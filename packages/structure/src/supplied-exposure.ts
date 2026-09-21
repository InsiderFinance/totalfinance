/** Supplied-Greek snapshot accounting. No pricing engine, IV inversion, or scenario repricing. */
import {
  type Assumptions,
  type Diagnostics,
  type OptionContract,
  type OptionQuote,
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  WarningCode,
  assertFiniteValue,
  ensureEnum,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  requireArgumentObject,
  requireFiniteFields,
  resolveValuationAsOf,
  stableSum,
  validateResolvedExpiry,
  warning,
  type OptionQuoteGreeks,
} from '@totalfinance/core';
import type { GammaUnit } from '@totalfinance/structure/exposure';

/**
 * Open observation: the core chain row's Greeks (`OptionQuote.greeks`) with `gamma` and the
 * provenance REQUIRED. Delta and gamma are NOT multiplied by open interest or contract multiplier.
 */
export interface SuppliedExposureGreeks extends OptionQuoteGreeks {
  /** Signed price delta per underlying unit; never converted to an absolute put delta. */
  delta: number;
  /** Signed change in delta per ONE spot-price point, not per 1% and not dollar gamma. */
  gamma: number;
  provenance: {
    /** Actual provider/model identifier, e.g. 'vendor-feed-v2' or 'bsm-2026-09'. */
    source: string;
    /** Actual Greek observation instant in epoch milliseconds, not report generation time. */
    timestampMs: number;
    model?: string;
  };
}

/** Canonical OptionQuote with independently sourced Greeks; harmless decoration is accepted. */
export interface SuppliedExposureQuote extends OptionQuote {
  /** Actual source of this quote/open-interest snapshot. */
  source: string;
  /** Omit when unavailable. Missing Greeks exclude the row; they are never recomputed. */
  greeks?: SuppliedExposureGreeks;
}

/** Explicit OI-position signs, applied ONCE to the supplied signed Greek, independently per metric. */
export interface SuppliedExposurePositionConvention {
  calls: 1 | -1;
  puts: 1 | -1;
}

/** Closed controls. No rate, dividend, pricing-model, or scenario knobs are accepted. */
export interface SuppliedExposureConfig {
  gexConvention: SuppliedExposurePositionConvention;
  dexConvention: SuppliedExposurePositionConvention;
  /** Output GEX unit: dollar-delta change per +1% spot move or per +1 spot-price point. */
  gammaUnit: GammaUnit;
  /** Inclusive maximum age of quote, Greek, and spot observations, in milliseconds. */
  maximumObservationAgeMs: number;
  /** Explicit fallback only; otherwise every contract must supply a positive multiplier. */
  defaultMultiplier?: number;
}

/** Open spot observation plus an explicit report cutoff; all quotes must name this underlying. */
export interface SuppliedExposureMarket {
  underlying: string;
  spot: number;
  source: string;
  timestampMs: number;
  /** Epoch ms, YYYY-MM-DD (UTC midnight), or a zoned ISO datetime. Never reads the clock. */
  asOf: number | string;
}

export interface SuppliedExposureInput {
  quotes: readonly SuppliedExposureQuote[];
  market: SuppliedExposureMarket;
  config: SuppliedExposureConfig;
}

export type SuppliedExposureExclusion =
  | 'missingGreeks'
  | 'missingOpenInterest'
  | 'expired'
  | 'staleQuote'
  | 'futureQuote'
  | 'staleGreeks'
  | 'futureGreeks'
  | 'staleMarket'
  | 'futureMarket';

export interface SuppliedExposureContribution {
  /** Original row index; equal contract identities preserve input order. No implicit deduplication. */
  inputIndex: number;
  /** Detached canonical identity and resolved multiplier; unrelated metadata is not copied. */
  contract: OptionContract;
  source: string;
  timestampMs: number;
  greeks: SuppliedExposureGreeks | null;
  openInterest: number | null;
  multiplier: number;
  multiplierSource: 'contract' | 'config.defaultMultiplier';
  gexSign: 1 | -1;
  dexSign: 1 | -1;
  included: boolean;
  exclusionReasons: SuppliedExposureExclusion[];
  /** Null means excluded, not zero exposure. Units are echoed in assumptions. */
  gex: number | null;
  dex: number | null;
}

