/**
 * FC3 event-study goldens, hand-computed over a small deterministic fixture.
 *
 * Fixture: two instruments (AAA, BBB) with 14 consecutive sessions 2024-03-01..2024-03-14 and a
 * FLAT market series (0.001 every session), plus a third instrument (LIN) whose estimation-window
 * returns are EXACTLY 0.001 + 2 × (a varying market) so the OLS market model has beta 2, alpha
 * 0.001, R² 1 by construction. Every expected value below is derived by hand in the comments.
 * Tolerances are 1e-12 (toBeCloseTo digits=12 ⇒ |diff| < 5e-13) wherever the value is exact.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  aggregateEventStudies,
  alignEventWindows,
  eventStudy,
  type EventStudyInput,
} from '../src/events.js';

// ---------------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------------

// Index:      0        1        2        3        4        5        6        7        8        9        10       11       12       13
const DATES = [
  '2024-03-01',
  '2024-03-02',
  '2024-03-03',
  '2024-03-04',
  '2024-03-05',
  '2024-03-06',
  '2024-03-07',
  '2024-03-08',
  '2024-03-09',
  '2024-03-10',
  '2024-03-11',
  '2024-03-12',
  '2024-03-13',
  '2024-03-14',
];
const AAA = [
  0.01, 0.02, -0.01, 0.005, 0.015, -0.005, 0.0, 0.01, 0.02, -0.02, 0.03, 0.01, -0.01, 0.005,
];
const BBB = [
  0.005, 0.01, 0.0, -0.005, 0.01, 0.005, 0.01, -0.01, 0.01, 0.0, 0.02, -0.005, 0.015, 0.01,
];

// Varying market for the OLS golden, and LIN = 0.001 + 2 × market EXACTLY on indices 2..6 (the
// estimation window used below); everywhere else LIN is arbitrary.
const VARYING_MARKET = [
  0.001, 0.002, -0.001, 0.003, 0.0, -0.002, 0.001, 0.004, 0.002, -0.001, 0.003, 0.001, 0.0, 0.002,
];
const LIN = [
  0.002, 0.004, -0.001, 0.007, 0.001, -0.003, 0.003, 0.006, 0.01, 0.005, 0.008, 0.002, 0.001, 0.003,
];

const returnObservations = DATES.flatMap((tradingSessionDate, i) => [
  { instrumentId: 'AAA', tradingSessionDate, simpleReturn: AAA[i]! },
  { instrumentId: 'BBB', tradingSessionDate, simpleReturn: BBB[i]! },
  { instrumentId: 'LIN', tradingSessionDate, simpleReturn: LIN[i]! },
]);

const FLAT_MARKET = DATES.map((tradingSessionDate) => ({
  tradingSessionDate,
  simpleReturn: 0.001,
}));
const VARYING_MARKET_ROWS = DATES.map((tradingSessionDate, i) => ({
  tradingSessionDate,
  simpleReturn: VARYING_MARKET[i]!,
}));

/** 2024-03-07T15:00:00Z — mid-session on the 03-07 session. */
const ANN_0307_MID = Date.UTC(2024, 2, 7, 15, 0, 0);
/** 2024-03-07T23:30:00Z — after the last session of that day, still the 03-07 UTC date. */
const ANN_0307_LATE = Date.UTC(2024, 2, 7, 23, 30, 0);

const E1 = {
  eventId: 'E1',
  instrumentId: 'AAA',
  eventType: 'earnings',
  announcedTimestampMs: ANN_0307_MID,
};
const E2 = {
  eventId: 'E2',
  instrumentId: 'BBB',
  eventType: 'earnings',
  announcedTimestampMs: ANN_0307_MID,
};

const MEAN_ADJUSTED_BASE: EventStudyInput = {
  events: [E1, E2],
  returnObservations,
  eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
  estimationWindow: { startTradingSessionOffset: -5, endTradingSessionOffset: -2 },
  expectedReturnModel: { model: 'mean-adjusted' },
  overlappingEventPolicy: 'reject',
};

