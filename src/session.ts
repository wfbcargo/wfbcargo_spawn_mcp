/**
 * The lane split, kept separate from SESSION_GUIDE because it is the one thing
 * an agent has to know BEFORE the rest of that guide is even true. Appended by
 * `spawn_getting_started` and by the `spawn_session` prompt.
 */
export const LANE_GUIDE = `TWO ENGINES, TWO LANES — check which one this world is on before you build.

Every tool that reads or writes the world detects the engine and routes itself; you can also assert it with the optional
engineVersion argument ("6.0", "6.0.0", "document"), which is CHECKED against the real pin and fails the call on a mismatch
rather than overriding it. spawn_status and spawn_docs both report the era. What actually differs:

ENGINE 6.0+ — the git lane. The world IS a git repository and there is no spec document at all.
- spawn_init CLONES the repo into projectDir. Your token is the git password; it is passed per-command and never written
  to .git/config. Your .env is excluded locally, and this server's own files (docs, caches, screenshots) live under
  .git/spawn-mcp/ — never in the tree, because a 6.0 world TRACKS .spawn/ itself (engine.yaml, skills.md, cost files).
- The tree is world.config.yaml, places/<place>/config.yaml, places/<place>/cells/x<cx>z<cz>.scene (placements by 128m cell,
  cx = Math.round(x/128)), templates/*.js, scripts/**/*.js. Read AGENTS.md at the clone root — it is that world's own grammar —
  and read tome-api.md (in .git/spawn-mcp/, saved by spawn_init) IN FULL before writing code: every shape in it is exact and
  a push in another shape is refused naming the row, the line and the field.
- spawn_push takes a REQUIRED message. Its first line is not a log entry: it lands in the creator's chat and their changes list
  under your name. One plain sentence about what changed for the player. The how goes in body — and that body is also the only
  way to leave Savi anything, since no agent can wake her.
- spawn_latest is git pull --rebase. Pull before you build: Savi, exec, and other clones commit to this same repo.
- spawn_validate is a LOCAL pre-flight (scripts parse, scene headers and cell keys agree, image bytes match their extension,
  no blobs under assets/). There is no server-side validator on this lane — the push is the authority, and it is live in every
  open room the moment it lands. There is no dev/live split to absorb a broken tree.
- Art is a CDN name, never bytes in the tree: reference "/cdn/<name>", never commit a .glb or a .png under assets/.

PRE-6.0 — the document lane. Everything the rest of this guide describes: game.json + world/ + scripts/, spawn_validate against
the server schema, spawn_push as a whole-document PUT, the base-version rail, .theirs receipts, 409 version_conflict.

If a document-lane push ever answers world_is_git, the world was migrated mid-session: the cached era is dropped automatically
and the result tells you the clone URL. Run spawn_init in a fresh directory and carry on there.`;

/**
 * The social baseline every game owes the platform: chat, parties, and doors
 * out. It lives here rather than in an optional skill because it is not a
 * style choice — Spawn carries players between worlds with their party, and a
 * game that ignores that breaks the trip for everyone who arrives together.
 * An optional skill only reaches the clients that load it; this text reaches
 * every agent through `spawn_getting_started`.
 *
 * It states only what the engine docs show. The 6.0 `chat` skill is not served
 * over the skills endpoint, so the shape of `scripts/chat.js` and the voice
 * keys are named as unknown instead of guessed at (R-001).
 */
