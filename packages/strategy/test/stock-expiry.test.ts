import { describe, expect, it } from 'vitest';
import { InputError, optionExpiryToMs, yearFraction } from '@totalfinance/core';
import {
  legs,
  strategy,
  type LegInput,
  type Position,
  type PositionConfig,
} from '@totalfinance/strategy';

const expiry = '2026-07-17';
const farExpiry = '2026-10-16';
const market = {
  spot: 100,
  volatility: 0.25,
  riskFreeRate: 0.03,
  asOf: '2026-06-01T20:00:00Z',
};
const horizon = (date: string) =>
  yearFraction(Date.parse(market.asOf), optionExpiryToMs(date), 'ACT/365F');
const stock = legs.stock({ price: 100, quantity: 100 });
const call = legs.call({ strike: 105, premium: 3, expiry, quantity: -1 });
const put = legs.put({ strike: 95, premium: 2, expiry, quantity: 1 });
const prices = [0, 90, 95, 100, 105, 110, 200];
const positivePrices = [90, 100, 110];
const simulation = { seed: 42, paths: 256, steps: 4 };

function expectInputError(run: () => unknown, code: string): void {
  expect(run).toThrow(InputError);
  expect(run).toThrow(expect.objectContaining({ code }));
}

function expectTerminalRejection(position: Position): void {
  for (const run of [
    () => position.pnlAtExpiry(100),
    () => position.metrics(),
    () => position.payoff(),
    () => position.chartData(),
    () => position.probability({ ...market, expiry }),
    () => position.monteCarloProbability({ ...market, expiry, ...simulation }),
  ]) {
    expectInputError(run, 'strategy.multi_expiry_expiration_analytics');
  }
}

describe('raw stock plus dated options — single-option-horizon analytics', () => {
  const cases = [
    {
      name: 'covered call',
      options: [call],
      pnl: (s: number) => 100 * (s - 100 - Math.max(s - 105, 0) + 3),
      metrics: {
        netDebit: 9700,
        netCredit: -9700,
        maxProfit: 800,
        maxLoss: -9700,
        bounded: { profit: true, loss: true },
        breakevens: [97],
      },
    },
    {
      name: 'protective put',
      options: [put],
      pnl: (s: number) => 100 * (s - 100 + Math.max(95 - s, 0) - 2),
      metrics: {
        netDebit: 10200,
        netCredit: -10200,
        maxProfit: null,
        maxLoss: -700,
        bounded: { profit: false, loss: true },
        breakevens: [102],
      },
    },
    {
      name: 'collar',
      options: [put, call],
      pnl: (s: number) => 100 * (s - 100 + Math.max(95 - s, 0) - Math.max(s - 105, 0) + 1),
      metrics: {
        netDebit: 9900,
        netCredit: -9900,
        maxProfit: 600,
        maxLoss: -400,
        bounded: { profit: true, loss: true },
        breakevens: [99],
      },
    },
  ];

  describe.each(cases)('$name', ({ options, pnl, metrics }) => {
    it.each(['first', 'last'] as const)(
      'works with undated stock %s without mutating the legs',
      (order) => {
        const input = order === 'first' ? [stock, ...options] : [...options, stock];
        const before = input.map((leg) => ({ ...leg }));
        const position = strategy(input);
        const explicit = strategy(input, { expiry });

        expect(position.metrics()).toEqual(metrics);
        expect(position.payoff({ prices }).points).toEqual(
          prices.map((underlyingPrice) => ({ underlyingPrice, pnl: pnl(underlyingPrice) })),
        );
        for (const price of prices) expect(position.pnlAtExpiry(price)).toBe(pnl(price));
        expect(position.payoff()).toEqual(explicit.payoff());
        expect(position.chartData()).toEqual(explicit.chartData());

        const probability = position.probability(market);
        expect(probability).toEqual(explicit.probability(market));
        expect(probability.assumptions.timeToExpiryYears).toBe(horizon(expiry));
        expect(probability.assumptions.marketSource).toBe('merged');
        expect(probability.probabilityOfProfit).toBeGreaterThan(0);
        expect(probability.probabilityOfProfit).toBeLessThan(1);
        expect(Number.isFinite(probability.expectedValue)).toBe(true);
        expect(position.monteCarloProbability({ ...market, ...simulation })).toEqual(
          explicit.monteCarloProbability({ ...market, ...simulation }),
        );

        const mark = position.value(market);
        expect(mark.pnl).toBe(explicit.value(market).pnl);
        expect(mark.greeks).toEqual(explicit.value(market).greeks);
        expect(mark.assumptions.timeToExpiryYears).toBe(horizon(expiry));
        const include = { expirationPnl: true, currentPnl: true, delta: true, theta: true };
        expect(position.chartData({ market, prices: positivePrices, include })).toEqual(
          explicit.chartData({ market, prices: positivePrices, include }),
        );
        expect(position.scenarioTable({ market, prices: positivePrices })).toEqual(
          explicit.scenarioTable({ market, prices: positivePrices }),
        );
        const cube = { market, prices: positivePrices, daysForward: [0, 7] };
        expect(position.whatIfCube(cube)).toEqual(explicit.whatIfCube(cube));
        expect(position.value({ ...market, asOf: optionExpiryToMs(expiry) }).pnl).toBe(pnl(100));
        expect(position.legs.find((leg) => leg.kind === 'stock')!.expiry).toBeUndefined();
        expect(input).toEqual(before);
        expect(Object.isFrozen(position.legs)).toBe(true);
      },
    );
  });

  it('includes option-horizon breakevens in the automatic chart/scenario range', () => {
    const input = [stock, { ...call, premium: 30 }]; // breakeven 70 is outside entry/strike range
    const position = strategy(input);
    const explicit = strategy(input, { expiry });
    expect(position.metrics().breakevens).toEqual([70]);
    expect(position.payoff()).toEqual(explicit.payoff());
    expect(position.chartData()[0]!.underlyingPrice).toBeLessThan(70);
    expect(position.chartData({ market, include: { currentPnl: true } })).toEqual(
      explicit.chartData({ market, include: { currentPnl: true } }),
    );
    expect(position.scenarioTable({ market })).toEqual(explicit.scenarioTable({ market }));
  });

  it('refuses a stock row that carries an expiry, strike, premium or volatility (a stock is a stock)', () => {
    // B4: a stock row has no horizon and no option fields. A date on it used to be silently
    // ignored; now the row is closed to its own kind and a misplaced field teaches.
    for (const [row, field] of [
      [{ ...stock, expiry: farExpiry }, 'expiry'],
      [{ ...stock, strike: 100 }, 'strike'],
      [{ ...stock, premium: 3 }, 'premium'],
      [{ ...stock, impliedVolatility: 0.2 }, 'impliedVolatility'],
    ] as const) {
      expect(() => strategy([row as never, put, call])).toThrow(
        expect.objectContaining({ code: 'input.unknown_field' }),
      );
      expect(() => strategy([row as never, put, call])).toThrow(new RegExp(field));
    }
    // …and an option row has no share price.
    expect(() => strategy([stock, { ...put, price: 95 } as never])).toThrow(
      expect.objectContaining({ code: 'input.unknown_field' }),
    );
  });

  it('composes model-priced entry premiums with remembered market and inferred option expiry', () => {
    const position = strategy(
      [
        { kind: 'stock', quantity: 100 },
        { kind: 'call', strike: 105, quantity: -1, expiry },
      ],
      { premiums: 'model', market },
    );
    expect(position.premiumSource).toBe('model');
    expect(position.value().pnl).toBe(0);
    expect(position.probability().assumptions.timeToExpiryYears).toBe(horizon(expiry));
    expect(
      position.chartData({ include: { expirationPnl: true, currentPnl: true } }).length,
    ).toBeGreaterThan(1);
  });
});

