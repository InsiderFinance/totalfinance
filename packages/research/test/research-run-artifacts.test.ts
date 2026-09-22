/**
 * Stage 4.5 slice 5 — `@totalfinance/research/artifacts` over the eleven FC3 run kinds: describe →
 * save → canonical round trip → read → replay parity byte-identical → compare against a perturbed
 * run with the kind's typed sections; referenced rows (handle stored, hash-verified replay,
 * mismatch and missing-rows refusals); the non-replayable callback law; the hygiene block with its
 * disclosed `Infinity`; the recipe; the descriptor; the direct-save transform fixture; and every
 * refusal with its stable code.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  canonicalJsonOf,
  contentHash,
  createAnalysisArtifact,
  createArtifactMigrationRegistry,
  fromCanonicalJson,
  isTableHandle,
  readAnalysisArtifact,
  type AnalysisArtifact,
} from '@totalfinance/core/artifacts';
import {
  CANONICAL_FACTOR_RECIPES,
  aggregateEventStudies,
  compositeFactorScore,
  eventStudy,
  factorDecay,
  factorSpreadReturn,
  factorTurnover,
  formQuantilePortfolios,
  informationCoefficient,
  rankUniverse,
  scoreUniverse,
  screenUniverse,
  winsorizeFactor,
  type EventStudyInput,
  type FactorEntry,
  type FieldDefinition,
  type UniverseObservation,
} from '@totalfinance/research';
import * as artifacts from '@totalfinance/research/artifacts';
import {
  RESEARCH_RUN_ARTIFACT_TYPE,
  RESEARCH_RUN_KINDS,
  compareResearchRuns,
  readResearchRun,
  replayResearchRun,
  researchRunArtifact,
  type ResearchHygieneBlock,
  type ResearchRunKind,
  type ResearchRunReport,
} from '@totalfinance/research/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}
const persisted = <T>(value: T): T => fromCanonicalJson(canonicalJsonOf(value)) as T;

// ───────────────────────────────────────────── inputs ─────────────────────────────────────────────

const AS_OF = Date.UTC(2026, 7, 12, 20);
const AVAILABLE = Date.UTC(2026, 7, 1);
const FIELDS: FieldDefinition[] = [
  { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'sector', kind: 'category' },
];
const observation = (
  instrumentId: string,
  fields: UniverseObservation['fields'],
): UniverseObservation => ({ instrumentId, availableTimestampMs: AVAILABLE, fields });
const observations = (shift = 0): UniverseObservation[] => [
  observation('AAA', {
    returnOnInvestedCapital: 0.22 + shift,
    freeCashFlowYield: 0.06,
    sector: 'tech',
  }),
  observation('BBB', {
    returnOnInvestedCapital: 0.12 + shift,
    freeCashFlowYield: 0.08,
    sector: 'tech',
  }),
  observation('CCC', {
    returnOnInvestedCapital: 0.18 + shift,
    freeCashFlowYield: 0.04,
    sector: 'energy',
  }),
  observation('DDD', {
    returnOnInvestedCapital: 0.09 + shift,
    freeCashFlowYield: 0.02,
    sector: 'energy',
  }),
];
const screenInput = (shift = 0) => ({
  universeId: 'test-universe',
  asOf: AS_OF,
  observations: observations(shift),
  fieldDefinitions: FIELDS,
  filter: { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual' as const, value: 0.1 },
  missingValuePolicy: 'exclude' as const,
  orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' as const }],
  limit: 3,
});
const rankInput = (shift = 0) => ({
  universeId: 'test-universe',
  asOf: AS_OF,
  observations: observations(shift),
  fieldDefinitions: FIELDS,
  rankBy: {
    field: shift === 0 ? 'freeCashFlowYield' : 'returnOnInvestedCapital',
    direction: 'descending' as const,
  },
  tiePolicy: 'competition' as const,
  missingValuePolicy: 'exclude' as const,
});
const scoreInput = (shift = 0) => ({
  universeId: 'test-universe',
  asOf: AS_OF,
  observations: observations(shift),
  fieldDefinitions: FIELDS,
  components: [
    {
      field: 'returnOnInvestedCapital',
      weight: 1,
      direction: 'higher-is-better' as const,
      standardization: 'z-score' as const,
    },
  ],
  missingValuePolicy: 'exclude' as const,
});
const entriesOf = (values: Record<string, number | null>): FactorEntry[] =>
  Object.entries(values).map(([instrumentId, value]) => ({ instrumentId, value }));
// A perturbation that REORDERS (CCC overtakes BBB at shift 0.05), so every rank-based kind changes.
const factorEntries = (shift = 0) => entriesOf({ AAA: 4, BBB: 3, CCC: 2 + 30 * shift, DDD: 1 });
const forwardReturns = () => entriesOf({ AAA: 0.04, BBB: 0.03, CCC: 0.01, DDD: -0.01 });

const SESSION_DATES = Array.from(
  { length: 12 },
  (_, i) => `2026-06-${String(i + 8).padStart(2, '0')}`,
);
const returnObservations = (shift = 0) =>
  SESSION_DATES.flatMap((tradingSessionDate, index) => [
    // A session-dependent perturbation, so abnormal returns (not just the fitted alpha) move.
    {
      instrumentId: 'AAA',
      tradingSessionDate,
      simpleReturn: 0.001 + 0.0005 * index + shift * (index % 3),
    },
    { instrumentId: 'BBB', tradingSessionDate, simpleReturn: 0.002 - 0.0003 * index },
  ]);
// Varying market returns: a constant market makes the market model inestimable (zero variance).
const marketReturns = () =>
  SESSION_DATES.map((tradingSessionDate, index) => ({
    tradingSessionDate,
    simpleReturn: 0.001 + 0.0004 * ((index * 7) % 5) - 0.0008,
  }));
const eventStudyInput = (shift = 0): EventStudyInput => ({
  events: [
    {
      eventId: 'event-1',
      instrumentId: 'AAA',
      eventType: 'earnings',
      announcedTimestampMs: Date.UTC(2026, 5, 15, 21),
    },
    {
      eventId: 'event-2',
      instrumentId: 'BBB',
      eventType: 'earnings',
      announcedTimestampMs: Date.UTC(2026, 5, 15, 21),
    },
  ],
  returnObservations: returnObservations(shift),
  marketReturns: marketReturns(),
  eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 2 },
  estimationWindow: { startTradingSessionOffset: -6, endTradingSessionOffset: -2 },
  expectedReturnModel: { model: 'market' },
  overlappingEventPolicy: 'reject',
});

interface Case {
  kind: ResearchRunKind;
  input: (shift?: number) => unknown;
  run: (input: unknown) => unknown;
  rowSet: string;
  section: (comparison: artifacts.ResearchRunComparison) => void;
}
const CASES: Case[] = [
  {
    kind: 'screen',
    input: screenInput,
    run: (i) => screenUniverse(i as never),
    rowSet: 'observations',
    section: (c) => {
      expect(c.sameUniverse).toBe(true);
      expect(c.sameAsOf).toBe(true);
      expect(c.sameFilter).toBe(true);
      expect(c.membership).not.toBeNull();
      expect(c.exclusionReasons).not.toBeNull();
      expect(c.rankMoves).toBeNull();
    },
  },
  {
    kind: 'rank',
    input: rankInput,
    run: (i) => rankUniverse(i as never),
    rowSet: 'observations',
    section: (c) => {
      expect(c.sameRankBy).toBe(false);
      expect(c.rankMoves!.movedCount).toBeGreaterThan(0);
      expect(c.rankMoves!.movers[0]!.delta).not.toBe(0);
    },
  },
  {
    kind: 'score',
    input: scoreInput,
    run: (i) => scoreUniverse(i as never),
    rowSet: 'observations',
    section: (c) => {
      expect(c.sameComponents).toBe(true);
      expect(c.scoreDeltas!.count).toBe(4);
      expect(c.scoreDeltas!.perInstrument.length).toBe(4);
    },
  },
  {
    kind: 'event-study',
    input: eventStudyInput,
    run: (i) => eventStudy(i as never),
    rowSet: 'returnObservations',
    section: (c) => {
      expect(c.sameUniverse).toBeNull();
      expect(c.averageAbnormalReturns!.length).toBe(4);
      expect(c.membership!.kept.count).toBe(2);
    },
  },
  {
    kind: 'aggregate-event-studies',
    input: (shift = 0) => ({
      studies: [eventStudy(eventStudyInput(shift)), eventStudy(eventStudyInput())],
    }),
    run: (i) => aggregateEventStudies(i as never),
    rowSet: 'studies',
    section: (c) => {
      expect(c.averageAbnormalReturns!.length).toBe(4);
    },
  },
  {
    kind: 'information-coefficient',
    input: (shift = 0) => ({
      factorEntries: factorEntries(shift),
      forwardReturns: forwardReturns(),
    }),
    run: (i) => informationCoefficient(i as never),
    rowSet: 'factorEntries',
    section: (c) => {
      expect(c.coefficients!.map((d) => d.name)).toEqual([
        'informationCoefficient',
        'rankInformationCoefficient',
      ]);
    },
  },
  {
    kind: 'factor-spread-return',
    input: (shift = 0) => ({
      entries: factorEntries(shift),
      forwardReturns: forwardReturns(),
      quantileCount: 2,
      direction: 'descending',
    }),
    run: (i) => factorSpreadReturn(i as never),
    rowSet: 'forwardReturns',
    section: (c) => {
      expect(c.coefficients!.map((d) => d.name)).toEqual([
        'spreadReturn',
        'longLegMeanReturn',
        'shortLegMeanReturn',
      ]);
    },
  },
  {
    kind: 'factor-turnover',
    input: (shift = 0) => ({
      previousPortfolios: [
        { quantileIndex: 1, instrumentIds: ['AAA', 'BBB'] },
        { quantileIndex: 2, instrumentIds: ['CCC', 'DDD'] },
      ],
      currentPortfolios: [
        { quantileIndex: 1, instrumentIds: shift === 0 ? ['AAA', 'CCC'] : ['AAA', 'BBB'] },
        { quantileIndex: 2, instrumentIds: shift === 0 ? ['BBB', 'DDD'] : ['CCC', 'DDD'] },
      ],
    }),
    run: (i) => factorTurnover(i as never),
    rowSet: 'currentPortfolios',
    section: (c) => {
      expect(c.quantiles!.map((d) => d.key)).toEqual([1, 2]);
      expect(c.quantiles![0]!.absoluteDelta).toBeCloseTo(-0.5, 12);
    },
  },
  {
    kind: 'factor-decay',
    input: (shift = 0) => ({
      factorEntries: factorEntries(shift),
      horizons: [
        { horizonLabel: '1m', forwardReturns: forwardReturns() },
        {
          horizonLabel: '3m',
          forwardReturns: entriesOf({ AAA: 0.01, BBB: 0.04, CCC: 0.02, DDD: 0.03 }),
        },
      ],
    }),
    run: (i) => factorDecay(i as never),
    rowSet: 'horizons[1].forwardReturns',
    section: (c) => {
      expect(c.horizons!.map((d) => d.key)).toEqual(['1m', '3m']);
    },
  },
  {
    kind: 'quantile-portfolios',
    input: (shift = 0) => ({
      entries: factorEntries(shift),
      quantileCount: 2,
      direction: 'descending',
    }),
    run: (i) => formQuantilePortfolios(i as never),
    rowSet: 'entries',
    section: (c) => {
      expect(c.portfolios!.map((p) => p.quantileIndex)).toEqual([1, 2]);
      expect(c.membership).not.toBeNull();
    },
  },
  {
    kind: 'composite-factor-score',
    input: (shift = 0) => ({
      components: [
        { label: 'value', entries: factorEntries(shift), weight: 1, direction: 'higher-is-better' },
        { label: 'quality', entries: forwardReturns(), weight: 1, direction: 'higher-is-better' },
      ],
      missingValuePolicy: 'exclude',
    }),
    run: (i) => compositeFactorScore(i as never),
    rowSet: 'components[0].entries',
    section: (c) => {
      expect(c.sameComponents).toBe(true);
      expect(c.scoreDeltas!.count).toBe(4);
      expect(c.exclusionReasons).not.toBeNull();
    },
  },
];

describe('every run kind: describe → save → round trip → read → replay parity → compare', () => {
  for (const testCase of CASES) {
    it(testCase.kind, () => {
      const input = testCase.input();
      const run = testCase.run(input);
      const artifact = researchRunArtifact({ kind: testCase.kind, run, input } as never);
      expect(artifact.artifactType).toBe(RESEARCH_RUN_ARTIFACT_TYPE);
      expect(artifact.producedBy.operation).toBe(RESEARCH_RUN_KINDS[testCase.kind].operation);
      const parameters = artifact.inputs.parameters as Record<string, unknown>;
      expect(parameters['kind']).toBe(testCase.kind);
      expect(parameters['referenced']).toEqual({});
      const result = artifact.result as ResearchRunReport;
      expect(result.kind).toBe(testCase.kind);
      expect(canonicalJsonOf(result.run)).toBe(canonicalJsonOf(run));
      expect(result.assumptions.replayable).toBe(true);
      expect(result.assumptions.nonReplayableField).toBeNull();
      expect(result.assumptions.inputPolicy).toBe('embedded');
      expect(result.diagnostics.embeddedRows).toBeGreaterThan(0);
      expect(result.diagnostics.referencedRows).toBe(0);
      expect(result.hygiene).toBeNull();
      expect(result.recipe).toBeNull();
      // Deterministic identity: the same call yields the same id.
      expect(researchRunArtifact({ kind: testCase.kind, run, input } as never).id).toBe(
        artifact.id,
      );
      // Read restores the report byte-identically and applies no migration.
      const restored = readResearchRun({ artifact: persisted(artifact) });
      expect(canonicalJsonOf(restored.report)).toBe(canonicalJsonOf(result));
      expect(restored.migrationsApplied).toEqual([]);
      expect(restored.modelMigrationsApplied).toEqual([]);
      expect(Object.isFrozen(restored.report)).toBe(true);
      // Replay parity is byte-identical.
      const replay = replayResearchRun({ artifact: persisted(artifact) });
      expect(replay.parity.identical).toBe(true);
      expect(replay.parity.savedHash).toBe(contentHash(run));
      expect(replay.diagnostics.warnings).toEqual([]);
      expect(replay.assumptions.referencedRowSets).toEqual([]);
      // Compare against a perturbed run with the kind's typed sections.
      const shiftedInput = testCase.input(0.05);
      const shifted = researchRunArtifact({
        kind: testCase.kind,
        run: testCase.run(shiftedInput),
        input: shiftedInput,
      } as never);
      const comparison = compareResearchRuns({ baseline: artifact, candidate: shifted });
      expect(comparison.kind).toBe(testCase.kind);
      expect(comparison.artifactIds).toEqual({ baseline: artifact.id, candidate: shifted.id });
      expect(comparison.sameInputs).toBe(false);
      expect(comparison.hygieneVerdict).toBeNull();
      expect(comparison.run.differenceCount).toBeGreaterThan(0);
      testCase.section(comparison);
      // Comparing a run with itself is the identity.
      const self = compareResearchRuns({ baseline: result, candidate: result });
      expect(self.sameInputs).toBe(true);
      expect(self.run.differenceCount).toBe(0);
      expect(self.artifactIds).toEqual({ baseline: null, candidate: null });
    });
  }

  it('the descriptor is frozen data over exactly the eleven kinds', () => {
    expect(Object.keys(RESEARCH_RUN_KINDS).sort()).toEqual(
      [
        'screen',
        'rank',
        'score',
        'event-study',
        'aggregate-event-studies',
        'information-coefficient',
        'factor-spread-return',
        'factor-turnover',
        'factor-decay',
        'quantile-portfolios',
        'composite-factor-score',
      ].sort(),
    );
    expect(Object.isFrozen(RESEARCH_RUN_KINDS)).toBe(true);
    for (const descriptor of Object.values(RESEARCH_RUN_KINDS)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.runVersion).toBe(1);
      expect(descriptor.replayableWithoutCallbacks).toBe(true);
      expect(descriptor.bulkRowSets.length).toBeGreaterThan(0);
    }
    expect(RESEARCH_RUN_KINDS.screen.callbackFields).toEqual(['customPredicate']);
    expect(RESEARCH_RUN_KINDS['event-study'].callbackFields).toEqual([
      'expectedReturnModel.expectedReturn',
    ]);
    expect(RESEARCH_RUN_KINDS['factor-decay'].bulkRowSets).toEqual([
      'factorEntries',
      'horizons[].forwardReturns',
    ]);
    // A screen is not a model: no evaluator, warm start, stability, or holdout verb exists here.
    for (const absent of [
      'evaluateResearchRun',
      'warmStartFrom',
      'fittedModelStability',
      'fittedModelHoldout',
    ])
      expect(Object.keys(artifacts)).not.toContain(absent);
  });
});

describe('referenced rows', () => {
  for (const testCase of CASES) {
    it(`${testCase.kind}: ${testCase.rowSet} by handle, hash-verified replay, mismatch and missing-rows refusals`, () => {
      const input = testCase.input() as Record<string, unknown>;
      const run = testCase.run(input);
      const artifact = researchRunArtifact({
        kind: testCase.kind,
        run,
        input,
        referenceRowSets: [testCase.rowSet],
        locators: { [testCase.rowSet]: 's3://bucket/rows.parquet' },
      } as never);
      const report = artifact.result as ResearchRunReport;
      const handle = report.referencedData[testCase.rowSet]!;
      expect(isTableHandle(handle)).toBe(true);
      expect(handle.locator).toBe('s3://bucket/rows.parquet');
      expect(report.assumptions.inputPolicy).toBe('referenced');
      expect(report.diagnostics.referencedRows).toBe(handle.rowCount);
      expect(
        (artifact.inputs.parameters as { referenced: Record<string, string> }).referenced,
      ).toEqual({
        [testCase.rowSet]: handle.contentHash,
      });
      expect(artifact.tables).toEqual({ [testCase.rowSet]: handle });
      // The stored input carries the handle where the rows were.
      const path = testCase.rowSet.split('.').flatMap((segment) => {
        const match = /^([^[\]]+)\[(\d+)\]$/.exec(segment);
        return match ? [match[1]!, match[2]!] : [segment];
      });
      let stored: unknown = report.inputs;
      for (const segment of path) stored = (stored as Record<string, unknown>)[segment];
      expect(isTableHandle(stored)).toBe(true);
      let rows: unknown = input;
      for (const segment of path) rows = (rows as Record<string, unknown>)[segment];
      // Replay with the rows is byte-identical; without them, or with other rows, it refuses.
      const replay = replayResearchRun({
        artifact: persisted(artifact),
        referencedData: { [testCase.rowSet]: rows as unknown[] },
      });
      expect(replay.parity.identical).toBe(true);
      expect(replay.assumptions.referencedRowSets).toEqual([testCase.rowSet]);
      expect(codeOf(() => replayResearchRun({ artifact: persisted(artifact) }))).toBe(
        ErrorCode.InputMissingField,
      );
      expect(
        codeOf(() =>
          replayResearchRun({
            artifact: persisted(artifact),
            referencedData: { [testCase.rowSet]: (rows as unknown[]).slice(1) },
          }),
        ),
      ).toBe(ErrorCode.ArtifactReferencedDataMismatch);
    });
  }

  it('refuses an unknown row-set label, a locator for an unreferenced set, and rows above the embedded limit', () => {
    const input = screenInput();
    const run = screenUniverse(input);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, referenceRowSets: ['fieldDefinitions'] }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, locators: { observations: 'x' } }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, limits: { embeddedRowLimit: 2 } }),
      ),
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
    expect(() =>
      researchRunArtifact({ kind: 'screen', run, input, limits: { embeddedRowLimit: 2 } }),
    ).toThrow(/referenceRowSets: \['observations'\]/);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, limits: { maximumEmbeddedBytes: 64 } }),
      ),
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, limits: { embeddedRowLimit: 1e9 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        researchRunArtifact({ kind: 'screen', run, input, referenceRowSets: null } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });
});

describe('non-replayable callbacks (Decision 4)', () => {
  it('a screen with a customPredicate is saved as non-replayable, the function omitted, and replay refuses by name', () => {
    const input = {
      ...screenInput(),
      customPredicate: (row: UniverseObservation) => row.instrumentId !== 'DDD',
    };
    const run = screenUniverse(input);
    expect(run.assumptions.customPredicate).toBe('non-serializable caller predicate');
    const artifact = researchRunArtifact({ kind: 'screen', run, input });
    const report = artifact.result as ResearchRunReport<'screen'>;
    expect(report.assumptions.replayable).toBe(false);
    expect(report.assumptions.nonReplayableField).toBe('customPredicate');
    expect('customPredicate' in (report.inputs as object)).toBe(false);
    const restored = readResearchRun({ artifact: persisted(artifact) });
    expect(restored.report.assumptions.replayable).toBe(false);
    expect(codeOf(() => replayResearchRun({ artifact: persisted(artifact) }))).toBe(
      ErrorCode.ArtifactNotReplayable,
    );
    expect(() => replayResearchRun({ artifact: persisted(artifact) })).toThrow(/customPredicate/);
    // A present callback that is not a function could not have produced the run.
    expect(
      codeOf(() =>
        researchRunArtifact({
          kind: 'screen',
          run,
          input: { ...screenInput(), customPredicate: 'x' } as never,
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });

  it("an event study under a 'custom' expected-return model stores the discriminator only", () => {
    const input: EventStudyInput = {
      ...eventStudyInput(),
      expectedReturnModel: { model: 'custom', expectedReturn: () => 0.0005 },
    };
    const run = eventStudy(input);
    const artifact = researchRunArtifact({ kind: 'event-study', run, input });
    const report = artifact.result as ResearchRunReport<'event-study'>;
    expect(report.assumptions.replayable).toBe(false);
    expect(report.assumptions.nonReplayableField).toBe('expectedReturnModel.expectedReturn');
    expect(report.inputs.expectedReturnModel).toEqual({ model: 'custom' });
    expect(codeOf(() => replayResearchRun({ artifact }))).toBe(ErrorCode.ArtifactNotReplayable);
    // Comparison still works on non-replayable runs — they are runs, not replays.
    const comparison = compareResearchRuns({ baseline: artifact, candidate: artifact });
    expect(comparison.run.differenceCount).toBe(0);
  });
});

const hygiene = (
  verdict: ResearchHygieneBlock['protocol'] extends infer P
    ? P extends { verdict: infer V }
      ? V
      : never
    : never = 'inconclusive',
): ResearchHygieneBlock => ({
  protocol: {
    verdict,
    inSample: { sharpe: 0.9, annualizedSharpe: 1.4, observations: 250 },
    deflatedSharpe: 0.3,
    probabilisticSharpe: 0.62,
    expectedMaxSharpe: 1.1,
    trialCount: 12,
    minTrackRecordLength: verdict === 'likely-overfit' ? Number.POSITIVE_INFINITY : 340,
    rationale: 'twelve trials deflate the in-sample Sharpe below its expected maximum',
    assumptions: { conventionsVersion: '0.0.1', confidence: 0.95, periodsPerYear: 252 },
    diagnostics: { warnings: [] },
  },
  deflatedSharpe: {
    assumptions: { conventionsVersion: '0.0.1', trials: 12, skewness: 0 },
    diagnostics: { warnings: [] },
    deflatedSharpe: 0.3,
    probabilisticSharpe: 0.62,
    expectedMaxSharpe: 1.1,
    trialCount: 12,
  },
  leakage: {
    assumptions: { conventionsVersion: '0.0.1', embargo: 5 },
    diagnostics: { warnings: [] },
    clean: true,
    leaks: [],
  },
  multipleTesting: {
    method: 'holm',
    alpha: 0.05,
    adjusted: [0.01, 0.2, 1],
    rejected: [true, false, false],
  },
});

describe('the hygiene block and the recipe', () => {
  const input = screenInput();
  const run = screenUniverse(input);

  it('stores the block verbatim, round-trips the disclosed Infinity, and reports the verdict change', () => {
    const artifact = researchRunArtifact({
      kind: 'screen',
      run,
      input,
      hygiene: hygiene('likely-overfit'),
    });
    const report = artifact.result as ResearchRunReport;
    expect(report.hygiene!.protocol!.minTrackRecordLength).toBe(Number.POSITIVE_INFINITY);
    const restored = readResearchRun({ artifact: persisted(artifact) });
    expect(restored.report.hygiene!.protocol!.minTrackRecordLength).toBe(Number.POSITIVE_INFINITY);
    expect(canonicalJsonOf(restored.report.hygiene)).toBe(
      canonicalJsonOf(hygiene('likely-overfit')),
    );
    // The block is covered by the artifact id.
    expect(
      researchRunArtifact({ kind: 'screen', run, input, hygiene: hygiene('significant') }).id,
    ).not.toBe(artifact.id);
    const comparison = compareResearchRuns({
      baseline: artifact,
      candidate: researchRunArtifact({
        kind: 'screen',
        run,
        input,
        hygiene: hygiene('significant'),
      }),
    });
    expect(comparison.hygieneVerdict).toEqual({
      baseline: 'likely-overfit',
      candidate: 'significant',
      changed: true,
    });
    expect(comparison.sameInputs).toBe(true);
  });

  it('validates the fields it consumes, closes the block, and leaves assumptions open', () => {
    const save = (block: unknown) =>
      codeOf(() => researchRunArtifact({ kind: 'screen', run, input, hygiene: block as never }));
    expect(save({ ...hygiene(), extra: {} })).toBe(ErrorCode.InputUnknownField);
    expect(save({ protocol: { ...hygiene().protocol, verdict: 'great' } })).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(save({ protocol: { ...hygiene().protocol, minTrackRecordLength: NaN } })).toBe(
      ErrorCode.InputWrongType,
    );
    expect(save({ protocol: { ...hygiene().protocol, probabilisticSharpe: 1.5 } })).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      save({
        leakage: { ...hygiene().leakage, leaks: [{ split: 1, overlapCount: 2, sample: [3] }] },
      }),
    ).toBe(ErrorCode.InputWrongShape);
    expect(save({ multipleTesting: { ...hygiene().multipleTesting, rejected: [true] } })).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(save(null)).toBe(ErrorCode.InputWrongType);
    // Open assumptions: risk's records may carry members research does not know.
    expect(
      save({
        deflatedSharpe: {
          ...hygiene().deflatedSharpe,
          assumptions: { conventionsVersion: '0.0.1', anything: { nested: true } },
        },
      }),
    ).toBeUndefined();
  });

  it('stores a canonical recipe verbatim and refuses a malformed one', () => {
    const recipe = CANONICAL_FACTOR_RECIPES[Object.keys(CANONICAL_FACTOR_RECIPES)[0]!]!;
    const artifact = researchRunArtifact({ kind: 'screen', run, input, recipe });
    const restored = readResearchRun({ artifact: persisted(artifact) });
    expect(canonicalJsonOf(restored.report.recipe)).toBe(canonicalJsonOf(recipe));
    expect(researchRunArtifact({ kind: 'screen', run, input }).id).not.toBe(artifact.id);
    expect(
      codeOf(() =>
        researchRunArtifact({
          kind: 'screen',
          run,
          input,
          recipe: { ...recipe, recipeVersion: 0 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        researchRunArtifact({
          kind: 'screen',
          run,
          input,
          recipe: { ...recipe, neutralization: 'beta' } as never,
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() => researchRunArtifact({ kind: 'screen', run, input, recipe: null } as never)),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('a transform result is a Law-2 report the spine saves directly and links by createdFrom', () => {
    const transform = winsorizeFactor({
      entries: factorEntries(),
      method: { type: 'percentile', lowerPercentile: 0.25, upperPercentile: 0.75 },
    });
    const saved = createAnalysisArtifact({
      artifactType: 'research.transform',
      producedBy: { operation: 'winsorizeFactor' },
      inputs: { parameters: { inputsHash: contentHash(factorEntries()) } },
      result: transform as unknown as Record<string, unknown>,
    });
    expect(readAnalysisArtifact({ artifact: persisted(saved) }).artifact.id).toBe(saved.id);
    const next = formQuantilePortfolios({
      entries: transform.entries,
      quantileCount: 2,
      direction: 'descending',
    });
    const artifact = researchRunArtifact({
      kind: 'quantile-portfolios',
      run: next,
      input: { entries: transform.entries, quantileCount: 2, direction: 'descending' },
      createdFrom: [saved.id],
    });
    expect(artifact.createdFrom).toEqual([saved.id]);
  });
});

describe('refusals and migration', () => {
  const input = screenInput();
  const run = screenUniverse(input);
  const artifact = researchRunArtifact({ kind: 'screen', run, input });

  it('refuses unknown fields, bad kinds, a run of the wrong shape, and a mismatched callback-free input', () => {
    expect(
      codeOf(() => researchRunArtifact({ kind: 'screen', run, input, extra: 1 } as never)),
    ).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => researchRunArtifact({ kind: 'screens', run, input } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => researchRunArtifact({ kind: 'rank', run, input } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() => researchRunArtifact({ kind: 'screen', run: { rows: [] }, input } as never)),
    ).toBe(ErrorCode.InputMissingField);
    expect(codeOf(() => researchRunArtifact({ kind: 'screen', run, input: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() => researchRunArtifact({ kind: 'screen', run, input, snapshotHash: 'abc' })),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() => researchRunArtifact({ kind: 'screen', run, input, libraryVersion: '' })),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('read door: foreign type, tampered result, newer run version, and a registered migration', () => {
    const foreign = createAnalysisArtifact({
      artifactType: 'volatility.fitted-model',
      producedBy: { operation: 'calibrateSvi' },
      inputs: { parameters: {} },
      result: { family: 'svi', assumptions: { model: 'svi' }, diagnostics: { warnings: [] } },
    });
    expect(codeOf(() => readResearchRun({ artifact: foreign }))).toBe(
      ErrorCode.ArtifactFamilyMismatch,
    );
    expect(() => readResearchRun({ artifact: foreign })).toThrow(
      /@insiderfinance\/totalfinance\/volatility\/artifacts/,
    );
    const tampered = persisted(artifact) as { result: Record<string, unknown> };
    tampered.result = { ...tampered.result, kind: 'rank' };
    expect(codeOf(() => readResearchRun({ artifact: tampered as never }))).not.toBeUndefined();
    const newer = createAnalysisArtifact({
      artifactType: RESEARCH_RUN_ARTIFACT_TYPE,
      producedBy: { operation: 'screenUniverse' },
      inputs: { parameters: {} },
      result: { ...(artifact.result as object), runVersion: 2 },
    });
    expect(codeOf(() => readResearchRun({ artifact: newer }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    const older = createAnalysisArtifact({
      artifactType: RESEARCH_RUN_ARTIFACT_TYPE,
      producedBy: { operation: 'screenUniverse' },
      inputs: { parameters: {} },
      result: { ...(artifact.result as object), runVersion: 0, legacy: true },
    });
    expect(codeOf(() => readResearchRun({ artifact: older }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: 'research.run:screen',
      fromVersion: 0,
      toVersion: 1,
      description: 'drop the legacy flag',
      migrate: (envelope) => {
        const { legacy: _legacy, ...report } = envelope['report'] as Record<string, unknown>;
        return { ...envelope, schemaVersion: 1, report };
      },
    });
    const read = readResearchRun({ artifact: older, migrations });
    expect(read.modelMigrationsApplied).toHaveLength(1);
    expect(read.report.runVersion).toBe(1);
    expect(codeOf(() => readResearchRun({ artifact, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });

  it('compare: different kinds refuse with the structural-diff teaching; a different universe warns; ids are capped', () => {
    const rank = researchRunArtifact({
      kind: 'rank',
      run: rankUniverse(rankInput()),
      input: rankInput(),
    });
    expect(codeOf(() => compareResearchRuns({ baseline: artifact, candidate: rank }))).toBe(
      ErrorCode.ArtifactFamilyMismatch,
    );
    expect(() => compareResearchRuns({ baseline: artifact, candidate: rank })).toThrow(
      /compareAnalysisArtifacts/,
    );
    const other = { ...screenInput(), universeId: 'other-universe', asOf: AS_OF + 1 };
    const otherArtifact = researchRunArtifact({
      kind: 'screen',
      run: screenUniverse(other),
      input: other,
    });
    const comparison = compareResearchRuns({
      baseline: artifact,
      candidate: otherArtifact,
      limits: { listedIds: 1 },
    });
    expect(comparison.sameUniverse).toBe(false);
    expect(comparison.sameAsOf).toBe(false);
    expect(comparison.diagnostics.warnings.map((w) => w.code)).toEqual([
      'artifact.comparison_different_universe',
    ]);
    expect(comparison.membership!.kept.ids).toHaveLength(1);
    expect(comparison.membership!.kept.remainderCount).toBe(comparison.membership!.kept.count - 1);
    expect(comparison.assumptions.limits.listedIds).toBe(1);
    expect(
      codeOf(() =>
        compareResearchRuns({ baseline: artifact, candidate: artifact, limits: { listedIds: 0 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() => compareResearchRuns({ baseline: artifact, candidate: null } as never)),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('replay discloses a library-version difference as a warning and never refuses on it', () => {
    const versioned = researchRunArtifact({ kind: 'screen', run, input, libraryVersion: '1.0.0' });
    const replay = replayResearchRun({ artifact: versioned, libraryVersion: '1.1.0' });
    expect(replay.parity.identical).toBe(true);
    expect(replay.diagnostics.warnings.map((w) => w.code)).toEqual([
      'artifact.library_version_differs',
    ]);
    expect(replay.assumptions.libraryVersion).toEqual({ saved: '1.0.0', current: '1.1.0' });
    expect(
      codeOf(() => replayResearchRun({ artifact: versioned, referencedData: null } as never)),
    ).toBe(ErrorCode.InputWrongType);
  });
});

// Keep the module namespace import honest: the barrel exports exactly the four verbs and three constants at runtime.
it('the subpath exports the four verbs and the descriptor, nothing else at runtime', () => {
  const runtime = Object.keys(artifacts).sort();
  expect(runtime).toEqual(
    [
      'RESEARCH_RUN_ARTIFACT_TYPE',
      'RESEARCH_RUN_KINDS',
      'RESEARCH_RUN_LIMITS',
      'compareResearchRuns',
      'readResearchRun',
      'replayResearchRun',
      'researchRunArtifact',
    ].sort(),
  );
  const _artifactType: AnalysisArtifact['artifactType'] = RESEARCH_RUN_ARTIFACT_TYPE;
  void _artifactType;
});
