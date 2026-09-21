/**
 * The snapshot envelope contract, measured across EVERY registered indicator (3B.1).
 *
 * Phase 3B.0 measured all 134 public restorers and found the same four holes in each: an envelope
 * with an undeclared key restored; an envelope with no `kind`, or a `kind` of the wrong type,
 * restored; an envelope whose `kind` named a DIFFERENT indicator restored — seeding one indicator
 * with another's numbers — and `NaN` in any state field restored, then propagated forever.
 *
 * A fix demonstrated on one indicator proves nothing about the other 133, and a hand-picked sample is
 * how the original defect survived review. So this drives the REGISTRY: every indicator is built,
 * fed real data past its warmup, serialized, and then each mutation is applied to its own snapshot.
 * The positive control runs first — an unmutated snapshot must restore and continue producing
 * identical output — because a guard that rejects everything would pass every rejection test.
 *
 * `snapshot-integrity` covers restore-twice independence and `snapshot-versioning` covers the schema
 * version; this file covers the ENVELOPE and the fields inside it.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { listIndicators } from '@totalfinance/technical-analysis/registry';
import { indicatorWarmups } from '@totalfinance/technical-analysis/warmup';
import { pairs } from '@totalfinance/technical-analysis/statistics';
import {
  SCHEMA_VERSION,
  readSnapshot,
  type BarInput,
  type Indicator,
  type TechnicalAnalysisSnapshot,
} from '@totalfinance/technical-analysis';

type AnyInd = Indicator<Record<string, unknown>, unknown, unknown>;

const LENGTH = 260;
const series = Array.from(
  { length: LENGTH },
  (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1),
);
const bars: BarInput[] = series.map((close, i) => {
  const open = i === 0 ? close : series[i - 1]!;
  return {
    open,
    high: Math.max(open, close) + 1 + (i % 3) * 0.5,
    low: Math.min(open, close) - 1 - (i % 4) * 0.3,
    close,
    volume: 1000 + ((i * 53) % 400),
  };
});
const pair = pairs(
  series,
  series.map((v, i) => v + Math.cos(i / 4) * 3),
);
/** A degenerate-but-valid series: every log-return is NaN, which is the case the encoding exists for. */
const zeros = Array.from({ length: LENGTH }, () => 0);
const zeroBars: BarInput[] = zeros.map((c) => ({ open: c, high: c, low: c, close: c, volume: 0 }));
const zeroPair = pairs(zeros, zeros);

const parametersByName = new Map(indicatorWarmups(280).map((w) => [w.name, w.parameters]));
const registered = listIndicators();

const inputFor = (kind: string, degenerate: boolean): readonly unknown[] =>
  kind === 'series'
    ? degenerate
      ? zeros
      : series
    : kind === 'bars'
      ? degenerate
        ? zeroBars
        : bars
      : degenerate
        ? zeroPair
        : pair;

/** Build, drive most of the way through the data, and serialize. */
function snapshotOfIndicator(
  entry: (typeof registered)[number],
  degenerate = false,
): {
  snapshot: TechnicalAnalysisSnapshot;
  rest: readonly unknown[];
  live: ReturnType<AnyInd['stream']>;
} {
  const indicator = entry.indicator as AnyInd;
  const input = inputFor(entry.inputs, degenerate);
  const cut = Math.floor(input.length * 0.8);
  const live = indicator.stream(parametersByName.get(entry.name));
  for (let i = 0; i < cut; i++) live.next(input[i]);
  return { snapshot: live.toJSON(), rest: input.slice(cut), live };
}

/** NaN-aware deep equality — indicator outputs carry NaN sentinels by contract. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = Object.keys(a as object);
    const right = Object.keys(b as object);
    if (left.length !== right.length) return false;
    return left.every((k) =>
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

const clone = (snapshot: TechnicalAnalysisSnapshot): TechnicalAnalysisSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as TechnicalAnalysisSnapshot;

/** The first top-level state key holding a plain number — the slot a mutation can convict on. */
function numericField(snapshot: TechnicalAnalysisSnapshot): string | undefined {
  return Object.keys(snapshot.state).find(
    (key) => typeof snapshot.state[key] === 'number' && key !== 'value',
  );
}

