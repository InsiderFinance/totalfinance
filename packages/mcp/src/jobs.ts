/** MCP lifecycle adapter over the explicit local JobRunner; no execution or storage engine here. */
import { randomUUID } from 'node:crypto';
import { ensureKnownKeys, ErrorCode, InputError, requireArgumentObject } from '@totalfinance/core';
import { schema } from '@totalfinance/core/schema';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  ArtifactStoreReader,
  JobRecord,
  OperationResult,
  TotalFinanceOperation,
} from '@totalfinance/workflows';
import type { JobRunner } from '@totalfinance/workflows/local';

const jobIdSchema = schema.object({
  jobId: schema
    .string()
    .regex(/^[A-Za-z0-9:._-]{1,200}$/)
    .describe('The exact job id returned by totalfinance_job_submit (not a report URI).'),
});

export const JOB_TOOL_NAMES = [
  'totalfinance_job_submit',
  'totalfinance_job_status',
  'totalfinance_job_result',
  'totalfinance_job_cancel',
] as const;

export function workerEligible(operation: TotalFinanceOperation): boolean {
  // JobSubmission has no grants/stores fields. Never send a privileged operation to a runner
  // that cannot represent that authorization context, even when the host runner is broader.
  return (
    operation.costClass === 'job' &&
    operation.sideEffect === 'none' &&
    operation.authorization === 'none' &&
    operation.requiredCapabilities.length === 0
  );
}

export function jobView(job: JobRecord) {
  return {
    job,
    progress: job.progress ?? { stage: job.state, fraction: job.state === 'completed' ? 1 : null },
    progressNote:
      'Lifecycle progress only unless the runner supplies finer stages; null is not a measured fraction.',
    statusUri: `totalfinance://jobs/${job.id}`,
    resultUri: `totalfinance://jobs/${job.id}/result`,
    next: 'Poll totalfinance_job_status; fetch totalfinance_job_result when completed; totalfinance_job_cancel stops unfinished work.',
  };
}

export function jobTools(operations: readonly TotalFinanceOperation[]): Tool[] {
  const eligible = operations.filter(workerEligible);
  return JOB_TOOL_NAMES.map(
    (name): Tool => ({
      name,
      title: `Job ${name.split('.').at(-1)}`,
      description:
        name === 'totalfinance_job_submit'
          ? 'Submit a listed worker-backed operation without waiting. The discriminated input is the operation’s own schema. Returns a job id, lifecycle progress, and status/result resource URIs; no arbitrary execution or capability overrides.'
          : name === 'totalfinance_job_status'
            ? 'Read a job record and honest lifecycle/stage progress. Only jobs for this server’s enabled worker operations are accessible.'
            : name === 'totalfinance_job_result'
              ? 'Fetch the completed job’s unchanged OperationResult (structured, assumptions, diagnostics, identity, artifacts). Unfinished/cancelled/failed jobs return an OperationError.'
              : 'Cancel an unfinished local job; the shared runner terminates the worker. Terminal cancellation is idempotent. Grants cannot be supplied or enlarged.',
      inputSchema:
        name === 'totalfinance_job_submit'
          ? {
              type: 'object',
              // No permissive { id: string, input: any }: enumerate EXACTLY the effective job set.
              ...(eligible.length === 0
                ? { not: {} }
                : {
                    oneOf: eligible.map((operation) => ({
                      type: 'object',
                      additionalProperties: false,
                      required: ['id', 'input'],
                      properties: {
                        id: { type: 'string', const: operation.id },
                        input: operation.inputSchema.toJSONSchema(),
                      },
                    })),
                  }),
            }
          : (jobIdSchema.toJSONSchema() as Tool['inputSchema']),
      annotations: {
        readOnlyHint: name === 'totalfinance_job_status' || name === 'totalfinance_job_result',
        destructiveHint: name === 'totalfinance_job_cancel',
        idempotentHint: name !== 'totalfinance_job_submit',
        openWorldHint: false,
      },
      _meta: {
        'totalfinance/execution': 'local-job-control',
        'totalfinance/experimentalTasksRequired': false,
      },
    }),
  );
}

