# Phase 3 — Market structure and volatility

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

Phase 3 adds the trader-analytics layer on top of the Phase 2 numerical foundation: two new packages turn an
option chain into an implied-volatility surface, skew/smile metrics, event-vol probabilities, and
dealer-positioning estimates (GEX/DEX/vanna/charm, walls, max pain, scenario maps) plus options flow.

## What's new

### `@totalfinance/vol` (new)

- **Implied-vol surface** — `volSurface(chain, opts)` solves an IV per quote (or uses the quote's
  own `impliedVolatility`), builds per-expiry smiles, and offers `iv(strike, expiry)` / `lookup(...)` with
  diagnostics. Strike interpolation is shape-preserving **PCHIP**; cross-expiry interpolation is
  linear in **total variance `σ²·t`** (calendar-arbitrage-friendly). Sparse-data and extrapolation
  warnings; `raw` and `interpolated` models. Consumes the canonical `OptionQuote[]`.
- **Skew / smile** — `skew(chain, { expiry, … })` reports ATM-forward IV, 10/25-delta put & call IVs
  (located in call-delta space), 25/10-delta **risk reversals** and **butterflies**, put/call skew,
  and the ATM **skew slope & curvature** in log-moneyness. Configurable `riskReversalConvention`.
- **IV rank / percentile** — `ivRank`, `ivPercentile`, `ivStats` against a trailing IV history.
- **Event vol** — `expectedMoveFromIv` / `expectedMoveFromStraddle` (linked by `√(2/π)`), risk-neutral
  `probabilityInTheMoney` (`N(±d2)`), and `probabilityOfTouch` (GBM first-passage, **Monte-Carlo verified**).

### `@totalfinance/structure` (new)

- **Exposure** — `exposure(chain, opts)` computes per-contract and aggregate **GEX** (the spec
  formula `Γ·OI·mult·S²·0.01`), **DEX**, and **vega/vanna/charm** exposure. A sign **convention is
  required** (`callsPositivePutsNegative` | `dealerShortGamma` | `tradeSignedAggressor` | explicit
  `{calls,puts}`) and is echoed with `limitations` on every result. No ambiguous canonical `vex`.
- **Levels** — `zeroGamma`/`gammaRegime`, call & put **walls**, max/min gamma strike, **max pain**,
  largest call/put OI, **vanna/charm walls**, and **pin risk**.
- **Profiles & scenarios** — `byStrike([...])` / `byExpiry([...])` chart-ready aggregates, and
  `scenarioMap({ spot, volShock, timeAdvance, metrics })` that re-prices Greeks across a grid.
- **Flow** — `flow(trades, opts)`: NBBO **aggressor** classification, **sweep**/**block** detection,
  multi-leg **spread** estimation, `groupBy(...)`, and `rank(...)` by premium / volume-OI ratio. Every
  inferred classification is labeled an **estimate**.

## Quality

- Surface recovers its input smile at fitted strikes and interpolates between them; cross-expiry
  total-variance interpolation and extrapolation flags tested; IV solved back from mid prices.
- Skew put-skew relationships (RR < 0 call-minus-put, BF > 0, negative slope) and convention sign-flip.
- Exposure **GEX matches the spec formula** to machine precision; max pain matches a brute-force
  recomputation; convention sign-flips; scenario grid recomputes Greeks (ATM gamma falls as vol rises).
- Flow aggressor/sweep/block/spread/groupBy/rank all asserted.
- Full CI green at the Phase 3 milestone: **388 tests** across **10 packages** (the suite keeps
  growing with later hardening — see the README for the current count), strict TypeScript, lint,
  build, bundle budgets,
  and committed public API reports (`@totalfinance/vol`, `@totalfinance/structure` added).

## Scenario-map performance (acceleration decision)

The `scenarioMap` benchmark runs the spec's canonical **121 × 3 × 4** grid over a ~360-contract index
chain (~1 M Greek-pair evaluations) in **~270 ms** — interactive (sub-second) in pure TypeScript. Per
design law #10, no accelerated backend is introduced; acceleration stays a flagged candidate for
larger grids / real-time streaming.

## Decisions

- **API shape** — functions are exported per package (`import { volSurface, skew } from '@totalfinance/vol'`,
  `import { exposure, flow } from '@totalfinance/structure'`). The spec's `options.volSurface(...)` /
  `options.exposure(...)` namespace reads as illustrative; package-per-domain is the established pattern.
- **Chain input** — the canonical `OptionQuote[]` (and `OptionTrade[]` for flow) from `@totalfinance/core`;
  no new chain type was invented.
- **Scenario time** — numeric `timeAdvance` (years to advance, reducing each `T`) rather than the
  spec's `'now'/'close'/'tomorrowOpen'/'expiry'` labels, which would need market-hours data.

## Deferred (tracked for later phases)

Parametric surface fits (SVI/SABR/Heston/Dupire) with calendar/butterfly-arbitrage constraints;
term-structure & forward/calendar skew, realized-vs-implied & variance risk premium; event-vol
decomposition (earnings/de-earned vol); extra exposure greeks (theta/vomma/speed/color) and OPEX-dated
walls; and deeper flow tags (opening-vs-closing, repeated prints, delta-adjusted premium, IV-change).

## Next (Phase 4)

TA parity (pure compute, no data-layer dependency): 100+ indicators, candlestick patterns, chart
types, price-action utilities, feature pipeline, and signal DSL. The data/provider/adapter layer is
split out to its own phase, sequenced last.
