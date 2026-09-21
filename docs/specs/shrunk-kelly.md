# Spec — Estimation-error-shrunk Kelly (`@totalfinance/risk`)

> Roadmap Tier 2 → Sizing → Kelly _"Follow-up: … estimation-error-shrunk Kelly …"_ Status: **shipped**
> as `shrunkKelly` in `packages/risk/src/kelly.ts`, covered by
> `packages/risk/test/shrunk-kelly.test.ts`, full CI green. (Complements the naive portfolio `kelly()`
> optimizer in `optimize.ts` and the single-bet `kellyBet`.)

## Goal

The portfolio Kelly weights `w = Σ⁻¹μ` are growth-optimal only if `μ` and `Σ` are the **true**
parameters. In practice they are **estimated** from a finite sample, and the plug-in `Σ̂⁻¹μ̂` is
famously too aggressive: it fits the sampling noise, so its realized out-of-sample growth is far below
the in-sample promise — and, when the sample is short relative to the number of assets, the naive Kelly
book actually **loses money out of sample**. This is the single most important practical failure of Kelly
sizing, and most libraries ignore it. `shrunkKelly` corrects it: it scales the plug-in weights by the
estimation-error-optimal factor and discloses the honest expected growth.

## The shrinkage

For `n` assets estimated from `T` observations, with the plug-in in-sample squared Sharpe
`θ̂² = μ̂ᵀΣ̂⁻¹μ̂`, the growth-optimal scaling of the plug-in weights is

```
c* = max(0, 1 − (n/T) / θ̂²)   =   θ̂²_corrected / θ̂²          where θ̂²_corrected = θ̂² − n/T
```

and the shrunk weights are `w = fraction · c* · Σ̂⁻¹μ̂` (`fraction` an optional extra fractional-Kelly on
top). The derivation: only `μ̂ ~ N(μ, Σ/T)` is noisy, so the expected out-of-sample growth of `c·Σ⁻¹μ̂`
is `g(c) = c·θ² − ½c²·(θ² + n/T)`, maximized at `c* = θ²/(θ² + n/T)`; plugging the bias-corrected
`θ̂²_corrected = θ̂² − n/T` for `θ²` gives the form above. _Verified against a Monte-Carlo over a known
`(μ, Σ)`: the MC-optimal fixed scaling matches `θ²/(θ²+n/T)` (e.g. `T=60, n=3 → 0.84`), and the
per-realization plug-in `c*` raises realized OOS growth above the naive `c = 1` at every sample size._

## The disclosures (the point)

- **In-sample vs corrected Sharpe** — `θ̂²` (biased high) and `θ̂²_corrected = θ̂² − n/T` (the honest OOS
  squared Sharpe, which can be **≤ 0**).
- **No-edge verdict** — when `n/T ≥ θ̂²` (`θ̂²_corrected ≤ 0`), the estimated edge is indistinguishable
  from sampling noise: `c* = 0`, the weights are all zero, and a `risk.kelly_estimation_no_edge` warning
  fires. Don't bet.
- **Naive-overbet flag** — the naive plug-in's expected OOS growth is `g(1) = ½(θ̂²_corrected − n/T)`;
  when that is **negative** while `c* > 0`, the naive Kelly would erode capital and a
  `risk.kelly_naive_overbet` warning names the gap that shrinkage closes.
- **Thin-sample flag** — `T ≤ 2n` makes the correction extreme and unreliable; computed but flagged
  (`risk.kelly_estimation_thin_sample`).

## Expected growth

At the applied scaling `a = fraction · c*`, the expected OOS log-growth is
`g(a) = a·θ̂²_corrected − ½a²·θ̂²` (so `g(c*) = ½·c*·θ̂²_corrected ≥ 0`); the naive book's is
`g(1) = θ̂²_corrected − ½θ̂²`. Both are reported so the caller sees exactly what the shrinkage buys.

## Honesty / envelope contract

