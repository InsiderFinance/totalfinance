import { describe, expect, it } from 'vitest';
import { blackScholesExtendedGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { legs, strategy } from '@totalfinance/strategy';

describe('bull call spread (golden)', () => {
  const pos = strategy.bullCallSpread({
    long: { strike: 100, premium: 4.25 },
    short: { strike: 110, premium: 1.4 },
  });

  it('net debit, max profit/loss, breakeven', () => {
    const m = pos.metrics();
    expect(m.netDebit).toBeCloseTo(285, 9);
    expect(m.netCredit).toBeCloseTo(-285, 9);
    expect(m.maxLoss).toBeCloseTo(-285, 9);
    expect(m.maxProfit).toBeCloseTo(715, 9);
    expect(m.breakevens).toHaveLength(1);
    expect(m.breakevens[0]).toBeCloseTo(102.85, 9);
  });

  it('payoff points evaluate the piecewise-linear curve', () => {
    const r = pos.payoff({ prices: { from: 90, to: 120, steps: 31 } });
    expect(r.points[0]).toEqual({ underlyingPrice: 90, pnl: -285 });
    expect(r.points.at(-1)).toEqual({ underlyingPrice: 120, pnl: 715 });
  });
});

describe('long straddle', () => {
  it('breakevens are strike ± total premium', () => {
    const pos = strategy.straddle({ strike: 100, callPremium: 5, putPremium: 4 });
    const m = pos.metrics();
    expect(m.netDebit).toBeCloseTo(900, 9); // (5+4)*100
    expect(m.breakevens.sort((a, b) => a - b)).toEqual([
      expect.closeTo(91, 9),
      expect.closeTo(109, 9),
    ]);
    expect(m.maxProfit).toBeNull(); // unbounded upside (B3: null, never Infinity)
    expect(m.bounded).toEqual({ profit: false, loss: true });
  });
});

describe('iron condor (golden)', () => {
  const pos = strategy.ironCondor({
    putLong: { strike: 90, premium: 0.8 },
    putShort: { strike: 95, premium: 1.9 },
    callShort: { strike: 110, premium: 2.1 },
    callLong: { strike: 115, premium: 0.9 },
  });

  it('credit, max profit/loss, breakevens', () => {
    const m = pos.metrics();
    expect(m.netCredit).toBeCloseTo(230, 9);
    expect(m.maxProfit).toBeCloseTo(230, 9);
    expect(m.maxLoss).toBeCloseTo(-270, 9);
    expect(m.breakevens.sort((a, b) => a - b)).toEqual([
      expect.closeTo(92.7, 9),
      expect.closeTo(112.3, 9),
    ]);
  });
});

describe('unbounded payoffs', () => {
  it('long call: unbounded profit is null with bounded.profit false, bounded loss', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    const m = pos.metrics();
    expect(m.maxProfit).toBeNull();
    expect(m.bounded).toEqual({ profit: false, loss: true });
    expect(m.maxLoss).toBeCloseTo(-500, 9); // premium paid
    expect(JSON.stringify(m)).not.toContain('Infinity'); // nothing on the surface is Infinity
  });
  it('short call: unbounded loss is null with bounded.loss false', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: -1 })]);
    expect(pos.metrics().maxLoss).toBeNull();
    expect(pos.metrics().bounded).toEqual({ profit: true, loss: false });
    expect(pos.metrics().maxProfit).toBeCloseTo(500, 9);
  });
});

