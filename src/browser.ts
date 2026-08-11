import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from "playwright";
import { api, variantPath } from "./client.js";
import { loadEnv, requireEnv, resolveProjectDir } from "./env.js";

export type ConsoleEntry = {
  type: string;
  text: string;
  timestamp: number;
};

type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  playUrl: string;
  headed: boolean;
  console: ConsoleEntry[];
  /** Whether the canvas has already been click-focused for this session. */
  canvasFocused: boolean;
};

let session: Session | null = null;

const MAX_CONSOLE = 200;

/**
 * Serializes everything that touches the single browser session. MCP clients
 * can issue tool calls concurrently; without this, two spawn_play_open calls
 * both launch Chromium and one is orphaned, and inputs from separate batches
 * interleave mid-sequence.
 */
let sessionQueue: Promise<unknown> = Promise.resolve();

function withSession<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionQueue.then(fn, fn);
  sessionQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function pushConsole(entry: ConsoleEntry) {
  if (!session) return;
  session.console.push(entry);
  if (session.console.length > MAX_CONSOLE) {
    session.console.splice(0, session.console.length - MAX_CONSOLE);
  }
}

/** Resolve absolute play URL from explicit arg, docs endpoint, or cached session. */
export async function resolvePlayUrl(
  projectDir?: string,
  explicit?: string
): Promise<{ playUrl: string; source: string }> {
  if (explicit) {
    return { playUrl: explicit, source: "argument" };
  }
  if (session?.playUrl) {
    return { playUrl: session.playUrl, source: "session" };
  }

  const dir = resolveProjectDir(projectDir);
  const env = loadEnv(dir);
  requireEnv(env, "SPAWN_API_URL", "SPAWN_AGENT_KEY", "SPAWN_VARIANT_ID");
  const { status, json } = await api(env, "GET", variantPath(env, "/agent/docs"));
  if (status === 200 && json?.playUrl) {
    return { playUrl: `${env.apiUrl}${json.playUrl}`, source: "docs" };
  }

  const games = await api(env, "GET", "/api/agent/v1/games");
  const match = (games.json?.games ?? []).find((g: any) => g.variantId === env.variantId);
  if (match?.playUrl) {
    return { playUrl: `${env.apiUrl}${match.playUrl}`, source: "games" };
  }

  throw new Error(
    "Could not resolve play URL — pass playUrl explicitly, or ensure SPAWN_VARIANT_ID is set and the game exists."
  );
}

export function getSession(): Session | null {
  return session;
}

export function openPlay(opts: {
  playUrl: string;
  headed?: boolean;
  width?: number;
  height?: number;
  waitMs?: number;
}): Promise<OpenResult> {
  return withSession(() => openPlayUnlocked(opts));
}

