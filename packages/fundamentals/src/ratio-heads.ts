/**
 * FC2 — the direct ratio operations. Every head is made by the kernel in `ratio-internals.ts`
 * (one validation gate, one explain shape) and states its FIXED formula; the bases are the
 * spec-frozen defaults, never per-call reinterpretations. Values are decimal ratios — a display
 * layer may render percentages, this library does not.
 */

import { resolveGrossProfit, resolveTotalDebt } from './statement-contracts.js';
import {
  type DayMetricRatioInput,
  type DebtServiceRatioInput,
  type EnterpriseMultipleRatioInput,
  type InvestedCapitalRatioInput,
  type MarketMultipleRatioInput,
  type PairRatioInput,
  type RatioFacade,
  type RatioInput,
  type RatioOutcome,
  type SingleStatementRatioInput,
  absoluteAmount,
  averageBalance,
  makeRatio,
  resolveEbitda,
  resolveEnterpriseValue,
  resolveMarketCapitalization,
} from './ratio-internals.js';

// ---------------------------------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------------------------------

export const grossMargin: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'grossMargin',
    category: 'profitability',
    formula: 'grossProfit / revenue',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const income = input.statements!.income;
      const { grossProfit, derived } = resolveGrossProfit(income);
      if (grossProfit === null) {
        return {
          reason: 'neither grossProfit nor costOfRevenue is stated — gross profit cannot be formed',
        };
      }
      if (derived) notes.push('grossProfit derived as revenue - costOfRevenue');
      return {
        numerator: { label: 'grossProfit', amount: grossProfit },
        denominator: { label: 'revenue', amount: income.revenue },
      };
    },
  });

export const operatingMargin: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'operatingMargin',
    category: 'profitability',
    formula: 'operatingIncome / revenue',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const income = input.statements!.income;
      return {
        numerator: { label: 'operatingIncome', amount: income.operatingIncome },
        denominator: { label: 'revenue', amount: income.revenue },
      };
    },
  });

export const ebitdaMargin: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'ebitdaMargin',
    category: 'profitability',
    formula: '(operatingIncome + depreciationAndAmortization) / revenue',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const ebitda = resolveEbitda(input.statements!, notes);
      if (ebitda === null) {
        return { reason: 'depreciationAndAmortization is absent — EBITDA cannot be formed' };
      }
      return {
        numerator: { label: 'EBITDA', amount: ebitda.amount },
        denominator: { label: 'revenue', amount: input.statements!.income.revenue },
      };
    },
  });

export const netProfitMargin: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'netProfitMargin',
    category: 'profitability',
    formula: 'netIncome / revenue',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const income = input.statements!.income;
      return {
        numerator: { label: 'netIncome', amount: income.netIncome },
        denominator: { label: 'revenue', amount: income.revenue },
      };
    },
  });

// ---------------------------------------------------------------------------------------------------
// Returns (average balance denominators)
// ---------------------------------------------------------------------------------------------------

export const returnOnAssets: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'returnOnAssets',
  category: 'returns',
  formula: 'netIncome / average totalAssets',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const denominator = averageBalance(
      input.current!,
      input.prior!,
      'totalAssets',
      'totalAssets',
      notes,
    )!;
    return {
      numerator: { label: 'netIncome', amount: input.current!.income.netIncome },
      denominator,
    };
  },
});

export const returnOnEquity: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'returnOnEquity',
  category: 'returns',
  formula: 'netIncome / average totalEquity',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const denominator = averageBalance(
      input.current!,
      input.prior!,
      'totalEquity',
      'totalEquity',
      notes,
    )!;
    return {
      numerator: { label: 'netIncome', amount: input.current!.income.netIncome },
      denominator,
    };
  },
});

