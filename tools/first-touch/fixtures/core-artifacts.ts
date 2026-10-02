/**
 * Gate B — first-touch fixtures for the `@totalfinance/core/artifacts` spine: the create/read heads
 * synthesis cannot build (they need hash strings, Law-2 results, and whole envelopes) plus the
 * migration-registry receiver methods. Thunks build FRESH inputs per call; probes mutate what they
 * are given. Read fixtures pass a REAL created envelope through a JSON round-trip, so the read
 * heads exercise validation and id verification rather than only ever hitting a refusal path.
 */

import {
  contentHash,
  createAnalysisArtifact,
  createMarketSnapshot,
  createScenarioSet,
} from '@totalfinance/core/artifacts';
import { ErrorCode, InputError } from '@totalfinance/core';
import { type MarketObservation, type MarketRequirement } from '@totalfinance/core/pricing';
import { type FixtureThunk } from '../inputs.js';

const spotRequirement = (): MarketRequirement => ({ kind: 'spot', symbol: 'AAPL' });

const spotObservation = (): MarketObservation => ({
  requirement: { kind: 'spot', symbol: 'AAPL' },
  value: 195.3,
});

/** A minimal conformant pricer for the definition/conformance fixtures — zero pricing math. */
const fixturePricer = () => ({
  name: 'fixture.spot-echo',
  version: '0.0.1',
  capabilities: { greeks: 'none', randomness: 'none', batch: false } as const,
  supports: () => true,
  requirements: (): MarketRequirement[] => [spotRequirement()],
  price: (input: { observations: readonly MarketObservation[] }) => {
    const spot = input.observations.find(
      (o) => o.requirement.kind === 'spot' && o.requirement.symbol === 'AAPL',
    );
    if (spot === undefined) {
      throw new InputError(
        'fixture.spot-echo: no observation satisfies the required market requirement spot(symbol=AAPL).',
        { code: ErrorCode.PricerRequirementUnsatisfied, context: {} },
      );
    }
    return {
      value: spot.value as number,
      assumptions: { conventionsVersion: 'totalfinance-conventions@1' },
      diagnostics: { warnings: [] },
    };
  },
});

const lawTwoResult = (): Record<string, unknown> => ({
  value: 12.34,
  assumptions: { conventionsVersion: 'totalfinance-conventions@1' },
  diagnostics: { warnings: [] },
});

const snapshot = (): unknown =>
  createMarketSnapshot({
    asOf: '2026-07-20T00:00:00Z',
    conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
    observations: {
      spots: { AAPL: { price: 195.3, currency: 'USD' } },
      riskFreeRates: { USD: 0.045 },
      volatilities: { AAPL: 0.24 },
    },
  });

const scenarioSet = (): unknown =>
  createScenarioSet({
    name: 'fixture-stress',
    scenarios: [{ name: 'crash -20%', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] }],
  });

const artifact = (): unknown =>
  createAnalysisArtifact({
    artifactType: 'options.chain-analysis',
    producedBy: { operation: 'analyzeChain' },
    inputs: { parameters: { minOpenInterest: 100 } },
    result: lawTwoResult(),
  });

/** A complete Stage 4.5 fitted-model summary (Decision 2), fresh per call. */
const fittedModelSummary = (): Record<string, unknown> => ({
  family: 'volatility.ssvi',
  modelVersion: 1,
  parameters: {
    rho: -0.3,
    'phi.kind': 'power-law',
    'phi.eta': 1.2,
    'thetaTerm.theta': [0.01, 0.02],
  },
  objective: { kind: 'root-mean-square-error', value: 0.0012, unit: 'total variance' },
  convergence: { converged: true, iterations: 212 },
  residuals: {
    count: 40,
    rootMeanSquare: 0.0012,
    maximumAbsolute: 0.004,
    unit: 'total variance',
    source: 'direct-evaluator',
  },
  modelRisk: {
    arbitrageFree: true,
    calibratedRange: { logMoneyness: { minimum: -0.4, maximum: 0.3 } },
    notes: [],
  },
  weighting: 'vega',
  inputIdentity: { calibrationHash: contentHash({ slices: [] }), snapshotHash: null },
  warningCount: 0,
});

