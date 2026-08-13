# spawn-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io) server for the [Spawn](https://www.spawn.co) Games agent API, plus a **Playwright Chromium play client** so the LLM can open the live game, screenshot it, drive input, and debug without asking you to look.

> **New here?** Read **[GETTING-STARTED.md](GETTING-STARTED.md)** instead: a plain-language walkthrough from install to your first game, no MCP experience assumed. The rest of this file is the technical reference.

## Install

```bash
git clone https://github.com/wfbcargo/wfbcargo_spawn_mcp.git
cd wfbcargo_spawn_mcp
npm install
npm run build
npm run setup        # one-time: downloads Chromium (~150MB) for the play client
```

`npm run setup` is separate on purpose, so `npm install` never downloads a browser behind your back. The API tools work fine without it; only the `spawn_play_*` tools need Chromium. Equivalent: `npx playwright install chromium`.

## Cursor config

```json
{
  "mcpServers": {
    "spawn": {
      "command": "node",
      "args": ["/absolute/path/to/wfbcargo_spawn_mcp/dist/index.js"],
      "env": {
        "SPAWN_PROJECT_DIR": "/absolute/path/to/your-spawn-game"
      }
    }
  }
}
```

See `mcp.example.json`. On Windows use forward slashes (`C:/Users/you/...`).

| Env var | Default | Purpose |
|---------|---------|---------|
| `SPAWN_PROJECT_DIR` | process cwd | Game project holding `game.json` / `.env` |
| `SPAWN_PLAY_HEADED` | `1` | `0` forces headless (see the warning below); games will not render |
| `SPAWN_TEAM` | unset | `1` enables team mode: adds `spawn_team_*` and the session latch |
| `SPAWN_TEAM_DIR` | shared `.git/spawn-team` | Ledger location, for agents that are not worktrees of one repo |
| `SPAWN_ASSET_BANK` | `~/.spawn-mcp/assets` | Cross-project asset catalog directory |
| `SPAWN_HTTP_TIMEOUT_MS` | `60000` | Abort API calls that hang |
| `SPAWN_API_URL` | pinned in `src/config.ts` | Dev override only; must be `https` (or localhost) |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default | Override where Chromium is installed |

## Loop

```
edit → spawn_validate → spawn_push
     → spawn_play_open (once)
     → spawn_play_screenshot / spawn_play_input
     → spawn_logs / spawn_play_console / spawn_exec if broken
     → fix → push → screenshot again
```

Spawn is WebGPU/canvas, so accessibility snapshots won't see the world. Screenshots are the ground truth.

### Play browser rules

Three things that cost real debugging time if you learn them the hard way:

- **Headed only.** Headless Chromium gets no WebGPU adapter (`requestAdapter()` returns `null`, SwiftShader flags included), so Spawn refuses to start and every screenshot is its *"One graphics fix away"* gate rather than your game. `spawn_play_open` probes this and reports `webgpu: "ok" | "unavailable"` with an explanation. Leave `SPAWN_PLAY_HEADED` unset, and only use `headed: false` to reach a non-Spawn page.
- **`spawn_play_eval` cannot touch your game UI.** `ui.js` renders into a *cross-origin sandboxed iframe*, so `document.querySelector` in the top frame finds none of your buttons and reaching into the frame throws. Click UI with `spawn_play_input` coordinates: screenshot, read the button's position off the image, click it. (`spawn_play_eval` also takes an expression, not a function body: wrap statements in an IIFE.)
- **`spawn_exec` needs a live room and cannot read your database.** Rooms exist only while a player is connected, so call `spawn_play_open` first or you get a 5xx (the error says so). The endpoint is read-only server-side and refuses `api.sql` outright, even `SELECT`, so there is no way to query the game's SQLite from this server. Verify persistence through replicated state instead.

## First connection