async function openPlayUnlocked(opts: {
  playUrl: string;
  headed?: boolean;
  width?: number;
  height?: number;
  waitMs?: number;
}): Promise<OpenResult> {
  const headed = opts.headed ?? process.env.SPAWN_PLAY_HEADED !== "0";
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const waitMs = opts.waitMs ?? 4000;

  if (session) {
    await session.browser.close().catch(() => {});
    session = null;
  }

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--ignore-gpu-blocklist",
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const consoleBuf: ConsoleEntry[] = [];
  session = {
    browser,
    context,
    page,
    playUrl: opts.playUrl,
    headed,
    console: consoleBuf,
    canvasFocused: false,
  };

  page.on("console", (msg: ConsoleMessage) => {
    pushConsole({
      type: msg.type(),
      text: msg.text(),
      timestamp: Date.now(),
    });
  });
  page.on("pageerror", (err) => {
    pushConsole({
      type: "pageerror",
      text: err.message,
      timestamp: Date.now(),
    });
  });

  await page.goto(opts.playUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (waitMs > 0) await sleep(waitMs);

  const gpu = await probeWebGpu(page);
  return {
    playUrl: opts.playUrl,
    headed,
    title: await page.title(),
    url: page.url(),
    webgpu: gpu.adapter ? "ok" : "unavailable",
    ...(gpu.adapter ? {} : { webgpuDetail: gpu.detail, warning: HEADLESS_WEBGPU_WARNING }),
  };
}

export type OpenResult = {
  playUrl: string;
  headed: boolean;
  title: string;
  url: string;
  webgpu: "ok" | "unavailable";
  webgpuDetail?: string;
  warning?: string;
};

export const HEADLESS_WEBGPU_WARNING =
  "This page has no WebGPU adapter, so Spawn will show its 'One graphics fix away' gate instead of the game. " +
  "Headless Chromium cannot render Spawn — there is no GPU and software fallbacks do not provide an adapter. " +
  "Re-open with headed:true (the default) and make sure SPAWN_PLAY_HEADED is not set to 0.";

/**
 * Ask the page whether a WebGPU adapter is actually obtainable. `navigator.gpu`
 * exists in headless Chromium but requestAdapter() resolves null, which is what
 * trips Spawn's graphics gate — so probing the API alone would report a false OK.
 */
async function probeWebGpu(page: Page): Promise<{ adapter: boolean; detail: string }> {
  try {
    return await page.evaluate(async () => {
      if (typeof navigator === "undefined" || !("gpu" in navigator)) {
        return { adapter: false, detail: "navigator.gpu missing" };
      }
      try {
        const a = await (navigator as any).gpu.requestAdapter();
        return a ? { adapter: true, detail: "adapter granted" } : { adapter: false, detail: "requestAdapter() returned null" };
      } catch (e: any) {
        return { adapter: false, detail: `requestAdapter() threw: ${e?.message ?? e}` };
      }
    });
  } catch (e: any) {
    // Never let a diagnostic break opening the browser.
    return { adapter: true, detail: `probe skipped: ${e?.message ?? e}` };
  }
}

export async function ensurePage(): Promise<Page> {
  if (!session) {
    throw new Error("No play session — call spawn_play_open first.");
  }
  return session.page;
}

export type ShotFormat = "jpeg" | "png";

export type ShotOptions = {
  fullPage?: boolean;
  savePath?: string;
  format?: ShotFormat;
  /** JPEG only, 1-100. */
  quality?: number;
};

export type Shot = {
  image: Buffer;
  mimeType: string;
  format: ShotFormat;
  bytes: number;
  savedTo?: string;
  url: string;
};

export const DEFAULT_SHOT_FORMAT: ShotFormat = "jpeg";
export const DEFAULT_SHOT_QUALITY = 80;

export function screenshot(opts?: ShotOptions): Promise<Shot> {
  return withSession(() => screenshotUnlocked(opts));
}

async function screenshotUnlocked(opts?: ShotOptions): Promise<Shot> {
  const page = await ensurePage();
  // Raise the window so games that pause when unfocused keep rendering.
  // Deliberately no mouse movement here: a screenshot is an observation, and
  // nudging the pointer swings the camera in any mouse-look game.
  await page.bringToFront().catch(() => {});

  // JPEG by default: these images are base64'd into an LLM context on nearly
  // every play tool call. Measured on 1280x720 canvases, a lit/textured scene
  // is 1306KB as PNG vs 93KB as JPEG q80 (14x). Flat low-poly scenes invert
  // that ratio (5KB png vs 21KB jpeg) but the absolute cost there is trivial,
  // so defaulting to JPEG caps the expensive case and barely loses the cheap
  // one. Callers wanting lossless flat art pass format:"png".
  const format = opts?.format ?? DEFAULT_SHOT_FORMAT;
  const image = await page.screenshot({
    type: format,
    ...(format === "jpeg" ? { quality: opts?.quality ?? DEFAULT_SHOT_QUALITY } : {}),
    fullPage: opts?.fullPage ?? false,
  });

  let savedTo: string | undefined;
  if (opts?.savePath) {
    mkdirSync(dirname(opts.savePath), { recursive: true });
    writeFileSync(opts.savePath, image);
    savedTo = opts.savePath;
  }

  return {
    image,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    format,
    bytes: image.byteLength,
    savedTo,
    url: page.url(),
  };
}

export type InputAction =
  | { type: "key"; key: string; action?: "press" | "down" | "up"; delayMs?: number }
  | { type: "keys"; keys: string[]; holdMs?: number; gapMs?: number }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; fromX: number; fromY: number; toX: number; toY: number; steps?: number }
  | { type: "wait"; ms: number }
  | { type: "type"; text: string; delayMs?: number };

