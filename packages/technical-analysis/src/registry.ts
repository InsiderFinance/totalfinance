/**
 * Indicator registry (spec §13.5).
 *
 * `defineIndicator({ name, inputs, parameters, defaults, stream, restore, nan })` builds an aligned
 * batch+stream indicator (via `makeIndicator`) and registers it with introspectable metadata. Every
 * built-in indicator is auto-registered here, so the registry is the single source of truth for
 * "what indicators exist, what they consume, what they're parameterised by, and what each parameter
 * defaults to" — and it generates the indicator reference documentation.
 *
 * The disclosure law (dx R1) is enforced through registration: each entry's `defaults` are bound
 * onto the facade (`bindIndicatorMetadata`), so `.explain().assumptions.parameters` echoes every default
 * that engaged — verified for the whole catalog by `test/registry-defaults-truth.test.ts`.
 */

import { ensureKnownKeys, ErrorCode, InputError, requireArgumentObject } from '@totalfinance/core';
import {
  type IndicatorOutputMetadata,
  requireOutputMetadata,
  resolveOutputMetadata,
} from './output-meta.js';
import {
  type IndicatorConventions,
  type IndicatorStream,
  type Indicator,
  type TechnicalAnalysisSnapshot,
  bindIndicatorMetadata,
  makeIndicator,
} from './framework.js';
import * as transforms from './transforms.js';
import * as series from './series.js';
import * as ma from './moving-averages.js';
import * as osc from './oscillators.js';
import * as trend from './trend.js';
import * as vol from './volatility.js';
import * as volm from './volume.js';
import * as bars from './bars.js';
import * as cycle from './cycle.js';
import * as math from './math.js';
import * as perf from './performance-ext.js';
import * as stats from './statistics.js';
import * as momx from './momentum-ext.js';
import * as ovx from './overlap-ext.js';
import * as trx from './trend-ext.js';
import * as volx from './volatility-ext.js';
import * as volmx from './volume-ext.js';
import * as pax from './price-action-ext.js';
import * as fx from './features-ext.js';
import { divergence } from './divergence.js';
import { rsi } from './rsi.js';
import { macd } from './macd.js';
import { bbands } from './bands.js';
import { candlesticks } from './candlesticks.js';
import { cdlDoji, cdlInside, cdlZ } from './candle-aliases.js';

// The registry is heterogeneous by nature; one permissive alias keeps the call sites clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIndicator = Indicator<any, any, any>;

export type IndicatorInputs = 'series' | 'bars' | 'pair';
export type IndicatorCategory =
  | 'transform'
  | 'moving-average'
  | 'momentum'
  | 'trend'
  | 'volatility'
  | 'volume'
  | 'cycle'
  | 'math'
  | 'performance'
  | 'statistic'
  | 'candlestick'
  | 'price-action'
  | 'custom';

/**
 * Compiler-checked runtime domain for {@link IndicatorCategory} — `satisfies` makes a missing or
 * misspelled member a type error here, so the table cannot drift from the union it teaches.
 */
const INDICATOR_CATEGORIES = [
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
] as const satisfies readonly IndicatorCategory[];
type CategoryDomainIsTotal =
  Exclude<IndicatorCategory, (typeof INDICATOR_CATEGORIES)[number]> extends never ? true : never;
const CATEGORY_DOMAIN_IS_TOTAL: CategoryDomainIsTotal = true;
void CATEGORY_DOMAIN_IS_TOTAL;

export interface IndicatorMetadata {
  name: string;
  category: IndicatorCategory;
  inputs: IndicatorInputs;
  /** Parameter names (including defaulted ones the caller may omit). */
  parameters: string[];
  /**
   * Declared default per optional parameter (the disclosure law, dx R1): a parameter listed in
   * `parameters` but absent here is REQUIRED. A value may be a resolver `(resolved) => value` for the
   * rare default computed from another parameter. Bound onto the facade at registration so
   * `.explain().assumptions.parameters` echoes every default that engages.
   */
  defaults?: Record<string, unknown>;
  /**
   * The choices this indicator made that its parameters do not reveal — Wilder vs EMA smoothing, what
   * a flat window resolves to, how the first value is seeded. Present only where such a choice exists,
   * so its absence is information too. Echoed by `.explain().assumptions.conventions` and surfaced by
   * `describeIndicator`, which is what makes a divergence from TA-Lib or pandas-ta discoverable from
   * the result instead of only from prose.
   */
  conventions?: IndicatorConventions;
}
export interface RegisteredIndicator extends IndicatorMetadata {
  indicator: AnyIndicator;
  /** The indicator's output metadata (recursive value schema + optional visualization) — Wave 6 §4. */
  output: IndicatorOutputMetadata;
}

const REGISTRY = new Map<string, RegisteredIndicator>();

/**
 * A frozen structural copy — the registry's defence against its own accessors.
 *
 * `getIndicator` and `listIndicators` used to hand back the LIVE entry, and `register` bound the
 * caller's own `parameters` array into the facade's runtime allowlist. Those are the same array, so
 * a reader could disable validation for the whole process:
 *
 *     getIndicator('rsi')!.parameters.push('typo');
 *     rsi(values, { period: 14, typo: true });   // Law 12 silently off, everywhere
 *
 * `describeIndicator` leaked the same objects, so discovery and MCP could be made to disclose one
 * set of conventions while `.explain()` disclosed another. A read accessor must not be a write.
 *
 * Copying containers and freezing them fixes both halves at once: the caller's array is no longer the
 * facade's allowlist, and the entry a reader receives refuses mutation. FUNCTIONS pass through by
 * reference — the `indicator` facade must stay callable, and a `defaults` value may legitimately be
 * a resolver `(resolved) => value`.
 */
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((v) => frozenCopy(v))) as unknown as T;
  if (value !== null && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, frozenCopy(v)]),
      ),
    ) as T;
  return value;
}

const INPUT_KINDS: readonly IndicatorInputs[] = ['series', 'bars', 'pair'];

/** Throw unless `inputs` is a member of {@link INPUT_KINDS} (an unchecked `inputs` used to register
 * fine and then mis-route as `'pair'` in every registry-driven probe — silent degradation). */
