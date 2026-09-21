/**
 * Minimal feature pipeline with explicit aliasing (spec §13.6).
 *
 * 0.1 supports building named feature columns from the core indicators. Auto-names are provided for
 * quick scripts; production code should pass `{ as: 'name' }`. Duplicate aliases throw
 * `InputError('pipeline.duplicate_alias')`.
 *
 * ## Generated column names are snake_case
 *
 * `sma_close_20`, `rsi_close_14`, `rolling_volatility_close_5`. One convention across the whole
 * string, and it is chosen for the artifact rather than for the codebase: a column lands in a
 * DataFrame, a parquet file, or a warehouse table, and identifier case-folding there is not on our
 * side — Postgres lowercases an unquoted identifier and Snowflake uppercases it, so a camelCase
 * column either gets quoted forever or silently mangled. Every peer library that emits feature
 * columns (pandas-ta, tsfresh, dbt models) reached the same place.
 *
 * This cost a round trip to get right. The first correction of `vol_` used the indicator's EXPORT
 * name — `rollingVolatility_close_5` — to keep the name mechanically parseable back into
 * (indicator, field, parameter), since snake-casing a multi-word indicator makes `_` ambiguous
 * (`rolling_volatility_close_5` splits into four segments for a three-slot format). That reasoning
 * inverts the priority: a column name is data, not an identifier, and provenance you need
 * mechanically should be exposed structurally rather than recovered by parsing a string. So the
 * name reads naturally and the parse is simply not offered.
 *
 * Every convenience method takes its indicator's own PARAMETER OBJECT — `sma(field, { period: 20 })`,
 * not `sma(field, 20)`. That is the same grammar the indicators themselves enforce (calling
 * `sma(series, 20)` throws a teaching error), and it was already what `macd`, `bbands` and
 * `rollingVolatility` took here; `sma`/`ema`/`wma`/`rsi`/`atr` were the holdouts, so this class
 * disagreed with the rest of the package AND with itself. A bare number cannot say whether it is a
 * period, a multiplier or a lookback, which is the whole reason for the rule.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { bbands, type BollingerParameters } from './bands.js';
import { atr, obv, vwap, type WilderPeriodParameters } from './bars.js';
import type { BarInput, Indicator } from './framework.js';
import { macd, type MacdParameters } from './macd.js';
import { ema, sma, wma, type PeriodParameters } from './moving-averages.js';
import { rsi, type RsiParameters } from './rsi.js';
import { returns, rollingVolatility, type RollingVolatilityParameters } from './series.js';
import { requireOneOf } from './validate.js';

export type Field = 'open' | 'high' | 'low' | 'close';
const FIELDS: readonly Field[] = ['open', 'high', 'low', 'close'];
/** A computed column: one value (scalar or record) per input bar. */
export type FeatureColumn = unknown[];

interface AliasOpt {
  as?: string;
}

const ALIAS_KEYS = ['as'] as const;

/**
 * Validate an alias option object and return the alias it names.
 *
 * Two silent failures lived here. `{ az: 'fast' }` — one key off — was ignored, so the column landed
 * under its auto-generated name and the caller's later lookup of `fast` found nothing; and `{ as: '' }`
 * produced a column literally keyed by the empty string. Both are Law 12's territory: an options
 * object is a closed request, and a near-miss key teaches instead of being dropped.
 */
function requireAlias(functionName: string, options: AliasOpt & { as: string }): string {
  requireArgumentObject(functionName, 'options', options);
  const alias = resolveAlias(functionName, options);
  if (alias === undefined) {
    throw new InputError(
      `${functionName}: options.as is required — this method has no indicator name to generate a ` +
        `column name from.`,
      { code: ErrorCode.InputMissingField, context: { function: functionName } },
    );
  }
  return alias;
}

