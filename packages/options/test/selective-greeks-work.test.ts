import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unrequested work is SKIPPED, not merely discarded (selective Greeks spec, decision 1): the
 * normal-distribution primitives are counted, because they are the expensive part of every
 * Black–Scholes evaluation and the part a selection is meant to avoid.
 */
const counts = vi.hoisted(() => ({ cumulative: 0, density: 0 }));
vi.mock('@totalfinance/math', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totalfinance/math')>();
  return {
    ...actual,
    normalCdf: (x: number) => {
      counts.cumulative++;
      return actual.normalCdf(x);
    },
    normalPdf: (x: number) => {
      counts.density++;
      return actual.normalPdf(x);
    },
  };
});

const { blackScholes, blackScholesGreeks } = await import('@totalfinance/options/black-scholes');

const input = {
  type: 'call' as const,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0.01,
  volatility: 0.2,
};

function measure(run: () => unknown): { cumulative: number; density: number } {
  counts.cumulative = 0;
  counts.density = 0;
  run();
  return { cumulative: counts.cumulative, density: counts.density };
}

describe('selective evaluation skips what was not requested', () => {
  beforeEach(() => {
    counts.cumulative = 0;
    counts.density = 0;
  });

  it('each named Greek evaluates only the distribution terms its formula uses', () => {
    expect(measure(() => blackScholes.gamma(input))).toEqual({ cumulative: 0, density: 1 });
    expect(measure(() => blackScholes.vega(input))).toEqual({ cumulative: 0, density: 1 });
    expect(measure(() => blackScholes.delta(input))).toEqual({ cumulative: 1, density: 0 });
    expect(measure(() => blackScholes.rho(input))).toEqual({ cumulative: 1, density: 0 });
    expect(measure(() => blackScholes.theta(input))).toEqual({ cumulative: 2, density: 1 });
  });

  it('a selection shares intermediates: each cumulative/density term is evaluated at most once', () => {
    expect(measure(() => blackScholes.evaluate({ ...input, outputs: ['price', 'delta'] }))).toEqual(
      {
        cumulative: 2,
        density: 0,
      },
    );
    expect(
      measure(() =>
        blackScholes.evaluate({ ...input, outputs: ['gamma', 'vanna', 'vomma', 'speed', 'color'] }),
      ),
    ).toEqual({ cumulative: 0, density: 1 });
    expect(
      measure(() =>
        blackScholes.evaluate({
          ...input,
          outputs: [
            'price',
            'delta',
            'gamma',
            'theta',
            'vega',
            'rho',
            'vanna',
            'charm',
            'vomma',
            'speed',
            'color',
          ],
        }),
      ),
    ).toEqual({ cumulative: 2, density: 1 });
  });

  it('for contrast, the existing all-Greeks kernel evaluates four cumulative normals', () => {
    expect(measure(() => blackScholesGreeks(input))).toEqual({ cumulative: 4, density: 1 });
  });
});
