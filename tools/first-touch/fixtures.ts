import { DISCLOSED_HOLDINGS_FIXTURES } from './fixtures/disclosed-holdings.js';
/**
 * R3 — happy-path fixtures for the deep sweep (`deep-sweep.test.ts`).
 *
 * A fixture is a THUNK returning a fresh, VALID argument list for one public callable. The deep
 * sweep uses it four ways:
 *
 *   1. the fixture call itself must succeed (every fixture is a baked-in happy-path test);
 *   2. each argument position is replaced with garbage — the call must throw a typed QuantError
 *      or return (never a raw TypeError/RangeError/plain Error);
 *   3. each top-level key of each object argument is deleted one at a time — same law (this is
 *      the "partial-but-plausible input" class the arg-0 sweep can never see);
 *   4. if the callable has `.explain`, the envelope is checked with `isComputed` (WS-7.2), and a
 *      numeric NaN value must carry at least one diagnostics warning (design law #4).
 *
 * Keys are `pkg.path` exactly as the sweep enumerates them (`options.option.price`,
 * `performance.sharpe`, `technical_analysis.rsi`). Thunks MUST return fresh objects — probes mutate arguments.
 *
 * Coverage is enforced by `unfixtured.ts` (shrink-only): every multi-argument or explain-bearing
 * callable either has a fixture here or is listed there — and the ledger only shrinks.
 */

import * as technicalAnalysis from '@totalfinance/technical-analysis';
import { listIndicators, indicatorWarmups, pairs } from '@totalfinance/technical-analysis';
import { listStrategies } from '@totalfinance/strategy';
import { bonds, curves } from '@totalfinance/fixed-income';
import {
  BARS,
  CLOSES,
  PREMIUM_MARKET,
  RETURNS,
  WEIGHTS_PATH,
  type FixtureThunk,
} from './inputs.js';
import { TA_FIXTURES } from './fixtures/ta.js';
import { OPTIONS_FIXTURES } from './fixtures/options.js';
import { FI_VOL_RISK_FIXTURES } from './fixtures/fi-vol-risk.js';
import { MISC_FIXTURES } from './fixtures/misc.js';
import { FUNDAMENTALS_FIXTURES } from './fixtures/fundamentals.js';
import { ANALYSIS_VALUATION_FIXTURES } from './fixtures/analysis-valuation.js';
import { RESEARCH_FIXTURES } from './fixtures/research.js';
import { FOREIGN_EXCHANGE_FIXTURES } from './fixtures/foreign-exchange.js';
import { COMMODITIES_FIXTURES } from './fixtures/commodities.js';
import { CORE_ARTIFACTS_FIXTURES } from './fixtures/core-artifacts.js';
import { PERFORMANCE_FLOW_AWARE_FIXTURES } from './fixtures/performance-flow-aware.js';
import { SECTOR_PERFORMANCE_FIXTURES } from './fixtures/sector-performance.js';
import { ANALYSIS_BACKTEST_CRYPTO_FIXTURES } from './fixtures/analysis-backtest-crypto.js';
import { ANALYSIS_FIXED_INCOME_FIXTURES } from './fixtures/analysis-fixed-income.js';
import { ANALYSIS_OPTIONS_STRATEGY_STRUCTURE_FIXTURES } from './fixtures/analysis-options-strategy-structure.js';
import { ANALYSIS_RISK_FIXTURES } from './fixtures/analysis-risk.js';
import { ANALYSIS_TA_FIXTURES } from './fixtures/analysis-ta.js';
import { ANALYSIS_VOL_FIXTURES } from './fixtures/analysis-vol.js';
import { VALUATION_PRIMITIVES_FIXTURES } from './fixtures/valuation-primitives.js';
import { CONSTRUCTOR_FIXTURES } from './fixtures/constructors.js';
import { PORTFOLIO_FIXTURES } from './fixtures/portfolio.js';
import { SCENARIOS_FIXTURES } from './fixtures/scenarios.js';
import { VOLATILITY_ARTIFACTS_FIXTURES } from './fixtures/volatility-artifacts.js';
import { FIXED_INCOME_ARTIFACTS_FIXTURES } from './fixtures/fixed-income-artifacts.js';
import { RESEARCH_ARTIFACTS_FIXTURES } from './fixtures/research-artifacts.js';
import { WORKFLOWS_FIXTURES } from './fixtures/workflows.js';
import { MCP_FIXTURES } from './fixtures/mcp.js';
import { CLI_FIXTURES } from './fixtures/cli.js';
import { HTTP_FIXTURES } from './fixtures/http.js';
import { MATH_RESOURCE_FIXTURES } from './fixtures/math-resource.js';
import { PAPER_FIXTURES } from './fixtures/paper.js';
import { OBSERVED_SKEW_FIXTURES } from './fixtures/observed-skew.js';
import { STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES } from './fixtures/structure-option-flow-drift.js';
import { STRUCTURE_SUPPLIED_EXPOSURE_FIXTURES } from './fixtures/structure-supplied-exposure.js';
import { OPTION_CHAIN_HEALTH_FIXTURES } from './fixtures/options-chain-health.js';