describe('mark-to-market via BSM', () => {
  const pos = strategy([legs.call({ strike: 100, premium: 4, quantity: 1 })]);
  const market = {
    // 16:00 ET (21:00 UTC, EST) close: the date-only 1y expiry resolves to exactly T = 1.
    asOf: Date.UTC(2026, 0, 1, 21),
    expiry: '2027-01-01',
    volatility: 0.2,
    riskFreeRate: 0.05,
  };

  it('values the position against BSM and reports Greeks', () => {
    const r = pos.value({ ...market, spot: 105 });
    const optionPrice = blackScholesPrice({
      type: 'call',
      spot: 105,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    expect(r.value).toBeCloseTo((optionPrice - 4) * 100, 6);
    expect(r.pnl).toBe(r.value);
    expect(r.greeks.delta).toBeGreaterThan(0);
    expect(r.greeks.delta).toBeLessThan(100); // 1 contract * 100 * call delta (<1)
    expect(r.perLeg).toHaveLength(1);
    expect(r.assumptions.model).toBe('black-scholes-merton');
  });

  it('reports the full extended greeks per leg (scaled) — powers higher-order P&L attribution', () => {
    const r = pos.value({ ...market, spot: 105 });
    const scaled = 1 * 100; // 1 contract × multiplier
    const ext = blackScholesExtendedGreeks({
      type: 'call',
      spot: 105,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    const leg = r.perLeg[0]!.greeks;
    // Second-order fields are present and scaled by position size (lambda is dimensionless, unscaled).
    expect(leg.vanna).toBeCloseTo(ext.vanna * scaled, 8);
    expect(leg.vomma).toBeCloseTo(ext.vomma * scaled, 8);
    expect(leg.charm).toBeCloseTo(ext.charm * scaled, 8);
    expect(leg.veta).toBeCloseTo(ext.veta * scaled, 8);
    expect(leg.vera).toBeCloseTo(ext.vera * scaled, 8);
    expect(leg.phi).toBeCloseTo(ext.phi * scaled, 8);
    expect(leg.lambda).toBeCloseTo(ext.lambda!, 8); // elasticity: scale-invariant
  });

  it('aggregates the additive extended greeks and recomputes book elasticity (Λ = Δ·S/V)', () => {
    // A two-leg spread: the aggregate second-order greeks are the term-wise sum of the legs, and the
    // book lambda is recomputed (not summed) as Δ·S / bookValue.
    const spread = strategy(
      [
        legs.call({ strike: 100, premium: 4, quantity: 1 }),
        legs.call({ strike: 110, premium: 1.5, quantity: -1 }),
      ],
      { multiplier: 100, expiry: '2027-01-01' },
    );
    const r = spread.value({ ...market, spot: 105 });
    for (const k of ['vanna', 'vomma', 'charm', 'veta', 'vera', 'phi'] as const) {
      const legSum = r.perLeg.reduce((a, l) => a + l.greeks[k], 0);
      expect(r.greeks[k]).toBeCloseTo(legSum, 8);
    }
    // Book elasticity is Δ·S / (mark value) — the mark is Σ per-leg value, not `r.value` (which is P&L).
    const bookValue = r.perLeg.reduce((a, l) => a + l.value, 0);
    expect(r.greeks.lambda).toBeCloseTo((r.greeks.delta * 105) / bookValue, 8);
  });

  it('rejects invalid MTM inputs instead of returning NaN with converged:true', () => {
    expect(() => pos.value({ ...market, spot: 105, volatility: NaN })).toThrow();
    expect(() => pos.value({ ...market, spot: -1 })).toThrow();
    expect(() => pos.value({ ...market, spot: 105, riskFreeRate: Infinity })).toThrow();
    expect(() => pos.value({ ...market, spot: 105, expiry: 'not-a-date' })).toThrow();
  });

  it('accepts an ISO-string asOf, parsed at the boundary to the same result as epoch-ms (WS3.2)', () => {
    const fromMs = pos.value({ ...market, spot: 105 });
    // 2026-01-01 21:00 UTC as an ISO datetime string — must resolve identically
    const fromString = pos.value({ ...market, asOf: '2026-01-01T21:00:00Z', spot: 105 });
    expect(fromString.value).toBeCloseTo(fromMs.value, 9);
    // an unparseable asOf string is a hard input error, never a NaN with converged:true
    expect(() => pos.value({ ...market, asOf: 'not-a-timestamp', spot: 105 })).toThrow(/asOf/);
  });

  it('rejects a ZONE-LESS datetime asOf with a teaching error (core resolveAsOf, deterministic)', () => {
    // A bare '2026-01-01T21:00' would parse in the MACHINE's local zone — same input, different
    // epoch per box. Core resolveAsOf refuses it with the fix instead of silently localizing.
    expect(() => pos.value({ ...market, asOf: '2026-01-01T21:00', spot: 105 })).toThrow(
      /no timezone.*append 'Z' or an offset/,
    );
    expect(() =>
      pos.probability({ ...market, volatility: 0.25, asOf: '2026-01-01T21:00', spot: 105 }),
    ).toThrow(/no timezone/);
    // Date-only strings stay valid (UTC midnight) — the everyday spelling keeps working.
    const dateOnly = pos.value({ ...market, asOf: '2026-01-01T00:00:00Z', spot: 105 });
    const utcMidnight = pos.value({ ...market, asOf: Date.UTC(2026, 0, 1), spot: 105 });
    expect(dateOnly.value).toBeCloseTo(utcMidnight.value, 12);
  });

  it('aggregate Greeks are the sum of per-leg Greeks', () => {
    const spread = strategy.bullCallSpread({
      long: { strike: 100, premium: 4.25 },
      short: { strike: 110, premium: 1.4 },
    });
    const r = spread.value({ ...market, spot: 105 });
    const sumDelta = r.perLeg.reduce((acc, l) => acc + l.greeks.delta, 0);
    expect(r.greeks.delta).toBeCloseTo(sumDelta, 9);
  });

  it('chartData includes expiration and current P&L', () => {
    const data = pos.chartData({
      prices: { from: 90, to: 120, steps: 4 },
      include: { expirationPnl: true, currentPnl: true, delta: true },
      market,
    });
    expect(data).toHaveLength(4);
    expect(data[0]).toHaveProperty('expirationPnl');
    expect(data[0]).toHaveProperty('currentPnl');
    expect(data[0]).toHaveProperty('delta');
  });
});

describe('strategy input validation (no successful-looking NaN metrics)', () => {
  it('rejects malformed legs and multipliers at construction', () => {
    expect(() => strategy([legs.call({ strike: NaN, premium: 5, quantity: 1 })])).toThrow();
    expect(() => strategy([legs.call({ strike: 100, premium: NaN, quantity: 1 })])).toThrow();
    expect(() => strategy([legs.call({ strike: 100, premium: 5, quantity: NaN })])).toThrow();
    expect(() => strategy([legs.call({ strike: 100, premium: 5, quantity: 0 })])).toThrow();
    expect(() =>
      strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })], { multiplier: NaN }),
    ).toThrow();
  });

  it('rejects a malformed payoff price range', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    expect(() => pos.payoff({ prices: { from: 80, to: 120, steps: NaN } })).toThrow();
    expect(() => pos.payoff({ prices: { from: NaN, to: 120, steps: 10 } })).toThrow();
    expect(() => pos.payoff({ prices: { from: 80, to: 120, steps: 0 } })).toThrow();
    // A valid range still works and yields finite metrics.
    const r = pos.payoff({ prices: { from: 80, to: 120, steps: 41 } });
    expect(r.points.every((p) => Number.isFinite(p.pnl))).toBe(true);
  });
});