export const CORE_ARTIFACTS_FIXTURES: Record<string, FixtureThunk> = {
  'core.createTableHandle': () => [
    {
      contentHash: contentHash({ rows: [1, 2, 3] }),
      rowCount: 3,
      columnCount: 1,
      columns: ['value'],
    },
  ],
  'core.createAnalysisArtifact': () => [
    {
      artifactType: 'options.chain-analysis',
      producedBy: { operation: 'analyzeChain' },
      inputs: { parameters: { minOpenInterest: 100 } },
      result: lawTwoResult(),
    },
  ],
  'core.readAnalysisArtifact': () => [{ artifact: JSON.parse(JSON.stringify(artifact())) }],
  // Stage 4.5 slice 1 — comparison, parity, the promoted scanner, row handles, the summary grammar.
  'core.compareCalculationArtifacts': () => [
    {
      baseline: JSON.parse(JSON.stringify(artifact())),
      candidate: JSON.parse(JSON.stringify(artifact())),
      metrics: [
        {
          name: 'premium',
          baseline: { path: ['value'], unit: 'USD/share' },
          candidate: { path: ['value'], unit: 'USD/share' },
          tolerance: { absolute: 0.0001, relative: 0 },
        },
      ],
      limits: { maximumDifferences: 100, maximumLeaves: 100_000 },
    },
  ],
  'core.compareAnalysisArtifacts': () => [
    {
      baseline: JSON.parse(JSON.stringify(artifact())),
      candidate: JSON.parse(JSON.stringify(artifact())),
      tolerance: { absolute: 1e-9, relative: 1e-9 },
      limits: { maximumDifferences: 100, maximumLeaves: 100_000 },
    },
  ],
  'core.artifactReplayParity': () => [
    { saved: lawTwoResult(), recomputed: lawTwoResult(), limits: { maximumDifferences: 100 } },
  ],
  'core.scanCanonicalData': () => [
    { rows: [1, 2, 3], label: 'x' },
    {
      functionName: 'fixture',
      label: 'value',
      maximumWorkUnits: 10_000,
      requireFiniteNumbers: true,
    },
  ],
  'core.tableHandleForRows': () => [
    {
      rows: [
        { instrumentId: 'AAPL', value: 1 },
        { instrumentId: 'MSFT', value: 2 },
      ],
    },
  ],
  'core.requireFittedModelSummary': () => ['deepSweepProbe', 'summary', fittedModelSummary()],
  // A selection list and the names it may hold (selective Greeks and exposure).
  'core.requireSelection': () => [
    'deepSweepProbe',
    'outputs',
    ['gamma', 'delta'],
    ['delta', 'gamma', 'vega'],
  ],
  'core.requireRateCurveData': () => [
    'deepSweepProbe',
    'curve',
    {
      currency: 'USD',
      asOf: Date.UTC(2026, 0, 1),
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      points: [
        { date: '2026-01-01', zeroRate: 0.04 },
        { date: '2027-01-01', zeroRate: 0.042 },
      ],
    },
  ],
  'core.isFittedModelSummary': () => [fittedModelSummary()],
  // Stage 4.5 slice 4 — the shared fitted-model kit.
  'core.requireWorkLimit': () => [
    {
      functionName: 'fixture',
      field: 'limits.gridPoints',
      value: 64,
      law: { default: 256, maximum: 4_096 },
    },
  ],
  'core.requireComparisonTolerance': () => [
    { functionName: 'fixture', tolerance: { absolute: 1e-6, relative: 1e-4 } },
  ],
  'core.applyReportMigrations': () => [
    {
      functionName: 'fixture',
      kind: 'volatility.fitted-model:svi',
      report: { family: 'svi', modelVersion: 1 },
      storedVersion: 1,
      currentVersion: 1,
      versionField: 'modelVersion',
      subject: "'svi' report",
    },
  ],
  'core.verifyReferencedRows': () => {
    const rows = [
      { instrumentId: 'AAPL', value: 1 },
      { instrumentId: 'MSFT', value: 2 },
    ];
    return [
      {
        functionName: 'fixture',
        label: 'observations',
        handle: {
          kind: 'totalfinance.table-handle',
          contentHash: contentHash(rows),
          rowCount: 2,
          columnCount: 2,
          columns: ['instrumentId', 'value'],
        },
        rows,
      },
    ];
  },
  'core.flattenSummaryParameters': () => [fittedModelSummary()],
  'core.residualStatistics': () => [[0.001, -0.002, 0.0005]],
  'core.createScenarioSet': () => [
    {
      name: 'fixture-stress',
      scenarios: [
        { name: 'crash -20%', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] },
      ],
    },
  ],
  'core.readScenarioSet': () => [{ scenarioSet: JSON.parse(JSON.stringify(scenarioSet())) }],
  // Stage 7A slice 3: a valid set for the content hash (the synthesized one carried a non-factor name).
  'core.scenarioSetContentHash': () => [JSON.parse(JSON.stringify(scenarioSet()))],
  // Stage 7A: the JSON Schema document guard (functionName, field, document).
  'core.requireJSONSchema': () => [
    'fixture',
    'document',
    { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
  ],
  'core.readMarketSnapshot': () => [{ snapshot: JSON.parse(JSON.stringify(snapshot())) }],
  // The option-pricing guard takes an explicit-instant snapshot (the fixture helper's asOf is zoned).
  'core.requireInstantMarketSnapshot': () => ['requireInstantMarketSnapshot', snapshot()],
  'core.ArtifactMigrationRegistry#register': () => [
    {
      kind: 'totalfinance.market-snapshot',
      fromVersion: 0,
      toVersion: 1,
      description: 'fixture step: rename a field the v0 grammar spelled differently',
      migrate: (envelope: Record<string, unknown>) => ({ ...envelope, schemaVersion: 1 }),
    },
  ],
  'core.ArtifactMigrationRegistry#upgrade': () => [
    {
      envelope: JSON.parse(JSON.stringify(snapshot())) as Record<string, unknown>,
      targetVersion: 1,
    },
  ],

  // Gate C pricing protocol (multi-positional helpers + lookups).
  'core.validateMarketRequirement': () => ['deepSweepProbe', 'requirement', spotRequirement()],
  'core.requirementKey': () => [spotRequirement()],
  'core.sameRequirement': () => [spotRequirement(), spotRequirement()],
  'core.validateMarketObservation': () => ['deepSweepProbe', 'observation', spotObservation()],
  'core.observationFor': () => [[spotObservation()], spotRequirement()],
  'core.requireObservationValue': () => ['deepSweepProbe', [spotObservation()], spotRequirement()],
  'core.optionalObservationValue': () => ['deepSweepProbe', [spotObservation()], spotRequirement()],
  'core.missingRequirements': () => [
    { requirements: [spotRequirement()], observations: [spotObservation()] },
  ],
  'core.validateSelectionReport': () => [
    'deepSweepProbe',
    {
      mode: 'explicit',
      selected: { name: 'black-scholes', version: '0.0.1' },
      reason: 'caller-selected explicitly.',
    },
  ],
  'core.definePricer': () => [fixturePricer()],
  'core.validatePricer': () => [
    fixturePricer(),
    [{ instrument: { any: true }, observations: [spotObservation()] }],
  ],
  'options.optionContractPricer': () => [{}],
};
