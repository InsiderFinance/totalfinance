/**
 * `@insiderfinance/totalfinance/fundamentals/statements` — the typed statement contracts and the utilities over them
 * (FC2). Statement TRUTH lives here; ratios and scores consume it.
 */

export type {
  BalanceSheet,
  CashFlowStatement,
  FinancialStatements,
  FundamentalSeries,
  FundamentalSnapshot,
  IncomeStatement,
  RestatementPolicy,
} from './statement-contracts.js';
export {
  requireBalanceSheet,
  requireCashFlowStatement,
  requireFinancialStatements,
  requireIncomeStatement,
  statementsAvailableTimestampMs,
} from './statement-contracts.js';
export * from './statement-utilities.js';
