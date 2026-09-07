/**
 * `spawn_client_*` — the agent's own body in the world.
 *
 * Four tools rather than one per client verb: join, leave and status carry real
 * schemas because they are the lifecycle an agent has to get right, and
 * everything else goes through one passthrough. That shape is deliberate — the
 * client is served by the stack, not shipped here ("the client it runs is the
 * one the stack you join serves"), so its verb list can change under us. A
 * hardcoded tool per verb would drift; a passthrough cannot.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import {
  CACHE_DIRECTORY,
  ClientMissingError,
  client,
  isWindowsScriptPathBug,
  output,
} from "./player.js";
import { loadEnv, requireEnv, resolveProjectDir } from "./env.js";
import { latchProject } from "./team.js";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const projectDirSchema = z
  .string()
  .optional()
  .describe("Absolute path to the Spawn game project (.env). Defaults to SPAWN_PROJECT_DIR or the MCP process cwd.");

const sessionSchema = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "Session name, so one machine can stand more than one body (default 'default'). Every verb takes it; a session self-expires at its ttl."
  );

/** Shared preamble: credentials, the latch, and the world to act on. */
function context(projectDir?: string) {
  const dir = resolveProjectDir(projectDir);
  const env = loadEnv(dir);
  requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY");
  return { dir, env };
}

function sessionArgs(session?: string): string[] {
  return session ? ["--name", session] : [];
}

/** Turn the two "you have not set this up" failures into one teachable error. */
function missing(e: unknown): ReturnType<typeof err> | null {
  return e instanceof ClientMissingError ? err(e.message) : null;
}

