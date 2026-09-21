/**
 * Stage 4.6 slice 1 — point-in-time universe vocabulary: membership is a half-open interval,
 * additions and exits are what changed between two instants, a delisting carries its return, and
 * eligibility is the ONE availability law screening already applies (shifting availability past
 * the cutoff removes the row; the latest version wins; a lag counts sessions, never days).
 */
import { describe, expect, it } from 'vitest';
import {
  eligibleObservationsAt,
  requireUniverseHistory,
  screenUniverse,
  universeMembershipAt,
  type FieldDefinition,
  type UniverseHistory,
  type UniverseObservation,
} from '@totalfinance/research';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 21);
const at = (days: number): number => T0 + days * DAY;

const history: UniverseHistory = {
  universeId: 'test-universe',
  members: [
    { instrumentId: 'AAA', fromTimestampMs: at(0) },
    { instrumentId: 'BBB', fromTimestampMs: at(0), toTimestampMs: at(10), exitReason: 'removed' },
    {
      instrumentId: 'CCC',
      fromTimestampMs: at(5),
      toTimestampMs: at(20),
      exitReason: 'delisted',
      delistingReturn: -0.35,
    },
    { instrumentId: 'DDD', fromTimestampMs: at(15) },
    { instrumentId: 'BBB', fromTimestampMs: at(30) },
  ],
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('universeMembershipAt — half-open intervals', () => {
  it('lists the members at an instant, sorted, with the rule echoed', () => {
    const r = universeMembershipAt({ universeHistory: history, asOf: at(7) });
    expect(r.instrumentIds).toEqual(['AAA', 'BBB', 'CCC']);
    expect(r.assumptions.membershipRule).toBe('fromTimestampMs <= asOf < toTimestampMs');
    expect(r.additions).toEqual([]);
    expect(r.exits).toEqual([]);
    // the exit instant itself is NOT a membership instant (half-open), the entry instant is
    expect(universeMembershipAt({ universeHistory: history, asOf: at(10) }).instrumentIds).toEqual([
      'AAA',
      'CCC',
    ]);
    expect(universeMembershipAt({ universeHistory: history, asOf: at(15) }).instrumentIds).toEqual([
      'AAA',
      'CCC',
      'DDD',
    ]);
  });

  it('reports additions and exits inside (previousAsOf, asOf], with the exit reason and delisting return', () => {
    const r = universeMembershipAt({ universeHistory: history, asOf: at(20), previousAsOf: at(7) });
    expect(r.instrumentIds).toEqual(['AAA', 'DDD']);
    expect(r.additions).toEqual(['DDD']);
    expect(r.exits).toEqual([
      {
        instrumentId: 'BBB',
        exitTimestampMs: at(10),
        exitReason: 'removed',
        delistingReturn: null,
      },
      {
        instrumentId: 'CCC',
        exitTimestampMs: at(20),
        exitReason: 'delisted',
        delistingReturn: -0.35,
      },
    ]);
    expect(r.diagnostics).toMatchObject({
      memberCount: 2,
      additionCount: 1,
      exitCount: 2,
      warnings: [],
    });
    // a name may re-enter later as a new interval
    const later = universeMembershipAt({
      universeHistory: history,
      asOf: at(31),
      previousAsOf: at(29),
    });
    expect(later.additions).toEqual(['BBB']);
  });

  it('warns when a delisting exit carries no return (a simulator must refuse, never assume)', () => {
    const h: UniverseHistory = {
      universeId: 'u',
      members: [
        {
          instrumentId: 'ZZZ',
          fromTimestampMs: at(0),
          toTimestampMs: at(3),
          exitReason: 'delisted',
        },
      ],
    };
    const r = universeMembershipAt({ universeHistory: h, asOf: at(4), previousAsOf: at(1) });
    expect(r.exits[0]!.delistingReturn).toBeNull();
    expect(r.diagnostics.warnings[0]).toContain('without a delistingReturn');
  });

  it('teaches: overlapping intervals, empty intervals, exits without instants, returns without delistings, bad instants', () => {
    const base = (members: UniverseHistory['members']) =>
      codeOf(() => requireUniverseHistory('t', 'h', { universeId: 'u', members }));
    expect(
      base([
        { instrumentId: 'A', fromTimestampMs: at(0), toTimestampMs: at(5) },
        { instrumentId: 'A', fromTimestampMs: at(3) },
      ]),
    ).toBe('input.out_of_range');
    expect(base([{ instrumentId: 'A', fromTimestampMs: at(5), toTimestampMs: at(5) }])).toBe(
      'input.out_of_range',
    );
    expect(base([{ instrumentId: 'A', fromTimestampMs: at(0), exitReason: 'removed' }])).toBe(
      'input.missing_field',
    );
    expect(
      base([
        {
          instrumentId: 'A',
          fromTimestampMs: at(0),
          toTimestampMs: at(2),
          exitReason: 'removed',
          delistingReturn: -0.1,
        },
      ]),
    ).toBe('input.out_of_range');
    expect(
      base([
        {
          instrumentId: 'A',
          fromTimestampMs: at(0),
          toTimestampMs: at(2),
          exitReason: 'delisted',
          delistingReturn: -1.5,
        },
      ]),
    ).toBe('input.out_of_range');
    expect(base([{ instrumentId: 'A', fromTimestampMs: Number.NaN }])).toBe('input.wrong_type');
    expect(
      base([
        {
          instrumentId: 'A',
          fromTimestampMs: at(0),
          toTimestampMs: at(1),
          exitReason: 'bankrupt' as never,
        },
      ]),
    ).toBe('input.invalid_enum');
    expect(base([{ instrumentId: 'A', fromTimestampMs: at(0), extra: 1 } as never])).toBe(
      'input.unknown_field',
    );
    expect(
      codeOf(() =>
        universeMembershipAt({ universeHistory: history, asOf: at(5), previousAsOf: at(5) }),
      ),
    ).toBe('input.out_of_range');
    expect(
      codeOf(() =>
        universeMembershipAt({ universeHistory: { universeId: '', members: [] }, asOf: at(5) }),
      ),
    ).toBe('input.wrong_type');
  });
});

const fieldDefinitions: FieldDefinition[] = [{ fieldName: 'score', kind: 'numeric' }];
const observations: UniverseObservation[] = [
  { instrumentId: 'AAA', availableTimestampMs: at(1), fields: { score: 1 } },
  { instrumentId: 'AAA', availableTimestampMs: at(6), fields: { score: 2 } }, // a revision
  { instrumentId: 'BBB', availableTimestampMs: at(1), fields: { score: 3 } },
  { instrumentId: 'CCC', availableTimestampMs: at(9), fields: { score: 4 } },
  { instrumentId: 'DDD', availableTimestampMs: at(16), fields: { score: 5 } },
];

describe('eligibleObservationsAt — the one availability law', () => {
  it('returns the latest available version per instrument at or before asOf, sorted, with exclusions counted', () => {
    const r = eligibleObservationsAt({ observations, fieldDefinitions, asOf: at(7) });
    expect(r.observations.map((o) => [o.instrumentId, o.fields['score']])).toEqual([
      ['AAA', 2],
      ['BBB', 3],
    ]);
    expect(r.diagnostics.exclusionReasons).toEqual({
      'superseded-by-later-version': 1,
      'not-yet-available-at-asOf': 2,
    });
    expect(r.assumptions.availabilityCutoffMs).toBe(at(7));
    expect(r.assumptions.versionResolution).toBe(
      'latest available at or before the cutoff per instrument',
    );
  });

  it("shifting a row's availability past the instant removes it (no look-ahead)", () => {
    const shifted = observations.map((o) =>
      o.instrumentId === 'BBB' ? { ...o, availableTimestampMs: at(8) } : o,
    );
    const r = eligibleObservationsAt({ observations: shifted, fieldDefinitions, asOf: at(7) });
    expect(r.observations.map((o) => o.instrumentId)).toEqual(['AAA']);
  });

  it('restricts to universe members at asOf when a history is given', () => {
    const r = eligibleObservationsAt({
      observations,
      fieldDefinitions,
      asOf: at(12),
      universeHistory: history,
    });
    // BBB left at day 10; CCC is a member (5..20) and available at day 9
    expect(r.observations.map((o) => o.instrumentId)).toEqual(['AAA', 'CCC']);
    expect(r.diagnostics.exclusionReasons['not-a-universe-member-at-asOf']).toBe(1);
    expect(r.assumptions.universeId).toBe('test-universe');
  });

  it("a lag counts sessions in the caller's index, never calendar days", () => {
    // sessions on days 1..9 except day 4 (a holiday); asOf day 7, lag 2 sessions → day 5 (not day 5 by calendar arithmetic through the holiday: days 6, 5)
    const sessionTimestamps = [1, 2, 3, 5, 6, 7, 8, 9].map(at);
    const r = eligibleObservationsAt({
      observations,
      fieldDefinitions,
      asOf: at(7),
      lag: { tradingSessions: 2, sessionTimestamps },
    });
    expect(r.assumptions.availabilityCutoffMs).toBe(at(5));
    expect(r.assumptions.lagTradingSessions).toBe(2);
    // AAA's revision (day 6) is not yet visible; the day-1 version is
    expect(r.observations.map((o) => [o.instrumentId, o.fields['score']])).toEqual([
      ['AAA', 1],
      ['BBB', 3],
    ]);
    // lag 3 from day 7 crosses the holiday: sessions 6, 5, 3 → cutoff day 3
    expect(
      eligibleObservationsAt({
        observations,
        fieldDefinitions,
        asOf: at(7),
        lag: { tradingSessions: 3, sessionTimestamps },
      }).assumptions.availabilityCutoffMs,
    ).toBe(at(3));
  });

  it('teaches: a lag past the start of the index, an unsorted index, a non-integer lag', () => {
    const sessionTimestamps = [1, 2, 3].map(at);
    expect(
      codeOf(() =>
        eligibleObservationsAt({
          observations,
          fieldDefinitions,
          asOf: at(3),
          lag: { tradingSessions: 5, sessionTimestamps },
        }),
      ),
    ).toBe('input.out_of_range');
    expect(
      codeOf(() =>
        eligibleObservationsAt({
          observations,
          fieldDefinitions,
          asOf: at(3),
          lag: { tradingSessions: 1, sessionTimestamps: [at(2), at(1)] },
        }),
      ),
    ).toBe('input.out_of_range');
    expect(
      codeOf(() =>
        eligibleObservationsAt({
          observations,
          fieldDefinitions,
          asOf: at(3),
          lag: { tradingSessions: 1.5, sessionTimestamps },
        }),
      ),
    ).toBe('input.out_of_range');
    expect(
      codeOf(() => eligibleObservationsAt({ observations, fieldDefinitions, asOf: Number.NaN })),
    ).toBe('input.wrong_type');
  });

  it('is the same law screenUniverse applies (one implementation)', () => {
    const screen = screenUniverse({
      universeId: 'u',
      asOf: at(7),
      observations,
      fieldDefinitions,
      missingValuePolicy: 'exclude',
      orderBy: [{ field: 'score', direction: 'descending' }],
    });
    const eligible = eligibleObservationsAt({ observations, fieldDefinitions, asOf: at(7) });
    expect([...screen.rows.map((r) => r.instrumentId)].sort()).toEqual(
      eligible.observations.map((o) => o.instrumentId),
    );
    expect(screen.diagnostics.exclusionReasons['not-yet-available-at-asOf']).toBe(
      eligible.diagnostics.exclusionReasons['not-yet-available-at-asOf'],
    );
  });
});