export const SOCIAL_GUIDE = `SOCIAL BASELINE — every game ships with this, whatever its genre. Not optional, and not a feature to add later.

Spawn owns the social layer: text and voice chat, parties of friends, and doors that carry a player (and the party they came with) from one
world into another. Your game does not rebuild any of it. Its job is to never break it, and to give it something to do.

1. Chat is Spawn's. Never build a text-chat box, a voice system, or an in-game DM. Keep game UI out of the platform rail — the right-middle
   block (about 50×340 px on the right edge) carrying home, creator, like, comments, near, mic, settings, camera — and keep ~150 px clear of
   it on a phone. Show player.displayName on nameplates and scoreboards so what is said in chat can be matched to a body. Design moments worth
   talking about: a reveal, a vote, a steal, an elimination, a close finish.
   The chat skill (scripts/chat.js, and the voice keys on world.config.yaml) is NOT served by spawn_skill, so its shape is unknown here:
   do not write scripts/chat.js from a guess. Leave the platform's chat and voice at their defaults unless the world's own docs show the shape.
2. Parties arrive together; keep them together. On 6.0 every player row carries player.party: { id, leader } | null (read-only; parties
   are formed in Spawn's interface, never by game code). In onArrive, put party members on the same team, side, spawn point, or match copy.
   Never let routing, auto-balance, or a full match split a party: size team caps so a party fits, or open a fresh copy
   (place config instance: party gives each party its own copy). A routing script that keeps publics out of party rooms (the
   rooms-and-matchmaking skill's party- prefix) is the pattern.
3. Every game has a door out, and accepts a door in. A portal is an object that calls ctx.cross(entity, link) — to one of its own places
   ("+arena"), another room ("world:" + ctx.world.id + "/room:" + name), or another creator's world ("@handle/slug +place"). Put at least one
   visible exit portal where a player who is finished will look for it (the lobby or the results screen). Its far side is the creator's
   call — another of their worlds, or anyone's they name (the portals skill shows how an address is found) — so ask rather than invent one.
   Make arrival work from any door: onArrive runs on boot AND on arrival, so a player coming through a portal mid-round must land somewhere
   sensible, never inside a running match or under the floor. Handle onRefuse with a toast rather than silence. Load the portals skill for
   the set piece: a door is a place in the world, not a button in a menu.
4. Invites are links. window.publicUrl + "/room:" + name is the invite link on 6.0 (null on a headless surface — show the name to copy). Any
   private room or match copy shows its code or a copy-link control so a friend can follow.
5. Leaving is normal. onLeave runs whichever way a player left, so it must never stall a round, strand a party member, or lose progress:
   save to player.state at the moment it is earned, let timers end rounds, and reassign whatever the leaver held.

ENGINE LANES: all of the above is the 6.0 surface. On a pre-6.0 (document) world the docs expose no party field and no cross-world door:
places are entered with enterPlace, invite links are window.publicUrl + "?room=" + name, and the join hooks are onPlayerConnected /
onPlayerDisconnected. Build rules 1, 4 and 5 there, say plainly that party and cross-world portals need a 6.0 world, and start new games on 6.0.

Check it before calling a build done: two bodies (spawn_client_join, plus a play client) arrive, leave, and come back without breaking a
round; a screenshot shows no game UI under the rail; an exit portal is visible from where a finished player stands.`;

/**
 * One source of truth for "how do I work on a Spawn game", shared by the
 * `spawn_session` prompt and the `spawn_getting_started` tool. Most MCP clients
 * never surface prompts to the model, so the tool is how this text actually
 * gets read. SOCIAL_GUIDE and LANE_GUIDE above are appended to it by both.
 */
