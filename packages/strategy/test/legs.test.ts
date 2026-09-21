import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import {
  legs,
  strategy,
  listStrategies,
  buildStrategy,
  classifyStrategy,
  type OptionLegInput,
  type StockLegInput,
} from '@totalfinance/strategy';

function refusal(run: () => unknown, field: string, code?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputError);
  expect((caught as Error).message).toContain(field);
  if (code) expect((caught as InputError).code).toBe(code);
}

const market = {
  spot: 100,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-09-01T00:00:00Z',
  expiry: '2026-12-18',
};

describe('instrument-first signed leg constructors', () => {
  it('exposes exactly three canonical constructors, not direction aliases', () => {
    expect(Object.keys(legs)).toEqual(['call', 'put', 'stock']);
  });

  it.each(['call', 'put'] as const)(
    '%s preserves signed contracts and optional per-leg fields',
    (kind) => {
      for (const quantity of [1, -1, 3, -3, 0.5, -0.5]) {
        const input = {
          strike: 100,
          quantity,
          premium: 5,
          expiry: market.expiry,
          impliedVolatility: 0.3,
        };
        expect(legs[kind](input)).toEqual({ kind, ...input });
      }
      expect(legs[kind]({ strike: 100, quantity: -1, premium: undefined })).toEqual({
        kind,
        strike: 100,
        quantity: -1,
      });
    },
  );

  it('preserves stock shares and returns a plain interoperable record', () => {
    for (const quantity of [100, -100, 12.5, -12.5])
      expect(legs.stock({ price: 100, quantity })).toEqual({
        kind: 'stock',
        price: 100,
        quantity,
      });
  });

  it.each(['call', 'put', 'stock'] as const)(
    '%s refuses missing, zero and malformed quantities at its own boundary',
    (kind) => {
      const call = (input: unknown) =>
        kind === 'stock' ? legs.stock(input as StockLegInput) : legs[kind](input as OptionLegInput);
      const valid = kind === 'stock' ? { price: 100, quantity: -1 } : { strike: 100, quantity: -1 };
      for (const input of [undefined, null, [], 'call', 1, true])
        refusal(() => call(input), `legs.${kind}`);
      refusal(
        () => call({ ...valid, quantity: undefined }),
        'quantity',
        ErrorCode.InputMissingField,
      );
      for (const quantity of [0, -0])
        refusal(() => call({ ...valid, quantity }), 'quantity', ErrorCode.InputOutOfRange);
      for (const quantity of [null, '1', true, {}, [], NaN, Infinity, -Infinity])
        refusal(() => call({ ...valid, quantity }), 'quantity');
      refusal(() => call({ ...valid, quantitty: 2 }), 'quantitty', ErrorCode.InputUnknownField);
      refusal(() => call({ ...valid, side: 'short' }), 'side', ErrorCode.InputUnknownField);
    },
  );

  it.each(['call', 'put'] as const)(
    '%s validates every optional coordinate and teaches expiry errors',
    (kind) => {
      const call = (input: unknown) => legs[kind](input as OptionLegInput);
      const valid = { strike: 100, quantity: -1 };
      for (const strike of [undefined, null, '100', NaN, Infinity, -1, 0])
        refusal(() => call({ ...valid, strike }), 'strike');
      for (const premium of [null, '5', NaN, Infinity])
        refusal(() => call({ ...valid, premium }), 'premium');
      for (const impliedVolatility of [null, '0.2', NaN, Infinity, 0, -0.2])
        refusal(() => call({ ...valid, impliedVolatility }), 'impliedVolatility');
      for (const expiry of [null, 123, '', '2026-02-30', 'not-a-date', '2026-12-18T16:00:00'])
        refusal(() => call({ ...valid, expiry }), 'expiry');
      expect(call({ ...valid, expiry: '2026-12-18T16:00:00-05:00' })).toMatchObject({
        expiry: '2026-12-18T16:00:00-05:00',
      });
    },
  );

  it('stock requires a finite entry price and does not accept option-only coordinates', () => {
    for (const price of [undefined, null, '100', NaN, Infinity])
      refusal(() => legs.stock({ price, quantity: 10 } as StockLegInput), 'price');
    refusal(
      () => legs.stock({ price: 100, quantity: 10, strike: 100 } as StockLegInput),
      'strike',
      ErrorCode.InputUnknownField,
    );
  });

  it('raw records and constructors agree for custom ratios, payoff, per-leg volatility and Greeks', () => {
    const raw = strategy(
      [
        { kind: 'call', strike: 100, premium: 6, quantity: 2, impliedVolatility: 0.3 },
        { kind: 'call', strike: 110, premium: 2, quantity: -1, impliedVolatility: 0.25 },
      ],
      { expiry: market.expiry },
    );
    const built = strategy(
      [
        legs.call({ strike: 100, premium: 6, quantity: 2, impliedVolatility: 0.3 }),
        legs.call({ strike: 110, premium: 2, quantity: -1, impliedVolatility: 0.25 }),
      ],
      { expiry: market.expiry },
    );
    expect(built.payoff({ prices: [80, 90, 100, 110, 120] })).toEqual(
      raw.payoff({ prices: [80, 90, 100, 110, 120] }),
    );
    expect(
      built.payoff({ prices: [80, 90, 100, 110, 120] }).points.map((point) => point.pnl),
    ).toEqual([-1000, -1000, -1000, 1000, 2000]);
    expect(built.value(market)).toEqual(raw.value(market));
    const edited = strategy(
      built.legs.map((leg) => ({ ...leg, quantity: -leg.quantity })),
      { expiry: market.expiry },
    );
    expect(edited.pnlAtExpiry(120)).toBe(-built.pnlAtExpiry(120));
    expect(built.legs[0]!.quantity).toBe(2);
  });

  it('option multipliers never multiply stock shares and signed legs still support model premiums', () => {
    const position = strategy(
      [
        legs.stock({ price: 100, quantity: -10 }),
        legs.call({ strike: 100, premium: 2, quantity: 2 }),
      ],
      { multiplier: 50 },
    );
    expect(position.pnlAtExpiry(110)).toBe(700); // -10 × 10 + 2 × 50 × (10 - 2)
    const built = strategy([legs.put({ strike: 95, quantity: -2 })], { premiums: 'model', market });
    const raw = strategy([{ kind: 'put', strike: 95, quantity: -2 }], {
      premiums: 'model',
      market,
    });
    expect(built.legs).toEqual(raw.legs);
    expect(built.premiumSource).toBe('model');
  });

  it.each(listStrategies())(
    '$name keeps its preset identity, positive size and default composition',
    (preset) => {
      // Catalog examples include summer expiries; entry must precede every example's near expiry.
      const config = {
        premiums: 'model' as const,
        market: { ...market, asOf: '2026-01-02T00:00:00Z' },
      };
      const original = buildStrategy({ name: preset.name, input: preset.example, config });
      const doubled = buildStrategy({
        name: preset.name,
        input: { ...preset.example, quantity: 2 },
        config,
      });
      expect(doubled.legs).toEqual(
        original.legs.map((leg) => ({ ...leg, quantity: leg.quantity * 2 })),
      );
      expect(doubled.constructedAs).toBe(preset.name);
      expect(
        classifyStrategy(doubled.legs).matches.some((match) => match.name === preset.name),
      ).toBe(true);
      for (const quantity of [0, -1, NaN, Infinity, null, '2'])
        refusal(
          () =>
            buildStrategy({ name: preset.name, input: { ...preset.example, quantity }, config }),
          'quantity',
        );
    },
  );
});
