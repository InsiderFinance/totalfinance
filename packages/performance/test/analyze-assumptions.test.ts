/**
 * WS2.2 — the performance summary echoes the annualization/risk-free/benchmark conventions it
 * applied, so a serialized `analyze` result is self-interpreting; value fields are unchanged.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '@totalfinance/performance';

// a simple growing equity curve
const equity = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);

describe('WS2.2 — analyze echoes its assumptions', () => {
  it('echoes periodsPerYear and the applied risk-free rate', () => {
    const s = analyze({ equity }, { periodsPerYear: 252, riskFreeRate: 0.02 });
    const rt = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(rt.assumptions.periodsPerYear).toBe(252);
    expect(rt.assumptions.riskFreeRate).toBe(0.02);
    expect(rt.assumptions.benchmarkLength).toBeUndefined();
  });

  it('defaults an unspecified risk-free rate to 0 and echoes it', () => {
    const s = analyze({ equity }, { periodsPerYear: 12 });
    expect(s.assumptions.riskFreeRate).toBe(0);
    expect(s.assumptions.periodsPerYear).toBe(12);
  });

  it('records the benchmark length when a benchmark is supplied', () => {
    const benchmark = Array.from({ length: equity.length - 1 }, () => 0.005);
    const s = analyze({ equity }, { periodsPerYear: 252, benchmark });
    expect(s.assumptions.benchmarkLength).toBe(benchmark.length);
    expect(s.beta).toBeDefined();
  });

  it('adding the assumptions echo does not change the metric values', () => {
    const s = analyze({ equity }, { periodsPerYear: 252 });
    // sanity on a couple of value fields — a monotone up-curve has positive annualized return.
    expect(s.annualizedReturn).toBeGreaterThan(0);
    expect(s.maxDrawdown).toBe(0);
  });
});
