import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runSiteExamplesAgainstInstalled,
  siteExampleCases,
  siteExamplesSha256,
  type SiteExamplesSmokeResult,
} from './site-examples-smoke.js';
import {
  captureSmokeSource,
  createSmokeReceipt,
  observeWithEvidence,
  writeSmokeReceipt,
  type SmokeEvidence,
  type SmokeReceipt,
} from './release/registry-smoke.js';
import type { ReleaseManifest } from './release/dry-run.js';
import { playgrounds } from '../site/src/playgrounds/index.js';
import { registerInstalledConsumerTests } from './bundle-size/consumer-tests.js';
import { assertInstalledIndicatorMetadata } from './bundle-size/indicator-metadata-consumer.js';
import {
  assertInstalledPublicArtifacts,
  assertPublicPackageDependencies,
  type PublicDependencyMetadata,
} from './bundle-size/public-artifacts.js';
import { CONSUMER_BUNDLERS, CONSUMER_FIXTURES } from './bundle-size/consumer-fixtures.js';
import { measureConsumer } from './bundle-size/consumer-measure.js';
import {
  MCP_PACKAGE_NAME,
  PUBLIC_PACKAGE_NAME,
  publicPackageDirectories,
  toPublicSpecifier,
} from './public-packages.js';

/**
 * Alignment-spec P1.5 — the PACKED-consumer matrix. Workspace imports prove nothing about what
 * ships: this suite `pnpm pack`s exactly the two distribution packages, installs the tarballs into a real out-of-tree
 * consumer with npm, and exercises the published artifacts:
 *
 *   - Node ESM `import` of the umbrella and a scoped deep subpath;
 *   - `require(ESM)` interop (the `default` condition) — honest framing: this is interop on
 *     Node ≥ 22.13.0 (unflagged 22.12.0, warning-free 22.13.0), NOT a CommonJS build;
 *   - TypeScript resolution under BOTH `moduleResolution: "nodenext"` and `"bundler"`, strict.
 *
 * Runs against the packed tarballs only — a `files` allowlist mistake, a broken `exports` target,
 * or a d.ts that references unshipped sources fails HERE, not on a user's machine.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_DIR = join(ROOT, 'packages');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');
// The full, pretty-printed trade OpenAPI exceeds Node's default 1 MiB capture buffer.
const OPENAPI_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * One direct-public-import fixture for both source compile smoke (public-reference.test.ts) and
 * the packed NodeNext/Bundler consumer. No casts/spreads may hide report-to-artifact assignability.
 */
const DOGFOODING_PUBLIC_CONSUMER_TS = `
import { resolvedExpiry, type OptionContract } from '@insiderfinance/totalfinance/core';
import {
  compareCalculationArtifacts, createAnalysisArtifact, readAnalysisArtifact,
  type CalculationArtifactComparison,
} from '@insiderfinance/totalfinance/core/artifacts';
import { optionChainHealth, type OptionChainHealthReport } from '@insiderfinance/totalfinance/options';
import { exposureFromGreeks, type SuppliedExposureReport } from '@insiderfinance/totalfinance/structure';

const asOf = Date.parse('2026-09-01T15:00:00Z');
const contract: OptionContract = {
  underlying: 'TEST', type: 'put', style: 'american', strike: 100,
  expiry: '2026-09-18', ...resolvedExpiry('2026-09-18'), multiplier: 100,
};
const exposureInput: Parameters<typeof exposureFromGreeks>[0] = {
  quotes: [{ contract, timestampMs: asOf, source: 'synthetic-chain', openInterest: 10,
    greeks: { delta: -0.4, gamma: 0.02, provenance: { source: 'synthetic-greeks', timestampMs: asOf } } }],
  market: { underlying: 'TEST', spot: 100, asOf, source: 'synthetic-spot', timestampMs: asOf },
  config: { gexConvention: { calls: 1, puts: -1 }, dexConvention: { calls: 1, puts: 1 },
    gammaUnit: 'per1PercentMove', maximumObservationAgeMs: 60000 },
};
const exposureReport: SuppliedExposureReport = exposureFromGreeks(exposureInput);
const exposureArtifact = createAnalysisArtifact({
  artifactType: 'supplied-exposure', producedBy: { operation: 'structure.exposureFromGreeks' },
  inputs: { parameters: exposureInput }, result: exposureReport,
});

const healthInput: Parameters<typeof optionChainHealth>[0] = {
  quotes: [{ contract, timestampMs: asOf, bid: 1, ask: 1.2 }],
  market: { underlying: 'TEST', asOf },
  config: { priceSource: 'mid', maximumQuoteAgeMs: 60000, maximumRelativeSpread: 0.5 },
};
const healthReport: OptionChainHealthReport = optionChainHealth(healthInput);
const healthArtifact = createAnalysisArtifact({
  artifactType: 'chain-health', producedBy: { operation: 'options.optionChainHealth' },
  inputs: { parameters: healthInput }, result: healthReport,
});

const comparisonReport: CalculationArtifactComparison = compareCalculationArtifacts({
  baseline: exposureArtifact, candidate: exposureArtifact,
  metrics: [{ name: 'net-gex',
    baseline: { path: ['aggregate', 'gex'], unit: 'USD-delta-per-1%-spot-move' },
    candidate: { path: ['aggregate', 'gex'], unit: 'USD-delta-per-1%-spot-move' },
    tolerance: { absolute: 1e-6, relative: 1e-12 } }],
});
const comparisonArtifact = createAnalysisArtifact({
  artifactType: 'calculation-comparison',
  producedBy: { operation: 'core.compareCalculationArtifacts' }, result: comparisonReport,
});

if (exposureReport.aggregate.gex !== -2000 || exposureReport.aggregate.dex !== -40000)
  throw new Error('supplied exposure arithmetic drifted');
if (exposureReport.coverage.includedQuotes !== 1 || healthReport.summary.quoteCount !== 1)
  throw new Error('synthetic quote coverage drifted');
if (comparisonReport.status !== 'match' || comparisonReport.metrics[0]?.withinTolerance !== true)
  throw new Error('self-comparison did not match');
for (const artifact of [exposureArtifact, healthArtifact, comparisonArtifact]) {
  if (readAnalysisArtifact({ artifact }).artifact.id !== artifact.id)
    throw new Error('direct report artifact failed validation');
}
console.log('DOGFOODING_PUBLIC_OK gex=-2000 dex=-40000 quotes=1 artifacts=3');
`;

let work: string;
let consumer: string;
let releaseManifest: ReleaseManifest;
let tarballDir: string;
let retainedReceiptPath: string | undefined;

// These examples deliberately use synchronous child processes to inspect isolated installed
// packages. Promise-only transitions between tests do not let the worker read IPC replies: a
// traced solo run delayed progress acknowledgements for the entire 34-second file, and the same
// file took 64 seconds in full coverage, past Vitest's 60-second RPC deadline. Yield between
// examples so acknowledgements can drain. Keep every example, assertion, and timeout unchanged.
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});

/**
 * FC7 exit-gate row (slice 5): "Serialization/migration/replay works through packed browser,
 * Node, worker, and local-store fixtures without a database dependency." ONE ledger journey —
 * a deposit, a fill, a 4-for-1 split — is folded in every environment against the PACKED
 * `@insiderfinance/totalfinance/portfolio`, and each prints the ledger's content hash so a reviewer can compare
 * them across environments (the last test asserts they agree). Plain JS (no numeric separators or
 * TS syntax) so the same text runs in a worker file, a browser bundle, and a Node script.
 */
const LEDGER_JOURNEY_JS = `
const at = (month, day) => Date.UTC(2026, month - 1, day, 15);
const envelope = (eventId, effectiveTimestampMs, event) => ({
  eventId,
  schemaVersion: 1,
  eventType: event.eventType,
  sourceId: 'packed-fixture',
  accountId: 'main',
  effectiveTimestampMs,
  recordedTimestampMs: effectiveTimestampMs,
  event,
  provenance: {},
});
// 100,000 in; 100 AAPL @ 150 (cash 85,000); 4-for-1 split -> 400 AAPL @ 37.5 basis.
const JOURNEY = [
  envelope('dep-1', at(1, 2), { eventType: 'cash.deposit', amount: 100000, currency: 'USD' }),
  envelope('fill-1', at(1, 10), { eventType: 'trade.fill', instrumentId: 'AAPL', side: 'buy', quantity: 100, pricePerUnit: 150, currency: 'USD' }),
  envelope('split-1', at(1, 20), { eventType: 'corporate.split', instrumentId: 'AAPL', sharesAfterSplit: 4, sharesBeforeSplit: 1 }),
];
// Sell 100 of the 400 @ 40 (realized (40 - 37.5) x 100 = 250); a 75 dividend.
const MORE = [
  envelope('fill-2', at(2, 3), { eventType: 'trade.fill', instrumentId: 'AAPL', side: 'sell', quantity: 100, pricePerUnit: 40, currency: 'USD' }),
  envelope('div-1', at(2, 10), { eventType: 'income.received', incomeType: 'dividend', amount: 75, currency: 'USD', instrumentId: 'AAPL' }),
];
`;

/**
 * Stage 4.4b's smallest useful shared scenario, written as plain JavaScript so the exact same
 * public call runs in Node, a worker, and a browser bundle from the packed install.
 */
const STOCK_SCENARIO_JS = `
const runPackedStockScenario = () => {
  const result = runScenarios({
    scenarioSet: createScenarioSet({
      name: 'packed-stock-stress',
      scenarios: [
        { name: 'AAPL +10%', shocks: [{ factor: 'spot', target: 'AAPL', kind: 'percent', value: 0.1 }] },
      ],
    }),
    market: createMarketSnapshot({
      asOf: 1788048000000,
      observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
    }),
    targets: [scenarioTarget.spot({ id: 'aapl', symbol: 'AAPL', quantity: 2, currency: 'USD' })],
  });
  const base = result.base[0];
  const cell = result.cells[0];
  if (base?.status !== 'complete' || cell?.status !== 'complete') throw new Error('stock scenario did not complete');
  if (base.valuePerUnit !== 100 || base.positionValue !== 200) throw new Error('stock base value drifted');
  if (Math.abs(cell.valuePerUnit - 110) > 1e-12 || Math.abs(cell.localPnl - 20) > 1e-12)
    throw new Error('stock scenario value drifted');
  if (!Object.isFrozen(result) || !Object.isFrozen(result.cells)) throw new Error('scenario result is not deeply frozen');
  return result;
};
`;

/** The journey's content hash as printed by each environment (`<ENV>_OK <hash>`). */
/**
 * Stage 4.5 (slice 6): ONE artifact journey over the three `./artifacts` subpaths — calibrate /
 * bootstrap / screen → save → canonical JSON → restore → evaluate → replay parity → compare — whose
 * canonical bytes must agree in Node, a worker, and a web-only browser bundle. Plain JS (no TS
 * syntax) so the same text runs everywhere; every law is asserted from INSIDE the journey so a
 * silent drift in any environment fails loudly, not by comparison alone.
 */
