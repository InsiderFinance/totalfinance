import {
  alwaysOpen,
  createRuleCalendar,
  InputError,
  isComputed,
  type Calendar,
} from '@totalfinance/core';
import { CBOE, NYSE } from '@totalfinance/calendars';
import {
  optionFlowDrift,
  type OptionFlowDriftConfig,
  type OptionFlowDriftInput,
  type OptionFlowDriftTotals,
  type OptionFlowDriftTrade,
} from '@totalfinance/structure';
import { describe, expect, it } from 'vitest';
import {
  DRIFT_DATE,
  DRIFT_OPEN,
  DRIFT_CLOSE,
  driftPrint,
  recordedDriftTape,
} from './fixtures/option-flow-drift.js';
import { STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES } from '../../../tools/first-touch/fixtures/structure-option-flow-drift.js';

const minute = 60_000;
const request = (
  trades: readonly OptionFlowDriftTrade[] = [],
  config: OptionFlowDriftConfig = {},
): OptionFlowDriftInput => ({ trades, session: { date: DRIFT_DATE }, config });

function accounting(t: OptionFlowDriftTotals): void {
  expect(t.callDrift).toBeCloseTo(t.callBuyPremium - t.callSellPremium, 10);
  expect(t.putDrift).toBeCloseTo(t.putBuyPremium - t.putSellPremium, 10);
  expect(t.netDirectionalDrift).toBeCloseTo(t.callDrift - t.putDrift, 10);
  expect(t.netDirectionalDrift).toBeCloseTo(t.bullishPremium - t.bearishPremium, 10);
  expect(t.totalPremium).toBeCloseTo(t.classifiedPremium + t.unknownPremium, 10);
  expect(t.totalPremium).toBeCloseTo(t.callPremium + t.putPremium, 10);
  expect(t.totalVolume).toBe(t.bullishVolume + t.bearishVolume + t.unknownVolume);
  expect(t.netDirectionalVolume).toBe(t.bullishVolume - t.bearishVolume);
  expect(t.tradeCount).toBe(t.classifiedTradeCount + t.unknownTradeCount);
  expect(t.netDirectionalBounds).toEqual([
    t.netDirectionalDrift - t.unknownPremium,
    t.netDirectionalDrift + t.unknownPremium,
  ]);
  expect(t.classificationCoverage).toBe(
    t.totalPremium === 0 ? null : t.classifiedPremium / t.totalPremium,
  );
}