1. Spawn gear → **Build with a coding agent** → fresh `sbk_…` key (~5 min, once).
2. **`spawn_bootstrap`** → token lands in project `.env` (masked in tool output). Use a distinct `name` per agent.
3. **`spawn_me`**, then **`spawn_create_game`** (or list + **`spawn_set_variant`**).
4. **`spawn_init`**, read `.spawn/guide.md` + `.spawn/tome-api.md`.
5. **`spawn_play_open`**: agent joins as its own browser client (creator can still keep their tab open).

## Multi-agent

Same creator account needs **no crew setup**. Each agent gets its own key (settings → build with your own agent) and can push the same game concurrently, the same model Savi's background builders use.

1. **Publish in the Spawn UI** before unleashing agents. Published (`mode=live`) stays stable for players while agents mutate dev head. There is no agent publish API; agents only *read* live via `spawn_latest` / `spawn_status`.
2. **One project dir (or worktree) per agent.** A shared `SPAWN_PROJECT_DIR` will thrash `game.json`, scripts, and `.spawn/base-version`. Same `SPAWN_VARIANT_ID` for everyone. Credentials resolve from the project's own `.env` first, so a git worktree each (`.env` and `.spawn/` are untracked) is what makes them separate connections. A key in the MCP config env is only a fallback for projects that carry none.
3. Start with **2 to 3 agents**, partition script/area ownership, treat **409 `version_conflict`** as normal: `spawn_latest` → merge `.theirs` → push.
4. Label bootstraps (`terrain-agent`, …) and call **`spawn_savi`** after meaningful pushes.

```
spawn_status                 # head vs published, local base, .theirs, credential source
spawn_latest                 # pull head (conflict recovery)
spawn_latest mode=live       # inspect published (no local write)
spawn_latest mode=live applyLocal=true   # reset local to published snapshot
```

### Team mode

Opt-in bookkeeping for the above. Set `SPAWN_TEAM=1` in the first session's MCP config and run `spawn_team_init` in each agent's worktree. That writes a roster into the repo's shared `.git/spawn-team/`, which every worktree finds with no configuration and nobody can commit by accident, so later sessions pick the mode up on their own and need no extra config.

| Tool | Purpose |
|------|---------|
| `spawn_team_init` | Create the ledger if absent, register this worktree under a label |
| `spawn_team_status` | Every agent, how far behind head each rail is, who has unresolved receipts, open claims, recent pushes |
| `spawn_team_claim` / `spawn_team_release` | Take or give up ownership of `game.json` key paths and `scripts/` globs |
| `spawn_team_add` | Stand up a new agent's worktree: variant, own token, scaffold, roster entry |
| `spawn_team_brief` | Ready-to-paste opening prompt for one builder, or the whole team |

Four behaviours change while it is on:

- **One session drives one agent.** `spawn_push`, `spawn_latest applyLocal`, `spawn_revoke`, and `spawn_play_open` latch to the first project directory they see and refuse a second one. Identity, the version rail, and the single Chromium session all belong to one directory, so driving two from one session pushes one agent's work onto the other's rail and points its screenshots at the wrong client. Read-only tools stay free to inspect any worktree, and `spawn_bootstrap` / `spawn_init` stay free so a new worktree can be provisioned from anywhere.
- **A globally configured `SPAWN_PROJECT_DIR` is refused**, with an explanation, rather than used. It would resolve every session to one `.env`, so every agent would push as the same connection while appearing to work in its own worktree. An explicit `projectDir` argument is never refused.
- **Pushes serialise and rebase.** `spawn_push` takes a ledger-wide lock, and from inside it "behind head" can only mean a teammate landed a push since your last sync, so it pulls first. A clean rebase costs you nothing and the 409 never happens. A rebase that collides stops the push with your work intact and the conflicts named, because that needs a decision no server should make. `force: true` skips the rebase, since it is a deliberate whole-replace.
- **Claims warn on push.** Changes are diffed against the base rails, so what gets checked is exactly your own edits, and touching another agent's claim is reported alongside the successful push. Advisory by design: a stale claim must never become a hostage situation.

