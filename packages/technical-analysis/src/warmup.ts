/**
 * Per-indicator warmup / lookahead / displacement introspection (spec §13.5).
 *
 * `warmup` is the number of leading bars before an indicator emits its first real value — exactly
 * what `indicator.explain(input, parameters).diagnostics.warmup` reports (the one-envelope law).
 * `indicatorWarmups` measures it for every registered indicator at a canonical parameter set, on a
 * long synthetic probe series, so the numbers are authoritative (derived, not hand-written
 * formulas).
 *
 * **Lookahead is zero for every indicator.** Batch output is DERIVED from a left-to-right stream
 * (`collect`), so no output can depend on a future bar — causality is structural, not a per-indicator
 * property. **Displacement is zero too:** TotalFinance returns each value aligned to the bar it is
 * computed on. (Charting platforms plot some indicators displaced — Ichimoku's leading spans 26 bars
 * ahead, the classic DPO shifted back — but TotalFinance never plot-shifts; align downstream if needed.)
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import type { BarInput, Indicator } from './framework.js';
import { resolveIndicator } from './aliases.js';
import {
  listIndicators,
  type IndicatorCategory,
  type IndicatorInputs,
  type RegisteredIndicator,
} from './registry.js';
import { pairs, type Pair } from './statistics.js';

/** Canonical value for each parameter name in the registry (covers every declared param). */
const CANONICAL: Readonly<Record<string, unknown>> = {
  above: 0,
  accelInitLong: 0.02,
  accelInitShort: 0.02,
  accelLong: 0.02,
  accelMaxLong: 0.2,
  accelMaxShort: 0.2,
  accelShort: 0.02,
  anchor: 'high',
  annualization: 252,
  atrPeriod: 14,
  bars: 10,
  base: 26,
  bollingerBandPeriod: 20,
  bollingerStandardDeviations: 2,
  below: 0,
  cmoPeriod: 9,
  coefficient: 0.2,
  conversion: 9,
  cycle: 10,
  dPeriod: 3,
  ddof: 1,
  displacement: 26,
  drift: 1,
  factor: 4.236,
  fast: 12,
  fastLimit: 0.5,
  fastMovingAverageType: 'ema',
  gamma: 0.5,
  narrowKeltnerChannelMultiplier: 1,
  kPeriod: 14,
  keltnerChannelMultiplier: 1.5,
  keltnerChannelPeriod: 20,
  kinds: ['bullish', 'bearish', 'hiddenBullish', 'hiddenBearish'],
  levels: 10,
  long: 25,
  longRoc: 14,
  lookback: 20,
  lower: 0.05,
  wideKeltnerChannelMultiplier: 2,
  movingAverageType: 'ema',
  max: 0.2,
  medium: 14,
  normalKeltnerChannelMultiplier: 1.5,
  min: 0,
  minimumGapPercent: 0,
  multiplier: 2,
  levelSmoothing: 0.2,
  trendSmoothing: 0.1,
  accelerationSmoothing: 0.1,
  varianceSmoothing: 0.1,
  occurrence: 0,
  offset: 0.85,
  offsetOnReverse: 0,
  period: 14,
  periods: [5, 10, 20],
  phase: 0,
  power: 1,
  quantile: 0.5,
  rankPeriod: 100,
  resetEvery: 20,
  rocPeriod: 10,
  rocPeriods: [10, 15, 20, 30],
  rsiPeriod: 14,
  runLength: 2,
  rviPeriod: 14,
  sample: true,
  scalar: 1,
  scale: 10000,
  short: 13,
  shortRoc: 11,
  sigma: 6,
  signal: 9,
  signalMovingAverageType: 'ema',
  signed: false,
  slow: 26,
  slowLimit: 0.05,
  slowMovingAverageType: 'ema',
  smaPeriods: [10, 10, 10, 15],
  smooth: 5,
  smoothK: 1,
  spanB: 52,
  startValue: 0,
  standardDeviation: 2,
  stds: [1, 2, 3],
  stdevPeriod: 14,
  step: 0.02,
  stochPeriod: 14,
  streakPeriod: 2,
  strength: 2,
  strict: false,
  swing: { left: 5, right: 5 },
  talib: false,
  tolerance: 0.001,
  upper: 0.95,
  volumeCutoff: 2.5,
  volumeFactor: 0.7,
  wma: 10,
  wickMultiplier: 1.5,
};

