# Spec — Swaption cube (SABR-on-rates) (`@totalfinance/volatility`)

> Roadmap Tier 2 → Fixed income → _"swaption cube + SABR-on-rates."_ Status: **shipped** as
> `swaptionCube` + `swaptionCubeVolatility` in `packages/volatility/src/swaption-cube.ts`, covered by
> `packages/volatility/test/swaption-cube.test.ts`, full CI green.
>
> **Home decision:** built in `@totalfinance/volatility`, not `@totalfinance/fixed-income`. A swaption cube is a **vol**
> object — the rates analog of the SSVI surface already here — and the SABR machinery it needs
> (`fitSABRSmile`, `sabrVolatility`) lives in `vol`/`options`. `fixed-income` does not depend on `vol`, so
> building it here reuses the tested calibrator with **no new package edge**. The `(expiry, tenor)` axes
> are the only rates-specific part, and they are plain numbers.

## Goal

A **swaption cube** is the interest-rate vol surface: implied volatility as a function of **option
expiry × underlying swap tenor × strike**. A rates desk has broker vol quotes on a grid of
`(expiry, tenor)` nodes, each a smile across strikes — and needs the vol at _any_ `(expiry, tenor,
strike)`, including points between the quoted nodes. This builds that: a **SABR smile calibrated per
node** (so each node's smile is arbitrage-aware and extrapolates in strike), then **bilinear
interpolation of the SABR parameters** across the `(expiry, tenor)` grid.

It is quote-driven, exactly like the SSVI surface: the forward swap rate is an input per node (not
bootstrapped from curves here), so the cube is a pure vol object. Pricing a swaption is then
`annuity · Black(forward, strike, cubeVolatility, expiry)` — the caller supplies the annuity (from
`fixed-income`'s `swaptionPrice`/curves), keeping this package dependency-clean.

## Calibration (per node)

Each node carries a forward swap rate `F`, a set of strikes, and market vols. `swaptionCube` calibrates
`(α, ρ, ν)` per node with the existing `fitSABRSmile` (Hagan expansion, β fixed — 0.5 for rates by
default, per-node override allowed), and records the fitted params, the ATM vol (SABR at `K = F`), the
fit RMSE, and convergence. _Verified: on smiles generated from known SABR params, the per-node
calibration recovers `(α, ρ, ν)` to ~1e-13._ Nodes whose fit is poor (RMSE > 10bp) or non-converged are
disclosed via warnings — never silently trusted.

The grid must be **complete and rectangular**: every `(expiry, tenor)` in `expiries × tenors` present
exactly once, so the bilinear interpolation is well-defined. A missing or duplicated node is a typed
error.

## Evaluation (`swaptionCubeVolatility`)

For a query `(expiry E, tenor T, strike K)`:

1. Bracket `E` in the expiry axis and `T` in the tenor axis (clamp to the boundary when outside the grid
   — flat extrapolation, disclosed).
2. **Bilinearly interpolate** the forward `F` and each SABR parameter `(α, β, ρ, ν)` from the four
   surrounding nodes.
3. Evaluate `sabrVolatility({forward: F, strike: K, t: E}, params, {volatilityType})`.

_Verified: at an exact grid node the interpolation returns that node's SABR vol; a between-nodes query is
bounded by the surrounding nodes' vols (e.g. the `(3, 6)` ATM vol `6.82%` sits inside the corner range
`[5.91%, 7.84%]`)._ Interpolating the **parameters** (rather than the vols) preserves each smile's shape
so the cube extrapolates sensibly in strike at interpolated `(E, T)`; the method is disclosed
(`bilinear-params`).

## Honesty / envelope contract

- **Fit quality is disclosed** — per-node RMSE + convergence on the cube; a `volatility.swaption_node_poor_fit`
  warning names any node over the 10bp threshold or that failed to converge.
- **Extrapolation is disclosed** — a query outside the `(expiry, tenor)` grid clamps to the edge and sets
  `extrapolated: true` with a `volatility.swaption_cube_extrapolated` warning; it never silently pretends the
  point was inside the quoted grid.
- **Grid integrity** — a non-rectangular / incomplete / duplicated node grid is rejected up front.
- **First-touch guards** — non-object input; a node with < 3 strikes, mismatched strikes/vols,
  non-positive forward/strikes/vols; a non-finite query; an empty cube — all throw a typed `QuantError`;
  never a `NaN`.
- **Envelopes (R2)** — `swaptionCube` returns a data-only object (calibrated nodes + axes +
  `assumptions` + `diagnostics`), serializable like `VolatilitySurfaceSnapshot`; `swaptionCubeVolatility` returns a
  value object (`value` + the interpolated `forward`/`params` + `extrapolated` + `assumptions` +
  `diagnostics`).

## API

```ts
interface SwaptionCubeNode {
  expiry: number; // option expiry, years
  tenorYears: number; // underlying swap tenor, years
  forward: number; // forward swap rate (the SABR forward)
  strikes: number[]; // absolute strike rates (≥ 3)
  volatilities: number[]; // market implied vols aligned to strikes
  beta?: number; // per-node backbone β override
}
interface SwaptionCubeInput {
  nodes: SwaptionCubeNode[];
  beta?: number; // default backbone β (0.5, rates)
  volatilityType?: SabrVolatilityType; // 'lognormal' (default) | 'normal'
  maximumIterations?: number; // fitSABRSmile pass-through
  tolerance?: number;
}
interface CalibratedSwaptionNode {
  expiry: number;
  tenorYears: number;
  forward: number;
  parameters: SabrParameters; // { alpha, beta, rho, nu }
  atmVolatility: number; // SABR vol at K = forward
  rmse: number;
  converged: boolean;
}
interface SwaptionCube {
  nodes: CalibratedSwaptionNode[]; // sorted by (expiry, tenor)
  expiries: number[]; // unique, ascending
  tenors: number[]; // unique, ascending
  volatilityType: SabrVolatilityType;
  assumptions: { conventionsVersion: string; volatilityType: SabrVolatilityType; backbone: 'sabr' };
  diagnostics: Diagnostics;
}
function swaptionCube(input: SwaptionCubeInput): SwaptionCube;

interface SwaptionCubeVolatilityQuery {
  cube: SwaptionCube;
  expiry: number;
  tenorYears: number;
  strike: number;
}
interface SwaptionCubeVolatilityResult {
  value: number; // interpolated implied vol
  forward: number; // interpolated forward swap rate
  parameters: SabrParameters; // interpolated SABR params used
  extrapolated: boolean; // query was outside the grid (clamped)
  assumptions: {
    conventionsVersion: string;
    volatilityType: SabrVolatilityType;
    interpolation: 'bilinear-params';
  };
  diagnostics: Diagnostics;
}
function swaptionCubeVolatility(query: SwaptionCubeVolatilityQuery): SwaptionCubeVolatilityResult;
```

## Build checklist

1. **`swaptionCube`** — validate the rectangular grid (unique expiries × tenors, every node present once);
   per-node `fitSABRSmile` (β default/override, volatilityType); record params/atmVolatility/rmse/converged; sort nodes;
   emit poor-fit / non-converged warnings; envelope.
2. **`swaptionCubeVolatility`** — bracket + clamp `E`/`T`; bilinear-interpolate forward + `(α, β, ρ, ν)`; SABR
   vol; the value object with the extrapolation flag + warning.
3. **Envelope + exports + API report + READMEs/llms.** (Both single-arg object inputs ⇒ first-touch
   **garbage sweep**; no deep-sweep fixtures.)
4. **Tests** — per-node calibration recovers known params; a node-exact query equals that node's SABR
   vol; a between-nodes ATM query is bounded by its neighbors; extrapolation sets the flag + warning; a
   poor-fit node warns; grid guards (incomplete/duplicated), node guards (< 3 strikes, length mismatch,
   non-positive), query guards.

## Deferred (explicitly)

- **Curve-driven cube** — computing the forward swap rate + annuity per node from `fixed-income`
  curves/`swapRate` (this milestone takes the forward as a quote, like the SSVI surface).
- **Arbitrage-free interpolation in expiry** (total-variance-linear rather than parameter-linear) and
  calendar/butterfly diagnostics across the cube.
- **Shifted (displaced) SABR** for negative/zero rates — the underlying `fitSABRSmile`/`sabrVolatility` require
  positive forwards and strikes, so this cube is positive-rate only; a displacement `s` (fit on `F + s`,
  `K + s`) is the natural extension.
- **A convexity/CMS adjustment** and the **SABR-implied swaption smile risk** (vega/vanna/volga along
  the cube).
- **Direct swaption pricing** (`cube × annuity → price`) once the curve integration lands.
