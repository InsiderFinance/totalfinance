/**
 * Phase 3B.N8-DOCS item 7 — the budgeted entrypoints, declared once.
 *
 * "Regenerate package/deep-entrypoint bundle measurements and the stability table only after the new
 * packed imports exist; retain the capability's budget and stability intent across a rename."
 *
 * Both halves of that had failed, because the budgets lived in `budgets.test.ts` and the published
 * table lived in `docs/bundle-size.md`, hand-kept, with nothing between them:
 *
 *   - `@insiderfinance/totalfinance/math` was published as "< 14 KB" while the test allowed 33 KB. A consumer budgeting
 *     from the doc would have been wrong by 2.4x — and 14 KB was a real budget once, four raises ago.
 *   - `@insiderfinance/totalfinance/options/black-scholes` was published as "< 8 KB" after 3B.N2 moved it to 8.5 KB.
 *   - Six budgeted entrypoints — `math/montecarlo`, `calendars/crypto`, the three `fixed-income`
 *     modules, and the umbrella root — were absent from the table entirely, including the largest
 *     number in the library (the umbrella at < 310 KB).
 *
 * So the specifier, the budget, and the INTENT are one record here. The test iterates it and the
 * published table is generated from it, which is what makes "retain the intent across a rename"
 * structural rather than a thing to remember: renaming an entrypoint moves its intent with it,
 * because they are the same object.
 */

/** A substring that must not appear in a bundle, and the guarantee its absence proves. */
export interface ForbiddenSymbol {
  needle: string;
  why: string;
}

export interface BundleBudget {
  /** The public specifier a consumer imports. */
  specifier: string;
  /** Repository-relative source entry the measurement bundles. */
  entry: string;
  /** Budget in KB gzip. Exceeding it fails `budgets.test.ts`. */
  budgetKB: number;
  /** The capability this budget protects — the published table's Notes column. */
  intent: string;
  /** Structural guarantees the test enforces rather than merely measuring. */
  forbidden?: ForbiddenSymbol[];
  /** Why the budget is what it is. Kept as data so a raise records its own reason. */
  rationale?: string;
  /** Bundling the whole umbrella is slow; it needs a longer timeout. */
  timeoutMs?: number;
}

