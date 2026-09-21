/**
 * Signal DSL (spec §13.6).
 *
 *   technicalAnalysis.signal(candles)
 *     .sma('close', { period: 20 }, { as: 'fast' })
 *     .sma('close', { period: 50 }, { as: 'slow' })
 *     .rsi('close', { period: 14 }, { as: 'momentum' })
 *     .when(crossOver('fast', 'slow')).and(gt('momentum', 50)).emit('long')
 *     .when(crossUnder('fast', 'slow')).emit('flat')
 *     .signals();
 *
 * Feature methods build named columns (reusing the feature pipeline); rules are boolean expressions
 * over those columns (and the raw OHLCV fields) that emit a label per bar. Conditions reference a
 * column by alias, a record sub-field by `alias.field` (e.g. `macd.histogram`), or a numeric constant.
 *
 * Feature methods take their indicator's PARAMETER OBJECT, the same grammar the indicators enforce
 * directly — `sma(series, { period: 20 })` there, `.sma('close', { period: 20 })` here. They took a
 * bare number until 3B.1b, which made this DSL the one place in the package that accepted the very
 * call shape `makeIndicator` throws a teaching error on.
 */

import {
  ensureKnownKeys,
  ErrorCode,
  InputError,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { WilderPeriodParameters } from './bars.js';
import type { BarInput, Indicator } from './framework.js';
import type { PeriodParameters } from './moving-averages.js';
import { FeaturePipeline, type Field } from './pipeline.js';
import type { RsiParameters } from './rsi.js';
import { requireStreamParameters } from './stream-validation.js';

export type Operand = string | number;

const RAW_FIELDS = new Set(['open', 'high', 'low', 'close', 'volume']);

export class SignalContext {
  private readonly cols: Map<string, unknown[]>;
  private readonly candles: BarInput[];
  constructor(parameters: { cols: Map<string, unknown[]>; candles: BarInput[] }) {
    requireStreamParameters('SignalContext.constructor#0', 'SignalContext', parameters);
    const { cols, candles } = parameters;
    this.cols = cols;
    this.candles = candles;
  }
  get(operand: Operand, barIndex: number): number {
    if (typeof operand === 'number') return operand;
    if (barIndex < 0) return NaN;
    if (operand.includes('.')) {
      const dot = operand.indexOf('.');
      const alias = operand.slice(0, dot);
      const f = operand.slice(dot + 1);
      const v = this.cols.get(alias)?.[barIndex];
      return v && typeof v === 'object' ? ((v as Record<string, number>)[f] ?? NaN) : NaN;
    }
    if (this.cols.has(operand)) {
      const v = this.cols.get(operand)![barIndex];
      return typeof v === 'number' ? v : NaN;
    }
    const b = this.candles[barIndex];
    if (!b) return NaN;
    if (operand === 'open') return b.open ?? NaN;
    if (operand === 'high') return b.high;
    if (operand === 'low') return b.low;
    if (operand === 'close') return b.close;
    if (operand === 'volume') return b.volume ?? NaN;
    return NaN;
  }
}

/** A boolean predicate over the signal context, tagged with the column refs it reads. */
export interface Condition {
  (context: SignalContext, barIndex: number): boolean;
  /** String operands (column aliases, dotted sub-fields, raw fields) this condition reads. */
  readonly refs: readonly string[];
}

const ok = (x: number): boolean => Number.isFinite(x);

/** Tag a predicate with the string operands it reads, so the builder can validate them up front. */
function cond(
  operands: Operand[],
  predicate: (context: SignalContext, barIndex: number) => boolean,
): Condition {
  const refs = operands.filter((o): o is string => typeof o === 'string');
  return Object.assign(predicate, { refs }) as Condition;
}

/**
 * Build a custom condition. `refs` are the column aliases / `alias.field` / raw OHLCV fields the
 * predicate reads via `context.get(...)` — they are validated up front like the built-in conditions, so
 * a typo fails loud. Pass `[]` for a condition that reads nothing (or reads only constants).
 */
export function condition(
  refs: readonly string[],
  predicate: (context: SignalContext, barIndex: number) => boolean,
): Condition {
  requireArgumentArray('condition', 'refs', refs);
  if (typeof predicate !== 'function') {
    throw new InputError(
      `condition: predicate must be a (context, barIndex) => boolean function, got ${
        predicate === null ? 'null' : typeof predicate
      }.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  return Object.assign(predicate, { refs: [...refs] }) as Condition;
}

export function crossOver(first: Operand, second: Operand): Condition {
  return cond([first, second], (context, i) => {
    if (i < 1) return false;
    const a0 = context.get(first, i - 1);
    const a1 = context.get(first, i);
    const b0 = context.get(second, i - 1);
    const b1 = context.get(second, i);
    return ok(a0) && ok(a1) && ok(b0) && ok(b1) && a0 <= b0 && a1 > b1;
  });
}
export function crossUnder(first: Operand, second: Operand): Condition {
  return cond([first, second], (context, i) => {
    if (i < 1) return false;
    const a0 = context.get(first, i - 1);
    const a1 = context.get(first, i);
    const b0 = context.get(second, i - 1);
    const b1 = context.get(second, i);
    return ok(a0) && ok(a1) && ok(b0) && ok(b1) && a0 >= b0 && a1 < b1;
  });
}
export function gt(left: Operand, right: Operand): Condition {
  return cond([left, right], (context, i) => {
    const x = context.get(left, i);
    const y = context.get(right, i);
    return ok(x) && ok(y) && x > y;
  });
}
export function lt(left: Operand, right: Operand): Condition {
  return cond([left, right], (context, i) => {
    const x = context.get(left, i);
    const y = context.get(right, i);
    return ok(x) && ok(y) && x < y;
  });
}
export function gte(left: Operand, right: Operand): Condition {
  return cond([left, right], (context, i) => {
    const x = context.get(left, i);
    const y = context.get(right, i);
    return ok(x) && ok(y) && x >= y;
  });
}
export function lte(left: Operand, right: Operand): Condition {
  return cond([left, right], (context, i) => {
    const x = context.get(left, i);
    const y = context.get(right, i);
    return ok(x) && ok(y) && x <= y;
  });
}
export function rising(operand: Operand): Condition {
  return cond([operand], (context, i) => {
    if (i < 1) return false;
    const x0 = context.get(operand, i - 1);
    const x1 = context.get(operand, i);
    return ok(x0) && ok(x1) && x1 > x0;
  });
}
export function falling(operand: Operand): Condition {
  return cond([operand], (context, i) => {
    if (i < 1) return false;
    const x0 = context.get(operand, i - 1);
    const x1 = context.get(operand, i);
    return ok(x0) && ok(x1) && x1 < x0;
  });
}
export function between(operand: Operand, low: number, high: number): Condition {
  return cond([operand], (context, i) => {
    const x = context.get(operand, i);
    return ok(x) && x >= low && x <= high;
  });
}
/** Logical negation of a condition (carries through the inner condition's refs). */
export function not(condition: Condition): Condition {
  if (typeof condition !== 'function' || !Array.isArray((condition as { refs?: unknown }).refs)) {
    throw new InputError(
      `not: condition must be a Condition (built with condition()/gt()/lt()/…), got ${
        condition === null ? 'null' : typeof condition
      }.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  return cond([...condition.refs], (context, i) => !condition(context, i));
}

/** One condition inside a rule, with the operator joining it to the PREVIOUS term. */
export interface Term {
  condition: Condition;
  operator: 'and' | 'or';
}
/** A labeled and/or-combination of conditions — the unit {@link SignalBuilder#addRule} accepts. */
export interface Rule {
  terms: Term[];
  label: string;
}

export interface SignalEvent {
  index: number;
  label: string;
}

/**
 * Builds one rule as a chain of conditions. Evaluation is STRICT LEFT-TO-RIGHT with NO operator
 * precedence: each `.and(c)` / `.or(c)` folds `c` into the accumulated result immediately, so
 * `when(a).or(b).and(c)` evaluates as `(a || b) && c` — NOT `a || (b && c)`. When you need
 * grouping, compose a single condition instead (e.g. with `condition()` / `not()`), or order the
 * chain so left-to-right folding expresses your intent.
 */
export class RuleBuilder {
  private readonly terms: Term[];
  private readonly owner: SignalBuilder;
  constructor({ owner, first }: { owner: SignalBuilder; first: Condition }) {
    this.owner = owner;

    this.terms = [{ condition: first, operator: 'and' }];
  }
  /** Fold `c` into the accumulated result with AND (left-to-right, no precedence — class doc). */
  and(condition: Condition): this {
    this.terms.push({ condition: condition, operator: 'and' });
    return this;
  }
  /** Fold `c` into the accumulated result with OR (left-to-right, no precedence — class doc). */
  or(condition: Condition): this {
    this.terms.push({ condition: condition, operator: 'or' });
    return this;
  }
  /** Finalise the rule with a label and return to the signal builder. */
  emit(label: string): SignalBuilder {
    this.owner.addRule({ terms: [...this.terms], label });
    return this.owner;
  }
}

interface AliasOpt {
  as?: string;
}

export class SignalBuilder {
  private readonly pipe: FeaturePipeline;
  private readonly rules: Rule[] = [];
  constructor(private readonly candles: BarInput[]) {
    this.pipe = new FeaturePipeline(candles);
  }

  // feature methods (build named columns) — parameter OBJECTS, matching the indicators themselves
  sma(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    this.pipe.sma(field, parameters, options);
    return this;
  }
  ema(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    this.pipe.ema(field, parameters, options);
    return this;
  }
  wma(field: Field, parameters: PeriodParameters, options?: AliasOpt): this {
    this.pipe.wma(field, parameters, options);
    return this;
  }
  /**
   * `parameters` is optional on the default-bearing methods, matching both `FeaturePipeline` and the
   * direct call: `rsi(closes)` resolves period 14, so `signal(bars).rsi('close')` must too.
   *
   * These two were left required when the pipeline's were relaxed, so the two fluent surfaces
   * disagreed — the delegate compiled and the caller's identical call did not.
   */
  rsi(field: Field, parameters?: RsiParameters, options?: AliasOpt): this {
    this.pipe.rsi(field, parameters, options);
    return this;
  }
  atr(parameters?: WilderPeriodParameters, options?: AliasOpt): this {
    this.pipe.atr(parameters, options);
    return this;
  }
  /**
   * Apply any series indicator to a field under an alias. `options.as` is REQUIRED here: the generic
   * escape hatch has no indicator-specific auto-name to fall back on.
   */
  use<P, Out>(
    field: Field,
    indicator: Indicator<P, number, Out>,
    parameters: P,
    options: Required<AliasOpt>,
  ): this {
    this.pipe.applySeries(field, indicator, parameters, options);
    return this;
  }
  /** Apply any bar indicator to the candles under an alias. `options.as` is required (see {@link use}). */
  useBars<P, Out>(
    indicator: Indicator<P, BarInput, Out>,
    parameters: P,
    options: Required<AliasOpt>,
  ): this {
    this.pipe.applyBars(indicator, parameters, options);
    return this;
  }
  /** Inject a precomputed column. */
  feature(alias: string, values: unknown[]): this {
    this.pipe.column(alias, values);
    return this;
  }

  when(condition: Condition): RuleBuilder {
    return new RuleBuilder({ owner: this, first: condition });
  }
  addRule(rule: Rule): void {
    // Rules also arrive hand-built (not just via `when(...)`), so the boundary teaches: a rule
    // missing its label or terms used to be accepted and surface later as a nonsense signal.
    requireArgumentObject('SignalBuilder.addRule', 'rule', rule);
    ensureKnownKeys('SignalBuilder.addRule', 'rule', rule, ['terms', 'label']);
    if (typeof rule.label !== 'string' || rule.label.length === 0) {
      throw new InputError(
        `SignalBuilder.addRule: rule.label must be a non-empty string naming the signal. Received ${rule.label === null ? 'null' : typeof rule.label === 'string' ? 'an empty string' : typeof rule.label}.`,
        { code: ErrorCode.InputWrongType, context: { label: rule.label } },
      );
    }
    requireArgumentArray('SignalBuilder.addRule', 'rule.terms', rule.terms);
    for (const [index, term] of rule.terms.entries()) {
      // A Condition is a tagged PREDICATE (a function carrying `refs`), not a plain object.
      if (
        term === null ||
        typeof term !== 'object' ||
        (term.operator !== 'and' && term.operator !== 'or') ||
        typeof term.condition !== 'function'
      ) {
        throw new InputError(
          `SignalBuilder.addRule: rule.terms[${index}] must be { cond, operator: 'and' | 'or' } — build terms with when(...).and(...) or the Condition helpers.`,
          { code: ErrorCode.InputWrongType, context: { index, term } },
        );
      }
    }
    this.rules.push(rule);
  }

  private context(): SignalContext {
    return new SignalContext({
      cols: new Map(Object.entries(this.pipe.toColumns())),
      candles: this.candles,
    });
  }

  /** A reference is valid if it is a raw OHLCV field, a known column, or `alias.field` of a record column. */
  private isKnownRef(ref: string, cols: Map<string, unknown[]>): boolean {
    if (RAW_FIELDS.has(ref)) return true;
    if (ref.includes('.')) {
      const dot = ref.indexOf('.');
      const alias = ref.slice(0, dot);
      const f = ref.slice(dot + 1);
      const col = cols.get(alias);
      if (!col) return false;
      const firstDefined = col.find((v) => v !== null && v !== undefined);
      if (firstDefined === undefined) return true; // empty / all-warmup column — cannot verify the field
      if (typeof firstDefined !== 'object') return false; // scalar column: dotted access is invalid
      return f in (firstDefined as object);
    }
    return cols.has(ref);
  }

  /** Fail fast on misspelled aliases/sub-fields instead of silently evaluating them to `false`. */
  private validateRefs(cols: Map<string, unknown[]>): void {
    for (const rule of this.rules) {
      for (const term of rule.terms) {
        for (const ref of term.condition.refs) {
          if (!this.isKnownRef(ref, cols)) {
            throw new InputError(
              `signal: unknown reference "${ref}". Define it with a feature method / { as } alias, or use a raw OHLCV field.`,
              {
                code: ErrorCode.SignalUnknownReference,
                context: { reference: ref, label: rule.label },
              },
            );
          }
        }
      }
    }
  }

  private evalRule(rule: Rule, context: SignalContext, i: number): boolean {
    let result = rule.terms[0]!.condition(context, i);
    for (let k = 1; k < rule.terms.length; k++) {
      const t = rule.terms[k]!;
      result =
        t.operator === 'and'
          ? result && t.condition(context, i)
          : result || t.condition(context, i);
    }
    return result;
  }

  /** Aligned labels: the first matching rule's label per bar, else `null`. */
  signals(): (string | null)[] {
    const context = this.context();
    this.validateRefs(new Map(Object.entries(this.pipe.toColumns())));
    const out = new Array<string | null>(this.candles.length).fill(null);
    for (let i = 0; i < this.candles.length; i++) {
      for (const rule of this.rules) {
        if (this.evalRule(rule, context, i)) {
          out[i] = rule.label;
          break;
        }
      }
    }
    return out;
  }

  /** Only the bars that emitted, as `{ index, label }` events. */
  events(): SignalEvent[] {
    return this.signals()
      .map((label, index) => ({ index, label }))
      .filter((e): e is SignalEvent => e.label !== null);
  }

  /** The underlying feature columns (for inspection / charting). */
  columns(): Record<string, unknown[]> {
    return this.pipe.toColumns();
  }
}

export function signal(candles: BarInput[]): SignalBuilder {
  return new SignalBuilder(candles);
}
