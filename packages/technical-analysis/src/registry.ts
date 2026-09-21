/**
 * Indicator registry (spec §13.5).
 *
 * `defineIndicator({ name, inputs, parameters, defaults, stream, restore, nan })` builds an aligned
 * batch+stream indicator (via `makeIndicator`) and registers it with introspectable metadata. Every
 * built-in indicator is auto-registered here, so the registry is the single source of truth for
 * "what indicators exist, what they consume, what they're parameterised by, and what each parameter
 * defaults to" — and it generates the indicator reference documentation.
 *
 * Built-ins bind their package-private contracts during leaf construction, before discovery is
 * imported. This registry consumes those same named contracts; custom registration still binds
 * caller-declared metadata through `bindIndicatorMetadata`.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { frozenCopy, type BuiltinIndicatorMetadata } from './indicator-metadata.js';
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
   * rare default computed from another parameter. Bound at built-in construction/custom registration so
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
type Entry = [name: string, indicator: AnyIndicator, metadata: BuiltinIndicatorMetadata];

const BUILTINS: Record<IndicatorCategory, Entry[]> = {
  transform: [
    ['typicalPrice', transforms.typicalPrice, builtinMetadata.typicalPriceMetadata],
    ['medianPrice', transforms.medianPrice, builtinMetadata.medianPriceMetadata],
    ['weightedClose', transforms.weightedClose, builtinMetadata.weightedCloseMetadata],
    ['averagePrice', transforms.averagePrice, builtinMetadata.averagePriceMetadata],
    ['realBody', transforms.realBody, builtinMetadata.realBodyMetadata],
    ['upperShadow', transforms.upperShadow, builtinMetadata.upperShadowMetadata],
    ['lowerShadow', transforms.lowerShadow, builtinMetadata.lowerShadowMetadata],
    ['candleRange', transforms.candleRange, builtinMetadata.candleRangeMetadata],
    ['trueRange', transforms.trueRange, builtinMetadata.trueRangeMetadata],
    ['gap', transforms.gap, builtinMetadata.gapMetadata],
    ['heikinAshi', transforms.heikinAshi, builtinMetadata.heikinAshiMetadata],
    ['returns', series.returns, builtinMetadata.returnsMetadata],
    ['logReturns', series.logReturns, builtinMetadata.logReturnsMetadata],
    ['rollingVolatility', series.rollingVolatility, builtinMetadata.rollingVolatilityMetadata],
  ],
  'moving-average': [
    ['sma', ma.sma, builtinMetadata.smaMetadata],
    ['ema', ma.ema, builtinMetadata.emaMetadata],
    ['wma', ma.wma, builtinMetadata.wmaMetadata],
    ['rma', ma.rma, builtinMetadata.rmaMetadata],
    ['dema', ma.dema, builtinMetadata.demaMetadata],
    ['tema', ma.tema, builtinMetadata.temaMetadata],
    ['trima', ma.trima, builtinMetadata.trimaMetadata],
    ['t3', ma.t3, builtinMetadata.t3Metadata],
    ['kama', ma.kama, builtinMetadata.kamaMetadata],
    ['hma', ma.hma, builtinMetadata.hmaMetadata],
    ['zlema', ma.zlema, builtinMetadata.zlemaMetadata],
    ['alma', ma.alma, builtinMetadata.almaMetadata],
    ['vidya', ma.vidya, builtinMetadata.vidyaMetadata],
    ['mcginley', ma.mcginley, builtinMetadata.mcginleyMetadata],
    ['superSmoother', ma.superSmoother, builtinMetadata.superSmootherMetadata],
    ['vwma', ma.vwma, builtinMetadata.vwmaMetadata],
    ['rollingVwap', ma.rollingVwap, builtinMetadata.rollingVwapMetadata],
    ['anchoredVwap', ma.anchoredVwap, builtinMetadata.anchoredVwapMetadata],
    ['frama', ma.frama, builtinMetadata.framaMetadata],
    ['mama', ma.mama, builtinMetadata.mamaMetadata],
    ['movingAverage', stats.movingAverage, builtinMetadata.movingAverageMetadata],
    ['midpoint', stats.midpoint, builtinMetadata.midpointMetadata],
    ['midprice', stats.midprice, builtinMetadata.midpriceMetadata],
    ['fwma', ovx.fwma, builtinMetadata.fwmaMetadata],
    ['sineWma', ovx.sineWma, builtinMetadata.sineWmaMetadata],
    ['pascalWma', ovx.pascalWma, builtinMetadata.pascalWmaMetadata],
    ['symmetricWma', ovx.symmetricWma, builtinMetadata.symmetricWmaMetadata],
    ['jma', ovx.jma, builtinMetadata.jmaMetadata],
    [
      'holtWinterMovingAverage',
      ovx.holtWinterMovingAverage,
      builtinMetadata.holtWinterMovingAverageMetadata,
    ],
    [
      'rainbowMovingAverage',
      ovx.rainbowMovingAverage,
      builtinMetadata.rainbowMovingAverageMetadata,
    ],
    ['movingAverageRibbon', ovx.movingAverageRibbon, builtinMetadata.movingAverageRibbonMetadata],
    [
      'gannHighLowActivator',
      ovx.gannHighLowActivator,
      builtinMetadata.gannHighLowActivatorMetadata,
    ],
    ['vwapBands', ovx.vwapBands, builtinMetadata.vwapBandsMetadata],
    ['sessionVwap', ovx.sessionVwap, builtinMetadata.sessionVwapMetadata],
    ['rollingAnchoredVwap', ovx.rollingAnchoredVwap, builtinMetadata.rollingAnchoredVwapMetadata],
  ],
  momentum: [
    ['rsi', rsi, builtinMetadata.rsiMetadata],
    ['macd', macd, builtinMetadata.macdMetadata],
    ['roc', osc.roc, builtinMetadata.rocMetadata],
    ['rocp', osc.rocp, builtinMetadata.rocpMetadata],
    ['rocr', osc.rocr, builtinMetadata.rocrMetadata],
    ['rocr100', osc.rocr100, builtinMetadata.rocr100Metadata],
    ['momentum', osc.momentum, builtinMetadata.momentumMetadata],
    ['cmo', osc.cmo, builtinMetadata.cmoMetadata],
    ['apo', osc.apo, builtinMetadata.apoMetadata],
    ['ppo', osc.ppo, builtinMetadata.ppoMetadata],
    ['stochRsi', osc.stochRsi, builtinMetadata.stochRsiMetadata],
    ['trix', osc.trix, builtinMetadata.trixMetadata],
    ['dpo', osc.dpo, builtinMetadata.dpoMetadata],
    ['tsi', osc.tsi, builtinMetadata.tsiMetadata],
    ['kst', osc.kst, builtinMetadata.kstMetadata],
    ['connorsRsi', osc.connorsRsi, builtinMetadata.connorsRsiMetadata],
    ['macdExt', osc.macdExt, builtinMetadata.macdExtMetadata],
    ['macdFix', osc.macdFix, builtinMetadata.macdFixMetadata],
    ['cci', osc.cci, builtinMetadata.cciMetadata],
    ['williamsR', osc.williamsR, builtinMetadata.williamsRMetadata],
    ['awesomeOscillator', osc.awesomeOscillator, builtinMetadata.awesomeOscillatorMetadata],
    ['ultimateOscillator', osc.ultimateOscillator, builtinMetadata.ultimateOscillatorMetadata],
    ['fisherTransform', osc.fisherTransform, builtinMetadata.fisherTransformMetadata],
    ['stochastic', bars.stochastic, builtinMetadata.stochasticMetadata],
    // A true alias of `stochastic` (same facade object): with the default `smoothK: 1` the
    // stochastic IS the fast stochastic (TA-Lib STOCHF). The declared defaults are identical by
    // construction — both names share one disclosure slot.
    ['stochFast', stats.stochFast, builtinMetadata.stochFastMetadata],
    ['bop', stats.bop, builtinMetadata.bopMetadata],
    ['bias', momx.bias, builtinMetadata.biasMetadata],
    ['cfo', momx.cfo, builtinMetadata.cfoMetadata],
    ['forecastOscillator', momx.forecastOscillator, builtinMetadata.forecastOscillatorMetadata],
    ['coppock', momx.coppock, builtinMetadata.coppockMetadata],
    ['cti', momx.cti, builtinMetadata.ctiMetadata],
    ['efficiencyRatio', momx.efficiencyRatio, builtinMetadata.efficiencyRatioMetadata],
    ['centerOfGravity', momx.centerOfGravity, builtinMetadata.centerOfGravityMetadata],
    ['psychologicalLine', momx.psychologicalLine, builtinMetadata.psychologicalLineMetadata],
    ['slope', momx.slope, builtinMetadata.slopeMetadata],
    ['trixHistogram', momx.trixHistogram, builtinMetadata.trixHistogramMetadata],
    ['smiErgodic', momx.smiErgodic, builtinMetadata.smiErgodicMetadata],
    ['pvo', momx.pvo, builtinMetadata.pvoMetadata],
    ['elderRay', momx.elderRay, builtinMetadata.elderRayMetadata],
    ['brar', momx.brar, builtinMetadata.brarMetadata],
    ['kdj', momx.kdj, builtinMetadata.kdjMetadata],
    ['relativeVigorIndex', momx.relativeVigorIndex, builtinMetadata.relativeVigorIndexMetadata],
    ['pgo', momx.pgo, builtinMetadata.pgoMetadata],
    ['volumeWeightedMacd', momx.volumeWeightedMacd, builtinMetadata.volumeWeightedMacdMetadata],
    ['inertia', momx.inertia, builtinMetadata.inertiaMetadata],
    ['laguerreRsi', momx.laguerreRsi, builtinMetadata.laguerreRsiMetadata],
    ['qqe', momx.qqe, builtinMetadata.qqeMetadata],
    ['rsx', momx.rsx, builtinMetadata.rsxMetadata],
    ['schaffTrendCycle', momx.schaffTrendCycle, builtinMetadata.schaffTrendCycleMetadata],
    ['squeeze', momx.squeeze, builtinMetadata.squeezeMetadata],
    ['squeezePro', momx.squeezePro, builtinMetadata.squeezeProMetadata],
    [
      'projectionOscillator',
      momx.projectionOscillator,
      builtinMetadata.projectionOscillatorMetadata,
    ],
    ['tdSequential', momx.tdSequential, builtinMetadata.tdSequentialMetadata],
    ['smcSweep', pax.smcSweep, builtinMetadata.smcSweepMetadata],
  ],
  trend: [
    ['adx', bars.adx, builtinMetadata.adxMetadata],
    ['dmi', trend.dmi, builtinMetadata.dmiMetadata],
    ['plusDI', trend.plusDI, builtinMetadata.plusDIMetadata],
    ['minusDI', trend.minusDI, builtinMetadata.minusDIMetadata],
    ['plusDM', trend.plusDM, builtinMetadata.plusDMMetadata],
    ['minusDM', trend.minusDM, builtinMetadata.minusDMMetadata],
    ['dx', trend.dx, builtinMetadata.dxMetadata],
    ['adxr', trend.adxr, builtinMetadata.adxrMetadata],
    ['aroon', trend.aroon, builtinMetadata.aroonMetadata],
    ['aroonOscillator', trend.aroonOscillator, builtinMetadata.aroonOscillatorMetadata],
    ['psar', trend.psar, builtinMetadata.psarMetadata],
    ['psarExt', trend.psarExt, builtinMetadata.psarExtMetadata],
    ['supertrend', trend.supertrend, builtinMetadata.supertrendMetadata],
    ['ichimoku', trend.ichimoku, builtinMetadata.ichimokuMetadata],
    ['vortex', trend.vortex, builtinMetadata.vortexMetadata],
    ['donchianTrend', trend.donchianTrend, builtinMetadata.donchianTrendMetadata],
    ['chandelierExit', trend.chandelierExit, builtinMetadata.chandelierExitMetadata],
    ['linreg', trend.linreg, builtinMetadata.linregMetadata],
    ['linregSlope', trend.linregSlope, builtinMetadata.linregSlopeMetadata],
    ['linregIntercept', trend.linregIntercept, builtinMetadata.linregInterceptMetadata],
    ['linregAngle', trend.linregAngle, builtinMetadata.linregAngleMetadata],
    ['tsf', trend.tsf, builtinMetadata.tsfMetadata],
    ['choppinessIndex', trx.choppinessIndex, builtinMetadata.choppinessIndexMetadata],
    ['chandeKrollStop', trx.chandeKrollStop, builtinMetadata.chandeKrollStopMetadata],
    ['centralPivotRange', trx.centralPivotRange, builtinMetadata.centralPivotRangeMetadata],
    ['amat', trx.amat, builtinMetadata.amatMetadata],
    ['linearDecay', trx.linearDecay, builtinMetadata.linearDecayMetadata],
    ['exponentialDecay', trx.exponentialDecay, builtinMetadata.exponentialDecayMetadata],
    ['increasing', trx.increasing, builtinMetadata.increasingMetadata],
    ['decreasing', trx.decreasing, builtinMetadata.decreasingMetadata],
    ['longRun', trx.longRun, builtinMetadata.longRunMetadata],
    ['shortRun', trx.shortRun, builtinMetadata.shortRunMetadata],
    ['pMax', trx.pMax, builtinMetadata.pMaxMetadata],
    ['qstick', trx.qstick, builtinMetadata.qstickMetadata],
    ['ttmTrend', trx.ttmTrend, builtinMetadata.ttmTrendMetadata],
    [
      'verticalHorizontalFilter',
      trx.verticalHorizontalFilter,
      builtinMetadata.verticalHorizontalFilterMetadata,
    ],
    ['trendSignals', trx.trendSignals, builtinMetadata.trendSignalsMetadata],
    ['crossSignals', trx.crossSignals, builtinMetadata.crossSignalsMetadata],
  ],
  volatility: [
    ['atr', bars.atr, builtinMetadata.atrMetadata],
    ['natr', vol.natr, builtinMetadata.natrMetadata],
    ['keltner', vol.keltner, builtinMetadata.keltnerMetadata],
    ['donchian', vol.donchian, builtinMetadata.donchianMetadata],
    ['parkinson', vol.parkinson, builtinMetadata.parkinsonMetadata],
    ['garmanKlass', vol.garmanKlass, builtinMetadata.garmanKlassMetadata],
    ['rogersSatchell', vol.rogersSatchell, builtinMetadata.rogersSatchellMetadata],
    ['yangZhang', vol.yangZhang, builtinMetadata.yangZhangMetadata],
    ['chaikinVolatility', vol.chaikinVolatility, builtinMetadata.chaikinVolatilityMetadata],
    ['bbands', bbands, builtinMetadata.bbandsMetadata],
    ['bollingerBandWidth', vol.bollingerBandWidth, builtinMetadata.bollingerBandWidthMetadata],
    ['bollingerPercentB', vol.bollingerPercentB, builtinMetadata.bollingerPercentBMetadata],
    ['standardDeviation', vol.standardDeviation, builtinMetadata.standardDeviationMetadata],
    ['variance', vol.variance, builtinMetadata.varianceMetadata],
    [
      'historicalVolatility',
      vol.historicalVolatility,
      builtinMetadata.historicalVolatilityMetadata,
    ],
    ['realizedVolatility', vol.realizedVolatility, builtinMetadata.realizedVolatilityMetadata],
    [
      'relativeVolatilityIndex',
      vol.relativeVolatilityIndex,
      builtinMetadata.relativeVolatilityIndexMetadata,
    ],
    ['aberration', volx.aberration, builtinMetadata.aberrationMetadata],
    ['accelerationBands', volx.accelerationBands, builtinMetadata.accelerationBandsMetadata],
    ['holtWinterChannel', volx.holtWinterChannel, builtinMetadata.holtWinterChannelMetadata],
    ['massIndex', volx.massIndex, builtinMetadata.massIndexMetadata],
    ['priceDistance', volx.priceDistance, builtinMetadata.priceDistanceMetadata],
    ['elderThermometer', volx.elderThermometer, builtinMetadata.elderThermometerMetadata],
    ['ulcerIndex', volx.ulcerIndex, builtinMetadata.ulcerIndexMetadata],
    ['atrBands', volx.atrBands, builtinMetadata.atrBandsMetadata],
    ['percentAtr', volx.percentAtr, builtinMetadata.percentAtrMetadata],
    ['volatilityStop', volx.volatilityStop, builtinMetadata.volatilityStopMetadata],
  ],
  volume: [
    ['obv', bars.obv, builtinMetadata.obvMetadata],
    ['vwap', bars.vwap, builtinMetadata.vwapMetadata],
    ['adLine', volm.adLine, builtinMetadata.adLineMetadata],
    ['chaikinOscillator', volm.chaikinOscillator, builtinMetadata.chaikinOscillatorMetadata],
    ['chaikinMoneyFlow', volm.chaikinMoneyFlow, builtinMetadata.chaikinMoneyFlowMetadata],
    ['mfi', volm.mfi, builtinMetadata.mfiMetadata],
    ['pvt', volm.pvt, builtinMetadata.pvtMetadata],
    ['easeOfMovement', volm.easeOfMovement, builtinMetadata.easeOfMovementMetadata],
    ['forceIndex', volm.forceIndex, builtinMetadata.forceIndexMetadata],
    ['nvi', volm.nvi, builtinMetadata.nviMetadata],
    ['pvi', volm.pvi, builtinMetadata.pviMetadata],
    ['klinger', volm.klinger, builtinMetadata.klingerMetadata],
    ['vfi', volm.vfi, builtinMetadata.vfiMetadata],
    ['relativeVolume', volm.relativeVolume, builtinMetadata.relativeVolumeMetadata],
    ['cvd', volm.cvd, builtinMetadata.cvdMetadata],
    ['archerObv', volmx.archerObv, builtinMetadata.archerObvMetadata],
    [
      'marketFacilitationIndex',
      volmx.marketFacilitationIndex,
      builtinMetadata.marketFacilitationIndexMetadata,
    ],
    ['priceVolume', volmx.priceVolume, builtinMetadata.priceVolumeMetadata],
    ['priceVolumeRank', volmx.priceVolumeRank, builtinMetadata.priceVolumeRankMetadata],
    ['volumeOscillator', volmx.volumeOscillator, builtinMetadata.volumeOscillatorMetadata],
    ['williamsAd', volmx.williamsAd, builtinMetadata.williamsAdMetadata],
    // efi / emv / kvo are the SAME facades as forceIndex / easeOfMovement / klinger, so their
    // declared defaults must be identical — both names share one disclosure slot.
    ['efi', volmx.efi, builtinMetadata.efiMetadata],
    ['emv', volmx.emv, builtinMetadata.emvMetadata],
    ['kvo', volmx.kvo, builtinMetadata.kvoMetadata],
  ],
  cycle: [
    ['dsp', cycle.dsp, builtinMetadata.dspMetadata],
    ['ebsw', cycle.ebsw, builtinMetadata.ebswMetadata],
    ['msw', cycle.msw, builtinMetadata.mswMetadata],
    ['htDcPeriod', cycle.htDcPeriod, builtinMetadata.htDcPeriodMetadata],
    ['htDcPhase', cycle.htDcPhase, builtinMetadata.htDcPhaseMetadata],
    ['htPhasor', cycle.htPhasor, builtinMetadata.htPhasorMetadata],
    ['htSine', cycle.htSine, builtinMetadata.htSineMetadata],
    ['htTrendMode', cycle.htTrendMode, builtinMetadata.htTrendModeMetadata],
    ['htTrendline', cycle.htTrendline, builtinMetadata.htTrendlineMetadata],
  ],
  statistic: [
    ['beta', stats.beta, builtinMetadata.betaMetadata],
    ['correl', stats.correl, builtinMetadata.correlMetadata],
    ['rollingMin', stats.rollingMin, builtinMetadata.rollingMinMetadata],
    ['rollingMax', stats.rollingMax, builtinMetadata.rollingMaxMetadata],
    ['rollingSum', stats.rollingSum, builtinMetadata.rollingSumMetadata],
    ['rollingMinIndex', stats.rollingMinIndex, builtinMetadata.rollingMinIndexMetadata],
    ['rollingMaxIndex', stats.rollingMaxIndex, builtinMetadata.rollingMaxIndexMetadata],
    ['rollingMinMax', stats.rollingMinMax, builtinMetadata.rollingMinMaxMetadata],
    ['rollingMinMaxIndex', stats.rollingMinMaxIndex, builtinMetadata.rollingMinMaxIndexMetadata],
    ['shift', fx.shift, builtinMetadata.shiftMetadata],
    ['lag', fx.lag, builtinMetadata.lagMetadata],
    ['diff', fx.difference, builtinMetadata.diffMetadata],
    ['change', fx.change, builtinMetadata.changeMetadata],
    ['fractionalChange', fx.fractionalChange, builtinMetadata.fractionalChangeMetadata],
    ['cum', fx.cumulativeSum, builtinMetadata.cumMetadata],
    ['zScore', fx.zScore, builtinMetadata.zScoreMetadata],
    ['normalize', fx.normalize, builtinMetadata.normalizeMetadata],
    ['rescale', fx.rescale, builtinMetadata.rescaleMetadata],
    ['rollingMedian', fx.rollingMedian, builtinMetadata.rollingMedianMetadata],
    ['mad', fx.rollingMeanAbsoluteDeviation, builtinMetadata.madMetadata],
    ['standardError', fx.standardError, builtinMetadata.standardErrorMetadata],
    ['rollingRank', fx.rollingRank, builtinMetadata.rollingRankMetadata],
    ['percentRank', fx.percentRank, builtinMetadata.percentRankMetadata],
    ['rollingQuantile', fx.rollingQuantile, builtinMetadata.rollingQuantileMetadata],
    ['winsorize', fx.winsorize, builtinMetadata.winsorizeMetadata],
    ['skew', fx.skew, builtinMetadata.skewMetadata],
    ['kurtosis', fx.kurtosis, builtinMetadata.kurtosisMetadata],
    ['entropy', fx.entropy, builtinMetadata.entropyMetadata],
    ['covariance', fx.covariance, builtinMetadata.covarianceMetadata],
    ['rSquared', fx.rSquared, builtinMetadata.rSquaredMetadata],
    ['rollingRegression', fx.rollingRegression, builtinMetadata.rollingRegressionMetadata],
    ['barSince', fx.barSince, builtinMetadata.barSinceMetadata],
    ['valueWhen', fx.valueWhen, builtinMetadata.valueWhenMetadata],
    ['rollingMean', fx.rollingMean, builtinMetadata.rollingMeanMetadata],
    ['rollingBeta', fx.rollingBeta, builtinMetadata.rollingBetaMetadata],
    ['rollingCorrelation', fx.rollingCorrelation, builtinMetadata.rollingCorrelationMetadata],
    ['highestBars', fx.highestBars, builtinMetadata.highestBarsMetadata],
    ['lowestBars', fx.lowestBars, builtinMetadata.lowestBarsMetadata],
    // `period: null` is the disclosed expanding (all-history) window — null and undefined both
    // select it, so the echoed parameters reproduce the computation verbatim.
    ['tosStdevAll', fx.tosStdevAll, builtinMetadata.tosStdevAllMetadata],
  ],
  math: [
    ['acos', math.acos, builtinMetadata.acosMetadata],
    ['asin', math.asin, builtinMetadata.asinMetadata],
    ['atan', math.atan, builtinMetadata.atanMetadata],
    ['ceil', math.ceil, builtinMetadata.ceilMetadata],
    ['cos', math.cos, builtinMetadata.cosMetadata],
    ['cosh', math.cosh, builtinMetadata.coshMetadata],
    ['exp', math.exp, builtinMetadata.expMetadata],
    ['floor', math.floor, builtinMetadata.floorMetadata],
    ['ln', math.ln, builtinMetadata.lnMetadata],
    ['log10', math.log10, builtinMetadata.log10Metadata],
    ['sin', math.sin, builtinMetadata.sinMetadata],
    ['sinh', math.sinh, builtinMetadata.sinhMetadata],
    ['sqrt', math.sqrt, builtinMetadata.sqrtMetadata],
    ['tan', math.tan, builtinMetadata.tanMetadata],
    ['tanh', math.tanh, builtinMetadata.tanhMetadata],
    ['add', math.add, builtinMetadata.addMetadata],
    ['sub', math.sub, builtinMetadata.subMetadata],
    ['mult', math.mult, builtinMetadata.multMetadata],
    ['div', math.div, builtinMetadata.divMetadata],
    ['crossover', math.crossover, builtinMetadata.crossoverMetadata],
    ['crossany', math.crossany, builtinMetadata.crossanyMetadata],
  ],
  performance: [['drawdown', perf.drawdown, builtinMetadata.drawdownMetadata]],
  candlestick: [
    ['cdlDoji', cdlDoji, builtinMetadata.cdlDojiMetadata],
    ['cdlInside', cdlInside, builtinMetadata.cdlInsideMetadata],
    ['cdlZ', cdlZ, builtinMetadata.cdlZMetadata],
  ],
  'price-action': [
    ['fairValueGaps', pax.fairValueGaps, builtinMetadata.fairValueGapsMetadata],
    ['orderBlocks', pax.orderBlocks, builtinMetadata.orderBlocksMetadata],
    ['liquiditySweeps', pax.liquiditySweeps, builtinMetadata.liquiditySweepsMetadata],
    ['swingTrailingStop', pax.swingTrailingStop, builtinMetadata.swingTrailingStopMetadata],
    ['atrTrailingStop', pax.atrTrailingStop, builtinMetadata.atrTrailingStopMetadata],
    ['equalHighs', pax.equalHighs, builtinMetadata.equalHighsMetadata],
    ['equalLows', pax.equalLows, builtinMetadata.equalLowsMetadata],
    ['divergence', divergence, builtinMetadata.divergenceMetadata],
  ],
  custom: [],
};

for (const [category, entries] of Object.entries(BUILTINS) as [IndicatorCategory, Entry[]][]) {
  for (const [name, indicator, metadata] of entries) {
    register({
      name,
      category,
      ...metadata,
      parameters: [...metadata.parameters],
      indicator,
      output: resolveOutputMetadata(name),
    });
  }
}
for (const [name, indicator] of Object.entries(candlesticks)) {
  register({
    name,
    category: 'candlestick',
    ...builtinMetadata.candlestickMetadata,
    parameters: [...builtinMetadata.candlestickMetadata.parameters],
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
