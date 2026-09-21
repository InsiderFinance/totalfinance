# TotalFinance vs the InsiderFinance app: dogfooding comparison

Date: September 7, 2026. Status: historical comparison, recorded before implementation.

**Implementation follow-up:** the user approved repairs and the later OPC, GEX/DEX, observed-skew
and premium-drift migrations. Current completion evidence, opt-in controls and remaining acceptance
gates live in [app-dogfooding-implementation.md](./app-dogfooding-implementation.md). The findings,
measurements and unchecked proposal below preserve the original comparison; they are not today's
completion tracker. Nothing has been deployed or globally enabled.

## Bottom line

**Yes: dogfood TotalFinance in the app before exposing the public API. Start with OPC.** The numerical
foundation compares well, the library already has all 58 named strategies in the app's registry,
and its existing batch pricer is fast enough to justify a real browser trial without waiting for
WASM. However, this is not an interchangeable-import exercise: several similarly named results
answer different questions, and the exercise reproduced defects in both the app and the library.

The best sequence is **targeted repairs and explicit contracts → OPC shadow comparison → gated
OPC rollout → GEX/DEX and observed skew → trade-premium drift**. The later integrations can be
designed in parallel; they do not need to delay the first OPC shadow run. Do not silently change
pricing models, manufacture missing results, or preserve a legacy bug merely to obtain parity.

This report supplements [implementation-order.md](../implementation-order.md). It is the proposed
next pre-release dogfooding work, not authorization to change production calculations, merge
PR #286, publish packages, or deploy. Existing completed implementation stages remain completed.

## 1. What was actually compared

- Latest fetched `develop`: `ca2856a8` (`Finalize mobile`). It was merged cleanly into the isolated
  PR #303 worktree in `b215ca54`; no incoming develop changes touched TotalFinance. TotalFinance's baseline
  was PR head `bae2a21a`. The normal app checkout was left untouched. The merge is local, not pushed.
