import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, type Computed } from '@totalfinance/core';
import type { ScenarioSet } from '@totalfinance/core/artifacts';
import type { Pricer } from '@totalfinance/core/pricing';
import { scenarioTarget } from '../src/targets.js';
import type { RunScenariosInput } from '../src/types.js';
import {
  DEFAULT_MAXIMUM_VALUATION_CELLS,
  DEFAULT_MAXIMUM_WORK_UNITS,
  HARD_MAXIMUM_VALUATION_CELLS,
  MAXIMUM_CURRENCY_QUOTES,
  estimateBarrierB,
  runBarrierA,
} from '../src/work.js';

function scenarioSet(scenarios: ScenarioSet['scenarios'] = []): ScenarioSet {
  return {
    kind: 'totalfinance.scenario-set',
    schemaVersion: 1,
    name: 'test-set',
    scenarios,
  };
}

function inputWith(
  targets: RunScenariosInput['targets'],
  scenarios: ScenarioSet['scenarios'] = [],
  extra: Partial<RunScenariosInput> = {},
): RunScenariosInput {
  return {
    scenarioSet: scenarioSet(scenarios),
    market: {
      kind: 'totalfinance.market-snapshot',
      schemaVersion: 1,
      asOf: 1_786_915_200_000,
      observations: {},
    } as unknown as RunScenariosInput['market'],
    targets,
    ...extra,
  };
}

function spyPricer(calls: string[]): Pricer<{ symbol: string }> {
  return {
    name: 'test.spy',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: ({ symbol }) => {
      calls.push(`supports:${symbol}`);
      return true;
    },
    requirements: ({ symbol }) => {
      calls.push(`requirements:${symbol}`);
      return [{ kind: 'spot', symbol }];
    },
    price: ({ instrument }) => {
      calls.push(`price:${instrument.symbol}`);
      return {
        value: 1,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      } satisfies Computed<number>;
    },
  };
}

function fullTarget(calls: string[] = []) {
  return scenarioTarget.fullRevaluation({
    id: 'aapl',
    quantity: 1,
    contractMultiplier: 1,
    currency: 'USD',
    underlying: 'AAPL',
    instrument: { symbol: 'AAPL' },
    instrumentDescriptor: { kind: 'equity', symbol: 'AAPL' },
    pricer: spyPricer(calls),
  });
}

