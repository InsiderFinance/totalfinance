import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it, vi } from 'vitest';
import type { JSONSchema, Schema } from '@totalfinance/core/schema';
import type * as TradeWireCommon from '../src/trade-wire-common-schemas.js';
import {
  TradeOrderSchema,
  TradeIntentOrderSchema,
  GrantSchema,
} from '../src/trade-wire-schemas.js';
import { PortfolioEventEnvelopeSchema } from '../src/trade-wire-ledger-schemas.js';
import { grant } from './fixtures/store-values.js';

// Capture the actual builder output BEFORE transport wrapping, including operation-local
// schemas. Do not maintain a second field inventory or compare two compacted documents.
const originals = vi.hoisted(() => new Map<string, JSONSchema>());
vi.mock('../src/trade-wire-common-schemas.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TradeWireCommon>();
  return {
    ...actual,
    tradeInputSchema<T>(input: Schema<T>, resourceId: string): Schema<T> {
      originals.set(resourceId, input.toJSONSchema());
      return actual.tradeInputSchema(input, resourceId);
    },
    tradeSchemaDocument(document: JSONSchema, resourceId: string): JSONSchema {
      originals.set(resourceId, document);
      return actual.tradeSchemaDocument(document, resourceId);
    },
  };
});

import { createOperationRegistry, tradePack } from '../src/index.js';
import {
  PORTFOLIO_EVENT_SCHEMA_ID,
  tradeSchemaDocument,
} from '../src/trade-wire-common-schemas.js';

// Independent, pre-compaction normalization: the sole existing representation change was
// hoisting the recursive ledger resource and rebasing its self-reference.
function ledgerDocument(document: JSONSchema, resourceId: string): JSONSchema {
  let envelope: JSONSchema | undefined;
  const visit = (node: JSONSchema, inside = false): JSONSchema => {
    if (node.$id === PORTFOLIO_EVENT_SCHEMA_ID) {
      if (!envelope) {
        const { $id: _id, ...body } = node;
        envelope = visit(body, true);
      }
      return { $ref: '#/$defs/PortfolioEventEnvelope' };
    }
    if (inside && node['$ref'] === '#') return { $ref: '#/$defs/PortfolioEventEnvelope' };
    const copy = { ...node };
    if (node.properties)
      copy.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, value]) => [key, visit(value, inside)]),
      );
    if (node.items) copy.items = visit(node.items, inside);
    if (typeof node.additionalProperties === 'object')
      copy.additionalProperties = visit(node.additionalProperties, inside);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const)
      if (node[key]) copy[key] = node[key].map((value) => visit(value, inside));
    return copy;
  };
  return {
    ...visit(document),
    $id: `https://totalfinance.dev/schemas/${resourceId}`,
    ...(envelope ? { $defs: { PortfolioEventEnvelope: envelope } } : {}),
  };
}

function expand(document: JSONSchema, retained: readonly string[] = []): JSONSchema {
  const definitions = (document['$defs'] ?? {}) as Record<string, JSONSchema>;
  const visit = (value: unknown, stack: string[] = []): unknown => {
    if (Array.isArray(value)) return value.map((child) => visit(child, stack));
    if (value === null || typeof value !== 'object') return value;
    const node = value as JSONSchema;
    if (typeof node['$ref'] === 'string' && node['$ref'].startsWith('#/$defs/')) {
      const name = node['$ref'].slice('#/$defs/'.length);
      expect(definitions[name], `unresolved local reference ${name}`).toBeDefined();
      if (!retained.includes(name)) {
        expect(stack, `unexpected definition cycle ${name}`).not.toContain(name);
        expect(Object.keys(node)).toEqual(['$ref']);
        return visit(definitions[name], [...stack, name]);
      }
    }
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, visit(child, stack)]),
    );
  };
  const { $defs: _defs, ...body } = document;
  return {
    ...(visit(body) as JSONSchema),
    ...(retained.length
      ? { $defs: Object.fromEntries(retained.map((name) => [name, visit(definitions[name])])) }
      : {}),
  };
}

// Invert shared-header factoring independently: distribute the closed field map over the
// union and remove precisely the fields each branch forbids. Required is a set in JSON Schema.
function distribute(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(distribute);
  if (value === null || typeof value !== 'object') return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, distribute(child)]),
  ) as JSONSchema;
  const [shared, alternatives] = node.allOf ?? [];
  const keyword = alternatives?.anyOf ? 'anyOf' : 'oneOf';
  const branches = alternatives?.[keyword];
  if (
    node.allOf?.length === 2 &&
    shared?.type === 'object' &&
    shared.additionalProperties === false &&
    branches
  ) {
    const { allOf: _allOf, ...rest } = node;
    return {
      ...rest,
      [keyword]: branches.map((branch) => {
        const forbidden = ((branch['not'] as JSONSchema | undefined)?.anyOf ?? []).flatMap(
          (item) => item.required ?? [],
        );
        const properties = Object.fromEntries(
          Object.entries({ ...shared.properties, ...branch.properties }).filter(
            ([field]) => !forbidden.includes(field),
          ),
        );
        const required = [...(shared.required ?? []), ...(branch.required ?? [])].sort();
        return {
          type: 'object',
          properties,
          additionalProperties: false,
          ...(required.length ? { required } : {}),
        };
      }),
    };
  }
  if (node.required) node.required = [...node.required].sort();
  return node;
}

