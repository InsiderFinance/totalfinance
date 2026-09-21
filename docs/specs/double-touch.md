# Spec — Double one-touch / double no-touch (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: … double one-touch / double no-touch …"_ Status:
> **shipped** as `doubleTouch` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/double-touch.test.ts`, full CI green. (Builds on the single-barrier `touch`.)

## Goal

A **double no-touch (DNT)** pays a fixed amount if the underlying stays inside a corridor `(L, U)` for the
whole life; a **double one-touch (DOT)** pays if it ever _leaves_ the corridor (touches either barrier).
They are the single-`touch`'s two-barrier sibling and the archetypal FX / crypto structured product —
the "BTC stays between \$90k and \$120k" range bet. This adds them with a **closed-form analytic price
and a Monte-Carlo engine that converges to it**, matching the existing exotics idiom.

## The double-barrier survival probability

Everything reduces to `P_stay` — the risk-neutral probability that `S_t ∈ (L, U)` for all `t ∈ [0, T]`.
In log-space (`a = ln(L/S) < 0 < b = ln(U/S)`, drift `ν = r − q − σ²/2`, corridor `d = b − a`) the
**method of images** gives an infinite series of source/sink reflections:

```
P_stay = Σ_{n=−∞}^{∞} [ term(2n·d) − term(2b + 2n·d) ]
term(c) = exp(ν·c/σ²) · [ N((b − c − νT)/(σ√T)) − N((a − c − νT)/(σ√T)) ]
```

The `n = 0` source term is the no-barrier corridor probability; the images enforce absorption at both
`L` and `U`. The series **converges geometrically** — for realistic corridors `|n| ≤ 2` already pins it
to 1e-8, and the implementation sums `|n| ≤ 25`. _Verified against a 1M-path Monte-Carlo (Brownian-bridge
survival at both barriers): `P_stay` matches to ~3e-4 across symmetric and asymmetric corridors; the
series is stable to the truncation width._

## DNT, DOT, and the parity

Both settle **at expiry** (this milestone):

```
DNT = cash · e^{−rT} · P_stay
DOT = cash · e^{−rT} · (1 − P_stay)
```

so **`DNT + DOT = cash · e^{−rT}`** exactly — one pays if and only if the other does not. This parity is a
test anchor. An **already-breached** spot (`S ≤ L` or `S ≥ U`) short-circuits: the corridor is already
left, so `DNT = 0` and `DOT = cash · e^{−rT}`.

## Monte-Carlo

Simulate GBM paths; the corridor survival per path is the **product of the two single-barrier
Brownian-bridge survivals** (`barrierSurvival` at `L` down × at `U` up), so discrete monitoring converges
to the continuous analytic. `DNT` discounts `cash · survival`; `DOT` discounts `cash · (1 − survival)`.
Converges to the closed form — the corroboration every exotic here carries.

## Honesty / envelope contract

- **Analytic ⇄ MC corroboration** — the image-series closed form has a Monte-Carlo engine that converges
  to it; the `engine`/`method` name the pricing route.
- **The parity is exact** — `DNT + DOT = cash·e^{−rT}` (tested), and an already-breached corridor
  short-circuits rather than mis-evaluating the series at a degenerate point.
- **Value envelope (R2)** — `ExoticResult` (`Computed<number>` with `assumptions` + `diagnostics`); the MC
  variant adds `mc`, exactly like the other exotics.
- **First-touch guards** — non-object input; non-positive `spot`/`vol`/`t`/`cash`; a corridor that is not
  `0 < L < U` — all throw a typed `QuantError`; never a `NaN`.

## API

```ts
export type DoubleTouchKind = 'double-no-touch' | 'double-one-touch';

interface DoubleTouchInput {
  spot: number;
  /** Lower barrier `L` (> 0). */
  lower: number;
  /** Upper barrier `U` (> L). */
  upper: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Payout on the winning outcome; default 1. */
  cash?: number;
}

const doubleTouch: {
  price(kind: DoubleTouchKind, input: DoubleTouchInput): ExoticResult; // image-series analytic
  monteCarloPrice(
    kind: DoubleTouchKind,
    input: DoubleTouchInput,
    options: TouchMonteCarloOptions,
  ): ExoticMonteCarloResult;
};
```

## Build checklist

1. **Survival** — the image-series `P_stay` (sum `|n| ≤ 25`), clamped to `[0, 1]`.
2. **Analytic** — `doubleTouch.price`: the already-breached short-circuit, then
   `cash·e^{−rT}·P_stay` (DNT) / `cash·e^{−rT}·(1 − P_stay)` (DOT).
3. **Monte-Carlo** — `doubleTouch.monteCarloPrice`: GBM paths, `barrierSurvival(L,down)·barrierSurvival(U,up)`,
   discount the DNT/DOT payoff; reuse `monteCarloEstimate`.
4. **Envelope + exports + API report + READMEs/llms** (+ deep-sweep fixtures for the two new callables,
   mirroring `touch`).
5. **Tests** — the analytic matches the Monte-Carlo (both kinds) within the MC error; the
   `DNT + DOT = cash·e^{−rT}` parity; DNT falls / DOT rises as the corridor tightens (monotone); an
   already-breached spot short-circuits; guards.

## Deferred (explicitly)

- **Pay-at-hit settlement** for the DOT (discount the rebate at the first barrier crossing) — the
  double-barrier first-passage analytic (Kunitomo–Ikeda) is materially harder than the single-barrier
  Reiner–Rubinstein; expiry settlement is shipped, pay-at-hit is MC-only follow-up.
- **Rebate at each barrier** (a different payout for the upper vs lower touch) and **partial-window /
  window-barrier** variants.
- **Greeks** for the double-barrier binaries.
