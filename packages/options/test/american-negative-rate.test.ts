import { describe, expect, it } from 'vitest';
import { engines, market, option } from '@totalfinance/options';

/**
 * Regression for an external-review finding: the auto engine routed an American no-dividend call to
 * the European BSM shortcut even when r < 0, undervaluing it — with a negative rate, deferring the
 * strike is costly, so early exercise can be optimal. It must fall through to the American lattice.
 */
describe('american call routing under negative rates', () => {
  const asOf = Date.UTC(2026, 6, 11);
  const amCall = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry: '2027-07-11',
    style: 'american',
  });
  const euCall = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry: '2027-07-11',
    style: 'european',
  });
  const mkt = (riskFreeRate: number) =>
    market({ spot: 100, riskFreeRate, dividendYield: 0, volatility: 0.3, asOf });
  const lattice = engines.binomial({ variant: 'leisen-reimer', steps: 501 });

  it('prices an American no-dividend call above European when r < 0 (early-exercise premium)', () => {
    const r = -0.2;
    const american = option.price({
      contract: amCall,
      market: mkt(r),
      engine: engines.auto(),
    }).value;
    const european = option.price({
      contract: euCall,
      market: mkt(r),
      engine: engines.blackScholesMerton(),
    }).value;
    expect(american).toBeGreaterThan(european + 0.05); // a genuine early-exercise premium
    // and `auto` routed to the American lattice, not the BSM shortcut
    expect(american).toBeCloseTo(
      option.price({ contract: amCall, market: mkt(r), engine: lattice }).value,
      3,
    );
  });

  it('still equals European for a non-dividend call when r ≥ 0 (theorem holds)', () => {
    const r = 0.05;
    const american = option.price({
      contract: amCall,
      market: mkt(r),
      engine: engines.auto(),
    }).value;
    const european = option.price({
      contract: euCall,
      market: mkt(r),
      engine: engines.blackScholesMerton(),
    }).value;
    expect(american).toBeCloseTo(european, 6);
  });
});
