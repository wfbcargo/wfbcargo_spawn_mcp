import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { changedScriptPaths, changedSpecPaths } from "../src/compile.js";
import {
  addClaim,
  appendPush,
  classifyPattern,
  findClaimOwner,
  findPushByVersion,
  matchesScriptClaim,
  matchesSpecClaim,
  readClaims,
  readPushes,
  removeClaims,
  writeClaims,
  type Claim,
  type Claims,
} from "../src/team.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmpLedger = () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-claims-"));
  roots.push(dir);
  return dir;
};

const claim = (label: string, pattern: string, kind: "script" | "spec"): Claim => ({
  label,
  pattern,
  kind,
  claimedAt: "t",
});
const claimsOf = (...cs: Claim[]): Claims => ({ version: 1, claims: cs });

describe("classifyPattern", () => {
  it("treats scripts/ patterns as file globs and everything else as key paths", () => {
    assert.deepEqual(classifyPattern("scripts/terrain/**"), { kind: "script" });
    assert.deepEqual(classifyPattern("entities.player"), { kind: "spec" });
  });

  it("rejects a path outside scripts/, which would silently never match", () => {
    const result = classifyPattern("world/terrain.json");
    assert.ok("error" in result);
    assert.match(result.error, /Only scripts\/\*\* are files/);
    assert.match(result.error, /dotted game\.json key path/);
  });

  it("points 'scripts' at the glob that actually works", () => {
    const result = classifyPattern("scripts");
    assert.ok("error" in result);
    assert.match(result.error, /scripts\/\*\*/);
  });

  it("rejects wildcards in a key path", () => {
    assert.ok("error" in classifyPattern("entities.*"));
  });
});

describe("script glob matching", () => {
  it("crosses directories for ** but not for *", () => {
    assert.equal(matchesScriptClaim("scripts/terrain/**", "scripts/terrain/deep/a.js"), true);
    assert.equal(matchesScriptClaim("scripts/*.js", "scripts/hud.js"), true);
    assert.equal(matchesScriptClaim("scripts/*.js", "scripts/ui/hud.js"), false);
  });

  it("treats a wildcard-free pattern as the file or the directory under it", () => {
    assert.equal(matchesScriptClaim("scripts/hud.js", "scripts/hud.js"), true);
    assert.equal(matchesScriptClaim("scripts/hud.js", "scripts/hud.json"), false);
    assert.equal(matchesScriptClaim("scripts/terrain", "scripts/terrain/a.js"), true);
    assert.equal(matchesScriptClaim("scripts/terrain", "scripts/terrain2/a.js"), false);
  });

  it("does not let a dot in the pattern act as a regex wildcard", () => {
    assert.equal(matchesScriptClaim("scripts/a.js", "scripts/axjs"), false);
  });
});

describe("spec key path matching", () => {
  it("covers everything under the claimed path", () => {
    assert.equal(matchesSpecClaim("entities.player", "entities.player.hp"), true);
    assert.equal(matchesSpecClaim("entities.player", "entities.player"), true);
  });

  it("also collides when the change is broader than the claim", () => {
    assert.equal(matchesSpecClaim("entities.player.hp", "entities"), true);
  });

  it("does not match a sibling with a shared prefix", () => {
    assert.equal(matchesSpecClaim("entities.player", "entities.playerTwo"), false);
    assert.equal(matchesSpecClaim("world.sky", "world.ground"), false);
  });
});

