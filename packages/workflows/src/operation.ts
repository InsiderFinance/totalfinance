/**
 * The protocol-neutral operation contract (Stage 7A, `docs/specs/local-operations-and-transports.md`
 * Decision 2): ONE definition drives the SDK-facing runtime, the CLI, the OpenAPI document, and the
 * MCP tools. An operation composes public TotalFinance functions and forwards their assumptions and
 * diagnostics verbatim; it owns no quantitative semantics of its own.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { EpochMs, Provenance, QuantWarning } from '@totalfinance/core';
import { requireJSONSchema } from '@totalfinance/core/schema';
import type { JSONSchema, Schema, SchemaIssue } from '@totalfinance/core/schema';
import type { AuthorizationStore, ExecutionJournalStore } from './stores-trade.js';

export type OperationSideEffect = 'none' | 'portfolio-state' | 'external-order';
export type OperationAuthorization = 'none' | 'policy' | 'human';
export type OperationIdempotency = 'not-applicable' | 'optional' | 'required';
export type OperationCostClass = 'small' | 'medium' | 'large' | 'job';

/** What a transport advertises about an operation's behaviour — DERIVED from its effect metadata, never authored. */
export interface OperationAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Read access to the handles an input may reference (Decision 5); `null` when no store was supplied. */
export interface ArtifactStoreReader {
  get(uri: string): { handle: ResourceHandle; value: Record<string, unknown> } | null;
  list(filter?: { kind?: ResourceHandleKind }): ResourceHandle[];
}

/** The kinds of stored data a handle can point at (Decision 5). */
export type ResourceHandleKind =
  | 'report'
  | 'job'
  | 'portfolio'
  | 'scenario'
  | 'market'
  | 'authorization'
  | 'journal';

/** An explicit, store-scoped reference to stored data — never implicit session state. */
export interface ResourceHandle {
  uri: string;
  kind: ResourceHandleKind;
  schema: string;
  version: string;
  contentHash: string | null;
  /** When the store minted the handle — the caller's clock in epoch ms, never the library's. */
  createdTimestampMs: EpochMs;
  /** When the stored value stops being served, epoch ms; null = never. */
  expiresTimestampMs: EpochMs | null;
  /** Caller-supplied provenance, preserved verbatim. */
  provenance: Provenance;
}

/**
 * The structural shape of a cancellation signal (an `AbortSignal` satisfies it): this package is
 * browser-safe and declares no platform lib, so the contract names only what an operation reads.
 */
export interface OperationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface OperationContext {
  /** The resolved seed for a stochastic call (the seed policy injects the default when absent); `null` for a deterministic call. */
  seed: number | null;
  budgets: { maxInputBytes: number | null; deadlineMs: number | null };
  /** Cooperative cancellation for job-class operations; `null` for an inline run. */
  signal: OperationSignal | null;
  artifacts: ArtifactStoreReader | null;
  /** What the caller holds (Stage 7B.2 Decision 9); the runtime refused the call already when a required one is missing. */
  capabilities: readonly string[];
  /** The trade lifecycle's stores (Decision 10), explicit parameters of the runtime — never session state. */
  stores: { authorization: AuthorizationStore | null; journal: ExecutionJournalStore | null };
}

/** What an operation returns — the runtime completes it into an {@link OperationResult}. */
export interface OperationOutput<Output = Record<string, unknown>> {
  /** Human-readable one-line summary. */
  summary: string;
  /** Machine-readable structured output (validated against `outputSchema` in the parity fixtures). */
  structured: Output;
  artifacts?: ResourceHandle[];
  status?: 'complete' | 'partial';
  incomplete?: string[];
}

export interface TotalFinanceOperation<Input = unknown, Output = Record<string, unknown>> {
  /** The wire identity every transport uses: `totalfinance.<domain>.<verb>`. */
  id: string;
  /** An integer string; a breaking output change bumps it (pre-1.0: no aliases). */
  version: string;
  title: string;
  description: string;
  inputSchema: Schema<Input>;
  outputSchema: JSONSchema | null;
  sideEffect: OperationSideEffect;
  authorization: OperationAuthorization;
  idempotency: OperationIdempotency;
  deterministic: boolean;
  /**
   * A call that draws random samples — `true` for every call, or a per-call predicate over the PARSED
   * input. (Declared through a method type so a specifically typed operation stays assignable to the
   * registry's `TotalFinanceOperation<unknown>` — the predicate reads its own parsed input.)
   */
  stochastic: boolean | { predicate(input: Input): boolean }['predicate'];
  costClass: OperationCostClass;
  requiredCapabilities: readonly string[];
  /** True only when the runtime can actually stop the work (a terminated worker), never a post-hoc report. */
  supportsCancellation: boolean;
  /** Input paths that accept a resource handle in place of inline data. */
  handleFields: readonly string[];
  /** SYNCHRONOUS — compute never awaits; the runtime, the job runner, and the transports own asynchrony. */
  run(input: Input, context: OperationContext): OperationOutput<Output>;
}

