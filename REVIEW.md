# Review (capture)

> Status: **captured; §E built.** This document writes down the review that already happens,
> sourced line by line to where each check currently comes from, so that mechanizing it is
> transcription rather than invention. Section E (math) now ships as `spawn_audit_scan` and
> `spawn_audit_math`; everything else is still a capture.

## The finding

The review has three categories in practice — **math**, **assets**, **UX flow** — and the
repo specifies exactly one of them.

| Category | Specified where | How much |
|---|---|---|
| Assets | `ASSET-BANK.md`, `src/asset-tools.ts`, `src/assets.ts` | Thoroughly, with tooling behind it |
| Visual craft | `src/session.ts:18-23`, `src/tools.ts:778`, `src/play-tools.ts:193` | A failure signature and a remedy, no criteria |
| Runtime / errors | `README.md:60-66`, `src/tools.ts:939` | Which instrument to use, not what to conclude |
| **UX flow** | `src/session.ts:30` — one sentence | Effectively nothing |
| **Math** | *nowhere* | Nothing. Zero occurrences of balance, formula, rate, NaN, tuning |

So the hours are not going into re-reading a long checklist. They are going into a model
**re-deriving two absent checklists every session**, and paying for that derivation through
the slowest instrument available — a headed browser, a screenshot, and a judgment call per
observation. The category that *is* written down is also the one that already has tools.
That is the whole story of the runtime.

## Tiers of evidence

Every check below is tagged with what it costs to answer.

| Tier | Instrument | Cost | Deterministic? |
|---|---|---|---|
| **L** | Local files + `compile()`. No network, no browser. | ms | yes |
| **N** | One HTTP call. Schema validate, CDN `200/404`. | ~100ms, batchable | yes |
| **B** | Headed Chromium + a live room. | seconds, serial, fragile | mostly |
| **J** | A model looks and decides. | slow, non-repeatable, the real cost | no |

**J never travels alone** — it always rides on B or N. That is the lever. A check pinned at
J because nobody wrote down its criteria is not inherently a judgment call; it is an
unspecified one. Cost falls in two ways: move a check down a tier, or batch the J that
genuinely remains so one look answers twenty questions.

---

## A. Spec integrity — tier L/N, already automated

These run today and are the only part of the review that is already a gate.

| # | Check | Source | Tier |
|---|---|---|---|
| A1 | Project compiles: `game.json` + `world/*.json` + `scripts/**` | `src/compile.ts` | L |
| A2 | Server schema validation passes | `spawn_validate`, `src/tools.ts:742` | N |
| A3 | New issues distinguished from pre-existing debt; `pushable` vs `valid` | `src/tools.ts:762-766` | N |
| A4 | No unresolved `.theirs` receipts | push refuses, `README.md:140` | L |
| A5 | Edits stay inside claimed key paths / globs (advisory) | `README.md:109` | L |
| A6 | No symlink escape, no script path escape | `src/compile.ts:56-63` | L |

**Known blind spot, already documented:** `world/*.json` overlays are deep-merged at compile
time and never reconciled, so a stale overlay silently re-applies over freshly pulled content
(`README.md:142`). Nothing warns. This is an L-tier check that does not exist yet.

## B. Assets — tier N + J, well specified, partly automated

The implicit checklist, extracted from `ASSET-BANK.md` and the asset tool descriptions.
Order matters: 1–3 must happen *before* a name is invented, because a path cannot be re-rolled.