/** Per-indicator overrides where a shared parameter name means different things. */
const OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  // `anchor` is a 0-based bar index here, not the 'high'/'low' mode used by rollingAnchoredVwap.
  anchoredVwap: { anchor: 0 },
  ebsw: { period: 40 },
};

export interface WarmupMetadata {
  name: string;
  category: IndicatorCategory;
  inputs: IndicatorInputs;
  /** The canonical parameters used to measure the warmup. */
  parameters: Record<string, unknown>;
  /** Leading bars before the first real value, or `null` if it never emitted within the probe. */
  warmup: number | null;
}

function buildParams(name: string, paramNames: readonly string[]): Record<string, unknown> {
  const ov = OVERRIDES[name];
  const parameters: Record<string, unknown> = {};
  for (const p of paramNames) {
    if (ov && p in ov) {
      parameters[p] = ov[p];
      continue;
    }
    // CANONICAL must cover EVERY declared parameter: a gap would silently probe with `undefined`
    // and print `undefined` into the generated reference (design law #4 — fail loudly instead).
    if (!(p in CANONICAL)) {
      throw new InputError(
        `indicatorWarmups: no canonical value for parameter "${p}" of "${name}" — add it to CANONICAL in warmup.ts.`,
        { code: ErrorCode.InputMissingField, context: { indicator: name, parameter: p } },
      );
    }
    parameters[p] = CANONICAL[p];
  }
  return parameters;
}

function probeInputs(length: number): { series: number[]; bars: BarInput[]; pair: Pair[] } {
  const series = Array.from(
    { length },
    (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1),
  );
  const bars: BarInput[] = series.map((c, i) => {
    const open = i === 0 ? c : series[i - 1]!;
    return {
      open,
      high: Math.max(open, c) + 1 + (i % 3) * 0.5,
      low: Math.min(open, c) - 1 - (i % 4) * 0.3,
      close: c,
      volume: 1000 + ((i * 53) % 400),
    };
  });
  const other = series.map((v, i) => v + Math.cos(i / 4) * 3);
  return { series, bars, pair: pairs(series, other) };
}

/**
 * The longest probe one warmup measurement will synthesize (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check let a probeLength reach the probe builders as
 * an unfinishable allocation — the probe materializes a series, a bar object PER element, and a pair
 * series, then runs the indicator's full `explain` over all of it (the bulk API does so for every
 * registered indicator, ~335 of them). Warmup is a property of an indicator's first few hundred bars;
 * the 512 default already measures every registered indicator, and 100,000 bars (~20 MB of probe,
 * seconds across the bulk sweep) leaves two decades of headroom.
 */
const MAX_PROBE_LENGTH = 100_000;

