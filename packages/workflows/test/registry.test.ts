/**
 * Stage 7A slice 1 — the operation contract, the registry, and the runtime: one definition, one
 * validation grammar, one seed policy, one error shape; the twenty-three default operations (and the
 * opt-in backtest operation) re-homed from MCP without a schema of their own anywhere else.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { schema } from '@totalfinance/core/schema';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  OPERATION_ID,
  backtestPack,
  createOperationRegistry,
  defaultOperations,
  defaultPacks,
  defineOperation,
  describeOperation,
  operationAnnotations,
  WORKFLOWS_VERSION,
  capRows,
  extendObjectSchema,
  requireOperation,
  runOperation,
  toOperationError,
} from '@totalfinance/workflows';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const echo = defineOperation({
  id: 'totalfinance.test.echo',
  title: 'Echo',
  description: 'Returns its input.',
  inputSchema: schema.object({
    value: schema.number(),
    seed: schema.number().integer().optional(),
  }),
  outputSchema: { type: 'object', properties: { value: { type: 'number' } } },
  run: (input) => ({
    summary: `echo ${input.value}`,
    structured: { value: input.value, assumptions: { unit: 'x' } },
  }),
});

describe('defineOperation', () => {
  it('fills the read-only defaults and freezes the definition', () => {
    expect(echo.version).toBe('1');
    expect(echo.sideEffect).toBe('none');
    expect(echo.authorization).toBe('none');
    expect(echo.idempotency).toBe('not-applicable');
    expect(echo.deterministic).toBe(true);
    expect(echo.stochastic).toBe(false);
    expect(echo.costClass).toBe('small');
    expect(echo.supportsCancellation).toBe(false);
    expect(Object.isFrozen(echo)).toBe(true);
    expect(OPERATION_ID.test(echo.id)).toBe(true);
  });

  it('refuses a bad id, a bad version, an unknown key, and a deterministic-yet-stochastic declaration', () => {
    const base = {
      title: 't',
      description: 'd',
      inputSchema: schema.object({}),
      run: () => ({ summary: '', structured: {} }),
    };
    expect(codeOf(() => defineOperation({ ...base, id: 'option.price' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => defineOperation({ ...base, id: 'totalfinance.Option.Price' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(
      codeOf(() => defineOperation({ ...base, id: 'totalfinance.test.x', version: '0' })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() => defineOperation({ ...base, id: 'totalfinance.test.x', extra: 1 } as never)),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        defineOperation({
          ...base,
          id: 'totalfinance.test.x',
          deterministic: true,
          stochastic: true,
        }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        defineOperation({ ...base, id: 'totalfinance.test.x', costClass: 'huge' } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        defineOperation({ ...base, id: 'totalfinance.test.x', inputSchema: {} } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('derives annotations from the effect metadata, never from prose', () => {
    expect(operationAnnotations(echo)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const described = describeOperation(echo);
    expect(described.inputSchema.type).toBe('object');
    expect(described.stochastic).toBe(false);
    expect(described.annotations.readOnlyHint).toBe(true);
  });
});

describe('createOperationRegistry', () => {
  it('lists, describes, requires with a closest-id teaching, and runs', () => {
    const registry = createOperationRegistry({ operations: [echo] });
    expect(registry.size).toBe(1);
    expect(registry.list().map((d) => d.id)).toEqual(['totalfinance.test.echo']);
    expect(registry.get('totalfinance.test.echo')).toBe(echo);
    expect(registry.get('totalfinance.test.nope')).toBeNull();
    expect(codeOf(() => registry.require('totalfinance.test.ech'))).toBe(
      ErrorCode.OperationUnknown,
    );
    expect(() => registry.require('totalfinance.test.ech')).toThrow(
      /did you mean 'totalfinance.test.echo'/,
    );
    const result = registry.run({ id: 'totalfinance.test.echo', input: { value: 2 } });
    expect(result.structured).toEqual({ value: 2, assumptions: { unit: 'x' } });
    expect(result.operation).toEqual({ id: 'totalfinance.test.echo', version: '1' });
    expect(
      codeOf(() =>
        registry.run({ id: 'totalfinance.test.echo', input: { value: 2 }, extra: 1 } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('registers a side effect (execution is capability-gated), and refuses a duplicate id and a malformed pack at registration', () => {
    // Stage 7B.2 slice 4 (2026-09-06): the registry is effect-aware — a write registers like any
    // other operation and the RUNTIME refuses the call until the caller holds its capability.
    const writer = defineOperation({
      id: 'totalfinance.test.write',
      title: 'w',
      description: 'writes',
      inputSchema: schema.object({}),
      sideEffect: 'portfolio-state',
      authorization: 'policy',
      requiredCapabilities: ['portfolio:write'],
      run: () => ({ summary: 'wrote', structured: { wrote: true } }),
    });
    const writers = createOperationRegistry({ operations: [writer] });
    expect(writers.size).toBe(1);
    expect(writers.describe('totalfinance.test.write').annotations.readOnlyHint).toBe(false);
    expect(codeOf(() => writers.run({ id: 'totalfinance.test.write', input: {} }))).toBe(
      ErrorCode.OperationCapabilityMissing,
    );
    expect(
      writers.run({ id: 'totalfinance.test.write', input: {}, capabilities: ['portfolio:write'] })
        .structured,
    ).toEqual({ wrote: true });
    const twin = defineOperation({
      id: 'totalfinance.test.echo',
      title: 't',
      description: 'd',
      inputSchema: schema.object({}),
      run: () => ({ summary: '', structured: {} }),
    });
    expect(codeOf(() => createOperationRegistry({ operations: [echo, twin] }))).toBe(
      ErrorCode.OperationRegistrationRefused,
    );
    expect(
      codeOf(() =>
        createOperationRegistry({ packs: [{ name: 'p', operations: [echo], extra: 1 }] } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(createOperationRegistry({ operations: [echo, echo] }).size).toBe(1);
  });
});

describe('runOperation', () => {
  it('applies a byte budget only when asked, validates strictly with the schema’s own teaching error, and stamps identity/usage', () => {
    const big = { value: 1, pad: 'x'.repeat(200_000) };
    expect(codeOf(() => runOperation({ operation: echo, input: big }))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => runOperation({ operation: echo, input: big, maxInputBytes: 1024 }))).toBe(
      ErrorCode.OperationInputTooLarge,
    );
    expect(codeOf(() => runOperation({ operation: echo, input: { value: 'x' } }))).toBeDefined();
    expect(codeOf(() => runOperation({ operation: echo, input: {} }))).toBeDefined();
    const result = runOperation({ operation: echo, input: { value: 3 }, requestId: 'r-1' });
    expect(result.identity.inputsHash).toMatch(/^sha256:/);
    expect(result.usage.inputBytes).toBe(JSON.stringify({ value: 3 }).length);
    expect(result.trace.requestId).toBe('r-1');
    expect(result.diagnostics).toEqual({ warnings: [], status: 'complete', incomplete: [] });
    expect(result.assumptions).toEqual({ unit: 'x' });
    expect(
      codeOf(() => runOperation({ operation: echo, input: { value: 3 }, maxInputBytes: -1 })),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('seed policy: a stochastic call without a seed gets the default injected and echoed; a deterministic call never does', () => {
    const noisy = defineOperation({
      id: 'totalfinance.test.noisy',
      title: 'n',
      description: 'draws',
      inputSchema: schema.object({
        seed: schema.number().integer().optional(),
        method: schema.enum(['mc', 'exact']).optional(),
      }),
      deterministic: false,
      stochastic: (input) => (input.method ?? 'mc') === 'mc',
      run: (input, context) => ({
        summary: 's',
        structured: { seedSeen: context.seed, method: input.method ?? 'mc' },
      }),
    });
    const injected = runOperation({ operation: noisy, input: {}, defaultSeed: 7 });
    expect(injected.structured['seedSeen']).toBe(7);
    expect(injected.assumptions['seed']).toBe(7);
    const supplied = runOperation({ operation: noisy, input: { seed: 11 } });
    expect(supplied.assumptions['seed']).toBe(11);
    const exact = runOperation({ operation: noisy, input: { method: 'exact' }, defaultSeed: 7 });
    expect(exact.structured['seedSeen']).toBeNull();
    expect(exact.assumptions['seed']).toBeUndefined();
    expect(codeOf(() => runOperation({ operation: noisy, input: {}, defaultSeed: 1.5 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
  });

  it('reports a deadline post hoc, normalizes non-finite output to null, and maps errors to the one shape', () => {
    const slow = defineOperation({
      id: 'totalfinance.test.slow',
      title: 's',
      description: 'd',
      inputSchema: schema.object({}),
      run: () => ({ summary: 's', structured: { value: NaN, inf: Infinity } }),
    });
    const ticks = [0, 50];
    expect(
      codeOf(() =>
        runOperation({
          operation: slow,
          input: {},
          deadlineMs: 10,
          now: () => ticks.shift() ?? 50,
        }),
      ),
    ).toBe(ErrorCode.OperationDeadlineExceeded);
    const result = runOperation({ operation: slow, input: {} });
    expect(result.structured).toEqual({ value: null, inf: null });
    const mapped = toOperationError(new TypeError('boom'), slow);
    expect(mapped).toEqual({
      code: ErrorCode.OperationInternal,
      message: 'boom',
      context: {},
      operation: { id: 'totalfinance.test.slow', version: '1' },
    });
    try {
      runOperation({ operation: echo, input: { value: 'x' } });
    } catch (error) {
      const typed = toOperationError(error, echo);
      expect(typed.code).toBeDefined();
      expect(typed.operation).toEqual({ id: 'totalfinance.test.echo', version: '1' });
    }
  });
});

describe('every door is closed and typed (null is not omission)', () => {
  it('defineOperation, describeOperation, requireOperation, and the runtime refuse nulls, unknown keys, and mistyped members', () => {
    const base = {
      title: 't',
      description: 'd',
      inputSchema: schema.object({}),
      run: () => ({ summary: '', structured: {} }),
    };
    expect(
      codeOf(() =>
        defineOperation({ ...base, id: 'totalfinance.test.x', authorization: null } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        defineOperation({ ...base, id: 'totalfinance.test.x', costClass: null } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        defineOperation({
          ...base,
          id: 'totalfinance.test.x',
          requiredCapabilities: null,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        defineOperation({
          ...base,
          id: 'totalfinance.test.x',
          supportsCancellation: null,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => describeOperation({ ...echo, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => describeOperation({ ...echo, authorization: null } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    const { authorization: _dropped, ...partial } = echo;
    expect(codeOf(() => describeOperation(partial as never))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => requireOperation('t', 'operation', { ...echo, run: 'nope' }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => operationAnnotations({ ...echo, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(
      codeOf(() =>
        runOperation({ operation: echo, input: { value: 1 }, artifacts: null } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({ operation: echo, input: { value: 1 }, signal: { aborted: 'no' } } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() => runOperation({ operation: echo, input: { value: 1 }, requestId: '' })),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() => runOperation({ operation: echo, input: { value: 1 }, now: 5 } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({ operation: { ...echo, extra: 1 } as never, input: { value: 1 } }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => toOperationError(undefined, echo))).toBe(ErrorCode.InputMissingField);
    expect(codeOf(() => toOperationError(new Error('x'), { ...echo, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => capRows([1, 2], '', 'totalfinance.test.echo'))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => capRows([1, 2], 'rows', 'totalfinance.test.echo', 0))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => capRows('rows' as never, 'rows', 'totalfinance.test.echo'))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => extendObjectSchema({} as never, schema.object({})))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => extendObjectSchema(schema.object({}), undefined as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(capRows([1, 2], 'rows', 'totalfinance.test.echo', 2)).toEqual([1, 2]);
    // The output schema is a document: every declared keyword is typed at every depth.
    expect(codeOf(() => describeOperation({ ...echo, outputSchema: { $id: null } } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() => describeOperation({ ...echo, outputSchema: { const: null } } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        describeOperation({
          ...echo,
          outputSchema: { properties: { x: { default: null } } },
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() => describeOperation({ ...echo, outputSchema: { allOf: 'x' } } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        describeOperation({
          ...echo,
          outputSchema: { properties: { x: { type: 'nope' } } },
        } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        describeOperation({ ...echo, outputSchema: { items: { minimum: Number.NaN } } } as never),
      ),
    ).toBe(ErrorCode.InputNotFinite);
    expect(
      codeOf(() =>
        defineOperation({
          ...base,
          id: 'totalfinance.test.x',
          outputSchema: { additionalProperties: null },
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        toOperationError(new Error('x'), { ...echo, outputSchema: { required: [1] } } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(() =>
      describeOperation({
        ...echo,
        outputSchema: {
          type: ['object', 'null'],
          properties: { x: { type: 'number', 'x-vendor': 1 } },
          additionalProperties: false,
        },
      }),
    ).not.toThrow();
  });
});

describe('createOperationRegistry({}) — both members omitted', () => {
  it('is the curated default set — the same default the MCP server ships; an empty list is empty', () => {
    const registry = createOperationRegistry({});
    expect(registry.size).toBe(defaultOperations().length);
    expect(createOperationRegistry({ operations: [] }).size).toBe(0);
    expect(createOperationRegistry({ packs: [] }).size).toBe(0);
    expect(
      registry.run({
        id: 'totalfinance.option.price',
        input: {
          type: 'call',
          spot: 100,
          strike: 105,
          timeToExpiryYears: 0.25,
          riskFreeRate: 0.04,
          volatility: 0.2,
        },
      }).structured['value'],
    ).toBeGreaterThan(0);
  });
});

describe('extendObjectSchema composes like a plain object schema', () => {
  it('nests inside schema.array / schema.object and keeps exact issue paths', () => {
    const quote = extendObjectSchema(
      schema.object({ price: schema.number() }),
      schema.object({ delta: schema.number().optional() }),
    );
    const rows = schema.object({ quotes: schema.array(quote) });
    expect(rows.parse({ quotes: [{ price: 1, delta: 0.5 }, { price: 2 }] })).toEqual({
      quotes: [{ price: 1, delta: 0.5 }, { price: 2 }],
    });
    const failed = rows.safeParse({ quotes: [{ price: 1 }, { price: 'x', delta: 0.5 }] });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.issues.map((issue) => issue.path.join('.'))).toEqual(['quotes.1.price']);
    }
    expect(codeOf(() => rows.parse({ quotes: [{ price: 1, extra: 1 }] }))).toBe(
      ErrorCode.InputUnknownField,
    );
  });
});

describe('the version constant', () => {
  it('equals the package.json version (a browser-safe package reads no file at runtime)', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(WORKFLOWS_VERSION).toBe(manifest.version);
    expect(runOperation({ operation: echo, input: { value: 1 } }).library.version).toBe(
      manifest.version,
    );
  });
});

describe('the curated set', () => {
  it('re-homes the twenty-three default operations and the opt-in backtest with ids in the wire grammar', () => {
    const operations = defaultOperations();
    expect(operations).toHaveLength(23);
    expect(defaultPacks().map((p) => p.name)).toEqual([
      'options',
      'technical_analysis',
      'strategy',
      'volatility',
      'structure',
      'risk',
      'performance',
      'calendar',
      'crypto',
      'fixed_income',
    ]);
    expect(backtestPack().operations.map((o) => o.id)).toEqual([
      'totalfinance.backtest.vectorized_run',
      'totalfinance.backtest.options_run',
      'totalfinance.backtest.cross_sectional_run',
      'totalfinance.backtest.portfolio_run',
      'totalfinance.backtest.environment_episode',
    ]);
    for (const operation of [...operations, ...backtestPack().operations]) {
      expect(OPERATION_ID.test(operation.id)).toBe(true);
      expect(operation.sideEffect).toBe('none');
      expect(describeOperation(operation).inputSchema.type).toBe('object');
    }
    const registry = createOperationRegistry({ packs: defaultPacks() });
    expect(registry.size).toBe(23);
  });

  it('runs an option price through the registry and matches the direct pricer exactly', () => {
    const registry = createOperationRegistry({ packs: defaultPacks() });
    const result = registry.run({
      id: 'totalfinance.option.price',
      input: {
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 0.25,
        riskFreeRate: 0.04,
        volatility: 0.2,
      },
      maxInputBytes: 65_536,
    });
    expect(result.structured['value']).toBe(
      blackScholesPrice({
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 0.25,
        riskFreeRate: 0.04,
        dividendYield: 0,
        volatility: 0.2,
      }),
    );
    expect(result.assumptions['model']).toBe('black-scholes-merton');
  });
});
