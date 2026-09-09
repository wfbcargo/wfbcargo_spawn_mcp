import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DOCUMENT_ERA, forgetEngine, isGitLane, resolveEngine } from "../src/engine.js";
import { loadEnv } from "../src/env.js";
import { absoluteUrl } from "../src/lane.js";

/**
 * A stand-in Spawn API on loopback.
 *
 * `resolveApiUrl` allows plain http for localhost precisely so a dev deploy can
 * be pointed at, and that is what lets the document-lane branch be exercised
 * from an account that only owns 6.0 worlds.
 */
type Route = (url: URL) => { status: number; body: unknown } | null;

let server: Server;
let origin: string;
let routes: Route[] = [];
const calls: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push(url.pathname);
    for (const route of routes) {
      const hit = route(url);
      if (hit) {
        res.writeHead(hit.status, { "content-type": "application/json" });
        res.end(JSON.stringify(hit.body));
        return;
      }
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  process.env.SPAWN_API_URL = origin;
});

after(() => {
  delete process.env.SPAWN_API_URL;
  server?.close();
  roots.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const roots: string[] = [];
let counter = 0;

function project(variantId: string): { dir: string; env: ReturnType<typeof loadEnv> } {
  const dir = mkdtempSync(join(tmpdir(), "spawn-lane-"));
  roots.push(dir);
  mkdirSync(join(dir, ".spawn"), { recursive: true });
  writeFileSync(join(dir, ".env"), `SPAWN_AGENT_KEY=sak_test\nSPAWN_VARIANT_ID=${variantId}\n`);
  const env = loadEnv(dir);
  // Each case gets a fresh variant id, so the process-level memo never leaks
  // one test's era into the next.
  forgetEngine(env);
  return { dir, env };
}

function uniqueVariant(): string {
  return `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;
}

describe("resolveEngine against a live-shaped API", () => {
  it("reads a document-lane world and routes it to the document lane", async () => {
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) =>
        u.pathname === "/api/agent/v1/worlds"
          ? {
              status: 200,
              body: {
                worlds: [
                  {
                    worldId: variantId,
                    address: "@alice/oldworld",
                    git: null,
                    playUrl: "/@alice/oldworld",
                    engine: { semver: "5.4.2", era: "document", git: null },
                  },
                ],
              },
            }
          : null,
    ];

    const info = await resolveEngine(dir, env, undefined);
    assert.equal(info.era, DOCUMENT_ERA);
    assert.equal(info.semver, "5.4.2");
    assert.equal(isGitLane(info.era), false, "a pre-6.0 world must keep the PUT lane");
    assert.equal(info.gitUrl, null);
  });

  it("falls back to agent/docs when worlds does not list the variant", async () => {
    // A document-lane variant need not equal its world id, so the cheap list
    // can miss it — docs is authoritative for anything the token can reach.
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) => (u.pathname === "/api/agent/v1/worlds" ? { status: 200, body: { worlds: [] } } : null),
      (u) =>
        u.pathname === `/api/sdk/v1/${variantId}/agent/docs`
          ? { status: 200, body: { era: "document", engineVersion: "5.1.0", playUrl: "/@alice/w" } }
          : null,
    ];

    const info = await resolveEngine(dir, env, undefined);
    assert.equal(info.era, DOCUMENT_ERA);
    assert.equal(info.source, "docs");
  });

  it("accepts a matching engineVersion on a document world", async () => {
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) =>
        u.pathname === "/api/agent/v1/worlds"
          ? {
              status: 200,
              body: {
                worlds: [{ worldId: variantId, git: null, engine: { semver: "5.4.2", era: "document", git: null } }],
              },
            }
          : null,
    ];

    const info = await resolveEngine(dir, env, "document");
    assert.equal(info.pinned, true);
    assert.equal(info.era, DOCUMENT_ERA);
    assert.equal(await resolveEngine(dir, env, "5.4").then((i) => i.era), DOCUMENT_ERA);
  });

  it("refuses a 6.0 claim about a document world, and the reverse", async () => {
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) =>
        u.pathname === "/api/agent/v1/worlds"
          ? {
              status: 200,
              body: {
                worlds: [{ worldId: variantId, git: null, engine: { semver: "5.4.2", era: "document", git: null } }],
              },
            }
          : null,
    ];
    await assert.rejects(() => resolveEngine(dir, env, "6.0"), /mismatch/);
    await assert.rejects(() => resolveEngine(dir, env, "6.0.0"), /Nothing was written/);
  });

  it("warns but proceeds when only the patch version differs", async () => {
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) =>
        u.pathname === "/api/agent/v1/worlds"
          ? {
              status: 200,
              body: {
                worlds: [
                  {
                    worldId: variantId,
                    git: "https://git.spawn.co/@a/b.git",
                    engine: { semver: "6.0.1", era: "6.0", git: null },
                  },
                ],
              },
            }
          : null,
    ];
    const info = await resolveEngine(dir, env, "6.0.0");
    assert.equal(info.era, "6.0", "same lane, so the call proceeds");
    assert.match(info.warning ?? "", /6\.0\.1/);
  });

  it("proceeds on the caller's word when detection is down, and says so", async () => {
    const { dir, env } = project(uniqueVariant());
    routes = []; // every endpoint 404s

    await assert.rejects(
      () => resolveEngine(dir, env, undefined),
      /Could not read this world's engine/,
      "with nothing to go on it must fail rather than guess a lane"
    );

    const info = await resolveEngine(dir, env, "6.0");
    assert.equal(info.era, "6.0");
    assert.equal(info.source, "pinned");
    assert.match(info.warning ?? "", /detection failed/i);
  });

  it("caches, so a second call costs no request", async () => {
    const variantId = uniqueVariant();
    const { dir, env } = project(variantId);
    routes = [
      (u) =>
        u.pathname === "/api/agent/v1/worlds"
          ? {
              status: 200,
              body: { worlds: [{ worldId: variantId, git: null, engine: { semver: "5.4.2", era: "document", git: null } }] },
            }
          : null,
    ];
    await resolveEngine(dir, env, undefined);
    const before = calls.length;
    const again = await resolveEngine(dir, env, undefined);
    assert.equal(calls.length, before, "no second round trip");
    assert.equal(again.source, "cache");
  });
});

describe("absoluteUrl", () => {
  it("leaves an absolute URL alone — what the git lane returns", () => {
    assert.equal(
      absoluteUrl("https://www.spawn.co", "https://www.spawn.co/@a/b"),
      "https://www.spawn.co/@a/b"
    );
  });

  it("prefixes a relative path — what the document lane returns", () => {
    assert.equal(absoluteUrl("https://www.spawn.co", "/@a/b"), "https://www.spawn.co/@a/b");
  });

  it("is undefined for nothing, rather than a bare origin", () => {
    assert.equal(absoluteUrl("https://www.spawn.co", null), undefined);
    assert.equal(absoluteUrl("https://www.spawn.co", ""), undefined);
  });
});
