# Spec — Earnings / event-vol modeling (`@totalfinance/volatility`)

> Roadmap Tier 2 → "Options & vol": _"Earnings modeling: event-vol extraction fitted across the term
> structure, straddle-implied move vs realized-move calibration."_ The term-structure layer over the
> single-tenor event-vol kernels (`eventVolatilityDecomposition`, `eventStrippedVolatility`) that already exist. Status:
> **shipped** as `calibrateEventVolatility` + `calibrateEventMove` in `packages/volatility/src/earnings.ts`, covered by
> `packages/volatility/test/earnings.test.ts`, full CI green.

## Goal

Two questions every options trader asks around earnings:

1. **"How big a move is the market pricing for this earnings?"** — extract the discrete **event jump**
   (the implied earnings move) and the underlying **continuous vol** from the whole ATM term structure,
   not just a hand-supplied base vol. `calibrateEventVolatility`.
2. **"Is this name's earnings straddle historically over- or under-priced?"** — calibrate the
   straddle-**implied** move against the subsequently-**realized** move across past events.
   `calibrateEventMove`.

## Why this is a composition, not a re-implementation

The single-tenor kernels exist but need the base vol handed to them:

- `eventVolatilityDecomposition({ atmVolatility, t, baseVolatility })` (event.ts) — splits one event-spanning ATM vol into
  continuous + event variance **given** `baseVolatility`.
- `eventStrippedVolatility({ atmVolatility, t, eventMove })` (event.ts) — strips a **known** event jump.
- `expectedMoveFromImpliedVolatility` / `expectedMoveFromStraddle` (event.ts) — the 1-σ / straddle move.
- `varianceRiskPremium` / `realizedImpliedSpread` (event.ts) — the premium kernels.

`calibrateEventVolatility` supplies what's missing: it **fits** `σ_base` and the jump `J` from the term structure by
regression, so the base vol is discovered from the data, not assumed. `calibrateEventMove` is the
historical honesty layer the roadmap names — pure calibration statistics over past events.

## The model (additive event variance)

An earnings event at time `τ` (years from `asOf`) contributes a **fixed** variance `J²` to any option
that expires on/after it; the rest of the variance accrues continuously at `σ_base`. So an expiry at
time `Tᵢ` with ATM vol `σᵢ` has total variance

```
Vᵢ = σᵢ²·Tᵢ = σ_base²·Tᵢ + J²·[Tᵢ spans the event]
```

This is **linear** in the two unknowns `(σ_base², J²)` with a known 0/1 indicator, so a least-squares
fit of `V` on `[T, spans]` recovers the base-variance **slope** `σ_base²` and the event-variance
**intercept** `J²`. `J` is the implied earnings move as a fraction of spot (`spot·J` in price units).

- Pre-event expiries (`Tᵢ < τ`) pin `σ_base` (no intercept); post-event expiries (`Tᵢ ≥ τ`) carry the
  jump. A mix identifies both directly; ≥ 2 post-event expiries with different `T` also identify both
  (the classic V-vs-T regression with an intercept).
- **Underdetermined** (one expiry, or no `T`-variation among the spanning expiries): the fit can't
  separate `σ_base` from `J`. If the caller supplies `baseVolatility`, pin it and solve `J` per
  `eventVolatilityDecomposition`; otherwise throw a teaching error asking for ≥ 2 expiries or a `baseVolatility`.
- **Negative fit** (`σ_base² < 0` or `J² < 0` — vol _falls_ through the event, i.e. no positive event
  premium): clamp to 0 and **disclose** a warning; never report a fabricated positive move.

## API

