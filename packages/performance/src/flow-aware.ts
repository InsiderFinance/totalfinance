/**
 * FC4 — cash-flow-aware performance. External deposits, withdrawals, and transfers are NOT
 * investment profit or loss; every method here states its flow-timing convention explicitly and
 * echoes it back in `assumptions`. Missing marks become GAPS in `diagnostics.gaps` — never a
 * silent forward fill. The money-weighted return COMPOSES `datedInternalRateOfReturn` from
 * `@insiderfinance/totalfinance/valuation` (the FC1 solver) and preserves its root/convergence diagnostics whole.
 * Annualization is explicit — `'none'` or a declared basis — and never inferred from timestamps.
 */

import {
  requireRepresentableResult,
  stableSum,
  ErrorCode,
  InputError,
  assertFiniteValue,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
  yearFraction,
} from '@totalfinance/core';
import {
  type DatedCashFlow,
  type InternalRateOfReturnReport,
  datedInternalRateOfReturn,
} from '@totalfinance/valuation';

// ---------------------------------------------------------------------------------------------------
// Shared contracts
// ---------------------------------------------------------------------------------------------------

/** One portfolio mark: the net asset value observed on a strict calendar date. */
export interface PortfolioValuation {
  /** Strict `YYYY-MM-DD` calendar date. */
  valuationDate: string;
  /** The portfolio's net asset value — finite and ≥ 0 (`0` only for an empty portfolio). */
  netAssetValue: number;
}

/** One EXTERNAL cash flow: money crossing the portfolio boundary, never profit or loss. */
export interface ExternalCashFlow {
  /** Strict `YYYY-MM-DD` calendar date. */
  cashFlowDate: string;
  /** Positive = deposit INTO the portfolio, negative = withdrawal FROM it. */
  amount: number;
  label?: string;
  /** The account the flow touched — required on both legs for internal-transfer detection. */
  accountId?: string;
}

/** One excluded date range with the reason it was excluded — never forward-filled. */
export interface PerformanceGap {
  fromDate: string;
  toDate: string;
  reason: string;
}

/** The explicit annualization policy: `'none'` or a declared day-count basis. */
export type AnnualizationPolicy = 'none' | { basis: 'ACT/365F' };

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The ONE flow convention every time-weighted computation here states and obeys:
 * a valuation dated D marks the portfolio BEFORE any external flow dated D lands (mark first,
 * then flow), so a flow dated on a valuation date belongs to the subperiod that STARTS at D —
 * the flow is invested for the WHOLE subperiod. Within a subperiod,
 * simpleReturn = endNetAssetValue / (startNetAssetValue + netExternalFlows) − 1:
 * the flow principal joins the start-of-subperiod base (denominator), so external deposits and
 * withdrawals are never profit or loss. A flow dated on the FINAL valuation date lies after the
 * last mark and affects no measured subperiod.
 */
const FLOW_CONVENTION =
  'A valuation dated D marks the portfolio BEFORE any external flow dated D lands (mark first, then flow); ' +
  'a flow dated on a valuation date belongs to the subperiod that STARTS at D — the flow is invested for ' +
  'the WHOLE subperiod. Within a subperiod, ' +
  'simpleReturn = endNetAssetValue / (startNetAssetValue + netExternalFlows) − 1 — the flow principal ' +
  'joins the start-of-subperiod base (denominator), so external deposits and withdrawals are never profit ' +
  'or loss. A flow dated on the final valuation date lies after the last mark and affects no ' +
  'measured subperiod.';

// ---------------------------------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------------------------------

function requireStrictDate(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || !STRICT_DATE.test(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a strict YYYY-MM-DD calendar date. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      { code: ErrorCode.InputWrongType, context: { field } },
    );
  }
}

const VALUATION_KEYS = ['valuationDate', 'netAssetValue'] as const;

/** Validate a valuation series: dated marks, finite non-negative values, strictly ascending dates. */
function requireValuations(
  functionName: string,
  valuations: readonly PortfolioValuation[],
  minimumCount: number,
): void {
  requireArgumentArray(functionName, 'valuations', valuations);
  if (valuations.length < minimumCount) {
    throw new InputError(
      `${functionName}: valuations needs at least ${minimumCount} dated marks — a return is measured BETWEEN valuations. Received ${valuations.length}.\n  e.g. ${functionName}({ valuations: [{ valuationDate: '2024-01-01', netAssetValue: 1_000 }, { valuationDate: '2024-02-01', netAssetValue: 1_050 }], ...request })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'valuations' } },
    );
  }
  valuations.forEach((valuation, index) => {
    requireArgumentObject(functionName, `valuations[${index}]`, valuation);
    ensureKnownKeys(functionName, `valuations[${index}]`, valuation, VALUATION_KEYS);
    requireStrictDate(functionName, `valuations[${index}].valuationDate`, valuation.valuationDate);
    if (typeof valuation.netAssetValue !== 'number' || !Number.isFinite(valuation.netAssetValue)) {
      throw new InputError(
        `${functionName}: valuations[${index}].netAssetValue must be a finite number. Received ${valuation.netAssetValue === null ? 'null' : typeof valuation.netAssetValue === 'number' ? valuation.netAssetValue : typeof valuation.netAssetValue}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `valuations[${index}].netAssetValue` },
        },
      );
    }
    if (valuation.netAssetValue < 0) {
      throw new InputError(
        `${functionName}: valuations[${index}].netAssetValue must be ≥ 0 (0 only for an empty portfolio). Received ${valuation.netAssetValue}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `valuations[${index}].netAssetValue` },
        },
      );
    }
  });
  for (let index = 1; index < valuations.length; index++) {
    const previous = isoDateToEpochMs(valuations[index - 1]!.valuationDate);
    const current = isoDateToEpochMs(valuations[index]!.valuationDate);
    if (current <= previous) {
      throw new InputError(
        `${functionName}: valuations must be strictly ascending by valuationDate — valuations[${index}] (${valuations[index]!.valuationDate}) does not follow valuations[${index - 1}] (${valuations[index - 1]!.valuationDate}). Sort the series and remove duplicate dates.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `valuations[${index}].valuationDate` },
        },
      );
    }
  }
}

const EXTERNAL_FLOW_KEYS = ['cashFlowDate', 'amount', 'label', 'accountId'] as const;

/** Validate an external-flow collection (empty is a valid "no flows" statement). */
function requireExternalCashFlows(
  functionName: string,
  externalCashFlows: readonly ExternalCashFlow[],
): void {
  requireArgumentArray(functionName, 'externalCashFlows', externalCashFlows);
  externalCashFlows.forEach((flow, index) => {
    requireArgumentObject(functionName, `externalCashFlows[${index}]`, flow);
    ensureKnownKeys(functionName, `externalCashFlows[${index}]`, flow, EXTERNAL_FLOW_KEYS);
    requireStrictDate(functionName, `externalCashFlows[${index}].cashFlowDate`, flow.cashFlowDate);
    if (typeof flow.amount !== 'number' || !Number.isFinite(flow.amount)) {
      throw new InputError(
        `${functionName}: externalCashFlows[${index}].amount must be a finite number (positive deposit into the portfolio, negative withdrawal). Received ${flow.amount === null ? 'null' : typeof flow.amount}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `externalCashFlows[${index}].amount` },
        },
      );
    }
    if (flow.label !== undefined && typeof flow.label !== 'string') {
      throw new InputError(
        `${functionName}: externalCashFlows[${index}].label must be a string when provided. Received ${flow.label === null ? 'null' : typeof flow.label}.`,
        { code: ErrorCode.InputWrongType, context: { field: `externalCashFlows[${index}].label` } },
      );
    }
    if (
      flow.accountId !== undefined &&
      (typeof flow.accountId !== 'string' || flow.accountId.length === 0)
    ) {
      throw new InputError(
        `${functionName}: externalCashFlows[${index}].accountId must be a non-empty string when provided. Received ${flow.accountId === null ? 'null' : JSON.stringify(flow.accountId)}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `externalCashFlows[${index}].accountId` },
        },
      );
    }
  });
}

