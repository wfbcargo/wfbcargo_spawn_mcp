/**
 * The git lane: how this server clones, pulls, and pushes an engine-6.0 world.
 *
 * A 6.0 world's repo authenticates with the same Spawn agent token the API
 * uses, as the HTTPS basic-auth password. That is a bearer credential, so the
 * rule here is that it never lands anywhere durable:
 *
 *   - The credential helper is passed per-invocation with `-c`, so it is never
 *     written into `.git/config` — a clone this server made carries no
 *     credential of any kind, and neither does `git remote -v`.
 *   - The helper body references `$SPAWN_TOKEN`, expanded by the shell git runs
 *     it in, so the secret is never an argv element (which is world-readable on
 *     most systems). The value reaches the child through its environment only.
 *   - Anything we capture from git is scrubbed before it is returned, because a
 *     URL echoed in an error can carry credentials a user pre-configured.
 *
 * `GIT_TERMINAL_PROMPT=0` matters more than it looks: an MCP server has no
 * terminal, so a git that decides to ask for a password would hang the tool
 * call until the client gave up. Failing fast is the only safe answer.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Long enough for a cold clone of a world with history, short enough to fail. */
const GIT_TIMEOUT_MS = Number(process.env.SPAWN_GIT_TIMEOUT_MS) || 180_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export type GitCreds = { username: string; token: string };

export type GitRun = { ok: boolean; code: number; stdout: string; stderr: string };

/**
 * A username reaches a shell snippet, so it is validated rather than escaped.
 * Spawn handles are `[A-Za-z0-9_-]` plus the `@` an agent handle carries; a
 * name outside that is a bug or an attack, and neither should reach `sh -c`.
 */
const SAFE_USERNAME = /^@?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeUsername(username: string): string {
  if (!SAFE_USERNAME.test(username)) {
    throw new Error(
      `Refusing to build a git credential helper for username ${JSON.stringify(username)} — ` +
        "it is not a plain Spawn handle, and it would be interpolated into a shell command."
    );
  }
  return username;
}

/**
 * `$SPAWN_TOKEN` is deliberately NOT interpolated here: git's shell expands it
 * at use time from the environment we hand the child, so the token itself never
 * appears in an argument list or in any file.
 */
function credentialHelper(username: string): string {
  return `!f() { echo username=${assertSafeUsername(username)}; echo password=$SPAWN_TOKEN; }; f`;
}

/** Remove a token from anything we are about to show a model or a user. */
export function scrub(text: string, token?: string): string {
  let out = text;
  if (token && token.length > 6) out = out.split(token).join("«token»");
  // Credentials a user configured themselves can ride in an echoed remote URL.
  return out.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, "$1«credentials»@");
}

function gitArgs(creds: GitCreds | null, args: string[]): string[] {
  if (!creds) return args;
  return [
    // The empty value resets any helper chain the machine has configured —
    // a stored credential for a different Spawn account otherwise answers
    // first and the push fails as the wrong identity.
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${credentialHelper(creds.username)}`,
    ...args,
  ];
}

export async function git(
  cwd: string,
  args: string[],
  creds: GitCreds | null = null
): Promise<GitRun> {
  try {
    const { stdout, stderr } = await run("git", gitArgs(creds, args), {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        ...(creds ? { SPAWN_TOKEN: creds.token } : {}),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ADVICE: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    return { ok: true, code: 0, stdout: scrub(stdout, creds?.token), stderr: scrub(stderr, creds?.token) };
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(
        "git is not on PATH. The git lane (engine 6.0 worlds) needs it — install git, or work a pre-6.0 world through the document lane."
      );
    }
    if (e?.killed) {
      throw new Error(
        `git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms (set SPAWN_GIT_TIMEOUT_MS to raise).`
      );
    }
    return {
      ok: false,
      code: typeof e?.code === "number" ? e.code : 1,
      stdout: scrub(String(e?.stdout ?? ""), creds?.token),
      stderr: scrub(String(e?.stderr ?? e?.message ?? ""), creds?.token),
    };
  }
}

/** `git ...` or throw with git's own message — for steps with no useful fallback. */
async function gitOrThrow(
  cwd: string,
  args: string[],
  creds: GitCreds | null,
  what: string
): Promise<string> {
  const r = await git(cwd, args, creds);
  if (!r.ok) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `git exit ${r.code}`}`);
  return r.stdout.trim();
}

/* ----------------------------------------------------------------- reading */

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

export async function remoteUrl(dir: string, remote = "origin"): Promise<string | null> {
  const r = await git(dir, ["remote", "get-url", remote]);
  return r.ok ? r.stdout.trim() || null : null;
}

export type GitStatus = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: string[];
  clean: boolean;
  head: string | null;
  headSubject: string | null;
};

