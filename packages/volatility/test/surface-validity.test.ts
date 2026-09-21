import { describe, expect, it } from 'vitest';
import { type OptionQuote, isQuantError, resolvedExpiry } from '@totalfinance/core';
import { volatilitySurface } from '@totalfinance/volatility';

/**
 * Regression for an external-review finding: a VolatilitySurface reported `converged: true` around invalid
 * data — an infinite spot/IV built a NaN surface, and a shock could drive implied vol non-positive
 * with no warning.
 */
const asOf = Date.UTC(2026, 6, 13);
const chain = (): OptionQuote[] =>
  [90, 95, 100, 105, 110].map((K) => ({
    contract: {
      underlying: 'X',
      type: 'call',
      style: 'european',
      strike: K,
      expiry: '2026-08-21',
      ...resolvedExpiry('2026-08-21'),
    },
    timestampMs: asOf,
    impliedVolatility: 0.2 + Math.abs(K - 100) * 0.002,
    underlyingPrice: 100,
  }));

describe('vol surface — no converged:true around invalid data', () => {
  it('rejects a non-finite global spot instead of building a NaN surface', () => {
    let caught: unknown;
    try {
      volatilitySurface({ quotes: chain(), market: { spot: Infinity, riskFreeRate: 0.04, asOf } });
    } catch (e) {
      caught = e;
    }
    // input.not_finite at the dotted path replaced the bespoke negative_spot here — Infinity was
    // never "negative", and the generated ladder's code is the accurate one (350c2796 taxonomy).
    expect(isQuantError(caught, 'input.not_finite')).toBe(true);
  });

  it('skips a quote with a non-finite implied vol rather than propagating NaN', () => {
    const withInfImpliedVolatility: OptionQuote[] = [
      ...chain(),
      {
        contract: {
          underlying: 'X',
          type: 'call',
          style: 'european',
          strike: 115,
          expiry: '2026-08-21',
          ...resolvedExpiry('2026-08-21'),
        },
        timestampMs: asOf,
        impliedVolatility: Infinity,
        underlyingPrice: 100,
      },
    ];
    const surf = volatilitySurface({
      quotes: withInfImpliedVolatility,
      market: { spot: 100, riskFreeRate: 0.04, asOf },
    });
    expect(
      surf.slices.every((s) => s.impliedVolatilities.every((v) => Number.isFinite(v) && v > 0)),
    ).toBe(true);
  });

  it('a clean interpolated surface reports converged: true', () => {
    expect(
      volatilitySurface({ quotes: chain(), market: { spot: 100, riskFreeRate: 0.04, asOf } })
        .diagnostics.converged,
    ).toBe(true);
  });

  it('a shock that drives vol non-positive floors it and warns (no silent negative σ)', () => {
    const shocked = volatilitySurface({
      quotes: chain(),
      market: { spot: 100, riskFreeRate: 0.04, asOf },
    }).shock({
      parallel: -0.5,
    });
    expect(shocked.diagnostics.warnings.some((w) => w.code === 'volatility.shock_floored')).toBe(
      true,
    );
    expect(shocked.slices.every((s) => s.impliedVolatilities.every((v) => v > 0))).toBe(true);
  });

  // Review finding: `quotes` was never validated — undefined died on "quotes is not iterable", and a
  // STRING iterates character-by-character into a raw destructure TypeError at `quote.contract`.
  it('rejects a missing / non-array quotes argument with a teaching error, not a raw TypeError', () => {
    const market = { spot: 100, riskFreeRate: 0.04, asOf };
    // Absent is MISSING (four-code matrix), not wrong-typed: the old array guard pinned
    // wrong-type-for-absence in place.
    expect(() => volatilitySurface({ quotes: undefined as never, market })).toThrow(
      /quotes is required/,
    );
    expect(() => volatilitySurface({ quotes: 'hello' as never, market })).toThrow(
      /quotes must be an array/,
    );
    let caught: unknown;
    try {
      volatilitySurface({ quotes: 'hello' as never, market });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
  });

  it('rejects quotes whose elements are not OptionQuotes by naming the expected shape', () => {
    let caught: unknown;
    try {
      volatilitySurface({ quotes: [{}] as never, market: { spot: 100, riskFreeRate: 0.04, asOf } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/OptionQuote/);
    expect((caught as Error).message).toMatch(/contract/);
  });
});
