import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  classifyAssetPath,
  extractFromSpec,
  facetsOf,
  findNameOwner,
  gameCount,
  normalizeAssetPath,
  pathWarning,
  readBank,
  resolveRef,
  scanDirectory,
  searchAssets,
  shardKey,
  shardsFor,
  syncAdvice,
  upsertAsset,
  writeBank,
  type Bank,
} from "../src/assets.js";

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-assets-"));
  roots.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

const NOW = "2026-01-01T00:00:00.000Z";
const emptyBank = (): Bank => ({ version: 1, storagePrefix: null, sync: null, assets: [] });

describe("normalizeAssetPath", () => {
  it("strips a leading slash and keeps the cdn prefix", () => {
    assert.equal(normalizeAssetPath("/cdn/effect-smoke-puff.png"), "cdn/effect-smoke-puff.png");
    assert.equal(normalizeAssetPath("cdn/effect-smoke-puff.png"), "cdn/effect-smoke-puff.png");
  });

  it("drops a query string so ?animations= is not a second asset", () => {
    assert.equal(
      normalizeAssetPath("cdn/moodboard-toon-vibrant/model-knight.glb?animations=Idle,Walk"),
      "cdn/moodboard-toon-vibrant/model-knight.glb"
    );
  });

  it("rejects anything that is not a cdn path", () => {
    assert.equal(normalizeAssetPath("scripts/main.js"), null);
    assert.equal(normalizeAssetPath("https://example.com/cdn/x.png"), null);
    assert.equal(normalizeAssetPath("cdn/"), null);
  });

  it("rejects traversal", () => {
    assert.equal(normalizeAssetPath("cdn/../secrets.png"), null);
  });
});

describe("classifyAssetPath", () => {
  it("reads the documented moodboard form", () => {
    const a = classifyAssetPath("cdn/moodboard-gothic-horror/model-humanoid-knight.glb");
    assert.equal(a.namespace, "moodboard");
    assert.equal(a.slug, "gothic-horror");
    assert.equal(a.canonicalSlug, true);
    assert.equal(a.prefix, "model");
    assert.equal(a.stem, "humanoid-knight");
    assert.equal(a.kind, "model");
  });

  it("flags a custom slug as non-canonical but still a moodboard", () => {
    const a = classifyAssetPath("cdn/moodboard-mud-kingdom/texture-packed-earth.png");
    assert.equal(a.namespace, "moodboard");
    assert.equal(a.slug, "mud-kingdom");
    assert.equal(a.canonicalSlug, false);
    assert.equal(a.kind, "image");
  });

  it("treats a bare name as the global root namespace", () => {
    const a = classifyAssetPath("cdn/effect-smoke-puff.png");
    assert.equal(a.namespace, "root");
    assert.equal(a.slug, null);
    assert.equal(a.prefix, "effect");
  });

  it("treats a base64 upload as ingested, with no prefix to imitate", () => {
    const a = classifyAssetPath("cdn/public.aHR0cHM6Ly9leGFtcGxl.png");
    assert.equal(a.namespace, "ingested");
    assert.equal(a.prefix, null);
  });

  it("maps extensions to kinds", () => {
    assert.equal(classifyAssetPath("cdn/a/sfx-tap.mp3").kind, "audio");
    assert.equal(classifyAssetPath("cdn/a/model-x.glb").kind, "model");
    assert.equal(classifyAssetPath("cdn/a/thing.xyz").kind, "unknown");
  });
});

describe("pathWarning", () => {
  it("warns that a root-namespace path is globally shared", () => {
    const w = pathWarning(classifyAssetPath("cdn/model-tree.glb"));
    assert.ok(w && w.includes("global"));
  });

  it("says nothing about a canonical moodboard path", () => {
    assert.equal(pathWarning(classifyAssetPath("cdn/moodboard-pixel-moody/sprite-lamp.png")), null);
  });

  it("mentions the canonical families for a custom slug", () => {
    const w = pathWarning(classifyAssetPath("cdn/moodboard-mine/model-x.glb"));
    assert.ok(w && w.includes("canonical"));
  });
});

