# TotalFinance vs TA-Lib — intentional differences

TotalFinance implements **all 158** TA-Lib functions and certifies every value-bearing one against the
**TA-Lib 0.6.x C reference** (`packages/technical-analysis/test/talib-golden.test.ts`, 172 assertions;
`talib-candles-golden.test.ts`, 61 patterns). The large majority match TA-Lib **bit-for-bit** (to
~1e-13). This document catalogues the handful that differ _on purpose_, the reason, the measured
magnitude, and how to reproduce TA-Lib's exact value.

The unifying design choice: **where TA-Lib and TradingView/Pine (and pandas-ta) disagree, TotalFinance
follows the TradingView/pandas-ta convention** — because that is what traders see on charts and what
quants use in research. TA-Lib's differences are almost all _seeding_ idiosyncrasies of its C
implementation, not different formulas.

## Exact matches (no caveat)

SMA, EMA, WMA, DEMA, TEMA, TRIMA, T3, KAMA, MA, MIDPOINT, MIDPRICE, SAR, BBANDS, RSI, ROC, ROCP,
ROCR, ROCR100, MOM, TRIX, CCI, WILLR, MFI, AROON, AROONOSC, BOP, ULTOSC, STOCHF, TRANGE, AVGPRICE,
MEDPRICE, TYPPRICE, WCLPRICE, AD, LINEARREG (+ slope/intercept/angle), TSF, CORREL, STDDEV, VAR,
MAX, MIN, SUM, MINMAX, MAVP, and the window-index functions (after the convention note below).
These reproduce TA-Lib to floating-point noise.

`TRIX` also matches TA-Lib's **warmup index**: the first value lands at TA-Lib's lookback
`3·(period − 1) + 1`. (The bar before it, where the triple EMA exists but has no predecessor to take
a rate of change against, is warmup — not a `0`.)

## Seeding differences (converge to TA-Lib)

These use **Wilder's RMA seed** (the average of the first `period` values — TradingView's `technical_analysis.rma`),
whereas TA-Lib accumulates `period − 1` values then takes one Wilder step. Both are valid "Wilder
smoothing"; they differ only in the seed, and the difference decays like `(1 − 1/period)^k`. TotalFinance
matches TradingView's ADX/ATR exactly. Convergence to TA-Lib measured on the reference series:

