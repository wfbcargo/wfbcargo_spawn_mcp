import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";

/**
 * Drives the real tool handlers against a stub Spawn API, so the assertions
 * cover what an MCP client would actually receive.
 */
type Handler = (url: string) => { status: number; body: unknown };

let server: Server;
let handler: Handler = () => ({ status: 200, body: {} });
let dir: string;
const tools = new Map<string, (args: any) => Promise<any>>();

before(async () => {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  dir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
  writeFileSync(join(dir, ".env"), "SPAWN_AGENT_KEY=sat_test\nSPAWN_VARIANT_ID=v1\n");
  process.env.SPAWN_API_URL = `http://localhost:${port}`;

  // Capture each tool's callback off a real McpServer registration.
  const capture = {
    registerTool: (name: string, _def: unknown, cb: (args: any) => Promise<any>) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  registerTools(capture);
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SPAWN_API_URL;
});

const call = (name: string, args: any = {}) => tools.get(name)!({ projectDir: dir, ...args });
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("spawn_exec", () => {
  it("returns the result when the script succeeds", async () => {
    handler = () => ({ status: 200, body: { ok: true, result: [1, 2, 3] } });
    const r = await call("spawn_exec", { script: "return 1" });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /"result"/);
  });

  it("reports a 200 { ok: false } script failure as an ERROR, not a success", async () => {
    // The endpoint answers 200 even when the script threw; treating that as
    // success makes a broken script look like a working one.
    handler = () => ({ status: 200, body: { ok: false, error: "api.sql is not available in read-only mode" } });
    const r = await call("spawn_exec", { script: "await api.sql`SELECT 1`" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /exec script failed/);
    assert.match(textOf(r), /read-only mode/);
  });

  it("explains that a 502 usually means no live room", async () => {
    handler = () => ({ status: 502, body: { error: "Bad gateway" } });
    const r = await call("spawn_exec", { script: "return 1" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /NO LIVE ROOM/);
    assert.match(textOf(r), /spawn_play_open/);
  });

  it("gives the same hint for logs and rooms", async () => {
    handler = () => ({ status: 502, body: { error: "Bad gateway" } });
    for (const tool of ["spawn_logs", "spawn_rooms"]) {
      const r = await call(tool);
      assert.equal(r.isError, true, `${tool} should error`);
      assert.match(textOf(r), /NO LIVE ROOM/, `${tool} should hint`);
    }
  });

  it("keeps a non-JSON 5xx body readable instead of reporting null", async () => {
    handler = () => ({ status: 502, body: "<html>502 Bad Gateway</html>" });
    const r = await call("spawn_exec", { script: "return 1" });
    assert.match(textOf(r), /Bad Gateway/);
  });
});
