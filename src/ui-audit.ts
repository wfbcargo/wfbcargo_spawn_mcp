/**
 * A local, zero-network completeness check for a Spawn game's UI: which of the
 * 21 Interface In Game surfaces have a trace anywhere in the project, and
 * which have none at all.
 *
 * This deliberately does not judge how a surface LOOKS, or even whether it is
 * actually built — a static scan of source text cannot see a rendered screen,
 * and spawn_play_screenshot already answers that question. The verdict named
 * "found" means exactly one thing: the surface's name appears in a path or an
 * identifier. It says nothing about whether the screen exists, is complete, or
 * is styled. An earlier version of this module tried to claim more — a third
 * verdict, "present", for evidence plus a citing file that referenced art or
 * style — and that machinery is gone. It looked for a `cdn/` path, a colour
 * literal, a font or a material call in any file that mentioned a surface's
 * name, but "settings", "map", "store", "loading" and "in-game" are ordinary
 * programming words: `export const settings = {…}` next to any hex colour
 * anywhere in the same file was enough to mark the settings screen built. A
 * false "found-and-styled" is the worst outcome this design can produce — it
 * removes a surface from the report entirely, so a screen that was never built
 * never reaches a human or a conductor's backlog. Any text heuristic sharp
 * enough to be trusted there would be claiming to see a rendered screen, which
 * is exactly what `harness.ts` refuses for engine builtins: a check that
 * passes against something it never actually verified. So this module now
 * claims only the one thing a text scan can honestly stand behind.
 *
 * Both engine lanes are handled, because the on-disk shape of "a UI object
 * exists" differs completely between them: the git lane is a tree of scripts
 * and scenes, the document lane is one compiled
 * `game.json` plus whatever scripts have been folded onto disk beside it. A
 * directory that matches neither shape is refused rather than reported as an
 * empty game — an empty report and "this is not a Spawn project" must never
 * look the same. That refusal holds even when a cached engine reading is on
 * disk: the cache names a lane, but the directory must still look like that
 * lane, or scanning refuses rather than trusting a stale or misplaced cache.
 *
 * Detection itself is a best-effort text/path heuristic, not a parse of the
 * engine's real UI object model: it tokenizes identifiers, filenames and
 * source lines and looks for the surface's declared aliases as a contiguous
 * word sequence. A needle of a single token (`map`, `settings`, `store`) is
 * trusted against filenames only, never against free text — it is too
 * ordinary an English word to trust once it leaves a path. A needle of two or
 * more tokens is specific enough to trust in text too. That is honest about
 * what it can and cannot see, which is the whole point — a false "missing"
 * sends someone to `spawn_skill` for work that already exists, but a
 * confident false "found" would be worse.
 *
 * Reference links point at interfaceingame.com but are never fetched: the
 * site's terms forbid scraping and the screenshots are the games' own
 * copyright (`.wiki/decisions/0001-interfaceingame-links-not-scraping.md`).
 * The 21 element slugs, 15 genres and 10 themes below are a hardcoded,
 * verified vocabulary — not something this code could look up even if it
 * wanted to.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { isGitLane } from "./engine.js";

/* ------------------------------------------------------------------ catalog */

export type UiSurface = {
  id: string;
  label: string;
  /** Expected in essentially every playable game — the fallback set when no `audit/ui.json` exists. */
  baseline: boolean;
  /** Lowercase signals beyond the id itself: identifiers, filenames, UI strings. */
  aliases: string[];
  /** Craft skills to load when this surface is missing. Ids only — spawn_skills is authoritative. */
  skills: string[];
};

const GAME_UI_DRAWN_ART = ["game-ui", "drawn-art"];

/**
 * Verified 2026-09-10 against `value=` on the site's own `data-type="elements"`
 * filter inputs (`.wiki/decisions/0001-interfaceingame-links-not-scraping.md`).
 * Already alphabetical, which is also the order the report lists surfaces in.
 *
 * `skills` follows `game-ui` + `drawn-art` for every surface, plus `looks`
 * where colour grade carries most of a surface's mood (the full-screen,
 * atmosphere-setting ones) and `fx` for the two surfaces that are inherently
 * a transition (`loading`, `overlay`) rather than a static screen.
 */
