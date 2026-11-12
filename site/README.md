# TotalFinance marketing homepage and documentation

The original marketing homepage at `/`, plus the public developer docs: task-first guides, ten live calculators that run the library in the
browser, the complete generated API reference, and agent-first surfaces (Markdown twins,
`llms.txt`, per-domain bundles, a docs MCP endpoint and browser agent tools). It is a static
Next.js export. The marketing homepage is served at `https://www.totalfinance.io/`; the docs use
`/docs/totalfinance`, ready for InsiderFinance’s separate rewrite. The controlling contract is
[`docs/specs/developer-docs-v2.md`](../docs/specs/developer-docs-v2.md).

No API keys, accounts, analytics beacon, remote compute, market feeds or brokerage access. Every
calculation runs on the reader's machine; a reader's own data never leaves the page.

## Build and preview

From the repository root (Node ≥22.13, pinned pnpm):

```sh
pnpm install --frozen-lockfile
pnpm build            # the library the site imports
pnpm site:build       # installs site/ dependencies, generates, exports, post-processes → site/dist
pnpm site:test
pnpm site:dev         # http://127.0.0.1:4173/docs/totalfinance
```

The site is its own pnpm project (`site/package.json`, `site/pnpm-lock.yaml`), deliberately outside
the library workspace so Next.js, React, Fumadocs and Tailwind never re-resolve the library's
dependency graph. It consumes the **built** package through a link to `distribution/totalfinance`,
exactly as an installed consumer would. `pnpm site:install` installs it with the frozen lockfile;
`pnpm site:build` runs that first.

For iterative UI work, `pnpm --dir site dev` runs `next dev` (run `pnpm site:build` once first so
the generated inputs exist).

## How a build works

1. **Generate** (`scripts/generate.ts`, repository toolchain): the reference from export maps and
   the TypeScript checker, guides from `docs/guides/*.md`, search records, the operation catalog,
   per-entry-point JSON contracts and the version manifest. Outputs are git-ignored
   (`.generated/`, `content/generated/`, generated files in `public/`).
   `scripts/runtime.ts` then bundles every browser-safe public entry point of the built package,
   the TypeScript stripper (Sucrase) and the sandboxed example runner into `public/runtime/`
   (content-hashed, split so a run loads only what its imports reach).
2. **Export** (`next build`, `output: 'export'`): every page is prerendered. `next build` also
   type-checks the app (`app/`, `components/`, `lib/`); `pnpm site:typecheck` checks the
   framework-free modules (`src/`, `scripts/`, `mcp/`, `api/`, tests) under the repository's strict
   settings.
3. **Post-export** (`scripts/postexport.ts`): a Markdown twin for every page, `llms.txt`,
   `llms/<domain>.txt` (each must fit 400 KB or the build fails), `llms-full.txt`, a per-page
   Content-Security-Policy `<meta>` whose `script-src` lists only `'self'` and the SHA-256 hashes of
   that page's inline scripts, robots/sitemap per the indexing policy, the route inventory and the
   calculator catalogue.
4. **Snapshot**: a second export under `/docs/totalfinance/versions/<version>` (canonicals point at
   the current docs; never indexed). Verified earlier releases are restored byte-for-byte from
   `TOTALFINANCE_DOCS_ARCHIVES`. `TOTALFINANCE_DOCS_SNAPSHOT=0` skips the snapshot for quick local
   iteration only; tests require it.

### Environment

