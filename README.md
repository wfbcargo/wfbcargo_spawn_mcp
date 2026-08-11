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
2. **One project dir (or worktree) per agent.** A shared `SPAWN_PROJECT_DIR` will thrash `game.json`, scripts, and `.spawn/base-version`. Same `SPAWN_VARIANT_ID` for everyone.
3. Start with **2 to 3 agents**, partition script/area ownership, treat **409 `version_conflict`** as normal: `spawn_latest` → merge `.theirs` → push.
4. Label bootstraps (`terrain-agent`, …) and call **`spawn_savi`** after meaningful pushes.

```
spawn_status                 # head vs published, local base, .theirs
spawn_latest                 # pull head (conflict recovery)
spawn_latest mode=live       # inspect published (no local write)
spawn_latest mode=live applyLocal=true   # reset local to published snapshot
```

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

**This MCP has no asset-generation lane.** Conjuring a 3D model from a prompt or generating a texture belongs to Savi in the studio; there is no agent API for it. An agent's art levers are code-drawn textures (`drawn-art`), scripted materials, composed primitives, and `cdn/` assets that already exist. When a build genuinely needs a generated asset, ask Savi in the studio for it and let the agent wire it in.

```
spawn_skill ids=["game-ui","drawn-art","looks"]   # load a set; a bad id returns the menu
spawn_skills                                      # all 60, id + name + description
spawn_skills search="ui"                          # filter over id, name, description
spawn_skills detail="brief"                       # id + name only (the full index is ~9k tokens)
```

The index is read from `.spawn/skills.json` when `spawn_init` / `spawn_docs` has already saved it, so browsing costs no network call; `refresh: true` re-fetches.

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
