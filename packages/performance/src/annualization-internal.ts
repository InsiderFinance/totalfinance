/**
 * Package-internal annualization resolvers — deliberately ABSENT from the exports map (every other
 * module in this package IS a public entrypoint, so this is the only non-public home). The
 * statistics cluster set the precedent: shared validation plumbing lives in an `-internal` module
 * so the public surface carries only the metrics and their conventions.
 */

import { ensureFiniteWhenPresent, ErrorCode, InputError } from '@totalfinance/core';
import {
  type AnnualizationOptions,
  DEFAULT_PERIODS_PER_YEAR,
  type SharpeOptions,
} from './sharpe.js';

/**
 * Resolve the annualization factor through the optional-scalar ladder: a PRESENT
 * `periodsPerYear` must be a positive finite number (null is a wrong-typed value, not omission —
 * the 350c2796 ruling); an omitted one engages the disclosed default. Every metric in the package
 * resolves through here, so `{ periodsPerYear: null }` can never silently annualize at 252 and a
 * string can never be echoed into `assumptions` as if it were the applied convention.
 */
export function resolvePeriodsPerYear(functionName: string, options: AnnualizationOptions): number {
  ensureFiniteWhenPresent(options.periodsPerYear, 'periodsPerYear', functionName);
  if (options.periodsPerYear !== undefined && options.periodsPerYear <= 0) {
    throw new InputError(
      `${functionName}: periodsPerYear must be a positive finite number of periods per year (252 daily, 12 monthly, 52 weekly). Received ${options.periodsPerYear}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'periodsPerYear', value: options.periodsPerYear },
      },
    );
  }
  return options.periodsPerYear ?? DEFAULT_PERIODS_PER_YEAR;
}

/**
 * Resolve the applied risk-free rate: finite number when present (negative rates are real),
 * 0 when omitted. Same ladder discipline as {@link resolvePeriodsPerYear}.
 */
export function resolveRiskFreeRate(functionName: string, options: SharpeOptions): number {
  ensureFiniteWhenPresent(options.riskFreeRate, 'riskFreeRate', functionName);
  return options.riskFreeRate ?? 0;
}