function requireAnnualizationPolicy(
  functionName: string,
  value: unknown,
): asserts value is AnnualizationPolicy {
  if (value === 'none') return;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    ensureKnownKeys(functionName, 'annualization', value, ['basis']);
    const basis = (value as { basis?: unknown }).basis;
    if (basis === 'ACT/365F') return;
    throw new InputError(
      `${functionName}: annualization.basis must be the explicit literal 'ACT/365F' — the only declared basis in v1. Received ${basis === null ? 'null' : JSON.stringify(basis)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'annualization.basis' } },
    );
  }
  throw new InputError(
    `${functionName}: annualization is required and EXPLICIT — pass 'none' or { basis: 'ACT/365F' }; it is never inferred from timestamps. Received ${value === undefined ? 'undefined' : value === null ? 'null' : JSON.stringify(value)}.\n  e.g. ${functionName}({ valuations, externalCashFlows, flowTiming: 'at-flow-timestamp', annualization: 'none' })`,
    {
      code: value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
      context: { field: 'annualization' },
    },
  );
}

// ---------------------------------------------------------------------------------------------------
// Time-weighted subperiod core (shared by timeWeightedReturn and portfolioReturnIndex)
// ---------------------------------------------------------------------------------------------------

/** One measured subperiod between consecutive valuation dates. */
export interface TimeWeightedSubperiod {
  startDate: string;
  endDate: string;
  startNetAssetValue: number;
  endNetAssetValue: number;
  /**
   * Net external flows attributed to this subperiod (dated on its start valuation date). Under the
   * flow convention the mark precedes the same-dated flow, so this amount lands at the START of
   * the subperiod and is invested for its whole length — it joins the return base.
   */
  externalFlowAmount: number;
  /** `endNetAssetValue / (startNetAssetValue + externalFlowAmount) − 1` — the flow rides in the base. */
  simpleReturn: number;
}

interface SubperiodComputationOutcome {
  /** Measured (non-gap) subperiods only; gap windows live in `gaps`. */
  subperiods: TimeWeightedSubperiod[];
  gaps: PerformanceGap[];
  warnings: string[];
}

function computeTimeWeightedSubperiods(
  functionName: string,
  valuations: readonly PortfolioValuation[],
  externalCashFlows: readonly ExternalCashFlow[],
): SubperiodComputationOutcome {
  const count = valuations.length;
  const epochMilliseconds = valuations.map((valuation) =>
    isoDateToEpochMs(valuation.valuationDate),
  );
  const dateToIndex = new Map<string, number>();
  valuations.forEach((valuation, index) => dateToIndex.set(valuation.valuationDate, index));

  const startFlowTotals: number[] = new Array(count - 1).fill(0);
  const gapFlowDates: string[][] = Array.from({ length: count - 1 }, () => []);
  const warnings: string[] = [];

  const firstDate = valuations[0]!.valuationDate;
  const lastDate = valuations[count - 1]!.valuationDate;

  for (const flow of externalCashFlows) {
    const flowMilliseconds = isoDateToEpochMs(flow.cashFlowDate);
    if (
      flowMilliseconds < epochMilliseconds[0]! ||
      flowMilliseconds > epochMilliseconds[count - 1]!
    ) {
      warnings.push(
        `${functionName}: external flow dated ${flow.cashFlowDate} lies outside the valuation window [${firstDate}, ${lastDate}] — it cannot affect any measured subperiod.`,
      );
      continue;
    }
    const valuationIndex = dateToIndex.get(flow.cashFlowDate);
    if (valuationIndex !== undefined) {
      if (valuationIndex === count - 1) {
        warnings.push(
          `${functionName}: external flow dated ${flow.cashFlowDate} falls on the final valuation date — the final mark precedes same-dated flows, so the flow lies after the measured window and affects no subperiod.`,
        );
      } else {
        // Attributed to the START of the subperiod beginning at this valuation date.
        startFlowTotals[valuationIndex]! += flow.amount;
      }
      continue;
    }
    // Interior flow with NO valuation dated the same day → the surrounding subperiod is a gap.
    for (let index = 0; index < count - 1; index++) {
      if (
        flowMilliseconds > epochMilliseconds[index]! &&
        flowMilliseconds < epochMilliseconds[index + 1]!
      ) {
        gapFlowDates[index]!.push(flow.cashFlowDate);
        break;
      }
    }
  }

  const subperiods: TimeWeightedSubperiod[] = [];
  const gaps: PerformanceGap[] = [];
  for (let index = 0; index < count - 1; index++) {
    const start = valuations[index]!;
    const end = valuations[index + 1]!;
    const unmatchedFlowDates = gapFlowDates[index]!;
    if (unmatchedFlowDates.length > 0) {
      gaps.push({
        fromDate: start.valuationDate,
        toDate: end.valuationDate,
        reason: `external flow${unmatchedFlowDates.length > 1 ? 's' : ''} dated ${unmatchedFlowDates.join(', ')} ${unmatchedFlowDates.length > 1 ? 'have' : 'has'} no portfolio valuation dated the same day (flowTiming 'at-flow-timestamp') — the subperiod is a gap, excluded from linking rather than forward-filled.`,
      });
      continue;
    }
    const externalFlowAmount = startFlowTotals[index]!;
    // The return base under the flow convention: the start mark PLUS the same-day flows that are
    // invested for the whole subperiod. A non-positive base has no measurable return (an empty
    // portfolio with no inflow, or a same-day withdrawal of the whole portfolio) — the subperiod
    // is a GAP with a reason, never a division blow-up.
    const investedBase = start.netAssetValue + externalFlowAmount;
    if (investedBase <= 0) {
      gaps.push({
        fromDate: start.valuationDate,
        toDate: end.valuationDate,
        reason: `the return base on ${start.valuationDate} (start net asset value ${start.netAssetValue} + same-day external flows ${externalFlowAmount} = ${investedBase}) is not positive — a simple return over this subperiod is undefined, so it is a gap rather than a fabricated rate.`,
      });
      continue;
    }
    subperiods.push({
      startDate: start.valuationDate,
      endDate: end.valuationDate,
      startNetAssetValue: start.netAssetValue,
      endNetAssetValue: end.netAssetValue,
      externalFlowAmount,
      simpleReturn: end.netAssetValue / investedBase - 1,
    });
  }
  if (gaps.length > 0) {
    warnings.push(
      `${functionName}: ${gaps.length} of ${count - 1} subperiods are gaps — the linked result covers only the measured subperiods and is not a continuous-period figure.`,
    );
  }
  return { subperiods, gaps, warnings };
}

// ---------------------------------------------------------------------------------------------------
// timeWeightedReturn
// ---------------------------------------------------------------------------------------------------

/** Input for {@link timeWeightedReturn}. */
export interface TimeWeightedReturnInput {
  valuations: readonly PortfolioValuation[];
  externalCashFlows: readonly ExternalCashFlow[];
  /**
   * The only v1 policy: a flow is valued at the net asset value dated the SAME date; a flow date
   * with no valuation makes its surrounding subperiod a gap — never a forward fill.
   */
  flowTiming: 'at-flow-timestamp';
  /** REQUIRED and explicit: `'none'` or `{ basis: 'ACT/365F' }` — never inferred from timestamps. */
  annualization: AnnualizationPolicy;
}

/** Result of {@link timeWeightedReturn}. */
export interface TimeWeightedReturnResult {
  /** Geometric link of the measured subperiod returns; `null` when every subperiod is a gap. */
  timeWeightedReturn: number | null;
  /** Present exactly when `timeWeightedReturn` is `null`. */
  reason?: string;
  /**
   * Present only when `annualization` declared a basis AND the linked return exists, is
   * annualizable (its growth factor is positive), AND NO subperiod is a gap:
   * `(1 + timeWeightedReturn)^(1 / elapsedYears) − 1` over the ACT/365F year fraction between the
   * first and last valuation dates. When any subperiod is a gap the linked return does not cover
   * the whole window, so no annualized rate is stated (withheld with a warning).
   */
  annualizedReturn?: number;
  subperiods: TimeWeightedSubperiod[];
  assumptions: {
    flowTiming: 'at-flow-timestamp';
    flowConvention: string;
    annualization: AnnualizationPolicy;
    linking: 'geometric';
  };
  diagnostics: {
    warnings: string[];
    gaps: PerformanceGap[];
    flowCount: number;
    subperiodCount: number;
  };
}

const TIME_WEIGHTED_KEYS = [
  'valuations',
  'externalCashFlows',
  'flowTiming',
  'annualization',
] as const;

/**
 * Time-weighted return: simple returns between consecutive valuation dates, linked geometrically.
 *
 * Flow convention (also echoed in `assumptions.flowConvention`): a valuation dated D marks the
 * portfolio BEFORE any external flow dated D lands, so a flow dated on a valuation date is
 * attributed to the START of the subperiod beginning at D and is invested for its whole length.
 * Each subperiod uses
 * `simpleReturn = endNetAssetValue / (startNetAssetValue + netExternalFlows) − 1` — the flow
 * principal joins the start-of-subperiod base (denominator), so external deposits and
 * withdrawals are never profit or loss. A flow dated between valuations has no mark
 * to be valued at, so its surrounding subperiod becomes a GAP: excluded from linking, recorded in
 * `diagnostics.gaps`, never forward-filled. `annualizedReturn` appears only under the explicit
 * `{ basis: 'ACT/365F' }` policy, and only when NO subperiod is a gap — a linked return that
 * covers part of the window is never annualized over the whole window.
 */
export function timeWeightedReturn(input: TimeWeightedReturnInput): TimeWeightedReturnResult {
  requireArgumentObject('timeWeightedReturn', 'input', input);
  ensureKnownKeys('timeWeightedReturn', 'input', input, TIME_WEIGHTED_KEYS);
  requireValuations('timeWeightedReturn', input.valuations, 2);
  requireExternalCashFlows('timeWeightedReturn', input.externalCashFlows);
  if (input.flowTiming !== 'at-flow-timestamp') {
    throw new InputError(
      `timeWeightedReturn: flowTiming must be the explicit literal 'at-flow-timestamp' — the only v1 policy: a flow is valued at the net asset value dated the SAME date, and a flow date with no valuation makes its subperiod a gap. Received ${input.flowTiming === undefined ? 'undefined' : JSON.stringify(input.flowTiming)}.\n  e.g. timeWeightedReturn({ valuations, externalCashFlows, flowTiming: 'at-flow-timestamp', annualization: 'none' })`,
      {
        code:
          input.flowTiming === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
        context: { field: 'flowTiming' },
      },
    );
  }
  requireAnnualizationPolicy('timeWeightedReturn', input.annualization);

  const outcome = computeTimeWeightedSubperiods(
    'timeWeightedReturn',
    input.valuations,
    input.externalCashFlows,
  );
  const warnings = [...outcome.warnings];

  let timeWeighted: number | null;
  let reason: string | undefined;
  if (outcome.subperiods.length === 0) {
    timeWeighted = null;
    reason = 'every subperiod is a gap — no measured subperiod return remains to link.';
  } else {
    let linkedFactor = 1;
    for (const subperiod of outcome.subperiods) linkedFactor *= 1 + subperiod.simpleReturn;
    timeWeighted = linkedFactor - 1;
  }

  let annualizedReturn: number | undefined;
  if (input.annualization !== 'none' && timeWeighted !== null) {
    if (outcome.gaps.length > 0) {
      // A warning alone would not make the number economically valid: the linked return covers
      // only the measured subperiods, so annualizing it over the full first-to-last window states
      // a rate for time the measurement never covered. Withhold, mirroring the ≤ −100% withhold.
      warnings.push(
        `timeWeightedReturn: ${outcome.gaps.length} subperiod(s) are gaps, so the linked return does not cover the whole first-to-last valuation window — annualizedReturn is withheld because an annualized rate over the full window would claim time the measurement excluded.`,
      );
    } else {
      const elapsedYears = yearFraction(
        input.valuations[0]!.valuationDate,
        input.valuations[input.valuations.length - 1]!.valuationDate,
        'ACT/365F',
      );
      const linkedFactor = 1 + timeWeighted;
      if (linkedFactor <= 0) {
        warnings.push(
          'timeWeightedReturn: the linked return is at or below −100% — an annualized rate has no real growth factor, so annualizedReturn is withheld.',
        );
      } else {
        annualizedReturn = Math.pow(linkedFactor, 1 / elapsedYears) - 1;
      }
    }
  }

  const result: TimeWeightedReturnResult = {
    timeWeightedReturn: timeWeighted,
    ...(reason !== undefined ? { reason } : {}),
    ...(annualizedReturn !== undefined ? { annualizedReturn } : {}),
    subperiods: outcome.subperiods,
    assumptions: {
      flowTiming: 'at-flow-timestamp',
      flowConvention: FLOW_CONVENTION,
      annualization: input.annualization,
      linking: 'geometric',
    },
    diagnostics: {
      warnings,
      gaps: outcome.gaps,
      flowCount: input.externalCashFlows.length,
      subperiodCount: outcome.subperiods.length,
    },
  };
  // Law 7: a finite-input overflow must never leave here as a successful Infinity.
  assertFiniteValue('timeWeightedReturn', result);
  return result;
}

// ---------------------------------------------------------------------------------------------------
// moneyWeightedReturn
// ---------------------------------------------------------------------------------------------------

/** Input for {@link moneyWeightedReturn}. */
export interface MoneyWeightedReturnInput {
  /** First and last valuations REQUIRED — they anchor the schedule. Interior marks do not enter. */
  valuations: readonly PortfolioValuation[];
  externalCashFlows: readonly ExternalCashFlow[];
}

/** Result of {@link moneyWeightedReturn}. */
export interface MoneyWeightedReturnResult {
  /** The dated internal rate of return of the investor schedule; `null` on no root or ambiguity. */
  moneyWeightedReturn: number | null;
  /** Present exactly when `moneyWeightedReturn` is `null` — why the solver withheld a value. */
  reason?: string;
  /** The FC1 solver's full `.explain()` report: roots, convergence, and warnings ride along. */
  solverReport: InternalRateOfReturnReport;
  assumptions: {
    signConvention: string;
    /** The first valuation date — the solver's valuation instant. */
    asOf: string;
  };
  diagnostics: {
    warnings: string[];
    scheduleRowCount: number;
  };
}

const MONEY_WEIGHTED_KEYS = ['valuations', 'externalCashFlows'] as const;

const SIGN_CONVENTION =
  'Investor cash flows: the beginning net asset value is an outflow (−netAssetValue at the first ' +
  'valuation date), a deposit into the portfolio is an outflow (−amount), a withdrawal is an inflow ' +
  '(+amount), and the ending net asset value is an inflow (+netAssetValue at the last valuation date).';

/**
 * Money-weighted return: the dated internal rate of return of the INVESTOR's cash-flow schedule,
 * composed from `datedInternalRateOfReturn` in `@insiderfinance/totalfinance/valuation` (annual compounding,
 * ACT/365F — echoed in `solverReport.assumptions`).
 *
 * Sign convention (echoed in `assumptions.signConvention`): flows are stated from the INVESTOR's
 * perspective — the beginning net asset value is money the investor has committed (an outflow,
 * `−netAssetValue₀`), a deposit is the investor paying in (an outflow, `−amount`), a withdrawal is
 * the investor taking money out (an inflow, `+amount`), and the ending net asset value is what the
 * investor could take out (an inflow, `+netAssetValueₙ`). The solver's `.explain()` report is
 * preserved whole in `solverReport` so every admissible root and convergence detail rides along.
 */
export function moneyWeightedReturn(input: MoneyWeightedReturnInput): MoneyWeightedReturnResult {
  requireArgumentObject('moneyWeightedReturn', 'input', input);
  ensureKnownKeys('moneyWeightedReturn', 'input', input, MONEY_WEIGHTED_KEYS);
  requireValuations('moneyWeightedReturn', input.valuations, 2);
  requireExternalCashFlows('moneyWeightedReturn', input.externalCashFlows);

  const first = input.valuations[0]!;
  const last = input.valuations[input.valuations.length - 1]!;
  const firstMilliseconds = isoDateToEpochMs(first.valuationDate);
  const lastMilliseconds = isoDateToEpochMs(last.valuationDate);
  input.externalCashFlows.forEach((flow, index) => {
    const flowMilliseconds = isoDateToEpochMs(flow.cashFlowDate);
    if (flowMilliseconds < firstMilliseconds || flowMilliseconds > lastMilliseconds) {
      throw new InputError(
        `moneyWeightedReturn: externalCashFlows[${index}] dated ${flow.cashFlowDate} lies outside the measurement window [${first.valuationDate}, ${last.valuationDate}] — the first and last valuations anchor the schedule, so every flow must fall between them.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `externalCashFlows[${index}].cashFlowDate` },
        },
      );
    }
  });

  const warnings: string[] = [];
  if (input.valuations.length > 2) {
    warnings.push(
      `moneyWeightedReturn: ${input.valuations.length - 2} interior valuation(s) do not enter the money-weighted schedule — only the first and last anchor it. Use timeWeightedReturn to use every mark.`,
    );
  }

  const schedule: DatedCashFlow[] = [
    {
      amount: -first.netAssetValue,
      cashFlowDate: first.valuationDate,
      label: 'beginning net asset value (investor outflow)',
    },
    ...input.externalCashFlows.map((flow): DatedCashFlow => {
      return {
        amount: -flow.amount,
        cashFlowDate: flow.cashFlowDate,
        ...(flow.label !== undefined ? { label: flow.label } : {}),
      };
    }),
    {
      amount: last.netAssetValue,
      cashFlowDate: last.valuationDate,
      label: 'ending net asset value (investor inflow)',
    },
  ];
  const hasPositive = schedule.some((row) => row.amount > 0);
  const hasNegative = schedule.some((row) => row.amount < 0);
  if (!hasPositive || !hasNegative) {
    throw new InputError(
      `moneyWeightedReturn: the investor schedule needs at least one inflow AND one outflow — under the sign convention (−netAssetValue₀, −deposits, +withdrawals, +netAssetValueₙ) this schedule is all one sign, so no internal rate can cross zero. Check the beginning/ending net asset values and flow signs.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'valuations' } },
    );
  }

  const solverReport = datedInternalRateOfReturn.explain({
    cashFlows: schedule,
    asOf: first.valuationDate,
  });

  let reason: string | undefined;
  if (solverReport.value === null) {
    reason =
      solverReport.roots.length === 0
        ? 'no admissible internal rate exists — the schedule net present value never crosses zero in the search range (see solverReport).'
        : `${solverReport.roots.length} economically admissible internal rates exist — the plain value is withheld; select an explicit root from solverReport.roots.`;
  }

  return {
    moneyWeightedReturn: solverReport.value,
    ...(reason !== undefined ? { reason } : {}),
    solverReport,
    assumptions: {
      signConvention: SIGN_CONVENTION,
      asOf: first.valuationDate,
    },
    diagnostics: {
      warnings,
      scheduleRowCount: schedule.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// modifiedDietzReturn
// ---------------------------------------------------------------------------------------------------

/** One flow with the day-weight Modified Dietz applied to it. */
export interface ModifiedDietzFlowWeight {
  cashFlowDate: string;
  amount: number;
  /** `(daysInPeriod − daysSinceStart) / daysInPeriod` — 1 on the start date, 0 on the end date. */
  weight: number;
}

/** Input for {@link modifiedDietzReturn}. */
export interface ModifiedDietzReturnInput {
  /** EXACTLY the two period endpoints: the start and end valuations. */
  valuations: readonly PortfolioValuation[];
  externalCashFlows: readonly ExternalCashFlow[];
}

/** Result of {@link modifiedDietzReturn}. */
export interface ModifiedDietzReturnResult {
  /** `null` (with `reason`) when the average-capital denominator is not positive. */
  modifiedDietzReturn: number | null;
  /** Present exactly when `modifiedDietzReturn` is `null`. */
  reason?: string;
  /** The exact weight applied to each flow — exposed, never hidden. */
  flowWeights: ModifiedDietzFlowWeight[];
  assumptions: {
    weightFormula: string;
    dayCount: 'ACT (actual calendar days)';
  };
  diagnostics: {
    warnings: string[];
    flowCount: number;
    daysInPeriod: number;
  };
}

const MODIFIED_DIETZ_KEYS = ['valuations', 'externalCashFlows'] as const;

const MODIFIED_DIETZ_WEIGHT_FORMULA =
  'weight_i = (daysInPeriod − daysSinceStart_i) / daysInPeriod, with ACT (actual calendar day) counts ' +
  'between the strict calendar dates — a flow on the start date carries weight 1 (invested the ' +
  'whole period), a flow on the end date weight 0.';

/**
 * Classic Modified Dietz single-period return:
 * `(netAssetValue₁ − netAssetValue₀ − F) / (netAssetValue₀ + Σ weightᵢ·flowᵢ)` where `F` is the
 * net external flow and each `weightᵢ = (daysInPeriod − daysSinceStartᵢ) / daysInPeriod` under ACT day
 * counts. The weights actually used are exposed in `flowWeights`. When the average-capital
 * denominator is not positive the result is `null` with a reason — never a fabricated rate.
 */
export function modifiedDietzReturn(input: ModifiedDietzReturnInput): ModifiedDietzReturnResult {
  requireArgumentObject('modifiedDietzReturn', 'input', input);
  ensureKnownKeys('modifiedDietzReturn', 'input', input, MODIFIED_DIETZ_KEYS);
  requireValuations('modifiedDietzReturn', input.valuations, 2);
  if (input.valuations.length !== 2) {
    throw new InputError(
      `modifiedDietzReturn: valuations must be EXACTLY the two period endpoints [start, end] — Modified Dietz is a single-period estimator; compute per-period results and chain them with linkSubperiodReturns for longer windows. Received ${input.valuations.length} valuations.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'valuations' } },
    );
  }
  requireExternalCashFlows('modifiedDietzReturn', input.externalCashFlows);

  const start = input.valuations[0]!;
  const end = input.valuations[1]!;
  const startMilliseconds = isoDateToEpochMs(start.valuationDate);
  const endMilliseconds = isoDateToEpochMs(end.valuationDate);
  const daysInPeriod = Math.round((endMilliseconds - startMilliseconds) / MILLISECONDS_PER_DAY);

  const flowWeights: ModifiedDietzFlowWeight[] = input.externalCashFlows.map((flow, index) => {
    const flowMilliseconds = isoDateToEpochMs(flow.cashFlowDate);
    if (flowMilliseconds < startMilliseconds || flowMilliseconds > endMilliseconds) {
      throw new InputError(
        `modifiedDietzReturn: externalCashFlows[${index}] dated ${flow.cashFlowDate} lies outside the measurement window [${start.valuationDate}, ${end.valuationDate}] — every flow must fall between the two anchoring valuations.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `externalCashFlows[${index}].cashFlowDate` },
        },
      );
    }
    const daysSinceStart = Math.round(
      (flowMilliseconds - startMilliseconds) / MILLISECONDS_PER_DAY,
    );
    return {
      cashFlowDate: flow.cashFlowDate,
      amount: flow.amount,
      weight: (daysInPeriod - daysSinceStart) / daysInPeriod,
    };
  });

  let netFlow = 0;
  let weightedFlows = 0;
  for (const row of flowWeights) {
    netFlow += row.amount;
    weightedFlows += row.weight * row.amount;
  }

  const warnings: string[] = [];
  const denominator = start.netAssetValue + weightedFlows;
  let value: number | null;
  let reason: string | undefined;
  if (denominator <= 0) {
    value = null;
    reason = `the average-capital denominator (start net asset value + weighted flows = ${denominator}) is not positive — a rate of return on non-positive average capital is undefined.`;
  } else {
    value = (end.netAssetValue - start.netAssetValue - netFlow) / denominator;
  }

  return {
    modifiedDietzReturn: value,
    ...(reason !== undefined ? { reason } : {}),
    flowWeights,
    assumptions: {
      weightFormula: MODIFIED_DIETZ_WEIGHT_FORMULA,
      dayCount: 'ACT (actual calendar days)',
    },
    diagnostics: {
      warnings,
      flowCount: input.externalCashFlows.length,
      daysInPeriod,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// linkSubperiodReturns
// ---------------------------------------------------------------------------------------------------

/** Input for {@link linkSubperiodReturns}. */
export interface LinkSubperiodReturnsInput {
  subperiodReturns: readonly number[];
  /** REQUIRED and explicit — linking is a policy, never a guess. */
  linking: 'geometric' | 'arithmetic';
}

/** Result of {@link linkSubperiodReturns}. */
export interface LinkSubperiodReturnsResult {
  linkedReturn: number;
  assumptions: {
    linking: 'geometric' | 'arithmetic';
    formula: string;
  };
  diagnostics: {
    warnings: string[];
    subperiodCount: number;
  };
}

const LINK_KEYS = ['subperiodReturns', 'linking'] as const;

/**
 * Explicit subperiod linking: `'geometric'` compounds (`Π(1 + rᵢ) − 1`, the time-weighted
 * convention), `'arithmetic'` sums (`Σ rᵢ`, no compounding — an approximation that ignores
 * base drift). The policy is required; nothing is inferred.
 */
export function linkSubperiodReturns(input: LinkSubperiodReturnsInput): LinkSubperiodReturnsResult {
  requireArgumentObject('linkSubperiodReturns', 'input', input);
  ensureKnownKeys('linkSubperiodReturns', 'input', input, LINK_KEYS);
  requireArgumentArray('linkSubperiodReturns', 'subperiodReturns', input.subperiodReturns);
  if (input.subperiodReturns.length === 0) {
    throw new InputError('linkSubperiodReturns: subperiodReturns must not be empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'subperiodReturns' },
    });
  }
  input.subperiodReturns.forEach((subperiodReturn, index) => {
    if (typeof subperiodReturn !== 'number' || !Number.isFinite(subperiodReturn)) {
      throw new InputError(
        `linkSubperiodReturns: subperiodReturns[${index}] must be a finite simple return (decimal). Received ${subperiodReturn === null ? 'null' : typeof subperiodReturn}.`,
        { code: ErrorCode.InputWrongType, context: { field: `subperiodReturns[${index}]` } },
      );
    }
  });
  if (input.linking !== 'geometric' && input.linking !== 'arithmetic') {
    throw new InputError(
      `linkSubperiodReturns: linking must be 'geometric' (compound: Π(1 + r) − 1) or 'arithmetic' (sum: Σ r). Received ${input.linking === undefined ? 'undefined' : JSON.stringify(input.linking)}.\n  e.g. linkSubperiodReturns({ subperiodReturns: [0.02, -0.01], linking: 'geometric' })`,
      {
        code:
          input.linking === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
        context: { field: 'linking' },
      },
    );
  }

  const warnings: string[] = [];
  let linkedReturn: number;
  if (input.linking === 'geometric') {
    if (input.subperiodReturns.some((subperiodReturn) => subperiodReturn <= -1)) {
      warnings.push(
        'linkSubperiodReturns: a subperiod return at or below −100% makes its geometric linking factor non-positive — the linked product is arithmetic on signed factors past a total wipeout and should be read with care.',
      );
    }
    let factor = 1;
    for (const subperiodReturn of input.subperiodReturns) factor *= 1 + subperiodReturn;
    linkedReturn = factor - 1;
  } else {
    let sum = 0;
    for (const subperiodReturn of input.subperiodReturns) sum += subperiodReturn;
    linkedReturn = sum;
  }

  const result: LinkSubperiodReturnsResult = {
    linkedReturn,
    assumptions: {
      linking: input.linking,
      formula:
        input.linking === 'geometric'
          ? 'linkedReturn = Π(1 + subperiodReturn_i) − 1'
          : 'linkedReturn = Σ subperiodReturn_i (no compounding)',
    },
    diagnostics: {
      warnings,
      subperiodCount: input.subperiodReturns.length,
    },
  };
  assertFiniteValue('linkSubperiodReturns', result);
  return result;
}

// ---------------------------------------------------------------------------------------------------
// segmentExternalFlows
// ---------------------------------------------------------------------------------------------------

/** Per-account external-flow totals. `accountId` is `'unassigned'` for flows without one. */
export interface AccountFlowSegment {
  accountId: string;
  /** Sum of positive external amounts (≥ 0). */
  deposits: number;
  /** Sum of negative external amounts (≤ 0, kept signed so `net = deposits + withdrawals`). */
  withdrawals: number;
  net: number;
}

/** One identified transfer between two accounts of the SAME portfolio — internal, not external. */
export interface InternalTransfer {
  cashFlowDate: string;
  /** The positive magnitude moved. */
  amount: number;
  fromAccountId: string;
  toAccountId: string;
}

/** Input for {@link segmentExternalFlows}. */
export interface SegmentExternalFlowsInput {
  externalCashFlows: readonly ExternalCashFlow[];
  /**
   * Keep only flows whose `accountId` is listed (flows without an `accountId` are excluded by any
   * filter). Transfer identification runs BEFORE the filter so a filter can never orphan one leg.
   */
  accountFilter?: readonly string[];
}

/** Result of {@link segmentExternalFlows}. */
export interface SegmentExternalFlowsResult {
  /** Net EXTERNAL flow across the kept accounts — internal transfers contribute exactly zero. */
  externalNetAmount: number;
  byAccount: AccountFlowSegment[];
  internalTransfers: InternalTransfer[];
  assumptions: {
    transferIdentification: string;
    accountFilter: readonly string[] | 'none';
  };
  diagnostics: {
    warnings: string[];
    flowCount: number;
    internalTransferCount: number;
    excludedByFilterCount: number;
  };
}

const SEGMENT_KEYS = ['externalCashFlows', 'accountFilter'] as const;

const TRANSFER_IDENTIFICATION =
  'Two flows on the same date with the same absolute amount, opposite signs, and two DIFFERENT ' +
  'accountIds are one internal transfer between accounts of this portfolio — internal money ' +
  'movement, not external flow; both legs are removed from every external total (they net to zero ' +
  'external flow). Matching is deterministic first-match in input order, and transfer ' +
  'identification runs before accountFilter so a filter can never orphan one leg of a transfer.';

/**
 * External-flow segmentation: totals by account plus the net, with transfers BETWEEN accounts of
 * one portfolio identified and reported as internal — a transfer nets to zero external flow (the
 * acceptance law) and appears only in `internalTransfers`, never in the external totals.
 */
export function segmentExternalFlows(input: SegmentExternalFlowsInput): SegmentExternalFlowsResult {
  requireArgumentObject('segmentExternalFlows', 'input', input);
  ensureKnownKeys('segmentExternalFlows', 'input', input, SEGMENT_KEYS);
  requireExternalCashFlows('segmentExternalFlows', input.externalCashFlows);
  if (input.accountFilter !== undefined) {
    requireArgumentArray('segmentExternalFlows', 'accountFilter', input.accountFilter);
    input.accountFilter.forEach((accountId, index) => {
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new InputError(
          `segmentExternalFlows: accountFilter[${index}] must be a non-empty accountId string. Received ${accountId === null ? 'null' : JSON.stringify(accountId)}.`,
          { code: ErrorCode.InputWrongType, context: { field: `accountFilter[${index}]` } },
        );
      }
    });
  }

  const flows = input.externalCashFlows;
  const usedAsTransferLeg: boolean[] = new Array(flows.length).fill(false);
  const internalTransfers: InternalTransfer[] = [];
  // Identify transfers on the FULL flow set, before any filter.
  for (let i = 0; i < flows.length; i++) {
    const outgoing = flows[i]!;
    if (usedAsTransferLeg[i] || outgoing.accountId === undefined || outgoing.amount >= 0) continue;
    for (let j = 0; j < flows.length; j++) {
      const incoming = flows[j]!;
      if (
        j === i ||
        usedAsTransferLeg[j] ||
        incoming.accountId === undefined ||
        incoming.accountId === outgoing.accountId ||
        incoming.cashFlowDate !== outgoing.cashFlowDate ||
        incoming.amount !== -outgoing.amount
      ) {
        continue;
      }
      usedAsTransferLeg[i] = true;
      usedAsTransferLeg[j] = true;
      internalTransfers.push({
        cashFlowDate: outgoing.cashFlowDate,
        amount: -outgoing.amount,
        fromAccountId: outgoing.accountId,
        toAccountId: incoming.accountId,
      });
      break;
    }
  }

  const filterSet = input.accountFilter !== undefined ? new Set(input.accountFilter) : undefined;
  let excludedByFilterCount = 0;
  const segmentOrder: string[] = [];
  const segments = new Map<string, AccountFlowSegment>();
  const segmentAmounts = new Map<string, number[]>();
  const includedAmounts: number[] = [];
  let externalNetAmount = 0;
  for (let i = 0; i < flows.length; i++) {
    if (usedAsTransferLeg[i]) continue;
    const flow = flows[i]!;
    if (
      filterSet !== undefined &&
      (flow.accountId === undefined || !filterSet.has(flow.accountId))
    ) {
      excludedByFilterCount++;
      continue;
    }
    const accountId = flow.accountId !== undefined ? flow.accountId : 'unassigned';
    let segment = segments.get(accountId);
    if (segment === undefined) {
      segment = { accountId, deposits: 0, withdrawals: 0, net: 0 };
      segments.set(accountId, segment);
      segmentAmounts.set(accountId, []);
      segmentOrder.push(accountId);
    }
    if (flow.amount >= 0) {
      segment.deposits += flow.amount;
    } else {
      segment.withdrawals += flow.amount;
    }
    includedAmounts.push(flow.amount);
    segmentAmounts.get(accountId)!.push(flow.amount);
  }
  // stableSum for the SIGNED nets: deposits and withdrawals are same-sign running sums (overflow
  // there means the true subtotal is unrepresentable), but a net of near-MAX flows can cancel to a
  // perfectly representable number that left-to-right addition loses (2026-08-23, fourth review).
  externalNetAmount = stableSum(includedAmounts);
  for (const [accountId, amounts] of segmentAmounts) {
    segments.get(accountId)!.net = stableSum(amounts);
  }

  return requireRepresentableResult('segmentExternalFlows', {
    externalNetAmount,
    byAccount: segmentOrder.map((accountId) => segments.get(accountId)!),
    internalTransfers,
    assumptions: {
      transferIdentification: TRANSFER_IDENTIFICATION,
      accountFilter: input.accountFilter !== undefined ? input.accountFilter : 'none',
    },
    diagnostics: {
      warnings: [],
      flowCount: flows.length,
      internalTransferCount: internalTransfers.length,
      excludedByFilterCount,
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// portfolioReturnIndex
// ---------------------------------------------------------------------------------------------------

/** One point of a total-return index series. */
export interface ReturnIndexPoint {
  date: string;
  indexValue: number;
}

/** Input for {@link portfolioReturnIndex}. */
export interface PortfolioReturnIndexInput {
  valuations: readonly PortfolioValuation[];
  externalCashFlows: readonly ExternalCashFlow[];
  /** The index level at the first valuation date. Default `100`, echoed in `assumptions`. */
  baseValue?: number;
}

/** Result of {@link portfolioReturnIndex}. */
export interface PortfolioReturnIndexResult {
  /** `null` (with `reason`) under the null-on-any-gap policy — see `assumptions.gapPolicy`. */
  indexSeries: ReturnIndexPoint[] | null;
  /** Present exactly when `indexSeries` is `null`. */
  reason?: string;
  assumptions: {
    baseValue: number;
    gapPolicy: string;
    flowTiming: 'at-flow-timestamp';
    flowConvention: string;
    linking: 'geometric';
  };
  diagnostics: {
    warnings: string[];
    gaps: PerformanceGap[];
    flowCount: number;
    subperiodCount: number;
  };
}

const INDEX_KEYS = ['valuations', 'externalCashFlows', 'baseValue'] as const;

const GAP_POLICY =
  'null-on-any-gap: one missing mark breaks the chain — a total-return index with a hole is not ' +
  'one continuous series, so the whole index is withheld with a reason rather than restarted or ' +
  'forward-filled.';

/**
 * The portfolio's total-return index: the time-weighted subperiod returns (same flow convention
 * and gap rules as {@link timeWeightedReturn}) chained geometrically from `baseValue` at the first
 * valuation date. Gap policy — decided, documented, echoed: ANY gap makes the WHOLE index
 * `null` with a reason (`assumptions.gapPolicy`), because an index that silently restarts across
 * a hole misrepresents cumulative growth.
 */
export function portfolioReturnIndex(input: PortfolioReturnIndexInput): PortfolioReturnIndexResult {
  requireArgumentObject('portfolioReturnIndex', 'input', input);
  ensureKnownKeys('portfolioReturnIndex', 'input', input, INDEX_KEYS);
  requireValuations('portfolioReturnIndex', input.valuations, 2);
  requireExternalCashFlows('portfolioReturnIndex', input.externalCashFlows);
  if (input.baseValue !== undefined) {
    requireFiniteFields('portfolioReturnIndex', input, ['baseValue'], {
      exampleCall:
        "portfolioReturnIndex({ valuations: [{ valuationDate: '2024-01-01', netAssetValue: 1_000 }, { valuationDate: '2024-02-01', netAssetValue: 1_050 }], externalCashFlows: [], baseValue: 100 })",
    });
    if (input.baseValue <= 0) {
      throw new InputError(
        `portfolioReturnIndex: baseValue must be > 0 — an index base of ${input.baseValue} has no meaningful relative levels.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'baseValue' } },
      );
    }
  }
  const baseValue = input.baseValue !== undefined ? input.baseValue : 100;

  const outcome = computeTimeWeightedSubperiods(
    'portfolioReturnIndex',
    input.valuations,
    input.externalCashFlows,
  );

  let indexSeries: ReturnIndexPoint[] | null;
  let reason: string | undefined;
  if (outcome.gaps.length > 0) {
    indexSeries = null;
    reason = `${outcome.gaps.length} subperiod(s) are gaps — under the null-on-any-gap policy the whole index is withheld (see diagnostics.gaps) rather than restarted or forward-filled.`;
  } else {
    indexSeries = [{ date: input.valuations[0]!.valuationDate, indexValue: baseValue }];
    let level = baseValue;
    for (const subperiod of outcome.subperiods) {
      level *= 1 + subperiod.simpleReturn;
      indexSeries.push({ date: subperiod.endDate, indexValue: level });
    }
  }

  const result: PortfolioReturnIndexResult = {
    indexSeries,
    ...(reason !== undefined ? { reason } : {}),
    assumptions: {
      baseValue,
      gapPolicy: GAP_POLICY,
      flowTiming: 'at-flow-timestamp',
      flowConvention: FLOW_CONVENTION,
      linking: 'geometric',
    },
    diagnostics: {
      warnings: outcome.warnings,
      gaps: outcome.gaps,
      flowCount: input.externalCashFlows.length,
      subperiodCount: outcome.subperiods.length,
    },
  };
  // Law 7: a finite-input overflow must never leave here as a successful Infinity.
  assertFiniteValue('portfolioReturnIndex', result);
  return result;
}

