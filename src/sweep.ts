/**
 * Run declared invariants over a game's pure functions.
 *
 * The split this file assumes is the one in REVIEW.md: this server owns the
 * RUNNER, the game project owns the ASSERTIONS. Per-game invariants ("a wave
 * never gets easier than the one before it") are not knowledge a generic MCP
 * server can hold, so they live in the project as `audit/math.json` and this
 * code only knows how to enumerate inputs, call, and judge.
 *
 * Findings are reported with the exact arguments that produced them, because a
 * counterexample you can paste into a REPL is the difference between a finding
 * and an opinion.
 */
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { z } from "zod";
import { createHarness, EngineOnlyError, toSpecifier, type Harness } from "./harness.js";

/** Enough to sweep a 12×5 difficulty table thousands of times over; small enough to stay instant. */
const DEFAULT_MAX_CALLS = 200_000;
const MAX_REPORTED_FAILURES = 5;
const EXPR_TIMEOUT_MS = 1_000;

const domainSchema = z.union([
  z.object({
    name: z.string().optional(),
    range: z.tuple([z.number(), z.number()]),
    step: z.number().positive().optional(),
  }),
  z.object({ name: z.string().optional(), values: z.array(z.any()).min(1) }),
  z.object({ name: z.string().optional(), const: z.any() }),
]);

const assertSchema = z.object({
  finite: z.boolean().optional(),
  integer: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  increasingIn: z.union([z.string(), z.number()]).optional(),
  nondecreasingIn: z.union([z.string(), z.number()]).optional(),
  decreasingIn: z.union([z.string(), z.number()]).optional(),
  nonincreasingIn: z.union([z.string(), z.number()]).optional(),
  expr: z.string().optional(),
});

const checkSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  module: z.string().min(1),
  export: z.string().min(1),
  args: z.array(domainSchema).default([]),
  /** Dot-path into an object result, e.g. "stats.health". Omit for a scalar return. */
  select: z.string().optional(),
  assert: assertSchema,
});

