import type {
  DataPage,
  PriceBarRecord,
  PriceBarsRequest,
  OptionChainResearchRecord,
  DataCapability,
} from '@insiderfinance/totalfinance/core/data';
import { CONVENTIONS_VERSION } from '@insiderfinance/totalfinance/core';
export const dailyRequest: PriceBarsRequest = {
  kind: 'price-bars',
  symbol: 'TEST',
  interval: '1d',
  from: '2026-10-26',
  to: '2026-10-28',
  limit: 2,
};
export const barCapability: DataCapability = {
  kind: 'price-bars',
  intervals: ['1d', '1m'],
  maxPageSize: 2000,
  consistency: 'best-effort',
  pointInTime: false,
  access: 'unknown',
};
export function page(
  kind: 'price-bars' | 'option-chain-research' = 'price-bars',
): DataPage<PriceBarRecord | OptionChainResearchRecord> {
  const times = {
    observedTimestampMs: null,
    availableTimestampMs: null,
    sourceStoredTimestampMs: null,
  };
  return {
    contractVersion: 1,
    kind,
    symbol: 'TEST',
    data: [],
    nextCursor: null,
    provenance: {
      provider: 'fixture',
      dataset: 'synthetic',
      sourceVersion: '1',
      receivedAt: 1793203200000,
    },
    metadata: {
      datasetId: 'synthetic',
      datasetVersion: '1',
      snapshotId: null,
      sessionDate: null,
      sourceGeneratedTimestampMs: null,
      receivedTimestampMs: 1793203200000,
      times,
      consistency: 'best-effort',
      freshness: { status: 'end-of-day', configuredDelayMs: 0, evaluatedTimestampMs: null },
      coverage: { status: 'unknown', start: null, end: null },
      adjustment: 'split',
      quality: { status: 'complete', issues: [] },
      access: 'unknown',
      executionEligibility: 'research-only',
    },
    assumptions: { conventionsVersion: CONVENTIONS_VERSION },
    diagnostics: { warnings: [] },
  };
}
export function bar(date = '2026-10-26', close = 101): PriceBarRecord {
  return {
    bar: {
      symbol: 'TEST',
      timestampMs: Date.parse(date + 'T00:00:00Z'),
      open: 100,
      high: 102,
      low: 99,
      close,
      volume: 0,
      adjusted: true,
    },
    sessionDate: date,
    timestampConvention: 'session-label-midnight-utc',
    times: { observedTimestampMs: null, availableTimestampMs: null, sourceStoredTimestampMs: null },
    source: null,
    provisional: null,
    revision: null,
    diagnostics: { warnings: [] },
  };
}
export function chain(): OptionChainResearchRecord {
  return {
    sourceContractId: 'synthetic-contract',
    terms: {
      underlying: 'TEST',
      type: 'call',
      strike: 100,
      expiry: '2026-11-20',
      root: null,
      occSymbol: null,
      multiplier: null,
      currency: 'USD',
      style: null,
      settlement: null,
      expiresAt: null,
      termsStatus: 'incomplete',
    },
    times: { observedTimestampMs: null, availableTimestampMs: null, sourceStoredTimestampMs: null },
    quote: { bid: 0, ask: 1, openInterest: 0 },
    greeks: null,
    theoreticalPrice: null,
    openInterestSessionDate: null,
    diagnostics: { warnings: [] },
  };
}
