/**
 * FC2 — the composite scores: Piotroski F, Altman Z (three published variants), and the Beneish
 * M-score (the original eight-variable 1999 model — no silent five-variable fallback). Each score
 * follows its PAPER's definitions, which are not always this library's ratio defaults; where they
 * differ (Piotroski's beginning-assets return, Beneish's debt definition) the difference is stated
 * here and echoed in the result.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type FinancialStatements,
  requireFinancialStatements,
  resolveGrossProfit,
} from './statement-contracts.js';

function requireConsecutive(
  functionName: string,
  pairs: ReadonlyArray<readonly [string, FinancialStatements, string, FinancialStatements]>,
): void {
  for (const [laterLabel, later, earlierLabel, earlier] of pairs) {
    if (earlier.income.period.periodEndDate >= later.income.period.periodEndDate) {
      throw new InputError(
        `${functionName}: ${earlierLabel} must END BEFORE ${laterLabel} — received ${earlierLabel} ending ${earlier.income.period.periodEndDate} against ${laterLabel} ending ${later.income.period.periodEndDate}.`,
        { code: ErrorCode.InputWrongShape, context: { field: earlierLabel } },
      );
    }
    const a = later.income.period;
    const b = earlier.income.period;
    if (a.currency !== b.currency || a.monetaryScale !== b.monetaryScale) {
      throw new InputError(
        `${functionName}: ${laterLabel} and ${earlierLabel} must share one currency and monetary scale — received ${a.currency}@${a.monetaryScale} against ${b.currency}@${b.monetaryScale}.`,
        { code: ErrorCode.InputWrongShape, context: { field: earlierLabel } },
      );
    }
  }
}

/** A statement line the score's model REQUIRES; absence is an error naming it, never a proxy. */
function demand(
  functionName: string,
  owner: string,
  value: number | undefined,
  field: string,
): number {
  if (value === undefined) {
    throw new InputError(
      `${functionName}: ${owner}.${field} is required by this model and is absent — the model runs on its published variables or not at all.`,
      { code: ErrorCode.InputMissingField, context: { field: `${owner}.${field}` } },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------
// Piotroski F-score
// ---------------------------------------------------------------------------------------------------

/** Input for {@link piotroskiFScore}: three consecutive periods of one entity. */
export interface PiotroskiInput {
  current: FinancialStatements;
  prior: FinancialStatements;
  /**
   * The period before `prior`. Needed because the paper's return and turnover use BEGINNING
   * assets, so the prior year's own signal needs the balance sheet one further back.
   */
  priorPrior: FinancialStatements;
}

/** One of the nine binary signals. */
export interface PiotroskiSignal {
  signal: string;
  /** 1 or 0 per the paper; `null` with `reason` when an optional statement line is absent. */
  value: 0 | 1 | null;
  detail: string;
  reason?: string;
}

/** Result of {@link piotroskiFScore}. */
export interface PiotroskiResult {
  assumptions: {
    /** The published model name (a label, deliberately not a literal type). */
    model: string;
    /** Returns and turnover use BEGINNING total assets, per the paper. */
    returnBasis: 'beginning total assets';
  };
  diagnostics: {
    /** One warning per unevaluable signal. */
    warnings: string[];
  };
  /** Sum of the evaluable signals (each 0 or 1). */
  fScore: number;
  /** How many of the nine signals could be evaluated; 9 when every input line was present. */
  evaluableSignals: number;
  signals: PiotroskiSignal[];
}

/**
 * The standard nine binary signals, per the paper: profitability (return on beginning assets,
 * operating cash flow, their improvement, accruals), leverage/liquidity/funding (falling
 * long-term-debt ratio, improving current ratio, no net share issuance), and efficiency
 * (improving gross margin, improving beginning-assets turnover). Each signal is reported, not
 * only the total; a signal whose statement line is absent reports `null` with the reason and is
 * excluded from `fScore` — never guessed to 0 or 1.
 */
export function piotroskiFScore(input: PiotroskiInput): PiotroskiResult {
  requireArgumentObject('piotroskiFScore', 'input', input);
  ensureKnownKeys('piotroskiFScore', 'input', input, ['current', 'prior', 'priorPrior']);
  for (const field of ['current', 'prior', 'priorPrior'] as const) {
    if (input[field] === undefined) {
      throw new InputError(
        `piotroskiFScore: ${field} is required — the paper's beginning-assets return makes the prior year's signal need the balance sheet one further back.\n  e.g. piotroskiFScore({ current, prior, priorPrior })`,
        { code: ErrorCode.InputMissingField, context: { field } },
      );
    }
    requireFinancialStatements('piotroskiFScore', input[field]);
  }
  requireConsecutive('piotroskiFScore', [
    ['current', input.current, 'prior', input.prior],
    ['prior', input.prior, 'priorPrior', input.priorPrior],
  ]);

  const { current, prior, priorPrior } = input;
  const signals: PiotroskiSignal[] = [];
  const binary = (condition: boolean): 0 | 1 => (condition ? 1 : 0);

  const returnOnBeginningAssets = (
    period: FinancialStatements,
    beginning: FinancialStatements,
  ): number => period.income.netIncome / beginning.balance.totalAssets;
  const currentReturn = returnOnBeginningAssets(current, prior);
  const priorReturn = returnOnBeginningAssets(prior, priorPrior);

  signals.push({
    signal: 'positive return on assets',
    value: binary(currentReturn > 0),
    detail: `netIncome / beginning totalAssets = ${currentReturn.toFixed(6)}`,
  });
  signals.push({
    signal: 'positive operating cash flow',
    value: binary(current.cashFlow.operatingCashFlow > 0),
    detail: `operatingCashFlow = ${current.cashFlow.operatingCashFlow}`,
  });
  signals.push({
    signal: 'improving return on assets',
    value: binary(currentReturn > priorReturn),
    detail: `${currentReturn.toFixed(6)} vs prior ${priorReturn.toFixed(6)}`,
  });
  signals.push({
    signal: 'operating cash flow greater than net income',
    value: binary(current.cashFlow.operatingCashFlow > current.income.netIncome),
    detail: `${current.cashFlow.operatingCashFlow} vs netIncome ${current.income.netIncome}`,
  });

  const longTermDebtRatio = (
    period: FinancialStatements,
    beginning: FinancialStatements,
  ): number | null => {
    if (period.balance.longTermDebt === undefined) return null;
    const averageAssets = (beginning.balance.totalAssets + period.balance.totalAssets) / 2;
    return period.balance.longTermDebt / averageAssets;
  };
  const currentLeverage = longTermDebtRatio(current, prior);
  const priorLeverage = longTermDebtRatio(prior, priorPrior);
  signals.push(
    currentLeverage === null || priorLeverage === null
      ? {
          signal: 'falling long-term-debt ratio',
          value: null,
          detail: 'longTermDebt / average totalAssets, current vs prior',
          reason: 'longTermDebt is absent in one period',
        }
      : {
          signal: 'falling long-term-debt ratio',
          value: binary(currentLeverage <= priorLeverage),
          detail: `${currentLeverage.toFixed(6)} vs prior ${priorLeverage.toFixed(6)}`,
        },
  );

  const currentRatioOf = (period: FinancialStatements): number | null => {
    const balance = period.balance;
    if (balance.currentAssets === undefined || balance.currentLiabilities === undefined)
      return null;
    if (balance.currentLiabilities === 0) return null;
    return balance.currentAssets / balance.currentLiabilities;
  };
  const liquidityNow = currentRatioOf(current);
  const liquidityPrior = currentRatioOf(prior);
  signals.push(
    liquidityNow === null || liquidityPrior === null
      ? {
          signal: 'improving current ratio',
          value: null,
          detail: 'currentAssets / currentLiabilities, current vs prior',
          reason: 'currentAssets or currentLiabilities is absent (or zero) in one period',
        }
      : {
          signal: 'improving current ratio',
          value: binary(liquidityNow > liquidityPrior),
          detail: `${liquidityNow.toFixed(6)} vs prior ${liquidityPrior.toFixed(6)}`,
        },
  );

  const sharesNow = current.income.dilutedSharesOutstanding;
  const sharesPrior = prior.income.dilutedSharesOutstanding;
  signals.push(
    sharesNow === undefined || sharesPrior === undefined
      ? {
          signal: 'no net share issuance',
          value: null,
          detail: 'dilutedSharesOutstanding, current vs prior',
          reason: 'dilutedSharesOutstanding is absent in one period',
        }
      : {
          signal: 'no net share issuance',
          value: binary(sharesNow <= sharesPrior),
          detail: `${sharesNow} vs prior ${sharesPrior}`,
        },
  );

  const marginOf = (period: FinancialStatements): number | null => {
    const { grossProfit } = resolveGrossProfit(period.income);
    if (grossProfit === null || period.income.revenue === 0) return null;
    return grossProfit / period.income.revenue;
  };
  const marginNow = marginOf(current);
  const marginPrior = marginOf(prior);
  signals.push(
    marginNow === null || marginPrior === null
      ? {
          signal: 'improving gross margin',
          value: null,
          detail: 'grossProfit / revenue, current vs prior',
          reason: 'gross profit cannot be formed (or revenue is zero) in one period',
        }
      : {
          signal: 'improving gross margin',
          value: binary(marginNow > marginPrior),
          detail: `${marginNow.toFixed(6)} vs prior ${marginPrior.toFixed(6)}`,
        },
  );

  const turnoverNow = current.income.revenue / prior.balance.totalAssets;
  const turnoverPrior = prior.income.revenue / priorPrior.balance.totalAssets;
  signals.push({
    signal: 'improving asset turnover',
    value: binary(turnoverNow > turnoverPrior),
    detail: `revenue / beginning totalAssets: ${turnoverNow.toFixed(6)} vs prior ${turnoverPrior.toFixed(6)}`,
  });

  const evaluable = signals.filter((signal) => signal.value !== null);
  return {
    assumptions: {
      model: 'Piotroski F-Score (Piotroski 2000)',
      returnBasis: 'beginning total assets',
    },
    diagnostics: {
      warnings: signals
        .filter((signal) => signal.value === null)
        .map((signal) => `${signal.signal}: ${signal.reason ?? 'not evaluable'}`),
    },
    fScore: evaluable.reduce((total, signal) => total + (signal.value as number), 0),
    evaluableSignals: evaluable.length,
    signals,
  };
}

// ---------------------------------------------------------------------------------------------------
// Altman Z-score
// ---------------------------------------------------------------------------------------------------

/** The published Altman variants; each fixes its coefficients and its equity basis. */
export type AltmanVariant = 'public-manufacturing' | 'private-manufacturing' | 'non-manufacturing';

/** Input for {@link altmanZScore}. */
export interface AltmanInput {
  statements: FinancialStatements;
  variant: AltmanVariant;
  /** REQUIRED for `public-manufacturing` (its X4 uses market equity); rejected otherwise. */
  marketEquity?: number;
}

/** One Altman component. */
export interface AltmanComponent {
  component: 'X1' | 'X2' | 'X3' | 'X4' | 'X5';
  definition: string;
  value: number;
  coefficient: number;
  contribution: number;
}

/** Result of {@link altmanZScore}. */
export interface AltmanResult {
  assumptions: {
    /** The published model name (a label, deliberately not a literal type). */
    model: string;
    variant: AltmanVariant;
    equityBasis: 'market' | 'book';
  };
  diagnostics: { warnings: string[] };
  zScore: number;
  variant: AltmanVariant;
  components: AltmanComponent[];
}

const ALTMAN_COEFFICIENTS: Record<
  AltmanVariant,
  Partial<Record<'X1' | 'X2' | 'X3' | 'X4' | 'X5', number>>
> = {
  'public-manufacturing': { X1: 1.2, X2: 1.4, X3: 3.3, X4: 0.6, X5: 1.0 },
  'private-manufacturing': { X1: 0.717, X2: 0.847, X3: 3.107, X4: 0.42, X5: 0.998 },
  'non-manufacturing': { X1: 6.56, X2: 3.26, X3: 6.72, X4: 1.05 },
};

/**
 * The Altman Z-score with the published coefficients and denominator definitions per variant.
 * `X1` working capital / assets, `X2` retained earnings / assets, `X3` operating income / assets,
 * `X4` the variant's equity basis / total liabilities, `X5` sales / assets where the variant has
 * one. The variant is REQUIRED — there is no default bankruptcy model.
 */
export function altmanZScore(input: AltmanInput): AltmanResult {
  requireArgumentObject('altmanZScore', 'input', input);
  ensureKnownKeys('altmanZScore', 'input', input, ['statements', 'variant', 'marketEquity']);
  if (input.statements === undefined) {
    throw new InputError(`altmanZScore: statements is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'statements' },
    });
  }
  requireFinancialStatements('altmanZScore', input.statements);
  if (
    input.variant !== 'public-manufacturing' &&
    input.variant !== 'private-manufacturing' &&
    input.variant !== 'non-manufacturing'
  ) {
    throw new InputError(
      `altmanZScore: variant must be 'public-manufacturing' | 'private-manufacturing' | 'non-manufacturing' — the model is explicit, never defaulted. Received ${input.variant === null ? 'null' : JSON.stringify(input.variant)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'variant' } },
    );
  }
  if (input.variant === 'public-manufacturing') {
    if (
      input.marketEquity === undefined ||
      typeof input.marketEquity !== 'number' ||
      !Number.isFinite(input.marketEquity) ||
      input.marketEquity <= 0
    ) {
      throw new InputError(
        `altmanZScore: marketEquity (a finite amount > 0) is required for the public-manufacturing variant — its X4 uses MARKET equity over total liabilities.`,
        {
          code:
            input.marketEquity === undefined
              ? ErrorCode.InputMissingField
              : ErrorCode.InputOutOfRange,
          context: { field: 'marketEquity' },
        },
      );
    }
  } else if (input.marketEquity !== undefined) {
    throw new InputError(
      `altmanZScore: marketEquity applies only to the public-manufacturing variant — the ${input.variant} X4 uses BOOK equity, and accepting both would let them disagree silently.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'marketEquity' } },
    );
  }

  const { balance, income } = input.statements;
  const assets = balance.totalAssets;
  if (assets <= 0) {
    throw new InputError(
      `altmanZScore: totalAssets must be positive — every Altman component is scaled by assets. Received ${assets}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'statements.balance.totalAssets' } },
    );
  }
  if (balance.totalLiabilities <= 0) {
    throw new InputError(
      `altmanZScore: totalLiabilities must be positive — X4 divides by it. Received ${balance.totalLiabilities}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'statements.balance.totalLiabilities' },
      },
    );
  }
  const currentAssets = demand(
    'altmanZScore',
    'statements.balance',
    balance.currentAssets,
    'currentAssets',
  );
  const currentLiabilities = demand(
    'altmanZScore',
    'statements.balance',
    balance.currentLiabilities,
    'currentLiabilities',
  );
  const retainedEarnings = demand(
    'altmanZScore',
    'statements.balance',
    balance.retainedEarnings,
    'retainedEarnings',
  );

  const equityBasis =
    input.variant === 'public-manufacturing' ? input.marketEquity! : balance.totalEquity;
  const coefficients = ALTMAN_COEFFICIENTS[input.variant];
  const values: Record<string, [string, number]> = {
    X1: ['working capital / totalAssets', (currentAssets - currentLiabilities) / assets],
    X2: ['retainedEarnings / totalAssets', retainedEarnings / assets],
    X3: ['operatingIncome / totalAssets', income.operatingIncome / assets],
    X4: [
      `${input.variant === 'public-manufacturing' ? 'market' : 'book'} equity / totalLiabilities`,
      equityBasis / balance.totalLiabilities,
    ],
    X5: ['revenue / totalAssets', income.revenue / assets],
  };
  const components: AltmanComponent[] = [];
  let zScore = 0;
  for (const component of ['X1', 'X2', 'X3', 'X4', 'X5'] as const) {
    const coefficient = coefficients[component];
    if (coefficient === undefined) continue; // non-manufacturing has no sales/assets term
    const [definition, value] = values[component]!;
    const contribution = coefficient * value;
    zScore += contribution;
    components.push({ component, definition, value, coefficient, contribution });
  }
  return requireRepresentableResult('altmanZScore', {
    assumptions: {
      model: 'Altman Z-Score',
      variant: input.variant,
      equityBasis: input.variant === 'public-manufacturing' ? 'market' : 'book',
    },
    diagnostics: { warnings: [] },
    zScore,
    variant: input.variant,
    components,
  });
}

// ---------------------------------------------------------------------------------------------------
// Beneish M-score
// ---------------------------------------------------------------------------------------------------

/** Input for {@link beneishMScore}: two consecutive periods. */
export interface BeneishInput {
  current: FinancialStatements;
  prior: FinancialStatements;
}

/** One Beneish component index. */
export interface BeneishComponent {
  index: 'DSRI' | 'GMI' | 'AQI' | 'SGI' | 'DEPI' | 'SGAI' | 'LVGI' | 'TATA';
  expandedName: string;
  value: number;
  coefficient: number;
  contribution: number;
  currentPeriodEndDate: string;
  priorPeriodEndDate: string;
}

/** Result of {@link beneishMScore}. */
export interface BeneishResult {
  assumptions: {
    /** The published model name (a label, deliberately not a literal type). */
    model: string;
  };
  diagnostics: {
    /** Conventions the inputs forced (e.g. D&A standing in for pure depreciation) — disclosed. */
    warnings: string[];
  };
  mScore: number;
  components: BeneishComponent[];
  /** The same disclosures as `diagnostics.warnings` (kept for direct reading). */
  notes: string[];
}

/**
 * The original eight-variable 1999 Beneish equation
 * `-4.84 + 0.920 DSRI + 0.528 GMI + 0.404 AQI + 0.892 SGI + 0.115 DEPI - 0.172 SGAI + 4.679 TATA
 * - 0.327 LVGI`, with the component definitions fixed to the paper. Every variable the model needs
 * must be present in both periods — there is NO five-variable fallback, silent or otherwise.
 */
export function beneishMScore(input: BeneishInput): BeneishResult {
  requireArgumentObject('beneishMScore', 'input', input);
  ensureKnownKeys('beneishMScore', 'input', input, ['current', 'prior']);
  for (const field of ['current', 'prior'] as const) {
    if (input[field] === undefined) {
      throw new InputError(
        `beneishMScore: ${field} is required.\n  e.g. beneishMScore({ current, prior })`,
        { code: ErrorCode.InputMissingField, context: { field } },
      );
    }
    requireFinancialStatements('beneishMScore', input[field]);
  }
  requireConsecutive('beneishMScore', [['current', input.current, 'prior', input.prior]]);

  const notes: string[] = [];
  const line = (
    period: FinancialStatements,
    owner: 'current' | 'prior',
  ): {
    sales: number;
    receivables: number;
    costOfRevenue: number;
    currentAssets: number;
    propertyPlantEquipment: number;
    totalAssets: number;
    depreciation: number;
    sellingGeneralAdministrative: number;
    longTermDebt: number;
    currentLiabilities: number;
    operatingCashFlow: number;
    income: number;
  } => {
    const sales = period.income.revenue;
    if (sales === 0) {
      throw new InputError(
        `beneishMScore: ${owner}.income.revenue is zero — four of the eight indices divide by sales.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${owner}.income.revenue` } },
      );
    }
    let income = period.income.incomeFromContinuingOperations;
    if (income === undefined) {
      income = period.income.netIncome;
      if (owner === 'current') {
        notes.push(
          'incomeFromContinuingOperations absent — TATA uses netIncome (disclosed substitution, same equation)',
        );
      }
    }
    return {
      sales,
      receivables: demand(
        'beneishMScore',
        `${owner}.balance`,
        period.balance.accountsReceivable,
        'accountsReceivable',
      ),
      costOfRevenue: demand(
        'beneishMScore',
        `${owner}.income`,
        period.income.costOfRevenue,
        'costOfRevenue',
      ),
      currentAssets: demand(
        'beneishMScore',
        `${owner}.balance`,
        period.balance.currentAssets,
        'currentAssets',
      ),
      propertyPlantEquipment: demand(
        'beneishMScore',
        `${owner}.balance`,
        period.balance.propertyPlantEquipmentNet,
        'propertyPlantEquipmentNet',
      ),
      totalAssets: period.balance.totalAssets,
      depreciation: demand(
        'beneishMScore',
        `${owner}.cashFlow`,
        period.cashFlow.depreciationAndAmortization,
        'depreciationAndAmortization',
      ),
      sellingGeneralAdministrative: demand(
        'beneishMScore',
        `${owner}.income`,
        period.income.sellingGeneralAdministrativeExpense,
        'sellingGeneralAdministrativeExpense',
      ),
      longTermDebt: demand(
        'beneishMScore',
        `${owner}.balance`,
        period.balance.longTermDebt,
        'longTermDebt',
      ),
      currentLiabilities: demand(
        'beneishMScore',
        `${owner}.balance`,
        period.balance.currentLiabilities,
        'currentLiabilities',
      ),
      operatingCashFlow: period.cashFlow.operatingCashFlow,
      income,
    };
  };
  const now = line(input.current, 'current');
  const then = line(input.prior, 'prior');
  notes.push(
    'depreciationAndAmortization stands in for pure depreciation in DEPI (disclosed convention)',
  );

  const grossMarginOf = (row: typeof now): number => (row.sales - row.costOfRevenue) / row.sales;
  const softAssetShare = (row: typeof now): number =>
    1 - (row.currentAssets + row.propertyPlantEquipment) / row.totalAssets;
  const depreciationRate = (row: typeof now): number =>
    row.depreciation / (row.depreciation + row.propertyPlantEquipment);
  const leverage = (row: typeof now): number =>
    (row.longTermDebt + row.currentLiabilities) / row.totalAssets;

  const indices: Array<[BeneishComponent['index'], string, number, number]> = [
    [
      'DSRI',
      'days-sales-in-receivables index',
      now.receivables / now.sales / (then.receivables / then.sales),
      0.92,
    ],
    ['GMI', 'gross-margin index', grossMarginOf(then) / grossMarginOf(now), 0.528],
    ['AQI', 'asset-quality index', softAssetShare(now) / softAssetShare(then), 0.404],
    ['SGI', 'sales-growth index', now.sales / then.sales, 0.892],
    ['DEPI', 'depreciation index', depreciationRate(then) / depreciationRate(now), 0.115],
    [
      'SGAI',
      'selling/general/administrative-expense index',
      now.sellingGeneralAdministrative /
        now.sales /
        (then.sellingGeneralAdministrative / then.sales),
      -0.172,
    ],
    [
      'TATA',
      'total accruals to total assets',
      (now.income - now.operatingCashFlow) / now.totalAssets,
      4.679,
    ],
    ['LVGI', 'leverage index', leverage(now) / leverage(then), -0.327],
  ];
  const currentEnd = input.current.income.period.periodEndDate;
  const priorEnd = input.prior.income.period.periodEndDate;
  const components: BeneishComponent[] = indices.map(
    ([index, expandedName, value, coefficient]) => ({
      index,
      expandedName,
      value,
      coefficient,
      contribution: coefficient * value,
      currentPeriodEndDate: currentEnd,
      priorPeriodEndDate: priorEnd,
    }),
  );
  const mScore = -4.84 + components.reduce((total, component) => total + component.contribution, 0);
  return requireRepresentableResult('beneishMScore', {
    assumptions: { model: 'Beneish M-Score (Beneish 1999, eight-variable)' },
    diagnostics: { warnings: [...notes] },
    mScore,
    components,
    notes,
  });
}
