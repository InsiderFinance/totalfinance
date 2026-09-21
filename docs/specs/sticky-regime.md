# Spec — Sticky-strike vs sticky-delta regime (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → _"…sticky-strike vs sticky-delta regime measurement."_ (The other
> half of the surface-dynamics line; the first half shipped as `surfacePCA`.) Status: **shipped** as
> `stickyRegime` in `packages/volatility/src/sticky-regime.ts`, covered by
> `packages/volatility/test/sticky-regime.test.ts`, full CI green.

## Goal

When spot moves, does the smile **stay put on strikes** or **slide with the spot**? That regime governs
how you delta-hedge — `minimumVarianceDelta` _assumes_ a regime (`sticky-strike` ⇒ `β = 0`,
`sticky-moneyness` ⇒ `β = −skewSlope/spot`); `stickyRegime` **measures which one the market is actually
in** from a history of spot and a fixed reference strike's implied vol. It places the market on the
sticky-strike ↔ sticky-moneyness axis with a single **stickiness** number and a labeled regime.

## The measurement

Track one **fixed** strike `K` over time: its implied vol `σ_K(t)` and the spot `S(t)`. Regress the vol
change on the spot log-return (OLS, from `@totalfinance/math`):

```
Δσ_K,t = a + β·ΔlnS_t + ε_t,     ΔlnS_t = ln(S_t / S_{t−1})
```

`β = ∂σ_K/∂lnS` is the **vol-spot beta** — how a _fixed strike's_ vol co-moves with spot. The two
reference regimes (with `skewSlope = ∂σ/∂ln K`, the smile slope in log-strike):

- **sticky-strike** — a fixed strike's vol is constant as spot moves: `β = 0`.
- **sticky-moneyness (sticky-delta)** — `σ = f(ln(K/S))`, so a fixed strike's moneyness (hence vol)
  changes with spot: `β = −skewSlope` (`∂σ_K/∂lnS = f'·(−1) = −∂σ/∂lnK`).

**Stickiness** interpolates the axis: `s = −β / skewSlope`. `s = 0` ⇒ pure sticky-strike, `s = 1` ⇒ pure
sticky-moneyness; `s < 0` (super-sticky-strike) and `s > 1` (over-sliding) are possible and reported as
such. _(Verified against synthetic worlds: sticky-strike → `s ≈ 0`, `R² ≈ 0`; sticky-moneyness →
`s ≈ 1`, `R² ≈ 0.97`; a 50/50 blend → `s ≈ 0.5`.)_

The regression's **R²** says how much of the fixed-strike vol's motion spot explains — the reliability of
the placement. (Sticky-strike naturally has a low R²: the point is that the vol _doesn't_ respond.)

## Regime label

From `s` (when `skewSlope` is usable): `s < 0.25 → 'sticky-strike'`, `s > 0.75 → 'sticky-moneyness'`,
otherwise `'intermediate'`. When `skewSlope` is absent or ≈ 0 (a flat smile — nothing to normalize
against), `s` is `null` and the regime is `'indeterminate'`; the raw `β`, `tStatistic`, and `R²` are still
reported so the caller has the empirical co-movement even without a reference.

## Honesty / envelope contract

- **Placement needs a reference** — without a non-flat `skewSlope` the sticky axis is undefined; the
  result says so (`'indeterminate'`, `stickiness: null`) rather than dividing by ~0.
- **Reliability is surfaced** — a low `R²` that supports a **non-trivial** placement (intermediate /
  sticky-moneyness) rides an info-level `volatility.sticky_weak_fit` warning, so a regime label built on a weak
  regression is flagged. A low `R²` under a **sticky-strike** verdict is _not_ warned — there it is the
  expected signature (the vol simply doesn't respond to spot), not a reliability concern.
- **Sign is honest for both skews** — a downside (put) skew (`skewSlope < 0`) and an upside skew both map
  through the same `s = −β/skewSlope`; the regime doesn't depend on the skew's sign.
- **Envelope (R2)** — `assumptions` (change basis, skewSlope used) + `diagnostics`; deterministic.
- Typed guards (aligned `spot`/`fixedStrikeVolatility`, ≥ 3 observations for a 2-parameter regression, positive
  spot/vol, finite `skewSlope`).

## API

```ts
interface StickyRegimeInput {
  /** Per-observation underlying spot, aligned to fixedStrikeVolatility. */
  spot: ArrayLike<number>;
  /** Per-observation implied vol of a FIXED reference strike (same K across the series). */
  fixedStrikeVolatility: ArrayLike<number>;
  /** The smile slope ∂σ/∂ln(K) — the sticky-moneyness reference. Omit ⇒ only β/R² (indeterminate regime). */
  skewSlope?: number;
}
interface StickyRegime {
  /** ∂σ_K/∂lnS — the empirical vol-spot beta from the regression. */
  volatilitySpotBeta: number;
  tStatistic: number;
  /** How much of the fixed-strike vol's change spot returns explain. */
  rSquared: number;
  /** Position on the axis: 0 = sticky-strike, 1 = sticky-moneyness (= −β/skewSlope). Null if no reference. */
  stickiness: number | null;
  regime: 'sticky-strike' | 'sticky-moneyness' | 'intermediate' | 'indeterminate';
  observations: number;
  assumptions: { conventionsVersion: string; skewSlope: number | null };
  diagnostics: Diagnostics;
}
function stickyRegime(input: StickyRegimeInput): StickyRegime;
```

## Build checklist

1. **Regression** — validate/align; build `ΔlnS` and `Δσ_K`; `ols(Δσ, [[ΔlnS]])` → `β` (slope), t-stat, R².
2. **Placement** — `stickiness = −β/skewSlope` (when `skewSlope` usable); regime bands; `indeterminate`
   when no/flat `skewSlope`.
3. **Disclosure** — the weak-`R²` info warning.
4. **Envelope + exports + API report + READMEs/llms** (single-arg ⇒ garbage-sweep only).
5. **Tests** — a sticky-strike synthetic world → `β≈0`/`s≈0`; a sticky-moneyness world → `β≈−skewSlope`/
   `s≈1`/high R²; a blend → `intermediate`; no/flat `skewSlope` → `indeterminate`, `stickiness: null`; a
   low-R² input warns; an upside-skew (`skewSlope>0`) case maps correctly; guards.

## Deferred (explicitly)

- **Multi-strike / whole-smile regime** — aggregate the beta across several strikes (or the ATM-forward
  vol) instead of one reference strike.
- **Rolling regime** — a time-varying stickiness over a moving window (regime shifts across a vol event).
- **Sticky-local-volatility / sticky-implied-tree** regimes beyond the two-point axis.
- **Auto-`skewSlope`** — derive the reference slope from a supplied smile rather than taking it as input.