- Net-drift [PR #286](https://github.com/InsiderFinance/insiderfinance-app/pull/286):
  `f0944551`, checked out separately and **not merged**. GitHub reported it open and not mergeable
  at inspection; rebase/integration work remains separate from this mathematical comparison.
- **Recorded market inputs:** 196 SPY/MSTR/TSLA quotes captured June 4, 2026, across June 18,
  July 17, and October 16 expiries. The existing fixture's generator sampled and filtered the chain.
  These are historical captured inputs, not current prices, a complete market sample, or vendor-IV
  truth. [Fixture](../../../src/utils/shared/quantlib/iv/__tests__/fixtures/opcChainSample.json),
  [capture/sampling script](../../../scripts/iv-fixtures/generateOpcFixtures.js).
- **Synthetic cases:** 162 scalar pricing/Greek combinations; six app-selected strategies rebuilt
  through both TotalFinance raw legs and named builders; 161 expiry prices per strategy; a calendar
  evaluated at the near expiry; quantity and near-expiry boundary probes; a 66-contract GEX/skew
  chain; and a five-print net-drift tape. The GEX chain deliberately uses TotalFinance-computed Greeks
  as the app's supplied Greeks, isolating aggregation and convention differences.
- The [portable comparison runner](../../../scripts/totalfinance-dogfood/README.md) uses built **public
  package exports** and actual app/PR functions. Its 24 compatibility assertions passed. The
  [recorded results](./app-dogfooding-evidence.json) retain numerical outputs and assumptions;
  smile-point arrays are omitted from that compact record but emitted by the runner.
- Eight targeted app Jest suites passed: **515 tests**, covering BSM, the strategy kernel,
  single-leg calculations, IV/root solvers, strategy entry-price sides, GEX and skew.

Limitations: no live authenticated screen/browser session was inspected in this pass; no fresh
live GEX vendor snapshot or production net-drift tape was captured. App tests used the existing
installed app dependencies; this was not a fresh frozen-lockfile app install, full app build,
whole-library CI rerun, supported-Node matrix run, or release certification. Local Node was 26.5.
Agreement between related BSM implementations establishes compatibility, not independent proof
of financial correctness or a model's suitability for every listed option.

## 2. OPC: strong fit, with important boundary differences

### Prices, Greeks and IV

With identical scalar time-to-expiry, volatility, rate and zero dividend yield, the 162-case grid's
largest option-price difference was **$0.00008864 per share**—less than one cent for a 100-share
contract. Maximum per-share Greek differences were approximately `6.89e-8` delta, `1.84e-12`
gamma, `8.13e-9` theta/day, `7.57e-14` vega/volatility point, and `5.09e-7` rho/rate point.

Both raw IV engines converged on the same **195/196** recorded inputs. TotalFinance's maximum
repricing residual was `3.26e-11` dollars/share. The app solver at its standalone default tolerance
had a maximum residual of `$0.00008993`; the production wrapper's looser tolerance had a maximum
residual of `$0.00098744`. The largest IV difference against the production wrapper was
`0.000313525` in decimal volatility, or **0.03135 volatility percentage points**. These figures
are solver compatibility measurements, not vendor-IV calibration claims.

The exception is particularly useful: SPY July 17 call, strike 645, spot 753.99, mid 111.50,
rate 3.71%. Under the selected no-dividend European model, the discounted lower price bound is
about 111.81575, so this price has no implied volatility under those assumptions. TotalFinance returns
`null` with `implied_volatility.below_intrinsic`; the app raw solver reports `not-bracketed`.
**The app's production wrapper then returns 0.151, which looks like a solved 15.1% IV.**

Do not characterize this as necessarily a bad market quote: dividends, model choice, quote timing
and spread selection are candidates to examine. But a fixed fallback is not a successful solve.
The app's averaging path accepts finite fallback values as though they were solved leg IVs.
Dogfooding should preserve an unavailable/failed state, and any user-selected estimate must be
visibly identified as an estimate. [App wrapper and default](../../../src/utils/shared/quantlib/BlackScholes.ts),
[OPC initialization](../../../src/screens/OptionsProfitCalculatorStrategy/OptionsProfitCalculatorStrategy.tsx),
[TotalFinance IV contract](../../packages/options/src/iv.ts).

### Strategy construction and payoff

The app and library each register 58 named strategies. This is a coverage inventory, **not** a
claim that every builder and customization has been cross-validated in this pass.

For the following six strategies, the app selected strikes and executable-side entry prices from
the synthetic chain. The same positions were then constructed with TotalFinance raw legs and named
builders. Every expiry P&L grid matched to floating-point noise (maximum about `1.03e-12` dollars).

| App-selected strategy | TotalFinance terminal max profit | TotalFinance terminal max loss | Break-even(s)        |
| --------------------- | -------------------------------: | -----------------------------: | -------------------- |
| Long call             |                        Unlimited |                       -$450.57 | $104.5057            |
| Bull call spread      |                          $635.47 |                       -$364.53 | $103.6453            |
| Bear put spread       |                          $330.43 |                       -$669.57 | $103.3043            |
| Iron condor           |                          $197.03 |                       -$302.97 | $93.0297 / $106.9703 |
| Covered call          |                          $714.52 |                     -$9,785.48 | $97.8548             |
| Long straddle         |                        Unlimited |                       -$842.12 | $91.5788 / $108.4212 |

These are constructed examples, not recommended trades or live quotes. Shared setup: spot 100,
July 17 expiry; entry prices use a synthetic smile and spread. Scenario marks use a common 30%
volatility, so not every entry is marked at its own entry IV.

A calendar works through time-aware `value()`: at the near expiry the short ATM leg is settled
and the far leg retains time value. TotalFinance's refusal to present a multi-expiry position as a
single terminal `payoff()` is correct. The observed app/library P&Ls were $156.6501 / $156.7782,
with different day counts; do not label their difference a payoff bug.

### Required input/output mapping

| Concern                 | App behavior                                                                                                                       | TotalFinance behavior / integration requirement                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry prices            | Builders default to long-at-ask, short-at-bid                                                                                      | Named builders accept explicit premiums. `strategyFromChain` defaults to mid; its ten structure-selection policies are not the app's 58 auto-pickers. Preserve the app's selected legs and side-specific fills initially.                                      |
| Time                    | Exact 16:00 Eastern expiry, elapsed time divided by 365.25 days                                                                    | Date-driven strategy/exposure APIs use ACT/365F and the same date-only 16:00 ET convention. Scalar/batch pricing accepts explicit years. Do not change `asOf` to fake agreement.                                                                               |
| Quantities              | `numberOfContracts` is already signed in kernel inputs; options multiply by 100, stocks are shares                                 | Raw `quantity` is signed; named long/short builders take positive quantities. Do not negate short contracts twice. Keep contract multiplier distinct from strategy-unit count.                                                                                 |
| Current value           | `contractValue` is signed option value before multiplying by 100, excluding stock                                                  | `position.value().value` is **P&L**, as is `.pnl`. Current signed market value is the sum of `perLeg[].value`; filter stock out before mapping an options-only field.                                                                                          |
| Loss / unlimited values | Multiple display contracts, including positive loss magnitude and `'Infinite'` in single-leg output                                | Terminal `maxLoss` is signed negative; unbounded bounds are infinities. Normalize display/JSON deliberately, never let `JSON.stringify` silently turn infinities into an unexplained `null`.                                                                   |
| Volatility controls     | OPC commonly averages solved IVs into one rounded strategy IV; relative adjustments appear elsewhere                               | Support common-IV mode and per-leg/current-quote IVs explicitly. `volatilityShock` is additive decimal volatility, while the GEX app slider applies a relative multiplier. `+15%` relative to 30% is 34.5%, not 45%.                                           |
| Expiry boundary         | OPC settles to intrinsic within about 31.6 seconds                                                                                 | Scalar BSM continues to price positive time. At 20 seconds, an ATM $100 call at 30% IV priced at $0 in the app versus $0.009529/share in TotalFinance. Choose and label the UI cutoff; do not bury it inside general-purpose math.                             |
| Probability             | Strategy probability helper uses `log(K/S)/(σ√T)` and the first leg's market inputs; a separate plotted density is normal in price | TotalFinance defaults to a disclosed risk-neutral lognormal model. These are not identical probability definitions. For the test long call, POP was 33.4648% vs 33.6792%. This comparison supplied common terminal break-evens, not the entire screen's state. |

The date convention alone moved these six one-unit current P&Ls by up to $0.2797. After matching
year fractions in the **diagnostic only**, residual P&L differences were below $0.0016. Select the
intended convention in an app-owned contract; permit explained changes rather than weakening tests.

The app's normalized profit factor also contains explicit logistic/bounding heuristics, not the
library's expected P&L or realized trading profit factor. Retain it as an app-labeled heuristic or
replace it as a separately approved product decision. Do not map by similar names.
[App kernel](../../../src/utils/shared/quantlib/strategyKernel.ts),
[app strategy analytics](../../../src/utils/shared/quantlib/StrategyBuilder.ts),
[TotalFinance position/results](../../packages/strategy/src/position.ts).

### Reproduced defects, not convention differences

1. **Library: dated option plus undated stock falsely trips the multi-expiry guard.**
   A raw covered call with an explicit option expiry and an ordinary stock leg throws from
   `payoff()` because `assertSingleExpiry` includes stock's `undefined` expiry. A position-level
   expiry or the named covered-call builder works, but a natural raw composition should work too.
   Fix the guard to classify option expiries without inventing a stock expiry; preserve rejection
   of true calendars and ambiguous option horizons. Test raw covered call, protective put, collar,
   stock-only positions, defaults and true multi-expiry positions.
2. **App: five stock strategies do not scale their shares with strategy size.** At
   `contractMultiplier: 2`, covered call, protective put, collar, covered short straddle and covered
   short strangle all produced 100 shares while their option legs doubled. The library's two-unit
   covered call correctly produced 200 shares and two short calls. The app's URL-size initialization
   passes this multiplier, so this is not merely an unreachable helper discrepancy. Correct the
   stock-leg builders and test sizing rather than making TotalFinance reproduce uncovered exposure.
3. **App: failed IV becomes a plausible 15.1%**, as reproduced above. Fix the status contract before
   using dual-run output to approve an IV migration.
4. **App: return-on-cost can be non-finite.** A valid zero-premium, zero-cost position produced
   `profitPercent: Infinity`. Return an unavailable ratio with a reason when the denominator is
   zero; do not make up collateral/return-on-risk in its place.

### Performance: use the existing batch surface before considering WASM

Recorded local median time for a 300-point, four-leg curve, seven warmed samples:

| Path                                                                                                       |      Time |
| ---------------------------------------------------------------------------------------------------------- | --------: |
| App's prepared first-order kernel                                                                          |  0.219 ms |
| Repeated rich `position.value()`                                                                           | 20.363 ms |
| Public `blackScholesPriceMany(..., { greeks: true })`, including column creation and P&L/Greek aggregation |  0.424 ms |

Rich valuation computes extended Greeks and result metadata; it does more work than the app needs
on every chart point. This is **not** evidence that the underlying library math is 93× slower.
Across diagnostic reruns the batch path stayed around 0.4–0.53 ms; timing is environment-sensitive.
The batch curve's maximum P&L difference from the app kernel was $0.001859 with aligned times.

Use `@totalfinance/options/batch` behind a typed app curve adapter, with dates/legs prepared once and
expired legs settled explicitly (the batch pricer requires positive time). Include stock P&L,
first-order Greeks, strike injection and break-even refinement. Keep rich position methods for
summaries, explanations and less frequent calculations. Benchmark the actual 500-point chart and
payoff table on supported desktop/mobile browsers before rollout. A pleasant prepared strategy
curve API may be worth adding later, but the first experiment does not require a new accelerator.

## 3. GEX/DEX: aggregation works; the products' meanings differ

The matched-input synthetic chain produced:

| Metric                                                                  |              App |                                              TotalFinance |
| ----------------------------------------------------------------------- | ---------------: | --------------------------------------------------------: |
| Net GEX, app `always-short` / library `callsPositivePutsNegative`       |    $389,380.8717 |                                             $389,380.8717 |
| Gross GEX                                                               |  $3,485,721.1747 | $3,485,721.1747, computed as sum of absolute contract GEX |
| Net DEX using that same library convention                              | $14,263,332.7627 |                                          $90,278,689.3399 |
| Net DEX using a **separate** library `{ calls: 1, puts: 1 }` convention | $14,263,332.7627 |                                          $14,263,332.7627 |

The DEX difference is not rounding. The app signs `abs(delta)` by type and presumed hedge
direction. TotalFinance multiplies already-signed delta by the selected position signs. A convention
that reproduces GEX does not automatically reproduce the app's DEX. Do not reverse put delta
globally or call this an error in TotalFinance's defined formula.

Other mappings needing explicit approval:

- **Observed versus model Greeks:** baseline app exposure consumes vendor gamma/delta. TotalFinance
  `exposure()` recomputes from IV, rate, yield and time. Start with separate observed/model labels
  and shadow comparisons. A model profile is not proof that the vendor supplied bad Greeks.
- **Presumed dealer side:** the canonical app transform currently calls
  `deriveTradeDirection(undefined, bid, ask)`, producing `mid`; that fallback is treated as
  presumed short. The default API-fed path therefore does not observe dealer inventory or trade
  initiation, despite the `derived` mode name. Be explicit about this proxy. If signed trade
  inputs are later supplied, per-contract signs need an additional integration contract.
- **Gross versus net:** app `totalGEX` is gross; TotalFinance aggregate `gex` is net. This matters for
  concentration percentages as well as the headline card.
- **Walls:** app finds positive net GEX above spot / negative net GEX below spot; TotalFinance finds
  the largest side-specific exposure magnitudes across strikes. In this deliberately asymmetric
  fixture, app call wall was absent and put wall 97.5; TotalFinance walls were 95 and 105. Both names
  cannot be used without describing which definition is intended.
- **Zero-gamma scans:** app scans roughly ±15% on a rounded grid, fixes rate at 5%, uses 365.25
  and floors time at 30 minutes; library scans ±20%, uses explicit market inputs and ACT/365F,
  and skips expired contracts instead of applying that floor. The fixture roots were 103.27738
  versus 103.27417. Different root availability can also be legitimate with different ranges.
- **Max pain:** TotalFinance restricts it to the nearest expiry; the app's strike-based helper consumes
  its supplied aggregate. An all-expiry profile is not equivalent to nearest-expiry max pain.
- **App-specific scores:** hedging pressure, squeeze scores, confluence, volatility-trigger and
  directional labels are product heuristics. Keep them app-owned initially; review and explain
  each before treating it as a universal library calculation.

Source contracts: [app exposure calculations](../../../src/utils/client/gex/calculations.ts),
[API-to-app transform](../../../src/utils/shared/gex/transformGEXData.ts),
[live/selection filtering and consumers](../../../src/hooks/useGEXDataFromAPI.ts),
[library exposure](../../packages/structure/src/exposure.ts).

**A reproduced app simulation inconsistency:** adding 50% relative IV changed this fixture's
headline net GEX from $389,380.87 to $281,647.18, but the returned zero-gamma level stayed at
103.27738. The app recalculates headline gamma with adjusted IV but passes the original-IV rows
to its price-profile/root calculation (and the hook separately charts the original-IV profile).
Running that profile with the shocked IVs moves the root to 107.48668. Align the simulated
exposure/profile/derived-level snapshot, or explicitly label the retained profile as observed.
This differs from the deliberate choice to keep the **observed skew** panel unsimulated.

## 4. Volatility and skew: observed reads versus model analysis

The app intentionally preserves observed-chain semantics: nearest spot strike for ATM, observed
vendor deltas to select wings, actual chosen wing strikes, put-minus-call skew, and missing wings
as `null`. TotalFinance's `skew()` uses an interpolated surface, forward ATM, model-delta interpolation,
and default call-minus-put risk reversal. Configuring `putMinusCall` fixes the sign, not the rest.

| Same synthetic smile   |          App observation | TotalFinance model, put-minus-call |
| ---------------------- | -----------------------: | ---------------------------------: |
| ATM IV                 |   30.0000% at strike 100 |      29.8813% at forward 100.59365 |
| 25-delta risk reversal | 2.5000 percentage points |           2.7865 percentage points |
| 25-delta butterfly     |           -0.2500 points |                    -0.08715 points |

For the narrowed 95–105 chain, the app reports unavailable 10-delta skew. TotalFinance returns
2.0 points by clamping to boundary IVs **with extrapolation warnings**. The library is not silent,
but dropping its diagnostics would turn a disclosed estimate into a fabricated observed wing.
The app's OLS slope in IV points per 1% moneyness and TotalFinance's local derivative with respect to
log-moneyness are also different estimators—not a generic unit conversion.

Recommendation: **keep the observed panel observed.** Retain its app calculation in the first
rollout, then extract a reusable observed-chain skew operation with provided-delta selection,
explicit tolerances, selected-strike/actual-delta provenance and unavailable-wing reasons. Keep
surface/model skew as a distinct capability. A model view should offer a visible opt-in and show
extrapolation diagnostics. This distinction belongs in SDK and agent output, not just a tooltip.
[App skew](../../../src/utils/client/gex/skew.ts), [library skew](../../packages/volatility/src/skew.ts).

For broader volatility features, TotalFinance already exposes IV rank **and** percentile, expected move,
realized/implied spread, variance risk premium and event decomposition; do not rebuild those in
the app. Their integration needs defined histories, sampling, tenors and data quality—not merely
today's option chain. I found app confluence code mapping `ivPercentile` into a field displayed as
“IV Rank”; I did **not** find an active call site for that confluence calculator in this source scan.
Treat it as a latent naming/semantic issue, not a claim about a currently rendered live card.
[Library volatility exports](../../packages/volatility/src/index.ts),
[separate rank/percentile formulas](../../packages/volatility/src/metrics.ts).

## 5. Net-drift PR: usable components, not the same feature

PR #286 measures cumulative signed **trading premium** by session minute. Its call line is call
buys minus call sells; its put line is put buys minus put sells; net directional premium is call
drift minus put drift. Unknown trades widen uncertainty bands without moving drift.

TotalFinance `exposure(...).netDrift()` estimates **dealer hedging effects** from gamma/charm/vanna.
It is not a session trade-premium chart. `deltaAdjustedPremium()` is also not a substitute because
it weights by delta. Keep distinct names and descriptions; do not promise this PR is implemented
because a method named `netDrift` exists.

The five-print probe gave app call drift $1,500, put drift -$200, net $1,700, unknown premium $310
and classified-premium coverage 92.64%. TotalFinance's flow groups reproduce the premium arithmetic
when provider classification is preserved. However, its current `aggressorSide: 'unknown'` allows
NBBO fallback: the unknown $310 print at 1.55 inside a 1–2 quote was reclassified as a buy, making
composed net premium $2,010. Omitting bid/ask for that classification pass reproduced $1,700, but
that diagnostic proves the policy difference; stripping useful quote data is not the desired
permanent API design. [Library classification](../../packages/structure/src/flow.ts).

Before moving this feature to shared code:

- Add a clear classification-source policy that can preserve authoritative unknowns, separate
  them from absent classification, and report how each classification was obtained.
- Build session bucketing/cumulative raw-premium drift as a distinct operation. Reuse calendar
  support for regular/short sessions and pass the session explicitly rather than selecting the
  date with the most trades. Preserve ticker scope, input timestamp units and contract multipliers.
- Describe the PR's bands as bounds from unclassified premium, not statistical confidence
  intervals; its “confidence” is classification coverage, not probability of a profitable trade.
- Preserve an explicit price-overlay symbol in whole-market mode. The PR backfills leading prices
  from the first later observed price; do not reuse that display series in backtests/agent signals
  without an as-of-safe missing-price policy. Do not infer trading predictiveness from aggregation
  correctness.

This work can proceed separately from OPC. The old PR still needs normal current-develop
integration and UI review; this comparison does not certify its whole application behavior.

## 6. Ordered implementation and acceptance checklist

**Workstream A — repair and establish the boundary (first).**

- [ ] Fix the library's raw stock-plus-dated-option guard; add regression tests and regenerate any
      affected contract evidence. No unnecessary API rename is required for this fix.
- [ ] Fix the app's five stock-sizing builders, failed-IV status propagation and zero-cost ratio.
- [ ] Restore independent test-runner discovery after the merge. Root Jest currently discovers
      **533 TotalFinance tests among 637 total** because its ignores omit `/totalfinance/`. Running the
      library's batch test under root Jest reproduces the Vitest/CommonJS import failure. Exclude
      the library from root Jest; keep its own Vitest/CI job. The 515 targeted app tests passing
      does not make this merged tree globally green. [Root Jest config](../../../jest.config.js).
- [ ] Define a typed app adapter contract: timestamp/time zone, expiry, instrument style, multiplier,
      premiums/fill sides, signed quantities, dividends, rate, common/per-leg volatility, units,
      output meanings and unavailable states. Keep frozen raw input plus normalized input for each
      comparison. Add cross-package contracts to CI; the diagnostic harness is not that full gate.

**Workstream B — OPC shadow mode, then controlled adoption.**

- [ ] Import SDK packages locally through an app-owned integration module; use the library directly
      in browser/server calculations, not an HTTP/MCP round trip. Keep provider credentials,
      authentication, licensing and caching in the app's server/data layer.
- [ ] Preserve existing strike selection initially. Feed identical selected legs, side-specific
      premiums and snapshot times to both engines. Use explicit scalar years for legacy-day-count
      compatibility where required, or approve/document the ACT/365F change.
- [ ] Extend fixtures to all 58 builders and customization: quantities 1/2/10, raw positions,
      stock combinations, spreads/ratios, calendars/diagonals, per-leg volatility, calls/puts,
      0DTE, near/at expiry, DST, missing/zero/crossed/stale quotes, failed IV and unbounded/zero-cost
      outcomes. Non-100 multipliers and American/dividend-sensitive contracts need separate model
      checks; do not imply default BSM covers them just because it matches the old app.
- [ ] Implement and benchmark the batch curve adapter, including expiry settlement, break-even
      refinement and grid strike injection. Run chart/table interaction and mobile measurements.
- [ ] Classify each mismatch: defect, intentional convention, display-only mapping, missing data,
      or unsupported case. Fix unexplained differences; approve economic-model changes explicitly.
      A proposed starting numerical gate for aligned BSM examples is $0.01 per 100-share contract
      and scaled per-share Greek tolerances; low-vega IV must be judged by repricing residual and
      status, not decimal-IV agreement alone.
- [ ] Exercise packed artifacts in the Yarn app without converting its package manager or
      introducing a dependency on private TotalFinance source files. Before public npm availability,
      use locally produced tarballs/private distribution as appropriate. No data redistribution is
      implied by this dogfooding plan.
- [ ] Roll out behind a switch with shadow telemetry and rollback; keep the old path until the
      actual app/browser acceptance is green. Then remove duplicated financial math instead of
      keeping two permanent implementations.

**Workstream C — GEX/DEX and observed skew (parallel design, subsequent rollout).**

- [ ] Capture permitted, timestamped vendor chain snapshots and verify the full normalization and
      filter path; today's matched synthetic chain does not establish vendor/model parity.
- [ ] Approve separate GEX/DEX signs, gross/net labels, supplied/model Greeks, dealer assumptions,
      wall/flip/max-pain definitions, selected-expiry scope, simulation units and expiry floors.
- [ ] Resolve the reproduced IV-simulation split between adjusted headline exposure and the
      original-IV profile/zero-gamma level; test that all simulated exposure views use one snapshot.
- [ ] Shadow the outputs actually displayed: headline cards, strike/expiry profiles, zero gamma,
      walls, max pain, 0DTE/weekly/monthly concentrations, DEX alignment and dependent heuristic
      labels. Test sparse chains and absence of valid roots/levels.
- [ ] Preserve observed skew and missing-wing behavior; extract it into a separate shared surface
      before replacing it. Add the model view only as an explicitly different analysis.
- [ ] Use existing volatility utilities for history-backed features only when the app has the
      correctly defined histories. Keep rank distinct from percentile.

**Workstream D — net-drift adoption (independent of first OPC rollout).**

- [ ] Integrate PR #286 onto current develop separately; add explicit classification-source control,
      session-aware premium drift, honest uncertainty labels and as-of-safe overlay semantics.
- [ ] Validate ticker and whole-market tapes, partial classifications, half-days, duplicate/out-of-
      order timestamps, missing overlays, multiplier handling and cumulative accounting identities.
- [ ] Make SDK/agent discovery distinguish premium drift from dealer hedging drift.

**Before public API release:** resolve the concrete library defect and do at least one complete
OPC dogfooding slice—including real captured inputs, packed app consumption, browser performance,
failure-state UX and rollback. That supplies evidence the existing isolated library tests cannot.
The entire GEX/skew/net-drift migration need not block a limited, honestly scoped preview; it must
block claims that those app experiences have already been ported or validated end to end.

After this work, the existing documentation/browser/shipping, registry verification, external-agent
evaluation and maintainer approval gates still apply. Nothing in this comparison publishes or
launches the library.
