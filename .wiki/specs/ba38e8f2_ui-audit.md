# ba38e8f2 — `spawn_audit_ui`: local UI completeness audit

Epic: 9ba39c53 ui-completeness
Branch: `main--epic/9ba39c53_ui-completeness--spec/ba38e8f2_ui-audit`
Status: done — squashed into epic 9ba39c53

## Objective

A local, zero-network audit that reports which of the 21 Interface In Game UI surfaces a
Spawn game project has, which are **thin** (present but citing no art), and which are
**missing** — pointing each gap at the craft skill that fixes it and at a reference URL a
human can open.

The gap this closes is not "the inventory screen looks wrong" — a static scan cannot know
that, and `spawn_play_screenshot` already answers it. It is **"there is no pause overlay,
no game-over screen, and no loading state."** That is a completeness question, it is
answerable by counting, and per the local-audit principle it does not need a browser.

## Acceptance criteria

1. `spawn_audit_ui` returns a rendered report classifying every expected surface as
   `present` / `thin` / `missing`, with `file:line` citations for what matched.
2. It works on **both engine lanes** (R-005) and names which lane it read, and how it
   determined that. On a directory it cannot recognise as either, it refuses with a
   message rather than reporting an empty game.
3. **No network, no credentials, no browser, no push** (R-006). The whole tool runs
   against the filesystem.
4. Every emitted `interfaceingame.com` URL is built from the validated slug allowlists
   below and is **never fetched** (R-007).
5. A surface set the caller did not declare is reported quietly, not as a failure
   (R-004) — a puzzle game is not scolded for having no skill tree.
6. `expect` containing an unknown slug returns the full 21-item menu rather than an
   error (conventions.md → tool descriptions).
7. Unit tests cover: both lanes, each verdict, the unknown-slug menu, the refusal path,
   link construction, and `audit/ui.json` loading. Registered in `package.json` (R-009).

## Design

### The catalog

21 surfaces, keyed by the site's own element slug. Verified 2026-09-10 by reading
`value=` on the `data-type="elements"` inputs in the site's filter markup — these are
authoritative, not derived from labels.

```
character, credits, dialogue, game-over, in-game, inventory, level-selection,
loading, lobby, main-menu, map, overlay, progress, quest, scoreboard, settings,
skill-tree, start-screen, stats, store, tutorial
```

```ts
type UiSurface = {
  id: string;        // the element slug above
  label: string;     // "Skill tree"
  baseline: boolean; // expected in essentially every playable game
  aliases: string[]; // lowercase signals: identifiers, filenames, UI strings
  skills: string[];  // craft skills to load when this surface is missing or thin
};
```

`skills` draws from the real engine menu — `game-ui` and `drawn-art` for every surface,
plus `looks` where colour grade matters and `fx` for transitions (`loading`, `overlay`).
Do not invent skill ids; `spawn_skills` is the authoritative list.

**Baseline set** (used when the game declares nothing): `main-menu`, `in-game`,
`settings`, `overlay`, `game-over`, `loading`. Six surfaces essentially every playable
game has, chosen to be defensible rather than complete. Everything else is genre-
dependent and belongs in a declaration, not a default.

### The declaration — `audit/ui.json` in the *game* project

This server owns the runner; the game owns the assertions. Same split as
`audit/math.json`, for the same reason: per-game intent is not knowledge a generic
server can hold.

```json
{
  "expect": ["main-menu", "in-game", "settings", "overlay", "game-over", "inventory", "map"],
  "ignore": ["credits"],
  "genre": "rpg",
  "theme": "fantasy"
}
```

- `expect` **replaces** the baseline when present.
- `ignore` drops surfaces from every section of the report.
- `genre` / `theme` are validated against the allowlists below and appended to reference
  links. Invalid values are refused with the menu, not silently dropped.

When the file is absent, the report says so and names the baseline it fell back to —
the same shape as the asset bank's `syncAdvice` line.

### Corpus, then detection

Assemble a lane-appropriate corpus, then run one detector over it. The lane decides
**how the corpus is gathered**, not how detection works.

```ts
type UiCorpus = {
  lane: "git" | "document";
  laneSource: string;                                  // how the lane was determined
  files: string[];                                     // relative paths
  texts: Array<{ source: string; text: string }>;      // path or spec pointer + body
};
```

