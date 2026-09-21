# Spec — Cornish-Fisher gamma-adjusted book VaR (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → the follow-up flagged on `bookVaR`: "a Cornish-Fisher gamma-adjusted
> parametric quantile".
> Status: **shipped** as the `cornishFisher` result of `bookVaR` in `packages/risk/src/book-var.ts`,
> covered by `packages/risk/test/book-var.test.ts`, full CI green.

## Goal

`bookVaR` reports two numbers: a **parametric** (delta-normal) VaR — fast but linear, so it _ignores gamma_
and understates the tail of a convex book — and a **Monte-Carlo** (delta-gamma-exact) VaR — accurate but
sampled. The gap between them is the gamma convexity. A **Cornish-Fisher** expansion fills it analytically:
it adjusts the normal quantile for the **skewness and excess kurtosis** the gamma induces, giving a
closed-form gamma-aware VaR that tracks the Monte-Carlo (to ~0.1 % for a normal-ish book) without sampling
— the best-of-both third number.

## The construction

The horizonPeriods P&L of a delta-gamma book is a **quadratic form in the spot shocks** (plus an independent vega
term and a deterministic theta drift):

```
ΔV = Σᵢ [δᵢ·dSᵢ + ½γᵢ·dSᵢ²] + Σᵢ vegaᵢ·dσᵢ + Σᵢ θᵢ·h      dS ~ N(0, Σ_S),  dσ ⟂ dS
```

Its cumulants have **closed forms** in `Σ_S`, the delta vector `δ`, and the (diagonal) gamma `Γ` — no
eigendecomposition, robust to a singular covariance (`M ≡ ΓΣ_S`):

```
κ₁ = ½·tr(M) + Σθᵢ·h                               (the parametric mean drift)
κ₂ = δᵀΣ_Sδ + ½·tr(M²) + Σvegaᵢ²·Var(dσᵢ)          (delta-normal variance + gamma variance + vega)
κ₃ = 3·δᵀΣ_SΓΣ_Sδ + tr(M³)                          (skewness numerator — gamma tilts the P&L)
κ₄ = 12·δᵀΣ_SΓΣ_SΓΣ_Sδ + 3·tr(M⁴)                   (excess-kurtosis numerator)
```

giving skewness `S = κ₃/κ₂^{3/2}` and excess kurtosis `K = κ₄/κ₂²`. The **Cornish-Fisher** quantile at
tail probability `α` (`z_α = Φ⁻¹(α)`) is

```
q(z_α) = z_α + (z_α²−1)/6·S + (z_α³−3z_α)/24·K − (2z_α³−5z_α)/36·S²
VaR    = max(0, −(κ₁ + √κ₂·q(z_α)))
```

with a **closed-form CVaR** (the tail-average of `q`) reducing to the normal ES when `S = K = 0`.
_Verified: for a normal-ish book the CF VaR matches the Monte-Carlo delta-gamma VaR to ~0.1 % at 95 % and
99 % — strictly better than the delta-normal — while reducing to it exactly at zero gamma._

## The honest part: the domain gate

Cornish-Fisher is an **asymptotic expansion** — it is only a valid (monotone) quantile transformation for
**mild** non-normality. A nearly-pure-gamma book (a straddle with `δ ≈ 0`) is essentially a scaled `χ²`
with `S ≈ ±2.8`, where the CF quantile function _folds back on itself_ and returns nonsense (a negative
"VaR") — CF genuinely cannot price such a book, so it must not pretend to. The expansion is therefore gated
on the **monotonicity of its quantile map over the tail region actually used**: with `a = S/6`, `b = K/24`,
`q'(z) = (3b−6a²)z² + 2a·z + (1−3b+5a²)` must stay `> 0` across `[z_low, −z_low]`, where `z_low` reaches a
deep `1e-4` tail (covering the VaR point and the ES integration region). This tail test is essential: a
_global_ `∀z` test wrongly rejects even mild skew (`S ≈ −0.3`), because `3b−6a²` dips slightly negative
there and `q'` bends down only at `z → ±∞`, far outside the tail. When the tail test holds, `cornishFisher`
is populated; when it doesn't, it is **omitted** and a `risk.cornish_fisher_out_of_domain` warning
(carrying the skewness/kurtosis) directs the caller to the exact `monteCarlo` VaR. The feature never
returns a misleading number.

## API

Additive to `bookVaR` — a new optional result field, present only when the parametric path runs and the CF
expansion is in-domain:

```ts
interface BookVaRMethodResult {
  valueAtRisk: number;
  conditionalValueAtRisk: number;
  pnlMean: number;
  pnlStandardDeviation: number;
  /** Populated on the `cornishFisher` result: the P&L skewness / excess kurtosis the gamma induces. */
  skewness?: number;
  excessKurtosis?: number;
}
interface BookVaRResult {
  parametric?: BookVaRMethodResult; // delta-normal (linear)
  cornishFisher?: BookVaRMethodResult; // delta-gamma, analytic (this spec) — omitted when out-of-domain
  monteCarlo?: BookVaRMethodResult; // delta-gamma, sampled
  // …unchanged…
}
```

## Honesty / envelope contract

- **Omitted, never wrong** — `cornishFisher` is present only when the CF expansion is a valid quantile
  transform; otherwise a typed `risk.cornish_fisher_out_of_domain` warning points to the Monte-Carlo.
- **Same model as the MC** — the cumulants use the identical shock model the `monteCarlo` path samples
  (correlated `dS`, independent `dσ`, theta drift), so the two are directly comparable.
- **Moments disclosed** — the CF result carries the P&L `skewness` and `excessKurtosis` that drive it.
- **Floors consistent with `parametric`** — VaR/CVaR are `≥ 0` loss magnitudes; `pnlMean` (drift) is
  disclosed, not hidden.

## Build checklist

1. **Cumulants** — `κ₁…κ₄` via the trace formulas over `Σ_S` / `Γ` (add a small `matmul`; reuse `covDelta`).
2. **Domain gate** — `q'(z) > 0` across the tail interval `[z_low, −z_low]` (the analytic min of the
   quadratic over the interval), NOT a global `∀z` test (which over-rejects mild skew).
3. **CF VaR + CVaR** — the quantile expansion and its closed-form tail average; floor at 0.
4. **Wire** — populate `cornishFisher` when `method !== 'monteCarlo'` and in-domain; else the warning;
   handle the empty book; add `skewness`/`excessKurtosis` optional fields.
5. **Tests** — CF ≈ MC for a moderate book; the out-of-domain warning + omission for a convex book; the
   zero-gamma reduction to delta-normal; empty book; the disclosed moments; guards unchanged.

## Deferred (explicitly)

- **A rate factor and spot–vol (leverage) correlation** in the shock model (bookVaR follow-ups) — the CF
  cumulants would extend to them.
- **Saddlepoint / Imhof exact quadratic-form VaR** for the out-of-domain (very convex) regime, as an
  analytic alternative to the Monte-Carlo.
- **Higher-order (vanna/vomma) cross terms** in the P&L expansion.