export interface OperationPack {
  name: string;
  operations: TotalFinanceOperation[];
}

/** The transport-neutral description every adapter renders. */
export interface OperationDescription {
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema | null;
  sideEffect: OperationSideEffect;
  authorization: OperationAuthorization;
  idempotency: OperationIdempotency;
  deterministic: boolean;
  stochastic: boolean | 'per-call';
  costClass: OperationCostClass;
  requiredCapabilities: string[];
  supportsCancellation: boolean;
  handleFields: string[];
  annotations: OperationAnnotations;
}

export const OPERATION_ID = /^totalfinance\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const DEFINE_KEYS = [
  'id',
  'version',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'sideEffect',
  'authorization',
  'idempotency',
  'deterministic',
  'stochastic',
  'costClass',
  'requiredCapabilities',
  'supportsCancellation',
  'handleFields',
  'run',
] as const;

const SIDE_EFFECTS: readonly OperationSideEffect[] = ['none', 'portfolio-state', 'external-order'];
const AUTHORIZATIONS: readonly OperationAuthorization[] = ['none', 'policy', 'human'];
const IDEMPOTENCIES: readonly OperationIdempotency[] = ['not-applicable', 'optional', 'required'];
const COST_CLASSES: readonly OperationCostClass[] = ['small', 'medium', 'large', 'job'];