const ARTIFACT_JOURNEY_JS = `
import { canonicalJsonOf, fromCanonicalJson } from '@insiderfinance/totalfinance/core/artifacts';
import { calibrateSvi } from '@insiderfinance/totalfinance/volatility';
import { compareFittedModels, evaluateFittedModel, fittedModelArtifact, readFittedModel, replayFittedModel } from '@insiderfinance/totalfinance/volatility/artifacts';
import { curves } from '@insiderfinance/totalfinance/fixed-income';
import { compareFittedModels as compareCurveModels, evaluateFittedModel as evaluateCurveModel, fittedModelArtifact as curveArtifact, readFittedModel as readCurveModel, replayFittedModel as replayCurveModel } from '@insiderfinance/totalfinance/fixed-income/artifacts';
import { screenUniverse } from '@insiderfinance/totalfinance/research';
import { compareResearchRuns, readResearchRun, replayResearchRun, researchRunArtifact } from '@insiderfinance/totalfinance/research/artifacts';
import { crossSectionalBacktest } from '@insiderfinance/totalfinance/backtest';
import { backtestRunArtifact, compareBacktestRuns, readBacktestRun, replayBacktestRun } from '@insiderfinance/totalfinance/backtest/artifacts';
import { optionsBacktest } from '@insiderfinance/totalfinance/backtest/options';
import { portfolioBacktest } from '@insiderfinance/totalfinance/backtest/portfolio';

const runPackedArtifactJourney = () => {
  // Volatility: an SVI smile.
  const k = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
  const w = k.map((x) => 0.04 + 0.4 * (-0.4 * (x - 0.05) + Math.sqrt((x - 0.05) ** 2 + 0.15 ** 2)));
  const smile = { k, w };
  const sviArtifact = fittedModelArtifact({ family: 'svi', fit: calibrateSvi(smile, { timeToExpiryYears: 0.5 }), calibration: { smile, options: { timeToExpiryYears: 0.5 } } });
  const sviRestored = readFittedModel({ artifact: fromCanonicalJson(canonicalJsonOf(sviArtifact)) });
  if (canonicalJsonOf(sviRestored.report) !== canonicalJsonOf(sviArtifact.result)) throw new Error('svi restore changed the report bytes');
  const sviEvaluated = evaluateFittedModel({ model: sviRestored.report, at: { logMoneyness: [-0.2, 0, 0.2] } });
  if (sviEvaluated.values.length !== 3 || sviEvaluated.values.some((v) => !(v > 0))) throw new Error('svi evaluation drifted');
  const sviReplay = replayFittedModel({ artifact: sviArtifact });
  if (!sviReplay.parity.identical) throw new Error('svi replay parity failed');
  const scaled = { k, w: w.map((x) => x * 1.05) };
  const sviComparison = compareFittedModels({ baseline: sviArtifact, candidate: fittedModelArtifact({ family: 'svi', fit: calibrateSvi(scaled, { timeToExpiryYears: 0.5 }), calibration: { smile: scaled, options: { timeToExpiryYears: 0.5 } } }) });
  if (sviComparison.sameCalibrationInput !== false || sviComparison.parameters.length === 0) throw new Error('svi comparison drifted');

  // Fixed income: a bootstrapped discount curve.
  const instruments = [
    { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
    { type: 'swap', maturity: '2028-01-01', rate: 0.032, fixedFrequency: 'semiannual' },
    { type: 'swap', maturity: '2031-01-01', rate: 0.035, fixedFrequency: 'semiannual' },
  ];
  const options = { referenceDate: '2026-01-01' };
  const curve = curves.bootstrap(instruments, options);
  const curveSaved = curveArtifact({ family: 'discount-curve', fit: curve, calibration: { instruments, options }, currency: 'USD' });
  const curveRestored = readCurveModel({ artifact: fromCanonicalJson(canonicalJsonOf(curveSaved)) });
  const discount = evaluateCurveModel({ model: curveRestored.report, at: { dates: ['2028-06-30'], measure: 'discount' } });
  if (discount.values[0] !== curve.discount('2028-06-30')) throw new Error('restored curve is not the live curve');
  const curveReplay = replayCurveModel({ artifact: curveSaved });
  if (!curveReplay.parity.identical) throw new Error('curve replay parity failed');
  const bumped = instruments.map((i) => ({ ...i, rate: i.rate + 0.001 }));
  const curveComparison = compareCurveModels({ baseline: curveSaved, candidate: curveArtifact({ family: 'discount-curve', fit: curves.bootstrap(bumped, options), calibration: { instruments: bumped, options }, currency: 'USD' }) });
  if (curveComparison.sameCalibrationInput !== false) throw new Error('curve comparison drifted');

  // Research: a screen with its rows referenced by content hash.
  const observations = [
    { instrumentId: 'AAA', availableTimestampMs: 1785542400000, fields: { freeCashFlowYield: 0.06 } },
    { instrumentId: 'BBB', availableTimestampMs: 1785542400000, fields: { freeCashFlowYield: 0.08 } },
    { instrumentId: 'CCC', availableTimestampMs: 1785542400000, fields: { freeCashFlowYield: 0.02 } },
  ];
  const input = {
    universeId: 'us-large-cap', asOf: 1786564800000, observations,
    fieldDefinitions: [{ fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' }],
    filter: { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.03 },
    missingValuePolicy: 'exclude',
    orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
  };
  const runArtifact = researchRunArtifact({ kind: 'screen', run: screenUniverse(input), input, referenceRowSets: ['observations'] });
  const runRestored = readResearchRun({ artifact: fromCanonicalJson(canonicalJsonOf(runArtifact)) });
  if (runRestored.report.assumptions.inputPolicy !== 'referenced') throw new Error('research rows were not referenced');
  const runReplay = replayResearchRun({ artifact: runArtifact, referencedData: { observations } });
  if (!runReplay.parity.identical) throw new Error('research replay parity failed');
  const looser = { ...input, filter: { ...input.filter, value: 0.01 } };
  const runComparison = compareResearchRuns({ baseline: runArtifact, candidate: researchRunArtifact({ kind: 'screen', run: screenUniverse(looser), input: looser }) });
  if (runComparison.membership.entered.ids.join() !== 'CCC') throw new Error('research comparison drifted');

  // Backtest (Stage 4.6 slice 3): a cross-sectional run with its returns referenced by content hash.
  const sessions = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23'];
  const names = ['AAA', 'BBB', 'CCC'];
  const request = {
    dataset: {
      observations: names.map((instrumentId, n) => ({ instrumentId, availableTimestampMs: 1767222000000, fields: { quality: 3 - n } })),
      fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' }],
      returns: names.flatMap((instrumentId, n) => sessions.map((tradingSessionDate, i) => ({ instrumentId, tradingSessionDate, simpleReturn: (1 - n) * 0.01 + (i % 2 === 0 ? 0.001 : -0.001) }))),
    },
    universeHistory: { universeId: 'packed-3', members: names.map((instrumentId) => ({ instrumentId, fromTimestampMs: 1767222000000 })) },
    signal: { score: { components: [{ field: 'quality', weight: 1, direction: 'higher-is-better', standardization: 'z-score' }], missingValuePolicy: 'exclude' } },
    rebalanceSchedule: { frequency: 'monthly', session: 'close' },
    portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
    initialCapital: 100000,
  };
  const backtestRun = crossSectionalBacktest(request);
  const backtestArtifact = backtestRunArtifact({ kind: 'cross-sectional', run: backtestRun, input: request, referenceRowSets: ['dataset.returns'] });
  const backtestRestored = readBacktestRun({ artifact: fromCanonicalJson(canonicalJsonOf(backtestArtifact)) });
  if (backtestRestored.report.assumptions.inputPolicy !== 'referenced') throw new Error('backtest returns were not referenced');
  const backtestReplay = replayBacktestRun({ artifact: backtestArtifact, referencedData: { 'dataset.returns': request.dataset.returns } });
  if (!backtestReplay.matches) throw new Error('backtest replay did not reproduce the run hash');
  const wider = { ...request, portfolioConstruction: { method: 'equal-weight', long: { count: 3 } } };
  const backtestComparison = compareBacktestRuns({ baseline: backtestArtifact, candidate: backtestRunArtifact({ kind: 'cross-sectional', run: crossSectionalBacktest(wider), input: wider }) });
  if (backtestComparison.holdings.entered.ids.join() !== 'CCC') throw new Error('backtest comparison drifted');

  // Options book (Stage 4.6 slice 4): a two-snapshot chain with hand-written mids and deltas; the run's
  // ledger reconciles, the artifact replays to the same run hash in every environment.
  const chain = (date, spot) => ({
    asOf: date + 'T21:00:00Z', // the 16:00 EST close: a valuation instant, never a bare date
    underlyingPrice: spot,
    quotes: [90, 95, 100, 105, 110].flatMap((strike) => ['call', 'put'].map((type) => {
      const intrinsic = type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
      const distance = Math.abs(spot - strike);
      return {
        contract: { underlying: 'XYZ', type, style: 'european', strike, expiry: '2026-02-20', expiresAt: 1771617600000, expiryConvention: 'us-equity-close', multiplier: 100 },
        timestampMs: Date.parse(date + 'T21:00:00Z'),
        mid: intrinsic + Math.max(0.25, 4 - distance * 0.6),
        impliedVolatility: 0.2,
        delta: type === 'call' ? Math.max(0.05, Math.min(0.95, 0.5 + (spot - strike) * 0.06)) : -Math.max(0.05, Math.min(0.95, 0.5 - (spot - strike) * 0.06)),
        underlyingPrice: spot,
      };
    })),
  });
  const optionsConfig = {
    chains: [chain('2026-01-05', 100), chain('2026-01-12', 101), chain('2026-01-19', 102)],
    riskFreeRate: 0.04,
    entry: { daysToExpiry: { target: 45, min: 20, max: 60 }, structure: 'bullPutSpread', select: { shortDelta: 0.3, width: 5 } },
    exit: { profitTarget: 0.5, daysToExpiry: 21 },
    book: { maximumOpenPositions: 1 },
  };
  const optionsRun = optionsBacktest(optionsConfig);
  if (Math.abs(optionsRun.diagnostics.reconciliationResidual) > 1e-9) throw new Error('options ledger did not reconcile');
  const optionsArtifact = backtestRunArtifact({ kind: 'options', run: optionsRun, input: optionsConfig });
  const optionsRestored = readBacktestRun({ artifact: fromCanonicalJson(canonicalJsonOf(optionsArtifact)) });
  const optionsReplay = replayBacktestRun({ artifact: optionsArtifact });
  if (!optionsReplay.matches) throw new Error('options replay did not reproduce the run hash');

  // Portfolio engine (Stage 4.6 slice 5): two equities on daily bars, a weekly equal-weight model;
  // the run's ledger reconciles and the artifact replays to the same run hash in every environment.
  const days = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13'];
  const bars = days.flatMap((date, i) => ['AAA', 'BBB'].map((symbol) => {
    const close = (symbol === 'AAA' ? 100 : 50) * (1 + i * (symbol === 'AAA' ? 0.004 : -0.002));
    return { symbol, timestampMs: Date.parse(date + 'T21:00:00Z'), open: close * 0.995, high: close * 1.01, low: close * 0.99, close, volume: 1000000 };
  }));
  const portfolioRequest = {
    accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100000 }] },
    instruments: { AAA: { kind: 'equity', currency: 'USD' }, BBB: { kind: 'equity', currency: 'USD' } },
    marketData: { bars },
    strategy: { model: [{ group: { instrumentId: 'AAA' }, weight: 0.5 }, { group: { instrumentId: 'BBB' }, weight: 0.5 }], schedule: { frequency: 'weekly' } },
    calendar: 'NYSE',
  };
  const portfolioRun = portfolioBacktest(portfolioRequest);
  if (Math.abs(portfolioRun.diagnostics.reconciliationResidual) > 1e-9) throw new Error('portfolio ledger did not reconcile');
  if (portfolioRun.fills.length === 0) throw new Error('portfolio run placed no fills');
  const portfolioArtifact = backtestRunArtifact({ kind: 'portfolio', run: portfolioRun, input: portfolioRequest, referenceRowSets: ['marketData.bars'] });
  const portfolioRestored = readBacktestRun({ artifact: fromCanonicalJson(canonicalJsonOf(portfolioArtifact)) });
  const portfolioReplay = replayBacktestRun({ artifact: portfolioArtifact, referencedData: { 'marketData.bars': bars } });
  if (!portfolioReplay.matches) throw new Error('portfolio replay did not reproduce the run hash');

  // The journey's identity: every artifact id and the six restored reports, as canonical bytes.
  return canonicalJsonOf({
    ids: { svi: sviArtifact.id, curve: curveSaved.id, run: runArtifact.id, backtest: backtestArtifact.id, options: optionsArtifact.id, portfolio: portfolioArtifact.id },
    reports: { svi: sviRestored.report, curve: curveRestored.report, run: runRestored.report, backtest: backtestRestored.report, options: optionsRestored.report, portfolio: portfolioRestored.report },
    parity: { svi: sviReplay.parity.identical, curve: curveReplay.parity.identical, run: runReplay.parity.identical, backtest: backtestReplay.matches, options: optionsReplay.matches, portfolio: portfolioReplay.matches },
  });
};
`;

const artifactBytesByEnvironment: Record<string, string> = {};

function recordArtifactBytes(environment: string, output: string, marker: string): string {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${marker} `));
  if (line === undefined)
    throw new Error(`${environment}: no '${marker} <JSON string>' line in:\n${output}`);
  const bytes = JSON.parse(line.slice(marker.length + 1)) as unknown;
  if (typeof bytes !== 'string' || !bytes.startsWith('{')) {
    throw new Error(`${environment}: malformed canonical artifact bytes in:\n${output}`);
  }
  artifactBytesByEnvironment[environment] = bytes;
  return bytes;
}

const journeyHashByEnvironment: Record<string, string> = {};

/** Canonical scenario-result bytes emitted by each packed execution environment. */
const scenarioBytesByEnvironment: Record<string, string> = {};

function recordJourneyHash(environment: string, output: string, marker: string): string {
  const match = new RegExp(`${marker} (sha256:[0-9a-f]{64})`).exec(output);
  if (match === null) throw new Error(`${environment}: no '${marker} <hash>' line in:\n${output}`);
  journeyHashByEnvironment[environment] = match[1]!;
  return match[1]!;
}

function recordScenarioBytes(environment: string, output: string, marker: string): string {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${marker} `));
  if (line === undefined)
    throw new Error(`${environment}: no '${marker} <JSON string>' line in:\n${output}`);
  const bytes = JSON.parse(line.slice(marker.length + 1)) as unknown;
  if (typeof bytes !== 'string' || !bytes.startsWith('{')) {
    throw new Error(`${environment}: malformed canonical scenario bytes in:\n${output}`);
  }
  scenarioBytesByEnvironment[environment] = bytes;
  return bytes;
}

function outputExcerpt(output: string | null): string {
  const text = output ?? '';
  const edge = 4096;
  if (text.length <= edge * 2) return text;
  return `${text.slice(0, edge)}\n[... ${text.length - edge * 2} characters omitted; ${Buffer.byteLength(text)} bytes captured ...]\n${text.slice(-edge)}`;
}

