# @insiderfinance/totalfinance

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
