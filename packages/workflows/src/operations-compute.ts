import { resolvedExpiry, ErrorCode } from '@totalfinance/core';
/**
 * TotalFinance MCP tool definitions.
 *
 * Each tool calls the public `@totalfinance/options` API — no duplicated pricing math (spec §18.1) — and
 * derives its input JSON Schema from the same runtime schema facade used everywhere else.
 */

import {
  InputError,
  type OptionQuote,
  type QuantWarning,
  optionExpiryToMs,
  resolveValuationAsOf,
  yearFraction,
} from '@totalfinance/core';
import { type Infer, type JSONSchema, schema } from '@totalfinance/core/schema';
import { blackScholes, impliedVolatility } from '@totalfinance/options';
import { blackScholesShape, optionType } from '@totalfinance/options/schema';
import { type VaROptions, valueAtRisk, valueAtRiskReport } from '@totalfinance/risk';
import {
  buildStrategy,
  classifyStrategy,
  type LegInput,
  listStrategies,
  type PositionConfig,
  strategy,
} from '@totalfinance/strategy';
import { type ExposureConfig, type ExposureMarket, exposure } from '@totalfinance/structure';
import {
  type BarInput,
  type IndicatorCategory,
  type TechnicalAnalysisExplain,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import {
  expectedMoveFromImpliedVolatility,
  expectedMoveFromStraddle,
  probabilityInTheMoney,
  probabilityOfTouch,
} from '@totalfinance/volatility';
import { capRows, extendObjectSchema } from './operation-kit.js';
import { ValuationInstantSchema } from './wire-schemas.js';
import {
  defineOperation,
  type OperationOutput,
  type OperationPack,
  type TotalFinanceOperation,
} from './operation.js';
import {
  calendarSessions,
  cryptoPack,
  fixedIncomePack,
  performanceAnalyze,
  riskOptimize,
  strategyList,
  structureFlow,
  volatilityEvent,
  volatilityMetrics,
  volatilitySurfaceTool,
} from './operations-analysis.js';

const ASSUMPTIONS_SCHEMA: JSONSchema = { type: 'object', description: 'Applied conventions' };
const DIAGNOSTICS_SCHEMA: JSONSchema = { type: 'object', description: 'Engine, method, warnings' };

const PRICE_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    value: { type: 'number' },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: ['value'],
};
const GREEKS_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    greeks: {
      type: 'object',
      properties: {
        delta: { type: 'number' },
        gamma: { type: 'number' },
        theta: { type: 'number' },
        vega: { type: 'number' },
        rho: { type: 'number' },
      },
    },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: ['greeks'],
};
const IV_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    // `null` when the inversion did not converge (`converged: false`); never a fabricated number.
    value: { type: ['number', 'null'] },
    converged: { type: 'boolean' },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: ['value', 'converged'],
};
const TA_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    indicator: { type: 'string' },
    category: { type: 'string' },
    inputs: { type: 'string', enum: ['series', 'bars', 'pair'] },
    // Warmup slots are `null` (the indicator's NaN warmup, JSON-normalized); later points are
    // numbers or per-point objects (e.g. MACD).
    value: { type: 'array', items: { type: ['number', 'object', 'null'] } },
    assumptions: {
      type: 'object',
      description: 'indicator + parameters actually used (declared defaults merged with supplied)',
    },
    diagnostics: { type: 'object', description: 'warnings + warmup (first non-null index)' },
  },
  required: ['indicator', 'value', 'assumptions', 'diagnostics'],
};

/**
 * Date-aware option inputs (F7). Agents know dates, not year-fractions: they have an `expiry` and a
 * valuation date, not a memorized `t`. So every option tool accepts EITHER `t` (years, the library's
 * native field) OR `expiry` + `asOf`, from which `t` is derived on ACT/365F. `t` is made optional and
 * the two date fields added on top of the library's own field descriptors (one source of truth — same
 * descriptions as everywhere else). The resolved `t` is echoed back in `assumptions.timeToExpiryYears`.
 */
const expiryField = schema
  .string()
  .optional()
  .describe(
    'Option expiry — YYYY-MM-DD (→ the US close: 16:00 ET, 13:00 ET on early-close days) or a zoned ISO datetime. Supply with asOf instead of timeToExpiryYears.',
  );
const asOfField = ValuationInstantSchema.optional().describe(
  'Valuation instant — epoch ms or a zoned ISO datetime (a bare date is refused: the time of day ' +
    'matters for a same-day option). Supply with expiry instead of timeToExpiryYears.',
);

const dateAwareBlackScholesShape = {
  ...blackScholesShape,
  timeToExpiryYears: blackScholesShape.timeToExpiryYears
    .optional()
    .describe('Time to expiry in years — or supply expiry + asOf instead.'),
  expiry: expiryField,
  asOf: asOfField,
} as const;

/** Date-aware `blackScholes.price` / `blackScholes.greeks` input: `t` optional, `expiry` + `asOf` accepted. */
const DateAwareBlackScholesTypedInputSchema = schema.object({
  ...dateAwareBlackScholesShape,
  type: optionType,
});

/** Date-aware implied-vol input (the library IV schema with `t` optional + `expiry`/`asOf`). */
const DateAwareBlackScholesImpliedVolatilityInputSchema = schema.object({
  price: schema.number().positive().describe('Observed option price to invert'),
  spot: blackScholesShape.spot,
  strike: blackScholesShape.strike,
  timeToExpiryYears: dateAwareBlackScholesShape.timeToExpiryYears,
  riskFreeRate: blackScholesShape.riskFreeRate,
  type: optionType,
  dividendYield: blackScholesShape.dividendYield,
  expiry: expiryField,
  asOf: asOfField,
});

/**
 * Collapse a date-aware option input to the library's `t`-based payload: use `t` if given, else derive
 * it from `expiry` + `asOf` on ACT/365F. Rejects the ambiguous both-given case and the underspecified
 * neither-given case with a typed teaching error, and strips the date fields the pricing kernels don't
 * take. The resolved `t` then flows through so `assumptions.timeToExpiryYears` echoes it honestly.
 */
function withResolvedTime<
  T extends { timeToExpiryYears?: number; expiry?: string; asOf?: string | number },
