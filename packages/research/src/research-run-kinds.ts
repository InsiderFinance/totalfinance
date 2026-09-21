/**
 * Internal (not an entrypoint): the research run-kind table — one row per FC3 operation the
 * `@totalfinance/research/artifacts` verbs describe, save, replay, and compare (Stage 4.5 Decision 4).
 *
 * A row names the direct operation to re-issue, the bulk row sets its input carries (each may be
 * embedded verbatim or referenced by table handle), the caller-callback fields that make a run
 * non-replayable, the result's closed top-level keys, the identity members a comparison reports
 * (`universe`, `asOf`, `filter` / `rankBy` / `components`), and the accessors the typed comparison
 * sections read — membership, ranks, scores, exclusion reasons, coefficients, abnormal returns,
 * per-quantile and per-horizon values. Nothing here computes: the operation is the engine, the row
 * is its description. `RESEARCH_RUN_KINDS` is the frozen data projection of the table.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import {
  aggregateEventStudies,
  eventStudy,
  type AggregateEventStudiesInput,
  type AggregateEventStudiesResult,
  type AverageAbnormalReturnRow,
  type EventStudyInput,
  type EventStudyResult,
} from './events.js';
import {
  compositeFactorScore,
  factorDecay,
  factorSpreadReturn,
  factorTurnover,
  formQuantilePortfolios,
  informationCoefficient,
  type CompositeFactorScoreInput,
  type CompositeFactorScoreResult,
  type FactorDecayInput,
  type FactorDecayResult,
  type FactorSpreadReturnInput,
  type FactorSpreadReturnResult,
  type FactorTurnoverInput,
  type FactorTurnoverResult,
  type FormQuantilePortfoliosInput,
  type FormQuantilePortfoliosResult,
  type InformationCoefficientInput,
  type InformationCoefficientResult,
} from './factors.js';
import {
  rankUniverse,
  scoreUniverse,
  screenUniverse,
  type RankUniverseInput,
  type RankUniverseResult,
  type ScoreUniverseInput,
  type ScoreUniverseResult,
  type ScreenUniverseInput,
  type ScreenUniverseResult,
} from './screening.js';

export type ResearchRunKind =
  | 'screen'
  | 'rank'
  | 'score'
  | 'event-study'
  | 'aggregate-event-studies'
  | 'information-coefficient'
  | 'factor-spread-return'
  | 'factor-turnover'
  | 'factor-decay'
  | 'quantile-portfolios'
  | 'composite-factor-score';

export interface ResearchRunInputs {
  screen: ScreenUniverseInput;
  rank: RankUniverseInput;
  score: ScoreUniverseInput;
  'event-study': EventStudyInput;
  'aggregate-event-studies': AggregateEventStudiesInput;
  'information-coefficient': InformationCoefficientInput;
  'factor-spread-return': FactorSpreadReturnInput;
  'factor-turnover': FactorTurnoverInput;
  'factor-decay': FactorDecayInput;
  'quantile-portfolios': FormQuantilePortfoliosInput;
  'composite-factor-score': CompositeFactorScoreInput;
}

export interface ResearchRunResults {
  screen: ScreenUniverseResult;
  rank: RankUniverseResult;
  score: ScoreUniverseResult;
  'event-study': EventStudyResult;
  'aggregate-event-studies': AggregateEventStudiesResult;
  'information-coefficient': InformationCoefficientResult;
  'factor-spread-return': FactorSpreadReturnResult;
  'factor-turnover': FactorTurnoverResult;
  'factor-decay': FactorDecayResult;
  'quantile-portfolios': FormQuantilePortfoliosResult;
  'composite-factor-score': CompositeFactorScoreResult;
}

export type InputOf<K extends ResearchRunKind> = ResearchRunInputs[K];
export type RunOf<K extends ResearchRunKind> = ResearchRunResults[K];

export type ResearchRunCostClass =
  | 'scan'
  | 'sort'
  | 'statistic'
  | 'event-alignment'
  | 'aggregation';

/** The frozen, data-only description of one run kind — the research twin of `FITTED_MODEL_FAMILIES`. */
export interface ResearchRunKindDescriptor {
  kind: ResearchRunKind;
  runVersion: number;
  /** The direct operation the run re-issues on replay. */
  operation: string;
  /** Bulk row-set patterns in the input (`[]` spans an array: `horizons[].forwardReturns`). */
  bulkRowSets: readonly string[];
  /** Input fields that, when they carry a caller function, make the run non-replayable. */
  callbackFields: readonly string[];
  /** Every kind replays from its stored input as long as no callback participated. */
  replayableWithoutCallbacks: boolean;
  costClass: ResearchRunCostClass;
  requiredData: string;
}

