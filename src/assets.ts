/**
 * The asset bank: a local, cross-project catalog of Spawn CDN asset paths.
 *
 * Spawn generates an asset on first fetch of its path and caches it there
 * forever ("naming is creating" — .spawn/guide.md), and it has no catalog API.
 * So the same path in two games is already the same asset, and nothing needs
 * building for sharing. What nothing stores is the JUDGMENT: which names
 * produced something good, which produced something bad, and what to write
 * instead. A name is spent once — you cannot re-roll a path — so that record is
 * the only part of the process that is genuinely lost otherwise.
 *
 * Two vocabularies meet in an Asset and are kept strictly apart:
 *   - DERIVED from the path and never editable: namespace, slug, prefix, stem, kind.
 *   - ASSIGNED by you: name, category, description, tags, verdict, replacedBy.
 * `prefix`/`stem` are what the filename happens to say; `name`/`category` are
 * what you decided it is. Collapsing them would mean a rescan could silently
 * overwrite a judgement.
 *
 * Design notes, including what is deliberately not built, live in ASSET-BANK.md.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

/** The nine documented style families. A custom slug is allowed, just flagged. */
export const CANONICAL_SLUGS = [
  "lowpoly-cozy",
  "painterly-fantasy",
  "toon-vibrant",
  "voxel-bright",
  "realistic-gritty",
  "scifi-neon",
  "gothic-horror",
  "pixel-bright",
  "pixel-moody",
] as const;

/** The cook route. Answers 302 → storage for a ready asset, 401 for an unknown one. */
const COOK_ORIGIN = "https://www.spawn.co";
/**
 * Last-resort storage prefix. Normally resolved at runtime by following one 302,
 * because the live value carries an environment segment and a version that will
 * move. Hardcoding it alone would turn a Spawn deploy into a silent wrong answer.
 */
const FALLBACK_STORAGE_PREFIX = "https://spawnfile.io/dev/magic-assets/v5/assets";
/** A path already known to exist, used only to re-resolve the storage prefix. */
const PREFIX_PROBE_PATH = "cdn/effect-smoke-puff.png";
const CHECK_TIMEOUT_MS = Number(process.env.SPAWN_HTTP_TIMEOUT_MS) || 30_000;
/** Big enough for any texture; a .glb that exceeds it still reports existence. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export type AssetKind = "model" | "image" | "audio" | "unknown";
export type AssetNamespace = "moodboard" | "root" | "custom" | "ingested";
export type Verdict = "good" | "bad";

export type AssetUse = {
  /**
   * The game using the asset. This is what makes a game count honest: in team
   * mode N worktrees are ONE game, so counting directories would report a
   * 3-agent team as 3 games.
   */
  variantId: string | null;
  /** Display name from the account listing, when a sync supplied one. */
  game: string | null;
  /** Absolute path of the local project, when one was scanned. Null for sync-only games. */
  project: string | null;
  /** File paths that mention it, capped so one path cannot bloat the bank. */
  files: string[];
  /** `scan` = read off local disk, `sync` = read from the account's server-side spec. */
  source: "scan" | "sync";
  lastSeenAt: string;
};

/**
 * Which existing use an incoming one belongs to, or -1 for a new row.
 *
 * A local scan identifies itself by DIRECTORY: keying it on the variant would
 * merge a team's worktrees into one row and make each scan overwrite the last
 * one's path, so the recorded directory would flip on every run.
 *
 * A sync has no directory, so it identifies itself by variant, and folds into
 * whichever local checkout of that game is already recorded. Without that fold,
 * every synced game would add a second row for a game you already have checked
 * out — harmless for `gameCount`, which counts variants, but it would show the
 * same game twice in provenance.
 */
function matchUse(
  usedIn: AssetUse[],
  incoming: Pick<AssetUse, "variantId" | "project">
): number {
  if (incoming.project) {
    const dir = resolve(incoming.project);
    return usedIn.findIndex((u) => u.project && resolve(u.project) === dir);
  }
  if (incoming.variantId) return usedIn.findIndex((u) => u.variantId === incoming.variantId);
  return -1;
}

export type SyncState = {
  lastSyncAt: string;
  /** Games seen on the account at that sync. */
  games: number;
  variantIds: string[];
};

export type Asset = {
  path: string;
  // --- derived from the path, refreshed on every read ---
  namespace: AssetNamespace;
  slug: string | null;
  canonicalSlug: boolean;
  /** First token of the filename ("model" in model-humanoid-knight.glb). */
  prefix: string | null;
  /** The rest of the filename ("humanoid-knight"). */
  stem: string;
  kind: AssetKind;
  // --- assigned by you, never touched by a rescan ---
  /** Short unique handle. Every tool that takes a path takes this instead. */
  name: string | null;
  /** Free-form grouping of your own ("enemies", "ui-icons"). Not the filename prefix. */
  category: string | null;
  description: string | null;
  tags: string[];
  verdict: Verdict | null;
  replacedBy: string | null;
  // --- observed ---
  exists: boolean | null;
  bytes: number | null;
  checkedAt: string | null;
  usedIn: AssetUse[];
  firstSeenAt: string;
  updatedAt: string;
};

