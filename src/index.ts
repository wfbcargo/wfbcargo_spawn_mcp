#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closePlay } from "./browser.js";
import { registerPlayTools } from "./play-tools.js";
import { SESSION_GUIDE } from "./session.js";
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
        content: { type: "text" as const, text: SESSION_GUIDE },
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