/** One bulk row-set pattern: segments, where `'*'` spans every element of an array. */
export interface RowSetPattern {
  readonly pattern: string;
  readonly segments: readonly string[];
}

/** A caller-callback field: present ⇒ the run is not replayable; the stored input omits the function. */
export interface CallbackFieldSpec {
  /** The dotted field recorded as `assumptions.nonReplayableField`. */
  readonly field: string;
  readonly isPresent: (input: Record<string, unknown>) => boolean;
  /** The function value at the field, for the type check (a present callback must be a function). */
  readonly read: (input: Record<string, unknown>) => unknown;
  /** The stored form of the input: the function removed, the discriminator kept. */
  readonly strip: (input: Record<string, unknown>) => Record<string, unknown>;
}

/** The identity members every comparison reports (`null` where the kind carries none). */
export interface RunIdentity {
  universe: string | null;
  asOf: number | null;
  filter: unknown;
  rankBy: unknown;
  components: unknown;
}

export interface KeyedValue<Key> {
  key: Key;
  value: number | null;
}

export interface KindSpec<K extends ResearchRunKind> {
  readonly descriptor: ResearchRunKindDescriptor;
  readonly run: (input: InputOf<K>) => RunOf<K>;
  readonly rowSets: readonly RowSetPattern[];
  readonly callbacks: readonly CallbackFieldSpec[];
  /** The result's top-level keys (closed) and which of them the operation may omit. */
  readonly runKeys: readonly string[];
  readonly optionalRunKeys: readonly string[];
  /** Assumption members the operation always reports — what tells a screen result from a rank result. */
  readonly requiredAssumptionKeys: readonly string[];
  readonly identity: (input: Record<string, unknown>) => RunIdentity;
  readonly members: ((run: RunOf<K>) => readonly string[]) | null;
  readonly ranks: ((run: RunOf<K>) => ReadonlyMap<string, number>) | null;
  readonly scores: ((run: RunOf<K>) => ReadonlyMap<string, number>) | null;
  readonly exclusionReasons: ((run: RunOf<K>) => Readonly<Record<string, number>>) | null;
  readonly coefficients: ((run: RunOf<K>) => Readonly<Record<string, number | null>>) | null;
  readonly abnormalReturns: ((run: RunOf<K>) => readonly AverageAbnormalReturnRow[]) | null;
  readonly quantiles: ((run: RunOf<K>) => readonly KeyedValue<number>[]) | null;
  readonly horizons: ((run: RunOf<K>) => readonly KeyedValue<string>[]) | null;
  readonly portfolios:
    | ((run: RunOf<K>) => readonly { quantileIndex: number; instrumentIds: readonly string[] }[])
    | null;
}

// ────────────────────────────────────────── shared pieces ──────────────────────────────────────────

const pattern = (text: string): RowSetPattern => ({
  pattern: text,
  segments: text
    .split('.')
    .flatMap((segment) => (segment.endsWith('[]') ? [segment.slice(0, -2), '*'] : [segment])),
});

const noIdentity = (): RunIdentity => ({
  universe: null,
  asOf: null,
  filter: null,
  rankBy: null,
  components: null,
});

const universeIdentity = (input: Record<string, unknown>): RunIdentity => ({
  universe: typeof input['universeId'] === 'string' ? input['universeId'] : null,
  asOf: typeof input['asOf'] === 'number' ? input['asOf'] : null,
  filter: null,
  rankBy: null,
  components: null,
});

const scoreDeltaMap = (
  rows: readonly { instrumentId: string; score: number }[],
): ReadonlyMap<string, number> => new Map(rows.map((row) => [row.instrumentId, row.score]));