const documents = createOperationRegistry({ packs: [tradePack()] })
  .list()
  .flatMap((operation) =>
    (['input', 'output'] as const).map((direction) => ({
      id: `${operation.id.slice('totalfinance.'.length)}.${direction}`,
      document: direction === 'input' ? operation.inputSchema : operation.outputSchema,
    })),
  );

describe('bounded lossless trade schema documents (R14)', () => {
  it.each(documents)(
    '$id stays bounded with exact every-field/constraint parity',
    ({ id, document }) => {
      expect(document).toBeDefined();
      const original = originals.get(id);
      expect(original).toBeDefined();
      const baseline = ledgerDocument(original!, id);
      expect(
        distribute(expand(document!, Object.keys((baseline['$defs'] ?? {}) as object))),
      ).toEqual(distribute(baseline));
      // Preflight exposes BOTH plan + intent and full ledger/state + market alternatives. Keep
      // its remaining distinct grammar rather than shortening identifiers or removing fields.
      // 37,000 → 40,000 (2026-09-20, repairs B5): the intent and plan grammars gained combos
      // (comboId per order, the combo list with its legs and net limit) on both alternatives.
      expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(
        id === 'trade.preflight.input' ? 40_000 : 35_000,
      );
      expect(tradeSchemaDocument(original!, id)).toEqual(document);
    },
  );

  it.each(['market', 'market-on-open', 'market-on-close', 'limit', 'stop', 'stop-limit'])(
    '%s retains every forbidden/required price and sizing combination under AJV',
    (type) => {
      for (const [name, grammar] of [
        ['order', TradeOrderSchema],
        ['intent', TradeIntentOrderSchema],
      ] as const) {
        const original = grammar.toJSONSchema();
        const compact = tradeSchemaDocument(original, `test.${name}.${type}`);
        const before = new AjvJsonSchemaValidator().getValidator(original);
        const after = new AjvJsonSchemaValidator().getValidator(compact);
        for (const price of [
          {},
          { limitPrice: 10 },
          { stopPrice: 11 },
          { limitPrice: 10, stopPrice: 11 },
          { limitPrice: '10' },
        ]) {
          for (const sizing of [
            { quantity: 1 },
            { notionalWeight: 0.2 },
            { quantity: 1, notionalWeight: 0.2 },
            {},
          ]) {
            for (const extra of [{}, { unknownAuthority: true }]) {
              const value = {
                type,
                instrumentId: 'AAA',
                side: 'buy',
                ...sizing,
                ...price,
                ...extra,
                ...(name === 'order' ? { orderId: 'order', plannedTimestampMs: 1_000 } : {}),
              };
              expect(after(value).valid).toBe(before(value).valid);
            }
          }
        }
      }
    },
  );

  it('keeps authorization authority fields required, closed, and paper-only', () => {
    const document = tradeSchemaDocument(GrantSchema.toJSONSchema(), 'test.authority');
    const validate = new AjvJsonSchemaValidator().getValidator(document);
    const value = grant('authority');
    expect(validate(value).valid).toBe(true);
    for (const field of [
      'approvedBy',
      'mode',
      'planHash',
      'preflightHash',
      'portfolioHash',
      'marketHash',
      'accountId',
      'expiresAt',
      'idempotencyKeys',
    ]) {
      const copy = { ...value } as Record<string, unknown>;
      delete copy[field];
      expect(validate(copy).valid, field).toBe(false);
    }
    expect(validate({ ...value, approvedBy: '' }).valid).toBe(false);
    expect(validate({ ...value, mode: 'live' }).valid).toBe(false);
    expect(validate({ ...value, idempotencyKeys: [] }).valid).toBe(false);
    expect(validate({ ...value, admin: true }).valid).toBe(false);
    const authorization = documents.find(({ id }) => id === 'trade.authorize.input')!.document!;
    expect(authorization.required).toEqual(
      expect.arrayContaining([
        'approvedBy',
        'expiresAt',
        'now',
        'variance',
        'marketMaximumAgeMs',
        'idempotencyKeys',
      ]),
    );
  });

  it('validates recursive corrections and rejects mismatched event tags and missing original authority', () => {
    const document = tradeSchemaDocument(
      { type: 'array', items: PortfolioEventEnvelopeSchema.toJSONSchema() },
      'test.recursive-ledger',
    );
    const validateArray = new AjvJsonSchemaValidator().getValidator(document);
    const validate = (value: unknown) => validateArray([value]);
    const deposit = {
      eventId: 'deposit',
      schemaVersion: 1,
      sourceId: 'source',
      accountId: 'main',
      effectiveTimestampMs: 1_000,
      recordedTimestampMs: 1_000,
      provenance: {},
      eventType: 'cash.deposit',
      event: { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
    };
    const correction = {
      ...deposit,
      eventId: 'correction',
      eventType: 'admin.correction',
      reversesEventId: 'deposit',
      event: { eventType: 'admin.correction', original: deposit, replacement: deposit.event },
    };
    expect(validate(correction).valid).toBe(true);
    expect(
      validate({ ...correction, event: { ...correction.event, original: correction } }).valid,
    ).toBe(true);
    expect(validate({ ...deposit, eventType: 'cash.withdrawal' }).valid).toBe(false);
    expect(validate({ ...correction, reversesEventId: undefined }).valid).toBe(false);
    expect(
      validate({
        ...correction,
        event: { ...correction.event, original: { ...deposit, sourceId: undefined } },
      }).valid,
    ).toBe(false);
    const wrapper = new AjvJsonSchemaValidator().getValidator({
      $defs: { LedgerDocument: document },
      type: 'object',
      properties: { ledger: { $ref: '#/$defs/LedgerDocument' } },
      required: ['ledger'],
    });
    expect(wrapper({ ledger: [correction] }).valid).toBe(true);
    expect(wrapper({ ledger: [{ ...deposit, eventType: 'cash.withdrawal' }] }).valid).toBe(false);
  });

  it('preserves existing definitions, scoped resources, positional references, and caller-owned input', () => {
    const resource: JSONSchema = {
      $id: 'https://totalfinance.dev/schemas/test/embedded',
      type: 'object',
      properties: { value: { type: 'string' }, copy: { $ref: '#/properties/value' } },
    };
    const original: JSONSchema = {
      type: 'object',
      properties: { resource, first: { $ref: '#/$defs/Existing' } },
      $defs: { Existing: { type: 'string', minLength: 1 } },
    };
    const snapshot = JSON.stringify(original);
    const document = tradeSchemaDocument(original, 'test.resources');
    expect(document.properties!['resource']).toEqual(resource);
    expect(document['$defs']).toEqual(original['$defs']);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(tradeSchemaDocument(document, 'test.resources')).toEqual(document);
    const positional: JSONSchema = {
      type: 'object',
      properties: { value: { type: 'string' }, copy: { $ref: '#/properties/value' } },
    };
    expect(tradeSchemaDocument(positional, 'test.positional')).toEqual({
      ...positional,
      $id: 'https://totalfinance.dev/schemas/test.positional',
    });
  });

  it.each(documents)(
    '$id compiles standalone and embedded with local references',
    ({ document }) => {
      const validator = new AjvJsonSchemaValidator();
      expect(() => validator.getValidator(document!)).not.toThrow();
      expect(() =>
        validator.getValidator({
          type: 'object',
          properties: { structured: document! },
          required: ['structured'],
          additionalProperties: false,
        }),
      ).not.toThrow();
    },
  );

  it('retains descriptions, defaults, closed/open fields, union distinctions and deterministic readable names', () => {
    const exposure: JSONSchema = {
      type: 'object',
      description: 'Exposure in account currency, including caller annotations.',
      properties: {
        instrumentId: { type: 'string', minLength: 1 },
        amount: { type: 'number', minimum: 0 },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['instrumentId', 'amount'],
      additionalProperties: false,
    };
    const original: JSONSchema = {
      type: 'object',
      properties: {
        before: exposure,
        after: exposure,
        annotated: { ...exposure, default: { instrumentId: 'AAA', amount: 1 } },
        alternatives: { anyOf: [exposure, { ...exposure, required: ['instrumentId'] }] },
      },
      required: ['before', 'after'],
      additionalProperties: false,
    };
    const document = tradeSchemaDocument(original, 'test.exposure');
    expect(expand(document)).toEqual({ ...original, $id: document.$id });
    const names = Object.keys(document['$defs'] as object);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => /^[A-Z][A-Za-z0-9]*$/.test(name))).toBe(true);
    expect(JSON.stringify(document)).toContain('Before');
    const validator = new AjvJsonSchemaValidator();
    const prior = validator.getValidator(original);
    const compact = validator.getValidator(document);
    for (const amount of [1, -1, '1', undefined]) {
      for (const extra of [{}, { unknown: true }]) {
        const value = {
          before: { instrumentId: 'AAA', amount, ...extra },
          after: { instrumentId: 'BBB', amount: 2 },
        };
        expect(compact(value).valid).toBe(prior(value).valid);
      }
    }
  });
});
