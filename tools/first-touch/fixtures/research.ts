/**
 * FC3 — first-touch fixtures for `@totalfinance/research`: the multi-arg vendor-adapter guards and
 * every analysis-role export. Thunks build FRESH inputs per call; probes mutate what they are
 * given.
 */

import { eventStudy } from '@totalfinance/research';
import type { EventStudyInput } from '@totalfinance/research';
import { type FixtureThunk } from '../inputs.js';

const AS_OF = Date.UTC(2026, 7, 12, 20);
const AVAILABLE = Date.UTC(2026, 7, 1);

const fieldDefinitions = (): unknown[] => [
  { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'sector', kind: 'category' },
];

const observations = (): unknown[] => [
  {
    instrumentId: 'AAA',
    availableTimestampMs: AVAILABLE,
    fields: { returnOnInvestedCapital: 0.22, freeCashFlowYield: 0.06, sector: 'tech' },
  },
  {
    instrumentId: 'BBB',
    availableTimestampMs: AVAILABLE,
    fields: { returnOnInvestedCapital: 0.12, freeCashFlowYield: 0.08, sector: 'tech' },
  },
  {
    instrumentId: 'CCC',
    availableTimestampMs: AVAILABLE,
    fields: { returnOnInvestedCapital: 0.18, freeCashFlowYield: 0.04, sector: 'energy' },
  },
  {
    instrumentId: 'DDD',
    availableTimestampMs: AVAILABLE,
    fields: { returnOnInvestedCapital: 0.09, freeCashFlowYield: 0.02, sector: 'energy' },
  },
];

const factorEntries = (): unknown[] => [
  { instrumentId: 'AAA', value: 4 },
  { instrumentId: 'BBB', value: 3 },
  { instrumentId: 'CCC', value: 2 },
  { instrumentId: 'DDD', value: 1 },
];

const forwardReturns = (): unknown[] => [
  { instrumentId: 'AAA', value: 0.04 },
  { instrumentId: 'BBB', value: 0.03 },
  { instrumentId: 'CCC', value: 0.01 },
  { instrumentId: 'DDD', value: -0.01 },
];

/** A definitions Map, built the way the guards consume it. */
const definitionsMap = (): Map<string, unknown> =>
  new Map(
    (fieldDefinitions() as Array<{ fieldName: string }>).map((definition) => [
      definition.fieldName,
      definition,
    ]),
  );

const SESSION_DATES = Array.from(
  { length: 12 },
  (_, index) => `2026-06-${String(index + 8).padStart(2, '0')}`,
);

const returnObservations = (): unknown[] =>
  SESSION_DATES.flatMap((tradingSessionDate, index) => [
    { instrumentId: 'AAA', tradingSessionDate, simpleReturn: 0.001 + 0.0005 * index },
    { instrumentId: 'BBB', tradingSessionDate, simpleReturn: 0.002 - 0.0003 * index },
  ]);

const marketReturns = (): unknown[] =>
  SESSION_DATES.map((tradingSessionDate) => ({ tradingSessionDate, simpleReturn: 0.001 }));

const events = (): unknown[] => [
  {
    eventId: 'event-1',
    instrumentId: 'AAA',
    eventType: 'earnings',
    announcedTimestampMs: Date.UTC(2026, 5, 15, 21),
  },
];

const eventStudyInput = (): Record<string, unknown> => ({
  events: events(),
  returnObservations: returnObservations(),
  marketReturns: marketReturns(),
  eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 2 },
  estimationWindow: { startTradingSessionOffset: -7, endTradingSessionOffset: -2 },
  expectedReturnModel: { model: 'market' },
  overlappingEventPolicy: 'reject',
});

/** Stage 4.6 slice 1 (2026-09-03): a universe history with an addition, a removal, and a delisting. */
function universeHistory(): Record<string, unknown> {
  const T0 = Date.UTC(2026, 0, 5, 21);
  const DAY = 86_400_000;
  return {
    universeId: 'fixture-universe',
    members: [
      { instrumentId: 'AAA', fromTimestampMs: T0 },
      {
        instrumentId: 'BBB',
        fromTimestampMs: T0,
        toTimestampMs: T0 + 10 * DAY,
        exitReason: 'removed',
      },
      {
        instrumentId: 'CCC',
        fromTimestampMs: T0 + 5 * DAY,
        toTimestampMs: T0 + 20 * DAY,
        exitReason: 'delisted',
        delistingReturn: -0.35,
      },
    ],
  };
}

