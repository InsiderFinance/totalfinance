#!/usr/bin/env node
/**
 * The `totalfinance` command line (Stage 7A Decision 6). Machine mode is the default: one JSON document
 * on stdout, logs on stderr only; `--pretty` is the explicit human mode. Exit codes are a contract
 * (`CLI_EXIT_CODES`). The CLI owns no schema and no compute — every command renders
 * `describeOperation`, calls `runOperation`, or drives the job runner and the file stores.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isQuantError, ErrorCode } from '@totalfinance/core';
import {
  OPERATION_BUDGETS,
  WORKFLOWS_VERSION,
  runOperation,
  toOperationError,
  type OperationError,
  type OperationRegistry,
} from '@totalfinance/workflows';
import { CLI_EXIT_CODES, type CliExitCode } from './exit-codes.js';
import {
  REGISTRY_PROFILES,
  cancelJob,
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createFileJobStore,
  registryForProfile,
  submitJob,
  type RegistryProfile,
} from '@totalfinance/workflows/local';

const NODE_FLOOR = '22.13.0';

const HELP = `totalfinance — TotalFinance local operations (machine-first; JSON on stdout, logs on stderr)

Usage
  totalfinance operations list                         every registered operation (descriptions)
  totalfinance schema <id> [--output]                  an operation's input (or output) JSON Schema
  totalfinance run <id> --input <file|->               run an operation inline; prints the OperationResult
  totalfinance job submit <id> --input <file|-> [--follow]
                                                   run a job-class operation in a worker; prints the terminal record
  totalfinance job status <jobId> [--follow]           the job record (NDJSON while following)
  totalfinance job result <jobId>                      the stored OperationResult of a completed job
  totalfinance job cancel <jobId>                      cancel a job from any process
  totalfinance artifacts get <uri>                     a stored value by handle uri ({ handle, value })
  totalfinance serve --http [--port 8787] [--host 127.0.0.1] [--openapi]
                                                   the exact totalfinance-http invocation (this binary never serves)
  totalfinance doctor                                  the Node floor, the registry, the store, the budgets
  totalfinance --help | --version

Global flags
  --profile default|options|research|full          the registry profile (default: default)
  --packs a,b                                      narrow the profile to named packs
  --seed <int>                                     the default seed injected into a stochastic call
  --max-input-bytes <n>                            the wire byte budget (default ${OPERATION_BUDGETS.maxInputBytes.transportDefault})
  --deadline-ms <n>                                post-hoc deadline for an inline run
  --store <dir>                                    the artifact/job store directory (default ~/.totalfinance/store)
  --capability <name>                              a capability the caller holds (repeatable; default portfolio:read, analytics:run, trade:propose)
  --pretty                                         human mode: indented JSON and a summary line on stderr

Exit codes
  0 success · 2 usage · 3 input refused (input.*) · 4 operation failed · 5 job cancelled · 70 internal
`;

class UsageError extends Error {}

function readPackageVersion(): string {
  try {
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(text) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function nodeMeetsFloor(version: string, floor: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number(part));
  const [a, b, c] = parse(version);
  const [x, y, z] = parse(floor);
  return a! > x! || (a === x && (b! > y! || (b === y && c! >= z!)));
}

/** Parse one integer flag; a non-integer is a usage error, never a silent default. */
function integerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value))
    throw new UsageError(`--${name} must be an integer, received ${JSON.stringify(value)}`);
  return Number(value);
}

function readInputDocument(source: string | undefined): unknown {
  if (source === undefined) throw new UsageError('--input <file|-> is required (use - for stdin)');
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(source), 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(
      `--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface Globals {
  registry: OperationRegistry;
  profile: RegistryProfile;
  packs: readonly string[] | undefined;
  store: string;
  capabilities: readonly string[] | undefined;
  seed: number | undefined;
  maxInputBytes: number;
  deadlineMs: number | undefined;
  pretty: boolean;
}

function emit(document: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(document, null, pretty ? 2 : 0)}\n`);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function exitCodeFor(error: OperationError): CliExitCode {
  if (error.code.startsWith('input.')) return CLI_EXIT_CODES.inputRefused;
  if (error.code === 'operation.cancelled') return CLI_EXIT_CODES.jobCancelled;
  if (error.code === 'operation.internal') return CLI_EXIT_CODES.internal;
  return CLI_EXIT_CODES.operationFailed;
}

function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      profile: { type: 'string' },
      packs: { type: 'string' },
      seed: { type: 'string' },
      'max-input-bytes': { type: 'string' },
      'deadline-ms': { type: 'string' },
      store: { type: 'string' },
      capability: { type: 'string', multiple: true },
      pretty: { type: 'boolean' },
      input: { type: 'string' },
      output: { type: 'boolean' },
      follow: { type: 'boolean' },
      json: { type: 'boolean' },
      http: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      openapi: { type: 'boolean' },
    },
  });
}

