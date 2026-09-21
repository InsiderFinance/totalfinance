/**
 * First-touch container guards: every pro/batch/exotic boundary must answer a missing or garbage
 * argument with a typed {@link InputError} that names the argument — never a raw
 * `TypeError: Cannot read properties of undefined` from deep inside the implementation.
 */
import { describe, expect, it } from 'vitest';
import { InputError, resolvedExpiry } from '@totalfinance/core';
import {
  barrier,
  basket,
  compareEngines,
  lookback,
  market,
  option,
  priceMany,
  quanto,
  rainbow,
  spread,
  type OptionBatchColumns,
  type OptionImpliedVolatilityBatchColumns,
} from '@totalfinance/options';
import { monteCarloPrice } from '@totalfinance/options/monte-carlo';
import {
  blackScholesImpliedVolatilityMany,
  blackScholesPriceManyInto,
} from '@totalfinance/options/batch';

const WRONG_TYPE = 'input.wrong_type';

/** Assert `run` throws a typed InputError with the expected code and a message naming `argName`. */
function expectTypedGuard(run: () => unknown, argName: string, code = WRONG_TYPE): void {
  try {
    run();
    throw new Error(`expected a typed guard throw for ${argName}`);
  } catch (err) {
    expect(err, `expected InputError for ${argName}, got ${String(err)}`).toBeInstanceOf(
      InputError,
    );
    expect((err as InputError).code).toBe(code);
    expect((err as InputError).message).toContain(argName);
  }
}

const asOf = Date.UTC(2026, 0, 1);
const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
const contract = option.call({
  convention: 'us-equity-close',
  underlying: 'X',
  strike: 100,
  expiry: '2027-01-01',
  style: 'european',
});

describe('pro tier guards `market` like it guards `contract`', () => {
  it('option.price without a market teaches instead of crashing', () => {
    expectTypedGuard(() => option.price({ contract, market: undefined as never }), 'market');
    expectTypedGuard(() => option.price({ contract, market: null as never }), 'market');
  });

  it('option.impliedVolatility without a market teaches instead of crashing', () => {
    expectTypedGuard(
      () => option.impliedVolatility({ contract, market: undefined as never }),
      'market',
    );
  });

  it('compareEngines without a market teaches instead of crashing', () => {
    expectTypedGuard(() => compareEngines({ contract, market: undefined as never }), 'market');
    // The contract guard still fires (once, under the exported name).
    expectTypedGuard(
      () => compareEngines({ contract: undefined as never, market: mkt }),
      'contract',
    );
  });

  it('monteCarloPrice without a market teaches instead of crashing', () => {
    expectTypedGuard(
      () =>
        monteCarloPrice({
          contract,
          market: undefined as never,
          options: { paths: 100, seed: 1 },
        }),
      'market',
    );
  });
});

describe('priceMany guards market and each contract element', () => {
  it('missing market teaches instead of crashing inside the engine', () => {
    expectTypedGuard(
      () => priceMany({ contracts: [contract], market: undefined as never }),
      'market',
    );
  });

  it('a null element names the offending index instead of crashing on null.style', () => {
    expectTypedGuard(() => priceMany({ contracts: [null] as never, market: mkt }), 'contracts[0]');
    expectTypedGuard(
      () => priceMany({ contracts: [contract, null] as never, market: mkt }),
      'contracts[1]',
    );
  });
});

describe('columnar batch guards the columns it actually uses', () => {
  function impliedVolatilityColumns(): OptionImpliedVolatilityBatchColumns {
    return {
      price: Float64Array.from([10]),
      spot: Float64Array.from([100]),
      strike: Float64Array.from([100]),
      riskFreeRate: Float64Array.from([0.05]),
      timeToExpiryYears: Float64Array.from([1]),
      type: Int8Array.from([1]),
    };
  }

  it('blackScholesImpliedVolatilityMany rejects a missing price column (the row-count column)', () => {
    const { price: _price, ...rest } = impliedVolatilityColumns();
    expectTypedGuard(() => blackScholesImpliedVolatilityMany(rest as never), 'cols.price');
    // And still rejects a missing spot column.
    const { spot: _spot, ...noSpot } = impliedVolatilityColumns();
    expectTypedGuard(() => blackScholesImpliedVolatilityMany(noSpot as never), 'cols.spot');
  });

  it('blackScholesPriceManyInto rejects a missing out buffer instead of crashing on out.length', () => {
    const cols: OptionBatchColumns = {
      spot: Float64Array.from([100]),
      strike: Float64Array.from([100]),
      volatility: Float64Array.from([0.2]),
      riskFreeRate: Float64Array.from([0.05]),
      timeToExpiryYears: Float64Array.from([1]),
      type: Int8Array.from([1]),
    };
    expectTypedGuard(() => blackScholesPriceManyInto(cols, undefined as never), 'out');
  });
});

