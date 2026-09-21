/**
 * Indicator output metadata (spec: `docs/specs/wave6-quant-moats.md` §4). A recursive, JSON-safe
 * value schema that tells an agent or UI the runtime SHAPE of an indicator's output — scalar, record,
 * or vector — without a guess-and-inspect loop, plus an optional visualization hint. This metadata is
 * CURATED and source-controlled: runtime inference may VERIFY it (see `test/output-meta.test.ts`) but
 * never redefines it. Every registered indicator resolves to metadata via {@link resolveOutputMetadata}.
 */

import { ErrorCode, InputError } from '@totalfinance/core';

/** A numeric output leaf, optionally with a semantic role, unit, and inclusive value bounds. */
export interface IndicatorNumberOutput {
  type: 'number';
  role?: string;
  unit?: string;
  bounds?: readonly [number, number];
}

/** The recursive output value schema — a scalar leaf, a named record, or a vector. */
export type IndicatorOutputValue =
  | IndicatorNumberOutput
  | { type: 'boolean'; role?: string }
  | { type: 'string'; role?: string; values?: readonly string[] }
  | { type: 'record'; fields: Readonly<Record<string, IndicatorOutputValue>> }
  | {
      type: 'array';
      items: IndicatorOutputValue;
      length?: { fixed: number } | { parameter: string };
    };

/** How an indicator plots (one path per drawn series), separate from the runtime `value` shape. */
export interface IndicatorVisualization {
  kind: 'line' | 'bands' | 'oscillator' | 'histogram' | 'candles' | 'events' | 'levels' | 'multi';
  plots?: ReadonlyArray<{ path: string; role?: string }>;
  referenceLevels?: readonly number[];
}

/** An indicator's output metadata: its runtime value schema plus an optional visualization hint. */
export interface IndicatorOutputMetadata {
  value: IndicatorOutputValue;
  visualization?: IndicatorVisualization;
}

/** The default for a plain scalar line indicator (SMA, EMA, ATR, …) — the majority of the catalog. */
export const SCALAR_LINE: IndicatorOutputMetadata = {
  value: { type: 'number' },
  visualization: { kind: 'line' },
};

const num = { type: 'number' } as const;
/** A `{ lower, middle, upper }`-style band record with a `bands` visualization. */
const bandsRecord = (
  extra: Record<string, IndicatorOutputValue> = {},
): IndicatorOutputMetadata => ({
  value: { type: 'record', fields: { lower: num, middle: num, upper: num, ...extra } },
  visualization: { kind: 'bands' },
});
/** A `{ macd, signal, histogram }`-style oscillator record (a line, a signal, and a histogram). */
const macdRecord = (main: string): IndicatorOutputMetadata => ({
  value: { type: 'record', fields: { histogram: num, [main]: num, signal: num } },
  visualization: {
    kind: 'multi',
    plots: [
      { path: main, role: 'line' },
      { path: 'signal', role: 'signal' },
      { path: 'histogram', role: 'histogram' },
    ],
  },
});

/**
 * Curated output metadata for every NON-scalar indicator (records / vectors) plus the scalar indicators
 * that carry semantic overlays (bounded oscillators, event/pattern signals). The structural `value`
 * shapes here were generated from live runtime probes and are re-verified against runtime in
 * `test/output-meta.test.ts`; the visualization / bounds are the curated, source-controlled semantics.
 * Any indicator NOT listed resolves to {@link SCALAR_LINE} (a plain numeric line) — also verified.
 */