| Function(s)                             | Convention                                                                                                                                                                    | Converges to TA-Lib within                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ATR`, `NATR`                           | includes the first bar's range (`TR[0] = H₀ − L₀`, per Wilder); TA-Lib drops it                                                                                               | ~1e-5 by ~5·period bars                        |
| `+DI`, `−DI`, `+DM`, `−DM`, `DX`, `ADX` | RMA seed (TradingView) vs TA-Lib's `period−1` accumulation                                                                                                                    | ~1e-2 by ~6·period bars                        |
| `ADXR`                                  | inherits the ADX seed (doubled), **and reaches back one bar further**: TotalFinance averages `ADX_t` with `ADX_{t−period}`; TA-Lib averages `ADX_t` with `ADX_{t−(period−1)}` | approximate; documented, not asserted strictly |
| `ADOSC`                                 | Chaikin A/D oscillator with EMA-seeded fast/slow (TradingView)                                                                                                                | ~1e-4 by ~60 bars                              |

To reproduce TA-Lib's ATR exactly: drop `TR[0]` and seed the Wilder average at index `period` with
`mean(TR[1..period])`.

## Different default, identical formula

| Function          | TotalFinance default                                                                                                                                                               | TA-Lib default                                                                        | Reproduce TA-Lib                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APO`, `PPO`      | EMA of fast/slow (TradingView)                                                                                                                                                     | SMA (`matype = 0`)                                                                    | exact vs TA-Lib `matype = 1` (certified)                                                                                                             |
| `MACD`, `MACDFIX` | line = `EMA(fast) − EMA(slow)`, each seeded independently (TradingView)                                                                                                            | fast EMA re-seeded at the slow period's start; line trimmed to the signal-valid index | use TA-Lib MACD if C-reference seeding is required                                                                                                   |
| `CMO`             | Chande's original simple sums (pandas-ta default)                                                                                                                                  | Wilder-smoothed (like RSI)                                                            | `cmo(…, { talib: true })` reproduces TA-Lib's Wilder CMO (`2·RSI − 100`) exactly (certified)                                                         |
| `STOCH` (slow)    | `stochastic` defaults to the _fast_ stochastic (`smoothK: 1`, raw %K); `smoothK > 1` SMA-smooths %K into the classic slow stochastic (`stochFast` is a pure alias of `stochastic`) | built-in slow %K (`slowk_period`)                                                     | `stochastic(bars, { kPeriod: fastk_period, smoothK: slowk_period, dPeriod: slowd_period })` reproduces TA-Lib STOCH (SMA matype) exactly (certified) |
| `STOCHRSI`        | `kPeriod`/`dPeriod` smooth the raw Stoch-RSI                                                                                                                                       | `fastk_period` is the Stoch lookback over RSI; `fastd_period` smooths                 | exact vs TA-Lib with `kPeriod: 1` (TA-Lib's `fastk` is the raw %K; certified)                                                                        |

## Encoding / convention differences

| Function                                   | Difference                                                                                                                                                                                                                                                                                                                                                                   | Bridge                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `RSI` (flat series)                        | When the window's average loss is zero (flat or monotonically rising prices), TotalFinance returns **100** (the RS → ∞ limit; TradingView). TA-Lib emits `0` there; pandas-ta emits `NaN`. On any series with both gains and losses the values are bit-for-bit identical.                                                                                                    | convention only — no bridge needed off the degenerate case                                    |
| `STOCH`/`STOCHF`, `STOCHRSI` (flat window) | When the window's high equals its low (a halt, a limit-locked session), %K is `0/0`. TotalFinance returns **0**, which is what TA-Lib's `STOCH`/`STOCHF` and pandas-ta's `stoch`/`stochrsi` both return. Note this is deliberately NOT the RSI convention above: RSI's degenerate case has a one-sided limit (RS → ∞), a flat stochastic window carries no direction at all. | none needed — TotalFinance matches both references here                                       |
| `DPO`                                      | TotalFinance uses Pring's causal form `close[t − shift] − SMA(close, period)[t]` with `shift = ⌊period/2⌋ + 1` — pandas-ta's `centered=True` result resolved BACKWARD so no value depends on a future bar. pandas-ta's `centered=False` computes `close[t] − SMA[t − shift]`, a different series. Certified by closed-form oracle.                                           | to compare with pandas-ta, shift its centered output forward by `shift` bars                  |
| `OBV`                                      | TotalFinance seeds at `0`; TA-Lib seeds at `volume[0]`. The series differ by that constant; **deltas are identical**.                                                                                                                                                                                                                                                        | `qkOBV + volume[0]` equals TA-Lib (certified)                                                 |
| `MAXINDEX`, `MININDEX`, `MINMAXINDEX`      | TotalFinance returns _bars since_ the extreme (TradingView `highestbars`/`lowestbars`, `0` = current bar); TA-Lib returns the _absolute_ array index.                                                                                                                                                                                                                        | `i − barsSince` equals TA-Lib's absolute index (certified)                                    |
| `MAMA`, `FAMA`                             | TotalFinance's MAMA is a **bars** indicator using the `(H+L)/2` median price (Ehlers' original); TA-Lib applies whatever single series you pass (typically close). Algorithm matches to ~1e-8 in steady state.                                                                                                                                                               | feed equal-H/L bars (`high = low = close`) to reproduce TA-Lib's close-based MAMA (certified) |
| `BETA`                                     | TotalFinance's `beta` is the **financial** beta on returns (`cov(Δx, Δy) / var(Δy)`), certified by closed-form oracle; TA-Lib's BETA uses a different internal return/regression, so the values differ.                                                                                                                                                                      | documented difference — TotalFinance's form is verified against its own published definition  |

