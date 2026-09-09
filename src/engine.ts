/**
 * Which lane a world speaks.
 *
 * Spawn worlds come in two eras and they are not two versions of one protocol —
 * they are two different write paths:
 *
 *   - `document` (pre-6.0): the world IS a compiled GameSpec document. You
 *     `PUT /game-specs` and the saved document replicates to every open room.
 *   - `6.0` and later: the world IS a git repository. You clone it, edit the
 *     tree, and `git push`; `PUT /game-specs` answers 409 `world_is_git` before
 *     it even reads the body, and `GET /game-specs/latest` degrades to a
 *     read-only projection of the git head.
 *
 * So the era is not decoration on a tool result — it decides which code path a
 * push, a pull, or an init is allowed to take. Everything here exists to answer
 * that question once, cheaply, and to fail loudly when a caller's assumption
 * disagrees with the world.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, variantPath } from "./client.js";
import { saveFile, type SpawnEnv } from "./env.js";

/** The legacy lane. Every other era is a git repository. */
export const DOCUMENT_ERA = "document";

/**
 * `"6.0"` and `"document"` are what the API returns today. The open string
 * keeps a future `"6.1"` / `"7.0"` from being a breaking change here: the only
 * predicate anything downstream asks is `isGitLane`, and "not the document
 * lane" is the durable half of that distinction.
 */
export type Era = "6.0" | "document" | (string & {});

export function isGitLane(era: Era): boolean {
  return era !== DOCUMENT_ERA;
}

export type EngineInfo = {
  era: Era;
  /** Full engine semver when the world names one (`6.0.0`); null on old pins. */
  semver: string | null;
  /** Clone URL — present on the git lane, null on the document lane. */
  gitUrl: string | null;
  address: string | null;
  playUrl: string | null;
  codeUrl: string | null;
  /** Where this reading came from, so a surprising lane is debuggable. */
  source: "pinned" | "cache" | "worlds" | "docs";
  /** True when the caller passed engineVersion instead of us detecting it. */
  pinned: boolean;
  /** Non-fatal disagreement (e.g. pinned 6.0.0, world is on 6.0.1). */
  warning?: string;
};

export function laneName(era: Era): string {
  return isGitLane(era) ? "git lane" : "document lane";
}

/** A caller's `engineVersion` contradicted the world's actual pin. */
export class EngineMismatchError extends Error {
  constructor(
    readonly claimed: { era: Era; semver: string | null },
    readonly actual: EngineInfo
  ) {
    super(
      `engineVersion mismatch: you passed "${claimed.semver ?? claimed.era}" (${laneName(claimed.era)}), ` +
        `but this world is pinned to ${actual.semver ?? actual.era} (${laneName(actual.era)}). ` +
        "Nothing was written. " +
        (isGitLane(actual.era)
          ? "Drop engineVersion to let it detect, or pass the world's real engine version."
          : "Drop engineVersion to let it detect, or pass 'document'.")
    );
    this.name = "EngineMismatchError";
  }
}

/**
 * Parse what a caller passed as `engineVersion`.
 *
 * Accepts the era names the API uses (`document`, `6.0`) and full semvers
 * (`6.0.0`, `v6.0.0`, `5.4`). The major version alone decides the lane: 6 and
 * up is git, everything below it is the document lane — which is exactly the
 * cut the server makes.
 */
export function parseEngineVersion(input: string): { era: Era; semver: string | null } {
  const raw = input.trim();
  if (!raw) throw new Error("engineVersion was empty — omit it to auto-detect.");

  const lowered = raw.toLowerCase();
  if (lowered === DOCUMENT_ERA || lowered === "doc" || lowered === "pre-6.0" || lowered === "pre-6") {
    return { era: DOCUMENT_ERA, semver: null };
  }

  const m = lowered.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) {
    throw new Error(
      `engineVersion "${raw}" is not an engine version. Pass a semver ("6.0.0", "6.0", "5.4") ` +
        'or the era name ("document" for pre-6.0 worlds), or omit it to auto-detect.'
    );
  }
  const major = Number(m[1]);
  const minor = m[2];
  // A bare major/minor is an era statement, not a pin — keep semver null so it
  // never trips the "you said 6.0.0 but the world is on 6.0.1" warning below.
  const semver = m[3] !== undefined ? `${m[1]}.${m[2] ?? "0"}.${m[3]}` : null;
  const era: Era =
    major >= 6 ? (minor !== undefined ? `${major}.${minor}` : `${major}.0`) : DOCUMENT_ERA;
  return { era, semver };
}

/* ------------------------------------------------------------------ cache */

const memo = new Map<string, EngineInfo>();

function memoKey(env: SpawnEnv): string {
  return `${env.apiUrl}|${env.variantId}`;
}

