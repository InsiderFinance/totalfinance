/** Internal v1 validation shapes for canonical restore, never a public source-call compatibility door. */
export type {
  DataPage,
  PriceBarRecord,
  OptionChainResearchRecord,
  DataProvider,
} from './data-types.js';
export interface PriceBarsRequest {
  kind: 'price-bars';
  symbol: string;
  interval: '1d' | '1m';
  from: string;
  to: string;
  limit: number;
}
export interface OptionChainResearchRequest {
  kind: 'option-chain-research';
  symbol: string;
  snapshot:
    | { kind: 'latest' }
    | { kind: 'session'; sessionDate: string }
    | { kind: 'id'; snapshotId: string };
  expirationFrom?: string;
  expirationTo?: string;
  rights?: readonly ('call' | 'put')[];
  minStrike?: number;
  maxStrike?: number;
  limit: number;
}
export interface DataContinuationRequest {
  kind: 'price-bars' | 'option-chain-research';
  symbol: string;
  cursor: string;
  limit: number;
}
export type DataRequest = PriceBarsRequest | OptionChainResearchRequest | DataContinuationRequest;
export interface DataCapabilities {
  contractVersion: 1;
  providerId: string;
  providerVersion: string;
  capabilities: readonly {
    kind: 'price-bars' | 'option-chain-research';
    intervals: readonly ('1d' | '1m')[];
    maxPageSize: number;
    consistency: 'snapshot' | 'best-effort';
    pointInTime: false;
    access: 'unknown' | 'granted' | 'denied';
  }[];
}
