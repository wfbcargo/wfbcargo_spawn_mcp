import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  api,
  apiError,
  exchangeBootstrap,
  latestPath,
  variantPath,
  type ApiResult,
} from "./client.js";
import {
  changedScriptPaths,
  changedSpecPaths,
  compile,
  formatIssues,
  listConflictReceipts,
  materializeScripts,
  readBaseGame,
  readBaseScripts,
  readBaseVersion,
  specScriptsByFilePath,
  syncPulledScripts,
  syncPulledSpec,
  writeBaseGame,
  writeBaseScripts,
  writeBaseVersion,
} from "./compile.js";
import { isHandoff, renderHandoff } from "./brief.js";
import { countWispsOnScreen, getSession, readStudio } from "./browser.js";
import { resolveApiUrl } from "./config.js";
import {
  ENGINE_VERSION_DESCRIPTION,
  EngineMismatchError,
  engineSummary,
  forgetEngine,
  gitLaneRedirect,
  isGitLane,
  laneName,
  resolveEngine,
  stateDir,
  type EngineInfo,
  type Era,
} from "./engine.js";
import {
  cloneInto,
  commitAndPush,
  configureNotes,
  excludeLocally,
  isEmptyDir,
  isGitRepo,
  pullRebase,
  status as gitStatus,
  spawnNote,
  strangersIn,
} from "./git.js";
import { absoluteUrl, checkClone, gitCreds } from "./lane.js";
import { checkTree, formatTreeReport } from "./tree.js";
import { LANE_GUIDE, SESSION_GUIDE } from "./session.js";
import { renderFleetLine, summarizeFleet } from "./wisps.js";
import {
  agentFor,
  appendPush,
  findClaimOwner,
  findPushByVersion,
  isTeamMode,
  latchProject,
  PUSH_LOCK,
  readClaims,
  readRoster,
  resolveLedgerDir,
  withLedgerLock,
  type Claims,
} from "./team.js";
import {
  ensureGitignore,
  loadEnv,
  maskToken,
  requireEnv,
  resolveProjectDir,
  saveFile,
  upsertEnv,
  type SpawnEnv,
} from "./env.js";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

const projectDirSchema = z
  .string()
  .optional()
  .describe(
    "Absolute path to the Spawn game project (game.json / .env). Defaults to SPAWN_PROJECT_DIR or the MCP process cwd."
  );

/**
 * Carried by every tool whose behaviour depends on the world's engine — the
 * ones that read or write the world itself. Room tools (exec / logs / rooms)
 * deliberately do NOT take it: those endpoints are identical on both lanes, so
 * the parameter would be a knob that does nothing.
 */
const engineVersionSchema = z.string().optional().describe(ENGINE_VERSION_DESCRIPTION);

/**
 * Resolve the lane, turning the two ways it can fail into tool errors rather
 * than exceptions. `null` means the caller should return `failure` unchanged.
 */
async function lane(
  dir: string,
  env: SpawnEnv,
  engineVersion?: string
): Promise<{ info: EngineInfo } | { failure: ReturnType<typeof err> }> {
  try {
    return { info: await resolveEngine(dir, env, engineVersion) };
  } catch (e: any) {
    if (e instanceof EngineMismatchError) return { failure: err(e.message) };
    return { failure: err(`Could not resolve this world's engine: ${e?.message ?? e}`) };
  }
}

/**
 * The document lane answering "this world is git" is not an error to report and
 * move on from — it means the cached era is stale, so drop it and teach.
 */
function gitLaneFrom409(env: SpawnEnv, info: EngineInfo, json: any, what: string) {
  forgetEngine(env);
  const pointer = json?.pointer ?? {};
  return err(
    gitLaneRedirect(
      {
        ...info,
        era: isGitLane(info.era) ? info.era : "6.0",
        gitUrl: pointer.gitUrl ?? info.gitUrl,
        playUrl: pointer.playUrl ?? info.playUrl,
        codeUrl: pointer.codeUrl ?? info.codeUrl,
        address: pointer.address ?? info.address,
      },
      what
    )
  );
}

/**
 * The live-room endpoints answer 502 when no room is running. That reads as a
 * server outage unless you know a room only exists while someone is connected.
 */
function execHint(result: ApiResult): string {
  const detail = apiError(result);
  const noRoom =
    result.status === 502 || result.status === 503 || result.json?.error === "no_live_room";
  if (noRoom) {
    return (
      `${detail}\n\nNO LIVE ROOM: a room boots for a PLAYER and never for a door, so these endpoints read nothing until a body ` +
      "stands. Boot one yourself with spawn_client_join — your own body in the world, no browser and no GPU, live while it stands " +
      "(and check spawn_client_status for a ttl that has run out). spawn_play_open boots one too, and is what you want when you need " +
      "to SEE the world rather than query it. Or have the creator open the play URL."
    );
  }
  return detail;
}

type TeamContext = { ledgerDir: string; label: string | null; claims: Claims };

/** Team bookkeeping for one worktree, or null when there is no team. */
function teamContext(dir: string): TeamContext | null {
  if (!isTeamMode()) return null;
  const ledgerDir = resolveLedgerDir(dir);
  if (!ledgerDir) return null;
  return {
    ledgerDir,
    label: agentFor(readRoster(ledgerDir), dir)?.label ?? null,
    claims: readClaims(ledgerDir),
  };
}

/**
 * Advisory only, per the team-mode decision: a stale claim must never become a
 * hostage situation. Deduped by claim, so one owned area does not produce forty
 * near-identical lines.
 */
