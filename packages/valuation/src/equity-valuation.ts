/**
 * FC2 — equity valuation models: the dividend-discount valuation and the residual-income
 * valuation (clean-surplus). Both are per-share, explicitly.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  discountFactor,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
  type InterestCompounding,
} from '@totalfinance/core';
import { requireCompoundingWhenPresent } from './discounting.js';
import { type TimedCashFlow, requireTimedCashFlows } from './flows.js';
import {
  type TerminalValueMethod,
  requireTerminalValueMethod,
  terminalValue,
} from './corporate-primitives.js';

// ---------------------------------------------------------------------------------------------------
// Dividend discount
// ---------------------------------------------------------------------------------------------------

/** Input for {@link dividendDiscountValuation}. */
export interface DividendDiscountInput {
  /**
   * Explicit projected dividends PER SHARE (timed from today). An empty projection stage with a
   * perpetual-growth terminal is the classic single-stage Gordon model.
   */
  projectedDividendsPerShare: readonly TimedCashFlow[];
  /** Annual cost of equity (decimal) — the discount rate for dividends. */
  annualCostOfEquity: number;
  terminalValueMethod: TerminalValueMethod;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
}

/** Result of {@link dividendDiscountValuation}. */
export interface DividendDiscountResult {
  diagnostics: { warnings: string[] };
  valuePerShare: number;
  rows: Array<{
    timeYears: number;
    dividendPerShare: number;
    discountFactor: number;
    presentValue: number;
  }>;
  projectedDividendPresentValue: number;
  terminalValue: number;
  terminalValuePresentValue: number;
  assumptions: {
    annualCostOfEquity: number;
    compounding: InterestCompounding;
    terminalValueMethod: TerminalValueMethod;
    terminalCashFlowConvention: 'final-forecast-period-flow';
  };
}

/**
 * Present value of explicit projected dividends per share plus a terminal stage. With an EMPTY
 * projection stage and a perpetual-growth terminal (its `terminalCashFlow` being the CURRENT
 * annual dividend), this is exactly the Gordon growth model: `D0 × (1 + g) / (r − g)`.
 */
