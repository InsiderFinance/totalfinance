import { bench, describe } from 'vitest';
import { type HestonParameters, heston, impliedVolatility } from '@totalfinance/options';

/**
 * Phase-5 acceleration-need benchmarks for the options hot kernels (§19.4 candidates).
 *
 * Repaired at 3B.1b: this called `hestonPrice` (no longer an export; the curated surface is
 * `heston.cosineExpansion`) and passed `t`/`rate`, renamed to `timeToExpiryYears`/`riskFreeRate` in
 * Phase 3B.N. It had not compiled since that rename — invisibly, because `*.bench.ts` sat outside
 * both `pnpm run ci` and `typecheck`. The root tsconfig now includes benchmarks, so the next rename
 * breaks them loudly instead of silently.
 */
describe('options hot kernels (acceleration-need benchmark)', () => {
  const parameters: HestonParameters = {
    v0: 0.04,
    kappa: 1.5,
    theta: 0.045,
    sigma: 0.3,
    rho: -0.6,
  };

  bench('Heston COS European price (256 terms)', () => {
    heston.cosineExpansion({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      dividendYield: 0,
      parameters,
      terms: 256,
    });
  });

  bench('batch implied vol × 1000 (Brent/Newton)', () => {
    for (let i = 0; i < 1000; i++) {
      impliedVolatility({
        price: 4 + (i % 20) * 0.1,
        spot: 100,
        strike: 90 + (i % 40),
        timeToExpiryYears: 0.3,
        riskFreeRate: 0.03,
        type: 'call',
      });
    }
  });
});