const PREDICATE_CALLBACK: CallbackFieldSpec = {
  field: 'customPredicate',
  isPresent: (input) => input['customPredicate'] !== undefined,
  read: (input) => input['customPredicate'],
  strip: (input) => {
    const { customPredicate: _dropped, ...rest } = input;
    return rest;
  },
};

const EXPECTED_RETURN_CALLBACK: CallbackFieldSpec = {
  field: 'expectedReturnModel.expectedReturn',
  isPresent: (input) => {
    const model = input['expectedReturnModel'];
    return (
      model !== null &&
      typeof model === 'object' &&
      (model as { model?: unknown }).model === 'custom'
    );
  },
  read: (input) => (input['expectedReturnModel'] as { expectedReturn?: unknown }).expectedReturn,
  strip: (input) => ({ ...input, expectedReturnModel: { model: 'custom' } }),
};

const universeSpec = <K extends 'screen' | 'rank' | 'score'>(
  kind: K,
  operation: string,
  run: KindSpec<K>['run'],
  costClass: ResearchRunCostClass,
  requiredData: string,
  extra: Partial<KindSpec<K>>,
): KindSpec<K> => ({
  descriptor: Object.freeze({
    kind,
    runVersion: 1,
    operation,
    bulkRowSets: Object.freeze(['observations']),
    callbackFields: Object.freeze(kind === 'screen' ? ['customPredicate'] : []),
    replayableWithoutCallbacks: true,
    costClass,
    requiredData,
  }),
  run,
  rowSets: [pattern('observations')],
  callbacks: kind === 'screen' ? [PREDICATE_CALLBACK] : [],
  runKeys: ['assumptions', 'diagnostics', 'rows'],
  optionalRunKeys: [],
  requiredAssumptionKeys: [
    'universeId',
    'asOf',
    'missingValuePolicy',
    'finalTieBreaker',
    'versionResolution',
    ...(kind === 'screen'
      ? ['orderBy']
      : kind === 'rank'
        ? ['rankBy', 'tiePolicy']
        : ['components']),
  ],
  identity: universeIdentity,
  members: (run) =>
    (run as { rows: readonly { instrumentId: string }[] }).rows.map((row) => row.instrumentId),
  ranks: null,
  scores: null,
  exclusionReasons: (run) =>
    (run as { diagnostics: { exclusionReasons: Record<string, number> } }).diagnostics
      .exclusionReasons,
  coefficients: null,
  abnormalReturns: null,
  quantiles: null,
  horizons: null,
  portfolios: null,
  ...extra,
});

// ─────────────────────────────────────────── the table ──────────────────────────────────────────────

const SCREEN: KindSpec<'screen'> = universeSpec(
  'screen',
  'screenUniverse',
  screenUniverse,
  'scan',
  'point-in-time universe observations with declared field definitions; a serializable filter',
  {
    identity: (input) => ({ ...universeIdentity(input), filter: input['filter'] ?? null }),
  },
);

const RANK: KindSpec<'rank'> = universeSpec(
  'rank',
  'rankUniverse',
  rankUniverse,
  'sort',
  'point-in-time universe observations with declared field definitions; one ranking field',
  {
    identity: (input) => ({ ...universeIdentity(input), rankBy: input['rankBy'] ?? null }),
    ranks: (run) => new Map(run.rows.map((row) => [row.instrumentId, row.rank])),
  },
);

const SCORE: KindSpec<'score'> = universeSpec(
  'score',
  'scoreUniverse',
  scoreUniverse,
  'statistic',
  'point-in-time universe observations with declared field definitions; weighted score components',
  {
    identity: (input) => ({
      ...universeIdentity(input),
      components: input['components'] ?? null,
    }),
    scores: (run) => scoreDeltaMap(run.rows),
  },
);

