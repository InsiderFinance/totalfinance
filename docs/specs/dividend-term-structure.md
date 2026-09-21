# Spec — Dividend term structures (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"Dividend term structures (discrete schedule + yield curve,
> unified)."_ Status: **shipped** as `dividendTermStructure` in
> `packages/options/src/dividend-term-structure.ts`, covered by
> `packages/options/test/dividend-term-structure.test.ts`, full CI green.

## Goal

Every option desk carries dividends two incompatible ways at once: a **discrete cash schedule** (the
ex-dates and per-share amounts a name actually pays) and a **continuous yield** `q` (the single number
a Black–Scholes engine wants). This tool **unifies** them into one per-maturity term structure so a
trader can answer, for any expiry `T`:

- what is the **dividend-adjusted forward** `F(T)`?
- what is the **present value** of the dividends that accrue before `T`?
- what **single continuous yield** `q_eff(T)` reproduces that forward — so I can price _this_ expiry with
  one number instead of the whole schedule?

The last question is the point. `q_eff(T)` is the escrowed schedule collapsed to the one continuous yield
that a vanilla BSM/Greeks call consumes, **exactly** — so the whole discrete-vs-continuous mismatch
disappears at the pricing boundary.

This is the _forward_ direction of the same relationship `parity.impliedDividendYield` inverts:
parity **recovers** `q_eff` from observed call/put prices; this **predicts** `F(T)`, PV, and `q_eff(T)`
from a known schedule. The two reconcile on the same escrowed-dividend model.

## Model (escrowed dividends — the package-wide convention)

Cash dividends `Dᵢ` with ex-dates `τᵢ` years from `asOf` (ACT/365F). For a maturity `T` years out, the
**present value of the dividends that accrue strictly before expiry** — matching `escrowedSpot`'s
`0 < τᵢ < T` rule exactly, so this tool and the pricing engines never disagree:

```
PV_div(T) = Σ_{0 < τᵢ < T}  Dᵢ · e^{−r·τᵢ}
```

The **escrowed forward**: the dividends are set aside (escrowed) out of the spot, and the remainder
grows at the net cost-of-carry `r − q` (continuous yield `q` applied alongside):

```
F(T) = (S − PV_div(T)) · e^{(r − q)·T}
```

The **continuous-equivalent dividend yield** `q_eff(T)` is the single `q'` for which
`F(T) = S · e^{(r − q')·T}`. Solving:

```
q_eff(T) = q − (1/T)·ln(1 − PV_div(T)/S)          [total effective yield: continuous + discrete]
         = q + discreteEquivalentYield(T)
discreteEquivalentYield(T) = −(1/T)·ln(1 − PV_div(T)/S)   [the discrete schedule alone, as a yield]
carry(T)  = r − q_eff(T)                            [the rate the forward grows at: F = S·e^{carry·T}]
```

**The exactness guarantee.** BSM depends on `(S, r, q, σ)` only through the forward
`F = S·e^{(r−q)T}` — because `S·e^{−qT} = e^{−rT}·F` and `d₁ = (ln(F/K) + σ²T/2)/(σ√T)`. So pricing an
expiry-`T` option with `(S, r, q_eff(T), σ)` returns **exactly** the escrowed-spot price
`(S − PV_div(T), r, q, σ)` — same forward, same price, to machine precision. `q_eff(T)` is therefore a
_lossless_ collapse of the schedule at each expiry, not an approximation. _(Verified: escrowed-spot BSM
vs `q_eff` BSM match to 1e-10 for both call and put, `S=100, r=5%, q=1%, σ=25%`, two $1.50 dividends.)_

**A note on shape.** `q_eff(T)` is _not_ monotone in `T`. As each ex-date passes it steps up (more cash
accrued); between ex-dates and past the last one it **decays like `1/T`** (the same fixed cash spread as
an annualized yield over a longer horizonPeriods is a smaller yield). A `3.97%` one-year yield becoming `2.49%`
at two years is correct, not a bug. The tool reports points **sorted ascending by tenor** so this term
structure reads left to right.

## Honesty / envelope contract

- **One escrowed model, shared** — identical `0 < τᵢ < T` rule and amount validation as `escrowedSpot`,
  so `q_eff(T)` provably round-trips through the pricing engines.
- **Disclosure, not silence** — ex-dates on/before `asOf` are dropped (already paid) and reported via a
  `options.dividends_past` warning with the count; an empty/zero schedule reports
  `options.dividends_none` (the forwards are pure cost-of-carry `S·e^{(r−q)T}`).