function sh(cmd: string, args: string[], cwd: string, maxBuffer = 1024 * 1024): string {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
  if (result.error !== undefined || result.status !== 0) {
    // Keep the spawn error (including ENOBUFS), exit status, signal, and both streams visible.
    // Do not attach the raw result as a cause: reporters would serialize its entire OpenAPI
    // stdout again, defeating the bounded head/tail diagnostics.
    throw new Error(
      `${cmd} ${args.join(' ')} failed in ${cwd}:\n` +
        `error: ${result.error === undefined ? 'none' : String(result.error)}\n` +
        `status: ${result.status}; signal: ${result.signal ?? 'none'}; maxBuffer: ${maxBuffer} bytes\n` +
        `stderr: ${outputExcerpt(result.stderr)}\nstdout: ${outputExcerpt(result.stdout)}`,
    );
  }
  return result.stdout;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'totalfinance-packed-'));
  tarballDir = join(work, 'tarballs');
  consumer = join(work, 'consumer');
  sh('mkdir', ['-p', tarballDir, consumer], work);

  const deps: Record<string, string> = {};
  const artifacts: ReleaseManifest['packages'] = [];
  for (const { path: pkgPath, name } of publicPackageDirectories(ROOT)) {
    const manifest = JSON.parse(
      readFileSync(join(pkgPath, 'package.json'), 'utf8'),
    ) as PublicDependencyMetadata;
    assertPublicPackageDependencies(manifest, name, manifest.version);
    const out = sh('pnpm', ['pack', '--pack-destination', tarballDir], pkgPath).trim();
    const tgz = out.split('\n').at(-1)!.trim();
    // Validate the actual tarball too, before npm can resolve any dependency from a registry.
    const packedManifest = JSON.parse(
      sh('tar', ['-xOf', tgz, 'package/package.json'], work),
    ) as PublicDependencyMetadata;
    assertPublicPackageDependencies(packedManifest, name, manifest.version);
    deps[name] = `file:${tgz}`;
    const bytes = readFileSync(tgz);
    artifacts.push({
      package: name,
      version: manifest.version,
      tarball: basename(tgz),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  expect(artifacts.map((artifact) => artifact.package)).toEqual([
    PUBLIC_PACKAGE_NAME,
    MCP_PACKAGE_NAME,
  ]);
  expect(readdirSync(tarballDir).filter((file) => file.endsWith('.tgz'))).toHaveLength(2);
  const versions = new Set(artifacts.map((artifact) => artifact.version));
  if (versions.size !== 1)
    throw new Error('Packed examples require matching main and MCP versions.');
  expect([...versions]).toEqual(['0.1.0']);
  const source = captureSmokeSource();
  releaseManifest = {
    version: artifacts[0]!.version,
    commit: source.sourceCommit,
    sourceDirty: source.sourceDirty,
    packages: artifacts,
  };
  writeFileSync(
    join(tarballDir, 'RELEASE_HASHES.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      { name: 'totalfinance-packed-consumer', private: true, dependencies: deps },
      null,
      2,
    ),
  );
  sh(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
    consumer,
  );
}, 240_000);

// The packed tree carries the two distribution tarballs plus the consumer's installed
// node_modules; removal historically exceeded vitest's 10 s hook default under CI load. Bounded from the
// measurement (a few seconds idle), not left to the default.
afterAll(() => {
  if (work) {
    try {
      if (retainedReceiptPath) {
        rmSync(consumer, { recursive: true, force: true });
        const receipt = JSON.parse(readFileSync(retainedReceiptPath, 'utf8')) as SmokeReceipt;
        expect(receipt.examplesCount).toBe(24);
        expect(receipt.origin.kind).toBe('tarball-rehearsal');
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}, 60_000);

// TS1/TS3 reuse the tarballs and installation above; no duplicate pack/install cycle.
registerInstalledConsumerTests(() => consumer);

it('the complete installed indicator catalog is independent of discovery imports', async () => {
  const coverage = await assertInstalledIndicatorMetadata(consumer);
  expect(coverage.names).toBe(335);
  expect(coverage.identities).toBe(321);
  expect(coverage.leafEntrypoints).toBeGreaterThan(20);
  expect(coverage.comparisons).toBeGreaterThan(335 * 10);
  expect(coverage.dependentDefaults.sort()).toEqual([
    'chaikinVolatility.rocPeriod',
    'relativeVolatilityIndex.stdevPeriod',
    'vidya.cmoPeriod',
  ]);
  expect(coverage.nullableDefaults).toContain('tosStdevAll.period');
}, 120_000);

describe('site copy buttons against installed tarballs and release receipts', () => {
  let result: SiteExamplesSmokeResult;

  it('strictly typechecks and executes all 24 exact first-call/full default/edited copies from the installed tarballs', () => {
    const samples = siteExampleCases();
    expect(samples).toHaveLength(24);
    expect(samples.map((sample) => sample.id)).toEqual(
      playgrounds.flatMap((playground) => [
        `${playground.id}-default`,
        `${playground.id}-default-first-call`,
        `${playground.id}-edited`,
        `${playground.id}-edited-first-call`,
      ]),
    );
    result = runSiteExamplesAgainstInstalled(consumer, releaseManifest.version);
    expect(result).toMatchObject({
      version: releaseManifest.version,
      cases: 24,
      sha256: siteExamplesSha256(samples),
      caseIds: samples.map((sample) => sample.id),
      typecheck: { modes: ['nodenext', 'bundler'], strict: true, skipLibCheck: false },
    });
    const directories = readdirSync(consumer).filter((name) =>
      name.startsWith('site-example-smoke-'),
    );
    expect(directories).toHaveLength(1);
    for (const sample of samples) {
      expect(readFileSync(join(consumer, directories[0]!, `${sample.id}.mts`), 'utf8')).toBe(
        sample.code,
      );
      // Actual checked output, not a rewritten source or independently transpiled surrogate.
      expect(
        readFileSync(join(consumer, directories[0]!, 'compiled', `${sample.id}.mjs`), 'utf8'),
      ).toContain('console.log(result);');
    }
    expect(new Set(Object.values(result.packages))).toEqual(new Set([releaseManifest.version]));
  }, 120_000);

  it.each(['full', 'first-call'] as const)(
    'fails a syntactically valid %s copy that transpile-only checking would accept',
    (surface) => {
      const playground = playgrounds[0]!;
      const original = playground.run;
      const mock = vi.spyOn(playground, 'run').mockImplementation((input) => {
        const calculation = original(input);
        return {
          ...calculation,
          ...(surface === 'full'
            ? { code: `${calculation.code}\nconst mustBeNumeric: number = 'wrong type';` }
            : {
                example: {
                  ...calculation.example,
                  code: `${calculation.example.code}\nconst mustBeNumeric: number = 'wrong type';`,
                },
              }),
        };
      });
      try {
        expect(() => runSiteExamplesAgainstInstalled(consumer, releaseManifest.version)).toThrow(
          /strict nodenext typecheck[\s\S]*not assignable to type 'number'/,
        );
      } finally {
        mock.mockRestore();
      }
    },
    120_000,
  );

  it('rejects a first-call result mismatch and binds that surface into the release fingerprint', () => {
    const playground = playgrounds[0]!;
    const original = playground.run;
    const baseline = siteExamplesSha256();
    const mock = vi.spyOn(playground, 'run').mockImplementation((input) => {
      const calculation = original(input);
      return { ...calculation, example: { ...calculation.example, result: -999 } };
    });
    try {
      expect(siteExamplesSha256()).not.toBe(baseline);
      expect(() => runSiteExamplesAgainstInstalled(consumer, releaseManifest.version)).toThrow(
        /first-call: copied example differs from the displayed result/,
      );
    } finally {
      mock.mockRestore();
    }
  }, 120_000);

  it('refuses version drift and workspace imports rather than issuing partial evidence', () => {
    expect(() => runSiteExamplesAgainstInstalled(consumer, '999.0.0')).toThrow(
      /expected 999\.0\.0/,
    );
    const playground = playgrounds[0]!;
    const original = playground.run;
    const mock = vi.spyOn(playground, 'run').mockImplementation((input) => {
      const calculation = original(input);
      return {
        ...calculation,
        code: `import '../../packages/options/src/index.js';\n${calculation.code}`,
      };
    });
    try {
      expect(() => runSiteExamplesAgainstInstalled(consumer, releaseManifest.version)).toThrow(
        /not an installed TotalFinance package entrypoint/,
      );
    } finally {
      mock.mockRestore();
    }
  });

  it('the receipt is version/commit/example bound and distinguishes rehearsal from registry verification', () => {
    const observation = {
      ...JSON.parse(readFileSync(join(ROOT, 'tools/release/smoke-expected.json'), 'utf8')),
      version: releaseManifest.version,
    } as SmokeEvidence['observation'];
    const evidence: SmokeEvidence = { observation, siteExamples: result };
    const source = { sourceCommit: releaseManifest.commit, sourceDirty: true };
    const origin = {
      kind: 'tarball-rehearsal' as const,
      manifestCommit: releaseManifest.commit,
      manifestSha256: createHash('sha256')
        .update(readFileSync(join(tarballDir, 'RELEASE_HASHES.json')))
        .digest('hex'),
    };
    const expectations = {
      matched: true,
      sha256: createHash('sha256')
        .update(readFileSync(join(ROOT, 'tools/release/smoke-expected.json')))
        .digest('hex'),
    };
    const input = {
      evidence,
      source,
      origin,
      expectations,
      verifiedAt: '2026-09-07T00:00:00.000Z',
    };
    const receipt = createSmokeReceipt(input);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      version: releaseManifest.version,
      sourceCommit: releaseManifest.commit,
      sourceDirty: true,
      registry: null,
      examplesCount: 24,
      examplesSha256: result.sha256,
      origin,
    });
    expect(receipt.observation).toEqual(observation);
    expect(createSmokeReceipt(input)).toEqual(receipt);
    expect(() =>
      createSmokeReceipt({
        ...input,
        evidence: { ...evidence, siteExamples: { ...result, version: '999.0.0' } },
      }),
    ).toThrow(/Inconsistent/);
    expect(() =>
      createSmokeReceipt({ ...input, origin: { ...origin, manifestCommit: '0'.repeat(40) } }),
    ).toThrow(/source commit/);
    expect(() =>
      createSmokeReceipt({
        ...input,
        origin: { kind: 'registry-verification', registry: 'https://secret:token@example.test/' },
      }),
    ).toThrow(/without credentials/);
    const registryReceipt = createSmokeReceipt({
      ...input,
      origin: { kind: 'registry-verification', registry: 'https://registry.example.test/' },
    });
    expect(registryReceipt.registry).toBe('https://registry.example.test');
    expect(registryReceipt.sourceDirty).toBe(true); // A version or registry label never erases a dirty checkout.
    expect(registryReceipt).not.toHaveProperty('published');
  });

  it('the release CLI retains a tarball receipt after cleaning its temporary installed consumer', () => {
    const path = join(work, 'retained-smoke.json');
    const output = sh(
      process.execPath,
      [
        '--import',
        'tsx',
        join(ROOT, 'tools/release/registry-smoke.ts'),
        '--version',
        releaseManifest.version,
        '--tarballs',
        tarballDir,
        '--receipt',
        path,
      ],
      ROOT,
      OPENAPI_MAX_BUFFER,
    );
    expect(output).toContain('every journey matches');
    expect(output).toContain('24 typechecked site examples');
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as SmokeReceipt;
    expect(receipt).toMatchObject({
      sourceCommit: releaseManifest.commit,
      version: releaseManifest.version,
      registry: null,
      examplesCount: 24,
      examplesSha256: siteExamplesSha256(),
      origin: { kind: 'tarball-rehearsal' },
      expectations: { matched: true },
    });
    expect(receipt.siteExamples.caseIds).toEqual(siteExampleCases().map((sample) => sample.id));
    expect(JSON.stringify(receipt)).not.toContain(work);
    expect(JSON.stringify(receipt)).not.toContain(ROOT);
    expect(receipt.observation).not.toHaveProperty('siteExamples');
    expect(receipt.sourceDirty).toBe(captureSmokeSource().sourceDirty);
  }, 180_000);

  it('the evidence API durably retains explicitly unapproved rehearsal results without changing SmokeObservation', () => {
    const evidence = observeWithEvidence(
      consumer,
      releaseManifest.version,
      releaseManifest.packages.map((artifact) => artifact.package),
    );
    const receipt = createSmokeReceipt({
      evidence,
      source: captureSmokeSource(),
      origin: {
        kind: 'tarball-rehearsal',
        manifestCommit: releaseManifest.commit,
        manifestSha256: createHash('sha256')
          .update(readFileSync(join(tarballDir, 'RELEASE_HASHES.json')))
          .digest('hex'),
      },
      // Deliberately no assertion that this live result matches the maintainer-approved baseline.
      expectations: {
        matched: false,
        sha256: createHash('sha256')
          .update(readFileSync(join(ROOT, 'tools/release/smoke-expected.json')))
          .digest('hex'),
      },
    });
    retainedReceiptPath = join(work, 'unapproved-rehearsal-receipt.json');
    writeSmokeReceipt(retainedReceiptPath, receipt);
    expect(JSON.parse(readFileSync(retainedReceiptPath, 'utf8'))).toEqual(receipt);
    expect(receipt.examplesSha256).toBe(result.sha256);
    expect(receipt.registry).toBeNull();
    expect(receipt.expectations.matched).toBe(false);
    expect(receipt.observation).not.toHaveProperty('siteExamples');
    // The afterAll hook deletes the actual consumer before rereading this retained file.
  }, 120_000);
});

describe('packed command capture', () => {
  it('captures complete JSON beyond the default 1 MiB with an explicit bounded buffer', () => {
    const bytes = 2 * 1024 * 1024;
    const output = sh(
      process.execPath,
      ['-e', `console.log(JSON.stringify({ payload: 'x'.repeat(${bytes}), complete: true }))`],
      consumer,
      OPENAPI_MAX_BUFFER,
    );
    const document = JSON.parse(output) as { payload: string; complete: boolean };
    expect(document.payload).toHaveLength(bytes);
    expect(document.complete).toBe(true);
  });

  it('still fails explicitly if a command exceeds its finite capture limit', () => {
    expect(() =>
      sh(process.execPath, ['-e', "console.log('x'.repeat(2 * 1024 * 1024))"], consumer, 1024),
    ).toThrow(/ENOBUFS[\s\S]*maxBuffer: 1024 bytes/);
  });

  it('reports real nonzero exits and bounded excerpts of both streams without a huge raw cause', () => {
    let failure: unknown;
    try {
      sh(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { writeSync } from 'node:fs';
writeSync(1, 'STDOUT_HEAD' + 'x'.repeat(32768) + 'STDOUT_TAIL');
writeSync(2, 'STDERR_HEAD' + 'y'.repeat(32768) + 'STDERR_TAIL');
process.exitCode = 7;`,
        ],
        consumer,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain('status: 7; signal: none; maxBuffer: 1048576 bytes');
    expect(error.message).toMatch(/stderr: STDERR_HEAD[\s\S]*characters omitted[\s\S]*STDERR_TAIL/);
    expect(error.message).toMatch(/stdout: STDOUT_HEAD[\s\S]*characters omitted[\s\S]*STDOUT_TAIL/);
    expect(error.message.length).toBeLessThan(20_000);
    expect(error.cause).toBeUndefined();
  });
});

describe('packed consumer (P1.5) — the published artifacts, not the workspace', () => {
  it('only the two public artifacts ship, with closed dependencies, declarations, maps and sources', () => {
    const counts = assertInstalledPublicArtifacts(consumer, releaseManifest.version);
    expect(counts.javascript).toBeGreaterThan(100);
    expect(counts.declarations).toBe(counts.javascript);
    expect(counts.maps).toBe(counts.javascript + counts.declarations);
  });

  it('private names, domain manifests and main/MCP internals are not public imports', () => {
    const privateNames = readdirSync(PKG_DIR).map((dir) =>
      dir === 'totalfinance' ? 'totalfinance' : `@totalfinance/${dir}`,
    );
    const script = `
import assert from 'node:assert/strict';
for (const specifier of ${JSON.stringify(privateNames)}) {
  await assert.rejects(import(specifier), { code: 'ERR_MODULE_NOT_FOUND' });
}
for (const specifier of [
  '@insiderfinance/totalfinance/core/package.json',
  '@insiderfinance/totalfinance/technical-analysis/package.json',
  '@insiderfinance/totalfinance/modules/core/dist/index.js',
  '@insiderfinance/totalfinance/mcp',
]) {
  await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
console.log('PRIVATE_BOUNDARIES_OK');
`;
    expect(sh('node', ['--input-type=module', '-e', script], consumer)).toContain(
      'PRIVATE_BOUNDARIES_OK',
    );
  });

  it('root, domain and deep imports share callable, constructor and error identities', () => {
    const script = `
import assert from 'node:assert/strict';
import { blackScholes, core, options, technicalAnalysis } from '@insiderfinance/totalfinance';
import { InputError, QuantError } from '@insiderfinance/totalfinance/core';
import { blackScholes as domain } from '@insiderfinance/totalfinance/options';
import { blackScholes as deep } from '@insiderfinance/totalfinance/options/black-scholes';
import { rsi } from '@insiderfinance/totalfinance/technical-analysis/rsi';
assert.equal(blackScholes, domain);
assert.equal(blackScholes, deep);
assert.equal(options.blackScholes, deep);
assert.equal(technicalAnalysis.rsi, rsi);
assert.equal(core.InputError, InputError);
assert.equal(core.QuantError, QuantError);
assert.throws(() => deep.call({}), error => error instanceof InputError && error instanceof QuantError && error instanceof core.InputError);
console.log('MODULE_IDENTITY_OK');
`;
    expect(sh('node', ['--input-type=module', '-e', script], consumer)).toContain(
      'MODULE_IDENTITY_OK',
    );
  });

  for (const bundler of CONSUMER_BUNDLERS) {
    it.each(['workflows/local', 'cli', 'http'])(
      `${bundler}: explicit Node-only /%s is not silently browser-compatible`,
      async (subpath) => {
        const specifier = `${PUBLIC_PACKAGE_NAME}/${subpath}`;
        await expect(
          measureConsumer(
            consumer,
            {
              ...CONSUMER_FIXTURES[0]!,
              id: `node-only-${subpath.replace('/', '-')}`,
              specifier,
              source: `import * as nodeOnly from '${specifier}'; globalThis.consumerCall = () => Object.keys(nodeOnly);`,
            },
            bundler,
          ),
        ).rejects.toThrow(/node:|Node-only module/);
      },
      60_000,
    );
  }

  it.each(['nodenext', 'bundler'] as const)(
    'signed leg constructors and retired-name/required-quantity contracts survive packing under %s',
    (resolution) => {
      const dir = join(consumer, `signed-legs-${resolution}`);
      sh('mkdir', ['-p', dir], consumer);
      const contracts = readFileSync(
        join(ROOT, 'packages/strategy/test/legs.compile.ts'),
        'utf8',
      ).replace(
        /(['"])(@totalfinance\/[^'"]+|totalfinance(?:\/[^'"]+)?)\1/g,
        (_match, quote: string, specifier: string) => quote + toPublicSpecifier(specifier) + quote,
      );
      writeFileSync(
        join(dir, 'consumer.mts'),
        contracts +
          `
import { strategy as umbrellaStrategy } from '@insiderfinance/totalfinance';
import { InputError, ErrorCode } from '@insiderfinance/totalfinance/core';
const umbrellaLegs = umbrellaStrategy.legs;
if (Object.keys(legs).join(',') !== 'call,put,stock') throw new Error('Unexpected constructors');
if (umbrellaLegs !== legs) throw new Error('Umbrella leg surface diverged');
const position = strategy([
  legs.call({ strike: 100, premium: 6, quantity: 2 }),
  legs.call({ strike: 110, premium: 2, quantity: -1 }),
]);
if (position.pnlAtExpiry(120) !== 2000) throw new Error('Signed-call payoff drift');
if (strategy([legs.put({ strike: 100, premium: 3, quantity: -2 })]).pnlAtExpiry(90) !== -1400)
  throw new Error('Signed-put payoff drift');
if (strategy([legs.stock({ price: 100, quantity: -12.5 })], { multiplier: 50 }).pnlAtExpiry(110) !== -125)
  throw new Error('Stock share units drift');
for (const [make, input] of [
  [legs.call, { strike: 100 }], [legs.put, { strike: 100 }], [legs.stock, { price: 100 }],
] as const) {
  let caught: unknown;
  try { Reflect.apply(make, undefined, [input]); } catch (error) { caught = error; }
  if (!(caught instanceof InputError) || caught.code !== ErrorCode.InputMissingField || !caught.message.includes('quantity'))
    throw new Error('Missing quantity did not teach at the packed boundary');
}
console.log('SIGNED_LEGS_PACKED_OK');
`,
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: resolution === 'nodenext' ? 'nodenext' : 'esnext',
            moduleResolution: resolution,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            target: 'es2022',
            outDir: './compiled',
          },
          include: ['consumer.mts'],
        }),
      );
      sh(TSC, ['-p', dir], dir);
      expect(sh('node', [join(dir, 'compiled/consumer.mjs')], consumer)).toContain(
        'SIGNED_LEGS_PACKED_OK',
      );
    },
    120_000,
  );
  it.each(['nodenext', 'bundler'] as const)(
    'dogfooding direct public exports compile and reports save under moduleResolution: %s',
    (resolution) => {
      const dir = join(consumer, `dogfooding-public-${resolution}`);
      sh('mkdir', ['-p', dir], consumer);
      writeFileSync(join(dir, 'consumer.mts'), DOGFOODING_PUBLIC_CONSUMER_TS);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: resolution === 'nodenext' ? 'nodenext' : 'esnext',
            moduleResolution: resolution,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            target: 'es2022',
            outDir: './compiled',
          },
          include: ['consumer.mts'],
        }),
      );
      // No paths aliases, workspace sources, type assertions, or transpile-only runner.
      sh(TSC, ['-p', dir], dir);
      expect(sh('node', [join(dir, 'compiled/consumer.mjs')], consumer)).toContain(
        'DOGFOODING_PUBLIC_OK gex=-2000 dex=-40000 quotes=1 artifacts=3',
      );
    },
    120_000,
  );
  it('the running Node satisfies the published engines floor (>=22.13.0)', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    expect(maj! > 22 || (maj === 22 && min! >= 13)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(consumer, 'node_modules', PUBLIC_PACKAGE_NAME, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    expect(manifest.engines?.node).toBe('>=22.13.0');
  });

  it('Node ESM: imports the umbrella and a deep scoped subpath and computes', () => {
    const script = `
      import { blackScholes, technicalAnalysis } from '@insiderfinance/totalfinance';
      import { blackScholes as blackScholesDeep, blackScholesPrice } from '@insiderfinance/totalfinance/options/black-scholes';
      import { blackScholesPriceMany } from '@insiderfinance/totalfinance/options/batch';
      import { expectedMoveFromImpliedVolatility } from '@insiderfinance/totalfinance/volatility';
      const p = blackScholes.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
      if (Math.abs(p - 0.8983963669668142) > 1e-12) throw new Error('umbrella price drifted: ' + p);
      if (!(expectedMoveFromImpliedVolatility({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 }).oneSigma > 9))
        throw new Error('@insiderfinance/totalfinance/volatility umbrella subpath broken');
      if (blackScholesDeep.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 }) !== p)
        throw new Error('deep entrypoint disagrees with the umbrella');
      const raw = blackScholesPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, dividendYield: 0, volatility: 0.22 });
      if (raw !== p) throw new Error('named raw kernel disagrees with the facade');
      const batch = blackScholesPriceMany({
        spot: Float64Array.of(100), strike: Float64Array.of(105), timeToExpiryYears: Float64Array.of(30 / 365),
        riskFreeRate: Float64Array.of(0.045), dividendYield: Float64Array.of(0), volatility: Float64Array.of(0.22),
        type: Int8Array.of(1),
      });
      if (batch.price[0] !== p) throw new Error('packed columnar path disagrees with the scalar path');
      const r = technicalAnalysis.rsi([44,44.34,44.09,43.61,44.33,44.83,45.1,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46,46.03,46.41,46.22,45.64]);
      if (!Number.isFinite(r.at(-1))) throw new Error('rsi tail is not finite');
      console.log('ESM_OK');
    `;
    const out = sh('node', ['--input-type=module', '-e', script], consumer);
    expect(out).toContain('ESM_OK');
  }, 60_000);

  it('require(ESM) interop: the default condition serves CJS consumers on Node >= 22.13.0', () => {
    const script = `
      const { blackScholes } = require('@insiderfinance/totalfinance');
      const p = blackScholes.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
      if (Math.abs(p - 0.8983963669668142) > 1e-12) throw new Error('require price drifted: ' + p);
      const { valueAtRisk } = require('@insiderfinance/totalfinance/risk');
      if (!Number.isFinite(valueAtRisk([0.01, -0.02, 0.015, -0.005, 0.008]))) throw new Error('VaR not finite');
      console.log('REQUIRE_OK');
    `;
    const out = sh('node', ['-e', script], consumer);
    expect(out).toContain('REQUIRE_OK');
  }, 60_000);

  it('a real bundler (esbuild) bundles the packed install and the bundle executes', () => {
    const dir = join(consumer, 'bundled');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'entry.mjs'),
      `
import { blackScholes } from '@insiderfinance/totalfinance';
import { blackScholes as blackScholesDeep, blackScholesPrice } from '@insiderfinance/totalfinance/options/black-scholes';
import { blackScholesPriceMany } from '@insiderfinance/totalfinance/options/batch';
const p = blackScholes.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
if (Math.abs(p - 0.8983963669668142) > 1e-12) throw new Error('bundled price drifted: ' + p);
if (blackScholesDeep.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 }) !== p)
  throw new Error('bundled deep entrypoint disagrees');
if (blackScholesPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, dividendYield: 0, volatility: 0.22 }) !== p)
  throw new Error('bundled named raw kernel disagrees');
if (blackScholesPriceMany({
  spot: Float64Array.of(100), strike: Float64Array.of(105), timeToExpiryYears: Float64Array.of(30 / 365),
  riskFreeRate: Float64Array.of(0.045), dividendYield: Float64Array.of(0), volatility: Float64Array.of(0.22),
  type: Int8Array.of(1),
}).price[0] !== p) throw new Error('bundled columnar path disagrees');
console.log('BUNDLE_OK');
`,
    );
    const esbuild = join(ROOT, 'node_modules', '.bin', 'esbuild');
    sh(
      esbuild,
      [
        join(dir, 'entry.mjs'),
        '--bundle',
        '--platform=neutral',
        '--format=esm',
        `--outfile=${join(dir, 'bundle.mjs')}`,
      ],
      consumer,
    );
    const out = sh('node', [join(dir, 'bundle.mjs')], consumer);
    expect(out).toContain('BUNDLE_OK');
  }, 120_000);

  it('FC7 worker fixture: a worker_threads Worker folds the ledger and the parent restores it from a structured clone', () => {
    const dir = join(consumer, 'ledger-worker');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'worker.mjs'),
      `
import { parentPort } from 'node:worker_threads';
import { createPortfolioLedger, portfolioLedgerContentHash } from '@insiderfinance/totalfinance/portfolio';
${LEDGER_JOURNEY_JS}
const ledger = createPortfolioLedger({ portfolioId: 'packed', baseCurrency: 'USD', events: JOURNEY });
// ledger.toJSON() is a deeply frozen canonical tree; structured clone carries it across the thread.
parentPort.postMessage({
  snapshot: ledger.toJSON(),
  hash: portfolioLedgerContentHash(ledger.toJSON()),
  eventCount: ledger.state.eventCount,
  quantity: ledger.state.accounts.main.positions.AAPL.quantity,
});
`,
    );
    writeFileSync(
      join(dir, 'parent.mjs'),
      `
import { Worker } from 'node:worker_threads';
import { readPortfolioLedgerSnapshot, portfolioLedgerContentHash } from '@insiderfinance/totalfinance/portfolio';
const message = await new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url));
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) => { if (code !== 0) reject(new Error('worker exited with ' + code)); });
});
if (Object.isFrozen(message.snapshot)) throw new Error('a structured clone is a fresh tree, never the frozen original');
const { ledger, migrationsApplied } = readPortfolioLedgerSnapshot({ snapshot: message.snapshot });
if (migrationsApplied.length !== 0) throw new Error('a current-version envelope needs no migration');
const hash = portfolioLedgerContentHash(ledger.toJSON());
if (hash !== message.hash) throw new Error('parent hash ' + hash + ' != worker hash ' + message.hash);
if (ledger.state.eventCount !== message.eventCount) throw new Error('eventCount drifted across the thread');
if (ledger.state.eventCount !== 3) throw new Error('expected 3 applied events, got ' + ledger.state.eventCount);
if (ledger.state.accounts.main.positions.AAPL.quantity !== 400 || message.quantity !== 400)
  throw new Error('the split did not fold to 400 AAPL');