export interface SuppliedExposureTotals {
  /** Net signed exposures across included rows only. An empty sum is NOT measured zero market exposure. */
  gex: number;
  dex: number;
  /** Sum of absolute PER-ROW exposures, before any strike/expiry netting. */
  grossGex: number;
  grossDex: number;
  callGex: number;
  putGex: number;
  callDex: number;
  putDex: number;
  openInterest: number;
  callOpenInterest: number;
  putOpenInterest: number;
  includedQuotes: number;
}

export type SuppliedExposureAssumptions = Assumptions<{
  greekSource: 'supplied';
  suppliedDeltaUnit: 'priceDeltaPerUnderlyingUnit';
  suppliedGammaUnit: 'deltaPerSpotPoint';
  suppliedGreekSignPolicy: 'signed-as-provided';
  currencyPolicy: 'caller-aligned-single-currency-no-fx-conversion';
  gammaUnit: GammaUnit;
  dexUnit: 'dollarDelta';
  gexConvention: SuppliedExposurePositionConvention;
  dexConvention: SuppliedExposurePositionConvention;
  maximumObservationAgeMs: number;
  defaultMultiplier: number | null;
  market: SuppliedExposureMarket & { asOf: number };
  scenarioRepricing: 'unavailable';
  aggregationPolicy: 'additive-input-rows-no-deduplication';
}>;

/** Plain JSON-safe analysis report, directly compatible with saved-analysis report grammar. */
export type SuppliedExposureReport = {
  contributions: SuppliedExposureContribution[];
  aggregate: SuppliedExposureTotals;
  byStrike: Array<SuppliedExposureTotals & { strike: number }>;
  /** Groups economically identical expiry instants, even when labels use different time zones. */
  byExpiry: Array<SuppliedExposureTotals & { expiry: string; expiresAt: number }>;
  coverage: {
    scope: 'suppliedQuotesOnly';
    status: 'emptyInput' | 'noEligibleQuotes' | 'partialInput' | 'allInputQuotesIncluded';
    totalQuotes: number;
    includedQuotes: number;
    excludedQuotes: number;
    /** Included / supplied rows; null for an empty chain. Not coverage of an unknown full universe. */
    fraction: number | null;
    /** Rows beyond the first matching underlying/type/style/strike/expiry instant, across sources/times. */
    duplicateContractQuotes: number;
    /** Included rows beyond the first included matching identity; these can double-count OI. */
    duplicateIncludedContractQuotes: number;
    /** Counts overlap when a row has several reasons. */
    exclusionCounts: Record<SuppliedExposureExclusion, number>;
  };
  assumptions: SuppliedExposureAssumptions;
  diagnostics: Diagnostics;
};

const FN = 'exposureFromGreeks';
const MAX_QUOTES = 100_000;
const MAX_TEXT_LENGTH = 512;
const EXAMPLE =
  "exposureFromGreeks({ quotes: [], market: { underlying: 'SPY', spot: 100, source: 'feed', timestampMs: 0, asOf: 0 }, config: { gexConvention: { calls: 1, puts: -1 }, dexConvention: { calls: 1, puts: 1 }, gammaUnit: 'per1PercentMove', maximumObservationAgeMs: 60000 } })";
const REASONS: readonly SuppliedExposureExclusion[] = [
  'missingGreeks',
  'missingOpenInterest',
  'expired',
  'staleQuote',
  'futureQuote',
  'staleGreeks',
  'futureGreeks',
  'staleMarket',
  'futureMarket',
];

function fail(field: string, message: string, code: string = ErrorCode.InputOutOfRange): never {
  throw new InputError(`${FN}: ${field} ${message}`, {
    code,
    context: { function: FN, field },
  });
}

function textField(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    fail(
      field,
      'must be a nonempty source/identity string.',
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
    );
  }
  // Refuse length before scanning caller text.
  if (value.length > MAX_TEXT_LENGTH)
    fail(
      field,
      `must contain at most ${MAX_TEXT_LENGTH} characters.`,
      ErrorCode.OperationInputTooLarge,
    );
  if (value.trim().length === 0) fail(field, 'must not be blank.');
}

