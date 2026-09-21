import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { mulberry32, normalSample } from '@totalfinance/math';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { gbmPath } from '@totalfinance/options/monte-carlo';
import {
  type BarrierType,
  type LookbackStrike,
  asian,
  barrier,
  lookback,
} from '@totalfinance/options/exotics';

// ── Barrier ──────────────────────────────────────────────────────────────────

describe('Barrier — analytic structure', () => {
  const base = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
  } as const;

  it('knock-in + knock-out = vanilla (in/out parity)', () => {
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.25,
    });
    const di = barrier.price({ type: 'call', barrierType: 'down-in', ...base, barrier: 90 }).value;
    const dout = barrier.price({
      type: 'call',
      barrierType: 'down-out',
      ...base,
      barrier: 90,
    }).value;
    expect(di + dout).toBeCloseTo(vanilla, 9);

    const ui = barrier.price({ type: 'call', barrierType: 'up-in', ...base, barrier: 120 }).value;
    const uo = barrier.price({ type: 'call', barrierType: 'up-out', ...base, barrier: 120 }).value;
    expect(ui + uo).toBeCloseTo(vanilla, 9);
  });

  it('an already-breached barrier collapses to 0 (out) or vanilla (in)', () => {
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.25,
    });
    expect(
      barrier.price({ type: 'call', barrierType: 'down-out', ...base, barrier: 105 }).value,
    ).toBe(0);
    expect(
      barrier.price({ type: 'call', barrierType: 'down-in', ...base, barrier: 105 }).value,
    ).toBeCloseTo(vanilla, 12);
  });

  it('a knock-out is worth less than the vanilla', () => {
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.25,
    });
    const dout = barrier.price({
      type: 'call',
      barrierType: 'down-out',
      ...base,
      barrier: 90,
    }).value;
    expect(dout).toBeLessThan(vanilla);
    expect(dout).toBeGreaterThan(0);
  });
});

describe('Barrier — analytic cross-validated against Brownian-bridge Monte-Carlo', () => {
  const cases = [
    { type: 'call', bt: 'down-out', K: 100, H: 90 },
    { type: 'call', bt: 'down-in', K: 85, H: 90 }, // K < H branch
    { type: 'put', bt: 'up-out', K: 100, H: 115 },
    { type: 'call', bt: 'up-in', K: 100, H: 120 },
  ] as const;
  for (const { type, bt, K, H } of cases) {
    it(`${bt} ${type} (K=${K}, H=${H})`, () => {
      const input = {
        spot: 100,
        strike: K,
        barrier: H,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.25,
      };
      const analytic = barrier.price({ ...input, type, barrierType: bt }).value;
      const monteCarlo = barrier.monteCarloPrice(
        { ...input, type, barrierType: bt },
        { paths: 60_000, seed: 123, steps: 120 },
      );
      expect(monteCarlo.monteCarlo.standardError).toBeGreaterThan(0);
      expect(Math.abs(analytic - monteCarlo.value)).toBeLessThan(
        4 * monteCarlo.monteCarlo.standardError! + 0.05,
      );
    });
  }
});

// ── Asian ────────────────────────────────────────────────────────────────────

function bruteAsian(
  type: 'call' | 'put',
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  m: number,
  paths: number,
  seed: number,
): { arith: number; geo: number } {
  const randomNumberGenerator = mulberry32(seed);
  const df = Math.exp(-r * T);
  let sa = 0;
  let sg = 0;
  for (let p = 0; p < paths; p++) {
    const z = Array.from({ length: m }, () => normalSample(randomNumberGenerator));
    const path = gbmPath({
      spot: S,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      timeToExpiryYears: T,
      shocks: z,
    });
    let sum = 0;
    let logSum = 0;
    for (let i = 1; i <= m; i++) {
      sum += path[i]!;
      logSum += Math.log(path[i]!);
    }
    const A = sum / m;
    const G = Math.exp(logSum / m);
    sa += df * Math.max(0, type === 'call' ? A - K : K - A);
    sg += df * Math.max(0, type === 'call' ? G - K : K - G);
  }
  return { arith: sa / paths, geo: sg / paths };
}

describe('Asian — geometric closed form', () => {
  it('m=1 averaging reduces to the European (BSM) price exactly', () => {
    const r = 0.04;
    const q = 0.01;
    const sigma = 0.3;
    for (const [type, K] of [
      ['call', 100],
      ['put', 110],
    ] as const) {
      const geo = asian.geometricPrice({
        type,
        spot: 100,
        strike: K,
        timeToExpiryYears: 1,
        riskFreeRate: r,
        volatility: sigma,
        dividendYield: q,
        averagingPoints: 1,
      });
      expect(geo.value).toBeCloseTo(
        blackScholesPrice({
          type,
          spot: 100,
          strike: K,
          timeToExpiryYears: 1,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sigma,
        }),
        10,
      );
    }
  });

  it('matches a brute-force geometric-average Monte-Carlo', () => {
    const input = {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.25,
      averagingPoints: 12,
    };
    const closed = asian.geometricPrice({ ...input, type: 'call' }).value;
    const brute = bruteAsian('call', 100, 100, 1, 0.05, 0, 0.25, 12, 120_000, 99).geo;
    expect(Math.abs(closed - brute)).toBeLessThan(0.05);
  });
});

