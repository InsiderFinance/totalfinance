/**
 * The trade lifecycle's stores (Stage 7B.2, Decision 10): an authorization store keyed by the
 * grant's content hash and an append-only execution-journal store keyed by journal id. Both are
 * explicit parameters of the runtime (`stores: { authorization, journal }`), never session state;
 * the memory implementations live here, the file implementations beside the artifact store.
 */
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { EpochMs } from '@totalfinance/core';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import type { AuthorizationGrant, ExecutionJournalEvent } from '@totalfinance/portfolio/trade';
import {
  requireAuthorizationGrant,
  requireExecutionJournalEvent,
} from '@totalfinance/portfolio/trade';
import type { ResourceHandle } from './operation.js';
import { handleUriOf } from './stores.js';

/** The one submission a grant licensed, durably prepared before its journal commit. */
export interface GrantConsumption {
  /** Opaque identity of the authoritative store, retained across file-store restarts. */
  journalStoreId: string;
  journalId: string;
  receiptId: string;
  idempotencyKey: string;
  consumedTimestampMs: EpochMs;
  /** Write-ahead event batch: recovery replays these exact facts, never the fill engine. */
  journalEvents: readonly ExecutionJournalEvent[];
}

export interface AuthorizationStore {
  /** Store a grant under its content hash; idempotent (the first put stands). Returns its handle. */
  put(input: { grant: AuthorizationGrant; createdTimestampMs: EpochMs }): ResourceHandle;
  /** The grant by content hash (or handle uri) with its consumption (null while unconsumed), or null. */
  get(hashOrUri: string): {
    handle: ResourceHandle;
    grant: AuthorizationGrant;
    consumed: GrantConsumption | null;
  } | null;
  /**
   * Atomically claim the grant with its validated write-ahead batch before journal commit.
   * Idempotent only for the same store, receipt, key and batch; all other claims refuse.
   */
  consume(input: GrantConsumption & { hashOrUri: string }): GrantConsumption;
  list(): ResourceHandle[];
}

export interface ExecutionJournalStore {
  /** Stable opaque storage identity. Fresh stores differ; reopening a file store retains it. */
  readonly storeId: string;
  /**
   * Serialize restoration, idempotency checks, identity allocation and commit for one journal.
   * `execute` is synchronous and receives a detached snapshot. Its events are a newly appended
   * batch (possibly empty), committed before result is returned. Exceptions commit nothing.
   * Do not nest transactions/append on the same journal; read does not acquire another lock.
   */
  transact<T>(input: {
    journalId: string;
    execute: (prior: readonly ExecutionJournalEvent[]) => {
      events: readonly ExecutionJournalEvent[];
      result: T;
    };
  }): T;
  /** Append atomically; identical eventId/body retries are skipped, conflicting bodies refused. */
  append(input: { events: readonly ExecutionJournalEvent[] }): {
    journalId: string;
    appended: number;
    skipped: number;
    total: number;
  };
  /** Every event of a journal in append order (empty for an unknown journal). */
  read(journalId: string): ExecutionJournalEvent[];
  /** Every journal id, sorted. */
  list(): string[];
}

/** A journal read folds at most this many events; the store refuses to grow a journal beyond it. */
export const EXECUTION_JOURNAL_STORE_CEILING = 100_000;

const PUT_KEYS = ['grant', 'createdTimestampMs'] as const;
const CONSUME_KEYS = [
  'hashOrUri',
  'journalId',
  'receiptId',
  'idempotencyKey',
  'consumedTimestampMs',
  'journalStoreId',
  'journalEvents',
] as const;
const APPEND_KEYS = ['events'] as const;

function refuse(functionName: string, field: string, message: string, code: string): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

