import { InputError } from '@totalfinance/core';
import {
  sectorPerformance,
  sectorPerformanceSnapshot,
  type SectorPerformanceMember,
} from '@totalfinance/performance/sector-performance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sectorSimpleReturn } from '../src/sector-performance-internal.js';
import { snapshotInput } from './sector-performance-fixtures.js';

function member(securityId: string, periodReturn: number): SectorPerformanceMember {
  return { securityId, sectorId: securityId, sectorName: securityId, periodReturn };
}

/** Exact adjacent double, not a guessed epsilon that may skip the relevant boundary. */
function adjacent({ value, direction }: { value: number; direction: 'up' | 'down' }): number {
  if (value === 0) return direction === 'up' ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const increment = value > 0 === (direction === 'up') ? 1n : -1n;
  view.setBigUint64(0, view.getBigUint64(0) + increment);
  return view.getFloat64(0);
}

/**
 * Independent integer oracle: decompose the actual double as an exact dyadic rational, multiply
 * by the decimal grid using BigInt, and compare the exact remainder to half the denominator.
 * No production helper, toFixed, Math.round, or floating-point multiplication by 1e8 is used.
 */
function exactEightPlaceOracle(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent === 0 ? 0n : 1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  if (power >= 0) return value; // Already an integer, even at MAX_VALUE.
  const denominator = 1n << BigInt(-power);
  const scaled = significand * 100_000_000n;
  const ticks = scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n);
  const digits = ticks.toString().padStart(9, '0');
  // Parse the rounded decimal once; converting ticks to Number before dividing could double-round.
  const magnitude = Number(`${digits.slice(0, -8)}.${digits.slice(-8)}`);
  return magnitude === 0 ? 0 : value < 0 ? -magnitude : magnitude;
}

describe('sector exact rounding policy regressions', () => {
  it('rounds exact dyadic half ties away from zero and distinguishes both adjacent doubles', () => {
    // 1/512 is exactly representable AND exactly halfway between eight-decimal grid points.
    for (const tie of [1 / 512, -1 / 512, 3 / 512, -3 / 512]) {
      const values = [
        adjacent({ value: tie, direction: 'down' }),
        tie,
        adjacent({ value: tie, direction: 'up' }),
      ];
      const report = sectorPerformance({
        members: values.map((value, i) => member(String(i), value)),
      });
      for (const sector of report.sectors) {
        expect(sector.periodReturn).toBe(exactEightPlaceOracle(values[Number(sector.sectorId)]!));
      }
      const roundedTie = report.sectors.find((sector) => sector.sectorId === '1')!.periodReturn;
      expect(roundedTie).toBe(
        tie > 0
          ? tie === 1 / 512
            ? 0.00195313
            : 0.00585938
          : tie === -1 / 512
            ? -0.00195313
            : -0.00585938,
      );
    }
  });

  it('does not mistake an epsilon-nudged near-boundary return for a rank-changing increase', () => {
    const report = sectorPerformance({
      members: [member('a', 10_000_000), member('b', 10_000_000.000000004)],
    });
    expect(
      report.sectors.map(({ sectorId, periodReturn, rank }) => [sectorId, periodReturn, rank]),
    ).toEqual([
      ['a', 10_000_000, 1],
      ['b', 10_000_000, 1],
    ]);
    for (const value of [40_000_000.00000002, 40_000_000.00000003]) {
      expect(sectorPerformance({ members: [member('a', value)] }).sectors[0]!.periodReturn).toBe(
        value,
      );
    }
  });

  it('does not push a below-half double onto a tie by multiplying the decimal grid first', () => {
    const values: number[] = [];
    for (let numerator = 1; numerator < 512; numerator += 2) {
      const tie = numerator / 512;
      for (const value of [tie, -tie])
        values.push(
          adjacent({ value, direction: 'down' }),
          value,
          adjacent({ value, direction: 'up' }),
        );
    }
    const report = sectorPerformance({
      members: values.map((value, i) => member(String(i), value)),
    });
    for (const sector of report.sectors)
      expect(sector.periodReturn).toBe(exactEightPlaceOracle(values[Number(sector.sectorId)]!));
  });

  it('preserves MAX_VALUE and signed-zero/subnormal semantics with finite JSON output', () => {
    const values = [Number.MAX_VALUE, 1e21, Number.MIN_VALUE, -Number.MIN_VALUE, 0, -0, -1];
    const report = sectorPerformance({
      members: values.map((value, i) => member(String(i), value)),
    });
    for (const sector of report.sectors) {
      expect(sector.periodReturn).toBe(exactEightPlaceOracle(values[Number(sector.sectorId)]!));
      expect(Object.is(sector.periodReturn, -0)).toBe(false);
      expect(Object.is(sector.members[0]!.periodReturn, -0)).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.assumptions.rounding).toContain('without an epsilon nudge');
    expect(
      sectorPerformance({
        members: [0, 1, 2].map((i) => ({
          ...member(String(i), Number.MAX_VALUE),
          sectorId: 'same',
          sectorName: 'same',
        })),
      }).sectors[0]!.periodReturn,
    ).toBe(Number.MAX_VALUE);
  });

  it('property: exact integer oracle across the finite simple-return domain', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const report = sectorPerformance({ members: [member('a', value)] });
          expect(report.sectors[0]!.periodReturn).toBe(exactEightPlaceOracle(value));
        },
      ),
      { seed: 3362026, numRuns: 500 },
    );
  });
});