Claim `game.json` key paths (`entities.player`, `world.terrain`) and script globs (`scripts/hud/**`). Everything except `scripts/**` is claimed by key path, because `spawn_init` puts the whole spec in `game.json`; a `world/foo.json`-style pattern is rejected rather than silently never matching.

Solo, none of this exists: the tool list stays at 32, nothing latches, and pushes take no lock.

Adding an agent is two calls plus one command you run yourself:

```
spawn_team_add label="terrain" worktreePath="../game-terrain" branch="terrain"
  → returns: git worktree add -b terrain ../game-terrain     # run it; this server never executes git
spawn_team_add label="terrain" worktreePath="../game-terrain" bootstrapKey="sbk_…"
  → writes its variant, trades the key for its OWN token, scaffolds, registers it
spawn_team_brief label="terrain"
  → the opening prompt to paste into a session started in that worktree
```

Mint the `sbk_` key just before the second call: they are single-use and expire in about five minutes. `spawn_team_brief` with no label briefs the whole team at once.

The fuller design, including what is deliberately not built and why, is in [TEAM-MODE.md](TEAM-MODE.md).

### What a pull merges

`spawn_latest` three-way merges against the last-seen upstream, tracked in `.spawn/base-scripts.json` and `.spawn/base-game.json`. Disjoint edits compose; only genuine overlap conflicts.

