/** Element-wise math transforms/operators (TA-Lib Math Transform/Operators; pandas-ta math). */

import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import type { Pair } from './statistics.js';
import { requireStreamParameters } from './stream-validation.js';

type Empty = Record<never, never>;

class UnaryMathStream implements IndicatorStream<number, number> {
  value: number | null = null;
  private readonly kind: string;
  private readonly transform: (x: number) => number;
  constructor(parameters: { kind: string; transform: (x: number) => number }) {
    requireStreamParameters('UnaryMathStream.constructor#0', 'UnaryMathStream', parameters);
    const { kind, transform } = parameters;
    this.kind = kind;
    this.transform = transform;
  }
  next(value: number): number | null {
    this.value = this.transform(value);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { value: this.value });
  }
  static restore(kind: string, operation: (x: number) => number) {
    return (s: TechnicalAnalysisSnapshot): UnaryMathStream => {
      const state = readSnapshot(s, kind);
      const x = new UnaryMathStream({ kind, transform: operation });
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

const unary = (kind: string, fn: (x: number) => number) =>
  makeIndicator<Empty, number, number>(
    () => new UnaryMathStream({ kind, transform: fn }),
    UnaryMathStream.restore(kind, fn),
    () => NaN,
  );

class BinaryMathStream implements IndicatorStream<Pair, number> {
  value: number | null = null;
  private readonly kind: string;
  private readonly combine: (x: number, y: number) => number;
  constructor(parameters: { kind: string; combine: (x: number, y: number) => number }) {
    requireStreamParameters('BinaryMathStream.constructor#0', 'BinaryMathStream', parameters);
    const { kind, combine } = parameters;
    this.kind = kind;
    this.combine = combine;
  }
  next(pair: Pair): number | null {
    this.value = this.combine(pair.x, pair.y);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { value: this.value });
  }
  static restore(kind: string, operation: (x: number, y: number) => number) {
    return (s: TechnicalAnalysisSnapshot): BinaryMathStream => {
      const state = readSnapshot(s, kind);
      const x = new BinaryMathStream({ kind, combine: operation });
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

const binary = (kind: string, fn: (x: number, y: number) => number) =>
  makeIndicator<Empty, Pair, number>(
    () => new BinaryMathStream({ kind, combine: fn }),
    BinaryMathStream.restore(kind, fn),
    () => NaN,
  );

export const acos = unary('acos', Math.acos);
export const asin = unary('asin', Math.asin);
export const atan = unary('atan', Math.atan);
export const ceil = unary('ceil', Math.ceil);
export const cos = unary('cos', Math.cos);
export const cosh = unary('cosh', Math.cosh);
export const exp = unary('exp', Math.exp);
export const floor = unary('floor', Math.floor);
export const ln = unary('ln', Math.log);
export const log10 = unary('log10', Math.log10);
export const sin = unary('sin', Math.sin);
export const sinh = unary('sinh', Math.sinh);
export const sqrt = unary('sqrt', Math.sqrt);
export const tan = unary('tan', Math.tan);
export const tanh = unary('tanh', Math.tanh);

export const add = binary('add', (x, y) => x + y);
export const sub = binary('sub', (x, y) => x - y);
export const mult = binary('mult', (x, y) => x * y);
export const div = binary('div', (x, y) => x / y);

/** The cross family: one class, two public indicators, so the restorer guards the pair. */
const CROSS_PAIR_KINDS = ['crossover', 'crossany'] as const;
type CrossPairKind = (typeof CROSS_PAIR_KINDS)[number];

class CrossPairStream implements IndicatorStream<Pair, number> {
  private prev: Pair | null = null;
  value: number | null = null;
  private readonly kind: CrossPairKind;
  private readonly mode: 'over' | 'any';
  constructor(parameters: { kind: CrossPairKind; mode: 'over' | 'any' }) {
    requireStreamParameters('CrossPairStream.constructor#0', 'CrossPairStream', parameters);
    const { kind, mode } = parameters;
    this.kind = kind;
    this.mode = mode;
  }
  next(pair: Pair): number | null {
    if (this.prev === null) {
      this.prev = { ...pair };
      this.value = 0;
      return this.value;
    }
    const over = this.prev.x <= this.prev.y && pair.x > pair.y;
    const under = this.prev.x >= this.prev.y && pair.x < pair.y;
    this.prev = { ...pair };
    this.value = this.mode === 'over' ? (over ? 1 : 0) : over || under ? 1 : 0;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { mode: this.mode, prev: this.prev, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CrossPairStream {
    const state = readSnapshot(snapshot, CROSS_PAIR_KINDS);
    const x = new CrossPairStream({
      kind: state.kind,
      mode: state.literal('mode', ['over', 'any'] as const),
    });
    const prev = state.recordOrNull<Pair>('prev');
    x.prev = prev === null ? null : { ...prev };
    x.value = state.cached<number>('value');
    return x;
  }
}

/** 1 on the bar where `x` crosses above `y`, else 0. */
export const crossover = makeIndicator<Empty, Pair, number>(
  () => new CrossPairStream({ kind: 'crossover', mode: 'over' }),
  CrossPairStream.fromJSON,
  () => NaN,
);

/** 1 on the bar where `x` crosses either above or below `y`, else 0. */
export const crossany = makeIndicator<Empty, Pair, number>(
  () => new CrossPairStream({ kind: 'crossany', mode: 'any' }),
  CrossPairStream.fromJSON,
  () => NaN,
);

export { UnaryMathStream, BinaryMathStream, CrossPairStream };