export function runInputs(
  actions: InputAction[],
  opts: { refocus?: boolean } = {}
): Promise<{ ran: number; focusClicked: boolean }> {
  return withSession(() => runInputsUnlocked(actions, opts));
}

async function runInputsUnlocked(
  actions: InputAction[],
  opts: { refocus?: boolean } = {}
): Promise<{ ran: number; focusClicked: boolean }> {
  const page = await ensurePage();
  await page.bringToFront().catch(() => {});

  // Click the canvas once per session to hand it keyboard focus. Doing this on
  // every batch fired a real left click each time — attacking, interacting, or
  // dismissing UI as a side effect of merely sending a keystroke.
  const needsFocus = opts.refocus === true || session?.canvasFocused === false;
  if (needsFocus) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.click(viewport.width / 2, viewport.height / 2).catch(() => {});
    if (session) session.canvasFocused = true;
  }

  let ran = 0;
  for (const action of actions) {
    switch (action.type) {
      case "wait":
        await sleep(action.ms);
        break;
      case "key": {
        const mode = action.action ?? "press";
        if (mode === "down") await page.keyboard.down(action.key);
        else if (mode === "up") await page.keyboard.up(action.key);
        else await page.keyboard.press(action.key, { delay: action.delayMs });
        break;
      }
      case "keys": {
        for (const key of action.keys) await page.keyboard.down(key);
        await sleep(action.holdMs ?? 200);
        for (const key of [...action.keys].reverse()) await page.keyboard.up(key);
        if (action.gapMs) await sleep(action.gapMs);
        break;
      }
      case "click":
        await page.mouse.click(action.x, action.y, { button: action.button ?? "left" });
        break;
      case "move":
        await page.mouse.move(action.x, action.y);
        break;
      case "drag":
        await page.mouse.move(action.fromX, action.fromY);
        await page.mouse.down();
        await page.mouse.move(action.toX, action.toY, { steps: action.steps ?? 20 });
        await page.mouse.up();
        break;
      case "type":
        await page.keyboard.type(action.text, { delay: action.delayMs ?? 20 });
        break;
      default:
        throw new Error(`Unknown input action: ${(action as any).type}`);
    }
    ran++;
  }
  return { ran, focusClicked: needsFocus };
}

export function reload(waitMs = 4000): Promise<{ url: string; title: string }> {
  return withSession(() => reloadUnlocked(waitMs));
}

async function reloadUnlocked(waitMs: number): Promise<{ url: string; title: string }> {
  const page = await ensurePage();
  // A reload drops canvas focus — the next input batch must re-click.
  if (session) session.canvasFocused = false;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  if (waitMs > 0) await sleep(waitMs);
  return { url: page.url(), title: await page.title() };
}

export function readConsole(opts?: {
  types?: string[];
  limit?: number;
}): ConsoleEntry[] {
  if (!session) return [];
  let entries = session.console;
  if (opts?.types?.length) {
    const set = new Set(opts.types);
    entries = entries.filter((e) => set.has(e.type));
  }
  const limit = opts?.limit ?? 50;
  return entries.slice(-limit);
}

export function evaluate(script: string): Promise<unknown> {
  return withSession(async () => {
    const page = await ensurePage();
    return page.evaluate(script);
  });
}

export function closePlay(): Promise<boolean> {
  return withSession(async () => {
    if (!session) return false;
    await session.browser.close().catch(() => {});
    session = null;
    return true;
  });
}
