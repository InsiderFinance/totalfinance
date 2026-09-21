# Spec — Vanna–volga-implied risk-neutral density (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the vanna-volga follow-up: "a VV-implied density".
> Status: **shipped** as `vannaVolgaDensity` in `packages/volatility/src/vanna-volga.ts`, covered by
> `packages/volatility/test/vanna-volga.test.ts`, full CI green.

## Goal

From just **three quotes** — ATM vol + the δ-delta risk reversal and butterfly — recover the full
**risk-neutral terminal distribution** of the underlying: the PDF, CDF, quantiles, probability-in-range, and
the distribution's moments (mean, variance, skewness, excess kurtosis). This is the "probability cone" an
options desk reads off the smile — _what's the chance we finish between X and Y, and how fat/skewed is the
market's implied distribution_ — but sourced from the compact FX/crypto quote triple rather than a full chain.

`riskNeutralDistribution` (in `analytics.ts`) already does Breeden–Litzenberger from _any_ smile. The new
value here is a **first-class VV entry** that (1) builds the smile from the quotes, (2) samples a sensible
grid and integrates the **moments + quantiles + diagnostics** on top, and (3) is honest about the one smile
that can supply it.

## Why the Castagna–Mercurio smile (not the exact `calibrateVannaVolga`)

Breeden–Litzenberger needs the smile evaluated across a **wide strike grid** (default ±6 ATM standard
deviations, capturing ≈ all mass) and at the finite-difference stencil `K ± h`. The **exact `calibrateVannaVolga`
breaks down in the wings** — its VV price leaves the no-arbitrage bounds and it throws — so it cannot supply
vol across the range a density needs. The **Castagna–Mercurio closed form** (`vannaVolgaApproximation`, order 2) is
the always-defined, smooth, market-standard smile for this: it extrapolates to a finite vol across the grid
for a normal smile. So `vannaVolgaDensity` is built on the CM smile — this feature is exactly why the closed
form exists. (Where CM's curvature `√` still turns negative — a **risk reversal too steep for the butterfly**,
or a non-positive butterfly — the density is undefined on that grid; those strikes are collected into a typed
error, with the remedy to narrow `widthStandardDeviations` or check the quotes.)

## Method

- **Smile.** Pillars via `smileFromQuotes` (built **once**); the per-strike vol from the private
  `castagnaMercurio(order, …)` (default `order: 2`). Every grid + stencil strike is pre-scanned; a non-finite
  CM vol (inverted-butterfly breakdown) is a typed error naming the strikes.
- **Breeden–Litzenberger in forward space.** Price the **undiscounted forward** Black call
  `C(K) = blackScholesPrice({ type: 'call', spot: F, strike: K, t: T, riskFreeRate: 0, dividendYield: 0, volatility: σ_CM(K) })`.
  Because the forward call is `e^{rT}` times the discounted
  call, its strike derivatives _are_ the risk-neutral (T-forward-measure) density and CDF directly, with no
  discount factor to carry:
  ```
  f(K) = ∂²C/∂K²              (central 2nd difference; clamped ≥ 0)
  F(K) = P(S_T ≤ K) = 1 + ∂C/∂K   (central 1st difference; clamped to [0,1])
  ```
  This is the same Breeden–Litzenberger as `riskNeutralDistribution` with `spot = F, rate = 0, q = 0`; the
  density/CDF/probability closures are obtained by **composing that verified function**, so the numerics are
  shared and consistent.
- **Grid + moments.** Sample `f` on `gridPoints` (default 801, odd so ATM is a node) strikes spanning
  `F·e^{±widthStandardDeviations·σ_ATM·√T}` (default `widthStandardDeviations = 6`). Trapezoidal integration gives
  `totalMass = ∫f`, `mean = ∫K·f`, `variance`, `stdev`, `skewness = ∫(K−μ)³f / σ³`, and
  `excessKurtosis = ∫(K−μ)⁴f / σ⁴ − 3` (all normalised by `totalMass`).
- **Quantile.** `quantile(p)` inverts the CDF by bisection over the grid span (monotone for an arb-free smile).

## Honesty / verification

- **Verified against the analytic lognormal.** For a **flat** smile (RR = BF = 0) the risk-neutral law is
  exactly lognormal (`mean = F`, `vol = σ√T`). The BL density reproduces the closed-form lognormal density to
  **~4e-6 relative**; `totalMass = 1.000000`, `mean = F` to 4 dp, `variance` matches `F²(e^{σ²T}−1)`.