export function attachJobs(input: {
  runner: JobRunner;
  artifacts: ArtifactStoreReader;
  operations: readonly TotalFinanceOperation[];
  maxInputBytes: number;
  defaultSeed: number;
  deadlineMs?: number;
}) {
  const byId = new Map(
    input.operations.filter(workerEligible).map((operation) => [operation.id, operation]),
  );
  const allows = (job: JobRecord) => byId.get(job.operation.id)?.version === job.operation.version;
  const unknown = (jobId: string) =>
    new InputError(
      `totalfinance_job_status: Unknown or unavailable job '${jobId}' for this server's effective operation set.`,
      {
        code: ErrorCode.OperationHandleUnknown,
        context: { jobId },
      },
    );
  const get = (jobId: string): JobRecord => {
    if (!/^[A-Za-z0-9:._-]{1,200}$/.test(jobId)) throw unknown(jobId);
    const job = input.runner.get(jobId);
    if (job === null || !allows(job)) throw unknown(jobId);
    return job;
  };
  const result = (job: JobRecord): OperationResult => {
    if (!allows(job)) throw unknown(job.id);
    if (job.state !== 'completed' || job.result === null)
      throw new InputError(
        `totalfinance_job_result: Job '${job.id}' is ${job.state}; poll totalfinance_job_status and fetch only when completed.`,
        {
          code:
            job.state === 'cancelled'
              ? ErrorCode.OperationCancelled
              : job.state === 'completed'
                ? ErrorCode.OperationHandleUnknown
                : ErrorCode.InputWrongShape,
          context: { jobId: job.id, state: job.state },
        },
      );
    const stored = input.artifacts.get(job.result.uri);
    if (stored === null)
      throw new InputError(
        `totalfinance_job_result: Job result '${job.result.uri}' is unavailable; attach the runner's artifact store.`,
        {
          code: ErrorCode.OperationHandleUnknown,
          context: { uri: job.result.uri },
        },
      );
    const value = stored.value as unknown as OperationResult;
    if (
      value.operation?.id !== job.operation.id ||
      value.operation?.version !== job.operation.version ||
      value.structured === null ||
      typeof value.structured !== 'object'
    ) {
      throw new InputError(
        'totalfinance_job_result: Job result does not match the requested operation identity.',
        {
          code: ErrorCode.OperationHandleKindMismatch,
          context: { jobId: job.id },
        },
      );
    }
    return value;
  };
  return {
    allows,
    get,
    result,
    list: () => input.runner.list().filter(allows),
    parseJobId(args: unknown): string {
      const parsed = jobIdSchema.safeParse(args, { mode: 'strict' });
      if (!parsed.success) throw parsed.error;
      return parsed.data.jobId;
    },
    submit(args: unknown, envelopeBudget = true) {
      requireArgumentObject('totalfinance_job_submit', 'arguments', args);
      ensureKnownKeys('totalfinance_job_submit', 'arguments', args as object, ['id', 'input']);
      const request = args as { id?: unknown; input?: unknown };
      const operation = typeof request.id === 'string' ? byId.get(request.id) : undefined;
      if (!operation)
        throw new InputError(
          'totalfinance_job_submit: Unavailable job operation. List tools for the exact typed totalfinance_job_submit alternatives; only unprivileged worker-backed operations are supported.',
          {
            code: ErrorCode.OperationUnknown,
            context: { id: request.id ?? null, available: [...byId.keys()] },
          },
        );
      // Bound the raw submission BEFORE the runner hashes input, allocates a record or starts a worker.
      const inputBytes = Buffer.byteLength(
        JSON.stringify(envelopeBudget ? args : request.input) ?? '',
        'utf8',
      );
      if (inputBytes > input.maxInputBytes)
        throw new InputError(
          'totalfinance_job_submit: Job submission exceeds maxInputBytes; use a bulk-data handle or raise the server budget.',
          {
            code: ErrorCode.OperationInputTooLarge,
            context: { inputBytes, maxInputBytes: input.maxInputBytes },
          },
        );
      return input.runner.submit({
        id: operation.id,
        input: request.input,
        requestId: `mcp-${randomUUID()}`,
        seed: input.defaultSeed,
        maxInputBytes: input.maxInputBytes,
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      });
    },
    cancel(jobId: string) {
      get(jobId); // Authorize before touching a broader runner; no existence oracle for hidden jobs.
      return input.runner.cancel(jobId);
    },
  };
}
