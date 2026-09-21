/**
 * `@totalfinance/cli` — the `totalfinance` command line (Stage 7A). The local runtime it drives — the file
 * stores, the registry profiles, the worker-terminated job runner — lives in
 * `@totalfinance/workflows/local` (so `@totalfinance/http` composes the same runtime without an L6 cross-edge)
 * and is re-exported here for the callers Decision 5 named. The CLI owns no schema and no compute.
 */

export { CLI_EXIT_CODES } from './exit-codes.js';
export type { CliExitCode } from './exit-codes.js';
export { CLI_COMMANDS } from './commands.js';
export type { CliCommand } from './commands.js';
export {
  REGISTRY_PROFILES,
  cancelJob,
  createFileArtifactStore,
  createFileJobStore,
  createLocalJobRunner,
  packsForProfile,
  registryForProfile,
  submitJob,
} from '@totalfinance/workflows/local';
export type {
  JobRun,
  JobRunner,
  JobSubmission,
  LocalJobRunnerInput,
  RegistryProfile,
  SubmitJobInput,
} from '@totalfinance/workflows/local';