export type StoragePrefix = { url: string; resolvedAt: string };

export type Bank = {
  version: 1;
  storagePrefix: StoragePrefix | null;
  sync: SyncState | null;
  assets: Asset[];
};

export const EMPTY_BANK: Bank = { version: 1, storagePrefix: null, sync: null, assets: [] };

/** A sync older than this is worth mentioning; games move on. */
const SYNC_STALE_DAYS = 7;

/**
 * Whether the bank is worth re-syncing, phrased for the model, or null when it
 * is fine.
 *
 * Returned by every asset tool rather than only by search, because the moment a
 * caller is about to invent a new asset name is exactly when a stale bank does
 * real damage: it reports "no match", the model coins a fresh path, and a
 * perfectly good asset that already exists on another game is regenerated under
 * a second name that can never be merged with the first.
 */
export function syncAdvice(bank: Bank): string | null {
  if (!bank.assets.length) {
    return "The asset bank is EMPTY. Run spawn_asset_sync to pull every game on your Spawn account and harvest the assets each one actually uses — including games you have no local checkout of. Until then, treat 'no match' as 'unknown', not as 'does not exist'.";
  }
  if (!bank.sync) {
    return "This bank has never been synced with your Spawn account — it only holds what local scans found. Run spawn_asset_sync to add the games you have no checkout of, and assets a teammate or Savi added that never landed on your disk.";
  }
  const age = Date.now() - Date.parse(bank.sync.lastSyncAt);
  if (!Number.isFinite(age)) return null;
  const days = Math.floor(age / 86_400_000);
  if (days >= SYNC_STALE_DAYS) {
    return `Last synced with your Spawn account ${days} days ago. Run spawn_asset_sync if assets may have been added since — a stale bank makes a real asset look like it does not exist.`;
  }
  return null;
}

/** Cap on recorded files per project, so a path used in 200 scripts stays readable. */
const MAX_FILES_PER_USE = 12;
const META_FILE = "_meta.json";

// ---------------------------------------------------------------------------
// Location and sharding
// ---------------------------------------------------------------------------

/**
 * Where the bank lives. User-level on purpose: the team ledger sits in a repo's
 * shared .git because a team is scoped to one game, which is exactly wrong here.
 * The bank's whole value is crossing games — a per-repo one would forget the
 * thing it exists to remember.
 *
 * A directory, not a file. `SPAWN_ASSET_BANK` pointing at a .json is accepted
 * and read as its parent directory, so an older single-file setting keeps working.
 */
export function resolveBankDir(): string {
  const override = (process.env.SPAWN_ASSET_BANK || "").trim();
  if (!override) return join(homedir(), ".spawn-mcp", "assets");
  const abs = resolve(override);
  return abs.toLowerCase().endsWith(".json") ? join(abs, "..") : abs;
}

const SHARD_SAFE = /[^a-z0-9_-]+/g;

/**
 * Which file an asset lives in. Sharded by style family, because that is the
 * axis people actually think along and it keeps each file human-openable: a
 * note rewrites one family instead of the whole catalog.
 *
 * Sharding does NOT make search faster — a cross-shard query loads the same
 * total bytes, and filtering was never the bottleneck. It buys bounded writes
 * and a directory you can read.
 */
