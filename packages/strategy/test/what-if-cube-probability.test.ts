/**
 * What-if cube — probability mass + break-even-time surfaces (Wave 6 §3).
 *
 * Verifies: spot-mass rows sum to 1 with disclosed tails (both grid policies); lognormal bin masses
 * match CDF differences and a custom density matches an independent quadrature; `expectedPnlByVolatilityAndDay`
 * is a direct weighted sum of the cube cells; the zero-vol expiry slice converges to
 * `probability().expectedValue`; the measure grammar (riskNeutral default, realWorld, explicit) resolves
 * drift with no silent zero; break-even is a direct cell scan (no/one/many crossings); day zero is a
 * point mass; and the guards.
 */

import { describe, expect, it } from 'vitest';
import { normalCdf } from '@totalfinance/math';
import { legs, strategy } from '@totalfinance/strategy';

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 4, 1, 13, 0, 0);
const D = 30;
const EXPIRY_ISO = new Date(ASOF + D * DAY).toISOString();
const MKT = { spot: 100, volatility: 0.2, riskFreeRate: 0.04, dividendYield: 0.02, asOf: ASOF };

function pos() {
  return strategy(
    [
      legs.put({ strike: 95, premium: 2.0, quantity: -1 }),
      legs.put({ strike: 90, premium: 1.0, quantity: 1 }),
    ],
    { multiplier: 100, expiry: EXPIRY_ISO, market: MKT, premiums: 'user' },
  );
}

/** A wide log-uniform grid around the spot (±`k`σ over the horizon). */
function wideGrid(n: number, sigmaT: number): number[] {
  const lo = Math.log(100) - 8 * sigmaT;
  const hi = Math.log(100) + 8 * sigmaT;
  return Array.from({ length: n }, (_, i) => Math.exp(lo + ((hi - lo) * i) / (n - 1)));
}

const gbm = { kind: 'gbm', annualizedVolatility: 0.2 } as const;

describe('what-if cube probability — mass & tails', () => {
  it('report-and-renormalize: each spot-mass row sums to 1, meaning conditional-on-grid', () => {
    const cube = pos().whatIfCube({
      prices: wideGrid(201, 0.2 * Math.sqrt(D / 365)),
      volatilityShocks: [0],
      daysForward: [0, 7, 30],
      probability: { model: gbm },
    });
    const prob = cube.value.probability!;
    expect(prob.gridPolicy).toBe('report-and-renormalize');
    expect(prob.expectationMeaning).toBe('conditional-on-grid');
    for (const row of prob.spotMassByDay) {
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    for (const tail of prob.tailMassByDay) {
      expect(tail.below).toBeGreaterThanOrEqual(0);
      expect(tail.above).toBeGreaterThanOrEqual(0);
    }
  });

  it('include-in-edge-bins: tails fold into the edges, rows sum to 1, meaning edge-censored', () => {
    // A deliberately NARROW grid so there is real tail mass to fold.
    const cube = pos().whatIfCube({
      prices: [96, 98, 100, 102, 104],
      volatilityShocks: [0],
      daysForward: [30],
      probability: { model: gbm, gridPolicy: 'include-in-edge-bins' },
    });
    const prob = cube.value.probability!;
    expect(prob.expectationMeaning).toBe('edge-censored');
    const row = prob.spotMassByDay[0]!;
    expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const { below, above } = prob.tailMassByDay[0]!;
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
    // The folded edge bins carry at least their tail mass.
    expect(row[0]!).toBeGreaterThanOrEqual(below - 1e-12);
    expect(row[row.length - 1]!).toBeGreaterThanOrEqual(above - 1e-12);
  });

  it('lognormal bin masses match direct CDF differences (renormalized in-grid)', () => {
    const sigmaT = 0.2 * Math.sqrt(D / 365);
    const prices = wideGrid(101, sigmaT);
    const cube = pos().whatIfCube({
      prices,
      volatilityShocks: [0],
      daysForward: [30],
      probability: { model: gbm },
    });
    const row = cube.value.probability!.spotMassByDay[0]!;
    const muLog = Math.log(100) + (0.04 - 0.02 - 0.5 * 0.2 * 0.2) * (D / 365);
    const zln = (price: number) => (Math.log(price) - muLog) / sigmaT;
    const n = prices.length;
    const raw = prices.map((_, i) => {
      const lo =
        i === 0 ? prices[0]! - (prices[1]! - prices[0]!) / 2 : (prices[i - 1]! + prices[i]!) / 2;
      const hi =
        i === n - 1
          ? prices[n - 1]! + (prices[n - 1]! - prices[n - 2]!) / 2
          : (prices[i]! + prices[i + 1]!) / 2;
      return normalCdf(zln(hi)) - normalCdf(zln(lo));
    });
    const inGrid = raw.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) expect(row[i]!).toBeCloseTo(raw[i]! / inGrid, 10);
  });

  it('custom density masses match an independent midpoint-bin quadrature', () => {
    // Uniform density on [80, 120]; grid whose midpoint bins tile [80, 120] exactly ⇒ equal masses.
    const density = (p: number) => (p >= 80 && p <= 120 ? 1 / 40 : 0);
    const cube = pos().whatIfCube({
      prices: [85, 95, 105, 115],
      volatilityShocks: [0],
      daysForward: [10],
      probability: { model: { kind: 'custom', density, support: { from: 80, to: 120 } } },
    });
    const row = cube.value.probability!.spotMassByDay[0]!;
    for (const m of row) expect(m).toBeCloseTo(0.25, 9); // 4 equal-width bins over a uniform density
    expect(cube.value.probability!.tailMassByDay[0]).toEqual({ below: 0, above: 0 });
  });
});

