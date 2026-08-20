---
name: savi-conductor
description: >-
  Run a capacity-gated delegation loop over a Spawn game built through the spawn MCP.
  Maintain a git-tracked wiki of intent, fan broad slices out to Savi's sub-agents whenever
  lanes are free (spawn_savi_status), build one lane yourself, and verify landed work by
  screenshot. Self-paces via ScheduleWakeup. Use when conducting a long-running Spawn build
  through Savi, or when the user asks to run the Savi conductor / delegation loop
  (e.g. "/loop /savi-conductor", "conduct the build", "keep Savi's lanes full").
---

# Savi conductor

You are the conductor of a Spawn build. Savi has up to **8 sub-agents** (wisps); this loop
keeps them fed from a durable wiki, builds one lane itself, and verifies what lands.

## The one fact everything follows from

`spawn_savi` is **fire-and-forget**: no reply, no acknowledgement, no completion event, and
no endpoint reports who pushed. The wiki is the reply channel the API won't give you — you
keep the other half of the conversation on disk and reconstruct completion by inference
(head moved **and** a screenshot matches intent). Three consequences run through this skill:

- **A head bump is not proof a task is done.** Verify by *looking*, never by the version
  number alone. Head could move from Savi, the creator, a teammate, or your own push.
- **You cannot see which wisp owns which task.** So hold a dispatched task for a few minutes
  on real evidence before re-sending it, and never dispatch more slices than there were free
  lanes.
- **The wiki outlives your context.** When your chat is compacted, a fresh conductor
  re-enters by reading `index.md` and following links. Keep it true, or the loop rots.

## Mode

**Hybrid, self-scheduling.** You build one lane yourself and fan the rest out. You pick your
own next wake time from how full the fleet is. Run this in `/loop` dynamic mode
(`/loop /savi-conductor`, no interval) so each tick ends by scheduling the next.

## Preconditions (check every tick)

1. **A headed play session is open.** It is both the wisp sensor (`spawn_savi_status` reads
   the open play page) and the screenshot verifier — the same window does both. If none is
   open, `spawn_play_open` first. The session is a server-side singleton that survives
   between wakeups, so normally you open it once on the first tick and every later tick
   finds it already up.
2. **One conductor per fleet.** `spawn_savi_status` is account-wide across the studio. Two
   conductors would double-count vacancy and thrash Savi. If team mode is on, exactly one
   agent runs this loop; the others build their own claimed lanes.

## First tick: bootstrap the wiki

If `docs/savi-wiki/index.md` does not exist, build it and stop dispatching until it has a
backlog:

1. Copy the files in this skill's `templates/` into `docs/savi-wiki/` (`index.md`,
   `vision.md`, `backlog.md`, `log.md`, and `areas/` from `area.md`).
2. **Ingest the creator's thinking.** If they pointed you at notes, a design doc, or a
   previous wiki, split it: the *why* and pillars into `vision.md`, each subsystem into
   `areas/<name>.md`, and the work into `backlog.md` as **broad, ready** slices — outcomes,
   not step lists. If they didn't, draft a skeleton from the game and ask them to fill the
   pillars before you dispatch anything.
3. **Choose your lane.** Pick one area you will build yourself; record it in `index.md`
   under "Conductor lane". It becomes `keepOff` on every handoff.
4. `git add docs/savi-wiki && git commit` so the thinking is durable and diffable.
5. If the backlog now has `ready` tasks, schedule a short wake and return — do not dispatch
   on the bootstrap tick. If it has none (the pillars are unfilled, or you had nothing to
   ingest), say plainly what the wiki still needs from the creator and
   `ScheduleWakeup({ stop: true })` — do not spin an empty loop waiting for work that only a
   human can add.

## The tick

Idempotent. Read the wiki fresh each time; trust it over your memory.

### 1. Sense
- `spawn_savi_status` → `{ free, busy, workingOn }`. This is your vacancy signal.
- `spawn_status` → `headNow` (the current `remote.headVersion`).

### 2. Reconcile the verify queue
Head moving is a **prompt to look, not a verdict** — other tasks (or your own push) may
have advanced it while a given task is still running. So if `headNow` moved past *any*
dispatched stamp, `spawn_latest` to pull, then look at each in-flight task's intent:
`spawn_play_screenshot`, or the task's named `verify` flow (`spawn_exec` for state,
`spawn_play_input` for an interaction). For each `dispatched` task, judge as a player would:
- **Intent visibly satisfied** → `verified`. Append to `log.md` with the head and verdict.
- **Intent visibly built but wrong or broken** → `reopened` with a one-line note on what's
  wrong; it re-enters the ready pool.
