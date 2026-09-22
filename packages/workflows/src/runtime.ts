/**
 * The one runtime every transport calls (Stage 7A Decision 2) — extracted from `@insiderfinance/totalfinance-mcp`'s
 * server so the byte budget, the strict parse, the seed policy, the deadline verdict, the JSON-safe
 * normalization, and the error mapping exist exactly once.
 */

import type { EpochMs } from '@totalfinance/core';
import {
  WarningCode,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isQuantError,
  requireArgumentObject,
  type QuantWarning,
} from '@totalfinance/core';
import { canonicalJsonOf, contentHash, fromCanonicalJson } from '@totalfinance/core/artifacts';
import { jsonSafe } from './json-safe.js';
import { boundedPreview } from './preview.js';
import { parseHandleUri, type ArtifactStore } from './stores.js';
import type { AuthorizationStore, ExecutionJournalStore } from './stores-trade.js';
import { DEFAULT_CAPABILITIES, missingCapabilities, requireCapabilities } from './capabilities.js';
import { WORKFLOWS_VERSION } from './version.js';
import {
  requireOperation,
  type ArtifactStoreReader,
  type OperationContext,
  type OperationError,
  type OperationResult,
  type OperationSignal,
  type TotalFinanceOperation,
  type ResourceHandle,
} from './operation.js';

export const OPERATION_BUDGETS = Object.freeze({
  /**
   * Serialized input bytes a call may carry (UTF-8, measured on the raw request). A WIRE budget: a
   * transport always passes one (the MCP server's default is 64 KiB); an in-process run that omits
   * it is bounded by the operation's own row caps instead.
   */
  maxInputBytes: Object.freeze({ transportDefault: 65_536, maximum: 16_777_216 }),
  /**
   * Canonical bytes of a structured result above which, when a WRITABLE artifact store is supplied,
   * the result is stored and the response carries its handle with a bounded preview — never a
   * silent truncation (Decision 5).
   */
  inlineResultBytes: Object.freeze({ default: 262_144, maximum: 16_777_216 }),
});

export interface RunOperationOptions {
  /** Reject a call whose serialized input exceeds this many UTF-8 bytes; omitted ⇒ no byte budget (the operation's row caps still bound work). */
  maxInputBytes?: number;
  /** Injected for a stochastic call that omits its seed; echoed under `assumptions.seed` (default 0). */
  defaultSeed?: number;
  /** Post-hoc wall-clock verdict for an inline run (ms); a job runner pre-empts instead. */
  deadlineMs?: number;
  signal?: OperationSignal;
  /**
   * The store handles in the input resolve through (`operation.handleFields`). A WRITABLE store
   * (`put`) also receives a result whose canonical bytes exceed `inlineResultBytes`; that needs
   * `createdTimestampMs` — the caller's clock, never the library's.
   */
  artifacts?: ArtifactStoreReader | ArtifactStore;
  /** Spill threshold in canonical bytes (default 256 KiB); only meaningful with a writable store. */
  inlineResultBytes?: number;
  /** Epoch ms stamped on a spilled result's handle (the caller's clock); required with a writable store. */
  createdTimestampMs?: EpochMs;
  requestId?: string;
  /** Elapsed-time source for `usage` only — never for a result. Defaults to `Date.now`. */
  now?: () => number;
  /** What the caller holds (Stage 7B.2 Decision 9); default DEFAULT_CAPABILITIES (read, analyze, propose). */
  capabilities?: readonly string[];
  /** The trade lifecycle's stores (Decision 10): authorization grants and execution journals. */
  stores?: { authorization?: AuthorizationStore; journal?: ExecutionJournalStore };
}

const RUN_OPTION_KEYS = [
  'maxInputBytes',
  'defaultSeed',
  'deadlineMs',
  'signal',
  'artifacts',
  'inlineResultBytes',
  'createdTimestampMs',
  'requestId',
  'now',
  'capabilities',
  'stores',
] as const;