function refuse(
  functionName: string,
  message: string,
  field: string,
  code: ErrorCode = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

/**
 * Define an operation. Every effect field has the read-only default this stage ships; a definition
 * is validated once here so a malformed operation never reaches a registry or a transport.
 */
export function defineOperation<Input, Output extends Record<string, unknown>>(definition: {
  id: string;
  version?: string;
  title: string;
  description: string;
  inputSchema: Schema<Input>;
  outputSchema?: JSONSchema;
  sideEffect?: OperationSideEffect;
  authorization?: OperationAuthorization;
  idempotency?: OperationIdempotency;
  deterministic?: boolean;
  stochastic?: boolean | ((input: Input) => boolean);
  costClass?: OperationCostClass;
  requiredCapabilities?: readonly string[];
  supportsCancellation?: boolean;
  handleFields?: readonly string[];
  run: (input: Input, context: OperationContext) => OperationOutput<Output>;
}): TotalFinanceOperation<Input, Output> {
  const functionName = 'defineOperation';
  requireArgumentObject(functionName, 'definition', definition);
  ensureKnownKeys(functionName, 'definition', definition, DEFINE_KEYS);
  if (typeof definition.id !== 'string' || !OPERATION_ID.test(definition.id)) {
    refuse(
      functionName,
      `id must match totalfinance.<domain>.<verb> in lower snake_case (e.g. 'totalfinance.option.price'). Received ${JSON.stringify(definition.id)}.`,
      'definition.id',
      ErrorCode.InputWrongShape,
    );
  }
  const version = definition.version === undefined ? '1' : definition.version;
  if (typeof version !== 'string' || !/^[1-9][0-9]*$/.test(version)) {
    refuse(
      functionName,
      `version must be a positive integer string. Received ${JSON.stringify(version)}.`,
      'definition.version',
      ErrorCode.InputWrongShape,
    );
  }
  for (const field of ['title', 'description'] as const) {
    if (typeof definition[field] !== 'string' || definition[field].length === 0) {
      refuse(functionName, `${field} must be a non-empty string.`, `definition.${field}`);
    }
  }
  const inputSchema = definition.inputSchema as unknown as {
    safeParse?: unknown;
    toJSONSchema?: unknown;
  };
  if (
    inputSchema === null ||
    typeof inputSchema !== 'object' ||
    typeof inputSchema.safeParse !== 'function' ||
    typeof inputSchema.toJSONSchema !== 'function'
  ) {
    refuse(
      functionName,
      'inputSchema must be a @totalfinance/core/schema Schema (safeParse + toJSONSchema).',
      'definition.inputSchema',
    );
  }
  if (definition.outputSchema !== undefined) {
    requireJSONSchema(functionName, 'definition.outputSchema', definition.outputSchema);
  }
  // null is NOT omission: every optional member is validated whenever it is present.
  const sideEffect = definition.sideEffect === undefined ? 'none' : definition.sideEffect;
  const authorization = definition.authorization === undefined ? 'none' : definition.authorization;
  const idempotency =
    definition.idempotency === undefined ? 'not-applicable' : definition.idempotency;
  const costClass = definition.costClass === undefined ? 'small' : definition.costClass;
  if (!SIDE_EFFECTS.includes(sideEffect))
    refuse(
      functionName,
      `sideEffect must be one of ${SIDE_EFFECTS.join(', ')}.`,
      'definition.sideEffect',
      ErrorCode.InputInvalidEnum,
    );
  if (!AUTHORIZATIONS.includes(authorization))
    refuse(
      functionName,
      `authorization must be one of ${AUTHORIZATIONS.join(', ')}.`,
      'definition.authorization',
      ErrorCode.InputInvalidEnum,
    );
  if (!IDEMPOTENCIES.includes(idempotency))
    refuse(
      functionName,
      `idempotency must be one of ${IDEMPOTENCIES.join(', ')}.`,
      'definition.idempotency',
      ErrorCode.InputInvalidEnum,
    );
  if (!COST_CLASSES.includes(costClass))
    refuse(
      functionName,
      `costClass must be one of ${COST_CLASSES.join(', ')}.`,
      'definition.costClass',
      ErrorCode.InputInvalidEnum,
    );
  const stochastic = definition.stochastic === undefined ? false : definition.stochastic;
  if (typeof stochastic !== 'boolean' && typeof stochastic !== 'function') {
    refuse(
      functionName,
      'stochastic must be a boolean or a per-call predicate over the parsed input.',
      'definition.stochastic',
    );
  }
  const deterministic =
    definition.deterministic === undefined ? stochastic === false : definition.deterministic;
  if (typeof deterministic !== 'boolean')
    refuse(functionName, 'deterministic must be a boolean.', 'definition.deterministic');
  if (deterministic && stochastic !== false) {
    refuse(
      functionName,
      'an operation cannot be deterministic and stochastic at once — a stochastic call needs a seed, so declare deterministic: false.',
      'definition.deterministic',
      ErrorCode.InputWrongShape,
    );
  }
  if (
    definition.requiredCapabilities !== undefined &&
    !Array.isArray(definition.requiredCapabilities)
  ) {
    refuse(
      functionName,
      'requiredCapabilities must be an array of capability names.',
      'definition.requiredCapabilities',
    );
  }
  const requiredCapabilities = [...(definition.requiredCapabilities ?? [])];
  for (const capability of requiredCapabilities) {
    if (typeof capability !== 'string' || capability.length === 0)
      refuse(
        functionName,
        'requiredCapabilities must be non-empty strings.',
        'definition.requiredCapabilities',
      );
  }
  if (definition.handleFields !== undefined && !Array.isArray(definition.handleFields)) {
    refuse(
      functionName,
      'handleFields must be an array of input paths.',
      'definition.handleFields',
    );
  }
  const handleFields = [...(definition.handleFields ?? [])];
  for (const field of handleFields) {
    if (typeof field !== 'string' || field.length === 0)
      refuse(
        functionName,
        'handleFields must be non-empty input paths.',
        'definition.handleFields',
      );
  }
  const supportsCancellation =
    definition.supportsCancellation === undefined ? false : definition.supportsCancellation;
  if (typeof supportsCancellation !== 'boolean')
    refuse(
      functionName,
      'supportsCancellation must be a boolean.',
      'definition.supportsCancellation',
    );
  if (typeof definition.run !== 'function')
    refuse(
      functionName,
      'run must be a function (input, context) => { summary, structured }.',
      'definition.run',
    );
  return Object.freeze({
    id: definition.id,
    version,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema ?? null,
    sideEffect,
    authorization,
    idempotency,
    deterministic,
    stochastic,
    costClass,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    supportsCancellation,
    handleFields: Object.freeze(handleFields),
    run: definition.run,
  });
}

/** Annotations are a pure function of the effect metadata — the one place a transport hint is decided. */
export function operationAnnotations(
  operation: Pick<TotalFinanceOperation, 'sideEffect' | 'idempotency' | 'requiredCapabilities'>,
): OperationAnnotations {
  requireArgumentObject('operationAnnotations', 'operation', operation);
  ensureKnownKeys('operationAnnotations', 'operation', operation as object, OPERATION_KEYS);
  const record = operation as unknown as Record<string, unknown>;
  if (!SIDE_EFFECTS.includes(record['sideEffect'] as OperationSideEffect))
    refuse(
      'operationAnnotations',
      `operation.sideEffect must be one of ${SIDE_EFFECTS.join(', ')}.`,
      'operation.sideEffect',
      ErrorCode.InputInvalidEnum,
    );
  if (!IDEMPOTENCIES.includes(record['idempotency'] as OperationIdempotency))
    refuse(
      'operationAnnotations',
      `operation.idempotency must be one of ${IDEMPOTENCIES.join(', ')}.`,
      'operation.idempotency',
      ErrorCode.InputInvalidEnum,
    );
  if (!Array.isArray(record['requiredCapabilities']))
    refuse(
      'operationAnnotations',
      'operation.requiredCapabilities must be an array.',
      'operation.requiredCapabilities',
    );
  const readOnly = operation.sideEffect === 'none';
  return {
    readOnlyHint: readOnly,
    destructiveHint: operation.sideEffect === 'external-order',
    idempotentHint: readOnly || operation.idempotency === 'required',
    // Open-world means the call reaches beyond the process (an order, a stored ledger) — an
    // effect, not a permission: a capability-gated read (B6: preflight needs trade:propose) is
    // still a closed-world call.
    openWorldHint: operation.sideEffect !== 'none',
  };
}

const OPERATION_KEYS = [
  'id',
  'version',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'sideEffect',
  'authorization',
  'idempotency',
  'deterministic',
  'stochastic',
  'costClass',
  'requiredCapabilities',
  'supportsCancellation',
  'handleFields',
  'run',
] as const;

/**
 * Prove a value is a COMPLETE operation (the shape `defineOperation` returns): closed keys, every
 * member typed. The one guard every door that receives an operation applies — a hand-assembled
 * object with a missing member or a null effect field never reaches a registry or a transport.
 */
export function requireOperation(
  functionName: string,
  field: string,
  value: unknown,
): TotalFinanceOperation {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, OPERATION_KEYS);
  const record = value as Record<string, unknown>;
  const teaching = `${field} must be a complete operation — build it with defineOperation({ id, title, description, inputSchema, run })`;
  if (typeof record['id'] !== 'string' || !OPERATION_ID.test(record['id'])) {
    refuse(
      functionName,
      `${field}.id must match totalfinance.<domain>.<verb>; ${teaching}.`,
      `${field}.id`,
      ErrorCode.InputWrongShape,
    );
  }
  if (typeof record['version'] !== 'string' || !/^[1-9][0-9]*$/.test(record['version'])) {
    refuse(
      functionName,
      `${field}.version must be a positive integer string; ${teaching}.`,
      `${field}.version`,
      ErrorCode.InputWrongShape,
    );
  }
  for (const member of ['title', 'description'] as const) {
    if (typeof record[member] !== 'string' || (record[member] as string).length === 0) {
      refuse(
        functionName,
        `${field}.${member} must be a non-empty string; ${teaching}.`,
        `${field}.${member}`,
      );
    }
  }
  const schema = record['inputSchema'] as { safeParse?: unknown; toJSONSchema?: unknown } | null;
  if (
    schema === null ||
    typeof schema !== 'object' ||
    typeof schema.safeParse !== 'function' ||
    typeof schema.toJSONSchema !== 'function'
  ) {
    refuse(
      functionName,
      `${field}.inputSchema must be a @totalfinance/core/schema Schema; ${teaching}.`,
      `${field}.inputSchema`,
    );
  }
  if (record['outputSchema'] === undefined) {
    refuse(
      functionName,
      `${field}.outputSchema must be a JSON Schema object or null; ${teaching}.`,
      `${field}.outputSchema`,
      ErrorCode.InputMissingField,
    );
  }
  if (record['outputSchema'] !== null) {
    requireJSONSchema(functionName, `${field}.outputSchema`, record['outputSchema']);
  }
  if (!SIDE_EFFECTS.includes(record['sideEffect'] as OperationSideEffect))
    refuse(
      functionName,
      `${field}.sideEffect must be one of ${SIDE_EFFECTS.join(', ')}; ${teaching}.`,
      `${field}.sideEffect`,
      ErrorCode.InputInvalidEnum,
    );
  if (!AUTHORIZATIONS.includes(record['authorization'] as OperationAuthorization))
    refuse(
      functionName,
      `${field}.authorization must be one of ${AUTHORIZATIONS.join(', ')}; ${teaching}.`,
      `${field}.authorization`,
      ErrorCode.InputInvalidEnum,
    );
  if (!IDEMPOTENCIES.includes(record['idempotency'] as OperationIdempotency))
    refuse(
      functionName,
      `${field}.idempotency must be one of ${IDEMPOTENCIES.join(', ')}; ${teaching}.`,
      `${field}.idempotency`,
      ErrorCode.InputInvalidEnum,
    );
  if (!COST_CLASSES.includes(record['costClass'] as OperationCostClass))
    refuse(
      functionName,
      `${field}.costClass must be one of ${COST_CLASSES.join(', ')}; ${teaching}.`,
      `${field}.costClass`,
      ErrorCode.InputInvalidEnum,
    );
  if (typeof record['deterministic'] !== 'boolean')
    refuse(
      functionName,
      `${field}.deterministic must be a boolean; ${teaching}.`,
      `${field}.deterministic`,
    );
  if (typeof record['stochastic'] !== 'boolean' && typeof record['stochastic'] !== 'function')
    refuse(
      functionName,
      `${field}.stochastic must be a boolean or a per-call predicate; ${teaching}.`,
      `${field}.stochastic`,
    );
  if (record['deterministic'] === true && record['stochastic'] !== false)
    refuse(
      functionName,
      `${field} cannot be deterministic and stochastic at once; ${teaching}.`,
      `${field}.deterministic`,
      ErrorCode.InputWrongShape,
    );
  for (const member of ['requiredCapabilities', 'handleFields'] as const) {
    const list = record[member];
    if (
      !Array.isArray(list) ||
      list.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      refuse(
        functionName,
        `${field}.${member} must be an array of non-empty strings; ${teaching}.`,
        `${field}.${member}`,
      );
    }
  }
  if (typeof record['supportsCancellation'] !== 'boolean')
    refuse(
      functionName,
      `${field}.supportsCancellation must be a boolean; ${teaching}.`,
      `${field}.supportsCancellation`,
    );
  if (typeof record['run'] !== 'function')
    refuse(functionName, `${field}.run must be a function; ${teaching}.`, `${field}.run`);
  return value as TotalFinanceOperation;
}