if (ledger.state.accounts.main.cashBalances.USD.totalAmount !== 85000) throw new Error('cash drifted');
console.log('WORKER_OK ' + hash + ' events=' + ledger.state.eventCount);
`,
    );
    const out = sh('node', [join(dir, 'parent.mjs')], consumer);
    expect(out).toContain('WORKER_OK');
    recordJourneyHash('worker', out, 'WORKER_OK');
  }, 120_000);

  it('the installed local runner finds its shipped worker by relative URL and preserves the SDK report', () => {
    const dir = join(consumer, 'installed-job-worker');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'run.mjs'),
      `
import assert from 'node:assert/strict';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { jsonSafe } from '@insiderfinance/totalfinance/workflows';
import { createFileArtifactStore, createLocalJobRunner, registryForProfile } from '@insiderfinance/totalfinance/workflows/local';
const registry = registryForProfile({ profile: 'full' });
const directory = ${JSON.stringify(join(dir, 'store'))};
const runner = createLocalJobRunner({ registry, directory, profile: 'full', clock: () => new Date().toISOString() });
const id = 'totalfinance.backtest.environment_episode';
const input = { episode: 'range-bound', policy: { baseline: 'buyAndHold' }, seed: 7 };
assert.equal(registry.require(id).costClass, 'job');
const expected = canonicalJsonOf(jsonSafe(registry.run({ id, input }).structured));
let workers = 0;
process.on('worker', () => workers++);
const run = runner.submit({ id, input });
assert.equal(run.record.state, 'running');
const deadline = setTimeout(() => { void run.cancel(); }, 30000);
try {
  const done = await run.completion;
  assert.equal(workers, 1, 'The installed operation must really spawn its shipped worker');
  assert.equal(done.state, 'completed', JSON.stringify(done.error));
  assert.equal(done.result.kind, 'report');
  const report = createFileArtifactStore({ directory }).get(done.result.uri).value;
  assert.equal(report.operation.id, id);
  assert.equal(canonicalJsonOf(jsonSafe(report.structured)), expected);
  assert.equal(runner.get(done.id).state, 'completed');
} finally {
  clearTimeout(deadline);
}
console.log('INSTALLED_RELATIVE_WORKER_OK');
`,
    );
    expect(sh('node', [join(dir, 'run.mjs')], consumer)).toContain('INSTALLED_RELATIVE_WORKER_OK');
  }, 120_000);

  it('FC7 browser fixture: an esbuild browser bundle round-trips the ledger inside a vm context with web globals only', () => {
    const dir = join(consumer, 'ledger-browser');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'entry.mjs'),
      `
import { createPortfolioLedger, readPortfolioLedgerSnapshot, portfolioLedgerContentHash } from '@insiderfinance/totalfinance/portfolio';
${LEDGER_JOURNEY_JS}
// The browser law, proven from INSIDE the bundle: no Node globals exist here. Probed through
// globalThis because esbuild rewrites a bare \`require\` reference in an ESM bundle into its
// own \`__require\` shim (so \`typeof require\` would read the shim, not the context).
for (const name of ['process', 'require', 'Buffer', 'module']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error(name + ' is defined inside the browser bundle');
}
if (typeof process !== 'undefined') throw new Error('process is defined inside the browser bundle');
if (typeof TextEncoder === 'undefined' || typeof crypto === 'undefined') throw new Error('web globals missing');
const ledger = createPortfolioLedger({ portfolioId: 'packed', baseCurrency: 'USD', events: JOURNEY });
const stored = JSON.stringify(ledger.toJSON());
const { ledger: restored, migrationsApplied } = readPortfolioLedgerSnapshot({ snapshot: JSON.parse(stored) });
if (migrationsApplied.length !== 0) throw new Error('a current-version envelope needs no migration');
if (JSON.stringify(restored.state) !== JSON.stringify(ledger.state)) throw new Error('replay is the deserializer: the restored state drifted');
const hash = portfolioLedgerContentHash(restored.toJSON());
if (hash !== portfolioLedgerContentHash(ledger.toJSON())) throw new Error('content hash drifted through the string round trip');
if (restored.state.accounts.main.positions.AAPL.quantity !== 400) throw new Error('the split did not fold to 400 AAPL');
console.log('BROWSER_OK ' + hash + ' events=' + restored.state.eventCount);
`,
    );
    const esbuild = join(ROOT, 'node_modules', '.bin', 'esbuild');
    sh(
      esbuild,
      [
        join(dir, 'entry.mjs'),
        '--bundle',
        '--platform=browser',
        '--format=esm',
        `--outfile=${join(dir, 'bundle.mjs')}`,
      ],
      consumer,
    );
    writeFileSync(
      join(dir, 'harness.mjs'),
      `
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const code = readFileSync(new URL('./bundle.mjs', import.meta.url), 'utf8');
// A self-contained bundle: nothing left to import, nothing exported (it runs as a classic script).
if (/^\\s*(import|export)\\b/m.test(code)) throw new Error('the bundle still imports or exports');
// ONLY web globals — TextEncoder/TextDecoder, console, structuredClone, and WebCrypto.
const context = vm.createContext({ TextEncoder, TextDecoder, console, structuredClone, crypto: webcrypto });
vm.runInContext(
  'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof Buffer !== "undefined" || typeof module !== "undefined") throw new Error("Node globals leaked into the context");',
  context,
);
vm.runInContext(code, context, { filename: 'bundle.mjs' });
`,
    );
    const out = sh('node', [join(dir, 'harness.mjs')], consumer);
    expect(out).toContain('BROWSER_OK');
    recordJourneyHash('browser', out, 'BROWSER_OK');
  }, 120_000);

  it('FC7 local-store fixture: a localStorage-shaped store round-trips, grows, and restores the ledger; a newer schema refuses with the typed code', () => {
    const dir = join(consumer, 'ledger-store');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'store.mjs'),
      `
