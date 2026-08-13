/**
 * Local math audit: run a game's pure functions in plain Node and check
 * declared invariants against them.
 *
 * This is the tier-L half of the review (REVIEW.md §E). It needs no browser, no
 * live room, no push and no credentials — which is the entire point, because
 * every check it answers was previously answered by playing the game.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectDir } from "./env.js";
import { ENGINE_ONLY, hasScripts } from "./harness.js";
import {
  formatReport,
  loadManifest,
  manifestSchema,
  runSweep,
  type Manifest,
} from "./sweep.js";

const DEFAULT_MANIFEST = "audit/math.json";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const projectDirSchema = z
  .string()
  .optional()
  .describe("Absolute path to the Spawn game project. Defaults to SPAWN_PROJECT_DIR or cwd.");

function listScripts(dir: string): string[] {
  const root = join(dir, "scripts");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".js")) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** Read the parameter list of a function whose `(` follows `from`. */
function readParams(source: string, from: number): string[] {
  const open = source.indexOf("(", from);
  if (open < 0) return [];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return source
          .slice(open + 1, i)
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      }
    }
  }
  return [];
}

/**
 * The engine injects `objectApi` as a parameter and never as an import
 * (`.spawn/tome-api.md` <behavior-hooks>), so the parameter list is a sound
 * classifier: a function that does not receive it cannot reach the engine.
 */
const API_PARAM = /^(api|objectApi|_api)\b/;

/**
 * Names exported by `module.exports = { … }`. Only the top level of the object
 * literal is read, and only its keys, so `{ spec: spec, despawn: despawn }` and
 * shorthand both resolve without parsing the values.
 */
export function commonJsExports(source: string): string[] {
  const start = source.search(/\bmodule\.exports\s*=\s*\{/);
  if (start < 0) return [];
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];

  const body = source.slice(open + 1, end);
  const names: string[] = [];
  let nesting = 0;
  for (const [i, part] of body.split(/([{}[\]])/).entries()) {
    if (i % 2 === 1) {
      nesting += "{[".includes(part) ? 1 : -1;
      continue;
    }
    if (nesting > 0) continue;
    for (const m of part.matchAll(/(?:^|,)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,:}]|$)/g)) {
      names.push(m[1]);
    }
  }
  return [...new Set(names)];
}

export type FoundFn = {
  module: string;
  export: string;
  params: string[];
  auditable: boolean;
  reason?: string;
};

export function scanProject(dir: string): {
  functions: FoundFn[];
  engineOnlyModules: string[];
  totals: Record<string, number>;
} {
  const functions: FoundFn[] = [];
  const engineOnlyModules: string[] = [];

  for (const file of listScripts(dir)) {
    const source = readFileSync(file, "utf8");
    const module = relative(dir, file).split(/[\\/]/).join("/");

    const requires = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const engineDep = requires.find((r) => ENGINE_ONLY.includes(r));
    if (engineDep) engineOnlyModules.push(`${module} (${engineDep})`);

    const add = (name: string, paramsAt: number) => {
      const params = paramsAt >= 0 ? readParams(source, paramsAt) : [];
      const takesApi = params.some((p) => API_PARAM.test(p));
      const fn: FoundFn = { module, export: name, params, auditable: !takesApi && !engineDep };
      if (takesApi) fn.reason = `takes ${params.find((p) => API_PARAM.test(p))} — needs a live room`;
      else if (engineDep) fn.reason = `module requires ${engineDep}`;
      functions.push(fn);
    };

    for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gm)) {
      add(m[1], m.index! + m[0].length);
    }

    // The `lib/*.js` helpers overwhelmingly export CommonJS-style, and they are
    // where the pure math actually lives, so missing them would hide the best
    // audit targets in the tree.
    for (const name of commonJsExports(source)) {
      if (functions.some((f) => f.module === module && f.export === name)) continue;
      const decl = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
      add(name, decl ? decl.index + decl[0].length - 1 : -1);
    }
  }

  return {
    functions,
    engineOnlyModules,
    totals: {
      exported: functions.length,
      auditable: functions.filter((f) => f.auditable).length,
      needsRoom: functions.filter((f) => !f.auditable).length,
    },
  };
}

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "spawn_audit_scan",
    {
      description:
        "List a game's exported functions and say which can be audited locally. Engine-coupled functions take objectApi as a parameter (the engine injects it, never imports it), so the signature alone decides: no api parameter and no engine-only require means the function is pure and runnable in plain Node. Run this BEFORE writing an audit manifest — it tells you what there is to check. No browser, no room, no credentials.",
      inputSchema: {
        projectDir: projectDirSchema,
        auditableOnly: z
          .boolean()
          .default(true)
          .describe("Hide functions that need a live room (the usual case when writing a manifest)"),
      },
    },
    async ({ projectDir, auditableOnly }) => {
      const dir = resolveProjectDir(projectDir);
      if (!hasScripts(dir)) return err(`no scripts/ directory under ${dir} — nothing to audit`);
      const scan = scanProject(dir);
      return text({
        projectDir: dir,
        ...scan.totals,
        engineOnlyModules: scan.engineOnlyModules,
        functions: auditableOnly ? scan.functions.filter((f) => f.auditable) : scan.functions,
        next: `Write ${DEFAULT_MANIFEST} with checks over these, then run spawn_audit_math.`,
      });
    }
  );

  server.registerTool(
    "spawn_audit_math",
    {
      description:
        "Run declared numeric invariants over the game's pure functions, locally: no browser, no live room, no push, no credentials. Sweeps each function across its declared input domain and reports the exact arguments that broke a rule. Catches what playing the game catches slowly and unreliably — NaN and Infinity, divide-by-zero at boundary inputs, difficulty curves that flatten or invert, values escaping their declared bounds. Reads audit/math.json by default; pass `manifest` for another path or `checks` to try one inline without writing a file. Use spawn_audit_scan first to see what is auditable.",
      inputSchema: {
        projectDir: projectDirSchema,
        manifest: z
          .string()
          .optional()
          .describe(`Manifest path, relative to the project. Default ${DEFAULT_MANIFEST}`),
        checks: z
          .array(z.any())
          .optional()
          .describe("Inline checks, same shape as the manifest's `checks`. Overrides the file."),
        json: z
          .boolean()
          .default(false)
          .describe("Return the full machine-readable report instead of the compact summary"),
      },
    },
    async ({ projectDir, manifest, checks, json }) => {
      const dir = resolveProjectDir(projectDir);
      if (!hasScripts(dir)) return err(`no scripts/ directory under ${dir} — nothing to audit`);

      let spec: Manifest;
      if (checks?.length) {
        const parsed = manifestSchema.safeParse({ checks });
        if (!parsed.success) {
          return err(
            `inline checks are not valid:\n${parsed.error.issues
              .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n")}`
          );
        }
        spec = parsed.data;
      } else {
        const file = resolve(dir, manifest ?? DEFAULT_MANIFEST);
        if (!existsSync(file)) {
          return err(
            `no audit manifest at ${file}. Run spawn_audit_scan to see what is auditable, then write one, or pass \`checks\` inline to try a rule without saving it.`
          );
        }
        try {
          spec = loadManifest(file);
        } catch (e: any) {
          return err(e?.message ?? String(e));
        }
      }

      let report;
      try {
        report = runSweep(dir, spec);
      } catch (e: any) {
        return err(`sweep failed: ${e?.message ?? e}`);
      }

      const body = json ? JSON.stringify(report, null, 2) : formatReport(report);
      return {
        content: [{ type: "text" as const, text: body }],
        isError: report.summary.fail > 0 || report.summary.error > 0,
      };
    }
  );
}
