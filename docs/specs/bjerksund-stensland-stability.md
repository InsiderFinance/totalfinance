# Bjerksund–Stensland low-volatility stability

Status: C–F verified locally; G (hosted checks, full CI, review) pending. Tracked in [issue #37](https://github.com/InsiderFinance/totalfinance/issues/37).
Base: `main` at `90fd7f9`. No options, math or core source has changed there since
`totalfinance-v0.1.6`. This bounded correctness contract was written before the regression fixtures
were committed. It was checked against alignment laws 7, 13, 14 and 15 and against `CONTRIBUTING.md`.

## Outcome and boundaries

`engines.bjerksundStensland2002()` (alias `bjerksundStensland()`) and `bjerksundStensland1993()`
return finite, accurate prices and finite-difference Greeks for every valid input whose model value
is representable. This includes the low-volatility, far-boundary and near-`b = r` regimes that
currently fail. The published model, its terms, the put–call transformation, the
`max(approximation, intrinsic, European)` floor, the `b ≥ r` European branch, the no-arbitrage
postcondition, Greek units and finite-difference bumps, result shapes, names and metadata are all
unchanged. Ordinary inputs agree with the previous implementation to rounding.

Non-goals: no new public export, parameter normalization, clamp, European or lattice substitution,
relaxed postcondition, or change to the bump policy. No dependency is added and no transport
computes anything. Barone–Adesi–Whaley, the lattices and `touchProbability` (#15, the same defect
class in a different function) are out of scope. So are versioning, publication and deployment.

## Reproductions (synthetic)

- Call and put, S = K = 100, T = 1/365, r = 5%, q = 1%, σ = 1%, through the public engine with
  `greeks: true`. Both throw `engine.result_out_of_bounds` for a NaN price.
- Put, S = 140, K = 100, T = 0.5, r = 0, q = 12%, σ = 5%. The price is 1.33e-15, but `rho` is NaN
  because the r + 1e-4 bump prices to NaN.
- A 972-case boundary grid and a 12,000-case rate/yield/volatility/moneyness/maturity grid fail
  66 and 746 cases. Failures are thrown NaN prices or non-finite rho/vega, at σ ∈ {0.1%, 1%, 5%}.

## Root cause

Each φ/Ψ term multiplies a reflection power `(I/S)^κ`, where `κ = 2μ/σ²` and `μ = b + (γ − ½)σ²`, by
a normal or bivariate-normal tail. The product is a bounded reflection probability. At low σ, or
with a boundary far from the spot, the power overflows to Infinity while the tail underflows to 0,
which gives `NaN`. `α = (I − K)·I^{−β}` is likewise formed apart from `S^β`. Separately, `β − 1`,
`B∞ − B0` and `1 − e^{h}` subtract nearly equal numbers as σ → 0 or b → r. The floor's `Math.max`
propagates the NaN correctly, and the postcondition refuses it.

## Decisions

1. **Log-domain products at the source.** Every φ bracket term and Ψ bivariate term is evaluated as
   `e^{logWeight + κ·ln(ratio) + ln(probability)}`. The tail must then be RELATIVELY accurate.
   `normalCdf` (West 2009) is, for x ≥ −2. Further left it is accurate only in absolute terms (5e-11
   relative at −5, 9e-9 near −8), so `ln Φ` takes the Mills ratio from its continued fraction
   (DLMF 7.9.3), with `⌈320/z²⌉ + 8` backward-recurrence levels seeded by the fraction's asymptotic
   tail. The bivariate tail folds the log
   weight into every exponent of the same Genz Gauss–Legendre rule that `bivariateNormalCdf` uses,
   including its rounding clamps; a non-finite sum is never clamped. `αⱼ·S^β` becomes
   `(Iⱼ − K)·e^{β·ln(S/Iⱼ)}`, with the λ factor exactly 1 (λ(γ = β) = 0 is β's defining equation).
   Terms and their order are the paper's.
2. **Cancellation-free boundary algebra.** `u = β − 1` is the positive root of
   `½σ²u² + (½σ² + b)u − (r − b) = 0`, taken in whichever algebraic form avoids subtraction.
   `B0 − K = max(b, 0)·K/(r − b)`. `B∞ − B0` is `K/u` for b ≤ 0 and `Kσ²(1 + u)/(2(r − b))` for b > 0,
   which follows from the quadratic. `Iⱼ − K = (B0 − K) + (B∞ − B0)·(−expm1(h))`. These are exact
   identities, not limits.
3. **Exact regimes stay exact; nothing else changes.** The `b ≥ r` European branch, the early-exercise
   branch `S ≥ I → S − K`, the floor and every postcondition are untouched. A genuinely unrepresentable
   result still fails the existing postcondition, with no clamp.
4. **Greek semantics unchanged.** Bumps (S·1e-3, min(1e-3, σ/4), min(1e-4, T/4), 1e-4) and units
   (theta per calendar day, vega per vol point, rho per 1%) are preserved. Where the coarse default
   bump does not resolve a very low σ√T, the stencil's truncation error is reported rather than
   changed.
5. **Independent evidence.** A term-for-term mpmath evaluation of the published formulas is the
   reference. Its bivariate normal uses cross-checked adaptive quadrature at 30–50 digits. The
   reference reproduces NAG S30QCF and two MathWorks examples first. Greeks are checked against the
   exact evaluation of the engine's own stencil, which isolates floating-point error, and against
   the true derivative, which measures truncation. Converged Leisen–Reimer lattices report the
   model's approximation error separately from evaluation error.
6. **Surface.** The raw (unfloored) approximations and the two kernels are exported only from the
   internal engine module, for the reference tests. Package entrypoints, contracts and generated
   artifacts are unchanged; regeneration must produce no diff. A patch changeset records the
   behavior correction.
7. **Finite Greeks are a postcondition (Law 7).** The shared finite-difference engine factory already
   refuses an out-of-bounds value, but it returned a NaN Greek silently. That is how the second
   reproduction surfaced. Every returned Greek now passes `assertFiniteValue`
   (`postcondition.non_finite_result`); the documented `lambda: null` is not a number and passes.
   After decisions 1–3, a 2,160-case scan found no non-finite Greek from Bjerksund–Stensland 2002 or
   1993, Barone–Adesi–Whaley, Leisen–Reimer, CRR or the trinomial lattice, so the check changes no
   successful result. Crank–Nicolson's scan did not finish within its time window, though its suites
   pass. The check turns any future silent NaN into a typed refusal.

## Ordered checklist

- [x] A. Reproduce both cases and both grids on the base. Diagnose the overflow × underflow and the
      cancellation sources.
- [x] B. Independent reference: published formulas in mpmath. It reproduces NAG 10.3340 and MathWorks
      0.8420/0.1108 and 13.7594/8.4830/4.9451/2.7475.
- [x] C. Stable evaluation for both forms (decisions 1–3, 7). The 17 focused American, engine-contract,
      Greek, IV, chain and exercise suites pass unchanged (446 tests).
- [x] D. Golden fixtures (`tools/golden/generate_bjerksund_stensland.py`) and regression tests: both
      reproductions with Greeks, anchors, raw and floored prices, matrix rows, Greek stencils and
      derivatives, kernels, homogeneity, put–call transformation, the b → r⁻ limit, both grids
      re-run through the public engine, the factory postcondition, and the first-touch/packed
      numerical journey.
- [x] E. Evidence: full-grid reference comparison, a dense raw low-volatility stress grid, the lattice
      model-error table and residual limits, recorded below.
- [ ] F. Format and lint changed files. Typecheck, API reports, clean ordered regeneration (expected
      no-op), measured bundle budgets, build, and a packed consumer journey on a fresh tarball.
- G (post-commit, owned by the PR): exact-head fast PR checks, `pnpm run ci` with the independent
  repeat, and an independent adversarial review. No merge, version or publication.

## Evidence

All values are synthetic. Local receipts are on Node 22.23.2 / esbuild 0.25.12; hosted receipts are
on the PR. Greek units: delta per unit spot, gamma per unit spot², theta per calendar day, vega per
vol point, rho per 1%.

- **Reproductions** (public engine, explicit expiry instants, `greeks: true`):
  - Call S = K = 100, T = 1/365, r = 5%, q = 1%, σ = 1%: 0.02681485528545835 (exact
    0.026814855285463960). Delta 0.5516243, gamma 5.859880, theta −0.01660074, vega 0.02042276,
    rho 0.001596543.
  - Put, same inputs: 0.016546824893630685 (exact 0.016546824893642747). Delta −0.4983820, gamma
    6.722996, theta −0.006519924, vega 0.02005017, rho −0.0008774014.
  - Put S = 140, K = 100, T = 0.5, r = 0, q = 12%, σ = 5%: 1.3313e-15. Rho is −1.5217e-15 and
    matches the exact stencil to 3e-24.
- **Grids.** The 972-case boundary grid and the 12,000-case grid fail 66 and 746 cases on the base
  and 0 and 0 after the fix.
- **Against the reference.**
  - All 12,972 grid prices: worst error 5.6e-16·(S + K).
  - A dense raw (unfloored) stress grid of 10,944 evaluations (σ 0.2–2%, spot every 2% of strike,
    six rate/carry pairs, three maturities): all finite, worst error 4.9e-15·(S + K).
  - Committed goldens (7 published anchors, 196 raw and floored cases in both forms, 1,932 grid rows)
    all pass within 5e-14·(S + K).
- **Ordinary results.** On the 12,160 grid cases the base already handled, prices move by at most
  5.7e-15·(S + K). The moves are corrections: the largest is where the base's West-tail error was
  5.6e-15·(S + K), and one base rho was off its exact stencil by 9.3e-10 (now 6.2e-13).
- **Greeks.** Engine against the exact evaluation of its own stencil, worst case: delta 3.5e-13,
  gamma 1.2e-11, theta 6.5e-13, vega 2.9e-13, rho 3.5e-12. Truncation against the true derivative
  is at most 4e-6 relative in ordinary regimes.
- **Kernels.** 120 weighted bivariate terms with the arguments BS2002 actually produces (weights up
  to e^1290): worst error 2.2e-16 on O(1) terms. `ln Φ` is within 1.6 ulp. In exact arithmetic the
  20-point rule's own error on these arguments is at most 5.5e-17.
- **Model error versus evaluation error.** Against Leisen–Reimer lattices (2001 and 4001 steps,
  which differ by at most 5.8e-4) on the 960 low-volatility near-the-money grid cases, BS2002 never
  exceeds the lattice. That is the lower-bound property. 90 of 643 cases worth more than 0.01
  underprice by more than 1%, and 32 by more than 90% (see residual 1). At ordinary volatility,
  2002 is 0.3–1.8% below the lattice and closer than 1993.
- **Surface and gates.** The ordered regeneration chain changes only `docs/bundle-size.md` and the
  docs inventory entry for this spec, with `summary.defective` 0. The umbrella bundle measures
  732,903 → 733,746 B gzip, so its ceiling rises 716 → 716.875 KiB from that measurement; every
  other budget is unchanged.
- **Cost.** Indicatively, one scalar price takes about 1.4–1.9× as long (interleaved A/B, roughly
  5 → 9 µs). The machine carried a background backup, so this is not a gate.

## Residual limits

1. **Model approximation at low volatility (not a floating-point error).** When
   `b·T + 2σ√T < 0` in the call form (for a put, `(r − q)·T > 2σ√T`), the paper's flat boundary
   lies below B0. The formula then reports immediate exercise, or the floor's European value. For
   example, a put with S = K = 100, T = 0.5, r = 5% and σ = 1% has an exact BS2002 value equal to the
   European 3.54e-5, while the converged lattice gives 0.0368. This fix evaluates the published
   model exactly; it does not change the model. Callers needing American accuracy there should use a
   lattice.
2. **Finite-difference truncation.** The default S·1e-3 spot bump is wide against a one-day, 1%-vol
   distribution (σ√T·S ≈ 0.05): delta truncation is 5–12% and gamma 21%. A stencil that straddles
   the exercise kink or the floor switch is a secant. The bump policy is unchanged.
3. **Adjacent precision (follow-ups, out of scope).** The public `normalCdf` is accurate in absolute
   but not relative terms below −2 (9e-9 relative near −8), and `normalLogCdf` uses a 1e-10
   five-term series below −20. Deep out-of-the-money European values inherit this (for example, a
   1e-8 relative error on a 1.3e-15 put). `touchProbability` (#15) has the same overflow × underflow
   class.
4. **Unexercised extremes.** σ² must be a normal binary64 number (σ above about 1.5e-154).
