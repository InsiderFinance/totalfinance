/**
 * Cliquet / ratchet options (`cliquet`). The Black-76 caplet-strip closed form is pinned by its
 * Monte-Carlo corroboration (locally-capped and uncapped), a global cap lowers the value while a global
 * floor is non-binding under a non-negative local floor, the value is monotone in the local cap, the
 * closed form refuses a global constraint, and the guards hold.
 */

import { describe, expect, it } from 'vitest';
import { cliquet } from '@totalfinance/options';

const BASE = {
  spot: 100,
  resetTimes: [0.25, 0.5, 0.75, 1.0],
  riskFreeRate: 0.05,
  volatility: 0.25,
  dividendYield: 0.02,
  notional: 100,
};

describe('cliquet', () => {
  it('the analytic matches the Monte-Carlo (no global constraint) — locally-capped and uncapped', () => {
    const monteCarlo = { paths: 400_000, seed: 9 };
    for (const localCap of [0.05, Infinity]) {
      const input = { ...BASE, localFloor: 0, localCap };
      const a = cliquet.price(input).value;
      const m = cliquet.monteCarloPrice(input, monteCarlo);
      expect(Math.abs(m.value - a)).toBeLessThan(5 * m.monteCarlo.standardError!);
    }
  });

  it('a global cap lowers the value; a global floor is non-binding under a non-negative local floor', () => {
    const monteCarlo = { paths: 200_000, seed: 3 };
    const base = { ...BASE, localFloor: 0, localCap: 0.05 };
    const noGlobal = cliquet.monteCarloPrice(base, monteCarlo).value;
    const capped = cliquet.monteCarloPrice({ ...base, globalCap: 0.12 }, monteCarlo).value;
    const floored = cliquet.monteCarloPrice({ ...base, globalFloor: 0 }, monteCarlo).value;
    expect(capped).toBeLessThan(noGlobal); // the 12% total cap bites
    expect(floored).toBeCloseTo(noGlobal, 8); // localFloor 0 ⇒ Σ ≥ 0 already, so the global floor 0 does nothing
  });

  it('the value is monotone increasing in the local cap', () => {
    const v3 = cliquet.price({ ...BASE, localFloor: 0, localCap: 0.03 }).value;
    const v7 = cliquet.price({ ...BASE, localFloor: 0, localCap: 0.07 }).value;
    const vInf = cliquet.price({ ...BASE, localFloor: 0 }).value; // uncapped
    expect(v3).toBeLessThan(v7);
    expect(v7).toBeLessThan(vInf);
  });

  it('the value scales with notional', () => {
    const one = cliquet.price({ ...BASE, notional: 1, localCap: 0.05 }).value;
    const hundred = cliquet.price({ ...BASE, notional: 100, localCap: 0.05 }).value;
    expect(hundred).toBeCloseTo(100 * one, 10);
  });

  it('the closed form refuses a global cap or floor (directs to monteCarloPrice)', () => {
    expect(() => cliquet.price({ ...BASE, globalCap: 0.1 })).toThrowError();
    expect(() => cliquet.price({ ...BASE, globalFloor: 0 })).toThrowError();
    // monteCarloPrice handles them.
    expect(() =>
      cliquet.monteCarloPrice({ ...BASE, globalCap: 0.1 }, { paths: 1000, seed: 1 }),
    ).not.toThrowError();
  });

  it('guards a bad reset schedule, cap/floor ordering, and inputs', () => {
    expect(() => cliquet.price(undefined as never)).toThrowError();
    expect(() => cliquet.price({ ...BASE, resetTimes: [] })).toThrowError(); // no resets
    expect(() => cliquet.price({ ...BASE, resetTimes: [0.5, 0.25] })).toThrowError(); // not increasing
    expect(() => cliquet.price({ ...BASE, resetTimes: [0, 0.5] })).toThrowError(); // t₁ = 0
    expect(() => cliquet.price({ ...BASE, localFloor: 0.1, localCap: 0.05 })).toThrowError(); // cap ≤ floor
    expect(() => cliquet.price({ ...BASE, localFloor: -1.5 })).toThrowError(); // floor < −1
    expect(() => cliquet.price({ ...BASE, spot: -1 })).toThrowError();
    expect(() =>
      cliquet.monteCarloPrice(
        { ...BASE, globalFloor: 0.2, globalCap: 0.1 },
        { paths: 100, seed: 1 },
      ),
    ).toThrowError(); // globalCap ≤ globalFloor
  });
});
