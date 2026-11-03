/** SDK-first preview example. The host supplies apiKey; the offline rehearsal injects synthetic HTTP. */
import { createInsiderFinanceProvider } from '@insiderfinance/totalfinance-connector-insiderfinance';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';

declare const apiKey: string;
const provider = createInsiderFinanceProvider(apiKey);
const prices = await provider.query({
  kind: 'price-bars',
  symbol: 'SPY',
  interval: '1d',
  from: '2026-10-26',
  to: '2026-10-28',
  limit: 100,
});
const average = sma(prices.closePrices, { period: 2 });
// The source remains at prices.page, including metadata, diagnostics and any nextCursor.
// average is the existing pure calculation result over this page, not a full-history claim.
export { prices, average };
