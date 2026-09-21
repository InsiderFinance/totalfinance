/**
 * OpenAPI 3.1 for the local HTTP server (Stage 7A Decision 7): generated from the registry — the
 * operations' JSON Schemas verbatim (components keyed by id), one error schema (`OperationError`),
 * and the `x-totalfinance` vendor extension carrying each operation's effect metadata and annotations.
 * Deterministic (ids sorted) so the committed document diffs cleanly.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import type { JSONSchema } from '@totalfinance/core/schema';
import {
  OPERATION_BUDGETS,
  RESOURCE_HANDLE_SCHEMA,
  WORKFLOWS_VERSION,
  type OperationDescription,
  type OperationRegistry,
  operationResultSchema as sharedOperationResultSchema,
} from '@totalfinance/workflows';
import { operationWrites } from './security.js';

export interface OpenApiDocumentInput {
  registry: OperationRegistry;
  /** The server url advertised in `servers` (default `http://127.0.0.1:8787`). */
  serverUrl?: string;
}

/** The subset of OpenAPI 3.1 this document uses — enough to be typed, validated, and diffed. */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JSONSchema>;
    securitySchemes: Record<string, { type: 'http'; scheme: 'bearer'; description: string }>;
  };
}

const OPERATION_ERROR: JSONSchema = {
  type: 'object',
  description: 'Every non-2xx body: the same document the CLI prints and the MCP server returns.',
  properties: {
    code: {
      type: 'string',
      description: 'A registered TotalFinance error code (input.*, operation.*, …)',
    },
    message: { type: 'string' },
    context: { type: 'object' },
    operation: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'string' } },
      required: ['id', 'version'],
    },
  },
  required: ['code', 'message', 'context', 'operation'],
};

const RESOURCE_HANDLE: JSONSchema = RESOURCE_HANDLE_SCHEMA;

const JOB_RECORD: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    operation: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'string' } },
      required: ['id', 'version'],
    },
    state: {
      type: 'string',
      enum: ['accepted', 'queued', 'running', 'completed', 'failed', 'cancelled'],
    },
    progress: {
      type: ['object', 'null'],
      properties: { stage: { type: 'string' }, fraction: { type: ['number', 'null'] } },
    },
    inputsHash: { type: 'string' },
    seed: { type: ['integer', 'null'] },
    submittedAt: { type: 'string' },
    startedAt: { type: ['string', 'null'] },
    finishedAt: { type: ['string', 'null'] },
    result: { oneOf: [{ $ref: '#/components/schemas/ResourceHandle' }, { type: 'null' }] },
    error: { oneOf: [{ $ref: '#/components/schemas/OperationError' }, { type: 'null' }] },
    usage: { type: 'object', properties: { elapsedMs: { type: ['number', 'null'] } } },
  },
  required: [
    'id',
    'operation',
    'state',
    'progress',
    'inputsHash',
    'seed',
    'submittedAt',
    'startedAt',
    'finishedAt',
    'result',
    'error',
    'usage',
  ],
};

const OPERATION_DESCRIPTION: JSONSchema = {
  type: 'object',
  description: 'describeOperation(...) — the transport-neutral description every adapter renders.',
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    inputSchema: { type: 'object' },
    outputSchema: { type: ['object', 'null'] },
    sideEffect: { type: 'string', enum: ['none', 'portfolio-state', 'external-order'] },
    authorization: { type: 'string', enum: ['none', 'policy', 'human'] },
    idempotency: { type: 'string', enum: ['not-applicable', 'optional', 'required'] },
    deterministic: { type: 'boolean' },
    stochastic: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['per-call'] }] },
    costClass: { type: 'string', enum: ['small', 'medium', 'large', 'job'] },
    requiredCapabilities: { type: 'array', items: { type: 'string' } },
    supportsCancellation: { type: 'boolean' },
    handleFields: { type: 'array', items: { type: 'string' } },
    annotations: {
      type: 'object',
      properties: {
        readOnlyHint: { type: 'boolean' },
        destructiveHint: { type: 'boolean' },
        idempotentHint: { type: 'boolean' },
        openWorldHint: { type: 'boolean' },
      },
      required: ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
    },
  },
  required: [
    'id',
    'version',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'sideEffect',
    'authorization',
    'idempotency',
    'deterministic',
    'stochastic',
    'costClass',
    'requiredCapabilities',
    'supportsCancellation',
    'handleFields',
    'annotations',
  ],
};

