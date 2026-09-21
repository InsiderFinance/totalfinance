import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  kalmanFilter,
  kalmanLogLikelihood,
  kalmanSmooth,
  mulberry32,
  normalInverseCdf,
  type KalmanModel,
} from '@totalfinance/math';

/**
 * Golden: the 1-D local-level model with ZERO process noise (`F=1, H=1, Q=0, R=1, x0=0, P0=1`) is
 * Bayesian estimation of a constant mean μ ~ N(0,1) from unit-variance observations. It has a
 * closed form the whole recursion can be checked against:
 *   posterior after obs z₀..z_t:  mean = (Σzᵢ)/(t+2),  variance = 1/(t+2)
 * (the +2 = t+1 observations plus one prior pseudo-observation from P₀=1). With Q=0 the state never
 * moves, so the RTS smoother collapses every state to the full-sample posterior mean.
 */
function constantModel(): KalmanModel {
  return { x0: [0], P0: [[1]], F: [[1]], H: [[1]], Q: [[0]], R: [[1]] };
}

describe('kalmanFilter — 1-D local level, exact closed-form golden', () => {
  const z = [2, 4, 6];

  it('filtered means are the prior-shrunk running averages Σz/(t+2)', () => {
    const res = kalmanFilter(constantModel(), z);
    // means: 2/2=1, 6/3=2, 12/4=3.
    [1, 2, 3].forEach((mu, t) => expect(res.filteredStates[t]![0]!).toBeCloseTo(mu, 12));
    // variances: 1/2, 1/3, 1/4.
    expect(res.filteredCovariances[0]![0]![0]!).toBeCloseTo(1 / 2, 12);
    expect(res.filteredCovariances[1]![0]![0]!).toBeCloseTo(1 / 3, 12);
    expect(res.filteredCovariances[2]![0]![0]!).toBeCloseTo(1 / 4, 12);
    expect(res.observedCount).toBe(3);
    expect(res.stateDimension).toBe(1);
    expect(res.observationDimension).toBe(1);
  });

  it('log-likelihood matches the hand-summed innovation form', () => {
    const res = kalmanFilter(constantModel(), z);
    // Innovations (2, 3, 4) with S = (2, 3/2, 4/3): ll = −½[3ln2π + ln(2·1.5·4/3) + (2+6+12)]
    //                                                 = −½[3ln2π + ln4 + 20].
    const expected = -0.5 * (3 * Math.log(2 * Math.PI) + Math.log(4) + 20);
    expect(res.logLikelihood).toBeCloseTo(expected, 10);
    expect(kalmanLogLikelihood(constantModel(), z)).toBeCloseTo(expected, 10);
  });

  it('exposes one-step predictions and innovations', () => {
    const res = kalmanFilter(constantModel(), z);
    // Predicted state at t equals the previous filtered state (F=1): [0, 1, 2].
    [0, 1, 2].forEach((x, t) => expect(res.predictedStates[t]![0]!).toBeCloseTo(x, 12));
    [2, 3, 4].forEach((y, t) => expect(res.innovations[t]![0]!).toBeCloseTo(y, 12));
    expect(res.innovationCovariances[0]![0]![0]!).toBeCloseTo(2, 12);
    expect(res.innovationCovariances[1]![0]![0]!).toBeCloseTo(3 / 2, 12);
  });
});

describe('kalmanSmooth — RTS backward pass', () => {
  it('collapses a constant state to the full-sample posterior (exact golden)', () => {
    const res = kalmanSmooth(constantModel(), [2, 4, 6]);
    // With Q=0 every smoothed state equals the final filtered mean, 3, with variance 1/(3+1)=1/4.
    res.smoothedStates.forEach((s) => expect(s[0]!).toBeCloseTo(3, 12));
    for (const P of res.smoothedCovariances) expect(P[0]![0]!).toBeCloseTo(1 / 4, 12);
  });

  it('is never less certain than the filter (smoothed variance ≤ filtered variance)', () => {
    // Local level WITH process noise — a genuine random walk plus noise.
    const model: KalmanModel = { x0: [0], P0: [[1]], F: [[1]], H: [[1]], Q: [[0.1]], R: [[1]] };
    const randomNumberGenerator = mulberry32(99);
    let level = 0;
    const obs: number[] = [];
    for (let t = 0; t < 60; t++) {
      level += Math.sqrt(0.1) * normalInverseCdf(randomNumberGenerator.next());
      obs.push(level + normalInverseCdf(randomNumberGenerator.next()));
    }
    const res = kalmanSmooth(model, obs);
    for (let t = 0; t < obs.length; t++) {
      expect(res.smoothedCovariances[t]![0]![0]!).toBeLessThanOrEqual(
        res.filteredCovariances[t]![0]![0]! + 1e-12,
      );
    }
    // The smoother should track the latent level better than the raw noisy observations.
    const mseSmooth = res.smoothedStates.reduce(
      (s, _, t) => s + (res.smoothedStates[t]![0]! - obs[t]!) ** 2,
      0,
    );
    expect(Number.isFinite(mseSmooth)).toBe(true);
  });
});

