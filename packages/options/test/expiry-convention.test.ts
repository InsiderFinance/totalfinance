import { describe, expect, it } from 'vitest';
import { type OptionMarket, engines, market, option } from '@totalfinance/options';

/**
 * Alignment spec P1.6 — the date-only-expiry resolution convention is NAMED and ECHOED in
 * assumptions, never silent: a bare `YYYY-MM-DD` resolves to 16:00 America/New_York (US
 * equity/options close) and the result says so; a zoned datetime is the caller's explicit instant.
 * Full instrument-convention ownership arrives with the Phase 3 contract redesign.
 */

const asOf = Date.UTC(2026, 0, 1, 21);
const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

describe('assumptions.expiryConvention (P1.6)', () => {
  it('date-only expiry echoes us-equity-close on the BSM pro path', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const r = option.price({ contract: c, market: mkt, engine: engines.blackScholesMerton() });
    expect(r.assumptions.expiryConvention).toBe('us-equity-close');
  });

  it('zoned datetime expiry echoes explicit-instant', () => {
    const c = option.call({
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01T21:00:00Z',
      style: 'european',
    });
    const r = option.price({ contract: c, market: mkt, engine: engines.blackScholesMerton() });
    expect(r.assumptions.expiryConvention).toBe('explicit-instant');
  });

  it('the Black-76 engine echoes it too', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const r = engines.black76().price({
      contract: c,
      market: { forward: 105, riskFreeRate: 0.05, volatility: 0.2, asOf } as OptionMarket,
    });
    expect(r.assumptions.expiryConvention).toBe('us-equity-close');
  });
});
