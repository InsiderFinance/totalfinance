# Spec — SKEW-style tail-risk index (`@totalfinance/volatility`)

> Roadmap Tier 2 → "Options & vol" (variance-index follow-up): _"a SKEW-style third-moment index."_ The
> crash-risk sibling of the variance index — the model-free risk-neutral **skewness** (and excess
> kurtosis) of the log-return distribution, built from the **same OTM strip**. Status: **shipped** as
> `tailRiskIndex` in `packages/volatility/src/tail-risk.ts`, covered by
> `packages/volatility/test/tail-risk.test.ts`, full CI green.

## Goal

The variance index says how _much_ the market expects to move; this says how _asymmetric_ and _fat_ that
move distribution is. `tailRiskIndex` returns the risk-neutral skewness and excess kurtosis per expiry
and a constant-maturity **SKEW value** — `100 − 10·skewness`, the CBOE convention — so the usual equity
put-skew (a fat left tail) reads **above 100** and a symmetric smile reads **~100**. "How much crash
risk is priced right now, and how does it slope across expiries?"

## Why this is a composition, not a re-implementation

It reuses the exact OTM-strip machinery the variance index already needs, factored into a shared module:

- `extractOtmStrips(quotes, { rate, asOf })` (otm-strip.ts) — per expiry: the put–call-parity forward,
  the OTM strip (puts below the forward, calls above, averaged at the money), `t`/`dte`, dropping any
  un-replicable expiry with a disclosed warning. **Shared with `varianceIndex`** (extracted in this
  change), so the two indices see identical strips.

`tailRiskIndex` applies the **Bakshi–Kapadia–Madan (2003)** power-payoff estimators to each strip and
standardizes the moments.

## The moments (BKM, forward-referenced)

Referenced to the forward `F` (so `E[S_T/F] = 1` and the strip's OTM split at `F` is exactly right), for
`R = ln(S_T/F)`, the fair value of a claim paying `g(S_T)` spanned around `F` gives
`E[gₙ(S_T)] = e^{rT}·Σᵢ gₙ''(Kᵢ)·Qᵢ·ΔKᵢ`, and for `gₙ = Rⁿ` (with `u = ln(K/F)`):

```
g₁''·K² = −1        g₂''·K² = 2(1−u)      g₃''·K² = 6u − 3u²      g₄''·K² = 12u² − 4u³
```

So `Mₙ = e^{rT}·Σ (gₙ''·K²)·Qᵢ·ΔKᵢ / Kᵢ²`, `μ = M₁`, and the central moments give

```
variance = M₂ − μ²
skewness = (M₃ − 3μM₂ + 2μ³) / variance^{3/2}
excess kurtosis = (M₄ − 4μM₃ + 6μ²M₂ − 3μ⁴) / variance² − 3
skewIndex = 100 − 10·skewness
```

`ΔKᵢ` is the central-difference strike spacing (one-sided at the ends), same as the DDKZ variance. An
expiry whose strip yields a non-positive variance or non-finite moments is **dropped with a disclosed
warning**, never fabricated; if no expiry survives, a typed error explains why.

## API

```ts
interface TailRiskOptions {
  quotes: OptionQuote[];
  spot: number;
  riskFreeRate: number;
  asOf: EpochMs | string;
  horizonDays?: number; // constant-maturity target; default 30 (CBOE SKEW)
}
interface ExpiryTailRisk {
  expiry: string;
  daysToExpiry: number;
  timeToExpiryYears: number;
  forward: number;
  skewness: number; // risk-neutral skewness of ln(S_T/F)
  excessKurtosis: number; // kurtosis − 3
  skewIndex: number; // 100 − 10·skewness
  strikesUsed: number;
}
interface TailRiskResult {
  skewIndex: number; // constant-maturity, interpolated to horizonDays
  skewness: number;
  excessKurtosis: number;
  horizonDays: number;
  termStructure: ExpiryTailRisk[]; // per expiry, ascending by DTE
  interpolatedBetween?: { near: string; far: string };
  assumptions: {
    conventionsVersion: string;
    horizonDays: number;
    measure: 'risk-neutral';
    method: string;
  };
  diagnostics: Diagnostics;
}
function tailRiskIndex(options: TailRiskOptions): TailRiskResult;
```

## Semantics & honesty contract

- **Sign** — a fat left tail (equity put-skew) ⇒ negative skewness ⇒ `skewIndex > 100`; a symmetric
  smile ⇒ ~0 skewness ⇒ `skewIndex ≈ 100`.
- **Constant maturity** — skewness (and excess kurtosis) are interpolated **linearly in DTE** between the
  two bracketing expiries (skewness is dimensionless, not √-time-scaled). An un-bracketed horizonPeriods is
  extrapolated from the nearest expiry, **disclosed** with a warning.
- **No fabricated points** — an expiry with a non-positive variance / non-finite moments is dropped with
  a warning; if none survive, a typed error.
- **Risk-neutral measure** carried through.
- Typed guards on every entry (garbage quotes/opts, `spot`/`rate`, `horizonDays > 0`); pure/deterministic.

## Build checklist

1. **Shared strip** — extract `extractOtmStrips` (+ `midOf`, `OtmStrip`) from `variance-index.ts` into
   `otm-strip.ts`; refactor `varianceIndex` to consume it (fixing its `dte` to clean calendar days).
2. **BKM moments** — the four power sums + standardized skewness / excess kurtosis per strip; skip on
   non-positive variance / non-finite.
3. **`tailRiskIndex`** — term structure + linear-in-DTE constant-maturity interpolation + envelope.
4. **Exports + API report + READMEs/llms.**
5. **Tests** — a symmetric synthetic smile gives skewness ≈ 0 and skewIndex ≈ 100; a put-skew smile gives
   negative skewness and skewIndex > 100 (and a steeper skew ⇒ higher index); excess kurtosis > 0 for a
   smile with fat wings; the constant-maturity value interpolates between expiries; a dropped/sparse
   expiry is disclosed; envelope/guards.

## Deferred (explicitly)

- **A tail-loss / VaR-style read** (probability of an N-σ down move) from the same risk-neutral
  distribution (pairs with `riskNeutralDistribution`).
- **Minutes-precision time** and **SVI-consistent strip pricing** (shared with the variance-index
  follow-ups) to de-noise sparse chains.
- **Physical-measure skew** (vs realized) once the data layer lands.
