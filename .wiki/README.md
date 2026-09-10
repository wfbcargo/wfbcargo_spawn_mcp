# Project wiki — spawn-mcp

Durable, committed memory for this project. Agents read cited sections of it; humans can
read all of it. `.work-log/` is the ephemeral counterpart and is gitignored.

| File | Holds |
|---|---|
| [rules.md](rules.md) | Active invariants, stable IDs. Passed to every sub-agent at spawn. **Hot — keep to one screen.** |
| [architecture.md](architecture.md) | Module layout, the two engine lanes, data flow. |
| [conventions.md](conventions.md) | Tool descriptions, module comments, schemas, tests, release steps. |
| [glossary.md](glossary.md) | Spawn domain terms — lane, era, skill, asset bank, UI surface. |
| [gotchas.md](gotchas.md) | Things that bit us once. |
| [decisions/](decisions/) | One ADR per architectural decision. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |

## Start here

The two facts that explain most of the codebase:

1. **There are two engine lanes** — a world is either a `game.json` document (pre-6.0)
   or a git repository (6.0+). Anything that reads a game branches on this
   (architecture.md, R-005).
2. **The engine injects `objectApi` as a parameter, never an import** — so a game
   function that does not take `api` runs in plain Node. That is the whole basis of the
   local audit, which needs no browser, credentials, or live room.

## Decisions

- [0001 — Interface In Game: links, not scraping](decisions/0001-interfaceingame-links-not-scraping.md)
