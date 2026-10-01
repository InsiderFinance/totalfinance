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
   vega. The row kernel computes only flagged intermediates and writes straight into output
   storage — no per-row result objects. `blackScholesPriceUnchecked`, `blackScholesGreeks` and
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
   `.greeks.explain`.
6. **Honest selection types.** A literal selection (`outputs: ['price', 'gamma']`, inferred through
   a `const` type parameter) yields required properties for exactly those names. A dynamic
   selection (`BlackScholesOutput[]`) yields optional properties — the type never claims a value
   exists that was not requested. Unknown names and reading an unrequested property are compile
   errors. The same rule applies to the batch family, model exposure and supplied exposure.
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
10. **Owned snapshots.** Mutable caller arrays are re-validated on every call. Internal snapshots the
    library owns (the resolved contracts inside an `ExposureProfile`) are validated once at
    construction; their scenario inputs (spot, volatility shock, time advance) are validated per
    call. No calculator object is required of scalar users.
11. **Selective model exposure.** `exposure({ quotes, market, config, metrics? })`. Omitting `metrics`
    preserves the existing full profile exactly: same values, fields and assumptions. A selection
    computes only the selected metrics and their Black–Scholes dependencies (`gex`→gamma,
    `dex`→delta, `vega`→vega, `theta`→theta, `vanna`→vanna, `charm`→charm, `vomma`→vomma,
    `speed`→speed and gamma, `color`→color), in one kernel pass, and echoes `assumptions.metrics`.
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
    of model exposure. The only behavior correction is decision 9's input validation.
16. **Expiry validation cost (#1).** The America/New_York offset formatter is built once per module
    (lazily) instead of once per call. Results are byte-identical; a test asserts that repeated
    validations construct no further formatters.
17. **No transport expansion.** No MCP/HTTP/CLI operation, manifest `mcpTools` entry, or OpenAPI
    surface is added. The existing `totalfinance.structure.exposures` operation keeps its full-profile
    behavior.

## Ordered checklist and exit evidence

- [ ] SG1: record this plan, link it from `implementation-order.md`, and supersede the "no released
      consumers" statement.
- [ ] SG2: expiry-validation formatter fix with a construction-count regression test.
- [ ] SG3: kernel, named methods, `evaluate`, and the new error code; scalar parity, oracle and
      validation tests; literal/dynamic/compile-fail type tests.
- [ ] SG4: batch family, routing of the existing batch APIs, buffer-safety and validate-before-write
      tests, skipped-work tests.
- [ ] SG5: selective model exposure, analyses, shortcuts; conservation, parity, roots, scenarios,
      shortcut-equivalence and skipped-work tests.
- [ ] SG6: supplied-exposure selection with requirement and report-shape tests.
- [ ] SG7: manifests, first-touch fixtures, naming/signature/contract curation, bundle budgets from
      measurements, packed-consumer coverage, docs and examples; regenerate in lawful order.
- [ ] SG8: Node and browser benchmarks before/after; record workload, environment, timing and
      allocation behavior.
- [ ] SG9: full CI, a second coverage run, `api:check`, byte-stable `regen:check`; record evidence.

## Verification record

To be completed at SG9.
