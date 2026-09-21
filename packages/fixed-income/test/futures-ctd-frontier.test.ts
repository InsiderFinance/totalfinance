/**
 * Bond-future CTD switching frontier + delivery-date DV01 (`bondFutureCtdFrontier`, Wave 6 §1).
 *
 * The frontier is pinned by composition identities, not re-derived math: every scanned node equals a
 * direct `bondFuture(...)` call on independently shifted prices; the zero node equals the unshifted
 * basket's CTD; a switch's refined root equalizes the two rivals' implied-repo rates to 1e-10 inside a
 * bracket no wider than the location tolerance; a narrow third-deliverable window splits into TWO
 * frontier transitions (the global-frontier guard); and the delivery-date futures DV01 equals a central
 * finite difference of the CTD price at delivery divided by the conversion factor — distinct from the
 * spot cash DV01 / CF.
 */

import { describe, expect, it } from 'vitest';
import {
  bonds,
  bondFuture,
  bondFutureCtdFrontier,
  priceFromYield,
  yieldMetrics,
  yieldToMaturity,
} from '@totalfinance/fixed-income';

const mk = (couponRate: number, maturityDate: string) =>
  bonds.fixedRate({
    issueDate: '2015-05-15',
    maturityDate,
    couponRate,
    frequency: 'semiannual',
    dayCount: 'ACT/ACT',
  });

const SETTLE = '2024-03-01';
const DELIVERY = '2024-06-15';
const F = 110.5;
const REPO = 0.053;

// A short/low-duration vs long/high-duration pair: the CTD switches as parallel yields cross the ~6%
// notional-coupon region (short cheap below, long cheap above).
const SHORT = mk(0.0625, '2029-11-15');
const LONG = mk(0.02, '2044-08-15');
const priceAt = (bond: ReturnType<typeof mk>, y: number) =>
  priceFromYield(bond, { settlementDate: SETTLE, yield: y }).cleanPrice;

const TWO_BOND = () => ({
  futuresPrice: F,
  settlementDate: SETTLE,
  deliveryDate: DELIVERY,
  repoRate: REPO,
  deliverables: [
    { id: 'short', bond: SHORT, cleanPrice: priceAt(SHORT, 0.05) },
    { id: 'long', bond: LONG, cleanPrice: priceAt(LONG, 0.05) },
  ],
});

describe('bondFutureCtdFrontier — scan structure', () => {
  it('resolves the default range to 17 ordered shifts with exactly one zero node', () => {
    const r = bondFutureCtdFrontier(TWO_BOND());
    const shifts = r.assumptions.yieldShiftsBp;
    expect(shifts).toHaveLength(17);
    expect(shifts[0]).toBe(-200);
    expect(shifts[16]).toBe(200);
    expect(shifts.filter((s) => s === 0)).toHaveLength(1);
    // strictly ascending
    for (let i = 1; i < shifts.length; i++) expect(shifts[i]!).toBeGreaterThan(shifts[i - 1]!);
    expect(r.scenarios).toHaveLength(17);
    expect(r.assumptions.futuresPriceScenario).toBe('held-constant');
    expect(r.assumptions.yieldShock).toBe('parallel');
    expect(r.assumptions.repoRateTieTolerance).toBe(1e-10);
  });

  it('the zero node exactly matches bondFuture(input).cheapestToDeliver', () => {
    const input = TWO_BOND();
    const r = bondFutureCtdFrontier(input);
    const zero = r.scenarios.find((s) => s.yieldShiftBp === 0)!;
    const direct = bondFuture(input);
    // The CTD identity is exact; values match to the yield round-trip's solver precision (~1e-11),
    // since the frontier is yield-driven (solve each spot yield, then reprice at shift 0).
    expect(zero.ctdId).toBe(direct.cheapestToDeliver.id);
    expect(zero.impliedRepoRate).toBeCloseTo(direct.cheapestToDeliver.impliedRepoRate, 9);
    expect(zero.netBasis).toBeCloseTo(direct.cheapestToDeliver.netBasis, 9);
    // and `current` reports that same CTD
    expect(r.current.ctdId).toBe(direct.cheapestToDeliver.id);
  });

  it('every scenario row equals a direct bondFuture on independently shifted prices', () => {
    const r = bondFutureCtdFrontier(TWO_BOND());
    // Independently re-derive the +50bp node from the solved spot yields.
    const yS = yieldToMaturity(SHORT, { settlementDate: SETTLE, price: priceAt(SHORT, 0.05) });
    const yL = yieldToMaturity(LONG, { settlementDate: SETTLE, price: priceAt(LONG, 0.05) });
    for (const shift of [-100, 0, 50, 150]) {
      const node = r.scenarios.find((s) => s.yieldShiftBp === shift)!;
      const direct = bondFuture({
        futuresPrice: F,
        settlementDate: SETTLE,
        deliveryDate: DELIVERY,
        repoRate: REPO,
        deliverables: [
          { id: 'short', bond: SHORT, cleanPrice: priceAt(SHORT, yS + shift / 1e4) },
          { id: 'long', bond: LONG, cleanPrice: priceAt(LONG, yL + shift / 1e4) },
        ],
      });
      expect(node.ctdId).toBe(direct.cheapestToDeliver.id);
      for (const row of node.deliverables) {
        const d = direct.deliverables.find((x) => x.id === row.id)!;
        expect(row.impliedRepoRate).toBeCloseTo(d.impliedRepoRate, 12);
        expect(row.netBasis).toBeCloseTo(d.netBasis, 12);
      }
    }
  });

  it('a one-bond basket has no switches and keeps its CTD at every node', () => {
    const r = bondFutureCtdFrontier({
      futuresPrice: F,
      settlementDate: SETTLE,
      deliveryDate: DELIVERY,
      repoRate: REPO,
      deliverables: [{ id: 'only', bond: SHORT, cleanPrice: priceAt(SHORT, 0.05) }],
    });
    expect(r.switches).toHaveLength(0);
    expect(r.scenarios.every((s) => s.ctdId === 'only')).toBe(true);
    expect(r.current.ctdId).toBe('only');
  });
});

