/**
 * FC2 — leveraged buyout analysis.
 *
 * Required semantics (spec, frozen): the analysis accepts EXPLICIT sources/uses, debt tranches
 * with rates and amortization/cash-sweep policy, an operating forecast, fees, taxes, the holding
 * period, and exit assumptions. It returns the annual debt/cash schedule, the exit bridge, the
 * sponsor's equity cash flows, the multiple on invested capital, and the IRR — composing the FC1
 * solver (`internalRateOfReturn`) rather than owning a root finder. Sources MUST equal uses; a
 * structure that does not balance is refused with both sides stated.
 *
 * DISCLOSED simplifications (also echoed in `assumptions.disclosedSimplifications`):
 * - taxable income is EBITDA − interest. Depreciation and amortization are deliberately out of
 *   scope, so their tax shields are NOT modeled;
 * - taxes = max(0, taxable income) × taxRate — no loss carryforward;
 * - the cash sweep applies only to positive post-mandatory-amortization free cash flow; there is
 *   no revolver, so a year whose cash balance would go negative is refused, never silently funded;
 * - accumulated cash (including `cashToBalanceSheet` funded at close) earns no interest income and
 *   returns to the sponsor at exit through the net-debt bridge; and
 * - no interim dividends (v1): the sponsor's flows are −equity at year 0 and +proceeds at exit.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { type TimedCashFlow } from './flows.js';
import { internalRateOfReturn } from './solvers.js';

/** The uses side of the entry: what the purchase consumes. All explicit. */
export interface LeveragedBuyoutTransactionInput {
  /** Enterprise value paid for the target (> 0). */
  purchaseEnterpriseValue: number;
  /** Advisory/financing fees paid at close (≥ 0). */
  transactionFees: number;
  /** Cash funded onto the opening balance sheet at close (≥ 0). */
  cashToBalanceSheet: number;
}

/** One debt tranche in the capital structure. */
export interface LeveragedBuyoutDebtTrancheInput {
  trancheName: string;
  /** Amount drawn at close (> 0). */
  principal: number;
  /** Annual interest rate (decimal) on the beginning-of-year balance. */
  annualInterestRate: number;
  /** Fraction of the ORIGINAL principal repaid per year (0 ≤ f ≤ 1), capped at the balance. */
  mandatoryAmortizationFraction: number;
  /** Sweep order: 1 is repaid first. Distinct positive integers across tranches. */
  cashSweepPriority: number;
}

/** The sources side of the entry: who funds the purchase. */
export interface LeveragedBuyoutSourcesInput {
  /** The sponsor's equity check (> 0). */
  sponsorEquity: number;
  /** May be empty — an explicit all-equity structure. */
  tranches: readonly LeveragedBuyoutDebtTrancheInput[];
}

/** One forecast year. Years are 1..N consecutive from the close. */
export interface LeveragedBuyoutOperatingYearInput {
  year: number;
  ebitda: number;
  capitalExpenditure: number;
  increaseInNetWorkingCapital: number;
  /** Marginal cash tax rate for the year (0 ≤ t ≤ 1). */
  taxRate: number;
}

/** Exit assumptions. `year` must equal the last forecast year. */
export interface LeveragedBuyoutExitInput {
  year: number;
  /** Exit enterprise value = exit-year EBITDA × this multiple (> 0). */
  exitEbitdaMultiple: number;
  /** Fees paid on exit (≥ 0), deducted from equity proceeds. */
  exitFees: number;
}

/** Input for {@link leveragedBuyoutAnalysis}. */
export interface LeveragedBuyoutAnalysisInput {
  transaction: LeveragedBuyoutTransactionInput;
  sources: LeveragedBuyoutSourcesInput;
  operatingForecast: readonly LeveragedBuyoutOperatingYearInput[];
  /** Fraction (0 ≤ f ≤ 1) of positive post-mandatory-amortization FCF swept to debt each year. */
  cashSweepFraction: number;
  exit: LeveragedBuyoutExitInput;
}

/** Both sides of the entry, itemized — the "sources equal uses" law made inspectable. */
export interface LeveragedBuyoutSourcesAndUses {
  sources: {
    sponsorEquity: number;
    tranches: { trancheName: string; principal: number }[];
    totalSources: number;
  };
  uses: {
    purchaseEnterpriseValue: number;
    transactionFees: number;
    cashToBalanceSheet: number;
    totalUses: number;
  };
}

