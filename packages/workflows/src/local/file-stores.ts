/// <reference types="node" />
/**
 * File-backed stores (Stage 7A Decision 5): one JSON file per content hash under a directory, an
 * index file, idempotent re-puts; the job store is one JSON file per record. Two processes over the
 * same directory see the same data — that is what lets another process poll, cancel, and retrieve.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ErrorCode, InputError } from '@totalfinance/core';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import type { AuthorizationGrant, ExecutionJournalEvent } from '@totalfinance/portfolio/trade';
import {
  copyJournalEvents,
  prepareJournalCommit,
  requireAuthorizationPut,
  requireJournalAppend,
  requireJournalId,
  requireJournalTransaction,
  requireJournalTransactionOutput,
  type AuthorizationStore,
  type ExecutionJournalStore,
  authorizationUriOf,
  reconcileGrantConsumption,
  requireGrantConsume,
  type GrantConsumption,
} from '../stores-trade.js';
import {
  applyJobPatch,
  requireArtifactListFilter,
  requireArtifactPut,
  requireJobRecord,
  type ArtifactStore,
  type JobRecord,
  type JobStore,
  type ResourceHandle,
} from '../index.js';
import { ensureDirectory, trackFileLockRoot, withFileLock, writeAtomic } from './file-lock.js';

const DIRECTORY_KEYS = ['directory'] as const;

function requireDirectoryInput(functionName: string, input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError(`${functionName}: input must be an object ({ directory }).`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input' },
    });
  }
  for (const key of Object.keys(input)) {
    if (!(DIRECTORY_KEYS as readonly string[]).includes(key)) {
      throw new InputError(
        `${functionName}: unknown field "${key}" in input. Allowed fields: directory.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: 'input', key },
        },
      );
    }
  }
  const directory = (input as Record<string, unknown>)['directory'];
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new InputError(`${functionName}: input.directory must be a non-empty path.`, {
      code: directory === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input.directory' },
    });
  }
  // Store-scoped and explicit: an absolute path, resolved by the caller (the CLI resolves `--store`
  // against its working directory) — a library that resolves relative paths itself writes wherever
  // it happens to be run from.
  if (!isAbsolute(directory)) {
    throw new InputError(
      `${functionName}: input.directory must be an absolute path (resolve it at the call site, e.g. path.resolve('${directory}')).`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, field: 'input.directory', directory },
      },
    );
  }
  const resolved = resolve(directory);
  trackFileLockRoot(join(resolved, '.locks'));
  return resolved;
}

const hashOf = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex');

function fileNameOf(uri: string): string {
  return `${uri.replace(/^totalfinance:\/\//, '').replace(/[/:]/g, '_')}.json`;
}

/**
 * A file-backed artifact store: `<directory>/artifacts/<namespace>_<hash>.json` per value, plus
 * `<directory>/artifacts/index.json` listing every handle. Idempotent by content.
 */
export function createFileArtifactStore(input: { directory: string }): ArtifactStore {
  const root = join(requireDirectoryInput('createFileArtifactStore', input), 'artifacts');
  const indexPath = join(root, 'index.json');
  const lockPath = join(root, '..', '.locks', 'artifact-index');
  ensureDirectory(root);
  const readIndex = (): Record<string, ResourceHandle> =>
    existsSync(indexPath)
      ? (fromCanonicalJson(readFileSync(indexPath, 'utf8')) as Record<string, ResourceHandle>)
      : {};
  return {
    put(request) {
      const { handle, canonical } = requireArtifactPut('ArtifactStore.put', request);
      return withFileLock(lockPath, () => {
        const index = readIndex();
        const existing = index[handle.uri];
        if (existing !== undefined) return existing; // idempotent: the first mint stands
        // The durable value precedes its index entry. A crash may leave an unindexed value,
        // never an acknowledged handle without its value; retry safely completes the put.
        writeAtomic(join(root, fileNameOf(handle.uri)), canonical);
        index[handle.uri] = handle;
        writeAtomic(indexPath, canonicalJsonOf(index));
        return handle;
      });
    },
    get(uri) {
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new InputError('ArtifactStore.get: uri must be a non-empty string.', {
          code: ErrorCode.InputWrongType,
          context: { function: 'ArtifactStore.get', field: 'uri' },
        });
      }
      const handle = readIndex()[uri];
      if (handle === undefined) return null;
      const path = join(root, fileNameOf(uri));
      if (!existsSync(path)) return null;
      return {
        handle,
        value: fromCanonicalJson(readFileSync(path, 'utf8')) as Record<string, unknown>,
      };
    },
    list(filter) {
      const { kind } = requireArtifactListFilter('ArtifactStore.list', filter);
      return Object.values(readIndex())
        .filter((handle) => kind === undefined || handle.kind === kind)
        .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    },
  };
}