function resolveAlias(functionName: string, options: AliasOpt | undefined): string | undefined {
  if (options === undefined) return undefined;
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, ALIAS_KEYS);
  const { as } = options;
  if (as === undefined) return undefined;
  if (typeof as !== 'string' || as.length === 0) {
    throw new InputError(
      `${functionName}: options.as must be a non-empty column name. Received ${
        typeof as === 'string' ? 'an empty string' : typeof as
      }.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName } },
    );
  }
  return as;
}

export class FeaturePipeline {
  private readonly cols = new Map<string, FeatureColumn>();
  constructor(private readonly candles: BarInput[]) {}

  private series(field: Field): number[] {
    requireOneOf(field, FIELDS, 'features', 'field');
    return this.candles.map((c) => c[field] ?? NaN);
  }

  /** The raw `field` column (`close`, `high`, …) as a number array. */
  field(field: Field): number[] {
    return this.series(field);
  }

  /** Add under an explicit alias; a duplicate explicit alias throws `pipeline.duplicate_alias`. */
  private add(alias: string, values: FeatureColumn): this {
    if (this.cols.has(alias)) {
      throw new InputError(`FeaturePipeline.add: Duplicate pipeline alias "${alias}".`, {
        code: ErrorCode.PipelineDuplicateAlias,
        context: { alias },
      });
    }
    if (values.length !== this.candles.length) {
      throw new InputError(
        `FeaturePipeline.add: Pipeline column "${alias}" has length ${values.length}, expected ${this.candles.length} (one value per bar).`,
        {
          code: ErrorCode.PipelineLengthMismatch,
          context: { alias, length: values.length, expected: this.candles.length },
        },
      );
    }
    this.cols.set(alias, values);
    return this;
  }

  /** Stable disambiguation for auto-generated names: `base`, then `base_2`, `base_3`, … */
  private uniqueAuto(base: string): string {
    if (!this.cols.has(base)) return base;
    let i = 2;
    while (this.cols.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  /**
   * Explicit aliases are taken verbatim (and collide loudly); auto-generated names disambiguate, so
   * repeating an indicator with the same parameters yields `sma_close_20`, `sma_close_20_2`, … (spec §13.6).
   */
  private put(explicitAs: string | undefined, base: string, values: FeatureColumn): this {
    return this.add(explicitAs ?? this.uniqueAuto(base), values);
  }

  /**
   * The convenience methods all follow one order, and the order is the point: validate the alias,
   * then CALL THE INDICATOR, then build the auto-name from the parameters it just accepted.
   *
   * The first version built the name first — `` `sma_${field}_${parameters.period}` `` — so a caller
   * who omitted `parameters` got `TypeError: Cannot read properties of undefined (reading 'period')`
   * from the pipeline instead of `sma`'s own teaching `InputError`. Worse for `rsi` and `atr`, whose
   * direct forms default to 14: the fluent wrapper was STRICTER than the thing it wraps. Calling the
   * indicator first delegates every parameter question to the validator that owns it.
   */
  sma(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.sma', options);
    const values = sma(this.series(field), parameters);
    return this.put(alias, `sma_${field}_${parameters.period}`, values);
  }
  ema(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.ema', options);
    const values = ema(this.series(field), parameters);
    return this.put(alias, `ema_${field}_${parameters.period}`, values);
  }
  wma(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.wma', options);
    const values = wma(this.series(field), parameters);
    return this.put(alias, `wma_${field}_${parameters.period}`, values);
  }
  /** `parameters` is optional: RSI's period defaults to 14, exactly as `rsi(series)` does. */
  rsi(field: Field, parameters?: RsiParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.rsi', options);
    const values = rsi(this.series(field), parameters ?? {});
    return this.put(alias, `rsi_${field}_${parameters?.period ?? 14}`, values);
  }
  macd(field: Field, parameters?: MacdParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.macd', options);
    const values = macd(this.series(field), parameters ?? {});
    return this.put(alias, `macd_${field}`, values);
  }
  /** `parameters` is optional: Bollinger's period defaults to 20, exactly as `bbands(series)` does. */
  bbands(field: Field, parameters?: BollingerParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.bbands', options);
    const values = bbands(this.series(field), parameters ?? {});
    return this.put(alias, `bbands_${field}_${parameters?.period ?? 20}`, values);
  }
  returns(field: Field, options?: AliasOpt): this {
    const alias = resolveAlias('features.returns', options);
    return this.put(alias, `returns_${field}`, returns(this.series(field), {}));
  }
  rollingVolatility(
    field: Field,
    parameters: RollingVolatilityParameters,
    options?: AliasOpt,
  ): this {
    const alias = resolveAlias('features.rollingVolatility', options);
    const values = rollingVolatility(this.series(field), parameters);
    return this.put(alias, `rolling_volatility_${field}_${parameters.period}`, values);
  }
  /** `parameters` is optional: ATR's Wilder period defaults to 14, exactly as `atr(bars)` does. */
  atr(parameters?: WilderPeriodParameters, options?: AliasOpt): this {
    const alias = resolveAlias('features.atr', options);
    const values = atr(this.candles, parameters ?? {});
    return this.put(alias, `atr_${parameters?.period ?? 14}`, values);
  }
  vwap(options?: AliasOpt): this {
    return this.put(resolveAlias('features.vwap', options), 'vwap', vwap(this.candles, {}));
  }
  obv(options?: AliasOpt): this {
    return this.put(resolveAlias('features.obv', options), 'obv', obv(this.candles, {}));
  }

  /**
   * Apply any series indicator (number → Out) to a price field. The generic escape hatch that lets
   * the pipeline reach every indicator in the catalog, not just the named convenience methods.
   */
  applySeries<P, Out>(
    field: Field,
    indicator: Indicator<P, number, Out>,
    parameters: P,
    options: AliasOpt & { as: string },
  ): this {
    // `as` is REQUIRED here — there is no indicator name to auto-generate from — so a misspelled key
    // produced a column called "undefined" rather than the one the caller asked for.
    const alias = requireAlias('features.applySeries', options);
    return this.add(alias, indicator(this.series(field), parameters) as FeatureColumn);
  }

  /** Apply any bar indicator (BarInput → Out) to the candles. */
  applyBars<P, Out>(
    indicator: Indicator<P, BarInput, Out>,
    parameters: P,
    options: AliasOpt & { as: string },
  ): this {
    const alias = requireAlias('features.applyBars', options);
    return this.add(alias, indicator(this.candles, parameters) as FeatureColumn);
  }

  /** Inject a precomputed column under an alias. */
  column(alias: string, values: FeatureColumn): this {
    if (typeof alias !== 'string' || alias.length === 0) {
      throw new InputError(
        `features.column: alias must be a non-empty column name. Received ${
          typeof alias === 'string' ? 'an empty string' : typeof alias
        }.`,
        { code: ErrorCode.InputWrongType, context: { function: 'features.column' } },
      );
    }
    return this.add(alias, values);
  }

  /** Columnar output keyed by alias. */
  toColumns(): Record<string, FeatureColumn> {
    return Object.fromEntries(this.cols);
  }

  /** Row-oriented output: one object per bar with each alias as a key. */
  toRows(): Record<string, unknown>[] {
    const keys = [...this.cols.keys()];
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < this.candles.length; i++) {
      const row: Record<string, unknown> = {};
      for (const k of keys) row[k] = this.cols.get(k)![i];
      rows.push(row);
    }
    return rows;
  }
}

export function features(candles: BarInput[]): FeaturePipeline {
  return new FeaturePipeline(candles);
}