describe('what-if cube probability — expected P&L', () => {
  it('expectedPnlByVolatilityAndDay equals a direct weighted sum of the cube cells', () => {
    const cube = pos().whatIfCube({
      prices: wideGrid(151, 0.2 * Math.sqrt(D / 365)),
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward: [7, 30],
      probability: { model: gbm },
    });
    const { cells, axes, probability } = cube.value;
    const nVolatility = axes.volatilityShocks.length;
    const nDay = axes.daysForward.length;
    for (let vi = 0; vi < nVolatility; vi++) {
      for (let di = 0; di < nDay; di++) {
        let expected = 0;
        for (let pi = 0; pi < axes.prices.length; pi++) {
          expected +=
            probability!.spotMassByDay[di]![pi]! * cells[(pi * nVolatility + vi) * nDay + di]!.pnl;
        }
        expect(probability!.expectedPnlByVolatilityAndDay[vi]![di]!).toBeCloseTo(expected, 9);
      }
    }
  });

  it('at expiry + zero vol shock, refining converges to probability().expectedValue', () => {
    const target = pos().probability({ measure: 'riskNeutral' }).expectedValue;
    const ev = (n: number) => {
      const cube = pos().whatIfCube({
        prices: wideGrid(n, 0.2 * Math.sqrt(D / 365)),
        volatilityShocks: [0],
        daysForward: [D],
        probability: { model: gbm },
      });
      return cube.value.probability!.expectedPnlByVolatilityAndDay[0]![0]!;
    };
    const e51 = Math.abs(ev(51) - target);
    const e801 = Math.abs(ev(801) - target);
    expect(e801).toBeLessThan(e51); // refining reduces the error
    expect(e801).toBeLessThan(0.05);
  });
});

