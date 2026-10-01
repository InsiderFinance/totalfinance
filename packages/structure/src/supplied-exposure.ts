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
  requireSelection,
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

/** The supplied-Greek exposures {@link exposureFromGreeks} can select. */
export type SuppliedExposureMetric = 'gex' | 'dex';

/**
 * What a selection `S` requires of a metric's inputs: required when `metrics` is omitted or a literal
 * selection names it, optional otherwise (an unselected metric's inputs are not read, and a dynamic
 * selection's needs are only known at run time, where they are enforced).
 */
type RequiredFor<
  M extends SuppliedExposureMetric,
  S extends readonly SuppliedExposureMetric[] | undefined,
  T,
> = [S] extends [undefined]
  ? T
  : number extends NonNullable<S>['length']
    ? Partial<T>
    : M extends NonNullable<S>[number]
      ? T
      : Partial<T>;

/**
 * The supplied Greeks a selection reads: gamma for `gex`, delta for `dex`, provenance always. With
 * `metrics` omitted this is {@link SuppliedExposureGreeks}.
 */
export type SuppliedExposureGreeksFor<S extends readonly SuppliedExposureMetric[] | undefined> =
  Omit<OptionQuoteGreeks, 'delta' | 'gamma' | 'provenance'> & {
    provenance: SuppliedExposureGreeks['provenance'];
  } & RequiredFor<'gex', S, { gamma: number }> &
    RequiredFor<'dex', S, { delta: number }>;

/**
 * The configuration a selection reads: `gexConvention` and `gammaUnit` for `gex`, `dexConvention`
 * for `dex`. An unselected metric's fields may still be passed; they are shape-checked, not applied.
 */
export type SuppliedExposureConfigFor<S extends readonly SuppliedExposureMetric[] | undefined> = [
  S,
] extends [undefined]
  ? SuppliedExposureConfig
  : Omit<SuppliedExposureConfig, 'gexConvention' | 'dexConvention' | 'gammaUnit'> &
      RequiredFor<'gex', S, Pick<SuppliedExposureConfig, 'gexConvention' | 'gammaUnit'>> &
      RequiredFor<'dex', S, Pick<SuppliedExposureConfig, 'dexConvention'>>;

export interface SuppliedExposureInput<
  S extends readonly SuppliedExposureMetric[] | undefined = undefined,
