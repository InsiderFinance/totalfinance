# TotalFinance homepage and developer documentation

This static TypeScript site uses the original task-first TotalFinance homepage and public developer
workbench layout, with real, local library calculations. No API keys, remote compute, market feeds,
brokerage access, analytics beacon, or account sign-in is required. Publishing decisions still
belong to the maintainer.

## Build and preview

From the repository root, select Node from `.nvmrc` and pnpm from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm site:typecheck
pnpm site:build
pnpm site:test
pnpm site:dev
```

The preview binds only to `http://127.0.0.1:4173`. Rebuild after source changes; the server serves
`site/dist` without a development framework or hidden hosted service. Stop it with Ctrl+C.

- Homepage: `http://127.0.0.1:4173/`
- Documentation: `http://127.0.0.1:4173/docs/totalfinance/`
- Example: `http://127.0.0.1:4173/docs/totalfinance/learn/price-an-option/`
- Search: `http://127.0.0.1:4173/docs/totalfinance/search/?q=black+scholes`

## Routes and hosting handoff

Follow the numbered [deployment runbook](../docs/runbooks/deploy-totalfinance-site.md) for Vercel,
DNS, preview review and the separately pending InsiderFinance integration. The checked-in root
`vercel.json` serves `site/dist` and calls `site/vercel.sh` for the exact Node/pnpm versions already
selected by `.nvmrc`/`package.json`. No package version or supported Node range is changed.

The original homepage lives at `/`, retaining its sidebar, task cards, copy and calculator; only
the logo and brand colors change. The documentation copy, including its assets, search index,
reference coverage, machine-readable discovery and version snapshots, lives under `/docs/totalfinance/`.
`paths.ts` owns that mount. The homepage's example is the exact option-playground first call;
its displayed price and chart come from that same calculation, not a second implementation.

InsiderFinance's separate product landing page is planned for `/totalfinance` in the app repo. Its
future rewrite should forward only `/docs/totalfinance/:path*` to the same path on this build's
deployment origin. The origin must serve those files directly, rather than forwarding them back to
InsiderFinance. The complete docs HTML is served by the rewrite; it does not inherit the app's shell.
Production domain selection, cross-domain homepage links, canonical URLs/sitemaps and the external
rewrite are separate integration work. This local split configures none of those services.

Deploy **only `site/dist/`**, using a static host with directory-index routing and `404.html` fallback.
Do not use an SPA fallback that returns the home page for unknown reference URLs. Enable HTTPS and
Brotli/gzip compression. HTML, version manifests, and search indexes should revalidate; immutable
version snapshots may be cached permanently once released. Hashed JavaScript chunks may be immutable;
`client.js`, `calculation-worker.js`, and `styles.css` are not content-hashed and must revalidate.
Suggested security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
There are no inline scripts or styles requiring an unsafe-inline exception.

## Content and ownership

- `build.ts` and `src/styles.css`: the original shared homepage/docs renderer and layout. The root
  homepage uses the original workbench content; no separate marketing renderer or stylesheet exists.
- `brand/`: original supplied PNG, editable vector recreation, favicon/Apple icons and social card.
  See [asset sources and regeneration](./brand/README.md). The site build copies the reviewed exports.
- `content/`: task-first starting and agent guides. Other public guides come from `docs/guides/`.
- `src/playgrounds/`: six calculators. Every financial operation delegates to a package API.
  `controls`, displayed results, chart data, warnings, and copied TypeScript describe the same input.
  Samples are hypothetical, not a data adapter or a claim of profitable backtest results.
- First-call examples show explicit sample inputs, the useful call, and its actual output. If a
  report is projected to selected fields, say so; do not imply that projection is the return type.
  Put larger literal datasets in expandable setup with a preview. The copy button includes setup
  and imports. Full chart reproduction stays separately expandable and copyable. Do not replace
  `Array.from` with a loop merely to hide it: separate demonstration setup from the calculation.
- `tools/public-reference.ts`: export maps + TypeScript checker/JSDoc generate all packages,
  entry points, types, members, signatures, source examples, and operation metadata. No curated API
  list can silently omit a new export. Large namespaces get complete bounded field pages.
- `src/search.ts`: deterministic task/API/type/operation search. Identical re-exports share a hit;
  their import paths remain indexed and all have independent reference pages.
- Public reference defaults are only declared JSDoc defaults. Missing annotations are explicitly
  labeled; no financial convention is guessed from an optional TypeScript property. Source examples
  may be illustrative excerpts; the six complete playground examples carry installed-package proof.
- `llms.txt`, `llms-full.txt`, `operation-catalog.json`, `openapi.json`, and `reference-coverage.json` provide
  machine-readable discovery without forcing every tool or SDK export into an agent's context.

The optional browser `document.modelContext` integration exposes the current calculator only. It
uses the same validated action and visible state as the form. Unsupported browsers retain the full
interface. Mock contract tests are not supported-host WebMCP certification. No server capability or
trade authority can be obtained through this integration.

## Verification and releases

`pnpm run ci` includes site typecheck, build and focused tests. The existing packed-consumer and registry
smoke workflows also compile every copied playground example in strict NodeNext and bundler modes,
then run it against the **installed artifacts**, comparing the full displayed result and chart data.
Both first-call and complete-playground copies are tested at default and edited inputs (24 cases).
The release fingerprint covers all 24, including the exact sample setup. Unit/source tests are
separate from packed proof; never exclude a new copy surface from the installed-artifact gate.

`releases.json` intentionally starts empty. A package version is not proof of publication. After an
authorized public npm release passes the registry smoke, import its retained receipt:

```sh
pnpm site:record-release /absolute/path/to/smoke-receipt.json stable
pnpm site:build
pnpm site:test
```

For `0.1.0`, `stable` denotes a version without a prerelease suffix in the evidence ledger,
not a 1.0 API-stability guarantee; the public label remains **Pre-1.0 release**. Use `preview` for
versions with a prerelease suffix. Import only after maintainer-authorized publication of both
`@insiderfinance/totalfinance` and `@insiderfinance/totalfinance-mcp`. The importer refuses a local tarball
rehearsal, dirty source, mismatched expectations, wrong version, or changed copied examples. The site
also checks package-source equality with the receipt commit. Changed source stays labeled development
even if someone forgot to bump the package version. This command does not publish or deploy anything.

Preserve `site/dist/docs/totalfinance/versions/<version>/` as an immutable build artifact for each actual release.
For later builds, restore those directories into an archive root and set
`TOTALFINANCE_DOCS_ARCHIVES=/absolute/path/to/archive-root`. The build copies the original pages, assets,
search and version manifest; it does not regenerate historical docs from current source. Published
builds refuse missing earlier verified snapshots. Local development can omit the archive cache.

## Agent evaluations

The maintained 110-case corpus and scorer live in `tools/agent-experience/`. Run:

```sh
pnpm agents:score /absolute/path/to/recorded-runs.json
```

This scores actual supplied recordings; it does not call a model or place trades. Missing runs,
unreviewed safety, first-call validity, recovery, and invented data are reported separately. An
illustrative recording is never a model benchmark. See that directory's README for the exact schema.

## Maintainer handoff

Use `docs/implementation-order.md` for the internal queue. Public learners start at
`/docs/totalfinance/`; the standalone homepage is `/`.
Before deployment, perform a real browser/keyboard/mobile review and a supported-host WebMCP check
where available. The original workbench implementation had no browser signoff. During the homepage
split, Ri's browser refused loopback preview URLs; visual/mobile/keyboard and supported-host checks
remain explicitly unverified. Domain, public repository, npm rights,
release approvals and actual deployment remain maintainer-held.
