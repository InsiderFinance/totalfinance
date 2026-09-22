# Tree shaking and installed-consumer budgets

Status: **COMPLETE (local) 2026-09-21**, tested source commit
`d95634c3b65f50130d243c160cf9108822dd7095`. This bounded pre-freeze repair follows the standalone
migration and precedes the exact release rehearsal in `implementation-order.md`. This closeout
changes tracking documents only; it does not authorize a push, publication, or deployment.

## Outcome and constraints

Users can install one domain or the umbrella and bundle a small calculation without unrelated
domains. Preserve every public name, argument, result, diagnostic, validation boundary, type and
supported import. Do not replace the namespace API, introduce compatibility aliases, add runtime
dependencies, or require consumer-specific build plugins. No publication or deployment is authorized.

## Decisions

1. ESM and `sideEffects: false` stay. Public subpaths, not private `dist` paths, are the portable
   small-bundle contract. Named imports from `totalfinance/<domain>` and `@totalfinance/<domain>`
   must match their supported feature subpaths for the canaries below, within a small declared
   byte tolerance for identifier/minifier differences.
2. Preserve umbrella domain namespaces. esbuild's namespace re-export limitation
   (<https://github.com/evanw/esbuild/issues/1420>) is not fixed by pretending a namespace object
   has independently removable properties. Test and document the actual result alongside
   Rollup. Direct `import * as domain from 'totalfinance/<domain>'` with static member use is
   also covered; dynamic property access/namespace enumeration necessarily retains more code.
3. Reduce avoidable retained implementation without weakening safeguards. Pure annotations are
   permitted only on reviewed construction of unused library-owned wrappers/objects, never on a
   calculation, validation boundary, user callback, or observable registration. Keep shared error
   code identities stable and do not hand-maintain a second unchecked code vocabulary.
   Built-in technical indicators must carry their own validation/disclosure metadata: importing a
   leaf must not require the full discovery registry for correctness. Relocate declarations to
   statically imported private descriptors shared with discovery, preserving alias identities,
   effective conventions, dependent defaults, nullable defaults, and custom registration behavior.
   Verify the complete built-in catalog, not just the RSI size canary.
4. Installed-artifact tests pack and install real tarballs outside the workspace, resolve public
   package exports without source aliases, build with pinned development bundlers, and execute
   browser-targeted output without Node globals. Numerical parity and typed malformed-input
   refusals remain required after tree shaking. Bundlers are development-only dependencies.
5. Canary matrix: normal CDF, RSI, Black–Scholes facade and expert kernel; scoped root/feature,
   umbrella domain subpath, static direct namespace, and applicable root umbrella access.
   Assert byte budgets AND retained-module boundaries; an unused-library control emits no library
   code, while a dynamic/enumeration control proves the harness can detect retention. Do not count
   parsed-but-eliminated modules as retained. Keep existing whole-entrypoint budgets and distinguish
   them clearly from used-function consumer budgets.
6. Publish truthful guidance: installation size versus delivered bundle versus unbundled Node
   loading; named domain imports as the portable browser default; explicit, bundler-dependent
   namespace caveat; no claim of a bare formula cost for a facade with diagnostics/streaming.
   Generate measurements from the enforcing fixture record; never hand-maintain competing tables.

## Ordered checklist and exit evidence

- [x] TS1: reproduce current installed-artifact costs and establish cross-bundler consumer fixtures.
- [x] TS2: optimize reviewed, unused implementation construction; make all built-in indicator
      metadata independent of registry import; preserve public and runtime parity.
- [x] TS3: enforce size/boundary/import parity and misuse canaries against installed artifacts in CI.
- [x] TS4: update public import guidance, generated bundle report, changeset and controlling queue.
- [x] TS5: pass full CI, independent coverage repeat, API check and byte-stable regeneration;
      reconcile all completion claims with the tested revision. Hosted release gates remain separate.

Baseline (esbuild 0.25.12, packed runtime matching `7a505d4`): scoped normal CDF ~0.47 KiB versus
root `math.normalCdf` ~40.4 KiB; scoped RSI ~8.2 KiB versus root `technicalAnalysis.rsi` ~100.4 KiB;
facade and expert Black–Scholes both ~11.7 KiB. Rollup through Vite 7 eliminates the namespace
over-retention and yields ~2.3 KiB for the expert kernel. These observations motivate the repair;
they are not final budgets or promises for every bundler version.

## Implementation decisions and regression evidence

- The analytic facade factories are lazy: they allocate callable/`.explain()` pairs without invoking
  calculations, validation, or user callbacks. Reviewed construction annotations allow expert-only
  imports to discard these pairs; they do not annotate or disable the actual guards.
- Input/postcondition codes now have private named constants, reused by the public `ErrorCode`
  registry and lightweight guards. Public values, literal types, property order, error classes,
  serialized errors, and the export map remain unchanged. Four whole-registry entrypoints gained
  32–77 bytes beyond their old ceilings; their measured rationale and 128-byte ceiling adjustments
  are recorded in the existing budget source. Independent expert canaries enforce the much larger
  reduction for guard-only imports, rather than hiding it behind a whole-package budget.
- Installed misuse tests exposed a pre-existing indicator defect: metadata was attached only when
  the discovery registry ran. A lean RSI import could ignore an unknown parameter and omit convention
  disclosures. The correction covers all built-ins and must preserve the same behavior before and
  after registry initialization. Alias-specific discovery descriptions remain distinct from the
  effective runtime conventions of shared facade identities; this repair does not redefine aliases.
- Browser results cross the test boundary with numeric `NaN`, infinities, and negative zero intact.
  Negative controls prove that string spellings cannot satisfy numeric-result assertions.
- The catalog migration preserves all 335 registered names and 321 facade identities, including the
  prior effective alias conventions. Independent old-to-new catalog comparison found no declaration
  differences. The installed isolation gate exercises 22 public leaf bundles and 4,641 comparisons;
  it passes the correction and fails 2,665 comparisons against the prior runtime. The source-level
  companion covers 30 families/aggregators, delayed registry loading, and defensive defaults.

## Verification record

- Canonical Node 22.23.2: full `pnpm run ci` exits 0 — **559 library files / 12,360 tests**, **79 site
  tests**, all 25 API reports, format, lint, typechecks, build, site build, and coverage. Coverage:
  94.13% statements, 83.88% branches, 96.96% functions, 94.70% lines.
- The full packed-consumer file plus harness unit tests pass 234 tests on Node 22.23.2; the focused
  consumer matrix and harness pass 174 tests independently on minimum Node 22.13.0 and Node 24.21.0.
- Independent full Node 24.21.0 coverage repeat exits 0: **559 files / 12,360 tests**, with the same
  coverage percentages. It used a separate report directory. The standalone `pnpm api:check` also
  exits 0 on the committed implementation, confirming all 25 reports independently of full CI.
- `pnpm regen:check` exits 0 on canonical Node 22.23.2 in a fresh, clean checkout of the source
  commit above: the entire regeneration chain is **byte-stable**, and `git status` remains clean.
- Independent adversarial review found no additional defects. Old/new comparisons cover all 335
  names with two parameter sets and 280 inputs, including batch/explain, streams, snapshots,
  restoration and peek. All 51 existing technical-analysis declaration files are byte-identical.
- Required artifact regeneration completed; enforcement has **0 defective** candidates and the
  public declarations, signatures, contracts and enforcement artifacts remain unchanged. The
  generated bundle report records final installed measurements from the enforcing fixtures.
- Restoring leaf-local TA correctness adds metadata construction/copying: whole RSI measures
  8,842 bytes, workflows 508,947 bytes, and the all-exports umbrella 697,387 bytes on canonical Node
  and esbuild. Their measured ceilings are recorded in `tools/bundle-size/budgets.ts`. The lean
  installed RSI canary stays below 9 KiB, and all three expert price kernels stay below 2.5 KiB.

All TS1–TS5 requirements are locally complete. Next: the remaining organization/website acceptance
and exact versioned release rehearsal in `implementation-order.md`. Hosted release gates,
publication, and deployment remain separate and are not implied by these local results.
