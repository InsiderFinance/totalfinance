/**
 * Count/resource safety, library-wide wave (2026-08-23 review, P0).
 *
 * `Number.isInteger(1e308)` is `true` and `counter++` stops advancing at 2^53, so a workload
 * control (paths, steps, grid points, averaging fixings, boundary points) validated with
 * `Number.isInteger` and then looped or allocated was a non-terminating loop or an absurd
 * allocation. Every such head in this package now refuses non-safe integers with a typed teaching
 * and carries an operation-appropriate cap that names its own boundary — with the paths × dimensions
 * PRODUCT bounded where the two multiply into the real workload (the reviewer-named mc/core case).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError, resolvedExpiry } from '@totalfinance/core';
import type { OptionContract, OptionMarket } from '@totalfinance/options';
import { americanExercise, engines, heston } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { asian } from '@totalfinance/options/exotics';
import { equityLattice } from '@totalfinance/options/lattice';
import { monteCarloEstimate } from '../src/mc/core.js';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const ABSURD = [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 2.5] as const;

const mcEstimate = (paths: number, dimensions = 1): unknown =>
  monteCarloEstimate({
    dimensions,
    payoff: (z) => z[0]!,
    options: { paths, seed: 1 },
  });

describe('2026-08-23 P0 — monteCarloEstimate paths/dimensions (reviewer-named case)', () => {
  it('refuses 2^53, 2^53 + 2, 1e308, −2^53, and a fraction for paths and dimensions', () => {
    for (const bad of ABSURD) {
      const paths = caught(() => mcEstimate(bad));
      expect(isQuantError(paths, 'input.out_of_range'), `paths = ${bad}`).toBe(true);
      const dims = caught(() => mcEstimate(1_000, bad));
      expect(isQuantError(dims, 'input.out_of_range'), `dimensions = ${bad}`).toBe(true);
    }
  });

  it('cap + 1 paths is refused naming the 10,000,000 bound and the 1/√n reason', () => {
    const error = caught(() => mcEstimate(10_000_001));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('10,000,000');
    expect(String((error as Error).message)).toContain('1/√n');
  });

  it('paths × dimensions is bounded as a PRODUCT even when each factor is under its own cap', () => {
    // 100,000 paths (fine alone) × 1,000 dimensions (fine alone) = 10^8 draws > the 5×10^7 cap.
    const error = caught(() => mcEstimate(100_000, 1_000));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('paths × dimensions');
    expect(String((error as Error).message)).toContain('50,000,000');
  });

  it('a realistic estimate still runs (E[z] ≈ 0)', () => {
    const est = monteCarloEstimate({
      dimensions: 2,
      payoff: (z) => z[0]! + z[1]!,
      options: { paths: 4_000, seed: 7 },
    });
    expect(Math.abs(est.value)).toBeLessThan(0.1);
  });
});

describe('2026-08-27 P0 — engine factories validate captured simulation budgets immediately', () => {
  it('the GBM Monte-Carlo factory refuses invalid paths before returning an engine', () => {
    for (const bad of ABSURD) {
      const error = caught(() => engines.monteCarlo({ paths: bad, seed: 1 }));
      expect(isQuantError(error, 'input.out_of_range'), `paths = ${bad}`).toBe(true);
    }
  });

  it('the local-volatility factory refuses invalid steps and the paths × steps product', () => {
    const surface = (): number => 0.2;
    for (const bad of ABSURD) {
      const error = caught(() =>
        engines.localVolatility(surface, { paths: 200, seed: 1, steps: bad }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `steps = ${bad}`).toBe(true);
    }
    const product = caught(() =>
      engines.localVolatility(surface, { paths: 100_000, seed: 1, steps: 1_000 }),
    );
    expect(isQuantError(product, 'input.out_of_range')).toBe(true);
    expect(String((product as Error).message)).toContain('paths × dimensions');
  });
});

describe('2026-08-23 P0 — lattice and engine resolution parameters', () => {
  const latticeAt = (steps: number): unknown =>
    equityLattice({ spot: 100, riskFreeRate: 0.04, volatility: 0.2, horizonYears: 1, steps });

  it('equityLattice steps refuses absurd counts and teaches the 25,000 cap (steps²/2 nodes)', () => {
    for (const bad of ABSURD) {
      const error = caught(() => latticeAt(bad));
      expect(isQuantError(error, 'input.out_of_range'), `steps = ${bad}`).toBe(true);
    }
    const overCap = caught(() => latticeAt(25_001));
    expect(isQuantError(overCap, 'input.out_of_range')).toBe(true);
    expect(String((overCap as Error).message)).toContain('25,000');
    expect(String((overCap as Error).message)).toContain('steps²/2');
    // The documented CRR-stability case (rate 1.0, σ 0.01 needs > 10^4 steps) still fits under it.
    expect(() =>
      equityLattice({
        spot: 100,
        riskFreeRate: 1,
        volatility: 0.01,
        horizonYears: 1,
        steps: 20_000,
      }),
    ).not.toThrow();
  });

  it('a realistic lattice rollback still converges to Black–Scholes', () => {
    const lattice = equityLattice({
      spot: 100,
      riskFreeRate: 0.04,
      volatility: 0.2,
      horizonYears: 1,
      steps: 501,
    });
    const price = lattice.rollback(
      (spot) => Math.max(0, spot - 100),
      (node) =>
        node.discount * (node.upProbability * node.up + (1 - node.upProbability) * node.down),
    );
    const reference = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.04,
      dividendYield: 0,
      volatility: 0.2,
    });
    expect(price).toBeCloseTo(reference, 1);
  });

  it('tree engines refuse absurd steps at CONFIG time, naming the 25,000 cap', () => {
    for (const bad of [2 ** 53, 1e308, 25_001]) {
      const binomial = caught(() => engines.binomial({ steps: bad }));
      expect(isQuantError(binomial, 'input.out_of_range'), `binomial steps = ${bad}`).toBe(true);
      const trinomial = caught(() => engines.trinomial({ steps: bad }));
      expect(isQuantError(trinomial, 'input.out_of_range'), `trinomial steps = ${bad}`).toBe(true);
    }
    expect(String((caught(() => engines.binomial({ steps: 25_001 })) as Error).message)).toContain(
      '25,000',
    );
    expect(() => engines.binomial({ variant: 'leisen-reimer', steps: 501 })).not.toThrow();
    expect(() => engines.trinomial({ steps: 301 })).not.toThrow();
  });

  it('Crank–Nicolson bounds each axis AND the gridPoints × timeSteps product', () => {
    for (const bad of [2 ** 53, 1e308, 100_001]) {
      const grid = caught(() => engines.finiteDifference.crankNicolson({ gridPoints: bad }));
      expect(isQuantError(grid, 'input.out_of_range'), `gridPoints = ${bad}`).toBe(true);
      const time = caught(() => engines.finiteDifference.crankNicolson({ timeSteps: bad }));
      expect(isQuantError(time, 'input.out_of_range'), `timeSteps = ${bad}`).toBe(true);
    }
    // 20,000 × 10,000 = 2×10^8 cells: each axis is legal alone, the product is not.
    const product = caught(() =>
      engines.finiteDifference.crankNicolson({ gridPoints: 20_000, timeSteps: 10_000 }),
    );
    expect(isQuantError(product, 'input.out_of_range')).toBe(true);
    expect(String((product as Error).message)).toContain('gridPoints × timeSteps');
    expect(String((product as Error).message)).toContain('100,000,000');
    expect(() =>
      engines.finiteDifference.crankNicolson({ gridPoints: 200, timeSteps: 200 }),
    ).not.toThrow();
  });
});

describe('2026-08-26 P0 — Heston COS terms are bounded before expansion work', () => {
  const parameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.7 };
  const input = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.04,
    dividendYield: 0,
  };

  it('refuses unsafe, fractional, and above-cap term counts on both public forms', () => {
    for (const bad of [...ABSURD, 8_193]) {
      const raw = caught(() =>
        heston.cosineExpansion({ type: 'call', ...input, parameters, terms: bad }),
      );
      expect(isQuantError(raw, 'input.out_of_range'), `raw terms = ${bad}`).toBe(true);
      const facade = caught(() =>
        heston.price({ type: 'call', input, parameters, options: { terms: bad } }),
      );
      expect(isQuantError(facade, 'input.out_of_range'), `facade terms = ${bad}`).toBe(true);
      const factory = caught(() => engines.heston(parameters, { terms: bad }));
      expect(isQuantError(factory, 'input.out_of_range'), `factory terms = ${bad}`).toBe(true);
    }
    expect(
      String(
        (
          caught(() =>
            heston.price({ type: 'call', input, parameters, options: { terms: 8_193 } }),
          ) as Error
        ).message,
      ),
    ).toContain('8,192');
  });
});

describe('2026-08-23 P0 — Asian averaging points and exercise boundary points', () => {
  const asianInput = (averagingPoints: number) =>
    ({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.04,
      volatility: 0.2,
      averagingPoints,
    }) as const;

  it('averagingPoints refuses absurd fixings and teaches the 100,000 cap', () => {
    for (const bad of ABSURD) {
      const error = caught(() => asian.geometricPrice(asianInput(bad)));
      expect(isQuantError(error, 'input.out_of_range'), `averagingPoints = ${bad}`).toBe(true);
    }
    const overCap = caught(() => asian.geometricPrice(asianInput(100_001)));
    expect(String((overCap as Error).message)).toContain('100,000');
    expect(String((overCap as Error).message)).toContain('fixing');
    expect(asian.geometricPrice(asianInput(252)).value).toBeGreaterThan(0); // one year, daily fixings
  });

  it('Monte-Carlo owns averagingPoints in exactly one argument and validates it there', () => {
    const input = {
      type: 'call' as const,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    for (const bad of ABSURD) {
      const error = caught(() =>
        asian.monteCarloPrice(input, { paths: 200, seed: 1, averagingPoints: bad }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `averagingPoints = ${bad}`).toBe(true);
    }
    const duplicate = caught(() =>
      asian.monteCarloPrice({ ...input, averagingPoints: 12 } as never, {
        paths: 200,
        seed: 1,
        averagingPoints: 12,
      }),
    );
    expect(isQuantError(duplicate, 'input.unknown_field')).toBe(true);
  });

  const EXPIRY = '2027-01-15';
  const put: OptionContract = {
    underlying: 'XYZ',
    type: 'put',
    style: 'american',
    strike: 100,
    expiry: EXPIRY,
    ...resolvedExpiry(EXPIRY),
  };
  const market: OptionMarket = {
    spot: 100,
    riskFreeRate: 0.05,
    volatility: 0.25,
    asOf: '2026-01-15T00:00:00Z',
  };

  it('boundaryPoints refuses absurd resolutions and teaches the 10,000 cap (one root-solve per point)', () => {
    for (const bad of [2 ** 53, 1e308, -(2 ** 53), 2.5]) {
      const error = caught(() =>
        americanExercise({ contract: put, market, options: { boundaryPoints: bad } }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `boundaryPoints = ${bad}`).toBe(true);
    }
    const overCap = caught(() =>
      americanExercise({ contract: put, market, options: { boundaryPoints: 10_001 } }),
    );
    expect(String((overCap as Error).message)).toContain('10,000');
    expect(String((overCap as Error).message)).toContain('root-solve');
    const ok = americanExercise({ contract: put, market, options: { boundaryPoints: 12 } });
    expect(ok.boundary.length).toBe(12);
  });
});
