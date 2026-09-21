# Spec — Touch & double-touch greeks (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → the follow-up flagged on `digital.greeks` and `doubleTouch`: "greeks for
> the barrier binaries (`touch`, `doubleTouch`)". Completes the exotic-binary risk suite.
> Status: **shipped** as `touch.greeks` + `doubleTouch.greeks` in `packages/options/src/exotics.ts`, covered
> by `packages/options/test/touch-greeks.test.ts`, full CI green.

## Goal

`digital.greeks` gives the risk of the European binaries; the **barrier** binaries — one-touch / no-touch
and the corridor double-no-touch / double-one-touch — were priced (`touch`, `doubleTouch`) but had no
greeks. Their risk is exactly what a desk holding them needs: the delta **spikes and flips** near a
barrier, and the position is heavily short/long vol depending on side. This adds the first-order greeks
(delta, gamma, vega, theta, rho) for both.

## Why finite-difference (and why it's exact enough)

The one-touch first-passage value (`touchProbability`, Reiner–Rubinstein at-hit) and the double-barrier
**method-of-images series** don't have clean, robust analytic greeks — differentiating the image series or
the two-regime first-passage form is research-grade and error-prone. So the greeks are a **central
finite-difference of the exact analytic price** (not a re-simulated one), disclosed as
`method: 'finite-difference'`. This is honest and standard for barrier greeks, and it is pinned to an
**exact identity** that leaves no room for a silent error:

```
one-touch(pay-at-expiry) + no-touch = cash·e^{−rT}      double-no-touch + double-one-touch = cash·e^{−rT}
```

Both sides hold for **every** spot/vol/rate/time, so the two binaries' greeks must sum to the greeks of the
constant `cash·e^{−rT}` — i.e. `Δ, Γ, vega` sum to **0** and `θ, ρ` sum to the (trivial) `cash·e^{−rT}`
greeks. Because the pair is differenced with the same bumps, the delta/gamma/vega sums are **0 to machine
precision** and θ/ρ match the closed form. _Verified: the sums are `~1e-13` (Δ,Γ,vega) and match `cash·e^{−rT}`'s
θ/ρ to `~1e-16`; the one-touch delta agrees in sign and magnitude with a bumped Monte-Carlo._

## The construction

- **Shared value functions** — the value logic is extracted into pure `touchValue` / `doubleTouchValue`
  (also now backing `.price`, so the differenced value is byte-for-byte the priced one), then bumped.
- **Bumps** — central differences: `hS` on spot, `1e-4` on vol, `1e-4` on time, `1e-5` on rate; σ/T bumps
  are clamped to stay valid (`min(1e-4, ·/2)`).
- **Barrier-aware spot bump** — `hS` is **shrunk near a barrier** so a central bump never straddles it (the
  value is discontinuous in _regime_ across `H` / `L` / `U`): `hS = min(S·1e-4, dist·0.25)`, floored
  positive so a breached spot still bumps validly. Greeks exactly _at_ a barrier are unbounded and not
  meaningful — disclosed.
- **Units** — package convention: delta/gamma raw, **vega/1%**, **theta/day**, **rho/1%**, echoed in
  `assumptions.units = DEFAULT_GREEK_UNITS`.

## Honesty / envelope contract

- **Method disclosed** — `diagnostics.method = 'finite-difference'`; the greeks differentiate the exact
  price, not a simulation.
- **payAt respected** — `touch.greeks` honours `payAt` (`expiry` default / `hit`); a `no-touch` with
  `payAt: 'hit'` throws (as `touch.price` does), since a no-touch has no hit to pay on.
- **First-touch** — namespaced facade methods (`touch.greeks`, `doubleTouch.greeks`) ⇒ first-touch
  **deep-sweep fixtures**. Guards: bad `kind`; the no-touch+hit case; and every `touch.price` /
  `doubleTouch.price` input guard (non-positive spot/barrier(s)/t/vol, `lower < upper`, non-finite
  rate/cash) — all typed `QuantError`.
- **Envelope (R2)** — `Computed<Greeks>` (`value` + `assumptions` + `diagnostics`).

## API

```ts
// touch: one-touch / no-touch first-order greeks (payAt honoured).
touch.greeks(kind: TouchKind, input: TouchInput): Computed<Greeks>;
// doubleTouch: double-no-touch / double-one-touch corridor greeks.
doubleTouch.greeks(kind: DoubleTouchKind, input: DoubleTouchInput): Computed<Greeks>;
```

(Both `Greeks = { delta, gamma, theta, vega, rho }` in the package units above.)

## Build checklist

1. **Extract** `touchValue` / `doubleTouchValue` from the price engines; refactor `.price` onto them.
2. **`fdBarrierGreeks`** — central-difference a `v(S, σ, T, r)` in package units, with clamped σ/T bumps.
3. **`touch.greeks`** — barrier-aware `hS = min(S·1e-4, |S−H|·0.25)`; honour `payAt`; reject no-touch+hit.
4. **`doubleTouch.greeks`** — `hS = min(S·1e-4, (S−L)·0.25, (U−S)·0.25)` floored positive.
5. **Deep-sweep fixtures + export** (the facades are already exported).
6. **Tests** — the two exact `= cash·e^{−rT}` greek identities; the delta signs (down-barrier one-touch
   `< 0`, no-touch `> 0`; up-barrier flips); one-touch long-vol / no-touch short-vol; a bumped-MC delta
   cross-check; units; pay-at-hit path; guards.

## Deferred (explicitly)

- **Analytic touch greeks** — a closed-form differentiation of `touchProbability` / Reiner–Rubinstein for
  the single-barrier case (the double-barrier series stays finite-difference).
- **Higher-order barrier greeks** (vanna/charm/vomma) and **per-barrier greek attribution** for the corridor
  (which barrier drives the delta).
- **Pay-at-hit double-touch greeks** once a pay-at-hit double-touch price lands.