// ---------------------------------------------------------------------------------------------------
// Session-policy anchoring (alignEventWindows — the same code path eventStudy uses)
// ---------------------------------------------------------------------------------------------------

describe('session-policy anchoring', () => {
  const align = (
    announcedTimestampMs: number,
    sessionPolicy: 'announcement-session' | 'next-session',
  ) =>
    alignEventWindows({
      events: [{ ...E1, announcedTimestampMs }],
      returnObservations,
      eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 0 },
      sessionPolicy,
    });

  it("'announcement-session' anchors a mid-session announcement to that same session", () => {
    // Announcement date 2024-03-07 IS a session date → the first session ≥ 03-07 is 03-07 itself.
    const result = align(ANN_0307_MID, 'announcement-session');
    expect(result.alignments[0]!.anchorTradingSessionDate).toBe('2024-03-07');
    // Offset 0 carries that session's actual return: AAA[6] = 0.000.
    expect(result.alignments[0]!.rows[0]!.simpleReturn).toBeCloseTo(0.0, 12);
  });

  it("'next-session' anchors a mid-session announcement to the NEXT session", () => {
    // Last session ≤ 03-07 is 03-07 (index 6) → session 0 is index 7 = 2024-03-08.
    const result = align(ANN_0307_MID, 'next-session');
    expect(result.alignments[0]!.anchorTradingSessionDate).toBe('2024-03-08');
    expect(result.alignments[0]!.rows[0]!.simpleReturn).toBeCloseTo(0.01, 12); // AAA[7]
  });

  it('a post-close announcement on the same UTC date anchors identically — the policy, not the clock, is the knob', () => {
    expect(
      align(ANN_0307_LATE, 'announcement-session').alignments[0]!.anchorTradingSessionDate,
    ).toBe('2024-03-07');
    expect(align(ANN_0307_LATE, 'next-session').alignments[0]!.anchorTradingSessionDate).toBe(
      '2024-03-08',
    );
  });

  it('an announcement before every observed session anchors to the first session under both policies', () => {
    const before = Date.UTC(2024, 1, 25, 12, 0, 0); // 2024-02-25, before 2024-03-01
    expect(align(before, 'announcement-session').alignments[0]!.anchorTradingSessionDate).toBe(
      '2024-03-01',
    );
    expect(align(before, 'next-session').alignments[0]!.anchorTradingSessionDate).toBe(
      '2024-03-01',
    );
  });

  it('sessionPolicy defaults to next-session and is echoed in assumptions', () => {
    const result = alignEventWindows({
      events: [E1],
      returnObservations,
      eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 0 },
    });
    expect(result.assumptions.sessionPolicy).toBe('next-session');
    expect(result.alignments[0]!.anchorTradingSessionDate).toBe('2024-03-08');
  });

  it('eventStudy anchors through the same code path as alignEventWindows', () => {
    const study = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
    const aligned = alignEventWindows({
      events: [E1],
      returnObservations,
      eventWindow: MEAN_ADJUSTED_BASE.eventWindow,
    });
    expect(study.events[0]!.anchorTradingSessionDate).toBe(
      aligned.alignments[0]!.anchorTradingSessionDate,
    );
    expect(study.events[0]!.rows.map((row) => row.tradingSessionDate)).toEqual(
      aligned.alignments[0]!.rows.map((row) => row.tradingSessionDate),
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// Mean-adjusted goldens
// ---------------------------------------------------------------------------------------------------

describe('mean-adjusted expected returns (hand-computed)', () => {
  // E1 (AAA), next-session anchor = index 7 (2024-03-08).
  // Estimation offsets −5..−2 → indices 2..5 → AAA returns [−0.010, 0.005, 0.015, −0.005];
  //   sum = 0.005, mean = 0.005/4 = 0.00125.
  // Event offsets −1, 0, +1 → indices 6, 7, 8 → actual [0.000, 0.010, 0.020];
  //   AR = actual − 0.00125 = [−0.00125, 0.00875, 0.01875]; CAR(sum) = 0.02625.
  const study = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
  const event = study.events[0]!;

  it('anchors at 2024-03-08 and slices dates 03-07..03-09', () => {
    expect(event.anchorTradingSessionDate).toBe('2024-03-08');
    expect(event.rows.map((row) => row.tradingSessionDate)).toEqual([
      '2024-03-07',
      '2024-03-08',
      '2024-03-09',
    ]);
    expect(event.rows.map((row) => row.tradingSessionOffset)).toEqual([-1, 0, 1]);
  });

  it('every expected, actual, and abnormal return matches the hand computation to 1e-12', () => {
    const expectedReturns = [0.00125, 0.00125, 0.00125];
    const actualReturns = [0.0, 0.01, 0.02];
    const abnormalReturns = [-0.00125, 0.00875, 0.01875];
    event.rows.forEach((row, k) => {
      expect(row.expectedReturn).toBeCloseTo(expectedReturns[k]!, 12);
      expect(row.actualReturn).toBeCloseTo(actualReturns[k]!, 12);
      expect(row.abnormalReturn).toBeCloseTo(abnormalReturns[k]!, 12);
    });
  });

  it('CAR under the default sum convention is 0.02625', () => {
    expect(study.assumptions.cumulativeConvention).toBe('sum');
    expect(event.cumulativeAbnormalReturn).toBeCloseTo(0.02625, 12);
  });

  it('echoes every convention in assumptions', () => {
    expect(study.assumptions).toMatchObject({
      sessionPolicy: 'next-session',
      cumulativeConvention: 'sum',
      expectedReturnModel: 'mean-adjusted',
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      estimationWindow: { startTradingSessionOffset: -5, endTradingSessionOffset: -2 },
      overlappingEventPolicy: 'reject',
    });
    expect(study.diagnostics.warnings).toEqual([]);
  });
});

describe('cumulative conventions', () => {
  it('sum and compound CARs differ exactly as Σ vs Π(1+AR)−1', () => {
    // AR = [−0.00125, 0.00875, 0.01875]:
    //   sum       = 0.02625
    //   compound  = (0.99875)(1.00875)(1.01875) − 1
    //             = 1.0074890625 × 1.01875 − 1 = 0.026379482421875
    const sum = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1], cumulativeConvention: 'sum' });
    const compound = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [E1],
      cumulativeConvention: 'compound',
    });
    expect(sum.events[0]!.cumulativeAbnormalReturn).toBeCloseTo(0.02625, 12);
    expect(compound.events[0]!.cumulativeAbnormalReturn).toBeCloseTo(
      0.99875 * 1.00875 * 1.01875 - 1,
      12,
    );
    expect(compound.events[0]!.cumulativeAbnormalReturn).not.toBeCloseTo(
      sum.events[0]!.cumulativeAbnormalReturn,
      6,
    );
    expect(compound.assumptions.cumulativeConvention).toBe('compound');
  });
});

