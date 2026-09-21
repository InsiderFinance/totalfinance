/**
 * FC2 — `analyzeFundamentals`: the one-call typed analysis. It selects the point-in-time snapshot,
 * runs every direct ratio the supplied inputs can support, runs the scores whose models can run,
 * and REPORTS every metric it could not form and why — a missing denominator is an answer, not an
 * omission.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  type EpochMs,
  ensureKnownKeys,
  isQuantError,
  requireArgumentObject,
} from '@totalfinance/core';
import { type FinancialStatements, type RestatementPolicy } from './statement-contracts.js';
import { selectFundamentalSnapshot } from './statement-utilities.js';
import {
  type MarketObservation,
  type RatioFacade,
  type RatioInput,
  requireMarketObservation,
} from './ratio-internals.js';
import * as ratios from './ratio-heads.js';
import {
  type AltmanResult,
  type AltmanVariant,
  type BeneishResult,
  type PiotroskiResult,
  altmanZScore,
  beneishMScore,
  piotroskiFScore,
} from './score-heads.js';

/** Input for {@link analyzeFundamentals}. */
export interface AnalyzeFundamentalsInput {
  /** The reported history (restatements included) — the analysis sees only what `asOf` allows. */
  statements: readonly FinancialStatements[];
  /** The market side for valuation multiples; without it they are reported missing, not guessed. */
  marketSnapshot?: MarketObservation;
  asOf: EpochMs;
  restatementPolicy: RestatementPolicy;
  /** Day metrics need the explicit period-day count; absent → they are reported missing. */
  periodDays?: number;
  /** Bounds market-observation staleness for the multiples when supplied. */
  maximumStalenessMs?: number;
  /** Explicit tax rate for return on invested capital; else the effective rate is derived. */
  taxRate?: number;
  /** The exact debt-service denominator; absent → debtServiceCoverage is reported missing. */
  debtServiceAmount?: number;
  /** Separately supplied non-operating assets for enterprise value. */
  nonOperatingAssets?: number;
  /** Runs the Altman Z-score under this explicit published variant; absent → reported missing. */
  altmanVariant?: AltmanVariant;
}

/** One computed (or explicitly not-computed) metric. */
export interface AnalyzedRatio {
  value: number | null;
  reason?: string;
}

/** Result of {@link analyzeFundamentals}. */
export interface AnalyzeFundamentalsResult {
  assumptions: {
    asOf: EpochMs;
    restatementPolicy: RestatementPolicy;
    periodUsed: { periodEndDate: string; periodType: string; fiscalYear: number };
    priorPeriodUsed?: { periodEndDate: string; periodType: string; fiscalYear: number };
  };
  diagnostics: {
    /** One warning per metric that could not be formed (mirrors `missing`). */
    warnings: string[];
  };
  asOf: EpochMs;
  restatementPolicy: RestatementPolicy;
  /** How many statement sets were visible at `asOf` after restatement resolution. */
  periodsVisible: number;
  /** The period the single-period metrics used. */
  periodUsed: { periodEndDate: string; periodType: string; fiscalYear: number };
  /** The prior period the average-balance metrics used, when one was visible. */
  priorPeriodUsed?: { periodEndDate: string; periodType: string; fiscalYear: number };
  ratios: Record<string, AnalyzedRatio>;
  scores: {
    piotroski?: PiotroskiResult;
    altman?: AltmanResult;
    beneish?: BeneishResult;
  };
  /** Every metric that could not be formed, with its reason — the honest gaps ledger. */
  missing: Array<{ metric: string; reason: string }>;
}

/**
 * The kernel-internal bag view of a precisely-typed head. The composition assembles each head's
 * exact input at runtime; the wide view exists only so heads of different shapes share one table.
 */
function asComposable(head: { explain(input: never): unknown }): RatioFacade {
  return head as unknown as RatioFacade;
}

