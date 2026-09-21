/**
 * Stage 4.5 slice 5 — first-touch fixtures for `@totalfinance/research/artifacts`: the four verbs over
 * a screen run (embedded rows) and a referenced-row replay. Thunks build FRESH inputs per call.
 */

import { screenUniverse } from '@totalfinance/research';
import { researchRunArtifact } from '@totalfinance/research/artifacts';
import { type FixtureThunk } from '../inputs.js';

const AS_OF = Date.UTC(2026, 7, 12, 20);
const AVAILABLE = Date.UTC(2026, 7, 1);

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
];

const screenInput = (): Record<string, unknown> => ({
  universeId: 'fixture-universe',
  asOf: AS_OF,
  observations: observations(),
  fieldDefinitions: [
    { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
    { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
    { fieldName: 'sector', kind: 'category' },
  ],
  filter: { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.1 },
  missingValuePolicy: 'exclude',
  orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
  limit: 2,
});

const screenRun = (): unknown => screenUniverse(screenInput() as never);

const artifact = (): unknown =>
  JSON.parse(
    JSON.stringify(
      researchRunArtifact({
        kind: 'screen',
        run: screenRun() as never,
        input: screenInput() as never,
      }),
    ),
  );

export const RESEARCH_ARTIFACTS_FIXTURES: Record<string, FixtureThunk> = {
  'research.researchRunArtifact': () => [
    { kind: 'screen', run: screenRun(), input: screenInput(), libraryVersion: '0.0.1' },
  ],
  'research.readResearchRun': () => [{ artifact: artifact() }],
  'research.replayResearchRun': () => [{ artifact: artifact(), libraryVersion: '0.0.1' }],
  'research.compareResearchRuns': () => [
    { baseline: artifact(), candidate: artifact(), limits: { listedIds: 50 } },
  ],
};