>(
  input: T,
  tool: string,
): Omit<T, 'expiry' | 'asOf'> & {
  timeToExpiryYears: number;
  /** Present only on the date-aware path — merged into the tool's returned assumptions (P1.6). */
  timeMetadata?: {
    asOf: number;
    asOfIso: string;
    expiryConvention: 'us-equity-close' | 'explicit-instant';
  };
} {
  const { expiry, asOf, ...rest } = input;
  const hasDates = expiry !== undefined || asOf !== undefined;
  if (rest.timeToExpiryYears !== undefined) {
    if (hasDates) {
      throw new InputError(
        `${tool}: provide either timeToExpiryYears (time to expiry in years) or expiry + asOf, not both.`,
        { code: ErrorCode.InputOutOfRange, context: { tool } },
      );
    }
    return { ...rest, timeToExpiryYears: rest.timeToExpiryYears };
  }
  if (expiry === undefined || asOf === undefined) {
    throw new InputError(
      `${tool}: provide timeToExpiryYears (time to expiry in years), or both expiry and asOf to derive it.`,
      {
        code: ErrorCode.InputMissingField,
        context: { tool, missing: expiry === undefined ? 'expiry' : 'asOf' },
      },
    );
  }
  const asOfMs = resolveValuationAsOf(asOf, tool);
  const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
  if (!(t > 0)) {
    throw new InputError(
      `${tool}: expiry ${expiry} is not after asOf ${asOf} (derived timeToExpiryYears=${t} years).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { tool, expiry, asOf, timeToExpiryYears: t },
      },
    );
  }
  // The applied resolution is echoed, not hidden: a bare YYYY-MM-DD expiry means 16:00 ET
  // (US equity/options close); a zoned datetime is the caller's explicit instant.
  const expiryConvention = /^\d{4}-\d{2}-\d{2}$/.test(expiry)
    ? ('us-equity-close' as const)
    : ('explicit-instant' as const);
  return {
    ...rest,
    timeToExpiryYears: t,
    timeMetadata: { asOf: asOfMs, asOfIso: new Date(asOfMs).toISOString(), expiryConvention },
  };
}

/** Split the date-resolution metadata off a resolved input and merge it into a result's assumptions. */
function splitTimeMetadata<T extends { timeMetadata?: Record<string, unknown> }>(
  resolved: T,
): { input: Omit<T, 'timeMetadata'>; meta: Record<string, unknown> } {
  const { timeMetadata, ...input } = resolved;
  return { input, meta: timeMetadata ?? {} };
}

const optionPrice = defineOperation({
  id: 'totalfinance.option.price',
  title: 'Price an option (Black–Scholes–Merton)',
  description:
    'Price a European option with the Black–Scholes–Merton model. Supply time as timeToExpiryYears (years) or as ' +
    'expiry + asOf (dates). Returns the price plus the assumptions (day count, compounding, units, ' +
    'resolved timeToExpiryYears) and diagnostics that produced it.',
  inputSchema: DateAwareBlackScholesTypedInputSchema,
  outputSchema: PRICE_OUTPUT,
  run: (input) => {
    const { input: resolved, meta } = splitTimeMetadata(
      withResolvedTime(input, 'totalfinance.option.price'),
    );
    const r = blackScholes.price.explain(resolved);
    return {
      summary: `${input.type} price = ${r.value.toFixed(6)} (engine ${r.diagnostics.engine})`,
      structured: {
        value: r.value,
        assumptions: { ...r.assumptions, ...meta },
        diagnostics: r.diagnostics,
      },
    };
  },
});

const optionGreeks = defineOperation({
  id: 'totalfinance.option.greeks',
  title: 'Compute first-order Greeks',
  description:
    'Compute first-order Greeks (delta, gamma, theta/day, vega/1%, rho/1%) for a European option ' +
    'under Black–Scholes–Merton. Supply time as timeToExpiryYears (years) or as expiry + asOf (dates).',
  inputSchema: DateAwareBlackScholesTypedInputSchema,
  outputSchema: GREEKS_OUTPUT,
  run: (input) => {
    const { input: resolved, meta } = splitTimeMetadata(
      withResolvedTime(input, 'totalfinance.option.greeks'),
    );
    const r = blackScholes.greeks.explain(resolved);
    const g = r.value;
    return {
      summary: `delta=${g.delta.toFixed(4)} gamma=${g.gamma.toFixed(6)} theta=${g.theta.toFixed(
        4,
      )} vega=${g.vega.toFixed(4)} rho=${g.rho.toFixed(4)}`,
      structured: {
        greeks: g,
        assumptions: { ...r.assumptions, ...meta },
        diagnostics: r.diagnostics,
      },
    };
  },
});

/**
 * IV input with the full method suite exposed to agents: the option fields come from the library's
 * own `BlackScholesImpliedVolatilityInputSchema` (one source of truth — no drift-prone duplicate), extended with
 * the tool-only solver knobs: `method` selects the solver (auto/brent/newton/halley/householder)
 * and `fallback` toggles the safe Brent backstop. The actually-used method and any fallback are
 * reported in `diagnostics`.
 */
const ImpliedVolatilityMethodInputSchema = extendObjectSchema(
  DateAwareBlackScholesImpliedVolatilityInputSchema,
  schema.object({
    method: schema
      .enum(['auto', 'brent', 'newton', 'halley', 'householder'] as const)
      .describe('Solver method (default auto = Householder with a Brent fallback)')
      .optional(),
    fallback: schema
      .boolean()
      .describe('Fall back to Brent when the chosen method fails (default true)')
      .optional(),
  }),
);

const impliedVolatilityTool = defineOperation({
  id: 'totalfinance.option.implied_volatility',
  title: 'Solve implied volatility',
  description:
    'Solve Black–Scholes–Merton implied volatility from an observed option price using the method ' +
    'suite (auto/brent/newton/halley/householder, with an optional Brent fallback). Supply time as timeToExpiryYears ' +
    '(years) or as expiry + asOf (dates). Non-convergence and no-arbitrage failures are reported in ' +
    'diagnostics (converged: false), never fabricated; the method actually used is echoed in ' +
    'diagnostics.method.',
  inputSchema: ImpliedVolatilityMethodInputSchema,
  outputSchema: IV_OUTPUT,
  run: (input) => {
    const { method, fallback, ...dateAware } = input;
    const { input: impliedVolatilityInput, meta } = splitTimeMetadata(
      withResolvedTime(dateAware, 'totalfinance.option.implied_volatility'),
    );
    const options = {
      ...(method !== undefined ? { method } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
    };
    const r = impliedVolatility(impliedVolatilityInput, options);
    const summary =
      r.diagnostics.converged && r.value !== null
        ? `implied volatility = ${(r.value * 100).toFixed(4)}% (method ${r.diagnostics.method})`
        : `implied volatility did not converge (${r.diagnostics.warnings[0]?.code ?? 'unknown'})`;
    return {
      summary,
      structured: {
        value: r.value,
        converged: r.diagnostics.converged === true,
        assumptions: { ...r.assumptions, ...meta },
        diagnostics: r.diagnostics,
      },
    };
  },
});

/**
 * Every registered indicator is dispatchable: both the `indicator` enum and the runtime dispatch
 * come from the `@totalfinance/technical-analysis` registry, so `technical_analysis.calculate` covers the full ~300-indicator surface
 * (spec DX5.1) instead of a hardcoded handful. Discover names + input kinds with `totalfinance.technical_analysis.list`.
 */
const INDICATOR_NAMES: readonly string[] = ta.listIndicators().map((i) => i.name);
const INDICATOR_CATEGORIES: readonly string[] = ta.indicatorCategories();

const numberArray = () => schema.array(schema.number());

const TaCalculateInputSchema = schema.object({
  indicator: schema.enum(INDICATOR_NAMES),
  // Close-based (`series`) indicators take `closes`. Bar-based indicators take `bars` (an array of
  // OHLCV objects) or parallel column arrays under `series`. Pair indicators (e.g. beta, correl)
  // take `x` and `y`. Use `totalfinance.technical_analysis.list` to look up an indicator's input kind and parameters.
  closes: numberArray().optional(),
  bars: schema
    .array(
      schema.object({
        open: schema.number().optional(),
        high: schema.number(),
        low: schema.number(),
        close: schema.number(),
        volume: schema.number().optional(),
      }),
    )
    .optional(),
  series: schema
    .object({
      open: numberArray().optional(),
      high: numberArray().optional(),
      low: numberArray().optional(),
      close: numberArray().optional(),
      volume: numberArray().optional(),
    })
    .optional(),
  // Bivariate-sample coordinates, the same `x`/`y` the library's `Pair` carries. An MCP schema has
  // no owning type to supply that role, so the describe strings do it instead.
  x: numberArray()
    .optional()
    .describe('Pair indicators: the first series (for beta/correl, the ASSET returns)'),
  y: numberArray()
    .optional()
    .describe('Pair indicators: the second series (for beta/correl, the BENCHMARK returns)'),
  // Indicator parameters (e.g. `{ period: 14 }`). Omitted parameters fall back to each indicator's
  // documented default (spec DX0.2). Discover param names with `totalfinance.technical_analysis.list`.
  parameters: schema
    .record(schema.union([schema.number(), schema.string(), schema.boolean()]))
    .optional(),
});

type TaInput = Infer<typeof TaCalculateInputSchema>;
type RegisteredIndicator = NonNullable<ReturnType<typeof ta.getIndicator>>;

/** A teaching error that names the field this indicator needs, keyed to its input kind. */
function requireField<T>(value: T | undefined, def: RegisteredIndicator, field: string): T {
  if (value === undefined) {
    throw new InputError(
      `technical_analysis.calculate: "${def.name}" needs \`${field}\` (input kind: ${def.inputs}).`,
      {
        code: ErrorCode.InputMissingField,
        context: { indicator: def.name, field, inputs: def.inputs },
      },
    );
  }
  return value;
}