function claimWarnings(
  team: TeamContext,
  changed: { specPaths: string[]; scripts: string[] }
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const check = (kind: "spec" | "script", paths: string[]) => {
    for (const path of paths) {
      const owner = findClaimOwner(team.claims, kind, path);
      if (!owner || owner.label === team.label) continue;
      const key = `${owner.label}:${owner.pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        `${path} falls under "${owner.pattern}", claimed by ${owner.label}${owner.note ? ` (${owner.note})` : ""}`
      );
    }
  };
  check("spec", changed.specPaths);
  check("script", changed.scripts);
  return out;
}

/**
 * Pull head before pushing, from inside the push lock.
 *
 * Serialised, "behind head" can only mean a teammate landed a push since our
 * last sync, so rebasing here turns what would have been a 409 into a no-op.
 * A dirty rebase stops the push instead: that needs a human decision, and
 * pushing over it would discard the teammate's work.
 */
async function rebaseOntoHead(
  dir: string,
  env: SpawnEnv,
  team: TeamContext
): Promise<{ pulled?: { from: number; to: number; by: string | null } } | { error: string }> {
  const base = readBaseVersion(dir);
  if (base === null) return {}; // no rail: the existing error path explains it better

  let head;
  try {
    head = await api(env, "GET", latestPath(env));
  } catch {
    return {}; // unreachable API: let the push itself report the failure
  }
  if (head.status !== 200 || typeof head.json?.version !== "number") return {};
  if (head.json.version <= base) return {};

  const scripts = syncPulledScripts(dir, head.json.gameSpec ?? {}, head.json.version);
  const spec = syncPulledSpec(dir, head.json.gameSpec ?? {});
  writeBaseVersion(dir, head.json.version);
  const by = findPushByVersion(team.ledgerDir, head.json.version)?.label ?? null;

  const conflicts = [
    ...scripts.summary.conflicts.map((c) => c.path),
    ...spec.conflicts.map((p) => `game.json:${p}`),
  ];
  if (conflicts.length) {
    return {
      error:
        `Not pushed. ${by ? `${by} pushed` : "A teammate pushed"} v${head.json.version} while you were working, and rebasing onto it collided with your changes at: ${conflicts.join(", ")}.\n\n` +
        "Your work is intact — every conflict kept YOUR value, and their side is in the .theirs receipt beside each file. Reconcile those, delete the receipts, then push again.",
    };
  }
  return { pulled: { from: base, to: head.json.version, by } };
}

export type InitResult =
  | { ok: true; summary: Record<string, unknown> }
  | { ok: false; error: string };

/** Pull guide / tome API / skills into `.spawn/`, on either lane. */
async function saveDocs(dir: string, env: SpawnEnv, era?: Era): Promise<ApiResult> {
  const docs = await api(env, "GET", variantPath(env, "/agent/docs"));
  if (docs.status !== 200) return docs;
  writeDocs(dir, docs.json, era);
  return docs;
}

/** The three doc files, written wherever this project's state lives. */
function writeDocs(dir: string, json: any, era?: Era): string {
  const home = stateDir(dir, era);
  saveFile(join(home, "guide.md"), json.guide ?? "");
  saveFile(join(home, "tome-api.md"), json.tomeApi ?? "");
  saveFile(join(home, "skills.json"), JSON.stringify(json.skills ?? [], null, 2));
  return home;
}

/**
 * Provision a project directory for an engine-6.0 world: clone the repo.
 *
 * The world's code IS the repo, so there is nothing to scaffold — the tree
 * arrives whole or not at all. Three shapes of directory, told apart before
 * anything is written, because two of them would be destructive to guess at:
 * empty (clone into it), already this world's clone (configure and leave the
 * files alone), and anything else (refuse, and say what it found).
 */
async function initGitWorld(
  dir: string,
  env: SpawnEnv,
  info: EngineInfo,
  depth?: number
): Promise<InitResult> {
  if (!info.gitUrl) {
    return {
      ok: false,
      error:
        `This world is on engine ${info.semver ?? info.era} (the git lane) but the API did not name a clone URL for it. ` +
        "It may have no @-address yet — ask the creator to name it, then retry.",
    };
  }

  const creds = await gitCreds(dir, env);
  const notes: string[] = [];
  let cloned = false;

  if (await isGitRepo(dir)) {
    const check = await checkClone(dir, info);
    if (!check.ok) return { ok: false, error: check.message };
    notes.push("Clone already present — files left untouched (use spawn_latest to pull).");
  } else if (isEmptyDir(dir)) {
    const result = await cloneInto(info.gitUrl, dir, creds, ...(depth != null ? [{ depth }] : []));
    notes.push(
      `Cloned ${info.gitUrl} (branch ${result.branch}, ` +
        `${result.depth > 0 ? `last ${result.depth} commits` : "full history"})`
    );
    if (result.depth > 0) {
      notes.push(
        "Shallow by design: a live world's full history runs to tens of thousands of objects and does not reliably " +
          "finish fetching, while the tip arrives in seconds. Editing, committing and pushing all work from here. " +
          "Pass depth:0 if you genuinely need the whole history (and expect it to be slow)."
      );
    } else if (!result.notes) {
      notes.push("The spawn notes ref was not fetched — `git log --notes=spawn` will be empty.");
    }
    if (result.excluded.length) notes.push(`excluded from this clone: ${result.excluded.join(", ")}`);
    cloned = true;
  } else {
    return {
      ok: false,
      error:
        `${dir} is not empty and is not a git repository, so cloning into it would be destructive. ` +
        "Nothing was written. Point projectDir at an empty directory or at an existing clone of " +
        `${info.gitUrl}.`,
    };
  }

  await configureNotes(dir);
  // The token lives in .env inside this directory and .spawn/ holds our caches.
  // Neither may reach a commit, and neither belongs in the world's tracked
  // .gitignore — so they are excluded locally, in this clone only.
  const excluded = excludeLocally(dir);
  if (excluded.length) notes.push(`excluded from this clone: ${excluded.join(", ")}`);

  const docs = await saveDocs(dir, env, info.era);
  if (docs.status !== 200) {
    return { ok: false, error: `init: docs failed (${docs.status}): ${docs.json?.error}` };
  }

  const st = await gitStatus(dir);
  const home = stateDir(dir, info.era);
  return {
    ok: true,
    summary: {
      projectDir: dir,
      engine: engineSummary(info),
      cloned,
      // Named explicitly: on this lane the docs are NOT under .spawn/, because
      // that directory belongs to the world.
      docsDir: home,
      branch: st.branch,
      head: st.headShort,
      headSubject: st.headSubject,
      specVersion: docs.json.specVersion,
      playUrl: absoluteUrl(env.apiUrl, docs.json.playUrl),
      docsWarnings: docs.json.errors ?? [],
      notes,
      next:
        `Read AGENTS.md at the root of this clone — it is this world's own grammar — then ${join(home, "tome-api.md")} IN FULL ` +
        "before you write any code: every shape in it is exact, and a push in another shape is refused naming the row, the line and the field. " +
        'Then load the craft: spawn_skill ids: ["…"] for every domain the work touches. ' +
        "Edit the tree, then spawn_push with a `message` — its first line lands in the creator's chat, so write it as one plain " +
        "sentence about what changed for the player. Every push is live in every open room.",
    },
  };
}

/**
 * Scaffold a project directory: gitignore secrets, world/ + scripts/, pull the
 * current spec into game.json with rails, materialize scripts, save docs.
 *
 * Shared by `spawn_init` and `spawn_team_add`, so provisioning a teammate's
 * worktree cannot drift from provisioning your own. On the git lane it hands
 * off to `initGitWorld`: a 6.0 world has no spec document to scaffold from.
 */
