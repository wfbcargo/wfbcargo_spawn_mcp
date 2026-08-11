import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  listConflictReceipts,
  mergeSpec,
  readBaseGame,
  syncPulledSpec,
  writeBaseGame,
} from "../src/compile.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project whose game.json is `local` and whose spec rail is `base`. */
function scenario(opts: { base?: object | null; local?: object }): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-spec-"));
  roots.push(dir);
  if (opts.base !== null && opts.base !== undefined) writeBaseGame(dir, opts.base);
  if (opts.local !== undefined) {
    writeFileSync(join(dir, "game.json"), JSON.stringify(opts.local, null, 2));
  }
  return dir;
}

const readGame = (dir: string) => JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
const readReceipt = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "game.json.theirs"), "utf8"));

describe("mergeSpec", () => {
  it("takes upstream for keys only upstream moved", () => {
    const { merged, conflicts } = mergeSpec(
      { title: "old", gravity: 9 },
      { title: "old", gravity: 9 },
      { title: "new", gravity: 9 }
    );
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { title: "new", gravity: 9 });
  });

  it("keeps local for keys only we moved", () => {
    const { merged, conflicts } = mergeSpec(
      { title: "old", gravity: 9 },
      { title: "mine", gravity: 9 },
      { title: "old", gravity: 9 }
    );
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { title: "mine", gravity: 9 });
  });

  it("composes disjoint edits from both sides", () => {
    const { merged, conflicts } = mergeSpec(
      { a: 1, b: 1 },
      { a: 2, b: 1 },
      { a: 1, b: 3 }
    );
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { a: 2, b: 3 });
  });

  it("conflicts on the narrowest key, not the whole subtree", () => {
    const { merged, conflicts } = mergeSpec(
      { world: { sky: "blue", fog: 1, ground: "dirt" } },
      { world: { sky: "red", fog: 1, ground: "dirt" } },
      { world: { sky: "green", fog: 2, ground: "dirt" } }
    );
    assert.deepEqual(conflicts, ["world.sky"]);
    // fog still fast-forwards even though its sibling conflicted.
    assert.deepEqual(merged, { world: { sky: "red", fog: 2, ground: "dirt" } });
  });

  it("keeps the local value at a conflict so work is never clobbered", () => {
    const { merged } = mergeSpec({ x: 1 }, { x: "mine" }, { x: "theirs" });
    assert.deepEqual(merged, { x: "mine" });
  });

  it("is a no-op when both sides made the same edit", () => {
    const { merged, conflicts } = mergeSpec({ x: 1 }, { x: 2 }, { x: 2 });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { x: 2 });
  });

  it("treats arrays as atomic values", () => {
    const both = mergeSpec({ tags: ["a"] }, { tags: ["a", "b"] }, { tags: ["a", "c"] });
    assert.deepEqual(both.conflicts, ["tags"]);
    assert.deepEqual(both.merged, { tags: ["a", "b"] });

    const oneSide = mergeSpec({ tags: ["a"] }, { tags: ["a"] }, { tags: ["a", "c"] });
    assert.deepEqual(oneSide.conflicts, []);
    assert.deepEqual(oneSide.merged, { tags: ["a", "c"] });
  });

  it("honours a local delete that upstream did not touch", () => {
    const { merged, conflicts } = mergeSpec({ gone: 1, kept: 1 }, { kept: 1 }, { gone: 1, kept: 1 });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { kept: 1 });
  });

  it("applies an upstream delete we did not touch", () => {
    const { merged, conflicts } = mergeSpec({ gone: 1, kept: 1 }, { gone: 1, kept: 1 }, { kept: 1 });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { kept: 1 });
  });

  it("conflicts when upstream changed a key we deleted", () => {
    const { merged, conflicts } = mergeSpec({ x: 1 }, {}, { x: 2 });
    assert.deepEqual(conflicts, ["x"]);
    assert.deepEqual(merged, {}, "our delete stands until the agent resolves it");
  });

  it("conflicts when both sides added the same key differently", () => {
    const { merged, conflicts } = mergeSpec({}, { x: "mine" }, { x: "theirs" });
    assert.deepEqual(conflicts, ["x"]);
    assert.deepEqual(merged, { x: "mine" });
  });

  it("accepts a key only upstream added", () => {
    const { merged, conflicts } = mergeSpec({}, { a: 1 }, { a: 1, b: 2 });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(merged, { a: 1, b: 2 });
  });

  it("reports nested conflicts with a dotted path", () => {
    const { conflicts } = mergeSpec(
      { entities: { player: { hp: 100 } } },
      { entities: { player: { hp: 120 } } },
      { entities: { player: { hp: 150 } } }
    );
    assert.deepEqual(conflicts, ["entities.player.hp"]);
  });
});

