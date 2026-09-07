/**
 * Putting the agent's own body in a world, through Spawn's packaged client.
 *
 * This exists because of one hard rule in the platform: **a room boots for a
 * player, never for a door.** `agent/exec` and `agent/logs` only read rooms the
 * registry says are LIVE, and until now this server's only way to make one live
 * was `spawn_play_open` — a headed Chromium with a working WebGPU adapter. That
 * is a heavy dependency for "I just want to query the room I pushed to", and it
 * is impossible on a machine with no GPU.
 *
 * `spawn client join` is the other way: a real player session, no browser, no
 * pixels. The world boots for the body and stays live while it stands.
 *
 * We wrap the packaged client rather than speaking the session protocol
 * ourselves, and that is not laziness — the client the stack serves IS the room
 * host shell (~2 MB of engine code that runs the world's pinned engine). It is
 * also versioned by the stack, so a wrapper cannot fall behind the doors it
 * dials. What this module owns is finding it, running it safely, and keeping
 * the token pinned to the stack this server already talks to.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveApiUrl } from "./config.js";
import { scrub } from "./git.js";

const run = promisify(execFile);

/** A join boots a world; that is slower than a read and worth waiting for. */
const CLIENT_TIMEOUT_MS = Number(process.env.SPAWN_CLIENT_TIMEOUT_MS) || 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** Where this server keeps things that are not any one project's. */
const CACHE_DIR = join(homedir(), ".spawn-mcp", "client");

export class ClientMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMissingError";
  }
}

/* ---------------------------------------------------------------- resolving */

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find Bun.
 *
 * The client's session shell is spawned as `bun <entry>` — literally, that
 * string is in the client — so Bun is not a preference here, it is the runtime
 * the shell is launched with. Running the CLI under Node gets as far as
 * "shell process failed to spawn (no pid)".
 */
export function resolveBun(): string {
  const explicit = process.env.SPAWN_BUN_BIN?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new ClientMissingError(`SPAWN_BUN_BIN=${explicit} does not exist.`);
    }
    return explicit;
  }

  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const found = firstExisting([
    join(homedir(), ".bun", "bin", exe),
    ...(process.env.BUN_INSTALL ? [join(process.env.BUN_INSTALL, "bin", exe)] : []),
    ...(process.platform === "win32"
      ? [join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", exe)]
      : ["/usr/local/bin/bun", "/opt/homebrew/bin/bun"]),
  ]);
  // PATH is the common case and execFile searches it, so a bare name is the
  // right fallback — a miss surfaces as ENOENT and is translated below.
  return found ?? "bun";
}

/**
 * Find the packaged client's entry module.
 *
 * A path is resolved rather than the `spawn` shim on PATH: on Windows that shim
 * is a `.cmd`, which cannot be exec'd without a shell, and a shell is a quoting
 * hazard we have no reason to accept. `bun x` is the last resort and needs no
 * install at all, which is what makes this work out of the box.
 */
export function resolveClientEntry(): { args: string[]; how: string } {
  const explicit = process.env.SPAWN_CLIENT_ENTRY?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new ClientMissingError(`SPAWN_CLIENT_ENTRY=${explicit} does not exist.`);
    }
    return { args: [explicit], how: `SPAWN_CLIENT_ENTRY=${explicit}` };
  }

  const rel = join("@spawnco", "client", "bin", "spawn.mjs");
  const installed = firstExisting([
    join(homedir(), ".bun", "install", "global", "node_modules", rel),
    ...(process.platform === "win32"
      ? [join(process.env.APPDATA ?? "", "npm", "node_modules", rel)]
      : ["/usr/local/lib/node_modules/" + rel.replace(/\\/g, "/")]),
  ]);
  if (installed) return { args: [installed], how: `installed client at ${installed}` };

  return { args: ["x", "@spawnco/client"], how: "bun x @spawnco/client (no global install)" };
}

/* ----------------------------------------------------------------- running */

