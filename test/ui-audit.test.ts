import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ALL_SURFACE_IDS,
  formatUiReport,
  loadUiManifest,
  mergeUiManifest,
  missingUiSurfaceLabels,
  scanUi,
  type UiManifest,
} from "../src/ui-audit.js";

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-ui-audit-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function findingOf(report: ReturnType<typeof scanUi>, id: string) {
  const f = report.findings.find((x) => x.id === id);
  assert.ok(f, `expected a finding for "${id}"`);
  return f!;
}

describe("lane detection", () => {
  it("recognises the git lane from .spawn/engine.yaml plus a git checkout, and finds evidence in the tree", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "scripts/ui/main-menu.js": "export function draw(ctx) {\n  ctx.fillStyle = '#ffcc00';\n  return true;\n}\n",
      "scripts/ui/inventory.js": "export function toggle() {\n  return true;\n}\n",
    });

    const report = scanUi(dir, { expect: ["main-menu", "inventory", "quest"] });
    assert.equal(report.lane, "git");
    assert.match(report.laneSource, /engine\.yaml/);

    assert.equal(findingOf(report, "main-menu").verdict, "present");
    assert.equal(findingOf(report, "inventory").verdict, "thin");
    assert.equal(findingOf(report, "quest").verdict, "missing");
  });

  it("recognises the document lane from a bare game.json, reading embedded scripts and folded-out ones", () => {
    const dir = project({
      "game.json": JSON.stringify({
        objects: [{ id: "hud", type: "panel" }],
        scripts: { "scripts/ui/overlay.js": "export function draw(){ return { color: '#112233' }; }" },
      }),
      "scripts/ui/tutorial.js": "export function show(){ return 1; }",
    });

    const report = scanUi(dir, { expect: ["overlay", "tutorial", "quest"] });
    assert.equal(report.lane, "document");
    assert.match(report.laneSource, /game\.json/);

    assert.equal(findingOf(report, "overlay").verdict, "present");
    assert.equal(findingOf(report, "tutorial").verdict, "thin");
    assert.equal(findingOf(report, "quest").verdict, "missing");
  });

  it("prefers a cached engine reading over structural signals", () => {
    const dir = project({
      ".spawn/engine.json": JSON.stringify({ era: "6.0" }),
      // A bare game.json would normally read as the document lane, but the
      // cache is checked first and says otherwise.
      "game.json": "{}",
    });

    const report = scanUi(dir, { expect: [] });
    assert.equal(report.lane, "git");
    assert.match(report.laneSource, /cached engine reading/);
  });

  it("refuses a directory that matches neither lane, rather than reporting an empty game", () => {
    const dir = project({ "README.md": "just a readme\n" });
    assert.throws(() => scanUi(dir, null), /does not look like a Spawn game project/);
  });
});

