/**
 * Team mode: several agents building one Spawn game, one per git worktree.
 *
 * The model is deliberately small. A Spawn identity is a property of a project
 * DIRECTORY (its `.env`), not of a session, so N worktrees give you N agents
 * with no connection registry and no fleet manager in this server. What lives
 * here is the shared bookkeeping those separate processes cannot hold in memory:
 * where the ledger is, who is in it, and the latch that keeps one session from
 * quietly acting as two different agents.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const ROSTER_FILE = "roster.json";
const LOCK_DIR = "lock";
/** A holder that dies mid-write must not wedge the ledger forever. */
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

export type TeamAgent = {
  label: string;
  /** Absolute path to this agent's worktree / project dir. */
  projectDir: string;
  variantId: string | null;
  /** Masked prefix only — the ledger never holds a usable token. */
  tokenMask: string | null;
  spawnUser: string | null;
  addedAt: string;
  lastSeenAt: string;
};

export type Roster = { version: 1; agents: TeamAgent[] };

/**
 * Resolve the git common directory without running git.
 *
 * A main checkout has `.git` as a directory. A worktree has `.git` as a file
 * holding `gitdir: <path>`, and that path holds a `commondir` file pointing back
 * at the shared `.git`. Reading those directly is what `git rev-parse
 * --git-common-dir` does, and it keeps this server free of subprocesses.
 */
