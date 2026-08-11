/**
 * One source of truth for "how do I work on a Spawn game", shared by the
 * `spawn_session` prompt and the `spawn_getting_started` tool. Most MCP clients
 * never surface prompts to the model, so the tool is how this text actually
 * gets read.
 */
export const SESSION_GUIDE = `You are building a Spawn game via the spawn MCP tools.

Credentials live in the game project's .env (SPAWN_API_URL, SPAWN_AGENT_KEY, SPAWN_VARIANT_ID). Never print the full agent key.

Setup:
1. If no token: spawn_bootstrap with the creator's one-time sbk_ key (expires ~5m, single use). Use a distinct name per agent (e.g. terrain-agent).
2. spawn_me — tell the creator who you're connected as.
3. spawn_create_game or spawn_list_games + spawn_set_variant.
4. spawn_init — scaffolds game.json, world/, scripts/, .spawn/ docs.
5. Read .spawn/guide.md and .spawn/tome-api.md before building. Then load craft with spawn_skill ids: ["…"] — pass every domain the work touches at once, not one per call. spawn_skills lists what exists; guessing an id is fine, a miss answers with the menu.

Art, UI, and look — load the skills BEFORE building, not after it looks wrong:
- The engine's visual craft lives in the skills, not in the API reference. Code written without them lands as untextured primitives and default DOM, which is the single biggest quality gap between an agent build and a studio build.
- Carry the look skills alongside the mechanic in the same spawn_skill call: a HUD is game-ui + drawn-art, a glowing surface is custom-materials + looks, a scene is world-composition + looks, matching an attached image is match-a-reference. Others worth passing when they apply: fx and slash-vfx (hit and ability effects), 3d-sprites (2.5D sprite casts).
- You CANNOT generate images or conjure 3D models through this MCP — that lane belongs to Savi in the studio. Your art levers are code-drawn textures (drawn-art), scripted materials, composed primitives, and cdn/ assets that already exist. Build for those, and ask the creator to have Savi conjure a model or generate a texture when the look genuinely needs one.
- Judge art with your eyes, never from a successful push: push → spawn_play_screenshot → compare against the intent → iterate. Game UI renders in a cross-origin iframe, so screenshot-and-click coordinates is the only UI loop you have.

Build loop (show, don't tell):
1. Edit project files.
2. spawn_validate → spawn_push. Every push rebuilds live room state (~1s).
3. Open your own play client: spawn_play_open (headed Chromium). This is YOUR eyes — Spawn is WebGPU/canvas; screenshots beat descriptions. Keep it HEADED: headless has no WebGPU adapter, so Spawn shows a graphics gate instead of your game (the result reports webgpu: "unavailable" when that happens).
4. After each meaningful push: spawn_play_screenshot (or reload if the client didn't reshape). Look at the image. If wrong, fix and push again — don't claim done from API success alone.
5. Exercise gameplay with spawn_play_input (WASD, Space, clicks), then screenshot again. Your game's UI (ui.js) renders in a cross-origin iframe that spawn_play_eval CANNOT read or click — to press a button, screenshot, read its position off the image, and click those coordinates with spawn_play_input.
6. Debug: spawn_logs + spawn_play_console for script/page errors; spawn_exec for live world queries. spawn_exec needs a live room (open a play client first) and cannot run api.sql at all — verify persistence through replicated state, not by querying the database.
7. On version_conflict (409): spawn_latest (head), merge .theirs receipts, push again. A pull three-way merges both scripts/ files and game.json against the last-seen upstream, so disjoint edits just compose. Where both sides changed the same thing it keeps YOURS, names the file (or the dotted game.json key path) in the result, and drops a .theirs receipt beside it — reconcile, delete the receipt, then push. Push refuses to run while a receipt is unresolved.
8. After meaningful pushes, spawn_savi with what changed. It is a one-way note into the creator's studio chat (background context for Savi), not a request — there is no reply channel and no way to hand Savi a task from here.
9. spawn_play_close when finished.

Multi-agent (same creator account — no crew setup):
- Each agent needs its own bootstrap key (settings → build with your own agent) and its own local projectDir / worktree. Never share one SPAWN_PROJECT_DIR — agents will thrash game.json, scripts/, and .spawn/base-version. Credentials come from the project's own .env first, so a worktree per agent is what makes them separate connections; if SPAWN_AGENT_KEY is set in the MCP config it is only a fallback for projects that have none (spawn_status reports which source won).
- Point every agent at the same SPAWN_VARIANT_ID. Concurrent pushes are supported (optimistic concurrency); 409s are expected, not bugs.
- Ask the creator to publish in the Spawn UI before unleashing the team — published (mode=live) stays stable for players while agents push to dev head. Agents cannot publish via API; use spawn_latest mode=live (read) or spawn_status to confirm a published baseline exists.
- Start small (2–3 agents). Partition work by script/area so conflicts stay rare. Prefer spawn_latest after gaps; restore with mode=live applyLocal:true only when intentionally resetting.
- Coordinate with Savi via spawn_savi; treat other agents' pushes like Savi/creator edits on the version rail.
- If spawn_team_* tools exist, team mode is on. Register this worktree once with spawn_team_init, then spawn_team_claim the areas you own BEFORE building: game.json key paths (entities.player, world.terrain) and script globs (scripts/hud/**). Claims are advisory — they warn on push, never block — and claiming early is what keeps two agents off the same key. spawn_team_status shows the team, who is behind head, and who claimed what.
- In team mode one session drives ONE agent — push, applying pulls, revoke, and spawn_play_open bind to the first project dir they touch and refuse a second, so work on another agent's worktree from a session started there. Pushes serialise and rebase onto head first, so a teammate's push costs you nothing and a 409 is rare; if the rebase collides, the push stops with your work intact and the colliding paths named.

Pass projectDir when the game project is not SPAWN_PROJECT_DIR / cwd.`;