function operationResultSchema(outputRef: string | null): JSONSchema {
  // One envelope definition for every transport (workflows/envelope-schema): the HTTP document
  // refers to the shared handle and per-operation output components by `$ref`.
  return sharedOperationResultSchema({
    ...(outputRef === null ? {} : { structured: { $ref: outputRef } }),
    handle: { $ref: '#/components/schemas/ResourceHandle' },
  });
}

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/OperationError' } } },
});

const ERROR_RESPONSES = {
  '400': errorResponse('The input was refused (an input.* code).'),
  '401': errorResponse('Missing or invalid bearer credential (operation.capability_missing).'),
  '403': errorResponse(
    'Untrusted Host/Origin, missing server capability, or mutations disabled without a credential.',
  ),
  '404': errorResponse('Unknown operation, job, or handle.'),
  '413': errorResponse('The input exceeds the wire byte budget (operation.input_too_large).'),
  '415': errorResponse(
    'JSON POST requests require Content-Type: application/json (input.wrong_shape).',
  ),
  '422': errorResponse('The operation failed (any other operation error).'),
  '500': errorResponse('Internal error (operation.internal).'),
};

function vendorExtension(description: OperationDescription): Record<string, unknown> {
  return {
    'x-totalfinance': {
      sideEffect: description.sideEffect,
      authorization: description.authorization,
      idempotency: description.idempotency,
      deterministic: description.deterministic,
      stochastic: description.stochastic,
      costClass: description.costClass,
      supportsCancellation: description.supportsCancellation,
      handleFields: description.handleFields,
      annotations: description.annotations,
    },
  };
}

