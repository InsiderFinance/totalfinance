---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Faster supplied-Greek exposure and gamma sweeps; every result is unchanged bit for bit.

- `exposureFromGreeks` is about 36% faster on a large chain (8,114 quotes: 41.5 → 26.7 ms). Exact
  summation (`stableSum`) uses indexed loops instead of a destructuring swap and the iterator
  protocol; the check that a result holds no non-finite number formats a path only when it finds
  one; and parsed expiry labels are remembered (failures still throw every time).
- A gamma-only Black–Scholes selection (`blackScholesEvaluateMany(…, { outputs: ['gamma'] })`,
  `blackScholesEvaluateManyInto(…, { gamma })`, `gammaExposure`, zero-gamma sweeps) runs its own
  row loop, and a zero rate or yield skips its discount exponential: 40.6 → 25.7 ns per gamma.
