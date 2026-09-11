# Glossary

- **World** — a Spawn game as the platform holds it. Either a `game.json` document or a
  git repo, depending on the lane.
- **Document lane** — pre-6.0. The world IS a compiled GameSpec document.
- **Git lane** — 6.0+. The world IS a git repository; `spawn_push` is `git add -A` and a
  push, live in every open room in about a second.
- **Era** — the engine version string a world is pinned to (`"6.0"` / `"document"`).
- **Variant id** — `SPAWN_VARIANT_ID`; identifies a game on the account. In team mode
  each worktree carries its own `.env`, hence its own identity.
- **Skill** — one of the ~60 engine craft documents (`game-ui`, `drawn-art`, `looks`,
  `match-a-reference`). Long (~7k tokens each). Where the engine's real technique lives;
  the API reference only lists fields.
- **Craft skills / look skills** — the visual cluster of the above. Code written without
  them works but looks like a default.
- **objectApi / `api`** — the engine handle, injected as a function **parameter**, never
  imported. A function without it is pure and runs in plain Node — the basis of the
  local audit.
- **Asset bank** — the user-level record at `~/.spawn-mcp/assets/` of which `cdn/` paths
  produced good art. Exists because a path IS an asset and Spawn has no catalog.
- **Naming is creating** — a `cdn/` asset is generated on first fetch of its path, so the
  path is the prompt. A path cannot be re-rolled.
- **Moodboard namespace** — `/cdn/moodboard-<slug>/<category>-<name>.<ext>`, the
  documented namespaced asset form. A bare `/cdn/<name>.<ext>` shares one global
  namespace with every other Spawn game.
- **Lane (team mode)** — a unit of parallel work claimed by one agent, distinct from an
  engine lane. Context disambiguates; prefer "engine lane" when both are in play.
- **Savi** — the Spawn platform's own build agent, delegated to via `spawn_savi`.
- **UI surface** — one of the 21 Interface In Game element types; the unit the UI
  completeness audit reports on. See `decisions/0001`.
