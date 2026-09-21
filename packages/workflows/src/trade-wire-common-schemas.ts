import {
  schema,
  type Schema,
  type OptionalSchema,
  type SchemaCheckContext,
  type JSONSchema,
} from '@totalfinance/core/schema';
import { InputError, type Provenance, type QuantWarning } from '@totalfinance/core';
import type { DerivativeContractTerms } from '@totalfinance/portfolio';

/** Require all domain keys, including optional ones, and their declared value types. */
export type Shape<T> = { [K in keyof T]-?: Schema<T[K]> };

export const PORTFOLIO_EVENT_SCHEMA_ID =
  'https://totalfinance.dev/schemas/trade/portfolio-event-envelope';

/** Visit only schema-bearing facade keywords, never schema-shaped default/const/vendor data. */
function mapSchemaChildren(
  node: JSONSchema,
  visit: (child: JSONSchema, name: string) => JSONSchema,
  name: string,
): JSONSchema {
  const result = { ...node };
  for (const key of ['properties', '$defs', 'patternProperties', 'dependentSchemas'] as const) {
    const children = node[key] as Record<string, JSONSchema> | undefined;
    if (children)
      result[key] = Object.fromEntries(
        Object.entries(children).map(([field, child]) => [field, visit(child, field)]),
      );
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const)
    if (node[key]) result[key] = node[key].map((child) => visit(child, name));
  for (const key of [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
  ] as const) {
    const child = node[key];
    if (child && typeof child === 'object' && !Array.isArray(child))
      result[key] = visit(child as JSONSchema, name);
  }
  return result;
}

/** Distribute a closed object union's identical headers out of its branches. The shared
 * object still closes the complete field set, and each branch explicitly forbids fields
 * that belonged only to other variants. No unevaluatedProperties or $ref siblings needed.
 * This is A∧B | A∧C -> A∧(B | C), also preserving oneOf's exact match count.
 */
function factorObjectUnions(node: JSONSchema): JSONSchema {
  if (/"\$(?:id|anchor|dynamicAnchor|dynamicRef)":/.test(JSON.stringify(node))) return node;
  const result = mapSchemaChildren(node, factorObjectUnions, '');
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = result[keyword];
    if (!branches || branches.length < 2 || result.allOf) continue;
    if (
      !branches.every(
        (branch) =>
          branch.type === 'object' &&
          branch.properties &&
          branch.additionalProperties === false &&
          Object.keys(branch).every((key) =>
            ['type', 'properties', 'required', 'additionalProperties'].includes(key),
          ),
      )
    )
      continue;
    const fields = [...new Set(branches.flatMap((branch) => Object.keys(branch.properties!)))];
    const common = fields.filter((field) =>
      branches.every(
        (branch) =>
          Object.hasOwn(branch.properties!, field) &&
          JSON.stringify(branch.properties![field]) ===
            JSON.stringify(branches[0]!.properties![field]),
      ),
    );
    if (!common.length) continue;
    const required = (branches[0]!.required ?? []).filter((field) =>
      branches.every((branch) => branch.required?.includes(field)),
    );
    const shared: JSONSchema = {
      type: 'object',
      properties: Object.fromEntries(
        fields.map((field) => [
          field,
          common.includes(field) ? branches[0]!.properties![field]! : {},
        ]),
      ),
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
    const variants = branches.map((branch): JSONSchema => {
      const forbidden = fields.filter((field) => !Object.hasOwn(branch.properties!, field));
      const remaining = (branch.required ?? []).filter((field) => !required.includes(field));
      return {
        properties: Object.fromEntries(
          Object.entries(branch.properties!).filter(([field]) => !common.includes(field)),
        ),
        ...(remaining.length ? { required: remaining } : {}),
        ...(forbidden.length
          ? { not: { anyOf: forbidden.map((field) => ({ required: [field] })) } }
          : {}),
      };
    });
    const factored: JSONSchema = { allOf: [shared, { [keyword]: variants }] };
    if (JSON.stringify(factored).length + 256 < JSON.stringify({ [keyword]: branches }).length) {
      delete result[keyword];
      result.allOf = factored.allOf!;
    }
  }
  return result;
}

/** Intern exact repeated complex schemas, without changing their grammar or annotations.
 * Names come from domain kind discriminants or field names; scalars remain legible inline.
 * Unknown resource/anchor scopes and non-definition local pointers are deliberately left alone.
 */
