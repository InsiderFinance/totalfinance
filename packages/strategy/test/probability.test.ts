/**
 * Tests for §12.6 probability & scenario metrics: probability of profit, expected value,
 * reward/risk, probability of touch, and the scenario table — verified against closed forms.
 */

import { describe, expect, it } from 'vitest';
import { optionExpiryToMs, yearFraction } from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { legs, strategy } from '@totalfinance/strategy';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-04-02';
// Mirror the library's option-expiry convention (date-only → 16:00 ET) so the reference t matches.
const t = yearFraction(asOf, optionExpiryToMs(expiry), 'ACT/365F');
const rate = 0.04;
const vol = 0.25;
const market = { asOf, expiry, volatility: vol, riskFreeRate: rate } as const;

describe('long call probability', () => {
  const K = 100;
  const premium = 5;
  const S0 = 100;
  const pos = strategy([legs.call({ strike: K, premium, quantity: 1 })]);

  it('POP = risk-neutral P(S_T > breakeven); EV cross-checks the forward-value of the call', () => {
    const p = pos.probability({ ...market, spot: S0 });
    const be = K + premium; // 105
    const d2 = (Math.log(S0 / be) + (rate - 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
    expect(p.probabilityOfProfit).toBeCloseTo(normalCdf(d2), 6);

    // E[max(S_T−K,0)] (risk-neutral, undiscounted) = e^{rT}·BSM call price; EV = 100·(that − premium)
    const evExpected =
      100 *
      (Math.exp(rate * t) *
        blackScholesPrice({
          type: 'call',
          spot: S0,
          strike: K,
          timeToExpiryYears: t,
          riskFreeRate: rate,
          dividendYield: 0,
          volatility: vol,
        }) -
        premium);
    expect(p.expectedValue).toBeCloseTo(evExpected, 6);

    // Unbounded upside: the ratio is undefined — null, with the reason in diagnostics (B3).
    expect(p.riskReward).toBeNull();
    expect(p.diagnostics.warnings.map((w) => w.code)).toEqual(['strategy.risk_reward_undefined']);
    expect(p.diagnostics.warnings[0]!.message).toContain('maximum profit is unbounded');
    expect(p.probabilityOfTouch).toHaveLength(1);
    expect(p.probabilityOfTouch[0]!.price).toBeCloseTo(be, 9);
    // touch ≥ terminal probability of finishing beyond the breakeven
    expect(p.probabilityOfTouch[0]!.probability).toBeGreaterThan(p.probabilityOfProfit);
    expect(p.assumptions.probabilityModel.measure).toBe('riskNeutral');
    expect(p.assumptions.probabilityModel.drift).toBeCloseTo(rate, 12);
  });
});

describe('iron condor probability (defined risk, two breakevens)', () => {
  // short 95 put / long 90 put / short 105 call / long 110 call, net credit
  const pos = strategy.ironCondor({
    putLong: { strike: 90, premium: 0.7 },
    putShort: { strike: 95, premium: 1.5 },
    callShort: { strike: 105, premium: 1.6 },
    callLong: { strike: 110, premium: 0.8 },
  });

  it('POP is the probability of landing between the two breakevens; risk/reward is finite', () => {
    const m = pos.metrics();
    expect(m.breakevens).toHaveLength(2);
    const p = pos.probability({ ...market, spot: 100 });
    const [lo, hi] = [...m.breakevens].sort((a, b) => a - b);
    const cdf = (k: number): number => {
      const d2 = (Math.log(100 / k) + (rate - 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
      return normalCdf(-d2);
    };
    expect(p.probabilityOfProfit).toBeCloseTo(cdf(hi!) - cdf(lo!), 6);
    expect(p.probabilityOfProfit).toBeGreaterThan(0);
    expect(p.probabilityOfProfit).toBeLessThan(1);
    expect(Number.isFinite(p.riskReward)).toBe(true);
    expect(p.diagnostics.warnings).toEqual([]);
    expect(p.probabilityOfTouch).toHaveLength(2);
  });
});

describe('real-world measure', () => {
  it('uses the supplied expected return as the drift', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    const p = pos.probability({
      ...market,
      spot: 100,
      measure: 'realWorld',
      expectedReturn: 0.12,
    });
    expect(p.assumptions.probabilityModel.measure).toBe('realWorld');
    expect(p.assumptions.probabilityModel.drift).toBeCloseTo(0.12, 12); // q = 0
    // a higher drift than risk-neutral raises the probability of profit for a long call
    const rn = pos.probability({ ...market, spot: 100 });
    expect(p.probabilityOfProfit).toBeGreaterThan(rn.probabilityOfProfit);
  });

  it('rejects an unknown measure rather than silently defaulting to risk-neutral', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    expect(() =>
      pos.probability({ ...market, spot: 100, measure: 'bogus' as 'realWorld' }),
    ).toThrow(/measure/);
  });

  it('rejects a non-finite expectedReturn rather than emitting NaN metrics', () => {
    const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    expect(() =>
      pos.probability({
        ...market,
        spot: 100,
        measure: 'realWorld',
        expectedReturn: NaN,
      }),
    ).toThrow(/expectedReturn/);
  });
});

describe('scenario table', () => {
  const pos = strategy.bullCallSpread({
    long: { strike: 100, premium: 4.25 },
    short: { strike: 110, premium: 1.4 },
  });

  it('produces a spot × vol × time grid whose base cell matches value() (R2 envelope)', () => {
    const table = pos.scenarioTable({
      market,
      prices: [95, 100, 105],
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward: [0, 7],
    });
    const rows = table.value;
    expect(rows).toHaveLength(3 * 3 * 2);
    expect(table.diagnostics.warnings).toEqual([]); // no shock drives vol below the floor here
    // One-envelope law (R2): the grid is `value`, marketSource rides assumptions, warnings ride
    // diagnostics — no hoisted fields.
    expect(table.assumptions.conventionsVersion).toBeTypeOf('string');
    expect(table.assumptions.marketSource).toBe('call'); // no construction market on this position
    expect('rows' in table).toBe(false);
    const base = rows.find(
      (r) => r.underlyingPrice === 100 && r.volatilityShock === 0 && r.daysForward === 0,
    )!;
    const markToMarket = pos.value({ ...market, spot: 100 });
    expect(base.pnl).toBeCloseTo(markToMarket.pnl, 9);
    expect(base.delta).toBeCloseTo(markToMarket.greeks.delta, 9);
  });

  it('warns strategy.volatility_floored when a vol shock drives volatility below the floor (WS3.7)', () => {
    // market.vol here is ~0.2; a −0.5 shock lands well below the 1e-6 floor for every price
    const { value: rows, diagnostics } = pos.scenarioTable({
      market,
      prices: [100],
      volatilityShocks: [0, -0.5],
    });
    expect(rows).toHaveLength(2);
    const w = diagnostics.warnings.find((x) => x.code === 'strategy.volatility_floored');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warn');
    expect((w!.context as { clampedCells: number }).clampedCells).toBe(1); // only the −0.5 cell
  });
});

describe('Monte-Carlo probabilities (cross-validate the analytic metrics)', () => {
  const pos = strategy.bullCallSpread({
    long: { strike: 100, premium: 4.25 },
    short: { strike: 110, premium: 1.4 },
  });
  const mkt = { ...market, spot: 100 };

  it('MC POP, EV, and prob-of-touch agree with the closed-form metrics', () => {
    const analytic = pos.probability(mkt);
    const monteCarlo = pos.monteCarloProbability({ ...mkt, seed: 7, paths: 40_000, steps: 40 });
    expect(monteCarlo.probabilityOfProfit).toBeCloseTo(analytic.probabilityOfProfit, 2);
    expect(Math.abs(monteCarlo.expectedValue - analytic.expectedValue)).toBeLessThan(
      4 * monteCarlo.expectedValueStandardError + 0.05,
    );
    expect(monteCarlo.probabilityOfTouch).toHaveLength(analytic.probabilityOfTouch.length);
    for (let i = 0; i < monteCarlo.probabilityOfTouch.length; i++) {
      expect(monteCarlo.probabilityOfTouch[i]!.probability).toBeCloseTo(
        analytic.probabilityOfTouch[i]!.probability,
        1, // within ~0.05
      );
    }
    expect(monteCarlo.assumptions.probabilityModel.measure).toBe('riskNeutral');
  });

  it('is deterministic given the seed and validates its inputs', () => {
    const a = pos.monteCarloProbability({ ...mkt, seed: 3, paths: 5000 });
    const b = pos.monteCarloProbability({ ...mkt, seed: 3, paths: 5000 });
    expect(a.probabilityOfProfit).toBe(b.probabilityOfProfit);
    expect(a.expectedValue).toBe(b.expectedValue);
    expect(a.seed).toBe(3); // echoed for reproducibility
    expect(() => pos.monteCarloProbability({ ...mkt, seed: NaN })).toThrow(/seed/);
    expect(() => pos.monteCarloProbability({ ...mkt, seed: 1, paths: 1 })).toThrow(/paths/);
    // A bare call teaches the seed requirement directly — and stays an error (determinism law:
    // a stochastic call is never silently seeded; alignment spec P1.6).
    expect(() => (pos.monteCarloProbability as () => unknown)()).toThrow(
      /must be explicitly seeded — call monteCarloProbability\(\{ seed: 42 \}\)/,
    );
  });
});

describe('smile-aware Monte-Carlo probabilities (local-volatility paths)', () => {
  // A wide short strangle so both wings can be touched; downside vol drives the put side.
  const pos = strategy.ironCondor({
    putLong: { strike: 80, premium: 0.6 },
    putShort: { strike: 90, premium: 1.4 },
    callShort: { strike: 110, premium: 1.3 },
    callLong: { strike: 120, premium: 0.5 },
  });
  const mkt = { ...market, spot: 100 };

  it('a flat local-volatility surface reproduces the constant-σ result bit-for-bit (the anchor)', () => {
    const constant = pos.monteCarloProbability({
      ...mkt,
      volatility: 0.25,
      seed: 11,
      paths: 8000,
      steps: 40,
    });
    const flatLocal = pos.monteCarloProbability({
      ...mkt,
      localVolatility: () => 0.25,
      seed: 11,
      paths: 8000,
      steps: 40,
    });
    expect(flatLocal.probabilityOfProfit).toBe(constant.probabilityOfProfit);
    expect(flatLocal.expectedValue).toBe(constant.expectedValue);
    expect(flatLocal.assumptions.probabilityModel.volatilityModel).toBe('localVolatility');
    expect(constant.assumptions.probabilityModel.volatilityModel).toBe('lognormal');
  });

  it('a downside skew raises the put-side touch probability vs a flat surface', () => {
    // Equity skew: σ_loc is 20% ATM/above and steepens sharply as the underlying falls (≈34% at the
    // ~88 put breakeven), so downside excursions are more volatile than a flat 20% surface.
    const skew = (level: number): number => 0.2 + 1.2 * Math.max(0, (100 - level) / 100);
    const flat = pos.monteCarloProbability({
      ...mkt,
      volatility: 0.2,
      seed: 21,
      paths: 30_000,
      steps: 60,
    });
    const skewed = pos.monteCarloProbability({
      ...mkt,
      localVolatility: skew,
      seed: 21,
      paths: 30_000,
      steps: 60,
    });
    const putBe = (r: typeof flat): number => Math.min(...r.probabilityOfTouch.map((x) => x.price));
    const putTouch = (r: typeof flat): number =>
      r.probabilityOfTouch.find((x) => x.price === putBe(r))!.probability;
    expect(putTouch(skewed)).toBeGreaterThan(putTouch(flat) + 0.02);
    // The representative echo vol is the local vol at spot (20%).
    expect(skewed.assumptions.probabilityModel.volatility).toBeCloseTo(0.2, 6);
  });

  it('reports the requested expiration-P&L quantiles (profit cone), ascending', () => {
    const monteCarlo = pos.monteCarloProbability({
      ...mkt,
      volatility: 0.25,
      seed: 5,
      paths: 10_000,
      steps: 30,
      pnlQuantiles: [0.05, 0.5, 0.95],
    });
    expect(monteCarlo.pnlQuantiles).toHaveLength(3);
    expect(monteCarlo.pnlQuantiles![0]!.pnl).toBeLessThanOrEqual(monteCarlo.pnlQuantiles![1]!.pnl);
    expect(monteCarlo.pnlQuantiles![1]!.pnl).toBeLessThanOrEqual(monteCarlo.pnlQuantiles![2]!.pnl);
    expect(() =>
      pos.monteCarloProbability({ ...mkt, volatility: 0.25, seed: 5, pnlQuantiles: [1.5] }),
    ).toThrow(/pnlQuantile/);
  });

  it('requires either vol or localVolatility, and rejects a bad local-volatility σ', () => {
    const { volatility: _omit, ...marketNoVolatility } = market;
    expect(() => pos.monteCarloProbability({ ...marketNoVolatility, spot: 100, seed: 1 })).toThrow(
      /vol|localVolatility/,
    );
    expect(() =>
      pos.monteCarloProbability({
        ...mkt,
        localVolatility: () => -1,
        seed: 1,
        paths: 100,
        steps: 5,
      }),
    ).toThrow(/localVolatility/);
  });
});