describe('Stage 4.4b work barriers', () => {
  it('applies the public defaults and counts the complete base-plus-scenario grid', () => {
    const result = runBarrierA(
      inputWith(
        [fullTarget()],
        [
          { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
          { name: 'down', shocks: [{ factor: 'spot', kind: 'percent', value: -0.1 }] },
        ],
      ),
    );

    expect(result).toMatchObject({
      targetCount: 1,
      scenarioCount: 2,
      valuationCells: 3,
      maximumValuationCells: DEFAULT_MAXIMUM_VALUATION_CELLS,
      maximumWorkUnits: DEFAULT_MAXIMUM_WORK_UNITS,
      failureMode: 'fail-fast',
      seed: null,
    });
    expect(result.inputDataWorkUnits).toBeGreaterThan(0);
  });

  it('rejects the valuation-cell cap before pricer, resolver, or handler behavior', () => {
    const calls: string[] = [];
    const resolve = () => {
      calls.push('resolve');
      return undefined;
    };
    const apply = () => {
      calls.push('apply');
      return undefined;
    };

    expect(() =>
      runBarrierA(
        inputWith(
          [fullTarget(calls)],
          [{ name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] }],
          {
            options: {
              maximumValuationCells: 1,
              marketResolvers: [{ name: 'test.resolver', version: '1', resolve }],
              factorHandlers: [
                { factor: 'custom-factor', name: 'test.handler', version: '1', apply },
              ],
            },
          },
        ),
      ),
    ).toThrow(/requires 2 valuation cells.*configured maximum 1/);
    expect(calls).toEqual([]);
  });

  it('enforces option and quote hard caps with teaching errors', () => {
    const target = fullTarget();
    expect(() =>
      runBarrierA(
        inputWith([target], [], {
          options: { maximumValuationCells: HARD_MAXIMUM_VALUATION_CELLS + 1 },
        }),
      ),
    ).toThrow(/hard maximum 50000/);

    const quotes = Array.from({ length: MAXIMUM_CURRENCY_QUOTES + 1 }, () => ({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: 1.1,
    }));
    expect(() =>
      runBarrierA(
        inputWith([target], [], {
          currencyConversions: quotes,
        } as unknown as Partial<RunScenariosInput>),
      ),
    ).toThrow(/at most 256 quotes/);
  });

  it('rejects oversized quote and behavior panels before visiting any array slot', () => {
    const target = fullTarget();
    let slotReads = 0;
    const oversizedQuotes = new Array(MAXIMUM_CURRENCY_QUOTES + 1);
    Object.defineProperty(oversizedQuotes, '0', {
      enumerable: true,
      get() {
        slotReads++;
        throw new Error('must not read an oversized quote slot');
      },
    });
    expect(() =>
      runBarrierA(
        inputWith([target], [], {
          currencyConversions: oversizedQuotes,
        } as unknown as Partial<RunScenariosInput>),
      ),
    ).toThrow(/at most 256 quotes/);

    for (const optionKey of ['marketResolvers', 'factorHandlers'] as const) {
      const oversizedBehaviors = new Array(33);
      Object.defineProperty(oversizedBehaviors, '0', {
        enumerable: true,
        get() {
          slotReads++;
          throw new Error('must not read an oversized behavior slot');
        },
      });
      expect(() =>
        runBarrierA(
          inputWith([target], [], {
            options: { [optionKey]: oversizedBehaviors },
          } as unknown as Partial<RunScenariosInput>),
        ),
      ).toThrow(/may contain at most 32/);
    }
    expect(slotReads).toBe(0);
  });

  it('uses one cumulative Barrier-A data allowance and never reaches later inputs after exhaustion', () => {
    let marketOwnKeyVisits = 0;
    const untouchedMarket = new Proxy(
      {},
      {
        ownKeys() {
          marketOwnKeyVisits++;
          return [];
        },
      },
    );
    expect(() =>
      runBarrierA({
        ...inputWith([fullTarget()]),
        market: untouchedMarket as RunScenariosInput['market'],
        options: { maximumWorkUnits: 100 },
        // The first scanner input alone exhausts floor((100 - supports) / 6).
        // Keeping it in provenance avoids any Gate-B reader before the bounded scan.
        scenarioSet: {
          ...scenarioSet([]),
          provenance: { dataset: 'x'.repeat(4_096) },
        },
      }),
    ).toThrow(/data-work limit/);
    expect(marketOwnKeyVisits).toBe(0);
  });

  it('reports malformed options without invoking coercion or serialization hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON() {
        calls++;
        throw new Error('must not serialize');
      },
      toString() {
        calls++;
        throw new Error('must not coerce');
      },
      [Symbol.toPrimitive]() {
        calls++;
        throw new Error('must not coerce');
      },
    };
    expect(() =>
      runBarrierA(
        inputWith([fullTarget()], [], {
          options: { failureMode: hostile },
        } as unknown as Partial<RunScenariosInput>),
      ),
    ).toThrow(/failureMode.*received object/);
    expect(calls).toBe(0);
  });

  it('does not treat null as omission for an optional run option', () => {
    expect(() =>
      runBarrierA(
        inputWith([fullTarget()], [], {
          options: { failureMode: null },
        } as unknown as Partial<RunScenariosInput>),
      ),
    ).toThrow(/failureMode.*received null/);
  });

  it('stops a data scan at the configured work budget before any pricer behavior', () => {
    const calls: string[] = [];
    expect(() =>
      runBarrierA(
        inputWith([fullTarget(calls)], [], {
          options: { maximumWorkUnits: 1 },
        }),
      ),
    ).toThrow(/data-work limit/);
    expect(calls).toEqual([]);
  });

  it('keeps the Barrier-B estimator pure while reserving supports and requirements work', () => {
    const calls: string[] = [];
    const target = fullTarget(calls);
    const set = scenarioSet([
      { name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
    ]);
    const barrierA = runBarrierA(inputWith([target], set.scenarios));
    const estimate = estimateBarrierB({
      barrierA,
      scenarioSet: set,
      reportingCurrency: 'USD',
      targets: [
        {
          descriptor: target,
          requirements: [{ kind: 'spot', symbol: 'AAPL' }],
          requirementDescriptorWorkUnits: 5,
          coordinateCount: 1,
          unresolvedRequirementCount: 0,
          usedForeignExchangeCoordinates: 0,
          resolverReturnDataWorkReserve: 0,
          handlerReturnDataWorkLimit: 0,
        },
      ],
    });

    expect(estimate).toMatchObject({
      supportsDispatches: 1,
      requirementsDispatches: 1,
      resolverDispatches: 0,
      handlerDispatches: 0,
      requirementDescriptorWork: 5,
      instructionApplications: 1,
      estimatedPricerCalls: 2,
      estimatedTaylorCalls: 0,
    });
    expect(estimate.workUnits).toBeGreaterThan(barrierA.inputDataWorkUnits);
    expect(calls).toEqual([]);
  });
});
