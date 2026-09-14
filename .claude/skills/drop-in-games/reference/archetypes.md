# Drop-in archetypes

Eight loops that pass the six tests in `SKILL.md`, each with the games that proved it, what to
take from them, and a Spawn 6.0 sketch. Sketches name tome/skill moves; they are starting shapes,
not code to paste — read the tome before writing any.

Numbers and sources for every example are in [research.md](research.md).

---

## 1. Round-based party

**Loop:** shared clock → short round with one rule → survivors or scorers win → 10–20 s
intermission → next round, often with a random variant (map, disaster, prompt).

**Proven by:** Natural Disaster Survival (random map + random disaster; waiting players watch
from a spawn tower), The Floor Is LAVA (15 s to climb, 40 s of lava, 20 s intermission; the lobby
has a mini-obby), Dress to Impress (~6 min themed round, then a runway vote), Jackbox.

**Take:** randomised variants make one loop feel fresh for many rounds; spectating is built into
the waiting area; the intermission is a toy, not a menu.

**Spawn sketch:** one referee in `sim.js` (`cadence = "250ms"`) holding `phase`, `deadline`,
`variant` in `ctx.world.state`; a bulletin object with `audience: "all"` for the timer and
scoreboard. `onArrive` puts arrivals in the lobby area when `phase !== "waiting"` and sets
`player.spectating`. Eliminated players become spectators until the next round.
Chat moments: the variant reveal, the last survivor.

## 2. Course / obby

**Loop:** everyone runs the same course; best time or furthest point wins; the course resets on
a timer (Tower of Hell: a new random tower every 8 minutes, no checkpoints).

**Proven by:** Tower of Hell, obbies in general, DOORS as a co-op run (elevator pads in the lobby
form 1–6 player groups; procedurally generated rooms).

**Take:** movement alone is a game if it feels good; a shared course makes strangers into rivals
without any interaction code; a lobby pad is a matchmaking UI players understand without text.

**Spawn sketch:** course sections as templates assembled from a seed stored in `ctx.world.state`
per round; checkpoints as triggers writing `player.state.best` on improvement only. A co-op run
uses a match place with `instance: party`, so a party gets its own copy. Ghost of your best run
for solo play: record a sparse position list on finish, replay it locally. Load `game-feel`.

## 3. King of the hill / arena

**Loop:** tiny arena, instant respawn, one contested thing (the hill, the crown, the biggest
blob), a score that ticks while you hold it.

**Proven by:** Gorilla Tag (tag with one locomotion verb; ~10 s from launch to a social lobby;
~60 min average play), Fortnite's The Pit / box fights / red vs blue, agar.io and slither.io
(instant respawn, one mechanic, drop in and out).

**Take:** no rounds needed — the loop is continuous, so late join and leaving are free;
instant respawn removes the only downtime; one verb with depth ("easy to learn, hard to master").

**Spawn sketch:** the hill is a trigger zone; its behaviour writes `holder` on enter/exit and
the referee accrues score on a `"1s"` cadence — not per tick. Respawn is a position write in the
player's own behaviour. Party members share a team colour and a combined score. Keep contact
cheap: shoves are impulses on the player's own body, not synced physics piles.

## 4. Social deduction / asymmetric chase

**Loop:** hidden or asymmetric roles assigned at round start → timed objective → reveal.

**Proven by:** Murder Mystery 2 (12 players: 1 murderer, 1 sheriff, 10 innocents), Flee the
Facility (1 beast vs up to 4 survivors; computers to hack scale with player count), Piggy (bot
fallback so it plays solo), Among Us (meetings and votes; spread through streamers).

**Take:** the reveal is the best chat moment there is; objectives that scale with headcount
keep it fair at any size; a bot role makes it solo-viable.

**Spawn sketch:** roles written by the referee to each player's row at round start
(`row.state.role = …`, whole top-level keys). The chaser bot, if any, is a rule (move toward
nearest visible survivor on a `"500ms"` schedule), not a planner. A leaver's role is reassigned
or the round ends early. Keep parties on the same side where the roles allow; never split a party
across murderer and victim unless the creator chooses that deliberately.