describe('exotics container-guard their input (and required options)', () => {
  const monteCarloOpts = { paths: 200, seed: 1 };
  const barrierInput = {
    spot: 100,
    strike: 100,
    barrier: 90,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
  };
  const lookInput = { spot: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.25 };
  const spreadInput = {
    spot1: 100,
    spot2: 100,
    strike: 5,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
    volatility1: 0.2,
    volatility2: 0.25,
    correlation: 0.5,
  };
  const multiInput = {
    spots: [100, 95],
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
    volatilities: [0.2, 0.25],
    correlation: [
      [1, 0.5],
      [0.5, 1],
    ],
  };

  it('barrier.price / barrier.monteCarloPrice guard input and options', () => {
    expectTypedGuard(() => barrier.price(undefined as never), 'input');
    expectTypedGuard(() => barrier.monteCarloPrice(undefined as never, monteCarloOpts), 'input');
    expectTypedGuard(
      () =>
        barrier.monteCarloPrice(
          { ...barrierInput, type: 'call', barrierType: 'down-out' },
          undefined as never,
        ),
      'options',
    );
  });

  it('lookback.price / lookback.monteCarloPrice guard input and options', () => {
    expectTypedGuard(() => lookback.price(undefined as never), 'input');
    expectTypedGuard(
      () =>
        lookback.monteCarloPrice(
          { ...lookInput, type: 'call', strikeType: 'floating' },
          undefined as never,
        ),
      'options',
    );
  });

  it('spread.price / spread.monteCarloPrice guard input and options', () => {
    expectTypedGuard(() => spread.price(undefined as never), 'input');
    expectTypedGuard(
      () => spread.monteCarloPrice({ ...spreadInput, type: 'call' }, undefined as never),
      'options',
    );
  });

  it('quanto.price guards input', () => {
    expectTypedGuard(() => quanto.price(undefined as never), 'input');
  });

  it('basket / rainbow guard input and options', () => {
    expectTypedGuard(() => basket.approximatePrice(undefined as never), 'input');
    expectTypedGuard(
      () =>
        basket.monteCarloPrice(
          { type: 'call', ...multiInput, weights: [0.5, 0.5] },
          undefined as never,
        ),
      'options',
    );
    expectTypedGuard(() => rainbow.monteCarloPrice(undefined as never, monteCarloOpts), 'input');
  });

  it('a wrong array key (the removed short form) teaches the expected shape', () => {
    const wrongKey = {
      spots: [100, 95],
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      // Built by concatenation: a repo-wide rename must not rewrite the very key this test
      // exists to prove is rejected.
      ['vol' + 's']: [0.2, 0.25],
      correlation: [
        [1, 0.5],
        [0.5, 1],
      ],
      weights: [0.5, 0.5],
    };
    try {
      basket.approximatePrice({ ...(wrongKey as object), type: 'call' } as never);
      throw new Error('expected a wrong-shape throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      const message = (err as InputError).message;
      // The error names the real slot and echoes what the caller DID pass.
      expect(message).toContain('volatilities');
      expect(message).toContain('volatilities');
    }
  });

  it('valid exotics inputs still price after the guards', () => {
    expect(
      barrier.price({ ...barrierInput, type: 'call', barrierType: 'down-out' }).value,
    ).toBeGreaterThan(0);
    expect(spread.price({ ...spreadInput, type: 'call' }).value).toBeGreaterThan(0);
    expect(
      basket.approximatePrice({ type: 'call', ...multiInput, weights: [0.5, 0.5] }).value,
    ).toBeGreaterThan(0);
  });
});

describe('one grammar for "when": asOf accepts ISO strings everywhere (R3)', () => {
  const contract = {
    underlying: 'SPY',
    type: 'call',
    style: 'european',
    strike: 105,
    expiry: '2026-06-19',
    ...resolvedExpiry('2026-06-19'),
  } as const;
  const asOfMs = Date.UTC(2026, 0, 2);

  it('option.price with a date string equals the epoch-ms call and echoes resolved ms', () => {
    const a = option.price({
      contract: contract as never,
      market: {
        spot: 105,
        volatility: 0.2,
        riskFreeRate: 0.04,
        asOf: '2026-01-02T00:00:00Z',
      },
    });
    const b = option.price({
      contract: contract as never,
      market: { spot: 105, volatility: 0.2, riskFreeRate: 0.04, asOf: asOfMs },
    });
    expect(a.value).toBeCloseTo(b.value, 12);
    expect(a.assumptions.asOf).toBe(asOfMs);
  });

  it('a zone-less datetime is rejected with the teaching error (determinism law)', () => {
    expect(() =>
      option.price({
        contract: contract as never,
        market: {
          spot: 105,
          volatility: 0.2,
          riskFreeRate: 0.04,
          asOf: '2026-01-02T09:30',
        },
      }),
    ).toThrowError(/append 'Z' or an offset/);
  });
});
