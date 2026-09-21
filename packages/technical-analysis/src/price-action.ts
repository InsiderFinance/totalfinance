/**
 * Price-action utilities (spec §13.3).
 *
 * Pivot points (classic / Fibonacci / Woodie / Camarilla / DeMark), swing highs & lows, Bill Williams
 * fractals, support/resistance clustering, trendlines & channels, breakout & gap detection, market
 * structure (HH/HL/LH/LL with BOS / CHoCH), session ranges and the opening-range breakout.
 *
 * These are batch utilities over a bar array — most need to look both backward and forward across the
 * whole series (a swing is only confirmed once later bars exist), so they are functions, not the
 * causal streaming indicators in the rest of the package.
 */

import {
  CONVENTIONS_VERSION,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
  warning,
  WarningCode,
} from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';
import type { BarInput } from './framework.js';
import {
  requireFinite,
  requireNonNegative,
  requireOneOf,
  requirePeriod,
  requirePositive,
} from './validate.js';

function openOf(bar: BarInput): number {
  return bar.open ?? bar.close;
}

/** The exact `BarInput` fields — single-bar object arguments reject unknown keys (Law 12). */
const BAR_KEYS = ['open', 'high', 'low', 'close', 'volume'] as const;

// ───────────────────────── pivot points ─────────────────────────

export type PivotMethod = 'classic' | 'fibonacci' | 'woodie' | 'camarilla' | 'demark';
const PIVOT_METHODS: readonly PivotMethod[] = [
  'classic',
  'fibonacci',
  'woodie',
  'camarilla',
  'demark',
];

/** Pivot-level report (Law 2): the levels plus the applied conventions and diagnostics. */
export interface PivotLevels {
  pivot: number;
  resistance: number[];
  support: number[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; method: PivotMethod };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** Pivot levels for the next period from a prior period's OHLC. */
export function pivots(bar: BarInput, method: PivotMethod = 'classic'): PivotLevels {
  requireArgumentObject('pivots', 'bar', bar);
  // Law 12: an unknown field (a `hihg` typo) teaches instead of being silently ignored.
  ensureKnownKeys('pivots', 'bar', bar, BAR_KEYS);
  requireOneOf(method, PIVOT_METHODS, 'pivots', 'method');
  // Every consumed field runs its ladder: `close: null` used to coerce to 0 and report a WRONG
  // pivot (the silent-miscompute class), and an omitted field reported nulls instead of teaching.
  requireFiniteFields('pivots', bar, ['high', 'low', 'close'], {
    exampleCall: "pivots({ high: 11, low: 9, close: 10.5 }, 'classic')",
  });
  // The bar is CLOSED here (ensureKnownKeys above), so its declared optional members are part of
  // the request shape and a present-and-garbage one teaches — even `volume`, which no pivot
  // formula reads: a string volume in a bar is a data bug the caller wants surfaced.
  ensureFiniteWhenPresent((bar as { open?: unknown }).open, 'open', 'pivots');
  ensureFiniteWhenPresent((bar as { volume?: unknown }).volume, 'volume', 'pivots');
  const h = bar.high;
  const l = bar.low;
  const c = bar.close;
  const o = openOf(bar);
  const range = h - l;
  const report = (pivot: number, resistance: number[], support: number[]): PivotLevels => ({
    pivot,
    resistance,
    support,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method },
    diagnostics: { warnings: [] },
  });
  switch (method) {
    case 'classic': {
      const p = (h + l + c) / 3;
      return report(
        p,
        [2 * p - l, p + range, h + 2 * (p - l)],
        [2 * p - h, p - range, l - 2 * (h - p)],
      );
    }
    case 'fibonacci': {
      const p = (h + l + c) / 3;
      return report(
        p,
        [p + 0.382 * range, p + 0.618 * range, p + range],
        [p - 0.382 * range, p - 0.618 * range, p - range],
      );
    }
    case 'woodie': {
      const p = (h + l + 2 * c) / 4;
      return report(p, [2 * p - l, p + range], [2 * p - h, p - range]);
    }
    case 'camarilla': {
      const p = (h + l + c) / 3;
      const f = 1.1;
      return report(
        p,
        [c + (range * f) / 12, c + (range * f) / 6, c + (range * f) / 4, c + (range * f) / 2],
        [c - (range * f) / 12, c - (range * f) / 6, c - (range * f) / 4, c - (range * f) / 2],
      );
    }
    case 'demark': {
      let x: number;
      if (c < o) x = h + 2 * l + c;
      else if (c > o) x = 2 * h + l + c;
      else x = h + l + 2 * c;
      return report(x / 4, [x / 2 - l], [x / 2 - h]);
    }
  }
}

