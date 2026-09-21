import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, type Computed, isQuantError } from '@totalfinance/core';
import { createMarketSnapshot, createScenarioSet } from '@totalfinance/core/artifacts';
import type { MarketObservation, MarketRequirement, Pricer } from '@totalfinance/core/pricing';
import { snapshotResolvers } from '../src/internal/behaviors.js';
import { resolveBuiltInRequirement, resolveRequirementSet } from '../src/market-resolution.js';
import { runScenarios, scenarioTarget } from '../src/index.js';
import { validateTaylorBaseCoherence } from '../src/taylor.js';
import type { ScenarioTargetDescriptor, TaylorScenarioTargetDescriptor } from '../src/types.js';

const AS_OF = Date.UTC(2026, 7, 30);

function descriptor(currency = 'USD'): ScenarioTargetDescriptor {
  const target = scenarioTarget.spot({
    id: 'under-test',
    symbol: 'AAPL',
    quantity: 1,
    currency,
  });
  return JSON.parse(JSON.stringify(target)) as ScenarioTargetDescriptor;
}

function snapshot(
  input: {
    observations?: Parameters<typeof createMarketSnapshot>[0]['observations'];
    conventions?: Parameters<typeof createMarketSnapshot>[0]['conventions'];
  } = {},
) {
  return createMarketSnapshot({
    asOf: AS_OF,
    conventions: input.conventions ?? {},
    observations: input.observations ?? {},
  });
}

function valueResult(value: number): Computed<number> {
  return {
    value,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION },
    diagnostics: { warnings: [] },
  };
}

function quantoSpotPricer(): Pricer<{ symbol: string }> {
  return {
    name: 'test.eur-spot-usd-quanto',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: () => true,
    requirements: ({ symbol }) => [{ kind: 'spot', symbol }],
    price: ({ observations }) => valueResult(observations[0]!.value as number),
  };
}

