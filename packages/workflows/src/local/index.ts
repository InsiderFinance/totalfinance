/**
 * `@totalfinance/workflows/local` — the node-only local runtime the transports compose (Stage 7A
 * Decisions 5–7): file-backed artifact and job stores, registry profiles, and the worker-terminated
 * job runner. The package root stays browser-safe; this subpath needs `node:fs` and
 * `node:worker_threads`. `@totalfinance/cli` and `@totalfinance/http` both build on it, so neither L6
 * transport depends on the other.
 */

export {
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createFileJobStore,
} from './file-stores.js';
export { REGISTRY_PROFILES, packsForProfile, registryForProfile } from './profiles.js';
export type { RegistryProfile } from './profiles.js';
export { cancelJob, submitJob } from './jobs.js';
export type { JobRun, SubmitJobInput } from './jobs.js';
export { createLocalJobRunner } from './local-runner.js';
export type { JobRunner, JobSubmission, LocalJobRunnerInput } from './local-runner.js';
