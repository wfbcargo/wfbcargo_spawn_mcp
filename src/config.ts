/**
 * Single source of truth for where this server talks to Spawn.
 *
 * The API origin is pinned here rather than being configurable per project.
 * The agent token is a bearer credential: whatever host this resolves to
 * receives it on every call. Reading it from a project `.env` (which can ship
 * inside a cloned game repo) or from a tool argument (which an LLM chooses)
 * would let untrusted input redirect that credential.
 */
export const SPAWN_API_URL = "https://www.spawn.co";

/** Process-env override, for developing against a staging deploy. */
const OVERRIDE_ENV_VAR = "SPAWN_API_URL";

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Resolve the API origin. Only the process environment can override the pinned
 * value — that is set by whoever wrote the MCP server config, a trusted
 * channel. Project `.env` files and tool arguments are deliberately ignored.
 */
export function resolveApiUrl(): string {
  const override = process.env[OVERRIDE_ENV_VAR]?.trim();
  if (!override) return SPAWN_API_URL;

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    console.error(
      `spawn-mcp: ignoring malformed ${OVERRIDE_ENV_VAR}=${override} — using ${SPAWN_API_URL}`
    );
    return SPAWN_API_URL;
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    console.error(
      `spawn-mcp: refusing ${OVERRIDE_ENV_VAR}=${override} — the agent token may only be sent over https (http allowed for localhost only). Using ${SPAWN_API_URL}`
    );
    return SPAWN_API_URL;
  }

  const normalized = parsed.origin;
  if (normalized !== SPAWN_API_URL) {
    console.error(`spawn-mcp: API origin overridden to ${normalized} (default ${SPAWN_API_URL})`);
  }
  return normalized;
}