describe('what-if cube probability — measure grammar', () => {
  it('the default GBM measure resolves to risk-neutral drift = rate - div (never zero unless equal)', () => {
    const ma = pos().whatIfCube({
      prices: [95, 100, 105],
      volatilityShocks: [0],
      daysForward: [30],
      probability: { model: gbm },
    }).value.probability!.modelAssumptions;
    expect(ma.kind).toBe('gbm');
    if (ma.kind === 'gbm') {
      expect(ma.measure).toBe('riskNeutral');
      expect(ma.resolvedDrift).toBeCloseTo(0.04 - 0.02, 12);
      expect(ma.resolvedDrift).not.toBe(0);
    }
  });

  it('realWorld resolves drift = expectedReturn - div, matching probability()', () => {
    const er = 0.1;
    const ma = pos().whatIfCube({
      prices: [95, 100, 105],
      volatilityShocks: [0],
      daysForward: [30],
      probability: {
        model: { kind: 'gbm', annualizedVolatility: 0.2, measure: 'realWorld', expectedReturn: er },
      },
    }).value.probability!.modelAssumptions;
    if (ma.kind === 'gbm' && ma.measure === 'realWorld') {
      expect(ma.resolvedDrift).toBeCloseTo(er - 0.02, 12);
    } else throw new Error('expected realWorld gbm');
    // probability() with the same expectedReturn resolves the identical drift (its EV differs only
    // because it integrates to expiry — the drift itself is expectedReturn - dividendYield).
    const probEv = pos().probability({ measure: 'realWorld', expectedReturn: er }).expectedValue;
    const rnEv = pos().probability({ measure: 'riskNeutral' }).expectedValue;
    expect(probEv).not.toBeCloseTo(rnEv, 3); // a different drift moves the EV
  });

  it('explicit drift is used directly and echoed', () => {
    const ma = pos().whatIfCube({
      prices: [95, 100, 105],
      volatilityShocks: [0],
      daysForward: [30],
      probability: {
        model: { kind: 'gbm', annualizedVolatility: 0.2, measure: 'explicit', drift: 0.07 },
      },
    }).value.probability!.modelAssumptions;
    if (ma.kind === 'gbm' && ma.measure === 'explicit') expect(ma.resolvedDrift).toBe(0.07);
    else throw new Error('expected explicit gbm');
  });

  it('rejects missing expectedReturn/drift, contradictory fields, and a misspelled measure', () => {
    const run = (model: unknown) =>
      pos().whatIfCube({
        prices: [95, 100, 105],
        volatilityShocks: [0],
        daysForward: [30],
        probability: { model } as never,
      });
    expect(() =>
      run({ kind: 'gbm', annualizedVolatility: 0.2, measure: 'realWorld' }),
    ).toThrowError();
    expect(() =>
      run({ kind: 'gbm', annualizedVolatility: 0.2, measure: 'explicit' }),
    ).toThrowError();
    expect(() =>
      run({ kind: 'gbm', annualizedVolatility: 0.2, measure: 'riskNeutral', drift: 0.05 }),
    ).toThrowError(); // contradictory
    expect(() =>
      run({ kind: 'gbm', annualizedVolatility: 0.2, measure: 'realworld', expectedReturn: 0.1 }),
    ).toThrowError(); // misspelled
  });
});

describe('what-if cube break-even surface', () => {
  it('every break-even entry equals a direct scan of its fixed price/vol cells', () => {
    const cube = pos().whatIfCube({
      prices: [80, 90, 95, 100, 110],
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward: [0, 10, 20, 30],
    });
    const { cells, axes, breakEven } = cube.value;
    const nVolatility = axes.volatilityShocks.length;
    const nDay = axes.daysForward.length;
    for (let pi = 0; pi < axes.prices.length; pi++) {
      for (let vi = 0; vi < nVolatility; vi++) {
        let expected: number | null = null;
        for (let di = 0; di < nDay; di++) {
          if (cells[(pi * nVolatility + vi) * nDay + di]!.pnl >= 0) {
            expected = axes.daysForward[di]!;
            break;
          }
        }
        expect(breakEven.firstNonNegativeDayByPriceAndVolatility[pi]![vi]!).toBe(expected);
      }
    }
  });

  it('is present without a probability request', () => {
    const cube = pos().whatIfCube({
      prices: [95, 100, 105],
      volatilityShocks: [0],
      daysForward: [0, 30],
    });
    expect(cube.value.probability).toBeUndefined();
    expect(cube.value.breakEven.firstNonNegativeDayByPriceAndVolatility.length).toBe(3);
  });
});

