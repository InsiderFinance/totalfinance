/**
 * Strategy-package hardening matrix (2026-08 defect-fix wave).
 *
 * Three tables plus the point fixes:
 *   1. builder strike-ordering — a documented precondition that nothing enforced, so a swapped slot
 *      silently built a DIFFERENT structure under the requested name;
 *   2. `strategyFromChain` row shape — the scanner's flat row grammar crashed with a raw TypeError;
 *   3. `scanStrategies` asOf — ISO strings were rejected at this boundary alone;
 *   plus the Kelly horizon knob, the stock-leg share count, the undefined-risk reward ratio, and the
 *   real-world measure's required drift.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  classifyStrategy,
  explainPosition,
  legs,
  optimizeStrategy,
  scanStrategies,
  strategy,
  strategyFromChain,
} from '@totalfinance/strategy';
import type { ScanQuoteRow } from '@totalfinance/strategy/scanner';

const MARKET = {
  spot: 105,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
  expiry: '2026-06-19',
} as const;
const MODEL = { premiums: 'model', market: MARKET } as const;

// ─────────────────────── 1. the builder strike-ordering table ───────────────────────

/**
 * Every row: a builder, a VALID ascending input, and the same input with one documented ordering
 * broken. The valid call must build; the broken call must throw and name the violated pair.
 *
 * The sample spans every ordering family in the catalog: 2-slot verticals, `lower < upper` combos
 * and guts, strangle-shaped put/call pairs, 3-slot ladders / broken wings / butterflies, the
 * iron-butterfly `putWing < body < callWing`, 4-slot single-type condors, the iron condors, the
 * jade lizards' one-sided promise, and the ratio spreads (whose "further" leg sits above for calls
 * and below for puts).
 */
interface OrderingRow {
  name: string;
  build: (input: Record<string, unknown>) => unknown;
  valid: Record<string, unknown>;
  /** The same input with one ordering inverted. */
  broken: Record<string, unknown>;
  /** Substring the error must name — the slots on the violated side. */
  names: RegExp;
}

const ROWS: OrderingRow[] = [
  {
    name: 'bullCallSpread',
    build: (i) => strategy.bullCallSpread(i as never, MODEL),
    valid: { long: 100, short: 110 }, // long lower, short higher (debit)
    broken: { long: 110, short: 100 },
    names: /long .* is above short/,
  },
  {
    name: 'bearPutSpread',
    build: (i) => strategy.bearPutSpread(i as never, MODEL),
    valid: { long: 105, short: 95 }, // long HIGHER put ⇒ ascending order is short < long
    broken: { long: 95, short: 105 },
    names: /short .* is above long/,
  },
  {
    name: 'strangle',
    build: (i) => strategy.strangle(i as never, MODEL),
    valid: { call: 115, put: 95 }, // OTM call above, OTM put below
    broken: { call: 95, put: 115 }, // inverted ⇒ that is a `guts`, not a strangle
    names: /put .* is above call/,
  },
  {
    name: 'guts',
    build: (i) => strategy.guts(i as never, MODEL),
    valid: { lower: 95, upper: 115 },
    broken: { lower: 115, upper: 95 },
    names: /lower .* is above upper/,
  },
  {
    name: 'longCombo',
    build: (i) => strategy.longCombo(i as never, MODEL),
    valid: { lower: 95, upper: 115 },
    broken: { lower: 115, upper: 95 },
    names: /lower .* is above upper/,
  },
  {
    name: 'bullCallLadder',
    build: (i) => strategy.bullCallLadder(i as never, MODEL),
    valid: { lower: 100, middle: 110, upper: 120 },
    broken: { lower: 100, middle: 120, upper: 110 }, // middle above upper
    names: /middle .* is above upper/,
  },
  {
    name: 'callBrokenWing',
    build: (i) => strategy.callBrokenWing(i as never, MODEL),
    valid: { lower: 100, middle: 110, upper: 125 },
    broken: { lower: 110, middle: 100, upper: 125 }, // lower above middle
    names: /lower .* is above middle/,
  },
  {
    name: 'longCallButterfly',
    build: (i) => strategy.longCallButterfly(i as never, MODEL),
    valid: { lower: 95, middle: 105, upper: 115 },
    broken: { lower: 95, middle: 115, upper: 105 },
    names: /middle .* is above upper/,
  },
  {
    name: 'longCallCondor',
    build: (i) => strategy.longCallCondor(i as never, MODEL),
    valid: { k1: 90, k2: 100, k3: 110, k4: 120 },
    broken: { k1: 90, k2: 110, k3: 100, k4: 120 }, // k2/k3 swapped
    names: /k2 .* is above k3/,
  },
  {
    name: 'ironButterfly',
    build: (i) => strategy.ironButterfly(i as never, MODEL),
    valid: { body: { strike: 105 }, putWing: 95, callWing: 115 },
    broken: { body: { strike: 105 }, putWing: 110, callWing: 115 }, // put wing ABOVE the body
    names: /putWing .* is above body/,
  },
  {
    name: 'jadeLizard',
    build: (i) => strategy.jadeLizard(i as never, MODEL),
    valid: { put: 95, shortCall: 110, longCall: 115 },
    broken: { put: 95, shortCall: 115, longCall: 110 }, // the long call must be HIGHER
    names: /shortCall .* is above longCall/,
  },
  {
    name: 'putRatioSpread',
    build: (i) => strategy.putRatioSpread(i as never, MODEL),
    valid: { long: 105, short: 95 }, // the FURTHER (short) put sits below
    broken: { long: 95, short: 105 },
    names: /short .* is above long/,
  },
];

