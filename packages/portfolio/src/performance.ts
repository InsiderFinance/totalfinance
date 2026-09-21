/**
 * `@totalfinance/portfolio/performance` — the P&L reconciliation seam between the ledger and FC4's
 * flow-aware performance calls (`@totalfinance/performance`).
 *
 * The ledger FEEDS `timeWeightedReturn` / `moneyWeightedReturn` / `modifiedDietzReturn`; it never
 * re-implements them (agent-native Permanent law "No second engine"; FC7 exit gate: "TWR/MWR
 * consume the exact ledger flows and marks and match FC4 direct calls"). The output types here
 * ARE FC4's `PortfolioValuation` and `ExternalCashFlow`, imported from `@totalfinance/performance` —
 * not structural copies — so the seam cannot drift from the consumer.
 *
 * Convention agreement, stated once and tested: FC4's time-weighted convention is "a valuation
 * dated D marks the portfolio BEFORE any external flow dated D lands". This seam therefore values
 * each `valuationDate` D at 00:00 UTC of D over the ledger prefix
 * `effectiveTimestampMs < that instant` — every event dated D has a timestamp at or after 00:00
 * UTC of D, so the mark always lands first. External flows are deposits (+) and withdrawals (−)
 * ONLY: internal transfers net to zero inside the portfolio and currency conversions move value
 * between currencies; neither crosses the portfolio boundary ("Transfers and contributions remain
 * external flows rather than trading gains" — agent-native "Performance through time").
 */