export function dividendDiscountValuation(input: DividendDiscountInput): DividendDiscountResult {
  requireArgumentObject('dividendDiscountValuation', 'input', input);
  ensureKnownKeys('dividendDiscountValuation', 'input', input, [
    'projectedDividendsPerShare',
    'annualCostOfEquity',
    'terminalValueMethod',
    'compounding',
  ]);
  requireFiniteFields(
    'dividendDiscountValuation',
    input as unknown as Record<string, unknown>,
    ['annualCostOfEquity'],
    {
      exampleCall:
        "dividendDiscountValuation({ projectedDividendsPerShare: [], annualCostOfEquity: 0.09, terminalValueMethod: { method: 'perpetual-growth', terminalCashFlow: 2, perpetualGrowthRate: 0.03 } })",
    },
  );
  if (!Array.isArray(input.projectedDividendsPerShare)) {
    throw new InputError(
      `dividendDiscountValuation: projectedDividendsPerShare must be an array (possibly empty for the single-stage model).`,
      { code: ErrorCode.InputWrongType, context: { field: 'projectedDividendsPerShare' } },
    );
  }
  if (input.projectedDividendsPerShare.length > 0) {
    requireTimedCashFlows('dividendDiscountValuation', input.projectedDividendsPerShare);
  }
  requireCompoundingWhenPresent('dividendDiscountValuation', input.compounding);
  requireTerminalValueMethod(
    'dividendDiscountValuation',
    input.terminalValueMethod,
    input.annualCostOfEquity,
  );
  const compounding = input.compounding ?? 'annual';
  const rows = input.projectedDividendsPerShare.map((flow) => {
    const factor = discountFactor(input.annualCostOfEquity, flow.timeYears, compounding);
    return {
      timeYears: flow.timeYears,
      dividendPerShare: flow.amount,
      discountFactor: factor,
      presentValue: flow.amount * factor,
    };
  });
  const projectedDividendPresentValue = rows.reduce((total, row) => total + row.presentValue, 0);
  const horizonYears = rows.length > 0 ? rows[rows.length - 1]!.timeYears : 0;
  const terminal = terminalValue({
    terminalValueMethod: input.terminalValueMethod,
    annualDiscountRate: input.annualCostOfEquity,
  });
  const terminalValuePresentValue =
    terminal * discountFactor(input.annualCostOfEquity, horizonYears, compounding);
  return requireRepresentableResult('dividendDiscountValuation', {
    diagnostics: { warnings: [] },
    valuePerShare: projectedDividendPresentValue + terminalValuePresentValue,
    rows,
    projectedDividendPresentValue,
    terminalValue: terminal,
    terminalValuePresentValue,
    assumptions: {
      annualCostOfEquity: input.annualCostOfEquity,
      compounding,
      terminalValueMethod: input.terminalValueMethod,
      terminalCashFlowConvention: 'final-forecast-period-flow',
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// Residual income
// ---------------------------------------------------------------------------------------------------

/** One projected clean-surplus year. */
export interface ResidualIncomeProjection {
  earningsPerShare: number;
  dividendsPerShare: number;
}

/** Input for {@link residualIncomeValuation}. */
export interface ResidualIncomeInput {
  /** Book value per share at the valuation date. */
  beginningBookValuePerShare: number;
  /** Annual cost of equity (decimal). */
  annualCostOfEquity: number;
  /** One entry per forecast YEAR, in order — clean surplus rolls the book value between them. */
  projections: readonly ResidualIncomeProjection[];
  /**
   * The residual-income terminal stage: `'none'` states that residual income is competed away
   * after the horizon; `'perpetuity'` continues the FINAL residual income at a growth rate.
   */
  terminalResidualIncome:
    | { method: 'none' }
    | { method: 'perpetuity'; perpetualGrowthRate: number };
}

/** Result of {@link residualIncomeValuation}. */
export interface ResidualIncomeResult {
  diagnostics: { warnings: string[] };
  valuePerShare: number;
  beginningBookValuePerShare: number;
  rows: Array<{
    year: number;
    beginningBookValuePerShare: number;
    earningsPerShare: number;
    dividendsPerShare: number;
    endingBookValuePerShare: number;
    equityCharge: number;
    residualIncomePerShare: number;
    presentValue: number;
  }>;
  residualIncomePresentValue: number;
  terminalValuePresentValue: number;
  assumptions: {
    annualCostOfEquity: number;
    cleanSurplus: 'ending book = beginning book + earnings - dividends';
    terminalResidualIncome: ResidualIncomeInput['terminalResidualIncome'];
  };
}

/**
 * Clean-surplus residual income: value = beginning book value + Σ PV(EPS_t − r × B_{t−1}) + PV of
 * the stated terminal stage. Book value rolls forward as `B_t = B_{t−1} + EPS_t − DPS_t`; annual
 * discrete discounting (the model is annual by construction).
 */
export function residualIncomeValuation(input: ResidualIncomeInput): ResidualIncomeResult {
  requireArgumentObject('residualIncomeValuation', 'input', input);
  ensureKnownKeys('residualIncomeValuation', 'input', input, [
    'beginningBookValuePerShare',
    'annualCostOfEquity',
    'projections',
    'terminalResidualIncome',
  ]);
  requireFiniteFields(
    'residualIncomeValuation',
    input as unknown as Record<string, unknown>,
    ['beginningBookValuePerShare', 'annualCostOfEquity'],
    {
      exampleCall:
        "residualIncomeValuation({ beginningBookValuePerShare: 20, annualCostOfEquity: 0.1, projections: [{ earningsPerShare: 3, dividendsPerShare: 1 }], terminalResidualIncome: { method: 'none' } })",
    },
  );
  if (!Array.isArray(input.projections) || input.projections.length === 0) {
    throw new InputError(
      `residualIncomeValuation: projections must be a non-empty array of { earningsPerShare, dividendsPerShare } years.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'projections' } },
    );
  }
  input.projections.forEach((projection, index) => {
    requireArgumentObject('residualIncomeValuation', `projections[${index}]`, projection);
    ensureKnownKeys('residualIncomeValuation', `projections[${index}]`, projection, [
      'earningsPerShare',
      'dividendsPerShare',
    ]);
    requireFiniteFields(
      'residualIncomeValuation',
      projection as unknown as Record<string, unknown>,
      ['earningsPerShare', 'dividendsPerShare'],
      {
        exampleCall:
          "residualIncomeValuation({ beginningBookValuePerShare: 20, annualCostOfEquity: 0.1, projections: [{ earningsPerShare: 3, dividendsPerShare: 1 }], terminalResidualIncome: { method: 'none' } })",
      },
    );
  });
  const terminal = input.terminalResidualIncome;
  requireArgumentObject('residualIncomeValuation', 'terminalResidualIncome', terminal);
  const terminalMethod = (terminal as { method?: unknown }).method;
  if (terminalMethod === 'none') {
    ensureKnownKeys('residualIncomeValuation', 'terminalResidualIncome', terminal, ['method']);
  } else if (terminalMethod === 'perpetuity') {
    ensureKnownKeys('residualIncomeValuation', 'terminalResidualIncome', terminal, [
      'method',
      'perpetualGrowthRate',
    ]);
    requireFiniteFields(
      'residualIncomeValuation',
      terminal as unknown as Record<string, unknown>,
      ['perpetualGrowthRate'],
      {
        exampleCall:
          "residualIncomeValuation({ beginningBookValuePerShare: 20, annualCostOfEquity: 0.1, projections: [{ earningsPerShare: 3, dividendsPerShare: 1 }], terminalResidualIncome: { method: 'perpetuity', perpetualGrowthRate: 0 } })",
      },
    );
    if (
      input.annualCostOfEquity <= (terminal as { perpetualGrowthRate: number }).perpetualGrowthRate
    ) {
      throw new InputError(
        `residualIncomeValuation: the terminal perpetuity requires annualCostOfEquity > perpetualGrowthRate — received cost ${input.annualCostOfEquity} against growth ${(terminal as { perpetualGrowthRate: number }).perpetualGrowthRate}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: 'terminalResidualIncome.perpetualGrowthRate' },
        },
      );
    }
  } else {
    throw new InputError(
      `residualIncomeValuation: terminalResidualIncome.method must be 'none' | 'perpetuity'. Received ${terminalMethod === null ? 'null' : JSON.stringify(terminalMethod)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'terminalResidualIncome.method' } },
    );
  }

  const rate = input.annualCostOfEquity;
  let book = input.beginningBookValuePerShare;
  let residualIncomePresentValue = 0;
  const rows: ResidualIncomeResult['rows'] = input.projections.map((projection, index) => {
    const year = index + 1;
    const equityCharge = rate * book;
    const residualIncomePerShare = projection.earningsPerShare - equityCharge;
    const presentValue = residualIncomePerShare / Math.pow(1 + rate, year);
    const endingBook = book + projection.earningsPerShare - projection.dividendsPerShare;
    const row = {
      year,
      beginningBookValuePerShare: book,
      earningsPerShare: projection.earningsPerShare,
      dividendsPerShare: projection.dividendsPerShare,
      endingBookValuePerShare: endingBook,
      equityCharge,
      residualIncomePerShare,
      presentValue,
    };
    residualIncomePresentValue += presentValue;
    book = endingBook;
    return row;
  });

  let terminalValuePresentValue = 0;
  if (terminalMethod === 'perpetuity') {
    const growth = (terminal as { perpetualGrowthRate: number }).perpetualGrowthRate;
    const lastRow = rows[rows.length - 1]!;
    const horizon = rows.length;
    // The perpetuity continues the FINAL residual income, grown one year, from the horizon.
    const terminalAtHorizon = (lastRow.residualIncomePerShare * (1 + growth)) / (rate - growth);
    terminalValuePresentValue = terminalAtHorizon / Math.pow(1 + rate, horizon);
  }
  return requireRepresentableResult('residualIncomeValuation', {
    diagnostics: { warnings: [] },
    valuePerShare:
      input.beginningBookValuePerShare + residualIncomePresentValue + terminalValuePresentValue,
    beginningBookValuePerShare: input.beginningBookValuePerShare,
    rows,
    residualIncomePresentValue,
    terminalValuePresentValue,
    assumptions: {
      annualCostOfEquity: rate,
      cleanSurplus: 'ending book = beginning book + earnings - dividends',
      terminalResidualIncome: input.terminalResidualIncome,
    },
  });
}
