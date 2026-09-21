/**
 * Valuation marks and the prefix-fold windows behind every "through time" report (slice 2,
 * 2026-08-28). ONE mark grammar and ONE window builder serve the FC4 seam
 * (`portfolioPerformanceInputs`), `portfolioPnl`, and `portfolioTimeline`, so the three can never
 * disagree about which events precede a mark: a mark dated D is the fold of every event with
 * `effectiveTimestampMs < 00:00 UTC of D`, valued at that instant — the mark lands BEFORE any
 * same-day flow, exactly FC4's stated flow convention. Package-internal (not an entrypoint).
 */

import type { EpochMs } from '@totalfinance/core';
import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import type { PortfolioEventEnvelope } from './events.js';
import { describeInputValue, type CurrencyPairQuote } from './internal.js';
import type { PortfolioLedger } from './ledger.js';
import type { PortfolioSnapshotResult } from './snapshot.js';
import { portfolioSnapshot } from './snapshot.js';
import type { PortfolioState } from './state.js';
import { applyPortfolioEvents } from './state.js';

/** One dated valuation: the market snapshot (and base-currency quotes) to value the ledger at. */
export interface PortfolioValuationMark {
  /** Strict `YYYY-MM-DD`; the mark instant is 00:00 UTC of this date. */
  valuationDate: string;
  /** A Gate B market snapshot carrying `observations.spots[instrumentId]` for every held instrument. */
  market: MarketSnapshot;
  /** Quotes to the base currency for every non-base cash balance and position currency. */
  currencyConversions?: CurrencyPairQuote[];
}

export const MARK_KEYS = ['valuationDate', 'market', 'currencyConversions'] as const;
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Structural validation of a strictly ascending mark list with at least `minimum` entries. */
export function requireValuationMarks(
  functionName: string,
  marks: readonly PortfolioValuationMark[],
  minimum: number,
  exampleCall: string,
): void {
  requireArgumentArray(functionName, 'valuationMarks', marks);
  if (marks.length < minimum) {
    throw new InputError(
      `${functionName}: valuationMarks needs at least ${minimum} dated mark${minimum === 1 ? '' : 's'} — ${
        minimum >= 2
          ? 'a change is measured BETWEEN valuations'
          : 'a report needs one instant to value at'
      }. Received ${marks.length}.\n  e.g. ${exampleCall}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'valuationMarks' },
      },
    );
  }
  marks.forEach((mark, index) => {
    requireArgumentObject(functionName, `valuationMarks[${index}]`, mark);
    ensureKnownKeys(functionName, `valuationMarks[${index}]`, mark, MARK_KEYS);
    if (typeof mark.valuationDate !== 'string' || !STRICT_DATE.test(mark.valuationDate)) {
      throw new InputError(
        `${functionName}: valuationMarks[${index}].valuationDate must be a strict YYYY-MM-DD calendar date. Received ${describeInputValue(mark.valuationDate)}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `valuationMarks[${index}].valuationDate` },
        },
      );
    }
    if (index > 0 && mark.valuationDate <= marks[index - 1]!.valuationDate) {
      throw new InputError(
        `${functionName}: valuationMarks must be strictly ascending by valuationDate — [${index - 1}] is ${marks[index - 1]!.valuationDate} and [${index}] is ${mark.valuationDate}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `valuationMarks[${index}].valuationDate` },
        },
      );
    }
  });
}

/** The ledger folded up to a mark and valued there, with the events that arrived since the prior mark. */
export interface MarkWindow {
  mark: PortfolioValuationMark;
  /** 00:00 UTC of `mark.valuationDate`. */
  instant: EpochMs;
  /** The fold of every event with `effectiveTimestampMs < instant`. */
  state: PortfolioState;
  valued: PortfolioSnapshotResult;
  /** Events with `prior.instant ≤ effectiveTimestampMs < instant` (all events before the first mark, for index 0). */
  eventsSincePrior: PortfolioEventEnvelope[];
}

/**
 * Fold the ledger incrementally through the marks and value it at each. The caller has already
 * validated the ledger and the marks; this only sequences them.
 */
export function foldToMarks(
  ledger: PortfolioLedger,
  marks: readonly PortfolioValuationMark[],
): MarkWindow[] {
  let prefixState: PortfolioState = applyPortfolioEvents({
    portfolio: {
      ...(ledger.state.portfolioId !== undefined ? { portfolioId: ledger.state.portfolioId } : {}),
      baseCurrency: ledger.state.baseCurrency,
      lotRelief: ledger.state.lotRelief,
    },
    events: [],
  });
  let eventPointer = 0;
  const windows: MarkWindow[] = [];
  for (const mark of marks) {
    const instant = isoDateToEpochMs(mark.valuationDate);
    const batch: PortfolioEventEnvelope[] = [];
    while (
      eventPointer < ledger.events.length &&
      ledger.events[eventPointer]!.effectiveTimestampMs < instant
    ) {
      batch.push(ledger.events[eventPointer]!);
      eventPointer += 1;
    }
    if (batch.length > 0) {
      prefixState = applyPortfolioEvents({ previousState: prefixState, events: batch });
    }
    const valued = portfolioSnapshot({
      portfolio: prefixState,
      asOf: instant,
      market: mark.market,
      ...(mark.currencyConversions !== undefined
        ? { currencyConversions: mark.currencyConversions }
        : {}),
    });
    windows.push({ mark, instant, state: prefixState, valued, eventsSincePrior: batch });
  }
  return windows;
}
