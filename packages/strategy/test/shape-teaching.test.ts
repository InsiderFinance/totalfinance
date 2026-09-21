import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { bullCallSpread, ironButterfly, ironCondor, strategy } from '@totalfinance/strategy';

/**
 * DX0 shape-teaching: a reasonable wrong guess at a builder's input must NOT crash with a raw
 * `TypeError` from deep in the build path. It throws a typed `InputError` that names the expected
 * slots and echoes the keys the caller actually passed — the error doubles as documentation.
 */

describe('strategy builders teach the right shape instead of crashing', () => {
  it('ironCondor with strike-suffixed guesses throws a typed error listing expected slots', () => {
    let caught: unknown;
    try {
      // A perfectly reasonable but wrong guess (app uses `putLongStrike`-style names).
      ironCondor({ putLongStrike: 540, putShortStrike: 550 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_shape')).toBe(true); // F15: a wrong SHAPE, not a missing field
    expect(caught instanceof TypeError).toBe(false);
    const msg = (caught as Error).message;
    expect(msg).toContain('putLong'); // expected shape names the real slots
    expect(msg).toContain('received keys: putLongStrike'); // echoes what the caller passed
  });

  it('a builder called with an empty object throws a typed error, never a raw TypeError', () => {
    let caught: unknown;
    try {
      bullCallSpread({} as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_shape')).toBe(true); // F15: a wrong SHAPE, not a missing field
    expect(caught instanceof TypeError).toBe(false);
  });

  it('a correctly-shaped call still builds a position', () => {
    const pos = ironCondor({
      putLong: { strike: 90, premium: 1 },
      putShort: { strike: 95, premium: 2 },
      callShort: { strike: 105, premium: 2 },
      callLong: { strike: 110, premium: 1 },
    });
    expect(pos.metrics().breakevens.length).toBeGreaterThan(0);
  });

  it('bare strike numbers are shorthand for { strike } (R3) — both spellings build the same legs', () => {
    const short = ironCondor(
      { putLong: 90, putShort: 95, callShort: 105, callLong: 110 },
      {
        premiums: 'model',
        market: {
          spot: 100,
          volatility: 0.2,
          riskFreeRate: 0.04,
          asOf: '2026-01-02T00:00:00Z',
          expiry: '2026-02-20',
        },
      },
    );
    const long = ironCondor(
      {
        putLong: { strike: 90 },
        putShort: { strike: 95 },
        callShort: { strike: 105 },
        callLong: { strike: 110 },
      },
      {
        premiums: 'model',
        market: {
          spot: 100,
          volatility: 0.2,
          riskFreeRate: 0.04,
          asOf: '2026-01-02T00:00:00Z',
          expiry: '2026-02-20',
        },
      },
    );
    expect(short.legs).toEqual(long.legs);
  });

  it('the retired nested `premiums` object is rejected with the leg-shape replacement, not ignored', () => {
    let caught: unknown;
    try {
      ironCondor({
        putLong: 90,
        putShort: 95,
        callShort: 105,
        callLong: 110,
        premiums: { putLong: 1 },
      } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('putLong: { strike: 540, premium: 3.4 }');
  });

  it('garbage in a role slot teaches `strike | { strike, premium? }`', () => {
    let caught: unknown;
    try {
      bullCallSpread({ long: 'hello', short: 105 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('{ strike, premium? }');
  });

  it('ironCondor and inverseIronCondor accept the SAME input value (one grammar)', async () => {
    const { inverseIronCondor } = await import('@totalfinance/strategy');
    const input = {
      putLong: { strike: 90, premium: 1 },
      putShort: { strike: 95, premium: 2 },
      callShort: { strike: 105, premium: 2 },
      callLong: { strike: 110, premium: 1 },
    };
    const condor = ironCondor(input);
    const inverse = inverseIronCondor(input);
    // Same strikes, mirrored signs.
    expect(condor.legs.map((l) => l.strike)).toEqual(inverse.legs.map((l) => l.strike));
    expect(condor.legs.map((l) => l.quantity)).toEqual(inverse.legs.map((l) => -l.quantity));
  });
});

describe('ironButterfly / inverseIronButterfly validate their slots (no raw TypeError)', () => {
  it('a missing body throws a teaching error naming body (wings present)', () => {
    let caught: unknown;
    try {
      ironButterfly({ putWing: 95, callWing: 115 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_shape')).toBe(true); // F15: a wrong SHAPE, not a missing field
    expect(caught instanceof TypeError).toBe(false);
    expect((caught as Error).message).toContain('body');
    expect((caught as Error).message).toContain('strategy.ironButterfly');
  });

  it('inverseIronButterfly guards the same slots', () => {
    let caught: unknown;
    try {
      strategy.inverseIronButterfly({ putWing: 95, callWing: 115 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_shape')).toBe(true); // F15: a wrong SHAPE, not a missing field
    expect((caught as Error).message).toContain('body');
  });

  it('garbage in the body slot teaches the shared-strike shape', () => {
    let caught: unknown;
    try {
      ironButterfly({ body: 'atm', putWing: 95, callWing: 115 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('{ strike, callPremium?, putPremium? }');
  });

  it('a bare body strike number is accepted as shorthand (R3), equal to { strike }', () => {
    const market = {
      spot: 100,
      volatility: 0.2,
      riskFreeRate: 0.04,
      asOf: '2026-01-02T00:00:00Z',
      expiry: '2026-02-20',
    };
    const short = ironButterfly(
      { body: 105, putWing: 95, callWing: 115 },
      { premiums: 'model', market },
    );
    const long = ironButterfly(
      { body: { strike: 105 }, putWing: 95, callWing: 115 },
      { premiums: 'model', market },
    );
    expect(short.legs).toEqual(long.legs);
  });
});

describe('slot errors carry the BUILDER name, not the bare namespace', () => {
  it('bullCallLadder names itself when a slot is garbage', () => {
    let caught: unknown;
    try {
      strategy.bullCallLadder({ lower: 'x', middle: 100, upper: 110 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toMatch(/^strategy\.bullCallLadder: lower/);
  });

  it('jadeLizard and longCallCondor name themselves too', () => {
    expect(() =>
      strategy.jadeLizard({ put: null, shortCall: 105, longCall: 115 } as never),
    ).toThrow(/strategy\.jadeLizard: put/);
    expect(() => strategy.longCallCondor({ k1: 90, k2: {}, k3: 105, k4: 110 } as never)).toThrow(
      /strategy\.longCallCondor: k2/,
    );
  });
});