/**
 * Branch, divergence, and working-tree state in one read.
 *
 * `--branch --porcelain=v1` is the stable form: the first line carries the
 * upstream and the ahead/behind counts, every other line is a changed path.
 */
export async function status(dir: string): Promise<GitStatus> {
  const r = await git(dir, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]);
  if (!r.ok) throw new Error(`git status failed: ${(r.stderr || r.stdout).trim()}`);

  const lines = r.stdout.split("\n").filter(Boolean);
  const header = lines.find((l) => l.startsWith("##")) ?? "";
  const dirty = lines.filter((l) => !l.startsWith("##")).map((l) => l.slice(3).trim());

  const branchMatch = header.match(/^## (?:No commits yet on )?([^.\s]+(?:\.[^.\s]+)*)/);
  let branch = branchMatch ? branchMatch[1] : null;
  if (branch === "HEAD" || branch === "(no") branch = null;
  const upstreamMatch = header.match(/\.\.\.([^\s]+)/);
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);

  const head = (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
  const headSubject = (await git(dir, ["log", "-1", "--pretty=%s"])).stdout.trim() || null;

  return {
    branch,
    upstream: upstreamMatch ? upstreamMatch[1] : null,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    dirty,
    clean: dirty.length === 0,
    head,
    headSubject,
  };
}

/** The world's own reading of a commit, when the notes ref has been fetched. */
export async function spawnNote(dir: string, ref = "HEAD"): Promise<string | null> {
  const r = await git(dir, ["notes", "--ref=spawn", "show", ref]);
  return r.ok ? r.stdout.trim() || null : null;
}

/* ----------------------------------------------------------------- writing */

const NOTES_REFSPEC = "+refs/notes/*:refs/notes/*";

/**
 * Keep our own files out of the world's tree without touching its `.gitignore`.
 *
 * `.env` holds the token and `.spawn/` holds this server's caches; neither
 * belongs in a commit. Writing them into the tracked `.gitignore` would make
 * every clone carry a change nobody asked for, so this uses `.git/info/exclude`,
 * which is local to the clone and never pushed.
 */
export function excludeLocally(dir: string, patterns: string[] = DEFAULT_EXCLUDES): string[] {
  const file = join(dir, ".git", "info", "exclude");
  try {
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const present = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = patterns.filter((p) => !present.has(p) && !present.has(p.replace(/\/$/, "")));
    if (missing.length) {
      writeFileSync(
        file,
        existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"
      );
    }
    return missing;
  } catch {
    return [];
  }
}

/** Fetch the spawn notes ref alongside branches, so `spawnNote` has something to read. */
export async function configureNotes(dir: string): Promise<void> {
  const existing = await git(dir, ["config", "--get-all", "remote.origin.fetch"]);
  if (existing.stdout.split("\n").some((l) => l.trim() === NOTES_REFSPEC)) return;
  await git(dir, ["config", "--add", "remote.origin.fetch", NOTES_REFSPEC]);
}

/**
 * Give the clone a committer identity when the machine has none.
 *
 * Attribution on Spawn is the token's persona, not this name, so the value only
 * has to exist — but `git commit` refuses outright without one, and an agent
 * hitting that gets an error about nothing it can act on.
 */
export async function ensureIdentity(dir: string, username: string): Promise<boolean> {
  const email = await git(dir, ["config", "user.email"]);
  const name = await git(dir, ["config", "user.name"]);
  if (email.ok && email.stdout.trim() && name.ok && name.stdout.trim()) return false;
  const handle = username.replace(/^@+/, "");
  await git(dir, ["config", "user.name", handle]);
  await git(dir, ["config", "user.email", `${handle}@agents.spawn.co`]);
  return true;
}

export type CloneResult = {
  cloned: boolean;
  dir: string;
  branch: string;
  excluded: string[];
  depth: number;
  /** False when the world's own commit readings could not be fetched (shallow). */
  notes: boolean;
};

/**
 * How much history a clone takes by default.
 *
 * A world's full history is not a reasonable thing to ask for: measured on a
 * live one, `main` alone was 18,500 objects and 80 MB and the fetch did not
 * finish — Savi, exec, and every other clone commit into the same repo all day.
 * The same world's tip is ~320 objects and a few seconds. Nothing this server
 * does needs deep history: it edits the tip, commits, and pushes.
 */
const DEFAULT_DEPTH = 20;

/** What this server puts in a project dir itself — never the world's own files. */
const OURS = new Set([".env", ".spawn", ".git"]);

/**
 * Only `.env` is ours to hide inside a world tree.
 *
 * `.spawn/` is emphatically NOT: a 6.0 world tracks its engine pin, its skills
 * index and its per-cell cost files there. Excluding the directory would make
 * `git add -A` silently skip any new file an agent writes into it, and the push
 * would land missing exactly the work nobody thought to check.
 */
const DEFAULT_EXCLUDES = [".env"];

