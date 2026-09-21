import { describe, expect, it } from 'vitest';
import { simpleReturns, equityCurve } from '@totalfinance/performance/returns';
import { maxDrawdown } from '@totalfinance/performance/drawdown';
import { calmar } from '@totalfinance/performance/metrics';
import { analyze } from '@totalfinance/performance/analyze';
import { sharpe } from '@totalfinance/performance/sharpe';
import { omega, profitFactor } from '@totalfinance/performance/ratios';
import { beta } from '@totalfinance/performance/relative';
import { turnover } from '@totalfinance/performance/activity';
import { rollingVolatility } from '@totalfinance/performance/rolling';
import * as sector from '@totalfinance/performance/sector-performance';
import * as performance from '@totalfinance/performance';

// Each per-feature deep entrypoint resolves and exports a working function (design law #9).
describe('@totalfinance/performance deep entrypoints', () => {
  it('returns / drawdown / metrics / analyze / sharpe are importable per-feature', () => {
    const r = simpleReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    const eq = equityCurve(r, 100);
    expect(eq[0]).toBe(100);
    expect(maxDrawdown(eq).maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(calmar(r, { periodsPerYear: 252 }))).toBe(true);
    expect(analyze({ equity: eq }, { periodsPerYear: 252 }).periods).toBe(2);
    expect(Number.isFinite(sharpe(r, { periodsPerYear: 252 }))).toBe(true);
  });

  it('ratios / relative / activity / rolling are importable per-feature', () => {
    expect(omega([0.01, -0.01, 0.02])).toBeGreaterThan(0);
    expect(profitFactor([0.02, -0.01])).toBeCloseTo(2, 12);
    expect(beta([0.02, -0.04], [0.01, -0.02])).toBeCloseTo(2, 8);
    expect(
      turnover([
        [1, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(0.75, 12);
    expect(rollingVolatility([0.01, -0.02, 0.03, 0.0], 2, { periodsPerYear: 252 })).toHaveLength(4); // input-aligned
  });

  it('sector performance is importable from its lean entrypoint', () => {
    expect(Object.keys(sector).sort()).toEqual(['sectorPerformance', 'sectorPerformanceSnapshot']);
    expect(performance.sectorPerformance).toBe(sector.sectorPerformance);
    expect(performance.sectorPerformanceSnapshot).toBe(sector.sectorPerformanceSnapshot);
    expect(
      sector.sectorPerformance({
        members: [
          { securityId: 'A', sectorId: 'technology', sectorName: 'Technology', periodReturn: 0.01 },
        ],
      }).sectors[0]!.periodReturn,
    ).toBe(0.01);
  });
});
