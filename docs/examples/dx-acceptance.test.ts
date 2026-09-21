/**
 * DX completion acceptance (totalfinance-dx-completion-spec.md §10) — every probe here was run
 * against the pre-DX2 tree and either raw-crashed, silently lied, or didn't exist. This file is
 * the spec's ledger: each group maps to a workstream, and each assertion is a behavior the
 * library now guarantees.
 */

import { describe, expect, it } from 'vitest';
import { isComputed, isQuantError, resolvedExpiry } from '@totalfinance/core';
import * as backtest from '@totalfinance/backtest';
import { bonds } from '@totalfinance/fixed-income';
import { analyze, sharpe } from '@totalfinance/performance';
import { valueAtRisk } from '@totalfinance/risk';
import type { OptionQuote } from '@totalfinance/core';
import {
  bullCallSpread,
  classifyStrategy,
  inverseIronCondor,
  ironCondor,
  strategy,
  strategyFromChain,
} from '@totalfinance/strategy';
import { barsFromColumns, stoch } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 8);
const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
const market = {
  spot: 570,
  volatility: 0.18,
  riskFreeRate: 0.045,
  asOf: '2026-07-06T00:00:00Z',
  expiry: '2026-08-21',
} as const;
const condorSpecification = { putLong: 540, putShort: 550, callShort: 590, callLong: 600 } as const;

// Small synthetic chain for the strategyFromChain probes (spot 100; mirrors the fixture in
// packages/strategy/test/from-chain.test.ts).
const chainExpiry = '2026-04-17';
function chainQuote(
  type: 'call' | 'put',
  strike: number,
  mid: number,
  impliedVolatility: number,
  delta: number,
): OptionQuote {
  return {
    contract: {
      underlying: 'XYZ',
      type,
      style: 'american',
      strike,
      expiry: chainExpiry,
      ...resolvedExpiry(chainExpiry),
    },
    timestampMs: 0,
    bid: mid - 0.1,
    ask: mid + 0.1,
    mid,
    impliedVolatility,
    underlyingPrice: 100,
    greeks: { delta },
  };
}
// strike, mid, impliedVolatility, delta — per side.
const CHAIN_CALLS: Array<[number, number, number, number]> = [
  [85, 16.5, 0.29, 0.82],
  [90, 12.5, 0.28, 0.7],
  [95, 9.0, 0.27, 0.58],
  [100, 6.0, 0.26, 0.5],
  [105, 3.8, 0.25, 0.38],
  [110, 2.2, 0.24, 0.28],
  [115, 1.2, 0.23, 0.18],
];
const CHAIN_PUTS: Array<[number, number, number, number]> = [
  [85, 1.0, 0.31, -0.18],
  [90, 1.8, 0.3, -0.3],
  [95, 3.0, 0.29, -0.42],
  [100, 5.0, 0.28, -0.5],
  [105, 7.5, 0.27, -0.62],
  [110, 10.8, 0.26, -0.72],
  [115, 14.5, 0.25, -0.82],
];
const chain: OptionQuote[] = [
  ...CHAIN_CALLS.map(([k, m, impliedVolatility, d]) =>
    chainQuote('call', k, m, impliedVolatility, d),
  ),
  ...CHAIN_PUTS.map(([k, m, impliedVolatility, d]) =>
    chainQuote('put', k, m, impliedVolatility, d),
  ),
];

describe('Group A — the typed-error law (WS-1)', () => {
  it('backtest.vectorized({ close, signal }) teaches instead of raw-crashing', () => {
    let caught: unknown;
    try {
      backtest.vectorized({ close: closes, signal: closes.map(() => 1) } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof TypeError).toBe(false);
    expect(isQuantError(caught)).toBe(true);
    expect((caught as Error).message).toContain('data: Bar[]');
  });

  it('technicalAnalysis.rsi("hello") and string elements throw typed, never silent nulls', () => {
    expect(() => ta.rsi('hello' as never)).toThrowError(/technicalAnalysis\.rsi/);
    expect(() => ta.rsi([1, 2, 'x', 4] as never)).toThrowError(/series\[2\]/);
  });

  it('columnar arrays into stoch teach barsFromColumns; the converter round-trips', () => {
    expect(() => stoch({ high: [1], low: [0], close: [0.5] } as never)).toThrowError(
      /barsFromColumns/,
    );
    const bars = barsFromColumns({
      high: closes.map((c) => c + 2),
      low: closes.map((c) => c - 2),
      close: [...closes],
    });
    expect(stoch(bars)).toHaveLength(closes.length);
  });

  it('bonds.fixedRate names the missing field', () => {
    expect(() =>
      (bonds as { fixedRate: (s: unknown) => unknown }).fixedRate({
        couponRate: 0.05,
        maturityDate: '2031-07-06',
        frequency: 2,
      }),
    ).toThrowError(/issueDate is required/);
  });

  it('strategyFromChain teaches on garbage, and a real chain builds legs with expiry + provenance', () => {
    // Garbage options throw the typed teaching error (never a raw TypeError)…
    let caught: unknown;
    try {
      strategyFromChain(chain, 42 as never);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof TypeError).toBe(false);
    expect(isQuantError(caught)).toBe(true);
    expect((caught as Error).message).toContain('shortDelta');
    // …and the happy path builds from the chain: the position remembers the selection expiry (R4)
    // — every resolved leg carries it — and stamps what it was constructed as.
    const res = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry: chainExpiry,
      shortDelta: 0.3,
      wingWidth: 5,
    });
    expect(res.legs).toHaveLength(4);
    for (const leg of res.position.legs) expect(leg.expiry).toBe(chainExpiry);
    expect(res.position.constructedAs).toBe('ironCondor');
  });
});

