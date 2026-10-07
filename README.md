# Indiana Code

Indiana Code by citation, plus full-text topic search and historical (per-year)
annual editions. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1704+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Source (fleet #2724)

The Indiana General Assembly's code viewer (iga.in.gov) is a React SPA. Its own
JS bundle names its data source directly (`REACT_APP_API_URL`), and the page a
title renders fetches one plain document per title per year:

```
https://iga.in.gov/ic/<year>/Title_<N>.html
```

One document per TITLE, not per section — `Title_9.html` (Motor Vehicles) is
~5.9 MB and contains all of Title 9's ~2,300 sections for that year. `<year>`
is the same field the SPA calls `in_code_year` — **this is the historical-
version capability**: `in_code_section`'s `year` argument fetches the exact
same shape for a past year (e.g. 2018), rather than needing a separate archive
API. Measured 2026-10-06: Title 9 has real content back to 2017; some titles'
earliest year differs, so a request for a year with no archived content
returns `year_or_title_not_found` rather than a hardcoded floor.

**The upstream needs a browser-shaped User-Agent.** A bare UA (including a
plain `"Mozilla/5.0"`) gets HTTP 200 with a 691-byte SPA shell — silent
emptiness, not an error. `Mozilla/5.0 (compatible; pipeworx-mcp-indiana-code/1.0;
+https://pipeworx.io)` — the same honest bot-UA convention this repo already
uses elsewhere (19hz, fed-comms) — passes; no Referer, cookie, or JS challenge
needed. Confirmed with a plain `curl`, outside any browser.

## Citation lookup

`in_code_section` resolves a citation (e.g. `"9-21-5-5"`, `"32-31-3-6"`) by
locating its boundary marker — a `section`-classed element keyed by the
citation itself — in the title document. Every title/article/chapter/section
in the source carries the same marker shape, so one boundary scan finds a
section's exact start and end regardless of its depth in the hierarchy.

For the **current** code, it tries a pre-fetched bundle first
(`scripts/ingest-indiana-statutes.mjs`, written to the shared `pipeworx-datasets`
R2 bucket at `statutes/in/<title>.json` — one bundle per title, 37 total) and
falls back to a live fetch if the bundle is missing. For an explicit `year`
different from the bundle's own ingested year, it always goes live — the
pre-fetched bundle only ever holds the current code; historical years are not
pre-ingested because the live path is not throttled (unlike
`mcps/north-carolina-code`'s per-section path on ncleg.gov).

Each section's trailing "As added by..."/"Amended by..." note (and any
"[Pre-&lt;year&gt; Recodification Citation: ...]" line) is split out into its own
`history` field rather than left inside `text` — the amendment-history
capability the task asked for, same split `mcps/california-code` makes for its
own trailing enactment parenthetical.

## Topic search

`in_code_search` answers questions no citation lookup can — "landlord
retaliatory eviction", "oversized vehicle permit" — via FTS5 in the shared
`SEARCH_SHARD` Durable Object (`workers/gateway/src/search-shard.ts`, shard
name `in-statutes`; no new Cloudflare binding, per
`docs/gateway-text-binding-limit.md`). Search hits carry a citation and
heading; call `in_code_section` with the section from a result for the full
text.

## Coverage

All 37 Indiana Code titles that exist as separate documents (Title 7 is fully
folded into 7.1 and returns no separate content; Titles 17/18/19 are "REPEALED"
stubs with a marker and zero sections — both kept as real, zero-section
results rather than treated as missing). 77,780 sections ingested across 37
titles for the 2026 code.

## Refresh

`node scripts/ingest-indiana-statutes.mjs` — re-run periodically (the General
Assembly convenes annually; there is no daily-freshness need). No schedule is
wired up: dispatch by hand, following the same pattern as
`scripts/ingest-nc-statutes.mjs`.

## Data source

Official state legislature site (iga.in.gov). Indiana statutes are public
record; no reuse restriction was found on the title bulk-document paths used
here.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "indiana-code": {
      "url": "https://gateway.pipeworx.io/indiana-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/indiana-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1704+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/in_code_section \
  -H 'Content-Type: application/json' \
  -d '{"section":"9-21-5-5"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/in_code_section`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "indiana-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-indiana-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-indiana-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Indiana Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