/** Assemble bar objects from parallel `series` columns when `bars` was not passed directly. */
function columnsToBars(series: TaInput['series']): BarInput[] | undefined {
  if (!series?.close || !series.high || !series.low) return undefined;
  const { high, low, close, open, volume } = series;
  const n = close.length;
  // Mismatched column lengths would silently read `undefined` (→ NaN) rather than teach; reject it.
  for (const [name, col] of [
    ['high', high],
    ['low', low],
    ['open', open],
    ['volume', volume],
  ] as const) {
    if (col && col.length !== n) {
      throw new InputError(
        `technical_analysis.calculate: series column \`${name}\` has length ${col.length}, expected ${n} to match \`close\`.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { column: name, length: col.length, expected: n },
        },
      );
    }
  }
  return close.map((c, i) => ({
    high: high[i] as number,
    low: low[i] as number,
    close: c,
    ...(open ? { open: open[i] as number } : {}),
    ...(volume ? { volume: volume[i] as number } : {}),
  }));
}

const TA_TOOL = 'totalfinance.technical_analysis.calculate';

/** Route the caller's arrays to the shape this indicator's input kind expects. */
function indicatorInput(def: RegisteredIndicator, input: TaInput): readonly unknown[] {
  switch (def.inputs) {
    case 'series':
      return capRows(
        requireField(input.closes ?? input.series?.close, def, 'closes'),
        'closes',
        TA_TOOL,
      );
    case 'bars':
      return capRows(
        requireField(input.bars ?? columnsToBars(input.series), def, 'bars'),
        'bars',
        TA_TOOL,
      );
    case 'pair': {
      const x = capRows(requireField(input.x, def, 'x'), 'x', TA_TOOL);
      const y = capRows(requireField(input.y, def, 'y'), 'y', TA_TOOL);
      return ta.pairs(x, y);
    }
  }
}

function runTa(input: TaInput): {
  def: RegisteredIndicator;
  result: TechnicalAnalysisExplain<unknown>;
} {
  const def = ta.getIndicator(input.indicator);
  if (!def) {
    throw new InputError(`technical_analysis.calculate: unknown indicator "${input.indicator}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { indicator: input.indicator },
    });
  }
  const parameters = input.parameters ?? {};
  const result = def.indicator.explain(
    indicatorInput(def, input),
    parameters,
  ) as TechnicalAnalysisExplain<unknown>;
  return { def, result };
}

const taCalculate = defineOperation({
  id: 'totalfinance.technical_analysis.calculate',
  title: 'Calculate a technical indicator',
  description:
    'Compute any of TotalFinance’s ~300 registered technical indicators over a price series. ' +
    'Close-based (`series`) indicators take `closes`; bar-based indicators take `bars` (OHLCV ' +
    'objects) or parallel column arrays under `series`; pair indicators (e.g. beta, correl) take ' +
    '`x` and `y`. Use `totalfinance.technical_analysis.list` to discover indicator names, input kinds, and parameters. ' +
    'Output is aligned to input length with null during warmup; `assumptions.parameters` echoes the ' +
    'parameters actually used (declared defaults merged with yours), and `diagnostics.warmup` is ' +
    'the first real index.',
  inputSchema: TaCalculateInputSchema,
  outputSchema: TA_OUTPUT,
  run: (input) => {
    const { def, result } = runTa(input);
    return {
      summary: `${def.name}: ${result.value.length} points (warmup ${result.diagnostics.warmup})`,
      structured: {
        indicator: def.name,
        category: def.category,
        inputs: def.inputs,
        value: result.value,
        // The one-envelope law (dx §2.8): structured output IS the explain envelope.
        assumptions: result.assumptions,
        diagnostics: result.diagnostics,
      },
    };
  },
});

const TA_LIST_DEFAULT_LIMIT = 50;

const TaListInputSchema = schema.object({
  search: schema
    .string()
    .optional()
    .describe(
      'Case-insensitive substring of an indicator name OR a TA-Lib/pandas/TradingView alias',
    ),
  category: schema.enum(INDICATOR_CATEGORIES).optional(),
  limit: schema
    .number()
    .integer()
    .positive()
    .optional()
    .describe(
      `Page size (default ${TA_LIST_DEFAULT_LIMIT}; \`total\` is the full match count) — narrow with \`search\` before paging`,
    ),
  offset: schema.number().integer().nonnegative().optional().describe('Page offset (default 0)'),
});

/** JSON-safe view of a registry `defaults` map: resolver-function defaults become '(derived)'. */
function jsonSafeDefaults(defaults: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!defaults) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults)) out[k] = typeof v === 'function' ? '(derived)' : v;
  return out;
}