// ───────────────────────── swings & fractals ─────────────────────────

export interface SwingPoint {
  index: number;
  price: number;
}
/** Swing report (Law 2): the confirmed swing points plus applied conventions and diagnostics. */
export interface Swings {
  highs: SwingPoint[];
  lows: SwingPoint[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; strength: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const SWING_OPTS_KEYS = ['strength'] as const;

/**
 * Swing highs/lows: a swing high is a bar whose high strictly exceeds the highs of the `strength`
 * bars on each side (and symmetrically for lows). The first and last `strength` bars can never be
 * swings. `strength` defaults to 2 (the Bill Williams fractal window).
 */
export function swings(bars: ArrayLike<BarInput>, options: { strength?: number } = {}): Swings {
  requireArgumentArray('swings', 'bars', bars);
  requireArgumentObject('swings', 'options', options);
  // Law 12: an unknown option (a `strenght` typo) teaches instead of being silently ignored.
  ensureKnownKeys('swings', 'options', options, SWING_OPTS_KEYS);
  ensureFiniteWhenPresent(options.strength, 'strength', 'swings');
  const strength = requirePeriod(options.strength ?? 2, 'swings', 'strength');
  const warnings: QuantWarning[] = [];
  if (bars.length < 2 * strength + 1) {
    // Law 7 disclosure: too short to ever confirm a swing — empty lists, said out loud.
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        `swings: ${bars.length} bars cannot confirm any strength-${strength} swing (needs ≥ ${
          2 * strength + 1
        }) — highs/lows are empty.`,
        'info',
        { bars: bars.length, strength },
      ),
    );
  }
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const hi = bars[i]!.high;
    const lo = bars[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (hi <= bars[i - k]!.high || hi <= bars[i + k]!.high) isHigh = false;
      if (lo >= bars[i - k]!.low || lo >= bars[i + k]!.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: hi });
    if (isLow) lows.push({ index: i, price: lo });
  }
  return {
    highs,
    lows,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, strength },
    diagnostics: { warnings },
  };
}