// ---------------------------------------------------------------------------------------------------
// benchmarkRelativeTimeline
// ---------------------------------------------------------------------------------------------------

/** One benchmark observation: the simple return of the period ENDING on `date`. */
export interface BenchmarkReturnObservation {
  date: string;
  simpleReturn: number;
}

/** One aligned relative-performance row. */
export interface BenchmarkRelativeRow {
  date: string;
  /** Portfolio index level relative to the anchor level, minus one. */
  portfolioCumulativeReturn: number;
  /** Compounded benchmark returns from just after the anchor through this date, minus one. */
  benchmarkCumulativeReturn: number;
  /** Geometric excess: `(1 + portfolioCumulative) / (1 + benchmarkCumulative) − 1`. */
  relativePerformance: number;
}

/** Input for {@link benchmarkRelativeTimeline}. */
export interface BenchmarkRelativeTimelineInput {
  portfolioIndex: readonly ReturnIndexPoint[];
  benchmarkReturns: readonly BenchmarkReturnObservation[];
  /** REQUIRED — a benchmark states its basis; price-return omits dividend/income return. */
  benchmarkBasis: 'total-return' | 'price-return';
}

/** Result of {@link benchmarkRelativeTimeline}. */
export interface BenchmarkRelativeTimelineResult {
  rows: BenchmarkRelativeRow[];
  assumptions: {
    benchmarkBasis: 'total-return' | 'price-return';
    relativeMethod: string;
    anchorDate: string;
    benchmarkReturnConvention: string;
  };
  diagnostics: {
    warnings: string[];
    gaps: PerformanceGap[];
    rowCount: number;
  };
}

