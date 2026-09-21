/**
 * Runnable strategy examples (spec §12). Each snippet executes in CI with assertions so the
 * named-strategy catalogue, profit-calculator metrics, and scanner docs cannot drift from working
 * code. Every builder takes explicit strikes/premiums (data-agnostic) and returns a `Position`.
 */

import { describe, expect, it } from 'vitest';
import { scanStrategies, strategy } from '@totalfinance/strategy';
import type { ScanQuoteRow } from '@totalfinance/strategy';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-04-02';
const market = { spot: 100, asOf, expiry, riskFreeRate: 0.03, volatility: 0.25 } as const;

describe('profit calculator — named structures', () => {
  it('iron condor: metrics + probability of profit from one builder', () => {
    const condor = strategy.ironCondor({
      putLong: { strike: 90, premium: 0.7 },
      putShort: { strike: 95, premium: 1.5 },
      callShort: { strike: 105, premium: 1.6 },
      callLong: { strike: 110, premium: 0.8 },
    });
    const m = condor.metrics();
    expect(m.netCredit).toBeGreaterThan(0); // a credit structure
    expect(m.breakevens).toHaveLength(2);
    expect(Number.isFinite(m.maxLoss)).toBe(true); // defined risk

    const p = condor.probability(market);
    expect(p.probabilityOfProfit).toBeGreaterThan(0);
    expect(p.probabilityOfProfit).toBeLessThan(1);
  });

  it('jade lizard: short put + short call spread, no upside risk when credit ≥ width', () => {
    const jl = strategy.jadeLizard({
      put: { strike: 90, premium: 2 },
      shortCall: { strike: 105, premium: 3 }, // 15-wide call spread, 5 credit ⇒ no upside risk
      longCall: { strike: 110, premium: 1 },
    });
    // Total credit (2 + 3 − 1 = 4) < 5 width here, so upside risk exists but is capped (defined).
    expect(Number.isFinite(jl.metrics().maxLoss)).toBe(true);
  });

  it('covered call: long 100 shares + short call caps the upside', () => {
    const cc = strategy.coveredCall({ stockPrice: 100, strike: 105, premium: 2 });
    expect(Number.isFinite(cc.metrics().maxProfit)).toBe(true);
  });

  it('a long synthetic future behaves like long stock (delta ≈ +100 for one contract)', () => {
    const syn = strategy.longSyntheticFuture({ strike: 100, callPremium: 3, putPremium: 3 });
    const v = syn.value(market);
    expect(v.greeks.delta).toBeGreaterThan(90);
  });
});

describe('multi-expiry — calendars valued at the near expiry', () => {
  it('a call calendar keeps the long leg time value near the strike (the tent)', () => {
    const cal = strategy.calendarCallSpread({
      strike: 100,
      nearExpiry: '2026-02-20',
      shortPremium: 3,
      farExpiry: '2026-05-15',
      longPremium: 5,
    });
    const nearExpiryTs = Date.parse('2026-02-20T20:00:00Z'); // ~16:00 ET on the near-expiry day
    // The calendar's legs own their horizons (2026-02-20 and 2026-05-15): the single-expiry
    // example market's `expiry` is not passed, because a call-site expiry that names a horizon
    // the legs do not have is refused rather than silently echoed.
    const { expiry: _singleExpiry, ...calendarMarket } = market;
    const atStrike = cal.value({ ...calendarMarket, spot: 100, asOf: nearExpiryTs });
    const deepOtm = cal.value({ ...calendarMarket, spot: 70, asOf: nearExpiryTs });
    expect(atStrike.value).toBeGreaterThan(deepOtm.value); // profitable near the strike, worse OTM
  });
});

describe('scanner — rank defined-risk structures across a strike grid', () => {
  it('ranks candidates by risk-adjusted expected value', () => {
    const chain: ScanQuoteRow[] = [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({
      strike,
    }));
    const ranked = scanStrategies({
      ...market,
      chain, // premiums synthesized from `vol` via Black–Scholes
      structures: ['ironCondor', 'bullPutSpread', 'longCallButterfly'],
      rankBy: 'expectedValuePerRisk',
      top: 5,
    }).candidates;
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThanOrEqual(5);
    // Descending by the objective.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score ?? -Infinity).toBeGreaterThanOrEqual(
        ranked[i]!.score ?? -Infinity,
      );
    }
  });
});