export {
  BARS,
  CLOSES,
  MARKET,
  PREMIUM_MARKET,
  RETURNS,
  WEIGHTS_PATH,
  type FixtureThunk,
} from './inputs.js';

// ── static fixtures ──────────────────────────────────────────────────────────────────────────────

const STATIC: Record<string, FixtureThunk> = {
  // options payoff primitive (Gate A)
  'options.vanillaIntrinsic': () => [{ type: 'call', underlyingPrice: 112, strike: 100 }],
  // performance (series-first: [series, options?])
  'performance.annualizedReturn': () => [RETURNS(), { periodsPerYear: 252 }],
  'performance.annualizedVolatility': () => [RETURNS(), { periodsPerYear: 252 }],
  'performance.sharpe': () => [RETURNS(), { periodsPerYear: 252 }],
  'performance.sortino': () => [RETURNS(), { periodsPerYear: 252 }],
  'performance.calmar': () => [RETURNS(), { periodsPerYear: 252 }],
  'performance.treynor': () => [RETURNS(), RETURNS(), { periodsPerYear: 252 }],
  'performance.omega': () => [RETURNS(), { threshold: 0 }],
  'performance.hitRate': () => [RETURNS()],
  'performance.profitFactor': () => [RETURNS()],
  'performance.expectancy': () => [RETURNS()],
  'performance.winLossStatistics': () => [RETURNS()],
  'performance.maxDrawdown': () => [CLOSES()],
  'performance.maxDrawdownFromReturns': () => [RETURNS()],
  'performance.underwater': () => [CLOSES()],
  'performance.analyze': () => [{ returns: RETURNS() }, { periodsPerYear: 252 }],
  'performance.beta': () => [RETURNS(), RETURNS()],
  'performance.alpha': () => [RETURNS(), RETURNS(), { periodsPerYear: 252 }],
  'performance.trackingError': () => [RETURNS(), RETURNS(), { periodsPerYear: 252 }],
  'performance.informationRatio': () => [RETURNS(), RETURNS(), { periodsPerYear: 252 }],
  'performance.turnover': () => [WEIGHTS_PATH()],
  'performance.exposure': () => [WEIGHTS_PATH()],
  'performance.rollingVolatility': () => [RETURNS(), 20, { periodsPerYear: 252 }],
  'performance.rollingSharpe': () => [RETURNS(), 20, { periodsPerYear: 252 }],
  'performance.rollingReturn': () => [RETURNS(), 20],
  'performance.simpleReturns': () => [CLOSES()],
  'performance.logReturns': () => [CLOSES()],
  'performance.cumulativeReturns': () => [RETURNS()],
  'performance.equityCurve': () => [RETURNS()],

  // risk
  'risk.valueAtRisk': () => [RETURNS(), { confidence: 0.95 }],
  'risk.expectedShortfall': () => [RETURNS(), { confidence: 0.95 }],

  // fixed-income (WS-2.7 explain facades)
  'fixed-income.yieldToMaturity': () => [FI_BOND(), { settlementDate: '2026-01-01', price: 105 }],
  'fixed-income.priceFromYield': () => [FI_BOND(), { settlementDate: '2026-01-01', yield: 0.04 }],
  'fixed-income.yieldMetrics': () => [FI_BOND(), { settlementDate: '2026-01-01', yield: 0.04 }],
  'fixed-income.curveMetrics': () => [FI_BOND(), FI_CURVE(), { settlementDate: '2026-01-01' }],
};

function FI_BOND(): unknown {
  return bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
}

function FI_CURVE(): unknown {
  return curves.fromZeroRates(
    [
      ['2027-01-01', 0.035],
      ['2029-01-01', 0.04],
      ['2031-01-01', 0.043],
    ],
    { referenceDate: '2026-01-01' },
  );
}

// ── dynamic fixtures ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry id → EXPORT name, resolved by identity.
 *
 * These are two different vocabularies and they are allowed to differ: a registry id is a
 * serialized TA-Lib / pandas-ta compatibility identity (`mad`, `cum`), while the export is the
 * library's own public name (`rollingMeanAbsoluteDeviation`, `cumulativeSum`). The fixture map is
 * keyed by MANIFEST id, i.e. by export name — so keying it off the registry id silently drops the
 * fixture for every indicator whose two names differ, and the coverage gate then reports the export
 * as unfixtured. Matching on the function object keeps the two vocabularies independent.
 */
