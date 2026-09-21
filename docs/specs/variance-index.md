# Spec — VIX-style variance index + VRP term structure (`@totalfinance/volatility`)

> Roadmap Tier 2 → "Options & vol": _"VIX-style model-free variance index construction from a chain;
> variance-risk-premium term structure."_ The trader-facing layer over the single-expiry DDKZ
> replication (`varianceSwapRate`) that already exists. Status: **shipped** as `varianceIndex` +
> `varianceRiskPremiumTermStructure` in `packages/volatility/src/variance-index.ts`, covered by
> `packages/volatility/test/variance-index.test.ts`, full CI green.

## Goal

From an option **chain** (a strip of call/put mids across strikes and expiries), compute the
**constant-maturity, model-free implied volatility** — the number the CBOE publishes as VIX — plus the
per-expiry **term structure** of fair variance, and (against a realized-vol input) the
**variance-risk-premium term structure**. "What's the market's 30-day implied vol on this name, how does
it slope across expiries, and how rich is it vs realized?" — the core options-trader read that nothing
open-source answers cleanly from a raw chain.

## Why this is a composition, not a re-implementation

The hard kernel already exists; the chain pipeline around it does not:

- `varianceSwapRate({ strikes, otmPrices, forward, rate, t })` (analytics.ts:178) — the
  Demeterfi–Derman–Kamal–Zou model-free replication `σ² = (2/T)Σ(ΔKᵢ/Kᵢ²)e^{rT}Q(Kᵢ) − (1/T)(F/K₀−1)²`
  for **one** expiry, given a **pre-selected** OTM strip and forward. It already discloses a NaN fairVolatility
  on a negative (arbitrageable) variance.
- `varianceRiskPremium(iv, rv)` = `iv² − rv²` and `realizedImpliedSpread(iv, rv)` = `iv − rv`
  (event.ts) — the VRP kernels.

`varianceIndex` adds the three things `varianceSwapRate` can't do from a raw chain: (1) **extract the
forward** per expiry from put–call parity, (2) **select the OTM strip** (puts below the forward, calls
above, averaged at the money), and (3) **time-interpolate** two expiries' fair variance to a constant
maturity — the actual CBOE VIX construction. `varianceRiskPremiumTermStructure` layers the VRP kernel over the per-expiry
term structure.

## The construction (per the CBOE white paper, daily-bar simplification)

For each listed expiry with enough strikes:

1. **Forward** `F = K* + e^{rT}·(C(K*) − P(K*))`, where `K*` is the strike with the smallest
   `|C − P|` (put–call parity at the most liquid strike). `T = yearFraction(asOf, expiry, ACT/365F)`.
2. **OTM strip** — `K₀` = the highest strike ≤ `F`; use the **put** mid for `K < K₀`, the **call** mid
   for `K > K₀`, and the **average** of the two at `K₀`. Strikes with no usable mid are dropped.
3. **Fair variance** `σ²(expiry)` via `varianceSwapRate` on that strip; skip the expiry (with a disclosed
   warning) if it has < 3 usable strikes, no bracketing forward strike, or a negative (arbitrageable)
   variance — never fabricate a point.
4. **Constant-maturity interpolation** — pick the two expiries whose DTE brackets `horizonDays` and
   interpolate **total** variance on a single **calendar-day** time base (`Nᵢ = dte`):
   `σ²_index = { (N₁/365)·σ₁²·(N₂−N)/(N₂−N₁) + (N₂/365)·σ₂²·(N−N₁)/(N₂−N₁) } · (365/N)`, `N = horizonDays`.
   The total variance uses `dte/365` (not the 16:00-ET year fraction), matching the dte-based weights and
   the horizonPeriods — mixing the two biases the flat-vol index by ~1.4%. If the horizonPeriods isn't bracketed (one
   expiry, or beyond the range), fall back to the nearest expiry's fair variance with a disclosed
   `extrapolated` warning. The index is `100·√σ²_index` (VIX-style points).

## API