/**
 * True when nothing but our own files is in the way.
 *
 * A project dir necessarily holds `.env` before any of this runs — that is
 * where the token lives, and without it there is nothing to authenticate a
 * clone with. So "empty" has to mean "no world in it", not "no entries".
 */
export function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).every((entry) => OURS.has(entry));
  } catch {
    return false;
  }
}

/**
 * Materialise a world's repo into a directory that already has files in it.
 *
 * `git clone` refuses a non-empty destination, and the destination is never
 * empty here — `.env` is what made the call possible. init + fetch + checkout
 * is the same result without that constraint, and it keeps the safe refusal
 * that matters: if an incoming file would overwrite something already on disk,
 * checkout stops and names it rather than clobbering the work.
 */
export async function cloneInto(
  gitUrl: string,
  dest: string,
  creds: GitCreds,
  { depth = DEFAULT_DEPTH }: { depth?: number } = {}
): Promise<CloneResult> {
  mkdirSync(dest, { recursive: true });
  await gitOrThrow(dest, ["init", "-q"], null, "git init");

  const hasRemote = (await git(dest, ["remote", "get-url", "origin"])).ok;
  await gitOrThrow(
    dest,
    hasRemote ? ["remote", "set-url", "origin", gitUrl] : ["remote", "add", "origin", gitUrl],
    null,
    "configure origin"
  );

  const shallow = depth > 0;
  // The notes ref points at commits all through history, so on a shallow clone
  // it cannot resolve — and configuring the refspec anyway would break every
  // later `git pull` with "remote did not send all necessary objects". Notes
  // are a nicety; a working pull is not.
  if (!shallow) await configureNotes(dest);

  // Before the checkout, so our own files are never candidates for a collision.
  const excluded = excludeLocally(dest);

  await gitOrThrow(
    dest,
    ["fetch", ...(shallow ? ["--depth", String(depth)] : []), "origin"],
    creds,
    `fetch ${gitUrl}`
  );
  // The world names its own default branch; assuming `main` would strand a
  // world that does not use it.
  await git(dest, ["remote", "set-head", "origin", "-a"], creds);
  const symbolic = await git(dest, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = symbolic.ok ? symbolic.stdout.trim().replace(/^origin\//, "") || "main" : "main";

  await gitOrThrow(dest, ["checkout", "-B", branch, `origin/${branch}`], creds, `checkout ${branch}`);
  await ensureIdentity(dest, creds.username);
  return { cloned: true, dir: dest, branch, excluded, depth, notes: !shallow };
}

export type PullResult = {
  ok: true;
  changed: boolean;
  before: string | null;
  after: string | null;
  files: string[];
  output: string;
};

export type PullConflict = {
  ok: false;
  reason: "dirty" | "conflict" | "failed";
  message: string;
  paths: string[];
};

/** Is a rebase actually mid-flight, or did the command just fail? */
async function rebaseInProgress(dir: string): Promise<boolean> {
  const gitDir = await git(dir, ["rev-parse", "--git-path", "rebase-merge"]);
  const apply = await git(dir, ["rev-parse", "--git-path", "rebase-apply"]);
  return [gitDir.stdout.trim(), apply.stdout.trim()]
    .filter(Boolean)
    .some((p) => existsSync(join(dir, p)) || existsSync(p));
}

/**
 * `git pull --rebase`, with the two ways it goes wrong told apart.
 *
 * A dirty tree is refused before anything starts rather than stashed: the local
 * edits are the agent's unpushed work, and moving them somewhere it will not
 * look for them is worse than saying no. A rebase that collides is aborted, so
 * the clone is never left mid-rebase for a tool that has no way to finish one.
 */
export async function pullRebase(dir: string, creds: GitCreds): Promise<PullResult | PullConflict> {
  const before = await status(dir);
  if (!before.clean) {
    return {
      ok: false,
      reason: "dirty",
      message:
        "Working tree has uncommitted changes, so a rebase would move them out from under you. " +
        "Commit them (spawn_push) or discard them, then pull.",
      paths: before.dirty,
    };
  }

  const beforeSha = before.head;
  const r = await git(dir, ["pull", "--rebase", "--no-autostash"], creds);
  if (!r.ok) {
    const detail = (r.stderr || r.stdout).trim();
    const conflicting = await git(dir, ["diff", "--name-only", "--diff-filter=U"]);
    const paths = conflicting.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const midRebase = await rebaseInProgress(dir);

    // A pull can fail for reasons that are not a collision at all — no network,
    // a refused credential, a bad flag. Calling those "your changes conflict"
    // sends the agent to resolve a conflict that does not exist.
    if (!midRebase && paths.length === 0) {
      return { ok: false, reason: "failed", message: `git pull --rebase failed: ${detail}`, paths: [] };
    }

    // Leave no half-rebased clone behind: a tool cannot drive an interactive
    // rebase, and the agent's commits are safest exactly where they were.
    await git(dir, ["rebase", "--abort"]);
    return {
      ok: false,
      reason: "conflict",
      message:
        "Rebase onto origin collided and was aborted — your commits are intact and nothing moved. " +
        `Resolve by hand in ${dir}: git pull --rebase, fix the conflicts, git rebase --continue.\n\n${detail}`,
      paths,
    };
  }

  const after = await status(dir);
  const files =
    beforeSha && after.head && beforeSha !== after.head
      ? (await git(dir, ["diff", "--name-only", `${beforeSha}..${after.head}`])).stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

  return {
    ok: true,
    changed: beforeSha !== after.head,
    before: beforeSha,
    after: after.head,
    files,
    output: (r.stdout + r.stderr).trim(),
  };
}

export type PushResult = {
  ok: true;
  committed: boolean;
  sha: string | null;
  subject: string;
  files: string[];
  pushed: boolean;
  /** The `remote:` lines — rooms, players, and each room's verdict on the push. */
  verdicts: string[];
  output: string;
  note: string | null;
};

export type PushFailure = { ok: false; stage: "commit" | "push"; message: string; behind?: boolean };

/**
 * Files that are this server's or the agent's, never the world's.
 *
 * A 6.0 push is `git add -A`, so anything sitting in the project directory goes
 * into the world. Screenshots, sync receipts, a document-lane `game.json`, and
 * a stray credential file are all things a tool run can leave behind, and none
 * of them belong in a world people are standing in.
 */
const NOT_THE_WORLDS = [
  /(^|\/)\.env($|\.)/,
  /\.theirs$/,
  /(^|\/)screenshots\//,
  /(^|\/)game\.json$/,
  /(^|\/)node_modules\//,
];

export function strangersIn(paths: string[]): string[] {
  return paths.filter((p) => NOT_THE_WORLDS.some((re) => re.test(p)));
}

/** Lines the git server printed back — where a 6.0 world reports its verdict. */
export function remoteLines(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("remote:"))
    .map((l) => l.replace(/^remote:\s?/, "").trimEnd())
    .filter(Boolean);
}

/**
 * Stage, commit, push — the whole 6.0 write in one step.
 *
 * The commit's first line is not a log entry: it lands in the creator's chat
 * under the agent's name, beside what they and Savi said. That is why `message`
 * is a required argument on this lane and why the body is kept separate.
 */
export async function commitAndPush(
  dir: string,
  creds: GitCreds,
  {
    message,
    body,
    branch,
    allowEmpty = false,
  }: { message: string; body?: string; branch?: string; allowEmpty?: boolean }
): Promise<PushResult | PushFailure> {
  await ensureIdentity(dir, creds.username);

  const before = await status(dir);
  // The checked-out branch is the world's own default (cloneInto resolved it
  // from origin/HEAD); hardcoding `main` would push a world that uses another
  // name onto a branch nothing reads.
  const target = branch ?? before.branch ?? "main";
  const files = before.dirty.slice();
  let committed = false;

  if (!before.clean) {
    const add = await git(dir, ["add", "-A"]);
    if (!add.ok) return { ok: false, stage: "commit", message: `git add failed: ${add.stderr.trim()}` };
    const args = ["commit", "-m", message, ...(body ? ["-m", body] : [])];
    const commit = await git(dir, args);
    if (!commit.ok) {
      return { ok: false, stage: "commit", message: `git commit failed: ${(commit.stderr || commit.stdout).trim()}` };
    }
    committed = true;
  } else if (before.ahead === 0 && !allowEmpty) {
    return {
      ok: false,
      stage: "commit",
      message:
        "Nothing to push: the working tree is clean and no local commit is ahead of origin. Edit the tree first.",
    };
  }

  const push = await git(dir, ["push", "origin", `HEAD:${target}`], creds);
  if (!push.ok) {
    const text = (push.stderr || push.stdout).trim();
    const behind = /non-fast-forward|fetch first|rejected/i.test(text);
    return {
      ok: false,
      stage: "push",
      behind,
      message: behind
        ? `Push refused — origin/${target} has moved since you last pulled. Your commit is safe locally. ` +
          `Run spawn_latest (git pull --rebase), then push again.\n\n${text}`
        : `git push failed: ${text}`,
    };
  }

  const output = (push.stdout + "\n" + push.stderr).trim();
  const after = await status(dir);
  return {
    ok: true,
    committed,
    sha: after.head,
    // When nothing was committed this call pushed a commit that already
    // existed — usually one a refused push left behind. Echoing the `message`
    // argument would report a subject that is not what landed.
    subject: committed ? message : (after.headSubject ?? message),
    files,
    pushed: true,
    verdicts: remoteLines(output),
    output,
    note: await spawnNote(dir),
  };
}
