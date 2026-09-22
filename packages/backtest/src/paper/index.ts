/**
 * `@insiderfinance/totalfinance/backtest/paper` — the paper broker (Stage 7B.2, AT5, Decision 7): the first execution
 * adapter, deterministic and credential-free. `submit` verifies the authorization grant and journals
 * (one idempotency key, one plan; a retry returns the same receipt); `step` meets every open order with
 * the market through the engines' own fill path and returns the fills and the ledger events; `cancel`,
 * `deliver`, and `halt` are the hazard surface. Paper, backtest, and replay share fills, costs, and
 * accounting exactly — the difference is who supplies the observations.
 */
export { createPaperBroker } from './paper.js';
export { requireCreatePaperBrokerInput, requirePaperInstrument } from './validate.js';
export { EXECUTION_RECEIPT_KIND, EXECUTION_RECEIPT_SCHEMA_VERSION } from './types.js';
export type {
  CreatePaperBrokerInput,
  ExecutionReceipt,
  PaperBroker,
  PaperBrokerDescription,
  PaperCancelInput,
  PaperCancelResult,
  PaperDeliverInput,
  PaperDeliverResult,
  PaperHaltInput,
  PaperHaltResult,
  PaperInstrument,
  PaperStepInput,
  PaperStepResult,
  PaperSubmitInput,
} from './types.js';
