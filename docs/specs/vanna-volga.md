# Spec — Vanna–volga smile construction (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the standard FX/crypto smile builder (best-of-its-kind vol depth).
> Status: **shipped** as `calibrateVannaVolga` in `packages/volatility/src/vanna-volga.ts`, covered by
> `packages/volatility/test/vanna-volga.test.ts`, full CI green. Composes `smileFromQuotes` (pillars in) and
> round-trips through `riskReversalButterfly` (quotes back out).

## Goal

FX and crypto desks quote three points per expiry — the ATM vol and the 25-delta risk reversal and
butterfly — and need a **full smile** across all strikes from just those three. The **vanna–volga (VV)**
method is the market standard: it prices any strike as the flat-ATM Black–Scholes value plus the cost of
a portfolio of the three market instruments that hedges the option's **vega, vanna, and volga**, so the
constructed smile **reprices the three market pillars exactly** and interpolates/extrapolates smoothly in
between. This adds it as the natural companion to `riskReversalButterfly`.

## The construction

From `(ATM, RR, BF)` at delta `δ`, the three pillars `(K, σ)` — the δ-delta put, the ATM, and the δ-delta
call — come straight from `smileFromQuotes`. Everything is done in **forward** (undiscounted) terms
(`S = F`, `r = q = 0`), so the vol is discount-invariant. For a target strike `K`:

1. **Weights** — build the `3×3` matrix whose columns are the `(vega, vanna, volga)` of the three pillar
   options evaluated at the **ATM** vol, and solve `M·w = (vega, vanna, volga)_K` (the target's greeks at
   the ATM vol). The weights `w` are the amounts of the three pillar options that replicate `K`'s vega,
   vanna, and volga.

   ```
   vega  = F·n(d₁)·√T            vanna = −n(d₁)·d₂/σ            volga = vega·d₁·d₂/σ
   ```

2. **VV price** — the flat-ATM price plus the market cost the hedge would carry:

   ```
   P_VV(K) = P_BSM(K, σ_atm) + Σᵢ wᵢ · [ P_BSM(Kᵢ, σᵢ) − P_BSM(Kᵢ, σ_atm) ]
   ```

3. **VV vol** — invert `P_VV(K)` back to an implied vol.

At a pillar `Kⱼ`, the target greeks equal column `j`, so `w = eⱼ` and `P_VV(Kⱼ) = P_BSM(Kⱼ, σⱼ)` — the
pillar reprices **exactly**. _Verified: `calibrateVannaVolga` returns the pillar vols to 1e-6 at the three
strikes; the constructed smile is smooth and convex; and feeding it back into `riskReversalButterfly`
recovers the input `(ATM, RR, BF)` to 1e-4 — the full quote → smile → quote loop closes._

## Honesty / envelope contract

- **Exact at the pillars, disclosed elsewhere** — the three market points reprice exactly by construction;
  VV is an interpolation, so far-out-of-range strikes where it breaks down — the price violates the
  no-arbitrage bounds (below intrinsic / above the forward) and cannot be inverted, or the price collapses
  to intrinsic and gives a degenerate `≈ 0` vol — are reported as un-representable rather than returned as
  a `NaN` or a garbage near-zero vol.
- **A singular pillar matrix is a typed error** — coincident/degenerate pillars (e.g. `RR = BF = 0` giving
  three identical strikes) make the `3×3` un-solvable and throw with an explanation.
- **Convention disclosed** — the pillars use the same **forward, non-premium-adjusted** delta as
  `smileFromQuotes`; echoed in `assumptions`.
- **First-touch guards** — non-object input; non-positive `forward`/`t`/`atmVolatility`; a `delta` outside
  `(0, 0.5)`; non-finite quotes; a non-array/empty `strikes` — all throw a typed `QuantError`.
- **Envelope (R2)** — a domain object with the smile points, the pillars, `assumptions`, and `diagnostics`.

## API

```ts
interface VannaVolgaInput {
  /** Forward price of the underlying. */
  forward: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** ATM vol. */
  atmVolatility: number;
  /** 25-delta (or `delta`) risk reversal (callVolatility − putVolatility). */
  riskReversal: number;
  /** 25-delta (or `delta`) butterfly ((callVolatility + putVolatility)/2 − atmVolatility). */
  butterfly: number;
  /** Delta level for the pillars. Default 0.25. */
  delta?: number;
  /** Strikes to evaluate the constructed smile at. */
  strikes: number[];
}
interface VannaVolgaSmile {
  /** The constructed smile: strike → vol, aligned to the requested strikes. */
  strikes: number[];
  volatilities: number[];
  /** The three market pillars the smile reprices exactly. */
  pillars: {
    putStrike: number;
    putVolatility: number;
    atmStrike: number;
    atmVolatility: number;
    callStrike: number;
    callVolatility: number;
  };
  delta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'vanna-volga';
    deltaConvention: 'forward';
    delta: number;
  };
  diagnostics: Diagnostics;
}
function calibrateVannaVolga(input: VannaVolgaInput): VannaVolgaSmile;
```

## Build checklist

1. **Pillars** — validate; `smileFromQuotes(ATM, RR, BF, δ)` → the three `(strike, vol)` pillars.
2. **Per strike** — the `(vega, vanna, volga)` greeks at the ATM vol; solve the `3×3` for the weights
   (`luSolve`, erroring on a singular matrix); the VV price correction; invert to a vol (forward BSM,
   erroring / disclosing when the price is out of the no-arb bounds).
3. **Envelope + export + API report + READMEs/llms.** (Single-arg ⇒ first-touch **garbage sweep**; no
   deep-sweep fixture.)
4. **Tests** — reprices the three pillars exactly; the smile round-trips through `riskReversalButterfly`
   to the input quotes; the interpolation is smooth (monotone between pillars for a monotone smile); an
   out-of-range strike / singular-pillar case errors; guards.

## Deferred (explicitly)

- **The second/third-order VV analytic approximation** (Castagna–Mercurio closed form) as a faster,
  inversion-free alternative to the exact price-and-invert here.
- **The 5-pillar (10Δ + 25Δ) VV** and premium-adjusted / spot-delta conventions.
- **Wiring VV into `volatilitySurface`** as a per-expiry smile model, and a VV-implied density / arbitrage check.
