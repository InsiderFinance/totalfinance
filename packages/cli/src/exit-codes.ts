/**
 * The `totalfinance` exit codes — a contract (Stage 7A Decision 6), published so a caller's script and
 * the CLI guide's table are checked against the same values.
 */

export const CLI_EXIT_CODES = Object.freeze({
  /** The command succeeded; stdout carries one JSON document. */
  success: 0,
  /** Usage: an unknown command or flag, a missing argument, a malformed `--input`, an environment below the floor. */
  usage: 2,
  /** The input was refused — an `OperationError` with an `input.*` code. */
  inputRefused: 3,
  /** The operation failed — any other `OperationError`. */
  operationFailed: 4,
  /** The job was cancelled before it produced a result. */
  jobCancelled: 5,
  /** An internal error (a bug, a missing worker build) — never an input problem. */
  internal: 70,
} as const);

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];
