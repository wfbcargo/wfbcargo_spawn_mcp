import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compile, deepMerge, scriptKeyFilePath, specScriptsByFilePath } from "../src/compile.js";

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-compile-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("deepMerge", () => {
  it("merges nested objects", () => {
    assert.deepEqual(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } }), { a: { x: 1, y: 3 } });
  });

  it("replaces arrays wholesale rather than concatenating", () => {
    assert.deepEqual(deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  });

  it("lets the overlay win on type mismatch", () => {
    assert.equal(deepMerge({ a: 1 }, "str"), "str");
  });
});

describe("scriptKeyFilePath", () => {
  it("accepts well-formed script keys", () => {
    assert.equal(scriptKeyFilePath("scripts/main.js"), "scripts/main.js");
    assert.equal(scriptKeyFilePath("scripts/ai/enemy.json"), "scripts/ai/enemy.json");
  });

  it("collapses repeated scripts/ prefixes", () => {
    assert.equal(scriptKeyFilePath("scripts/scripts/main.js"), "scripts/main.js");
  });

  it("rejects traversal, absolute-ish, and non-script keys", () => {
    for (const bad of [
      "scripts/../evil.js",
      "scripts/a/../../evil.js",
      "scripts/./evil.js",
      "scripts/sub\\evil.js",
      "scripts//evil.js",
      "world/thing.js",
      "scripts/notes.txt",
      "scripts/no-extension",
    ]) {
      assert.equal(scriptKeyFilePath(bad), null, `expected ${bad} to be rejected`);
    }
  });
});

describe("specScriptsByFilePath", () => {
  it("normalizes bare keys and drops non-string sources", () => {
    const out = specScriptsByFilePath({
      scripts: { "main.js": "a", "scripts/other.js": "b", "scripts/bad.js": 42, "x.txt": "c" },
    });
    assert.deepEqual(out, { "scripts/main.js": "a", "scripts/other.js": "b" });
  });
});

describe("compile", () => {
  it("throws a useful error when game.json is missing or malformed", () => {
    assert.throws(() => compile(project({})), /no game.json/);
    assert.throws(() => compile(project({ "game.json": "{oops" })), /not valid JSON/);
  });

  it("merges world/*.json over game.json", () => {
    const dir = project({
      "game.json": JSON.stringify({ name: "g", world: { sky: "day", seed: 1 } }),
      "world/sky.json": JSON.stringify({ world: { sky: "night" } }),
    });
    assert.deepEqual(compile(dir).world, { sky: "night", seed: 1 });
  });

  it("names the offending file when a world json is malformed", () => {
    const dir = project({ "game.json": "{}", "world/broken.json": "{nope" });
    assert.throws(() => compile(dir), /broken\.json is not valid JSON/);
  });

  it("folds scripts/** into the spec, with disk winning over inline sources", () => {
    const dir = project({
      "game.json": JSON.stringify({ scripts: { "scripts/main.js": "stale", "scripts/only-inline.js": "kept" } }),
      "scripts/main.js": "fresh",
      "scripts/ai/enemy.js": "enemy",
    });
    const spec = compile(dir);
    assert.equal(spec.scripts["scripts/main.js"], "fresh");
    assert.equal(spec.scripts["scripts/ai/enemy.js"], "enemy");
    assert.equal(spec.scripts["scripts/only-inline.js"], "kept");
  });

  it("ignores non-script files and .theirs receipts", () => {
    const dir = project({
      "game.json": JSON.stringify({ scripts: {} }),
      "scripts/main.js": "ok",
      "scripts/README.md": "docs",
      "scripts/main.js.theirs": "conflict",
    });
    assert.deepEqual(Object.keys(compile(dir).scripts), ["scripts/main.js"]);
  });

  /**
   * Windows refuses unprivileged symlinks but allows directory junctions,
   * which Node's lstat also reports as symlinks — so the walker sees the same
   * thing either way and these stay real assertions on every platform.
   */
  function linkDir(target: string, path: string): boolean {
    for (const type of ["dir", "junction"] as const) {
      try {
        symlinkSync(target, path, type);
        return true;
      } catch {
        /* try the next flavor */
      }
    }
    return false;
  }

  it("does not follow links out of the project", (t) => {
    const outside = project({ "secret.js": "SECRET" });
    const dir = project({ "game.json": JSON.stringify({ scripts: {} }), "scripts/real.js": "ok" });
    if (!linkDir(outside, join(dir, "scripts", "leak"))) {
      return t.skip("neither symlinks nor junctions are permitted on this host");
    }
    const scripts = compile(dir).scripts;
    assert.deepEqual(Object.keys(scripts), ["scripts/real.js"]);
    assert.equal(JSON.stringify(scripts).includes("SECRET"), false, "linked-in file must not be uploaded");
  });

  it("does not recurse forever on a link loop", (t) => {
    const dir = project({ "game.json": JSON.stringify({ scripts: {} }), "scripts/a.js": "ok" });
    if (!linkDir(join(dir, "scripts"), join(dir, "scripts", "loop"))) {
      return t.skip("neither symlinks nor junctions are permitted on this host");
    }
    assert.deepEqual(Object.keys(compile(dir).scripts), ["scripts/a.js"]);
  });
});
