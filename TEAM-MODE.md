# Team mode (design sketch)

> Status: **all four phases landed**, shipped as 1.4.0. Everything described below is built.
> Decisions, and the reasoning behind each, are recorded at the bottom.

## The idea in one line

A Spawn agent identity is a property of a **directory**, not of a session. Git worktrees give
you as many directories as you want, so they give you as many agents as you want.

Everything below follows from that. There is no connection registry, no `connection:` argument
on twenty tools, no fleet manager inside the MCP. One session drives one agent, and you get a
team by running more sessions.

## The unit

| Owned by the worktree | Where it lives | Already true? |
|---|---|---|
| Spawn identity (token) | `.env` → `SPAWN_AGENT_KEY` | yes, gitignored |
| Target game | `.env` → `SPAWN_VARIANT_ID` | yes, same for every agent |
| Version rail | `.spawn/base-version`, `.spawn/base-scripts.json` | yes, gitignored |
| Engine docs / skills cache | `.spawn/guide.md`, `skills.json` | yes |
| Play browser | one Chromium session per MCP process | yes, and now correct rather than a bug |
| Working tree | git worktree, own branch | yes |
| LLM session | one `claude` / Cursor session started in that directory | yes |

Git worktrees share `.git` but **not** untracked files, so `.env` and `.spawn/` are naturally
per-worktree. That is the whole mechanism. `cd ../game-terrain && claude` already resolves to
that worktree's identity through `resolveProjectDir()`'s cwd fallback, with one caveat below.

The browser singleton in `src/browser.ts:24` stops being a defect under this model. One process
serves one agent, so one browser is exactly right. It only needs a guard so it cannot be
hijacked (see Fix 2).

## Three things break it today

### Fix 1: identity precedence (landed)

`loadEnv` read `process.env.SPAWN_AGENT_KEY` **before** the project `.env`. Correct for the solo
case, fatal here: a key set in MCP config pinned every worktree to one identity and every agent
pushed as the same connection, silently.

The precedence is now inverted unconditionally, not just in team mode: the project `.env` wins,
process env is the fallback for a project that carries no credential of its own. `spawn_status`
reports which source won for each of `SPAWN_AGENT_KEY` and `SPAWN_VARIANT_ID`.

`SPAWN_PROJECT_DIR` is the subtler version of the same problem, and it is now a hard error in
team mode, narrowed to the case where it would actually be used: an explicit `projectDir`
argument overrides it and is never refused. The error explains the failure rather than just
naming the rule, because the failure it prevents is invisible from inside the session. Nothing
throws, nothing looks wrong, and the pushes quietly overwrite each other.

### Fix 2: the session latch (landed)

Once a process has taken an identity-bearing action, that is who it is. `spawn_push`,
`spawn_latest applyLocal`, `spawn_revoke`, and `spawn_play_open` latch to the first project dir
they see and error on a different one:

```
This session is terrain-agent (worktree ../game-terrain). You passed projectDir
../game-combat, which is a different agent. One session drives one agent: start a
session in that worktree instead.
```

Read-only tools (`spawn_status`, `spawn_latest` without apply, `spawn_me`, `spawn_docs`) stay
free to look across worktrees, because the conductor needs exactly that. So does provisioning:
`spawn_bootstrap` and `spawn_init` are how a *new* worktree gets an identity in the first place,
and latching them would make it impossible to set one up from the conductor's session. The line
is not "mutating" but "acting **as** an established agent".

The latch is inert outside team mode, where one process legitimately serves several projects.

The play tools need this most: `openPlayUnlocked` closes the existing browser before opening a
new one (`src/browser.ts:114-117`), and `resolvePlayUrl` returns the cached `session.playUrl`
(`:65-67`), so today a second project dir silently steals the first one's eyes and can end up
pointed at a different game.

### Fix 3: `game.json` had no merge story (landed)

This is the one that changed the design, and it was a real problem for solo users too.

Scripts are handled properly. `syncPulledScripts` does a genuine three-way merge against
`.spawn/base-scripts.json` and writes `<file>.theirs` receipts when both sides moved
(`src/compile.ts:176-243`). `spawn_push` refuses to run while receipts are unresolved.

Nothing else gets that treatment:

- **`game.json` is overwritten wholesale on pull.** `spawn_latest applyLocal` does
  `saveFile(join(dir,"game.json"), ...)` (`src/tools.ts:557`). Your local edits to it are gone,
  with no receipt and no mention in the sync summary.
- **`world/*.json` is never reconciled at all.** Those files are local overlays deep-merged
  onto `game.json` at compile time (`src/compile.ts:94-100`). After a pull, a stale overlay
  re-applies on top of freshly pulled content and gets pushed back up, silently reverting
  whoever wrote it.
- **`spawn_init` leaves `world/` empty and puts the entire spec in `game.json`**
  (`src/tools.ts:278-300`), so in practice agents edit the one file that has no protection.

