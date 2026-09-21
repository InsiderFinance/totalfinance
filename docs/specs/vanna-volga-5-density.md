# Spec — 5-pillar (10Δ) vanna-volga-implied risk-neutral density (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the vanna-volga-density follow-up: "a 5-pillar-fed `vannaVolgaDensity`".
> Status: **shipped** as `vannaVolga5Density` in `packages/volatility/src/vanna-volga.ts`, covered by
> `packages/volatility/test/vanna-volga.test.ts`, full CI green.

## Goal

`vannaVolgaDensity` builds the risk-neutral terminal distribution from the **three**-quote smile (ATM + 25Δ
RR/BF). `calibrateVannaVolga5` builds a **five**-pillar smile (adding the 10Δ RR/BF) that reprices the wings exactly.
This joins them: the **risk-neutral density implied by the five-pillar smile** — the same PDF / CDF /
quantiles / probability-in-range / moments read-out, but with the core (the quoted `[10Δ put, 10Δ call]`
range, where most probability mass sits) pinned to real quotes instead of extrapolated from three.

## Construction

- **Smile.** The `calibrateVannaVolga5` PCHIP-of-total-variance smile (built once, shared with `calibrateVannaVolga5`).
- **Density.** Breeden–Litzenberger in forward space (`spot = F, rate = 0`): the undiscounted forward Black
  call's strike derivatives are the density and CDF directly. This is the **shared density core**
  (`forwardMeasureDensity`) that `vannaVolgaDensity` also uses — same grid, moments, quantile, and
  mass/mean/non-monotone-CDF diagnostics — so the two densities are consistent by construction.

## Why linear wing extrapolation (forced)

A density needs the smile across a wide grid (default ±6σ), far beyond the 10Δ pillars. The PCHIP smile is C¹
**inside** `[10Δp, 10Δc]` but its behaviour past the outer knots depends on the extrapolation:

- **`flat`** (constant total variance) is **C⁰** at the outer knots — the vol slope jumps from the PCHIP
  value to zero. That kink puts a spurious spike in the density (its second derivative) right at the 10Δ
  knots, which are **interior** to the ±6σ grid — producing a false negative-density / non-monotone-CDF
  reading, a mass overshoot, and a mean drift. _Verified: flat gives min raw density ≈ −6e-2, a non-monotone
  CDF, mass ≈ 1.008, mean ≈ 99.86 — unusable._
- **`linear`** (constant total-variance slope) is **C¹** at the outer knots — it continues the PCHIP endpoint
  slope, so there is **no slope kink** and the density stays smooth. _Verified: min raw density ≈ +1e-11, a
  strictly monotone CDF, mass ≈ 1.0000, mean = forward to 3 dp._

So `vannaVolga5Density` **forces linear extrapolation** (it does not expose `wingExtrapolation`); flat is
simply wrong for a density. If a down-sloping wing drives total variance `≤ 0` anywhere on the grid (a wing
too steep for the ±widthStandardDeviations span), those strikes are a typed error — narrow `widthStandardDeviations`.

## Honesty / verification

- **Martingale + mass.** Verified: the risk-neutral mean equals the forward and the mass integrates to ≈ 1
  for benign five-quote sets; drift past 1% is the same disclosed `ModelLimitation` warning as
  `vannaVolgaDensity`.
- **Reprices its own pillars.** The density's smile passes through all five quoted `(strike, vol)` pillars
  exactly (it _is_ the `calibrateVannaVolga5` smile).
- **Sharper core than the 3-pillar density.** Verified: inside the quoted `[10Δp, 10Δc]` range the 5-pillar
  density's CDF differs from the 3-pillar `vannaVolgaDensity` where the 10Δ quotes disagree with the 3-pillar
  extrapolation — the tail probabilities are pinned to real wing quotes.
- **Genuine arbitrage still surfaced.** An over-convex butterfly makes the interior density go negative ⇒ the
  shared non-monotone-CDF warning fires (linear extrapolation removes only the _spurious_ boundary artifact,
  not real arbitrage).
- **Envelope + guards.** Positive `forward`/`t`/`atmVolatility`, finite RR/BF ×2, `outerDelta < innerDelta` in
  `(0, 0.5)`, `gridPoints` odd ≥ 11, `widthStandardDeviations > 0`, positive `step`. No explicit first-touch fixture — the
  single-object-arg signature is auto-covered by the arg-0 garbage sweep.

## API

```ts
export interface VannaVolga5DensityInput extends Omit<
  VannaVolga5Input,
  'strikes' | 'wingExtrapolation'
> {
  /** Grid points for the sampled density / moments; odd integer ≥ 11 (default 801). */
  gridPoints?: number;
  /** Grid half-width in ATM standard deviations, F·e^{±widthStandardDeviations·σ√T} (default 6). */
  widthStandardDeviations?: number;
  /** Central-difference step in strike for Breeden–Litzenberger (default F·1e-3). */
  step?: number;
}

export interface VannaVolga5Density {
  density(K: number): number;
  cdf(K: number): number;
  probabilityBelow(K: number): number;
  probabilityAbove(K: number): number;
  probabilityBetween(a: number, b: number): number;
  quantile(p: number): number;
  grid: { strikes: number[]; density: number[]; cdf: number[] };
  moments: {
    totalMass: number;
    mean: number;
    variance: number;
    stdev: number;
    skewness: number;
    excessKurtosis: number;
  };
  /** The five market pillars the underlying smile reprices exactly, low → high strike. */
  pillars: VannaVolga5Pillar[];
  innerDelta: number;
  outerDelta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'breeden-litzenberger';
    smile: 'vanna-volga-5';
    measure: 'risk-neutral-forward';
  };
  diagnostics: Diagnostics;
}

export function vannaVolga5Density(input: VannaVolga5DensityInput): VannaVolga5Density;
```

## Build checklist

1. Extract the shared cores from the shipped functions (validated by their existing tests):
   `buildVanna5Smile` (anchors + monotone check + PCHIP → a `varAt`/`volatilityAt` closure + the five pillars) out of
   `calibrateVannaVolga5`, and `forwardMeasureDensity` (grid + BL + moments + quantile + mass/mean/non-monotone
   diagnostics) out of `vannaVolgaDensity`.
2. `vannaVolga5Density` — validate the grid controls; `buildVanna5Smile` with `wingExtrapolation: 'linear'`;
   pre-scan the grid + stencil for total variance `> 0` (typed error otherwise); `forwardMeasureDensity`;
   assemble with the five pillars.
3. Exports (`vannaVolga5Density`, `VannaVolga5DensityInput`, `VannaVolga5Density`) in `index.ts`.
4. Tests: martingale (mean = forward) + mass ≈ 1, reprices the five pillars, a CDF that differs from the
   3-pillar density inside the quoted range, the over-convex-butterfly arbitrage warning, the non-positive-
   variance guard, and the input guards; 100% coverage of the new code.

## Deferred (explicitly)

- **A whole-surface (term-structure) VV density** — stacking per-expiry 5-pillar densities into a
  `(k, t)` risk-neutral surface — a larger, separate build.
