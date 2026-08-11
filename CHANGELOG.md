# Changelog

Notable changes to spawn-mcp. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The project `.env` now wins over the process env** for `SPAWN_AGENT_KEY` and `SPAWN_VARIANT_ID`; process env remains the fallback for a project that carries none. A key in the MCP config used to override every project, which made `spawn_bootstrap` look like it had done nothing and pinned every checkout to one connection. `spawn_status` reports where each credential came from.

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

[1.3.0]: https://github.com/wfbcargo/wfbcargo_spawn_mcp/releases/tag/v1.3.0