## Bug-compatible by choice: `ebsw`

pandas-ta's Even Better Sinewave feeds **degree** quantities (`360 / period`, `√2·180 / bars`) to
`sin`/`cos`, which take **radians** — Ehlers' published filter uses `2π / period` and `√2·π / bars`.
TotalFinance reproduces pandas-ta bit-for-bit, defect included, because that is what the certified golden
pins and what a pandas-ta user comparing outputs expects. The consequence is explicit: **TotalFinance's
`ebsw` is pandas-ta's EBSW, not Ehlers's published filter.** Do not port its coefficients into a
from-scratch Ehlers implementation. (Flagged in the `ebsw` docstring too.)

## Interior `NaN` (a gap in the feed)

TA-Lib rejects an interior `NaN` outright. TotalFinance accepts it and gives it **pandas' rolling
semantics: the gap flows through, then the indicator recovers.** A missing print at bar `i` makes the
output `NaN` for exactly as long as that sample is inside the indicator's window (`period` bars, or
`period + 1` for indicators that difference against the previous bar), and the values afterwards are
the gap-free values again — to floating-point noise, since a subtract-on-evict running sum is
order-dependent. Indicators that carry a recursion (`kama`, `vidya`, `vfi`'s smoothing EMA) **hold**
that recursion across the gap instead of feeding it a `NaN` — feeding it would latch the filter
forever — so they resume finite and correct going forward, with the small, permanent offset a held
filter implies. Warmup is never pulled earlier by a gap; a gap inside the warmup region can push the
first value later (`vfi`).

## Hilbert-transform family (approximate)

`HT_DCPERIOD`, `HT_DCPHASE`, `HT_PHASOR`, `HT_SINE`, `HT_TRENDLINE`, `HT_TRENDMODE` are
implementation-specific everywhere. TotalFinance follows **Ehlers' published formulas**, which differ
from TA-Lib's internal period/phase smoothing. Measured agreement in steady state: `HT_DCPERIOD`,
`HT_TRENDLINE`, `HT_PHASOR` within ~1–3%; `HT_DCPHASE`, `HT_SINE`, `HT_TRENDMODE` diverge more
(phase-wrapping and a binary trend flag). Treat the HT family as approximate cross-platform.

## Candlesticks (61 `CDL*` patterns)

TotalFinance's detectors use **fixed** body/shadow/range ratios; TA-Lib uses an **adaptive** trailing
average (`TA_SetCandleSettings`, a 10-bar body average by default). Consequences:

1. **No averaging warmup.** TA-Lib suppresses every pattern for ~10–12 bars while its averages seed;
   TotalFinance reports patterns from the first valid bar.
2. **Slightly more sensitive.** Fixed thresholds flag a few percent more patterns than TA-Lib's
   adaptive ones (notably the doji family, takuri, harami).
3. **±100 only.** TA-Lib occasionally emits ±200 (pattern + confirming marubozu); TotalFinance uses ±100.
4. **Directional dojis.** TotalFinance assigns a bias to gravestone/dragonfly/long-legged dojis and
   rickshaw man; TA-Lib returns `+100` presence. These are compared on presence in the parity suite.

Measured on the reference series, **past the warmup TotalFinance agrees with TA-Lib's direction on ~95%
of TA-Lib's signals**, and 100% on the unambiguous patterns (doji, long-legged doji, spinning top,
engulfing, high-wave, long/short line, belt-hold). The parity suite asserts ≥85% presence and ≥88%
directional agreement in aggregate, and ≥60% per well-populated pattern.

## pandas-ta parity (modern indicators)

For the modern indicators TA-Lib lacks, TotalFinance is certified against **pandas-ta 0.4.x**
(`packages/technical-analysis/test/pandas-ta-golden.test.ts`). Per-family tolerance:

