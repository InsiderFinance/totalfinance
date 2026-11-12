/** Research-only acquisition contracts. Epoch timestamps are integer milliseconds; unknown clocks
 * and terms are null. Price/volatility/Greek units reuse the canonical core market records. */
import type { Bar, OptionQuote, OptionQuoteGreeks } from './market-data.js';
import type { OptionContract } from './contracts.js';
import type { Provenance } from './provenance.js';
import type { Assumptions } from './assumptions.js';
import type { Diagnostics } from './diagnostics.js';

export type DataKind = 'price-bars' | 'option-chain-research';

export type DataInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1mo';
export interface PriceBarsQuery {
  readonly kind: 'price-bars';
  readonly symbol: string;
  readonly interval: DataInterval;
  readonly from: string;
  readonly to: string;
}
export interface OptionChainResearchQuery {
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
}
export type DataQuery = PriceBarsQuery | OptionChainResearchQuery;
export type DataFor<R extends DataQuery> = R extends PriceBarsQuery
  ? PriceBarRecord
  : OptionChainResearchRecord;
export interface DataQueryBinding {
  readonly provider: { readonly id: string; readonly version: string };
  readonly query: DataQuery;
}
export interface DataPins {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly snapshotId: string | null;
  readonly sessionDate: string | null;
  readonly adjustment: DataPageMetadata['adjustment'];
  readonly consistency: 'snapshot' | 'best-effort';
  readonly temporal:
    | {
        readonly kind: 'price-bars';
        readonly interval: DataInterval;
        readonly timestampConvention: PriceBarRecord['timestampConvention'];
      }
    | { readonly kind: 'option-chain-research' };
}
export interface DataContinuation {
  readonly version: 2;
  readonly binding: DataQueryBinding;
  readonly cursor: string;
  readonly pins: DataPins;
}
export interface DataCallOptions {
  readonly signal?: AbortSignal;
}
export interface DataPageOptions extends DataCallOptions {
  readonly limit: number;
  readonly cursor: string | null;
  readonly pins: DataPins | null;
}
export interface DataQueryOptions extends DataCallOptions {
  readonly limit: number;
  readonly cursor?: DataContinuation;
}
export interface DataCapabilityDeclaration {
  readonly kind: string;
  readonly intervals: readonly string[];
  readonly maxPageSize: number;
  readonly consistency: readonly ('snapshot' | 'best-effort')[];
  readonly pointInTime: false;
  readonly access: 'unknown' | 'granted' | 'denied';
  readonly maxWindowMs?: number;
  readonly maxSessionDays?: number;
}
export interface DataCapability extends Omit<DataCapabilityDeclaration, 'kind' | 'intervals'> {
  readonly kind: DataKind;
  readonly intervals: readonly DataInterval[];
}
export interface DataCapabilities {
  readonly contractVersion: 2;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly capabilities: readonly DataCapability[];
  readonly ignored: { readonly kinds: number; readonly intervals: number };
}
export interface CommonPageFacts {
  readonly dataset: { readonly id: string; readonly version: string };
  readonly receivedTimestampMs: number;
  readonly adjustment: DataPageMetadata['adjustment'];
  readonly consistency: 'snapshot' | 'best-effort';
  readonly sourceSymbol?: string;
  readonly snapshotId?: string | null;
  readonly sessionDate?: string | null;
  readonly sourceGeneratedTimestampMs?: number | null;
  readonly times?: ObservationTimes;
  readonly freshness?: DataPageMetadata['freshness'];
  readonly coverage?: DataPageMetadata['coverage'];
  readonly quality?: DataPageMetadata['quality'];
  readonly access?: DataPageMetadata['access'];
  readonly requestId?: string;
}
export interface PriceBarsPageFacts extends CommonPageFacts {
  readonly timestampConvention: PriceBarRecord['timestampConvention'];
}
export interface SourcePriceBarRecord {
  readonly bar: Omit<Bar, 'symbol'>;
  readonly sessionDate?: string | null;
  readonly times?: ObservationTimes;
  readonly source?: string | null;
  readonly provisional?: boolean | null;
  readonly revision?: number | null;
  readonly diagnostics?: Diagnostics;
}
export interface SourcePriceBarsPage {
  readonly data: readonly SourcePriceBarRecord[];
  readonly nextCursor: string | null;
  readonly facts: PriceBarsPageFacts;
  readonly diagnostics?: Diagnostics;
}
export interface SourceOptionChainPage {
  readonly data: readonly OptionChainResearchRecord[];
  readonly nextCursor: string | null;
  readonly facts: CommonPageFacts;
  readonly diagnostics?: Diagnostics;
}
export interface DataProviderSource {
  readonly protocol: 'totalfinance-data-source';
  readonly contractVersion: 2;
  readonly id: string;
  readonly version: string;
  capabilities(options?: DataCallOptions): Promise<readonly DataCapabilityDeclaration[]>;
  query(
    query: DataQuery,
    page: DataPageOptions,
  ): Promise<SourcePriceBarsPage | SourceOptionChainPage>;
}
export interface OhlcvInput {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
export type TimestampedOhlcvInput = Readonly<Bar & { volume: number }>;
export interface RowRef {
  readonly pageIndex: number;
  readonly rowIndex: number;
}
export type OHLCField = 'open' | 'high' | 'low' | 'close';
export interface ResearchBarIssue extends RowRef {
  readonly rule: 'low_above_high' | 'open_outside_range' | 'close_outside_range';
  readonly fields: readonly OHLCField[];
}
export type ResearchBarChoice =
  | {
      readonly action: 'exclude' | 'use';
      readonly rows?: readonly RowRef[];
      readonly reason: string;
    }
  | {
      readonly action: 'correct';
      readonly corrections: readonly {
        readonly row: RowRef;
        readonly values: Partial<Pick<Bar, OHLCField>>;
      }[];
      readonly reason: string;
    };
export interface ResearchBarSelection {
  readonly version: 1;
  readonly decisions: readonly ResearchBarChoice[];
  readonly sourceRows: readonly RowRef[];
}
export interface PriceBarsSelections {
  readonly closePrices: readonly number[];
  readonly ohlcvBars: readonly OhlcvInput[];
  readonly bars: readonly TimestampedOhlcvInput[];
  readonly issues: readonly ResearchBarIssue[];
  readonly selection: ResearchBarSelection;
  readonly selections: readonly ['closePrices', 'ohlcvBars', 'bars'];
}
export interface PriceBarsView extends PriceBarsSelections {
  readonly kind: 'price-bars';
  readonly page: DataPage<PriceBarRecord>;
  readonly continuation: DataContinuation | null;
  readonly continuationStatus: 'available' | 'terminal' | 'unavailable-legacy-context';
  resolve(choice: ResearchBarChoice): PriceBarsView;
}
export interface OptionChainResearchView {
  readonly kind: 'option-chain-research';
  readonly page: DataPage<OptionChainResearchRecord>;
  readonly continuation: DataContinuation | null;
  readonly continuationStatus: 'available' | 'terminal' | 'unavailable-legacy-context';
}
export type DataView = PriceBarsView | OptionChainResearchView;
export type DataViewFor<R extends DataQuery> = R extends PriceBarsQuery
  ? PriceBarsView
  : OptionChainResearchView;
export interface DataProvider {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: 2;
  capabilities(options?: DataCallOptions): Promise<DataCapabilities>;
  query<R extends DataQuery>(query: R, options: DataQueryOptions): Promise<DataViewFor<R>>;
}

export interface ObservationTimes {
  readonly observedTimestampMs: number | null;
  readonly availableTimestampMs: number | null;
  readonly sourceStoredTimestampMs: number | null;
}

export interface PriceBarRecord {
  readonly bar: Bar;
  readonly sessionDate: string | null;
  readonly timestampConvention: 'session-label-midnight-utc' | 'interval-start' | 'session-start';
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

interface DataPageFields<T> {
  readonly kind: DataKind;
  readonly symbol: string;
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly provenance: Provenance;
  readonly metadata: DataPageMetadata;
  readonly assumptions: Assumptions;
  readonly diagnostics: Diagnostics;
}

/** Version1 remains a canonical restore format, never a live source protocol. */
export type DataPage<T> = DataPageFields<T> &
  (
    | {
        readonly contractVersion: 1;
        readonly binding?: never;
        readonly timestampConvention?: never;
        readonly issues?: never;
      }
    | {
        readonly contractVersion: 2;
        readonly binding: DataQueryBinding;
        readonly timestampConvention?: PriceBarRecord['timestampConvention'];
        readonly issues: readonly ResearchBarIssue[];
      }
  );

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

/** Financial query without the source protocol discriminator. */
export type PriceBarsWindowRequest = Omit<PriceBarsQuery, 'kind'>;
export interface DataConnectionOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxReads?: number;
  readonly maxRecords?: number;
}
export interface PriceBarsWindowOptions extends DataConnectionOptions {
  readonly signal?: AbortSignal;
}
export interface ConnectedData extends DataProvider {
  priceBars(
    request: PriceBarsWindowRequest,
    options?: PriceBarsWindowOptions,
  ): Promise<PriceBarsWindowView>;
  resumePriceBars(
    checkpoint: unknown,
    options?: PriceBarsWindowOptions,
  ): Promise<PriceBarsWindowView>;
}
export interface PriceBarsPaging {
  readonly requested:
    | { readonly mode: 'automatic' }
    | { readonly mode: 'explicit'; readonly size: number };
  readonly state:
    | { readonly status: 'unresolved' }
    | { readonly status: 'resolved'; readonly effectiveSize: number };
}
export interface PriceBarsCheckpoint {
  readonly version: 1;
  readonly kind: 'price-bars-checkpoint';
  readonly contractVersion: 2;
  readonly binding: DataQueryBinding;
  readonly pages: readonly DataPage<PriceBarRecord>[];
  readonly next: DataContinuation | null;
  readonly progress: {
    readonly status: 'incomplete';
    readonly acceptedPages: number;
    readonly records: number;
    readonly reads: number;
  };
  readonly paging: PriceBarsPaging;
  readonly limits: {
    readonly maxPages: number;
    readonly maxReads: number;
    readonly maxRecords: number;
  };
  readonly bytes: number;
}
interface CurrentPriceBarsWindow {
  readonly version: 2;
  readonly kind: 'price-bars-window';
  readonly contractVersion: 2;
  readonly binding: DataQueryBinding;
  readonly pages: readonly DataPage<PriceBarRecord>[];
  readonly pagination: {
    readonly status: 'terminal';
    readonly pageSize: number;
    readonly pageCalls: number;
    readonly reads: number;
    readonly records: number;
  };
  readonly bytes: number;
}
interface LegacyPriceBarsWindow {
  readonly version: 1;
  readonly kind: 'price-bars-window';
  readonly request: PriceBarsWindowRequest;
  readonly pages: readonly DataPage<PriceBarRecord>[];
  readonly pagination: {
    readonly status: 'terminal';
    readonly pageSize: number;
    readonly pageCalls: number;
    readonly records: number;
    readonly reads?: never;
  };
}
export type PriceBarsWindow = CurrentPriceBarsWindow | LegacyPriceBarsWindow;
export interface PriceBarsWindowView extends PriceBarsSelections {
  readonly kind: 'price-bars-window';
  readonly window: PriceBarsWindow;
  resolve(choice: ResearchBarChoice): PriceBarsWindowView;
}
