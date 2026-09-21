# TotalFinance roadmap — the ambitious surface

> Phases 0–6 (the compute library: core, math, calendars, options, volatility, structure, strategy, technical-analysis,
> performance, risk, backtest, fixed-income, crypto, mcp, and the umbrella) are implemented. Most of
> the pre-1.0 coherence pass is verified at `e1e846e7`: 308 test files / 6,284 tests, domain reference
> and property evidence, runtime-export manifests, finite/unknown-key/first-touch ratchets, and
> installed-tarball consumer tests. A later review found that the manifest and acceptance gates did
> not inspect callable signatures and had explicitly allowed unsafe positional expert kernels.
> Alignment Phase 3A closed that P0 on 2026-07-22 with a declaration-backed inventory of 3,310
> callables, named-request migrations, compile-fail and parity contracts, internal conformance, and
> packed-consumer evidence. This roadmap remains the feature inventory beyond that correction.
>
> Standing discipline for everything below: no data-fetching in compute packages, no charting
> framework, no broker execution. Adapters and renderers live at the edges; every new export ships
> a deep-sweep fixture; the ratchets never grow.

> **Sequencing is governed by [`implementation-order.md`](./implementation-order.md).** The
> [`library-alignment-spec.md`](./library-alignment-spec.md) owns public-contract laws and Phase 3A/3B
> evidence; this file remains a feature inventory and does not choose the next task. Shipped names
> below are the FINAL canonical vocabulary: the
> [Phase 3B.N naming migration](./specs/phase-3b-public-naming-normalization.md) has landed, and that
> spec plus the committed naming baseline own package, SDK, artifact, and MCP names. Names attached to unshipped candidate
> ideas are capability sketches, not implementation authority; normalize them against Phase 3B.N
> before promoting any candidate into an executable spec.
>
> This document remains the inventory of individual quant features. The cross-cutting architecture,
> product journeys, and release gates for turning that inventory into a complete platform live in
> the [`platform-completeness roadmap`](./platform-completeness-roadmap.md).

## Sequencing

0. ✅ **The verified alignment baseline at `e1e846e7`**: surgical fixes, finite-success correctness,
   composable schemas, explicit extension validation, per-role result grammar, per-argument input
   policy, topology, contracts, vocabulary, and the existing executable conformance gates.
1. ✅ **Public function-shape correction** (= spec Phase 3A, closed 2026-07-22) — 3,310 public
   callables are declaration-inventoried; financially confusable signatures and internal calls use
   named requests; compile-fail, grammar, parity, throughput, and packed-consumer gates prevent
   regression.
2. ✅ **Wave 6 quant moats** — the finite four-item batch is complete in
   [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md).
3. ✅ **Phase 3B.N public naming normalization (N0–N9, re-closed after RV7)** — whole-repository package/import, SDK,
   declaration-label, schema, artifact, stable-code, and MCP vocabulary, from the dedicated
   [`naming implementation spec`](./specs/phase-3b-public-naming-normalization.md). 21,408 public
   naming identities walked, 0 unresolved, drift gated in CI. Phase state is owned by
   [`implementation-order.md`](./implementation-order.md).
4. **Phase 3B runtime/semantic closeout** — runtime object enforcement, implementation of
   the [settled decision ledger](./specs/phase-3b-decision-ledger.md), field semantics, and cold
   packed misuse journeys from the dedicated
   [`Phase 3B implementation spec`](./specs/phase-3b-runtime-semantic-closeout.md).
