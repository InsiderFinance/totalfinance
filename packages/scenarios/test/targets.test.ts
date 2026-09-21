import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, type Computed } from '@totalfinance/core';
import type { Pricer } from '@totalfinance/core/pricing';
import { scenarioTarget, validateScenarioTarget } from '../src/targets.js';

interface EquityInstrument {
  symbol: string;
  refresh(): void;
}

function equityPricer(calls: string[]): Pricer<EquityInstrument> {
  return {
    name: 'test.equity',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: (instrument) => {
      calls.push(`supports:${instrument.symbol}`);
      return true;
    },
    requirements: (instrument) => {
      calls.push(`requirements:${instrument.symbol}`);
      return [{ kind: 'spot', symbol: instrument.symbol }];
    },
    price: ({ instrument }) => {
      calls.push(`price:${instrument.symbol}`);
      return {
        value: 100,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      } satisfies Computed<number>;
    },
  };
}

describe('scenarioTarget ownership and storage law', () => {
  it('returns an opaque frozen descriptor without freezing or invoking caller behavior', () => {
    const calls: string[] = [];
    const instrument: EquityInstrument = {
      symbol: 'AAPL',
      refresh() {},
    };
    const pricer = equityPricer(calls);
    const instrumentDescriptor = {
      kind: 'equity',
      symbol: 'AAPL',
      metadata: { venue: 'NASDAQ' },
    };

    const target = scenarioTarget.fullRevaluation({
      id: 'aapl-long',
      quantity: 2,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'AAPL',
      tags: ['equity', 'growth'],
      instrument,
      instrumentDescriptor,
      pricer,
    });

    expect(target.valuationMethod).toBe('full-revaluation');
    if (target.valuationMethod !== 'full-revaluation') {
      throw new Error('fullRevaluation must return a full-revaluation descriptor');
    }

    expect(calls).toEqual([]);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.instrumentDescriptor)).toBe(true);
    expect(
      Object.isFrozen((target.instrumentDescriptor as typeof instrumentDescriptor).metadata),
    ).toBe(true);
    expect(Object.isFrozen(target.pricer)).toBe(true);
    expect(Object.isFrozen(target.pricer.capabilities)).toBe(true);

    expect(Object.isFrozen(instrument)).toBe(false);
    expect(Object.isFrozen(pricer)).toBe(false);
    expect(Object.isFrozen(pricer.capabilities)).toBe(false);
    expect(Object.isFrozen(instrumentDescriptor)).toBe(false);
    expect(Object.isFrozen(instrumentDescriptor.metadata)).toBe(false);

    const symbols = Object.getOwnPropertySymbols(target);
    expect(symbols).toHaveLength(2);
    expect(Object.keys(target)).not.toContain('instrument');
    expect(Object.keys(target)).not.toContain('binding');
    for (const symbol of symbols) {
      const descriptor = Object.getOwnPropertyDescriptor(target, symbol);
      expect(descriptor).toMatchObject({
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }

    const validated = validateScenarioTarget(target, 0);
    expect(validated.target).toBe(target);
    expect(validated.binding?.instrument).toBe(instrument);
    expect(calls).toEqual([]);
  });

  it('rejects a frozen public lookalike that did not come from a builder', () => {
    const target = scenarioTarget.spot({
      id: 'spot-aapl',
      symbol: 'AAPL',
      quantity: 1,
      currency: 'USD',
    });
    const lookalike = Object.freeze({ ...target });

    expect(() => validateScenarioTarget(lookalike, 0)).toThrow(/builder-owned target brand/);
  });

  it('spot is the exact one-unit convenience and records one unambiguous underlying', () => {
    const target = scenarioTarget.spot({
      id: 'short-msft',
      symbol: 'MSFT',
      quantity: -3,
      currency: 'USD',
      strategy: 'hedge',
    });

    expect(target).toMatchObject({
      id: 'short-msft',
      quantity: -3,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'MSFT',
      strategy: 'hedge',
      valuationMethod: 'full-revaluation',
      instrumentDescriptor: { kind: 'spot-asset', symbol: 'MSFT' },
      pricer: {
        name: 'scenarios.spot-asset',
        version: '0.0.1',
        capabilities: { greeks: 'none', randomness: 'none', batch: false },
      },
    });
    expect(validateScenarioTarget(target, 0).binding?.instrument).toEqual({ symbol: 'MSFT' });
  });

  it('uses the instrument, not the pricer, as the generic inference source', () => {
    interface BondInstrument {
      cusip: string;
    }
    const bondPricer: Pricer<BondInstrument> = {
      name: 'test.bond',
      version: '1.0.0',
      capabilities: { greeks: 'none', randomness: 'none', batch: false },
      supports: () => true,
      requirements: () => [],
      price: () => ({
        value: 100,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      }),
    };

    const rejectMismatchedTarget = (): void => {
      scenarioTarget.fullRevaluation({
        id: 'wrong-pair',
        quantity: 1,
        contractMultiplier: 1,
        currency: 'USD',
        instrument: { symbol: 'AAPL' },
        instrumentDescriptor: { kind: 'equity', symbol: 'AAPL' },
        // @ts-expect-error NoInfer: an equity-shaped instrument cannot be paired with a bond pricer.
        pricer: bondPricer,
      });
    };

    expect(rejectMismatchedTarget).toBeTypeOf('function');
    expect(bondPricer.name).toBe('test.bond');
  });
});
