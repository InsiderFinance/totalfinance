/**
 * The local HTTP server (Stage 7A Decision 7): loopback by default, unauthenticated and read-only,
 * one OperationError shape for every failure, `X-Request-Id` on every response. It owns no schema
 * and no compute — `runOperation` runs, the injected runner submits jobs, the stores answer handles.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ErrorCode, InputError, isQuantError } from '@totalfinance/core';
import {
  DEFAULT_CAPABILITIES,
  type ArtifactStore,
  type ArtifactStoreReader,
  type JobRecord,
  OPERATION_BUDGETS,
  type OperationError,
  type OperationRegistry,
  WORKFLOWS_VERSION,
  requireCapabilities,
  missingCapabilities,
  runOperation,
  toOperationError,
} from '@totalfinance/workflows';
import type { AuthorizationStore, ExecutionJournalStore } from '@totalfinance/workflows';
import type { JobRunner } from '@totalfinance/workflows/local';
import { openApiDocument, type OpenApiDocument } from './openapi.js';
import {
  hostForUrl,
  HttpRequestError,
  operationWrites,
  requestRoute,
  requireBearer,
  requireJson,
  requireLocalRequest,
} from './security.js';

export interface LocalHttpServerBudgets {
  /** The wire byte budget (default 65,536; maximum 16,777,216). */
  maxInputBytes?: number;
  /** Post-hoc deadline for an inline run (ms). */
  deadlineMs?: number;
  /** The default seed injected into a stochastic call that omits its own. */
  defaultSeed?: number;
  /** Spill threshold for a writable store (default 256 KiB). */
  inlineResultBytes?: number;
}

export interface LocalHttpServerInput {
  registry: OperationRegistry;
  /** Handles resolve through this store; a writable store also receives spilled results. */
  artifacts?: ArtifactStoreReader | ArtifactStore;
  /** The server's capability ceiling (default the runtime's defaults). Writes also need the bearer credential. */
  capabilities?: readonly string[];
  /** Server-owned bearer credential, at least 32 cryptographically random characters (e.g. randomBytes(32).toString('hex')). Required for enabled write operations, including trade:approve. Never returned by discovery. Read-only analytics remain public; job submission/cancellation always require this token. */
  authenticationToken?: string;
  /** The trade lifecycle's stores (Decision 10). */
  stores?: { authorization?: AuthorizationStore; journal?: ExecutionJournalStore };
  /** The job runner (`@insiderfinance/totalfinance/workflows/local`'s or another implementation of the contract). */
  jobs?: JobRunner;
  host?: string;
  port?: number;
  /** Binding anything but loopback needs this flag and your own network/TLS boundary; reads remain unauthenticated. */
  allowNonLoopback?: boolean;
  budgets?: LocalHttpServerBudgets;
  /** The caller's clock (ISO instants for spilled results and job transitions); default `Date`. */
  clock?: () => string;
}

