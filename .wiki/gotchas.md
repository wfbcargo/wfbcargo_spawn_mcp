# Gotchas

- A 6.0 push is `git add -A` and lands live in every open room within about a second.
  There is no staging step and no dev/live split. `spawn_push` refuses while this
  server's own session artifacts are in the tree.
- A 6.0 world tracks `.spawn/` **itself**, so this server's files go under
  `.git/spawn-mcp/` and `.env` goes in `.git/info/exclude` — the world's own
  `.gitignore` is never touched.
- A `cdn/` asset path cannot be re-rolled. A bad result means picking a different name,
  permanently; the two names can never be merged.
- `spawn_asset_sync` finds assets a local scan cannot (games with no checkout, pushes by
  a teammate or Savi). Measured: local scan of three projects found 169, sync found 408.
- Asset use counts collapse on the variant id, not the directory — in team mode one game
  is several worktrees, and counting directories reports a three-agent team as three
  games.
- `builtins.ts` is written from documented names only; the engine's source is not
  distributed. A check whose verdict turns on a subtle builtin edge case is evidence
  about that file, not about the game.
- Non-pure builtins (`fx`, `geom`, `three`, `tsl`, `vibe`, `room-routing`, `primitives`)
  are absent, not stubbed. Reaching one fails loudly. This is deliberate — see R-001.
- In team mode a globally configured `SPAWN_PROJECT_DIR` is refused, not used. It would
  collapse every worktree onto one Spawn identity.
- interfaceingame.com must never be fetched by this server — see R-007 and
  `decisions/0001`. It is a link target only.
- The `test` script in `package.json` lists every test file explicitly. A new test file
  that is not added there silently never runs.
