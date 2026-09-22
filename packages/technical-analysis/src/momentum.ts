/**
 * Momentum & oscillator family (concept entrypoint).
 *
 * Bundles RSI, MACD, the base momentum oscillators (`./oscillators`) and the extended
 * modern-momentum set (`./momentum-ext`). Consumers import one concept —
 * `@insiderfinance/totalfinance/technical-analysis/momentum` — instead of the per-split modules. The per-indicator deep imports
 * (`@insiderfinance/totalfinance/technical-analysis/rsi`, `@insiderfinance/totalfinance/technical-analysis/macd`, `@insiderfinance/totalfinance/technical-analysis/oscillators`) remain available
 * (design law #9).
 */
export { rsi } from './rsi.js';
export { macd } from './macd.js';
export * from './oscillators.js';
export * from './momentum-ext.js';
// Both `./oscillators` and `./momentum-ext` export an identical `PeriodParameters` ({ period: number }).
// Re-export one explicitly to resolve the star-export ambiguity (TS2308); the choice is immaterial.
export type { PeriodParameters } from './oscillators.js';
