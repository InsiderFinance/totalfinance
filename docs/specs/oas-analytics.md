# Spec — Option-adjusted-spread analytics (`@totalfinance/fixed-income`)

> Roadmap Tier 2 → Fixed income → "OAS on the existing short-rate lattice". Completes the callable-bond
> story: the existing `callableBond` returns a bare OAS; this adds the risk decomposition traders actually
> quote.
> Status: **shipped** as `oasAnalytics` in `packages/fixed-income/src/lattice.ts`, covered by
> `packages/fixed-income/test/lattice.test.ts`, full CI green.

## Goal

`callableBond` already computes an **option-adjusted spread** — the parallel curve shift that reprices the
lattice model to a market price. But an OAS in isolation is not actionable. Desks quote it **against the
Z-spread** (the option cost) and hedge on the **OAS-consistent** duration and convexity — the risk measured
with the spread _held fixed_ while the curve moves, not the zero-spread model risk `callableBond` reports.
`oasAnalytics` is the market-calibrated companion that delivers all of it from one call.

## The decomposition

On the same calibrated Hull-White / Black-Karasinski tree the `callableBond` pricer uses, with the bond's
cash flows rolled back and the call (cap) / put (floor) applied at each option node:

- **OAS** — solve `s` such that `callablePrice(curve.shift(s)) = marketPrice` (Brent). The spread the market
  charges the model **after** accounting for the embedded option.
- **Z-spread** — solve `s` such that `straightPrice(curve.shift(s)) = marketPrice` on the **same tree**
  (the σ-free, no-optionality leg of the same rollback). The zero-volatility spread.
- **Option cost** = `zSpread − oas`. Because both are solved on the same lattice, this isolates the
  optionality (the discretization cancels): **positive for a callable** (the holder is short the call, so
  the model needs _less_ spread to reach the market price ⇒ `oas < zSpread`) and **negative for a putable**
  (the holder is long the put ⇒ `oas > zSpread`). _Verified: a callable prices to `+30 bps` option cost, a
  putable to `−72 bps`, and an unreachable option collapses the two to within `0.04 bp`._
- **OAS-consistent effective duration & convexity** — shock the curve `±Δy` **holding the OAS fixed**
  (`curve.shift(oas ± Δy)`), reprice the callable, and central-difference:

  ```
  P₀ = callablePrice(curve.shift(oas)) = marketPrice        (recovered exactly, by construction)
  effectiveDuration  = (P₋ − P₊) / (2·P₀·Δy)
  effectiveConvexity = (P₊ + P₋ − 2·P₀) / (P₀·Δy²)
  ```

  These are the market-consistent risk numbers — distinct from `callableBond.effectiveDuration`, which
  shocks the curve at **zero** spread (a model duration). _Verified: `P₀` recovers the market price to
  machine precision and the OAS duration differs from the model duration (3.35 vs 3.13 on the sample bond)._

## Honesty / envelope contract

- **Same-lattice consistency disclosed** — OAS and Z-spread are both solved on the one tree, so
  `optionCost` is pure optionality; the `method` names the two Brent solves.
- **Reuses the pricer, no new model** — composes the private `priceCallableOnCurve` the `callableBond`
  engine already uses; identical conventions (ACT/365F, the model/`a`/`sigma`/`stepsPerYear` knobs echoed).
- **Non-convergence is an error, never a fabricated spread** — the OAS / Z-spread Brent solves throw a typed
  `ConvergenceError` if the market price is outside the `±500 bp` bracket (as `callableBond` does).
- **First-touch guards** — non-object input; a missing `marketPrice`; no call/put schedule; the bond
  maturing on/before valuation — all typed `QuantError`. Single-object function ⇒ first-touch **garbage
  sweep** covers it (no fixture).
- **Envelope (R2)** — a domain object with the spreads, risk, echoed `assumptions`, and `diagnostics`.

## API

```ts
interface OasAnalyticsSpecification {
  bond: Bond;
  curve: YieldCurve;
  a: number;
  sigma: number;
  model?: TreeModel; // default 'hull-white'
  calls?: BondOption[];
  puts?: BondOption[];
  stepsPerYear?: number; // default 24
  /** Market dirty price the OAS/Z-spread are solved to. Required. */
  marketPrice: number;
  /** Curve shock for the effective duration/convexity, in decimal. Default 1e-4 (1 bp). */
  durationShock?: number;
  /**
   * Optional term-structure spread curve added to `curve` before the spreads are solved: the effective
   * benchmark is `curve` + `spreadCurve` (continuous zeros add ⇔ discount factors multiply), so the OAS
   * and Z-spread are measured OVER a non-flat benchmark — e.g. an OIS discount curve plus a sector/rating
   * spread — not just a flat one. Its zero rates ARE the spreads; same reference date as `curve`. A flat
   * σ shifts the OAS by exactly −σ; a zero spread is a no-op. `diagnostics.method` discloses when applied.
   */
  spreadCurve?: YieldCurve;
}
interface OasAnalyticsResult {
  /** Parallel curve shift repricing the callable model to `marketPrice` (decimal; ×1e4 = bps). */
  oas: number;
  /** Zero-volatility spread on the same lattice's straight leg (decimal). */
  zSpread: number;
  /** `zSpread − oas` (decimal) — the embedded-option cost. Positive callable / negative putable. */
  optionCost: number;
  /** OAS-consistent effective duration (curve shocked at constant OAS). */
  effectiveDuration: number;
  /** OAS-consistent effective convexity. */
  effectiveConvexity: number;
  /** The no-spread lattice model price (what the OAS explains the gap to). */
  modelPrice: number;
  marketPrice: number;
  assumptions: {
    conventionsVersion: string;
    dayCount: 'ACT/365F';
    settlementDate: string;
    model: TreeModel;
    stepsPerYear: number;
    a: number;
    sigma: number;
  };
  diagnostics: Diagnostics;
}
function oasAnalytics(spec: OasAnalyticsSpecification): OasAnalyticsResult;
```

## Build checklist

1. **Validate** — object, `marketPrice` present, at least one call/put (reuse the `callableBond` guards).
2. **OAS + Z-spread** — two Brent solves over `curve.shift(s)` on `priceCallableOnCurve(...).callable` /
   `.straight`; `optionCost = zSpread − oas`.
3. **Risk** — reprice the callable at `curve.shift(oas ± Δy)`; central-difference duration & convexity;
   `P₀` at `curve.shift(oas)`.
4. **Envelope + export + API report + READMEs/llms.**
5. **Tests** — callable `optionCost > 0`, putable `optionCost < 0`; unreachable option ⇒ `oas ≈ zSpread`;
   `P₀ = marketPrice`; duration > 0 and differs from the model duration; convexity finite; guards.

## Deferred (explicitly)

- **Key-rate (partial) durations** — bucketed curve shocks at constant OAS.
- **OAS to a spread curve** (not a flat parallel shift) and a credit-spread-aware OAS.
- **Volatility sensitivity** (the OAS's dependence on the tree `sigma` — "vega" of the embedded option).