describe("scanDirectory", () => {
  it("finds paths in game.json, overlays and scripts, with the citing files", () => {
    const root = tmpRoot();
    write(root, "game.json", JSON.stringify({ atmosphere: { sky: "cdn/moodboard-scifi-neon/texture-sky.png" } }));
    write(root, "world/props.json", JSON.stringify({ o: { model: "/cdn/moodboard-scifi-neon/model-crate.glb" } }));
    write(root, "scripts/fx.js", 'api.spawn({ material: { texture: "cdn/effect-ember-glow.png" } })');

    const { hits } = scanDirectory(root);
    const paths = hits.map((h) => h.path);
    assert.deepEqual(paths, [
      "cdn/effect-ember-glow.png",
      "cdn/moodboard-scifi-neon/model-crate.glb",
      "cdn/moodboard-scifi-neon/texture-sky.png",
    ]);
    assert.deepEqual(hits.find((h) => h.path === "cdn/effect-ember-glow.png")!.files, ["scripts/fx.js"]);
  });

  it("dedupes one asset cited by several files and by a query variant", () => {
    const root = tmpRoot();
    write(root, "game.json", JSON.stringify({ a: "cdn/moodboard-toon-vibrant/model-x.glb?animations=Idle" }));
    write(root, "scripts/a.js", 'const m = "cdn/moodboard-toon-vibrant/model-x.glb"');

    const { hits } = scanDirectory(root);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].files, ["game.json", "scripts/a.js"]);
  });

  it("skips node_modules and .spawn", () => {
    const root = tmpRoot();
    write(root, "node_modules/pkg/index.js", '"cdn/moodboard-x/model-vendor.glb"');
    write(root, ".spawn/base-game.json", '{"a":"cdn/moodboard-x/model-cached.glb"}');
    write(root, "game.json", '{"a":"cdn/moodboard-x/model-real.glb"}');

    const { hits } = scanDirectory(root);
    assert.deepEqual(hits.map((h) => h.path), ["cdn/moodboard-x/model-real.glb"]);
  });

  it("ignores an unquoted cdn mention in prose", () => {
    const root = tmpRoot();
    write(root, "notes.md", "Assets live under cdn/whatever.png in the docs.");
    assert.equal(scanDirectory(root).hits.length, 0);
  });
});

