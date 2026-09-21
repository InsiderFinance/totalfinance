# Spec — Kelly bet-sizing pack (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → _"Sizing: multi-period Kelly, drawdown-constrained Kelly."_
> Status: **shipped** as `kellyBet` in `packages/risk/src/kelly.ts`, covered by
> `packages/risk/test/kelly.test.ts`, full CI green.

## Goal

"How much of my account do I put on this?" is the single most consequential — and most abused — number
in trading. The Kelly criterion answers it: the fraction of bankroll that maximizes long-run compound
growth. But **full Kelly is violent** — at full Kelly the probability of _ever_ falling to a
fraction `b` of your starting capital is exactly `b` (a 50% chance of ever halving), and real return tails make
the naive Gaussian Kelly dangerously too large. `kellyBet` computes the growth-optimal fraction from a
trade's edge — a **binary** win/loss bet, a discrete **payoff distribution**, a **Gaussian** `μ/σ²`, or
a raw **return sample** — and then sizes it _sanely_: **fractional-Kelly by default (half-Kelly)**,
capped by an explicit **drawdown budget**, with the growth/drawdown tradeoff, the fat-tail correction,
and the "no edge → don't bet" verdict all disclosed.

## Not the portfolio `kelly()`

`@totalfinance/risk` already exports `kelly()` in `optimize.ts` — the **portfolio-allocation** Kelly,
`w = fraction·Σ⁻¹μ`, weights across correlated assets. `kellyBet` is the orthogonal, single-bankroll
**bet-sizing** question: one edge, one number, with the drawdown and multi-period growth machinery a
sizing decision actually needs. They compose (size a book with `kelly()`, size a single trade with
`kellyBet`) but neither reimplements the other.

## Edge specifications

The edge is given exactly one of four ways (self-describing keys, not a `kind` tag):

```ts
edge:
  | { binary: { winProbability: number; winAmount: number; lossAmount?: number } } // per unit staked; lossAmount default 1
  | { outcomes: Array<{ probability: number; payoff: number }> }                    // discrete P&L per unit staked
  | { gaussian: { mean: number; variance: number } }                               // per-period arithmetic moments
  | { returns: ArrayLike<number> };                                                // per-period return sample
```

**Full Kelly `f*`** (growth-optimal fraction of bankroll) per edge type — each the maximizer of the
per-period log-growth `g(f) = E[ln(1 + f·r)]`:

- **binary** — closed form `f* = p/a − q/b` (`p` = winProbability, `q = 1−p`, `b` = winAmount,
  `a` = lossAmount). Derivation: `g'(f) = p·b/(1+f·b) − q·a/(1−f·a) = 0 ⟹ f* = (p·b − q·a)/(a·b)`.
- **gaussian** — closed form `f* = μ/σ²`, the standard continuous result.
- **outcomes / returns** — the **exact empirical** Kelly: numerically maximize
  `g(f) = Σ pᵢ·ln(1+f·payoffᵢ)` (resp. the sample mean of `ln(1+f·rᵢ)`) over `f ∈ (0, f_max)`, where
  `f_max = 1/L` and `L` is the worst loss magnitude (`max(0, −min payoff)`). `g` is strictly concave on
  that domain, so the maximizer is unique (Brent 1-D minimization of `−g`).

The **returns** path also reports `gaussianKelly = μ/σ²` (population moments of the sample) alongside
the exact empirical `f*`, so the **fat-tail correction is visible**: when the sample has fat left tails
the empirical `f*` is materially below the Gaussian number, and the rationale says so.

## Sizing: fractional, drawdown-constrained, capped

The recommended fraction is the growth-optimal `f*` scaled down by whichever of three caps binds first:

- **Fractional Kelly** — `fraction · f*`. **Default `fraction = 0.5`** (half-Kelly): it keeps ~75% of the
  growth (`g(κ) = g_full·κ(2−κ)`, so `κ=0.5 ⟹ 0.75·g_full`) for far less drawdown. The default is a
  deliberate, disclosed choice — set `fraction: 1` for full Kelly.
- **Drawdown budget** — `drawdownLimit: { toFraction: b, maxProbability: p }` caps the applied Kelly
  multiple to `κ_max = 2 / (1 + ln p / ln b)` (non-binding when `1 + ln p/ln b ≤ 0`). Below.