export function registerPlayerTools(server: McpServer): void {
  // `bun x` resolves a package into its cwd; make sure that cwd exists and is
  // ours before any verb runs.
  try {
    mkdirSync(CACHE_DIRECTORY, { recursive: true });
  } catch {
    /* a missing cache dir surfaces at the first call, with git's own message */
  }

  server.registerTool(
    "spawn_client_join",
    {
      description:
        "Put YOUR OWN BODY in the world as a real player — no browser, no GPU. This is the cheap way to get a LIVE ROOM, and a live room is " +
        "what spawn_exec and spawn_logs need: a room boots for a player and never for a door, so until a body stands they answer " +
        "409 no_live_room / 5xx. Before this, the only way to boot one was spawn_play_open (headed Chromium with a working WebGPU adapter); " +
        "this needs neither, so it works on a machine with no GPU and costs a fraction of the time. It is also how you PLAY the game you are " +
        "building: the body is a real player wearing your name, it appears in the room's census beside the creator and Savi, and the world's " +
        "own player hooks fire for it like anyone's.\n\n" +
        "The session is a detached background process that outlives this call, so join once and then use spawn_exec / spawn_logs / " +
        "spawn_client freely. It SELF-EXPIRES at ttl (default 600s) — that is the safety net that stops a forgotten body standing in someone's " +
        "world forever — so raise ttl for a long session and call spawn_client_leave when you are done. Needs Bun (the client's session shell " +
        "is spawned as `bun`); the error says so if it is missing.\n\n" +
        "Joining is the same on every engine — it is the play door, not the write path — so this takes no engineVersion.",
      inputSchema: {
        projectDir: projectDirSchema,
        world: z
          .string()
          .optional()
          .describe(
            "World to join: an @user/world address, or a world id. Defaults to this project's SPAWN_VARIANT_ID, which is usually what you want."
          ),
        as: z.string().max(64).optional().describe("Display name for the body (defaults to your account's name)."),
        ttl: z
          .number()
          .int()
          .min(30)
          .max(86_400)
          .default(600)
          .describe(
            "Seconds the body stands before it self-departs. The room stays live for exactly this long, so size it to the work: a screenshot loop is minutes, not hours."
          ),
        body: z
          .string()
          .optional()
          .describe("Model URL to wear (a /cdn/ address or an https .glb), instead of the default body."),
        session: sessionSchema,
      },
    },
    async ({ projectDir, world, as, ttl, body, session }) => {
      try {
        const { dir, env } = context(projectDir);
        // Standing a body is identity-bearing — it is this agent, by name, in
        // someone's world — so it binds to one project like a push does.
        latchProject(dir, "spawn_client_join");

        const target = world ?? env.variantId;
        if (!target) {
          return err(
            "No world to join: pass `world` (an @user/world address or a world id), or set SPAWN_VARIANT_ID with spawn_set_variant."
          );
        }

        const result = await client(
          "join",
          [
            target,
            "--ttl",
            String(ttl),
            ...(as ? ["--as", as] : []),
            ...(body ? ["--body", body] : []),
            ...sessionArgs(session),
          ],
          env.agentKey
        );
        const said = output(result);
        if (!result.ok) {
          return err(
            `join failed:\n${said}` +
              (/already live/.test(said)
                ? "\n\nA body is already standing under this session name. Use it, pass a different `session`, or spawn_client_leave first."
                : "")
          );
        }
        return text(
          `${said}\n\n` +
            "The room is live while this body stands: spawn_exec and spawn_logs read it now, and spawn_rooms lists it. " +
            "Read the world with spawn_client where / players, move with spawn_client move, and end it with spawn_client_leave " +
            "(or let the ttl expire). A sim read is not a picture — for how the world LOOKS, still use spawn_play_open and spawn_play_screenshot."
        );
      } catch (e: any) {
        return missing(e) ?? err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_client_leave",
    {
      description:
        "End the session and despawn the body — the graceful departure (the despawn is journaled before the socket closes). The room folds " +
        "when the last body leaves, so spawn_exec and spawn_logs stop working after this until something else is standing. Call it when you " +
        "are done; a session left alone self-expires at its ttl anyway.",
      inputSchema: { projectDir: projectDirSchema, session: sessionSchema },
    },
    async ({ projectDir, session }) => {
      try {
        const { env } = context(projectDir);
        const result = await client("leave", sessionArgs(session), env.agentKey);
        const said = output(result);
        return result.ok ? text(said || "left.") : err(`leave failed:\n${said}`);
      } catch (e: any) {
        return missing(e) ?? err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_client_status",
    {
      description:
        "Is a body standing, and for how much longer? Reports each session's pid, world, connection phase, entity id and REMAINING TTL. " +
        "Check it before spawn_exec / spawn_logs when they answer no_live_room: an expired session is the usual reason, and the fix is to " +
        "join again rather than to debug the endpoint.",
      inputSchema: { projectDir: projectDirSchema, session: sessionSchema },
    },
    async ({ projectDir, session }) => {
      try {
        const { env } = context(projectDir);
        const result = await client("status", sessionArgs(session), env.agentKey);
        const said = output(result);
        if (!result.ok) return err(`status failed:\n${said}`);
        return text(said || "No session is standing — spawn_client_join to boot the room for your own body.");
      } catch (e: any) {
        return missing(e) ?? err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_client",
    {
      description:
        "Run any other verb of the packaged client against your standing body — `spawn client <verb> …`. Join first (spawn_client_join); " +
        "these all act through that session.\n\n" +
        "The verbs the current client serves: `where` (your pose, world, place and the nearest objects — a sim read, no pixels), " +
        "`players` (every body in the room and where it is), `inputs` (the world's declared actions — what a key actually does HERE, " +
        "read it before sending any), `move <x> <y> <z>` or `move --to <objectId>` with `--speed walk|run|teleport`, `look --at <objectId|x,y,z>`, " +
        "`witness` (the room as a picture), `crossing` (portals and slot census), `screenshot`, `run <file>` or `run -e \"<source>\"` (a play " +
        "script: play.key / press / hold / release / walk / face / moveTo / where / players / entities / state / until).\n\n" +
        "The verb list belongs to the client the STACK serves, not to this server, so it can gain verbs without this tool changing — if one " +
        "is not recognised, `spawn_client verb:\"--help\"` is not it; the client's own error names what it takes. `--origin` is refused: it " +
        "would send your token to another stack.",
      inputSchema: {
        projectDir: projectDirSchema,
        verb: z
          .string()
          .describe("The client verb: where, players, inputs, move, look, witness, crossing, screenshot, run, …"),
        args: z
          .array(z.string())
          .default([])
          .describe(
            'Arguments, one array element each — never one joined string. `move 8 0 18 --speed walk` is ["8","0","18","--speed","walk"].'
          ),
        session: sessionSchema,
      },
    },
    async ({ projectDir, verb, args, session }) => {
      try {
        const { env } = context(projectDir);
        // Defaulted by zod in a well-behaved client, but a missing array must
        // not become a TypeError the model has to decode.
        const result = await client(verb, [...(args ?? []), ...sessionArgs(session)], env.agentKey);
        const said = output(result);

        if (!result.ok) {
          if (isWindowsScriptPathBug(said)) {
            return err(
              `${said}\n\n` +
                "This is a bug in the client the stack currently serves, not in your script: its session shell requires a POSIX-absolute " +
                "scriptPath, so no Windows path is accepted — and `-e` fails the same way, because it writes the source to a temp file and " +
                "passes that path. `spawn client run` is therefore unavailable on Windows. Everything else works: read with `where` / " +
                "`players`, act with `move` and `look`, and drive the world through spawn_exec for reads."
            );
          }
          if (/no session|not live|no such session/i.test(said)) {
            return err(`${said}\n\nNo body is standing. spawn_client_join first (or check spawn_client_status for an expired ttl).`);
          }
          return err(`spawn client ${verb} failed:\n${said}`);
        }
        return text(said || `spawn client ${verb}: (no output)`);
      } catch (e: any) {
        return missing(e) ?? err(String(e?.message ?? e));
      }
    }
  );
}