describe('kalman — missing observations predict only (design law #4)', () => {
  it('carries the state forward with no likelihood contribution at a null step', () => {
    const res = kalmanFilter(constantModel(), [2, null, 6, null]);
    expect(res.observedCount).toBe(2);
    // Missing steps: innovation is null and the filtered state equals the prediction.
    expect(res.innovations[1]).toBeNull();
    expect(res.innovations[3]).toBeNull();
    expect(res.filteredStates[1]![0]!).toBe(res.predictedStates[1]![0]!);
    // A vector of NaN is also treated as missing.
    const res2 = kalmanFilter({ ...constantModel() }, [2, [NaN], 6]);
    expect(res2.observedCount).toBe(2);
    expect(res2.innovations[1]).toBeNull();
  });
});

describe('kalman — multivariate local-linear trend recovers a known ramp', () => {
  it('filters a [level, slope] state on a clean linear series', () => {
    // state = [level, slope]; level_{t+1} = level + slope, slope constant. Observe the level.
    const model: KalmanModel = {
      x0: [0, 0],
      P0: [
        [10, 0],
        [0, 10],
      ],
      F: [
        [1, 1],
        [0, 1],
      ],
      H: [[1, 0]],
      Q: [
        [1e-6, 0],
        [0, 1e-6],
      ],
      R: [[1e-4]],
    };
    // True ramp: level_t = 3 + 2t (slope 2). Observe with negligible noise.
    const obs = Array.from({ length: 40 }, (_, t) => 3 + 2 * t);
    const res = kalmanFilter(model, obs);
    const last = res.filteredStates[res.filteredStates.length - 1]!;
    expect(last[0]!).toBeCloseTo(3 + 2 * 39, 2); // level
    expect(last[1]!).toBeCloseTo(2, 2); // slope
    expect(Number.isFinite(res.logLikelihood)).toBe(true);
  });
});

describe('kalman — validation (no fabricated fits)', () => {
  const base = constantModel();

  it('rejects a wrongly-shaped transition matrix', () => {
    expect(() => kalmanFilter({ ...base, F: [[1, 0]] }, [1, 2, 3])).toThrow();
  });

  it('rejects an empty observation sequence', () => {
    expect(() => kalmanFilter(base, [])).toThrow();
  });

  it('rejects a bare-number observation when m > 1', () => {
    const twoObs: KalmanModel = {
      x0: [0, 0],
      P0: [
        [1, 0],
        [0, 1],
      ],
      F: [
        [1, 0],
        [0, 1],
      ],
      H: [
        [1, 0],
        [0, 1],
      ],
      Q: [
        [0, 0],
        [0, 0],
      ],
      R: [
        [1, 0],
        [0, 1],
      ],
    };
    // A bare number is a type-valid KalmanObservation, but the runtime guard rejects it when m = 2
    // (a scalar can't fill a 2-vector) rather than silently zero-padding.
    expect(() => kalmanFilter(twoObs, [1, 2, 3])).toThrow();
  });

  it('raises on a non-positive-definite innovation covariance rather than inventing a gain', () => {
    // R = −1 drives S negative on the first update ⇒ Cholesky must throw.
    expect(() => kalmanFilter({ ...base, R: [[-1]] }, [1, 2, 3])).toThrow();
  });

  // Regression for an external-review finding: a negative R was accepted whenever the innovation
  // covariance S = HPHᵀ + R happened to stay positive. R = −0.5 leaves S = 1 − 0.5 = 0.5 > 0 here, so
  // the old code produced a confident filter from an invalid noise model; R must be PD up front.
  it('rejects a negative R even when the innovation covariance would stay positive', () => {
    let caught: unknown;
    try {
      kalmanFilter({ ...base, R: [[-0.5]] }, [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'linalg.not_positive_definite')).toBe(true);
  });

  it('rejects a non-symmetric covariance (a covariance is symmetric by definition)', () => {
    const asym: KalmanModel = {
      x0: [0, 0],
      P0: [
        [1, 0.5],
        [0.3, 1], // 0.5 ≠ 0.3 ⇒ not symmetric
      ],
      F: [
        [1, 0],
        [0, 1],
      ],
      H: [[1, 0]],
      Q: [
        [1e-6, 0],
        [0, 1e-6],
      ],
      R: [[1e-4]],
    };
    expect(() => kalmanFilter(asym, [1, 2, 3])).toThrow(/symmetric/);
  });

  it('rejects a symmetric-but-indefinite process covariance Q', () => {
    const indefiniteQ: KalmanModel = {
      x0: [0, 0],
      P0: [
        [1, 0],
        [0, 1],
      ],
      F: [
        [1, 0],
        [0, 1],
      ],
      H: [[1, 0]],
      Q: [
        [1, 2],
        [2, 1], // eigenvalues 3 and −1 ⇒ not PSD
      ],
      R: [[1e-4]],
    };
    let caught: unknown;
    try {
      kalmanFilter(indefiniteQ, [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'linalg.not_positive_definite')).toBe(true);
  });

  it('treats an ±Infinity observation as a data error, not a silent missing marker', () => {
    // null and NaN mark MISSING (tested above); Infinity is invalid data and must not be swallowed.
    let caught: unknown;
    try {
      kalmanFilter(base, [1, Infinity, 3]);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.not_finite')).toBe(true);
  });
});
