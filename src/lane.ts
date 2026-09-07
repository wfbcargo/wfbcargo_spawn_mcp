/**
 * What a git-lane tool needs before it can touch a clone: the git credential,
 * and the guarantee that the project directory really is this world's repo.
 *
 * Kept apart from `engine.ts` (which only answers "which lane") and `git.ts`
 * (which only runs git) so neither of those has to know about project layout or
 * about the Spawn API's identity endpoint.
 */
import { api } from "./client.js";
import { readEngineCache, rememberUsername, type EngineInfo } from "./engine.js";
import type { SpawnEnv } from "./env.js";
import { isGitRepo, remoteUrl, type GitCreds } from "./git.js";

/**
 * The git username for this token.
 *
 * Git basic auth needs a username beside the token, and it must be the token
 * owner's handle — the git host resolves standing from the pair. Cached in
 * `.spawn/engine.json` so the common path costs no round trip.
 */
export async function gitCreds(dir: string, env: SpawnEnv): Promise<GitCreds> {
  if (!env.agentKey) {
    throw new Error("Missing SPAWN_AGENT_KEY — the agent token is the git password. Run spawn_bootstrap.");
  }

  const cached = readEngineCache(dir, env)?.username;
  if (cached) return { username: cached, token: env.agentKey };

  const me = await api(env, "GET", "/api/agent/v1/me");
  if (me.status !== 200 || typeof me.json?.username !== "string" || !me.json.username) {
    throw new Error(
      `Could not read this token's username from /me (${me.status}), and git needs it as the basic-auth user. ` +
        (me.status === 401 ? "The token looks invalid — re-run spawn_bootstrap." : "")
    );
  }
  const username: string = me.json.username;
  rememberUsername(dir, env, username);
  return { username, token: env.agentKey };
}

/** Compare clone URLs without being fooled by a trailing slash or a `.git`. */
function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) =>
    u.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "").replace(/^https?:\/\//, "");
  return norm(a) === norm(b);
}

export type CloneCheck =
  | { ok: true; dir: string; remote: string | null }
  | { ok: false; reason: "not-a-repo" | "wrong-repo"; message: string };

/**
 * Refuse to run a git-lane write against a directory that is not this world.
 *
 * The failure this prevents is the expensive one: committing a world's tree
 * into some unrelated repository that happened to be the project dir, or
 * pushing one Spawn world's files to another.
 */
export async function checkClone(dir: string, info: EngineInfo): Promise<CloneCheck> {
  if (!(await isGitRepo(dir))) {
    return {
      ok: false,
      reason: "not-a-repo",
      message:
        `${dir} is not a git repository, and ${info.address ?? "this world"} is on engine ${info.semver ?? info.era} — ` +
        "its code IS a git repo. Run spawn_init to clone it here" +
        (info.gitUrl ? ` (${info.gitUrl})` : "") +
        ", or point projectDir at an existing clone.",
    };
  }

  const remote = await remoteUrl(dir);
  if (info.gitUrl && remote && !sameRepo(remote, info.gitUrl)) {
    return {
      ok: false,
      reason: "wrong-repo",
      message:
        `${dir} is a git repository, but its origin is ${remote} — not this world's repo (${info.gitUrl}). ` +
        "Nothing was written. Point projectDir at the right clone, or check SPAWN_VARIANT_ID.",
    };
  }
  return { ok: true, dir, remote };
}

/** Prefix-free absolute URL: the API returns some paths relative and some whole. */
export function absoluteUrl(apiUrl: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return /^https?:\/\//i.test(value) ? value : `${apiUrl}${value}`;
}
