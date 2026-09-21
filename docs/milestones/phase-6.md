# Phase 6 — Fixed Income

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

Phase 6 ships **`@totalfinance/fixed-income`** (spec §14): bonds, yield curves and bootstrapping, rates
derivatives, short-rate models, and credit. The package builds on `@totalfinance/core` (dates, day counts,
calendars, errors), `@totalfinance/math` (solvers, interpolation, the normal distribution), and
`@totalfinance/options` (the convertible-bond engine reuses `equityLattice`). The Black and Bachelier
forward-option formulas used by swaptions/caps/floors are implemented inline on `math.normalCdf`.
Everything is browser-safe and clock-free: every function takes explicit ISO dates, market data, and an
injected valuation date, and bad inputs throw rather than silently degrading.

The module set maps one-to-one onto the spec, each its own sub-path import (`./conventions`, `./curves`,
`./bonds`, `./rates`, `./models`, `./credit`) re-exported from the umbrella entry.

## Conventions (`./conventions`, spec §14)

The shared primitives every other module builds on. Day counts extend the three in `@totalfinance/core`
(`ACT/365F`, `ACT/360`, `30/360`) with the two fixed income needs — **`ACT/ACT`** (ISDA, calendar-year
split) and **`30E/360`** (Eurobond). **Business-day adjustment** (`following` / `modifiedFollowing` /
`preceding` / `modifiedPreceding` / `unadjusted`) rolls against an injectable `@totalfinance/core` calendar,
defaulting to weekends-only so callers need no holiday data. **Coupon-schedule generation** rolls
backward from maturity at the coupon interval — the market default — placing any irregular stub at the
front, with month-end snapping auto-detected from the maturity date and an optional settlement lag on
payment dates. Plus the calendar arithmetic (`addMonths` with day clamping/EOM, `isLeapYear`,
`daysInYear`, `isEndOfMonth`, `compareDates`).

## Curves (`./curves`, spec §14.2)

`YieldCurve` stores **continuously-compounded zero rates at pillar times**; discount factors, zero
rates in any compounding (`continuous`/`simple`/`annual`/`semiannual`/`quarterly`/`monthly`/explicit
frequency), simple forwards, and instantaneous forwards all derive from those consistently.

- **Constructors** (`curves.*`): `zeroRate` (the §14.2 example builder), `discountFactor`, `flat`, and
  `bootstrap`. Five **interpolation** policies — `logLinearDiscount` (market default ⇒ piecewise-constant
  forwards), `linearZero`, `linearDiscount`, `cubicZero` (natural spline), `pchipZero` (monotone) — and
  three **extrapolation** policies (`flatForward`/`flatZero`/`throw`).
- **Curve risk**: a `shift(Δ)` parallel zero bump and `bumpPillar(i, Δ)` key-rate bump, both returning
  new immutable curves — the engine behind DV01 and key-rate duration.
- **Bootstrapping**: deposits, FRAs, futures (with a caller-supplied convexity adjustment — never
  fabricated), OIS, and par swaps, processed in ascending maturity. Money-market legs are closed-form;
  OIS/swaps solve the terminal discount factor from the single-curve identity
  `s · Σ τᵢ·DF(tᵢ) = 1 − DF(T)` with intermediate coupon discount factors interpolated through the trial
  pillar. **Multi-curve** pricing is handled at the rates layer: a discount curve and a forecast curve
  are just two `YieldCurve`s.

## Bonds (`./bonds`, spec §14.1)

Constructors for **fixed-rate**, **zero-coupon**, **floating-rate** (coupons projected off a forecast
curve), **amortizing** (straight-line / level annuity / explicit principal schedule), and
**inflation-linked** (index-ratio uplift with an optional deflation floor) bonds — each a `Bond` with
life cash flows, settlement-relative future cash flows, and accrued interest.

Analytics: **clean/dirty price**, **accrued interest**, **yield to maturity**, **yield to call** (on a
synthetic call-truncated bond), **Macaulay / modified / effective / key-rate duration**, **convexity**,
and **DV01/PV01**. Yield-based metrics use the unambiguous **actuarial ("true yield")** convention —
`(1 + y/f)^(−f·τ)` — which handles stubs and zero-coupons uniformly and gives closed-form duration and
convexity. **Curve-based** effective/key-rate measures reprice against a `YieldCurve` and its shocks
(an FRN correctly shows ~zero effective duration because its coupons reset with the shocked curve), and
`priceMultiCurve` discounts on one curve while projecting floating coupons off another.

## Rates derivatives (`./rates`, spec §14.3)