export const RESEARCH_FIXTURES: Record<string, FixtureThunk> = {
  'research.requireUniverseHistory': () => ['fixture', 'history', universeHistory()],
  'research.universeMembershipAt': () => [
    {
      universeHistory: universeHistory(),
      asOf: Date.UTC(2026, 0, 25, 21),
      previousAsOf: Date.UTC(2026, 0, 12, 21),
    },
  ],
  'research.eligibleObservationsAt': () => [
    {
      observations: [
        {
          instrumentId: 'AAA',
          availableTimestampMs: Date.UTC(2026, 0, 6, 21),
          fields: { score: 1 },
        },
        {
          instrumentId: 'BBB',
          availableTimestampMs: Date.UTC(2026, 0, 6, 21),
          fields: { score: 2 },
        },
      ],
      fieldDefinitions: [{ fieldName: 'score', kind: 'numeric' }],
      asOf: Date.UTC(2026, 0, 12, 21),
      universeHistory: universeHistory(),
    },
  ],
  // Multi-arg vendor-adapter guards.
  'research.requireFieldDefinitions': () => ['deepSweepProbe', fieldDefinitions()],
  'research.requireUniverseObservation': () => [
    'deepSweepProbe',
    'observation',
    (observations() as unknown[])[0],
    definitionsMap(),
  ],
  'research.requireUniverseObservations': () => [
    'deepSweepProbe',
    observations(),
    definitionsMap(),
  ],
  'research.requireMarketEvent': () => [
    'deepSweepProbe',
    'event',
    {
      eventId: 'event-1',
      instrumentId: 'AAA',
      eventType: 'earnings',
      announcedTimestampMs: Date.UTC(2026, 5, 10, 21),
    },
  ],
  'research.requireReturnObservations': () => [
    'deepSweepProbe',
    'returnObservations',
    [{ instrumentId: 'AAA', tradingSessionDate: '2026-06-10', simpleReturn: 0.01 }],
  ],
  'research.requireDefinitionsMap': () => ['deepSweepProbe', definitionsMap()],
  'research.requireScreenFilter': () => [
    'deepSweepProbe',
    'filter',
    { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.03 },
    definitionsMap(),
  ],

  // Analysis exports.
  'research.screenUniverse': () => [
    {
      universeId: 'fixture-universe',
      asOf: AS_OF,
      observations: observations(),
      fieldDefinitions: fieldDefinitions(),
      filter: { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.1 },
      missingValuePolicy: 'exclude',
      orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
      limit: 2,
    },
  ],
  'research.rankUniverse': () => [
    {
      universeId: 'fixture-universe',
      asOf: AS_OF,
      observations: observations(),
      fieldDefinitions: fieldDefinitions(),
      rankBy: { field: 'freeCashFlowYield', direction: 'descending' },
      tiePolicy: 'competition',
      missingValuePolicy: 'exclude',
    },
  ],
  'research.scoreUniverse': () => [
    {
      universeId: 'fixture-universe',
      asOf: AS_OF,
      observations: observations(),
      fieldDefinitions: fieldDefinitions(),
      components: [
        {
          field: 'returnOnInvestedCapital',
          weight: 1,
          direction: 'higher-is-better',
          standardization: 'z-score',
        },
      ],
      missingValuePolicy: 'exclude',
    },
  ],
  'research.winsorizeFactor': () => [
    {
      entries: factorEntries(),
      method: { type: 'percentile', lowerPercentile: 0.25, upperPercentile: 0.75 },
    },
  ],
  'research.standardizeFactor': () => [{ entries: factorEntries(), method: 'z-score' }],
  'research.neutralizeFactor': () => [
    {
      entries: factorEntries(),
      groups: [
        { instrumentId: 'AAA', group: 'tech' },
        { instrumentId: 'BBB', group: 'tech' },
        { instrumentId: 'CCC', group: 'energy' },
        { instrumentId: 'DDD', group: 'energy' },
      ],
    },
  ],
  'research.compositeFactorScore': () => [
    {
      components: [
        {
          label: 'value',
          entries: factorEntries(),
          weight: 1,
          direction: 'higher-is-better',
        },
      ],
      missingValuePolicy: 'exclude',
    },
  ],
  'research.formQuantilePortfolios': () => [
    { entries: factorEntries(), quantileCount: 2, direction: 'descending' },
  ],
  'research.informationCoefficient': () => [
    { factorEntries: factorEntries(), forwardReturns: forwardReturns() },
  ],
  'research.factorSpreadReturn': () => [
    {
      entries: factorEntries(),
      forwardReturns: forwardReturns(),
      quantileCount: 2,
      direction: 'descending',
    },
  ],
  'research.factorTurnover': () => [
    {
      previousPortfolios: [
        { quantileIndex: 1, instrumentIds: ['AAA', 'BBB'] },
        { quantileIndex: 2, instrumentIds: ['CCC', 'DDD'] },
      ],
      currentPortfolios: [
        { quantileIndex: 1, instrumentIds: ['AAA', 'CCC'] },
        { quantileIndex: 2, instrumentIds: ['BBB', 'DDD'] },
      ],
    },
  ],
  'research.factorDecay': () => [
    {
      factorEntries: factorEntries(),
      horizons: [{ horizonLabel: '1m', forwardReturns: forwardReturns() }],
    },
  ],

  // Event studies.
  'research.eventStudy': () => [eventStudyInput()],
  'research.aggregateEventStudies': () => [
    { studies: [eventStudy(eventStudyInput() as unknown as EventStudyInput)] },
  ],
  'research.alignEventWindows': () => [
    {
      events: events(),
      returnObservations: returnObservations(),
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 2 },
    },
  ],
};