/** A file-backed job store: `<directory>/jobs/<id>.json` per record, re-read on every call. */
export function createFileJobStore(input: { directory: string }): JobStore {
  const root = join(requireDirectoryInput('createFileJobStore', input), 'jobs');
  ensureDirectory(root);
  const pathOf = (id: string): string => join(root, `${id}.json`);
  const lockOf = (id: string): string => join(root, '..', '.locks', 'jobs', hashOf(id));
  const requireId = (functionName: string, id: unknown): string => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(id)) {
      throw new InputError(`${functionName}: id must be a non-empty string of [A-Za-z0-9:._-].`, {
        code: typeof id === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
        context: { function: functionName, field: 'id' },
      });
    }
    return id;
  };
  const read = (id: string): JobRecord | null =>
    existsSync(pathOf(id))
      ? (fromCanonicalJson(readFileSync(pathOf(id), 'utf8')) as JobRecord)
      : null;
  return {
    create(record) {
      const valid = requireJobRecord('JobStore.create', 'record', record);
      return withFileLock(lockOf(valid.id), () => {
        if (existsSync(pathOf(valid.id))) {
          throw new InputError(
            `JobStore.create: a job with id '${valid.id}' already exists — ids are minted once.`,
            {
              code: ErrorCode.InputWrongShape,
              context: { function: 'JobStore.create', field: 'record.id' },
            },
          );
        }
        writeAtomic(pathOf(valid.id), canonicalJsonOf(valid));
        return read(valid.id)!;
      });
    },
    update(id, patch) {
      const validId = requireId('JobStore.update', id);
      return withFileLock(lockOf(validId), () => {
        const current = read(validId);
        if (current === null) {
          throw new InputError(`JobStore.update: unknown job '${id}'.`, {
            code: ErrorCode.OperationHandleUnknown,
            context: { function: 'JobStore.update', field: 'id', id },
          });
        }
        const next = applyJobPatch('JobStore.update', current, patch);
        writeAtomic(pathOf(id), canonicalJsonOf(next));
        return read(id)!;
      });
    },
    get(id) {
      return read(requireId('JobStore.get', id));
    },
    list() {
      return readdirSync(root)
        .filter((name) => name.endsWith('.json'))
        .map((name) => fromCanonicalJson(readFileSync(join(root, name), 'utf8')) as JobRecord)
        .sort((a, b) =>
          a.submittedAt < b.submittedAt
            ? -1
            : a.submittedAt > b.submittedAt
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        );
    },
  };
}