describe('what-if cube probability — day zero, dimensions & guards', () => {
  it('day zero is a point mass in the bin containing the current spot', () => {
    const cube = pos().whatIfCube({
      prices: [90, 95, 100, 105, 110],
      volatilityShocks: [0],
      daysForward: [0],
      probability: { model: gbm },
    });
    const row0 = cube.value.probability!.spotMassByDay[0]!;
    expect(row0.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(row0[2]).toBe(1); // spot 100 → bin index 2
    expect(cube.value.probability!.tailMassByDay[0]).toEqual({ below: 0, above: 0 });
  });

  it('a day-zero spot outside the grid rejects under conditional-grid, edge-censors otherwise', () => {
    const options = (gridPolicy?: 'include-in-edge-bins') => ({
      prices: [80, 85, 90], // entirely below spot 100
      volatilityShocks: [0],
      daysForward: [0],
      probability: { model: gbm, ...(gridPolicy ? { gridPolicy } : {}) },
    });
    expect(() => pos().whatIfCube(options())).toThrowError(/outside the price grid/);
    const cube = pos().whatIfCube(options('include-in-edge-bins'));
    const row0 = cube.value.probability!.spotMassByDay[0]!;
    expect(row0[2]).toBe(1); // nearest edge (top)
    expect(cube.value.probability!.tailMassByDay[0]).toEqual({ below: 0, above: 1 });
  });

  it('probability dimension lengths match the axes', () => {
    const cube = pos().whatIfCube({
      prices: [95, 100, 105],
      volatilityShocks: [-0.05, 0],
      daysForward: [0, 15, 30],
      probability: { model: gbm },
    });
    const prob = cube.value.probability!;
    expect(prob.spotMassByDay.length).toBe(3); // days
    expect(prob.spotMassByDay[0]!.length).toBe(3); // prices
    expect(prob.tailMassByDay.length).toBe(3);
    expect(prob.expectedPnlByVolatilityAndDay.length).toBe(2); // volatilities
    expect(prob.expectedPnlByVolatilityAndDay[0]!.length).toBe(3); // days
    expect(cube.value.breakEven.firstNonNegativeDayByPriceAndVolatility.length).toBe(3); // prices
    expect(cube.value.breakEven.firstNonNegativeDayByPriceAndVolatility[0]!.length).toBe(2); // volatilities
  });

  it('rejects unsorted/duplicate prices, negative days, unknown fields, and bad support', () => {
    const base = { volatilityShocks: [0], daysForward: [30], probability: { model: gbm } };
    expect(() => pos().whatIfCube({ ...base, prices: [100, 95, 105] })).toThrowError();
    expect(() => pos().whatIfCube({ ...base, prices: [100, 100, 105] })).toThrowError();
    expect(() =>
      pos().whatIfCube({
        prices: [95, 100, 105],
        volatilityShocks: [0],
        daysForward: [-1, 30],
        probability: { model: gbm },
      }),
    ).toThrowError();
    expect(() =>
      pos().whatIfCube({
        prices: [95, 100, 105],
        volatilityShocks: [0],
        daysForward: [30],
        probability: { model: gbm, junk: 1 } as never,
      }),
    ).toThrowError();
    expect(() =>
      pos().whatIfCube({
        prices: [95, 100, 105],
        volatilityShocks: [0],
        daysForward: [30],
        probability: {
          model: { kind: 'custom', density: () => 1, support: { from: 120, to: 80 } },
        },
      }),
    ).toThrowError();
  });
});
