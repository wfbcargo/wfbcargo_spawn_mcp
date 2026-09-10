# Architecture

A local MCP server (stdio) wrapping the Spawn Games agent API, plus a Playwright play
client. Published to npm as `spawn-mcp`; `dist/` is the shipped artifact, `src/` is the
source of truth.

## Shape

`src/index.ts` builds one `McpServer` and calls a `register*Tools(server)` per tool
group. That registration call is the whole composition root — there is no DI, no
plugin loader.

```
index.ts
├── tools.ts          API surface: init, docs, skills, spec, push, exec, logs, status
├── play-tools.ts     the body in the world (browser.ts, player.ts)
├── player-tools.ts   player identity / session
├── asset-tools.ts    the asset bank (assets.ts)
├── audit-tools.ts    LOCAL audit: no network (sweep.ts, harness.ts, builtins.ts, ui-audit.ts)
└── team-tools.ts     multi-agent team mode (team.ts, git.ts) — conditional on team.enabled
```

Tool modules are thin: schema, argument marshalling, and the description text. The
logic they call lives in a sibling non-`-tools` module that is pure and unit-tested.
`audit-tools.ts` → `sweep.ts` and `ui-audit.ts`; `asset-tools.ts` → `assets.ts`. Keep that split — the
tests target the logic module, not the tool.

## The two lanes (`engine.ts`)

The single most load-bearing distinction in the codebase.

| Lane | Era | A world IS | Edited by |
|---|---|---|---|
| document | pre-6.0 | a compiled `game.json` GameSpec | reading/merging the spec document |
| git | `6.0`+ | a git repository of scenes, scripts, assets | cloning, editing files, `git push` |

`engine.ts` detects the lane, `laneName()` renders it, and `isGitLane()` branches on it.
A caller may pass `engineVersion` to assert one; a mismatch with the world's real pin is
refused, not silently accepted. **Anything that reads a game's content must branch here**
(R-005).

## Project directory resolution (`env.ts`)

Every tool takes an optional `projectDir` and falls back to `SPAWN_PROJECT_DIR` then
`cwd`. In team mode a globally configured `SPAWN_PROJECT_DIR` is *refused* rather than
used, because one pinned dir collapses every worktree onto one Spawn identity. The
project `.env` owns the identity; process env is a fallback, never an override.

## The local audit (`audit-tools.ts` → `sweep.ts`, `harness.ts`, `builtins.ts`, `ui-audit.ts`)

The engine injects `objectApi` as a **parameter**, never as an import — so a function
that does not take `api` cannot reach the engine and runs fine in plain Node. That one
fact is the entire basis for the **math** audit: `harness.ts` loads game scripts,
`builtins.ts` reimplements the documented pure helpers, `sweep.ts` runs declared
invariants over argument domains. No browser, no credentials, no push.

`spawn_audit_ui` reaches the same place by a different route: it runs no game code at
all. Whether a pause overlay *exists* is answerable by reading scripts and scenes, so it
needs no browser for the same reason arithmetic does not — it is counting, not rendering.
What it deliberately cannot answer is whether the overlay looks right: its verdicts are
only `found` and `missing`, where `found` means the surface's name appears and makes no
claim at all about the screen (R-001). `spawn_play_screenshot` remains the only authority
on appearance.

Per-game assertions live in the **game project** (`audit/math.json`, `audit/ui.json`),
not in this server: this server owns the runner, the game owns the tests.

## Data flow for a typical build turn

`spawn_init` (clone or fetch spec) → `spawn_skill` (load craft) → edit files →
`spawn_push` → `spawn_play_screenshot` (visual check) → `spawn_audit_*` (local checks).

## Not in scope

No database, no server state, no background jobs. Everything is a request/response
against the Spawn API, the filesystem, or a Playwright page. State that outlives a call
lives in the game project (`.spawn/`, `.git/spawn-mcp/`) or the user-level asset bank
(`~/.spawn-mcp/assets/`).