function finiteFields(value: unknown, fields: readonly string[], path: string): void {
  requireFiniteFields(FN, value, fields, { path, exampleCall: EXAMPLE });
}

function timestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) {
    fail(field, 'must be integer epoch milliseconds in the JavaScript Date range.');
  }
}

function convention(
  value: SuppliedExposurePositionConvention,
  field: string,
): SuppliedExposurePositionConvention {
  requireArgumentObject(FN, field, value);
  ensureKnownKeys(FN, field, value, ['calls', 'puts']);
  for (const side of ['calls', 'puts'] as const) {
    if (value[side] !== 1 && value[side] !== -1)
      fail(
        `${field}.${side}`,
        'must be +1 or -1; signs multiply the supplied signed Greek.',
        ErrorCode.InputInvalidEnum,
      );
  }
  return { calls: value.calls, puts: value.puts };
}

function finiteComputed(value: number, field: string): number {
  if (!Number.isFinite(value))
    fail(field, 'exceeds finite numeric range; reduce the input magnitudes.');
  return value === 0 ? 0 : value;
}

/** Scale only on the exceptional path: finite final exposures can have overflowing intermediates. */
function exposureProduct(factors: readonly number[], field: string): number {
  if (factors.includes(0)) return 0;
  let direct = 1;
  let needsScaling = false;
  for (const factor of factors) {
    direct *= factor;
    if (!Number.isFinite(direct) || Math.abs(direct) < 2 ** -1022) needsScaling = true;
  }
  if (!needsScaling) return direct;
  let mantissa = 1;
  let exponent = 0;
  let sign = 1;
  for (const factor of factors) {
    if (factor < 0) sign = -sign;
    const magnitude = Math.abs(factor);
    // log2(MAX_VALUE) rounds to 1024; cap before forming a power of two.
    const power = Math.min(1023, Math.floor(Math.log2(magnitude)));
    mantissa *= magnitude / 2 ** power;
    exponent += power;
    while (mantissa >= 2) {
      mantissa /= 2;
      exponent++;
    }
    while (mantissa < 1) {
      mantissa *= 2;
      exponent--;
    }
  }
  const magnitude =
    exponent < -1022
      ? mantissa * 2 ** (exponent + 1074) * Number.MIN_VALUE
      : mantissa * 2 ** exponent;
  return finiteComputed(sign * magnitude, field);
}

function totals(
  rows: readonly SuppliedExposureContribution[],
  path: string,
): SuppliedExposureTotals {
  const included = rows.filter((row) => row.included);
  const sum = (select: (row: SuppliedExposureContribution) => number, field: string): number =>
    finiteComputed(stableSum(included.map(select)), `${path}.${field}`);
  return {
    gex: sum((r) => r.gex!, 'gex'),
    dex: sum((r) => r.dex!, 'dex'),
    grossGex: sum((r) => Math.abs(r.gex!), 'grossGex'),
    grossDex: sum((r) => Math.abs(r.dex!), 'grossDex'),
    callGex: sum((r) => (r.contract.type === 'call' ? r.gex! : 0), 'callGex'),
    putGex: sum((r) => (r.contract.type === 'put' ? r.gex! : 0), 'putGex'),
    callDex: sum((r) => (r.contract.type === 'call' ? r.dex! : 0), 'callDex'),
    putDex: sum((r) => (r.contract.type === 'put' ? r.dex! : 0), 'putDex'),
    openInterest: sum((r) => r.openInterest!, 'openInterest'),
    callOpenInterest: sum(
      (r) => (r.contract.type === 'call' ? r.openInterest! : 0),
      'callOpenInterest',
    ),
    putOpenInterest: sum(
      (r) => (r.contract.type === 'put' ? r.openInterest! : 0),
      'putOpenInterest',
    ),
    includedQuotes: included.length,
  };
}

