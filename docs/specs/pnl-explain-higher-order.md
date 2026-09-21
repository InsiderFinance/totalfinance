# Spec — Higher-order P&L explain: the complete 2nd-order Taylor + dividend carry (`@totalfinance/risk`)

> Roadmap Tier 1.3 → P&L explain follow-up: "higher-order terms to shrink the residual on demand".
> Amended 2026-09-18 (pre-publish interface repairs, A2 — one Greek unit system): `PositionGreeks` is
> the DISPLAY-unit shape the options package reports (theta per calendar day, vega per volatility
> point, rho and `phi` per 1%, the second-order Greeks in the options package's units); the Taylor
> kernel converts internally, so there is no raw adapter (`rawGreeksFromDisplay` is deleted) and the
> dividend-carry Greek is `phi`, not a rescaled `epsilon`. The terms, signs and invariants below are
> unchanged; the unit statements are updated in place.
> Status: **shipped in two waves.** Wave 1 added the spot-driven crosses **vanna / vomma / charm**. Wave 2
> **completes the second-order Taylor** in (spot, vol, time, rate) — **veta, vera, deltaRate, thetaRate,
> rhoConvexity, thetaConvexity** — plus a first-order **dividend-carry** term **ε·dq**. All are optional
> terms on `taylorPnl` / `explainPnl` in `packages/risk/src/scenario.ts` +
> `packages/risk/src/pnl-explain.ts`, covered by `packages/risk/test/pnl-explain.test.ts` +
> `packages/risk/test/scenario.test.ts`, full CI green. Wave 2 also **wires the extended greeks into
> `Position.value()`** (`@totalfinance/strategy`): each option leg now reports the full `ExtendedGreeks` (and the
> book aggregate too), so `explainPositionPnl` attributes `vanna/vomma/charm/veta/vera/ε` on the auto path
> with no hand-supplied greek set — covered by `packages/strategy/test/strategy.test.ts` +
> `packages/risk/test/pnl-explain.test.ts`.

## Goal

P&L explain decomposes a realized move into greek terms plus an **unexplained residual**. Wave 1 promoted
the spot-driven second-order crosses (**vanna** spot–vol, **vomma** vol convexity, **charm** spot–time) out
of the residual. Wave 2 promotes **every remaining second-order term** — the vol–time cross (**veta**), the
rate crosses (**vera** vol–rate, **deltaRate** spot–rate, **thetaRate** time–rate), and the rate/time
convexities (**rhoConvexity**, **thetaConvexity**) — plus a first-order **dividend-carry** term (**ε = ∂V/∂q**).
The attribution is now **complete to second order in (spot, vol, time, rate)**: a book with real cross-gamma,
rate convexity, or dividend exposure gets an honest, itemized attribution instead of a lumped residual.

The second-order Taylor terms (calendar-time convention, matching `theta`'s `timeStepYears`):

```
# Wave 1 (spot-driven)
vanna term = (∂²V/∂S∂σ) · dS · dσ
vomma term = ½ (∂²V/∂σ²) · dσ²
charm term = (∂²V/∂S∂t) · dS · timeStepYears          (∂²V/∂S∂t = −∂Δ/∂T; see the sign note)
# Wave 2 (the rest of the 2nd order + carry)
veta  term = (∂²V/∂σ∂t) · dσ · timeStepYears          (∂²V/∂σ∂t = −∂vega/∂T; same sign note as charm)
vera  term = (∂²V/∂σ∂r) · dσ · dr
deltaRate  = (∂²V/∂S∂r) · dS · dr
thetaRate  = (∂²V/∂t∂r) · timeStepYears · dr
rhoConvexity   = ½ (∂²V/∂r²) · dr²
thetaConvexity = ½ (∂²V/∂t²) · timeStepYears²
phi term       = (∂V/∂q) · dq              (first-order dividend carry)
```

With the full set attributed, `unexplained` contains only **3rd-order-and-higher** (spot cubic/`speed`,
`ultima`, …), any second-order greek the caller did not supply (see below), the out-of-scope 2nd-order
**dividend** crosses (`∂²V/∂S∂q`, `∂²V/∂q²`, …; only the first-order `ε` is in scope), and any model/data
effects.

## An honest framing (not "the residual always shrinks")

The follow-up says "shrink the residual", but that is only true **as the move → 0**. For a _finite_ move the
3rd-order term can be large and even _opposite_ in sign to the 2nd-order cross terms, so a first-order+gamma
explanation can be closer _by luck of cancellation_ than a 2nd-order one. What the terms guarantee is the
**exact second-order attribution**: they equal the price's mixed partials times the moves, so the residual
becomes genuinely `O(move³)`. That is what the tests pin — an **exact match to a finite-difference 2nd-order
Taylor** and **cubic convergence** of the residual (÷≈8 per halving of the move), not a blanket "smaller
number".

_Verified before implementation (Wave 1): the analytic vanna/vomma/charm terms reproduce the full FD
2nd-order Taylor of the BSM price to ~1e-8; each greek matches its mixed finite difference to ~1e-6; and the
2nd-order residual falls ~7.8×/7.9× per halving of the move (cubic), confirming `O(move³)`._

_Verified before implementation (Wave 2): with the **full** second-order greek vector supplied (analytic
where `ExtendedGreeks` carries it — through veta/vera — and finite-difference for the four rate/time
crosses), a move in **all** of (spot, vol, time, rate) leaves an `O(move³)` residual — it falls ~8×/halving,
versus ~4×/halving (quadratic) with first-order+gamma only. Each new term equals its price mixed-partial
times the moves; `ε` matches `∂V/∂q` and is supplied as `ExtendedGreeks.phi` (per 1%), which the kernel
rescales internally._

## The calendar-time sign (the one subtlety — now shared by charm AND veta)

`theta` in this engine is the **calendar-time** decay `∂V/∂t` (bsm reports it per day; the Taylor kernel
scales ×365 internally), and `timeStepYears` in a `PnlMove` is elapsed calendar years (`> 0`). For consistency, every time-cross is
the calendar-time partial. The standard analytic **charm is `∂Δ/∂T`** and **veta is `∂vega/∂T`** (both per year
of _time-to-expiry_), and `T` decreases as calendar time passes, so `∂²V/∂S∂t = −∂Δ/∂T` and `∂²V/∂σ∂t =
−∂vega/∂T`. The Taylor kernel therefore **negates** the `ExtendedGreeks.charm` and `ExtendedGreeks.veta`
it receives; `thetaRate` (`∂²V/∂t∂r`) and `thetaConvexity` (`∂²V/∂t²`) carry the same calendar convention on
the field (a caller hand-building `PositionGreeks` supplies it in the documented display units). `vera`
(`∂²V/∂σ∂r`, no time axis) and the dividend `phi` (`∂V/∂q`, per 1% dividend yield) pass through un-flipped;
the kernel applies the per-1% and per-day scalings itself.

## API (additive, backward-compatible)

`PositionGreeks` (scenario.ts) gains the optional second-order greeks in the options package's display units
(plus the first-order dividend `phi`); `PnlAttribution` and `PnlExplain` gain the matching named terms. A new `shock.dividend(change)`
constructor and a `'dividend'` shock factor feed the `ε·dq` term through the scenario engine (parity with
`shock.rate` / `shock.vol`).

```ts
interface PositionGreeks {
  // …value, spot, delta, gamma, vega (per volatility point), theta (per calendar day), rho (per 1%)…
  vanna?: number; // ∂²V/∂S∂σ per 1.00 σ per $ — the options package's vanna
  vomma?: number; // ∂²V/∂σ² per 1.00 σ² — the options package's vomma
  charm?: number; // ∂Δ/∂T per year of time-to-expiry — the options package's charm
  veta?: number; // ∂vega/∂T per year, vega per 1.00 σ — the options package's veta
  vera?: number; // ∂²V/∂σ∂r per 1.00 σ per 1.00 rate — the options package's vera
  deltaRate?: number; // ∂²V/∂S∂r per $ per 1% rate
  thetaRate?: number; // ∂²V/∂t∂r per calendar day per 1% rate
  rhoConvexity?: number; // ∂²V/∂r² per (1%)²
  thetaConvexity?: number; // ∂²V/∂t² per calendar day²
  phi?: number; // ∂V/∂q per 1% dividend yield — the options package's phi (first-order carry)
}
// PnlAttribution and PnlExplain gain the same-named terms (veta, vera, deltaRate, thetaRate,
// rhoConvexity, thetaConvexity, phi).
```

`taylorPnl` adds every term above to `total`; with a greek absent its term is 0, so **every existing caller is
unchanged** and the summing invariant `Σ(greek terms) + unexplained === total` stays bit-exact.

A whole `ExtendedGreeks` spreads straight into `PositionGreeks` (`{ value, spot, ...greeks }`): the kernel
auto-attributes the three greeks it carries analytically — `veta` and `charm` (converted from the options
package's ∂/∂T-per-year convention to the calendar-time sign inside `taylorPnl`), `vera` (pass-through) and
`phi` (per 1%, scaled inside the kernel). The four remaining crosses (`deltaRate`/`thetaRate`/`rhoConvexity`/
`thetaConvexity`) are **not** on `ExtendedGreeks` — the general primitive `explainPnl` attributes them when a
caller supplies them in the documented display units (e.g. a rates model or a finite-difference greek set);
otherwise they fall into the residual. When `g` is a first-order `Greeks`, all higher-order fields are omitted
and the attribution is unchanged.

## Honesty / envelope contract

- **Backward-compatible** — optional greeks default to 0; the summing invariant is preserved exactly; no
  existing caller of `taylorPnl`/`explainPnl`/`explainPositionPnl` changes.
- **The residual stays load-bearing** — it now means "3rd-order-and-higher + any 2nd-order greek the caller
  didn't supply (the four non-analytic rate/time crosses on the auto path) + out-of-scope 2nd-order dividend
  crosses + model/data", documented so it is not read as "everything is explained".
- **Units + sign disclosed** — every Greek is in the options package's display units (one unit system
  library-wide); the two calendar sign flips (`charm`, `veta`) and the per-1% / per-day scalings live in one
  place (the Taylor kernel) and are documented on the fields; every report echoes `greekUnits`.
- **Envelope** — no shape change beyond the additive term fields and the new `shock.dividend` constructor.

## Build checklist

- [x] `PositionGreeks` += the second-order greeks + `phi` (display units since 2026-09-18; the field was
      `epsilon` in raw units before A2); `PnlAttribution`/`PnlExplain` += the named
      terms; `taylorPnl` computes each term and folds it into `total`; a `'dividend'` factor + `shock.dividend`
      feed `ε·dq`.
- [x] `explainPnl`/`zero()`/position+portfolio aggregates carry every new term; `PnlMove` += `dDividendYield`;
      `moveBetween` derives a dividend move between two markets.
- [x] The kernel auto-sources `veta` (sign-converted), `vera` and `phi` from a spread `ExtendedGreeks`; omits
      the four non-analytic crosses and all fields for a first-order `Greeks`. (The `rawGreeksFromDisplay`
      adapter this item first shipped with was deleted on 2026-09-18 by A2.)
- [x] Tests: full-2nd-order cubic convergence for an all-factor move (vs quadratic for first-order+gamma),
      per-term mixed-FD, the wiring sign/scale FD check, the dividend-carry FD check, the summing invariant,
      backward-compat, and the position/portfolio roll-up.
- [x] **`Position.value()` emits `ExtendedGreeks`** (`@totalfinance/strategy`) — every option leg reports the full
      extended greeks (scaled by position size; `lambda` unscaled), the book aggregate sums the additive fields
      and recomputes elasticity `Λ = Δ·S/V`, and `explainPositionPnl` now attributes the higher-order terms
      (vanna, vomma, charm, veta, vera, ε) on the auto path (previously first-order only).
      `LegValuation.greeks`/`MarkToMarketResult.greeks` widen `Greeks → ExtendedGreeks` (a superset — first-order
      consumers are unchanged).

## Deferred (explicitly)

- **Analytic `deltaRate`/`thetaRate`/`rhoConvexity`/`thetaConvexity` on `ExtendedGreeks`** — the four
  rate/time crosses are attributed when a caller supplies them, but are not emitted by the BSM greek engine
  (adding them cascades across every model — black76, the normal-model bachelier, the FD/exotics engines, the
  cross-probe — for marginal equity-P&L terms). Revisit if a rates-desk consumer needs them auto-emitted.
- **The 2nd-order dividend crosses** (`∂²V/∂S∂q`, `∂²V/∂σ∂q`, `∂²V/∂q²`, …) — only the first-order carry `ε`
  is in scope; the dividend convexity/crosses stay in the residual.
