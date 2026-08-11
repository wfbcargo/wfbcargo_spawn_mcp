/**
 * Text emitted for a builder to start from. Pure on purpose: this is the
 * dispatch affordance, and it hands back a prompt rather than running anything,
 * so ownership of the fleet stays with the LLM instead of moving into this
 * server.
 */
import type { TeamAgent } from "./team.js";

export type BriefInput = {
  agent: TeamAgent;
  teamSize: number;
  variantId: string | null;
  yourClaims: string[];
  othersClaims: Array<{ pattern: string; label: string }>;
  headVersion: number | null;
  baseVersion: number | null;
  hasKey: boolean;
};

/** Shell-quote only when needed, so the common case stays copy-pasteable. */
export function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function worktreeCommand(worktreePath: string, branch?: string): string {
  const target = quoteArg(worktreePath);
  return branch ? `git worktree add -b ${quoteArg(branch)} ${target}` : `git worktree add ${target}`;
}

function groupByLabel(claims: Array<{ pattern: string; label: string }>): string {
  const byLabel = new Map<string, string[]>();
  for (const c of claims) byLabel.set(c.label, [...(byLabel.get(c.label) ?? []), c.pattern]);
  return [...byLabel]
    .map(([label, patterns]) => `${patterns.join(", ")} (${label})`)
    .join("; ");
}

export function renderBrief(input: BriefInput): string {
  const { agent, teamSize, variantId, yourClaims, othersClaims, headVersion, baseVersion, hasKey } =
    input;
  const lines: string[] = [];

  lines.push(
    `You are ${agent.label}, one of ${teamSize} agent${teamSize === 1 ? "" : "s"} building a single Spawn game${variantId ? ` (variant ${variantId})` : ""}.`
  );
  lines.push(
    `Your worktree is ${agent.projectDir}. Work only from a session started there: one session drives one agent, and pushing, applying a pull, and spawn_play_open all bind to the first project directory they touch.`
  );
  lines.push("");

  if (!hasKey) {
    lines.push(
      "SETUP FIRST: this worktree has no SPAWN_AGENT_KEY of its own, so it is not yet a distinct connection. Ask the creator for a fresh one-time sbk_ key (Spawn gear, Build with a coding agent, expires in about 5 minutes) and run spawn_bootstrap here before anything else."
    );
    lines.push("");
  }

  lines.push(
    yourClaims.length
      ? `You own: ${yourClaims.join(", ")}`
      : "You own nothing yet. Claim your area with spawn_team_claim BEFORE you start editing, so teammates get warned off it."
  );
  if (othersClaims.length) {
    lines.push(`Owned by others: ${groupByLabel(othersClaims)}`);
    lines.push("Leave those alone. If you need one, ask for it rather than taking it.");
  }
  lines.push("");

  if (headVersion != null) {
    lines.push(
      baseVersion != null && baseVersion < headVersion
        ? `Head is v${headVersion}, your local rail is v${baseVersion}: run spawn_latest before you start.`
        : `Head is v${headVersion} and your local rail matches it.`
    );
    lines.push("");
  }

  lines.push("How to work:");
  lines.push("- spawn_getting_started, then read .spawn/guide.md and .spawn/tome-api.md.");
  lines.push(
    "- Load the craft BEFORE building, not after it looks wrong: spawn_skill with every domain the work touches, look skills included. Untextured primitives and default DOM are a missing skill, not a missing feature."
  );
  lines.push(
    "- Claim anything else you need with spawn_team_claim before editing it. Claims only warn, so they work by everyone being honest about them."
  );
  lines.push(
    "- Loop: edit, spawn_validate, spawn_push, spawn_play_screenshot, then LOOK at the image. A successful push proves the spec parsed and nothing more."
  );
  lines.push(
    "- Pushes serialise and rebase onto head automatically, so a teammate landing work costs you nothing and a 409 is rare. If a rebase collides, your value is kept and theirs is in the .theirs receipt beside the file: reconcile it, delete the receipt, push again."
  );
  lines.push("- spawn_team_status shows who is where. spawn_savi after meaningful pushes.");

  return lines.join("\n");
}
