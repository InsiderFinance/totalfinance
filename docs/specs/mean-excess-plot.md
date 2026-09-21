# Spec — Mean-excess plot & EVT threshold selection (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → the follow-up flagged on the EVT tail-risk pack: "threshold-choice
> diagnostics (mean-excess plot)".
> Status: **shipped** as `meanExcessPlot` in `packages/risk/src/evt.ts`, covered by
> `packages/risk/test/evt.test.ts`, full CI green.

## Goal

`fitGeneralizedParetoTail` / `extremeValueTailRisk` fit a Generalized Pareto tail **above a threshold `u`** — but the pack takes
that threshold (`tailFraction`, default 0.10) with **no guidance on choosing it**, which is the single most
consequential EVT decision: too low and the fit is biased by the non-tail body; too high and it is starved
of data. The **mean-excess plot** is the standard tool. The mean-excess function

```
e(u) = E[X − u | X > u]
```

is **linear in `u` above the true tail threshold** for a GPD tail — with slope `ξ/(1−ξ)` — and non-linear
(typically flat/declining for a light body) below it. So the threshold is read off as **where the curve
straightens**. `meanExcessPlot` computes the curve, and adds a heuristic **suggested threshold** (the lowest
`u` above which the curve is linear within a tolerance), the **tail-index estimate** `ξ` from that region's
slope, and the **`suggestedTailFraction`** to hand straight to `fitGeneralizedParetoTail`.

## The construction

Working on **losses** (`loss = −return`, the same convention as the rest of the pack):

- **The curve** — over a grid of candidate thresholds `u` (explicit, or auto: `gridSize` evenly-spaced
  values from the `startQuantile` loss up to the loss leaving `minExceedances` exceedances), each point
  reports `e(u)` = the mean of the excesses `(loss − u)` among losses `> u`, the exceedance count `Nu`, and
  the standard error `sd(excesses)/√Nu`.
- **Suggested threshold** — scan the candidates low→high; for each `u` (with `≥ minExceedances` above and
  `≥ 3` candidates above), fit a line to `e(·)` over `[u, uₘₐₓ]` and take the max absolute deviation of those
  points from the line, normalized by the `e`-range. The suggested threshold is the **lowest** `u` whose
  normalized deviation `≤ linearTolerance` (use as much data as possible while staying linear); if none
  qualifies, the highest candidate with enough exceedances, with a `risk.mean_excess_no_linear_region`
  warning.
- **Tail index** — the slope `b` of the line over `[suggestedThreshold, uₘₐₓ]` gives `ξ = b/(1+b)` (inverting
  `slope = ξ/(1−ξ)`).
- **Suggested tail fraction** — `Nu(suggestedThreshold)/n`, ready for `fitGeneralizedParetoTail({ tailFraction })`.

_Verified: on GPD(ξ)-tailed losses the mean-excess is linear and the slope recovers `ξ` (0.306 vs 0.30);
on a light-body + heavy-tail mixture the suggested threshold lands in the tail region; and feeding the
suggested threshold to `fitGeneralizedParetoTail` yields a `ξ` consistent with the plot's estimate._

## Honesty / envelope contract

- **A diagnostic, disclosed as heuristic** — the mean-excess plot is fundamentally a visual/judgment tool;
  `suggestedThreshold` is the honest automation of "where it straightens," disclosed as a heuristic and
  warned when no clear linear region exists (`risk.mean_excess_no_linear_region`) — never presented as a
  definitive answer.
- **Loss convention shared** — operates on `loss = −return`, matching `fitGeneralizedParetoTail`/`extremeValueTailRisk`, and the
  `suggestedTailFraction` plugs straight into them.
- **Insufficient-data guard** — when the auto-grid collapses (too few losses for `startQuantile` /
  `minExceedances` to separate) it throws a typed error asking for more data or a lower `startQuantile`.
- **First-touch guards** — non-array / `< 2` / non-finite returns (via the shared `toLosses`); a
  `startQuantile` outside `(0, 1)`; a non-positive `gridSize`/`minExceedances`; a non-finite explicit
  threshold — all throw a typed `QuantError`.
- **Envelope (R2)** — a domain object with the `points`, `suggestedThreshold`, `tailIndexEstimate`,
  `suggestedTailFraction`, `assumptions`, `diagnostics`.

## API

```ts
interface MeanExcessPlotOptions {
  /** Explicit candidate thresholds (loss units); else an auto grid. */
  thresholds?: number[];
  /** Auto-grid point count. Default 25. */
  gridSize?: number;
  /** Auto-grid lower bound as a loss quantile. Default 0.5 (the median loss). */
  startQuantile?: number;
  /** Minimum exceedances the top threshold retains (and the fit-reliability floor). Default 10. */
  minExceedances?: number;
  /** Normalized deviation below which the mean-excess counts as linear. Default 0.1. */
  linearTolerance?: number;
}
interface MeanExcessPoint {
  threshold: number;
  meanExcess: number;
  exceedances: number;
  standardError: number;
}
interface MeanExcessPlot {
  points: MeanExcessPoint[];
  /** Heuristic tail-onset threshold — the lowest u above which e(·) is ~linear. */
  suggestedThreshold: number;
  /** ξ from the slope over [suggestedThreshold, uₘₐₓ]: ξ = slope/(1+slope). */
  tailIndexEstimate: number;
  /** Nu(suggestedThreshold)/n — hand to `fitGeneralizedParetoTail({ tailFraction })`. */
  suggestedTailFraction: number;
  assumptions: { conventionsVersion: string; observations: number; losses: number };
  diagnostics: Diagnostics;
}
function meanExcessPlot(returns: ArrayLike<number>, opts?: MeanExcessPlotOptions): MeanExcessPlot;
```

## Build checklist

1. **Losses + grid** — reuse `toLosses`; build the auto grid (or take explicit thresholds); guard the
   collapse case.
2. **Curve** — `e(u)`, `Nu`, standard error per threshold.
3. **Suggested threshold** — the lowest linear-region threshold (with the fallback + warning).
4. **Tail index + tail fraction** — slope over the linear region → `ξ`; `Nu/n`.
5. **Envelope + export + API report + READMEs/llms.**
6. **Tests** — GPD linearity + `ξ` recovery; the mixture threshold onset; `suggestedTailFraction` →
   `fitGeneralizedParetoTail` consistency; the no-linear-region warning; guards.

## Deferred (explicitly)

- **A threshold-stability plot** (`ξ̂(u)` and `β̂(u)` across thresholds — the parameter-stability companion
  diagnostic) and an automatic multiple-threshold goodness-of-fit criterion.
- **Bootstrap confidence bands** on the mean-excess curve (the EVT pack's other flagged follow-up).
- **The Hill plot** for the tail index (`ξ` vs the number of upper order statistics).
