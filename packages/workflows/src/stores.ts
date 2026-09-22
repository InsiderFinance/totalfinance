/**
 * Handles, artifact stores, and job stores (Stage 7A Decision 5): explicit, store-scoped references
 * to stored data — never implicit session state. The memory stores here are pure and browser-safe;
 * `@insiderfinance/totalfinance/cli` ships the file-backed ones over the same contracts.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { EpochMs, Provenance } from '@totalfinance/core';
import { canonicalJsonOf, contentHash, fromCanonicalJson } from '@totalfinance/core/artifacts';
import type {
  ArtifactStoreReader,
  OperationError,
  ResourceHandle,
  ResourceHandleKind,
} from './operation.js';

/** The handle kinds, their uri namespaces, and the envelope kind a stored value of that kind carries. */
export const HANDLE_KINDS = Object.freeze({
  report: Object.freeze({ namespace: 'reports', envelopeKind: null }),
  job: Object.freeze({ namespace: 'jobs', envelopeKind: null }),
  portfolio: Object.freeze({
    namespace: 'portfolios',
    envelopeKind: 'totalfinance.portfolio-ledger',
  }),
  scenario: Object.freeze({ namespace: 'scenarios', envelopeKind: 'totalfinance.scenario-set' }),
  market: Object.freeze({ namespace: 'markets', envelopeKind: 'totalfinance.market-snapshot' }),
  authorization: Object.freeze({
    namespace: 'authorizations',
    envelopeKind: 'totalfinance.authorization-grant',
  }),
  journal: Object.freeze({ namespace: 'journals', envelopeKind: null }),
} as const) satisfies Record<
  ResourceHandleKind,
  { namespace: string; envelopeKind: string | null }
>;

const HANDLE_KIND_NAMES = Object.keys(HANDLE_KINDS) as ResourceHandleKind[];
const HANDLE_URI = /^totalfinance:\/\/([a-z]+)\/([A-Za-z0-9:._-]+)$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

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