describe('Group B — one envelope (WS-2)', () => {
  it('technicalAnalysis.rsi.explain(closes) is a Computed envelope echoing the default period', () => {
    const r = ta.rsi.explain(closes);
    expect(isComputed(r)).toBe(true);
    expect(r.assumptions.parameters).toEqual({ period: 14 });
    expect(r.diagnostics.warmup).toBe(14);
  });

  it('valueAtRisk.explain echoes { confidence: 0.95, method: historical, horizonPeriods: 1 }', () => {
    const r = valueAtRisk.explain(closes.map((c, i) => (i ? c / closes[i - 1]! - 1 : 0)));
    expect(isComputed(r)).toBe(true);
    expect(r.assumptions.confidence).toBe(0.95);
    expect(r.assumptions.method).toBe('historical');
    expect(r.assumptions.horizonPeriods).toBe(1);
  });

  it('analyze.explain returns the envelope with echoed conventions', () => {
    const r = analyze.explain({ returns: [0.01, -0.02, 0.015] });
    expect(isComputed(r)).toBe(true);
    expect(r.assumptions.periodsPerYear).toBe(252);
  });

  it('backtest.vectorized({...}).assumptions.fill — policies live in assumptions, not diagnostics', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const data = closes.map((c, i) => ({
      symbol: 'TEST',
      timestampMs: t0 + i * 86_400_000,
      open: c,
      high: c,
      low: c,
      close: c,
    }));
    const r = backtest.vectorized({
      data,
      signal: closes.map(() => true),
      initialCapital: 1000,
    });
    expect(r.assumptions.fill).toBe('close');
  });
});

describe('Group C — strategy coherence (WS-4)', () => {
  it('the dx-specification §3.4 sketch works verbatim: expiry in the input, model premiums', () => {
    const pos = ironCondor(
      { ...condorSpecification, expiry: '2026-08-21' },
      {
        premiums: 'model',
        market: { spot: 570, volatility: 0.18, riskFreeRate: 0.045, asOf: '2026-07-06T00:00:00Z' },
      },
    );
    expect(pos.premiumSource).toBe('model');
    expect(pos.legs[0]!.expiry).toBe('2026-08-21');
  });

  it('probability() with ZERO arguments works on a model-premium position', () => {
    const p = ironCondor(condorSpecification, { premiums: 'model', market }).probability();
    expect(p.probabilityOfProfit).toBeGreaterThan(0);
    expect(p.probabilityOfProfit).toBeLessThan(1);
    expect(p.assumptions.marketSource).toBe('construction');
  });

  it('partial overrides echo marketSource merged', () => {
    const p = ironCondor(condorSpecification, { premiums: 'model', market }).probability({
      spot: 575,
    });
    expect(p.assumptions.marketSource).toBe('merged');
  });

  it('legs are a frozen snapshot; rebuild-after-tweak works for ANY leg combo', () => {
    const pos = ironCondor(condorSpecification, { premiums: 'model', market });
    expect(() => (pos.legs as unknown as unknown[]).push({})).toThrow(TypeError);
    const edited = pos.legs.filter((l) => l.strike !== 600).map((l) => ({ ...l }));
    expect(strategy(edited).metrics().breakevens.length).toBeGreaterThan(0);
  });

  it('one grammar: bare strikes are shorthand; condor and inverse share an input type', () => {
    expect(
      bullCallSpread({ long: 540, short: 550 }, { premiums: 'model', market }).legs,
    ).toHaveLength(2);
    const both = { putLong: 540, putShort: 550, callShort: 590, callLong: 600 };
    expect(ironCondor(both, { premiums: 'model', market }).legs.map((l) => l.quantity)).toEqual(
      inverseIronCondor(both, { premiums: 'model', market }).legs.map((l) => -l.quantity),
    );
  });

  it('identity is derived: classifyStrategy recognizes, provenance never lies', () => {
    const pos = ironCondor(condorSpecification, { premiums: 'model', market });
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('ironCondor');
    expect(pos.constructedAs).toBe('ironCondor');
    const tweaked = pos.legs.filter((l) => l.kind !== 'put');
    expect(classifyStrategy(tweaked).matches.map((m) => m.name)).toContain('bearCallSpread');
    expect(strategy([...pos.legs]).constructedAs).toBeUndefined();
  });
});

describe('Group D — plausibility (WS-3)', () => {
  it('sharpe.explain(prices) flags input.suspicious_returns instead of a silent 117', () => {
    const r = sharpe.explain(prices);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('input.suspicious_returns');
  });

  it('valueAtRisk.explain(prices) flags it too', () => {
    expect(valueAtRisk.explain(prices).diagnostics.warnings.map((w) => w.code)).toContain(
      'input.suspicious_returns',
    );
  });
});