/** The authorization store on disk: `<directory>/authorizations/<hash>.json` plus an index of handles. */
export function createFileAuthorizationStore(input: { directory: string }): AuthorizationStore {
  const root = join(requireDirectoryInput('createFileAuthorizationStore', input), 'authorizations');
  const indexPath = join(root, 'index.json');
  const consumptionsPath = join(root, 'consumptions.json');
  const lockPath = join(root, '..', '.locks', 'authorization-index');
  ensureDirectory(root);
  const readIndex = (): Record<string, ResourceHandle> =>
    existsSync(indexPath)
      ? (fromCanonicalJson(readFileSync(indexPath, 'utf8')) as Record<string, ResourceHandle>)
      : {};
  const readConsumptions = (): Record<string, GrantConsumption> => {
    if (!existsSync(consumptionsPath)) return {};
    const stored = fromCanonicalJson(readFileSync(consumptionsPath, 'utf8')) as Record<
      string,
      GrantConsumption
    >;
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored))
      throw new InputError(
        'AuthorizationStore: stored consumptions must be a record; recover original authorization facts before writing.',
        { code: ErrorCode.InputWrongShape },
      );
    return Object.fromEntries(
      Object.entries(stored).map(([uri, record]) => [
        uri,
        requireGrantConsume('AuthorizationStore.readConsumption', { ...record, hashOrUri: uri })
          .consumption,
      ]),
    );
  };
  return {
    put(request) {
      const { handle, canonical } = requireAuthorizationPut('AuthorizationStore.put', request);
      return withFileLock(lockPath, () => {
        const index = readIndex();
        const existing = index[handle.uri];
        if (existing !== undefined) return existing; // idempotent: the first mint stands
        writeAtomic(join(root, fileNameOf(handle.uri)), canonical);
        index[handle.uri] = handle;
        writeAtomic(indexPath, canonicalJsonOf(index));
        return handle;
      });
    },
    get(hashOrUri) {
      const uri = authorizationUriOf('AuthorizationStore.get', hashOrUri);
      const handle = readIndex()[uri];
      if (handle === undefined) return null;
      const path = join(root, fileNameOf(uri));
      if (!existsSync(path)) return null;
      return {
        handle,
        grant: fromCanonicalJson(readFileSync(path, 'utf8')) as unknown as AuthorizationGrant,
        consumed: readConsumptions()[uri] ?? null,
      };
    },
    consume(request) {
      const FN = 'AuthorizationStore.consume';
      const { uri, consumption } = requireGrantConsume(FN, request);
      return withFileLock(lockPath, () => {
        if (readIndex()[uri] === undefined) {
          throw new InputError(`${FN}: ${uri} is not a stored grant.`, {
            code: ErrorCode.OperationHandleUnknown,
            context: { function: FN, field: 'input.hashOrUri' },
          });
        }
        const consumptions = readConsumptions();
        const record = reconcileGrantConsumption(FN, uri, consumptions[uri], consumption);
        if (consumptions[uri] === undefined) {
          consumptions[uri] = record;
          writeAtomic(consumptionsPath, canonicalJsonOf(consumptions));
        }
        return { ...record };
      });
    },
    list() {
      return Object.values(readIndex()).sort((a, b) =>
        a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0,
      );
    },
  };
}

/**
 * Journals use `journals/v2/<sha256-of-exact-id>.json` with an identity-checked envelope.
 * Legacy sanitized arrays are read only if ALL embedded IDs match. A successful transaction
 * migrates that snapshot; the legacy file is retained, never overwritten through a colliding ID.
 * Only a fully valid foreign collision is absent; malformed/ambiguous files fail closed.
 * Stop old-version writers before migration: they do not participate in the transaction protocol.
 */