describe('optionFlowDrift raw premium arithmetic and honest result contract', () => {
  it('supplies a fresh valid fixture shard for main registration', () => {
    const fixture = STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES['structure.optionFlowDrift']!;
    const input = fixture()[0] as OptionFlowDriftInput;
    expect(isComputed(optionFlowDrift(input))).toBe(true);
    expect(input).toEqual(fixture()[0]);
    expect(input).not.toBe(fixture()[0]);
  });
  it('reproduces the recorded five-print PR probe without reclassifying its authoritative unknown', () => {
    const result = optionFlowDrift(request(recordedDriftTape()));
    expect(isComputed(result)).toBe(true);
    expect(result.value.summary).toMatchObject({
      callBuyPremium: 2000,
      callSellPremium: 500,
      putBuyPremium: 600,
      putSellPremium: 800,
      callUnknownPremium: 310,
      putUnknownPremium: 0,
      callPremium: 2810,
      putPremium: 1400,
      callDrift: 1500,
      putDrift: -200,
      netDirectionalDrift: 1700,
      bullishPremium: 2800,
      bearishPremium: 1100,
      classifiedPremium: 3900,
      unknownPremium: 310,
      totalPremium: 4210,
      callBounds: [1190, 1810],
      putBounds: [-200, -200],
      netDirectionalBounds: [1390, 2010],
      bullishVolume: 18,
      bearishVolume: 8,
      unknownVolume: 2,
      totalVolume: 28,
      netDirectionalVolume: 10,
      tradeCount: 5,
      classifiedTradeCount: 4,
      unknownTradeCount: 1,
      volumeConfirmation: 'aligned',
      heuristic: 'bullish-expansion',
    });
    expect(result.value.summary.classificationCoverage).toBeCloseTo(0.9263657957244655, 14);
    expect(result.value.minutes.slice(0, 5).map((b) => b.cumulative.netDirectionalDrift)).toEqual([
      2000, 1500, 900, 1700, 1700,
    ]);
    expect(result.value.minutes.slice(0, 5).map((b) => b.change.netDirectionalDrift)).toEqual([
      2000, -500, -600, 800, 0,
    ]);
    expect(result.value.buckets[0]!.change).toEqual(result.value.summary);
    expect(result.value.buckets[0]!.trades[4]).toMatchObject({
      side: 'unknown',
      premium: 310,
      premiumSource: 'provided',
      classificationProvenance: { source: 'provided', providedSide: 'unknown' },
    });
    expect(result.assumptions).toMatchObject({
      calendar: 'NYSE',
      calendarVersion: NYSE.version,
      timezone: 'America/New_York',
      classificationSource: 'provided-first',
      multiplier: 100,
      minimumClassificationCoverage: 0.6,
      coverageMeaning: 'classified-premium-share-not-probability',
    });
    expect(result.diagnostics.warnings.every((w) => w.code === 'model.limitation')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"confidence"|"probability"|"netDrift"/);
    accounting(result.value.summary);
  });

  it('allows callers to opt into the legacy quote fallback intentionally', () => {
    const result = optionFlowDrift(
      request(recordedDriftTape(), { classificationSource: 'provided-or-quotes' }),
    );
    expect(result.value.summary.netDirectionalDrift).toBe(2010);
    expect(result.value.summary.unknownPremium).toBe(0);
    expect(result.value.summary.classificationCoverage).toBe(1);
  });

  it('distinguishes provided-only absence from authoritative unknown', () => {
    const absent = driftPrint({ id: 'absent' });
    delete absent.aggressorSide;
    const trades = [absent, driftPrint({ id: 'unknown', aggressorSide: 'unknown' })];
    const result = optionFlowDrift(request(trades, { classificationSource: 'provided-only' }));
    expect(result.value.summary).toMatchObject({
      netDirectionalDrift: 0,
      unknownPremium: 4000,
      classificationCoverage: 0,
      heuristic: 'low-coverage',
      bullishVolume: 0,
      bearishVolume: 0,
    });
    expect(result.value.minutes[0]!.trades.map((t) => t.classificationProvenance)).toMatchObject([
      { source: 'unavailable', providedSide: null },
      { source: 'provided', providedSide: 'unknown' },
    ]);
  });

  it('uses call/put unknown premium in per-window and cumulative bounds', () => {
    const a = driftPrint({ id: 'u-call', aggressorSide: 'unknown', premium: 200 });
    const b = driftPrint({
      id: 'u-put',
      aggressorSide: 'unknown',
      premium: 700,
      timestampMs: DRIFT_OPEN + minute,
    });
    b.contract.type = 'put';
    const r = optionFlowDrift(request([a, b]));
    expect(r.value.minutes[1]!.change).toMatchObject({
      callBounds: [0, 0],
      putBounds: [-700, 700],
      netDirectionalBounds: [-700, 700],
    });
    expect(r.value.summary).toMatchObject({
      callBounds: [-200, 200],
      putBounds: [-700, 700],
      netDirectionalBounds: [-900, 900],
    });
  });

  it('honors contract multipliers, fallback multipliers, and supplied zero premium without changing contract volume', () => {
    const custom = driftPrint({ id: 'custom', price: 2, size: 3 });
    custom.contract.multiplier = 25;
    const fallback = driftPrint({ id: 'fallback', price: 1, size: 4 });
    delete fallback.contract.multiplier;
    const zero = driftPrint({ id: 'zero', premium: 0 });
    const r = optionFlowDrift(request([custom, fallback, zero], { multiplier: 10 }));
    expect(r.value.summary).toMatchObject({
      totalPremium: 190,
      totalVolume: 17,
      classificationCoverage: 1,
    });
    expect(
      r.value.minutes[0]!.trades.map((t) => [t.premium, t.multiplier, t.premiumSource]),
    ).toEqual([
      [150, 25, 'price-size-multiplier'],
      [40, 10, 'price-size-multiplier'],
      [0, 100, 'provided'],
    ]);
    expect(optionFlowDrift(request([zero])).value.summary).toMatchObject({
      totalPremium: 0,
      classificationCoverage: null,
      heuristic: 'no-signal',
      tradeCount: 1,
    });
  });

  it('returns fresh finite empty rows, with null coverage and no invented prices', () => {
    const r = optionFlowDrift(request());
    expect(r.value.minutes).toHaveLength(390);
    expect(r.value.buckets).toHaveLength(78);
    expect(
      r.value.minutes.every(
        (b) =>
          b.trades.length === 0 && b.price === null && b.change.classificationCoverage === null,
      ),
    ).toBe(true);
    expect(r.value.summary).toMatchObject({
      tradeCount: 0,
      netDirectionalDrift: 0,
      classificationCoverage: null,
      heuristic: 'no-signal',
    });
    r.value.minutes[0]!.cumulative.callBounds[0] = 10;
    expect(r.value.minutes[1]!.cumulative.callBounds).toEqual([0, 0]);
    expect(optionFlowDrift(request()).value.minutes[0]!.cumulative.callBounds).toEqual([0, 0]);
  });

  it('keeps leading/interior/trailing empties and anchors non-divisible buckets to session open', () => {
    const r = optionFlowDrift(
      request([driftPrint({ timestampMs: DRIFT_OPEN + 2 * minute })], { bucketMinutes: 7 }),
    );
    expect(r.value.minutes[0]!.cumulative.netDirectionalDrift).toBe(0);
    expect(r.value.minutes[1]!.cumulative.netDirectionalDrift).toBe(0);
    expect(r.value.minutes[3]!).toMatchObject({
      change: { tradeCount: 0 },
      cumulative: { netDirectionalDrift: 2000 },
    });
    expect(r.value.minutes.at(-1)!.cumulative).toEqual(r.value.summary);
    expect(r.value.buckets).toHaveLength(56);
    expect(r.value.buckets[1]!.startTimestampMs).toBe(DRIFT_OPEN + 7 * minute);
    expect(r.value.buckets.at(-1)).toMatchObject({
      startTimestampMs: DRIFT_OPEN + 385 * minute,
      endTimestampMs: DRIFT_CLOSE,
      partial: false,
    });
  });

  it('maintains accounting identities and bucket/minute conservation over a mixed deterministic tape', () => {
    const trades = Array.from({ length: 90 }, (_, i) => {
      const t = driftPrint({
        id: String(i),
        timestampMs: DRIFT_OPEN + ((i * 31) % 390) * minute + i,
        price: ((i % 9) + 1) / 4,
        size: (i % 20) + 1,
        aggressorSide: (['buy', 'sell', 'unknown'] as const)[i % 3]!,
      });
      t.contract.type = i % 2 === 0 ? 'call' : 'put';
      return t;
    });
    const r = optionFlowDrift(request(trades, { bucketMinutes: 13 }));
    for (const b of [...r.value.minutes, ...r.value.buckets]) {
      accounting(b.change);
      accounting(b.cumulative);
    }
    accounting(r.value.summary);
    for (const key of [
      'totalPremium',
      'netDirectionalDrift',
      'totalVolume',
      'tradeCount',
    ] as const) {
      expect(r.value.minutes.reduce((sum, b) => sum + b.change[key], 0)).toBeCloseTo(
        r.value.summary[key],
        10,
      );
      expect(r.value.buckets.reduce((sum, b) => sum + b.change[key], 0)).toBeCloseTo(
        r.value.summary[key],
        10,
      );
    }
    expect(r.value.buckets.at(-1)!.cumulative).toEqual(r.value.summary);
  });
});

