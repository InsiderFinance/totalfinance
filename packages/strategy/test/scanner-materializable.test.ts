import { describe, expect, it } from 'vitest';
import { type ScanQuoteRow, scanStrategies, strategy } from '@totalfinance/strategy';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-04-02';
const chain: ScanQuoteRow[] = [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({
  strike,
}));
const base = { spot: 100, asOf, expiry, riskFreeRate: 0.03, volatility: 0.25, chain } as const;

describe('WS7.3 scanner candidates are materializable', () => {
  for (const structure of ['bullCallSpread', 'ironCondor', 'longCallButterfly'] as const) {
    it(`${structure}: strategy(candidate.legs).metrics() reproduces the reported metrics`, () => {
      const res = scanStrategies({
        ...base,
        structures: [structure],
        rankBy: 'expectedValue',
        top: 1,
      }).candidates;
      expect(res.length).toBeGreaterThan(0);
      const cand = res[0]!;
      expect(cand.legs.length).toBeGreaterThan(0);

      // Reconstruct the exact position from the candidate's resolved legs and re-derive its metrics.
      const m = strategy(cand.legs).metrics();
      expect(m.netDebit).toBeCloseTo(cand.netDebit, 9);
      expect(m.maxProfit!).toBeCloseTo(cand.maxProfit!, 9);
      expect(m.maxLoss!).toBeCloseTo(cand.maxLoss!, 9);
      expect(m.breakevens).toHaveLength(cand.breakevens.length);
      for (let i = 0; i < m.breakevens.length; i++) {
        expect(m.breakevens[i]).toBeCloseTo(cand.breakevens[i]!, 9);
      }
    });
  }

  it('the materialized position can also be marked-to-market and charted', () => {
    const [cand] = scanStrategies({
      ...base,
      structures: ['ironCondor'],
      rankBy: 'expectedValuePerRisk',
      top: 1,
    }).candidates;
    const pos = strategy(cand!.legs);
    const markToMarket = pos.value({
      spot: 100,
      asOf,
      expiry,
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    expect(Number.isFinite(markToMarket.pnl)).toBe(true);
    expect(pos.chartData({ prices: { from: 90, to: 110, steps: 5 } })).toHaveLength(5);
  });
});