describe('F4 — chart/scenario methods default their price grid (no raw crash on a bare call)', () => {
  const pos = strategy.ironCondor({
    putLong: { strike: 90, premium: 0.8 },
    putShort: { strike: 95, premium: 1.9 },
    callShort: { strike: 110, premium: 2.1 },
    callLong: { strike: 115, premium: 0.9 },
  });

  it('payoff() / chartData() with no argument frame a strike-derived window spanning the strikes', () => {
    const payoff = pos.payoff();
    const chart = pos.chartData();
    expect(payoff.points.length).toBeGreaterThan(2);
    expect(chart.length).toBe(payoff.points.length); // same default grid
    const lows = payoff.points.map((p) => p.underlyingPrice);
    expect(Math.min(...lows)).toBeLessThan(90); // below the lowest strike
    expect(Math.max(...lows)).toBeGreaterThan(115); // above the highest strike
    expect(payoff.points.every((p) => Number.isFinite(p.pnl))).toBe(true);
  });

  it('payoff/chartData also accept an explicit price ARRAY, not only a { from, to, steps } range', () => {
    const r = pos.payoff({ prices: [90, 100, 110] });
    expect(r.points.map((p) => p.underlyingPrice)).toEqual([90, 100, 110]);
    expect(pos.chartData({ prices: [95, 105] })).toHaveLength(2);
  });

  it('a non-object argument is a typed error, never a raw TypeError', () => {
    expect(() => (pos as unknown as { payoff: (x: unknown) => unknown }).payoff(42)).toThrow(
      /options must be an object/,
    );
    expect(() =>
      (pos as unknown as { scenarioTable: (x: unknown) => unknown }).scenarioTable(null),
    ).toThrow(/options must be an object/);
  });

  it('scenarioTable() / whatIfCube() default their spot axis from the strikes too', () => {
    const market = {
      spot: 102,
      volatility: 0.25,
      riskFreeRate: 0.03,
      asOf: '2026-07-06T00:00:00Z',
      expiry: '2026-08-21',
    };
    const withMarket = strategy.ironCondor(
      {
        putLong: { strike: 90, premium: 0.8 },
        putShort: { strike: 95, premium: 1.9 },
        callShort: { strike: 110, premium: 2.1 },
        callLong: { strike: 115, premium: 0.9 },
      },
      { market },
    );
    expect(withMarket.scenarioTable().value.length).toBeGreaterThan(2);
    expect(withMarket.whatIfCube().value.axes.prices.length).toBeGreaterThan(2);
  });
});

