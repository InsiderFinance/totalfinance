/**
 * `@insiderfinance/totalfinance/valuation/cash-flows` — the FC1 surface as a lean subpath: discounting, rate
 * conversion, return solvers, loans and amortization, capital budgeting and depreciation. The
 * per-element flow guards stay package-internal; the public boundary validates collections.
 */

export type { TimedCashFlow, DatedCashFlow } from './flows.js';
export * from './discounting.js';
export * from './solvers.js';
export * from './loans.js';
export * from './capital-budgeting.js';