export const returnOnInvestedCapital: RatioFacade<InvestedCapitalRatioInput> =
  makeRatio<InvestedCapitalRatioInput>({
    ratioName: 'returnOnInvestedCapital',
    category: 'returns',
    formula:
      'operatingIncome × (1 - taxRate) / average (interest-bearing debt + totalEquity - cashAndCashEquivalents)',
    keys: ['current', 'prior', 'taxRate'],
    compute(input, notes): RatioOutcome {
      const income = input.current!.income;
      let taxRate = input.taxRate;
      if (taxRate === undefined) {
        const taxExpense = income.incomeTaxExpense;
        if (taxExpense === undefined) {
          return {
            reason:
              'no taxRate was supplied and incomeTaxExpense is absent — the effective rate cannot be derived',
          };
        }
        const pretaxIncome = income.netIncome + taxExpense;
        if (pretaxIncome <= 0) {
          return {
            reason:
              'no taxRate was supplied and pretax income (netIncome + incomeTaxExpense) is not positive — the effective rate is meaningless',
          };
        }
        taxRate = taxExpense / pretaxIncome;
        notes.push(
          `taxRate derived as the effective rate incomeTaxExpense / (netIncome + incomeTaxExpense) = ${taxRate.toFixed(4)}`,
        );
      }
      const investedCapitalAt = (statements: typeof input.current): number | null => {
        const balance = statements!.balance;
        const { totalDebt } = resolveTotalDebt(balance);
        if (totalDebt === null) return null;
        return totalDebt + balance.totalEquity - balance.cashAndCashEquivalents;
      };
      const currentCapital = investedCapitalAt(input.current);
      const priorCapital = investedCapitalAt(input.prior);
      if (currentCapital === null || priorCapital === null) {
        return {
          reason:
            'no interest-bearing debt figure in one endpoint — invested capital needs totalDebt or the stated debt maturities',
        };
      }
      notes.push('invested capital averaged over beginning (prior end) and ending balances');
      return {
        numerator: {
          label: 'after-tax operatingIncome',
          amount: income.operatingIncome * (1 - taxRate),
        },
        denominator: {
          label: 'average invested capital',
          amount: (currentCapital + priorCapital) / 2,
        },
      };
    },
  });

export const returnOnCapitalEmployed: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'returnOnCapitalEmployed',
  category: 'returns',
  formula: 'operatingIncome / average (totalAssets - currentLiabilities)',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const employedAt = (statements: typeof input.current): number | null => {
      const balance = statements!.balance;
      if (balance.currentLiabilities === undefined) return null;
      return balance.totalAssets - balance.currentLiabilities;
    };
    const currentEmployed = employedAt(input.current);
    const priorEmployed = employedAt(input.prior);
    if (currentEmployed === null || priorEmployed === null) {
      return {
        reason: 'currentLiabilities is absent in one endpoint — capital employed cannot be formed',
      };
    }
    notes.push('capital employed averaged over beginning (prior end) and ending balances');
    return {
      numerator: { label: 'operatingIncome', amount: input.current!.income.operatingIncome },
      denominator: {
        label: 'average capital employed',
        amount: (currentEmployed + priorEmployed) / 2,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------------------------------

export const currentRatio: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'currentRatio',
    category: 'liquidity',
    formula: 'currentAssets / currentLiabilities',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const balance = input.statements!.balance;
      if (balance.currentAssets === undefined || balance.currentLiabilities === undefined) {
        return { reason: 'currentAssets and currentLiabilities are both required' };
      }
      return {
        numerator: { label: 'currentAssets', amount: balance.currentAssets },
        denominator: { label: 'currentLiabilities', amount: balance.currentLiabilities },
      };
    },
  });

export const quickRatio: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'quickRatio',
    category: 'liquidity',
    formula: '(currentAssets - inventory) / currentLiabilities',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const balance = input.statements!.balance;
      if (
        balance.currentAssets === undefined ||
        balance.inventory === undefined ||
        balance.currentLiabilities === undefined
      ) {
        return { reason: 'currentAssets, inventory, and currentLiabilities are all required' };
      }
      return {
        numerator: {
          label: 'currentAssets - inventory',
          amount: balance.currentAssets - balance.inventory,
        },
        denominator: { label: 'currentLiabilities', amount: balance.currentLiabilities },
      };
    },
  });

