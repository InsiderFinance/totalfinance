# TotalFinance homepage and documentation routing

## Current follow-up: compact documentation chrome (2026-11-12)

The maintainer requested one brand block in the top left, a version/GitHub/npm resource row, and
“View Docs” in the shared navigation. Keep the global header's brand and remove the sidebar's
duplicate logo, name and byline. Link the compact version badge to the versions page and remove
the redundant sidebar-footer GitHub link. The docs mount remains `/docs/totalfinance` on both hosts
so one build can be proxied by InsiderFinance without remapping its compiled links and assets.
Document that reasoning and use the canonical `www` origin in the rewrite example.

- [x] N1: One brand block; version, GitHub and npm grouped above the docs-area tabs.
- [x] N2: “View Docs” links from the marketing homepage to the docs start page.
- [x] N3: Explain the shared prefix; pass the build, typecheck and existing site checks.

Local verification on Node 22.23.2/pnpm 10.32.0: the 578-route static build, all 202 site tests,
30 documentation checks, site types, changed-source ESLint and formatting pass. The generated
documentation inventory is unchanged. The preceding main commit `3555f93` passed all 23 hosted jobs.
No docs mount, SDK source, dependency graph or package version changed.

## Current follow-up: navigation, copy and palette (2026-11-12)

The maintainer requested “finance” in the marketing headline, removal of the unlaunched Discord
bot link, a better name than Domains with an always-visible list, less green in code blocks, and
README docs links to the upcoming InsiderFinance host plus a linked By InsiderFinance credit.
The recovered docs are ported content: generated reference coverage and authored guide depth are
different claims. Do not present curated overview cards as a complete set of guides.

- [x] U1: Use the finance headline; remove Discord; label the overview section Library and keep its links expanded.
- [x] U2: Use neutral charcoal code panels and a balanced syntax palette, retaining green as a brand accent.
- [x] U3: Point README documentation/LLM links at the intended InsiderFinance prefix and add the linked credit.
- [x] U4: Clarify overview-to-reference navigation; preserve all export coverage, LLM artifacts, routes and checks.

The `/domains/*` routes and internal identifiers remain stable. The live site's source-host links
continue working until the separate InsiderFinance rewrite launches; README URLs intentionally
name the upcoming public docs host. No library calculations, public package versions or dependencies change.

Local verification on Node 22.23.2/pnpm 10.32.0: the build preserves 578 routes, 577 Markdown twins,
197 public entry points, 6,967 export paths and 48 operations. All 202 site tests and 42 targeted
documentation/example tests pass, along with site typecheck and changed-source ESLint. Documentation
regeneration leaves the inventory unchanged. Both LLM artifacts are generated; the source-host index
and full bundle returned HTTP 200. These counts include types and re-exports, not 6,967 unique functions
or authored guides. The 24 module overviews now separate common APIs from complete generated reference
links. Authored tutorial depth remains the ported content; no new comprehensive guide coverage is claimed.

**Current correction (2026-11-12):** the requested original is the uncommitted Next.js/Fumadocs
site in worktree `totalfinance-24287e`, whose hero reads “The complete quant library for TypeScript
and AI agents.” It is governed by [the recovered original contract](./developer-docs-v2.md).
The pre-`7c1e932` workbench restored below was the wrong page; that verification is historical.
Recover the original site's authored frontend and isolated dependency project, preserve its layout
and copy with the supplied logo/green brand palette, and serve its marketing page at `/`.
Keep the docs mounted at `/docs/totalfinance` and remove release-status banners from the header,
hero and sidebar. Release evidence and version-page details retain their existing semantics.

- [x] M1: Recover the actual original marketing frontend and its dependent components/calculators.
- [x] M2: Apply the supplied logo/colors and omit prominent development/unpublished labels.
- [x] M3: Serve the homepage at `/`; verify docs/assets/agent files and actual 404s through the mount.
- [x] M4: Pass the recovered site's tests/build, installed-example checks, lint and documentation regeneration.
- [x] M5: Verify hosted checks and inspect the corrected public homepage after integration.