describe('Gate-B to Gate-C market resolution', () => {
  it('projects exact valuation, spot, volatility, rate, dividend, and curve observations', () => {
    const curve = {
      currency: 'USD',
      asOf: AS_OF,
      dayCount: 'ACT/365F' as const,
      compounding: 'continuous' as const,
      interpolation: 'linear-zero' as const,
      points: [
        { date: '2027-08-30', zeroRate: 0.04 },
        { date: '2028-08-30', zeroRate: 0.045 },
      ],
    };
    const market = snapshot({
      conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
      observations: {
        spots: { AAPL: { price: 100, currency: 'USD' } },
        volatilities: { AAPL: 0.25 },
        riskFreeRates: { USD: 0.04 },
        dividendYields: { AAPL: 0.01 },
        curves: { 'USD.sofr': curve },
      },
    });
    const target = descriptor();
    const requirements: MarketRequirement[] = [
      { kind: 'valuationInstant' },
      { kind: 'spot', symbol: 'AAPL' },
      { kind: 'impliedVolatility', symbol: 'AAPL', strike: 100, expiresAt: AS_OF + 86_400_000 },
      { kind: 'riskFreeRate', currency: 'USD' },
      { kind: 'dividendYield', symbol: 'AAPL' },
      { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
    ];

    expect(
      requirements.map((requirement) => resolveBuiltInRequirement(requirement, market, target)),
    ).toEqual([
      { status: 'resolved', observation: { requirement: requirements[0], value: AS_OF } },
      { status: 'resolved', observation: { requirement: requirements[1], value: 100 } },
      { status: 'resolved', observation: { requirement: requirements[2], value: 0.25 } },
      { status: 'resolved', observation: { requirement: requirements[3], value: 0.04 } },
      { status: 'resolved', observation: { requirement: requirements[4], value: 0.01 } },
      { status: 'resolved', observation: { requirement: requirements[5], value: curve } },
    ]);
  });

  it('refuses to answer WHEN from a date-granular snapshot, but still serves spots', () => {
    // A ledger snapshot created from a bare date is 00:00 UTC of that date (19:00/20:00 ET the
    // evening before): an option pricer asking for the valuation instant gets the fix, not a guess.
    const dated = createMarketSnapshot({
      asOf: '2026-08-30',
      observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
    });
    expect(dated.conventions.asOfConvention).toBe('date-midnight-utc');
    let caught: unknown;
    try {
      resolveBuiltInRequirement({ kind: 'valuationInstant' }, dated, descriptor());
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    if (!isQuantError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('time.valuation_instant_required');
    expect(caught.message).toContain("usEquitySessionInstant('2026-08-30', 'close')");
    expect(
      resolveBuiltInRequirement({ kind: 'spot', symbol: 'AAPL' }, dated, descriptor()),
    ).toMatchObject({ status: 'resolved' });
  });

  it('does not silently normalize incompatible rate conventions', () => {
    const requirement = { kind: 'riskFreeRate', currency: 'USD' } as const;
    const result = resolveBuiltInRequirement(
      requirement,
      snapshot({
        conventions: { dayCount: 'ACT/360', compounding: 'simple' },
        observations: { riskFreeRates: { USD: 0.04 } },
      }),
      descriptor(),
    );

    expect(result).toMatchObject({ status: 'unavailable', absence: 'present-incompatible' });
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('not continuous / ACT/365F');
    }
  });

  it('enforces spot currency only for the first-party spot-valued target', () => {
    const requirement = { kind: 'spot', symbol: 'SAP' } as const;
    const eurSpotMarket = snapshot({
      observations: { spots: { SAP: { price: 100, currency: 'EUR' } } },
    });
    const firstParty = resolveBuiltInRequirement(requirement, eurSpotMarket, descriptor('USD'));
    const quantoTarget = scenarioTarget.fullRevaluation({
      id: 'sap-usd-quanto',
      quantity: 1,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'SAP',
      instrument: { symbol: 'SAP' },
      pricer: quantoSpotPricer(),
    });
    const quantoDescriptor = JSON.parse(JSON.stringify(quantoTarget)) as ScenarioTargetDescriptor;

    expect(firstParty).toMatchObject({
      status: 'unavailable',
      absence: 'present-incompatible',
    });
    expect(resolveBuiltInRequirement(requirement, eurSpotMarket, quantoDescriptor)).toEqual({
      status: 'resolved',
      observation: { requirement, value: 100 },
    });
  });

  it('runs a USD quanto target over a EUR spot observation end to end', () => {
    const result = runScenarios({
      scenarioSet: createScenarioSet({
        name: 'quanto spot',
        scenarios: [
          { name: 'SAP +10%', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
        ],
      }),
      market: snapshot({
        observations: { spots: { SAP: { price: 100, currency: 'EUR' } } },
      }),
      targets: [
        scenarioTarget.fullRevaluation({
          id: 'sap-usd-quanto',
          quantity: 1,
          contractMultiplier: 1,
          currency: 'USD',
          underlying: 'SAP',
          instrument: { symbol: 'SAP' },
          pricer: quantoSpotPricer(),
        }),
      ],
    });

    expect(result.base[0]).toMatchObject({
      status: 'complete',
      valuationCurrency: 'USD',
      valuePerUnit: 100,
    });
    expect(result.cells[0]).toMatchObject({
      status: 'complete',
      valuationCurrency: 'USD',
    });
    expect(result.cells[0]?.valuePerUnit).toBeCloseTo(110);
    expect(result.cells[0]?.localPnl).toBeCloseTo(10);
  });

  it('allows a Taylor target currency to differ from its spot factor currency', () => {
    const target = scenarioTarget.taylor({
      id: 'sap-usd-taylor',
      quantity: 1,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'SAP',
      baseValuePerUnit: 25,
      greeks: { delta: 0.5 },
      factors: { spot: { subject: 'SAP', level: 100 } },
    });
    const targetDescriptor = JSON.parse(JSON.stringify(target)) as TaylorScenarioTargetDescriptor;

    expect(() =>
      validateTaylorBaseCoherence(
        targetDescriptor,
        snapshot({ observations: { spots: { SAP: { price: 100, currency: 'EUR' } } } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateTaylorBaseCoherence(
        targetDescriptor,
        snapshot({ observations: { spots: { SAP: { price: 101, currency: 'EUR' } } } }),
      ),
    ).toThrow(/matching market snapshot quote is 101/);
  });

  it('requires a resolver for forward and records the exact answering identity', () => {
    const requirement = {
      kind: 'forward',
      symbol: 'AAPL',
      expiresAt: AS_OF + 31_536_000_000,
    } as const;
    const calls: string[] = [];
    const resolvers = snapshotResolvers([
      {
        name: 'test.forward-source',
        version: '1.0.0',
        resolve: ({ requirement: requested }: { requirement: MarketRequirement }) => {
          calls.push(requested.kind);
          return requested.kind === 'forward'
            ? ({ requirement: requested, value: 105 } as MarketObservation)
            : undefined;
        },
      },
    ]);

    const builtIn = resolveBuiltInRequirement(requirement, snapshot(), descriptor());
    expect(builtIn).toMatchObject({ status: 'unavailable', absence: 'genuinely-absent' });
    const resolved = resolveRequirementSet({
      requirements: [requirement],
      market: snapshot(),
      target: descriptor(),
      resolvers,
    });
    expect(calls).toEqual(['forward']);
    expect(resolved.observations).toEqual([{ requirement, value: 105 }]);
    expect(resolved.resolvers).toEqual([{ name: 'test.forward-source', version: '1.0.0' }]);
    expect(resolved.resolverCalls).toBe(1);
  });

  it('refuses ambiguous resolver answers instead of choosing by list order', () => {
    const requirement = {
      kind: 'forward',
      symbol: 'AAPL',
      expiresAt: AS_OF + 31_536_000_000,
    } as const;
    const resolvers = snapshotResolvers([
      {
        name: 'test.first',
        version: '1.0.0',
        resolve: () => ({ requirement, value: 104 }),
      },
      {
        name: 'test.second',
        version: '1.0.0',
        resolve: () => ({ requirement, value: 106 }),
      },
    ]);

    expect(() =>
      resolveRequirementSet({
        requirements: [requirement],
        market: snapshot(),
        target: descriptor(),
        resolvers,
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.PricerObservationInvalid }));
  });

  it('wraps a resolver throw in the stable preflight taxonomy without losing its cause', () => {
    const requirement = {
      kind: 'forward',
      symbol: 'AAPL',
      expiresAt: AS_OF + 31_536_000_000,
    } as const;
    const original = new Error('provider unavailable');
    const resolvers = snapshotResolvers([
      {
        name: 'test.throwing',
        version: '1.0.0',
        resolve: () => {
          throw original;
        },
      },
    ]);

    expect(() =>
      resolveRequirementSet({
        requirements: [requirement],
        market: snapshot(),
        target: descriptor(),
        resolvers,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ErrorCode.PricerObservationInvalid,
        cause: original,
      }),
    );
  });

  it('runs a forward-resolved target end-to-end and invokes all resolvers once', () => {
    const requirement = {
      kind: 'forward',
      symbol: 'AAPL',
      expiresAt: AS_OF + 31_536_000_000,
    } as const;
    const calls: string[] = [];
    const pricer: Pricer<{ symbol: string }> = {
      name: 'test.forward-pricer',
      version: '1.0.0',
      capabilities: { greeks: 'none', randomness: 'none', batch: false },
      supports: () => true,
      requirements: () => [requirement],
      price: ({ observations }) => valueResult(observations[0]!.value as number),
    };
    const target = scenarioTarget.fullRevaluation({
      id: 'forward-aapl',
      quantity: 1,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'AAPL',
      instrument: { symbol: 'AAPL' },
      pricer,
    });

    const result = runScenarios({
      scenarioSet: createScenarioSet({
        name: 'forward',
        scenarios: [
          { name: 'forward +5', shocks: [{ factor: 'forward', kind: 'absolute', value: 5 }] },
        ],
      }),
      market: snapshot(),
      targets: [target],
      options: {
        marketResolvers: [
          {
            name: 'test.miss',
            version: '1.0.0',
            resolve: () => {
              calls.push('miss');
              return undefined;
            },
          },
          {
            name: 'test.hit',
            version: '1.0.0',
            resolve: ({ requirement: requested }) => {
              calls.push('hit');
              return { requirement: requested, value: 105 } as MarketObservation;
            },
          },
        ],
      },
    });

    expect(calls).toEqual(['miss', 'hit']);
    expect(result.base[0]).toMatchObject({ status: 'complete', valuePerUnit: 105 });
    expect(result.cells[0]).toMatchObject({ status: 'complete', valuePerUnit: 110, localPnl: 5 });
  });

  it('rejects an oversized resolver curve before visiting any pillar slot', () => {
    let pillarReads = 0;
    const points = new Array(4_097);
    Object.defineProperty(points, '0', {
      enumerable: true,
      get() {
        pillarReads++;
        throw new Error('must not read an oversized curve pillar');
      },
    });
    const requirement = {
      kind: 'discountCurve',
      curveId: 'USD.oversized',
      currency: 'USD',
    } as const;
    const resolvers = snapshotResolvers([
      {
        name: 'test.oversized-curve',
        version: '1.0.0',
        resolve: () =>
          ({
            requirement,
            value: {
              currency: 'USD',
              asOf: AS_OF,
              dayCount: 'ACT/365F',
              compounding: 'continuous',
              points,
            },
          }) as unknown as MarketObservation,
      },
    ]);
    expect(() =>
      resolveRequirementSet({
        requirements: [requirement],
        market: snapshot(),
        target: descriptor(),
        resolvers,
        maximumResultWorkUnits: [1_000_000],
      }),
    ).toThrow(/4097 curve pillars.*maximum is 4,096/);
    expect(pillarReads).toBe(0);
  });
});
