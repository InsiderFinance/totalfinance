/**
 * Stage 4.6 slice 3 — `@totalfinance/backtest/artifacts`: a cross-sectional run and a grid save → JSON
 * → restore → replay to the same run hash → compare. The laws: the run is stored verbatim and its
 * hash is its identity; referenced row sets restore only with the verified rows; a caller function
 * makes a run non-replayable by name; models are taken back at replay and verified against their
 * recorded descriptions; a foreign artifact, a tampered report, and every malformed input teach.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import {
  type CrossSectionalBacktestRequest,
  crossSectionalBacktest,
  crossSectionalBacktestGrid,
  fees,
  slippage,
} from '@totalfinance/backtest';
import {
  BACKTEST_RUN_ARTIFACT_TYPE,
  BACKTEST_RUN_KINDS,
  BACKTEST_RUN_KIND_LIST,
  backtestRunArtifact,
  compareBacktestRuns,
  readBacktestRun,
  replayBacktestRun,
} from '@totalfinance/backtest/artifacts';
import { execution, spreadModels } from '@totalfinance/backtest/execution';
import { researchProtocol } from '@totalfinance/risk';
import type {
  FieldDefinition,
  ReturnObservation,
  UniverseObservation,
} from '@totalfinance/research';

const DAY = 86_400_000;
const NAMES = ['AAA', 'BBB', 'CCC', 'DDD'] as const;
const fieldDefinitions: FieldDefinition[] = [{ fieldName: 'quality', kind: 'numeric' }];

function sessions(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 2) + i * 7 * DAY).toISOString().slice(0, 10),
  );
}

function returnsFor(dates: readonly string[]): ReturnObservation[] {
  const drift: Record<string, number> = { AAA: 0.02, BBB: 0.005, CCC: -0.01, DDD: -0.02 };
  const rows: ReturnObservation[] = [];
  for (const instrumentId of NAMES) {
    dates.forEach((tradingSessionDate, i) => {
      rows.push({
        instrumentId,
        tradingSessionDate,
        simpleReturn:
          drift[instrumentId]! + ((i * 7 + instrumentId.charCodeAt(0)) % 5) * 0.002 - 0.004,
      });
    });
  }
  return rows;
}

function observations(): UniverseObservation[] {
  const quality: Record<string, number> = { AAA: 4, BBB: 3, CCC: 2, DDD: 1 };
  return NAMES.map((instrumentId) => ({
    instrumentId,
    availableTimestampMs: Date.UTC(2026, 0, 1),
    fields: { quality: quality[instrumentId]! },
  }));
}

function request(
  overrides: Partial<CrossSectionalBacktestRequest> = {},
): CrossSectionalBacktestRequest {
  return {
    dataset: { observations: observations(), fieldDefinitions, returns: returnsFor(sessions(20)) },
    universeHistory: {
      universeId: 'artifact-4',
      members: NAMES.map((instrumentId) => ({
        instrumentId,
        fromTimestampMs: Date.UTC(2026, 0, 1),
      })),
    },
    signal: {
      score: {
        components: [
          {
            field: 'quality',
            weight: 1,
            direction: 'higher-is-better',
            standardization: 'z-score',
          },
        ],
        missingValuePolicy: 'exclude',
      },
    },
    rebalanceSchedule: { frequency: 'monthly', session: 'close' },
    portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
    initialCapital: 100_000,
    ...overrides,
  };
}

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('the kind table', () => {
  it('is data: five kinds, each naming its verb, row sets, callbacks, and model fields', () => {
    expect(BACKTEST_RUN_KIND_LIST).toEqual([
      'cross-sectional',
      'cross-sectional-grid',
      'options',
      'portfolio',
      'environment',
    ]);
    expect(BACKTEST_RUN_KINDS['environment'].operation).toBe('runEnvironmentEpisode');
    expect(BACKTEST_RUN_KINDS['environment'].inputRowSets).toContain('definition.marketData.bars');
    expect(BACKTEST_RUN_KINDS['environment'].inputRowSets).toContain('actions');
    expect(BACKTEST_RUN_KINDS['environment'].resultRowSets).toContain('run.result.ledger.events');
    expect(BACKTEST_RUN_KINDS['environment'].callbackFields).toEqual([
      'definition.reward.goal',
      'definition.instruments.<id>.adapter',
    ]);
    expect(BACKTEST_RUN_KINDS['portfolio'].operation).toBe('portfolioBacktest');
    expect(BACKTEST_RUN_KINDS['portfolio'].inputRowSets).toContain('marketData.bars');
    expect(BACKTEST_RUN_KINDS['portfolio'].resultRowSets).toContain('run.ledger.events');
    expect(BACKTEST_RUN_KINDS['cross-sectional'].operation).toBe('crossSectionalBacktest');
    expect(BACKTEST_RUN_KINDS['cross-sectional'].inputRowSets).toContain('dataset.returns');
    expect(BACKTEST_RUN_KINDS['cross-sectional'].resultRowSets).toContain('run.ledger.events');
    expect(BACKTEST_RUN_KINDS['cross-sectional'].callbackFields).toEqual([
      'signal.callback',
      'portfolioConstruction.suppliedWeights',
    ]);
    expect(BACKTEST_RUN_KINDS['cross-sectional-grid'].operation).toBe('crossSectionalBacktestGrid');
    expect(Object.isFrozen(BACKTEST_RUN_KINDS)).toBe(true);
  });
});

describe('a cross-sectional run: save → JSON → restore → replay → compare', () => {
  it('stores the run verbatim, hashes it, records the FC8 identity, and replays to the same hash', () => {
    const input = request();
    const run = crossSectionalBacktest(input);
    const artifact = backtestRunArtifact({
      kind: 'cross-sectional',
      run,
      input,
      libraryVersion: '0.1.0',
    });
    expect(artifact.artifactType).toBe(BACKTEST_RUN_ARTIFACT_TYPE);
    expect(artifact.producedBy).toEqual({
      operation: 'crossSectionalBacktest',
      libraryVersion: '0.1.0',
    });
    expect(artifact.tables).toBeUndefined();

    const restored = readBacktestRun({ artifact: fromCanonicalJson(canonicalJsonOf(artifact)) });
    const report = restored.report;
    expect(report.kind).toBe('cross-sectional');
    expect(canonicalJsonOf(report.run)).toBe(canonicalJsonOf(run));
    expect(report.runHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.identity.runId).toBe(run.runId);
    expect(report.identity.universeId).toBe('artifact-4');
    expect(report.identity.universeHistoryHash).toMatch(/^sha256:/);
    expect(report.identity.strategy['kind']).toBe('score');
    expect(report.identity.recipe).toBeNull();
    expect(report.identity.models).toEqual({ execution: null, commission: null, slippage: null });
    expect(report.identity.calendar.sessions).toBe(20);
    expect(report.identity.engine).toEqual({ operation: 'crossSectionalBacktest', runVersion: 1 });
    expect(report.identity.annualization).toEqual({ periodsPerYear: 252, riskFreeRate: 0 });
    expect(report.execution).toEqual({ completed: true });
    expect(report.assumptions.replayable).toBe(true);
    expect(report.assumptions.inputPolicy).toBe('embedded');
    expect(report.hygiene).toBeNull();
    expect(report.diagnostics.embeddedRows).toBeGreaterThan(0);
    expect(report.diagnostics.referencedRows).toBe(0);
    expect(Object.isFrozen(report.run)).toBe(true);

    const replay = replayBacktestRun({ artifact, libraryVersion: '0.1.0' });
    expect(replay.matches).toBe(true);
    expect(replay.parity.identical).toBe(true);
    expect(replay.runHash.recomputed).toBe(report.runHash);
    expect(replay.assumptions.models).toEqual({ execution: 'none', transactionCostModel: 'none' });
    expect(replay.diagnostics.warnings).toEqual([]);
  });

  it('references bulk row sets by handle, refuses to replay without the rows, and restores them verified', () => {
    const input = request();
    const run = crossSectionalBacktest(input);
    const artifact = backtestRunArtifact({
      kind: 'cross-sectional',
      run,
      input,
      referenceRowSets: ['dataset.returns', 'run.ledger.events', 'run.holdings'],
      locators: { 'dataset.returns': 's3://bucket/returns.json' },
    });
    expect(Object.keys(artifact.tables ?? {}).sort()).toEqual([
      'dataset.returns',
      'run.holdings',
      'run.ledger.events',
    ]);
    expect(artifact.tables!['dataset.returns']!.locator).toBe('s3://bucket/returns.json');
    expect(artifact.tables!['dataset.returns']!.rowCount).toBe(input.dataset.returns.length);
    const read = readBacktestRun({ artifact });
    expect(read.report.assumptions.inputPolicy).toBe('referenced');
    expect(read.report.run['holdings']).toEqual(artifact.tables!['run.holdings']);
    expect((read.report.run['ledger'] as { events: unknown }).events).toEqual(
      artifact.tables!['run.ledger.events'],
    );
    expect((read.report.inputs['dataset'] as { returns: unknown }).returns).toEqual(
      artifact.tables!['dataset.returns'],
    );
    expect(read.restoredRowSets).toEqual([]);
    // the run hash is the projection's hash — the same run, referenced, hashes differently than embedded
    expect(read.report.runHash).not.toBe(
      backtestRunArtifact({ kind: 'cross-sectional', run, input }).result['runHash'],
    );

    const missing = failure(() => replayBacktestRun({ artifact }));
    expect(missing.code).toBe(ErrorCode.InputMissingField);
    expect(missing.message).toContain("referencedData['dataset.returns']");
    const wrong = failure(() =>
      replayBacktestRun({
        artifact,
        referencedData: { 'dataset.returns': input.dataset.returns.slice(1) },
      }),
    );
    expect(wrong.message).toContain('dataset.returns');

    const replay = replayBacktestRun({
      artifact,
      referencedData: { 'dataset.returns': input.dataset.returns },
    });
    expect(replay.matches).toBe(true);
    expect(replay.parity.identical).toBe(true);
    expect(replay.assumptions.referencedRowSets).toEqual([
      'dataset.returns',
      'run.holdings',
      'run.ledger.events',
    ]);
    // the read door restores supplied rows after verifying them
    const hydrated = readBacktestRun({
      artifact,
      referencedData: { 'run.holdings': run.holdings, 'dataset.returns': input.dataset.returns },
    });
    expect(hydrated.restoredRowSets).toEqual(['dataset.returns', 'run.holdings']);
    expect(hydrated.report.run['holdings']).toEqual(run.holdings);
    expect(
      failure(() => readBacktestRun({ artifact, referencedData: { 'run.trades': run.trades } }))
        .code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        readBacktestRun({ artifact, referencedData: { 'run.holdings': run.holdings.slice(1) } }),
      ).message,
    ).toContain('run.holdings');
  });

  it('records models by description, takes them back at replay, and verifies each', () => {
    const policy = execution.declared({
      label: 'test: 2 bps half-spread',
      costs: { spread: spreadModels.halfSpreadBps(2) },
    });
    const costs = { commission: fees.bps(1), slippage: slippage.bps(2) };
    const input = request({ execution: policy, transactionCostModel: costs });
    const run = crossSectionalBacktest(input);
    const artifact = backtestRunArtifact({ kind: 'cross-sectional', run, input });
    const { report } = readBacktestRun({ artifact });
    expect(report.identity.models.execution?.label).toBe('test: 2 bps half-spread');
    expect(report.identity.models.execution?.realism).toBe('declared');
    expect(report.identity.models).toMatchObject({ commission: 'bps(1)', slippage: 'bps(2)' });
    expect(report.inputs['transactionCostModel'] as Record<string, string>).toEqual({
      commission: 'bps(1)',
      slippage: 'bps(2)',
    });
    expect(report.assumptions.replayable).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain('halfSpread(');

    const noModels = failure(() => replayBacktestRun({ artifact }));
    expect(noModels.code).toBe(ErrorCode.InputMissingField);
    expect(noModels.message).toContain('models.execution');
    const wrongPolicy = failure(() =>
      replayBacktestRun({
        artifact,
        models: { execution: execution.simplified(), transactionCostModel: costs },
      }),
    );
    expect(wrongPolicy.code).toBe(ErrorCode.BacktestAdapterNonconformant);
    const wrongCosts = failure(() =>
      replayBacktestRun({
        artifact,
        models: {
          execution: policy,
          transactionCostModel: { commission: fees.bps(5), slippage: slippage.bps(2) },
        },
      }),
    );
    expect(wrongCosts.code).toBe(ErrorCode.BacktestAdapterNonconformant);
    expect(wrongCosts.message).toContain("'bps(1)'");
    const replay = replayBacktestRun({
      artifact,
      models: { execution: policy, transactionCostModel: costs },
    });
    expect(replay.matches).toBe(true);
    expect(replay.assumptions.models).toEqual({
      execution: 'supplied',
      transactionCostModel: 'supplied',
    });
    // the simplified default is rebuilt without help
    const simplified = backtestRunArtifact({
      kind: 'cross-sectional',
      run: crossSectionalBacktest(request({ execution: execution.simplified() })),
      input: request({ execution: execution.simplified() }),
    });
    expect(replayBacktestRun({ artifact: simplified }).assumptions.models.execution).toBe(
      'recorded-default',
    );
    expect(
      failure(() =>
        replayBacktestRun({
          artifact: backtestRunArtifact({
            kind: 'cross-sectional',
            run: crossSectionalBacktest(request()),
            input: request(),
          }),
          models: { execution: policy },
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('a caller function makes the run non-replayable by name; the function is never stored', () => {
    const input = request({
      signal: {
        callback: (context) =>
          context.eligible.map((observation) => ({
            instrumentId: observation.instrumentId,
            score: Number(observation.fields['quality']),
          })),
      },
    });
    const run = crossSectionalBacktest(input);
    const artifact = backtestRunArtifact({ kind: 'cross-sectional', run, input });
    const { report } = readBacktestRun({ artifact });
    expect(report.assumptions.replayable).toBe(false);
    expect(report.assumptions.nonReplayableField).toBe('signal.callback');
    expect(report.inputs['signal']).toEqual({ callback: '[caller function — not stored]' });
    const refused = failure(() => replayBacktestRun({ artifact }));
    expect(refused.code).toBe(ErrorCode.ArtifactNotReplayable);
    expect(refused.message).toContain('signal.callback');
  });

  it('attaches hygiene verbatim and compares two runs: metrics, holdings, rebalances, the structural diff', () => {
    const base = request();
    const baseRun = crossSectionalBacktest(base);
    const protocol = researchProtocol({ returns: baseRun.returns });
    const baseline = backtestRunArtifact({
      kind: 'cross-sectional',
      run: baseRun,
      input: base,
      hygiene: { researchProtocol: protocol as unknown as Record<string, unknown> },
    });
    expect(readBacktestRun({ artifact: baseline }).report.hygiene?.researchProtocol).toEqual(
      JSON.parse(JSON.stringify(protocol)),
    );
    const other = request({
      portfolioConstruction: { method: 'equal-weight', long: { count: 3 } },
    });
    const candidate = backtestRunArtifact({
      kind: 'cross-sectional',
      run: crossSectionalBacktest(other),
      input: other,
    });
    const comparison = compareBacktestRuns({ baseline, candidate });
    expect(comparison.kind).toBe('cross-sectional');
    expect(comparison.identical).toBe(false);
    expect(comparison.sameInputs).toBe(false);
    expect(comparison.sameUniverse).toBe(true);
    expect(comparison.sameStrategy).toBe(true);
    expect(comparison.sameModels).toBe(true);
    expect(comparison.metrics.map((m) => m.name)).toContain('sharpe');
    expect(comparison.metrics.find((m) => m.name === 'finalValue')!.withinTolerance).toBeNull();
    expect(comparison.holdings!.entered.ids).toEqual(['CCC']);
    expect(comparison.holdings!.kept.count).toBe(2);
    expect(comparison.rebalances!.compared).toBe(baseRun.rebalances.length);
    expect(comparison.rebalances!.rows[0]!.longCount).toEqual({ baseline: 2, candidate: 3 });
    expect(comparison.hygiene).toEqual({
      baseline: protocol.verdict,
      candidate: null,
      changed: true,
    });
    expect(comparison.run.differenceCount).toBeGreaterThan(0);
    expect(comparison.withinTolerance).toBeNull();
    const same = compareBacktestRuns({
      baseline,
      candidate: baseline,
      tolerance: { absolute: 0, relative: 0 },
    });
    expect(same.identical).toBe(true);
    expect(same.withinTolerance).toBe(true);
    expect(same.run.differenceCount).toBe(0);
    // a report compares as well as an artifact
    const viaReport = compareBacktestRuns({
      baseline: readBacktestRun({ artifact: baseline }).report,
      candidate,
    });
    expect(viaReport.artifactIds).toEqual({ baseline: null, candidate: candidate.id });
  });
});

describe('a grid: the sweep hash, the child hashes, and the grid’s own hygiene', () => {
  const gridRequest = () => ({
    request: request(),
    variations: [{ path: 'portfolioConstruction.long.count', values: [1, 2, 3] }],
  });

  it('saves the whole protocol in one artifact and replays it', () => {
    const input = gridRequest();
    const run = crossSectionalBacktestGrid(input);
    const artifact = backtestRunArtifact({
      kind: 'cross-sectional-grid',
      run,
      input,
      referenceRowSets: ['run.runs'],
    });
    const { report } = readBacktestRun({ artifact });
    expect(report.identity.runId).toBe(run.sweepId);
    expect(report.identity.childRunIds).toEqual(run.variations.map((v) => v.runId));
    expect(report.identity.variations).toEqual([
      { path: 'portfolioConstruction.long.count', values: [1, 2, 3] },
    ]);
    expect(report.hygiene?.researchProtocol).toEqual(
      JSON.parse(JSON.stringify(run.hygiene.researchProtocol)),
    );
    expect(report.hygiene?.backtestOverfitting).toEqual(
      JSON.parse(JSON.stringify(run.hygiene.backtestOverfitting)),
    );
    expect(report.run['runs']).toEqual(artifact.tables!['run.runs']);
    expect(
      failure(() => backtestRunArtifact({ kind: 'cross-sectional-grid', run, input, hygiene: {} }))
        .code,
    ).toBe(ErrorCode.InputUnknownField);
    const replay = replayBacktestRun({ artifact });
    expect(replay.matches).toBe(true);
    expect(replay.parity.identical).toBe(true);
  });

  it('compares two grids variation by variation and says whether the best moved', () => {
    const left = gridRequest();
    const right = {
      ...gridRequest(),
      variations: [{ path: 'portfolioConstruction.long.count', values: [2, 3, 4] }],
    };
    const baseline = backtestRunArtifact({
      kind: 'cross-sectional-grid',
      run: crossSectionalBacktestGrid(left),
      input: left,
    });
    const candidate = backtestRunArtifact({
      kind: 'cross-sectional-grid',
      run: crossSectionalBacktestGrid(right),
      input: right,
    });
    const comparison = compareBacktestRuns({ baseline, candidate });
    expect(comparison.kind).toBe('cross-sectional-grid');
    expect(comparison.variations).toMatchObject({ matched: 2, baselineOnly: 1, candidateOnly: 1 });
    expect(comparison.variations!.rows.every((row) => row.absoluteDelta === 0)).toBe(true);
    expect(comparison.variations!.rows[0]!.metric).toBe('sharpe');
    expect(comparison.holdings).toBeNull();
    expect(comparison.rebalances).toBeNull();
    expect(comparison.hygiene?.changed).toBeTypeOf('boolean');
  });
});

describe('refusals', () => {
  it('foreign types, tampered reports, mixed kinds, and every malformed input teach', () => {
    const input = request();
    const run = crossSectionalBacktest(input);
    const artifact = backtestRunArtifact({ kind: 'cross-sectional', run, input });
    const foreign = { ...artifact, artifactType: 'research.run' };
    expect(failure(() => readBacktestRun({ artifact: foreign })).code).toBeDefined();
    const tampered = JSON.parse(JSON.stringify(readBacktestRun({ artifact }).report)) as Record<
      string,
      unknown
    >;
    (tampered['run'] as Record<string, unknown>)['finalValue'] = 1;
    expect(
      failure(() => compareBacktestRuns({ baseline: tampered as never, candidate: artifact })).code,
    ).toBe(ErrorCode.ArtifactIdMismatch);
    expect(
      failure(() => backtestRunArtifact({ kind: 'monte-carlo', run, input } as never)).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        backtestRunArtifact({
          kind: 'cross-sectional',
          run,
          input,
          referenceRowSets: ['run.nope'],
        }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        backtestRunArtifact({
          kind: 'cross-sectional',
          run,
          input,
          referenceRowSets: ['dataset.benchmarkReturns'],
        }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        backtestRunArtifact({
          kind: 'cross-sectional',
          run,
          input,
          locators: { 'dataset.returns': 'x' },
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        backtestRunArtifact({
          kind: 'cross-sectional',
          run,
          input,
          limits: { embeddedRowLimit: 10 },
        }),
      ).code,
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
    expect(
      failure(() =>
        backtestRunArtifact({
          kind: 'cross-sectional',
          run,
          input,
          hygiene: { researchProtocol: { verdict: 'significant' } },
        }),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() =>
        backtestRunArtifact({ kind: 'cross-sectional', run: { ...run, extra: 1 } as never, input }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        backtestRunArtifact({ kind: 'cross-sectional', run, input, snapshotHash: 'abc' }),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() => backtestRunArtifact({ kind: 'cross-sectional', run, input, seed: 1 } as never))
        .code,
    ).toBe(ErrorCode.InputUnknownField);
    const grid = crossSectionalBacktestGrid({
      request: input,
      variations: [{ path: 'initialCapital', values: [1e5] }],
    });
    const gridArtifact = backtestRunArtifact({
      kind: 'cross-sectional-grid',
      run: grid,
      input: { request: input, variations: [{ path: 'initialCapital', values: [1e5] }] },
    });
    expect(
      failure(() => compareBacktestRuns({ baseline: artifact, candidate: gridArtifact })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        compareBacktestRuns({ baseline: artifact, candidate: artifact, limits: { listedIds: 0 } }),
      ).code,
    ).toBeDefined();
    expect(failure(() => replayBacktestRun({ artifact, referencedData: null } as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
  });
});
