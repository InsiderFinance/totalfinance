import { resolvedExpiry } from '@totalfinance/core';
import type { OptionFlowDriftTrade } from '@totalfinance/structure';

export const DRIFT_DATE = '2026-06-04';
export const DRIFT_OPEN = Date.parse(`${DRIFT_DATE}T13:30:00Z`);
export const DRIFT_CLOSE = Date.parse(`${DRIFT_DATE}T20:00:00Z`);

export function driftPrint(overrides: Partial<OptionFlowDriftTrade> = {}): OptionFlowDriftTrade {
  return {
    id: 'one',
    contract: {
      underlying: 'TEST',
      type: 'call',
      strike: 100,
      style: 'american',
      expiry: '2026-06-19',
      ...resolvedExpiry('2026-06-19'),
      multiplier: 100,
    },
    timestampMs: DRIFT_OPEN,
    price: 2,
    size: 10,
    bid: 1,
    ask: 2,
    aggressorSide: 'buy',
    ...overrides,
  };
}

/** Synthetic five-print probe recorded in app-dogfooding-comparison §5; NOT a live market tape. */
export function recordedDriftTape(): OptionFlowDriftTrade[] {
  const tape = [
    { type: 'call', side: 'buy', price: 2, size: 10, premium: 2000 },
    { type: 'call', side: 'sell', price: 1, size: 5, premium: 500 },
    { type: 'put', side: 'buy', price: 2, size: 3, premium: 600 },
    { type: 'put', side: 'sell', price: 1, size: 8, premium: 800 },
    { type: 'call', side: 'unknown', price: 1.55, size: 2, premium: 310 },
  ] as const;
  return tape.map((row, i) => {
    const trade = driftPrint({
      id: `recorded-${i}`,
      timestampMs: DRIFT_OPEN + i * 60_000,
      aggressorSide: row.side,
      premium: row.premium,
      price: row.price,
      size: row.size,
    });
    trade.contract.type = row.type;
    return trade;
  });
}