export const cashRatio: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'cashRatio',
    category: 'liquidity',
    formula: 'cashAndCashEquivalents / currentLiabilities',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const balance = input.statements!.balance;
      if (balance.currentLiabilities === undefined) {
        return { reason: 'currentLiabilities is required' };
      }
      return {
        numerator: { label: 'cashAndCashEquivalents', amount: balance.cashAndCashEquivalents },
        denominator: { label: 'currentLiabilities', amount: balance.currentLiabilities },
      };
    },
  });

// ---------------------------------------------------------------------------------------------------
// Leverage and coverage
// ---------------------------------------------------------------------------------------------------

export const debtToEquity: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'debtToEquity',
    category: 'leverage',
    formula: 'interest-bearing debt / totalEquity',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const balance = input.statements!.balance;
      const { totalDebt, derived } = resolveTotalDebt(balance);
      if (totalDebt === null) {
        return {
          reason:
            'no interest-bearing debt figure — totalDebt or the stated maturities are required',
        };
      }
      if (derived) notes.push('totalDebt derived from the stated debt maturities');
      return {
        numerator: { label: 'totalDebt', amount: totalDebt },
        denominator: { label: 'totalEquity', amount: balance.totalEquity },
      };
    },
  });

export const debtToAssets: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'debtToAssets',
    category: 'leverage',
    formula: 'interest-bearing debt / totalAssets',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const balance = input.statements!.balance;
      const { totalDebt, derived } = resolveTotalDebt(balance);
      if (totalDebt === null) {
        return {
          reason:
            'no interest-bearing debt figure — totalDebt or the stated maturities are required',
        };
      }
      if (derived) notes.push('totalDebt derived from the stated debt maturities');
      return {
        numerator: { label: 'totalDebt', amount: totalDebt },
        denominator: { label: 'totalAssets', amount: balance.totalAssets },
      };
    },
  });

export const netDebtToEbitda: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'netDebtToEbitda',
    category: 'leverage',
    formula: '(interest-bearing debt - cashAndCashEquivalents) / EBITDA',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const statements = input.statements!;
      const { totalDebt, derived } = resolveTotalDebt(statements.balance);
      if (totalDebt === null) {
        return {
          reason:
            'no interest-bearing debt figure — totalDebt or the stated maturities are required',
        };
      }
      if (derived) notes.push('totalDebt derived from the stated debt maturities');
      const ebitda = resolveEbitda(statements, notes);
      if (ebitda === null) {
        return { reason: 'depreciationAndAmortization is absent — EBITDA cannot be formed' };
      }
      return {
        numerator: {
          label: 'net debt',
          amount: totalDebt - statements.balance.cashAndCashEquivalents,
        },
        denominator: { label: 'EBITDA', amount: ebitda.amount },
      };
    },
  });

export const interestCoverage: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'interestCoverage',
    category: 'leverage',
    formula: 'operatingIncome / interestExpense',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const income = input.statements!.income;
      if (income.interestExpense === undefined) {
        return {
          reason:
            'interestExpense is absent — coverage uses the exact interest denominator supplied',
        };
      }
      return {
        numerator: { label: 'operatingIncome', amount: income.operatingIncome },
        denominator: { label: 'interestExpense', amount: income.interestExpense },
      };
    },
  });

export const debtServiceCoverage: RatioFacade<DebtServiceRatioInput> =
  makeRatio<DebtServiceRatioInput>({
    ratioName: 'debtServiceCoverage',
    category: 'leverage',
    formula: 'operatingIncome / debtServiceAmount (the exact supplied denominator)',
    keys: ['statements', 'debtServiceAmount'],
    compute(input): RatioOutcome {
      return {
        numerator: { label: 'operatingIncome', amount: input.statements!.income.operatingIncome },
        denominator: { label: 'debtServiceAmount', amount: input.debtServiceAmount! },
      };
    },
  });

// ---------------------------------------------------------------------------------------------------
// Efficiency (matching flow over average balance; day metrics need the explicit day count)
// ---------------------------------------------------------------------------------------------------

export const assetTurnover: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'assetTurnover',
  category: 'efficiency',
  formula: 'revenue / average totalAssets',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const denominator = averageBalance(
      input.current!,
      input.prior!,
      'totalAssets',
      'totalAssets',
      notes,
    )!;
    return {
      numerator: { label: 'revenue', amount: input.current!.income.revenue },
      denominator,
    };
  },
});

