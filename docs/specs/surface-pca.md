# Spec — Volatility-surface PCA (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → _"…surface PCA (level/slope/curvature dynamics); sticky-strike vs
> sticky-delta regime measurement."_ Status: **shipped** as `surfacePCA` in
> `packages/volatility/src/surface-pca.ts`, covered by `packages/volatility/test/surface-pca.test.ts`, full CI green.
> (Sticky-strike vs sticky-delta regime measurement remains.)

## Goal

The package fits and interpolates a vol surface at a point in time; this answers the complementary
question — **how does the surface _move_?** Given a history of surface snapshots, `surfacePCA` runs a
principal-component analysis of the surface **changes** and reports the dominant modes, which for an
implied-vol surface are the same three Litterman–Scheinkman shapes as a yield curve:

- **level** — a parallel shift (the whole surface up/down),
- **slope** — a tilt (front vs back, or downside vs upside skew steepening),
- **curvature** — a bowing (wings vs the belly).

Each mode comes with its **variance explained** (how much of the surface's daily motion it drives) and a
**factor-score time series** (how much that mode fired each day) — the raw material for surface risk
models, scenario generation, and vol-of-vol analysis.

## The change panel

Input is `snapshots: number[][]` — `snapshots[t]` is the implied-vol vector at a **fixed** set of grid
points (same strikes/tenors every snapshot), one row per observation time. From `T` snapshots come
`T − 1` **change** vectors:

- `changes: 'absolute'` (default): `Δσ_t = σ_t − σ_{t−1}` — vol points.
- `changes: 'relative'`: `Δσ_t = (σ_t − σ_{t−1}) / σ_{t−1}` — proportional moves (needs `σ_{t−1} ≠ 0`).

The changes are **column-centered** (each grid point's mean change removed), their `G × G` covariance is
formed, and its eigendecomposition (`jacobiEigen`, symmetric) gives the modes, ordered by eigenvalue.

## Modes and shape labeling

For each retained mode (default all `G`, or the top `maxComponents`):

- **loadings** — the eigenvector across the grid, sign-canonicalized (its loadings sum ≥ 0) for a stable
  orientation.
- **varianceExplained** = `λ_k / Σλ` (non-negative eigenvalues); **cumulative** across modes.
- **shape** — labeled from the number of **sign changes** in the loadings, read along the grid order
  (`gridPoints` if supplied, else the input column order): `0 → level`, `1 → slope`, `2 → curvature`,
  `≥3 → higher-order`. Loadings within `15%` of the peak magnitude are treated as ≈ 0 so a wiggle near
  zero doesn't fabricate a crossing. _(Verified: recovers level (57.9% var, 0 crossings), slope (32.1%,
  1), curvature (10.0%, 2) from a synthetic level+slope+curvature panel.)_
- **scores** — the factor-score series: each centered change projected onto the loadings
  (`score_{k,t} = Δσ_t · loadings_k`), i.e. how strongly mode `k` fired at each time. Orthonormal
  eigenvectors ⇒ `Δσ_t = Σ_k score_{k,t}·loadings_k` (the changes reconstruct from the scores).

## Honesty / envelope contract

- **Shape is derived, not assumed** — the level/slope/curvature label comes from the eigenvector's actual
  sign pattern; a surface whose second mode isn't a clean tilt is labeled `higher-order`, not forced.
- **Variance is disclosed** — `varianceExplained` per mode and the cumulative curve show exactly how much
  motion the top modes capture, so "3 factors explain 92%" is a number, not a claim.
- **Ordering for labeling is explicit** — `gridPoints` orders the loadings for the sign-change count;
  without it the input column order is assumed and echoed in `assumptions`.
- **Envelope (R2)** — the result carries `assumptions` (change type, grid ordering) and `diagnostics`;
  a non-positive-definite sample covariance (fewer changes than grid points) still decomposes, with the
  near-zero/negative eigenvalues reported as ~0 variance rather than hidden.
- Typed guards (≥ 2 snapshots; ≥ 2 grid points; equal-length rows; finite; `maxComponents ≥ 1`; relative
  changes need non-zero prior vols).

## API

```ts
interface SurfacePcaInput {
  /** IV snapshots over time; snapshots[t] is the vol vector at the (fixed) grid points. */
  snapshots: number[][];
  /** Ordered grid coordinates (moneyness or tenor), one per column — for shape labeling. Optional. */
  gridPoints?: number[];
  /** How to difference consecutive snapshots; default 'absolute'. */
  changes?: 'absolute' | 'relative';
  /** Retain only the top-k modes; default all (= grid size). */
  maxComponents?: number;
}
interface SurfaceMode {
  loadings: number[];
  eigenvalue: number;
  varianceExplained: number;
  shape: 'level' | 'slope' | 'curvature' | 'higher-order';
  scores: number[]; // factor score per change observation
}
interface SurfacePcaResult {
  modes: SurfaceMode[];
  cumulativeVarianceExplained: number[]; // cumulative up to each mode
  totalVariance: number;
  observations: number; // number of change vectors (snapshots − 1)
  gridSize: number;
  changeType: 'absolute' | 'relative';
  assumptions: { conventionsVersion: string; changeType: string; ordered: boolean };
  diagnostics: Diagnostics;
}
function surfacePCA(input: SurfacePcaInput): SurfacePcaResult;
```

## Build checklist

1. **Panel** — validate; build the `T−1` change vectors (absolute/relative); column-center.
2. **PCA** — `G×G` covariance; `jacobiEigen`; order by eigenvalue; sign-canonical loadings;
   variance-explained + cumulative.
3. **Modes** — shape labeling (sign changes on grid-ordered loadings) and the factor-score series.
4. **Envelope + exports + API report + READMEs/llms** (single-arg ⇒ garbage-sweep only, no deep fixture).
5. **Tests** — recovers and labels level/slope/curvature from a synthetic panel; variance-explained is
   decreasing and cumulates to 1; the scores reconstruct the changes (orthonormal identity); relative vs
   absolute; `maxComponents` truncates; `gridPoints` reorders the shape labeling; guards.

## Deferred (explicitly)

- **Sticky-strike vs sticky-delta regime measurement** — the other half of the roadmap line: regress
  fixed-strike IV changes on spot returns to place the market on the sticky-strike ↔ sticky-moneyness
  axis (complements `minimumVarianceDelta`, which _assumes_ a regime).
- **Wiring PCA scenarios into `scenarioGrid`** — shock the surface by ±k·σ along a mode.
- **Rolling / EWMA covariance** for a time-varying mode structure.
- **Cross-sectional surface PCA** (one snapshot's smile shape) as distinct from the temporal-change PCA.