> {
  quotes: readonly ([S] extends [undefined]
    ? SuppliedExposureQuote
    : Omit<SuppliedExposureQuote, 'greeks'> & { greeks?: SuppliedExposureGreeksFor<S> })[];
  market: SuppliedExposureMarket;
  config: SuppliedExposureConfigFor<S>;
  /**
   * `['gex']`, `['dex']` or both. Omit for today's report (both). A GEX-only report needs only
   * supplied gamma, `gexConvention` and `gammaUnit`; a DEX-only report only supplied delta and
   * `dexConvention`. The unselected metric's fields are absent from the report, never zero.
   */
  metrics?: S;
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

type SuppliedGexTotal = 'gex' | 'grossGex' | 'callGex' | 'putGex';
type SuppliedDexTotal = 'dex' | 'grossDex' | 'callDex' | 'putDex';

/** A metric's fields: required when guaranteed (`G`), optional when possible (`P`), else absent. */
type MetricFields<
  M extends SuppliedExposureMetric,
  G extends SuppliedExposureMetric,
  P extends SuppliedExposureMetric,
  T,
> = M extends G ? T : M extends P ? Partial<T> : unknown;

/** Totals of a report that computed `G` (and possibly `P`); with the defaults, {@link SuppliedExposureTotals}. */
export type SuppliedExposureTotalsFor<
  G extends SuppliedExposureMetric = SuppliedExposureMetric,
  P extends SuppliedExposureMetric = G,
> = Omit<SuppliedExposureTotals, SuppliedGexTotal | SuppliedDexTotal> &
  MetricFields<'gex', G, P, Pick<SuppliedExposureTotals, SuppliedGexTotal>> &
  MetricFields<'dex', G, P, Pick<SuppliedExposureTotals, SuppliedDexTotal>>;

/**
 * A contribution row of a report that computed `G` (and possibly `P`): the GEX sign and value only
 * with `gex`, the DEX sign and value only with `dex`, and only the supplied Greeks that were read.
 * With the defaults, {@link SuppliedExposureContribution}.
 */
export type SuppliedExposureContributionFor<
  G extends SuppliedExposureMetric = SuppliedExposureMetric,
  P extends SuppliedExposureMetric = G,
> = Omit<SuppliedExposureContribution, 'greeks' | 'gexSign' | 'gex' | 'dexSign' | 'dex'> & {
  greeks:
    | ({ provenance: SuppliedExposureGreeks['provenance'] } & MetricFields<
        'gex',
        G,
        P,
        { gamma: number }
      > &
        MetricFields<'dex', G, P, { delta: number }>)
    | null;
} & MetricFields<'gex', G, P, Pick<SuppliedExposureContribution, 'gexSign' | 'gex'>> &
  MetricFields<'dex', G, P, Pick<SuppliedExposureContribution, 'dexSign' | 'dex'>>;

/**
 * Assumptions of a report that computed `G` (and possibly `P`): the GEX unit and convention echoes
 * only with `gex`, the DEX ones only with `dex`, plus `metrics` when a selection was passed.
 */
export type SuppliedExposureAssumptionsFor<
  G extends SuppliedExposureMetric = SuppliedExposureMetric,
  P extends SuppliedExposureMetric = G,
> = Omit<
  SuppliedExposureAssumptions,
  | 'suppliedGammaUnit'
  | 'gammaUnit'
  | 'gexConvention'
  | 'suppliedDeltaUnit'
  | 'dexUnit'
  | 'dexConvention'
> &
  MetricFields<
    'gex',
    G,
    P,
    Pick<SuppliedExposureAssumptions, 'suppliedGammaUnit' | 'gammaUnit' | 'gexConvention'>
  > &
  MetricFields<
    'dex',
    G,
    P,
    Pick<SuppliedExposureAssumptions, 'suppliedDeltaUnit' | 'dexUnit' | 'dexConvention'>
  > & {
    /** The selection as passed; present only when `metrics` was passed. */
    metrics?: readonly SuppliedExposureMetric[];
  };

/**
 * Plain JSON-safe analysis report, directly compatible with saved-analysis report grammar.
 *
 * `G`/`P` follow the `metrics` selection (guaranteed/possible metrics); both default to GEX and DEX,
 * today's report. A GEX+DEX report requires BOTH supplied Greeks on every row that supplies Greeks,
 * so the two metrics are always computed over the same included rows.
 */
export type SuppliedExposureReport<
  G extends SuppliedExposureMetric = SuppliedExposureMetric,
  P extends SuppliedExposureMetric = G,
> = {
  contributions: SuppliedExposureContributionFor<G, P>[];
  aggregate: SuppliedExposureTotalsFor<G, P>;
  byStrike: Array<SuppliedExposureTotalsFor<G, P> & { strike: number }>;
  /** Groups economically identical expiry instants, even when labels use different time zones. */
  byExpiry: Array<SuppliedExposureTotalsFor<G, P> & { expiry: string; expiresAt: number }>;
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
  assumptions: SuppliedExposureAssumptionsFor<G, P>;
  diagnostics: Diagnostics;
};

/** The metrics a selection guarantees: both when omitted, the names of a literal, none if dynamic. */
export type GuaranteedSuppliedExposureMetrics<
  S extends readonly SuppliedExposureMetric[] | undefined,
> = [S] extends [undefined]
  ? SuppliedExposureMetric
  : number extends NonNullable<S>['length']
    ? never
    : NonNullable<S>[number];

/** The metrics a selection may have computed. */
export type PossibleSuppliedExposureMetrics<
  S extends readonly SuppliedExposureMetric[] | undefined,
> = undefined extends S ? SuppliedExposureMetric : NonNullable<S>[number];

const FN = 'exposureFromGreeks';
const SUPPLIED_METRICS: readonly SuppliedExposureMetric[] = ['gex', 'dex'];
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

/** A contribution row as built internally: a selective report leaves out the unselected metric's fields. */
type ContributionRow = Omit<
  SuppliedExposureContribution,
  'greeks' | 'gexSign' | 'dexSign' | 'gex' | 'dex'
> & {
  greeks: Record<string, unknown> | null;
  gexSign?: 1 | -1;
  dexSign?: 1 | -1;
  gex?: number | null;
  dex?: number | null;
};

function totals(
  rows: readonly ContributionRow[],
  path: string,
  wantGex: boolean,
  wantDex: boolean,
): Partial<SuppliedExposureTotals> & Pick<SuppliedExposureTotals, 'includedQuotes'> {
  const included = rows.filter((row) => row.included);
  const sum = (select: (row: ContributionRow) => number, field: string): number =>
    finiteComputed(stableSum(included.map(select)), `${path}.${field}`);
  // Field order is the released report's; a selective report omits the unselected metric's totals.
  return {
    ...(wantGex ? { gex: sum((r) => r.gex!, 'gex') } : {}),
    ...(wantDex ? { dex: sum((r) => r.dex!, 'dex') } : {}),
    ...(wantGex ? { grossGex: sum((r) => Math.abs(r.gex!), 'grossGex') } : {}),
    ...(wantDex ? { grossDex: sum((r) => Math.abs(r.dex!), 'grossDex') } : {}),
    ...(wantGex
      ? {
          callGex: sum((r) => (r.contract.type === 'call' ? r.gex! : 0), 'callGex'),
          putGex: sum((r) => (r.contract.type === 'put' ? r.gex! : 0), 'putGex'),
        }
      : {}),
    ...(wantDex
      ? {
          callDex: sum((r) => (r.contract.type === 'call' ? r.dex! : 0), 'callDex'),
          putDex: sum((r) => (r.contract.type === 'put' ? r.dex! : 0), 'putDex'),
        }
      : {}),
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
 * `metrics` selects GEX, DEX or both (omitted: both, exactly as before). `['gex']` reads only supplied
 * gamma, `gexConvention` and `gammaUnit` — a row's delta may be absent — and `['dex']` only supplied
 * delta and `dexConvention`. The unselected metric's contribution sign and value, totals, units and
 * convention echoes are absent from the report (never zero), and `assumptions.metrics` echoes the
 * selection. A GEX+DEX report requires both supplied Greeks on every row that supplies Greeks, so the
 * two metrics always cover the same included rows. Modeled Greeks are never substituted.
 *
 * @example
 * ```ts
 * import { resolvedExpiry } from '@insiderfinance/totalfinance/core';
 * import { exposureFromGreeks } from '@insiderfinance/totalfinance/structure';
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
export function exposureFromGreeks(request: SuppliedExposureInput): SuppliedExposureReport;
/**
 * A GEX or DEX selection: only the selected metric's inputs are read and required, and the report
 * carries only its fields. The released signature is declared first (the contract tooling and
 * readers see) and last (the one `Parameters`/`ReturnType` name), with this one between them.
 */
export function exposureFromGreeks<
  const S extends readonly SuppliedExposureMetric[] | undefined = undefined,
>(
  request: SuppliedExposureInput<S> &
    ([S] extends [readonly []]
      ? { metrics: readonly [SuppliedExposureMetric, ...SuppliedExposureMetric[]] }
      : unknown),
): SuppliedExposureReport<GuaranteedSuppliedExposureMetrics<S>, PossibleSuppliedExposureMetrics<S>>;
/** The released signature again, last, for `Parameters`/`ReturnType` (see above). */
export function exposureFromGreeks(request: SuppliedExposureInput): SuppliedExposureReport;
export function exposureFromGreeks(request: SuppliedExposureInput): SuppliedExposureReport {
  // One loose view of the request: which fields are required depends on the selection, checked below.
  const input = request as unknown as {
    quotes: readonly SuppliedExposureQuote[];
    market: SuppliedExposureMarket;
    config: Partial<SuppliedExposureConfig>;
    metrics?: unknown;
  };
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, ['quotes', 'market', 'config', 'metrics']);
  const { quotes, market, config } = input;
  const selection =
    input.metrics === undefined
      ? undefined
      : requireSelection(FN, 'metrics', input.metrics, SUPPLIED_METRICS);
  const wantGex = selection === undefined || selection.includes('gex');
  const wantDex = selection === undefined || selection.includes('dex');
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
  // A selected metric's controls are required; an unselected one's may be present and are still
  // shape-checked (the config is closed), but they are neither applied nor echoed.
  const gexConvention =
    wantGex || config.gexConvention !== undefined
      ? convention(config.gexConvention!, 'config.gexConvention')
      : undefined;
  const dexConvention =
    wantDex || config.dexConvention !== undefined
      ? convention(config.dexConvention!, 'config.dexConvention')
      : undefined;
  if (wantGex || config.gammaUnit !== undefined) {
    ensureEnum(config.gammaUnit, ['per1PercentMove', 'perPoint'], 'config.gammaUnit', FN);
  }
  finiteFields(config, ['maximumObservationAgeMs'], 'config');
  const maximumObservationAgeMs = config.maximumObservationAgeMs!;
  ensureNonNegative(maximumObservationAgeMs, 'config.maximumObservationAgeMs', FN);
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
    observed > asOf ? 'future' : asOf - observed > maximumObservationAgeMs ? 'stale' : null;
  const marketStatus = ageStatus(market.timestampMs);
  const contributions: ContributionRow[] = [];
  // Only the supplied Greeks the selection reads are required, validated and copied.
  const suppliedGreeks = [...(wantDex ? ['delta'] : []), ...(wantGex ? ['gamma'] : [])];
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
    let greeks:
      | (Record<string, unknown> & { provenance: SuppliedExposureGreeks['provenance'] })
      | null = null;
    if (quote.greeks !== undefined) {
      finiteFields(quote.greeks, suppliedGreeks, `${path}.greeks`);
      requireArgumentObject(FN, `${path}.greeks.provenance`, quote.greeks.provenance);
      const provenance = quote.greeks.provenance!;
      finiteFields(provenance, ['timestampMs'], `${path}.greeks.provenance`);
      timestamp(provenance.timestampMs, `${path}.greeks.provenance.timestampMs`);
      textField(provenance.source, `${path}.greeks.provenance.source`);
      greeks = {
        ...(wantDex ? { delta: quote.greeks.delta } : {}),
        ...(wantGex ? { gamma: quote.greeks.gamma } : {}),
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
    const gexSign = wantGex ? gexConvention![side] : undefined;
    const dexSign = wantDex ? dexConvention![side] : undefined;
    let gex: number | null = null;
    let dex: number | null = null;
    if (included && wantGex) {
      const gammaFactors = [
        greeks!['gamma'] as number,
        quote.openInterest!,
        multiplier,
        gexSign!,
        market.spot,
      ];
      if (config.gammaUnit === 'per1PercentMove') gammaFactors.push(market.spot, 0.01);
      gex = exposureProduct(gammaFactors, `${path}.gex`);
    }
    if (included && wantDex) {
      dex = exposureProduct(
        [greeks!['delta'] as number, quote.openInterest!, multiplier, dexSign!, market.spot],
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
      ...(wantGex ? { gexSign: gexSign! } : {}),
      ...(wantDex ? { dexSign: dexSign! } : {}),
      included,
      exclusionReasons,
      ...(wantGex ? { gex } : {}),
      ...(wantDex ? { dex } : {}),
    });
  }
  contributions.sort(
    (a, b) =>
      a.contract.expiresAt - b.contract.expiresAt ||
      a.contract.strike - b.contract.strike ||
      (a.contract.type === b.contract.type ? 0 : a.contract.type === 'call' ? -1 : 1) ||
      a.inputIndex - b.inputIndex,
  );
  const strikes = new Map<number, ContributionRow[]>();
  const expiries = new Map<number, ContributionRow[]>();
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
  const aggregate = totals(contributions, 'aggregate', wantGex, wantDex);
  const excludedQuotes = quotes.length - aggregate.includedQuotes;
  const warnings = [
    warning(
      WarningCode.ModelLimitation,
      wantGex && wantDex
        ? 'Positioning is estimated from supplied signed delta/gamma, open interest and independent GEX/DEX signs, not actual dealer books. Signed Greeks are used unchanged before position signs. No Greeks are recomputed and no scenario repricing is available.'
        : `Positioning is estimated from supplied signed ${wantGex ? 'gamma' : 'delta'}, open interest and an independent ${wantGex ? 'GEX' : 'DEX'} sign, not actual dealer books. Signed Greeks are used unchanged before position signs. No Greeks are recomputed and no scenario repricing is available.`,
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
  const report = {
    contributions,
    aggregate,
    byStrike: [...strikes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([strike, rows]) => ({
        strike,
        ...totals(rows, `byStrike[${strike}]`, wantGex, wantDex),
      })),
    byExpiry: [...expiries.entries()]
      .sort(([a], [b]) => a - b)
      .map(([expiresAt, rows]) => ({
        expiry: new Date(expiresAt).toISOString(),
        expiresAt,
        ...totals(rows, `byExpiry[${expiresAt}]`, wantGex, wantDex),
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
    // Field order is the released report's; only the selected metrics' units and conventions are echoed.
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      asOf,
      greekSource: 'supplied',
      ...(wantDex ? { suppliedDeltaUnit: 'priceDeltaPerUnderlyingUnit' as const } : {}),
      ...(wantGex ? { suppliedGammaUnit: 'deltaPerSpotPoint' as const } : {}),
      suppliedGreekSignPolicy: 'signed-as-provided',
      currencyPolicy: 'caller-aligned-single-currency-no-fx-conversion',
      ...(wantGex ? { gammaUnit: config.gammaUnit! } : {}),
      ...(wantDex ? { dexUnit: 'dollarDelta' as const } : {}),
      ...(wantGex ? { gexConvention: gexConvention! } : {}),
      ...(wantDex ? { dexConvention: dexConvention! } : {}),
      maximumObservationAgeMs,
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
      ...(selection === undefined ? {} : { metrics: selection }),
    },
    diagnostics: { method: 'supplied-greek-accounting', warnings },
  };
  assertFiniteValue(FN, report);
  return report as unknown as SuppliedExposureReport;
}