function inventoryTurnoverOutcome(input: RatioInput, notes: string[]): RatioOutcome {
  const cost = input.current!.income.costOfRevenue;
  if (cost === undefined) {
    return { reason: 'costOfRevenue is absent — inventory turns on cost, not revenue' };
  }
  const denominator = averageBalance(input.current!, input.prior!, 'inventory', 'inventory', notes);
  if (denominator === null) {
    return { reason: 'inventory is absent in one endpoint — the average balance cannot be formed' };
  }
  return { numerator: { label: 'costOfRevenue', amount: cost }, denominator };
}

export const inventoryTurnover: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'inventoryTurnover',
  category: 'efficiency',
  formula: 'costOfRevenue / average inventory',
  keys: ['current', 'prior'],
  compute: inventoryTurnoverOutcome,
});

function receivablesTurnoverOutcome(input: RatioInput, notes: string[]): RatioOutcome {
  const denominator = averageBalance(
    input.current!,
    input.prior!,
    'accountsReceivable',
    'accountsReceivable',
    notes,
  );
  if (denominator === null) {
    return {
      reason: 'accountsReceivable is absent in one endpoint — the average balance cannot be formed',
    };
  }
  return {
    numerator: { label: 'revenue', amount: input.current!.income.revenue },
    denominator,
  };
}

export const receivablesTurnover: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'receivablesTurnover',
  category: 'efficiency',
  formula: 'revenue / average accountsReceivable',
  keys: ['current', 'prior'],
  compute: receivablesTurnoverOutcome,
});

function payablesTurnoverOutcome(input: RatioInput, notes: string[]): RatioOutcome {
  const cost = input.current!.income.costOfRevenue;
  if (cost === undefined) {
    return { reason: 'costOfRevenue is absent — payables turn on cost, not revenue' };
  }
  const denominator = averageBalance(
    input.current!,
    input.prior!,
    'accountsPayable',
    'accountsPayable',
    notes,
  );
  if (denominator === null) {
    return {
      reason: 'accountsPayable is absent in one endpoint — the average balance cannot be formed',
    };
  }
  return { numerator: { label: 'costOfRevenue', amount: cost }, denominator };
}

export const payablesTurnover: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'payablesTurnover',
  category: 'efficiency',
  formula: 'costOfRevenue / average accountsPayable',
  keys: ['current', 'prior'],
  compute: payablesTurnoverOutcome,
});

/**
 * A day metric from a turnover OUTCOME (not through the public facade — the boundary validates
 * once per external call, and an internal frame never re-validates).
 */
function daysFromTurnover(
  turnoverOutcome: (input: RatioInput, notes: string[]) => RatioOutcome,
  input: RatioInput,
  notes: string[],
  flowLabel: string,
): RatioOutcome {
  const outcome = turnoverOutcome(input, notes);
  if (outcome.reason !== undefined) return outcome;
  if (outcome.denominator!.amount === 0) {
    return { reason: `${outcome.denominator!.label} is zero — ${flowLabel} turnover is undefined` };
  }
  const turns = outcome.numerator!.amount / outcome.denominator!.amount;
  if (turns === 0) {
    return { reason: `${flowLabel} turnover is zero — the day metric is unbounded` };
  }
  return { valueOverride: input.periodDays! / turns };
}

export const daysInventoryOutstanding: RatioFacade<DayMetricRatioInput> =
  makeRatio<DayMetricRatioInput>({
    ratioName: 'daysInventoryOutstanding',
    category: 'efficiency',
    formula: 'periodDays / inventoryTurnover',
    keys: ['current', 'prior', 'periodDays'],
    compute(input, notes): RatioOutcome {
      return daysFromTurnover(inventoryTurnoverOutcome, input, notes, 'inventory');
    },
  });

