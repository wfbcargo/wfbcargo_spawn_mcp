import { gzipSync } from "node:zlib";
import type { SpawnEnv } from "./env.js";

const GZIP_BODY_THRESHOLD_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.SPAWN_HTTP_TIMEOUT_MS) || 60_000;
const ERROR_BODY_SNIPPET = 400;

export type ApiResult = {
  status: number;
  ok: boolean;
  json: any;
  /** Raw body when it wasn't JSON — keeps proxy/HTML errors debuggable. */
  bodyText?: string;
};

/**
 * Read the body once, then try JSON. Non-JSON responses (proxy HTML, empty
 * bodies) keep a truncated snippet instead of vanishing into `null`.
 */
async function readBody(res: Response): Promise<Pick<ApiResult, "json" | "bodyText">> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return { json: null };
  }
  if (!raw.trim()) return { json: null };
  try {
    return { json: JSON.parse(raw) };
  } catch {
    const snippet = raw.slice(0, ERROR_BODY_SNIPPET).replace(/\s+/g, " ").trim();
    return {
      json: null,
      bodyText: raw.length > ERROR_BODY_SNIPPET ? `${snippet}…` : snippet,
    };
  }
}

/** Human-readable failure detail for tool error messages. */
export function apiError(result: ApiResult): string {
  return (
    result.json?.error ??
    result.bodyText ??
    (result.json !== null ? JSON.stringify(result.json) : `HTTP ${result.status} (empty body)`)
  );
}

export async function api(
  env: SpawnEnv,
  method: string,
  path: string,
  body?: unknown,
  { noGzip = false }: { noGzip?: boolean } = {}
): Promise<ApiResult> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const useGzip =
    !noGzip &&
    payload !== undefined &&
    Buffer.byteLength(payload, "utf8") > GZIP_BODY_THRESHOLD_BYTES;

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.agentKey}`,
        Accept: "application/json",
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(useGzip ? { "Content-Encoding": "gzip" } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(payload !== undefined
        ? { body: useGzip ? gzipSync(payload) : payload }
        : {}),
    });
  } catch (e: any) {
    throw new Error(
      e?.name === "TimeoutError"
        ? `${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms (set SPAWN_HTTP_TIMEOUT_MS to raise)`
        : `${method} ${path} failed to reach ${env.apiUrl}: ${e?.message ?? e}`
    );
  }

  if (useGzip && (res.status === 400 || res.status === 415)) {
    return api(env, method, path, body, { noGzip: true });
  }

  return { status: res.status, ok: res.ok, ...(await readBody(res)) };
}

/** Bootstrap exchange — no Bearer yet. */
export async function exchangeBootstrap(
  apiUrl: string,
  bootstrapKey: string,
  name: string
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/agent/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ bootstrapKey, name }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new Error(
      e?.name === "TimeoutError"
        ? `Bootstrap exchange timed out after ${REQUEST_TIMEOUT_MS}ms — the key was not consumed, retry it.`
        : `Bootstrap exchange could not reach ${apiUrl}: ${e?.message ?? e}`
    );
  }
  return { status: res.status, ok: res.ok, ...(await readBody(res)) };
}

export function variantPath(env: SpawnEnv, suffix: string): string {
  return `/api/sdk/v1/${encodeURIComponent(env.variantId)}${suffix}`;
}

export type LatestQuery = {
  mode?: "dev" | "live";
  version?: number;
  updateSlug?: string;
};

/** GET /game-specs/latest with optional mode / version / updateSlug. */
export function latestPath(env: SpawnEnv, query: LatestQuery = {}): string {
  const params = new URLSearchParams();
  if (query.mode) params.set("mode", query.mode);
  if (query.version != null) params.set("version", String(query.version));
  if (query.updateSlug) params.set("updateSlug", query.updateSlug);
  const qs = params.toString();
  return variantPath(env, `/game-specs/latest${qs ? `?${qs}` : ""}`);
}