export function requireAuthorizationPut(
  functionName: string,
  input: unknown,
): { grant: AuthorizationGrant; handle: ResourceHandle; canonical: string } {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, PUT_KEYS);
  const request = input as Record<string, unknown>;
  const grant = requireAuthorizationGrant(functionName, 'input.grant', request['grant']);
  const createdTimestampMs = requireEpochField(
    functionName,
    'input.createdTimestampMs',
    request['createdTimestampMs'],
  );
  const handle: ResourceHandle = {
    uri: handleUriOf('authorization', grant.contentHash),
    kind: 'authorization',
    schema: grant.kind,
    version: String(grant.schemaVersion),
    contentHash: grant.contentHash,
    createdTimestampMs,
    expiresTimestampMs: grant.expiresAt,
    provenance: {},
  };
  return { grant, handle, canonical: canonicalJsonOf(grant as unknown as Record<string, unknown>) };
}

function requireEpochField(functionName: string, field: string, value: unknown): EpochMs {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    refuse(
      functionName,
      field,
      `${field} must be an integer epoch-millisecond instant — the caller's clock, never the library's.`,
      typeof value === 'number' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return value;
}

/** The uri a store keys by, from a content hash or a handle uri. */
export function authorizationUriOf(functionName: string, hashOrUri: unknown): string {
  if (typeof hashOrUri !== 'string' || hashOrUri.length === 0) {
    refuse(
      functionName,
      'hashOrUri',
      'hashOrUri must be a non-empty string (a grant content hash or its handle uri).',
      ErrorCode.InputWrongType,
    );
  }
  return hashOrUri.startsWith('totalfinance://')
    ? hashOrUri
    : handleUriOf('authorization', hashOrUri);
}

/** Validate a consumption request; returns the uri and the record to store (shared by every store). */
export function requireGrantConsume(
  functionName: string,
  input: unknown,
): { uri: string; consumption: GrantConsumption } {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, CONSUME_KEYS);
  const request = input as Record<string, unknown>;
  const uri = authorizationUriOf(functionName, request['hashOrUri']);
  for (const key of ['journalStoreId', 'journalId', 'receiptId', 'idempotencyKey'] as const) {
    if (typeof request[key] !== 'string' || (request[key] as string).length === 0) {
      refuse(
        functionName,
        `input.${key}`,
        `input.${key} must be a non-empty string.`,
        ErrorCode.InputWrongType,
      );
    }
  }
  const consumedTimestampMs = requireEpochField(
    functionName,
    'input.consumedTimestampMs',
    request['consumedTimestampMs'],
  );
  return {
    uri,
    consumption: {
      journalStoreId: request['journalStoreId'] as string,
      journalId: request['journalId'] as string,
      receiptId: request['receiptId'] as string,
      idempotencyKey: request['idempotencyKey'] as string,
      consumedTimestampMs,
      journalEvents: prepareJournalCommit(
        requireJournalId(functionName, request['journalId']),
        [],
        request['journalEvents'],
      ).events,
    },
  };
}

/** Idempotent for the same receipt; any other consumption of a consumed grant is refused. */
export function reconcileGrantConsumption(
  functionName: string,
  uri: string,
  existing: GrantConsumption | undefined,
  next: GrantConsumption,
): GrantConsumption {
  if (existing === undefined) return next;
  if (
    existing.journalId === next.journalId &&
    existing.journalStoreId === next.journalStoreId &&
    existing.receiptId === next.receiptId &&
    existing.idempotencyKey === next.idempotencyKey &&
    canonicalJsonOf(existing.journalEvents) === canonicalJsonOf(next.journalEvents)
  )
    return existing;
  throw new InputError(
    `${functionName}: grant ${uri} was already consumed by receipt ${existing.receiptId} (journal ${existing.journalId}, key ${JSON.stringify(existing.idempotencyKey)}) at ${existing.consumedTimestampMs}; a grant licenses one submission — authorize a new grant.`,
    {
      code: ErrorCode.TradeGrantConsumed,
      context: { function: functionName, field: 'hashOrUri', uri, existing },
    },
  );
}

