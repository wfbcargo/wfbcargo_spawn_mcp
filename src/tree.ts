/**
 * Local pre-flight for a 6.0 world tree.
 *
 * The document lane has an authoritative server validator (`/game-specs/validate`).
 * The git lane has none — the push itself is the validator, and it refuses typed,
 * naming the row, the line, and the field. That is a good verdict but an
 * expensive one to get wrong: a refused push is a round trip, and a push that
 * lands is live in every open room before the receipt prints.
 *
 * So this checks, locally, the failures the push law names explicitly — "JS that
 * does not parse", "a .png whose bytes are not a PNG", "a blob under assets/" —
 * plus the scene-header and cell-key grammar the tree documents. It is a
 * pre-flight, not an authority: passing here does not mean the push will land,
 * and every caller is told so.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TreeIssue = {
  file: string;
  line?: number;
  message: string;
  law: string;
};

export type TreeReport = {
  checked: { js: number; scenes: number; assets: number; images: number };
  issues: TreeIssue[];
  ok: boolean;
};

// `.spawn/` is NOT skipped: on a 6.0 world it is part of the tracked tree
// (engine.yaml, skills.md, the per-cell cost files), so its contents are the
// world's and belong in the check. This server's own files live under
// `.git/spawn-mcp/`, which `.git` already excludes.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build"]);
const CHECK_TIMEOUT_MS = 60_000;

/**
 * Every file under `dir`, minus the directories nothing in a world lives in.
 *
 * KNOWN DEFECT, deliberately not fixed here. This stats rather than lstats, so
 * it FOLLOWS SYMLINKS, and it keeps no visited set. Measured on a tree whose
 * `scripts/ui/loop` links back to `scripts/`: **64 paths for 1 real file, max
 * depth 129 segments** before the OS refuses the path. It does not hang, but
 * `checkTree` then syntax-checks 64 entries and `formatTreeReport` reports
 * "checked 64 script(s)" — false, in a tool whose job is honest reporting
 * (R-003) — and a link pointing out of the project is pre-flighted and cited at
 * a fabricated project-relative path.
 *
 * Every other walker in this codebase already refuses links (`assets.ts`,
 * `audit-tools.ts`, `compile.ts`, `harness.ts`, `ui-audit.ts`). This one is not
 * changed with them because it feeds `spawn_validate` and `spawn_push`, so
 * narrowing it narrows what gets syntax-checked before a live push — a
 * behaviour change on the push path, and its own spec. `spawn_audit_ui` walks
 * with its own `walkForCorpus` rather than wait for that.
 */
export function walkTree(dir: string, root = dir): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkTree(full, root));
    else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/* --------------------------------------------------------------- JS syntax */

/**
 * Parse every module without running any of it.
 *
 * `vm.SourceTextModule` is a real ESM parse — it accepts `import`/`export`,
 * which the tree's templates and scripts both use and which `new vm.Script`
 * rejects outright. It needs `--experimental-vm-modules`, so this runs in a
 * child we spawn with that flag rather than in the server's own process, and
 * constructing the module never evaluates it.
 */
