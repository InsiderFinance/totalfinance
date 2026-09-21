# Spec — The full higher-order greek set for every options model (`@totalfinance/options`)

> User request: "do all our options models calculate all of these values?" → "implement everything for all
> options models." Parity target: the 16-greek set (delta, gamma, theta, vega, rho, **phi/ε**, vanna,
> vomma, charm, **zomma**, color, speed, **veta**, **vera**, **ultima**, **lambda**).
> Status (this spec): **complete — every options model computes the full 16-greek set.** The 6 missing
> greeks were added to `blackScholesExtendedGreeks` + new `black76ExtendedGreeks` / `bachelierExtendedGreeks`
> (commit 1); `option.price(..., { extendedGreeks: true })` returns the exact analytic set on the
> closed-form engines and the full set by a shared finite-difference helper on the **American / lattice /
> PDE** engines (Bjerksund–Stensland 1993/2002, binomial, trinomial, BAW, Crank–Nicolson) (commit 2); and
> the **stochastic** engines (Heston, SABR, Monte-Carlo) return the full set by the same helper driven by a
> model-appropriate vol-level closure (commit 3).

## The gap

`blackScholesExtendedGreeks` computed 10 of the 16 (delta…rho + vanna, charm, vomma, speed, color); **Black-76 and
Bachelier had no extended-greek function at all**. The six missing everywhere:

| greek        | meaning                 | definition            |
| ------------ | ----------------------- | --------------------- |
| `phi` (ε)    | dividend rho            | `∂V/∂q`               |
| `zomma`      | gamma's vol sensitivity | `∂Γ/∂σ = ∂³V/∂S²∂σ`   |
| `veta`       | vega's decay            | `∂vega/∂T`            |
| `vera`       | rho's vol sensitivity   | `∂rho/∂σ = ∂²V/∂r∂σ`  |
| `ultima`     | vomma's vol sensitivity | `∂vomma/∂σ = ∂³V/∂σ³` |
| `lambda` (Λ) | elasticity / leverage   | `Δ·S / V`             |

## Conventions (decided, documented)

- **First-order units unchanged** — delta/gamma raw, vega/1%, theta/day, rho/1%. `phi` is a first-order
  sensitivity (peer of rho), so it is stored **per 1% dividend yield** (÷100), matching rho and the
  market convention.
- **Higher-order greeks are raw** — `zomma/veta/vera/ultima` join the existing raw `vanna/vomma/charm/
speed/color` (per 1.00 σ, per year of time-to-expiry). Time-derivatives use **∂/∂T** (time-to-expiry) to
  match the existing `charm`/`color`, i.e. `veta = −∂vega/∂t_calendar`.
- **`lambda` is dimensionless** (`Δ·S/V`; for the forward models, `Δ·F/V`).
- **`ExtendedGreeks`** (the type) gains the six fields; the only producers are the three `*ExtendedGreeks`
  functions (+ their `blackScholes`/`black76`/`bachelier` `extendedGreeks` facades), so the change is contained.

## Per-model implementation

- **BSM** (`blackScholesExtendedGreeks`, lognormal) — closed forms:
  `phi = ∓S·T·e^{−qT}·N(±d1)/100`, `zomma = Γ(d1d2−1)/σ`,
  `veta = −vega·(q + (r−q)d1/(σ√T) − (1+d1d2)/2T)`, `vera = −K·T·e^{−rT}·φ(d2)·d1/σ`,
  `ultima = −(vega/σ²)·(d1d2(1−d1d2) + d1² + d2²)`, `lambda = Δ·S/V`.
- **Black-76** (`black76ExtendedGreeks`, forward/lognormal) — the forward-price derivatives (vanna, charm,
  vomma, speed, color, zomma, veta, ultima) **coincide with BSM at `S=F, q=r`** (identical `d1/d2` and
  discount), so they are borrowed from `blackScholesExtendedGreeks`; the model-specific ones are
  `vera = −T·vega` (since Black-76 `rho = −T·price`), `phi = 0` (no dividend yield), `lambda = Δ·F/V`.
- **Bachelier** (`bachelierExtendedGreeks`, normal/arithmetic-BM) — its own formulas on `d = (F−K)/(σ_N√T)`
  (vega and the σ-derivatives are per 1.00 of **normal** vol): `vanna = −e^{−rT}φ(d)d/σ_N`,
  `vomma = e^{−rT}√T d²φ/σ_N`, `speed = −e^{−rT}dφ/sd²`, `zomma = Γ(d²−1)/σ_N`,
  `color = Γ(−r + (d²−1)/2T)`, `veta = e^{−rT}φ(−r√T + (1+d²)/2√T)`, `vera = −T·vega`,
  `ultima = e^{−rT}√T φ(d⁴−3d²)/σ_N²`, `charm = −r·e^{−rT}N(d) − e^{−rT}φd/2T` (put: `+ r·e^{−rT}`),
  `phi = 0`, `lambda = Δ·F/V`.

