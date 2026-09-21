# Spec — Multi-period attribution linking (Cariño) (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → the follow-up flagged on `brinsonAttribution`: "multi-period
> geometric linking (Cariño/Menchero)".
> Status: **shipped** as `linkAttribution` in `packages/risk/src/attribution.ts`, covered by
> `packages/risk/test/attribution.test.ts`, full CI green.

## Goal

`brinsonAttribution` decomposes **one period's** active return into allocation / selection / interaction,
exactly. But performance is reported over **many** periods, and single-period effects **do not add up**:
returns compound geometrically while the arithmetic effects don't, so `Σₜ allocationₜ + Σₜ selectionₜ +
Σₜ interactionₜ ≠` the total (geometric) active return. This is the classic **linking problem**.
`linkAttribution` solves it with **Cariño's** logarithmic linking coefficients — the standard, smooth,
residual-free method — so the linked cumulative effects sum **exactly** to the compounded active return.

## The construction

Given per-period portfolio/benchmark returns `Pₜ, Bₜ` and effects `(aₜ, sₜ, iₜ)` (with `aₜ+sₜ+iₜ = Pₜ−Bₜ`):

```
R_P = ∏ₜ(1+Pₜ) − 1        R_B = ∏ₜ(1+Bₜ) − 1        activeReturn = R_P − R_B   (geometric)
```

Cariño's scaling factors (with the `x→0` L'Hôpital limit `1/(1+P)` when the denominator vanishes, i.e. a
flat-active period or a flat-active total):

```
k   = (ln(1+R_P) − ln(1+R_B)) / (R_P − R_B)          — the total scaling
kₜ  = (ln(1+Pₜ) − ln(1+Bₜ)) / (Pₜ − Bₜ)              — the period scaling
βₜ  = kₜ / k                                          — the linking coefficient for period t
```

The linked cumulative effect is the `βₜ`-weighted sum, `allocation = Σₜ βₜ·aₜ` (likewise selection,
interaction). Because `aₜ+sₜ+iₜ = Pₜ−Bₜ` and `Σₜ βₜ(Pₜ−Bₜ) = (1/k)·Σₜ kₜ(Pₜ−Bₜ) = (1/k)(ln(1+R_P) −
ln(1+R_B)) = R_P − R_B`, the three linked effects **sum to the geometric active return, exactly** — the
property the naive arithmetic sum lacks.

Per-**segment** effects are linked with the same `βₜ` and aggregated by segment name across periods, so the
segment breakdown still sums to the cumulative allocation/selection/interaction.

_Verified: the linked effects sum to `∏(1+P)−∏(1+B)` to machine precision (2e-17); a single period reduces
to `β = 1` (the effects pass through unchanged); a flat-active period gets a finite `β` (no `0/0`); and the
naive arithmetic sum is visibly wrong (the problem the linking fixes)._

## Honesty / envelope contract

- **Exact reconciliation, inherited** — the linked `allocation + selection + interaction = activeReturn` iff
  each period's effects reconcile to its active return (which `brinsonAttribution` guarantees); a supplied
  per-period residual is carried through, not hidden.
- **Cariño disclosed** — `method: 'carino'` echoed; the per-period `linkingCoefficients` (`βₜ`) are returned
  so the correction is auditable. (Menchero/GRAP variants are deferred.)
- **Return-domain guard** — every `Pₜ`/`Bₜ` (and the compounded totals) must exceed `−100 %` (else the log
  linking is undefined); enforced with a typed error.
- **Segments all-or-nothing** — the linked segment breakdown is produced only when **every** period supplies
  segments (else it would silently drop a period's effects from the breakdown); disclosed by its presence.
- **First-touch** — `linkAttribution(periods, options?)` ⇒ first-touch **deep-sweep fixture**. Guards:
  non-array / empty `periods`; a non-object period; non-finite or `≤ −100 %` returns; a bad `method`.
- **Envelope (R2)** — a domain object with the compounded returns, linked effects, coefficients, optional
  segments, `assumptions`, `diagnostics`.

## API

```ts
interface AttributionPeriod {
  portfolioReturn: number;
  benchmarkReturn: number;
  allocation: number;
  selection: number;
  interaction: number;
  /** Optional per-segment effects (as from `brinsonAttribution().segments`) to link segment-by-segment. */
  segments?: SegmentEffect[];
  /** Optional period label, echoed onto its linking coefficient. */
  label?: string;
}
interface LinkedAttribution {
  /** Compounded portfolio / benchmark return and their (geometric) difference. */
  portfolioReturn: number;
  benchmarkReturn: number;
  activeReturn: number;
  /** Cariño-linked cumulative effects — `allocation + selection + interaction = activeReturn` (exact). */
  allocation: number;
  selection: number;
  interaction: number;
  /** The per-period linking coefficient `βₜ` (with the period's `label` when supplied). */
  linkingCoefficients: { label?: string; coefficient: number }[];
  /** Linked per-segment effects — present only when every period supplied segments. */
  segments?: SegmentEffect[];
  method: 'carino';
  assumptions: { conventionsVersion: string; method: 'carino'; periods: number };
  diagnostics: Diagnostics;
}
function linkAttribution(
  periods: AttributionPeriod[],
  options?: { method?: 'carino' },
): LinkedAttribution;
```

`BrinsonAttribution` (from `brinsonAttribution`) is structurally an `AttributionPeriod`, so a sequence of
Brinson results links directly.

## Build checklist

1. **Validate** — non-empty `periods`; each finite with `Pₜ, Bₜ > −1`; method enum.
2. **Compound** — `R_P`, `R_B`, `activeReturn`; the total scaling `k` (with the limit).
3. **Link** — per-period `βₜ = kₜ/k`; `Σₜ βₜ·(aₜ, sₜ, iₜ)`.
4. **Segments** — when all periods have them, aggregate `βₜ·segmentEffect` by name.
5. **Envelope + export + deep-sweep fixture + API report + READMEs/llms.**
6. **Tests** — the exact-sum identity; single-period `β = 1`; the flat-active limit; segment reconciliation;
   a real `brinsonAttribution`-sequence round-trip; guards.

## Deferred (explicitly)

- **Menchero and GRAP** linking variants (different coefficient definitions; Cariño is the smooth default).
- **Multi-currency** attribution (a currency/hedging effect) and a **residual (smoothing) term** report when
  the single-period inputs don't reconcile.
- **Factor-model linking** — the same multi-period linking applied to `factorAttribution` contributions.
