/**
 * `portfolioTimeline` — NAV, cash, external flows, exposure, drawdown, and P&L components at
 * explicit marks (FC7 slice 2, 2026-08-28; agent-native "Performance through time"). The caller
 * chooses the marks; a mark that cannot value the book is a typed failure, never a forward-fill.
 *
 * Nothing here is a second engine: each step's P&L components are the `portfolioPnl` kernel over
 * consecutive marks — the step TOTALS telescope to the whole window's investment return exactly
 * (tested), and the components telescope too within one currency; across currencies the split
 * between a component and foreign-exchange P&L is path-dependent (each step translates at its own
 * closing quote), which is disclosed rather than hidden. The
 * return index and drawdown are `@insiderfinance/totalfinance/performance`'s `portfolioReturnIndex` and `underwater`
 * over the exact series `portfolioPerformanceInputs` emits (FC4 reuse), and exposure by group is
 * the mark's positions grouped by the same classification the P&L uses.
 */

import type { EpochMs } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ensureKnownKeys,
  requireArgumentObject,
  requireRepresentableResult,
  stableSum,
} from '@totalfinance/core';
import type {
  ExternalCashFlow,
  PerformanceGap,
  PortfolioValuation,
} from '@totalfinance/performance';
import { portfolioReturnIndex, underwater } from '@totalfinance/performance';
import { deepFreeze, ownValue, positionGroupingLabel } from './internal.js';
import type { PortfolioLedger } from './ledger.js';
import type { MarkWindow, PortfolioValuationMark } from './marks.js';
import { foldToMarks, requireValuationMarks } from './marks.js';
import { portfolioPerformanceInputs } from './performance.js';
import type {
  InstrumentClassification,
  PortfolioGroupingDimension,
  PortfolioPnlComponents,
} from './pnl.js';
import { GROUPING_DIMENSIONS, computePnlWindow, requireInstrumentClassification } from './pnl.js';
import type { LotReliefPolicy } from './state.js';
import { requirePortfolioLedger } from './state.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

export interface PortfolioExposure {
  /** Σ positive position base values. */
  long: number;
  /** Σ |negative position base values| (a positive magnitude). */
  short: number;
  /** `long + short`. */
  gross: number;
  /** `long − short`. */
  net: number;
  /** `gross / netAssetValue`, `null` when NAV is 0. */
  grossLeverage: number | null;
}

export interface PortfolioExposureGroupRow {
  label: string;
  /** The group's notional exposure in base currency (quantity × mark × multiplier), signed. */
  baseCurrencyNotionalValue: number;
}

export interface PortfolioExposureGrouping {
  dimension: PortfolioGroupingDimension;
  rows: PortfolioExposureGroupRow[];
  /** `Σ rows − positions base value`; 0 within 1e-9 for partitioning dimensions. */
  reconciliationResidual: number;
  reconciles: boolean;
  reason?: string;
}

export interface PortfolioTimelineRow {
  valuationDate: string;
  asOf: EpochMs;
  netAssetValue: number;
  cashBaseCurrencyValue: number;
  positionsBaseCurrencyValue: number;
  exposure: PortfolioExposure;
  exposureByGroup: PortfolioExposureGrouping[];
  /** Deposits − withdrawals since the prior mark, in base at this mark's quotes; 0 on the first row. */
  externalFlowsSincePrior: number;
  /** The `portfolioPnl` kernel over [prior mark, this mark); `null` on the first row. */
  pnlSincePrior: (PortfolioPnlComponents & { residual: number }) | null;
  /** FC4's total-return index at this mark (`null` when the index is withheld — see diagnostics). */
  indexValue: number | null;
  /** Drawdown from the running index peak as a positive fraction (`null` with the index). */
  drawdown: number | null;
}

export interface PortfolioTimelineInput {
  ledger: PortfolioLedger;
  /** At least two marks, strictly ascending by date. */
  valuationMarks: readonly PortfolioValuationMark[];
  instrumentClassification?: Record<string, InstrumentClassification>;
}

export interface PortfolioTimelineResult {
  baseCurrency: string;
  rows: PortfolioTimelineRow[];
  /** The exact FC4 series behind the index — feed straight to timeWeightedReturn / moneyWeightedReturn. */
  valuations: PortfolioValuation[];
  externalCashFlows: ExternalCashFlow[];
  /**
   * `Σ rows.pnlSincePrior` per component. `totalPnl` equals `portfolioPnl(first, last)`'s
   * investment return exactly; individual components equal it only when every currency is the
   * base — otherwise each step's closing-quote translation moves value between a component and
   * `foreignExchangePnl` (path-dependent attribution, stated in `assumptions.markInstant`).
   */
  cumulativePnl: PortfolioPnlComponents & { residual: number };
  /** Worst drawdown from the index, `null` when the index is withheld. */
  maxDrawdown: number | null;
  assumptions: {
    conventionsVersion: string;
    lotRelief: LotReliefPolicy;
    markInstant: string;
    indexConvention: string;
    exposureConvention: string;
  };
  diagnostics: {
    warnings: string[];
    markCount: number;
    /** Why the index (and drawdown) is null, when it is. */
    indexWithheldReason?: string;
    gaps: PerformanceGap[];
  };
}