function requireStoresOption(
  functionName: string,
  value: unknown,
): { authorization: AuthorizationStore | null; journal: ExecutionJournalStore | null } {
  if (value === undefined) return { authorization: null, journal: null };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(
      `${functionName}: request.stores must be an object ({ authorization?, journal? }) when present.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'request.stores' },
      },
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'authorization' && key !== 'journal') {
      throw new InputError(
        `${functionName}: unknown field "${key}" in request.stores. Allowed fields: authorization, journal.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: 'request.stores', key },
        },
      );
    }
  }
  const shaped = <T>(field: string, store: unknown, methods: string[]): T | null => {
    if (store === undefined) return null;
    if (
      store === null ||
      typeof store !== 'object' ||
      methods.some((m) => typeof (store as Record<string, unknown>)[m] !== 'function')
    ) {
      throw new InputError(
        `${functionName}: request.stores.${field} must be a store with ${methods.join(', ')} when present.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `request.stores.${field}` },
        },
      );
    }
    return store as T;
  };
  return {
    authorization: shaped<AuthorizationStore>('authorization', record['authorization'], [
      'put',
      'get',
      'list',
    ]),
    journal: shaped<ExecutionJournalStore>('journal', record['journal'], [
      'transact',
      'append',
      'read',
      'list',
    ]),
  };
}

function failure(
  code: ErrorCode,
  message: string,
  context: Record<string, unknown>,
  operation: TotalFinanceOperation | null,
): InputError {
  return new InputError(message, {
    code,
    context: {
      ...context,
      ...(operation === null
        ? {}
        : { operation: { id: operation.id, version: operation.version } }),
    },
  });
}

/**
 * Map any thrown value to the one error shape every transport renders: a QuantError keeps its code,
 * message, and context (a schema refusal keeps its issues); anything else is `operation.internal`.
 * The runtime itself THROWS the typed error (an embedding caller sees the same teaching error the
 * direct SDK call would raise); a transport calls this at its edge.
 */
export function toOperationError(
  error: unknown,
  operation: TotalFinanceOperation | null,
): OperationError {
  if (error === undefined || error === null) {
    throw new InputError(
      'toOperationError: error must be the thrown value (a QuantError, an Error, or any other throwable); undefined/null is not a failure to map.',
      {
        code: ErrorCode.InputMissingField,
        context: { function: 'toOperationError', field: 'error' },
      },
    );
  }
  if (operation !== null) requireOperation('toOperationError', 'operation', operation);
  const identity = operation === null ? null : { id: operation.id, version: operation.version };
  if (isQuantError(error)) {
    const context = { ...(error.context as Record<string, unknown>) };
    const issues = (error as { issues?: OperationError['issues'] }).issues;
    return {
      code: error.code,
      message: error.message,
      context,
      ...(issues !== undefined ? { issues } : {}),
      operation: identity,
    };
  }
  return {
    code: ErrorCode.OperationInternal,
    message: error instanceof Error ? error.message : 'operation failed',
    context: {},
    operation: identity,
  };
}

function requireBudget(field: string, value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new InputError(
      `runOperation: ${field} must be a positive finite number ≤ ${maximum}. Received ${typeof value === 'number' ? String(value) : value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: 'runOperation', field } },
    );
  }
  return value;
}

/** UTF-8 byte length of a JSON document — what a wire actually carries — without a platform encoder. */
function utf8Bytes(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // a surrogate pair encodes one 4-byte code point
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** A handle reference in an input: a `totalfinance://…` uri or a ResourceHandle object. */
function handleUriIn(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('totalfinance://') ? value : null;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const uri = (value as Record<string, unknown>)['uri'];
    const kind = (value as Record<string, unknown>)['kind'];
    if (typeof uri === 'string' && uri.startsWith('totalfinance://') && typeof kind === 'string')
      return uri;
  }
  return null;
}

/**
 * Resolve every `handleFields` path of the raw input through the store: a missing store, an
 * unknown uri, and a kind mismatch each refuse with their registered code; a resolved field is
 * replaced by a fresh copy of the stored value, so validation and compute see inline data.
 */