| Variable                               | Default                             | Meaning                                                                                                                                             |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOTALFINANCE_DOCS_BASE_PATH`          | `/docs/totalfinance`                | Where the docs live on their host.                                                                                                                  |
| `TOTALFINANCE_DOCS_ORIGIN`             | `https://www.totalfinance.io`       | Origin for canonical URLs, the sitemap and agent files.                                                                                             |
| `TOTALFINANCE_DOCS_INDEXING`           | `index` only for a verified release | `index` or `noindex`, explicitly.                                                                                                                   |
| `TOTALFINANCE_DOCS_FAMILY_API`         | unset                               | `1` shows the InsiderFinance API and MCP docs in the header (only when they are public).                                                            |
| `TOTALFINANCE_DOCS_FAMILY_ORIGIN`      | `https://www.insiderfinance.io`     | Where the family links point.                                                                                                                       |
| `TOTALFINANCE_DOCS_ARCHIVES`           | unset                               | Directory of preserved `versions/<version>/` snapshots of verified releases.                                                                        |
| `TOTALFINANCE_DOCS_PREVIEW_ORIGINS`    | unset                               | Extra hosts (comma-separated) that serve a preview, e.g. a tunnel; the example runner's CSP must name its host.                                     |
| `TOTALFINANCE_DOCS_HOSTED_MCP_URL`     | unset                               | An https MCP endpoint for hosted calculations. Set ⇒ every "Connect an AI agent" surface offers it first. Never set it before that endpoint exists. |
| `TOTALFINANCE_DOCS_HOSTED_MCP_KEY_URL` | unset                               | Where readers get an API key for that endpoint; set ⇒ setup includes an `Authorization: Bearer YOUR_API_KEY` header.                                |

## Content and ownership

- `content/docs/`: authored MDX (start, concepts, calculator explanations, domain overviews,
  agent pages). TypeScript blocks are executed by `test/docs-code.test.ts`.
- `docs/guides/*.md` and a few root documents are the single source for the Guides section;
  `scripts/guides.ts` rewrites their repository links and neutralizes links to non-public files.
  Edit the source, never `content/generated/`.
- `src/playgrounds/`: the ten calculators. Each is a framework-free module that calls public
  package APIs and returns a typed `Calculation`. One control schema (`number | select | table |
data`) drives the form, boundary validation (`src/playgrounds/inputs.ts`), shareable URL state,
  the browser agent-tool schema and the copied TypeScript. The React UI never computes finance.
- `src/data/`: the reader-data CSV/TSV parser and the deterministic **synthetic** samples. Samples
  are labelled synthetic everywhere and are never presented as market history.
- `components/charts/`: purpose-built SVG charts (line/area with profit-loss fill, candlesticks
  with overlays and panes, heatmap, histogram, waterfall, bars) with a crosshair, keyboard
  navigation and an exact-data table. Colours come from the validated palette in `app/global.css`.
- `src/search.ts`: the deterministic ranking engine with its regression tests;
  `src/search-controller.ts` drives the ⌘K dialog and the search page.
