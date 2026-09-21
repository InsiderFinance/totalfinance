/**
 * Preview P1 — `MarkToMarketInput.legVolatilities`: per-call, per-leg volatility overrides so a
 * position built at entry volatilities can be marked from CURRENT quotes without rebuilding it.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { explainPosition, strategy } from '@totalfinance/strategy';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const EXPIRY = '2026-06-19';
const AS_OF = '2026-03-02T00:00:00Z'; // a valuation instant names its time of day
const market = { spot: 100, asOf: AS_OF, riskFreeRate: 0.04, dividendYield: 0 };

describe('Position.value legVolatilities (Preview P1)', () => {
  const position = strategy(
    [
      {
        kind: 'put',
        strike: 95,
        premium: 1.2,
        quantity: -1,
        impliedVolatility: 0.2,
        expiry: EXPIRY,
      },
      {
        kind: 'put',
        strike: 90,
        premium: 0.5,
        quantity: 1,
        impliedVolatility: 0.22,
        expiry: EXPIRY,
      },
    ],
    { multiplier: 100 },
  );
  const t = position.value({ ...market }).perLeg[0]!.greeks; // warm-up: shape only
  void t;

  it('prices an overridden leg at the override and leaves undefined entries on the leg’s own volatility', () => {
    const base = position.value({ ...market });
    const marked = position.value({ ...market, legVolatilities: [0.3, undefined] });
    expect(marked.assumptions.volatilitySource).toBe('perCall');
    expect(base.assumptions.volatilitySource).toBe('perLeg');
    const timeToExpiryYears =
      (Date.UTC(2026, 5, 19, 20) - Date.UTC(2026, 2, 2)) / (365 * 86_400_000);
    const price = (volatility: number, strike: number) =>
      blackScholesPrice({
        type: 'put',
        spot: 100,
        strike,
        timeToExpiryYears,
        riskFreeRate: 0.04,
        dividendYield: 0,
        volatility,
      });
    // Leg 0 (short 95 put) repriced at 0.30; leg 1 unchanged at its own 0.22.
    expect(marked.perLeg[0]!.value).toBeCloseTo(-100 * price(0.3, 95), 6);
    expect(marked.perLeg[1]!.value).toBeCloseTo(base.perLeg[1]!.value, 12);
    expect(marked.pnl).not.toBe(base.pnl);
    // A no-op override array reproduces the base mark exactly.
    expect(position.value({ ...market, legVolatilities: [undefined, undefined] }).pnl).toBe(
      base.pnl,
    );
  });

  it('composes with volatilityShock and a position-level volatility for legs without their own', () => {
    const bare = strategy(
      [{ kind: 'put', strike: 95, premium: 1.2, quantity: -1, expiry: EXPIRY }],
      { multiplier: 100 },
    );
    expect(codeOf(() => bare.value({ ...market }))).toBe(ErrorCode.InputMissingField);
    const overridden = bare.value({ ...market, legVolatilities: [0.25] });
    expect(overridden.assumptions.volatilitySource).toBe('perCall');
    const shocked = bare.value({ ...market, legVolatilities: [0.25], volatilityShock: 0.05 });
    expect(shocked.pnl).toBe(bare.value({ ...market, legVolatilities: [0.3] }).pnl);
  });

  it('explainPosition validates market.legVolatilities the same way (null and misalignment teach)', () => {
    expect(
      codeOf(() =>
        explainPosition(position, { market: { ...market, legVolatilities: null } as never }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() => explainPosition(position, { market: { ...market, legVolatilities: [0.3] } })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        explainPosition(position, { market: { ...market, legVolatilities: [0.3, -1] } }),
      ),
    ).toBe(ErrorCode.InputNegativeVolatility);
    expect(
      codeOf(() =>
        explainPosition(position, { market: { ...market, legVolatilities: [0.3, undefined] } }),
      ),
    ).toBeUndefined();
  });

  it('validates the override array: aligned to the legs, each stated entry a positive volatility', () => {
    expect(codeOf(() => position.value({ ...market, legVolatilities: [0.3] }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => position.value({ ...market, legVolatilities: null as never }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => position.value({ ...market, legVolatilities: [-0.1, undefined] }))).toBe(
      ErrorCode.InputNegativeVolatility,
    );
    // NaN is not negative — core's positivity guard names it for what it is.
    expect(codeOf(() => position.value({ ...market, legVolatilities: [NaN, undefined] }))).toBe(
      'input.nan',
    );
  });
});