/**
 * Account for caller-supplied signed Greeks at one spot snapshot. GEX is
 * `gamma * openInterest * multiplier * gexSign * spot * (spot * 0.01)` for
 * `per1PercentMove`, or `gamma * openInterest * multiplier * gexSign * spot` for
 * `perPoint`. DEX is `delta * openInterest * multiplier * dexSign * spot`.
 * A negative put delta is used unchanged: a negative DEX position sign reverses it ONCE.
 * Gamma inputs are signed delta-per-spot-point, never dollar gamma or per-contract gamma.
 *
 * Quotes, contracts, Greeks and market observations are open to harmless decoration; the request,
 * config and both convention objects are closed. Only consumed fields are validated/copied.
 * Quote timestamp/source describe the supplied OI snapshot, not a fabricated exchange OI update.
 * Caller must align currency, deliverable basis, source units and non-overlapping OI observations.
 * Repeated underlying/type/style/strike/expiry identities are counted and warned, never silently
 * deduplicated; differing multipliers, sources, timestamps and provider metadata do not hide repeats.
 * Coverage describes only supplied quote rows, not a full market universe. Empty or entirely
 * excluded chains produce empty sums, NOT an estimate that market exposure is zero.
 * Every row is validated, including rows later excluded. Missing OI/Greeks, expired contracts
 * (`expiresAt <= asOf`), future observations (`timestampMs > asOf`) and stale observations
 * (`asOf - timestampMs > maximumObservationAgeMs`) are excluded with retained lineage.
 * Zero OI is a valid included zero contribution. Missing multipliers require an explicit fallback.
 *
 * Contributions sort by expiry instant, strike, call-before-put, then original input index.
 * Aggregates sort numerically by strike/expiry instant and include excluded-only buckets as zero.
 * At most 100,000 dense quote rows and 512 characters per consumed string are accepted; lengths
 * are refused before traversal. Nonrepresentable contributions or aggregates throw InputError.
 * No rate/dividend model is invented and fixed supplied Greeks cannot yield scenario repricing,
 * gamma flips, or model-driven hedging forecasts. Use exposure() for model-based scenarios.
 *
 * @example
 * ```ts
 * import { resolvedExpiry } from '@totalfinance/core';
 * import { exposureFromGreeks } from '@totalfinance/structure';
 * const timestampMs = Date.parse('2026-09-01T15:00:00Z');
 * const report = exposureFromGreeks({
 *   quotes: [{
 *     contract: { underlying: 'SPY', type: 'put', style: 'american', strike: 100,
 *       expiry: '2026-09-18', ...resolvedExpiry('2026-09-18'), multiplier: 100 },
 *     timestampMs, source: 'chain-feed', openInterest: 10,
 *     greeks: { delta: -0.4, gamma: 0.02, provenance: { source: 'greek-feed', timestampMs } },
 *   }],
 *   market: { underlying: 'SPY', spot: 100, source: 'spot-feed', timestampMs, asOf: timestampMs },
 *   config: { gexConvention: { calls: 1, puts: -1 }, dexConvention: { calls: 1, puts: 1 },
 *     gammaUnit: 'per1PercentMove', maximumObservationAgeMs: 60000 },
 * });
 * console.assert(report.aggregate.gex === -2000);
 * console.assert(report.aggregate.dex === -40000);
 * ```
 */
