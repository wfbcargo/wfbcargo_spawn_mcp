import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  ClientMissingError,
  client,
  isWindowsScriptPathBug,
  output,
  resolveBun,
  resolveClientEntry,
} from "../src/player.js";

const saved = { ...process.env };
after(() => {
  for (const key of ["SPAWN_BUN_BIN", "SPAWN_CLIENT_ENTRY"]) delete process.env[key];
  Object.assign(process.env, saved);
});

const TOKEN = "sak_test_token_value";

describe("client verb validation", () => {
  it("refuses anything that is not a plain verb", async () => {
    // Everything runs as `spawn client <verb>`, so the verb is the only place a
    // flag could smuggle itself into the front of the line.
    for (const bad of ["--origin", "-e", "client join", "join;ls", "JOIN", "", "../x"]) {
      await assert.rejects(() => client(bad, [], TOKEN), /is not a client verb/, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it("refuses --origin in the arguments, wherever it sits", async () => {
    // The token travels to whatever --origin names. Same threat the pinned API
    // origin exists for, reached through the client instead.
    await assert.rejects(() => client("where", ["--origin", "https://evil.example"], TOKEN), /Refusing --origin/);
    await assert.rejects(() => client("where", ["--origin=https://evil.example"], TOKEN), /Refusing --origin/);
    await assert.rejects(
      () => client("move", ["1", "0", "2", "--origin", "https://evil.example"], TOKEN),
      /Refusing --origin/
    );
  });

  it("refuses to run without a token", async () => {
    await assert.rejects(() => client("where", [], ""), /Missing SPAWN_AGENT_KEY/);
  });
});

describe("resolveBun", () => {
  it("honours an explicit binary", () => {
    process.env.SPAWN_BUN_BIN = process.execPath;
    assert.equal(resolveBun(), process.execPath);
    delete process.env.SPAWN_BUN_BIN;
  });

  it("refuses an explicit binary that is not there, rather than silently falling back", () => {
    process.env.SPAWN_BUN_BIN = "/nope/bun";
    assert.throws(() => resolveBun(), ClientMissingError);
    delete process.env.SPAWN_BUN_BIN;
  });

  it("always answers something, so a miss surfaces as ENOENT with a real message", () => {
    delete process.env.SPAWN_BUN_BIN;
    assert.ok(resolveBun().length > 0);
  });
});

describe("resolveClientEntry", () => {
  it("honours an explicit entry", () => {
    process.env.SPAWN_CLIENT_ENTRY = process.execPath;
    assert.deepEqual(resolveClientEntry().args, [process.execPath]);
    delete process.env.SPAWN_CLIENT_ENTRY;
  });

  it("refuses an explicit entry that is not there", () => {
    process.env.SPAWN_CLIENT_ENTRY = "/nope/spawn.mjs";
    assert.throws(() => resolveClientEntry(), ClientMissingError);
    delete process.env.SPAWN_CLIENT_ENTRY;
  });

  it("falls back to a form that needs no install at all", () => {
    delete process.env.SPAWN_CLIENT_ENTRY;
    const entry = resolveClientEntry();
    // Either an installed copy was found, or `bun x` — never nothing.
    assert.ok(entry.args.length >= 1);
    assert.ok(entry.how.length > 0);
    if (entry.args[0] === "x") assert.equal(entry.args[1], "@spawnco/client");
  });
});

describe("isWindowsScriptPathBug", () => {
  it("recognises the client's POSIX-only scriptPath check", () => {
    // The drive letter is mid-line inside the echoed path, which is why this
    // cannot be anchored to the start of a line.
    assert.equal(
      isWindowsScriptPathBug(
        'spawn client run: /run → run needs an ABSOLUTE scriptPath, got "C:\\Users\\me\\.spawn\\scripts\\inline-1.mjs"'
      ),
      true
    );
  });

  it("does not claim it for a POSIX path, where the message means something else", () => {
    assert.equal(
      isWindowsScriptPathBug('run needs an ABSOLUTE scriptPath, got "play.js"'),
      false,
      "a relative POSIX path is the user's own mistake, not the platform bug"
    );
  });

  it("does not fire on unrelated output", () => {
    assert.equal(isWindowsScriptPathBug("left \"default\": session departed"), false);
  });
});

describe("output", () => {
  it("keeps both streams, in order, and drops the empty one", () => {
    assert.equal(output({ ok: true, code: 0, stdout: "joined\n", stderr: "" }), "joined");
    assert.equal(output({ ok: false, code: 1, stdout: "", stderr: "boom\n" }), "boom");
    assert.equal(output({ ok: false, code: 1, stdout: "a\n", stderr: "b\n" }), "a\nb");
  });
});
