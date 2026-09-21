# Spec — 5-pillar (10Δ) vanna-volga smile (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the vanna-volga follow-up: "5-pillar (10Δ) VV".
> Status: **shipped** as `calibrateVannaVolga5` in `packages/volatility/src/vanna-volga.ts`, covered by
> `packages/volatility/test/vanna-volga.test.ts`, full CI green.

## Goal

The 3-pillar `calibrateVannaVolga` / `vannaVolgaApproximation` build the whole smile from **three** quotes (ATM + 25Δ
RR/BF), so the wings are an _extrapolation_ — the 10Δ region is inferred, not fitted. FX/crypto desks quote a
**10Δ** risk reversal and butterfly too; `calibrateVannaVolga5` uses the full **five**-quote set (ATM + 25Δ RR/BF +
10Δ RR/BF) to build a smile that **exactly reprices all five market pillars** and interpolates smoothly
between them, pinning the wings to real quotes instead of extrapolating them.

This complements — does not duplicate — the parametric fits (`fitSVI`, `fitSABRSmile`, `calibrateSSVI`):
those are **least-squares** fits that need not hit any quote exactly; `calibrateVannaVolga5` is an **exact-repricing**
interpolation of a small, canonical quote set, the vanna-volga family's native way to carry a full smile.

## Construction

1. **Five anchors.** Reuse `smileFromQuotes` twice — at the inner delta (25Δ, with RR25/BF25) and the outer
   delta (10Δ, with RR10/BF10) — sharing the ATM. That yields five `(strike, vol)` anchors, low→high strike:
   `10Δ put, 25Δ put, ATM, 25Δ call, 10Δ call`. Each wing strike is the closed form
   `K = F·exp(½σ²T − Φ⁻¹(·)·σ√T)` at its own vol (as `smileFromQuotes` already does). The five strikes must
   be **strictly increasing**; a pathological quote set that reorders them (e.g. a 10Δ put strike above the
   25Δ put strike) is a typed error.
2. **Interpolate in total variance.** Fit a **PCHIP** (shape-preserving monotone cubic — Fritsch–Carlson) to
   `w(k) = σ(k)²·T` against log-moneyness `k = ln(K/F)` through the five anchors. PCHIP is the right tool:
   C¹-smooth, exact at every anchor, and — unlike a degree-4 Lagrange polynomial — it **cannot overshoot**
   between anchors, so it adds no spurious wiggle (and no wiggle-induced arbitrage) of its own. Total-variance
   space is the smile-standard space and gives an arbitrage-aware linear wing extrapolation.
3. **Query.** `σ(K) = √(w(ln(K/F)) / T)`. Beyond the outer (10Δ) pillars the wing is extrapolated in `w` —
   `flat` (constant `w`; default) or `linear` (constant slope). A `linear` wing that drives `w ≤ 0` far out is
   a typed error at those strikes (never an imaginary vol).

## Honesty / verification

- **Exact repricing.** Verified: `calibrateVannaVolga5` returns each pillar's quoted vol to machine precision at its
  strike (PCHIP is exact at its nodes; `√(σ²T / T) = σ`).
- **Sharper than the 3-pillar smile, by construction.** Verified against `vannaVolgaApproximation` (3-pillar CM):
  the two agree to ~0 bp at the shared 25Δ/ATM pillars, but differ by tens of bp in the 10Δ wings — where
  `calibrateVannaVolga5` uses the real 10Δ quote and the 3-pillar smile only extrapolates.