export const BUNDLE_BUDGETS: readonly BundleBudget[] = [
  {
    specifier: '@insiderfinance/totalfinance/options/black-scholes',
    entry: 'packages/options/src/black-scholes.ts',
    budgetKB: 14,
    intent: 'all model exports; runtime guards included, schema/JSON-Schema machinery excluded',
    forbidden: [
      {
        needle: 'toJSONSchema',
        why: 'hot-path rule (§6): the compute entrypoint must not pull schema/JSON-Schema machinery',
      },
      {
        needle: '__TOTALFINANCE_SCHEMA_FACADE__',
        why: 'the runtime schema facade lives at its own entrypoint',
      },
    ],
    rationale:
      '13.75 → 14 KB (0.1.2 speed, 2026-10-05): measured 14,208 B (0.1.1 measured 13,929 B) with Node 22.23.2/esbuild 0.25.12 — the gamma-only Black–Scholes row loop (a 1.6× faster gamma sweep), the remembered expiry-label parses and the finiteness walk that formats a path only for a hit (both in core, shared by every facade). Results are unchanged bit for bit; 128 B of headroom. 11.75 → 11.875 KB (disclosed-holdings warning registration, 2026-09-25): isolated Node 22.23.2/esbuild 0.25.12 measurements against 009f223 are 12,029 → 12,058 B gzip (+29 B), with an identical retained-module set. The one new public WarningCode member grows the shared catalog; no holdings or schema implementation enters pricing. The installed expert kernel remains 2,321 B. All forbidden-dependency and installed-consumer canaries stay unchanged; headroom is 102 B. ' +
      '8 KB → 8.5 KB in Phase 3B.N2. The stable diagnostic codes this entrypoint carries became ' +
      'self-describing (`vol.surface_extrapolated` → `volatility.surface_extrapolated`, plus the ' +
      'matching enum members), which costs ~25 B gzip. The budget’s real content — no schema or ' +
      'validator machinery on the hot path — is unchanged and still asserted. ' +
      '8.5 KB → 9.5 KB in the 2026-08-02 defect-fix wave: the implied-vol solvers moved to a ' +
      'RELATIVE acceptance tolerance with a typed price-below-resolvable failure (they had been ' +
      'fabricating converged:true with an arbitrary volatility for any premium at or below 1e-8), ' +
      'plus the underflow and low-vega disclosures and core’s widened finiteness walker. Measured ' +
      '9,022 B. Boundary and honesty code on the hottest path, not dependency creep — the import ' +
      'graph is unchanged and the forbidden-needle checks above still prove it. ' +
      '9.5 KB → 10 KB in the RV6 review wave, measured 9,818 B, for two fixes a reviewer found: ' +
      'the implied-vol solver now rejects a non-positive or reversed volatility bracket (it had ' +
      'returned converged:true with a plausible IV for `loVolatility: -0.1`), and the five facade ' +
      'methods that share one validator now derive their missing-field example from the method that ' +
      'actually failed instead of all naming `.price`. The example is built behind a thunk, so the ' +
      'SUCCESS path allocates nothing — the first version computed it on every call, which is the ' +
      'per-call cost this budget exists to catch, caught here by the budget itself. Still no schema ' +
      'or validator machinery pulled in; the forbidden-needle checks are unchanged and still pass. ' +
      '10.5 → 10.75 KB (FC7 slice 4, 2026-08-29): five risk warning codes joined core’s central ' +
      'WarningCode table, which every entrypoint carries whole — measured 10,771 B, 19 B over the ' +
      'old line; no new imports, the needle checks still pass.' +
      '10.75 → 11 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 11,050 B, 42 B over the old line; no new imports, the needle checks still pass.' +
      '11 -> 11.25 KB (Stage 4.6 slice 2, 2026-09-03): four more backtest codes registered centrally (backtest.input_too_large, delisting_return_missing, universe_membership_unknown, ledger_reconciliation_failed) reach every entrypoint that imports the ErrorCode registry; measured 11,314 B against 11,264 B, headroom now 206 B. No pricing code changed.' +
      '11.25 → 11.5 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes registered in core (the not_reset refusal and the seven rejection-row codes the trading environment returns) ride every entrypoint that bundles the error taxonomy; measured 11,550 B against a 11.25 KB line this row already sat within a few dozen bytes of, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed.' +
      '11.5 → 11.75 KB (dogfooding warning registration, 2026-09-07): three public WarningCode entries for quote-only chain health, duplicate supplied contracts and no eligible supplied quotes grow the shared registry. Isolated old/new measurements are 11,717 → 11,783 B gzip (+66 B), seven bytes beyond the old line. The contributing source set is identical; no sector, artifact, provider or schema implementation is added to pricing. Structural forbidden-dependency checks remain unchanged.' +
      ' 11.75 → 13.75 KB (selective Greeks and exposure, 2026-10-01; docs/specs/selective-greeks-and-exposure.md): origin/main measured 12,029 B (3 B under the old line), this change 13,929 B (+1,900 B) with Node 22.23.2/esbuild 0.25.12. The blackScholes namespace gains six members (delta, gamma, theta, vega, rho, evaluate — each with .explain), which a namespace object cannot tree-shake, plus the one selective kernel they share (bsm-evaluate.ts: the plan resolver and the allocation-free row loop, 2.2 KB minified) and core’s requireSelection with its five teaching refusals and its label guard (the guard, added when the enforcement run measured the helper, is 109 B of the total, and the review fixes on #3 another 29 B). No schema, validator, artifact or engine module joins; the forbidden-needle checks still pass.',
  },
  {
    specifier: '@insiderfinance/totalfinance/core',
    entry: 'packages/core/src/index.ts',
    budgetKB: 20,
    intent: 'types, errors, conventions, dates, symbology, calendar engine; no exchange datasets',
    forbidden: [
      {
        needle: '2001-09-11',
        why: 'Calendars 0.1 acceptance: core must not ship exchange holiday datasets; the NYSE closure list lives in @insiderfinance/totalfinance/calendars',
      },
    ],
  },
  {
    specifier: '@insiderfinance/totalfinance/core/artifacts',
    entry: 'packages/core/src/artifacts/index.ts',
    budgetKB: 32,
    intent:
      'the Gate B artifact spine: canonical JSON, SHA-256 identity, snapshot/artifact/scenario envelopes — its own entrypoint so pricing bundles never pay for it',
    forbidden: [
      {
        needle: '__TOTALFINANCE_SCHEMA_FACADE__',
        why: 'the spine serializes envelopes; it must not pull the runtime schema facade',
      },
    ],
    rationale:
      'Pre-publish interface repairs (2026-09-16, valuation instants): 31 → 32 KB, measured 31,798 B. The stamped snapshot asOfConvention (validated on read) and the requireInstantMarketSnapshot guard, which validates through the one snapshot reader before it reads a field; ' +
      'Gate B first slice: the canonical serializer with its teaching errors, the pure-TS ' +
      'synchronous SHA-256 (browser safety is the point — no node:crypto), and the three envelope ' +
      'families with full boundary validation. The hot-path guarantee is structural: core’s ' +
      'root entrypoint does not re-export this module, so its own 20 KB budget proves compute ' +
      'bundles stay artifact-free. 14 → 14.5 KB (correction wave, 2026-08-23): the full nested validators — table handles, chain-quote numerics, curve pillars — and the re-verified inputsHash (measured 14,487 B). 14.5 → 15.5 KB (defect-fix wave, 2026-08-23): the ONE shared provenance validator (closed keys, typed fields, structured warnings) and the sound is* guards — every public guard now routes through its complete read-door validator instead of a five-field sniff, with the extra teachings that entails (measured 15,338 B). 15.5 → 16 KB (RateCurve one-contract wave, 2026-08-23): the shared curve validator the snapshot spine bundles now derives every pillar’s discount factor through core’s own compounding transform (yearFraction + discountFactor) and refuses pre-asOf pillars — economics checks with their teachings, replacing the advisory-field sign heuristic (measured 15,926 B). 16 → 16.5 KB (FC7 closeout, 2026-08-29): canonical JSON now refuses sparse/accessor/decorated arrays and behavioral or hidden object members without invoking them, so the bytes hashed are exactly the stored data the reducer observes (measured 16,448 B, headroom 448 B).' +
      '16.5 → 23 KB (Stage 4.5 slice 1, 2026-09-02): the bounded stored-data scanner promoted from @insiderfinance/totalfinance/scenarios (one scanner, one Barrier A cost law, now with a closed options request), the structural compareAnalysisArtifacts / artifactReplayParity walk with its teaching refusals and count-safe limits, the fitted-model summary validator, and tableHandleForRows (measured 23,159 B, headroom 393 B).' +
      ' 23 → 24.5 KB (Stage 4.5 slice 4, 2026-09-03): the shared fitted-model kit — ARTIFACT_WORK_LIMITS with its named floors, the work-limit and comparison-tolerance validators, the family-scoped report migration walk, referenced-row hash verification, parameter flattening, and residual statistics — one engine every domain adapter (volatility, fixed-income, research) rides instead of three copies — each helper a closed, typed door of its own, and a referenced-row handle must describe the rows in every member, not only by hash (measured 24,804 B, headroom 284 B).' +
      '24.5 -> 24.75 KB (Stage 4.6 slice 2, 2026-09-03): four more backtest codes registered centrally (backtest.input_too_large, delisting_return_missing, universe_membership_unknown, ledger_reconciliation_failed) reach every entrypoint that imports the ErrorCode registry; measured 25,104 B against 25,088 B, headroom now 240 B. No artifact code changed.' +
      '24.75 → 25.25 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 25,405 B against a 24.75 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.' +
      '25.25 → 31 KB (dogfooding value, 2026-09-07): compareCalculationArtifacts adds bounded per-metric selectors, exact IEEE tolerance decisions, input/assumption/operation identity and source-failure disclosures over the existing artifact engine. Measured 30,975 B. This is an opt-in artifact entrypoint; core root and Black-Scholes budgets and forbidden-dependency assertions are unchanged.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/core/pricing',
    entry: 'packages/core/src/pricing.ts',
    budgetKB: 15.25,
    intent:
      'the Gate C Pricer/requirements protocol and conformance kit — contract types and probes, zero pricing mathematics',
    rationale:
      'Gate C first slice: the requirement/observation grammar with its teaching errors, the ' +
      'selection-report validator, definePricer, and the behavioral conformance kit. The ' +
      'no-second-engine law is the content: this entrypoint must never grow pricing math — it ' +
      'validates and routes, and adapters wrap existing public functions. Seated at 7.5 KB ' +
      '(measured 7,356 B) after the landing pass closed the pricer key set and added the ' +
      "boundary-name guards the deep probe demanded. 7.5 → 9.5 KB (correction wave, 2026-08-23): the serializable RateCurve observation pulls the shared curve validator and the real asOf grammar into the protocol — data honesty over method bags (review finding 8). 9.5 → 11.5 KB (defect-fix wave, 2026-08-23): the conformance kit’s honesty probes now compare COMPLETE canonical results, which pulls the canonical-JSON serializer into the kit — a probe that read only .value certified pricers whose assumptions drifted call-to-call (review finding 3) — plus the curveId subject field and the impliedVolatility/currency observation domains (measured 11,227 B). 11.5 → 13 KB (randomness law, 2026-08-23, second external review): deterministic:boolean → randomness:'none'|'seeded' with the seeded conformance probes — the seed-required refusal, the assumptions.seed echo, same-seed complete-result identity, the two-copy batch seed-derivation probe with its MAX_SAFE_INTEGER refusal, and the seed-ignoring law for 'none' — plus the strengthened shared curve validator this entrypoint bundles (measured 12,829 B). 13.5 → 13.75 KB (FC7 closeout, 2026-08-29): this conformance entrypoint deliberately shares canonical JSON's complete-result comparator, so it inherits the stored-data/accessor safety correction (measured 13,847 B, headroom 233 B); no pricing mathematics or new dependency joined." +
      '13.75 → 14 KB (Stage 7A slice 1, 2026-09-03): the nine operation.* runtime codes registered in core ride every entrypoint that bundles the error taxonomy (measured 14,150 B, headroom 186 B).' +
      '14 → 15 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes (environment.not_reset and the seven rejection-row codes) registered in core — the refusal and the rows the trading environment returns and never throws — ride every entrypoint that bundles the error taxonomy; this one sat 1 B over its line at 14,337 B before the seven were added, so the budget moves a whole kilobyte and the next code pays nothing.' +
      ' 15 → 15.25 KB (selective Greeks and exposure, 2026-10-01): origin/main 15,307 B, now 15,405 B (+98 B) — the New York offset formatter built once per module instead of once per expiry validation (InsiderFinance/totalfinance#1: a lazy formatter and an hour-keyed offset cache in core/time) and the input.duplicate_entry code. No pricing mathematics joined.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/math',
    entry: 'packages/math/src/index.ts',
    budgetKB: 40.5,
    intent: 'the whole numerical suite; consumers tree-shake to far less via deep entrypoints',
    rationale:
      'Measures the kitchen-sink import of the whole index; real consumers import deep/used symbols ' +
      'and pay far less. 12 KB in Phase 1 → 14 KB when Phase 2 grew math into the full numerical ' +
      'foundation → 16 KB with LU/QR/SVD + pseudoinverse, differential evolution and bicubic ' +
      'interpolation → 18 KB completing §8.3 with the general (Hessenberg + Francis QR) eigensolver ' +
      '→ 26 KB with the WS9 statistical tier (OLS + Newey–West, the ACF/PACF/unit-root/cointegration/' +
      'Hurst suite, Student-t/χ²/gamma, Kalman) → ~26.5 KB with Ledoit–Wolf 2004 constant-correlation ' +
      'shrinkage → 33 KB, raised +5 KB in P3.1c when the central ErrorCode/WarningCode registries ' +
      'absorbed all 101 leaf-package codes → 34 KB in 3B.1b (Law-12 statistics cluster): the 18 ' +
      'statistics reductions and covarianceMatrix gained closed options boundaries — the did-you-mean ' +
      'key guard, the nanPolicy enum ladder, and per-field teaching errors, nearly all message ' +
      'strings (measured 33,823 B against 33,792 allowed). → 37 KB in the math-to-zero wave: the ' +
      'optimizer/integration/interpolation/linalg/timeseries/Monte-Carlo boundary ladders and ' +
      'their teaching strings (measured 36,943 B). 37 → 39 KB (library-wide count safety, 2026-08-26 ' +
      'fourth-review closeout): every workload control (random counts/iterations, Monte-Carlo ' +
      'paths/dimensions, optimizer population/generations, low-discrepancy counts, Sobol dimIndex) ' +
      'is a safe integer with a measured cap and its teaching string (measured 38,700 B). Still ' +
      'zero-dependency. ' +
      '39 → 40 KB (Stage 7A slice 3, 2026-09-03): luSolve closes its LuResult argument — a hand baseline exposed that an edited decomposition was solved into nonsense; requireLuResult (square finite factors, a valid permutation, sign ±1) and its teaching strings (measured 40,503 B, headroom 457 B).' +
      '40 → 40.5 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 41,004 B against a 40 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/math/montecarlo',
    entry: 'packages/math/src/montecarlo.ts',
    budgetKB: 7.375,
    intent: 'Sobol direction numbers are generated, not a vendored table',
    rationale:
      '7.25 → 7.375 KB (installed-consumer repair, 2026-09-21): measured 7,501 B with Node 22.23.2/esbuild 0.25.12. Shared input codes are private named constants so guard-only consumers can drop the complete error registry; whole-registry consumers pay small binding overhead. No added module family; the lean expert-price fixtures independently cap the resulting savings. ' +
      'WS9.5 lifted the 13-dimension Sobol cap to 1111 dimensions. The direction numbers are ' +
      'GENERATED from primitive polynomials at load (a few KB of code), NOT a ~50 KB vendored table, ' +
      'so the base Monte-Carlo path stays lean — this budget is the proof. 6 KB (was 5) in 3B.1b: ' +
      'this entrypoint imports the statistics reductions, whose options are now closed Law-12 ' +
      'boundaries; the module it already pulled grew by the key guard and its teaching strings ' +
      '(measured 5,604 B, was 4,478 B). The Sobol claim is unchanged — no new module became reachable. ' +
      '6 → 7 KB (library-wide count safety, 2026-08-26): paths/dimensions/count are safe integers ' +
      'with measured caps and product bounds, each with its teaching (measured 6,519 B).' +
      '7 → 7.25 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes registered in core (the not_reset refusal and the seven rejection-row codes the trading environment returns) ride every entrypoint that bundles the error taxonomy; measured 7,216 B against a 7 KB line this row already sat within a few dozen bytes of, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/math/normal',
    entry: 'packages/math/src/normal.ts',
    budgetKB: 3,
    intent: 'standard normal only — the canonical lean deep entrypoint',
    rationale:
      'The deep entrypoints (design law #9) let consumers import one feature without the whole ' +
      'numerical suite. `/normal` is the canonical hot path — used by stats, options, anything.',
  },
  {
    specifier: '@insiderfinance/totalfinance/calendars/nyse',
    entry: 'packages/calendars/src/nyse.ts',
    budgetKB: 8,
    intent: 'rules-based — no giant holiday tables',
  },
  {
    specifier: '@insiderfinance/totalfinance/calendars/crypto',
    entry: 'packages/calendars/src/crypto.ts',
    budgetKB: 4.875,
    intent: 'aliases alwaysOpen and pulls in no exchange-holiday dataset',
    rationale:
      '4.75 → 4.875 KB (installed-consumer repair, 2026-09-21): measured 4,934 B with Node 22.23.2/esbuild 0.25.12. The shared validation-code split adds small binding overhead to whole-registry consumers while allowing guard-only kernels to discard unrelated codes. The no-dataset boundary remains enforced. ' +
      '3.5 KB (was 3): the 2026-08-02 defect-fix wave made createRuleCalendar copy its rule arrays ' +
      'and session object at construction and reject an all-weekend configuration, so one calendar ' +
      'can no longer answer the same rule two ways depending on query order. Measured 3,169 B. The ' +
      '9/11 needle check below still proves the equity dataset stays out. 4 → 4.25 KB (Stage ' +
      '4.4b): the shared scenario error and warning codes joined core’s central registries, which ' +
      'every entrypoint importing core carries whole (measured 4,114 B); the no-dataset needle ' +
      'check below is unchanged.' +
      '4.25 → 4.5 KB (Stage 7A slice 1, 2026-09-03): the operation.* codes registered in core (measured 4,356 B, headroom 252 B).' +
      '4.5 → 4.75 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes registered in core (the not_reset refusal and the seven rejection-row codes the trading environment returns) ride every entrypoint that bundles the error taxonomy; measured 4,641 B against a 4.5 KB line this row already sat within a few dozen bytes of, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed.',
    forbidden: [
      {
        needle: '2001-09-11',
        why: 'decoupled from us-market.js: the NYSE 9/11 closure (a us-market-only date) must not leak in',
      },
    ],
  },
  {
    specifier: '@insiderfinance/totalfinance/performance/sector-performance',
    entry: 'packages/performance/src/sector-performance.ts',
    budgetKB: 10.5,
    intent: 'simple and audited sector returns; no option pricing or schema machinery',
    rationale:
      'PR #336 (2026-09-07): measured 10,374 B gzip for both pure entrypoints, shared aggregation, runtime teaching and complete selected-input lineage. Consumers need not import the umbrella or unrelated performance metrics.',
    forbidden: [
      { needle: 'blackScholesPrice', why: 'sector returns must not pull option-pricing engines' },
      {
        needle: '__TOTALFINANCE_SCHEMA_FACADE__',
        why: 'pure sector computation must not pull schema machinery',
      },
    ],
  },
  {
    specifier: '@insiderfinance/totalfinance/performance/sharpe',
    entry: 'packages/performance/src/sharpe.ts',
    budgetKB: 9,
    intent: 'verified to pull in no option pricing',
    rationale:
      'Pre-publish interface repairs C (2026-09-21, hygiene): 8.75 -> 9 KB, measured 8.8 KB. An empty series is refused by the drawdown door through the shared InputError, and the core registries ride whole. ' +
      '7.75 KB (was 7.5), FC7 slice 3 (2026-08-28): two portfolio repair codes ' +
      '(reversal_target_missing, reversal_infeasible) joined core’s central ErrorCode table, which ' +
      'every entrypoint carries whole — measured 7,699 B, 19 B over the old line; the no-option-pricing ' +
      'needle check below still holds. ' +
      '7.5 KB (was 7), the optional-scalar null-coalescing wave: the shared ' +
      'resolvePeriodsPerYear/resolveRiskFreeRate ladders and the front-door guards on the public ' +
      'helpers (requireSeries, degenerateAwareDiagnostics, riskAdjustedAssumptions) live in this ' +
      'module and carry their teaching strings (measured 7,381 B). ' +
      '7 KB (was 6.5), 3B.1b Law-12 statistics cluster: this package computes over the @insiderfinance/totalfinance/math ' +
      'statistics reductions, whose options are now closed boundaries; the entrypoint inherits the ' +
      'did-you-mean key guard and its teaching strings (measured 6,799 B). ' +
      "Previously 6.5 KB (was 6): the 2026-08-02 wave grew core's Law-7 finiteness walker to cover provenance, " +
      'BigInt, DataView and Map/Set contents, and every facade in this package routes through it. ' +
      'Measured 6,258 B. The no-option-pricing needle check below still holds.' +
      '8 → 8.25 KB (Stage 7A slice 1, 2026-09-03): the operation.* codes registered in core (measured 8,222 B, headroom 226 B). ' +
      '8.25 → 8.5 KB (Stage 4.6 slice 5, 2026-09-04): backtest.margin_breach and backtest.forced_liquidation joined the central WarningCode registry that every entry carries whole — measured 8,461 B against 8,704 B, headroom 243 B; the sharpe module itself is unchanged.' +
      '8.5 → 8.75 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 8,708 B against a 8.5 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
    forbidden: [
      {
        needle: 'black-scholes-merton',
        why:
          'must not transitively bundle option pricing (§15.1)' +
          '7.75 → 8 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 8,091 B, 155 B over the old line; no new imports.',
      },
    ],
  },
  {
    specifier: '@insiderfinance/totalfinance/technical-analysis/rsi',
    entry: 'packages/technical-analysis/src/rsi.ts',
    budgetKB: 8.75,
    intent: 'single indicator, deep entrypoint',
    rationale:
      '8.25 → 8.75 KB (installed-consumer correctness repair, 2026-09-21): measured 8,842 B with Node 22.23.2/esbuild 0.25.12. The leaf now binds its own closed parameter set, defaults, input kind and conventions through a private immutable-copy helper; previously the full registry had to run before these guards and disclosures existed. No other indicator or discovery catalog is retained; installed cross-bundler boundaries verify that independently. ' +
      '7 KB (was 6): 3B.1a put the snapshot READER into the framework module every indicator already ' +
      'imports — envelope validation, the indicator-identity guard, the non-finite codec, and the ' +
      'checked state accessors with their teaching messages. Measured at +1.6 KB gzip (5.0 → 6.6), ' +
      'nearly all of it message strings. The import graph is unchanged: nothing new became reachable ' +
      'from this entrypoint, the module it already pulled got bigger. What the previous 6 KB bought ' +
      'was a restore path spelled `state["period"] as number`, which costs no bytes and accepts a ' +
      'snapshot written by any other indicator. 7 → 7.5 KB (library-wide count safety, 2026-08-26): ' +
      'the shared snapshot reader\u2019s integer/lookback accessors gained their safe-integer ' +
      'ladders — corrupt JSON counts teach instead of freezing a stream clock (measured 7,214 B).' +
      '7.5 → 7.75 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 7,735 B, 55 B over the old line; no new imports.' +
      '7.75 -> 8 KB (Stage 4.6 slice 2, 2026-09-03): four more backtest codes registered centrally (backtest.input_too_large, delisting_return_missing, universe_membership_unknown, ledger_reconciliation_failed) reach every entrypoint that imports the ErrorCode registry; measured 7,974 B against 7,936 B, headroom now 218 B. No indicator code changed.' +
      '8 → 8.25 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 8,267 B against a 8 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/fixed-income/lattice',
    entry: 'packages/fixed-income/src/lattice.ts',
    budgetKB: 12.875,
    intent: 'short-rate lattice; pulls the option/BSM kernel for the equity leg',
    rationale:
      '12.75 → 12.875 KB (installed-consumer repair, 2026-09-21): measured 13,112 B with Node 22.23.2/esbuild 0.25.12. The shared validation-code split adds small binding overhead when the full error registry is also needed; no new runtime dependency or capability. Separate installed expert-price fixtures enforce removal of the unrelated registry and facades. ' +
      '9 KB (was 8): E5 added the Law 12 spec-key guards, bond/curve instance teaching errors, and ' +
      'the bermudan report grammar (assumptions echo + diagnostics) — deliberate boundary code ' +
      '(~0.6 KB gzip), not dependency creep; the import graph is unchanged. ' +
      '10.5 KB (was 9), 2026-08-02 defect-fix wave: schedule boundaries are now computed from the ' +
      'maturity anchor rather than iteratively from the previous one (the clamp-inheritance defect ' +
      'that silently moved coupon dates through February), and the OAS/switch solvers expand their ' +
      'brackets instead of reporting false non-convergence on distressed input. Measured 9,754 B. ' +
      'Note this entrypoint was already ~41 B over its 9 KB budget BEFORE the wave. ' +
      '11 KB → 11.5 (2026-08-16 coordinated tail sweep): shortRateTree teaches its REQUIRED model ' +
      'with a complete example call and ladders steps; generateSchedule closes endOfMonth ' +
      '(measured 11,375 B). 11.5 → 12 KB (library-wide count safety, 2026-08-26): lattice steps are ' +
      'safe integers with a cap that names the per-step cost (measured 11,907 B).' +
      '12 → 12.25 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 12,402 B, 114 B over the old line; no new imports.' +
      '12.25 -> 12.5 KB (Stage 4.6 slice 1, 2026-09-03): three backtest codes registered in the central ErrorCode registry (backtest.ambiguous_intrabar, stale_quote, adapter_nonconformant) reach every entrypoint that imports ErrorCode; measured 12,571 B against a 12,544 B budget, headroom now 229 B. No lattice code changed.' +
      '12.5 → 12.75 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes registered in core (the not_reset refusal and the seven rejection-row codes the trading environment returns) ride every entrypoint that bundles the error taxonomy; measured 12,816 B against a 12.5 KB line this row already sat within a few dozen bytes of, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/fixed-income/convertible',
    entry: 'packages/fixed-income/src/convertible.ts',
    budgetKB: 8.75,
    intent: 'convertible bond pricing, reported separately so a consumer sees what it pays',
    rationale:
      '6.5 KB (was 6), 2026-08-02 defect-fix wave: inherits the anchor-based schedule generation ' +
      'and the expanding yield bracket. Measured 6,370 B; already ~23 B over before the wave. ' +
      '7 KB → 7.5 (2026-08-16 coordinated tail sweep): inherits the endOfMonth schedule ladder ' +
      'and the shared bond-analytics option ladders through its yield leg — measured 7,168 B, ' +
      'EXACTLY the old 7 KB line. 7.5 → 8 KB (library-wide count safety, 2026-08-26): inherits the ' +
      'lattice step ladder through its equity leg (measured 7,747 B).' +
      '8 → 8.25 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 8,210 B, 18 B over the old line; no new imports.' +
      '8.25 -> 8.5 KB (Stage 4.6 slice 2, 2026-09-03): four more backtest codes registered centrally (backtest.input_too_large, delisting_return_missing, universe_membership_unknown, ledger_reconciliation_failed) reach every entrypoint that imports the ErrorCode registry; measured 8,450 B against 8,448 B, headroom now 254 B. No convertible code changed.' +
      '8.5 → 8.75 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 8,752 B against a 8.5 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/fixed-income/xva',
    entry: 'packages/fixed-income/src/xva.ts',
    budgetKB: 11.75,
    intent: 'CVA/DVA/FVA valuation adjustments, reported separately',
    rationale:
      '11.5 → 11.75 KB (pre-publish interface repairs, 2026-09-18, assumptions and units): one more code in the central registry (strategy.expiry_conflict, the position-owns-its-horizon refusal) rides every entrypoint that bundles the error taxonomy; measured 11,784 B against an 11.5 KB line this row sat 8 B under, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed. ' +
      '10 → 10.5 KB (Gate B, 2026-08-20): four artifact-spine error codes joined core\u2019s central ' +
      'registry (serialization.unsupported_value, artifact.migration_missing/duplicate_migration/' +
      'id_mismatch), and every bundle importing ErrorCode inherits the registry \u2014 xva crossed ' +
      'its line by 37 B (measured 10,277 B). The spine itself stays out of compute bundles (its ' +
      'own entrypoint, not re-exported from core\u2019s root); the registry is the one shared cost. ' +
      'Previously 9.2 KB (was 8.7), 3B.1b Law-12 statistics cluster: inherits the closed statistics/linalg ' +
      'options boundaries through its math imports (measured 9,159 B, +389 B). ' +
      'Previously 8.7 KB (was 8.5), 2026-08-04 3B.1b: XVA pulls in the credit module, so it inherits ' +
      '`requireFiniteFields` and the `credit.cdsBasis` field guard. Measured 8,770 B — 66 B over the ' +
      '8.5 KB line, and the cost of a basis that can no longer return NaN from a missing leg. ' +
      'Previously 8.5 KB (was 8), 2026-08-02 defect-fix wave: anchor-based schedule generation, ' +
      'measured 8,396 B.' +
      '11 → 11.25 KB (Stage 7A slice 1, 2026-09-03): the operation.* codes registered in core (measured 11,317 B, headroom 203 B).' +
      '11.25 → 11.5 KB (Stage 7B.1 slice 1, 2026-09-05): the eight environment codes registered in core (the not_reset refusal and the seven rejection-row codes the trading environment returns) ride every entrypoint that bundles the error taxonomy; measured 11,611 B against a 11.25 KB line this row already sat within a few dozen bytes of, so the budget moves a quarter kilobyte and the growth is recorded, not absorbed.',
  },
  {
    specifier: '@insiderfinance/totalfinance/volatility/artifacts',
    entry: 'packages/volatility/src/artifacts.ts',
    budgetKB: 88,
    intent:
      'Stage 4.5 fitted-model artifacts for the twelve volatility families: save/restore/evaluate/replay/compare, warm starts, stability, holdout — a subpath so calibration bundles never pay for the spine',
    rationale:
      'Pre-publish interface repairs (2026-09-16, valuation instants): 85 → 88 KB, measured 89,268 B. The volatility market-day copy was deleted in favour of the core helper, but the core time module it now shares (session table, strict door) is larger than the copy; ' +
      'Stage 4.5 slice 3 (2026-09-02): this entrypoint is deliberately the whole family table — every ' +
      'direct calibrator it replays (SVI, SSVI, eSSVI, SABR, the Heston COS calibrator, vanna–volga, ' +
      'event volatility, GARCH, HAR-RV, the surface) and every direct evaluator it dispatches to ' +
      '(including the options Heston and SABR kernels), plus the Gate B spine (canonical JSON, SHA-256, ' +
      "envelope validation, the comparison walk) and the eight verbs' teaching validation. A consumer " +
      'that only calibrates imports the calibrator subpath and pays none of this. Measured 84,979 B ' +
      '(83.0 KB) at landing; the budget is 85 KB so the next slice reconciles its growth rather than absorbs it.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/fixed-income/artifacts',
    entry: 'packages/fixed-income/src/artifacts.ts',
    budgetKB: 45.5,
    intent:
      'Stage 4.5 fitted-model artifacts for the four curve families: save/restore/evaluate/replay/compare and the repricing-residual holdout — a subpath so bootstrap bundles never pay for the spine',
    rationale:
      'Pre-publish interface repairs C (2026-09-21, hygiene): 42 -> 45.5 KB, measured 44.5 KB. Every diagnostic code names a WarningCode member, so the subpath now carries the core registries it spelled as strings before. ' +
      'Stage 4.5 slice 4 (2026-09-03): the four curve families over their stored data — the family table (bootstrap re-issue, exact stored-state restore, repricing residuals through the public instrument valuations), the six verbs an exact bootstrap can honour on the shared core kit (no warm start, no stability — a verb that refuses every input is a dead door), and the curve/survival data validators. The subpath bundles the bootstraps, the swap/CDS valuations they reprice through, and the artifact spine: a consumer that only bootstraps imports the package root and pays none of it (measured 41,636 B, headroom 1,372 B).',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/backtest/portfolio',
    entry: 'packages/backtest/src/portfolio/index.ts',
    budgetKB: 114,
    intent:
      'Stage 4.6 portfolioBacktest: the ledger-backed multi-asset simulator with its eight instrument adapters and the conformance suite — a subpath so a single-instrument backtest never pays for the ledger fold or the adapters',
    rationale:
      'Pre-publish interface repairs (2026-09-16, valuation instants): 112 → 114 KB, measured 114,967 B. The same core time helpers plus the stamped snapshot asOf convention; ' +
      'September 2026 R01–R05: 101 → 112 KB, measured 113,585 B. Causal timing, projected-ledger entry funding, signed lifecycle events and fixed-income-owned calendar accrual replace silent-wrong-number paths. Reusing bonds.fixedRate deliberately adds the existing validated bond/schedule implementation; no second formula or new public helper is introduced. Pricing hot-path budgets remain unchanged. ' +
      'Stage 4.6 slice 5 (2026-09-04): the engine (instants, lifecycle, flows, marks, the declarative proposal through proposePortfolioRebalance, execution, the margin check, the valuation marks), the adapters, and the guards, over @insiderfinance/totalfinance/portfolio, @insiderfinance/totalfinance/calendars, and the execution layer — measured 99,744 B against 102,400 B, headroom 2,656 B.' +
      "100 → 101 KB (Stage 7B.2 slice 3, 2026-09-06): the engine's fill sequence moved into fillOrderWithPolicy, whose typed doors (the policy, order, observation, terms, and instants re-validated for a direct caller) now ride the portfolio entry; measured 102,518 B.",
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/portfolio/trade',
    entry: 'packages/portfolio/src/trade/index.ts',
    budgetKB: 77.5,
    intent:
      'Stage 7B.2 the safe trade lifecycle: intents and execution plans, the structured policy, and preflight through the ledger fold and the monitor — a subpath so a ledger consumer never pays for the lifecycle',
    rationale:
      'Pre-publish interface repairs B5/B6 (2026-09-21, combos and one order vocabulary): 76 -> 77.5 KB, measured 76.3 KB. Combo terms on the intent and the plan, the combo after-state in preflight, the combo binding in the grant, and the core order vocabulary. ' +
      'Stage 7B.2 slice 1 (2026-09-05): the artifacts and their guards, normalization from an intent or a rebalance proposal, the policy with its stricter-merge, and preflight — which bundles the snapshot, the reducer fold, and the monitor it composes (the monitor is most of the weight). Measured 64,195 B (62.7 KB); the budget is 65 KB so slice 2 (the grant, the journal, reconciliation) reconciles its growth rather than absorbs it.' +
      '65 → 76 KB (Stage 7B.2 slice 2, 2026-09-06): the authorization grant (create + verify with the variance envelope), the execution journal fold with its transition table, and reconcileExecution composing reconcilePortfolio — the slice-2 verbs and their closed guards; measured 74,507 B.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/backtest/environment',
    entry: 'packages/backtest/src/environment/index.ts',
    budgetKB: 142.25,
    intent:
      'Stage 7B.1 createTradingEnvironment: the deterministic trading-agent environment over the portfolio engine — reset/step, open orders, typed rejections, the trace identity — a subpath so a backtest never pays for the environment and the environment pays only for the engine it drives',
    rationale:
      "142 → 142.25 KB (0.1.2 speed, 2026-10-05): measured 145,443 B, 35 B over the old line — core's remembered expiry-label parses and path-on-hit finiteness walk, which every result here passes through; 221 B of headroom. 141 → 142 KB (pre-publish interface repairs, 2026-09-18, assumptions and units): the environment features require an annualization (no per-bar volatility feeding annualized consumers), the bench baseline and episodes name theirs, and the paper broker and plan it composes refuse an OCC option symbol without a declared multiplier through the core OCC grammar predicate; measured 144,489 B, 105 B over the 141 KB line. " +
      'September 2026 R01–R05: 129 → 141 KB, measured 142,528 B. Inherits the corrected portfolio engine and existing fixed-income calendar owner; adds explicit currency funding in the multi-currency episode. The engine/environment split and hot-path exclusions remain intact. ' +
      'Stage 7B.1 slice 1 (2026-09-05): the environment core (the definition and action guards, reset/step over the stepper seam, open-order carry-forward and cancel/replace, idempotent retry, the trace hash) on top of the multi-asset engine it composes — the engine with its eight adapters is ~99 KB of the whole. Measured 103,352 B (100.9 KB) at landing; the budget is 103 KB so slice 2 (limits, the mask, the reward, features) reconciles its growth rather than absorbs it.' +
      "103 → 119 KB (Stage 7B.1 slice 2, 2026-09-05): limits judged post-trade by FC7's monitorPortfolio (the environment bundles the monitor rather than re-deriving one family of it), the pre-trade projection and the action mask, the reward composition, the feature recipes over @insiderfinance/totalfinance/math and @insiderfinance/totalfinance/performance, and the freshness block. Measured 119,353 B (116.6 KB); the budget is 119 KB so slice 3 (the episode library and the environment run kind) reconciles its growth rather than absorbs it." +
      '119 → 124 KB (Stage 7B.1 slice 3, 2026-09-05): runEnvironmentEpisode (the trace-driven episode the artifact spine replays) and the twenty seeded scenario generators of the episode library. Measured 124,798 B (121.9 KB); the budget is 124 KB so slice 4 (the baselines and Agent Bench) reconciles its growth rather than absorbs it.' +
      '124 → 129 KB (Stage 7B.1 slice 4, 2026-09-05): Agent Bench — the six baseline policies, runAgentBench with its leakage probe and retry drive, and the transcript scorer. Measured 128,804 B (125.8 KB); the budget is 129 KB so slice 5 (the operation and the closeout) reconciles its growth rather than absorbs it.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/backtest/paper',
    entry: 'packages/backtest/src/paper/index.ts',
    budgetKB: 37.125,
    intent:
      'Stage 7B.2 createPaperBroker: the first execution adapter over the engines’ own fill path — submit (grant verification, idempotency, the receipt), step (fills through fillOrderWithPolicy and the ledger events), cancel, deliver, halt; its own entrypoint so the engines never pay for the broker',
    rationale:
      '37 → 37.125 KB (installed-consumer repair, 2026-09-21): measured 37,920 B with Node 22.23.2/esbuild 0.25.12. Private shared validation constants add binding overhead to whole-registry consumers while preserving code identities and allowing guard-only consumers to discard the registry. No broker behavior or dependency changed. ' +
      'Pre-publish interface repairs B5/B6 (2026-09-21): 34.5 -> 37 KB, measured 36.1 KB. All-or-none combo fills against one observation instant with the net-limit check, the submission stamp and the observation-before-submission refusal. ' +
      '34 → 34.5 KB (pre-publish interface repairs, 2026-09-18, assumptions and units): the broker refuses an OCC option symbol it has no multiplier for, at creation and at submit, through the core OCC grammar predicate (the grammar was split from expiry resolution so this costs the parse, not the session calendar: 36.6 KB with the calendar, 34,876 B without); 60 B over the 34 KB line. ' +
      'September 2026 R06/R07: 33 → 34 KB, measured 33,969 B. Persisted order/instrument/fill context, identity restoration, and replay-safe partial observations replace the empty restart state. ' +
      'Stage 7B.2 slice 3 (2026-09-06): the broker composes @insiderfinance/totalfinance/portfolio/trade (the grant verification, the journal fold) and the execution module (the policy, the fill models, the shared fill helper) — measured 31,207 B at landing (2026-09-06) against a 33 KB line.',
  },
  {
    specifier: '@insiderfinance/totalfinance/backtest/artifacts',
    entry: 'packages/backtest/src/artifacts.ts',
    budgetKB: 235.5,
    intent:
      'Stage 4.6 backtest-run artifacts over the cross-sectional engine and its grid: save/read/replay/compare with embedded or referenced rows of the request and the run, models by description, the run hash, and the FC8 identity list — a subpath so a bundle that only backtests never pays for the spine',
    rationale:
      'Pre-publish interface repairs C (2026-09-21, hygiene): 234 -> 235.5 KB, measured 234.1 KB. The core order vocabulary and the registries every code now names. ' +
      'Pre-publish interface repairs (2026-09-16, valuation instants): 231 → 234 KB, measured 237,792 B. The core shared session table (early-close-aware close, the session-instant helper, the one America/New_York day boundary) and the strict valuation door ride along; ' +
      'September 2026 repairs: 223 → 231 KB, measured 235,351 B. Replays the corrected portfolio/environment engines and calendar-based bond accrual; those paths account for the growth. Artifact transport remains off direct compute imports. ' +
      'Stage 4.6 slice 3 (2026-09-04): the kind table (two kinds re-issued on replay, their row sets, callbacks, and model fields), the four verbs on the shared core kit, and the engine plus the grid they import (research, the allocator, execution, the ledger, the hygiene verbs) — measured 130,470 B against 133,120 B, headroom 2,650 B. ' +
      '130 → 180 KB (Stage 4.6 slice 4, 2026-09-04): the options kind re-issues optionsBacktest on replay, so the subpath now bundles the options book engine too (the chain selectors, the strategy constructors, marking, margin and the risk limits, the ledger fold) — measured 179,329 B against 184,320 B, headroom 4,991 B. ' +
      '180 → 202 KB (Stage 4.6 slice 5, 2026-09-04): the portfolio kind re-issues portfolioBacktest on replay, so the subpath now bundles the multi-asset engine and its eight adapters (the observation cursors, the lifecycle fold, the declarative proposal, the margin check) — measured 203,696 B against 206,848 B, headroom 3,152 B.' +
      '202 → 223 KB (Stage 7B.1 slice 3, 2026-09-05): the environment run kind re-issues runEnvironmentEpisode on replay, so the subpath now bundles the trading environment over the engine it already carried — the limits through FC7’s monitor, the mask, the reward, the features (+21 KB gzip; measured 225,634 B).',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/research/artifacts',
    entry: 'packages/research/src/artifacts.ts',
    budgetKB: 44,
    intent:
      'Stage 4.5 research-run artifacts over the eleven FC3 operations: save/read/replay/compare with embedded or referenced rows, the verbatim hygiene block, and the recipe — a subpath so screening bundles never pay for the spine',
    rationale:
      'Pre-publish interface repairs C (2026-09-21, hygiene): 41 -> 44 KB, measured 42.9 KB. The hygiene block accepts null Sharpe figures (zero-variance series) and every code names a WarningCode member, so the registries ride along. ' +
      'Stage 4.5 slice 5 (2026-09-03): the run-kind table (eleven FC3 operations re-issued on replay, their bulk row-set patterns, callback fields, and the typed comparison accessors), the four verbs on the shared core kit, the structural hygiene validator (six risk result shapes, assumptions open), and the recipe validator. The subpath bundles every screening, factor, and event-study operation plus the artifact spine: a consumer that only screens imports the package root and pays none of it (measured 40,598 B, headroom 1,386 B).',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/workflows',
    entry: 'packages/workflows/src/index.ts',
    budgetKB: 502.5,
    intent:
      'Stage 7A: the protocol-neutral operation registry and the curated operations every transport adapts — bundles the compute it composes; a transport imports it, an application imports the domain packages directly',
    rationale:
      '502.25 → 502.5 KB (0.1.2 speed and exposureFromGreeks breakdowns, 2026-10-05): measured 514,383 B (+79 B over the old line) — the gamma-only Black–Scholes row loop (a 1.6× faster gamma sweep), the remembered expiry-label parses and the finiteness walk that formats a path only for a hit (both in core, shared by every facade), and the supplied-exposure `breakdowns` flag; 177 B of headroom. 497.25 → 502.25 KB (selective Greeks and exposure, 2026-10-01): origin/main measured 508,996 B (188 B under the old line), this change 514,035 B (+5,039 B) with Node 22.23.2/esbuild 0.25.12. The exposure operation composes the selective ExposureProfile, which now evaluates through @insiderfinance/totalfinance/options/batch (the validated blackScholesEvaluateManyInto boundary, 4.4 KB minified) and the shared kernel (2.2 KB), and carries the nine single-metric shortcuts and the supplied-Greek selection; core gains requireSelection (its label guard, added when the enforcement run measured the helper, is 302 B of the total; the review fixes on #3 — the batch row-value type check and its error descriptions, per-point color — another 123 B). No new operation, transport or dependency domain. ' +
      '495 → 497.25 KB (installed-consumer correctness repair, 2026-09-21): measured 508,947 B with Node 22.23.2/esbuild 0.25.12. All built-in TA facades now bind their own shared metadata before registry import. The complete operation catalog includes that construction code and shared named declarations; narrow consumers are separately budgeted, and no runtime dependency or financial calculation changed. ' +
      'Freeze correctness repairs (2026-09-21): 494 -> 495 KB, measured 494.3 KB on supported Node 22. Durable write-ahead grant recovery, plan-scoped combo lifecycle and hedge-capacity validation, and separate embedded execution-cost attribution. No new dependency; the local filesystem coordinator remains outside the browser root. ' +
      'Pre-publish interface repairs B (2026-09-21, wire contracts): 488 -> 494 KB, measured 492.8 KB. The shared envelope schema (the spilled-handle branch), grant consumption in the stores, the combo grammar on the trade wire, and the C code registries. ' +
      'September 2026 R08/R10/R14: 476 → 482 KB, measured 490,994 B. Full discriminated trade input/output schemas, trusted approval lookup, transactional journal integration and corrected domain engines. Node-only file locking stays in the local subpath, never this browser-safe root. ' +
      'Stage 7A slice 1 (2026-09-03): the operation contract, the registry with its registration refusals, the runtime (byte budget, strict parse, seed policy, deadline verdict, JSON-safe output, identity), and the twenty-four operations re-homed from @insiderfinance/totalfinance-mcp WITH the compute they compose — every domain pack (options, TA, strategy, volatility, structure, risk, performance, calendars, crypto, fixed income, the opt-in backtest). Big by design and measured, like the MCP server it replaces the schemas of: a transport imports this; an application that wants one calculation imports its domain package (measured 206,220 B, headroom 6,772 B). ' +
      '208 → 330 KB (Stage 7A slice 2, 2026-09-03): the ten journey operations compose @insiderfinance/totalfinance/portfolio (ledger, snapshot, P&L, timeline, policy monitor), @insiderfinance/totalfinance/scenarios, @insiderfinance/totalfinance/research and the options backtester, so the package now bundles those four surfaces too — the same by-design shape as slice 1, measured rather than absorbed (measured 335,951 B, headroom 1,969 B; the journey packs are opt-in, so a transport that enables only the domain packs still pays for them here — a consumer that wants one calculation imports its domain package). ' +
      '330 → 334 KB (Stage 7A slice 3, 2026-09-03): the handle grammar, the memory artifact and job stores with their shared validators, the runtime handle resolution and large-output spill, and the bounded preview (measured 339,416 B, headroom 2,600 B). ' +
      '334 → 372 KB (Stage 4.6 slice 3, 2026-09-04): totalfinance.backtest.cross_sectional_run composes crossSectionalBacktest and a declared execution policy, so the opt-in backtest pack now bundles the cross-sectional engine — research eligibility and scoring, the allocator, the execution policy, the ledger fold — the same by-design shape as the journey packs, measured rather than absorbed (measured 378,003 B, headroom 2,925 B). ' +
      '372 → 382 KB (Stage 4.6 slice 4, 2026-09-04): totalfinance.backtest.options_run now composes the options book — the rule book, the limits, the fill and freshness policies, calendars and diagonals, corporate actions, dividends, the surface, and the ledger fold (measured 387,285 B, headroom 3,883 B). ' +
      '382 → 405 KB (Stage 4.6 slice 6, 2026-09-04): totalfinance.backtest.portfolio_run composes portfolioBacktest, so the opt-in backtest pack now bundles the multi-asset engine, its eight instrument adapters, and the calendars it counts settlement days on — measured 410,809 B against 414,720 B, headroom 3,911 B. ' +
      '405 → 415 KB (Stage 4.7 slice 2, 2026-09-04): totalfinance.valuation.company composes discountedCashFlowFromStatements and the sensitivity table, so the registry now bundles the valuation package (the statement projection, the DCF, the terminal-value methods) — the new L5 → L3 edge, measured 420,525 B against 424,960 B, headroom 4,435 B.' +
      "415 → 447 KB (Stage 7B.1 slice 5, 2026-09-05): totalfinance.backtest.environment_episode composes runAgentBench and the artifact spine's environment kind, so the opt-in backtest pack now bundles the trading environment, the six baselines, the bench with its leakage probe and retry drive, and the episode library (+31.6 KB gzip; measured 453,524 B). A consumer that never expands the pack pays none of this." +
      "447 → 476 KB (Stage 7B.2 slice 4, 2026-09-06): the trade pack's six operations with their wire schemas, the capabilities gate, and the authorization and journal stores; measured 482,528 B." +
      '482 → 488 KB (Stage 5A second pre-publish refresh, 2026-09-07): the September review repairs (the transactional journal store, trusted-grant verification in the trade operations) over this refresh; measured 494,733 B.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/research',
    entry: 'packages/research/src/index.ts',
    budgetKB: 25.25,
    intent: 'point-in-time screening, style factors, and event studies',
    rationale:
      'FC3 first slice: the declared-field observation contracts, the closed screen grammar with ' +
      'its teaching errors, the factor toolkit (winsorize/standardize/neutralize/composite/' +
      'quantiles/IC/turnover/decay), the seven canonical recipes, and the event-study module. ' +
      'Teaching strings dominate the weight, as everywhere in this library. 21 → 22 KB ' +
      '(library-wide overflow closeout, 2026-08-26): winsorization now uses scaled moments and ' +
      'cancellation-safe summation, and refuses only mathematically unrepresentable results instead ' +
      'of overflowing intermediate arithmetic (measured 21,930 B). The added bytes are numerical ' +
      'correctness at the public boundary; the import graph remains workspace-only. 10.5 → 11 KB (library-wide count safety, 2026-08-26): simulation paths ' +
      'are safe integers with a cap sized to the per-path exposure grid (measured 10,808 B). 13 → 13.5 KB (FC7, 2026-08-28): three portfolio codes joined core\u2019s central ' +
      'ErrorCode registry, and every bundle importing ErrorCode inherits the registry (measured 13,379 B). ' +
      '22 → 22.75 KB (Stage 7A slice 3, 2026-09-03): inherits requireLuResult through the factor toolkit linear algebra (measured 22,908 B, headroom 388 B).' +
      '22.75 -> 24.75 KB (Stage 4.6 slice 1, 2026-09-03): the point-in-time universe vocabulary the simulators read — UniverseHistory validation (interval overlap, exit reasons, delisting returns), universeMembershipAt, eligibleObservationsAt with the session-index lag — is root surface by the ownership row (research owns universe identity); the three screening verbs now delegate to the same resolver, so the law costs its bytes once. Measured 25,056 B against 23,296 B, headroom now 288 B.' +
      '24.75 → 25.25 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 25,422 B against a 24.75 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/foreign-exchange',
    entry: 'packages/foreign-exchange/src/index.ts',
    budgetKB: 10.75,
    intent: 'currency pairs, conversion, forwards and parity, currency exposure',
    rationale:
      'FC5 first slice: the CurrencyPairQuote contract and its guards, inversion/cross-rate/' +
      'conversion/pip value, covered interest parity, forward points and valuation, swap and ' +
      'non-deliverable-forward values, and the exposure/hedging module. Teaching strings dominate ' +
      'the weight, as everywhere in this library.' +
      '10 -> 10.25 KB (Stage 4.6 slice 2, 2026-09-03): four more backtest codes registered centrally (backtest.input_too_large, delisting_return_missing, universe_membership_unknown, ledger_reconciliation_failed) reach every entrypoint that imports the ErrorCode registry; measured 10,288 B against 10,240 B, headroom now 208 B. No foreign-exchange code changed.' +
      '10.25 → 10.75 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 10,583 B against a 10.25 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/portfolio/disclosed-holdings',
    entry: 'packages/portfolio/src/disclosed-holdings.ts',
    budgetKB: 10.5,
    intent:
      'exact disclosed quantity/value changes, complete-universe weights and concentration; no ledger or provider integration',
    forbidden: [
      {
        needle: 'toJSONSchema',
        why: 'the pure disclosure calculator must not pull schema/JSON-Schema machinery',
      },
      {
        needle: '__TOTALFINANCE_SCHEMA_FACADE__',
        why: 'the runtime schema facade stays at its own entrypoint',
      },
    ],
    rationale:
      'Initial disclosed-holdings surface (2026-09-25): measured 10,510 B gzip with Node 22.23.2/esbuild 0.25.12; 242 B headroom. The dedicated import retains only its exact-decimal/boundary/calculation modules and shared core helpers. It does not retain portfolio ledger, provider, artifact or schema implementations.',
  },
  {
    specifier: '@insiderfinance/totalfinance/portfolio/disclosed-holding-partitions',
    entry: 'packages/portfolio/src/disclosed-holding-partitions.ts',
    budgetKB: 11.375,
    intent:
      'exact reported line partitions, complete-universe partition weights and conservative basis comparisons',
    forbidden: [
      {
        needle: 'toJSONSchema',
        why: 'the provider-free calculator must not retain schema machinery',
      },
      { needle: '__TOTALFINANCE_SCHEMA_FACADE__', why: 'the runtime schema facade stays separate' },
    ],
    rationale:
      'Initial reported holding partitions (2026-10-06): measured 11,449 B gzip with Node 22.23.2/esbuild 0.25.12; 199 B headroom. Only the dedicated validator/calculator and shared exact-decimal/core helpers are retained, without ledger, provider or artifact implementations.',
  },
  {
    specifier: '@insiderfinance/totalfinance/portfolio',
    entry: 'packages/portfolio/src/index.ts',
    budgetKB: 110.5,
    intent:
      'the FC7 event-derived ledger and independent disclosed-holdings comparison; events, reducer, serialization, valuation, FC4 seam',
    rationale:
      '108.125 → 110.5 KB (reported holding partitions, 2026-10-06): measured 110,715 → 112,927 B gzip (+2,212 B) on Node 22.23.2/esbuild 0.25.12. The additive calculator/validator reuse the existing private exact-decimal module; no dependency family is added. The dedicated partition import measures 11,449 B and has its own cap. Headroom is 225 B; all narrow installed-consumer canaries remain unchanged. ' +
      '104 → 108.125 KB (disclosed holdings, 2026-09-25): isolated 009f223/current measurements are 106,352 → 110,554 B gzip (+4,202 B), with Node 22.23.2/esbuild 0.25.12. The only newly retained modules are disclosed-holdings, its boundary and its private exact-decimal arithmetic; no dependency family is added. The named domain export adds the requested API; its dedicated 10.5 KB subpath is independently capped. Headroom is 166 B. ' +
      'Pre-publish interface repairs B5/B6 (2026-09-21): 102 -> 104 KB, measured 103.1 KB. Combos on the trade grammar, the core order vocabulary, and the option terms spelled as type. ' +
      '101 → 102 KB (pre-publish interface repairs, 2026-09-18, assumptions and units): a rebalance leaves a non-held OCC option target unresolved with the reason instead of sizing it at a share multiplier (the core OCC grammar predicate, without the session calendar), and every plan row carries the contract multiplier its estimate applied; measured 103,759 B, 335 B over the 101 KB line. ' +
      'FC7 first slice (Stage 4.4, 2026-08-28): the closed economic-event grammar with per-variant ' +
      'teaching validation, the pure lot/cash reducer (four relief policies), the versioned ' +
      'events-not-state ledger envelope riding the Gate B artifact spine (canonical JSON + ' +
      'content hash + registered migrations), the explicit market/as-of valuation snapshot, and ' +
      'the flow/mark series seam into @insiderfinance/totalfinance/performance. Runtime dependencies are exactly ' +
      'core + performance (the FC0 graph row); the spine and the performance flow-aware module ' +
      'are what this entrypoint pays for beyond its own teaching strings. Measured 22,423 B at landing; the budget is 23 KB so the next slice ' +
      '(timeline/P&L) must reconcile its growth rather than absorb it. 23 → 37 KB (slice 2, 2026-08-28): portfolioPnl (the reconciled ' +
      'identity, per-currency ledger, eight groupings) and portfolioTimeline, which composes ' +
      'the performance package’s portfolioReturnIndex and underwater — the flow-aware FC4 module ' +
      'now rides this entrypoint (measured 36,071 B). 37 → 41 KB (slice 3, 2026-08-28): the ' +
      'administration family — exact per-family inverses with their infeasibility teachings, the ' +
      'correction and migration folds, repair-envelope validation, fill-effect and reversal-link ' +
      'state — and reconcilePortfolio on ./reconciliation (settled/unsettled classification, the ' +
      'two explanations, validated draft envelopes); measured 40,710 B, headroom ~1.2 KB. ' +
      '41 → 70 KB (slice 4, 2026-08-29): the policy-driven management surface on ./policy — the ' +
      'investment-policy grammar (model artifacts with dated strategic/tactical/glide-path sets, ' +
      'hierarchical sleeves, benchmark and liability identity, closed limits) and its ONE ' +
      'group-to-instrument expansion law, allocatePortfolio (lot rounding, dust, cost model, cash ' +
      'conservation), proposePortfolioRebalance (drift, flows, turnover/cash capping, post-trade ' +
      'limits, lot previews, the trade-plan artifact), and monitorPortfolio (eleven alert families ' +
      'with hysteresis/debounce/cooldown/acknowledgment state). Four modules of closed-key ' +
      'validators and teaching strings; measured 69,020 B, headroom ~2.6 KB. ' +
      '70 → 80 KB (slice 5, 2026-08-29): the lifecycle families — the shared reducer kernel, the ' +
      'derivative lifecycle (exercise/assignment/expiration/settlement, variation margin, rolls, ' +
      'multiplier and strike adjustments), the corporate/fixed-income/transfer families, thirteen ' +
      'new closed-key validators, and the monitor’s option-expiration/assignment-risk families; ' +
      'measured 79,166 B, headroom ~2.7 KB. 80 → 85 KB (FC7 slice-5 closeout, 2026-08-29): ' +
      'the restoration boundary now validates the complete nested PortfolioState, every ' +
      'identifier-indexed dictionary preserves hostile-but-valid own keys, canonical JSON decodes ' +
      'those keys safely, and derivative lifecycle events enforce their economic contract; measured ' +
      '85,219 B after final provenance/hash/fold parity and shared-validator hostile-input safety, ' +
      'headroom ~1.8 KB.' +
      ' 85 → 85.25 KB (Stage 4.6 slice 4, 2026-09-04): four central code registrations (backtest.book_too_large, backtest.unsupported_corporate_action, backtest.limit_rejected, backtest.combo_leg_unfilled) reach every entrypoint that imports the registries — measured 87,046 B against 87,296 B, headroom 250 B.' +
      "85.25 → 94 KB (Stage 7B.2 slice 1, 2026-09-05): the root re-exports normalizeTradePlan, preflightTradePlan, and mergeTradePolicies, so the package index now bundles the trade lifecycle's grammar, guards, normalization, policy, and preflight (+7.0 KB gzip; measured 94,339 B). A consumer that only folds the ledger imports ./ledger and pays none of it." +
      '94 → 101 KB (Stage 7B.2 slice 2, 2026-09-06): the four slice-2 verbs re-exported at the root (grant, verify, journal fold, reconcileExecution) with their guards; measured 101,517 B.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/commodities',
    entry: 'packages/commodities/src/index.ts',
    budgetKB: 11,
    intent: 'cost-of-carry forwards, implied carry inputs, roll analytics, curve state',
    rationale:
      'FC6 first slice: the frozen cost-of-carry first touch and its inverses (implied convenience ' +
      'yield and storage cost), contract valuation, hedge ratio and basis, term-structure ' +
      'classification with a disclosed tolerance, calendar/curve spreads, roll yield and the ' +
      'exact multiplicative roll decomposition, seasonality, and the explicit-factor unit ' +
      'conversion. Teaching strings dominate the weight, as everywhere in this library ' +
      '(measured 9,385 B). 9.5 → 10 KB (correction wave, 2026-08-23): the Law-7 overflow refusal — a finite-input Infinity now teaches instead of returning (measured 9,768 B).' +
      '10 → 10.25 KB (Stage 4.5 slice 1, 2026-09-02): ten artifact error/warning codes (the Stage 4.5 comparison, replay, model-version, referenced-data, embedded-input, and operation codes) joined core’s central ErrorCode/WarningCode tables, which every entrypoint carries whole — measured 10,352 B, 112 B over the old line; no new imports.' +
      '10.25 -> 10.5 KB (Stage 4.6 slice 1, 2026-09-03): the same three central ErrorCode registrations; measured 10,510 B against 10,496 B, headroom now 242 B. No commodities code changed.' +
      '10.5 → 11 KB (Stage 7B.2 slice 1, 2026-09-05): the nine trade codes and operation.capability_missing registered in core ride every entrypoint that bundles the error taxonomy; measured 10,879 B against a 10.5 KB line this row sat within a few dozen bytes of, so the budget moves a step and the growth is recorded, not absorbed.',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance/scenarios',
    entry: 'packages/scenarios/src/index.ts',
    budgetKB: 72,
    intent:
      'shared deterministic scenario execution: full revaluation, Taylor approximation, aggregation, FX conversion, and exact replay',
    rationale:
      'Pre-publish interface repairs (2026-09-16, valuation instants): 70 → 72 KB, measured 72,526 B. The snapshot asOf-convention guard for option pricing and the shared core time helpers; ' +
      'Stage 4.4b first slice: the complete shared-scenario runner, three target builders, bounded ' +
      'work barriers, resolver and factor-handler extension points, full/Taylor valuation, ' +
      'portfolio aggregation, exact artifact replay, and the teaching validation required at every ' +
      'public boundary (measured 70,057 B gzip).',
    timeoutMs: 120_000,
  },
  {
    specifier: '@insiderfinance/totalfinance',
    entry: 'packages/totalfinance/src/index.ts',
    budgetKB: 693.5,
    intent: 'the deliberately-everything umbrella import; tree-shakes or use totalfinance/<domain>',
    timeoutMs: 120_000,
    rationale:
      '691.25 → 693.5 KB (reported holding partitions, 2026-10-06): measured 707,616 → 709,976 B gzip (+2,360 B) on Node 22.23.2/esbuild 0.25.12. Only the new provider-free partition calculation and its separate validation/type boundary enter the deliberately whole-surface umbrella; exact decimals are shared, all original disclosure code stays unchanged. Headroom is 168 B; narrow installed-consumer budgets are not raised. ' +
      "690.75 → 691.25 KB (0.1.2 speed and exposureFromGreeks breakdowns, 2026-10-05): measured 707,616 B (+288 B over the old line) — the gamma-only Black–Scholes row loop (a 1.6× faster gamma sweep), the remembered expiry-label parses and the finiteness walk that formats a path only for a hit (both in core, shared by every facade), and the supplied-exposure `breakdowns` flag; 224 B of headroom. 686.5 → 690.75 KB (PR #4 integrated with 0.1.1 main, 2026-10-02): the combined source measures 707,171 B gzip with Node 22.23.2/esbuild 0.25.12, versus main's 702,783 B (+4,388 B). The umbrella now includes the three exact-decimal disclosed-holdings runtime modules, structured policy echo and one registered warning in addition to selective Greeks/exposure. Headroom is 157 B. The separate holdings import measures 10,550 B within its unchanged 10.5 KB cap, the portfolio domain 110,588 B within 108.125 KB; all narrow installed-consumer and forbidden-dependency gates remain intact. " +
      '681.25 → 686.5 KB (selective Greeks and exposure, 2026-10-01): origin/main measured 697,450 B (150 B under the old line), this change 702,783 B (+5,333 B) with Node 22.23.2/esbuild 0.25.12 — the same additions the workflows row records (selective kernel, batch selection boundary, named Greeks and evaluate, selective exposure with nine shortcuts, supplied selection, requireSelection and its label guard, the expiry formatter cache, and the review fixes on #3); 193 B of headroom. ' +
      '680 → 681.25 KB (installed-consumer correctness repair, 2026-09-21): measured 697,387 B with Node 22.23.2/esbuild 0.25.12. Built-in TA contracts are now shared named declarations bound by every leaf, so the all-exports umbrella includes their construction code. This protects narrow-import correctness without relying on discovery side effects; separate installed-function budgets enforce lean imports and document the esbuild root-namespace limitation. ' +
      'Pre-publish interface repairs B and C (2026-09-21): 674 -> 680 KB, measured 677.8 KB. Combos and one order vocabulary, chainGreeks and usEquityOption, the unified portfolio VaR door, and every code as a registry member. ' +
      'Pre-publish interface repairs (2026-09-18, assumptions and units): 672 → 674 KB, measured 689,089 B. One engine-inversion kernel with style-aware bounds (the American door, a European contract with a named engine, and the chain-health report share it), the chain-health American rows and dividend disclosure, the OCC grammar predicate and its refusals in the plan, paper broker and rebalance, the required annualization and risk-free rate, and the display-unit Greek kernel in risk; every other entrypoint stays inside its own line after the grammar/calendar split. ' +
      'Pre-publish interface repairs (2026-09-16, valuation instants): 670 → 672 KB, measured 686,738 B. The core time module grew by the session table and the strict valuation door; ' +
      'All 13 domains behind one specifier. Real apps either tree-shake it (the umbrella is ' +
      '`sideEffects: false` re-exports) or import `@insiderfinance/totalfinance/<domain>` and pay only that slice. The ' +
      'budget exists so the kitchen-sink number is a MEASURED claim in CI, not folklore. ' +
      '300 KB → 310 KB in Phase 3B.N6: the naming normalization expanded thousands of identifiers ' +
      '(`iv` → `impliedVolatility`, `cvar` → `conditionalValueAtRisk`, …) and esbuild preserves ' +
      'PROPERTY names, so the kitchen-sink import crossed 300 KB by ~200 B — 0.06%. The cost of the ' +
      'vocabulary, paid once, recorded rather than absorbed: the umbrella’s re-exports and dependency ' +
      'set are byte-identical to the previous commit, so the growth is identifier length, not creep. ' +
      '310 KB → 325 KB in the 2026-08-02 defect-fix wave, and the +20.8 KB is RECONCILED rather ' +
      'than absorbed. This entrypoint is every package at once, so it carries the sum of the wave’s ' +
      'validation, guards and disclosures: measured 321.8 KB against 301.0 KB before. The two ' +
      'full package indexes that carry their own budgets grew +0.9 KB (core) and +1.8 KB (math), ' +
      'so ~1.5 KB across fourteen packages predicts ~21 KB — against 20.8 KB observed. The library ' +
      'has no third-party dependencies and the wave’s new modules import only workspace paths, so ' +
      'there is no import-creep channel for the rest to hide in. Headroom is deliberately ~3 KB, ' +
      'not the 13 KB an initial 335 KB would have left: a budget with slack in it cannot see the ' +
      'next jump, which is the only thing this number exists to do. 325 KB → 327 KB in 3B.1a: the ' +
      'snapshot reader is +1.6 KB gzip at `technical-analysis/rsi` and the umbrella pays it once ' +
      '(321.8 → 325.3 KB), because the reader is ONE module every indicator shares rather than ' +
      'per-indicator code. 330 KB → 332 KB in the RV6 review wave (measured 338,372 B): the ' +
      'shared validators in costs.ts, transforms.ts, svi.ts, ssvi.ts and models.ts now derive their ' +
      'missing-field example from the failing function rather than sharing one constant that named ' +
      'a different API — nine `bar.*` methods had been recommending `bar.typical`. All derived ' +
      'examples are thunks, so no success path pays for them. ' +
      'per-indicator code. 327 KB → 330 KB for the review-correction wave, +2.2 KB measured ' +
      '(325.3 → 327.5): the registry\u2019s clone-and-freeze at registration, the fluent pipeline\u2019s ' +
      'closed-key alias validation, the broker\u2019s bracket-capacity ledger, and the MCP server\u2019s ' +
      'construction-time budget checks — four guards, each with its teaching message. Headroom stays ' +
      'at ~2.5 KB for the same reason as before: slack is what stops a budget seeing the next jump. ' +
      '332 KB → 334 KB in the 3B.1b Law-12 statistics cluster: 19 math boundaries (the 18 statistics ' +
      'reductions plus covarianceMatrix) gained closed options validation, paid once in the shared ' +
      'statistics module (measured 340,325 B = 332.3 KB against 339,968 allowed). Headroom ~1.7 KB. ' +
      '334 KB → 337 KB in the 3B.1b exotics closure: the reusable validateClosedRequest walker in ' +
      'core plus the GENERATED validation specs for all 41 exotics boundaries — the runtime now ' +
      'carries the declaration-projected allowlists it enforces (measured 344,609 B = 336.5 KB). ' +
      'That is the deliberate trade: the bytes ARE the contract data, deduped per distinct contract ' +
      'identity and emitted once per package, and the hand enum consts they replace were deleted. ' +
      '337 KB → 338 KB with the fixed-income bonds cluster specs (measured 345,487 B). 338 → 342 KB ' +
      'with the 68 TA Stream-constructor specs — the largest generated-spec module yet, guarding the ' +
      'back doors beside the facades (measured 349,105 B). 342 → 343 KB: the root-finder guards — ' +
      'compiler-checked tables and teaching strings only, deliberately NOT the generated-spec ' +
      'walker, because brent sits in the black-scholes hot entrypoint whose intent is no ' +
      'schema/validator code (that entrypoint measured 9,818 → 10,239 B, still under its 10 KB ' +
      'line, and math 34,213 B under 34,816) — the umbrella pays the strings once (350,403 B). 343 → 345 KB: the sabr/engines/local-volatility ' +
      'generated specs and teaching (measured 352,396 B) — spec data for 25 more closed boundaries. 345 → 348 KB: the volatility package sweep — 45 ' +
      'boundaries of generated specs including the large surface/calibration contracts ' +
      '(measured 355,838 B). 348 → 350 KB: the TA declared-required-but-defaulted wave — ' +
      'registered defaults, the divergence/register/pivots/output-metadata ladders and the ' +
      'requireBooleanWhenPresent teaching strings, plus the open-bar guards (measured 357,615 B). ' +
      'Bytes are teaching messages and disclosure data across ~12 TA modules; the umbrella pays ' +
      'them once. 350 → 351 KB: the strategy example-shape walk in the named() wrapper and the ' +
      'chart-types flush/percent/lines/reversal ladders (measured 358,702 B). 351 → 352 KB, with ' +
      'lattice 10.5 → 11 and convertible 6.5 → 7: the fixed-income conventions sweep — the ' +
      'dayCount/frequency/compounding domain ladders and required-field teaching across the CDS, ' +
      'swap, curve, futures, inflation and convertible families (measured 360,136 B). ' +
      '352 → 353 KB: the risk package sweep — 39 when-present ladders and their teaching across ' +
      '12 files (measured 361,278 B). 353 → 354 KB: the risk second slice — shared-entry seed, ' +
      'constraint-object and estimator ladders (measured 361,930 B). 354 → 355 KB: the strategy ' +
      'leg/options sweep — leg builder closures, the Position constructor config ladders and the ' +
      'scanner/optimizer domains (measured 362,715 B). 355 → 357 KB: the math-to-zero wave ' +
      '(measured 364,985 B). 357 → 358 KB: the TA-to-one and backtest front-door slices ' +
      '(measured 366,200 B). 358 → 359 KB: the FI stratum, crypto-to-zero and options-tail ' +
      'slices (measured 367,033 B). 359 → 360 KB (with black-scholes 10 → 10.5, calendars/crypto ' +
      '3.5 → 4, xva 9.2 → 9.5): the core-utilities wave — between/formatter/warning/plausibility/' +
      'calendar-config guards live in core, so every dependent bundle inherits their teaching ' +
      'strings (measured 368,142 B; black-scholes 10,276 B with its forbidden-needle checks ' +
      'still proving no schema machinery). 360 → 361 KB (xva 9.5 → 10): the fixed-income model ' +
      'floor — the vasicek/g2pp/discountBond/schedule/swap-third-stratum ladders (measured ' +
      '369,097 B; xva 9,812 B inherits the swapXva conventions). ' +
      '361 → 363 KB (lattice 11 → 11.5, convertible 7 → 7.5): the coordinated tail sweep — ' +
      'options engine/flag ladders across seven pricing heads, the fixed-income fourth stratum, ' +
      'the broker registerOption/submit/processBar closures, strategy premiums/chain/label ' +
      'ladders and the structure exposure/flow configs, five packages in one wave ' +
      '(measured 371,000 B). 363 → 365 KB: DEFECTIVE ZERO — the backtest package gains its first ' +
      'generated-spec module (optionsBacktest\u2019s full EntryRule union tree walked by ' +
      'validateClosedRequest) plus the vectorized/tearsheet/eventDriven/calendar/mcp second-stratum ' +
      'ladders and their teaching strings (measured 372,888 B). 365 → 366 KB: the H07 covariance ' +
      'contract — requireFiniteSymmetric in risk/linalg (finite cells, PSD diagonal, symmetry ' +
      'tolerance) and the quadFormNonNegative kernel replacing a silent clamp-to-zero, ' +
      'inherited by all six covariance consumers (measured 373,799 B — 39 bytes over the old ' +
      'line). 366 → 367 KB: the H10–H12 reports — contribution rows, the stress envelope with its ' +
      'explicit-base-mark guard, and the self-interpreting grid axes (measured 375,167 B). ' +
      '367 → 368 KB: FC0 — the ONE InterestCompounding grammar (periodic object form + floor ' +
      'guards in core dates) and the @insiderfinance/totalfinance/fundamentals first slice riding the umbrella ' +
      '(measured 376,413 B). 368 → 374 KB: FC1 — the @insiderfinance/totalfinance/valuation cash-flow foundation ' +
      '(27 heads: discounting, the all-roots IRR facades, loans/amortization, capital ' +
      'budgeting and depreciation) rides the umbrella (measured 381,990 B). 374 → 402 KB: FC2 — ' +
      'corporate valuation and typed fundamentals: the statement contracts and their guards, ' +
      '39 ratio facades with explain reports, three published scores, the one-call analysis, the ' +
      'DCF family (direct/reverse/sensitivity/scenario/probabilistic), the equity models, ' +
      'comparable/APV/LBO, and the three-statement forecasting compositions (measured 411,055 B; ' +
      '402 → 403 KB after the one-grammar report conformance added assumptions/diagnostics to every ' +
      'analysis result — measured 411,735 B). 403 → 412 KB: FC3 — @insiderfinance/totalfinance/research rides the ' +
      'umbrella: the declared-field screen grammar and its teaching errors, the factor toolkit ' +
      'and canonical recipes, and the event-study module (measured 427,863 B with events landed; ' +
      'the research package alone gzips to 20,363 B). 418 → 431 KB: FC4 + FC5 — the flow-aware ' +
      'performance module (time/money-weighted returns with the mark-first flow convention spelled ' +
      'out, Modified Dietz, the null-on-any-gap return index, benchmark alignment, contribution) ' +
      'plus @insiderfinance/totalfinance/foreign-exchange riding the umbrella (pairs/conversion/parity/forward and ' +
      'NDF valuation/exposure; measured 440,899 B). 431 → 436 KB: FC6 — @insiderfinance/totalfinance/commodities ' +
      'rides the umbrella: cost-of-carry forwards and their inverses, roll analytics, curve-state ' +
      'classification, seasonality, and the explicit-factor conversion law (measured 446,091 B; ' +
      'the commodities package alone gzips to 9,385 B). 436 → 437 KB: Gates B+C — eight new ' +
      'central error codes (artifact spine + pricer protocol) inherited by every dependent ' +
      'bundle, and the options auto-router now discloses its candidate table in ' +
      'diagnostics.selection (measured 446,838 B — superseded 2026-08-23 by the correction wave: TWR convention fix, loan-inverse bracket-proved solver, convention-honest EAA, nested artifact validators, real-calendar dates, Law-7 overflow refusals, measured 448,472 B; the spine and protocol themselves stay off ' +
      'compute entrypoints). 439 → 442 KB (2026-08-23, second external review): the RateCurve ' +
      'one-contract wave (pillar zeroRate rename, discount factors derived through core’s own ' +
      'compounding transform, pre-asOf refusals, the schema routed through the ONE runtime ' +
      'validator) plus the pricer randomness law (the seeded conformance probes and their ' +
      'teachings) — measured 450,945 B, headroom ~1.6 KB kept deliberately thin so the next ' +
      'jump is visible. 442 → 452 KB (library-wide count ' +
      'safety, 2026-08-26 fourth-review closeout): the umbrella pays the whole wave once — every ' +
      'package\u2019s safe-integer ladders, caps, and teaching strings, plus the batch-path seed ' +
      'probes and the structured-open RateCurve schema (measured 458,574 B = 447.8 KB). 452 → 472 KB (FC7 first slice, 2026-08-28): the 19th domain ' +
      'namespace — the whole ledger package rides the umbrella once (measured 480,919 B = 469.6 KB). 472 → 480 KB (FC7 slice 2, 2026-08-28): the through-time ' +
      'reports (measured 487,284 B = 475.9 KB). 480 → 483 KB (FC7 slice 3, 2026-08-28): the repair ' +
      'family and reconciliation ride the umbrella once (measured 491,978 B = 480.4 KB, headroom ~2.5 KB). ' +
      '483 → 517 KB (FC7 slice 4, 2026-08-29): the ./policy management surface (+28 KB in the ' +
      'portfolio package) plus the risk-side estimateExpectedReturns/efficientFrontier ride the ' +
      'umbrella once (measured 526,967 B = 514.6 KB, headroom ~2.4 KB). 517 → 527 KB (FC7 slice 5, ' +
      '2026-08-29): the lifecycle families ride the umbrella once (measured 537,258 B = 524.7 KB, ' +
      'headroom ~2.3 KB). 527 → 535 KB (FC7 slice-5 closeout, 2026-08-29): the portfolio ' +
      'restoration audit, identity-safe dictionaries, exact derivative chronology, canonical JSON ' +
      'stored-data correction, closed optimizer constraint grammar, and frontier endpoint/work-budget ' +
      'hardening ride the umbrella once (measured 547,080 B = 534.26 KB after strict public ' +
      'ArrayLike parity, intrinsic typed-array snapshotting, provenance/hash/fold parity, and ' +
      'shared-validator hostile-input safety; headroom 760 B). 535 → 567 KB (Stage 4.4b): ' +
      '@insiderfinance/totalfinance/scenarios, the fixed-income Gate-C bond adapter, and their central diagnostic ' +
      'codes ride the umbrella once (measured 577,711 B gzip).' +
      "567 → 570 KB (Stage 4.5 slice 2, 2026-09-02): the direct-API warm starts (initialParameters on SVI/SSVI/eSSVI/SABR/GARCH with their start validators and echoes, the Heston initialParameters rename), the event-volatility forward evaluator with its generated closed-request spec, the fixed-income curve mappers (the pricer's curve builder made public, with the complete built-curve guard), and core's requireRateCurveData now on the root — all ride the umbrella once (measured 583,351 B = 569.7 KB, headroom 329 B)." +
      ' 570 → 572 KB (Preview P1, 2026-09-03): current-quote marking in the options backtester — the per-leg contract lookup with its four missing-mark causes and their teachings, the named fallbacks with per-trade evidence, the marking policy in the generated closed-request spec — plus the per-leg volatility overrides in the strategy mark-to-market and the risk P&L explain (measured 584,206 B = 570.5 KB, headroom 1,522 B).' +
      '572 -> 575 KB (Stage 4.6 slice 1, 2026-09-03): the umbrella re-exports the research universe vocabulary and the portfolio normalized-fill bridge (NormalizedFill guard + portfolioEventsFromFill) plus the three central codes; measured 588,028 B against 585,728 B, headroom now 772 B. The backtest execution subpath is NOT on the umbrella and adds nothing here.' +
      '575 -> 594 KB (Stage 4.6 slice 2, 2026-09-03): the umbrella re-exports the backtest root, which now carries crossSectionalBacktest — the loop over research eligibility and scoring, the allocator, the execution policy, and the ledger fold, plus its closed request guard — measured 607,224 B against 588,800 B, headroom now 1,032 B; the research, portfolio, and risk surfaces it composes were already on the umbrella, so the growth is the engine itself.' +
      '594 -> 600 KB (Stage 4.6 slice 3, 2026-09-04): the backtest root now also carries crossSectionalBacktestGrid — the product runner, its closed guard, and the three risk hygiene verbs it composes (already on the umbrella through @insiderfinance/totalfinance/risk, so the growth is the runner) — measured 609,964 B against 614,400 B, headroom 4,436 B. The artifacts subpath is NOT on the umbrella and adds nothing here. ' +
      '600 KB → 612 KB (Stage 4.6 slice 5, 2026-09-04): the umbrella re-exports @insiderfinance/totalfinance/backtest, whose root now carries the portfolio engine and its adapters beside the cross-sectional engine and the options book — measured 623,192 B against 626,688 B, headroom 3,496 B. ' +
      '612 → 615 KB (Stage 4.6 slice 6, 2026-09-04): the backtest root now also carries crossSectionalWalkForward and crossSectionalPurgedFolds — the out-of-sample procedure over the grid, its two guards, and the fold plan — measured 625,782 B against 629,760 B, headroom 3,978 B.' +
      '615 KB → 617 KB (Stage 7B.1 slice 1, 2026-09-05): the root re-exports createTradingEnvironment, so the umbrella now bundles the environment core over the engine it already carried — +2.4 KB gzip for the guards, the open-order bookkeeping, and the trace identity (measured 630,154 B against 615 KB).' +
      "617 KB → 623 KB (Stage 7B.1 slice 2, 2026-09-05): the environment's limits, mask, reward, and feature modules ride the umbrella (+5.1 KB gzip; the monitor it composes was already bundled through @insiderfinance/totalfinance/portfolio); measured 635,348 B." +
      '623 → 628 KB (Stage 7B.1 slice 3, 2026-09-05): the episode verb and the scenario library ride the umbrella (+5.3 KB gzip; measured 640,654 B).' +
      '628 → 634 KB (Stage 7B.1 slice 4, 2026-09-05): the bench, the baselines, and the transcript scorer ride the umbrella (+3.9 KB gzip; measured 644,625 B).' +
      "634 → 640 KB (Stage 7B.2 slice 1, 2026-09-05): the trade lifecycle's first slice rides the umbrella (+3.7 KB gzip; measured 652,937 B)." +
      "640 → 648 KB (Stage 7B.2 slice 2, 2026-09-06): the portfolio trade lifecycle's slice-2 verbs ride the umbrella; measured 660,110 B." +
      "648 → 652 KB (Stage 5A second pre-publish refresh, 2026-09-07): the September review repairs ride the umbrella (the paper broker's resumable journal, the engine's buying-power gate and signed lifecycle economics); measured 664,704 B." +
      '652 → 655 KB (app dogfooding migrations, 2026-09-07): the umbrella now exports observedSkew and optionFlowDrift, including observed-wing availability, explicit classification provenance and session-aware premium accounting. Measured 669,902 B (+5,198 B from the prior measurement), with 818 B headroom, including final registered warnings, named internal requests and stable observed-selection/expiry-validation fixes. All 28 existing narrower budgets and their forbidden-dependency checks remain unchanged; no schema machinery was added to the option pricing hot path.' +
      '655 → 664 KB (dogfooding value, 2026-09-07): supplied-Greek exposure and quote/model chain-health reports join their domain roots; measured 677,457 B. The existing model/IV primitives are shared, no new dependency or transport operation is added, and the new artifact comparison remains off the umbrella root. Narrow pricing budgets remain unchanged.' +
      '664 → 670 KB (PR #336, 2026-09-07): simple and audited sector-performance calculations join the performance domain root, including bounded indexed selection and point-in-time lineage. Combined umbrella measured 683,634 B. The dedicated sector subpath is separately budgeted; every prior narrow-import budget and forbidden-dependency assertion is retained.',
  },
];
