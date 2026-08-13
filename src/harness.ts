/**
 * Load a Spawn game's scripts in plain Node, with no engine, no browser, and no
 * live room, so their pure functions can be checked locally.
 *
 * Four properties of the engine's module system make this possible, all stated
 * in `.spawn/tome-api.md` and confirmed against a real 77-script game:
 *
 *   1. `objectApi` is INJECTED — hooks are `update(dt, api)`, never `import api`.
 *      A function that does not take `api` cannot reach the engine.
 *   2. The module graph is CLOSED — `require()` resolves `lib/*.js`,
 *      `lib/data/*.json` and `builtin/*` and nothing else. No URL imports, no
 *      dynamic require.
 *   3. There are NO `import` statements anywhere, so nothing needs ES module
 *      linking; each file runs as a classic script with `require` in scope.
 *   4. Exports come in two systems, both narrow: four `export …` forms (see
 *      `transformModule`) used by behaviours, and `module.exports = { … }` used
 *      by most `lib/*.js` helpers. Both are supported here.
 *
 * Property 3 is why this needs no `--experimental-vm-modules`: `vm.Script` is
 * enough. Anything outside those four export forms throws by name rather than
 * being silently mis-parsed, because a wrong parse would produce a passing
 * audit of code that was never loaded.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createContext, Script } from "node:vm";
import { PURE_BUILTINS } from "./builtins.js";

/** A script reached an engine surface that only exists inside a live room. */
export class EngineOnlyError extends Error {
  constructor(readonly specifier: string) {
    super(
      `require("${specifier}") is an engine surface — it only exists inside a running room, so this code cannot be audited locally. Engine-only builtins: ${ENGINE_ONLY.join(", ")}.`
    );
    this.name = "EngineOnlyError";
  }
}

/**
 * Builtins that wrap rendering, audio or room state. Listed rather than
 * stubbed: a stub would let a check "pass" against behaviour that was never
 * executed, which is worse than refusing to run it.
 */
export const ENGINE_ONLY = [
  "builtin/fx",
  "builtin/geom",
  "builtin/three",
  "builtin/tsl",
  "builtin/vibe",
  "builtin/room-routing",
  "builtin/primitives",
];

const MAX_SOURCE_BYTES = 4_000_000;

export type LoadedModule = Record<string, unknown>;

export type HarnessOptions = {
  /** Wall-clock cap for a single module's top-level evaluation. */
  timeoutMs?: number;
};

/**
 * Rewrite the engine's export forms into assignments on a synthetic exports
 * object. Only line-initial `export` is matched: that is the shape every real
 * script uses, and it keeps the word inside a string or a `//` comment from
 * being rewritten.
 *
 * Measured over a real game: 95 `export function`, 13 `export const`,
 * 2 `export async function`, 1 `export default function`, 0 anything else.
 */
export function transformModule(source: string, file: string): string {
  const out: string[] = [];
  const named: string[] = [];
  let hasDefault = false;

  for (const [i, line] of source.split("\n").entries()) {
    if (!/^export\b/.test(line)) {
      out.push(line);
      continue;
    }

    let m = /^export\s+default\s+/.exec(line);
    if (m) {
      hasDefault = true;
      out.push(`const __default = ${line.slice(m[0].length)}`);
      continue;
    }

    m = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/.exec(line);
    if (m) {
      named.push(m[1]);
      out.push(line.slice("export ".length));
      continue;
    }

    m = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) {
      named.push(m[1]);
      out.push(line.slice("export ".length));
      continue;
    }

    throw new Error(
      `${file}:${i + 1}: unsupported export form, refusing to guess: ${line.trim()}`
    );
  }

  // Appended, not hoisted: `const` exports must be assigned after their
  // initialisers have run, and function declarations hoist anyway.
  const assigns = named.map((n) => `  __exports[${JSON.stringify(n)}] = ${n};`);
  if (hasDefault) assigns.push("  __exports.default = __default;");
  return `${out.join("\n")}\n;(() => {\n${assigns.join("\n")}\n})();\n`;
}

/**
 * Resolve an engine specifier to a file under the project.
 *
 * `lib/x.js` and `lib/data/x.json` live under `scripts/`. The resolved path is
 * checked to still be inside `scripts/`, and symlinks are refused, for the same
 * reason `compile.ts` refuses them: a link pointing outside the project would
 * pull arbitrary file contents into an evaluated script.
 */
