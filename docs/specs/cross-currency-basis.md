# Spec — Cross-currency basis (`@totalfinance/fixed-income`)

## Goal

Post-2008, a foreign cash flow collateralized in the domestic currency is discounted on a
**basis-adjusted foreign curve**, not the foreign currency's own OIS — the gap is the cross-currency
basis, and it is what makes covered interest parity (CIP) "fail". This completes the multi-curve story
(OIS → dual-curve projection → cross-currency) with the two directions traders need: build the
collateralized curve + FX forwards from a basis, and imply the basis from market FX forwards.

FX convention throughout: **domestic units per 1 foreign unit** (e.g. USD per EUR, domestic = USD).

## The relationships

- **Covered interest parity (no basis):** `F(0,t) = spot · D_for(t) / D_dom(t)`.
- **Domestic-collateralized foreign discount curve:** the foreign OIS curve plus the basis term
  structure — continuous zeros add, `D_for^dom = foreign.addSpread(basis)` (reusing the curve method).
  The market FX forward is then `F(0,t) = spot · D_for^dom(t) / D_dom(t)`.
- **Inverse:** from an observed `F(0,t)`, the collateralized foreign discount factor is
  `D_for^dom(t) = F(0,t)·D_dom(t)/spot`, and the implied basis is its continuous zero minus the foreign
  curve's own zero.

All pure curve arithmetic — no FX data feed; the curves come from `curves.bootstrapMultiCurve`.

## API (`@totalfinance/fixed-income`, subpath `./cross-currency`)

```ts
// The collateralized foreign discount curve + its FX forwards, from a (optional) basis term structure.
crossCurrencyBasisCurve(input: {
  spot: number;          // domestic per foreign
  domestic: YieldCurve;  // domestic collateral (OIS) discount curve
  foreign: YieldCurve;   // foreign index/OIS discount curve (pre-basis)
  basis?: YieldCurve;    // xccy basis term structure (zeros ARE the spreads); omit for pure CIP
}): {
  collateralizedCurve: YieldCurve;    // foreign + basis — discount foreign cash flows on THIS
  fxForward(at: string | number): number;
  assumptions; diagnostics;
};

// Invert market FX forwards to the implied basis (the inverse of the above).
impliedCrossCurrencyBasis(input: {
  spot: number; domestic: YieldCurve; foreign: YieldCurve;
  forwards: [string, number][];       // [date, forward] (domestic per foreign)
}): { basis: { date: string; spread: number }[]; assumptions; diagnostics };
```

## Honesty / envelope contract

- Both are analysis-role reports (assumptions + diagnostics). Builders reject a raw (non-curve) input,
  a curve whose reference date disagrees with the domestic curve, a non-positive spot/forward, and
  unknown option keys (Law 12) — typed `QuantError`s, never a raw `TypeError` or a silent NaN.

## Build checklist

- [x] `crossCurrencyBasisCurve` — collateralized curve (`foreign.addSpread(basis)`) + CIP FX forwards;
      `basis` optional (pure-CIP default).
- [x] `impliedCrossCurrencyBasis` — invert market forwards to the basis term structure.
- [x] `./cross-currency` subpath (package.json + vitest alias); manifest classification; first-touch
      fixtures; tests.

## Verified

Collateralized curve reproduces the foreign curve with no basis (1e-12); `D_for^dom(t)=F(t)·D_dom(t)/spot`
consistency (1e-12); a positive basis lowers the domestic-per-foreign forward; a known flat/non-flat
basis is recovered pointwise by `impliedCrossCurrencyBasis` to machine precision (~1e-17).

## Deferred (explicitly)

- Bootstrapping the basis from mark-to-market (notional-resetting) cross-currency basis SWAP par quotes
  (this ships the FX-forward-implied construction, which is the market-standard input).
- Triangulation across three currencies and a quanto/composite FX adjustment.
