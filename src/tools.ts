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
  compile,
  formatIssues,
  listConflictReceipts,
  materializeScripts,
  readBaseGame,
  readBaseVersion,
  specScriptsByFilePath,
  syncPulledScripts,
  syncPulledSpec,
  writeBaseGame,
  writeBaseScripts,
  writeBaseVersion,
} from "./compile.js";
import { resolveApiUrl } from "./config.js";
import { SESSION_GUIDE } from "./session.js";
import { latchProject } from "./team.js";
import {
  ensureGitignore,
  loadEnv,
  maskToken,
  requireEnv,
  resolveProjectDir,
  saveFile,
  upsertEnv,
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
 * The live-room endpoints answer 502 when no room is running. That reads as a
 * server outage unless you know a room only exists while someone is connected.
 */
function execHint(result: ApiResult): string {
  const detail = apiError(result);
  if (result.status === 502 || result.status === 503) {
    return `${detail}\n\nA 5xx here usually means NO LIVE ROOM: rooms only exist while a player is connected. Open one with spawn_play_open (or have the creator open the play URL) and retry.`;
  }
  return detail;
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
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      const state = {
        agentKey: Boolean(env.agentKey),
        variantId: Boolean(env.variantId),
        gameJson: existsSync(join(dir, "game.json")),
        docs: existsSync(join(dir, ".spawn", "guide.md")),
        skillsIndex: existsSync(join(dir, ".spawn", "skills.json")),
      };
      const next = !state.agentKey
        ? "spawn_bootstrap — ask the creator for a fresh sbk_ key (Spawn gear → Build with a coding agent)."
        : !state.variantId
          ? "spawn_create_game, or spawn_list_games + spawn_set_variant."
          : !state.gameJson || !state.docs
            ? "spawn_init — scaffold the project and pull docs into .spawn/."
            : "Read .spawn/guide.md + .spawn/tome-api.md, then spawn_skills to pick the skills this build needs.";

      const checklist = Object.entries(state)
        .map(([key, ok]) => `  ${ok ? "✓" : "✗"} ${key}`)
        .join("\n");

      return text(
        `${SESSION_GUIDE}\n\n---\n\nThis project (${dir}):\n${checklist}\n\nNext step: ${next}`
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
          open: `${env.apiUrl}${g.playUrl ?? ""}`,
        })),
      });
    }
  );

  server.registerTool(
    "spawn_create_game",
    {
      description:
        "Create a new game in the creator's account. Optionally writes SPAWN_VARIANT_ID to .env. Creator should open the play URL and keep it open.",
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
      return text({
        ...json,
        playUrlAbsolute: `${env.apiUrl}${json.playUrl ?? ""}`,
        variantWritten: Boolean(setVariant && json?.variantId),
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
        "Scaffold a Spawn game project: gitignore secrets, world/ + scripts/, pull current spec → game.json, materialize scripts, fetch docs into .spawn/ (guide.md, tome-api.md, skills.json).",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");

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
        if (status !== 200) return err(`init: latest failed (${status}): ${json?.error}`);
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

      const docs = await api(env, "GET", variantPath(env, "/agent/docs"));
      if (docs.status !== 200) return err(`init: docs failed (${docs.status}): ${docs.json?.error}`);
      saveFile(join(dir, ".spawn", "guide.md"), docs.json.guide ?? "");
      saveFile(join(dir, ".spawn", "tome-api.md"), docs.json.tomeApi ?? "");
      saveFile(join(dir, ".spawn", "skills.json"), JSON.stringify(docs.json.skills ?? [], null, 2));

      return text({
        ok: true,
        projectDir: dir,
        version,
        scriptsMaterialized,
        engineVersion: docs.json.engineVersion,
        specVersion: docs.json.specVersion,
        playUrl: `${env.apiUrl}${docs.json.playUrl ?? ""}`,
        docsWarnings: docs.json.errors ?? [],
        notes,
        next: 'Read .spawn/guide.md and .spawn/tome-api.md, then load the craft for what you are about to build: spawn_skill ids: ["…"] — every domain the work touches, look skills included (a scene is world-composition + looks, a HUD is game-ui + drawn-art). spawn_skills lists all of them.',
      });
    }
  );

  server.registerTool(
    "spawn_docs",
    {
      description:
        "Fetch engine guide, tome API reference, and skills index. Optionally save under .spawn/. For just the skill menu with descriptions, spawn_skills is cheaper.",
      inputSchema: {
        projectDir: projectDirSchema,
        save: z.boolean().default(true).describe("Write guide.md, tome-api.md, skills.json under .spawn/"),
      },
    },
    async ({ projectDir, save }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const { status, json } = await api(env, "GET", variantPath(env, "/agent/docs"));
      if (status !== 200) return err(`docs failed (${status}): ${json?.error}`);
      if (save) {
        saveFile(join(dir, ".spawn", "guide.md"), json.guide ?? "");
        saveFile(join(dir, ".spawn", "tome-api.md"), json.tomeApi ?? "");
        saveFile(join(dir, ".spawn", "skills.json"), JSON.stringify(json.skills ?? [], null, 2));
      }
      return text({
        engineVersion: json.engineVersion,
        specVersion: json.specVersion,
        playUrl: `${env.apiUrl}${json.playUrl ?? ""}`,
        skills: json.skills,
        errors: json.errors ?? [],
        saved: save,
        guideChars: (json.guide ?? "").length,
        tomeApiChars: (json.tomeApi ?? "").length,
        note: save
          ? "Full docs written to .spawn/ — read those files; this response omits the bodies."
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
      const cachePath = join(dir, ".spawn", "skills.json");

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
        const cached = readSkillsCache(join(dir, ".spawn", "skills.json"));
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
        "Pull a saved spec: head (mode=dev, default), published live (mode=live), an exact version, or a published updateSlug. Head pulls sync scripts (untouched fast-forward; both-changed → <file>.theirs) and update the base-version rail — use after version_conflict. Non-head pulls are read-only unless applyLocal:true (resets local rail to that snapshot). version and updateSlug are mutually exclusive.",
      inputSchema: {
        projectDir: projectDirSchema,
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
    async ({ projectDir, mode, version, updateSlug, applyLocal, saveGameJson }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");

      if (version != null && updateSlug) {
        return err("Pass version OR updateSlug, not both (API mutual exclusion).");
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
        note: notes.join(" "),
      });
    }
  );

  server.registerTool(
    "spawn_validate",
    {
      description:
        "Compile the project (game.json + world/*.json + scripts/**) and run authoritative server-side schema validation. Schema-valid is not the same as good: it says nothing about how the result looks or feels, which comes from the skills you loaded (spawn_skill) before writing the code.",
      inputSchema: { projectDir: projectDirSchema },
    },
    async ({ projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      let spec: any;
      try {
        spec = compile(dir);
      } catch (e: any) {
        return err(e.message);
      }
      const { status, json } = await api(env, "POST", variantPath(env, "/game-specs/validate"), {
        gameSpec: spec,
      });
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
        "Compile + push the project live (~1s in the creator's browser). Every push rebuilds the live room. On 409 version_conflict, call spawn_latest then merge .theirs receipts and push again. A successful push proves the spec parsed, nothing more — look at spawn_play_screenshot before calling the work done, and if what you pushed is visual and untextured or plainly styled, the missing piece is a skill you did not load (spawn_skill ids: drawn-art, custom-materials, looks, game-ui).",
      inputSchema: {
        projectDir: projectDirSchema,
        dryRun: z.boolean().default(false),
        force: z
          .boolean()
          .default(false)
          .describe("Whole-replace without base-version rail / discard .theirs (destructive)"),
      },
    },
    async ({ projectDir, dryRun, force }) => {
      const dir = resolveProjectDir(projectDir);
      latchProject(dir, "spawn_push");
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");

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

      const { status, json } = await api(env, "PUT", variantPath(env, "/game-specs"), {
        gameSpec: spec,
        ...(baseVersion !== null ? { baseVersion } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });

      if (status === 409) {
        return err(
          `version_conflict — someone else saved v${json?.currentVersion ?? "?"}. Upstream scripts: ${(json?.upstreamChangedScripts ?? []).join(", ") || "(none named)"}. Nothing written. Call spawn_latest, merge any .theirs, then push again.`
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

      return text({
        ok: true,
        dryRun,
        version: json.version,
        ...(receipts.length && !dryRun
          ? { discardedReceipts: receipts.map((r) => relative(dir, r)) }
          : {}),
        playUrl: json.playUrl ? `${env.apiUrl}${json.playUrl}` : undefined,
        rooms: json.rooms,
        roomsError: json.roomsError,
        preExistingDebt: json.issues,
        issueCount: json.issueCount,
      });
    }
  );

  server.registerTool(
    "spawn_exec",
    {
      description:
        "Run a read-only JavaScript snippet against the live room (e.g. query objects, read an object's state). Pushing is the only write path. Needs a LIVE ROOM — rooms exist only while a player is connected, so open spawn_play_open first or you get a 5xx. `api.sql` is NOT available here at all (the endpoint is read-only server-side and refuses SQL outright, even SELECT) — there is no way to read the game database through this server.",
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
      description: "Variant logs + live room script logs. Use when behavior doesn't match what you pushed.",
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
      description: "Active rooms + player counts for the current variant.",
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
        "Leave background context for Savi (the creator's in-game AI companion) after meaningful pushes so you don't fight over the world.",
      inputSchema: {
        message: z
          .string()
          .describe('e.g. "Pushed v12: parkour course in the north canyon. Atmosphere untouched if you want it."'),
        projectDir: projectDirSchema,
      },
    },
    async ({ message, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const env = loadEnv(dir);
      requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
      const { status, json } = await api(env, "POST", variantPath(env, "/studio-chat/notify"), {
        message,
      });
      if (status !== 200) return err(`savi failed (${status}): ${json?.error}`);
      return text({ ok: true, note: "Sent — Savi will see it as background context." });
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
        "Local project status plus optional remote head/published versions: env (masked), base version, conflict receipts, docs present, headVersion vs publishedVersion when credentials allow.",
      inputSchema: {
        projectDir: projectDirSchema,
        remote: z
          .boolean()
          .default(true)
          .describe("When credentials exist, also fetch head + published (mode=live) versions"),
      },
    },
    async ({ projectDir, remote }) => {
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
        hasGuide: existsSync(join(dir, ".spawn", "guide.md")),
        hasTomeApi: existsSync(join(dir, ".spawn", "tome-api.md")),
        hasSkills: existsSync(join(dir, ".spawn", "skills.json")),
      };

      const canRemote =
        remote && Boolean(env.apiUrl && env.agentKey && env.variantId);
      if (!canRemote) {
        status.remote = remote
          ? { skipped: true, reason: "Need SPAWN_API_URL, SPAWN_AGENT_KEY, SPAWN_VARIANT_ID" }
          : { skipped: true, reason: "remote:false" };
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