export const daysSalesOutstanding: RatioFacade<DayMetricRatioInput> =
  makeRatio<DayMetricRatioInput>({
    ratioName: 'daysSalesOutstanding',
    category: 'efficiency',
    formula: 'periodDays / receivablesTurnover',
    keys: ['current', 'prior', 'periodDays'],
    compute(input, notes): RatioOutcome {
      return daysFromTurnover(receivablesTurnoverOutcome, input, notes, 'receivables');
    },
  });

export const daysPayablesOutstanding: RatioFacade<DayMetricRatioInput> =
  makeRatio<DayMetricRatioInput>({
    ratioName: 'daysPayablesOutstanding',
    category: 'efficiency',
    formula: 'periodDays / payablesTurnover',
    keys: ['current', 'prior', 'periodDays'],
    compute(input, notes): RatioOutcome {
      return daysFromTurnover(payablesTurnoverOutcome, input, notes, 'payables');
    },
  });

export const cashConversionCycle: RatioFacade<DayMetricRatioInput> = makeRatio<DayMetricRatioInput>(
  {
    ratioName: 'cashConversionCycle',
    category: 'efficiency',
    formula: 'daysInventoryOutstanding + daysSalesOutstanding - daysPayablesOutstanding',
    keys: ['current', 'prior', 'periodDays'],
    compute(input, notes): RatioOutcome {
      const parts = [
        ['daysInventoryOutstanding', inventoryTurnoverOutcome, 'inventory'],
        ['daysSalesOutstanding', receivablesTurnoverOutcome, 'receivables'],
        ['daysPayablesOutstanding', payablesTurnoverOutcome, 'payables'],
      ] as const;
      const values: number[] = [];
      for (const [headName, outcomeOf, flowLabel] of parts) {
        const outcome = daysFromTurnover(outcomeOf, input, notes, flowLabel);
        if (outcome.reason !== undefined) {
          return { reason: `${headName}: ${outcome.reason}` };
        }
        values.push(outcome.valueOverride as number);
      }
      return { valueOverride: values[0]! + values[1]! - values[2]! };
    },
  },
);

// ---------------------------------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------------------------------

export const accrualRatio: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'accrualRatio',
  category: 'quality',
  formula: '(netIncome - operatingCashFlow) / average totalAssets',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const denominator = averageBalance(
      input.current!,
      input.prior!,
      'totalAssets',
      'totalAssets',
      notes,
    )!;
    return {
      numerator: {
        label: 'netIncome - operatingCashFlow',
        amount: input.current!.income.netIncome - input.current!.cashFlow.operatingCashFlow,
      },
      denominator,
    };
  },
});

export const cashFlowToNetIncome: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'cashFlowToNetIncome',
    category: 'quality',
    formula: 'operatingCashFlow / netIncome',
    keys: ['statements'],
    compute(input): RatioOutcome {
      const statements = input.statements!;
      return {
        numerator: { label: 'operatingCashFlow', amount: statements.cashFlow.operatingCashFlow },
        denominator: { label: 'netIncome', amount: statements.income.netIncome },
      };
    },
  });

export const cashReturnOnAssets: RatioFacade<PairRatioInput> = makeRatio<PairRatioInput>({
  ratioName: 'cashReturnOnAssets',
  category: 'quality',
  formula: 'operatingCashFlow / average totalAssets',
  keys: ['current', 'prior'],
  compute(input, notes): RatioOutcome {
    const denominator = averageBalance(
      input.current!,
      input.prior!,
      'totalAssets',
      'totalAssets',
      notes,
    )!;
    return {
      numerator: {
        label: 'operatingCashFlow',
        amount: input.current!.cashFlow.operatingCashFlow,
      },
      denominator,
    };
  },
});

// ---------------------------------------------------------------------------------------------------
// Per-share (diluted, split-adjusted shares for the period)
// ---------------------------------------------------------------------------------------------------

function perShare(
  numeratorLabel: string,
  amount: number,
  input: RatioInput,
  notes: string[],
): RatioOutcome {
  const shares = input.statements!.income.dilutedSharesOutstanding;
  if (shares === undefined || shares <= 0) {
    return {
      reason:
        'income.dilutedSharesOutstanding must be present and > 0 — per-share metrics require split-adjusted diluted shares for the period',
    };
  }
  // Absolute currency per share — a share count is a count, so the amount alone carries the scale.
  return {
    numerator: { label: numeratorLabel, amount: absoluteAmount(input.statements!, amount, notes) },
    denominator: { label: 'dilutedSharesOutstanding', amount: shares },
  };
}