export function resolveSpecifier(projectDir: string, specifier: string): string {
  const scriptsRoot = resolve(projectDir, "scripts");
  const rel = specifier.startsWith("scripts/") ? specifier.slice("scripts/".length) : specifier;
  const abs = resolve(scriptsRoot, rel);

  const inside = relative(scriptsRoot, abs);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`refusing to load "${specifier}": resolves outside ${scriptsRoot}`);
  }
  if (!existsSync(abs)) throw new Error(`require("${specifier}"): no such file (${abs})`);
  for (let p = abs; p.startsWith(scriptsRoot); p = resolve(p, "..")) {
    if (lstatSync(p).isSymbolicLink()) {
      throw new Error(`refusing to load "${specifier}": ${p} is a symlink`);
    }
    if (p === scriptsRoot) break;
  }
  return abs;
}

export type Harness = {
  /** Load a module by engine specifier (`lib/grid.js`) or project-relative path. */
  require(specifier: string): LoadedModule;
  /** Every specifier loaded so far, in load order — the real dependency set. */
  loaded(): string[];
};

/**
 * Build a loader rooted at one game project.
 *
 * Modules are cached and cyclic requires return the partially-built exports,
 * matching CommonJS. Each module gets its own `__exports` but shares one vm
 * context, so cross-module identity (`instanceof`, JSON data) stays consistent.
 */
export function createHarness(projectDir: string, options: HarnessOptions = {}): Harness {
  const timeout = options.timeoutMs ?? 5_000;
  const cache = new Map<string, LoadedModule>();
  const order: string[] = [];

  const context = createContext({
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Symbol,
    Error,
    TypeError,
    RangeError,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    structuredClone,
  });

  function load(specifier: string): LoadedModule {
    const key = specifier.replace(/^\.\//, "");

    if (key.startsWith("builtin/")) {
      const pure = PURE_BUILTINS[key];
      if (pure) return pure;
      throw new EngineOnlyError(key);
    }

    const cached = cache.get(key);
    if (cached) return cached;

    const file = resolveSpecifier(projectDir, key);

    if (file.endsWith(".json")) {
      const data = JSON.parse(readFileSync(file, "utf8")) as LoadedModule;
      cache.set(key, data);
      order.push(key);
      return data;
    }

    const source = readFileSync(file, "utf8");
    if (source.length > MAX_SOURCE_BYTES) {
      throw new Error(`${key}: ${source.length} bytes exceeds the ${MAX_SOURCE_BYTES} cap`);
    }

    const exports: LoadedModule = {};
    // Seeded before evaluation so a cycle resolves to this object rather than
    // recursing forever.
    cache.set(key, exports);
    order.push(key);

    const body = transformModule(source, key);
    // `module` and `exports` are passed alongside the ESM shim because the
    // engine accepts BOTH systems: behaviours use `export function`, while
    // `lib/*.js` helpers overwhelmingly end in `module.exports = { … }`.
    const wrapped = `(function (__exports, require, module, exports) {\n${body}\n});`;

    type Factory = (
      e: LoadedModule,
      r: (s: string) => LoadedModule,
      m: { exports: unknown },
      x: LoadedModule
    ) => void;

    let factory: Factory;
    try {
      factory = new Script(wrapped, { filename: key }).runInContext(context, { timeout });
    } catch (e: any) {
      cache.delete(key);
      throw new Error(`${key}: failed to compile — ${e?.message ?? e}`);
    }

    const moduleObj: { exports: unknown } = { exports };
    try {
      factory(exports, load, moduleObj, exports);
    } catch (e: any) {
      cache.delete(key);
      if (e instanceof EngineOnlyError) throw e;
      throw new Error(`${key}: failed to evaluate — ${e?.message ?? e}`);
    }

    const final = moduleObj.exports;
    if (final === exports || final == null) return exports;

    // A reassigned `module.exports` is folded back onto the seeded object so a
    // cyclic require still sees one identity. A non-plain export (a bare
    // function) cannot be folded, so it replaces the cache entry instead.
    if (typeof final === "object" && !Array.isArray(final)) {
      Object.assign(exports, final as LoadedModule);
      return exports;
    }
    const replacement = final as LoadedModule;
    cache.set(key, replacement);
    return replacement;
  }

  return { require: load, loaded: () => [...order] };
}

/** Normalise a project-relative script path to the specifier form require uses. */
export function toSpecifier(pathOrSpecifier: string): string {
  return pathOrSpecifier.split(sep).join("/").replace(/^\.\//, "");
}

/** True when `scripts/` exists under the project — the harness has nothing to load otherwise. */
export function hasScripts(projectDir: string): boolean {
  return existsSync(join(projectDir, "scripts"));
}