function compactTradeDocument(document: JSONSchema): JSONSchema {
  const fingerprints = new WeakMap<JSONSchema, string>();
  const fingerprint = (node: JSONSchema): string => {
    let value = fingerprints.get(node);
    if (value === undefined) {
      value = JSON.stringify(node);
      fingerprints.set(node, value);
    }
    return value;
  };
  const candidates = new Map<string, { count: number; name: string }>();
  let hasPositionalReference = false;
  const inspect = (node: JSONSchema, name: string, root = false): JSONSchema => {
    if (!root && node.$id) return node;
    const reference = node['$ref'];
    if (
      typeof reference === 'string' &&
      reference.startsWith('#') &&
      !/^#\/\$defs\/[^/]+$/.test(reference)
    )
      hasPositionalReference = true;
    const key = fingerprint(node);
    if (
      !root &&
      key.length >= 128 &&
      (node.properties ||
        node.anyOf ||
        node.oneOf ||
        node.allOf ||
        node.items ||
        node.enum ||
        typeof node.additionalProperties === 'object') &&
      !/"\$(?:id|anchor|dynamicAnchor|dynamicRef)":/.test(key)
    ) {
      const prior = candidates.get(key);
      const kind = node.properties?.['kind']?.const ?? node.properties?.['eventType']?.const;
      const label = typeof kind === 'string' ? kind.replace(/^totalfinance\./, '') : name;
      if (prior) prior.count += 1;
      else
        candidates.set(key, {
          count: 1,
          name: label.replace(/(?:^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, letter: string) =>
            letter.toUpperCase(),
          ),
        });
    }
    mapSchemaChildren(node, (child, field) => inspect(child, field), name);
    return node;
  };
  // Preserve pointer targets before factoring, too. In trade documents the only recursive
  // reference is to the retained PortfolioEventEnvelope definition.
  inspect(document, 'Document', true);
  // Moving a target of #/properties/... would invalidate that pointer. These are not emitted
  // by the trade facade; fail conservatively if a future builder introduces one.
  if (hasPositionalReference) return document;

  const { $id: resourceId, ...unscoped } = document;
  document = { ...factorObjectUnions(unscoped), ...(resourceId ? { $id: resourceId } : {}) };
  candidates.clear();
  inspect(document, 'Document', true);

  const existing = (document['$defs'] ?? {}) as Record<string, JSONSchema>;
  const definitions: Record<string, JSONSchema> = { ...existing };
  const names = new Map<string, string>();
  const uses = new Map<string, number>();
  const rewrite = (node: JSONSchema, hint: string, inline = false): JSONSchema => {
    if (node.$id && !inline) return node;
    const key = fingerprint(node);
    const candidate = candidates.get(key);
    if (!inline && candidate && candidate.count > 1) {
      let name = names.get(key);
      if (!name) {
        const base = /^[A-Z]/.test(candidate.name) ? candidate.name : `Field${candidate.name}`;
        name = base;
        for (let suffix = 2; Object.hasOwn(definitions, name); suffix += 1)
          name = `${base}${suffix}`;
        names.set(key, name);
        definitions[name] = {};
        definitions[name] = rewrite(node, hint, true);
      }
      uses.set(name, (uses.get(name) ?? 0) + 1);
      return { $ref: `#/$defs/${name}` };
    }
    return mapSchemaChildren(node, (child, field) => rewrite(child, field), hint);
  };
  const { $defs: _defs, ...body } = document;
  const result = rewrite(body, 'Document', true);
  for (const [name, value] of Object.entries(existing))
    definitions[name] = value.$id ? value : rewrite(value, name, true);

  // A child repeated only inside a repeated parent now occurs once. Inline those definitions
  // again: a local reference plus a one-use definition would increase discovery cost.
  const trim = (node: JSONSchema): JSONSchema => {
    const reference = node['$ref'];
    if (typeof reference === 'string' && reference.startsWith('#/$defs/')) {
      const name = reference.slice('#/$defs/'.length);
      if (uses.get(name) === 1) return trim(definitions[name]!);
    }
    if (node.$id) return node;
    return mapSchemaChildren(node, trim, '');
  };
  const retained = Object.fromEntries(
    Object.entries(definitions)
      .filter(([name]) => uses.get(name) !== 1)
      .map(([name, value]) => [name, trim(value)]),
  );
  const { $id, ...resultBody } = result;
  return {
    ...trim(resultBody),
    ...($id ? { $id } : {}),
    ...(Object.keys(retained).length ? { $defs: retained } : {}),
  };
}