| # | Check | Source | Tier |
|---|---|---|---|
| B1 | Bank was searched before the name was invented | `src/asset-tools.ts:385` | L |
| B2 | Bank is fresh enough that "no match" means something | `syncAdvice`, `src/assets.ts:164-177` | L |
| B3 | Path is namespaced `moodboard-<slug>/`, not bare global root | `README.md:194`, `src/assets.ts:332` | L |
| B4 | Style slug is consistent across the world (one namespace per game) | `src/session.ts:21` | L |
| B5 | Path is not marked `bad`, or has a `replacedBy` pointer | `src/assets.ts:897` | L |
| B6 | Asset actually exists on storage (`200`, not `404`) | `spawn_asset_preview`, `src/asset-tools.ts:574` | N |
| B7 | Every `cdn/` path referenced by the spec resolves | — | N |
| B8 | *Reverse:* nothing referenced is absent from the bank | — | L |
| B9 | Image looks like what was intended | inline preview | **J** |
| B10 | Models / audio look right **in world** (preview can't judge them) | `README.md:232` | **B+J** |
| B11 | Judgment recorded via `spawn_asset_note` while still visible | `src/asset-tools.ts:456` | J |

B1–B8 are all mechanical and only B6/B7 need the network. **B7 does not exist as a tool** —
today it is N-tier work done one `spawn_asset_preview` call at a time, which is where a
meaningful slice of the hours goes. Walking the compiled spec for every `cdn/` reference and
batch-checking existence is the single highest-value thing on this page.

B9 stays J, but it should be *one batched look* at a contact sheet, not N inline previews.

## C. Visual craft — tier B+J, a signature but no criteria

| # | Check | Source | Tier |
|---|---|---|---|
| C1 | Screenshot taken after **every** meaningful push, and looked at | `src/session.ts:29`, `src/brief.ts:87` | B |
| C2 | Reads as a game, not grey boxes / flat untextured shapes / default DOM | `src/play-tools.ts:193` | **J** |
| C3 | Failure attributed correctly: plain look = missing *skill*, not missing feature | `src/tools.ts:778` | J |
| C4 | Matches stated intent | `src/session.ts:23` | J |

The remedy is named precisely (`drawn-art`, `custom-materials`, `looks`, `game-ui`,
`world-composition`, `fx`, `slash-vfx`, `3d-sprites`, `match-a-reference`) but the *criteria*
are not here — they live in ~60 server-side skills this repo only indexes. **Any attempt to
systematize C without reading those skills will encode a guess.** Fetch them first.

C1 is mechanizable as a *precondition* even though C2–C4 are not: "was a screenshot taken
after the last push" is answerable from session state.

## D. Runtime and behavior — tier B, instruments known

| # | Check | Source | Tier |
|---|---|---|---|
| D1 | WebGPU adapter present (`webgpu: "ok"`) — else every screenshot is a false negative | `src/play-tools.ts:120` | B |
| D2 | No `pageerror` / console errors | `spawn_play_console` | B |
| D3 | No server-side script errors | `spawn_logs` | B |
| D4 | Live world state matches intent | `spawn_exec`, `src/tools.ts:939` | B |
| D5 | Persistence verified through **replicated state** — no SQL exists | `README.md:66` | B |
| D6 | Client reshaped after push (else hard reload) | `src/play-tools.ts:266` | B |

D1 deserves promotion to a hard gate. It is the check that, when it fails, invalidates every
downstream visual observation — and it currently reports rather than blocks.

D2/D3 are B-tier only because a room must be live; the *assertion* is mechanical. They should
be pass/fail lines in a report, never something a model reads and interprets.

## E. Math — was unspecified, now built

Nothing in this repo asked for a single numeric check. Every math review to date was
improvised, which explains both the time it took and why it did not come out the same twice.

**Now shipped** as `spawn_audit_scan` + `spawn_audit_math` (`src/harness.ts`, `src/sweep.ts`,
`src/audit-tools.ts`). Measured on the game above: **1,020 calls across 6 checks in 72 ms**,
no browser, no live room, no push, no credentials.

What it asserts, all of it tier **L** — game scripts are plain JS and run under Node
with no WebGPU and no server:

| # | Check | Tier |
|---|---|---|
| E1 | No `NaN` / `Infinity` reachable in any formula over its input range | L |
| E2 | No divide-by-zero at boundary inputs (0 hp, 0 speed, empty inventory) | L |
| E3 | Monotonic where intent says monotonic (more level → more damage) | L |
| E4 | Outputs stay inside declared bounds (hp never negative, no negative price) | L |
| E5 | Time-to-kill / time-to-goal inside a sane band | L |
| E6 | Economy not net-inflationary per loop | L |
| E7 | Rates and timers do not diverge (spawn rate, respawn, cooldown) | L |
| E8 | Units consistent — per-second vs per-tick not mixed | L |

### The separability precondition — resolved, and it holds

Measured against `King of The Mud, Spawn` (77 scripts, ~39.5k lines) and the cached
`.spawn/tome-api.md`. Four properties make an L-tier harness viable:

| Property | Evidence |
|---|---|
| **`objectApi` is injected, never imported** — hooks are `update(dt, api)`, `onSpawn(api)` | `tome-api.md:56`, `:180-181` |
| **Coupling is greppable** — engine-touching functions take `api` as a parameter; pure ones don't | `spawnWave(api, …)` vs `planWave(tier, waveInTier, popMult)` |
| **The module graph is closed** — `require()` resolves `lib/*.js`, `lib/data/*.json`, `builtin/*` and nothing else. No URL imports, no dynamic require | `tome-api.md:64` |
| **Tunables are already externalized** — engine doctrine puts data in `scripts/lib/data/*.json` | `tome-api.md:63`, `:198` |
| **No `import` statements exist at all** — so nothing needs ES module linking | measured: 0 across 77 scripts |

The measured split in that game:

| | Files | Lines |
|---|---|---|
| Zero `api.` references | 44 | **24,076 (61%)** |
| Engine-coupled | 33 | 15,433 |

`scripts/lib/data/` holds 27 tunable files (`battle.json`, `units.json`, `tiers.json`,
`eras.json`, `formations.json`, `abilities.json`, …), and the balance math is already pure:
`planWave(tier, waveInTier, popMult)` is 180 lines with **zero** `api.` references.

**The convention I assumed was missing is the engine's own doctrine, and this game follows it.**

Three things the implementation corrected about the paragraph above:

1. **Exports come in two systems, not one.** Behaviours use `export function`; 17 of the
   `lib/*.js` helpers — including `economy.js` (942 lines) and `tactics.js` (456) — end in
   `module.exports = { … }`. An earlier count that grepped only `^export` missed them, and
   they are where most of the pure math actually lives: a scan that reads both finds **271**
   exported functions where one reading only ESM finds 97.
2. **The math path needs no builtins at all.** Every `require("builtin/…")` in the tree sits
   in a render, FX, geometry, material or audio script. `battle-system.js`, `economy.js`,
   `tactics.js`, `grid.js`, `ant.js` and `colony.js` require **zero**. So the builtins are a
   portability concern, not a dependency — and the engine-only ones (`fx`, `geom`, `three`,
   `tsl`, `vibe`, `room-routing`, `primitives`) are better refused than stubbed, since a stub
   lets a check pass against behaviour that never ran.
3. **`waveMult` is module-private, not exported.** The exported pure surface of
   `battle-system.js` is `planWave` and `waveLabel`. A private function is only reachable
   through what calls it — which is a limit on what any local harness can assert.

**One real constraint remains.** Scripts are a syntax hybrid: ESM `export …` *plus* bare
`require()` and `module.exports`. Node ESM has no `require`, so they cannot be `import()`ed.
Because there are no `import` statements, though, no ES module linking is needed and
`vm.Script` is enough — no `--experimental-vm-modules`, no source-level module graph.

**Caveat on the sample:** one game. `King of the Mud 2026` is an empty scaffold, and the other
sibling directories are not Spawn projects. Confirm against a second real game before treating
61% as typical rather than as one data point.

### This is already being done by hand, per game

`King of The Mud, Spawn` carries **7,713 lines of local audit tooling** in `tools/` — 16 files
written over three days: `sim.js` (905 lines, a headless battle simulator that plays out
35-wave runs), `economy-check.js`, `formation-check.js`, `legibility.js`, `lum.js`,
`hud-check.js`, `gen-check.js`, and more.

That settles the question of whether local checking is worth building: someone already found it
necessary and built it, ad hoc, inside one game. What is missing is not the idea but the
**shared runner** — and `sim.js` shows exactly what that costs. Its loader strips every
`require` and hand-injects the dependencies from two parallel arrays, and its own comment
records the bill:

> eras.json arrived in battle-system for the display-only enemy skins, ERAS was missing here,
> and the 35-wave run died partway through the first boss summon. Ten minutes to diagnose.

A loader that resolves `require` instead of stripping it cannot have that failure. That is the
argument for one runner in this server rather than sixteen in each game.

## F. UX flow — one sentence today

The entire current specification is `src/session.ts:30`: *"Exercise gameplay with
`spawn_play_input` (WASD, Space, clicks), then screenshot again."* No notion of a flow,
a checkpoint, a softlock, or reachability.

| # | Check | Tier |
|---|---|---|
| F1 | Named flows exist (spawn → move → interact → objective → outcome) | L |
| F2 | Each flow runs start to finish without a dead end | B |
| F3 | Every UI affordance is reachable by coordinate click | B+J |
| F4 | No softlock: every state has an exit | B |
| F5 | State asserted at each checkpoint via `spawn_exec`, not by eye | B |
| F6 | Screenshots captured at checkpoints and reviewed as **one batch** | J |

`spawn_play_input` already takes an ordered action array (`src/play-tools.ts:231`), so a flow
is expressible as data today. That turns "a model plays and looks at everything" into "a
script plays, a model looks at six frames" — the largest available reduction in J.

**Constraint that shapes all of F:** game UI renders in a cross-origin sandboxed iframe, so
`spawn_play_eval` cannot see or click it (`README.md:65`). Screenshot → read coordinates →
click is the only UI loop that exists. Coordinates are therefore resolution-dependent, and a
recorded flow is only replayable at a pinned viewport size.

---

## Where the time actually goes

| Tier | Checks | Automated today |
|---|---|---|
| L | 19 | 6 in section A, plus the §E runner (E1–E8; assertions are per-game) |
| N | 4 | 2 |
| B | 12 | 0 — instruments exist, assertions don't |
| J | 8 | n/a by definition |

Nineteen checks are answerable from local files alone, and before `spawn_audit_math` thirteen
of them cost browser time or model reasoning instead. Four are still written down nowhere: F1,
B7, B8, and the `world/*.json` staleness gap.

**The review is not too thorough. It is thorough at the wrong tier.**

## Order

1. ~~**E1–E4** — a Node harness that loads `scripts/**` and sweeps pure functions.~~ **Done.**
   `spawn_audit_scan` reports what is auditable; `spawn_audit_math` runs an `audit/math.json`
   manifest and reports the exact arguments that broke a rule.
2. **B7** — walk the compiled spec, batch-check every `cdn/` reference. Pure N, generic across
   games, and this server already owns `compile()` and the CDN client. Now the top item.
3. **D1 as a gate** — refuse to record visual findings when `webgpu !== "ok"`.
4. **F1/F6** — flows as data, screenshots batched at checkpoints.
5. **C** — only after reading the visual skills. Encoding a guess here is worse than leaving
   it to judgment.

### What the first real run found

Six checks over `planWave` and `waveLabel`, 1,020 calls, 72 ms. Five pass. The manifest lives
in the game at `audit/math.json`, and two of its entries are worth reading as examples of what
this kind of check is for:

- **`formation-fits-at-authored-pop` fails at exactly one point: T3.3, `spilled: 1`.** At the
  baseline population the game is tuned at, one wave has a body that could not stand in the
  slot its shape asked for and had to ring outward. Not a crash, not a dropped body — a
  formation that does not fit the space it was written for, in one wave out of sixty. This is
  the archetypal finding for tier L: invisible in play (you would see a slightly-off formation
  once and never register it), instant and exact from a sweep.
- **Body count is NOT monotonic, and the manifest records that as a non-invariant.** The first
  version of this check asserted that waves grow with tier. It failed — T2.2 is 10 light
  bodies, T3.2 is 5 heavy ones, because composition carries the difficulty and body count
  falls whenever the table swaps up a weight class. The assertion was wrong, not the game.
  Writing the refuted invariant down under `_notInvariants` is what stops the next reviewer
  re-deriving it.

The second point generalizes: a sweep is only as good as the invariant, and the fastest way to
learn the real one is to assert the obvious one and watch it fail in 70 ms.

Split of ownership, if it becomes tooling: this server provides the **runner** (compile, walk,
sweep, batch-fetch), the game project provides the **assertions**. Test runner versus tests.
Per-game invariants do not belong in a generic MCP server.

Output should be a machine-readable report keyed by check id, so a re-run after a one-line fix
re-checks what changed instead of repeating the whole pass. Repeating the whole pass after
every small fix is, at a guess, where most of the hours actually went.