import { createPortfolioLedger, readPortfolioLedgerSnapshot, portfolioLedgerContentHash } from '@insiderfinance/totalfinance/portfolio';
${LEDGER_JOURNEY_JS}
// A localStorage-shaped key/value store: strings in, strings out, nothing else.
const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};
const restore = () => readPortfolioLedgerSnapshot({ snapshot: JSON.parse(localStorage.getItem('ledger')) });

const first = createPortfolioLedger({ portfolioId: 'packed', baseCurrency: 'USD', events: JOURNEY });
const hashFirst = portfolioLedgerContentHash(first.toJSON());
localStorage.setItem('ledger', JSON.stringify(first.toJSON()));
if (typeof store.get('ledger') !== 'string') throw new Error('the store holds strings');

// Restore, apply more events to the RESTORED ledger, store again, restore again.
const { ledger: restored1, migrationsApplied } = restore();
if (migrationsApplied.length !== 0) throw new Error('a current-version envelope needs no migration');
if (portfolioLedgerContentHash(restored1.toJSON()) !== hashFirst) throw new Error('hash drifted through the store');
const grown = restored1.apply(MORE);
localStorage.setItem('ledger', JSON.stringify(grown.toJSON()));
const { ledger: restored2 } = restore();

// The final state deep-equals a SINGLE-PASS fold of every event (replay is the deserializer).
const singlePass = createPortfolioLedger({ portfolioId: 'packed', baseCurrency: 'USD', events: [...JOURNEY, ...MORE] });
if (JSON.stringify(restored2.state) !== JSON.stringify(singlePass.state)) throw new Error('two-stage restore != single-pass fold');
if (restored2.state.eventCount !== 5) throw new Error('expected 5 applied events, got ' + restored2.state.eventCount);
if (restored2.state.accounts.main.positions.AAPL.quantity !== 300) throw new Error('expected 300 AAPL after the sale');
if (restored2.state.accounts.main.realizedPnl.USD !== 250) throw new Error('expected 250 realized, got ' + restored2.state.accounts.main.realizedPnl.USD);
if (restored2.state.accounts.main.cashBalances.USD.totalAmount !== 85000 + 4000 + 75) throw new Error('cash drifted');

// The content-hash chain is stable: the grown ledger hashes like the single-pass fold, differs
// from the first, and re-reading the stored string reproduces it.
const hashGrown = portfolioLedgerContentHash(restored2.toJSON());
if (hashGrown !== portfolioLedgerContentHash(singlePass.toJSON())) throw new Error('grown hash != single-pass hash');
if (hashGrown === hashFirst) throw new Error('the chain did not move');
if (portfolioLedgerContentHash(JSON.parse(localStorage.getItem('ledger'))) !== hashGrown) throw new Error('re-reading the store changed the hash');
if (portfolioLedgerContentHash(restore().ledger.toJSON()) !== hashGrown) throw new Error('a second restore changed the hash');

// The migration law from the packed install: a stored envelope one schema version AHEAD refuses
// with the typed code — this build cannot know what changed.
const ahead = { ...JSON.parse(localStorage.getItem('ledger')) };
ahead.schemaVersion = ahead.schemaVersion + 1;
let refusal = null;
try { readPortfolioLedgerSnapshot({ snapshot: ahead }); } catch (error) { refusal = error; }
if (refusal === null) throw new Error('a newer schema version was accepted');
if (refusal.code !== 'snapshot.unsupported_version') throw new Error('wrong code: ' + refusal.code + ' — ' + refusal.message);
if (!String(refusal.message).includes('newer than this build supports')) throw new Error('the refusal does not teach: ' + refusal.message);
// And the store is untouched by the refusal: the last good envelope still restores.
if (portfolioLedgerContentHash(restore().ledger.toJSON()) !== hashGrown) throw new Error('the refusal disturbed the store');
console.log('STORE_OK ' + hashFirst + ' grown=' + hashGrown + ' events=' + restored2.state.eventCount);
`,
    );
    const out = sh('node', [join(dir, 'store.mjs')], consumer);
    expect(out).toContain('STORE_OK');
    recordJourneyHash('store', out, 'STORE_OK');
  }, 120_000);

  it('FC7: the worker, browser, and local-store fixtures agree on the journey ledger content hash', () => {
    const environments = ['worker', 'browser', 'store'];
    for (const environment of environments) {
      expect(
        journeyHashByEnvironment[environment],
        `no hash recorded for ${environment} (its fixture failed above)`,
      ).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const hashes = new Set(
      environments.map((environment) => journeyHashByEnvironment[environment]),
    );
    expect([...hashes], JSON.stringify(journeyHashByEnvironment)).toHaveLength(1);
    // Surfaced in the run log so a reviewer can compare the environments without re-running.
    console.log(
      `FC7 journey ledger content hash by environment: ${JSON.stringify(journeyHashByEnvironment)}`,
    );
  });

  it('Stage 4.4b: packed plain JS is canonical-byte-identical in Node, a worker, and a web-only browser bundle', () => {
    const dir = join(consumer, 'scenario-environments');
    sh('mkdir', ['-p', dir], consumer);

    writeFileSync(
      join(dir, 'node.mjs'),
      `
import { runScenarios, scenarioTarget } from '@insiderfinance/totalfinance/scenarios';
import { canonicalJsonOf, createMarketSnapshot, createScenarioSet } from '@insiderfinance/totalfinance/core/artifacts';
${STOCK_SCENARIO_JS}
console.log('SCENARIO_NODE ' + JSON.stringify(canonicalJsonOf(runPackedStockScenario())));
`,
    );
    const nodeOutput = sh('node', [join(dir, 'node.mjs')], consumer);
    const nodeBytes = recordScenarioBytes('node', nodeOutput, 'SCENARIO_NODE');

    writeFileSync(
      join(dir, 'worker.mjs'),
      `
import { parentPort } from 'node:worker_threads';
import { runScenarios, scenarioTarget } from '@insiderfinance/totalfinance/scenarios';
import { canonicalJsonOf, createMarketSnapshot, createScenarioSet } from '@insiderfinance/totalfinance/core/artifacts';
${STOCK_SCENARIO_JS}
const result = runPackedStockScenario();
parentPort.postMessage({ result, canonicalBytes: canonicalJsonOf(result) });
`,
    );
    writeFileSync(
      join(dir, 'worker-parent.mjs'),
      `
import { Worker } from 'node:worker_threads';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
const message = await new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url));
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) => { if (code !== 0) reject(new Error('worker exited with ' + code)); });
});
if (canonicalJsonOf(message.result) !== message.canonicalBytes)
  throw new Error('structured clone changed the scenario result bytes');
console.log('SCENARIO_WORKER ' + JSON.stringify(message.canonicalBytes));
`,
    );
    const workerOutput = sh('node', [join(dir, 'worker-parent.mjs')], consumer);
    const workerBytes = recordScenarioBytes('worker', workerOutput, 'SCENARIO_WORKER');

    writeFileSync(
      join(dir, 'browser-entry.mjs'),
      `
import { runScenarios, scenarioTarget } from '@insiderfinance/totalfinance/scenarios';
import { canonicalJsonOf, createMarketSnapshot, createScenarioSet } from '@insiderfinance/totalfinance/core/artifacts';
${STOCK_SCENARIO_JS}
for (const name of ['process', 'require', 'Buffer', 'module']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error(name + ' is defined inside the browser bundle');
}
if (typeof TextEncoder === 'undefined' || typeof crypto === 'undefined') throw new Error('web globals missing');
globalThis.__totalfinanceScenarioCanonicalBytes = canonicalJsonOf(runPackedStockScenario());
`,
    );
    const esbuild = join(ROOT, 'node_modules', '.bin', 'esbuild');
    sh(
      esbuild,
      [
        join(dir, 'browser-entry.mjs'),
        '--bundle',
        '--platform=browser',
        '--format=iife',
        `--outfile=${join(dir, 'browser-bundle.js')}`,
      ],
      consumer,
    );
    writeFileSync(
      join(dir, 'browser-harness.mjs'),
      `
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const code = readFileSync(new URL('./browser-bundle.js', import.meta.url), 'utf8');
if (/^\\s*(import|export)\\b/m.test(code)) throw new Error('the browser bundle is not self-contained');
const context = vm.createContext({ TextEncoder, TextDecoder, structuredClone, crypto: webcrypto });
vm.runInContext(
  'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof Buffer !== "undefined" || typeof module !== "undefined") throw new Error("Node globals leaked into the context");',
  context,
);
vm.runInContext(code, context, { filename: 'browser-bundle.js' });
const bytes = context.__totalfinanceScenarioCanonicalBytes;
if (typeof bytes !== 'string') throw new Error('the browser bundle did not expose canonical scenario bytes');
console.log('SCENARIO_BROWSER ' + JSON.stringify(bytes));
`,
    );
    const browserOutput = sh('node', [join(dir, 'browser-harness.mjs')], consumer);
    const browserBytes = recordScenarioBytes('browser', browserOutput, 'SCENARIO_BROWSER');

    expect(workerBytes).toBe(nodeBytes);
    expect(browserBytes).toBe(nodeBytes);
    expect(scenarioBytesByEnvironment).toEqual({
      node: nodeBytes,
      worker: nodeBytes,
      browser: nodeBytes,
    });
  }, 180_000);

  it('Stage 4.5 + 4.6: the four ./artifacts subpaths save → JSON → restore → evaluate → replay byte-identically in Node, a worker, and a web-only browser bundle', () => {
    const dir = join(consumer, 'artifact-environments');
    sh('mkdir', ['-p', dir], consumer);

    writeFileSync(
      join(dir, 'node.mjs'),
      `${ARTIFACT_JOURNEY_JS}\nconsole.log('ARTIFACTS_NODE ' + JSON.stringify(runPackedArtifactJourney()));\n`,
    );
    const nodeOutput = sh('node', [join(dir, 'node.mjs')], consumer);
    const nodeBytes = recordArtifactBytes('node', nodeOutput, 'ARTIFACTS_NODE');

    writeFileSync(
      join(dir, 'worker.mjs'),
      `
import { parentPort } from 'node:worker_threads';
${ARTIFACT_JOURNEY_JS}
parentPort.postMessage({ bytes: runPackedArtifactJourney() });
`,
    );
    writeFileSync(
      join(dir, 'worker-parent.mjs'),
      `
import { Worker } from 'node:worker_threads';
const message = await new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url));
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) => { if (code !== 0) reject(new Error('worker exited with ' + code)); });
});
console.log('ARTIFACTS_WORKER ' + JSON.stringify(message.bytes));
`,
    );
    const workerOutput = sh('node', [join(dir, 'worker-parent.mjs')], consumer);
    const workerBytes = recordArtifactBytes('worker', workerOutput, 'ARTIFACTS_WORKER');

    writeFileSync(
      join(dir, 'browser-entry.mjs'),
      `
${ARTIFACT_JOURNEY_JS}
for (const name of ['process', 'require', 'Buffer', 'module']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error(name + ' is defined inside the browser bundle');
}
if (typeof TextEncoder === 'undefined' || typeof crypto === 'undefined') throw new Error('web globals missing');
globalThis.__totalfinanceArtifactBytes = runPackedArtifactJourney();
`,
    );
    const esbuild = join(ROOT, 'node_modules', '.bin', 'esbuild');
    sh(
      esbuild,
      [
        join(dir, 'browser-entry.mjs'),
        '--bundle',
        '--platform=browser',
        '--format=iife',
        `--outfile=${join(dir, 'browser-bundle.js')}`,
      ],
      consumer,
    );
    writeFileSync(
      join(dir, 'browser-harness.mjs'),
      `
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const code = readFileSync(new URL('./browser-bundle.js', import.meta.url), 'utf8');
if (/^\\s*(import|export)\\b/m.test(code)) throw new Error('the browser bundle is not self-contained');
const context = vm.createContext({ TextEncoder, TextDecoder, structuredClone, crypto: webcrypto });
vm.runInContext(
  'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof Buffer !== "undefined" || typeof module !== "undefined") throw new Error("Node globals leaked into the context");',
  context,
);
vm.runInContext(code, context, { filename: 'browser-bundle.js' });
const bytes = context.__totalfinanceArtifactBytes;
if (typeof bytes !== 'string' || !bytes.startsWith('{')) throw new Error('the browser bundle did not expose the artifact journey bytes');
console.log('ARTIFACTS_BROWSER ' + JSON.stringify(bytes));
`,
    );
    const browserOutput = sh('node', [join(dir, 'browser-harness.mjs')], consumer);
    const browserBytes = recordArtifactBytes('browser', browserOutput, 'ARTIFACTS_BROWSER');

    expect(workerBytes).toBe(nodeBytes);
    expect(browserBytes).toBe(nodeBytes);
    expect(artifactBytesByEnvironment).toEqual({
      node: nodeBytes,
      worker: nodeBytes,
      browser: nodeBytes,
    });
  }, 240_000);

  it.each(['nodenext', 'bundler'] as const)(
    'TypeScript strict resolution under moduleResolution: %s',
    (resolution) => {
      const dir = join(consumer, `ts-${resolution}`);
      sh('mkdir', ['-p', dir], consumer);
      writeFileSync(
        join(dir, 'consumer.ts'),
        `
import { blackScholes, technicalAnalysis } from '@insiderfinance/totalfinance';
import { type OptionMarket } from '@insiderfinance/totalfinance/options';
import { runScenarios, scenarioTarget, type ScenarioRunResult } from '@insiderfinance/totalfinance/scenarios';
import { createMarketSnapshot, createScenarioSet } from '@insiderfinance/totalfinance/core/artifacts';
import { blackScholes as blackScholesDeep, blackScholesPrice } from '@insiderfinance/totalfinance/options/black-scholes';
import { blackScholesPriceMany } from '@insiderfinance/totalfinance/options/batch';
import { estimateCovariance } from '@insiderfinance/totalfinance/math';