const EVENT_STUDY: KindSpec<'event-study'> = {
  descriptor: Object.freeze({
    kind: 'event-study',
    runVersion: 1,
    operation: 'eventStudy',
    bulkRowSets: Object.freeze(['events', 'returnObservations', 'marketReturns']),
    callbackFields: Object.freeze(['expectedReturnModel.expectedReturn']),
    replayableWithoutCallbacks: true,
    costClass: 'event-alignment',
    requiredData:
      'market events, per-instrument session returns, market returns for the market models; event and estimation windows in trading sessions',
  }),
  run: eventStudy,
  rowSets: [pattern('events'), pattern('returnObservations'), pattern('marketReturns')],
  callbacks: [EXPECTED_RETURN_CALLBACK],
  runKeys: ['assumptions', 'diagnostics', 'events', 'averageAbnormalReturns'],
  optionalRunKeys: [],
  requiredAssumptionKeys: [
    'sessionPolicy',
    'cumulativeConvention',
    'expectedReturnModel',
    'eventWindow',
    'overlappingEventPolicy',
  ],
  identity: noIdentity,
  members: (run) => run.events.map((event) => event.eventId),
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: null,
  abnormalReturns: (run) => run.averageAbnormalReturns,
  quantiles: null,
  horizons: null,
  portfolios: null,
};

