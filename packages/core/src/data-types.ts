/** Research-only acquisition contracts. Epoch timestamps are integer milliseconds; unknown clocks
 * and terms are null. Price/volatility/Greek units reuse the canonical core market records. */
import type { Bar, OptionQuote, OptionQuoteGreeks } from './market-data.js';
import type { OptionContract } from './contracts.js';
import type { Provenance } from './provenance.js';
import type { Assumptions } from './assumptions.js';
import type { Diagnostics } from './diagnostics.js';

export type DataKind = 'price-bars' | 'option-chain-research';

export interface PriceBarsRequest {
  readonly kind: 'price-bars';
  readonly symbol: string;
  readonly interval: '1d' | '1m';
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

export interface OptionChainResearchRequest {
  readonly kind: 'option-chain-research';
  readonly symbol: string;
  readonly snapshot:
    | { readonly kind: 'latest' }
    | { readonly kind: 'session'; readonly sessionDate: string }
    | { readonly kind: 'id'; readonly snapshotId: string };
  readonly expirationFrom?: string;
  readonly expirationTo?: string;
  readonly rights?: readonly ('call' | 'put')[];
  readonly minStrike?: number;
  readonly maxStrike?: number;
  readonly limit: number;
}

export interface DataContinuationRequest {
  readonly kind: DataKind;
  readonly symbol: string;
  readonly cursor: string;
  readonly limit: number;
}

export type DataRequest = PriceBarsRequest | OptionChainResearchRequest | DataContinuationRequest;
export type DataFor<R extends DataRequest> = R['kind'] extends 'price-bars'
  ? PriceBarRecord
  : R['kind'] extends 'option-chain-research'
    ? OptionChainResearchRecord
    : PriceBarRecord | OptionChainResearchRecord;

export interface DataCapability {
  readonly kind: DataKind;
  readonly intervals: readonly ('1d' | '1m')[];
  readonly maxPageSize: number;
  readonly consistency: 'snapshot' | 'best-effort';
  readonly pointInTime: false;
  readonly access: 'unknown' | 'granted' | 'denied';
}

export interface DataCapabilities {
  readonly contractVersion: 1;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly capabilities: readonly DataCapability[];
}

export interface DataProvider {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: 1;
  capabilities(input: { signal?: AbortSignal }): Promise<DataCapabilities>;
  query<R extends DataRequest>(input: {
    readonly request: R;
    readonly signal?: AbortSignal;
  }): Promise<DataPage<DataFor<R>>>;
}

export interface ObservationTimes {
  readonly observedTimestampMs: number | null;
  readonly availableTimestampMs: number | null;
  readonly sourceStoredTimestampMs: number | null;
}

export interface PriceBarRecord {
  readonly bar: Bar;
  readonly sessionDate: string | null;
  readonly timestampConvention: 'session-label-midnight-utc' | 'interval-start';
  readonly times: ObservationTimes;
  readonly source: string | null;
  readonly provisional: boolean | null;
  readonly revision: number | null;
  readonly diagnostics: Diagnostics;
}

export interface OptionResearchTerms {
  readonly underlying: OptionContract['underlying'];
  readonly type: OptionContract['type'];
  readonly strike: OptionContract['strike'];
  readonly expiry: OptionContract['expiry'];
  readonly root: string | null;
  readonly occSymbol: string | null;
  readonly multiplier: number | null;
  readonly currency: string | null;
  readonly style: OptionContract['style'] | null;
  readonly settlement: NonNullable<OptionContract['settlement']> | null;
  readonly expiresAt: number | null;
  readonly termsStatus: 'verified' | 'incomplete';
}

export interface OptionChainResearchRecord {
  readonly sourceContractId: string;
  readonly terms: OptionResearchTerms;
  readonly times: ObservationTimes;
  readonly quote: Pick<
    OptionQuote,
    | 'bid'
    | 'ask'
    | 'mid'
    | 'last'
    | 'mark'
    | 'volume'
    | 'openInterest'
    | 'underlyingPrice'
    | 'impliedVolatility'
  >;
  readonly greeks: OptionQuoteGreeks | null;
  readonly theoreticalPrice: number | null;
  readonly openInterestSessionDate: string | null;
  readonly diagnostics: Diagnostics;
}

export interface DataPage<T> {
  readonly contractVersion: 1;
  readonly kind: DataKind;
  readonly symbol: string;
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly provenance: Provenance;
  readonly metadata: DataPageMetadata;
  readonly assumptions: Assumptions;
  readonly diagnostics: Diagnostics;
}

export interface DataPageMetadata {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly snapshotId: string | null;
  readonly sessionDate: string | null;
  readonly sourceGeneratedTimestampMs: number | null;
  readonly receivedTimestampMs: number;
  readonly times: ObservationTimes;
  readonly consistency: 'snapshot' | 'best-effort';
  readonly freshness: {
    readonly status:
      | 'current'
      | 'stale'
      | 'session-closed'
      | 'historical'
      | 'end-of-day'
      | 'stored'
      | 'unknown';
    readonly configuredDelayMs: number | null;
    readonly evaluatedTimestampMs: number | null;
  };
  readonly coverage: {
    readonly status: 'continuous' | 'observed-only' | 'unknown';
    readonly start: string | null;
    readonly end: string | null;
  };
  readonly adjustment: 'unadjusted' | 'split' | 'split-and-dividend' | 'unknown';
  readonly quality: {
    readonly status: 'complete' | 'partial' | 'unavailable' | 'unknown';
    readonly issues: readonly { source: string; code: string; message: string }[];
  };
  readonly access: 'unknown' | 'granted' | 'denied';
  readonly executionEligibility: 'research-only';
}
