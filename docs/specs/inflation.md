# Spec — Inflation analytics: TIPS, breakevens, seasonality (`@totalfinance/fixed-income`)

> Roadmap Tier 2 → Fixed income → _"inflation (TIPS, breakevens, seasonality)."_ Status: **shipped** as
> `tipsIndexRatio`, `breakevenInflation`, and `cpiSeasonality` in
> `packages/fixed-income/src/inflation.ts`, covered by `packages/fixed-income/test/inflation.test.ts`,
> full CI green.

## Goal

`bonds.inflationLinked` already _prices_ a linker given a `referenceIndex(date)` — but the three
analytics every inflation desk actually reaches for are missing. This adds them as a cohesive trio,
each composing the existing machinery rather than adding a model:

1. **`tipsIndexRatio`** — the US-Treasury reference-CPI **daily interpolation** and the resulting **index
   ratio** (the number that uplifts a TIPS's principal and coupons). This is the exact indexation
   mechanic `bonds.inflationLinked` consumes via `referenceIndex`.
2. **`breakevenInflation`** — the headline **breakeven** (nominal yield − real yield), both arithmetic and
   the exact Fisher-compounded form, plus the standard **premium decomposition** into expected inflation.
3. **`cpiSeasonality`** — the 12 multiplicative **seasonal factors** of a not-seasonally-adjusted CPI
   history, extracted by the classic **ratio-to-2×12-moving-average**, so a linker's near-dated indexation
   can be seasonally adjusted.

## 1. TIPS index ratio (reference-CPI daily interpolation)

The reference CPI for a settlement date is the **3-month-lagged** NSA CPI, **linearly interpolated by
day** across the settlement month. For settlement on day `t` of a month with `D` calendar days (`D` is
the **settlement** month's length), using the CPI of the month three prior (`CPI₋₃`) and two prior
(`CPI₋₂`):

```
RefCPI(settle) = CPI₋₃ + (t − 1)/D · (CPI₋₂ − CPI₋₃)
indexRatio     = RefCPI(settle) / RefCPI(base)        (rounded to 5 dp — Treasury convention)
```

`RefCPI(base)` is the reference CPI on the bond's dated date — supplied directly (`baseReferenceCpi`), or
computed from the same CPI series via a `datedDate` (the tool interpolates it identically, so the index
ratio between any two dates is one call). _Verified: on the **1st** of the month `RefCPI = CPI₋₃`
exactly; mid-month it is the exact linear blend (`May-15 → CPI_Feb + 14/31·(CPI_Mar − CPI_Feb)`); and the
series is continuous — the last day of a month meets the next month's 1st (`May-31 ≈ CPI_Mar` from
below)._ The `D` is the **settlement** month's day count (May → 31), not the lag month's — the subtlety
that makes `May-15` interpolate to `301.355`, not `301.4`.

Rounding: RefCPI and the index ratio are reported both raw and rounded to the Treasury's 5 decimals.

## 2. Breakeven inflation

The breakeven is what the market prices as future inflation — the spread between a nominal yield and the
real (TIPS) yield of comparable maturity:

```
breakeven            = nominalYield − realYield                 (arithmetic, the quoted number)
breakevenCompounded  = (1 + nominalYield)/(1 + realYield) − 1   (exact Fisher: (1+r)(1+π) = (1+n))
```

_Verified: `(1 + realYield)·(1 + breakevenCompounded) = (1 + nominalYield)` to machine precision._ The
breakeven is not pure expected inflation — it also carries an **inflation risk premium** (which lifts it)
and, on the TIPS side, a **liquidity premium** (which depresses the real yield, lifting the breakeven).
The standard decomposition, offered when the premia are supplied:

```
expectedInflation = breakeven − inflationRiskPremium + liquidityPremium
```

## 3. CPI seasonality (ratio-to-moving-average)

NSA CPI has a stable within-year shape (energy in summer, apparel cycles, …). From a monthly NSA history
(≥ 24 contiguous months), extract 12 multiplicative seasonal factors by the classic decomposition:

```
CMAₜ    = (½·xₜ₋₆ + xₜ₋₅ + … + xₜ₊₅ + ½·xₜ₊₆) / 12      (centered 2×12 moving average = the trend)
ratioₜ  = xₜ / CMAₜ                                        (seasonal × irregular)
factorₘ = mean over years of ratioₜ for calendar month m, then normalized so the 12 factors average 1
```

A factor above 1 means that month's NSA level runs above trend. _Verified: on a synthetic
`trend × knownFactor` series the extraction recovers the known factors to < 1e-5._ Output reports the
factors (Jan…Dec), the peak/trough months, and how many observations/years fed the estimate.

## 4. Zero-coupon inflation swap (ZCIS)

The standard inflation-market instrument. At maturity the inflation leg pays `I(T)/I(0) − 1` and the fixed
leg pays `(1+K)^N − 1`; the par rate `K` sets the two equal, so **the par ZCIS rate _is_ the geometric
breakeven inflation**:

```
(1 + parRate)^N = I(T)/I(0) = forwardIndexRatio        (par condition)
fixedLeg        = (1 + parRate)^N − 1                  (= expected inflation leg at par)
MTM             = ±notional·DF·[(1+parRate)^N − (1+contractRate)^N]   (pay-fixed = +)
```

Supply the market rate **or** the forward index ratio (each implies the other); supply a `contractRate`
to mark an existing position (pay-fixed / receive-inflation gains when the par rate rises above the
contract). Deterministic (forward-measure) — no inflation-vol model. _Verified: the par rate reproduces
`(1+K)^N = forwardIndexRatio` both directions; the MTM is 0 at par, equals
`notional·DF·[(1+parRate)^N − (1+contractRate)^N]` away from par, and the `'inflation'` payer is the exact
negative._

## Honesty / envelope contract

- **Exact where it can be** — the Fisher breakeven is the exact compounded relation, not the linear
  approximation (both are reported); the index-ratio interpolation is the precise Treasury convention.
- **Disclosure** — the index ratio discloses the two CPI months it interpolated between; seasonality
  discloses how many months/years fed each factor and warns on a short (< 3-year) history; the premium
  decomposition is only populated when the premia are supplied.
- **First-touch guards** — non-object input; non-finite/negative CPI levels or yields; a settlement date
  whose 3-month-lag CPI months are missing from the series; a base ref CPI ≤ 0; a seasonality history
  under 24 months or with month gaps — all throw a typed `QuantError`; never a `NaN`.
- **Domain-object envelopes (R2)** — each function returns its result object with `assumptions` +
  `diagnostics`.

## API

```ts
// 1. TIPS index ratio
interface TipsIndexRatioInput {
  settlementDate: string; // ISO date the ratio is for
  cpi: Record<string, number>; // NSA CPI by month 'YYYY-MM' → level (covers the lag window)
  baseReferenceCpi?: number; // the dated-date ref CPI (indexation base) …
  datedDate?: string; // … or compute it from `cpi` at this dated date (exactly one)
}
interface TipsIndexRatioResult {
  settlementDate: string;
  referenceCpi: number; // interpolated, raw
  referenceCpiRounded: number; // 5 dp
  baseReferenceCpi: number;
  indexRatio: number; // raw
  indexRatioRounded: number; // 5 dp (the official ratio)
  lagMonth3: string;
  lagMonth3Cpi: number; // CPI₋₃ and its month
  lagMonth2: string;
  lagMonth2Cpi: number; // CPI₋₂ and its month
  inflationSinceBase: number; // indexRatio − 1
  assumptions: { conventionsVersion: string; lagMonths: 3; interpolation: 'daily-linear' };
  diagnostics: Diagnostics;
}
function tipsIndexRatio(input: TipsIndexRatioInput): TipsIndexRatioResult;

// 2. Breakeven inflation
interface BreakevenInflationInput {
  nominalYield: number;
  realYield: number;
  inflationRiskPremium?: number; // lifts the breakeven above expected inflation
  liquidityPremium?: number; // TIPS illiquidity depresses real yield → lifts breakeven
}
interface BreakevenInflationResult {
  breakeven: number; // nominal − real
  breakevenCompounded: number; // exact Fisher
  expectedInflation: number | null; // decomposition, or null when no premia supplied
  nominalYield: number;
  realYield: number;
  assumptions: { conventionsVersion: string; method: 'fisher' };
  diagnostics: Diagnostics;
}
function breakevenInflation(input: BreakevenInflationInput): BreakevenInflationResult;

// 3. CPI seasonality
interface CpiSeasonalityInput {
  series: Array<{ month: string; level: number }>; // NSA CPI, 'YYYY-MM' → level; ≥ 24 contiguous months
}
interface CpiSeasonalityResult {
  factors: number[]; // length 12, Jan…Dec, average 1
  peakMonth: number; // 1-12, largest factor
  troughMonth: number; // 1-12, smallest factor
  monthsUsed: number; // ratios that fed the estimate
  yearsSpanned: number;
  assumptions: { conventionsVersion: string; method: 'ratio-to-2x12-moving-average' };
  diagnostics: Diagnostics;
}
function cpiSeasonality(input: CpiSeasonalityInput): CpiSeasonalityResult;
```

## Build checklist

1. **`tipsIndexRatio`** — an internal `interpolatedRefCpi(date, cpi)` (3-month lag, `(t−1)/D` daily,
   `D` = settlement month days) reused for both the settlement date and (when `datedDate` is given) the
   base; the ratio + 5-dp rounding + the two lag months; guards for missing CPI months / bad base.
2. **`breakevenInflation`** — arithmetic + Fisher-compounded breakeven; the premium decomposition when
   supplied; guards on non-finite yields.
3. **`cpiSeasonality`** — sort + contiguity-check the series; the 2×12 centered MA; ratio; per-calendar-
   month mean; normalize to average 1; peak/trough; short-history warning; guards on length/gaps/levels.
4. **Envelope + exports + API report + READMEs/llms.** (All single-arg object inputs ⇒ first-touch
   **garbage sweep**; no deep-sweep fixtures.)
5. **Tests** — ref CPI at the 1st (`= CPI₋₃`), mid-month linear blend, month-boundary continuity, index
   ratio + `datedDate` base path; the Fisher identity and the premium decomposition; seasonality recovery
   of known factors, the average-1 normalization, peak/trough; guards for each function.

## Deferred (explicitly)

- **Carry/roll on a linker** (seasonally-adjusted index projection into a forward index path) and wiring
  `tipsIndexRatio` into `bonds.inflationLinked` as a ready-made `referenceIndex`.
- **Curve-based breakeven** (a breakeven term structure from nominal & real curves, not two scalar yields)
  and the **inflation swap** (zero-coupon / year-on-year) fair rate.
- **Seasonality via X-13/STL** and confidence bands on the factors; the current method is the transparent
  ratio-to-moving-average.
- **The deflation floor's option value** (a linker's embedded floor is worth more after disinflation).
