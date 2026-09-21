/**
 * Phase 3B contract policy — the CURATED half of the contract inventory (decision ledger C20).
 *
 * C20: **validation scope follows contract shape, not package tier.** The rule this replaces was
 * "only facade-tier packages get mutation coverage," which exempted `core` and `math` wholesale — and
 * a package-wide exemption is indistinguishable from an oversight. Every exception here is bound to a
 * stable CONTRACT IDENTITY and carries the reason, so it can be argued with.
 *
 * The generator (`contract-inventory.ts`) discovers structure. It may not decide that an unenforced
 * boundary is acceptable. That decision lives here, one entry at a time.
 *
 * ⚠ EXCLUDE THIS FILE FROM BULK RENAME SWEEPS — like the naming policy, its keys are the very
 * identities it governs, so a sweep that rewrites them silently empties the policy.
 */

/**
 * Is this called function a validator?
 *
 * By CONVENTION, not by enumeration. The repo has 90 distinct `requireX` / `ensureX` functions and the
 * first version of this file listed 35 of them by hand — so 55 real guards read as absent, and the
 * inventory over-reported unguarded contracts. A hand list of a growing vocabulary is stale the day it
 * is written; the convention is the actual contract, and a new guard that follows it is recognized
 * with no edit here.
 *
 * `assert*` is deliberately NOT a guard: those are Law 7 POSTconditions on the result
 * (`assertFiniteResult`), which are evidence of result discipline rather than input enforcement, and
 * are recorded separately.
 */
export function isGuardName(name: string): boolean {
  if (/^(?:require|ensure)[A-Z]/.test(name)) return true;
  return GUARD_EXCEPTIONS.has(name);
}

/** Is this a Law 7 result postcondition rather than an input guard? */
export function isPostconditionName(name: string): boolean {
  return /^assert[A-Z]/.test(name);
}

/**
 * Validators that do NOT follow the `require*`/`ensure*` convention, listed because they cannot be
 * detected any other way. Keep this small: a new guard should follow the convention instead.
 */
export const GUARD_EXCEPTIONS: ReadonlySet<string> = new Set([
  // MCP tools validate through their declared schema rather than imperative guards.
  'parse',
  'safeParse',
]);

/**
 * The guard vocabulary as it stood when this policy was written, kept ONLY as a drift signal:
 * `contract-conformance.test.ts` asserts every name here still satisfies {@link isGuardName}, so a
 * rename that breaks the convention is caught rather than silently shrinking coverage.
 */
export const KNOWN_GUARD_NAMES: readonly string[] = [
  'ensureAligned',
  'ensureAscending',
  'ensureEnum',
  'ensureFinite',
  'ensureFiniteUnique',
  'ensureKnownKeys',
  'ensureNonNegative',
  'ensureNonNegativeVolatility',
  'ensurePositive',
  'ensurePrimitives',
  'ensureStrictlyIncreasing',
  'requireAligned',
  'requireArgumentArray',
  'requireArgumentObject',
  'requireAtMost',
  'requireBarData',
  'requireBars',
  'requireBondField',
  'requireBondInstance',
  'requireCalendar',
  'requireCdsCurves',
  'requireConfidence',
  'requireCorrelation',
  'requireCurve',
  'requireCurveArg',
  'requireCurveField',
  'requireCurveInstance',
  'requireDefaultsSubsetOfParams',
  'requireDeliverableBondInstance',
  'requireDelta',
  'requireESSVIParams',
  'requireEngine',
  'requireEqualLength',
  'requireEqualLengths',
  'requireEuropean',
  'requireField',
  'requireFinite',
  'requireFiniteMatrix',
  'requireFiniteRow',
  'requireFirstArg',
  'requireHistory',
  'requireInRange',
  'requireIndicatorStream',
  'requireInputs',
  'requireLaterArgsNotNull',
  'requireLegPrice',
  'requireMarket',
  'requireMeanVector',
  'requireNonNegative',
  'requireNonNegativeInt',
  'requireNumericField',
  'requireNumericHandle',
  'requireOneOf',
  'requireOptionalArgObject',
  'requireOrderBook',
  'requireOutputMetadata',
  'requirePd',
  'requirePeriod',
  'requirePoints',
  'requirePosition',
  'requirePositionGreeks',
  'requirePositive',
  'requirePositiveInt',
  'requirePositiveRow',
  'requirePresent',
  'requireProbability',
  'requireProbeLength',
  'requirePsd',
  'requireQuote',
  'requireQuotes',
  'requireRate',
  'requireRectangular',
  'requireSameLength',
  'requireSameReference',
  'requireScalarVolatility',
  'requireScenarioShape',
  'requireSeries',
  'requireSigma',
  'requireSnapshot',
  'requireSpecification',
  'requireSpot',
  'requireState',
  'requireSurfaceParams',
  'requireSurvivalField',
  'requireSwapCurves',
  'requireSymmetric',
  'requireTrade',
  'requireTrades',
  'requireVector',
  'requireWindow',
];