export function shardKey(asset: Pick<Asset, "namespace" | "slug" | "prefix" | "path">): string {
  const clean = (s: string) => s.toLowerCase().replace(SHARD_SAFE, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (asset.namespace === "moodboard") return `moodboard-${clean(asset.slug ?? "unslugged") || "unslugged"}`;
  if (asset.namespace === "custom") {
    const folder = asset.path.slice("cdn/".length).split("/")[0];
    return `custom-${clean(folder) || "other"}`;
  }
  // The root namespace has no style family to shard on and is typically the
  // largest group (it holds the shared standard sets), so it would otherwise
  // become the one oversized file. Its filename prefix — effect, music, sfx —
  // is the only grouping it has, and it is a good one.
  if (asset.namespace === "root") return `root-${clean(asset.prefix ?? "other") || "other"}`;
  return "ingested";
}

// ---------------------------------------------------------------------------
// Path grammar
// ---------------------------------------------------------------------------

const EXT_KINDS: Record<string, AssetKind> = {
  glb: "model",
  gltf: "model",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
};

/**
 * Canonical key form: no leading slash, no query string, forward slashes.
 *
 * `model="cdn/x.glb?animations=Idle"` is a documented reference form, and the
 * query selects clips from the SAME asset — so it must not create a second
 * entry, or the bank would hold three rows for one file.
 */
export function normalizeAssetPath(raw: string): string | null {
  let p = raw.trim().split("\\").join("/");
  p = p.split("?")[0].split("#")[0];
  p = p.replace(/^\/+/, "");
  if (!p.toLowerCase().startsWith("cdn/")) return null;
  p = `cdn/${p.slice(4).replace(/^\/+/, "")}`;
  if (p === "cdn/" || p.includes("//")) return null;
  if (p.split("/").some((s) => s === "." || s === "..")) return null;
  return p;
}

export type DerivedFields = Pick<
  Asset,
  "path" | "namespace" | "slug" | "canonicalSlug" | "prefix" | "stem" | "kind"
>;

export function classifyAssetPath(path: string): DerivedFields {
  const rest = path.slice("cdn/".length);
  const segments = rest.split("/");
  const file = segments[segments.length - 1];
  const folder = segments.length > 1 ? segments[0] : null;

  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
  const whole = dot >= 0 ? file.slice(0, dot) : file;
  const kind = EXT_KINDS[ext] ?? "unknown";

  let namespace: AssetNamespace;
  let slug: string | null = null;
  if (segments.length === 1) {
    // `public.<base64>.png` is an ingested upload, not a chosen name. It carries
    // no naming guidance and must never be offered as a style example.
    namespace = /^public\./.test(file) ? "ingested" : "root";
  } else if (folder && folder.startsWith("moodboard-")) {
    namespace = "moodboard";
    slug = folder.slice("moodboard-".length) || null;
  } else {
    namespace = "custom";
  }

  const hyphen = whole.indexOf("-");
  const prefix = namespace === "ingested" || hyphen <= 0 ? null : whole.slice(0, hyphen);
  const stem = prefix ? whole.slice(hyphen + 1) : whole;

  return {
    path,
    namespace,
    slug,
    canonicalSlug: slug !== null && (CANONICAL_SLUGS as readonly string[]).includes(slug),
    prefix,
    stem,
    kind,
  };
}

export type PathWarningKind = "root-namespace" | "custom-slug";

/**
 * Whether the caller can still do anything about it.
 *
 * `act` — nothing has been generated at this path yet, so the name is still
 * changeable and the advice is worth following now.
 * `note` — the path is already spent. A path cannot be re-rolled, so telling
 * the caller to rename it is not advice, it is noise; the rule applies to the
 * next name instead.
 */
export type PathWarningSeverity = "act" | "note";

export type PathWarning = {
  path: string;
  kind: PathWarningKind;
  severity: PathWarningSeverity;
  text: string;
};

/** The advice half of a warning, keyed on whether the name is still yours to choose. */
function nameFate(
  asset: Partial<Pick<Asset, "exists" | "usedIn">>
): { severity: PathWarningSeverity; tail: string } {
  if (asset.exists === true) {
    return {
      severity: "note",
      tail: "It is already generated, and a path cannot be re-rolled — keep using it. The rule applies to names you create from here.",
    };
  }
  if (asset.exists === false) {
    // Checked, and storage has nothing. Definitive, and it outranks being
    // referenced: a path written into game.json but never fetched is exactly the
    // case that is still fixable.
    return {
      severity: "act",
      tail: "Storage says nothing has been generated here yet, so the name is still yours to choose: prefer cdn/moodboard-<slug>/<prefix>-<name>.<ext> before the first fetch spends it.",
    };
  }
  const games = asset.usedIn?.length ? gameCount({ usedIn: asset.usedIn }) : 0;
  if (games > 0) {
    // Referenced by a real game but never checked against storage. Almost
    // certainly fetched (that is what referencing it does), and renaming it now
    // means editing shipped content — so this is a note, with the one check that
    // could still prove otherwise.
    return {
      severity: "note",
      tail: `It is already referenced by ${games} game${games === 1 ? "" : "s"}, so the name is very likely spent — spawn_asset_preview says for certain. The rule applies to names you create from here.`,
    };
  }
  return {
    severity: "act",
    tail: "Nothing is recorded as using it, so the name may still be yours to choose: prefer cdn/moodboard-<slug>/<prefix>-<name>.<ext>, and spawn_asset_preview says whether the first fetch has already spent it.",
  };
}

/**
 * Why a path is risky, or null when it is fine.
 *
 * The root namespace is global: if naming is creating and there is no
 * namespacing, `cdn/model-tree.glb` is whatever the first fetch anywhere caused
 * to be generated. A moodboard slug is the defense.
 *
 * The diagnosis fires on every such path, but the *advice* is gated on whether
 * the name can still change. Repeating "prefer a namespaced path" over sixty
 * already-generated references is unactionable — the caller cannot re-roll any
 * of them — and burying the handful of paths that are still unspent underneath
 * that noise is the actual cost. `exists` and `usedIn` are optional so a bare
 * `classifyAssetPath` result still warns; unknown provenance is treated as the
 * moment of invention, which is when the advice matters most.
 */
export function pathWarning(
  asset: Pick<Asset, "namespace" | "slug" | "canonicalSlug" | "path"> &
    Partial<Pick<Asset, "exists" | "usedIn">>
): PathWarning | null {
  const head =
    asset.namespace === "root"
      ? {
          kind: "root-namespace" as const,
          text: `${asset.path} is a bare global name: with no moodboard-<slug>/ folder it shares one namespace with every other Spawn game, so whatever the first fetch anywhere generated is what you get.`,
        }
      : asset.namespace === "moodboard" && !asset.canonicalSlug
        ? {
            kind: "custom-slug" as const,
            text: `${asset.path} uses the custom slug "${asset.slug}" rather than one of the nine canonical families (${CANONICAL_SLUGS.join(", ")}). Fine for a look of your own, but a canonical slug is how a world shares one namespace with the rest of Spawn.`,
          }
        : null;
  if (!head) return null;
  const { severity, tail } = nameFate(asset);
  return { path: asset.path, kind: head.kind, severity, text: `${head.text} ${tail}` };
}

/** Text for the rollup line, per kind. `n` is how many spent paths it stands for. */
const SPENT_ROLLUP: Record<PathWarningKind, (n: number) => string> = {
  "root-namespace": (n) =>
    `${n} path${n === 1 ? " is a" : "s are"} bare global name${n === 1 ? "" : "s"} (cdn/<name>.<ext>, no moodboard-<slug>/ folder), sharing one namespace with every other Spawn game. ${n === 1 ? "It is" : "They are"} already in use and cannot be re-rolled, so this is a rule for new names only: cdn/moodboard-<slug>/<prefix>-<name>.<ext>. spawn_asset_search namespace:"root" lists them.`,
  "custom-slug": (n) =>
    `${n} path${n === 1 ? " uses" : "s use"} a custom moodboard slug rather than one of the nine canonical families (${CANONICAL_SLUGS.join(", ")}). Already in use and not re-rollable; fine for a look of your own, and worth a canonical slug on the next one.`,
};

/**
 * A scan's worth of warnings, reported at two different volumes.
 *
 * Without this, a scan of one real project emitted the same sentence sixty-odd
 * times with only the path changing, truncated to ten — which reads as ten
 * findings, hides the one path that is still fixable, and recommends an action
 * that is impossible for every path listed. Actionable ones are named
 * individually; spent ones collapse to a single line per kind that says what the
 * namespace means and where to see the full list.
 */
export function summarizePathWarnings(
  warnings: PathWarning[],
  limit = 10
): { warnings?: string[]; namespaceNotes?: string[] } {
  const act = warnings.filter((w) => w.severity === "act");
  const spent = new Map<PathWarningKind, number>();
  for (const w of warnings) {
    if (w.severity === "note") spent.set(w.kind, (spent.get(w.kind) ?? 0) + 1);
  }
  const notes = [...spent.entries()].map(([kind, n]) => SPENT_ROLLUP[kind](n));
  return {
    ...(act.length
      ? {
          warnings: [
            ...act.slice(0, limit).map((w) => w.text),
            ...(act.length > limit ? [`…and ${act.length - limit} more not generated yet.`] : []),
          ],
        }
      : {}),
    ...(notes.length ? { namespaceNotes: notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Game counting
// ---------------------------------------------------------------------------

/**
 * How many distinct GAMES use an asset.
 *
 * Deliberately not `usedIn.length`. In team mode one game is several worktrees,
 * each its own project directory, so counting directories reports a 3-agent team
 * as 3 games. Uses collapse on variant id where one is known; a project whose
 * .env names no variant cannot be proven to be the same game as another, so it
 * counts once on its own.
 */
export function gameCount(asset: Pick<Asset, "usedIn">): number {
  const variants = new Set<string>();
  let unknown = 0;
  for (const use of asset.usedIn) {
    if (use.variantId) variants.add(use.variantId);
    else unknown++;
  }
  return variants.size + unknown;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A malformed row is dropped rather than failing the whole bank. */
function reviveAsset(raw: unknown): Asset | null {
  if (!isRecord(raw) || typeof raw.path !== "string") return null;
  const path = normalizeAssetPath(raw.path);
  if (!path) return null;
  const now = new Date().toISOString();
  const usedIn: AssetUse[] = Array.isArray(raw.usedIn)
    ? raw.usedIn
        .filter((u): u is Record<string, unknown> => isRecord(u))
        .map((u) => ({
          variantId: typeof u.variantId === "string" && u.variantId ? u.variantId : null,
          game: typeof u.game === "string" && u.game ? u.game : null,
          project: typeof u.project === "string" && u.project ? u.project : null,
          files: Array.isArray(u.files) ? u.files.map(String).slice(0, MAX_FILES_PER_USE) : [],
          source: (u.source === "sync" ? "sync" : "scan") as "scan" | "sync",
          lastSeenAt: typeof u.lastSeenAt === "string" ? u.lastSeenAt : now,
        }))
        // A use that identifies neither a game nor a project cannot be counted
        // or merged, so it is noise rather than provenance.
        .filter((u) => u.variantId || u.project)
    : [];
  return {
    // Derived fields are recomputed rather than trusted: the grammar can change,
    // and a stale namespace would silently mis-file the asset's shard.
    ...classifyAssetPath(path),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    category: typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : null,
    description: typeof raw.description === "string" ? raw.description : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    verdict: raw.verdict === "good" || raw.verdict === "bad" ? raw.verdict : null,
    replacedBy: typeof raw.replacedBy === "string" ? raw.replacedBy : null,
    exists: typeof raw.exists === "boolean" ? raw.exists : null,
    bytes: typeof raw.bytes === "number" ? raw.bytes : null,
    checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
    usedIn,
    firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

/** Only the assigned fields are stored; derived ones are recomputed on read. */
function serializeAsset(a: Asset) {
  return {
    path: a.path,
    ...(a.name ? { name: a.name } : {}),
    ...(a.category ? { category: a.category } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.tags.length ? { tags: a.tags } : {}),
    ...(a.verdict ? { verdict: a.verdict } : {}),
    ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}),
    ...(a.exists !== null ? { exists: a.exists } : {}),
    ...(a.bytes !== null ? { bytes: a.bytes } : {}),
    ...(a.checkedAt ? { checkedAt: a.checkedAt } : {}),
    usedIn: a.usedIn,
    firstSeenAt: a.firstSeenAt,
    updatedAt: a.updatedAt,
  };
}

function readShardFile(file: string): Asset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return []; // a torn shard loses that family, not the catalog
  }
  const rows = isRecord(parsed) && Array.isArray(parsed.assets) ? parsed.assets : [];
  return rows.map(reviveAsset).filter((a): a is Asset => a !== null);
}

/**
 * Read every shard. A single legacy `assets.json` beside the shards is read too,
 * so a bank written before sharding is not silently lost; the next write splits it.
 */
export function readBank(bankDir: string): Bank {
  const dir = resolve(bankDir);
  let storagePrefix: StoragePrefix | null = null;
  let sync: SyncState | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
    if (isRecord(meta) && isRecord(meta.storagePrefix) && typeof meta.storagePrefix.url === "string") {
      storagePrefix = {
        url: meta.storagePrefix.url,
        resolvedAt: typeof meta.storagePrefix.resolvedAt === "string" ? meta.storagePrefix.resolvedAt : "",
      };
    }
    if (isRecord(meta) && isRecord(meta.sync) && typeof meta.sync.lastSyncAt === "string") {
      sync = {
        lastSyncAt: meta.sync.lastSyncAt,
        games: typeof meta.sync.games === "number" ? meta.sync.games : 0,
        variantIds: Array.isArray(meta.sync.variantIds) ? meta.sync.variantIds.map(String) : [],
      };
    }
  } catch {
    /* no meta yet */
  }

  const byPath = new Map<string, Asset>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== META_FILE);
  } catch {
    return { version: 1, storagePrefix, sync, assets: [] };
  }
  // Legacy single file first, so a sharded copy of the same path wins.
  for (const file of files.sort((a, b) => Number(a !== "assets.json") - Number(b !== "assets.json"))) {
    for (const asset of readShardFile(join(dir, file))) byPath.set(asset.path, asset);
  }
  return { version: 1, storagePrefix, sync, assets: [...byPath.values()] };
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Write the bank, optionally only the shards named in `only`.
 *
 * `only` is what keeps a one-field note from rewriting the whole catalog. Shards
 * that end up empty are removed, and the legacy single file is deleted once its
 * contents have been re-sharded, so nothing is read twice.
 */
export function writeBank(bankDir: string, bank: Bank, only?: Set<string>): void {
  const dir = resolve(bankDir);
  mkdirSync(dir, { recursive: true });

  const grouped = new Map<string, Asset[]>();
  for (const asset of bank.assets) {
    const key = shardKey(asset);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(asset);
  }

  for (const [key, assets] of grouped) {
    if (only && !only.has(key)) continue;
    writeJsonAtomic(join(dir, `${key}.json`), {
      version: 1,
      shard: key,
      assets: assets.sort((a, b) => a.path.localeCompare(b.path)).map(serializeAsset),
    });
  }

  // Drop shards that no longer have any assets, and the pre-sharding file.
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file === META_FILE) continue;
      const key = file.slice(0, -".json".length);
      if (file === "assets.json" && !grouped.has(key)) {
        rmSync(join(dir, file), { force: true });
      } else if (!grouped.has(key) && (!only || only.has(key))) {
        rmSync(join(dir, file), { force: true });
      }
    }
  } catch {
    /* best effort */
  }

  writeJsonAtomic(join(dir, META_FILE), {
    version: 1,
    storagePrefix: bank.storagePrefix,
    sync: bank.sync,
    assetCount: bank.assets.length,
    shards: [...grouped.keys()].sort(),
  });
}