Solo, that is a papercut you hit when you pull. With three agents pushing whole specs to a
shared version rail, it is a silent-clobber machine, and no amount of coordination on top would
fix it. So it shipped as **phase 0**, not as a team feature:

1. `.spawn/base-game.json` holds upstream's spec body as of the last sync point, alongside
   `base-scripts.json`. Written by `spawn_init`, by every applying pull, and after every
   successful push (where the base is the *compiled* spec, since that is what upstream now
   holds).
2. `mergeSpec` three-ways at the key-path level: mine equals base takes theirs, theirs equals
   base takes mine, both moved is a conflict. Recursion goes as deep as all three sides stay
   objects, so a conflict lands on `entities.player.hp` rather than on `entities`. Arrays are
   atomic. Absent keys are a distinct slot, so deletes merge properly.
3. A conflict keeps the local value, reports the dotted path, and writes `game.json.theirs`
   holding upstream's whole spec. Detect exactly, let the agent resolve, same philosophy as the
   script receipts.
4. `listConflictReceipts` includes the spec receipt, so `spawn_push` blocks on it too.
5. Script sources are excluded from the comparison entirely. They have their own rail and their
   own files, and merging them twice would conflict on the same content twice.

`world/*.json` overlays remain unreconciled. That is the honest limit, and per decision 6 it is
also why the team rule is **not** "move everything into overlays": `spawn_init` leaves `world/`
empty and puts the whole spec in `game.json`, so the key-path merge above is what actually
carries a team. Agents partition `game.json` by key path and `scripts/` by file, and the overlay
gap only matters for a project that has chosen to use overlays anyway.

## The ledger

Coordination state has to be visible to every worktree, and the processes are separate, so it
is files.

Location: the common `.git` plus `spawn-team/`. Worktrees of the same repo all resolve to the
same shared `.git`, so this needs zero configuration, is automatically scoped to one game, and
can never be committed by accident. Precedence: `SPAWN_TEAM_DIR`, then the git common dir, then
refuse with an explanation.

Finding the common dir does **not** shell out to `git rev-parse`, per decision 5. A main
checkout has `.git` as a directory; a worktree has it as a file holding `gitdir: <path>`, and
that path holds a `commondir` file pointing back. Reading those three things is exactly what git
does, and it keeps this server free of subprocesses.

```
.git/spawn-team/
  roster.json     label, worktree path, token mask, spawn username, variant, added, lastSeen   [built]
  lock/           mutex directory, stolen after a 15s stale window                             [built]
  claims.json     key path or script glob → owner label, claimed at, note                      [built]
  pushes.jsonl    append-only {ts, label, version, paths} so a 409 can name a teammate          [built]
```

The roster is keyed on the project directory, so re-running `spawn_team_init` with a new label
renames an agent in place rather than cloning it, and two agents can never claim one worktree.
Labels must stay distinct, since they are how a human tells two agents apart.

Writes are tmp-file-plus-rename; `pushes.jsonl` is append-only; `claims.json` takes the lock for
read-modify-write. Nothing here is authoritative, it is all local bookkeeping, so a corrupt
ledger degrades to solo behaviour rather than blocking work.

## Tool surface

### New, registered only in team mode

| Tool | Purpose | |
|---|---|---|
| `spawn_team_init` | Create the ledger if absent, register this worktree under a label | built |
| `spawn_team_status` | Roster, each agent's base version, head version, who is behind, who is blocked by receipts | built |
| `spawn_team_claim` / `spawn_team_release` | Claim `game.json` key paths and script globs for a label | built |
| `spawn_team_add` | Emit the `git worktree add` command, then bootstrap and init the new agent | built |
| `spawn_team_brief` | Emit a ready-to-paste opening prompt for one builder: worktree path, its claims, head version, the rules | built |

Per decision 5, `spawn_team_add` returns the `git worktree add` command for the LLM to run
through its own shell rather than executing it here. Keeping this server free of process
execution is worth more than saving one paste, given the trust model already has to explain
filesystem writes and two eval paths.

`spawn_team_brief` is how the conductor dispatches without the MCP becoming an agent runtime.
It hands back text; the LLM decides what to do with it.

### Changed in team mode

- **`spawn_push`** enforces the latch, takes the push lock, rebases onto head when the rebase is
  clean, pushes, appends to `pushes.jsonl`, releases. Serialised, "behind head" can only mean a
  teammate landed a push since the last sync, so the rebase turns what would have been a 409 into
  a no-op. A dirty rebase stops the push instead, with the local work intact and the colliding
  paths named. It also warns when the compiled spec touches paths another label claims, diffed
  against the base rails so only this agent's own edits are checked.