export const manifestSchema = z.object({
  maxCalls: z.number().int().positive().optional(),
  checks: z.array(checkSchema).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Check = z.infer<typeof checkSchema>;
type Domain = z.infer<typeof domainSchema>;

export type Failure = {
  rule: string;
  args: Record<string, unknown>;
  value: unknown;
  detail: string;
};

export type CheckResult = {
  id: string;
  description?: string;
  status: "pass" | "fail" | "error" | "engine-only";
  target: string;
  calls: number;
  /** Set when the declared domain was larger than the call budget. Never silent. */
  capped?: { declared: number; ran: number };
  failureCount?: number;
  failures?: Failure[];
  error?: string;
};

export type SweepReport = {
  projectDir: string;
  checks: CheckResult[];
  summary: { pass: number; fail: number; error: number; engineOnly: number; calls: number };
  modulesLoaded: string[];
};

function domainValues(d: Domain): unknown[] {
  // Narrowed positively (`"range" in d`) rather than by elimination: `const` is
  // declared with z.any(), so its key is optional and `"const" in d` does not
  // remove that branch from the union.
  if (!("range" in d)) return "values" in d ? d.values : [(d as { const: unknown }).const];
  const [lo, hi] = d.range;
  const step = d.step ?? 1;
  if (hi < lo) throw new Error(`range [${lo}, ${hi}] is empty — high bound is below the low bound`);
  const out: number[] = [];
  // Inclusive of `hi` when it lands on a step; the epsilon absorbs float drift
  // over long sweeps (0.1 steps do not land exactly).
  for (let v = lo; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function argName(domains: Domain[], i: number): string {
  return domains[i]?.name ?? `arg${i}`;
}

/** Resolve `increasingIn: "tier"` (or an index) to a positional argument. */
function resolveAxis(domains: Domain[], ref: string | number): number {
  if (typeof ref === "number") {
    if (ref < 0 || ref >= domains.length) throw new Error(`monotonic axis ${ref} is out of range`);
    return ref;
  }
  const i = domains.findIndex((d) => d.name === ref);
  if (i < 0) throw new Error(`monotonic axis "${ref}" names no declared argument`);
  return i;
}

function pick(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: any = value;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function labelArgs(domains: Domain[], tuple: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  tuple.forEach((v, i) => (out[argName(domains, i)] = v));
  return out;
}

/**
 * Enumerate the cartesian product, capped. Returns the cap alongside the tuples
 * rather than truncating quietly: a bounded sweep reported as a full one reads
 * as "covered everything" when it did not.
 */
function product(domains: Domain[], maxCalls: number): { tuples: unknown[][]; declared: number } {
  const axes = domains.map(domainValues);
  const declared = axes.reduce((n, a) => n * a.length, 1);
  const tuples: unknown[][] = [];
  const limit = Math.min(declared, maxCalls);
  for (let i = 0; i < limit; i++) {
    const tuple: unknown[] = [];
    let rest = i;
    for (let a = axes.length - 1; a >= 0; a--) {
      tuple[a] = axes[a][rest % axes[a].length];
      rest = Math.floor(rest / axes[a].length);
    }
    tuples.push(tuple);
  }
  return { tuples, declared };
}

function compileExpr(expr: string): Script {
  return new Script(`(${expr})`, { filename: "assert.expr" });
}

function describe(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "undefined";
  try {
    const s = JSON.stringify(value);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function runCheck(harness: Harness, check: Check, maxCalls: number): CheckResult {
  const target = `${check.module}:${check.export}`;
  const base: CheckResult = { id: check.id, status: "pass", target, calls: 0 };
  if (check.description) base.description = check.description;

  let fn: unknown;
  try {
    const mod = harness.require(toSpecifier(check.module));
    fn = mod[check.export];
  } catch (e: any) {
    if (e instanceof EngineOnlyError) {
      return { ...base, status: "engine-only", error: e.message };
    }
    return { ...base, status: "error", error: e?.message ?? String(e) };
  }
  if (typeof fn !== "function") {
    return {
      ...base,
      status: "error",
      error: `${target} is not an exported function (got ${typeof fn}) — check the export name`,
    };
  }

  let tuples: unknown[][];
  let declared: number;
  try {
    ({ tuples, declared } = product(check.args, maxCalls));
  } catch (e: any) {
    return { ...base, status: "error", error: e?.message ?? String(e) };
  }

  const a = check.assert;
  const expr = a.expr ? compileExpr(a.expr) : null;
  const failures: Failure[] = [];
  let failureCount = 0;
  const record = (rule: string, tuple: unknown[], value: unknown, detail: string) => {
    failureCount++;
    if (failures.length < MAX_REPORTED_FAILURES) {
      failures.push({ rule, args: labelArgs(check.args, tuple), value, detail });
    }
  };

  // Kept for the monotonic pass, which needs values grouped by the non-varying
  // arguments and therefore cannot be judged inside this loop.
  const values = new Array<unknown>(tuples.length);

  for (const [i, tuple] of tuples.entries()) {
    let value: unknown;
    try {
      value = pick((fn as (...xs: unknown[]) => unknown)(...tuple), check.select);
    } catch (e: any) {
      if (e instanceof EngineOnlyError) {
        return { ...base, status: "engine-only", calls: i, error: e.message };
      }
      record("throws", tuple, undefined, `threw ${e?.name ?? "Error"}: ${e?.message ?? e}`);
      values[i] = undefined;
      continue;
    }
    values[i] = value;

    if (a.finite && (typeof value !== "number" || !Number.isFinite(value))) {
      record("finite", tuple, value, `expected a finite number, got ${describe(value)}`);
    }
    if (a.integer && (typeof value !== "number" || !Number.isInteger(value))) {
      record("integer", tuple, value, `expected an integer, got ${describe(value)}`);
    }
    if (a.min !== undefined && typeof value === "number" && value < a.min) {
      record("min", tuple, value, `${value} is below the declared minimum ${a.min}`);
    }
    if (a.max !== undefined && typeof value === "number" && value > a.max) {
      record("max", tuple, value, `${value} is above the declared maximum ${a.max}`);
    }
    if (expr) {
      const ctx = createContext({ value, args: labelArgs(check.args, tuple), Math, Number });
      let ok: unknown;
      try {
        ok = expr.runInContext(ctx, { timeout: EXPR_TIMEOUT_MS });
      } catch (e: any) {
        return { ...base, status: "error", calls: i, error: `assert.expr failed: ${e?.message ?? e}` };
      }
      if (!ok) record("expr", tuple, value, `${a.expr} was falsy`);
    }
  }

  const monotonic = (
    [
      ["increasingIn", a.increasingIn, (p: number, c: number) => c > p, "increase"],
      ["nondecreasingIn", a.nondecreasingIn, (p: number, c: number) => c >= p, "not decrease"],
      ["decreasingIn", a.decreasingIn, (p: number, c: number) => c < p, "decrease"],
      ["nonincreasingIn", a.nonincreasingIn, (p: number, c: number) => c <= p, "not increase"],
    ] as const
  ).filter(([, ref]) => ref !== undefined);

  for (const [rule, ref, ok, verb] of monotonic) {
    let axis: number;
    try {
      axis = resolveAxis(check.args, ref!);
    } catch (e: any) {
      return { ...base, status: "error", error: e?.message ?? String(e) };
    }
    // Group by every argument except the axis; within a group the tuples are
    // already in domain order, because the product enumerates the last axis
    // fastest and each axis ascends.
    const groups = new Map<string, number[]>();
    for (const [i, tuple] of tuples.entries()) {
      const key = JSON.stringify(tuple.map((v, j) => (j === axis ? null : v)));
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    for (const idxs of groups.values()) {
      for (let k = 1; k < idxs.length; k++) {
        const prev = values[idxs[k - 1]];
        const cur = values[idxs[k]];
        if (typeof prev !== "number" || typeof cur !== "number") continue;
        if (!ok(prev, cur)) {
          const name = argName(check.args, axis);
          record(
            rule,
            tuples[idxs[k]],
            cur,
            `expected the result to ${verb} as ${name} rises: ${prev} → ${cur}`
          );
        }
      }
    }
  }

  const result: CheckResult = {
    ...base,
    status: failureCount ? "fail" : "pass",
    calls: tuples.length,
  };
  if (declared > tuples.length) result.capped = { declared, ran: tuples.length };
  if (failureCount) {
    result.failureCount = failureCount;
    result.failures = failures;
  }
  return result;
}

export function loadManifest(file: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`could not read the audit manifest ${file}: ${e?.message ?? e}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${file} is not a valid audit manifest:\n${issues}`);
  }
  return parsed.data;
}

export function runSweep(projectDir: string, manifest: Manifest): SweepReport {
  const harness = createHarness(projectDir);
  const maxCalls = manifest.maxCalls ?? DEFAULT_MAX_CALLS;
  const checks = manifest.checks.map((c) => runCheck(harness, c, maxCalls));
  return {
    projectDir,
    checks,
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      error: checks.filter((c) => c.status === "error").length,
      engineOnly: checks.filter((c) => c.status === "engine-only").length,
      calls: checks.reduce((n, c) => n + c.calls, 0),
    },
    modulesLoaded: harness.loaded(),
  };
}

/** Compact, greppable rendering — the model reads this, the JSON is for tooling. */
export function formatReport(report: SweepReport): string {
  const icon = { pass: "PASS", fail: "FAIL", error: "ERR ", "engine-only": "SKIP" } as const;
  const lines = report.checks.map((c) => {
    const head = `${icon[c.status]} ${c.id} — ${c.target} (${c.calls} calls${
      c.capped ? `, CAPPED from ${c.capped.declared}` : ""
    })`;
    if (c.status === "error" || c.status === "engine-only") return `${head}\n       ${c.error}`;
    if (c.status === "pass") return head;
    const shown = (c.failures ?? []).map(
      (f) => `       ${f.rule}: ${f.detail}\n         at ${JSON.stringify(f.args)}`
    );
    const more =
      (c.failureCount ?? 0) > shown.length
        ? [`       … ${(c.failureCount ?? 0) - shown.length} more`]
        : [];
    return [head, ...shown, ...more].join("\n");
  });
  const s = report.summary;
  return [
    `${s.pass} pass, ${s.fail} fail, ${s.error} error, ${s.engineOnly} engine-only — ${s.calls} calls`,
    "",
    ...lines,
  ].join("\n");
}
