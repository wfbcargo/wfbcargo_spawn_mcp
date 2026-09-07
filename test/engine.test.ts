import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DOCUMENT_ERA,
  EngineMismatchError,
  engineSummary,
  gitLaneRedirect,
  isGitLane,
  laneName,
  parseEngineVersion,
  readEngineCache,
  rememberUsername,
  type EngineInfo,
} from "../src/engine.js";
import { loadEnv } from "../src/env.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmpProject(envBody = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-engine-"));
  roots.push(dir);
  if (envBody) writeFileSync(join(dir, ".env"), envBody);
  mkdirSync(join(dir, ".spawn"), { recursive: true });
  return dir;
}

describe("parseEngineVersion", () => {
  it("reads the era names the API uses", () => {
    for (const name of ["document", "Document", " doc ", "pre-6.0", "pre-6"]) {
      assert.deepEqual(parseEngineVersion(name), { era: DOCUMENT_ERA, semver: null });
    }
  });

  it("puts engine 6 and up on the git lane", () => {
    assert.deepEqual(parseEngineVersion("6.0"), { era: "6.0", semver: null });
    assert.deepEqual(parseEngineVersion("6.0.0"), { era: "6.0", semver: "6.0.0" });
    assert.deepEqual(parseEngineVersion("v6.1.2"), { era: "6.1", semver: "6.1.2" });
    assert.deepEqual(parseEngineVersion("7"), { era: "7.0", semver: null });
  });

  it("puts everything below 6 on the document lane", () => {
    assert.equal(parseEngineVersion("5.4").era, DOCUMENT_ERA);
    assert.equal(parseEngineVersion("4.0.1").era, DOCUMENT_ERA);
    assert.equal(parseEngineVersion("1").era, DOCUMENT_ERA);
  });

  it("keeps semver null for a bare era, so a pin never warns about itself", () => {
    // "6.0" is a statement about the lane; "6.0.0" is a claim about the build.
    // Only the second one can disagree with the world.
    assert.equal(parseEngineVersion("6.0").semver, null);
    assert.equal(parseEngineVersion("6.0.0").semver, "6.0.0");
  });

  it("refuses anything that is not a version", () => {
    for (const bad of ["", "  ", "latest", "6.x", "spawn6", "6.0.0-rc1", "../etc"]) {
      assert.throws(() => parseEngineVersion(bad), /engineVersion/);
    }
  });
});

describe("isGitLane", () => {
  it("treats only the document era as the document lane", () => {
    assert.equal(isGitLane(DOCUMENT_ERA), false);
    assert.equal(isGitLane("6.0"), true);
    // A future era must not silently fall back to the dead write path.
    assert.equal(isGitLane("7.0"), true);
    assert.equal(laneName("6.0"), "git lane");
    assert.equal(laneName(DOCUMENT_ERA), "document lane");
  });
});

const gitWorld: EngineInfo = {
  era: "6.0",
  semver: "6.0.0",
  gitUrl: "https://git.spawn.co/@alice/gauntlet.git",
  address: "@alice/gauntlet",
  playUrl: "https://www.spawn.co/@alice/gauntlet",
  codeUrl: "https://www.spawn.co/@alice/gauntlet/code",
  source: "worlds",
  pinned: false,
};

describe("EngineMismatchError", () => {
  it("names both sides and says nothing was written", () => {
    const e = new EngineMismatchError({ era: DOCUMENT_ERA, semver: null }, gitWorld);
    assert.match(e.message, /document lane/);
    assert.match(e.message, /6\.0\.0/);
    assert.match(e.message, /Nothing was written/);
  });
});

describe("engineSummary", () => {
  it("always states the lane, not just the number", () => {
    const summary = engineSummary(gitWorld);
    assert.equal(summary.lane, "git lane");
    assert.equal(summary.era, "6.0");
    assert.equal(summary.gitUrl, gitWorld.gitUrl);
  });

  it("omits the git URL for a document world", () => {
    const summary = engineSummary({ ...gitWorld, era: DOCUMENT_ERA, gitUrl: null });
    assert.equal(summary.lane, "document lane");
    assert.ok(!("gitUrl" in summary));
  });
});

describe("gitLaneRedirect", () => {
  it("carries the clone URL and the next move", () => {
    const text = gitLaneRedirect(gitWorld, "spawn_push's whole-document PUT");
    assert.match(text, /Nothing was written/);
    assert.match(text, /git\.spawn\.co\/@alice\/gauntlet\.git/);
    assert.match(text, /spawn_init/);
    assert.match(text, /spawn_push/);
  });
});

describe("engine cache", () => {
  it("refuses a cache written for a different world", () => {
    const dir = tmpProject("SPAWN_AGENT_KEY=sak_test\nSPAWN_VARIANT_ID=world-a\n");
    const env = loadEnv(dir);
    writeFileSync(
      join(dir, ".spawn", "engine.json"),
      JSON.stringify({ ...gitWorld, variantId: "world-B", apiUrl: env.apiUrl, username: "alice" }),
    );
    assert.equal(readEngineCache(dir, env), null);
  });

  it("survives a corrupt cache file", () => {
    const dir = tmpProject("SPAWN_AGENT_KEY=sak_test\nSPAWN_VARIANT_ID=world-a\n");
    const env = loadEnv(dir);
    writeFileSync(join(dir, ".spawn", "engine.json"), "{not json");
    assert.equal(readEngineCache(dir, env), null);
  });

  it("keeps the username when nothing else is known yet", () => {
    const dir = tmpProject("SPAWN_AGENT_KEY=sak_test\nSPAWN_VARIANT_ID=world-a\n");
    const env = loadEnv(dir);
    // No cache yet: there is nothing to attach a username to, and inventing an
    // era to hold it would be a lie the next resolve would trust.
    rememberUsername(dir, env, "alice");
    assert.equal(readEngineCache(dir, env), null);
  });
});