const AGGREGATE_EVENT_STUDIES: KindSpec<'aggregate-event-studies'> = {
  descriptor: Object.freeze({
    kind: 'aggregate-event-studies',
    runVersion: 1,
    operation: 'aggregateEventStudies',
    bulkRowSets: Object.freeze(['studies']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'aggregation',
    requiredData: 'prior eventStudy results under one convention (each study is one row)',
  }),
  run: aggregateEventStudies,
  rowSets: [pattern('studies')],
  callbacks: [],
  runKeys: ['assumptions', 'diagnostics', 'events', 'averageAbnormalReturns', 'studiesAggregated'],
  optionalRunKeys: [],
  requiredAssumptionKeys: [
    'sessionPolicy',
    'cumulativeConvention',
    'expectedReturnModel',
    'eventWindow',
    'overlappingEventPolicy',
  ],
  identity: noIdentity,
  members: (run) => run.events.map((event) => event.eventId),
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: null,
  abnormalReturns: (run) => run.averageAbnormalReturns,
  quantiles: null,
  horizons: null,
  portfolios: null,
};

const INFORMATION_COEFFICIENT: KindSpec<'information-coefficient'> = {
  descriptor: Object.freeze({
    kind: 'information-coefficient',
    runVersion: 1,
    operation: 'informationCoefficient',
    bulkRowSets: Object.freeze(['factorEntries', 'forwardReturns']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'statistic',
    requiredData: 'factor entries and forward-return entries keyed by instrument',
  }),
  run: informationCoefficient,
  rowSets: [pattern('factorEntries'), pattern('forwardReturns')],
  callbacks: [],
  runKeys: [
    'assumptions',
    'diagnostics',
    'informationCoefficient',
    'rankInformationCoefficient',
    'reason',
  ],
  optionalRunKeys: ['reason'],
  requiredAssumptionKeys: ['pearsonBasis', 'rankBasis', 'minimumCoverageFraction'],
  identity: noIdentity,
  members: null,
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: (run) => ({
    informationCoefficient: run.informationCoefficient,
    rankInformationCoefficient: run.rankInformationCoefficient,
  }),
  abnormalReturns: null,
  quantiles: null,
  horizons: null,
  portfolios: null,
};

const FACTOR_SPREAD_RETURN: KindSpec<'factor-spread-return'> = {
  descriptor: Object.freeze({
    kind: 'factor-spread-return',
    runVersion: 1,
    operation: 'factorSpreadReturn',
    bulkRowSets: Object.freeze(['entries', 'forwardReturns']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'statistic',
    requiredData:
      'factor entries and forward-return entries keyed by instrument; quantile count and direction',
  }),
  run: factorSpreadReturn,
  rowSets: [pattern('entries'), pattern('forwardReturns')],
  callbacks: [],
  runKeys: [
    'assumptions',
    'diagnostics',
    'spreadReturn',
    'longLegMeanReturn',
    'shortLegMeanReturn',
    'reason',
  ],
  optionalRunKeys: ['reason'],
  requiredAssumptionKeys: ['quantileCount', 'direction', 'legWeighting'],
  identity: noIdentity,
  members: null,
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: (run) => ({
    spreadReturn: run.spreadReturn,
    longLegMeanReturn: run.longLegMeanReturn,
    shortLegMeanReturn: run.shortLegMeanReturn,
  }),
  abnormalReturns: null,
  quantiles: null,
  horizons: null,
  portfolios: null,
};

const FACTOR_TURNOVER: KindSpec<'factor-turnover'> = {
  descriptor: Object.freeze({
    kind: 'factor-turnover',
    runVersion: 1,
    operation: 'factorTurnover',
    bulkRowSets: Object.freeze(['previousPortfolios', 'currentPortfolios']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'statistic',
    requiredData: 'two quantile-portfolio results (each portfolio is one row)',
  }),
  run: factorTurnover,
  rowSets: [pattern('previousPortfolios'), pattern('currentPortfolios')],
  callbacks: [],
  runKeys: ['assumptions', 'diagnostics', 'byQuantile'],
  optionalRunKeys: [],
  requiredAssumptionKeys: ['definition'],
  identity: noIdentity,
  members: null,
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: null,
  abnormalReturns: null,
  quantiles: (run) =>
    run.byQuantile.map((row) => ({ key: row.quantileIndex, value: row.turnover })),
  horizons: null,
  portfolios: null,
};

const FACTOR_DECAY: KindSpec<'factor-decay'> = {
  descriptor: Object.freeze({
    kind: 'factor-decay',
    runVersion: 1,
    operation: 'factorDecay',
    bulkRowSets: Object.freeze(['factorEntries', 'horizons[].forwardReturns']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'statistic',
    requiredData: 'factor entries and labelled forward-return horizons keyed by instrument',
  }),
  run: factorDecay,
  rowSets: [pattern('factorEntries'), pattern('horizons[].forwardReturns')],
  callbacks: [],
  runKeys: ['assumptions', 'diagnostics', 'byHorizon'],
  optionalRunKeys: [],
  requiredAssumptionKeys: ['coefficient', 'minimumCoverageFraction'],
  identity: noIdentity,
  members: null,
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: null,
  abnormalReturns: null,
  quantiles: null,
  horizons: (run) =>
    run.byHorizon.map((row) => ({ key: row.horizonLabel, value: row.rankInformationCoefficient })),
  portfolios: null,
};

const QUANTILE_PORTFOLIOS: KindSpec<'quantile-portfolios'> = {
  descriptor: Object.freeze({
    kind: 'quantile-portfolios',
    runVersion: 1,
    operation: 'formQuantilePortfolios',
    bulkRowSets: Object.freeze(['entries']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'sort',
    requiredData: 'factor entries keyed by instrument; quantile count and direction',
  }),
  run: formQuantilePortfolios,
  rowSets: [pattern('entries')],
  callbacks: [],
  runKeys: ['assumptions', 'diagnostics', 'portfolios'],
  optionalRunKeys: [],
  requiredAssumptionKeys: ['quantileCount', 'direction', 'tieBreaker', 'sizing'],
  identity: noIdentity,
  members: (run) => run.portfolios.flatMap((portfolio) => portfolio.instrumentIds),
  ranks: null,
  scores: null,
  exclusionReasons: null,
  coefficients: null,
  abnormalReturns: null,
  quantiles: null,
  horizons: null,
  portfolios: (run) => run.portfolios,
};

const COMPOSITE_FACTOR_SCORE: KindSpec<'composite-factor-score'> = {
  descriptor: Object.freeze({
    kind: 'composite-factor-score',
    runVersion: 1,
    operation: 'compositeFactorScore',
    bulkRowSets: Object.freeze(['components[].entries']),
    callbackFields: Object.freeze([]),
    replayableWithoutCallbacks: true,
    costClass: 'statistic',
    requiredData: 'labelled, weighted, directed factor components with their entries',
  }),
  run: compositeFactorScore,
  rowSets: [pattern('components[].entries')],
  callbacks: [],
  runKeys: ['assumptions', 'diagnostics', 'entries'],
  optionalRunKeys: [],
  requiredAssumptionKeys: ['components', 'missingValuePolicy'],
  identity: (input) => ({
    ...noIdentity(),
    components: Array.isArray(input['components'])
      ? (input['components'] as Record<string, unknown>[]).map((component) => ({
          label: component['label'],
          weight: component['weight'],
          direction: component['direction'],
        }))
      : null,
  }),
  members: (run) => run.entries.map((entry) => entry.instrumentId),
  ranks: null,
  scores: (run) =>
    new Map(
      run.entries.flatMap((entry) =>
        entry.value === null ? [] : [[entry.instrumentId, entry.value] as [string, number]],
      ),
    ),
  exclusionReasons: (run) => run.diagnostics.exclusionReasons,
  coefficients: null,
  abnormalReturns: null,
  quantiles: null,
  horizons: null,
  portfolios: null,
};

export const KIND_SPECS: { readonly [K in ResearchRunKind]: KindSpec<K> } = {
  screen: SCREEN,
  rank: RANK,
  score: SCORE,
  'event-study': EVENT_STUDY,
  'aggregate-event-studies': AGGREGATE_EVENT_STUDIES,
  'information-coefficient': INFORMATION_COEFFICIENT,
  'factor-spread-return': FACTOR_SPREAD_RETURN,
  'factor-turnover': FACTOR_TURNOVER,
  'factor-decay': FACTOR_DECAY,
  'quantile-portfolios': QUANTILE_PORTFOLIOS,
  'composite-factor-score': COMPOSITE_FACTOR_SCORE,
};

export const RESEARCH_RUN_KIND_LIST: readonly ResearchRunKind[] = Object.freeze([
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
]);

/** The frozen descriptor per run kind — Program 5's registry metadata without a registry. */
export const RESEARCH_RUN_KINDS: Readonly<Record<ResearchRunKind, ResearchRunKindDescriptor>> =
  Object.freeze(
    Object.fromEntries(
      RESEARCH_RUN_KIND_LIST.map((kind) => [kind, KIND_SPECS[kind].descriptor]),
    ) as Record<ResearchRunKind, ResearchRunKindDescriptor>,
  );

// ─────────────────────────────────────── row-set resolution ──────────────────────────────────────

/** One resolved bulk row set in a concrete input: its label (`horizons[0].forwardReturns`) and path. */
export interface ResolvedRowSet {
  readonly label: string;
  readonly path: readonly string[];
  readonly rows: unknown;
}

export function readPath(record: unknown, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A structurally shared copy with `value` at `path` (arrays stay arrays). */
export function withPath(record: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(record)) {
    const copy = record.slice();
    copy[Number(head)] = withPath(record[Number(head)], rest, value);
    return copy;
  }
  const source = (record ?? {}) as Record<string, unknown>;
  return { ...source, [head]: withPath(source[head], rest, value) };
}

/** Parse a concrete label back to its path: `horizons[0].forwardReturns` → `['horizons', '0', 'forwardReturns']`. */
export function pathOfLabel(label: string): string[] {
  return label.split('.').flatMap((segment) => {
    const match = /^([^[\]]+)\[(\d+)\]$/.exec(segment);
    return match ? [match[1]!, match[2]!] : [segment];
  });
}

/**
 * Resolve every bulk row set a kind declares against one concrete input. An optional row set that
 * is absent resolves to nothing; a wildcard whose container is not an array is a shape error the
 * direct operation would refuse — reported here with the same code.
 */
export function resolveRowSets(
  functionName: string,
  spec: KindSpec<ResearchRunKind>,
  input: Record<string, unknown>,
): ResolvedRowSet[] {
  const resolved: ResolvedRowSet[] = [];
  const walk = (
    segments: readonly string[],
    path: readonly string[],
    label: string,
    current: unknown,
  ): void => {
    if (segments.length === 0) {
      if (current === undefined) return;
      resolved.push({ label, path, rows: current });
      return;
    }
    const [segment, ...rest] = segments as [string, ...string[]];
    if (segment === '*') {
      if (current === undefined) return;
      if (!Array.isArray(current)) {
        throw new InputError(
          `${functionName}: input.${label} must be an array (each element carries a '${rest.join('.')}' row set). Received ${current === null ? 'null' : typeof current}.`,
          { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
        );
      }
      current.forEach((element, index) =>
        walk(rest, [...path, String(index)], `${label}[${index}]`, element),
      );
      return;
    }
    const next =
      current !== null && typeof current === 'object'
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    walk(rest, [...path, segment], label.length === 0 ? segment : `${label}.${segment}`, next);
  };
  for (const rowSet of spec.rowSets) walk(rowSet.segments, [], '', input);
  return resolved;
}
