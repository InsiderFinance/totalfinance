# Spec — Volatility-surface PCA scenario shocks (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the follow-up flagged on `surfacePCA`: "PCA scenario shocks".
> Status: **shipped** as `surfacePcaScenarios` in `packages/volatility/src/surface-pca.ts`, covered by
> `packages/volatility/test/surface-pca.test.ts`, full CI green.

## Goal

`surfacePCA` learns how a vol surface _moves_ — its principal modes (level / slope / curvature), how much
of the variance each explains, and each mode's daily standard deviation. The natural next question a vol
desk asks is: **what does my surface look like after a 1- or 2-sigma move along each mode?** This turns the
learned modes into **stress scenarios** — shocked surfaces you can reprice a book against — completing the
PCA workflow (fit → interpret → stress).

## The construction

`surfacePCA` returns, for each mode `i`, a **unit-norm** eigenvector `loadings_i` over the grid and an
`eigenvalue λ_i` that is the variance of that mode's factor scores — so `√λ_i` is the mode's **1-sigma
daily move** (verified: `std(scores_i) = √λ_i` to full precision, `‖loadings_i‖ = 1`). A `k`-sigma shock
along mode `i` is therefore a surface change of

```
shockVector = k · √λ_i · loadings_i          shockedSurface = max(floor, base + shockVector)
```

applied to a supplied **base** surface (the current vols at the same grid points). For a **combined**
scenario, independent per-mode moves add:

```
combinedShock = Σ_i s_i · √λ_i · loadings_i          combinedSurface = max(floor, base + combinedShock)
```

Because the level mode's loadings share a sign, a `+k` level shock **raises every vol**; a slope shock
tilts the wings oppositely; curvature bends the smile. Shocked vols are floored (default 0) so a large
downside shock can't produce a negative vol. The change type (`absolute` / `relative`) is inherited from
the PCA and disclosed — for a `relative` PCA the shock is a fractional vol change (documented; the caller
applies it multiplicatively if desired).

_Verified: the shock vector reconstructs `k·√λ·loadings` exactly; a +1σ level shock raises every grid vol;
the floor clamps a large downside shock; the combined surface equals the summed per-mode shocks; and the
per-mode `+1σ` shock advances the base by exactly one factor standard deviation._

## Honesty / envelope contract

- **Composes `surfacePCA`, no new estimation** — the modes/eigenvalues are taken as given; the scenarios are
  exact arithmetic on them, disclosed as `engine: 'surface-pca-scenarios'`.
- **Change type inherited & disclosed** — `assumptions.changeType` echoes whether the shock is an absolute
  vol change or a relative (fractional) one, so the caller applies it correctly.
- **Floor disclosed** — shocked vols are clamped at `floor` (default 0); the raw (unclamped) shock vector is
  also returned so nothing is hidden.
- **First-touch guards** — non-object input; a `pca` without a non-empty `modes` array; a `base` whose
  length ≠ the mode grid size; non-finite `base`/`sigmas`/`combined` entries; a non-positive-integer
  `maxModes`; a `combined` longer than the mode count — all throw a typed `QuantError`. Single-object
  function ⇒ first-touch **garbage sweep** covers it.
- **Envelope (R2)** — a domain object with `base`, `scenarios`, optional `combinedSurface`, `assumptions`,
  `diagnostics`.

## API

```ts
interface SurfacePcaScenarioInput {
  /** The result of `surfacePCA` — its modes drive the shocks. */
  pca: SurfacePcaResult;
  /** Current vols to shock, at the SAME grid points as the PCA (length = pca.gridSize). */
  base: number[];
  /** Shock magnitudes in standard deviations, applied to each mode. Default [-1, 1]. */
  sigmas?: number[];
  /** Shock only the top-N modes. Default all of `pca.modes`. */
  maxModes?: number;
  /** Floor for the shocked vols (a vol can't go negative). Default 0. */
  floor?: number;
  /** Optional per-mode sigma moves → one combined shocked surface. */
  combined?: number[];
}
interface SurfaceScenario {
  mode: number; // 0-indexed
  shape: 'level' | 'slope' | 'curvature' | 'higher-order';
  sigma: number;
  /** k·√λ·loadings — the (unclamped) change vector. */
  shockVector: number[];
  /** max(floor, base + shockVector). */
  shockedSurface: number[];
}
interface SurfacePcaScenarios {
  base: number[];
  /** One per (mode, sigma), in mode-major order. */
  scenarios: SurfaceScenario[];
  /** base + Σ sᵢ·√λᵢ·loadingsᵢ, floored — present only when `combined` is supplied. */
  combinedSurface?: number[];
  assumptions: { conventionsVersion: string; changeType: 'absolute' | 'relative'; floor: number };
  diagnostics: Diagnostics;
}
function surfacePcaScenarios(input: SurfacePcaScenarioInput): SurfacePcaScenarios;
```

## Build checklist

1. **Validate** — `pca.modes` non-empty; `base` length = grid size; finite `sigmas`/`combined`/`floor`;
   `maxModes` a positive integer.
2. **Per-mode shocks** — for the top `maxModes` modes × each `sigma`: `shockVector = sigma·√max(0,λ)·loadings`,
   `shockedSurface = max(floor, base + shockVector)`.
3. **Combined** — when supplied, sum `sᵢ·√λᵢ·loadingsᵢ` over the modes, add to base, floor.
4. **Envelope + export + fixture + API report + READMEs/llms.**
5. **Tests** — reconstruction (`shockVector = k·√λ·loadings`); +1σ level raises all vols; floor clamps;
   combined = summed shocks; a full round-trip through `surfacePCA`; guards.

## Deferred (explicitly)

- **Book repricing under each scenario** — feeding the shocked surfaces into a position P&L (pairs with the
  strategy/risk scenario tables) rather than returning surfaces.
- **Correlated / historical scenarios** — worst historical factor-score combination, and a Cornish-Fisher
  tail scenario, beyond independent per-mode sigma moves.
- **Grid interpolation** — shocking a surface whose grid differs from the PCA's (currently they must match).
