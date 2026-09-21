import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CDL_ALIASES, cdlPattern } from '@totalfinance/technical-analysis/candle-aliases';

/**
 * TA-Lib candlestick parity (61 `CDL*` functions).
 *
 * TotalFinance's candlestick detectors use *fixed* body/shadow/range ratios, whereas TA-Lib uses an
 * *adaptive* trailing-average engine (`TA_SetCandleSettings`, a 10-bar body average by default).
 * The two therefore differ in three documented ways (see docs/compatibility/talib-differences.md):
 *   1. TA-Lib suppresses every pattern through its averaging warmup (~10–12 bars); TotalFinance does not.
 *   2. TotalFinance's fixed thresholds are slightly more sensitive (a few percent more signals).
 *   3. TotalFinance emits ±100; TA-Lib occasionally emits ±200 (pattern + confirming marubozu).
 *
 * This suite certifies the *agreement* past the warmup: where TA-Lib reports a pattern, TotalFinance
 * reports the same pattern and (for directional patterns) the same direction at a high rate.
 */

const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8'),
  ) as T;
const candles = load<{ patterns: Record<string, number[]> }>('talib-candles-golden.json').patterns;
const D = load<{
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}>('reference-ohlcv.json');
const bars = D.close.map((c, i) => ({
  open: D.open[i]!,
  high: D.high[i]!,
  low: D.low[i]!,
  close: c,
  volume: D.volume[i]!,
}));

/** Past TA-Lib's body-average + pattern-length warmup. */
const WARMUP = 13;
/** TA-Lib encodes a few single doji variants as +100 "presence"; TotalFinance assigns them a directional
 *  bias. Compare these on presence (|signal|) only. */
const PRESENCE_ONLY = new Set(['gravestoneDoji', 'dragonflyDoji', 'rickshawMan', 'longLeggedDoji']);

type Stat = { tal: number; present: number; dirAgree: number };
function compare(talName: string, qkName: string): Stat {
  const exp = candles[talName]!;
  const act = cdlPattern(bars, qkName);
  const s: Stat = { tal: 0, present: 0, dirAgree: 0 };
  for (let i = WARMUP; i < exp.length; i++) {
    const x = exp[i]!;
    const a = act[i] ?? 0;
    if (x === 0) continue;
    s.tal++;
    if (a !== 0) s.present++;
    if (a !== 0 && Math.sign(a) === Math.sign(x)) s.dirAgree++;
  }
  return s;
}

const cdlEntries = Object.entries(CDL_ALIASES).filter(([tal]) => candles[tal] != null);

describe('TA-Lib candlestick parity', () => {
  it('covers all 61 TA-Lib CDL functions', () => {
    expect(cdlEntries.length).toBe(61);
  });

  it('aggregate: ≥85% presence and ≥88% direction agreement on TA-Lib signals (past warmup)', () => {
    let tal = 0;
    let present = 0;
    let dir = 0;
    let dirDenom = 0;
    for (const [talName, qkName] of cdlEntries) {
      const s = compare(talName, qkName);
      tal += s.tal;
      present += s.present;
      if (!PRESENCE_ONLY.has(qkName)) {
        dir += s.dirAgree;
        dirDenom += s.tal;
      }
    }
    expect(tal, 'TA-Lib must emit a meaningful number of signals on the fixture').toBeGreaterThan(
      300,
    );
    expect(present / tal, `presence agreement ${(100 * present) / tal}%`).toBeGreaterThanOrEqual(
      0.85,
    );
    expect(dir / dirDenom, `direction agreement ${(100 * dir) / dirDenom}%`).toBeGreaterThanOrEqual(
      0.88,
    );
  });

  it('per-pattern: well-populated patterns (≥8 TA-Lib signals) agree ≥60% directionally', () => {
    const weak: string[] = [];
    for (const [talName, qkName] of cdlEntries) {
      if (PRESENCE_ONLY.has(qkName)) continue;
      const s = compare(talName, qkName);
      if (s.tal >= 8 && s.dirAgree / s.tal < 0.6) weak.push(`${talName} ${s.dirAgree}/${s.tal}`);
    }
    expect(weak, `patterns below 60% agreement: ${weak.join(', ')}`).toEqual([]);
  });

  it('the common doji/line/engulfing patterns match TA-Lib exactly past warmup', () => {
    // these are unambiguous and should reach 100% directional agreement
    for (const [talName, qkName] of [
      ['CDLDOJI', 'doji'],
      ['CDLLONGLEGGEDDOJI', 'longLeggedDoji'],
      ['CDLSPINNINGTOP', 'spinningTop'],
      ['CDLENGULFING', 'engulfing'],
      ['CDLHIGHWAVE', 'highWave'],
      ['CDLLONGLINE', 'longLine'],
      ['CDLSHORTLINE', 'shortLine'],
      ['CDLBELTHOLD', 'beltHold'],
    ] as const) {
      const s = compare(talName, qkName);
      const metric = PRESENCE_ONLY.has(qkName) ? s.present : s.dirAgree;
      expect(metric, `${talName}: ${metric}/${s.tal}`).toBe(s.tal);
    }
  });

  it('every pattern runs and returns an aligned ±100/0 integer series', () => {
    for (const [, qkName] of cdlEntries) {
      const out = cdlPattern(bars, qkName);
      expect(out).toHaveLength(bars.length);
      // warmup bars are NaN-filled (the framework sentinel); signals are the TA-Lib ±100/0 encoding
      for (const v of out)
        expect(
          Number.isNaN(v) || v === 0 || v === 100 || v === -100 || v === 200 || v === -200,
        ).toBe(true);
    }
  });
});