describe("claims ledger", () => {
  it("re-claiming a pattern moves it rather than duplicating it", () => {
    let claims = claimsOf(claim("terrain", "world.sky", "spec"));
    claims = addClaim(claims, claim("combat", "world.sky", "spec"));
    assert.equal(claims.claims.length, 1);
    assert.equal(claims.claims[0].label, "combat");
  });

  it("releases only the calling agent's claims", () => {
    const claims = claimsOf(
      claim("terrain", "world.sky", "spec"),
      claim("combat", "entities.enemy", "spec")
    );
    const { claims: after, removed } = removeClaims(claims, "terrain");
    assert.deepEqual(removed.map((c) => c.pattern), ["world.sky"]);
    assert.deepEqual(after.claims.map((c) => c.label), ["combat"]);
  });

  it("releases a named subset", () => {
    const claims = claimsOf(
      claim("terrain", "world.sky", "spec"),
      claim("terrain", "world.ground", "spec")
    );
    const { removed } = removeClaims(claims, "terrain", ["world.sky"]);
    assert.deepEqual(removed.map((c) => c.pattern), ["world.sky"]);
  });

  it("round-trips through disk and degrades to empty on a corrupt file", () => {
    const dir = tmpLedger();
    writeClaims(dir, claimsOf(claim("terrain", "world.sky", "spec")));
    assert.equal(readClaims(dir).claims.length, 1);
    writeFileSync(join(dir, "claims.json"), "{ truncated");
    assert.deepEqual(readClaims(dir).claims, [], "claims are advisory, so a broken file must not block work");
  });

  it("finds the owner of a changed path by kind", () => {
    const claims = claimsOf(
      claim("terrain", "world.terrain", "spec"),
      claim("ui", "scripts/hud/**", "script")
    );
    assert.equal(findClaimOwner(claims, "spec", "world.terrain.height")?.label, "terrain");
    assert.equal(findClaimOwner(claims, "script", "scripts/hud/bar.js")?.label, "ui");
    assert.equal(findClaimOwner(claims, "spec", "scripts/hud/bar.js"), null, "kinds must not cross");
    assert.equal(findClaimOwner(claims, "spec", "world.sky"), null);
  });
});

describe("changed paths", () => {
  it("reports the narrowest key that moved", () => {
    assert.deepEqual(
      changedSpecPaths({ world: { sky: "blue", fog: 1 } }, { world: { sky: "red", fog: 1 } }),
      ["world.sky"]
    );
  });

  it("reports added and removed keys", () => {
    assert.deepEqual(changedSpecPaths({ a: 1 }, { a: 1, b: 2 }), ["b"]);
    assert.deepEqual(changedSpecPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
  });

  it("is empty for an identical spec", () => {
    assert.deepEqual(changedSpecPaths({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), []);
  });

  it("ignores scripts, which have their own rail", () => {
    assert.deepEqual(
      changedSpecPaths({ a: 1, scripts: { "scripts/x.js": "old" } }, { a: 1, scripts: { "scripts/x.js": "new" } }),
      []
    );
  });

  it("lists script files whose content moved", () => {
    assert.deepEqual(
      changedScriptPaths({ "scripts/a.js": "v1", "scripts/b.js": "v1" }, { "scripts/a.js": "v2", "scripts/b.js": "v1" }),
      ["scripts/a.js"]
    );
    assert.deepEqual(changedScriptPaths(null, { "scripts/new.js": "x" }), ["scripts/new.js"]);
    assert.deepEqual(changedScriptPaths({ "scripts/gone.js": "x" }, {}), ["scripts/gone.js"]);
  });
});

describe("push log", () => {
  it("attributes a version to the agent that pushed it", () => {
    const dir = tmpLedger();
    appendPush(dir, { ts: "t1", label: "terrain", version: 46, specPaths: ["world.terrain"], scripts: [] });
    appendPush(dir, { ts: "t2", label: "combat", version: 47, specPaths: [], scripts: ["scripts/ai.js"] });
    assert.equal(findPushByVersion(dir, 46)?.label, "terrain");
    assert.equal(findPushByVersion(dir, 47)?.label, "combat");
    assert.equal(findPushByVersion(dir, 99), null);
  });

  it("survives a torn line rather than losing the whole log", () => {
    const dir = tmpLedger();
    appendPush(dir, { ts: "t1", label: "terrain", version: 46, specPaths: [], scripts: [] });
    writeFileSync(join(dir, "pushes.jsonl"), '{"ts":"t1","label":"terrain","version":46,"specPaths":[],"scripts":[]}\n{ torn\n', { flag: "w" });
    appendPush(dir, { ts: "t2", label: "combat", version: 47, specPaths: [], scripts: [] });
    assert.deepEqual(readPushes(dir).map((p) => p.version), [46, 47]);
  });

  it("returns the most recent entries when limited", () => {
    const dir = tmpLedger();
    for (let v = 1; v <= 30; v++) {
      appendPush(dir, { ts: `t${v}`, label: "a", version: v, specPaths: [], scripts: [] });
    }
    const recent = readPushes(dir, 5);
    assert.deepEqual(recent.map((p) => p.version), [26, 27, 28, 29, 30]);
    assert.equal(readPushes(dir, 0).length, 30, "limit 0 means everything, for version lookup");
  });

  it("has no log at all before the first push", () => {
    assert.deepEqual(readPushes(tmpLedger()), []);
  });
});