/** Hoist the recursive ledger resource once per transport document. Inlining it twice (e.g.
 * ledger + record_events) repeats $id and makes standards-compliant validators reject the schema.
 * A root $id gives local $defs the same scope standalone and embedded in OpenAPI components.
 */
export function tradeSchemaDocument(document: JSONSchema, resourceId: string): JSONSchema {
  let envelope: JSONSchema | undefined;
  const reference = '#/$defs/PortfolioEventEnvelope';
  const visit = (node: JSONSchema, insideEnvelope = false): JSONSchema => {
    if (node.$id === PORTFOLIO_EVENT_SCHEMA_ID) {
      if (envelope === undefined) {
        const { $id: _id, ...body } = node;
        envelope = visit(body, true);
      }
      return { $ref: reference };
    }
    if (insideEnvelope && node['$ref'] === '#') return { $ref: reference };
    return mapSchemaChildren(node, (child) => visit(child, insideEnvelope), '');
  };
  const result = visit(document);
  return compactTradeDocument({
    ...result,
    $id: `https://totalfinance.dev/schemas/${resourceId}`,
    ...(envelope
      ? { $defs: { ...(result['$defs'] as object), PortfolioEventEnvelope: envelope } }
      : {}),
  });
}

export function tradeInputSchema<T>(input: Schema<T>, resourceId: string): Schema<T> {
  const document = tradeSchemaDocument(input.toJSONSchema(), resourceId);
  return Object.assign(input, { toJSONSchema: () => document });
}

/** A domain-door leaf in the existing facade. `_check` is its composition hook, so this
 * works in arrays/unions/optionals too (overriding only safeParse would silently bypass it).
 * The published grammar is built with the facade; the domain owns semantic checks and teaching.
 * Also permits the ledger's recursive admin.original grammar without a second ledger validator.
 */
type DomainSchema<T> = Omit<Schema<T>, 'optional'> & { optional(): OptionalSchema<T> };
export function domainWireSchema<T>(
  grammar: () => JSONSchema,
  requireValue: (input: unknown) => T,
  structure?: Schema<unknown>,
): DomainSchema<T> {
  return Object.assign(schema.unknown(), {
    _check(input: unknown, context: SchemaCheckContext) {
      try {
        // Domain teaching wins (e.g. missing limitPrice), then the same published structural
        // grammar checks nested fields the door may only inspect shallowly. Return the domain
        // value, preserving declared-open metadata and the door's normalization/freezing.
        const value = requireValue(input);
        structure?.parse(value, { mode: context.mode });
        return { ok: true as const, value };
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        return {
          ok: false as const,
          issues: [{ code: error.code, message: error.message, path: [...context.path] }],
        };
      }
    },
    _toJSONSchema: grammar,
  }) as DomainSchema<T>;
}
const str = schema.string();
const id = str.min(1);
const epoch = schema.number().describe('Epoch milliseconds');
export const WarningSchema = schema.object({
  code: id,
  message: str,
  severity: schema.enum(['info', 'warn', 'error'] as const),
  context: schema.record(schema.unknown()).optional(),
} satisfies Shape<QuantWarning>);
export const TradeProvenanceSchema = schema.object({
  provider: str.optional(),
  dataset: str.optional(),
  asOf: epoch.optional(),
  receivedAt: epoch.optional(),
  sourceVersion: str.optional(),
  requestId: str.optional(),
  warnings: schema.array(WarningSchema).optional(),
} satisfies Shape<Provenance>);
export const ContractSchema = schema.union([
  schema.object({
    kind: schema.literal('option'),
    underlyingInstrumentId: id,
    type: schema.enum(['call', 'put'] as const),
    strikePricePerUnit: schema.number(),
    expiryTimestampMs: epoch,
  } satisfies Shape<Extract<DerivativeContractTerms, { kind: 'option' }>>),
  schema.object({
    kind: schema.literal('future'),
    underlyingInstrumentId: id,
    expiryTimestampMs: epoch,
  } satisfies Shape<Extract<DerivativeContractTerms, { kind: 'future' }>>),
  schema.object({ kind: schema.literal('perpetual'), underlyingInstrumentId: id } satisfies Shape<
    Extract<DerivativeContractTerms, { kind: 'perpetual' }>
  >),
]);
