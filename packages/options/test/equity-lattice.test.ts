/**
 * Tests for the generic equity binomial lattice: a European payoff rolled back through it converges to
 * Black-Scholes, an American put shows a positive early-exercise premium, and both CRR and Jarrow-Rudd
 * variants agree.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type LatticeNode } from '@totalfinance/options';
import { equityLattice } from '@totalfinance/options/lattice';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const S = 100;
const K = 100;
const r = 0.05;
const q = 0;
const sigma = 0.2;
const T = 1;

/** Risk-neutral discounted continuation (no early exercise). */
const european = (n: LatticeNode): number =>
  n.discount * (n.upProbability * n.up + (1 - n.upProbability) * n.down);

describe('equity binomial lattice', () => {
  it('a European call rolled back converges to Black-Scholes', () => {
    const tree = equityLattice({
      spot: S,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      horizonYears: T,
      steps: 600,
    });
    const price = tree.rollback((spot) => Math.max(spot - K, 0), european);
    expect(price).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
      }),
      2,
    );
  });

  it('a European put matches BSM under both variants', () => {
    const ref = blackScholesPrice({
      type: 'put',
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
    });
    for (const variant of ['crr', 'jarrow-rudd'] as const) {
      const tree = equityLattice({
        spot: S,
        riskFreeRate: r,
        volatility: sigma,
        horizonYears: T,
        steps: 600,
        variant,
      });
      const price = tree.rollback((spot) => Math.max(K - spot, 0), european);
      expect(price).toBeCloseTo(ref, 1);
    }
  });

  it('an American put has a positive early-exercise premium over the European put', () => {
    const tree = equityLattice({
      spot: S,
      riskFreeRate: r,
      volatility: sigma,
      horizonYears: T,
      steps: 600,
    });
    const americanPut = tree.rollback(
      (spot) => Math.max(K - spot, 0),
      (n) => Math.max(european(n), K - n.spot), // exercise = max(continuation, intrinsic)
    );
    const europeanPut = tree.rollback((spot) => Math.max(K - spot, 0), european);
    expect(americanPut).toBeGreaterThan(europeanPut);
    expect(americanPut).toBeGreaterThan(
      blackScholesPrice({
        type: 'put',
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
      }) - 1e-6,
    );
  });

  it('spotAt lays out the recombining grid', () => {
    const tree = equityLattice({
      spot: 100,
      riskFreeRate: r,
      volatility: sigma,
      horizonYears: T,
      steps: 4,
    });
    expect(tree.spotAt(0, 0)).toBeCloseTo(100, 10);
    expect(tree.spotAt(2, 2)).toBeGreaterThan(tree.spotAt(2, 1)); // up > mid
    expect(tree.spotAt(2, 0)).toBeLessThan(tree.spotAt(2, 1)); // down < mid
  });

  it('spotAt teaches invalid node coordinates', () => {
    const tree = equityLattice({
      spot: S,
      riskFreeRate: r,
      volatility: sigma,
      horizonYears: T,
      steps: 10,
    });
    for (const [stepIndex, upMoveCount] of [
      [2.5, 1],
      [2 ** 53, 1],
      [-1, 0],
      [11, 1],
      [4, -1],
      [4, 5],
    ]) {
      expect(() => tree.spotAt(stepIndex!, upMoveCount!)).toThrow(InputError);
    }
  });

  it('rejects bad parameters', () => {
    expect(() =>
      equityLattice({ spot: -1, riskFreeRate: r, volatility: sigma, horizonYears: T }),
    ).toThrow(/spot/);
    expect(() =>
      equityLattice({ spot: S, riskFreeRate: r, volatility: sigma, horizonYears: T, steps: 0 }),
    ).toThrow(/steps/);
  });

  it('rejects parameters that push the CRR up-probability outside [0, 1]', () => {
    // rate ≫ volatility over one coarse step ⇒ p ≈ 86, a meaningless "probability".
    expect(() =>
      equityLattice({ spot: 100, riskFreeRate: 1, volatility: 0.01, horizonYears: 1, steps: 1 }),
    ).toThrow(/unstable|probability/);
    // The same horizonYears with enough steps (dt < (σ/(r−q))² = 1e-4 ⇒ steps > 1e4) is stable.
    expect(() =>
      equityLattice({
        spot: 100,
        riskFreeRate: 1,
        volatility: 0.01,
        horizonYears: 1,
        steps: 20000,
      }),
    ).not.toThrow();
  });
});