describe("sharding", () => {
  it("shards by style family, and by namespace outside it", () => {
    assert.equal(shardKey(classifyAssetPath("cdn/moodboard-gothic-horror/model-x.glb")), "moodboard-gothic-horror");
    assert.equal(shardKey(classifyAssetPath("cdn/public.abc.png")), "ingested");
    assert.equal(shardKey(classifyAssetPath("cdn/my-folder/thing.png")), "custom-my-folder");
  });

  it("splits the root namespace by prefix, so the biggest group is not one file", () => {
    assert.equal(shardKey(classifyAssetPath("cdn/effect-a.png")), "root-effect");
    assert.equal(shardKey(classifyAssetPath("cdn/music-a.mp3")), "root-music");
    assert.equal(shardKey(classifyAssetPath("cdn/sfx-a.mp3")), "root-sfx");
    assert.equal(shardKey(classifyAssetPath("cdn/nohyphen.png")), "root-other");
  });

  it("sanitizes a slug that would not be a safe filename", () => {
    const key = shardKey(classifyAssetPath("cdn/moodboard-A B..C/model-x.glb"));
    assert.match(key, /^moodboard-[a-z0-9_-]+$/);
  });

  it("writes one file per family and reads them back as one bank", () => {
    const dir = tmpRoot();
    let bank = emptyBank();
    for (const p of [
      "cdn/moodboard-voxel-bright/model-z.glb",
      "cdn/moodboard-voxel-bright/model-a.glb",
      "cdn/moodboard-pixel-moody/sprite-lamp.png",
      "cdn/effect-a.png",
    ]) {
      bank = upsertAsset(bank, p, null, NOW).bank;
    }
    writeBank(dir, bank);

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, [
      "_meta.json",
      "moodboard-pixel-moody.json",
      "moodboard-voxel-bright.json",
      "root-effect.json",
    ]);
    assert.equal(readBank(dir).assets.length, 4);
  });

  it("a narrow write touches only the named shard", () => {
    const dir = tmpRoot();
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/moodboard-voxel-bright/model-z.glb", null, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", null, NOW).bank;
    writeBank(dir, bank);

    const before = statSync(join(dir, "root-effect.json")).mtimeMs;
    const idx = bank.assets.findIndex((a) => a.path === "cdn/moodboard-voxel-bright/model-z.glb");
    bank.assets[idx].description = "changed";
    writeBank(dir, bank, shardsFor(["cdn/moodboard-voxel-bright/model-z.glb"]));

    assert.equal(statSync(join(dir, "root-effect.json")).mtimeMs, before);
    assert.equal(readBank(dir).assets.find((a) => a.path.includes("model-z"))!.description, "changed");
  });

  it("removes a shard that no longer holds anything", () => {
    const dir = tmpRoot();
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", null, NOW).bank;
    writeBank(dir, bank);
    assert.ok(existsSync(join(dir, "root-effect.json")));

    writeBank(dir, { ...bank, assets: [] });
    assert.equal(existsSync(join(dir, "root-effect.json")), false);
  });

  it("absorbs a pre-sharding assets.json and then drops it", () => {
    const dir = tmpRoot();
    writeFileSync(
      join(dir, "assets.json"),
      JSON.stringify({
        version: 1,
        assets: [{ path: "cdn/moodboard-toon-vibrant/model-old.glb", description: "from the flat file" }],
      })
    );

    const read = readBank(dir);
    assert.equal(read.assets.length, 1);
    assert.equal(read.assets[0].description, "from the flat file");

    writeBank(dir, read);
    assert.equal(existsSync(join(dir, "assets.json")), false);
    assert.ok(existsSync(join(dir, "moodboard-toon-vibrant.json")));
    assert.equal(readBank(dir).assets[0].description, "from the flat file");
  });

  it("degrades a corrupt shard to empty rather than throwing", () => {
    const dir = tmpRoot();
    writeFileSync(join(dir, "root-effect.json"), "{ not json");
    assert.deepEqual(readBank(dir).assets, []);
  });

  it("a torn shard does not take the rest of the catalog with it", () => {
    const dir = tmpRoot();
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", null, NOW).bank;
    bank = upsertAsset(bank, "cdn/moodboard-pixel-moody/sprite-lamp.png", null, NOW).bank;
    writeBank(dir, bank);
    writeFileSync(join(dir, "root-effect.json"), "{ torn");

    assert.deepEqual(readBank(dir).assets.map((a) => a.path), ["cdn/moodboard-pixel-moody/sprite-lamp.png"]);
  });

  it("drops a malformed row but keeps the good ones", () => {
    const dir = tmpRoot();
    writeFileSync(
      join(dir, "root-effect.json"),
      JSON.stringify({
        version: 1,
        assets: [{ path: "not-an-asset" }, {}, { path: "cdn/effect-ok.png", description: "fine" }],
      })
    );
    const read = readBank(dir);
    assert.deepEqual(read.assets.map((a) => a.path), ["cdn/effect-ok.png"]);
    assert.equal(read.assets[0].description, "fine");
  });

  it("round-trips assigned fields, and recomputes derived ones", () => {
    const dir = tmpRoot();
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/moodboard-scifi-neon/model-drone.glb", null, NOW).bank;
    bank.assets[0].name = "drone";
    bank.assets[0].category = "enemies";
    bank.assets[0].verdict = "good";
    writeBank(dir, bank);

    const a = readBank(dir).assets[0];
    assert.equal(a.name, "drone");
    assert.equal(a.category, "enemies");
    assert.equal(a.verdict, "good");
    assert.equal(a.prefix, "model");
    assert.equal(a.stem, "drone");
    assert.equal(a.canonicalSlug, true);
  });
});

