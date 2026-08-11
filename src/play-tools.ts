import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import {
  closePlay,
  DEFAULT_SHOT_FORMAT,
  DEFAULT_SHOT_QUALITY,
  evaluate,
  getSession,
  openPlay,
  readConsole,
  reload,
  resolvePlayUrl,
  runInputs,
  screenshot,
  type InputAction,
  type Shot,
} from "./browser.js";
import { resolveProjectDir } from "./env.js";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function imageResult(shot: Shot, meta: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...meta, format: shot.format, bytes: shot.bytes }, null, 2),
      },
      {
        type: "image" as const,
        data: shot.image.toString("base64"),
        mimeType: shot.mimeType,
      },
    ],
  };
}

const shotFormatSchema = z
  .enum(["jpeg", "png"])
  .default(DEFAULT_SHOT_FORMAT)
  .describe(
    "jpeg (default) is 7-14x smaller on lit/textured 3D scenes (~1.3MB png vs ~90KB jpeg) and reads the same. Prefer png for flat-shaded or pixel-art worlds, where large uniform areas compress better losslessly, or when you need exact pixels."
  );

const shotQualitySchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(DEFAULT_SHOT_QUALITY)
  .describe("JPEG quality 1-100 (ignored for png)");

const projectDirSchema = z
  .string()
  .optional()
  .describe(
    "Absolute path to the Spawn game project. Defaults to SPAWN_PROJECT_DIR or cwd."
  );

const inputActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("key"),
    key: z.string().describe("Playwright key name, e.g. KeyW, Space, ArrowLeft"),
    action: z.enum(["press", "down", "up"]).optional(),
    delayMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("keys"),
    keys: z.array(z.string()).describe("Chord held together, e.g. [KeyW, ShiftLeft]"),
    holdMs: z.number().optional(),
    gapMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("click"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({
    type: z.literal("move"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("drag"),
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    steps: z.number().optional(),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z.number(),
  }),
  z.object({
    type: z.literal("type"),
    text: z.string(),
    delayMs: z.number().optional(),
  }),
]);