- **Git lane** — walk the world tree for `.js` scripts and scene files. `walkTree` in
  `src/tree.ts` already skips `.git`, `node_modules`, `dist`, `build`; reuse it rather
  than writing a second walker.
- **Document lane** — read `game.json`, collecting object names/ids and embedded script
  bodies, plus any folded-out `scripts/**/*.js` on disk.

Lane determination is **local only** — no `spawn_init`, no credentials. Use a cached
engine reading if one is already on disk, else structural signals (`.spawn/engine.yaml`
and a git checkout → git lane; a bare `game.json` → document lane). Record which in
`laneSource`, the way `EngineInfo.source` exists "so a surprising lane is debuggable".
Neither recognisable → refuse (criterion 2).

Detection scores alias hits, weighting a **path** match above a **text** match, and keeps
up to 3 `file:line` citations per surface.

### Verdicts — named for what they can honestly claim

| Verdict | Means |
|---|---|
| `missing` | Zero evidence anywhere in the corpus. |
| `thin` | Evidence found, but no citing file references art or style — no `cdn/` path, no colour literal, no font, no material or texture call. |
| `present` | Evidence found, and at least one citing file references art or style. |

**`present` means "cites art", not "looks right".** The report must say this in as many
words, and point at `spawn_play_screenshot` as the actual authority. This is R-001: the
scan reports what it can verify and refuses to imply what it cannot. It is the same move
`spawn_asset_preview` makes when it reports existence only for models and audio.

### Report

Pure `formatUiReport(report: UiReport): string`, unit-testable without a server
(`sweep.ts#formatReport` is the model). Sections in order: a headline count and the lane,
`MISSING`, `THIN`, `PRESENT` (names only), then a quiet "not in your expected set" line,
then the declaration hint if `audit/ui.json` was absent, then the `present`-means-cites-art
caveat. Each `missing` / `thin` entry carries its `spawn_skill ids=[…]` call and its
reference URL.

### Reference links

```
https://interfaceingame.com/screenshots/?elements=<slug>[&genres=<g>][&themes=<t>]
```

Built by string concatenation over validated allowlists. **Never fetched** (R-007,
`decisions/0001`).

Verified 2026-09-10 from the site's own filter markup:

- **genres** (15): `action, adventure, card-game, fighting, fps, indie, mmo, music,
  platformer, puzzle, racing, rpg, simulation, sport, strategy`
- **themes** (10): `cartoon, fantasy, horror, medieval, military, modern, pirate,
  pixel-art, sci-fi, western`

## Seam — what spec 9ba39c53/wiring consumes

Spec B (wiring) references this surface and must not invent it. Frozen here:

```ts
export type UiVerdict = "found" | "missing";   // AMENDED — see the amendment below
export type UiFinding = {
  id: string;            // element slug
  label: string;
  verdict: UiVerdict;
  citations: string[];   // "scripts/ui/hud.js:42", up to 3
  skills: string[];
  reference: string;     // the interfaceingame URL
};
export type UiReport = {
  lane: "git" | "document";
  laneSource: string;
  declared: boolean;     // audit/ui.json was present
  expected: string[];
  findings: UiFinding[];
  notExpected: string[];
};
export function scanUi(dir: string, manifest: UiManifest | null): UiReport;
export function formatUiReport(report: UiReport): string;
```

Tool name: **`spawn_audit_ui`**. Verdict words: **present / thin / missing**, exactly
these. Spec B quotes them in tool descriptions and brief text.

## Decomposition

| Phase | Owner | Does |
|---|---|---|
| 1 | leaf | `src/ui-audit.ts` — catalog, manifest schema + loader, corpus for both lanes, detection, verdicts, `formatUiReport`. Plus `test/ui-audit.test.ts` and its `package.json` registration. |
| 2 | leaf | `spawn_audit_ui` in `src/audit-tools.ts`; README section; CHANGELOG; version bump. |

Sequential — phase 2 builds on phase 1's exports — so both commit into this spec's
worktree. No impl worktrees.

## Outcome

Shipped as `spawn_audit_ui` in 2.1.0. `src/ui-audit.ts` (~720 lines) + `test/ui-audit.test.ts`
(30 cases), registered in `src/audit-tools.ts`.

