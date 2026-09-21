import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, isQuantError } from '@totalfinance/core';
import type { MarketObservation } from '@totalfinance/core/pricing';
import { spotAssetPricer } from '../src/spot-pricer.js';

function codeOf(action: () => unknown): string {
  try {
    action();
    return '<none>';
  } catch (error) {
    return isQuantError(error) ? error.code : '<not-a-quant-error>';
  }
}

describe('spotAssetPricer Gate-C adapter', () => {
  it('declares the exact stable identity, capabilities, support gate, and requirement', () => {
    const pricer = spotAssetPricer();

    expect(pricer).toMatchObject({
      name: 'scenarios.spot-asset',
      version: '0.0.1',
      capabilities: { greeks: 'none', randomness: 'none', batch: false },
    });
    expect(Object.isFrozen(pricer)).toBe(true);
    expect(pricer.supports({ symbol: 'AAPL' })).toBe(true);
    expect(pricer.supports({ symbol: '' })).toBe(false);
    expect(pricer.supports({ symbol: 'AAPL', typo: true } as never)).toBe(false);

    const requirements = pricer.requirements({ symbol: 'AAPL' });
    expect(requirements).toEqual([{ kind: 'spot', symbol: 'AAPL' }]);
    expect(Object.isFrozen(requirements)).toBe(true);
  });

  it('returns the observed per-unit spot exactly and discloses its complete assumptions', () => {
    const pricer = spotAssetPricer();
    const observations: MarketObservation[] = [
      { requirement: { kind: 'spot', symbol: 'AAPL' }, value: 193.25 },
      { requirement: { kind: 'spot', symbol: 'MSFT' }, value: 420 },
      { requirement: { kind: 'riskFreeRate', currency: 'USD' }, value: 0.04 },
    ];

    const base = pricer.price({ instrument: { symbol: 'AAPL' }, observations });
    const withIgnoredRequest = pricer.price({
      instrument: { symbol: 'AAPL' },
      observations,
      request: { greeks: false, seed: 42 },
    });

    expect(base).toEqual({
      value: 193.25,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        model: 'observed-spot',
        symbol: 'AAPL',
        valuationUnit: 'one spot asset unit',
      },
      diagnostics: {
        engine: 'scenarios.spot-asset',
        method: 'market-observation',
        warnings: [],
      },
    });
    expect(withIgnoredRequest).toEqual(base);
  });

  it('uses the protocol missing-requirement error and rejects malformed closed inputs', () => {
    const pricer = spotAssetPricer();

    expect(codeOf(() => pricer.price({ instrument: { symbol: 'AAPL' }, observations: [] }))).toBe(
      ErrorCode.PricerRequirementUnsatisfied,
    );
    expect(() =>
      pricer.price({
        instrument: { symbol: 'AAPL' },
        observations: [],
        typo: true,
      } as never),
    ).toThrow(/unknown field/);
    expect(() =>
      pricer.price({
        instrument: { symbol: 'AAPL' },
        observations: [],
        request: { seed: -1 },
      }),
    ).toThrow(/non-negative safe integer/);
  });

  it('never invokes accessor-backed instrument or request fields', () => {
    let reads = 0;
    const hostileInstrument = {};
    Object.defineProperty(hostileInstrument, 'symbol', {
      enumerable: true,
      get() {
        reads += 1;
        return 'AAPL';
      },
    });
    const hostileRequest = {};
    Object.defineProperty(hostileRequest, 'seed', {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    const pricer = spotAssetPricer();

    expect(pricer.supports(hostileInstrument as never)).toBe(false);
    expect(() => pricer.requirements(hostileInstrument as never)).toThrow(/data property/);
    expect(() =>
      pricer.price({
        instrument: { symbol: 'AAPL' },
        observations: [{ requirement: { kind: 'spot', symbol: 'AAPL' }, value: 1 }],
        request: hostileRequest,
      } as never),
    ).toThrow(/data property/);
    expect(reads).toBe(0);
  });
});
