import { bench, describe } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { option } from '@totalfinance/options';
import { exposure } from '@totalfinance/structure';

/**
 * Repaired at 3B.1b, where including `*.bench.ts` in typecheck first compiled it. Four separate
 * drifts had accumulated silently: the contract literal predates the one-expiry law (E2), `market.rate`
 * became `riskFreeRate`, `quote.ts` became `timestampMs`, and the `as const` grid produces readonly
 * tuples that `ScenarioMapOptions` (mutable `number[]`) does not accept.
 */

const asOf = Date.UTC(2026, 0, 1);
const spot = 500;
const rate = 0.04;

/** A realistic index chain: 3 expiries × ~60 strikes × {call, put} ≈ 360 contracts. */
function bigChain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of ['2026-01-16', '2026-02-20', '2026-03-20']) {
    for (let k = 350; k <= 650; k += 5) {
      for (const type of ['call', 'put'] as OptionType[]) {
        rows.push({
          contract: option.european({
            underlying: 'SPX',
            type,
            strike: k,
            expiry,
            multiplier: 100,
            convention: 'us-equity-close',
          }),
          timestampMs: asOf,
          impliedVolatility: 0.18 + Math.abs(spot - k) * 0.0004,
          openInterest: 1000,
          underlyingPrice: spot,
        });
      }
    }
  }
  return rows;
}

describe('scenario map throughput (acceleration-need benchmark)', () => {
  const prof = exposure({
    quotes: bigChain(),
    market: { riskFreeRate: rate, asOf, spot },
    config: { convention: 'callsPositivePutsNegative' },
  });
  // NOT `as const`: `ScenarioMapOptions` takes mutable `number[]`, and readonly tuples do not assign.
  const grid = {
    spot: { from: 440, to: 560, steps: 121 },
    volatilityShock: [-0.05, 0, 0.05],
    timeAdvance: [0, 1 / 365, 3 / 365, 7 / 365],
  };

  // The spec's example grid: 121 spot steps × 3 vol shocks × 4 time points = 1452 cells.
  bench('scenarioMap 121×3×4 — includes an extended-greek metric (vanna/charm)', () => {
    prof.scenarioMap({ ...grid, metrics: ['gex', 'dex', 'vanna', 'charm'] });
  });

  // WS2.4: a gex/dex-only map skips the second-order `blackScholesExtendedGreeks` pass entirely — same grid,
  // roughly half the per-cell greek work. Compare this line against the one above.
  bench('scenarioMap 121×3×4 — gex/dex only (skips the extended-greek pass)', () => {
    prof.scenarioMap({ ...grid, metrics: ['gex', 'dex'] });
  });
});
