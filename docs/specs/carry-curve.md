# Spec — Crypto carry curve / futures term structure (`@totalfinance/crypto`)

> Roadmap Tier 2 → Crypto → "a funding term-structure / carry curve across expiries". The term-structure
> companion to the single-expiry [`futuresBasis`](./crypto-carry.md).
> Status: **shipped** as `carryCurve` in `packages/crypto/src/curve.ts`, covered by
> `packages/crypto/test/curve.test.ts`, full CI green.

## Goal

`futuresBasis` reads the carry off **one** dated future. A desk quotes the whole **curve** — every listed
expiry's implied carry, the **forward carry** the market prices between consecutive expiries (the crypto
analogue of a forward riskFreeRate: the funding it expects to earn holding from `tᵢ` to `tᵢ₊₁`), the curve's
**shape** (upward / downward / humped contango, or backwardation), and the carry at any **interpolated**
tenor. `carryCurve` turns a spot + a set of futures into that term structure, composing `futuresBasis` per
point so the per-expiry numbers are identical to the single-expiry tool.

Deterministic, browser-safe, `@totalfinance/core`-only (via `futuresBasis`).

## The construction

For a spot `S` (at `t = 0`) and futures `(tᵢ, Fᵢ)` sorted by expiry:

- **Per-expiry carry** — `futuresBasis({ spot: S, future: Fᵢ, t: tᵢ, … })` for each point: the annualized log
  carry `ln(Fᵢ/S)/tᵢ`, the contango/backwardation label, and (given `financingRate`) the cash-and-carry
  richness — reused verbatim, so a curve point equals the standalone `futuresBasis`.
- **Forward carry** — over each window `(tᵢ₋₁, tᵢ)` (with `t₀ = 0`, `F₀ = S`):

  ```
  forwardCarry(i) = ln(Fᵢ / Fᵢ₋₁) / (tᵢ − tᵢ₋₁)
  ```

  the market's marginal carry between two expiries. The first (`S → F₁`) equals point 1's annualized carry,
  so the forwards **tile** the curve. Under a constant-carry curve `F = S·e^{c·t}`, every forward equals `c`.

- **Shape** — classified from the forward-carry sequence: `flat` (range < `flatTolerance`), `upward`
  (non-decreasing), `downward` (non-increasing), `humped` (rises to an interior peak then falls), else
  `mixed`.
- **Interpolation** — for each requested `queryTenors` value, `ln F(t)` is **log-linearly** interpolated in
  `t` (flat-forward extrapolation beyond the ends), giving the implied forward price and its annualized
  carry. Exact on a constant-carry curve and it reproduces the nodes.

_Verified: a constant-carry curve gives all per-expiry and all forward carries equal to `c` and a flat
shape; a steepening contango classifies `upward` with rising forwards; backwardation gives negative carries;
interpolation reproduces the node prices exactly and is exact between nodes for constant carry._

## Honesty / envelope contract

- **Composes `futuresBasis`, no new math** — the per-point carry/structure/richness are the exact
  single-expiry numbers; disclosed as `model: 'carry'`, `engine: 'carry-curve'`.
- **Forward carries need adjacent expiries** — with a single future there are no forward windows beyond
  `S → F₁` and the shape is `flat` (undetermined slope), disclosed rather than guessed.
- **Interpolation is log-linear, extrapolation is flat-forward** — both disclosed; a queried tenor beyond
  the last expiry carries the last forward carry, never a fabricated curve shape.
- **First-touch guards** — non-object input; non-positive `spot`; an empty / non-array `futures`; a
  non-positive `t`/`price`; **duplicate or non-increasing expiries** (a zero-width forward); a non-positive
  `queryTenors` entry — all throw a typed `QuantError`. Single-object function ⇒ first-touch **garbage
  sweep** covers it.
- **Envelope (R2)** — a domain object with `points`, `forwards`, `shape`, optional `interpolated`,
  `assumptions`, `diagnostics`.

## API

```ts
interface CarryCurveInput {
  /** Spot / index price (t = 0). */
  spot: number;
  /** Dated futures on the same underlying — each a time-to-expiry (years) and price. */
  futures: { timeToExpiryYears: number; price: number }[];
  /** Quote financing rate — enables per-point cash-and-carry richness. */
  financingRate?: number;
  /** Coin (base) yield. Default 0. */
  coinYield?: number;
  /** Tenors (years) to interpolate the carry at. */
  queryTenors?: number[];
  /** |forward-carry| range below which the shape is 'flat'. Default 5e-4 (5 bp). */
  flatTolerance?: number;
}
interface CarryCurvePoint {
  timeToExpiryYears: number;
  price: number;
  /** ln(price/spot)/t — the continuously-compounded implied carry. */
  annualizedCarry: number;
  structure: 'contango' | 'backwardation' | 'flat';
  /** price − spot·e^{(r−q)t} — present only when financingRate is supplied. */
  richness?: number;
}
interface CarryForward {
  fromTenorYears: number;
  toTenorYears: number;
  /** ln(F_to/F_from)/(toT − fromT); the first window is spot(t=0) → F₁. */
  forwardCarry: number;
}
interface CarryInterp {
  timeToExpiryYears: number;
  impliedForward: number;
  annualizedCarry: number;
}
interface CarryCurve {
  spot: number;
  points: CarryCurvePoint[];
  forwards: CarryForward[];
  shape: 'upward' | 'downward' | 'humped' | 'flat' | 'mixed';
  interpolated?: CarryInterp[];
  assumptions: Assumptions;
  diagnostics: Diagnostics;
}
function carryCurve(input: CarryCurveInput): CarryCurve;
```

## Build checklist

1. **Validate & sort** — guard spot/futures/tenors; sort points by `t`; reject non-increasing expiries.
2. **Points** — `futuresBasis` per expiry → `annualizedCarry`/`structure`/`richness`.
3. **Forwards** — `ln(Fᵢ/Fᵢ₋₁)/(tᵢ − tᵢ₋₁)` with `t₀ = 0`, `F₀ = spot`.
4. **Shape** — classify the forward-carry sequence.
5. **Interpolation** — log-linear `ln F(t)`, flat-forward extrapolation, for each `queryTenors`.
6. **Envelope + export + API report + READMEs/llms.**
7. **Tests** — constant-carry flatness (points, forwards, interp); contango `upward`; backwardation;
   node reproduction; richness with financing; guards.

## Deferred (explicitly)

- **Perp-anchored curves** — splicing a perpetual's funding-implied carry into the front of the dated curve
  (pairs with `perpetualFunding`/`fundingBasisSpread`).
- **A monotone/curvature-preserving interpolation** (the current one is log-linear) and a no-arbitrage
  (monotone forward) check.
- **A realized-vs-implied forward-carry backtest** once the data layer lands.
