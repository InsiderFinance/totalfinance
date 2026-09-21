/** Stage 4.6 slice 4 — the 'options' run-artifact kind: save → JSON → read → replay → compare. */
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  isoDateToEpochMs,
  resolvedExpiry,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionQuote } from '@totalfinance/core';
import { fees, slippage } from '@totalfinance/backtest';
import {
  backtestRunArtifact,
  compareBacktestRuns,
  readBacktestRun,
  replayBacktestRun,
  BACKTEST_RUN_KINDS,
} from '@totalfinance/backtest/artifacts';
import {
  optionsBacktest,
  type ChainSnapshot,
  type OptionsBacktestConfig,
} from '@totalfinance/backtest/options';

const DAY = 86_400_000;
function addDays(start: string, days: number): string {
  return new Date(isoDateToEpochMs(start) + days * DAY).toISOString().slice(0, 10);
}
/** End-of-day chains are observed at the close; expiries settle at their own close instant. */
const instantOf = (date: string): number => usEquitySessionInstant(date, 'close');
function chain(date: string, spot: number, expiries: readonly string[]): ChainSnapshot {
  const ts = instantOf(date);
  const quotes: OptionQuote[] = [];
  for (const expiry of expiries) {
    const t = (optionExpiryToMs(expiry) - ts) / (DAY * 365);
    if (t <= 0) continue;
    for (let k = 80; k <= 120; k += 5) {
      for (const type of ['call', 'put'] as const) {
        quotes.push({
          contract: {
            underlying: 'XYZ',
            type,
            style: 'european',
            strike: k,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: 100,
          },
          timestampMs: ts,
          mid: blackScholesPrice({
            type,
            spot,
            strike: k,
            timeToExpiryYears: t,
            riskFreeRate: 0.04,
            dividendYield: 0,
            volatility: 0.2,
          }),
          impliedVolatility: 0.2,
          greeks: {
            delta: blackScholesGreeks({
              type,
              spot,
              strike: k,
              timeToExpiryYears: t,
              riskFreeRate: 0.04,
              dividendYield: 0,
              volatility: 0.2,
            }).delta,
          },
          underlyingPrice: spot,
        });
      }
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}
const START = '2026-01-05';
const EXPIRIES = [addDays(START, 49), addDays(START, 84)];
const chains = (): ChainSnapshot[] =>
  Array.from({ length: 8 }, (_, i) => chain(addDays(START, i * 7), 100, EXPIRIES));
const config = (): OptionsBacktestConfig => ({
  chains: chains(),
  riskFreeRate: 0.04,
  entry: {
    daysToExpiry: { target: 45, min: 30, max: 60 },
    structure: 'bullPutSpread',
    select: { shortDelta: 0.3, width: 5 },
  },
  exit: { profitTarget: 0.5, daysToExpiry: 21 },
  commission: fees.bps(1),
  slippage: slippage.bps(2),
});

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe("the 'options' run-artifact kind", () => {
  it('is in the kind table with its row sets, callbacks, and model fields', () => {
    expect(BACKTEST_RUN_KINDS.options.operation).toBe('optionsBacktest');
    expect(BACKTEST_RUN_KINDS.options.inputRowSets).toEqual([
      'chains',
      'corporateActions',
      'dividends',
    ]);
    expect(BACKTEST_RUN_KINDS.options.resultRowSets).toContain('run.ledger.events');
    expect(BACKTEST_RUN_KINDS.options.modelFields).toEqual([
      'commission',
      'slippage',
      'hedge.commission',
      'hedge.slippage',
    ]);
  });

  it('saves, restores, replays with the live cost models, and compares', () => {
    const input = config();
    const run = optionsBacktest(input);
    const artifact = backtestRunArtifact({
      kind: 'options',
      run,
      input,
      referenceRowSets: ['chains'],
    });
    expect(artifact.producedBy.operation).toBe('optionsBacktest');
    const { report } = readBacktestRun({ artifact: fromCanonicalJson(canonicalJsonOf(artifact)) });
    expect(report.kind).toBe('options');
    expect(report.identity.runId).toBe(run.runId);
    expect(report.identity.universeId).toBe('XYZ');
    expect(report.identity.models).toEqual({
      execution: null,
      commission: 'bps(1)',
      slippage: 'bps(2)',
    });
    expect(report.identity.strategy['kind']).toBe('options-rules');
    expect((report.inputs['commission'] as { label: string }).label).toBe('bps(1)');
    expect(report.assumptions.replayable).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain('commission(');
    const missing = failure(() =>
      replayBacktestRun({ artifact, referencedData: { chains: input.chains as unknown[] } }),
    );
    expect(missing.code).toBe(ErrorCode.InputMissingField);
    expect(missing.message).toContain("models.labeled['commission']");
    const replay = replayBacktestRun({
      artifact,
      referencedData: { chains: input.chains as unknown[] },
      models: { labeled: { commission: fees.bps(1), slippage: slippage.bps(2) } },
    });
    expect(replay.matches).toBe(true);
    expect(replay.parity.identical).toBe(true);
    const wrong = failure(() =>
      replayBacktestRun({
        artifact,
        referencedData: { chains: input.chains as unknown[] },
        models: { labeled: { commission: fees.bps(9), slippage: slippage.bps(2) } },
      }),
    );
    expect(wrong.code).toBe(ErrorCode.BacktestAdapterNonconformant);
    const other = { ...config(), exit: { profitTarget: 0.25, daysToExpiry: 21 } };
    const candidate = backtestRunArtifact({
      kind: 'options',
      run: optionsBacktest(other),
      input: other,
    });
    const comparison = compareBacktestRuns({ baseline: artifact, candidate });
    expect(comparison.kind).toBe('options');
    expect(comparison.sameStrategy).toBe(false);
    expect(comparison.metrics.map((m) => m.name)).toContain('finalValue');
    expect(comparison.holdings).toBeNull();
  });

  it('a build callback makes the run non-replayable by name', () => {
    const { entry: _entry, ...rest } = config();
    const input: OptionsBacktestConfig = {
      ...rest,
      rules: [{ id: 'custom', daysToExpiry: { target: 45 }, build: () => null }],
    };
    const run = optionsBacktest(input);
    const artifact = backtestRunArtifact({ kind: 'options', run, input });
    const { report } = readBacktestRun({ artifact });
    expect(report.assumptions.replayable).toBe(false);
    expect(report.assumptions.nonReplayableField).toBe('rules[0].build');
    expect(failure(() => replayBacktestRun({ artifact })).code).toBe(
      ErrorCode.ArtifactNotReplayable,
    );
  });
});
