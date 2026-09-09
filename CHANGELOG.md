# Changelog

Notable changes to spawn-mcp. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-09

**Spawn 6 support.** Spawn 6 is not a new version of the thing this server talked to — it is a
different write path, and 1.x could not reach it at all. A 6.0 world's code is a git repository, and
the whole-document `PUT /game-specs` that every 1.x push used answers `409 world_is_git` against one
*before it reads the body*. Every `spawn_push` aimed at a 6.0 world failed, and nothing it reported
was reaching the tree.

2.0 detects which engine a world is on and routes itself. The tool names did not change, so an
agent prompt written for 1.x keeps working on both — but the lanes underneath are genuinely
different, and the breaking changes below are the places where that shows.

It also gains a body. A room boots for a *player* and never for a door, so `spawn_exec`,
`spawn_logs` and `spawn_rooms` read nothing until someone is standing in the world. In 1.x the only
way to arrange that was `spawn_play_open` — a headed Chromium with a working WebGPU adapter.
`spawn_client_join` puts the agent's own body in the room instead: no browser, no GPU, a few
seconds.

**Worlds on a pre-6.0 engine are unaffected.** Every document-lane behaviour in this list is
unchanged from 1.8.0.

### Breaking changes

Only on **engine 6.0+ worlds**; the document lane behaves exactly as it did.

1. **`spawn_init` clones instead of scaffolding.** There is no spec document to scaffold from — the
   tree arrives whole or not at all. A project directory that is not empty and is not already this
   world's clone is **refused** rather than cloned over, where 1.x would have written a `game.json`
   that could never be pushed.
2. **`spawn_push` requires `message`.** The commit's first line lands in the creator's chat under
   your name, so it is a required argument on this lane, not an optional label. Calls without one
   fail.
3. **`spawn_push` refuses `force`.** It meant "whole-replace over the base-version rail", and there
   is no safe equivalent: on a git world it would mean a force-push, and the server never
   force-pushes or merges.
4. **`spawn_latest` refuses `mode`, `version`, `updateSlug` and `applyLocal`.** They are document
   concepts. Silently ignoring "give me the published live snapshot" and handing back the dev head
   would look like it worked, so it is an error instead. With no arguments it is `git pull --rebase`.
5. **`spawn_validate` is a local pre-flight, not an authority.** This lane has no server-side
   validator — the push itself is the validator. "Clean" now means only that the failures visible
   without the engine are absent.
6. **`spawn_status` drops the version rail.** `baseVersion`, `hasSpecRail`, `conflictReceipts` and
   `hasGameJson` are absent on a 6.0 world; branch, HEAD, ahead/behind and uncommitted files take
   their place. Anything parsing those keys must handle their absence.
7. **This server's own files moved out of the world tree.** A 6.0 world *tracks* `.spawn/` — its
   engine pin, its skills index, its per-cell cost files — so the docs and caches written there in
   1.x now live under `.git/spawn-mcp/`. If you read `.spawn/guide.md` or `.spawn/tome-api.md` by
   path, read `.git/spawn-mcp/` on a 6.0 clone (`spawn_init` reports `docsDir`, and a clone also
   carries its own `AGENTS.md` at the root). Screenshots moved with them.
8. **Lane-sensitive tools now make an engine-detection call** (cached per process, and persisted).
   A world whose engine cannot be read from the API is now an error where 1.x would have gone ahead
   and pushed. Pass `engineVersion` explicitly to proceed without detection.
