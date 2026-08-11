import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quoteArg, renderBrief, worktreeCommand, type BriefInput } from "../src/brief.js";
import type { TeamAgent } from "../src/team.js";

const agent = (label: string, projectDir: string): TeamAgent => ({
  label,
  projectDir,
  variantId: "var_1",
  tokenMask: "sat_abcd…wxyz",
  spawnUser: "pat",
  addedAt: "t",
  lastSeenAt: "t",
});

function brief(overrides: Partial<BriefInput> = {}): string {
  return renderBrief({
    agent: agent("terrain", "/w/terrain"),
    teamSize: 3,
    variantId: "var_1",
    yourClaims: ["world.terrain"],
    othersClaims: [],
    headVersion: 47,
    baseVersion: 47,
    hasKey: true,
    ...overrides,
  });
}

describe("worktreeCommand", () => {
  it("builds the command the agent should run itself", () => {
    assert.equal(worktreeCommand("../game-terrain"), "git worktree add ../game-terrain");
    assert.equal(
      worktreeCommand("../game-terrain", "terrain"),
      "git worktree add -b terrain ../game-terrain"
    );
  });

  it("quotes a path with spaces so the command is paste-safe", () => {
    assert.equal(
      worktreeCommand("C:/My Games/terrain"),
      'git worktree add "C:/My Games/terrain"'
    );
    assert.equal(quoteArg("plain"), "plain");
  });
});

describe("renderBrief", () => {
  it("names the agent, its worktree, and the one-session rule", () => {
    const text = brief();
    assert.match(text, /You are terrain, one of 3 agents/);
    assert.match(text, /Your worktree is \/w\/terrain/);
    assert.match(text, /one session drives one agent/);
  });

  it("leads with setup when the worktree has no key of its own", () => {
    const text = brief({ hasKey: false });
    assert.match(text, /SETUP FIRST/);
    assert.match(text, /spawn_bootstrap/);
    // Must come before the working instructions, not be buried under them.
    assert.ok(text.indexOf("SETUP FIRST") < text.indexOf("How to work:"));
  });

  it("says nothing about setup once the agent has its own key", () => {
    assert.equal(brief().includes("SETUP FIRST"), false);
  });

  it("pushes an unclaimed agent to claim before editing", () => {
    assert.match(brief({ yourClaims: [] }), /Claim your area with spawn_team_claim BEFORE/);
  });

  it("groups other agents' claims by owner", () => {
    const text = brief({
      othersClaims: [
        { pattern: "entities.player", label: "combat" },
        { pattern: "scripts/ai/**", label: "combat" },
        { pattern: "scripts/hud/**", label: "ui" },
      ],
    });
    assert.match(text, /entities\.player, scripts\/ai\/\*\* \(combat\)/);
    assert.match(text, /scripts\/hud\/\*\* \(ui\)/);
    assert.match(text, /Leave those alone/);
  });

  it("tells an agent behind head to pull first", () => {
    assert.match(brief({ baseVersion: 45 }), /Head is v47, your local rail is v45: run spawn_latest/);
  });

  it("says so when the rail already matches head", () => {
    assert.match(brief(), /Head is v47 and your local rail matches it/);
  });

  it("omits the version line entirely when head is unknown", () => {
    const text = brief({ headVersion: null });
    assert.equal(/Head is v/.test(text), false);
    assert.match(text, /How to work:/, "the rest of the brief still stands");
  });

  it("carries the working rules a builder cannot infer", () => {
    const text = brief();
    assert.match(text, /Load the craft BEFORE building/);
    assert.match(text, /spawn_play_screenshot/);
    assert.match(text, /rebase onto head automatically/);
    assert.match(text, /\.theirs receipt/);
  });

  it("handles a team of one without saying 'one of 1 agents'", () => {
    assert.match(brief({ teamSize: 1 }), /one of 1 agent building/);
  });
});