- **Corrects, discloses, refuses** — shrinks toward the OOS-optimal, discloses the biased-vs-corrected
  Sharpe, and returns a **zero** book (not a fabricated edge) when the sample can't tell signal from noise.
- **SPD-guarded** — `Σ̂` must be symmetric positive-definite (`cholesky` throws a typed
  `LinalgNotPositiveDefinite` otherwise); `μ̂`/`Σ̂` dimensions must agree; `T > 0`, `fraction > 0`.
- **Domain-object envelope (R2)** — a `ShrunkKelly` result with the weights, the two Sharpe figures, the
  two growth figures, `assumptions`, and `diagnostics`.

## API

```ts
interface ShrunkKellyInput {
  /** Estimated per-period expected (excess) returns μ̂, one per asset. */
  mean: number[];
  /** Estimated covariance Σ̂ (n×n, symmetric positive-definite). */
  covariance: number[][];
  /** Number of observations T the estimates came from. */
  sampleSize: number;
  /** Extra fractional-Kelly multiplier applied on top of the shrinkage (e.g. 0.5). Default 1. */
  fraction?: number;
}
interface ShrunkKelly {
  /** Estimation-error shrinkage factor c* ∈ [0, 1]. */
  shrinkage: number;
  /** The applied scaling `fraction · c*`. */
  appliedScaling: number;
  /** Shrunk Kelly weights `fraction · c* · Σ̂⁻¹μ̂`. */
  weights: number[];
  /** Naive plug-in Kelly weights `Σ̂⁻¹μ̂`. */
  naiveWeights: number[];
  /** In-sample squared Sharpe `θ̂² = μ̂ᵀΣ̂⁻¹μ̂` (biased high). */
  inSampleSharpeSquared: number;
  /** Bias-corrected OOS squared Sharpe `θ̂² − n/T` (may be ≤ 0). */
  correctedSharpeSquared: number;
  /** Expected OOS log-growth at the applied scaling. */
  expectedGrowth: number;
  /** Expected OOS log-growth of the naive (unshrunk) book — often negative. */
  naiveExpectedGrowth: number;
  assumptions: { conventionsVersion: string; assets: number; sampleSize: number; fraction: number };
  diagnostics: Diagnostics;
}
function shrunkKelly(input: ShrunkKellyInput): ShrunkKelly;
```

## Build checklist

1. **Solve** — validate dims + SPD; `L = cholesky(Σ̂)`, `naive = choleskySolve(L, μ̂)` = `Σ̂⁻¹μ̂`;
   `θ̂² = μ̂ · naive`.
2. **Shrink** — `c* = θ̂² > 0 ? max(0, 1 − (n/T)/θ̂²) : 0`; `weights = fraction·c*·naive`;
   the two Sharpe + two growth figures.
3. **Disclose** — the no-edge / naive-overbet / thin-sample warnings; envelope; export; API report +
   READMEs/llms. (Single-arg ⇒ first-touch **garbage sweep**; no deep-sweep fixture.)
4. **Tests** — `c*` matches `1 − (n/T)/θ̂²` and → 1 as `T` grows; the shrunk book's expected OOS growth
   ≥ the naive book's; a short sample (`n/T ≥ θ̂²`) returns `c* = 0` with the no-edge warning; the
   naive-overbet warning fires when `g(1) < 0 < c*`; SPD / dimension / `fraction` guards.

## Deferred (explicitly)

- **Cost-aware sizing** — netting linear transaction / borrow costs from `μ̂` before the solve (the other
  Kelly follow-up); a clean extension once this lands.
- **Shrinking the inputs themselves** — Ledoit–Wolf on `Σ̂`, James–Stein on `μ̂` — before the Kelly
  solve, rather than only scaling the resulting weights.
- **Constrained shrunk Kelly** — feeding the shrinkage into the constrained `kelly()` optimizer
  (long-only / gross cap), not just the unconstrained weights.