describe('sector stable audit return regressions', () => {
  it('matches independently supplied positive/negative half-tick economics and competition ranks', () => {
    const input = snapshotInput(3);
    const ids = ['positive', 'zero', 'negative'];
    input.classifications = input.classifications.map((row, i) => ({
      ...row,
      sectorId: ids[i]!,
      sectorName: ids[i]!,
    }));
    input.splitAdjustedCloses = input.splitAdjustedCloses.map((row, i) => ({
      ...row,
      splitAdjustedClose:
        row.sessionId === 'previous'
          ? 100_000_000
          : [100_000_000.5, 100_000_000, 99_999_999.5][Math.floor(i / 2)]!,
    }));
    const audit = sectorPerformanceSnapshot(input);
    const simple = sectorPerformance({
      members: [5e-9, 0, -5e-9].map((value, i) => member(ids[i]!, value)),
    });
    const expected = [
      ['positive', 1e-8, 1],
      ['zero', 0, 2],
      ['negative', -1e-8, 3],
    ];
    expect(audit.sectors.map((s) => [s.sectorId, s.dailyReturn, s.rank])).toEqual(expected);
    expect(simple.sectors.map((s) => [s.sectorId, s.periodReturn, s.rank])).toEqual(expected);
    expect(audit.sectors.map((s) => s.members[0]!.dailyReturn)).toEqual([5e-9, 0, -5e-9]);
    expect(audit.assumptions.rounding).toBe(simple.assumptions.rounding);
    // Source lineage remains the selected observations, not synthesized return data.
    expect(audit.sectors[0]!.members[0]!.targetClose.splitAdjustedClose).toBe(100_000_000.5);
  });

  it('preserves positive-price extremes, subnormal ratios, total-loss rounding and overflow refusal', () => {
    for (const [previousClose, targetClose, expected] of [
      [Number.MIN_VALUE, Number.MIN_VALUE, 0],
      [Number.MIN_VALUE, 2 * Number.MIN_VALUE, 1],
      [2 * Number.MIN_VALUE, Number.MIN_VALUE, -0.5],
      [Number.MAX_VALUE, Number.MAX_VALUE, 0],
      [Number.MAX_VALUE / 2, Number.MAX_VALUE, 1],
      [Number.MAX_VALUE, Number.MIN_VALUE, -1],
      [1, Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const input = snapshotInput();
      input.splitAdjustedCloses[0]!.splitAdjustedClose = previousClose!;
      input.splitAdjustedCloses[1]!.splitAdjustedClose = targetClose!;
      const report = sectorPerformanceSnapshot(input);
      expect(report.sectors[0]!.dailyReturn).toBe(expected);
      expect(Object.is(report.sectors[0]!.members[0]!.dailyReturn, -0)).toBe(false);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
    const overflow = snapshotInput();
    overflow.splitAdjustedCloses[0]!.splitAdjustedClose = Number.MIN_VALUE;
    overflow.splitAdjustedCloses[1]!.splitAdjustedClose = Number.MAX_VALUE;
    expect(() => sectorPerformanceSnapshot(overflow)).toThrow(InputError);
  });

  it('uses split fallback if finite signed operands overflow subtraction, without fabricating a result', () => {
    // Public split-adjusted closes remain strictly positive; signed cases exercise the defensive helper.
    expect(
      sectorSimpleReturn({ targetClose: Number.MAX_VALUE, previousClose: -Number.MAX_VALUE }),
    ).toBe(-2);
    expect(
      sectorSimpleReturn({ targetClose: -Number.MAX_VALUE, previousClose: Number.MAX_VALUE }),
    ).toBe(-2);
    expect(sectorSimpleReturn({ targetClose: -1, previousClose: -1 })).toBe(0);
    expect(
      sectorSimpleReturn({ targetClose: Number.MAX_VALUE, previousClose: Number.MIN_VALUE }),
    ).toBe(Infinity);
    const invalid = snapshotInput();
    invalid.splitAdjustedCloses[0]!.splitAdjustedClose = -1;
    expect(() => sectorPerformanceSnapshot(invalid)).toThrow(InputError);
  });

  it('keeps target/previous lineage correct through named-object empty-report branches', () => {
    const input = snapshotInput();
    const absent = sectorPerformanceSnapshot({ ...input, targetSessionDate: '2026-08-23' });
    expect(absent.selectedSessions).toEqual({ target: null, previous: null });
    const noPrevious = sectorPerformanceSnapshot({
      ...input,
      completedSessions: [input.completedSessions[1]!],
      splitAdjustedCloses: [input.splitAdjustedCloses[1]!],
    });
    expect(noPrevious.selectedSessions).toEqual({
      target: input.completedSessions[1],
      previous: null,
    });
    const emptyUniverse = sectorPerformanceSnapshot({ ...input, eligibleUniverse: [] });
    expect(emptyUniverse.selectedSessions).toEqual({
      target: input.completedSessions[1],
      previous: input.completedSessions[0],
    });
  });
});
