# Spec — Wave 6: the "insanely complete" per-package quant moats

> **Status: COMPLETE at `8e59ca96`.** This document is authoritative for Wave 6 behavior and
> checkboxes only. Global sequencing lives in [`implementation-order.md`](../implementation-order.md),
> permanent API laws live in [`library-alignment-spec.md`](../library-alignment-spec.md), and the broad
> feature inventory remains [`roadmap.md`](../roadmap.md). Phase 3B.N public-naming normalization is
> now current and release-blocking; runtime-semantic Phase 3B follows it. API names in this completed
> evidence file are the Wave 6 baseline spellings; the
> [naming specification](./phase-3b-public-naming-normalization.md) owns their pre-release
> replacements.

## Status and order

- [x] **Zero-coupon inflation swap** — `zeroCouponInflationSwap` (`@totalfinance/fixed-income`), commit
      `6b240d6b`.
- [x] **Probability of backtest overfitting (CSCV)** — `probabilityOfBacktestOverfitting`
      (`@totalfinance/risk`), commit `04bfbc48`.
- [x] **1. Bond-future CTD frontier + delivery-date DV01** — `bondFutureCtdFrontier`
      (`@totalfinance/fixed-income`), commit `f555b11f`.
- [x] **2. Strategy-optimizer capital normalization + admissible Kelly sizing**
      (`@totalfinance/strategy`)
  - [x] **2A. Package-graph decoupling and cycle ratchet** — risk `StrategyPosition` protocol +
        `@totalfinance/risk/sizing` + `tools/package-graph.test.ts`, commit `b2888eb4`.
  - [x] **2B. Shared outcome mass and capital-normalized ranking** — shared
        `thesis-distribution.ts` (CDF bin-mass), `capital` + `thesisExpectedValuePerCapital` + objective, commit
        `0691d912`.
  - [x] **2C. Kelly integration and admissibility** — 2C-i `KellySizing` finite-success law (no
        Infinity), 2C-ii optimizer `sizing`/`kelly` (dimensionless returns, unbounded-downside
        refusal), commits `4f8ca63b` and `9356745f`. **Follow-up:** the naked-short case is exercised
        via the internal resolver, not end-to-end—the defined-risk scanner enumerates no
        undefined-risk structures. The settled opt-in expansion is recorded in
        [`phase-3b-decision-ledger.md`](./phase-3b-decision-ledger.md#adjacent-governed-decision-not-a-phase-3b-blocker).
- [x] **3. What-if-cube probability mass + break-even-time surfaces** (`@totalfinance/strategy`) —
      `WhatIfCubeOptions.probability` (GBM measure grammar / custom density, midpoint-bin mass +
      disclosed tails, per-(vol, day) expected P&L) + always-present `breakEven`; shares
      `priceGridDistribution` with the optimizer; converges to `probability().expectedValue`, commit
      `67034ce1`.
- [x] **4. TA typo-tolerant discovery + exhaustive output metadata** (`@totalfinance/technical-analysis`) — 4a
      `searchIndicators` fuzzy fallback (Damerau–Levenshtein, `match`/`minScore`, inspectable
      evidence); 4b `IndicatorOutputMetadata` on all 335 built-ins + `register`/`defineIndicator`
      requirement, verified against runtime by `test/output-meta.test.ts`, exposed via
      describe/search/registryMarkdown, commits `3c3a1d8f` and `8e59ca96`.

The batch landed in the listed order and every status above is backed by its built artifacts. This
file is completion evidence, not the current scheduler.

## Non-negotiable constraints

1. Phase 3A remains settled: financially confusable coordinates use one named request; natural
   subject/context, series/options, and algebraic pairs remain positional.
2. New APIs reject unknown closed-object fields, validate every consumed value, use typed
   `QuantError`s, and obey the declared facade/analysis/artifact/kernel result grammar.
3. Package dependencies remain acyclic and point down the platform layer model. A type-only import is
   still a package/build edge.
4. A probability is a mass over an interval, not an unscaled point density. Units and normalization
   bases must be explicit.
5. Margin/buying power is a capital requirement, not a maximum-loss claim. Metrics may not silently
   substitute one meaning for the other.
6. A grid is not a stochastic path. Conditional surfaces must be named and documented as conditional
   surfaces.
7. No implementation may rely on rerunning a flaky test. Fix nondeterminism or identify and resolve the
   real defect before checking an item complete.

---

<a id="wave6-ctd-frontier"></a>

## 1. Bond-future CTD frontier + delivery-date DV01 (`@totalfinance/fixed-income`)

**Goal.** Show how the cheapest-to-deliver bond changes under explicit parallel-yield and futures-price
scenarios, and report the futures risk at delivery. This is a **CTD switching frontier**, not a valuation
of the short's timing or quality option. Actual delivery-option value remains deferred.

This extends `bondFuture` and `bondFutureHedge` from
[`packages/fixed-income/src/futures.ts`](../../packages/fixed-income/src/futures.ts) and the shipped
[`bond-future CTD`](./bond-future-ctd.md) / [`hedge`](./bond-future-hedge.md) specs.

### Method

1. Solve each deliverable's current yield from its clean price at `settlementDate`.
2. Resolve and sort `yieldShiftsBp`; require finite unique shifts. The default is
   `{ from: -200, to: 200, step: 25 }`, inclusive and guaranteed to contain zero. `futuresPrices`,
   when supplied, must align one-for-one with the caller's explicit shifts; sort the `(shift, price)`
   pairs together. Otherwise hold the input futures price constant and disclose
   `futuresPriceScenario: 'held-constant'`.
3. At every shift, reprice every deliverable with the existing
   `priceFromYield(bond, { settlementDate, yield: currentYield + shiftBp / 10_000 })`.
4. Call the existing `bondFuture(...)` with the shifted clean prices and that node's futures price.
   Do not reproduce basis, carry, conversion-factor, or implied-repo mathematics.
5. Record the full CTD row at each node. A switch is a change in the global CTD identity between
   adjacent nodes. Under the held-constant futures policy, refinement has three distinct stages:
   - recursively bisect a changed-winner bracket by re-evaluating the whole basket until each global
     transition bracket is no wider than `switchLocationToleranceBp`; if a third deliverable becomes
     CTD, split the bracket into the resulting transitions;
   - inside each final adjacent-winner bracket, use the existing Brent solver on the difference
     between those two deliverables' implied-repo rates; and
   - re-evaluate the full basket at the candidate root. Label it `root-refined` only when the pair's
     implied-repo rates agree within the internal annualized-rate tie tolerance and no third
     deliverable exceeds them by more than that tolerance. Otherwise continue subdivision or return
     the honest grid midpoint with a diagnostic.

   A caller-supplied discrete futures-price path does not define values between nodes, so its switches
   remain labeled grid midpoints; do not invent interpolation.

6. Compute delivery-date futures DV01 from the current CTD's futures-implied forward yield:
   `yieldMetrics(ctdBond, { settlementDate: deliveryDate, yield: impliedForwardYield }).dv01 / CF`.
   This is distinct from the existing spot cash DV01 divided by conversion factor.

Holding the futures quote fixed answers a useful ceteris-paribus basis question; it does not claim to
forecast how the futures itself moves when rates change. A caller that has a futures-price path supplies
it explicitly. The result echoes which policy was used.

### API

```ts
interface BondFutureCtdFrontierInput extends BondFutureInput {
  yieldShiftsBp?: readonly number[] | { from: number; to: number; step: number };
  /** Optional path, aligned with explicit shifts before sorting (or resolved range order). */
  futuresPrices?: readonly number[];
  /** Refine held-constant-policy brackets; default true. Invalid with `futuresPrices`. */
  refineSwitches?: boolean;
  /** Maximum reported switch-location bracket width in shift basis points; default 0.01. */
  switchLocationToleranceBp?: number;
}

interface BondFutureCtdFrontierResult {
  current: { ctdId: string; ctdYield: number; conversionFactor: number };
  scenarios: Array<{
    yieldShiftBp: number;
    futuresPrice: number;
    ctdId: string;
    netBasis: number;
    impliedRepoRate: number;
    deliverables: DeliverableAnalysis[];
  }>;
  switches: Array<{
    fromCtd: string;
    toCtd: string;
    bracketBp: readonly [number, number];
    estimatedSwitchBp: number;
    method: 'root-refined' | 'grid-midpoint';
  }>;
  risk: {
    spotFuturesDv01: number;
    deliveryDateFuturesDv01: number;
    impliedForwardYield: number;
  };
  assumptions: {
    conventionsVersion: string;
    settlementDate: string;
    deliveryDate: string;
    futuresPriceScenario: 'held-constant' | 'supplied-path';
    yieldShock: 'parallel';
    yieldShiftsBp: number[];
    refineSwitches: boolean;
    switchLocationToleranceBp: number | null;
    /** Internal global-tie test, decimal annualized implied-repo rate; fixed at 1e-10. */
    repoRateTieTolerance: 1e-10;
  };
  diagnostics: Diagnostics;
}

function bondFutureCtdFrontier(input: BondFutureCtdFrontierInput): BondFutureCtdFrontierResult;
```

### Verification

- A one-bond basket has no switches and every node keeps that CTD.
- When the resolved grid contains zero, that node exactly matches
  `bondFuture(input).cheapestToDeliver`.
- Every scenario row equals a direct `bondFuture(...)` call built from independently shifted bond
  prices.
- A deliberately constructed two-bond fixture has a bracketed switch; the refined root equalizes the
  two competing implied-repo rates within `1e-10`, its final bracket is no wider than the configured
  location tolerance, and the two tolerances are never compared across units. Do not assert that
  arbitrary two-bond baskets switch exactly once.
- A three-bond fixture with a narrow intermediate CTD finds both frontier transitions; no reported
  root is accepted when a third deliverable has the strictly better implied repo at that point.
- Delivery-date DV01 equals a central finite difference of the CTD price at the delivery settlement
  date, divided by conversion factor.
- Supplied and held-constant futures-price policies produce distinct, correctly disclosed frontiers.
- The default range resolves to the documented 17 ordered shifts and contains exactly one zero node.
- `refineSwitches: true` with a supplied discrete futures-price path rejects instead of inventing an
  interpolation.
- Invalid ranges/location tolerances, duplicates, non-finite shifts, misaligned futures prices, and
  malformed deliverables throw typed teaching errors. The annualized repo-rate tie tolerance is a
  deterministic library assumption, not a user knob.

**Deferred:** non-parallel/key-rate frontiers; stochastic delivery probabilities; timing/end-of-month
options; and delivery-option value under a rate model.

---

<a id="wave6-optimizer-sizing"></a>

## 2. Strategy-optimizer capital normalization + admissible Kelly sizing (`@totalfinance/strategy`)

**Goal.** Rank every candidate by an economically honest capital denominator and optionally answer
"how much bankroll can this trade receive?" without pretending margin is maximum loss or applying Kelly
to an unbounded-downside distribution.

This extends [`strategy-optimizer.md`](./strategy-optimizer.md) and composes the shipped
[`kelly-sizing.md`](./kelly-sizing.md) and `optionsMargin` behavior.

### 2A — Package-graph decoupling and cycle ratchet (own precursor commit)

The current dependency direction is `@totalfinance/risk` → `@totalfinance/strategy`; strategy does **not**
currently depend on risk. Importing `kellyBet` or `optionsMargin` from strategy would create a cycle.

Land the graph correction as a behavior-preserving precursor:

1. replace risk's three concrete type-only `Position`/`Leg` imports with the minimal structural
   protocols each risk operation actually consumes; do not create a new shared package for this
   narrow type seam;
2. remove the risk → strategy project/package edge;
3. add a focused `@totalfinance/risk/sizing` export path for `kellyBet`, `optionsMargin`, and their public
   types, preserving their existing root exports;
4. add a repository test that rejects package dependency cycles and upward edges; and
5. prove existing risk calls still accept a real `Position` structurally and that packed consumers
   can import both the preserved root exports and the new focused subpath.

Do not add an unused strategy → risk edge in this precursor. Commit 2B adds that dependency only when
the optimizer actually composes `optionsMargin`. Do not duplicate Kelly or margin mathematics to
avoid the graph decision.

**2A exit:** API reports and packed type consumers are unchanged except for the additive sizing
subpath; risk no longer references strategy; the graph is acyclic; the synthetic reverse-edge fixture
fails.

### 2B — Shared outcome mass and capital-normalized ranking

`optimizeStrategy` currently accumulates only EV and probability of profit; it does not retain a
discrete outcome distribution. Factor one internal quadrature path that yields normalized nodes:

```ts
interface ThesisOutcomeNode {
  terminalPrice: number;
  probability: number;
  pnl: number;
}
```

The same nodes must reproduce the existing thesis EV/PoP within tolerance. Lognormal nodes use interval
probability mass (CDF differences, including disclosed tails), while a custom density uses its explicit
support and normalized quadrature weights. This path becomes the source reused by the what-if-cube item.

Add the strategy → risk dependency in this commit and import `optionsMargin` only through
`@totalfinance/risk/sizing`.

#### Capital semantics

- `thesisExpectedValuePerRisk` remains `thesisExpectedValue / |maxLoss|` and retains its current defined-risk meaning. It
  never falls back to margin.
- Add `capital.requirement` from `optionsMargin(...).buyingPowerReduction`, with its method and Reg-T
  assumptions disclosed.
- Add `thesisExpectedValuePerCapital = thesisExpectedValue / capital.requirement` and a separate
  `'thesisExpectedValuePerCapital'` ranking objective.
- Treat the requirement as static entry buying power, not a liquidation or future house-margin model;
  echo that limitation. If the requirement is zero, the ratio is `null` with a diagnostic and ranks
  last for the capital objective—never Infinity.

**2B exit:** shared nodes reproduce the pre-change EV/PoP, every candidate carries disclosed capital,
the new capital objective ranks deterministically, and no Kelly field or implicit sizing appears.

### 2C — Kelly integration and admissibility

- Kelly outcomes are dimensionless returns:
  `payoff = node.pnl / capital.requirement`. Passing absolute dollar P&L to `kellyBet` is forbidden.
- Kelly is opt-in through optimizer-level sizing options; half-Kelly may remain the `kellyBet` default
  only when the caller requests sizing, and every applied cap is returned unchanged from `KellySizing`.
- A position with unbounded downside under the thesis support is not Kelly-admissible: any positive
  bankroll fraction can cross zero wealth. Return a structured `not-admissible` verdict unless the
  caller supplies a separately modeled, explicit loss cap/exit rule in a future feature. Never make a
  naked short call look safe by truncating a ±sigma integration grid.
- Determine unbounded downside from the materialized payoff's asymptotic slopes and the distribution's
  support, not from sampled grid nodes. The quadrature grid is numerical integration evidence, never a
  proof that loss is bounded.
- A naked short put has finite expiration loss and is not the unbounded-loss test case. Use a naked
  short call or net-short-call ratio structure.
- `KellySizing` itself must obey the finite-success law before it is embedded. A no-downside edge has
  no finite unconstrained optimum; represent that state with a discriminant and `null`/omitted
  unconstrained fraction plus a diagnostic, rather than `Infinity`. A finite recommendation still
  requires an explicit cap.

Commit 2C imports `kellyBet` from the same focused sizing subpath and introduces sizing only behind the
explicit `sizing` option.

### API

```ts
type OptimizerSizingOptions = Omit<KellyBetInput, 'edge'> & {
  enabled: true;
};

interface OptimizeStrategyOptions {
  // existing fields...
  /** Added in 2C; omission means no Kelly work and no Kelly field. */
  sizing?: OptimizerSizingOptions;
}

interface OptimizedStrategy {
  // existing fields...
  capital: {
    requirement: number;
    method: 'defined-risk-max-loss' | 'long-premium' | 'reg-t-naked';
    maxLoss: number | null;
    assumptions: OptionsMarginResult['assumptions'];
    diagnostics: OptionsMarginResult['diagnostics'];
  };
  thesisExpectedValuePerCapital: number | null;
  /** Added only in 2C. */
  kelly?:
    | { status: 'sized'; sizing: KellySizing }
    | { status: 'not-admissible'; reason: 'unbounded-downside' | 'zero-capital' };
}

type OptimizerObjective =
  | 'thesisExpectedValuePerRisk'
  | 'thesisExpectedValuePerCapital'
  | 'thesisExpectedValue'
  | 'thesisProbabilityOfProfit'
  | ScanObjective;
```

### Verification by commit

#### 2A — graph

- Existing risk APIs accept `Position` structurally with declaration and packed-consumer proof.
- Root and `@totalfinance/risk/sizing` exports resolve to the same Kelly/margin implementation identities.
- The package graph is acyclic and the dependency test fails on a synthetic reverse edge.

#### 2B — outcome mass and capital

- Shared outcome nodes reproduce pre-change thesis EV and PoP.
- A naked short call and defined-risk spread both receive the exact result of a direct
  `optionsMargin(...)` call.
- A zero-capital fixture returns `thesisExpectedValuePerCapital: null`, carries a field-specific diagnostic, and
  ranks below every defined capital score for the capital objective.
- `thesisExpectedValuePerRisk` is unchanged for every pre-existing candidate and never changes meaning.

#### 2C — Kelly

- Dividing every dollar P&L and the capital requirement by the same currency scale leaves Kelly
  unchanged.
- A favorable bounded binary payoff matches `kellyBet` exactly; negative edge sizes to zero.
- Half-Kelly and drawdown/max-fraction caps match `kellyBet` exactly when requested.
- A naked short call receives Reg-T capital and can rank by `thesisExpectedValuePerCapital`, but Kelly reports
  `not-admissible`; a defined-risk spread receives a finite sizing result.
- Omitting `sizing` performs no Kelly calculation and omits the field; requesting it preserves every
  `kellyBet` cap and diagnostic.

Each of 2A, 2B, and 2C passes the full per-item completion gate and lands independently reviewable.

**Deferred:** portfolio/simultaneous Kelly across correlated candidates; portfolio-margin or broker
house rules; explicit stop/liquidation policies that can bound an otherwise unbounded strategy; and
risk-neutral Kelly as a separately named research comparison.

---

<a id="wave6-cube-probability"></a>

## 3. What-if-cube probability mass + break-even-time surfaces (`@totalfinance/strategy`)

**Goal.** Add probability-aware reductions and time-to-break-even reads to the existing
spot × vol-shock × days-forward cube while preserving all three dimensions and labeling conditional
scenarios honestly.

This extends [`what-if-cube.md`](./what-if-cube.md) and reuses the resolved-distribution and
probability-mass utilities established by Wave 6 item 2.

### Semantics

1. A spot distribution is resolved separately at each day from the current spot and the selected
   process model. Convert ordered grid prices into non-overlapping midpoint bins and assign
   CDF/quadrature probability mass. Report probability below the displayed minimum and above the
   displayed maximum explicitly; if a result renormalizes the in-grid mass, disclose that policy.
2. No probability is assigned to the volatility-shock axis in this release. Therefore the expected
   P&L reduction is **per vol-shock and day**, not one number per day, and no field is called a full
   cube-cell probability.
3. Break-even time is the first requested day with non-negative P&L for each fixed
   `(price, volatilityShock)` grid coordinate. It is a conditional surface, not a simulated path and not
   guaranteed to be monotone.
4. Day zero is a degenerate spot distribution at the current spot and must be represented without a
   divide-by-zero or fabricated smooth density.
5. The weighted cube is a finite-grid estimate. At expiration on the zero-vol-shock slice, it must
   converge toward `position.probability().expectedValue` as the grid widens/refines under the same
   measure, drift, volatility, and expiry convention. Do not assert exact identity for a coarse or
   conditionally renormalized grid, and do not claim a generic identity at intermediate days.
6. Probability mode requires strictly increasing unique prices, strictly increasing unique
   non-negative days, and finite unique volatility shocks.
7. GBM volatility is positive. Drift follows the same measure grammar as `Position.probability()`:
   - `riskNeutral` is the default and resolves annualized drift to
     `market.rate - market.dividendYield`;
   - `realWorld` requires `expectedReturn` and resolves drift to
     `expectedReturn - market.dividendYield`; and
   - `explicit` requires `drift` and uses it directly.

   There is no silent zero-drift default. The result echoes the measure, inputs, and resolved drift.

8. Custom support is finite, ordered, non-negative, and its density must be non-negative with positive
   integrable mass at every requested positive horizonPeriods.

### API

```ts
type WhatIfGbmProbabilityModel =
  | { kind: 'gbm'; annualizedVolatility: number; measure?: 'riskNeutral' }
  | {
      kind: 'gbm';
      annualizedVolatility: number;
      measure: 'realWorld';
      /** Annualized total expected return before dividend yield. */
      expectedReturn: number;
    }
  | {
      kind: 'gbm';
      annualizedVolatility: number;
      measure: 'explicit';
      /** Annualized arithmetic GBM drift used directly for the underlying process. */
      drift: number;
    };

type WhatIfProbabilityModel =
  | WhatIfGbmProbabilityModel
  | {
      kind: 'custom';
      density: (price: number, yearsForward: number) => number;
      support: { from: number; to: number };
    };

interface WhatIfProbabilityOptions {
  model: WhatIfProbabilityModel;
  /** How finite price-grid tails are handled; default 'report-and-renormalize'. */
  gridPolicy?: 'report-and-renormalize' | 'include-in-edge-bins';
}

interface WhatIfCubeOptions {
  // existing fields...
  probability?: WhatIfProbabilityOptions;
}

interface WhatIfCubeProbability {
  /** Day outer, price inner. Volatility-independent spot mass. */
  spotMassByDay: number[][];
  tailMassByDay: Array<{ below: number; above: number }>;
  gridPolicy: 'report-and-renormalize' | 'include-in-edge-bins';
  expectationMeaning: 'conditional-on-grid' | 'edge-censored';
  modelAssumptions:
    | {
        kind: 'gbm';
        measure: 'riskNeutral';
        annualizedVolatility: number;
        riskFreeRate: number;
        dividendYield: number;
        resolvedDrift: number;
      }
    | {
        kind: 'gbm';
        measure: 'realWorld';
        annualizedVolatility: number;
        expectedReturn: number;
        dividendYield: number;
        resolvedDrift: number;
      }
    | {
        kind: 'gbm';
        measure: 'explicit';
        annualizedVolatility: number;
        drift: number;
        resolvedDrift: number;
      }
    | { kind: 'custom'; support: { from: number; to: number } };
  /** Volatility-shock outer, day inner; interpreted by `expectationMeaning`. */
  expectedPnlByVolatilityAndDay: number[][];
}

interface WhatIfCubeBreakEven {
  /** Price outer, vol-shock inner. */
  firstNonNegativeDayByPriceAndVolatility: Array<Array<number | null>>;
}

interface WhatIfCubeValue {
  // existing axes/cells/optimalExit/best/worst...
  probability?: WhatIfCubeProbability;
  breakEven: WhatIfCubeBreakEven;
}
```

Share the lower-level resolved-price-distribution and probability-mass utility with the optimizer.
Do not force the optimizer's terminal target-price thesis and the cube's multi-day process into one
public type: they answer different questions. Preserve the existing one-options-object method shape.

### Verification

- Before renormalization, in-grid mass plus disclosed tails equals one. Under
  `report-and-renormalize`, each returned spot-mass row sums to one and `expectationMeaning` is
  `conditional-on-grid`; under `include-in-edge-bins`, tails are assigned to the nearest edge,
  returned mass sums to one, and the meaning is `edge-censored`.
- Analytic lognormal bin masses match direct CDF differences; custom density masses match an
  independent quadrature.
- `expectedPnlByVolatilityAndDay[v][d]` equals a direct weighted sum of the existing cube cells for that exact
  vol/day slice.
- At expiry and zero vol shock, successively wider/finer grids converge toward
  `position.probability({ measure: 'riskNeutral' }).expectedValue` when both calls use identical
  spot, rate, dividend yield, volatility, expiry, and tail policy; the error decreases at the
  expected quadrature rate for the fixture.
- A real-world fixture supplies one `expectedReturn` to both APIs and resolves the identical
  `expectedReturn - dividendYield` drift. Explicit drift is tested against an independent GBM
  integral and is not falsely claimed to equal a differently configured `position.probability()`.
- Missing `expectedReturn`/`drift`, contradictory measure fields, or a misspelled measure reject with
  typed errors. The default GBM measure resolves to risk-neutral drift, never zero unless
  `rate === dividendYield`.
- Every break-even entry equals a direct scan of its fixed price/vol cells; fixtures include no
  crossing, one crossing, and multiple sign changes without assuming monotonicity.
- Dimension lengths exactly match their documented axes, including one-point axes and day zero.
- Day zero produces a point mass in the containing bin. With conditional-grid policy, a day-zero spot
  outside the grid rejects with a teaching error instead of dividing by zero; edge-censored policy
  assigns it to the nearest edge and discloses the tail.
- Unknown probability fields, invalid masses/support, unsorted/duplicate grids, and non-finite values
  throw typed teaching errors.

**Deferred:** a joint spot-volatility distribution; stochastic path-dependent stopping rules; a
rendered heatmap; and probability over optimal-exit decisions.

---

<a id="wave6-ta-metadata"></a>

## 4. TA typo-tolerant discovery + exhaustive output metadata (`@totalfinance/technical-analysis`)

**Goal.** Make the 335-indicator catalog forgiving to search and machine-understandable enough for an
agent or UI to consume and render each output without running a guess-and-inspect loop.

This extends [`ta-discovery.md`](./ta-discovery.md). Preserve the existing object-shaped
`searchIndicators(opts)` API, paginated `SearchIndicatorsResult`, canonical `name`, and
`IndicatorRow`/`IndicatorDescription` vocabulary.

### Fuzzy discovery

- Extend `SearchIndicatorsOptions` with `match?: 'substring' | 'fuzzy' | 'auto'` and `minScore?`.
- Default `auto`: preserve exact/alias/substring results when any exist; use deterministic fuzzy
  fallback only when they do not. An exact canonical or alias match always ranks first.
- Normalize case, separators, and camel-case boundaries; compare against each canonical/alias full
  name and token with normalized Damerau–Levenshtein similarity. The default `minScore` is `0.7`, its
  valid range is `[0, 1]`, and fuzzy matching requires at least three normalized query characters.
- Rank by match class, then score descending, canonical name ascending. Return `matchKind`, `score`,
  and the canonical/alias candidate that matched so ranking is inspectable and deterministic.
- Keep `category`, `limit`, `offset`, `total`, and the existing result envelope. Add match evidence to
  rows rather than replacing the result with an incompatible array.
- Omit match evidence when no query is supplied so unfiltered pagination stays lean. `minScore` is
  used only for fuzzy matching; reject it or a non-default match mode when there is no query rather
  than accepting a no-op option.
- Unknown options and invalid score/limit modes reject with typed teaching errors.

### Output metadata

Do not conflate runtime shape with chart style. The catalog includes scalar, record, and vector
outputs (`maRibbon`, for example, emits `number[]`), so use a recursive JSON-safe value schema rather
than a closed list of chart-oriented shapes:

```ts
interface IndicatorNumberOutput {
  type: 'number';
  role?: string;
  unit?: string;
  bounds?: readonly [number, number];
}

type IndicatorOutputValue =
  | IndicatorNumberOutput
  | { type: 'boolean'; role?: string }
  | { type: 'string'; role?: string; values?: readonly string[] }
  | { type: 'record'; fields: Readonly<Record<string, IndicatorOutputValue>> }
  | {
      type: 'array';
      items: IndicatorOutputValue;
      length?: { fixed: number } | { parameter: string };
    };

interface IndicatorOutputMetadata {
  value: IndicatorOutputValue;
  visualization?: {
    kind: 'line' | 'bands' | 'oscillator' | 'histogram' | 'candles' | 'events' | 'levels' | 'multi';
    plots?: ReadonlyArray<{ path: string; role?: string }>;
    referenceLevels?: readonly number[];
  };
}

interface IndicatorMetadata {
  // existing fields...
  output: IndicatorOutputMetadata;
}
```

The exact field/plot-role vocabulary and path notation are curated once and documented. Every built-in
registry entry must declare output metadata. Both public registration paths, `register` and
`defineIndicator`, require and runtime-validate it for custom indicators so discovery never lies by
omission. `describeIndicator`, `searchIndicators`, `registryMarkdown`, generated indicator docs, and MCP
TA discovery all expose the same source-controlled data.

### API sketch

```ts
interface IndicatorMatchEvidence {
  kind: 'canonical-exact' | 'alias-exact' | 'canonical-substring' | 'alias-substring' | 'fuzzy';
  score: number;
  matchedOn: { source: 'canonical' | 'alias'; value: string };
}

interface IndicatorRow {
  // existing fields...
  match?: IndicatorMatchEvidence;
}

searchIndicators({
  query: 'bolinger',
  match: 'auto',
  limit: 10,
});
// => existing SearchIndicatorsResult; queried rows include inspectable match evidence.
```

### Verification

- One- and two-edit misspellings for a representative corpus return the intended indicator first;
  exact canonical and alias matches always outrank fuzzy candidates.
- Matching is deterministic across runtimes and stable under registry insertion order.
- Every registered built-in has output metadata; no representative-only loophole is allowed.
- Runtime probes recursively compare the declared value type, field names, array shape, and fixed or
  parameter-derived lengths with post-warmup results for every fixtureable indicator. Explicitly
  exceptional dynamic outputs carry a reviewed policy entry.
- RSI is a bounded oscillator; MACD declares its lines and histogram; Bollinger Bands declares band
  fields; SMA is a scalar line; Heikin-Ashi is a bar series; candlesticks/events use honest non-line
  shapes.
- Metadata round-trips through description/search, generated Markdown, and MCP without separate
  hand-maintained copies.

**Deferred:** semantic/embedding search; model-generated indicator explanations; and automatic
metadata inference as the source of truth. Runtime inference may verify curated metadata but may not
silently redefine it.

---

## Per-item completion gate

For every Wave 6 top-level item and named sub-item:

1. verify the mathematics or defining behavior first with an independent formula, finite difference,
   direct composition identity, property test, or external reference appropriate to the domain;
2. settle public types and package dependencies before implementation;
3. implement through existing primitives with one source of mathematical truth;
4. enforce input shape, unknown-key, finite-success, assumptions, diagnostics, determinism, and
   serialization laws;
5. wire exports, package subpaths, manifest classification, signature inventory, first-touch fixtures,
   generated API reports, READMEs, and `llms` docs;
6. test semantic properties, malformed runtime inputs, aliases, packed-tarball TypeScript/JavaScript
   consumption, and any cross-layer parity affected by the change;
7. format only changed files with the repository-pinned Prettier; and
8. pass the full `pnpm run ci` gate without relying on reruns.

All four items are checked and independently reviewed against their built artifacts. Phase 3B is now
the current execution stage.
