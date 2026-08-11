import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { saveFile } from "./env.js";

const BASE_VERSION_FILE = ".spawn/base-version";
const BASE_SCRIPTS_FILE = ".spawn/base-scripts.json";
const BASE_GAME_FILE = ".spawn/base-game.json";
const REPLACED_GAME_FILE = ".spawn/replaced-game.json";
/** Sits next to game.json so it reads like the script receipts and diffs against it. */
export const SPEC_RECEIPT_FILE = "game.json.theirs";
const FOLDABLE_SCRIPT_FILE = /\.(js|json)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function deepMerge(base: any, overlay: any): any {
  if (
    base &&
    overlay &&
    typeof base === "object" &&
    typeof overlay === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const out = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return overlay;
}

/**
 * Walk `dir` for files matching `predicate`.
 *
 * Uses lstat and skips symlinks deliberately: following them let a symlinked
 * directory loop recurse until the stack blew, and let a link pointing outside
 * the project pull arbitrary file contents into the pushed spec.
 */
function listFiles(dir: string, predicate: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

const collapseScriptKey = (key: string) => key.replace(/^(?:scripts\/)+/, "scripts/");
const collapseDepth = (key: string) => key.length - collapseScriptKey(key).length;

function collapseScriptMap(scripts: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const depths = new Map<string, number>();
  const collapsed: string[] = [];
  for (const [key, source] of Object.entries(scripts)) {
    const canon = collapseScriptKey(key);
    if (canon !== key) collapsed.push(key);
    if (canon in out && collapseDepth(key) < (depths.get(canon) ?? 0)) continue;
    out[canon] = source;
    depths.set(canon, collapseDepth(key));
  }
  return { scripts: out, collapsed };
}

export function scriptKeyFilePath(key: string): string | null {
  const canon = collapseScriptKey(key);
  if (!canon.startsWith("scripts/")) return null;
  if (!FOLDABLE_SCRIPT_FILE.test(canon)) return null;
  const segments = canon.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) return null;
  return canon;
}

export function compile(dir: string): any {
  const root = resolve(dir);
  const gamePath = join(root, "game.json");
  if (!existsSync(gamePath)) throw new Error(`no game.json in ${root}`);
  let spec: any;
  try {
    spec = JSON.parse(readFileSync(gamePath, "utf8"));
  } catch (e: any) {
    throw new Error(`game.json is not valid JSON: ${e.message}`);
  }

  for (const file of listFiles(join(root, "world"), (f) => f.endsWith(".json"))) {
    try {
      spec = deepMerge(spec, JSON.parse(readFileSync(file, "utf8")));
    } catch (e: any) {
      throw new Error(`${file} is not valid JSON: ${e.message}`);
    }
  }

  const base = collapseScriptMap(spec.scripts ?? {});
  spec.scripts = base.scripts;

  const scriptsDir = join(root, "scripts");
  const foldDepths = new Map<string, number>();
  for (const file of listFiles(scriptsDir, (f) => FOLDABLE_SCRIPT_FILE.test(f))) {
    const rel = relative(scriptsDir, file).split("\\").join("/");
    const key = collapseScriptKey(`scripts/${rel}`);
    const depth = collapseDepth(`scripts/${rel}`);
    if (foldDepths.has(key) && depth < (foldDepths.get(key) ?? 0)) continue;
    foldDepths.set(key, depth);
    spec.scripts[key] = readFileSync(file, "utf8");
    const stripped = key.slice("scripts/".length);
    if (stripped in spec.scripts) delete spec.scripts[stripped];
  }

  return spec;
}

export function readBaseVersion(projectDir: string): number | null {
  try {
    const n = Number(readFileSync(join(projectDir, BASE_VERSION_FILE), "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeBaseVersion(projectDir: string, version: number): void {
  if (!Number.isInteger(version)) return;
  saveFile(join(projectDir, BASE_VERSION_FILE), `${version}\n`);
}

function readBaseScripts(projectDir: string): Record<string, string> | null {
  try {
    const value = JSON.parse(readFileSync(join(projectDir, BASE_SCRIPTS_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeBaseScripts(projectDir: string, scripts: Record<string, string>): void {
  saveFile(join(projectDir, BASE_SCRIPTS_FILE), JSON.stringify(scripts, null, 2));
}

/**
 * The spec body without `scripts`. Script sources have their own three-way rail
 * (base-scripts.json + .theirs receipts) and their own files on disk, so folding
 * them into the spec merge would conflict on the same content twice.
 */
function withoutScripts(spec: unknown): Record<string, unknown> {
  if (!isPlainObject(spec)) return {};
  const { scripts: _scripts, ...rest } = spec;
  return rest;
}

/** Rejoin a merged body with the upstream script map, matching how game.json is written today. */
function composeSpec(body: Record<string, unknown>, upstream: unknown): Record<string, unknown> {
  const scripts = isPlainObject(upstream) ? upstream.scripts : undefined;
  return scripts === undefined ? { ...body } : { ...body, scripts };
}

/** `.spawn/base-game.json` — upstream's spec body as of the last sync point. */
export function readBaseGame(projectDir: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(join(projectDir, BASE_GAME_FILE), "utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeBaseGame(projectDir: string, spec: unknown): void {
  saveFile(join(projectDir, BASE_GAME_FILE), JSON.stringify(withoutScripts(spec), null, 2));
}

/** Absent-key marker, so "you deleted it" is distinguishable from "you set it to undefined". */
const MISSING = Symbol("missing");

function sameSlot(a: unknown, b: unknown): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  return deepEqual(a, b);
}

function mergeSlot(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  path: string,
  conflicts: string[]
): unknown {
  if (sameSlot(mine, theirs)) return mine; // both sides landed on the same thing
  if (sameSlot(mine, base)) return theirs; // only upstream moved
  if (sameSlot(theirs, base)) return mine; // only we moved

  // Both moved and disagree. Recurse while all the live sides are objects, so a
  // conflict lands on the narrowest key rather than the whole subtree.
  if (isPlainObject(mine) && isPlainObject(theirs) && (base === MISSING || isPlainObject(base))) {
    const baseObj = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    // Upstream key order first, then keys only we have: keeps game.json stable.
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const has = (o: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(o, key);
      const merged = mergeSlot(
        has(baseObj) ? baseObj[key] : MISSING,
        has(mine) ? mine[key] : MISSING,
        has(theirs) ? theirs[key] : MISSING,
        path ? `${path}.${key}` : key,
        conflicts
      );
      if (merged !== MISSING) out[key] = merged;
    }
    return out;
  }

  conflicts.push(path || "<root>");
  return mine; // never clobber local work; the receipt carries their side
}

/**
 * Three-way merge of spec bodies by key path. Conflicts keep the local value and
 * are reported as dotted paths — detect precisely, let the agent resolve, same
 * contract as the script `.theirs` receipts.
 */
export function mergeSpec(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>
): { merged: Record<string, unknown>; conflicts: string[] } {
  const conflicts: string[] = [];
  const merged = mergeSlot(base, mine, theirs, "", conflicts);
  return { merged: isPlainObject(merged) ? merged : {}, conflicts };
}

export type SpecSyncSummary = {
  /** merged = three-way applied; replaced = no rail to merge against; skipped = not writing game.json. */
  mode: "merged" | "replaced" | "skipped";
  conflicts: string[];
  /** Set when `mode` is "replaced" and content was actually dropped. */
  backup?: string;
  reason?: string;
};

/**
 * Reconcile a pulled spec into game.json.
 *
 * Before this rail existed, a pull overwrote game.json wholesale, so any local
 * edit to it vanished with no receipt and no mention in the summary — the one
 * file `spawn_init` puts the entire spec into. Scripts were the only content
 * with a merge story.
 */
export function syncPulledSpec(
  projectDir: string,
  pulledSpec: unknown,
  { write = true }: { write?: boolean } = {}
): SpecSyncSummary {
  if (!write) return { mode: "skipped", conflicts: [] };

  const gamePath = join(projectDir, "game.json");
  const receiptPath = join(projectDir, SPEC_RECEIPT_FILE);
  const theirsBody = withoutScripts(pulledSpec);

  const raw = existsSync(gamePath) ? readFileSync(gamePath, "utf8") : null;
  let mine: Record<string, unknown> | null = null;
  let unreadable = false;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) mine = parsed;
      else unreadable = true;
    } catch {
      unreadable = true;
    }
  }

  const base = readBaseGame(projectDir);
  if (mine === null || base === null) {
    // Legacy project or first pull: no merge base exists, so keep the old
    // whole-replace behaviour rather than inventing conflicts for every key.
    const dropping = unreadable || (mine !== null && !deepEqual(withoutScripts(mine), theirsBody));
    if (dropping && raw !== null) saveFile(join(projectDir, REPLACED_GAME_FILE), raw);
    saveFile(gamePath, JSON.stringify(composeSpec(theirsBody, pulledSpec), null, 2));
    writeBaseGame(projectDir, pulledSpec);
    return {
      mode: "replaced",
      conflicts: [],
      ...(dropping && raw !== null ? { backup: REPLACED_GAME_FILE } : {}),
      reason: unreadable
        ? "game.json was not readable JSON"
        : mine === null
          ? "no local game.json"
          : "no .spawn/base-game.json rail yet (project predates the spec merge) — future pulls will merge",
    };
  }

  const { merged, conflicts } = mergeSpec(base, withoutScripts(mine), theirsBody);
  saveFile(gamePath, JSON.stringify(composeSpec(merged, pulledSpec), null, 2));
  writeBaseGame(projectDir, pulledSpec);

  if (conflicts.length) {
    saveFile(receiptPath, JSON.stringify(composeSpec(theirsBody, pulledSpec), null, 2));
  } else {
    rmSync(receiptPath, { force: true });
  }
  return { mode: "merged", conflicts };
}

function scriptFilePathForSpecKey(key: string): string | null {
  const direct = scriptKeyFilePath(key);
  if (direct) return direct;
  return scriptKeyFilePath(`scripts/${key.trim().replace(/^\/+/, "")}`);
}

export function specScriptsByFilePath(spec: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(spec?.scripts ?? {})) {
    if (typeof source !== "string") continue;
    const path = scriptFilePathForSpecKey(key);
    if (!path) continue;
    if (!(path in out) || key === path) out[path] = source;
  }
  return out;
}

export function listConflictReceipts(dir: string): string[] {
  const specReceipt = join(dir, SPEC_RECEIPT_FILE);
  return [
    ...(existsSync(specReceipt) ? [specReceipt] : []),
    ...listFiles(join(dir, "scripts"), (f) => f.endsWith(".theirs")),
  ];
}

export type SyncSummary = {
  created: string[];
  fastForwarded: string[];
  deleted: string[];
  conflicts: Array<{ path: string; kind: "edit" | "delete" | "resurrect" }>;
};

export function syncPulledScripts(
  projectDir: string,
  pulledSpec: any,
  pulledVersion: number
): { summary: SyncSummary; baseRail: number | null } {
  const baseRail = readBaseVersion(projectDir);
  const base = readBaseScripts(projectDir);
  const theirs = specScriptsByFilePath(pulledSpec);
  const summary: SyncSummary = { created: [], fastForwarded: [], deleted: [], conflicts: [] };

  const paths = new Set([...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const rel of [...paths].sort()) {
    const abs = join(projectDir, rel);
    const theirSource = theirs[rel];
    const baseSource = base?.[rel];
    const isLocalFile = existsSync(abs) && statSync(abs).isFile();
    const mine = isLocalFile ? readFileSync(abs, "utf8") : null;

    if (theirSource !== undefined) {
      if (!isLocalFile) {
        if (baseSource === undefined) {
          // New upstream script (e.g. a teammate's push). Write it out, or it
          // would exist only inside game.json where nobody can edit it.
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, theirSource);
          summary.created.push(rel);
        } else if (theirSource !== baseSource) {
          // We deleted it locally, they changed it. Let the agent decide.
          writeFileSync(
            `${abs}.theirs`,
            `// [spawn sync] ${rel} was CHANGED upstream (v${pulledVersion}), but you deleted it locally.\n` +
              `// Keep it deleted: remove this receipt, then push.\n` +
              `// Take their version: rename this receipt to ${rel.split("/").pop()}.\n\n` +
              theirSource
          );
          summary.conflicts.push({ path: rel, kind: "resurrect" });
        }
        // else: deleted locally, unchanged upstream — respect the delete.
        continue;
      }
      if (mine === theirSource) continue;
      if (baseSource !== undefined && theirSource === baseSource) continue;
      if (baseSource !== undefined && mine === baseSource) {
        writeFileSync(abs, theirSource);
        summary.fastForwarded.push(rel);
        continue;
      }
      writeFileSync(`${abs}.theirs`, theirSource);
      summary.conflicts.push({ path: rel, kind: "edit" });
    } else if (baseSource !== undefined && isLocalFile) {
      if (mine === baseSource) {
        rmSync(abs);
        summary.deleted.push(rel);
      } else {
        writeFileSync(
          `${abs}.theirs`,
          `// [spawn sync] ${rel} was DELETED upstream (v${pulledVersion}), but your local file has changes.\n` +
            `// Keep yours: delete this receipt, then push (your file restores the script).\n` +
            `// Accept their delete: remove this receipt AND ${rel}.\n`
        );
        summary.conflicts.push({ path: rel, kind: "delete" });
      }
    }
  }

  writeBaseScripts(projectDir, theirs);
  return { summary, baseRail };
}

/** Materialize scripts from a pulled/latest spec into scripts/ (init path). */
export function materializeScripts(projectDir: string, spec: any): { written: number; gameSpec: any } {
  const scripts = { ...(spec.scripts ?? {}) };
  const written = new Set<string>();
  for (const key of Object.keys(scripts).sort((a, b) => collapseDepth(b) - collapseDepth(a))) {
    const target = scriptKeyFilePath(key);
    if (!target || typeof scripts[key] !== "string") continue;
    if (written.has(target)) {
      delete scripts[key];
      continue;
    }
    const abs = join(projectDir, target);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, scripts[key] as string);
    written.add(target);
    delete scripts[key];
  }
  return { written: written.size, gameSpec: { ...spec, scripts } };
}

export function formatIssues(
  label: string,
  issues: Array<{ path: string[]; message: string; code: string }> | undefined,
  count?: number
): string {
  if (!issues?.length) return "";
  const lines = [`${label} (${count ?? issues.length}):`];
  for (const issue of issues) {
    lines.push(`  ${issue.path.join(".") || "<root>"} — ${issue.message} [${issue.code}]`);
  }
  return lines.join("\n");
}
