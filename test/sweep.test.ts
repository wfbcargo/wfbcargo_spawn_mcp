import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { formatReport, loadManifest, manifestSchema, runSweep } from "../src/sweep.js";

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-sweep-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** One project reused by most cases: a scaling curve, a divider, an object return. */
function mathProject(): string {
  return project({
    "scripts/math.js": [
      "export function mult(tier, wave) { return 1 + 0.35 * (tier - 1) + 0.06 * (wave - 1); }",
      "export function ratio(a, b) { return a / b; }",
      "export function plan(n) { return { bodies: n, dropped: n > 5 ? n - 5 : 0 }; }",
      "export function dip(t) { return t === 3 ? 0 : t; }",
      "export function label(t) { return t > 2 ? '' : 'wave ' + t; }",
    ].join("\n"),
  });
}

const run = (dir: string, checks: unknown[]) => runSweep(dir, manifestSchema.parse({ checks }));

describe("domains", () => {
  it("sweeps an inclusive numeric range", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "mult", args: [{ range: [1, 5] }, { const: 1 }], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].calls, 5);
    assert.equal(r.checks[0].status, "pass");
  });

  it("honours a fractional step without dropping the high bound to float drift", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "mult", args: [{ range: [1, 2], step: 0.1 }, { const: 1 }], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].calls, 11);
  });

  it("takes an explicit value list", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "mult", args: [{ values: [1, 4, 9] }, { const: 1 }], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].calls, 3);
  });

  it("reports a capped sweep rather than truncating in silence", () => {
    const dir = mathProject();
    const report = runSweep(
      dir,
      manifestSchema.parse({
        maxCalls: 10,
        checks: [
          { id: "c", module: "scripts/math.js", export: "mult", args: [{ range: [1, 100] }, { range: [1, 5] }], assert: { finite: true } },
        ],
      })
    );
    assert.deepEqual(report.checks[0].capped, { declared: 500, ran: 10 });
    assert.match(formatReport(report), /CAPPED from 500/);
  });
});

describe("assertions", () => {
  it("catches a non-finite result (E1)", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "ratio", args: [{ name: "a", const: 1 }, { name: "b", values: [2, 0] }], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].status, "fail");
    assert.equal(r.checks[0].failureCount, 1);
    assert.deepEqual(r.checks[0].failures?.[0].args, { a: 1, b: 0 });
    assert.match(r.checks[0].failures?.[0].detail ?? "", /Infinity/);
  });

  it("catches a bound violation and names the arguments", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "plan", args: [{ name: "n", range: [1, 8] }], select: "dropped", assert: { max: 0 } },
    ]);
    assert.equal(r.checks[0].status, "fail");
    assert.equal(r.checks[0].failureCount, 3);
    assert.deepEqual(r.checks[0].failures?.[0].args, { n: 6 });
  });

  it("selects a field out of an object result", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "plan", args: [{ range: [1, 4] }], select: "bodies", assert: { min: 1, integer: true } },
    ]);
    assert.equal(r.checks[0].status, "pass");
  });

  it("evaluates a custom expression against the value", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "label", args: [{ name: "t", range: [1, 4] }], assert: { expr: "typeof value === 'string' && value.length > 0" } },
    ]);
    assert.equal(r.checks[0].status, "fail");
    assert.equal(r.checks[0].failureCount, 2);
  });

  it("records a throw as a finding rather than losing the sweep", () => {
    const dir = project({ "scripts/m.js": "export function boom(n) { if (n === 2) throw new Error('nope'); return n; }" });
    const r = run(dir, [
      { id: "c", module: "scripts/m.js", export: "boom", args: [{ name: "n", range: [1, 3] }], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].calls, 3);
    assert.equal(r.checks[0].failures?.[0].rule, "throws");
    assert.match(r.checks[0].failures?.[0].detail ?? "", /nope/);
  });
});

describe("monotonicity (E3)", () => {
  it("passes a curve that only rises", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "mult", args: [{ name: "tier", range: [1, 10] }, { name: "wave", range: [1, 5] }], assert: { increasingIn: "tier" } },
    ]);
    assert.equal(r.checks[0].status, "pass");
  });

  it("catches a dip, holding the other arguments fixed", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "dip", args: [{ name: "t", range: [1, 5] }], assert: { nondecreasingIn: "t" } },
    ]);
    assert.equal(r.checks[0].status, "fail");
    assert.deepEqual(r.checks[0].failures?.[0].args, { t: 3 });
    assert.match(r.checks[0].failures?.[0].detail ?? "", /2 → 0/);
  });

  it("compares within a group, not across unrelated argument combinations", () => {
    // f falls as `other` rises, so a group-blind comparison would report a false
    // decrease when the sweep rolls over from (t=5, other=1) to (t=1, other=2).
    const dir = project({ "scripts/m.js": "export function f(t, other) { return t * 10 - other; }" });
    const r = run(dir, [
      { id: "c", module: "scripts/m.js", export: "f", args: [{ name: "t", range: [1, 5] }, { name: "other", range: [1, 3] }], assert: { increasingIn: "t" } },
    ]);
    assert.equal(r.checks[0].status, "pass");
  });

  it("rejects an axis that names no declared argument", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "mult", args: [{ name: "tier", range: [1, 3] }, { const: 1 }], assert: { increasingIn: "nope" } },
    ]);
    assert.equal(r.checks[0].status, "error");
    assert.match(r.checks[0].error ?? "", /names no declared argument/);
  });
});

describe("failure modes", () => {
  it("reports a missing export as an error, not a pass", () => {
    const r = run(mathProject(), [
      { id: "c", module: "scripts/math.js", export: "ghost", args: [], assert: { finite: true } },
    ]);
    assert.equal(r.checks[0].status, "error");
    assert.match(r.checks[0].error ?? "", /not an exported function/);
  });

  it("marks an engine-coupled module engine-only instead of failing it", () => {
    const dir = project({
      "scripts/fx.js": 'const fx = require("builtin/fx");\nexport function go(n) { return n; }',
    });
    const r = run(dir, [{ id: "c", module: "scripts/fx.js", export: "go", args: [{ range: [1, 2] }], assert: { finite: true } }]);
    assert.equal(r.checks[0].status, "engine-only");
    assert.equal(r.summary.fail, 0);
    assert.equal(r.summary.engineOnly, 1);
  });

  it("keeps one broken check from stopping the others", () => {
    const r = run(mathProject(), [
      { id: "broken", module: "scripts/math.js", export: "ghost", args: [], assert: { finite: true } },
      { id: "fine", module: "scripts/math.js", export: "mult", args: [{ range: [1, 3] }, { const: 1 }], assert: { finite: true } },
    ]);
    assert.equal(r.summary.error, 1);
    assert.equal(r.summary.pass, 1);
  });
});

describe("loadManifest", () => {
  it("names the offending field when the manifest is malformed", () => {
    const dir = project({ "audit/math.json": '{ "checks": [{ "id": "c" }] }' });
    assert.throws(() => loadManifest(join(dir, "audit/math.json")), /checks\.0\.module/);
  });

  it("rejects a manifest with no checks", () => {
    const dir = project({ "audit/math.json": '{ "checks": [] }' });
    assert.throws(() => loadManifest(join(dir, "audit/math.json")), /is not a valid audit manifest/);
  });
});
