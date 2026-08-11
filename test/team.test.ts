import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { resolveProjectDir } from "../src/env.js";
import {
  findLabelOwner,
  initTeamMode,
  isTeamMode,
  latchProject,
  latchedProject,
  readRoster,
  resolveGitCommonDir,
  resolveLedgerDir,
  setTeamModeForTests,
  upsertAgent,
  withLedgerLock,
  writeRoster,
  type Roster,
} from "../src/team.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-team-"));
  roots.push(dir);
  return dir;
}

/** A main checkout with `.git` as a real directory. */
function mainCheckout(): string {
  const root = tmpRoot();
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

/** A linked worktree: `.git` is a pointer file, and the gitdir holds `commondir`. */
function linkedWorktree(main: string, name: string): string {
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  const tree = join(tmpRoot(), name);
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, ".git"), `gitdir: ${gitDir}\n`);
  return tree;
}

const emptyRoster = (): Roster => ({ version: 1, agents: [] });

beforeEach(() => {
  delete process.env.SPAWN_TEAM;
  delete process.env.SPAWN_TEAM_DIR;
  delete process.env.SPAWN_PROJECT_DIR;
  setTeamModeForTests(false);
});

describe("resolveGitCommonDir", () => {
  it("finds .git in a main checkout", () => {
    const root = mainCheckout();
    assert.equal(resolveGitCommonDir(root), join(root, ".git"));
  });

  it("walks up from a nested directory", () => {
    const root = mainCheckout();
    const nested = join(root, "world", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveGitCommonDir(nested), join(root, ".git"));
  });

  it("follows a worktree pointer back to the shared .git", () => {
    const main = mainCheckout();
    const tree = linkedWorktree(main, "terrain");
    assert.equal(resolveGitCommonDir(tree), resolve(join(main, ".git")));
  });

  it("falls back to the gitdir when there is no commondir (submodule shape)", () => {
    const main = mainCheckout();
    const gitDir = join(main, ".git", "modules", "sub");
    mkdirSync(gitDir, { recursive: true });
    const tree = join(tmpRoot(), "sub");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${gitDir}\n`);
    assert.equal(resolveGitCommonDir(tree), gitDir);
  });

  it("returns null outside a repository", () => {
    assert.equal(resolveGitCommonDir(tmpRoot()), null);
  });
});

describe("resolveLedgerDir", () => {
  it("puts the ledger inside the shared .git so every worktree agrees", () => {
    const main = mainCheckout();
    const tree = linkedWorktree(main, "combat");
    assert.equal(resolveLedgerDir(main), join(main, ".git", "spawn-team"));
    assert.equal(resolveLedgerDir(tree), resolve(join(main, ".git", "spawn-team")));
  });

  it("lets SPAWN_TEAM_DIR override, for projects outside one repo", () => {
    const shared = tmpRoot();
    process.env.SPAWN_TEAM_DIR = shared;
    assert.equal(resolveLedgerDir(mainCheckout()), resolve(shared));
  });

  it("has no location outside a repo and without an override", () => {
    assert.equal(resolveLedgerDir(tmpRoot()), null);
  });
});

describe("initTeamMode", () => {
  it("stays off for a solo project", () => {
    process.env.SPAWN_PROJECT_DIR = mainCheckout();
    assert.equal(initTeamMode().enabled, false);
    assert.equal(isTeamMode(), false);
  });

  it("turns on with SPAWN_TEAM=1 before any ledger exists", () => {
    process.env.SPAWN_TEAM = "1";
    process.env.SPAWN_PROJECT_DIR = mainCheckout();
    const boot = initTeamMode();
    assert.equal(boot.enabled, true);
    assert.match(boot.reason, /no ledger yet/);
  });

  it("turns on for a later session purely because the ledger exists", () => {
    const main = mainCheckout();
    const ledger = join(main, ".git", "spawn-team");
    writeRoster(ledger, upsertAgent(emptyRoster(), { label: "a", projectDir: main }, "now"));
    process.env.SPAWN_PROJECT_DIR = main;
    const boot = initTeamMode();
    assert.equal(boot.enabled, true, "builders need no extra config once the team exists");
    assert.match(boot.reason, /joined the team ledger/);
  });
});

describe("resolveProjectDir under team mode", () => {
  it("refuses a globally pinned SPAWN_PROJECT_DIR", () => {
    process.env.SPAWN_PROJECT_DIR = "/somewhere/pinned";
    setTeamModeForTests(true);
    assert.throws(() => resolveProjectDir(), /SPAWN_PROJECT_DIR is set/);
  });

  it("explains why, rather than only refusing", () => {
    process.env.SPAWN_PROJECT_DIR = "/somewhere/pinned";
    setTeamModeForTests(true);
    const message = (() => {
      try {
        resolveProjectDir();
        return "";
      } catch (e: any) {
        return e.message as string;
      }
    })();
    assert.match(message, /identity comes from its project directory's \.env/);
    assert.match(message, /silently overwrite each other/);
    assert.match(message, /Fix either way/);
  });

  it("never refuses an explicit projectDir, which is unambiguous", () => {
    process.env.SPAWN_PROJECT_DIR = "/somewhere/pinned";
    setTeamModeForTests(true);
    assert.equal(resolveProjectDir("/explicit/dir"), resolve("/explicit/dir"));
  });

  it("still honours SPAWN_PROJECT_DIR when team mode is off", () => {
    const dir = tmpRoot();
    process.env.SPAWN_PROJECT_DIR = dir;
    assert.equal(resolveProjectDir(), resolve(dir));
  });
});

describe("session latch", () => {
  it("does nothing at all in solo mode", () => {
    latchProject("/a", "spawn_push");
    latchProject("/b", "spawn_push");
    assert.equal(latchedProject(), null);
  });

  it("binds to the first project and allows it again", () => {
    setTeamModeForTests(true);
    latchProject("/a", "spawn_push");
    latchProject("/a", "spawn_play_open");
    assert.equal(latchedProject(), "/a");
  });

  it("refuses a second project, naming both and the reason", () => {
    setTeamModeForTests(true);
    latchProject("/a", "spawn_push");
    assert.throws(() => latchProject("/b", "spawn_play_open"), (e: Error) => {
      assert.match(e.message, /already acting as the agent in \/a/);
      assert.match(e.message, /spawn_play_open targets \/b/);
      assert.match(e.message, /One session drives one agent/);
      return true;
    });
  });
});

describe("roster", () => {
  it("keys on the project dir, so a relabel renames in place", () => {
    let roster = upsertAgent(emptyRoster(), { label: "old", projectDir: "/w/one" }, "t1");
    roster = upsertAgent(roster, { label: "new", projectDir: "/w/one" }, "t2");
    assert.equal(roster.agents.length, 1);
    assert.equal(roster.agents[0].label, "new");
    assert.equal(roster.agents[0].addedAt, "t1", "addedAt survives a relabel");
    assert.equal(roster.agents[0].lastSeenAt, "t2");
  });

  it("carries known fields forward when a later call omits them", () => {
    let roster = upsertAgent(
      emptyRoster(),
      { label: "a", projectDir: "/w/one", variantId: "var_1", spawnUser: "pat" },
      "t1"
    );
    roster = upsertAgent(roster, { label: "a", projectDir: "/w/one" }, "t2");
    assert.equal(roster.agents[0].variantId, "var_1");
    assert.equal(roster.agents[0].spawnUser, "pat");
  });

  it("flags a label another worktree already holds", () => {
    const roster = upsertAgent(emptyRoster(), { label: "terrain", projectDir: "/w/one" }, "t1");
    assert.equal(findLabelOwner(roster, "TERRAIN", "/w/two")?.projectDir, resolve("/w/one"));
    assert.equal(findLabelOwner(roster, "terrain", "/w/one"), null, "your own label is not a clash");
    assert.equal(findLabelOwner(roster, "combat", "/w/two"), null);
  });

  it("round-trips through disk and degrades to empty on a corrupt file", () => {
    const ledger = join(tmpRoot(), "spawn-team");
    writeRoster(ledger, upsertAgent(emptyRoster(), { label: "a", projectDir: "/w/one" }, "t1"));
    assert.equal(readRoster(ledger).agents.length, 1);
    writeFileSync(join(ledger, "roster.json"), "{ truncated");
    assert.deepEqual(readRoster(ledger), { version: 1, agents: [] });
  });

  it("returns an empty roster when the ledger does not exist yet", () => {
    assert.deepEqual(readRoster(join(tmpRoot(), "nope")), { version: 1, agents: [] });
  });
});

describe("withLedgerLock", () => {
  it("serialises concurrent read-modify-writes so no agent is lost", async () => {
    const ledger = join(tmpRoot(), "spawn-team");
    const labels = ["terrain", "combat", "ui", "audio"];
    await Promise.all(
      labels.map((label, i) =>
        withLedgerLock(ledger, () => {
          const roster = readRoster(ledger);
          writeRoster(ledger, upsertAgent(roster, { label, projectDir: `/w/${i}` }, "t"));
        })
      )
    );
    assert.deepEqual(
      readRoster(ledger).agents.map((a) => a.label).sort(),
      [...labels].sort(),
      "a lost update would drop an agent from the roster"
    );
  });

  it("releases the lock when the body throws", async () => {
    const ledger = join(tmpRoot(), "spawn-team");
    await assert.rejects(
      withLedgerLock(ledger, () => {
        throw new Error("boom");
      })
    );
    // A wedged lock would make this hang until the stale window instead.
    assert.equal(await withLedgerLock(ledger, () => "recovered"), "recovered");
  });
});