/** One tranche-year of the debt schedule. Closing law: ending = beginning − mandatory − sweep. */
export interface LeveragedBuyoutDebtScheduleRow {
  year: number;
  trancheName: string;
  beginningBalance: number;
  interest: number;
  mandatoryAmortization: number;
  cashSweep: number;
  endingBalance: number;
}

/** One year of the annual schedule: the operating totals plus every tranche's row. */
export interface LeveragedBuyoutAnnualScheduleRow {
  year: number;
  ebitda: number;
  /** Total interest across tranches, on beginning-of-year balances. */
  interest: number;
  taxes: number;
  /** EBITDA − taxes − capitalExpenditure − increaseInNetWorkingCapital − interest. */
  freeCashFlow: number;
  /** Total swept to debt this year (mandatory amortization is reported per tranche). */
  cashSweptToDebt: number;
  /** The cumulative cash balance at year end. */
  cashAccumulated: number;
  /** Per-tranche detail, in input order. */
  trancheRows: LeveragedBuyoutDebtScheduleRow[];
}

/** The walk from exit enterprise value to sponsor proceeds. */
export interface LeveragedBuyoutExitBridge {
  exitEbitda: number;
  exitEbitdaMultiple: number;
  enterpriseValue: number;
  /** Σ ending debt balances − accumulated cash, at the exit year. */
  netDebtAtExit: number;
  exitFees: number;
  /** `enterpriseValue − netDebtAtExit − exitFees`. */
  equityProceeds: number;
}

/** Result of {@link leveragedBuyoutAnalysis}. */
export interface LeveragedBuyoutAnalysisResult {
  diagnostics: {
    /** The disclosed simplifications, surfaced in the one grammar every analysis shares. */
    warnings: string[];
  };
  sourcesAndUses: LeveragedBuyoutSourcesAndUses;
  annualSchedule: LeveragedBuyoutAnnualScheduleRow[];
  exitBridge: LeveragedBuyoutExitBridge;
  /** −sponsorEquity at year 0, +equityProceeds at the exit year (no interim dividends, v1). */
  equityCashFlows: TimedCashFlow[];
  /** `equityProceeds / sponsorEquity`. */
  multipleOnInvestedCapital: number;
  /**
   * The sponsor's IRR from the FC1 solver, or `null` when no admissible rate exists (equity
   * proceeds ≤ 0 have no positive-flow leg for an internal rate to equate).
   */
  internalRateOfReturn: number | null;
  assumptions: {
    /** Every modeling simplification this analysis makes, stated — never implied. */
    disclosedSimplifications: string[];
  };
}

const INPUT_KEYS = [
  'transaction',
  'sources',
  'operatingForecast',
  'cashSweepFraction',
  'exit',
] as const;
const TRANSACTION_KEYS = [
  'purchaseEnterpriseValue',
  'transactionFees',
  'cashToBalanceSheet',
] as const;
const SOURCES_KEYS = ['sponsorEquity', 'tranches'] as const;
const TRANCHE_KEYS = [
  'trancheName',
  'principal',
  'annualInterestRate',
  'mandatoryAmortizationFraction',
  'cashSweepPriority',
] as const;
const FORECAST_KEYS = [
  'year',
  'ebitda',
  'capitalExpenditure',
  'increaseInNetWorkingCapital',
  'taxRate',
] as const;
const EXIT_KEYS = ['year', 'exitEbitdaMultiple', 'exitFees'] as const;

// A COMPLETE, balanced, runnable request: sources 430 + 600 = uses 1,000 + 20 + 10.
const EXAMPLE_CALL =
  "leveragedBuyoutAnalysis({ transaction: { purchaseEnterpriseValue: 1_000, transactionFees: 20, cashToBalanceSheet: 10 }, sources: { sponsorEquity: 430, tranches: [{ trancheName: 'Term Loan A', principal: 600, annualInterestRate: 0.07, mandatoryAmortizationFraction: 0.05, cashSweepPriority: 1 }] }, operatingForecast: [{ year: 1, ebitda: 150, capitalExpenditure: 30, increaseInNetWorkingCapital: 5, taxRate: 0.25 }], cashSweepFraction: 0.75, exit: { year: 1, exitEbitdaMultiple: 8, exitFees: 15 } })";

