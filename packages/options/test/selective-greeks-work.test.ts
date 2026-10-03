import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MathModule from '@totalfinance/math';

/**
 * Unrequested work is SKIPPED, not merely discarded (selective Greeks spec, decision 1): the
 * normal-distribution primitives are counted, because they are the expensive part of every
 * Black–Scholes evaluation and the part a selection is meant to avoid.
 */
const counts = vi.hoisted(() => ({ cumulative: 0, density: 0 }));
vi.mock('@totalfinance/math', async (importOriginal) => {
  const actual = await importOriginal<typeof MathModule>();
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
const { blackScholesEvaluateMany, blackScholesEvaluateManyInto, blackScholesPriceMany } =
  await import('@totalfinance/options/batch');

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

describe('the batch family pays per row only for what was requested', () => {
  const ROWS = 40;
  const columns = {
    spot: Float64Array.from({ length: ROWS }, (_, i) => 90 + i),
    strike: new Float64Array(ROWS).fill(105),
    volatility: new Float64Array(ROWS).fill(0.2),
    riskFreeRate: new Float64Array(ROWS).fill(0.04),
    timeToExpiryYears: new Float64Array(ROWS).fill(0.25),
    type: Int8Array.from({ length: ROWS }, (_, i) => (i % 2 === 0 ? 1 : -1)),
    dividendYield: new Float64Array(ROWS).fill(0.01),
  };

  it('a gamma sweep evaluates one density and no cumulative normal per row', () => {
    expect(measure(() => blackScholesEvaluateMany(columns, { outputs: ['gamma'] }))).toEqual({
      cumulative: 0,
      density: ROWS,
    });
    const gamma = new Float64Array(ROWS);
    expect(measure(() => blackScholesEvaluateManyInto(columns, { gamma }))).toEqual({
      cumulative: 0,
      density: ROWS,
    });
  });

  it('delta plus gamma shares one pass: one cumulative and one density per row', () => {
    expect(
      measure(() => blackScholesEvaluateMany(columns, { outputs: ['delta', 'gamma'] })),
    ).toEqual({ cumulative: ROWS, density: ROWS });
  });

  it('blackScholesPriceMany with Greeks is now one pass (it was a price pass plus a full Greeks call per row)', () => {
    // Before: 2 cumulative normals per row for price, then blackScholesGreeks' 4 cumulative + 1 density.
    expect(measure(() => blackScholesPriceMany(columns, { greeks: true }))).toEqual({
      cumulative: 2 * ROWS,
      density: ROWS,
    });
    expect(measure(() => blackScholesPriceMany(columns))).toEqual({
      cumulative: 2 * ROWS,
      density: 0,
    });
  });
});
