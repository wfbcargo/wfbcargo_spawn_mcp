# Research behind drop-in-games

Compiled 2026-09-14. Two parts: what Spawn itself documents and rewards, then what the hits on other
community platforms have in common. Every claim carries its source. Claims that could not be sourced
are marked **[unverified]**, and numbers from fan wikis or trackers are marked as such because they
drift. Re-check anything time-sensitive (jam theme, deadlines, player counts) before quoting it.

---

## Spawn

### Spawn Jam (https://www.spawn.co/jam, fetched 2026-09-14)

- "Make a game in three days. Win $2,850." First place $1,000. Weekly; "the team picks friday".
- Enter: create a new game and type `/jam` to Savi; post it in #spawnjam on Discord (https://discord.gg/spawnco).
- Rules: "start your game after the jam begins. no pre-built entries"; "enter as many games as you want.
  only your highest placement counts". Judged on "fun, creativity, polish, ambition". "Most people finish in an afternoon."
- Recent winners:
  - #28 "Home Sweet Home": A Little Place (@enfeul; 6.0; "Cozy, Sim, Social", live multiplayer), The Last Dream (@chucky), Little Orbit (@digifreaked; 6.0)
  - #27 "The Spell Went Wrong": COLORFALL (@chucky) and Incantarys (@ress), tied; Wizardry Mishaps: Cleanup (@enfeul); Merick: The Gambling Wizard (@kaya)
  - #26 "Ultimate Destruction": CHOMP IT (@chucky), Wreckochet (@lazydev), Pinballpocalypse (@horse)
  - #25 "Old School": Legend of Tophat (@medivhus), Just Another Monday (@goblinjo), Grind95 (@gaba)
  - #24 "For the Kingdom!": Vaelreach (@ress), Conquest (@jissi), Parry the Knight (@ejthebae)
- Pattern (inferred from titles and engine pins): one readable hook per title; repeat winners who ship
  several entries; the most recent podium on engine 6.0; cosy/social multiplayer took first in #28.

### Engine 6.0 "One Place" (released 2026-09-05, https://www.spawn.co/about/release-6-0-0)

From the 6.0 agent docs (`guide.md`, `tome-api.md`) and the `portals`, `rooms-and-matchmaking`,
`platform-systems`, `game-ui`, `mobile-controls` and `publish` skills:

- **Party and guild:** `player.party: { id, leader: boolean } | null // Spawn's, read-only`;
  `player.guild: { id, name, rank } | null`. Places take `instance: solo | party` with
  `persistence: "ephemeral" | "session" | "persistent"`.
- **Doors:** `cross(entity, "world:<id>[@ref] [+<place>][#<exit>]" | "<place>")` returns
  `{ crossed: true, placeId } | { crossed: "departing", link } | { crossed: false, verdict }`. Hooks:
  `onCross`, `onRefuse`, `admits`, `onArrive` ("boot AND arrival through a door"), `onLeave`. A link can
  name another creator's world (`"@ress/cathedral +main"`). Release notes: "walk through with no loading
  screen, and what you carry, throw or shoot crosses with you."
- **Rooms:** `routing: { script, maxPlayers, persistence }`; `pickRoom(ctx)` with a 2 s budget; invite link
  `window.publicUrl + "/room:" + name`; `ctx.cross(p, "world:" + ctx.world.id + "/room:" + name)` moves a
  connected player; `player.spectating`. "There is no server here to port it to": each client simulates
  its own body, and every entity has one simulator.
- **Chat:** the tome lists `scripts/chat.js // the world's chat as code →chat`. The game-ui skill: "Players
  talking to each other is Spawn's voice chat, tuned on world.config.yaml (the chat skill)". The `chat`
  skill is **not** served by the skills endpoint, so its hooks and keys are unknown to this research.
- **Rail:** "The right-middle block of the game screen (a 50×340 px reservation, vertically centered on the
  right edge) belongs to the platform". The game-ui skill lists "home, creator, like, comments, near, mic,
  settings, camera".
- **Saves:** `player.state` is the player's save in every room; `ctx.world.state` is the room's;
  `ctx.session` is scratch. "SQL runs where an event runs, once per event — never per tick." "A save in
  `onLeave` lands whichever way the player left", except when the player is alone and nobody hosts the place.
- **Cost:** `sim.js` `tick(ctx)` at 30 Hz, slowed by `cadence`; `updateSchedule`, `sleep()`. "Scripts,
  physics and timers run within ~500 m of a player"; "Time nobody watched is a timestamp read on wake."
  No numeric CPU budget is documented.
- **Phones:** touch controls are projected from `inputs` (≤ 4 actions); `?touch=1` previews; publish proofs
  use a 390×844 phone frame. (The spawn.co FAQ still said mobile was "Coming soon" on 2026-09-14,
  contradicting the release notes.)
- **Unknown:**
  - Whether a party auto-follows through `cross()` into another world. The creator reports that Spawn
    portals bring the party, but no doc text states the mechanism.
  - The chat skill's contents.
  - A 6.0 room cap.

### Platform social API (https://www.spawn.co/openapi.json)

- Room chat: `GET/POST /api/agent/v1/chat/room` (text 1–200 characters, 20 lines a minute).
- DMs: `/api/agent/v1/chat/inbox` and `/api/agent/v1/chat/dm`.
- Friends are follows: `POST /api/social/relation` ("A friend is a follow … no request, no accept").
- `/api/social/places` shows where the people you follow are.
- A `reach` setting controls "who may open a portal to you".

