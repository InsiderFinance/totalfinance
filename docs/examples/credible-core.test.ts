/**
 * Runnable 0.1 examples (spec §21.2). Each documented snippet executes in CI with assertions, so the
 * docs cannot drift from working code.
 */

import { describe, expect, it } from 'vitest';
import { NYSE } from '@insiderfinance/totalfinance/calendars/nyse';
import * as performance from '@insiderfinance/totalfinance/performance';
import { bachelier, black76, type OptionBatchColumns } from '@insiderfinance/totalfinance/options';
import { blackScholesPriceMany } from '@insiderfinance/totalfinance/options/batch';
import * as ta from '@insiderfinance/totalfinance/technical-analysis';
import { legs, strategy } from '@insiderfinance/totalfinance/strategy';

describe('docs: options profit calculator (browser-safe)', () => {
  it('builds a bull call spread and reads its risk profile', () => {
    const position = strategy([
      legs.call({ strike: 100, premium: 4.25, quantity: 1 }),
      legs.call({ strike: 110, premium: 1.4, quantity: -1 }),
    ]);

    const { netDebit, maxProfit, maxLoss, breakevens } = position.metrics();
    expect(netDebit).toBeCloseTo(285, 6);
    expect(maxProfit).toBeCloseTo(715, 6);
    expect(maxLoss).toBeCloseTo(-285, 6);
    expect(breakevens[0]).toBeCloseTo(102.85, 6);

    const chart = position.payoff({ prices: { from: 90, to: 120, steps: 31 } });
    expect(chart.points).toHaveLength(31);
  });

  it('marks the position to market with Greeks', () => {
    const position = strategy.ironCondor({
      putLong: { strike: 90, premium: 0.8 },
      putShort: { strike: 95, premium: 1.9 },
      callShort: { strike: 110, premium: 2.1 },
      callLong: { strike: 115, premium: 0.9 },
    });
    const markToMarket = position.value({
      spot: 102,
      asOf: Date.UTC(2026, 0, 1),
      expiry: '2026-02-20',
      volatility: 0.25,
      riskFreeRate: 0.045,
    });
    expect(Number.isFinite(markToMarket.pnl)).toBe(true);
    expect(markToMarket.greeks).toHaveProperty('delta');
  });
});

describe('docs: technical analysis', () => {
  it('computes RSI and MACD with aligned warmup', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 6);
    const rsi = ta.rsi.explain(closes, { period: 14 });
    expect(rsi.value.length).toBe(closes.length);
    expect(rsi.diagnostics.warmup).toBe(14);

    const macd = ta.macd(closes, { fast: 12, slow: 26, signal: 9 });
    const last = macd.at(-1)!;
    expect(last.histogram).toBeCloseTo(last.macd - last.signal, 9);
  });

  it('streams an indicator and resumes from a serialized snapshot', () => {
    const prices = [100, 101, 102, 103, 104, 105, 106];
    const reference = ta.ema.stream({ period: 3 });
    const refOut = prices.map((p) => reference.next(p));

    const partial = ta.ema.stream({ period: 3 });
    for (let i = 0; i < 4; i++) partial.next(prices[i]!);
    const restored = ta.ema.fromJSON(JSON.parse(JSON.stringify(partial.toJSON())));
    expect(restored.next(prices[4]!)).toEqual(refOut[4]); // resumes identically
  });
});

describe('docs: bring-your-own-data option chain', () => {
  it('prices a columnar chain in one batch call', () => {
    const cols: OptionBatchColumns = {
      spot: Float64Array.from([100, 100, 100]),
      strike: Float64Array.from([95, 100, 105]),
      volatility: Float64Array.from([0.22, 0.2, 0.19]),
      riskFreeRate: Float64Array.from([0.045, 0.045, 0.045]),
      timeToExpiryYears: Float64Array.from([0.25, 0.25, 0.25]),
      type: Int8Array.from([1, 1, 1]),
    };
    const { price } = blackScholesPriceMany(cols, { greeks: true });
    expect(price).toHaveLength(3);
    expect(price[0]!).toBeGreaterThan(price[2]!); // lower strike call worth more
  });
});

describe('docs: performance metrics', () => {
  it('summarizes an equity curve', () => {
    const daily = Array.from({ length: 252 }, (_, i) => 100 * (1 + 0.0003) ** i);
    const summary = performance.analyze({ equity: daily }, { periodsPerYear: 252 });
    expect(summary.annualizedReturn).toBeGreaterThan(0);
    expect(summary.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});

describe('docs: other pricing models', () => {
  it('Black-76 and Bachelier price options on forwards', () => {
    expect(
      black76.call({
        forward: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
      }),
    ).toBeGreaterThan(0);
    expect(
      bachelier.call({
        forward: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        normalVolatility: 10,
      }),
    ).toBeCloseTo(10 / Math.sqrt(2 * Math.PI), 6);
  });
});

describe('docs: exchange calendar', () => {
  it('knows NYSE holidays and business days', () => {
    expect(NYSE.isHoliday('2026-12-25')).toBe(true);
    expect(NYSE.isBusinessDay('2026-12-24')).toBe(true);
    expect(NYSE.nextBusinessDay('2026-12-24')).toBe('2026-12-28'); // skip Christmas + weekend
  });
});