/** Shards touched by a set of paths — the `only` argument for a narrow write. */
export function shardsFor(paths: string[]): Set<string> {
  return new Set(paths.map((p) => shardKey(classifyAssetPath(p))));
}

export function findAsset(bank: Bank, path: string): Asset | null {
  return bank.assets.find((a) => a.path === path) ?? null;
}

/** Look up by assigned name, case-insensitively. */
export function findByName(bank: Bank, name: string): Asset | null {
  const want = name.trim().toLowerCase();
  return bank.assets.find((a) => a.name?.toLowerCase() === want) ?? null;
}

/**
 * Resolve a user-supplied reference: a `cdn/...` path, or an assigned name.
 *
 * Names are the point of naming — a handle you can actually remember — so every
 * tool that takes a path takes one of these instead.
 */
export function resolveRef(bank: Bank, ref: string): { path: string } | { error: string } {
  const named = findByName(bank, ref);
  if (named) return { path: named.path };
  const path = normalizeAssetPath(ref);
  if (path) return { path };
  return {
    error: `"${ref}" is neither a name in the bank nor a Spawn asset path. Paths start with cdn/ and end in an extension (cdn/moodboard-lowpoly-cozy/model-humanoid-knight.glb); names are whatever you set with spawn_asset_note name:"…".`,
  };
}