export interface LocalHttpServer {
  document: OpenApiDocument;
  /** The bound address once started (`null` before `start()` / after `stop()`). */
  address(): { host: string; port: number; url: string } | null;
  /** Bind and listen; resolves with the bound address (port 0 picks a free port). */
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

const INPUT_KEYS = [
  'registry',
  'artifacts',
  'jobs',
  'host',
  'port',
  'allowNonLoopback',
  'budgets',
  'clock',
  'capabilities',
  'stores',
  'authenticationToken',
] as const;
const BUDGET_KEYS = ['maxInputBytes', 'deadlineMs', 'defaultSeed', 'inlineResultBytes'] as const;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function refuse(
  functionName: string,
  message: string,
  field: string,
  code: ErrorCode = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function requireInput(input: unknown): LocalHttpServerInput {
  const functionName = 'createLocalHttpServer';
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    refuse(functionName, 'input must be an object.', 'input');
  for (const key of Object.keys(input)) {
    if (!(INPUT_KEYS as readonly string[]).includes(key)) {
      refuse(
        functionName,
        `unknown field "${key}" in input. Allowed fields: ${INPUT_KEYS.join(', ')}.`,
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
      (m) => typeof registry[m] !== 'function',
    ) ||
    !Number.isSafeInteger(registry['size']) ||
    (registry['size'] as number) < 0
  ) {
    refuse(functionName, 'input.registry must be an OperationRegistry.', 'input.registry');
  }
  if (request['artifacts'] !== undefined) {
    const store = request['artifacts'] as Record<string, unknown> | null;
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store['get'] !== 'function' ||
      typeof store['list'] !== 'function'
    ) {
      refuse(
        functionName,
        'input.artifacts must be an artifact store ({ get, list, put? }).',
        'input.artifacts',
      );
    }
  }
  if (request['capabilities'] !== undefined) {
    requireCapabilities(functionName, 'input.capabilities', request['capabilities']);
  }
  if (request['authenticationToken'] !== undefined) {
    if (typeof request['authenticationToken'] !== 'string') {
      refuse(
        functionName,
        'input.authenticationToken must be a string.',
        'input.authenticationToken',
      );
    }
    if (!/^[A-Za-z0-9._~+/-]{32,}=*$/.test(request['authenticationToken'] as string)) {
      refuse(
        functionName,
        'input.authenticationToken must contain at least 32 cryptographically random bearer-token characters; generate randomBytes(32).toString("hex"). Supply it via --token-file or TOTALFINANCE_HTTP_TOKEN, never a secret CLI argument.',
        'input.authenticationToken',
        ErrorCode.InputWrongShape,
      );
    }
  }
  const capabilities =
    (request['capabilities'] as readonly string[] | undefined) ?? DEFAULT_CAPABILITIES;
  if (
    request['authenticationToken'] === undefined &&
    (input as LocalHttpServerInput).registry
      .list()
      .some(
        (operation) =>
          operationWrites(operation) &&
          missingCapabilities(operation.requiredCapabilities, capabilities).length === 0,
      )
  ) {
    refuse(
      functionName,
      'Enabled write operations require a server-owned authenticationToken with at least 32 cryptographically random characters (CLI: --token-file or TOTALFINANCE_HTTP_TOKEN). This includes trade:approve, which persists grants.',
      'input.authenticationToken',
      ErrorCode.InputMissingField,
    );
  }
  if (request['stores'] !== undefined) {
    const stores = request['stores'] as Record<string, unknown> | null;
    if (stores === null || typeof stores !== 'object' || Array.isArray(stores)) {
      refuse(
        functionName,
        'input.stores must be an object ({ authorization?, journal? }).',
        'input.stores',
      );
    }
  }
  if (request['jobs'] !== undefined) {
    const runner = request['jobs'] as Record<string, unknown> | null;
    if (
      runner === null ||
      typeof runner !== 'object' ||
      typeof runner['submit'] !== 'function' ||
      typeof runner['cancel'] !== 'function' ||
      typeof runner['get'] !== 'function'
    ) {
      refuse(
        functionName,
        'input.jobs must be a JobRunner ({ submit, cancel, get }).',
        'input.jobs',
      );
    }
  }
  if (
    request['host'] !== undefined &&
    (typeof request['host'] !== 'string' || request['host'].length === 0)
  ) {
    refuse(functionName, 'input.host must be a non-empty host name when present.', 'input.host');
  }
  if (
    request['port'] !== undefined &&
    !(
      Number.isInteger(request['port']) &&
      (request['port'] as number) >= 0 &&
      (request['port'] as number) <= 65_535
    )
  ) {
    refuse(
      functionName,
      'input.port must be an integer in [0, 65535] when present (0 picks a free port).',
      'input.port',
      typeof request['port'] === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
    );
  }
  if (
    request['allowNonLoopback'] !== undefined &&
    typeof request['allowNonLoopback'] !== 'boolean'
  ) {
    refuse(
      functionName,
      'input.allowNonLoopback must be a boolean when present.',
      'input.allowNonLoopback',
    );
  }
  if (request['budgets'] !== undefined) {
    const budgets = request['budgets'] as Record<string, unknown> | null;
    if (budgets === null || typeof budgets !== 'object' || Array.isArray(budgets))
      refuse(functionName, 'input.budgets must be an object when present.', 'input.budgets');
    for (const key of Object.keys(budgets)) {
      if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
        refuse(
          functionName,
          `unknown field "${key}" in input.budgets. Allowed fields: ${BUDGET_KEYS.join(', ')}.`,
          'input.budgets',
          ErrorCode.InputUnknownField,
        );
      }
      const value = budgets[key];
      if (
        value !== undefined &&
        !(
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          (key === 'defaultSeed' || value > 0)
        )
      ) {
        refuse(
          functionName,
          `input.budgets.${key} must be a ${key === 'defaultSeed' ? 'safe integer' : 'positive safe integer'} when present.`,
          `input.budgets.${key}`,
          typeof value === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
        );
      }
    }
  }
  if (request['clock'] !== undefined && typeof request['clock'] !== 'function') {
    refuse(
      functionName,
      'input.clock must be a function returning an ISO-8601 instant when present.',
      'input.clock',
    );
  }
  const host = (request['host'] as string | undefined) ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && request['allowNonLoopback'] !== true) {
    refuse(
      functionName,
      `input.host '${host}' is not loopback; binding elsewhere needs allowNonLoopback: true and your own network/TLS boundary (read endpoints remain public).`,
      'input.host',
      ErrorCode.InputWrongShape,
    );
  }
  return input as LocalHttpServerInput;
}