- `src/runner/` and `components/playground/run-example.tsx`: **Edit and run**. The reader's edited
  first call runs only on an explicit Run, in a hidden `sandbox="allow-scripts"` iframe
  (`runtime/runner`, an opaque origin that cannot reach the page, its cookies or storage), inside a
  worker that the iframe terminates after 10 s, too much output, a new run or Stop. The iframe's
  own CSP allows scripts only from these docs and no network (`connect-src 'none'`). Imports are
  rewritten to the docs' bundles; anything else (another package, a URL, a computed `import()`) is
  refused. Code never comes from or goes to a URL. `test/runner.test.ts` covers the protocol; the
  sandbox itself is verified in real browsers (see the spec's completion record).
- `src/routes.ts`: every route, canonical URL, sitemap entry and Markdown twin. Routes never end in
  a slash and never end in `/index` (see Hosting).
- `src/agents.ts`, `lib/agents.ts`, `components/agents/`: **Connect an AI agent**. One model produces
  the exact setup (command, config file, one-click install link) for Claude Code, Claude Desktop,
  Cursor, VS Code, Codex, Windsurf, Gemini CLI and ChatGPT, for each server this build offers: the
  calculations MCP (local; a pinned `npx` command once a release is verified, a source build
  until then), the hosted docs MCP, and hosted calculations only when
  `TOTALFINANCE_DOCS_HOSTED_MCP_URL` names an endpoint. The same model renders the home page
  section, `/agents`, the page twins and the MCP section of `llms.txt`. `src/playgrounds/agent.ts`
  maps each calculator to its MCP tool and builds the **Ask your AI agent** prompt from the
  reader's inputs; `test/agents.test.ts` checks every tool and profile against the catalog.
- `mcp/`: the stateless docs MCP server (`search_docs`, `read_page`, `get_reference`,
  `list_calculators`). It reads only the static export and never computes finance.

## Copied examples are release evidence

Every calculator has four copy surfaces (first call and complete program, at default and edited
inputs). `tools/site-examples-smoke.ts` derives them from the same definitions; the packed-consumer
and registry-smoke workflows type-check them in strict NodeNext and bundler modes and run them
against the **installed** artifacts, comparing every result; the release fingerprint covers all of
them. `test/playgrounds.test.ts` executes them against the source. Never exclude a new copy
surface from these gates.

## Hosting

Deploy only `site/dist/`, at the repository-root Vercel project, with the zone rewrites, clean URLs and a real `404.html` (never an
SPA fallback). A page `/learn/x` is the file `learn/x.html`; URLs never end in a slash (`/x/`
redirects to `/x`) or in `/index`. `vercel.json` is the reference configuration for a Vercel
project rooted at `site/` (`cleanUrls: true`, `trailingSlash: false`): static output from `dist/`,
the read-only docs MCP adapter (`api/mcp.ts` at the repository root) at `/docs/totalfinance/mcp`, `Accept: text/markdown`
negotiation (with `Vary: Accept`), immutable caching for hashed assets and runtime bundles, CORS
for the runtime bundles (the runner's origin is opaque), `noindex` for archived versions, and the
security headers a `<meta>` CSP cannot carry: `frame-ancestors 'none'` everywhere except the
runner, which only these docs may frame. HTML, manifests and indexes revalidate.

**Inside insiderfinance.io (multi-zone).** The main app redirects `/docs/totalfinance` to
`/docs/totalfinance/start`, then forwards `/docs/totalfinance/:path*` to this deployment with a
rewrite in its `next.config.js`. Use the canonical `www.totalfinance.io` source host; see the
[deployment guide](../docs/runbooks/deploy-totalfinance-site.md) for both rules. This site's
`TOTALFINANCE_DOCS_ORIGIN` controls the public origin. Clean URLs are required there: the
app's Next.js redirects `/x/` to `/x` before rewrites run, so a trailing-slash zone would
redirect forever. Readers and search engines see one site; the main domain's `/robots.txt`
governs crawling, and every page also carries its own robots meta tag. Under the zone, these
docs run on the signed-in InsiderFinance origin: deploy only from the protected `main` branch,
and keep project membership to maintainers. `TOTALFINANCE_DOCS_FAMILY_API=1` should be set only
once the InsiderFinance API and MCP docs are public in production.

Static size is about 0.65 GB with the version snapshot (Vercel's static upload limit is 1 GB);
the largest page is under 600 KB of HTML and any page loads under 240 KB of gzipped JavaScript.
`test/build.test.ts` enforces those budgets.

## Verification and releases

`pnpm run ci` includes the site typecheck, build and tests. The release fingerprint and the
version ledger work as before: `releases.json` starts empty, and a package version is never
evidence of publication. After an authorized public npm release passes the registry smoke, import
its receipt and rebuild:

```sh
pnpm site:record-release /absolute/path/to/smoke-receipt.json stable
pnpm site:build
pnpm site:test
```

Preserve `site/dist/versions/<version>/` as an immutable artifact for each actual release and set
`TOTALFINANCE_DOCS_ARCHIVES` for later builds. Published builds refuse missing earlier snapshots.

## Maintainer handoff

Domain, deployment, npm rights and release approvals remain maintainer-held; nothing here deploys
anything. Before deployment, repeat the browser/keyboard/mobile review on the real host, run an
**Edit and run** example there (the runner's CSP names the public origin and, on Vercel builds,
the deployment's own hosts), and check WebMCP in a supported browser (mock-free verification is a
host check, not a unit test).
