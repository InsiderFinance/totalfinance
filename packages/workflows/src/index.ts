/**
 * `@insiderfinance/totalfinance/workflows` — the protocol-neutral operation registry (Stage 7A,
 * `docs/specs/local-operations-and-transports.md`). One operation definition drives the SDK-facing
 * runtime, the CLI, the OpenAPI document, and the MCP tools; no transport owns a second schema,
 * budget, seed rule, or effect classification. Read-only, provider-free, browser-safe.
 *
 * ```ts
 * import { createOperationRegistry, defaultPacks } from '@insiderfinance/totalfinance/workflows';
 * const registry = createOperationRegistry({ packs: defaultPacks() });
 * const result = registry.run('totalfinance.option.price', { type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 });
 * ```
 */

export {
  OPERATION_ID,
  defineOperation,
  describeOperation,
  operationAnnotations,
  requireOperation,
} from './operation.js';
export type {
  ArtifactStoreReader,
  OperationAnnotations,
  OperationAuthorization,
  OperationContext,
  OperationCostClass,
  OperationDescription,
  OperationError,
  OperationIdempotency,
  OperationOutput,
  OperationPack,
  OperationResult,
  OperationSideEffect,
  OperationSignal,
  TotalFinanceOperation,
  ResourceHandle,
  ResourceHandleKind,
} from './operation.js';
export { OPERATION_BUDGETS, runOperation, toOperationError } from './runtime.js';
export type { RunOperationInput, RunOperationOptions } from './runtime.js';
export { createOperationRegistry } from './registry.js';
export type { OperationRegistry } from './registry.js';
export { jsonSafe } from './json-safe.js';
export {
  RESOURCE_HANDLE_SCHEMA,
  operationResultSchema,
  spilledResultSchema,
} from './envelope-schema.js';
export type { OperationResultSchemaInput } from './envelope-schema.js';
export {
  HANDLE_KINDS,
  JOB_STATES,
  applyJobPatch,
  createMemoryArtifactStore,
  createMemoryJobStore,
  handleUriOf,
  parseHandleUri,
  requireArtifactListFilter,
  requireArtifactPut,
  requireJobRecord,
  requireResourceHandle,
} from './stores.js';
export type {
  ArtifactStore,
  ArtifactStorePutInput,
  JobRecord,
  JobState,
  JobStore,
} from './stores.js';
export { WORKFLOWS_VERSION } from './version.js';
export {
  DEFAULT_CAPABILITIES,
  KNOWN_CAPABILITIES,
  missingCapabilities,
  requireCapabilities,
} from './capabilities.js';
export {
  EXECUTION_JOURNAL_STORE_CEILING,
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  requireAuthorizationPut,
  requireJournalAppend,
  requireJournalId,
} from './stores-trade.js';
export type {
  AuthorizationStore,
  ExecutionJournalStore,
  GrantConsumption,
} from './stores-trade.js';
export { tradePack } from './operations-trade.js';
export { MAX_ROWS, capRows, extendObjectSchema } from './operation-kit.js';
export {
  calendarPack,
  defaultOperations,
  defaultPacks,
  optionsPack,
  performancePack,
  riskPack,
  strategyPack,
  structurePack,
  technicalAnalysisPack,
  volatilityPack,
} from './operations-compute.js';
export {
  analysisOperations,
  backtestPack,
  cryptoPack,
  fixedIncomePack,
} from './operations-analysis.js';
export {
  artifactPack,
  journeyOperations,
  journeyPacks,
  portfolioPack,
  valuationPack,
  researchPack,
  scenarioPack,
} from './operations-journey.js';