export async function initProject(
  dir: string,
  env: SpawnEnv,
  engineVersion?: string,
  depth?: number
): Promise<InitResult> {
  let info: EngineInfo;
  try {
    info = await resolveEngine(dir, env, engineVersion);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  if (isGitLane(info.era)) return initGitWorld(dir, env, info, depth);

  const gitignored = ensureGitignore(dir);
  for (const sub of ["world", "scripts"]) {
    const p = join(dir, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  const notes: string[] = [];
  if (gitignored.length) notes.push(`gitignored ${gitignored.join(", ")}`);

  const gamePath = join(dir, "game.json");
  let version: number | undefined;
  let scriptsMaterialized = 0;

  if (existsSync(gamePath)) {
    notes.push("game.json already present — left untouched (use spawn_latest to pull)");
  } else {
    const { status, json } = await api(env, "GET", variantPath(env, "/game-specs/latest"));
    if (status !== 200) return { ok: false, error: `init: latest failed (${status}): ${json?.error}` };
    version = json.version;
    writeBaseVersion(dir, json.version);
    writeBaseScripts(dir, specScriptsByFilePath(json.gameSpec ?? {}));
    writeBaseGame(dir, json.gameSpec ?? {});
    const { written, gameSpec } = materializeScripts(dir, json.gameSpec ?? {});
    scriptsMaterialized = written;
    saveFile(gamePath, JSON.stringify(gameSpec, null, 2));
    notes.push(`game.json = saved spec v${json.version}`);
    if (written) notes.push(`materialized ${written} script(s) into scripts/`);
  }

  const docs = await saveDocs(dir, env);
  if (docs.status !== 200)
    return { ok: false, error: `init: docs failed (${docs.status}): ${docs.json?.error}` };

  return {
    ok: true,
    summary: {
    projectDir: dir,
    version,
    scriptsMaterialized,
    engine: engineSummary(info),
    engineVersion: docs.json.engineVersion,
    specVersion: docs.json.specVersion,
    playUrl: absoluteUrl(env.apiUrl, docs.json.playUrl),
    docsWarnings: docs.json.errors ?? [],
    notes,
    next: 'Read .spawn/guide.md and .spawn/tome-api.md, then load the craft for what you are about to build: spawn_skill ids: ["…"] — every domain the work touches, look skills included (a scene is world-composition + looks, a HUD is game-ui + drawn-art). spawn_skills lists all of them.',
    },
  };
}

type SkillEntry = { id?: string; name?: string; description?: string };

/** Read the skills index `spawn_init` / `spawn_docs` already saved, if usable. */
function readSkillsCache(file: string): SkillEntry[] | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "spawn_getting_started",
    {
      description:
        "START HERE before any other spawn tool. The whole workflow in one call: setup order, the art/UI skills to load BEFORE building anything visual, the push → screenshot → fix loop, and the multi-agent rules. Also reports what this project already has (token, variant, game.json, docs) so you know which step you're on. Needs no credentials.",
      inputSchema: { projectDir: projectDirSchema, engineVersion: engineVersionSchema },
    },
    async ({ projectDir, engineVersion }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);

      // Best effort: this tool must answer with no credentials at all, so a
      // failed detection degrades the report rather than failing the call.
      let info: EngineInfo | null = null;
      let engineNote = "unknown (needs a token and SPAWN_VARIANT_ID)";
      if (env.agentKey && env.variantId) {
        try {
          info = await resolveEngine(dir, env, engineVersion);
          engineNote = `${info.semver ?? info.era} — ${laneName(info.era)}`;
        } catch (e: any) {
          engineNote = `could not detect (${e?.message ?? e})`;
        }
      }
      const git = info ? isGitLane(info.era) : false;

      const state: Record<string, boolean> = {
        agentKey: Boolean(env.agentKey),
        variantId: Boolean(env.variantId),
        ...(git
          ? { clone: await isGitRepo(dir) }
          : { gameJson: existsSync(join(dir, "game.json")) }),
        docs: existsSync(join(stateDir(dir, info?.era), "guide.md")),
        skillsIndex: existsSync(join(stateDir(dir, info?.era), "skills.json")),
      };
      const provisioned = git ? state.clone : state.gameJson;
      const next = !state.agentKey
        ? "spawn_bootstrap — ask the creator for a fresh sbk_ key (Spawn gear → Build with a coding agent)."
        : !state.variantId
          ? "spawn_create_game, or spawn_list_games + spawn_set_variant."
          : !provisioned || !state.docs
            ? git
              ? "spawn_init — clone this world's repo into the project dir and pull docs into .spawn/."
              : "spawn_init — scaffold the project and pull docs into .spawn/."
            : git
              ? "Read AGENTS.md in the clone and .spawn/tome-api.md IN FULL, then spawn_skills to pick the skills this build needs."
              : "Read .spawn/guide.md + .spawn/tome-api.md, then spawn_skills to pick the skills this build needs.";

      const checklist = Object.entries(state)
        .map(([key, ok]) => `  ${ok ? "✓" : "✗"} ${key}`)
        .join("\n");

      return text(
        `${SESSION_GUIDE}\n\n${LANE_GUIDE}\n\n---\n\nThis project (${dir}):\n` +
          `  engine: ${engineNote}\n${checklist}\n\nNext step: ${next}`
      );
    }
  );

  server.registerTool(
    "spawn_bootstrap",
    {
      description:
        "Trade a one-time setup bootstrap key (sbk_…) for a durable agent token. Writes SPAWN_AGENT_KEY to the project .env. The full token is NEVER returned — only a masked prefix. Bootstrap keys expire in ~5 minutes and work once.",
      inputSchema: {
        bootstrapKey: z.string().describe("One-time setup key from Spawn settings (sbk_…)"),
        name: z
          .string()
          .default("Cursor Spawn MCP")
          .describe(
            "Human-readable label for this agent connection (use a distinct name per concurrent agent, e.g. terrain-agent)"
          ),
        projectDir: projectDirSchema,
      },
    },
    async ({ bootstrapKey, name, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const apiUrl = resolveApiUrl();
      const result = await exchangeBootstrap(apiUrl, bootstrapKey, name);
      if (result.status !== 200 || !result.json?.token) {
        return err(
          `Bootstrap failed (${result.status}): ${apiError(result)}. If expired/already used, ask the creator for a fresh setup prompt (Spawn gear → Build with a coding agent).`
        );
      }
      const token: string = result.json.token;

      // The bootstrap key is now spent. Persist the token before anything else
      // that can throw — otherwise the creator has to mint a brand new key.
      try {
        upsertEnv(dir, { SPAWN_AGENT_KEY: token });
      } catch (e: any) {
        return err(
          `Token was issued but could NOT be written to ${join(dir, ".env")}: ${e?.message ?? e}\n` +
            "The one-time bootstrap key is now spent. Fix the path/permissions and ask the creator for a fresh setup key."
        );
      }
      ensureGitignore(dir);

      const env = loadEnv(dir);
      let connectedAs: unknown = null;
      let meWarning: string | undefined;
      try {
        const me = await api(env, "GET", "/api/agent/v1/me");
        if (me.status === 200) connectedAs = me.json;
        else meWarning = `whoami failed (${me.status}): ${apiError(me)}`;
      } catch (e: any) {
        meWarning = `whoami unreachable: ${e?.message ?? e}`;
      }

      return text({
        ok: true,
        wrote: join(dir, ".env"),
        tokenMasked: maskToken(token),
        connectedAs,
        ...(meWarning ? { warning: `${meWarning} — the token is saved; retry spawn_me.` } : {}),
        note: "Token lives only in .env — never commit, log, or paste it.",
      });
    }
  );

  server.registerTool(
    "spawn_me",
    {
      description: "Whoami — returns { userId, username } for the connected Spawn agent token.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY");
      const { status, json } = await api(env, "GET", "/api/agent/v1/me");
      if (status !== 200) return err(`me failed (${status}): ${json?.error ?? JSON.stringify(json)}`);
      return text(json);
    }
  );

  server.registerTool(
    "spawn_list_games",
    {
      description:
        "List games this token can push to: { games: [{ appId, variantId, name, playUrl }] }. Ask the creator which one by name.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY");
      const { status, json } = await api(env, "GET", "/api/agent/v1/games");
      if (status !== 200) return err(`list games failed (${status}): ${json?.error ?? JSON.stringify(json)}`);
      return text({
        ...json,
        playUrls: (json.games ?? []).map((g: any) => ({
          name: g.name,
          variantId: g.variantId,
          open: absoluteUrl(env.apiUrl, g.playUrl),
        })),
      });
    }
  );

  server.registerTool(
    "spawn_create_game",
    {
      description:
        "Create a new game in the creator's account. Optionally writes SPAWN_VARIANT_ID to .env. Creator should open the play URL and keep it " +
        "open. The engine a new world is pinned to is the platform's choice, not an argument here — the result reports which lane it landed on, " +
        "and spawn_init then provisions for that lane (a clone on 6.0+, a scaffold on pre-6.0).",
      inputSchema: {
        projectDir: projectDirSchema,
        setVariant: z
          .boolean()
          .default(true)
          .describe("Write SPAWN_VARIANT_ID into the project .env"),
      },
    },
    async ({ projectDir, setVariant }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY");
      const { status, json } = await api(env, "POST", "/api/agent/v1/games", {});
      if (status !== 200) return err(`create failed (${status}): ${json?.error ?? JSON.stringify(json)}`);
      if (setVariant && json?.variantId) {
        upsertEnv(dir, { SPAWN_VARIANT_ID: json.variantId });
        ensureGitignore(dir);
      }

      // Which lane the new world landed on decides what spawn_init will do, so
      // answer it here rather than leaving the next tool to discover it.
      let engine: Record<string, unknown> | undefined;
      if (setVariant && json?.variantId) {
        try {
          engine = engineSummary(await resolveEngine(dir, loadEnv(dir)));
        } catch {
          /* the game exists either way; spawn_init will detect it */
        }
      }

      return text({
        ...json,
        playUrlAbsolute: absoluteUrl(env.apiUrl, json.playUrl),
        variantWritten: Boolean(setVariant && json?.variantId),
        ...(engine ? { engine } : {}),
        next: setVariant
          ? "spawn_init — it provisions for whichever lane this world is on."
          : "spawn_set_variant with the variantId above, then spawn_init.",
      });
    }
  );

  server.registerTool(
    "spawn_set_variant",
    {
      description: "Set SPAWN_VARIANT_ID in the project .env (join an existing game from spawn_list_games).",
      inputSchema: {
        variantId: z.string().describe("variantId from list/create games"),
        projectDir: projectDirSchema,
      },
    },
    async ({ variantId, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      upsertEnv(dir, { SPAWN_VARIANT_ID: variantId });
      ensureGitignore(dir);
      return text({ ok: true, variantId, wrote: join(dir, ".env") });
    }
  );

  server.registerTool(
    "spawn_init",
    {
      description:
        "Provision the project directory for this world — what that means depends on the engine, and this detects it. " +
        "On engine 6.0+ (the git lane) the world's code IS a git repository: this CLONES it into projectDir (the agent token is the git " +
        "password, supplied per-command and never written to .git/config), fetches the spawn notes ref, keeps .env and .spawn/ out of the " +
        "tree via .git/info/exclude, and saves the docs. A non-empty directory that is not already this world's clone is refused rather " +
        "than cloned over. On a pre-6.0 world (the document lane) it scaffolds as before: gitignore secrets, world/ + scripts/, pull " +
        "current spec → game.json, materialize scripts. Either way the docs land in .spawn/ (guide.md, tome-api.md, skills.json).",
      inputSchema: {
        projectDir: projectDirSchema,
        engineVersion: engineVersionSchema,
        depth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Engine 6.0+ only: how many commits of history to clone (default 20). A live world's full history is tens of thousands of " +
              "objects and may not finish fetching at all, and nothing here needs it — editing, committing and pushing all work from the tip. " +
              "Pass 0 for the full history (slow, and the only way to get `git log --notes=spawn`)."
          ),
      },
    },
    async ({ projectDir, engineVersion, depth }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const result = await initProject(dir, env, engineVersion, depth);
      return result.ok ? text({ ok: true, ...result.summary }) : err(result.error);
    }
  );

  server.registerTool(
    "spawn_docs",
    {
      description:
        "Fetch this world's guide, the Tome API reference, and the skills index — all matched to the engine version the world is pinned to, " +
        "and this is also the cheapest authoritative answer to WHICH engine that is (era + semver come back in the result). On engine 6.0+ the " +
        "guide IS the world's AGENTS.md: the tree grammar, the API in one screen, the git loop. On a pre-6.0 world it is the document lane's " +
        "one paragraph. Optionally save under .spawn/. For just the skill menu with descriptions, spawn_skills is cheaper.",
      inputSchema: {
        projectDir: projectDirSchema,
        save: z.boolean().default(true).describe("Write guide.md, tome-api.md, skills.json under .spawn/"),
        engineVersion: engineVersionSchema,
      },
    },
    async ({ projectDir, save, engineVersion }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const resolved = await lane(dir, env, engineVersion);
      if ("failure" in resolved) return resolved.failure;

      const { status, json } = await api(env, "GET", variantPath(env, "/agent/docs"));
      if (status !== 200) return err(`docs failed (${status}): ${json?.error}`);
      const savedTo = save ? writeDocs(dir, json, resolved.info.era) : null;
      return text({
        engine: engineSummary(resolved.info),
        // The docs endpoint is the authority on the pin, so echo its own reading
        // beside the resolved lane rather than only the cached one.
        engineVersion: json.engineVersion,
        era: json.era,
        specVersion: json.specVersion,
        // playUrl comes back absolute on the git lane and relative on the
        // document lane; prefixing blindly produced a double origin.
        playUrl: absoluteUrl(env.apiUrl, json.playUrl),
        gitUrl: json.gitUrl ?? undefined,
        codeUrl: json.codeUrl ?? undefined,
        skills: json.skills,
        errors: json.errors ?? [],
        saved: save,
        savedTo: savedTo ?? undefined,
        guideChars: (json.guide ?? "").length,
        tomeApiChars: (json.tomeApi ?? "").length,
        note: save
          ? `Full docs written to ${savedTo} — read those files; this response omits the bodies.`
          : "Pass save:true to write full bodies to disk.",
      });
    }
  );

  server.registerTool(
    "spawn_skills",
    {
      description:
        "The menu of skill ids to pass to spawn_skill, each with what it covers. Browse it when planning a build so the spawn_skill call can carry every domain the work touches — mechanic and look together. Reads .spawn/skills.json when present (no network, no credentials) and falls back to the API. If you already know roughly what you need, skip this and pass ids straight to spawn_skill; a wrong id answers with this list anyway.",
      inputSchema: {
        projectDir: projectDirSchema,
        search: z
          .string()
          .optional()
          .describe('Case-insensitive filter over id, name, and description (e.g. "ui", "camera", "terrain")'),
        detail: z
          .enum(["full", "brief"])
          .default("full")
          .describe("'full' includes each skill's description (the whole index is ~9k tokens); 'brief' is id + name only"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Re-fetch the index from the API and rewrite .spawn/skills.json (needs credentials)"),
      },
    },
    async ({ projectDir, search, detail, refresh }) => {
      const dir = resolveProjectDir(projectDir);
      const cachePath = join(stateDir(dir), "skills.json");

      let skills = refresh ? null : readSkillsCache(cachePath);
      let source = "cache";
      if (!skills) {
        const env = loadEnv(dir);
        requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
        const result = await api(env, "GET", variantPath(env, "/agent/docs"));
        if (result.status !== 200) return err(`skills failed (${result.status}): ${apiError(result)}`);
        skills = (Array.isArray(result.json?.skills) ? result.json.skills : []) as SkillEntry[];
        source = "api";
        // Cache it so later calls (and spawn_skill lookups) work offline.
        try {
          saveFile(cachePath, JSON.stringify(skills, null, 2));
        } catch {
          /* unwritable project dir — the listing itself still works */
        }
      }

      const needle = search?.trim().toLowerCase();
      const matched = needle
        ? skills.filter((s) =>
            `${s.id ?? ""} ${s.name ?? ""} ${s.description ?? ""}`.toLowerCase().includes(needle)
          )
        : skills;

      return text({
        count: matched.length,
        total: skills.length,
        source,
        ...(needle ? { search } : {}),
        skills: matched.map((s) =>
          detail === "brief" ? { id: s.id, name: s.name } : { id: s.id, name: s.name, description: s.description }
        ),
        next:
          "spawn_skill <id> for the full markdown of any skill listed here. Load the art/UI ones before writing visual code — a HUD or a material written without them lands as default DOM and untextured primitives.",
      });
    }
  );

  server.registerTool(
    "spawn_skill",
    {
      description:
        "Load the craft for what you are about to build — pass EVERY skill the work touches, not one. This is where the engine's real technique lives (how a HUD is actually built, how a material is written, how terrain is sculpted); the API reference only lists fields, so code written without the skills works but looks and behaves like a default. Anything visual should carry the look skills alongside the mechanic: a HUD is game-ui + drawn-art, a glowing surface is custom-materials + looks, a scene is world-composition + looks. Guessing an id is fine and cheap — a miss answers with the real menu.",
      inputSchema: {
        ids: z
          .array(z.string())
          .optional()
          .describe(
            'Skill ids to load together, e.g. ["game-ui","drawn-art","looks"]. Pass every domain the next chunk of work touches — mechanic AND look. These are long documents (~7k tokens each), so 2-4 ids for the work actually in front of you, not the whole menu. Visual: drawn-art, game-ui, looks, custom-materials, fx, slash-vfx, 3d-sprites, world-composition, match-a-reference. Motion/camera: platformer-movement, vehicles, camera-first-person, camera-third-person, camera-isometric, camera-top-down. Systems: scripted-systems, data-and-saves, npc, enemy-ai, combat, projectiles, leaderboard, interactive-objects. Terrain/build: heightmap-terrain, voxel-terrain, structures, custom-geometry. spawn_skills is the authoritative live list.'
          ),
        id: z.string().optional().describe("Single skill id — prefer ids: [...] and load the whole set at once"),
        projectDir: projectDirSchema,
      },
    },
    async ({ ids, id, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const wanted = [...new Set([...(ids ?? []), ...(id ? [id] : [])].map((s) => s.trim()).filter(Boolean))];
      const menu = () => {
        const cached = readSkillsCache(join(stateDir(dir), "skills.json"));
        return cached
          ? `\n\nAvailable ids:\n${cached.map((s) => `  ${s.id} — ${s.name}`).join("\n")}`
          : "\n\nCall spawn_skills for the list of ids.";
      };
      if (!wanted.length) return err(`Pass ids: [...] — the skills this work needs.${menu()}`);

      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const loaded = await Promise.all(
        wanted.map(async (skillId) => {
          const result = await api(env, "GET", variantPath(env, `/agent/skills/${encodeURIComponent(skillId)}`));
          if (result.status !== 200) {
            return { id: skillId, error: `${result.status}: ${apiError(result)}` };
          }
          const body = result.json?.content ?? result.json;
          return { id: skillId, content: typeof body === "string" ? body : JSON.stringify(body, null, 2) };
        })
      );

      const ok = loaded.filter((s) => s.content !== undefined);
      const failed = loaded.filter((s) => s.error !== undefined);
      // A wrong id must not cost a round trip to find the right one.
      if (!ok.length) {
        return err(`No skill loaded.\n${failed.map((f) => `  ${f.id}: ${f.error}`).join("\n")}${menu()}`);
      }

      const body = ok.map((s) => `=== ${s.id} ===\n\n${s.content}`).join("\n\n");
      const problems = failed.length
        ? `\n\n=== not loaded ===\n${failed.map((f) => `  ${f.id}: ${f.error}`).join("\n")}${menu()}`
        : "";
      return text(body + problems);
    }
  );

  server.registerTool(
    "spawn_latest",
    {
      description:
        "Take upstream's work into your project. ON ENGINE 6.0+ (git lane) this is `git pull --rebase`: Savi, exec, and other clones commit " +
        "to the same repo, so pull before you build and again after a refused push. A dirty tree is refused rather than stashed, and a " +
        "rebase that collides is aborted with your commits intact and the colliding paths named. mode / version / updateSlug / applyLocal " +
        "are document-lane concepts and are refused there. ON A PRE-6.0 WORLD (document lane) it is unchanged: pull a saved spec — head " +
        "(mode=dev, default), published live (mode=live), an exact version, or a published updateSlug. Head pulls sync scripts (untouched " +
        "fast-forward; both-changed → <file>.theirs) and update the base-version rail — use after version_conflict. Non-head pulls are " +
        "read-only unless applyLocal:true. version and updateSlug are mutually exclusive.",
      inputSchema: {
        projectDir: projectDirSchema,
        engineVersion: engineVersionSchema,
        mode: z
          .enum(["dev", "live"])
          .default("dev")
          .describe("'dev' = saved head (default); 'live' = published live version"),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Exact saved spec version (mutually exclusive with updateSlug)"),
        updateSlug: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("Published update slug → pinned spec version (mutually exclusive with version)"),
        applyLocal: z
          .boolean()
          .optional()
          .describe(
            "Write pulled scripts/base-version (and game.json when saveGameJson). Defaults true for plain head pulls, false for mode=live / version / updateSlug"
          ),
        saveGameJson: z
          .boolean()
          .default(true)
          .describe("When applying: write pulled spec to game.json"),
      },
    },
    async ({ projectDir, mode, version, updateSlug, applyLocal, saveGameJson, engineVersion }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");

      if (version != null && updateSlug) {
        return err("Pass version OR updateSlug, not both (API mutual exclusion).");
      }

      const resolved = await lane(dir, env, engineVersion);
      if ("failure" in resolved) return resolved.failure;

      if (isGitLane(resolved.info.era)) {
        // Refused rather than ignored: silently dropping "give me the published
        // live snapshot" would hand back the dev head and look like it worked.
        const documentOnly = [
          version != null ? "version" : null,
          updateSlug ? "updateSlug" : null,
          mode === "live" ? "mode=live" : null,
          applyLocal !== undefined ? "applyLocal" : null,
        ].filter(Boolean);
        if (documentOnly.length) {
          return err(
            `${documentOnly.join(", ")} ${documentOnly.length > 1 ? "are" : "is"} document-lane only, and this world is on engine ` +
              `${resolved.info.semver ?? resolved.info.era} — its history is git. Nothing was pulled. ` +
              "Call spawn_latest with no arguments for `git pull --rebase`; for an older state, use git directly in the clone."
          );
        }

        latchProject(dir, "spawn_latest (git pull)");
        const check = await checkClone(dir, resolved.info);
        if (!check.ok) return err(check.message);

        const creds = await gitCreds(dir, env);
        const pulled = await pullRebase(dir, creds);
        if (!pulled.ok) {
          return err(`${pulled.message}${pulled.paths.length ? `\n\nPaths: ${pulled.paths.join(", ")}` : ""}`);
        }
        const st = await gitStatus(dir);
        return text({
          engine: engineSummary(resolved.info),
          pulled: true,
          changed: pulled.changed,
          from: pulled.before,
          to: pulled.after,
          files: pulled.files.slice(0, 50),
          fileCount: pulled.files.length,
          branch: st.branch,
          ahead: st.ahead,
          behind: st.behind,
          note: !pulled.changed
            ? "Already up to date with origin."
            : pulled.files.length === 0
              ? "Rebased onto origin. New commits arrived but the tree is byte-identical — nothing to re-read. " +
                "(A world's own bookkeeping commits, e.g. re-measuring cell costs, often land this way.)"
              : `Rebased onto origin — ${pulled.files.length} file(s) moved. Read what changed before building on top of it: ` +
                "these commits are Savi's, the creator's, or another clone's, and `git log --notes=spawn` carries the world's own reading of each.",
        });
      }

      const isHeadPull = mode === "dev" && version == null && !updateSlug;
      const shouldApply = applyLocal ?? isHeadPull;
      // Only the applying form is identity-bearing: it advances that worktree's
      // rail. A read-only pull stays available for inspecting a teammate.
      if (shouldApply) latchProject(dir, "spawn_latest applyLocal");

      const { status, json } = await api(
        env,
        "GET",
        latestPath(env, {
          mode: mode === "dev" && isHeadPull ? undefined : mode,
          version,
          updateSlug,
        })
      );
      if (status === 404) {
        return err(
          `latest failed (404): ${json?.error ?? "not found"}. For mode=live this usually means nothing is published yet — publish in the Spawn UI before relying on a live baseline.`
        );
      }
      if (status !== 200) return err(`latest failed (${status}): ${json?.error ?? JSON.stringify(json)}`);

      if (!shouldApply) {
        return text({
          version: json.version,
          mode,
          versionParam: version ?? null,
          updateSlug: updateSlug ?? null,
          applied: false,
          note: "Fetched only — pass applyLocal:true to sync scripts / update .spawn/base-version (and game.json).",
        });
      }

      const sync = syncPulledScripts(dir, json.gameSpec ?? {}, json.version);
      const specSync = syncPulledSpec(dir, json.gameSpec ?? {}, { write: saveGameJson });
      writeBaseVersion(dir, json.version);

      const scriptConflicts = sync.summary.conflicts.length;
      const specConflicts = specSync.conflicts.length;
      const notes: string[] = [];

      // Name the teammate whose work this is, rather than "someone else". Kept
      // out of `notes` so it does not suppress the clean-pull message below.
      const puller = teamContext(dir);
      const pushedBy = puller ? findPushByVersion(puller.ledgerDir, json.version) : null;
      const attribution =
        pushedBy && pushedBy.label !== puller?.label
          ? `v${json.version} is ${pushedBy.label}'s push${pushedBy.specPaths.length ? ` (touched ${pushedBy.specPaths.slice(0, 6).join(", ")})` : ""}.`
          : null;
      if (specConflicts > 0) {
        notes.push(
          `game.json: ${specConflicts} key(s) changed both locally and upstream — kept YOURS at ${specSync.conflicts.join(", ")}, upstream's whole spec is in game.json.theirs. Reconcile those keys, delete the receipt, then push.`
        );
      }
      if (scriptConflicts > 0) {
        notes.push("Scripts: merge each .theirs into its file, delete the receipt, then push.");
      }
      if (specSync.mode === "replaced" && specSync.backup) {
        notes.push(
          `game.json was replaced wholesale (${specSync.reason}). The previous file is at ${specSync.backup} if you need anything back.`
        );
      }
      if (!notes.length) {
        notes.push(
          sync.summary.created.length > 0
            ? `Clean pull. ${sync.summary.created.length} new upstream script(s) written into scripts/ — read them before editing nearby code.`
            : isHeadPull
              ? "Clean pull."
              : "Local project reset to this snapshot — next push will use this baseVersion."
        );
      }

      return text({
        version: json.version,
        mode,
        versionParam: version ?? null,
        updateSlug: updateSlug ?? null,
        applied: true,
        savedGameJson: saveGameJson,
        sync: sync.summary,
        spec: specSync,
        hasConflicts: scriptConflicts + specConflicts > 0,
        ...(pushedBy ? { pushedBy: pushedBy.label } : {}),
        note: [attribution, ...notes].filter(Boolean).join(" "),
      });
    }
  );

  server.registerTool(
    "spawn_validate",
    {
      description:
        "Check the project before pushing. ON ENGINE 6.0+ (git lane) there is no server-side validator — the push itself is the authority " +
        "and refuses typed, naming the row, the line and the field — so this runs a LOCAL pre-flight over the tree instead: every script and " +
        "template is ESM-parsed, .scene files are checked against the `# spawn-scene v2 yaml <cellKey>` header and their filename's cell key, " +
        "image bytes are checked against their extension, and binaries under assets/ are caught (law.git.asset-kind refuses them). Clean here " +
        "does NOT mean the push will land. ON A PRE-6.0 WORLD it is unchanged: compile the project and run authoritative server-side schema " +
        "validation. Either way, valid is not the same as good — it says nothing about how the result looks or feels, which comes from the " +
        "skills you loaded (spawn_skill) before writing the code.",
      inputSchema: { projectDir: projectDirSchema, engineVersion: engineVersionSchema },
    },
    async ({ projectDir, engineVersion }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const resolved = await lane(dir, env, engineVersion);
      if ("failure" in resolved) return resolved.failure;

      if (isGitLane(resolved.info.era)) {
        const check = await checkClone(dir, resolved.info);
        if (!check.ok) return err(check.message);
        const report = await checkTree(dir);
        const st = await gitStatus(dir);
        const body =
          `${formatTreeReport(report)}\n\n` +
          `Working tree: ${st.clean ? "clean" : `${st.dirty.length} uncommitted change(s)`}` +
          `${st.behind ? `, ${st.behind} behind origin (spawn_latest first)` : ""}` +
          `${st.ahead ? `, ${st.ahead} unpushed commit(s)` : ""}.\n\n` +
          "This is a LOCAL pre-flight, not a verdict: the authority on a 6.0 world is the push, which validates the whole tree " +
          "server-side and answers with each room's verdict. Clean here only means the failures that can be seen without the engine " +
          "are absent.";
        return { content: [{ type: "text" as const, text: body }], isError: !report.ok };
      }

      let spec: any;
      try {
        spec = compile(dir);
      } catch (e: any) {
        return err(e.message);
      }
      const { status, json } = await api(env, "POST", variantPath(env, "/game-specs/validate"), {
        gameSpec: spec,
      });
      // The world migrated to 6.0 since we last looked: the document lane has no
      // validator for it, and the cached era is now wrong.
      if (status === 409 && json?.code === "world_is_git") {
        return gitLaneFrom409(env, resolved.info, json, "spawn_validate's server-side schema check");
      }
      if (!json || status !== 200) {
        return err(`validate failed (${status}): ${json?.error ?? "unknown"}`);
      }
      const parts = [
        json.valid ? "valid — no schema issues" : json.pushable ? "pushable — only pre-existing debt" : "NOT pushable",
        formatIssues("new issues (would block a push)", json.newIssues, json.newIssueCount),
        formatIssues("all issues", json.issues, json.issueCount),
      ].filter(Boolean);
      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
        isError: !json.pushable,
      };
    }
  );

  server.registerTool(
    "spawn_push",
    {
      description:
        "Push your work live (~1s in every open room). The lane is detected from the world's engine. " +
        "ON ENGINE 6.0+ (git lane) this stages, commits and git-pushes the clone: `message` is REQUIRED and is not a log line — its first " +
        "line lands in the creator's chat and their changes list under your name, so write one plain sentence about what changed for the " +
        "PLAYER (\"the getaway car keeps its grip on wet streets\"), never how you did it, never a file or a function; put the how in `body`, " +
        "which is also where you leave Savi what she needs. The result carries the `remote:` verdict lines — rooms, players, and each room's " +
        "reading of your change. A push refused as non-fast-forward means origin moved: spawn_latest, then push again. " +
        "ON A PRE-6.0 WORLD (document lane) it is unchanged: compile the project and PUT the spec; on 409 version_conflict call spawn_latest, " +
        "merge .theirs receipts and push again. In team mode document-lane pushes are serialised and rebased onto head first. " +
        "Either way a successful push proves it parsed, nothing more — look at spawn_play_screenshot before calling the work done, and if " +
        "what you pushed is visual and untextured or plainly styled, the missing piece is a skill you did not load (spawn_skill ids: " +
        "drawn-art, custom-materials, looks, game-ui); spawn_audit_ui answers the other question, what UI you never built at all.",
      inputSchema: {
        projectDir: projectDirSchema,
        engineVersion: engineVersionSchema,
        message: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Engine 6.0+ ONLY, and required there: the commit's first line, which IS the creator's chat line. One plain sentence about what " +
              'changed for the player — "the tram now stops at the north platform". Not a file, not a function, not a diagnosis. Ignored on the document lane.'
          ),
        body: z
          .string()
          .optional()
          .describe(
            "Engine 6.0+ only: the commit body — the how, and anything Savi needs. She reads it on the creator's next turn; there is no other door into her chat."
          ),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "Document lane: validate the push without saving. Git lane: run the local pre-flight and report what WOULD be committed, without committing or pushing."
          ),
        force: z
          .boolean()
          .default(false)
          .describe("Document lane only: whole-replace without base-version rail / discard .theirs (destructive)"),
      },
    },
    async ({ projectDir, dryRun, force, engineVersion, message, body }) => {
      const dir = resolveProjectDir(projectDir);
      latchProject(dir, "spawn_push");
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");

      const resolved = await lane(dir, env, engineVersion);
      if ("failure" in resolved) return resolved.failure;
      if (isGitLane(resolved.info.era)) {
        return gitPush({ dir, env, info: resolved.info, message, body, dryRun, force });
      }

      // A dry run touches nothing shared, so it never queues behind a teammate.
      const team = !dryRun ? teamContext(dir) : null;
      const run = () => pushOnce({ dir, env, info: resolved.info, dryRun, force, team });
      return team
        ? withLedgerLock(team.ledgerDir, run, PUSH_LOCK)
        : run();
    }
  );

  /**
   * The 6.0 write: stage, commit, push, and report what the rooms said.
   *
   * The local pre-flight runs first and BLOCKS on failure, because on this lane
   * a push is live the moment it lands — there is no dev/live split to absorb a
   * broken tree, and people may be standing in the world while it happens.
   */
  async function gitPush({
    dir,
    env,
    info,
    message,
    body,
    dryRun,
    force,
  }: {
    dir: string;
    env: SpawnEnv;
    info: EngineInfo;
    message?: string;
    body?: string;
    dryRun: boolean;
    force: boolean;
  }) {
    if (force) {
      return err(
        "force is a document-lane concept (whole-replace over the base-version rail) and there is no safe equivalent here — " +
          "on a git world it would mean a force-push, and the server never force-pushes or merges. Nothing was written. " +
          "If origin has moved, run spawn_latest to rebase onto it."
      );
    }

    const check = await checkClone(dir, info);
    if (!check.ok) return err(check.message);

    const st = await gitStatus(dir);
    if (st.clean && st.ahead === 0) {
      return err("Nothing to push: the working tree is clean and no local commit is ahead of origin.");
    }

    // A 6.0 push is `git add -A`, so anything left lying in the project dir
    // would become part of the world. Refuse rather than commit it: a
    // screenshot or a stray credential landing in a live world is not
    // something the agent would notice, and not something a pull undoes.
    const strangers = strangersIn(st.dirty);
    if (strangers.length) {
      return err(
        "Not pushed — these are this session's files, not the world's, and a push would commit them into it:\n" +
          strangers.map((p) => `  ${p}`).join("\n") +
          "\n\nMove or delete them, then push. (Screenshots and caches belong under .git/spawn-mcp/, " +
          "which is never part of the tree.)"
      );
    }

    // Only what this push would actually carry — a whole-tree parse on every
    // push would bill the agent for files it has not touched.
    const scope = st.dirty.length ? st.dirty : undefined;
    const report = await checkTree(dir, scope);
    if (!report.ok) {
      return err(
        `Not pushed — the local pre-flight failed, and a push on this lane is live in every open room the moment it lands.\n\n${formatTreeReport(report)}`
      );
    }

    if (dryRun) {
      return text({
        engine: engineSummary(info),
        dryRun: true,
        wouldCommit: st.dirty,
        unpushedCommits: st.ahead,
        behind: st.behind,
        preflight: report.checked,
        note:
          `${formatTreeReport(report)} Nothing was committed or pushed.` +
          (st.behind ? ` origin is ${st.behind} commit(s) ahead — run spawn_latest first.` : ""),
      });
    }

    if (!message?.trim()) {
      return err(
        "message is required on the git lane. Its first line lands in the creator's chat and their changes list under your name, " +
          'so it is a sentence about what changed for the player — "the north gate opens when both levers are pulled" — not a file, ' +
          "a function, or a diagnosis. Put the how in `body`."
      );
    }

    const creds = await gitCreds(dir, env);
    const pushed = await commitAndPush(dir, creds, { message: message.trim(), body });
    if (!pushed.ok) {
      return err(
        pushed.stage === "push" && pushed.behind
          ? pushed.message
          : `${pushed.message}\n\nNothing reached the world.`
      );
    }

    return text({
      engine: engineSummary(info),
      ok: true,
      committed: pushed.committed,
      sha: pushed.sha,
      // The subject that actually landed, which is not the `message` argument
      // when this pushed a commit a previous refusal had already made.
      message: pushed.subject,
      files: pushed.files.slice(0, 50),
      fileCount: pushed.files.length,
      // The rooms' own reading of the change — the closest thing this lane has
      // to a validation result, and the only report of who was standing in it.
      verdicts: pushed.verdicts,
      ...(pushed.note ? { spawnNote: pushed.note } : {}),
      playUrl: absoluteUrl(env.apiUrl, info.playUrl),
      note:
        (pushed.committed
          ? ""
          : "Pushed a commit that already existed locally (usually one a refused push left behind) — nothing new was committed. ") +
        "Live in every open room. The verdict lines above are the rooms' reading of the push, not proof the world is good — " +
        "open spawn_play_open and spawn_play_screenshot and judge the frame before calling it done.",
    });
  }

  /** The push itself, run under the team push lock when there is a team. */
  async function pushOnce({
    dir,
    env,
    info,
    dryRun,
    force,
    team,
  }: {
    dir: string;
    env: ReturnType<typeof loadEnv>;
    info: EngineInfo;
    dryRun: boolean;
    force: boolean;
    team: TeamContext | null;
  }) {
      const receipts = dryRun ? [] : listConflictReceipts(dir);
      if (receipts.length > 0 && !force) {
        return err(
          `Unresolved sync conflict receipts:\n${receipts
            .map((r) => `  ${relative(dir, r)}`)
            .join("\n")}\nMerge each .theirs into the file it sits next to (game.json.theirs is upstream's whole spec), delete the receipt, then push.`
        );
      }
      // With force, receipts are discarded — but only AFTER the push lands, so a
      // compile/validation failure can't destroy the upstream content they hold.

      // Serialised behind the lock, so "behind head" here means a teammate landed
      // a push since our last sync. Rebase now and the 409 never happens; bail if
      // the rebase is not clean, because that needs a human decision either way.
      let autoPulled: { from: number; to: number; by: string | null } | undefined;
      if (team && !force) {
        const rebased = await rebaseOntoHead(dir, env, team);
        if ("error" in rebased) return err(rebased.error);
        autoPulled = rebased.pulled;
      }

      let spec: any;
      try {
        spec = compile(dir);
      } catch (e: any) {
        return err(e.message);
      }

      const baseVersion = readBaseVersion(dir);
      if (baseVersion === null && !dryRun && !force) {
        return err(
          'No .spawn/base-version — run spawn_latest (or spawn_init), re-apply changes, then push; or pass force:true to whole-replace.'
        );
      }

      // Computed before the push, while the rails still describe the last sync
      // point: these are exactly this agent's own uncommitted changes.
      const changed = team
        ? {
            specPaths: changedSpecPaths(readBaseGame(dir) ?? {}, spec),
            scripts: changedScriptPaths(readBaseScripts(dir), specScriptsByFilePath(spec)),
          }
        : null;
      const trespasses = team && changed ? claimWarnings(team, changed) : [];

      const { status, json } = await api(env, "PUT", variantPath(env, "/game-specs"), {
        gameSpec: spec,
        ...(baseVersion !== null ? { baseVersion } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });

      // The world became a git world since this session last looked. Not a
      // conflict — a lane change, and the document push never reached it.
      if (status === 409 && json?.code === "world_is_git") {
        return gitLaneFrom409(env, info, json, "spawn_push's whole-document PUT");
      }
      if (status === 409) {
        const current = json?.currentVersion;
        const owner =
          team && typeof current === "number" ? findPushByVersion(team.ledgerDir, current) : null;
        return err(
          `version_conflict — ${owner ? `${owner.label} saved v${owner.version}` : `someone else saved v${current ?? "?"}`}. ` +
            `Upstream scripts: ${(json?.upstreamChangedScripts ?? []).join(", ") || "(none named)"}. ` +
            `${owner?.specPaths?.length ? `They touched: ${owner.specPaths.slice(0, 8).join(", ")}. ` : ""}` +
            "Nothing written. Call spawn_latest, merge any .theirs, then push again."
        );
      }
      if (status === 400) {
        return err(
          `push rejected: ${json?.error ?? "unknown"}\n${formatIssues("REJECTED — new schema issues", json?.issues, json?.issueCount)}`
        );
      }
      if (status === 413) {
        return err(
          "spec_too_large (413): crossed boot/wire budget — keep assets as /cdn/ path references, no inline binary/base64."
        );
      }
      if (!json || status !== 200) {
        return err(`push failed (${status}): ${json?.error ?? "unknown"}`);
      }

      if (!dryRun) {
        writeBaseVersion(dir, json.version);
        writeBaseScripts(dir, specScriptsByFilePath(spec));
        // Upstream now holds what we compiled (game.json + world/ overlays), so
        // that is the base the next pull merges against.
        writeBaseGame(dir, spec);
        for (const receipt of receipts) rmSync(receipt, { force: true });
      }

      if (team && changed && !dryRun) {
        appendPush(team.ledgerDir, {
          ts: new Date().toISOString(),
          label: team.label ?? "(unregistered)",
          version: json.version,
          specPaths: changed.specPaths.slice(0, 20),
          scripts: changed.scripts.slice(0, 20),
        });
      }

      return text({
        ok: true,
        dryRun,
        version: json.version,
        ...(receipts.length && !dryRun
          ? { discardedReceipts: receipts.map((r) => relative(dir, r)) }
          : {}),
        ...(autoPulled
          ? {
              autoPulled: {
                ...autoPulled,
                note: `Rebased onto v${autoPulled.to}${autoPulled.by ? ` (${autoPulled.by}'s push)` : ""} before pushing, cleanly.`,
              },
            }
          : {}),
        ...(trespasses.length ? { claimWarnings: trespasses } : {}),
        playUrl: absoluteUrl(env.apiUrl, json.playUrl),
        rooms: json.rooms,
        roomsError: json.roomsError,
        preExistingDebt: json.issues,
        issueCount: json.issueCount,
      });
  }

  server.registerTool(
    "spawn_exec",
    {
      description:
        "Run a read-only JavaScript snippet against the live room (e.g. query objects, read an object's state). Pushing is the only write path. Needs a LIVE ROOM, and a room boots for a PLAYER, never for a door: the cheapest way to get one is spawn_client_join, which stands your own body in the world with no browser and no GPU (spawn_play_open boots one too, and is the right call when you need to SEE rather than query). Without either you get 409 no_live_room or a 5xx. `api.sql` is NOT available here at all (the endpoint is read-only server-side and refuses SQL outright, even SELECT) — there is no way to read the game database through this server.",
      inputSchema: {
        script: z
          .string()
          .describe(
            "JS to eval in the live room, e.g. return api.query({}).slice(0,50).map(o => ({id:o.id, pos:o.feetPosition, tags:o.tags}))"
          ),
        projectDir: projectDirSchema,
      },
    },
    async ({ script, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const result = await api(env, "POST", variantPath(env, "/agent/exec"), { script });
      if (result.status !== 200) return err(`exec failed (${result.status}): ${execHint(result)}`);
      // The endpoint answers 200 with { ok: false, error } when the SCRIPT
      // failed. Reporting that as success makes a broken script look like a
      // working one.
      if (result.json && result.json.ok === false) {
        return err(`exec script failed: ${result.json.error ?? JSON.stringify(result.json)}`);
      }
      return text(result.json);
    }
  );

  server.registerTool(
    "spawn_logs",
    {
      description:
        "Variant logs + live room script logs. Use when behavior doesn't match what you pushed — script syntax and runtime "  +
        "errors surface here, not in a push receipt. Needs a live room: spawn_client_join stands your own body and boots one without a browser.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const result = await api(env, "GET", variantPath(env, "/agent/logs"));
      if (result.status !== 200) return err(`logs failed (${result.status}): ${execHint(result)}`);
      return text(result.json);
    }
  );

  server.registerTool(
    "spawn_rooms",
    {
      description:
        "Active rooms + player counts for the current variant, and the room exec/logs will target. An empty list is a room you can "  +
        "boot yourself: spawn_client_join puts your body in the world and it appears here while the body stands.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const result = await api(env, "GET", variantPath(env, "/agent/rooms"));
      if (result.status !== 200) return err(`rooms failed (${result.status}): ${execHint(result)}`);
      return text(result.json);
    }
  );

  server.registerTool(
    "spawn_savi",
    {
      description:
        "Write into the creator's studio chat, where Savi (their in-game AI companion) reads it. Two uses, and the second is the valuable one. (1) Context after a meaningful push, so you don't fight over the world. (2) HAND OFF WORK: pass `task` and Savi can take it on, fanning it out across its own sub-agents — up to 8 in the studio, needing no bootstrap key, worktree, or browser of its own. Check spawn_savi_status first: it counts the lanes already burning, and every idle one is a sub-agent that would be finishing work while you build. The strongest targets are the ones where your own lane is weakest: you make art by naming a cdn/ path, and that path is spent on first fetch and cannot be re-rolled, so art that needs iterating — or that the creator wants to steer — is better handed to Savi, who can try it again with them in the loop. Delegate BROAD and GENERAL (\"build out the northern district\"), never as a step list — the splitting is what the fan-out is good at, and a narrow task wastes it. NOTHING COMES BACK: no reply, no acknowledgement, no completion event, and no endpoint on this API reports who pushed. So declare your boundary with `keepOff` rather than asking for one, and never put a delegated task on your own critical path. Uptake is visible even though acknowledgement is not: spawn_savi_status shows a new wisp lighting up and what Savi has it doing, which tells you the fan-out started — not that it started on YOUR task, since nothing here reports an author. Detect the finished work by inference rather than by reading a field — head moving past your own last push (spawn_status `remote.headVersion`) is Savi or the creator, and in team mode spawn_team_status `recentPushes` is what rules out a teammate. Then spawn_latest to take it and LOOK at it: work arriving on your rail is unverified until you screenshot it, exactly like your own.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .describe('What just happened, e.g. "Pushed v12: parkour course in the north canyon. Atmosphere untouched if you want it."'),
        task: z
          .string()
          .optional()
          .describe(
            'Work to hand over, stated broadly, e.g. "Give the north canyon a night pass — lighting, ambient audio, and whatever set dressing sells it." Omit for a pure status note.'
          ),
        subAgents: z
          .number()
          .int()
          .min(1)
          // Mirrors the studio UI's fan-out limit, not a server constraint: the
          // number never reaches an endpoint, it ends up as prose in the chat.
          .max(8)
          .optional()
          .describe(
            "Pin how wide Savi should fan the task out (the studio allows up to 8; 1 asks it NOT to split). Omit to let Savi split it as far as it splits, which is usually the better ask."
          ),
        keepOff: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Areas you are still working in, so Savi routes its sub-agents around you, e.g. ["scripts/player/**", "world.terrain"]. Advisory — the same trust model as spawn_team_claim.'
          ),
        projectDir: projectDirSchema,
      },
    },
    async ({ message, task, subAgents, keepOff, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      // Three builders writing "leave that to me" into one studio chat are
      // indistinguishable without this, which would make keepOff unroutable in
      // exactly the mode it exists for.
      const composed = renderHandoff({
        message,
        task,
        subAgents,
        keepOff,
        label: teamContext(dir)?.label ?? null,
      });
      const { status, json } = await api(env, "POST", variantPath(env, "/studio-chat/notify"), {
        message: composed,
      });
      // The door is now closed by ACCOUNT CLASS: a standalone agent account
      // (sak_ from /signup) can never wake Savi, linked or not, while a human's
      // personal token still can. Reported as itself rather than a bare 403,
      // because retrying and re-wording both fail forever.
      if (status === 403 && json?.error === "agent_lane_closed") {
        return err(
          "Savi's lane is closed to this token: she is only woken by a person's own token, never by an agent account. " +
            (json?.verdict ? `${json.verdict} ` : "") +
            "Nothing was sent, and no wording or retry opens it.\n\n" +
            "Your work still reaches her — on a 6.0 world every push lands in the creator's chat as a commit row she reads on their " +
            "next turn, so put what she needs in the commit message body (spawn_push `body`). To hand her a TASK, ask the creator to " +
            "ask her; spawn_savi_status still shows what her sub-agents are doing."
        );
      }
      if (status !== 200) return err(`savi failed (${status}): ${json?.error}`);
      // Gate on the same predicate renderHandoff uses: a whitespace-only task
      // composes no ask, and reporting one would leave the model waiting on
      // work it never actually requested.
      const handedOff = isHandoff({ task });
      // Composed after the POST so the numbers describe the fleet this task is
      // landing in. Best effort: no play session means no wisps to read, which
      // is a reason to open one rather than an error.
      const fleet = summarizeFleet({
        snapshot: readStudio(),
        onScreen: getSession() ? await countWispsOnScreen() : null,
        sessionOpen: getSession() !== null,
      });
      return text({
        ok: true,
        // Echoing back a bare status note just bills the model for its own
        // sentence; worth showing only when this composed something in.
        ...(composed === message.trim() ? {} : { sent: composed }),
        ...(handedOff ? { savi: renderFleetLine(fleet) } : {}),
        note: handedOff
          ? "Handed off. Nothing acknowledges a task on this channel and no endpoint reports an author, so don't wait on it and don't sequence anything behind it. Keep building your own area. Watch it start with spawn_savi_status — a wisp lighting up is Savi taking work on — and read the work landing as spawn_status remote.headVersion moving past your own last push (in team mode, spawn_team_status recentPushes rules out a teammate). Then spawn_latest to take it, and screenshot it before building on top — it is unverified until you look."
          : "Sent — Savi will see it as background context.",
      });
    }
  );

  server.registerTool(
    "spawn_revoke",
    {
      description:
        "Revoke the durable agent token (disconnect). Removes SPAWN_AGENT_KEY from project .env after success.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      latchProject(dir, "spawn_revoke");
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY");
      const { status, json } = await api(env, "POST", "/api/agent/v1/token/revoke");
      if (status !== 200) return err(`revoke failed (${status}): ${json?.error}`);
      // Clear key from .env without leaving the secret value hanging in updates map as empty? Yes clear it.
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) {
        const raw = readFileSync(envPath, "utf8");
        const cleaned = raw
          .split("\n")
          .filter((line) => !/^\s*SPAWN_AGENT_KEY\s*=/.test(line))
          .join("\n");
        saveFile(envPath, cleaned.endsWith("\n") ? cleaned : cleaned + "\n");
      }
      return text({ ok: true, note: "Token revoked — this connection is dead." });
    }
  );

  server.registerTool(
    "spawn_status",
    {
      description:
        "Where this project stands. Always reports env (masked), credential source, docs present, and — once credentials allow — the world's " +
        "ENGINE (era + semver), which decides everything else. On engine 6.0+ the remote block is git: branch, HEAD, how many commits ahead of " +
        "and behind origin, and the uncommitted files. On a pre-6.0 world it is the version rail: base version, conflict receipts, headVersion " +
        "vs publishedVersion.",
      inputSchema: {
        projectDir: projectDirSchema,
        engineVersion: engineVersionSchema,
        remote: z
          .boolean()
          .default(true)
          .describe("When credentials exist, also read the remote (git divergence, or head + published versions)"),
      },
    },
    async ({ projectDir, remote, engineVersion }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      const localBaseVersion = readBaseVersion(dir);
      const conflictReceipts = listConflictReceipts(dir).map((r) => relative(dir, r));
      const status: Record<string, unknown> = {
        projectDir: dir,
        apiUrl: env.apiUrl || null,
        agentKey: env.agentKey ? maskToken(env.agentKey) : null,
        // "process" means the key came from the MCP config rather than this
        // project's .env — the thing to check first when an agent turns out to
        // be pushing as a different connection than you expected.
        credentialSource: env.sources,
        variantId: env.variantId || null,
        baseVersion: localBaseVersion,
        // False on a project that predates the spec merge: the next pull replaces
        // game.json wholesale (with a backup), establishes the rail, and merges
        // from then on.
        hasSpecRail: readBaseGame(dir) !== null,
        conflictReceipts,
        hasGameJson: existsSync(join(dir, "game.json")),
        hasGuide: existsSync(join(stateDir(dir), "guide.md")),
        hasTomeApi: existsSync(join(stateDir(dir), "tome-api.md")),
        hasSkills: existsSync(join(stateDir(dir), "skills.json")),
      };

      const team = teamContext(dir);
      if (team) {
        status.team = {
          label: team.label,
          registered: team.label !== null,
          yourClaims: team.claims.claims.filter((c) => c.label === team.label).map((c) => c.pattern),
          claimedByOthers: team.claims.claims
            .filter((c) => c.label !== team.label)
            .map((c) => ({ pattern: c.pattern, label: c.label })),
          ...(team.label === null
            ? { note: "This worktree is not in the team ledger — run spawn_team_init. spawn_team_status shows the rest of the team." }
            : {}),
        };
      }

      const canRemote =
        remote && Boolean(env.apiUrl && env.agentKey && env.variantId);
      if (!canRemote) {
        status.remote = remote
          ? { skipped: true, reason: "Need SPAWN_API_URL, SPAWN_AGENT_KEY, SPAWN_VARIANT_ID" }
          : { skipped: true, reason: "remote:false" };
        return text(status);
      }

      const resolved = await lane(dir, env, engineVersion);
      if ("failure" in resolved) return resolved.failure;
      status.engine = engineSummary(resolved.info);

      if (isGitLane(resolved.info.era)) {
        // The base-version rail and the .theirs receipts describe the document
        // lane. Reporting them for a git world would be answering a question
        // nobody asked with numbers that mean nothing here.
        delete status.baseVersion;
        delete status.hasSpecRail;
        delete status.conflictReceipts;
        delete status.hasGameJson;

        if (!(await isGitRepo(dir))) {
          status.remote = {
            skipped: true,
            reason: `${dir} is not a clone of this world — run spawn_init.`,
            gitUrl: resolved.info.gitUrl,
          };
          return text(status);
        }
        const check = await checkClone(dir, resolved.info);
        const st = await gitStatus(dir);
        status.remote = {
          lane: laneName(resolved.info.era),
          gitUrl: resolved.info.gitUrl,
          ...(check.ok ? {} : { warning: check.message }),
          branch: st.branch,
          upstream: st.upstream,
          head: st.headShort,
          headSubject: st.headSubject,
          ahead: st.ahead,
          behind: st.behind,
          uncommitted: st.dirty,
          spawnNote: await spawnNote(dir),
          note:
            st.behind > 0
              ? `origin is ${st.behind} commit(s) ahead — spawn_latest to rebase onto it before pushing.`
              : st.dirty.length
                ? `${st.dirty.length} uncommitted change(s) — spawn_push with a message commits and pushes them live.`
                : st.ahead > 0
                  ? `${st.ahead} commit(s) not yet pushed — spawn_push sends them.`
                  : "In sync with origin.",
        };
        return text(status);
      }

      // allSettled: an unreachable API should degrade this report, not fail it.
      const [headSettled, liveSettled] = await Promise.allSettled([
        api(env, "GET", latestPath(env)),
        api(env, "GET", latestPath(env, { mode: "live" })),
      ]);
      const unreachable = (s: PromiseSettledResult<ApiResult>): ApiResult =>
        s.status === "fulfilled"
          ? s.value
          : { status: 0, ok: false, json: null, bodyText: String(s.reason?.message ?? s.reason) };
      const head = unreachable(headSettled);
      const live = unreachable(liveSettled);

      const headVersion = head.status === 200 ? (head.json?.version as number | undefined) : null;
      const publishedVersion =
        live.status === 200 ? (live.json?.version as number | undefined) : null;
      const published =
        live.status === 200
          ? { ok: true as const, version: publishedVersion }
          : {
              ok: false as const,
              status: live.status,
              error:
                live.status === 404
                  ? live.json?.error ?? "nothing published yet"
                  : apiError(live),
            };

      status.remote = {
        headVersion: head.status === 200 ? headVersion : null,
        headError: head.status === 200 ? null : apiError(head),
        published,
        localBaseVersion,
        localBehindHead:
          headVersion != null && localBaseVersion != null
            ? localBaseVersion < headVersion
            : null,
        headAheadOfPublished:
          headVersion != null && publishedVersion != null
            ? headVersion - publishedVersion
            : null,
        note:
          published.ok === false && live.status === 404
            ? "Publish in the Spawn UI before multi-agent work so players keep a stable live snapshot while agents push to dev head."
            : conflictReceipts.length > 0
              ? "Unresolved .theirs receipts — merge before push."
              : undefined,
      };
      return text(status);
    }
  );
}