export const earningsPerShare: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'earningsPerShare',
    category: 'per-share',
    formula: 'netIncome / dilutedSharesOutstanding',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      return perShare('netIncome', input.statements!.income.netIncome, input, notes);
    },
  });

export const bookValuePerShare: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'bookValuePerShare',
    category: 'per-share',
    formula: 'totalEquity / dilutedSharesOutstanding',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      return perShare('totalEquity', input.statements!.balance.totalEquity, input, notes);
    },
  });

export const revenuePerShare: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'revenuePerShare',
    category: 'per-share',
    formula: 'revenue / dilutedSharesOutstanding',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      return perShare('revenue', input.statements!.income.revenue, input, notes);
    },
  });

export const freeCashFlowPerShare: RatioFacade<SingleStatementRatioInput> =
  makeRatio<SingleStatementRatioInput>({
    ratioName: 'freeCashFlowPerShare',
    category: 'per-share',
    formula: '(operatingCashFlow - capitalExpenditure) / dilutedSharesOutstanding',
    keys: ['statements'],
    compute(input, notes): RatioOutcome {
      const cashFlow = input.statements!.cashFlow;
      if (cashFlow.capitalExpenditure === undefined) {
        return { reason: 'capitalExpenditure is absent — free cash flow cannot be formed' };
      }
      return perShare(
        'operatingCashFlow - capitalExpenditure',
        cashFlow.operatingCashFlow - cashFlow.capitalExpenditure,
        input,
        notes,
      );
    },
  });

// ---------------------------------------------------------------------------------------------------
// Valuation multiples (market observation + the point-in-time law)
// ---------------------------------------------------------------------------------------------------

const MULTIPLE_KEYS = ['statements', 'marketObservation', 'maximumStalenessMs'] as const;
const ENTERPRISE_KEYS = [...MULTIPLE_KEYS, 'nonOperatingAssets'] as const;

export const priceToEarnings: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'priceToEarnings',
    category: 'valuation',
    formula: 'sharePrice / (netIncome / dilutedSharesOutstanding)',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      const income = input.statements!.income;
      const shares = income.dilutedSharesOutstanding;
      if (shares === undefined || shares <= 0) {
        return {
          reason:
            'income.dilutedSharesOutstanding must be present and > 0 for a per-share multiple',
        };
      }
      if (income.netIncome <= 0) {
        return {
          reason: 'netIncome is not positive — a price-to-earnings multiple is not meaningful',
        };
      }
      return {
        numerator: { label: 'sharePrice', amount: input.marketObservation!.sharePrice },
        denominator: {
          label: 'earnings per share',
          amount: absoluteAmount(input.statements!, income.netIncome, notes) / shares,
        },
      };
    },
  });

export const priceToBook: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'priceToBook',
    category: 'valuation',
    formula: 'marketCapitalization / totalEquity',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      const equity = input.statements!.balance.totalEquity;
      if (equity <= 0) {
        return {
          reason: 'totalEquity is not positive — a price-to-book multiple is not meaningful',
        };
      }
      return {
        numerator: {
          label: 'marketCapitalization',
          amount: resolveMarketCapitalization(input.marketObservation!, notes),
        },
        denominator: {
          label: 'totalEquity',
          amount: absoluteAmount(input.statements!, equity, notes),
        },
      };
    },
  });

export const priceToSales: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'priceToSales',
    category: 'valuation',
    formula: 'marketCapitalization / revenue',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      return {
        numerator: {
          label: 'marketCapitalization',
          amount: resolveMarketCapitalization(input.marketObservation!, notes),
        },
        denominator: {
          label: 'revenue',
          amount: absoluteAmount(input.statements!, input.statements!.income.revenue, notes),
        },
      };
    },
  });