const ERROR_KEYS = ['code', 'message', 'context', 'issues', 'operation'] as const;

/** The closed structural guard for an error document handed to the mapper. */
function requireOperationErrorDocument(error: unknown): asserts error is OperationError {
  const functionName = 'statusForError';
  if (error === null || typeof error !== 'object' || Array.isArray(error))
    refuse(functionName, 'error must be an OperationError document.', 'error');
  for (const key of Object.keys(error)) {
    if (!(ERROR_KEYS as readonly string[]).includes(key)) {
      refuse(
        functionName,
        `unknown field "${key}" in error. Allowed fields: ${ERROR_KEYS.join(', ')}.`,
        'error',
        ErrorCode.InputUnknownField,
      );
    }
  }
  const document = error as Record<string, unknown>;
  if (typeof document['code'] !== 'string' || document['code'].length === 0)
    refuse(functionName, 'error.code must be a non-empty string.', 'error.code');
  if (typeof document['message'] !== 'string')
    refuse(functionName, 'error.message must be a string.', 'error.message');
  if (
    document['context'] === null ||
    typeof document['context'] !== 'object' ||
    Array.isArray(document['context'])
  ) {
    refuse(functionName, 'error.context must be an object.', 'error.context');
  }
  if (document['issues'] !== undefined && !Array.isArray(document['issues']))
    refuse(functionName, 'error.issues must be an array when present.', 'error.issues');
  const operation = document['operation'];
  if (operation !== null) {
    if (operation === undefined || typeof operation !== 'object' || Array.isArray(operation)) {
      refuse(
        functionName,
        'error.operation must be { id, version } or null.',
        'error.operation',
        operation === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
      );
    }
    const identity = operation as Record<string, unknown>;
    for (const key of Object.keys(identity)) {
      if (key !== 'id' && key !== 'version')
        refuse(
          functionName,
          `unknown field "${key}" in error.operation. Allowed fields: id, version.`,
          'error.operation',
          ErrorCode.InputUnknownField,
        );
    }
    if (typeof identity['id'] !== 'string' || typeof identity['version'] !== 'string') {
      refuse(
        functionName,
        'error.operation must be { id: string, version: string }.',
        'error.operation',
        ErrorCode.InputWrongShape,
      );
    }
  }
}

/** HTTP status for an OperationError (Decision 7). */
export function statusForError(error: OperationError): number {
  requireOperationErrorDocument(error);
  switch (error.code) {
    case ErrorCode.OperationUnknown:
    case ErrorCode.OperationHandleUnknown:
      return 404;
    case ErrorCode.OperationInputTooLarge:
      return 413;
    case ErrorCode.OperationCancelled:
      return 409;
    case ErrorCode.OperationInternal:
      return 500;
    default:
      return error.code.startsWith('input.') ? 400 : 422;
  }
}