const SINGLE_PERIOD_HEADS: ReadonlyArray<[string, RatioFacade]> = [
  ['grossMargin', asComposable(ratios.grossMargin)],
  ['operatingMargin', asComposable(ratios.operatingMargin)],
  ['ebitdaMargin', asComposable(ratios.ebitdaMargin)],
  ['netProfitMargin', asComposable(ratios.netProfitMargin)],
  ['currentRatio', asComposable(ratios.currentRatio)],
  ['quickRatio', asComposable(ratios.quickRatio)],
  ['cashRatio', asComposable(ratios.cashRatio)],
  ['debtToEquity', asComposable(ratios.debtToEquity)],
  ['debtToAssets', asComposable(ratios.debtToAssets)],
  ['netDebtToEbitda', asComposable(ratios.netDebtToEbitda)],
  ['interestCoverage', asComposable(ratios.interestCoverage)],
  ['cashFlowToNetIncome', asComposable(ratios.cashFlowToNetIncome)],
  ['earningsPerShare', asComposable(ratios.earningsPerShare)],
  ['bookValuePerShare', asComposable(ratios.bookValuePerShare)],
  ['revenuePerShare', asComposable(ratios.revenuePerShare)],
  ['freeCashFlowPerShare', asComposable(ratios.freeCashFlowPerShare)],
];

const PAIR_HEADS: ReadonlyArray<[string, RatioFacade]> = [
  ['returnOnAssets', asComposable(ratios.returnOnAssets)],
  ['returnOnEquity', asComposable(ratios.returnOnEquity)],
  ['returnOnInvestedCapital', asComposable(ratios.returnOnInvestedCapital)],
  ['returnOnCapitalEmployed', asComposable(ratios.returnOnCapitalEmployed)],
  ['assetTurnover', asComposable(ratios.assetTurnover)],
  ['inventoryTurnover', asComposable(ratios.inventoryTurnover)],
  ['receivablesTurnover', asComposable(ratios.receivablesTurnover)],
  ['payablesTurnover', asComposable(ratios.payablesTurnover)],
  ['accrualRatio', asComposable(ratios.accrualRatio)],
  ['cashReturnOnAssets', asComposable(ratios.cashReturnOnAssets)],
];

const DAY_HEADS: ReadonlyArray<[string, RatioFacade]> = [
  ['daysInventoryOutstanding', asComposable(ratios.daysInventoryOutstanding)],
  ['daysSalesOutstanding', asComposable(ratios.daysSalesOutstanding)],
  ['daysPayablesOutstanding', asComposable(ratios.daysPayablesOutstanding)],
  ['cashConversionCycle', asComposable(ratios.cashConversionCycle)],
];

const MARKET_HEADS: ReadonlyArray<[string, RatioFacade]> = [
  ['priceToEarnings', asComposable(ratios.priceToEarnings)],
  ['priceToBook', asComposable(ratios.priceToBook)],
  ['priceToSales', asComposable(ratios.priceToSales)],
  ['enterpriseValueToRevenue', asComposable(ratios.enterpriseValueToRevenue)],
  ['enterpriseValueToEbitda', asComposable(ratios.enterpriseValueToEbitda)],
  ['freeCashFlowYield', asComposable(ratios.freeCashFlowYield)],
  ['earningsYield', asComposable(ratios.earningsYield)],
  ['dividendYield', asComposable(ratios.dividendYield)],
];

const ANALYZE_KEYS = [
  'statements',
  'marketSnapshot',
  'asOf',
  'restatementPolicy',
  'periodDays',
  'maximumStalenessMs',
  'taxRate',
  'debtServiceAmount',
  'nonOperatingAssets',
  'altmanVariant',
] as const;

/**
 * The one-call analysis. Missing inputs disable exactly the metrics that need them, each with a
 * stated reason; nothing is guessed, proxied, or silently skipped.
 */
