# Spec — EVT tail-risk pack (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → _"Tail machinery: EVT (GPD tail fitting), drawdown-at-risk,
> spectral risk measures."_ Status: **shipped** as `fitGeneralizedParetoTail`, `extremeValueTailRisk`, `drawdownAtRisk`, and
> `spectralRisk` in `packages/risk/src/evt.ts`, covered by `packages/risk/test/evt.test.ts`, full CI
> green.

## Goal

Normal and historical VaR **lie about the left tail** — the Gaussian has no fat tail, and the empirical
quantile runs out of data exactly where the risk lives (a 99.5% VaR from 250 days rests on ~1 point).
This is the risk that blows up option sellers. Extreme-value theory gives the principled fix: the
**Pickands–Balkema–de Haan** theorem says exceedances over a high threshold converge to a **Generalized
Pareto Distribution (GPD)** regardless of the parent, so we can fit the _shape of the tail itself_ and
extrapolate past the data. This pack delivers the tail toolkit:

- `fitGeneralizedParetoTail` — peaks-over-threshold GPD fit of the loss tail (robust PWM by default, MLE optional).
- `extremeValueTailRisk` — EVT VaR + Expected Shortfall at extreme confidence, shown **beside** the empirical and
  normal numbers so the fat-tail gap is explicit.
- `drawdownAtRisk` — Drawdown-at-Risk and **Conditional Drawdown-at-Risk** (Chekhlov–Uryasev) from the
  path's underwater curve.
- `spectralRisk` — a coherent **spectral risk measure** (Acerbi) with a risk-aversion spectrum; ES is
  the special case of a flat tail spectrum.

Everything is a pure function of a return series; nothing fetches data.

## The GPD tail model

Work in **loss** units `x = −return`; the tail of interest is the largest losses. Over a high threshold
`u`, the excess `y = x − u | x > u` is modelled `GPD(ξ, β)`:

```
G(y) = 1 − (1 + ξ·y/β)^(−1/ξ)   (ξ ≠ 0),   1 − exp(−y/β)   (ξ = 0),   y ≥ 0, 1 + ξy/β > 0
```

`ξ` is the **tail index** — `ξ > 0` heavy (power-law, e.g. `ξ ≈ 1/ν` for Student-t with `ν` dof),
`ξ = 0` exponential (thin), `ξ < 0` finite right endpoint. `ξ ≥ 1` ⇒ infinite mean (ES undefined);
`ξ ≥ 0.5` ⇒ infinite variance — both are disclosed as warnings.

**Threshold** — `options.threshold` (a loss level) or `options.tailFraction` (default `0.10`): use the worst
`tailFraction` of losses as exceedances, `u` = the `(1 − tailFraction)` empirical quantile of losses.

**Estimators** (`options.method`):

- `'pwm'` (default) — probability-weighted moments (Hosking & Wallis 1987): closed-form, robust, no
  convergence risk. With ascending excess order statistics `y₍₁₎ ≤ … ≤ y₍ₙ₎`,
  `a₀ = mean(y)`, `a₁ = (1/N)·Σ (1 − (i−0.35)/N)·y₍ᵢ₎`, then `ξ = 2 − a₀/(a₀ − 2a₁)`,
  `β = 2·a₀·a₁/(a₀ − 2a₁)`. _(Verified: recovers ξ = 0.3, 0.1, −0.15, 0.0 from a 200k GPD sample.)_
- `'mle'` — maximum likelihood: minimize `N·ln β + (1 + 1/ξ)·Σ ln(1 + ξ·yᵢ/β)` (Nelder–Mead, started
  at the PWM estimate, constrained to `β > 0`, `1 + ξyᵢ/β > 0`). On non-convergence it **falls back to
  PWM** with a disclosed warning — never returns an untrustworthy fit silently.

## EVT VaR / ES (MonteCarloNeil–Frey peaks-over-threshold)

With `N` total losses, `Nu` exceedances over `u`, and the fitted `(ξ, β)`, for a confidence `p` deep
enough to sit in the tail (`1 − p < Nu/N`):