/** Fractal report (Law 2): Bill Williams up/down fractals plus conventions and diagnostics. */
export interface Fractals {
  up: SwingPoint[];
  down: SwingPoint[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; strength: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** Bill Williams fractals: a 5-bar swing (strength 2). */
export function fractals(bars: ArrayLike<BarInput>): Fractals {
  requireArgumentArray('fractals', 'bars', bars);
  const s = swings(bars, { strength: 2 });
  return { up: s.highs, down: s.lows, assumptions: s.assumptions, diagnostics: s.diagnostics };
}

// ───────────────────────── support / resistance ─────────────────────────

export interface SrLevel {
  price: number;
  touches: number;
}
/** Support/resistance report (Law 2): clustered levels plus conventions and diagnostics. */
export interface SupportResistance {
  support: SrLevel[];
  resistance: SrLevel[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; strength: number; tolerance: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const SUPPORT_RESISTANCE_OPTS_KEYS = ['strength', 'tolerance'] as const;

/** Cluster swing highs into resistance levels and swing lows into support levels. */
export function supportResistance(
  bars: ArrayLike<BarInput>,
  options: { strength?: number; tolerance?: number } = {},
): SupportResistance {
  requireArgumentArray('supportResistance', 'bars', bars);
  requireArgumentObject('supportResistance', 'options', options);
  // Law 12: an unknown option (a `tolerence` typo) teaches instead of being silently ignored.
  ensureKnownKeys('supportResistance', 'options', options, SUPPORT_RESISTANCE_OPTS_KEYS);
  ensureFiniteWhenPresent(options.strength, 'strength', 'supportResistance');
  const strength = requirePeriod(options.strength ?? 2, 'supportResistance', 'strength');
  ensureFiniteWhenPresent(options.tolerance, 'tolerance', 'supportResistance');
  const tolerance = requirePositive(options.tolerance ?? 0.005, 'supportResistance', 'tolerance'); // clustering band
  const s = swings(bars, { strength });
  const cluster = (pts: SwingPoint[]): SrLevel[] => {
    const sorted = pts.map((p) => p.price).sort((a, b) => a - b);
    const levels: SrLevel[] = [];
    for (const price of sorted) {
      const last = levels[levels.length - 1];
      if (last && Math.abs(price - last.price) <= tolerance * last.price) {
        // merge into the running cluster (volume-free average)
        last.price = (last.price * last.touches + price) / (last.touches + 1);
        last.touches += 1;
      } else {
        levels.push({ price, touches: 1 });
      }
    }
    return levels.sort((a, b) => b.touches - a.touches);
  };
  return {
    support: cluster(s.lows),
    resistance: cluster(s.highs),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, strength, tolerance },
    diagnostics: { warnings: s.diagnostics.warnings },
  };
}

// ───────────────────────── trendlines & channels ─────────────────────────

export interface Line {
  slope: number;
  intercept: number;
  from: number;
  to: number;
}

/** Evaluate a fitted line (price = intercept + slope·index) at a bar index. */
export function lineAt(line: Line, index: number): number {
  requireArgumentObject('lineAt', 'line', line);
  // Lines are fitted-result artifacts and may carry labels/provenance. Validate the fields used by
  // this calculation and preserve unrelated decoration.
  const intercept = requireFinite(line.intercept, 'lineAt', 'line.intercept');
  const slope = requireFinite(line.slope, 'lineAt', 'line.slope');
  const at = requireFinite(index, 'lineAt', 'index');
  return requireFinite(intercept + slope * at, 'lineAt', 'result');
}

function lineThrough(a: SwingPoint, b: SwingPoint): Line {
  const slope = (b.price - a.price) / (b.index - a.index);
  return { slope, intercept: a.price - slope * a.index, from: a.index, to: b.index };
}

/** Trendline/channel report (Law 2): the two rails plus conventions and diagnostics. */
export interface TrendlineChannel {
  /** Line through the two most recent swing lows, or null when fewer than two exist. */
  support: Line | null;
  /** Line through the two most recent swing highs, or null when fewer than two exist. */
  resistance: Line | null;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; strength: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const TRENDLINE_OPTS_KEYS = ['strength'] as const;

/** Shared rails computation — a null rail is disclosed with a warning (null-with-reason, Law 7). */
function railsReport(
  functionName: string,
  bars: ArrayLike<BarInput>,
  strength: number,
): TrendlineChannel {
  const s = swings(bars, { strength });
  const support =
    s.lows.length >= 2 ? lineThrough(s.lows[s.lows.length - 2]!, s.lows[s.lows.length - 1]!) : null;
  const resistance =
    s.highs.length >= 2
      ? lineThrough(s.highs[s.highs.length - 2]!, s.highs[s.highs.length - 1]!)
      : null;
  const warnings: QuantWarning[] = [];
  if (support === null) {
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        `${functionName}: fewer than two swing lows — the support rail is null.`,
        'info',
        { swingLows: s.lows.length, strength },
      ),
    );
  }
  if (resistance === null) {
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        `${functionName}: fewer than two swing highs — the resistance rail is null.`,
        'info',
        { swingHighs: s.highs.length, strength },
      ),
    );
  }
  return {
    support,
    resistance,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, strength },
    diagnostics: { warnings },
  };
}

/** Connect the two most recent swing lows (support) and swing highs (resistance) into trendlines. */
export function trendlines(
  bars: ArrayLike<BarInput>,
  options: { strength?: number } = {},
): TrendlineChannel {
  requireArgumentArray('trendlines', 'bars', bars);
  requireArgumentObject('trendlines', 'options', options);
  ensureKnownKeys('trendlines', 'options', options, TRENDLINE_OPTS_KEYS);
  ensureFiniteWhenPresent(options.strength, 'strength', 'trendlines');
  return railsReport(
    'trendlines',
    bars,
    requirePeriod(options.strength ?? 2, 'trendlines', 'strength'),
  );
}

