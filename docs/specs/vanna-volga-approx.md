# Spec — Vanna–volga Castagna–Mercurio closed-form approximation (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the vanna-volga follow-up: "the Castagna–Mercurio closed-form
> approximation".
> Status: **shipped** as `vannaVolgaApproximation` in `packages/volatility/src/vanna-volga.ts`, covered by
> `packages/volatility/test/vanna-volga.test.ts`, full CI green.

## Goal

`calibrateVannaVolga` builds the FX/crypto smile by **exactly** replicating each strike's vega/vanna/volga — a
per-strike 3×3 solve, a Black inversion, and a no-arbitrage-bounds check that can _fail_ in the wings.
Castagna & Mercurio (2007) give the **closed-form** implied-vol approximation the market actually quotes
with: no linear solve, no inversion, always defined. This adds `vannaVolgaApproximation` — the same three-pillar
setup, the CM formula for the vol at any strike.

## The formula

Pillars `K₁ < K₂ < K₃` (put / ATM / call) with vols `σ₁, σ₂ (= ATM), σ₃`, from the same `smileFromQuotes`
the exact method uses. Define the log-strike Lagrange weights at a query strike `K`:

```
y₁ = ln(K₂/K)·ln(K₃/K) / (ln(K₂/K₁)·ln(K₃/K₁))
y₂ = ln(K/K₁)·ln(K₃/K) / (ln(K₂/K₁)·ln(K₃/K₂))
y₃ = ln(K/K₁)·ln(K/K₂) / (ln(K₃/K₁)·ln(K₃/K₂))      (y₁ + y₂ + y₃ = 1)
```

- **First order** (`order: 1`) — a quadratic interpolation of the three vols in log-strike:
  `σ(K) = y₁σ₁ + y₂σ₂ + y₃σ₃`.
- **Second order** (`order: 2`, default) — curvature-corrected:
  ```
  σ(K) = σ₂ + (−σ₂ + √(σ₂² + d₁(K)d₂(K)·(2σ₂·D₁ + D₂))) / (d₁(K)d₂(K))
  D₁ = y₁(σ₁−σ₂) + y₃(σ₃−σ₂)
  D₂ = y₁·d₁(K₁)d₂(K₁)(σ₁−σ₂)² + y₃·d₁(K₃)d₂(K₃)(σ₃−σ₂)²
  ```
  where `d₁(·), d₂(·)` are the forward Black d₁/d₂ at ATM vol σ₂.

**Both orders reprice the three pillars exactly** (`y_i` is 1 at its own pillar, 0 elsewhere; the 2nd-order
`√` collapses to `σ₂ + d₁d₂(σᵢ−σ₂)` at a pillar, giving `σᵢ`). _Verified against the exact `calibrateVannaVolga` at
the test smile (F = 100, T = 0.5, ATM = 20%, RR = −2%, BF = +0.5%): pillar-exact to ~1e-6; the 2nd order
matches the exact VV to **< 0.1 bp** across the 94–106 core (0.06 bp at a 5%-OTM strike), widening to only
~3.6 bp in the far 20%-OTM wing; the 1st order is a rough interpolation (~105 bp in that wing). Steeper smiles
widen the wing gap while the core stays sub-bp — e.g. at RR = −5%, BF = +2% the 20%-OTM error is ~32 bp
(order 2) / ~485 bp (order 1)._

## Honesty / envelope contract

- **Approximation, disclosed** — the result carries `method: 'castagna-mercurio'` and the `order`; the exact
  replication stays in `calibrateVannaVolga`. The 2nd order is the accurate, market-standard one; the 1st is the
  simple interpolation.
- **Always defined, but guarded** — unlike the exact method (which throws in the far wings once its VV price
  leaves the no-arbitrage bounds), the closed form needs no Black inversion, so it **extrapolates**: for a
  normal convex smile (butterfly `> 0`) it returns a finite vol at _any_ strike, including ones where
  `calibrateVannaVolga` refuses. The one genuine breakdown is an **inverted** smile: a non-positive butterfly makes the
  2nd-order curvature term `D₁` negative in the wings, driving the `√` argument negative (or, in the limit
  branch, the vol below `MIN_VOL`). Those strikes are collected and a typed error names them — never a
  `NaN`/silent-garbage vol. The 1st order (a Lagrange parabola) is unconditionally finite and positive.
- **Pillars echoed** — the result reports the same three pillars it reprices, like `calibrateVannaVolga`.
- **Guards** — the same input validation as `calibrateVannaVolga` (positive forward/t/atmVolatility/strikes, finite RR/BF),
  plus `order ∈ {1, 2}`.

## API

```ts
export interface VannaVolgaApproximationInput extends VannaVolgaInput {
  /** Castagna–Mercurio order: 1 (log-strike interpolation) or 2 (curvature-corrected; default). */
  order?: 1 | 2;
}
export interface VannaVolgaApproximationSmile {
  strikes: number[];
  volatilities: number[];
  pillars: { putStrike; putVolatility; atmStrike; atmVolatility; callStrike; callVolatility };
  delta: number;
  order: 1 | 2;
  assumptions: {
    conventionsVersion;
    method: 'castagna-mercurio';
    deltaConvention: 'forward';
    delta;
    order;
  };
  diagnostics: Diagnostics;
}
export function vannaVolgaApproximation(
  input: VannaVolgaApproximationInput,
): VannaVolgaApproximationSmile;
```

## Build checklist

1. `castagnaMercurio(order, F, T, K, K₁, K₂, K₃, σ₁, σ₂, σ₃)` — the private closed-form helper.
2. `vannaVolgaApproximation` — validate (reuse the `calibrateVannaVolga` guards) + `order`; pillars via `smileFromQuotes`;
   per-strike CM vol with the breakdown guard; return the smile.
3. Exports in `index.ts`. No explicit first-touch fixture needed — like `calibrateVannaVolga`, the single-object-arg
   signature is auto-covered by the arg-0 garbage sweep (`requireArgumentObject` throws a typed `QuantError`).
4. Tests: pillar-exactness (both orders), 2nd-order ≈ exact `calibrateVannaVolga` in the core (bp-tight), 1st-vs-2nd
   accuracy, the `d₁d₂ → 0` limit branch, the flat-smile case, extrapolation past where the exact method
   refuses, the inverted-butterfly breakdown guard, and the input guards; 100% coverage of the new code.

## Deferred (explicitly)

- **5-pillar (10Δ) vanna-volga** and a **VV-implied risk-neutral density** — the other two vanna-volga
  follow-ups.