/** Another asset already holding this name, if any. Names are handles, so they must be unique. */
export function findNameOwner(bank: Bank, name: string, path: string): Asset | null {
  const want = name.trim().toLowerCase();
  return bank.assets.find((a) => a.name?.toLowerCase() === want && a.path !== path) ?? null;
}

/**
 * Merge one sighting into the bank. Keyed on the canonical path, so re-scanning
 * a project refreshes provenance rather than duplicating rows, and assigned
 * fields are never clobbered by a later scan.
 */
export type UseInput = {
  project?: string | null;
  variantId?: string | null;
  game?: string | null;
  files?: string[];
  source: "scan" | "sync";
};

export function upsertAsset(
  bank: Bank,
  path: string,
  use: UseInput | null,
  now: string
): { bank: Bank; created: boolean } {
  const existing = findAsset(bank, path);
  const base: Asset = existing ?? {
    ...classifyAssetPath(path),
    name: null,
    category: null,
    description: null,
    tags: [],
    verdict: null,
    replacedBy: null,
    exists: null,
    bytes: null,
    checkedAt: null,
    usedIn: [],
    firstSeenAt: now,
    updatedAt: now,
  };

  let usedIn = base.usedIn;
  if (use) {
    const incoming = {
      variantId: use.variantId ?? null,
      project: use.project ? resolve(use.project) : null,
    };
    // A use that names neither a game nor a directory cannot be counted or
    // merged, so it is noise rather than provenance.
    if (incoming.variantId || incoming.project) {
      const at = matchUse(usedIn, incoming);
      const prior = at >= 0 ? usedIn[at] : null;
      const others = at >= 0 ? usedIn.filter((_, i) => i !== at) : usedIn;
      const files = [...new Set([...(prior?.files ?? []), ...(use.files ?? [])])]
        .sort()
        .slice(0, MAX_FILES_PER_USE);
      usedIn = [
        ...others,
        {
          variantId: incoming.variantId ?? prior?.variantId ?? null,
          game: use.game ?? prior?.game ?? null,
          // Never drop a known local checkout because a sync did not know one.
          project: incoming.project ?? prior?.project ?? null,
          files,
          source: use.source,
          lastSeenAt: now,
        },
      ].sort((a, b) =>
        `${a.variantId ?? ""}${a.project ?? ""}`.localeCompare(`${b.variantId ?? ""}${b.project ?? ""}`)
      );
    }
  }

  const next: Asset = { ...base, usedIn, updatedAt: now };
  return {
    bank: { ...bank, assets: [...bank.assets.filter((a) => a.path !== path), next] },
    created: !existing,
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Matches a cdn path inside any quoted string or template literal.
 *
 * Deliberately run over raw file text rather than the compiled spec: it also
 * catches paths built in script strings and works on a project that does not
 * compile. The trailing extension is required so a bare "cdn/" prefix in prose
 * is not harvested as an asset.
 */
const CDN_PATTERN = /["'`]\s*(\/?cdn\/[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{2,5})(?:\?[^"'`]*)?\s*["'`]/g;

const SCANNABLE = /\.(json|js|jsx|ts|tsx|mjs|cjs|md)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".spawn", "dist", "build", ".next", "coverage"]);
/** Guards against a stray huge file (a base64 blob, a lockfile) stalling a scan. */
const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;

/** Symlinks are skipped, as in compile.ts: they loop, and they reach outside the project. */
function listScannable(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listScannable(full, out, depth + 1);
    } else if (entry.isFile() && SCANNABLE.test(entry.name)) {
      try {
        if (statSync(full).size <= MAX_SCAN_FILE_BYTES) out.push(full);
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return out;
}

export type ScanHit = { path: string; files: string[] };

/**
 * Every cdn path in a blob of text. Shared by the local scan and the account
 * sync so the two can never disagree about what counts as a reference.
 *
 * Works on JSON.stringify output too: a path inside an escaped script source
 * reads as \"cdn/x.png\", which still presents a quote on both sides.
 */
export function extractCdnPaths(text: string): string[] {
  const out = new Set<string>();
  CDN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CDN_PATTERN.exec(text)) !== null) {
    const path = normalizeAssetPath(m[1]);
    if (path) out.add(path);
  }
  return [...out];
}

/**
 * Harvest a server-side game spec, attributing each path to the script it
 * appears in so a synced game reads like a scanned project rather than one
 * undifferentiated blob.
 */
export function extractFromSpec(spec: any): ScanHit[] {
  const byPath = new Map<string, Set<string>>();
  const add = (path: string, file: string) => {
    if (!byPath.has(path)) byPath.set(path, new Set());
    byPath.get(path)!.add(file);
  };

  const scripts = isRecord(spec?.scripts) ? spec.scripts : {};
  for (const [key, source] of Object.entries(scripts)) {
    if (typeof source !== "string") continue;
    for (const path of extractCdnPaths(source)) add(path, key);
  }

  const { scripts: _dropped, ...rest } = isRecord(spec) ? spec : {};
  for (const path of extractCdnPaths(JSON.stringify(rest))) add(path, "game.json");

  return [...byPath.entries()]
    .map(([path, files]) => ({ path, files: [...files].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every distinct cdn path under `dir`, with the project-relative files citing it. */
export function scanDirectory(dir: string): { hits: ScanHit[]; filesScanned: number } {
  const root = resolve(dir);
  const byPath = new Map<string, Set<string>>();
  const files = listScannable(root);

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file).split("\\").join("/");
    for (const path of extractCdnPaths(text)) {
      if (!byPath.has(path)) byPath.set(path, new Set());
      byPath.get(path)!.add(rel);
    }
  }

  return {
    hits: [...byPath.entries()]
      .map(([path, fileSet]) => ({ path, files: [...fileSet].sort() }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    filesScanned: files.length,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchFilters = {
  query?: string;
  name?: string;
  kind?: AssetKind;
  category?: string;
  prefix?: string;
  slug?: string;
  namespace?: AssetNamespace;
  verdict?: Verdict | "unrated";
  project?: string;
  variantId?: string;
  minGames?: number;
};

/** Ranked so a named, described, known-good asset outranks a bare path match. */
function score(asset: Asset, terms: string[]): number {
  let s = 0;
  if (asset.verdict === "good") s += 6;
  if (asset.verdict === "bad") s -= 10;
  if (asset.name) s += 4;
  if (asset.description) s += 3;
  if (asset.category) s += 1;
  if (asset.namespace === "moodboard") s += 2;
  if (asset.namespace === "ingested") s -= 4;
  if (asset.exists === true) s += 1;
  // Reuse across games is the strongest evidence an asset actually worked.
  s += Math.min(gameCount(asset), 3) * 2;
  for (const term of terms) {
    if (asset.name?.toLowerCase().includes(term)) s += 6;
    if (asset.stem.toLowerCase().includes(term)) s += 4;
    if (asset.category?.toLowerCase().includes(term)) s += 3;
    if (asset.tags.some((t) => t.toLowerCase().includes(term))) s += 3;
    if ((asset.description ?? "").toLowerCase().includes(term)) s += 2;
  }
  return s;
}

export type Facets = {
  category: Record<string, number>;
  kind: Record<string, number>;
  slug: Record<string, number>;
  namespace: Record<string, number>;
};

/** Counts over a result set, so "what do I have" needs no extra tool. */
export function facetsOf(assets: Asset[]): Facets {
  const bump = (m: Record<string, number>, k: string | null) => {
    if (!k) return;
    m[k] = (m[k] ?? 0) + 1;
  };
  const out: Facets = { category: {}, kind: {}, slug: {}, namespace: {} };
  for (const a of assets) {
    bump(out.category, a.category ?? "(uncategorized)");
    bump(out.kind, a.kind);
    bump(out.slug, a.slug);
    bump(out.namespace, a.namespace);
  }
  const sortMap = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    category: sortMap(out.category),
    kind: sortMap(out.kind),
    slug: sortMap(out.slug),
    namespace: sortMap(out.namespace),
  };
}

export function filterAssets(bank: Bank, filters: SearchFilters): Asset[] {
  const terms = (filters.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const eq = (a: string | null, b?: string) => !b || a?.toLowerCase() === b.toLowerCase();

  return bank.assets.filter((a) => {
    if (filters.kind && a.kind !== filters.kind) return false;
    if (filters.namespace && a.namespace !== filters.namespace) return false;
    if (!eq(a.category, filters.category)) return false;
    if (!eq(a.prefix, filters.prefix)) return false;
    if (!eq(a.slug, filters.slug)) return false;
    if (!eq(a.name, filters.name)) return false;
    if (filters.verdict === "unrated" && a.verdict !== null) return false;
    if (filters.verdict && filters.verdict !== "unrated" && a.verdict !== filters.verdict) return false;
    if (filters.minGames !== undefined && gameCount(a) < filters.minGames) return false;
    if (filters.variantId && !a.usedIn.some((u) => u.variantId === filters.variantId)) return false;
    if (filters.project) {
      const want = resolve(filters.project);
      if (!a.usedIn.some((u) => u.project && resolve(u.project) === want)) return false;
    }
    if (terms.length) {
      const haystack =
        `${a.path} ${a.name ?? ""} ${a.category ?? ""} ${a.stem} ${a.prefix ?? ""} ${a.slug ?? ""} ${a.description ?? ""} ${a.tags.join(" ")}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) return false;
    }
    return true;
  });
}

