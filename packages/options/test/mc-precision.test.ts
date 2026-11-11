import { expect, it } from 'vitest';
import { monteCarloEstimate } from '../src/mc/core.js';
import { asian } from '@totalfinance/options';
it('matches independent centered fitted residuals with a high offset (#22)', () => {
  const observations: [number, number][] = [];
  const result = monteCarloEstimate({
    dimensions: 1,
    payoff: (z) => {
      const x = 1e6 + z[0]!;
      const y = 1e6 + 1.7 * z[0]! + 0.00001 * z[0]! ** 2;
      observations.push([y, x]);
      return y;
    },
    controlVariate: { estimate: (z) => 1e6 + z[0]!, mean: 1e6 },
    options: { paths: 1000, seed: 42, antithetic: false },
  });
  // Independent two-pass centered fit: use offsets to retain low-order digits.
  const ys = observations.map((r) => r[0] - observations[0]![0]),
    xs = observations.map((r) => r[1] - observations[0]![1]);
  const my = ys.reduce((a, b) => a + b, 0) / ys.length,
    mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beta =
    xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) /
    xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const residual = ys.map((y, i) => y - my - beta * (xs[i]! - mx));
  const se = Math.sqrt(residual.reduce((s, r) => s + r * r, 0) / (ys.length - 1) / ys.length);
  expect(result.standardError! / se).toBeCloseTo(1, 7);
  expect(result.standardError).toBeGreaterThan(0);
  expect(observations).toHaveLength(1000);
});
for (const scale of [1e-150, 1, 1e150])
  it(`preserves uncertainty scale ${scale}`, () => {
    const result = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => scale * z[0]! ** 2,
      options: { paths: 1000, seed: 42, antithetic: false },
    });
    const base = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => z[0]! ** 2,
      options: { paths: 1000, seed: 42, antithetic: false },
    });
    expect(result.standardError! / scale / base.standardError!).toBeCloseTo(1, 12);
  });
it('retains genuine zero uncertainty and one-pass callbacks for identity controls', () => {
  let payoffs = 0,
    controls = 0;
  const r = monteCarloEstimate({
    dimensions: 1,
    payoff: (z) => {
      payoffs++;
      return Math.exp(z[0]!);
    },
    controlVariate: {
      estimate: (z) => {
        controls++;
        return Math.exp(z[0]!);
      },
      mean: Math.exp(0.5),
    },
    options: { paths: 1000, seed: 42, antithetic: true },
  });
  expect(r.standardError).toBe(0);
  expect(r.value).toBe(Math.exp(0.5));
  expect(payoffs).toBe(2000);
  expect(controls).toBe(2000);
});
it('does not advertise a point confidence interval for the reported twelve-fixing Asian case', () => {
  const r = asian.monteCarloPrice(
    {
      type: 'put',
      spot: 1,
      strike: 1e6,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.0001,
    },
    {
      averagingPoints: 12,
      paths: 1000,
      seed: 42,
      method: 'pseudo',
      antithetic: true,
      brownianBridge: false,
      confidence: 0.95,
      randomNumberGenerator: 'mulberry32',
    },
  );
  // Independent 80-digit two-pass fit on these same binary64 payoff/control samples.
  expect(r.monteCarlo.standardError! / 1.91594991165564953148e-11).toBeCloseTo(1, 12);
  if (r.monteCarlo.confidenceInterval !== null)
    expect(r.monteCarlo.confidenceInterval[1]).toBeGreaterThan(r.monteCarlo.confidenceInterval[0]);
  else {
    expect(r.diagnostics.converged).toBe(false);
    expect(r.diagnostics.warnings).toContainEqual(
      expect.objectContaining({ code: 'model.limitation' }),
    );
  }
});
it('retains constant payoff and constant-control semantics', () => {
  const r = monteCarloEstimate({
    dimensions: 1,
    payoff: () => 7,
    controlVariate: { estimate: () => 3, mean: 3 },
    options: { paths: 1000, seed: 42 },
  });
  expect(r.value).toBe(7);
  expect(r.standardError).toBe(0);
  expect(r.varianceReduction.controlVariate).toBe(false);
});
it('keeps genuine one-fixing Asian identity uncertainty exactly zero', () => {
  const r = asian.monteCarloPrice(
    {
      type: 'put',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    },
    { averagingPoints: 1, paths: 1000, seed: 42 },
  );
  expect(r.monteCarlo.standardError).toBe(0);
  expect(r.diagnostics.converged).toBe(true);
});
it('preserves QMC null uncertainty', () => {
  const r = monteCarloEstimate({
    dimensions: 1,
    payoff: (z) => Math.exp(z[0]!),
    options: { paths: 1000, seed: 42, method: 'sobol' },
  });
  expect(r.standardError).toBeNull();
  expect(r.confidenceInterval).toBeNull();
});
for (const scale of [1e-150, 1e150])
  it(`preserves fitted-control residual uncertainty at scale ${scale}`, () => {
    const estimate = (s: number) =>
      monteCarloEstimate({
        dimensions: 1,
        payoff: (z) => s * (z[0]! + 0.2 * z[0]! ** 2),
        controlVariate: { estimate: (z) => s * z[0]!, mean: 0 },
        options: { paths: 1000, seed: 42, antithetic: false },
      });
    expect(estimate(scale).standardError! / scale / estimate(1).standardError!).toBeCloseTo(1, 12);
  });