export const OUTPUT_META: Readonly<Record<string, IndicatorOutputMetadata>> = {
  // ── scalar overlays: bounded oscillators and event/pattern signals ──
  rsi: {
    value: { type: 'number', role: 'oscillator', bounds: [0, 100] },
    visualization: { kind: 'oscillator', referenceLevels: [30, 70] },
  },
  mfi: {
    value: { type: 'number', role: 'oscillator', bounds: [0, 100] },
    visualization: { kind: 'oscillator', referenceLevels: [20, 80] },
  },
  williamsR: {
    value: { type: 'number', role: 'oscillator', bounds: [-100, 0] },
    visualization: { kind: 'oscillator', referenceLevels: [-80, -20] },
  },
  cdlDoji: { value: { type: 'number', role: 'pattern-signal' }, visualization: { kind: 'events' } },
  cdlInside: {
    value: { type: 'number', role: 'pattern-signal' },
    visualization: { kind: 'events' },
  },

  // ── records & vectors (structural shapes from runtime probes) ──
  aberration: {
    value: { type: 'record', fields: { atr: num, lowerBand: num, upperBand: num, zeroLine: num } },
  },
  accelerationBands: bandsRecord(),
  adx: {
    value: { type: 'record', fields: { adx: num, minusDI: num, plusDI: num } },
    visualization: { kind: 'multi' },
  },
  amat: { value: { type: 'record', fields: { long: num, short: num } } },
  archerObv: {
    value: { type: 'record', fields: { fast: num, long: num, obv: num, short: num, slow: num } },
  },
  aroon: {
    value: { type: 'record', fields: { down: num, up: num } },
    visualization: { kind: 'oscillator' },
  },
  atrBands: bandsRecord(),
  atrTrailingStop: { value: { type: 'record', fields: { stop: num, trend: num } } },
  bbands: {
    value: {
      type: 'record',
      fields: { bandwidth: num, lower: num, middle: num, percentB: num, upper: num },
    },
    visualization: {
      kind: 'bands',
      plots: [{ path: 'upper' }, { path: 'middle' }, { path: 'lower' }],
    },
  },
  brar: { value: { type: 'record', fields: { popularityIndex: num, willingnessIndex: num } } },
  cdlZ: {
    value: { type: 'record', fields: { close: num, high: num, low: num, open: num } },
    visualization: { kind: 'candles' },
  },
  centralPivotRange: {
    value: { type: 'record', fields: { bottomCentral: num, pivot: num, topCentral: num } },
    visualization: { kind: 'levels' },
  },
  chandeKrollStop: { value: { type: 'record', fields: { long: num, short: num } } },
  chandelierExit: { value: { type: 'record', fields: { long: num, short: num } } },
  crossSignals: { value: { type: 'record', fields: { entry: num, exit: num, trend: num } } },
  divergence: {
    value: {
      type: 'record',
      fields: {
        code: num,
        index: num,
        indicatorSwings: { type: 'array', items: num, length: { fixed: 2 } },
        priceSwings: { type: 'array', items: num, length: { fixed: 2 } },
      },
    },
  },
  dmi: {
    value: {
      type: 'record',
      fields: { dx: num, minusDI: num, minusDM: num, plusDI: num, plusDM: num },
    },
    visualization: { kind: 'multi' },
  },
  donchian: bandsRecord(),
  drawdown: { value: { type: 'record', fields: { drawdown: num, log: num, percent: num } } },
  elderRay: {
    value: { type: 'record', fields: { bear: num, bull: num } },
    visualization: { kind: 'histogram' },
  },
  elderThermometer: {
    value: { type: 'record', fields: { long: num, movingAverage: num, short: num, thermo: num } },
  },
  equalHighs: {
    value: { type: 'record', fields: { count: num, detected: num, level: num } },
    visualization: { kind: 'events' },
  },
  equalLows: {
    value: { type: 'record', fields: { count: num, detected: num, level: num } },
    visualization: { kind: 'events' },
  },
  fairValueGaps: {
    value: { type: 'record', fields: { bottom: num, direction: num, mid: num, top: num } },
    visualization: { kind: 'events' },
  },
  fisherTransform: {
    value: { type: 'record', fields: { fisher: num, trigger: num } },
    visualization: { kind: 'oscillator' },
  },
  gannHighLowActivator: { value: { type: 'record', fields: { trend: num, value: num } } },
  heikinAshi: {
    value: { type: 'record', fields: { close: num, high: num, low: num, open: num } },
    visualization: { kind: 'candles' },
  },
  holtWinterChannel: bandsRecord(),
  htPhasor: { value: { type: 'record', fields: { inPhase: num, quadrature: num } } },
  htSine: { value: { type: 'record', fields: { leadSine: num, sine: num } } },
  ichimoku: {
    value: {
      type: 'record',
      fields: {
        chikou: num,
        displacement: num,
        kijun: num,
        senkouA: num,
        senkouB: num,
        tenkan: num,
      },
    },
    visualization: { kind: 'multi' },
  },
  kdj: {
    value: { type: 'record', fields: { d: num, j: num, k: num } },
    visualization: { kind: 'oscillator' },
  },
  keltner: bandsRecord(),
  klinger: { value: { type: 'record', fields: { klinger: num, signal: num } } },
  kst: { value: { type: 'record', fields: { kst: num, signal: num } } },
  kvo: { value: { type: 'record', fields: { klinger: num, signal: num } } },
  linreg: {
    value: {
      type: 'record',
      fields: { angle: num, forecast: num, intercept: num, slope: num, value: num },
    },
  },
  liquiditySweeps: {
    value: { type: 'record', fields: { direction: num, level: num } },
    visualization: { kind: 'events' },
  },
  movingAverageRibbon: {
    value: { type: 'array', items: num, length: { parameter: 'periods' } },
    visualization: { kind: 'multi' },
  },
  macd: macdRecord('macd'),
  macdExt: macdRecord('macd'),
  macdFix: macdRecord('macd'),
  mama: { value: { type: 'record', fields: { fama: num, mama: num } } },
  msw: { value: { type: 'record', fields: { lead: num, sine: num } } },
  orderBlocks: {
    value: { type: 'record', fields: { bottom: num, direction: num, mid: num, top: num } },
    visualization: { kind: 'events' },
  },
  pMax: { value: { type: 'record', fields: { pmax: num, trend: num } } },
  ppo: macdRecord('ppo'),
  projectionOscillator: { value: { type: 'record', fields: { lower: num, po: num, upper: num } } },
  psar: {
    value: { type: 'record', fields: { sar: num, trend: num } },
    visualization: { kind: 'events' },
  },
  pvo: macdRecord('pvo'),
  qqe: {
    value: { type: 'record', fields: { longBand: num, rsiMovingAverage: num, shortBand: num } },
  },
  relativeVigorIndex: { value: { type: 'record', fields: { rvi: num, signal: num } } },
  rollingAnchoredVwap: { value: { type: 'record', fields: { anchorBarsAgo: num, vwap: num } } },
  rollingMinMax: { value: { type: 'record', fields: { max: num, min: num } } },
  rollingMinMaxIndex: { value: { type: 'record', fields: { maxIndex: num, minIndex: num } } },
  rollingRegression: {
    value: { type: 'record', fields: { intercept: num, rSquared: num, slope: num } },
  },
  smiErgodic: { value: { type: 'record', fields: { oscillator: num, signal: num, smi: num } } },
  squeeze: { value: { type: 'record', fields: { momentum: num, on: num } } },
  squeezePro: {
    value: {
      type: 'record',
      fields: { highCompression: num, lowCompression: num, momentum: num, normalCompression: num },
    },
  },
  stochFast: {
    value: { type: 'record', fields: { d: num, k: num } },
    visualization: { kind: 'oscillator' },
  },
  stochRsi: {
    value: { type: 'record', fields: { d: num, k: num } },
    visualization: { kind: 'oscillator' },
  },
  stochastic: {
    value: { type: 'record', fields: { d: num, k: num } },
    visualization: { kind: 'oscillator' },
  },
  supertrend: { value: { type: 'record', fields: { direction: num, supertrend: num } } },
  swingTrailingStop: { value: { type: 'record', fields: { stop: num, trend: num } } },
  tdSequential: {
    value: { type: 'record', fields: { countdown: num, direction: num, setup: num } },
    visualization: { kind: 'events' },
  },
  tosStdevAll: {
    value: {
      type: 'record',
      fields: {
        line: num,
        lower: { type: 'array', items: num, length: { fixed: 3 } },
        upper: { type: 'array', items: num, length: { fixed: 3 } },
      },
    },
  },
  trendSignals: { value: { type: 'record', fields: { entry: num, exit: num, trend: num } } },
  trixHistogram: {
    value: { type: 'record', fields: { histogram: num, signal: num, trix: num } },
    visualization: { kind: 'multi' },
  },
  tsi: { value: { type: 'record', fields: { signal: num, tsi: num } } },
  volatilityStop: { value: { type: 'record', fields: { stop: num, trend: num } } },
  volumeWeightedMacd: macdRecord('macd'),
  vortex: { value: { type: 'record', fields: { viMinus: num, viPlus: num } } },
  vwapBands: {
    value: { type: 'record', fields: { lower: num, upper: num, vwap: num } },
    visualization: { kind: 'bands' },
  },
};