The **Black-76** (lognormal-forward) and **Bachelier** (normal-forward, handles negative rates) option
cores, then: **FRAs** (`N·τ·(F − K)·DF`), **swaps / OIS** (par rate, value, annuity/PV01, multi-curve),
**European swaptions** (priced as `annuity · ForwardOption(S, K, σ, T)` under the annuity measure),
**caps / floors** (a strip of Black/Bachelier caplets/floorlets), and **CMS** (the convexity-adjusted
forward swap rate, `Δ = −½·y₀²·σ²·T·G''/G'` on the par-bond function `G(y)`). Verified against
no-arbitrage identities: swaption put-call parity `payer − receiver = A·(S − K)`, cap − floor = the
payer swap on the same schedule and strike, and the CMS adjustment scaling with `σ²·T` and the
underlying swap tenor.

## Short-rate models (`./models`, spec §14.3)

- **Vasicek** and **CIR** — affine discount bonds `P = A·e^{−B·r}`, zero rates, and short-rate moments;
  Vasicek adds the **Jamshidian** zero-coupon-bond option (⇒ analytic caplet/floorlet).
- **Hull-White** (extended Vasicek) — fit to the initial curve, reconstructing market discount factors
  exactly and pricing ZCB options/caplets directly off the market curve.
- **Black-Karasinski** — the lognormal short rate has no closed-form bond price, so it is priced on a
  **Hull-White / Black-Karasinski trinomial tree** (shared engine, `model` selector) calibrated to the
  input curve by forward induction: stage 1 lays out the symmetric mean-reverting state tree, stage 2
  shifts each slice by `α(t)` to reprice every grid discount factor (closed-form for Hull-White, a 1-D
  solve per step for the lognormal Black-Karasinski). The tree reprices the curve to machine precision
  and keeps the short rate strictly positive.

## Credit (`./credit`, spec §14.4)

`SurvivalCurve` stores a **piecewise-constant forward hazard** so `Q(t) = exp(−∫λ)` is log-linear between
pillars — built from hazard pillars, from survival probabilities, flat, or **bootstrapped from a CDS
par-spread term structure**. **CDS pricing** values the premium leg (with accrual-on-default) and the
protection leg (`(1 − R)` over a fine default-timing grid), giving value, par spread, and risky annuity;
the bootstrap reprices every quoted CDS to par. Plus the **par-spread term structure**, the
**credit-triangle** hazard approximation (`λ ≈ s/(1 − R)`), and the **CDS-bond basis** helper.

## Verification

**110 tests** across the seven modules, anchored on closed forms and no-arbitrage identities rather than
self-consistency: par bonds priced to exactly 100, DV01 matched to a finite-difference of price,
key-rate durations summing to the parallel duration, cap−floor = payer-swap and swaption put-call
parity, the CMS convexity adjustment's `σ²·T` scaling, the survival/hazard round-trips, the bootstrap
and tree calibrations reproducing their inputs, and the model affine/Jamshidian formulas. A runnable
`docs/examples/fixed-income.test.ts` walks the headline workflow. Full `pnpm run ci` green; whole
workspace **→ 2,299 tests**.

## Phases 1–6 completeness pass

With the §14 spine in place, a sweep closed every remaining **now-buildable** gap across phases 1–6 —
both spec-"later" items the new foundations unblock and in-scope items not previously built. All tested;
whole workspace **→ 2,403 tests**.

- **`@totalfinance/math` (§7/§8.3–8.5):** `LU`/`QR`/`SVD` factorizations + `matMul`/`transpose`/`matVec` and
  the Moore–Penrose `pseudoInverse`; **differential evolution** (seeded global optimizer); **bicubic**
  surface interpolation; and a **general (non-symmetric) eigensolver** (`eigenvalues`/`eigen` via
  Hessenberg + Francis double-shift QR, with inverse-iteration eigenvectors for real eigenvalues).
- **`@totalfinance/options` (§9.3):** the rest of the exotics surface — **spread** (Kirk + MC), **quanto**
  (closed form), **basket** (Levy moment-match + MC), **rainbow** (max/min MC), **autocallable** notes
  (MC), and **variance / volatility swaps** (Heston fair variance + Brockhaus–Long convexity).
- **`@totalfinance/vol` (§10.1):** **Dupire local-volatility surface fitting** — a derived `LocalVolSurface`
  (with a cached grid) extracted from any implied-vol function or a fitted `VolSurface`.
- **`@totalfinance/strategy` (§12.6):** **Monte-Carlo probabilities** (`probabilityMC`) — seeded POP / EV /
  prob-of-touch (Brownian-bridge corrected), cross-validating the closed-form metrics.