/** The trendline pair as a channel; `support`/`resistance` are the channel rails. */
export function channel(
  bars: ArrayLike<BarInput>,
  options: { strength?: number } = {},
): TrendlineChannel {
  requireArgumentArray('channel', 'bars', bars);
  requireArgumentObject('channel', 'options', options);
  ensureKnownKeys('channel', 'options', options, TRENDLINE_OPTS_KEYS);
  ensureFiniteWhenPresent(options.strength, 'strength', 'channel');
  return railsReport('channel', bars, requirePeriod(options.strength ?? 2, 'channel', 'strength'));
}

// ───────────────────────── breakout & gap detection ─────────────────────────

/** Breakout report (Law 2): the aligned signal series plus conventions and diagnostics. */
export interface BreakoutsReport {
  /**
   * Aligned to the input: `+1` when the close exceeds the highest high of the prior `lookback`
   * bars, `−1` below the lowest low, `0` otherwise — `null` during the lookback warmup.
   */
  signal: Array<number | null>;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; lookback: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const BREAKOUT_OPTS_KEYS = ['lookback'] as const;

/**
 * Breakout signal aligned to the input: at each bar, `+1` if the close exceeds the highest high of
 * the prior `lookback` bars, `−1` if it breaks below the lowest low, else `0` (null during warmup).
 */
export function breakouts(
  bars: ArrayLike<BarInput>,
  options: { lookback?: number } = {},
): BreakoutsReport {
  requireArgumentArray('breakouts', 'bars', bars);
  requireArgumentObject('breakouts', 'options', options);
  ensureKnownKeys('breakouts', 'options', options, BREAKOUT_OPTS_KEYS);
  ensureFiniteWhenPresent(options.lookback, 'lookback', 'breakouts');
  const lookback = requirePeriod(options.lookback ?? 20, 'breakouts', 'lookback');
  const signal = new Array<number | null>(bars.length).fill(null);
  for (let i = lookback; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = i - lookback; k < i; k++) {
      hh = Math.max(hh, bars[k]!.high);
      ll = Math.min(ll, bars[k]!.low);
    }
    const c = bars[i]!.close;
    signal[i] = c > hh ? 1 : c < ll ? -1 : 0;
  }
  const warnings: QuantWarning[] = [];
  if (bars.length <= lookback) {
    // Law 7 disclosure: the whole series is warmup — every slot is null, said out loud.
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        `breakouts: only ${bars.length} bars for a ${lookback}-bar lookback — the entire signal is warmup (null).`,
        'info',
        { bars: bars.length, lookback },
      ),
    );
  }
  return {
    signal,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, lookback },
    diagnostics: { warnings },
  };
}

export interface Gap {
  index: number;
  direction: 1 | -1;
  /** Gap size as a FRACTION of the prior close (`0.005` = a 0.5% gap). */
  sizeFraction: number;
}

/** Gap report (Law 2): the detected gaps plus conventions and diagnostics. */
export interface GapsReport {
  gaps: Gap[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; minSizeFraction: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const GAP_OPTS_KEYS = ['minSizeFraction'] as const;

/**
 * Opening gaps: this bar's open leaves the prior bar's RANGE (above its high or below its low).
 * `sizeFraction` is measured from the prior CLOSE — the level a fill has to trade back to — and
 * `minSizeFraction` filters in that same unit (`0.005` = 0.5%). {@link gapFill} detects exactly these
 * events and adds fill tracking.
 */
export function gaps(
  bars: ArrayLike<BarInput>,
  options: { minSizeFraction?: number } = {},
): GapsReport {
  requireArgumentArray('gaps', 'bars', bars);
  requireArgumentObject('gaps', 'options', options);
  ensureKnownKeys('gaps', 'options', options, GAP_OPTS_KEYS);
  ensureFiniteWhenPresent(options.minSizeFraction, 'minSizeFraction', 'gaps');
  const minSizeFraction = requireNonNegative(
    options.minSizeFraction ?? 0,
    'gaps',
    'minSizeFraction',
  );
  const out: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const o = openOf(bars[i]!);
    if (o > prev.high) {
      const sizeFraction = (o - prev.close) / prev.close;
      if (sizeFraction >= minSizeFraction) out.push({ index: i, direction: 1, sizeFraction });
    } else if (o < prev.low) {
      const sizeFraction = (prev.close - o) / prev.close;
      if (sizeFraction >= minSizeFraction) out.push({ index: i, direction: -1, sizeFraction });
    }
  }
  return {
    gaps: out,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, minSizeFraction },
    diagnostics: { warnings: [] },
  };
}