- **Hard cap** — `maxFraction` (e.g. `1` = no leverage / no margin).

`recommendedFraction = max(0, min(fraction·f*, κ_max·f*, maxFraction))`, and `bindingConstraint` reports
which one set it (`'fraction' | 'drawdown-limit' | 'max-fraction' | 'no-edge'`).

### The drawdown model (continuous approximation)

At an applied Kelly multiple `κ = f/f*` (betting `κ` of full Kelly), the wealth process is a GBM whose
log-drift `ν` and vol `σ_W` satisfy `2ν/σ_W² = 2/κ − 1`. The first-passage (running-minimum) law of GBM
gives the probability that wealth **ever** falls to a fraction `b < 1` of the **starting bankroll**
(the Thorp / MacLean–Ziemba result — relative to _initial_ capital, not a running peak):

```
P(ever fall to b×W₀) = b^(2/κ − 1)   (clamped to [0,1]; = 1 for κ ≥ 2, where the log-drift is ≤ 0)
```

At full Kelly (`κ=1`): `P = b` (the classic result — a `b` chance of ever reaching `b×W₀`). At
half-Kelly (`κ=0.5`): `P = b³` — the chance of ever halving falls from 50% to 12.5%. Inverting for the
**drawdown-constrained** multiple: `b^(2/κ−1) ≤ p ⟺ κ ≤ 2/(1 + ln p/ln b)`. This is a
continuous/log-normal approximation (exact for GBM, a good guide for the discrete edges) — **disclosed
as such** in `assumptions.drawdownModel`. Verified against a direct GBM Monte-Carlo first-passage
simulation (κ=1 → 60% and κ=0.5 → 21.6% at `b=0.6`, matching the simulated hitting frequencies).