5. **Core capability completion and platform spine through Stage 4.5** — execute the accepted
   [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
   for cash-flow math, DCF/fundamentals, research, performance, FX, commodities, and durable
   portfolio; then close the shared artifact, extension, scenario, calibration, and
   reproducible-research programs in
   [`platform-completeness-roadmap.md`](./platform-completeness-roadmap.md).
6. **Pre-1.0 preview cutover** — close options-marking truthfulness; pull forward the Stage 7A
   protocol-neutral operation registry, machine-first CLI, generated OpenAPI/local HTTP, and
   exemplary read-only local MCP; run launch-surface integration and public preview shipping.
7. **Stable-core completion** — finish FC8 portfolio-scale/cross-asset simulation, extend every
   flagship operation through the preview transports as it lands, run the one true FC9/Stage 4.7
   whole-surface freeze, and complete stable shipping.
8. **Data, first-party growth, connected/hosted agent operation, and measured acceleration** in the
   order defined by `implementation-order.md`. Everything else below remains candidate inventory,
   not implied release scope.

**Completion boundary:** Phase 3A/3B, Wave 6, FC0–FC7, Platform Stages 4.1–4.4b, and their permanent
ratchets are complete. Stage 4.5 is current. Its close activates the preview lane; the preview is
explicitly pre-1.0 and does not claim FC8/FC9 complete. FC8 and the final FC9/Stage 4.7 audit remain
stable-release blockers. Every later API must satisfy the existing ratchets immediately. Optional
feature ideas below do not become blockers merely by appearing in this inventory.

---

## Tier 1 — next product layers and high-leverage depth

### 1.0 Core capability completion — accepted, queued after Phase 3B

The blank-sheet completeness audit found that options depth had hidden several basic finance
categories. The complete build contract is now
[`specs/finance-portfolio-backtesting-completeness.md`](./specs/finance-portfolio-backtesting-completeness.md),
which settles package ownership, public surfaces, semantics, acceptance laws, dependencies, and
per-slice execution status. It covers four independently useful families—finance/valuation,
research, portfolio management, and portfolio-scale simulation/backtesting. Backtesting is FC8, not
the umbrella for the other work:

- general present/future value, NPV/IRR, loans, schedules, capital budgeting, and depreciation;
- typed financial statements, ratios, cost of capital, DCF/reverse DCF, sensitivities, and comparable
  valuation;
- general screening/ranking, economic style-factor construction, and point-in-time event studies;
- TWR, MWR, Modified Dietz, external-flow handling, and reconciled contribution;
- coherent foreign-exchange and commodity carry/term-structure front doors;
- the event-derived durable portfolio ledger, lifecycle accounting, policy, rebalancing,
  reconciliation, and performance through time; and
- cross-sectional, portfolio-grade options, cross-asset, portfolio-scale, ledger-backed backtesting.

These are pure BYOD compute capabilities. The pre-1.0 preview may ship after Stage 4.5 and its
truthfulness/transport gates while the final portfolio-scale row continues; the stable release still
waits for the complete core freeze. Provider work remains separate. Raw calculations remain
independently callable; the higher portfolio/research layers compose them rather than burying them.

### 1.1 The data layer (`@totalfinance/data` + `@totalfinance/adapter-*`) — spec §13

> **Deferred by choice, fully designed in [`data-layer.md`](./data-layer.md).** Critical, and coming
> — but sequenced after the finance-tool surface so the fluent API is felt against finished compute
> and the tools tell us exactly which data shapes to serve. The dedicated doc has the provider
> interface, the front-door, the adapter tiers (incl. the flagship InsiderFinance adapter), MCP data
> handles, and the open questions.

Bring-your-own-data, sequenced last by design; no compute package will ever depend on it.

- `MarketDataProvider` interface (bars/quotes/trades/optionChain/optionTrades/dividends/
  corporateActions/riskFreeCurve), cache abstractions (memory/file/Redis), normalization to the §5.2
  types, quality scoring, and provenance propagation (results carry where their data came from).
- `createTotalFinance({ data })` front-door (WS5.1) and the fluent chain API (WS5.2):
  `totalfinanceClient.options.chain(chain).withMarketFromData().impliedVolatility().greeks().toRows()`.
- Adapter packages, isomorphic first: in-memory, CSV, JSON, Arrow; then server-side Parquet /
  SQLite / DuckDB / Postgres; generic REST + WebSocket adapters as templates.
- Vendor adapters in their own packages (Polygon, Alpaca, Databento, IBKR, FRED, SEC EDGAR) — and
  the flagship: an **InsiderFinance adapter**, so the flow/chain/GEX platform is a first-class
  provider and the library dogfoods the product.

### 1.2 Options backtesting — ✅ shipped (`@totalfinance/backtest/options`)

The equity engines don't fit options; the audience trades options. Built by composing the existing
primitives (builders, `strategyFromChain`, `Position.value`, `optionsMargin`, calendars) — see
[`specs/options-backtest.md`](./specs/options-backtest.md).

- ✅ Chain-driven strategy backtests over a `ChainSnapshot` time series: declarative entry
  (structure/delta/DTE) with callback escape hatches, exit triggers (profit target / stop / DTE /
  callback), **roll rules**, expiry settlement + American early-assignment, and margin-aware sizing.
- ✅ Delta-hedging (trade the underlying to a band, with cost accounting).
- ✅ `optionsTearSheet`: win rate, avg credit, days held, assignment count, P&L by structure, per-leg
  attribution.
- **Portfolio-grade completion:** current-implied-volatility re-marking and its vega P&L close before
  preview; multiple concurrent positions, multi-expiry lifecycle, portfolio cash/margin/risk, and
  explicit combo/legged execution remain governed by FC8 in the
  [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md).
  Provider-fed chains remain a later zero-change data-layer integration.

### 1.3 P&L explain — ✅ shipped (`@totalfinance/risk`)

Decompose realized P&L between two market states into delta/gamma/vega/theta/rho terms plus an
honest unexplained residual — position-level and portfolio-level. Built as the realized wrapper over
the existing `taylorPnl` greek engine; see [`specs/pnl-explain.md`](./specs/pnl-explain.md).

- ✅ `explainPnl(greeks, move, actualPnl)` primitive, `explainPositionPnl(position, from, to)` with
  per-leg attribution, `explainPortfolioPnl(items)` roll-up across underlyings.
- ✅ The residual is a first-class field (`delta + gamma + vega + theta + rho + vanna + vomma + charm +
unexplained === total`, exact); it grows precisely when the greek approximation breaks over the move.
- ✅ **Higher-order terms (vanna/vomma/charm).** Optional second-order greeks on `PositionGreeks` promote
  the spot–vol cross (`vanna·dS·dσ`), the vol convexity (`½·vomma·dσ²`), and the spot–time cross
  (`charm·dS·timeStepYears`) out of the residual into named terms — so the residual becomes genuinely
  3rd-order-and-higher. Backward-compatible (absent greeks ⇒ 0 terms, invariant preserved);
  `rawGreeksFromDisplay` feeds `blackScholesExtendedGreeks` through, negating charm to the calendar convention
  (`∂²V/∂S∂t = −∂Δ/∂T`). Verified the terms reproduce the FD 2nd-order Taylor of the BSM price to ~1e-8 and
  the residual converges cubically (÷≈8 per halving of the move) — an honest "exact 2nd-order attribution",
  not a blanket "smaller residual" (a large move's 3rd-order term can dominate). See
  [`specs/pnl-explain-higher-order.md`](./specs/pnl-explain-higher-order.md).
- ✅ **The complete 2nd-order Taylor + dividend carry.** Promotes every remaining second-order term out of
  the residual — the vol–time cross (`veta`), the rate crosses (`vera`, `deltaRate`, `thetaRate`), and the
  rate/time convexities (`rhoConvexity`, `thetaConvexity`) — plus a first-order dividend-carry term
  (`ε·dq`, via a new `shock.dividend` factor). `rawGreeksFromDisplay` auto-sources `veta`/`vera`/`ε` from
  `blackScholesExtendedGreeks`; the attribution is complete to 2nd order in (spot, vol, time, rate) and verified to
  leave an O(move³) residual for an all-factor move. See
  [`specs/pnl-explain-higher-order.md`](./specs/pnl-explain-higher-order.md).
- ✅ **Extended greeks wired into `Position.value()`** (`@totalfinance/strategy`): each option leg now reports
  the full `ExtendedGreeks` (the aggregate too, with book elasticity recomputed), so `explainPositionPnl`/
  `explainPortfolioPnl` attribute the higher-order terms on any strategy Position automatically — no
  hand-supplied greek set.
- ✅ **Per-trade P&L explain in the options backtester** (`@totalfinance/backtest/options`): every
  `OptionsTrade` carries a `pnlExplain` (greek decomposition of its gross P&L, `total === realizedPnl +
costs` with the entry edge folded into the residual), and `optionsTearSheet` rolls them into a
  strategy-level `greekAttribution` — "where did the P&L come from." See
  [`specs/options-backtest.md`](./specs/options-backtest.md).
- **Follow-up:** analytic `deltaRate`/`thetaRate`/`rhoConvexity`/`thetaConvexity` on `ExtendedGreeks` (the
  four rate/time crosses are attributed when supplied but not yet emitted by the BSM greek engine — adding
  them cascades across every model for marginal equity-P&L terms).

### 1.4 Performance: benchmarks + acceleration

- A published benchmark suite (ops/sec for pricing, IV, chains, indicators — tracked in CI, shown
  on the docs site) against QuantLib/py-vollib-class baselines.
- WASM/SIMD kernels for batch pricing and Monte Carlo behind the existing columnar APIs
  (`blackScholesPriceMany` was designed for exactly this); worker-pool helpers; a WebGPU MC experiment.
- Arrow-native columnar interop so data-layer results flow into batch pricers with zero copies.

## Tier 2 — depth that makes each package the best of its kind

### Options & vol

- ✅ **SSVI arbitrage-free surface** (`calibrateSsvi`, `ssviVolatility`, `ssviTotalVariance`,
  `ssviArbitrageFree`, `@totalfinance/volatility`): the Gatheral–Jacquier surface SVI — parametrizes the WHOLE
  surface with the ATM total-variance term structure `θ(t)`, a global skew `ρ`, and a curvature `φ(θ)`
  (power-law or Heston), **free of calendar arbitrage by construction** (monotone `θ`), which per-slice
  SVI can't guarantee. SSVI-at-`θ` reduces exactly to a raw-SVI slice, so evaluation and the Gatheral-`g`
  butterfly density test reuse `svi.ts`. Global least-squares calibration (θ from ATM, monotone-clamped
  with disclosure), exact butterfly + calendar arbitrage diagnostics, and arbitrage-free interpolation
  **in time**. See [`specs/ssvi-surface.md`](./specs/ssvi-surface.md).
  - ✅ **Wired into `volatilitySurface` as `model: 'ssvi'`** — a first-class global model alongside `heston`, so
    the whole surface API (strike×expiry lookup, moneyness/delta axes, `arbitrage()`, `toRows`,
    `toJSON`/`fromJSON`, `shock`) works on the arbitrage-free SSVI surface. One `calibrateSsvi` to the whole
    surface, `ssviVolatility` per slice, `θ(t)` interpolation (calendar-arb-free in time), convergence + residual-
    arbitrage disclosures. Verified: faithful wrapper (`impliedVolatility` = `ssviVolatility(parameters)` exactly), recovers a
    generating SSVI surface, snapshot `impliedVolatility`-identical, shock degrades to interpolated. See
    [`specs/ssvi-surface-model.md`](./specs/ssvi-surface-model.md).
  - ✅ **Vega-weighted calibration** (`weight: 'vega'` on `calibrateSsvi`/`calibrateEssvi`, `ssviWeight`/
    `essviWeight` on `volatilitySurface`) — weight the total-variance residuals by Black vega `∝ φ(d₁)·√t`, so liquid
    ATM/near-the-money strikes dominate the fit and thin, noisy, low-vega wings are downweighted (weights are
    the market's, fixed across the search). Default `'uniform'` (backward-compatible); reported RMSE stays
    unweighted for comparability. Verified: on a fat-wing surface the vega fit's ATM-core residual is tighter
    than the uniform fit's (which the bad wings pull off). See
    [`specs/ssvi-vega-weighting.md`](./specs/ssvi-vega-weighting.md). _Follow-up:_ bid/ask- or quote-count-
    weighted calibration.
- ✅ **eSSVI — per-maturity skew** (`calibrateEssvi`, `essviVolatility`, `essviTotalVariance`,
  `essviArbitrageFree`, `@totalfinance/volatility`): extends SSVI's single global `ρ` to a **term structure of skew**
  `ρ(θ)`, so a steep short-dated skew and a mild long-dated one fit at once — while `φ(θ)` stays global.
  Each fixed-θ slice is still an SSVI (hence raw-SVI) slice, so evaluation and the Gatheral-`g` butterfly
  test reuse `ssvi.ts`/`svi.ts`. Because `ρ` now varies, a monotone `θ` is **no longer sufficient** for
  calendar-arbitrage-freedom (verified: a θ-monotone pair still crosses in total variance), so the calendar
  check scans the `(k, t)` grid by definition. Calibration is **warm-started from a global SSVI fit** (a
  strict superset — never worse) then refines per-maturity `ρᵢ` + `φ` with a calendar-crossing penalty.
  Verified: constant `ρ` reproduces SSVI to 0; recovers a known `(−0.75, −0.5, −0.18)` skew term structure
  to ~1e-13 (≈1e10× better RMSE than a single global `ρ`); the arbitrage scan flags a θ-monotone crossing.
  See [`specs/essvi-surface.md`](./specs/essvi-surface.md).
  - ✅ **Wired into `volatilitySurface` as `model: 'essvi'`** — the sibling global model to `ssvi`, reusing the same
    integration (one `calibrateEssvi` to the whole surface, `essviVolatility` per slice, snapshot/shock/`arbitrage()`
    support). Unlike SSVI, calendar-arb-freedom is **not** free-by-construction (ρ varies), so the calendar
    warning is a genuinely reachable disclosure. Verified: faithful wrapper, recovers a steep-short/mild-long
    `ρ(θ)`, and fits such a chain materially better than a single-ρ `ssvi` surface (SSE 7e-6 vs 2.4e-3). See
    [`specs/essvi-surface-model.md`](./specs/essvi-surface-model.md). _Follow-up:_ the fully-general per-slice
    `ψᵢ` eSSVI (Hendriks–Martini) with closed-form no-arb inequalities. (Vega weighting ✅ — see the
    vega-weighted-calibration entry above.)
- ✅ **Volatility-surface PCA** (`surfacePCA`, `@totalfinance/volatility`): the dominant modes of surface _motion_ from a
  history of snapshots — a PCA of the surface changes (absolute/relative), reporting each mode's
  loadings, variance explained (+ cumulative), a **level/slope/curvature** shape label derived from the
  eigenvector's sign-change count (Litterman–Scheinkman, `gridPoints`-ordered), and a factor-score time
  series (which mode fired each day, reconstructing the changes). See
  [`specs/surface-pca.md`](./specs/surface-pca.md). _Follow-up:_ rolling/EWMA covariance.
- ✅ **Volatility-surface PCA scenario shocks** (`surfacePcaScenarios`, `@totalfinance/volatility`): turns the fitted PCA into
  **stress scenarios** — completing the fit → interpret → stress workflow. A `k`-sigma move along each mode
  is exactly `k·√λ·loadings` (since `√λ` is the mode's 1-sigma daily move and the loadings are unit-norm,
  verified `std(scores) = √λ` to full precision), applied to a supplied base surface and floored so a large
  downside shock can't go negative; a **combined** per-mode move sums them. So a `+k` level shock raises
  every vol, a slope shock tilts the wings, curvature bends the smile — shocked surfaces a book can be
  repriced against. Composes `surfacePCA` (no new estimation); the change type is inherited and disclosed.
  See [`specs/surface-pca-scenarios.md`](./specs/surface-pca-scenarios.md). _Follow-up:_ book repricing per
  scenario, correlated/historical worst-case scenarios, and grid interpolation.
- ✅ **Sticky-strike vs sticky-delta regime** (`stickyRegime`, `@totalfinance/volatility`): measures which regime
  the market is actually in — regresses a fixed reference strike's IV changes on spot log-returns for the
  vol-spot beta `β = ∂σ_K/∂lnS`, then places the market on the axis via `stickiness = −β/skewSlope`
  (0 = sticky-strike, 1 = sticky-moneyness), with R²/t-stat reliability and a labeled regime.
  Complements `minimumVarianceDelta` (which _assumes_ a regime); indeterminate under a flat/absent smile;
  a non-trivial placement on a weak regression is flagged. Verified against synthetic sticky-strike
  (s≈0), sticky-moneyness (s≈1), and blended (s≈0.5) worlds. See
  [`specs/sticky-regime.md`](./specs/sticky-regime.md). _Follow-up:_ multi-strike/whole-smile aggregation,
  a rolling regime, and auto-`skewSlope` from a supplied smile.
- ✅ **Risk reversal & butterfly** (`riskReversalButterfly`, `smileFromQuotes`, `@totalfinance/volatility`): the
  standard FX/crypto smile-quoting decomposition — from a smile function, find the δ-delta (forward-delta)
  wing strikes and report the ATM vol, the **risk reversal** (`callVolatility − putVolatility`, the skew) and the
  **butterfly** (`avg − ATM`, the curvature); and its **exact closed-form inverse** `smileFromQuotes`
  (`(ATM, RR, BF) → (put, ATM, call)` anchors). The two round-trip to machine precision (vols and
  strikes), the wing strikes carry forward delta δ exactly, an unreachable δ on an extreme smile is a
  typed error, and a flat smile gives RR = BF = 0. Composes with any fit (SVI/SSVI/`volatilitySurface`). See
  [`specs/risk-reversal-butterfly.md`](./specs/risk-reversal-butterfly.md). _Follow-up:_ spot/premium-
  adjusted delta + ATM-DNS conventions, the 10-delta/strangle FX quotes, and a whole-surface term structure.
- ✅ **Vanna–volga smile** (`calibrateVannaVolga`, `@totalfinance/volatility`): the FX/crypto market standard for building a
  **full smile from three quotes** (ATM + 25Δ RR/BF). Prices any strike as the flat-ATM Black value plus
  the cost of a portfolio of the three market instruments that replicates its **vega, vanna, and volga**
  (a per-strike 3×3 solve), so the smile **reprices the three pillars exactly** and interpolates smoothly.
  Composes `smileFromQuotes` (pillars in) and closes the quote → smile → quote loop through
  `riskReversalButterfly`. Far-out strikes where VV breaks down (price out of the no-arb bounds, or a
  degenerate ≈0 vol) are a typed error, never garbage. See [`specs/vanna-volga.md`](./specs/vanna-volga.md).
- ✅ **Vanna–volga Castagna–Mercurio closed form** (`vannaVolgaApproximation`, `@totalfinance/volatility`): the fast,
  **always-defined** market-quoting form the exact `calibrateVannaVolga` is usually approximated by — same three
  pillars (`smileFromQuotes`), but the vol at any strike from the Castagna–Mercurio (2007) formula: `order: 1`
  (log-strike Lagrange interpolation) or `order: 2` (curvature-corrected; default). **Both orders reprice the
  three pillars exactly**; the 2nd order matches the exact VV to **< 0.5 bp** across the pillar range. Unlike
  the exact method it needs no Black inversion, so it **extrapolates** where `calibrateVannaVolga` refuses; the one
  genuine breakdown — an inverted (butterfly < 0) smile driving the curvature `√` negative — is a typed error,
  never a NaN. See [`specs/vanna-volga-approx.md`](./specs/vanna-volga-approx.md).
- ✅ **Vanna–volga-implied risk-neutral density** (`vannaVolgaDensity`, `@totalfinance/volatility`): from just the three
  quotes (ATM + δ RR/BF) to the **full risk-neutral terminal distribution** — PDF, CDF, quantiles,
  probability-in-range, and the moments (mass ≈ 1, mean = forward by the martingale property, variance,
  skewness, excess kurtosis). Builds the **Castagna–Mercurio** smile (the always-defined closed form — the
  exact `calibrateVannaVolga` breaks down across the wide grid a density needs) and applies **Breeden–Litzenberger** in
  forward space. Verified against the analytic lognormal (flat smile) to ~4e-6; skewness tracks the risk
  reversal and kurtosis the butterfly. Grid-truncation and residual butterfly-arbitrage (a non-monotone CDF)
  are disclosed warnings; a smile too steep for the grid is a typed error. See
  [`specs/vanna-volga-density.md`](./specs/vanna-volga-density.md).
- ✅ **5-pillar (10Δ) vanna-volga smile** (`calibrateVannaVolga5`, `@totalfinance/volatility`): the full FX/crypto quote set — ATM
  - 25Δ **and** 10Δ RR/BF — built into a smile that **exactly reprices all five market pillars** (10Δ put, 25Δ
    put, ATM, 25Δ call, 10Δ call), pinning the wings to real quotes instead of extrapolating them like the
    3-pillar smile. The five anchors come from `smileFromQuotes` at each delta; the curve is a shape-preserving
    **PCHIP** interpolation of total variance in log-moneyness — exact at the pillars, C¹, no overshoot.
    Complements (doesn't duplicate) the least-squares `calibrateSvi`/`calibrateSabrSmile`/`calibrateSsvi` by hitting the
    quotes exactly. Verified: pillar-exact to machine precision, agrees with the 3-pillar CM at the shared
    pillars and diverges tens of bp in the 10Δ wings. An over-convex butterfly (negative implied density on the
    interior) is a disclosed arbitrage warning; a linear wing driven to non-positive variance and crossed
    pillars are typed errors. See [`specs/vanna-volga-5.md`](./specs/vanna-volga-5.md).
- ✅ **5-pillar-implied risk-neutral density** (`vannaVolga5Density`, `@totalfinance/volatility`): the
  `vannaVolgaDensity` read-out (PDF/CDF/quantiles/probability-in-range/moments) but from the **five-pillar**
  smile, so the core `[10Δ put, 10Δ call]` range — where most probability mass sits — is pinned to real
  quotes instead of extrapolated from three. Shares one Breeden–Litzenberger density core with the 3-pillar
  version. Forces **linear** wing extrapolation: it is C¹ at the 10Δ knots so the density stays smooth,
  whereas a `flat` wing puts a spurious kink-spike in the density at those interior knots (verified: flat →
  min density ≈ −6e-2, non-monotone CDF, mass ≈ 1.008; linear → +1e-11, monotone, mass ≈ 1.0000, mean =
  forward). Verified sharper than the 3-pillar density inside the quoted range; a down-sloping wing driven to
  non-positive variance is a typed error, an over-convex butterfly a disclosed warning. See
  [`specs/vanna-volga-5-density.md`](./specs/vanna-volga-5-density.md). _Follow-up:_ a whole-surface
  (term-structure) VV density, and a physical-measure re-weighting.
- ✅ **VIX-style model-free variance index** + **VRP term structure** (`varianceIndex`,
  `varianceRiskPremiumTermStructure`, `@totalfinance/volatility`): from a raw chain — per-expiry forward + OTM-strip extraction →
  DDKZ fair variance → CBOE time-interpolation to a constant maturity, the per-expiry term structure,
  and the variance-risk-premium curve vs realized. See [`specs/variance-index.md`](./specs/variance-index.md).
  _Follow-up:_ SVI-consistent strip pricing, minutes-precision time.
- ✅ **SKEW-style tail-risk index** (`tailRiskIndex`, `@totalfinance/volatility`): model-free risk-neutral skewness
  - excess kurtosis (Bakshi–Kapadia–Madan) from the **same OTM strip** as the variance index (extracted
    into a shared `otm-strip` module), with the CBOE-style `100 − 10·skewness` SKEW value and a
    constant-maturity term structure. See [`specs/tail-risk-index.md`](./specs/tail-risk-index.md).
    _Follow-up:_ a tail-loss/VaR read from the same risk-neutral distribution; physical-measure skew.
- ✅ **Minimum-variance (smile-adjusted) delta** (`minimumVarianceDelta`, `@totalfinance/volatility`): the hedge
  ratio `Δ_BS + Vega·β` that accounts for the vol–spot co-movement (`β = ∂σ/∂S`) — β supplied empirically
  (leverage), or derived from the skew slope under a disclosed sticky-strike / sticky-moneyness regime.
  See [`specs/min-variance-delta.md`](./specs/min-variance-delta.md).
- ✅ **SABR Bartlett (minimum-variance) delta & vega** (`sabrBartlettGreeks`, `@totalfinance/volatility`): the
  model-consistent hedge when the smile is a **SABR** fit — Bartlett (2006) accounts for the vol-level move
  that, on average, accompanies a forward move under the correlated dynamics (`⟨dW_F, dW_α⟩ = ρ timeStepYears`):
  `Δ_B = ∂V/∂F + ∂V/∂α·(ρν/F^β)`, `V_B = ∂V/∂α + ∂V/∂F·(ρF^β/ν)`, and the minimum-variance **gamma**
  `Γ_B = d²V/dF²` along the correlated hedge path. Composes `sabrPrice`'s verified naive greeks and adds the
  coupling; reports the decomposition (naive, Bartlett, adjustment). Verified against a **correlated-bump SABR
  reprice** to ~1e-8; an equity skew (`ρ < 0`) lowers a call's delta and the delta adjustment vanishes at
  `ρ = 0`, while the gamma adjustment is ≈ 0 at the money and **material in the wings** (tens of % OTM). The
  SABR realization of `minimumVarianceDelta`. See
  [`specs/sabr-bartlett-delta.md`](./specs/sabr-bartlett-delta.md) +
  [`specs/sabr-bartlett-gamma.md`](./specs/sabr-bartlett-gamma.md).
- ✅ **Empirical vol–spot β — the leverage effect** (`estimateVolatilitySpotBeta`, `@totalfinance/volatility`): estimates the honest,
  model-free `β = ∂σ/∂S` from a `(spot, impliedVolatility)` history — the OLS slope of realized IV changes on spot
  changes (negative for equities), the empirical hedge input `minimumVarianceDelta({ volatilitySpotBeta })` consumes.
  Regresses on **log-returns** (default; slope `∂σ/∂ln S` → `∂σ/∂S` at a reference spot) or dollar changes,
  composes `@totalfinance/math`'s `ols` with optional **Newey–West HAC** errors, and discloses the slope's
  standard error / t-stat / R² plus a **significance / small-sample / dropped-observation** warning so a β
  that is really noise can't masquerade as a hedge. Verified: recovers a known leverage β exactly on a
  synthetic log-leverage series and round-trips into `minimumVarianceDelta`. See
  [`specs/vol-spot-beta.md`](./specs/vol-spot-beta.md). This **completes the `minimumVarianceDelta` follow-up
  trio** (SABR/Bartlett delta, min-variance vega/gamma, empirical β). _Follow-up:_ a multi-factor / rolling
  (EWMA) β.
- ✅ **American exercise analytics** (`americanExercise`, `@totalfinance/options`): the early-exercise
  **premium decomposition** (American value − European value) + the **exercise boundary** `S*(τ)`
  recovered over the option's life + a plain **exercise-now** verdict, from one call. Composes `bawPrice`
  (which returns exactly intrinsic in the exercise region, so premium = 0 ⟺ exercise now ⟺ spot past
  `S*`, all consistent) with the BSM European price; the boundary is bisected from the BAW value.
  Handles put (low-spot boundary rising to `K`) vs dividend-call (high-spot boundary) vs non-dividend
  call (never optimal → no premium/boundary), and discloses discrete-dividend and negative-rate cases.
  See [`specs/american-exercise.md`](./specs/american-exercise.md). _Follow-up:_ a discrete-dividend
  lattice boundary, a higher-accuracy value engine (Bjerksund–Stensland 2002), and early-exercise greeks.
- ✅ **Dividend term structures** (`dividendTermStructure`, `@totalfinance/options`): unifies a **discrete
  cash schedule** and a **continuous yield** into a per-expiry term structure of the dividend-adjusted
  (escrowed) **forward** `F(T)`, the **PV** of dividends accruing before `T`, and the
  **continuous-equivalent yield** `q_eff(T) = q − ln(1−PV/S)/T` — the single yield that reproduces the
  forward. Because BSM depends on `(S,r,q)` only through the forward, pricing an expiry with `q_eff(T)`
  returns _exactly_ the escrowed-spot price (verified to 1e-14), so the discrete-vs-continuous mismatch
  vanishes losslessly at the pricing boundary. Same `0 < τᵢ < T` escrowed model as `escrowedSpot`; the
  forward direction of what `parity.impliedDividendYield` inverts. Drops paid ex-dates (disclosed), reports
  points sorted by tenor, and notes the `q_eff` `1/T` decay past the last ex-date.
  See [`specs/dividend-term-structure.md`](./specs/dividend-term-structure.md). _Follow-up:_ a non-flat
  `r(T)` curve, proportional dividends, dividend greeks, and chain-implied reconciliation.
- ✅ **Earnings / event-vol modeling** (`calibrateEventVolatility`, `calibrateEventMove`, `@totalfinance/volatility`):
  extract the continuous vol + the discrete event jump (implied earnings move) from an ATM-vol term
  structure by regression (`V = σ_base²·T + J²·[spans]`), and calibrate straddle-implied vs realized
  moves across past events (is the earnings straddle historically rich?). See
  [`specs/earnings-event-vol.md`](./specs/earnings-event-vol.md). _Follow-up:_ multi-event windows,
  chain→straddle move extraction, weighted/robust regression.
- ✅ **Digital & one-touch options** (`digital`, `touch`, `@totalfinance/options`): binary bets —
  **digitals** (cash-or-nothing `Q·e^{−rT}·N(±d₂)` / asset-or-nothing `S·e^{−qT}·N(±d₁)`, so a vanilla
  = asset-or-nothing − K·cash-or-nothing exactly) and **one-touch / no-touch** (first-passage touch
  probability; pay-at-expiry `cash·e^{−rT}·P` or pay-at-hit Reiner–Rubinstein), each with a closed-form
  price and a Monte-Carlo engine that converges to it (the touch pay-at-expiry MC reuses the
  Brownian-bridge survival). Already-touched spots short-circuit; `no-touch` is expiry-settled. Verified
  by exact identities + the r=0 pay-at-hit ⇄ pay-at-expiry equality. See
  [`specs/digital-touch.md`](./specs/digital-touch.md).
- ✅ **Forward-start options** (`forwardStart`, `@totalfinance/options`): the strike is set at a future
  **reset** `t₁` as `α·S(t₁)` (α=1 ⇒ at-the-money-at-reset) — the building block of cliquets/ratchets and
  reset structures. Rubinstein (1991) closed form `V = S·e^{−q·t₁}·φ` (homogeneous of degree 1 in today's
  spot) + a two-step-GBM Monte-Carlo that converges to it. See [`specs/forward-start.md`](./specs/forward-start.md).
- ✅ **Cliquet / ratchet options** (`cliquet`, `@totalfinance/options`): a capped strip of forward-start
  caplets — per-period returns clipped to a local floor/cap (a local floor of 0 locks in gains), summed,
  clipped to a global floor/cap, paid at maturity. Closed form for the locally-capped case (a strip of
  Black-76 return call-spreads) + a general Monte-Carlo for the globally-constrained one; `price` refuses
  a global constraint (directs to `monteCarloPrice`). Verified analytic ⇄ MC (8.02) and the global cap effect
  (7.39). See [`specs/cliquet.md`](./specs/cliquet.md).
- ✅ **Double one-touch / double no-touch** (`doubleTouch`, `@totalfinance/options`): the corridor binaries —
  DNT pays if the spot stays inside `(L, U)` for the whole life, DOT pays if it ever leaves. The
  **double-barrier survival** `P_stay` is the method-of-images series (source images `2n·d`, sink images
  `2b + 2n·d`; converges by `|n| ≤ 2`); `DNT = cash·e^{−rT}·P_stay`, `DOT = cash·e^{−rT}·(1 − P_stay)`, so
  `DNT + DOT = cash·e^{−rT}` exactly. Analytic + Monte-Carlo (product of the two single-barrier
  Brownian-bridge survivals) agree to the MC error; an already-breached corridor short-circuits. Builds on
  the single-barrier `touch`. See [`specs/double-touch.md`](./specs/double-touch.md). _Follow-up:_
  pay-at-hit (Kunitomo–Ikeda first passage) and per-barrier rebates (`doubleTouch.greeks` now ships).
- ✅ **Digital greeks** (`digital.greeks`, `@totalfinance/options`): closed-form delta/gamma/vega/theta/rho
  for the cash-or-nothing and asset-or-nothing binaries (call/put) — the risk the `digital` binaries were
  missing. Captures the **pin risk** traders fear: the cash-or-nothing delta spikes near the strike and
  its gamma flips sign across it. Package unit conventions (vega/point, theta/day, rho/1%, echoed in
  `assumptions.units`); returns `Computed<Greeks>`. Every greek pinned to a finite-difference bump of the
  exact `digital.price`, and to the vanilla decomposition `call = asset − K·cash`, `put = K·cash − asset`.
  **`digital.extendedGreeks`** completes them with the full higher-order set (vanna, charm, vomma, speed,
  color, phi, zomma, veta, vera, ultima, lambda) for both kinds — the binary price is smooth for `T > 0`, so
  the higher-order greeks are exact finite differences of `digital.price` (the shared FD helper), with
  analytic first-order fields; verified against an independent FD of the analytic greeks AND the vanilla
  decomposition of `blackScholesExtendedGreeks`. See [`specs/digital-greeks.md`](./specs/digital-greeks.md) and
  [`specs/digital-extended-greeks.md`](./specs/digital-extended-greeks.md). _Follow-up:_ closed-form
  higher-order binary greeks (exact at the pin), and one-touch/no-touch extended greeks.
- ✅ **Touch & double-touch greeks** (`touch.greeks`, `doubleTouch.greeks`, `@totalfinance/options`): the
  first-order greeks the barrier binaries were missing — delta/gamma/vega/theta/rho for one-touch/no-touch
  and the corridor double-no-touch/double-one-touch, by **central finite-difference of the exact price**
  (the first-passage / method-of-images forms have no clean robust analytic greeks). Package units, method
  disclosed. Pinned to the **exact identities** `one-touch(expiry) + no-touch = cash·e^{−rT}` and
  `DNT + DOT = cash·e^{−rT}`, so the pair's greeks sum to the constant's greeks (Δ,Γ,vega → 0; θ,ρ to the
  closed form) — leaving no room for a silent error; the spot bump is shrunk near a barrier so it never
  straddles it; a bumped-MC delta corroborates. `touch.greeks` honours `payAt`. See
  [`specs/touch-greeks.md`](./specs/touch-greeks.md). _Follow-up:_ analytic single-barrier touch greeks,
  higher-order (vanna/charm/vomma) and per-barrier corridor greek attribution.
- ✅ **Composite (compo) options** (`compo`, `@totalfinance/options`): the FX-floating sibling of the existing
  `quanto` — pays `(S_f(T)·X(T) − K_d)⁺` in domestic currency (foreign asset at the _prevailing_ FX rate,
  domestic strike). The composite `A = S_f·X` is a domestic asset drifting at `r_d − q`, so it's exactly
  `BSM(A₀ = S_f·X, K_d, T, r_d, q, σ_A)` with `σ_A = √(σ_S² + σ_X² + 2ρσ_Sσ_X)` — **the foreign rate drops
  out** (verified: a 2-factor MC gives the same price for `r_f` = 2% and 9%). Ships the full multi-factor
  risk — asset & FX deltas, asset gamma, dual vega, and the distinctive **correlation vega** (a compo is
  long correlation) — every greek matched to a finite-difference; plus a 2-factor correlated MC. See
  [`specs/compo-option.md`](./specs/compo-option.md). _Follow-up:_ compo forwards/digitals, a quanto-vs-compo
  helper, and cross-greeks (∂²C/∂S_f∂X).
- ✅ **Napoleon & reverse cliquet** (`napoleon`, `reverseCliquet`, `@totalfinance/options`): the third
  generation of the cliquet family (`forwardStart` → `cliquet` → these), completing the exotic-options
  catalogue. Both pay a fixed coupon degraded by the periodic returns and leave the investor **short vol** —
  napoleon by the **single worst** period return (`max(floor, C + minᵢ rᵢ)`), reverse cliquet by the **sum of
  the negatives** (`max(floor, C + Σ min(rᵢ,0))`) — so a higher vol _lowers_ the value. Priced by Monte-Carlo
  on the same per-period GBM as `cliquet`; reverse cliquet adds a **closed-form floorless value** (a strip of
  per-period expected negative returns via the existing `returnCaplet`) that equals the unfloored MC exactly
  and bounds the floored one. See [`specs/napoleon-reverse-cliquet.md`](./specs/napoleon-reverse-cliquet.md).
  _Follow-up:_ local per-period floors/caps, a napoleon analytic (needs the min of dependent lognormals), and
  short-vol greeks.

### Portfolio & risk

- ✅ **Multi-strategy portfolio ledger** (`analyzeBook`, `@totalfinance/risk`): a book of strategy
  positions across underlyings → net greeks, beta-weighted delta, total + per-position margin,
  concentration by name, per-position/per-underlying breakdowns, and an optional scenario roll-up.
  See [`specs/portfolio-book.md`](./specs/portfolio-book.md). _Follow-up:_ a dedicated futures
  instrument and correlated (cross-underlying) stress matrices.
- ✅ **Greek-based book VaR** (`bookVaR`, `@totalfinance/risk`): a delta-gamma Value-at-Risk / CVaR over a
  book of positions from each name's greeks + a risk-factor model (per-underlying spot vol,
  cross-underlying correlation, optional vol-of-vol) — a fast **parametric** (delta-normal) number and
  a **Monte-Carlo** (delta-gamma-exact, seeded) one, with a per-underlying standalone/component
  decomposition and a disclosed P&L drift — **now with a ✅ Cornish-Fisher gamma-adjusted analytic VaR**
  (`result.cornishFisher`): the parametric quantile corrected for the skewness/kurtosis the gamma induces,
  from closed-form cumulants of the delta-gamma quadratic form (no eigendecomposition), tracking the
  Monte-Carlo to ~0.1 % for a normal-ish book — and **gated on the CF validity domain**, so a too-convex
  book omits it with a `risk.cornish_fisher_out_of_domain` warning pointing to the exact Monte-Carlo
  (never a mis-reported number). See [`specs/book-var.md`](./specs/book-var.md),
  [`specs/cornish-fisher-var.md`](./specs/cornish-fisher-var.md). _Follow-up:_ a rate factor, spot–vol
  (leverage) correlation, a saddlepoint VaR for the out-of-domain regime, and historical/bootstrap book
  VaR once the data layer lands.
- ✅ **Return attribution** (`factorAttribution`, `brinsonAttribution`, `@totalfinance/risk`): the two
  classics, each an EXACT additive decomposition. **Factor P&L** regresses a return series on observable
  factor returns (`ols`) → per-factor exposure/t-stat/contribution + a specific (alpha) residual, with
  `totalReturn = specificReturn + Σ contributions` to machine precision (OLS residuals vanish).
  **Brinson** splits active return vs a benchmark into allocation/selection/interaction
  (Brinson–Fachler default + Brinson–Hood–Beebower), `= activeReturn` exactly, with any non-reconciling
  (unequal-weight) BF residual measured and disclosed. The statistical/PCA factor model already exists
  as `factorExposure`/`pca`. See [`specs/attribution.md`](./specs/attribution.md). Now with ✅
  **multi-period linking** (`linkAttribution`): single-period Brinson effects don't add up across periods
  (returns compound, arithmetic effects don't — the "linking problem"), so **Cariño's** logarithmic
  coefficients `βₜ = kₜ/k` scale each period's effects, making the cumulative allocation/selection/
  interaction sum **exactly** to the compounded (geometric) active return `∏(1+Pₜ)−∏(1+Bₜ)` — with the
  `1/(1+P)` L'Hôpital limit for flat-active periods, per-segment linking, and the `βₜ` returned for audit.
  A sequence of `brinsonAttribution` results links directly. See
  [`specs/attribution-linking.md`](./specs/attribution-linking.md). _Follow-up:_ Menchero/GRAP variants,
  multi-currency attribution, nested Brinson, and ex-ante risk attribution.
- ✅ **EVT tail-risk pack** (`fitGeneralizedParetoTail`, `extremeValueTailRisk`, `drawdownAtRisk`, `spectralRisk`,
  `@totalfinance/risk`): the honest fat-tail toolkit — normal/historical VaR under-state the left tail, so
  this fits the tail _shape_ with a **Generalized Pareto Distribution** (peaks-over-threshold; robust
  PWM by default, MLE with PWM fallback) and reads **extreme VaR + Expected Shortfall** (MonteCarloNeil–Frey)
  off it, always shown **beside the empirical and normal** numbers with a fat-tail ratio. Plus
  **Drawdown-at-Risk + Conditional Drawdown-at-Risk** (Chekhlov–Uryasev) and a coherent **spectral risk
  measure** (Acerbi; ES as the flat-tail special case). Estimators verified by recovering a known
  `(ξ,β)` from simulated GPD samples; EVT VaR cross-checked against a GBM/empirical tail. Discloses
  infinite-moment (`ξ≥1`/`ξ≥0.5`) and degenerate fits, and never extrapolates outside the fitted tail.
  See [`specs/evt-tail-risk.md`](./specs/evt-tail-risk.md). Now with ✅ **threshold selection**
  (`meanExcessPlot`): the mean-excess `e(u) = E[X−u | X>u]` is **linear above the true tail threshold**
  (slope `ξ/(1−ξ)`), so the plot tells you where the GPD tail begins — the single most consequential EVT
  choice the pack otherwise punts on. Returns the curve (with exceedance counts + standard errors), a
  heuristic **suggested threshold** (the lowest `u` where the exceedance-weighted curve is linear within a
  tolerance, warned when none is), the **tail-index estimate** `ξ = slope/(1+slope)`, and the
  **`suggestedTailFraction`** to hand straight to `fitGeneralizedParetoTail`. Verified: the slope recovers `ξ` on GPD data
  (0.31 vs 0.30) and the suggested threshold fits a consistent tail. See
  [`specs/mean-excess-plot.md`](./specs/mean-excess-plot.md). _Follow-up:_ a parameter-stability plot
  (`ξ̂(u)`/`β̂(u)`), a Hill plot, a bootstrap Max-Drawdown distribution, and multivariate tail-dependence EVT.
- ✅ **Kelly bet-sizing pack** (`kellyBet`, `@totalfinance/risk`): "how much of my account do I put on
  this?" from a trade's edge — a binary win/loss bet, a discrete payoff distribution, a Gaussian
  `μ/σ²`, or a raw return sample → the growth-optimal fraction `f*`, then sized _sanely_: half-Kelly by
  default, capped by an explicit **drawdown budget** (`P(ever falling to b×W₀) = b^(2/κ−1)`, verified
  against a GBM first-passage Monte-Carlo) and a hard cap, with the multi-period growth (doubling time,
  horizonPeriods projection), the "no edge → don't bet" / "≥2× Kelly → ruin" verdicts, and the fat-tail
  correction (exact empirical `f*` vs the Gaussian estimate) all disclosed. Distinct from the portfolio
  `kelly()` (`Σ⁻¹μ` weights). See [`specs/kelly-sizing.md`](./specs/kelly-sizing.md).
- ✅ **Estimation-error-shrunk Kelly** (`shrunkKelly`, `@totalfinance/risk`): the portfolio Kelly follow-up —
  the plug-in weights `Σ̂⁻¹μ̂` overbet because `μ̂`/`Σ̂` are estimated, so this scales them by the
  growth-optimal `c* = max(0, 1 − (n/T)/θ̂²)` (`θ̂² = μ̂ᵀΣ̂⁻¹μ̂`), returns a **zero book** when the edge is
  indistinguishable from sampling noise (`n/T ≥ θ̂²`), and flags when the **naive Kelly would lose money
  out-of-sample** (`g(1) < 0`). Derived from `g(c) = c·θ² − ½c²(θ²+n/T)` and verified against a
  Monte-Carlo over a known `(μ, Σ)` (MC-optimal scaling matches, shrunk OOS growth beats naive at every
  `T`). Complements the naive portfolio `kelly()` and the single-bet `kellyBet`. See
  [`specs/shrunk-kelly.md`](./specs/shrunk-kelly.md). _Follow-up:_ James–Stein `μ̂` shrinkage, and feeding
  the shrinkage into constrained `kelly()`.
- ✅ **Cost-aware Kelly** (`costAwareKelly`, `@totalfinance/risk`): completes the sizing trilogy (single-bet
  `kellyBet`, portfolio `shrunkKelly`, and now costs). A per-period holding cost plus an **amortized**
  round-trip cost `c = holdingCost + roundTripCost/horizonPeriods` shift the drift (`μ → μ − c`, variance
  unchanged), so the growth-optimal size shrinks to `netKelly = max(0, (μ−c)/σ²)` and below the breakeven
  cost `μ` the edge isn't worth betting. Reports gross vs net Kelly, the log-growth **drag** the costs
  impose, the penalty for naively betting gross while paying costs, and refuses a losing bet
  (`risk.cost_exceeds_edge`). Verified `netKelly` is the exact argmax of the cost-adjusted growth. See
  [`specs/cost-aware-kelly.md`](./specs/cost-aware-kelly.md). _Follow-up:_ costs on the discrete edges, a
  Davis–Norman no-trade band, and per-asset costs in the portfolio solve.
- ✅ **Ledoit–Wolf covariance shrinkage** (`ledoitWolfShrinkage`, `@totalfinance/math`): the estimation-error
  fix for the covariance itself — pulls the sample `S` toward the scaled identity `μI` with the
  analytically optimal intensity `δ = min(b̄², d²)/d²` (`d² = ‖S−μI‖²_F`, `b̄²` the sampling error in `S`),
  giving `Σ* = δ·μI + (1−δ)·S`. Always **SPD**, so it is invertible even when `T < p` (where the raw
  sample covariance is singular — the headline benefit for every optimizer/`Σ⁻¹` consumer). Lives in
  `math` beside `covarianceMatrix`; verified against a Monte-Carlo (closer to truth than `S`, 22% lower
  Frobenius error at `T=8`; `δ → 0` as `T` grows). A **`target: 'constant-correlation'`** option (the
  Ledoit–Wolf 2004 target — each variable's own variance with the **average** sample correlation on every
  off-diagonal, and the paper's `(π̂−ρ̂)/γ̂/T` intensity) fits correlated returns far better than the
  identity default and is passed through `estimateCovariance` via `ledoitWolfTarget`; verified 25–30% lower
  Frobenius error than `S` on a constant-correlation truth, `r̄` recovered, and `δ → 0` only when the target
  is _misspecified_ (a 1-factor truth). See
  [`specs/ledoit-wolf-shrinkage.md`](./specs/ledoit-wolf-shrinkage.md) and
  [`specs/ledoit-wolf-constant-correlation.md`](./specs/ledoit-wolf-constant-correlation.md).
  - ✅ **Single-index (market-model) target** (`target: 'single-index'`, `ledoitWolfTarget: 'single-index'`) — the
    Ledoit–Wolf 2003 `covMarket` structured estimator: a one-factor structure built from each variable's
    covariance with the equal-weighted market (`Fᵢⱼ = covmktᵢ·covmktⱼ/varmkt`, `Fᵢᵢ = Sᵢᵢ`) with the paper's
    market-specific intensity `ρ̂ = rdiag + 2·roff₁ − roff₃`. The best-specified target for stock returns.
    Verified on a heterogeneous one-factor Monte-Carlo: lower Frobenius error to the true Σ than the raw
    sample **and** than the identity- and constant-correlation-target shrinks; always SPD; `δ → 0` as `T`
    grows; reports the `marketVariance`. See [`specs/ledoit-wolf-single-index.md`](./specs/ledoit-wolf-single-index.md).
    _Follow-up:_ nonlinear (Ledoit–Wolf 2020) shrinkage.
- ✅ **`estimateCovariance` front door** (`@totalfinance/math`): the one call every `Σ⁻¹` consumer wants —
  turns a returns matrix into a **well-conditioned, usually-invertible** covariance and reports the
  **conditioning** (min/max eigenvalue, condition number, SPD-ness, effective rank) so the caller knows
  whether it is safe to invert. Methods `sample` (raw, flagged when singular), `ledoit-wolf` (always SPD),
  `ridge` (diagonal load `λI`), `auto` (sample when well-conditioned, else shrink), and now ✅ **`ewma`**
  (RiskMetrics exponentially-weighted, time-varying) — composing `covarianceMatrix`, `ledoitWolfShrinkage`,
  and `jacobiEigen`. Never silently returns junk: a singular sample is disclosed
  (`math.covariance_singular`), `auto` refuses it. The **EWMA** method weights recent observations more
  (decay `λ`, default 0.94, or a `halfLife`), demeaned with the EWMA mean and PSD by construction; it
  reports the **Kish effective sample size** `1/Σwₜ² ≈ (1+λ)/(1−λ)` and warns when that drops below the
  variable count — verified to reduce to the sample as `λ → 1` and to track a volatility regime the
  equal-weighted sample lags. Verified against a direct eigen-decomposition; each method equals the piece it
  composes. See [`specs/estimate-covariance.md`](./specs/estimate-covariance.md),
  [`specs/ewma-covariance.md`](./specs/ewma-covariance.md). _Follow-up:_ a paired `(μ̂, Σ̂)` estimator, an
  EWMA correlation/vol decomposition, a streaming update, and wiring the front door into the optimizers.

### Fixed income

- ✅ **Bond futures & cheapest-to-deliver** (`bondFuture`, `conversionFactor`, `bondFutureHedge`,
  `bondFutureCtdFrontier`, `@totalfinance/fixed-income`): the CME/CBOT **conversion factor** (whole-quarter rounding, 6% notional —
  pinned to Hull's 1.4623 and the at-par 1.0000), then per-deliverable **gross/net basis**, **carry**, and
  the exact break-even **implied repo rate** across the delivery basket, selecting the **CTD** as the
  max-implied-repo (⇔ min-net-basis, agreement asserted) bond. Composes the existing `Bond` accrued-interest
  - cash-flow machinery; exchange conversion-factor overrides supported; the semiannual-coupon assumption is
    disclosed. **`bondFutureHedge`** adds the desk's risk view: the **futures DV01** (`= CTD DV01 / CF`, Hull),
    the **DV01 hedge ratio** (`positionDV01 / futuresDV01` contracts — exactly `CF` to hedge the CTD itself),
    per-deliverable DV01, and the **futures-implied forward yield** (the CTD yield at forward clean price
    `F·CF`) — composing `bondFuture` + `yieldToMaturity`/`yieldMetrics`, verified `ctdDV01` against a
    finite-difference reprice and the forward yield against an exact round-trip. See
    [`specs/bond-future-ctd.md`](./specs/bond-future-ctd.md) and
    [`specs/bond-future-hedge.md`](./specs/bond-future-hedge.md). **`bondFutureCtdFrontier`** adds the
    Wave 6 **CTD switching frontier**: reprices the whole basket under a parallel-yield (and optional
    futures-price) scan, detects CTD switches, and root-refines each switch by re-evaluating the global
    basket—so a narrow intermediate CTD splits into two honest transitions and no pairwise root off the
    frontier is accepted—plus the **delivery-date futures DV01** from the CTD's implied forward yield
    (distinct from the spot cash DV01 / CF). This is a ceteris-paribus switching frontier, **not**
    delivery-option valuation (still deferred). See
    [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md#wave6-ctd-frontier).
- ✅ **Inflation analytics** (`tipsIndexRatio`, `breakevenInflation`, `cpiSeasonality`,
  `@totalfinance/fixed-income`): the three tools an inflation desk reaches for, over the existing linker
  machinery. **`tipsIndexRatio`** — the US-Treasury reference-CPI daily interpolation (3-month lag,
  `(t−1)/D` over the settlement month's days) + the 5-dp index ratio (base supplied or interpolated from a
  `datedDate`). **`breakevenInflation`** — nominal − real breakeven, arithmetic and exact Fisher-
  compounded, with the standard `expected = breakeven − riskPremium + liquidityPremium` decomposition.
  **`cpiSeasonality`** — 12 multiplicative seasonal factors from an NSA history via the classic ratio-to-
  2×12-moving-average (recovers known factors to <1e-5, normalized to average 1). See
  [`specs/inflation.md`](./specs/inflation.md).
- ✅ **Zero-coupon inflation swap** (`zeroCouponInflationSwap`, `@totalfinance/fixed-income`): the standard
  inflation instrument — the par ZCIS rate **is** the geometric breakeven, `(1+K)^N = I(T)/I(0)`. Supply the
  market rate or the forward index ratio (each implies the other); supply a `contractRate` to mark a
  position (`MTM = ±notional·DF·[(1+parRate)^N − (1+contractRate)^N]`, pay-fixed gains as the par rate
  rises). Deterministic forward-measure — no inflation-vol model. Verified: par round-trips both directions,
  MTM is 0 at par and signs correctly, the two payers are exact negatives. _Follow-up:_ year-on-year swaps
  (with the convexity adjustment), a curve-based breakeven **term structure**, and X-13/STL seasonality.
- ✅ **Swaption cube (SABR-on-rates)** (`swaptionCube`, `swaptionCubeVolatility`, `@totalfinance/volatility`): the
  interest-rate vol surface — implied vol over option **expiry × swap tenor × strike**. Quote-driven like
  the SSVI surface: each `(expiry, tenor)` node carries a forward swap rate + a market smile, calibrated to
  a **SABR smile per node** (reusing `calibrateSabrSmile`), then **bilinear interpolation of the SABR params**
  across the grid gives the vol at any `(expiry, tenor, strike)` — with node fit-quality and grid
  extrapolation disclosed. Built in `@totalfinance/volatility` (not `fixed-income`) as a vol object on the existing
  SABR machinery, adding no package edge; pricing is `annuity · Black(forward, strike, cubeVolatility, expiry)`
  with the caller's annuity. Recovers known SABR params to ~1e-13; interpolation bounded by its nodes.
  **Shifted (displaced) SABR** (`shift` option) calibrates and evaluates on `forward + s` / `strike + s`
  so **negative-rate** cubes work (EUR/JPY/CHF): `shift = 0` leaves the classic path byte-identical, the
  vol becomes a shifted-lognormal vol (priced with Black on the shifted rates — normal/Bachelier vols are
  unchanged), and the shift is disclosed on the cube + its `assumptions`; recovers known params to ~1e-11
  through a negative forward and reproduces the smile at negative strikes to ~1e-13.
  See [`specs/swaption-cube.md`](./specs/swaption-cube.md) and
  [`specs/swaption-cube-shift.md`](./specs/swaption-cube-shift.md). ✅ **Curve-driven forwards/annuity**
  — `forwardSwap(curves, spec)` (`@totalfinance/fixed-income`) returns the forward swap rate + annuity from a
  live OIS/projection curve in one call (`= swapValue`'s par rate/annuity, purpose-named for the swaption
  recipe `annuity · Black(forward, strike, cubeVolatility, expiry)`), so the cube's forward/annuity come from a
  bootstrapped curve rather than stale market nodes; no vol↔fixed-income coupling. _Follow-up:_ a per-node
  shift term structure, variance-linear expiry interpolation, and cube vega/vanna/volga.
- ✅ **OAS analytics** (`oasAnalytics`, `@totalfinance/fixed-income`): completes the callable-bond story on the
  short-rate lattice. `callableBond` already returns a bare option-adjusted spread; this adds the
  decomposition desks actually quote — the **OAS**, the **Z-spread** (the σ-free spread on the same tree's
  straight leg), the **option cost** (`zSpread − oas`: positive for a callable, negative for a putable), and
  the **OAS-consistent effective duration & convexity** (the curve shocked with the spread held fixed, so
  `P₀` recovers the market price exactly — distinct from `callableBond`'s zero-spread model duration). Both
  spreads are solved on the one lattice so the option cost is pure optionality. Verified: callable `+30 bps`
  / putable `−72 bps` option cost, and an unreachable option collapses OAS→Z within `0.04 bp`. See
  [`specs/oas-analytics.md`](./specs/oas-analytics.md). ✅ **OAS over a non-flat spread curve** — an
  optional `spreadCurve` is added to the benchmark (continuous zeros add ⇔ discount factors multiply,
  rebuilt from zeros so the reference pillar isn't degenerate), so the OAS/Z-spread are measured over a
  term-structure benchmark (e.g. an OIS discount curve plus a sector/rating spread) rather than a flat
  one; a flat σ shifts the OAS by exactly −σ, a zero spread is a no-op. _Follow-up:_ key-rate (partial)
  durations and the embedded option's volatility sensitivity.
- ✅ **Multi-curve (dual-curve, OIS-discounted) bootstrapping** (`curves.bootstrapProjection`,
  `curves.bootstrapMultiCurve`, `@totalfinance/fixed-income`): the construction side of the post-2008
  framework, completing the already-dual-curve valuation (`swapValue`/`swaptionPrice`/`capFloorPrice`
  all take `{ discountCurve, forecastCurve }`). `bootstrapProjection` builds an index **projection
  curve** from par IRS quotes whose fixed leg `K·Σ τ·D(t)` and floating leg `Σ Fⱼ·τ·D(t)` (forwards
  `Fⱼ` off the curve being built, discount factors `D` from a **separate OIS curve**) are solved to par
  — the float no longer telescopes, so each terminal projection DF is a 1-D Brent solve reusing
  `swapValue`'s exact conventions; deposits/FRAs/futures pin the short end closed-form. `bootstrapMultiCurve`
  is the one-call front-door: OIS discount curve + projection curve → a ready `{ discountCurve,
forecastCurve }`. Verified to machine precision: recovers a known projection curve (DF err ~3e-16)
  and reprices its inputs to par under the real pricer (~1e-10); single≡dual consistency when discount
  == projection. See [`specs/multi-curve-ois.md`](./specs/multi-curve-ois.md). _Follow-up:_ turn-of-year
  step curves and a per-instrument basis overlay.
- ✅ **Cross-currency basis** (`crossCurrencyBasisCurve`, `impliedCrossCurrencyBasis`,
  `@totalfinance/fixed-income/cross-currency`): completes the multi-curve story. Post-2008 a foreign cash
  flow collateralized in the domestic currency is discounted on a basis-adjusted foreign curve, not the
  foreign OIS. `crossCurrencyBasisCurve` builds the **domestic-collateralized foreign discount curve**
  `D_for^dom = foreign.addSpread(basis)` (basis optional → pure covered-interest-parity) and its FX
  forwards `F(0,t) = spot · D_for^dom(t)/D_dom(t)` (domestic per foreign); `impliedCrossCurrencyBasis` is
  the exact inverse — back out the basis term structure from market FX forwards. Pure curve arithmetic
  (no FX feed), composing `bootstrapMultiCurve` + `YieldCurve.addSpread`. Verified: no-basis reproduces
  the foreign curve (1e-12), the `D_for^dom = F·D_dom/spot` consistency (1e-12), and round-trip basis
  recovery to ~1e-17. See [`specs/cross-currency-basis.md`](./specs/cross-currency-basis.md). _Follow-up:_
  bootstrap the basis from MtM xccy basis-swap par quotes; tri-currency triangulation.

### Crypto

- ✅ **Inverse (coin-settled / Deribit-style) options** (`inverseOption`, `@totalfinance/options`): the first
  crypto-native analytics — Deribit BTC/ETH options settle `(±(S_T−K))⁺/S_T` in the coin, so the coin
  premium is exactly the vanilla `blackScholesPrice/spot` (confirmed by a coin-numeraire Monte-Carlo where the spot
  drifts at the self-quanto rate `r−q+σ²`). The value-add is the **coin greeks**: differentiating
  `V_usd/S` gives `Δ_coin = Δ_usd/S − V_coin/S` and `Γ_coin = Γ_usd/S − 2Δ_usd/S² + 2V_usd/S³` (vega/theta/
  rho just scale by `1/S`) — the `−V_coin/S` delta term is the embedded short-coin from the coin-denominated
  premium, so an inverse option is **not** hedged at its Black–Scholes delta. `greeks` returns both the
  `coin` and the `usd` (vanilla) risk; inverse put-call parity `C_coin − P_coin = e^{−qT} − (K/S)e^{−rT}`
  holds. See [`specs/inverse-option.md`](./specs/inverse-option.md).
- ✅ **Coin-settled binaries & barriers** (`inverseOption.digital`, `inverseOption.barrier`): the coin-settled
  binary/barrier premium via the **universal** identity — a coin payoff `H(S_T)/S_T` is worth `H(S_T)` USD at
  expiry, so `coinPrice = vanillaUsd/spot` for ANY exotic (not just the vanilla). Composes the already-tested
  `digital`/`barrier` pricers ÷ spot. Verified: a coin-numeraire Monte-Carlo of the real coin payoff converges
  to `vanillaUsd/spot` (digital & barrier); the coin-settled asset-or-nothing call equals the BSM delta
  `e^{−qT}N(d1)`; in–out parity reconstructs the vanilla. _Follow-up:_ coin-settled **touch** (rebate-leg
  numeraire), inverse futures/perps hedge, and USD-collateralized (linear) crypto options.
- ✅ **Perpetual & futures carry** (`perpetualFunding`, `futuresBasis`, `predictedFunding`,
  `fundingBasisSpread`, **`@totalfinance/crypto`** — the first package in the Crypto tier): the annualized,
  comparable, no-arbitrage-grounded numbers every crypto trader watches. `perpetualFunding` annualizes a funding
  rate into its implied cost-of-carry (simple + compounded, long/short signs explicit); `futuresBasis`
  decomposes a dated future's basis and, given financing, the fair future + cash-and-carry edge (richness
  and `carryArbitrage`, exactly 0 at the no-arb future); `predictedFunding` is the venue (Binance-style)
  `premium + clamp(interest − premium, ±clamp)` formula; and `fundingBasisSpread` is the flagship
  cross-instrument signal — the perp's funding-implied carry vs the future's basis-implied carry are the
  same number in equilibrium (both = `r − q`), so their spread is `future-rich`/`perp-rich`. Deterministic,
  browser-safe, `@totalfinance/core`-only; extreme funding and live arbitrage are disclosed `crypto.*` warnings.
  See [`specs/crypto-carry.md`](./specs/crypto-carry.md). _Follow-up:_ inverse-future/perp (Deribit)
  conventions (the hedge for the inverse-option coin delta), a funding term-structure / carry curve, and
  options-implied carry reconciliation.
- ✅ **Inverse (coin-margined / Deribit-style) futures & the coin-delta hedge** (`inverseFuture`,
  `inverseHedge`, `@totalfinance/crypto`): closes the loop with the inverse _option_. Inverse contracts are
  denominated in USD but margined/settled in the coin, so the coin PnL `s·Q·(1/entry − 1/mark)` is
  **non-linear** — the coin delta is `Q/mark²` (not constant) and a long inverse future is **short gamma in
  coin** (both pinned to a finite-difference). `inverseHedge` sizes the future/perp to `|D|·mark²` to
  neutralize any coin delta `D` (equal-and-opposite by construction) and reports the residual coin gamma the
  delta hedge leaves; a cross-package test confirms it **neutralizes a real `inverseOption` coin delta to
  exactly 0**. See [`specs/inverse-future.md`](./specs/inverse-future.md). _Follow-up:_ a basis-adjusted
  hedge for a dated future, and funding-aware hedge carry.
- ✅ **Liquidation & bankruptcy price** (`liquidationPrice`, `@totalfinance/crypto`): the most-watched number for
  a leveraged trader, for **inverse** (coin-margined) and **linear** (USDT-margined) perps/futures. Isolated,
  mark-based maintenance (the exact mark-to-market definition — liquidation is where equity first equals the
  maintenance margin; the entry-notional venue variant is disclosed in `assumptions.marginBasis`). In terms
  of `IMR = 1/leverage` and `MMR = m` the four closed forms are size-independent (e.g. inverse long
  `F₀·(1+m)/(1+IMR)`), plus the bankruptcy price (the `m = 0` case). **Verified against its own definition:**
  substituting the returned price back gives `equity == maintenance margin` (~1e-10) for all four
  inverse/linear × long/short, and `equity == 0` at bankruptcy. See
  [`specs/perp-liquidation.md`](./specs/perp-liquidation.md). _Follow-up:_ cross margin, fee/funding buffers,
  tiered maintenance margin.
- ✅ **Carry curve / futures term structure** (`carryCurve`, `@totalfinance/crypto`): the term-structure
  companion to `futuresBasis` — from a spot + a set of dated futures it builds each expiry's implied carry
  (composing `futuresBasis` verbatim), the **forward carry** the market prices between consecutive expiries
  (the crypto forward-rate analogue; `ln(Fᵢ/Fᵢ₋₁)/Δt`, tiling the curve), a **shape** classification
  (upward/downward/humped contango, backwardation, flat) off the forward sequence, and the carry at any
  interpolated tenor (log-linear in `ln F`, flat-forward beyond the ends). Verified: a constant-carry curve
  is flat in both the per-expiry and forward carries, interpolation reproduces the nodes and is exact for
  constant carry. See [`specs/carry-curve.md`](./specs/carry-curve.md). _Follow-up:_ splicing a perp's
  funding-implied carry onto the front, a monotone (no-arb) interpolation, and a realized-vs-implied
  forward-carry backtest.
- Remaining crypto: a realized-funding basis-trade backtest (once the data layer lands); coin-settled
  binaries/barriers; options-implied carry reconciliation. The 24/7 calendar already exists
  (`@totalfinance/calendars`).

## Tier 3 — the moats nobody else will build

### Live layer — ⏸️ DEFERRED (revisit only with a concrete real-time consumer)

Deferred by decision (2026-07-21): this is **infrastructure/plumbing, not quant math**. A pure library
can't own the socket, so "live" is inherently a thin stateful wrapper over the batch analytics — and
"call the batch function per tick" covers most of it. Its value is real only paired with a concrete
real-time consumer (the InsiderFinance platform + the CF realtime prices WS); the quant **core**
(models, instruments, analytics) is a better use of effort under the "insanely complete functionality"
priority. Revisit when a live consumer makes it concrete — the **incremental GEX/flow aggregator** is the
one genuinely differentiated piece (avoids O(n) recompute per print) and would be the first to build.

- Streaming greeks/P&L: a position subscribed to a quote stream re-values incrementally
  (pairs with the CF realtime prices WebSocket). _Thinnest — `Position.value()` + per-tick difference._
- Incremental structure: streaming GEX/flow aggregation (the batch analytics, updated per print).
  _Most valuable — real incremental efficiency at high frequency._
- Alerting primitives: the signal DSL evaluated live with hysteresis/debounce → typed alert events.
  _App-level plumbing._

### Strategy intelligence

- ✅ **Strategy optimizer** (`optimizeStrategy`, `@totalfinance/strategy`): inverts the calculator — given a
  thesis (target price + uncertainty vol, or a drift/custom density), searches structures × strikes ×
  **expiries** and ranks by expected P&L **under the thesis** (not the market's risk-neutral measure),
  reusing `scanStrategies` for enumeration + risk metrics + materializable legs. Objectives:
  thesisExpectedValuePerRisk / thesisExpectedValuePerCapital / thesisExpectedValue / thesisProbabilityOfProfit + the market-implied pop/ev/return.
  Capital-normalized ranking and opt-in admissible Kelly sizing shipped in Wave 6; see
  [`specs/strategy-optimizer.md`](./specs/strategy-optimizer.md) and
  [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md#wave6-optimizer-sizing). The explicit
  opt-in undefined-risk scanner expansion is settled in the
  [`Phase 3B decision ledger`](./specs/phase-3b-decision-ledger.md#adjacent-governed-decision-not-a-phase-3b-blocker).
  Calendars across the expiry chain remain later inventory.
- ✅ **What-if cube** (`Position.whatIfCube`, `@totalfinance/strategy`): the position marked over the full
  spot × vol-shock × days-forward grid as a navigable cube (axes + row-major cells with P&L + live
  greeks), plus the **optimal-exit surface** — for each (spot, vol) outcome, the day along the time axis
  that optimizes P&L (`max-pnl`/`min-pnl`) — and the global best/worst cells. `scenarioTable` extended a
  dimension: every cell is a `value()` mark (time-aware, per-leg-IV, multi-expiry-correct), so a
  short-premium book optimally exits latest (decay helps) and a long-premium one earlier, from one
  lookup. **Wave 6 §3** adds an always-present **break-even-time** surface (first non-negative-P&L day
  per (price, vol)) and opt-in **probability weighting**: a per-day spot distribution (GBM by
  measure — riskNeutral/realWorld/explicit, no silent zero drift — or a custom density), midpoint-bin
  mass with disclosed tails, and per-(vol, day) expected P&L, sharing the `priceGridDistribution`
  quadrature with the optimizer and converging to `probability().expectedValue` at expiry. See
  [`specs/what-if-cube.md`](./specs/what-if-cube.md) and
  [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md#wave6-cube-probability).
  A rendered heatmap remains later `@totalfinance/viz` inventory.
- ✅ **Zero-dep payoff SVG rendering** (`payoffSvg`, `@totalfinance/strategy`): turns any `Position` into a
  self-contained `<svg>` payoff diagram — profit/loss shaded, breakevens, spot, max-P&L guides, optional
  current-P&L curve, light/dark themes — composing `chartData()` + `metrics()`, no deps / external refs
  (CSP-safe). See [`specs/payoff-svg.md`](./specs/payoff-svg.md). _Follow-up:_ equity-curve / drawdown
  SVG for backtests and a scenario heatmap (spot × vol/time), in a dedicated `@totalfinance/viz` package once
  rendering grows beyond the payoff diagram.

### Agent-native

- **Durable agent portfolio workflows:** build, persist, replay, and analyze a versioned portfolio
  across calls and transports through explicit scoped handles—not hidden MCP connection/session state.
  The ledger, workflow, simulation, authorization, and execution boundaries are specified in
  [`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md).
  Queue placement is explicit in the
  [`implementation-order.md` agent-platform crosswalk](./implementation-order.md#7-agent-workflows-transports-apps-remote-operation-and-live-state):
  the durable ledger lands with the platform core, while transports, evaluation, authorization,
  hosting, and any separately approved broker edge follow their stated prerequisites.
- ✅ **"Explain this position" narrative** (`explainPosition`, `@totalfinance/strategy`): composes
  `classifyStrategy` + `metrics` + `pnlAtExpiry` (market-free directional/move posture) + `probability`
  - `value().greeks` into a structured explanation **and a prose summary** an agent relays — every claim
    grounded in an engine number, degrading gracefully without a market. See
    [`specs/explain-position.md`](./specs/explain-position.md). _Follow-up:_ a scenario narrative
    (`scenarioTable`) and pairing the prose with a `payoffSvg` picture.
- ✅ **Research-protocol pack** (`researchProtocol`, `@totalfinance/risk`): one call that renders a
  statistically honest verdict on a research process — deflate the selected strategy's Sharpe for the
  number of trials (Bailey & López de Prado), confirm it survives out-of-sample, and return
  `significant` / `inconclusive` / `likely-overfit` with a grounded prose rationale (plus MinTRL and
  the un-deflated PSR for comparison). Only deflation **and** out-of-sample survival earns
  `significant`, so honest research is the path of least resistance. Composes `sharpeStatistics` +
  `deflatedSharpeRatio` + `probabilisticSharpeRatio`. See [`specs/research-protocol.md`](./specs/research-protocol.md).
- ✅ **Probability of backtest overfitting** (`probabilityOfBacktestOverfitting`, `@totalfinance/risk`): the
  Bailey & López de Prado **CSCV** lens — from a `T×N` matrix of per-config returns, over every `C(S,S/2)`
  symmetric train/test split, pick the in-sample-best config and measure its out-of-sample rank; PBO is the
  fraction of splits where the IS winner lands below the OOS median (logit `λ < 0`). Near `0.5` = the
  selection is worthless out of sample; near `0` = a persistent edge. Block-aggregate Sharpe keeps it
  `O(C(S,S/2)·N·S)`. Verified: a persistent edge → PBO 0 (median logit > 0), pure noise → a non-degenerate
  PBO (~0.5 averaged), and trimming/guards. _Follow-up:_ run the walk-forward for the caller, a deflated
  Sortino/Calmar variant, and the PBO performance-degradation & stochastic-dominance companions.
- More packs: a fixed-income pack, a vol-surface pack; llms.txt served as an MCP resource.
- ✅ **Leaner TA discovery** (`describeIndicator`/`searchIndicators`/`indicatorWarmup` in
  `@totalfinance/technical-analysis`; `totalfinance.technical_analysis.describe` + a searchable/paginated `totalfinance.technical_analysis.list` over MCP): the
  targeted discovery paths for the ~335-indicator catalog. `technical_analysis.describe(name)` returns one indicator's
  full card — params, defaults, required, **warmup** (measured on demand), input kind, and
  cross-library aliases — alias-aware (`describe('RSI')` → `rsi`). `technical_analysis.list` gains a name/alias
  **search**, `limit`/`offset` **pagination**, and a `total` count, while its default payload stays
  byte-for-byte backward-compatible. **Wave 6 §4** adds a **typo-tolerant** `searchIndicators`
  (deterministic Damerau–Levenshtein `match`/`minScore` with inspectable evidence) and **exhaustive
  output metadata** — a recursive value schema (scalar / record / vector) + optional visualization on
  every one of the 335 built-ins, required by `register`/`defineIndicator`, exposed identically through
  describe / search / registry Markdown, and verified against runtime for all 335. See
  [`specs/ta-discovery.md`](./specs/ta-discovery.md) and
  [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md#wave6-ta-metadata).
  A static per-indicator MCP resource remains later inventory.

### Hosting the MCP (local first, remote later)

The stdio server is ready to ship and promote **locally today** — pure compute, read-only-capable,
schema-validated, envelope-honest, and now with Monte-Carlo path counts capped in-schema so a bad
request is rejected before any work starts. A **publicly hosted remote server** should wait behind:

- **Pre-compute budgets, generalized.** The MC sample cap is the first instance; extend it to a
  uniform "estimate the cost, reject before running" guard across every tool (the request deadline
  only reports failure _after_ a synchronous compute finishes — too late to prevent CPU/OOM).
- **Auth, tenancy, rate limits, and activity history** — none of which a compute-only wrapper needs,
  all of which a hosted multi-tenant service does.
- **The data/resource layer below** — so tools take a dataset/resource ID instead of routing
  thousands of rows through the model's context.
- **Reproducible scenario links** — a tool result can reference a saved, replayable TotalFinance
  scenario (inputs + conventions + seed), so research is shareable and auditable.

A hosted compute-only wrapper isn't worth the operational and security burden; the hosted version
earns its keep once it unlocks authenticated data, saved research, shareable scenarios, and
long-running jobs. (Assessment confirmed by an external MCP review, July 2026.)

### Data handles for the MCP (pairs with the data layer, §1.1)

- Local dataset handles (CSV / file / user adapter) and, later, hosted authenticated handles.
- Tools accept a dataset/resource ID; the server resolves rows server-side instead of through the
  LLM (fixes the 64 KB / context-cost ceiling on chains and histories).
- Every result keeps source + timestamp + version + transformation provenance (the propagation the
  data layer already specifies).
- Retire the aspirational `screen-options-chain` prompt's assumption of a chain the server can't yet
  fetch — it becomes real once handles exist.

### Interop

- Python bridge (WASM-backed or subprocess with the JSON schemas the library already exports) so
  pandas users can call TotalFinance without leaving their notebook — evaluate demand before building.

---

_Ideas graduate from this document into `totalfinance-spec.md` sections with workstreams before any
code is written — same as phases 0–6._
