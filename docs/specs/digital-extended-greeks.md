# Spec — Higher-order binary (digital) greeks (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → the `digital-greeks` follow-up: "higher-order binary greeks
> (vanna/charm/vomma)".
> Status: **shipped** as `digital.extendedGreeks` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/digital-greeks.test.ts`, full CI green.

## Goal

`digital.greeks` gives the five first-order greeks (delta, gamma, vega, theta, rho) of a European binary in
closed form. The follow-up asked for the higher-order ones — and since we now have the full vanilla
`ExtendedGreeks` set, the natural, complete deliverable is `digital.extendedGreeks` returning **all 16**
(the five plus vanna, charm, vomma, speed, color, phi, zomma, veta, vera, ultima, lambda) for both
`cash-or-nothing` and `asset-or-nothing` binaries. Binary higher-order greeks are the desk's **pin-risk**
read — how a binary's delta/gamma explode and flip as spot approaches the strike near expiry.

## Method

The binary price (`cash·e^{−rT}·N(±d₂)` / `S·e^{−qT}·N(±d₁)`) is a **smooth** function of `(S, σ, r, q, T)`
for `T > 0`, so the higher-order greeks are taken by central **finite differences of the exact
`digital.price` closed form**, via the shared `finiteDifferenceExtendedGreeks(price, spotAt, state)` helper
(`engines/fd-greeks.ts`) — the same helper the numerical pricing engines use, so units and stencils are
identical. The **first-order fields are the exact analytic greeks** of `digital.greeks` (the FD first-order
agrees to ~1e-5; the analytic values are used so the two calls are consistent), and **`lambda = Δ·S/V` is
re-derived from the analytic delta** so it matches the overridden first-order.

Units match the package: delta/gamma raw, vega/1%, theta/day, rho/1%, `phi` per 1% dividend yield, the
higher-order greeks raw, `lambda` dimensionless.

## Honesty / verification

- **Cross-checked three ways.** (1) The extended set's first-order fields equal `digital.greeks` exactly;
  (2) each higher-order greek matches an **independent finite difference of the analytic first-order greeks**
  (`vanna = ∂delta/∂σ`, `vomma = ∂vega/∂σ`, `charm = ∂delta/∂T`, `zomma = ∂gamma/∂σ`, `vera = ∂rho/∂σ`,
  `phi = ∂price/∂q`) to ~1e-3 relative; (3) — the strongest — the whole set obeys the **vanilla
  decomposition** `vanilla = asset − K·cash`: every _linear_ greek of `blackScholesExtendedGreeks` equals
  `asset.extendedGreeks − K·cash.extendedGreeks` (first-order to ~1e-6, higher-order to ~2e-2), tying the
  binary greeks back to the known-correct analytic vanilla extended set.
- **The pin caveat is disclosed.** Near the strike a binary's greeks spike; they stay finite for `T > 0`,
  but very close to expiry-at-the-pin the higher-order finite differences lose precision — documented on the
  method so a caller reads the sign/scale rather than the last digit.
- **Envelope + guards.** Returns a `Computed<ExtendedGreeks>` with `assumptions.units` echoed and a
  `converged` flag over the 16 finite values; bad `type`/`kind`/input throw typed `QuantError`s. A deep-sweep
  first-touch fixture covers the new facade method.

## API

```ts
// on the existing `digital` namespace:
extendedGreeks(type: OptionType, kind: DigitalKind, input: DigitalInput): Computed<ExtendedGreeks>;
```

## Deferred (explicitly)

- **Closed-form higher-order binary greeks** (analytic vanna/charm/vomma/… rather than FD-of-exact-price) —
  more accurate _exactly_ at the pin, at the cost of ~22 hand-derived formulas; the FD-of-exact-price set is
  correct to FD precision everywhere `T > 0` and reuses one verified helper.
- **One-touch / no-touch (American binary) extended greeks** — the barrier analogue, a separate follow-on to
  `touch.greeks`.