describe('builder strike ordering: the documented precondition is enforced', () => {
  for (const row of ROWS) {
    it(`${row.name}: the valid ordering builds, the inverted one throws`, () => {
      expect(() => row.build(row.valid)).not.toThrow();
      let thrown: unknown;
      try {
        row.build(row.broken);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${row.name} accepted an inverted ordering`).toBeDefined();
      expect(isQuantError(thrown)).toBe(true);
      const e = thrown as { message: string; code?: string; context?: Record<string, unknown> };
      expect(e.code).toBe('input.out_of_range');
      expect(e.message).toMatch(new RegExp(`strategy\\.${row.name}`));
      expect(e.message).toMatch(/must be ascending/);
      expect(e.message).toMatch(row.names);
      // The error echoes exactly what was passed, so the caller can see their own numbers.
      expect(e.context?.['received']).toBeDefined();
    });
  }

  it('the full catalog still builds from its own examples (happy paths unchanged)', async () => {
    const { strategyRegistry } = await import('../src/manifest.js');
    for (const entry of strategyRegistry()) {
      expect(
        () => entry.builder(entry.example as never, MODEL),
        `${entry.name} no longer builds from its own manifest example`,
      ).not.toThrow();
    }
  });

  it('equal strikes are rejected too — an ascending precondition is strict', () => {
    // A "butterfly" whose middle equals its upper is not a butterfly; it is a two-strike position
    // with a doubled leg, and its metrics describe something the caller did not ask for.
    expect(() => strategy.longCallButterfly({ lower: 95, middle: 105, upper: 105 }, MODEL)).toThrow(
      /middle \(105\) equals upper \(105\)/,
    );
  });
});

describe('the ordering error names the builder the caller actually described', () => {
  it('a fully mirrored ironCondor is answered with "did you want inverseIronCondor?"', () => {
    // Mirroring BOTH pairs (putLong↔putShort and callShort↔callLong) turns the credit condor into
    // a textbook reverse iron condor: long the inner strangle, short the outer wings. The legs are
    // classified structurally, so the hint is derived, never hard-coded.
    let thrown: unknown;
    try {
      strategy.ironCondor({ putLong: 95, putShort: 90, callShort: 115, callLong: 110 }, MODEL);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as { message: string };
    expect(e.message).toMatch(/inverseIronCondor/);
    expect(e.message).toMatch(/did you want/i);

    // …and the hint is true: that leg set really does classify as an inverseIronCondor.
    const mirrored = strategy.inverseIronCondor(
      { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
      MODEL,
    );
    expect(classifyStrategy(mirrored).matches.map((m) => m.name)).toContain('inverseIronCondor');
  });

  it('a put-side-only swap is a plain ordering error with no false hint', () => {
    // Swapping only the puts builds a debit put spread beside a credit call spread — that matches
    // NO catalog builder, so the error must not invent one.
    let thrown: unknown;
    try {
      strategy.ironCondor({ putLong: 95, putShort: 90, callShort: 110, callLong: 115 }, MODEL);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as { message: string; context?: Record<string, unknown> };
    expect(e.message).toMatch(/putLong \(95\) is above putShort \(90\)/);
    expect(e.message).not.toMatch(/did you want/i);
    expect(e.context?.['expected']).toBe('putLong < putShort < callShort < callLong');
  });

  it('the swapped condor no longer builds a mislabelled position at all (the original repro)', () => {
    // Before the fix this returned a Position stamped `constructedAs: 'ironCondor'` whose legs were
    // an inverse condor — a DEBIT structure reported under a credit structure's name.
    expect(() =>
      strategy.ironCondor({ putLong: 95, putShort: 90, callShort: 115, callLong: 110 }, MODEL),
    ).toThrow();
  });
});

// ─────────────────────── 2. the from-chain row-shape table ───────────────────────

const CONTRACT = (type: 'call' | 'put', strike: number) => ({
  underlying: 'XYZ',
  type,
  strike,
  expiry: '2026-06-19',
});

const NESTED_ROWS = [
  { contract: CONTRACT('put', 95), mid: 1.2, greeks: { delta: -0.2 }, timestampMs: 0 },
  { contract: CONTRACT('put', 90), mid: 0.6, greeks: { delta: -0.1 }, timestampMs: 0 },
  { contract: CONTRACT('call', 115), mid: 1.1, greeks: { delta: 0.2 }, timestampMs: 0 },
  { contract: CONTRACT('call', 120), mid: 0.5, greeks: { delta: 0.1 }, timestampMs: 0 },
];

describe('strategyFromChain shape guard: flat scanner rows teach, never TypeError', () => {
  /** row shape → the guard's verdict. */
  const SHAPES: { label: string; rows: unknown[]; match: RegExp }[] = [
    {
      label: "the scanner's FLAT ScanQuoteRow grammar",
      rows: [
        { strike: 95, call: 1.1, put: 1.2 },
        { strike: 105, call: 0.6, put: 2.4 },
      ],
      match: /FLAT per-strike row[\s\S]*scanStrategies/,
    },
    {
      label: 'a flat row carrying only bid/ask columns',
      rows: [{ strike: 95, callBid: 1, callAsk: 1.2 }],
      match: /FLAT per-strike row/,
    },
    {
      label: 'a nested row whose contract is missing expiry',
      rows: [{ contract: { underlying: 'XYZ', type: 'call', strike: 100 }, mid: 1 }],
      match: /contract is missing the fields strike\/expiry\/type/,
    },
    {
      label: 'a primitive row',
      rows: [42],
      match: /expected rows: OptionQuote\[\]/,
    },
    {
      label: 'a null row',
      rows: [null],
      match: /expected rows: OptionQuote\[\]/,
    },
  ];

  for (const shape of SHAPES) {
    it(`${shape.label} is answered with a teaching error`, () => {
      let thrown: unknown;
      try {
        strategyFromChain(shape.rows as never, {
          type: 'ironCondor',
          expiry: '2026-06-19',
          shortDelta: 0.2,
          wingWidth: 5,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect(isQuantError(thrown)).toBe(true);
      const e = thrown as { message: string; code?: string };
      expect(e.code).toBe('input.wrong_shape');
      expect(e.message).toMatch(/^strategyFromChain:/);
      expect(e.message).toMatch(shape.match);
    });
  }

  it('the flat-row error names the API that DOES take that shape, and that API works', () => {
    const chain: ScanQuoteRow[] = [
      { strike: 95, call: 11.2, put: 1.2 },
      { strike: 105, call: 4.8, put: 4.5 },
      { strike: 115, call: 1.4, put: 11.0 },
    ];
    let thrown: unknown;
    try {
      strategyFromChain(chain as never, {
        type: 'straddle',
        expiry: '2026-06-19',
        strike: 105,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { message: string }).message).toMatch(/scanStrategies\(\{ chain, … \}\)/);
    // The suggested call really does accept these rows.
    const scan = scanStrategies({
      spot: 105,
      asOf: '2026-01-02T00:00:00Z',
      expiry: '2026-06-19',
      riskFreeRate: 0.04,
      volatility: 0.2,
      chain,
      structures: ['straddle'],
    });
    expect(scan.candidates.length).toBeGreaterThan(0);
  });

  it('a well-formed nested chain still builds (happy path unchanged)', () => {
    const built = strategyFromChain(NESTED_ROWS as never, {
      type: 'ironCondor',
      expiry: '2026-06-19',
      shortDelta: 0.2,
      wingWidth: 5,
    });
    expect(built.legs).toHaveLength(4);
    expect(built.position.constructedAs).toBe('ironCondor');
  });
});

// ─────────────────────── 3. scanner asOf accepts the shared grammar ───────────────────────

describe('scanStrategies resolves asOf like every other market boundary', () => {
  const chain: ScanQuoteRow[] = [
    { strike: 95, call: 11.2, put: 1.2 },
    { strike: 100, call: 7.4, put: 2.4 },
    { strike: 105, call: 4.8, put: 4.5 },
    { strike: 110, call: 2.8, put: 7.4 },
    { strike: 115, call: 1.4, put: 11.0 },
  ];
  const base = {
    spot: 105,
    expiry: '2026-06-19',
    riskFreeRate: 0.04,
    volatility: 0.2,
    chain,
  } as const;

  it('an ISO date string is accepted and matches the epoch-ms call exactly', () => {
    const iso = scanStrategies({ ...base, asOf: '2026-01-02T00:00:00Z' });
    const ms = scanStrategies({ ...base, asOf: Date.UTC(2026, 0, 2) });
    expect(iso.assumptions.timeToExpiryYears).toBeCloseTo(ms.assumptions.timeToExpiryYears, 15);
    expect(iso.candidates[0]!.score!).toBeCloseTo(ms.candidates[0]!.score!, 12);
  });

  it('a zoned ISO datetime is accepted', () => {
    expect(() => scanStrategies({ ...base, asOf: '2026-01-02T14:30:00Z' })).not.toThrow();
  });

  it('a BARE datetime is still refused — it would parse in the machine local zone', () => {
    expect(() => scanStrategies({ ...base, asOf: '2026-01-02T14:30:00' as never })).toThrow(
      /timezone/,
    );
  });

  it('unparseable junk still teaches the accepted forms', () => {
    expect(() => scanStrategies({ ...base, asOf: 'last tuesday' as never })).toThrow(
      /epoch milliseconds/,
    );
  });
});

// ─────────────────────── 4. the Kelly horizon knob ───────────────────────

describe('optimizer Kelly sizing forwards horizonPeriods end to end', () => {
  const chain: ScanQuoteRow[] = [
    { strike: 95, call: 11.2, put: 1.2 },
    { strike: 100, call: 7.4, put: 2.4 },
    { strike: 105, call: 4.8, put: 4.5 },
    { strike: 110, call: 2.8, put: 7.4 },
    { strike: 115, call: 1.4, put: 11.0 },
  ];
  const run = (sizing: Record<string, unknown>) =>
    optimizeStrategy({
      spot: 105,
      asOf: Date.UTC(2026, 0, 2),
      riskFreeRate: 0.04,
      volatility: 0.2,
      expiries: [{ expiry: '2026-06-19', chain }],
      thesis: { targetPrice: 112, volatility: 0.25 },
      structures: ['bullCallSpread'],
      top: 5,
      sizing: sizing as never,
    });

  it('{ enabled, horizonPeriods } produces a horizonGrowth projection', () => {
    const sized = run({ enabled: true, horizonPeriods: 12 });
    const candidate = sized.candidates.find((c) => c.kelly?.status === 'sized')!;
    const kelly = candidate.kelly!;
    expect(kelly.status).toBe('sized');
    if (kelly.status !== 'sized') throw new Error('expected a sized verdict');
    const growth = kelly.sizing.horizonGrowth;
    expect(growth).toBeDefined();
    expect(growth!.horizonPeriods).toBe(12);
    // The projection IS the per-period growth rate compounded over the horizon — check it against
    // the sizing's own growthRate rather than against itself.
    expect(kelly.sizing.growthRate).not.toBeNull();
    expect(growth!.logGrowth).toBeCloseTo(12 * kelly.sizing.growthRate!, 12);
    expect(growth!.growthMultiple).toBeCloseTo(Math.exp(12 * kelly.sizing.growthRate!), 12);
  });

  it('omitting the horizon leaves horizonGrowth absent (the knob is opt-in)', () => {
    const sized = run({ enabled: true });
    const kelly = sized.candidates.find((c) => c.kelly?.status === 'sized')!.kelly!;
    const growth = kelly.status === 'sized' ? kelly.sizing.horizonGrowth : undefined;
    expect(growth).toBeUndefined();
  });

  it('the RETIRED `horizon` spelling is now rejected instead of silently ignored', () => {
    // It used to be allow-listed and then dropped on the floor — accepted, and dead.
    expect(() => run({ enabled: true, horizon: 12 })).toThrow(/horizon/);
  });
});

// ─────────────────────── 5. explainPosition: shares and undefined risk ───────────────────────

describe('explainPosition describes the position it was given', () => {
  it('a 1-lot covered call is 100 shares, not 10 000', () => {
    // `coveredCall` builds `legs.stock({ quantity: 100 · contracts })` — the quantity is ALREADY
    // in shares, so the prose must not re-apply the multiplier.
    const e = explainPosition(
      strategy.coveredCall({ stockPrice: 105, strike: 115, premium: 2 }, { expiry: '2026-06-19' }),
      { underlyingLabel: 'XYZ' },
    );
    expect(e.structure).toContain('long 100 shares');
    expect(e.structure).not.toContain('10000');
  });

  it('a 3-lot covered call scales to 300 shares', () => {
    const e = explainPosition(
      strategy.coveredCall(
        { stockPrice: 105, strike: 115, premium: 2, quantity: 3 },
        { expiry: '2026-06-19' },
      ),
    );
    expect(e.structure).toContain('long 300 shares');
  });

  it('an undefined-risk position reports rewardToRisk null, matching probability().riskReward', () => {
    // A naked short call: the maximum loss is unbounded, so |maxProfit / maxLoss| has no value.
    // It is `null` with the reason (B3) — neither `Infinity` (which read as the most attractive
    // structure in the catalog) nor a bare 0 (which read as "no reward").
    const short = strategy.shortCall({ strike: 115, premium: 2 }, { expiry: '2026-06-19' });
    const e = explainPosition(short, { market: { ...MARKET } });
    expect(e.definedRisk).toBe(false);
    expect(e.economics.rewardToRisk).toBeNull();
    expect(e.economics.maxLoss).toBeNull();
    // The two engine reads of the same position agree, and the probability read says why.
    const p = short.probability({ ...MARKET });
    expect(p.riskReward).toBeNull();
    expect(p.diagnostics.warnings[0]).toMatchObject({ code: 'strategy.risk_reward_undefined' });
    expect(p.diagnostics.warnings[0]!.message).toContain('maximum loss is unbounded');
    // …and the prose says WHY it is null.
    expect(e.summary).toMatch(/undefined risk/i);
    expect(e.summary).toMatch(/reported as null/);
  });

  it('a DEFINED-risk position keeps its real ratio and says nothing about undefined risk', () => {
    // bullCallSpread 100/110 at 5.20 / 1.80: net debit 3.40 ⇒ per contract maxLoss = −340,
    // maxProfit = (10 − 3.40) × 100 = 660 ⇒ rewardToRisk = 660 / 340 = 1.9411764…
    const spread = strategy.bullCallSpread(
      { long: { strike: 100, premium: 5.2 }, short: { strike: 110, premium: 1.8 } },
      { expiry: '2026-06-19' },
    );
    const e = explainPosition(spread);
    expect(e.definedRisk).toBe(true);
    expect(e.economics.maxLoss).toBeCloseTo(-340, 9);
    expect(e.economics.maxProfit).toBeCloseTo(660, 9);
    expect(e.economics.rewardToRisk).toBeCloseTo(660 / 340, 12);
    expect(e.summary).not.toMatch(/undefined risk/i);
  });
});

// ─────────────────────── 6. the realWorld measure requires its drift ───────────────────────

describe("measure: 'realWorld' requires expectedReturn", () => {
  const pos = () =>
    strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })], { expiry: MARKET.expiry });
  const market = {
    spot: 100,
    volatility: 0.25,
    riskFreeRate: 0.04,
    asOf: '2026-01-02T00:00:00Z',
  } as const;

  it('omitting it throws instead of silently returning the risk-neutral answer', () => {
    let thrown: unknown;
    try {
      pos().probability({ ...market, measure: 'realWorld' });
    } catch (err) {
      thrown = err;
    }
    expect(isQuantError(thrown)).toBe(true);
    const e = thrown as { message: string; code?: string };
    expect(e.code).toBe('input.missing_field');
    expect(e.message).toMatch(/measure 'realWorld' requires expectedReturn/);
    // The teaching error offers both ways out.
    expect(e.message).toMatch(/expectedReturn: 0\.08/);
    expect(e.message).toMatch(/risk-neutral default/);
  });

  it('the Monte-Carlo path enforces the same contract', () => {
    expect(() =>
      pos().monteCarloProbability({ ...market, measure: 'realWorld', seed: 7, paths: 100 }),
    ).toThrow(/requires expectedReturn/);
  });

  it('supplying it works and really does move the drift', () => {
    const p = pos().probability({ ...market, measure: 'realWorld', expectedReturn: 0.12 });
    expect(p.assumptions.probabilityModel.measure).toBe('realWorld');
    expect(p.assumptions.probabilityModel.drift).toBeCloseTo(0.12, 12);
    const rn = pos().probability({ ...market });
    expect(p.probabilityOfProfit).toBeGreaterThan(rn.probabilityOfProfit);
  });

  it('expectedReturn under the risk-neutral measure is a contradiction, not a no-op', () => {
    // It was silently ignored, which reads as "my drift was applied" when it was not.
    expect(() => pos().probability({ ...market, expectedReturn: 0.12 })).toThrow(
      /only applies to measure 'realWorld'/,
    );
  });

  it('the risk-neutral default still needs nothing at all', () => {
    expect(() => pos().probability({ ...market })).not.toThrow();
  });
});

describe('optimizeStrategy accepts the one "when" grammar', () => {
  // Found next door to the scanner asOf fix: optimizeStrategy DELEGATES to scanStrategies, which
  // accepts an ISO date — but its own guard called ensureFinite first, so the string never got
  // there. Two functions in one file disagreeing about what a date is.
  const chain = [
    { strike: 95, callBid: 6.0, callAsk: 6.4, putBid: 1.0, putAsk: 1.3 },
    { strike: 100, callBid: 3.0, callAsk: 3.3, putBid: 3.0, putAsk: 3.3 },
    { strike: 105, callBid: 1.2, callAsk: 1.5, putBid: 6.1, putAsk: 6.5 },
  ];
  const base = {
    spot: 100,
    riskFreeRate: 0.04,
    volatility: 0.25,
    expiries: [{ expiry: '2026-03-20', chain }],
    thesis: { targetPrice: 104, volatility: 0.28 },
    top: 3,
  };

  it('an ISO date resolves exactly like its epoch-ms equivalent', () => {
    const iso = optimizeStrategy({ ...base, asOf: '2026-01-02T00:00:00Z' });
    const ms = optimizeStrategy({ ...base, asOf: Date.UTC(2026, 0, 2) });
    expect(iso.candidates.length).toBeGreaterThan(0);
    expect(iso.candidates.map((c) => c.thesisExpectedValue)).toEqual(
      ms.candidates.map((c) => c.thesisExpectedValue),
    );
  });

  it('a malformed date still teaches instead of silently resolving', () => {
    expect(() => optimizeStrategy({ ...base, asOf: 'not-a-date' })).toThrow(/asOf/);
  });
});
