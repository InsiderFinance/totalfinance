# Selective Greeks and exposure — compute only what is requested

Status: in progress (opened 2026-10-01). Authorized by the maintainer as a bounded amendment to the
published `@insiderfinance/totalfinance@0.1.0`. `implementation-order.md` owns its place in the
queue. This amendment does not authorize a version bump, npm publication, MCP expansion, site
deployment, or changes to any private application.

## Why

The package is published and has a consumer that sweeps model gamma across a 7,800-contract chain at
73 spot levels on every live update. Three measured costs sit in the library, not the consumer:

- **Greek calculations compute every Greek.** `blackScholesGreeks` evaluates price-path CDFs, theta
  and rho even when only gamma is wanted. Gamma needs only `d1`, the dividend discount and the
  normal density.
- **Batch price-plus-Greeks repeats work and validation.** `blackScholesPriceMany(…, { greeks: true })`
  runs one pass for prices and a second that calls the validating public scalar
  `blackScholesGreeks` once per row, recomputing `d1/d2` and re-checking every field of an
  already-validated batch (spec 3B.1b forbids this pattern).
- **Exposure does more than its results require.** `exposure()` computes every metric — the basic
  Greeks plus a second-order pass that itself recomputes the basic Greeks and a price — for every
  contract, and its spot, scenario and gamma-root paths evaluate delta and the other Greeks even
  for gamma-only searches.

