/** Declaration-derived inventory ratchet for public workload controls. */

import { describe, expect, it } from 'vitest';
import { allDeclaredNumericCoordinates } from './declaration-coordinates.js';
import { numericCoordinatePolicy, RESOURCE_SAFETY_CEILING } from './count-semantics.js';

const coordinates = allDeclaredNumericCoordinates();
const classified = coordinates.map((coordinate) => ({
  ...coordinate,
  policy: numericCoordinatePolicy(coordinate),
}));
const resources = classified.filter(({ policy }) => policy.kind === 'resource');

describe('declaration-derived public resource-control inventory', () => {
  it('classifies every compiler-visible numeric input and gives every resource a reason and ceiling', () => {
    expect(coordinates.length).toBeGreaterThan(10_000);
    expect(resources.length).toBeGreaterThan(900);
    const malformed = resources.filter(
      ({ policy }) =>
        policy.rationale.trim().length < 20 || policy.safetyCeiling !== RESOURCE_SAFETY_CEILING,
    );
    expect(malformed).toEqual([]);
  });

  it('keeps the known workload vocabulary live in real declarations, including positional controls', () => {
    const keys = new Set(resources.map(({ key }) => key));
    for (const key of [
      'paths',
      'samples',
      'maximumIterations',
      'populationSize',
      'folds',
      'lags',
      'lookback',
      'bins',
      'dimensions',
      'maxGenerations',
      'nodeCount',
      'terms',
      'gridPoints',
      'stepsPerYear',
      'fast',
      'signal',
      'strength',
    ]) {
      expect(keys.has(key), `no declared resource coordinate classified for '${key}'`).toBe(true);
    }
    expect(
      resources.some(
        ({ head, path, key }) =>
          head === 'math.gaussLegendreNodes' && path.join('.') === '0' && key === 'nodeCount',
      ),
      'a scalar positional resource must retain its declaration name',
    ).toBe(true);
    expect(
      numericCoordinatePolicy({
        head: 'structure.FlowAnalysis#rank#declared:arm',
        path: [1, 'limit'],
        key: 'limit',
      }).kind,
      'a fixture suffix must not erase the real class method ID',
    ).toBe('magnitude');
    for (const [head, key] of [
      ['risk.meanExcessPlot', 'gridSize'],
      ['options.americanExercise', 'boundaryPoints'],
      ['options.asian.monteCarloPrice', 'averagingPoints'],
      ['math.differentialEvolution', 'maxGenerations'],
      ['technical-analysis.macd', 'fast'],
      ['technical-analysis.swings', 'strength'],
      ['technical-analysis.rainbowMovingAverage', 'levels'],
    ] as const) {
      expect(numericCoordinatePolicy({ head, path: [0, key], key }).kind, `${head}.${key}`).toBe(
        'resource',
      );
    }
  });

  it('does not confuse continuous horizons, report metadata, or coordinate arrays with budgets', () => {
    for (const head of [
      'risk.costAwareKelly',
      'risk.kellyBet',
      'risk.portfolioVaR',
      'risk.valueAtRiskReport',
      'strategy.optimizeStrategy',
    ]) {
      expect(
        numericCoordinatePolicy({ head, path: [0, 'horizonPeriods'], key: 'horizonPeriods' }).kind,
      ).toBe('magnitude');
    }
    expect(
      numericCoordinatePolicy({
        head: 'volatility.garchForecast',
        path: [0, 'fit', 'iterations'],
        key: 'iterations',
      }).kind,
    ).toBe('magnitude');
    expect(
      numericCoordinatePolicy({
        head: 'volatility.surfacePCA',
        path: [0, 'gridPoints', 0],
        key: 'gridPoints',
      }).kind,
    ).toBe('magnitude');
    for (const coordinate of [
      { head: 'research.screenUniverse', path: [0, 'limit'], key: 'limit' },
      { head: 'technical-analysis.searchIndicators', path: [0, 'offset'], key: 'offset' },
      { head: 'technical-analysis.kagi', path: [1, 'reversal'], key: 'reversal' },
      { head: 'technical-analysis.mavp', path: [0, 'periods', 1], key: 'periods' },
      { head: 'options.ControlVariate#estimate', path: [0, 0], key: 'normalDraws' },
      { head: 'math.controlVariateEstimate', path: [0, 0, 'samples'], key: 'samples' },
      { head: 'math.monteCarlo', path: [1, 'minPaths'], key: 'minPaths' },
      { head: 'math.rollingMean', path: [1], key: 'window' },
      { head: 'core.createTableHandle', path: [0, 'rowCount'], key: 'rowCount' },
      { head: 'risk.deflatedSharpeRatio', path: [1, 'trialCount'], key: 'trialCount' },
    ]) {
      expect(numericCoordinatePolicy(coordinate).kind, `${coordinate.head}.${coordinate.key}`).toBe(
        'magnitude',
      );
    }
  });
});
