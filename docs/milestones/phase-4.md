# Phase 4 — TA parity

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

Phase 4 turns `@totalfinance/ta` from the Phase 0–3 starter set (13 indicators) into a full
technical-analysis suite that stands next to TA-Lib — **172 registered indicators**, the complete
candlestick catalog, alternative chart types, price-action tooling, a feature pipeline, a signal DSL
and an introspectable indicator registry. Everything is **pure compute over raw arrays/bars** with no
data-layer dependency: each indicator is simultaneously an aligned batch function and a serializable
stream, and batch output is _derived_ from the stream, so the two are identical by construction.

## What's new

### Indicator families (≈120 streaming indicators)

- **Transforms** — typical / median / weighted / average price, candle body & shadow & range
  geometry, true range, gaps, Heikin-Ashi, and log/simple returns.
- **Moving averages (20)** — SMA, EMA, WMA, Wilder/RMA, DEMA, TEMA, TRIMA, T3, KAMA, **MAMA/FAMA**,
  HMA, ZLEMA, ALMA, VIDYA, **FRAMA**, McGinley Dynamic, Ehlers Super Smoother, VWMA, and
  rolling / anchored VWAP.
- **Momentum (24)** — RSI, MACD, StochRSI, PPO, APO, CCI, CMO, the ROC family, Momentum, Williams %R,
  TRIX, Ultimate & Awesome oscillators, KST, TSI, Connors RSI, Fisher Transform, DPO, Stochastic, and
  the MACDEXT / MACDFIX variants.
- **Trend (22)** — DMI (+DI/−DI/+DM/−DM/DX), ADX, ADXR, Aroon & Aroon Oscillator, Parabolic SAR and
  Extended SAR (SAREXT), Supertrend, Ichimoku, Vortex, Donchian trend, linear-regression
  value/slope/intercept/angle, Time-Series Forecast, Chandelier exits, and ZigZag.
- **Volatility (16)** — ATR, NATR, Bollinger Width & %B, Keltner & Donchian channels, rolling standardDeviation
  & variance, and the OHLC estimator family (close-to-close historical, realized, Parkinson,
  Garman-Klass, Rogers-Satchell, Yang-Zhang) plus Chaikin Volatility.
- **Volume / order-flow (15)** — OBV, VWAP, A/D line, Chaikin Oscillator & Money Flow, MFI, PVT, Ease
  of Movement, Force Index, NVI, PVI, Klinger, Volume Flow Indicator, relative volume, a bar-based
  Cumulative Volume Delta, plus volume-profile and order-book-imbalance utilities.

### Candlestick catalog (61 patterns)

The full TA-Lib `CDL*` set on a shared `CandleView` that reproduces TA-Lib's candle-average
thresholds (body / range / shadow averages over the trailing 10- or 5-bar window _before_ the
pattern), so "long body", "doji", "short shadow", "near"/"equal" all scale to recent volatility.
Output is TA-Lib's signal scale — `+100` bullish, `−100` bearish, `0` none — and `detectCandles(bars)`
scans the whole catalog at once.

### Chart types

Heikin-Ashi, Renko, Kagi, Point & Figure and Three-Line-Break, plus the information-driven bar
aggregations (range / tick / volume / dollar). Renko, Line-Break and the bar aggregations expose
serializable streams (each `.next(bar)` returns the units that completed on that bar) for live
charting; Kagi and P&F are batch constructions.

### Price action

Pivot points (classic / Fibonacci / Woodie / Camarilla / DeMark), swing highs/lows, Bill Williams
fractals, support/resistance clustering, trendlines & channels, breakout & gap detection, market
structure (HH/HL/LH/LL with BOS / CHoCH), session ranges, and the opening-range breakout.

### Pipeline, signal DSL & registry

- **Feature pipeline** — named feature columns with `{ as }` aliases (duplicate aliases throw
  `pipeline.duplicate_alias`), plus generic `applySeries` / `applyBars` / `column` escape hatches that
  reach every indicator in the catalog and a `toColumns()` / `toRows()` output.
- **Signal DSL** — `technical_analysis.signal(candles).sma('close', 20, { as: 'fast' })…when(crossOver('fast','slow')).and(gt('momentum', 50)).emit('long')`,
  with `crossOver/crossUnder/gt/lt/gte/lte/rising/falling/between/not` conditions over named columns,
  raw OHLCV fields, dotted record sub-fields (`macd.histogram`), and numeric constants. A public
  `condition(refs, fn)` helper makes custom predicates first-class — their refs are validated up front
  just like the built-ins.
- **Indicator registry** — `defineIndicator({ name, inputs, params, stream, restore, nan })` builds an
  aligned batch+stream indicator and registers it; every built-in is auto-registered, and the registry
  generates [`docs/guides/ta-indicators.md`](../guides/ta-indicators.md) (172 indicators).

## Quality