```ts
interface VarianceIndexOptions {
  quotes: OptionQuote[]; // chain across ≥1 expiries with call+put mids (mid or (bid+ask)/2)
  spot: number;
  riskFreeRate: number;
  asOf: EpochMs | string;
  horizonDays?: number; // constant-maturity target; default 30 (VIX)
  dividendYield?: number; // reserved for the forward; default 0 (parity forward already carries carry)
}
interface ExpiryVariance {
  expiry: string;
  daysToExpiry: number; // calendar days to expiry
  timeToExpiryYears: number; // year fraction (ACT/365F)
  forward: number; // parity forward
  variance: number; // annualized fair variance
  fairVolatility: number; // √variance — model-free implied vol (decimal, e.g. 0.20)
  strikesUsed: number;
}
interface VarianceIndexResult {
  /** Constant-maturity model-free vol in VIX-style points (e.g. 20.0 = 20% annualized). */
  index: number;
  /** Constant-maturity annualized fair variance (decimal). */
  variance: number;
  /** Constant-maturity fair vol as a decimal (`index/100`). */
  fairVolatility: number;
  horizonDays: number;
  /** Per-expiry fair variance/vol — the whole term structure, ascending by DTE. */
  termStructure: ExpiryVariance[];
  /** The two expiries that bracketed the horizonPeriods (absent when extrapolated from one). */
  interpolatedBetween?: { near: string; far: string };
  assumptions: {
    conventionsVersion: string;
    horizonDays: number;
    measure: 'risk-neutral';
    method: string;
  };
  diagnostics: Diagnostics;
}
function varianceIndex(options: VarianceIndexOptions): VarianceIndexResult;

interface VarianceRiskPremiumTermStructureOptions extends VarianceIndexOptions {
  /** Realized vol to compare (decimal): one number for the whole curve, or per-expiry by ISO date. */
  realizedVolatility: number | Record<string, number>;
}
interface VarianceRiskPremiumPoint extends ExpiryVariance {
  realizedVolatility: number;
  /** `iv² − rv²` (annualized) — the variance risk premium. */
  varianceRiskPremium: number;
  /** `iv − rv` — the vol-point spread. */
  volatilitySpread: number;
}
interface VarianceRiskPremiumTermStructureResult {
  points: VarianceRiskPremiumPoint[]; // per expiry, ascending by DTE
  /** VRP at the constant-maturity index vs the (interpolated or scalar) realized vol. */
  indexVarianceRiskPremium: number;
  assumptions: { conventionsVersion: string; measure: 'risk-neutral'; method: string };
  diagnostics: Diagnostics;
}
function varianceRiskPremiumTermStructure(
  options: VarianceRiskPremiumTermStructureOptions,
): VarianceRiskPremiumTermStructureResult;
```

## Semantics & honesty contract

- **Units** — `index` is VIX-style points (`100·fairVolatility`); `fairVolatility`/`variance` are decimals. Time is
  calendar (ACT/365F, 365-day annualization) to match VIX.
- **No fabricated points** — an expiry that can't be replicated (too few strikes, no forward-straddling
  strike, negative variance) is **dropped with a disclosed warning**, never guessed; if _no_ expiry is
  usable, a typed error explains why.
- **Extrapolation disclosed** — when the horizonPeriods isn't bracketed by two expiries, the index is the
  nearest expiry's fair vol with an `extrapolated` warning, never silently.
- **Risk-neutral measure** carried through (`RISK_NEUTRAL_ESTIMATE`, inherited from `varianceSwapRate`).
- Typed guards on every entry (garbage quotes/opts, `spot`/`rate`/`asOf`, `horizonDays > 0`, a bad
  `realizedVolatility`); pure and deterministic (no clock — `asOf` is explicit).

## Build checklist

1. **Types** — the five interfaces above.
2. **Chain grouping** — group quotes by expiry; per strike collect call-mid + put-mid (mid, else
   `(bid+ask)/2`); drop strikes with no usable mid.
3. **Per-expiry** — forward (parity at min `|C−P|`), OTM strip (put/call/averaged-at-K₀), `varianceSwapRate`;
   skip-with-disclosure on failure.
4. **Interpolation** — bracket the horizonPeriods; interpolate total variance; nearest-with-warning fallback.
5. **`varianceIndex`** — assemble the term structure + index + envelope.
6. **`varianceRiskPremiumTermStructure`** — per-expiry `varianceRiskPremium`/`realizedImpliedSpread`; index VRP.
7. **Exports + fixture + API report + READMEs/llms** — vol index; deep-sweep fixtures.
8. **Tests** — a flat-vol synthetic chain recovers ~that vol at every expiry and the index; the index
   interpolates between two expiries (monotone in horizonPeriods); a sparse/arbitrageable expiry is dropped with
   a warning; VRP sign (implied > realized ⇒ positive); single-expiry extrapolation is disclosed;
   envelope/guards; deep-sweep.

## Deferred (explicitly)

- **Term-structure smoothing / SVI-consistent strip** — v1 uses the raw OTM mids (CBOE-style); pricing
  the strip off a fitted arbitrage-free surface (`volatilitySurface`) is a follow-up that de-noises sparse chains.
- **Minutes-precision time** (CBOE uses time-to-settlement in minutes); v1 uses calendar-day ACT/365F.
- **A skew/convexity index** (SKEW-style third-moment) from the same strip — a natural sibling.
- **Realized vol estimators** (close-to-close, Parkinson, Yang–Zhang) so `varianceRiskPremiumTermStructure` can take a
  price history directly instead of a realized-vol number — pairs with the data layer.
