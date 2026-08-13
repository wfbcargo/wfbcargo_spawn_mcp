/**
 * Local reimplementations of the engine builtins that are documented as pure
 * scalar/vector helpers (`.spawn/tome-api.md`, `<modular-code>`):
 *
 *   builtin/math    clamp, lerp, smoothstep, remap, …
 *   builtin/vec3    add, sub, scale, normalize, distance, …
 *   builtin/easing  easeIn/Out/InOut × Quad/Cubic/Sine/Expo, …
 *   builtin/format  formatNumber, formatTime, formatPercent, padZero
 *
 * These are BEST EFFORT, written from the documented names — the engine's own
 * source is not distributed, so exact edge-case behaviour (rounding, clamping
 * at domain ends) is unverified. Two consequences worth keeping in mind:
 *
 *   - A check whose verdict turns on a subtle builtin edge case is evidence
 *     about this file, not about the game. Prefer checks that would hold under
 *     any reasonable implementation.
 *   - Anything that is NOT a pure helper (fx, geom, three, tsl, vibe,
 *     room-routing, primitives) is deliberately absent rather than stubbed, so
 *     reaching one fails loudly instead of passing against a fake.
 *
 * On the game measured while building this, the entire math path required no
 * builtin at all: every `require("builtin/…")` sat in a render, FX or audio
 * script. So this file is for portability to other games, not a dependency of
 * the common case.
 */
import type { LoadedModule } from "./harness.js";

type Vec3 = { x: number; y: number; z: number };
type Vec3Like = Vec3 | [number, number, number];

function v3(v: Vec3Like): Vec3 {
  return Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v;
}

const clamp = (value: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, value));

function lerp(a: number | string, b: number | string, t: number): number {
  if (typeof a !== "number" || typeof b !== "number") {
    throw new Error(
      "builtin/math lerp on colour strings is not reimplemented locally — audit the numbers, not the colour"
    );
  }
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function remap(value: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  if (inLo === inHi) return outLo;
  return outLo + ((value - inLo) / (inHi - inLo)) * (outHi - outLo);
}

const mathBuiltin = {
  clamp,
  clamp01: (v: number) => clamp(v),
  lerp,
  inverseLerp: (a: number, b: number, v: number) => (a === b ? 0 : (v - a) / (b - a)),
  smoothstep,
  smootherstep(edge0: number, edge1: number, x: number) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = clamp((x - edge0) / (edge1 - edge0));
    return t * t * t * (t * (t * 6 - 15) + 10);
  },
  remap,
  sign: Math.sign,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  pow: Math.pow,
  PI: Math.PI,
  TAU: Math.PI * 2,
  degToRad: (d: number) => (d * Math.PI) / 180,
  radToDeg: (r: number) => (r * 180) / Math.PI,
  wrap: (v: number, lo: number, hi: number) => {
    const span = hi - lo;
    return span === 0 ? lo : lo + (((v - lo) % span) + span) % span;
  },
};

const vec3Builtin = {
  add: (a: Vec3Like, b: Vec3Like) => {
    const p = v3(a);
    const q = v3(b);
    return { x: p.x + q.x, y: p.y + q.y, z: p.z + q.z };
  },
  sub: (a: Vec3Like, b: Vec3Like) => {
    const p = v3(a);
    const q = v3(b);
    return { x: p.x - q.x, y: p.y - q.y, z: p.z - q.z };
  },
  scale: (a: Vec3Like, s: number) => {
    const p = v3(a);
    return { x: p.x * s, y: p.y * s, z: p.z * s };
  },
  dot: (a: Vec3Like, b: Vec3Like) => {
    const p = v3(a);
    const q = v3(b);
    return p.x * q.x + p.y * q.y + p.z * q.z;
  },
  cross: (a: Vec3Like, b: Vec3Like) => {
    const p = v3(a);
    const q = v3(b);
    return {
      x: p.y * q.z - p.z * q.y,
      y: p.z * q.x - p.x * q.z,
      z: p.x * q.y - p.y * q.x,
    };
  },
  length: (a: Vec3Like) => {
    const p = v3(a);
    return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  },
  distance: (a: Vec3Like, b: Vec3Like) => {
    const p = v3(a);
    const q = v3(b);
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  },
  normalize: (a: Vec3Like) => {
    const p = v3(a);
    const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    return len === 0 ? { x: 0, y: 0, z: 0 } : { x: p.x / len, y: p.y / len, z: p.z / len };
  },
  lerp: (a: Vec3Like, b: Vec3Like, t: number) => {
    const p = v3(a);
    const q = v3(b);
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t };
  },
};

const pow = Math.pow;
const easingBuiltin = {
  linear: (t: number) => t,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t: number) => t * t * t,
  easeOutCubic: (t: number) => 1 + pow(t - 1, 3),
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 + pow(2 * t - 2, 3) / 2),
  easeInSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t: number) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInExpo: (t: number) => (t === 0 ? 0 : pow(2, 10 * t - 10)),
  easeOutExpo: (t: number) => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
  easeInOutExpo: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2,
};

function padZero(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

const formatBuiltin = {
  formatNumber(value: number, decimals = 0): string {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  },
  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds)) return String(seconds);
    const sign = seconds < 0 ? "-" : "";
    const total = Math.floor(Math.abs(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${sign}${h}:${padZero(m)}:${padZero(s)}` : `${sign}${m}:${padZero(s)}`;
  },
  formatPercent(value: number, decimals = 0): string {
    if (!Number.isFinite(value)) return String(value);
    return `${(value * 100).toFixed(decimals)}%`;
  },
  padZero,
};

/** Specifier → module, for the builtins that are honestly reimplementable. */
export const PURE_BUILTINS: Record<string, LoadedModule> = {
  "builtin/math": mathBuiltin,
  "builtin/vec3": vec3Builtin,
  "builtin/easing": easingBuiltin,
  "builtin/format": formatBuiltin,
};