/** The transport-neutral description of an operation — what CLI help, OpenAPI, and MCP tools render. */
export function describeOperation(operation: TotalFinanceOperation): OperationDescription {
  requireOperation('describeOperation', 'operation', operation);
  return {
    id: operation.id,
    version: operation.version,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.inputSchema.toJSONSchema(),
    outputSchema: operation.outputSchema,
    sideEffect: operation.sideEffect,
    authorization: operation.authorization,
    idempotency: operation.idempotency,
    deterministic: operation.deterministic,
    stochastic: typeof operation.stochastic === 'function' ? 'per-call' : operation.stochastic,
    costClass: operation.costClass,
    requiredCapabilities: [...operation.requiredCapabilities],
    supportsCancellation: operation.supportsCancellation,
    handleFields: [...operation.handleFields],
    annotations: operationAnnotations(operation),
  };
}

/** The one error shape every transport maps: the QuantError code, or a runtime code. */
export interface OperationError {
  code: string;
  message: string;
  context: Record<string, unknown>;
  issues?: SchemaIssue[];
  operation: { id: string; version: string } | null;
}

export interface OperationResult<Output = Record<string, unknown>> {
  operation: { id: string; version: string };
  library: { version: string };
  summary: string;
  structured: Output;
  assumptions: Record<string, unknown>;
  diagnostics: { warnings: QuantWarning[]; status: 'complete' | 'partial'; incomplete: string[] };
  identity: { inputsHash: string; artifactIds: string[]; snapshotHash: string | null };
  artifacts: ResourceHandle[];
  usage: { inputBytes: number; elapsedMs: number | null };
  trace: { requestId: string | null };
}
