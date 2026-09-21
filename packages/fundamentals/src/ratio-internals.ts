/**
 * FC2 — the ratio kernel. Every ratio head is made HERE, so the family has one validation gate,
 * one explain shape, one null-with-reason discipline, and one disclosure convention — the
 * framework-choke-point lesson applied before the family exists rather than after it defects.
 *
 * This module is package-internal: it is ABSENT from the exports map, so the maker never becomes
 * accidental public API.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type EpochMs,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type FinancialStatements,
  availabilityOf,
  requireFinancialStatements,
} from './statement-contracts.js';

// ---------------------------------------------------------------------------------------------------
// Market observation (a ratio input this package owns)
// ---------------------------------------------------------------------------------------------------

/**
 * The market side of a valuation multiple — a narrow structural view, not a market-data feed.
 * `marketCapitalization` may be given directly or derived as `sharePrice × sharesOutstanding`
 * (the derivation is disclosed).
 *
 * UNITS: market amounts are ABSOLUTE currency, not the statements' `monetaryScale`. The kernel
 * converts statement amounts to absolute currency before a multiple divides, and discloses the
 * conversion — a thousands-scale filing must not shift every multiple by 1,000×.
 */
export interface MarketObservation {
  /** When the price was observed (epoch ms). Must not precede the fundamentals' availability. */
  observedTimestampMs: EpochMs;
  sharePrice: number;
  /** Split-adjusted shares consistent with `sharePrice`. */
  sharesOutstanding?: number;
  marketCapitalization?: number;
}

const MARKET_OBSERVATION_KEYS = [
  'observedTimestampMs',
  'sharePrice',
  'sharesOutstanding',
  'marketCapitalization',
] as const;

/** Validate a {@link MarketObservation} at a public boundary. */
export function requireMarketObservation(
  functionName: string,
  observation: MarketObservation,
): void {
  // The guard's own label is part of its contract: invoked without one, every error it teaches
  // would blame "undefined".
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireMarketObservation: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  requireArgumentObject(functionName, 'marketObservation', observation);
  ensureKnownKeys(functionName, 'marketObservation', observation, MARKET_OBSERVATION_KEYS);
  for (const field of MARKET_OBSERVATION_KEYS) {
    const value = observation[field];
    if (value === undefined) {
      if (field === 'observedTimestampMs' || field === 'sharePrice') {
        throw new InputError(
          `${functionName}: marketObservation.${field} is required.\n  e.g. ${functionName}({ statements, marketObservation: { observedTimestampMs: Date.UTC(2026, 7, 12), sharePrice: 42.5, sharesOutstanding: 1_000_000 } })`,
          { code: ErrorCode.InputMissingField, context: { field: `marketObservation.${field}` } },
        );
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InputError(
        `${functionName}: marketObservation.${field} must be a finite number. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `marketObservation.${field}` } },
      );
    }
    if (field !== 'observedTimestampMs' && value < 0) {
      throw new InputError(
        `${functionName}: marketObservation.${field} must not be negative. Received ${value}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `marketObservation.${field}` } },
      );
    }
  }
  if (
    observation.marketCapitalization === undefined &&
    observation.sharesOutstanding === undefined
  ) {
    throw new InputError(
      `${functionName}: marketObservation needs marketCapitalization, or sharesOutstanding so it can be derived as sharePrice × sharesOutstanding.`,
      {
        code: ErrorCode.InputMissingField,
        context: { field: 'marketObservation.marketCapitalization' },
      },
    );
  }
}

/** Market capitalization, derived when not given; the derivation is pushed onto `notes`. */
export function resolveMarketCapitalization(
  observation: MarketObservation,
  notes: string[],
): number {
  if (observation.marketCapitalization !== undefined) return observation.marketCapitalization;
  notes.push('marketCapitalization derived as sharePrice × sharesOutstanding');
  return observation.sharePrice * observation.sharesOutstanding!;
}

// ---------------------------------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------------------------------

export type RatioCategory =
  | 'profitability'
  | 'returns'
  | 'liquidity'
  | 'leverage'
  | 'efficiency'
  | 'quality'
  | 'per-share'
  | 'valuation';

/** The identity of the period a ratio was computed over. */
export interface RatioPeriodIdentity {
  periodEndDate: string;
  periodType: string;
  fiscalYear: number;
  currency: string;
  monetaryScale: number;
}