All seven acceptance criteria met. Verified independently of the implementing agents'
reports: the three slug vocabularies match the authoritative lists exactly (21/15/10);
the module contains no network call (the only URL is a string constant); `npm run check`
is 388 pass / 0 fail; the rendered report was inspected against fixtures on both lanes.

Two deviations from the design as first written, both corrections rather than changes of
intent:

- `UiReport` gained **`expectDeclared`**. `declared` had been set from "a manifest object
  was passed", but the tool builds one out of its own arguments, so passing `genre` with
  no `audit/ui.json` on disk claimed a declaration existed and suppressed the nudge to
  write one — at the moment that nudge is worth the most. `declared` now reads the
  filesystem; `expectDeclared` records whether the surface set was chosen or defaulted.
  The two come apart in four combinations, and the hint says something true in each.
- `UI_MANIFEST_PATH` is exported from `src/ui-audit.ts` rather than spelled separately in
  the tool layer, since `scanUi` reads the path too.

`ignore` is validated against the surface menu as well as `expect`, and manifest contents
are re-validated inside `scanUi` and not only in `loadUiManifest` — `scanUi` can be handed
a manifest built outside the loader, as the tool in fact does.

**Post-merge fix, on the epic branch (`3b5f2d5`).** The corpus stopped reusing `tree.ts`'s
`walkTree` and grew its own `walkForCorpus`. `walkTree` stats rather than lstats, so it
follows symlinks and keeps no visited set: measured on a tree whose `scripts/ui/loop` links
back to `scripts/`, it returns **64 paths for one real file**, nested to depth 129 before
the OS refuses the path — the corpus would read that file 64 times and cite it at 64
absurd paths — and a link out of the project is read in too. Neither is fixable after the
walk, since the duplicates are produced during it.

`walkTree` itself is deliberately unchanged: it is also `spawn_validate`'s, and altering
what gets syntax-checked before a push is a decision of its own. **That hazard therefore
remains live for `spawn_validate` and is not closed by this epic** — it wants its own spec.

Both lanes use the new walker (the document lane also walks for folded-out scripts). Two
tests cover it, platform-gated on the ability to create directory junctions.

Recorded in the 2.2.0 CHANGELOG entry rather than as a patch release: neither 2.1.0 nor
2.2.0 had been tagged or published, so a 2.2.1 would have implied 2.2.0 shipped with the
bug.

## Amendment — the `present` verdict is withdrawn (post-review, orchestrator-authorised)

Review found the three-verdict scheme unsound, and the fix is to claim less rather than
to detect harder.

**What was wrong.** `present` required an "art signal" — a `cdn/` path, colour literal,
font, or material call — anywhere in a file that cited the surface. Two independent
defects, both reproduced:

- **UI-C1.** Six of the 21 ids are ordinary programming words, and the id is itself a
  needle matching a bare token anywhere in a line. `items.map(i => i.name)` plus
  `'#ff0000'` anywhere in the same file scored `map` as **present**. Likewise
  `let loading = false`, `export const settings = {…}`, `// while in game`,
  `store(k, v)`, `let progress = 0`. `settings`, `loading` and `in-game` are baseline
  surfaces, so this fired on the default no-manifest path.
- **UI-C2.** The document-lane corpus collected only `id`/`name`/`type` values, so
  `hasArtSignal` only ever saw a newline-joined identifier list — which by construction
  cannot hold a colour, a font, or a `cdn/` path. A pure-spec document-lane game could
  **never** score `present`, while the identical JSON in a `.scene` file on the git lane
  did. Two lanes disagreeing about the same game is R-005.

**Why not just fix the detection.** A false `present` is the worst outcome this design
can produce — the module header says so — because it removes a surface from both MISSING
and THIN, so a screen that does not exist never reaches the report, the brief, or the
conductor backlog. Any text heuristic sharp enough to be trusted here would be claiming
to see a rendered screen, which is exactly what R-001 forbids and what
`spawn_play_screenshot` already does properly.

**The new vocabulary. `UiVerdict = "found" | "missing"`.**

| Verdict | Means |
|---|---|
| `missing` | No evidence anywhere in the corpus. |
| `found` | The surface's name appears in a path or identifier. **Says nothing about whether the screen is built, complete, or styled.** |