/**
 * What KIND of boundary a public path is — which decides whether "no guard here" is a defect.
 *
 * Without this, the inventory reports 1,673 unenforced object contracts and every one reads like work.
 * 850 are streaming-indicator internals (`AdLineStream#next`, `AlmaStream.constructor`) and the schema
 * machinery itself (`ArraySchema#safeParse`). Validating those would be WRONG, not merely unnecessary:
 * the spec forbids adding "per-row object validation/allocation inside already validated columnar
 * loops," and a validator that validates its own input with itself is circular.
 *
 * So the kind is derived STRUCTURALLY and the must-enforce set is the honest remainder. This is C20
 * applied as a rule rather than as 850 hand-written exemptions — a list that long is not reviewable,
 * and an unreviewable exemption list is the package-tier exclusion again with extra steps.
 */
export type BoundaryKind =
  /** A function a caller invokes with data. Enforcement is required. */
  | 'entry-point'
  /**
   * The per-tick step of a streaming indicator (`next`, `peek`). The stream was validated at
   * construction and this runs once per bar; the spec forbids per-row validation here.
   */
  | 'stream-step'
  /** A class constructor, reached through a validated factory in the stream/indicator design. */
  | 'constructor'
  /** The validation machinery (`schema.ts`). It cannot validate its own input with itself. */
  | 'validator'
  /** An `Error` subclass constructor — `(message, options)`, not a quant input. */
  | 'error'
  /** A snapshot restore boundary. Enforcement IS required (3B.1 gave these `readSnapshot`). */
  | 'snapshot-restore'
  /**
   * A signature the CALLER implements and the library invokes (`CostModel.commission`, which the
   * backtest calls as `this.fee.commission(…)`). There is no body here to guard, so this can never be
   * "fixed"; what the library owes is validating what it passes in and what it gets back.
   */
  | 'callback-contract';

/**
 * Derive the boundary kind from a public path, its implementation file, and whether an implementation
 * body exists at all.
 */
