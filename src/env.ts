import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveApiUrl } from "./config.js";

export type SpawnEnv = {
  apiUrl: string;
  agentKey: string;
  variantId: string;
};

const ENV_KEYS = ["SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID"] as const;

/** Resolve the game project directory (where game.json / .env live). */
export function resolveProjectDir(explicit?: string): string {
  return resolve(explicit || process.env.SPAWN_PROJECT_DIR || process.cwd());
}

function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Load Spawn credentials from process env, then project `.env`. */
export function loadEnv(projectDir: string): SpawnEnv {
  const filePath = join(projectDir, ".env");
  let file: Record<string, string> = {};
  if (existsSync(filePath)) {
    try {
      file = parseDotEnv(readFileSync(filePath, "utf8"));
    } catch {
      /* ignore unreadable .env */
    }
  }

  const pick = (key: (typeof ENV_KEYS)[number]) => (process.env[key] || file[key] || "").trim();

  return {
    // Pinned in config.ts — never sourced from the project .env. See the note there.
    apiUrl: resolveApiUrl(),
    agentKey: pick("SPAWN_AGENT_KEY"),
    variantId: pick("SPAWN_VARIANT_ID"),
  };
}

export function requireEnv(
  env: SpawnEnv,
  ...names: Array<"SPAWN_API_URL" | "SPAWN_AGENT_KEY" | "SPAWN_VARIANT_ID">
): void {
  // SPAWN_API_URL is always satisfied now (pinned), but callers still list it.
  const missing = names.filter((n) => {
    if (n === "SPAWN_API_URL") return !env.apiUrl;
    if (n === "SPAWN_AGENT_KEY") return !env.agentKey;
    return !env.variantId;
  });
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")} (set in project .env or via bootstrap / set_variant)`);
  }
}

/** Upsert keys in project `.env` without printing secret values. */
export function upsertEnv(projectDir: string, updates: Record<string, string>): string {
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, ".env");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing.length ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const seen = new Set<string>();

  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m) return line;
    const key = m[1];
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  // 0600: this file holds a bearer token. Mode only applies on create, so also
  // tighten an existing file. Both are no-ops on Windows — best effort.
  const body = next.join("\n").replace(/\n*$/, "\n");
  writeFileSync(filePath, body, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* unsupported filesystem */
  }
  return filePath;
}

/**
 * Best-effort — never let a gitignore write fail a tool that has already done
 * something irreversible (e.g. spent a one-time bootstrap key).
 */
export function ensureGitignore(projectDir: string): string[] {
  try {
    return ensureGitignoreUnsafe(projectDir);
  } catch {
    return [];
  }
}

function ensureGitignoreUnsafe(projectDir: string): string[] {
  const wanted = [".env", ".spawn/"];
  mkdirSync(projectDir, { recursive: true });
  const giPath = join(projectDir, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const lines = gi.split("\n").map((l) => l.trim());
  const missing = wanted.filter((w) => !lines.includes(w) && !lines.includes(w.replace(/\/$/, "")));
  if (missing.length) {
    writeFileSync(
      giPath,
      gi + (gi && !gi.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"
    );
  }
  return missing;
}

export function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

export function saveFile(file: string, content: string): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, content);
}