/**
 * These five properties are asserted ACROSS the registry, not once per indicator.
 *
 * The first version spelled one `it()` per indicator per property — 1,675 test cases from one file,
 * every one of them a reporter round-trip, and enough traffic on a loaded machine to time out the
 * runner's RPC channel while every assertion passed. The coverage is identical either way; what
 * changes is that a failure now prints the LIST of indicators that broke the property instead of
 * stopping at the first, which is the more useful report anyway.
 */
const offenders = (test: (entry: (typeof registered)[number]) => string | null): string[] =>
  registered.flatMap((entry) => {
    const failure = test(entry);
    return failure === null ? [] : [`${entry.name}: ${failure}`];
  });

const rejects = (
  entry: (typeof registered)[number],
  snapshot: TechnicalAnalysisSnapshot,
): boolean => {
  try {
    (entry.indicator as AnyInd).fromJSON(snapshot);
    return false;
  } catch {
    return true;
  }
};

describe('every registered indicator, across the whole registry', () => {
  it('positive control: an untouched snapshot restores and continues identically', () => {
    const broken = offenders((entry) => {
      const { snapshot, rest, live } = snapshotOfIndicator(entry);
      const restored = (entry.indicator as AnyInd).fromJSON(clone(snapshot));
      for (const next of rest)
        if (!same(restored.next(next), live.next(next))) return 'restored stream diverged';
      return null;
    });
    expect(
      broken,
      `a restored stream stopped matching the live one:\n${broken.join('\n')}`,
    ).toEqual([]);
  });

  it('the envelope is CLOSED — an undeclared key is a caller error, not noise', () => {
    const broken = offenders((entry) => {
      const { snapshot } = snapshotOfIndicator(entry);
      const mutated = { ...clone(snapshot), qzxBogusKey: 1 } as TechnicalAnalysisSnapshot;
      return rejects(entry, mutated) ? null : 'accepted an undeclared envelope key';
    });
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('the envelope carries an IDENTITY, and every restorer checks it', () => {
    const broken = offenders((entry) => {
      const { snapshot } = snapshotOfIndicator(entry);

      const anonymous = clone(snapshot) as Partial<TechnicalAnalysisSnapshot>;
      delete anonymous.kind;
      if (!rejects(entry, anonymous as TechnicalAnalysisSnapshot)) return 'restored with no kind';

      const wrongType = { ...clone(snapshot), kind: 42 } as unknown as TechnicalAnalysisSnapshot;
      if (!rejects(entry, wrongType)) return 'restored a numeric kind';

      const foreign = { ...clone(snapshot), kind: 'qzxNotAnIndicator' };
      if (!rejects(entry, foreign)) return 'restored a foreign kind';
      return null;
    });
    expect(
      broken,
      `an indicator restored a snapshot that is not its own:\n${broken.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Two mutations, and only two, because only these are wrong for EVERY numeric slot whatever the
   * field means: a raw non-finite (which `snapshotOf` can no longer write) and a string. `null` is
   * deliberately not asserted — plenty of running values are `number | null` by contract. A missing
   * field is asserted only for `period`, which no indicator treats as optional.
   */
  it('state fields are read, not assumed', () => {
    const broken = offenders((entry) => {
      const { snapshot } = snapshotOfIndicator(entry);
      const field = numericField(snapshot);
      if (field !== undefined) {
        for (const [label, bad] of [
          ['a raw NaN', Number.NaN],
          ['a string', 'not-a-number'],
        ] as const) {
          const mutated = clone(snapshot);
          mutated.state[field] = bad;
          if (!rejects(entry, mutated)) return `accepted ${label} in state.${field}`;
        }
      }
      if (typeof snapshot.state['period'] === 'number') {
        const missing = clone(snapshot);
        delete missing.state['period'];
        if (!rejects(entry, missing)) return 'accepted a snapshot with no period';
      }
      return null;
    });
    expect(broken, broken.join('\n')).toEqual([]);
  });

  /**
   * The bug this proves gone: `JSON.stringify(NaN)` is `null`, and a zero price series makes every
   * log-return NaN. Before the encoding, persisting `realizedVolatility` mid-stream and restoring it
   * replaced a NaN-filled window with nulls, which then read as zero in the next arithmetic.
   */
  it('a snapshot survives REAL JSON, including the values JSON cannot represent', () => {
    const broken = offenders((entry) => {
      const { snapshot, rest, live } = snapshotOfIndicator(entry, true);
      const restored = (entry.indicator as AnyInd).fromJSON(
        JSON.parse(JSON.stringify(snapshot)) as TechnicalAnalysisSnapshot,
      );
      if (!same(restored.toJSON(), snapshot)) return 'lost state through JSON';
      for (const next of rest)
        if (!same(restored.next(next), live.next(next))) return 'diverged after a JSON round-trip';
      return null;
    });
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('no serialized state contains a raw non-finite number, for any indicator', () => {
    const bad: string[] = [];
    const scan = (value: unknown, path: string, depth = 0): void => {
      if (depth > 8) return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) bad.push(path);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((element, i) => scan(element, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [key, member] of Object.entries(value as Record<string, unknown>))
        scan(member, `${path}.${key}`, depth + 1);
    };
    for (const entry of registered) {
      const { snapshot } = snapshotOfIndicator(entry, true);
      scan(snapshot.state, `${entry.name}.state`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it('covers the whole catalog rather than a sample', () => {
    expect(registered.length).toBeGreaterThan(300);
  });
});

describe('readSnapshot: the door itself', () => {
  const envelope = (state: Record<string, unknown> = {}): TechnicalAnalysisSnapshot => ({
    kind: 'atr',
    schemaVersion: SCHEMA_VERSION,
    state,
  });

  it('rejects a non-envelope', () => {
    for (const bad of [null, undefined, 42, 'atr', []]) {
      expect(() => readSnapshot(bad as unknown as TechnicalAnalysisSnapshot, 'atr')).toThrow();
    }
  });

  it('diagnoses a PRE-ENVELOPE (flat) snapshot as such, not as a misspelled field', () => {
    const flat = { kind: 'atr', period: 14, count: 3 } as unknown as TechnicalAnalysisSnapshot;
    expect(() => readSnapshot(flat, 'atr')).toThrowError(/pre-envelope/);
  });

  it('rejects an undeclared envelope key with a did-you-mean', () => {
    const typo = { ...envelope(), schemaversion: 3 } as unknown as TechnicalAnalysisSnapshot;
    expect(() => readSnapshot(typo, 'atr')).toThrowError(/unknown field/);
  });

  it('accepts a FAMILY, and still refuses a non-member', () => {
    const family = ['standardDeviation', 'variance'] as const;
    const state = readSnapshot({ ...envelope(), kind: 'variance' }, family);
    expect(state.kind).toBe('variance');
    expect(() => readSnapshot({ ...envelope(), kind: 'skew' }, family)).toThrowError(/kind/);
  });

  it('number: accepts finite and the encoded non-finite', () => {
    const state = readSnapshot(
      envelope({ a: 1.5, b: { nonFinite: 'NaN' }, c: { nonFinite: '-Infinity' } }),
      'atr',
    );
    expect(state.number('a')).toBe(1.5);
    expect(Number.isNaN(state.number('b'))).toBe(true);
    expect(state.number('c')).toBe(Number.NEGATIVE_INFINITY);
    expect(() => state.number('missing')).toThrowError(/required/);
  });

  it('a RAW non-finite is refused at the door, before any accessor asks for it', () => {
    // The point of doing this in `readSnapshot`: the field nobody reads is checked too.
    expect(() => readSnapshot(envelope({ neverRead: Number.NaN }), 'atr')).toThrowError(/raw NaN/);
    expect(() =>
      readSnapshot(envelope({ nested: { deep: [1, Number.POSITIVE_INFINITY] } }), 'atr'),
    ).toThrowError(/nested\.deep\[1\]/);
  });

  it('lookback: a period must still be a period', () => {
    const state = readSnapshot(envelope({ ok: 14, zero: 0, negative: -3, fractional: 2.5 }), 'atr');
    expect(state.lookback('ok')).toBe(14);
    for (const bad of ['zero', 'negative', 'fractional'])
      expect(() => state.lookback(bad), bad).toThrowError(/lookback/);
  });

  it('numbers: returns a FRESH array so two restores never share a buffer', () => {
    const source = [1, 2, 3];
    const state = readSnapshot(envelope({ buffer: source }), 'atr');
    const first = state.numbers('buffer');
    const second = state.numbers('buffer');
    first[0] = 99;
    expect(second[0]).toBe(1);
    expect(source[0]).toBe(1);
  });

  it('numbers: refuses a non-numeric element and names its index', () => {
    const state = readSnapshot(envelope({ buffer: [1, 'two', 3] }), 'atr');
    expect(() => state.numbers('buffer')).toThrowError(/buffer\[1\]/);
  });

  it('literal: a closed set is closed', () => {
    const state = readSnapshot(envelope({ mode: 'run', bogus: 'nope' }), 'atr');
    expect(state.literal('mode', ['imbalance', 'run'] as const)).toBe('run');
    expect(() => state.literal('bogus', ['imbalance', 'run'] as const)).toThrowError(
      /must be one of/,
    );
  });

  /**
   * A review found the hole these close, and it was in the GUARANTEE rather than the plumbing:
   * "a raw non-finite anywhere in state is refused" was published while the walk skipped anything
   * that merely LOOKED like a nested envelope — a string `kind` and a numeric `schemaVersion` were
   * enough, and ordinary state records wear that shape by coincidence.
   */
  it('a state record that merely resembles an envelope is still walked', () => {
    const lookalike = envelope({
      // Not an envelope: it carries the two recognisable keys AND other members.
      bar: { kind: 'engulfing', schemaVersion: 2, high: Number.NaN, low: 1 },
    });
    expect(() => readSnapshot(lookalike, 'atr')).toThrowError(/raw NaN/);
  });

  it('an object with the envelope header but no `state` is not mistaken for one', () => {
    const headerOnly = envelope({
      child: { kind: 'ema', schemaVersion: SCHEMA_VERSION, sum: Number.NaN },
    });
    expect(() => readSnapshot(headerOnly, 'atr')).toThrowError(/raw NaN/);
  });

  it('a REAL nested envelope is still left for its own reader', () => {
    // The child keeps its encoded value: the parent must not walk it, or a composed indicator pays
    // the walk once per level and any error names the wrong indicator.
    const parent = envelope({
      fast: { kind: 'ema', schemaVersion: SCHEMA_VERSION, state: { value: { nonFinite: 'NaN' } } },
    });
    const state = readSnapshot(parent, 'atr');
    const child = state.child('fast');
    expect(child.kind).toBe('ema');
    expect(Number.isNaN(readSnapshot(child, 'ema').number('value'))).toBe(true);
  });

  it('cached: absent reads as null, and an encoded non-finite inside survives', () => {
    const state = readSnapshot(
      envelope({ absent: null, point: { top: { nonFinite: 'NaN' }, bottom: 3 } }),
      'atr',
    );
    expect(state.cached('neverWritten')).toBeNull();
    expect(state.cached('absent')).toBeNull();
    const point = state.cached<{ top: number; bottom: number }>('point')!;
    expect(Number.isNaN(point.top)).toBe(true);
    expect(point.bottom).toBe(3);
  });

  it('child: a nested envelope must be an object, and its own kind is checked by its own restorer', () => {
    const state = readSnapshot(envelope({ inner: envelope(), broken: 7 }), 'atr');
    expect(state.child('inner').kind).toBe('atr');
    expect(() => state.child('broken')).toThrowError(/nested snapshot/);
  });

  it('the error names the field and carries it in context for a programmatic consumer', () => {
    const state = readSnapshot(envelope({ trSum: 'oops' }), 'atr');
    let caught: unknown;
    try {
      state.number('trSum');
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    expect((caught as { message: string }).message).toContain('trSum');
    expect((caught as { context: Record<string, unknown> }).context['field']).toBe('trSum');
    expect((caught as { context: Record<string, unknown> }).context['kind']).toBe('atr');
  });
});