describe("verdicts", () => {
  it("scores present only when a citing file references art or style, not just any evidence", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/ui/settings.js": "export function open(){ return true; }",
    });
    const report = scanUi(dir, { expect: ["settings"] });
    assert.equal(findingOf(report, "settings").verdict, "thin");
  });

  it("keeps missing distinct from thin: zero evidence anywhere in the corpus", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/misc.js": "export function noop(){}",
    });
    const report = scanUi(dir, { expect: ["skill-tree"] });
    const f = findingOf(report, "skill-tree");
    assert.equal(f.verdict, "missing");
    assert.deepEqual(f.citations, []);
  });

  it("cites a file once, at its line, rather than twice for the path and the line", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/ui/inventory.js": "export function openInventory(){ return true; }",
    });
    const { citations } = findingOf(scanUi(dir, { expect: ["inventory"] }), "inventory");
    assert.deepEqual(citations, ["scripts/ui/inventory.js:1"]);
  });

  it("says how many citations it withheld rather than capping silently", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      // Six citing lines against a cap of three.
      "scripts/ui/panel.js": Array.from({ length: 6 }, () => "// settings").join("\n"),
    });
    const { citations } = findingOf(scanUi(dir, { expect: ["settings"] }), "settings");
    assert.equal(citations.length, 4, "three citations plus the overflow line");
    assert.equal(citations.at(-1), "(+3 more)");
  });

  // The corpus walker refuses symlinks as it goes. Filtering after the walk
  // could not have worked: the duplicates are produced during it — tree.ts's
  // walkTree returns 64 paths for one real file on the cycle fixture below.
  // Directory symlinks need admin rights on Windows, so skip there rather than
  // assert something the platform won't let us build.
  const canSymlinkDirs = (() => {
    if (process.platform !== "win32") return true;
    try {
      const d = project({ "a/keep.js": "" });
      symlinkSync(join(d, "a"), join(d, "link"), "junction");
      return true;
    } catch {
      return false;
    }
  })();

  it("cites a file once on a symlinked directory cycle, not once per phantom path", { skip: !canSymlinkDirs }, () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/ui/settings.js": "export function open(){}",
    });
    // scripts/ui/loop -> scripts, so scripts/ui/loop/ui/loop/… keeps descending.
    symlinkSync(join(dir, "scripts"), join(dir, "scripts", "ui", "loop"), "junction");
    const { verdict, citations } = findingOf(scanUi(dir, { expect: ["settings"] }), "settings");
    assert.equal(verdict, "thin", "the real file is still found");
    // Path hit only: the body says nothing about settings, the filename does.
    assert.deepEqual(citations, ["scripts/ui/settings.js"], "exactly one path, not a nested phantom");
  });

  it("does not read a file linked in from outside the project", { skip: !canSymlinkDirs }, () => {
    const outside = project({ "secret/inventory-notes.js": "// backpack item-grid" });
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/keep.js": "export function keep(){}",
    });
    symlinkSync(join(outside, "secret"), join(dir, "scripts", "linked"), "junction");
    const report = scanUi(dir, { expect: ["inventory"] });
    assert.equal(findingOf(report, "inventory").verdict, "missing", "linked-in file must not enter the corpus");
  });

  it("does not false-positive a short alias against a longer word (map vs mapping)", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/enemy-mapping.js": "export function reduceMapping(list){ return list.filter(x => x); }",
    });
    const report = scanUi(dir, { expect: ["map"] });
    assert.equal(findingOf(report, "map").verdict, "missing");
  });
});

describe("declaration and scope", () => {
  it("falls back to the baseline set when no manifest is given, and reports it undeclared", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
    });
    const report = scanUi(dir, null);
    assert.equal(report.declared, false);
    assert.deepEqual(report.expected, ["main-menu", "in-game", "settings", "overlay", "game-over", "loading"]);
  });

  it("lets an explicit empty expect replace the baseline with nothing, rather than falling back to it", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: [] });
    assert.deepEqual(report.expected, []);
    assert.deepEqual(report.findings, []);
  });

  it("drops ignored surfaces from every section, not just findings", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: ["main-menu", "credits"], ignore: ["credits"] });
    assert.deepEqual(
      report.findings.map((f) => f.id),
      ["main-menu"]
    );
    assert.ok(!report.notExpected.includes("credits"));
  });

  it("reports everything not declared quietly, in notExpected", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: ["main-menu"] });
    assert.equal(report.notExpected.length, ALL_SURFACE_IDS.length - 1);
    assert.ok(!report.notExpected.includes("main-menu"));
  });
});

describe("the unknown-slug menu", () => {
  it("refuses an unknown expect slug with the full 21-surface menu rather than an error code", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    assert.throws(() => scanUi(dir, { expect: ["not-a-real-surface"] }), (e: any) => {
      assert.match(e.message, /not-a-real-surface/);
      assert.match(e.message, /character/);
      assert.match(e.message, /tutorial/);
      return true;
    });
  });

  it("refuses an unknown genre with the genre menu", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    assert.throws(() => scanUi(dir, { genre: "not-a-genre" }), /Valid genres.*rpg/s);
  });

  it("refuses an unknown theme with the theme menu", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    assert.throws(() => scanUi(dir, { theme: "not-a-theme" }), /Valid themes.*fantasy/s);
  });
});

