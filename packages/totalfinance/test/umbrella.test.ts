import { describe, expect, it } from 'vitest';
import {
  blackScholes as scopedBs,
  engines as scopedEngines,
  option as scopedOption,
} from '@totalfinance/options';
import { rsi as scopedRsi } from '@totalfinance/technical-analysis';
import * as scopedVolatility from '@totalfinance/volatility';
import * as scopedScenarios from '@totalfinance/scenarios';
import * as scopedScenarioPortfolio from '@totalfinance/scenarios/portfolio';
import {
  backtest,
  blackScholes,
  calendars,
  core,
  engines,
  fixedIncome,
  impliedVolatility,
  market,
  math,
  option,
  options,
  performance,
  risk,
  scenarios,
  strategy,
  structure,
  technicalAnalysis,
  volatility,
} from 'totalfinance';
import * as umbrella from 'totalfinance';
import * as volatilitySubpath from 'totalfinance/volatility';
import * as optionsSubpath from 'totalfinance/options';
import * as scenariosSubpath from 'totalfinance/scenarios';

/**
 * DX4.1 + alignment-spec P3.3 — the umbrella topology:
 *   - the flagship hoist is exactly `blackScholes, option, market, engines, impliedVolatility`;
 *   - every domain is a namespace (`options` included), each a pure re-export (same bindings,
 *     no copy, no new API);
 *   - `totalfinance/<domain>` subpaths expose the identical surface for tree-shakeable imports;
 *   - kernels stay off the umbrella root, and no namespace contains itself (`technicalAnalysis.technicalAnalysis` is gone).
 */
describe('totalfinance umbrella', () => {
  it('hoists exactly the five flagship names, identical to the scoped exports', () => {
    expect(blackScholes).toBe(scopedBs);
    expect(option).toBe(scopedOption);
    expect(engines).toBe(scopedEngines);
    expect(typeof market).toBe('function');
    expect(typeof impliedVolatility).toBe('function');
    const price = blackScholes.price({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
      type: 'call',
    });
    expect(price).toBeCloseTo(10.4506, 3);
  });

  it('keeps kernels and batch APIs OFF the umbrella root (expert subpaths only)', () => {
    for (const kernel of [
      'blackScholesPrice',
      'black76Price',
      'bachelierPrice',
      'blackScholesPriceMany',
    ]) {
      expect(kernel in umbrella, kernel).toBe(false);
    }
    // …but the options namespace still carries the full curated options root.
    expect(typeof options.priceMany).toBe('function');
  });

  it('exposes every domain as a namespace and runs one function from each', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i));
    expect(technicalAnalysis.rsi.explain(closes, { period: 14 }).value).toHaveLength(30);

    const returns = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? -0.05 : 0.01));
    expect(risk.valueAtRisk(returns)).toBeGreaterThan(0);

    const pos = strategy.strategy([strategy.legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    expect(pos.premiumSource).toBe('user');

    expect(
      volatility.expectedMoveFromImpliedVolatility({
        spot: 100,
        impliedVolatility: 0.2,
        timeToExpiryYears: 0.25,
      }).oneSigma,
    ).toBeCloseTo(10, 6);

    // The remaining domains are present as live namespace objects.
    for (const ns of [core, math, calendars, performance, backtest, structure, fixedIncome]) {
      expect(typeof ns).toBe('object');
      expect(ns).not.toBeNull();
    }
  });

  it('no namespace contains an eponymous copy of itself (P3.3 dedup)', () => {
    expect('technicalAnalysis' in technicalAnalysis).toBe(false);
    expect('performance' in performance).toBe(false);
    expect('backtest' in backtest).toBe(false);
    expect('performance' in risk).toBe(false);
    // strategy.strategy stays: it is the raw-position FACTORY (a callable), not a namespace copy.
    expect(typeof strategy.strategy).toBe('function');
  });

  it('namespace bindings are the scoped package itself (no copy)', () => {
    expect(technicalAnalysis.rsi).toBe(scopedRsi);
    expect(options.blackScholes).toBe(scopedBs);
  });

  it('totalfinance/<domain> subpaths expose the identical scoped surface', () => {
    expect(volatilitySubpath.expectedMoveFromImpliedVolatility).toBe(
      scopedVolatility.expectedMoveFromImpliedVolatility,
    );
    expect(optionsSubpath.blackScholes).toBe(scopedBs);
    expect(optionsSubpath.option).toBe(scopedOption);
    expect(scenarios.runScenarios).toBe(scopedScenarios.runScenarios);
    expect(scenarios.scenarioTarget).toBe(scopedScenarios.scenarioTarget);
    expect(scenarios.spotAssetPricer).toBe(scopedScenarios.spotAssetPricer);
    expect(scenarios.scenarioPortfolioBinding).toBe(scopedScenarios.scenarioPortfolioBinding);
    expect(scenarios.scenarioTargetsFromPortfolio).toBe(
      scopedScenarios.scenarioTargetsFromPortfolio,
    );
    expect(scopedScenarioPortfolio.scenarioPortfolioBinding).toBe(
      scopedScenarios.scenarioPortfolioBinding,
    );
    expect(scopedScenarioPortfolio.scenarioTargetsFromPortfolio).toBe(
      scopedScenarios.scenarioTargetsFromPortfolio,
    );
    expect(scenariosSubpath.runScenarios).toBe(scopedScenarios.runScenarios);
  });

  it('keeps scenario operations off the umbrella root', () => {
    for (const name of [
      'runScenarios',
      'scenarioTarget',
      'spotAssetPricer',
      'scenarioPortfolioBinding',
      'scenarioTargetsFromPortfolio',
    ]) {
      expect(name in umbrella, name).toBe(false);
    }
  });
});