/**
 * A world CAN be migrated from the document lane to 6.0 while a session is
 * running, and the process cache would otherwise keep sending it down the dead
 * lane. The 409 `world_is_git` handler calls this, so the next read re-detects.
 */
export function forgetEngine(env: SpawnEnv): void {
  memo.delete(memoKey(env));
}

/**
 * Where this server keeps its OWN files for a project — docs, caches, the
 * engine reading.
 *
 * On the document lane that is `.spawn/`, as it has always been. On a 6.0 world
 * it cannot be: `.spawn/` is part of the world's tracked tree (engine.yaml,
 * skills.md, the per-cell cost files), so writing caches there mixes our files
 * into the world's, and excluding the directory to keep them out of a commit
 * would silently drop legitimate new world files from `git add -A`.
 *
 * `.git/spawn-mcp/` is the answer: never tracked, never pushed, never touched
 * by a pull, and impossible to confuse with the world's own content.
 */
export function stateDir(dir: string, era?: Era): string {
  const inGitDir = join(dir, ".git", "spawn-mcp");
  // With no era to go on (the engine cache is read before detection), an
  // existing .git/spawn-mcp is the record that this is a git-lane clone.
  if (era ? isGitLane(era) : existsSync(inGitDir)) return inGitDir;
  return join(dir, ".spawn");
}

function cachePath(dir: string, era?: Era): string {
  return join(stateDir(dir, era), "engine.json");
}

export type EngineCache = EngineInfo & {
  variantId: string;
  apiUrl: string;
  username: string | null;
  checkedAt: string;
};

