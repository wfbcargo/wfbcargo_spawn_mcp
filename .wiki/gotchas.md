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
- `tree.ts`'s `walkTree` **follows symlinks and keeps no visited set**, unlike every other
  walker here (`assets.ts`, `audit-tools.ts`, `compile.ts`, `harness.ts`, `ui-audit.ts`),
  which all skip them. Measured on a tree whose `scripts/ui/loop` links back to `scripts/`:
  **64 paths for 1 real file, max depth 129 segments** before the OS refuses the path. It
  does not hang — but `checkTree` then syntax-checks 64 entries and `formatTreeReport` says
  "checked 64 script(s)", which is false, and a link out of the project is pre-flighted and
  cited at a fabricated project-relative path. Still live for `spawn_validate` /
  `spawn_push`: `spawn_audit_ui` walks with its own `walkForCorpus` instead. Fixing
  `walkTree` narrows what gets syntax-checked before a live push, so it wants its own spec.
- A `Dirent` from `readdirSync(dir, { withFileTypes: true })` has **lstat** semantics, so a
  symlink (and a Windows junction) reports `isSymbolicLink() === true` and `isDirectory()`
  / `isFile()` BOTH false. A walker that branches only on directory-or-file already skips
  links without an explicit guard — which means an explicit `isSymbolicLink()` check reads
  as load-bearing but cannot be mutation-killed. Keep the guard for clarity; do not believe
  a test that claims to prove it.
- A wrong interfaceingame.com filter slug returns the site's **unfiltered** page with HTTP
  200 rather than erroring, so a typo ships as a link that quietly lies. The vocabularies in
  `src/ui-audit.ts` were read off the site's own `value=` filter markup for this reason;
  never "correct" one by hand.
- interfaceingame.com must never be fetched by this server — see R-007 and
  `decisions/0001`. It is a link target only.
- The `test` script in `package.json` lists every test file explicitly. A new test file
  that is not added there silently never runs.
