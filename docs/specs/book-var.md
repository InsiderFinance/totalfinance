# Spec — Greek-based book VaR (`@totalfinance/risk`)

> Roadmap Tier 2 → "Portfolio & risk" follow-up: _"greek-based parametric book VaR."_ The risk-
> dashboard capstone that turns the aggregated portfolio book ([`portfolio-book.md`](./portfolio-book.md))
> into a loss distribution. Status: **shipped** as `bookVaR` in `packages/risk/src/book-var.ts`,
> covered by `packages/risk/test/book-var.test.ts`, full CI green.

## Goal

Answer, in one call, _"how much can my whole options book lose over the next N days, and which name
drives it?"_ — a **delta-gamma** Value-at-Risk / Conditional-VaR for a book of strategy positions, from
each name's greeks and a risk-factor model (per-underlying spot vol, cross-underlying correlation, and
optional vol-of-vol). It composes the existing greek-Taylor engine (`taylorPnl`), the VaR/ES machinery
(`valueAtRiskReport`), the correlated-normal sampler (`correlatedNormalSampler`), and the book marking that
`analyzeBook` already performs.

## Why this is a composition, not a re-implementation

Everything the number needs already exists:

- `taylorPnl(greeks, scenario)` (scenario.ts) — the per-name Taylor P&L `Δ·dS + ½Γ·dS² + Vega·dσ +
Θ·timeStepYears` under a factor move. **This is where gamma's convexity lives**, so a Monte-Carlo pass over it is
  delta-gamma-exact.
- `correlatedNormalSampler(cov)` + `mulberry32(seed)` (math) — seeded correlated-normal draws (Cholesky
  inside), the same primitives `portfolioVaR({ method: 'monteCarlo' })` uses. Determinism-law compliant.
- `valueAtRiskReport(pnl, { method: 'historical' })` (value-at-risk.ts) — VaR + CVaR as positive loss magnitudes from a
  P&L sample, so the MC tail is computed with the library's own quantile/ES conventions.
- `quadForm(Σ, δ)` / `matVec(Σ, δ)` (linalg) — `δᵀΣδ` and `Σδ` for the closed-form parametric VaR and
  its Euler risk decomposition.
- The display→raw greek bridge (`rawGreeksFromDisplay`, pnl-explain) and per-underlying marking are the
  same ones `analyzeBook` uses.

`bookVaR` marks each position, aggregates **raw** greeks and spot per underlying, builds the horizonPeriods
`dS` covariance from the factor model, and returns both a parametric (delta-normal) and a Monte-Carlo
(delta-gamma) VaR with a per-underlying decomposition — one coherent `BookVaRResult`.

## The model

For a horizonPeriods of `h = horizonDays / tradingDaysPerYear` years:

- **Spot** — each underlying `i`'s move `dSᵢ = spotᵢ · rᵢ`, with `rᵢ ~ N(0, σᵢ²·h)` (`σᵢ` = annualized
  spot return vol) and a cross-underlying correlation `ρ`. The horizonPeriods `dS` covariance is
  `Σ_S,ij = ρ_ij · (σᵢ·spotᵢ·√h)·(σⱼ·spotⱼ·√h)`.
- **Volatility** (optional) — each name's IV move `dσᵢ ~ N(0, (νᵢ·√h)²)` (`νᵢ` = annualized vol-of-vol, in vol
  points/√yr), independent of spot in v1 (leverage/skew correlation is a follow-up). Drives vega P&L.
- **Time** — the deterministic decay `Θᵢ·h`, a drift (not a dispersion), surfaced in `pnlMean`.
- **Rate** — no rate factor in v1 (negligible over short equity-option horizons); a documented follow-up.

Positions on the same underlying share one spot factor (their greeks add), so cross-underlying gamma is
zero and the book's second-order term is diagonal by name.

### Parametric (delta-normal, closed form)

Linear P&L dispersion `σ_L² = δᵀΣ_S δ + Σᵢ vegaᵢ²·(νᵢ√h)²`; drift `μ = ½Σᵢ Γᵢ·Var(dSᵢ) + Σᵢ Θᵢ·h`
(gamma convexity mean + theta). With `z = −Φ⁻¹(1−c)`:

```
VaR  = max(0, z·σ_L − μ)          CVaR = max(VaR, φ(Φ⁻¹(1−c))/(1−c)·σ_L − μ)
```