describe("names", () => {
  function named(): Bank {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/moodboard-gothic-horror/model-humanoid-knight.glb", null, NOW).bank;
    bank.assets[0].name = "knight";
    bank = upsertAsset(bank, "cdn/effect-a.png", null, NOW).bank;
    return bank;
  }

  it("resolves a name to its path", () => {
    assert.deepEqual(resolveRef(named(), "knight"), {
      path: "cdn/moodboard-gothic-horror/model-humanoid-knight.glb",
    });
  });

  it("resolves case-insensitively", () => {
    assert.deepEqual(resolveRef(named(), "KNIGHT"), {
      path: "cdn/moodboard-gothic-horror/model-humanoid-knight.glb",
    });
  });

  it("still resolves a raw path", () => {
    assert.deepEqual(resolveRef(named(), "/cdn/effect-a.png"), { path: "cdn/effect-a.png" });
  });

  it("explains a reference that is neither", () => {
    const r = resolveRef(named(), "no-such-thing");
    assert.ok("error" in r && r.error.includes("neither a name"));
  });

  it("finds the asset already holding a name, ignoring the one being renamed", () => {
    const bank = named();
    assert.ok(findNameOwner(bank, "knight", "cdn/effect-a.png"));
    assert.equal(findNameOwner(bank, "knight", "cdn/moodboard-gothic-horror/model-humanoid-knight.glb"), null);
  });
});

describe("gameCount", () => {
  it("counts one game per distinct variant, not per directory", () => {
    let bank = emptyBank();
    // Three worktrees of one game, as team mode produces.
    for (const dir of ["/w/terrain", "/w/hud", "/w/fx"]) {
      bank = upsertAsset(bank, "cdn/effect-a.png", { project: dir, variantId: "var-1", files: [], source: "scan" }, NOW).bank;
    }
    assert.equal(bank.assets[0].usedIn.length, 3);
    assert.equal(gameCount(bank.assets[0]), 1);
  });

  it("counts two games as two", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/a", variantId: "var-1", files: [], source: "scan" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/b", variantId: "var-2", files: [], source: "scan" }, NOW).bank;
    assert.equal(gameCount(bank.assets[0]), 2);
  });

  it("counts a project with no known variant on its own", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/a", variantId: "var-1", files: [], source: "scan" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/b", variantId: null, files: [], source: "scan" }, NOW).bank;
    assert.equal(gameCount(bank.assets[0]), 2);
  });

  it("keeps a known variant when a later scan cannot read one", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/a", variantId: "var-1", files: [], source: "scan" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/a", variantId: null, files: [], source: "scan" }, NOW).bank;
    assert.equal(bank.assets[0].usedIn[0].variantId, "var-1");
  });

  it("a synced game and its local checkout are ONE use, not two", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/w/game", variantId: "var-1", files: ["game.json"], source: "scan" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { variantId: "var-1", game: "My Game", files: ["scripts/fx.js"], source: "sync" }, NOW).bank;

    const use = bank.assets[0].usedIn;
    assert.equal(use.length, 1);
    assert.equal(gameCount(bank.assets[0]), 1);
    // The sync knew no directory; it must not erase the one the scan found.
    assert.equal(use[0].project, resolve("/w/game"));
    assert.equal(use[0].game, "My Game");
    assert.deepEqual(use[0].files, ["game.json", "scripts/fx.js"]);
  });

  it("counts a sync-only game with no local checkout", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { variantId: "var-1", game: "A", files: [], source: "sync" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { variantId: "var-2", game: "B", files: [], source: "sync" }, NOW).bank;
    assert.equal(gameCount(bank.assets[0]), 2);
    assert.equal(bank.assets[0].usedIn[0].project, null);
  });

  it("ignores a use that identifies neither a game nor a project", () => {
    const bank = upsertAsset(emptyBank(), "cdn/effect-a.png", { files: ["x"], source: "sync" }, NOW).bank;
    assert.equal(bank.assets[0].usedIn.length, 0);
  });
});