function exportNameByRegistryId(): Map<string, string> {
  const byFunction = new Map<unknown, string>();
  for (const [name, value] of Object.entries(technicalAnalysis)) {
    if (typeof value === 'function' && !byFunction.has(value)) byFunction.set(value, name);
  }
  const out = new Map<string, string>();
  for (const entry of listIndicators()) {
    out.set(entry.name, byFunction.get(entry.indicator) ?? entry.name);
  }
  return out;
}

function taFixtures(): Map<string, FixtureThunk> {
  const out = new Map<string, FixtureThunk>();
  const registered = new Set(listIndicators().map((e) => e.name));
  const exportName = exportNameByRegistryId();
  // indicatorWarmups measures at canonical parameters — reuse those parameters as known-valid fixtures.
  for (const info of indicatorWarmups(96)) {
    if (!registered.has(info.name)) continue;
    const kind = info.inputs;
    const parameters = info.parameters;
    out.set(`technical-analysis.${exportName.get(info.name) ?? info.name}`, () => {
      const input =
        kind === 'series'
          ? CLOSES()
          : kind === 'bars'
            ? BARS()
            : pairs(
                CLOSES(),
                CLOSES().map((v, i) => v + Math.cos(i / 3) * 2),
              );
      return Object.keys(parameters).length > 0 ? [input, { ...parameters }] : [input];
    });
  }
  return out;
}

function strategyFixtures(): Map<string, FixtureThunk> {
  const out = new Map<string, FixtureThunk>();
  for (const d of listStrategies()) {
    out.set(`strategy.${d.name}`, () => [
      JSON.parse(JSON.stringify(d.example)) as Record<string, unknown>,
      { premiums: 'model', market: PREMIUM_MARKET() },
    ]);
  }
  out.set('strategy.buildStrategy', () => [
    {
      name: 'ironCondor',
      input: { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
      config: { premiums: 'model', market: PREMIUM_MARKET() },
    },
  ]);
  return out;
}

let cache: Map<string, FixtureThunk> | null = null;

/** All fixtures, keyed by sweep path. Built lazily (the ta generator runs the whole registry). */
export function allFixtures(): Map<string, FixtureThunk> {
  if (cache) return cache;
  const map = new Map<string, FixtureThunk>(Object.entries(STATIC));
  for (const shard of [
    TA_FIXTURES,
    OPTIONS_FIXTURES,
    FI_VOL_RISK_FIXTURES,
    MISC_FIXTURES,
    FUNDAMENTALS_FIXTURES,
    ANALYSIS_VALUATION_FIXTURES,
    RESEARCH_FIXTURES,
    FOREIGN_EXCHANGE_FIXTURES,
    COMMODITIES_FIXTURES,
    CORE_ARTIFACTS_FIXTURES,
    PERFORMANCE_FLOW_AWARE_FIXTURES,
    SECTOR_PERFORMANCE_FIXTURES,
    ANALYSIS_BACKTEST_CRYPTO_FIXTURES,
    ANALYSIS_FIXED_INCOME_FIXTURES,
    ANALYSIS_OPTIONS_STRATEGY_STRUCTURE_FIXTURES,
    ANALYSIS_RISK_FIXTURES,
    ANALYSIS_TA_FIXTURES,
    ANALYSIS_VOL_FIXTURES,
    VALUATION_PRIMITIVES_FIXTURES,
    CONSTRUCTOR_FIXTURES,
    PORTFOLIO_FIXTURES,
    DISCLOSED_HOLDINGS_FIXTURES,
    SCENARIOS_FIXTURES,
    VOLATILITY_ARTIFACTS_FIXTURES,
    FIXED_INCOME_ARTIFACTS_FIXTURES,
    RESEARCH_ARTIFACTS_FIXTURES,
    WORKFLOWS_FIXTURES,
    MCP_FIXTURES,
    CLI_FIXTURES,
    HTTP_FIXTURES,
    MATH_RESOURCE_FIXTURES,
    PAPER_FIXTURES,
    OBSERVED_SKEW_FIXTURES,
    STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES,
    STRUCTURE_SUPPLIED_EXPOSURE_FIXTURES,
    OPTION_CHAIN_HEALTH_FIXTURES,
  ]) {
    for (const [k, v] of Object.entries(shard)) if (!map.has(k)) map.set(k, v);
  }
  for (const [k, v] of taFixtures()) if (!map.has(k)) map.set(k, v);
  for (const [k, v] of strategyFixtures()) if (!map.has(k)) map.set(k, v);
  cache = map;
  return map;
}
