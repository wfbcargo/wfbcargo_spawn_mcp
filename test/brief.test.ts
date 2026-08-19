import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isHandoff,
  quoteArg,
  renderBrief,
  renderHandoff,
  worktreeCommand,
  type BriefInput,
} from "../src/brief.js";
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

describe("renderHandoff", () => {
  it("is just the message when nothing is being handed over", () => {
    assert.equal(renderHandoff({ message: "  Pushed v12: parkour course.  " }), "Pushed v12: parkour course.");
  });

  it("asks Savi to split a task across sub-agents when the width is left open", () => {
    const out = renderHandoff({ message: "Pushed v12.", task: "Give the canyon a night pass." });
    assert.match(out, /Please take this on: Give the canyon a night pass\./);
    assert.match(out, /Fan it out across your sub-agents/);
    assert.match(out, /No reply channel/);
  });

  it("pins the fan-out width when one is given", () => {
    const out = renderHandoff({ message: "Pushed v12.", task: "Night pass.", subAgents: 4 });
    assert.match(out, /Run it across 4 sub-agents in parallel/);
    assert.doesNotMatch(out, /if it splits cleanly/);
  });

  it("asks for NO split when the width is pinned to one", () => {
    const out = renderHandoff({ message: "Pushed v12.", task: "Night pass.", subAgents: 1 });
    assert.match(out, /One agent is enough for this/);
    assert.doesNotMatch(out, /Fan it out/);
  });

  it("ignores a width when there is no task to spend it on", () => {
    assert.equal(renderHandoff({ message: "Pushed v12.", subAgents: 4 }), "Pushed v12.");
  });

  it("states ownership rather than asking, because nothing can answer", () => {
    const out = renderHandoff({
      message: "Pushed v12.",
      task: "Night pass.",
      keepOff: ["scripts/player/**", "world.terrain"],
    });
    assert.match(out, /I'm still working in: scripts\/player\/\*\*, world\.terrain\. Leave those to me\./);
  });

  it("still names your area on a bare status note", () => {
    const out = renderHandoff({ message: "Pushed v12.", keepOff: ["world.terrain"] });
    assert.match(out, /Currently mine: world\.terrain\./);
    assert.doesNotMatch(out, /take this on/);
  });

  it("ignores a blank task instead of emitting an empty ask", () => {
    assert.equal(renderHandoff({ message: "Pushed v12.", task: "   " }), "Pushed v12.");
  });
});

describe("renderHandoff composition", () => {
  // The blank line between blocks versus the single newline inside the ask is
  // what decides whether this reads as a chat message rather than a blob, and
  // partial assert.match cannot see it. Pin the canonical output whole.
  it("lays the canonical handoff out exactly", () => {
    assert.equal(
      renderHandoff({
        message: "Pushed v12: parkour course in the north canyon.",
        task: "Give the canyon a night pass.",
        subAgents: 4,
        keepOff: ["scripts/player/**", "world.terrain"],
        label: "terrain",
      }),
      [
        "Pushed v12: parkour course in the north canyon.",
        "",
        "terrain here. Please take this on: Give the canyon a night pass.",
        "Run it across 4 sub-agents in parallel, split by area so they don't collide.",
        "No reply channel back to me, so just push as each piece lands and I'll take it off head.",
        "",
        "I'm still working in: scripts/player/**, world.terrain. Leave those to me.",
      ].join("\n")
    );
  });

  it("names the sender on a bare status note too, so keepOff is attributable", () => {
    assert.equal(
      renderHandoff({ message: "Pushed v12.", keepOff: ["world.terrain"], label: "terrain" }),
      "Pushed v12.\n\nterrain here. Currently mine: world.terrain. Leave those to me."
    );
  });

  it("stays anonymous when there is no team label", () => {
    const out = renderHandoff({ message: "Pushed v12.", task: "Night pass." });
    assert.match(out, /^Pushed v12\.\n\nPlease take this on:/);
  });

  it("never opens with a blank block when the message is empty", () => {
    const out = renderHandoff({ message: "   ", task: "Night pass." });
    assert.doesNotMatch(out, /^\s/);
    assert.match(out, /^Please take this on:/);
  });

  it("drops blank keepOff patterns rather than rendering them", () => {
    assert.equal(renderHandoff({ message: "Pushed v12.", keepOff: ["", "  "] }), "Pushed v12.");
    assert.equal(renderHandoff({ message: "Pushed v12.", keepOff: [] }), "Pushed v12.");
    assert.match(
      renderHandoff({ message: "Pushed v12.", keepOff: ["  world.terrain  "] }),
      /Currently mine: world\.terrain\./
    );
  });
});

describe("isHandoff", () => {
  // The tool's result note gates on this too. When it disagreed with
  // renderHandoff, a whitespace task reported work in flight that was never
  // sent — and the guidance tells the model not to go looking.
  it("agrees with what renderHandoff actually composed", () => {
    for (const task of [undefined, "", "   ", "\n\t"]) {
      assert.equal(isHandoff({ task }), false, `expected no handoff for ${JSON.stringify(task)}`);
      assert.doesNotMatch(renderHandoff({ message: "m", task }), /take this on/);
    }
    assert.equal(isHandoff({ task: "Night pass." }), true);
    assert.match(renderHandoff({ message: "m", task: "Night pass." }), /take this on/);
  });
});

describe("renderBrief and Savi", () => {
  it("tells a builder Savi is capacity, and that its pushes are unattributable", () => {
    const out = brief();
    assert.match(out, /hand Savi anything outside your claim with its task argument/);
    assert.match(out, /Pass your claims as keepOff/);
    assert.match(out, /pull and look before you build on them/);
  });
});
