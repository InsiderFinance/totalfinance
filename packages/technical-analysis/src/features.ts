/**
 * Feature-engineering + performance-metric helpers (concept entrypoint).
 *
 * Rolling feature transforms (`./features-ext`) — lag/diff/change, z-score, ranks, rolling
 * regression/quantiles, winsorize, covariance/beta, … — plus performance metrics
 * (`./performance-ext`, e.g. `drawdown`).
 */
export * from './features-ext.js';
export * from './performance-ext.js';
