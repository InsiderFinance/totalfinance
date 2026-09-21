# Phase 1 — Credible core

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

0.1 turns the architecture spike into the first genuinely useful library: real market-data types and
conventions, exchange calendars, two more pricing models, a batch API, streaming technical
indicators, performance metrics, and the options profit calculator.

## What's new

### `@totalfinance/core`

- Date parsing, day counts (ACT/365F, ACT/360, true 30/360), and compounding (continuous/simple).
- Market-data contracts: `Bar`, `Quote`, `Trade`, `OptionQuote`, `OptionTrade`, `Dividend`,
  `CorporateAction`, `RateCurve`, `OrderBook`, `Fundamentals`, plus quote price-source selection.
- OCC option symbology (`parseOccSymbol` / `formatOccSymbol`).
- Calendar interface + rules engine (`createRuleCalendar`, `defineCalendar`, `alwaysOpen`,
  `weekendsOnly`) and the `WarningCode` registry.
- Public payload schemas at `@totalfinance/core/schema`.

### `@totalfinance/calendars` (new)

- Rules-based `NYSE`, `CBOE`, and `crypto24x7` calendars with half-days and ad-hoc closures. No giant
  holiday tables; core ships no exchange datasets.

### `@totalfinance/math`

- Descriptive + rolling statistics, quantiles, covariance/correlation, linear interpolation (with
  extrapolation policies), a seedable PRNG, normal sampling, and a reproducible bootstrap.

### `@totalfinance/options`

- **Black-76** and **Bachelier (normal)** models — price, Greeks (finite-difference verified), and
  implied volatility, each as a facade with `.explain()`.
- Batch API: `priceMany` (rows) and columnar struct-of-arrays kernels (`bsmPriceMany`,
  `bsmPriceManyInto`), no-arbitrage checks, and bid/ask/mid selection.

### `@totalfinance/performance` (new)

- Returns, annualized return/volatility, Sharpe, Sortino, Calmar, drawdowns, and `analyze`. The
  `/sharpe` deep entrypoint pulls in no option pricing.

### `@totalfinance/ta` (new)

- 13 indicators (SMA, EMA, WMA, RSI, MACD, ATR, Bollinger, Stochastic, ADX, VWAP, OBV, returns,
  rolling volatility), each with **aligned batch output and a serializable streaming form**. Batch is
  derived from the stream, so the two are identical by construction. Plus a feature pipeline with
  explicit aliasing.

### `@totalfinance/strategy` (new)

- The options profit calculator: legs, expiration payoff, exact max profit/loss and breakevens,
  BSM mark-to-market, per-leg + aggregate Greeks, chart data, and named builders (verticals,
  straddle, strangle, iron condor).

### `@totalfinance/mcp`

- `totalfinance.ta.calculate` tool, core-payload schema resources, a deterministic seed-policy resource,
  `/analyze-option-trade` and `/screen-options-chain` prompts, and a max-row guard.

## Quality

- Golden values (canonical BSM 10.4506, Black-76, RSI 70.46, exact spread payoffs), property tests
  (parity, monotonicity, non-negative gamma, IV round-trips, stats), streaming↔batch equivalence for
  every indicator, and serialization round-trips.
- Strict TypeScript, ESLint package boundaries, bundle budgets (all green), composite build, and
  public API reports for all packages.

## Bundle sizes (gzip)

`black-scholes` 3.0 KB · `core` 3.7 KB · `math` 3.5 KB · `calendars/nyse` 2.0 KB ·
`performance/sharpe` 0.3 KB · `ta/rsi` 0.6 KB. See [bundle-size.md](../bundle-size.md).

## Next (Phase 2)

American option engines (BAW, Bjerksund–Stensland, trees, Crank–Nicolson), batch chain IV,
higher-order Greeks, and QuantLib-validated vectors.