export function exposureFromGreeks(input: SuppliedExposureInput): SuppliedExposureReport {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, ['quotes', 'market', 'config']);
  const { quotes, market, config } = input;
  if (!Array.isArray(quotes))
    fail('quotes', 'must be a dense array of OptionQuote observations.', ErrorCode.InputWrongType);
  if (quotes.length > MAX_QUOTES)
    fail('quotes', `must contain at most ${MAX_QUOTES} rows.`, ErrorCode.OperationInputTooLarge);
  requireArgumentObject(FN, 'market', market);
  requireArgumentObject(FN, 'config', config);
  ensureKnownKeys(FN, 'config', config, [
    'gexConvention',
    'dexConvention',
    'gammaUnit',
    'maximumObservationAgeMs',
    'defaultMultiplier',
  ]);
  const gexConvention = convention(config.gexConvention, 'config.gexConvention');
  const dexConvention = convention(config.dexConvention, 'config.dexConvention');
  ensureEnum(config.gammaUnit, ['per1PercentMove', 'perPoint'], 'config.gammaUnit', FN);
  finiteFields(config, ['maximumObservationAgeMs'], 'config');
  ensureNonNegative(config.maximumObservationAgeMs, 'config.maximumObservationAgeMs', FN);
  if (config.defaultMultiplier !== undefined) {
    finiteFields(config, ['defaultMultiplier'], 'config');
    ensurePositive(config.defaultMultiplier, 'config.defaultMultiplier', FN);
  }
  textField(market.underlying, 'market.underlying');
  textField(market.source, 'market.source');
  finiteFields(market, ['spot', 'timestampMs'], 'market');
  ensurePositive(market.spot, 'market.spot', FN);
  timestamp(market.timestampMs, 'market.timestampMs');
  if (typeof market.asOf === 'string') textField(market.asOf, 'market.asOf');
  const asOf = resolveValuationAsOf(market.asOf, FN);
  timestamp(asOf, 'market.asOf');
  const ageStatus = (observed: number): 'future' | 'stale' | null =>
    observed > asOf ? 'future' : asOf - observed > config.maximumObservationAgeMs ? 'stale' : null;
  const marketStatus = ageStatus(market.timestampMs);
  const contributions: SuppliedExposureContribution[] = [];
  const seenContracts = new Map<string, boolean>();
  let duplicateContractQuotes = 0;
  let duplicateIncludedContractQuotes = 0;
  const exclusionCounts = Object.fromEntries(REASONS.map((reason) => [reason, 0])) as Record<
    SuppliedExposureExclusion,
    number
  >;
  for (let index = 0; index < quotes.length; index++) {
    const path = `quotes[${index}]`;
    if (!Object.hasOwn(quotes, index))
      fail(
        path,
        'is missing; provide a dense array, not a sparse hole.',
        ErrorCode.InputMissingField,
      );
    const quote: SuppliedExposureQuote = quotes[index]!;
    requireArgumentObject(FN, path, quote);
    const contract: OptionContract = quote.contract;
    requireArgumentObject(FN, `${path}.contract`, contract);
    textField(contract.underlying, `${path}.contract.underlying`);
    if (contract.underlying !== market.underlying)
      fail(
        `${path}.contract.underlying`,
        'must match market.underlying; mixed underlying books need separate reports.',
      );
    ensureEnum(contract.type, ['call', 'put'], `${path}.contract.type`, FN);
    ensureEnum(contract.style, ['american', 'european'], `${path}.contract.style`, FN);
    finiteFields(contract, ['strike', 'expiresAt'], `${path}.contract`);
    ensurePositive(contract.strike, `${path}.contract.strike`, FN);
    timestamp(contract.expiresAt, `${path}.contract.expiresAt`);
    textField(contract.expiry, `${path}.contract.expiry`);
    ensureEnum(
      contract.expiryConvention,
      ['us-equity-close', 'explicit-instant'],
      `${path}.contract.expiryConvention`,
      FN,
    );
    try {
      validateResolvedExpiry(FN, contract.expiry, contract.expiresAt, contract.expiryConvention);
    } catch (error) {
      if (error instanceof InputError) fail(`${path}.contract.expiry`, error.message, error.code);
      throw error;
    }
    if (contract.multiplier !== undefined) {
      finiteFields(contract, ['multiplier'], `${path}.contract`);
      ensurePositive(contract.multiplier, `${path}.contract.multiplier`, FN);
    }
    const multiplier = contract.multiplier ?? config.defaultMultiplier;
    if (multiplier === undefined)
      fail(
        `${path}.contract.multiplier`,
        'is required unless config.defaultMultiplier is explicit.',
        ErrorCode.InputMissingField,
      );
    textField(quote.source, `${path}.source`);
    finiteFields(quote, ['timestampMs'], path);
    timestamp(quote.timestampMs, `${path}.timestampMs`);
    if (quote.openInterest !== undefined) {
      finiteFields(quote, ['openInterest'], path);
      if (!Number.isSafeInteger(quote.openInterest) || quote.openInterest < 0)
        fail(`${path}.openInterest`, 'must be a nonnegative safe integer number of contracts.');
    }
    let greeks: SuppliedExposureGreeks | null = null;
    if (quote.greeks !== undefined) {
      finiteFields(quote.greeks, ['delta', 'gamma'], `${path}.greeks`);
      requireArgumentObject(FN, `${path}.greeks.provenance`, quote.greeks.provenance);
      const provenance = quote.greeks.provenance!;
      finiteFields(provenance, ['timestampMs'], `${path}.greeks.provenance`);
      timestamp(provenance.timestampMs, `${path}.greeks.provenance.timestampMs`);
      textField(provenance.source, `${path}.greeks.provenance.source`);
      greeks = {
        delta: quote.greeks.delta,
        gamma: quote.greeks.gamma,
        provenance: {
          source: provenance.source,
          timestampMs: provenance.timestampMs!,
          ...(provenance.model !== undefined ? { model: provenance.model } : {}),
        },
      };
    }
    const exclusionReasons: SuppliedExposureExclusion[] = [];
    if (greeks === null) exclusionReasons.push('missingGreeks');
    if (quote.openInterest === undefined) exclusionReasons.push('missingOpenInterest');
    if (contract.expiresAt <= asOf) exclusionReasons.push('expired');
    const quoteStatus = ageStatus(quote.timestampMs);
    if (quoteStatus) exclusionReasons.push(`${quoteStatus}Quote`);
    const greekStatus = greeks === null ? null : ageStatus(greeks.provenance.timestampMs);
    if (greekStatus) exclusionReasons.push(`${greekStatus}Greeks`);
    if (marketStatus) exclusionReasons.push(`${marketStatus}Market`);
    for (const reason of exclusionReasons) exclusionCounts[reason]++;
    const included = exclusionReasons.length === 0;
    const identity = JSON.stringify([
      contract.underlying,
      contract.type,
      contract.style,
      contract.strike,
      contract.expiresAt,
    ]);
    const previouslyIncluded = seenContracts.get(identity);
    if (previouslyIncluded !== undefined) duplicateContractQuotes++;
    if (included && previouslyIncluded === true) duplicateIncludedContractQuotes++;
    seenContracts.set(identity, included || previouslyIncluded === true);
    const side = contract.type === 'call' ? 'calls' : 'puts';
    const gexSign = gexConvention[side];
    const dexSign = dexConvention[side];
    let gex: number | null = null;
    let dex: number | null = null;
    if (included) {
      const gammaFactors = [greeks!.gamma, quote.openInterest!, multiplier, gexSign, market.spot];
      if (config.gammaUnit === 'per1PercentMove') gammaFactors.push(market.spot, 0.01);
      gex = exposureProduct(gammaFactors, `${path}.gex`);
      dex = exposureProduct(
        [greeks!.delta, quote.openInterest!, multiplier, dexSign, market.spot],
        `${path}.dex`,
      );
    }
    contributions.push({
      inputIndex: index,
      contract: {
        underlying: contract.underlying,
        type: contract.type,
        style: contract.style,
        strike: contract.strike,
        expiry: contract.expiry,
        expiresAt: contract.expiresAt,
        expiryConvention: contract.expiryConvention,
        multiplier,
      },
      source: quote.source,
      timestampMs: quote.timestampMs,
      greeks,
      openInterest: quote.openInterest ?? null,
      multiplier,
      multiplierSource: contract.multiplier === undefined ? 'config.defaultMultiplier' : 'contract',
      gexSign,
      dexSign,
      included,
      exclusionReasons,
      gex,
      dex,
    });
  }
  contributions.sort(
    (a, b) =>
      a.contract.expiresAt - b.contract.expiresAt ||
      a.contract.strike - b.contract.strike ||
      (a.contract.type === b.contract.type ? 0 : a.contract.type === 'call' ? -1 : 1) ||
      a.inputIndex - b.inputIndex,
  );
  const strikes = new Map<number, SuppliedExposureContribution[]>();
  const expiries = new Map<number, SuppliedExposureContribution[]>();
  for (const row of contributions) {
    for (const [groups, key] of [
      [strikes, row.contract.strike],
      [expiries, row.contract.expiresAt],
    ] as const) {
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
  }
  const aggregate = totals(contributions, 'aggregate');
  const excludedQuotes = quotes.length - aggregate.includedQuotes;
  const warnings = [
    warning(
      WarningCode.ModelLimitation,
      'Positioning is estimated from supplied signed delta/gamma, open interest and independent GEX/DEX signs, not actual dealer books. Signed Greeks are used unchanged before position signs. No Greeks are recomputed and no scenario repricing is available.',
      'info',
    ),
    warning(
      WarningCode.ModelLimitation,
      'Coverage is supplied quote rows only, not the full market. All rows share market.underlying; caller must align a single currency and deliverable basis (no FX conversion). Rows are additive, not deduplicated. Quote source/timestamp identify the supplied OI snapshot, not the exchange OI update or availability time.',
      'info',
    ),
  ];
  if (duplicateContractQuotes > 0)
    warnings.push(
      warning(
        WarningCode.StructureDuplicateContractQuotes,
        `${duplicateContractQuotes} repeated contract-identity quote(s); ${duplicateIncludedContractQuotes} repeat an included identity and may double-count open interest. Rows remain additive; select non-overlapping snapshots before calling.`,
        'warn',
        { duplicateContractQuotes, duplicateIncludedContractQuotes },
      ),
    );
  if (excludedQuotes > 0)
    warnings.push(
      warning(
        WarningCode.StructureContractsSkipped,
        `${excludedQuotes} quote(s) excluded; inspect contributions[].exclusionReasons and coverage.exclusionCounts.`,
        'warn',
        { excludedQuotes },
      ),
    );
  if (quotes.length === 0)
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        'Empty chain: totals are empty sums and coverage.fraction is null, not measured zero market exposure.',
        'info',
      ),
    );
  else if (aggregate.includedQuotes === 0)
    warnings.push(
      warning(
        WarningCode.StructureNoEligibleQuotes,
        'No supplied quote is eligible: aggregate and bucket zeros are empty sums, not measured zero market exposure. Inspect exclusions.',
        'warn',
      ),
    );
  const report: SuppliedExposureReport = {
    contributions,
    aggregate,
    byStrike: [...strikes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([strike, rows]) => ({ strike, ...totals(rows, `byStrike[${strike}]`) })),
    byExpiry: [...expiries.entries()]
      .sort(([a], [b]) => a - b)
      .map(([expiresAt, rows]) => ({
        expiry: new Date(expiresAt).toISOString(),
        expiresAt,
        ...totals(rows, `byExpiry[${expiresAt}]`),
      })),
    coverage: {
      scope: 'suppliedQuotesOnly',
      status:
        quotes.length === 0
          ? 'emptyInput'
          : aggregate.includedQuotes === 0
            ? 'noEligibleQuotes'
            : excludedQuotes > 0
              ? 'partialInput'
              : 'allInputQuotesIncluded',
      totalQuotes: quotes.length,
      includedQuotes: aggregate.includedQuotes,
      excludedQuotes,
      fraction: quotes.length === 0 ? null : aggregate.includedQuotes / quotes.length,
      duplicateContractQuotes,
      duplicateIncludedContractQuotes,
      exclusionCounts,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      asOf,
      greekSource: 'supplied',
      suppliedDeltaUnit: 'priceDeltaPerUnderlyingUnit',
      suppliedGammaUnit: 'deltaPerSpotPoint',
      suppliedGreekSignPolicy: 'signed-as-provided',
      currencyPolicy: 'caller-aligned-single-currency-no-fx-conversion',
      gammaUnit: config.gammaUnit,
      dexUnit: 'dollarDelta',
      gexConvention,
      dexConvention,
      maximumObservationAgeMs: config.maximumObservationAgeMs,
      defaultMultiplier: config.defaultMultiplier ?? null,
      market: {
        underlying: market.underlying,
        spot: market.spot,
        source: market.source,
        timestampMs: market.timestampMs,
        asOf,
      },
      scenarioRepricing: 'unavailable',
      aggregationPolicy: 'additive-input-rows-no-deduplication',
    },
    diagnostics: { method: 'supplied-greek-accounting', warnings },
  };
  assertFiniteValue(FN, report);
  return report;
}
