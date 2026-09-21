# Spec — Cost-aware Kelly sizing (`@totalfinance/risk`)

> Roadmap Tier 2 → Sizing → Kelly _"Follow-up: … cost-aware sizing …"_ Status: **shipped** as
> `costAwareKelly` in `packages/risk/src/kelly.ts`, covered by
> `packages/risk/test/cost-aware-kelly.test.ts`, full CI green. Completes the sizing trilogy alongside
> the single-bet `kellyBet` and the portfolio `shrunkKelly`.

## Goal

Kelly sizes to a **gross** edge, but a trader pays to hold and to trade — financing/borrow carry each
period, and a bid/ask + commission on the round trip. Those costs eat the edge, so the growth-optimal
size is **smaller** than gross Kelly, and below a breakeven cost the "edge" is not worth betting at all.
This answers, for a continuous edge: how much does gross Kelly overbet once costs are paid, what is the
break-even cost, and how much long-run growth do the costs cost you?

## The cost model

Two components, combined into one per-period drag on the edge:

```
c = holdingCost + roundTripCost / horizonPeriods
```

- **holdingCost** — per-period cost per unit of position (financing / borrow / carry).
- **roundTripCost** — the one-time entry + exit cost per unit of position (spread + commission),
  **amortized** over the expected `horizonPeriods` (periods held): a round-trip cost hurts less the longer you
  hold. `horizonPeriods` is required when `roundTripCost > 0`.

Every period's return is reduced by `c`, so the drift shifts (`μ → μ − c`) while the variance is
unchanged.

## The sizing

For a per-period edge with mean `μ` and variance `σ²` (supplied directly, or from a return sample), the
continuous log-growth of a position `f` net of costs is `g(f) = f·(μ − c) − ½f²σ²`, so:

```
grossKelly = μ / σ²                          (ignores costs)
netKelly   = max(0, (μ − c) / σ²)            (the cost-aware growth-optimal fraction)
breakevenCost = μ                            (c ≥ μ ⇒ netKelly = 0 ⇒ don't bet)
grossGrowth = μ² / (2σ²)                      (ideal, no costs)
netGrowth   = (μ − c)² / (2σ²)               (achievable optimum with costs, at netKelly)
growthDrag  = grossGrowth − netGrowth         (the log-growth the costs cost you)
ignoringCostsGrowth = grossKelly·(μ − c) − ½·grossKelly²·σ²   (naively betting gross Kelly while paying c)
```

`ignoringCostsGrowth ≤ netGrowth` always — betting the gross size while paying costs is an overbet that
gives up growth; the gap is the penalty for ignoring costs. _Verified: `netKelly` is the exact argmax of
`g(f)` and `netGrowth` its maximum; at `c = μ` both collapse to 0; `ignoringCostsGrowth < netGrowth`
whenever `c > 0`._ A `fraction` (fractional-Kelly, default 0.5) scales `netKelly` to the
`recommendedFraction`.

## Honesty / envelope contract

- **Refuses a losing bet** — `c ≥ μ` returns `netKelly = 0`, `isProfitable = false`, and a
  `risk.cost_exceeds_edge` warning: the costs consume the entire edge, so don't bet.
- **Flags a heavy cost drag** — when the costs eat a large share of the gross growth
  (`growthDrag / grossGrowth` past a threshold) a `risk.high_cost_drag` warning quantifies it.
- **Discloses the overbet** — `ignoringCostsGrowth` shows exactly what naively using gross Kelly costs.
- **First-touch guards** — non-object input; a non-`{gaussian}`/`{returns}` edge; non-positive variance /
  `< 2` returns; negative `holdingCost`/`roundTripCost`; a `roundTripCost > 0` without a positive
  `horizonPeriods`; non-positive `fraction` — all throw a typed `QuantError`; never a `NaN`.
- **Domain-object envelope (R2)** — a `CostAwareKelly` result with the fractions, growths, breakeven,
  a prose `rationale`, `assumptions`, and `diagnostics`.