/** What `.explain()` returns for every ratio head — the ONE `Computed` envelope (dx §7.2). */
export interface RatioReport {
  /** A decimal ratio (never a displayed percentage), or `null` with `diagnostics.reason`. */
  value: number | null;
  assumptions: {
    conventionsVersion: string;
    ratioName: string;
    category: RatioCategory;
    /** The fixed formula, stated as prose (also in the generated reference documentation). */
    formula: string;
    period: RatioPeriodIdentity;
    priorPeriod?: RatioPeriodIdentity;
  };
  diagnostics: {
    warnings: string[];
    numerator: { label: string; amount: number } | null;
    denominator: { label: string; amount: number } | null;
    /** Every derivation, omission, and convention the computation relied on. */
    notes: string[];
    /** Present exactly when `value` is null. */
    reason?: string;
    /** For market multiples: how far the price sits after the fundamentals became available. */
    marketStalenessMs?: number;
  };
}

/** What a definition's `compute` returns; the kernel finishes the division and the report. */
export interface RatioOutcome {
  numerator?: { label: string; amount: number };
  denominator?: { label: string; amount: number };
  /** A definitional gap (missing optional field, meaningless domain). Wins over the division. */
  reason?: string;
  /** Overrides the plain `numerator/denominator` division (e.g. cash-conversion cycle sums). */
  valueOverride?: number | null;
}

/**
 * A statement amount in ABSOLUTE currency: reported units × the period's monetary scale. Market
 * multiples and per-share values divide absolute amounts, so a filing's reporting scale never
 * leaks into the ratio. The conversion is disclosed once per call when the scale is not 1.
 */
export function absoluteAmount(
  statements: FinancialStatements,
  amount: number,
  notes: string[],
): number {
  const scale = statements.income.period.monetaryScale;
  if (scale === 1) return amount;
  const note = `statement amounts converted to absolute currency (× monetaryScale ${scale}) to match the market/per-share basis`;
  if (!notes.includes(note)) notes.push(note);
  return amount * scale;
}

function periodIdentity(statements: FinancialStatements): RatioPeriodIdentity {
  const period = statements.income.period;
  return {
    periodEndDate: period.periodEndDate,
    periodType: period.periodType,
    fiscalYear: period.fiscalYear,
    currency: period.currency,
    monetaryScale: period.monetaryScale,
  };
}

// ---------------------------------------------------------------------------------------------------
// The maker
// ---------------------------------------------------------------------------------------------------

/** Common inputs a ratio head can declare. */
export interface RatioInput {
  /** Single-period heads. */
  statements?: FinancialStatements;
  /** Average-denominator heads: the period being measured… */
  current?: FinancialStatements;
  /** …and the immediately prior period (average balances need both endpoints). */
  prior?: FinancialStatements;
  /** Day-count heads: the explicit number of days in the period (never guessed from periodType). */
  periodDays?: number;
  /** Market-multiple heads. */
  marketObservation?: MarketObservation;
  /** Market-multiple heads: reject a price observed more than this after availability. */
  maximumStalenessMs?: number;
  /** ROIC: explicit tax rate; when absent the effective rate is derived and disclosed. */
  taxRate?: number;
  /** debtServiceCoverage: the exact debt-service denominator (interest + scheduled principal). */
  debtServiceAmount?: number;
  /** Enterprise-value heads: separately supplied non-operating assets. */
  nonOperatingAssets?: number;
}

export interface RatioDefinition {
  ratioName: string;
  category: RatioCategory;
  formula: string;
  /** Which of the common inputs this head accepts (its Law-12 closed key set). */
  keys: readonly (keyof RatioInput)[];
  compute(input: RatioInput, notes: string[]): RatioOutcome;
}

/** Single-period heads. */
export interface SingleStatementRatioInput {
  statements: FinancialStatements;
}

/** Average-balance heads: the period being measured and the immediately prior period. */
export interface PairRatioInput {
  current: FinancialStatements;
  prior: FinancialStatements;
}

/** Return on invested capital: the pair plus an optional explicit tax rate. */
export interface InvestedCapitalRatioInput extends PairRatioInput {
  taxRate?: number;
}

