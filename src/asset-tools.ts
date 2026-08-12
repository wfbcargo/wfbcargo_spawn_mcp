/**
 * The five asset-bank tools. Storage and grammar live in assets.ts; this file is
 * argument shapes, output shaping, and the messages that teach the model why a
 * path is risky. Design rationale: ASSET-BANK.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CANONICAL_SLUGS,
  checkAsset,
  classifyAssetPath,
  extractFromSpec,
  facetsOf,
  findAsset,
  findNameOwner,
  gameCount,
  pathWarning,
  readBank,
  resolveBankDir,
  resolveRef,
  resolveStoragePrefix,
  scanDirectory,
  searchAssets,
  shardsFor,
  summarizePathWarnings,
  syncAdvice,
  upsertAsset,
  writeBank,
  type Asset,
  type Bank,
  type PathWarning,
} from "./assets.js";
import { api, apiError, latestPath } from "./client.js";
import { loadEnv, requireEnv, resolveProjectDir } from "./env.js";
import { withLedgerLock } from "./team.js";

function text(data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * Several MCP processes can run at once (one per worktree in team mode) and all
 * write this one bank, so read-modify-write takes the same cross-process mutex
 * the team ledger uses. The lock lives in the bank directory.
 */
async function withBank<T>(fn: (bank: Bank, bankDir: string) => T | Promise<T>): Promise<T> {
  const bankDir = resolveBankDir();
  return withLedgerLock(bankDir, () => fn(readBank(bankDir), bankDir), { name: "assets.lock" });
}

/**
 * The compact row search and scan return.
 *
 * `games` rather than the project list: how many distinct games use an asset is
 * the reuse signal, and it is not the same number as the directory count when a
 * team has several worktrees per game.
 */
function brief(a: Asset) {
  const games = gameCount(a);
  return {
    ...(a.name ? { name: a.name } : {}),
    path: a.path,
    kind: a.kind,
    ...(a.category ? { category: a.category } : {}),
    ...(a.prefix ? { prefix: a.prefix } : {}),
    ...(a.slug ? { slug: a.slug } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.tags.length ? { tags: a.tags } : {}),
    ...(a.verdict ? { verdict: a.verdict } : {}),
    ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}),
    ...(a.exists !== null ? { exists: a.exists } : {}),
    games,
  };
}

/** The full record, for a single-asset answer where provenance is the point. */
function full(a: Asset) {
  return {
    ...brief(a),
    usedIn: a.usedIn.map((u) => ({
      project: u.project,
      ...(u.variantId ? { variantId: u.variantId } : {}),
      files: u.files,
    })),
    firstSeenAt: a.firstSeenAt,
    updatedAt: a.updatedAt,
  };
}

const refSchema = z
  .string()
  .min(1)
  .describe(
    'The asset: either its bank name ("knight") or its path ("cdn/moodboard-lowpoly-cozy/model-humanoid-knight.glb"). A leading slash and a ?animations= query are normalized away.'
  );

/**
 * The game a project pushes to, read from its OWN .env only.
 *
 * loadEnv falls back to the process environment, which during a multi-directory
 * scan would stamp this server's variant onto every project and collapse
 * unrelated games into one. Only a project-sourced variant identifies it.
 */
function projectVariant(dir: string): string | null {
  try {
    const env = loadEnv(dir);
    return env.sources.variantId === "project" && env.variantId ? env.variantId : null;
  } catch {
    return null;
  }
}

/**
 * Politeness cap on parallel spec fetches. A game spec carries every script
 * source, so this is real bandwidth against someone else's server, and the CDN
 * exposes a rate-limit header — four at a time keeps a 20-game account quick
 * without looking like a scraper.
 */