// ---------------------------------------------------------------------------------------------------
// Market-adjusted and market-model goldens
// ---------------------------------------------------------------------------------------------------

describe('market-adjusted expected returns (flat market)', () => {
  it('expected return is the same-session market return; AR = actual − 0.001', () => {
    // Flat market 0.001. E1 event rows (indices 6..8): actual [0.000, 0.010, 0.020] →
    // AR = [−0.001, 0.009, 0.019]; CAR(sum) = 0.027.
    const study = eventStudy({
      events: [E1],
      returnObservations,
      marketReturns: FLAT_MARKET,
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      expectedReturnModel: { model: 'market-adjusted' },
      overlappingEventPolicy: 'reject',
    });
    const rows = study.events[0]!.rows;
    rows.forEach((row) => expect(row.expectedReturn).toBeCloseTo(0.001, 12));
    expect(rows.map((row) => row.abnormalReturn)).toEqual(
      [-0.001, 0.009, 0.019].map((v) => expect.closeTo(v, 12)),
    );
    expect(study.events[0]!.cumulativeAbnormalReturn).toBeCloseTo(0.027, 12);
    expect(study.events[0]!.marketModel).toBeUndefined();
  });
});

describe('market model (OLS over the estimation window)', () => {
  // LIN was CONSTRUCTED linear over the estimation window. Event announced 2024-03-09T10:00Z,
  // 'announcement-session' → anchor index 8 (2024-03-09). estimationWindow −6..−2 → indices 2..6:
  //   x (market)     = [−0.001, 0.003, 0.000, −0.002, 0.001], Σx = 0.001, meanX = 0.0002
  //   y (instrument) = [−0.001, 0.007, 0.001, −0.003, 0.003], Σy = 0.007, meanY = 0.0014
  //   x-deviations   = [−0.0012, 0.0028, −0.0002, −0.0022, 0.0008]
  //   y-deviations   = 2 × x-deviations exactly (y = 0.001 + 2x) →
  //   Sxx = 1.48e-5, Sxy = 2·Sxx, Syy = 4·Sxx
  //   beta = Sxy/Sxx = 2;  alpha = 0.0014 − 2×0.0002 = 0.001;  R² = Sxy²/(Sxx·Syy) = 1.
  const study = eventStudy({
    events: [
      {
        eventId: 'ELIN',
        instrumentId: 'LIN',
        eventType: 'earnings',
        announcedTimestampMs: Date.UTC(2024, 2, 9, 10, 0, 0),
      },
    ],
    returnObservations,
    marketReturns: VARYING_MARKET_ROWS,
    eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 1 },
    estimationWindow: { startTradingSessionOffset: -6, endTradingSessionOffset: -2 },
    expectedReturnModel: { model: 'market' },
    sessionPolicy: 'announcement-session',
    overlappingEventPolicy: 'reject',
  });
  const event = study.events[0]!;

  it('recovers beta = 2, alpha = 0.001, R² = 1 on the exactly-linear window', () => {
    expect(event.anchorTradingSessionDate).toBe('2024-03-09');
    expect(event.marketModel!.beta).toBeCloseTo(2, 12);
    expect(event.marketModel!.alpha).toBeCloseTo(0.001, 12);
    expect(event.marketModel!.rSquared).toBeCloseTo(1, 12);
    expect(event.marketModel!.rSquaredAbsentReason).toBeUndefined();
  });

  it('expected = alpha + beta × market per event session; AR and CAR match by hand', () => {
    // Index 8: market 0.002 → expected 0.001 + 2×0.002 = 0.005; actual 0.010 → AR 0.005.
    // Index 9: market −0.001 → expected 0.001 − 0.002 = −0.001; actual 0.005 → AR 0.006.
    // CAR(sum) = 0.011.
    expect(event.rows[0]!.expectedReturn).toBeCloseTo(0.005, 12);
    expect(event.rows[0]!.abnormalReturn).toBeCloseTo(0.005, 12);
    expect(event.rows[1]!.expectedReturn).toBeCloseTo(-0.001, 12);
    expect(event.rows[1]!.abnormalReturn).toBeCloseTo(0.006, 12);
    expect(event.cumulativeAbnormalReturn).toBeCloseTo(0.011, 12);
  });
});