async function checkJsSyntax(dir: string, files: string[]): Promise<TreeIssue[]> {
  if (!files.length) return [];
  const work = mkdtempSync(join(tmpdir(), "spawn-tree-"));
  const manifest = join(work, "files.json");
  const checker = join(work, "check.mjs");
  writeFileSync(manifest, JSON.stringify(files.map((f) => ({ rel: f, abs: join(dir, f) }))));
  writeFileSync(
    checker,
    [
      "import vm from 'node:vm';",
      "import { readFileSync } from 'node:fs';",
      "const files = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
      "const out = [];",
      "for (const { rel, abs } of files) {",
      "  let src;",
      "  try { src = readFileSync(abs, 'utf8'); }",
      "  catch (e) { out.push({ file: rel, message: 'unreadable: ' + e.message }); continue; }",
      "  try { new vm.SourceTextModule(src, { identifier: rel }); }",
      "  catch (e) { out.push({ file: rel, message: e.message, line: e.lineNumber }); }",
      "}",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n")
  );

  try {
    const { stdout } = await run(process.execPath, ["--experimental-vm-modules", checker, manifest], {
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const parsed = JSON.parse(stdout || "[]") as Array<{ file: string; message: string; line?: number }>;
    return parsed.map((p) => ({
      file: p.file,
      ...(p.line ? { line: p.line } : {}),
      message: p.message,
      law: "js must parse",
    }));
  } catch (e: any) {
    // A checker that cannot run is a gap in the report, not a tree failure —
    // saying "your scripts are broken" because node refused a flag would be a lie.
    return [
      {
        file: "(syntax check)",
        message: `Could not run the JS parse check (${e?.message ?? e}). Scripts were NOT syntax-checked.`,
        law: "js must parse",
      },
    ];
  }
}

/* ------------------------------------------------------------------ scenes */

/**
 * `cx = Math.round(x / 128)` names the file, so the header and the filename
 * must agree — a placement written into the wrong cell file loads at the wrong
 * place, or not at all, and nothing about the YAML itself is malformed.
 */
function checkScene(rel: string, source: string): TreeIssue[] {
  const issues: TreeIssue[] = [];
  const firstLine = source.split("\n", 1)[0] ?? "";
  const header = firstLine.match(/^#\s*spawn-scene\s+v2\s+yaml\s+(\S+)\s*$/);
  if (!header) {
    issues.push({
      file: rel,
      line: 1,
      message: `Line 1 must be the header "# spawn-scene v2 yaml <cellKey>", found: ${firstLine.trim() || "(empty)"}`,
      law: "scene header",
    });
    return issues;
  }
  const expected = basename(rel, ".scene");
  if (header[1] !== expected && expected !== "objects") {
    issues.push({
      file: rel,
      line: 1,
      message: `Header names cell "${header[1]}" but the file is "${expected}.scene" — placements would load into the wrong cell.`,
      law: "scene cell key",
    });
  }
  // Tabs are not YAML indentation and the failure they produce is opaque.
  const tab = source.split("\n").findIndex((l) => /^\s*\t/.test(l));
  if (tab >= 0) {
    issues.push({
      file: rel,
      line: tab + 1,
      message: "Indented with a tab — YAML indentation must be spaces.",
      law: "scene yaml",
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ assets */

const IMAGE_MAGIC: Record<string, { bytes: number[]; name: string }> = {
  ".png": { bytes: [0x89, 0x50, 0x4e, 0x47], name: "PNG" },
  ".jpg": { bytes: [0xff, 0xd8, 0xff], name: "JPEG" },
  ".jpeg": { bytes: [0xff, 0xd8, 0xff], name: "JPEG" },
  ".gif": { bytes: [0x47, 0x49, 0x46], name: "GIF" },
};

/** Extensions that are bytes, not source — the kinds `law.git.asset-kind` refuses. */
const BLOB_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tga", ".ktx2",
  ".glb", ".gltf", ".fbx", ".obj", ".mp3", ".wav", ".ogg", ".m4a",
  ".mp4", ".webm", ".mov", ".ttf", ".otf", ".woff", ".woff2",
]);

function checkImageMagic(rel: string, abs: string): TreeIssue | null {
  const expect = IMAGE_MAGIC[extname(rel).toLowerCase()];
  if (!expect) return null;
  let head: Buffer;
  try {
    head = readFileSync(abs).subarray(0, 8);
  } catch {
    return null;
  }
  const matches = expect.bytes.every((b, i) => head[i] === b);
  return matches
    ? null
    : {
        file: rel,
        message: `Extension says ${expect.name} but the bytes are not ${expect.name} — the push refuses this typed.`,
        law: "asset bytes match extension",
      };
}

/* ------------------------------------------------------------------ report */

/**
 * Run every local check over a 6.0 tree.
 *
 * `only` narrows the run to a set of paths — what `spawn_push` passes so a
 * pre-flight before a commit costs the changed files, not the whole world.
 */
export async function checkTree(dir: string, only?: string[]): Promise<TreeReport> {
  const all = walkTree(dir);
  const scope = only?.length ? all.filter((f) => only.includes(f)) : all;

  const js = scope.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  const scenes = scope.filter((f) => f.endsWith(".scene"));
  const images = scope.filter((f) => IMAGE_MAGIC[extname(f).toLowerCase()]);
  const assets = scope.filter((f) => f.startsWith("assets/"));

  const issues: TreeIssue[] = [];
  issues.push(...(await checkJsSyntax(dir, js)));

  for (const rel of scenes) {
    try {
      issues.push(...checkScene(rel, readFileSync(join(dir, rel), "utf8")));
    } catch (e: any) {
      issues.push({ file: rel, message: `unreadable: ${e?.message ?? e}`, law: "scene yaml" });
    }
  }

  for (const rel of images) {
    const issue = checkImageMagic(rel, join(dir, rel));
    if (issue) issues.push(issue);
  }

  // Art in a 6.0 tree is a CDN name, never bytes. A blob under assets/ is
  // refused at the push, so catching it here saves a live round trip.
  for (const rel of assets) {
    if (BLOB_EXTENSIONS.has(extname(rel).toLowerCase())) {
      issues.push({
        file: rel,
        message:
          "A binary under assets/ is refused by the push (law.git.asset-kind). Art in the tree is a CDN name — " +
          'reference "/cdn/<name>" and upload the bytes through kiln instead.',
        law: "law.git.asset-kind",
      });
    }
  }

  return {
    checked: { js: js.length, scenes: scenes.length, assets: assets.length, images: images.length },
    issues,
    ok: issues.length === 0,
  };
}

export function formatTreeReport(report: TreeReport): string {
  const counts = `checked ${report.checked.js} script(s), ${report.checked.scenes} scene(s), ${report.checked.images} image(s)`;
  if (report.ok) return `Local pre-flight clean — ${counts}.`;
  const lines = report.issues.map(
    (i) => `  ${i.file}${i.line ? `:${i.line}` : ""} — ${i.message}  [${i.law}]`
  );
  return `Local pre-flight found ${report.issues.length} issue(s) — ${counts}:\n${lines.join("\n")}`;
}
