/**
 * Phase 3B.0-R8 — the MCP tool contracts, canonically, and measured.
 *
 * The 23 tools an agent calls are a public contract that Phase 3B has to freeze, and they cannot be read
 * from declarations: a tool's schema is a runtime VALUE built at module load. The first version of this
 * file therefore guessed at private slots (`shape`, `fields`, `_shape`) and recorded top-level field
 * NAMES only.
 *
 * That guessing was wrong in a way worth stating plainly. `totalfinance.option.implied_volatility` records an
 * EMPTY input field list under it — while the schema's own public serializer reports eleven properties
 * and five required ones:
 *
 *   properties  asOf, dividendYield, expiry, fallback, method, price, riskFreeRate, spot, strike,
 *               timeToExpiryYears, type
 *   required    price, riskFreeRate, spot, strike, type
 *
 * `method` and `fallback` — the two fields that decide which solver runs and what happens when it fails —
 * were entirely invisible. So this module asks `schema.toJSONSchema()`, which is public API and exists
 * precisely for MCP tools, docs and adapters.
 *
 * It also MEASURES, on the same principle as the rest of 3B.0: a recorded schema says what a tool claims
 * to accept, and only execution says what it does. Each tool is called with an unknown key and with a
 * required field removed, and the observed outcome is recorded.
 */

import { createHash } from 'node:crypto';
import { defaultTools } from '@totalfinance/mcp';
import { isQuantError } from '@totalfinance/core';

/** A JSON Schema object, as far as this inventory needs to understand one. */
export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaNode;
  [key: string]: unknown;
}

export type McpVerdict = 'rejected' | 'untyped' | 'accepted' | 'unmeasured';

export interface McpProbe {
  mutation: 'unknown-key' | 'omit-required';
  field?: string;
  verdict: McpVerdict;
  code?: string;
}

export interface McpToolContract {
  /** The wire identity an agent calls. Stable, serialized, public API. */
  id: string;
  /** The canonical input JSON Schema, recursive, exactly as the tool publishes it. */
  inputSchema: JsonSchemaNode | null;
  /** The canonical output JSON Schema. */
  outputSchema: JsonSchemaNode | null;
  /** Content hashes, so a schema change is one line in a diff rather than a hundred. */
  inputSchemaHash: string | null;
  outputSchemaHash: string | null;
  /** Top-level input properties, sorted — a quick index into the schema above. */
  inputFields: string[];
  /** Declared REQUIRED input properties, sorted. Absent from the previous record entirely. */
  requiredInputFields: string[];
  /** Top-level output properties, sorted. */
  outputFields: string[];
  /** Does the schema admit undeclared properties? A `false` here is Law 12 stated in JSON Schema. */
  additionalPropertiesAllowed: boolean | null;
  /** What the tool DID when handed a mutated payload. */
  probes: McpProbe[];
}

/** Stable hash of a schema, key order normalized so formatting cannot change it. */
function schemaHash(schema: JsonSchemaNode): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(schema)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The canonical JSON Schema for a tool slot.
 *
 * Prefers the schema's own `toJSONSchema()` — public API, and the reason the private-slot guessing was
 * unnecessary as well as wrong. Falls back to a raw JSONSchema literal, which is how the output slots are
 * already written.
 */
function canonicalSchema(slot: unknown): JsonSchemaNode | null {
  if (slot === null || typeof slot !== 'object') return null;
  const asSchema = slot as { toJSONSchema?: () => unknown };
  if (typeof asSchema.toJSONSchema === 'function') {
    const serialized = asSchema.toJSONSchema();
    return serialized !== null && typeof serialized === 'object'
      ? (serialized as JsonSchemaNode)
      : null;
  }
  // A raw JSONSchema literal already IS the canonical form.
  const record = slot as JsonSchemaNode;
  return record.type !== undefined || record.properties !== undefined ? record : null;
}

/** A minimal payload satisfying the declared required properties, or `null` if one cannot be built. */
function minimalPayload(schema: JsonSchemaNode | null): Record<string, unknown> | null {
  if (!schema?.properties) return null;
  const required = schema.required ?? [];
  if (required.length === 0) return null;
  const payload: Record<string, unknown> = {};
  for (const name of required) {
    const property = schema.properties[name];
    if (!property) return null;
    const value = sampleFor(name, property);
    if (value === undefined) return null;
    payload[name] = value;
  }
  return payload;
}

