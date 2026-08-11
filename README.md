# spawn-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io) server for the [Spawn](https://www.spawn.co) Games agent API — plus a **Playwright Chromium play client** so the LLM can open the live game, screenshot it, drive input, and debug without asking you to look.

> **New here?** Read **[GETTING-STARTED.md](GETTING-STARTED.md)** instead — a plain-language walkthrough from install to your first game, no MCP experience assumed. The rest of this file is the technical reference.

## Install

```bash
git clone https://github.com/wfbcargo/wfbcargo_spawn_mcp.git
cd wfbcargo_spawn_mcp
npm install
npm run build
npm run setup        # one-time: downloads Chromium (~150MB) for the play client
```

`npm run setup` is separate on purpose — `npm install` never downloads a browser behind your back, and the API tools work fine without it. Only the `spawn_play_*` tools need Chromium. Equivalent: `npx playwright install chromium`.

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
| `SPAWN_PLAY_HEADED` | `1` | `0` forces headless play sessions |
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

Spawn is WebGPU/canvas — accessibility snapshots won't see the world. Screenshots are the ground truth.

## First connection

1. Spawn gear → **Build with a coding agent** → fresh `sbk_…` key (~5 min, once).
2. **`spawn_bootstrap`** → token lands in project `.env` (masked in tool output). Use a distinct `name` per agent.
3. **`spawn_me`**, then **`spawn_create_game`** (or list + **`spawn_set_variant`**).
4. **`spawn_init`**, read `.spawn/guide.md` + `.spawn/tome-api.md`.
5. **`spawn_play_open`** — agent joins as its own browser client (creator can still keep their tab open).

## Multi-agent

Same creator account needs **no crew setup**. Each agent gets its own key (settings → build with your own agent) and can push the same game concurrently — same model Savi's background builders use.

1. **Publish in the Spawn UI** before unleashing agents. Published (`mode=live`) stays stable for players while agents mutate dev head. There is no agent publish API; agents only *read* live via `spawn_latest` / `spawn_status`.
2. **One project dir (or worktree) per agent** — shared `SPAWN_PROJECT_DIR` will thrash `game.json`, scripts, and `.spawn/base-version`. Same `SPAWN_VARIANT_ID` for everyone.
3. Start with **2–3 agents**, partition script/area ownership, treat **409 `version_conflict`** as normal: `spawn_latest` → merge `.theirs` → push.
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
| `spawn_init` | Scaffold project + docs |
| `spawn_docs` / `spawn_skill` | Guide, tome API, domain skills |
| `spawn_latest` | Pull head / published / version / updateSlug (+ script sync) |
| `spawn_validate` / `spawn_push` | Compile + schema check / live push |
| `spawn_exec` / `spawn_logs` / `spawn_rooms` | Live world inspect |
| `spawn_savi` | Background context for Savi |
| `spawn_revoke` / `spawn_status` | Disconnect / local + head/published health |

### Play browser
| Tool | Purpose |
|------|---------|
| `spawn_play_open` | Launch Chromium on the play URL (screenshot by default) |
| `spawn_play_screenshot` | See the world after a push (jpeg by default; `format:"png"` for flat art) |
| `spawn_play_input` | Keys/mouse (WASD, click, drag, type) |
| `spawn_play_reload` | Hard reload if the client didn't reshape |
| `spawn_play_console` | Page console / pageerror |
| `spawn_play_eval` | Page JS (prefer `spawn_exec` for room state) |
| `spawn_play_status` / `spawn_play_close` | Session health / teardown |

Also: **`spawn_session`** prompt with the full loop (including multi-agent).

## Development

```bash
npm run typecheck   # tsc over src/ + test/
npm test            # node:test suite (no browser needed)
npm run check       # both
npm run build       # emit dist/
```

Tests cover the parts that silently corrupt a project when they regress: the spec compiler, the script path guards, and the three-way pull/merge in `syncPulledScripts`. CI runs them on Node 20/22 across Linux and Windows.

> The `test` script lists test files explicitly rather than globbing — `node --test` only expands globs itself on Node 21+, and Windows shells don't expand them either. **Add new `test/*.test.ts` files to that script or they won't run.**

## Security

- `SPAWN_AGENT_KEY` lives in the game project's `.env` only.
- Tools never echo the full token — `spawn_bootstrap` and `spawn_status` return a masked prefix.
- `.env` and `.spawn/` are gitignored by init/bootstrap.
- The play browser is a normal player client — it runs in a fresh, credential-free context and does not inject the agent key into the page.

### Trust model

This server hands an LLM real capabilities on your machine. Worth knowing before you run it:

- **Filesystem writes** — every tool takes a `projectDir` and writes `.env`, `.gitignore`, `game.json`, `scripts/**`, and `.spawn/**` under it. There is no sandbox beyond the path you pass.
- **Code execution** — `spawn_exec` runs JS in your live room; `spawn_play_eval` runs JS in the play page; `spawn_play_open` will navigate to any URL it's given.
- **Untrusted text flows back to the model** — `spawn_logs`, `spawn_exec`, and `spawn_play_console` return server- and player-influenced content. Treat it as data, not instructions.
- **The API origin is pinned** to `https://www.spawn.co` in [`src/config.ts`](src/config.ts). It is deliberately *not* read from the project `.env` and *not* a tool argument, so neither a cloned game repo nor the model can redirect your bearer token. Only the `SPAWN_API_URL` process env — set by whoever wrote the MCP config — can override it, and only to an `https` origin (or localhost).

## License

MIT — see [LICENSE](LICENSE). Unofficial community project; not affiliated with or endorsed by Spawn.