describe('option expiry defaults and ambiguity', () => {
  it.each([
    {
      name: 'market default',
      option: legs.call({ strike: 105, premium: 3, quantity: -1 }),
      config: { market: { ...market, expiry } },
    },
    {
      name: 'config over market',
      option: legs.call({ strike: 105, premium: 3, quantity: -1 }),
      config: { expiry, market: { ...market, expiry: farExpiry } },
    },
    {
      name: 'leg over config and market',
      option: call,
      config: { expiry: farExpiry, market: { ...market, expiry: '2026-12-18' } },
    },
  ])('$name', ({ option, config }) => {
    const position = strategy([stock, option], config);
    expect(position.legs[1]!.expiry).toBe(expiry);
    expect(position.payoff()).toEqual(strategy([stock, call], { expiry }).payoff());
    expect(position.probability().assumptions.timeToExpiryYears).toBe(horizon(expiry));
    expect(position.value().assumptions.timeToExpiryYears).toBe(horizon(expiry));
    // The position owns its horizon: a foreign call-site expiry is refused; re-passing the
    // construction market's own expiry is accepted and the legs' expiry still governs (no phantom
    // horizon in the echo). `undefined` never erases a default.
    if (config.market.expiry === farExpiry) {
      expect(position.probability({ expiry: farExpiry }).assumptions.timeToExpiryYears).toBe(
        horizon(expiry),
      );
    } else {
      expect(() => position.probability({ expiry: farExpiry })).toThrow(
        /would price them at a horizon they do not have/,
      );
    }
    expect(position.probability({ expiry: undefined } as never)).toEqual(position.probability());
  });

  it('requires a default to resolve mixed dated/undated options, not a sibling option or stock date', () => {
    const { expiry: _expiry, ...undatedPut } = put;
    const input = [stock, call, undatedPut];
    const position = strategy(input);
    expectTerminalRejection(position);
    expectInputError(() => position.value(market), 'input.missing_field');
    expectInputError(() => position.scenarioTable({ market }), 'input.missing_field');
    expectInputError(
      () => position.chartData({ market, include: { currentPnl: true } }),
      'input.missing_field',
    );
    // Time-aware valuation can use an explicitly supplied horizon for the missing option.
    expect(Number.isFinite(position.value({ ...market, expiry }).pnl)).toBe(true);
    expect(strategy(input, { expiry }).payoff()).toEqual(
      strategy([stock, call, put], { expiry }).payoff(),
    );
    expectTerminalRejection(strategy(input, { expiry: farExpiry }));
  });

  it('allows all-undated symbolic payoffs but requires an explicit option horizon for market analytics', () => {
    const { expiry: _expiry, ...undatedCall } = call;
    const position = strategy([stock, undatedCall]);
    expect(position.pnlAtExpiry(100)).toBe(300);
    for (const run of [
      () => position.value(market),
      () => position.probability(market),
      () => position.monteCarloProbability({ ...market, ...simulation }),
    ])
      expectInputError(run, 'input.missing_field');
    expect(position.probability({ ...market, expiry })).toEqual(
      strategy([stock, undatedCall]).probability({ ...market, expiry }),
    );
  });

  it('preserves real calendar rejection beside an undated stock row', () => {
    {
      const datedStock = stock;
      const options = [call, { ...call, quantity: 1, premium: 5, expiry: farExpiry }];
      const position = strategy([datedStock, ...options]);
      expectTerminalRejection(position);
      expectTerminalRejection(strategy([datedStock, ...options], { expiry }));
      const base = strategy(options).value(market);
      const mark = position.value(market);
      expect(mark.pnl).toBeCloseTo(base.pnl, 10);
      expect(mark.greeks.delta).toBeCloseTo(base.greeks.delta + stock.quantity, 10);
      expect(mark.assumptions.timeToExpiryYears).toBeUndefined();
      // The dated options own their horizon: a contradicting call-site expiry is refused.
      expect(() => position.value({ ...market, expiry: '2031-12-19' })).toThrow(
        /would price them at a horizon they do not have/,
      );
      expect(
        position
          .chartData({ market, include: { currentPnl: true } })
          .every((row) => Number.isFinite(row.currentPnl)),
      ).toBe(true);
      expect(
        position.scenarioTable({ market }).value.every((row) => Number.isFinite(row.pnl)),
      ).toBe(true);
    }
  });
});