describe('option-expiry convention (date-only → 16:00 ET)', () => {
  const pos = strategy([legs.call({ strike: 100, premium: 4, quantity: 1 })]);

  it('values a same-day date-only 0DTE intraday with positive time and live Greeks', () => {
    const asOf = Date.UTC(2026, 1, 2, 14); // 14:00 UTC, before the 21:00 UTC (EST) close
    const r = pos.value({
      asOf,
      expiry: '2026-02-02',
      volatility: 0.2,
      riskFreeRate: 0.05,
      spot: 101,
    });
    expect(r.assumptions.timeToExpiryYears).toBeGreaterThan(0); // not t<0 / intrinsic-only
    expect(r.greeks.delta).not.toBe(0); // BSM Greeks, not the zeroed at-expiry set
  });

  it('accepts a full datetime expiry (no longer rejected by the date parser)', () => {
    const asOf = Date.UTC(2026, 1, 2, 14);
    const r = pos.value({
      asOf,
      expiry: '2026-02-02T21:00:00Z',
      volatility: 0.2,
      riskFreeRate: 0.05,
      spot: 101,
    });
    expect(r.assumptions.timeToExpiryYears).toBeGreaterThan(0);
  });
});

describe('analytic breakevens (WS1.2)', () => {
  const asOf = Date.UTC(2026, 0, 1);
  const expiry = '2026-04-02';

  it('a lone long stock has a breakeven at its entry price', () => {
    const pos = strategy([legs.stock({ price: 500, quantity: 100 })]);
    expect(pos.metrics().breakevens).toEqual([500]); // grid version returned []
  });

  it('a deep-ITM long call breaks even at strike + premium, beyond the old grid cap', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 301, quantity: 1 })]);
    const m = pos.metrics();
    expect(m.breakevens).toHaveLength(1);
    expect(m.breakevens[0]).toBeCloseTo(401, 9); // was [] (grid capped near 2·maxStrike)
  });

  it('the deep-ITM breakeven feeds a non-zero probability of profit', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 301, quantity: 1 })]);
    const p = pos.probability({ asOf, expiry, volatility: 0.2, riskFreeRate: 0.05, spot: 400 });
    expect(p.probabilityOfProfit).toBeGreaterThan(0); // was 0 with breakevens: []
    expect(p.probabilityOfProfit).toBeLessThan(1);
  });

  it('an iron condor has exactly two breakevens, each an exact payoff root', () => {
    const ic = strategy([
      legs.put({ strike: 90, premium: 0.7, quantity: 1 }),
      legs.put({ strike: 95, premium: 1.5, quantity: -1 }),
      legs.call({ strike: 105, premium: 1.6, quantity: -1 }),
      legs.call({ strike: 110, premium: 0.8, quantity: 1 }),
    ]);
    const m = ic.metrics();
    expect(m.breakevens).toHaveLength(2);
    for (const be of m.breakevens) expect(ic.pnlAtExpiry(be)).toBeCloseTo(0, 9);
    expect(m.breakevens[0]).toBeGreaterThan(90);
    expect(m.breakevens[0]).toBeLessThan(95);
    expect(m.breakevens[1]).toBeGreaterThan(105);
    expect(m.breakevens[1]).toBeLessThan(110);
  });

  it('a breakeven sitting exactly on a kink is reported once', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 0, quantity: 1 })]);
    expect(pos.metrics().breakevens).toEqual([100]);
  });
});