// ---------------------------------------------------------------------------------------------------
// Cross-sectional AAR / CAAR / t
// ---------------------------------------------------------------------------------------------------

describe('AAR, CAAR, and the cross-sectional t-statistic', () => {
  // E1 AR = [−0.00125, 0.00875, 0.01875]; E2 (BBB) estimation indices 2..5 =
  // [0.000, −0.005, 0.010, 0.005], mean 0.0025; event actual [0.010, −0.010, 0.010] →
  // E2 AR = [0.0075, −0.0125, 0.0075].
  //   AAR  = [(−0.00125+0.0075)/2, (0.00875−0.0125)/2, (0.01875+0.0075)/2]
  //        = [0.003125, −0.001875, 0.013125]
  //   CAAR(sum) = [0.003125, 0.001250, 0.014375]
  // For n = 2, t = mean/(s/√2) with s = |x1−x2|/√2 ⇒ t = 2·mean/|x1−x2|:
  //   offset −1: 2(0.003125)/0.00875  =  5/7
  //   offset  0: 2(−0.001875)/0.02125 = −3/17
  //   offset +1: 2(0.013125)/0.01125  =  7/3
  const study = eventStudy(MEAN_ADJUSTED_BASE);

  it('computes the hand AAR and CAAR series', () => {
    const rows = study.averageAbnormalReturns;
    expect(rows.map((row) => row.tradingSessionOffset)).toEqual([-1, 0, 1]);
    expect(rows.map((row) => row.averageAbnormalReturn)).toEqual(
      [0.003125, -0.001875, 0.013125].map((v) => expect.closeTo(v, 12)),
    );
    expect(rows.map((row) => row.cumulativeAverageAbnormalReturn)).toEqual(
      [0.003125, 0.00125, 0.014375].map((v) => expect.closeTo(v, 12)),
    );
    rows.forEach((row) => expect(row.eventCount).toBe(2));
  });

  it('computes the exact n=2 t-statistics', () => {
    const rows = study.averageAbnormalReturns;
    expect(rows[0]!.tStatistic).toBeCloseTo(5 / 7, 12);
    expect(rows[1]!.tStatistic).toBeCloseTo(-3 / 17, 12);
    expect(rows[2]!.tStatistic).toBeCloseTo(7 / 3, 12);
    rows.forEach((row) => expect(row.tStatisticAbsentReason).toBeUndefined());
  });

  it('with a single event the t-statistic is null with a reason, never NaN', () => {
    const single = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
    single.averageAbnormalReturns.forEach((row) => {
      expect(row.eventCount).toBe(1);
      expect(row.tStatistic).toBeNull();
      expect(row.tStatisticAbsentReason).toMatch(/at least 2 events/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Overlapping events
// ---------------------------------------------------------------------------------------------------

describe('overlappingEventPolicy', () => {
  // E1 (ann 03-07, next-session) → anchor index 7, event window {−1,+1} = indices 6..8.
  // E3 (ann 03-08, next-session) → anchor index 8, event window indices 7..9. Overlap: 7..8.
  const E3 = {
    eventId: 'E3',
    instrumentId: 'AAA',
    eventType: 'guidance',
    announcedTimestampMs: Date.UTC(2024, 2, 8, 16, 0, 0),
  };
  const base: EventStudyInput = {
    events: [E1, E3],
    returnObservations,
    marketReturns: FLAT_MARKET,
    eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
    expectedReturnModel: { model: 'market-adjusted' },
    overlappingEventPolicy: 'reject',
  };

  it("'reject' keeps the earlier event and excludes the later one with a named reason", () => {
    const study = eventStudy(base);
    expect(study.diagnostics.eventsIncluded).toBe(1);
    expect(study.events.map((event) => event.eventId)).toEqual(['E1']);
    const exclusion = study.diagnostics.excludedEvents.find((entry) => entry.eventId === 'E3')!;
    expect(exclusion.reason).toMatch(/'reject'/);
    expect(exclusion.reason).toMatch(/'E1'/);
    expect(study.diagnostics.contaminatedEventIds).toEqual([]);
  });

  it("'allow-contaminated' keeps both and lists both in contaminatedEventIds", () => {
    const study = eventStudy({ ...base, overlappingEventPolicy: 'allow-contaminated' });
    expect(study.diagnostics.eventsIncluded).toBe(2);
    expect(study.events.map((event) => event.eventId)).toEqual(['E1', 'E3']);
    expect(study.diagnostics.contaminatedEventIds).toEqual(['E1', 'E3']);
    expect(study.diagnostics.excludedEvents).toEqual([]);
    study.averageAbnormalReturns.forEach((row) => expect(row.eventCount).toBe(2));
  });

  it('events on DIFFERENT instruments never conflict', () => {
    const study = eventStudy(MEAN_ADJUSTED_BASE); // E1 (AAA) and E2 (BBB) share the same sessions
    expect(study.diagnostics.eventsIncluded).toBe(2);
    expect(study.diagnostics.excludedEvents).toEqual([]);
  });

  it('overlappingEventPolicy is required — omitting it is a teaching error', () => {
    const { overlappingEventPolicy: _omitted, ...rest } = base;
    expect(() => eventStudy(rest as EventStudyInput)).toThrow(InputError);
    expect(() => eventStudy(rest as EventStudyInput)).toThrow(/overlappingEventPolicy/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Exclusions and validation
// ---------------------------------------------------------------------------------------------------

describe('exclusion with reason, never silent patching', () => {
  it('an event missing a session in its event window is excluded and the offset named', () => {
    // Ann 2024-03-13, next-session → anchor index 13 (2024-03-14, the LAST session); offset +1
    // has no session.
    const study = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [{ ...E1, eventId: 'E4', announcedTimestampMs: Date.UTC(2024, 2, 13, 15, 0, 0) }],
    });
    expect(study.diagnostics.eventsIncluded).toBe(0);
    const exclusion = study.diagnostics.excludedEvents[0]!;
    expect(exclusion.eventId).toBe('E4');
    expect(exclusion.reason).toMatch(/missing trading session/);
    expect(exclusion.reason).toMatch(/\+1/);
    expect(study.averageAbnormalReturns).toEqual([]);
    expect(
      study.diagnostics.warnings.some((warning) => warning.includes('no events were included')),
    ).toBe(true);
  });

  it('an event missing the estimation window its model requires is excluded', () => {
    // Ann 2024-03-02, announcement-session → anchor index 1; estimation −5..−2 → indices −4..−1.
    const study = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [{ ...E1, eventId: 'E5', announcedTimestampMs: Date.UTC(2024, 2, 2, 12, 0, 0) }],
      sessionPolicy: 'announcement-session',
    });
    expect(study.diagnostics.eventsIncluded).toBe(0);
    expect(study.diagnostics.excludedEvents[0]!.reason).toMatch(/estimation window/);
  });

  it('an estimation window that does not end strictly before the event window is refused', () => {
    const bad = {
      ...MEAN_ADJUSTED_BASE,
      estimationWindow: { startTradingSessionOffset: -3, endTradingSessionOffset: -1 },
    };
    expect(() => eventStudy(bad)).toThrow(InputError);
    expect(() => eventStudy(bad)).toThrow(/strictly BEFORE/);
    // The boundary case −2 < −1 passes.
    expect(() =>
      eventStudy({
        ...MEAN_ADJUSTED_BASE,
        estimationWindow: { startTradingSessionOffset: -3, endTradingSessionOffset: -2 },
      }),
    ).not.toThrow();
  });

  it('models name the inputs they require', () => {
    const { estimationWindow: _e, ...noEstimation } = MEAN_ADJUSTED_BASE;
    expect(() => eventStudy(noEstimation as EventStudyInput)).toThrow(/estimationWindow/);
    expect(() =>
      eventStudy({
        ...MEAN_ADJUSTED_BASE,
        expectedReturnModel: { model: 'market-adjusted' },
        estimationWindow: undefined as never,
        marketReturns: undefined as never,
      }),
    ).toThrow(/marketReturns/);
  });

  it('ambiguous inputs are teaching errors: duplicate sessions, duplicate event ids, unknown keys', () => {
    expect(() =>
      eventStudy({
        ...MEAN_ADJUSTED_BASE,
        returnObservations: [
          ...returnObservations,
          { instrumentId: 'AAA', tradingSessionDate: '2024-03-01', simpleReturn: 0.02 },
        ],
      }),
    ).toThrow(/duplicates instrument 'AAA' session 2024-03-01/);
    expect(() =>
      eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1, { ...E2, eventId: 'E1' }] }),
    ).toThrow(/reuses eventId 'E1'/);
    expect(() =>
      eventStudy({ ...MEAN_ADJUSTED_BASE, bogus: true } as unknown as EventStudyInput),
    ).toThrow(/unknown field "bogus"/);
  });

  it('an unused estimation window is kept in assumptions and disclosed as a warning', () => {
    const study = eventStudy({
      events: [E1],
      returnObservations,
      marketReturns: FLAT_MARKET,
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      estimationWindow: { startTradingSessionOffset: -5, endTradingSessionOffset: -2 },
      expectedReturnModel: { model: 'market-adjusted' },
      overlappingEventPolicy: 'reject',
    });
    expect(study.assumptions.estimationWindow).toEqual({
      startTradingSessionOffset: -5,
      endTradingSessionOffset: -2,
    });
    expect(study.diagnostics.warnings.some((warning) => warning.includes('does not use one'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// Acceptance law: shifting the announcement past the observation instant removes the information
// ---------------------------------------------------------------------------------------------------

describe('point-in-time law', () => {
  it('moving announcedTimestampMs one day later moves the anchor strictly forward', () => {
    const before = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
    const after = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [{ ...E1, announcedTimestampMs: Date.UTC(2024, 2, 8, 15, 0, 0) }],
    });
    expect(before.events[0]!.anchorTradingSessionDate).toBe('2024-03-08');
    expect(after.events[0]!.anchorTradingSessionDate).toBe('2024-03-09');
    // The 2024-03-08 return sat at offset 0 before the shift; afterwards offset 0 is 2024-03-09 —
    // the information no longer reaches the 03-08 observation.
    expect(before.events[0]!.rows[1]!.tradingSessionDate).toBe('2024-03-08');
    expect(after.events[0]!.rows[1]!.tradingSessionDate).toBe('2024-03-09');
    expect(after.events[0]!.rows.map((row) => row.tradingSessionDate)).not.toContain('2024-03-07');
  });

  it('moving the announcement within the same UTC date does NOT move the anchor (date-granular)', () => {
    const mid = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
    const late = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [{ ...E1, announcedTimestampMs: ANN_0307_LATE }],
    });
    expect(late.events[0]!.anchorTradingSessionDate).toBe(mid.events[0]!.anchorTradingSessionDate);
  });
});

// ---------------------------------------------------------------------------------------------------
// Custom (structural) expected-return model
// ---------------------------------------------------------------------------------------------------

describe('custom expected-return model', () => {
  it('calls the supplied function per session with the market return and classifies it non-serializable', () => {
    const seen: { instrumentId: string; tradingSessionDate: string; marketReturn?: number }[] = [];
    const study = eventStudy({
      events: [E1],
      returnObservations,
      marketReturns: FLAT_MARKET,
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      expectedReturnModel: {
        model: 'custom',
        expectedReturn: (context) => {
          seen.push(context);
          return 0.001;
        },
      },
      overlappingEventPolicy: 'reject',
    });
    expect(study.assumptions.expectedReturnModel).toBe('custom (non-serializable)');
    // Same numbers as the flat market-adjusted golden: AR = [−0.001, 0.009, 0.019].
    expect(study.events[0]!.rows.map((row) => row.abnormalReturn)).toEqual(
      [-0.001, 0.009, 0.019].map((v) => expect.closeTo(v, 12)),
    );
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({
      instrumentId: 'AAA',
      tradingSessionDate: '2024-03-07',
      marketReturn: 0.001,
    });
  });

  it('a custom model returning a non-finite value is a teaching error, never a NaN row', () => {
    expect(() =>
      eventStudy({
        events: [E1],
        returnObservations,
        eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 0 },
        expectedReturnModel: { model: 'custom', expectedReturn: () => Number.NaN },
        overlappingEventPolicy: 'reject',
      }),
    ).toThrow(/finite decimal return/);
  });
});

// ---------------------------------------------------------------------------------------------------
// aggregateEventStudies
// ---------------------------------------------------------------------------------------------------

describe('aggregateEventStudies', () => {
  const studyE1 = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E1] });
  const studyE2 = eventStudy({ ...MEAN_ADJUSTED_BASE, events: [E2] });
  const joint = eventStudy(MEAN_ADJUSTED_BASE);

  it('pooling two single-event studies reproduces the joint study exactly', () => {
    const pooled = aggregateEventStudies({ studies: [studyE1, studyE2] });
    expect(pooled.studiesAggregated).toBe(2);
    expect(pooled.diagnostics.eventsSupplied).toBe(2);
    expect(pooled.diagnostics.eventsIncluded).toBe(2);
    pooled.averageAbnormalReturns.forEach((row, k) => {
      const reference = joint.averageAbnormalReturns[k]!;
      expect(row.averageAbnormalReturn).toBeCloseTo(reference.averageAbnormalReturn, 12);
      expect(row.cumulativeAverageAbnormalReturn).toBeCloseTo(
        reference.cumulativeAverageAbnormalReturn,
        12,
      );
      expect(row.tStatistic).toBeCloseTo(reference.tStatistic!, 12);
      expect(row.eventCount).toBe(2);
    });
    expect(pooled.assumptions).toMatchObject({
      sessionPolicy: 'next-session',
      cumulativeConvention: 'sum',
      expectedReturnModel: 'mean-adjusted',
      overlappingEventPolicy: 'reject',
      estimationWindow: { startTradingSessionOffset: -5, endTradingSessionOffset: -2 },
    });
  });

  it('aggregate results reconcile to the pooled event rows', () => {
    const pooled = aggregateEventStudies({ studies: [studyE1, studyE2] });
    pooled.averageAbnormalReturns.forEach((row, k) => {
      const mean =
        pooled.events.reduce((total, event) => total + event.rows[k]!.abnormalReturn, 0) /
        pooled.events.length;
      expect(row.averageAbnormalReturn).toBeCloseTo(mean, 12);
    });
  });

  it('refuses a mismatched event window naming both values', () => {
    const other = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [E1],
      eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 1 },
    });
    expect(() => aggregateEventStudies({ studies: [studyE1, other] })).toThrow(InputError);
    expect(() => aggregateEventStudies({ studies: [studyE1, other] })).toThrow(
      /\[0, 1\].*does not match.*\[-1, 1\]/,
    );
  });

  it('refuses a mismatched cumulative convention naming both values', () => {
    const compound = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [E1],
      cumulativeConvention: 'compound',
    });
    expect(() => aggregateEventStudies({ studies: [studyE1, compound] })).toThrow(
      /'compound'.*does not match.*'sum'|'sum'.*does not match.*'compound'/,
    );
  });

  it('unions the input warnings and flags duplicated event ids', () => {
    const withWarning = eventStudy({
      ...MEAN_ADJUSTED_BASE,
      events: [E1],
      marketReturns: FLAT_MARKET, // unused by mean-adjusted → warning
    });
    const pooled = aggregateEventStudies({ studies: [withWarning, studyE1] });
    expect(pooled.diagnostics.warnings.some((warning) => warning.includes('mean-adjusted'))).toBe(
      true,
    );
    expect(pooled.diagnostics.warnings.some((warning) => warning.includes("'E1'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Result grammar
// ---------------------------------------------------------------------------------------------------

describe('result grammar', () => {
  it('every analysis result carries assumptions and diagnostics with warnings', () => {
    const study = eventStudy(MEAN_ADJUSTED_BASE);
    const pooled = aggregateEventStudies({ studies: [study] });
    const aligned = alignEventWindows({
      events: [E1],
      returnObservations,
      eventWindow: { startTradingSessionOffset: 0, endTradingSessionOffset: 0 },
    });
    for (const result of [study, pooled, aligned]) {
      expect(result.assumptions).toBeDefined();
      expect(Array.isArray(result.diagnostics.warnings)).toBe(true);
    }
    expect(pooled.studiesAggregated).toBe(1);
  });
});
