# Backlog — {{GAME_NAME}}

The machine state, kept human-readable. Each task is one broad, separable slice — an
*outcome*, never a step list, because the split across sub-agents is what Savi's fan-out
is good at and a prescriptive task wastes it.

## Status vocabulary

- `ready` — decomposed, broad, its area known; not yet dispatched.
- `dispatched` — handed to Savi. Stamped with the head version at dispatch and the tick.
- `landed` — head moved past the stamp; pulled, awaiting a look. (The verify queue.)
- `verified` — a screenshot or an input flow matched the intent. Closed. Logged.
- `reopened` — it landed but was wrong or incomplete. Back in the ready pool with a note.
- `blocked` — waiting on a creator decision or an unbuilt dependency. Never dispatch it.

## Task format

```
### <short title>
- status: ready
- area: scripts/hud/**            # what it touches — becomes keepOff for concurrent tasks
- intent: <one sentence a screenshot could confirm or refute>
- verify: <how — "screenshot the HUD" | "spawn_exec state.x" | "join a phone and tap say">
- dispatched: —                   # head=vN, at=<iso>, attempt=K   (filled on dispatch)
- notes: —
```

## Ready

### (example) the tavern reads as lived-in
- status: ready
- area: `world.places.tavern`, `scripts/world/tavern-dressing.js`
- intent: the tavern has clutter, warm lamplight, and NPCs at tables — not an empty box
- verify: screenshot from the entrance vantage
- dispatched: —
- notes: broad on purpose; let Savi split dressing / lighting / NPCs across lanes

## Dispatched

## Landed (verify queue)

## Verified

## Reopened

## Blocked