/** The guard label every positional guard carries first (core's own order); a missing label is a caller bug. */
function requireFunctionName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `requireFunctionName: functionName must be a non-empty string naming the public function that reports the refusal. Received ${value === undefined ? 'undefined' : JSON.stringify(value)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: 'requireFunctionName', field: 'functionName' },
      },
    );
  }
}

function requireIsoInstant(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    refuse(
      functionName,
      `${field} must be an ISO-8601 instant with a zone (e.g. 2026-09-03T14:00:00Z) — the caller's clock, never the library's.`,
      field,
      typeof value === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return value;
}

/** An integer epoch-millisecond instant — the caller's clock, never the library's. */
function requireEpochInstant(functionName: string, field: string, value: unknown): EpochMs {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    refuse(
      functionName,
      `${field} must be an integer epoch-millisecond instant (e.g. Date.parse('2026-09-03T14:00:00Z')) — the caller's clock, never the library's.`,
      field,
      typeof value === 'number' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireHandleKind(
  functionName: string,
  field: string,
  value: unknown,
): ResourceHandleKind {
  if (typeof value !== 'string' || !HANDLE_KIND_NAMES.includes(value as ResourceHandleKind)) {
    refuse(
      functionName,
      `${field} must be one of ${HANDLE_KIND_NAMES.join(', ')}.`,
      field,
      typeof value === 'string' ? ErrorCode.InputInvalidEnum : ErrorCode.InputWrongType,
    );
  }
  return value as ResourceHandleKind;
}

/** The uri of a handle: `totalfinance://<namespace>/<id>` — content hash for data, the job id for a job. */
export function handleUriOf(kind: ResourceHandleKind, id: string): string {
  requireHandleKind('handleUriOf', 'kind', kind);
  if (typeof id !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(id)) {
    refuse(
      'handleUriOf',
      'id must be a non-empty string of [A-Za-z0-9:._-] (a content hash or a job id).',
      'id',
      typeof id === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return `totalfinance://${HANDLE_KINDS[kind].namespace}/${id}`;
}

/** Parse a handle uri into its kind and id; a malformed uri is refused with the grammar. */
export function parseHandleUri(uri: string): { kind: ResourceHandleKind; id: string } {
  const match = typeof uri === 'string' ? HANDLE_URI.exec(uri) : null;
  const kind = match
    ? HANDLE_KIND_NAMES.find((candidate) => HANDLE_KINDS[candidate].namespace === match[1])
    : undefined;
  if (!match || kind === undefined) {
    refuse(
      'parseHandleUri',
      `uri must match totalfinance://<${HANDLE_KIND_NAMES.map((k) => HANDLE_KINDS[k].namespace).join('|')}>/<id>. Received ${JSON.stringify(uri)}.`,
      'uri',
      typeof uri === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return { kind, id: match[2]! };
}

const HANDLE_KEYS = [
  'uri',
  'kind',
  'schema',
  'version',
  'contentHash',
  'createdTimestampMs',
  'expiresTimestampMs',
  'provenance',
] as const;

/** The closed structural guard for a caller-supplied handle (core's guard order). */
export function requireResourceHandle(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is ResourceHandle {
  requireFunctionName(functionName);
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, HANDLE_KEYS);
  const record = value as Record<string, unknown>;
  const { kind } = parseHandleUri(record['uri'] as string);
  const declaredKind = requireHandleKind(functionName, `${field}.kind`, record['kind']);
  if (declaredKind !== kind) {
    refuse(
      functionName,
      `${field}.kind '${declaredKind}' disagrees with the uri namespace of '${record['uri'] as string}'.`,
      `${field}.kind`,
      ErrorCode.InputWrongShape,
    );
  }
  for (const member of ['schema', 'version'] as const) {
    if (typeof record[member] !== 'string' || (record[member] as string).length === 0) {
      refuse(functionName, `${field}.${member} must be a non-empty string.`, `${field}.${member}`);
    }
  }
  if (record['contentHash'] !== null && typeof record['contentHash'] !== 'string') {
    refuse(functionName, `${field}.contentHash must be a string or null.`, `${field}.contentHash`);
  }
  requireEpochInstant(functionName, `${field}.createdTimestampMs`, record['createdTimestampMs']);
  if (record['expiresTimestampMs'] !== null) {
    requireEpochInstant(functionName, `${field}.expiresTimestampMs`, record['expiresTimestampMs']);
  }
  requireArgumentObject(functionName, `${field}.provenance`, record['provenance']);
}

// ── artifact stores ───────────────────────────────────────────────────────────────────────────

export interface ArtifactStorePutInput {
  /** The stored data — an envelope or an operation's structured result; JSON-safe by construction. */
  value: Record<string, unknown>;
  kind: Exclude<ResourceHandleKind, 'job'>;
  /** Epoch ms — the caller's clock, never read by the library. */
  createdTimestampMs: EpochMs;
  /** Epoch ms; must be after `createdTimestampMs`. */
  expiresTimestampMs?: EpochMs;
  provenance?: Provenance;
}

/** A writable store: `put` is idempotent by content (the same value yields the same handle). */
export interface ArtifactStore extends ArtifactStoreReader {
  put(input: ArtifactStorePutInput): ResourceHandle;
}

const PUT_KEYS = [
  'value',
  'kind',
  'createdTimestampMs',
  'expiresTimestampMs',
  'provenance',
] as const;
const LIST_KEYS = ['kind'] as const;

/** Validate a `put` request and derive the handle it would mint (shared by every store). */
export function requireArtifactPut(
  functionName: string,
  input: unknown,
): { handle: ResourceHandle; canonical: string } {
  requireFunctionName(functionName);
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, PUT_KEYS);
  const request = input as Record<string, unknown>;
  requireArgumentObject(functionName, 'input.value', request['value']);
  const kind = requireHandleKind(functionName, 'input.kind', request['kind']);
  if (kind === 'job') {
    refuse(
      functionName,
      "input.kind 'job' is not stored data — a job lives in the job store and its result is a report handle.",
      'input.kind',
      ErrorCode.InputInvalidEnum,
    );
  }
  const expected = HANDLE_KINDS[kind].envelopeKind;
  const value = request['value'] as Record<string, unknown>;
  if (expected !== null && value['kind'] !== expected) {
    refuse(
      functionName,
      `input.value.kind must be '${expected}' for a '${kind}' handle. Received ${JSON.stringify(value['kind'])}.`,
      'input.value.kind',
      ErrorCode.InputWrongShape,
    );
  }
  const createdTimestampMs = requireEpochInstant(
    functionName,
    'input.createdTimestampMs',
    request['createdTimestampMs'],
  );
  const expiresTimestampMs =
    request['expiresTimestampMs'] === undefined
      ? null
      : requireEpochInstant(
          functionName,
          'input.expiresTimestampMs',
          request['expiresTimestampMs'],
        );
  if (expiresTimestampMs !== null && expiresTimestampMs <= createdTimestampMs) {
    refuse(
      functionName,
      'input.expiresTimestampMs must be after input.createdTimestampMs.',
      'input.expiresTimestampMs',
      ErrorCode.InputOutOfRange,
    );
  }
  if (request['provenance'] !== undefined) {
    requireArgumentObject(functionName, 'input.provenance', request['provenance']);
  }
  let canonical: string;
  try {
    canonical = canonicalJsonOf(value);
  } catch (error) {
    refuse(
      functionName,
      `input.value must be JSON-safe (finite numbers, no functions): ${error instanceof Error ? error.message : String(error)}`,
      'input.value',
      ErrorCode.InputWrongType,
    );
  }
  const hash = contentHash(value);
  const schema =
    typeof value['kind'] === 'string' ? value['kind'] : 'totalfinance.operation-result';
  const version = typeof value['schemaVersion'] === 'number' ? String(value['schemaVersion']) : '1';
  return {
    handle: {
      uri: handleUriOf(kind, hash),
      kind,
      schema,
      version,
      contentHash: hash,
      createdTimestampMs,
      expiresTimestampMs,
      provenance: (request['provenance'] as Provenance | undefined) ?? {},
    },
    canonical,
  };
}

/** Validate a `list` filter (shared by every store). */
export function requireArtifactListFilter(
  functionName: string,
  filter: unknown,
): { kind?: ResourceHandleKind } {
  requireFunctionName(functionName);
  if (filter === undefined) return {};
  requireArgumentObject(functionName, 'filter', filter);
  ensureKnownKeys(functionName, 'filter', filter as object, LIST_KEYS);
  const record = filter as Record<string, unknown>;
  if (record['kind'] === undefined) return {};
  return { kind: requireHandleKind(functionName, 'filter.kind', record['kind']) };
}

function requireUri(functionName: string, uri: unknown): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    refuse(functionName, 'uri must be a non-empty string.', 'uri');
  }
  return uri;
}

/** A pure in-memory artifact store — browser-safe; idempotent by content. */
export function createMemoryArtifactStore(): ArtifactStore {
  const entries = new Map<string, { handle: ResourceHandle; canonical: string }>();
  return {
    put(input) {
      const { handle, canonical } = requireArtifactPut('ArtifactStore.put', input);
      const existing = entries.get(handle.uri);
      if (existing) return existing.handle; // idempotent: the first mint stands
      entries.set(handle.uri, { handle, canonical });
      return handle;
    },
    get(uri) {
      const entry = entries.get(requireUri('ArtifactStore.get', uri));
      if (!entry) return null;
      return {
        handle: entry.handle,
        value: fromCanonicalJson(entry.canonical) as Record<string, unknown>,
      };
    },
    list(filter) {
      const { kind } = requireArtifactListFilter('ArtifactStore.list', filter);
      return [...entries.values()]
        .map((entry) => entry.handle)
        .filter((handle) => kind === undefined || handle.kind === kind)
        .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    },
  };
}

// ── job stores ────────────────────────────────────────────────────────────────────────────────

export type JobState = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const JOB_STATES: readonly JobState[] = Object.freeze([
  'accepted',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/** The legal transitions; a terminal state has none. */
const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  accepted: ['queued', 'running', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export interface JobRecord {
  id: string;
  operation: { id: string; version: string };
  state: JobState;
  progress: { stage: string; fraction: number | null } | null;
  inputsHash: string;
  seed: number | null;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: ResourceHandle | null;
  error: OperationError | null;
  usage: { elapsedMs: number | null };
}

export interface JobStore {
  create(record: JobRecord): JobRecord;
  update(id: string, patch: Partial<Omit<JobRecord, 'id'>>): JobRecord;
  get(id: string): JobRecord | null;
  list(): JobRecord[];
}

const JOB_KEYS = [
  'id',
  'operation',
  'state',
  'progress',
  'inputsHash',
  'seed',
  'submittedAt',
  'startedAt',
  'finishedAt',
  'result',
  'error',
  'usage',
] as const;

function requireNullableInstant(functionName: string, field: string, value: unknown): void {
  if (value !== null) requireIsoInstant(functionName, field, value);
}

/** The closed structural guard for a job record (shared by every store). */
export function requireJobRecord(functionName: string, field: string, value: unknown): JobRecord {
  requireFunctionName(functionName);
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, JOB_KEYS);
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(record['id'])) {
    refuse(
      functionName,
      `${field}.id must be a non-empty string of [A-Za-z0-9:._-].`,
      `${field}.id`,
      typeof record['id'] === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  requireArgumentObject(functionName, `${field}.operation`, record['operation']);
  ensureKnownKeys(functionName, `${field}.operation`, record['operation'] as object, [
    'id',
    'version',
  ]);
  const operation = record['operation'] as Record<string, unknown>;
  for (const member of ['id', 'version'] as const) {
    if (typeof operation[member] !== 'string' || (operation[member] as string).length === 0) {
      refuse(
        functionName,
        `${field}.operation.${member} must be a non-empty string.`,
        `${field}.operation.${member}`,
      );
    }
  }
  if (typeof record['state'] !== 'string' || !JOB_STATES.includes(record['state'] as JobState)) {
    refuse(
      functionName,
      `${field}.state must be one of ${JOB_STATES.join(', ')}.`,
      `${field}.state`,
      typeof record['state'] === 'string' ? ErrorCode.InputInvalidEnum : ErrorCode.InputWrongType,
    );
  }
  if (record['progress'] !== null) {
    requireArgumentObject(functionName, `${field}.progress`, record['progress']);
    ensureKnownKeys(functionName, `${field}.progress`, record['progress'] as object, [
      'stage',
      'fraction',
    ]);
    const progress = record['progress'] as Record<string, unknown>;
    if (typeof progress['stage'] !== 'string') {
      refuse(functionName, `${field}.progress.stage must be a string.`, `${field}.progress.stage`);
    }
    if (
      progress['fraction'] !== null &&
      (typeof progress['fraction'] !== 'number' ||
        !Number.isFinite(progress['fraction']) ||
        progress['fraction'] < 0 ||
        progress['fraction'] > 1)
    ) {
      refuse(
        functionName,
        `${field}.progress.fraction must be a number in [0, 1] or null.`,
        `${field}.progress.fraction`,
        typeof progress['fraction'] === 'number'
          ? ErrorCode.InputOutOfRange
          : ErrorCode.InputWrongType,
      );
    }
  }
  if (typeof record['inputsHash'] !== 'string' || record['inputsHash'].length === 0) {
    refuse(functionName, `${field}.inputsHash must be a non-empty string.`, `${field}.inputsHash`);
  }
  if (record['seed'] !== null && !Number.isSafeInteger(record['seed'])) {
    refuse(
      functionName,
      `${field}.seed must be a safe integer or null.`,
      `${field}.seed`,
      typeof record['seed'] === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
    );
  }
  requireIsoInstant(functionName, `${field}.submittedAt`, record['submittedAt']);
  requireNullableInstant(functionName, `${field}.startedAt`, record['startedAt']);
  requireNullableInstant(functionName, `${field}.finishedAt`, record['finishedAt']);
  if (record['result'] !== null)
    requireResourceHandle(functionName, `${field}.result`, record['result']);
  if (record['error'] !== null) {
    requireArgumentObject(functionName, `${field}.error`, record['error']);
    const error = record['error'] as Record<string, unknown>;
    if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
      refuse(
        functionName,
        `${field}.error must be an OperationError ({ code, message, context, operation }) or null.`,
        `${field}.error`,
        ErrorCode.InputWrongShape,
      );
    }
  }
  requireArgumentObject(functionName, `${field}.usage`, record['usage']);
  ensureKnownKeys(functionName, `${field}.usage`, record['usage'] as object, ['elapsedMs']);
  const usage = record['usage'] as Record<string, unknown>;
  if (
    usage['elapsedMs'] !== null &&
    !(
      typeof usage['elapsedMs'] === 'number' &&
      Number.isFinite(usage['elapsedMs']) &&
      usage['elapsedMs'] >= 0
    )
  ) {
    refuse(
      functionName,
      `${field}.usage.elapsedMs must be a non-negative finite number or null.`,
      `${field}.usage.elapsedMs`,
      typeof usage['elapsedMs'] === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
    );
  }
  return value as JobRecord;
}

/** Apply a patch to a record under the state machine; the merged record is re-validated whole. */
export function applyJobPatch(functionName: string, current: JobRecord, patch: unknown): JobRecord {
  requireFunctionName(functionName);
  requireJobRecord(functionName, 'current', current);
  requireArgumentObject(functionName, 'patch', patch);
  ensureKnownKeys(
    functionName,
    'patch',
    patch as object,
    JOB_KEYS.filter((key) => key !== 'id'),
  );
  const next = patch as Partial<Omit<JobRecord, 'id'>>;
  if (next.state !== undefined && next.state !== current.state) {
    if (!JOB_TRANSITIONS[current.state].includes(next.state)) {
      refuse(
        functionName,
        `job ${current.id} cannot move from '${current.state}' to '${String(next.state)}'${JOB_TRANSITIONS[current.state].length === 0 ? ' — a terminal state never changes' : ` — allowed: ${JOB_TRANSITIONS[current.state].join(', ')}`}.`,
        'patch.state',
        ErrorCode.InputWrongShape,
      );
    }
  } else if (JOB_TRANSITIONS[current.state].length === 0 && Object.keys(next).length > 0) {
    refuse(
      functionName,
      `job ${current.id} is '${current.state}' — a terminal record never changes.`,
      'patch',
      ErrorCode.InputWrongShape,
    );
  }
  return requireJobRecord(functionName, 'record', { ...current, ...next });
}

/** A pure in-memory job store — browser-safe; records are copied on the way in and out. */
export function createMemoryJobStore(): JobStore {
  const records = new Map<string, JobRecord>();
  const copy = (record: JobRecord): JobRecord =>
    fromCanonicalJson(canonicalJsonOf(record)) as JobRecord;
  const requireId = (functionName: string, id: unknown): string => {
    if (typeof id !== 'string' || id.length === 0)
      refuse(functionName, 'id must be a non-empty string.', 'id');
    return id;
  };
  return {
    create(record) {
      const valid = requireJobRecord('JobStore.create', 'record', record);
      if (records.has(valid.id)) {
        refuse(
          'JobStore.create',
          `a job with id '${valid.id}' already exists — ids are minted once.`,
          'record.id',
          ErrorCode.InputWrongShape,
        );
      }
      const stored = copy(valid);
      records.set(stored.id, stored);
      return copy(stored);
    },
    update(id, patch) {
      const current = records.get(requireId('JobStore.update', id));
      if (!current) {
        throw new InputError(`JobStore.update: unknown job '${id}'.`, {
          code: ErrorCode.OperationHandleUnknown,
          context: { function: 'JobStore.update', field: 'id', id },
        });
      }
      const next = copy(applyJobPatch('JobStore.update', current, patch));
      records.set(id, next);
      return copy(next);
    },
    get(id) {
      const record = records.get(requireId('JobStore.get', id));
      return record ? copy(record) : null;
    },
    list() {
      return [...records.values()]
        .sort((a, b) =>
          a.submittedAt < b.submittedAt
            ? -1
            : a.submittedAt > b.submittedAt
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        )
        .map(copy);
    },
  };
}
