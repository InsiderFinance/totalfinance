import { expect, it } from 'vitest';
import { moneyWeightedReturn } from '@totalfinance/performance';
for (const scale of [1e-200, 1e-15, 1, 1e200, 1e300]) {
  it(`preserves the independent one-year 2.5x investor return at ${scale} (#21)`, () => {
    const result = moneyWeightedReturn({
      valuations: [
        { valuationDate: '2025-01-01', netAssetValue: scale },
        { valuationDate: '2026-01-01', netAssetValue: 2.5 * scale },
      ],
      externalCashFlows: [],
    });
    expect(result.moneyWeightedReturn).toBeCloseTo(1.5, 11);
    expect(result.solverReport.diagnostics.converged).toBe(true);
    expect(result.solverReport.assumptions.dayCount).toBe('ACT/365F');
  });
}