- **`spawn_latest`** names the teammate whose push it just pulled instead of "someone else".
- **`spawn_status`** gained a `team` block: your label, your claims, what others hold.
- **`spawn_latest applyLocal`, `spawn_revoke`, `spawn_play_open`** enforce the latch.

### Roles

- **Conductor**: the human's session at the main checkout. Provisions, reads status, merges
  branches. Needs a token only for the remote head read, and the main checkout already has one
  from the solo flow, so it is just agent zero.
- **Builders**: one session per worktree. Each one behaves exactly like today's solo agent and
  needs to know nothing about the team beyond its own claims.

## Enabling it

Decided once at boot, from `SPAWN_TEAM=1` **or** a ledger already existing. Both the tool list
and the latch key off that single flag.

`SPAWN_TEAM=1` is how a team is *started*, because creating the ledger needs the tools to exist
first. Every later session picks the mode up from the ledger the first session created, so
builders need no config beyond being a worktree of the same repo. A solo user who never runs
`spawn_team_init` sees exactly the tool list they saw before (27 tools, verified over
`tools/list`) and nothing latches, which matters because tool descriptions are this server's
main teaching surface and extra tools plus a `connection` argument everywhere would be pure
noise for the common case.

Phase 0 (the `game.json` merge, the credential precedence) is not gated. It is a straight bug
fix.

## Non-goals

- **An agent runtime.** The MCP does not spawn `claude -p`, stream logs, or own process
  lifecycle. The host already runs agents, and doing it here would take ownership away from the
  LLM, which is the opposite of the point.
- **Publishing.** There is no agent publish API. The creator publishes in the UI before the team
  starts; agents only read `mode=live`.
- **An inter-agent chat bus.** `spawn_savi` is one-way into the creator's studio chat with no
  reply channel. Cross-agent messaging is the conductor's context, which is where the ownership
  is supposed to sit anyway.
- **Enforcement.** Claims are advisory. The server cannot stop a determined agent from editing a
  claimed file and should not pretend otherwise.

## What this costs

- **Bootstrap keys.** One-time, single-use, ~5 minute expiry. Three agents is three trips to the
  Spawn gear menu inside a short window, and nothing in this design reduces the trips.
  `spawn_team_add` can at least make each trip one call instead of three.
- **GPU.** Headed Chromium only, because headless has no WebGPU adapter. Every builder holds a
  window and a GPU context, and on Windows they fight for focus. Two to three builders, and the
  tool descriptions should say so the way they already say headless does not work.
- **Disk.** A full checkout plus a `.spawn/` docs cache per worktree.
- **Merge overhead.** Every agent is on one shared version rail. Claims keep the content
  disjoint so pulls fast-forward cleanly; the push lock keeps the rail from thrashing. Neither
  helps if agents edit the same overlay.

## Build order

| Phase | Contents | Ships value to |
|---|---|---|
| 0 **(done)** | Identity precedence, `game.json` three-way merge and receipts | everyone, solo included |
| 1 **(done)** | Ledger, `spawn_team_init`, `spawn_team_status`, the session latch | first real team run |
| 2 **(done)** | Claims, push lock, teammate attribution on 409 | teams larger than two |
| 3 **(done)** | `spawn_team_add`, `spawn_team_brief` | ergonomics |

Phases 0 and 1 together make host-driven multi-agent work with no new concepts: a worktree per
agent, a session per worktree, and a status view.

## Decisions

1. **`SPAWN_PROJECT_DIR` in team mode is a hard error, with the reasoning in the message.**
   Silent identity collapse is precisely the bug phase 0 fixed, and letting a cwd quietly win
   reintroduces the same ambiguity in a friendlier costume. Removing one line from MCP config is
   a cheap fix for the user, and an explicit `projectDir` argument is never refused.
2. **Claims warn, never block.** The push lock already prevents the mechanical damage. Blocking
   turns a stale claim into a hostage situation, and the server cannot enforce it against a
   determined agent anyway.
3. **`spawn_push` auto-pulls only when the resulting sync is conflict-free**, otherwise it
   returns today's error untouched. Gets the 409 ergonomics without surprising anyone mid-push.
4. **Ledger in `.git/spawn-team/`.** Zero config, auto-scoped to one game, impossible to commit
   by accident. A tracked file can come later if claims should be reviewable.
5. **No `git worktree add` from the MCP.** `spawn_team_add` returns the exact command instead.
6. **Claims key on `game.json` key paths and script globs, not `world/` overlay files.** This
   doc originally said "put intent in overlays, claim the overlay file", but `spawn_init` leaves
   `world/` empty and puts the entire spec in `game.json`, so in practice nobody uses overlays
   and the phase 0 key-path merge is doing all the real work. Claiming what people actually edit
   also downgrades the unreconciled overlay gap from an urgent hole to something that only
   matters for a project already committed to overlays, rather than something we would be
   pushing every team into.

Shipped as 1.4.0: team mode landed as one coherent version rather than three partial ones.
