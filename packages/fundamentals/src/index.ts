/**
 * @totalfinance/fundamentals — typed fundamental truth (FC0 foundation slice).
 *
 * This first slice installs the FROZEN contracts the domain builds on: the point-in-time
 * {@link FundamentalPeriod}, its boundary guard, the availability rule, and the raw data-edge
 * artifact relocated from core. Statements, ratios, and scores (FC2) attach to these
 * declarations; no formula implementation lands before FC0 is green.
 */

export { requireFundamentalPeriod, isPeriodAvailableAt } from './periods.js';
export type { FundamentalPeriod } from './periods.js';
// FC2 — statements, ratios, scores, and the one-call analysis.
export * from './statements.js';
export * from './ratios.js';
export * from './scores.js';
export { analyzeFundamentals } from './analyze.js';
export type {
  AnalyzeFundamentalsInput,
  AnalyzeFundamentalsResult,
  AnalyzedRatio,
} from './analyze.js';
// The raw data-edge record lives in core (the schema layer validates vendor payloads there);
// re-exported so the fundamentals domain names its own edge artifact.
export type { RawFundamentalsRecord } from '@totalfinance/core';