describe('stock-only and validation laws', () => {
  it.each([
    { name: 'undated stock', input: [stock] },
    { name: 'two stock rows', input: [stock, { ...stock, quantity: -20 }] },
  ])(
    'has no terminal expiry restriction or mark-to-market expiry requirement: $name',
    ({ input }) => {
      const position = strategy(input);
      expect(position.metrics().breakevens).toEqual([100]);
      expect(position.payoff().points.length).toBeGreaterThan(1);
      expect(position.chartData().length).toBeGreaterThan(1);
      const mark = position.value({ spot: 110, riskFreeRate: 0.03, asOf: market.asOf });
      expect(mark.pnl).toBe(input.reduce((total, leg) => total + 10 * leg.quantity, 0));
      expect(mark.assumptions.timeToExpiryYears).toBeUndefined();
      expect(position.probability({ ...market, expiry }).assumptions.timeToExpiryYears).toBe(
        horizon(expiry),
      );
      expectInputError(() => position.probability(market), 'input.missing_field');
    },
  );

  it.each([
    { expiry, market: { ...market, expiry: farExpiry } },
    { market: { ...market, expiry } },
    { expiry },
  ])('retains a configured stock-only probability horizon: %j', (config) => {
    for (const leg of [stock]) {
      const position = strategy([leg], config);
      expect(position.probability(market).assumptions.timeToExpiryYears).toBe(horizon(expiry));
      expect(
        position.monteCarloProbability({ ...market, ...simulation }).assumptions.timeToExpiryYears,
      ).toBe(horizon(expiry));
    }
  });

  it.each([null, 42, '', 'not-a-date'])(
    'does not weaken config expiry validation: %j',
    (badExpiry) => {
      expect(() => strategy([stock, call], { expiry: badExpiry } as PositionConfig)).toThrow(
        InputError,
      );
    },
  );

  it('preserves unknown config keys, non-finite legs, zero quantities and invalid option strikes', () => {
    expectInputError(
      () => strategy([stock, call], { expirry: expiry } as PositionConfig),
      'input.unknown_field',
    );
    for (const leg of [
      { ...stock, quantity: 0 },
      { ...stock, price: NaN },
      { ...call, quantity: Infinity },
      { ...call, strike: 0 },
    ] satisfies LegInput[])
      expect(() => strategy([stock, leg])).toThrow(InputError);
    const position = strategy([stock, call]);
    expectInputError(
      () => position.probability({ ...market, measure: 'realWorld' }),
      'input.missing_field',
    );
    expectInputError(
      () => position.monteCarloProbability({ ...market, ...simulation, seed: NaN }),
      'input.nan',
    );
  });
});
