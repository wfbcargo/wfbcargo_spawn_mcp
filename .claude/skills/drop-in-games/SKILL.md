---
name: drop-in-games
description: >-
  Design lens for Spawn games that people jump into in seconds, play in a small self-contained
  space, leave without loss and come back to — solo-viable, better with a party, and cheap to run.
  Grounded in what wins Spawn Jams and in the Roblox, Fortnite Creative, Rec Room, .io and Jackbox
  hits with this shape. Optional: use it when the creator has not fixed a design (a Spawn Jam entry,
  "make me a game", "something my friends and I can play", an open or vague brief), when picking a
  concept for a jam theme, or when reviewing a build for time-to-fun, round flow, late join, party
  play, or server cost. When the creator already has a vision, build theirs and borrow only the parts
  that fit.
---

# Drop-in games on Spawn

A drop-in game is one a stranger clicks into, understands by doing, plays for two minutes or
twenty, walks out of through a portal with their friends, and returns to without having lost
anything. It is the shape of most breakout games on community platforms, and it is the shape
that suits Spawn: a weekly jam judged in the first few minutes of play, worlds joined from a link
on a phone, and a social layer — chat, parties, portals — that moves groups from game to game.

**This is a lens, not a genre and not a rule.** Creators build what they want. Use this skill
to choose a concept when nobody has, and otherwise to find the drop-in version of what the
creator asked for: a sprawling RPG still benefits from a playable first ten seconds and from
not losing progress on a closed tab.

The social baseline (Spawn owns chat; parties stay together; every game has a door out) is
**not** part of this optional lens — it applies to every game and is in `spawn_getting_started`.
This skill assumes it and builds on it.

## The shape, in six tests

A concept passes when every answer is yes. Ask them before the first file, and again at review.

| # | Test | Passes when | Fails when |
|---|---|---|---|
| 1 | **Acts in 3 seconds** | Arrival puts a body in the world with the core verb usable; the game explains itself by being played within 30 s | Title screen, "press start", a menu, a text tutorial, a wait for other players |
| 2 | **One verb, one space** | The whole game is one sentence ("tag the others before the lava rises") in one room-sized area the camera can hold | Several systems to learn, a map that needs travel or a minimap |
| 3 | **Joins any time** | A player arriving mid-round plays at once or watches from a safe spot with a visible "next round in N s" | Late joiners locked out, or dropped into a running match mid-danger |
| 4 | **Leaves any time** | A leaver costs nobody their round and loses nothing earned; returning shows their progress, grown if time passed | A round that stalls on a missing player; progress that lived only in memory |
| 5 | **Solo-viable, better together** | One player has a real game (score chase, ghost, simple rule-driven hazards); goals scale with headcount; friends change it | "Waiting for 4 players"; a multiplayer game where players never have to notice each other |
| 6 | **Cheap to run** | Timers, discrete events, and state written when it changes; any "enemy" is a rule or a timer | Swarms of pathfinding AI, synced rigid-body piles, per-tick writes, per-tick SQL |

## Pick an archetype

Start from a proven loop and put **one twist** on it (the jam theme is usually the twist). Full
catalog with examples, why each works, and a Spawn sketch: [reference/archetypes.md](reference/archetypes.md).

| Archetype | Core loop | Think of |
|---|---|---|
| Round-based party | Short timed round on a shared clock, intermission, repeat | Natural Disaster Survival, The Floor Is LAVA, Dress to Impress |
| Course / obby | Everyone on the same course, reset on a timer | Tower of Hell, DOORS (co-op run) |
| King of the hill / arena | Tiny arena, instant respawn, a contested spot or score | Gorilla Tag, The Pit, agar.io |
| Social deduction / chase | Hidden or asymmetric roles, a timed round, a reveal | Murder Mystery 2, Flee the Facility, Among Us |
| Create and vote | Everyone makes something against a prompt; the room judges | Dress to Impress, skribbl.io, Gartic Phone |
| Idle / garden | A plot that grows while you are gone; small shared economy | Grow a Garden, Steal a Brainrot, r/place |
| Hangout plus toy | A social space with one thing to fiddle with | Rec Room's Rec Center, PLS DONATE |
| Co-op survival | The group protects one shared thing against a clock | 99 Nights in the Forest |

