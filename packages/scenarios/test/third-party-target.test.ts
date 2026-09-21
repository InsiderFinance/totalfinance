import { describe, expect, it, vi } from 'vitest';
import { CONVENTIONS_VERSION, type Computed } from '@totalfinance/core';
import {
  canonicalJsonOf,
  createMarketSnapshot,
  createScenarioSet,
} from '@totalfinance/core/artifacts';
import {
  requireObservationValue,
  type MarketRequirement,
  type Pricer,
} from '@totalfinance/core/pricing';
import {
  runScenarios,
  scenarioTarget,
  type ScenarioFactorHandler,
  type ScenarioMarketResolver,
  type ScenarioRunResult,
  type ScenarioTargetDescriptor,
} from '../src/index.js';

const AS_OF = Date.UTC(2026, 7, 30);
const EXPIRY = Date.UTC(2027, 7, 30);

interface SyntheticForwardDescriptor {
  readonly kind: 'example.synthetic-forward';
  readonly symbol: string;
  readonly expiresAt: number;
  readonly additiveSpread: number;
}

interface SyntheticForwardInstrument {
  readonly descriptor: SyntheticForwardDescriptor;
  readonly privateAdjustment: () => number;
  readonly privateState: { readonly marker: 'must-not-serialize' };
}

interface SyntheticForwardResult extends Computed<number> {
  readonly forward: number;
  readonly additiveSpread: number;
  readonly seedAdjustment: number;
}

interface FixtureState {
  readonly calls: string[];
  readonly priceSeeds: number[];
  readonly resolverTargets: ScenarioTargetDescriptor[];
  readonly handlerTargets: ScenarioTargetDescriptor[];
  readonly callbackInputsFrozen: boolean[];
  resolverThis: unknown;
  handlerThis: unknown;
}

function newState(): FixtureState {
  return {
    calls: [],
    priceSeeds: [],
    resolverTargets: [],
    handlerTargets: [],
    callbackInputsFrozen: [],
    resolverThis: 'not-called',
    handlerThis: 'not-called',
  };
}

function instrumentFromDescriptor(
  descriptor: SyntheticForwardDescriptor,
): SyntheticForwardInstrument {
  return {
    descriptor,
    privateAdjustment: () => descriptor.additiveSpread,
    privateState: { marker: 'must-not-serialize' },
  };
}

function thirdPartyPricer(
  state: FixtureState,
): Pricer<SyntheticForwardInstrument, SyntheticForwardResult> {
  return {
    name: 'example.synthetic-forward-pricer',
    version: '2.1.0',
    capabilities: { greeks: 'none', randomness: 'seeded', batch: false },
    supports: (instrument) => {
      state.calls.push('supports');
      return instrument.descriptor.kind === 'example.synthetic-forward';
    },
    requirements: (instrument) => {
      state.calls.push('requirements');
      return [
        {
          kind: 'forward',
          symbol: instrument.descriptor.symbol,
          expiresAt: instrument.descriptor.expiresAt,
        },
      ];
    },
    price: ({ instrument, observations, request }) => {
      state.calls.push('price');
      if (request?.seed === undefined) {
        throw new Error('example.synthetic-forward-pricer requires request.seed');
      }
      state.priceSeeds.push(request.seed);
      const requirement: MarketRequirement & { kind: 'forward' } = {
        kind: 'forward',
        symbol: instrument.descriptor.symbol,
        expiresAt: instrument.descriptor.expiresAt,
      };
      const forward = requireObservationValue(
        'example.synthetic-forward-pricer.price',
        observations,
        requirement,
      );
      const additiveSpread = instrument.privateAdjustment();
      const seedAdjustment = request.seed / 1_000;
      return {
        value: forward + additiveSpread + seedAdjustment,
        forward,
        additiveSpread,
        seedAdjustment,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          seed: request.seed,
          model: 'example.synthetic-forward',
        },
        diagnostics: { warnings: [] },
      };
    },
  };
}

function thirdPartyResolver(state: FixtureState): ScenarioMarketResolver {
  return {
    name: 'example.forward-resolver',
    version: '3.0.0',
    resolve: function (this: undefined, input) {
      state.calls.push('resolver');
      state.resolverThis = this;
      state.resolverTargets.push(input.target);
      state.callbackInputsFrozen.push(
        Object.isFrozen(input),
        Object.isFrozen(input.requirement),
        Object.isFrozen(input.market),
        Object.isFrozen(input.target),
      );
      return input.requirement.kind === 'forward'
        ? { requirement: input.requirement, value: 105 }
        : undefined;
    },
  };
}

function liquidityHandler(state: FixtureState): ScenarioFactorHandler {
  return {
    factor: 'liquidityPremium',
    name: 'example.liquidity-premium-handler',
    version: '1.2.0',
    apply: function (this: undefined, input) {
      state.calls.push('handler');
      state.handlerThis = this;
      state.handlerTargets.push(input.target);
      state.callbackInputsFrozen.push(
        Object.isFrozen(input),
        Object.isFrozen(input.instruction),
        Object.isFrozen(input.observations),
        Object.isFrozen(input.target),
      );
      if (input.instruction.factor !== 'liquidityPremium') return undefined;
      return input.observations.map((observation) =>
        observation.requirement.kind === 'forward'
          ? {
              requirement: observation.requirement,
              value: (observation.value as number) + input.instruction.value,
            }
          : observation,
      );
    },
  };
}