describe('bondFutureCtdFrontier — switch refinement', () => {
  it('root-refines a two-bond switch: rivals tie to 1e-10 inside a sub-tolerance bracket', () => {
    const r = bondFutureCtdFrontier(TWO_BOND());
    expect(r.switches.length).toBeGreaterThanOrEqual(1);
    const sw = r.switches[0]!;
    expect(sw.method).toBe('root-refined');
    expect(new Set([sw.fromCtd, sw.toCtd])).toEqual(new Set(['short', 'long']));
    // The refined bracket is no wider than the (default) location tolerance...
    expect(sw.bracketBp[1] - sw.bracketBp[0]).toBeLessThanOrEqual(0.01 + 1e-9);
    // ...and at the estimated switch the two rivals' implied-repo rates are equal to 1e-10 (a rate
    // tie tolerance — never compared against the bp bracket width).
    const yS = yieldToMaturity(SHORT, { settlementDate: SETTLE, price: priceAt(SHORT, 0.05) });
    const yL = yieldToMaturity(LONG, { settlementDate: SETTLE, price: priceAt(LONG, 0.05) });
    const at = bondFuture({
      futuresPrice: F,
      settlementDate: SETTLE,
      deliveryDate: DELIVERY,
      repoRate: REPO,
      deliverables: [
        { id: 'short', bond: SHORT, cleanPrice: priceAt(SHORT, yS + sw.estimatedSwitchBp / 1e4) },
        { id: 'long', bond: LONG, cleanPrice: priceAt(LONG, yL + sw.estimatedSwitchBp / 1e4) },
      ],
    });
    const irrShort = at.deliverables.find((d) => d.id === 'short')!.impliedRepoRate;
    const irrLong = at.deliverables.find((d) => d.id === 'long')!.impliedRepoRate;
    expect(Math.abs(irrShort - irrLong)).toBeLessThanOrEqual(1e-10);
  });

  it('honors a custom location tolerance without conflating it with the rate tie tolerance', () => {
    const r = bondFutureCtdFrontier({ ...TWO_BOND(), switchLocationToleranceBp: 0.5 });
    expect(r.assumptions.switchLocationToleranceBp).toBe(0.5);
    const sw = r.switches.find((s) => s.method === 'root-refined')!;
    expect(sw.bracketBp[1] - sw.bracketBp[0]).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(r.assumptions.repoRateTieTolerance).toBe(1e-10); // unchanged, not a user knob
  });

  it('finds BOTH frontier transitions across a narrow intermediate CTD (global-frontier guard)', () => {
    // MID priced ~35bp cheap so it wins a central band; SHORT below, LONG above.
    const MID = mk(0.04, '2036-05-15');
    const input = {
      futuresPrice: F,
      settlementDate: SETTLE,
      deliveryDate: DELIVERY,
      repoRate: REPO,
      deliverables: [
        { id: 'short', bond: SHORT, cleanPrice: priceAt(SHORT, 0.05) },
        { id: 'mid', bond: MID, cleanPrice: priceAt(MID, 0.0535) },
        { id: 'long', bond: LONG, cleanPrice: priceAt(LONG, 0.05) },
      ],
    };
    const r = bondFutureCtdFrontier(input);
    const labels = r.switches.map((s) => `${s.fromCtd}->${s.toCtd}`);
    // The frontier sweeps short -> mid -> long: both transitions are present, no direct short->long.
    expect(labels).toContain('short->mid');
    expect(labels).toContain('mid->long');
    expect(labels).not.toContain('short->long');
    // Every reported root truly ties its two rivals AND is not beaten by the third deliverable there.
    const yById = {
      short: yieldToMaturity(SHORT, { settlementDate: SETTLE, price: priceAt(SHORT, 0.05) }),
      mid: yieldToMaturity(MID, { settlementDate: SETTLE, price: priceAt(MID, 0.0535) }),
      long: yieldToMaturity(LONG, { settlementDate: SETTLE, price: priceAt(LONG, 0.05) }),
    };
    const bondById = { short: SHORT, mid: MID, long: LONG } as const;
    for (const sw of r.switches) {
      if (sw.method !== 'root-refined') continue;
      const at = bondFuture({
        futuresPrice: F,
        settlementDate: SETTLE,
        deliveryDate: DELIVERY,
        repoRate: REPO,
        deliverables: (['short', 'mid', 'long'] as const).map((id) => ({
          id,
          bond: bondById[id],
          cleanPrice: priceAt(bondById[id], yById[id] + sw.estimatedSwitchBp / 1e4),
        })),
      });
      const irr = new Map(at.deliverables.map((d) => [d.id, d.impliedRepoRate]));
      const a = irr.get(sw.fromCtd)!;
      const b = irr.get(sw.toCtd)!;
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-10);
      for (const [id, v] of irr) {
        if (id !== sw.fromCtd && id !== sw.toCtd)
          expect(v).toBeLessThanOrEqual(Math.max(a, b) + 1e-10);
      }
    }
  });
});