- **`@totalfinance/ta` (§13.2):** **async-iterable streaming input** (`streamAsync` / `collectAsync`) so
  indicators consume live feeds without buffering the series.
- **`@totalfinance/fixed-income` (§14.1/14.3):** **callable/putable bonds** (option-adjusted price, option
  value, effective duration, OAS) and **Bermudan swaptions** by backward induction on the short-rate
  tree (a new generic `rollback` primitive), plus the **G2++** two-factor Gaussian model (analytic
  bonds + ZCB options, reduces to Hull-White as η → 0).

A second sweep then built the two §14 items that _that_ work unblocked:

- **`@totalfinance/options` (§9 lattice tooling):** a generic, payoff-agnostic **equity binomial lattice**
  (`equityLattice`, CRR / Jarrow–Rudd) with a `rollback(terminal, combine)` primitive — the equity
  analogue of the short-rate tree's rollback.
- **`@totalfinance/fixed-income` (§14.1):** **convertible bonds** (`convertibleBond`) on that lattice with a
  **reduced-form hazard** credit model — conversion / issuer-call / holder-put / coupons and
  default-with-recovery, decomposed into bond floor + embedded equity-option value.
- **`@totalfinance/fixed-income` (§14.4):** **CVA / DVA / FVA** (`swapXva`) for interest-rate swaps via a
  Hull-White **exposure simulator** — exact Ornstein-Uhlenbeck short-rate paths along a pathwise
  stochastic discount factor, the swap valued analytically at each exposure date, aggregated against
  the counterparty / own survival curves. The simulator is self-validated by a zero-coupon martingale
  repricing check; CVA scales exactly with `(1 − R)` and notional.
- **`@totalfinance/backtest` (§16.2):** **options exercise / assignment** in the simulated broker —
  `registerOption` + `settleExpiries` auto-exercise ITM longs and assign ITM shorts at expiry (physical
  or cash settlement), with multiplier-aware marking and fill cash; the event-driven engine settles
  expiries automatically and reports them.

## PR-review hardening + product-depth pass