/** Resolve any indicator's output metadata — its curated {@link OUTPUT_META} entry, or the scalar line. */
export function resolveOutputMetadata(name: string): IndicatorOutputMetadata {
  return OUTPUT_META[name] ?? SCALAR_LINE;
}

// ── Recursive shape inference (for GENERATING the curated table and VERIFYING it — never at runtime) ──

/** Infer the structural {@link IndicatorOutputValue} of a single post-warmup output sample. */
export function inferOutputValue(sample: unknown): IndicatorOutputValue {
  if (typeof sample === 'boolean') return { type: 'boolean' };
  if (typeof sample === 'string') return { type: 'string' };
  if (Array.isArray(sample)) {
    const items = sample.length > 0 ? inferOutputValue(sample[0]) : { type: 'number' as const };
    return sample.length > 0
      ? { type: 'array', items, length: { fixed: sample.length } }
      : { type: 'array', items };
  }
  if (sample !== null && typeof sample === 'object') {
    const fields: Record<string, IndicatorOutputValue> = {};
    for (const key of Object.keys(sample as Record<string, unknown>).sort()) {
      fields[key] = inferOutputValue((sample as Record<string, unknown>)[key]);
    }
    return { type: 'record', fields };
  }
  // number, null, or a warmup NaN — a numeric leaf (null is a not-yet-warm number field).
  return { type: 'number' };
}

