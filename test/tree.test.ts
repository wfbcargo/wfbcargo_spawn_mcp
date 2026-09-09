import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { checkTree, formatTreeReport, walkTree } from "../src/tree.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A tiny 6.0 tree — files written by path, contents as given. */
function world(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-tree-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body as any);
  }
  return dir;
}

const GOOD_SCENE = '# spawn-scene v2 yaml x0z0\n"cube-1":\n  "primitive": { "kind": "box", "size": 2 }\n';

describe("walkTree", () => {
  it("skips .git but keeps .spawn, which the world tracks", () => {
    const dir = world({
      "world.config.yaml": "engine: 6.0.0\n",
      ".spawn/engine.yaml": "pin: 6.0.0\n",
      ".git/config": "[core]\n",
      "node_modules/x/index.js": "module.exports = 1;\n",
    });
    const files = walkTree(dir);
    assert.ok(files.includes("world.config.yaml"));
    assert.ok(files.includes(".spawn/engine.yaml"), ".spawn/ is world content on 6.0");
    assert.ok(!files.some((f) => f.startsWith(".git/")));
    assert.ok(!files.some((f) => f.startsWith("node_modules/")));
  });
});

describe("checkTree — scripts", () => {
  it("accepts real ESM: imports, exports, and the engine's hook shape", async () => {
    const dir = world({
      "templates/cube.js": 'export const cube = { primitive: { kind: "box", size: 2 } };\n',
      "scripts/lever.js":
        'import { cube } from "../templates/cube.js";\n' +
        "export function onSpawn(self, ctx) { ctx.emit('ready', cube); }\n" +
        "export async function update(self, ctx) { await ctx.runInSeconds(1, () => {}); }\n",
    });
    const report = await checkTree(dir);
    assert.deepEqual(report.issues, []);
    assert.equal(report.checked.js, 2);
    assert.equal(report.ok, true);
  });

  it("catches a script that does not parse, and names the file", async () => {
    const dir = world({ "scripts/broken.js": "export function onSpawn(self, ctx) { if (\n" });
    const report = await checkTree(dir);
    assert.equal(report.ok, false);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].file, "scripts/broken.js");
    assert.equal(report.issues[0].law, "js must parse");
  });

  it("does not EXECUTE the module it parses", async () => {
    // Parsing must be inert: a top-level throw is valid syntax, and running it
    // would turn a pre-flight into arbitrary code execution.
    const marker = join(mkdtempSync(join(tmpdir(), "spawn-side-")), "written.txt");
    roots.push(dirname(marker));
    const dir = world({
      "scripts/sideeffect.js":
        `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "executed");\n` +
        "throw new Error('top level');\n" +
        "export function onSpawn() {}\n",
    });
    const report = await checkTree(dir);
    assert.deepEqual(report.issues, [], "valid syntax must pass");
    assert.equal(
      (await import("node:fs")).existsSync(marker),
      false,
      "the module must never have been evaluated"
    );
  });

  it("narrows to the changed files when given a scope", async () => {
    const dir = world({
      "scripts/ok.js": "export const a = 1;\n",
      "scripts/broken.js": "export function x( {\n",
    });
    const scoped = await checkTree(dir, ["scripts/ok.js"]);
    assert.equal(scoped.ok, true, "a file outside the scope must not be checked");
    assert.equal(scoped.checked.js, 1);
    assert.equal((await checkTree(dir)).ok, false);
  });
});

describe("checkTree — scenes", () => {
  it("accepts a well-formed cell", async () => {
    const dir = world({ "places/main/cells/x0z0.scene": GOOD_SCENE });
    assert.deepEqual((await checkTree(dir)).issues, []);
  });

  it("requires the v2 header on line 1", async () => {
    const dir = world({ "places/main/cells/x0z0.scene": '"cube-1":\n  "physics": "static"\n' });
    const report = await checkTree(dir);
    assert.equal(report.issues[0].law, "scene header");
    assert.equal(report.issues[0].line, 1);
  });

  it("catches a header whose cell key disagrees with the filename", async () => {
    // cx = Math.round(x / 128): a mismatch loads the placements into the wrong
    // cell, and nothing about the YAML itself is malformed.
    const dir = world({ "places/main/cells/x1z0.scene": GOOD_SCENE });
    const report = await checkTree(dir);
    assert.equal(report.issues[0].law, "scene cell key");
    assert.match(report.issues[0].message, /x0z0/);
  });

  it("allows objects.scene, which carries no world xz", async () => {
    const dir = world({
      "places/main/cells/objects.scene": '# spawn-scene v2 yaml objects\n"thing":\n  "tags": ["x"]\n',
    });
    assert.deepEqual((await checkTree(dir)).issues, []);
  });

  it("catches tab indentation, whose YAML failure is opaque", async () => {
    const dir = world({ "places/main/cells/x0z0.scene": '# spawn-scene v2 yaml x0z0\n\t"a": 1\n' });
    const report = await checkTree(dir);
    assert.ok(report.issues.some((i) => i.law === "scene yaml"));
  });
});

describe("checkTree — assets", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("catches a .png whose bytes are not a PNG", async () => {
    const dir = world({ "ui/logo.png": "this is text, not an image" });
    const report = await checkTree(dir);
    assert.equal(report.issues[0].law, "asset bytes match extension");
  });

  it("accepts real PNG bytes", async () => {
    const dir = world({ "ui/logo.png": PNG });
    assert.deepEqual((await checkTree(dir)).issues, []);
  });

  it("refuses a binary under assets/, which the push law rejects", async () => {
    const dir = world({ "assets/knight.glb": Buffer.from([0x67, 0x6c, 0x54, 0x46]) });
    const report = await checkTree(dir);
    assert.equal(report.issues[0].law, "law.git.asset-kind");
    assert.match(report.issues[0].message, /CDN name/);
  });

  it("leaves source under assets/ alone", async () => {
    const dir = world({ "assets/manifest.json": "{}\n" });
    assert.deepEqual((await checkTree(dir)).issues, []);
  });
});

describe("formatTreeReport", () => {
  it("says what was checked when clean", async () => {
    const dir = world({ "scripts/a.js": "export const a = 1;\n" });
    assert.match(formatTreeReport(await checkTree(dir)), /clean — checked 1 script/);
  });

  it("names file, line and law when not", async () => {
    const dir = world({ "places/main/cells/x0z0.scene": "nope\n" });
    const text = formatTreeReport(await checkTree(dir));
    assert.match(text, /x0z0\.scene:1/);
    assert.match(text, /\[scene header\]/);
  });
});