// ───────────────────────── market structure ─────────────────────────

export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL';
export interface LabeledSwing {
  index: number;
  kind: 'high' | 'low';
  price: number;
  /**
   * HH/HL/LH/LL relative to the PREVIOUS swing of the same kind — `null` for the first swing high
   * and the first swing low of the series, which have nothing to be higher or lower than. (These
   * used to be labeled `LH`/`HL`, i.e. reported as a lower high / higher low against a comparison
   * that never happened, which reads as bearish/bullish structure the data does not contain.)
   */
  label: SwingLabel | null;
}
export type StructureEventType = 'BOS' | 'CHoCH';
export interface StructureEvent {
  index: number;
  type: StructureEventType;
  direction: 1 | -1;
}
/** Market-structure report (Law 2): labeled swings and events plus conventions and diagnostics. */
export interface MarketStructure {
  swings: LabeledSwing[];
  events: StructureEvent[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; strength: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}
const MARKET_STRUCTURE_OPTS_KEYS = ['strength'] as const;

/**
 * Label the swing sequence (HH/HL/LH/LL) and flag breaks of structure. A higher-high while already
 * bullish is a continuation (BOS); a higher-high that reverses a bearish run is a change of character
 * (CHoCH), and symmetrically for lower-lows.
 *
 * The first swing high and the first swing low carry `label: null` — a label is a comparison with the
 * previous swing of that kind, and there is none yet.
 */
export function marketStructure(
  bars: ArrayLike<BarInput>,
  options: { strength?: number } = {},
): MarketStructure {
  requireArgumentArray('marketStructure', 'bars', bars);
  requireArgumentObject('marketStructure', 'options', options);
  ensureKnownKeys('marketStructure', 'options', options, MARKET_STRUCTURE_OPTS_KEYS);
  ensureFiniteWhenPresent(options.strength, 'strength', 'marketStructure');
  const strength = requirePeriod(options.strength ?? 2, 'marketStructure', 'strength');
  const s = swings(bars, { strength });
  const merged: { index: number; kind: 'high' | 'low'; price: number }[] = [
    ...s.highs.map((p) => ({ ...p, kind: 'high' as const })),
    ...s.lows.map((p) => ({ ...p, kind: 'low' as const })),
  ].sort((a, b) => a.index - b.index);

  const labeled: LabeledSwing[] = [];
  const events: StructureEvent[] = [];
  let prevHigh: number | null = null;
  let prevLow: number | null = null;
  let trend = 0; // +1 bullish, −1 bearish

  for (const sw of merged) {
    if (sw.kind === 'high') {
      const label: SwingLabel | null = prevHigh === null ? null : sw.price > prevHigh ? 'HH' : 'LH';
      labeled.push({ ...sw, label });
      if (label === 'HH' && prevHigh !== null) {
        events.push({ index: sw.index, type: trend === -1 ? 'CHoCH' : 'BOS', direction: 1 });
        trend = 1;
      }
      prevHigh = sw.price;
    } else {
      const label: SwingLabel | null = prevLow === null ? null : sw.price < prevLow ? 'LL' : 'HL';
      labeled.push({ ...sw, label });
      if (label === 'LL' && prevLow !== null) {
        events.push({ index: sw.index, type: trend === 1 ? 'CHoCH' : 'BOS', direction: -1 });
        trend = -1;
      }
      prevLow = sw.price;
    }
  }
  return {
    swings: labeled,
    events,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, strength },
    diagnostics: { warnings: s.diagnostics.warnings },
  };
}

// ───────────────────────── session range & opening-range breakout ─────────────────────────

export interface SessionRange {
  session: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  range: number;
}

/**
 * Aggregate bars into per-session OHLCV + range. `sessionIds[i]` is the session a bar belongs to
 * (bars carry no timestamp, so the caller supplies the grouping). Sessions appear in first-seen order.
 */
