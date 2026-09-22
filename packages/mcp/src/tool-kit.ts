/**
 * The MCP tool shape and the two builders: `toolFromOperation` renders a registry operation as a
 * tool (the shipped path), and `defineTool` builds a caller's own custom tool with the same run-time
 * validation. Neither owns a schema of its own — the operation (or the caller) does.
 */

import { ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { ErrorCode, InputError } from '@totalfinance/core';
import { requireJSONSchema } from '@totalfinance/core/schema';
import type { JSONSchema, Schema } from '@totalfinance/core/schema';
import {
  jsonSafe,
  requireOperation,
  runOperation,
  type OperationOutput,
  type TotalFinanceOperation,
} from '@totalfinance/workflows';

export interface ToolResult {
  /** Human-readable one-line summary. */
  summary: string;
  /** Machine-readable structured output (returned as MCP `structuredContent`). */
  structured: Record<string, unknown>;
}

export interface ToolPack {
  name: string;
  tools: TotalFinanceTool[];
}

export interface TotalFinanceTool {
  name: string;
  title: string;
  description: string;
  schema: Schema<unknown>;
  /**
   * JSON Schema describing the structured output (the `structured` slot). On the wire every
   * tool's `outputSchema` is the full `OperationResult` envelope wrapping this schema.
   */
  outputSchema?: JSONSchema;
  /** Whether the tool mutates state (filtered out in read-only mode). Default `false`. */
  mutates?: boolean;
  /**
   * Whether a call draws random samples, so the server's deterministic seed policy applies (inject
   * the default seed when absent; echo it in `structured.assumptions.seed`). `true` = every call;
   * a predicate = per-call (e.g. VaR is stochastic only for `method: 'monteCarlo'`). Default `false`.
   */
  stochastic?: boolean | ((args: Record<string, unknown>) => boolean);
  run(input: unknown): ToolResult;
}

/**
 * The registry operation behind a shipped tool. A private binding, not a field: a caller cannot
 * forge one onto a custom tool, and the tool's public shape stays exactly what an MCP client sees.
 */
const OPERATION_OF = new WeakMap<TotalFinanceTool, TotalFinanceOperation>();

/** @internal The operation a tool was rendered from, or `null` for a caller-defined custom tool. */
export function operationOf(tool: TotalFinanceTool): TotalFinanceOperation | null {
  return OPERATION_OF.get(tool) ?? null;
}

/**
 * The MCP tool name of an operation: the dotted operation id with every dot replaced by an
 * underscore (`totalfinance.option.price` → `totalfinance_option_price`). MCP clients constrain tool names
 * to `[A-Za-z0-9_-]`; the dotted id stays the operation's identity everywhere else — in
 * `_meta['totalfinance/operation'].id`, `totalfinance://operations/<id>`, the HTTP paths and the CLI.
 */
export function toolNameFor(operationId: string): string {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new InputError(
      `toolNameFor: operationId must be a non-empty string. Received ${operationId === null ? 'null' : typeof operationId}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'operationId' } },
    );
  }
  return operationId.replace(/\./g, '_');
}

/** Render a registry operation as an MCP tool — the shipped tools are exactly these. */
export function toolFromOperation(operation: TotalFinanceOperation): TotalFinanceTool {
  requireOperation('toolFromOperation', 'operation', operation);
  const tool: TotalFinanceTool = {
    name: toolNameFor(operation.id),
    title: operation.title,
    description: operation.description,
    schema: operation.inputSchema as Schema<unknown>,
    ...(operation.outputSchema !== null ? { outputSchema: operation.outputSchema } : {}),
    mutates: operation.sideEffect !== 'none',
    stochastic:
      typeof operation.stochastic === 'function'
        ? (args: Record<string, unknown>) =>
            (operation.stochastic as (input: unknown) => boolean)(args)
        : operation.stochastic,
    // A direct `tool.run(input)` (embedding, `defaultTools()[i].run(...)`) goes through the ONE
    // runtime: strict validation, JSON-safe output — the same path the server and every other
    // transport take, so an embedded call can never disagree with a wire call.
    run: (input: unknown): ToolResult => {
      const result = runOperation({ operation, input });
      return { summary: result.summary, structured: result.structured };
    },
  };
  OPERATION_OF.set(tool, operation);
  return tool;
}

const DEFINE_TOOL_KEYS = [
  'name',
  'title',
  'description',
  'schema',
  'outputSchema',
  'mutates',
  'stochastic',
  'run',
] as const;

function refuse(message: string, field: string, code: ErrorCode = ErrorCode.InputWrongType): never {
  throw new InputError(`defineTool: ${message}`, {
    code,
    context: { function: 'defineTool', field },
  });
}

/** Define a caller's own tool (the escape hatch for a custom server); validated on every run. */
export function defineTool<I>(definition: {
  name: string;
  title: string;
  description: string;
  schema: Schema<I>;
  outputSchema?: JSONSchema;
  mutates?: boolean;
  stochastic?: boolean | ((args: Record<string, unknown>) => boolean);
  run: (input: I) => ToolResult | OperationOutput<Record<string, unknown>>;
}): TotalFinanceTool {
  requireArgumentObject('defineTool', 'definition', definition);
  ensureKnownKeys('defineTool', 'definition', definition, DEFINE_TOOL_KEYS);
  for (const field of ['name', 'title', 'description'] as const) {
    if (typeof definition[field] !== 'string' || definition[field].length === 0) {
      refuse(`${field} must be a non-empty string.`, `definition.${field}`);
    }
  }
  const schema = definition.schema as unknown as { safeParse?: unknown; toJSONSchema?: unknown };
  if (
    schema === null ||
    typeof schema !== 'object' ||
    typeof schema.safeParse !== 'function' ||
    typeof schema.toJSONSchema !== 'function'
  ) {
    refuse(
      'schema must be a @insiderfinance/totalfinance/core/schema Schema (safeParse + toJSONSchema).',
      'definition.schema',
    );
  }
  // null is NOT omission: every optional member is validated whenever it is present.
  if (definition.outputSchema !== undefined) {
    requireJSONSchema('defineTool', 'definition.outputSchema', definition.outputSchema);
  }
  if (definition.mutates !== undefined && typeof definition.mutates !== 'boolean') {
    refuse('mutates must be a boolean when present.', 'definition.mutates');
  }
  if (
    definition.stochastic !== undefined &&
    typeof definition.stochastic !== 'boolean' &&
    typeof definition.stochastic !== 'function'
  ) {
    refuse('stochastic must be a boolean or a predicate when present.', 'definition.stochastic');
  }
  if (typeof definition.run !== 'function') {
    refuse('run must be a function.', 'definition.run');
  }
  const wrapped = {
    ...definition,
    run: (input: unknown): ToolResult => {
      const parsed = definition.schema.safeParse(input, { mode: 'strict' });
      if (!parsed.success) throw parsed.error;
      const result = definition.run(parsed.data);
      return {
        summary: result.summary,
        structured: jsonSafe(result.structured) as Record<string, unknown>,
      };
    },
  };
  return wrapped as unknown as TotalFinanceTool;
}