const TIMELINE_KEYS = ['portfolioIndex', 'benchmarkReturns', 'benchmarkBasis'] as const;
const PORTFOLIO_INDEX_POINT_KEYS = ['date', 'indexValue'] as const;
const BENCHMARK_RETURN_KEYS = ['date', 'simpleReturn'] as const;

/**
 * Benchmark-relative timeline: aligns a portfolio total-return index with benchmark period
 * returns BY DATE and reports cumulative relative performance rows. A row exists only where BOTH
 * a portfolio index value and a benchmark return dated exactly that day exist; missing dates on
 * either side become `diagnostics.gaps` — never interpolated. Benchmark observations on
 * non-portfolio dates are real growth: they still compound into the benchmark cumulative at the
 * next aligned row (compounding observed returns is not interpolation), and their absence of a
 * row is recorded as a gap.
 */
export function benchmarkRelativeTimeline(
  input: BenchmarkRelativeTimelineInput,
): BenchmarkRelativeTimelineResult {
  requireArgumentObject('benchmarkRelativeTimeline', 'input', input);
  ensureKnownKeys('benchmarkRelativeTimeline', 'input', input, TIMELINE_KEYS);
  requireArgumentArray('benchmarkRelativeTimeline', 'portfolioIndex', input.portfolioIndex);
  if (input.portfolioIndex.length === 0) {
    throw new InputError(
      'benchmarkRelativeTimeline: portfolioIndex must not be empty — the first point anchors the timeline.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'portfolioIndex' } },
    );
  }
  input.portfolioIndex.forEach((point, index) => {
    requireArgumentObject('benchmarkRelativeTimeline', `portfolioIndex[${index}]`, point);
    ensureKnownKeys(
      'benchmarkRelativeTimeline',
      `portfolioIndex[${index}]`,
      point,
      PORTFOLIO_INDEX_POINT_KEYS,
    );
    requireStrictDate('benchmarkRelativeTimeline', `portfolioIndex[${index}].date`, point.date);
    if (
      typeof point.indexValue !== 'number' ||
      !Number.isFinite(point.indexValue) ||
      point.indexValue <= 0
    ) {
      throw new InputError(
        `benchmarkRelativeTimeline: portfolioIndex[${index}].indexValue must be a finite number > 0. Received ${point.indexValue === null ? 'null' : typeof point.indexValue === 'number' ? point.indexValue : typeof point.indexValue}.`,
        {
          code:
            typeof point.indexValue === 'number' && Number.isFinite(point.indexValue)
              ? ErrorCode.InputOutOfRange
              : ErrorCode.InputWrongType,
          context: { field: `portfolioIndex[${index}].indexValue` },
        },
      );
    }
  });
  requireArgumentArray('benchmarkRelativeTimeline', 'benchmarkReturns', input.benchmarkReturns);
  input.benchmarkReturns.forEach((observation, index) => {
    requireArgumentObject('benchmarkRelativeTimeline', `benchmarkReturns[${index}]`, observation);
    ensureKnownKeys(
      'benchmarkRelativeTimeline',
      `benchmarkReturns[${index}]`,
      observation,
      BENCHMARK_RETURN_KEYS,
    );
    requireStrictDate(
      'benchmarkRelativeTimeline',
      `benchmarkReturns[${index}].date`,
      observation.date,
    );
    if (
      typeof observation.simpleReturn !== 'number' ||
      !Number.isFinite(observation.simpleReturn)
    ) {
      throw new InputError(
        `benchmarkRelativeTimeline: benchmarkReturns[${index}].simpleReturn must be a finite simple return (decimal). Received ${observation.simpleReturn === null ? 'null' : typeof observation.simpleReturn}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `benchmarkReturns[${index}].simpleReturn` },
        },
      );
    }
    if (observation.simpleReturn <= -1) {
      throw new InputError(
        `benchmarkRelativeTimeline: benchmarkReturns[${index}].simpleReturn must be > −1 — a period return at or below −100% has no positive growth factor to compound. Received ${observation.simpleReturn}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `benchmarkReturns[${index}].simpleReturn` },
        },
      );
    }
  });
  for (const [field, series] of [
    ['portfolioIndex', input.portfolioIndex.map((point) => point.date)],
    ['benchmarkReturns', input.benchmarkReturns.map((observation) => observation.date)],
  ] as const) {
    for (let index = 1; index < series.length; index++) {
      if (isoDateToEpochMs(series[index]!) <= isoDateToEpochMs(series[index - 1]!)) {
        throw new InputError(
          `benchmarkRelativeTimeline: ${field} must be strictly ascending by date — ${field}[${index}] (${series[index]}) does not follow ${field}[${index - 1}] (${series[index - 1]}).`,
          { code: ErrorCode.InputOutOfRange, context: { field: `${field}[${index}].date` } },
        );
      }
    }
  }
  if (input.benchmarkBasis !== 'total-return' && input.benchmarkBasis !== 'price-return') {
    throw new InputError(
      `benchmarkRelativeTimeline: benchmarkBasis is REQUIRED — a benchmark states its basis: 'total-return' (dividends/income reinvested) or 'price-return' (price only). Received ${input.benchmarkBasis === undefined ? 'undefined' : JSON.stringify(input.benchmarkBasis)}.\n  e.g. benchmarkRelativeTimeline({ portfolioIndex, benchmarkReturns, benchmarkBasis: 'total-return' })`,
      {
        code:
          input.benchmarkBasis === undefined
            ? ErrorCode.InputMissingField
            : ErrorCode.InputInvalidEnum,
        context: { field: 'benchmarkBasis' },
      },
    );
  }

  const warnings: string[] = [];
  const gaps: PerformanceGap[] = [];
  const anchor = input.portfolioIndex[0]!;
  const anchorMilliseconds = isoDateToEpochMs(anchor.date);
  const lastPortfolioDate = input.portfolioIndex[input.portfolioIndex.length - 1]!.date;
  const portfolioDateSet = new Set(input.portfolioIndex.map((point) => point.date));

  if (input.benchmarkBasis === 'price-return') {
    warnings.push(
      'benchmarkRelativeTimeline: the benchmark is a price-return series — dividend/income return is absent from the benchmark side, so relative performance overstates the portfolio against a total-return reading of the same benchmark.',
    );
  }
  if (input.portfolioIndex.length === 1) {
    warnings.push(
      'benchmarkRelativeTimeline: a single portfolio index point anchors the timeline but yields no comparison rows.',
    );
  }

  const rows: BenchmarkRelativeRow[] = [];
  let benchmarkFactor = 1;
  let observationIndex = 0;
  // Benchmark observations at or before the anchor precede the measured window.
  while (
    observationIndex < input.benchmarkReturns.length &&
    isoDateToEpochMs(input.benchmarkReturns[observationIndex]!.date) <= anchorMilliseconds
  ) {
    const observation = input.benchmarkReturns[observationIndex]!;
    gaps.push({
      fromDate: observation.date,
      toDate: observation.date,
      reason: `benchmark return dated ${observation.date} is at or before the anchor date ${anchor.date} — no relative row precedes the anchor; the observation is excluded, never interpolated.`,
    });
    observationIndex++;
  }
  for (let pointIndex = 1; pointIndex < input.portfolioIndex.length; pointIndex++) {
    const point = input.portfolioIndex[pointIndex]!;
    const pointMilliseconds = isoDateToEpochMs(point.date);
    let matchedObservation = false;
    while (
      observationIndex < input.benchmarkReturns.length &&
      isoDateToEpochMs(input.benchmarkReturns[observationIndex]!.date) <= pointMilliseconds
    ) {
      const observation = input.benchmarkReturns[observationIndex]!;
      benchmarkFactor *= 1 + observation.simpleReturn;
      if (observation.date === point.date) {
        matchedObservation = true;
      } else if (!portfolioDateSet.has(observation.date)) {
        gaps.push({
          fromDate: observation.date,
          toDate: observation.date,
          reason: `benchmark return dated ${observation.date} has no portfolio index value dated the same day — no relative row exists there; the observed return still compounds into the benchmark cumulative at the next aligned row (never interpolated).`,
        });
      }
      observationIndex++;
    }
    if (!matchedObservation) {
      gaps.push({
        fromDate: point.date,
        toDate: point.date,
        reason: `portfolio index value dated ${point.date} has no benchmark return dated the same day — no relative row exists there; missing observations are never interpolated.`,
      });
      continue;
    }
    const portfolioFactor = point.indexValue / anchor.indexValue;
    rows.push({
      date: point.date,
      portfolioCumulativeReturn: portfolioFactor - 1,
      benchmarkCumulativeReturn: benchmarkFactor - 1,
      relativePerformance: portfolioFactor / benchmarkFactor - 1,
    });
  }
  while (observationIndex < input.benchmarkReturns.length) {
    const observation = input.benchmarkReturns[observationIndex]!;
    gaps.push({
      fromDate: observation.date,
      toDate: observation.date,
      reason: `benchmark return dated ${observation.date} is after the final portfolio index date ${lastPortfolioDate} — no aligned row can absorb it; the observation is excluded, never interpolated.`,
    });
    observationIndex++;
  }

  if (rows.length === 0 && input.portfolioIndex.length > 1) {
    warnings.push(
      'benchmarkRelativeTimeline: no aligned dates — every candidate row is a gap (see diagnostics.gaps).',
    );
  }

  return requireRepresentableResult('benchmarkRelativeTimeline', {
    rows,
    assumptions: {
      benchmarkBasis: input.benchmarkBasis,
      relativeMethod:
        'geometric — relativePerformance = (1 + portfolioCumulativeReturn) / (1 + benchmarkCumulativeReturn) − 1',
      anchorDate: anchor.date,
      benchmarkReturnConvention:
        'a benchmark return dated D is the simple return of the period ENDING at D; observations between aligned dates compound into the next aligned row.',
    },
    diagnostics: {
      warnings,
      gaps,
      rowCount: rows.length,
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// contributionByGroup
// ---------------------------------------------------------------------------------------------------

/** One group's weight and simple return over ONE period. */
export interface GroupReturn {
  groupLabel: string;
  /** The group's weight of the portfolio over the period (may be negative or exceed 1). */
  weight: number;
  simpleReturn: number;
}

/** One group's contribution row. */
export interface GroupContribution {
  groupLabel: string;
  weight: number;
  simpleReturn: number;
  /** `weight × simpleReturn`. */
  contribution: number;
}

/** Input for {@link contributionByGroup}. */
export interface ContributionByGroupInput {
  /** ONE period's per-group weights and returns (position/account/strategy/asset class/…). */
  groupReturns: readonly GroupReturn[];
}

/** Result of {@link contributionByGroup}. */
export interface ContributionByGroupResult {
  contributions: GroupContribution[];
  /** The weighted total return `Σ weightᵢ · simpleReturnᵢ` the contributions reconcile to. */
  totalReturn: number;
  assumptions: {
    formula: string;
    scope: 'single-period';
  };
  diagnostics: {
    warnings: string[];
    groupCount: number;
    weightSum: number;
    /** `totalReturn − Σ contributionᵢ` — identically 0 at single-period scope (the linking-residual law). */
    reconciliationResidual: number;
  };
}

const CONTRIBUTION_KEYS = ['groupReturns'] as const;
const GROUP_RETURN_KEYS = ['groupLabel', 'weight', 'simpleReturn'] as const;

/**
 * Single-period contribution by group: `contribution = weight × simpleReturn` per group, summing
 * to the weighted total return. At single-period scope the reconciliation is exact — the residual
 * (disclosed in `diagnostics.reconciliationResidual`) is 0 within 1e-12, the linking-residual law
 * with no linking involved.
 */
export function contributionByGroup(input: ContributionByGroupInput): ContributionByGroupResult {
  requireArgumentObject('contributionByGroup', 'input', input);
  ensureKnownKeys('contributionByGroup', 'input', input, CONTRIBUTION_KEYS);
  requireArgumentArray('contributionByGroup', 'groupReturns', input.groupReturns);
  if (input.groupReturns.length === 0) {
    throw new InputError('contributionByGroup: groupReturns must not be empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'groupReturns' },
    });
  }
  input.groupReturns.forEach((group, index) => {
    requireArgumentObject('contributionByGroup', `groupReturns[${index}]`, group);
    ensureKnownKeys('contributionByGroup', `groupReturns[${index}]`, group, GROUP_RETURN_KEYS);
    if (typeof group.groupLabel !== 'string' || group.groupLabel.length === 0) {
      throw new InputError(
        `contributionByGroup: groupReturns[${index}].groupLabel must be a non-empty string. Received ${group.groupLabel === null ? 'null' : JSON.stringify(group.groupLabel)}.`,
        { code: ErrorCode.InputWrongType, context: { field: `groupReturns[${index}].groupLabel` } },
      );
    }
    for (const field of ['weight', 'simpleReturn'] as const) {
      if (typeof group[field] !== 'number' || !Number.isFinite(group[field])) {
        throw new InputError(
          `contributionByGroup: groupReturns[${index}].${field} must be a finite number. Received ${group[field] === null ? 'null' : typeof group[field]}.`,
          { code: ErrorCode.InputWrongType, context: { field: `groupReturns[${index}].${field}` } },
        );
      }
    }
  });

  const contributions: GroupContribution[] = input.groupReturns.map((group) => {
    return {
      groupLabel: group.groupLabel,
      weight: group.weight,
      simpleReturn: group.simpleReturn,
      contribution: group.weight * group.simpleReturn,
    };
  });
  const totalReturn = stableSum(
    input.groupReturns.map((group) => group.weight * group.simpleReturn),
  );
  const weightSum = stableSum(input.groupReturns.map((group) => group.weight));
  const totalContribution = stableSum(contributions.map((row) => row.contribution));

  const warnings: string[] = [];
  if (Math.abs(weightSum - 1) > 1e-8) {
    warnings.push(
      `contributionByGroup: group weights sum to ${weightSum}, not 1 (tolerance 1e-8) — the contributions reconcile to the weighted total of the SUPPLIED groups, not to a fully allocated portfolio return.`,
    );
  }

  return requireRepresentableResult('contributionByGroup', {
    contributions,
    totalReturn,
    assumptions: {
      formula:
        'contribution_i = weight_i × simpleReturn_i over one period; totalReturn = Σ weight_i × simpleReturn_i',
      scope: 'single-period',
    },
    diagnostics: {
      warnings,
      groupCount: input.groupReturns.length,
      weightSum,
      reconciliationResidual: totalReturn - totalContribution,
    },
  });
}