import {
  requireRepresentableResult,
  CONVENTIONS_VERSION,
  DataError,
  ErrorCode,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import type { ExternalCashFlow, PortfolioValuation } from '@totalfinance/performance';
import type { CashDepositEvent, CashWithdrawalEvent } from './events.js';
import { convertWithQuotes, deepFreeze, epochMsToUtcDate } from './internal.js';
import type { PortfolioLedger } from './ledger.js';
import type { PortfolioValuationMark } from './marks.js';
import { foldToMarks, requireValuationMarks } from './marks.js';
import { requirePortfolioLedger } from './state.js';

// Subpath completeness: `@totalfinance/portfolio/performance` consumers can name the quote type.
export type { CurrencyPairQuote } from './internal.js';

/** One dated valuation mark: the market (and any FX quotes) to value the ledger with on a date. */
export type { PortfolioValuationMark } from './marks.js';

/** Input for {@link portfolioPerformanceInputs}. */
export interface PortfolioPerformanceInputsInput {
  ledger: PortfolioLedger;
  /** At least two marks, strictly ascending by date — a return is measured BETWEEN valuations. */
  valuationMarks: readonly PortfolioValuationMark[];
}

/** Result of {@link portfolioPerformanceInputs} — FC4's exact input series. */
export interface PortfolioPerformanceInputsResult {
  /** Feed directly to `timeWeightedReturn` / `moneyWeightedReturn` as `valuations`. */
  valuations: PortfolioValuation[];
  /** Feed directly as `externalCashFlows`; `label` carries the source `eventId`. */
  externalCashFlows: ExternalCashFlow[];
  assumptions: {
    conventionsVersion: string;
    /** Prose statement of the mark instant and its agreement with FC4's flow convention. */
    markInstant: string;
    /** Prose statement of which events are external flows and how they convert. */
    flowMapping: string;
  };
  diagnostics: {
    warnings: string[];
    markCount: number;
    flowCount: number;
    /** Deposits/withdrawals outside the [first, last] mark window — excluded, disclosed. */
    excludedFlowCount: number;
  };
}

const INPUT_KEYS = ['ledger', 'valuationMarks'] as const;

const MARK_INSTANT_PROSE =
  'Each valuationDate D is valued at 00:00 UTC of D over the ledger prefix with ' +
  'effectiveTimestampMs strictly before that instant, so the mark lands BEFORE any external flow ' +
  'dated D — the exact flow convention timeWeightedReturn states (mark first, then flow).';

const FLOW_MAPPING_PROSE =
  'External flows are cash.deposit (+amount) and cash.withdrawal (−amount) only, dated by the UTC ' +
  'calendar date of effectiveTimestampMs, with label = the source eventId. Internal cash.transfer ' +
  'legs net to zero inside the portfolio and cash.conversion moves value between currencies — ' +
  'neither crosses the portfolio boundary, so neither is an external flow. A non-base-currency ' +
  'flow converts at the SAME-DATE valuation mark’s currencyConversions quote (FC5 arithmetic); ' +
  'flows outside the [first, last] mark window are excluded and counted in ' +
  'diagnostics.excludedFlowCount.';

const EXAMPLE_CALL =
  "portfolioPerformanceInputs({ ledger, valuationMarks: [{ valuationDate: '2026-01-01', market: marketJan1 }, { valuationDate: '2026-02-01', market: marketFeb1 }] })";

/**
 * Derive the EXACT `valuations` + `externalCashFlows` series FC4's flow-aware calls consume, from
 * a ledger and explicit per-date marks. The identity test in `test/performance-seam.test.ts`
 * proves ledger-derived series → `timeWeightedReturn`/`moneyWeightedReturn` equal the same FC4
 * calls on hand-built series (the FC7 exit-gate hook, closed in this slice).
 *
 * @example
 * ```ts
 * import { timeWeightedReturn } from '@totalfinance/performance';
 * import { portfolioPerformanceInputs } from '@totalfinance/portfolio/performance';
 *
 * const series = portfolioPerformanceInputs({ ledger, valuationMarks });
 * const twr = timeWeightedReturn({
 *   valuations: series.valuations,
 *   externalCashFlows: series.externalCashFlows,
 *   flowTiming: 'at-flow-timestamp',
 *   annualization: 'none',
 * });
 * ```
 */
export function portfolioPerformanceInputs(
  input: PortfolioPerformanceInputsInput,
): PortfolioPerformanceInputsResult {
  const functionName = 'portfolioPerformanceInputs';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  // A ledger is a value object that can be tampered with after creation (the magnitude mutant
  // rewrote an effectiveTimestampMs into a raw RangeError; the enforcement harness dropped
  // `apply` and nulled `baseCurrency`). The whole object is re-validated at this door (2026-08-28).
  requirePortfolioLedger(functionName, 'ledger', input.ledger);
  requireValuationMarks(functionName, input.valuationMarks, 2, EXAMPLE_CALL);

  const ledger = input.ledger;
  const warnings: string[] = [];
  const valuations: PortfolioValuation[] = [];

  // ONE window builder for every through-time report (marks.ts): a mark folds every event strictly
  // before 00:00 UTC of its date and values it there.
  for (const window of foldToMarks(ledger, input.valuationMarks)) {
    const valued = window.valued;
    for (const warning of valued.diagnostics.warnings) {
      warnings.push(`${window.mark.valuationDate}: ${warning}`);
    }
    if (valued.netAssetValue < 0) {
      warnings.push(
        `${functionName}: the ${window.mark.valuationDate} mark values the portfolio at ${valued.netAssetValue} — FC4's flow-aware calls require netAssetValue ≥ 0 and will refuse this series.`,
      );
    }
    valuations.push({
      valuationDate: window.mark.valuationDate,
      netAssetValue: valued.netAssetValue,
    });
  }

  const firstDate = input.valuationMarks[0]!.valuationDate;
  const lastDate = input.valuationMarks[input.valuationMarks.length - 1]!.valuationDate;
  const marksByDate = new Map<string, PortfolioValuationMark>(
    input.valuationMarks.map((mark) => [mark.valuationDate, mark]),
  );
  const externalCashFlows: ExternalCashFlow[] = [];
  let excludedFlowCount = 0;

  for (const envelope of ledger.events) {
    const eventType = envelope.event.eventType;
    if (eventType !== 'cash.deposit' && eventType !== 'cash.withdrawal') continue;
    const event = envelope.event as CashDepositEvent | CashWithdrawalEvent;
    const cashFlowDate = epochMsToUtcDate(envelope.effectiveTimestampMs);
    if (cashFlowDate < firstDate || cashFlowDate > lastDate) {
      excludedFlowCount += 1;
      continue;
    }
    const signedAmount = eventType === 'cash.deposit' ? event.amount : -event.amount;
    let amount = signedAmount;
    if (event.currency !== ledger.state.baseCurrency) {
      const sameDateMark = marksByDate.get(cashFlowDate);
      if (sameDateMark === undefined) {
        throw new DataError(
          `${functionName}: the ${cashFlowDate} ${eventType} '${envelope.eventId}' is in ${event.currency}, not the base currency ${ledger.state.baseCurrency}, and no valuation mark is dated ${cashFlowDate} to convert it at — FC4 needs a same-date valuation for a measured flow anyway ('a flow date with no valuation makes its subperiod a gap'). Add a valuationMark for ${cashFlowDate} carrying the ${event.currency}/${ledger.state.baseCurrency} quote.`,
          {
            code: ErrorCode.PortfolioMarkUnavailable,
            context: { function: functionName, eventId: envelope.eventId, cashFlowDate },
          },
        );
      }
      amount = convertWithQuotes({
        functionName,
        amount: signedAmount,
        fromCurrency: event.currency,
        toCurrency: ledger.state.baseCurrency,
        quotes: sameDateMark.currencyConversions ?? [],
        subject: `the ${cashFlowDate} ${eventType} '${envelope.eventId}'`,
      }).convertedAmount;
    }
    externalCashFlows.push({
      cashFlowDate,
      amount,
      label: envelope.eventId,
      accountId: envelope.accountId,
    });
  }

  if (excludedFlowCount > 0) {
    warnings.push(
      `${functionName}: ${excludedFlowCount} external flow(s) fall outside the [${firstDate}, ${lastDate}] mark window and are excluded from the series — widen the marks to include them.`,
    );
  }

  return deepFreeze(
    requireRepresentableResult('portfolioPerformanceInputs', {
      valuations,
      externalCashFlows,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        markInstant: MARK_INSTANT_PROSE,
        flowMapping: FLOW_MAPPING_PROSE,
      },
      diagnostics: {
        warnings,
        markCount: valuations.length,
        flowCount: externalCashFlows.length,
        excludedFlowCount,
      },
    }),
  );
}

// Slice 2 (2026-08-28): the through-time reports ride the same subpath as the seam they compose.
export { portfolioPnl } from './pnl.js';
export type {
  InstrumentClassification,
  PortfolioGroupingDimension,
  PortfolioPnlComponents,
  PortfolioPnlCurrencyRow,
  PortfolioPnlGroupRow,
  PortfolioPnlGrouping,
  PortfolioPnlInput,
  PortfolioPnlResult,
} from './pnl.js';
export { portfolioTimeline } from './timeline.js';
export type {
  PortfolioExposure,
  PortfolioExposureGroupRow,
  PortfolioExposureGrouping,
  PortfolioTimelineInput,
  PortfolioTimelineResult,
  PortfolioTimelineRow,
} from './timeline.js';
