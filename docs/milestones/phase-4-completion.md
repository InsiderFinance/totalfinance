# Phase 4.5 — TA completion backlog

> **Historical milestone record.** The baseline TA catalog and its compatibility/validation gates
> are complete. Unchecked or partial rows below are explicitly optional variants, data-layer-dependent
> work, or future ergonomic depth; they are not open core-library blockers. Current status lives in
> [`../library-alignment-spec.md`](../library-alignment-spec.md), and future work in
> [`../roadmap.md`](../roadmap.md).
>
> Tracking doc for reaching full TA parity + modern-TA coverage on top of the Phase 4 base
> (`@totalfinance/ta`, 172 registered indicators). Worked incrementally; each slice ships with
> batch≡stream parity, serializable streams, boundary validation, tests, and green CI. npm version
> stays `0.0.1`.

Benchmarks: [TA-Lib function list](https://ta-lib.github.io/ta-lib-python/funcs.html) and
[pandas-ta-classic](https://xgboosted.github.io/pandas-ta-classic/indicators.html) (192 category
indicators + candles).

Legend: `[ ]` todo · `[x]` done · `[~]` partial/aliased · names are TotalFinance camelCase
(TA-Lib `CDL*`/`WILLR`-style and pandas snake_case reachable via the alias layer once built).

---

## P0 — TA-Lib parity ✅ COMPLETE (2026-06-23)

### Cycle — Hilbert Transform (shared `HilbertCore`, `./cycle`)

- [x] `htDcPeriod` — dominant cycle period
- [x] `htDcPhase` — dominant cycle phase
- [x] `htPhasor` — `{ inPhase, quadrature }`
- [x] `htSine` — `{ sine, leadSine }`
- [x] `htTrendMode` — 0 cycle / 1 trend
- [x] `htTrendline` — instantaneous trendline

### Overlap / stat / momentum / operators (`./stats`)

- [x] `ma` — MA-type dispatcher `{ period, maType }`
- [x] `mavp` — MA with a per-bar variable period (batch)
- [x] `midpoint` — (max + min) / 2 of a series over period
- [x] `midprice` — (highest high + lowest low) / 2 over period (bars)
- [x] `bop` — balance of power
- [x] `stochFast` — fast stochastic `{ k, d }`
- [x] `beta` — beta vs a benchmark series (paired input; `pairs()` zips two series)
- [x] `correl` — Pearson correlation over a window (paired input)
- [x] `rollingMin` / `rollingMax` / `rollingSum`
- [x] `rollingMinIndex` / `rollingMaxIndex` — bars-ago of the window extreme
- [x] `rollingMinMax` — `{ min, max }`
- [x] `rollingMinMaxIndex` — `{ minIndex, maxIndex }`

### Candle wrappers / aliases (`./candle-aliases`)

- [x] `cdlPattern(bars, name | 'all')` — run one (TotalFinance or `CDL*` name) or scan all
- [x] `cdlInside` — inside-bar pattern (added to the catalog → 62 patterns)
- [x] TA-Lib `CDL*` name aliases (`CDL_ALIASES`) → full catalog, `resolveCandleName`

---

## P1 — Modern TA / pandas-ta coverage

### Momentum / oscillators — tractable set done (`./momentum-ext`)

- [x] `bias` · `brar` · `cfo` · `centerOfGravity` · `coppock` · `cti` · `efficiencyRatio`
- [x] `elderRay` · `forecastOscillator` · `kdj` · `pgo` · `psychologicalLine` · `pvo`
- [x] `relativeVigorIndex` · `slope` · `smiErgodic` · `trixHistogram` · `volumeWeightedMacd`
- [x] **complex, smoothed/cycle family:** `qqe` · `rsx` (Jurik) · `schaffTrendCycle` · `laguerreRsi`
      · `inertia` (linreg of RVI)
- [x] **complex, structural family:** `tdSequential` (DeMark setup+countdown core) · `squeeze` (TTM)
      · `squeezePro` (3 compression levels) · `projectionOscillator` (Widner)

### Moving averages / overlap — done (`./overlap-ext`)

- [x] `fwma` · `gannHighLowActivator` · `holtWinterMa` · `jma`
- [x] `maRibbon` · `pascalWma` · `rainbowMa` · `sineWma` · `symmetricWma` (= `trima`)
- [x] `vwapBands` · `sessionVwap` (periodic reset) · `rollingAnchoredVwap` (auto-anchored to rolling extreme)
- [x] `zlma` (alias → `zlema`), `hl2`/`hlc3`/`ohlc4`/`wcp` price aliases

### Trend — done (`./trend-ext`)

- [x] `choppinessIndex` · `chandeKrollStop` · `centralPivotRange` (prior-bar CPR)
- [x] `linearDecay` · `exponentialDecay` · `increasing` · `decreasing` (strict/non-strict)
- [x] `longRun` · `shortRun` (two-series, `pair` input) · `pMax` (MA-Supertrend) · `qstick`
- [x] `trendSignals` · `ttmTrend` · `verticalHorizontalFilter` · `crossSignals`

### Volatility / channels — done (`./volatility-ext`)

- [x] `aberration` · `accelerationBands` · `holtWinterChannel`
- [x] `massIndex` · `priceDistance` · [x] `relativeVolatilityIndex` (done — `inertia` depends on it)
- [x] `elderThermometer` · `ulcerIndex`
- [x] `atrBands` · `percentAtr` · `volatilityStop`

### Volume — done (`./volume-ext`)

- [x] `archerObv` · `marketFacilitationIndex` · `priceVolume`
- [x] `priceVolumeRank` · `volumeOscillator` · `williamsAd`
- [x] `efi`→`forceIndex`, `emv`→`easeOfMovement`, `kvo`→`klinger` (direct aliases)

---

## P2 — Trader-useful price action

> Reconciliation: a large part of this list already shipped in `./price-action` (batch utilities,
> because swing confirmation needs forward bars): `breakOfStructure`/`changeOfCharacter` = `marketStructure`
> (BOS/CHoCH events); `sessionHighLow` = `sessionRanges`; `openingRangeLevels` = `openingRange` +
> `openingRangeBreakout`; `fibPivot` = `pivots(bar, 'fibonacci')`; plus `swings`/`fractals`/`gaps`/
> `supportResistance`/`trendlines`. The new streaming SMC detectors + the gaps below are what remained.

- [x] `fairValueGaps` · `orderBlocks` · `liquiditySweeps` (P2a — streaming, `./price-action-ext`, new
      `price-action` category)
- [~] `breakOfStructure` · `changeOfCharacter` = `marketStructure` (BOS/CHoCH) in `./price-action`
- [~] `sessionHighLow` = `sessionRanges` · `openingRangeLevels` = `openingRange`/`openingRangeBreakout`
- [~] `fibPivot` = `pivots(bar, 'fibonacci')`
- [x] `equalHighs` · `equalLows` (liquidity pools) — P2b (streaming, causal `SwingTracker`)
- [x] `atrTrailingStop` (Vervoort/UT-Bot) · `swingTrailingStop` (structure) — P2b
- [x] `fibRetracement` (2-anchor) · `fibExtension` (3-anchor ABC) — P2c (pure functions, `./price-action`)
- [x] `previousDayHighLow` · `previousWeekHighLow` = `previousSessionLevels(bars, sessionIds)` — P2c
- [x] `orbRetest` · `gapFill` (lifecycle: retest / fill tracking) — P2c

**P2 price action complete.**

## P2 — Chart / bar construction

> `chart-types.ts` already had renko · lineBreak · kagi · pointAndFigure · rangeBars · tickBars ·
> volumeBars · dollarBars (streaming aggregators + batch). This slice added the information-driven bars.

- [x] `imbalanceBars` · `volumeImbalanceBars` · `dollarImbalanceBars` (de Prado, tick-rule signed)
- [x] `runBars` · `volumeRunBars` · `dollarRunBars` (dominant one-sided run)
- [ ] `timeBars` · `sessionBars` · `resampleOhlcv` (need timestamps; out of scope until the data layer)
- [ ] `atrRenko` · `percentRenko` · `logRenko` · PnF high/low-vs-close modes (renko/PnF variants — optional)

## P2 — Rolling feature engineering (`./features-ext`)

- [x] `shift` · `lag` · `diff` · `change` · `pctChange` · `cum` — slice 1
- [x] `zScore` · `normalize` · `rescale` · `rollingMedian` · `mad` · `standardError` — slice 1
- [x] `rollingQuantile` · `rollingRank` · `percentRank` · `winsorize` — slice 2
- [x] `skew` · `kurtosis` · `entropy` — slice 2
- [x] `covariance` · `rollingBeta`(=beta) · `rollingCorrelation`(=correl) · `rollingRegression` · `rSquared` — slice 3
- [x] `highestBars`(=rollingMaxIndex) · `lowestBars`(=rollingMinIndex) · `barSince` · `valueWhen` · `rollingMean`(=sma) — slice 3

**P2 complete** (price action · chart construction · rolling feature engineering).

---

## Non-indicator gaps (cross-cutting; revisit as families land)

- [x] Alias layer (`./aliases`): `resolveIndicator`/`resolveIndicatorName` map `williamsR`/`willr`/`WILLR`/
      `Williams %R` (case-insensitive, canonical-wins) to the registered indicator
- [x] Compatibility matrix: `compatibilityMatrixMarkdown` → `docs/guides/ta-compatibility.md` (TotalFinance
      vs TA-Lib vs pandas-ta vs TradingView; 164/267 mapped, rest are candlesticks/niche estimators)
- [x] Runtime validators for all enum/string params (Phase 4 hardening rounds 1–3)
- [~] Golden-vector tests (`golden-vectors.test.ts`): ~40 core TA-Lib indicators cross-checked against
  independent from-scratch textbook oracles (no shared code) at full-series precision; complex
  recursive/cycle indicators stay covered by closed-form + batch≡stream parity
- [x] Per-indicator warmup / lookahead / displacement docs (`./warmup` + `docs/guides/ta-warmup.md`):
      `indicatorWarmups()` measures warmup for all 267 via `explain().warmup` at canonical params;
      lookahead/displacement are structurally zero (documented in the header)
- [x] Stream snapshot schema versioning (`framework.ts`): `SCHEMA_VERSION` + `checkSnapshotVersion`;
      `indicator.stream(...).toJSON()` stamps `v` centrally, `fromJSON` rejects newer/invalid versions
      (typed `InputError`) and accepts legacy (no-`v`) snapshots as v1 — no per-indicator changes
- [~] Batch/stream parity tests (done for the Phase 4 catalog; extend to every new indicator)
- [ ] Pipeline support for every indicator (generic `applySeries`/`applyBars` exists; add named methods)
- [ ] Generated registry docs incl. params, defaults, warmup, output shape, aliases, examples

---

## Progress log

- 2026-06-23: backlog opened. Starting P0 (Hilbert cycle family, overlap/stat/operators, candle wrappers/aliases).
- 2026-06-23: **P0 complete.** Added the Hilbert cycle family (`./cycle`), overlap/stat/operators
  (`./stats`), and candle wrappers/aliases (`./candle-aliases`); `inside` added to the candle catalog
  (62 patterns). Registry grew 172 → **193** indicators (new `cycle` & `statistic` categories; new
  `pair` input kind). `@totalfinance/ta` now exports 317 symbols. Full CI green at **580 tests**. Next: P1
  (modern-TA / pandas-ta momentum, MA, trend, volatility, volume).
- 2026-06-23: **P1a-1 done** — 18 tractable modern-momentum indicators (`./momentum-ext`): bias, CFO,
  forecast oscillator, Coppock, CTI, efficiency ratio, center of gravity, psychological line, slope,
  PVO, Elder Ray, BRAR, KDJ, RVGI, PGO, TRIX histogram, SMI Ergodic, volume-weighted MACD. Registry
  193 → **211**, 348 exports, **593 tests** green. Next: P1a-2 (QQE, RSX, Schaff, Laguerre, TD
  Sequential, Squeeze/Pro, projection osc, inertia).
- 2026-06-23: **P1a-2 part 1 done** — smoothed/cycle oscillators: `laguerreRsi`, `qqe`, `rsx` (Jurik
  cascade; warmup-gated), `schaffTrendCycle`, plus `relativeVolatilityIndex` (in `./volatility`) and
  `inertia` (linreg of RVI). Registry 211 → **217**, 360 exports, **603 tests** green.
- 2026-06-23: **P1a-2 complete** — structural oscillators: `squeeze` (TTM, BB-inside-KC + LazyBear
  momentum), `squeezePro` (3 KC compression levels via a shared `SqueezeCore`), `projectionOscillator`
  (Widner projection bands), `tdSequential` (DeMark setup 1–9 + countdown 1–13 core). Registry
  217 → **221**, 371 exports, **610 tests** green. **P1a (momentum) done.** Next: P1b (modern MAs/overlap).
- 2026-06-23: **P1b complete** (`./overlap-ext`) — weighted MAs (`fwma`, `sineWma`, `pascalWma`,
  `symmetricWma`=trima), `jma` (Jurik), `holtWinterMa`, `rainbowMa`, `maRibbon`, `gannHighLowActivator`,
  `vwapBands`, `sessionVwap`, `rollingAnchoredVwap`, plus `hl2/hlc3/ohlc4/wcp/zlma` aliases. Registry
  221 → **233**, 398 exports, **628 tests** green. **Bug fix:** a short-circuit in array-of-independent-
  substream loops starved the longer sub-streams — corrupted `maRibbon` warmup and **`kst` values**
  (latent since Phase 4); both now feed every sub-stream each bar. Next: P1c (modern trend).
- 2026-06-23: **P1c complete** (`./trend-ext`) — 15 modern-trend indicators: `choppinessIndex`,
  `chandeKrollStop` (two-stage ATR stops), `centralPivotRange` (prior-bar pivot/tc/bc), `linearDecay`
  & `exponentialDecay` (pandas-ta decay floors), `increasing`/`decreasing` (strict + non-strict),
  `longRun`/`shortRun` (two-series `pair` input — both fast & slow trending), `pMax` (MA-based
  Supertrend trailing stop), `qstick` (SMA of body), `ttmTrend`, `verticalHorizontalFilter`, and the
  `trendSignals`/`crossSignals` entry/exit state machines. Registry 233 → **248**, 421 exports,
  **649 tests** green. Next: P1d (modern volatility / channels).
- 2026-06-23: **P1d complete** (`./volatility-ext`) — 10 volatility indicators/channels:
  `aberration` (SMA-of-HLC3 ± ATR), `accelerationBands` (Price Headley), `holtWinterChannel`
  (recursive HWMA + variance bands), `massIndex` (EMA-ratio bulge), `priceDistance` (pdist),
  `elderThermometer` (market thermometer + long/short flags), `ulcerIndex` (RMS drawdown), `atrBands`
  (SMA ± k·ATR), `percentAtr` (ATRP), `volatilityStop` (ATR trailing stop). Channel outputs reuse the
  shared `ChannelPoint {upper, middle, lower}`. Registry 248 → **258**, 441 exports, **666 tests**
  green. Next: P1e (modern volume).
- 2026-06-23: **P1e complete** (`./volume-ext`) — 6 volume indicators + 3 aliases: `archerObv`
  (OBV + fast/slow EMAs + long/short run signals), `marketFacilitationIndex` (BW MFI = range/volume),
  `priceVolume` (close·volume, optional signed), `priceVolumeRank` (1–4 price/volume direction rank),
  `volumeOscillator` (EMA-spread of volume), `williamsAd` (price-based A/D cumulation), plus
  `efi`→`forceIndex`, `emv`→`easeOfMovement`, `kvo`→`klinger`. Registry 258 → **267**, 454 exports,
  **678 tests** green. **P1 (all modern pandas-ta momentum/MA/trend/volatility/volume) complete.**
  Next: cross-cutting items (alias layer, compatibility matrix, golden-vector tests) then Phase 5.
  Note: 3 stochastic tests in `packages/options` & `packages/vol` (Monte-Carlo first-passage,
  Crank–Nicolson convergence, engine comparison) are intermittently flaky — they pass on re-run and
  are unrelated to the TA work.
- 2026-06-23: **Alias layer + compatibility matrix done** (`./aliases`) — curated `ALIAS_TABLE`
  (164 rows) drives case-insensitive `resolveIndicator`/`resolveIndicatorName` (canonical-exact >
  case variant > external alias) so `WILLR`/`willr`/`Williams %R` all reach `williamsR`, plus
  `aliasesOf` and `compatibilityMatrixMarkdown` → `docs/guides/ta-compatibility.md` (generated by
  `tools/ta-compatibility-doc.ts`). Table targets validated against the live registry at load. Registry
  unchanged at **267**, 460 exports, **687 tests** green. Next cross-cutting: golden-vector tests,
  per-indicator warmup/lookahead docs, snapshot schema versioning — then P2.
- 2026-06-23: **Golden-vector tests done** (`golden-vectors.test.ts`) — ~40 core indicators
  (sma/ema/wma/rma/dema/tema, rsi/macd/roc·family/cmo/cci/williamsR/stochastic/bop, standardDeviation/variance/
  bbands/atr/natr, obv/adLine/mfi, linreg/linregSlope/tsf/aroon, midpoint/midprice, the price
  transforms/trueRange, rollingMin/Max/Sum) cross-checked against INDEPENDENT from-scratch textbook
  oracles in the test file (Wilder RSI/ATR, population std, EMA-cascade DEMA/TEMA, least-squares
  linreg) at 8-dp full-series precision. All matched on the first run — no implementation divergence.
  **708 tests** green. Next cross-cutting: per-indicator warmup/lookahead docs, snapshot schema
  versioning — then P2.
- 2026-06-23: **Snapshot schema versioning done** (`framework.ts`) — `SCHEMA_VERSION = 1` +
  `checkSnapshotVersion`. A central `VersionedStream` wrapper (returned by `indicator.stream()`)
  stamps `v` onto `toJSON()` at the facade boundary; `indicator.fromJSON` validates it (rejects
  newer/invalid versions with a typed `InputError`, accepts legacy no-`v` snapshots as v1) — zero
  changes to the 267 per-indicator `toJSON`/`restore` methods, batch path untouched. Composed
  indicators are versioned at the root only. 460→**462** exports, **715 tests** green. Next
  cross-cutting: per-indicator warmup/lookahead/displacement docs — then P2.
- 2026-06-23: **Warmup/lookahead/displacement docs done** (`./warmup` + `docs/guides/ta-warmup.md` via
  `tools/ta-warmup-doc.ts`) — `indicatorWarmups()` measures warmup for all **267** indicators
  authoritatively via `explain(probe, canonicalParams).warmup` (not hand-written formulas), driven by
  an 81-entry canonical-param map (one `anchor` override for `anchoredVwap`). A test proves every
  indicator instantiates and emits within the probe (param map is complete). Lookahead and
  displacement are structurally **zero** (causal stream + bar-aligned output) — documented in the
  header with the Ichimoku/DPO charting-displacement caveats. 462→**465** exports, **720 tests** green.
  **All cross-cutting items in this section are now done.** Next: P2 (price action / chart construction
  / rolling features).
- 2026-06-23: **P2a done** (`./price-action-ext`, new `price-action` category) — the headline streaming
  SMC detectors: `fairValueGaps` (3-bar imbalance, optional `minGapPct` filter), `orderBlocks` (last
  opposite candle before a displacement break, `lookback`-bounded), `liquiditySweeps` (rolling-extreme
  taken out then rejected). All causal → full streaming indicators (parity + serializable), dense
  per-bar `{direction, ...}` records (0 = no event) like the candlestick patterns. Also reconciled the
  P2 backlog: BOS/CHoCH/session/ORB/fibPivot already shipped as `./price-action` batch utilities.
  Registry 267 → **270**, 473 exports, **732 tests** green. Next: P2b (equal highs/lows, fib
  retracement/extension, prior-period levels, ORB-retest/gap-fill lifecycle, ATR/swing trailing stops).
- 2026-06-24: **P2b done** (`./price-action-ext`) — a causal `SwingTracker` primitive (a swing high/low
  is confirmed `strength` bars after it forms, so detection lags but never looks ahead) underpins
  `swingTrailingStop` (ratcheting structure stop trailing the latest confirmed swing low/high) and
  `equalHighs`/`equalLows` (consecutive swings within `tolerance` → liquidity pools, dense
  `{detected, level, count}`). Plus the standalone `atrTrailingStop` (Vervoort/UT-Bot close-anchored
  ATR trail — distinct from the extreme-anchored `chandelierExit` and the trend-var `volatilityStop`).
  All streaming, full parity + serializable. Registry 270 → **274**, 482 exports, **741 tests** green.
  Next: P2c (fibRetracement/fibExtension pure fns, previousDay/WeekHighLow, orbRetest/gapFill).
- 2026-06-24: **P2c done** (`./price-action` batch utilities) — `fibRetracement` (2-anchor,
  `end + (start−end)·r`), `fibExtension` (3-anchor ABC, `c + (b−a)·r`), `previousSessionLevels` (the
  prior completed session's high/low/close aligned to each bar — covers previousDay/WeekHighLow via
  the caller's session ids), `orbRetest` (pullback to a broken opening-range edge, re-armed per
  breakout), and `gapFill` (open-vs-prior-close gaps with fill tracking + `minPercent`). Pure/batch
  functions (no streaming state) → no registry change; 482 → **492** exports, **751 tests** green.
  **P2 price action complete.** Next: chart/bar construction (imbalance/run bars) + rolling feature
  engineering, then Phase 5.
- 2026-06-24: **P2 chart construction (info-driven bars) done** (`./chart-types`) — the de Prado
  imbalance & run bars: `imbalanceBars`/`volumeImbalanceBars`/`dollarImbalanceBars` (close on
  `|Σ sign(Δclose)·w|`) and `runBars`/`volumeRunBars`/`dollarRunBars` (close on the larger one-sided
  run `max(Σ_buy w, Σ_sell w)`), `w ∈ {1, volume, close·volume}`. A new `InfoBarAggregator` carries the
  tick sign continuously across bar boundaries (persistent prior close); serializable + streaming
  factories on `aggregators`. Output is plain OHLCV `BarInput` (drop-in, like the other bars). Batch
  fns → no registry change; 492 → **500** exports, **758 tests** green. Next: P2 rolling feature
  engineering (shift/difference/zScore/rolling stats/…), then Phase 5.
- 2026-06-24: **P2 rolling features slice 1 done** (`./features-ext`) — lag operators
  `shift`/`lag`(alias), `diff`/`change`(alias), `pctChange`, `cum`, and rolling stats `zScore`
  (population), `normalize`/`rescale` (min-max, midpoint on flat), `rollingMedian`, `mad`, `standardError`
  (sample SEM). All causal series→series streaming indicators + parity + serializable, registered
  under `statistic`. Registry 274 → **286**, 513 exports, **770 tests** green. Next: slice 2
  (rollingQuantile/Rank/percentRank/winsorize, skew/kurtosis/entropy) + slice 3 (covariance/
  rollingRegression/rSquared, barSince/valueWhen + aliases), then Phase 5.
- 2026-06-24: **P2 rolling features slice 2 done** (`./features-ext`) — `rollingQuantile` (type-7
  interp), `rollingRank` (1-based ordinal), `percentRank` (percentile position [0,100]), `winsorize`
  (clip to window quantiles), `skew` (bias-corrected G1), `kurtosis` (bias-corrected excess G2,
  verified = scipy −1.2 on [1..5]), `entropy` (pandas-ta value-as-fraction Shannon, bits). Reused the
  `RollingStatStream` kind-dispatch. Registry 286 → **293**, 522 exports, **781 tests** green. Next:
  slice 3 (covariance/rollingRegression/rSquared on `pair` input, barSince/valueWhen, thin aliases),
  then Phase 5.
- 2026-06-24: **P2 rolling features slice 3 done — P2 COMPLETE** (`./features-ext`) — paired
  `covariance` (sample/population), `rSquared` (squared correlation), `rollingRegression`
  (`{slope, intercept, rSquared}`) via a shared `PairWindowStream`/moment helper; `barSince` (bars since the
  condition `>0`) and `valueWhen` (source at the `occurrence`-th most recent true, `pair` input); plus
  aliases `rollingMean`=sma, `rollingBeta`=beta, `rollingCorrelation`=correl, `highestBars`=
  rollingMaxIndex, `lowestBars`=rollingMinIndex. Registry 293 → **303**, 535 exports, **793 tests**
  green. **All of P2 (price action / chart construction / rolling features) is done.** Next: Phase 5
  (Advanced Quant).
- 2026-06-24: **External golden-vector certification — TA-Lib + pandas-ta** (`./test/golden`,
  `tools/golden/`). Installed the **TA-Lib 0.6.4 C reference** (158 functions) and **pandas-ta
  0.4.71b0**, and built a committed certification layer: a deterministic 256-bar OHLCV fixture
  (`reference-ohlcv.json`) plus reference outputs (`talib-golden.json`, `talib-candles-golden.json`,
  `pandas-ta-golden.json`) emitted by `tools/golden/generate*.py` — so CI needs no Python.
  - **Coverage audit** (`docs/compatibility/talib-coverage.md`, generated): **139/158** TA-Lib
    functions = **139/139 of the value-bearing catalog**, 0 genuine gaps (the 19 excluded are trivial
    element-wise libm: `SIN`/`SQRT`/`ADD`/…). MAVP was already covered by the batch fn `technical_analysis.mavp`.
  - **`talib-golden.test.ts` (153 assertions):** ~50 functions match TA-Lib **bit-for-bit** (~1e-13);
    the rest are certified via documented bridges/convergence (TotalFinance follows the TradingView/
    pandas-ta conventions where they differ from TA-Lib's C seedings). Differences catalogued in
    `docs/compatibility/talib-differences.md`.
  - **`talib-candles-golden.test.ts`:** all 61 `CDL*` patterns; ~95% directional agreement past
    warmup (TotalFinance uses fixed body/shadow ratios vs TA-Lib's adaptive averaging engine).
  - **`pandas-ta-golden.test.ts` (11):** ao/cmf/chop/coppock/cti/massi/efi/tsi/vortex exact;
    bias(×100)/supertrend bridged.
  - **`registry-property.test.ts` (622):** batch≡stream + JSON-round-trip proven for **every** one of
    the 303 indicators, plus no-raw-throws on degenerate inputs, bounded oscillators, typed param
    errors. This caught two real bugs — **KAMA** seeded with an SMA instead of Kaufman's previous-price
    (now matches TA-Lib to 1e-14), and **`holtWinterMa`** serialized a `v` field that collided with the
    reserved schema-version key (renamed `vel`; added a framework guard against future collisions).
  - Whole workspace **793 → 1,584 tests** green under `pnpm run ci`; 303 indicators, all 10 API
    reports up to date. Next: Phase 5 (Advanced Quant).
- 2026-06-24: **Test-hardening round — full TA-Lib parity + new-indicator certification.** The
  catalog grew to **334 registered indicators** (math transforms/operators, Ehlers DSP/sine cycles,
  SMC sweep, drawdown, cross utilities, cdlZ/tosStdevAll/amat). Closed the test gaps:
  - **TA-Lib 158/158.** Added the 15 Math Transform + 4 Math Operator wrappers (`acos`…`tanh`,
    `add`/`sub`/`mult`/`div`) and certified them **exactly** against TA-Lib (transforms on an
    in-domain unit series, operators on the high/low pair). `talib-golden.test.ts` → **172** assertions;
    coverage doc now **158/158, 0 gaps**.
  - **pandas-ta expansion** (`pandas-ta-golden.test.ts` → 17): exact `psl`, `vhf`, `ebsw`
    (original-formula), `drawdown`, `cdlZ` (ddof 0); `amat` run-flags ≥90% agreement. `cg`/`cfo`/
    `tos_stdevall` documented as different definitions (certified by closed-form instead).
  - **Behavioral contract tests** (`utilities-behavioral.test.ts`, 11): closed-form `crossover`/
    `crossany`, `smcSweep` (+1/−1 sweeps), `volumeProfile` (POC/value-area/total), `tosStdevAll`
    (OLS line ± k·σ), `mavp` (constant-period == SMA; per-bar selection), `msw`/`ebsw` bounds.
  - The registry-property suite now auto-covers all **334** indicators (batch≡stream + JSON
    round-trip). Per-family **tolerance audit** added to `talib-differences.md`. Docs regenerated
    (registry/warmup/aliases/coverage). Whole workspace **1,584 → 1,697 tests** green under
    `pnpm run ci`. Next: Phase 5 (Advanced Quant).
- 2026-06-25: **Review-driven hardening (round 3).** Fixed a real `msw` (Mesa Sine Wave) alignment
  bug — it emitted at warmup `period−1`; tulipy uses `period`, so cycle signals were shifted one bar
  early. Values at index ≥ period already matched tulipy bit-for-bit; the gate now agrees. Added a
  **tulipy golden suite** (independent C reference): `msw` (warmup-aligned, values match except
  isolated phase singularities) plus exact `crossover`/`crossany`/`qstick`/`williamsAd`/
  `marketFacilitationIndex`. Made `tosStdevAll` warmup rows **shape-stable** (band arrays of NaN
  placeholders, not empty) and documented the period-omitted = expanding-window contract. Added an
  **exhaustive deep-entrypoint test** that imports every `package.json` export (caught the missing
  `@totalfinance/ta/math` + `/performance-ext` vitest aliases). Reframed `catalog-parity` to separate
  **name resolution** from **numerical proof**, and added a proof-coverage test with an explicit,
  bounded name-only allowlist (so the gap is tracked, not hidden). Expanded pandas-ta golden by 16
  (MAs `fwma`/`hma`/`pwma`/`sinwma`/`swma`/`vwma`/`zlma`/`rma`, stats `zScore`/`mad`/`skew`/
  `kurtosis`/`median`, `ulcerIndex`, `priceDistance`; `alma` ~close) → catalog numerical coverage
  **55% → 63%**. Fixed `cdl_z` generator metadata (ddof 0). Whole workspace **1,697 → 1,722 tests**
  green under `pnpm run ci`. Next: Phase 5 (Advanced Quant).
- 2026-06-25: **Proof-accounting hardening (round 4).** Fixed an integrity gap the review caught:
  catalog proof-coverage was counting every _present_ golden fixture as proven, but a few are
  committed for reference and **not asserted** (`nvi`/`pvi`/`pgo`; the documented TA-Lib differences
  `MACDFIX`/`BETA`/`ADXR`/`STOCHRSI`/`HT_DCPHASE`/`HT_SINE`/`HT_TRENDMODE`). Added
  `test/golden/proof-manifest.ts` as the single source of truth (asserted vs reference-only), drove
  `provenSet()` and the parity loops from it, and added a manifest-integrity test that every fixture
  is classified exactly once. Honest catalog coverage corrected **63% → 59%**. Added `requireCoverage`
  to the pandas-ta and tulipy exact groups (TotalFinance must emit a value wherever the reference does —
  no silent null-skip; enforced from TotalFinance's first value so a longer leading warmup is tolerated
  but internal gaps fail). Split the truly-exact pandas group (~1e-7) from the seed-sensitive
  `rma`/`zlma` (converge ~1e-5) to match the doc wording. Stamped a `meta` provenance block
  (generator, reference + version, Python/package versions, seed, dataset) into every fixture —
  TA-Lib 0.6.4, pandas-ta 0.4.71b0, tulipy 0.8.4. Whole workspace **1,722 → 1,724 tests** green under
  `pnpm run ci`. Next: Phase 5 (Advanced Quant).
- 2026-06-25: **Review round 5 — coverage-run + manifest-guard fixes.** (1) The exhaustive
  deep-entrypoint test imports the whole package graph in one test; under `--coverage` that exceeded
  Vitest's 5s default and failed the coverage run — gave it an explicit 30s timeout, so
  `vitest run packages/ta/test --coverage` now passes with the default global timeout (42 files,
  1,345 tests; 94.91% stmts / 85.3% branches). (2) Added the missing tulipy manifest-integrity test
  (the manifest comment claimed both pandas + tulipy guarded the partition, but only pandas did) —
  `TULIPY_ASSERTED` is now validated against the fixture contents. (3) Softened a docs sentence that
  overstated proof: only `tos_stdevall` has a closed-form oracle; `nvi`/`pvi`/`pvt`/`pgo`/`cg`/`cfo`
  carry only the registry-wide structural guarantees and are tracked as name-only. Whole workspace
  **1,725 tests** green under `pnpm run ci`. Next: Phase 5 (Advanced Quant).
- 2026-06-25: **Long-tail numerical proof — extended pandas-ta suite.** Closed the largest remaining
  honesty gap: 89 catalog names were tracked as _name-resolution only_, not externally certified. Ran
  an empirical sweep of all 89 against pandas-ta 0.4.71b0 (best-field + integer-lag + abs/rel/ratio/
  corr analysis on the committed reference series) to classify each by evidence rather than guesswork.
  Added `tools/golden/generate_pandas_ta_ext.py` (59 reference vectors with a `meta` provenance block)
  and `test/pandas-ta-ext-golden.test.ts`, which **numerically certifies 39 fixtures** plus **4
  closed-form oracles**: 28 exact (≤1e-6; most ≤1e-13 — `decreasing`/`increasing`/`efficiencyRatio`/
  `holtWinterMa`/`logReturns`/`returns`/`mcginley`/`rollingQuantile`/`slope`/`accelerationBands`/
  `brar`/`donchian`/`easeOfMovement`/`elderRay`/`heikinAshi`/`ichimoku`/`priceVolume`/`priceVolumeRank`/
  `pvo`/`relativeVigorIndex`/`elderThermometer`/`ttmTrend`/`qqe`/`stochRsi`/`aberration`/
  `chandeKrollStop`/`keltner`/`forecastOscillator`), 6 converge-after-seed (`superSmoother`/
  `holtWinterChannel`/`adx`/`dmi`/`rsx`/`kdj`), 3 documented percent-scale bridges (`pvt`÷100,
  `kst`÷100, `smiErgodic`×100), 1 exact integer flag (`squeeze` on-state), and closed-form
  `adxr`/`standardError`/`lag`/`centralPivotRange`. Real findings along the way: pandas-ta's **CFO is the
  one-bar TSF-forecast variant** (so it certifies TotalFinance's `forecastOscillator`, not `cfo`);
  `nvi`/`pvi` use an additive-percent accumulation vs TotalFinance's classic multiplicative Fosback form;
  `dpo` follows classic Pring (price-in-past − SMA) vs pandas-ta's shifted-average; `entropy` is true
  windowed Shannon vs pandas-ta's double-rolled normalization; `jma` differs ~2% (parameterized vs
  fixed Jurik) — all kept name-only and documented honestly. Extended `proof-manifest.ts` with the new
  asserted/fixture-only/closed-form partitions, drove `catalog-parity` `provenSet()` from them, shrank
  the name-only allowlist **89 → 47**, and raised the coverage floor **55% → 70%** (actual **~59% →
  ~78%** of the ~216-name catalog). Whole workspace **1,725 → 1,768 tests** green under `pnpm run ci`
  (build, api:check, lint, typecheck, format all clean; options engines passed this run). Next: Phase 5
  (Advanced Quant).
- 2026-06-25: **"Do it all" — closed-form oracles, talib modes, robustness matrix, microstructure,
  adaptive candles.** A five-front push closing the gaps from the tiered completeness review.
  (1) **Closed-form oracle blitz** (`closed-form-oracles.test.ts`): certified **38** long-tail
  indicators that no single external library pins down — recomputing each one's published formula from
  golden-certified primitives (SMA/EMA/VWMA/ATR/STDDEV/LINREG/TRIX/OBV/RMA) and asserting equality
  (vosc, vwmacd, aobv, nvi, pvi, cvi, hvol, dsp, vwap, rainbow, mmar, vidya, decay, edecay, cg, cfo,
  trixh, dpo, lrsi, fisher, tsignals, xsignals, beta, macdfix, macdext, pgo, rvi, kvo, entropy, emv,
  ce, hilo, long/short_run, inertia, stc, po, pmax). Real bug-class coverage: caught that
  `volumeOscillator` uses EMA (not SMA), `beta` is financial-beta-on-returns (`cov(Δx,Δy)/var(Δy)`,
  correcting a stale doc), pandas-ta's CFO is the TSF-forecast variant (≡ TotalFinance `forecastOscillator`),
  and `dpo`/`entropy`/`nvi`/`pvi` follow classic conventions. Catalog numerical proof **~78% → ~96%**;
  name-only allowlist **47 → 8** (only Jurik `jma`, `sarext`, `squeeze_pro`, `td_seq`, `vfi`, and the
  Ehlers HT trio remain). (2) **TA-Lib `talib: true` modes** (`talib-modes.test.ts`): opt-in exact
  reproduction — `cmo` Wilder (`2·RSI−100`), `obv` `volume[0]` seed — plus STOCHRSI proven exact vs
  TA-Lib (its `fastk` is the raw %K → `kPeriod: 1`). (3) **Degenerate-OHLC robustness matrix**
  (`degenerate-matrix.test.ts`): every registered indicator across 9 market pathologies (gaps, halts,
  splits, limit-lock, inverted/zero/negative bars, spikes) + 0/1/2-bar inputs — no raw throws, aligned
  output, **no Infinity leaks** (except correct IEEE math), batch≡stream preserved. (4) **Microstructure
  tier** (`microstructure.ts`, new `@totalfinance/ta/microstructure`): trade/quote-level Lee-Ready + tick
  aggressor classification, cumulative volume delta (streaming + serializable `CvdAggregator`),
  tick-level volume profile (POC/value-area/footprint delta), multi-level order-book imbalance,
  size-weighted microprice, and footprint bars — all hand-oracle-verified. (5) **Adaptive candlestick
  engine** (`candle-talib.ts`, new `@totalfinance/ta/candle-talib`): TA-Lib's `TA_SetCandleSettings`
  trailing range averages + signed ±100 encoding, asserted bit-for-bit vs the TA-Lib golden for
  CDLDOJI/CDLMARUBOZU/CDLCLOSINGMARUBOZU (foundation; remaining `CDL*` stay on the certified fixed-ratio
  detectors). Whole workspace **1,768 → 1,852 tests** green under `pnpm run ci`. Next: extend the
  adaptive candle engine to the full 61-pattern set; consider a TradingView/Pine golden harness for the
  last 8 name-only indicators.
- 2026-06-25: **Closing the last long-tail 8 → 4.** Pushed the remaining name-only set through
  chosen-public-formula oracles (the convention must be fixed before "proof" means anything): `jma`
  (public Jurik e0/e1/e2 recurrence), `vfi` (Katsanos capped signed money flow), `squeezePro`
  (LazyBear BB-in-KC momentum + low/mid/high flags), `tdSequential` (standard DeMark setup 1–9 /
  countdown 1–13) — all asserted exact in `closed-form-oracles.test.ts`. Investigated `sarext`:
  TotalFinance `psarExt` matches TA-Lib SAREXT's trend direction **255/255** but differs ~0.08 in value
  (each SAR reversal re-injects a seed difference), so it's a documented direction-exact bridge, not
  bit-for-bit — left name-only honestly. The Hilbert trio `ht_dcphase`/`ht_sine`/`ht_trendmode` stays
  name-only too (TotalFinance follows Ehlers; exact TA-Lib parity needs porting TA-Lib's distinct HT
  internals). Net: closed-form certified **38 → 42**, catalog proof **~96% → ~98%**, name-only
  allowlist **8 → 4** (`sarext` + HT trio), coverage floor raised to 95%. Whole workspace
  **1,852 → 1,856 tests** green under `pnpm run ci` (options engine flakiness confirmed unrelated —
  `packages/options` re-ran 111/111).
