# Bjerksund–Stensland low-volatility stability

Status: A–F and H–I verified locally. G (full local CI, packed consumer, hosted checks, review) is pending on the PR. Tracked in [issue #37](https://github.com/InsiderFinance/totalfinance/issues/37).
Base: `main` at `90fd7f9`. No options, math or core source has changed there since
`totalfinance-v0.1.6`. This bounded correctness contract was written before the regression fixtures
were committed. It was checked against alignment laws 7, 13, 14 and 15 and against `CONTRIBUTING.md`.

## Outcome and boundaries

`engines.bjerksundStensland2002()` (alias `bjerksundStensland()`) and `bjerksundStensland1993()`
return finite, accurate prices for valid inputs, including the low-volatility, far-boundary and
near-`b = r` regimes that currently fail. The one range condition is that the call-form exercise
boundary at expiry, `B0 = K·max(1, r/(r − b))`, is representable in binary64. Beyond that the value
is non-finite and the existing postcondition refuses it, so no wrong number is returned. This was
tested at monetary scales from 1e-300 to 1e300. The
finite-difference Greeks of the shared engine factory resolve short-expiry and low-volatility
contracts, where the fixed spot bump was wider than the distribution. The published model, its
terms, the put–call transformation, the `max(approximation, intrinsic, European)` floor, the
`b ≥ r` European branch, the existing no-arbitrage postcondition, Greek units, explicit step
controls, result shapes, names and metadata are all unchanged. Ordinary prices agree with the
previous implementation to rounding. Bumps change only where a coordinate's natural scale is
narrow (decision 4 lists the exact conditions).

There are three kinds of change:

1. The numerical price change (decisions 1–3) is confined to
   `packages/options/src/engines/american-approx.ts`.
2. The shared finite-difference step policy (decisions 4 and 8) lives in
   `packages/options/src/engines/fd-greeks.ts`, used by the American engine factory
   (`engine-factory.ts`). It sets scale-aware default bumps and differences on the exercise branch
   that holds the base point. Monte Carlo (`monte-carlo.ts`) keeps its previous bumps through the
   explicitly named `referenceFdSteps`. Two price-only internal calls request no Greeks: the American
   IV inversion's repricing (`american-iv.ts`) and the `compareEngines` reference value
   (`engines.ts`).
3. One additive failure check (decision 7), in `engine-factory.ts`, refuses a non-finite Greek that
   was previously returned silently.

Non-goals: no new public export, parameter normalization, clamp, European or lattice substitution,
or relaxed postcondition. Model-specific bump rules (SABR, Heston's first-order set, exotics) stay
with their owners. No dependency is added and no transport computes anything. Barone–Adesi–Whaley, the lattices and `touchProbability` (#15, the same defect
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
   identities, not limits. The paper's ratios of products (`K²/((B∞ − B0)·B0)`, `I2²/(S·I1)`,
   `S·I1²/(H·I2²)`) are formed as products of scale-free ratios. The products themselves overflowed
   above a spot near 1e103 and underflowed below 1e-148.
3. **Exact regimes stay exact.** The `b ≥ r` European branch, the early-exercise branch
   `S ≥ I → S − K`, the floor and every existing postcondition are untouched; decision 7 adds one
   check separately. A genuinely unrepresentable result still fails the existing postcondition,
   with no clamp.
4. **Scale-aware default bumps (supersedes P2.3's σ/4 and T/4 rules).** Every default bump is its
   previous reference value, capped at a hundredth of the coordinate's natural scale:
   - spot `S·min(1e-3, max(1e-8, σ√T/100))`, on the scale of the terminal standard deviation S·σ√T;
   - volatility `min(1e-3, σ/100)`;
   - time `min(ceiling, T/100)`, with ceiling 1e-4 for first-order theta and 1e-3 for the extended
     set;
   - rate `min(1e-4, (σ/√T)/100)` and carry `min(1e-5, (σ/√T)/100)`, because the drift moves the
     distribution one standard deviation per σ/√T.

   Derivation: central differences have truncation h²/6·f‴ (first derivative) and h²/12·f⁗
   (second). On the coordinate's own scale L, that is about (h/L)²/6 and (h/L)²/12 of the Greek, so
   h = L/100 gives about 1e-5. Rounding adds about ε/h and 4ε/h², with ε ≈ 1e-15·(S + K) for these
   engines. That stays below 1e-6 of an at-the-money gamma down to σ√T ≈ 1e-5. The 1e-8 relative spot
   floor (≈ √ε) binds only at an essentially deterministic σ√T < 1e-6.

   A bump keeps its exact previous value unless its cap binds:
   - spot when σ√T < 0.1;
   - volatility when σ < 10%;
   - first-order time when T < 0.01 years (extended set: T < 0.1);
   - rate when σ/√T < 0.01, and carry when σ/√T < 0.001.

   The extended (higher-order) set uses the same rule. Monte Carlo keeps the previous fixed policy
   (`referenceFdSteps`): common-random-number differences are variance-limited, because a second
   difference across the payoff kink has variance ∝ 1/h. Measured over 12 seeds × 20,000 paths, the
   scale-aware bump would have doubled the gamma error at 30 days and 10% vol (2.2% → 4.7% RMS),
   though it removed the one-day 1%-vol bias (21% → 6.8%). The right Monte-Carlo bump depends on the
   path count, so that is a separate decision. Units are unchanged (theta per calendar day, vega per vol point, rho per
   1%). Explicit steps and the lattices' `rateStepFloor` still win. Shift-mode callers (σ = 0) keep
   the fixed spot, rate and carry references. Bumps stay disclosed in
   `diagnostics.finiteDifferenceBumps`. The rule `σ − h > 0, T − h > 0` still holds.

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
   Internal callers that need only a price (the American IV inversion and the `compareEngines`
   reference) now request no Greeks, so a price never depends on Greek success.
   After decisions 1–3, a 2,160-case scan found no non-finite Greek from Bjerksund–Stensland 2002 or
   1993, Barone–Adesi–Whaley, Leisen–Reimer, CRR or the trinomial lattice, so the check changes no
   successful result. Crank–Nicolson's scan did not finish within its time window, though its suites
   pass. The check turns any future silent NaN into a typed refusal.
8. **Exercise-branch differencing.** An American value equals its exercise value exactly in the
   exercise region, and is not twice differentiable where the regions meet. The closed forms are
   not always even once differentiable there. A central stencil straddling that switch returns a
   secant slope and a curvature of about (slope jump)/h, which grows as h shrinks. So when exactly
   one neighbour lies on the other branch, the factory differences one-sided, on the base point's
   branch, with second-order stencils `(−3V₀ + 4V₁ − V₂)/(2h)` and `(2V₀ − 5V₁ + 4V₂ − V₃)/h²`. That
   costs two extra evaluations, only in that band. It applies to every bumped coordinate (spot,
   volatility, time, rate) of the first-order set. The branch is read from exact equality with a
   positive exercise value, which every American engine returns verbatim. An exercised base thus
   reports the exercise value's own derivatives (spot slope ±1, zero curvature, zero vega, theta and
   rho). Stencils within one branch are exactly the central difference. Two cases are not handled.
   First, the extended (higher-order) set keeps plain central stencils. Second, a kink that is not an
   exercise switch, such as the floor's European branch in the degenerate regime of residual 1, is
   not detectable this way and stays a secant within one bump.

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
- [x] F. Changed files are formatted and linted, and the repository typecheck passes. The ordered
      regeneration chain produces no contract churn (`summary.defective` 0), and the measured bundle
      budgets pass.
- [x] H. Scale-aware default bumps (decision 4) in the shared resolver used by the American engine
      factory. Monte Carlo keeps the reference policy, and its Greeks are byte-identical. The policy
      tests (`fd-adaptive-bumps.test.ts`) follow the new rule, and a Jarrow–Rudd test shows the rate
      floor still overrides. 66 exact European-equivalent references (mpmath BSM derivatives) pass
      across BS2002, BS1993, BAW and Leisen–Reimer, including the one-day 1%-vol call, which moves
      from −6.4%/−21% to 2.8e-6/7.7e-6.
- [x] I. Exercise-branch differencing (decision 8), with exact branch references on both sides of
      BS2002's boundary and a demonstration that the central secant is the artifact.
- G (post-commit, owned by the PR): full local `pnpm run ci`, the build and the packed
  installed-consumer journey (with exit codes), a private packed SDK artifact for downstream
  validation, exact-head hosted PR checks, and an independent adversarial review. No merge, version
  bump or publication.

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
  - All 12,972 grid prices, measured at source commit `6329802` (later commits change only
    documentation): worst error 5.6e-16·(S + K). The engine was re-dumped at that commit and
    compared with the stored 30-digit references. An earlier revision, which still took `ln Φ` from
    `normalCdf`, measured 5.7e-15·(S + K) against the same references.
  - A dense raw (unfloored) stress grid of 10,944 evaluations (σ 0.2–2%, spot every 2% of strike,
    six rate/carry pairs, three maturities): all finite, worst error 4.9e-15·(S + K).
  - Committed goldens (7 published anchors, 196 raw and floored cases in both forms, 1,932 grid rows)
    all pass within 5e-14·(S + K).
- **Ordinary results.** On the 12,160 grid cases the base already handled, prices move by at most
  5.7e-15·(S + K). The moves are corrections: the largest is where the base's West-tail error was
  5.6e-15·(S + K), and one base rho was off its exact stencil by 9.3e-10 (now 6.2e-13).
- **Greeks.** Measured with the scale-aware bumps of decision 4.
  - Against the exact evaluation of the engine's own stencil (one straddling coordinate excluded),
    the worst floating-point error is delta 3.2e-11, gamma 1.4e-7, theta 7e-13, vega 9e-13 and
    rho 3.5e-12. The gamma figure is the expected 4ε/h² at h ≈ 5e-4, about 2e-8 of that gamma.
  - Against the true derivatives, normalized by each Greek's at-the-money magnitude, the worst case
    across the 14 BS2002 cases, the 66 exact European-equivalent cases (BS2002, BS1993 and BAW
    alike) and the four exercise-boundary cases is: delta 4.3e-6, gamma 8.3e-6, theta 1.25e-5, vega
    2.0e-5, rho 7e-7. Leisen–Reimer at 801 steps reaches 4.6e-5 on gamma and 5.2e-4 on rho, which is
    lattice discretization.
  - The one-day, 1%-vol, no-dividend at-the-money call (analytic delta 0.60332913, gamma 7.36467588)
    moves from −6.44% and −21.01% at the old 0.1 spot bump to −2.8e-6 and −7.7e-6. Theta moves from
    +9.1e-5 to +6.9e-6 and vega from −3.4e-4 to −3.4e-6. Rho is unchanged at −7.9e-9.
  - On the same European-equivalent probes, the extended Greeks (still central stencils) drop from
    worst relative errors of 84% (speed), 83% (vanna), 52% (color and zomma) and 10% (charm) to at
    most 0.3% (vera, on an ordinary one-year 5%-vol case that was 1.2% before).
- **Kernels.** 120 weighted bivariate terms with the arguments BS2002 actually produces (weights up
  to e^1290): worst error 2.2e-16 on O(1) terms. `ln Φ` is within 1.6 ulp. In exact arithmetic the
  20-point rule's own error on these arguments is at most 5.5e-17.
- **Model error versus evaluation error.** Against Leisen–Reimer lattices (2001 and 4001 steps,
  which differ by at most 5.8e-4) on the 960 low-volatility near-the-money grid cases, BS2002 never
  exceeds the lattice. That is the lower-bound property. 90 of 643 cases worth more than 0.01
  underprice by more than 1%, and 32 by more than 90% (see residual 1). At ordinary volatility,
  2002 is 0.3–1.8% below the lattice and closer than 1993.
- **Surface and gates.** The ordered regeneration chain changes only `docs/bundle-size.md`, the docs
  inventory entry for this spec, and `docs/llms-full.txt`, which carries the updated
  `finiteDifferenceBumps` field description. `summary.defective` is 0. All bundle figures are gzip,
  measured on the canonical Node 22.23.2 / esbuild 0.25.12, one change at a time against base.
  - Umbrella: 732,903 → 734,105 B (+1,202 B). The price kernel accounts for +832 B (including the
    scale-free boundary ratios) and the finite-Greek check for +21 B. The shared step resolver, with
    Monte Carlo's reference policy and the branch-aware helper, adds +113 B. Exercise-branch
    differencing in the factory adds +238 B, and the price-only internal calls +1 B.
  - Workflows: 521,707 → 521,762 B (+55 B), all of it the shared resolver that Monte-Carlo Greeks
    use.
  - Following CONTRIBUTING's rule (raise a bound only from a measurement, and say where it came
    from), the umbrella ceiling rises 716 → 717 KiB (103 B headroom). The workflows ceiling rises
    509.5 → 509.625 KiB (94 B headroom). Every other budget and every structural exclusion is
    unchanged.
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
2. **Finite-difference limits.** Truncation at the scale-aware bumps is about 1e-5 of each Greek's
   at-the-money magnitude. Measured against exact derivatives, the worst is 2e-5 for the closed forms
   and 5e-4 for Leisen–Reimer rho, which is lattice discretization. Within one bump of a non-exercise
   kink (the floor's European branch in residual 1's regime, or a put's rate exactly at r = 0, the
   model's own regime switch), a stencil is still a secant. The extended Greeks keep central
   stencils; at short expiry they improve from errors of up to 84% to at most 0.3%. Model-specific
   bump rules (SABR α/4, Heston's first-order set, exotics) are separate follow-ups.
3. **Adjacent precision (follow-ups, out of scope).** The public `normalCdf` is accurate in absolute
   but not relative terms below −2 (9e-9 relative near −8), and `normalLogCdf` uses a 1e-10
   five-term series below −20. Deep out-of-the-money European values inherit this (for example, a
   1e-8 relative error on a 1.3e-15 put). `touchProbability` (#15) has the same overflow × underflow
   class.
4. **Range.** The call-form boundary `B0 = K·max(1, r/(r − b))` must be representable. Near
   `b = r` at a huge spot it is not (for example, ×1e300 with r − b = 1e-10). There the value is
   non-finite and the postcondition refuses it. σ² must be a normal binary64 number (σ above about
   1.5e-154).
5. **Conditioning near the exercise boundary at very low volatility.** The price there is sensitive
   to input rounding at about ε·S/(σ√T), a property of the problem rather than of this evaluation.
   The price tolerance 5e-14·(S + K) is verified for σ ≥ 1e-3. An independent review measured
   near-boundary errors of 1.1e-14·(S + K) at σ = 1e-3, 7.5e-14 (2002) and 1.2e-13 (1993) at
   σ = 1e-4, and 6.5e-13 at σ = 1e-5, all below that input sensitivity.
6. **Monte Carlo** keeps its previous Greek bumps (decision 4); a variance-aware rule that depends on
   the path count is a follow-up.
