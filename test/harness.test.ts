import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHarness, EngineOnlyError, transformModule } from "../src/harness.js";
import { commonJsExports, scanProject } from "../src/audit-tools.js";

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-harness-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("transformModule", () => {
  it("handles the four export forms the engine uses", () => {
    const out = transformModule(
      [
        "export function a() { return 1; }",
        "export async function b() { return 2; }",
        "export const c = 3;",
        "export default function () { return 4; }",
      ].join("\n"),
      "t.js"
    );
    assert.match(out, /__exports\["a"\] = a;/);
    assert.match(out, /__exports\["b"\] = b;/);
    assert.match(out, /__exports\["c"\] = c;/);
    assert.match(out, /__exports\.default = __default;/);
  });

  it("leaves `export` inside a comment or string alone", () => {
    const src = ["// export function ghost() {}", 'const s = "export const x = 1";'].join("\n");
    const out = transformModule(src, "t.js");
    assert.doesNotMatch(out, /__exports\["ghost"\]/);
    assert.doesNotMatch(out, /__exports\["x"\]/);
  });

  it("refuses an export form it cannot parse rather than guessing", () => {
    assert.throws(
      () => transformModule("export { a, b };", "t.js"),
      /t\.js:1: unsupported export form/
    );
  });
});

describe("createHarness", () => {
  it("loads ESM-style exports and resolves lib requires", () => {
    const dir = project({
      "scripts/lib/grid.js": "export const cols = 4;\nexport function twice(n) { return n * 2; }",
      "scripts/main.js": [
        'const grid = require("lib/grid.js");',
        "export function widen(n) { return grid.twice(n) + grid.cols; }",
      ].join("\n"),
    });
    const mod = createHarness(dir).require("scripts/main.js") as any;
    assert.equal(mod.widen(3), 10);
  });

  it("loads CommonJS helpers, which is how most lib/*.js actually export", () => {
    const dir = project({
      "scripts/lib/eco.js": "function cost(n) { return n * 5; }\nmodule.exports = { cost: cost };",
      "scripts/main.js": [
        'const eco = require("lib/eco.js");',
        "export function total(n) { return eco.cost(n); }",
      ].join("\n"),
    });
    const mod = createHarness(dir).require("scripts/main.js") as any;
    assert.equal(mod.total(4), 20);
  });

  it("loads JSON data modules", () => {
    const dir = project({
      "scripts/lib/data/tiers.json": '{ "perTier": 0.35 }',
      "scripts/main.js": [
        'const T = require("lib/data/tiers.json");',
        "export function mult(t) { return 1 + T.perTier * (t - 1); }",
      ].join("\n"),
    });
    const mod = createHarness(dir).require("scripts/main.js") as any;
    assert.equal(mod.mult(3), 1.7);
  });

  it("caches a module so one instance is shared", () => {
    const dir = project({
      "scripts/lib/counter.js": "let n = 0;\nfunction bump() { return ++n; }\nmodule.exports = { bump: bump };",
      "scripts/a.js": 'const c = require("lib/counter.js");\nexport function go() { return c.bump(); }',
      "scripts/b.js": 'const c = require("lib/counter.js");\nexport function go() { return c.bump(); }',
    });
    const h = createHarness(dir);
    const a = h.require("scripts/a.js") as any;
    const b = h.require("scripts/b.js") as any;
    assert.equal(a.go(), 1);
    assert.equal(b.go(), 2);
  });

  it("reports the real dependency set it pulled", () => {
    const dir = project({
      "scripts/lib/one.js": "module.exports = { x: 1 };",
      "scripts/main.js": 'const o = require("lib/one.js");\nexport function v() { return o.x; }',
    });
    const h = createHarness(dir);
    h.require("scripts/main.js");
    assert.deepEqual(h.loaded().sort(), ["lib/one.js", "scripts/main.js"]);
  });

  it("refuses an engine-only builtin instead of stubbing it", () => {
    const dir = project({
      "scripts/fx.js": 'const fx = require("builtin/fx");\nexport function go() { return fx; }',
    });
    assert.throws(() => createHarness(dir).require("scripts/fx.js"), EngineOnlyError);
  });

  it("supplies the pure builtins", () => {
    const dir = project({
      "scripts/m.js": [
        'const M = require("builtin/math");',
        "export function c(v) { return M.clamp(v, 0, 10); }",
      ].join("\n"),
    });
    const mod = createHarness(dir).require("scripts/m.js") as any;
    assert.equal(mod.c(42), 10);
    assert.equal(mod.c(-1), 0);
  });

  it("refuses to escape the scripts directory", () => {
    const dir = project({ "scripts/main.js": "export const x = 1;", "secret.txt": "nope" });
    assert.throws(
      () => createHarness(dir).require("../../secret.txt"),
      /resolves outside/
    );
  });

  it("refuses a symlinked script, matching the compiler's guard", (t) => {
    const dir = project({ "scripts/real.js": "export const x = 1;", "outside.js": "export const x = 2;" });
    try {
      symlinkSync(join(dir, "outside.js"), join(dir, "scripts", "link.js"));
    } catch {
      return t.skip("symlink creation not permitted here");
    }
    assert.throws(() => createHarness(dir).require("scripts/link.js"), /is a symlink/);
  });

  it("surfaces a syntax error against the file that has it", () => {
    const dir = project({ "scripts/bad.js": "export function a( { return; }" });
    assert.throws(() => createHarness(dir).require("scripts/bad.js"), /scripts\/bad\.js: failed to compile/);
  });
});

describe("commonJsExports", () => {
  it("reads both shorthand and explicit keys", () => {
    assert.deepEqual(commonJsExports("module.exports = { a, b: b, c: helper };"), ["a", "b", "c"]);
  });

  it("ignores keys nested inside a value", () => {
    assert.deepEqual(commonJsExports("module.exports = { a: { deep: 1 }, b: [2] };"), ["a", "b"]);
  });

  it("returns nothing when the file has no CommonJS export", () => {
    assert.deepEqual(commonJsExports("export function a() {}"), []);
  });
});

describe("scanProject", () => {
  it("classifies by the api parameter, which is how the engine injects it", () => {
    const dir = project({
      "scripts/sys.js": [
        "export function update(dt, api) { return api; }",
        "export function pure(a, b) { return a + b; }",
      ].join("\n"),
    });
    const scan = scanProject(dir);
    const pure = scan.functions.find((f) => f.export === "pure");
    const coupled = scan.functions.find((f) => f.export === "update");
    assert.equal(pure?.auditable, true);
    assert.equal(coupled?.auditable, false);
    assert.match(coupled?.reason ?? "", /needs a live room/);
  });

  it("marks a whole module unauditable when it requires an engine builtin", () => {
    const dir = project({
      "scripts/geo.js": 'const g = require("builtin/geom");\nexport function shape(n) { return n; }',
    });
    const scan = scanProject(dir);
    assert.equal(scan.functions[0].auditable, false);
    assert.match(scan.functions[0].reason ?? "", /builtin\/geom/);
    assert.equal(scan.engineOnlyModules.length, 1);
  });

  it("finds CommonJS exports, where the pure math usually lives", () => {
    const dir = project({
      "scripts/lib/eco.js": "function cost(n, rate) { return n * rate; }\nmodule.exports = { cost: cost };",
    });
    const found = scanProject(dir).functions.find((f) => f.export === "cost");
    assert.deepEqual(found?.params, ["n", "rate"]);
    assert.equal(found?.auditable, true);
  });
});
