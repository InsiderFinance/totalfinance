import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blackScholes } from '@totalfinance/options';
import * as ta from '@totalfinance/technical-analysis';
import { legs, strategy } from '@totalfinance/strategy';
import * as backtest from '@totalfinance/backtest';

/**
 * DX7.3 — the five-minute journey (dx-spec §7): a newcomer with only autocomplete prices an option,
 * reads an indicator, gets an iron condor's probability-of-profit FROM STRIKES ALONE (DX3), and runs
 * a tiny backtest — all in a handful of lines. The line budget below fails CI if that journey grows.
 */
describe('DX7.3 five-minute new-user journey', () => {
  it('price → indicator → condor PoP from strikes → mini backtest', () => {
    // journey:begin
    const price = blackScholes.call({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    const rsi = ta.rsi.explain(
      [
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
        46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
      ],
      { period: 14 },
    );
    const market = {
      spot: 570,
      volatility: 0.18,
      riskFreeRate: 0.045,
      asOf: '2026-07-06T00:00:00Z',
      expiry: '2026-08-21',
    };
    const condor = strategy(
      [
        legs.put({ strike: 540, quantity: 1 }),
        legs.put({ strike: 550, quantity: -1 }),
        legs.call({ strike: 590, quantity: -1 }),
        legs.call({ strike: 600, quantity: 1 }),
      ],
      { premiums: 'model', market },
    );
    const pop = condor.probability().probabilityOfProfit; // the position remembers its market (R5)
    const bars = Array.from({ length: 30 }, (_, i) => ({
      symbol: 'SPY',
      timestampMs: i * 86_400_000,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
    }));
    const bt = backtest.vectorized({ data: bars, signal: bars.map((_, i) => i >= 5) });
    // journey:end
    expect(price).toBeGreaterThan(0);
    expect(rsi.value).toHaveLength(20);
    expect(rsi.value.at(-1)).toBeCloseTo(57.915, 2); // a real oscillator reading, not warmup NaN
    expect(condor.premiumSource).toBe('model'); // priced from strikes, no fills
    expect(pop).toBeGreaterThan(0);
    expect(pop).toBeLessThan(1);
    expect(bt.finalValue).toBeGreaterThan(0);
  });

  it('the journey stays within its step budget (CI flags growth)', () => {
    // Count logical steps (top-level `const` bindings in the journey region), not raw lines — that
    // stays stable under Prettier's array/object wrapping and measures real complexity growth.
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const begin = src.findIndex((l) => l.includes('journey:begin'));
    const end = src.findIndex((l) => l.includes('journey:end'));
    const steps = src.slice(begin + 1, end).filter((l) => /^\s*const /.test(l)).length;
    const BUDGET = 9; // today: 7 steps — price, rsi, market, condor, pop, bars, backtest
    expect(
      steps,
      `the five-minute journey grew to ${steps} steps (budget ${BUDGET})`,
    ).toBeLessThanOrEqual(BUDGET);
  });
});