- **First-touch guards** — non-object input, `spot ≤ 0`, non-finite `rate`/`dividendYield`, a non-finite
  or negative dividend amount, a maturity at/before `asOf` (`T ≤ 0`), and — matching `escrowedSpot` — a
  dividend PV that reaches or exceeds the spot (the escrowed spot would be non-positive) all throw a
  typed `QuantError`, never a `NaN`.
- **Domain-object envelope (R2)** — a `DividendTermStructure` with `points`, summary fields, `assumptions`
  (spot/rate/continuousYield/conventionsVersion/dividendModel), and `diagnostics`.

## API

```ts
interface DividendTermStructureInput {
  spot: number;
  /** Continuously-compounded risk-free rate (decimal). */
  riskFreeRate: number;
  /** Continuous dividend yield applied alongside the discrete schedule (decimal); default 0. */
  dividendYield?: number;
  /** Discrete cash dividends (ISO ex-date + per-share amount). Omitted / empty ⇒ continuous-only. */
  dividends?: DiscreteDividend[];
  /** Valuation date; ex-dates and maturities are measured from here (ISO or epoch ms). Required —
   *  the package never defaults to wall-clock `now`, so a term structure is always reproducible. */
  asOf: EpochMs | string;
  /** The expiries (ISO dates) to report the term structure at. At least one, each after `asOf`. */
  maturities: string[];
}

interface DividendTermStructurePoint {
  /** The maturity (ISO), echoed. */
  maturity: string;
  /** Year fraction from `asOf` (ACT/365F). */
  yearsToExpiry: number;
  /** PV of the discrete dividends accruing before this expiry. */
  dividendPresentValue: number;
  /** How many discrete dividends accrue before this expiry. */
  discreteCount: number;
  /** Dividend-adjusted (escrowed) forward `F(T)`. */
  forward: number;
  /** The discrete schedule expressed as a continuous yield: `−ln(1−PV/S)/T`. */
  discreteEquivalentYield: number;
  /** The single continuous yield that reproduces `F(T)`: `q + discreteEquivalentYield`. */
  impliedContinuousYield: number;
  /** Net cost-of-carry the forward grows at: `r − impliedContinuousYield`. */
  carry: number;
}

interface DividendTermStructure {
  points: DividendTermStructurePoint[]; // sorted ascending by tenor
  /** PV of every future dividend in the schedule (all `τᵢ > 0`), regardless of the maturities asked. */
  totalDividendPresentValue: number;
  /** The continuous yield echoed back (0 when none supplied). */
  continuousYield: number;
  /** One-line agent-relayable summary. */
  summary: string;
  assumptions: {
    conventionsVersion: string;
    spot: number;
    riskFreeRate: number;
    continuousYield: number;
    dividendModel: DividendModel;
  };
  diagnostics: Diagnostics;
}

function dividendTermStructure(input: DividendTermStructureInput): DividendTermStructure;
```

## Build checklist

1. **Core** — resolve `asOf`; validate spot/rate/yield and every dividend amount; convert ex-dates and
   maturities to year fractions; drop past ex-dates (warn); reject `T ≤ 0` maturities and `PV ≥ S`.
2. **Per-maturity** — `PV_div(T)`, `F(T)`, `discreteEquivalentYield`, `q_eff(T)`, `carry`, `discreteCount`;
   sort points ascending by tenor.
3. **Envelope** — `totalDividendPresentValue`, `continuousYield`, a `summary`, `assumptions`, `diagnostics` with the
   `dividends_past` / `dividends_none` warnings; export the function + types; API report + READMEs/llms.
   (Single-arg ⇒ covered by the first-touch **garbage sweep**; no deep-sweep fixture.)
4. **Tests** — the exactness guarantee (`q_eff(T)` BSM == escrowed-spot BSM, call & put); forward and PV
   match the hand-computed escrowed values; the term structure is sorted and decays `~1/T` past the last
   ex-date; a past ex-date is excluded (with the warning) while a future one accrues; a continuous-only
   input yields `q_eff = q` flat; guards (bad input, `spot ≤ 0`, non-finite rate, negative amount,
   `PV ≥ S`, `T ≤ 0`, empty maturities).

## Deferred (explicitly)

- **Non-flat rate curve** — a term structure of `r(T)` for both the PV discounting and the carry (this
  milestone takes one continuously-compounded scalar `r`, matching the rest of the pro API).
- **Proportional (yield-like) discrete dividends** and a **forward-implied** discrete schedule.
- **Dividend risk/greeks** — `∂price/∂D`, and the roll of `q_eff` as an ex-date passes.
- **Chain-implied reconciliation** — cross-checking `q_eff(T)` against `parity.impliedDividendYield` on a
  live chain in a single call (the pieces exist; wiring them together is follow-up).