const SYNC_CONCURRENCY = 4;

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Appended to every asset-tool result when the bank looks empty or stale. */
function withAdvice(bank: Bank, body: Record<string, unknown>): Record<string, unknown> {
  const advice = syncAdvice(bank);
  return advice ? { ...body, syncAdvice: advice } : body;
}

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "spawn_asset_sync",
    {
      description:
        "Sync the asset bank with your Spawn ACCOUNT: list every game you own, fetch each one's current server-side spec, and harvest the cdn/ assets it actually uses. This is the authoritative fill — it covers games you have no local checkout of, and assets a teammate or Savi added that never landed on your disk, neither of which a local spawn_asset_scan can see. SLOW BY DESIGN: one spec fetch per game, each carrying every script source, so expect seconds to low minutes on a large account. Run it once to populate an empty bank, and again when the other asset tools say the bank is stale. There is no asset API on Spawn — the specs are the only account-wide record of which assets exist.",
      inputSchema: {
        projectDir: z
          .string()
          .optional()
          .describe("Project whose .env supplies the agent key. Defaults to SPAWN_PROJECT_DIR or the MCP process cwd."),
        mode: z
          .enum(["dev", "live"])
          .default("dev")
          .describe("dev = current head, what agents push to (default). live = the published snapshot players see."),
        variantIds: z
          .array(z.string())
          .optional()
          .describe("Sync only these games. Defaults to every game on the account."),
      },
    },
    async ({ projectDir, mode, variantIds }) => {
      let dir: string;
      try {
        dir = resolveProjectDir(projectDir);
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
      const env = loadEnv(dir);
      try {
        requireEnv(env, "SPAWN_AGENT_KEY");
      } catch (e: any) {
        return err(
          `${e?.message ?? e}\n\nThe sync reads your whole account, so it needs an agent token. Run spawn_bootstrap in a project first, or pass projectDir pointing at one that already has a .env.`
        );
      }

      const startedAt = Date.now();
      const listed = await api(env, "GET", "/api/agent/v1/games");
      if (listed.status !== 200 || !Array.isArray(listed.json?.games)) {
        return err(`Could not list games (HTTP ${listed.status}): ${apiError(listed)}`);
      }

      type Game = { variantId: string; name: string };
      const all: Game[] = listed.json.games
        .filter((g: any) => typeof g?.variantId === "string")
        .map((g: any) => ({ variantId: g.variantId, name: String(g.name ?? g.variantId) }));
      const wanted = variantIds?.length
        ? all.filter((g) => variantIds.includes(g.variantId))
        : all;

      if (!wanted.length) {
        return err(
          variantIds?.length
            ? `None of those variant ids are on this account. It has ${all.length}: ${all.map((g) => `${g.name} (${g.variantId})`).join(", ")}`
            : "This account has no games yet. Create one with spawn_create_game."
        );
      }

      // Fetched outside the bank lock: this is the slow part, and holding a
      // cross-process mutex across minutes of network would stall every other
      // agent's notes for no benefit.
      const fetched = await mapWithLimit(wanted, SYNC_CONCURRENCY, async (game) => {
        try {
          const res = await api({ ...env, variantId: game.variantId }, "GET", latestPath({ ...env, variantId: game.variantId }, { mode }));
          if (res.status !== 200) return { game, error: `HTTP ${res.status}: ${apiError(res)}` };
          const spec = res.json?.gameSpec ?? res.json;
          return { game, hits: extractFromSpec(spec), version: res.json?.version ?? null };
        } catch (e: any) {
          // One unreachable game must not lose the other nineteen.
          return { game, error: e?.message ?? String(e) };
        }
      });

      const now = new Date().toISOString();
      const result = await withBank((bank, bankDir) => {
        let next = bank;
        const touched: string[] = [];
        const created: string[] = [];
        const perGame: Array<Record<string, unknown>> = [];

        for (const entry of fetched) {
          if ("error" in entry) {
            perGame.push({ game: entry.game.name, variantId: entry.game.variantId, error: entry.error });
            continue;
          }
          for (const hit of entry.hits) {
            const up = upsertAsset(
              next,
              hit.path,
              {
                variantId: entry.game.variantId,
                game: entry.game.name,
                files: hit.files,
                source: "sync",
              },
              now
            );
            next = up.bank;
            touched.push(hit.path);
            if (up.created) created.push(hit.path);
          }
          perGame.push({
            game: entry.game.name,
            variantId: entry.game.variantId,
            ...(entry.version !== null ? { version: entry.version } : {}),
            assetsFound: entry.hits.length,
          });
        }

        next = {
          ...next,
          sync: {
            lastSyncAt: now,
            games: all.length,
            variantIds: wanted.map((g) => g.variantId),
          },
        };
        writeBank(bankDir, next, shardsFor(touched));
        return { bankDir, perGame, created, total: next.assets.length };
      });

      const failures = result.perGame.filter((g) => g.error);
      return text({
        bank: result.bankDir,
        mode,
        gamesOnAccount: all.length,
        gamesSynced: result.perGame.length - failures.length,
        newToBank: result.created.length,
        bankTotal: result.total,
        tookMs: Date.now() - startedAt,
        games: result.perGame,
        ...(result.created.length ? { newPaths: result.created.slice(0, 40) } : {}),
        ...(failures.length
          ? {
              warning: `${failures.length} game(s) could not be read and were skipped — their assets are missing from this sync. The rest completed.`,
            }
          : {}),
        next:
          result.created.length > 0
            ? "Name and categorize the ones worth remembering with spawn_asset_note, and look at unfamiliar images with spawn_asset_preview."
            : "Bank already had everything the account uses.",
      });
    }
  );

  server.registerTool(
    "spawn_asset_scan",
    {
      description:
        "Harvest every cdn/ asset path used in a project (or any directory) into the local cross-project asset bank, recording which files and which game use it. Spawn generates an asset on first fetch of its path and keeps it there forever, so the same path in another game is the same asset — but there is no catalog API, and this bank is the only record of which names you have already used and how they turned out. Run it on each of your game projects once, then use spawn_asset_search before inventing a new asset name.",
      inputSchema: {
        projectDir: z
          .string()
          .optional()
          .describe("Directory to scan. Defaults to SPAWN_PROJECT_DIR or the MCP process cwd."),
        dirs: z
          .array(z.string())
          .optional()
          .describe("Scan several directories in one call, e.g. every game project you have. Overrides projectDir."),
      },
    },
    async ({ projectDir, dirs }) => {
      let targets: string[];
      try {
        targets = dirs?.length ? dirs.map((d) => resolveProjectDir(d)) : [resolveProjectDir(projectDir)];
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }

      const now = new Date().toISOString();
      const result = await withBank((bank, bankDir) => {
        let next = bank;
        const perDir: Array<Record<string, unknown>> = [];
        const created: string[] = [];
        const warnings = new Map<string, PathWarning>();
        const touched: string[] = [];

        for (const dir of targets) {
          const variantId = projectVariant(dir);
          const { hits, filesScanned } = scanDirectory(dir);
          for (const hit of hits) {
            const up = upsertAsset(
              next,
              hit.path,
              { project: dir, variantId, files: hit.files, source: "scan" },
              now
            );
            next = up.bank;
            touched.push(hit.path);
            if (up.created) created.push(hit.path);
            const asset = findAsset(next, hit.path);
            const warning = asset ? pathWarning(asset) : null;
            // Keyed by path: the same asset scanned from two of the given
            // directories is one warning, not two.
            if (warning) warnings.set(warning.path, warning);
          }
          perDir.push({
            dir,
            ...(variantId ? { variantId } : { variantId: null }),
            filesScanned,
            assetsFound: hits.length,
          });
        }

        writeBank(bankDir, next, shardsFor(touched));
        return {
          ...withAdvice(next, {}),
          bank: bankDir,
          scanned: perDir,
          newToBank: created.length,
          bankTotal: next.assets.length,
          ...(created.length ? { newPaths: created.slice(0, 40) } : {}),
          ...summarizePathWarnings([...warnings.values()]),
          ...(perDir.some((d) => d.variantId === null)
            ? {
                note: "A project whose own .env names no SPAWN_VARIANT_ID cannot be matched to a game, so it counts as its own game in reuse counts. Run this from a bootstrapped project to attribute it correctly.",
              }
            : {}),
        };
      });

      return text({
        ...result,
        next:
          result.newToBank > 0
            ? "Name the ones worth remembering with spawn_asset_note (name + description + category) — a path with no name is nearly as unusable as no record at all — and look at unfamiliar images with spawn_asset_preview."
            : "Nothing new. spawn_asset_search finds what is already banked.",
      });
    }
  );

  server.registerTool(
    "spawn_asset_search",
    {
      description:
        "Search the local asset bank for assets you (or your other projects) have already used. Call this BEFORE inventing a new cdn/ asset name: a path that already produced good art is reusable across games verbatim, and a path marked bad tells you what not to spell. Every result reports how many distinct GAMES use it — the strongest signal that an asset actually worked. Pass facets:true with no query to see what categories, kinds and style families the bank holds.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free text over name, path, category, tags and description, e.g. "knight" or "mud texture".'),
        name: z.string().optional().describe("Exact bank name you assigned with spawn_asset_note."),
        category: z
          .string()
          .optional()
          .describe('Exact category you assigned, e.g. "enemies". Use facets:true to list what exists.'),
        prefix: z
          .string()
          .optional()
          .describe('First token of the FILENAME, e.g. "model", "texture", "sfx". Derived from the path, not assigned by you.'),
        kind: z.enum(["model", "image", "audio", "unknown"]).optional(),
        slug: z.string().optional().describe('Moodboard style family without the prefix, e.g. "gothic-horror".'),
        namespace: z
          .enum(["moodboard", "root", "custom", "ingested"])
          .optional()
          .describe("moodboard = the documented namespaced form; root = bare global names; ingested = opaque uploads."),
        verdict: z
          .enum(["good", "bad", "unrated"])
          .optional()
          .describe('"good" for names known to have worked, "bad" for names to avoid.'),
        project: z.string().optional().describe("Only assets used in this project directory."),
        variantId: z.string().optional().describe("Only assets used by this game."),
        minGames: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only assets reused in at least this many distinct games — proven-good filter."),
        facets: z
          .boolean()
          .default(false)
          .describe("Include counts by category, kind, style family and namespace over the whole match set."),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async ({ limit, facets, ...filters }) => {
      const bankDir = resolveBankDir();
      const bank = readBank(bankDir);
      if (!bank.assets.length) {
        return text(withAdvice(bank, { bank: bankDir, results: [] }));
      }
      const { total, results, matched } = searchAssets(bank, filters, limit);
      return text({
        ...withAdvice(bank, {}),
        bank: bankDir,
        bankTotal: bank.assets.length,
        matched: total,
        returned: results.length,
        ...(facets ? { facets: facetsOf(matched) } : {}),
        results: results.map(brief),
        ...(total > results.length
          ? { note: `${total - results.length} more match — raise limit or narrow the query.` }
          : {}),
        ...(total === 0
          ? {
              note: `No match among ${bank.assets.length} banked assets. If you are about to create one, name it cdn/moodboard-<slug>/<prefix>-<name>.<ext> using a canonical slug (${CANONICAL_SLUGS.join(", ")}) — the path IS the asset, and the name is what gets generated.`,
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "spawn_asset_note",
    {
      description:
        "Name, categorize, describe or judge an asset in the bank — including a path that has not been scanned or even used yet. A name is a short handle you can use in place of the path in every other asset tool. This is the memory the platform does not keep: a Spawn asset is generated once from its path and cached there forever, so you cannot re-roll a name, and 'this name produced the wrong thing, use that one instead' is information nothing else records. Write the description while you can still see the asset.",
      inputSchema: {
        path: refSchema,
        name: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe('Short unique handle, e.g. "knight" — usable instead of the path everywhere. Must be unique in the bank.'),
        category: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe('Your own grouping, e.g. "enemies", "ui-icons", "ambient-music". Free-form; searchable and listable.'),
        description: z
          .string()
          .optional()
          .describe("What the asset actually looks or sounds like. Write it as if for someone who cannot see it."),
        tags: z.array(z.string()).optional().describe("Replaces the existing tags."),
        verdict: z
          .enum(["good", "bad"])
          .optional()
          .describe('"good" ranks it higher in search; "bad" ranks it below everything and warns on retrieval.'),
        replacedBy: z
          .string()
          .optional()
          .describe("For a bad name: the name or path to use instead. This is the whole point of recording a bad one."),
      },
    },
    async ({ path: ref, name, category, description, tags, verdict, replacedBy }) => {
      if (
        name === undefined &&
        category === undefined &&
        description === undefined &&
        tags === undefined &&
        verdict === undefined &&
        replacedBy === undefined
      ) {
        return err("Nothing to record. Pass at least one of name, category, description, tags, verdict, replacedBy.");
      }

      const outcome = await withBank((bank, bankDir) => {
        const resolved = resolveRef(bank, ref);
        if ("error" in resolved) return { ok: false as const, error: resolved.error };
        const { path } = resolved;

        if (name) {
          const clash = findNameOwner(bank, name, path);
          if (clash) {
            return {
              ok: false as const,
              error: `The name "${name}" already belongs to ${clash.path}. Names are handles you look assets up by, so they have to be unique — pick another, or rename that one first.`,
            };
          }
        }

        let replacement: string | undefined;
        if (replacedBy !== undefined) {
          const r = resolveRef(bank, replacedBy);
          if ("error" in r) return { ok: false as const, error: `replacedBy: ${r.error}` };
          replacement = r.path;
          if (replacement === path) {
            return { ok: false as const, error: "replacedBy points at the same asset. It should name the asset to use instead." };
          }
        }

        const now = new Date().toISOString();
        const { bank: withEntry, created } = upsertAsset(bank, path, null, now);
        const entry = findAsset(withEntry, path)!;
        const updated: Asset = {
          ...entry,
          name: name ?? entry.name,
          category: category ?? entry.category,
          description: description ?? entry.description,
          tags: tags ?? entry.tags,
          verdict: verdict ?? entry.verdict,
          replacedBy: replacement ?? entry.replacedBy,
          updatedAt: now,
        };
        const next: Bank = {
          ...withEntry,
          assets: [...withEntry.assets.filter((a) => a.path !== path), updated],
        };
        writeBank(bankDir, next, shardsFor([path]));
        return {
          ok: true as const,
          created,
          asset: updated,
          bankDir,
          total: next.assets.length,
          advice: syncAdvice(next),
        };
      });

      if (!outcome.ok) return err(outcome.error);

      const warning = pathWarning(outcome.asset);
      return text({
        ...(outcome.advice ? { syncAdvice: outcome.advice } : {}),
        bank: outcome.bankDir,
        recorded: full(outcome.asset),
        addedToBank: outcome.created,
        bankTotal: outcome.total,
        ...(warning ? { warning: warning.text } : {}),
        ...(outcome.asset.verdict === "bad" && !outcome.asset.replacedBy
          ? {
              note: "Marked bad with no replacement. A bad name is most useful when it points at the name that worked — pass replacedBy once you have one.",
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "spawn_asset_preview",
    {
      description:
        "Check whether an asset actually exists on Spawn's CDN, and LOOK AT IT if it is an image (returned inline, so you can judge it rather than guess from the filename). Use it on an unfamiliar path before building around it, and after generating a new one to see what the name produced. Safe to call: it queries the storage host directly, which never triggers generation — a 404 means the asset has not been created yet, not that you are forbidden to ask.",
      inputSchema: {
        path: refSchema,
        render: z
          .boolean()
          .default(true)
          .describe("Return the image inline for image assets. false checks existence only (a HEAD request)."),
        note: z
          .boolean()
          .default(true)
          .describe("Record the result (exists, size) in the bank, adding the path if it is new."),
      },
    },
    async ({ path: ref, render, note }) => {
      const bankDir = resolveBankDir();
      const bankNow = readBank(bankDir);
      const resolved = resolveRef(bankNow, ref);
      if ("error" in resolved) return err(resolved.error);
      const { path } = resolved;

      let prefix = bankNow.storagePrefix?.url;
      let prefixSource = "bank";
      if (!prefix) {
        const fresh = await resolveStoragePrefix();
        prefix = fresh.url;
        prefixSource = fresh.source;
      }

      let check = await checkAsset(prefix, path, { fetchImage: render });
      // A miss from a cached prefix usually means the prefix moved (it carries an
      // environment and a version segment), so re-derive it once before believing
      // a 404.
      if (!check.exists && prefixSource === "bank") {
        const fresh = await resolveStoragePrefix();
        if (fresh.url !== prefix) {
          prefix = fresh.url;
          prefixSource = `${fresh.source} (re-resolved)`;
          check = await checkAsset(prefix, path, { fetchImage: render });
        }
      }

      const now = new Date().toISOString();
      let banked: Asset | null = null;
      if (note) {
        banked = await withBank((bank, dir) => {
          const { bank: withEntry } = upsertAsset(bank, path, null, now);
          const entry = findAsset(withEntry, path)!;
          const updated: Asset = {
            ...entry,
            // A transport failure (status 0) is not evidence of absence.
            exists: check.status === 0 ? entry.exists : check.exists,
            bytes: check.bytes ?? entry.bytes,
            checkedAt: check.status === 0 ? entry.checkedAt : now,
            updatedAt: now,
          };
          writeBank(
            dir,
            {
              ...withEntry,
              storagePrefix: { url: prefix!, resolvedAt: now },
              assets: [...withEntry.assets.filter((a) => a.path !== path), updated],
            },
            shardsFor([path])
          );
          return updated;
        });
      }

      // The check that just ran is fresher than anything banked, and it is the
      // whole point of previewing: it settles whether the name is still free.
      // A transport failure (status 0) is not evidence either way.
      const warning = pathWarning({
        ...(banked ?? classifyAssetPath(path)),
        exists: check.status === 0 ? (banked?.exists ?? null) : check.exists,
        usedIn: banked?.usedIn ?? [],
      });
      const advice = syncAdvice(bankNow);
      const meta = {
        ...(advice ? { syncAdvice: advice } : {}),
        ...(banked?.name ? { name: banked.name } : {}),
        path,
        exists: check.exists,
        status: check.status,
        // A 404 body has its own content-type, which says nothing about the asset.
        ...(check.exists && check.bytes ? { bytes: check.bytes } : {}),
        ...(check.exists && check.contentType ? { contentType: check.contentType } : {}),
        storagePrefix: prefix,
        prefixSource,
        ...(banked ? { games: gameCount(banked) } : {}),
        ...(banked?.category ? { category: banked.category } : {}),
        ...(banked?.description ? { description: banked.description } : {}),
        ...(banked?.verdict ? { verdict: banked.verdict } : {}),
        ...(warning ? { warning } : {}),
        ...(check.error ? { error: check.error } : {}),
        ...(!check.exists && check.status === 404
          ? {
              note: "Not generated yet. Referencing this path from your game creates the asset from the name on first fetch, so read the name once more before you commit to it — you cannot re-roll a path, only pick a different one.",
            }
          : {}),
        ...(check.exists && !check.image && render
          ? {
              note:
                check.contentType && !check.contentType.startsWith("image/")
                  ? "Exists, but only images can be shown inline — there is nothing to render for a model or a clip without the engine. Put it in the world and use spawn_play_screenshot to judge it."
                  : "Exists, but the bytes could not be inlined.",
            }
          : {}),
      };

      if (check.image) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(meta, null, 2) },
            {
              type: "image" as const,
              data: check.image.data.toString("base64"),
              mimeType: check.image.mimeType,
            },
          ],
        };
      }
      return text(meta);
    }
  );
}