/**
 * Whether two output VALUE schemas have the same runtime structure — type, record field names, and
 * array element shape (and fixed length when both declare one). Semantic overlays (role / unit / bounds
 * / value enumerations) are intentionally IGNORED so curated semantics never fail structural conformance.
 */
export function structuralValueEqual(a: IndicatorOutputValue, b: IndicatorOutputValue): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'record' && b.type === 'record') {
    const ka = Object.keys(a.fields).sort();
    const kb = Object.keys(b.fields).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => structuralValueEqual(a.fields[k]!, b.fields[k]!));
  }
  if (a.type === 'array' && b.type === 'array') {
    if (!structuralValueEqual(a.items, b.items)) return false;
    const la = a.length && 'fixed' in a.length ? a.length.fixed : undefined;
    const lb = b.length && 'fixed' in b.length ? b.length.fixed : undefined;
    // A `{ parameter }` length is a curated claim inference can't see — only compare two fixed lengths.
    if (la !== undefined && lb !== undefined && la !== lb) return false;
    return true;
  }
  return true; // number / boolean / string leaves are structurally equal by type
}

// ── Validation (register / defineIndicator require valid output metadata for CUSTOM indicators) ──

const OUTPUT_VALUE_TYPES = ['number', 'boolean', 'string', 'record', 'array'] as const;
const VIS_KINDS: readonly IndicatorVisualization['kind'][] = [
  'line',
  'bands',
  'oscillator',
  'histogram',
  'candles',
  'events',
  'levels',
  'multi',
];