export const UI_CATALOG: UiSurface[] = [
  {
    id: "character",
    label: "Character",
    baseline: false,
    aliases: ["character-select", "character-sheet", "charselect", "hero-select", "player-card"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "credits",
    label: "Credits",
    baseline: false,
    aliases: ["credits-screen", "credits-roll", "end-credits"],
    skills: [...GAME_UI_DRAWN_ART, "looks"],
  },
  {
    id: "dialogue",
    label: "Dialogue",
    baseline: false,
    // "dialog" and "textbox" are single tokens, so — like the id itself —
    // they now only match filenames (UI-C1). "dialogue-box"/"dialog-box"
    // keep text recall for the common camelCase/hyphenated spelling.
    aliases: ["dialog", "speech-bubble", "conversation", "textbox", "npc-dialogue", "dialogue-box", "dialog-box"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "game-over",
    label: "Game over",
    baseline: true,
    aliases: ["gameover", "you-died", "defeat-screen", "death-screen"],
    skills: [...GAME_UI_DRAWN_ART, "looks"],
  },
  {
    id: "in-game",
    label: "In-game HUD",
    baseline: true,
    aliases: ["hud", "ingame", "crosshair", "health-bar"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "inventory",
    label: "Inventory",
    baseline: false,
    aliases: ["backpack", "item-grid", "inventory-panel"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "level-selection",
    label: "Level selection",
    baseline: false,
    aliases: ["level-select", "levelselect", "stage-select", "chapter-select"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "loading",
    label: "Loading",
    baseline: true,
    aliases: ["loading-screen", "please-wait", "spinner", "loadingbar"],
    skills: [...GAME_UI_DRAWN_ART, "looks", "fx"],
  },
  {
    id: "lobby",
    label: "Lobby",
    baseline: false,
    aliases: ["waiting-room", "matchmaking", "party-screen"],
    skills: [...GAME_UI_DRAWN_ART, "looks"],
  },
  {
    id: "main-menu",
    label: "Main menu",
    baseline: true,
    aliases: ["mainmenu", "home-screen", "menu-screen"],
    skills: [...GAME_UI_DRAWN_ART, "looks"],
  },
  {
    id: "map",
    label: "Map",
    baseline: false,
    aliases: ["minimap", "world-map", "map-screen"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "overlay",
    label: "Overlay",
    baseline: true,
    aliases: ["pause-menu", "pause-overlay", "modal", "popup"],
    skills: [...GAME_UI_DRAWN_ART, "fx"],
  },
  {
    id: "progress",
    label: "Progress",
    baseline: false,
    aliases: ["progress-bar", "progressbar", "xp-bar", "levelup-bar"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "quest",
    label: "Quest",
    baseline: false,
    aliases: ["quest-log", "quest-tracker", "objectives", "quest-panel"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "scoreboard",
    label: "Scoreboard",
    baseline: false,
    aliases: ["leaderboard", "high-scores", "rankings"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "settings",
    label: "Settings",
    baseline: true,
    // "settings" alone is a bare identifier as often as it is a screen (UI-C1:
    // `export const settings = {…}`), so it now matches paths only.
    // "settings-screen" keeps text recall for the common camelCase spelling.
    aliases: ["options-menu", "settingsmenu", "preferences", "config-menu", "settings-screen"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "skill-tree",
    label: "Skill tree",
    baseline: false,
    aliases: ["skilltree", "talent-tree", "ability-tree"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "start-screen",
    label: "Start screen",
    baseline: false,
    aliases: ["title-screen", "splash-screen", "press-start"],
    skills: [...GAME_UI_DRAWN_ART, "looks"],
  },
  {
    id: "stats",
    label: "Stats",
    baseline: false,
    aliases: ["stats-panel", "character-stats", "stat-sheet"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "store",
    label: "Store",
    baseline: false,
    // "store" alone is as often a data store as a shop screen (UI-C1:
    // `store(k, v)`), so it now matches paths only. "store-screen" keeps
    // text recall for the common camelCase spelling.
    aliases: ["shop", "shop-screen", "marketplace", "store-screen"],
    skills: GAME_UI_DRAWN_ART,
  },
  {
    id: "tutorial",
    label: "Tutorial",
    baseline: false,
    aliases: ["how-to-play", "onboarding", "tutorial-overlay"],
    skills: GAME_UI_DRAWN_ART,
  },
];

export const CATALOG_BY_ID = new Map(UI_CATALOG.map((s) => [s.id, s]));
export const ALL_SURFACE_IDS = UI_CATALOG.map((s) => s.id);

/**
 * Six surfaces essentially every playable game has, in the order the spec
 * names them — not catalog order, so it reads as a deliberate, chosen set
 * rather than an alphabetical accident.
 */
export const BASELINE_ORDER = ["main-menu", "in-game", "settings", "overlay", "game-over", "loading"];

/** Verified 2026-09-10 from the site's own filter markup. */
export const GENRES = [
  "action",
  "adventure",
  "card-game",
  "fighting",
  "fps",
  "indie",
  "mmo",
  "music",
  "platformer",
  "puzzle",
  "racing",
  "rpg",
  "simulation",
  "sport",
  "strategy",
] as const;

/** Verified 2026-09-10 from the site's own filter markup. */
export const THEMES = [
  "cartoon",
  "fantasy",
  "horror",
  "medieval",
  "military",
  "modern",
  "pirate",
  "pixel-art",
  "sci-fi",
  "western",
] as const;

/* ---------------------------------------------------------------- manifest */

export const uiManifestSchema = z.object({
  expect: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  genre: z.string().optional(),
  theme: z.string().optional(),
});

export type UiManifest = z.infer<typeof uiManifestSchema>;

function unknownIds(ids: string[] | undefined): string[] {
  return (ids ?? []).filter((id) => !CATALOG_BY_ID.has(id));
}

/**
 * Refuses with the full menu rather than a bare "invalid enum" — a typo'd
 * slug otherwise reads as "you have none of these", which is a worse failure
 * than a loud one (conventions.md → tool descriptions: a wrong enum value
 * answers with the real menu).
 *
 * `source` names where the bad value actually came from — `audit/ui.json`'s
 * path when the manifest was read from that file, or a description of the
 * call's own arguments when it was not (UI-C5). Blaming the file
 * unconditionally is wrong when no such file exists: `scanUi` is regularly
 * handed a manifest built entirely from tool arguments, and a caller cannot
 * fix a file that was never there.
 */
/**
 * How much of a rejected value is quoted back.
 *
 * `audit/ui.json` comes out of a game project that may be a clone someone else
 * wrote, and the error text goes straight to the model (R-011). Unbounded, a
 * 103 KB file of bogus slugs produced a measured 99,167-character error. Both
 * caps announce themselves when they bite, because a truncated list presented
 * whole is the thing R-003 exists to stop.
 */
const MAX_ECHOED_VALUES = 5;
const MAX_ECHOED_LENGTH = 80;

/**
 * What an engine era may look like: `document`, or a dotted version such as
 * `6.0` / `6.0.1`. `engine.ts` treats anything that is not `document` as the
 * git lane, so an unconstrained value here would also let a game project
 * choose which lane gets scanned.
 */
const PLAUSIBLE_ERA = /^(document|\d+(\.\d+){0,2})$/;

/**
 * A `game.json` `scripts` key is used as a citation source, but unlike a git-lane
 * path it never came from `readdirSync` — it is an arbitrary JSON key from an
 * untrusted file. Anything that is not a plausible relative path is refused, so
 * a multi-line key cannot forge structure in the rendered report (R-011).
 */
const PLAUSIBLE_SCRIPT_KEY = /^[A-Za-z0-9._\-/]{1,200}$/;

/** One rejected value, bounded and stripped of anything that could restructure the report. */
function echoValue(value: string): string {
  // Newlines and control characters would let a hostile value forge report
  // structure - a fake "=== END OF REPORT ===" line, say. Flatten them first.
  const flat = [...value].map((ch) => (ch.codePointAt(0)! < 0x20 || ch === "\u007f" ? " " : ch)).join("");
  return flat.length > MAX_ECHOED_LENGTH ? `${flat.slice(0, MAX_ECHOED_LENGTH)}…` : flat;
}

/** A bounded list of rejected values that says so when it withheld some (R-003). */
function echoList(values: string[]): string {
  const shown = values.slice(0, MAX_ECHOED_VALUES).map(echoValue).join(", ");
  return values.length > MAX_ECHOED_VALUES
    ? `${shown} (+${values.length - MAX_ECHOED_VALUES} more)`
    : shown;
}

function validateManifest(manifest: UiManifest, source: string): void {
  const surfaceMenu = `Valid surfaces (${ALL_SURFACE_IDS.length}): ${ALL_SURFACE_IDS.join(", ")}.`;

  const badExpect = unknownIds(manifest.expect);
  if (badExpect.length) {
    throw new Error(`${source} "expect" names unknown surface(s): ${echoList(badExpect)}. ${surfaceMenu}`);
  }
  const badIgnore = unknownIds(manifest.ignore);
  if (badIgnore.length) {
    throw new Error(`${source} "ignore" names unknown surface(s): ${echoList(badIgnore)}. ${surfaceMenu}`);
  }
  if (manifest.genre !== undefined && !(GENRES as readonly string[]).includes(manifest.genre)) {
    throw new Error(
      `${source} "genre" is not a valid interfaceingame genre: "${echoValue(manifest.genre)}". ` +
        `Valid genres (${GENRES.length}): ${GENRES.join(", ")}.`
    );
  }
  if (manifest.theme !== undefined && !(THEMES as readonly string[]).includes(manifest.theme)) {
    throw new Error(
      `${source} "theme" is not a valid interfaceingame theme: "${echoValue(manifest.theme)}". ` +
        `Valid themes (${THEMES.length}): ${THEMES.join(", ")}.`
    );
  }
}

/**
 * Where a game declares its intended UI. Lives here rather than in the tool
 * layer because `scanUi` reads it too, to answer whether anything is written
 * down at all — and two spellings of that path would disagree silently.
 */
export const UI_MANIFEST_PATH = "audit/ui.json";

/**
 * Load `audit/ui.json`. Absence is not an error — it just means the caller
 * falls back to the baseline set, which `scanUi` records in `declared`.
 */
export function loadUiManifest(file: string): UiManifest | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`could not read ${file}: ${e?.message ?? e}`);
  }
  const parsed = uiManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${file} is not a valid UI audit declaration:\n${issues}`);
  }
  validateManifest(parsed.data, file);
  return parsed.data;
}

/* ---------------------------------------------------------------- corpus */

export type UiCorpus = {
  lane: "git" | "document";
  laneSource: string;
  files: string[];
  texts: Array<{
    source: string;
    text: string;
    /** True for a text source that is not itself a file — a stringified spec
     *  body, say — so detection never attaches a line number that exists in
     *  no file on disk (UI-C4). */
    synthetic?: boolean;
  }>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type LaneDetection = { lane: "git" | "document"; laneSource: string };

/** A cached engine reading is authoritative when present — checked before any structural guess. */
function cachedEra(dir: string): { era: string; file: string } | null {
  for (const rel of [".git/spawn-mcp/engine.json", ".spawn/engine.json"]) {
    const file = join(dir, ...rel.split("/"));
    if (!existsSync(file)) continue;
    try {
      const cached = JSON.parse(readFileSync(file, "utf8"));
      // The era is interpolated into `laneSource`, which is the report's first
      // line — and this file comes out of a game project that may be a clone
      // someone else wrote. An unvalidated string here is a write primitive
      // into text the model reads (R-011), so accept only the shapes an era
      // actually takes and ignore the cache otherwise.
      if (isRecord(cached) && typeof cached.era === "string" && PLAUSIBLE_ERA.test(cached.era)) {
        return { era: cached.era, file: rel };
      }
    } catch {
      /* try the other home */
    }
  }
  return null;
}

/**
 * Whether `dir` still structurally looks like `lane`, independent of what any
 * cache claims.
 *
 * `engine.ts`'s own cache additionally pins a `variantId`/`apiUrl` pair and
 * refuses a reading recorded under a different one — this module has no
 * access to that (`scanUi` takes only a directory, no env), so it cannot
 * reproduce that guard directly. This structural check is the compensating
 * control instead: it catches the concrete failure (UI-C3) rather than the
 * general one — a `.spawn/engine.json` left over from a lane migration, or
 * (since `.spawn/` is tracked on the git lane, unlike `.git/spawn-mcp/`) a
 * stale copy committed into a git-lane clone — without needing the caller's
 * environment to do it.
 */
function corroboratesLane(lane: "git" | "document", dir: string): boolean {
  return lane === "git" ? existsSync(join(dir, ".git")) : existsSync(join(dir, "game.json"));
}

/**
 * Lane determination is local only (R-005, R-006): a cached engine reading if
 * one is already on disk, else the structural signals the architecture doc
 * names — `.spawn/engine.yaml` plus a git checkout for the git lane, a bare
 * `game.json` for the document lane. Neither recognisable is a refusal, not
 * an empty report.
 *
 * A cached reading is trusted only while the directory still corroborates it
 * (UI-C3): a directory holding nothing but a stale `.spawn/engine.json` and a
 * README must refuse, not report a game with every surface missing — an
 * empty-looking report and "this was never scanned" must never look the same.
 */
function detectLane(dir: string): LaneDetection {
  const cached = cachedEra(dir);
  if (cached) {
    const lane: "git" | "document" = isGitLane(cached.era) ? "git" : "document";
    if (!corroboratesLane(lane, dir)) {
      throw new Error(
        `${cached.file} in ${dir} names the ${lane} lane (era ${cached.era}), but the directory no longer looks ` +
          `like it (${lane === "git" ? "no .git checkout" : "no game.json"}). Refusing rather than trusting a ` +
          "stale or misplaced cache. Nothing was scanned."
      );
    }
    return { lane, laneSource: `cached engine reading (${cached.file}): era ${cached.era}` };
  }

  const hasEngineYaml = existsSync(join(dir, ".spawn", "engine.yaml"));
  const hasGitCheckout = existsSync(join(dir, ".git"));
  if (hasEngineYaml && hasGitCheckout) {
    return { lane: "git", laneSource: ".spawn/engine.yaml plus a git checkout" };
  }

  if (existsSync(join(dir, "game.json"))) {
    return { lane: "document", laneSource: "a bare game.json, no .spawn/engine.yaml" };
  }

  throw new Error(
    `${dir} does not look like a Spawn game project: no cached engine reading, no .spawn/engine.yaml ` +
      "with a git checkout (the git lane), and no game.json (the document lane). Nothing was scanned."
  );
}

/** Directories no part of a world lives in. Mirrors `tree.ts`'s own skip list. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build"]);

/**
 * Walk the world tree for corpus files, skipping symlinked entries.
 *
 * `tree.ts`'s `walkTree` would be the obvious reuse, but it stats rather than
 * lstats — it follows symlinks and keeps no visited set. It does not hang on a
 * cycle (the OS refuses the path long before that), but measured on a tree
 * whose `scripts/ui/loop` links back to `scripts/`, it returns **64 paths for
 * one real file**, nested to depth 129. That would read the same file 64 times
 * and cite it at 64 absurd paths. A link pointing out of the project is read in
 * as well.
 *
 * Neither is fixable after the walk — the duplicates are produced during it.
 * `readdirSync(..., { withFileTypes: true })` uses lstat, not stat, so a
 * symlinked or junction entry already reports `isDirectory()` and `isFile()`
 * both false — it falls through both branches below on its own, contributing
 * nothing to the walk with or without the explicit check. The
 * `entry.isSymbolicLink()` guard is kept anyway: it makes the skip a stated
 * decision rather than an incidental side effect of Dirent semantics a future
 * edit could quietly disturb — the same explicit skip `audit-tools.ts`,
 * `assets.ts`, `compile.ts` and `harness.ts` all already use; a fifth such
 * walker is the house pattern here, not a novelty.
 *
 * `walkTree` itself is deliberately left alone: it is also what `spawn_validate`
 * checks a tree with before a push, and changing what gets syntax-checked there
 * is a decision of its own rather than a side effect of this one.
 */
function walkForCorpus(dir: string, root = dir): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkForCorpus(full, root));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

function gitLaneCorpus(dir: string): Pick<UiCorpus, "files" | "texts"> {
  const files = walkForCorpus(dir).filter((f) => f.endsWith(".js") || f.endsWith(".scene"));
  const texts: Array<{ source: string; text: string }> = [];
  for (const rel of files) {
    try {
      texts.push({ source: rel, text: readFileSync(join(dir, rel), "utf8") });
    } catch {
      /* vanished mid-scan */
    }
  }
  return { files, texts };
}

/**
 * Document lane: the whole non-`scripts` `game.json` body (as one stringified
 * text source) plus embedded and folded-out script bodies. An embedded
 * script's spec key (`scripts/ui/overlay.js`) is treated as its path for
 * detection purposes, the same as a folded file would be — that key IS the
 * file path `compile.ts` writes it back out to.
 *
 * The whole body, not just `id`/`name`/`type` values, because a nested UI
 * object — `{ui:{mainMenu:{label:"Main Menu"}}}` — is otherwise invisible to
 * a scan that only reads those three keys (UI-C2), while the identical JSON
 * inside a `.scene` file on the git lane scores normally: two lanes
 * disagreeing about the same game is R-005. `assets.ts`'s `extractFromSpec`
 * already stringifies the non-`scripts` body to harvest `cdn/` paths this
 * same way; this follows it rather than inventing a second convention.
 */
function documentLaneCorpus(dir: string): Pick<UiCorpus, "files" | "texts"> {
  const files: string[] = [];
  const texts: Array<{ source: string; text: string; synthetic?: boolean }> = [];

  const gamePath = join(dir, "game.json");
  if (existsSync(gamePath)) {
    files.push("game.json");
    let spec: unknown = null;
    try {
      spec = JSON.parse(readFileSync(gamePath, "utf8"));
    } catch {
      /* an unreadable game.json yields an empty corpus, not a crash — the
         report shows everything missing rather than pretending it read
         content that was never actually parsed */
    }
    if (isRecord(spec)) {
      const { scripts, ...rest } = spec;
      if (Object.keys(rest).length) {
        // synthetic: this is a stringify of the object, not a file with real
        // lines, so a citation into it must never claim a line number (UI-C4).
        texts.push({ source: "game.json (spec body)", text: JSON.stringify(rest), synthetic: true });
      }
      if (isRecord(scripts)) {
        for (const [key, body] of Object.entries(scripts)) {
          if (typeof body !== "string") continue;
          // The key becomes a citation source. A git-lane path came from
          // readdirSync and is a real filesystem entry; this did not.
          if (!PLAUSIBLE_SCRIPT_KEY.test(key)) {
            // Still scan the body — the game's content is not the key's fault —
            // but cite it somewhere that cannot forge report structure.
            texts.push({ source: "game.json (a script under an unusable key)", text: body, synthetic: true });
            continue;
          }
          files.push(key);
          texts.push({ source: key, text: body });
        }
      }
    }
  }

  const scriptsDir = join(dir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const rel of walkForCorpus(dir).filter((f) => f.startsWith("scripts/") && f.endsWith(".js"))) {
      if (files.includes(rel)) continue; // already folded into game.json's script map
      files.push(rel);
      try {
        texts.push({ source: rel, text: readFileSync(join(dir, rel), "utf8") });
      } catch {
        /* vanished mid-scan */
      }
    }
  }

  return { files, texts };
}

/* -------------------------------------------------------------- detection */

type Hit = { source: string; line?: number; weight: number };

/** A path match outranks a text match: a file named for a surface is stronger evidence than one mention buried in a line. */
const PATH_WEIGHT = 2;
const TEXT_WEIGHT = 1;
const MAX_CITATIONS = 3;

/** Split an identifier, path or line into lowercase words, on both explicit separators and camelCase boundaries. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether `needle`'s words appear as a contiguous run inside `haystack`'s.
 * Word-based rather than substring-based on purpose: a short alias like "map"
 * would otherwise match "mapping" or "sitemap", and a naive lowercase
 * substring check cannot tell a real hit from noise the way token boundaries
 * can. What token boundaries cannot fix is a genuine homonym — `list.map(x)`
 * tokenizes to the standalone word "map", same as a real map screen would.
 * That residual imprecision on short, common-English slugs (`map`, `store`)
 * is why a single-token needle is trusted against filenames only, never
 * against free text (UI-C1, see `detectSurface`).
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Score alias hits for one surface over the corpus.
 *
 * A single-token needle (`map`, `settings`, `store`, the id or an alias) is
 * matched against filenames only. A filename naming a surface is deliberate;
 * a bare common-English word turning up somewhere in a line is not — `map` in
 * `items.map(i => i.name)`, `settings` in `export const settings = {…}`,
 * `store` in `store(k, v)` (UI-C1). A needle of two or more tokens is specific
 * enough to trust in text too. This costs recall on games that name a surface
 * only in prose with no distinctive filename, and that trade is the design's
 * stated preference: a false "missing" sends someone to build what already
 * exists, a false "found" hides a gap that was never built at all.
 */
function detectSurface(surface: UiSurface, corpus: UiCorpus): Hit[] {
  const needles = [surface.id, ...surface.aliases].map(words);
  const textNeedles = needles.filter((n) => n.length > 1);
  const hits: Hit[] = [];

  for (const file of corpus.files) {
    const haystack = words(file);
    if (needles.some((n) => containsPhrase(haystack, n))) {
      hits.push({ source: file, weight: PATH_WEIGHT });
    }
  }

  for (const { source, text, synthetic } of corpus.texts) {
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      const haystack = words(line);
      if (textNeedles.some((n) => containsPhrase(haystack, n))) {
        // A synthetic source (a stringified spec body) is not a file with
        // real lines, so no line number is attached to it (UI-C4) — the
        // citation names the source alone.
        hits.push({ source, line: synthetic ? undefined : i + 1, weight: TEXT_WEIGHT });
      }
    }
  }

  return hits;
}

function formatCitation(hit: Hit): string {
  return hit.line ? `${hit.source}:${hit.line}` : hit.source;
}

/* -------------------------------------------------------------- reference */

const INTERFACEINGAME_SCREENSHOTS = "https://interfaceingame.com/screenshots/";

/** Built by string concatenation over the validated allowlists above. Never fetched (R-007). */
function referenceUrl(id: string, genre?: string, theme?: string): string {
  const params = [`elements=${id}`];
  if (genre) params.push(`genres=${genre}`);
  if (theme) params.push(`themes=${theme}`);
  return `${INTERFACEINGAME_SCREENSHOTS}?${params.join("&")}`;
}

/* ------------------------------------------------------------------- seam */

export type UiVerdict = "found" | "missing";

export type UiFinding = {
  id: string;
  label: string;
  verdict: UiVerdict;
  citations: string[];
  skills: string[];
  reference: string;
};

export type UiReport = {
  lane: "git" | "document";
  laneSource: string;
  /** `audit/ui.json` was on disk. Read from the filesystem, not inferred from
   *  the manifest: a caller may hand us one built entirely from tool arguments. */
  declared: boolean;
  /** The surface set came from an explicit `expect`, rather than the baseline. */
  expectDeclared: boolean;
  expected: string[];
  findings: UiFinding[];
  notExpected: string[];
};

/**
 * Fold a caller's arguments onto whatever `audit/ui.json` declared.
 *
 * Precedence, not marshalling — which is why it lives here and is tested here
 * rather than sitting in the tool handler: each argument overrides ONLY its own
 * field, so aiming a reference link with `genre` cannot silently discard the
 * file's `expect` and check a different surface set than the game declared.
 * `ignore` is deliberately not overridable from arguments: it is the game's
 * standing statement that a surface does not apply, and a per-call flag is the
 * wrong place to revoke it.
 */
export function mergeUiManifest(
  file: UiManifest | null,
  args: { expect?: string[]; genre?: string; theme?: string }
): UiManifest | null {
  const { expect, genre, theme } = args;
  if (expect === undefined && genre === undefined && theme === undefined) return file;
  return {
    expect: expect ?? file?.expect,
    ignore: file?.ignore,
    genre: genre ?? file?.genre,
    theme: theme ?? file?.theme,
  };
}

/**
 * Labels of the surfaces scored `missing` for a project, or **null when the
 * scan could not run** — an unrecognisable directory, an unreadable
 * `game.json`, a slug typo `validateManifest` correctly refuses.
 *
 * The null matters more than it looks. A caller that collapses failure to an
 * empty list reports "nothing is missing" for a scan that never happened, and
 * a brief handed to a builder is read as ground truth. That is R-003: a result
 * that did not cover everything must not read as one that did.
 */
export function missingUiSurfaceLabels(dir: string): string[] | null {
  try {
    const manifest = loadUiManifest(join(dir, UI_MANIFEST_PATH));
    return scanUi(dir, manifest)
      .findings.filter((f) => f.verdict === "missing")
      .map((f) => f.label);
  } catch {
    return null;
  }
}

/** `expect`/`ignore` order-preserving de-duplication (UI-C6): a repeated id must not be scored, or counted, twice. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function scanUi(dir: string, manifest: UiManifest | null): UiReport {
  const manifestFile = join(dir, UI_MANIFEST_PATH);
  const declared = existsSync(manifestFile);
  if (manifest) {
    // Name the file only when it is actually the source of this manifest
    // (UI-C5) — `scanUi` is regularly handed one built from tool arguments,
    // and blaming `audit/ui.json` for that is wrong when the file may not
    // even exist.
    validateManifest(
      manifest,
      declared ? manifestFile : `the arguments passed to this call (no ${UI_MANIFEST_PATH} exists in ${dir})`
    );
  }

  const { lane, laneSource } = detectLane(dir);
  const corpus: UiCorpus = { lane, laneSource, ...(lane === "git" ? gitLaneCorpus(dir) : documentLaneCorpus(dir)) };

  const ignore = new Set(manifest?.ignore ?? []);
  // Presence, not truthiness: an explicit `"expect": []` replaces the
  // baseline with an empty set rather than being treated as absent.
  const rawExpected = manifest?.expect !== undefined ? manifest.expect : BASELINE_ORDER;
  const expectedIds = dedupe(rawExpected).filter((id) => !ignore.has(id));

  const findings: UiFinding[] = expectedIds.map((id) => {
    const surface = CATALOG_BY_ID.get(id)!; // valid: baseline ids are catalog ids, declared ids were validated above
    const hits = detectSurface(surface, corpus);
    const verdict: UiVerdict = hits.length === 0 ? "missing" : "found";
    // A bare path hit and a line hit on the same file are the same evidence,
    // and the line hit is strictly more useful — keep only the latter.
    const located = new Set(hits.filter((h) => h.line).map((h) => h.source));
    const distinct = hits.filter((h) => h.line || !located.has(h.source));
    const ranked = [...distinct].sort((a, b) => b.weight - a.weight);
    const citations = ranked.slice(0, MAX_CITATIONS).map(formatCitation);
    // R-003: a capped list reported as a whole one reads as "these are all of them".
    if (ranked.length > MAX_CITATIONS) {
      citations.push(`(+${ranked.length - MAX_CITATIONS} more)`);
    }
    return {
      id: surface.id,
      label: surface.label,
      verdict,
      citations,
      skills: surface.skills,
      reference: referenceUrl(surface.id, manifest?.genre, manifest?.theme),
    };
  });

  const notExpected = ALL_SURFACE_IDS.filter((id) => !expectedIds.includes(id) && !ignore.has(id));

  return {
    lane,
    laneSource,
    declared,
    expectDeclared: manifest?.expect !== undefined,
    expected: expectedIds,
    findings,
    notExpected,
  };
}

const LANE_LABEL: Record<UiReport["lane"], string> = { git: "git lane", document: "document lane" };

/** Compact, greppable rendering — the model reads this, the JSON is for tooling. Model: sweep.ts#formatReport. */
export function formatUiReport(report: UiReport): string {
  const missing = report.findings.filter((f) => f.verdict === "missing");
  const found = report.findings.filter((f) => f.verdict === "found");

  // A `missing` finding has no citations by construction — zero evidence
  // anywhere in the corpus is exactly what the verdict means — so its detail
  // goes straight from the label to the remediation: which skill to load and
  // where to compare against a real game.
  const missingDetail = (f: UiFinding) =>
    [`  ${f.id} — ${f.label}`, `    spawn_skill ids=${JSON.stringify(f.skills)}`, `    reference: ${f.reference}`].join(
      "\n"
    );

  const lines: string[] = [
    `${found.length} found, ${missing.length} missing, ` +
      `out of ${report.findings.length} expected UI surface(s) — ${LANE_LABEL[report.lane]} (${report.laneSource}).`,
    "",
    `MISSING (${missing.length}):`,
    missing.length ? missing.map(missingDetail).join("\n") : "  (none)",
    "",
    // Names only — a "found" verdict says nothing about whether the screen is
    // built or styled, so there is no remediation to point at here.
    `FOUND (${found.length}):`,
    found.length ? found.map((f) => `  ${f.id} — ${f.label}`).join("\n") : "  (none)",
  ];

  if (report.notExpected.length) {
    lines.push(
      "",
      `Not in your expected set, so not scored: ${report.notExpected.join(", ")}. ` +
        'Add any of these to "expect" in audit/ui.json if your game actually has them.'
    );
  }

  // Four cases, and the hint has to be true in each. `declared` is whether the
  // file is on disk; `expectDeclared` is whether the surface set was chosen
  // rather than defaulted. The two come apart when a caller passes `expect`
  // (or just a link hint) inline with no file written — which is exactly the
  // moment the nudge to write one is worth the most.
  if (!report.declared && !report.expectDeclared) {
    lines.push(
      "",
      `No ${UI_MANIFEST_PATH} declaration found — fell back to the baseline set ` +
        `(${report.expected.join(", ")}). Write ${UI_MANIFEST_PATH} with an "expect" list to check ` +
        "the surfaces your actual game has."
    );
  } else if (!report.declared) {
    lines.push(
      "",
      `Checked the surface set passed to this call; there is no ${UI_MANIFEST_PATH} on disk, ` +
        "so nothing here is written down. Put the same list in that file to keep it."
    );
  } else if (!report.expectDeclared) {
    lines.push(
      "",
      `${UI_MANIFEST_PATH} exists but declares no "expect" list — fell back to the baseline set ` +
        `(${report.expected.join(", ")}). Add "expect" to check the surfaces your actual game has.`
    );
  }

  lines.push(
    "",
    '"found" means the surface\'s name appears in a path or identifier — it says nothing about whether the ' +
      "screen is built or styled. spawn_play_screenshot is the authority on how a surface actually looks."
  );

  return lines.join("\n");
}