| Tolerance                                      | Indicators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **exact** (~1e-7)                              | `ao`, `cmf`, `chop`, `coppock`, `cti`, `massi`, `efi`, `tsi`, `vortex`, `psl`, `vhf`, `drawdown`, `ebsw`, `fwma`, `hma`, `pwma`, `sinwma`, `swma`, `vwma`, `zScore`, `mad`, `skew`, `kurtosis`, `median`, `ui`, `pdist`                                                                                                                                                                                                                                                                        |
| **converges after the seed transient (~1e-5)** | `rma`, `zlma` (EMA/RMA seed-value convention differs at the first bar, then decays — the test enforces coverage from the first value and parity past the transient)                                                                                                                                                                                                                                                                                                                            |
| **exact, with a noted convention**             | `cdlZ` (matches with population std, `ddof = 0`); `ebsw` (matches pandas-ta's _original_ formula — the 0.4.x rewrite changed it, so reproduce with `initial_version=True` — **including pandas-ta's degree/radian defect**, see below); `bias` (TotalFinance reports it as a **percent**, i.e. pandas-ta ×100)                                                                                                                                                                                 |
| **converges / bridged**                        | `supertrend` (direction exact; line shares the ATR seed transient). The initial direction is seeded **long** (`+1`, lower band) like pandas-ta's `dir_ = [1] * m` and TradingView, so the opening bars are not an artifact of the seed; both seeds agree from the first genuine flip.                                                                                                                                                                                                          |
| **~close, noted convention**                   | `alma` (~1e-2; minor ALMA window/offset convention)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **approximate (~93% agreement)**               | `amat` long/short run flags differ at a few crossovers (binary run-detection edges)                                                                                                                                                                                                                                                                                                                                                                                                            |
| **different definition — not asserted**        | `nvi`/`pvi` (classic multiplicative Fosback form vs pandas-ta's additive-percent variant); `pgo` (different true-range smoothing); `cg` (TotalFinance's is the Ehlers CG _oscillator_ around 0, pandas-ta's is the raw center-of-gravity in bar units); `tos_stdevall` (pandas-ta returns a single fixed-window regression frame, TotalFinance a per-bar rolling/expanding one). `pvt`, `kst`, `smi`, `cfo`→`forecastOscillator` and 35 more are now certified — see the extended suite below. |

## tulipy parity (independent C reference)

TotalFinance is also certified against **tulipy** (Tulip Indicators, an independent C library)
in `packages/technical-analysis/test/tulipy-golden.test.ts`: `crossover`, `crossany`, `qstick`, `williamsAd`,
and `marketFacilitationIndex` match **exactly**. The **Mesa Sine Wave** `msw` (which TA-Lib and
pandas-ta lack) is warmup-aligned to tulipy (first value at index `period`) and matches its
`sine`/`lead` everywhere except isolated phase singularities (bars where the in-phase component
crosses zero, so the sine is genuinely discontinuous). tulipy's `fosc`, `decay`, and `edecay` use
different definitions than TotalFinance's `forecastOscillator`/`linearDecay`/`exponentialDecay` and are
not asserted.

## pandas-ta parity — extended (long-tail) suite

A second golden suite (`packages/technical-analysis/test/pandas-ta-ext-golden.test.ts`, vectors from
`tools/golden/generate_pandas_ta_ext.py`) certifies the indicators that previously had only
name-resolution coverage. **39 fixtures are now numerically asserted**, plus four closed-form
oracles:

| Tolerance                                    | Indicators                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **exact** (≤1e-6; most ≤1e-13)               | `decreasing`, `increasing`, `er` (efficiencyRatio), `hwma`, `log_return`, `percent_return`, `mcgd` (mcginley), `quantile`, `slope`, `accbands`, `brar`, `donchian`, `eom`, `eri` (elderRay), `ha` (heikinAshi), `ichimoku` (tenkan/kijun), `pvol`, `pvr`, `pvo`, `rvgi`, `thermo`, `ttm_trend`, `qqe` (RSI-MA line), `cfo`→`forecastOscillator` |
| **near-exact** (≤1e-3, tiny seed)            | `stochrsi` (k/d); `aberration` (zg exact; sg/xg/atr within the ATR seed); `cksp`; `kc` (mid exact; bands within the range-EMA-vs-ATR convention)                                                                                                                                                                                                |
| **converges after a Wilder/recursive seed**  | `ssf` (superSmoother), `hwc` (mid exact; bands converge), `adx`, `dm` (dmi +DM/−DM), `rsx`, `kdj`                                                                                                                                                                                                                                               |
| **exact after a documented percent scale**   | `pvt` (÷100), `kst` (÷100), `smi` (×100) — TotalFinance uses fraction/percent conventions that differ from pandas-ta by a constant factor                                                                                                                                                                                                       |
| **exact integer signal**                     | `squeeze` on-state flag                                                                                                                                                                                                                                                                                                                         |
| **closed-form / structural oracle** (no lib) | `adxr` (= (ADX + ADX[period bars ago]) / 2), `standardError` (= sampleStdDev/√period), `lag` (exact shift), `centralPivotRange` (prior-bar pivot / TC / BC)                                                                                                                                                                                     |

Most of these long-tail names that no single external library agrees on are now certified by
**closed-form correctness oracles** (see the next section); only a handful remain name-only.

## Closed-form correctness oracles

`closed-form-oracles.test.ts` certifies **42** long-tail indicators that no external library pins to
a single convention by recomputing each one's **published defining formula from TotalFinance's own
golden-certified primitives** (SMA/EMA/VWMA/ATR/STDDEV/LINREG/TRIX/OBV/RMA — all proven in the
TA-Lib/pandas-ta goldens) and asserting equality. This proves the implementation is internally
correct (no off-by-one, seed, sign or coefficient bug); the proof rests on the certified primitives,
and the oracle formula is written from the standard definition, independently of the implementation:

| Family       | Certified via closed-form oracle                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| volume       | `volumeOscillator`, `volumeWeightedMacd`, `archerObv`, `nvi`, `pvi`, `klinger`/`kvo`, `priceVolume`(emv≡easeOfMovement), `vfi` (Katsanos)                                                          |
| volatility   | `chaikinVolatility`, `historicalVolatility`(hvol/avolume), `relativeVolatilityIndex`                                                                                                               |
| moving-avg   | `dsp`, `vwap`, `rainbowMa`, `maRibbon`, `vidya`, `linearDecay`, `exponentialDecay`, `gannHighLowActivator`, `jma` (public Jurik recurrence)                                                        |
| momentum     | `centerOfGravity`, `cfo`, `trixHistogram`, `dpo`, `laguerreRsi`, `fisherTransform`, `inertia`, `schaffTrendCycle`, `projectionOscillator`, `pgo`, `squeezePro` (LazyBear), `tdSequential` (DeMark) |
| trend/signal | `trendSignals`, `crossSignals`, `chandelierExit`, `pMax`, `longRun`, `shortRun`, `entropy`                                                                                                         |
| stats        | `beta` (financial beta on returns, `cov(Δx,Δy)/var(Δy)`), `macdFix`, `macdExt`                                                                                                                     |

The "chosen-formula" group (`jma`, `vfi`, `squeezePro`, `tdSequential`) is proven against the
**specific public variant** TotalFinance implements — the public Jurik recurrence, Katsanos VFI, LazyBear
squeeze, and standard DeMark setup/countdown — since the convention must be fixed before "proof"
means anything.

Four names still have **no numerical proof**: `sarext` (TA-Lib's extended-SAR state machine —
TotalFinance's `psarExt` matches TA-Lib's trend direction **255/255** but differs by ~0.08 in value, as
each reversal re-injects a seed difference) and the TA-Lib-only Hilbert trio `ht_dcphase`/`ht_sine`/
`ht_trendmode` (TotalFinance follows Ehlers' published formulas; exact parity would require porting
TA-Lib's distinct Hilbert internals). These carry only the registry-wide structural guarantees
(batch≡stream, serialization round-trip, no-raw-throws, bounded ranges) and stay name-only.

## TA-Lib compatibility modes (`talib: true`)

For documented divergences where TA-Lib's exact value is wanted, an opt-in `talib: true` flag
reproduces it bit-for-bit on top of TotalFinance's default convention (`talib-modes.test.ts`):

- **`cmo`** — `talib: true` uses TA-Lib's Wilder-smoothed CMO (`2·RSI − 100`); the default is
  Chande's original simple sums (pandas-ta).
- **`obv`** — `talib: true` seeds at `volume[0]` (TA-Lib) instead of 0; deltas are identical either way.
- **`stochRsi`** — already exact vs TA-Lib with `kPeriod: 1` (TA-Lib's `fastk` is the raw %K).

The C-reference reseeds for `MACDFIX`, `ADXR` and `BETA` are still documented-only (their TotalFinance
forms are independently certified above against the standard definition).

## Catalog proof coverage

`catalog-parity.test.ts` separates **name resolution** (every TA-Lib/pandas-ta name maps to a
TotalFinance indicator) from **numerical proof** (values certified against an external golden or a
closed-form oracle). Proof is derived from `golden/proof-manifest.ts`, which records which fixtures
are actually **asserted** vs merely **present** for reference — a committed fixture is _not_ counted
as proof. On that honest basis, after the closed-form oracle suite, **~98%** of the ~216-name
pandas-ta-classic catalog is numerically proven today — a tracked **4-name** allowlist remains
(`sarext` + the Hilbert trio), up from ~59% / 89 names. The gap is an explicit, bounded allowlist in
the test, so it stays visible and shrinks as coverage expands — never hidden behind a green "parity"
check.

## Reference versions & provenance

Every golden fixture carries a `meta` block (generator, reference library + version, Python and
package versions, seed, dataset id) so regenerated vectors are auditable. Current references:
**TA-Lib 0.6.4**, **pandas-ta 0.4.71b0**, **tulipy / Tulip Indicators 0.8.4**.

## Adaptive candlestick engine

`candle-talib.ts` ports TA-Lib's **adaptive** candle logic — the `TA_SetCandleSettings` trailing
range averages and the signed ±100 directional encoding — and is asserted bit-for-bit against the
TA-Lib golden for `CDLDOJI`, `CDLMARUBOZU`, and `CDLCLOSINGMARUBOZU` (`candle-talib.test.ts`). It is
the foundation for full adaptive parity; the remaining `CDL*` patterns continue to use TotalFinance's
fixed-ratio detectors (certified at ≥85% presence / ≥88% direction agreement vs TA-Lib).

## Microstructure (trade/quote level)

`microstructure.ts` adds the analytics OHLCV bars structurally cannot express — Lee-Ready / tick-rule
aggressor classification, cumulative volume delta (streaming + serializable), tick-level volume
profile with POC/value-area/footprint delta, multi-level order-book imbalance, the size-weighted
microprice, and footprint bars. All hand-oracle-verified (`microstructure.test.ts`).

## Element-wise math (Math Transform / Operators)

TA-Lib's 15 Math Transform functions (`ACOS`, `COS`, `SQRT`, `LN`, …) and four Math Operators
(`ADD`, `SUB`, `MULT`, `DIV`) are now exposed as streaming indicators (`acos`/`cos`/`sqrt`/`add`/…)
and **match TA-Lib exactly** (they are thin wrappers over `Math.*`). The transforms are certified on
an in-domain `unit` series in (0.1, 0.9); the operators on the high/low pair. There are **no**
remaining TA-Lib functions TotalFinance does not implement.