- Every family verifies the maths (constant-series invariants for all 20 moving averages; bounded
  oscillators stay in range; DEMA/TEMA cancel a ramp's lag exactly; linreg recovers a known line;
  Parkinson recovers a range-implied σ; …), confirms **batch ≡ stream** parity, and round-trips a
  `toJSON()` snapshot mid-stream. The whole 61-pattern candlestick catalog is checked for streaming
  parity and serialization in one sweep.
- **Numerical robustness fix:** MFI clamps rolling-sum float drift (a window of zero down-flow could
  leave `sumNeg ≈ −1e-13`, pushing the money ratio negative and MFI above 100).
- **Boundary validation (review hardening):** a shared `validate.ts` runs at every facade's public
  boundary (design law #4). Periods must be positive integers; chart-type brick/box/reversal/threshold
  sizes must be positive — closing a Renko `while`-loop that would spin forever on `brickSize ≤ 0`;
  price-action lookbacks are checked. Bad params now throw a typed `InputError` (`input.out_of_range`)
  instead of silently returning an all-`NaN` series. The signal DSL throws `signal.unknown_reference`
  on a misspelled alias/sub-field (including a dotted ref into a scalar column); the pipeline throws
  `pipeline.length_mismatch` on a wrong-length injected column.
- **Sample-estimator correctness:** `standardDeviation`/`variance` snapshots now persist the `sample` flag (it was
  dropped on restore, breaking streaming parity for sample mode), and every `÷ (n−1)` estimator
  (sample `standardDeviation`/`variance`, `rollingVolatility`, `historicalVolatility`, `yangZhang`) requires
  `period ≥ 2`. Domain ranges are enforced: Bollinger `stdDev > 0`, `t3.volumeFactor` and `alma.offset`
  in `[0, 1]`, and Parabolic SAR `step ≤ max`.
- **String-union & snapshot validation:** a shared `requireOneOf` rejects bad enum inputs — `macdExt`
  MA types, pipeline `Field`, `pivots` method — with a typed `InputError` rather than a raw `TypeError`,
  an all-`NaN` column, or `undefined`. `macdExt.fromJSON` throws on a corrupted MA sub-snapshot instead
  of silently restoring it as EMA. `mama` enforces `0 < slowLimit ≤ fastLimit ≤ 1`; `volumeProfile`
  validates `bins` and `valueAreaPct`.
- Full CI green at the Phase 4 milestone: **559 tests** across **10 packages**, strict TypeScript,
  lint, build, bundle budgets, and committed public API reports (`@totalfinance/ta` now documents
  281 public exports).

## Decisions

- **Volatility annualization** — the OHLC estimators report per-bar σ by default (`annualization = 1`,
  matching the existing `rollingVolatility`); pass `annualization: 252` (or your bars-per-year) to
  annualize. No calendar convention is baked in (design law #3).
- **MAMA/FAMA, FRAMA, Super Smoother** follow Ehlers' published algorithms; MAMA's adaptive period
  needs a warm-up before it stabilizes (its FIR history fills over the first ~6 bars).
- **ZigZag, Kagi, Point & Figure** repaint or re-aggregate by nature, so they are batch utilities
  whose final leg is flagged provisional rather than causal streaming indicators.
- **Candlestick thresholds** use TA-Lib's default candle settings (BodyLong 1×, BodyDoji 0.1×,
  Near 0.2×, …); where TA-Lib assigns a fixed bullish/bearish sign to a shape (hammer vs hanging-man),
  this catalog follows the same convention and leaves trend context to the caller.
- **`ta` namespace organization** — chart types and price-action utilities are grouped under
  `technical_analysis.charts` and `technical_analysis.priceAction` (they re-aggregate the series, so they aren't aligned indicators),
  while every aligned indicator sits directly on `ta` and in the registry.
- **`defineIndicator` shape** — the spec's §13.5 example lists a separate `batch(input, params)`; this
  build instead takes `stream`/`restore`/`nan` and _derives_ `batch` via `makeIndicator`, so the
  streaming-parity law (batch = `collect(stream)`) holds by construction rather than trusting a
  hand-written batch. `inputs` is `'series' | 'bars'` and `params` is a name list (lightweight metadata
  for docs/discovery) rather than a schema object; the spec example is illustrative, as the Phase 3
  `options.*` namespace was.

## Deferred (tracked for later phases)

Volume profile is typical-price/​range-distributed (not tick-level); CVD here is a bar-based proxy
(trade-level aggressor CVD lives in `@totalfinance/structure`); order-book imbalance takes a single
level. Parametric MA-type selection for MACDEXT covers the common SMA/EMA/WMA/DEMA/TEMA/TRIMA/RMA set.

The highest-value next test investment is a **TA-Lib reference-vector ("golden") suite** diffing the
full catalog against trusted TA-Lib outputs — the current suite proves internal consistency
(batch≡stream, serialization, closed-form invariants and textbook shapes) but not cross-library
numeric parity.

## Next (Phase 5)

Advanced quant: stochastic processes and simulation, deeper risk/portfolio analytics, and the
remaining numerical machinery. The data / provider / adapter layer remains split out to its own
phase (Phase 8), sequenced last.