export function analyzeFundamentals(input: AnalyzeFundamentalsInput): AnalyzeFundamentalsResult {
  requireArgumentObject('analyzeFundamentals', 'input', input);
  ensureKnownKeys('analyzeFundamentals', 'input', input, ANALYZE_KEYS);
  if (input.restatementPolicy === undefined) {
    throw new InputError(
      `analyzeFundamentals: restatementPolicy is required ('latest-available' | 'first-reported') — which VERSION of a period the analysis sees is a decision, not a default.\n  e.g. analyzeFundamentals({ statements, asOf: Date.UTC(2026, 7, 12), restatementPolicy: 'latest-available' })`,
      { code: ErrorCode.InputMissingField, context: { field: 'restatementPolicy' } },
    );
  }
  if (input.marketSnapshot !== undefined) {
    requireMarketObservation('analyzeFundamentals', input.marketSnapshot);
  }
  // Every optional scalar is typed at THIS boundary, even when the metric that would consume it
  // is disabled — null is a wrong-typed value, not omission, and an unconsumed wrong value
  // accepted silently is exactly the defect class the probes exist to catch.
  for (const [field, minimum, exclusive] of [
    ['periodDays', 0, true],
    ['maximumStalenessMs', 0, false],
    ['taxRate', 0, false],
    ['debtServiceAmount', 0, true],
    ['nonOperatingAssets', 0, false],
  ] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (exclusive ? value <= minimum : value < minimum) ||
      (field === 'taxRate' && value >= 1)
    ) {
      throw new InputError(
        `analyzeFundamentals: ${field} must be a finite number ${exclusive ? '>' : '≥'} ${minimum}${field === 'taxRate' ? ' and < 1' : ''} when provided. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        {
          code:
            typeof value === 'number' && Number.isFinite(value)
              ? ErrorCode.InputOutOfRange
              : ErrorCode.InputWrongType,
          context: { field },
        },
      );
    }
  }
  const snapshot = selectFundamentalSnapshot({
    series: { statements: input.statements },
    asOf: input.asOf,
    restatementPolicy: input.restatementPolicy,
  });
  if (snapshot.statements.length === 0) {
    throw new InputError(
      `analyzeFundamentals: no statement set is available at asOf=${input.asOf} — availability (availableTimestampMs), not period end, controls what an observer can see.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'asOf' } },
    );
  }

  const visible = snapshot.statements;
  const current = visible[visible.length - 1]!;
  const prior = visible.length >= 2 ? visible[visible.length - 2]! : undefined;
  const priorPrior = visible.length >= 3 ? visible[visible.length - 3]! : undefined;

  const computed: Record<string, AnalyzedRatio> = {};
  const missing: Array<{ metric: string; reason: string }> = [];
  const record = (metric: string, entry: AnalyzedRatio): void => {
    computed[metric] = entry;
    if (entry.value === null) {
      missing.push({ metric, reason: entry.reason ?? 'the metric could not be formed' });
    }
  };
  const skip = (metric: string, reason: string): void => {
    computed[metric] = { value: null, reason };
    missing.push({ metric, reason });
  };
  const run = (metric: string, head: RatioFacade, headInput: RatioInput): void => {
    const report = head.explain(headInput);
    record(metric, {
      value: report.value,
      ...(report.diagnostics.reason !== undefined ? { reason: report.diagnostics.reason } : {}),
    });
  };

  for (const [metric, head] of SINGLE_PERIOD_HEADS) {
    run(metric, head, { statements: current });
  }
  record(
    'debtServiceCoverage',
    input.debtServiceAmount === undefined
      ? {
          value: null,
          reason: 'debtServiceAmount not supplied — coverage uses the exact denominator supplied',
        }
      : (() => {
          const report = ratios.debtServiceCoverage.explain({
            statements: current,
            debtServiceAmount: input.debtServiceAmount,
          });
          return {
            value: report.value,
            ...(report.diagnostics.reason !== undefined
              ? { reason: report.diagnostics.reason }
              : {}),
          };
        })(),
  );

  const priorReason =
    'only one period is visible at asOf — average-balance metrics need the prior period';
  for (const [metric, head] of PAIR_HEADS) {
    if (prior === undefined) {
      skip(metric, priorReason);
      continue;
    }
    run(metric, head, {
      current,
      prior,
      ...(metric === 'returnOnInvestedCapital' && input.taxRate !== undefined
        ? { taxRate: input.taxRate }
        : {}),
    });
  }
  for (const [metric, head] of DAY_HEADS) {
    if (prior === undefined) {
      skip(metric, priorReason);
      continue;
    }
    if (input.periodDays === undefined) {
      skip(
        metric,
        'periodDays not supplied — day metrics use the explicitly supplied period-day count',
      );
      continue;
    }
    run(metric, head, { current, prior, periodDays: input.periodDays });
  }
  for (const [metric, head] of MARKET_HEADS) {
    if (input.marketSnapshot === undefined) {
      skip(metric, 'marketSnapshot not supplied — a market multiple has a market side');
      continue;
    }
    run(metric, head, {
      statements: current,
      marketObservation: input.marketSnapshot,
      ...(input.maximumStalenessMs !== undefined
        ? { maximumStalenessMs: input.maximumStalenessMs }
        : {}),
      ...((metric === 'enterpriseValueToRevenue' || metric === 'enterpriseValueToEbitda') &&
      input.nonOperatingAssets !== undefined
        ? { nonOperatingAssets: input.nonOperatingAssets }
        : {}),
    });
  }

  const scores: AnalyzeFundamentalsResult['scores'] = {};
  if (priorPrior === undefined) {
    missing.push({
      metric: 'piotroskiFScore',
      reason:
        'fewer than three periods are visible at asOf — the beginning-assets signals need the balance sheet two periods back',
    });
  } else {
    scores.piotroski = piotroskiFScore({ current, prior: prior!, priorPrior });
  }
  if (input.altmanVariant === undefined) {
    missing.push({
      metric: 'altmanZScore',
      reason: 'altmanVariant not supplied — the published variant is explicit, never defaulted',
    });
  } else {
    try {
      scores.altman = altmanZScore({
        statements: current,
        variant: input.altmanVariant,
        ...(input.altmanVariant === 'public-manufacturing'
          ? (() => {
              if (input.marketSnapshot === undefined) {
                throw new InputError(
                  'analyzeFundamentals: the public-manufacturing Altman variant needs marketSnapshot — its X4 uses market equity.',
                  { code: ErrorCode.InputMissingField, context: { field: 'marketSnapshot' } },
                );
              }
              const marketEquity =
                input.marketSnapshot.marketCapitalization ??
                input.marketSnapshot.sharePrice * input.marketSnapshot.sharesOutstanding!;
              return { marketEquity };
            })()
          : {}),
      });
    } catch (error) {
      if (isQuantError(error) && error.code === ErrorCode.InputMissingField) {
        missing.push({ metric: 'altmanZScore', reason: error.message });
      } else {
        throw error;
      }
    }
  }
  if (prior === undefined) {
    missing.push({
      metric: 'beneishMScore',
      reason: 'only one period is visible at asOf — the model compares two consecutive periods',
    });
  } else {
    try {
      scores.beneish = beneishMScore({ current, prior });
    } catch (error) {
      if (isQuantError(error) && error.code === ErrorCode.InputMissingField) {
        missing.push({ metric: 'beneishMScore', reason: error.message });
      } else {
        throw error;
      }
    }
  }

  const identity = (statements: FinancialStatements) => ({
    periodEndDate: statements.income.period.periodEndDate,
    periodType: statements.income.period.periodType,
    fiscalYear: statements.income.period.fiscalYear,
  });
  return requireRepresentableResult('analyzeFundamentals', {
    assumptions: {
      asOf: input.asOf,
      restatementPolicy: input.restatementPolicy,
      periodUsed: identity(current),
      ...(prior !== undefined ? { priorPeriodUsed: identity(prior) } : {}),
    },
    diagnostics: { warnings: missing.map((entry) => `${entry.metric}: ${entry.reason}`) },
    asOf: input.asOf,
    restatementPolicy: input.restatementPolicy,
    periodsVisible: visible.length,
    periodUsed: identity(current),
    ...(prior !== undefined ? { priorPeriodUsed: identity(prior) } : {}),
    ratios: computed,
    scores,
    missing,
  });
}