Default pick when there is no brief: **round-based party** or **king of the hill**. They pass all
six tests with the least code, read instantly on a phone, and produce chat moments every round.

## Design it in this order

1. **Write the first thirty seconds from the player's feet** — the 6.0 guide asks for exactly this
   before any file. Where they land, what they see, the first thing they do, and the moment it
   becomes a game. If a stranger cannot be doing the core verb by second three, redesign that
   before anything else.
2. **Name the one verb and the one space.** Jump, tag, push, grab, place, draw, vote. One arena,
   one course, one garden. The space should fit on a 390×844 phone screen at play zoom.
3. **Lay out the round clock.** Default rhythm: 1–5 minute rounds, 10–20 s intermission, automatic
   requeue, a scoreboard that carries across rounds. Short rounds are fine, but the *session* should
   chain them — games with 0–6 minute sessions retain worst of all.
4. **Decide what a late joiner and a leaver each do.** Late joiner: spectate (`player.spectating`) from
   a vantage point, or spawn straight in for continuous games. Leaver: whatever they held (a role,
   the ball, the crown) is reassigned by the referee; the round ends on its timer, never on a headcount.
5. **Scale 1 → N.** Write down the game at 1, 2, 6 and 20 players. Objectives scale with headcount
   (Flee the Facility adds computers per player). A solo player gets a best time, a ghost of their
   last run, or rule-driven hazards.
6. **Put the party in the design.** A party arriving together starts on one team, one side, or one
   match copy. Give parties something only a group can do (a two-person lift, a relay, a shared
   base). Mark one or two **chat moments** per round: the reveal, the vote, the steal, the
   last-second save.
7. **Decide what persists.** A small durable profile in `player.state`: best score, an unlocked
   cosmetic, a plot. Offline growth is computed from a timestamp on return, never simulated while
   they are away. Leaderboards go in SQL, written on the event (a finish), never per tick.