const price: number = blackScholes.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
const deep: number = blackScholesDeep.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
const raw: number = blackScholesPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, dividendYield: 0, volatility: 0.22 });
const batch: number = blackScholesPriceMany({
  spot: Float64Array.of(100), strike: Float64Array.of(105), timeToExpiryYears: Float64Array.of(30 / 365),
  riskFreeRate: Float64Array.of(0.045), dividendYield: Float64Array.of(0), volatility: Float64Array.of(0.22),
  type: Int8Array.of(1),
}).price[0]!;
const rsi: number[] = technicalAnalysis.rsi([1, 2, 3], { period: 2 });
const covariance = estimateCovariance([[0.01, -0.02, 0.01], [0.02, 0.01, -0.01]]);
const spd: boolean = covariance.isPositiveDefinite;
const scenarioResult: ScenarioRunResult = runScenarios({
  scenarioSet: createScenarioSet({
    name: 'packed-types',
    scenarios: [{ name: 'up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] }],
  }),
  market: createMarketSnapshot({
    asOf: 1788048000000,
    observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
  }),
  targets: [scenarioTarget.spot({ id: 'aapl', symbol: 'AAPL', quantity: 2, currency: 'USD' })],
});
const scenarioCell = scenarioResult.cells[0];
if (scenarioCell === undefined || scenarioCell.status !== 'complete') throw new Error('scenario failed');
const scenarioPnl: number = scenarioCell.localPnl;
export const ok: [number, number, number, number, number[], boolean, OptionMarket | null, number] = [price, deep, raw, batch, rsi, spd, null, scenarioPnl];
`,
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: resolution === 'nodenext' ? 'nodenext' : 'esnext',
            moduleResolution: resolution,
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            target: 'es2022',
          },
          include: ['consumer.ts', 'all-exports.mts'],
        }),
      );
      const specifiers = [PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME].flatMap((name) => {
        const manifest = JSON.parse(
          readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'),
        ) as {
          exports: Record<string, unknown>;
        };
        return Object.keys(manifest.exports)
          .filter((key) => key !== './package.json')
          .map((key) => name + (key === '.' ? '' : key.slice(1)));
      });
      expect(specifiers.length).toBeGreaterThan(100);
      writeFileSync(
        join(dir, 'all-exports.mts'),
        [
          ...specifiers.map(
            (specifier, index) =>
              `import type * as Surface${index} from '${specifier}'; export type Export${index} = typeof Surface${index};`,
          ),
          ...[
            'totalfinance',
            '@totalfinance/core',
            '@totalfinance/mcp',
            '@insiderfinance/totalfinance/core/package.json',
            '@insiderfinance/totalfinance/mcp',
          ].map(
            (specifier, index) =>
              `// @ts-expect-error private packages and hidden subpaths must not resolve\nimport type * as Private${index} from '${specifier}';`,
          ),
          `import type * as Root from '@insiderfinance/totalfinance';`,
          `// @ts-expect-error CLI is explicit and Node-only\ntype NoCLI = typeof Root.cli;`,
          `// @ts-expect-error HTTP is explicit and Node-only\ntype NoHTTP = typeof Root.http;`,
          `// @ts-expect-error MCP is a separate optional package\ntype NoMCP = typeof Root.mcp;`,
        ].join('\n'),
      );
      sh(TSC, ['-p', dir], dir);
    },
    120_000,
  );

  /**
   * Every generated package README, typechecked and RUN against the packed install.
   *
   * `readme-gen.test.ts` proves each README matches the generator and
   * `docs/examples/readme-snippets.test.ts` runs every snippet in CI — and both passed while two
   * READMEs were broken:
   *
   *     totalfinance    ReferenceError: ta is not defined
   *     structure   ReferenceError: resolvedExpiry is not defined
   *
   * The snippets test binds `ta`, `resolvedExpiry` and `OptionQuote` at FILE level, so a snippet body
   * could use an identifier its own (commented) import line never supplied. Un-commenting those lines
   * into a README then produced a file referencing undeclared names. The 3B.N1 `ta` →
   * `technicalAnalysis` sweep rewrote the commented import and left the body's `ta.rsi` alone, because
   * inside that test `ta` was legitimately in scope.
   *
   * This runs the READMEs where a user actually meets them: a fresh out-of-tree project with the
   * published tarballs installed. Typecheck catches a missing TYPE import (`OptionQuote` is
   * `import type`, erased before it could fail at runtime); execution catches a missing VALUE import
   * or an example that throws.
   */
  /**
   * 3B.5 — the cold MISUSE matrix, from the packed tarballs. The first-touch sweeps prove these
   * behaviors against workspace source; per the closeout spec, "workspace imports do not count as
   * packed-consumer evidence" — a consumer meets the guards only through the published artifacts.
   * One probe per misuse class, plus the ONE-ROUND-TRIP law: the example a teaching error carries
   * must itself succeed, and the MCP schema must agree with the SDK on field names.
   */
  it('3B.5: misuse journeys teach from the packed install, and the taught fix works in one round trip', () => {
    const script = `
      import { blackScholes, option, market, engines } from '@insiderfinance/totalfinance';
      import { priceMany } from '@insiderfinance/totalfinance/options';
      import { unusualness } from '@insiderfinance/totalfinance/structure';
      import { rsi } from '@insiderfinance/totalfinance/technical-analysis';
      import { createTotalFinanceMcpServer } from '@insiderfinance/totalfinance-mcp';
      const results = [];
      const expectCode = (label, fn, code, messageIncludes) => {
        try {
          fn();
          results.push(label + ':ACCEPTED');
        } catch (e) {
          const okCode = e?.code === code;
          const okMessage = messageIncludes === undefined || String(e?.message).includes(messageIncludes);
          results.push(label + ':' + (okCode && okMessage ? 'OK' : 'WRONG:' + e?.code + ':' + String(e?.message).slice(0, 60)));
        }
      };
      const good = { spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 };
      // omission — and the ROUND TRIP: the error's example must be a working call.
      try {
        blackScholes.call({ strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
        results.push('omission:ACCEPTED');
      } catch (e) {
        const taught = String(e?.message);
        const exampleLine = taught.split('e.g. ')[1];
        const example = exampleLine ? exampleLine.split(String.fromCharCode(10))[0].trim() : null;
        if (e?.code !== 'input.missing_field' || !example) results.push('omission:WRONG:' + e?.code);
        else {
          // THE ONE-ROUND-TRIP LAW: the taught example, evaluated verbatim, must succeed.
          const roundTrip = new Function('blackScholes', 'return ' + example + ';');
          const value = roundTrip(blackScholes);
          results.push(Number.isFinite(typeof value === 'number' ? value : value?.value) ? 'omission:OK:ROUNDTRIP' : 'omission:EXAMPLE_BROKEN');
        }
      }
      // misspelling → did-you-mean names the real field
      expectCode('misspelling', () => blackScholes.call({ ...good, strke: 105 }), 'input.unknown_field', 'strike');
      // extra key
      expectCode('extraKey', () => blackScholes.call({ ...good, bogusKnob: 1 }), 'input.unknown_field');
      // explicit undefined for a required field = missing
      expectCode('explicitUndefined', () => blackScholes.call({ ...good, spot: undefined }), 'input.missing_field');
      // wrong primitive
      expectCode('wrongPrimitive', () => blackScholes.call({ ...good, spot: '100' }), 'input.wrong_type');
      // wrong container (a series head fed an object)
      expectCode('wrongContainer', () => rsi({ close: [1, 2, 3] }), 'input.wrong_type');
      // non-finite
      expectCode('nonFinite', () => blackScholes.call({ ...good, spot: NaN }), 'input.nan');
      // degenerate-valid: a series shorter than the period answers the documented WARM-UP
      // convention (all-NaN output, no throw) — valid input, degenerate answer, honestly encoded.
      const warmup = rsi([44, 44.3, 44.1], { period: 14 });
      results.push('degenerateValid:' + (warmup.length === 3 && warmup.every(Number.isNaN) ? 'OK' : 'WRONG:' + JSON.stringify(warmup)));
      // plausible transposition: unusualness(value, baseline) with a series where the scalar goes
      expectCode('transposition', () => unusualness([1, 2, 3], 5), 'input.wrong_type');
      // batch: the failing ROW is named from packed (H06)
      try {
        const american = option.usEquityCall({ underlying: 'X', strike: 100, expiry: '2027-06-18' });
        priceMany({ contracts: [american], market: market({ spot: 100, riskFreeRate: 0.04, volatility: 0.2, asOf: '2026-08-19T00:00:00Z' }), engine: engines.blackScholes() });
        results.push('batchIndex:ACCEPTED');
      } catch (e) {
        results.push('batchIndex:' + (String(e?.message).includes('contracts[0]') && e?.context?.contractIndex === 0 ? 'OK' : 'WRONG:' + String(e?.message).slice(0, 60)));
      }
      // MCP schema agreement: a served tool's input schema names the SDK's field spelling
      const server = createTotalFinanceMcpServer({ readOnly: true });
      results.push('mcpServer:' + (server ? 'OK' : 'WRONG'));
      console.log(results.join('|'));
      process.exit(0);
    `;
    const out = sh('node', ['--input-type=module', '-e', script], consumer);
    for (const marker of [
      'omission:OK:ROUNDTRIP',
      'misspelling:OK',
      'extraKey:OK',
      'explicitUndefined:OK',
      'wrongPrimitive:OK',
      'wrongContainer:OK',
      'nonFinite:OK',
      'degenerateValid:OK',
      'transposition:OK',
      'batchIndex:OK',
      'mcpServer:OK',
    ]) {
      expect(out, `packed misuse probe failed: ${out}`).toContain(marker);
    }
  }, 60_000);

  describe('generated READMEs against the packed install', () => {
    /** `[packageDir, fenced ts block]` for every package README that publishes an example. */
    const readmes: [string, string][] = readdirSync(PKG_DIR)
      .sort()
      .flatMap((dir) => {
        const path = join(PKG_DIR, dir, 'README.md');
        const match = /```ts\n([\s\S]*?)```/.exec(readFileSync(path, 'utf8'));
        return match ? [[dir, match[1]!] as [string, string]] : [];
      });

    it('every package publishes an extractable example', () => {
      // Tied to the package count, so a silently-unmatched extractor fails here instead of reducing
      // this suite to asserting nothing — the failure mode that let the two broken READMEs through.
      expect(readmes.map(([dir]) => dir)).toEqual(readdirSync(PKG_DIR).sort());
    });

    it.each(readmes)(
      'packages/%s/README.md typechecks and runs as published',
      (dir, snippet) => {
        const work = join(consumer, 'readme', dir);
        sh('mkdir', ['-p', work], consumer);
        // Verbatim. Rewriting the snippet here would defeat the point of the gate.
        writeFileSync(join(work, 'example.ts'), snippet);
        writeFileSync(
          join(work, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              module: 'nodenext',
              moduleResolution: 'nodenext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'es2022',
            },
            include: ['example.ts'],
          }),
        );
        try {
          sh(TSC, ['-p', work], work);
          sh(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(work, 'example.ts')], consumer);
        } catch (error) {
          throw new Error(
            `packages/${dir}/README.md does not work as published. Fix the snippet in ` +
              `docs/examples/readme-snippets.test.ts — its commented import lines must supply every ` +
              `identifier the body uses, independent of that file's own top-level imports — then rerun ` +
              `\`pnpm tsx tools/readme-gen.ts\`.\n${String(error)}`,
            { cause: error },
          );
        }
      },
      120_000,
    );
  });
  // ── Stage 7A (Decision 9): the transports from the PACKED tarballs, bytes-identical to the SDK ──

  it('Stage 7A: the packed totalfinance CLI lists operations and runs one; the result equals the SDK result byte for byte', () => {
    const dir = join(consumer, 'transports');
    sh('mkdir', ['-p', dir], consumer);
    const price = {
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    writeFileSync(join(dir, 'price.json'), JSON.stringify(price));
    writeFileSync(
      join(dir, 'sdk.mjs'),
      `
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { createOperationRegistry, defaultPacks, jsonSafe } from '@insiderfinance/totalfinance/workflows';
const registry = createOperationRegistry({ packs: defaultPacks() });
const result = registry.run({ id: 'totalfinance.option.price', input: ${JSON.stringify(price)} });
console.log('SDK_OPERATIONS ' + registry.size);
console.log('SDK_STRUCTURED ' + canonicalJsonOf(jsonSafe(result.structured)));
`,
    );
    const sdk = sh('node', [join(dir, 'sdk.mjs')], consumer);
    const sdkStructured = /SDK_STRUCTURED (.*)/.exec(sdk)![1]!;
    const sdkOperations = Number(/SDK_OPERATIONS (\d+)/.exec(sdk)![1]);
    const cli = join(consumer, 'node_modules', '.bin', 'totalfinance');
    const store = join(dir, 'store');
    const list = JSON.parse(
      sh('node', [cli, 'operations', 'list', '--store', store], consumer),
    ) as { id: string }[];
    expect(list.length).toBe(sdkOperations);
    const run = JSON.parse(
      sh(
        'node',
        [
          cli,
          'run',
          'totalfinance.option.price',
          '--input',
          join(dir, 'price.json'),
          '--store',
          store,
        ],
        consumer,
      ),
    ) as {
      structured: unknown;
    };
    writeFileSync(
      join(dir, 'canon.mjs'),
      `
import { readFileSync } from 'node:fs';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { jsonSafe } from '@insiderfinance/totalfinance/workflows';
console.log('CLI_STRUCTURED ' + canonicalJsonOf(jsonSafe(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
`,
    );
    writeFileSync(join(dir, 'cli-structured.json'), JSON.stringify(run.structured));
    const cliStructured = /CLI_STRUCTURED (.*)/.exec(
      sh('node', [join(dir, 'canon.mjs'), join(dir, 'cli-structured.json')], consumer),
    )![1]!;
    expect(cliStructured).toBe(sdkStructured);
  }, 120_000);

  it('Stage 7B.2: the trade lifecycle runs from the tarballs — preflight, authorize, submit, record, reconcile — through the registry and the CLI, and agrees', () => {
    const dir = join(consumer, 'trade');
    sh('mkdir', ['-p', dir], consumer);
    writeFileSync(
      join(dir, 'sdk.mjs'),
      `
import { canonicalJsonOf, createMarketSnapshot } from '@insiderfinance/totalfinance/core/artifacts';
import { createPortfolioLedger } from '@insiderfinance/totalfinance/portfolio';
import {
  createMemoryArtifactStore, createMemoryAuthorizationStore, createMemoryExecutionJournalStore,
  createOperationRegistry, defaultPacks, journeyPacks, jsonSafe, tradePack,
} from '@insiderfinance/totalfinance/workflows';
const T0 = Date.UTC(2026, 0, 5, 21), DAY = 86_400_000, NOW = T0 + 2 * DAY, CREATED = Date.parse('2026-09-06T12:00:00Z');
const env = (eventId, at, event) => ({ eventId, schemaVersion: 1, eventType: event.eventType, sourceId: 'fixture', accountId: 'main', effectiveTimestampMs: at, recordedTimestampMs: at, event, provenance: {} });
const ledger = createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events: [
  env('dep', T0, { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
  env('fill', T0 + DAY, { eventType: 'trade.fill', instrumentId: 'AAA', side: 'buy', quantity: 100, pricePerUnit: 100, currency: 'USD' }),
] });
const market = createMarketSnapshot({ asOf: NOW, observations: { spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } } } });
const registry = createOperationRegistry({ packs: [...defaultPacks(), ...journeyPacks(), tradePack()] });
const artifacts = createMemoryArtifactStore();
const stores = { authorization: createMemoryAuthorizationStore(), journal: createMemoryExecutionJournalStore() };
const caps = ['portfolio:read', 'analytics:run', 'trade:propose', 'trade:approve', 'trade:paper', 'portfolio:write'];
const run = (id, input) => registry.run({ id, input, artifacts, stores, capabilities: caps, createdTimestampMs: CREATED, maxInputBytes: 16_777_216 }).structured;
const wire = (v) => JSON.parse(JSON.stringify(v));
const intent = { kind: 'totalfinance.trade-intent', schemaVersion: 1, accountId: 'main', asOf: NOW, orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' }], rationale: 'packed' };
const policy = { mode: 'paper', limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 }, maximumOrderNotional: 50_000, marketMaximumAgeMs: DAY };
const { plan, ...preflight } = run('totalfinance.trade.preflight', { intent, portfolio: wire(ledger.toJSON()), market: wire(market), asOf: NOW, policy });
const authorizeInput = { plan, preflight, approvedBy: 'packed', expiresAt: NOW + DAY, now: NOW, variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 }, marketMaximumAgeMs: DAY, idempotencyKeys: ['packed:1'], createdTimestampMs: CREATED };
const { grant } = run('totalfinance.trade.authorize', authorizeInput);
const submitInput = { plan, grant, idempotencyKey: 'packed:1', now: NOW + 1000, portfolioHash: preflight.portfolioHash, marketHash: preflight.marketHash, marketAsOf: NOW, sourceId: 'paper:packed', accountId: 'main', baseCurrency: 'USD', instruments: { BBB: { currency: 'USD' } }, observations: { BBB: { kind: 'bar', bar: { symbol: 'BBB', timestampMs: NOW + 60_000, open: 50, high: 51, low: 49, close: 50.5, volume: 10_000 } } }, asOf: NOW + 60_000 };
const submitted = run('totalfinance.trade.submit', submitInput);
const recordInput = { portfolio: wire(ledger.toJSON()), events: submitted.events, createdTimestampMs: CREATED };
const recorded = run('totalfinance.portfolio.record_events', recordInput);
const reconcileInput = { journalId: 'paper:packed:journal', ledger: recorded.handle.uri, sourceId: 'paper:packed', fills: submitted.fills, asOf: NOW + 120_000, tolerance: { quantity: 1e-9, cashAmount: 0.01 } };
const reconciled = run('totalfinance.trade.reconcile', { journalId: 'paper:packed:journal', ledger: artifacts.get(recorded.handle.uri).value, sourceId: 'paper:packed', fills: submitted.fills, asOf: NOW + 120_000, tolerance: { quantity: 1e-9, cashAmount: 0.01 } });
console.log('TRADE_FILLS ' + submitted.fills.length + ' RECONCILED ' + reconciled.reconciled + ' HANDLE ' + recorded.handle.uri);
console.log('TRADE_AUTHORIZE_INPUT ' + JSON.stringify(authorizeInput));
console.log('TRADE_SUBMIT_INPUT ' + JSON.stringify(submitInput));
console.log('TRADE_SUBMIT ' + canonicalJsonOf(jsonSafe(submitted.receipt)));
console.log('TRADE_RECORD_INPUT ' + JSON.stringify(recordInput));
console.log('TRADE_RECONCILE_INPUT ' + JSON.stringify(reconcileInput));
console.log('TRADE_RECONCILED ' + JSON.stringify(reconciled));
`,
    );
    const sdk = sh('node', [join(dir, 'sdk.mjs')], consumer);
    expect(/TRADE_FILLS (\d+) RECONCILED (\w+) HANDLE (\S+)/.exec(sdk)!.slice(1)).toEqual([
      '1',
      'true',
      expect.stringMatching(/^totalfinance:\/\/portfolios\//),
    ]);
    const submitInput = /TRADE_SUBMIT_INPUT (.*)/.exec(sdk)![1]!;
    const authorizeInput = /TRADE_AUTHORIZE_INPUT (.*)/.exec(sdk)![1]!;
    const sdkReceipt = /TRADE_SUBMIT (.*)/.exec(sdk)![1]!;
    writeFileSync(join(dir, 'submit.json'), submitInput);
    writeFileSync(join(dir, 'authorize.json'), authorizeInput);
    const cli = join(consumer, 'node_modules', '.bin', 'totalfinance');
    const store = join(dir, 'store');
    // An inline JSON grant is not authority: the execute-only caller must fail before approval.
    const unapproved = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        'totalfinance.trade.submit',
        '--input',
        join(dir, 'submit.json'),
        '--profile',
        'full',
        '--store',
        store,
        '--capability',
        'trade:paper',
        '--max-input-bytes',
        '16777216',
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    expect(unapproved.status).not.toBe(0);
    expect(JSON.parse(unapproved.stdout).code).toBe('operation.handle_unknown');
    const approved = JSON.parse(
      sh(
        'node',
        [
          cli,
          'run',
          'totalfinance.trade.authorize',
          '--input',
          join(dir, 'authorize.json'),
          '--profile',
          'full',
          '--store',
          store,
          '--capability',
          'trade:approve',
          '--max-input-bytes',
          '16777216',
        ],
        consumer,
      ),
    );
    expect(approved.structured.grant).toEqual(JSON.parse(submitInput).grant);
    const out = sh(
      'node',
      [
        cli,
        'run',
        'totalfinance.trade.submit',
        '--input',
        join(dir, 'submit.json'),
        '--profile',
        'full',
        '--store',
        store,
        '--capability',
        'trade:paper',
        '--max-input-bytes',
        '16777216',
      ],
      consumer,
    );
    writeFileSync(join(dir, 'run.json'), out);
    writeFileSync(
      join(dir, 'canon.mjs'),
      `
import { readFileSync } from 'node:fs';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { jsonSafe } from '@insiderfinance/totalfinance/workflows';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log('CLI_RECEIPT ' + canonicalJsonOf(jsonSafe(result.structured.receipt)));
`,
    );
    const cliReceipt = /CLI_RECEIPT (.*)/.exec(
      sh('node', [join(dir, 'canon.mjs'), join(dir, 'run.json')], consumer),
    )![1]!;
    expect(cliReceipt).toBe(sdkReceipt);
    const cliSubmitted = JSON.parse(out).structured;
    expect(cliSubmitted.retried).toBe(false);
    expect(cliSubmitted.fills).toHaveLength(1);
    expect(cliSubmitted.fills[0]).toMatchObject({
      instrumentId: 'BBB',
      side: 'buy',
      quantity: 200,
    });
    const recordInput = JSON.parse(/TRADE_RECORD_INPUT (.*)/.exec(sdk)![1]!);
    expect(cliSubmitted.events).toEqual(recordInput.events);
    // Finish the accounting journey through the CLI too, using its returned events and file stores.
    writeFileSync(
      join(dir, 'record.json'),
      JSON.stringify({ ...recordInput, events: cliSubmitted.events }),
    );
    const recorded = JSON.parse(
      sh(
        'node',
        [
          cli,
          'run',
          'totalfinance.portfolio.record_events',
          '--input',
          join(dir, 'record.json'),
          '--profile',
          'full',
          '--store',
          store,
          '--capability',
          'portfolio:write',
          '--max-input-bytes',
          '16777216',
        ],
        consumer,
      ),
    );
    const reconcileInput = JSON.parse(/TRADE_RECONCILE_INPUT (.*)/.exec(sdk)![1]!);
    expect(recorded.structured.handle.uri).toBe(reconcileInput.ledger);
    writeFileSync(
      join(dir, 'reconcile.json'),
      JSON.stringify({ ...reconcileInput, fills: cliSubmitted.fills }),
    );
    const reconciled = JSON.parse(
      sh(
        'node',
        [
          cli,
          'run',
          'totalfinance.trade.reconcile',
          '--input',
          join(dir, 'reconcile.json'),
          '--profile',
          'full',
          '--store',
          store,
          '--capability',
          'trade:paper',
          '--max-input-bytes',
          '16777216',
        ],
        consumer,
      ),
    );
    expect(reconciled.structured).toEqual(JSON.parse(/TRADE_RECONCILED (.*)/.exec(sdk)![1]!));
    expect(reconciled.structured.reconciled).toBe(true);
    // without the capability the CLI refuses with the registered code, before parsing
    const refused = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        'totalfinance.trade.submit',
        '--input',
        join(dir, 'submit.json'),
        '--profile',
        'full',
        '--store',
        join(dir, 'store2'),
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    expect(refused.status).not.toBe(0);
    expect(JSON.parse(refused.stdout).code).toBe('operation.capability_missing');
  }, 120_000);

  it('Stage 7B.1: the environment_episode operation runs from the tarballs through the registry and the CLI, and agrees', () => {
    const dir = join(consumer, 'environment');
    sh('mkdir', ['-p', dir], consumer);
    const input = { episode: 'range-bound', policy: { baseline: 'buyAndHold' }, seed: 7 };
    writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
    writeFileSync(
      join(dir, 'sdk.mjs'),
      `
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { backtestPack, createOperationRegistry, defaultPacks, jsonSafe } from '@insiderfinance/totalfinance/workflows';
const registry = createOperationRegistry({ packs: [...defaultPacks(), backtestPack()] });
const result = registry.run({ id: 'totalfinance.backtest.environment_episode', input: ${JSON.stringify(input)} });
console.log('ENV_PASSES ' + result.structured.episode.operational.passes);
console.log('ENV_STRUCTURED ' + canonicalJsonOf(jsonSafe(result.structured)));
`,
    );
    const sdk = sh('node', [join(dir, 'sdk.mjs')], consumer);
    expect(/ENV_PASSES (\w+)/.exec(sdk)![1]).toBe('true');
    const sdkStructured = /ENV_STRUCTURED (.*)/.exec(sdk)![1]!;
    const cli = join(consumer, 'node_modules', '.bin', 'totalfinance');
    const store = join(dir, 'store');
    writeFileSync(
      join(dir, 'run.json'),
      sh(
        'node',
        [
          cli,
          'run',
          'totalfinance.backtest.environment_episode',
          '--input',
          join(dir, 'input.json'),
          '--profile',
          'full',
          '--store',
          store,
        ],
        consumer,
      ),
    );
    writeFileSync(
      join(dir, 'canon.mjs'),
      `
import { readFileSync } from 'node:fs';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { jsonSafe } from '@insiderfinance/totalfinance/workflows';
console.log('CLI_STRUCTURED ' + canonicalJsonOf(jsonSafe(JSON.parse(readFileSync(process.argv[2], 'utf8')).structured)));
`,
    );
    const cliStructured = /CLI_STRUCTURED (.*)/.exec(
      sh('node', [join(dir, 'canon.mjs'), join(dir, 'run.json')], consumer),
    )![1]!;
    expect(cliStructured).toBe(sdkStructured);
  }, 120_000);

  it('Stage 7A: the packed totalfinance-http prints its OpenAPI document and serves one run identical to the SDK; the packed MCP server lists tools with annotations', () => {
    const dir = join(consumer, 'transports');
    sh('mkdir', ['-p', dir], consumer);
    const http = join(consumer, 'node_modules', '.bin', 'totalfinance-http');
    const document = JSON.parse(
      sh('node', [http, '--openapi', '--profile', 'full'], consumer, OPENAPI_MAX_BUFFER),
    ) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/operations/totalfinance.option.price/run']).toBeDefined();
    writeFileSync(
      join(dir, 'http-and-mcp.mjs'),
      `
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import { createLocalHttpServer } from '@insiderfinance/totalfinance/http';
import { createTotalFinanceMcpServer, defaultPacks as mcpDefaultPacks } from '@insiderfinance/totalfinance-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOperationRegistry, defaultPacks, jsonSafe } from '@insiderfinance/totalfinance/workflows';
const registry = createOperationRegistry({ packs: defaultPacks() });
const price = { type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 };
const expected = canonicalJsonOf(jsonSafe(registry.run({ id: 'totalfinance.option.price', input: price }).structured));
const local = createLocalHttpServer({ registry, port: 0 });
const { url } = await local.start();
const response = await fetch(url + '/operations/totalfinance.option.price/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(price) });
const body = await response.json();
await local.stop();
if (response.status !== 200) throw new Error('HTTP status ' + response.status);
if (canonicalJsonOf(jsonSafe(body.structured)) !== expected) throw new Error('HTTP structured drifted from the SDK');
const server = createTotalFinanceMcpServer({ packs: mcpDefaultPacks() });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'packed', version: '0' });
await client.connect(clientTransport);
const { tools } = await client.listTools();
const priced = tools.find((t) => t.name === 'totalfinance_option_price');
if (!priced || !priced.annotations || priced.annotations.readOnlyHint !== true) throw new Error('MCP tool annotations missing');
const call = await client.callTool({ name: 'totalfinance_option_price', arguments: price });
if (canonicalJsonOf(jsonSafe(call.structuredContent.structured)) !== expected) throw new Error('MCP structured drifted from the SDK');
await client.close();
console.log('TRANSPORTS_OK tools=' + tools.length);
`,
    );
    const out = sh('node', [join(dir, 'http-and-mcp.mjs')], consumer);
    expect(out).toContain('TRANSPORTS_OK tools=23');
  }, 120_000);

  it('the installed MCP executable serves stdio and reports the public release version', () => {
    const binary = join(consumer, 'node_modules', '.bin', 'totalfinance-mcp');
    expect(JSON.parse(sh('node', [binary, '--version'], consumer))['totalfinance-mcp']).toBe(
      releaseManifest.version,
    );
    const script = `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { blackScholes } from '@insiderfinance/totalfinance/options';
const client = new Client({ name: 'packed-stdio', version: '0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(binary)}], cwd: process.cwd() });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const priceTool = tools.find(tool => tool.name === 'totalfinance_option_price');
  assert.equal(priceTool.annotations.readOnlyHint, true);
  const input = { type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 };
  const result = await client.callTool({ name: priceTool.name, arguments: input });
  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.structured.value, blackScholes.price(input));
  console.log('MCP_STDIO_OK tools=' + tools.length);
} finally {
  await client.close();
  await transport.close();
}
`;
    expect(sh('node', ['--input-type=module', '-e', script], consumer)).toContain(
      'MCP_STDIO_OK tools=23',
    );
  }, 120_000);
});