export const SESSION_GUIDE = `You are building a Spawn game via the spawn MCP tools.

FIRST: which engine is this world on? Read LANE_GUIDE below, or run spawn_status — everything from step 4 down describes the
pre-6.0 document lane, and a 6.0 world works differently (its code is a git repository). The tools route themselves either way.

Credentials live in the game project's .env (SPAWN_API_URL, SPAWN_AGENT_KEY, SPAWN_VARIANT_ID). Never print the full agent key.

Setup:
1. If no token: spawn_bootstrap with the creator's one-time sbk_ key (expires ~5m, single use). Use a distinct name per agent (e.g. terrain-agent).
2. spawn_me — tell the creator who you're connected as.
3. spawn_create_game or spawn_list_games + spawn_set_variant.
5. spawn_init — on a pre-6.0 world scaffolds game.json, world/, scripts/, .spawn/ docs; on a 6.0 world clones its repo. It detects which.
6. Read the guide and tome-api reference spawn_init saved (.spawn/ on the document lane, .git/spawn-mcp/ on a 6.0 clone) before building. Then load craft with spawn_skill ids: ["…"] — pass every domain the work touches at once, not one per call. spawn_skills lists what exists; guessing an id is fine, a miss answers with the menu.

Art, UI, and look — load the skills BEFORE building, not after it looks wrong:
- The engine's visual craft lives in the skills, not in the API reference. Code written without them lands as untextured primitives and default DOM, which is the single biggest quality gap between an agent build and a studio build.
- Carry the look skills alongside the mechanic in the same spawn_skill call: a HUD is game-ui + drawn-art, a glowing surface is custom-materials + looks, a scene is world-composition + looks, matching an attached image is match-a-reference. Others worth passing when they apply: fx and slash-vfx (hit and ability effects), 3d-sprites (2.5D sprite casts).
- Naming is creating. A cdn/ asset is generated on first fetch of its path and cached there forever, so the path IS the asset: reference cdn/moodboard-<slug>/<category>-<name>.<ext> and that model, texture, or clip comes into being. Use a canonical slug (lowpoly-cozy, painterly-fantasy, toon-vibrant, voxel-bright, realistic-gritty, scifi-neon, gothic-horror, pixel-bright, pixel-moody) so a world shares one namespace, and read the name once more before you commit: you cannot re-roll a path, only pick a different one. Bare cdn/<name>.<ext> with no moodboard folder is a global namespace shared with every other game — avoid it for anything you create.
- Check the asset bank before you invent a name: spawn_asset_search finds paths you already used in this and other projects, with what they turned out to be. If a tool tells you the bank is empty or stale, run spawn_asset_sync first — it pulls every game on the account and harvests what each actually uses, which is the only account-wide record that exists. Treat "no match" from an unsynced bank as "unknown", never as "does not exist": inventing a second name for an asset you already have is permanent, because a path cannot be re-rolled. A path that worked is reusable across games verbatim. After creating one, spawn_asset_preview shows you the image inline, and spawn_asset_note is how the result stops being something only you remember. Your other art levers are code-drawn textures (drawn-art), scripted materials, and composed primitives; art the creator wants to art-direct interactively is worth handing to Savi with spawn_savi task, which you can do yourself without routing through the creator.
- Judge art with your eyes, never from a successful push: push → spawn_play_screenshot → compare against the intent → iterate. Game UI renders in a cross-origin iframe, so screenshot-and-click coordinates is the only UI loop you have.

Social — chat, parties and portals are part of every game, not an add-on: read SOCIAL BASELINE below before designing the first scene.
Game shape — when the creator has not fixed one (a jam entry, "make me a game", an open brief), prefer a drop-in shape: playable within seconds,
one small self-contained space, safe to leave and come back to, solo-viable but better with friends, and cheap to run (rounds, timers and
discrete events; no swarms of AI or synced physics). If the drop-in-games skill is installed, load it. When the creator has a vision, build theirs.

Build loop (show, don't tell):
1. Edit project files.
2. spawn_validate → spawn_push. Every push rebuilds live room state (~1s).
3. Put your own BODY in the world: spawn_client_join. A room boots for a player and never for a door, so this is what makes spawn_exec,
   spawn_logs and spawn_rooms read anything at all — no browser, no GPU, a few seconds. It is also how you PLAY what you built: your body
   stands in the room's census beside the creator and Savi, and spawn_client where / players / move / look act through it. The session
   self-expires at ttl (default 600s); spawn_client_leave ends it. Sim reads are not pixels.
4. Open your own play client: spawn_play_open (headed Chromium). This is YOUR EYES — Spawn is WebGPU/canvas; screenshots beat descriptions,
   and a body's sim read cannot tell you whether the frame is good. Keep it HEADED: headless has no WebGPU adapter, so Spawn shows a
   graphics gate instead of your game (the result reports webgpu: "unavailable" when that happens). Use join to QUERY, the browser to LOOK.
5. After each meaningful push: spawn_play_screenshot (or reload if the client didn't reshape). Look at the image. If wrong, fix and push again — don't claim done from API success alone.
6. Exercise gameplay with spawn_play_input (WASD, Space, clicks), then screenshot again. Your game's UI (ui.js) renders in a cross-origin iframe that spawn_play_eval CANNOT read or click — to press a button, screenshot, read its position off the image, and click those coordinates with spawn_play_input.
7. Debug: spawn_logs + spawn_play_console for script/page errors; spawn_exec for live world queries. spawn_exec needs a live room (spawn_client_join is the cheapest one; a play client works too) and cannot run api.sql at all — verify persistence through replicated state, not by querying the database.
8. On version_conflict (409): spawn_latest (head), merge .theirs receipts, push again. A pull three-way merges both scripts/ files and game.json against the last-seen upstream, so disjoint edits just compose. Where both sides changed the same thing it keeps YOURS, names the file (or the dotted game.json key path) in the result, and drops a .theirs receipt beside it — reconcile, delete the receipt, then push. Push refuses to run while a receipt is unresolved.
9. After meaningful pushes, spawn_savi with what changed — and use it to DELEGATE. Savi reads the creator's studio chat and can take a task on, fanning it out across its own sub-agents, so hand over whole separable slices with the task argument rather than building them yourself. State it broadly and let Savi split it; pass keepOff so its sub-agents route around what you are still in. Nothing comes back on this channel, which has one consequence worth holding: never sequence your own work behind a handoff. Read the result as head moving past your own last push, then spawn_latest and screenshot it like any other change. The tool description has the rest.
   Savi's fan-out is EIGHT lanes wide and spawn_savi_status counts what is burning right now — the wisps along the top of your play page, one per sub-agent. Read it as the honest measure of how much of the build is running in parallel and how much is just you: eight idle lanes beside a long todo list is the shape of an agent doing serially what it could have handed over. Check it before a handoff to size the slice, and after one to watch a wisp light up, which is uptake even though no reply ever arrives. It reads the open play client, so it wants spawn_play_open — the same window you are already screenshotting.
10. spawn_play_close when finished.

Multi-agent (same creator account — no crew setup):
- Each agent needs its own bootstrap key (settings → build with your own agent) and its own local projectDir / worktree. Never share one SPAWN_PROJECT_DIR — agents will thrash game.json, scripts/, and .spawn/base-version. Credentials come from the project's own .env first, so a worktree per agent is what makes them separate connections; if SPAWN_AGENT_KEY is set in the MCP config it is only a fallback for projects that have none (spawn_status reports which source won).
- Point every agent at the same SPAWN_VARIANT_ID. Concurrent pushes are supported (optimistic concurrency); 409s are expected, not bugs.
- Ask the creator to publish in the Spawn UI before unleashing the team — published (mode=live) stays stable for players while agents push to dev head. Agents cannot publish via API; use spawn_latest mode=live (read) or spawn_status to confirm a published baseline exists.
- Start small (2–3 agents). Partition work by script/area so conflicts stay rare. Prefer spawn_latest after gaps; restore with mode=live applyLocal:true only when intentionally resetting.
- Coordinate with Savi via spawn_savi, and count Savi as capacity rather than a bystander: a broad task handed over there comes back built by sub-agents you never had to key, check out, or supervise. It is the cheapest capacity on the board and the easiest to leave idle — spawn_savi_status is how many of its eight lanes are actually burning, and free lanes there outrank a fourth keyed agent you would have to bootstrap and babysit. Partition against it the way you would against a teammate — claim your area, pass those same patterns as keepOff — and treat the pushes that result like any other agent's on the version rail. They are literally indistinguishable: no endpoint reports an author, so an unexplained head bump is Savi, the creator, or a teammate, and only the team ledger can tell you which.
- If spawn_team_* tools exist, team mode is on. Register this worktree once with spawn_team_init, then spawn_team_claim the areas you own BEFORE building: game.json key paths (entities.player, world.terrain) and script globs (scripts/hud/**). Claims are advisory — they warn on push, never block — and claiming early is what keeps two agents off the same key. spawn_team_status shows the team, who is behind head, and who claimed what.
- In team mode one session drives ONE agent — push, applying pulls, revoke, and spawn_play_open bind to the first project dir they touch and refuse a second, so work on another agent's worktree from a session started there. Pushes serialise and rebase onto head first, so a teammate's push costs you nothing and a 409 is rare; if the rebase collides, the push stops with your work intact and the colliding paths named.

Pass projectDir when the game project is not SPAWN_PROJECT_DIR / cwd.`;
