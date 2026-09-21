# Phase 5 — Advanced quant & research

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

Phase 5 opens the advanced-quant tier (model-specific Monte Carlo, stochastic-vol models, surface
calibration, exotics, `risk`, `backtest`). The first slice delivered is the **`@totalfinance/risk`**
package — risk & portfolio analytics built purely on `@totalfinance/core` + `@totalfinance/math` +
`@totalfinance/performance`, browser-safe, with the two-shape/validated-input discipline of the rest of
the SDK.

## `@totalfinance/risk` (spec §12.2)

Four pillars, each a focused sub-path import and re-exported from the umbrella entry:

### VaR / CVaR + decomposition (`./var`)

- **VaR** — parametric (Gaussian, with optional **Cornish-Fisher** skew/kurtosis adjustment),
  **historical** (empirical tail quantile), and **Monte-Carlo** (seeded, reproducible). `√`-time
  horizonPeriods scaling.
- **CVaR / expected shortfall** for all three methods; CVaR ≥ VaR by construction. VaR/CVaR are
  reported as **positive loss magnitudes**.
- **Portfolio decomposition** — variance/volatility from weights + covariance, **marginal** and
  **component** VaR (Euler: Σ component VaR = total VaR), percent risk contribution, **diversification
  ratio**, and a correlated-normal **Monte-Carlo portfolio VaR** that converges to the parametric one.

### Stress & scenario testing (`./scenario`)

- Typed **shock** constructors (`spot`/`vol`/`rate`/`time`/custom) parsing `'-5%'`, `'+10pts'`,
  `'+50bp'` or raw numbers.
- **Greeks-Taylor P&L** (`Δ·dS + ½Γ·dS² + Vega·dσ + Θ·timeStepYears + Rho·dr`) with a full **P&L-explain**
  decomposition, a `stressTest` book engine (custom-reprice override supported), and a 2-D
  `scenarioGrid`.

### Factor / PCA exposure (`./factor`)

- `pca` (covariance or standardized correlation) → components sorted by eigenvalue with loadings,
  variance-explained and cumulative; spectral reconstruction `Σ = Σ λ_k v_k v_kᵀ` verified.
- `factorExposure` keeps the top-k components and reports each asset's loading.

### Portfolio optimization (`./optimize`)

- **min-variance**, **max-Sharpe** (tangency), **mean-variance** utility, **risk parity** (equal risk
  contribution via cyclical coordinate descent), **HRP** (López de Prado: correlation-distance
  clustering + recursive bisection), and **Kelly** (full/fractional).
- Constraints: **long-only**, per-asset **bounds**, and **budget** (leverage). Unconstrained problems
  use the analytic `Σ⁻¹` solutions; constrained ones a projected-gradient QP with affine-box
  projection. Verified against KKT optimality conditions, not just self-consistency.

Return/performance metrics (Sharpe, Sortino, Calmar, drawdown, returns) come from
`@totalfinance/performance`, re-exported under the `risk.performance` namespace so `@totalfinance/risk` is the
one-stop umbrella.

**Verification:** 44 tests against closed-form / KKT references (Gaussian VaR/CVaR formulas, Euler
decomposition, tangency & mean-variance optimality, ERC equal-contribution, spectral reconstruction,
Kelly `Σw = μ`). Full `pnpm run ci` green; whole workspace **1,856 → 1,900 tests**.

## Stochastic models, Monte-Carlo & exotics (`@totalfinance/options`, spec §8.6, §9.3)

The second slice opens the model-specific simulation and exotic tier on top of the Phase-2 math
Monte-Carlo primitives. Every pricer is **seeded and echoes its seed**, reports Monte-Carlo error
(`result.monteCarlo.standardError` / `confidenceInterval`), and is **cross-validated against an independent
method** — analytic models against a Monte-Carlo of their own SDE, and exotics against their
closed forms.

### Monte-Carlo / QMC engine (`./monte-carlo`)