/** Throw unless `value` is a well-formed {@link IndicatorOutputValue} (recursively). */
function validateOutputValue(value: unknown, functionName: string, path: string): void {
  if (value === null || typeof value !== 'object') {
    throw new InputError(`${functionName}: ${path} must be an output-value object.`, {
      code: ErrorCode.InputWrongType,
      context: { path, value },
    });
  }
  const t = (value as { type?: unknown }).type;
  if (!(OUTPUT_VALUE_TYPES as readonly unknown[]).includes(t)) {
    throw new InputError(
      `${functionName}: ${path}.type must be one of ${OUTPUT_VALUE_TYPES.join(' | ')}; got ${String(t)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { path, type: t } },
    );
  }
  // The descriptive members are DISCLOSED (describeIndicator, MCP schemas, charting) — junk
  // here would be served to consumers as truth, so each runs a when-present ladder. Null is a
  // wrong-typed value, not omission.
  const described = value as { role?: unknown; unit?: unknown; bounds?: unknown; values?: unknown };
  for (const member of ['role', 'unit'] as const) {
    const v = described[member];
    if (v !== undefined && typeof v !== 'string') {
      throw new InputError(
        `${functionName}: ${path}.${member} must be a string when provided. Received ${v === null ? 'null' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { path, [member]: v } },
      );
    }
  }
  if (described.bounds !== undefined) {
    const b = described.bounds;
    if (
      !Array.isArray(b) ||
      b.length !== 2 ||
      !b.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      throw new InputError(
        `${functionName}: ${path}.bounds must be [min, max] finite numbers when provided — e.g. bounds: [0, 100]. Received ${b === null ? 'null' : JSON.stringify(b)}.`,
        { code: ErrorCode.InputWrongType, context: { path, bounds: b } },
      );
    }
  }
  if (described.values !== undefined) {
    const vals = described.values;
    if (!Array.isArray(vals) || !vals.every((x) => typeof x === 'string')) {
      throw new InputError(
        `${functionName}: ${path}.values must be an array of strings when provided. Received ${vals === null ? 'null' : JSON.stringify(vals)}.`,
        { code: ErrorCode.InputWrongType, context: { path, values: vals } },
      );
    }
  }
  if (t === 'record') {
    const fields = (value as { fields?: unknown }).fields;
    if (fields === null || typeof fields !== 'object') {
      throw new InputError(`${functionName}: ${path}.fields must be a record of output values.`, {
        code: ErrorCode.InputWrongType,
        context: { path },
      });
    }
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      validateOutputValue(v, functionName, `${path}.fields.${k}`);
    }
  } else if (t === 'array') {
    validateOutputValue((value as { items?: unknown }).items, functionName, `${path}.items`);
  }
}

/** Throw unless `meta` is a well-formed {@link IndicatorOutputMetadata}. Used by `register`/`defineIndicator`. */
export function requireOutputMetadata(
  functionName: string,
  name: string,
  meta: unknown,
): asserts meta is IndicatorOutputMetadata {
  if (meta === null || typeof meta !== 'object') {
    throw new InputError(
      `${functionName}: "${name}" must declare output metadata { value } — see IndicatorOutputMetadata.`,
      { code: ErrorCode.InputMissingField, context: { name } },
    );
  }
  validateOutputValue((meta as { value?: unknown }).value, functionName, 'output.value');
  const vis = (meta as { visualization?: unknown }).visualization;
  if (vis !== undefined) {
    // A null visualization used to reach the `.kind` read and die as a raw TypeError.
    if (vis === null || typeof vis !== 'object') {
      throw new InputError(
        `${functionName}: "${name}" output.visualization must be an object when provided. Received ${vis === null ? 'null' : typeof vis}.`,
        { code: ErrorCode.InputWrongType, context: { name, visualization: vis } },
      );
    }
    const kind = (vis as { kind?: unknown }).kind;
    if (!(VIS_KINDS as readonly unknown[]).includes(kind)) {
      throw new InputError(
        `${functionName}: "${name}" output.visualization.kind must be one of ${VIS_KINDS.join(' | ')}; got ${String(kind)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { name, kind } },
      );
    }
  }
}