function runThirdPartyFixture(): {
  readonly result: ScenarioRunResult;
  readonly state: FixtureState;
  readonly instrument: SyntheticForwardInstrument;
  readonly pricer: Pricer<SyntheticForwardInstrument, SyntheticForwardResult>;
  readonly target: ReturnType<typeof scenarioTarget.fullRevaluation<SyntheticForwardInstrument>>;
} {
  const state = newState();
  const descriptor: SyntheticForwardDescriptor = {
    kind: 'example.synthetic-forward',
    symbol: 'ACME',
    expiresAt: EXPIRY,
    additiveSpread: 0.5,
  };
  const instrument = instrumentFromDescriptor(descriptor);
  const pricer = thirdPartyPricer(state);
  const target = scenarioTarget.fullRevaluation({
    id: 'third-party:acme-forward',
    quantity: 3,
    contractMultiplier: 10,
    currency: 'USD',
    underlying: 'ACME',
    strategy: 'synthetic-carry',
    account: 'test-account',
    book: 'extension-book',
    tags: ['third-party', 'forward'],
    instrument,
    instrumentDescriptor: descriptor,
    pricer,
  });

  // Building the opaque target validates only the structural door; user behavior is not invoked.
  expect(state.calls).toEqual([]);
  const result = runScenarios({
    scenarioSet: createScenarioSet({
      name: 'Third-party extension acceptance',
      scenarios: [
        {
          name: 'forward up, liquidity down',
          shocks: [
            { factor: 'forward', target: 'ACME', kind: 'absolute', value: 2 },
            {
              factor: 'liquidityPremium',
              target: 'third-party:acme-forward',
              kind: 'absolute',
              value: -1,
            },
          ],
        },
      ],
    }),
    market: createMarketSnapshot({ asOf: AS_OF, observations: {} }),
    targets: [target],
    options: {
      seed: 19,
      marketResolvers: [thirdPartyResolver(state)],
      factorHandlers: [liquidityHandler(state)],
    },
  });
  return { result, state, instrument, pricer, target };
}

function assertBehaviorFreeDescriptor(target: ScenarioTargetDescriptor): void {
  expect(Object.getOwnPropertySymbols(target)).toEqual([]);
  expect(Object.isFrozen(target)).toBe(true);
  expect('instrument' in target).toBe(false);
  if (target.valuationMethod === 'full-revaluation') {
    expect('price' in target.pricer).toBe(false);
    expect('supports' in target.pricer).toBe(false);
    expect('requirements' in target.pricer).toBe(false);
    expect(Object.isFrozen(target.instrumentDescriptor)).toBe(true);
  }
}

describe('Stage 4.4b third-party target acceptance', () => {
  it('uses a structural pricer, custom resolver, and custom handler without a registry or patch', () => {
    const fixture = runThirdPartyFixture();
    const { result, state, instrument, pricer, target } = fixture;

    expect(state.calls).toEqual([
      'supports',
      'requirements',
      'resolver',
      'handler',
      'price',
      'price',
    ]);
    expect(result.diagnostics.metrics.supportsCalls.actual).toBe(1);
    expect(result.diagnostics.metrics.requirements.actual).toBe(1);
    expect(result.diagnostics.metrics.resolverCalls.actual).toBe(1);
    expect(result.diagnostics.metrics.factorHandlerCalls.actual).toBe(1);
    expect(state.priceSeeds).toEqual([19, 19]);
    expect(state.resolverThis).toBeUndefined();
    expect(state.handlerThis).toBeUndefined();
    expect(state.callbackInputsFrozen.every(Boolean)).toBe(true);

    const base = result.base[0]!;
    const scenario = result.cells[0]!;
    expect(base).toMatchObject({
      status: 'complete',
      valuationMethod: 'full-revaluation',
      valuePerUnit: 105.519,
      positionValue: 3_165.57,
    });
    expect(scenario).toMatchObject({
      status: 'complete',
      valuationMethod: 'full-revaluation',
      valuePerUnit: 106.519,
      localPnl: 30,
    });
    expect(result.assumptions.resolvers).toEqual([
      { name: 'example.forward-resolver', version: '3.0.0' },
    ]);
    expect(result.assumptions.factorHandlers).toEqual([
      { name: 'example.liquidity-premium-handler', version: '1.2.0' },
    ]);

    // The caller's runtime-rich values remain caller-owned; only a frozen adapter copy is bound.
    expect(Object.isFrozen(instrument)).toBe(false);
    expect(Object.isFrozen(pricer)).toBe(false);
    expect(Object.isFrozen(target)).toBe(true);
    const privateSymbols = Object.getOwnPropertySymbols(target);
    expect(privateSymbols).toHaveLength(2);
    expect(
      privateSymbols.every(
        (symbol) => Object.getOwnPropertyDescriptor(target, symbol)?.enumerable === false,
      ),
    ).toBe(true);
    expect('instrument' in target).toBe(false);

    expect(state.resolverTargets).toHaveLength(1);
    expect(state.handlerTargets).toHaveLength(1);
    assertBehaviorFreeDescriptor(state.resolverTargets[0]!);
    assertBehaviorFreeDescriptor(state.handlerTargets[0]!);
    assertBehaviorFreeDescriptor(result.targetAxis[0]!);
    expect(canonicalJsonOf(result)).not.toContain('must-not-serialize');
  });

  it('is canonical-byte deterministic from explicit browser-safe data and never consults the clock', () => {
    const dateNow = vi.spyOn(Date, 'now');
    const first = runThirdPartyFixture();
    const second = runThirdPartyFixture();
    const ambientClockReads = dateNow.mock.calls.length;
    dateNow.mockRestore();

    expect(ambientClockReads).toBe(0);
    expect(canonicalJsonOf(second.result)).toBe(canonicalJsonOf(first.result));
    expect(first.result.assumptions.marketAsOf).toBe(AS_OF);
    expect(second.result.assumptions.marketAsOf).toBe(AS_OF);
    expect(first.state.calls).toEqual(second.state.calls);
  });
});
