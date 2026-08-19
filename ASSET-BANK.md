# Asset bank

A local, cross-project catalog of Spawn CDN asset paths: what exists, what it
looks like, which games use it, and whether it came out well.

This document is the design. The user-facing summary is in [README.md](README.md).

## The mechanism it is built on

From `.spawn/guide.md`, fetched by `spawn_docs` — Spawn's own words:

> **Assets: naming is creating.** Asset paths are generated on first fetch —
> there is no catalog. The CDN path IS the asset:
> `/cdn/moodboard-<slug>/<category>-<name>.<ext>`

Three consequences follow, and the whole design is downstream of them.

**Sharing is already free.** Assets are content-addressed by path, so the same
path in two games is the same asset. That is what "if you use the same file name
it will be the same asset" means. Nothing needs to be built to share an asset;
you paste the path. A tool that "publishes an asset to other projects" would be
a tool that does nothing.

**There is no catalog, literally.** The guide says so, and probing confirms it:
`/api/agent/v1/assets`, `/media`, and `/cdn` all answer `404 not_found`. So a
local index is not a cache of a remote list — it is the only catalog that can
exist, and the closest thing to an authoritative source is the set of specs your
own games have pushed (see [Syncing with the account](#syncing-with-the-account)).

**A path is a prompt, and it is spent once.** Generation happens on first fetch
and the result is cached at that path forever. You cannot re-roll a name. A path
that produced something great is unrecoverable knowledge the moment you forget
how you spelled it, and a path that produced something bad is permanently bad —
the only fix is a different name.

That last point is the actual reason this exists. The platform stores the
assets. Nothing stores the **judgment**: which names worked, which did not, and
what to write instead. That is what the bank holds.

## What it is, and is not

**Is:** an index of paths, with descriptions, tags, a good/bad verdict, a
replacement pointer for bad ones, and provenance (which project, which files).

**Is not:** an asset store. No binaries are copied, ever. Spawn's CDN holds the
bytes; duplicating them locally would create a second source of truth for
something already immutable and globally addressed.

**Is not:** a generation lane. Naming is how assets get made, and that happens
when a game client fetches the path. These tools record names; they do not
commission art — `spawn_savi` is the one that does, by handing the job to Savi.

## Storage

`~/.spawn-mcp/assets/`, a directory, overridable with `SPAWN_ASSET_BANK`. A
setting that points at a `.json` file is read as its parent directory, so an
older single-file configuration keeps working.

User-level, deliberately. The team ledger lives in the repo's shared `.git`
because a team is scoped to exactly one game — which is precisely wrong here.
The bank's entire value is that it crosses games: the knight you named in one
project is the knight you want in the next one. A per-repo bank would forget
exactly the thing it exists to remember.

Concurrency reuses `withLedgerLock` from `team.ts`. Several MCP server
processes can run at once (one per worktree in team mode) and all of them write
to the one bank, so read-modify-write needs the same cross-process mutex the
ledger already has. Writes are atomic (temp file + rename).

### Sharding, and what it is actually for

One file per style family, plus `_meta.json`:

```
~/.spawn-mcp/assets/
  _meta.json                     storage prefix, shard list, total
  moodboard-mud-kingdom.json
  moodboard-pixel-bright.json
  root-effect.json    root-music.json    root-sfx.json
  ingested.json
```

Measured on a real bank: **821 bytes per asset**, so 1,000 assets is 0.8 MB and
10,000 is 7.8 MB. Read-and-parse of the whole catalog is 0.34 ms at 170 assets
and extrapolates to roughly 19 ms at 10,000.

So **sharding does not make search faster**, and it would be dishonest to claim
it does — a cross-shard query loads the same total bytes, and filtering a few
thousand objects in JS was never the bottleneck. What it buys is:

- **Bounded writes.** Naming one asset rewrites one family, not the catalog.
  Without this, a one-field note rewrites megabytes and widens the window a torn
  write has to hit.
- **A directory you can read.** Each file stays openable by a human.
- **A cheap "what have I got"** from the file listing alone.

The `root` namespace is sub-sharded by filename prefix (`root-effect`,
`root-sfx`) because it has no style family and is typically the *largest* group
— it holds the shared standard sets. On the bank this was developed against it
was 116 of 170 assets, so leaving it whole would have recreated the single
oversized file that sharding exists to avoid.

A corrupt shard degrades to empty and loses that one family; the rest of the
catalog still loads.

## Data model

Two vocabularies meet in an asset and are kept strictly apart.

**Derived from the path**, recomputed on every read and never editable:
`namespace`, `slug`, `canonicalSlug`, `prefix`, `stem`, `kind`.

**Assigned by you**, and never touched by a rescan: `name`, `category`,
`description`, `tags`, `verdict`, `replacedBy`.

`prefix`/`stem` are what the filename happens to say —
`model-humanoid-knight.glb` has prefix `model` and stem `humanoid-knight`.
`name`/`category` are what *you* decided it is. Collapsing the two would mean a
rescan could silently overwrite a judgement, and it would leave no way to say
"this `texture-` file is one of my **terrain** assets".

Only assigned fields are written to disk; derived ones are recomputed on read,
so a change to the path grammar cannot leave an asset mis-filed in a stale shard.

```jsonc
// root-effect.json
{
  "version": 1,
  "shard": "root-effect",
  "assets": [
    {
      "path": "cdn/effect-smoke-puff.png",
      "name": "smoke",                    // your handle — usable instead of the path
      "category": "particles",            // your grouping
      "description": "Soft grey puff, radial falloff, transparent edges.",
      "tags": ["particle"],
      "verdict": "good",                  // good | bad
      "replacedBy": null,                 // set when bad: what to use instead
      "exists": true,                     // from the storage host
      "bytes": 106252,
      "checkedAt": "…",
      "usedIn": [
        { "project": "C:/…/King of The Mud", "variantId": "fa00b40a-…", "files": ["game.json"], "lastSeenAt": "…" }
      ],
      "firstSeenAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

Sorted arrays rather than keyed objects, matching `roster.json` and
`claims.json`: stable diffs, and the file stays readable by a human who opens it.

## Syncing with the account

There is no asset API. `/api/agent/v1/assets`, `/media`, and `/cdn` all answer
`404 not_found`; the only account-wide endpoint is `/api/agent/v1/games`. So
"sync with your account" has exactly one honest meaning:

1. `GET /api/agent/v1/games` — every game you own.
2. For each, `GET /api/sdk/v1/{variantId}/game-specs/latest` — the server's
   current spec.
3. Harvest `cdn/` paths out of it, attributing each to the script it appears in.

This is not a nicer `spawn_asset_scan`. It sees things a local scan **cannot**:
games with no checkout on this machine, and assets a teammate or Savi pushed
that never landed on your disk. Measured on the account this was built against,
a local scan of three projects found **169** assets and the sync found **408** —
the same Fire Nuke Island that had 105 asset references on disk had 298 in its
pushed spec. Most of the catalog was invisible to local scanning.

It is slow on purpose: one spec fetch per game, each carrying every script
source. Six games took ~3s. Fetches run four at a time — enough to keep a large
account quick, restrained enough not to look like a scraper against someone
else's server, which also exposes a rate-limit header.

Two failure choices worth stating:

- **Specs are fetched outside the bank lock.** Holding a cross-process mutex
  across minutes of network would stall every other agent's notes for no gain.
- **A game that errors is reported and skipped**, never fatal. One unreachable
  game must not cost you the other nineteen, and the result says plainly that
  its assets are missing from the run.

### Recommending a sync

`syncAdvice()` returns a line for the model, and every asset tool includes it —
not just search. The reason is that the damage happens at the moment of
*invention*: a stale bank answers "no match", the model coins a fresh path, and
an asset that already exists under a good name on another game gets regenerated
under a second name. Since a path cannot be re-rolled, those two names can never
be merged afterwards. That failure is silent and permanent, so the warning
belongs on every surface that could precede it.

It fires when the bank is empty, when it has never been synced (local scans
only), or when the last sync is more than seven days old.

## Names

A name is a short unique handle, and **every tool that takes a path takes a name
instead**. `spawn_asset_preview path="knight"` is the point of naming — a path
is 60 characters of style family and hyphenation that nobody recalls exactly,
which is the same reason the bank exists at all.

Names are unique and a collision is refused rather than silently reassigned: a
handle that resolves to two things is not a handle. Lookup is
case-insensitive.

## Counting games, not directories

`usedIn` records project directories, but the useful question is **how many
games use this**, and those are not the same number. In team mode one game is
several worktrees, each its own directory with its own `.env`, so counting
directories reports a three-agent team as three games and turns the reuse signal
into a headcount of your own agents.

So each use also records the `variantId` from that project's own `.env`, and
`gameCount` collapses uses that share one. Two details matter:

- The variant is read from the **project's** `.env` only. `loadEnv` falls back
  to the process environment, which during a multi-directory scan would stamp
  this server's variant onto every project and merge unrelated games into one.
- A project whose `.env` names no variant **counts on its own**. It cannot be
  proven to be the same game as another, and quietly merging unknowns would
  under-report.

Reuse across games is the strongest available evidence that an asset actually
worked, so it also feeds ranking, and `minGames` filters on it directly.

## Path grammar

The documented shape is `/cdn/moodboard-<slug>/<category>-<name>.<ext>`, with
nine canonical style families: `lowpoly-cozy`, `painterly-fantasy`,
`toon-vibrant`, `voxel-bright`, `realistic-gritty`, `scifi-neon`,
`gothic-horror`, `pixel-bright`, `pixel-moody`.

Real projects contain four namespaces, and the bank distinguishes them because
they carry different risks:

| Namespace | Example | Meaning |
|---|---|---|
| `moodboard` | `cdn/moodboard-gothic-horror/model-humanoid-knight.glb` | The documented form. Slug namespaces the name. |
| `root` | `cdn/effect-smoke-puff.png`, `cdn/music-battle-loop.mp3` | Bare global namespace. Appears to be a shared/standard set. |
| `custom` | `cdn/my-folder/thing.png` | Some other folder. |
| `ingested` | `cdn/public.aHR0cHM6…​.png` | Base64-encoded upload. Not a name — carries no naming guidance. |

**`root` is the collision hazard and the bank warns about it.** If naming is
creating and the namespace is global, then `cdn/model-tree.glb` is whatever the
first person to fetch that path caused to be generated. A moodboard slug is the
defense. `ingested` paths are excluded from naming guidance entirely: they are
opaque blobs, not names anyone should imitate.

### Warning volume, and why it is not constant

A path cannot be re-rolled, so "prefer a namespaced path" is advice about a
*future* name. Aimed at a path that already exists it is not advice at all —
there is no action behind it. That distinction is the warning's severity:

- **`act`** — nothing has been generated here. Either storage says so
  (`exists: false`, definitive) or nothing is recorded as using it, which is the
  moment of invention and the highest-value moment to say it. Full advice.
- **`note`** — the path is spent: storage confirmed the bytes, or a real game
  already references it (`exists` unknown, but referencing a path is what fetches
  it, and renaming now means editing shipped content). The diagnosis still
  lands — a caller should know a bare name is globally shared — but the
  instruction becomes "apply this to the next name".

`exists: false` outranks being referenced, because a path written into
`game.json` that has never been fetched is precisely the case that is still
fixable.

A scan reports the two at different volumes. Actionable paths are named
individually; spent ones collapse to **one line per kind** with a count and a
`spawn_asset_search namespace:"root"` pointer. Before this, scanning one real
project emitted the same sentence sixty-three times with only the path changing,
truncated to ten — which reads as ten findings, recommends an impossible action
for every path listed, and buries the one path that could still be renamed.

`kind` comes from the extension (`.glb` → model, `.png`/`.jpg` → image,
`.mp3`/`.wav` → audio). `prefix` is the first hyphen-delimited token of the
filename, recorded as-is rather than validated against a closed list — the
observed set (`model`, `texture`, `sprite`, `effect`, `sfx`, `music`) is a
convention, not a schema, and rejecting an unrecognised one would be this
server inventing a rule Spawn does not have.

Note that `prefix` is a *type* axis and largely restates `kind`. Your own
`category` is the semantic axis — "enemies", "ui-icons", "ambient-music" — and
the two are searchable independently.

## Two hosts, and the safe existence check

`https://www.spawn.co/cdn/<path>` is the **cook route**. For an asset that
exists it answers `302` with `x-cook-state: ready` and a `location` pointing at
storage. For an unknown path it answers `401` — generation is authenticated,
which is why an agent cannot accidentally bring an asset into existence by
checking on it from here.

`https://spawnfile.io/dev/magic-assets/v5/assets/<path>` is **storage**. It
answers `200` with the bytes, or `404`, and it does not cook. No credentials
either way; `access-control-allow-origin: *`.

So the existence check is: **ask storage, not the cook route.** It is
side-effect-free, unauthenticated, and unambiguous — a `404` means the asset has
not been generated yet, rather than meaning "you are not allowed to ask".

The storage prefix contains an environment segment (`dev`) and a version
(`v5`), so it is **not hardcoded**. It is resolved by following one 302 from the
cook route for a path already known to exist, then cached in the bank. When a
check starts failing wholesale, the prefix is re-resolved. Hardcoding it would
turn Spawn's next deploy into a silent wrong answer.

Because storage returns the actual bytes, an image asset can be handed to the
model as an MCP image block. That is the part that makes this a catalog rather
than a list of strings: a model cannot tell what `model-humanoid-knight.glb`
looks like from its name, and for `.png` assets it no longer has to guess.
`.glb` and `.mp3` report existence and size only — there is nothing to render
without the engine.

## Tools

Five, which takes the solo list from 27 to 32. Kept deliberately small; the
temptation is to add per-field editors and a delete tool, and none of them earn
their slot.

| Tool | Purpose |
|---|---|
| `spawn_asset_sync` | Pull every game on the account and harvest its server-side spec — the authoritative fill |
| `spawn_asset_scan` | Harvest `cdn/` paths from one or more directories into the bank, with provenance and the game each belongs to |
| `spawn_asset_search` | Query by text, name, category, prefix, kind, slug, namespace, verdict, project, game, or reuse count; `facets:true` for a breakdown |
| `spawn_asset_note` | Name, categorize, describe, tag, mark good/bad, point a bad name at its replacement |
| `spawn_asset_preview` | Check existence against storage; render images inline so the model can see them |

`spawn_asset_scan` reads raw file text (`game.json`, `world/**.json`,
`scripts/**`) rather than the compiled spec, so it also catches paths assembled
in script strings and paths in projects that do not compile. It accepts any
directory, not only Spawn projects.

`spawn_asset_search` returns the true match count alongside the page, because
reporting only the page size reads as "that is all there is" at exactly the
moment the caller should narrow the query instead of concluding the asset does
not exist. `facets:true` answers "what categories/kinds/families do I have"
over the whole match set, which is why there is no separate listing tool.

`spawn_asset_note` can annotate a path that has never been scanned. Recording
"I am about to use this name, and here is what I want from it" before the first
fetch is the highest-value moment to write it down, because that is the moment
the name is still changeable.

## Deliberately not built

**No delete.** A bad name is the most valuable record in the bank — it is the
one piece of information that cannot be recovered by scanning a project again.
`verdict: "bad"` with `replacedBy` keeps it working for you instead of
vanishing.

**No auto-scan or auto-sync on push.** Harvesting on every `spawn_push` would
make the bank grow silently and attribute paths to whichever agent happened to
push; an implicit sync would put a multi-second account-wide fetch inside a
one-second operation. Both are things you do on purpose, which is why the tools
*recommend* a sync rather than performing one.

**No sync to the team ledger.** Per-repo and per-user are different scopes and
merging them would put one game's paths in charge of the cross-game memory.

**No generation, no upload.** Neither has an agent API, and naming already is
the generation path.

## Open questions

- Whether the `root` namespace is a Spawn-curated standard set or simply the
  paths people happened to fetch first. The bank flags it as a collision risk
  either way, which is the correct behaviour under both readings.
- Whether `x-cook-state` has values beyond `ready` worth surfacing.
  `x-cook-retry-after` is in the exposed-headers list, which implies a
  `cooking`-style state exists on the authenticated path.
