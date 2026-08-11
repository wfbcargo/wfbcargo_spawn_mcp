#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closePlay } from "./browser.js";
import { registerPlayTools } from "./play-tools.js";
import { registerTools } from "./tools.js";

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({
  name: "spawn",
  version: packageVersion(),
});

server.registerPrompt(
  "spawn_session",
  {
    description:
      "How to work on a Spawn game via this MCP: bootstrap → game → init → edit → push → play/screenshot → fix (includes multi-agent).",
    argsSchema: {},
  },
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are building a Spawn game via the spawn MCP tools.

Credentials live in the game project's .env (SPAWN_API_URL, SPAWN_AGENT_KEY, SPAWN_VARIANT_ID). Never print the full agent key.

Setup:
1. If no token: spawn_bootstrap with the creator's one-time sbk_ key (expires ~5m, single use). Use a distinct name per agent (e.g. terrain-agent).
2. spawn_me — tell the creator who you're connected as.
3. spawn_create_game or spawn_list_games + spawn_set_variant.
4. spawn_init — scaffolds game.json, world/, scripts/, .spawn/ docs.
5. Read .spawn/guide.md and .spawn/tome-api.md before building. spawn_skill <id> before new domains.

Build loop (show, don't tell):
1. Edit project files.
2. spawn_validate → spawn_push. Every push rebuilds live room state (~1s).
3. Open your own play client: spawn_play_open (headed Chromium). This is YOUR eyes — Spawn is WebGPU/canvas; screenshots beat descriptions.
4. After each meaningful push: spawn_play_screenshot (or reload if the client didn't reshape). Look at the image. If wrong, fix and push again — don't claim done from API success alone.
5. Exercise gameplay with spawn_play_input (WASD, Space, clicks), then screenshot again.
6. Debug: spawn_logs + spawn_play_console for script/page errors; spawn_exec for live world queries.
7. On version_conflict (409): spawn_latest (head), merge .theirs receipts, push again.
8. After meaningful pushes, spawn_savi with what changed.
9. spawn_play_close when finished.

Multi-agent (same creator account — no crew setup):
- Each agent needs its own bootstrap key (settings → build with your own agent) and its own local projectDir / worktree. Never share one SPAWN_PROJECT_DIR — agents will thrash game.json, scripts/, and .spawn/base-version.
- Point every agent at the same SPAWN_VARIANT_ID. Concurrent pushes are supported (optimistic concurrency); 409s are expected, not bugs.
- Ask the creator to publish in the Spawn UI before unleashing the team — published (mode=live) stays stable for players while agents push to dev head. Agents cannot publish via API; use spawn_latest mode=live (read) or spawn_status to confirm a published baseline exists.
- Start small (2–3 agents). Partition work by script/area so conflicts stay rare. Prefer spawn_latest after gaps; restore with mode=live applyLocal:true only when intentionally resetting.
- Coordinate with Savi via spawn_savi; treat other agents' pushes like Savi/creator edits on the version rail.

Pass projectDir when the game project is not SPAWN_PROJECT_DIR / cwd.`,
        },
      },
    ],
  })
);

registerTools(server);
registerPlayTools(server);

/** Hard cap on graceful shutdown — a wedged browser must not block exit. */
const SHUTDOWN_GRACE_MS = 5_000;

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("spawn-mcp: ready on stdio (api + play browser)");

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`spawn-mcp: shutting down (${reason})`);
    // Playwright kills the browser on process exit; this just closes it
    // cleanly first. The timer guarantees we exit even if close() wedges.
    const forced = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    forced.unref();
    await closePlay().catch(() => {});
    await transport.close().catch(() => {});
    process.exit(0);
  };

  // An open browser pins the event loop, so without these the server survives
  // its client and strands a Chromium window. The stdio transport closing is
  // the signal that actually fires for most MCP clients.
  transport.onclose = () => void shutdown("transport closed");
  process.stdin.on("end", () => void shutdown("stdin ended"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on("uncaughtException", (e) => {
    console.error("spawn-mcp uncaught:", e);
    void shutdown("uncaught exception");
  });
  process.on("unhandledRejection", (e) => {
    console.error("spawn-mcp unhandled rejection:", e);
  });
}

main().catch((e) => {
  console.error("spawn-mcp fatal:", e);
  process.exit(1);
});
