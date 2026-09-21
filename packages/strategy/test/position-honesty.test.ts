import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { legs, strategy } from '@totalfinance/strategy';

/**
 * Regression for two external-review findings:
 *  - a vol scenario shock silently did nothing for legs that fix their own IV (it only touched the
 *    position-level `vol`, which `value()` ignores when a leg has `iv`);
 *  - `pnlAtExpiry()` / default `chartData()` fabricated a single terminal payoff for a calendar
 *    (multi-expiry), bypassing the `metrics()`/`payoff()` guard.
 */
describe('position honesty — scenario shocks reach per-leg IV; calendars refuse expiration payoff', () => {
  // Per-leg IV is carried on raw LegInput and instrument-first constructors — this is the
  // case finding 6 is about: legs that fix their own IV, which `value()` uses over the position `vol`.
  const perLegImpliedVolatility = () =>
    strategy([
      { kind: 'call', strike: 100, premium: 5, quantity: 1, impliedVolatility: 0.3 },
      { kind: 'call', strike: 110, premium: 2, quantity: -1, impliedVolatility: 0.28 },
    ]);
  const market = {
    volatility: 0.29,
    riskFreeRate: 0.045,
    asOf: '2026-07-06T00:00:00Z',
    expiry: '2026-08-21',
  };

  it('vol shocks change the scenario P&L even when every leg fixes its own IV', () => {
    const rows = perLegImpliedVolatility().scenarioTable({
      market,
      prices: [105],
      volatilityShocks: [-0.1, 0, 0.1],
    }).value;
    const pnls = rows.map((r) => r.pnl);
    expect(new Set(pnls.map((p) => p.toFixed(6))).size).toBe(3); // all distinct, not byte-identical
    expect(rows.map((r) => r.vega).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('value(volatilityShock) shifts a per-leg-IV mark-to-market', () => {
    const pos = perLegImpliedVolatility();
    const base = pos.value({ ...market, spot: 105 }).pnl;
    const up = pos.value({ ...market, spot: 105, volatilityShock: 0.1 }).pnl;
    expect(up).not.toBe(base);
  });

  it('a large negative shock floors the vol and says so (no silent negative σ)', () => {
    const markToMarket = perLegImpliedVolatility().value({
      ...market,
      spot: 105,
      volatilityShock: -0.5,
    });
    expect(
      markToMarket.diagnostics.warnings.some((w) => w.code === 'strategy.volatility_floored'),
    ).toBe(true);
  });

  const calendar = () =>
    strategy([
      legs.call({ strike: 100, premium: 3, expiry: '2026-08-21', quantity: -1 }),
      legs.call({ strike: 100, premium: 5, expiry: '2026-09-18', quantity: 1 }),
    ]);

  it('a calendar refuses pnlAtExpiry() rather than fabricate a flat payoff', () => {
    let caught: unknown;
    try {
      calendar().pnlAtExpiry(100);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'strategy.multi_expiry_expiration_analytics')).toBe(true);
  });

  it('a calendar refuses the default (expirationPnl) chartData', () => {
    expect(() => calendar().chartData({ prices: { from: 90, to: 110, steps: 5 } })).toThrow(
      /multiple expiries/,
    );
  });

  it('a calendar still supports the time-aware currentPnl chart', () => {
    const rows = calendar().chartData({
      prices: { from: 90, to: 110, steps: 5 },
      include: { currentPnl: true },
      market,
    });
    expect(rows.every((r) => Number.isFinite(r.currentPnl))).toBe(true);
  });
});

// Regression for an external-review finding: MarkToMarketInput.vol was typed required despite the runtime
// treating it as optional (a fully per-leg-IV position needs no position vol). The type now matches.
describe('R5 MarkToMarketInput.vol is optional — required only when a leg lacks its own impliedVolatility', () => {
  const noVolatilityMarket = {
    spot: 105,
    riskFreeRate: 0.045,
    asOf: '2026-07-06T00:00:00Z',
    expiry: '2026-08-21',
  };

  it('values a fully per-leg-IV position without a position-level vol', () => {
    const pos = strategy([
      { kind: 'call', strike: 100, premium: 5, quantity: 1, impliedVolatility: 0.3 },
      { kind: 'call', strike: 110, premium: 2, quantity: -1, impliedVolatility: 0.28 },
    ]);
    const markToMarket = pos.value(noVolatilityMarket); // no `vol`
    expect(Number.isFinite(markToMarket.pnl)).toBe(true);
    expect(markToMarket.assumptions.volatilitySource).toBe('perLeg');
  });

  it('throws a clear missing-field error when a leg has no impliedVolatility and no vol is given (no silent NaN)', () => {
    const mixed = strategy([
      { kind: 'call', strike: 100, premium: 5, quantity: 1, impliedVolatility: 0.3 },
      { kind: 'put', strike: 95, premium: 2, quantity: 1 }, // no impliedVolatility ⇒ needs a position vol
    ]);
    let caught: unknown;
    try {
      mixed.value(noVolatilityMarket);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.missing_field')).toBe(true);
  });
});