- **Not yet visible** → leave it `dispatched`. Absence is not failure — it may still be
  running. Step 3 is what rescues a genuinely dropped task, not this.

Two things that keep this honest:
- **One head bump can cover several dispatched tasks, or none of them** — check each intent
  against the world, never infer "one bump clears one task".
- **Rule out your own pushes.** If the bump matches a version you recorded under "Own
  pushes" in `log.md`, it is yours, not a Savi landing — do not credit it to a task.

### 3. Un-stick (re-delegation guard)
A task can be dropped silently — picked up and abandoned, or never picked up. Rescue one
only on real evidence, so you don't re-send work that is still running. For each
`dispatched` task where **all** of these hold: head has not moved past its stamp; at least
~5 minutes have passed since its `at` stamp (compare timestamps — it is wall-clock, not a
tick count); and a lane has since freed with no landing (weak evidence it may have dropped)
— return it to `ready` with a note. Do **not** touch `attempt` here; that is incremented
only at dispatch (step 4), so a rescued task is just ready again.

### 4. Dispatch to fill vacancy
If `free > 0` and `ready` tasks exist:
- `keepOff` = your conductor lane ∪ the areas of every currently `dispatched` task.
- Pick up to `free` of the **broadest** ready tasks (whole-area slices; if two ready tasks
  share an area, send one, not both — they would collide). Skip any task whose `attempt`
  has reached 3 → mark it `blocked` with a note instead of throwing it at the fleet again.
- For each: `spawn_savi(message=<what just changed / context>, task=<the outcome, stated
  broad>, keepOff=<the set above>)`. Then stamp it `dispatched: head=headNow, at=<now iso>,
  attempt=<previous attempt + 1>`.
- Never dispatch more than `free` — oversubscribing queues behind the fleet and then reads
  as "running" when you reconcile.

### 5. Build your lane
Spend the rest of the tick doing real work in your own area: edit → `spawn_validate` →
`spawn_push` → `spawn_play_screenshot`, look, iterate. **Record every push you make under
"Own pushes" in `log.md`** so step 2 next tick doesn't mistake your bump for a Savi landing.

### 6. Maintain
- Update the status counts and `head at last reconcile` in `index.md`.
- Keep `areas/*.md` current where work landed — concrete state (files, object roots, what a
  screenshot shows), so a fresh conductor trusts the wiki over guesswork.
- Commit only if the wiki changed this tick: `git add docs/savi-wiki`, and if `git diff
  --cached --quiet` reports changes, `git commit -m "conductor: tick <iso>"`. A tick that
  only looked and found nothing new leaves no commit. The history is the build's audit trail.

### 7. Pace and reschedule
- **Done?** No `ready`, no `dispatched`, no `reopened`, and your lane is finished →
  `ScheduleWakeup({ stop: true })`, tell the user, and stop.
- Otherwise choose the next delay from fleet state and call `ScheduleWakeup` with it,
  re-passing `/savi-conductor` as the prompt (or the `<<autonomous-loop-dynamic>>` sentinel
  if this loop was started autonomously). Set `noop: false` if anything changed this tick
  (a dispatch, a verdict, a push), `noop: true` if you only looked:

  | Fleet state | delaySeconds | why |
  |---|---|---|
  | free > 0 and ready tasks exist | ~120 | actively dispatching — check back fast |
  | free == 0 (fleet full) | ~360 | wisps run minutes; nothing to hand over yet |
  | ready empty, work still in flight | ~180 | just draining the verify queue |

  `reason` should name what you're waiting on ("fleet full, 3 wisps burning" beats "wait").

## Discipline that keeps the loop honest

- **Broad, not prescriptive.** "Give the canyon a night pass" splits across lanes; a
  numbered list of edits does not. If a task can't be stated as one outcome, it's two tasks.
- **Never sequence your own work behind a handoff.** Your lane (step 5) must not depend on a
  dispatched task landing — you cannot tell whether it was even picked up.
- **Verify or it didn't happen.** A task leaves the queue on a screenshot, never on a push
  succeeding or a version moving. "It compiled" is not "it's good."
- **The wiki is the state.** Don't hold task status in your head between ticks — write it
  down and read it back. That's what makes the loop survive compaction and hand off cleanly.
