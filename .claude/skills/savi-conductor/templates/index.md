# Savi wiki — {{GAME_NAME}}

The traversable map. A conductor that has lost its context re-enters here: read this
page, follow the links, and you know the state of the build without the chat history.

## Pillars

See [vision.md](vision.md) for the why. In one line: {{ONE_LINE_VISION}}.

## Conductor lane

The area this conductor builds itself (everything else is fanned out to Savi). Passed as
`keepOff` on every handoff so Savi's sub-agents route around it.

- **Owns:** {{CONDUCTOR_LANE}}   e.g. `scripts/player/**`, `world.terrain`

## Areas

One file each. The intent, the current state, and the open questions for a subsystem.

- [areas/example.md](areas/example.md) — replace with real areas

## Status

Updated every tick. The numbers come from [backlog.md](backlog.md).

- ready: 0 · dispatched: 0 · landed: 0 · verified: 0 · reopened: 0 · blocked: 0
- head at last reconcile: v0
- last tick: never

## How this wiki is driven

The `savi-conductor` skill ticks over this wiki: it reconciles what landed, fans ready
work out to Savi when lanes are free, builds the conductor lane, and reschedules itself.
Nothing here is edited by hand while the loop runs — the loop owns it.