A second, independent defect is fixed here as well: validating a date-labelled US-equity expiry
built a new `Intl.DateTimeFormat` on every call (InsiderFinance/totalfinance#1), about 40–120 µs per
quote row.

## Released consumers

0.1.0 is published. **The alignment spec's "there are no released consumers" statement (Law 9) is
no longer applicable.** From this amendment on, existing supported calls and conventions are
preserved: every change here is additive or a documented correction, and no existing name, option,
result field, unit or default changes meaning. Pre-1.0 stability labels are unchanged.

## Outcome

The user-facing story stays small:

| Need                               | API                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One Black–Scholes result           | `blackScholes.delta(input)`, `.gamma`, `.theta`, `.vega`, `.rho` (each with `.explain`)                                                                |
| Several Black–Scholes results      | `blackScholes.evaluate({ ...input, outputs: ['price', 'gamma'] })` (with `.explain`)                                                                   |
| A chain of rows                    | `blackScholesEvaluateMany(columns, { outputs })`                                                                                                       |
| Reusable output buffers (advanced) | `blackScholesEvaluateManyInto(columns, { gamma: buffer })`                                                                                             |
| One exposure                       | `gammaExposure`, `deltaExposure`, `vegaExposure`, `thetaExposure`, `vannaExposure`, `charmExposure`, `vommaExposure`, `speedExposure`, `colorExposure` |
| Several exposures                  | `exposure({ quotes, market, config, metrics: ['gex', 'dex'] })`                                                                                        |
| Supplied (vendor) Greeks           | `exposureFromGreeks({ quotes, market, config, metrics: ['gex'] })`                                                                                     |

All of it routes through ONE Black–Scholes evaluation kernel that computes only the requested
outputs and their mathematical dependencies.

## Decisions

1. **One kernel.** `packages/options/src/bsm-evaluate.ts` holds the package-private plan resolver and
   row kernel. A plan is resolved once per invocation (outside any row loop) from the requested
   outputs into dependency flags: `d2`, the rate discount, the normal density, the two cumulative
   normals (`N(±d1)`, `N(±d2)` with the existing call/put argument signs), gamma, `∂d1/∂T` and raw
   vega. The kernel is one row loop over validated columns that computes only flagged
   intermediates and writes straight into output storage — no per-row result objects and no
   per-row allocation; the scalar methods run the same loop over a reused one-row view. `blackScholesPriceUnchecked`, `blackScholesGreeks` and
   `blackScholesExtendedGreeks` keep their public behavior; the formulas are not changed.
2. **Bitwise parity.** Every kernel output uses the existing expression and operation order, so a
   selected value is `===` to the same value from `blackScholesPrice`, `blackScholesGreeks` or
   `blackScholesExtendedGreeks` on the same input. Parity is tested exactly, not to a tolerance.
3. **Outputs and units.** Supported outputs are `price`, `delta`, `gamma`, `theta`, `vega`, `rho`,
   `vanna`, `charm`, `vomma`, `speed`, `color`, in the units `blackScholesGreeks` and
   `blackScholesExtendedGreeks` already document: theta per calendar day, vega and rho per 1%,
   vanna per 1.00 σ, charm and color per added year of time-to-expiry (∂/∂T), vomma per 1.00 σ²,
   speed ∂Γ/∂S. `phi`, `zomma`, `veta`, `vera`, `ultima` and `lambda` stay on
   `blackScholes.extendedGreeks`; no nullable batch encoding is invented for `lambda`.
4. **Named single-Greek methods.** `blackScholes.delta|gamma|theta|vega|rho` take the existing
   `BlackScholesTypedInput`, run the existing facade validation (`validateCore`), and return a
   number. `.explain(input)` returns the existing closed-form envelope (assumptions with Greek
   units, plausibility warnings). Each resolves a one-output plan, so `.gamma` evaluates no CDF.
5. **`blackScholes.evaluate`.** Input is `BlackScholesTypedInput` plus a required `outputs`.
   The selection is explicit, nonempty, dense, made of known names, and duplicate-free. Errors:
   not an array → `input.wrong_type`; empty → `input.out_of_range`; sparse hole →
   `input.missing_field`; unknown name or non-string → `input.invalid_enum` (with the allowed
   names); a repeated name → the new `input.duplicate_entry`. The result object carries exactly
   the selected keys in request order. `.explain` returns `Computed<…>` with the same envelope as
   `.greeks.explain`. Every selection (`outputs`, `metrics`) goes through one public core helper,
   `requireSelection(functionName, field, value, allowed)`, which also refuses a missing or blank
   `functionName`/`field` label (`input.wrong_type`) so its errors always name the caller.
6. **Honest selection types.** A literal selection (`outputs: ['price', 'gamma']`, inferred through
   a `const` type parameter) yields required properties for exactly those names. A dynamic
   selection (`BlackScholesOutput[]`) yields optional properties — the type never claims a value
   exists that was not requested. Unknown names and reading an unrequested property are compile
   errors. The same rule applies to the batch family, model exposure and supplied exposure.
   Every public signature stays single and free of conditional parameter types: the public
   contract tooling (signature, union, intersection and probe inventories) walks one declaration
   per callable, and the alignment spec rules out overloads before 1.0. Consequently an empty
   selection, a view asking for a metric its profile did not compute, and the per-selection input
   requirements of `exposureFromGreeks` are refused at run time with typed errors rather than at
   compile time, and `Parameters<typeof exposure>` / `ReturnType<typeof exposure>` (likewise for
   `exposureFromGreeks`) describe the selection's general, dynamic form; a caller names the released
   types directly (`ExposureInput`, `ExposureProfile`, `SuppliedExposureInput`,
   `SuppliedExposureReport`), which keep their released shapes. `exposureFromGreeks` takes
   `SuppliedExposureRequest`, which `SuppliedExposureInput` satisfies.
7. **One batch family.** `blackScholesEvaluateMany(columns, { outputs })` allocates and returns one
   `Float64Array` per selected output. `blackScholesEvaluateManyInto(columns, outputs)` writes into
   caller-supplied `Float64Array`s whose property names ARE the selection. Both live on the
   existing `@insiderfinance/totalfinance/options/batch` entrypoint. No `blackScholesGreeksMany`
   family is added.
8. **Batch validation is a public boundary.** Both new functions validate the columns object (closed
   keys), every consumed column (array or typed array, exact row count), every consumed value
   (positive finite spot/strike/time/volatility, finite rate and dividend yield, finite type), the
   options/output object (closed keys), and every output buffer (a `Float64Array` with capacity ≥
   rows). Everything is validated before the first write, so a rejected request never partially
   updates an output. Elements past the row count are left untouched. Output buffers may not
   overlap any input column or each other, including exact aliasing.
9. **Existing batch APIs route through the kernel.** `blackScholesPriceMany` (with or without
   `greeks`) computes price and the five Greeks in one shared pass; its results are bitwise
   unchanged. `blackScholesPriceManyInto` keeps its documented exact in-place aliasing of an input
   column and its partial-overlap rejection. **Correction (documented):** it previously validated
   shapes only and silently produced `NaN` for non-finite or non-positive inputs; it now validates
   per-row values before writing, exactly as `blackScholesPriceMany` always has.
10. **Owned snapshots.** Mutable caller arrays are re-validated on every call. The resolved contracts
    inside an `ExposureProfile` are an owned snapshot: their option type and strike are checked once
    at construction (an invalid row fails with the error 0.1.0 raised for it), and every evaluation
    — base metrics, `atSpot`, the zero-gamma sweep, scenarios — goes through the public
    `blackScholesEvaluateManyInto` on owned columns, so changing scenario inputs (spot, volatility
    shock, time advance) are validated per call. A cross-package unchecked path would need a
    non-public entrypoint, which this amendment does not add; SG8 records the validation share of
    the per-call cost. No calculator object is required of scalar users.
11. **Selective model exposure.** `exposure({ quotes, market, config, metrics? })`. Omitting `metrics`
    preserves the existing full profile exactly: same values, fields and assumptions. A selection
    computes only the selected metrics and their Black–Scholes dependencies (`gex`→gamma,
    `dex`→delta, `vega`→vega, `theta`→theta, `vanna`→vanna, `charm`→charm, `vomma`→vomma,
    `speed`→speed and gamma, `color`→color), in one kernel pass, and echoes `assumptions.metrics`
    as requested. A full profile is checked against a golden captured from the published 0.1.0
    package (`tools/golden/capture-exposure-baseline.mjs`), not against the code this change rewrote.
    The check is exact against the same platform. V8's transcendental functions differ in the last
    bit between its darwin-arm64, linux-arm64 and x64 builds, so 0.1.0 itself returns a few
    different last bits on each (at most 8 values in the golden, under 4e-16 relative). One golden
    per platform keeps every comparison exact, and a guard holds the four committed platforms to
    1e-15 of one another.
    Per-contract rows and the aggregate carry exactly the selected metrics. Uncomputed metrics are
    absent, never zero. A row carries the raw `gamma` only when `gex` is selected and the raw
    `delta` only when `dex` is selected. `byStrike`/`byExpiry` default to the selection and refuse
    an unselected metric with a teaching error instead of reading a value that was not computed.
12. **Analyses compute their own dependencies when explicitly called.** `levels()` and `netDrift()`
    on a selective profile compute the per-contract columns they need (gamma for walls, pin risk and
    the zero-gamma sweep; vanna and charm for their walls and drift flows), cache them privately,
    and return the same values a full profile returns. Construction never runs level searches or
    scenarios. `atSpot(spot)` re-evaluates only the selected `gex`/`dex` (and refuses a profile
    that selected neither). The zero-gamma sweep evaluates gamma only. `scenarioMap` evaluates only
    the outputs its requested metrics need, sharing intermediates across them.
13. **Exposure shortcuts.** `gammaExposure`, `deltaExposure`, `vegaExposure`, `thetaExposure`,
    `vannaExposure`, `charmExposure`, `vommaExposure`, `speedExposure` and `colorExposure` each
    take `{ quotes, market, config }` (closed: a `metrics` key is refused) and return the same
    `ExposureProfile` as the corresponding one-metric `exposure(...)` call, from the same selective
    implementation. They are exported from `@insiderfinance/totalfinance/structure` and its
    `structure/exposure` entrypoint. No combination functions are added.
14. **Supplied Greeks stay explicit.** `exposureFromGreeks({ …, metrics? })` with `metrics` from
    `gex`/`dex`. Omitting it preserves today's behavior and report exactly. `['gex']` requires only
    supplied gamma, `gexConvention` and `gammaUnit`; `['dex']` requires only supplied delta and
    `dexConvention`. An unselected convention may be present and is still shape-validated, but is
    not applied or echoed. A selective report omits the unselected metric's fields (contribution
    sign and value, totals, units and convention echoes) and echoes `assumptions.metrics`. A combined
    selection requires both supplied Greeks on every row that supplies Greeks, so GEX and DEX always
    share one included population; this is stated in the report's documentation and asserted by
    tests. No modeled Greek is ever substituted and `scenarioRepricing` stays `'unavailable'`.
