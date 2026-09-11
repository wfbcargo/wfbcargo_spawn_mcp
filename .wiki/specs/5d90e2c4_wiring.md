# 5d90e2c4 — Wire `spawn_audit_ui` into the moments it matters

Epic: 9ba39c53 ui-completeness
Branch: `main--epic/9ba39c53_ui-completeness--spec/5d90e2c4_wiring`
Status: done — squashed into epic 9ba39c53

## Objective

`spawn_audit_ui` exists (spec ba38e8f2) and nothing calls it. Make it reachable at the
three moments a UI gap is actually actionable, so the audit stops being a report someone
has to remember to run and becomes something the build loop consumes.

This repo already holds the position this spec depends on, in the README's own words:
the endpoints are *shaped to pull craft in* rather than relying on a prompt telling the
model to go and read things. `spawn_push` and `spawn_play_screenshot` already say in
their own descriptions that a plain-looking result is a missing skill rather than a
missing feature. This spec extends that same move to the complementary question.

**Screenshot answers "how does what I built look". The audit answers "what did I never
build at all".** Every piece of wiring below is that one sentence, placed where it fires.

## Acceptance criteria

1. `spawn_push`'s description points at `spawn_audit_ui` in one clause — not a paragraph.
2. `spawn_brief` output names the game's missing UI surfaces when there are any, and says
   nothing about UI when there are none.
3. The savi-conductor skill gains a UI check in **step 6 (Maintain)**, turning `missing`
   surfaces into `ready` backlog entries.
4. No behaviour change to `spawn_audit_ui` itself; `src/ui-audit.ts` and
   `src/audit-tools.ts` are not edited.
5. `npm run check` passes. Existing brief tests still pass, and new brief behaviour is
   covered in `test/brief.test.ts`.
6. README and CHANGELOG reflect the wiring; version → 2.2.0.

## The three wiring points

### 1. `src/tools.ts` — `spawn_push` description (~line 1150)

It already ends with: *"a successful push proves it parsed, nothing more — look at
`spawn_play_screenshot` before calling the work done, and if what you pushed is visual
and untextured or plainly styled, the missing piece is a skill you did not load."*

Add **one clause** naming `spawn_audit_ui` for the other half — what is not there at all.
That description is already long and R-004 applies to descriptions as much as to reports:
a sentence that does not change what the model does next is noise. Do not restate the
verdict vocabulary here; the tool's own description carries it.

### 2. `src/brief.ts` — `renderBrief` / `renderHandoff`

Both are pure and hand back a prompt; ownership of the fleet stays with the LLM. Keep
that. A brief that names missing surfaces gives a builder — or Savi — a concrete starting
list instead of "make it look good".

**These functions must stay pure.** They take an input record and return a string; they
do not read the filesystem and do not call `scanUi`. So the missing-surface list arrives
as a new optional field on `BriefInput` / `HandoffInput`, and the caller supplies it.
Follow how `yourClaims` / `othersClaims` already work.

Omit the UI clause entirely when the list is empty (R-004). A brief that says "no UI gaps"
every time trains the reader to skip the line.

### 3. `.claude/skills/savi-conductor/SKILL.md` — step 6 "Maintain" (~line 122)

**Step 6, not step 5.** Step 5 is the per-tick build loop; a UI audit there fires every
tick and becomes noise. Step 6 already keeps `areas/*.md` current on a slower cadence and
is where the wiki is reconciled with what actually landed.

The check turns `missing` surfaces into `ready` backlog entries in the conductor's wiki,
which later ticks dispatch to Savi through the existing step 4. That closes the loop —
the audit's output becomes scheduled work rather than a report.

Match the file's existing register: terse imperative bullets, concrete tool calls, and
the honesty guards it already uses ("absence is not failure"). Two that apply here: do
not re-add a surface already in the backlog, and a `thin` verdict is not a missing
feature — it is a styling task, and only worth queueing if the area is otherwise done.

## Outcome

Shipped in 2.2.0. All six acceptance criteria met; `npm run check` 390 pass / 0 fail.

- `spawn_push` gained one trailing clause, no verdict vocabulary restated.
- `BriefInput.missingUiSurfaces?: string[]`; `renderBrief` renders one line when
  non-empty and is silent otherwise. `brief.ts` has no `node:fs` and no `scanUi` import —
  purity held.
- `src/team-tools.ts` is the non-pure caller: `missingUiLabels(dir)` loads the manifest,
  runs `scanUi`, returns `missing` labels, wrapped in try/catch and gated on the worktree
  existing. An unrecognisable project or a bad `audit/ui.json` drops the brief's UI line
  rather than failing the whole `spawn_team_brief` — the same posture as the
  head-version lookup beside it.
- Conductor step 6 gained one bullet, carrying three honesty guards: slower cadence only,
  never re-add a surface already in the backlog, and `thin` is a styling task rather than
  a missing feature.

**Deviation, accepted:** `renderHandoff` did *not* get the field. The distinction the
leaf drew is right and worth keeping — `renderBrief`'s fields are all server-computed
state the model cannot otherwise see, which is why they are threaded through a typed
record `team-tools.ts` populates. `renderHandoff`'s `task` and `message` are authored
per-call by the model, which already holds the audit output in context and can put it
straight into the prose. A structured field there would duplicate free text for an
audience (Savi, via studio chat) that never parses a machine field.

**Note for a future spec:** `spawn_team_brief` now runs one full tree walk per agent
worktree. It is a deliberate, occasional call rather than a hot path, and the worktrees
are genuinely distinct so the scans cannot be shared — but the tool does materially more
I/O than it used to.

## Out of scope

- Any change to `src/ui-audit.ts` or `src/audit-tools.ts` — spec ba38e8f2 owns those and
  is merged.
- Making `spawn_brief` or the conductor call the audit *automatically* from inside this
  server. The brief stays pure; the conductor is a skill the model executes.
- Any network call.