describe('bondFutureCtdFrontier — delivery-date DV01', () => {
  it('equals a central finite difference of the CTD price at delivery, / CF, distinct from spot', () => {
    const input = TWO_BOND();
    const r = bondFutureCtdFrontier(input);
    const ctdId = r.current.ctdId;
    const ctdBond = ctdId === 'short' ? SHORT : LONG;
    const CF = r.current.conversionFactor;
    const yFwd = r.risk.impliedForwardYield;

    const h = 1e-6;
    const pUp = priceFromYield(ctdBond, { settlementDate: DELIVERY, yield: yFwd + h }).dirtyPrice;
    const pDn = priceFromYield(ctdBond, { settlementDate: DELIVERY, yield: yFwd - h }).dirtyPrice;
    const fdFuturesDv01 = ((-(pUp - pDn) / (2 * h)) * 1e-4) / CF;
    expect(r.risk.deliveryDateFuturesDv01).toBeCloseTo(fdFuturesDv01, 6);

    // Sanity: it is the CTD forward DV01 at delivery / CF, and differs from the spot cash DV01 / CF.
    const direct = yieldMetrics(ctdBond, { settlementDate: DELIVERY, yield: yFwd }).dv01 / CF;
    expect(r.risk.deliveryDateFuturesDv01).toBeCloseTo(direct, 12);
    expect(Math.abs(r.risk.spotFuturesDv01 - r.risk.deliveryDateFuturesDv01)).toBeGreaterThan(1e-9);
  });
});