This is fast and exact for a **linear** book; gamma enters only through the disclosed `μ` drift, not the
tail (a long-gamma book's fatter right / thinner left tail is a Monte-Carlo effect). Disclosed as
`method: 'delta-normal'` so the linear approximation is never mistaken for the gamma-aware number.

### Monte-Carlo (delta-gamma, exact to 2nd order)

Draw `samples` correlated `dS` vectors (+ independent `dσ`), evaluate `Σᵢ taylorPnl(rawᵢ, {spot: dSᵢ,
volatility: dσᵢ, time: h})` per draw, and take the empirical tail via `valueAtRiskReport(pnl, 'historical')`. Captures
gamma convexity, correlation, and cross-factor terms exactly. Seeded (echoed) and deterministic.

### Per-underlying decomposition (from the linear risk)

- **standaloneVaR** `= max(0, z·√(δᵢ²Σ_S,ii + vegaᵢ²(νᵢ√h)²) − (½Γᵢ Σ_S,ii + Θᵢh))` — the name in
  isolation (its own dispersion less its own drift).
- **componentVaR** `= z·[δᵢ(Σ_S δ)ᵢ + vegaᵢ²(νᵢ√h)²]/σ_L − (½Γᵢ Σ_S,ii + Θᵢh)` — its diversification-aware
  Euler dispersion share **less its own drift**, so `Σᵢ componentVaR = z·σ_L − μ` = the book's
  parametric VaR (before the ≥0 floor), the Euler decomposition of the **full** VaR. Because the Euler
  dispersion share is ≤ the standalone dispersion, `standaloneVaR ≥ componentVaR` holds even for a
  positive-carry (long-gamma) name — where a dispersion-only component would have broken it.

## API

```ts
interface UnderlyingRiskFactor {
  spotReturnVolatility: number; // annualized spot RETURN vol (0.30 = 30%/yr) — required
  volatilityOfVolatility?: number; // annualized stdev of IV changes (vol points/√yr) → vega VaR; default 0
}
interface BookVaROptions {
  factors: Record<string, UnderlyingRiskFactor>; // MUST cover every underlying in the book
  confidence?: number; // (0,1), default 0.95
  horizonDays?: number; // > 0, default 1
  correlation?: number[][]; // spot-return correlation, rows/cols in sorted-underlying order; default I
  method?: 'both' | 'parametric' | 'monteCarlo'; // default 'both'
  samples?: number; // MC draws, default 10_000, capped at MAX_VAR_SAMPLES
  seed?: number; // integer, MC reproducibility, default 1
  tradingDaysPerYear?: number; // vol annualization, default 252
}
interface BookVaRComponent {
  underlying: string;
  standaloneVaR: number;
  componentVaR: number;
  delta: number;
  gamma: number;
  vega: number; // raw sensitivities used (audit trail)
}
interface BookVaRMethodResult {
  valueAtRisk: number;
  conditionalValueAtRisk: number;
  pnlMean: number;
  pnlStandardDeviation: number;
}
interface BookVaRResult {
  confidence: number;
  horizonDays: number;
  parametric?: BookVaRMethodResult; // delta-normal (present unless method='monteCarlo')
  monteCarlo?: BookVaRMethodResult; // delta-gamma, seeded (present unless method='parametric')
  components: BookVaRComponent[]; // by underlying, sorted by componentVaR desc
  assumptions: { conventionsVersion; confidence; horizonDays; tradingDaysPerYear; samples?; seed? };
  diagnostics: Diagnostics;
}
function bookVaR(positions: readonly BookPosition[], options: BookVaROptions): BookVaRResult;
```

`bookVaR` takes the **same `BookPosition[]`** as `analyzeBook` (so it has each name's spot from its
market), marks each position, and aggregates raw greeks + spot per underlying — no need to thread the
book's reduced shape or a separate spot map.

## Honesty / envelope contract

- VaR/CVaR are positive loss magnitudes (matches `VaRResult`); the drift `pnlMean` is disclosed so a
  positive-carry book's reduced VaR is transparent, never hidden.
- `method: 'delta-normal'` labels the parametric number as linear; the MC number is the gamma-aware one.
- Typed guards: garbage positions/opts; a `factors` map missing a book underlying; `confidence ∈ (0,1)`;
  `horizonDays > 0`; `spotReturnVolatility ≥ 0`; a non-integer `seed`; a correlation matrix that isn't square. The
  correlation must be **positive-definite** — validated via Cholesky on **every** method (not just
  Monte-Carlo), so a non-PSD ρ can never silently clamp the parametric variance to a wrong (often zero)
  VaR. Note this also rejects a valid-but-**singular** correlation (e.g. two perfectly-correlated names,
  ρ = 1, or a rank-deficient factor matrix) on both methods — merge perfectly-correlated names. `samples`
  capped in-range.
- Positions on one underlying share a single spot factor; a differing `market.spot` across them is
  disclosed as a warning (the first spot is used), never silently dropped.
- Pure and deterministic; the MC seed is echoed; times are the positions' explicit `asOf`s.

## Build checklist

1. **Types** — `UnderlyingRiskFactor`, `BookVaROptions`, `BookVaRComponent`, `BookVaRMethodResult`,
   `BookVaRResult`.
2. **Aggregate** — mark each position (`Position.value`), sum **raw** greeks + capture spot per
   underlying (reuse `rawGreeksFromDisplay`); guard a missing factor.
3. **Covariance** — build `Σ_S` (horizonPeriods-baked) from `spotReturnVolatility`, `spot`, and `correlation`.
4. **Parametric** — `σ_L`, `μ`, VaR/CVaR, and the standalone/component decomposition.
5. **Monte-Carlo** — seeded correlated `dS` + independent `dσ` draws → per-draw `Σ taylorPnl` →
   `valueAtRiskReport` historical; echo seed + samples.
6. **Envelope + exports** — assemble `BookVaRResult`; export from the risk index; API report; deep-sweep
   fixture.
7. **Tests** — parametric vs MC agreement on a linear (near-zero-gamma) book; a short-gamma book has
   MC VaR > parametric (fatter left tail); correlation raises book VaR vs independent; component VaR
   sums to the book VaR (`z·σ_L − μ`) and standalone ≥ component (incl. a long-gamma book); a non-PSD
   correlation throws on the parametric path; a single-name book matches a hand closed form; horizonPeriods
   √-scaling; vol-of-vol raises VaR; envelope/guards; deep-sweep.

## Deferred (explicitly)

- **Cornish-Fisher gamma-adjusted parametric** — fold the quadratic form's skew (`tr((GΣ_S)³)`, the
  δ-Γ-Σ cross term) into the parametric quantile so it, too, is gamma-aware without sampling.
- **A rate factor** and **spot–vol (leverage) correlation** in the factor model.
- **Historical / bootstrap** book VaR from a realized factor-return panel (pairs with the data layer).
- **Marginal VaR** (∂VaR/∂exposure) once a per-name exposure scalar is defined.