export function sessionRanges(
  bars: ArrayLike<BarInput>,
  sessionIds: ArrayLike<number>,
): SessionRange[] {
  requireArgumentArray('sessionRanges', 'sessionIds', sessionIds);
  requireArgumentArray('sessionRanges', 'bars', bars);
  if (sessionIds.length !== bars.length) {
    throw new InputError(
      `sessionRanges: sessionIds length (${sessionIds.length}) must match bars length (${bars.length}).`,
      {
        code: ErrorCode.InputLengthMismatch,
        context: { bars: bars.length, sessionIds: sessionIds.length },
      },
    );
  }
  const map = new Map<number, SessionRange>();
  const order: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const id = sessionIds[i]!;
    const b = bars[i]!;
    const v = b.volume ?? 0;
    let s = map.get(id);
    if (!s) {
      s = {
        session: id,
        open: openOf(b),
        high: b.high,
        low: b.low,
        close: b.close,
        volume: v,
        range: 0,
      };
      map.set(id, s);
      order.push(id);
    } else {
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close;
      s.volume += v;
    }
  }
  return order.map((id) => {
    const s = map.get(id)!;
    s.range = s.high - s.low;
    return s;
  });
}

export interface OpeningRange {
  high: number;
  low: number;
  mid: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; periods: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** The opening-range knobs: `periods` is the number of leading bars that define the range. */
export interface OpeningRangeParameters {
  periods: number;
}
const OPENING_RANGE_KEYS = ['periods'] as const;

/** High/low of the first `periods` bars — the opening range. */
export function openingRange(
  bars: ArrayLike<BarInput>,
  options: OpeningRangeParameters,
): OpeningRange {
  requireArgumentArray('openingRange', 'bars', bars);
  requireArgumentObject('openingRange', 'options', options);
  ensureKnownKeys('openingRange', 'options', options, OPENING_RANGE_KEYS);
  const periods = requirePeriod(options.periods, 'openingRange', 'periods', 1, 'bars');
  // Law 7: an empty series has no range — a typed error, never a ±Infinity record.
  if (bars.length === 0) {
    throw new InputError('openingRange: bars is empty — there is no range to measure.', {
      code: ErrorCode.InputOutOfRange,
      context: { length: 0 },
    });
  }
  const n = Math.min(periods, bars.length);
  const warnings: QuantWarning[] = [];
  if (n < periods) {
    warnings.push({
      code: WarningCode.TechnicalAnalysisOpeningRangeTruncated,
      message: `openingRange: only ${n} bars available for a ${periods}-bar opening range — the range covers the whole series.`,
      severity: 'warn',
      context: { periods, bars: n },
    });
  }
  let high = -Infinity;
  let low = Infinity;
  for (let i = 0; i < n; i++) {
    high = Math.max(high, bars[i]!.high);
    low = Math.min(low, bars[i]!.low);
  }
  return {
    high,
    low,
    mid: (high + low) / 2,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, periods },
    diagnostics: { warnings },
  };
}

/**
 * Opening-range breakout signal aligned to the input: `0` within the opening range, then `+1` on the
 * first close above the range high, `−1` below the range low (NaN for the opening-range bars).
 */
export function openingRangeBreakout(
  bars: ArrayLike<BarInput>,
  options: OpeningRangeParameters,
): number[] {
  requireArgumentArray('openingRangeBreakout', 'bars', bars);
  requireArgumentObject('openingRangeBreakout', 'options', options);
  ensureKnownKeys('openingRangeBreakout', 'options', options, OPENING_RANGE_KEYS);
  const periods = requirePeriod(options.periods, 'openingRangeBreakout', 'periods', 1, 'bars');
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= periods) return out;
  const or = openingRange(bars, { periods });
  for (let i = periods; i < bars.length; i++) {
    const c = bars[i]!.close;
    out[i] = c > or.high ? 1 : c < or.low ? -1 : 0;
  }
  return out;
}

/**
 * Opening-range retest aligned to the input: after a close breaks the range, `+1` on the first bar
 * that pulls back to touch the range high (a retest of an up-breakout), `−1` for a retest of the
 * range low. A new breakout in a direction re-arms that side; NaN during the opening range.
 */