8. **Place the doors.** Arrival point that is safe from any door, and a visible exit portal near
   the results screen or lobby (the far side is the creator's choice). If there is a lobby, make it
   a toy — something to bump, throw or climb while waiting.
9. **Juice the one verb.** Sound, particles, squash and a camera kick on every contact. Load
   `game-feel` before anything touches anything; one verb with great feedback beats five without.
10. **Cut.** Anything that fails a test in the table above, and anything that is not the one verb,
    goes. Scope is the most common way a jam game dies.

## On Spawn 6.0: the moves that make this cheap

Names below are from the 6.0 tome and skills; read the tome in full before writing code, and load
the skill in the right column in the same `spawn_skill` call as its look skills.

| Need | 6.0 move | Skill |
|---|---|---|
| Round clock | One referee: `sim.js` `tick(ctx)` with `export const cadence = "250ms"` (or `"1s"`), phase and deadline in `ctx.world.state`, compared against `ctx.now()`; `ctx.after(seconds, "export", payload)` for one-shots | platform-systems |
| Everyone sees the timer | The referee object or bulletin row with `audience: "all"` | rooms-and-matchmaking |
| Late join / elimination | `player.spectating = true` (body vanishes, keeps its slot); set `false` at the next round | rooms-and-matchmaking |
| Arrival from anywhere | `onArrive(ctx, entity)` runs on boot and on every door; place players by phase, not by where they last stood | portals |
| Party together | `player.party?.id` in `onArrive`; place config `instance: party` for a copy per party | rooms-and-matchmaking |
| Private match with a code | `ctx.cross(ctx.self, "+match")` into an `instance: solo`, `persistence: ephemeral` place; invite with `window.publicUrl + "/room:" + name` | rooms-and-matchmaking |
| Leaving | `onLeave(ctx, entity)` — one fast call; reassign what they held; save at the moment of earning too, since nobody runs `onLeave` for a lone player with no host | platform-systems |
| Durable progress | `player.state.x ??= {…}` seeded once on first arrival; `ctx.world.state` for room-shared; `ctx.session` for scratch | platform-systems |
| Offline growth | Store `plantedAt: ctx.now()`; on arrival compute elapsed growth. "Time nobody watched is a timestamp read on wake." | platform-systems |
| Leaderboard | `` ctx.sql`…` `` on the finish event, read on arrival or a cron; never per tick | platform-systems |
| Cheap hazards | `updateSchedule = { every, near }` and `sleep(seconds)` in `update()`; state written when it moves, never per tick. Scripts only run within ~500 m of a player | (tome) |
| Doors | `ctx.cross(entity, link)` from a trigger's `onTriggerEnter`; `onRefuse` toasts the verdict | portals |
| Phones | Declare ≤ 4 actions in `inputs`; touch controls are generated. Preview with `?touch=1`; keep UI off the right rail | mobile-controls, game-ui |
| Publishing | Judges and players follow the published link, not head | publish |

There is no authoritative server to write: each client simulates its own body and every entity has
one simulator. Design rules, not netcode — a hit is a write on the target's state.

**Pre-6.0 (document) worlds:** the same design holds, but the moves are `onPlayerConnected` /
`onPlayerDisconnected`, `enterPlace` for instances, and `?room=` invite links, and there is no
party field or cross-world door. Load `places`, `instanced-matches`, `rooms-and-matchmaking` and
`data-and-saves` there. Start new jam games on 6.0 — recent jam winners are.

## Spawn Jam specifics

- **Weekly, three days, judged on fun, creativity, polish and ambition.** Start after the jam opens;
  enter with `/jam` to Savi in a new game, then post in #spawnjam on Discord. "Most people finish in an
  afternoon." Check spawn.co/jam for the current theme and deadline rather than trusting this file.
- **The judged surface is the first two to three minutes, often on a phone.** Every second before the
  core verb is scored against you.
- **Judges play the published link.** Publish early and republish at each playable milestone; a build
  that only exists at head was never judged.
- **Several groups play at once.** Never assume one shared room or one host; test with two bodies.
- **A push rebuilds every open room** and guts any run in progress. Don't push while someone is
  testing, and never mid-judging.
- **Theme as twist, not as premise.** "King of the Hill" as a hill that *moves*, "Home Sweet Home"
  as a cosy co-op house — one clever conceit on a proven loop beats a novel loop that is not fun yet.
- **Shareable result.** An end-of-round card worth a screenshot does the marketing.

## Review checklist

Run before calling a drop-in build done. Each line is checked by doing, not by reading code.

- [ ] Fresh arrival: `spawn_play_open`, stopwatch from load to first core action. ≤ 3 s after the world renders.
- [ ] Stranger test: no text needed to understand the goal within 30 s (screenshot the first frame — is the goal visible?).
- [ ] Late join: `spawn_client_join` a second body mid-round. It spectates or plays; nothing breaks.
- [ ] Leave: `spawn_client_leave` the body holding the key role mid-round. The round continues and ends on its timer.
- [ ] Return: rejoin. Durable progress is there; offline growth advanced.
- [ ] Solo: one player alone has a goal and an ending.
- [ ] Party: two party members arriving together land on the same side (on 6.0).
- [ ] Door out: an exit portal is visible from the results screen or lobby; arrival through any door lands safely.
- [ ] Phone: `?touch=1` screenshot; ≤ 4 actions; nothing under the right rail.
- [ ] Cost: no per-tick state writes or SQL; hazards use `cadence`, `updateSchedule` or `sleep`.
- [ ] Juice: every contact of the core verb has sound and a visible reaction.
- [ ] Published: the public link shows the current playable build.

## Anti-patterns

- Title screens, logins, long intros, text-wall tutorials before play.
- A lobby that waits for N players to start. Start with one; bots or rules fill.
- Locking out late joiners, or an intermission that breaks if someone joins at 0 s.
- Progress held only in memory, lost on refresh.
- Networked physics piles, pathfinding crowds, or LLM calls per enemy per tick.
- Rounds of 10+ minutes with no mid-round entry.
- A multiplayer game where players never need to notice each other.
- A second chat box, or UI under the platform rail.
- Pay or ad gates on progress; scope creep across half-built systems.

The research behind all of this — numbers, sources, and what is unverified — is in
[reference/research.md](reference/research.md).