export function registerPlayTools(server: McpServer): void {
  server.registerTool(
    "spawn_play_open",
    {
      description:
        "Open the live Spawn play URL in a local Chromium (Playwright). Headed by default so you can watch. Use this as the agent's eyes/hands on the game — Spawn is WebGPU/canvas, so screenshot + input beat accessibility trees. Resolves play URL from the variant if omitted. Keep it HEADED: headless Chromium has no WebGPU adapter, so Spawn refuses to start and every screenshot shows its 'One graphics fix away' gate instead of the game. The result reports webgpu:'ok'|'unavailable'.",
      inputSchema: {
        projectDir: projectDirSchema,
        playUrl: z.string().optional().describe("Absolute play URL; otherwise resolved from the API"),
        headed: z
          .boolean()
          .optional()
          .describe(
            "Show a real browser window (default true). false = headless, which CANNOT render Spawn (no WebGPU adapter) — only useful for reaching a non-Spawn page."
          ),
        width: z.number().optional(),
        height: z.number().optional(),
        waitMs: z
          .number()
          .optional()
          .describe("Settle time after navigation before returning (default 4000)"),
        screenshot: z
          .boolean()
          .default(true)
          .describe("Return an image of the viewport after open"),
        format: shotFormatSchema,
        quality: shotQualitySchema,
      },
    },
    async ({ projectDir, playUrl, headed, width, height, waitMs, screenshot: takeShot, format, quality }) => {
      try {
        const resolved = await resolvePlayUrl(projectDir, playUrl);
        const opened = await openPlay({
          playUrl: resolved.playUrl,
          headed,
          width,
          height,
          waitMs,
        });
        if (!takeShot) {
          return text({ ...opened, source: resolved.source });
        }
        // A missing WebGPU adapter means the screenshot shows Spawn's graphics
        // gate, not the game. Say so loudly rather than returning a confusing
        // picture of an error page.
        if (opened.webgpu === "unavailable") {
          const shot = await screenshot({ format, quality });
          return imageResult(shot, {
            ...opened,
            source: resolved.source,
            note: "The screenshot below is Spawn's graphics gate, NOT your game.",
          });
        }
        const shot = await screenshot({ format, quality });
        return imageResult(shot, {
          ...opened,
          source: resolved.source,
          note: "Browser open. Drive with spawn_play_input; look with spawn_play_screenshot after pushes.",
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
          return err(
            `${msg}\n\nInstall Chromium once: cd spawn-mcp && npx playwright install chromium`
          );
        }
        return err(msg);
      }
    }
  );

  server.registerTool(
    "spawn_play_screenshot",
    {
      description:
        "Screenshot the open play session. Primary visual check after spawn_push — look at the image before calling the change done. Optionally save under the project.",
      inputSchema: {
        projectDir: projectDirSchema,
        save: z
          .boolean()
          .default(false)
          .describe("Also write the image to <project>/.spawn/screenshots/<timestamp>.<ext>"),
        fullPage: z.boolean().default(false),
        format: shotFormatSchema,
        quality: shotQualitySchema,
      },
    },
    async ({ projectDir, save, fullPage, format, quality }) => {
      try {
        const dir = resolveProjectDir(projectDir);
        const savePath = save
          ? join(dir, ".spawn", "screenshots", `play-${Date.now()}.${format === "png" ? "png" : "jpg"}`)
          : undefined;
        const shot = await screenshot({ fullPage, savePath, format, quality });
        const sess = getSession();
        return imageResult(shot, {
          url: shot.url,
          playUrl: sess?.playUrl,
          savedTo: shot.savedTo,
          at: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_play_input",
    {
      description:
        "Send keyboard/mouse actions to the play session (WASD, jump, click UI, etc.). Clicks the canvas center ONCE per session to give it keyboard focus — later batches send only the actions you list, so no stray clicks fire your weapon or dismiss UI. This is also the ONLY way to click your game's UI (ui.js renders into a cross-origin iframe that spawn_play_eval cannot reach): screenshot first, read the button's position off the image, then click those coordinates. After acting, call spawn_play_screenshot to see the result.",
      inputSchema: {
        actions: z
          .array(inputActionSchema)
          .min(1)
          .describe("Ordered list of input actions"),
        refocus: z
          .boolean()
          .default(false)
          .describe(
            "Force a canvas-center click before the actions (use if the game lost keyboard focus). Fires a real left click."
          ),
        screenshot: z
          .boolean()
          .default(true)
          .describe("Screenshot after the sequence"),
        format: shotFormatSchema,
        quality: shotQualitySchema,
      },
    },
    async ({ actions, refocus, screenshot: takeShot, format, quality }) => {
      try {
        const result = await runInputs(actions as InputAction[], { refocus });
        if (!takeShot) return text(result);
        await new Promise((r) => setTimeout(r, 200));
        const shot = await screenshot({ format, quality });
        return imageResult(shot, { ...result, url: shot.url });
      } catch (e: any) {
        return err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_play_reload",
    {
      description:
        "Reload the play tab (e.g. if a push didn't hot-apply to this client). Prefer waiting ~1s after spawn_push first — rooms usually reshape in place.",
      inputSchema: {
        waitMs: z.number().optional(),
        screenshot: z.boolean().default(true),
        format: shotFormatSchema,
        quality: shotQualitySchema,
      },
    },
    async ({ waitMs, screenshot: takeShot, format, quality }) => {
      try {
        const reloaded = await reload(waitMs);
        if (!takeShot) return text(reloaded);
        const shot = await screenshot({ format, quality });
        return imageResult(shot, reloaded);
      } catch (e: any) {
        return err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_play_console",
    {
      description:
        "Return recent browser console / pageerror messages from the play session. Pair with spawn_logs for server-side script errors.",
      inputSchema: {
        types: z
          .array(z.string())
          .optional()
          .describe("Filter e.g. [\"error\",\"warning\",\"pageerror\"]"),
        limit: z.number().optional(),
      },
    },
    async ({ types, limit }) => {
      const sess = getSession();
      if (!sess) return err("No play session — call spawn_play_open first.");
      return text({
        playUrl: sess.playUrl,
        entries: readConsole({ types, limit }),
      });
    }
  );

  server.registerTool(
    "spawn_play_eval",
    {
      description:
        "Evaluate JavaScript in the play page's TOP frame (browser context — not the Spawn room api). Use it for page-level diagnostics: WebGPU support, network state, document title. It CANNOT see or click the game's UI: Spawn renders the UI in a cross-origin sandboxed iframe, so document.querySelector finds none of your ui.js buttons and reaching into the frame throws. Click game UI with spawn_play_input coordinates instead, and read live world state with spawn_exec.",
      inputSchema: {
        script: z
          .string()
          .describe(
            "A JS EXPRESSION evaluated in the page's top frame (not a function body — a bare `return` is a syntax error). Wrap statements in an IIFE: (() => { ...; return x; })()"
          ),
      },
    },
    async ({ script }) => {
      try {
        const value = await evaluate(script);
        return text({ value });
      } catch (e: any) {
        return err(String(e?.message ?? e));
      }
    }
  );

  server.registerTool(
    "spawn_play_close",
    {
      description: "Close the Playwright Chromium session.",
      inputSchema: {},
    },
    async () => {
      const closed = await closePlay();
      return text({ closed });
    }
  );

  server.registerTool(
    "spawn_play_status",
    {
      description: "Whether a play browser session is open, its URL, headed mode, recent error count.",
      inputSchema: {},
    },
    async () => {
      const sess = getSession();
      if (!sess) return text({ open: false });
      const errors = readConsole({
        types: ["error", "warning", "pageerror"],
        limit: 20,
      });
      return text({
        open: true,
        playUrl: sess.playUrl,
        pageUrl: sess.page.url(),
        headed: sess.headed,
        recentErrors: errors,
      });
    }
  );
}