export function requireJournalAppend(
  functionName: string,
  input: unknown,
): { journalId: string; events: ExecutionJournalEvent[] } {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, APPEND_KEYS);
  const request = input as Record<string, unknown>;
  if (!Array.isArray(request['events']) || request['events'].length === 0) {
    refuse(
      functionName,
      'input.events',
      'input.events must be a non-empty array of journal events.',
      ErrorCode.InputWrongType,
    );
  }
  const events = (request['events'] as unknown[]).map((event, index) =>
    requireExecutionJournalEvent(functionName, `input.events[${index}]`, event),
  );
  const journalId = events[0]!.journalId;
  events.forEach((event, index) => {
    if (event.journalId !== journalId) {
      refuse(
        functionName,
        `input.events[${index}].journalId`,
        `input.events[${index}].journalId must be ${JSON.stringify(journalId)} — one append, one journal. Received ${JSON.stringify(event.journalId)}.`,
        ErrorCode.InputWrongShape,
      );
    }
  });
  return { journalId, events };
}

export function requireJournalId(functionName: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9/:._-]+$/.test(value)) {
    refuse(
      functionName,
      'journalId',
      'journalId must be a non-empty string of [A-Za-z0-9/:._-].',
      typeof value === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  return value;
}

/** Shared transaction boundary; never accept a promise as a synchronous commit. */
export function requireJournalTransaction(input: unknown): string {
  const fn = 'ExecutionJournalStore.transact';
  requireArgumentObject(fn, 'input', input);
  ensureKnownKeys(fn, 'input', input as object, ['journalId', 'execute']);
  const request = input as Record<string, unknown>;
  const id = requireJournalId(fn, request['journalId']);
  if (typeof request['execute'] !== 'function') {
    refuse(
      fn,
      'input.execute',
      'input.execute must be a synchronous function.',
      ErrorCode.InputWrongType,
    );
  }
  return id;
}

export function copyJournalEvents(
  events: readonly ExecutionJournalEvent[],
): ExecutionJournalEvent[] {
  return fromCanonicalJson(
    canonicalJsonOf(events as unknown as Record<string, unknown>[]),
  ) as ExecutionJournalEvent[];
}

/** Validate the entire batch before modifying either store, including duplicates within a batch. */
export function prepareJournalCommit(
  journalId: string,
  prior: readonly ExecutionJournalEvent[],
  batch: unknown,
): {
  events: ExecutionJournalEvent[];
  journalId: string;
  appended: number;
  skipped: number;
  total: number;
} {
  const fn = 'ExecutionJournalStore.transact';
  if (!Array.isArray(batch)) {
    refuse(
      fn,
      'events',
      'execute must return an array of events (possibly empty).',
      ErrorCode.InputWrongType,
    );
  }
  const ids = new Map(prior.map((event) => [event.eventId, canonicalJsonOf(event)]));
  const events = [...prior];
  let skipped = 0;
  for (const [index, value] of batch.entries()) {
    const event = requireExecutionJournalEvent(fn, `events[${index}]`, value);
    if (event.journalId !== journalId) {
      refuse(
        fn,
        `events[${index}].journalId`,
        `event must belong to journal ${JSON.stringify(journalId)}.`,
        ErrorCode.InputWrongShape,
      );
    }
    const canonical = canonicalJsonOf(event);
    const existing = ids.get(event.eventId);
    if (existing !== undefined) {
      if (existing !== canonical) {
        refuse(
          fn,
          `events[${index}].eventId`,
          `event ${JSON.stringify(event.eventId)} already exists with different content.`,
          ErrorCode.TradeIdempotencyConflict,
        );
      }
      skipped += 1;
      continue;
    }
    if (events.length >= EXECUTION_JOURNAL_STORE_CEILING) {
      refuse(
        fn,
        'events',
        `journal ${JSON.stringify(journalId)} grows to at most ${EXECUTION_JOURNAL_STORE_CEILING} events.`,
        ErrorCode.InputOutOfRange,
      );
    }
    events.push(fromCanonicalJson(canonical) as ExecutionJournalEvent);
    ids.set(event.eventId, canonical);
  }
  return {
    events,
    journalId,
    appended: events.length - prior.length,
    skipped,
    total: events.length,
  };
}

export function requireJournalTransactionOutput(input: unknown): void {
  const fn = 'ExecutionJournalStore.transact';
  requireArgumentObject(fn, 'output', input);
  ensureKnownKeys(fn, 'output', input as object, ['events', 'result']);
}

function cloneConsumption(record: GrantConsumption): GrantConsumption {
  return { ...record, journalEvents: copyJournalEvents(record.journalEvents) };
}

function cloneAuthorizationHandle(handle: ResourceHandle): ResourceHandle {
  return fromCanonicalJson(canonicalJsonOf(handle)) as unknown as ResourceHandle;
}

export function createMemoryAuthorizationStore(): AuthorizationStore {
  const entries = new Map<string, { handle: ResourceHandle; canonical: string }>();
  const consumptions = new Map<string, GrantConsumption>();
  return {
    put(input) {
      const { handle, canonical } = requireAuthorizationPut('AuthorizationStore.put', input);
      const existing = entries.get(handle.uri);
      if (existing) return cloneAuthorizationHandle(existing.handle);
      entries.set(handle.uri, { handle, canonical });
      return cloneAuthorizationHandle(handle);
    },
    get(hashOrUri) {
      const uri = authorizationUriOf('AuthorizationStore.get', hashOrUri);
      const entry = entries.get(uri);
      if (!entry) return null;
      return {
        handle: cloneAuthorizationHandle(entry.handle),
        grant: fromCanonicalJson(entry.canonical) as unknown as AuthorizationGrant,
        consumed: consumptions.has(uri) ? cloneConsumption(consumptions.get(uri)!) : null,
      };
    },
    consume(input) {
      const FN = 'AuthorizationStore.consume';
      const { uri, consumption } = requireGrantConsume(FN, input);
      if (!entries.has(uri))
        refuse(
          FN,
          'input.hashOrUri',
          `${uri} is not a stored grant.`,
          ErrorCode.OperationHandleUnknown,
        );
      const record = reconcileGrantConsumption(FN, uri, consumptions.get(uri), consumption);
      consumptions.set(uri, record);
      return cloneConsumption(record);
    },
    list() {
      return [...entries.values()]
        .map((entry) => cloneAuthorizationHandle(entry.handle))
        .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    },
  };
}

export function createMemoryExecutionJournalStore(): ExecutionJournalStore {
  const journals = new Map<string, ExecutionJournalEvent[]>();
  const active = new Set<string>();
  const identity = globalThis.crypto.randomUUID();
  const store: ExecutionJournalStore = {
    get storeId() {
      return identity;
    },
    transact(input) {
      const journalId = requireJournalTransaction(input);
      if (active.has(journalId)) {
        refuse(
          'ExecutionJournalStore.transact',
          'journalId',
          'a transaction on this journal is already executing; nested writes are not allowed.',
          ErrorCode.InputWrongShape,
        );
      }
      active.add(journalId);
      try {
        const prior = journals.get(journalId) ?? [];
        const output = input.execute(copyJournalEvents(prior));
        requireJournalTransactionOutput(output);
        const { events, result } = output;
        const commit = prepareJournalCommit(journalId, prior, events);
        if (commit.appended > 0) journals.set(journalId, commit.events);
        return result;
      } finally {
        active.delete(journalId);
      }
    },
    append(input) {
      const { journalId, events } = requireJournalAppend('ExecutionJournalStore.append', input);
      return store.transact({
        journalId,
        execute: (prior) => {
          const { appended, skipped, total } = prepareJournalCommit(journalId, prior, events);
          return { events, result: { journalId, appended, skipped, total } };
        },
      });
    },
    read(journalId) {
      const id = requireJournalId('ExecutionJournalStore.read', journalId);
      const journal = journals.get(id);
      return copyJournalEvents(journal ?? []);
    },
    list() {
      return [...journals.keys()].sort();
    },
  };
  return store;
}