The art-signal machinery (`ART_SIGNALS`, `hasArtSignal`, `detectSurface`'s `artSignal`)
is **deleted**, not disabled. The report's caveat becomes: *found means the name appears,
not that the screen is built or styled — judge it with `spawn_play_screenshot`.*

This keeps the tool pointed at the only question it can actually answer, which is the
question it was built for: **what did you never build at all.**

## Post-review defect fixes

- **UI-C1** — a single-token needle matches **paths only**, never free text; multi-token
  needles match both. A filename is deliberate naming; a bare word in a line is not. This
  costs recall on games with unconventional naming, and that trade is the design's stated
  preference: a false `missing` sends someone to build what exists, a false `found` hides
  a gap.
- **UI-C2** — the document lane feeds the whole non-`scripts` GameSpec body as a text
  source, the way `src/assets.ts` already does with `JSON.stringify` to harvest `cdn/`
  paths. Nested UI objects stop being invisible.
- **UI-C3** — a cached engine reading no longer bypasses the refusal: the directory must
  still look like the lane the cache names, or `scanUi` refuses. An empty report and
  "this is not a Spawn project" must never look the same.
- **UI-C4** — no line number is emitted for a synthetic source; a citation must name a
  line that exists in a file.
- **UI-C5** — an unknown slug names where it came from. Blaming `audit/ui.json` for a
  tool argument is wrong when no such file exists.
- **UI-C6** — `expect` is de-duplicated before scoring; duplicates inflated the headline.
- **UI-C7** — the map-vs-mapping test asserted a weaker property than its name claimed.

## Second review iteration (UI-C9 … UI-C14)

The rewrite above was re-reviewed, and it had introduced two new high defects of its own.
Both reproduced before acting.

- **UI-C9** — the single-token rule missed `in-game`, which tokenizes to `in` + `game`:
  two tokens, so it stayed a text needle. `in` is a JS keyword sitting beside `game*`
  constantly, so `for (const key in gameObjects)` scored the in-game HUD as `found`. A
  baseline surface, so it fired on the default path. **Fix:** a needle whose every token
  is a stopword loses its text channel. The list is 11 words and deliberately tiny —
  `over` is absent, so "game over" still matches; `in-game` keeps its filename channel
  and its `hud` / `crosshair` / `health-bar` aliases.
- **UI-C10** — an unparseable `game.json` was swallowed, so the scan succeeded against an
  empty corpus and `missingUiSurfaceLabels` returned six surfaces instead of `null`. Its
  own doc comment promised `null`. This is UI-C3's lie through a second door: a brief
  printing six screens of work for a spec nothing ever read. **Fix:** refuse.
- **UI-C11** — `JSON.stringify` with no indent collapsed the spec to one line, so any two
  adjacent fields formed a phrase (`{"level":{"selection":…}}` → level-selection).
  **Fix:** indent, so detection sees the real field structure.
- **UI-C12** — the document lane has essentially one file path, so the path-only rule left
  15 of 21 surfaces with no detection channel there at all, while the same game on the git
  lane resolved fine. **Fix:** a `names` channel — every JSON key plus `id`/`name`/`type`
  values. A key is chosen the way a filename is, so it earns a filename's trust; free
  prose in a string value does not.
- **UI-C13** — with `audit/ui.json` present, a bad id from the *argument* was blamed on the
  file. `scanUi` is handed the merge and genuinely cannot tell, so it now names both
  rather than picking one and being wrong half the time.

### Accepted, not fixed

**UI-C14** — a two-token needle still matches non-UI text: `texture-world-map.png` scores
`map`, `console.log('download progress bar')` scores `progress`, and `{"press":"start"}`
scores `start-screen` via the `press-start` alias. This is the cost of the text channel
existing at all, and it is the *cheap* direction of error: a false `found` leaves a
surface off the MISSING list, where a human still sees it under FOUND with a citation
they can check. Narrowing further would cost real recall on the lane that needs it most.
Stated here rather than silently tolerated.

## Out of scope

- Any network call, to interfaceingame.com or anywhere else.
- Judging how a surface *looks*. That is `spawn_play_screenshot`.
- Changes to `src/tools.ts`, `src/brief.ts`, or the savi-conductor skill — that is spec B.
