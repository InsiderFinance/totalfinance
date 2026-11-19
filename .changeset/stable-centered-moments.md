---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Variances, covariances and correlations that were computed as `Σx² − n·mean²` now use centered
moments, so values that share a large constant offset no longer cancel to rounding noise.

- `Position.monteCarloProbability()` reports an accurate `expectedValueStandardError` when every
  path pays nearly the same large amount. A deep in-the-money put (strike 1,000,000, spot 1,
  1,000 paths) reported about 300 times the true sample standard error; it now matches an
  exact-arithmetic reference to about 1e-15 relative.
- The technical-analysis `covariance`, `rSquared`, `rollingRegression`, `correl`, `beta` and `cti`
  indicators are exact on price-level inputs. A flat window of `0.1` regressed to slope `-1024`
  instead of `0`, flat windows correlated at about `±1e-7` or `NaN` instead of `0`, and
  BTC-sized prices moving by ticks gave a slope of `1.042` against a true `0.987`. Correlations
  stay within `[-1, 1]` and `rSquared` at most `1`; rounding put a perfect relationship one unit
  in the last place outside, so `Math.acos(correl)` could return `NaN`.
- `probabilityOfBacktestOverfitting` ranks a constant-return (cash-like) configuration by its
  zero-variance Sharpe of `0` at every return level. At some levels, such as `0.0007` per period,
  rounding noise scored it at a Sharpe of about `1e7`, so it won every split and the result
  reported PBO `0`. Each split now merges per-block means and centered sums of squares.

Seeded draws, probabilities, quantiles and `monteCarloProbability()` expected values are
unchanged. On ordinary inputs the corrected statistics move only by floating-point rounding.