`drawdownRisk: { toFraction, probability }` reports `P(ever fall to toFraction×W₀)` **at the recommended
fraction** (default `toFraction` = the `drawdownLimit`'s `b`, else `0.5`).

## Multi-period growth

Kelly is inherently multi-period — it maximizes long-run log-growth. The result surfaces:

- `growthRate` = `g(recommendedFraction)` and `growthRateFull` = `g(f*)` (the max), both exact per edge.
- `periodsToDouble` = `ln 2 / growthRate` (`Infinity` when `growthRate ≤ 0`).
- Optional `horizonPeriods` (periods) → `horizonLogGrowth = horizonPeriods·growthRate` and
  `horizonGrowthMultiple = exp(horizonPeriods·growthRate)` (the median wealth multiple over the horizonPeriods).

## Honesty / envelope contract

- **Sane default, loudly disclosed** — half-Kelly by default; `assumptions.fraction` and the rationale
  both state it so a full-Kelly user knows to override.
- **No edge → do not bet** — `f* ≤ 0` ⟹ `recommendedFraction = 0`, `bindingConstraint = 'no-edge'`, a
  `risk.kelly_no_edge` warning, and a rationale that says "the edge is non-positive; Kelly says pass."
  Never a hedged small number, never a short recommendation (that's a different bet).
- **No downside → no finite optimum (finite-success law)** — an edge with no losing outcome makes `g`
  increase without bound, so there is no finite unconstrained optimum. `fullKelly` is `null` (never
  `Infinity`, Wave 6 §2C), a `risk.kelly_unbounded` warning fires, and `growthRateFull` / `appliedFraction`
  are `null`. A finite recommendation requires an explicit `maxFraction`: with one, `recommendedFraction`
  is that cap (`bindingConstraint = 'max-fraction'`); without one, `recommendedFraction` is `null` and
  `bindingConstraint = 'no-downside'` — honest rather than a fabricated `Infinity`.
- **Fat tails disclosed** — the returns path surfaces `gaussianKelly`; when it exceeds the empirical
  `f*` by a material margin the rationale calls out the tail correction.
- **Over-Kelly is flagged** — an applied `κ > 1` (e.g. `fraction > 1`) carries a `risk.kelly_over` warning
  that the drawdown probability is severe.
- Typed guards (probabilities in range and summing to 1; positive amounts/variance; ≥ 2 finite returns
  with positive variance; valid `fraction`/`maxFraction`/`drawdownLimit`); pure and deterministic.

## API

```ts
interface KellyBetInput {
  edge:
    | { binary: { winProbability: number; winAmount: number; lossAmount?: number } }
    | { outcomes: Array<{ probability: number; payoff: number }> }
    | { gaussian: { mean: number; variance: number } }
    | { returns: ArrayLike<number> };
  /** Fraction of full Kelly to apply (0.5 = half-Kelly). Default 0.5. Must be > 0. */
  fraction?: number;
  /** Cap the applied Kelly multiple so P(ever falling to `toFraction` of starting bankroll) ≤ `maxProbability`. */
  drawdownLimit?: { toFraction: number; maxProbability: number };
  /** Hard cap on the recommended fraction of bankroll (e.g. 1 = no leverage). Must be > 0. */
  maxFraction?: number;
  /** Optional horizonPeriods (periods) for the growth projection. Must be > 0 when given. */
  horizonPeriods?: number;
}
interface KellySizing {
  fullKelly: number | null; // f* — growth-optimal fraction (null if no downside — no finite optimum)
  recommendedFraction: number | null; // after caps (≥ 0); null only for no-downside with no cap
  appliedFraction: number | null; // κ = recommendedFraction / fullKelly (0 no edge; null no downside)
  growthRate: number | null; // g(recommendedFraction), exact; null when no finite recommendation
  growthRateFull: number | null; // g(f*); null for a no-downside edge
  periodsToDouble: number | null; // ln2/growthRate (Infinity if ≤ 0; null when no recommendation)
  drawdownRisk: { toFraction: number; probability: number };
  bindingConstraint: 'fraction' | 'drawdown-limit' | 'max-fraction' | 'no-edge' | 'no-downside';
  gaussianKelly?: number; // returns path only — μ/σ² for the fat-tail comparison
  horizonGrowth?: { horizonPeriods: number; logGrowth: number; growthMultiple: number };
  rationale: string; // prose an agent relays
  assumptions: {
    conventionsVersion: string;
    fraction: number;
    drawdownModel: 'continuous-gbm';
    edgeType: 'binary' | 'outcomes' | 'gaussian' | 'returns';
  };
  diagnostics: Diagnostics;
}
function kellyBet(input: KellyBetInput): KellySizing;
```

## Build checklist

1. **Types** — the interfaces above.
2. **Full Kelly** — binary/gaussian closed forms; outcomes/returns via `brentMin` on `−g` over
   `(0, f_max)`; `f* ≤ 0 → no-edge`; no-loss `→ fullKelly: null` (finite-success law) + warning.
3. **Growth** — exact `g(f)` per edge; `growthRateFull`; `periodsToDouble`; optional horizonPeriods.
4. **Sizing** — fractional (default 0.5), `κ_max` drawdown solve, `maxFraction`; `recommendedFraction`
   - `bindingConstraint`.
5. **Drawdown** — `P(drawdown to b) = b^(2/κ−1)`, clamped; at the recommended fraction.
6. **Rationale** — prose grounded in the numbers, with the disclosures above.
7. **Exports + API report + READMEs/llms.**
8. **Tests** — binary closed form vs a brute-force log-growth max; outcomes/returns empirical `f*`
   matches a grid search; `gaussian f* = μ/σ²`; growth parabola `g(κ)=g_full·κ(2−κ)`; the drawdown
   formula verified against a direct GBM Monte-Carlo running-minimum; each cap binds when it should and
   `bindingConstraint` names it; no-edge/no-loss/over-Kelly; fat-tail returns show
   `empirical f* < gaussianKelly`; horizonPeriods projection; envelope/guards.

## Deferred (explicitly)

- **Simultaneous-bet Kelly** across correlated trades — that's the existing portfolio `kelly()`; a future
  convenience could bridge a set of `kellyBet` edges + a correlation matrix into it.
- **Discrete-edge exact drawdown** (a per-edge ruin probability instead of the GBM approximation).
- **Uncertainty-shrunk Kelly** — shrink `f*` for estimation error in `μ`/`p` (a Bayesian/robust Kelly).
- **Transaction-cost-aware Kelly** — net the edge of round-trip costs before sizing.