```ts
interface AtmVolatilityPoint {
  expiry: string; // ISO date → t computed from asOf (ACT/365F)
  atmVolatility: number; // annualized ATM implied vol (decimal)
}
interface FitEventVolatilityOptions {
  termStructure: AtmVolatilityPoint[]; // ≥ 1 expiry (≥ 2 to fit both, unless baseVolatility given)
  eventDate: string; // ISO date of the earnings/event
  asOf: EpochMs | string;
  baseVolatility?: number; // pin the continuous vol when the term structure can't identify it
}
interface FittedExpiry {
  expiry: string;
  daysToExpiry: number;
  timeToExpiryYears: number;
  atmVolatility: number;
  spansEvent: boolean;
  fittedVolatility: number; // the model's ATM vol at this expiry
  residual: number; // atmVolatility − fittedVolatility
}
interface EventVolatilityCalibration {
  /** Annualized continuous (non-event) vol √σ_base². */
  baseVolatility: number;
  /** Implied event move as a fraction of spot (J) — the "earnings move". */
  eventMove: number;
  /** J² — the discrete event variance. */
  eventVariance: number;
  daysToEvent: number;
  perExpiry: FittedExpiry[];
  /** Fit quality on total variance (1 = perfect). */
  rSquared: number;
  assumptions: { conventionsVersion: string; method: string; eventDate: string };
  diagnostics: Diagnostics;
}
function calibrateEventVolatility(options: FitEventVolatilityOptions): EventVolatilityCalibration;

interface EventMoveObservation {
  impliedMove: number; // straddle-implied move BEFORE the event (fraction of spot), > 0
  realizedMove: number; // realized |move| AFTER the event (fraction of spot), ≥ 0
  date?: string; // optional label
}
interface CalibratedEvent extends EventMoveObservation {
  error: number; // realizedMove − impliedMove
  overpriced: boolean; // impliedMove > realizedMove (straddle seller won)
}
interface EventMoveCalibration {
  count: number;
  averageImplied: number;
  averageRealized: number;
  /** averageRealized / averageImplied — > 1 ⇒ the stock moves MORE than the straddle prices. */
  ratio: number;
  /** Fraction of events where implied > realized (how often selling the straddle won). */
  overpricedFraction: number;
  /** Mean (realized − implied) — positive ⇒ straddles underpriced on average. */
  bias: number;
  /** Mean |realized − implied|. */
  meanAbsoluteError: number;
  perEvent: CalibratedEvent[];
  assumptions: { conventionsVersion: string; method: string };
  diagnostics: Diagnostics;
}
function calibrateEventMove(observations: readonly EventMoveObservation[]): EventMoveCalibration;
```

## Honesty / envelope contract

- **No fabricated event premium** — a term structure with no positive event excess yields `eventMove: 0`
  with a disclosed warning, not a made-up jump; an underdetermined fit throws (or uses the supplied
  `baseVolatility`), never guesses.
- **Fit quality disclosed** — `rSquared` and per-expiry residuals are first-class, so a poor
  single-event fit (a second event in the window, a vol regime shift) is visible.
- **Risk-neutral** implied moves vs **realized** outcomes are labeled distinctly; the calibration is a
  historical statistic, not a forecast.
- Typed guards on every entry (garbage opts, `eventDate`/`asOf`, `atmVolatility > 0`, empty history, a
  `realizedMove < 0`); pure and deterministic (`asOf`/dates explicit, no clock).

## Build checklist

1. **Types** — the interfaces above.
2. **`calibrateEventVolatility`** — compute `t`/`spans` per expiry; assemble `V = σ²·T`; 2×2 OLS of `V` on
   `[T, spans]`; identifiability guard + optional `baseVolatility` pin; clamp-with-disclosure; `rSquared` +
   per-expiry fitted/residual.
3. **`calibrateEventMove`** — per-event error/overpriced; aggregate ratio / overpriced-fraction / bias /
   MAE; guards.
4. **Exports + API report + READMEs/llms** — vol index.
5. **Tests** — a synthetic term structure with a known `(σ_base, J)` is recovered by the fit; a
   pre+post mix and an all-post-event set both identify; an underdetermined single expiry throws (and is
   solved with `baseVolatility`); a vol-falls-through-event term structure yields `eventMove 0` + warning;
   calibration ratio/overpriced/bias on hand-built histories; envelope/guards.

## Deferred (explicitly)

- **Multiple events** in one window (two earnings, or earnings + a macro print) — v1 fits a single jump;
  a multi-indicator regression is the generalization.
- **Straddle → implied move directly from a chain** (pick the ATM straddle per expiry, back out the
  move) so `calibrateEventVolatility` can take a raw chain instead of an ATM term structure — pairs with
  `atmTermStructure` and the variance-index strip selection.
- **Weighting / robust regression** (down-weight far-dated or illiquid expiries); v1 is unweighted OLS.
