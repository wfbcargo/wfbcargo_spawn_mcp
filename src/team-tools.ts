import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { api, apiError, latestPath } from "./client.js";
import { listConflictReceipts, readBaseVersion } from "./compile.js";
import { loadEnv, maskToken, resolveProjectDir } from "./env.js";
import {
  addClaim,
  agentFor,
  classifyPattern,
  findLabelOwner,
  latchedProject,
  readClaims,
  readPushes,
  readRoster,
  removeClaims,
  resolveLedgerDir,
  upsertAgent,
  withLedgerLock,
  writeClaims,
  writeRoster,
  type Claim,
  type TeamAgent,
} from "./team.js";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const projectDirSchema = z
  .string()
  .optional()
  .describe("Absolute path to this agent's worktree. Defaults to the MCP process cwd.");

function ledgerOrError(dir: string): { ledgerDir: string } | { error: string } {
  const ledgerDir = resolveLedgerDir(dir);
  if (!ledgerDir) {
    return {
      error:
        `No team ledger location for ${dir}: it is not inside a git repository, and SPAWN_TEAM_DIR is not set.\n` +
        "Team mode keys off the shared .git so every worktree finds the same ledger with no configuration. " +
        "Either run the agents from worktrees of one repo, or set SPAWN_TEAM_DIR to a directory they all share.",
    };
  }
  return { ledgerDir };
}

