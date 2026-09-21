import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, QuantError, type Computed } from '@totalfinance/core';
import {
  createMarketSnapshot,
  createScenarioSet,
  type MarketSnapshot,
  type ScenarioDefinition,
} from '@totalfinance/core/artifacts';
import {
  requireObservationValue,
  type MarketObservation,
  type MarketRequirement,
  type Pricer,
} from '@totalfinance/core/pricing';
import { taylorPnl } from '@totalfinance/risk';
import { runScenarios, scenarioTarget } from '../src/index.js';

const AS_OF = Date.UTC(2026, 7, 30);

function scenarioSet(scenarios: ScenarioDefinition[]) {
  return createScenarioSet({ name: 'integration', scenarios });
}

function market(
  observations: MarketSnapshot['observations'] = {},
  conventions: { dayCount?: 'ACT/365F'; compounding?: 'continuous' } = {},
) {
  return createMarketSnapshot({ asOf: AS_OF, conventions, observations });
}

function computed(value: number, extra: Record<string, unknown> = {}): Computed<number> {
  return {
    value,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION },
    diagnostics: { warnings: [] },
    ...extra,
  } as Computed<number>;
}

interface TestInstrument {
  symbol: string;
}

function observationPricer(
  input: {
    name?: string;
    randomness?: 'none' | 'seeded';
    calls?: string[];
    requirements?: (instrument: TestInstrument) => readonly MarketRequirement[];
    supports?: (instrument: TestInstrument) => boolean;
    price?: Pricer<TestInstrument>['price'];
  } = {},
): Pricer<TestInstrument> {
  return {
    name: input.name ?? 'test.observation',
    version: '1.0.0',
    capabilities: {
      greeks: 'none',
      randomness: input.randomness ?? 'none',
      batch: false,
    },
    supports: (instrument) => {
      input.calls?.push(`supports:${instrument.symbol}`);
      return input.supports?.(instrument) ?? true;
    },
    requirements: (instrument) => {
      input.calls?.push(`requirements:${instrument.symbol}`);
      return input.requirements?.(instrument) ?? [{ kind: 'spot', symbol: instrument.symbol }];
    },
    price:
      input.price ??
      ((priceInput) => {
        input.calls?.push(`price:${priceInput.instrument.symbol}`);
        return computed(
          requireObservationValue('test.observation.price', priceInput.observations, {
            kind: 'spot',
            symbol: priceInput.instrument.symbol,
          }),
        );
      }),
  };
}

function fullTarget(input: {
  id: string;
  symbol: string;
  quantity?: number;
  contractMultiplier?: number;
  currency?: string;
  pricer?: Pricer<TestInstrument>;
  underlying?: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}) {
  return scenarioTarget.fullRevaluation({
    id: input.id,
    quantity: input.quantity ?? 1,
    contractMultiplier: input.contractMultiplier ?? 1,
    currency: input.currency ?? 'USD',
    underlying: input.underlying ?? input.symbol,
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.book === undefined ? {} : { book: input.book }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    instrument: { symbol: input.symbol },
    instrumentDescriptor: { kind: 'test-instrument', symbol: input.symbol },
    pricer: input.pricer ?? observationPricer(),
  });
}

function successfulCell<T extends { status: string }>(cell: T): Extract<T, { status: 'complete' }> {
  expect(cell.status).toBe('complete');
  return cell as Extract<T, { status: 'complete' }>;
}

