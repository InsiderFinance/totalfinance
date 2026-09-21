/**
 * The JSON Schema of the one result envelope every transport returns (pre-publish interface
 * repairs, B2). `runOperation` produces an `OperationResult`; the JSON HTTP route sends it as the
 * body, the CLI prints it, and the MCP server returns it as `structuredContent` — byte-for-byte the
 * same document. The schema lives here so the OpenAPI document and every MCP tool's `outputSchema`
 * describe the envelope from one definition, including the branch a large result takes when it is
 * spilled to an artifact handle.
 */

import { ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { JSONSchema } from '@totalfinance/core/schema';
import { HANDLE_KINDS } from './stores.js';

const HANDLE_KIND_NAMES = Object.keys(HANDLE_KINDS);
const HANDLE_NAMESPACES = HANDLE_KIND_NAMES.map(
  (kind) => HANDLE_KINDS[kind as keyof typeof HANDLE_KINDS].namespace,
);

/**
 * A `ResourceHandle` — a stored report, job, portfolio, scenario, market, authorization or
 * journal — as JSON Schema. The kinds and URI namespaces are read from the one handle table, so
 * the schema can never list fewer kinds than the stores mint (an MCP client validates every
 * structured result against it).
 */
export const RESOURCE_HANDLE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    uri: { type: 'string', pattern: `^totalfinance://(${HANDLE_NAMESPACES.join('|')})/` },
    kind: { type: 'string', enum: HANDLE_KIND_NAMES },
    schema: { type: 'string' },
    version: { type: 'string' },
    contentHash: { type: ['string', 'null'] },
    createdTimestampMs: { type: 'number' },
    expiresTimestampMs: { type: ['number', 'null'] },
    provenance: { type: 'object' },
  },
  required: [
    'uri',
    'kind',
    'schema',
    'version',
    'contentHash',
    'createdTimestampMs',
    'expiresTimestampMs',
    'provenance',
  ],
};

/**
 * The `structured` slot of a result that exceeded the caller's inline byte budget: the runtime
 * stored the full output as a report and answered with its handle and a bounded preview.
 */
export function spilledResultSchema(handle: JSONSchema = RESOURCE_HANDLE_SCHEMA): JSONSchema {
  // A schema is an open record (any JSON Schema keyword); the one thing to refuse is a non-object.
  requireArgumentObject('spilledResultSchema', 'handle', handle);
  return {
    type: 'object',
    description:
      'The structured output exceeded the inline byte budget and was stored as a report; read `handle.uri` for the full result.',
    properties: {
      spilled: { const: true },
      handle,
      preview: {
        type: 'object',
        description: 'Top-level keys with scalars inline and containers summarized by size.',
      },
    },
    required: ['spilled', 'handle', 'preview'],
  };
}

/** A `QuantWarning` as JSON Schema: the typed code, the message and the severity. */
export const QUANT_WARNING_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warn', 'error'] },
    context: { type: 'object' },
  },
  required: ['code', 'message', 'severity'],
};

export interface OperationResultSchemaInput {
  /** The operation's own structured-output schema, or an open object when it declares none. */
  structured?: JSONSchema | undefined;
  /** How to refer to a resource handle — inline by default, or a `$ref` inside an OpenAPI document. */
  handle?: JSONSchema | undefined;
}

/**
 * The `OperationResult` envelope as JSON Schema: operation and library identity, the summary, the
 * structured output (or its spilled handle), assumptions, diagnostics with status, identity, the
 * artifact handles, usage and trace.
 */
export function operationResultSchema(input: OperationResultSchemaInput = {}): JSONSchema {
  requireArgumentObject('operationResultSchema', 'input', input);
  ensureKnownKeys('operationResultSchema', 'input', input, ['structured', 'handle']);
  // Present-or-absent: a `null` schema is not "the default schema", it is a malformed request.
  if (input.handle !== undefined)
    requireArgumentObject('operationResultSchema', 'input.handle', input.handle);
  if (input.structured !== undefined)
    requireArgumentObject('operationResultSchema', 'input.structured', input.structured);
  const handle = input.handle === undefined ? RESOURCE_HANDLE_SCHEMA : input.handle;
  const structured: JSONSchema =
    input.structured === undefined ? { type: 'object' } : input.structured;
  return {
    type: 'object',
    description:
      'runOperation(...) — identity, the structured output (or its spilled handle), assumptions, diagnostics, usage.',
    properties: {
      operation: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'string' } },
        required: ['id', 'version'],
      },
      library: {
        type: 'object',
        properties: { version: { type: 'string' } },
        required: ['version'],
      },
      summary: { type: 'string' },
      // `anyOf`, not `oneOf`: an operation that declares an open structured schema would match
      // the spilled branch too, and a validating client must still accept the result.
      structured: { anyOf: [structured, spilledResultSchema(handle)] },
      assumptions: { type: 'object' },
      diagnostics: {
        type: 'object',
        properties: {
          warnings: { type: 'array', items: QUANT_WARNING_SCHEMA },
          status: { type: 'string', enum: ['complete', 'partial'] },
          incomplete: { type: 'array', items: { type: 'string' } },
        },
        required: ['warnings', 'status', 'incomplete'],
      },
      identity: {
        type: 'object',
        properties: {
          inputsHash: { type: 'string' },
          artifactIds: { type: 'array', items: { type: 'string' } },
          snapshotHash: { type: ['string', 'null'] },
        },
        required: ['inputsHash', 'artifactIds', 'snapshotHash'],
      },
      artifacts: { type: 'array', items: handle },
      usage: {
        type: 'object',
        properties: { inputBytes: { type: 'integer' }, elapsedMs: { type: ['number', 'null'] } },
        required: ['inputBytes', 'elapsedMs'],
      },
      trace: {
        type: 'object',
        properties: { requestId: { type: ['string', 'null'] } },
        required: ['requestId'],
      },
    },
    required: [
      'operation',
      'library',
      'summary',
      'structured',
      'assumptions',
      'diagnostics',
      'identity',
      'artifacts',
      'usage',
      'trace',
    ],
  };
}
