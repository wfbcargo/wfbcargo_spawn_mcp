import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  assertSafeUsername,
  commitAndPush,
  ensureIdentity,
  excludeLocally,
  git,
  isEmptyDir,
  isGitRepo,
  pullRebase,
  remoteLines,
  scrub,
  status,
  strangersIn,
} from "../src/git.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-git-"));
  roots.push(dir);
  return dir;
}

/** A real local repo — the git behaviour under test is not worth faking. */
async function repo(): Promise<string> {
  const dir = tmpDir();
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "tester"]);
  await git(dir, ["config", "user.email", "tester@example.com"]);
  writeFileSync(join(dir, "world.config.yaml"), "engine: 6.0.0\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "first"]);
  return dir;
}

describe("assertSafeUsername", () => {
  it("accepts the handles Spawn issues", () => {
    for (const ok of ["wfbcargo", "vantage", "@vantage", "a-b_c.d", "A1"]) {
      assert.equal(assertSafeUsername(ok), ok);
    }
  });

  it("refuses anything that could break out of the credential helper", () => {
    // The username is interpolated into a shell function body, so a name
    // carrying shell syntax would run as a command with the token in scope.
    for (const bad of [
      "alice; rm -rf /",
      "alice`id`",
      "alice$(id)",
      "alice bob",
      "alice'x",
      'alice"x',
      "alice\nbob",
      "",
      "-alice",
    ]) {
      assert.throws(() => assertSafeUsername(bad), /Refusing/, `should refuse ${JSON.stringify(bad)}`);
    }
  });
});

describe("scrub", () => {
  it("removes the token from anything shown back", () => {
    const token = "sak_0123456789abcdef";
    assert.equal(scrub(`fatal: auth failed for ${token}`, token), "fatal: auth failed for «token»");
  });

  it("masks credentials embedded in a remote URL", () => {
    assert.equal(
      scrub("remote: https://alice:sak_secret@git.spawn.co/x.git"),
      "remote: https://«credentials»@git.spawn.co/x.git"
    );
  });

  it("leaves ordinary output alone", () => {
    assert.equal(scrub("Everything up-to-date"), "Everything up-to-date");
  });
});

describe("remoteLines", () => {
  it("picks out what the git server said, which is where a 6.0 verdict lands", () => {
    const output = [
      "To https://git.spawn.co/@alice/gauntlet.git",
      "remote: rooms 1, players 1",
      "remote: main: ok — 3 files, 2 ops",
      "   abc123..def456  HEAD -> main",
    ].join("\n");
    assert.deepEqual(remoteLines(output), ["rooms 1, players 1", "main: ok — 3 files, 2 ops"]);
  });

  it("is empty when the server said nothing", () => {
    assert.deepEqual(remoteLines("Everything up-to-date"), []);
  });
});

describe("isEmptyDir", () => {
  it("treats a dir holding only our own files as free to provision", () => {
    // .env must already exist for a clone to authenticate at all, so counting
    // it as "not empty" would make spawn_init impossible on the git lane.
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "SPAWN_AGENT_KEY=sak_x\n");
    mkdirSync(join(dir, ".spawn"));
    assert.equal(isEmptyDir(dir), true);
  });

  it("refuses a dir with someone else's files in it", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "notes.md"), "mine");
    assert.equal(isEmptyDir(dir), false);
  });

  it("treats a missing dir as empty", () => {
    assert.equal(isEmptyDir(join(tmpDir(), "nope")), true);
  });
});

describe("excludeLocally", () => {
  it("hides our files without touching the world's tracked .gitignore", async () => {
    const dir = await repo();
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "gitignore"]);

    assert.deepEqual(excludeLocally(dir), [".env"]);
    // The world's own file is untouched: a clone must not carry a change
    // nobody asked for just because we needed somewhere to hide a token.
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "dist/\n");
    assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /\.env/);

    writeFileSync(join(dir, ".env"), "SPAWN_AGENT_KEY=sak_secret\n");
    const st = await status(dir);
    assert.ok(!st.dirty.some((p) => p.includes(".env")), ".env must never show up as pushable");
  });

  it("never excludes .spawn/, which a 6.0 world tracks itself", async () => {
    // Excluding it would make `git add -A` silently skip new world files there
    // (engine.yaml, skills.md, the per-cell cost JSON), and the push would land
    // missing exactly the work nobody thought to check.
    const dir = await repo();
    excludeLocally(dir);
    mkdirSync(join(dir, ".spawn", "costs", "main"), { recursive: true });
    writeFileSync(join(dir, ".spawn", "costs", "main", "x0z0.json"), "{}\n");

    const st = await status(dir);
    assert.ok(
      st.dirty.some((p) => p.includes(".spawn")),
      "a new file under .spawn/ must still be stageable"
    );
  });

  it("is idempotent", async () => {
    const dir = await repo();
    excludeLocally(dir);
    assert.deepEqual(excludeLocally(dir), []);
  });
});