describe('runScenarios integration', () => {
  it('rejects oversized requirement lists before entry zero and never prices', () => {
    let slotReads = 0;
    const calls: string[] = [];
    const requirements = new Array(257);
    Object.defineProperty(requirements, '0', {
      enumerable: true,
      get() {
        slotReads++;
        throw new Error('must not read an oversized requirement slot');
      },
    });
    const target = fullTarget({
      id: 'oversized-requirements',
      symbol: 'AAPL',
      pricer: observationPricer({
        calls,
        requirements: () => requirements as readonly MarketRequirement[],
      }),
    });
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([{ name: 'baseline', shocks: [] }]),
        market: market({ spots: { AAPL: { price: 100, currency: 'USD' } } }),
        targets: [target],
      }),
    ).toThrow(/hard maximum is 256/);
    expect(slotReads).toBe(0);
    expect(calls).toEqual(['supports:AAPL', 'requirements:AAPL']);
  });

  it('rejects non-boolean supports answers without invoking coercion hooks', () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions++;
        throw new Error('must not coerce');
      },
      toJSON() {
        coercions++;
        throw new Error('must not serialize');
      },
      [Symbol.toPrimitive]() {
        coercions++;
        throw new Error('must not coerce');
      },
    };
    const target = fullTarget({
      id: 'hostile-supports',
      symbol: 'AAPL',
      pricer: observationPricer({ supports: () => hostile as unknown as boolean }),
    });
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([{ name: 'baseline', shocks: [] }]),
        market: market(),
        targets: [target],
      }),
    ).toThrow(/returned object from supports/);
    expect(coercions).toBe(0);
  });

  it('rejects a handler count expansion before visiting any returned slot', () => {
    let slotReads = 0;
    const result = new Array(2);
    Object.defineProperty(result, '0', {
      enumerable: true,
      get() {
        slotReads++;
        throw new Error('must not read an expanded handler result slot');
      },
    });
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([
          { name: 'custom', shocks: [{ factor: 'liquidity', kind: 'absolute', value: 1 }] },
        ]),
        market: market({ spots: { AAPL: { price: 100, currency: 'USD' } } }),
        targets: [fullTarget({ id: 'handler-shape', symbol: 'AAPL' })],
        options: {
          factorHandlers: [
            {
              factor: 'liquidity',
              name: 'test.expanding-handler',
              version: '1.0.0',
              apply: () => result as readonly MarketObservation[],
            },
          ],
        },
      }),
    ).toThrow(/changed observation count from 1 to 2/);
    expect(slotReads).toBe(0);
  });

  it('bounds requirement decorations and same-shape handler payloads before pricing', () => {
    const requirementCalls: string[] = [];
    const decoratedRequirement = {
      kind: 'spot',
      symbol: 'AAPL',
      decoration: { payload: 'x'.repeat(2_000_000) },
    } as unknown as MarketRequirement;
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([{ name: 'baseline', shocks: [] }]),
        market: market({ spots: { AAPL: { price: 100, currency: 'USD' } } }),
        targets: [
          fullTarget({
            id: 'decorated-requirement',
            symbol: 'AAPL',
            pricer: observationPricer({
              calls: requirementCalls,
              requirements: () => [decoratedRequirement],
            }),
          }),
        ],
        options: { maximumWorkUnits: 10_000 },
      }),
    ).toThrow(/data-work limit/);
    expect(requirementCalls).toEqual(['supports:AAPL', 'requirements:AAPL']);

    const handlerCalls: string[] = [];
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([
          { name: 'custom', shocks: [{ factor: 'liquidity', kind: 'absolute', value: 1 }] },
        ]),
        market: market({ spots: { AAPL: { price: 100, currency: 'USD' } } }),
        targets: [
          fullTarget({
            id: 'decorated-handler-result',
            symbol: 'AAPL',
            pricer: observationPricer({ calls: handlerCalls }),
          }),
        ],
        options: {
          factorHandlers: [
            {
              factor: 'liquidity',
              name: 'test.decorated-handler',
              version: '1.0.0',
              apply: ({ observations }) => [
                {
                  ...observations[0]!,
                  decoration: { payload: 'x'.repeat(2_000_000) },
                } as unknown as MarketObservation,
              ],
            },
          ],
        },
      }),
    ).toThrow(/data-work limit/);
    expect(handlerCalls).toEqual(['supports:AAPL', 'requirements:AAPL']);
  });

  it('revalues a spot target exactly and applies quantity/multiplier scaling once', () => {
    const result = runScenarios({
      scenarioSet: scenarioSet([
        { name: 'spot +10%', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100, currency: 'USD' } } }),
      targets: [
        fullTarget({
          id: 'aapl-options-contract',
          symbol: 'AAPL',
          quantity: -2,
          contractMultiplier: 100,
        }),
      ],
    });

    const base = successfulCell(result.base[0]!);
    const shocked = successfulCell(result.cells[0]!);
    expect(base.valuePerUnit).toBe(100);
    expect(base.positionValue).toBe(-20_000);
    expect(shocked.valuePerUnit).toBeCloseTo(110);
    expect(shocked.positionValue).toBeCloseTo(-22_000);
    expect(shocked.localPnl).toBeCloseTo(-2_000);
    expect(shocked.reportingPnl).toBeCloseTo(-2_000);
    expect(result.assumptions.tagAggregationPolicy).toBe(
      'overlapping-non-additive; grand total is target-based',
    );
    expect(shocked.valuationMethod).toBe('full-revaluation');
    if (shocked.valuationMethod !== 'full-revaluation') {
      throw new Error('expected full-revaluation cell');
    }
    expect(shocked.pricingResult.value).toBeCloseTo(110);
  });

  it('returns cells in stable scenario-major, then target-order layout', () => {
    const result = runScenarios({
      scenarioSet: scenarioSet([
        { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
        { name: 'down', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100 }, MSFT: { price: 200 } } }),
      targets: [
        scenarioTarget.spot({ id: 'aapl', symbol: 'AAPL', quantity: 1, currency: 'USD' }),
        scenarioTarget.spot({ id: 'msft', symbol: 'MSFT', quantity: 1, currency: 'USD' }),
      ],
    });

    expect(result.layout).toMatchObject({
      order: 'scenario-major-v1',
      targetCount: 2,
      scenarioCount: 2,
      cellsPerScenario: 2,
      cellCount: 4,
    });
    expect(result.cells.map((cell) => [cell.scenarioName, cell.targetId])).toEqual([
      ['up', 'aapl'],
      ['up', 'msft'],
      ['down', 'aapl'],
      ['down', 'msft'],
    ]);
    const values = result.cells.map((cell) => successfulCell(cell).valuePerUnit);
    expect(values[0]).toBeCloseTo(110);
    expect(values[1]).toBeCloseTo(220);
    expect(values[2]).toBeCloseTo(80);
    expect(values[3]).toBeCloseTo(160);
  });

  it('applies overrides before ordered shocks and retains lossless instruction evidence', () => {
    const result = runScenarios({
      scenarioSet: scenarioSet([
        {
          name: 'ordered',
          overrides: [{ factor: 'spot', target: 'AAPL', value: 120 }],
          shocks: [
            { factor: 'spot', target: 'AAPL', kind: 'percent', value: 0.1 },
            { factor: 'spot', target: 'AAPL', kind: 'absolute', value: -2 },
          ],
        },
      ]),
      market: market({ spots: { AAPL: { price: 100 } } }),
      targets: [scenarioTarget.spot({ id: 'aapl', symbol: 'AAPL', quantity: 1, currency: 'USD' })],
    });

    const cell = successfulCell(result.cells[0]!);
    expect(cell.valuePerUnit).toBeCloseTo(130);
    expect(
      cell.appliedInstructions.map(({ phase, instructionIndex }) => [phase, instructionIndex]),
    ).toEqual([
      ['override', 0],
      ['shock', 0],
      ['shock', 1],
    ]);
    expect(
      cell.appliedInstructions.map((row) => [
        row.detail,
        'before' in row ? row.before : null,
        'after' in row ? row.after : null,
      ]),
    ).toEqual([
      ['scalar', 100, 120],
      ['scalar', 120, 132],
      ['scalar', 132, 130],
    ]);
  });

  it('converts base and scenario values independently so an FX-only move produces reporting P&L', () => {
    const result = runScenarios({
      scenarioSet: scenarioSet([
        {
          name: 'EUR strengthens',
          shocks: [
            {
              factor: 'foreignExchangeRate',
              target: 'EUR/USD',
              kind: 'percent',
              value: 0.1,
            },
          ],
        },
      ]),
      market: market({ spots: { SAP: { price: 100, currency: 'EUR' } } }),
      targets: [scenarioTarget.spot({ id: 'sap', symbol: 'SAP', quantity: 2, currency: 'EUR' })],
      reportingCurrency: 'USD',
      currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 }],
    });

    const base = successfulCell(result.base[0]!);
    const cell = successfulCell(result.cells[0]!);
    expect(base.positionValue).toBe(200);
    expect(base.reportingPositionValue).toBeCloseTo(240);
    expect(cell.positionValue).toBe(200);
    expect(cell.localPnl).toBe(0);
    expect(cell.reportingPositionValue).toBeCloseTo(264);
    expect(cell.reportingPnl).toBeCloseTo(24);
    expect(cell.currencyConversion?.quote.quotePerBase).toBeCloseTo(1.32);
    expect(cell.appliedInstructions).toEqual([
      expect.objectContaining({
        factor: 'foreignExchangeRate',
        subject: 'EUR/USD',
        detail: 'foreign-exchange-rate',
        before: 1.2,
        after: 1.32,
      }),
    ]);
  });

  it('refuses any unmatched instruction before the first pricing call', () => {
    const calls: string[] = [];
    const target = fullTarget({ id: 'aapl', symbol: 'AAPL', pricer: observationPricer({ calls }) });

    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([
          { name: 'typo', shocks: [{ factor: 'volatiltiy', kind: 'absolute', value: 0.1 }] },
        ]),
        market: market({ spots: { AAPL: { price: 100 } } }),
        targets: [target],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ScenarioInstructionUnmatched }));
    expect(calls).toEqual(['supports:AAPL', 'requirements:AAPL']);
  });

  it('calls supports and requirements exactly once per target, in target order', () => {
    const calls: string[] = [];
    const pricer = observationPricer({ calls });
    runScenarios({
      scenarioSet: scenarioSet([
        { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100 }, MSFT: { price: 200 } } }),
      targets: [
        fullTarget({ id: 'aapl', symbol: 'AAPL', pricer }),
        fullTarget({ id: 'msft', symbol: 'MSFT', pricer }),
      ],
    });

    expect(calls).toEqual([
      'supports:AAPL',
      'requirements:AAPL',
      'supports:MSFT',
      'requirements:MSFT',
      'price:AAPL',
      'price:MSFT',
      'price:AAPL',
      'price:MSFT',
    ]);
  });

  it('runs one explicit custom factor handler and records its identity and hashes', () => {
    const result = runScenarios({
      scenarioSet: scenarioSet([
        {
          name: 'liquidity haircut',
          shocks: [{ factor: 'liquidityHaircut', kind: 'absolute', value: -5 }],
        },
      ]),
      market: market({ spots: { AAPL: { price: 100 } } }),
      targets: [scenarioTarget.spot({ id: 'aapl', symbol: 'AAPL', quantity: 1, currency: 'USD' })],
      options: {
        factorHandlers: [
          {
            factor: 'liquidityHaircut',
            name: 'test.liquidity-haircut',
            version: '1.0.0',
            apply: ({ instruction, observations }) =>
              observations.map((observation) =>
                observation.requirement.kind === 'spot'
                  ? { ...observation, value: (observation.value as number) + instruction.value }
                  : observation,
              ) as readonly MarketObservation[],
          },
        ],
      },
    });

    const cell = successfulCell(result.cells[0]!);
    expect(cell.valuePerUnit).toBe(95);
    expect(cell.factorHandlers).toEqual([{ name: 'test.liquidity-haircut', version: '1.0.0' }]);
    expect(cell.appliedInstructions).toEqual([
      expect.objectContaining({
        detail: 'custom',
        handler: { name: 'test.liquidity-haircut', version: '1.0.0' },
        beforeObservationsHash: expect.stringMatching(/^sha256:/),
        afterObservationsHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
  });

  it('uses one derived seed per target and common random numbers across base and scenarios', () => {
    const seeds: Array<[string, number | undefined]> = [];
    const seeded = observationPricer({
      randomness: 'seeded',
      requirements: () => [],
      price: ({ instrument, request }) => {
        seeds.push([instrument.symbol, request?.seed]);
        return computed(request!.seed!);
      },
    });
    const result = runScenarios({
      scenarioSet: scenarioSet([
        { name: 'first replay', shocks: [] },
        { name: 'second replay', shocks: [] },
      ]),
      market: market(),
      targets: [
        fullTarget({ id: 'first', symbol: 'FIRST', pricer: seeded }),
        fullTarget({ id: 'second', symbol: 'SECOND', pricer: seeded }),
      ],
      options: { seed: 41 },
    });

    expect(seeds).toEqual([
      ['FIRST', 41],
      ['SECOND', 42],
      ['FIRST', 41],
      ['SECOND', 42],
      ['FIRST', 41],
      ['SECOND', 42],
    ]);
    expect(result.assumptions.seedDerivation).toBe(
      'seed + targetIndex; common across base and scenarios',
    );
  });

  it('matches direct taylorPnl field-for-field and keeps the supplied base law explicit', () => {
    const target = scenarioTarget.taylor({
      id: 'delta-gamma',
      quantity: 3,
      contractMultiplier: 100,
      currency: 'USD',
      underlying: 'AAPL',
      baseValuePerUnit: 12,
      greeks: { delta: 0.5, gamma: 0.02, vega: 8 },
      factors: {
        spot: { subject: 'AAPL', level: 100 },
        volatility: { subject: 'AAPL', level: 0.2 },
      },
    });
    const definitions: ScenarioDefinition[] = [
      {
        name: 'up and vol',
        shocks: [
          { factor: 'spot', kind: 'absolute', value: 5 },
          { factor: 'volatility', kind: 'absolute', value: 0.03 },
        ],
      },
    ];
    const result = runScenarios({
      scenarioSet: scenarioSet(definitions),
      market: market({ spots: { AAPL: { price: 100 } }, volatilities: { AAPL: 0.2 } }),
      targets: [target],
    });
    const direct = taylorPnl(
      { value: 12, spot: 100, delta: 0.5, gamma: 0.02, vega: 8 },
      {
        name: 'up and vol',
        shocks: [
          { factor: 'spot', kind: 'absolute', value: 5 },
          { factor: 'volatility', kind: 'absolute', value: 0.03 },
        ],
      },
    );
    const base = successfulCell(result.base[0]!);
    const cell = successfulCell(result.cells[0]!);

    expect(base).toMatchObject({
      baseValueSource: 'supplied-base-value-per-unit',
      valuePerUnit: 12,
      positionValue: 3_600,
    });
    expect(cell.valuationMethod).toBe('taylor');
    if (cell.valuationMethod !== 'taylor') throw new Error('expected Taylor cell');
    expect(cell.taylorResult).toEqual(direct);
    expect(cell.valuePerUnit).toBeCloseTo(12 + direct.total);
    expect(cell.localPnl).toBeCloseTo(direct.total * 3 * 100);
  });

  it('collects a base failure, blocks its scenario cells, and makes affected totals incomplete', () => {
    const original = new QuantError('price feed unavailable', {
      code: 'test.price_unavailable',
      context: { venue: 'XNAS' },
    });
    const broken = observationPricer({
      price: () => {
        throw original;
      },
    });
    const result = runScenarios({
      scenarioSet: scenarioSet([
        { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100 } } }),
      targets: [fullTarget({ id: 'broken', symbol: 'AAPL', pricer: broken, strategy: 'growth' })],
      options: { failureMode: 'collect' },
    });

    expect(result.base[0]).toMatchObject({ status: 'failed', valuePerUnit: null });
    expect(result.cells[0]).toMatchObject({
      status: 'blocked',
      localPnl: null,
      blockedByBaseFailure: { code: 'test.price_unavailable', contextStatus: 'preserved' },
    });
    expect(result.diagnostics.failures).toHaveLength(1);
    expect(result.diagnostics.metrics.blockedCells.actual).toBe(1);
    const grandTotal = result.aggregates.scenarios[0]!.rows.find(
      (row) => row.group === 'grand-total',
    );
    expect(grandTotal).toMatchObject({
      status: 'incomplete',
      baseValue: null,
      scenarioValue: null,
      pnl: null,
      failedTargetIds: ['broken'],
    });
  });

  it('fail-fast wraps a cell failure and preserves the exact original cause', () => {
    const original = new Error('engine exploded');
    const broken = observationPricer({
      price: () => {
        throw original;
      },
    });
    let thrown: unknown;
    try {
      runScenarios({
        scenarioSet: scenarioSet([
          { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
        ]),
        market: market({ spots: { AAPL: { price: 100 } } }),
        targets: [fullTarget({ id: 'broken', symbol: 'AAPL', pricer: broken })],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(QuantError);
    expect((thrown as QuantError).code).toBe(ErrorCode.ScenarioCellFailed);
    expect((thrown as QuantError).cause).toBe(original);
  });

  it.each([
    ['non-finite', () => computed(Number.NaN)],
    [
      'non-canonical',
      () => ({
        value: 1,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
        calculate() {},
      }),
    ],
  ])('rejects a %s pricing result at the result boundary', (_label, resultFactory) => {
    const invalid = observationPricer({ price: resultFactory as Pricer<TestInstrument>['price'] });
    expect(() =>
      runScenarios({
        scenarioSet: scenarioSet([
          { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
        ]),
        market: market({ spots: { AAPL: { price: 100 } } }),
        targets: [fullTarget({ id: 'invalid', symbol: 'AAPL', pricer: invalid })],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ScenarioCellFailed }));
  });

  it('deeply freezes and detaches results from mutable pricer output', () => {
    const raw = {
      value: 100,
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, nested: { model: 'test' } },
      diagnostics: { warnings: [] as never[], detail: { source: 'fixture' } },
    };
    const pricer = observationPricer({ price: () => raw });
    const result = runScenarios({
      scenarioSet: scenarioSet([
        { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100 } } }),
      targets: [fullTarget({ id: 'aapl', symbol: 'AAPL', pricer })],
    });
    const base = successfulCell(result.base[0]!);
    expect(base.valuationMethod).toBe('full-revaluation');
    if (base.valuationMethod !== 'full-revaluation') throw new Error('expected full revaluation');

    expect(base.pricingResult).not.toBe(raw);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cells)).toBe(true);
    expect(Object.isFrozen(base.pricingResult)).toBe(true);
    expect(Object.isFrozen(base.pricingResult.assumptions)).toBe(true);
    expect(Object.isFrozen(base.pricingResult.diagnostics.warnings)).toBe(true);
    raw.assumptions.nested.model = 'mutated';
    expect((base.pricingResult.assumptions['nested'] as { model: string }).model).toBe('test');
  });

  it('rejects valuation-cell and total-work caps before pricing', () => {
    const calls: string[] = [];
    const target = fullTarget({ id: 'aapl', symbol: 'AAPL', pricer: observationPricer({ calls }) });
    const request = {
      scenarioSet: scenarioSet([
        { name: 'up', shocks: [{ factor: 'spot', kind: 'percent' as const, value: 0.1 }] },
      ]),
      market: market({ spots: { AAPL: { price: 100 } } }),
      targets: [target],
    };

    expect(() => runScenarios({ ...request, options: { maximumValuationCells: 1 } })).toThrow(
      /requires 2 valuation cells/,
    );
    expect(calls).toEqual([]);

    expect(() => runScenarios({ ...request, options: { maximumWorkUnits: 1 } })).toThrow(
      /work|bounded|limit/i,
    );
    expect(calls).toEqual([]);
  });
});