const INPUT_KEYS = ['ledger', 'valuationMarks', 'instrumentClassification'] as const;
const RESIDUAL_TOLERANCE = 1e-9;
const UNCLASSIFIED = 'unclassified';

const MARK_INSTANT =
  'A mark dated D values the fold of every event with effectiveTimestampMs strictly before 00:00 ' +
  'UTC of D — the mark lands BEFORE any external flow dated D, exactly FC4’s flow convention; ' +
  'external flows since the prior mark convert at THIS mark’s quotes (the P&L identity ' +
  'convention), while the FC4 series converts each flow at its own flow-date mark.';
const INDEX_CONVENTION =
  'indexValue is @insiderfinance/totalfinance/performance portfolioReturnIndex over the FC4 series (base value 1, ' +
  'geometric linking, flows at-flow-timestamp); drawdown is underwater() over that index — a ' +
  'flow-adjusted decline, so a withdrawal is never mistaken for a loss. One missing mark withholds ' +
  'the whole index with a reason rather than restarting it.';
const EXPOSURE_CONVENTION =
  'Exposure is position NOTIONAL value in base currency at the mark (quantity × mark × ' +
  'multiplier — a variation-margin position’s full notional, not its unsettled P&L): long = Σ positive values, ' +
  'short = Σ |negative values|, gross = long + short, net = long − short; cash is not exposure. ' +
  'exposureByGroup partitions the same positions by the caller’s classification (tags overlap and ' +
  'do not partition).';
const EXAMPLE_CALL =
  "portfolioTimeline({ ledger, valuationMarks: [{ valuationDate: '2026-01-02', market: m1 }, { valuationDate: '2026-02-01', market: m2 }] })";

function exposureAt(
  window: MarkWindow,
  classification: Record<string, InstrumentClassification>,
): { exposure: PortfolioExposure; byGroup: PortfolioExposureGrouping[] } {
  const rows = window.valued.positions;
  const long = stableSum(rows.map((row) => Math.max(0, row.baseCurrencyNotionalValue)));
  const short = stableSum(rows.map((row) => Math.max(0, -row.baseCurrencyNotionalValue)));
  const gross = long + short;
  const nav = window.valued.netAssetValue;
  const exposure: PortfolioExposure = {
    long,
    short,
    gross,
    net: long - short,
    grossLeverage: nav === 0 ? null : gross / nav,
  };
  const total = stableSum(rows.map((row) => row.baseCurrencyNotionalValue));
  const labelsFor = (
    dimension: PortfolioGroupingDimension,
    row: (typeof rows)[number],
  ): string[] => {
    const meta = ownValue(classification, row.instrumentId) ?? {};
    switch (dimension) {
      case 'position':
        return [positionGroupingLabel(row.accountId, row.instrumentId)];
      case 'instrument':
        return [row.instrumentId];
      case 'account':
        return [row.accountId];
      case 'currency':
        return [row.currency];
      case 'underlying':
        return [meta.underlying ?? UNCLASSIFIED];
      case 'assetClass':
        return [meta.assetClass ?? UNCLASSIFIED];
      case 'strategy':
        return [meta.strategy ?? UNCLASSIFIED];
      case 'tag':
        return meta.tags && meta.tags.length > 0 ? meta.tags : [UNCLASSIFIED];
      default:
        return [UNCLASSIFIED];
    }
  };
  const byGroup = GROUPING_DIMENSIONS.map((dimension) => {
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      for (const label of labelsFor(dimension, row)) {
        const bucket = buckets.get(label) ?? [];
        bucket.push(row.baseCurrencyNotionalValue);
        buckets.set(label, bucket);
      }
    }
    const groupRows = [...buckets.keys()].sort().map((label) => ({
      label,
      baseCurrencyNotionalValue: stableSum(buckets.get(label)!),
    }));
    const reconciliationResidual =
      stableSum(groupRows.map((row) => row.baseCurrencyNotionalValue)) - total;
    const overlapping = dimension === 'tag';
    const reconciles =
      !overlapping &&
      Math.abs(reconciliationResidual) <= RESIDUAL_TOLERANCE * Math.max(1, Math.abs(total));
    return {
      dimension,
      rows: groupRows,
      reconciliationResidual,
      reconciles,
      ...(reconciles
        ? {}
        : {
            reason: overlapping
              ? 'tags overlap — an instrument may carry several, so tag rows double-count by design and do not partition the total'
              : `the ${dimension} rows leave ${reconciliationResidual} of the positions value unexplained`,
          }),
    };
  });
  return { exposure, byGroup };
}