export function boundaryKindOf(
  path: string,
  implementationFile: string,
  hasImplementation: boolean,
): BoundaryKind {
  const member = /[#.]([A-Za-z0-9_$]+)$/.exec(path)?.[1] ?? '';
  // No body anywhere in the repo: an interface/abstract signature. Checked FIRST — a `fromJSON` on an
  // interface is still a declaration, not a restore boundary anyone can guard.
  if (!hasImplementation) return 'callback-contract';
  if (/\/errors\.d\.ts$/.test(implementationFile) && member === 'constructor') return 'error';
  if (/\/schema\.d\.ts$/.test(implementationFile)) return 'validator';
  if (member === 'fromJSON' || member === 'restore') return 'snapshot-restore';
  if (member === 'constructor') return 'constructor';
  // Anchored on the OWNER being stream-shaped, so a top-level `next` export — if one ever existed —
  // would still be an entry point that must enforce.
  if ((member === 'next' || member === 'peek') && /(?:Stream|Aggregator|View)[#.]/.test(path)) {
    return 'stream-step';
  }
  return 'entry-point';
}

/**
 * Public paths that are CONVENTIONAL POSITIONAL SCALAR MATHEMATICS.
 *
 * The spec is explicit that these keep "their explicit mathematical/IEEE contracts without universal
 * parser wrappers" — wrapping `normalCdf(x)` in an object parser would be ceremony that makes nothing
 * safer, and 3B.1 forbids putting a schema parser in a scalar hot loop. They are listed rather than
 * pattern-matched so that adding one is a decision, and so the count appears in the closeout.
 *
 * Empty at introduction: 3B.0's job is to record the SHAPE of the surface, and the inventory already
 * separates `positional-scalars` structurally. Entries land here only for a path whose shape reads as
 * an object contract but whose real contract is scalar mathematics — a genuine exception, not a
 * category.
 */
export const POSITIONAL_MATH_PATHS: ReadonlySet<string> = new Set<string>([]);

/**
 * Curated C20 exceptions: an object-shaped public contract deliberately left without a guard in its
 * own body, with the reason.
 *
 * The only defensible reason is that the contract is enforced at a boundary the caller must pass
 * through first, and the entry must say WHICH. "It is internal" is not a reason — if a user can reach
 * it from a published entrypoint, it is public.
 *
 * Empty at introduction, deliberately. 3B.0's commit boundary is inventory only; every unguarded
 * object input the generator finds is reported as work for 3B.1/3B.2, not pre-excused here. An entry
 * added later must name the enforcing boundary.
 */
/**
 * Boundaries whose PROBES do not terminate — EMPTY, and the reason it is empty matters.
 *
 * It briefly named `swapXva`, and that was false. The scoped path measured fine with 39 failures while
 * its two umbrella aliases — the SAME function object — were declared non-terminating, which is a
 * contradiction that should have stopped me: a property of a function cannot hold for one of its names
 * and not another. Re-run with the declarations ignored, all three terminate and all three are
 * defective. Nothing ever hung.
 *
 * What actually happened is a measurement artefact of my own making. The supervisor's budget bounds a
 * whole PROBE BATCH, not a call, and `swapXva` runs a Monte Carlo per probe. Its umbrella copies are
 * measured late in a 191-second pass and crossed a 20-second bound that was never meant to describe
 * them. I read "the harness gave up" as "the library does not return" — the same mistake as reading a
 * duplicate-registration rejection as enforcement, and the fourth time in this file that a diagnostic
 * has described the harness rather than the library.
 *
 * The mechanism stays, because a real non-termination is possible and `adaptiveSimpson` was one. Two
 * rules keep an entry honest:
 *
 *   EVIDENCE      An entry may never be its own evidence. `TOTALFINANCE_IGNORE_DECLARED_SKIPS=1` re-runs the
 *                 generator with this list ignored; anything here must have been shown to hang THAT
 *                 way, not merely to have been skipped.
 *   AGREEMENT     Aliases sharing a function object must agree. One name hanging while another
 *                 measures is a bug in the harness, not a fact about the library.
 */
export const NON_TERMINATING_BOUNDARIES: Readonly<Record<string, string>> = {};

/**
 * Boundaries that write PROCESS-GLOBAL state, so measuring one twice in one process is two different
 * experiments.
 *
 * `register(entry)` adds to the indicator registry, and registering a name twice is correctly refused.
 * That made it non-idempotent for the harness, with two consequences worth separating.
 *
 * The first was a FALSE POSITIVE and is fixed. With a constant synthesized `name`, the baseline
 * succeeded and every probe after it was refused as a DUPLICATE — so `register` scored `enforced` on
 * a clean sweep of rejections that had nothing to do with the mutations. Synthesis now mints a fresh
 * identity per call, and the boundary is defective: it accepts an undeclared key, accepts omitting the
 * required `category`, and accepts `category: 42`.
 *
 * The second is irreducible: a SECOND measurement in one process replays those identities into a
 * registry that already holds them. The committed artifact comes from a single pass and reproduces
 * across processes; only the in-process double-run check excludes these.
 *
 * A CORRECTION. This note previously claimed a failed `register` is partially applied and cannot be
 * retried. That is false — `registry.ts` validates the entry completely and then performs ONE
 * `REGISTRY.set`, so a rejected entry leaves the registry untouched. I never opened the function; I
 * inferred a library defect from the harness's own duplicate-name confusion. Kept here rather than
 * deleted, because it is the same error the paragraph above describes, made by me.
 */
export const GLOBAL_STATE_BOUNDARIES: Readonly<Record<string, string>> = {
  '@totalfinance/technical-analysis:register':
    'Writes the entry into the process-global indicator registry; a second call with the same name ' +
    'is refused as a duplicate, so re-measuring in one process measures a different registry.',
  'totalfinance:register': 'Umbrella alias of `@totalfinance/technical-analysis:register`.',
  'totalfinance:technicalAnalysis.register':
    'Namespace alias of `@totalfinance/technical-analysis:register`.',
};

export const CONTRACT_EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * Per-BOUNDARY input policies for callables the exports map cannot name: `.explain` twins (not
 * their own exports) and receiver methods of interface-typed artifacts (no exported class to hang
 * `methodInputPolicies` on). CURATED individually — the blanket explain-twin inheritance was tried
 * and manufactured 73 false convictions (`open` promises acceptance in both directions, and twins
 * do not uniformly keep it); every row here is a boundary whose runtime is KNOWN to accept
 * decoration on that argument.
 */
export const BOUNDARY_INPUT_POLICIES: Readonly<Record<string, Record<string, string>>> = {
  // A Calendar ARTIFACT flows in and its decoration flows OUT BY DESIGN: the implementation
  // spreads the instance (`{ ...base, isTradingDay }`), so a decorated calendar keeps its
  // decoration — that is the open-artifact promise kept in both directions, not a Law-12 gap.
  '@totalfinance/calendars:withTradingVocabulary': { '0': 'open' },
  // The tear sheet takes the optionsBacktest RESULT — an artifact whose decoration passes
  // through by design. Consumed members (trades/settlements/returns/diagnostics) carry their
  // own teaching guards; the echoed report sections (performance, finalValue, points) are the
  // artifact's own claims, not this boundary's to re-litigate.
  '@totalfinance/backtest:optionsTearSheet': { '0': 'open' },
  // The four facade-wrapped bond analytics take the built Bond artifact first; its members are
  // invoked (cashflows/accrued), not validated per-field — requireBondInstance guards identity.
  '@totalfinance/fixed-income:curveMetrics.explain': { '0': 'open', '1': 'open' },
  '@totalfinance/fixed-income:priceFromYield.explain': { '0': 'open' },
  '@totalfinance/fixed-income:yieldMetrics.explain': { '0': 'open' },
  '@totalfinance/fixed-income:yieldToMaturity.explain': { '0': 'open' },
  '@totalfinance/fixed-income:yieldToCall.explain': { '0': 'open' },
  'totalfinance:fixedIncome.yieldToCall.explain': { '0': 'open' },
  // addSpread takes a spread CURVE artifact — its members are invoked, never validated per-field.
  '@totalfinance/fixed-income:YieldCurve#addSpread': { '0': 'open' },
  // The broker consumes decorated market-data bars per tick; the model interfaces' default
  // implementations consume fill/trade artifacts the caller's data pipeline decorates.
  '@totalfinance/backtest:SimulatedBroker#processBar': { '0': 'open' },
  '@totalfinance/backtest:CostModel#commission': { '0': 'open' },
  '@totalfinance/backtest:SlippageModel#fill': { '0': 'open' },
  // harRvForecast takes a FITTED model artifact (open — wave-10 ruling); its explain twin
  // shares the argument, each spelling its own deliberate row.
  '@totalfinance/volatility:harRvForecast.explain': { '0': 'open' },
  'totalfinance:volatility.harRvForecast.explain': { '0': 'open' },
  // The size-weighted mid consumes an order book; its explain twin shares the argument.
  '@totalfinance/technical-analysis:microprice.explain': { '0': 'open' },
  // UMBRELLA SPELLINGS of the curated rows above. The propagation seed deliberately excludes
  // curated rows (a boundary policy names ONE path, never a function identity — the Facade
  // template lesson), so each umbrella alias of a curated boundary is its own deliberate row,
  // carrying the same argument policy as the source-package spelling it re-exports.
  'totalfinance:calendars.withTradingVocabulary': { '0': 'open' },
  'totalfinance:withTradingVocabulary': { '0': 'open' },
  'totalfinance:fixedIncome.curveMetrics.explain': { '0': 'open', '1': 'open' },
  'totalfinance:fixedIncome.priceFromYield.explain': { '0': 'open' },
  'totalfinance:fixedIncome.yieldMetrics.explain': { '0': 'open' },
  'totalfinance:fixedIncome.yieldToMaturity.explain': { '0': 'open' },
  'totalfinance:technicalAnalysis.microprice.explain': { '0': 'open' },
};

/**
 * Boundaries whose declared numeric argument accepts non-finite values BY DESIGN, keyed
 * `id#argumentIndex` with the rationale as the value (the conformance vagueness gate reads it).
 * TypeScript cannot narrow `number` to exclude NaN/Infinity, so the declaration cannot say this —
 * the curation does, and the harness scores `non-finite` on these arguments as ADVISORY rather
 * than convicting a function for its documented purpose.
 */
/**
 * Request-object FIELDS whose value is a built structural artifact (a YieldCurve, a Bond, a
 * survival curve), keyed `id#argumentIndex` → the artifact-valued root field names. C05 one level
 * down from argument policy: the boundary consumes a few members of the artifact and guards
 * identity with an instance check; which members it consumes is not statically knowable, so
 * mutations on `<root>.<member>` land in ADVISORY — the same doctrine as open-policy argument
 * members and container mutations. The REQUEST itself stays closed: typo keys still teach.
 */
export const ARTIFACT_VALUED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // B2 (2026-09-21): the envelope schema builder takes a caller's JSON Schemas (`structured`, the
  // operation's own output schema; `handle`, a `$ref` or inline handle schema) and embeds them
  // verbatim — foreign artifacts one level down, like a curve bundle; the request itself is closed.
  '@totalfinance/workflows:operationResultSchema#0': ['structured', 'handle'],
  '@totalfinance/fixed-income:bermudanSwaption#0': ['curve'],
  '@totalfinance/fixed-income:bootstrapHazardFromCds#1': ['discountCurve'],
  '@totalfinance/fixed-income:credit.bootstrapHazardFromCds#1': ['discountCurve'],
  '@totalfinance/fixed-income:callableBond#0': ['bond', 'curve'],
  '@totalfinance/fixed-income:capFloorPrice#1': ['discountCurve'],
  '@totalfinance/fixed-income:cdsParSpread#1': ['discountCurve', 'survivalCurve'],
  // The explain twin shares the curves bundle — and its umbrella spelling is its own deliberate
  // row (curated rows never propagate by implementation identity).
  '@totalfinance/fixed-income:cdsParSpread.explain#1': ['discountCurve', 'survivalCurve'],
  'totalfinance:fixedIncome.cdsParSpread.explain#1': ['discountCurve', 'survivalCurve'],
  'totalfinance:fixedIncome.cdsParSpread#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:cdsValue#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:conversionFactor#0': ['bond'],
  '@totalfinance/fixed-income:creditSpreadCurve#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:creditSpreadCurve.explain#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:credit.creditSpreadCurve.explain#1': [
    'discountCurve',
    'survivalCurve',
  ],
  'totalfinance:fixedIncome.creditSpreadCurve#1': ['discountCurve', 'survivalCurve'],
  'totalfinance:fixedIncome.creditSpreadCurve.explain#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:credit.creditSpreadCurve#1': ['discountCurve', 'survivalCurve'],
  '@totalfinance/fixed-income:crossCurrencyBasisCurve#0': ['basis', 'domestic', 'foreign'],
  '@totalfinance/fixed-income:curves.bootstrapProjection#1': ['discountCurve'],
  '@totalfinance/fixed-income:forwardCmsRate#1': ['discountCurve'],
  '@totalfinance/fixed-income:forwardSwap#1': ['discountCurve'],
  '@totalfinance/fixed-income:fraValue#1': ['curve'],
  '@totalfinance/fixed-income:impliedCrossCurrencyBasis#0': ['domestic', 'foreign'],
  '@totalfinance/fixed-income:oasAnalytics#0': ['bond', 'curve'],
  '@totalfinance/fixed-income:swapRate#1': ['discountCurve'],
  '@totalfinance/fixed-income:swapRate.explain#1': ['discountCurve'],
  'totalfinance:fixedIncome.swapRate#1': ['discountCurve'],
  'totalfinance:fixedIncome.swapRate.explain#1': ['discountCurve'],
  '@totalfinance/fixed-income:swapValue#1': ['discountCurve'],
  '@totalfinance/fixed-income:swapXva#0': ['curve'],
  '@totalfinance/fixed-income:swapXva#1': ['counterpartySurvival'],
  '@totalfinance/fixed-income:swaptionPrice#1': ['discountCurve'],
  '@totalfinance/fixed-income:priceMultiCurve#1': ['discountCurve', 'forecastCurve'],
  '@totalfinance/options:americanExercise#0': ['contract', 'market'],
  '@totalfinance/options:americanImpliedVolatility#0': ['contract', 'market'],
  '@totalfinance/options:impliedVolatility#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:impliedVolatilityMany#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:impliedVolatilityOption#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:option.impliedVolatility#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:option.price#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:priceOption#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:priceMany#0': ['engine', 'contract', 'market'],
  '@totalfinance/options:monteCarloPrice#0': ['engine', 'contract', 'market'],
};

export const NON_FINITE_IN_DOMAIN: Readonly<Record<string, string>> = {
  '@totalfinance/performance:degenerateAwareDiagnostics#0':
    'The helper EXISTS to explain a non-finite metric: every facade explain path hands it a ' +
    'possibly-NaN value and it converts that into the Law-7 null-with-warning disclosure. ' +
    'Rejecting NaN here would break the exact case it was built for.',
};

/**
 * The reproduced seed defects (spec "Reproduced seed defects"), as DATA.
 *
 * 3B.0 records these identities; the executable tests land atomically with the 3B.1 fixes, because the
 * spec forbids committing a knowingly red gate or ratcheting a defective result as expected behavior.
 *
 * All three were re-verified at this head, under their post-3B.N names:
 *
 *   blackScholesPrice({ …, volatility: undefined })  → NaN          (should throw)
 *   blackScholesPrice({ …, qzxBogus: 1 })            → a price      (unknown key silently ignored)
 *   blackScholesPrice({ …, volatilty: 0.2 })         → NaN          (both defects at once: the
 *                                                                   misspelling is ignored AND the
 *                                                                   real field is missing)
 *   blackScholes.price(same)                         → throws input.not_finite   (correct)
 *
 * The third is the one that matters most in practice: a caller who typos a field name gets a
 * plausible-looking number-shaped answer, from the path the docs call the fast one.
 */
export interface SeedFixture {
  /** Stable identity, preserved from the pre-3B.N baseline per the spec. */
  id: string;
  /** The public path that misbehaves, in prose — may name two paths for a parity defect. */
  path: string;
  /**
   * The exact callable id that is DEFECTIVE, for the machine cross-check.
   *
   * Prose is not checkable: the facade-vs-kernel parity fixture names both paths and asserts a
   * DIFFERENCE between them, and a matcher reading the first id concluded the working facade was the
   * broken one. The defective path has to be stated, not parsed out of a sentence.
   */
  defectiveId: string;
  /** What it does today. */
  observed: string;
  /** What it must do once 3B.1 lands. */
  required: string;
  /** The phase that lands the executable test WITH the fix. */
  landsIn: string;
  /**
   * The phase that actually CLOSED it, once the measured record says so.
   *
   * A closed row is dated, not deleted: the reproduced defect is the reason the phase exists, and
   * the record of what the library used to do is the useful part. The conformance gate reads this in
   * BOTH directions — an open fixture may not read `enforced`, and a fixture claiming `closedIn`
   * MUST, so "closed" cannot be asserted into existence.
   */
  closedIn?: string;
}

export const SEED_FIXTURES: readonly SeedFixture[] = [
  {
    id: 'contract/black-scholes/missing-volatility',
    defectiveId: '@totalfinance/options:blackScholesPrice',
    path: '@totalfinance/options/black-scholes:blackScholesPrice',
    observed: 'throws input.missing_field naming `volatility`, with a worked example',
    required: 'throws a typed InputError naming the missing field',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },
  {
    id: 'contract/black-scholes/unknown-key',
    defectiveId: '@totalfinance/options:blackScholesPrice',
    path: '@totalfinance/options/black-scholes:blackScholesPrice',
    observed: 'throws input.unknown_field with a did-you-mean and the allowed field list',
    required: 'throws input.unknown_field with a did-you-mean correction',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },
  {
    id: 'contract/black-scholes/misspelled-volatility',
    defectiveId: '@totalfinance/options:blackScholesPrice',
    path: '@totalfinance/options/black-scholes:blackScholesPrice',
    observed: 'throws input.unknown_field — the near-miss key is named and `volatility` suggested',
    required: 'throws, naming the near-miss key and the field it was probably meant to be',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },
  {
    // Re-verified on the `./black76` subpath. The first probe used `./black-scholes` and got
    // "not a function" — worth recording, because a fixture written against the wrong entrypoint
    // would have "passed" while proving nothing.
    id: 'contract/black76/missing-volatility',
    defectiveId: '@totalfinance/options:black76Price',
    path: '@totalfinance/options/black76:black76Price',
    observed: 'throws input.missing_field naming `volatility`, with a worked example',
    required: 'throws a typed InputError naming the missing field',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },
  {
    id: 'contract/black76/unknown-key',
    defectiveId: '@totalfinance/options:black76Price',
    path: '@totalfinance/options/black76:black76Price',
    observed: 'throws input.unknown_field with a did-you-mean and the allowed field list',
    required: 'throws input.unknown_field with a did-you-mean correction',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },
  {
    id: 'contract/facade-kernel-parity/black-scholes',
    defectiveId: '@totalfinance/options:blackScholesPrice',
    path: '@totalfinance/options:blackScholes.price vs blackScholesPrice',
    observed: 'facade and kernel both throw input.missing_field for the same request',
    required: 'both reject the same malformed request with the same code',
    landsIn: '3B.1',
    closedIn: '3B.1b-1',
  },

  // ── Found by the 3B.0 inventory, not by the original seed set ────────────────────────────────────
  // The same defect class outside options pricing entirely. Recorded so 3B.1's shared enforcement path
  // is designed against the real spread of the problem rather than against two pricing kernels — the
  // seed defects were never the scope, and the spec says so.
  {
    id: 'contract/core/format-money-wrong-shape',
    defectiveId: '@totalfinance/core:formatMoney',
    path: '@totalfinance/core:formatMoney',
    observed: 'returns the string "$NaN" for a wrong-shaped or empty object',
    required: 'throws a typed InputError naming the expected fields',
    landsIn: '3B.1',
    closedIn: '3B.1b core-utilities wave',
  },
  {
    id: 'contract/core/format-percent-wrong-shape',
    defectiveId: '@totalfinance/core:formatPercent',
    path: '@totalfinance/core:formatPercent',
    observed: 'returns the string "NaN%" for a wrong-shaped object',
    required: 'throws a typed InputError naming the expected fields',
    landsIn: '3B.1',
    closedIn: '3B.1b core-utilities wave',
  },
  {
    id: 'contract/core/select-quote-price-invalid-enum',
    defectiveId: '@totalfinance/core:selectQuotePrice',
    path: '@totalfinance/core:selectQuotePrice',
    observed: 'returns undefined for an unknown price source',
    required: 'throws input.invalid_enum listing the accepted sources',
    landsIn: '3B.1',
  },
  {
    id: 'contract/core/format-occ-symbol-untyped-throw',
    defectiveId: '@totalfinance/core:formatOccSymbol',
    path: '@totalfinance/core:formatOccSymbol',
    observed: 'throws an UNTYPED error — no code for a caller or agent to branch on',
    required: 'throws a typed QuantError; the spec requires an exact code, not "some exception"',
    landsIn: '3B.1',
    closedIn: '3B.1b core-utilities wave',
  },
];