describe("status", () => {
  it("reads branch, head and a clean tree", async () => {
    const dir = await repo();
    const st = await status(dir);
    assert.equal(st.branch, "main");
    assert.equal(st.clean, true);
    assert.equal(st.ahead, 0);
    assert.equal(st.headSubject, "first");
    assert.ok(st.head);
  });

  it("names uncommitted files", async () => {
    const dir = await repo();
    writeFileSync(join(dir, "places", "main", "cells").replace(/places.*/, "new.js"), "export const a = 1;\n");
    const st = await status(dir);
    assert.equal(st.clean, false);
    assert.ok(st.dirty.some((p) => p.includes("new.js")));
  });
});

describe("ensureIdentity", () => {
  it("only fills in an identity the clone is missing", async () => {
    const dir = tmpDir();
    await git(dir, ["init", "-q"]);
    // A fresh clone on a machine with no global git identity cannot commit at
    // all, and the error names nothing an agent can act on.
    assert.equal(await ensureIdentity(dir, "@vantage"), true);
    assert.equal((await git(dir, ["config", "user.name"])).stdout.trim(), "vantage");
    assert.equal(await ensureIdentity(dir, "@vantage"), false, "must not overwrite an existing identity");
  });
});

describe("commitAndPush", () => {
  const creds = { username: "tester", token: "sak_test_token_value" };

  it("refuses an empty push rather than making an empty commit", async () => {
    const dir = await repo();
    const result = await commitAndPush(dir, creds, { message: "nothing changed" });
    assert.equal(result.ok, false);
    assert.match((result as any).message, /Nothing to push/);
  });

  it("commits with the message as the first line and the body after it", async () => {
    const dir = await repo();
    // No remote, so the push leg fails — but the commit must already have been
    // made, and its shape is what lands in the creator's chat.
    writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
    const result = await commitAndPush(dir, creds, {
      message: "the north gate opens when both levers are pulled",
      body: "how: two lever behaviours emit to a shared world topic",
    });
    assert.equal(result.ok, false, "no remote configured, so the push leg must fail");
    assert.equal((result as any).stage, "push");

    const subject = (await git(dir, ["log", "-1", "--pretty=%s"])).stdout.trim();
    const body = (await git(dir, ["log", "-1", "--pretty=%b"])).stdout.trim();
    assert.equal(subject, "the north gate opens when both levers are pulled");
    assert.match(body, /two lever behaviours/);
  });
});

describe("pullRebase", () => {
  it("refuses a dirty tree instead of stashing work out from under the agent", async () => {
    const dir = await repo();
    writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
    const result = await pullRebase(dir, { username: "tester", token: "sak_x" });
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, "dirty");
    assert.ok((result as any).paths.some((p: string) => p.includes("a.js")));
  });
});

describe("isGitRepo", () => {
  it("is false for a plain directory", async () => {
    assert.equal(await isGitRepo(tmpDir()), false);
  });

  it("is true for a repo", async () => {
    assert.equal(await isGitRepo(await repo()), true);
  });
});

describe("strangersIn", () => {
  it("catches this session's files, which `git add -A` would otherwise commit into the world", () => {
    assert.deepEqual(
      strangersIn([
        "places/main/cells/x0z0.scene",
        ".env",
        ".spawn/screenshots/play-1.png",
        "scripts/a.js.theirs",
        "game.json",
        "scripts/lever.js",
      ]),
      [".env", ".spawn/screenshots/play-1.png", "scripts/a.js.theirs", "game.json"]
    );
  });

  it("leaves the world's own files alone, .spawn/ included", () => {
    assert.deepEqual(
      strangersIn([".spawn/engine.yaml", ".spawn/costs/main/x0z0.json", "world.config.yaml"]),
      []
    );
  });
});

describe("status sha fields", () => {
  it("reports a full sha for comparison and a short one for display", async () => {
    // `rev-parse --short` picks its length from the repo's object count, so the
    // same commit abbreviates to 7 characters in a small clone and 8 in a bigger
    // one. Comparing those strings made an unchanged HEAD read as a change:
    // spawn_latest reported "changed: true … 0 file(s) moved" after a no-op pull.
    const dir = await repo();
    const st = await status(dir);
    assert.equal(st.head?.length, 40, "head must be the full sha");
    assert.ok(st.headShort && st.headShort.length < 40, "headShort must be abbreviated");
    assert.ok(st.head?.startsWith(st.headShort!), "the short sha must be a prefix of the full one");
  });

  it("gives the same full sha across calls, whatever the abbreviation does", async () => {
    const dir = await repo();
    const a = await status(dir);
    const b = await status(dir);
    assert.equal(a.head, b.head);
  });
});
