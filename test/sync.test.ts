import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  listConflictReceipts,
  readBaseVersion,
  syncPulledScripts,
  writeBaseScripts,
  writeBaseVersion,
} from "../src/compile.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project at base-version 1 with a known base-scripts rail. */
function scenario(opts: {
  base?: Record<string, string>;
  local?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-sync-"));
  roots.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeBaseVersion(dir, 1);
  writeBaseScripts(dir, opts.base ?? {});
  for (const [rel, body] of Object.entries(opts.local ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const spec = (scripts: Record<string, string>) => ({ scripts });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

describe("syncPulledScripts", () => {
  it("writes brand-new upstream scripts to disk", () => {
    const dir = scenario({ base: {}, local: {} });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/new.js": "theirs" }), 2);
    assert.deepEqual(summary.created, ["scripts/new.js"]);
    assert.equal(read(dir, "scripts/new.js"), "theirs");
    assert.equal(summary.conflicts.length, 0);
  });

  it("fast-forwards a file the user has not touched", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: { "scripts/a.js": "v1" } });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "v2" }), 2);
    assert.deepEqual(summary.fastForwarded, ["scripts/a.js"]);
    assert.equal(read(dir, "scripts/a.js"), "v2");
  });

  it("leaves local-only edits alone when upstream did not move", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: { "scripts/a.js": "mine" } });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "v1" }), 2);
    assert.deepEqual(summary, { created: [], fastForwarded: [], deleted: [], conflicts: [] });
    assert.equal(read(dir, "scripts/a.js"), "mine");
  });

  it("writes a .theirs receipt when both sides changed", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: { "scripts/a.js": "mine" } });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "theirs" }), 2);
    assert.deepEqual(summary.conflicts, [{ path: "scripts/a.js", kind: "edit" }]);
    assert.equal(read(dir, "scripts/a.js"), "mine", "local file must not be clobbered");
    assert.equal(read(dir, "scripts/a.js.theirs"), "theirs");
    assert.deepEqual(
      listConflictReceipts(dir).map((p) => p.endsWith("a.js.theirs")),
      [true]
    );
  });

  it("is a no-op when both sides made the same edit", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: { "scripts/a.js": "same" } });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "same" }), 2);
    assert.deepEqual(summary.conflicts, []);
    assert.equal(existsSync(join(dir, "scripts/a.js.theirs")), false);
  });

  it("deletes a local file that upstream removed and the user never touched", () => {
    const dir = scenario({ base: { "scripts/gone.js": "v1" }, local: { "scripts/gone.js": "v1" } });
    const { summary } = syncPulledScripts(dir, spec({}), 2);
    assert.deepEqual(summary.deleted, ["scripts/gone.js"]);
    assert.equal(existsSync(join(dir, "scripts/gone.js")), false);
  });

  it("keeps a locally-edited file that upstream deleted, with a receipt", () => {
    const dir = scenario({ base: { "scripts/gone.js": "v1" }, local: { "scripts/gone.js": "mine" } });
    const { summary } = syncPulledScripts(dir, spec({}), 2);
    assert.deepEqual(summary.conflicts, [{ path: "scripts/gone.js", kind: "delete" }]);
    assert.equal(read(dir, "scripts/gone.js"), "mine");
    assert.match(read(dir, "scripts/gone.js.theirs"), /DELETED upstream \(v2\)/);
  });

  it("respects a local delete when upstream did not change the file", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: {} });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "v1" }), 2);
    assert.deepEqual(summary.created, []);
    assert.equal(existsSync(join(dir, "scripts/a.js")), false, "must not resurrect a deleted file");
  });

  it("flags a receipt when upstream changed a file the user deleted", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: {} });
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "v2" }), 2);
    assert.deepEqual(summary.conflicts, [{ path: "scripts/a.js", kind: "resurrect" }]);
    assert.equal(existsSync(join(dir, "scripts/a.js")), false);
    assert.match(read(dir, "scripts/a.js.theirs"), /CHANGED upstream/);
  });

  it("advances the base rail to the pulled scripts", () => {
    const dir = scenario({ base: { "scripts/a.js": "v1" }, local: { "scripts/a.js": "v1" } });
    syncPulledScripts(dir, spec({ "scripts/a.js": "v2", "scripts/b.js": "new" }), 2);
    // A second identical pull must now be a clean no-op.
    const { summary } = syncPulledScripts(dir, spec({ "scripts/a.js": "v2", "scripts/b.js": "new" }), 2);
    assert.deepEqual(summary, { created: [], fastForwarded: [], deleted: [], conflicts: [] });
  });
});

describe("base-version rail", () => {
  it("round-trips and rejects junk", () => {
    const dir = scenario({});
    writeBaseVersion(dir, 7);
    assert.equal(readBaseVersion(dir), 7);
    writeFileSync(join(dir, ".spawn", "base-version"), "not-a-number");
    assert.equal(readBaseVersion(dir), null);
  });

  it("returns null when absent, so push refuses to blind-replace", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-rail-"));
    roots.push(dir);
    assert.equal(readBaseVersion(dir), null);
  });
});
