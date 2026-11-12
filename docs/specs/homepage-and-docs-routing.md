# TotalFinance homepage and documentation routing

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
