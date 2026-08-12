# Changelog

Notable changes to spawn-mcp. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