- A model-agnostic estimator (`mcEstimate`) with **antithetic variates**, an arbitrary **control
  variate** (correct standard error from the regression residual), and **pseudo or quasi-random**
  sampling (Sobol/Halton + inverse-CDF, optional **Brownian-bridge** dimension ordering; QMC falls
  back to pseudo with a reported warning past the sequence's dimension limit).
- `monteCarloPrice` / `monteCarloEuropean` — GBM European pricing with the discounted terminal as
  control variate and **common-random-number finite-difference Greeks**. Converges to
  Black–Scholes–Merton; also wired in as `engines.monteCarlo({ seed })` (European-only, kept out of
  the `compareEngines` default panel since it is stochastic).

### Stochastic-volatility models (`./heston`, `./sabr`, `./local-volatility`)

- **Heston** — semi-analytic European pricing by the **COS method** (Fang–Oosterlee) on the
  Little-Heston-Trap characteristic function, plus the **Andersen QE** Monte-Carlo scheme; `hestonImpliedVol`
  bridges to a vol surface. Reduces to BSM in the ξ→0 limit and matches QE-MC within MC error.
- **SABR** — Hagan 2002 **lognormal and normal** implied-vol asymptotics priced through Black-76 /
  Bachelier, with an Euler SDE Monte-Carlo validator. Degenerate anchors (β=1,ν=0)⇒α and (β=0,ν=0)⇒α.
- **Local volatility** — **Dupire** extraction (Gatheral total-variance form) from any
  `(strike, t) ⇒ impliedVolatility` function (no dependency on `@totalfinance/vol`), a grid-cached
  `localVolGrid` for fast simulation, and `localVolPriceMC`. A flat surface recovers BSM; a skewed
  surface is reproduced (Dupire's theorem).

### Exotics (`./exotics`)

- **Barrier** — Reiner–Rubinstein / Haug single-barrier closed forms (in/out, up/down, zero rebate)
  with exact in–out parity, plus a **Brownian-bridge-corrected** Monte-Carlo for discrete monitoring.
- **Asian** — the exact discrete **geometric**-average price (m=1 ≡ BSM), reused as the control
  variate for the **arithmetic**-average Monte-Carlo (≈0.99 correlation ⇒ tiny standard error).
- **Lookback** — Conze–Viswanathan / Goldman–Sosin–Gatto floating- and fixed-strike formulas with a
  **Broadie–Glasserman–Kou** discrete-monitoring correction in the Monte-Carlo.

**Verification:** 60 new tests (plus a runnable `docs/examples/advanced-quant.test.ts`) — BSM/Black-76/Bachelier
degenerate-limit anchors, put–call and in–out parity, control-variate variance-reduction checks, and
analytic↔Monte-Carlo cross-validation for every model and exotic. Full `pnpm run ci` green.

## Review hardening (`@totalfinance/risk`)

A PR review of the risk slice surfaced two correctness bugs and a validation gap, all fixed with
regression tests:

- **Horizon scaling** — historical and Monte-Carlo VaR/CVaR scaled the whole one-period quantile
  linearly by `h` (a 4-period VaR came out exactly 4× the one-period value) instead of the documented
  √-time rule. They now apply `μ·h + (x − μ)·√h` — the same convention as the parametric method.
- **Optimizer feasibility & bounds** — an infeasible box+budget set (e.g. two assets each capped at
  0.4 summing to 1) returned a fabricated portfolio with `converged: true`; it now reports
  `converged: false`. Constrained `maxSharpe` solved in an auxiliary space and renormalized, which
  could push a weight past its cap (≈0.98 against a 0.6 bound); it now traces the box-constrained
  efficient frontier via a risk-aversion sweep, so the result is feasible by construction.
- **Input validation** — `varReport` rejects an unknown method (no silent Monte-Carlo fallthrough)
  and a non-positive sample count; portfolio VaR and the optimizers validate mean-vector length and
  finiteness. The shared options Monte-Carlo estimator likewise rejects an unknown `method`/`rng`
  (a typo in JSON/config no longer falls through to Halton/mulberry32 with a bogus echoed result).

Whole workspace **1,900 → 1,977 tests**.

## Volatility surface calibration & arbitrage (`@totalfinance/vol`, spec §10.1)

The third slice turns the non-parametric `raw`/`interpolated` surface into a parametric, calibrated,
arbitrage-checked one — fitting the very models the options tier prices.

### Parametric smiles (`./svi`, `./sabr`)

- **Raw SVI** (Gatheral) — `w(k) = a + b(ρ(k−m) + √((k−m)² + σ²))`. Calibrated by the **Zeliade
  quasi-explicit** method: for fixed `(m, σ)` the fit is _linear_ in `(a, bσρ, bσ)` and solved in
  closed form (a 3×3 Cholesky system), leaving only a 2-D Nelder–Mead search. A **butterfly penalty**
  in the outer objective (plus a 5-parameter refinement when needed) drives the fit to the closest
  **arbitrage-free** SVI; the result then **verifies and reports** it (`butterflyFree`/`minButterflyG`)
  rather than assuming it, and the surface flags any slice that stays arbitrageable. Gatheral's `g(k)`
  density function is exposed for an explicit check.
- **SABR** — `fitSABRSmile` calibrates `(α, ρ, ν)` for a fixed backbone `β` by Levenberg–Marquardt
  over the Hagan implied-vol expansion (reusing `@totalfinance/options` `sabrVol`), `α` seeded from the
  ATM vol, constraints kept via reparameterization. Round-trip recovery to ~1e-5 RMSE.

### Static no-arbitrage diagnostics (`./arbitrage`)

Two model-free checks in total-variance/log-moneyness coordinates: **calendar** (total variance
non-decreasing in maturity at fixed forward-moneyness) and **butterfly** (Gatheral `g(k) ≥ 0`, i.e.
non-negative risk-neutral density — which _is_ call-price convexity). `surfaceArbitrageReport` returns
structured violations; `VolSurface.arbitrage()` is the convenience wrapper.

### Surface integration

`VolSurface` gained `model: 'svi' | 'sabr'` — each fits a parametric smile per expiry (storing the
fitted `slice.svi`/`slice.sabr` parameters), falling back to an interpolated smile with a diagnostic
for expiries with too few strikes to identify the model.

**Verification:** 18 new tests (+ a runnable `docs/examples/vol-surface-calibration.test.ts`) —
round-trip parameter recovery for SVI and SABR, the Zeliade butterfly-free guarantee, calendar/
butterfly violation detection on synthetic surfaces, and end-to-end surface fitting/repricing/arbitrage.
Whole workspace **1,977 → 1,997 tests**.

## Research hygiene (`@totalfinance/risk/research`, spec §15.5)

The statistics that keep a backtest honest — defending against the two ways research lies to you:
selecting the luckiest of many configurations, and leaking the future across train/test boundaries.

- **Probabilistic & deflated Sharpe** (Bailey & López de Prado) — `probabilisticSharpeRatio` gives the
  probability the true Sharpe beats a benchmark, adjusted for sample length and skew/kurtosis;
  `deflatedSharpeRatio` sets that benchmark to the **expected maximum Sharpe across `N` trials**
  (Gumbel/Euler-Mascheroni), so a parameter sweep can't pass off its luckiest fit as real.
- **Multiple-testing correction** — `adjustPValues` with Bonferroni, Šidák, Holm (family-wise) and
  Benjamini–Hochberg (false-discovery-rate).
- **Leakage-free evaluation** — `walkForwardSplits` (rolling/anchored) and `purgedKFold` (López de
  Prado: contiguous test folds with a label-overlap **purge** and a trailing **embargo**).
- **`parameterSweepDiagnostics`**, **`checkLeakage`** (train∩test overlap), and **`survivorshipWarning`**.

Depends only on `@totalfinance/core` + `@totalfinance/math`. **Verification:** 17 tests + a runnable
`docs/examples/research-hygiene.test.ts` — the `PSR(SR̂)=0.5` identity, DSR monotonicity in trials,
hand-computed Bonferroni/Šidák/Holm/BH values, and leakage-free purged folds with full test coverage.
Whole workspace **1,997 → 2,017 tests**.

## Review hardening (Phase-5 validation sweep)

Successive reviews found a set of input-validation and guarantee gaps across the Phase-5 packages, all
fixed with regression tests:

- **SVI arbitrage guarantee** — the Zeliade box keeps the fit well-posed but does **not** by itself
  guarantee a non-negative density (a counterexample fit had `min g(k) ≈ −0.14`). `fitSVI` now adds a
  butterfly penalty to the calibration objective (plus a 5-parameter refinement when the closed-form
  fit is arbitrageable), **reports** `butterflyFree`/`minButterflyG`, and the surface flags any slice
  that remains arbitrageable — the over-strong "by construction" claim is corrected.
- **Enum fallthroughs** — every Phase-5 runtime enum now rejects unknown values instead of silently
  choosing a default: `VolSurface` `model`, `sabrVol` `volType` (the chokepoint every SABR path routes
  through), the exotic `barrierType` / `strikeType` (no more finite `barrier-bogus` or NaN
  `lookback-bogus` results), and the research `adjustPValues` `method` / `walkForwardSplits` `mode`.
- **Numeric knobs** — the risk optimizers reject `budget`/`tol`/`maxIter`/`riskAversion`/`fraction`
  that would leak NaN weights with `converged: true` (e.g. `kelly({fraction: NaN})`,
  `meanVariance({riskAversion: 0})`); `factorExposure` rejects a non-positive `k` (a `-1` previously
  kept "all but the last" factor via `slice(0, -1)`); `adjustPValues` rejects an out-of-range `alpha`;
  `deflatedSharpeRatio` rejects a negative `varianceSharpe` (rather than clamping it to 0, which would
  quietly collapse the deflated Sharpe to the un-deflated PSR).
- **Arbitrage-check knobs** — `checkButterfly`/`checkCalendar` validate `step > 0`, `butterflyPoints ≥ 3`,
  `calendarPoints ≥ 2`, and finite `tol ≥ 0`, so a degenerate setting can't produce a false
  `arbitrageFree: true`. (Also fixed stale "later-phase" doc comments on the surface and `fitSVI`.)

Whole workspace **2,017 → 2,028 tests**.

## Backtesting engines (`@totalfinance/backtest`, spec §16)

The last big Phase-5 slice: two backtest engines that return the **same** `BacktestResult`, so a fast
research sweep and a faithful execution simulation are directly comparable — and every run carries an
**implementation-risk** block that surfaces the modelling assumptions a backtest otherwise hides.
Depends only on `@totalfinance/core` + `@totalfinance/math` + `@totalfinance/performance`; fully browser-safe.

### Cost models (`./costs`)

Composable, labelled models shared by both engines: **commission** (`none`/`bps`/`perShare`/`fixed`),
**slippage** (`none`/`bps`/`fixed`/`spread`), and **short borrow** (`none`/`rate`, accrued per bar on
the carried short). Each model carries a stable `label` that flows straight into the diagnostics block.

### Vectorized research engine (`./vectorized`, §16.1)

A fast, deterministic single-asset loop: a per-bar target-weight `signal` drives a share-based position
rebalanced on a **calendar** (`everyBar`/`daily`/`weekly`/`monthly`/every-`N`-bars, boundary-detected
deterministically from `ts`), netting commission, slippage and borrow. Execution is **lagged one bar by
default** — the signal at bar `i` only affects the position held into `i+1` — so the engine cannot peek
at the return it trades on; setting `executionLag: 0` is allowed but **flagged** (`backtest.lookahead`).
A **dust band** suppresses phantom micro-rebalances from floating-point noise, so a constant target
weight is a single trade, not spurious turnover.

### Event-driven execution simulator (`./event-driven`, `./broker`, §16.2)

A chronological multi-symbol event loop over a **simulated broker**. The broker supports
**market / limit / stop / stop-limit** orders, **bracket** orders (a parent whose fill activates an OCO
take-profit + stop-loss pair), short selling with **borrow accrual**, a **max-leverage** cap and a
**no-short** switch (both reject with a warning rather than silently breaching), **volume-participation
partial fills**, and **corporate actions** (splits then dividends). Orders size by share `quantity`,
notional `value`, or target `percent` of equity — and notional/percent orders are **sized at the fill
price by the broker**, closing the size-at-decision-bar / fill-at-next-bar leverage gap. The `strategy`
gets a `StrategyContext` with `onBar`, streaming `indicator(...)` handles (structurally compatible with
`@totalfinance/ta` streams) and `crossOver`/`crossUnder` helpers, `buy`/`sell`/`close`/`order`/`cancel`,
and live `position`/`cash`/`equity`. Fills lag one bar — the same no-look-ahead contract.

### Walk-forward, tear sheets & attribution (`./walk-forward`, `./tearsheet`)

- **`walkForward`** slides a (train, test) window (`rolling` or `anchored`) and stitches only the
  **out-of-sample** test segments into one equity curve — the strategy may fit on train, but only OOS
  bars are scored.
- **`tearSheet`** is a render-free structured summary: performance metrics, return-distribution stats
  (hit rate, profit factor, expectancy, best/worst), trade/cost totals, per-symbol average-cost
  **realized-P&L attribution**, and an optional **seeded** Monte-Carlo **bootstrap** of bar returns for
  total-return confidence bands (so one backtest path isn't mistaken for certainty).

### Implementation-risk diagnostics (`./diagnostics`, §16.3)

Every result exposes a `policies` block (fill / cost / slippage / cash-settlement / corporate-action /
calendar), a `benchmarkFixtureVersion`, and structured `warnings`: **look-ahead** (lag 0),
**data-alignment** (out-of-order / duplicate timestamps, non-finite or non-positive prices) and
**survivorship** (a `current` universe). The six **golden fixtures** (§16.3) — buy-and-hold, monthly
equal-weight, SMA crossover, high-turnover rotation, long/short, and an option-with-expiration priced
through `@totalfinance/options` — pin both engines' behaviour at committed final-equity values.

**Verification:** 43 tests (engine units + the six golden fixtures + a runnable
`docs/examples/backtesting.test.ts`) — buy-and-hold exactness, no-look-ahead lag, bracket/OCO and
margin-rejection paths, notional-vs-percent sizing, walk-forward OOS stitching, seeded-bootstrap
reproducibility, and the data-alignment/look-ahead/survivorship warnings. Full `pnpm run ci` green;
whole workspace **2,028 → 2,071 tests**.

## Completeness pass — closing every §10/§15 gap

A final sweep took the advanced-quant tier from "headline features shipped" to **spec-complete**, adding
every metric/model/optimizer the §10/§15 lists name (only items the spec itself marks "later", or that
depend on a later phase, remain — see **Deferred**). All tested; whole workspace **2,071 → 2,128 tests**.

### `@totalfinance/performance` — the full §15.1 metric set

The extended ratios that needed a benchmark or trade/weight series, previously absent: **Omega**,
**Treynor**, **information ratio**, **tracking error**, **alpha/beta** (`./relative`); **hit rate**,
**profit factor**, **expectancy** (with its `winLossStats` win/loss decomposition, `./ratios`); **turnover** and
**exposure** from a weight time series (`./activity`); **rolling** volatility/Sharpe/return, input-aligned
(`./rolling`). `analyze` now takes a `benchmark` return series and reports beta/alpha/tracking/IR/Treynor
alongside the always-on Omega/hit-rate/profit-factor/expectancy.

### `@totalfinance/risk` — Black-Litterman, CVaR optimization, real constraints, portfolio risk

- **Black-Litterman** (`blackLitterman`): equilibrium prior (supplied or reverse-engineered `π = δΣw_mkt`)
  blended with views via `M = [(τΣ)⁻¹ + PᵀΩ⁻¹P]⁻¹`, then mean-variance-optimized; He–Litterman default
  view uncertainty.
- **CVaR optimization** (`cvarOptimize`): minimizes Rockafellar–Uryasev expected shortfall over a scenario
  set by **projected subgradient** (no LP dependency), honoring box/budget/sector/turnover + an optional
  return floor.
- **Real constraints**: `OptimizeConstraints` gained **sector/group caps**, a **turnover budget**, and a
  **transaction-cost** penalty — solved on the true constraint polytope via a **Dykstra projection**
  (box ∩ budget plane ∩ group half-spaces ∩ turnover L1-ball), not soft penalties, so the result is
  genuinely feasible. Wired into `minVariance`/`meanVariance` (and thus `maxSharpe`).
- **Portfolio risk** (`./portfolio`, §15.3): **concentration** (HHI/effective-N/top-k/Gini), **liquidity**
  (days-to-liquidate + √-law market impact), **margin** (gross/net/Reg-T/leverage), and **Greeks
  aggregation**. (Marginal/component VaR already shipped in the VaR slice.)

### `@totalfinance/vol` — Heston & smoothed surfaces, axes, term structure, event vol

- **Heston surface** (`model: 'heston'`): one stochastic-vol parameter set calibrated **globally** to the
  whole surface (Nelder–Mead over a bound-enforcing reparameterization, COS-priced); reprices a
  Heston-generated surface to <0.005 vol.
- **Smoothed surface** (`model: 'smoothed'`): a Nadaraya–Watson Gaussian-kernel smoother in log-moneyness.
- **Axes**: `ivByMoneyness` (spot- and forward-moneyness) and `ivByDelta` accessors round out the §10.1
  axis set (strike + delta + moneyness; SVI still fits in the log-moneyness coordinate).
- **Term structure** (`./term`, §10.2): `atmTermStructure`, `forwardVol`, `calendarSkew`, `forwardSkew`,
  plus **wing steepness** added to the per-expiry skew metrics.
- **Event vol** (§10.3): `realizedImpliedSpread`, `varianceRiskPremium`, `eventVolDecomposition`
  (base vs event-jump variance), and `deEarnedVol` (strip the earnings jump from ATM vol).

### Acceleration acceptance gate

`pnpm bench` now covers the Phase-5 hot kernels (options/vol/backtest/risk). All run sub-ms to
low-tens-of-ms single-core, so **no WASM/native work is justified in Phase 5** (design law #10,
correctness-first; acceleration is a Phase-7 deliverable). Decision recorded in
[`docs/adr/acceleration-phase-5.md`](../adr/acceleration-phase-5.md).

## Deferred (noted follow-ons)

Only items the spec itself sequences later, or that depend on a not-yet-built layer, remain:
**Dupire local-volatility _surface fitting_** (§10.1 marks it "later"; the Dupire _pricer_ already ships in
`@totalfinance/options`).

From §16.2, three items are explicitly instrument-specific and wait on layers TotalFinance hasn't built
yet: **options exercise/assignment** (the spec itself marks it "later" — needs an options-position
model in the broker), and **futures margin** + **continuous-futures roll** (need a futures-contract
abstraction). The current engine is cash-and-share based; equity/ETF strategies, shorting, and the
six golden archetypes are fully covered. Bar ingestion is **bring-your-own-`Bar[]`** rather than the
spec's `data: provider, symbols, from, to` form — the provider/date-range surface lands with
`@totalfinance/data` (§17, a later phase); the engine consumes whatever bars that package will produce.

## Next

Phase 5 (Advanced Quant & Research) is **complete** — every §10/§12/§15/§16 deliverable is shipped and
tested, and the acceptance gate (implementation-risk diagnostics, seeded stochastic APIs, the
benchmark/WASM decision) is satisfied. The only open thread inside Phase 5 is the spec-"later" Dupire
local-volatility surface fit. Next is **Phase 6 — Fixed Income** (`@totalfinance/fixed-income`: bonds, curves,
rates derivatives, credit), with `@totalfinance/data` (§17) and the adapter SDK following.