15. **Financial meaning is frozen.** No change to pricing model, exercise handling, dividends, rates,
    valuation instants, expiry conventions, day counts, Greek units, time direction, multipliers,
    position signs, exposure units, missing-data treatment, or the open-interest-estimate meaning
    of model exposure. The behavior corrections are decision 9's input validation and three
    exposure cases that returned meaningless values: a negative `minTimeToExpiry` admitted expired
    contracts and turned every exposure into `NaN` (contracts at or past expiry are now always
    skipped and counted); an unknown metric name passed to `byStrike`, `byExpiry` or `scenarioMap`
    returned `undefined` values (now `input.invalid_enum`); and a view asked for a metric the profile
    did not compute is refused rather than read.
16. **Expiry validation cost (#1).** The America/New_York offset formatter is built once per module
    (lazily) instead of once per call. Results are byte-identical; a test asserts that repeated
    validations construct no further formatters.
17. **No transport expansion.** No MCP/HTTP/CLI operation, manifest `mcpTools` entry, or OpenAPI
    surface is added. The existing `totalfinance.structure.exposures` operation keeps its full-profile
    behavior.

## Ordered checklist and exit evidence

- [x] SG1: record this plan, link it from `implementation-order.md`, and supersede the "no released
      consumers" statement.
- [x] SG2: expiry-validation formatter fix with a construction-count regression test.
- [x] SG3: kernel, named methods, `evaluate`, and the new error code; scalar parity, oracle and
      validation tests; literal/dynamic/compile-fail type tests.
- [x] SG4: batch family, routing of the existing batch APIs, buffer-safety and validate-before-write
      tests, skipped-work tests.
- [x] SG5: selective model exposure, analyses, shortcuts; conservation, parity, roots, scenarios,
      shortcut-equivalence and skipped-work tests.
- [x] SG6: supplied-exposure selection with requirement and report-shape tests.
- [x] SG7: manifests, first-touch fixtures, naming/signature/contract curation, bundle budgets from
      measurements, packed-consumer coverage, docs and examples; regenerate in lawful order.
- [x] SG8: Node and browser benchmarks before/after; record workload, environment, timing and
      allocation behavior.
- [x] SG9: full CI, a second coverage run, `api:check`, byte-stable `regen:check`; record evidence.

## Verification record

### SG8 — performance, 2026-10-01

**Workload.** One synthetic index chain: 30 weekly expiries × 130 strikes × call/put = 7,800
contracts, a smile, varying open interest, spot 6,500, r = 4.3%, q = 1.3%; the GEX sweep re-evaluates
it at 73 spot levels (±12%). Scalar calls use one 3-month call. Harness:
`tools/bench/selective-workloads.mjs`, run by `selective-greeks-and-exposure.mjs` (Node) and
`selective-browser.mjs` (a self-contained page).

**Before / after.** "Before" is the PUBLISHED `@insiderfinance/totalfinance@0.1.0` (npm install into
a temp directory); "after" is this branch's assembled `distribution/totalfinance` at the commit that
records this section. Where 0.1.0 has no selective API, "before" is what a 0.1.0 consumer had to do
instead: `blackScholes.greeks(x).gamma`, `blackScholesPriceMany(…, { greeks: true })`, the full
`exposure()`.

**Method.** Node 22.23.2 (`.nvmrc`), Apple M4 (10 cores, 32 GB), macOS 26.3, `--expose-gc
--max-semi-space-size=256`. Each workload runs in its own process (`BENCH_ONLY=<id>`); warm-up is at
least five iterations and 500 ms, then the median of 25 timed iterations. Three rounds alternate
before and after; the table shows the median of the three medians (the rounds agreed within 6% except
one 0.1.0 `levels()` outlier). Another session's `next-server` and a Time Machine backup each used
about one core during the runs; the harness is single-threaded.

| Workload (Node, median ms)                                                      |  0.1.0 | this change | Faster |
| ------------------------------------------------------------------------------- | -----: | ----------: | -----: |
| Scalar gamma × 100,000 (`blackScholes.gamma` vs `.greeks().gamma`)              |   44.1 |        17.1 |   2.6× |
| Batch gamma, 7,800 rows (`blackScholesEvaluateMany` vs `PriceMany` + Greeks)    |   1.41 |       0.215 |   6.6× |
| Batch delta + gamma                                                             |   1.42 |       0.384 |   3.7× |
| Batch price + gamma                                                             |   1.39 |       0.559 |   2.5× |
| Batch price + five Greeks (`blackScholesPriceMany(…, { greeks: true })` itself) |   1.39 |       0.693 |   2.0× |
| Batch gamma into a reused buffer (`blackScholesEvaluateManyInto`)               |      — |       0.216 |      — |
| 73-level GEX sweep over 7,800 contracts (columnar)                              |  102.5 |        16.0 |   6.4× |
| `exposure()` construction, full profile                                         |  240.3 |        14.1 |  17.1× |
| `gammaExposure()` construction (0.1.0: full `exposure()`)                       |  240.4 |        13.2 |  18.2× |
| 73 `atSpot` updates (0.1.0: gex + dex; `gammaExposure`: gex only)               |   69.8 |        16.7 |   4.2× |
| `levels()` (zero-gamma sweep, walls, pin risk) on a full profile                | 1297.1 |       117.9 |  11.0× |
| `exposureFromGreeks`, 7,800 supplied quotes (expiry-formatter fix, #1)          |  269.7 |        42.9 |   6.3× |

**Browser.** The same workloads in headless Chromium 148.0.7778.96 (Playwright), two alternating
rounds, median of medians. `performance.now()` resolution is 0.1 ms in the page, so sub-millisecond
rows are coarse.

| Workload (Chromium, median ms) |  0.1.0 | this change | Faster |
| ------------------------------ | -----: | ----------: | -----: |
| Scalar gamma × 100,000         |   42.5 |        17.3 |   2.5× |
| Batch gamma, 7,800 rows        |   1.45 |        0.25 |   5.8× |
| Batch delta + gamma            |   1.45 |        0.40 |   3.6× |
| Batch price + gamma            |   1.40 |        0.60 |   2.3× |
| Batch price + five Greeks      |   1.40 |        0.80 |   1.7× |
| Batch gamma, reused buffer     |      — |        0.25 |      — |
| 73-level GEX sweep             |  106.5 |        20.2 |   5.3× |
| `exposure()` construction      |  275.1 |        15.2 |  18.0× |
| `gammaExposure()` construction |  269.2 |        14.5 |  18.6× |
| 73 `atSpot` updates            |   73.7 |        22.4 |   3.3× |
| `levels()`                     | 1479.4 |       119.4 |  12.4× |
| `exposureFromGreeks`           |  304.4 |        42.0 |   7.3× |

**Allocation.** Heap growth per call, measured at 780, 7,800 and 78,000 rows after at least 300 calls
and one second of warm-up (so the fixed and per-row parts separate): the gamma batch into a reused
buffer allocates **0 bytes per row** and 5.6 KB per call (validation and plan); `atSpot` on a
`gammaExposure` profile **0 bytes per contract** and 5.9 KB per call; `blackScholesPriceMany` with
Greeks 2.8 bytes per row and 27 KB per call plus its six result arrays. Before the row loop became one
kernel loop and the batch validation an inline test, the gamma batch boxed ~177 bytes per row
(commit "Make the selective row loop allocation-free…"). The same method gave non-monotonic readings
for 0.1.0 (its per-row validating calls are partly removed by escape analysis, and typed-array
backing stores sit outside the measured heap), so no 0.1.0 per-row figure is claimed. A full profile
keeps its snapshot and per-metric columns for its analyses: about 1.13 MB of typed arrays for 7,800
contracts (145 bytes per contract), 1.32 MB once `atSpot` has run; a one-metric profile keeps the
snapshot and its own columns only.

Reproduce: `npm install --prefix /tmp/tf010 @insiderfinance/totalfinance@0.1.0`, `pnpm build`, then
`BENCH_ONLY=<id> node --expose-gc --max-semi-space-size=256 tools/bench/selective-greeks-and-exposure.mjs
<package root>` per workload, and `node tools/bench/selective-browser.mjs <package root> <dir>` for a
page.

### SG9 — gates, 2026-10-01

On a clean tree at `23628e1`, Node 22.23.2, Apple M4, in order:

| Gate                                                                                                                       | Result                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm run ci` (format check, lint, typecheck, site typecheck, build, site build, site tests, `test:coverage`, `api:check`) | pass: 574 test files, 12,664 tests; statements 94.18%, branches 84.02%, functions 96.99%, lines 94.74% |
| `pnpm api:check`                                                                                                           | pass: all 25 API reports up to date                                                                    |
| `pnpm test:coverage`, a second run                                                                                         | pass: the same 12,664 tests and the same coverage to the statement                                     |
| `pnpm regen:check`                                                                                                         | pass: the regeneration chain is byte-stable                                                            |

The enforcement artifact records 5,370 candidates: 2,482 enforced, 2,701 partial, 0 defective,
187 unmeasured (the ratchet's bound). The first landing attempt found two things, both fixed
before this run rather than waived:

- **`requireSelection` measured defective.** Its new first-touch fixture made the helper
  measurable, and the mutation probes showed it accepted an omitted or wrong-typed
  `functionName`/`field`. It now refuses a missing or blank label (`input.wrong_type`) and is
  enforced on all three spellings.
- **The `workflows` bundle was 120 B over its line.** That label guard adds 302 B there. The line
  moved 501.75 → 502 KB, with the final measurements recorded in each affected rationale.

The SG8 timings were taken before those two changes. Neither touches a row loop or a kernel: the
guard is two `typeof` checks per selection, once per call.

**Hosted CI (Node 22.13, 24, 26 on linux-x64) then failed the 0.1.0 parity test on 8 values**, all
of them inside scenario maps and gamma flips. Cause: the golden had been captured on darwin-arm64,
and 0.1.0 itself returns different last bits there than on x64. V8's `Math.exp`, `log`, `pow`,
`sin`, `cos`, `atan`, `expm1`, `log1p` and `tanh` differ between those builds; `sqrt`, `cbrt` and
`hypot` agree. Capturing 0.1.0 and this branch on four platforms showed:

- this branch equals 0.1.0 byte for byte on each of them: darwin-arm64, darwin-x64 (Rosetta), and
  linux-x64 and linux-arm64 (Docker);
- 0.1.0 differs between platforms in at most 8 values, under 4e-16 relative;
- each platform's result is the same under Node 22.13, 22.23, 24 and 26, and under official and
  Homebrew builds.

The model golden is therefore one file per platform, captured from one committed set of inputs.
The supplied-Greek golden is byte-identical on all four and stays one file.