/**
 * NAV, cash, flows, exposure, drawdown, and P&L components through time — see the module comment.
 */
export function portfolioTimeline(input: PortfolioTimelineInput): PortfolioTimelineResult {
  const functionName = 'portfolioTimeline';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioLedger(functionName, 'ledger', input.ledger);
  requireValuationMarks(functionName, input.valuationMarks, 2, EXAMPLE_CALL);
  const classification = requireInstrumentClassification(
    functionName,
    input.instrumentClassification,
  );

  const windows = foldToMarks(input.ledger, input.valuationMarks);
  const warnings: string[] = [];

  // The FC4 series and index — one call, the same convention the seam publishes.
  const series = portfolioPerformanceInputs({
    ledger: input.ledger,
    valuationMarks: input.valuationMarks,
  });
  warnings.push(...series.diagnostics.warnings);
  const index = portfolioReturnIndex({
    valuations: series.valuations,
    externalCashFlows: series.externalCashFlows,
    // Stated explicitly (FC4 defaults to 100): an index that starts at 1 reads as a growth factor.
    baseValue: 1,
  });
  warnings.push(...index.diagnostics.warnings.map((w) => `${functionName}: ${w}`));
  const indexByDate = new Map<string, number>();
  let drawdownByDate = new Map<string, number>();
  if (index.indexSeries !== null) {
    for (const point of index.indexSeries) indexByDate.set(point.date, point.indexValue);
    const values = index.indexSeries.map((point) => point.indexValue);
    const under = underwater(values);
    drawdownByDate = new Map(index.indexSeries.map((point, i) => [point.date, under[i]!]));
  }

  const rows: PortfolioTimelineRow[] = [];
  const cumulative = {
    realizedPnl: [] as number[],
    unrealizedPnl: [] as number[],
    income: [] as number[],
    transactionCosts: [] as number[],
    financing: [] as number[],
    foreignExchangePnl: [] as number[],
    totalPnl: [] as number[],
    residual: [] as number[],
  };
  windows.forEach((window, i) => {
    for (const w of window.valued.diagnostics.warnings) {
      warnings.push(`${window.mark.valuationDate}: ${w}`);
    }
    const { exposure, byGroup } = exposureAt(window, classification);
    let externalFlowsSincePrior = 0;
    let pnlSincePrior: PortfolioTimelineRow['pnlSincePrior'] = null;
    if (i > 0) {
      const step = computePnlWindow(
        functionName,
        input.ledger,
        windows[i - 1]!,
        window,
        classification,
      );
      warnings.push(...step.warnings);
      externalFlowsSincePrior = step.externalFlows;
      pnlSincePrior = { ...step.components, residual: step.residual };
      for (const key of Object.keys(cumulative) as (keyof typeof cumulative)[]) {
        cumulative[key].push(pnlSincePrior[key]);
      }
    }
    const date = window.mark.valuationDate;
    rows.push({
      valuationDate: date,
      asOf: window.instant,
      netAssetValue: window.valued.netAssetValue,
      cashBaseCurrencyValue: window.valued.totalCashBaseCurrencyValue,
      positionsBaseCurrencyValue: window.valued.totalPositionsBaseCurrencyValue,
      exposure,
      exposureByGroup: byGroup,
      externalFlowsSincePrior,
      pnlSincePrior,
      indexValue: indexByDate.get(date) ?? null,
      drawdown: drawdownByDate.get(date) ?? null,
    });
  });

  const cumulativePnl = {
    realizedPnl: stableSum(cumulative.realizedPnl),
    unrealizedPnl: stableSum(cumulative.unrealizedPnl),
    income: stableSum(cumulative.income),
    transactionCosts: stableSum(cumulative.transactionCosts),
    financing: stableSum(cumulative.financing),
    foreignExchangePnl: stableSum(cumulative.foreignExchangePnl),
    totalPnl: stableSum(cumulative.totalPnl),
    residual: stableSum(cumulative.residual),
  };
  const drawdowns = [...drawdownByDate.values()];

  return deepFreeze(
    requireRepresentableResult(functionName, {
      baseCurrency: input.ledger.state.baseCurrency,
      rows,
      valuations: series.valuations,
      externalCashFlows: series.externalCashFlows,
      cumulativePnl,
      maxDrawdown: index.indexSeries === null ? null : Math.max(0, ...drawdowns),
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        lotRelief: input.ledger.state.lotRelief,
        markInstant: MARK_INSTANT,
        indexConvention: INDEX_CONVENTION,
        exposureConvention: EXPOSURE_CONVENTION,
      },
      diagnostics: {
        warnings,
        markCount: windows.length,
        ...(index.indexSeries === null && index.reason !== undefined
          ? { indexWithheldReason: index.reason }
          : {}),
        gaps: index.diagnostics.gaps,
      },
    }),
  );
}