/** Day metrics: the pair plus the explicit period-day count (never guessed). */
export interface DayMetricRatioInput extends PairRatioInput {
  periodDays: number;
}

/** Debt-service coverage: the exact supplied denominator. */
export interface DebtServiceRatioInput extends SingleStatementRatioInput {
  debtServiceAmount: number;
}

/** Market multiples: the market side plus the optional freshness bound. */
export interface MarketMultipleRatioInput extends SingleStatementRatioInput {
  marketObservation: MarketObservation;
  maximumStalenessMs?: number;
}

/** Enterprise-value multiples: separately supplied non-operating assets. */
export interface EnterpriseMultipleRatioInput extends MarketMultipleRatioInput {
  nonOperatingAssets?: number;
}

/**
 * A ratio head: plain value + `.explain`. The DECLARED input is the head's exact shape — the
 * declaration never licenses a key the runtime refuses (the shared bag stays kernel-internal).
 */
export interface RatioFacade<Input extends RatioInput = RatioInput> {
  (input: Input): number | null;
  explain(input: Input): RatioReport;
}

const OPTIONAL_SCALARS: ReadonlyArray<
  [
    'periodDays' | 'maximumStalenessMs' | 'taxRate' | 'debtServiceAmount' | 'nonOperatingAssets',
    string,
  ]
> = [
  ['periodDays', 'the explicit day count of the period (> 0)'],
  ['maximumStalenessMs', 'the freshness limit in milliseconds (≥ 0)'],
  ['taxRate', 'a decimal tax rate in [0, 1)'],
  ['debtServiceAmount', 'the exact debt-service denominator (> 0)'],
  ['nonOperatingAssets', 'separately supplied non-operating assets (≥ 0)'],
];