export const enterpriseValueToRevenue: RatioFacade<EnterpriseMultipleRatioInput> =
  makeRatio<EnterpriseMultipleRatioInput>({
    ratioName: 'enterpriseValueToRevenue',
    category: 'valuation',
    formula: 'enterprise value / revenue',
    keys: ENTERPRISE_KEYS,
    compute(input, notes): RatioOutcome {
      const marketCapitalization = resolveMarketCapitalization(input.marketObservation!, notes);
      const enterprise = resolveEnterpriseValue(
        input.statements!,
        marketCapitalization,
        input.nonOperatingAssets,
        resolveTotalDebt,
        notes,
      );
      if ('reason' in enterprise) return { reason: enterprise.reason };
      return {
        numerator: { label: 'enterprise value', amount: enterprise.amount },
        denominator: {
          label: 'revenue',
          amount: absoluteAmount(input.statements!, input.statements!.income.revenue, notes),
        },
      };
    },
  });

export const enterpriseValueToEbitda: RatioFacade<EnterpriseMultipleRatioInput> =
  makeRatio<EnterpriseMultipleRatioInput>({
    ratioName: 'enterpriseValueToEbitda',
    category: 'valuation',
    formula: 'enterprise value / EBITDA',
    keys: ENTERPRISE_KEYS,
    compute(input, notes): RatioOutcome {
      const marketCapitalization = resolveMarketCapitalization(input.marketObservation!, notes);
      const enterprise = resolveEnterpriseValue(
        input.statements!,
        marketCapitalization,
        input.nonOperatingAssets,
        resolveTotalDebt,
        notes,
      );
      if ('reason' in enterprise) return { reason: enterprise.reason };
      const ebitda = resolveEbitda(input.statements!, notes);
      if (ebitda === null) {
        return { reason: 'depreciationAndAmortization is absent — EBITDA cannot be formed' };
      }
      return {
        numerator: { label: 'enterprise value', amount: enterprise.amount },
        denominator: {
          label: 'EBITDA',
          amount: absoluteAmount(input.statements!, ebitda.amount, notes),
        },
      };
    },
  });

export const freeCashFlowYield: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'freeCashFlowYield',
    category: 'valuation',
    formula: '(operatingCashFlow - capitalExpenditure) / marketCapitalization',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      const cashFlow = input.statements!.cashFlow;
      if (cashFlow.capitalExpenditure === undefined) {
        return { reason: 'capitalExpenditure is absent — free cash flow cannot be formed' };
      }
      return {
        numerator: {
          label: 'free cash flow',
          amount: absoluteAmount(
            input.statements!,
            cashFlow.operatingCashFlow - cashFlow.capitalExpenditure,
            notes,
          ),
        },
        denominator: {
          label: 'marketCapitalization',
          amount: resolveMarketCapitalization(input.marketObservation!, notes),
        },
      };
    },
  });

export const earningsYield: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'earningsYield',
    category: 'valuation',
    formula: 'netIncome / marketCapitalization',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      return {
        numerator: {
          label: 'netIncome',
          amount: absoluteAmount(input.statements!, input.statements!.income.netIncome, notes),
        },
        denominator: {
          label: 'marketCapitalization',
          amount: resolveMarketCapitalization(input.marketObservation!, notes),
        },
      };
    },
  });

export const dividendYield: RatioFacade<MarketMultipleRatioInput> =
  makeRatio<MarketMultipleRatioInput>({
    ratioName: 'dividendYield',
    category: 'valuation',
    formula: 'dividendsPaid (trailing, from the cash-flow statement) / marketCapitalization',
    keys: MULTIPLE_KEYS,
    compute(input, notes): RatioOutcome {
      const dividends = input.statements!.cashFlow.dividendsPaid;
      if (dividends === undefined) {
        return {
          reason: 'dividendsPaid is absent — a dividend yield needs the cash actually paid',
        };
      }
      return {
        numerator: {
          label: 'dividendsPaid',
          amount: absoluteAmount(input.statements!, dividends, notes),
        },
        denominator: {
          label: 'marketCapitalization',
          amount: resolveMarketCapitalization(input.marketObservation!, notes),
        },
      };
    },
  });