describe("syncPulledSpec", () => {
  it("merges upstream into local edits without a receipt when they are disjoint", () => {
    const dir = scenario({ base: { title: "old", fog: 1 }, local: { title: "mine", fog: 1 } });
    const summary = syncPulledSpec(dir, { title: "old", fog: 2 });
    assert.equal(summary.mode, "merged");
    assert.deepEqual(summary.conflicts, []);
    assert.deepEqual(readGame(dir), { title: "mine", fog: 2 });
    assert.equal(existsSync(join(dir, "game.json.theirs")), false);
  });

  it("keeps local content and writes a receipt when a key conflicts", () => {
    const dir = scenario({ base: { title: "old" }, local: { title: "mine" } });
    const summary = syncPulledSpec(dir, { title: "theirs" });
    assert.deepEqual(summary.conflicts, ["title"]);
    assert.deepEqual(readGame(dir), { title: "mine" }, "local file must not be clobbered");
    assert.deepEqual(readReceipt(dir), { title: "theirs" });
    assert.deepEqual(
      listConflictReceipts(dir).map((p) => p.endsWith("game.json.theirs")),
      [true],
      "an unresolved spec conflict must block spawn_push"
    );
  });

  it("clears a stale receipt once the next pull merges cleanly", () => {
    const dir = scenario({ base: { title: "old" }, local: { title: "mine" } });
    syncPulledSpec(dir, { title: "theirs" });
    assert.equal(existsSync(join(dir, "game.json.theirs")), true);
    // Agent resolves by taking upstream, then pulls again.
    writeFileSync(join(dir, "game.json"), JSON.stringify({ title: "theirs" }));
    syncPulledSpec(dir, { title: "theirs" });
    assert.equal(existsSync(join(dir, "game.json.theirs")), false);
  });

  it("leaves scripts to their own rail but carries upstream's map into game.json", () => {
    const dir = scenario({
      base: { title: "old" },
      local: { title: "old", scripts: { "scripts/a.js": "mine" } },
    });
    const summary = syncPulledSpec(dir, {
      title: "new",
      scripts: { "scripts/a.js": "theirs" },
    });
    assert.deepEqual(summary.conflicts, [], "script sources must not conflict here");
    assert.deepEqual(readGame(dir), { title: "new", scripts: { "scripts/a.js": "theirs" } });
    assert.deepEqual(readBaseGame(dir), { title: "new" }, "the rail never stores scripts");
  });

  it("advances the rail so an unchanged second pull is a clean no-op", () => {
    const dir = scenario({ base: { a: 1 }, local: { a: 1 } });
    syncPulledSpec(dir, { a: 1, b: 2 });
    const second = syncPulledSpec(dir, { a: 1, b: 2 });
    assert.equal(second.mode, "merged");
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(readGame(dir), { a: 1, b: 2 });
  });

  it("replaces and backs up when there is no rail to merge against", () => {
    const dir = scenario({ base: null, local: { title: "mine" } });
    const summary = syncPulledSpec(dir, { title: "theirs" });
    assert.equal(summary.mode, "replaced");
    assert.equal(summary.backup, ".spawn/replaced-game.json");
    assert.deepEqual(readGame(dir), { title: "theirs" });
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, ".spawn", "replaced-game.json"), "utf8")),
      { title: "mine" }
    );
    // The rail now exists, so the same situation merges next time.
    assert.deepEqual(readBaseGame(dir), { title: "theirs" });
  });

  it("skips the backup when a rail-less replace drops nothing", () => {
    const dir = scenario({ base: null, local: { title: "same" } });
    const summary = syncPulledSpec(dir, { title: "same" });
    assert.equal(summary.mode, "replaced");
    assert.equal(summary.backup, undefined);
    assert.equal(existsSync(join(dir, ".spawn", "replaced-game.json")), false);
  });

  it("backs up an unparseable game.json rather than silently dropping it", () => {
    const dir = scenario({ base: { title: "old" } });
    writeFileSync(join(dir, "game.json"), "{ half an edit");
    const summary = syncPulledSpec(dir, { title: "theirs" });
    assert.equal(summary.mode, "replaced");
    assert.equal(summary.backup, ".spawn/replaced-game.json");
    assert.equal(
      readFileSync(join(dir, ".spawn", "replaced-game.json"), "utf8"),
      "{ half an edit"
    );
  });

  it("writes nothing when the caller is not applying game.json", () => {
    const dir = scenario({ base: { title: "old" }, local: { title: "mine" } });
    const summary = syncPulledSpec(dir, { title: "theirs" }, { write: false });
    assert.equal(summary.mode, "skipped");
    assert.deepEqual(readGame(dir), { title: "mine" });
    assert.deepEqual(readBaseGame(dir), { title: "old" }, "the rail must not advance");
  });
});