describe('explicit calendars, boundaries, cutoffs and no-lookahead', () => {
  it.each([
    ['2026-06-04', '13:30', '20:00', 390, false],
    ['2026-01-15', '14:30', '21:00', 390, false],
    ['2026-11-27', '14:30', '18:00', 210, true],
  ] as const)('uses actual NYSE session hours for %s', (date, open, close, count, isHalfDay) => {
    const r = optionFlowDrift({ trades: [], session: { date } });
    expect(r.value.minutes).toHaveLength(count);
    expect(r.value.session).toMatchObject({
      openTimestampMs: Date.parse(`${date}T${open}:00Z`),
      closeTimestampMs: Date.parse(`${date}T${close}:00Z`),
      isHalfDay,
    });
  });

  it('uses half-day close exclusively, with no trades after early close', () => {
    const open = Date.parse('2026-11-27T14:30:00Z');
    const close = Date.parse('2026-11-27T18:00:00Z');
    const trades = [open - 1, open, close - 1, close, close + 1].map((timestampMs, i) =>
      driftPrint({ id: String(i), timestampMs }),
    );
    const r = optionFlowDrift({ trades, session: { date: '2026-11-27', calendar: CBOE } });
    expect(r.value.summary.tradeCount).toBe(2);
    expect(r.value.minutes).toHaveLength(210);
    expect(r.assumptions.calendar).toBe('CBOE');
  });

  it.each(['2026-06-06', '2026-07-03'])('returns an explicit closed session for %s', (date) => {
    const r = optionFlowDrift({ trades: recordedDriftTape(), session: { date } });
    expect(r.value.session).toMatchObject({
      date,
      isBusinessDay: false,
      openTimestampMs: null,
      closeTimestampMs: null,
      endTimestampMs: null,
    });
    expect(r.value.minutes).toEqual([]);
    expect(r.value.buckets).toEqual([]);
    expect(r.value.summary.tradeCount).toBe(0);
  });

  it('does not choose the most populated date and interprets epoch ms literally', () => {
    const trades = recordedDriftTape().map((t) => ({
      ...t,
      timestampMs: t.timestampMs + 86_400_000,
    }));
    trades.push(
      driftPrint({ id: 'selected' }),
      driftPrint({ id: 'seconds', timestampMs: Math.floor(DRIFT_OPEN / 1000) }),
    );
    expect(optionFlowDrift(request(trades)).value.summary.tradeCount).toBe(1);
  });

  it('accepts core calendars, non-ET timezones, and the 24:00 sentinel', () => {
    const tokyo = createRuleCalendar({
      name: 'CUSTOM',
      version: 'test',
      timezone: 'Asia/Tokyo',
      session: { open: '09:00', close: '15:00' },
    });
    const r = optionFlowDrift({ trades: [], session: { date: DRIFT_DATE, calendar: tokyo } });
    expect(r.value.session.openTimestampMs).toBe(Date.parse(`${DRIFT_DATE}T00:00:00Z`));
    expect(r.value.minutes).toHaveLength(360);
    const continuous = optionFlowDrift({
      trades: [],
      session: { date: DRIFT_DATE, calendar: alwaysOpen },
    });
    expect(continuous.value.minutes).toHaveLength(1440);
    expect(continuous.value.session.closeTimestampMs).toBe(Date.parse('2026-06-05T00:00:00Z'));
  });

  it('rejects ambiguous/nonexistent custom calendar wall times instead of guessing DST', () => {
    for (const [date, open] of [
      ['2026-03-08', '02:30'],
      ['2026-11-01', '01:30'],
    ]) {
      const calendar = createRuleCalendar({
        name: 'DST',
        version: 'test',
        timezone: 'America/New_York',
        weekendDays: [],
        session: { open: open!, close: '04:00' },
      });
      expect(() => optionFlowDrift({ trades: [], session: { date: date!, calendar } })).toThrow(
        /ambiguous or nonexistent/,
      );
    }
  });

  it('makes market open inclusive and market/bucket close exclusive', () => {
    const trades = [
      DRIFT_OPEN - 1,
      DRIFT_OPEN,
      DRIFT_OPEN + minute - 1,
      DRIFT_OPEN + minute,
      DRIFT_CLOSE - 1,
      DRIFT_CLOSE,
    ].map((timestampMs, i) => driftPrint({ id: String(i), timestampMs }));
    const r = optionFlowDrift(request(trades));
    expect(r.value.summary.tradeCount).toBe(4);
    expect(r.value.minutes[0]!.change.tradeCount).toBe(2);
    expect(r.value.minutes[1]!.change.tradeCount).toBe(1);
    expect(r.value.minutes.at(-1)!.change.tradeCount).toBe(1);
  });

  it('cuts partial buckets exclusively and does not emit future buckets or price observations', () => {
    const cutoff = DRIFT_OPEN + 90_000;
    const trades = [cutoff - 1, cutoff, cutoff + 1].map((timestampMs, i) =>
      driftPrint({ id: String(i), timestampMs, underlyingPrice: 100 + i }),
    );
    const r = optionFlowDrift(request(trades, { asOf: cutoff, symbol: 'TEST' }));
    expect(r.value.summary.tradeCount).toBe(1);
    expect(r.value.minutes).toHaveLength(2);
    expect(r.value.minutes[0]!.price).toBeNull();
    expect(r.value.minutes[1]).toMatchObject({
      endTimestampMs: cutoff,
      partial: true,
      price: { price: 100, timestampMs: cutoff - 1 },
    });
    expect(r.value.buckets).toHaveLength(1);
    expect(r.value.buckets[0]!.partial).toBe(true);
    expect(optionFlowDrift(request(trades, { asOf: DRIFT_OPEN })).value.minutes).toEqual([]);
    expect(optionFlowDrift(request(trades, { asOf: DRIFT_OPEN - 1 })).value.minutes).toEqual([]);
    expect(optionFlowDrift(request([], { asOf: DRIFT_CLOSE + 1000 })).value.minutes).toHaveLength(
      390,
    );
  });

  it('does not add a zero-duration bucket at an exact cutoff boundary', () => {
    const r = optionFlowDrift(request(recordedDriftTape(), { asOf: DRIFT_OPEN + 5 * minute }));
    expect(r.value.minutes).toHaveLength(5);
    expect(r.value.buckets).toHaveLength(1);
    expect(r.value.minutes.every((b) => !b.partial)).toBe(true);
    expect(r.value.buckets[0]!.partial).toBe(false);
  });

  it('has prefix-invariant analytics and prices when future observations are appended', () => {
    const tape = recordedDriftTape();
    const config = { symbol: 'TEST', asOf: DRIFT_OPEN + 2 * minute };
    const base = optionFlowDrift(request(tape.slice(0, 2), config));
    tape[4]!.underlyingPrice = 999;
    const extended = optionFlowDrift(request(tape, config));
    expect(extended).toEqual(base);
    const full = optionFlowDrift(request(tape, { symbol: 'TEST' }));
    expect(full.value.minutes.slice(0, 2)).toEqual(base.value.minutes);
    expect(full.value.minutes.slice(0, 4).every((b) => b.price === null)).toBe(true);
  });
});

