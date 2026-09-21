import { describe, expect, it } from 'vitest';
import { engines, market, option } from '@totalfinance/options';

/**
 * Regressions for external-review findings on `PriceOptions.greeks`:
 *  - American (finite-difference) engines ALWAYS computed Greeks, ignoring `{ greeks: false }`;
 *  - discrete-dividend rho/theta bumped the rate/time while holding the ESCROWED spot fixed, even
 *    though the escrowed spot depends on the rate and time (biasing those Greeks).
 */
const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1 (2026 non-leap)

describe('American engine — honors greeks: false', () => {
  const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
  const call = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry,
    style: 'american',
  });

  it('omits Greeks and flags them not-computed when greeks:false', () => {
    const res = engines
      .binomial({ steps: 200 })
      .price({ contract: call, market: mkt, options: { greeks: false } });
    expect(res.greeks).toBeUndefined();
    expect(res.diagnostics.warnings.some((w) => w.code === 'greeks.not_computed')).toBe(true);
    expect(Number.isFinite(res.value)).toBe(true); // the price is still computed
  });

  it('still returns Greeks by default (greeks omitted)', () => {
    const res = engines.binomial({ steps: 200 }).price({ contract: call, market: mkt });
    expect(res.greeks).toBeDefined();
    expect(Number.isFinite(res.greeks!.delta)).toBe(true);
  });
});

describe('American engine — discrete-dividend rho re-escrows the spot', () => {
  // A fat, rate-sensitive dividend (PV moves visibly with the rate) makes the bias detectable.
  const divs = [{ exDate: '2026-07-01', amount: 6 }];
  const rate = 0.05;
  const mkt = market({ spot: 100, riskFreeRate: rate, volatility: 0.2, asOf, dividends: divs });
  const call = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry,
    style: 'american',
  });
  const engine = engines.binomial({ variant: 'leisen-reimer', steps: 401 });

  it("reported rho matches a central difference of the engine's own price across the rate", () => {
    // The engine re-escrows the spot at r ± h internally, so its rho must equal a finite difference of
    // the full engine price (which also re-escrows). Holding the escrowed spot fixed — the old bug —
    // would use S(r) at both bumped rates and disagree with this reference.
    const h = 1e-4;
    const up = engine.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: rate + h, volatility: 0.2, asOf, dividends: divs }),
    }).value;
    const dn = engine.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: rate - h, volatility: 0.2, asOf, dividends: divs }),
    }).value;
    const refRho = (up - dn) / (2 * h) / 100; // per-1% units, matching the engine
    expect(engine.price({ contract: call, market: mkt }).greeks!.rho).toBeCloseTo(refRho, 6);
  });
});
