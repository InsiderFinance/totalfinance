/**
 * Gate B ⇄ the library's REAL Law-2 report grammar, proven with real reports — not synthetic
 * fixtures. The artifact spine promises "save any Law-2 result verbatim", and the TRUE Law-2 floor
 * is `assumptions` (a plain object) + `diagnostics.warnings` (an array): many real reports state
 * their assumptions WITHOUT an `assumptions.conventionsVersion` field. This bridge saves three of
 * them — a `discountedCashFlow` valuation, an `eventStudy`, and a `timeWeightedReturn` — then
 * round-trips each through canonical JSON, re-reads it, and verifies the id. If the artifact floor
 * ever drifts above what real reports carry (the defect this file pins), saving stops here.
 *
 * The artifact's top-level `conventionsVersion` is LIBRARY-STAMPED from core's
 * `CONVENTIONS_VERSION` (the market snapshot's law) — never an echo of the result.
 */

import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION } from '@totalfinance/core';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import { timeWeightedReturn } from '@totalfinance/performance';
import { eventStudy } from '@totalfinance/research';
import { discountedCashFlow } from '@totalfinance/valuation';

/** Save a real report, round-trip the artifact through canonical JSON, and verify its id. */
function saveAndRestore(input: {
  artifactType: string;
  operation: string;
  parameters: unknown;
  result: Record<string, unknown>;
}) {
  const artifact = createAnalysisArtifact({
    artifactType: input.artifactType,
    producedBy: { operation: input.operation },
    inputs: { parameters: input.parameters },
    result: input.result,
  });
  // Byte-honesty: the canonical serializer is the persistence format, and reading verifies the id.
  const { artifact: restored, migrationsApplied } = readAnalysisArtifact({
    artifact: fromCanonicalJson(canonicalJsonOf(artifact)),
  });
  expect(migrationsApplied).toEqual([]);
  expect(restored).toEqual(artifact);
  expect(restored.id).toBe(artifact.id);
  expect(restored.conventionsVersion).toBe(CONVENTIONS_VERSION);
  // Saving is the IDENTITY on the result — verbatim, byte-for-byte through the round trip.
  expect(restored.result).toEqual(input.result);
  return restored;
}

describe('the artifact spine saves REAL Law-2 reports verbatim', () => {
  it('saves a discountedCashFlow valuation report (@totalfinance/valuation)', () => {
    const parameters = {
      valuationBasis: 'firm',
      valuationDate: '2026-12-31',
      currency: 'USD',
      projectedCashFlows: [
        { timeYears: 1, amount: 120 },
        { timeYears: 2, amount: 135 },
      ],
      annualDiscountRate: 0.09,
      compounding: 'annual',
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 135,
        perpetualGrowthRate: 0.025,
      },
    } as const;
    const report = discountedCashFlow(parameters);
    // The real report's Law-2 shape: assumptions + warnings, with NO conventionsVersion inside.
    expect(report.assumptions.contractVersion).toBe(1);
    expect('conventionsVersion' in report.assumptions).toBe(false);
    expect(Array.isArray(report.diagnostics.warnings)).toBe(true);

    const restored = saveAndRestore({
      artifactType: 'valuation.discounted-cash-flow',
      operation: 'discountedCashFlow',
      parameters,
      result: report as unknown as Record<string, unknown>,
    });
    const assumptions = restored.result['assumptions'] as Record<string, unknown>;
    expect(assumptions['discountRateSource']).toBe('user-supplied');
  });

  it('saves an eventStudy report (@totalfinance/research)', () => {
    const dates = Array.from({ length: 14 }, (_, i) => `2024-03-${String(i + 1).padStart(2, '0')}`);
    const returns = [
      0.01, 0.02, -0.01, 0.005, 0.015, -0.005, 0.0, 0.01, 0.02, -0.02, 0.03, 0.01, -0.01, 0.005,
    ];
    const parameters = {
      events: [
        {
          eventId: 'E1',
          instrumentId: 'AAA',
          eventType: 'earnings',
          announcedTimestampMs: Date.UTC(2024, 2, 7, 15, 0, 0),
        },
      ],
      returnObservations: dates.map((tradingSessionDate, i) => ({
        instrumentId: 'AAA',
        tradingSessionDate,
        simpleReturn: returns[i]!,
      })),
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      estimationWindow: { startTradingSessionOffset: -5, endTradingSessionOffset: -2 },
      expectedReturnModel: { model: 'mean-adjusted' },
      overlappingEventPolicy: 'reject',
    } as const;
    const report = eventStudy(parameters);
    expect('conventionsVersion' in report.assumptions).toBe(false);
    expect(Array.isArray(report.diagnostics.warnings)).toBe(true);

    const restored = saveAndRestore({
      artifactType: 'research.event-study',
      operation: 'eventStudy',
      parameters,
      result: report as unknown as Record<string, unknown>,
    });
    const events = restored.result['events'] as unknown[];
    expect(events).toHaveLength(1);
  });

  it('saves a timeWeightedReturn report (@totalfinance/performance)', () => {
    const parameters = {
      valuations: [
        { valuationDate: '2026-01-01', netAssetValue: 100 },
        { valuationDate: '2026-03-31', netAssetValue: 110 },
        { valuationDate: '2026-06-30', netAssetValue: 135 },
      ],
      externalCashFlows: [{ cashFlowDate: '2026-03-31', amount: 20 }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    } as const;
    const report = timeWeightedReturn(parameters);
    expect('conventionsVersion' in report.assumptions).toBe(false);
    expect(Array.isArray(report.diagnostics.warnings)).toBe(true);
    expect(report.timeWeightedReturn).not.toBeNull();

    const restored = saveAndRestore({
      artifactType: 'performance.time-weighted-return',
      operation: 'timeWeightedReturn',
      parameters,
      result: report as unknown as Record<string, unknown>,
    });
    expect(restored.result['timeWeightedReturn']).toBe(report.timeWeightedReturn);
  });
});