/** Generate the OpenAPI 3.1 document for a registry. */
export function openApiDocument(input: OpenApiDocumentInput): OpenApiDocument {
  const functionName = 'openApiDocument';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError(`${functionName}: input must be an object ({ registry, serverUrl? }).`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input' },
    });
  }
  for (const key of Object.keys(input)) {
    if (key !== 'registry' && key !== 'serverUrl') {
      throw new InputError(
        `${functionName}: unknown field "${key}" in input. Allowed fields: registry, serverUrl.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: 'input', key },
        },
      );
    }
  }
  const registry = input.registry as unknown as Record<string, unknown> | null;
  if (
    registry === null ||
    typeof registry !== 'object' ||
    ['list', 'get', 'require', 'describe', 'run', 'packs'].some(
      (member) => typeof registry[member] !== 'function',
    ) ||
    !Number.isSafeInteger(registry['size']) ||
    (registry['size'] as number) < 0
  ) {
    throw new InputError(`${functionName}: input.registry must be an OperationRegistry.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input.registry' },
    });
  }
  if (
    input.serverUrl !== undefined &&
    (typeof input.serverUrl !== 'string' || !/^https?:\/\//.test(input.serverUrl))
  ) {
    throw new InputError(`${functionName}: input.serverUrl must be an http(s) url when present.`, {
      code:
        typeof input.serverUrl === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
      context: { function: functionName, field: 'input.serverUrl' },
    });
  }
  const descriptions = [...input.registry.list()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const schemas: Record<string, JSONSchema> = {
    OperationError: OPERATION_ERROR,
    ResourceHandle: RESOURCE_HANDLE,
    JobRecord: JOB_RECORD,
    OperationDescription: OPERATION_DESCRIPTION,
    OperationResult: operationResultSchema(null),
  };
  const paths: Record<string, Record<string, unknown>> = {
    '/operations': {
      get: {
        operationId: 'listOperations',
        summary: 'Every registered operation, described',
        responses: {
          '200': {
            description: 'The descriptions, in registry order.',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/OperationDescription' },
                },
              },
            },
          },
        },
      },
    },
    '/operations/{id}': {
      get: {
        operationId: 'describeOperation',
        summary: 'One operation, described',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The description.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OperationDescription' } },
            },
          },
          '404': ERROR_RESPONSES['404'],
        },
      },
    },
  };
  for (const description of descriptions) {
    const inputName = `${description.id}.input`;
    const outputName = `${description.id}.output`;
    schemas[inputName] = description.inputSchema;
    if (description.outputSchema !== null) schemas[outputName] = description.outputSchema;
    const resultName = `${description.id}.result`;
    schemas[resultName] = operationResultSchema(
      description.outputSchema !== null ? `#/components/schemas/${outputName}` : null,
    );
    paths[`/operations/${description.id}/run`] = {
      post: {
        operationId: `run.${description.id}`,
        security: operationWrites(description) ? [{ localBearer: [] }] : [],
        summary: description.title,
        description: description.description,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${inputName}` } },
          },
        },
        responses: {
          '200': {
            description: 'The OperationResult.',
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${resultName}` } },
            },
          },
          ...ERROR_RESPONSES,
        },
        ...vendorExtension(description),
      },
    };
  }
  paths['/jobs'] = {
    post: {
      operationId: 'submitJob',
      security: [{ localBearer: [] }],
      description:
        'Job creation persists state even for analytics and always requires the server-owned bearer token. Without a configured token, submission is disabled; inline read-only /run calls remain public.',
      summary:
        'Submit an operation as a job (a job-class operation runs in a worker; others inline)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                input: { type: 'object' },
                seed: { type: 'integer' },
              },
              required: ['id', 'input'],
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'The accepted (or, inline, terminal) record.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/JobRecord' } } },
        },
        ...ERROR_RESPONSES,
      },
    },
  };
  paths['/jobs/{id}'] = {
    get: {
      operationId: 'getJob',
      summary: 'The job record',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The record.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/JobRecord' } } },
        },
        '404': ERROR_RESPONSES['404'],
      },
    },
  };
  paths['/jobs/{id}/cancel'] = {
    post: {
      operationId: 'cancelJob',
      security: [{ localBearer: [] }],
      description:
        'Cancellation mutates persisted job state and always requires the server-owned bearer token. No JSON body is required.',
      summary: 'Cancel a job — the worker is terminated; the record moves to cancelled',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The cancelled (or already terminal) record.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/JobRecord' } } },
        },
        ...ERROR_RESPONSES,
      },
    },
  };
  paths['/jobs/{id}/result'] = {
    get: {
      operationId: 'getJobResult',
      summary: 'The stored OperationResult of a completed job',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The OperationResult.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OperationResult' } },
          },
        },
        '404': ERROR_RESPONSES['404'],
        '409': errorResponse('The job was cancelled (operation.cancelled) or has not finished.'),
        '422': ERROR_RESPONSES['422'],
      },
    },
  };
  paths['/artifacts/{uri}'] = {
    get: {
      operationId: 'getArtifact',
      summary: 'A stored value by handle uri (url-encoded)',
      parameters: [{ name: 'uri', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The handle and the stored value.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  handle: { $ref: '#/components/schemas/ResourceHandle' },
                  value: { type: 'object' },
                },
                required: ['handle', 'value'],
              },
            },
          },
        },
        '404': ERROR_RESPONSES['404'],
      },
    },
  };
  paths['/capabilities'] = {
    get: {
      operationId: 'capabilities',
      summary: 'Packs, budgets, the seed policy, and which stores are attached',
      responses: {
        '200': {
          description: 'The capabilities.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  };
  paths['/openapi.json'] = {
    get: {
      operationId: 'openapi',
      summary: 'This document',
      responses: {
        '200': {
          description: 'The OpenAPI 3.1 document.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  };
  // Host/Origin and malformed-target checks also protect all discovery and read routes.
  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      const route = operation as { responses: Record<string, unknown> };
      route.responses['400'] ??= ERROR_RESPONSES['400'];
      route.responses['403'] ??= ERROR_RESPONSES['403'];
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'TotalFinance local operations',
      version: WORKFLOWS_VERSION,
      description:
        `The local, read-only-by-default, loopback HTTP transport over the TotalFinance operation registry (${descriptions.length} operations across ${input.registry.packs().length} packs). ` +
        `Host and any Origin must match this server's host and bound port; null/foreign origins are refused. JSON POSTs require application/json. ` +
        `Enabled writes (including trade:approve) and job creation/cancellation require a server-owned bearer credential; read-only analytics and discovery remain unauthenticated. A credential does not grant capabilities. ` +
        `Every request body is the operation's own input schema; every error body is one OperationError. ` +
        `Wire byte budget default ${OPERATION_BUDGETS.maxInputBytes.transportDefault}.`,
    },
    servers: [{ url: input.serverUrl ?? 'http://127.0.0.1:8787', description: 'loopback' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        localBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Server-owned authenticationToken, at least 32 cryptographically random characters. Configure via --token-file or TOTALFINANCE_HTTP_TOKEN; send Authorization: Bearer <token>. Required for enabled writes (including approval), job creation and cancellation. Absent configuration disables job mutations. Read-only analytics remain public. No token is published in this document.',
        },
      },
    },
  };
}