## Honesty / verification

- **Every greek is verified against a finite difference** of the model's own price / first-order greeks
  (call and put, ITM/ATM/OTM) — the same discipline as the existing `extended-greeks.test.ts`. Before
  implementation: all six new BSM greeks matched FD to ≤3e-7 (veta after the ∂/∂T sign correction, ~6e-11);
  all Bachelier greeks matched to ~1e-7. Put/call parity relations are pinned too (e.g. `ε_put − ε_call =
S·T·e^{−qT}/100`, `vera_put = vera_call`, `lambda` sign flips call↔put).
- **`phi = 0` for the forward models is correct, not a stub** — Black-76/Bachelier price a forward with the
  carry already embedded in `F`, so `∂V/∂q ≡ 0`.
- **Additive & contained** — new fields on `ExtendedGreeks`; new standalone functions + `extendedGreeks`
  facades; existing callers unchanged. First-touch fixtures cover the direct named-input kernels + facade
  methods.

## Commit 2 — the numerical engines via `option.price(..., { extendedGreeks: true })`

A new `PriceOptions.extendedGreeks` flag (implies `greeks`) turns `PriceResult.greeks` from the 5-field
`Greeks` into the full `ExtendedGreeks`:

- **Closed-form engines** (BSM, Black-76) return their **exact analytic** set — `priceContract` /
  `priceBlack76Contract` thread the flag to `blackScholesExtendedGreeks` / `black76ExtendedGreeks`.
- **American / lattice / PDE engines** (all built through `engine-factory.ts`) return the full set by a
  shared **`finiteDifferenceExtendedGreeks(price, spotAt, state)`** helper (`engines/fd-greeks.ts`) — central
  differences of the engine's own price, **re-escrowing the spot** on every rate/time bump (matching the
  first-order `theta`/`rho`), so discrete-dividend Greeks stay consistent. This covers Bjerksund-Stensland
  1993/2002, binomial (CRR / Leisen-Reimer), trinomial, Barone-Adesi-Whaley, and Crank-Nicolson.

Verified: the FD helper reproduces `blackScholesExtendedGreeks` (via a BSM price closure) to ~1e-5 second-order /
~5e-5 third-order; through the pro API, the analytic engines match their closed form to machine precision, a
European Leisen-Reimer lattice converges to the BSM analytic set (first-order ~1e-3, second-order ~1–5%,
third-order sign-correct), and Bjerksund-Stensland returns a finite, sane full set. The `greeks` field is
`Greeks | ExtendedGreeks`; without the flag the fast 5-greek path is byte-unchanged.

## Commit 3 — the stochastic engines via a vol-level closure

**Heston, SABR, and Monte-Carlo** also return the full set through `option.price(..., { extendedGreeks: true })`
(each engine's option type gains an `extendedGreeks` flag; the pro wrappers thread it). The shared FD helper is
driven by a **model-appropriate scalar closure** — the same idea their first-order `vega` already uses:

- **Heston (COS)** — the "vol level" is `√v₀` (= `√θ` at the base); the closure `price(s, shift, …)` bumps
  `√v₀` and `√θ` together, exactly extending `cosGreeks`' vega convention.
- **SABR (Hagan)** — the vol level is `α`; the closure bumps `α` (threading the rate so `rho`/`vera` are real);
  `phi = 0` (forward model).
- **Monte-Carlo (GBM)** — `σ` is a genuine scalar; the closure re-prices with **common random numbers** (the
  seed is fixed), so the difference stencils are low-variance.

**The verification that overturned a premature "can't be done".** A first attempt tested Heston in the BSM
limit (`vol-of-vol = 1e-3`) and got garbage (`vomma −813` vs 2.4, `ultima 5.3e7`). That is a _degenerate_
regime — the COS characteristic function is ill-conditioned as `vol-of-vol → 0`. At **realistic** parameters
the picture is the opposite: the COS price is accurate (256 vs 1024 terms agree to 6e-13) and the FD extended
greeks are **fully converged** — all 16, including `vomma`/`veta`/`vera`/`ultima`, agree to ~1e-8 across term
counts, so they are the _true model sensitivities_. Cross-checks: **SABR (β=1, ν=0) reproduces the Black-76
analytic extended set to ~5e-3**; **Monte-Carlo (GBM) reproduces the BSM analytic set** to <1% (first/second
order) with the third-order sign-correct (`speed` carries the most MC error — raise `paths` to tighten). The
lesson: _verify the math in a representative regime before concluding it's impossible_ — the degenerate limit
lied.

Nothing is deferred: all closed-form, deterministic-numerical, and stochastic engines now compute the full
16-greek set.