describe("reference links", () => {
  it("builds a screenshots URL from the element slug alone", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: ["main-menu"] });
    assert.equal(
      findingOf(report, "main-menu").reference,
      "https://interfaceingame.com/screenshots/?elements=main-menu"
    );
  });

  it("appends validated genre and theme", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: ["main-menu"], genre: "rpg", theme: "fantasy" });
    assert.equal(
      findingOf(report, "main-menu").reference,
      "https://interfaceingame.com/screenshots/?elements=main-menu&genres=rpg&themes=fantasy"
    );
  });
});

// Precedence, not marshalling: this is what stops a per-call link hint from
// silently changing which surfaces get checked.
describe("mergeUiManifest", () => {
  const file: UiManifest = { expect: ["map"], ignore: ["credits"], genre: "rpg", theme: "fantasy" };

  it("returns the file manifest untouched when no argument was passed", () => {
    assert.equal(mergeUiManifest(file, {}), file);
    assert.equal(mergeUiManifest(null, {}), null);
  });

  it("keeps the file's expect when only a link hint is passed", () => {
    const merged = mergeUiManifest(file, { genre: "puzzle" });
    assert.deepEqual(merged?.expect, ["map"], "a genre hint must not change the surface set");
    assert.equal(merged?.genre, "puzzle");
    assert.equal(merged?.theme, "fantasy", "untouched fields survive");
  });

  it("never lets an argument revoke the file's ignore list", () => {
    assert.deepEqual(mergeUiManifest(file, { expect: ["settings"] })?.ignore, ["credits"]);
  });

  it("builds a manifest from arguments alone when there is no file", () => {
    assert.deepEqual(mergeUiManifest(null, { expect: ["settings"] }), {
      expect: ["settings"],
      ignore: undefined,
      genre: undefined,
      theme: undefined,
    });
  });
});

describe("missingUiSurfaceLabels", () => {
  it("returns labels for the surfaces scored missing", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "audit/ui.json": JSON.stringify({ expect: ["map", "settings"] }),
      "scripts/ui/settings.js": "export function open(){}",
    });
    assert.deepEqual(missingUiSurfaceLabels(dir), ["Map"]);
  });

  it("returns null — not an empty list — when the scan cannot run", () => {
    // A directory that is neither lane. Collapsing this to [] would report
    // "nothing is missing" for a scan that never happened (R-003).
    assert.equal(missingUiSurfaceLabels(project({ "readme.txt": "not a game" })), null);
  });

  it("returns null when audit/ui.json names a surface that does not exist", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "audit/ui.json": JSON.stringify({ expect: ["invnetory"] }),
    });
    assert.equal(missingUiSurfaceLabels(dir), null);
  });

  it("distinguishes a genuinely complete UI from a failed scan", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "audit/ui.json": JSON.stringify({ expect: ["settings"] }),
      "scripts/ui/settings.js": "export function open(){}",
    });
    assert.deepEqual(missingUiSurfaceLabels(dir), [], "clean is an empty list, never null");
  });
});

describe("loadUiManifest", () => {
  it("returns null when audit/ui.json is absent", () => {
    const dir = project({});
    assert.equal(loadUiManifest(join(dir, "audit/ui.json")), null);
  });

  it("loads a valid declaration", () => {
    const dir = project({
      "audit/ui.json": JSON.stringify({ expect: ["main-menu", "inventory"], genre: "rpg" }),
    });
    const manifest = loadUiManifest(join(dir, "audit/ui.json")) as UiManifest;
    assert.deepEqual(manifest.expect, ["main-menu", "inventory"]);
    assert.equal(manifest.genre, "rpg");
  });

  it("throws naming the field when the JSON does not match the schema", () => {
    const dir = project({ "audit/ui.json": JSON.stringify({ expect: "main-menu" }) });
    assert.throws(() => loadUiManifest(join(dir, "audit/ui.json")), /expect/);
  });

  it("throws when the file is not valid JSON", () => {
    const dir = project({ "audit/ui.json": "{ not json" });
    assert.throws(() => loadUiManifest(join(dir, "audit/ui.json")), /could not read/);
  });

  it("refuses an unknown slug with the menu, same as scanUi", () => {
    const dir = project({ "audit/ui.json": JSON.stringify({ expect: ["ghost-screen"] }) });
    assert.throws(() => loadUiManifest(join(dir, "audit/ui.json")), /Valid surfaces.*ghost-screen|ghost-screen.*Valid surfaces/s);
  });
});