describe('symbol scope and as-of underlying overlays', () => {
  it('never mixes spot levels across underlyings; marketwide overlay requires an explicit symbol', () => {
    const a = driftPrint({ id: 'a', underlyingPrice: 100 });
    const b = driftPrint({ id: 'b', underlyingPrice: 600, timestampMs: DRIFT_OPEN + minute });
    b.contract.underlying = 'SPY';
    const market = optionFlowDrift(request([a, b]));
    expect(market.value.summary.tradeCount).toBe(2);
    expect(market.value.minutes.every((m) => m.price === null)).toBe(true);
    const proxy = optionFlowDrift(request([a, b], { priceOverlay: { symbol: 'SPY' } }));
    expect(proxy.value.minutes[0]!.price).toBeNull();
    expect(proxy.value.minutes[1]!.price).toMatchObject({ symbol: 'SPY', price: 600 });
    const scoped = optionFlowDrift(
      request([a, b], { symbol: 'TEST', priceOverlay: { symbol: 'SPY' } }),
    );
    expect(scoped.value.summary.tradeCount).toBe(1);
    expect(scoped.value.minutes[1]!.price).toMatchObject({ symbol: 'SPY', price: 600 });
    const own = optionFlowDrift(request([a, b], { symbol: 'TEST' }));
    expect(own.value.minutes[0]!.price).toMatchObject({ symbol: 'TEST', price: 100 });
    expect(own.value.minutes.at(-1)!.price!.price).toBe(100);
    expect(optionFlowDrift(request([a, b], { symbol: 'test' })).value.summary.tradeCount).toBe(0);
  });

  it('uses underlying quotes/trades independently of option prints, with exclusive as-of and explicit tie precedence', () => {
    const r = optionFlowDrift(
      request([driftPrint({ underlyingPrice: 50 })], {
        symbol: 'TEST',
        asOf: DRIFT_OPEN + 3 * minute,
        priceOverlay: {
          symbol: 'TEST',
          quotes: [
            { symbol: 'TEST', timestampMs: DRIFT_OPEN - 1, bid: 9, ask: 11 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN, bid: 99, ask: 101 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN + minute, bid: 109, ask: 111 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN + 3 * minute, bid: 999, ask: 1001 },
          ],
          trades: [
            { symbol: 'TEST', timestampMs: DRIFT_OPEN, price: 102, size: 1 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN, price: 103, size: 1 },
            { symbol: 'OTHER', timestampMs: DRIFT_OPEN + minute, price: 999, size: 1 },
          ],
        },
      }),
    );
    expect(r.value.minutes.map((b) => b.price?.price)).toEqual([103, 110, 110]);
    expect(r.value.minutes[0]!.price!.source).toBe('underlying-trade');
    expect(r.value.minutes[1]!.price!.source).toBe('underlying-quote-midpoint');
  });

  it('never carries pre-session prices and leaves missing/bad-sided overlays null', () => {
    const r = optionFlowDrift(
      request([], {
        asOf: DRIFT_OPEN + minute,
        priceOverlay: {
          symbol: 'TEST',
          quotes: [
            { symbol: 'TEST', timestampMs: DRIFT_OPEN - 1, bid: 100, ask: 101 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN, bid: 0, ask: 101 },
            { symbol: 'TEST', timestampMs: DRIFT_OPEN, bid: 102, ask: 101 },
          ],
        },
      }),
    );
    expect(r.value.minutes[0]!.price).toBeNull();
    expect(r.value.summary.tradeCount).toBe(0);
  });

  it('uses locked underlying quotes as prices, while locked option quotes remain direction-unknown', () => {
    const r = optionFlowDrift(
      request([driftPrint({ bid: 2, ask: 2 })], {
        classificationSource: 'quotes-only',
        priceOverlay: {
          symbol: 'TEST',
          quotes: [{ symbol: 'TEST', timestampMs: DRIFT_OPEN, bid: 100, ask: 100 }],
        },
      }),
    );
    expect(r.value.summary.unknownPremium).toBe(2000);
    expect(r.value.minutes[0]!.price!.price).toBe(100);
  });
});