const DISCLOSED_SIMPLIFICATIONS: readonly string[] = [
  'taxable income is EBITDA minus interest — depreciation and amortization are deliberately out of scope, so their tax shields are not modeled',
  'taxes are max(0, taxable income) × taxRate — no loss carryforward: a loss year pays zero tax and carries nothing forward',
  'the cash sweep applies only to positive free cash flow remaining after mandatory amortization; no revolver is modeled, so a year whose cash balance would go negative is refused rather than silently funded',
  'accumulated cash (including cashToBalanceSheet funded at close) earns no interest income and returns to the sponsor at exit through the net-debt bridge',
  "no interim dividends (v1) — the sponsor's equity cash flows are the entry equity at year 0 and the exit proceeds at the exit year",
  "the internal rate of return composes the FC1 internalRateOfReturn solver under its documented default 'annual' compounding",
];

function requireRangeField(
  field: string,
  value: number,
  options: { min?: number; minExclusive?: number; max?: number },
): void {
  const functionName = 'leveragedBuyoutAnalysis';
  if (options.minExclusive !== undefined && value <= options.minExclusive) {
    throw new InputError(
      `${functionName}: ${field} must be > ${options.minExclusive}. Received ${value}.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
  if (options.min !== undefined && value < options.min) {
    throw new InputError(`${functionName}: ${field} must be ≥ ${options.min}. Received ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field },
    });
  }
  if (options.max !== undefined && value > options.max) {
    throw new InputError(`${functionName}: ${field} must be ≤ ${options.max}. Received ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field },
    });
  }
}

function validateInput(input: LeveragedBuyoutAnalysisInput): void {
  const functionName = 'leveragedBuyoutAnalysis';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);

  // transaction — the uses side.
  requireArgumentObject(functionName, 'transaction', input.transaction);
  ensureKnownKeys(functionName, 'transaction', input.transaction, TRANSACTION_KEYS);
  requireFiniteFields('leveragedBuyoutAnalysis', input.transaction, TRANSACTION_KEYS, {
    exampleCall: EXAMPLE_CALL,
    path: 'transaction',
  });
  requireRangeField(
    'transaction.purchaseEnterpriseValue',
    input.transaction.purchaseEnterpriseValue,
    {
      minExclusive: 0,
    },
  );
  requireRangeField('transaction.transactionFees', input.transaction.transactionFees, { min: 0 });
  requireRangeField('transaction.cashToBalanceSheet', input.transaction.cashToBalanceSheet, {
    min: 0,
  });

  // sources — the funding side.
  requireArgumentObject(functionName, 'sources', input.sources);
  ensureKnownKeys(functionName, 'sources', input.sources, SOURCES_KEYS);
  requireFiniteFields('leveragedBuyoutAnalysis', input.sources, ['sponsorEquity'], {
    exampleCall: EXAMPLE_CALL,
    path: 'sources',
  });
  requireRangeField('sources.sponsorEquity', input.sources.sponsorEquity, { minExclusive: 0 });
  requireArgumentArray(functionName, 'sources.tranches', input.sources.tranches);
  const seenNames = new Set<string>();
  const seenPriorities = new Set<number>();
  input.sources.tranches.forEach((tranche, index) => {
    const path = `sources.tranches[${index}]`;
    requireArgumentObject(functionName, path, tranche);
    ensureKnownKeys(functionName, path, tranche, TRANCHE_KEYS);
    if (typeof tranche.trancheName !== 'string' || tranche.trancheName.length === 0) {
      throw new InputError(
        `${functionName}: ${path}.trancheName must be a non-empty string — schedule rows are keyed by it. Received ${tranche.trancheName === null ? 'null' : typeof tranche.trancheName === 'string' ? "''" : typeof tranche.trancheName}. e.g. ${EXAMPLE_CALL}`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.trancheName` } },
      );
    }
    requireFiniteFields(
      'leveragedBuyoutAnalysis',
      tranche,
      ['principal', 'annualInterestRate', 'mandatoryAmortizationFraction', 'cashSweepPriority'],
      {
        exampleCall: EXAMPLE_CALL,
        path,
        hints: {
          annualInterestRate: 'an annual decimal — 0.07 means 7%, not 7',
          mandatoryAmortizationFraction: 'a fraction of the ORIGINAL principal repaid per year',
        },
      },
    );
    requireRangeField(`${path}.principal`, tranche.principal, { minExclusive: 0 });
    requireRangeField(`${path}.annualInterestRate`, tranche.annualInterestRate, {
      minExclusive: -1,
    });
    requireRangeField(
      `${path}.mandatoryAmortizationFraction`,
      tranche.mandatoryAmortizationFraction,
      {
        min: 0,
        max: 1,
      },
    );
    if (!Number.isSafeInteger(tranche.cashSweepPriority) || tranche.cashSweepPriority < 1) {
      throw new InputError(
        `${functionName}: ${path}.cashSweepPriority must be an integer ≥ 1 (1 is repaid first). Received ${tranche.cashSweepPriority}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.cashSweepPriority` } },
      );
    }
    if (seenNames.has(tranche.trancheName)) {
      throw new InputError(
        `${functionName}: ${path}.trancheName duplicates "${tranche.trancheName}" — schedule rows are keyed by name, so tranche names must be distinct.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.trancheName` } },
      );
    }
    if (seenPriorities.has(tranche.cashSweepPriority)) {
      throw new InputError(
        `${functionName}: ${path}.cashSweepPriority duplicates ${tranche.cashSweepPriority} — a tied sweep order would be broken silently, so priorities must be distinct.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.cashSweepPriority` } },
      );
    }
    seenNames.add(tranche.trancheName);
    seenPriorities.add(tranche.cashSweepPriority);
  });

  // operatingForecast — years 1..N consecutive.
  requireArgumentArray(functionName, 'operatingForecast', input.operatingForecast);
  if (input.operatingForecast.length === 0) {
    throw new InputError(
      `${functionName}: operatingForecast must not be empty — the holding period is its length.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'operatingForecast' } },
    );
  }
  input.operatingForecast.forEach((forecastYear, index) => {
    const path = `operatingForecast[${index}]`;
    requireArgumentObject(functionName, path, forecastYear);
    ensureKnownKeys(functionName, path, forecastYear, FORECAST_KEYS);
    requireFiniteFields('leveragedBuyoutAnalysis', forecastYear, FORECAST_KEYS, {
      exampleCall: EXAMPLE_CALL,
      path,
      hints: { taxRate: 'a decimal in [0, 1] — 0.25 means 25%, not 25' },
    });
    if (forecastYear.year !== index + 1) {
      throw new InputError(
        `${functionName}: ${path}.year must be ${index + 1} — forecast years run 1..N consecutively from the close, with no gaps or reordering. Received ${forecastYear.year}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.year` } },
      );
    }
    requireRangeField(`${path}.taxRate`, forecastYear.taxRate, { min: 0, max: 1 });
  });

  // cashSweepFraction.
  requireFiniteFields('leveragedBuyoutAnalysis', input, ['cashSweepFraction'], {
    exampleCall: EXAMPLE_CALL,
    hints: { cashSweepFraction: 'a fraction in [0, 1] of post-amortization free cash flow' },
  });
  requireRangeField('cashSweepFraction', input.cashSweepFraction, { min: 0, max: 1 });

  // exit.
  requireArgumentObject(functionName, 'exit', input.exit);
  ensureKnownKeys(functionName, 'exit', input.exit, EXIT_KEYS);
  requireFiniteFields('leveragedBuyoutAnalysis', input.exit, EXIT_KEYS, {
    exampleCall: EXAMPLE_CALL,
    path: 'exit',
  });
  const lastForecastYear = input.operatingForecast[input.operatingForecast.length - 1]!.year;
  if (input.exit.year !== lastForecastYear) {
    throw new InputError(
      `${functionName}: exit.year must equal the last forecast year (${lastForecastYear}) — the exit is priced off that year's EBITDA, so a different exit year needs a matching forecast. Received ${input.exit.year}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'exit.year' } },
    );
  }
  requireRangeField('exit.exitEbitdaMultiple', input.exit.exitEbitdaMultiple, { minExclusive: 0 });
  requireRangeField('exit.exitFees', input.exit.exitFees, { min: 0 });

  // The sources-equal-uses law, both sides stated.
  const totalTranchePrincipal = input.sources.tranches.reduce(
    (sum, tranche) => sum + tranche.principal,
    0,
  );
  const totalSources = input.sources.sponsorEquity + totalTranchePrincipal;
  const totalUses =
    input.transaction.purchaseEnterpriseValue +
    input.transaction.transactionFees +
    input.transaction.cashToBalanceSheet;
  if (Math.abs(totalSources - totalUses) > 1e-6) {
    throw new InputError(
      `${functionName}: sources must equal uses — sources total ${totalSources} (sponsorEquity ${input.sources.sponsorEquity} + tranche principals ${totalTranchePrincipal}) but uses total ${totalUses} (purchaseEnterpriseValue ${input.transaction.purchaseEnterpriseValue} + transactionFees ${input.transaction.transactionFees} + cashToBalanceSheet ${input.transaction.cashToBalanceSheet}). A structure that does not balance is refused, never plugged.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'sources' } },
    );
  }
}

/**
 * Leveraged buyout analysis: entry sources/uses, an annual debt/cash schedule under mandatory
 * amortization plus a priority-ordered cash sweep, the exit bridge from enterprise value to
 * sponsor proceeds, the sponsor's equity cash flows, MOIC, and IRR (via the FC1 solver).
 * See the module doc comment for the DISCLOSED simplifications, echoed in the result.
 */
export function leveragedBuyoutAnalysis(
  input: LeveragedBuyoutAnalysisInput,
): LeveragedBuyoutAnalysisResult {
  validateInput(input);

  const trancheStates = input.sources.tranches.map((tranche) => ({
    trancheName: tranche.trancheName,
    originalPrincipal: tranche.principal,
    annualInterestRate: tranche.annualInterestRate,
    mandatoryAmortizationFraction: tranche.mandatoryAmortizationFraction,
    cashSweepPriority: tranche.cashSweepPriority,
    balance: tranche.principal,
  }));
  const sweepOrder = [...trancheStates].sort((a, b) => a.cashSweepPriority - b.cashSweepPriority);

  const annualSchedule: LeveragedBuyoutAnnualScheduleRow[] = [];
  let cash = input.transaction.cashToBalanceSheet;
  for (const forecastYear of input.operatingForecast) {
    // Interest accrues on each tranche's beginning-of-year balance.
    const beginningBalances = new Map<string, number>(
      trancheStates.map((tranche) => [tranche.trancheName, tranche.balance]),
    );
    const interestByTranche = new Map<string, number>(
      trancheStates.map((tranche) => [
        tranche.trancheName,
        tranche.balance * tranche.annualInterestRate,
      ]),
    );
    let totalInterest = 0;
    for (const interest of interestByTranche.values()) totalInterest += interest;

    // DISCLOSED: EBITDA − interest is the tax base (no D&A); losses pay zero with no carryforward.
    const taxableIncome = forecastYear.ebitda - totalInterest;
    const taxes = Math.max(0, taxableIncome) * forecastYear.taxRate;
    const freeCashFlow =
      forecastYear.ebitda -
      taxes -
      forecastYear.capitalExpenditure -
      forecastYear.increaseInNetWorkingCapital -
      totalInterest;

    // Mandatory amortization: a fraction of ORIGINAL principal, capped at the remaining balance.
    const mandatoryByTranche = new Map<string, number>();
    let totalMandatory = 0;
    for (const tranche of trancheStates) {
      const mandatory = Math.min(
        tranche.mandatoryAmortizationFraction * tranche.originalPrincipal,
        tranche.balance,
      );
      mandatoryByTranche.set(tranche.trancheName, mandatory);
      tranche.balance -= mandatory;
      totalMandatory += mandatory;
    }

    // Cash sweep: only POSITIVE post-mandatory FCF sweeps, in priority order, capped per tranche.
    const remainingFreeCashFlow = freeCashFlow - totalMandatory;
    let sweepPool = remainingFreeCashFlow > 0 ? remainingFreeCashFlow * input.cashSweepFraction : 0;
    const sweepByTranche = new Map<string, number>(
      trancheStates.map((tranche) => [tranche.trancheName, 0]),
    );
    let totalSweep = 0;
    for (const tranche of sweepOrder) {
      if (sweepPool <= 0) break;
      const sweep = Math.min(sweepPool, tranche.balance);
      sweepByTranche.set(tranche.trancheName, sweep);
      tranche.balance -= sweep;
      sweepPool -= sweep;
      totalSweep += sweep;
    }

    const closingCash = cash + freeCashFlow - totalMandatory - totalSweep;
    if (closingCash < 0) {
      throw new InputError(
        `leveragedBuyoutAnalysis: year ${forecastYear.year} ends with negative cash (${closingCash}) — free cash flow ${freeCashFlow} plus opening cash ${cash} cannot fund mandatory amortization ${totalMandatory}. No revolver is modeled, so the structure is refused rather than silently funded; reduce mandatoryAmortizationFraction or revise the forecast.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'operatingForecast' } },
      );
    }
    cash = closingCash;

    annualSchedule.push({
      year: forecastYear.year,
      ebitda: forecastYear.ebitda,
      interest: totalInterest,
      taxes,
      freeCashFlow,
      cashSweptToDebt: totalSweep,
      cashAccumulated: cash,
      trancheRows: trancheStates.map((tranche) => ({
        year: forecastYear.year,
        trancheName: tranche.trancheName,
        beginningBalance: beginningBalances.get(tranche.trancheName)!,
        interest: interestByTranche.get(tranche.trancheName)!,
        mandatoryAmortization: mandatoryByTranche.get(tranche.trancheName)!,
        cashSweep: sweepByTranche.get(tranche.trancheName)!,
        endingBalance: tranche.balance,
      })),
    });
  }

  // Exit bridge: EV at the exit multiple, minus net debt, minus exit fees.
  const exitYearForecast = input.operatingForecast[input.operatingForecast.length - 1]!;
  const enterpriseValue = exitYearForecast.ebitda * input.exit.exitEbitdaMultiple;
  const remainingDebt = trancheStates.reduce((sum, tranche) => sum + tranche.balance, 0);
  const netDebtAtExit = remainingDebt - cash;
  const equityProceeds = enterpriseValue - netDebtAtExit - input.exit.exitFees;
  const exitBridge: LeveragedBuyoutExitBridge = {
    exitEbitda: exitYearForecast.ebitda,
    exitEbitdaMultiple: input.exit.exitEbitdaMultiple,
    enterpriseValue,
    netDebtAtExit,
    exitFees: input.exit.exitFees,
    equityProceeds,
  };

  const equityCashFlows: TimedCashFlow[] = [
    { amount: -input.sources.sponsorEquity, timeYears: 0 },
    { amount: equityProceeds, timeYears: input.exit.year },
  ];

  // FC1 composition: the solver needs one inflow AND one outflow, so non-positive proceeds have
  // no internal rate — `null` with the reason documented on the result field, never NaN.
  const sponsorInternalRateOfReturn =
    equityProceeds > 0 ? internalRateOfReturn({ cashFlows: equityCashFlows }) : null;

  return {
    diagnostics: { warnings: [...DISCLOSED_SIMPLIFICATIONS] },
    sourcesAndUses: {
      sources: {
        sponsorEquity: input.sources.sponsorEquity,
        tranches: input.sources.tranches.map((tranche) => ({
          trancheName: tranche.trancheName,
          principal: tranche.principal,
        })),
        totalSources:
          input.sources.sponsorEquity +
          input.sources.tranches.reduce((sum, tranche) => sum + tranche.principal, 0),
      },
      uses: {
        purchaseEnterpriseValue: input.transaction.purchaseEnterpriseValue,
        transactionFees: input.transaction.transactionFees,
        cashToBalanceSheet: input.transaction.cashToBalanceSheet,
        totalUses:
          input.transaction.purchaseEnterpriseValue +
          input.transaction.transactionFees +
          input.transaction.cashToBalanceSheet,
      },
    },
    annualSchedule,
    exitBridge,
    equityCashFlows,
    multipleOnInvestedCapital: equityProceeds / input.sources.sponsorEquity,
    internalRateOfReturn: sponsorInternalRateOfReturn,
    assumptions: { disclosedSimplifications: [...DISCLOSED_SIMPLIFICATIONS] },
  };
}