## API

```ts
interface CostAwareKellyInput {
  /** The per-period edge: a Gaussian mean/variance, or a return sample (μ, σ² computed from it). */
  edge: { gaussian: { mean: number; variance: number } } | { returns: ArrayLike<number> };
  /** Per-period holding cost per unit of position (financing / borrow / carry). Default 0. */
  holdingCost?: number;
  /** One-time round-trip cost per unit of position (entry + exit). Default 0. Needs `horizonPeriods`. */
  roundTripCost?: number;
  /** Expected holding periods, to amortize `roundTripCost`. Required when `roundTripCost > 0`. */
  horizonPeriods?: number;
  /** Fractional-Kelly multiplier applied to `netKelly`. Default 0.5. Must be > 0. */
  fraction?: number;
}
interface CostAwareKelly {
  /** Per-period cost drag `c = holdingCost + roundTripCost/horizonPeriods`. */
  costPerPeriod: number;
  /** `μ/σ²` — growth-optimal fraction ignoring costs. */
  grossKelly: number;
  /** `max(0, (μ−c)/σ²)` — cost-aware growth-optimal fraction. */
  netKelly: number;
  /** `fraction · netKelly` — the recommended size. */
  recommendedFraction: number;
  /** `μ` — the cost at which the edge vanishes. */
  breakevenCost: number;
  /** Whether the net edge is positive (`c < μ`). */
  isProfitable: boolean;
  /** `μ²/(2σ²)` — expected log-growth at gross Kelly, no costs. */
  grossGrowth: number;
  /** `(μ−c)²/(2σ²)` — expected log-growth at net Kelly (the achievable optimum). */
  netGrowth: number;
  /** `grossGrowth − netGrowth` — the log-growth the costs cost you. */
  growthDrag: number;
  /** Log-growth of naively betting gross Kelly while paying costs (`≤ netGrowth`). */
  ignoringCostsGrowth: number;
  /** The edge `μ` and `σ²` used. */
  mean: number;
  variance: number;
  rationale: string;
  assumptions: { conventionsVersion: string; fraction: number; edgeType: 'gaussian' | 'returns' };
  diagnostics: Diagnostics;
}
function costAwareKelly(input: CostAwareKellyInput): CostAwareKelly;
```

## Build checklist

1. **Edge** — resolve `μ`, `σ²` from `{gaussian}` (variance > 0) or `{returns}` (≥ 2, population
   variance > 0), matching `kellyBet`'s returns convention.
2. **Cost** — validate `holdingCost`/`roundTripCost ≥ 0` and `horizonPeriods > 0` when needed; `c = holding +
roundTrip/horizonPeriods`.
3. **Sizing** — gross/net Kelly, the three growths, drag, breakeven; `recommendedFraction = fraction·netKelly`;
   the `cost_exceeds_edge` / `high_cost_drag` warnings; prose; envelope; export; API report + READMEs/llms.
   (Single-arg ⇒ first-touch **garbage sweep**; no deep-sweep fixture.)
4. **Tests** — `netKelly` is the argmax of `g(f)` and `netGrowth` its max; `c = μ` ⇒ `netKelly = 0`,
   unprofitable warning; `growthDrag = grossGrowth − netGrowth`; `ignoringCostsGrowth < netGrowth` for
   `c > 0`; round-trip amortization (`c = holding + rt/horizonPeriods`); the returns edge matches the Gaussian
   edge with the same `μ, σ²`; guards.

## Deferred (explicitly)

- **Costs on the discrete edges** (binary / outcomes) — the shift is not a uniform drift there (a cost
  above the win flips the outcome), so this milestone is the continuous edge only.
- **A no-trade band** (Davis–Norman proportional-cost control) — the optimal rebalancing region under
  costs, rather than a single-period drift adjustment.
- **Portfolio cost-aware sizing** — per-asset costs netted into the `kelly()` / `shrunkKelly` solve,
  with the sign-dependence of per-position costs handled.