- **Martingale property.** The risk-neutral **mean equals the forward** for every smile (flat, left-skew,
  right-skew) — the defining no-arbitrage property; a deviation beyond tolerance is surfaced as a warning
  (grid too narrow or the smile is arbitrageable).
- **Skew/kurtosis respond correctly.** A negative risk reversal **lowers** the implied skewness and a positive
  one **raises** it (monotone in RR; note the lognormal baseline is itself right-skewed, so the honest check
  is the _ordering_, not a raw sign); a larger butterfly **fattens the tails** (higher excess kurtosis).
- **Arbitrage is disclosed, not hidden.** The density is clamped `≥ 0` and the CDF to `[0, 1]`; if the sampled
  CDF is **non-monotone** (⟺ a negative-density region ⟺ butterfly arbitrage in the smile) or `totalMass` /
  `mean` drift past tolerance (1%), a `ModelLimitation` warning says so. A smile too steep for CM to represent
  on the grid (steep RR / non-positive butterfly) is a hard typed error, not a silent partial density.
- **Envelope + guards.** Same input validation as `calibrateVannaVolga` (positive `forward`/`t`/`atmVolatility`, finite
  RR/BF, delta ∈ (0, 0.5)), plus `order ∈ {1, 2}`, `gridPoints` an odd integer ≥ 11, `widthStandardDeviations > 0`, and a
  positive `step`. No explicit first-touch fixture — the single-object-arg signature is auto-covered by the
  arg-0 garbage sweep.

## API

```ts
export interface VannaVolgaDensityInput extends Omit<VannaVolgaInput, 'strikes'> {
  /** Castagna–Mercurio order for the underlying smile: 1 or 2 (default). */
  order?: 1 | 2;
  /** Grid points for the sampled density / moments; odd integer ≥ 11 (default 801). */
  gridPoints?: number;
  /** Grid half-width in ATM standard deviations, F·e^{±widthStandardDeviations·σ√T} (default 6). */
  widthStandardDeviations?: number;
  /** Central-difference step in strike for Breeden–Litzenberger (default F·1e-3). */
  step?: number;
}

export interface VannaVolgaDensity {
  /** Risk-neutral (T-forward-measure) PDF at strike K. */
  density(K: number): number;
  /** Risk-neutral CDF P(S_T ≤ K). */
  cdf(K: number): number;
  probabilityBelow(K: number): number;
  probabilityAbove(K: number): number;
  probabilityBetween(a: number, b: number): number;
  /** Strike at CDF = p (inverse CDF via bisection); p ∈ (0, 1). */
  quantile(p: number): number;
  /** The sampled grid the moments and quantiles are computed on. */
  grid: { strikes: number[]; density: number[]; cdf: number[] };
  moments: {
    totalMass: number; // ∫f dK ≈ 1
    mean: number; // ∫K f dK ≈ forward
    variance: number;
    stdev: number;
    skewness: number;
    excessKurtosis: number;
  };
  pillars: { putStrike; putVolatility; atmStrike; atmVolatility; callStrike; callVolatility };
  order: 1 | 2;
  assumptions: {
    conventionsVersion;
    method: 'breeden-litzenberger';
    smile: 'castagna-mercurio';
    measure: 'risk-neutral-forward';
    order;
  };
  diagnostics: Diagnostics;
}

export function vannaVolgaDensity(input: VannaVolgaDensityInput): VannaVolgaDensity;
```

## Build checklist

1. `vannaVolgaDensity` — validate; build pillars once; pre-scan the grid + stencil through `castagnaMercurio`
   (typed breakdown error on any non-finite vol); compose `riskNeutralDistribution` for the density/CDF/
   probability closures; sample the grid; trapezoid moments; `quantile` bisection; martingale/mass/arb
   diagnostics.
2. Exports (`vannaVolgaDensity`, `VannaVolgaDensityInput`, `VannaVolgaDensity`) in `index.ts`.
3. Tests: lognormal match (flat smile), martingale mean = F, mass ≈ 1, skew monotone in RR, kurtosis ↑ with
   BF, quantile round-trip (`cdf(quantile(p)) ≈ p`), `probabilityBetween` consistency, the inverted-butterfly
   breakdown error, and the input guards; 100% coverage of the new code.

## Deferred (explicitly)

- **5-pillar (10Δ) vanna-volga** — the remaining vanna-volga follow-up (a richer smile → a sharper density).
- **A physical-measure re-weighting** (risk-neutral → real-world density via a pricing kernel) — a separate,
  larger modeling step; this spec is the risk-neutral density only.