| Content | Merged | Conflict lands as |
|---------|--------|-------------------|
| `scripts/**` | per file, by content | `<file>.theirs` beside it |
| `game.json` | per key path | `game.json.theirs` (upstream's whole spec) |
| `world/*.json` | **no** | nothing, see below |

A conflict always keeps **your** value and names what collided (a path, or a dotted key like `entities.player.hp`). `spawn_push` refuses to run until every receipt is resolved and deleted.

`world/*.json` overlays are the gap. They are deep-merged onto `game.json` at compile time and never reconciled, so a stale overlay re-applies over freshly pulled content and pushes back up. Disjoint overlays are fine; two agents writing the same key are not, and nothing will warn you.

Projects created before this rail existed have no `.spawn/base-game.json`. Their first pull keeps the old whole-replace behaviour, copies the previous `game.json` to `.spawn/replaced-game.json` if that drops anything, and establishes the rail. `spawn_status` reports `hasSpecRail`.

## Tools

### API
| Tool | Purpose |
|------|---------|
| `spawn_bootstrap` | Trade `sbk_…` → durable token in `.env` |
| `spawn_me` | Whoami |
| `spawn_list_games` / `spawn_create_game` / `spawn_set_variant` | Pick a game |
| `spawn_getting_started` | Whole workflow + what this project already has (no credentials needed) |
| `spawn_init` | Scaffold project + docs |
| `spawn_docs` | Guide, tome API, skills index |
| `spawn_skills` / `spawn_skill` | Browse the skill menu / load a set of skills by id |
| `spawn_latest` | Pull head / published / version / updateSlug (+ script sync) |
| `spawn_validate` / `spawn_push` | Compile + schema check / live push |
| `spawn_exec` / `spawn_logs` / `spawn_rooms` | Live world inspect (needs a live room; no SQL) |
| `spawn_savi` | Background context for Savi |
| `spawn_revoke` / `spawn_status` | Disconnect / local + head/published health |

### Asset bank
| Tool | Purpose |
|------|---------|
| `spawn_asset_sync` | Pull every game on your account and harvest its live spec (slow; the authoritative fill) |
| `spawn_asset_scan` | Harvest `cdn/` paths from local projects into the cross-project bank |
| `spawn_asset_search` | Find an asset you already used, before inventing a new name (`facets`, `category`, `minGames`) |
| `spawn_asset_note` | Name, categorize, describe, mark good/bad, point a bad name at its replacement |
| `spawn_asset_preview` | Check existence on the CDN; render images inline so the model can see them |

### Local audit
| Tool | Purpose |
|------|---------|
| `spawn_audit_scan` | List exported functions and say which are auditable without a live room |
| `spawn_audit_math` | Sweep pure functions across declared input domains and check invariants |

### Play browser
| Tool | Purpose |
|------|---------|
| `spawn_play_open` | Launch Chromium on the play URL (headed; screenshot by default) |
| `spawn_play_screenshot` | See the world after a push (jpeg by default; `format:"png"` for flat art) |
| `spawn_play_input` | Keys/mouse (WASD, click, drag, type); the only way to click game UI |
| `spawn_play_reload` | Hard reload if the client didn't reshape |
| `spawn_play_console` | Page console / pageerror |
| `spawn_play_eval` | Top-frame page JS only; cannot see or click game UI |
| `spawn_play_status` / `spawn_play_close` | Session health / teardown |

Also: **`spawn_session`** prompt with the full loop (including multi-agent). `spawn_getting_started` returns the same text as a tool call, because most clients never surface prompts to the model.

## Art and UI

The most common quality gap in an agent build is visual, and it has two causes worth knowing.

**The engine's craft lives in skills, not in the API reference.** There are ~60 of them, and the visual cluster (`drawn-art`, `game-ui`, `looks`, `custom-materials`, `fx`, `3d-sprites`, `world-composition`, `match-a-reference`) is where textures, HUDs, colour grade, and shader surfaces are actually explained. An agent that skips them writes untextured primitives and default DOM.

Rather than rely on a prompt telling the model to go and read them, the endpoints are shaped to pull skills in: `spawn_skill` takes `ids: [...]` so the natural call carries the whole set (mechanic *and* look), `spawn_push` and `spawn_play_screenshot` say in their own descriptions that a plain-looking result is a missing skill rather than a missing feature, and a wrong id answers with the full menu, so guessing is cheaper than looking up.

**Naming is creating.** A `cdn/` asset is generated on first fetch of its path and cached there forever, so the path *is* the asset: reference `/cdn/moodboard-<slug>/<category>-<name>.<ext>` and that model, texture, or clip comes into being. Agents create art by naming it, and the name is the prompt. Two consequences the tools are built around: a path cannot be re-rolled (a bad result means picking a different name, permanently), and a bare `/cdn/<name>.<ext>` with no moodboard folder shares one global namespace with every other game. See **[the asset bank](#asset-bank)** below and [ASSET-BANK.md](ASSET-BANK.md).

```
spawn_skill ids=["game-ui","drawn-art","looks"]   # load a set; a bad id returns the menu
spawn_skills                                      # all 60, id + name + description
spawn_skills search="ui"                          # filter over id, name, description
spawn_skills detail="brief"                       # id + name only (the full index is ~9k tokens)
```

The index is read from `.spawn/skills.json` when `spawn_init` / `spawn_docs` has already saved it, so browsing costs no network call; `refresh: true` re-fetches.

## Asset bank

Because a path *is* an asset, the same path in two games is the same asset — cross-project sharing costs nothing and needs no tooling. What Spawn has no API for is a **catalog**: the guide says so outright ("there is no catalog"). So a name that produced something great is unrecoverable knowledge the moment you forget how you spelled it, and a name that produced something bad is permanently bad, because you cannot re-roll a path.

The bank is the local record of that judgment, kept in `~/.spawn-mcp/assets/` — user-level, not per-repo, since its whole value is crossing games.

```
spawn_asset_sync                                           # every game on your account (start here)
spawn_asset_scan dirs=["../game-one","../game-two"]        # local-only: harvest what the checkouts cite
spawn_asset_note path="cdn/…/texture-packed-earth.png" name="dirt" category="terrain" verdict="good"
spawn_asset_search query="dirt"                            # before inventing a name
spawn_asset_search category="terrain"                      # or by your own grouping
spawn_asset_search facets=true                             # what categories/kinds/families exist
spawn_asset_search minGames=2                              # proven: reused across games
spawn_asset_preview path="dirt"                            # a name works anywhere a path does
```

**Start with `spawn_asset_sync`.** There is no asset API on Spawn (`/api/agent/v1/assets` and friends are `404`), so the only account-wide record is what your games have pushed. The sync lists every game you own, fetches each one's current spec, and harvests it — which sees things a local scan cannot: games with no checkout on this machine, and assets a teammate or Savi pushed that never reached your disk. On the account this was built against a local scan of three projects found **169** assets and the sync found **408**. It is slow by design (one spec fetch per game, four at a time; six games ≈ 3s), so it is a tool you run deliberately.

Every asset tool reports a `syncAdvice` line when the bank is empty, never synced, or over a week stale — not just search. A stale bank answers "no match", the model coins a fresh path, and an asset that already exists under a good name gets regenerated under a second one. Since a path cannot be re-rolled, those two names can never be merged.

**Name your assets.** A name is a short unique handle, and every tool that takes a path takes a name instead — `spawn_asset_preview path="knight"` rather than 60 characters of style family and hyphenation. Alongside it, `category` is your own grouping ("enemies", "ui-icons"), kept separate from the filename's `prefix` (`model-`, `texture-`) so a rescan can never overwrite a judgement.

**Results report how many *games* use an asset, not how many directories.** In team mode one game is several worktrees, so counting directories would report a three-agent team as three games. Each use records the variant id from that project's own `.env`, and the count collapses on it. Reuse across games is the best evidence an asset actually worked, so it feeds ranking and `minGames` filters on it.

**One file per style family**, plus `_meta.json`, with the `root` namespace split by prefix (`root-effect.json`, `root-sfx.json`) since it is usually the biggest group. At a measured 821 bytes/asset a 10k-asset bank is ~7.8 MB and parses in ~19 ms, so this is not about search speed — it keeps a one-field note from rewriting the whole catalog, and keeps each file openable.

`spawn_asset_preview` checks the storage host directly rather than the `/cdn/` cook route. Storage answers a plain 200/404 and never generates, so a 404 honestly means "not created yet" instead of "not allowed to ask" — and for images it hands the bytes back inline, so the model judges the art instead of guessing from the filename. Models and audio report existence only; put those in the world and use `spawn_play_screenshot`.

Paths are classified as `moodboard` (the documented namespaced form), `root` (a bare global name, shared with every other Spawn game), `custom`, or `ingested` (opaque `public.<base64>` uploads, which carry no naming guidance and rank last).

**A namespace warning is loud only while the name can still change.** A path that is already generated — or already referenced by a game — cannot be re-rolled, so telling you to rename it is not advice; those collapse to one counted line per kind. A path storage has never seen gets the full recommendation, because that is the only moment it can be acted on.

The design, including what is deliberately not built, is in [ASSET-BANK.md](ASSET-BANK.md).

## Local audit

Reviewing a build is slow because every question gets asked through the same instrument: a
headed browser, a screenshot, and a judgement call. Plenty of those questions are arithmetic,
and arithmetic does not need a browser.

Game scripts are plain JS, and the engine injects `objectApi` as a **parameter** rather than an
import — so a function that does not take `api` cannot reach the engine and runs fine in Node.
That is the whole basis for these two tools. Neither needs credentials, a push, a live room or
Chromium.

```
spawn_audit_scan                     # what can be checked locally, and what needs a room
spawn_audit_math                     # run audit/math.json
spawn_audit_math checks=[…]          # try one rule without saving it first
```

`spawn_audit_scan` classifies by signature: no `api` parameter and no engine-only `require`
means the function is pure. On a real 77-script game that is 185 of 271 exported functions.

`spawn_audit_math` reads **`audit/math.json` in the game project**, because per-game invariants
are not knowledge a generic server can hold. This server owns the runner; the game owns the
assertions — a test runner, and tests.

```json
{
  "checks": [
    {
      "id": "wave-bodies-all-fit",
      "module": "scripts/battle-system.js",
      "export": "planWave",
      "args": [
        { "name": "tier", "range": [1, 12] },
        { "name": "waveInTier", "range": [1, 5] },
        { "name": "popMult", "values": [1, 1.5, 2, 3] }
      ],
      "select": "dropped",
      "assert": { "finite": true, "max": 0 }
    }
  ]
}
```

Domains are `range` (with optional `step`), `values`, or `const`. Assertions cover `finite`
(NaN and Infinity), `integer`, `min`/`max`, the four monotonicity forms (`increasingIn`,
`nondecreasingIn`, `decreasingIn`, `nonincreasingIn`, naming an argument), and `expr` for
anything else. `select` pulls a field out of an object result. Failures report the **exact
arguments** that produced them, so a finding is a line you can paste into a REPL.

On the game this was built against, six checks over 1,020 calls run in **72 ms** and pin a
formation that does not fit its zone to one wave: `T3.3`.

Two deliberate refusals. A sweep that exceeds its call budget reports `CAPPED from N` rather
than truncating quietly, because a bounded sweep reported as a full one reads as "covered
everything". And the engine-only builtins (`fx`, `geom`, `three`, `tsl`, `vibe`,
`room-routing`, `primitives`) are refused rather than stubbed — a stub lets a check pass
against behaviour that never ran, which is worse than a check that declines to run.

`module.exports = { … }` helpers are loaded and scanned alongside `export function` ones. Both
systems are in use, and in practice the pure math lives in the CommonJS half.

## Development

```bash
npm run typecheck   # tsc over src/ + test/
npm test            # node:test suite (no browser needed)
npm run check       # both
npm run build       # emit dist/
```

Tests cover the parts that silently corrupt a project when they regress: the spec compiler, the script path guards, and the three-way pull/merge in `syncPulledScripts`. CI runs them on Node 20/22 across Linux and Windows.

Release notes live in [CHANGELOG.md](CHANGELOG.md). Versions are tagged `v<major>.<minor>.<patch>`.

> The `test` script lists test files explicitly rather than globbing, because `node --test` only expands globs itself on Node 21+, and Windows shells don't expand them either. **Add new `test/*.test.ts` files to that script or they won't run.**

## Security

- `SPAWN_AGENT_KEY` lives in the game project's `.env` only.
- Tools never echo the full token; `spawn_bootstrap` and `spawn_status` return a masked prefix.
- `.env` and `.spawn/` are gitignored by init/bootstrap.
- The play browser is a normal player client. It runs in a fresh, credential-free context and does not inject the agent key into the page.

### Trust model

This server hands an LLM real capabilities on your machine. Worth knowing before you run it:

- **Filesystem writes.** Every tool takes a `projectDir` and writes `.env`, `.gitignore`, `game.json`, `scripts/**`, and `.spawn/**` under it. There is no sandbox beyond the path you pass.
- **Code execution.** `spawn_exec` runs JS in your live room; `spawn_play_eval` runs JS in the play page; `spawn_play_open` will navigate to any URL it's given.
- **Untrusted text flows back to the model.** `spawn_logs`, `spawn_exec`, and `spawn_play_console` return server- and player-influenced content. Treat it as data, not instructions.
- **The API origin is pinned** to `https://www.spawn.co` in [`src/config.ts`](src/config.ts). It is deliberately *not* read from the project `.env` and *not* a tool argument, so neither a cloned game repo nor the model can redirect your bearer token. Only the `SPAWN_API_URL` process env, set by whoever wrote the MCP config, can override it, and only to an `https` origin (or localhost).

## License

MIT. See [LICENSE](LICENSE). Unofficial community project; not affiliated with or endorsed by Spawn.