const TA_LIST_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    count: { type: 'integer', description: 'Number of indicators returned in this page' },
    total: { type: 'integer', description: 'Total matches before pagination' },
    offset: { type: 'integer' },
    indicators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          inputs: { type: 'string', enum: ['series', 'bars', 'pair'] },
          parameters: { type: 'array', items: { type: 'string' } },
          defaults: {
            type: 'object',
            description:
              "Default per optional parameter ('(derived)' when computed from another parameter)",
          },
          required: {
            type: 'array',
            items: { type: 'string' },
            description: 'Parameters with no default (must be supplied)',
          },
        },
        required: ['name', 'category', 'inputs', 'parameters', 'defaults', 'required'],
      },
    },
  },
  required: ['count', 'indicators'],
};

const taList = defineOperation({
  id: 'totalfinance.technical_analysis.list',
  title: 'List technical indicators',
  description:
    'Discover the technical indicators available to `totalfinance.technical_analysis.calculate`. Returns each ' +
    'indicator’s name, category, input kind (series | bars | pair), parameters, defaults, and which ' +
    'parameters are required. Narrow the ~335-indicator catalog with `search` (matches a name or a ' +
    'TA-Lib/pandas/TradingView alias) and/or `category`, and page it with `limit` (default 50) / `offset` ' +
    '(`total` is the full match count). For one indicator’s full card (including its warmup), use ' +
    '`totalfinance.technical_analysis.describe`. Then pass a name to `totalfinance.technical_analysis.calculate`.',
  inputSchema: TaListInputSchema,
  outputSchema: TA_LIST_OUTPUT,
  run: (input) => {
    const res = ta.searchIndicators({
      ...(input.category !== undefined ? { category: input.category as IndicatorCategory } : {}),
      ...(input.search !== undefined ? { query: input.search } : {}),
      limit: input.limit ?? TA_LIST_DEFAULT_LIMIT,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    });
    const filters = [
      input.search ? `matching "${input.search}"` : '',
      input.category ? `in "${input.category}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const paged =
      res.indicators.length < res.total
        ? ` (showing ${res.indicators.length} of ${res.total})`
        : '';
    return {
      summary: `${res.total} indicator${res.total === 1 ? '' : 's'}${
        filters ? ` ${filters}` : ''
      }${paged}`,
      structured: {
        // `count` is the rows returned; `total` the full match count (equal when unpaged).
        count: res.indicators.length,
        total: res.total,
        offset: res.offset,
        indicators: res.indicators.map((i) => ({
          name: i.name,
          category: i.category,
          inputs: i.inputs,
          // The disclosure law (dx R1): the agent sees each optional param's default and which parameters
          // are required without a probing round-trip. A resolver-fn default surfaces as '(derived)'.
          parameters: i.parameters,
          defaults: jsonSafeDefaults(i.defaults),
          required: i.required,
        })),
      },
    };
  },
});

const TaDescribeInputSchema = schema.object({
  name: schema
    .string()
    .describe('Indicator name or a TA-Lib/pandas/TradingView alias (e.g. "rsi", "RSI", "STOCH")'),
});

const TA_DESCRIBE_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Canonical indicator name' },
    category: { type: 'string' },
    inputs: { type: 'string', enum: ['series', 'bars', 'pair'] },
    parameters: { type: 'array', items: { type: 'string' } },
    defaults: {
      type: 'object',
      description:
        "Default per optional parameter ('(derived)' when computed from another parameter)",
    },
    required: { type: 'array', items: { type: 'string' } },
    warmup: {
      type: ['integer', 'null'],
      description:
        'Leading bars before the first real value (null = warmup exceeds the probe window)',
    },
    conventions: {
      type: 'object',
      description:
        'The choices this indicator made that its parameters do not reveal — smoothing method, ' +
        'what a flat/degenerate window resolves to, how the first value is seeded. Present only ' +
        'where such a choice exists, and the field to read when this indicator disagrees with ' +
        'another library (e.g. RSI on a flat series: TotalFinance 100, TA-Lib 0, pandas-ta NaN).',
    },
    aliases: {
      type: 'object',
      description: 'Cross-library names (TA-Lib / pandas-ta / TradingView), when known',
    },
  },
  required: ['name', 'category', 'inputs', 'parameters', 'defaults', 'required', 'warmup'],
};

const taDescribe = defineOperation({
  id: 'totalfinance.technical_analysis.describe',
  title: 'Describe one technical indicator',
  description:
    'Return the full card for a single indicator (alias-aware): category, input kind, parameters, ' +
    'defaults, which parameters are required, its warmup (leading bars before the first real value), and ' +
    'its cross-library aliases. The token-lean way to learn one indicator without listing all ~335. ' +
    'Discover names with `totalfinance.technical_analysis.list`; compute with `totalfinance.technical_analysis.calculate`.',
  inputSchema: TaDescribeInputSchema,
  outputSchema: TA_DESCRIBE_OUTPUT,
  run: (input) => {
    const d = ta.describeIndicator(input.name);
    const warmupText = d.warmup === null ? 'warmup exceeds the probe' : `${d.warmup}-bar warmup`;
    return {
      summary: `${d.name} (${d.category}, ${d.inputs}) — ${warmupText}`,
      structured: {
        name: d.name,
        category: d.category,
        inputs: d.inputs,
        parameters: d.parameters,
        defaults: jsonSafeDefaults(d.defaults),
        required: d.required,
        warmup: d.warmup,
        // The choices the parameters do not reveal (Wilder vs EMA smoothing, what a flat window
        // resolves to). An agent comparing this library's RSI against another one's asks exactly
        // this question, and without it the only answer lives in a doc it cannot read from here.
        ...(d.conventions !== undefined ? { conventions: d.conventions } : {}),
        ...(d.aliases !== undefined ? { aliases: d.aliases } : {}),
      },
    };
  },
});

// DX5 — the flagship strategy tool: the DX3 "price from strikes alone" capability over MCP.
// B4: a stock leg is a stock — its own row shape, with no strike, premium or expiry to fake.
const StrategyStockLegSchema = schema.object({
  kind: schema.literal('stock'),
  quantity: schema.number().describe('Signed shares: positive = long, negative = short'),
  price: schema
    .number()
    .optional()
    .describe('Entry price per share; omit to model-price the leg at `market.spot`'),
});
const StrategyOptionLegSchema = schema.object({
  kind: schema.enum(['call', 'put'] as const),
  strike: schema.number().positive(),
  quantity: schema.number().describe('Signed contracts: positive = long, negative = short'),
  premium: schema
    .number()
    .optional()
    .describe('Entry premium per share; omit to model-price the leg from `market`'),
  expiry: schema
    .string()
    .optional()
    .describe('Per-leg expiry (YYYY-MM-DD or datetime) for calendars/diagonals'),
  impliedVolatility: schema
    .number()
    .positive()
    .optional()
    .describe('Per-leg implied volatility (decimal)'),
});
const StrategyLegSchema = schema.union([StrategyStockLegSchema, StrategyOptionLegSchema]);

const StrategyMarketSchema = schema.object({
  spot: schema.number().positive(),
  volatility: schema
    .number()
    .positive()
    .describe('Annualized implied volatility (decimal, e.g. 0.18)'),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  asOf: ValuationInstantSchema.describe(
    'Entry/valuation instant — epoch ms or a zoned ISO datetime (a bare date is refused)',
  ),
  expiry: schema
    .string()
    .optional()
    .describe(
      'Default expiry for legs without their own (YYYY-MM-DD → the US close, 16:00 ET or 13:00 ET on early-close days; or a zoned datetime)',
    ),
  dividendYield: schema.number().optional(),
});

const StrategyAnalyzeInputSchema = schema.object({
  legs: schema
    .array(StrategyLegSchema)
    .optional()
    .describe('The option/stock legs of the position — supply legs OR strategy+input'),
  strategy: schema
    .string()
    .optional()
    .describe(
      'A named builder from totalfinance.strategy.list (e.g. ironCondor); pair with `input`',
    ),
  input: schema
    .record(schema.unknown())
    .optional()
    .describe("The named builder's input (shape per totalfinance.strategy.list examples)"),
  premiums: schema
    .enum(['user', 'model'] as const)
    .optional()
    .describe(
      "Entry-premium source: 'user' (from the leg premiums, default) or 'model' (price unpriced legs from `market`)",
    ),
  market: StrategyMarketSchema.optional().describe(
    'Market snapshot; required for `premiums: model` and for `probability`',
  ),
  probability: schema
    .boolean()
    .optional()
    .describe(
      'Also compute probability-of-profit, expected value, risk/reward, and probability-of-touch (needs `market`)',
    ),
  multiplier: schema
    .number()
    .positive()
    .optional()
    .describe('Contract multiplier for option legs (default 100)'),
});

const STRATEGY_ANALYZE_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    premiumSource: { type: 'string', enum: ['user', 'model'] },
    classification: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Named strategies these legs structurally match (derived via classifyStrategy; empty = custom)',
    },
    metrics: {
      type: 'object',
      properties: {
        netDebit: { type: 'number' },
        netCredit: { type: 'number' },
        maxProfit: {
          type: ['number', 'null'],
          description: 'Maximum profit at expiration; null when unbounded (see bounded.profit)',
        },
        maxLoss: {
          type: ['number', 'null'],
          description:
            'Maximum loss at expiration (negative); null when unbounded (see bounded.loss)',
        },
        bounded: {
          type: 'object',
          properties: { profit: { type: 'boolean' }, loss: { type: 'boolean' } },
          required: ['profit', 'loss'],
        },
        breakevens: { type: 'array', items: { type: 'number' } },
      },
      required: ['netDebit', 'netCredit', 'maxProfit', 'maxLoss', 'bounded', 'breakevens'],
    },
    legs: { type: 'array', items: { type: 'object' } },
    assumptions: {
      type: 'object',
      description: 'Position-construction assumptions (premium source, multiplier, provenance)',
    },
    diagnostics: {
      type: 'object',
      description: 'Warnings from the metric/probability computations (empty array when none)',
    },
    probability: {
      type: 'object',
      description: 'Present when `probability: true` was supplied (requires `market`)',
      properties: {
        probabilityOfProfit: { type: 'number' },
        expectedValue: { type: 'number' },
        riskReward: {
          type: ['number', 'null'],
          description:
            '|maxProfit / maxLoss|; null when undefined (an unbounded side or a zero max loss) — see diagnostics',
        },
        probabilityOfTouch: { type: 'array' },
        model: { type: 'object' },
        assumptions: {
          type: 'object',
          description:
            'Probability-model conventions, including `marketSource` (construction | call | merged)',
        },
      },
    },
  },
  required: ['premiumSource', 'metrics', 'legs', 'classification', 'assumptions', 'diagnostics'],
};

/** Hoist any `diagnostics.warnings` a library result carries (empty when it carries none). */
function collectWarnings(result: unknown): QuantWarning[] {
  const diag = (result as { diagnostics?: { warnings?: QuantWarning[] } } | null | undefined)
    ?.diagnostics;
  return Array.isArray(diag?.warnings) ? diag.warnings : [];
}

const strategyAnalyze = defineOperation({
  id: 'totalfinance.strategy.analyze',
  title: 'Analyze an options strategy',
  description:
    'Build a multi-leg options position from its legs and return breakevens, net debit/credit, max ' +
    'profit, and max loss. Legs may be given without premiums: pass `premiums: "model"` with a ' +
    '`market` snapshot (spot, volatility, riskFreeRate, asOf, expiry) and every unpriced leg is priced by the BSM ' +
    'engine — so an iron condor’s P&L and probability-of-profit come from strikes alone. Set ' +
    '`probability: true` (with `market`) to also get probability-of-profit, expected value, ' +
    'risk/reward, and probability-of-touch. `premiumSource` reports whether premiums were user- or ' +
    'model-supplied.',
  inputSchema: StrategyAnalyzeInputSchema,
  outputSchema: STRATEGY_ANALYZE_OUTPUT,
  run: (input) => {
    const config: PositionConfig = {
      ...(input.premiums !== undefined ? { premiums: input.premiums } : {}),
      ...(input.market !== undefined ? { market: input.market } : {}),
      ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
    };
    if ((input.legs === undefined) === (input.strategy === undefined)) {
      throw new InputError(
        'strategy.analyze: supply exactly one of `legs` (raw signed-quantity legs) or ' +
          '`strategy` + `input` (a named builder — see totalfinance.strategy.list).',
        { code: ErrorCode.InputMissingField, context: {} },
      );
    }
    // Never silently drop a requested computation (design law #4): probability needs a market.
    if (input.probability && input.market === undefined) {
      throw new InputError(
        'strategy.analyze: `probability: true` requires `market` — pass ' +
          '{ spot, volatility, riskFreeRate, asOf } (expiry comes from the position’s legs, or set market.expiry ' +
          'as the default for legs without their own).',
        { code: ErrorCode.InputMissingField, context: { field: 'market' } },
      );
    }
    let position;
    if (input.strategy !== undefined) {
      if (!listStrategies().some((e) => e.name === input.strategy)) {
        throw new InputError(
          `strategy.analyze: unknown strategy "${input.strategy}" — list the catalog with totalfinance.strategy.list.`,
          { code: ErrorCode.InputInvalidEnum, context: { strategy: input.strategy } },
        );
      }
      position = buildStrategy({
        name: input.strategy,
        input: (input.input ?? {}) as Record<string, unknown>,
        config,
      });
    } else {
      position = strategy(input.legs as LegInput[], config);
    }
    const metrics = position.metrics();
    // Derived identity (dx §4.5): an agent that assembled raw legs learns what it built.
    const classification = classifyStrategy(position).matches.map((m) => m.name);
    // Envelope law (dx §2.8): the payload carries diagnostics — warnings hoisted from the metric
    // and probability computations (both are analytic today, so this is usually empty).
    const warnings: QuantWarning[] = [...collectWarnings(metrics)];
    const structured: Record<string, unknown> = {
      premiumSource: position.premiumSource,
      metrics,
      legs: position.legs,
      classification,
      assumptions: position.assumptions(),
    };
    let popText = '';
    if (input.probability) {
      // The position remembers its construction market (R5) — probability() needs no re-telling.
      // Where the market fields came from is echoed in `probability.assumptions.marketSource`.
      const prob = position.probability();
      warnings.push(...collectWarnings(prob));
      structured['probability'] = prob;
      popText = `, PoP=${(prob.probabilityOfProfit * 100).toFixed(1)}%`;
    }
    structured['diagnostics'] = { warnings };
    const be = metrics.breakevens.map((b) => b.toFixed(2)).join(', ');
    const known = classification.length > 0 ? ` [${classification[0]}]` : '';
    return {
      summary:
        `${position.legs.length}-leg position${known} (${position.premiumSource} premiums): ` +
        `maxProfit=${metrics.maxProfit ?? 'unbounded'}, maxLoss=${metrics.maxLoss ?? 'unbounded'}, breakevens=[${be}]${popText}`,
      structured,
    };
  },
});

// DX5 — vol pack: expected move + risk-neutral probabilities, the everyday options questions.
const EXPECTED_MOVE_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    value: {
      type: 'object',
      properties: {
        oneSigma: { type: 'number' },
        oneSigmaFraction: { type: 'number' },
        expectedAbsolute: { type: 'number' },
        lower: { type: 'number' },
        upper: { type: 'number' },
      },
      required: ['oneSigma', 'oneSigmaFraction', 'expectedAbsolute', 'lower', 'upper'],
    },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: ['value'],
};

const PROBABILITY_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    value: { type: 'number', description: 'Risk-neutral probability in [0, 1]' },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: ['value'],
};

const VolatilityExpectedMoveInputSchema = schema.object({
  spot: schema.number().positive(),
  impliedVolatility: schema
    .number()
    .positive()
    .optional()
    .describe(
      'Implied volatility (annualized decimal); with `timeToExpiryYears`, the 1σ move is spot·σ·√timeToExpiryYears',
    ),
  timeToExpiryYears: schema
    .number()
    .positive()
    .optional()
    .describe('Time to expiry in years (required with `impliedVolatility`)'),
  straddlePrice: schema
    .number()
    .positive()
    .optional()
    .describe(
      'ATM straddle mid-price; when given, the move is implied from the straddle instead of IV',
    ),
});

type ExpectedMoveResult = ReturnType<typeof expectedMoveFromImpliedVolatility.explain>;

function expectedMoveResult(r: ExpectedMoveResult): OperationOutput<Record<string, unknown>> {
  const em = r.value;
  return {
    summary:
      `expected move ±${em.oneSigma.toFixed(2)} (${(em.oneSigmaFraction * 100).toFixed(2)}%), ` +
      `1σ range [${em.lower.toFixed(2)}, ${em.upper.toFixed(2)}]`,
    structured: { value: em, assumptions: r.assumptions, diagnostics: r.diagnostics },
  };
}

const volatilityExpectedMove = defineOperation({
  id: 'totalfinance.volatility.expected_move',
  title: 'Expected move (1σ)',
  description:
    'Compute the expected 1-sigma move of the underlying by expiry — the lognormal ±1σ band and ' +
    'the expected absolute move. Provide `impliedVolatility` + `timeToExpiryYears` to imply it from volatility, or `straddlePrice` ' +
    'to imply it from the ATM straddle. Risk-neutral, not a directional forecast.',
  inputSchema: VolatilityExpectedMoveInputSchema,
  outputSchema: EXPECTED_MOVE_OUTPUT,
  run: (input) => {
    if (input.straddlePrice !== undefined) {
      return expectedMoveResult(
        expectedMoveFromStraddle.explain({ spot: input.spot, straddlePrice: input.straddlePrice }),
      );
    }
    if (input.impliedVolatility !== undefined && input.timeToExpiryYears !== undefined) {
      // Tool and library now share one field name; no translation layer to drift.
      return expectedMoveResult(
        expectedMoveFromImpliedVolatility.explain({
          spot: input.spot,
          impliedVolatility: input.impliedVolatility,
          timeToExpiryYears: input.timeToExpiryYears,
        }),
      );
    }
    throw new InputError(
      'totalfinance.volatility.expected_move: provide either `straddlePrice`, or both `impliedVolatility` and `timeToExpiryYears`.',
      {
        code: ErrorCode.InputMissingField,
        context: { need: 'straddlePrice OR (impliedVolatility AND timeToExpiryYears)' },
      },
    );
  },
});

const VolatilityProbabilityItmInputSchema = schema.object({
  type: schema.enum(['call', 'put'] as const),
  spot: schema.number().positive(),
  strike: schema.number().positive(),
  timeToExpiryYears: schema.number().positive().describe('Time to expiry in years'),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  volatility: schema.number().positive().describe('Implied volatility (annualized decimal)'),
  dividendYield: schema.number().optional(),
});

const volatilityProbabilityItm = defineOperation({
  id: 'totalfinance.volatility.probability_in_the_money',
  title: 'Probability of finishing in-the-money',
  description:
    'Risk-neutral probability that an option finishes in the money at expiry — N(d2) for a call, ' +
    'N(−d2) for a put. This is the model probability P(S_t ⋛ K), not a real-world forecast.',
  inputSchema: VolatilityProbabilityItmInputSchema,
  outputSchema: PROBABILITY_OUTPUT,
  run: (input) => {
    const r = probabilityInTheMoney.explain({
      type: input.type,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      volatility: input.volatility,
      ...(input.dividendYield !== undefined ? { dividendYield: input.dividendYield } : {}),
    });
    return {
      summary: `P(finish ITM) = ${(r.value * 100).toFixed(2)}%`,
      structured: { value: r.value, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

const VolatilityProbabilityOfTouchInputSchema = schema.object({
  spot: schema.number().positive(),
  barrier: schema.number().positive().describe('The price level to touch'),
  timeToExpiryYears: schema.number().positive().describe('Time to expiry in years'),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  volatility: schema.number().positive().describe('Implied volatility (annualized decimal)'),
  dividendYield: schema.number().optional(),
});

const volatilityProbabilityOfTouch = defineOperation({
  id: 'totalfinance.volatility.probability_of_touch',
  title: 'Probability of touching a level',
  description:
    'Risk-neutral probability that the underlying TOUCHES `barrier` at any time before expiry ' +
    '(first-passage probability for geometric Brownian motion). Useful for stop/target and ' +
    'one-touch reasoning.',
  inputSchema: VolatilityProbabilityOfTouchInputSchema,
  outputSchema: PROBABILITY_OUTPUT,
  run: (input) => {
    const r = probabilityOfTouch.explain({
      spot: input.spot,
      barrier: input.barrier,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      volatility: input.volatility,
      ...(input.dividendYield !== undefined ? { dividendYield: input.dividendYield } : {}),
    });
    return {
      summary: `P(touch ${input.barrier}) = ${(r.value * 100).toFixed(2)}%`,
      structured: { value: r.value, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

// DX5 — structure pack: dealer-positioning exposure (GEX/DEX) + levels (walls, zero-gamma, max
// pain) from an option chain. The app's signature options-flow read, agent-native.
const StructureChainRowSchema = schema.object({
  strike: schema.number().positive(),
  expiry: schema.string().describe('ISO date YYYY-MM-DD'),
  type: schema.enum(['call', 'put'] as const),
  openInterest: schema.number().describe('Open interest (contracts)'),
  impliedVolatility: schema
    .number()
    .positive()
    .optional()
    .describe('Implied volatility (decimal); when omitted, implied from `price`'),
  price: schema
    .number()
    .positive()
    .optional()
    .describe('Option mid price; used to imply IV when `impliedVolatility` is omitted'),
  multiplier: schema.number().positive().optional().describe('Contract multiplier (default 100)'),
});

const StructureExposuresInputSchema = schema.object({
  chain: schema.array(StructureChainRowSchema).describe('The option chain: one row per contract'),
  spot: schema.number().positive(),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  asOf: ValuationInstantSchema,
  dividendYield: schema.number().optional(),
  convention: schema
    .enum(['callsPositivePutsNegative', 'dealerShortGamma'] as const)
    .describe(
      'Dealer sign convention — REQUIRED, it decides the sign of every exposure number; echoed back with its limitations',
    ),
  style: schema
    .enum(['american', 'european'] as const)
    .describe(
      "Exercise style of every contract in the chain — REQUIRED (listed US equity options are 'american'); the library never defaults it",
    ),
  gammaUnit: schema
    .enum(['per1PercentMove', 'perPoint'] as const)
    .optional()
    .describe('GEX units: per1PercentMove (default, the specification formula) or perPoint'),
  underlying: schema
    .string()
    .describe('Ticker symbol of the chain — REQUIRED, it names every contract'),
  topStrikes: schema
    .number()
    .integer()
    .positive()
    .optional()
    .describe('How many top-|GEX| strikes to return (default 10)'),
});

const STRUCTURE_EXPOSURES_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    spot: { type: 'number' },
    atSpot: {
      type: 'object',
      description: 'Net dealer exposure at spot',
      properties: { gex: { type: 'number' }, dex: { type: 'number' } },
      required: ['gex', 'dex'],
    },
    levels: {
      type: 'object',
      description: 'Walls, zero-gamma, max pain, pin risk, and OPEX walls',
    },
    netDrift: { type: 'object', description: 'Gamma regime + pin/trend bias + charm/vanna flow' },
    topStrikes: {
      type: 'array',
      description: 'Highest-|GEX| strikes, most concentrated first',
      items: { type: 'object' },
    },
    assumptions: {
      type: 'object',
      description:
        'Every applied convention: the sign `convention`, gammaUnit, priceSource, ' +
        'minTimeToExpiry, defaultMultiplier, …',
    },
    diagnostics: {
      type: 'object',
      description:
        'Warnings, including the model limitations as `model.limitation` entries ' +
        '(positioning is estimated from OI + a sign convention, not true dealer books)',
    },
  },
  required: ['spot', 'atSpot', 'levels', 'netDrift', 'topStrikes', 'assumptions', 'diagnostics'],
};

const structureExposures = defineOperation({
  id: 'totalfinance.structure.exposures',
  title: 'Dealer exposure & levels from an option chain',
  description:
    'Compute dealer-positioning exposure (net GEX/DEX at spot) and key levels — call/put walls, ' +
    'zero-gamma flip, max pain, pin risk, and 0DTE/weekly/monthly OPEX walls — from an option chain. ' +
    'Each row needs `strike`, `expiry`, `type`, `openInterest`, and either `impliedVolatility` or `price` (IV is ' +
    'implied from price when omitted). Inferred from open interest and a sign convention (echoed ' +
    'in `assumptions.convention`, with its caveats as `model.limitation` warnings in ' +
    '`diagnostics.warnings`) — it does not know true dealer books.',
  inputSchema: StructureExposuresInputSchema,
  outputSchema: STRUCTURE_EXPOSURES_OUTPUT,
  run: (input) => {
    const chain = capRows(input.chain, 'chain', 'totalfinance.structure.exposures');
    const asOfMs = resolveValuationAsOf(input.asOf, 'totalfinance.structure.exposures');
    // No financial assumption is set here: the caller names the underlying and the exercise style.
    const { underlying, style } = input;
    const quotes: OptionQuote[] = chain.map((row) => ({
      contract: {
        underlying,
        type: row.type,
        style,
        strike: row.strike,
        expiry: row.expiry,
        ...resolvedExpiry(row.expiry),
        ...(row.multiplier !== undefined ? { multiplier: row.multiplier } : {}),
      },
      timestampMs: asOfMs,
      openInterest: row.openInterest,
      underlyingPrice: input.spot,
      ...(row.impliedVolatility !== undefined ? { impliedVolatility: row.impliedVolatility } : {}),
      ...(row.price !== undefined ? { mid: row.price } : {}),
    }));
    const market: ExposureMarket = {
      spot: input.spot,
      riskFreeRate: input.riskFreeRate,
      asOf: asOfMs,
      ...(input.dividendYield !== undefined ? { dividendYield: input.dividendYield } : {}),
    };
    const config: ExposureConfig = {
      convention: input.convention,
      priceSource: 'mid',
      ...(input.gammaUnit !== undefined ? { gammaUnit: input.gammaUnit } : {}),
    };
    const profile = exposure({ quotes, market, config });
    const atSpot = profile.atSpot(input.spot);
    const levels = profile.levels();
    const netDrift = profile.netDrift();
    const n = input.topStrikes ?? 10;
    const topStrikes = profile
      .byStrike(['gex'])
      .slice()
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, n);
    return {
      summary:
        `net GEX ${atSpot.gex.toExponential(2)} at spot ${input.spot}; ` +
        `callWall ${levels.callWall ?? 'n/a'}, putWall ${levels.putWall ?? 'n/a'}, ` +
        `zeroGamma ${levels.zeroGamma ?? 'n/a'}, maxPain ${levels.maxPain ?? 'n/a'}`,
      structured: {
        spot: input.spot,
        atSpot,
        levels,
        netDrift,
        topStrikes,
        // The R2 envelope rides whole: the sign convention lives in `assumptions.convention` and
        // the model limitations are `model.limitation` entries in `diagnostics.warnings`.
        assumptions: profile.assumptions,
        diagnostics: profile.diagnostics,
      },
    };
  },
});

// DX5 — risk pack: portfolio Value-at-Risk / Conditional VaR from a return series.
/**
 * Hard ceiling on Monte-Carlo path count for any tool (design law #4 extended to compute): a model
 * that requests millions/billions of paths is rejected by SCHEMA VALIDATION before any work begins,
 * so a hosted server can't be driven into CPU/OOM exhaustion (the request deadline only reports
 * failure AFTER a synchronous compute finishes — too late to prevent it).
 */
const MAX_MC_SAMPLES = 1_000_000;

const RiskVarInputSchema = schema.object({
  returns: schema.array(schema.number()).describe('Periodic returns as decimals (e.g. 0.01 = +1%)'),
  confidence: schema
    .number()
    .positive()
    .optional()
    .describe('Confidence level in (0, 1); default 0.95'),
  method: schema
    .enum(['historical', 'parametric', 'monteCarlo'] as const)
    .optional()
    .describe('Estimation method; default historical'),
  horizonPeriods: schema
    .number()
    .positive()
    .optional()
    .describe('Holding-period horizon in periods; scales by √-time; default 1'),
  cornishFisher: schema
    .boolean()
    .optional()
    .describe('Parametric only: Cornish-Fisher adjustment for skew/excess-kurtosis'),
  samples: schema
    .number()
    .integer()
    .positive()
    .max(MAX_MC_SAMPLES)
    .optional()
    .describe(
      `Monte-Carlo only: number of simulated paths; default 10000, capped at ${MAX_MC_SAMPLES.toLocaleString(
        'en-US',
      )} (compute is bounded BEFORE the work starts, not just by the deadline).`,
    ),
  seed: schema.number().integer().optional().describe('Monte-Carlo only: PRNG seed; default 0'),
});

const RISK_VAR_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    value: {
      type: 'object',
      properties: {
        valueAtRisk: { type: 'number', description: 'Positive loss magnitude at `confidence`' },
        conditionalValueAtRisk: {
          type: 'number',
          description: 'Conditional VaR / expected shortfall (≥ valueAtRisk)',
        },
      },
      required: ['valueAtRisk', 'conditionalValueAtRisk'],
    },
    assumptions: {
      type: 'object',
      description:
        'confidence, method, horizonPeriods, cornishFisher, conventionsVersion ' +
        '(+ seed/samples when method is monteCarlo)',
    },
    diagnostics: { type: 'object', description: 'method + warnings' },
  },
  required: ['value', 'assumptions', 'diagnostics'],
};

const riskValueAtRisk = defineOperation({
  id: 'totalfinance.risk.value_at_risk',
  title: 'Value-at-Risk & Conditional VaR',
  // Only the monteCarlo method draws random samples: the server's seed policy injects and echoes a
  // deterministic seed for THAT method alone (dx §5.3/R8) — deterministic methods never carry a
  // meaningless seed.
  stochastic: (args) => args['method'] === 'monteCarlo',
  description:
    'Estimate Value-at-Risk (VaR) and Conditional VaR / expected shortfall from a return series. ' +
    'Methods: historical (empirical quantile, default), parametric (Gaussian, optional ' +
    'Cornish-Fisher for skew/kurtosis), or monteCarlo. Both are positive loss magnitudes at the ' +
    'given `confidence`; the horizon scales by √-time. The applied confidence/method/horizon ride ' +
    '`assumptions` (with the resolved seed/samples for monteCarlo) and warnings ride `diagnostics`.',
  inputSchema: RiskVarInputSchema,
  outputSchema: RISK_VAR_OUTPUT,
  run: (input) => {
    const returns = capRows(input.returns, 'returns', 'totalfinance.risk.value_at_risk');
    const options: VaROptions = {
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.horizonPeriods !== undefined ? { horizonPeriods: input.horizonPeriods } : {}),
      ...(input.cornishFisher !== undefined ? { cornishFisher: input.cornishFisher } : {}),
      ...(input.samples !== undefined ? { samples: input.samples } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    };
    // The library's Computed envelope is canonical (dx §2.8): `valueAtRisk.explain` echoes the
    // resolved confidence/method/horizon (and seed/samples for monteCarlo) in `assumptions` and
    // carries warnings in `diagnostics` — never hand-fabricated here. `valueAtRiskReport` supplies the
    // paired CVaR; both runs are deterministic for the same (seeded) options, so they agree.
    const env = valueAtRisk.explain(returns, options);
    const r = valueAtRiskReport(returns, options);
    return {
      summary:
        `${(r.confidence * 100).toFixed(0)}% ${r.method} VaR = ${(env.value * 100).toFixed(2)}%, ` +
        `CVaR = ${(r.conditionalValueAtRisk * 100).toFixed(2)}% (horizon ${r.horizonPeriods})`,
      structured: {
        value: { valueAtRisk: env.value, conditionalValueAtRisk: r.conditionalValueAtRisk },
        assumptions: env.assumptions,
        diagnostics: env.diagnostics,
      },
    };
  },
});

/**
 * The default read-only tools, grouped into ten domain packs (dx §5.3). Each pack can be enabled on
 * its own — `createTotalFinanceMcpServer({ packs: [optionsPack(), technicalAnalysisPack()] })` exposes only those domains
 * instead of the full set — so an agent that only needs option math isn't handed the full set. `t.length`
 * and the domain count are DERIVED from this one list, so the docs' "N read-only tools across N packs"
 * can never drift (a conformance test pins the doc numbers to `defaultTools()`/`defaultPacks()`).
 */
export function optionsPack(): OperationPack {
  return { name: 'options', operations: [optionPrice, optionGreeks, impliedVolatilityTool] };
}
export function technicalAnalysisPack(): OperationPack {
  return { name: 'technical_analysis', operations: [taCalculate, taList, taDescribe] };
}
export function strategyPack(): OperationPack {
  return { name: 'strategy', operations: [strategyAnalyze, strategyList] };
}
export function volatilityPack(): OperationPack {
  return {
    name: 'volatility',
    operations: [
      volatilityExpectedMove,
      volatilityProbabilityItm,
      volatilityProbabilityOfTouch,
      volatilitySurfaceTool,
      volatilityMetrics,
      volatilityEvent,
    ],
  };
}
export function structurePack(): OperationPack {
  return { name: 'structure', operations: [structureExposures, structureFlow] };
}
export function riskPack(): OperationPack {
  return { name: 'risk', operations: [riskValueAtRisk, riskOptimize] };
}
export function performancePack(): OperationPack {
  return { name: 'performance', operations: [performanceAnalyze] };
}
export function calendarPack(): OperationPack {
  return { name: 'calendar', operations: [calendarSessions] };
}

/** The ten domain packs that make up the default read-only server, in tool-list order. */
export function defaultPacks(): OperationPack[] {
  return [
    optionsPack(),
    technicalAnalysisPack(),
    strategyPack(),
    volatilityPack(),
    structurePack(),
    riskPack(),
    performancePack(),
    calendarPack(),
    cryptoPack(),
    fixedIncomePack(),
  ];
}

/** The default read-only tool set — every domain pack flattened (dx §WS-5). */
export function defaultOperations(): TotalFinanceOperation[] {
  return defaultPacks().flatMap((pack) => pack.operations);
}
