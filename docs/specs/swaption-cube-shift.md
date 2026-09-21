# Spec — Shifted (displaced) SABR for the swaption cube (`@totalfinance/volatility`)

> Roadmap Tier 2 → Fixed income → the follow-up flagged on the swaption cube: "shifted-SABR for negative
> rates".
> Status: **shipped** as the `shift` option of `swaptionCube` / `swaptionCubeVolatility` in
> `packages/volatility/src/swaption-cube.ts`, covered by `packages/volatility/test/swaption-cube.test.ts`, full CI green.

## Goal

`swaptionCube` calibrates a SABR smile per node, and SABR is a **lognormal** model — its Hagan expansion is
built on `ln(F/K)`, so it requires **`F, K > 0`**. But interest rates go **negative** (EUR, JPY, CHF for a
decade), and a negative forward swap rate makes the cube throw (`fitSABRSmile: forward must be > 0`) — it
can't price a negative-rate swaption at all. The market-standard fix is **shifted (displaced) SABR**: add a
constant displacement `s` so `F + s` and `K + s` are positive, calibrate/evaluate on the shifted rates, and
quote the vol against shifted-lognormal (shifted-Black) pricing. This adds a `shift` option that makes the
cube work through zero and into negative rates, with `shift = 0` leaving the existing behavior untouched.

## The construction

A cube-wide displacement `s ≥ 0` is applied uniformly to the forward and the strikes everywhere SABR is
touched:

- **Calibration** — each node is fit as `fitSABRSmile({ forward: F + s, strikes: Kᵢ + s, ivs, t })`, and its
  ATM vol is `sabrVolatility({ forward: F + s, strike: F + s, t })`. The stored `CalibratedSwaptionNode.forward`
  stays the **real (unshifted)** forward for reporting; the shift lives only inside SABR.
- **Evaluation** — `swaptionCubeVolatility` interpolates the (unshifted) forward and SABR params as before, then
  evaluates `sabrVolatility({ forward: F + s, strike: K + s, t })`.
- **Validation** — every node must have `F + s > 0` and `min(strikes) + s > 0`, else a typed error asks for
  a larger shift.

**What the vol means.** For the `lognormal` convention the returned vol is a **shifted-lognormal** vol — it
is priced with Black on the shifted rates: `annuity · Black(F + s, K + s, vol, expiry)`. For the `normal`
(Bachelier) convention the shift is a harmless translation (Bachelier depends on `F − K`, invariant under a
common shift), so the vol is the ordinary normal vol — the shift is there only to satisfy SABR's
positivity. The `shift` is echoed in the result and its `assumptions` so the caller prices consistently.

_Verified: `shift = 0` reproduces the existing cube byte-for-byte; a negative-forward node that throws
without a shift calibrates cleanly with one and recovers its ATM input vol to ~1e-12; and the shifted smile
reproduces the market node vols it was fit to._

## Honesty / envelope contract

- **Backward-compatible** — `shift` defaults to `0`; an existing positive-rate cube is unchanged.
- **The vol convention is disclosed** — `shift` is echoed on the cube result and in `assumptions`; the
  lognormal vol is a shifted-lognormal vol (price with Black on `rate + shift`), documented so it is not
  mistaken for a plain-Black vol.
- **A too-small shift is a typed error, not garbage** — `F + s ≤ 0` or `min(K) + s ≤ 0` throws with a
  message to increase the shift, rather than letting SABR fail deep inside.
- **First-touch guards** — a non-finite `shift`; the existing node guards — all throw a typed `QuantError`.
- **Envelope (R2)** — the cube and vol results keep their `assumptions` + `diagnostics`, now carrying `shift`.

## API

Additive — a new option and a new result field:

```ts
interface SwaptionCubeInput {
  // …existing nodes / beta / volatilityType / maximumIterations / tolerance…
  /** Rate displacement `s ≥ 0` for shifted (displaced) SABR — lets `F + s`, `K + s` stay positive so a
   *  negative-rate cube calibrates. Default 0 (plain SABR). */
  shift?: number;
}
interface SwaptionCube {
  // …existing nodes / expiries / tenors / volatilityType…
  /** The rate shift applied inside SABR (0 for plain SABR). */
  shift: number;
  assumptions: {
    conventionsVersion: string;
    volatilityType: SabrVolatilityType;
    backbone: 'sabr';
    shift: number;
  };
  // …diagnostics…
}
```

`swaptionCubeVolatility` reads the `shift` off the cube — no query change.

## Build checklist

1. **Validate** — `ensureFinite(shift)`, `shift ≥ 0`; per node `F + s > 0` and `min(K) + s > 0`.
2. **Calibrate shifted** — `fitSABRSmile`/`sabrVolatility` on `F + s`, `K + s`; keep the reported forward unshifted.
3. **Store + echo** — `shift` on the cube and its `assumptions`.
4. **Evaluate shifted** — `swaptionCubeVolatility` applies the cube's `shift` to forward and strike.
5. **Tests** — `shift = 0` backward-compat; the negative-forward fit; the ATM/smile reproduction; the
   too-small-shift and non-finite guards.

## Deferred (explicitly)

- **A per-node shift** (a term structure of displacements) rather than one cube-wide `s`.
- **Free-boundary / normal-SABR** as an alternative negative-rate model, and a **negative-rate-aware
  swaption price helper** (`annuity · shiftedBlack(F+s, K+s, vol, T)`) so the caller need not re-apply the
  shift.
- **Auto-selecting the shift** from the most-negative forward in the grid.