function requireProbeLength(functionName: string, probeLength: number): void {
  if (!Number.isSafeInteger(probeLength) || probeLength < 8 || probeLength > MAX_PROBE_LENGTH) {
    throw new InputError(
      `${functionName}: probeLength must be an integer in [8, ${MAX_PROBE_LENGTH.toLocaleString('en-US')}] — the probe materializes a synthetic series, bars, and pair of that length and runs each indicator's explain over it, while warmup itself is decided in the first few hundred bars. Received ${String(probeLength)}.\n  e.g. indicatorWarmup('rsi', 512)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { probeLength, max: MAX_PROBE_LENGTH },
      },
    );
  }
}

/** Measure one registered indicator's warmup against the probe inputs (shared by the bulk + single API). */
function measureWarmup(
  e: RegisteredIndicator,
  probes: { series: number[]; bars: BarInput[]; pair: Pair[] },
): WarmupMetadata {
  const parameters = buildParams(e.name, e.parameters);
  const input =
    e.inputs === 'series' ? probes.series : e.inputs === 'bars' ? probes.bars : probes.pair;
  const ind = e.indicator as Indicator<Record<string, unknown>, unknown, unknown>;
  const {
    diagnostics: { warmup },
  } = ind.explain(input, parameters);
  return {
    name: e.name,
    category: e.category,
    inputs: e.inputs,
    parameters,
    warmup: warmup >= input.length ? null : warmup,
  };
}

/**
 * The warmup of a SINGLE indicator (alias-aware name), measured on a probe series — the targeted
 * counterpart to {@link indicatorWarmups} for a `describe`-style lookup that shouldn't probe all 335.
 */
export function indicatorWarmup(name: string, probeLength = 512): WarmupMetadata {
  const functionName = 'indicatorWarmup';
  if (typeof name !== 'string' || name.length === 0) {
    throw new InputError(`${functionName}: name must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { name },
    });
  }
  requireProbeLength(functionName, probeLength);
  const entry = resolveIndicator(name);
  if (entry === undefined) {
    throw new InputError(`${functionName}: unknown indicator "${name}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { name },
    });
  }
  return measureWarmup(entry, probeInputs(probeLength));
}

/**
 * Measure the warmup of every registered indicator at canonical parameters. `probeLength` must
 * exceed the longest warmup (default 512 comfortably covers the catalog).
 */
export function indicatorWarmups(probeLength = 512): WarmupMetadata[] {
  requireProbeLength('indicatorWarmups', probeLength);
  const probes = probeInputs(probeLength);
  return listIndicators().map((e) => measureWarmup(e, probes));
}

const CATEGORY_ORDER: readonly IndicatorCategory[] = [
  'transform',
  'moving-average',
  'momentum',
  'trend',
  'volatility',
  'volume',
  'cycle',
  'math',
  'performance',
  'statistic',
  'candlestick',
  'price-action',
  'custom',
];

const compactParams = (p: Record<string, unknown>): string => {
  const keys = Object.keys(p);
  if (keys.length === 0) return '—';
  return '`' + keys.map((k) => `${k}=${JSON.stringify(p[k])}`).join(', ') + '`';
};

/** Render warmup/lookahead/displacement reference as Markdown, grouped by category. */
export function warmupMarkdown(): string {
  const infos = indicatorWarmups();
  const lines: string[] = ['# TotalFinance indicator warmup / lookahead / displacement', ''];
  lines.push(
    'Warmup is the number of leading bars before the first real value, measured at the canonical ' +
      `parameters shown (via \`indicator.explain(...).diagnostics.warmup\`). ${infos.length} indicators.`,
    '',
    '**Lookahead: none.** Batch output is derived from a left-to-right stream, so no value depends ' +
      'on a future bar — causality is structural across the whole catalog.',
    '',
    '**Displacement: none.** Each value is aligned to the bar it is computed on. Charting platforms ' +
      "plot some indicators shifted (Ichimoku's leading spans 26 bars ahead, the classic DPO shifted " +
      'back); TotalFinance never plot-shifts — apply any display offset downstream.',
    '',
  );
  const byCat = new Map<IndicatorCategory, WarmupMetadata[]>();
  for (const info of infos)
    (byCat.get(info.category) ?? byCat.set(info.category, []).get(info.category)!).push(info);
  for (const cat of CATEGORY_ORDER) {
    const rows = byCat.get(cat);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${cat} (${rows.length})`, '');
    lines.push(
      '| Indicator | Inputs | Warmup | Canonical parameters |',
      '| --- | --- | --- | --- |',
    );
    for (const r of rows) {
      lines.push(
        `| \`${r.name}\` | ${r.inputs} | ${r.warmup === null ? '—' : r.warmup} | ${compactParams(r.parameters)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
