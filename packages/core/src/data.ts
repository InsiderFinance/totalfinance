/** Public provider-neutral research contract, separate from all provider HTTP packages. */
export const DATA_CONTRACT_VERSION = 2;
export type * from './data-types.js';
export { defineDataProvider } from './data-provider.js';
export { createDataView } from './data-view.js';
export { DataProviderError } from './data-provider-error.js';
export type {
  DataProviderErrorOptions,
  DataProviderFailure,
  KnownDataField,
  DataGuidanceRule,
} from './data-provider-error.js';
export { connect, createPriceBarsWindowView, priceBarsCheckpoint } from './data-connection.js';
