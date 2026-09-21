# Phase 2 — Numerical foundation and options seriousness

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

0.2 turns `@totalfinance/math` into a serious numerical foundation and uses it to make the options stack
credible: American engines, higher-order Greeks, a full implied-volatility method suite, batch chain
analytics, and an engine-comparison API. Every engine reproduces an external American-option oracle
and converges cross-engine.

## What's new

### `@totalfinance/math`

- **Distributions** — tail-safe `normal.survivalFunction`, `normal.logPdf`, `normal.logCdf`, `normal.logSurvivalFunction`
  (asymptotic far-tail expansion below x = −20), `NaN`/∞ guards on `normalCdf`/`normalInverseCdf`, and the
  cumulative **bivariate** normal `bivariateNormalCdf(a, b, ρ)` (Genz's algorithm, ~1e-15).
- **Numerically-stable stats** — Kahan-compensated summation, Welford online variance, robust
  statistics (MAD, winsorization, trimmed mean), rolling covariance/correlation, and a
  `nanPolicy: 'propagate' | 'omit' | 'throw'`. Covariance/correlation now reject unequal-length series
  instead of silently mixing them.
- **Root solvers** — Newton, Halley, Householder (with derivative diagnostics), Ridder, secant, and a
  hardened Brent/bisection: typed failure reasons, `xTol`/`fTol`/`rTol`, reversed-bracket
  normalization, non-finite-iteration detection, bracket expansion, and a batch `solveAll`.
- **Optimizers** — golden-section and Brent minimization, Nelder–Mead, BFGS (Armijo line search,
  Sherman–Morrison inverse-Hessian updates), and Levenberg–Marquardt for calibration least-squares.
- **Interpolation & linear algebra** — monotone PCHIP, natural cubic spline, bilinear surface
  interpolation (with strict-sorted-axis validation and a duplicate-x aggregation policy), Cholesky
  decomposition/solve, Jacobi eigensolver, and nearest-PSD / nearest-correlation repair.
- **Integration** — adaptive Simpson and cached Gauss–Legendre quadrature.
- **Monte Carlo** — xoshiro128\*\* and mulberry32 PRNGs with serializable state, Sobol (Joe–Kuo) and
  Halton low-discrepancy sequences, antithetic variates, control variates, stratified sampling,
  Brownian bridge, correlated-normal generation, and a generic runner with online mean/variance/
  standard-error/CI and a standard-error stopping rule. No option-payoff logic lives in `math`.

### `@totalfinance/options`

- **American & exotic engines** — Barone–Adesi–Whaley, Bjerksund–Stensland **1993 and 2002** (the
  `bjerksundStensland()` alias resolves to the more accurate 2002 two-boundary form), binomial CRR /
  Jarrow–Rudd / Tian / Leisen–Reimer, trinomial, and a Crank–Nicolson finite-difference engine with
  PSOR for early exercise. Discrete cash dividends via the escrowed-dividend model. First-order Greeks
  by finite differences with engine/method/timing diagnostics.
- **Higher-order Greeks** — analytic, exact `vanna`, `charm`, `vomma`, `speed`, `color`
  (`bsmExtendedGreeks`, `bs.extendedGreeks`), each validated against finite differences of the
  first-order Greeks.
- **Implied-volatility method suite** — `impliedVolatility` with
  `method: 'auto' | 'brent' | 'newton' | 'halley' | 'householder'`, analytic σ-derivatives
  (vega/vomma/d³), Manaster–Koller seeding, honest `fallback`/`failFast`, low-vega and above-bound
  detection, and per-row batch diagnostics that never abort the chain on a bad row. (`'rational'` is
  reserved per spec §9.5 and not exposed until a faithful Jäckel inversion lands — never aliased.)
- **`option.compareEngines`** — prices a contract across the engine panel and reports each engine's
  value, Greeks, convergence, timing, and signed deviation from a high-resolution reference, sorted
  most-accurate first. No silent "best" pick — every number is shown with its diagnostics.
- **Batch chain IV** — `bsmImpliedVolMany`, a columnar struct-of-arrays kernel that inverts an option
  chain and reports per-row convergence + machine-readable failure reasons (never a fabricated value).

### `@totalfinance/mcp`

- Output schemas for every tool, per-tool input/output schema resources, compact JSON alongside
  `structuredContent`, **enforced** read-only mode (mutating tools are filtered out, not just
  documented), row/path/iteration/deadline budgets, and required-and-echoed seeds for stochastic tools.

## Quality

- **External oracle** — every lattice/FDM engine reproduces the canonical Longstaff–Schwartz (2001)
  American-put benchmark (S=K=40, r=6%, σ=20%, T=1 → accurate value **2.3196**) to two decimals;
  closed-form approximations land within their documented tolerances.
- Cross-engine agreement and monotone step-refinement convergence tests; FD-verified higher-order
  Greeks; IV round-trip tests for every exposed method; deterministic Monte Carlo with seed echo and a
  variance-reduction benchmark; solver/optimizer property tests (reversed brackets, no sign change,
  zero derivative, non-finite iteration, max-iteration).
- Full CI green: **337 tests**, strict TypeScript, ESLint package boundaries, composite build, bundle
  budgets, and committed public API reports for all packages.
- Line coverage **89%** (statements 88%, functions 86%, branches 73%) via `pnpm test:coverage`
  (istanbul); the option engines added this milestone are at **98%** lines. 9 suites are
  property-based (fast-check).

## Bundle sizes (gzip)

`black-scholes` 3.3 KB · `core` 3.6 KB · `math` (full index) 12.2 KB · `math/normal` 1.1 KB ·
`calendars/nyse` 1.9 KB · `performance/sharpe` 0.9 KB · `ta/rsi` 0.6 KB. The hot path still pulls in
no validator. The full `math` index grew with the Phase 2 numerical foundation (solvers, optimizers,
interpolation, linalg, integration, Monte Carlo, the bivariate normal, and input validation), so its
kitchen-sink budget was raised from 12 KB to 14 KB — but `math` now ships per-feature deep entrypoints
(`@totalfinance/math/normal`, `/solvers`, …) so consumers tree-shake to a fraction of that. See
[bundle-size.md](../bundle-size.md).

## Deferred (honestly)

- **Normalized-Black / lognormal IV transform** — methods solve directly in price space with analytic
  σ-derivatives and Manaster–Koller seeding (well-conditioned in practice); a dedicated normalized
  representation is a future conditioning refinement.
- **Jäckel "Let's Be Rational" exact rational-cubic** — not implemented, so per spec §9.5 the
  `'rational'` method name is reserved and **not exposed** (we never alias it to another solver).

## Next (Phase 3)

Market structure and volatility: vol surfaces (SABR/SVI), term structure, and option-chain structure
analytics built on the Phase 2 numerical primitives.