describe("extractFromSpec", () => {
  it("attributes paths to the script they appear in, and the rest to game.json", () => {
    const hits = extractFromSpec({
      places: { main: { terrain: { materials: [{ albedo: "cdn/moodboard-voxel-bright/texture-grass.png" }] } } },
      scripts: {
        "scripts/fx.js": 'api.spawn({ texture: "cdn/effect-ember-glow.png" })',
        "scripts/ui.js": 'const icon = "/cdn/moodboard-voxel-bright/sprite-icon.png";',
      },
    });

    assert.deepEqual(
      hits.map((h) => [h.path, h.files]),
      [
        ["cdn/effect-ember-glow.png", ["scripts/fx.js"]],
        ["cdn/moodboard-voxel-bright/sprite-icon.png", ["scripts/ui.js"]],
        ["cdn/moodboard-voxel-bright/texture-grass.png", ["game.json"]],
      ]
    );
  });

  it("merges one path cited by a script and the spec body", () => {
    const hits = extractFromSpec({
      atmosphere: { sky: "cdn/moodboard-scifi-neon/texture-sky.png" },
      scripts: { "scripts/a.js": 'load("cdn/moodboard-scifi-neon/texture-sky.png")' },
    });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].files, ["game.json", "scripts/a.js"]);
  });

  it("survives a spec with no scripts and a junk spec", () => {
    assert.equal(extractFromSpec({ a: "cdn/effect-x.png" }).length, 1);
    assert.deepEqual(extractFromSpec(null), []);
    assert.deepEqual(extractFromSpec({ scripts: "not-an-object" }), []);
  });
});

describe("syncAdvice", () => {
  const withSync = (daysAgo: number): Bank => ({
    ...emptyBank(),
    assets: upsertAsset(emptyBank(), "cdn/effect-a.png", null, NOW).bank.assets,
    sync: {
      lastSyncAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      games: 3,
      variantIds: ["v1"],
    },
  });

  it("tells an empty bank to sync", () => {
    const advice = syncAdvice(emptyBank());
    assert.ok(advice && advice.includes("EMPTY") && advice.includes("spawn_asset_sync"));
  });

  it("tells a scanned-but-never-synced bank to sync", () => {
    const bank = upsertAsset(emptyBank(), "cdn/effect-a.png", null, NOW).bank;
    const advice = syncAdvice(bank);
    assert.ok(advice && advice.includes("never been synced"));
  });

  it("says nothing about a fresh sync", () => {
    assert.equal(syncAdvice(withSync(1)), null);
  });

  it("flags a stale sync with its age", () => {
    const advice = syncAdvice(withSync(30));
    assert.ok(advice && advice.includes("30 days ago"));
  });

  it("survives an unparseable timestamp rather than advising nonsense", () => {
    const bank = withSync(1);
    bank.sync!.lastSyncAt = "not a date";
    assert.equal(syncAdvice(bank), null);
  });
});

describe("facetsOf", () => {
  it("counts categories, kinds and families over the match set", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/moodboard-voxel-bright/model-a.glb", null, NOW).bank;
    bank = upsertAsset(bank, "cdn/moodboard-voxel-bright/model-b.glb", null, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-c.png", null, NOW).bank;
    bank.assets[0].category = "enemies";
    bank.assets[1].category = "enemies";

    const f = facetsOf(bank.assets);
    assert.equal(f.category.enemies, 2);
    assert.equal(f.category["(uncategorized)"], 1);
    assert.equal(f.kind.model, 2);
    assert.equal(f.slug["voxel-bright"], 2);
    assert.equal(f.namespace.root, 1);
  });
});

