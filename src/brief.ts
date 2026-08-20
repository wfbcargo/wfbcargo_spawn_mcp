/**
 * Text emitted for whoever is about to do work — one of our builders
 * (renderBrief) or Savi (renderHandoff). Pure on purpose: these are the dispatch
 * affordances, and they hand back a prompt rather than running anything, so
 * ownership of the fleet stays with the LLM instead of moving into this server.
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
  lines.push(
    "- spawn_team_status shows who is where. spawn_savi after meaningful pushes — and hand Savi anything outside your claim with its task argument, since it fans work out across its own sub-agents without needing a key or a worktree of its own. Pass your claims as keepOff. Nothing reports an author, so its pushes look exactly like a teammate's: pull and look before you build on them."
  );
  lines.push(
    "- spawn_savi_status counts how many of Savi's eight sub-agents are burning right now (the wisps on your play page). Idle lanes there are the cheapest capacity on this build — nobody had to key or check them out — so read a low number as work you should be handing over rather than queueing behind yourself."
  );

  return lines.join("\n");
}

export type HandoffInput = {
  /** What just happened — the context Savi needs regardless of whether work is being handed over. */
  message: string;
  /** The work being delegated. Broad and general beats prescriptive: Savi splits it, not you. */
  task?: string;
  /** Pin the fan-out width. Omitted means "split it if it splits", which is usually what you want. */
  subAgents?: number;
  /** Areas the calling agent owns. Stated, not negotiated — the channel has no reply. */
  keepOff?: string[];
  /** Team label, when there is one. Three builders writing "leave that to me" into one chat are otherwise indistinguishable. */
  label?: string | null;
};

/** True when this input actually hands work over, rather than only reporting. */
export function isHandoff(input: Pick<HandoffInput, "task">): boolean {
  return Boolean(input.task?.trim());
}

/**
 * Compose the studio-chat message. Savi reads this channel and can fan a broad
 * task out across its own sub-agents, so a handoff that names the work and the
 * boundary buys more than a status line does.
 *
 * The channel stays one-way, and that shapes the wording: ownership is declared
 * rather than asked about, and the note says work will be picked up off head,
 * so nothing on either side is written expecting an answer that cannot arrive.
 */
export function renderHandoff(input: HandoffInput): string {
  const { message, task, subAgents, label } = input;
  const keepOff = (input.keepOff ?? []).map((p) => p.trim()).filter(Boolean);
  const blocks: string[] = [message.trim()];
  const who = label ? `${label} here. ` : "";

  if (isHandoff(input)) {
    const ask = [`${who}Please take this on: ${task!.trim()}`];
    ask.push(
      subAgents === 1
        ? "One agent is enough for this — it doesn't split usefully."
        : subAgents
          ? `Run it across ${subAgents} sub-agents in parallel, split by area so they don't collide.`
          : "Fan it out across your sub-agents if it splits cleanly — I'm not blocking on it."
    );
    ask.push("No reply channel back to me, so just push as each piece lands and I'll take it off head.");
    blocks.push(ask.join("\n"));
  }

  if (keepOff.length) {
    const mine = isHandoff(input)
      ? `I'm still working in: ${keepOff.join(", ")}`
      : `${who}Currently mine: ${keepOff.join(", ")}`;
    blocks.push(`${mine}. Leave those to me.`);
  }

  // A blank first block would open the chat message with two empty lines.
  return blocks.filter(Boolean).join("\n\n");
}