describe('ordering, duplicate policy, finite boundaries and descriptive heuristics', () => {
  it('stably sorts a copy, preserves tied input order, and never exposes live input references', () => {
    const tape = recordedDriftTape().reverse();
    tape[4]!.underlyingPrice = 100;
    const snapshot = JSON.parse(JSON.stringify(tape));
    tape.forEach((t) => {
      Object.freeze(t.contract);
      Object.freeze(t);
    });
    Object.freeze(tape);
    const a = optionFlowDrift(request(tape, { symbol: 'TEST' }));
    const b = optionFlowDrift(request(tape, { symbol: 'TEST' }));
    expect(a).toEqual(b);
    expect(tape).toEqual(snapshot);
    expect(a.value.buckets[0]!.trades.map((t) => t.inputIndex)).toEqual([4, 3, 2, 1, 0]);
    const tied = optionFlowDrift(request([driftPrint({ id: 'z' }), driftPrint({ id: 'a' })]));
    expect(tied.value.minutes[0]!.trades.map((t) => t.id)).toEqual(['z', 'a']);
    a.value.minutes[0]!.trades[0]!.classificationProvenance.providedSide = 'sell';
    expect(a.value.buckets[0]!.trades[0]!.classificationProvenance.providedSide).toBe('buy');
    expect(b.value.minutes[0]!.trades[0]!.classificationProvenance.providedSide).toBe('buy');
  });

  it('rejects repeated IDs, including conflicting prints and IDs outside scope', () => {
    const a = driftPrint();
    const b = driftPrint({ price: 3, timestampMs: DRIFT_CLOSE });
    b.contract.underlying = 'OTHER';
    expect(() => optionFlowDrift(request([a, a]))).toThrow(/duplicates/);
    expect(() => optionFlowDrift(request([a, b], { symbol: 'TEST' }))).toThrow(/duplicates/);
  });

  it('rejects indistinguishable ID-less duplicates, but counts distinct IDs/sequences/venues', () => {
    const a = driftPrint();
    delete a.id;
    expect(() => optionFlowDrift(request([a, { ...a }]))).toThrow(/unique IDs/);
    expect(
      optionFlowDrift(request([driftPrint({ id: 'a' }), driftPrint({ id: 'b' })])).value.summary
        .tradeCount,
    ).toBe(2);
    expect(
      optionFlowDrift(
        request([
          { ...a, sequence: 1 },
          { ...a, sequence: 2 },
        ]),
      ).value.summary.tradeCount,
    ).toBe(2);
    expect(
      optionFlowDrift(
        request([
          { ...a, exchange: 'X' },
          { ...a, exchange: 'Y' },
        ]),
      ).value.summary.tradeCount,
    ).toBe(2);
  });

  it.each([
    undefined,
    null,
    [],
    1,
    { trades: [], session: { date: DRIFT_DATE }, typo: 1 },
    { trades: null, session: { date: DRIFT_DATE } },
    { trades: {}, session: { date: DRIFT_DATE } },
    { trades: [], session: null },
    { trades: [], session: { date: DRIFT_DATE, timeZone: 'UTC' } },
    { trades: [], session: { date: '2026-02-30' } },
    { trades: [], session: { date: '2026-06-04T00:00:00Z' } },
    { trades: [], session: { date: DRIFT_DATE, calendar: null } },
    { trades: [], session: { date: DRIFT_DATE, calendar: {} } },
    { trades: [], session: { date: DRIFT_DATE }, config: null },
  ])('rejects malformed or open-ended requests %j with typed errors', (input) => {
    expect(() => optionFlowDrift(input as never)).toThrow(InputError);
  });

  it.each([
    { typo: 1 },
    { symbol: '' },
    { symbol: null },
    { bucketMinutes: 0 },
    { bucketMinutes: 1.5 },
    { bucketMinutes: 1441 },
    { bucketMinutes: Infinity },
    { bucketMinutes: null },
    { asOf: NaN },
    { asOf: '2026-06-04' },
    { asOf: null },
    { asOf: DRIFT_OPEN + 0.5 },
    { classificationSource: null },
    { classificationSource: 'unknown' },
    { multiplier: 0 },
    { multiplier: Infinity },
    { multiplier: null },
    { minimumClassificationCoverage: -1 },
    { minimumClassificationCoverage: 1.01 },
    { minimumClassificationCoverage: null },
    { priceOverlay: null },
    { priceOverlay: {} },
    { priceOverlay: { symbol: 'TEST', typo: 1 } },
    { priceOverlay: { symbol: 'TEST', quotes: null } },
    { priceOverlay: { symbol: 'TEST', trades: [null] } },
    {
      priceOverlay: {
        symbol: 'TEST',
        quotes: [{ symbol: 'TEST', timestampMs: NaN, bid: 1, ask: 2 }],
      },
    },
    {
      priceOverlay: {
        symbol: 'TEST',
        trades: [{ symbol: 'TEST', timestampMs: DRIFT_OPEN, price: Infinity, size: 1 }],
      },
    },
  ])('rejects malformed configuration %j even on empty data', (config) => {
    expect(() => optionFlowDrift(request([], config as never))).toThrow(InputError);
  });

  it.each([
    { timestampMs: NaN },
    { timestampMs: Infinity },
    { timestampMs: 8.64e15 + 1 },
    { timestampMs: DRIFT_OPEN + 0.1 },
    { timestampMs: '1780580000000' },
    { price: 0 },
    { price: -1 },
    { price: NaN },
    { size: -1 },
    { premium: -1 },
    { premium: Infinity },
    { premium: null },
    { bid: NaN },
    { ask: -1 },
    { aggressorSide: 'BUY' },
    { aggressorSide: null },
    { id: '' },
    { id: 1 },
    { sequence: 0.1 },
    { sequence: -1 },
    { exchange: '' },
    { underlyingPrice: Infinity },
    { underlyingPrice: 0 },
    { contract: null },
    { contract: { type: 'stock' } },
  ])('rejects malformed prints %j without coercion', (overrides) => {
    expect(() => optionFlowDrift(request([driftPrint(overrides as never)]))).toThrow(InputError);
  });

  it('keeps vendor trade metadata open but rejects bad trade/contract shapes and consumed enums', () => {
    const data = { ...driftPrint(), vendorTag: 'preserved-input' };
    expect(optionFlowDrift(request([data])).value.summary.tradeCount).toBe(1);
    for (const trade of [null, undefined, [], 3])
      expect(() => optionFlowDrift(request([trade as never]))).toThrow(InputError);
    for (const contract of [
      [],
      { ...data.contract, type: 'stock' },
      { ...data.contract, underlying: '' },
      { ...data.contract, expiry: null },
    ]) {
      expect(() => optionFlowDrift(request([{ ...data, contract: contract as never }]))).toThrow(
        InputError,
      );
    }
  });

  it('rejects finite-input overflow in computed premium, sums and unknown bounds', () => {
    expect(() => optionFlowDrift(request([driftPrint({ price: 1e308 })]))).toThrow(InputError);
    expect(() =>
      optionFlowDrift(
        request([driftPrint({ id: 'a', premium: 1e308 }), driftPrint({ id: 'b', premium: 1e308 })]),
      ),
    ).toThrow(InputError);
    expect(() =>
      optionFlowDrift(
        request([
          driftPrint({ id: 'a', size: 1e308, premium: 1 }),
          driftPrint({ id: 'b', size: 1e308, premium: 1 }),
        ]),
      ),
    ).toThrow(InputError);
  });

  it.each([
    [null, 'input.wrong_type'],
    ['2', 'input.wrong_type'],
    [NaN, 'input.nan'],
    [Infinity, 'input.not_finite'],
  ])('uses the core numeric error taxonomy for %s', (value, code) => {
    const calls = [
      () => optionFlowDrift(request([], { multiplier: value as never })),
      () => optionFlowDrift(request([], { asOf: value as never })),
      () => optionFlowDrift(request([driftPrint({ price: value as never })])),
      () => optionFlowDrift(request([driftPrint({ underlyingPrice: value as never })])),
    ];
    for (const call of calls) {
      expect(call).toThrow(expect.objectContaining({ code }));
    }
  });

  it('rejects missing required numeric fields and sparse overlay arrays with typed errors', () => {
    const t = driftPrint();
    delete (t as Partial<OptionFlowDriftTrade>).price;
    expect(() => optionFlowDrift(request([t]))).toThrow(
      expect.objectContaining({ code: 'input.missing_field' }),
    );
    expect(() =>
      optionFlowDrift(request([], { priceOverlay: { symbol: 'TEST', quotes: new Array(1) } })),
    ).toThrow(InputError);
    const idless = driftPrint({ underlyingPrice: 1n as never });
    delete idless.id;
    expect(() => optionFlowDrift(request([idless]))).toThrow(InputError);
  });

  it.each([
    { open: '9:30', close: '16:00' },
    { open: '16:00', close: '09:30' },
    { open: '09:30', close: '09:30' },
  ])('rejects malformed calendar sessions %j', (hours) => {
    const calendar: Calendar = {
      ...NYSE,
      session: (date) => ({ date, isBusinessDay: true, isHalfDay: false, ...hours }),
    };
    expect(() => optionFlowDrift({ trades: [], session: { date: DRIFT_DATE, calendar } })).toThrow(
      InputError,
    );
  });

  it('rejects invalid timezones and malformed custom calendar results', () => {
    expect(() =>
      optionFlowDrift({
        trades: [],
        session: { date: DRIFT_DATE, calendar: { ...NYSE, timezone: 'Not/A/Zone' } },
      }),
    ).toThrow(InputError);
    expect(() =>
      optionFlowDrift({
        trades: [],
        session: { date: DRIFT_DATE, calendar: { ...NYSE, session: () => null as never } },
      }),
    ).toThrow(InputError);
    expect(() =>
      optionFlowDrift({
        trades: [],
        session: {
          date: DRIFT_DATE,
          calendar: {
            ...NYSE,
            session: () => ({ date: 'wrong', isBusinessDay: true, isHalfDay: false }),
          },
        },
      }),
    ).toThrow(InputError);
  });

  it('states same-window heuristics and lets opposing volume suppress expansion', () => {
    const call = driftPrint({ id: 'call', premium: 2000, size: 1 });
    const put = driftPrint({ id: 'put', premium: 100, size: 1, aggressorSide: 'sell' });
    put.contract.type = 'put';
    const opposing = driftPrint({ id: 'opposed', premium: 10, size: 100, aggressorSide: 'sell' });
    expect(optionFlowDrift(request([call, put])).value.summary.heuristic).toBe('bullish-expansion');
    expect(optionFlowDrift(request([call, put, opposing])).value.summary).toMatchObject({
      heuristic: 'volume-opposed',
      volumeConfirmation: 'opposed',
    });
    const reverse = [call, put].map((t) => ({
      ...t,
      aggressorSide: t.aggressorSide === 'buy' ? ('sell' as const) : ('buy' as const),
    }));
    expect(optionFlowDrift(request(reverse)).value.summary.heuristic).toBe('bearish-expansion');
    expect(optionFlowDrift(request([call])).value.summary.heuristic).toBe('mixed-flow');
    const unknown = driftPrint({ id: 'u', premium: 2000, aggressorSide: 'unknown' });
    expect(optionFlowDrift(request([call, unknown])).value.summary.heuristic).toBe('low-coverage');
    expect(
      optionFlowDrift(request([call, unknown], { minimumClassificationCoverage: 0.5 })).value
        .summary.heuristic,
    ).toBe('mixed-flow');
    expect(
      optionFlowDrift(request([call, { ...call, id: 'sell', aggressorSide: 'sell' }])).value.summary
        .heuristic,
    ).toBe('no-signal');
  });
});