describe("formatUiReport", () => {
  it("renders sections in order: headline, MISSING, THIN, PRESENT, notExpected, declaration hint, caveat", () => {
    const dir = project({
      ".spawn/engine.yaml": "era: 6.0\n",
      ".git/HEAD": "x\n",
      "scripts/ui/main-menu.js": "export function draw(){ return '#ffcc00'; }",
      "scripts/ui/settings.js": "export function open(){ return true; }",
    });
    const report = scanUi(dir, null); // undeclared -> baseline + declaration hint
    const text = formatUiReport(report);

    const iMissing = text.indexOf("MISSING (");
    const iThin = text.indexOf("THIN (");
    const iPresent = text.indexOf("PRESENT (");
    const iNotExpected = text.indexOf("Not in your expected set");
    const iHint = text.indexOf("No audit/ui.json declaration found");
    const iCaveat = text.indexOf('"present" means a citing file references art or style');

    assert.ok(iMissing >= 0 && iThin > iMissing && iPresent > iThin, "verdict sections out of order");
    assert.ok(iNotExpected > iPresent, "notExpected line should follow the verdict sections");
    assert.ok(iHint > iNotExpected, "declaration hint should follow the notExpected line");
    assert.ok(iCaveat > iHint, "the present-means-cites-art caveat should be last");

    assert.match(text, /main-menu — Main menu/);
    assert.match(text, /spawn_skill ids=\["game-ui","drawn-art","looks"\]/);
  });

  // `declared` (the file is on disk) and `expectDeclared` (the surface set was
  // chosen, not defaulted) come apart, and the hint has to be true in all four
  // combinations. The inline-with-no-file case is the one that regressed: it
  // used to claim a declaration existed because a manifest object was passed.
  const lane = { ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" };
  const declaration = JSON.stringify({ expect: ["main-menu"] });

  it("says nothing is written down when expect came inline and no file exists", () => {
    const report = scanUi(project(lane), { expect: ["main-menu"] });
    assert.equal(report.declared, false, "no audit/ui.json on disk");
    assert.equal(report.expectDeclared, true);
    assert.match(formatUiReport(report), /there is no audit\/ui\.json on disk, so nothing here is written down/);
  });

  it("keeps the write-a-declaration nudge when only a link hint was passed inline", () => {
    const report = scanUi(project(lane), { genre: "rpg" });
    assert.equal(report.declared, false);
    assert.equal(report.expectDeclared, false, "a genre hint is not a surface set");
    assert.match(formatUiReport(report), /No audit\/ui\.json declaration found/);
  });

  it("omits every hint when the file declares an expect list", () => {
    const report = scanUi(project({ ...lane, "audit/ui.json": declaration }), { expect: ["main-menu"] });
    assert.equal(report.declared, true);
    assert.equal(report.expectDeclared, true);
    const text = formatUiReport(report);
    assert.doesNotMatch(text, /No audit\/ui\.json declaration found/);
    assert.doesNotMatch(text, /nothing here is written down/);
    assert.doesNotMatch(text, /declares no "expect" list/);
  });

  it("asks for an expect list when the file exists but declares only a link hint", () => {
    const dir = project({ ...lane, "audit/ui.json": JSON.stringify({ genre: "rpg" }) });
    const report = scanUi(dir, { genre: "rpg" });
    assert.equal(report.declared, true);
    assert.equal(report.expectDeclared, false);
    assert.match(formatUiReport(report), /exists but declares no "expect" list/);
  });

  it("omits the notExpected line when nothing is left over", () => {
    const dir = project({ ".spawn/engine.yaml": "era: 6.0\n", ".git/HEAD": "x\n" });
    const report = scanUi(dir, { expect: [...ALL_SURFACE_IDS] });
    assert.doesNotMatch(formatUiReport(report), /Not in your expected set/);
  });
});
