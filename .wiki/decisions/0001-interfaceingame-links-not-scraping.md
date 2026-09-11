# 0001 — Interface In Game: links, not scraping

Date: 2026-09-10
Status: accepted

## Context

interfaceingame.com catalogues ~16,000 game-UI screenshots across 399 games, faceted by
**elements** (21 UI surface types), genres, themes, and platforms. It was proposed as a
reference source to guide UI decisions in agent builds.

Investigated surface:

- Filters are server-rendered query params — `?elements=skill-tree&themes=fantasy` is a
  stable, shareable URL.
- A WordPress REST API exists at `/wp-json/wp/v2/games`: 399 games with slug, title,
  link and taxonomy terms in `class_list`. **Screenshot-level element tags are not in
  the API** — only in page HTML. Image URLs are predictable and trivially scrapeable.
- `robots.txt` is permissive, but the site's terms of use, "Prohibited uses" clause (i),
  forbids using the site to "spider, crawl, or scrape."
- The screenshots are the game publishers' copyright; the site disclaims ownership.
- It is a free volunteer project funded by donations.

## Decision

**Use the element taxonomy. Never touch their servers.**

1. The 21-element vocabulary is hardcoded locally. It is a factual enumeration of what a
   finished game's UI contains, not their copyrighted expression, and it is ~21 strings.
2. Reference URLs are **emitted as links for a human to open**, never fetched.
3. No image is downloaded, cached, mirrored, or passed to a model as reference.

## Rationale

The valuable content is the images, and the images are exactly the part we cannot use. A
tool returning `hollow-knight-charms.jpg | inventory, stats` hands the model a filename
it cannot see — the same failure mode `src/builtins.ts` already refuses (R-001): a stub
that passes against behaviour that never ran.

What is genuinely missing from agent builds is not "the inventory screen looks wrong" but
"there is no pause overlay, no game-over screen, and no loading state." That is a
completeness question, it is answerable from the taxonomy alone, and per the local-audit
principle it does not need a browser.

Emitting links also sends the site traffic instead of taking its bandwidth, and puts a
human eye on the reference — which is where taste belongs.

## Consequences

- R-007 in `rules.md`.
- No third-party uptime or HTML structure becomes a dependency of this server.
- Users who want reference *matching* use the existing path: pick a screenshot, attach
  it, and the `match-a-reference` engine skill handles it.

## The vocabulary

`character`, `credits`, `dialogue`, `game-over`, `in-game`, `inventory`,
`level-selection`, `loading`, `lobby`, `main-menu`, `map`, `overlay`, `progress`,
`quest`, `scoreboard`, `settings`, `skill-tree`, `start-screen`, `stats`, `store`,
`tutorial`

Slugs verified against the site's own filter URLs, so an emitted deep link resolves.
