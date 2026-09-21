/// <reference types="node" />
/**
 * The worker-terminated job runner (Stage 7A Decision 5): a `costClass: 'job'` operation runs in a
 * `worker_threads` Worker; `cancelJob` terminates it — a cancellation that actually stops work —
 * and the record moves to `cancelled` with usage. A non-job operation runs inline. Every state
 * lives in the job store, so another process can poll, cancel (by writing `cancelled`), and
 * retrieve; the runner watches the store and terminates on an external cancel.
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ErrorCode, InputError } from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import {
  runOperation,
  toOperationError,
  type ArtifactStore,
  type JobRecord,
  type JobStore,
  type OperationError,
  type OperationRegistry,
  type ResourceHandle,
} from '../index.js';
import type { JobWorkerData, JobWorkerMessage } from './job-worker.js';
import { REGISTRY_PROFILES, type RegistryProfile } from './profiles.js';

export interface SubmitJobInput {
  registry: OperationRegistry;
  jobs: JobStore;
  artifacts: ArtifactStore;
  /** The store directory a worker reopens (file stores are shared by path). */
  directory: string;
  id: string;
  input: unknown;
  /** The profile (and optional pack narrowing) the worker rebuilds the registry from. */
  profile: RegistryProfile;
  packs?: readonly string[];
  /** The caller's clock: stamps `submittedAt`, handles, and every transition. */
  clock: () => string;
  /** A job id; omitted ⇒ `job-<inputsHash prefix>-<submittedAt digits>`. */
  jobId?: string;
  seed?: number;
  maxInputBytes?: number;
  deadlineMs?: number;
  inlineResultBytes?: number;
  /** How often the runner re-reads the store for an external cancel (ms, default 250). */
  pollMs?: number;
}

export interface JobRun {
  /** The record as accepted (or, for an inline non-job operation, as completed). */
  record: JobRecord;
  /** Resolves with the terminal record — completed, failed, or cancelled. Never rejects. */
  completion: Promise<JobRecord>;
  /** Terminate the worker now; resolves with the cancelled (or already terminal) record. */
  cancel(): Promise<JobRecord>;
}

const SUBMIT_KEYS = [
  'registry',
  'jobs',
  'artifacts',
  'directory',
  'id',
  'input',
  'profile',
  'packs',
  'clock',
  'jobId',
  'seed',
  'maxInputBytes',
  'deadlineMs',
  'inlineResultBytes',
  'pollMs',
] as const;