9. **New optional dependency: [Bun](https://bun.sh)**, required by the four `spawn_client_*` tools
   and nothing else. Everything that worked in 1.8.0 still works without it.

### Added

- **Both write lanes, detected per world.** Every tool that reads or writes a world routes itself:

  | tool | pre-6.0 (document lane) | 6.0+ (git lane) |
  |------|-------------------------|-----------------|
  | `spawn_init` | scaffold `game.json` / `world/` / `scripts/`, pull the spec | clone the repo into `projectDir` |
  | `spawn_push` | compile + `PUT /game-specs` | stage, commit, `git push`, report the rooms' verdicts |
  | `spawn_latest` | pull a saved spec, sync scripts, `.theirs` receipts | `git pull --rebase` |
  | `spawn_validate` | server-side schema validation | local tree pre-flight |
  | `spawn_status` | base version, receipts, head vs published | branch, HEAD, ahead/behind, uncommitted |
  | `spawn_docs` | guide + tome API + skills | same, and the world's era + semver |
  | `spawn_exec` / `spawn_logs` / `spawn_rooms` | unchanged | unchanged — identical on both lanes |

- **`engineVersion`, an optional argument on every lane-sensitive tool.** Omitted, the world's
  engine is read from the API and cached. Passed — as a semver (`6.0.0`, `5.4`) or an era name
  (`6.0`, `document`) — it is *checked* against the real pin, and a disagreement fails the call
  without writing anything. It is an assertion, not an override, because the failure it exists to
  prevent is a document-lane push aimed at a git world, or a `game.json` scaffolded over a live
  clone. `spawn_exec` / `spawn_logs` / `spawn_rooms` deliberately do not take it: those endpoints
  are identical on both lanes, so the parameter would be a knob that does nothing.

  The API answers the engine question in three places now, and all three are used:
  `GET /api/agent/v1/me` and `/worlds` carry `engine: { semver, era, git }` per world, and
  `GET /api/sdk/v1/{id}/agent/docs` carries `engineVersion` + `era`. Detection reads `worlds` first
  (a few hundred bytes) and falls back to `docs`, which is authoritative for any variant the token
  can reach. A `409 world_is_git` from the document lane drops the cached era, so a world migrated
  to 6.0 mid-session is picked up on the next call rather than retried into the wall.

- **`spawn_client_*` — the agent's own body in the world.**

  | tool | what it does |
  |------|--------------|
  | `spawn_client_join` | stands your body in the world as a real player — boots the room, no browser, no GPU |
  | `spawn_client_status` | which sessions are standing, and how much ttl is left |
  | `spawn_client_leave` | despawns the body; the room folds when the last one goes |
  | `spawn_client` | any other client verb — `where`, `players`, `inputs`, `move`, `look`, `witness`, `crossing`, `screenshot`, `run` |

  This is the cheap way to a live room, and it is also how an agent **plays** the game it is
  building: the body wears your name, stands in the room's census beside the creator and Savi, and
  the world's own player hooks fire for it like anyone's. `spawn_exec` and `spawn_logs` now name the
  join in their no-live-room errors instead of sending you to open a browser.

  A body and a browser answer different questions, and the build loop now says so in that order: a
  body makes the room readable and lets you act in it; the browser is the only thing that tells you
  whether the frame is any good. **Join to query, look to judge.**

  Four tools rather than one per verb, on purpose: the client is served by the stack rather than
  shipped here ("the client it runs is the one the stack you join serves"), so its verb list can
  change under us. Join, leave and status carry real schemas because they are the lifecycle an agent
  has to get right; everything else goes through one passthrough that cannot drift.

- **`spawn_push` takes a `message` and a `body` on the git lane.** The commit's first line is not a
  log entry: it lands in the creator's chat and their changes list under the agent's name, beside
  what they and Savi said. The tool asks for one plain sentence about what changed for the player.
  `body` carries the how — and since no agent account can wake Savi any more, that body is the only
  channel to her an agent has.

- **A local pre-flight for the git lane (`spawn_validate`).** The push *is* the validator on this
  lane, and it is live in every open room the moment it lands, with no dev/live split to absorb a
  broken tree. So `spawn_validate` checks locally what the push law names explicitly: every script
  and template is ESM-parsed (`vm.SourceTextModule` in a child process — a real parse that accepts
  `import`/`export`, and never evaluates the module), `.scene` files are checked against their
  `# spawn-scene v2 yaml <cellKey>` header and the cell key their filename implies, image bytes are
  checked against their extension, and binaries under `assets/` are caught before
  `law.git.asset-kind` refuses them. `spawn_push` runs the same check over the changed files and
  blocks on failure.

- **`depth` on `spawn_init`** — how much history a 6.0 clone takes (default 20, `0` for all of it).

### Fixed

- **The play client could not open a 6.0 world.** `agent/docs` returns `playUrl` absolute on the git
  lane and relative on the document lane, and four call sites prefixed it with the API origin
  unconditionally — producing `https://www.spawn.cohttps://www.spawn.co/@user/world`. All of them
  now go through one helper that leaves an absolute URL alone.

- **`spawn_savi` reported an opaque 403.** The studio-chat door is now closed by *account class*: a
  standalone agent account (`sak_` from `/signup`) can never wake Savi, linked or not, while a
  human's own token still can. Retrying and re-wording both fail forever, so the tool names the
  reason and points at the channel that does work — the commit body.

- **`spawn_push` echoed a commit subject that had not landed.** When a push sends a commit that
  already existed (usually one a refused push left behind), it reports the real HEAD subject and
  says nothing new was committed, rather than echoing back the `message` argument.

- **`spawn_latest` reported a no-op pull as a change.** `git rev-parse --short` picks its length
  from the repo's object count, so the same commit abbreviates to 7 characters in a fresh clone and
  8 once a fetch has brought more objects in. Comparing those strings made an unchanged HEAD read as
  a change — `changed: true` beside `0 file(s) moved`. Comparisons now use the full sha and only the
  display fields are abbreviated. Caught by re-verifying against the live world a few days after the
  clone, which is exactly how long it took the abbreviation to grow.

- **A pull that moves HEAD without changing the tree now says so.** A world commits its own
  bookkeeping (re-measuring cell costs, for instance), and those can land as real commits whose net
  diff is empty. "Rebased onto origin — 0 file(s) moved" was accurate but read like a bug; it now
  says the tree is byte-identical and there is nothing to re-read.

### Security

- **The git credential never lands anywhere durable.** The helper is passed per-invocation with
  `-c`, so a clone this server makes carries no credential in `.git/config` and none in
  `git remote -v`. The helper body references `$SPAWN_TOKEN`, expanded by the shell git runs it in,
  so the token is never an argv element; it reaches the child through its environment only. Git
  output is scrubbed of the token, and of any credentials riding in an echoed URL, before it is
  returned. `GIT_TERMINAL_PROMPT=0` is set because an MCP server has no terminal: a git that decided
  to prompt would hang the tool call rather than fail it. The username is validated against a strict
  handle pattern rather than escaped, because it is interpolated into a shell function body.

- **This server's own files stay out of the world tree.** They live under `.git/spawn-mcp/`, which
  is never tracked, never pushed, and never touched by a pull; `.env` is hidden via
  `.git/info/exclude` rather than the world's own `.gitignore`, so a clone carries no change nobody
  asked for. Excluding `.spawn/` wholesale — the first attempt — was worse than the problem: it
  would have made `git add -A` silently skip legitimate new world files there, and the push would
  have landed missing exactly the work nobody thought to check. A guard now refuses to push when
  this session's own artifacts (`.env`, `.theirs` receipts, screenshots, a document-lane
  `game.json`) are sitting in the tree, because a 6.0 push is `git add -A`.

- **The play client's origin is pinned, like the API's.** `--origin` anywhere on a client line
  redirects it to another stack, and the agent token travels to whatever that names — the same
  threat `src/config.ts` pins the API origin against, reached through a different door. It is
  refused in the verb and in every argument, and `SPAWN_ORIGIN` is set explicitly to this server's
  resolved API origin so the client and the API always talk to the same host. Verbs are validated
  against a plain-word pattern and always run as `spawn client <verb>`, so the blast radius is the
  client namespace — never `spawn upload`, `spawn fetch`, or a flag smuggled into the front of the
  line. Arguments go through `execFile` with no shell, and the client runs with its cwd in this
  server's own cache directory, never in the game project (`bun x` resolves a package into its cwd,
  and a world's tree is not the place for that).