export function createFileExecutionJournalStore(input: {
  directory: string;
}): ExecutionJournalStore {
  const root = join(requireDirectoryInput('createFileExecutionJournalStore', input), 'journals');
  const currentRoot = join(root, 'v2');
  ensureDirectory(currentRoot);
  // A stable identity distinguishes a restart from an empty replacement store. Kept outside
  // journal JSON namespaces so it cannot be mistaken for a legacy journal.
  const identityPath = join(root, 'store-id');
  const storeId = withFileLock(join(root, '..', '.locks', 'journal-store-identity'), () => {
    if (!existsSync(identityPath)) writeAtomic(identityPath, randomUUID());
    const identity = readFileSync(identityPath, 'utf8');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity))
      throw new InputError(
        'ExecutionJournalStore: stored identity is invalid; restore the original store identity before continuing.',
        {
          code: ErrorCode.InputWrongShape,
          context: { function: 'createFileExecutionJournalStore', field: 'storeId' },
        },
      );
    return identity;
  });
  const pathOf = (journalId: string): string => join(currentRoot, `${hashOf(journalId)}.json`);
  const legacyPathOf = (journalId: string): string =>
    join(root, `${journalId.replace(/[/:]/g, '_')}.json`);
  const lockOf = (journalId: string): string =>
    join(root, '..', '.locks', 'journals', hashOf(journalId));
  const validate = (journalId: string, events: unknown): ExecutionJournalEvent[] => {
    const checked = prepareJournalCommit(journalId, [], events);
    if (checked.skipped > 0) {
      throw new InputError(
        'ExecutionJournalStore.read: stored journal contains duplicate event IDs.',
        {
          code: ErrorCode.InputWrongShape,
          context: { function: 'ExecutionJournalStore.read', field: 'events' },
        },
      );
    }
    return checked.events;
  };
  const readLegacy = (
    path: string,
  ): { journalId: string | null; events: ExecutionJournalEvent[] } => {
    const stored = fromCanonicalJson(readFileSync(path, 'utf8'));
    if (!Array.isArray(stored)) {
      throw new InputError(
        'ExecutionJournalStore.read: legacy journal must be an array of events; repair it explicitly before writing.',
        {
          code: ErrorCode.InputWrongType,
          context: { function: 'ExecutionJournalStore.read', field: 'events', path },
        },
      );
    }
    if (stored.length === 0) return { journalId: null, events: [] };
    const first: unknown = stored[0];
    const journalId = requireJournalId(
      'ExecutionJournalStore.read',
      first !== null && typeof first === 'object'
        ? (first as { journalId?: unknown }).journalId
        : undefined,
    );
    // Validate the complete body AND uniform identity before ignoring a foreign collision.
    // Unknown/mixed IDs or invalid foreign bodies must never look like an empty journal.
    const events = validate(journalId, stored);
    if (legacyPathOf(journalId) !== path) {
      throw new InputError(
        'ExecutionJournalStore.read: legacy journal identity does not match its filename; repair it explicitly before writing.',
        {
          code: ErrorCode.InputWrongShape,
          context: { function: 'ExecutionJournalStore.read', field: 'journalId', path },
        },
      );
    }
    return { journalId, events };
  };
  const readCurrent = (
    path: string,
    expectedId?: string,
  ): { journalId: string; events: ExecutionJournalEvent[] } => {
    const envelope = fromCanonicalJson(readFileSync(path, 'utf8')) as {
      journalId: string;
      events: unknown;
    } | null;
    const journalId = requireJournalId('ExecutionJournalStore.read', envelope?.journalId);
    if ((expectedId !== undefined && journalId !== expectedId) || pathOf(journalId) !== path) {
      throw new InputError(
        'ExecutionJournalStore.read: stored journal identity does not match its filename or requested ID.',
        {
          code: ErrorCode.InputWrongShape,
          context: { function: 'ExecutionJournalStore.read', field: 'journalId' },
        },
      );
    }
    return { journalId, events: validate(journalId, envelope!.events) };
  };
  const readAll = (journalId: string): ExecutionJournalEvent[] => {
    const path = pathOf(journalId);
    if (existsSync(path)) return readCurrent(path, journalId).events;
    const legacy = legacyPathOf(journalId);
    if (!existsSync(legacy)) return [];
    const snapshot = readLegacy(legacy);
    return snapshot.journalId === journalId ? snapshot.events : [];
  };
  const store: ExecutionJournalStore = {
    get storeId() {
      return storeId;
    },
    transact(request) {
      const journalId = requireJournalTransaction(request);
      return withFileLock(lockOf(journalId), () => {
        const prior = readAll(journalId);
        const output = request.execute(copyJournalEvents(prior));
        requireJournalTransactionOutput(output);
        const { events, result } = output;
        const commit = prepareJournalCommit(journalId, prior, events);
        if (commit.appended > 0 || (prior.length > 0 && !existsSync(pathOf(journalId)))) {
          writeAtomic(pathOf(journalId), canonicalJsonOf({ journalId, events: commit.events }));
        }
        return result;
      });
    },
    append(request) {
      const { journalId, events } = requireJournalAppend('ExecutionJournalStore.append', request);
      return store.transact({
        journalId,
        execute: (prior) => {
          const { appended, skipped, total } = prepareJournalCommit(journalId, prior, events);
          return { events, result: { journalId, appended, skipped, total } };
        },
      });
    },
    read(journalId) {
      return readAll(requireJournalId('ExecutionJournalStore.read', journalId));
    },
    list() {
      const ids = new Set(
        readdirSync(currentRoot)
          .filter((name) => name.endsWith('.json'))
          .map((name) => readCurrent(join(currentRoot, name)).journalId),
      );
      for (const name of readdirSync(root).filter((name) => name.endsWith('.json'))) {
        const { journalId } = readLegacy(join(root, name));
        if (journalId !== null) ids.add(journalId);
      }
      return [...ids].sort();
    },
  };
  return store;
}