function requireInputs(
  functionName: string,
  inputs: unknown,
  name: unknown,
): asserts inputs is IndicatorInputs {
  if (!INPUT_KINDS.includes(inputs as IndicatorInputs)) {
    throw new InputError(
      `${functionName}: inputs must be one of ${INPUT_KINDS.join(' | ')}. Received ${typeof inputs === 'string' ? `"${inputs}"` : String(inputs)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { name, inputs } },
    );
  }
}

/** Throw when a default is declared for a parameter that is not in `parameters` (registry junk). */
function requireDefaultsSubsetOfParams(
  functionName: string,
  name: string,
  parameters: string[],
  defaults: Record<string, unknown> | undefined,
): void {
  // Null is a wrong-typed value, not a second spelling of "no defaults" (the 350c2796 ruling).
  if (defaults === null) {
    throw new InputError(
      `${functionName}: "${name}" defaults must be an object when provided — omit the field for an indicator with no defaults. Received null.`,
      { code: ErrorCode.InputWrongType, context: { name } },
    );
  }
  if (!defaults) return;
  for (const key of Object.keys(defaults)) {
    if (!parameters.includes(key)) {
      throw new InputError(
        `${functionName}: "${name}" declares a default for "${key}", which is not in parameters [${parameters.join(', ')}].`,
        { code: ErrorCode.InputOutOfRange, context: { name, key, parameters } },
      );
    }
  }
}

/** Register an already-built indicator facade with metadata. Throws on a duplicate name. */
const REGISTERED_INDICATOR_KEYS = [
  'name',
  'category',
  'inputs',
  'parameters',
  'defaults',
  'conventions',
  'indicator',
  'output',
] as const satisfies readonly (keyof RegisteredIndicator)[];

export function register(entry: RegisteredIndicator): void {
  requireArgumentObject('register', 'entry', entry);
  // Law 12: a `defualts` typo must teach, not silently register an indicator with no defaults.
  ensureKnownKeys('register', 'entry', entry, REGISTERED_INDICATOR_KEYS);
  // A malformed entry must never pollute the registry: warmup probes and listIndicators iterate every
  // registered entry, so junk here breaks unrelated calls later (first-touch law).
  if (
    typeof entry.name !== 'string' ||
    entry.name.length === 0 ||
    typeof entry.indicator !== 'function' ||
    !Array.isArray(entry.parameters)
  ) {
    throw new InputError(
      'register: entry needs { name, category, inputs, parameters: string[], indicator } — see defineIndicator.',
      { code: ErrorCode.InputWrongType, context: { name: (entry as { name?: unknown }).name } },
    );
  }
  // Category drives discovery (`listIndicators('momentum')`), so junk here hides the indicator
  // from every categorized listing — an omitted or misspelled category teaches its whole domain.
  if (!(INDICATOR_CATEGORIES as readonly string[]).includes(entry.category as string)) {
    throw new InputError(
      `register: entry.category must be one of ${INDICATOR_CATEGORIES.join(' | ')}. Received ${entry.category === undefined ? 'undefined' : entry.category === null ? 'null' : JSON.stringify(entry.category)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { name: entry.name, category: entry.category, allowed: [...INDICATOR_CATEGORIES] },
      },
    );
  }
  // Conventions are echoed by every `.explain()` — junk here would be DISCLOSED as truth.
  if (
    entry.conventions !== undefined &&
    (entry.conventions === null ||
      typeof entry.conventions !== 'object' ||
      Array.isArray(entry.conventions))
  ) {
    throw new InputError(
      `register: entry.conventions must be an object of named convention choices when provided. Received ${entry.conventions === null ? 'null' : Array.isArray(entry.conventions) ? 'an array' : typeof entry.conventions}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { name: entry.name, conventions: entry.conventions },
      },
    );
  }
  requireInputs('register', entry.inputs, entry.name);
  requireDefaultsSubsetOfParams('register', entry.name, entry.parameters, entry.defaults);
  // Wave 6 §4: every registered indicator must declare valid output metadata, so discovery never lies
  // by omission (the registry-driven describe/search all read it).
  requireOutputMetadata('register', entry.name, entry.output);
  if (REGISTRY.has(entry.name)) {
    throw new InputError(`register: Indicator "${entry.name}" is already registered.`, {
      code: ErrorCode.RegistryDuplicateIndicator,
      context: { name: entry.name },
    });
  }
  // Everything the registry keeps is a frozen copy of what the caller passed, so the caller's own
  // objects are no longer reachable from the facade's allowlist or from any read accessor.
  const stored: RegisteredIndicator = Object.freeze({
    name: entry.name,
    category: entry.category,
    inputs: entry.inputs,
    parameters: frozenCopy(entry.parameters),
    ...(entry.defaults ? { defaults: frozenCopy(entry.defaults) } : {}),
    ...(entry.conventions ? { conventions: frozenCopy(entry.conventions) } : {}),
    // NOT copied: the facade is the callable thing being registered, and its identity is the point.
    indicator: entry.indicator,
    output: frozenCopy(entry.output),
  });

  // The disclosure-law choke point: bind the declared defaults (echoed by `.explain()`) and the
  // input kind (first-element shape checks) onto the facade itself, so direct calls disclose too.
  // Bound from `stored`, never from `entry` — binding the caller's array is what made the runtime
  // allowlist editable from outside.
  bindIndicatorMetadata(stored.indicator, {
    ...(stored.defaults ? { defaults: stored.defaults } : {}),
    inputs: stored.inputs,
    // Law 12: the declared parameter names become the facade's runtime allowlist.
    ...(stored.parameters ? { parameters: stored.parameters } : {}),
    // The same choke point carries the conventions, so a direct `rsi(closes).explain()` discloses
    // Wilder smoothing exactly as the registry-driven discovery path does.
    ...(stored.conventions ? { conventions: stored.conventions } : {}),
  });
  REGISTRY.set(stored.name, stored);
}

export interface IndicatorDefinition<P, In, Out> {
  name: string;
  category?: IndicatorCategory;
  inputs: IndicatorInputs;
  parameters?: string[];
  /** Output metadata (Wave 6 §4) — the recursive value schema + optional visualization. Required. */
  output: IndicatorOutputMetadata;
  /**
   * Declared default per optional parameter, echoed through `.explain().assumptions.parameters` (the
   * disclosure law). Every key must appear in `parameters`; parameters without a default are required.
   */
  defaults?: Record<string, unknown>;
  /** See {@link IndicatorMetadata.conventions} — declared here, echoed by every `.explain()`. */
  conventions?: IndicatorConventions;
  /** Stream factory (`makeIndicator`'s `make`). */
  stream: (parameters: P) => IndicatorStream<In, Out>;
  /** TechnicalAnalysisSnapshot restorer (`makeIndicator`'s restore). */
  restore: (snapshot: TechnicalAnalysisSnapshot) => IndicatorStream<In, Out>;
  /** Warmup sentinel factory. */
  nan: (parameters: P) => Out;
}

/** Build an aligned batch+stream indicator and register it. Returns the facade. */
export function defineIndicator<P, In, Out>(
  definition: IndicatorDefinition<P, In, Out>,
): Indicator<P, In, Out> {
  requireArgumentObject('defineIndicator', 'definition', definition);
  if (
    typeof definition.name !== 'string' ||
    definition.name.length === 0 ||
    typeof definition.stream !== 'function' ||
    typeof definition.restore !== 'function' ||
    typeof definition.nan !== 'function'
  ) {
    throw new InputError(
      'defineIndicator: definition needs { name, inputs, stream(parameters), restore(snapshot), nan(parameters) } — a malformed definition must not pollute the registry.',
      {
        code: ErrorCode.InputWrongType,
        context: { name: (definition as { name?: unknown }).name },
      },
    );
  }
  requireInputs('defineIndicator', definition.inputs, definition.name);
  requireOutputMetadata('defineIndicator', definition.name, definition.output);
  const indicator = makeIndicator<P, In, Out>(
    definition.stream,
    definition.restore,
    definition.nan,
    definition.defaults,
  );
  register({
    name: definition.name,
    category: definition.category ?? 'custom',
    inputs: definition.inputs,
    parameters: definition.parameters ?? [],
    ...(definition.defaults ? { defaults: definition.defaults } : {}),
    ...(definition.conventions ? { conventions: definition.conventions } : {}),
    indicator: indicator as AnyIndicator,
    output: definition.output,
  });
  return indicator;
}

/**
 * The registered entry for `name`, or `undefined`.
 *
 * The result is DEEPLY FROZEN. It is a view of the registry, not a copy to edit: mutating it used to
 * reach the facade's own validation allowlist.
 */
export function getIndicator(name: string): Readonly<RegisteredIndicator> | undefined {
  return REGISTRY.get(name);
}
export function hasIndicator(name: string): boolean {
  return REGISTRY.has(name);
}
/** Every registered indicator (optionally one category). The ARRAY is fresh; the entries are frozen. */
export function listIndicators(category?: IndicatorCategory): Readonly<RegisteredIndicator>[] {
  const all = [...REGISTRY.values()];
  return category ? all.filter((e) => e.category === category) : all;
}
export function indicatorCategories(): IndicatorCategory[] {
  return [...new Set([...REGISTRY.values()].map((e) => e.category))];
}

// ───────────────────────── auto-register the built-ins ─────────────────────────

/**
 * One registration row: declared param names plus the default for every OPTIONAL param (the
 * curated disclosure data, dx R1). A param with no entry in `defaults` is required. A default may
 * be a resolver `(resolved) => value` when it is computed from another parameter. The whole table
 * is verified against the implementations by `test/registry-defaults-truth.test.ts` — declared
 * defaults must reproduce the no-param output exactly.
 */
type Entry = [
  name: string,
  indicator: AnyIndicator,
  inputs: IndicatorInputs,
  parameters: string[],
  defaults?: Record<string, unknown>,
];

/**
 * A derived default: the parameter defaults to another (already-resolved) parameter's value — e.g.
 * vidya's `cmoPeriod` defaults to its `period`. Disclosed as the concrete resolved value.
 */
const sib =
  (name: string) =>
  (resolved: Record<string, unknown>): unknown =>
    resolved[name];

const BUILTINS: Record<IndicatorCategory, Entry[]> = {
  transform: [
    ['typicalPrice', transforms.typicalPrice, 'bars', []],
    ['medianPrice', transforms.medianPrice, 'bars', []],
    ['weightedClose', transforms.weightedClose, 'bars', []],
    ['averagePrice', transforms.averagePrice, 'bars', []],
    ['realBody', transforms.realBody, 'bars', []],
    ['upperShadow', transforms.upperShadow, 'bars', []],
    ['lowerShadow', transforms.lowerShadow, 'bars', []],
    ['candleRange', transforms.candleRange, 'bars', []],
    ['trueRange', transforms.trueRange, 'bars', []],
    ['gap', transforms.gap, 'bars', []],
    ['heikinAshi', transforms.heikinAshi, 'bars', []],
    ['returns', series.returns, 'series', []],
    ['logReturns', series.logReturns, 'series', []],
    ['rollingVolatility', series.rollingVolatility, 'series', ['period', 'annualization']],
  ],
  'moving-average': [
    ['sma', ma.sma, 'series', ['period']],
    ['ema', ma.ema, 'series', ['period']],
    ['wma', ma.wma, 'series', ['period']],
    ['rma', ma.rma, 'series', ['period']],
    ['dema', ma.dema, 'series', ['period']],
    ['tema', ma.tema, 'series', ['period']],
    ['trima', ma.trima, 'series', ['period']],
    ['t3', ma.t3, 'series', ['period', 'volumeFactor'], { volumeFactor: 0.7 }],
    ['kama', ma.kama, 'series', ['period', 'fast', 'slow'], { fast: 2, slow: 30 }],
    ['hma', ma.hma, 'series', ['period']],
    ['zlema', ma.zlema, 'series', ['period']],
    ['alma', ma.alma, 'series', ['period', 'offset', 'sigma'], { offset: 0.85, sigma: 6 }],
    ['vidya', ma.vidya, 'series', ['period', 'cmoPeriod'], { cmoPeriod: sib('period') }],
    ['mcginley', ma.mcginley, 'series', ['period']],
    ['superSmoother', ma.superSmoother, 'series', ['period']],
    ['vwma', ma.vwma, 'bars', ['period']],
    ['rollingVwap', ma.rollingVwap, 'bars', ['period']],
    ['anchoredVwap', ma.anchoredVwap, 'bars', ['anchor']],
    ['frama', ma.frama, 'bars', ['period']],
    ['mama', ma.mama, 'bars', ['fastLimit', 'slowLimit'], { fastLimit: 0.5, slowLimit: 0.05 }],
    [
      'movingAverage',
      stats.movingAverage,
      'series',
      ['period', 'movingAverageType'],
      { movingAverageType: 'sma' },
    ],
    ['midpoint', stats.midpoint, 'series', ['period']],
    ['midprice', stats.midprice, 'bars', ['period']],
    ['fwma', ovx.fwma, 'series', ['period']],
    ['sineWma', ovx.sineWma, 'series', ['period']],
    ['pascalWma', ovx.pascalWma, 'series', ['period']],
    ['symmetricWma', ovx.symmetricWma, 'series', ['period']],
    ['jma', ovx.jma, 'series', ['period', 'phase', 'power'], { phase: 0, power: 1 }],
    [
      'holtWinterMovingAverage',
      ovx.holtWinterMovingAverage,
      'series',
      ['levelSmoothing', 'trendSmoothing', 'accelerationSmoothing'],
      { levelSmoothing: 0.2, trendSmoothing: 0.1, accelerationSmoothing: 0.1 },
    ],
    [
      'rainbowMovingAverage',
      ovx.rainbowMovingAverage,
      'series',
      ['period', 'levels'],
      { period: 2, levels: 10 },
    ],
    [
      'movingAverageRibbon',
      ovx.movingAverageRibbon,
      'series',
      ['periods'],
      { periods: [10, 20, 30, 40, 50] },
    ],
    ['gannHighLowActivator', ovx.gannHighLowActivator, 'bars', ['period'], { period: 3 }],
    ['vwapBands', ovx.vwapBands, 'bars', ['multiplier'], { multiplier: 2 }],
    ['sessionVwap', ovx.sessionVwap, 'bars', ['resetEvery']],
    [
      'rollingAnchoredVwap',
      ovx.rollingAnchoredVwap,
      'bars',
      ['lookback', 'anchor'],
      { lookback: 50, anchor: 'low' },
    ],
  ],
  momentum: [
    ['rsi', rsi, 'series', ['period'], { period: 14 }],
    ['macd', macd, 'series', ['fast', 'slow', 'signal'], { fast: 12, slow: 26, signal: 9 }],
    ['roc', osc.roc, 'series', ['period'], { period: 10 }],
    ['rocp', osc.rocp, 'series', ['period'], { period: 10 }],
    ['rocr', osc.rocr, 'series', ['period'], { period: 10 }],
    ['rocr100', osc.rocr100, 'series', ['period'], { period: 10 }],
    ['momentum', osc.momentum, 'series', ['period'], { period: 10 }],
    ['cmo', osc.cmo, 'series', ['period', 'talib'], { period: 14, talib: false }],
    ['apo', osc.apo, 'series', ['fast', 'slow'], { fast: 12, slow: 26 }],
    ['ppo', osc.ppo, 'series', ['fast', 'slow', 'signal'], { fast: 12, slow: 26, signal: 9 }],
    [
      'stochRsi',
      osc.stochRsi,
      'series',
      ['rsiPeriod', 'stochPeriod', 'kPeriod', 'dPeriod'],
      { rsiPeriod: 14, stochPeriod: 14, kPeriod: 3, dPeriod: 3 },
    ],
    ['trix', osc.trix, 'series', ['period'], { period: 30 }],
    ['dpo', osc.dpo, 'series', ['period']],
    ['tsi', osc.tsi, 'series', ['long', 'short', 'signal'], { long: 25, short: 13, signal: 13 }],
    [
      'kst',
      osc.kst,
      'series',
      ['rocPeriods', 'smaPeriods', 'signal'],
      { rocPeriods: [10, 15, 20, 30], smaPeriods: [10, 10, 10, 15], signal: 9 },
    ],
    [
      'connorsRsi',
      osc.connorsRsi,
      'series',
      ['rsiPeriod', 'streakPeriod', 'rankPeriod'],
      { rsiPeriod: 3, streakPeriod: 2, rankPeriod: 100 },
    ],
    [
      'macdExt',
      osc.macdExt,
      'series',
      [
        'fast',
        'slow',
        'signal',
        'fastMovingAverageType',
        'slowMovingAverageType',
        'signalMovingAverageType',
      ],
      {
        fast: 12,
        slow: 26,
        signal: 9,
        fastMovingAverageType: 'ema',
        slowMovingAverageType: 'ema',
        signalMovingAverageType: 'ema',
      },
    ],
    ['macdFix', osc.macdFix, 'series', ['signal'], { signal: 9 }],
    ['cci', osc.cci, 'bars', ['period'], { period: 14 }],
    ['williamsR', osc.williamsR, 'bars', ['period'], { period: 14 }],
    ['awesomeOscillator', osc.awesomeOscillator, 'bars', ['fast', 'slow'], { fast: 5, slow: 34 }],
    [
      'ultimateOscillator',
      osc.ultimateOscillator,
      'bars',
      ['short', 'medium', 'long'],
      { short: 7, medium: 14, long: 28 },
    ],
    ['fisherTransform', osc.fisherTransform, 'bars', ['period'], { period: 9 }],
    [
      'stochastic',
      bars.stochastic,
      'bars',
      ['kPeriod', 'dPeriod', 'smoothK'],
      { kPeriod: 14, dPeriod: 3, smoothK: 1 },
    ],
    // A true alias of `stochastic` (same facade object): with the default `smoothK: 1` the
    // stochastic IS the fast stochastic (TA-Lib STOCHF). The declared defaults are identical by
    // construction — both names share one disclosure slot.
    [
      'stochFast',
      stats.stochFast,
      'bars',
      ['kPeriod', 'dPeriod', 'smoothK'],
      { kPeriod: 14, dPeriod: 3, smoothK: 1 },
    ],
    ['bop', stats.bop, 'bars', []],
    ['bias', momx.bias, 'series', ['period'], { period: 26 }],
    ['cfo', momx.cfo, 'series', ['period'], { period: 14 }],
    ['forecastOscillator', momx.forecastOscillator, 'series', ['period'], { period: 14 }],
    [
      'coppock',
      momx.coppock,
      'series',
      ['longRoc', 'shortRoc', 'wma'],
      { longRoc: 14, shortRoc: 11, wma: 10 },
    ],
    ['cti', momx.cti, 'series', ['period'], { period: 12 }],
    ['efficiencyRatio', momx.efficiencyRatio, 'series', ['period'], { period: 10 }],
    ['centerOfGravity', momx.centerOfGravity, 'series', ['period'], { period: 10 }],
    ['psychologicalLine', momx.psychologicalLine, 'series', ['period'], { period: 12 }],
    ['slope', momx.slope, 'series', ['period'], { period: 1 }],
    [
      'trixHistogram',
      momx.trixHistogram,
      'series',
      ['period', 'signal'],
      { period: 15, signal: 9 },
    ],
    [
      'smiErgodic',
      momx.smiErgodic,
      'series',
      ['long', 'short', 'signal'],
      { long: 20, short: 5, signal: 5 },
    ],
    ['pvo', momx.pvo, 'bars', ['fast', 'slow', 'signal'], { fast: 12, slow: 26, signal: 9 }],
    ['elderRay', momx.elderRay, 'bars', ['period'], { period: 13 }],
    ['brar', momx.brar, 'bars', ['period'], { period: 26 }],
    ['kdj', momx.kdj, 'bars', ['period', 'signal'], { period: 9, signal: 3 }],
    ['relativeVigorIndex', momx.relativeVigorIndex, 'bars', ['period'], { period: 14 }],
    ['pgo', momx.pgo, 'bars', ['period'], { period: 14 }],
    [
      'volumeWeightedMacd',
      momx.volumeWeightedMacd,
      'bars',
      ['fast', 'slow', 'signal'],
      { fast: 12, slow: 26, signal: 9 },
    ],
    ['inertia', momx.inertia, 'series', ['period', 'rviPeriod'], { period: 20, rviPeriod: 14 }],
    ['laguerreRsi', momx.laguerreRsi, 'series', ['gamma'], { gamma: 0.5 }],
    [
      'qqe',
      momx.qqe,
      'series',
      ['rsiPeriod', 'smooth', 'factor'],
      { rsiPeriod: 14, smooth: 5, factor: 4.236 },
    ],
    ['rsx', momx.rsx, 'series', ['period'], { period: 14 }],
    [
      'schaffTrendCycle',
      momx.schaffTrendCycle,
      'series',
      ['fast', 'slow', 'cycle'],
      { fast: 23, slow: 50, cycle: 10 },
    ],
    [
      'squeeze',
      momx.squeeze,
      'bars',
      [
        'bollingerBandPeriod',
        'bollingerStandardDeviations',
        'keltnerChannelPeriod',
        'keltnerChannelMultiplier',
      ],
      {
        bollingerBandPeriod: 20,
        bollingerStandardDeviations: 2,
        keltnerChannelPeriod: 20,
        keltnerChannelMultiplier: 1.5,
      },
    ],
    [
      'squeezePro',
      momx.squeezePro,
      'bars',
      [
        'bollingerBandPeriod',
        'bollingerStandardDeviations',
        'keltnerChannelPeriod',
        'wideKeltnerChannelMultiplier',
        'normalKeltnerChannelMultiplier',
        'narrowKeltnerChannelMultiplier',
      ],
      {
        bollingerBandPeriod: 20,
        bollingerStandardDeviations: 2,
        keltnerChannelPeriod: 20,
        wideKeltnerChannelMultiplier: 2,
        normalKeltnerChannelMultiplier: 1.5,
        narrowKeltnerChannelMultiplier: 1,
      },
    ],
    ['projectionOscillator', momx.projectionOscillator, 'bars', ['period'], { period: 14 }],
    ['tdSequential', momx.tdSequential, 'bars', ['lookback'], { lookback: 4 }],
    [
      'smcSweep',
      pax.smcSweep,
      'bars',
      ['period', 'wickMultiplier'],
      { period: 15, wickMultiplier: 1.5 },
    ],
  ],
  trend: [
    ['adx', bars.adx, 'bars', ['period'], { period: 14 }],
    ['dmi', trend.dmi, 'bars', ['period'], { period: 14 }],
    ['plusDI', trend.plusDI, 'bars', ['period'], { period: 14 }],
    ['minusDI', trend.minusDI, 'bars', ['period'], { period: 14 }],
    ['plusDM', trend.plusDM, 'bars', ['period'], { period: 14 }],
    ['minusDM', trend.minusDM, 'bars', ['period'], { period: 14 }],
    ['dx', trend.dx, 'bars', ['period'], { period: 14 }],
    ['adxr', trend.adxr, 'bars', ['period'], { period: 14 }],
    ['aroon', trend.aroon, 'bars', ['period'], { period: 14 }],
    ['aroonOscillator', trend.aroonOscillator, 'bars', ['period'], { period: 14 }],
    ['psar', trend.psar, 'bars', ['step', 'max'], { step: 0.02, max: 0.2 }],
    [
      'psarExt',
      trend.psarExt,
      'bars',
      [
        'startValue',
        'offsetOnReverse',
        'accelInitLong',
        'accelLong',
        'accelMaxLong',
        'accelInitShort',
        'accelShort',
        'accelMaxShort',
      ],
      {
        startValue: 0,
        offsetOnReverse: 0,
        accelInitLong: 0.02,
        accelLong: 0.02,
        accelMaxLong: 0.2,
        accelInitShort: 0.02,
        accelShort: 0.02,
        accelMaxShort: 0.2,
      },
    ],
    ['supertrend', trend.supertrend, 'bars', ['period', 'multiplier'], { multiplier: 3 }],
    [
      'ichimoku',
      trend.ichimoku,
      'bars',
      ['conversion', 'base', 'spanB', 'displacement'],
      { conversion: 9, base: 26, spanB: 52, displacement: 26 },
    ],
    ['vortex', trend.vortex, 'bars', ['period'], { period: 14 }],
    ['donchianTrend', trend.donchianTrend, 'bars', ['period'], { period: 20 }],
    ['chandelierExit', trend.chandelierExit, 'bars', ['period', 'multiplier'], { multiplier: 3 }],
    ['linreg', trend.linreg, 'series', ['period']],
    ['linregSlope', trend.linregSlope, 'series', ['period']],
    ['linregIntercept', trend.linregIntercept, 'series', ['period']],
    ['linregAngle', trend.linregAngle, 'series', ['period']],
    ['tsf', trend.tsf, 'series', ['period']],
    ['choppinessIndex', trx.choppinessIndex, 'bars', ['period'], { period: 14 }],
    [
      'chandeKrollStop',
      trx.chandeKrollStop,
      'bars',
      ['atrPeriod', 'multiplier', 'period'],
      { atrPeriod: 10, multiplier: 1, period: 9 },
    ],
    ['centralPivotRange', trx.centralPivotRange, 'bars', []],
    [
      'amat',
      trx.amat,
      'series',
      ['fast', 'slow', 'lookback', 'movingAverageType'],
      { fast: 8, slow: 21, lookback: 2, movingAverageType: 'ema' },
    ],
    ['linearDecay', trx.linearDecay, 'series', ['period'], { period: 5 }],
    ['exponentialDecay', trx.exponentialDecay, 'series', ['period'], { period: 5 }],
    ['increasing', trx.increasing, 'series', ['period', 'strict'], { period: 1, strict: false }],
    ['decreasing', trx.decreasing, 'series', ['period', 'strict'], { period: 1, strict: false }],
    ['longRun', trx.longRun, 'pair', ['period'], { period: 2 }],
    ['shortRun', trx.shortRun, 'pair', ['period'], { period: 2 }],
    ['pMax', trx.pMax, 'bars', ['period', 'multiplier'], { period: 10, multiplier: 3 }],
    ['qstick', trx.qstick, 'bars', ['period'], { period: 10 }],
    ['ttmTrend', trx.ttmTrend, 'bars', ['period'], { period: 6 }],
    [
      'verticalHorizontalFilter',
      trx.verticalHorizontalFilter,
      'series',
      ['period'],
      { period: 28 },
    ],
    ['trendSignals', trx.trendSignals, 'series', []],
    ['crossSignals', trx.crossSignals, 'series', ['above', 'below'], { above: 0, below: 0 }],
  ],
  volatility: [
    ['atr', bars.atr, 'bars', ['period'], { period: 14 }],
    ['natr', vol.natr, 'bars', ['period'], { period: 14 }],
    [
      'keltner',
      vol.keltner,
      'bars',
      ['period', 'atrPeriod', 'multiplier'],
      { period: 20, atrPeriod: 10, multiplier: 2 },
    ],
    ['donchian', vol.donchian, 'bars', ['period'], { period: 20 }],
    ['parkinson', vol.parkinson, 'bars', ['period', 'annualization']],
    ['garmanKlass', vol.garmanKlass, 'bars', ['period', 'annualization']],
    ['rogersSatchell', vol.rogersSatchell, 'bars', ['period', 'annualization']],
    ['yangZhang', vol.yangZhang, 'bars', ['period', 'annualization']],
    [
      'chaikinVolatility',
      vol.chaikinVolatility,
      'bars',
      ['period', 'rocPeriod'],
      { rocPeriod: sib('period') },
    ],
    [
      'bbands',
      bbands,
      'series',
      ['period', 'standardDeviation'],
      { period: 20, standardDeviation: 2 },
    ],
    [
      'bollingerBandWidth',
      vol.bollingerBandWidth,
      'series',
      ['period', 'standardDeviation'],
      { standardDeviation: 2 },
    ],
    [
      'bollingerPercentB',
      vol.bollingerPercentB,
      'series',
      ['period', 'standardDeviation'],
      { standardDeviation: 2 },
    ],
    ['standardDeviation', vol.standardDeviation, 'series', ['period', 'sample'], { sample: false }],
    ['variance', vol.variance, 'series', ['period', 'sample'], { sample: false }],
    ['historicalVolatility', vol.historicalVolatility, 'series', ['period', 'annualization']],
    ['realizedVolatility', vol.realizedVolatility, 'series', ['period', 'annualization']],
    [
      'relativeVolatilityIndex',
      vol.relativeVolatilityIndex,
      'series',
      ['period', 'stdevPeriod'],
      { period: 14, stdevPeriod: sib('period') },
    ],
    ['aberration', volx.aberration, 'bars', ['period', 'atrPeriod'], { period: 5, atrPeriod: 15 }],
    [
      'accelerationBands',
      volx.accelerationBands,
      'bars',
      ['period', 'multiplier'],
      { period: 20, multiplier: 4 },
    ],
    [
      'holtWinterChannel',
      volx.holtWinterChannel,
      'series',
      ['levelSmoothing', 'trendSmoothing', 'accelerationSmoothing', 'varianceSmoothing', 'scalar'],
      {
        levelSmoothing: 0.2,
        trendSmoothing: 0.1,
        accelerationSmoothing: 0.1,
        varianceSmoothing: 0.1,
        scalar: 1,
      },
    ],
    ['massIndex', volx.massIndex, 'bars', ['fast', 'slow'], { fast: 9, slow: 25 }],
    ['priceDistance', volx.priceDistance, 'bars', ['drift'], { drift: 1 }],
    [
      'elderThermometer',
      volx.elderThermometer,
      'bars',
      ['period', 'long', 'short'],
      { period: 20, long: 2, short: 0.5 },
    ],
    ['ulcerIndex', volx.ulcerIndex, 'series', ['period'], { period: 14 }],
    ['atrBands', volx.atrBands, 'bars', ['period', 'multiplier'], { period: 14, multiplier: 2 }],
    ['percentAtr', volx.percentAtr, 'bars', ['period'], { period: 14 }],
    [
      'volatilityStop',
      volx.volatilityStop,
      'bars',
      ['period', 'multiplier'],
      { period: 20, multiplier: 2 },
    ],
  ],
  volume: [
    ['obv', bars.obv, 'bars', ['talib'], { talib: false }],
    ['vwap', bars.vwap, 'bars', []],
    ['adLine', volm.adLine, 'bars', []],
    ['chaikinOscillator', volm.chaikinOscillator, 'bars', ['fast', 'slow'], { fast: 3, slow: 10 }],
    ['chaikinMoneyFlow', volm.chaikinMoneyFlow, 'bars', ['period'], { period: 20 }],
    ['mfi', volm.mfi, 'bars', ['period'], { period: 14 }],
    ['pvt', volm.pvt, 'bars', []],
    ['easeOfMovement', volm.easeOfMovement, 'bars', ['period', 'scale'], { scale: 1e8 }],
    ['forceIndex', volm.forceIndex, 'bars', ['period'], { period: 13 }],
    ['nvi', volm.nvi, 'bars', []],
    ['pvi', volm.pvi, 'bars', []],
    [
      'klinger',
      volm.klinger,
      'bars',
      ['fast', 'slow', 'signal'],
      { fast: 34, slow: 55, signal: 13 },
    ],
    [
      'vfi',
      volm.vfi,
      'bars',
      ['period', 'coefficient', 'volumeCutoff', 'smooth'],
      { period: 130, coefficient: 0.2, volumeCutoff: 2.5, smooth: 3 },
    ],
    ['relativeVolume', volm.relativeVolume, 'bars', ['period']],
    ['cvd', volm.cvd, 'bars', []],
    [
      'archerObv',
      volmx.archerObv,
      'bars',
      ['fast', 'slow', 'runLength'],
      { fast: 4, slow: 12, runLength: 2 },
    ],
    ['marketFacilitationIndex', volmx.marketFacilitationIndex, 'bars', []],
    ['priceVolume', volmx.priceVolume, 'bars', ['signed'], { signed: false }],
    ['priceVolumeRank', volmx.priceVolumeRank, 'bars', []],
    ['volumeOscillator', volmx.volumeOscillator, 'bars', ['fast', 'slow'], { fast: 5, slow: 10 }],
    ['williamsAd', volmx.williamsAd, 'bars', []],
    // efi / emv / kvo are the SAME facades as forceIndex / easeOfMovement / klinger, so their
    // declared defaults must be identical — both names share one disclosure slot.
    ['efi', volmx.efi, 'bars', ['period'], { period: 13 }],
    ['emv', volmx.emv, 'bars', ['period', 'scale'], { scale: 1e8 }],
    ['kvo', volmx.kvo, 'bars', ['fast', 'slow', 'signal'], { fast: 34, slow: 55, signal: 13 }],
  ],
  cycle: [
    ['dsp', cycle.dsp, 'series', ['period'], { period: 14 }],
    ['ebsw', cycle.ebsw, 'series', ['period', 'bars'], { period: 40, bars: 10 }],
    ['msw', cycle.msw, 'series', ['period'], { period: 5 }],
    ['htDcPeriod', cycle.htDcPeriod, 'series', []],
    ['htDcPhase', cycle.htDcPhase, 'series', []],
    ['htPhasor', cycle.htPhasor, 'series', []],
    ['htSine', cycle.htSine, 'series', []],
    ['htTrendMode', cycle.htTrendMode, 'series', []],
    ['htTrendline', cycle.htTrendline, 'series', []],
  ],
  statistic: [
    ['beta', stats.beta, 'pair', ['period']],
    ['correl', stats.correl, 'pair', ['period']],
    ['rollingMin', stats.rollingMin, 'series', ['period']],
    ['rollingMax', stats.rollingMax, 'series', ['period']],
    ['rollingSum', stats.rollingSum, 'series', ['period']],
    ['rollingMinIndex', stats.rollingMinIndex, 'series', ['period']],
    ['rollingMaxIndex', stats.rollingMaxIndex, 'series', ['period']],
    ['rollingMinMax', stats.rollingMinMax, 'series', ['period']],
    ['rollingMinMaxIndex', stats.rollingMinMaxIndex, 'series', ['period']],
    ['shift', fx.shift, 'series', ['period'], { period: 1 }],
    ['lag', fx.lag, 'series', ['period'], { period: 1 }],
    ['diff', fx.difference, 'series', ['period'], { period: 1 }],
    ['change', fx.change, 'series', ['period'], { period: 1 }],
    ['fractionalChange', fx.fractionalChange, 'series', ['period'], { period: 1 }],
    ['cum', fx.cumulativeSum, 'series', []],
    ['zScore', fx.zScore, 'series', ['period'], { period: 20 }],
    ['normalize', fx.normalize, 'series', ['period'], { period: 20 }],
    ['rescale', fx.rescale, 'series', ['period', 'min', 'max'], { period: 20, min: 0, max: 1 }],
    ['rollingMedian', fx.rollingMedian, 'series', ['period'], { period: 20 }],
    ['mad', fx.rollingMeanAbsoluteDeviation, 'series', ['period'], { period: 20 }],
    ['standardError', fx.standardError, 'series', ['period'], { period: 20 }],
    ['rollingRank', fx.rollingRank, 'series', ['period'], { period: 20 }],
    ['percentRank', fx.percentRank, 'series', ['period'], { period: 20 }],
    [
      'rollingQuantile',
      fx.rollingQuantile,
      'series',
      ['period', 'quantile'],
      { period: 20, quantile: 0.5 },
    ],
    [
      'winsorize',
      fx.winsorize,
      'series',
      ['period', 'lower', 'upper'],
      { period: 20, lower: 0.05, upper: 0.95 },
    ],
    ['skew', fx.skew, 'series', ['period'], { period: 20 }],
    ['kurtosis', fx.kurtosis, 'series', ['period'], { period: 20 }],
    ['entropy', fx.entropy, 'series', ['period'], { period: 10 }],
    ['covariance', fx.covariance, 'pair', ['period', 'sample'], { period: 20, sample: true }],
    ['rSquared', fx.rSquared, 'pair', ['period'], { period: 20 }],
    ['rollingRegression', fx.rollingRegression, 'pair', ['period'], { period: 20 }],
    ['barSince', fx.barSince, 'series', []],
    ['valueWhen', fx.valueWhen, 'pair', ['occurrence'], { occurrence: 0 }],
    ['rollingMean', fx.rollingMean, 'series', ['period']],
    ['rollingBeta', fx.rollingBeta, 'pair', ['period']],
    ['rollingCorrelation', fx.rollingCorrelation, 'pair', ['period']],
    ['highestBars', fx.highestBars, 'series', ['period']],
    ['lowestBars', fx.lowestBars, 'series', ['period']],
    // `period: null` is the disclosed expanding (all-history) window — null and undefined both
    // select it, so the echoed parameters reproduce the computation verbatim.
    [
      'tosStdevAll',
      fx.tosStdevAll,
      'series',
      ['period', 'stds', 'ddof'],
      { period: null, stds: [1, 2, 3], ddof: 1 },
    ],
  ],
  math: [
    ['acos', math.acos, 'series', []],
    ['asin', math.asin, 'series', []],
    ['atan', math.atan, 'series', []],
    ['ceil', math.ceil, 'series', []],
    ['cos', math.cos, 'series', []],
    ['cosh', math.cosh, 'series', []],
    ['exp', math.exp, 'series', []],
    ['floor', math.floor, 'series', []],
    ['ln', math.ln, 'series', []],
    ['log10', math.log10, 'series', []],
    ['sin', math.sin, 'series', []],
    ['sinh', math.sinh, 'series', []],
    ['sqrt', math.sqrt, 'series', []],
    ['tan', math.tan, 'series', []],
    ['tanh', math.tanh, 'series', []],
    ['add', math.add, 'pair', []],
    ['sub', math.sub, 'pair', []],
    ['mult', math.mult, 'pair', []],
    ['div', math.div, 'pair', []],
    ['crossover', math.crossover, 'pair', []],
    ['crossany', math.crossany, 'pair', []],
  ],
  performance: [['drawdown', perf.drawdown, 'series', []]],
  candlestick: [
    ['cdlDoji', cdlDoji, 'bars', []],
    ['cdlInside', cdlInside, 'bars', []],
    ['cdlZ', cdlZ, 'bars', ['period', 'ddof'], { period: 30, ddof: 1 }],
  ],
  'price-action': [
    ['fairValueGaps', pax.fairValueGaps, 'bars', ['minimumGapPercent'], { minimumGapPercent: 0 }],
    ['orderBlocks', pax.orderBlocks, 'bars', ['lookback'], { lookback: 5 }],
    ['liquiditySweeps', pax.liquiditySweeps, 'bars', ['lookback'], { lookback: 20 }],
    ['swingTrailingStop', pax.swingTrailingStop, 'bars', ['strength'], { strength: 2 }],
    [
      'atrTrailingStop',
      pax.atrTrailingStop,
      'bars',
      ['period', 'multiplier'],
      { period: 14, multiplier: 3 },
    ],
    [
      'equalHighs',
      pax.equalHighs,
      'bars',
      ['strength', 'tolerance'],
      { strength: 2, tolerance: 0.001 },
    ],
    [
      'equalLows',
      pax.equalLows,
      'bars',
      ['strength', 'tolerance'],
      { strength: 2, tolerance: 0.001 },
    ],
    [
      'divergence',
      divergence,
      'pair',
      ['swing', 'kinds'],
      {
        swing: { left: 5, right: 5 },
        kinds: ['bullish', 'bearish', 'hiddenBullish', 'hiddenBearish'],
      },
    ],
  ],
  custom: [],
};

/**
 * The choices an indicator made that its PARAMETERS cannot reveal, echoed by `.explain()` and by
 * `describeIndicator` (see {@link IndicatorMetadata.conventions}).
 *
 * Every entry here corresponds to a row in `docs/compatibility/talib-differences.md`, and
 * `conventions-disclosure.test.ts` holds the two directions together: a documented divergence must
 * appear here, and an entry here must name a registered indicator. That is what stops the disclosure
 * from rotting the way a prose-only note does — the numbers moved, the doc stayed, and nobody knew.
 *
 * Kept as a keyed table rather than a sixth element of the `Entry` tuple ON PURPOSE: a positional
 * slot for something this varied is the same defect this file's `.explain()` grammar exists to
 * prevent, and it reads far better grouped by the question a user is actually asking ("why does
 * your RSI disagree with mine?").
 */
const CONVENTIONS: Readonly<Record<string, IndicatorConventions>> = {
  // ── Wilder's smoothing family: the seed and the first bar are where implementations part ──
  rsi: {
    smoothing: 'wilder',
    // The one that surprises people: TA-Lib says 0 here and pandas-ta says NaN.
    flatSeries: 'returns 100 (the RS → ∞ limit, TradingView); TA-Lib returns 0, pandas-ta NaN',
    reference: 'bit-identical to TA-Lib on any series carrying both gains and losses',
  },
  atr: {
    smoothing: 'wilder',
    firstBar: "includes the first bar's range (TR[0] = H₀ − L₀, per Wilder); TA-Lib drops it",
    reference: 'converges to TA-Lib within ~1e-5 by ~5·period bars',
  },
  natr: {
    smoothing: 'wilder',
    firstBar: "includes the first bar's range (per Wilder); TA-Lib drops it",
    reference: 'converges to TA-Lib within ~1e-5 by ~5·period bars',
  },
  adx: {
    smoothing: 'wilder',
    seeding: 'RMA seed (TradingView); TA-Lib accumulates period − 1 then takes one Wilder step',
  },
  // Same directional-movement family, same seed, same doc row as ADX — found by the disclosure gate
  // rather than by me, which is the argument for having the gate read the doc instead of a list.
  dx: {
    smoothing: 'wilder',
    seeding: 'RMA seed (TradingView); TA-Lib accumulates period − 1 then takes one Wilder step',
    reference: 'converges to TA-Lib within ~1e-2 by ~6·period bars',
  },
  adxr: {
    smoothing: 'wilder',
    lookback: 'averages ADX_t with ADX_{t−period}; TA-Lib reaches one bar less far (period − 1)',
    reference: 'approximate; documented rather than strictly asserted',
  },
  cmo: {
    smoothing: "Chande's original simple sums (pandas-ta default), NOT Wilder",
    talibMode: 'cmo(…, { talib: true }) reproduces TA-Lib’s Wilder CMO (2·RSI − 100) exactly',
  },

  // ── EMA-vs-SMA and seeding choices inherited from TradingView ──
  apo: { smoothing: 'EMA of fast/slow (TradingView); TA-Lib defaults to SMA (matype 0)' },
  ppo: { smoothing: 'EMA of fast/slow (TradingView); TA-Lib defaults to SMA (matype 0)' },
  macd: {
    seeding: 'fast and slow EMAs seeded independently (TradingView)',
    reference: 'TA-Lib re-seeds the fast EMA at the slow period’s start and trims the line',
  },
  macdFix: {
    seeding: 'fast and slow EMAs seeded independently (TradingView)',
    reference: 'TA-Lib re-seeds the fast EMA at the slow period’s start and trims the line',
  },
  chaikinOscillator: {
    seeding: 'EMA-seeded fast/slow (TradingView)',
    reference: 'converges to TA-Lib ADOSC within ~1e-4 by ~60 bars',
  },
  trix: {
    firstValue:
      'first emitted at TA-Lib’s lookback 3·(period − 1) + 1; no value is fabricated earlier',
    zeroBase: 'a zero previous triple-EMA yields NaN, matching roc rather than reporting 0 change',
  },

  // ── Degenerate windows: what 0/0 resolves to, and why it differs from RSI ──
  stochastic: {
    defaultForm: 'fast stochastic (smoothK: 1, raw %K); smoothK > 1 gives the classic slow form',
    flatWindow: 'returns 0 when the window high equals its low, matching TA-Lib and pandas-ta',
    reference: 'exact vs TA-Lib STOCH with { kPeriod, smoothK, dPeriod } and the SMA matype',
  },
  stochFast: {
    flatWindow: 'returns 0 when the window high equals its low, matching TA-Lib and pandas-ta',
  },
  stochRsi: {
    smoothing: 'kPeriod/dPeriod smooth the RAW Stoch-RSI',
    flatWindow: 'returns 0 when the RSI window is flat, matching TA-Lib and pandas-ta',
    reference: 'exact vs TA-Lib with kPeriod: 1 (TA-Lib’s fastk is the raw %K)',
  },

  // ── Definitional differences: the same name, a different quantity ──
  dpo: {
    form: "Pring's causal close[t − shift] − SMA(close, period)[t], shift = ⌊period/2⌋ + 1",
    lookahead:
      'none — pandas-ta’s centered=True result resolved BACKWARD so no value needs a future bar',
  },
  obv: {
    seeding: 'seeds at 0; TA-Lib seeds at volume[0], so the two differ by that constant',
    reference: 'deltas are identical; qkOBV + volume[0] equals TA-Lib exactly',
  },
  rollingMaxIndex: {
    form: 'bars SINCE the extreme (TradingView highestbars, 0 = current bar); TA-Lib returns the absolute index',
  },
  rollingMinIndex: {
    form: 'bars SINCE the extreme (TradingView lowestbars, 0 = current bar); TA-Lib returns the absolute index',
  },
  rollingMinMaxIndex: {
    form: 'bars SINCE each extreme (TradingView); TA-Lib returns absolute indices',
  },
  mama: {
    input:
      'a BARS indicator on the (H+L)/2 median price (Ehlers’ original); TA-Lib applies any single series',
    reference: 'feed high = low = close to reproduce TA-Lib’s close-based MAMA',
  },
  beta: {
    form: 'the FINANCIAL beta on returns, cov(Δx, Δy) / var(Δy), certified by closed-form oracle',
    reference: 'TA-Lib’s BETA uses a different internal regression, so the values differ',
  },
  supertrend: {
    seeding: 'seeds from the lower band, so the first direction is +1 (pandas-ta)',
  },
  ebsw: {
    reference:
      'bug-compatible with pandas-ta, INCLUDING its degree-valued arguments passed to radian trig; ' +
      'this is deliberately NOT Ehlers’ published filter',
  },
};

for (const [category, entries] of Object.entries(BUILTINS) as [IndicatorCategory, Entry[]][]) {
  for (const [name, indicator, inputs, parameters, defaults] of entries) {
    register({
      name,
      category,
      inputs,
      parameters,
      ...(defaults ? { defaults } : {}),
      ...(CONVENTIONS[name] ? { conventions: CONVENTIONS[name] } : {}),
      indicator,
      output: resolveOutputMetadata(name),
    });
  }
}
for (const [name, indicator] of Object.entries(candlesticks)) {
  register({
    name,
    category: 'candlestick',
    inputs: 'bars',
    parameters: [],
    indicator,
    output: resolveOutputMetadata(name),
  });
}

// ───────────────────────── documentation generation ─────────────────────────

/** Render the registry as a Markdown reference table, grouped by category. */
export function registryMarkdown(): string {
  const lines: string[] = ['# TotalFinance indicator registry', ''];
  lines.push(
    `Auto-generated from \`@totalfinance/technical-analysis\` — ${REGISTRY.size} registered indicators.`,
    '',
  );
  const categories: IndicatorCategory[] = [
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
  for (const cat of categories) {
    const entries = listIndicators(cat).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) continue;
    lines.push(`## ${cat} (${entries.length})`, '');
    lines.push('| Indicator | Inputs | Parameters | Output |', '| --- | --- | --- | --- |');
    for (const e of entries) {
      lines.push(
        `| \`${e.name}\` | ${e.inputs} | ${e.parameters.length ? e.parameters.map((p) => `\`${p}\``).join(', ') : '—'} | ${summarizeOutputShape(e.output.value)} |`,
      );
    }
    lines.push('');
    if (cat === 'volatility') {
      // The scale law (pre-publish interface repairs, A3): an annualized estimator never guesses
      // its bars per year, so the reference states the rule beside the table that lists them.
      const annualized = entries
        .filter((e) => e.parameters.includes('annualization'))
        .map((e) => `\`${e.name}\``)
        .join(', ');
      lines.push(
        `The volatility estimators (${annualized}) require \`annualization\` — the bars per year that scales the`,
        'per-bar σ: `252` for daily bars, `52` weekly, `12` monthly, or `1` to read the per-bar σ. There is no',
        "default, because a per-bar σ handed to `@totalfinance/volatility`'s realized-vs-implied tools is silently",
        'wrong by √252.',
        '',
      );
    }
  }
  return lines.join('\n');
}

/** A compact human summary of an output value shape for the registry Markdown (Wave 6 §4). */
function summarizeOutputShape(v: IndicatorOutputMetadata['value']): string {
  if (v.type === 'record') return `record{${Object.keys(v.fields).sort().join(', ')}}`;
  if (v.type === 'array') return `${summarizeOutputShape(v.items)}[]`;
  return v.type;
}