```
VaR_p = u + (β/ξ)·[ ((N/Nu)·(1−p))^(−ξ) − 1 ]          (ξ=0:  u + β·ln( Nu / (N·(1−p)) ))
ES_p  = VaR_p/(1−ξ) + (β − ξ·u)/(1−ξ)   (ξ < 1)        (ξ=0:  VaR_p + β)
```

Both are **positive loss magnitudes** (matching `VaRResult.var`'s convention). _(Verified against the
empirical quantile of a 300k |t₃| sample: VaR₀.₉₉ EVT 5.927 vs empirical 5.893; VaR₀.₉₉₅ 7.564 vs
7.558.)_ If `1 − p ≥ Nu/N` the confidence is **not in the fitted tail** — EVT can't extrapolate there,
so the result carries a warning and reports the empirical quantile instead of a fabricated EVT number.

`extremeValueTailRisk` returns the EVT `var`/`cvar` **and** the empirical and normal (Gaussian) VaR/ES at the
same confidence, plus `tailFatnessRatio = extremeValueVaR / normalVaR`, so "the tail is 1.6× fatter than normal
says" is a number, not a claim.

## Drawdown-at-Risk

From the return series, build the equity curve and its **underwater** series `dₜ = 1 − equityₜ/peakₜ`
(fractional drawdown ≥ 0). Then:

- `DaR_α` (Drawdown-at-Risk) — the `α`-quantile of the drawdown distribution (the depth exceeded only
  `(1−α)` of the time).
- `CDaR_α` (Conditional Drawdown-at-Risk, Chekhlov–Uryasev 2005) — the mean drawdown **beyond** `DaR_α`
  (the ES analogue for drawdowns; `≥ DaR_α`).
- `maxDrawdown` — the worst point on the path, for context (composed from `@totalfinance/performance`).

Deterministic, no simulation. (A bootstrap **max-drawdown** distribution is a documented follow-up.)

## Spectral risk

A **coherent** spectral risk measure `M_φ = Σᵢ φ(pᵢ)·loss₍ᵢ₎·Δp` — a weighted average of loss quantiles
with a non-decreasing weight `φ` on the ascending loss order statistics (more weight on worse
outcomes ⇒ risk-averse & coherent). `spectralRisk` uses Acerbi's **exponential** spectrum
`φ(p) = k·e^(−k(1−p)) / (1 − e^(−k))` with risk-aversion `k > 0` (default 10). ES at level `α` is the
special case `φ(p) = 1/(1−α)·𝟙[p ≥ α]`; the function exposes `{ spectrum: 'expected-shortfall',
alpha }` too, and a self-check that the ES spectrum reproduces `extremeValueTailRisk`'s empirical ES.

## Honesty / envelope contract

- **EVT beside empirical & normal** — never EVT alone; the caller sees all three and the fatness ratio.
- **No extrapolation past the fit** — a confidence outside the fitted tail (`1−p ≥ Nu/N`) yields the
  empirical quantile + a warning, not a fabricated EVT quantile.
- **Undefined moments disclosed** — `ξ ≥ 1` ⇒ ES is `Infinity` with a warning (the mean of the tail
  diverges); `ξ ≥ 0.5` ⇒ an infinite-variance warning; a near-degenerate `a₀ − 2a₁ → 0` in PWM is
  guarded.