function refuse(functionName: string, message: string, field: string, code: ErrorCode): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function requireSubmitInput(input: unknown): SubmitJobInput {
  const functionName = 'submitJob';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    refuse(functionName, 'input must be an object.', 'input', ErrorCode.InputWrongType);
  }
  for (const key of Object.keys(input)) {
    if (!(SUBMIT_KEYS as readonly string[]).includes(key)) {
      refuse(
        functionName,
        `unknown field "${key}" in input. Allowed fields: ${SUBMIT_KEYS.join(', ')}.`,
        'input',
        ErrorCode.InputUnknownField,
      );
    }
  }
  const request = input as Record<string, unknown>;
  const hasMethods = (value: unknown, names: readonly string[]): boolean =>
    value !== null &&
    typeof value === 'object' &&
    names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
  const registry = request['registry'] as { size?: unknown } | null;
  if (
    !hasMethods(request['registry'], ['list', 'get', 'require', 'describe', 'run', 'packs']) ||
    !Number.isSafeInteger(registry?.size) ||
    (registry?.size as number) < 0
  ) {
    refuse(
      functionName,
      'input.registry must be an OperationRegistry ({ list, get, require, describe, run, packs }).',
      'input.registry',
      ErrorCode.InputWrongType,
    );
  }
  if (!hasMethods(request['jobs'], ['create', 'update', 'get', 'list'])) {
    refuse(
      functionName,
      'input.jobs must be a JobStore ({ create, update, get, list }).',
      'input.jobs',
      ErrorCode.InputWrongType,
    );
  }
  if (!hasMethods(request['artifacts'], ['put', 'get', 'list'])) {
    refuse(
      functionName,
      'input.artifacts must be a writable ArtifactStore ({ put, get, list }).',
      'input.artifacts',
      ErrorCode.InputWrongType,
    );
  }
  if (request['input'] === undefined) {
    refuse(
      functionName,
      "input.input is required — the operation's input object (send {} for an operation with no fields).",
      'input.input',
      ErrorCode.InputMissingField,
    );
  }
  if (
    request['input'] === null ||
    typeof request['input'] !== 'object' ||
    Array.isArray(request['input'])
  ) {
    refuse(
      functionName,
      "input.input must be the operation's input object.",
      'input.input',
      ErrorCode.InputWrongType,
    );
  }
  if (typeof request['directory'] !== 'string' || request['directory'].length === 0) {
    refuse(
      functionName,
      'input.directory must be the store directory a worker reopens.',
      'input.directory',
      ErrorCode.InputWrongType,
    );
  }
  if (typeof request['id'] !== 'string' || request['id'].length === 0) {
    refuse(functionName, 'input.id must be an operation id.', 'input.id', ErrorCode.InputWrongType);
  }
  if (
    typeof request['profile'] !== 'string' ||
    !REGISTRY_PROFILES.includes(request['profile'] as RegistryProfile)
  ) {
    refuse(
      functionName,
      `input.profile must be one of ${REGISTRY_PROFILES.join(', ')}.`,
      'input.profile',
      typeof request['profile'] === 'string'
        ? ErrorCode.InputInvalidEnum
        : ErrorCode.InputWrongType,
    );
  }
  if (
    request['packs'] !== undefined &&
    (!Array.isArray(request['packs']) || request['packs'].some((p) => typeof p !== 'string'))
  ) {
    refuse(
      functionName,
      'input.packs must be an array of pack names when present.',
      'input.packs',
      ErrorCode.InputWrongType,
    );
  }
  if (typeof request['clock'] !== 'function') {
    refuse(
      functionName,
      'input.clock must be a function returning an ISO-8601 instant.',
      'input.clock',
      ErrorCode.InputWrongType,
    );
  }
  if (
    request['jobId'] !== undefined &&
    (typeof request['jobId'] !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(request['jobId']))
  ) {
    refuse(
      functionName,
      'input.jobId must be a string of [A-Za-z0-9:._-] when present.',
      'input.jobId',
      typeof request['jobId'] === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  for (const key of [
    'seed',
    'maxInputBytes',
    'deadlineMs',
    'inlineResultBytes',
    'pollMs',
  ] as const) {
    const value = request[key];
    if (
      value !== undefined &&
      !(typeof value === 'number' && Number.isSafeInteger(value) && (key === 'seed' || value > 0))
    ) {
      refuse(
        functionName,
        `input.${key} must be a ${key === 'seed' ? 'safe integer' : 'positive safe integer'} when present.`,
        `input.${key}`,
        typeof value === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
      );
    }
  }
  return input as SubmitJobInput;
}

/** Where the compiled worker lives: beside this module in `dist`, or `dist/` when running from source. */
function workerEntry(): URL {
  const candidates = [
    new URL('./job-worker.js', import.meta.url),
    new URL('../../dist/local/job-worker.js', import.meta.url),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new InputError(
    'submitJob: the compiled job worker (dist/job-worker.js) is missing — build @totalfinance/cli before submitting a job-class operation.',
    { code: ErrorCode.OperationInternal, context: { function: 'submitJob', field: 'worker' } },
  );
}

function internalError(
  operation: { id: string; version: string },
  message: string,
): OperationError {
  return { code: ErrorCode.OperationInternal, message, context: {}, operation } as OperationError;
}

/**
 * Submit an operation: a job-class operation runs in a terminated-on-cancel worker; any other
 * operation runs inline and its record is already terminal on return.
 */
export function submitJob(rawInput: SubmitJobInput): JobRun {
  const input = requireSubmitInput(rawInput);
  const operation = input.registry.require(input.id);
  const submittedAt = input.clock();
  const inputsHash = contentHash((input.input ?? {}) as Record<string, unknown>);
  const jobId =
    input.jobId ??
    `job-${inputsHash.replace(/^sha256:/, '').slice(0, 12)}-${submittedAt.replace(/\D/g, '')}`;
  const identity = { id: operation.id, version: operation.version };
  let record = input.jobs.create({
    id: jobId,
    operation: identity,
    state: 'accepted',
    progress: null,
    inputsHash,
    seed: input.seed ?? null,
    submittedAt,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    usage: { elapsedMs: null },
  });
  const requestId = jobId;

  if (operation.costClass !== 'job') {
    // Inline: the record is terminal on return.
    const started = Date.now();
    record = input.jobs.update(jobId, { state: 'running', startedAt: input.clock() });
    try {
      const result = runOperation({
        operation,
        input: input.input,
        artifacts: input.artifacts,
        createdTimestampMs: Date.parse(submittedAt),
        requestId,
        ...(input.seed !== undefined ? { defaultSeed: input.seed } : {}),
        ...(input.maxInputBytes !== undefined ? { maxInputBytes: input.maxInputBytes } : {}),
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        ...(input.inlineResultBytes !== undefined
          ? { inlineResultBytes: input.inlineResultBytes }
          : {}),
      });
      const handle = input.artifacts.put({
        value: result as unknown as Record<string, unknown>,
        kind: 'report',
        createdTimestampMs: Date.parse(submittedAt),
        provenance: { requestId },
      });
      record = input.jobs.update(jobId, {
        state: 'completed',
        finishedAt: input.clock(),
        result: handle,
        usage: { elapsedMs: Date.now() - started },
      });
    } catch (error) {
      record = input.jobs.update(jobId, {
        state: 'failed',
        finishedAt: input.clock(),
        error: toOperationError(error, operation),
        usage: { elapsedMs: Date.now() - started },
      });
    }
    const terminal = record;
    return {
      record: terminal,
      completion: Promise.resolve(terminal),
      cancel: () => Promise.resolve(terminal),
    };
  }

  const workerData: JobWorkerData = {
    operationId: operation.id,
    input: input.input,
    profile: input.profile,
    ...(input.packs !== undefined ? { packs: input.packs } : {}),
    directory: input.directory,
    createdTimestampMs: Date.parse(submittedAt),
    requestId,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.maxInputBytes !== undefined ? { maxInputBytes: input.maxInputBytes } : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    ...(input.inlineResultBytes !== undefined
      ? { inlineResultBytes: input.inlineResultBytes }
      : {}),
  };
  const started = Date.now();
  const worker = new Worker(workerEntry(), { workerData });
  record = input.jobs.update(jobId, { state: 'running', startedAt: input.clock() });
  let settled = false;
  let resolveCompletion: (record: JobRecord) => void = () => undefined;
  const completion = new Promise<JobRecord>((resolve) => {
    resolveCompletion = resolve;
  });
  const finish = (patch: Partial<Omit<JobRecord, 'id'>>): JobRecord => {
    if (settled) return input.jobs.get(jobId) ?? record;
    settled = true;
    clearInterval(poll);
    const current = input.jobs.get(jobId);
    // An external cancel already moved the record; only the usage is ours to add.
    const next =
      current !== null && current.state === 'cancelled'
        ? current
        : input.jobs.update(jobId, {
            finishedAt: input.clock(),
            usage: { elapsedMs: Date.now() - started },
            ...patch,
          });
    resolveCompletion(next);
    return next;
  };
  const terminate = async (): Promise<JobRecord> => {
    await worker.terminate();
    return finish({ state: 'cancelled' });
  };
  // Another process cancels by writing `cancelled` to the shared store; this runner honours it.
  const poll = setInterval(() => {
    const current = input.jobs.get(jobId);
    if (current !== null && current.state === 'cancelled' && !settled) void terminate();
  }, input.pollMs ?? 250);
  worker.once('message', (message: JobWorkerMessage) => {
    if (message.ok)
      finish({ state: 'completed', result: message.handle as unknown as ResourceHandle });
    else finish({ state: 'failed', error: message.error as unknown as OperationError });
  });
  worker.once('error', (error: Error) => {
    finish({ state: 'failed', error: internalError(identity, `worker error: ${error.message}`) });
  });
  worker.once('exit', (code) => {
    if (!settled) {
      finish(
        code === 0
          ? {
              state: 'failed',
              error: internalError(identity, 'the worker exited without posting a result'),
            }
          : { state: 'cancelled' },
      );
    }
  });
  return {
    record,
    completion,
    cancel: async () => {
      if (settled) return input.jobs.get(jobId) ?? record;
      input.jobs.update(jobId, { state: 'cancelled' });
      return terminate();
    },
  };
}

/** Cancel a job from ANY process: the record moves to `cancelled`; the running process's runner terminates its worker on the next poll. */
export function cancelJob(input: { jobs: JobStore; id: string; clock: () => string }): JobRecord {
  const functionName = 'cancelJob';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    refuse(
      functionName,
      'input must be an object ({ jobs, id, clock }).',
      'input',
      ErrorCode.InputWrongType,
    );
  }
  for (const key of Object.keys(input)) {
    if (!['jobs', 'id', 'clock'].includes(key)) {
      refuse(
        functionName,
        `unknown field "${key}" in input. Allowed fields: jobs, id, clock.`,
        'input',
        ErrorCode.InputUnknownField,
      );
    }
  }
  const jobs = input.jobs as { get?: unknown; update?: unknown } | null;
  if (
    jobs === null ||
    typeof jobs !== 'object' ||
    typeof jobs.get !== 'function' ||
    typeof jobs.update !== 'function'
  ) {
    refuse(functionName, 'input.jobs must be a JobStore.', 'input.jobs', ErrorCode.InputWrongType);
  }
  if (typeof input.id !== 'string' || input.id.length === 0) {
    refuse(functionName, 'input.id must be a job id.', 'input.id', ErrorCode.InputWrongType);
  }
  if (typeof input.clock !== 'function') {
    refuse(
      functionName,
      'input.clock must be a function returning an ISO-8601 instant.',
      'input.clock',
      ErrorCode.InputWrongType,
    );
  }
  const current = input.jobs.get(input.id);
  if (current === null) {
    throw new InputError(`${functionName}: unknown job '${input.id}'.`, {
      code: ErrorCode.OperationHandleUnknown,
      context: { function: functionName, field: 'input.id', id: input.id },
    });
  }
  if (current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled')
    return current;
  return input.jobs.update(input.id, { state: 'cancelled', finishedAt: input.clock() });
}
