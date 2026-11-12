# Developer documentation v2 — implementation contract

Recovery note (2026-11-12): this is the original design worktree’s contract and historical
verification record. The current recovery and fresh acceptance checks are tracked in
[homepage and docs routing](./homepage-and-docs-routing.md), M1–M5.

**Status: LOCALLY COMPLETE (2026-10-15) — authorized by the maintainer the same day.** W1–W12 are
implemented and verified locally (see [Completion record](#completion-record)); a full hosted CI run
(the workflow changed), deployment and the main app's zone switch remain. This contract supersedes the
_presentation_ decisions of [`mcp-and-public-docs-experience.md`](./mcp-and-public-docs-experience.md)
(hand-rolled static HTML, the navy “workbench” visual direction, and “no framework”). Every
_content, evidence and honesty_ decision of that contract stays in force and is restated below.
[`implementation-order.md`](../implementation-order.md) remains the global queue. Publication,
domain configuration and deployment remain maintainer-held.

## Outcome

TotalFinance gets documentation developers love and agents can use: a modern, fast, accessible
docs site in the InsiderFinance documentation family, with interactive calculators that accept the
reader's own data and visualize every result that has a natural picture. It is served under
`https://www.insiderfinance.io/docs/totalfinance` (Next.js multi-zone rewrite from the main app), so
it builds awareness for InsiderFinance while the source, generators and evidence stay in this
open-source repository.

## Decisions

1. **Framework.** `site/` becomes a private, separate pnpm project (`site/package.json` with its own
   `site/pnpm-lock.yaml`, outside the library workspace) built with Next.js 16 (App Router), React
   19, Fumadocs 16 (UI + core + MDX) and Tailwind CSS 4. It links the **built** package
   (`distribution/totalfinance`) exactly as an installed consumer would. _Amended during
   implementation:_ a workspace package made pnpm re-resolve the library's dependency graph; a
   separate project keeps the root lockfile untouched. The library packages gain no dependencies.
2. **Static export.** `next build` with `output: 'export'` and **clean URLs** (`trailingSlash:
false`; a page `/learn/x` is `learn/x.html`) writes a portable static site to `site/dist`.
   _Amended during implementation:_ the InsiderFinance app (Next.js 14, `trailingSlash: false`)
   redirects `/x/` to `/x` before its zone rewrite runs, so a trailing-slash zone would redirect
   forever. No route ends in `/index` either: clean-URL hosts redirect `/x/index` to `/x`. No page needs a server. The only optional dynamic piece is
   the stateless docs MCP endpoint (Decision 9), shipped as a host function that reads the same
   static artifacts.
3. **Base path.** All routes live under `TOTALFINANCE_DOCS_BASE_PATH` (default `/docs/totalfinance`).
   Canonical URLs use `TOTALFINANCE_DOCS_ORIGIN` (default `https://www.insiderfinance.io`). The
   local preview serves the export at the same base path.
4. **Design.** The InsiderFinance API-docs language: white reading surface, slate hairlines,
   `#303fe1` interaction colour, Space Grotesk display type, system UI body type, three columns
   (navigation, content, sticky dark “Run it” panel), plus a complete dark theme. TotalFinance keeps
   its own wordmark “by InsiderFinance”, with the GitHub repository and Apache-2.0 licence visible.
   Charts sit full width in the content column; the run panel holds inputs and key results.
5. **Calculations stay in the library.** Playground definitions (`site/src/playgrounds/*`) remain
   framework-agnostic modules that call public package APIs and return a typed `Calculation`. The
   React UI renders that object; it never computes finance itself. Calculations run in a Web Worker.
6. **Typed inputs, including the reader's data.** The playground control schema grows from numbers
   to `number | select | table | data` controls. One schema drives the form, boundary validation,
   URL state, the WebMCP tool schema and the copied TypeScript. Data controls accept pasted or
   uploaded CSV/TSV (OHLCV bars, single value columns, or typed tables) with row-numbered errors and
   an explicit row limit. Nothing leaves the browser.
7. **Charts.** Purpose-built React SVG charts (line/area with profit-loss fill, candlesticks with
   overlays and oscillator panes, heatmaps, histograms with tail shading, waterfalls), with a hover
   crosshair, keyboard navigation, synchronized panes, theme-aware colours, and the exact-data table
   for every chart. No canvas-only chart; no chart library that hides values from assistive tech.
8. **Search.** The tested deterministic ranking (`site/src/search.ts`) remains the engine; the UI
   becomes a ⌘K dialog with keyboard navigation, kind badges and grouped results.
9. **Agents first.** Every page has a Markdown twin (`<route>.md`), a “Copy page” action and “Open in
   Claude / ChatGPT” links. `llms.txt` is the index, `llms-full.txt` stays complete, and bounded
   per-domain bundles (`llms/<domain>.txt`) fit in an agent context. Every reference entry point has
   a JSON twin. A stateless docs MCP endpoint (`search_docs`, `read_page`, `get_reference`,
   `list_calculators`) reads the static artifacts; it never computes finance (the local
   `@insiderfinance/totalfinance-mcp` server does that). Page-scoped WebMCP calculator tools remain.
10. **Funnel without gating.** Pages that need market data say so honestly and link to the
    InsiderFinance product/API through one configuration module. API/MCP family links only appear
    when the build is told those docs are public. No analytics beacon, account or key is required.
11. **Versions and evidence are unchanged in meaning.** The version label, release ledger,
    release-receipt import, immutable archive restoration and copied-example fingerprints keep their
    semantics. A version-pinned snapshot is emitted under `versions/<version>/`. Indexing is
    explicit: `TOTALFINANCE_DOCS_INDEXING=index|noindex`, defaulting to `index` only for a verified
    published build; archived versions are always `noindex` with a canonical link to the current page.
12. **Security.** Static pages carry a per-page Content-Security-Policy `<meta>` whose `script-src`
    is `'self'` plus the SHA-256 hashes of that page's inline scripts (no `'unsafe-inline'` for
    scripts). Host headers carry the remaining directives. The live-code runner executes only code
    the reader typed or loaded from the page, never code from a URL, inside a sandboxed
    opaque-origin frame (`sandbox="allow-scripts"`), in a classic worker the frame terminates. Its
    own CSP allows no network and scripts only from the hosts that serve these docs (WebKit, per
    the CSP specification, matches `'self'` to nothing in an opaque origin, so the hosts are
    named; browsers also refuse a module worker from a blob in an opaque origin).

## Architecture

```
site/
  package.json            separate private pnpm project (next, react, fumadocs-*, tailwindcss, d3-*)
  next.config.mjs         static export, basePath, MDX
  source.config.ts        Fumadocs MDX collections
  app/                    App Router: home, docs routes, reference routes, llms/markdown routes
  components/             design system, playground UI, charts, data input, search dialog
  lib/                    source loader, configuration, markdown rendering, family links
  content/docs/           authored MDX (start, concepts, tasks, domains, agents)
  scripts/                prebuild generation, post-export (CSP, snapshot, sitemap), verification
  src/                    framework-agnostic: playgrounds, search, types, examples, routes, runner
  version.ts archives.ts record-release.ts releases.json   (unchanged role)
  serve.ts                local preview at the base path, Markdown negotiation, local MCP route
  mcp/                    stateless docs MCP handler + host adapter
  test/                   site tests (build, search, playgrounds, charts, data parsing, MCP, a11y)
```

Prebuild (`scripts/generate.ts`) writes git-ignored inputs: guide Markdown with rewritten links,
bounded reference page data, the search index, operation catalog, per-domain LLM bundles and the
version manifest. `scripts/runtime.ts` bundles the browser runtime for the live-code runner. `next build` renders pages from those inputs. Post-export (`scripts/postexport.ts`)
writes Markdown twins, CSP meta tags, sitemap/robots, the version snapshot and route inventory.

## Workstreams and acceptance

### W1 — Foundation and design system

- [x] Separate pnpm project (Decision 1, amended) with its own frozen lockfile and scripts
      (`site:install`, `site:build`, `site:dev`, `site:test`, `site:typecheck`); library packages,
      root dependencies and the root lockfile unchanged.
- [x] Static export under the base path with clean URLs (Decision 2, amended: no trailing slash,
      no route ending in `/index`) and a real `404.html`.
- [x] Theme tokens matching the InsiderFinance docs (light and dark), self-hosted fonts, focus
      rings, reduced-motion support, skip link, landmark structure.
- [x] Header (TotalFinance by InsiderFinance, section tabs, ⌘K search, version, GitHub, theme),
      sidebar tabs (Docs, Reference, Agents), table of contents, breadcrumbs, page actions,
      responsive mobile navigation that does not consume the first screen.

### W2 — Content

- [x] Home page: value proposition, install, first call with real output, task cards, live
      calculator preview, domain map, agent entry, InsiderFinance funnel.
- [x] Start here: introduction, installation (honest about publication status), quickstart,
      core concepts (units & conventions, `.explain()` envelopes, errors, API levels, imports).
- [x] Domain overview pages for every public domain, generated lists of key functions plus authored
      introductions. Authored code blocks execute in CI.
- [x] All existing public guides render from `docs/guides/` (single source), with internal links
      rewritten and non-public links neutralized exactly as before.
- [x] Agent handbook, MCP setup, profiles and the complete operation catalog.

### W3 — Playground contract and calculators

- [x] Typed control schema (`number | select | table | data`) with boundary validation, URL state,
      WebMCP schema and copied-code generation from one definition.
- [x] Upgraded calculators: option pricing (call/put, Greeks across spot), strategy builder
      (editable legs, presets, payoff with profit/loss fill and break-even markers), portfolio P&L
      (waterfall), company valuation (rate × growth heatmap), backtest (reader-supplied OHLCV, price
      with signal markers, equity and drawdown on one crosshair), scenarios (spot × volatility heatmap).
- [x] New calculators: technical indicators (candlesticks with overlays and oscillator panes on
      reader data), risk (VaR/ES with tail-shaded distribution and drawdown), bond pricing
      (price–yield curve with duration tangent), volatility smile (quotes plus fitted model).
- [x] Every calculator's first-call and full-reproduction copies join the installed-artifact
      gate at default and edited inputs; the release fingerprint covers all of them.
- [x] Assumptions and diagnostics render as readable definition lists and warnings, with the raw
      JSON still available.

### W4 — Charts

- [x] Line/area, candlestick + volume + overlays + oscillator panes, heatmap, histogram, waterfall,
      bar; crosshair tooltip; keyboard navigation; synchronized panes; markers and shaded regions.
- [x] Each chart has an accessible name, a summary, and an exact-value table; no `NaN`/`undefined`
      in output; flat and empty ranges handled.

### W5 — Data input

- [x] Paste, upload and sample selection for CSV/TSV with header detection, column mapping,
      date parsing, row-numbered errors, row limits and a preview. Pure parser module, unit tested.
      Columns map automatically by header name (common export spellings) and the mapping is
      reported ("Columns used: date ← "Date", …"); the preview shows the first and last rows
      exactly as the calculator reads them.

### W6 — Reference

- [x] Every public entry point and export path keeps a stable URL and anchor (coverage gate).
- [x] Entry-point pages group exports by kind with summaries; signatures highlighted and wrapped;
      members as tables with units/defaults (“not declared” stays explicit); large contracts split
      into bounded pages; JSDoc examples highlighted with copy.
- [x] Reference JSON twin per entry point.

### W7 — Search

- [x] ⌘K dialog over the deterministic engine; one lazy index load with retry; stale-result
      protection; keyboard selection; full-page search route preserved.
- [x] All existing ranking assertions pass against the real generated index.

### W8 — Agent surfaces

- [x] Markdown twin for every page; `llms.txt`, `llms-full.txt`, `llms/<domain>.txt` each linked
      from the index, with domain bundles under a stated size budget.
- [x] Copy page / Open in Claude / Open in ChatGPT actions.
- [x] Docs MCP handler with tests using the official MCP client; local preview route; host adapter.
- [x] WebMCP calculator tools generated from the typed schema.

### W9 — Live code

- [x] Editable first-call examples run in a sandboxed opaque-origin frame + worker against
      browser bundles of the built package; console output displayed; never auto-run from a URL.
      All 193 browser-safe public entry points import; the three Node-only ones are refused by
      name. A run stops after 10 s or 500 lines; typed errors show their code, context and line;
      an unchanged example confirms it reproduces the page's documented output.

### W10 — Versions, SEO and security

- [x] Version label, release ledger and archive restoration preserved; pinned snapshot emitted.
- [x] Canonical URLs, sitemap, robots policy and Open Graph metadata; explicit indexing policy.
- [x] Per-page script-hash CSP; host header configuration documented and tested.

### W11 — Verification

- [x] Site tests: build/routes/links/anchors/size budgets, search ranking, playground contract,
      copied examples, data parser, chart scales, Markdown twins, MCP, CSP, version snapshot.
- [x] Root tests that consume site modules (packed consumer, site-example smoke) updated and green.
- [x] Real browser review (desktop, mobile, keyboard, dark mode) with screenshots.

### W12 — Hosting handoff

- [x] `site/README.md` and the host configuration describe build, preview, headers, rewrites,
      the MCP function and the main-app multi-zone rewrite. Nothing is deployed.

## Amendment A — agents up front (2026-10-15, requested by the maintainer)

The maintainer asked for the docs to be "way more forward about connecting this to AI agents", and
to be ready to document a remotely hosted MCP server without promising one.

- [x] One setup model (`site/src/agents.ts`) produces exact, tested setup for Claude Code, Claude
      Desktop, Cursor, VS Code, Codex, Windsurf, Gemini CLI and ChatGPT: commands, config files
      and one-click install links (Cursor, VS Code), each checked in `test/agents.test.ts`.
- [x] The calculations MCP is presented truthfully: `@insiderfinance/totalfinance-mcp` is not on
      npm (registry 404 on 2026-10-15), so setup points at a source build and offers no install
      link until a release is verified; then it becomes a pinned `npx` command automatically.
- [x] Agents appear in the header (Connect AI), the hero, a section right after the stats, a new
      `/agents` landing (the previous page is now `/agents/handbook`), every calculator (**Ask
      your AI agent**: the MCP tool, its profile and a prompt from the reader's inputs), the page
      menu, every Markdown twin and the top of `llms.txt`.
- [x] Remote-ready: `TOTALFINANCE_DOCS_HOSTED_MCP_URL` (and optionally
      `TOTALFINANCE_DOCS_HOSTED_MCP_KEY_URL`) adds a hosted calculations option everywhere. Unset,
      nothing mentions one. The hosted docs MCP reports the real package version and refuses
      request bodies over 1 MB before parsing.
- [x] Corrected claims: the home page no longer shows an unpinned `npx` command for an unpublished
      package or says all operations are on by default (23 of 46 are).

Hosting the calculations MCP itself remains out of scope. It speaks stdio only, its compute is
synchronous with post-hoc deadlines, and the repository's roadmap requires authentication,
tenancy, quotas and CPU isolation before any hosted endpoint
([`roadmap.md`](../roadmap.md), "Hosting the MCP").

## Amendment B — home page positioning (2026-10-15, requested by the maintainer)

The maintainer judged the original hero line uncompelling and a problem-first rewrite cheesy, and
set the positioning: most quant work is forced into Python or unmaintained npm packages;
TotalFinance is the complete, fast, fully TypeScript library with agents as a first-class
consumer. The hero now reads "The complete quant library for TypeScript and AI agents", shows one
calculation as library code and as the `totalfinance_option_greeks` MCP tool call (both computed by
the library at build time), and a pillar strip states Complete (domains, exports), Fast (1,000,000
options with Greeks in 86 ms, measured with `blackScholesPriceMany` on an Apple M4 with Node 26 and
footnoted), TypeScript-native (no runtime dependencies) and Agent-ready (MCP tools). The "Sound
familiar?" section pairs four reader pains with what the library does. Title, description and
social image match. GitHub is prominent ("Star on GitHub" in the header, hero, a closing band,
the sidebar and every docs page; the build-time star count appears from 100 stars, and an offline
build simply shows no count). The licence moved out of the hero and sidebar to the footer, which
amends Decision 4's "licence visible".

## Completion record

**2026-10-15, local, uncommitted working tree on `totalfinance/session-24287e` (base `b678363`).**
Nothing is deployed or published. Evidence below is from the final source unless stated.

What exists (by workstream): a Next.js 16 / Fumadocs 16 / Tailwind 4 static export in the
InsiderFinance API-docs look with a full dark theme (W1); home, start-here, concepts, 24 domain
overviews, every public guide from `docs/guides/` and the agent handbook (W2); ten calculators on
one typed control schema, six upgraded and four new, with reader data (W3, W5); purpose-built SVG
charts with crosshair, keyboard navigation and exact-data tables (W4); the complete reference with
stable anchors and JSON twins (W6); the ⌘K dialog over the unchanged ranking engine (W7); Markdown
twins, `llms.txt`, bounded per-domain bundles, page actions, the docs MCP endpoint and WebMCP tools
(W8); **Edit and run** (W9); the version snapshot, explicit indexing, per-page script-hash CSP
and host headers (W10); hosting and multi-zone notes in `site/README.md` and `site/vercel.json`
(W12).

Decisions taken during implementation (all Agent, within this authorized contract):

- Decision 1 amended: a separate pnpm project instead of a workspace package (no root lockfile
  churn).
- Decision 2 amended: clean URLs. The InsiderFinance app (Next.js 14.2) redirects `/x/` to `/x`
  before rewrites, which would loop with a trailing-slash zone (verified in
  `next/dist/lib/load-custom-routes.js` and by proxying through the app). No route ends in
  `/index`, because clean-URL hosts redirect it; the package-root reference page is
  `/reference/totalfinance`.
- Live code: a classic worker inside the opaque-origin frame, because Chromium refuses a module
  worker from a blob there (probed); the frame's CSP names its serving hosts, because WebKit
  matches `'self'` to nothing in an opaque origin (probed); classes keep their names in the
  runtime bundles so errors read `InputError`, not a minified name.
- The sidebar scrolls its list directly instead of calling `scrollIntoView`, which in Chromium
  moved the Tab starting point past the skip link (found in the browser review, fixed, re-verified).
- `displayValue` now shows NaN and infinities (a pre-existing marker bug printed
  `"\u0000NaN\u0000"` in the client-side full-result view; regression-tested).

Verification:

- `pnpm site:build` (with the snapshot): 575 routes, 574 Markdown twins, 6,959 export paths, 46
  operations, 193 runnable entry points (3.9 MB of split bundles); `site/dist` is about 620 MB.
- `pnpm site:test`: 14 files, 195 tests passed (after Amendment A).
- `pnpm site:typecheck`, `next build` type checking and ESLint on `site/`: clean.
- Root suites that consume site modules (`tools/packed-consumer.test.ts`,
  `tools/preview-surface-audit.test.ts`, `docs/guides/imports-and-bundles.test.ts`,
  `tools/docs-conformance.test.ts`, `tools/manifest/contract-conformance.test.ts`):
  5 files, 327 tests passed. `pnpm docs:update` regenerated the docs inventory (237 surfaces, 0 findings).
- Real browsers (Playwright Chromium and WebKit 26.4, local preview): every calculator page
  renders without console errors; Edit and run reproduces the documented output (`price-an-option`
  2.3908769595711306, `measure-risk`); a negative spot shows `InputError [input.negative_spot] ·
line 12`; `fetch`, `window`, `document`, a URL import and an endless loop are all refused or
  stopped (10 s) in both engines; dark mode on home, calculator and reference pages; no horizontal
  overflow at 390 px on five page types; the first Tab reaches the skip link; ⌘K search opens the
  top result.
- Multi-zone: the InsiderFinance app (`next dev`, Next.js 14.2.3) with its zone switch pointed at
  the local preview serves pages, assets, Markdown negotiation, the MCP endpoint, 404s and the
  version snapshot under `/docs/totalfinance`, with at most one redirect for a slashed URL.

Not done here, and why:

- Full local `pnpm run ci` and the hosted full run: `.github/workflows/totalfinance-ci.yml`
  changed, so a full hosted run is required before landing (CONTRIBUTING fast-PR/full-gate
  policy).
- Firefox, a real host, and WebMCP in a browser that ships it: host checks for the maintainer
  before deployment (`site/README.md`, Maintainer handoff).
- Deployment, the docs domain and the main app's zone switch: maintainer-held. The app-side
  change is a separate InsiderFinance app branch, off by default; its open security decision
  (the docs run on the signed-in origin) belongs to the maintainer.
- Indexing stays `noindex` until a release receipt is imported; `releases.json` is empty, so the
  site labels itself "Development · unpublished".

## Preserved guarantees

The public site never shows the internal tracker, never implies publication from a package version,
never infers an undeclared default, never presents synthetic samples as market data, and keeps the
complete-coverage, search-ranking, copied-example, version-snapshot and size gates. Gates may move
with the implementation; none may be weakened to pass.

## Out of scope

Publishing packages, changing release versions, deploying the site, configuring DNS, analytics,
remote/hosted finance computation, live market data and brokerage access.
