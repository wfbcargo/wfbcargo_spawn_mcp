import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { SPAWN_API_URL, resolveApiUrl } from "../src/config.js";
import { loadEnv, maskToken, upsertEnv } from "../src/env.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmpProject(envBody?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-env-"));
  roots.push(dir);
  if (envBody !== undefined) writeFileSync(join(dir, ".env"), envBody);
  return dir;
}

describe("resolveApiUrl", () => {
  beforeEach(() => {
    delete process.env.SPAWN_API_URL;

  });

  it("defaults to the pinned origin", () => {
    assert.equal(resolveApiUrl(), SPAWN_API_URL);
  });

  it("honors an https process-env override and normalizes it", () => {
    process.env.SPAWN_API_URL = "https://staging.spawn.co/";
    assert.equal(resolveApiUrl(), "https://staging.spawn.co");
  });

  it("allows http only for loopback", () => {
    process.env.SPAWN_API_URL = "http://localhost:3000";
    assert.equal(resolveApiUrl(), "http://localhost:3000");
    process.env.SPAWN_API_URL = "http://evil.example.com";
    assert.equal(resolveApiUrl(), SPAWN_API_URL, "plain http must be refused");
  });

  it("falls back on malformed values", () => {
    process.env.SPAWN_API_URL = "not a url";
    assert.equal(resolveApiUrl(), SPAWN_API_URL);
  });
});

describe("loadEnv", () => {
  beforeEach(() => {
    delete process.env.SPAWN_API_URL;
    delete process.env.SPAWN_AGENT_KEY;
    delete process.env.SPAWN_VARIANT_ID;

  });

  it("reads credentials from the project .env", () => {
    const dir = tmpProject("SPAWN_AGENT_KEY=sat_abc\nSPAWN_VARIANT_ID=var_1\n");
    const env = loadEnv(dir);
    assert.equal(env.agentKey, "sat_abc");
    assert.equal(env.variantId, "var_1");
  });

  it("ignores SPAWN_API_URL in the project .env", () => {
    const dir = tmpProject("SPAWN_API_URL=https://evil.example.com\nSPAWN_AGENT_KEY=sat_abc\n");
    assert.equal(loadEnv(dir).apiUrl, SPAWN_API_URL);
  });

  it("lets the process env win over the file for credentials", () => {
    const dir = tmpProject("SPAWN_AGENT_KEY=from_file\n");
    process.env.SPAWN_AGENT_KEY = "from_process";
    assert.equal(loadEnv(dir).agentKey, "from_process");
  });

  it("tolerates quotes, CRLF, and a missing file", () => {
    const dir = tmpProject('SPAWN_AGENT_KEY="sat_quoted"\r\nSPAWN_VARIANT_ID=v\r\n');
    assert.equal(loadEnv(dir).agentKey, "sat_quoted");
    assert.equal(loadEnv(dir).variantId, "v");
    assert.equal(loadEnv(tmpProject()).agentKey, "");
  });
});

describe("upsertEnv", () => {
  it("creates missing directories and round-trips", () => {
    const dir = join(tmpProject(), "nested/deeper");
    upsertEnv(dir, { SPAWN_AGENT_KEY: "sat_new" });
    assert.equal(loadEnv(dir).agentKey, "sat_new");
  });

  it("replaces an existing key without disturbing other lines", () => {
    const dir = tmpProject("# comment\nSPAWN_AGENT_KEY=old\nOTHER=keep\n");
    upsertEnv(dir, { SPAWN_AGENT_KEY: "new" });
    const body = readFileSync(join(dir, ".env"), "utf8");
    assert.match(body, /^# comment$/m);
    assert.match(body, /^OTHER=keep$/m);
    assert.match(body, /^SPAWN_AGENT_KEY=new$/m);
    assert.equal(body.includes("old"), false);
  });
});

describe("maskToken", () => {
  it("never reveals the tail of a real token", () => {
    const masked = maskToken("sat_averylongsecrettokenvalue1234");
    assert.equal(masked.includes("averylongsecrettokenvalue"), false);
    assert.match(masked, /^sat_aver…/);
  });

  it("fully masks short values", () => {
    assert.equal(maskToken("short"), "***");
  });
});