export function registerTeamTools(server: McpServer): void {
  server.registerTool(
    "spawn_team_init",
    {
      description:
        "Create the team ledger if it does not exist and register THIS worktree in it under a label. Run once per agent, from that agent's own worktree. The ledger lives in the shared .git, so every worktree of the repo finds it with no config. Each agent still needs its own bootstrap key and its own .env — this only records who is who.",
      inputSchema: {
        label: z
          .string()
          .min(1)
          .max(40)
          .describe("Short distinct name for this agent, e.g. terrain-agent. Must match its bootstrap name."),
        projectDir: projectDirSchema,
      },
    },
    async ({ label, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const located = ledgerOrError(dir);
      if ("error" in located) return err(located.error);
      const { ledgerDir } = located;

      const env = loadEnv(dir);
      let spawnUser: string | null = null;
      if (env.agentKey) {
        try {
          const me = await api(env, "GET", "/api/agent/v1/me");
          if (me.status === 200) spawnUser = me.json?.username ?? null;
        } catch {
          /* whoami is a nicety; never fail registration on it */
        }
      }

      const result = await withLedgerLock(ledgerDir, () => {
        const roster = readRoster(ledgerDir);
        const clash = findLabelOwner(roster, label, dir);
        if (clash) return { conflict: clash, roster };
        const next = upsertAgent(
          roster,
          {
            label,
            projectDir: dir,
            variantId: env.variantId || null,
            tokenMask: env.agentKey ? maskToken(env.agentKey) : null,
            spawnUser,
          },
          new Date().toISOString()
        );
        writeRoster(ledgerDir, next);
        return { conflict: null as TeamAgent | null, roster: next };
      });

      if (result.conflict) {
        return err(
          `Label "${label}" already belongs to ${result.conflict.projectDir}. Labels are how a human tells two agents apart, so pick a different one.`
        );
      }

      const others = result.roster.agents.filter((a) => a.projectDir !== dir);
      const warnings: string[] = [];
      if (!env.agentKey) {
        warnings.push(
          "This worktree has no SPAWN_AGENT_KEY yet — run spawn_bootstrap here with its own one-time key, or it will have no identity of its own."
        );
      }
      if (env.sources.agentKey === "process") {
        warnings.push(
          "This worktree's key came from the MCP config, not its own .env, so it is not a distinct connection. Bootstrap it here."
        );
      }
      const variantMismatch = others.filter(
        (a) => a.variantId && env.variantId && a.variantId !== env.variantId
      );
      if (variantMismatch.length) {
        warnings.push(
          `Different SPAWN_VARIANT_ID than ${variantMismatch.map((a) => a.label).join(", ")}. A team builds ONE game: every agent needs the same variant.`
        );
      }

      return text({
        ok: true,
        ledgerDir,
        you: { label, projectDir: dir },
        teamSize: result.roster.agents.length,
        others: others.map((a) => ({ label: a.label, projectDir: a.projectDir })),
        ...(warnings.length ? { warnings } : {}),
        next:
          "spawn_team_status shows the whole team. Partition the work by script file and game.json key path so pulls stay conflict-free.",
      });
    }
  );

  server.registerTool(
    "spawn_team_claim",
    {
      description:
        "Claim the parts of the game this agent owns, so teammates are warned before they edit them. Two shapes: a dotted game.json key path ('entities.player', 'world.terrain') or a script glob under scripts/ ('scripts/terrain/**', 'scripts/hud.js'). Claims are ADVISORY — they warn on push, they never block one — and claiming early is what keeps pulls conflict-free. Re-claiming a pattern moves it to the new owner.",
      inputSchema: {
        patterns: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Key paths and/or script globs to claim. Everything except scripts/** is claimed by game.json key path, because that is where the whole spec lives."
          ),
        note: z.string().max(200).optional().describe("What you are building there"),
        projectDir: projectDirSchema,
      },
    },
    async ({ patterns, note, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const located = ledgerOrError(dir);
      if ("error" in located) return err(located.error);
      const { ledgerDir } = located;

      const me = agentFor(readRoster(ledgerDir), dir);
      if (!me) {
        return err(
          `${dir} is not registered in the team ledger. Run spawn_team_init here first — a claim needs a label to belong to.`
        );
      }

      const rejected: string[] = [];
      const accepted: Claim[] = [];
      const now = new Date().toISOString();
      for (const raw of patterns) {
        const pattern = raw.trim();
        const kind = classifyPattern(pattern);
        if ("error" in kind) {
          rejected.push(`${pattern}: ${kind.error}`);
          continue;
        }
        accepted.push({ label: me.label, pattern, kind: kind.kind, claimedAt: now, ...(note ? { note } : {}) });
      }
      if (!accepted.length) {
        return err(`No pattern could be claimed.\n${rejected.map((r) => `  ${r}`).join("\n")}`);
      }

      const result = await withLedgerLock(ledgerDir, () => {
        let claims = readClaims(ledgerDir);
        const takenFrom: string[] = [];
        for (const claim of accepted) {
          const previous = claims.claims.find((c) => c.pattern === claim.pattern);
          if (previous && previous.label !== me.label) {
            takenFrom.push(`${claim.pattern} (was ${previous.label})`);
          }
          claims = addClaim(claims, claim);
        }
        writeClaims(ledgerDir, claims);
        return { claims, takenFrom };
      });

      const mine = result.claims.claims.filter((c) => c.label === me.label);
      const others = result.claims.claims.filter((c) => c.label !== me.label);
      return text({
        ok: true,
        label: me.label,
        claimed: accepted.map((c) => ({ pattern: c.pattern, kind: c.kind })),
        ...(rejected.length ? { rejected } : {}),
        ...(result.takenFrom.length ? { tookOver: result.takenFrom } : {}),
        yourClaims: mine.map((c) => c.pattern),
        claimedByOthers: others.map((c) => ({ pattern: c.pattern, label: c.label })),
        note: "Advisory only. spawn_push warns when your changes touch someone else's claim; it never refuses.",
      });
    }
  );

  server.registerTool(
    "spawn_team_release",
    {
      description:
        "Release this agent's claims when it is done with an area, so a teammate can take it over without a stale warning. Omit patterns to release everything this agent holds.",
      inputSchema: {
        patterns: z
          .array(z.string().min(1))
          .optional()
          .describe("Specific patterns to release. Omit to release all of this agent's claims."),
        projectDir: projectDirSchema,
      },
    },
    async ({ patterns, projectDir }) => {
      const dir = resolveProjectDir(projectDir);
      const located = ledgerOrError(dir);
      if ("error" in located) return err(located.error);
      const { ledgerDir } = located;

      const me = agentFor(readRoster(ledgerDir), dir);
      if (!me) return err(`${dir} is not registered in the team ledger. Run spawn_team_init here first.`);

      const result = await withLedgerLock(ledgerDir, () => {
        const { claims, removed } = removeClaims(
          readClaims(ledgerDir),
          me.label,
          patterns?.map((p) => p.trim())
        );
        if (removed.length) writeClaims(ledgerDir, claims);
        return { claims, removed };
      });

      return text({
        ok: true,
        label: me.label,
        released: result.removed.map((c) => c.pattern),
        remaining: result.claims.claims.filter((c) => c.label === me.label).map((c) => c.pattern),
        ...(result.removed.length
          ? {}
          : { note: "Nothing matched — this agent held no such claim." }),
      });
    }
  );

  server.registerTool(
    "spawn_team_status",
    {
      description:
        "The whole team at a glance: every registered agent, how far behind head each one's local rail is, whose worktree has unresolved conflict receipts, and the current head vs published versions. Read-only and safe to call from any worktree. Use it before pushing to see whether a teammate has moved head under you.",
      inputSchema: {
        projectDir: projectDirSchema,
        remote: z
          .boolean()
          .default(true)
          .describe("Also fetch head + published versions using THIS worktree's credentials"),
      },
    },
    async ({ projectDir, remote }) => {
      const dir = resolveProjectDir(projectDir);
      const located = ledgerOrError(dir);
      if ("error" in located) return err(located.error);
      const { ledgerDir } = located;

      const roster = readRoster(ledgerDir);
      if (!roster.agents.length) {
        return err(
          `No agents registered at ${ledgerDir}. Run spawn_team_init in each agent's worktree first.`
        );
      }

      const agents = roster.agents.map((agent: TeamAgent) => {
        const present = existsSync(agent.projectDir);
        return {
          label: agent.label,
          projectDir: agent.projectDir,
          isYou: agent.projectDir === dir,
          spawnUser: agent.spawnUser,
          tokenMask: agent.tokenMask,
          variantId: agent.variantId,
          worktreeExists: present,
          baseVersion: present ? readBaseVersion(agent.projectDir) : null,
          unresolvedReceipts: present
            ? listConflictReceipts(agent.projectDir).map((r) => relative(agent.projectDir, r))
            : [],
          hasEnv: present ? existsSync(join(agent.projectDir, ".env")) : false,
          lastSeenAt: agent.lastSeenAt,
        };
      });

      const claims = readClaims(ledgerDir);
      const myLabel = agents.find((a) => a.isYou)?.label ?? null;
      const status: Record<string, unknown> = {
        ledgerDir,
        you: {
          projectDir: dir,
          label: myLabel,
          latchedTo: latchedProject(),
          claims: claims.claims.filter((c) => c.label === myLabel).map((c) => c.pattern),
        },
        agents,
        claims: claims.claims.map((c) => ({
          pattern: c.pattern,
          kind: c.kind,
          label: c.label,
          ...(c.note ? { note: c.note } : {}),
        })),
        unclaimed:
          claims.claims.length === 0
            ? "Nobody has claimed anything. spawn_team_claim early: it is what keeps two agents off the same key path."
            : undefined,
        recentPushes: readPushes(ledgerDir, 10).reverse(),
      };

      const env = loadEnv(dir);
      if (!remote || !env.agentKey || !env.variantId) {
        status.remote = {
          skipped: true,
          reason: remote ? "this worktree has no credentials" : "remote:false",
        };
        return text(status);
      }

      // allSettled: an unreachable API should degrade this report, not fail it.
      const [headSettled, liveSettled] = await Promise.allSettled([
        api(env, "GET", latestPath(env)),
        api(env, "GET", latestPath(env, { mode: "live" })),
      ]);
      const head = headSettled.status === "fulfilled" ? headSettled.value : null;
      const live = liveSettled.status === "fulfilled" ? liveSettled.value : null;
      const headVersion = head?.status === 200 ? (head.json?.version as number) : null;

      status.remote = {
        headVersion,
        headError: head && head.status !== 200 ? apiError(head) : null,
        publishedVersion: live?.status === 200 ? (live.json?.version ?? null) : null,
        publishedError:
          live && live.status !== 200
            ? live.status === 404
              ? "nothing published yet — publish in the Spawn UI before unleashing the team"
              : apiError(live)
            : null,
      };

      if (headVersion != null) {
        const behind = agents
          .filter((a) => a.baseVersion != null && a.baseVersion < headVersion)
          .map((a) => `${a.label} (v${a.baseVersion})`);
        const blocked = agents.filter((a) => a.unresolvedReceipts.length).map((a) => a.label);
        status.summary = [
          `head is v${headVersion}`,
          behind.length ? `behind: ${behind.join(", ")} — spawn_latest before pushing` : "everyone is on head",
          blocked.length ? `blocked by unresolved receipts: ${blocked.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ");
      }

      return text(status);
    }
  );
}