function resolveHandles(
  operation: TotalFinanceOperation,
  input: unknown,
  store: ArtifactStoreReader | null,
): unknown {
  if (operation.handleFields.length === 0) return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  let output: Record<string, unknown> = input as Record<string, unknown>;
  for (const path of operation.handleFields) {
    const segments = path.split('.');
    // Walk to the parent, copying each level touched so the caller's object is never mutated.
    const parents: Record<string, unknown>[] = [output];
    let cursor: Record<string, unknown> = output;
    let reachable = true;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        reachable = false;
        break;
      }
      cursor = next as Record<string, unknown>;
      parents.push(cursor);
    }
    if (!reachable) continue;
    const leaf = segments[segments.length - 1]!;
    const uri = handleUriIn(cursor[leaf]);
    if (uri === null) continue;
    if (store === null) {
      throw failure(
        ErrorCode.OperationHandleStoreMissing,
        `${operation.id}: ${path} references ${uri} but no artifact store was supplied to resolve it — pass \`artifacts\` or send the data inline.`,
        { field: path, uri },
        operation,
      );
    }
    const { kind } = parseHandleUri(uri);
    if (kind === 'job') {
      throw failure(
        ErrorCode.OperationHandleKindMismatch,
        `${operation.id}: ${path} references a job handle (${uri}); a job is not data — read its result handle (job result) and pass that.`,
        { field: path, uri, kind },
        operation,
      );
    }
    const entry = store.get(uri);
    if (entry === null) {
      throw failure(
        ErrorCode.OperationHandleUnknown,
        `${operation.id}: ${path} references ${uri}, which the supplied store does not hold — list the store (artifacts list) for the known handles.`,
        { field: path, uri },
        operation,
      );
    }
    if (entry.handle.kind !== kind) {
      throw failure(
        ErrorCode.OperationHandleKindMismatch,
        `${operation.id}: ${path} references ${uri}, whose namespace says '${kind}' but the stored handle is a '${entry.handle.kind}'.`,
        { field: path, uri, kind, storedKind: entry.handle.kind },
        operation,
      );
    }
    // Copy-on-write along the path.
    const copies: Record<string, unknown>[] = parents.map((level) => ({ ...level }));
    for (let index = 0; index < copies.length - 1; index += 1) {
      copies[index]![segments[index]!] = copies[index + 1];
    }
    copies[copies.length - 1]![leaf] = fromCanonicalJson(canonicalJsonOf(entry.value));
    output = copies[0]!;
  }
  return output;
}

/**
 * Run one operation: bytes → strict parse → seed policy → run → JSON-safe → identity/usage.
 * Throws the typed teaching error a direct call would raise (a QuantError with a registered code); never a raw crash.
 */
export interface RunOperationInput<
  Input = unknown,
  Output extends Record<string, unknown> = Record<string, unknown>,
> extends RunOperationOptions {
  operation: TotalFinanceOperation<Input, Output>;

  /** The raw request as the caller (or the wire) supplied it — validated here, never trusted. */
  input: unknown;
}

const RUN_INPUT_KEYS = ['operation', 'input', ...RUN_OPTION_KEYS] as const;

