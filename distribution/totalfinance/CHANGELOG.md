# @insiderfinance/totalfinance

## 0.1.3

### Patch Changes

- 8a8c8f8: Use supplied asset classification when preflighting a held instrument while preserving ledger economic terms. Reconcile selected plans without treating other plans' journaled fills as missing, retaining orphan detection. Report only newly applied portfolio events on retries and mixed duplicate batches.
- Add narrow income/balance inputs for single-statement ratios while preserving complete-statement calls and cross-statement validation. Add explicit portfolio creation and bounded handle inspection, and expose journal-derived currentOrders alongside immutable paper submission receipts.

  Add an explicit source-bar to OHLCV projection, bounded repeated-row error summaries, stable deduplicated mark-age warnings, recursive screen-predicate discovery, category guidance and calendar coverage diagnostics. Support real zero estimated-cost/slippage ceilings. Expose compatible declarative vectorized SDK controls and executable task-first recovery/research/cost/lag guidance.

  Release policy: the maintainer explicitly selected continued 0.1.x releases. This cut retains the already merged additive reference-price helpers and disclosed-holdings partitions as additions; their pending minor intents are released under the authorized patch override, not reclassified as bug fixes. Existing supported calls and result meanings remain compatible. Draft connector PR #26 and performance PR #12 are excluded. This is release preparation, with no merge, publication or deployment authorization.

- 67134bf: Faster New York market-day lookups, and so faster flow analysis, with every result unchanged.

  `usEquityMarketDayIndex` (and `usEquityMarketDateUtcMs`) read the New York calendar date from
  `Intl` on every call, and `flow()` asks for it twice per print to flag 0DTE trades: on a
  50,000-print session that was about three quarters of `flow()`. The day is now remembered per UTC
  clock hour. The first instant asked about in an hour is read exactly, as before; the second visit
  reads the hour's two ends and, when they agree, stores the date. A session of prints reads `Intl`
  three times per cacheable hour while its entry remains resident, instead of twice per print. A
  one-off call keeps the same Intl-read count, with added cache bookkeeping. An hour whose New York
  date changes inside it (before 1883, under local mean time) is still answered exactly every time:
  its second visit costs three reads (both ends plus the requested instant), and later visits cost
  one. The 8,192-entry cache is private to each module instance, including each worker's own instance;
  eviction restarts the first-visit/confirmation sequence. Invalid input still throws the same error.
  `flow()`, `optionFlowDrift()`, exposure's 0DTE buckets, earnings day counts and the backtest option
  chain all share the gain.

- 51599ae: Avoid rebuilding the freshly parsed JSON tree when restoring canonical artifacts. Non-finite
  wrappers, prototype-sensitive keys, independent decoded results, and serialization rules are unchanged.
- 2189afe: Add `valuation.convertPriceLevel` and the focused `valuation/price-levels` import for approximate two-way price-level mapping using explicit reference prices or a directed target-per-source ratio. The browser-safe facade includes `.explain()`, optional descriptive unit labels, typed boundary validation, numeric overflow/underflow refusals, and an optional schema import at `valuation/schemas`. No ticker ratios, quote retrieval or instrument economics are inferred.

  Add three-price named helpers in both directions for ES/SPY, NQ/QQQ, YM/DIA, RTY/IWM, SPX/SPY, NDX/QQQ, RUT/IWM and DJIA/DIA. Helpers include `.explain()` and separate closed schemas, share the generic arithmetic, and supply descriptive units without hardcoding market ratios. Generic unit labels are optional metadata; an unlabeled explained result reports `resultUnit: null`. DJIA means the full Dow Jones Industrial Average, not DJX.

- 538163a: Add compareDisclosedHoldingPartitions for caller-supplied common-stock reporting partitions, exact reported changes on stable no-reference bases, and complete-universe partition weights/concentration. Reference-bearing or changed-basis groups remain explicit uncompared observations; the existing disclosed-holdings API is preserved.

## 0.1.2

### Patch Changes

- 2d1c727: Compare caller-supplied disclosed holdings with exact decimal reported changes, explicit completeness
  and discretion review, and weights and concentration for complete supported reported universes.
  The new portfolio API preserves unresolved observations and never infers trades or ownership shares.
  It includes literal value-scale types, typed review codes, and a structured echo of the chosen policy.