/**
 * A plausible value for one schema property.
 *
 * Domain values keyed by NAME, same discipline as `contract-synthesis.ts`: a wrong guess costs coverage
 * (the baseline call fails, the tool is recorded `unmeasured`) and never a verdict.
 */
const SAMPLES: Readonly<Record<string, unknown>> = {
  spot: 100,
  strike: 100,
  forward: 100,
  price: 10,
  type: 'call',
  riskFreeRate: 0.05,
  dividendYield: 0,
  volatility: 0.2,
  impliedVolatility: 0.2,
  timeToExpiryYears: 0.25,
  markPrice: 100,
  indexPrice: 100,
  fundingRate: 0.0001,
  intervalHours: 8,
  future: 105,
  spread: 0.01,
  recovery: 0.4,
  confidence: 0.95,
  period: 14,
};

function sampleFor(name: string, property: JsonSchemaNode): unknown {
  // An enum tells us its own valid members; prefer that over any guess.
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
  // Then the domain value for this field NAME — a generic `1` for `spot` produces a technically valid
  // but financially degenerate call that several tools reject, costing measurable coverage.
  const named = SAMPLES[name];
  if (named !== undefined) return named;
  switch (property.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'string':
      return 'x';
    case 'boolean':
      return false;
    case 'array': {
      // Build elements from the ITEMS schema when there is one. A blanket `[1,2,3]` fails every tool
      // whose series is bars or trades, and a failed baseline costs measurement.
      const items = property.items;
      if (items?.type === 'object' && items.properties) {
        const element: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(items.properties)) {
          const value = sampleFor(key, sub);
          if (value !== undefined) element[key] = value;
        }
        return Array.from({ length: 40 }, () => ({ ...element }));
      }
      return Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 4) * 5);
    }
    case 'object': {
      if (property.properties) {
        const nested: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(property.properties)) {
          const value = sampleFor(key, sub);
          if (value !== undefined) nested[key] = value;
        }
        return nested;
      }
      return {};
    }
    default:
      return undefined;
  }
}

function observe(run: () => unknown): { verdict: McpVerdict; code?: string } {
  try {
    run();
  } catch (caught) {
    return isQuantError(caught)
      ? { verdict: 'rejected', code: caught.code }
      : { verdict: 'untyped' };
  }
  return { verdict: 'accepted' };
}

export function mcpToolContracts(): McpToolContract[] {
  return defaultTools()
    .map((tool) => {
      const record = tool as unknown as Record<string, unknown>;
      const id = String(record['name']);
      const inputSchema = canonicalSchema(record['schema'] ?? record['inputSchema']);
      const outputSchema = canonicalSchema(record['outputSchema']);
      const run = record['run'];

      const probes: McpProbe[] = [];
      // Build a payload from the DECLARED required set, then verify the baseline before mutating it —
      // the same rule the library harness uses, for the same reason: a probe cannot distinguish
      // "rejected my bad baseline" from "rejected the mutation".
      const payload = minimalPayload(inputSchema);
      if (typeof run === 'function' && payload) {
        const call = run as (input: unknown) => unknown;
        let baselineWorks = true;
        try {
          call({ ...payload });
        } catch {
          baselineWorks = false;
        }
        if (baselineWorks) {
          probes.push({
            mutation: 'unknown-key',
            ...observe(() => call({ ...payload, qzxBogusKey: 1 })),
          });
          for (const field of (inputSchema?.required ?? []).slice(0, 4)) {
            const broken = { ...payload };
            delete broken[field];
            probes.push({ mutation: 'omit-required', field, ...observe(() => call(broken)) });
          }
        } else {
          probes.push({ mutation: 'unknown-key', verdict: 'unmeasured' });
        }
      } else {
        probes.push({ mutation: 'unknown-key', verdict: 'unmeasured' });
      }

      const additional = inputSchema?.additionalProperties;
      return {
        id,
        inputSchema,
        outputSchema,
        inputSchemaHash: inputSchema ? schemaHash(inputSchema) : null,
        outputSchemaHash: outputSchema ? schemaHash(outputSchema) : null,
        inputFields: Object.keys(inputSchema?.properties ?? {}).sort(),
        requiredInputFields: [...(inputSchema?.required ?? [])].sort(),
        outputFields: Object.keys(outputSchema?.properties ?? {}).sort(),
        additionalPropertiesAllowed: typeof additional === 'boolean' ? additional : null,
        probes,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