An external review of the branch flagged nine correctness/robustness gaps (all in the "no silent
degradation" family the library commits to) and a set of trader-product feature gaps. Both were closed;
whole workspace **→ 2,443 tests**.

**Correctness / input-hardening (all with regression tests):**

- **Broker settlement (§16.2):** `settleExpiries` now validates the underlier mark (present, finite,
  positive) _before_ mutating any state, so a missing/`NaN` mark throws with the option still registered
  and the settlement retryable — instead of stranding it or writing a `NaN` into cash/shares.
- **`@totalfinance/vol` 0DTE surfaces:** `volSurface` now resolves date-only expiries via the core
  `optionExpiryToMs` (16:00 ET), matching options/structure — a same-day chain quoted intraday no longer
  drops every quote as "expired". Vol test helpers updated to the same convention.
- **Equity lattice:** the CRR tree throws when the risk-neutral up-probability leaves `[0, 1]`
  (unstable `timeStepYears`) rather than emitting a nonsensical price.
- **Rates derivatives:** `black`/`bachelier` reject a negative/NaN vol or maturity (no more silent
  "intrinsic"); `swaptionPrice`/`capFloorPrice` reject unknown `optionType`/`type` instead of defaulting
  to receiver/floor.
- **Bond yields:** `priceFromYield`/`yieldMetrics` reject a yield that drives the actuarial base
  `1 + y/f ≤ 0` (a one-year zero at `y = −2` no longer returns `−100`).
- **Convertibles:** a negative flat `hazardRate` is rejected (it had produced negative default
  probabilities and an inflated price).
- **Variance/vol swaps:** `varianceSwap.value` rejects a `NaN` notional; `volatilitySwap.fairVolApprox`
  throws when the Brockhaus–Long convexity term leaves its valid region (would return a ≤0 fair vol).
- **Local vol:** `dupireLocalVol` validates `dk`/`timeStepYears`/`floorVol`; `localVolGrid` enforces finite,
  strictly-ascending axes.
- **Vol analytics:** `volatilityCone` throws when a window exceeds the history (was an all-`NaN` row);
  `ivRank`/`ivPercentile`/`ivStats` reject `NaN` current/history values.

**Product-depth features (pure compute on existing primitives, fully tested):**

- **Smile-aware strategy probability (`@totalfinance/strategy`):** `probabilityMC` accepts an optional
  Dupire `localVol` function, so probability-of-profit / expected P&L / probability-of-touch step under
  the volatility smile instead of a single lognormal σ (a flat surface reproduces the constant-σ result
  bit-for-bit). Adds an optional expiration-P&L **profit cone** (`pnlQuantiles`).
- **Strategy scanner / optimizer (`@totalfinance/strategy` `scanStrategies`):** enumerate verticals, iron
  condors/butterflies, long call/put butterflies, straddles and strangles over a strike grid; score each
  with the existing payoff/probability metrics plus a bid/ask liquidity score; filter by POP / max risk;
  rank by POP, EV, return-on-risk, or EV-per-risk. Prices any missing premiums from a `vol`/`smile`.
- **Options margin / buying-power (`@totalfinance/risk`):** `optionsMargin` (defined-risk = max loss;
  long-only = debit; naked = Reg-T requirement) plus standalone `nakedCallMargin`/`nakedPutMargin`.
- **Flow intelligence (`@totalfinance/structure`):** `deltaAdjustedPremium` (delta-weighted directional
  premium, bullish vs bearish) and `unusualness` (z-score / percentile vs a caller-supplied baseline) —
  the pure-compute pieces of the review's flow gap; greeks/baselines stay bring-your-own.

## Full named-strategy set (app OPC parity)

`@totalfinance/strategy` now ships the **complete strategy catalogue** the InsiderFinance option profit
calculator supports (~58 structures), not just the seven original verticals/straddle/condor. Each is a
pure builder taking explicit strikes/premiums (data-agnostic) that composes legs into a `Position`,
with leg compositions mirroring the app 1:1:

- **Single legs:** long/short call & put, cash-secured put.
- **Ladders:** bull/bear call & put ladders.
- **Ratio:** call/put ratio spreads and ratio backspreads (configurable ratio).
- **Broken wings:** call/put broken-wing butterflies + their inverses.
- **Butterflies / condors:** long/short call & put butterflies and condors.
- **Iron:** iron & inverse-iron butterfly, inverse-iron condor (iron condor already shipped).
- **Volatility:** short straddle/strangle, guts/short guts, strips, straps, jade lizard + reverse.
- **Synthetics / combos:** long/short synthetic future, synthetic put, long/short combo.
- **Stock combinations:** covered call, protective put, collar, covered short straddle/strangle.
- **Multi-expiry:** calendar call/put spreads, diagonal call/put spreads, and the double diagonal —
  enabled by a new **per-leg `expiry`** on `Leg`, so `Position.value()` prices each leg at its own
  time-to-expiry (a calendar valued at the near expiry keeps the long leg's time value — the classic
  tent — instead of collapsing both legs to intrinsic).

All are attached to the `strategy` builder object and covered by leg-composition + payoff/greeks tests.

## Deferred

Every phases-0–6 **spec compute deliverable** that isn't sequenced into a later phase is built. That is
not the same as "nothing left at all": remaining product breadth (dedicated 0DTE workflows, deeper flow
intelligence — repeat-buyer/OI-delta inference, multi-leg reconstruction) and the Phase-7/8 surface
below are still open. The remaining review items are deliberately deferred, with reasons:

- **Live options data layer** (OPRA/vendor adapters, NBBO cleaning, WebSocket chain updates): this is the
  optional Phase-8 **data layer** — network/credentials/vendor infrastructure, not browser-safe pure
  compute — and the library is designed as "bring your own data" with data as a separate optional layer.
- **Per-minute GEX history / intraday time-series aggregation:** a data-pipeline concern over
  caller-supplied snapshots; the per-snapshot compute (GEX, gamma walls, intraday time-to-close) already
  exists, and the same-day surface fix above closes the one compute bug here.
- **MCP tool expansion** (exposing vol surface / structure / scanner as MCP tools): Phase-7 productization
  surface — wiring existing compute into the MCP server, not new compute.
- **Automatic differentiation for Greeks (§9.4)** and a standalone **arbitrage-aware vol interpolator
  (§7):** the former is spec-optional ("if added later"); the latter's intent is already met by the
  arbitrage-free SVI/SABR surface fitting in `@totalfinance/vol`.

## Next

Phase 6 (Fixed Income) is **complete**, and every phases-0–6 **spec compute deliverable** not sequenced
into a later phase is built and tested. What remains is **product depth** (broader named-strategy /
scanner coverage, first-class 0DTE workflows, richer flow intelligence) and **Phase 7 — Own the
TypeScript Space** (stable APIs, complete docs, adapter SDK, optional WASM/native acceleration, benchmark
suite, examples, public governance, and expanded MCP tools), with the optional `@totalfinance/data` layer and
adapter packages (Phase 8) following.