- b5ae781: Faster supplied-Greek exposure and gamma sweeps, and supplied exposure without breakdowns.

  - `exposureFromGreeks({ …, breakdowns: false })` leaves `byStrike` and `byExpiry` out of the report,
    for a caller that aggregates the contributions itself: no grouping and no per-group exact totals
    (two thirds of the summation). Contributions, aggregate, coverage and diagnostics are unchanged;
    `assumptions.breakdowns` echoes the flag. Omitted or `true` is the released report. The report
    type follows the flag (`SuppliedExposureBreakdownsFor`).

  Every existing result is unchanged bit for bit:

  - `exposureFromGreeks` is about 36% faster on a large chain (8,114 quotes: 41.5 → 26.7 ms). Exact
    summation (`stableSum`) uses indexed loops instead of a destructuring swap and the iterator
    protocol; the check that a result holds no non-finite number formats a path only when it finds
    one; and parsed expiry labels are remembered (failures still throw every time).
  - A gamma-only Black–Scholes selection (`blackScholesEvaluateMany(…, { outputs: ['gamma'] })`,
    `blackScholesEvaluateManyInto(…, { gamma })`, `gammaExposure`, zero-gamma sweeps) runs its own
    row loop, and a zero rate or yield skips its discount exponential: 40.6 → 25.7 ns per gamma.

## 0.1.1

### Patch Changes

- 85c2c2c: Compute only the Black–Scholes outputs and exposures you ask for.

  - `blackScholes.delta`, `.gamma`, `.theta`, `.vega` and `.rho` return one Greek (with `.explain`);
    `blackScholes.evaluate({ ...input, outputs })` returns exactly the selected outputs, typed
    precisely for literal selections. Values are bit-identical to `blackScholes.greeks`,
    `blackScholes.price` and `blackScholes.extendedGreeks`; gamma alone evaluates no cumulative normal.
  - `blackScholesEvaluateMany(columns, { outputs })` and
    `blackScholesEvaluateManyInto(columns, { gamma: buffer })` on `@insiderfinance/totalfinance/options/batch` run a selection over columnar
    chains. The `Into` form validates columns, row values and buffers before its first write, never
    touches elements past the row count, and refuses overlapping storage.
  - `blackScholesPriceMany` with `greeks: true` is now a single pass (no per-row validating Greek
    call); results are unchanged. `blackScholesPriceManyInto` now validates row values before
    writing instead of returning `NaN` for a non-positive or non-finite row, and both refuse a
    non-finite `type` and non-array columns.
  - `exposure({ ..., metrics })` computes only the selected exposures; omitting `metrics` returns the
    full profile exactly as before. Rows and totals carry only computed metrics (never zero-filled),
    `atSpot` re-evaluates only the selected GEX/DEX, the zero-gamma sweep evaluates gamma alone, and
    `levels()`, `netDrift()` and `scenarioMap()` compute what they need. New shortcuts:
    `gammaExposure`, `deltaExposure`, `vegaExposure`, `thetaExposure`, `vannaExposure`,
    `charmExposure`, `vommaExposure`, `speedExposure`, `colorExposure`.
  - `exposureFromGreeks({ ..., metrics: ['gex'] })` needs only supplied gamma (and `['dex']` only
    delta); omitting `metrics` keeps the existing report.
  - Validating a date-labelled US-equity expiry no longer constructs an `Intl.DateTimeFormat` per call.
  - Corrections: a negative `minTimeToExpiry` no longer admits expired contracts as `NaN` exposure;
    unknown metric names passed to `byStrike`, `byExpiry` or `scenarioMap` are typed errors; and color
    exposure under `gammaUnit: 'perPoint'` now uses the per-point GEX scale (`S`, not `S²·0.01`), so it
    matches the change in the profile's own per-point GEX as a day elapses. It was `spot·0.01` times
    too large; the default `per1PercentMove` values are unchanged. The `totalfinance.structure.exposures`
    operation reports the corrected value too.
  - A batch row value must be a number: a plain-array column holding `"100"`, `true` or `100n` is
    refused with a typed error naming the column and row, before anything is written.
  - New error code `input.duplicate_entry` for a selection that names an entry twice, and the core
    helper behind every selection, `requireSelection(functionName, field, value, allowed)`: it
    returns a dense copy in request order and refuses a non-array, an empty list, a sparse hole, an
    unknown name (with a suggestion) and a repeat.
  - No MCP, HTTP or CLI operation changes; the MCP package versions with the library (fixed group).
  - Selection result types promise only what is certain: a name is required only when every possible
    selection holds it (core's `GuaranteedSelection`), so `c ? ['gamma'] : ['delta']` or a
    union-valued element gives optional properties.
  - Type note: `exposure` and `exposureFromGreeks` are generic over their selection, so
    `Parameters<typeof …>` and `ReturnType<typeof …>` describe the general (dynamic-selection) form.
    Name `ExposureInput`/`ExposureProfile` and `SuppliedExposureInput`/`SuppliedExposureReport`
    directly for the full-profile types; their shapes are unchanged.