describe('Asian — arithmetic via geometric control variate', () => {
  const input = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
  };

  it('matches a brute-force arithmetic Monte-Carlo, with a far smaller standard error', () => {
    const res = asian.monteCarloPrice(
      { ...input, type: 'call' },
      { paths: 40_000, seed: 7, averagingPoints: 12 },
    );
    const brute = bruteAsian('call', 100, 100, 1, 0.05, 0, 0.25, 12, 120_000, 7).arith;
    expect(res.monteCarlo.varianceReduction.controlVariate).toBe(true);
    expect(Math.abs(res.value - brute)).toBeLessThan(0.05);
    // the geometric control variate makes the SE tiny
    expect(res.monteCarlo.standardError).toBeLessThan(0.01);
  });

  it('arithmetic ≥ geometric (AM–GM) and both below the vanilla (averaging dampens vol)', () => {
    const arith = asian.monteCarloPrice(
      { ...input, type: 'call' },
      { paths: 40_000, seed: 11, averagingPoints: 12 },
    ).value;
    const geo = asian.geometricPrice({ ...input, type: 'call', averagingPoints: 12 }).value;
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.25,
    });
    expect(arith).toBeGreaterThan(geo - 1e-6);
    expect(arith).toBeLessThan(vanilla);
  });
});

// ── Lookback ─────────────────────────────────────────────────────────────────

describe('Lookback — analytic cross-validated against BGK-corrected Monte-Carlo', () => {
  const cases = [
    { strike: 'floating', type: 'call' },
    { strike: 'floating', type: 'put' },
    { strike: 'fixed', type: 'call', K: 100 },
    { strike: 'fixed', type: 'put', K: 100 },
  ] as const;
  for (const c of cases) {
    it(`${c.strike} ${c.type}`, () => {
      const input = {
        spot: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.06,
        volatility: 0.25,
        dividendYield: 0.02,
        ...('K' in c ? { strike: c.K } : {}),
      };
      const analytic = lookback.price({ ...input, type: c.type, strikeType: c.strike }).value;
      const monteCarlo = lookback.monteCarloPrice(
        { ...input, type: c.type, strikeType: c.strike },
        {
          paths: 40_000,
          seed: 555,
          steps: 200,
        },
      );
      expect(analytic).toBeGreaterThan(0);
      expect(monteCarlo.monteCarlo.standardError).toBeGreaterThan(0);
      // lookback discrete↔continuous bias is the hardest; BGK correction + 200 steps gets close.
      expect(Math.abs(analytic - monteCarlo.value)).toBeLessThan(
        4 * monteCarlo.monteCarlo.standardError! + 0.25,
      );
    });
  }

  it('a floating-strike lookback call is worth more than the at-the-money vanilla', () => {
    const input = {
      spot: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.06,
      volatility: 0.25,
      dividendYield: 0.02,
    };
    const lb = lookback.price({ ...input, type: 'call', strikeType: 'floating' }).value;
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.06,
      dividendYield: 0.02,
      volatility: 0.25,
    });
    expect(lb).toBeGreaterThan(vanilla);
  });
});

describe('exotics — input validation', () => {
  it('fixed-strike lookback requires a strike', () => {
    expect(() =>
      lookback.price({
        type: 'call',
        strikeType: 'fixed',
        spot: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.25,
      }),
    ).toThrow();
  });
  it('Asian rejects a non-positive averaging-point count', () => {
    expect(() =>
      asian.geometricPrice({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.25,
        averagingPoints: 0,
      }),
    ).toThrow();
  });

  it('rejects an unknown barrierType / strikeType instead of returning a bogus result', () => {
    const bIn = {
      spot: 100,
      strike: 100,
      barrier: 90,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.25,
    };
    expect(() =>
      barrier.price({ ...bIn, type: 'call', barrierType: 'bogus' as unknown as BarrierType }),
    ).toThrow(InputError);
    expect(() =>
      barrier.monteCarloPrice(
        { ...bIn, type: 'call', barrierType: 'bogus' as unknown as BarrierType },
        { paths: 1000, seed: 1 },
      ),
    ).toThrow(InputError);

    const lIn = {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.25,
    };
    expect(() =>
      lookback.price({ ...lIn, type: 'call', strikeType: 'bogus' as unknown as LookbackStrike }),
    ).toThrow(InputError);
    expect(() =>
      lookback.monteCarloPrice(
        { ...lIn, type: 'call', strikeType: 'bogus' as unknown as LookbackStrike },
        { paths: 1000, seed: 1 },
      ),
    ).toThrow(InputError);
  });
});
