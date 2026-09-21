/// <reference types="node" />
/**
 * The job-runner contract a transport composes (Stage 7A Decision 5/7): `submit` starts a job
 * (a job-class operation in a worker, anything else inline), `cancel` stops one from any process
 * through the shared store, `get` reads a record. `createLocalJobRunner` binds the file-backed
 * runner in this package to one registry, one store directory, and one clock.
 */

import { isAbsolute } from 'node:path';
import { ErrorCode, InputError } from '@totalfinance/core';
import type { JobRecord } from '../stores.js';
import type { OperationRegistry } from '../registry.js';
import { createFileArtifactStore, createFileJobStore } from './file-stores.js';
import { cancelJob, submitJob, type JobRun } from './jobs.js';
import { REGISTRY_PROFILES, type RegistryProfile } from './profiles.js';

export interface JobSubmission {
  /** The operation id. */
  id: string;
  input: unknown;
  seed?: number;
  requestId?: string;
  maxInputBytes?: number;
  deadlineMs?: number;
  inlineResultBytes?: number;
}

/** What a transport needs from a job runner — structural, so a host can supply its own. */
export interface JobRunner {
  submit(submission: JobSubmission): JobRun;
  cancel(id: string): JobRecord;
  get(id: string): JobRecord | null;
  list(): JobRecord[];
}

export interface LocalJobRunnerInput {
  registry: OperationRegistry;
  /** The store directory (absolute) jobs, artifacts, and workers share. */
  directory: string;
  /** The profile the worker rebuilds the registry from — it must produce the same set as `registry`. */
  profile: RegistryProfile;
  packs?: readonly string[];
  clock: () => string;
  pollMs?: number;
}

/** A runner over the file stores in `directory`, for the `totalfinance-http` binary and any host that wants the same. */
const RUNNER_KEYS = ['registry', 'directory', 'profile', 'packs', 'clock', 'pollMs'] as const;

function refuse(message: string, field: string, code: ErrorCode = ErrorCode.InputWrongType): never {
  throw new InputError(`createLocalJobRunner: ${message}`, {
    code,
    context: { function: 'createLocalJobRunner', field },
  });
}

function requireRunnerInput(input: unknown): LocalJobRunnerInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    refuse(
      'input must be an object ({ registry, directory, profile, packs?, clock, pollMs? }).',
      'input',
    );
  }
  for (const key of Object.keys(input)) {
    if (!(RUNNER_KEYS as readonly string[]).includes(key)) {
      refuse(
        `unknown field "${key}" in input. Allowed fields: ${RUNNER_KEYS.join(', ')}.`,
        'input',
        ErrorCode.InputUnknownField,
      );
    }
  }
  const request = input as Record<string, unknown>;
  const registry = request['registry'] as Record<string, unknown> | null;
  if (
    registry === null ||
    typeof registry !== 'object' ||
    ['list', 'get', 'require', 'describe', 'run', 'packs'].some(
      (member) => typeof registry[member] !== 'function',
    ) ||
    !Number.isSafeInteger(registry['size']) ||
    (registry['size'] as number) < 0
  ) {
    refuse(
      'input.registry must be an OperationRegistry ({ list, get, require, describe, run, packs, size }).',
      'input.registry',
    );
  }
  if (typeof request['directory'] !== 'string' || !isAbsolute(request['directory'])) {
    refuse(
      'input.directory must be an absolute path (the store directory jobs, artifacts, and workers share).',
      'input.directory',
      typeof request['directory'] === 'string'
        ? ErrorCode.InputWrongShape
        : ErrorCode.InputWrongType,
    );
  }
  if (
    typeof request['profile'] !== 'string' ||
    !REGISTRY_PROFILES.includes(request['profile'] as RegistryProfile)
  ) {
    refuse(
      `input.profile must be one of ${REGISTRY_PROFILES.join(', ')}.`,
      'input.profile',
      typeof request['profile'] === 'string'
        ? ErrorCode.InputInvalidEnum
        : ErrorCode.InputWrongType,
    );
  }
  if (
    request['packs'] !== undefined &&
    (!Array.isArray(request['packs']) || request['packs'].some((name) => typeof name !== 'string'))
  ) {
    refuse('input.packs must be an array of pack names when present.', 'input.packs');
  }
  if (typeof request['clock'] !== 'function') {
    refuse('input.clock must be a function returning an ISO-8601 instant.', 'input.clock');
  }
  if (
    request['pollMs'] !== undefined &&
    !(Number.isSafeInteger(request['pollMs']) && (request['pollMs'] as number) > 0)
  ) {
    refuse(
      'input.pollMs must be a positive safe integer when present.',
      'input.pollMs',
      typeof request['pollMs'] === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
    );
  }
  return input as LocalJobRunnerInput;
}

export function createLocalJobRunner(rawInput: LocalJobRunnerInput): JobRunner {
  const input = requireRunnerInput(rawInput);
  const jobs = createFileJobStore({ directory: input.directory });
  const artifacts = createFileArtifactStore({ directory: input.directory });
  return {
    submit(submission) {
      return submitJob({
        registry: input.registry,
        jobs,
        artifacts,
        directory: input.directory,
        id: submission.id,
        input: submission.input,
        profile: input.profile,
        ...(input.packs !== undefined ? { packs: input.packs } : {}),
        clock: input.clock,
        ...(submission.requestId !== undefined ? { jobId: submission.requestId } : {}),
        ...(submission.seed !== undefined ? { seed: submission.seed } : {}),
        ...(submission.maxInputBytes !== undefined
          ? { maxInputBytes: submission.maxInputBytes }
          : {}),
        ...(submission.deadlineMs !== undefined ? { deadlineMs: submission.deadlineMs } : {}),
        ...(submission.inlineResultBytes !== undefined
          ? { inlineResultBytes: submission.inlineResultBytes }
          : {}),
        ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
      });
    },
    cancel(id) {
      return cancelJob({ jobs, id, clock: input.clock });
    },
    get(id) {
      return jobs.get(id);
    },
    list() {
      return jobs.list();
    },
  };
}