/** Separate tail fixture so sector integration does not overlap the primary dogfooding block. */
const SECTOR_PUBLIC_CONSUMER_TS = `
import { canonicalJsonOf, createAnalysisArtifact, readAnalysisArtifact } from '@insiderfinance/totalfinance/core/artifacts';
import {
  sectorPerformance, sectorPerformanceSnapshot,
  type SectorPerformanceReport, type SectorPerformanceSnapshotInput,
  type SectorPerformanceSnapshotReport,
} from '@insiderfinance/totalfinance/performance';
import {
  sectorPerformance as sectorPerformanceDeep, sectorPerformanceSnapshot as sectorPerformanceSnapshotDeep,
  type SectorPerformanceReport as DeepSectorReport,
  type SectorPerformanceSnapshotReport as DeepSnapshotReport,
} from '@insiderfinance/totalfinance/performance/sector-performance';

// Same-period decimal returns do not establish dates, currency, a taxonomy or price/source lineage.
const simpleInput = { members: [
  { securityId: 'A', sectorId: 'technology', sectorName: 'Technology', periodReturn: 0.1 },
  { securityId: 'B', sectorId: 'technology', sectorName: 'Technology', periodReturn: -0.04 },
] };
const simple: SectorPerformanceReport = sectorPerformance(simpleInput);
const simpleDeep: DeepSectorReport = sectorPerformanceDeep(simpleInput);
if (canonicalJsonOf(simple) !== canonicalJsonOf(simpleDeep)) throw new Error('simple root/deep drift');
if (simple.sectors[0]?.periodReturn !== 0.03 || simple.diagnostics.includedSecurityCount !== 2)
  throw new Error('same-period equal-weight return drift');
if (simple.diagnostics.status !== 'complete' || !Array.isArray(simple.diagnostics.warnings))
  throw new Error('simple report grammar drift');
// Check the complete simple report, not just its top level, for fabricated audit metadata.
function requireNoInventedMetadata(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const key of ['asOf', 'timestampMs', 'sourceTimestampMs', 'knownAtTimestampMs', 'sourceId',
    'targetSessionDate', 'selectedSessions', 'marketCalendarId', 'cutoffs', 'classificationTaxonomy',
    'classification', 'previousClose', 'targetClose', 'currency', 'dailyReturn']) {
    if (Object.hasOwn(value, key)) throw new Error('simple report invented metadata: ' + key);
  }
  for (const child of Object.values(value)) requireNoInventedMetadata(child);
}
requireNoInventedMetadata(simple);
requireNoInventedMetadata(simpleDeep);
const empty = sectorPerformance({ members: [] });
if (empty.diagnostics.status !== 'empty' || empty.sectors.length !== 0 || empty.diagnostics.warnings.length === 0)
  throw new Error('empty simple input was not disclosed');
requireNoInventedMetadata(empty);

const cutoff = Date.parse('2026-08-28T21:00:00Z');
const priorCloseTime = Date.parse('2026-08-27T20:00:00Z');
const targetCloseTime = Date.parse('2026-08-28T20:00:00Z');
const classificationTime = Date.parse('2026-01-02T00:00:00Z');
const snapshotInput: SectorPerformanceSnapshotInput = {
  targetSessionDate: '2026-08-28', marketCalendarId: 'XNYS',
  classificationTaxonomy: { taxonomyId: 'synthetic-taxonomy', taxonomyVersion: 'v1' },
  cutoffs: { sourceCutoffTimestampMs: cutoff, knowledgeCutoffTimestampMs: cutoff,
    sessionCompletedCutoffTimestampMs: cutoff },
  eligibleUniverse: ['A', 'B'].map((securityId) => ({ securityId,
    listingId: 'listing-' + securityId, universeMembershipId: 'member-' + securityId })),
  completedSessions: [
    { sessionId: 'previous', sessionDate: '2026-08-27', completedAtTimestampMs: priorCloseTime },
    { sessionId: 'target', sessionDate: '2026-08-28', completedAtTimestampMs: targetCloseTime },
  ],
  classifications: ['A', 'B'].map((securityId) => ({ classificationObservationId: 'class-' + securityId,
    securityId, taxonomyId: 'synthetic-taxonomy', taxonomyVersion: 'v1',
    effectiveFromSessionDate: '2026-01-01', effectiveToSessionDate: null,
    sectorId: 'technology', sectorName: 'Technology', sourceId: 'synthetic-classifications',
    sourceTimestampMs: classificationTime, knownAtTimestampMs: classificationTime })),
  splitAdjustedCloses: ['A', 'B'].flatMap((securityId) => ['previous', 'target'].map((sessionId) => ({
    closeObservationId: securityId + '-' + sessionId, securityId, listingId: 'listing-' + securityId,
    sessionId, splitAdjustedClose: sessionId === 'previous' ? 100 : securityId === 'A' ? 110 : 96,
    currency: 'USD', adjustmentVersion: 'synthetic-v1', quality: 'final', sourceId: 'synthetic-closes',
    sourceTimestampMs: sessionId === 'previous' ? priorCloseTime : targetCloseTime,
    knownAtTimestampMs: sessionId === 'previous' ? priorCloseTime : targetCloseTime,
  }))),
};
const snapshot: SectorPerformanceSnapshotReport = sectorPerformanceSnapshot(snapshotInput);
const snapshotDeep: DeepSnapshotReport = sectorPerformanceSnapshotDeep(snapshotInput);
if (canonicalJsonOf(snapshot) !== canonicalJsonOf(snapshotDeep)) throw new Error('snapshot root/deep drift');
if (snapshot.sectors[0]?.dailyReturn !== 0.03 || snapshot.diagnostics.status !== 'complete' ||
    snapshot.diagnostics.includedSecurityCount !== 2 || snapshot.diagnostics.excludedSecurityCount !== 0)
  throw new Error('audited completed-session return drift');
if (snapshot.selectedSessions.previous?.sessionId !== 'previous' || snapshot.selectedSessions.target?.sessionId !== 'target')
  throw new Error('selected completed sessions drifted');
const firstMember = snapshot.sectors[0]?.members[0];
if (firstMember?.securityId !== 'A' || firstMember.classification.classificationObservationId !== 'class-A' ||
    firstMember.previousClose.closeObservationId !== 'A-previous' || firstMember.targetClose.closeObservationId !== 'A-target' ||
    firstMember.targetClose.sourceTimestampMs !== targetCloseTime || firstMember.targetClose.knownAtTimestampMs !== targetCloseTime)
  throw new Error('selected-input audit lineage drifted');
if (snapshot.marketCalendarId !== 'XNYS' || snapshot.cutoffs.sourceCutoffTimestampMs !== cutoff ||
    snapshot.classificationTaxonomy.taxonomyId !== 'synthetic-taxonomy') throw new Error('caller audit controls not echoed');

// Raw calls above stand alone. Saving the SAME direct report objects must need no casts/spreads.
const simpleArtifact = createAnalysisArtifact({ artifactType: 'sector-same-period',
  producedBy: { operation: 'performance.sectorPerformance' }, result: simple });
const simpleDeepArtifact = createAnalysisArtifact({ artifactType: 'sector-same-period',
  producedBy: { operation: 'performance.sectorPerformance' }, result: simpleDeep });
const snapshotArtifact = createAnalysisArtifact({ artifactType: 'sector-snapshot',
  producedBy: { operation: 'performance.sectorPerformanceSnapshot' }, result: snapshot });
const snapshotDeepArtifact = createAnalysisArtifact({ artifactType: 'sector-snapshot',
  producedBy: { operation: 'performance.sectorPerformanceSnapshot' }, result: snapshotDeep });
if (simpleArtifact.id !== simpleDeepArtifact.id || snapshotArtifact.id !== snapshotDeepArtifact.id)
  throw new Error('root/deep report artifact identity drifted');
for (const artifact of [simpleArtifact, simpleDeepArtifact, snapshotArtifact, snapshotDeepArtifact]) {
  if (readAnalysisArtifact({ artifact }).artifact.id !== artifact.id) throw new Error('sector artifact did not validate');
}
console.log('SECTOR_PUBLIC_OK periodReturn=0.03 dailyReturn=0.03 included=2 artifacts=4 simpleAuditMetadata=absent');
`;