- **Arbitrage is detected, not hidden.** Exact repricing of five _arbitrary_ quotes cannot guarantee an
  arbitrage-free smile — an **over-convex butterfly** (a large 25Δ/10Δ BF relative to the strike gap) makes
  the call-price curve locally concave between the pillars ⇒ a **negative implied density**. Like `calibrateVannaVolga`
  (typed breakdown) and `vannaVolgaDensity` (non-monotone-CDF warning), `calibrateVannaVolga5` **checks the implied
  Breeden–Litzenberger density across the interior pillar span** and raises a `ModelLimitation` warning naming
  the butterfly arbitrage; a benign quote set produces a strictly-positive density and no warning. The scan is
  the _interior_ `(loK+2h, hiK-2h)`: a stencil straddling an outer knot — where the flat/linear wing
  extrapolation meets the interpolated curve — would pick up that vol-slope kink as a spurious density spike
  rather than a genuine arbitrage, and the constant-vol (flat) wings are individually arbitrage-free anyway.
  (For a **guaranteed** arbitrage-free surface, `calibrateSSVI` / `calibrateESSVI` remain the tools; the
  trade-off is those don't reprice the pillars exactly.)
- **Envelope + guards.** Positive `forward`/`t`/`atmVolatility`, finite RR/BF ×2, `outerDelta < innerDelta` both in
  `(0, 0.5)`, `wingExtrapolation ∈ {flat, linear}`, non-empty positive `strikes`. No explicit first-touch
  fixture — the single-object-arg signature is auto-covered by the arg-0 garbage sweep.

## API

```ts
export interface VannaVolga5Input {
  forward: number;
  timeToExpiryYears: number;
  atmVolatility: number;
  /** 25-delta risk reversal (callVolatility − putVolatility) and butterfly. */
  riskReversal25: number;
  butterfly25: number;
  /** 10-delta risk reversal and butterfly. */
  riskReversal10: number;
  butterfly10: number;
  /** Inner / outer wing deltas (default 0.25 / 0.10). */
  innerDelta?: number;
  outerDelta?: number;
  /** Wing extrapolation beyond the 10Δ pillars, in total variance: 'flat' (default) | 'linear'. */
  wingExtrapolation?: 'flat' | 'linear';
  strikes: number[];
}

export interface VannaVolga5Pillar {
  strike: number;
  volatility: number;
  delta: number;
  kind: 'put' | 'atm' | 'call';
}

export interface VannaVolga5Smile {
  strikes: number[];
  volatilities: number[];
  /** The five market pillars the smile reprices exactly, low → high strike. */
  pillars: VannaVolga5Pillar[];
  innerDelta: number;
  outerDelta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'vanna-volga-5';
    deltaConvention: 'forward';
    interpolation: 'pchip-total-variance';
    wingExtrapolation: 'flat' | 'linear';
  };
  diagnostics: Diagnostics;
}

export function calibrateVannaVolga5(input: VannaVolga5Input): VannaVolga5Smile;
```

## Build checklist

1. `calibrateVannaVolga5` — validate; two `smileFromQuotes` calls for the anchors; assert strictly-increasing pillar
   strikes; PCHIP `w(k)`; evaluate the requested strikes (typed error on a non-positive extrapolated `w`);
   butterfly-arbitrage diagnostic (BL density on a grid over the pillar span); return the smile + five pillars.
2. Exports (`calibrateVannaVolga5`, `VannaVolga5Input`, `VannaVolga5Pillar`, `VannaVolga5Smile`) in `index.ts`.
3. Tests: exact repricing of all five pillars, agreement with the 3-pillar CM at the shared pillars and
   divergence in the 10Δ wings, the arbitrage warning (fires on a steep-wing quote set, quiet on a benign
   one), `flat` vs `linear` wing extrapolation, the non-monotone-strike guard, and the input guards; 100%
   coverage of the new code.

## Deferred (explicitly)

- **A 5-pillar-fed `vannaVolgaDensity`** — the sharper density the extra wing quotes buy; the current density
  builds on the 3-pillar CM smile. (A caller can already feed `calibrateVannaVolga5` into `riskNeutralDistribution`.)
- **Spot/premium-adjusted delta and ATM-DNS conventions** — this uses the forward-delta convention throughout,
  like the rest of the vanna-volga family.