### Requirements

- **git** on `PATH`, for 6.0 worlds. Pre-6.0 worlds do not need it.
- **[Bun](https://bun.sh)** for the four `spawn_client_*` tools, and nothing else. It is not a
  preference: the client's session shell is literally spawned as `bun <entry>`, so under Node the
  CLI gets as far as `shell process failed to spawn (no pid)`. The client *package* needs no
  install — `bun x @spawnco/client` is the fallback, and a global `bun add -g @spawnco/client` is
  used when present.

| New env var | Default | Purpose |
|---|---|---|
| `SPAWN_GIT_TIMEOUT_MS` | `180000` | Abort a git command that hangs |
| `SPAWN_CLIENT_TIMEOUT_MS` | `120000` | Abort a client command that hangs |
| `SPAWN_BUN_BIN` | resolved | Path to the Bun binary, when it is somewhere unusual |
| `SPAWN_CLIENT_ENTRY` | resolved | Path to `@spawnco/client`'s `bin/spawn.mjs`, to pin a copy |

### Notes

- **Clones are shallow by default (`depth: 20`; `depth: 0` for everything).** Measured against a
  live world, `main`'s full history was 18,500 objects and 80 MB and the fetch did not finish at
  all; the same world's tip was ~320 objects and a few seconds. Nothing this server does needs deep
  history — it edits the tip, commits, and pushes, all of which work from a shallow clone. The
  `refs/notes/spawn` refspec is only configured on a full clone: notes point at commits all through
  history, so on a shallow clone they cannot resolve, and configuring the refspec anyway breaks
  every later `git pull` with "remote did not send all necessary objects".

- **Worlds move fast.** On the world this was built against, `origin/main` advanced between a fetch
  and a push seconds later, so a non-fast-forward rejection is ordinary rather than exceptional:
  `spawn_push` names it as such and points at `spawn_latest`, and `spawn_status` reports how far
  behind you are. The server has a second form of it — `law.git.head-moved`, a *remote* rejection
  when the world moves while the push is being read — and both are reported the same way, because
  the fix is the same: pull, then push.

- **Client sessions are detached and outlive the tool call**, which is what makes
  join-once-then-query work. They self-expire at `ttl` (default 600s) — the safety net against a
  forgotten body standing in someone's world — and this server deliberately does not kill them on
  shutdown, since a session is meant to survive an MCP restart.

- Bun resolution finds the real binary rather than the `bun`/`spawn` shim on `PATH`, because on
  Windows those are `.cmd` files that cannot be exec'd without a shell.

### Known upstream bugs

Both are in Spawn's packaged client, not in this server; both are reported here because the errors
are otherwise very hard to read. Each is tracked as an issue carrying the repro, the exact cause and
a suggested patch, because the package's declared tracker (`earth-kiln/main`) is private:
[#5](https://github.com/wfbcargo/wfbcargo_spawn_mcp/issues/5) and
[#6](https://github.com/wfbcargo/wfbcargo_spawn_mcp/issues/6).

- **`spawn client run` does not work on Windows**
  ([#6](https://github.com/wfbcargo/wfbcargo_spawn_mcp/issues/6)). The session shell validates
  `scriptPath` as POSIX-absolute, so a `C:\…` path is refused — and `-e` fails identically, because it writes the
  source to a temp file and passes that same path. Play scripts are therefore unavailable on Windows
  entirely. `spawn_client` detects the signature and says it is the client's bug rather than
  reporting it as the script's fault. Every other verb works: `where`, `players`, `inputs`, `move`,
  `look`, `witness`, `crossing`, `screenshot`.
- **`@spawnco/client` 0.2.0 passes a bare Windows path to `import()`** when run under Node
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`), which stops every client verb before
  it starts ([#5](https://github.com/wfbcargo/wfbcargo_spawn_mcp/issues/5)). Under Bun it does not
  bite, so this server's Bun requirement routes around it.

### Verified against a live world

`@wfbcargo/simplecity`, engine `6.0.0`:

- **Git lane:** clone, `git pull --rebase`, the local pre-flight over 210 scripts and 9 scenes, a
  refused non-fast-forward push, the rebase, and an accepted push whose receipt read
  `live · 1 room · 4 players · 1 op`.
- **Engine detection:** era and semver from both `worlds` and `docs`; a `document` claim about a 6.0
  world refused; a patch-version disagreement warned but allowed.
- **Play client:** joined as a real player and stood in the room beside Savi and the creator;
  `agent/rooms` listed the room and `agent/exec` answered `200` with a live read of 2,628 entities
  **with no browser open anywhere**; walked the body by input; read `where` / `players` / `inputs`;
  departed cleanly. Joining by world id works as well as by `@user/world` address, so the tools use
  `SPAWN_VARIANT_ID` directly.
- **Document lane**, which this account owns no world on, is covered by tests against a loopback
  stand-in for the API.

357 tests, 91 suites.

### Upgrading from 1.8.0

Nothing to do for a pre-6.0 world. For a 6.0 world:

1. Install git (and Bun, if you want `spawn_client_*`).
2. Run `spawn_init` in an **empty** directory holding only your `.env` — it clones the world there.
   An existing 1.x project directory full of `game.json` and `scripts/` is not a 6.0 clone and will
   be refused; start a fresh one.
3. Read `AGENTS.md` at the clone root and `.git/spawn-mcp/tome-api.md` before writing code.
4. Pass `message` to `spawn_push` from now on.

## [1.8.0] - 2026-08-20

### Added

- **`spawn_savi_status` — how many sub-agents Savi is running right now.** 1.7.0 turned
  `spawn_savi` into a delegation channel and told agents Savi's fan-out is eight wide, but left
  them with no way to see how much of it was already spoken for. An agent could hand over a slice
  into a full fleet, or build serially past eight idle sub-agents, and could not tell the two
  situations apart. This is that measurement.

  The number is legible in exactly one place: the play page an agent already keeps open. The
  studio broadcasts its whole state to that page over a websocket, and the wisps — the little
  flames along the top — are its visible form, one per sub-agent. There is no API for it; every
  studio-chat `GET` on the agent API is a 404, which is why this reads a browser rather than an
  endpoint.

  Two readings, deliberately, because neither format belongs to us. The server keeps the latest
  state frame off the socket (Playwright's own websocket events — the socket is not created
  through the page's `WebSocket` constructor, so injecting a wrapper never sees it), and counts
  the wisp hotspots in the DOM directly. The frame says what each sub-agent is working on; the
  count says how many there are. They agree, and either one alone still answers the question, so
  the tool degrades from full detail to a bare count to "no play session" rather than breaking.

  The state frame is kilobytes — chat history, command list, and the full prompt text of every
  task Savi was given — so it is projected down to titles and one-line summaries at the point of
  capture, before any of it can reach a model's context.

  Reported: `busy`/`free` against the 8 lanes, what each burning wisp is doing, weaves still in
  flight with their lane roll-up, and the most recent finish. `spawn_play_status` carries a
  one-line version, and `spawn_savi` reports the fleet its handoff just landed in.

- **`savi-conductor` skill — a capacity-gated delegation loop over a whole build.** The wisp
  count is only worth reading if something acts on it; this is the something. It is a Claude Code
  skill (`.claude/skills/savi-conductor/`) that runs the loop a builder would otherwise run by
  hand: maintain a durable, git-tracked wiki of intent, fan broad slices out to Savi whenever
  `spawn_savi_status` shows free lanes, build one lane itself, and verify what lands by looking at
  it. It self-paces — each tick picks its own next wake time from how full the fleet is.

  The design turns on the same fact `spawn_savi` does: the channel is one-way, so the wiki *is*
  the reply channel, holding the half of the conversation the API refuses to return. The loop
  reconstructs completion by inference and is deliberately conservative about it — a head bump is
  a prompt to look, never a verdict; a task leaves the verify queue on a screenshot matching its
  stated intent, not on a version moving; the conductor logs its own pushes so it never credits
  its own head bump to a Savi task; and a dispatched task is held for minutes on real evidence
  before it is ever re-sent, because nothing reports which wisp owns which task.

  **How to use it**

  1. **Have a game project open** with working spawn-mcp credentials (`spawn_status` green), and
     an idea of what you want built — notes, a design doc, or a previous wiki to ingest.
  2. **Start the loop** with the interval omitted, so it self-paces:

     ```
     /loop /savi-conductor
     ```

     The first tick **bootstraps the wiki** at `docs/savi-wiki/` (git-tracked): `vision.md` for
     the pillars, `areas/*.md` per subsystem, `backlog.md` for the work as broad `ready` slices,
     `log.md` as the reconcile trail, and `index.md` as the traversable re-entry map. It also
     opens a headed play client — the loop's wisp sensor and screenshot verifier are the same
     window — and picks one area as the conductor's own lane. If the backlog comes up empty (no
     pillars, nothing to ingest) it says what it needs and stops rather than spinning.
  3. **Each tick thereafter** it senses the fleet, drains the verify queue (pull + screenshot
     each landed intent), fills every free lane with the broadest ready slices (`keepOff` = its
     own lane plus whatever is already in flight), builds its own lane, commits the wiki if it
     changed, and reschedules — ~120s while actively dispatching, ~360s when the fleet is full.
  4. **Watch it** in the terminal (`/loop` shows each tick) or by reading `docs/savi-wiki/` — the
     backlog's status tags (`ready → dispatched → landed → verified` / `reopened` / `blocked`)
     are the live state, and the commit history is the audit trail.
  5. **Steer or stop.** Edit `vision.md`/`backlog.md` between ticks to redirect it; the next tick
     reads the wiki fresh. It stops itself when nothing is `ready`, in flight, or reopened and its
     lane is done — or stop it yourself by ending the loop.

  Two rules the skill enforces and you should know going in: **one conductor per fleet**
  (`spawn_savi_status` is account-wide, so two loops double-count vacancy and thrash Savi — in
  team mode exactly one agent conducts), and **delegate broad, never a step list** (the split
  across sub-agents is what the fan-out is good at). The wiki being git-tracked is the point that
  makes it survive your own context being compacted: a fresh conductor re-enters by reading
  `index.md`, not your chat history.

### Changed

- **Idle lanes are now stated as the finding, across every surface.** The tool description, the
  session guide, `spawn_team_brief`'s opening prompt, and the README all say the same thing: free
  lanes are parallelism nobody had to key, check out, or supervise, and an agent building
  serially past four of them is choosing the slow route. The advice line is computed from the
  actual count, so it escalates — eight idle lanes reads differently from one, and at full
  capacity it stops asking for more and points at `spawn_latest` instead. An unreadable fleet
  argues for delegating anyway rather than for stalling.

- **Handoff uptake is detectable now, and the guidance stops saying it isn't.** `spawn_savi`'s
  description said an agent "cannot tell whether it was even picked up". A wisp lighting up is
  exactly that signal. What has *not* changed is attribution: no endpoint reports an author, so a
  burning wisp means Savi is busy and on what, never that it is busy on your task. Both halves
  are now said together wherever the old claim appeared.

### Fixed

- **README's solo tool count was stale.** It claimed 32; the real number at 1.7.0 was 34, and is
  35 with `spawn_savi_status`.

## [1.7.0] - 2026-08-19

### Changed

- **`spawn_savi` is a delegation channel, not just a status line.** It has always POSTed to the
  creator's studio chat, and Savi acts on what it reads there — including taking a task on and
  fanning it out across its own sub-agents, up to 8 in the studio. Nothing about the endpoint
  changed; what changed is that the server stopped telling the model this was impossible. The
  1.3.0 entry below claimed "there is no way to hand Savi a task from here", and the session
  guide said the same in step 8, so agents treated the widest parallelism available to them as a
  notification channel and built everything themselves instead.

  The tool now takes `task` (the work, stated broadly), `subAgents` (1–8, optional — omitted
  means "split it as far as it splits", which is usually the better ask), and `keepOff` (the
  areas the calling agent is still in, so Savi's sub-agents route around it). `renderHandoff`
  composes those into the chat message; `message` alone still sends exactly what it always did.

  This is cheaper than the alternative it competes with. Another `sbk_` agent costs a one-time
  key minted by hand inside a 5-minute window, its own worktree and `.spawn/` cache, and a headed
  Chromium holding a GPU context — which is what caps a local fleet at two or three on Windows,
  where the windows fight for focus. Savi's sub-agents cost none of that. What it does *not* save
  is the version rail: Savi's work lands on the same head as everyone else's, which is both how
  you detect it and why it still has to be pulled and looked at.

  Two things stay true and are now stated as constraints rather than as a dead end: the channel
  is one-way, so an agent declares its boundary instead of negotiating it and must never wait on
  a reply that cannot arrive; and delegating broad beats delegating prescriptively, because the
  decomposition is the part the fan-out is actually good at.

- **The guidance says how a handoff is actually detected, which is by inference.** The first pass
  told agents to watch for "a head-version bump you did not cause", which reads like a field to
  look up. There isn't one: `spawn_status` returns `remote.headVersion` and `localBehindHead` and
  no author anywhere, and the team ledger's `recentPushes` only records our own agents. So an
  unexplained bump is Savi, the creator, or a teammate, and only the ledger separates the third
  from the first two. Every surface now says that outright, and two rules follow from it that
  were missing: **never put a delegated task on your critical path** (nothing reports that it was
  even picked up, so anything sequenced behind it stalls indefinitely), and **screenshot what
  lands before building on it** — the "a successful push proves the spec parsed and nothing more"
  rule applies to work that arrives on your rail exactly as it applies to your own.

- **The best handoff target is named, and it is not "art".** An agent makes art perfectly well by
  naming a `cdn/` path — that is 1.5.0's correction and it stands. The real asymmetry is narrower:
  a path is spent on first fetch and cannot be re-rolled, so a look that needs more than one
  attempt, or that the creator wants to steer, is worth handing to Savi, who can try it again with
  them in the loop. "What should I delegate?" now has that answer instead of "something
  separable". `keepOff` is also tied to team claims, since an agent in team mode already holds
  exactly the patterns it should be passing.

- **The session guide, the team brief, and the multi-agent docs count Savi as capacity.** Step 8
  of `SESSION_GUIDE` now says to hand separable slices over rather than only reporting on them,
  and to notice the result as a head-version bump the agent did not cause. `spawn_team_brief`
  tells builders to route anything outside their claim to Savi. README gained a **Delegating to
  Savi** section, and TEAM-MODE's "no inter-agent chat bus" non-goal is narrowed: dispatch out
  works, nothing comes back.

### Fixed

- **A whitespace-only `task` reported a handoff that was never sent.** `renderHandoff` gates the
  ask on `task.trim()`; the handler's result note gated on bare truthiness. So `task: "   "`
  composed a message with no request in it and still told the model work was in flight — and the
  new guidance tells it not to go checking. Both now gate on one exported `isHandoff`.

- **`subAgents: 1` asked Savi to do the opposite.** The schema advertises 1 as meaningful, but the
  branch was `subAgents > 1`, so pinning the width to one fell through to "fan it out across your
  sub-agents if it splits cleanly". 1 now asks for no split at all.

- **A handoff did not say who sent it.** In team mode several builders write into the same studio
  chat, and every one of them said "leave those to me" with nothing attached — which makes
  `keepOff` unroutable in precisely the mode it exists for. The composed message now carries the
  team label when there is one.

- **Input validation matched the description but not the repo's own pattern.** `message` accepted
  the empty string (POSTing an empty studio-chat message and reporting `ok`), and `keepOff`
  accepted blank patterns, rendering "Currently mine: ,  .". `message` is now `.min(1)`, `keepOff`
  items are `.min(1)` and trimmed, and an empty leading block can no longer open a message with
  two blank lines. `sent` is omitted from the result when nothing was composed in, rather than
  billing the model to read back its own sentence.

- **GETTING-STARTED said the assistant cannot generate images or 3D models.** Two releases stale:
  1.5.0 established that naming a `cdn/` path *is* the generation lane and corrected the session
  guide, but this file still told creators to fetch art from Savi themselves and hand it over.
  It now describes both lanes the assistant actually has, plus the one thing a creator genuinely
  needs to know about the new channel — that no completion signal comes back, so their assistant
  will not wait on Savi and will not always know which changes were Savi's.

## [1.6.0] - 2026-08-13

Local math audit: run a game's pure functions in plain Node and check declared invariants, with
no browser, no live room, no push and no credentials. The capture of the existing review that
motivated it — what it checks today, what it costs, and what is written down nowhere — is in
[REVIEW.md](REVIEW.md).

The review was not too thorough; it was thorough at the wrong tier. Nineteen of its checks are
answerable from files on disk, and thirteen of them were being answered through a headed
browser and a judgement call instead. Math was the worst case: nothing in this repo asked for a
single numeric check, so that half of every review was re-derived from scratch each session.

### Added

- **`spawn_audit_math`**: sweep exported pure functions across declared input domains and check invariants — `finite` (NaN/Infinity), `integer`, `min`/`max`, four monotonicity forms naming an argument, and `expr` for anything else. `select` reads a field out of an object result. Findings carry the **exact arguments** that produced them. Reads `audit/math.json` from the game project, or inline `checks` for a rule you have not saved yet. Measured on a real 77-script game: 1,020 calls across 6 checks in 72 ms, which pinned a formation that does not fit its zone to one wave out of sixty — a defect invisible in play and instant from a sweep.
- **`spawn_audit_scan`**: list every exported function and say which are auditable locally. The engine injects `objectApi` as a *parameter* rather than an import, so the signature alone decides: no `api` parameter and no engine-only `require` means the function cannot reach the engine. On that same game, 185 of 271 exported functions.
- **A script loader that resolves `require` instead of stripping it** (`src/harness.ts`). Handles both module systems in the tree — `export function` behaviours and the `module.exports = { … }` helpers where most pure math actually lives — caches modules, tolerates cycles, and refuses to leave `scripts/` or follow a symlink, matching the compiler's guard. No `--experimental-vm-modules`: there are no `import` statements anywhere in a Spawn game, so nothing needs ES module linking and `vm.Script` is enough.

### Notes

- **Engine-only builtins are refused, not stubbed.** `fx`, `geom`, `three`, `tsl`, `vibe`, `room-routing` and `primitives` report `engine-only` and the check declines to run. A stub would let a check pass against behaviour that never executed, which is worse than not running it. The four documented pure helpers (`math`, `vec3`, `easing`, `format`) are reimplemented locally, and flagged best-effort in `src/builtins.ts` since the engine's own source is not distributed.
- **A capped sweep says so.** Exceeding the call budget reports `CAPPED from N` rather than truncating quietly, because a bounded sweep reported as a full one reads as "covered everything".

## [1.5.1] - 2026-08-12

### Changed

- **Namespace warnings are loud only while the name can still change.** `pathWarning` now carries a severity. A path storage has never seen, or that nothing is recorded as using, is still at the moment of invention and gets the full recommendation. A path that is already generated (`exists: true`) or already referenced by a game cannot be re-rolled, so the diagnosis stays and the instruction becomes "apply this to the next name". `exists: false` outranks being referenced, because a path written into `game.json` but never fetched is exactly the case that is still fixable.
- **`spawn_asset_scan` reports the two at different volumes.** Spent paths collapse to one counted line per kind with a `spawn_asset_search namespace:"root"` pointer; actionable ones are still named individually. A scan of one real project used to emit the same sentence sixty-three times with only the path changing, truncated to ten — which reads as ten findings, recommends an impossible action for every path listed, and buries the one path that could still be renamed.

## [1.5.0] - 2026-08-12

A cross-project asset catalog, and a correction to what this server told the model about making art. Design: [ASSET-BANK.md](ASSET-BANK.md).

Spawn generates a `cdn/` asset on first fetch of its path and caches it there forever — the path *is* the asset — and it has no catalog API. So sharing across projects already costs nothing (the same path is the same asset, which is what Spawn's own "use the same file name and it will be the same asset" means), but nothing anywhere records **which names worked**. A name cannot be re-rolled: a path that produced something good is unrecoverable knowledge once you forget the spelling, and a path that produced something bad is permanently bad. That judgment is what the bank keeps.

### Added

- **The asset bank**, a user-level catalog in `~/.spawn-mcp/assets/` (`SPAWN_ASSET_BANK` overrides; a setting pointing at a `.json` file is read as its parent directory). User-level rather than per-repo on purpose: the team ledger lives in a repo's shared `.git` because a team is scoped to one game, which is exactly wrong for a store whose value is crossing games. Concurrent MCP processes share it through the same cross-process lock the team ledger uses. Five tools, taking the solo list from 27 to 32.
  - **`spawn_asset_scan`**: harvest every `cdn/` path from one or more directories, recording which files cite it and which game it belongs to. Reads raw file text rather than the compiled spec, so it also catches paths assembled in script strings and works on a project that does not compile. A `?animations=` query normalizes away, so one asset never becomes three rows.
  - **`spawn_asset_search`**: query by text, name, category, filename prefix, kind, slug, namespace, verdict, project, game, or reuse count. Ranks named, described and known-good assets above bare path matches and sinks bad ones, and reports the true match count rather than the page size, so a truncated result never reads as "that is all there is". `facets: true` returns counts by category, kind, style family and namespace over the whole match set, which is why there is no separate listing tool.
  - **`spawn_asset_note`**: a name, a category, description, tags, a good/bad verdict, and `replacedBy` — including for a path that has not been scanned or even used yet, since the moment before the first fetch is when the name is still changeable. There is deliberately no delete: a bad name is the one record that cannot be recovered by scanning again.
  - **`spawn_asset_preview`**: existence check plus, for images, the bytes inline so the model can judge the art instead of inferring it from a filename. Checks the **storage** host rather than the `/cdn/` cook route, because the cook route generates on first fetch and answers 401 for anything it will not cook anonymously — it conflates "does not exist" with "not allowed to ask", and asking there is not side-effect-free. Storage answers a plain 200/404 and never cooks. The storage prefix carries an environment and a version segment, so it is resolved by following one redirect and re-resolved when a cached prefix starts missing, rather than hardcoded.
- **`spawn_asset_sync`, the authoritative fill.** There is no asset API — `/api/agent/v1/assets`, `/media` and `/cdn` all answer `404 not_found`, and the only account-wide endpoint is the game list — so the closest thing to a catalog is the set of specs your own games have pushed. The sync lists every game on the account, fetches each one's current server-side spec, and harvests its `cdn/` paths, attributing each to the script it appears in. This sees what a local scan structurally cannot: games with no checkout on this machine, and assets a teammate or Savi pushed that never reached your disk. On the account it was built against, a local scan of three projects found 169 assets and the sync found 408 — the same game with 105 references on disk had 298 in its pushed spec. Slow on purpose (one spec fetch per game, each carrying every script source; four at a time, six games ≈ 3s). Specs are fetched **outside** the bank lock so a multi-minute sync cannot stall other agents' notes, and a game that errors is reported and skipped rather than losing the whole run.
- **Every asset tool recommends a sync when the bank is empty, never synced, or over a week stale** — not just search. The damage happens at the moment of invention: a stale bank answers "no match", the model coins a fresh path, and an asset that already exists under a good name is regenerated under a second one. Because a path cannot be re-rolled, those two names can never be merged afterwards, so the warning belongs on every surface that could precede it.
- **Names.** A name is a short unique handle, and every tool that takes a path takes a name instead — `spawn_asset_preview path="knight"` rather than sixty characters of style family and hyphenation, which is the same problem the bank exists to solve. Collisions are refused rather than silently reassigned, since a handle that resolves to two things is not a handle. Lookup is case-insensitive, and `replacedBy` accepts a name too.
- **Your own categories, kept separate from the filename's.** The token a path starts with (`model-`, `texture-`) is now `prefix`, and `category` is free-form and assigned by you ("enemies", "ui-icons"). They are different axes — one is a type that largely restates `kind`, the other is what the asset is *for* — and both are searchable. Assigned fields are the only ones written to disk; derived ones are recomputed on read, so a rescan can never overwrite a judgement and a grammar change cannot leave an asset mis-filed.
- **Reuse is counted in games, not directories.** In team mode one game is several worktrees, each its own project directory, so counting directories reported a three-agent team as three games — a headcount of your own agents dressed up as a reuse signal. Each use now records the `variantId` from that project's **own** `.env` (never the process fallback, which during a multi-directory scan would stamp one variant onto every project), and the count collapses uses that share one. A project naming no variant counts on its own rather than being quietly merged. Reuse across games feeds ranking, and `minGames` filters on it.
- **Sharded storage**, one file per style family plus `_meta.json`, with the `root` namespace split by filename prefix (`root-effect.json`, `root-sfx.json`) because it has no style family and is typically the largest group — on the bank this was developed against, 116 of 170 assets, which would have recreated the single oversized file sharding exists to avoid. Measured at 821 bytes/asset a 10,000-asset bank is ~7.8 MB and parses in ~19 ms, so this is explicitly **not** a search optimisation: it keeps a one-field note from rewriting the whole catalog, and keeps each file openable by a human. A corrupt shard loses that one family rather than the catalog.
- **Namespace classification and collision warnings.** Paths are read as `moodboard` (the documented `moodboard-<slug>/<category>-<name>.<ext>` form), `root`, `custom`, or `ingested`. A `root` path is a bare global name shared with every other Spawn game — if naming is creating and nothing namespaces it, `cdn/model-tree.glb` is whatever the first fetch anywhere produced — so it warns on every retrieval. A moodboard slug outside the nine canonical families is noted but allowed. `ingested` (`public.<base64>`) paths are opaque uploads, not names, and are ranked last so they are never offered as a style example.

### Fixed

- **The session guide no longer tells the model it cannot make art.** `spawn_session` and `spawn_getting_started` both claimed "you CANNOT generate images or conjure 3D models through this MCP … your art levers are cdn/ assets that already exist", and pointed at Savi instead. Naming a path *is* the generation lane, so this steered agents away from the engine's main art affordance and toward untextured primitives — the exact failure the 1.3.0 skills work existed to prevent. It now explains the mechanism, the moodboard convention, the canonical slugs, that a path cannot be re-rolled, and that bare names are globally shared.

## [1.4.0] - 2026-08-11

Running several agents against one game (see [TEAM-MODE.md](TEAM-MODE.md)). A Spawn identity is a property of a project directory, not of a session, so one git worktree per agent gives you a team with no connection registry and no agent runtime in this server.

### Added

- **Team mode**, off unless `SPAWN_TEAM=1` or a ledger already exists. Adds six tools and leaves the solo tool list at 27.
  - **`spawn_team_init`**: create the shared ledger if absent and register this worktree under a label. The ledger lives in the repo's common `.git/spawn-team/`, so every worktree resolves to the same path with no configuration, it is scoped to one game, and it cannot be committed by accident. `SPAWN_TEAM_DIR` overrides for agents that are not worktrees of one repo. Warns when a worktree has no key of its own, when its key came from the MCP config rather than its `.env`, and when its variant differs from the rest of the team.
  - **`spawn_team_status`**: the whole team at a glance: every agent, how far behind head each local rail is, whose worktree has unresolved conflict receipts, open claims, recent pushes, and head vs published.
  - **`spawn_team_claim` / `spawn_team_release`**: ownership of `game.json` key paths (`entities.player`) and `scripts/` globs (`scripts/hud/**`). Everything except `scripts/**` is claimed by key path, because that is where `spawn_init` puts the whole spec; a pattern that looks like a file path outside `scripts/` is rejected rather than silently never matching.
  - **`spawn_team_add`**: stands up a new agent in one call: writes its variant, trades its one-time key for its own token, scaffolds the project, and registers it. Called before the worktree exists it returns the exact `git worktree add` command instead of running it, because this server executes no subprocesses. It refuses to proceed without a distinct key for the new agent: sharing one token would make every agent indistinguishable on the version rail.
  - **`spawn_team_brief`**: a ready-to-paste opening prompt for one builder or the whole team, covering who it is, its worktree, what it owns, what teammates own, whether it is behind head, and the working rules. Text out; the LLM decides what to do with it. This is the dispatch affordance, and it is deliberately not an agent runtime.
- **Pushes serialise and rebase in team mode.** `spawn_push` takes a ledger-wide lock, and from inside it "behind head" can only mean a teammate landed a push since your last sync, so it pulls first. A clean rebase costs nothing and the 409 never happens; a rebase that collides stops the push with your work intact and the colliding paths named. `force: true` skips it, being a deliberate whole-replace. The lock's stale window is longer than the HTTP timeout so a slow push cannot have its lock stolen mid-flight.
- **Claim warnings on push, and attribution instead of "someone else".** Changes are diffed against the base rails, so exactly this agent's own edits get checked against other agents' claims, and collisions are reported alongside the successful push rather than blocking it. Every push is logged to `pushes.jsonl`, so a 409 names the teammate who took the version and what they touched, and `spawn_latest` says whose push you just pulled.
- **The session latch.** `spawn_push`, `spawn_latest applyLocal`, `spawn_revoke`, and `spawn_play_open` bind to the first project directory they see and refuse a second, because identity, the `.spawn/base-version` rail, and the single Chromium session all belong to one directory. Read-only tools still inspect any worktree, and provisioning (`spawn_bootstrap`, `spawn_init`) stays unlatched so a new worktree can be set up from anywhere.
- **A globally configured `SPAWN_PROJECT_DIR` is refused in team mode**, with the reasoning in the error rather than a bare rejection: it would resolve every session to one `.env`, so every agent would push to the same rail as the same connection while appearing to work in its own worktree, and nothing would error. An explicit `projectDir` argument is unambiguous and never refused.

### Fixed

- **A pull no longer silently discards your `game.json` edits.** `spawn_latest` used to overwrite the file wholesale, with no receipt and no mention in the sync summary, even though `spawn_init` puts the entire spec in it. Script sources were the only content with a merge story. There is now a `.spawn/base-game.json` rail and a three-way merge by key path: keys only you moved stay, keys only upstream moved fast-forward, and a key both sides moved keeps **your** value, lands in the reported `conflicts` list as a dotted path, and writes a `game.json.theirs` receipt that blocks `spawn_push` until you resolve it. Same contract the script receipts already had.
- **The project `.env` now wins over the process env** for `SPAWN_AGENT_KEY` and `SPAWN_VARIANT_ID`; process env remains the fallback for a project that carries none. A key in the MCP config used to override every project, which made `spawn_bootstrap` look like it had done nothing and pinned every checkout to one connection. `spawn_status` reports where each credential came from.

### Notes

- Existing projects have no `.spawn/base-game.json`, so the first pull after upgrading keeps the old whole-replace behaviour, copies the previous `game.json` to `.spawn/replaced-game.json` when it would drop anything, and establishes the rail. Pulls merge from then on. `spawn_status` reports `hasSpecRail`.
- `world/*.json` overlays are still not reconciled: they re-apply over pulled content at compile time. Disjoint overlays compose fine, overlapping ones do not. In practice `spawn_init` puts the whole spec in `game.json` and leaves `world/` empty, so the key-path merge covers the common case.
- The shared `.git` is located by reading `.git` directly (a directory in a main checkout, a `gitdir:` pointer plus `commondir` in a worktree) rather than by running `git rev-parse`. This server still spawns no subprocesses.
- Tool count is unchanged at 27 solo, and 33 with team mode on.
- `spawn_init`'s scaffolding is now shared with `spawn_team_add`, so provisioning a teammate's worktree cannot drift from provisioning your own.

## [1.3.0] - 2026-08-11

First tagged release. Everything in this version is about closing the quality gap between what an agent builds through this server and what Savi builds in the Spawn studio. Two causes, addressed separately.

The engine's craft lives in its ~60 skills, not in the API reference, and an agent that never loads them writes code that validates and pushes but lands as untextured primitives and default DOM. Rather than add a prompt telling the model to go read them, the endpoints themselves are now shaped to pull skills in.

### Added

- **`spawn_getting_started`**: the whole workflow in one tool call, plus a checklist of what the project already has (token, variant, `game.json`, docs) and which step is next. Needs no credentials. Most MCP clients never surface prompts to the model, so the `spawn_session` prompt was effectively unread; both now serve the same text from one constant.
- **`spawn_skills`**: the menu of skill ids with descriptions, so a build can be planned against what actually exists. Reads `.spawn/skills.json` when `spawn_init` or `spawn_docs` already saved it, so browsing costs no network call and no credentials, and falls back to the API. Supports `search`, `detail: full|brief`, and `refresh`.
- **`CHANGELOG.md`** (this file).

### Changed

- **`spawn_skill` now takes `ids: [...]`** and loads a set in one call, each skill labelled in the response. Passing several is the natural shape rather than something to repeat. `id` still works as a single-value alias, and duplicates collapse.
- **A wrong skill id answers with the full menu**, so guessing costs one call instead of two and there is no reason to skip loading for want of an id. A partial miss keeps whatever did load and reports the rest.
- **Tool descriptions name the missing craft at the moment it shows up.** `spawn_play_screenshot` says that grey boxes or default browser UI is a missing skill rather than a missing feature; `spawn_push` says a successful push only proves the spec parsed; `spawn_validate` says schema-valid is not the same as good; `spawn_init` hands over a concrete `spawn_skill` call.
- **The session guide gained an art, UI, and look section**, including the fact that image generation and model conjuring are not available through this server at all. That lane belongs to Savi in the studio, so an agent's levers are code-drawn textures, scripted materials, composed primitives, and existing `cdn/` assets.
- **`spawn_savi` is now described accurately** as a one-way note into the creator's studio chat. There is no reply channel and no way to hand Savi a task from here, so an agent should not wait on one.
- README gained an "Art and UI" section; the getting-started guide gained the plain-language version of the same two limits.

### Notes

- Skills are long documents, roughly 7k tokens each, so `spawn_skill` asks for 2 to 4 ids for the work in front of you rather than the whole menu.
- Tool count goes from 25 to 27.

## [1.2.0] and earlier

Untagged. The project declared `1.2.0` in its very first commit and never moved, so there is no release history to reconstruct before this point. For the record, what shipped under that number:

- Initial Spawn MCP server: API tools (bootstrap, game selection, init, docs, spec pull and push with a base-version rail, live-room exec, logs, rooms) plus the Playwright Chromium play client (open, screenshot, input, reload, console, eval, status, close).
- A plain-language getting-started guide.
- Fixes to the play browser and `spawn_exec` found by an end-to-end build, and a test-script fix for Node 20 and Windows, where `node --test` does not expand globs.

[1.4.0]: https://github.com/wfbcargo/wfbcargo_spawn_mcp/releases/tag/v1.4.0
[1.3.0]: https://github.com/wfbcargo/wfbcargo_spawn_mcp/releases/tag/v1.3.0