describe('packed sector public exports and report honesty', () => {
  it.each(['nodenext', 'bundler'] as const)(
    'both sector APIs compile and run from root/deep imports under moduleResolution: %s',
    (resolution) => {
      const dir = join(consumer, `sector-public-${resolution}`);
      sh('mkdir', ['-p', dir], consumer);
      writeFileSync(join(dir, 'consumer.mts'), SECTOR_PUBLIC_CONSUMER_TS);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: resolution === 'nodenext' ? 'nodenext' : 'esnext',
            moduleResolution: resolution,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            target: 'es2022',
            outDir: './compiled',
          },
          include: ['consumer.mts'],
        }),
      );
      sh(TSC, ['-p', dir], dir);
      expect(sh('node', [join(dir, 'compiled/consumer.mjs')], consumer)).toContain(
        'SECTOR_PUBLIC_OK periodReturn=0.03 dailyReturn=0.03 included=2 artifacts=4 simpleAuditMetadata=absent',
      );
    },
    120_000,
  );
});

/**
 * Selective Greeks and exposure (docs/specs/selective-greeks-and-exposure.md) from the installed
 * tarball: every named entry point resolves from its public specifier, selected values equal the
 * full calculation's, and a shortcut is the same function from both structure entrypoints.
 */
const SELECTIVE_PUBLIC_CONSUMER_TS = `
import { InputError, ErrorCode, resolvedExpiry } from '@insiderfinance/totalfinance/core';
import { blackScholes } from '@insiderfinance/totalfinance/options/black-scholes';
import {
  blackScholesEvaluateMany, blackScholesEvaluateManyInto, blackScholesPriceMany,
} from '@insiderfinance/totalfinance/options/batch';
import {
  colorExposure, exposure, exposureFromGreeks, gammaExposure,
} from '@insiderfinance/totalfinance/structure';
import { gammaExposure as gammaFromSubpath } from '@insiderfinance/totalfinance/structure/exposure';

const option = { type: 'call' as const, spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 };
const greeks = blackScholes.greeks(option);
if (blackScholes.gamma(option) !== greeks.gamma || blackScholes.rho(option) !== greeks.rho)
  throw new Error('named Greeks drifted from blackScholes.greeks');
const selected = blackScholes.evaluate({ ...option, outputs: ['price', 'gamma'] });
if (Object.keys(selected).join() !== 'price,gamma' || selected.price !== blackScholes.price(option))
  throw new Error('evaluate returned something other than the selection');

const columns = {
  spot: Float64Array.of(100, 100), strike: Float64Array.of(105, 95), volatility: Float64Array.of(0.2, 0.25),
  riskFreeRate: Float64Array.of(0.04, 0.04), timeToExpiryYears: Float64Array.of(0.25, 0.25), type: Int8Array.of(1, -1),
};
const many = blackScholesEvaluateMany(columns, { outputs: ['gamma', 'delta'] });
const priced = blackScholesPriceMany(columns, { greeks: true });
if (many.gamma[0] !== greeks.gamma || many.delta[1] !== priced.delta![1])
  throw new Error('the batch family disagrees with itself');
const reused = new Float64Array(4).fill(-1);
blackScholesEvaluateManyInto(columns, { gamma: reused });
if (reused[1] !== many.gamma[1] || reused[2] !== -1) throw new Error('Into wrote outside rows [0, n)');
let refused: unknown;
try { blackScholesEvaluateManyInto(columns, { gamma: columns.spot }); } catch (error) { refused = error; }
if (!(refused instanceof InputError) || refused.code !== ErrorCode.InputWrongShape)
  throw new Error('an output aliasing an input column was not refused');

const asOf = Date.parse('2026-06-15T18:30:00Z');
const quotes = [95, 100, 105].flatMap((strike) => (['call', 'put'] as const).map((type) => ({
  contract: { underlying: 'SPX', type, style: 'european' as const, strike, expiry: '2026-07-17', ...resolvedExpiry('2026-07-17'), multiplier: 100 },
  timestampMs: asOf, impliedVolatility: 0.2, openInterest: 1000,
})));
const chain = { quotes, market: { spot: 100, riskFreeRate: 0.04, asOf }, config: { convention: 'dealerShortGamma' as const } };
const full = exposure(chain);
const gex = gammaExposure(chain);
if (gammaFromSubpath !== gammaExposure) throw new Error('structure and structure/exposure export different shortcuts');
if (gex.aggregate.gex !== full.aggregate.gex || 'dex' in gex.aggregate)
  throw new Error('gammaExposure is not the gex selection');
if (gex.atSpot(101).gex !== full.atSpot(101).gex) throw new Error('per-tick GEX drifted');
if (colorExposure(chain).aggregate.color !== full.aggregate.color) throw new Error('color exposure drifted');
const both = exposure({ ...chain, metrics: ['gex', 'dex'] });
if (both.aggregate.dex !== full.aggregate.dex || both.assumptions.metrics?.join() !== 'gex,dex')
  throw new Error('a combined selection lost a metric or its echo');

const supplied = exposureFromGreeks({
  quotes: quotes.map((quote) => ({ ...quote, source: 'chain-feed', greeks: { gamma: 0.02, provenance: { source: 'greek-feed', timestampMs: asOf } } })),
  market: { underlying: 'SPX', spot: 100, source: 'spot-feed', timestampMs: asOf, asOf },
  config: { gexConvention: { calls: 1, puts: -1 }, gammaUnit: 'perPoint', maximumObservationAgeMs: 0 },
  metrics: ['gex'],
});
if ('dex' in supplied.aggregate || supplied.coverage.includedQuotes !== 6)
  throw new Error('a GEX-only supplied report required delta or reported DEX');
console.log('SELECTIVE_PUBLIC_OK gamma=' + gex.aggregate.gex.toFixed(2) + ' outputs=' + Object.keys(selected).join('+'));
`;

describe('packed selective Greeks and exposure', () => {
  it.each(['nodenext', 'bundler'] as const)(
    'the type contract and the selected results survive packing under moduleResolution: %s',
    (resolution) => {
      const dir = join(consumer, `selective-public-${resolution}`);
      sh('mkdir', ['-p', dir], consumer);
      // The source compile contracts, rewritten to public specifiers: every @ts-expect-error must
      // still be an error against the PACKED declarations, and every literal selection still exact.
      const publicSource = (path: string): string =>
        readFileSync(join(ROOT, path), 'utf8').replace(
          /(['"])(@totalfinance\/[^'"]+)\1/g,
          (_match, quote: string, specifier: string) =>
            quote + toPublicSpecifier(specifier) + quote,
        );
      writeFileSync(
        join(dir, 'greeks-contract.mts'),
        publicSource('packages/options/test/selective-greeks.compile.ts'),
      );
      writeFileSync(
        join(dir, 'exposure-contract.mts'),
        publicSource('packages/structure/test/exposure-selective.compile.ts'),
      );
      writeFileSync(join(dir, 'consumer.mts'), SELECTIVE_PUBLIC_CONSUMER_TS);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: resolution === 'nodenext' ? 'nodenext' : 'esnext',
            moduleResolution: resolution,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            target: 'es2022',
            outDir: './compiled',
          },
          include: ['greeks-contract.mts', 'exposure-contract.mts', 'consumer.mts'],
        }),
      );
      sh(TSC, ['-p', dir], dir);
      // Only the runtime journey executes; the contracts are compile-only (they declare inputs).
      expect(sh('node', [join(dir, 'compiled/consumer.mjs')], consumer)).toMatch(
        /SELECTIVE_PUBLIC_OK gamma=-\d+\.\d\d outputs=price\+gamma/,
      );
    },
    120_000,
  );
});
