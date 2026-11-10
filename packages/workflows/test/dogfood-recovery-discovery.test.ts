import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  createOperationRegistry,
  backtestPack,
  calendarPack,
  researchPack,
  technicalAnalysisPack,
  portfolioPack,
  tradePack,
  toOperationError,
} from '../src/index.js';
import { PARITY_FIXTURES } from '../../../tools/transport-parity/fixtures.js';
import { vectorized, fees, slippage } from '@totalfinance/backtest';
import { ohlcvFromBars, atr } from '@totalfinance/technical-analysis';
import { NYSE, US_EQUITY_CALENDAR_COVERAGE } from '@totalfinance/calendars';

const registry = () =>
  createOperationRegistry({
    packs: [
      backtestPack(),
      calendarPack(),
      researchPack(),
      technicalAnalysisPack(),
      portfolioPack(),
      tradePack(),
    ],
  });
const data = () =>
  ['2026-01-29', '2026-01-30', '2026-02-02', '2026-02-03', '2026-03-02'].map((date, i) => ({
    symbol: 'TEST',
    timestampMs: Date.parse(date),
    open: 100 + i * 10,
    high: 100 + i * 10,
    low: 100 + i * 10,
    close: 100 + i * 10,
    volume: 100,
  }));

describe('first-failure recovery and discovery', () => {
  it('bounds repeated row errors and preserves counts and indexed field teaching', () => {
    const r = registry();
    const op = r.require('totalfinance.technical_analysis.calculate');
    const bars = Array.from({ length: 200 }, (_, index) => ({
      ...data()[0]!,
      timestampMs: 1000 + index,
      extraHigh: 2,
      extraLow: 0,
    }));
    let mapped;
    try {
      r.run({ id: op.id, input: { indicator: 'atr', bars, parameters: { period: 1 } } });
    } catch (error) {
      mapped = toOperationError(error, op);
    }
    expect(mapped).toMatchObject({ code: 'input.unknown_field', context: { issueCount: 400 } });
    const context = mapped!.context;
    expect((context['issues'] as unknown[]).length).toBeLessThanOrEqual(10);
    expect(context['omittedIssueCount']).toBe(400 - (context['issues'] as unknown[]).length);
    expect(JSON.stringify(mapped).length).toBeLessThan(6000);
    expect((context['issues'] as { path: unknown[] }[])[0]!.path).toContain(0);
    const fixed = r.run({
      id: op.id,
      input: {
        indicator: 'atr',
        bars: bars.map(({ extraHigh: _high, extraLow: _low, ...bar }) => bar),
        parameters: { period: 1 },
      },
    });
    expect(fixed.structured['value']).toHaveLength(200);
    expect(JSON.stringify(r.describe(op.id))).toContain('canonical');
  });

  it('accepts raw canonical bars and original OHLCV rows with the same financial result', () => {
    const bars = [
      {
        symbol: 'TEST',
        timestampMs: 1000,
        open: 10,
        high: 12,
        low: 8,
        close: 10,
        vwap: 10,
        adjusted: false,
      },
      {
        symbol: 'TEST',
        timestampMs: 2000,
        open: 12,
        high: 14,
        low: 10,
        close: 12,
        vwap: 12,
        adjusted: false,
      },
    ];
    const before = structuredClone(bars);
    const run = (rows: unknown[]) =>
      registry().run({
        id: 'totalfinance.technical_analysis.calculate',
        input: { indicator: 'atr', bars: rows, parameters: { period: 1 } },
      });
    expect(run(bars).structured['value']).toEqual([4, 4]);
    expect(run(bars).structured).toEqual(run(ohlcvFromBars(bars)).structured);
    expect(atr(bars, { period: 1 })).toEqual([4, 4]);
    expect(bars).toEqual(before);
    const validate = new AjvJsonSchemaValidator().getValidator(
      registry().require('totalfinance.technical_analysis.calculate').inputSchema.toJSONSchema(),
    );
    expect(validate({ indicator: 'atr', bars, parameters: { period: 1 } }).valid).toBe(true);
  });

  it('refuses malformed source series and unknown keys instead of sorting or discarding them', () => {
    const bars = data();
    for (const rows of [
      [...bars].reverse(),
      [bars[0], bars[0]],
      [bars[0], { ...bars[1], symbol: 'OTHER' }],
      [bars[0], { high: 110, low: 110, close: 110 }],
      [{ ...bars[0], timestampMs: undefined }],
      [{ ...bars[0], vwap: '100' }],
      [{ ...bars[0], adjusted: 'false' }],
      [...bars.slice(0, -1), { ...bars.at(-1), close: Infinity }],
      [{ ...bars[0], unexpected: 1 }],
    ]) {
      expect(() =>
        registry().run({
          id: 'totalfinance.technical_analysis.calculate',
          input: { indicator: 'atr', bars: rows, parameters: { period: 1 } },
        }),
      ).toThrow(expect.objectContaining({ name: 'InputError' }));
    }
  });

  it('makes the category route evident without changing name search', () => {
    const r = registry();
    const described = JSON.stringify(r.describe('totalfinance.technical_analysis.list'));
    expect(described).toContain('category');
    expect(described).toContain('momentum');
    const run = (input: Record<string, unknown>) =>
      r.run({ id: 'totalfinance.technical_analysis.list', input }).structured;
    expect(run({ category: 'momentum', limit: 100 })['total'] as number).toBeGreaterThan(
      run({ search: 'momentum', limit: 100 })['total'] as number,
    );
  });

  it('publishes and executes the recursive finite screen grammar', () => {
    const r = registry();
    const op = r.require('totalfinance.research.screen');
    const input = PARITY_FIXTURES[op.id]!();
    const validate = new AjvJsonSchemaValidator().getValidator(op.inputSchema.toJSONSchema());
    expect(validate(input).valid).toBe(true);
    expect(
      validate({ ...input, filter: { field: 'momentum', operator: 'in', values: [] } }).valid,
    ).toBe(false);
    expect(
      validate({ ...input, filter: { field: 'momentum', operator: 'gt', value: 0 } }).valid,
    ).toBe(false);
    expect(
      validate({
        ...input,
        filter: { not: { field: 'momentum', operator: 'greaterThan', value: 0 } },
      }).valid,
    ).toBe(true);
    expect(() =>
      r.run({
        id: op.id,
        input: { ...input, filter: { field: 'momentum', operator: 'gt', value: 0 } },
      }),
    ).toThrow(/greaterThan/);
    expect(r.run({ id: op.id, input }).structured).toHaveProperty('rows');
  });

  it('discloses calendar coverage without altering historical answers', () => {
    expect(US_EQUITY_CALENDAR_COVERAGE.historicalFloor).toBe('2001-01-01');
    const old = registry().run({
      id: 'totalfinance.calendar.sessions',
      input: { calendar: 'NYSE', from: '1994-04-27', to: '1994-04-27' },
    });
    expect(old.structured['tradingDays']).toEqual(
      NYSE.isTradingDay('1994-04-27') ? ['1994-04-27'] : [],
    );
    expect(old.diagnostics.warnings).toMatchObject([
      { code: 'calendar.outside_historical_coverage' },
    ]);
    expect(
      registry().run({
        id: 'totalfinance.calendar.sessions',
        input: { calendar: 'NYSE', from: '2025-01-09', to: '2025-01-09' },
      }).structured['holidays'],
    ).toEqual(['2025-01-09']);
    expect(
      registry().run({
        id: 'totalfinance.calendar.sessions',
        input: { calendar: 'crypto24x7', from: '1994-04-27', to: '1994-04-27' },
      }).diagnostics.warnings,
    ).toEqual([]);
  });

  it('deduplicates stable mark-age warnings without changing timestamps or marks', () => {
    const r = registry();
    const input = PARITY_FIXTURES['totalfinance.portfolio.analyze']!();
    const market = input['market'] as Record<string, unknown>;
    const originalAsOf = market['asOf'] as number;
    const changed = { ...input, asOf: originalAsOf + 60_000 };
    const result = r.run({ id: 'totalfinance.portfolio.analyze', input: changed });
    const warnings = result.diagnostics.warnings.filter(
      (warning) => warning.code === 'portfolio.market_mark_age',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('60000 ms');
    expect(warnings[0]!.message).toContain('preserve its actual source timestamp');
    expect(market['asOf']).toBe(originalAsOf);
  });
});

describe('declarative vectorized controls delegate to the SDK', () => {
  it('preserves old calls and matches declared controls, including the monthly/lag interaction', () => {
    const r = registry();
    const input = {
      data: data(),
      signal: [0, 1, 1, 1, 1],
      initialCapital: 1000,
      executionLag: 2,
      rebalance: 'monthly' as const,
      periodsPerYear: 12,
      riskFreeRate: 0.02,
      maxLeverage: 1,
      feeBps: 0,
      slippageBps: 0,
    };
    // feeBps/slippageBps belong only to the wire: pass the SDK's actual control shape.
    const { feeBps, slippageBps, ...controls } = input;
    const direct = vectorized({
      ...controls,
      fees: fees.bps(feeBps),
      slippage: slippage.bps(slippageBps),
    });
    expect(direct.trades.map((trade) => trade.timestampMs)).toEqual([Date.parse('2026-03-02')]);
    expect(direct.finalValue).toBe(1000);
    const result = r.run({ id: 'totalfinance.backtest.vectorized_run', input }).structured;
    expect(result).toMatchObject({
      finalValue: direct.finalValue,
      turnover: direct.turnover,
      assumptions: direct.assumptions,
      diagnostics: direct.diagnostics,
    });
    expect(
      r.run({
        id: 'totalfinance.backtest.vectorized_run',
        input: { data: data(), signal: [0, 1, 1, 1, 1] },
      }).structured['finalValue'],
    ).toBeCloseTo(140 / 120, 12);
  });
});

describe('zero ceilings through wire validation', () => {
  it('uses a real zero bound with the same domain judgment', () => {
    const r = registry();
    const input = PARITY_FIXTURES['totalfinance.trade.preflight']!();
    const policy = {
      ...(input['policy'] as object),
      maximumEstimatedCost: 0,
      maximumSlippageBps: 0,
    };
    const run = (costs: Record<string, number>) =>
      r.run({ id: 'totalfinance.trade.preflight', input: { ...input, policy, costs } }).structured;
    expect(run({ commissionBps: 0, slippageBps: 0 })['decision']).toMatchObject({
      verdict: 'allow',
    });
    expect(run({ commissionBps: 1 })['decision']).toMatchObject({ verdict: 'deny' });
    expect(run({ slippageBps: 1 })['decision']).toMatchObject({ verdict: 'deny' });
    for (const value of [-1, null, '0', Infinity]) {
      expect(() =>
        r.run({
          id: 'totalfinance.trade.preflight',
          input: { ...input, policy: { ...policy, maximumEstimatedCost: value } },
        }),
      ).toThrow(expect.objectContaining({ name: 'InputError' }));
    }
  });
});

it('preserves non-schema QuantError context rather than treating arbitrary arrays as schema issues', () => {
  const context = { issues: Array.from({ length: 20 }, (_, index) => index) };
  const error = new InputError('synthetic refusal', { code: ErrorCode.InputWrongShape, context });
  expect(toOperationError(error, null).context).toEqual(context);
});