/**
 * Returns the page AND the true match count. Reporting only the page size would
 * read as "that is all there is" when a limit truncated it, which is exactly the
 * moment the caller needs to narrow the query instead of concluding the asset
 * does not exist.
 */
export function searchAssets(
  bank: Bank,
  filters: SearchFilters,
  limit = 25
): { total: number; results: Asset[]; matched: Asset[] } {
  const terms = (filters.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = filterAssets(bank, filters);
  return {
    total: matched.length,
    matched,
    results: [...matched]
      .sort((a, b) => score(b, terms) - score(a, terms) || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, limit)),
  };
}

// ---------------------------------------------------------------------------
// Existence / preview
// ---------------------------------------------------------------------------

/**
 * Resolve the storage prefix by following one 302 from the cook route.
 *
 * The live prefix carries an environment segment and a version (".../dev/
 * magic-assets/v5/assets"), both of which will move. Deriving it from a redirect
 * keeps the check correct across a Spawn deploy; the hardcoded constant is only
 * the fallback for when the probe itself fails.
 */
export async function resolveStoragePrefix(): Promise<{ url: string; source: string }> {
  try {
    const res = await fetch(`${COOK_ORIGIN}/${PREFIX_PROBE_PATH}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    const tail = PREFIX_PROBE_PATH.slice("cdn/".length);
    if (location && location.endsWith(tail)) {
      return { url: location.slice(0, location.length - tail.length).replace(/\/+$/, ""), source: "redirect" };
    }
  } catch {
    /* offline or the route moved — fall back rather than fail the tool */
  }
  return { url: FALLBACK_STORAGE_PREFIX, source: "fallback" };
}

export type CheckResult = {
  exists: boolean;
  status: number;
  bytes: number | null;
  contentType: string | null;
  /** Present only for an image the caller asked to render. */
  image?: { data: Buffer; mimeType: string };
  error?: string;
};

/**
 * Existence check against STORAGE, never the cook route.
 *
 * The cook route generates on first fetch and answers 401 for anything it will
 * not cook for an anonymous caller, so it conflates "does not exist" with "not
 * allowed to ask" — and asking there is not side-effect-free. Storage answers a
 * plain 200/404 and never cooks, which is the only honest way to check.
 */
export async function checkAsset(
  storagePrefix: string,
  path: string,
  { fetchImage = false }: { fetchImage?: boolean } = {}
): Promise<CheckResult> {
  const url = `${storagePrefix.replace(/\/+$/, "")}/${path.slice("cdn/".length)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: fetchImage ? "GET" : "HEAD",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (e: any) {
    return {
      exists: false,
      status: 0,
      bytes: null,
      contentType: null,
      error: `could not reach ${url}: ${e?.message ?? e}`,
    };
  }

  const contentType = res.headers.get("content-type");
  const declared = Number(res.headers.get("content-length"));
  const base: CheckResult = {
    exists: res.ok,
    status: res.status,
    bytes: Number.isFinite(declared) && declared > 0 ? declared : null,
    contentType,
  };
  if (!res.ok || !fetchImage) return base;

  // Only images are worth carrying back: the model can actually look at one,
  // and a .glb or .mp3 would just be megabytes it cannot interpret.
  if (!contentType?.startsWith("image/")) return base;
  if (base.bytes && base.bytes > MAX_PREVIEW_BYTES) {
    return { ...base, error: `image is ${base.bytes} bytes — too large to inline` };
  }
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_PREVIEW_BYTES) {
      return { ...base, bytes: buf.byteLength, error: "image too large to inline" };
    }
    return { ...base, bytes: buf.byteLength, image: { data: buf, mimeType: contentType } };
  } catch (e: any) {
    return { ...base, error: `could not read body: ${e?.message ?? e}` };
  }
}