export function orbRetest(bars: ArrayLike<BarInput>, options: OpeningRangeParameters): number[] {
  requireArgumentArray('orbRetest', 'bars', bars);
  requireArgumentObject('orbRetest', 'options', options);
  ensureKnownKeys('orbRetest', 'options', options, OPENING_RANGE_KEYS);
  const periods = requirePeriod(options.periods, 'orbRetest', 'periods', 1, 'bars');
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= periods) return out;
  const or = openingRange(bars, { periods });
  let armedUp = false;
  let armedDown = false;
  for (let i = periods; i < bars.length; i++) {
    const b = bars[i]!;
    let v = 0;
    // a retest uses the arming established on a PRIOR bar (so the breakout bar itself can't retest)
    if (armedUp && b.low <= or.high) {
      v = 1;
      armedUp = false;
    } else if (armedDown && b.high >= or.low) {
      v = -1;
      armedDown = false;
    }
    if (b.close > or.high) {
      armedUp = true;
      armedDown = false;
    } else if (b.close < or.low) {
      armedDown = true;
      armedUp = false;
    }
    out[i] = v;
  }
  return out;
}

// ───────────────────────── fibonacci retracement & extension ─────────────────────────

export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_EXTENSION_LEVELS = [0, 0.618, 1, 1.618, 2, 2.618] as const;

export interface FibLevel {
  ratio: number;
  price: number;
}

/**
 * Fibonacci retracement levels for a move from `start` (origin / 100% line) to `end` (extreme / 0%
 * line): `price(r) = end + (start − end)·r`. Direction-agnostic — works for up- and down-moves.
 */
export function fibRetracement(
  start: number,
  end: number,
  levels: readonly number[] = FIB_RETRACEMENT_LEVELS,
): FibLevel[] {
  requireFinite(start, 'fibRetracement', 'start');
  requireFinite(end, 'fibRetracement', 'end');
  requireArgumentArray('fibRetracement', 'levels', levels);
  return levels.map((r) => {
    requireFinite(r, 'fibRetracement', 'level');
    return { ratio: r, price: end + (start - end) * r };
  });
}

/**
 * Trend-based Fibonacci extension: project the `start → end` move from `projectFrom`:
 * `price(r) = projectFrom + (end − start)·r`. Targets at r ≥ 1 lie beyond the original move.
 */
export interface FibExtensionInput {
  start: number;
  end: number;
  projectFrom: number;
  levels?: readonly number[];
}

export function fibExtension(input: FibExtensionInput): FibLevel[] {
  requireArgumentObject('fibExtension', 'input', input);
  ensureKnownKeys('fibExtension', 'input', input, ['start', 'end', 'projectFrom', 'levels']);
  const { start, end, projectFrom, levels = FIB_EXTENSION_LEVELS } = input;
  requireFinite(start, 'fibExtension', 'start');
  requireFinite(end, 'fibExtension', 'end');
  requireFinite(projectFrom, 'fibExtension', 'projectFrom');
  requireArgumentArray('fibExtension', 'levels', levels);
  return levels.map((r) => {
    requireFinite(r, 'fibExtension', 'level');
    return { ratio: r, price: projectFrom + (end - start) * r };
  });
}

// ───────────────────────── prior-session levels & gap fill ─────────────────────────

export interface PriorSessionLevel {
  high: number;
  low: number;
  close: number;
}

/**
 * For each bar, the high/low/close of the PRIOR session (the fully-completed session before the bar's
 * own). `sessionIds[i]` groups bars (bars carry no timestamp, so the caller supplies the grouping —
 * pass day ids for "previous day high/low", week ids for "previous week high/low"). Bars in the first
 * session get NaN levels.
 */