describe('bondFutureCtdFrontier — futures-price policy', () => {
  it('a supplied path is distinct from held-constant and labels its switches grid-midpoint', () => {
    // Explicit shifts spanning the switch, with a mildly rising futures path aligned to them.
    const shiftsBp = [-100, -50, 0, 50, 100, 150];
    const held = bondFutureCtdFrontier({ ...TWO_BOND(), yieldShiftsBp: shiftsBp });
    const supplied = bondFutureCtdFrontier({
      ...TWO_BOND(),
      yieldShiftsBp: shiftsBp,
      futuresPrices: shiftsBp.map((s) => F - s * 0.01), // futures rises as yields fall
    });
    expect(held.assumptions.futuresPriceScenario).toBe('held-constant');
    expect(supplied.assumptions.futuresPriceScenario).toBe('supplied-path');
    // The supplied node prices track the path; the held ones are all F.
    expect(held.scenarios.every((s) => s.futuresPrice === F)).toBe(true);
    expect(supplied.scenarios.some((s) => s.futuresPrice !== F)).toBe(true);
    // A discrete path does not define values between nodes → switches stay grid-midpoint.
    expect(supplied.switches.every((s) => s.method === 'grid-midpoint')).toBe(true);
    expect(supplied.assumptions.switchLocationToleranceBp).toBeNull();
    // Pairs are sorted together by shift (already ascending here) and align one-for-one.
    expect(supplied.scenarios.map((s) => s.yieldShiftBp)).toEqual(shiftsBp);
  });

  it('sorts unordered explicit (shift, price) pairs together', () => {
    const shiftsBp = [50, -100, 0]; // deliberately unordered
    const prices = [111, 108, 110]; // paired with the above, respectively
    const r = bondFutureCtdFrontier({
      ...TWO_BOND(),
      yieldShiftsBp: shiftsBp,
      futuresPrices: prices,
    });
    expect(r.scenarios.map((s) => s.yieldShiftBp)).toEqual([-100, 0, 50]);
    expect(r.scenarios.map((s) => s.futuresPrice)).toEqual([108, 110, 111]);
  });
});

describe('bondFutureCtdFrontier — guards (typed teaching errors)', () => {
  it('rejects refineSwitches:true alongside a supplied futures path', () => {
    expect(() =>
      bondFutureCtdFrontier({
        ...TWO_BOND(),
        yieldShiftsBp: [0, 50],
        futuresPrices: [110, 111],
        refineSwitches: true,
      }),
    ).toThrowError(/refineSwitches is invalid/);
  });

  it('rejects a futures path that is not an explicit, aligned array', () => {
    // range form cannot align to a discrete path
    expect(() => bondFutureCtdFrontier({ ...TWO_BOND(), futuresPrices: [110, 111] })).toThrowError(
      /explicit yieldShiftsBp array/,
    );
    // misaligned length
    expect(() =>
      bondFutureCtdFrontier({
        ...TWO_BOND(),
        yieldShiftsBp: [0, 50, 100],
        futuresPrices: [110, 111],
      }),
    ).toThrowError(/align one-for-one/);
  });

  it('rejects duplicate, non-finite shifts, and degenerate ranges/tolerances', () => {
    expect(() => bondFutureCtdFrontier({ ...TWO_BOND(), yieldShiftsBp: [0, 50, 50] })).toThrowError(
      /duplicate/,
    );
    expect(() =>
      bondFutureCtdFrontier({ ...TWO_BOND(), yieldShiftsBp: [0, Number.NaN] }),
    ).toThrowError();
    expect(() =>
      bondFutureCtdFrontier({ ...TWO_BOND(), yieldShiftsBp: { from: 100, to: -100, step: 25 } }),
    ).toThrowError();
    expect(() =>
      bondFutureCtdFrontier({ ...TWO_BOND(), yieldShiftsBp: { from: -50, to: 50, step: 0 } }),
    ).toThrowError();
    expect(() =>
      bondFutureCtdFrontier({ ...TWO_BOND(), switchLocationToleranceBp: -1 }),
    ).toThrowError();
  });

  it('rejects unknown keys and malformed deliverables', () => {
    expect(() => bondFutureCtdFrontier(undefined as never)).toThrowError();
    expect(() => bondFutureCtdFrontier({ ...TWO_BOND(), notAField: 1 } as never)).toThrowError();
    // a raw spec object instead of a built Bond instance
    expect(() =>
      bondFutureCtdFrontier({
        futuresPrice: F,
        settlementDate: SETTLE,
        deliveryDate: DELIVERY,
        repoRate: REPO,
        deliverables: [{ id: 'x', bond: { couponRate: 0.05 } as never, cleanPrice: 99 }],
      }),
    ).toThrowError();
  });
});
