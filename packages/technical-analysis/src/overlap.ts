/**
 * Overlap studies (concept entrypoint).
 *
 * Moving averages (`./moving-averages`) plus the extended overlap set (`./overlap-ext`):
 * weighted MAs, JMA/HWMA, rainbow & ribbon MAs, VWAP bands, and session/rolling-anchored VWAP.
 * Bollinger / Keltner bands live in `@totalfinance/technical-analysis/bands`.
 */
export * from './moving-averages.js';
export * from './overlap-ext.js';
// Both `./moving-averages` and `./overlap-ext` export an identical `PeriodParameters` ({ period: number }).
// Re-export one explicitly to resolve the star-export ambiguity (TS2308); the choice is immaterial.
export type { PeriodParameters } from './moving-averages.js';
