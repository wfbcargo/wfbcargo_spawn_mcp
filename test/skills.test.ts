import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";

/** Same harness as exec.test.ts: real handlers against a stub Spawn API. */
type Handler = (url: string) => { status: number; body: unknown };

let server: Server;
let handler: Handler = () => ({ status: 200, body: {} });
let dir: string;
const tools = new Map<string, (args: any) => Promise<any>>();

const API_SKILLS = [
  { id: "drawn-art", name: "Drawn Art", description: "Code-drawn textures, tilesets, HUD icons." },
  { id: "game-ui", name: "Game UI", description: "Player-facing HUDs, panels, overlays." },
  { id: "vehicles", name: "Vehicles", description: "Cars, boats, handling." },
];

before(async () => {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  dir = mkdtempSync(join(tmpdir(), "spawn-skills-"));
  writeFileSync(join(dir, ".env"), "SPAWN_AGENT_KEY=sat_test\nSPAWN_VARIANT_ID=v1\n");
  process.env.SPAWN_API_URL = `http://localhost:${port}`;

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
const jsonOf = (r: any) => JSON.parse(textOf(r));

const writeCache = (skills: unknown) => {
  mkdirSync(join(dir, ".spawn"), { recursive: true });
  writeFileSync(join(dir, ".spawn", "skills.json"), JSON.stringify(skills, null, 2));
};

describe("spawn_skills", () => {
  it("fetches from the API and caches the index when nothing is on disk", async () => {
    rmSync(join(dir, ".spawn"), { recursive: true, force: true });
    handler = () => ({ status: 200, body: { skills: API_SKILLS } });

    const parsed = jsonOf(await call("spawn_skills", { detail: "full", refresh: false }));
    assert.equal(parsed.source, "api");
    assert.equal(parsed.count, 3);
    assert.equal(parsed.skills[0].description, API_SKILLS[0].description);

    // The API is now poisoned; a cache hit is the only way this can still pass.
    handler = () => ({ status: 500, body: { error: "should not be called" } });
    const cached = jsonOf(await call("spawn_skills", { detail: "full", refresh: false }));
    assert.equal(cached.source, "cache");
    assert.equal(cached.count, 3);
  });

  it("filters on id, name, and description", async () => {
    writeCache(API_SKILLS);
    handler = () => ({ status: 500, body: { error: "should not be called" } });

    const byId = jsonOf(await call("spawn_skills", { search: "drawn", detail: "full", refresh: false }));
    assert.deepEqual(byId.skills.map((s: any) => s.id), ["drawn-art"]);
    assert.equal(byId.total, 3, "total should stay the unfiltered count");

    const byDescription = jsonOf(await call("spawn_skills", { search: "HUD", detail: "full", refresh: false }));
    assert.deepEqual(byDescription.skills.map((s: any) => s.id).sort(), ["drawn-art", "game-ui"]);

    const miss = jsonOf(await call("spawn_skills", { search: "zzz", detail: "full", refresh: false }));
    assert.equal(miss.count, 0);
  });

  it("drops descriptions in brief mode", async () => {
    writeCache(API_SKILLS);
    const parsed = jsonOf(await call("spawn_skills", { detail: "brief", refresh: false }));
    assert.equal(parsed.skills[0].description, undefined);
    assert.equal(parsed.skills[0].id, "drawn-art");
  });

  it("re-fetches on refresh even with a warm cache", async () => {
    writeCache([{ id: "stale", name: "Stale", description: "old" }]);
    handler = () => ({ status: 200, body: { skills: API_SKILLS } });
    const parsed = jsonOf(await call("spawn_skills", { detail: "full", refresh: true }));
    assert.equal(parsed.source, "api");
    assert.equal(parsed.count, 3);
  });

  it("ignores an unusable cache instead of reporting zero skills", async () => {
    writeCache([]); // empty array is a failed save, not an engine with no skills
    handler = () => ({ status: 200, body: { skills: API_SKILLS } });
    const parsed = jsonOf(await call("spawn_skills", { detail: "full", refresh: false }));
    assert.equal(parsed.source, "api");
    assert.equal(parsed.count, 3);

    writeFileSync(join(dir, ".spawn", "skills.json"), "{ not json");
    const afterCorrupt = jsonOf(await call("spawn_skills", { detail: "full", refresh: false }));
    assert.equal(afterCorrupt.source, "api");
  });

  it("surfaces an API failure as an error", async () => {
    rmSync(join(dir, ".spawn"), { recursive: true, force: true });
    handler = () => ({ status: 401, body: { error: "bad token" } });
    const r = await call("spawn_skills", { detail: "full", refresh: false });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /bad token/);
  });
});

describe("spawn_skill", () => {
  const skillBody = (url: string) => {
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    return API_SKILLS.some((s) => s.id === id)
      ? { status: 200, body: { content: `# ${id}\nbody for ${id}` } }
      : { status: 404, body: { error: `unknown skill ${id}` } };
  };

  it("loads several skills in one call, each labelled", async () => {
    handler = skillBody;
    const body = textOf(await call("spawn_skill", { ids: ["drawn-art", "game-ui"] }));
    assert.match(body, /=== drawn-art ===/);
    assert.match(body, /=== game-ui ===/);
    assert.match(body, /body for game-ui/);
  });

  it("still accepts a single id, and de-dupes it against ids", async () => {
    handler = skillBody;
    const single = textOf(await call("spawn_skill", { id: "vehicles" }));
    assert.match(single, /body for vehicles/);

    const both = textOf(await call("spawn_skill", { ids: ["vehicles"], id: "vehicles" }));
    assert.equal(both.match(/=== vehicles ===/g)?.length, 1);
  });

  it("answers a wrong id with the real menu, so a guess costs one call", async () => {
    writeCache(API_SKILLS);
    handler = skillBody;
    const r = await call("spawn_skill", { ids: ["ui-stuff"] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Available ids:/);
    assert.match(textOf(r), /game-ui — Game UI/);
  });

  it("keeps the skills that did load when one id is wrong", async () => {
    writeCache(API_SKILLS);
    handler = skillBody;
    const r = await call("spawn_skill", { ids: ["game-ui", "nope"] });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /body for game-ui/);
    assert.match(textOf(r), /=== not loaded ===/);
    assert.match(textOf(r), /nope: 404/);
  });

  it("asks for ids rather than silently loading nothing", async () => {
    writeCache(API_SKILLS);
    const r = await call("spawn_skill", {});
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Pass ids/);
    assert.match(textOf(r), /Available ids:/);
  });
});

describe("spawn_getting_started", () => {
  it("returns the workflow guide with the art/UI step, without touching the API", async () => {
    handler = () => ({ status: 500, body: { error: "should not be called" } });
    const body = textOf(await call("spawn_getting_started"));
    assert.match(body, /Art, UI, and look/);
    assert.match(body, /drawn-art/);
    assert.match(body, /CANNOT generate images or conjure 3D models/);
    assert.match(body, /spawn_play_screenshot/);
  });

  it("points at the next unfinished setup step", async () => {
    rmSync(join(dir, ".spawn"), { recursive: true, force: true });
    rmSync(join(dir, "game.json"), { force: true });
    const body = textOf(await call("spawn_getting_started"));
    assert.match(body, /✗ gameJson/);
    assert.match(body, /Next step: spawn_init/);

    writeFileSync(join(dir, "game.json"), "{}");
    mkdirSync(join(dir, ".spawn"), { recursive: true });
    writeFileSync(join(dir, ".spawn", "guide.md"), "# guide");
    const ready = textOf(await call("spawn_getting_started"));
    assert.match(ready, /✓ gameJson/);
    assert.match(ready, /Next step: Read \.spawn\/guide\.md/);
  });
});