function validateRatioInput(definition: RatioDefinition, input: RatioInput): void {
  const name = definition.ratioName;
  requireArgumentObject(name, 'input', input);
  ensureKnownKeys(name, 'input', input, definition.keys);
  if (definition.keys.includes('statements')) {
    if (input.statements === undefined) {
      throw new InputError(`${name}: statements is required.\n  e.g. ${name}({ statements })`, {
        code: ErrorCode.InputMissingField,
        context: { field: 'statements' },
      });
    }
    requireFinancialStatements(name, input.statements);
  }
  if (definition.keys.includes('current')) {
    for (const field of ['current', 'prior'] as const) {
      if (input[field] === undefined) {
        throw new InputError(
          `${name}: ${field} is required — the fixed formula uses AVERAGE beginning/ending balances, which need the prior period's balance sheet as the beginning point.\n  e.g. ${name}({ current, prior })`,
          { code: ErrorCode.InputMissingField, context: { field } },
        );
      }
      requireFinancialStatements(name, input[field]!);
    }
    const currentEnd = input.current!.income.period.periodEndDate;
    const priorEnd = input.prior!.income.period.periodEndDate;
    if (priorEnd >= currentEnd) {
      throw new InputError(
        `${name}: prior must END BEFORE current — received prior ending ${priorEnd} against current ending ${currentEnd}.`,
        { code: ErrorCode.InputWrongShape, context: { field: 'prior' } },
      );
    }
    const currentPeriod = input.current!.income.period;
    const priorPeriod = input.prior!.income.period;
    if (
      currentPeriod.currency !== priorPeriod.currency ||
      currentPeriod.monetaryScale !== priorPeriod.monetaryScale
    ) {
      throw new InputError(
        `${name}: current and prior must share one currency and monetary scale — received ${currentPeriod.currency}@${currentPeriod.monetaryScale} against ${priorPeriod.currency}@${priorPeriod.monetaryScale}.`,
        { code: ErrorCode.InputWrongShape, context: { field: 'prior' } },
      );
    }
  }
  if (definition.keys.includes('marketObservation')) {
    if (input.marketObservation === undefined) {
      throw new InputError(
        `${name}: marketObservation is required — a market multiple has a market side.\n  e.g. ${name}({ statements, marketObservation: { observedTimestampMs, sharePrice, sharesOutstanding } })`,
        { code: ErrorCode.InputMissingField, context: { field: 'marketObservation' } },
      );
    }
    requireMarketObservation(name, input.marketObservation);
  }
  for (const [field, description] of OPTIONAL_SCALARS) {
    if (!definition.keys.includes(field)) continue;
    const value = input[field];
    const required = field === 'periodDays' || field === 'debtServiceAmount';
    if (value === undefined) {
      if (!required) continue;
      throw new InputError(
        `${name}: ${field} is required — ${description} is never guessed.\n  e.g. ${name}({ ...input, ${field}: ${field === 'periodDays' ? '365' : '1_000'} })`,
        { code: ErrorCode.InputMissingField, context: { field } },
      );
    }
    const outOfRange =
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (field === 'periodDays' && value <= 0) ||
      (field === 'debtServiceAmount' && value <= 0) ||
      (field === 'taxRate' && (value < 0 || value >= 1)) ||
      ((field === 'maximumStalenessMs' || field === 'nonOperatingAssets') && value < 0);
    if (outOfRange) {
      throw new InputError(
        `${name}: ${field} must be ${description}. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputOutOfRange, context: { field } },
      );
    }
  }
}

/**
 * The point-in-time law for market multiples: the price must not precede the fundamentals'
 * availability (that pairing would be lookahead in the OTHER direction — a stale filing priced
 * with knowledge the market did not attach to it), and an explicit freshness limit bounds how far
 * AFTER availability the price may sit.
 */
function checkMarketTiming(
  definition: RatioDefinition,
  input: RatioInput,
  warnings: string[],
): { stalenessMs: number } {
  const name = definition.ratioName;
  const statements = input.statements!;
  const available = availabilityOf(statements);
  const observed = input.marketObservation!.observedTimestampMs;
  if (observed < available) {
    throw new InputError(
      `${name}: the market observation (${observed}) precedes the fundamentals' availability (${available}) — a multiple must pair a price with fundamentals the market could already see.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'marketObservation.observedTimestampMs' },
      },
    );
  }
  const stalenessMs = observed - available;
  if (input.maximumStalenessMs !== undefined && stalenessMs > input.maximumStalenessMs) {
    throw new InputError(
      `${name}: the market observation sits ${stalenessMs} ms after the fundamentals' availability, beyond the declared maximumStalenessMs of ${input.maximumStalenessMs}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'maximumStalenessMs' } },
    );
  }
  if (input.maximumStalenessMs === undefined) {
    warnings.push(
      'no maximumStalenessMs declared — price/fundamentals staleness is disclosed, not bounded',
    );
  }
  return { stalenessMs };
}

/** Build one ratio head from its definition, declared at the head's EXACT input shape. */
export function makeRatio<Input extends RatioInput = RatioInput>(
  definition: RatioDefinition,
): RatioFacade<Input> {
  const explain = (input: RatioInput): RatioReport => {
    validateRatioInput(definition, input);
    const notes: string[] = [];
    const warnings: string[] = [];
    let marketStalenessMs: number | undefined;
    if (definition.keys.includes('marketObservation')) {
      marketStalenessMs = checkMarketTiming(definition, input, warnings).stalenessMs;
    }
    const outcome = definition.compute(input, notes);
    const base = input.statements ?? input.current!;
    const report: RatioReport = {
      value: null,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        ratioName: definition.ratioName,
        category: definition.category,
        formula: definition.formula,
        period: periodIdentity(base),
        ...(input.prior !== undefined ? { priorPeriod: periodIdentity(input.prior) } : {}),
      },
      diagnostics: {
        warnings,
        numerator: outcome.numerator ?? null,
        denominator: outcome.denominator ?? null,
        notes,
        ...(marketStalenessMs !== undefined ? { marketStalenessMs } : {}),
      },
    };
    if (outcome.reason !== undefined) {
      report.diagnostics.reason = outcome.reason;
      return report;
    }
    if (outcome.valueOverride !== undefined) {
      if (outcome.valueOverride !== null && !Number.isFinite(outcome.valueOverride)) {
        // Law 7 (2026-08-23): an override that overflowed is a null-with-reason like any ratio.
        report.diagnostics.reason =
          'the computed value is not representable in IEEE-754 double precision — the magnitudes overflow the arithmetic';
        return report;
      }
      report.value = outcome.valueOverride;
      return report;
    }
    const numerator = outcome.numerator;
    const denominator = outcome.denominator;
    if (numerator === undefined || denominator === undefined) {
      report.diagnostics.reason = 'the ratio could not be formed from the supplied statements';
      return report;
    }
    if (denominator.amount === 0) {
      report.diagnostics.reason = `${denominator.label} is zero — the ratio is undefined`;
      return report;
    }
    const value = numerator.amount / denominator.amount;
    if (!Number.isFinite(value)) {
      // Law 7 (2026-08-23 review wave): a finite-input overflow is a null-with-reason, never a
      // successful Infinity — the ratio grammar's own honest-absence channel.
      report.diagnostics.reason = `${numerator.label} over ${denominator.label} is not representable in IEEE-754 double precision — the magnitudes overflow the ratio`;
      return report;
    }
    report.value = value;
    return report;
  };
  const head = (input: RatioInput): number | null => explain(input).value;
  return Object.assign(head, { explain }) as RatioFacade<Input>;
}

// ---------------------------------------------------------------------------------------------------
// Shared resolution helpers for definitions
// ---------------------------------------------------------------------------------------------------

/** Average of one balance field across the prior/current endpoints; absent anywhere → null. */
export function averageBalance(
  current: FinancialStatements,
  prior: FinancialStatements,
  field: string,
  label: string,
  notes: string[],
): { amount: number; label: string } | null {
  const currentValue = (current.balance as unknown as Record<string, number | undefined>)[field];
  const priorValue = (prior.balance as unknown as Record<string, number | undefined>)[field];
  if (currentValue === undefined || priorValue === undefined) return null;
  notes.push(`${label} averaged over beginning (prior end) and ending balances`);
  return { amount: (priorValue + currentValue) / 2, label: `average ${label}` };
}

/**
 * EBITDA under the canonical statement mapping: operating income plus depreciation/amortization.
 * D&A absent → null (no proxy is substituted).
 */
export function resolveEbitda(
  statements: FinancialStatements,
  notes: string[],
): { amount: number } | null {
  const depreciationAndAmortization = statements.cashFlow.depreciationAndAmortization;
  if (depreciationAndAmortization === undefined) return null;
  notes.push(
    'EBITDA = operatingIncome + depreciationAndAmortization (canonical statement mapping)',
  );
  return { amount: statements.income.operatingIncome + depreciationAndAmortization };
}

/**
 * Enterprise value = market capitalization + total debt + preferred equity + minority interest −
 * cash and cash equivalents − separately supplied non-operating assets. Absent optional balance
 * lines are disclosed as excluded, never silently zeroed without a note.
 */
export function resolveEnterpriseValue(
  statements: FinancialStatements,
  marketCapitalization: number,
  nonOperatingAssets: number | undefined,
  resolveTotalDebtFn: (balance: FinancialStatements['balance']) => {
    totalDebt: number | null;
    derived: boolean;
  },
  notes: string[],
): { amount: number } | { reason: string } {
  const balance = statements.balance;
  const { totalDebt, derived } = resolveTotalDebtFn(balance);
  if (totalDebt === null) {
    return {
      reason:
        'no interest-bearing debt figure — totalDebt, or shortTermDebt/longTermDebt, is required for enterprise value',
    };
  }
  if (derived) notes.push('totalDebt derived from the stated debt maturities');
  // Balance amounts to ABSOLUTE currency: the market capitalization side already is, and mixing
  // scales would shift the bridge by the reporting scale. `nonOperatingAssets` is supplied by the
  // caller in absolute currency alongside the market observation.
  let enterpriseValue =
    marketCapitalization +
    absoluteAmount(statements, totalDebt, notes) -
    absoluteAmount(statements, balance.cashAndCashEquivalents, notes);
  if (balance.preferredEquity !== undefined) {
    enterpriseValue += absoluteAmount(statements, balance.preferredEquity, notes);
  } else notes.push('preferredEquity absent — excluded from enterprise value');
  if (balance.minorityInterest !== undefined) {
    enterpriseValue += absoluteAmount(statements, balance.minorityInterest, notes);
  } else notes.push('minorityInterest absent — excluded from enterprise value');
  if (nonOperatingAssets !== undefined) {
    enterpriseValue -= nonOperatingAssets;
    notes.push('nonOperatingAssets subtracted as separately supplied (absolute currency)');
  }
  return { amount: enterpriseValue };
}
