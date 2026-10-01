---
'@insiderfinance/totalfinance': minor
'@insiderfinance/totalfinance-mcp': minor
---

Compute only the Black–Scholes outputs and exposures you ask for.

- `blackScholes.delta`, `.gamma`, `.theta`, `.vega` and `.rho` return one Greek (with `.explain`);
  `blackScholes.evaluate({ ...input, outputs })` returns exactly the selected outputs, typed
  precisely for literal selections. Values are bit-identical to `blackScholes.greeks`,
  `blackScholes.price` and `blackScholes.extendedGreeks`; gamma alone evaluates no cumulative normal.
- `blackScholesEvaluateMany(columns, { outputs })` and `blackScholesEvaluateManyInto(columns,
{ gamma: buffer })` on `@insiderfinance/totalfinance/options/batch` run a selection over columnar
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
  unknown metric names passed to `byStrike`, `byExpiry` or `scenarioMap` are typed errors.
- New error code `input.duplicate_entry` for a selection that names an entry twice.
- No MCP, HTTP or CLI operation changes; the MCP package versions with the library (fixed group).
