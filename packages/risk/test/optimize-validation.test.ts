/**
 * Regression tests for the optimizer review (extended constraints honored everywhere, infeasible
 * problems never report converged:true, and thin extended-constraint validation tightened).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  conditionalValueAtRiskOptimize,
  kelly,
  maxSharpe,
  meanVariance,
  minVariance,
} from '@totalfinance/risk/optimize';

const cov3: number[][] = [
  [0.04, 0.002, 0.001],
  [0.002, 0.05, 0.003],
  [0.001, 0.003, 0.06],
];
const mu3 = [0.1, 0.12, 0.08];
const groupSum = (w: number[], members: number[]): number => members.reduce((s, m) => s + w[m]!, 0);

describe('[P1] extended constraints are honored by maxSharpe and kelly', () => {
  it('maxSharpe respects a sector/group cap (was silently dropped → ~1.0 exposure)', () => {
    const r = maxSharpe({
      mean: mu3,
      covariance: cov3,
      options: { longOnly: true, groups: [{ members: [0, 1], max: 0.5 }] },
    });
    expect(r.diagnostics.converged).toBe(true);
    expect(groupSum(r.value.weights, [0, 1])).toBeLessThanOrEqual(0.5 + 1e-4);
  });

  it('maxSharpe respects a turnover budget', () => {
    const prev = [1, 0, 0];
    const r = maxSharpe({
      mean: mu3,
      covariance: cov3,
      options: { longOnly: true, turnover: { previousWeights: prev, max: 0.5 } },
    });
    const turn = r.value.weights.reduce((s, w, i) => s + Math.abs(w - prev[i]!), 0);
    expect(turn).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('kelly projects onto a group cap rather than only box/budget', () => {
    const r = kelly({
      mean: mu3,
      covariance: cov3,
      options: {
        normalize: true,
        longOnly: true,
        groups: [{ members: [0, 1], max: 0.5 }],
      },
    });
    expect(groupSum(r.value.weights, [0, 1])).toBeLessThanOrEqual(0.5 + 1e-4);
  });
});

describe('[P1] infeasible extended constraints report converged:false', () => {
  it('min-variance: a group cap that cannot reach the budget does not converge', () => {
    // all three assets capped at 0.4 in aggregate, but Σw must equal 1 ⇒ infeasible
    const r = minVariance(cov3, { longOnly: true, groups: [{ members: [0, 1, 2], max: 0.4 }] });
    expect(r.diagnostics.converged).toBe(false);
  });

  it('CVaR: an impossible return floor does not converge (no fabricated success)', () => {
    const scenarios = [
      [0.01, 0.02],
      [0.005, 0.015],
      [-0.01, 0.0],
      [0.02, 0.03],
    ];
    const r = conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.9,
      longOnly: true,
      minReturn: 0.5,
      maximumIterations: 300,
    });
    expect(r.diagnostics.converged).toBe(false);
  });
});

describe('[P2] extended-constraint vector validation', () => {
  it('turns malformed nested group objects into typed teachings, never raw TypeErrors', () => {
    expect(() => minVariance(cov3, { groups: [null] } as never)).toThrow(
      /constraints\.groups\[0\] must be an object/,
    );
    expect(() => minVariance(cov3, { groups: [{ members: [0], maximum: 0.5 }] } as never)).toThrow(
      /unknown field "maximum".*Allowed fields: members, min, max/s,
    );
  });

  it('refuses inherited optimizer options instead of silently enabling them', () => {
    expect(() => minVariance(cov3, Object.create({ longOnly: true }) as never)).toThrow(
      /plain object|inherited/,
    );

    Object.defineProperty(Object.prototype, 'longOnly', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
    try {
      expect(() => minVariance(cov3, {})).toThrow(/longOnly.*inherited/);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['longOnly'];
    }
  });

  it('rejects a coercion object without executing valueOf', () => {
    let valueOfCalled = false;
    const coercionTrap = {
      valueOf(): number {
        valueOfCalled = true;
        throw new Error('must not execute caller coercion');
      },
    };
    expect(() => minVariance(cov3, { tolerance: coercionTrap } as never)).toThrow(
      /tolerance must be a number/,
    );
    expect(valueOfCalled).toBe(false);
  });

  it('requires exact dense [lower, upper] tuples without executing accessors', () => {
    expect(() => minVariance(cov3, { bounds: [[0], [0, 1], [0, 1]] } as never)).toThrow(
      /exactly \[lower, upper\]/,
    );
    const sparse = new Array<number>(2);
    expect(() => minVariance(cov3, { bounds: [sparse, [0, 1], [0, 1]] } as never)).toThrow(
      /dense array/,
    );

    let getterCalled = false;
    const accessor = [0, 1];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute');
      },
    });
    expect(() => minVariance(cov3, { bounds: [accessor, [0, 1], [0, 1]] } as never)).toThrow(
      /accessor-backed/,
    );
    expect(getterCalled).toBe(false);
  });

  it('rejects out-of-range / non-integer group members', () => {
    expect(() => minVariance(cov3, { groups: [{ members: [5], max: 0.5 }] })).toThrow(
      /member index/,
    );
    expect(() => minVariance(cov3, { groups: [{ members: [1.5], max: 0.5 }] })).toThrow(
      /member index/,
    );
  });

  it('rejects duplicate members before projection and violation accounting can disagree', () => {
    expect(() => minVariance(cov3, { groups: [{ members: [0, 0], max: 0.5 }] })).toThrow(
      /duplicated/,
    );
  });

  it('rejects a turnover.prev whose length does not match the asset count', () => {
    expect(() => minVariance(cov3, { turnover: { previousWeights: [1, 0], max: 0.5 } })).toThrow(
      /turnover.prev/,
    );
  });

  it('rejects a transactionCosts.prev of the wrong length and a non-finite prev', () => {
    expect(() =>
      minVariance(cov3, { transactionCosts: { perUnitTurnover: 0.01, previousWeights: [1, 0] } }),
    ).toThrow(/transactionCosts.prev/);
    expect(() =>
      minVariance(cov3, {
        transactionCosts: { perUnitTurnover: 0.01, previousWeights: [1, 0, NaN] },
      }),
    ).toThrow(/finite/);
  });

  it('conditionalValueAtRiskOptimize rejects non-finite scenario data instead of returning NaN CVaR', () => {
    expect(() =>
      conditionalValueAtRiskOptimize([
        [0.1, NaN],
        [0.2, 0.1],
      ]),
    ).toThrow(/finite/);
  });

  it('conditionalValueAtRiskOptimize rejects bad step / maximumIterations knobs', () => {
    const s = [
      [0.01, 0.02],
      [0.0, 0.01],
    ];
    expect(() => conditionalValueAtRiskOptimize(s, { step: 0 })).toThrow(/step/);
    expect(() => conditionalValueAtRiskOptimize(s, { maximumIterations: 1.5 })).toThrow(
      /maximumIterations/,
    );
    expect(() =>
      conditionalValueAtRiskOptimize(s, {
        conditionalValueAtRiskMaximumIterations: 100,
      } as never),
    ).toThrow(/unknown field.*conditionalValueAtRiskMaximumIterations.*maximumIterations/s);
  });

  it('scenario cells and option contexts never execute caller coercion or toJSON hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('toJSON must not execute');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('Symbol.toPrimitive must not execute');
      },
    };
    const scenarios = [
      [0.01, 0.02],
      [0, 0.01],
    ];
    const runs = [
      () =>
        conditionalValueAtRiskOptimize([
          [hostile, 0],
          [0, 0],
        ] as never),
      () => minVariance(cov3, { longOnly: hostile } as never),
      () => minVariance(cov3, { budget: hostile } as never),
      () => minVariance(cov3, { tolerance: hostile } as never),
      () =>
        conditionalValueAtRiskOptimize(scenarios, {
          turnover: { previousWeights: [1, 0], max: hostile },
        } as never),
    ];

    for (const run of runs) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(isQuantError(caught)).toBe(true);
      expect(() => JSON.stringify(caught)).not.toThrow();
    }
    expect(calls).toBe(0);
  });

  it('caps the first scenario width before allocating and refuses an empty asset universe', () => {
    const oversized = { length: 2 ** 32 };
    let caught: unknown;
    try {
      conditionalValueAtRiskOptimize([oversized, oversized] as never);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(String((caught as Error).message)).toContain('before allocation');

    expect(() => conditionalValueAtRiskOptimize([[], []])).toThrow(/at least one asset/);
  });
});

describe('[P2] per-asset bounds validation (NaN endpoints / inverted boxes)', () => {
  const cov2: number[][] = [
    [0.04, 0.006],
    [0.006, 0.09],
  ];
  const mu2 = [0.1, 0.12];
  const scenarios = [
    [0.01, 0.02],
    [-0.02, 0.0],
    [0.015, -0.01],
  ];
  const nan: [number, number][] = [
    [0, 1],
    [0, NaN],
  ];
  const inverted: [number, number][] = [
    [0, 1],
    [0.8, 0.1],
  ]; // lo > hi

  it('every optimizer rejects a NaN bound endpoint rather than leaking NaN weights', () => {
    expect(() => minVariance(cov2, { bounds: nan })).toThrow(/NaN/);
    expect(() => meanVariance({ mean: mu2, covariance: cov2, options: { bounds: nan } })).toThrow(
      /NaN/,
    );
    expect(() => maxSharpe({ mean: mu2, covariance: cov2, options: { bounds: nan } })).toThrow(
      /NaN/,
    );
    expect(() => kelly({ mean: mu2, covariance: cov2, options: { bounds: nan } })).toThrow(/NaN/);
    expect(() => conditionalValueAtRiskOptimize(scenarios, { bounds: nan })).toThrow(/NaN/);
  });

  it('every optimizer rejects an inverted box (lo > hi) rather than returning converged:true', () => {
    expect(() => minVariance(cov2, { bounds: inverted })).toThrow(/must not exceed/);
    expect(() =>
      meanVariance({ mean: mu2, covariance: cov2, options: { bounds: inverted } }),
    ).toThrow(/must not exceed/);
    expect(() => maxSharpe({ mean: mu2, covariance: cov2, options: { bounds: inverted } })).toThrow(
      /must not exceed/,
    );
    expect(() => kelly({ mean: mu2, covariance: cov2, options: { bounds: inverted } })).toThrow(
      /must not exceed/,
    );
    expect(() => conditionalValueAtRiskOptimize(scenarios, { bounds: inverted })).toThrow(
      /must not exceed/,
    );
  });

  it('rejects wrong-signed infinite endpoints instead of producing infinite weights', () => {
    const positiveInfiniteLower: [number, number][] = [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [0, 1],
    ];
    const negativeInfiniteUpper: [number, number][] = [
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [0, 1],
    ];
    for (const bounds of [positiveInfiniteLower, negativeInfiniteUpper]) {
      expect(() => minVariance(cov2, { bounds })).toThrow(/finite or/);
      expect(() => meanVariance({ mean: mu2, covariance: cov2, options: { bounds } })).toThrow(
        /finite or/,
      );
      expect(() => maxSharpe({ mean: mu2, covariance: cov2, options: { bounds } })).toThrow(
        /finite or/,
      );
      expect(() => kelly({ mean: mu2, covariance: cov2, options: { bounds } })).toThrow(
        /finite or/,
      );
      expect(() => conditionalValueAtRiskOptimize(scenarios, { bounds })).toThrow(/finite or/);
    }
  });
});

describe('[WS1.6] maxSharpe unconstrained tangency infeasibility', () => {
  it('returns a finite, disclosed min-variance fallback instead of NaN or a flipped portfolio', () => {
    // Σ = I ⇒ Σ⁻¹(μ−rf) = [0.10, −0.20], which sums to −0.10 ≤ 0: the tangency scaling would flip
    // every weight into a negative-Sharpe portfolio.
    const mu = [0.1, -0.2];
    const covariance = [
      [1, 0],
      [0, 1],
    ];
    const r = maxSharpe({ mean: mu, covariance });
    expect(r.diagnostics.converged).toBe(false);
    const notConverged = r.diagnostics.warnings.find((w) => w.code === 'optimize.not_converged');
    expect(notConverged?.context?.['reason']).toBe('infeasible_tangency');
    expect(r.value.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(r.value.objective)).toBe(true);
    expect(r.diagnostics.method).toBe('min_variance_fallback');
    expect(r.diagnostics.warnings?.some((w) => w.code === 'risk.infeasible_tangency')).toBe(true);
  });

  it('still solves the all-positive-excess unconstrained case (regression)', () => {
    const mu = [0.1, 0.15];
    const covariance = [
      [0.04, 0.01],
      [0.01, 0.09],
    ];
    const r = maxSharpe({ mean: mu, covariance });
    expect(r.diagnostics.converged).toBe(true);
    expect(r.value.weights.every(Number.isFinite)).toBe(true);
    expect(r.value.objective).toBeGreaterThan(0);
  });
});

describe('mean vectors are strict numeric snapshots', () => {
  const covariance = [
    [0.04, 0.006],
    [0.006, 0.09],
  ];

  it('rejects numeric strings and coercion objects without executing valueOf', () => {
    let valueOfCalled = false;
    const coercionTrap = {
      valueOf(): number {
        valueOfCalled = true;
        throw new Error('must not execute caller coercion');
      },
    };
    for (const run of [
      () => maxSharpe({ mean: ['0.1', 0.12] as never, covariance }),
      () => meanVariance({ mean: [coercionTrap, 0.12] as never, covariance }),
      () => kelly({ mean: [coercionTrap, 0.12] as never, covariance }),
    ]) {
      expect(run).toThrow(/must be a number/);
    }
    expect(valueOfCalled).toBe(false);
  });

  it('rejects an accessor-backed array without invoking the accessor', () => {
    let getterCalled = false;
    const mean = [0.1, 0.12];
    Object.defineProperty(mean, '0', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute caller accessor');
      },
    });
    expect(() => meanVariance({ mean, covariance })).toThrow(/accessor-backed/);
    expect(getterCalled).toBe(false);
  });

  it('accepts numeric typed arrays promised by the ArrayLike input type', () => {
    const mean = new Float64Array([0.1, 0.12]);
    expect(maxSharpe({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);
    expect(meanVariance({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);
    expect(kelly({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);
  });

  it('accepts dense stored-data ArrayLike records promised by the public type', () => {
    const mean: ArrayLike<number> = { 0: 0.1, 1: 0.12, length: 2 };
    expect(maxSharpe({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);
    expect(meanVariance({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);
    expect(kelly({ mean, covariance }).value.weights.every(Number.isFinite)).toBe(true);

    const hiddenIndexes = { length: 2 } as unknown as ArrayLike<number>;
    Object.defineProperties(hiddenIndexes, {
      0: { configurable: true, value: 0.1 },
      1: { configurable: true, value: 0.12 },
    });
    expect(
      maxSharpe({ mean: hiddenIndexes, covariance }).value.weights.every(Number.isFinite),
    ).toBe(true);
  });

  it('rejects accessor-backed ArrayLike records without invoking length or index getters', () => {
    let lengthGetterCalled = false;
    const accessorLength = { 0: 0.1, 1: 0.12 } as unknown as ArrayLike<number>;
    Object.defineProperty(accessorLength, 'length', {
      get(): never {
        lengthGetterCalled = true;
        throw new Error('must not execute caller length accessor');
      },
    });
    expect(() => maxSharpe({ mean: accessorLength, covariance })).toThrow(/length.*stored number/);
    expect(lengthGetterCalled).toBe(false);

    let indexGetterCalled = false;
    const accessorIndex = { 1: 0.12, length: 2 } as unknown as ArrayLike<number>;
    Object.defineProperty(accessorIndex, '0', {
      enumerable: true,
      get(): never {
        indexGetterCalled = true;
        throw new Error('must not execute caller index accessor');
      },
    });
    expect(() => meanVariance({ mean: accessorIndex, covariance })).toThrow(/accessor-backed/);
    expect(indexGetterCalled).toBe(false);
  });

  it('rejects a hostile ArrayLike length without invoking coercion or retaining it in context', () => {
    let calls = 0;
    const hostileLength = {
      toJSON(): never {
        calls += 1;
        throw new Error('must not execute toJSON');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('must not execute Symbol.toPrimitive');
      },
    };
    const mean = { 0: 0.1, 1: 0.12, length: hostileLength } as unknown as ArrayLike<number>;
    expect(() => meanVariance({ mean, covariance })).toThrow(/length.*got object/);
    expect(calls).toBe(0);
  });

  it('reads typed-array internal slots without invoking own or subclass length accessors', () => {
    let ownLengthGetterCalled = false;
    const ownLength = new Float64Array([0.1, 0.12]);
    Object.defineProperty(ownLength, 'length', {
      configurable: true,
      get(): never {
        ownLengthGetterCalled = true;
        throw new Error('must not execute own length accessor');
      },
    });
    expect(maxSharpe({ mean: ownLength, covariance }).value.weights.every(Number.isFinite)).toBe(
      true,
    );
    expect(ownLengthGetterCalled).toBe(false);

    let subclassLengthGetterCalled = false;
    class MeanVector extends Float64Array {
      override get length(): number {
        subclassLengthGetterCalled = true;
        throw new Error('must not execute subclass length accessor');
      }
    }
    const subclassMean = new MeanVector([0.1, 0.12]);
    expect(kelly({ mean: subclassMean, covariance }).value.weights.every(Number.isFinite)).toBe(
      true,
    );
    expect(subclassLengthGetterCalled).toBe(false);
  });
});

describe('constrained maxSharpe min-variance fallback is honest (review fix)', () => {
  const cov2: number[][] = [
    [0.04, 0.006],
    [0.006, 0.09],
  ];
  const variance = (A: number[][], w: number[]): number =>
    w.reduce((s, wi, i) => s + wi * A[i]!.reduce((t, a, j) => t + a * w[j]!, 0), 0);

  it('all-negative excess: objective is the hand-computed Sharpe of the returned weights, disclosed', () => {
    const mu = [-0.05, -0.02];
    const r = maxSharpe({ mean: mu, covariance: cov2, options: { longOnly: true } });
    const w = r.value.weights;
    // The old code returned the min-variance VARIANCE stamped as a "maxSharpe" objective with
    // converged:true and no warning. The objective must be the actual Sharpe of the weights.
    const handSharpe = (mu[0]! * w[0]! + mu[1]! * w[1]!) / Math.sqrt(variance(cov2, w));
    expect(r.value.objective).toBeCloseTo(handSharpe, 10);
    expect(r.value.objective).toBeLessThan(0); // honestly non-positive: no positive-Sharpe book exists
    expect(r.diagnostics.converged).toBe(false);
    expect(r.diagnostics.method).toBe('min_variance_fallback');
    expect(r.diagnostics.warnings.some((x) => x.code === 'risk.no_positive_excess')).toBe(true);
    const notConverged = r.diagnostics.warnings.find((x) => x.code === 'optimize.not_converged');
    expect(notConverged?.context?.['reason']).toBe('no_positive_excess');
  });

  it('the fallback weights ARE the min-variance portfolio (fully invested, feasible)', () => {
    const r = maxSharpe({ mean: [-0.05, -0.02], covariance: cov2, options: { longOnly: true } });
    const mv = minVariance(cov2, { longOnly: true });
    r.value.weights.forEach((w, i) => expect(w).toBeCloseTo(mv.value.weights[i]!, 8));
    expect(r.value.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
  });
});

describe('optimizer options hardening (deep-sweep boundary)', () => {
  it('maxSharpe / meanVariance / kelly reject a null options bag', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it) and used to die
    // on the first constraint read (raw TypeError).
    expect(() => maxSharpe({ mean: mu3, covariance: cov3, options: null as never })).toThrow(
      /maxSharpe: options must be an object/,
    );
    expect(() => meanVariance({ mean: mu3, covariance: cov3, options: null as never })).toThrow(
      /meanVariance: options must be an object/,
    );
    expect(() => kelly({ mean: mu3, covariance: cov3, options: null as never })).toThrow(
      /kelly: options must be an object/,
    );
    // A valid call still works without the bag.
    expect(maxSharpe({ mean: mu3, covariance: cov3 }).value.weights).toHaveLength(3);
  });

  it('rejects hostile count options without invoking their coercion hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('must not execute toJSON');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('must not execute Symbol.toPrimitive');
      },
    };
    expect(() => minVariance(cov3, { maximumIterations: hostile } as never)).toThrow(
      /maximumIterations.*got object/,
    );
    expect(calls).toBe(0);
  });
});