export function runOperation<Input, Output extends Record<string, unknown>>(
  request: RunOperationInput<Input, Output>,
): OperationResult<Output> {
  const functionName = 'runOperation';
  requireArgumentObject(functionName, 'request', request);
  ensureKnownKeys(functionName, 'request', request, RUN_INPUT_KEYS);
  const { operation, input, ...options } = request;
  requireOperation(functionName, 'request.operation', operation);
  // null is NOT omission: an optional runtime member present as null (or mistyped) teaches.
  if (options.signal !== undefined) {
    const signal = options.signal as { aborted?: unknown } | null;
    if (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
      throw new InputError(
        `${functionName}: request.signal must be an AbortSignal-like object with a boolean \`aborted\` when present.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: 'request.signal' },
        },
      );
    }
  }
  if (options.artifacts !== undefined) {
    const store = options.artifacts as { get?: unknown; list?: unknown; put?: unknown } | null;
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store.get !== 'function' ||
      typeof store.list !== 'function'
    ) {
      throw new InputError(
        `${functionName}: request.artifacts must be an artifact store reader ({ get, list }) when present.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: 'request.artifacts' },
        },
      );
    }
    if (store.put !== undefined && typeof store.put !== 'function') {
      throw new InputError(
        `${functionName}: request.artifacts.put must be a function when present (a writable store).`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: 'request.artifacts.put' },
        },
      );
    }
  }
  const writable =
    options.artifacts !== undefined &&
    typeof (options.artifacts as { put?: unknown }).put === 'function';
  if (options.createdTimestampMs !== undefined) {
    if (
      typeof options.createdTimestampMs !== 'number' ||
      !Number.isSafeInteger(options.createdTimestampMs)
    ) {
      throw new InputError(
        `${functionName}: request.createdTimestampMs must be an integer epoch-millisecond instant (the caller's clock, stamped on a spilled result's handle).`,
        {
          code:
            typeof options.createdTimestampMs === 'number'
              ? ErrorCode.InputWrongShape
              : ErrorCode.InputWrongType,
          context: { function: functionName, field: 'request.createdTimestampMs' },
        },
      );
    }
  }
  if (writable && options.createdTimestampMs === undefined) {
    throw new InputError(
      `${functionName}: request.createdTimestampMs is required with a writable artifact store — a spilled result's handle carries the caller's clock, never the library's.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'request.createdTimestampMs' },
      },
    );
  }
  if (options.inlineResultBytes !== undefined && !writable) {
    throw new InputError(
      `${functionName}: request.inlineResultBytes needs a writable artifact store (put) to spill into; supply one or omit the threshold.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, field: 'request.inlineResultBytes' },
      },
    );
  }
  if (
    options.requestId !== undefined &&
    (typeof options.requestId !== 'string' || options.requestId.length === 0)
  ) {
    throw new InputError(
      `${functionName}: request.requestId must be a non-empty string when present.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'request.requestId' },
      },
    );
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new InputError(
      `${functionName}: request.now must be a function returning milliseconds when present.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'request.now' },
      },
    );
  }
  const maxInputBytes =
    options.maxInputBytes === undefined
      ? null
      : requireBudget(
          'request.maxInputBytes',
          options.maxInputBytes,
          OPERATION_BUDGETS.maxInputBytes.maximum,
          OPERATION_BUDGETS.maxInputBytes.maximum,
        );
  const deadlineMs =
    options.deadlineMs === undefined
      ? null
      : requireBudget('request.deadlineMs', options.deadlineMs, 0, Number.MAX_SAFE_INTEGER);
  const inlineResultBytes = !writable
    ? null
    : options.inlineResultBytes === undefined
      ? OPERATION_BUDGETS.inlineResultBytes.default
      : requireBudget(
          'request.inlineResultBytes',
          options.inlineResultBytes,
          OPERATION_BUDGETS.inlineResultBytes.maximum,
          OPERATION_BUDGETS.inlineResultBytes.maximum,
        );
  const defaultSeed = options.defaultSeed === undefined ? 0 : options.defaultSeed;
  if (typeof defaultSeed !== 'number' || !Number.isSafeInteger(defaultSeed)) {
    throw new InputError(
      `${functionName}: request.defaultSeed must be a safe integer (it is injected into any stochastic call that omits a seed and must satisfy the operation's own seed schema). Received ${String(defaultSeed)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'request.defaultSeed' },
      },
    );
  }
  const now = options.now === undefined ? () => Date.now() : options.now;
  const generic = operation as unknown as TotalFinanceOperation;

  // 1. The byte budget, measured on the RAW request — what a wire actually carried.
  const capabilities =
    options.capabilities === undefined
      ? DEFAULT_CAPABILITIES
      : requireCapabilities(functionName, 'request.capabilities', options.capabilities);
  const stores = requireStoresOption(functionName, options.stores);
  // Decision 9: the capability gate runs BEFORE the input is parsed — a caller without authority
  // learns that first, and learns nothing about the input's validity.
  const missing = missingCapabilities(generic.requiredCapabilities, capabilities);
  if (missing.length > 0) {
    throw failure(
      ErrorCode.OperationCapabilityMissing,
      `${operation.id}: requires the ${missing.map((name) => `'${name}'`).join(', ')} capabilit${missing.length === 1 ? 'y' : 'ies'} the caller does not hold (held: ${capabilities.length === 0 ? 'none' : capabilities.map((name) => `'${name}'`).join(', ')}) — grant ${missing.length === 1 ? 'it' : 'them'} explicitly (\`capabilities\`; the CLI's --capability).`,
      { missing, held: [...capabilities] },
      generic,
    );
  }
  const inputBytes = utf8Bytes(input ?? {});
  if (maxInputBytes !== null && inputBytes > maxInputBytes) {
    throw failure(
      ErrorCode.OperationInputTooLarge,
      `${operation.id}: the input is ${inputBytes} bytes, above the ${maxInputBytes}-byte budget — reference bulk data by handle or raise maxInputBytes (maximum ${OPERATION_BUDGETS.maxInputBytes.maximum}).`,
      { inputBytes, maxInputBytes },
      generic,
    );
  }
  // 2. Handles resolve through the supplied store BEFORE validation (Decision 5): a handle field may
  //    carry a `totalfinance://…` uri or a ResourceHandle in place of inline data.
  const resolved = resolveHandles(generic, input, options.artifacts ?? null);
  // 3. Strict parse: the schema's own teaching error, with its issues.
  const parsed = operation.inputSchema.safeParse(resolved, { mode: 'strict' });
  if (!parsed.success) throw parsed.error;
  let effective = parsed.data;
  // 4. The seed policy — decided on the PARSED input so schema defaults count; a deterministic call
  //    never gets (or echoes) a meaningless seed.
  const stochasticCall =
    typeof operation.stochastic === 'function'
      ? operation.stochastic(effective)
      : operation.stochastic === true;
  let seed: number | null = null;
  if (stochasticCall) {
    const record =
      effective !== null && typeof effective === 'object' && !Array.isArray(effective)
        ? (effective as Record<string, unknown>)
        : null;
    const supplied = record?.['seed'];
    if (supplied === undefined) {
      seed = defaultSeed;
      if (record !== null) {
        const reparsed = operation.inputSchema.safeParse(
          { ...record, seed: defaultSeed },
          { mode: 'strict' },
        );
        if (!reparsed.success) {
          throw failure(
            reparsed.error.code as ErrorCode,
            `${operation.id}: the runtime's defaultSeed (${defaultSeed}) does not satisfy this operation's seed schema: ${reparsed.error.message}`,
            { defaultSeed },
            generic,
          );
        }
        effective = reparsed.data;
      }
    } else if (typeof supplied === 'number') {
      seed = supplied;
    }
  }
  // 5. Run.
  const context: OperationContext = {
    seed,
    budgets: { maxInputBytes, deadlineMs },
    signal: options.signal ?? null,
    artifacts: options.artifacts ?? null,
    capabilities,
    stores,
  };
  const started = now();
  // A QuantError from the composed function propagates AS IS — the same typed teaching error the
  // direct SDK call raises; a transport maps it with `toOperationError` at its edge.
  const output = operation.run(effective, context);
  const elapsedMs = now() - started;
  if (deadlineMs !== null && elapsedMs > deadlineMs) {
    throw failure(
      ErrorCode.OperationDeadlineExceeded,
      `${operation.id}: the call took ${Math.round(elapsedMs)}ms, above the ${deadlineMs}ms deadline (reported post hoc — an inline run is not pre-empted; submit a job-class operation to cancel work).`,
      { elapsedMs, deadlineMs },
      generic,
    );
  }
  // 6. JSON-safe output, the seed echoed under assumptions, identity and usage.
  requireArgumentObject(functionName, `${operation.id} output`, output);
  let structured = jsonSafe(output.structured) as Record<string, unknown>;
  const spilled: ResourceHandle[] = [];
  if (inlineResultBytes !== null) {
    const canonical = canonicalJsonOf(structured);
    if (utf8Bytes(canonical) > inlineResultBytes) {
      const handle = (options.artifacts as ArtifactStore).put({
        value: structured,
        kind: 'report',
        createdTimestampMs: options.createdTimestampMs!,
        provenance: {
          ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
        },
      });
      spilled.push(handle);
      structured = { spilled: true, handle, preview: boundedPreview(structured) };
    }
  }
  const rawAssumptions = structured['assumptions'];
  let assumptions: Record<string, unknown> =
    rawAssumptions !== null && typeof rawAssumptions === 'object' && !Array.isArray(rawAssumptions)
      ? (rawAssumptions as Record<string, unknown>)
      : {};
  if (stochasticCall && assumptions['seed'] === undefined) {
    assumptions = { ...assumptions, seed };
    structured = { ...structured, assumptions };
  }
  const rawDiagnostics = structured['diagnostics'];
  // The envelope's warnings are typed `QuantWarning`s. Library results that still report their
  // warnings as bare strings (the ledger, valuation and research families) are carried as
  // `operation.untyped_warning` with the sentence as the message, so a validating client sees one
  // shape and no warning is dropped on the way to the wire.
  const warnings: QuantWarning[] =
    rawDiagnostics !== null &&
    typeof rawDiagnostics === 'object' &&
    Array.isArray((rawDiagnostics as Record<string, unknown>)['warnings'])
      ? ((rawDiagnostics as Record<string, unknown>)['warnings'] as unknown[]).map((warning) =>
          typeof warning === 'string'
            ? { code: WarningCode.OperationUntypedWarning, message: warning, severity: 'warn' }
            : (warning as QuantWarning),
        )
      : [];
  const artifacts = [...(output.artifacts ?? []), ...spilled];
  return {
    operation: { id: operation.id, version: operation.version },
    library: { version: WORKFLOWS_VERSION },
    summary: output.summary,
    structured: structured as Output,
    assumptions,
    diagnostics: {
      warnings,
      status: output.status ?? 'complete',
      incomplete: [...(output.incomplete ?? [])],
    },
    identity: {
      inputsHash: contentHash(effective as Record<string, unknown>),
      artifactIds: artifacts.map((handle) => handle.uri),
      snapshotHash: null,
    },
    artifacts,
    usage: { inputBytes, elapsedMs },
    trace: { requestId: options.requestId ?? null },
  };
}
