import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { publicSourcePaths } from './tools/public-packages.js';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests and the bundle harness run against package *source*, not built `dist`, so the whole
 * workspace is testable without a build step. Deep entrypoints are listed before bare package
 * specifiers so the more specific alias wins.
 */
export default defineConfig({
  resolve: {
    alias: {
      ...Object.fromEntries(
        Object.entries(publicSourcePaths(fromRoot('.')))
          .sort(([a], [b]) => b.length - a.length)
          .map(([name, paths]) => [name, fromRoot(paths[0]!)]),
      ),
      '@totalfinance/core/schema': fromRoot('./packages/core/src/schema/index.ts'),
      '@totalfinance/core/artifacts': fromRoot('./packages/core/src/artifacts/index.ts'),
      '@totalfinance/core/pricing': fromRoot('./packages/core/src/pricing.ts'),
      '@totalfinance/core': fromRoot('./packages/core/src/index.ts'),
      '@totalfinance/crypto/carry': fromRoot('./packages/crypto/src/carry.ts'),
      '@totalfinance/crypto/curve': fromRoot('./packages/crypto/src/curve.ts'),
      '@totalfinance/crypto/inverse': fromRoot('./packages/crypto/src/inverse.ts'),
      '@totalfinance/crypto/liquidation': fromRoot('./packages/crypto/src/liquidation.ts'),
      '@totalfinance/crypto': fromRoot('./packages/crypto/src/index.ts'),
      '@totalfinance/calendars/nyse': fromRoot('./packages/calendars/src/nyse.ts'),
      '@totalfinance/calendars/cboe': fromRoot('./packages/calendars/src/cboe.ts'),
      '@totalfinance/calendars/crypto': fromRoot('./packages/calendars/src/crypto.ts'),
      '@totalfinance/valuation/cash-flows': fromRoot('./packages/valuation/src/cash-flows.ts'),
      '@totalfinance/valuation/corporate': fromRoot('./packages/valuation/src/corporate.ts'),
      '@totalfinance/valuation/forecasting': fromRoot('./packages/valuation/src/forecasting.ts'),
      '@totalfinance/valuation': fromRoot('./packages/valuation/src/index.ts'),
      '@totalfinance/research/screening': fromRoot('./packages/research/src/screening.ts'),
      '@totalfinance/research/factors': fromRoot('./packages/research/src/factors.ts'),
      '@totalfinance/research/events': fromRoot('./packages/research/src/events.ts'),
      '@totalfinance/research/artifacts': fromRoot('./packages/research/src/artifacts.ts'),
      '@totalfinance/research': fromRoot('./packages/research/src/index.ts'),
      '@totalfinance/fundamentals/statements': fromRoot(
        './packages/fundamentals/src/statements.ts',
      ),
      '@totalfinance/fundamentals/ratios': fromRoot('./packages/fundamentals/src/ratios.ts'),
      '@totalfinance/fundamentals/scores': fromRoot('./packages/fundamentals/src/scores.ts'),
      '@totalfinance/fundamentals': fromRoot('./packages/fundamentals/src/index.ts'),
      '@totalfinance/foreign-exchange/spot': fromRoot('./packages/foreign-exchange/src/spot.ts'),
      '@totalfinance/foreign-exchange/forwards': fromRoot(
        './packages/foreign-exchange/src/forwards.ts',
      ),
      '@totalfinance/foreign-exchange/risk': fromRoot(
        './packages/foreign-exchange/src/exposure.ts',
      ),
      '@totalfinance/foreign-exchange': fromRoot('./packages/foreign-exchange/src/index.ts'),
      '@totalfinance/portfolio/disclosed-holding-partitions': fromRoot(
        './packages/portfolio/src/disclosed-holding-partitions.ts',
      ),
      '@totalfinance/portfolio/disclosed-holdings': fromRoot(
        './packages/portfolio/src/disclosed-holdings.ts',
      ),
      '@totalfinance/portfolio/events': fromRoot('./packages/portfolio/src/events.ts'),
      '@totalfinance/portfolio/ledger': fromRoot('./packages/portfolio/src/ledger.ts'),
      '@totalfinance/portfolio/performance': fromRoot('./packages/portfolio/src/performance.ts'),
      '@totalfinance/portfolio/reconciliation': fromRoot(
        './packages/portfolio/src/reconciliation.ts',
      ),
      '@totalfinance/portfolio/policy': fromRoot('./packages/portfolio/src/policy.ts'),
      '@totalfinance/portfolio/trade': fromRoot('./packages/portfolio/src/trade/index.ts'),
      '@totalfinance/volatility/artifacts': fromRoot('./packages/volatility/src/artifacts.ts'),
      '@totalfinance/fixed-income/artifacts': fromRoot('./packages/fixed-income/src/artifacts.ts'),
      '@totalfinance/portfolio': fromRoot('./packages/portfolio/src/index.ts'),
      '@totalfinance/scenarios/portfolio': fromRoot('./packages/scenarios/src/portfolio.ts'),
      '@totalfinance/scenarios': fromRoot('./packages/scenarios/src/index.ts'),
      '@totalfinance/commodities/forwards': fromRoot('./packages/commodities/src/forwards.ts'),
      '@totalfinance/commodities/term-structure': fromRoot(
        './packages/commodities/src/term-structure.ts',
      ),
      '@totalfinance/commodities': fromRoot('./packages/commodities/src/index.ts'),
      '@totalfinance/calendars': fromRoot('./packages/calendars/src/index.ts'),
      '@totalfinance/workflows/local': fromRoot('./packages/workflows/src/local/index.ts'),
      '@totalfinance/workflows': fromRoot('./packages/workflows/src/index.ts'),
      '@totalfinance/cli': fromRoot('./packages/cli/src/index.ts'),
      '@totalfinance/http': fromRoot('./packages/http/src/index.ts'),
      '@totalfinance/math/normal': fromRoot('./packages/math/src/normal.ts'),
      '@totalfinance/math/bivariate': fromRoot('./packages/math/src/bivariate.ts'),
      '@totalfinance/math/statistics': fromRoot('./packages/math/src/statistics.ts'),
      '@totalfinance/math/solvers': fromRoot('./packages/math/src/solvers.ts'),
      '@totalfinance/math/optimize': fromRoot('./packages/math/src/optimize.ts'),
      '@totalfinance/math/interpolation': fromRoot('./packages/math/src/interpolation.ts'),
      '@totalfinance/math/linalg': fromRoot('./packages/math/src/linalg.ts'),
      '@totalfinance/math/integration': fromRoot('./packages/math/src/integration.ts'),
      '@totalfinance/math/random': fromRoot('./packages/math/src/random.ts'),
      '@totalfinance/math/lowdiscrepancy': fromRoot('./packages/math/src/lowdiscrepancy.ts'),
      '@totalfinance/math/montecarlo': fromRoot('./packages/math/src/montecarlo.ts'),
      '@totalfinance/math/regression': fromRoot('./packages/math/src/regression.ts'),
      '@totalfinance/math/timeseries': fromRoot('./packages/math/src/timeseries.ts'),
      '@totalfinance/math/distributions': fromRoot('./packages/math/src/distributions.ts'),
      '@totalfinance/math/filters': fromRoot('./packages/math/src/filters.ts'),
      '@totalfinance/math': fromRoot('./packages/math/src/index.ts'),
      '@totalfinance/performance/sharpe': fromRoot('./packages/performance/src/sharpe.ts'),
      '@totalfinance/performance/returns': fromRoot('./packages/performance/src/returns.ts'),
      '@totalfinance/performance/drawdown': fromRoot('./packages/performance/src/drawdown.ts'),
      '@totalfinance/performance/metrics': fromRoot('./packages/performance/src/metrics.ts'),
      '@totalfinance/performance/analyze': fromRoot('./packages/performance/src/analyze.ts'),
      '@totalfinance/performance/ratios': fromRoot('./packages/performance/src/ratios.ts'),
      '@totalfinance/performance/relative': fromRoot('./packages/performance/src/relative.ts'),
      '@totalfinance/performance/activity': fromRoot('./packages/performance/src/activity.ts'),
      '@totalfinance/performance/rolling': fromRoot('./packages/performance/src/rolling.ts'),
      '@totalfinance/performance/flow-aware': fromRoot('./packages/performance/src/flow-aware.ts'),
      '@totalfinance/performance/sector-performance': fromRoot(
        './packages/performance/src/sector-performance.ts',
      ),
      '@totalfinance/performance': fromRoot('./packages/performance/src/index.ts'),
      '@totalfinance/risk/value-at-risk': fromRoot('./packages/risk/src/value-at-risk.ts'),
      '@totalfinance/risk/scenario': fromRoot('./packages/risk/src/scenario.ts'),
      '@totalfinance/risk/factor': fromRoot('./packages/risk/src/factor.ts'),
      '@totalfinance/risk/optimize': fromRoot('./packages/risk/src/optimize.ts'),
      '@totalfinance/risk/research': fromRoot('./packages/risk/src/research.ts'),
      '@totalfinance/risk/portfolio': fromRoot('./packages/risk/src/portfolio.ts'),
      '@totalfinance/risk/sizing': fromRoot('./packages/risk/src/sizing.ts'),
      '@totalfinance/risk': fromRoot('./packages/risk/src/index.ts'),
      '@totalfinance/backtest/vectorized': fromRoot('./packages/backtest/src/vectorized.ts'),
      '@totalfinance/backtest/event-driven': fromRoot('./packages/backtest/src/event-driven.ts'),
      '@totalfinance/backtest/costs': fromRoot('./packages/backtest/src/costs.ts'),
      '@totalfinance/backtest/tearsheet': fromRoot('./packages/backtest/src/tearsheet.ts'),
      '@totalfinance/backtest/options': fromRoot('./packages/backtest/src/options/index.ts'),
      '@totalfinance/backtest/execution': fromRoot('./packages/backtest/src/execution/index.ts'),
      '@totalfinance/backtest/cross-sectional': fromRoot(
        './packages/backtest/src/cross-sectional/index.ts',
      ),
      '@totalfinance/backtest/artifacts': fromRoot('./packages/backtest/src/artifacts.ts'),
      '@totalfinance/backtest/portfolio': fromRoot('./packages/backtest/src/portfolio/index.ts'),
      '@totalfinance/backtest/environment': fromRoot(
        './packages/backtest/src/environment/index.ts',
      ),
      '@totalfinance/backtest/paper': fromRoot('./packages/backtest/src/paper/index.ts'),
      '@totalfinance/backtest': fromRoot('./packages/backtest/src/index.ts'),
      '@totalfinance/options/batch': fromRoot('./packages/options/src/batch.ts'),
      '@totalfinance/options/black-scholes': fromRoot('./packages/options/src/black-scholes.ts'),
      '@totalfinance/options/black76': fromRoot('./packages/options/src/black76.ts'),
      '@totalfinance/options/bachelier': fromRoot('./packages/options/src/bachelier.ts'),
      '@totalfinance/options/monte-carlo': fromRoot('./packages/options/src/monte-carlo.ts'),
      '@totalfinance/options/heston': fromRoot('./packages/options/src/heston.ts'),
      '@totalfinance/options/sabr': fromRoot('./packages/options/src/sabr.ts'),
      '@totalfinance/options/local-volatility': fromRoot(
        './packages/options/src/local-volatility.ts',
      ),
      '@totalfinance/options/exotics': fromRoot('./packages/options/src/exotics.ts'),
      '@totalfinance/options/schema': fromRoot('./packages/options/src/schema.ts'),
      '@totalfinance/options/parity': fromRoot('./packages/options/src/parity.ts'),
      '@totalfinance/options/lattice': fromRoot('./packages/options/src/lattice.ts'),
      '@totalfinance/options/payoff': fromRoot('./packages/options/src/payoff.ts'),
      '@totalfinance/options/pricer': fromRoot('./packages/options/src/pricer.ts'),
      '@totalfinance/options': fromRoot('./packages/options/src/index.ts'),
      '@totalfinance/volatility/surface': fromRoot('./packages/volatility/src/surface.ts'),
      '@totalfinance/volatility/skew': fromRoot('./packages/volatility/src/skew.ts'),
      '@totalfinance/volatility/event': fromRoot('./packages/volatility/src/event.ts'),
      '@totalfinance/volatility/svi': fromRoot('./packages/volatility/src/svi.ts'),
      '@totalfinance/volatility/sabr': fromRoot('./packages/volatility/src/sabr.ts'),
      '@totalfinance/volatility/arbitrage': fromRoot('./packages/volatility/src/arbitrage.ts'),
      '@totalfinance/volatility/analytics': fromRoot('./packages/volatility/src/analytics.ts'),
      '@totalfinance/volatility/metrics': fromRoot('./packages/volatility/src/metrics.ts'),
      '@totalfinance/volatility/local-volatility': fromRoot(
        './packages/volatility/src/local-volatility.ts',
      ),
      '@totalfinance/volatility/heston-surface': fromRoot(
        './packages/volatility/src/heston-surface.ts',
      ),
      '@totalfinance/volatility/term': fromRoot('./packages/volatility/src/term.ts'),
      '@totalfinance/volatility/forecast': fromRoot('./packages/volatility/src/forecast.ts'),
      '@totalfinance/volatility/earnings': fromRoot('./packages/volatility/src/earnings.ts'),
      '@totalfinance/volatility/essvi': fromRoot('./packages/volatility/src/essvi.ts'),
      '@totalfinance/volatility/estimate': fromRoot('./packages/volatility/src/estimate.ts'),
      '@totalfinance/volatility/min-variance-delta': fromRoot(
        './packages/volatility/src/min-variance-delta.ts',
      ),
      '@totalfinance/volatility/risk-reversal': fromRoot(
        './packages/volatility/src/risk-reversal.ts',
      ),
      '@totalfinance/volatility/sabr-delta': fromRoot('./packages/volatility/src/sabr-delta.ts'),
      '@totalfinance/volatility/ssvi': fromRoot('./packages/volatility/src/ssvi.ts'),
      '@totalfinance/volatility/sticky-regime': fromRoot(
        './packages/volatility/src/sticky-regime.ts',
      ),
      '@totalfinance/volatility/surface-pca': fromRoot('./packages/volatility/src/surface-pca.ts'),
      '@totalfinance/volatility/swaption-cube': fromRoot(
        './packages/volatility/src/swaption-cube.ts',
      ),
      '@totalfinance/volatility/tail-risk': fromRoot('./packages/volatility/src/tail-risk.ts'),
      '@totalfinance/volatility/vanna-volga': fromRoot('./packages/volatility/src/vanna-volga.ts'),
      '@totalfinance/volatility/variance-index': fromRoot(
        './packages/volatility/src/variance-index.ts',
      ),
      '@totalfinance/volatility/volatility-spot-beta': fromRoot(
        './packages/volatility/src/volatility-spot-beta.ts',
      ),
      '@totalfinance/volatility': fromRoot('./packages/volatility/src/index.ts'),
      '@totalfinance/structure/exposure': fromRoot('./packages/structure/src/exposure.ts'),
      '@totalfinance/structure/flow': fromRoot('./packages/structure/src/flow.ts'),
      '@totalfinance/structure': fromRoot('./packages/structure/src/index.ts'),
      '@totalfinance/technical-analysis/rsi': fromRoot('./packages/technical-analysis/src/rsi.ts'),
      '@totalfinance/technical-analysis/moving-averages': fromRoot(
        './packages/technical-analysis/src/moving-averages.ts',
      ),
      '@totalfinance/technical-analysis/macd': fromRoot(
        './packages/technical-analysis/src/macd.ts',
      ),
      '@totalfinance/technical-analysis/bands': fromRoot(
        './packages/technical-analysis/src/bands.ts',
      ),
      '@totalfinance/technical-analysis/pipeline': fromRoot(
        './packages/technical-analysis/src/pipeline.ts',
      ),
      '@totalfinance/technical-analysis/bars': fromRoot(
        './packages/technical-analysis/src/bars.ts',
      ),
      '@totalfinance/technical-analysis/transforms': fromRoot(
        './packages/technical-analysis/src/transforms.ts',
      ),
      '@totalfinance/technical-analysis/resample': fromRoot(
        './packages/technical-analysis/src/resample.ts',
      ),
      '@totalfinance/technical-analysis/divergence': fromRoot(
        './packages/technical-analysis/src/divergence.ts',
      ),
      '@totalfinance/technical-analysis/microstructure': fromRoot(
        './packages/technical-analysis/src/microstructure.ts',
      ),
      '@totalfinance/technical-analysis/candle-talib': fromRoot(
        './packages/technical-analysis/src/candle-talib.ts',
      ),
      '@totalfinance/technical-analysis/oscillators': fromRoot(
        './packages/technical-analysis/src/oscillators.ts',
      ),
      '@totalfinance/technical-analysis/momentum': fromRoot(
        './packages/technical-analysis/src/momentum.ts',
      ),
      '@totalfinance/technical-analysis/overlap': fromRoot(
        './packages/technical-analysis/src/overlap.ts',
      ),
      '@totalfinance/technical-analysis/features': fromRoot(
        './packages/technical-analysis/src/features.ts',
      ),
      '@totalfinance/technical-analysis/trend': fromRoot(
        './packages/technical-analysis/src/trend.ts',
      ),
      '@totalfinance/technical-analysis/aliases': fromRoot(
        './packages/technical-analysis/src/aliases.ts',
      ),
      '@totalfinance/technical-analysis/warmup': fromRoot(
        './packages/technical-analysis/src/warmup.ts',
      ),
      '@totalfinance/technical-analysis/volatility': fromRoot(
        './packages/technical-analysis/src/volatility.ts',
      ),
      '@totalfinance/technical-analysis/volume': fromRoot(
        './packages/technical-analysis/src/volume.ts',
      ),
      '@totalfinance/technical-analysis/candlesticks': fromRoot(
        './packages/technical-analysis/src/candlesticks.ts',
      ),
      '@totalfinance/technical-analysis/candle-aliases': fromRoot(
        './packages/technical-analysis/src/candle-aliases.ts',
      ),
      '@totalfinance/technical-analysis/cycle': fromRoot(
        './packages/technical-analysis/src/cycle.ts',
      ),
      '@totalfinance/technical-analysis/statistics': fromRoot(
        './packages/technical-analysis/src/statistics.ts',
      ),
      '@totalfinance/technical-analysis/chart-types': fromRoot(
        './packages/technical-analysis/src/chart-types.ts',
      ),
      '@totalfinance/technical-analysis/price-action': fromRoot(
        './packages/technical-analysis/src/price-action.ts',
      ),
      '@totalfinance/technical-analysis/math': fromRoot(
        './packages/technical-analysis/src/math.ts',
      ),
      '@totalfinance/technical-analysis/signal': fromRoot(
        './packages/technical-analysis/src/signal.ts',
      ),
      '@totalfinance/technical-analysis/registry': fromRoot(
        './packages/technical-analysis/src/registry.ts',
      ),
      '@totalfinance/technical-analysis/series': fromRoot(
        './packages/technical-analysis/src/series.ts',
      ),
      '@totalfinance/technical-analysis/framework': fromRoot(
        './packages/technical-analysis/src/framework.ts',
      ),
      '@totalfinance/technical-analysis': fromRoot('./packages/technical-analysis/src/index.ts'),
      '@totalfinance/strategy/scanner': fromRoot('./packages/strategy/src/scanner.ts'),
      '@totalfinance/strategy/probability': fromRoot('./packages/strategy/src/probability.ts'),
      '@totalfinance/strategy/from-chain': fromRoot('./packages/strategy/src/from-chain.ts'),
      '@totalfinance/strategy': fromRoot('./packages/strategy/src/index.ts'),
      '@totalfinance/fixed-income/conventions': fromRoot(
        './packages/fixed-income/src/conventions.ts',
      ),
      '@totalfinance/fixed-income/curves': fromRoot('./packages/fixed-income/src/curves.ts'),
      '@totalfinance/fixed-income/bonds': fromRoot('./packages/fixed-income/src/bonds.ts'),
      '@totalfinance/fixed-income/rates': fromRoot('./packages/fixed-income/src/rates.ts'),
      '@totalfinance/fixed-income/models': fromRoot('./packages/fixed-income/src/models.ts'),
      '@totalfinance/fixed-income/credit': fromRoot('./packages/fixed-income/src/credit.ts'),
      '@totalfinance/fixed-income/lattice': fromRoot('./packages/fixed-income/src/lattice.ts'),
      '@totalfinance/fixed-income/convertible': fromRoot(
        './packages/fixed-income/src/convertible.ts',
      ),
      '@totalfinance/fixed-income/xva': fromRoot('./packages/fixed-income/src/xva.ts'),
      '@totalfinance/fixed-income/cross-currency': fromRoot(
        './packages/fixed-income/src/cross-currency.ts',
      ),
      '@totalfinance/fixed-income/futures': fromRoot('./packages/fixed-income/src/futures.ts'),
      '@totalfinance/fixed-income/inflation': fromRoot('./packages/fixed-income/src/inflation.ts'),
      '@totalfinance/fixed-income/pricer': fromRoot('./packages/fixed-income/src/pricer.ts'),
      '@totalfinance/fixed-income': fromRoot('./packages/fixed-income/src/index.ts'),
      '@totalfinance/mcp': fromRoot('./packages/mcp/src/index.ts'),
      // The umbrella (bare `totalfinance`); no `@` prefix, so it never shadows the scoped aliases above.
      'totalfinance/options': fromRoot('./packages/totalfinance/src/options.ts'),
      'totalfinance/core': fromRoot('./packages/totalfinance/src/core.ts'),
      'totalfinance/math': fromRoot('./packages/totalfinance/src/math.ts'),
      'totalfinance/crypto': fromRoot('./packages/totalfinance/src/crypto.ts'),
      'totalfinance/valuation': fromRoot('./packages/totalfinance/src/valuation.ts'),
      'totalfinance/research': fromRoot('./packages/totalfinance/src/research.ts'),
      'totalfinance/foreign-exchange': fromRoot('./packages/totalfinance/src/foreign-exchange.ts'),
      'totalfinance/commodities': fromRoot('./packages/totalfinance/src/commodities.ts'),
      'totalfinance/portfolio': fromRoot('./packages/totalfinance/src/portfolio.ts'),
      'totalfinance/scenarios': fromRoot('./packages/totalfinance/src/scenarios.ts'),
      'totalfinance/fundamentals': fromRoot('./packages/totalfinance/src/fundamentals.ts'),
      'totalfinance/calendars': fromRoot('./packages/totalfinance/src/calendars.ts'),
      'totalfinance/performance': fromRoot('./packages/totalfinance/src/performance.ts'),
      'totalfinance/risk': fromRoot('./packages/totalfinance/src/risk.ts'),
      'totalfinance/backtest': fromRoot('./packages/totalfinance/src/backtest.ts'),
      'totalfinance/volatility': fromRoot('./packages/totalfinance/src/volatility.ts'),
      'totalfinance/structure': fromRoot('./packages/totalfinance/src/structure.ts'),
      'totalfinance/technical-analysis': fromRoot(
        './packages/totalfinance/src/technical-analysis.ts',
      ),
      'totalfinance/strategy': fromRoot('./packages/totalfinance/src/strategy.ts'),
      'totalfinance/fixed-income': fromRoot('./packages/totalfinance/src/fixed-income.ts'),
      totalfinance: fromRoot('./packages/totalfinance/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // The advanced-quant Monte-Carlo cross-validation tests (Heston QE, SABR/local-vol SDE
    // simulation, exotics) price tens of thousands of paths and run several per file. Standalone each
    // takes a few seconds, but under full parallel workers CPU contention inflates an individual test
    // ~3× — enough to brush a 20s cap and flake. 45s gives that contention real headroom (a genuinely
    // hung test still fails well within it) so `pnpm run ci` is deterministically green.
    testTimeout: 45_000,
    // WS1.16 — deflake. The residual intermittent failures were NOT numerical (every MC test is
    // seeded, so its value is deterministic; the Bjerksund–Stensland/Crank–Nicolson cases use no RNG
    // at all) — they were worker-level failures from CPU+memory OVERSUBSCRIPTION: with the default
    // one-worker-per-core pool, N CPU-bound MC files run at once and thrash the machine, so a worker
    // occasionally times out or is OOM-killed and its whole file is marked failed (it passes on a
    // lower-contention re-run). Capping the pool at half the cores removes the oversubscription while
    // keeping meaningful parallelism, so the suite is stable in one pass.
    maxWorkers: '50%',
    // An event-loop turn after every test, so back-to-back synchronous tests cannot hold a worker
    // past its 60 s progress-RPC timeout (`Timeout calling "onTaskUpdate"` with every test passing).
    // Long single tests yield inside with tools/test-support/cooperative-yield.ts.
    setupFiles: [fromRoot('./tools/test-support/yield-between-tests.ts')],
    include: ['packages/*/test/**/*.test.ts', 'docs/**/*.test.ts', 'tools/**/*.test.ts'],
    benchmark: {
      include: ['packages/*/bench/**/*.bench.ts'],
    },
    coverage: {
      // istanbul instruments at the source level, which (unlike v8) attributes coverage correctly
      // through the workspace `resolve.alias` that maps `@totalfinance/*` to package source. `all` is
      // off because the static-instrumentation pass it triggers does not reconcile with the
      // alias-resolved runtime paths in this monorepo (it would report every file as 0%); the suite
      // imports every package entrypoint, so executed-file coverage is representative.
      provider: 'istanbul',
      all: false,
      include: ['packages/*/src/**/*.ts'],
      // Pure type modules and ambient declarations carry no runtime logic to cover.
      exclude: ['**/*.test.ts', '**/types.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'text', 'html'],
      // Enforced floor (WS/R5): current executed-file coverage is ~95% stmts / 85% branches / 96%
      // funcs / 96% lines; the thresholds sit a couple points below so a genuine regression fails
      // `pnpm test:coverage` (wired into `pnpm run ci`) without flaking on normal variation. These are
      // GLOBAL over executed files — `all:false` is retained because istanbul's static pass does not
      // reconcile with this monorepo's `@totalfinance/*`→source aliases (it would report every file 0%).
      thresholds: {
        statements: 93,
        branches: 82,
        functions: 93,
        lines: 93,
      },
    },
  },
});