## 5. Create and vote

**Loop:** a prompt → everyone makes something in a time box → the room views and votes → points.

**Proven by:** Dress to Impress (styling + runway vote), skribbl.io and Gartic Phone (drawing;
private link rooms; low bandwidth), Jackbox ("limit the user's choices, one task at a time,
always know what to do next"; audience voting absorbs overflow players).

**Take:** almost zero simulation cost; every round ends in a guaranteed chat moment; spectators
can still vote, so late joiners are never idle.

**Spawn sketch:** creations as small data (a list of placed piece ids, a stroke list) written
once on submit, never streamed. The runway is a camera walk (`ctx.view.camera`) over each entry.
Votes are one write per player. Prompts from a `scripts/lib/data/prompts.yml` table, or the jam
theme itself.

## 6. Idle / garden

**Loop:** plant or build → leave → come back to growth → spend → expand; a shared clock
(restocks, rare spawns) gives reasons to return and gather.

**Proven by:** Grow a Garden (crops grow offline; shop stock rotates; built in 3 days) and Steal
a Brainrot (offline income, base-lock timers, a central conveyor of rare units that starts
races) — the two largest concurrent-player records on Roblox; r/place (one pixel per 5 minutes
forced coordination and return).

**Take:** progress that survives leaving is the retention engine; light PvP (stealing, raids)
adds tension without twitch skill; a global timer turns individual play into a shared moment.

**Spawn sketch:** the plot lives in `player.state.plot` with `plantedAt` timestamps; growth is
computed on read (`ctx.now() - plantedAt`), so nothing runs while nobody watches. Restocks on
`engine.crons` or a referee clock in `ctx.world.state`. A party gets a shared plot keyed on
`party.id` in SQL, or neighbouring plots.

## 7. Hangout plus toy

**Loop:** a good-looking social space with one thing to fiddle with; the people are the content.

**Proven by:** Rec Room's Rec Center (the hub has toys — basketballs, dodgeballs — so waiting is
play), PLS DONATE (a booth and chat, almost nothing else), Brookhaven (no goals; "friends are
there").

**Take:** on Spawn this is also the best *hub* shape: a hangout whose walls are portals to other
games, like Roblox's The Hunt (one hub, 100 portals, badges collected back in the hub).

**Spawn sketch:** one composed place, one physics toy with a behaviour, emote-able props, and a
ring of portals (`ctx.cross`) each labelled with its destination. Collect a stamp per visited
world in `player.state.stamps` on arrival back through a door. Load `portals` and
`geometry` + `looks` + `atmosphere` — a hangout lives or dies on how it looks.

## 8. Co-op survival

**Loop:** the group protects one shared thing (a campfire, a core) against a clock or waves;
upgrading it expands the safe space.

**Proven by:** 99 Nights in the Forest (keep the campfire alive; night brings threats; upgrades
grow the map).

**Take:** one shared objective makes cooperation automatic; a day/night clock gives natural
rounds; solo-viable because the threat scales.

**Spawn sketch:** the fire's fuel in `ctx.world.state`, decremented by the referee on a `"1s"`
cadence. Threats are simple rule-driven entities with `updateSchedule` and `sleep`, capped in
count, scaled by `ctx.place.players.length`. Night via the `atmosphere` skill. Keep threat counts
low and readable; this is the archetype most tempting to over-simulate.

---

## Picking one

| If the creator wants… | Start with |
|---|---|
| Nothing specific / a jam entry | Round-based party or king of the hill |
| Something to play with friends tonight | Create and vote, or social deduction |
| Something people come back to | Idle / garden |
| A place, a vibe, a home | Hangout plus toy |
| Pure feel, one mechanic | Course / obby, or king of the hill |
| A story or adventure | Co-op survival with a short run, or a course with set pieces |
