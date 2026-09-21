/// <reference types="node" />
/**
 * The job worker (Stage 7A Decision 5): rebuilds the submitter's registry by profile, runs ONE
 * operation through `runOperation` against the shared file artifact store, stores the whole
 * OperationResult as a report, and posts its handle back. Terminating this thread is the
 * cancellation — nothing here catches it.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runOperation, toOperationError } from '../index.js';
import { createFileArtifactStore } from './file-stores.js';
import { registryForProfile, type RegistryProfile } from './profiles.js';
import { ErrorCode } from '@totalfinance/core';

export interface JobWorkerData {
  operationId: string;
  input: unknown;
  profile: RegistryProfile;
  packs?: readonly string[];
  directory: string;
  createdTimestampMs: number;
  requestId: string;
  seed?: number;
  maxInputBytes?: number;
  deadlineMs?: number;
  inlineResultBytes?: number;
}

export type JobWorkerMessage =
  | { ok: true; handle: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

const data = workerData as JobWorkerData;
const registry = registryForProfile({
  profile: data.profile,
  ...(data.packs ? { packs: data.packs } : {}),
});
const artifacts = createFileArtifactStore({ directory: data.directory });
let message: JobWorkerMessage;
try {
  const operation = registry.require(data.operationId);
  const result = runOperation({
    operation,
    input: data.input,
    artifacts,
    createdTimestampMs: data.createdTimestampMs,
    requestId: data.requestId,
    ...(data.seed !== undefined ? { defaultSeed: data.seed } : {}),
    ...(data.maxInputBytes !== undefined ? { maxInputBytes: data.maxInputBytes } : {}),
    ...(data.deadlineMs !== undefined ? { deadlineMs: data.deadlineMs } : {}),
    ...(data.inlineResultBytes !== undefined ? { inlineResultBytes: data.inlineResultBytes } : {}),
  });
  const handle = artifacts.put({
    value: result as unknown as Record<string, unknown>,
    kind: 'report',
    createdTimestampMs: data.createdTimestampMs,
    provenance: { requestId: data.requestId },
  });
  message = { ok: true, handle: handle as unknown as Record<string, unknown> };
} catch (error) {
  const operation = registry.get(data.operationId);
  message = {
    ok: false,
    error: (operation
      ? toOperationError(error, operation)
      : {
          code: ErrorCode.OperationUnknown,
          message: error instanceof Error ? error.message : String(error),
          context: {},
          operation: { id: data.operationId, version: '0' },
        }) as unknown as Record<string, unknown>,
  };
}
parentPort?.postMessage(message);