Local recovery evidence (Node 22.23.2/pnpm 10.32.0): the marketing page body is byte-identical to
the original after removing its status paragraph and substituting one brand accent. The original
components, styles, self-hosted fonts, ten calculators and source-owned build pipeline are recovered.
The root serves that marketing page; the docs entry redirects to `/docs/totalfinance/start`.
Site build: 578 routes, 577 Markdown twins, 6,967 export paths and 48 operations, including the
self-contained version snapshot. All 198 site tests pass; 13 preview/host tests pass again after
the final routing adjustment. Root/site types, changed-source lint and 75 documentation/import
checks pass. All 40 exact default/edited first-call/full examples typecheck and execute against
installed tarballs. Documentation regeneration reports 248 surfaces, zero findings. Library
sources, public package versions, the root dependency graph and release evidence are unchanged.

Hosted and production verification:

- Recovery commit `3c7f1a411b96d287dcd2e470ba97b50283066049` passed all **23 full hosted jobs**
  [before landing](https://github.com/InsiderFinance/totalfinance/actions/runs/43272009110) and
  [on main](https://github.com/InsiderFinance/totalfinance/actions/runs/43274168756).
- The production homepage at `https://www.totalfinance.io/` shows the original marketing hero,
  supplied logo and green branding, with no development/unpublished header or hero banner. Real
  browser review at 1200px passed in light/dark themes with loaded fonts and no horizontal overflow.
  Changing volatility from 20% to 25% updated the live option price from $2.39 to $3.35; Get started
  opened `/docs/totalfinance/start`; keyboard activation of the skip link focused the main landmark.
- Eight production page/asset checks passed, including the docs-entry redirect, API reference,
  `llms.txt`, SVG icon and PNG social card. An unknown docs URL returned a real 404.
- Follow-up `9ac5181` finishes the remaining calculator accents and fixes the recovered docs MCP's
  emitted-ESM startup. A cold Node reproduction failed on the old extensionless import and passed
  after the repair. The 201-test site suite and the expanded four-test hosted-entrypoint suite pass,
  along with site types/lint. Production initialization reports `totalfinance-docs` version `0.1.4`,
  and a real `search_docs` call returns the current Black–Scholes reference. This endpoint reads
  documentation only; hosted financial computation remains separate.

M1–M5 are complete. H4 below is the historical full mobile/supported-WebMCP review item; those checks
were not freshly repeated in this recovery. No SDK/MCP package publication, version bump, DNS or
InsiderFinance-app change was made.

**Controlling correction (2026-11-12):** the maintainer rejected the new marketing homepage and
requested the original landing page from before the docs separation, changing only its logo and
brand colors. Restore the pre-`7c1e932` task-first content/layout at `/`; retain the existing docs
mount, logo/favicon/social assets and deployment configuration. The original implementation record
below is historical where it describes a replacement marketing page.

Correction acceptance:

- [x] R1: The original homepage content, sidebar, task cards and calculator appear at `/`.
- [x] R2: Remove the replacement marketing renderer/stylesheet; reuse the original page body/layout.
- [x] R3: Visual changes from the original are limited to the supplied logo and green brand palette.
- [x] R4: Verify source parity with the pre-change homepage and pass site build/type/link checks.

Correction verification on Node 22.23.2/pnpm 10.32.0: compared source against `7c1e932^`.
The homepage template matches exactly; the shared body layout differs only by the logo element;
CSS matches after excluding the logo rule and color values. The root and docs index reuse the same
body, with docs links mounted under `/docs/totalfinance/`. The replacement marketing renderer and
stylesheet are removed. The site build, typecheck, changed-source lint, **82 site tests** and
**30 documentation tests** pass. Documentation regeneration reports **247 surfaces, zero findings**
and leaves the generated inventory unchanged. H4's separate rendered-site review remains open.

Status: authorized local implementation, 2026-11-11. This is the bounded homepage separation
requested by the maintainer after reviewing the three-surface hosting proposal.

## Outcome

A standalone TotalFinance homepage introduces the TypeScript library at `/`. The existing developer
workbench remains complete under `/docs/totalfinance/`, ready for a later InsiderFinance rewrite.
InsiderFinance's own product landing page will use `/totalfinance` in its separate app.

## Decisions and non-goals

1. Keep the static TypeScript generator and existing dependencies. Build the homepage and docs into
   `site/dist`; do not introduce a framework, remote service, analytics or account requirement.
2. The homepage explains capabilities, shows the existing executable option-pricing example and its
   real result, and links to tasks, guides, reference and GitHub. Reuse the existing example covered by
   installed-consumer tests; do not add another financial calculation or copied-code contract.
3. Mount documentation HTML, assets, form actions, search and reference URLs, machine-readable links
   and current version snapshots under `/docs/totalfinance`. Keep release archives byte-preserved.
4. Preserve the documentation's task-first interface, units, assumptions, diagnostics, release labels,
   complete generated reference and existing size budgets. Homepage styling stays separate.
5. Add no InsiderFinance app page, external rewrite, production domain, canonical origin or deployment
   in this slice. Do not publish, bump versions or manufacture release evidence.
6. Use responsive, accessible static markup. No image asset is necessary: actual code and a financial
   chart explain the product. Verify the rendered homepage and a representative docs journey locally.

## Ordered slices and exit gate

- [x] H1: Add the standalone homepage with meaningful documentation and repository links, the existing
      first-call example, and a result/chart derived from the same library calculation.
- [x] H2: Relocate the workbench and its generated discovery artifacts to `/docs/totalfinance/`;
      current and pinned navigation/search/assets resolve without using another domain's root.
- [x] H3: Verify the complete generated route/link/reference checks, homepage/example correspondence,
      existing client/playground/release tests, site typecheck and changed-file format/lint.
- [ ] H4: Complete available browser review, update preview/hosting instructions and record exact local
      evidence and remaining hosting work. Hosted CI and deployment are separate evidence.

## Verification record

Local implementation on the session worktree based on `ca122ab3115e`, using Node **22.23.2** and
pnpm **10.32.0**. No hosted or production result is claimed.

- `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm site:typecheck`, `pnpm site:build` and
  changed-source ESLint/Prettier checks pass. Dependency versions and release manifests are unchanged.
- `pnpm site:test`: **81 tests / 8 files pass**. Generated link checks now cover the homepage and
  both current and pinned documentation: **2,005 routes**, **6,967 export paths**, **48 operations**.
  Existing HTML/client/search budgets remain enforced without changed thresholds.
- `pnpm docs:update` regenerates the documentation inventory with **zero findings**;
  **30 documentation conformance/generated-document tests pass**. The field reference is unchanged.
- The targeted packed-consumer test `strictly typechecks and executes all 24` passes. All **24**
  exact default/edited first-call/full-playground copies compile under strict NodeNext and bundler
  resolution and execute against installed tarballs. The homepage regression requires the exact
  existing first-call code, output and chart rather than adding an untested copied example.
- Local HTTP checks pass for **13** homepage/docs/assets/discovery/pinned routes. Unknown docs
  reference pages and the retired root `/reference/` return **404**, not the marketing homepage.
- H4 remains open for visual/mobile/keyboard review: Ri's browser rejected navigation to
  `http://127.0.0.1:4173/` with `unsupported: Refusing to browse a private or loopback address`.
  No rendered-browser or supported-host WebMCP result is claimed. Build/preview and future
  InsiderFinance rewrite instructions are updated in `site/README.md`.

The InsiderFinance app, domain setup, cross-domain/canonical integration, deployment, package
publication, release versions and existing release-evidence ledger were not changed. The normal
changeset records this website change for later maintainer-controlled release preparation.

## Branding and deployment handoff amendment (2026-11-12)

The maintainer supplied three PNG logo variants and requested their inclusion, favicons, an Open
Graph image, an SVG asset if useful, and step-by-step deployment directions. This authorizes local
asset/configuration work; it does not authorize deployment or changes to the InsiderFinance app.

Decisions:

1. Preserve a supplied transparent PNG as the original artwork. Add a clean, editable SVG redraw of
   the same code-brace/ascending-bars mark, with an explicit recreation label rather than claiming it
   is the original vector. Use that mark in the homepage and documentation instead of the temporary TF.
2. Maintain SVG sources for the logo, favicon and 1200×630 social card. Export PNG favicons, an ICO,
   Apple touch icon and social-card PNG from those sources with a documented, pinned optional tool.
   Site builds copy checked-in assets and require no image service or extra runtime dependency.
3. Publish icons and the social image with the homepage and under the docs asset mount; preserve
   those assets in current version snapshots. Add appropriate favicon/Apple/OG/Twitter metadata,
   using `https://totalfinance.io` for absolute image URLs. Do not invent an InsiderFinance launch.
4. Add a static Vercel configuration and a small build wrapper using `.nvmrc` and the existing pnpm
   pin. The broad package engine range must not silently override the canonical build runtime.
5. Write a numbered deployment runbook covering Git/CI, a preview deployment, domain/DNS, alternate
   domains, and the separately pending InsiderFinance landing/rewrite/canonical integration. Include
   real-browser checks and a 404 check. No credential, deployment or release-version change.

Acceptance:

- [x] B1: Original reference, SVG logo and favicon/social exports exist; inspect the rendered assets.
- [x] B2: Homepage/docs branding and metadata resolve through the docs mount and version snapshots.
- [x] B3: Static deployment settings, pinned-runtime build wrapper and step-by-step guide agree.
- [x] B4: Site build/typecheck and focused route/metadata tests pass; regenerate affected doc inventory.

Local verification on 2026-11-12:

- Rendered and inspected the exported 512px icon and 1200×630 social card. SVGs parse with unique
  IDs; no embedded raster is used in the logo. The original supplied transparent PNG is preserved
  byte-for-byte. ICO has 16/32/48px images; the Apple icon is opaque 180×180.
- Both exact Vercel commands, `bash site/vercel.sh install` and `bash site/vercel.sh build`, exit 0
  using Node 22.23.2/pnpm 10.32.0. Frozen install leaves the dependency graph unchanged. The build
  contains the same 2,005 routes, 6,967 export paths and 48 operations.
- Site typecheck and changed-source ESLint pass. `pnpm site:test`: **82 tests / 8 files pass**,
  including metadata, actual PNG/ICO format/dimensions, mounted/versioned icons, and byte-preserved
  archived SVG/PNG/ICO assets. Existing numerical examples and public package inputs are unchanged.
- Eight local branding HTTP routes return 200 with the correct MIME type; an unknown docs reference
  returns 404. Full site visual/mobile/keyboard review remains unverified under H4; exported-asset
  inspection is not that review. No hosted deployment or real social-crawler result is claimed.

- `pnpm docs:update` regenerates the documentation inventory: **245 surfaces, zero findings**.
  All **30 documentation conformance/generated-doc tests pass**. Changed-file Prettier (including
  explicit SVG formatting), source ESLint, shell syntax and `git diff --check` pass.

B1–B4 are locally complete. H4's separate rendered-site review stays open.

### Social-card copy follow-up (2026-11-12)

The maintainer requested a stronger social-card tagline and an explicit developer/agent and
TypeScript/portability message. Update the SVG source and generated SVG/PNG to read:

- “The most complete finance toolkit.”
- “For developers and AI agents.”
- “Built with TypeScript. Run anywhere.”

Keep the homepage sharing title/description and image alt text consistent. Preserve all three
supplied PNG variants in the source directory; the tight transparent PNG remains the original used
for the vector recreation. This is a local copy/asset follow-up, with no deployment or package change.

Local verification: regenerated SVG/PNG inspected at 1200×630; all three source PNGs match the
attachments byte-for-byte. Site build/typecheck, changed-source lint/format, all seven built-site
regressions and the documentation-inventory consistency check pass. The built sharing title,
description and OG image match the revised sources. This records local verification; hosted CI and
site deployment remain separate.

### Main integration and commit authorization (2026-11-12)

The maintainer explicitly requested “Commit and push to main.” The site change is integrated over
upstream `e588c9c1e222abecf36c9652ff6c5833ef3b75e8` (0.1.4 release preparation), preserving its
numerical repairs, package versions, dependency lockfile and release tracking. The implementation
queue conflict retains both the upstream release record and the bounded site record.

Verification after integration, on Node 22.23.2/pnpm 10.32.0: frozen install, library/site builds,
site typecheck, changed-source lint/format, **82 site tests**, **30 documentation tests**, and the
targeted installed-consumer test covering **all 24 copied examples** pass. The affected docs
inventory was regenerated: **247 surfaces, zero findings**. Public library sources and release
metadata are unchanged relative to that upstream commit. The local `.env` is excluded from the
commit. Hosted CI and the rendered-site review remain separate from these local results.