async function main(argv: string[]): Promise<CliExitCode> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    // parseArgs reports an unknown flag or a missing value as a TypeError carrying an ERR_PARSE_ARGS_* code.
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    emit(
      { totalfinance: readPackageVersion(), workflows: WORKFLOWS_VERSION, node: process.version },
      Boolean(values.pretty),
    );
    return CLI_EXIT_CODES.success;
  }
  if (values.help || positionals.length === 0) {
    process.stderr.write(HELP);
    return values.help ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.usage;
  }
  const profile = (values.profile ?? 'default') as RegistryProfile;
  if (!REGISTRY_PROFILES.includes(profile)) {
    throw new UsageError(
      `--profile must be one of ${REGISTRY_PROFILES.join(', ')}, received ${JSON.stringify(values.profile)}`,
    );
  }
  const packs =
    values.packs === undefined
      ? undefined
      : values.packs
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
  const storeFlag = values.store ?? join(homedir(), '.totalfinance', 'store');
  const globals: Globals = {
    registry: registryForProfile({ profile, ...(packs ? { packs } : {}) }),
    profile,
    packs,
    store: isAbsolute(storeFlag) ? storeFlag : resolve(storeFlag),
    capabilities: values.capability === undefined ? undefined : [...values.capability],
    seed: integerFlag('seed', values.seed),
    maxInputBytes:
      integerFlag('max-input-bytes', values['max-input-bytes']) ??
      OPERATION_BUDGETS.maxInputBytes.transportDefault,
    deadlineMs: integerFlag('deadline-ms', values['deadline-ms']),
    pretty: Boolean(values.pretty),
  };
  const [command, ...rest] = positionals;
  switch (command) {
    case 'operations':
      return operations(globals, rest);
    case 'schema':
      return schema(globals, rest, Boolean(values.output));
    case 'run':
      return run(globals, rest, values.input);
    case 'job':
      return job(globals, rest, values.input, Boolean(values.follow));
    case 'artifacts':
      return artifacts(globals, rest);
    case 'serve':
      return serve(globals, values);
    case 'doctor':
      return doctor(globals);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)} — see totalfinance --help`);
  }
}

function operations(globals: Globals, rest: string[]): CliExitCode {
  if (rest[0] !== 'list') throw new UsageError('usage: totalfinance operations list');
  const list = globals.registry.list();
  if (globals.pretty) {
    log(
      `${list.length} operations across ${globals.registry.packs().length} packs (profile ${globals.profile})`,
    );
  }
  emit(list, globals.pretty);
  return CLI_EXIT_CODES.success;
}

function schema(globals: Globals, rest: string[], output: boolean): CliExitCode {
  const id = rest[0];
  if (id === undefined) throw new UsageError('usage: totalfinance schema <id> [--output]');
  const description = globals.registry.describe(id);
  emit(output ? description.outputSchema : description.inputSchema, globals.pretty);
  return CLI_EXIT_CODES.success;
}

function run(globals: Globals, rest: string[], inputSource: string | undefined): CliExitCode {
  const id = rest[0];
  if (id === undefined) throw new UsageError('usage: totalfinance run <id> --input <file|->');
  const operation = globals.registry.require(id);
  const input = readInputDocument(inputSource);
  const artifacts = createFileArtifactStore({ directory: globals.store });
  const stores = {
    authorization: createFileAuthorizationStore({ directory: globals.store }),
    journal: createFileExecutionJournalStore({ directory: globals.store }),
  };
  try {
    const result = runOperation({
      operation,
      input,
      artifacts,
      stores,
      ...(globals.capabilities !== undefined ? { capabilities: globals.capabilities } : {}),
      createdTimestampMs: Date.now(),
      maxInputBytes: globals.maxInputBytes,
      ...(globals.seed !== undefined ? { defaultSeed: globals.seed } : {}),
      ...(globals.deadlineMs !== undefined ? { deadlineMs: globals.deadlineMs } : {}),
    });
    if (globals.pretty) log(result.summary);
    emit(result, globals.pretty);
    return CLI_EXIT_CODES.success;
  } catch (error) {
    const mapped = toOperationError(error, operation);
    emit(mapped, globals.pretty);
    return exitCodeFor(mapped);
  }
}

async function job(
  globals: Globals,
  rest: string[],
  inputSource: string | undefined,
  follow: boolean,
): Promise<CliExitCode> {
  const [verb, target] = rest;
  const jobs = createFileJobStore({ directory: globals.store });
  const artifactStore = createFileArtifactStore({ directory: globals.store });
  const clock = () => new Date().toISOString();
  switch (verb) {
    case 'submit': {
      if (target === undefined)
        throw new UsageError('usage: totalfinance job submit <id> --input <file|-> [--follow]');
      const input = readInputDocument(inputSource);
      const jobRun = submitJob({
        registry: globals.registry,
        jobs,
        artifacts: artifactStore,
        directory: globals.store,
        id: target,
        input,
        profile: globals.profile,
        ...(globals.packs ? { packs: globals.packs } : {}),
        clock,
        ...(globals.seed !== undefined ? { seed: globals.seed } : {}),
        maxInputBytes: globals.maxInputBytes,
        ...(globals.deadlineMs !== undefined ? { deadlineMs: globals.deadlineMs } : {}),
      });
      if (follow) emit(jobRun.record, false);
      const stop = () => {
        void jobRun.cancel();
      };
      process.once('SIGINT', stop);
      const terminal = await jobRun.completion;
      process.off('SIGINT', stop);
      emit(terminal, globals.pretty);
      return terminal.state === 'completed'
        ? CLI_EXIT_CODES.success
        : terminal.state === 'cancelled'
          ? CLI_EXIT_CODES.jobCancelled
          : terminal.error
            ? exitCodeFor(terminal.error)
            : CLI_EXIT_CODES.operationFailed;
    }
    case 'status': {
      if (target === undefined)
        throw new UsageError('usage: totalfinance job status <jobId> [--follow]');
      let record = jobs.get(target);
      if (record === null) return unknownJob(globals, target);
      if (!follow) {
        emit(record, globals.pretty);
        return CLI_EXIT_CODES.success;
      }
      let last = '';
      for (;;) {
        const line = JSON.stringify(record);
        if (line !== last) {
          process.stdout.write(`${line}\n`);
          last = line;
        }
        if (
          record.state === 'completed' ||
          record.state === 'failed' ||
          record.state === 'cancelled'
        )
          break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        record = jobs.get(target) ?? record;
      }
      return CLI_EXIT_CODES.success;
    }
    case 'result': {
      if (target === undefined) throw new UsageError('usage: totalfinance job result <jobId>');
      const record = jobs.get(target);
      if (record === null) return unknownJob(globals, target);
      if (record.state === 'cancelled') {
        emit(
          {
            code: ErrorCode.OperationCancelled,
            message: `job ${target} was cancelled`,
            context: { jobId: target },
            operation: record.operation,
          },
          globals.pretty,
        );
        return CLI_EXIT_CODES.jobCancelled;
      }
      if (record.state === 'failed' && record.error) {
        emit(record.error, globals.pretty);
        return exitCodeFor(record.error);
      }
      if (record.result === null) {
        emit(
          {
            code: ErrorCode.OperationInternal,
            message: `job ${target} is ${record.state} — no result yet (poll job status)`,
            context: { jobId: target, state: record.state },
            operation: record.operation,
          },
          globals.pretty,
        );
        return CLI_EXIT_CODES.operationFailed;
      }
      const stored = artifactStore.get(record.result.uri);
      if (stored === null) {
        emit(
          {
            code: ErrorCode.OperationHandleUnknown,
            message: `the result handle ${record.result.uri} is not in the store at ${globals.store}`,
            context: { uri: record.result.uri },
            operation: record.operation,
          },
          globals.pretty,
        );
        return CLI_EXIT_CODES.operationFailed;
      }
      emit(stored.value, globals.pretty);
      return CLI_EXIT_CODES.success;
    }
    case 'cancel': {
      if (target === undefined) throw new UsageError('usage: totalfinance job cancel <jobId>');
      if (jobs.get(target) === null) return unknownJob(globals, target);
      emit(cancelJob({ jobs, id: target, clock }), globals.pretty);
      return CLI_EXIT_CODES.success;
    }
    default:
      throw new UsageError('usage: totalfinance job submit|status|result|cancel …');
  }
}

function unknownJob(globals: Globals, id: string): CliExitCode {
  emit(
    {
      code: ErrorCode.OperationHandleUnknown,
      message: `unknown job '${id}' in the store at ${globals.store} — list the jobs directory or check --store`,
      context: { jobId: id, store: globals.store },
      operation: { id: 'totalfinance.job', version: '0' },
    },
    globals.pretty,
  );
  return CLI_EXIT_CODES.operationFailed;
}

function artifacts(globals: Globals, rest: string[]): CliExitCode {
  const [verb, uri] = rest;
  if (verb !== 'get' || uri === undefined)
    throw new UsageError('usage: totalfinance artifacts get <uri>');
  const store = createFileArtifactStore({ directory: globals.store });
  const entry = store.get(uri);
  if (entry === null) {
    emit(
      {
        code: ErrorCode.OperationHandleUnknown,
        message: `${uri} is not in the store at ${globals.store}`,
        context: { uri, store: globals.store },
        operation: { id: 'totalfinance.artifacts', version: '0' },
      },
      globals.pretty,
    );
    return CLI_EXIT_CODES.operationFailed;
  }
  emit(entry, globals.pretty);
  return CLI_EXIT_CODES.success;
}

function serve(
  globals: Globals,
  values: { http?: boolean; port?: string; host?: string; openapi?: boolean },
): CliExitCode {
  // L6 packages never depend on each other: the server is @totalfinance/http's own binary. This is a
  // teaching, not a hidden dependency.
  const parts = ['totalfinance-http'];
  if (values.port !== undefined) parts.push('--port', values.port);
  if (values.host !== undefined) parts.push('--host', values.host);
  if (values.openapi) parts.push('--openapi');
  parts.push('--profile', globals.profile, '--store', globals.store);
  log(
    `totalfinance does not serve HTTP itself; run the @totalfinance/http binary:\n  ${parts.join(' ')}`,
  );
  return CLI_EXIT_CODES.usage;
}

function doctor(globals: Globals): CliExitCode {
  const artifactStore = createFileArtifactStore({ directory: globals.store });
  const jobs = createFileJobStore({ directory: globals.store });
  const list = globals.registry.list();
  const report = {
    node: {
      version: process.version,
      floor: NODE_FLOOR,
      meetsFloor: nodeMeetsFloor(process.version, NODE_FLOOR),
    },
    totalfinance: { version: readPackageVersion(), workflows: WORKFLOWS_VERSION },
    registry: {
      profile: globals.profile,
      packs: globals.registry.packs().map((pack) => pack.name),
      operations: list.length,
      stochastic: list.filter((op) => op.stochastic !== false).map((op) => op.id),
      jobClass: list.filter((op) => op.costClass === 'job').map((op) => op.id),
    },
    store: {
      directory: globals.store,
      artifacts: artifactStore.list().length,
      jobs: jobs.list().length,
    },
    budgets: {
      maxInputBytes: globals.maxInputBytes,
      deadlineMs: globals.deadlineMs ?? null,
      inlineResultBytes: OPERATION_BUDGETS.inlineResultBytes.default,
      defaultSeed: globals.seed ?? null,
    },
  };
  emit(report, globals.pretty);
  return report.node.meetsFloor ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.usage;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      log(`totalfinance: ${error.message}`);
      process.exitCode = CLI_EXIT_CODES.usage;
      return;
    }
    if (isQuantError(error)) {
      // A typed refusal outside an operation call (a bad --store, an unknown operation id, …).
      const document = {
        code: error.code,
        message: error.message,
        context: error.context ?? {},
        operation: { id: 'totalfinance', version: '0' },
      };
      emit(document, false);
      process.exitCode = error.code.startsWith('input.')
        ? CLI_EXIT_CODES.inputRefused
        : CLI_EXIT_CODES.operationFailed;
      return;
    }
    log(
      `totalfinance: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = CLI_EXIT_CODES.internal;
  },
);
