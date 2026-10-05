---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Faster supplied-Greek exposure and gamma sweeps, and supplied exposure without breakdowns.

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