function errorDocument(
  code: string,
  message: string,
  context: Record<string, unknown>,
  operation: { id: string; version: string },
): OperationError {
  return { code, message, context, operation } as OperationError;
}

class RequestTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly budget: number,
  ) {
    super('request too large');
  }
}

/**
 * Read the body up to the wire budget. An oversized body is DRAINED (read and discarded) so the
 * client receives the 413 instead of a dropped socket, then reported as `RequestTooLarge`.
 */
function readBody(request: IncomingMessage, budget: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (overflowed) return;
      if (bytes > budget) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (overflowed) reject(new RequestTooLarge(bytes, budget));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/** Create the server (not yet listening). */
export function createLocalHttpServer(rawInput: LocalHttpServerInput): LocalHttpServer {
  const input = requireInput(rawInput);
  const host = input.host === '[::1]' ? '::1' : (input.host ?? '127.0.0.1');
  const capabilities = [...(input.capabilities ?? DEFAULT_CAPABILITIES)];
  const token =
    input.authenticationToken === undefined
      ? undefined
      : Buffer.from(input.authenticationToken, 'utf8');
  const port = input.port ?? 8787;
  const clock = input.clock ?? (() => new Date().toISOString());
  const maxInputBytes =
    input.budgets?.maxInputBytes ?? OPERATION_BUDGETS.maxInputBytes.transportDefault;
  const writable =
    input.artifacts !== undefined && typeof (input.artifacts as ArtifactStore).put === 'function';
  const document = openApiDocument({
    registry: input.registry,
    serverUrl: `http://${hostForUrl(host)}:${port}`,
  });

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    requestId: string,
  ): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-request-id': requestId,
      'cache-control': 'no-store',
    });
    response.end(text);
  };
  const sendError = (response: ServerResponse, error: OperationError, requestId: string): void => {
    send(response, statusForError(error), error, requestId);
  };
  const routeError = (
    id: string,
    message: string,
    context: Record<string, unknown> = {},
  ): OperationError =>
    errorDocument(ErrorCode.OperationUnknown, message, context, { id, version: '0' });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId =
      typeof request.headers['x-request-id'] === 'string' &&
      request.headers['x-request-id'].length > 0
        ? request.headers['x-request-id']
        : randomUUID();
    try {
      const url = requestRoute(request.url ?? '/');
      const { segments } = url;
      const method = request.method ?? 'GET';
      requireLocalRequest(request, host);
      // GET /openapi.json · GET /capabilities · GET /operations · GET /operations/{id}
      if (method === 'GET' && url.pathname === '/openapi.json')
        return send(response, 200, document, requestId);
      if (method === 'GET' && url.pathname === '/capabilities') {
        return send(
          response,
          200,
          {
            library: { version: WORKFLOWS_VERSION },
            packs: input.registry
              .packs()
              .map((pack) => ({ name: pack.name, operations: pack.operations.map((op) => op.id) })),
            operations: input.registry.size,
            budgets: {
              maxInputBytes,
              deadlineMs: input.budgets?.deadlineMs ?? null,
              defaultSeed: input.budgets?.defaultSeed ?? 0,
              inlineResultBytes: writable
                ? (input.budgets?.inlineResultBytes ?? OPERATION_BUDGETS.inlineResultBytes.default)
                : null,
            },
            seedPolicy:
              'a stochastic call that omits its seed receives the default seed and echoes it under assumptions.seed',
            artifacts: input.artifacts === undefined ? 'none' : writable ? 'writable' : 'read-only',
            jobs: input.jobs !== undefined,
            host,
            readOnly:
              !(input.jobs !== undefined && token !== undefined) &&
              !input.registry
                .list()
                .some(
                  (operation) =>
                    operationWrites(operation) &&
                    missingCapabilities(operation.requiredCapabilities, capabilities).length === 0,
                ),
            authentication: {
              scheme: 'bearer',
              configured: token !== undefined,
              mutations: 'required',
              reads: 'public',
            },
            jobMutations: input.jobs !== undefined && token !== undefined,
          },
          requestId,
        );
      }
      if (method === 'GET' && segments[0] === 'operations' && segments.length === 1) {
        return send(response, 200, input.registry.list(), requestId);
      }
      if (method === 'GET' && segments[0] === 'operations' && segments.length === 2) {
        return send(response, 200, input.registry.describe(segments[1]!), requestId);
      }
      // POST /operations/{id}/run
      if (
        method === 'POST' &&
        segments[0] === 'operations' &&
        segments.length === 3 &&
        segments[2] === 'run'
      ) {
        const operation = input.registry.require(segments[1]!);
        requireOperationCapabilities(operation);
        if (operationWrites(operation)) requireBearer(request, token);
        requireJson(request);
        let body: unknown;
        try {
          body = JSON.parse((await readBody(request, maxInputBytes)) || 'null');
        } catch (error) {
          if (error instanceof RequestTooLarge) {
            return sendError(
              response,
              errorDocument(
                ErrorCode.OperationInputTooLarge,
                `${operation.id}: the request body exceeds the ${error.budget}-byte wire budget.`,
                { maxInputBytes: error.budget },
                { id: operation.id, version: operation.version },
              ),
              requestId,
            );
          }
          return sendError(
            response,
            errorDocument(
              ErrorCode.InputWrongShape,
              `${operation.id}: the request body is not valid JSON.`,
              {},
              { id: operation.id, version: operation.version },
            ),
            requestId,
          );
        }
        try {
          const result = runOperation({
            operation,
            input: body,
            maxInputBytes,
            requestId,
            ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
            capabilities,
            ...(input.stores !== undefined ? { stores: input.stores } : {}),
            ...(writable ? { createdTimestampMs: Date.parse(clock()) } : {}),
            ...(input.budgets?.deadlineMs !== undefined
              ? { deadlineMs: input.budgets.deadlineMs }
              : {}),
            ...(input.budgets?.defaultSeed !== undefined
              ? { defaultSeed: input.budgets.defaultSeed }
              : {}),
            ...(writable && input.budgets?.inlineResultBytes !== undefined
              ? { inlineResultBytes: input.budgets.inlineResultBytes }
              : {}),
          });
          return send(response, 200, result, requestId);
        } catch (error) {
          return sendError(response, toOperationError(error, operation), requestId);
        }
      }
      // Jobs
      if (segments[0] === 'jobs') {
        if (input.jobs === undefined) {
          return sendError(
            response,
            routeError(
              'totalfinance.jobs',
              'this server has no job runner attached — start it with a store directory (totalfinance-http --store <dir>) or pass `jobs` to createLocalHttpServer.',
            ),
            requestId,
          );
        }
        if (method === 'POST' && segments.length === 1) {
          requireBearer(request, token);
          requireJson(request);
          let body: unknown;
          try {
            body = JSON.parse((await readBody(request, maxInputBytes)) || 'null');
          } catch (error) {
            if (error instanceof RequestTooLarge) {
              return sendError(
                response,
                errorDocument(
                  ErrorCode.OperationInputTooLarge,
                  `the request body exceeds the ${error.budget}-byte wire budget.`,
                  { maxInputBytes: error.budget },
                  { id: 'totalfinance.jobs', version: '0' },
                ),
                requestId,
              );
            }
            return sendError(
              response,
              errorDocument(
                ErrorCode.InputWrongShape,
                'the request body is not valid JSON.',
                {},
                { id: 'totalfinance.jobs', version: '0' },
              ),
              requestId,
            );
          }
          const submission = body as { id?: unknown; input?: unknown; seed?: unknown } | null;
          if (
            submission === null ||
            typeof submission !== 'object' ||
            Array.isArray(submission) ||
            typeof submission.id !== 'string'
          ) {
            return sendError(
              response,
              errorDocument(
                ErrorCode.InputWrongShape,
                'POST /jobs expects { id, input, seed? }.',
                {},
                { id: 'totalfinance.jobs', version: '0' },
              ),
              requestId,
            );
          }
          for (const key of Object.keys(submission)) {
            if (!['id', 'input', 'seed'].includes(key)) {
              return sendError(
                response,
                errorDocument(
                  ErrorCode.InputUnknownField,
                  `unknown field "${key}" in POST /jobs. Allowed fields: id, input, seed.`,
                  { key },
                  { id: 'totalfinance.jobs', version: '0' },
                ),
                requestId,
              );
            }
          }
          const operation = input.registry.require(submission.id);
          requireOperationCapabilities(operation);
          const run = input.jobs.submit({
            id: operation.id,
            input: submission.input,
            requestId,
            maxInputBytes,
            ...(typeof submission.seed === 'number' ? { seed: submission.seed } : {}),
            ...(input.budgets?.deadlineMs !== undefined
              ? { deadlineMs: input.budgets.deadlineMs }
              : {}),
          });
          // The completion is observed by polling GET /jobs/{id}; keep the promise from surfacing as unhandled.
          void run.completion.catch(() => undefined);
          return send(response, 202, run.record, requestId);
        }
        const jobId = segments[1];
        if (jobId === undefined)
          return sendError(
            response,
            routeError('totalfinance.jobs', `no such route: ${method} ${url.pathname}`),
            requestId,
          );
        if (method === 'POST' && segments.length === 3 && segments[2] === 'cancel') {
          requireBearer(request, token);
        }
        const record = input.jobs.get(jobId);
        if (record === null) {
          return sendError(
            response,
            errorDocument(
              ErrorCode.OperationHandleUnknown,
              `unknown job '${jobId}'.`,
              { jobId },
              { id: 'totalfinance.jobs', version: '0' },
            ),
            requestId,
          );
        }
        if (method === 'GET' && segments.length === 2)
          return send(response, 200, record, requestId);
        if (method === 'POST' && segments.length === 3 && segments[2] === 'cancel') {
          return send(response, 200, input.jobs.cancel(jobId), requestId);
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'result') {
          return sendJobResult(response, record, requestId);
        }
      }
      // GET /artifacts/{uri}
      if (method === 'GET' && segments[0] === 'artifacts' && segments.length >= 2) {
        const uri = segments.slice(1).join('/');
        if (input.artifacts === undefined) {
          return sendError(
            response,
            errorDocument(
              ErrorCode.OperationHandleStoreMissing,
              'this server has no artifact store attached.',
              { uri },
              { id: 'totalfinance.artifacts', version: '0' },
            ),
            requestId,
          );
        }
        const entry = input.artifacts.get(uri);
        if (entry === null) {
          return sendError(
            response,
            errorDocument(
              ErrorCode.OperationHandleUnknown,
              `${uri} is not in the store.`,
              { uri },
              { id: 'totalfinance.artifacts', version: '0' },
            ),
            requestId,
          );
        }
        return send(response, 200, entry, requestId);
      }
      return sendError(
        response,
        routeError(
          'totalfinance.http',
          `no such route: ${method} ${url.pathname} — GET /openapi.json lists every route.`,
        ),
        requestId,
      );
    } catch (error) {
      if (error instanceof HttpRequestError) {
        // Drain rejected bodies without parsing them so pooled clients can safely reuse the socket.
        request.resume();
        if (error.status === 401)
          response.setHeader('www-authenticate', 'Bearer realm="totalfinance"');
        return send(
          response,
          error.status,
          errorDocument(error.code, error.message, error.context as Record<string, unknown>, {
            id: 'totalfinance.http',
            version: '0',
          }),
          requestId,
        );
      }
      if (isQuantError(error)) {
        return sendError(
          response,
          errorDocument(
            error.code,
            error.message,
            (error.context as Record<string, unknown> | undefined) ?? {},
            { id: 'totalfinance.http', version: '0' },
          ),
          requestId,
        );
      }
      return sendError(
        response,
        errorDocument(
          ErrorCode.OperationInternal,
          error instanceof Error ? error.message : String(error),
          {},
          { id: 'totalfinance.http', version: '0' },
        ),
        requestId,
      );
    }
  };

  const requireOperationCapabilities = (operation: {
    requiredCapabilities: readonly string[];
  }): void => {
    const missing = missingCapabilities(operation.requiredCapabilities, capabilities);
    if (missing.length > 0) {
      throw new HttpRequestError(
        403,
        `The server has not enabled the required capabilities: ${missing.join(', ')}. A bearer token does not grant additional capabilities.`,
        'capabilities',
        ErrorCode.OperationCapabilityMissing,
      );
    }
  };

  const sendJobResult = (response: ServerResponse, record: JobRecord, requestId: string): void => {
    if (record.state === 'cancelled') {
      return sendError(
        response,
        errorDocument(
          ErrorCode.OperationCancelled,
          `job ${record.id} was cancelled.`,
          { jobId: record.id },
          record.operation,
        ),
        requestId,
      );
    }
    if (record.state === 'failed' && record.error)
      return sendError(response, record.error, requestId);
    if (record.result === null) {
      return sendError(
        response,
        errorDocument(
          ErrorCode.OperationCancelled,
          `job ${record.id} is ${record.state} — no result yet; poll GET /jobs/${record.id}.`,
          { jobId: record.id, state: record.state },
          record.operation,
        ),
        requestId,
      );
    }
    if (input.artifacts === undefined) {
      return sendError(
        response,
        errorDocument(
          ErrorCode.OperationHandleStoreMissing,
          'this server has no artifact store attached to read the result from.',
          { uri: record.result.uri },
          record.operation,
        ),
        requestId,
      );
    }
    const entry = input.artifacts.get(record.result.uri);
    if (entry === null) {
      return sendError(
        response,
        errorDocument(
          ErrorCode.OperationHandleUnknown,
          `the result handle ${record.result.uri} is not in the store.`,
          { uri: record.result.uri },
          record.operation,
        ),
        requestId,
      );
    }
    return send(response, 200, entry.value, requestId);
  };

  // Own the mandatory Host refusal so it has an OperationError body, not Node's empty 400.
  // requireHostHeader is supported at our Node 22.13.0 floor (v22.13.0/lib/_http_server.js).
  // requireLocalRequest still requires Host and validates its authority before any dispatch.
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    void handle(request, response).catch(() => {
      // Last boundary: even a failure while rendering an error must not reject into the process.
      // Do not echo arbitrary exception text or headers, which may contain credentials.
      try {
        if (response.headersSent || response.destroyed) {
          response.destroy();
          return;
        }
        send(
          response,
          500,
          errorDocument(
            ErrorCode.OperationInternal,
            'Unexpected HTTP handler failure.',
            {},
            { id: 'totalfinance.http', version: '0' },
          ),
          randomUUID(),
        );
      } catch {
        response.destroy();
      }
    });
  });
  // Node can refuse a malformed request target before creating IncomingMessage.
  // Keep those parser-level failures structured too; never include error.rawPacket (credentials).
  server.on('clientError', (_error, socket) => {
    try {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      const body = JSON.stringify(
        errorDocument(
          ErrorCode.InputWrongShape,
          'Malformed HTTP request.',
          {},
          { id: 'totalfinance.http', version: '0' },
        ),
      );
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Request-Id: ${randomUUID()}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
      );
    } catch {
      socket.destroy();
    }
  });
  // Node closes an idle keep-alive socket after 5 s by default, which races a client's pooled
  // connection between one-shot local calls (an ECONNRESET on the client's next request). A local
  // server keeps idle sockets for 65 s — advertised in `Keep-Alive: timeout=65`, so clients that read
  // the hint (undici does) never reuse a socket the server is about to close.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  let bound: { host: string; port: number; url: string } | null = null;
  return {
    document,
    address: () => bound,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const boundPort = typeof address === 'object' && address !== null ? address.port : port;
          bound = { host, port: boundPort, url: `http://${hostForUrl(host)}:${boundPort}` };
          document.servers[0]!.url = bound.url;
          resolve(bound);
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          bound = null;
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
