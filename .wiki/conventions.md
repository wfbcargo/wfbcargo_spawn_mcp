# Conventions

## Tool descriptions

The description on an MCP tool is the product, not documentation. It is read by a model
that will read nothing else, so it does three jobs:

1. Says what the tool is **for**, in the moment it applies.
2. Says what a bad result **means** — "if it reads as grey boxes, that is a missing
   skill rather than a missing feature."
3. Names **the next call**, concretely, with arguments.

A wrong enum value answers with the real menu rather than an error, so guessing is
cheaper than looking up. Prefer that shape wherever a tool takes a fixed vocabulary.

## Module comments

Every non-trivial module opens with a block comment stating *why the module exists* and
what it deliberately refuses to do — not what it contains. See `src/builtins.ts`,
`src/tree.ts`, `src/brief.ts`. Match that register: prose, specific, no bullet-list
summary of exports.

## Returns

Tool handlers return `text(data)` — a JSON string for structured data, a plain string
for a rendered report — and `err(message)` for failure. Both are local helpers in each
`*-tools.ts` file; do not add a shared abstraction for them.

Rendered reports are built by a pure `formatReport`-style function in the logic module
so it can be unit-tested without a server. Follow `sweep.ts#formatReport`.

## Schemas

`zod` for every tool input. Each field gets `.describe()` — those strings reach the
model and are as load-bearing as the tool description. Optional `projectDir` uses the
shared `projectDirSchema` shape already in the file.

## Naming

`spawn_<group>_<verb>` for tools (`spawn_asset_search`, `spawn_audit_math`,
`spawn_play_screenshot`). Group prefix matches the `*-tools.ts` module.

## Tests

`node:test` + `node:assert/strict`, one file per logic module. The prevailing pattern is
a `project(files)` helper that writes a temp directory of fixture files and an
`after()` that cleans them up — copy it rather than reinventing (`test/sweep.test.ts`).
Register new files in the `test` script in `package.json` (R-009).

## Docs and release

A user-visible change updates, in the same commit: `README.md` (the section that
describes the group), `CHANGELOG.md` (newest first), and the `version` in
`package.json`. The README's voice is essayistic and states measured numbers where it
has them ("six checks over 1,020 calls run in 72 ms") — keep that, and do not invent a
measurement you did not take.