These are platform endpoints for accounts and agents, not game-code APIs.

### Lessons from a local Spawn Jam build (RetroSpawnJam, "Old School", engine 5.2)

- Judges followed the published link, which at one point was thousands of versions behind head.
- "The scoring surface is the first two minutes"; judges may play three; "everyone has a phone".
- Several groups playing at once is the expected judging case.
- A push rebuilds the live room and guts runs in progress. A gutted room keeps its terrain and looks
  normal while nothing works.
- Published room names gain a `live-` prefix; string-matching room names broke only after publish.
- Persisted spec writes leaked into every room.

---

## Other community platforms

Condensed from a sourced survey of Roblox, Fortnite Creative/UEFN, Rec Room, VRChat, Horizon Worlds,
Gorilla Tag, .io games, Jackbox, Discord Activities, Reddit Devvit and game jams.

The "Spawn rule" lines below are the survey's own translation, written before it was checked against
the 6.0 engine. Where they talk in server terms (an authoritative tick, low-rate position sync), Spawn
has no server to put that on; `SKILL.md` gives the 6.0 moves and wins wherever the two differ.

### 1. Roblox

#### 1.1 Headline examples (numbers)

| Game | Archetype | Key numbers | Core loop / notable design | Sources |
|---|---|---|---|---|
| **Steal a Brainrot** | Idle/tycoon + PvP stealing | All-time record of 25.8 M CCU (Oct 11, 2025); 7 B visits in under 2 months | 8 bases per server. Units earn cash, including offline. You steal from others' bases when their lock timer drops. Lock is 30 s on join, then 60 s, +10 s per rebirth. Rare units appear on a central conveyor, which starts races | [PocketGamer.biz](https://www.pocketgamer.biz/robloxs-steal-a-brainrot-becomes-first-game-to-surpass-25m-concurrent-players/), [rpgstash](https://www.rpgstash.com/blog/steal-a-brainrot-ccu-record-25-million-players), [u7buy mechanics](https://www.u7buy.com/blog/steal-a-brainrot-game-mechanics/) |
| **Grow a Garden** | Idle/garden | Peak 22.3 M CCU (Aug 23, 2025); 35.3 B visits; fastest to 1 B visits (33 days); made in 3 days by a 16-year-old | Buy seeds, plant, harvest, sell. Crops grow while you are offline. The shop's stock rotates. Weekly exclusives require being online. Pets from eggs | [Wikipedia](https://en.wikipedia.org/wiki/Grow_a_Garden), [GameDeveloper](https://www.gamedeveloper.com/business/roblox-s-grow-a-garden-had-nearly-22-million-concurrent-users-in-july), [NBC](https://www.nbclosangeles.com/entertainment/entertainment-news/virtual-gardens-viral-roblox-game-created-teenager/3756917/) |
| **99 Nights in the Forest** | Co-op survival | Peak 14.2 M CCU | Team keeps a campfire alive; upgrading the fire expands the map and the safe zone. Night is when threats come. Rescue missing kids | [PC Gamer](https://www.pcgamer.com/games/survival-crafting/with-a-peak-player-count-of-14-2-million-99-nights-in-the-forest-has-an-audience-other-multiplayer-games-would-kill-for-to-find-these-behemoth-playerbases-you-need-to-be-on-a-platform-like-roblox/), [Fandom Campfire](https://99-nights-in-the-forest.fandom.com/wiki/Campfire) (fan wiki) |
| **Brookhaven RP** | Hangout / roleplay | Most-visited Roblox game; passed Adopt Me at 33.5 B visits (Jul 2023); 80 B+ now (fan wiki) | Free-roam town with houses and cars, no goals. Players come "because their friends are there". Won Best Social Hangout at the 2024 Innovation Awards | [Bloxy News](https://x.com/Bloxy_News/status/1680300979101761536), [BusinessWire](https://www.businesswire.com/news/home/20250204037702/en/Voldex-Acquires-Brookhaven-the-Most-Visited-Game-on-Roblox), [Fandom](https://brookhaven-rp.fandom.com/wiki/Popularity_and_milestones) |
| **Adopt Me!** | Hangout + collect/trade | Peak 1,615,085 CCU (Apr 11, 2021), more than all of Steam at the time | Collect 70+ pets and trade them with others. Update launches drive spikes | [playadopt.me](https://www.playadopt.me/news/cute-pet-collecting-roblox-game-adopt-me-sets-new-record) |
| **Dress to Impress** | Round-based party (creative + vote) | 1.1 M CCU after an update; 2.7 B plays by Sep 2024 | Random theme each round, about 6 minutes to style an outfit, then the room votes on a runway | [Wikipedia](https://en.wikipedia.org/wiki/Dress_to_Impress_(video_game)), [Fandom](https://roblox.fandom.com/wiki/Dress_To_Impress_Group/Dress_To_Impress) |
| **Tower of Hell** | Obby / course | 26 B+ visits (fan wiki) | Randomly assembled tower resets every 8 minutes. No checkpoints. Everyone climbs the same tower | [Fandom](https://roblox.fandom.com/wiki/YXceptional_Studios/Tower_of_Hell), [Play Store editorial](https://play.google.com/store/apps/editorial?id=mc_games_editorialevergreen_postinstall_tower_of_hell_in_roblox_now_fcp&hl=en_IN) |
| **Murder Mystery 2** | Social deduction | 29 B visits (Aug 2026, fan wiki) | 12-player server: 1 murderer, 1 sheriff, 10 innocents. Hidden roles, timed round | [MM2 Wiki](https://murder-mystery-2.fandom.com/wiki/Murder_Mystery_2) (fan wiki) |
| **Natural Disaster Survival** | Round-based party / survival | 3 B visits (Jun 2024) | Random map plus random disaster each round. Players wait on a spawn tower and watch the current round, so spectating is built into the lobby | [Fandom](https://roblox.fandom.com/wiki/Player:Stickmasterluke/Natural_Disaster_Survival) (fan wiki) |
| **The Floor Is LAVA!** | Round-based party | 2 B visits | 15 s to climb, 40 s of lava, 20 s intermission. The lobby has a shop, pets and a mini-obby to fill the wait | [Fandom](https://roblox.fandom.com/wiki/Player:TheLegendOfPyro/The_Floor_Is_LAVA!) (fan wiki) |
| **Flee the Facility** | Asymmetric chase | 3.5 B visits; 15–25 K CCU typical (tracker) | 1 Beast vs up to 4 survivors. Survivors hack 3–5 computers (count scales with players), then escape | [Fandom](https://roblox.fandom.com/wiki/A.W._Apps/Flee_the_Facility), [fleethefacility.wiki](https://fleethefacility.wiki/) |
| **Piggy** | Asymmetric chase / escape | Second-fastest to 1 B visits (per the DOORS wiki); boomed during 2020 lockdowns | Escape-room keys plus a chaser (player or bot). Many modes: Infection, Traitor, Tag | [Fandom](https://roblox.fandom.com/wiki/Community:MiniToon/Piggy), [DOORS wiki](https://roblox-doors.fandom.com/wiki/DOORS) |
| **DOORS** | Co-op run (horror) | Third-fastest to 1 B visits (3 months) | Lobby of elevators, each a 1–6 player party queue. Procedurally generated rooms. Solo-viable | [DOORS Wiki](https://roblox-doors.fandom.com/wiki/DOORS), [Lobby](https://doors-game.fandom.com/wiki/Lobby) |
| **PLS DONATE** | Social hangout / "booth" | ~4.9 B visits; 3 B by Dec 2024; 1,100 CCU on day 1 with no ads | Claim a booth, show your items, chat and beg for donations. Almost entirely social, with no other gameplay | [Fandom](https://roblox.fandom.com/wiki/Quataun/PLS_DONATE), [RoWatcher](https://rowatcher.com/games/3317679266/pls-donate) (tracker) |
| **Bee Swarm Simulator** | Simulator / idle-ish | **[unverified: visit counts not fetched]** | Collect pollen, convert it to honey, grow the hive. Long-horizon quests from NPCs (Onett's quests need 30 bees) | [Fandom](https://bee-swarm-simulator.fandom.com/wiki/Onett) |

#### 1.2 Loops the Roblox hits share
- **Round rotation plus intermission** (NDS, Floor Is LAVA, MM2, Tower of Hell, DTI). A server-wide clock means a late joiner waits at most one round and can watch while waiting. Sources: rows above.
- **Offline or AFK growth** (Grow a Garden, Steal a Brainrot). The game world keeps working while you are away, so returning always pays off. [Wikipedia](https://en.wikipedia.org/wiki/Grow_a_Garden), [u7buy](https://www.u7buy.com/blog/steal-a-brainrot-game-mechanics/)
- **Server-synced scarcity timers** (the shop restocks on a global clock, 5 minutes in Grow a Garden 2). This creates "check back" moments and shared excitement. [mygagcalculator](https://mygagcalculator.com/grow-a-garden-2-stock-tracker/) (tracker)
- **Light PvP on top of idle** (stealing, base locks). Tension without twitch skill. [u7buy](https://www.u7buy.com/blog/steal-a-brainrot-game-mechanics/)
- **Hangout with a thin excuse** (Brookhaven, PLS DONATE, Adopt Me). The social space is the product. [BusinessWire](https://www.businesswire.com/news/home/20250204037702/en/Voldex-Acquires-Brookhaven-the-Most-Visited-Game-on-Roblox)
- **Lobby queues that form parties** (DOORS elevators). Walking into a pad is the matchmaking UI. [DOORS Lobby](https://doors-game.fandom.com/wiki/Lobby)

#### 1.3 Roblox's own guidance and metrics
- **Onboarding**: teach navigation and the core loop; "get to the fun quickly" (players decide within minutes); use low early XP thresholds; give starter items; show short, mid and long-term goals; end onboarding "with an intentionally designed moment of joy". [Roblox Onboarding doc](https://github.com/Roblox/creator-docs/blob/main/content/en-us/production/game-design/onboarding.md)
- **Contextual tutorials**, triggered by first use of a feature; delay non-essential info to later sessions. [onboarding-techniques](https://github.com/Roblox/creator-docs/blob/main/content/en-us/production/game-design/onboarding-techniques.md)
- **Discovery signals** (Recommended for You): Play-Through Rate; **First Play Bounce Rate (<60 s and 61–180 s)** as a negative signal; Play Days per User (D1, D2–7, D8–28); Playtime per User (**capped at 60 min/user/game/day**); **Intentional Co-Play Days per User** (friends via join, invites or private servers; reserved servers count); Qualified Play Sessions; spend days and Robux spent. [Roblox Discovery doc](https://github.com/Roblox/creator-docs/blob/main/content/en-us/discovery.md)
- **Benchmarks (GameAnalytics 2025 Roblox report)**: games with 0–3 minute sessions get D1 retention of 2.7% (25th percentile) to 12.3% (98th percentile). At 19–24 minutes, D1 is 9.4% to 32.3%. Short-session titles (0–6 min) sit below 10% D1. There is a "15x gap" between casual users (about 2 min per session) and core users (37+ min). [GameAnalytics](https://www.gameanalytics.com/reports/2025-roblox-report)
  - *Implication for Spawn:* individual rounds can be short, but the **session** should chain rounds (auto-requeue) so total time grows past the 0–6 minute band.
- **Age-aware recommendations (RDC 2026)**: younger players respond better to shorter experiences; older players prefer deeper games they revisit. [allthings.how RDC 2026](https://allthings.how/roblox-rdc-every-major-announcement-for-players-and-creators/)
- **Creator Rewards** (replaced engagement payouts Jul 2025): 5 Robux per qualifying Active Spender whose first three experiences of the day include yours, played for at least 10 minutes. [Roblox Creator Hub](https://create.roblox.com/docs/production/monetization/engagement-based-payouts) (via search summary)

#### 1.4 Roblox social plumbing
- **Party** (launched Dec 2024): up to 6 friends group up, keep text and voice chat across games, and "parties move together between games". Party API (2025) lets games detect party members and teleport them to a private lobby together. [Roblox newsroom](https://about.roblox.com/newsroom/2024/12/join-the-party-on-roblox), [DevForum Party API](https://devforum.roblox.com/t/party-api-is-here-enable-connected-player-experiences-and-drive-deeper-engagement/3676068)
- **TeleportService**: `ReserveServerAsync` plus `TeleportToPrivateServer` sends groups to a reserved instance. At most 50 players per `TeleportAsync` call. Groups can only teleport within one experience. Server-only. [TeleportService doc](https://create.roblox.com/docs/reference/engine/classes/TeleportService)
- **Invite prompts**: `SocialService:PromptGameInvite` with launch data lets you deep-link a friend into a specific context. [invite-prompts doc](https://github.com/Roblox/creator-docs/blob/main/content/en-us/production/promotion/invite-prompts.md)
- **Private (VIP) servers** can be bought and shared with friends. [Roblox Support](https://en.help.roblox.com/hc/en-us/articles/205345050-Private-VIP-Servers-FAQ)
- **Friends chat tab follows players across games** so groups can move to a new game together (RDC 2026). [allthings.how](https://allthings.how/roblox-rdc-every-major-announcement-for-players-and-creators/)
- **Custom matchmaking signals** such as skill rating (RDC 2025). [Roblox RDC 2025](https://about.roblox.com/newsroom/2025/09/roblox-rdc-2025)

#### 1.5 Hub / portal event: The Hunt: First Edition (Mar 15–30, 2024)
One hub ("The Infinite Vault") had **100 portals to 100 partner games**. Each game had a task that awarded a badge, and badge milestones unlocked cosmetics back in the hub. It is a model for Spawn portals: a meta-quest across many small games, with the reward collected in a shared hub. [Roblox Wiki](https://roblox.fandom.com/wiki/The_Hunt:_First_Edition), [Dexerto](https://www.dexerto.com/roblox/roblox-the-hunt-all-badges-games-and-how-to-get-them-2596083/)

---

### 2. Fortnite Creative / UEFN

- **Top genres by concurrent players** (fortnite.gg snapshot): Tycoon (a Brainrot clone "STEAL THE BRAINROT" at 78.5 K); Zone Wars ("GO GOATED!" 15.9 K); Box PvP (16 K); "1V1 WITH EVERY GUN" (14.4 K); "MEGA RED VS BLUE" (10 K). Some tycoons are popular partly because they allow AFK XP farming. [fortnite.gg tycoon](https://fortnite.gg/creative?tag=23), [fortnite.gg](https://fortnite.gg/creative) (tracker; live numbers change)
- **The Pit** (free-for-all arena) passed 100 M unique players by Nov 2022; it is repeatedly the most-played Creative map. [Sportskeeda](https://www.sportskeeda.com/fortnite/fortnite-the-pit-red-vs-blue-uefn-map-code-play-teamgeerzy)
- **What these share:** instant respawn, tiny arenas, rounds of seconds to minutes, no downtime, a playlist-style loop of repeating short matches. **[unverified: design synthesis]**
- **Discover metrics (Epic docs):** average playtime (capped at 120 min/session); CCU; **bounce rate** (sessions shorter than a row threshold, "often 5 minutes"); player retention; **social play** (invites, party returns, share of playtime in groups); QPTR (play-through weighted by depth); unique users over 7 days. Epic advises against duplicating existing experiences. [Epic: How Discover Works](https://dev.epicgames.com/documentation/fortnite/how-discover-works-in-fortnite)
- **Portals and rifts:** the Matchmaking Portal device warps players to another island by code, which enables multi-island games. The old Creative Hub had rifts to islands and "Featured portals", which were later replaced by the Browse and then Discover tab. [Epic: Matchmaking Portal](https://dev.epicgames.com/documentation/en-us/fortnite/using-matchmaking-portal-devices-in-fortnite-creative), [Fortnite Wiki: Hub](https://fortnite.fandom.com/wiki/The_Hub)
- **Join in progress** is supported and Epic's Verse tutorials show how to handle it (for example, assigning a late joiner to the smaller team). [Epic tutorial](https://dev.epicgames.com/documentation/en-us/fortnite/team-elimination-game-6-handling-a-player-joining-a-game-in-progress-in-verse) (page title confirmed; body not retrieved, so **[unverified: specifics]**)

---

### 3. Social VR: Rec Room, VRChat, Horizon Worlds, Gorilla Tag

- **Gorilla Tag** (Another Axiom): **$100 M+ revenue, 10 M+ VR players, 1 M+ DAU, ~60 min average playtime, downloaded by 1 in 3 Quest owners.** [GamesBeat](https://gamesbeat.com/gorilla-tag-crosses-10m-vr-players-and-100m-in-revenue/), [RoadtoVR](https://roadtovr.com/how-gorilla-tag-became-a-100-million-vr-success/)
  - Minimal mechanic (tag) with physical arm locomotion: "easy to learn, difficult to master". [RoadtoVR](https://roadtovr.com/how-gorilla-tag-became-a-100-million-vr-success/)
  - **About 10 s from launch to a social lobby.** Voice is on by default with proximity chat. [RoadtoVR](https://roadtovr.com/how-gorilla-tag-became-a-100-million-vr-success/)
  - **Diegetic navigation**: you physically walk to the forest to join rooms; modes are places. No tutorials, so veterans teach newcomers. "This game forces you to interact with other people." [Meta dev blog](https://developers.meta.com/horizon/blog/gorilla-tag/)
  - Revenue comes from cosmetics with try-ons (social shopping). [GamesBeat](https://gamesbeat.com/gorilla-tag-crosses-10m-vr-players-and-100m-in-revenue/)
- **Rec Room**: the **Rec Center** hub has doors to Rec Room Originals and featured rooms, plus toys (basketballs, dodgeballs, ping-pong) so waiting is play. Clubhouses can be visited even when the owner is offline. Paintball and Laser Tag rooms use teams of up to 4 with bot backfill. 1 M+ monthly VR users (2019). [Rec Room Wiki](https://rec-room.fandom.com/wiki/Rec_Center), [UploadVR](https://www.uploadvr.com/rec-room-gets-clubhouses-can-friends-visit/), [Laser Tag wiki](https://rec-room.fandom.com/wiki/Laser_Tag), [RoadtoVR](https://www.roadtovr.com/rec-room-1-million-monthly-active-users/)
- **VRChat**: groups "world-hop" by dropping portals in-world. Portals to Friends/Friends+ instances are locked so only friends can use them, and portals to public instances are open to anyone. World-hopping works by joining friends and then pulling others along. [VRChat Wiki: Portals](https://wiki.vrchat.com/wiki/Portals)
- **Horizon Worlds**: Meta's flagship "Super Rumble" uses 2–6 players and **5-minute matches**. The platform struggled (fewer than 200 K monthly users in Oct 2022) and in Feb 2026 shifted its focus to mobile. [Meta blog](https://www.meta.com/blog/meta-horizon-worlds-v121-get-ready-to-super-rumble/), [Wikipedia](https://en.wikipedia.org/wiki/Horizon_Worlds)

---

### 4. Web / Zero-Install Games

- **agar.io** (Apr 2015, built in about 4 days by Matheus Valadares) and **slither.io** (Mar 2016; 60 M+ daily players and 68 M downloads in 3 months; over $100 K/day revenue). The formula: free, instant, no install, deep emergent play from one mechanic, instant respawn. [Root-Nation](https://root-nation.com/en/games-en/games-articles-en/en-slither-io-and-agar-io-behind-the-game-scene/), [bonk-io history](https://bonk-io.com/blog/history-of-io-games/), [Tech.co](https://tech.co/news/gaming-industry-entrepreneurs-can-learn-slither-io-2016-07)
  - "You share a link, someone clicks it, and they're playing in three seconds." [topicsolutions](https://topicsolutions.net/from-agario-to-now-how-browserbased-gaming-quietly-became-the-internets-most-competitive-space/)
- **Krunker.io, Bloxd.io, Smash Karts, Shell Shockers, LOL Beans, Narrow One**: standout multiplayer titles on CrazyGames. [gamingpromax](https://gamingpromax.com/crazygames-vs-poki-which-platform-has-better-free-games-2026/) (low-authority listicle); [Similarweb bloxd.io](https://www.similarweb.com/website/bloxd.io/) (traffic figures not extracted, **[unverified: numbers]**)
- **skribbl.io**: 5.6 M visits (Jun 2025), about 3 min 54 s average session, 54% bounce (Similarweb via search). Private rooms with custom word lists; built for "speed and casual drop-ins". **Gartic Phone** (Oct 2020) became a pandemic Zoom-party standard, and streamers drove the 2021 spikes. [doodleduel](https://doodleduel.ai/blog/skribbl-io-alternatives-2026), [NamuWiki](https://en.namu.wiki/w/Gartic%20Phone), [onlineparty.games](https://onlineparty.games/compare/gartic-phone-vs-skribbl-io)
- **Jackbox**: join by typing a room code at jackbox.tv on your phone, with no app. The Jack Principles: "limit the user's choices, give them one task at a time, make sure they always know what to do next". TV-show pacing appeals to non-gamers. Audience mode lets overflow players vote. [Built In Chicago](https://www.builtinchicago.org/articles/jackbox-games-design-party-pack), [Jackbox blog](https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight)
- **Discord Activities**: web apps in an iframe inside voice channels (Embedded App SDK opened in 2024). Hits include Poker Night, Putt Party, and friend-quiz games. [Discord SDK GitHub](https://github.com/discord/embedded-app-sdk), [Soulbound](https://soulbound.game/blog/top-15-discord-games-on-discord-2025/)
- **Reddit (Devvit)**: r/place 2017 drew 1 M users placing 16 M pixels on a 1000×1000 canvas with **one pixel per 5 minutes**. The cooldown forced coordination and return visits. Devvit rewards **daily** games: payouts start at about 500 qualified daily players sustained over 7 days. Hits include r/hotandcold (daily semantic word guess), r/syllacrostic (acquired by Reddit), r/pixelary. [Wikipedia r/place](https://en.wikipedia.org/wiki/R/place), [dev.to Devvit guide](https://dev.to/seolith/building-games-on-reddit-the-complete-guide-for-would-be-developers-1g4l), [DeepWiki HotAndCold](https://deepwiki.com/reddit/devvit-HotAndCold). "Sword and Supper": **[unverified: no source found]**
- **Wordle**: went from 90 players to about 3 M in roughly 2 months with no marketing, driven by the spoiler-free emoji share grid (23.5 M tweets from Dec 2021 to Feb 2022). One puzzle per day. [Dinogame](https://dinogame.gg/blog/history-of-wordle/), [FactSpark](https://factspark.blog/posts/wordle-the-daily-puzzle-that-conquered-the-world)
- **Poki (portal) guidance**: players abandon games that load for more than 10 s; minimise menus; visual rather than text tutorials; skippable cutscenes; wrap localStorage in try/catch; support desktop and mobile touch; tracks "Pure Game Time" and D1/D3/D7 retention. "Long intros, heavy tutorials, complex menus, and slow unlock systems tend to hurt conversion to play." [Poki requirements](https://developers.poki.com/guide/requirements-quality), [Google AdMob on Poki](https://blog.google/products/admob/app-monetization-insights-how-poki/), [Defold web best practices](https://defold.com/2026/06/02/Best-practices-when-building-for-the-web/)
- **Among Us** (a reference point for social deduction): about 3.8 M CCU at its peak and 500 M MAU (Nov 2020); spread through streamers (765 K concurrent Twitch viewers). [Business of Apps](https://www.businessofapps.com/data/among-us-statistics/), [Streams Charts](https://streamscharts.com/news/phenomena-2020-among-us)

---

### 5. Jam Games

- **Scope to one idea and spend real time on ideation**; don't take your first idea. Focused, polished entries beat sprawling ones, and a small, tailored concept can be "fun and polished with very little code". Exposure (content creators) and luck matter. [GMTK/EGM](https://egmnow.com/jam-sesh-how-a-popular-online-contest-sparks-gameplay-innovation/), [Medium: How to Win GMTK](https://medium.com/@rhettwpilcher/pause-to-play-how-to-win-the-gmtk-game-jam-b2d53818ec82) (403 on fetch; summary via search)
- **A twist on the theme**: a winning example was "a player character that can interact with the UI", a single clever conceit. [EGM](https://egmnow.com/jam-sesh-how-a-popular-online-contest-sparks-gameplay-innovation/)
- **Jam games that became hits**: Baba Is You (Nordic Game Jam 2017, theme "Not There"); SUPERHOT (7-Day FPS jam prototype, then 2 M+ copies sold); Broforce (LD23); Super Crate Box; McPixel. [MCV](https://mcvuk.com/development-news/when-we-made-baba-is-you/), [GameMaker blog](https://gamemaker.io/en/blog/best-game-jam-games)
- **Platform hits built on jam timelines**: Grow a Garden (3 days) and agar.io (about 4 days). Speed plus one sticky loop can outperform big productions. [NBC](https://www.nbclosangeles.com/entertainment/entertainment-news/virtual-gardens-viral-roblox-game-created-teenager/3756917/), [Root-Nation](https://root-nation.com/en/games-en/games-articles-en/en-slither-io-and-agar-io-behind-the-game-scene/)
- **Juice** (screen shake, particles, hit-pause, sound on every action) is widely cited as the multiplier on a simple mechanic. **[unverified: well-established practice; the widely cited "Juice it or lose it" GDC talk was not fetched]**

---

### 6. Game Catalog (24 examples by archetype)

| # | Game | Platform | Archetype | Why it fits Spawn's target shape |
|---|---|---|---|---|
| 1 | Natural Disaster Survival | Roblox | Round-based party | Random map and disaster, short rounds, you watch while you wait, no skill floor |
| 2 | The Floor Is LAVA! | Roblox | Round-based party | 15/40/20 s timing, trivially cheap to simulate |
| 3 | Dress to Impress | Roblox | Round-based party (create + vote) | ~6-min theme round, people vote, no combat |
| 4 | Jackbox (Quiplash etc.) | Web/TV | Round-based party / word | Room code, one task at a time, audience overflow |
| 5 | Tower of Hell | Roblox | Obby / course | Shared 8-min tower, pure movement, late joiners start immediately |
| 6 | DOORS | Roblox | Obby-like co-op run | Elevator-pad party queue, 1–6 players, solo-viable |
| 7 | Murder Mystery 2 | Roblox | Social deduction | 12 players, 3 roles, chat-driven |
| 8 | Among Us | PC/mobile | Social deduction | Meetings plus voting, streamer-friendly |
| 9 | Flee the Facility | Roblox | Social deduction / asymmetric chase | 1 vs 4, objectives scale with player count |
| 10 | Piggy | Roblox | Asymmetric chase | Bot fallback allows solo play |
| 11 | Brookhaven RP | Roblox | Hangout | No goals, the friends are the content |
| 12 | PLS DONATE | Roblox | Hangout (booth/social) | Nearly pure chat, 1,100 CCU on day 1 with no ads |
| 13 | Adopt Me! | Roblox | Hangout + collect/trade | Trading makes other players valuable |
| 14 | Grow a Garden | Roblox | Idle/garden | Offline growth, global restock clock |
| 15 | Steal a Brainrot | Roblox | Idle/tycoon + light PvP | Offline income, base-lock timers, raid tension |
| 16 | Bee Swarm Simulator | Roblox | Idle/simulator | Long-horizon collection |
| 17 | r/place | Reddit | Idle/collaborative canvas | 1 action per 5 min, shared persistent state |
| 18 | Gorilla Tag | VR | Arena (minimal-mechanic tag) | One verb, ~10 s to lobby, proximity voice |
| 19 | agar.io / slither.io | Web | Arena (.io) | Instant respawn, drop-in and drop-out, one mechanic |
| 20 | The Pit / Box Fights / Red vs Blue | Fortnite | Arena | Tiny map, instant respawn, endless loop |
| 21 | skribbl.io / Gartic Phone | Web | Drawing/word | Turn-based, private link rooms, low bandwidth |
| 22 | Wordle / Hot and Cold | Web/Reddit | Drawing/word (daily puzzle) | Once per day, share grid |
| 23 | 99 Nights in the Forest | Roblox | Co-op survival | Campfire as a shared goal, night pressure |
| 24 | Rec Room Paintball / Laser Tag | Rec Room | Arena (team) | Teams of up to 4, bot backfill, launched from a hub with toys |

---

### 7. Cross-Cutting Patterns (with Spawn-specific translation)

#### 7.1 Time-to-fun
- Loading should finish in under 10 s ([Poki](https://developers.poki.com/guide/requirements-quality)). About 10 s from launch to lobby ([Gorilla Tag](https://roadtovr.com/how-gorilla-tag-became-a-100-million-vr-success/)). Bounce within 60 s is a ranked negative ([Roblox](https://github.com/Roblox/creator-docs/blob/main/content/en-us/discovery.md)); bounce within about 5 min is the Fortnite threshold ([Epic](https://dev.epicgames.com/documentation/fortnite/how-discover-works-in-fortnite)).
- **Spawn rule:** the player should be able to act (move, click, draw) within 3 seconds of arrival. No title screen and no "press start"; teach by doing.

#### 7.2 Drop-in / drop-out and late join
- A server-wide round clock plus an intermission lobby means a late joiner waits at most one round (NDS, Floor Is LAVA, Tower of Hell). Continuous arenas (.io, The Pit) let players spawn straight in. Sources: §1.1, §2, §4.
- **Spawn rule:** always show "next round in N s". Late joiners either spectate the live round from a safe vantage (the NDS spawn tower) or join the continuous arena instantly. Leaving mid-round must not break the round: reassign roles, backfill with a simple bot, or let the round end by timer.

#### 7.3 Round length
- Observed: Floor Is LAVA (about 55 s play plus 20 s intermission), Super Rumble (5 min), Dress to Impress (~6 min), Tower of Hell (8 min). Sources: §1.1, §3.
- Short sessions retain poorly on their own ([GameAnalytics](https://www.gameanalytics.com/reports/2025-roblox-report)), so **chain rounds automatically** and add a cross-round scoreboard or streak.
- **Spawn rule:** rounds of 1–5 minutes, intermissions of 10–20 s, auto-requeue.

#### 7.4 Spectating and waiting
- NDS spectate tower; Floor Is LAVA lobby with a mini-obby and shop; Rec Center toys; Jackbox audience voting. Sources: §1.1, §3, §4.
- **Spawn rule:** the lobby is itself a toy (something to bump, throw, or doodle) and eliminated players get an action, such as voting, cheering with emotes, or placing hazards.

#### 7.5 Scaling from 1 to N (solo-viable)
- DOORS runs 1–6 players; Piggy offers Bot and Player+Bot modes; Flee the Facility scales the number of computers with player count; Rec Room Laser Tag backfills with bots. Sources: §1.1, §3.
- **Spawn rule:** every multiplayer game needs a fun solo mode (race a ghost or your best time, simple bots) and objectives that scale with headcount.

#### 7.6 Cheap netcode
- Turn/round-based (skribbl.io, Jackbox) and "shared persistent state plus timers" (r/place, Grow a Garden restock) need only event messages. Deterministic lockstep sends inputs only but Fiedler recommends it for 2–4 players at most; snapshot interpolation at 10 Hz adds about 100–150 ms of delay. [Gaffer On Games: lockstep](https://gafferongames.com/post/deterministic_lockstep/), [snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/)
- **Spawn rule:** use authoritative simple state (positions at low tick rate, discrete events, a server timer). Avoid rigid-body physics sync, projectile ballistics, and many AI agents. Tag, touch-to-collect, grid moves, votes, and drawings are all cheap.

#### 7.7 Social virality
- Discovery algorithms reward friends: Roblox's intentional co-play signal and Fortnite's social play metrics. Sources: §1.3, §2.
- Links and codes: Jackbox room code; skribbl private link; Roblox `PromptGameInvite` with launch data. Sources: §4, §1.4.
- Shareable artifacts: Wordle grid; Dress to Impress runway looks; r/place art. Streamer moments: Among Us, Gartic Phone. Sources: §4.
- Proximity or default-on voice made Gorilla Tag social by force ([Meta](https://developers.meta.com/horizon/blog/gorilla-tag/)). Spawn's chat covers this role.
- **Spawn rule:** design at least one "chat moment" per round (reveal, vote, steal, elimination, funny drawing) and one shareable end-of-round card or result.

#### 7.8 Progression that survives leaving
- Offline growth (Grow a Garden, Steal a Brainrot); persistent collections (Adopt Me pets, Bee Swarm); daily cadence (Wordle, Devvit daily games, Grow a Garden weekly exclusives); cooldown-based return (r/place 5 min). Sources: §1, §4.
- **Spawn rule:** save a small persistent profile (best time, unlocked cosmetic, plot or garden state) and compute offline progress from timestamps on return. Don't simulate anything while the player is away.

#### 7.9 Hub and portal design
- The Hunt (a hub with 100 portals and a badge meta-quest); Fortnite Creative Hub rifts; Rec Center doors plus toys; VRChat locked friends-only portals; Roblox parties moving together; DOORS elevator pads as queues. Sources: §1.4, §1.5, §2, §3.
- **Spawn rule:** games should expose a clear "exit portal" and accept a party arriving together (start with the party on the same team, or start a round when the party arrives). Cross-game badges and quests are how a jam catalog becomes a destination.

---

### 8. Distilled Design Principles

1. **Act within 3 seconds; understand within 30.** No menus before play; a visual, contextual tutorial; skippable everything.
2. **One core verb, one screen.** If it can't be explained in a single sentence of on-screen text, cut it.
3. **Clock-driven rounds with an always-visible timer.** 1–5 minute rounds, 10–20 s intermissions, auto-requeue.
4. **Late joiners are first-class.** They spectate or join instantly; the lobby is a toy.
5. **Leaving never breaks anything.** Timers end rounds, and bots or rebalancing fill gaps.
6. **Solo-viable, better with friends.** Bots, ghosts or score chasing for 1 player; objectives scale with N.
7. **Parties arrive together, stay together.** Detect the party, start them on the same team or in the same room, and give them a portal out.
8. **Create chat moments.** Reveals, votes, steals and eliminations: build designed beats for people to react to.
9. **Leave a trace that persists.** A best score, a cosmetic, a growing plot. Offline progress comes from timestamps, not simulation.
10. **Give a reason to return.** Daily puzzles, restock timers, cooldowns.
11. **Cheap state only.** Discrete events plus low-tick positions; no physics sync; enemies are simple rules or timers, not AI.
12. **Juice every action.** Sound, particles and screen shake make one mechanic feel like a game. **[unverified as a sourced claim]**
13. **One clever twist on the jam theme** beats feature breadth.
14. **Make a shareable result.** An end card or emoji-style summary.
15. **Readable at a glance, on mobile too.** Big shapes, high contrast, touch-friendly controls.

### 9. Anti-Patterns

- **Title screens, logins, long intros and text-wall tutorials** before play. These hurt conversion ([Poki](https://developers.poki.com/guide/requirements-quality)) and increase bounce ([Roblox](https://github.com/Roblox/creator-docs/blob/main/content/en-us/discovery.md)).
- **Requiring N players to start.** An empty lobby with "waiting for 4 players" is death; start with bots or solo instead. **[unverified: synthesis from Piggy, DOORS, Rec Room bot backfill]**
- **Locking late joiners out** with no spectate or queue feedback, or an intermission that breaks when someone joins at 0 s ([DevForum](https://devforum.roblox.com/t/intermission-script-breaks-when-player-joins-at-the-end-of-intermission/1611447)).
- **Progress that only exists in memory**, so a refresh or leaving wipes it. Also: persistent progress that requires being online and grinding with no offline credit.
- **Physics-heavy or AI-heavy simulation** synced over the network (lockstep is advisable only for 2–4 players; snapshots add latency) ([Gaffer](https://gafferongames.com/post/deterministic_lockstep/)).
- **Long rounds with no mid-round entry** (10+ min), or a single-shot session with no requeue, which leaves you in the 0–6 minute session band with under 10% D1 ([GameAnalytics](https://www.gameanalytics.com/reports/2025-roblox-report)).
- **Silent multiplayer**, where players never need to notice each other. Gorilla Tag's lesson is to force interaction ([Meta](https://developers.meta.com/horizon/blog/gorilla-tag/)).
- **Clone-of-a-clone metadata** (repetitive titles and thumbnails). Both Roblox and Epic down-rank it ([Roblox](https://github.com/Roblox/creator-docs/blob/main/content/en-us/discovery.md), [Epic](https://dev.epicgames.com/documentation/fortnite/how-discover-works-in-fortnite)).
- **Pay or ad gates on progression** (Poki forbids reward videos that gate progress ([Poki](https://developers.poki.com/guide/requirements-quality))); Grow a Garden drew criticism for excessive monetization ([Wikipedia](https://en.wikipedia.org/wiki/Grow_a_Garden)).
- **Scope creep in a jam**: many half-built systems instead of one polished loop ([EGM](https://egmnow.com/jam-sesh-how-a-popular-online-contest-sparks-gameplay-innovation/)).
- **Unguarded localStorage** (it breaks in incognito) ([Poki](https://developers.poki.com/guide/requirements-quality)).

### 10. Unverified / Gaps
- Round lengths for MM2, NDS and Flee the Facility; visit or CCU numbers for Bee Swarm Simulator, Krunker and Bloxd; any info on "Sword and Supper" (Reddit); Fortnite join-in-progress specifics; direct GMTK winner postmortem (Medium article returned 403); juice talk not fetched.
- Several visit and CCU figures come from fan wikis or third-party trackers and move over time.