describe("upsertAsset", () => {
  it("re-scanning merges provenance instead of duplicating the row", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/games/one", files: ["game.json"], source: "scan" }, NOW).bank;
    const second = upsertAsset(bank, "cdn/effect-a.png", { project: "/games/one", files: ["scripts/fx.js"], source: "scan" }, NOW);
    bank = second.bank;

    assert.equal(second.created, false);
    assert.equal(bank.assets.length, 1);
    assert.deepEqual(bank.assets[0].usedIn[0].files, ["game.json", "scripts/fx.js"]);
  });

  it("records a second project separately", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/games/one", files: ["game.json"], source: "scan" }, NOW).bank;
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/games/two", files: ["game.json"], source: "scan" }, NOW).bank;
    assert.equal(bank.assets[0].usedIn.length, 2);
  });

  it("a later scan never clobbers a hand-written note", () => {
    let bank = emptyBank();
    bank = upsertAsset(bank, "cdn/effect-a.png", null, NOW).bank;
    bank.assets[0].description = "orange ember, soft edges";
    bank.assets[0].verdict = "good";
    bank = upsertAsset(bank, "cdn/effect-a.png", { project: "/games/one", files: ["game.json"], source: "scan" }, NOW).bank;

    assert.equal(bank.assets[0].description, "orange ember, soft edges");
    assert.equal(bank.assets[0].verdict, "good");
  });
});

describe("searchAssets", () => {
  function seeded(): Bank {
    let bank = emptyBank();
    for (const p of [
      "cdn/moodboard-gothic-horror/model-humanoid-knight.glb",
      "cdn/moodboard-lowpoly-cozy/texture-grass.png",
      "cdn/effect-smoke-puff.png",
      "cdn/moodboard-lowpoly-cozy/sfx-door-creak.mp3",
    ]) {
      bank = upsertAsset(bank, p, null, NOW).bank;
    }
    return bank;
  }

  it("filters by kind and slug", () => {
    const bank = seeded();
    assert.deepEqual(
      searchAssets(bank, { kind: "audio" }).results.map((a) => a.path),
      ["cdn/moodboard-lowpoly-cozy/sfx-door-creak.mp3"]
    );
    assert.equal(searchAssets(bank, { slug: "lowpoly-cozy" }).total, 2);
  });

  it("matches free text across name and description", () => {
    const bank = seeded();
    assert.deepEqual(
      searchAssets(bank, { query: "knight" }).results.map((a) => a.path),
      ["cdn/moodboard-gothic-horror/model-humanoid-knight.glb"]
    );
  });

  it("requires every term to match", () => {
    const bank = seeded();
    assert.equal(searchAssets(bank, { query: "knight grass" }).total, 0);
  });

  it("reports the true match count when a limit truncates the page", () => {
    const bank = seeded();
    const found = searchAssets(bank, {}, 2);
    assert.equal(found.results.length, 2);
    assert.equal(found.total, 4);
  });

  it("ranks a known-good described asset above a bare match", () => {
    let bank = seeded();
    const idx = bank.assets.findIndex((a) => a.path === "cdn/moodboard-lowpoly-cozy/texture-grass.png");
    bank.assets[idx].verdict = "good";
    bank.assets[idx].description = "bright grass tile";
    bank = upsertAsset(bank, "cdn/moodboard-realistic-gritty/texture-grass-dead.png", null, NOW).bank;

    assert.equal(
      searchAssets(bank, { query: "grass" }).results[0].path,
      "cdn/moodboard-lowpoly-cozy/texture-grass.png"
    );
  });

  it("sinks a bad verdict below everything else", () => {
    let bank = seeded();
    const idx = bank.assets.findIndex((a) => a.path === "cdn/moodboard-lowpoly-cozy/texture-grass.png");
    bank.assets[idx].verdict = "bad";
    bank = upsertAsset(bank, "cdn/moodboard-realistic-gritty/texture-grass-dead.png", null, NOW).bank;

    const { results } = searchAssets(bank, { query: "grass" });
    assert.equal(results[results.length - 1].path, "cdn/moodboard-lowpoly-cozy/texture-grass.png");
  });

  it("finds unrated assets", () => {
    let bank = seeded();
    bank.assets[0].verdict = "good";
    assert.equal(searchAssets(bank, { verdict: "unrated" }).total, 3);
  });
});