/**
 * `--origin` anywhere on the client's line changes which stack it dials, and
 * the agent token travels to whatever that names. It is the same threat
 * `config.ts` pins the API origin against, reached through a different door,
 * so it gets the same answer: the model does not choose the host.
 */
function assertNoOriginRedirect(args: string[]): void {
  for (const arg of args) {
    if (arg === "--origin" || arg.startsWith("--origin=")) {
      throw new Error(
        "Refusing --origin: it redirects the client to another stack, and your agent token is sent to whatever it names. " +
          "The origin is pinned to the same host this server's API calls use (override it only through the SPAWN_API_URL process env)."
      );
    }
  }
}

/** Client verbs are `spawn client <verb>`; anything else is a different tool. */
const VERB = /^[a-z][a-z0-9-]{0,31}$/;

export type ClientResult = { ok: boolean; stdout: string; stderr: string; code: number };

/**
 * Run one `spawn client …` command.
 *
 * The token reaches the child through its environment only, and `SPAWN_ORIGIN`
 * is pinned to this server's resolved API origin so the client and the API
 * always talk to the same stack.
 */
export async function client(
  verb: string,
  args: string[],
  token: string,
  { timeoutMs = CLIENT_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<ClientResult> {
  if (!VERB.test(verb)) {
    throw new Error(`"${verb}" is not a client verb (lowercase letters, digits and dashes).`);
  }
  assertNoOriginRedirect(args);
  if (!token) {
    throw new Error("Missing SPAWN_AGENT_KEY — the agent token is what the body wears. Run spawn_bootstrap.");
  }

  const bun = resolveBun();
  const entry = resolveClientEntry();
  const argv = [...entry.args, "client", verb, ...args];

  try {
    const { stdout, stderr } = await run(bun, argv, {
      // Never the project directory: `bun x` resolves a package here, and a
      // world's tree is not the place for that.
      cwd: CACHE_DIR,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        SPAWN_TOKEN: token,
        SPAWN_ORIGIN: resolveApiUrl(),
        SPAWN_CLIENT_CACHE_DIR: process.env.SPAWN_CLIENT_CACHE_DIR ?? join(CACHE_DIR, "cache"),
      },
    });
    return { ok: true, code: 0, stdout: scrub(stdout, token), stderr: scrub(stderr, token) };
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new ClientMissingError(
        "Bun is not installed, and the Spawn client's session shell is spawned as `bun` — the CLI cannot hold a session without it.\n\n" +
          "Install it: https://bun.sh  (or `npm install -g bun`), then retry. " +
          "If Bun is installed somewhere unusual, point SPAWN_BUN_BIN at the binary."
      );
    }
    if (e?.killed) {
      throw new Error(
        `spawn client ${verb} timed out after ${timeoutMs}ms (set SPAWN_CLIENT_TIMEOUT_MS to raise).`
      );
    }
    return {
      ok: false,
      code: typeof e?.code === "number" ? e.code : 1,
      stdout: scrub(String(e?.stdout ?? ""), token),
      stderr: scrub(String(e?.stderr ?? e?.message ?? ""), token),
    };
  }
}

/** Everything the client printed, in the order it printed it. */
export function output(result: ClientResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * `spawn client run` is broken on Windows in the client the stack currently
 * serves: the session shell validates `scriptPath` as POSIX-absolute, so a
 * `C:\…` path is refused — and `-e` inline hits it too, because it writes the
 * source to a temp file and passes that same path. Detected by the message
 * rather than by platform, so it stops being reported the moment it is fixed.
 */
export function isWindowsScriptPathBug(text: string): boolean {
  // The drive letter sits mid-line, inside the quoted path the client echoes
  // back, so anchoring to the start of a line never matches.
  return /run needs an ABSOLUTE scriptPath/.test(text) && /[A-Za-z]:\\/.test(text);
}

export const CACHE_DIRECTORY = CACHE_DIR;
