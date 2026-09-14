# 0002 — Social baseline in the server; drop-in design as an optional skill

- Status: accepted
- Date: 2026-09-14

## Context

Two kinds of game-design guidance were asked for at once, and they have different force.

1. **Spawn's social layer**: in-game chat, parties of friends, and portals to other worlds
   that bring the party along. The creator wants every game to support these natively.
   Engine 6.0 ("One Place", 2026-09-05) exposes the game-code side:
   - `player.party: { id, leader } | null`, read-only
   - place `instance: party`
   - `ctx.cross(entity, link)` to a place, a room, or another creator's world
   - `onArrive` / `onLeave` / `admits`
   - the `window.publicUrl + "/room:" + name` invite link

   Chat and voice belong to the platform, and a right-edge rail is reserved for them.
2. **A preferred game shape** for the weekly Spawn Jam and for open briefs: quick to jump
   into, small and self-contained, safe to leave and return to, optionally multiplayer, cheap
   to run. The creator was explicit that builders stay free to make other games, and that this
   shape applies only where the opportunity exists.

Guidance can live in two places here.
- **In the server**: `SESSION_GUIDE` and its siblings in `src/session.ts`, served by
  `spawn_getting_started` and the `spawn_session` prompt. This reaches every agent in every MCP
  client, and it costs context on every session.
- **As a Claude skill** under `.claude/skills/`. It loads on demand, costs nothing until it
  triggers, and only reaches Claude Code sessions that have it installed.

## Decision

- **The social baseline is server text** (`SOCIAL_GUIDE`), appended to both the tool and the
  prompt, with a one-line pointer in `spawn_team_brief`. It is a requirement on every game, so
  it has to reach agents that never load a skill. It is kept to what a builder must not break
  and must provide: no chat of its own, the rail kept clear, parties kept together, a door out,
  arrival from any door, invites as links, and leaving without harm. It names the pre-6.0 lane's
  narrower surface (R-005).
- **The drop-in shape is an optional skill** (`.claude/skills/drop-in-games/`). It covers a
  six-test definition, eight archetypes, a design order, 6.0 moves, jam specifics, a review
  checklist, and the sourced research behind it. `SESSION_GUIDE` carries a three-line nudge
  towards the shape for open briefs, and names the skill "if installed", so non-Claude clients
  still get the default without the depth.

## Consequences

- Every `spawn_getting_started` call is ~50 lines longer. That is accepted, because social
  support is not optional.
- **Unverified surfaces are named as unknown, not documented (R-001).**
  - The 6.0 `chat` skill (`scripts/chat.js`, voice keys) is not served by the skills endpoint, and
    this server cannot reach the engine git repo that holds it. The guide says not to write
    `scripts/chat.js` from a guess.
  - Whether a party auto-follows a member through `cross()` into another world is stated by the
    creator but not by any fetched doc. The guide tells games to *receive* parties together rather
    than claiming a mechanism.
- The skill's jam facts (theme, prize, dates) and player-count numbers go stale. The skill says
  to re-check spawn.co/jam, and its research file dates every figure.
- **Deliberately not built:** a `spawn_audit_*` check for social surfaces (for example, "an exit
  portal exists", "onArrive reads party"). It would fit the UI audit's found/missing model, and
  is the natural next step if builds keep missing the baseline.