export function resolveGitCommonDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let stat;
      try {
        stat = statSync(dotGit);
      } catch {
        return null;
      }
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) return resolveWorktreeGitDir(dir, dotGit);
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveWorktreeGitDir(worktreeDir: string, pointerFile: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(pointerFile, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const gitDir = isAbsolute(match[1]) ? match[1] : resolve(worktreeDir, match[1]);

  // `.git/worktrees/<name>/commondir` holds "../.." back to the shared .git.
  // Absent for submodules, where the gitdir already IS the common dir.
  const commonDirFile = join(gitDir, "commondir");
  if (!existsSync(commonDirFile)) return gitDir;
  try {
    const rel = readFileSync(commonDirFile, "utf8").trim();
    return rel ? (isAbsolute(rel) ? rel : resolve(gitDir, rel)) : gitDir;
  } catch {
    return gitDir;
  }
}

/**
 * Where the shared ledger lives. Inside the common `.git` by default: every
 * worktree of the repo resolves to the same path with no configuration, it is
 * scoped to exactly one game, and it can never be committed by accident.
 */
export function resolveLedgerDir(startDir: string): string | null {
  const override = (process.env.SPAWN_TEAM_DIR || "").trim();
  if (override) return resolve(override);
  const commonDir = resolveGitCommonDir(startDir);
  return commonDir ? join(commonDir, "spawn-team") : null;
}

let teamMode = false;

export type TeamModeBoot = {
  enabled: boolean;
  ledgerDir: string | null;
  reason: string;
};

/**
 * Decide team mode once, at boot: tool registration depends on it, and the
 * ledger lookup must not depend on a per-call projectDir.
 *
 * `SPAWN_TEAM=1` is how a team is started, because creating the ledger needs the
 * tools to exist first. Every later session picks the mode up from the ledger
 * the first session created, so builders need no extra config.
 */
export function initTeamMode(): TeamModeBoot {
  const startDir = process.env.SPAWN_PROJECT_DIR || process.cwd();
  const ledgerDir = resolveLedgerDir(startDir);
  const hasLedger = Boolean(ledgerDir && existsSync(join(ledgerDir, ROSTER_FILE)));
  const optedIn = process.env.SPAWN_TEAM === "1";
  teamMode = optedIn || hasLedger;
  return {
    enabled: teamMode,
    ledgerDir,
    reason: hasLedger
      ? `joined the team ledger at ${ledgerDir}`
      : optedIn
        ? "SPAWN_TEAM=1 (no ledger yet — run spawn_team_init)"
        : "solo (set SPAWN_TEAM=1 to start a team)",
  };
}

export function isTeamMode(): boolean {
  return teamMode;
}

/** Test seam. Production code sets the mode through `initTeamMode` only. */
export function setTeamModeForTests(enabled: boolean): void {
  teamMode = enabled;
  latched = null;
}

export const PROJECT_DIR_PINNED_MESSAGE = (configured: string): string =>
  `SPAWN_PROJECT_DIR is set to ${configured} and team mode is on, so this call would act on that one directory no matter which worktree the session is running in.

Why this is refused instead of ignored: an agent's Spawn identity comes from its project directory's .env. With SPAWN_PROJECT_DIR pinned in the MCP config, every session resolves to that same .env, so every agent pushes to the same version rail as the same connection while appearing to work in its own worktree. Nothing errors. The pushes silently overwrite each other, spawn_savi attributes all the work to one connection, and each worktree's .spawn/base-version rail describes a project it is not actually pushing. That failure is invisible from inside the session, which is why it is a hard stop rather than a warning.

Fix either way:
  - Remove SPAWN_PROJECT_DIR from the MCP config and start each session in its own worktree (the process cwd is used), or
  - pass projectDir explicitly on the call, which overrides the global and is never refused.`;

let latched: { dir: string; action: string } | null = null;

/**
 * One session drives one agent.
 *
 * Only identity-bearing actions latch: pushing, applying a pull, revoking, and
 * the play browser (a single Chromium session per process, which a second
 * project dir would otherwise silently steal). Reads stay free to look across
 * worktrees so a conductor can see the whole team, and provisioning
 * (`spawn_bootstrap`, `spawn_init`) stays free so a new worktree can be set up
 * from anywhere.
 */
export function latchProject(dir: string, action: string): void {
  if (!teamMode) return;
  if (!latched) {
    latched = { dir, action };
    return;
  }
  if (latched.dir === dir) return;
  throw new Error(
    `This session is already acting as the agent in ${latched.dir} (first claimed by ${latched.action}). ` +
      `${action} targets ${dir}, which is a different agent.\n\n` +
      "One session drives one agent, because identity, the .spawn/base-version rail, and the single play browser all belong to one project directory. " +
      "Driving two from here would push one agent's work onto the other's rail and point its screenshots at the wrong client.\n\n" +
      `Start a session in ${dir} instead, or use the read-only tools (spawn_status, spawn_latest without applyLocal, spawn_me) to inspect it from here.`
  );
}

export function latchedProject(): string | null {
  return latched?.dir ?? null;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, filePath);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-process mutex for read-modify-write on the ledger. `mkdir` is atomic on
 * every platform we run on; a lock older than the stale window is assumed
 * abandoned and taken, because a crashed agent must not block the rest of a team.
 */
export async function withLedgerLock<T>(ledgerDir: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = join(ledgerDir, LOCK_DIR);
  mkdirSync(ledgerDir, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the failed mkdir and the stat
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the team ledger lock at ${lockPath}. If no other agent is running, delete that directory.`
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function readRoster(ledgerDir: string): Roster {
  try {
    const parsed = JSON.parse(readFileSync(join(ledgerDir, ROSTER_FILE), "utf8"));
    if (parsed && Array.isArray(parsed.agents)) {
      return { version: 1, agents: parsed.agents.filter((a: any) => a?.label && a?.projectDir) };
    }
  } catch {
    /* absent or corrupt — a broken ledger degrades to an empty one */
  }
  return { version: 1, agents: [] };
}

export function writeRoster(ledgerDir: string, roster: Roster): void {
  writeJsonAtomic(join(ledgerDir, ROSTER_FILE), roster);
}

export type AgentUpsert = {
  label: string;
  projectDir: string;
  variantId?: string | null;
  tokenMask?: string | null;
  spawnUser?: string | null;
};

/**
 * Register or refresh one agent. Keyed on the project directory, so re-running
 * with a new label renames the agent in place rather than cloning it, and two
 * agents can never claim the same worktree.
 */
export function upsertAgent(roster: Roster, entry: AgentUpsert, now: string): Roster {
  const dir = resolve(entry.projectDir);
  const existing = roster.agents.find((a) => resolve(a.projectDir) === dir);
  const merged: TeamAgent = {
    label: entry.label,
    projectDir: dir,
    variantId: entry.variantId ?? existing?.variantId ?? null,
    tokenMask: entry.tokenMask ?? existing?.tokenMask ?? null,
    spawnUser: entry.spawnUser ?? existing?.spawnUser ?? null,
    addedAt: existing?.addedAt ?? now,
    lastSeenAt: now,
  };
  return {
    version: 1,
    agents: [...roster.agents.filter((a) => resolve(a.projectDir) !== dir), merged].sort((a, b) =>
      a.label.localeCompare(b.label)
    ),
  };
}

/**
 * Another worktree already using this label, if any. Labels must stay distinct:
 * they are how a human tells two agents apart.
 */
export function findLabelOwner(
  roster: Roster,
  label: string,
  projectDir: string
): TeamAgent | null {
  const dir = resolve(projectDir);
  return (
    roster.agents.find(
      (a) => a.label.toLowerCase() === label.toLowerCase() && resolve(a.projectDir) !== dir
    ) ?? null
  );
}

/** Ledger files present, for status output and diagnostics. */
export function ledgerContents(ledgerDir: string): string[] {
  try {
    return readdirSync(ledgerDir).sort();
  } catch {
    return [];
  }
}