- **No absurd fit returned silently** — near-constant exceedances drive the estimator to an implausible
  `|ξ| > 10`; that is disclosed with a `risk.extreme_value_degenerate_fit` warning ("treat the result as
  unusable"), never returned as if it were a real tail.
- **MLE never silently bad** — non-convergence ⇒ PWM fallback + warning; the reported `method` says
  which estimator actually produced the numbers.
- Typed guards (enough exceedances — default ≥ 10, else warn/insufficient; valid confidence/tailFraction/
  method/k; finite returns); pure and deterministic.

## API

```ts
interface GeneralizedParetoFitOptions {
  tailFraction?: number; // worst fraction of losses used as exceedances; default 0.10
  threshold?: number; // explicit loss threshold u (overrides tailFraction)
  method?: 'pwm' | 'mle'; // default 'pwm'
  minExceedances?: number; // default 10; below this, a warning
}
interface GeneralizedParetoFit {
  shape: number; // ξ
  scale: number; // β
  threshold: number; // u (loss units)
  exceedances: number; // Nu
  observationCount: number; // total losses
  tailFraction: number; // Nu / n
  method: 'pwm' | 'mle'; // the estimator that produced the fit
  assumptions: { conventionsVersion: string; estimator: 'pwm' | 'mle' };
  diagnostics: Diagnostics;
}
interface ExtremeValueTailRisk {
  confidence: number;
  valueAtRisk: number; // EVT VaR (positive loss)
  conditionalValueAtRisk: number; // EVT Expected Shortfall
  empirical: { valueAtRisk: number; conditionalValueAtRisk: number };
  normal: { valueAtRisk: number; conditionalValueAtRisk: number };
  tailFatnessRatio: number; // evt.var / normal.var
  fit: GeneralizedParetoFit;
  assumptions: { conventionsVersion: string; confidence: number };
  diagnostics: Diagnostics;
}
interface DrawdownAtRisk {
  confidence: number;
  drawdownAtRisk: number; // DaR_α (fractional, ≥ 0)
  conditionalDrawdownAtRisk: number; // CDaR_α (≥ DaR_α)
  maxDrawdown: number;
  observations: number;
  assumptions: { conventionsVersion: string; confidence: number };
  diagnostics: Diagnostics;
}
interface SpectralRisk {
  value: number; // the spectral risk measure (positive loss)
  spectrum: 'exponential' | 'expected-shortfall';
  riskAversion?: number; // k, for exponential
  alpha?: number; // for the ES spectrum
  assumptions: { conventionsVersion: string };
  diagnostics: Diagnostics;
}
function fitGeneralizedParetoTail(
  returns: ArrayLike<number>,
  opts?: GeneralizedParetoFitOptions,
): GeneralizedParetoFit;
function extremeValueTailRisk(
  returns: ArrayLike<number>,
  opts?: { confidence?: number } & GeneralizedParetoFitOptions,
): ExtremeValueTailRisk;
function drawdownAtRisk(returns: ArrayLike<number>, opts?: { confidence?: number }): DrawdownAtRisk;
function spectralRisk(
  returns: ArrayLike<number>,
  opts?: { riskAversion?: number } | { alpha: number },
): SpectralRisk;
```

## Build checklist

1. **GPD core** — PWM + MLE estimators, threshold selection, degeneracy guards. (The inverse GPD CDF is
   only needed to _simulate_ GPD samples for the tests, so it lives in the test file, not the public
   surface — the VaR/ES read-outs use the closed-form POT formulas directly.)
2. **`fitGeneralizedParetoTail`** — loss conversion, exceedance extraction, fit, `ξ`-warnings, MLE→PWM fallback.
3. **`extremeValueTailRisk`** — the POT VaR/ES formulas; empirical + normal beside; `tailFatnessRatio`;
   out-of-tail confidence → empirical + warning.
4. **`drawdownAtRisk`** — underwater series, `DaR`/`CDaR`, `maxDrawdown` from `@totalfinance/performance`.
5. **`spectralRisk`** — exponential + ES spectra over the loss order statistics.
6. **Exports + API report + READMEs/llms.**
7. **Tests** — PWM & MLE recover a known `(ξ,β)` from a simulated GPD sample; EVT VaR ≈ the empirical
   quantile on a large sample and ≥ the normal VaR on a fat-tailed one; `ES ≥ VaR`; out-of-tail
   confidence falls back with a warning; `ξ ≥ 1` ⇒ infinite ES warning; `CDaR ≥ DaR` and a hand-checked
   drawdown series; the ES-spectrum `spectralRisk` equals the empirical ES; envelope/guards.

## Deferred (explicitly)

- **Threshold diagnostics** — a mean-excess plot / stability-of-`ξ` sweep to _choose_ the threshold
  (v1 takes `tailFraction`/`threshold`).
- **Bootstrap max-drawdown distribution** — a simulated Max-DaR alongside the closed-form CDaR.
- **Multivariate / tail-dependence EVT** — copula tail dependence across underlyings.
- **Return-level / waiting-time** read-outs (the `T`-period expected worst loss).