export function previousSessionLevels(
  bars: ArrayLike<BarInput>,
  sessionIds: ArrayLike<number>,
): (PriorSessionLevel | null)[] {
  requireArgumentArray('previousSessionLevels', 'sessionIds', sessionIds);
  requireArgumentArray('previousSessionLevels', 'bars', bars);
  if (sessionIds.length !== bars.length) {
    throw new InputError(
      `previousSessionLevels: sessionIds length (${sessionIds.length}) must match bars length (${bars.length}).`,
      {
        code: ErrorCode.InputLengthMismatch,
        context: { bars: bars.length, sessionIds: sessionIds.length },
      },
    );
  }
  const agg = new Map<number, PriorSessionLevel>();
  const order: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const id = sessionIds[i]!;
    const b = bars[i]!;
    const s = agg.get(id);
    if (!s) {
      agg.set(id, { high: b.high, low: b.low, close: b.close });
      order.push(id);
    } else {
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close;
    }
  }
  const pos = new Map(order.map((id, i) => [id, i]));
  return Array.from({ length: bars.length }, (_, i) => {
    const p = pos.get(sessionIds[i]!)!;
    // H19: a first session has no prior session — STRUCTURAL absence, not a warm-up position,
    // so it is `null`, never an object of three NaNs the C10 allowance does not cover.
    if (p === 0) return null;
    return { ...agg.get(order[p - 1]!)! };
  });
}

export interface GapFillEvent {
  index: number;
  direction: 1 | -1;
  /** Lower / upper bound of the gap zone. */
  gapFrom: number;
  gapTo: number;
  /** Gap size as a FRACTION of the prior close (`0.005` = a 0.5% gap). */
  sizeFraction: number;
  filled: boolean;
  /** Index of the bar that first traded back to the prior close, or −1 if never filled. */
  fillIndex: number;
}

/** Gap-fill report (Law 2): the tracked gap events plus conventions and diagnostics. */
export interface GapFillReport {
  events: GapFillEvent[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; minSizeFraction: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Opening gaps with fill tracking: the same events {@link gaps} detects, plus whether and when each
 * one closed. A gap fills when a later bar trades back to the prior close.
 *
 * A gap requires the open to leave the prior bar's RANGE — above its high or below its low — which
 * is the definition {@link gaps} uses and the only one that means anything on a real tape. This
 * function previously fired on any open that merely differed from the prior close: on a 500-bar
 * random walk with no true gaps, `gaps()` returned 0 events and this returned 499, one per bar. The
 * two are now the same event universe, so `sizeFraction` and `minSizeFraction` mean the same thing
 * in both and a caller can pair them.
 *
 * `minSizeFraction` filters small gaps as a FRACTION of the prior close (`0.005` = 0.5%), the same
 * unit `sizeFraction` reports. Default 0 — every detected gap.
 */
export function gapFill(
  bars: ArrayLike<BarInput>,
  options: { minSizeFraction?: number } = {},
): GapFillReport {
  requireArgumentArray('gapFill', 'bars', bars);
  requireArgumentObject('gapFill', 'options', options);
  ensureKnownKeys('gapFill', 'options', options, GAP_OPTS_KEYS);
  ensureFiniteWhenPresent(options.minSizeFraction, 'minSizeFraction', 'gapFill');
  const minSizeFraction = requireNonNegative(
    options.minSizeFraction ?? 0,
    'gapFill',
    'minSizeFraction',
  );
  const out: GapFillEvent[] = [];
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1]!;
    const previousClose = previous.close;
    const o = openOf(bars[i]!);
    // Leaving the prior RANGE is what makes it a gap; the size is then measured from the prior close,
    // which is the price a fill has to trade back to.
    const direction: 1 | -1 | 0 = o > previous.high ? 1 : o < previous.low ? -1 : 0;
    if (direction === 0) continue;
    const sizeFraction = Math.abs(o - previousClose) / Math.abs(previousClose);
    if (sizeFraction < minSizeFraction) continue;
    let fillIndex = -1;
    // A LATER bar fills the gap (the docstring's contract, and `orbRetest`'s discipline): starting
    // at the gap bar itself let a wide opening bar whose own low tags the prior close report
    // `fillIndex === index` — "filled by the bar that created it", which is not a fill at all.
    for (let j = i + 1; j < bars.length; j++) {
      const filled =
        direction === 1 ? bars[j]!.low <= previousClose : bars[j]!.high >= previousClose;
      if (filled) {
        fillIndex = j;
        break;
      }
    }
    out.push({
      index: i,
      direction,
      gapFrom: direction === 1 ? previousClose : o,
      gapTo: direction === 1 ? o : previousClose,
      sizeFraction,
      filled: fillIndex >= 0,
      fillIndex,
    });
  }
  return {
    events: out,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, minSizeFraction },
    diagnostics: { warnings: [] },
  };
}

export * from './price-action-ext.js';