export function readEngineCache(dir: string, env: SpawnEnv): EngineCache | null {
  // Both homes are checked because the lane is not known yet at read time, and
  // a project can legitimately have been provisioned under either.
  for (const file of [join(dir, ".git", "spawn-mcp", "engine.json"), join(dir, ".spawn", "engine.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as EngineCache;
      if (parsed.variantId !== env.variantId || parsed.apiUrl !== env.apiUrl) continue;
      if (!parsed.era) continue;
      return parsed;
    } catch {
      /* try the other home */
    }
  }
  return null;
}

function writeEngineCache(
  dir: string,
  env: SpawnEnv,
  info: EngineInfo,
  username: string | null
): void {
  try {
    const previous = readEngineCache(dir, env);
    saveFile(
      cachePath(dir, info.era),
      JSON.stringify(
        {
          ...info,
          variantId: env.variantId,
          apiUrl: env.apiUrl,
          // Keep a username learned earlier rather than dropping it — the git
          // credential helper needs one and `me` is a separate round-trip.
          username: username ?? previous?.username ?? null,
          checkedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch {
    /* a cache that cannot be written is not a reason to fail the call */
  }
}

/** Remember the git username for the credential helper, without re-detecting. */
export function rememberUsername(dir: string, env: SpawnEnv, username: string): void {
  const cached = readEngineCache(dir, env);
  if (!cached || cached.username === username) return;
  writeEngineCache(dir, env, cached, username);
}

/* --------------------------------------------------------------- detection */

function sameWorld(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/-/g, "");
  return norm(a) === norm(b);
}

function fromWorldsRow(row: any): EngineInfo | null {
  const engine = row?.engine;
  if (!engine || typeof engine.era !== "string") return null;
  return {
    era: engine.era,
    semver: typeof engine.semver === "string" ? engine.semver : null,
    gitUrl: typeof row?.git === "string" ? row.git : null,
    address: typeof row?.address === "string" ? row.address : null,
    playUrl: typeof row?.playUrl === "string" ? row.playUrl : null,
    codeUrl: null,
    source: "worlds",
    pinned: false,
  };
}

/**
 * Ask the API what engine this world is on.
 *
 * Two sources, cheapest first. `/agent/v1/worlds` is a few hundred bytes and
 * already carries the engine block, but it only lists worlds this token has
 * standing on and keys them by world id — which equals the variant id on 6.0,
 * and need not on the document lane. `/agent/docs` is authoritative for any
 * variant the token can reach, at the cost of a much larger body.
 */
async function detect(env: SpawnEnv): Promise<EngineInfo> {
  try {
    const worlds = await api(env, "GET", "/api/agent/v1/worlds");
    if (worlds.status === 200 && Array.isArray(worlds.json?.worlds)) {
      const hit = worlds.json.worlds.find(
        (w: any) =>
          (typeof w?.worldId === "string" && sameWorld(w.worldId, env.variantId)) ||
          (typeof w?.appId === "string" && sameWorld(w.appId, env.variantId))
      );
      const info = hit ? fromWorldsRow(hit) : null;
      if (info) return info;
    }
  } catch {
    /* fall through to docs */
  }

  const docs = await api(env, "GET", variantPath(env, "/agent/docs"));
  if (docs.status !== 200) {
    throw new Error(
      `Could not read this world's engine version (docs ${docs.status}: ${docs.json?.error ?? "unknown"}). ` +
        'Pass engineVersion explicitly ("6.0" for a git world, "document" for a pre-6.0 one) to proceed without detection.'
    );
  }
  const era: Era = typeof docs.json?.era === "string" ? docs.json.era : DOCUMENT_ERA;
  return {
    era,
    semver: typeof docs.json?.engineVersion === "string" ? docs.json.engineVersion : null,
    gitUrl: typeof docs.json?.gitUrl === "string" ? docs.json.gitUrl : null,
    address: null,
    playUrl: typeof docs.json?.playUrl === "string" ? docs.json.playUrl : null,
    codeUrl: typeof docs.json?.codeUrl === "string" ? docs.json.codeUrl : null,
    source: "docs",
    pinned: false,
  };
}

/**
 * The one call every lane-sensitive tool makes.
 *
 * With no `engineVersion` this detects and caches. With one, it still detects —
 * and a disagreement is an error rather than a silent override, because the
 * failure it prevents is a document-lane push aimed at a git world, or worse, a
 * document-lane `game.json` scaffolded over a live clone.
 */
export async function resolveEngine(
  dir: string,
  env: SpawnEnv,
  engineVersion?: string
): Promise<EngineInfo> {
  const claimed = engineVersion ? parseEngineVersion(engineVersion) : null;

  const cached = memo.get(memoKey(env));
  let actual: EngineInfo;
  if (cached) {
    actual = { ...cached, source: "cache" };
  } else {
    try {
      actual = await detect(env);
      memo.set(memoKey(env), actual);
      writeEngineCache(dir, env, actual, null);
    } catch (e: any) {
      // Detection is down. A caller who named the era can still proceed on
      // their word; one who did not gets the detection failure.
      if (!claimed) throw e;
      return {
        era: claimed.era,
        semver: claimed.semver,
        gitUrl: readEngineCache(dir, env)?.gitUrl ?? null,
        address: null,
        playUrl: null,
        codeUrl: null,
        source: "pinned",
        pinned: true,
        warning: `Engine detection failed (${e?.message ?? e}) — proceeding on your engineVersion alone.`,
      };
    }
  }

  if (!claimed) return actual;
  if (claimed.era !== actual.era) throw new EngineMismatchError(claimed, actual);

  const warning =
    claimed.semver && actual.semver && claimed.semver !== actual.semver
      ? `You pinned engineVersion ${claimed.semver}, but the world is on ${actual.semver}. Same lane (${laneName(actual.era)}), so this proceeded — the tree grammar may still differ.`
      : undefined;
  return { ...actual, pinned: true, ...(warning ? { warning } : {}) };
}

/** Shared schema text, so every tool describes the parameter identically. */
export const ENGINE_VERSION_DESCRIPTION =
  "Optional engine version this call assumes: a semver ('6.0.0', '5.4') or an era name ('6.0' for a git world, " +
  "'document' for a pre-6.0 one). Omit it and the world's engine is detected from the API and cached. When passed it is " +
  "CHECKED against the real pin and a mismatch fails the call without writing anything — it is an assertion, not an override.";

/** One block for tool results, so the chosen lane is always visible. */
export function engineSummary(info: EngineInfo): Record<string, unknown> {
  return {
    era: info.era,
    semver: info.semver,
    lane: laneName(info.era),
    detectedFrom: info.source,
    ...(info.gitUrl ? { gitUrl: info.gitUrl } : {}),
    ...(info.warning ? { warning: info.warning } : {}),
  };
}

/**
 * The teaching a document-lane tool prints when the world turns out to be git.
 * Shared so the pointer, the clone line, and the reason read identically
 * wherever an agent runs into the wall.
 */
export function gitLaneRedirect(info: EngineInfo, what: string): string {
  const address = info.address ?? "this world";
  return (
    `${what} is the document lane, and ${address} is on engine ${info.semver ?? info.era} — a git repository. ` +
    "Nothing was written.\n\n" +
    (info.gitUrl ? `Repo:  ${info.gitUrl}\n` : "") +
    (info.playUrl ? `Play:  ${info.playUrl}\n` : "") +
    (info.codeUrl ? `Code:  ${info.codeUrl}\n` : "") +
    "\nRun spawn_init to clone it (the token is the git password, supplied per-command and never written to disk), " +
    "then edit the tree and spawn_push with a `message` — spawn_push commits and git-pushes on this lane, and every push is live " +
    "in every open room. spawn_latest pulls with --rebase."
  );
}
