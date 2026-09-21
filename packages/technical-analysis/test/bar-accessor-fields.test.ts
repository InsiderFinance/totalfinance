/**
 * The `bar.*` single-bar accessors (3B.1b silent-miscompute cluster).
 *
 * Each accessor read the OHLC fields it needed straight off the object after only a container check,
 * so `bar.range({ high: 10 })` returned `NaN` — a range, of a bar, that is not a number. These feed
 * candlestick and price-action logic, where a `NaN` becomes a comparison that is silently false and
 * a pattern that silently never matches.
 *
 * The per-accessor field lists are the point: `bar.range` needs `high`/`low` and nothing else, so
 * requiring a full OHLC everywhere would reject bars that are perfectly valid for the call being
 * made. `open` is required by NO accessor — every helper reads `bar.open ?? bar.close`, which is a
 * documented shape, not an oversight — but it is type-checked when present, because a present-but-
 * garbage `open` wins over that fallback.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { bar } from '@totalfinance/technical-analysis';

const BAR = { open: 100, high: 101.5, low: 99.5, close: 100.8 } as const;

function codeOf(call: () => unknown): string {
  try {
    return `NO THROW — returned ${String(call())}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

/** Accessor → the fields it genuinely consumes, mirroring the implementations. */
const CONSUMES: Array<[keyof typeof bar, readonly string[]]> = [
  ['typical', ['high', 'low', 'close']],
  ['median', ['high', 'low']],
  ['weighted', ['high', 'low', 'close']],
  ['average', ['high', 'low', 'close']],
  ['body', ['close']],
  ['upperShadow', ['high', 'close']],
  ['lowerShadow', ['low', 'close']],
  ['range', ['high', 'low']],
];

describe('bar accessors require the fields they read', () => {
  it('the controls all compute', () => {
    expect(bar.typical(BAR)).toBeCloseTo((101.5 + 99.5 + 100.8) / 3, 10);
    expect(bar.range(BAR)).toBeCloseTo(2, 10);
    expect(bar.body(BAR)).toBeCloseTo(0.8, 10);
    expect(bar.trueRange(BAR, 100)).toBeCloseTo(2, 10);
  });

  for (const [name, fields] of CONSUMES) {
    it(`bar.${name} refuses a bar missing any of ${fields.join('/')}`, () => {
      for (const field of fields) {
        const input: Record<string, unknown> = { ...BAR };
        delete input[field];
        expect(codeOf(() => (bar[name] as (b: unknown) => number)(input))).toBe(
          'input.missing_field',
        );
      }
    });
  }

  it('`open` is never required — the helpers fall back to `close`', () => {
    const noOpen: Record<string, unknown> = { ...BAR };
    delete noOpen['open'];
    for (const [name] of CONSUMES) {
      const result = (bar[name] as (b: unknown) => number)(noOpen);
      expect(Number.isFinite(result), `bar.${name} on a bar with no open`).toBe(true);
    }
  });

  /**
   * An optional field runs the SAME ladder as a required one. This test previously asserted
   * `input.not_finite` for a string — true of `Number.isFinite('100')`, and a direct contradiction of
   * the library's own matrix, which says a string in a numeric field is `wrong_type`. The test was
   * codifying the bug, so fixing the taxonomy meant fixing the assertion too.
   */
  it('...but a present `open` of the wrong type is refused, since it wins over the fallback', () => {
    expect(codeOf(() => bar.body({ ...BAR, open: Number.NaN }))).toBe('input.nan');
    expect(codeOf(() => bar.body({ ...BAR, open: '100' } as never))).toBe('input.wrong_type');
    expect(codeOf(() => bar.body({ ...BAR, open: Number.POSITIVE_INFINITY }))).toBe(
      'input.not_finite',
    );
  });

  it('trueRange validates its positional previousClose, not just the bar', () => {
    // Omitted, every comparison against `undefined` was false and it returned `high - low` — a plain
    // range wearing the name of a true range. Silently the wrong indicator, not a crash.
    expect(codeOf(() => (bar.trueRange as (b: unknown) => number)(BAR))).toBe('input.not_finite');
    expect(codeOf(() => bar.trueRange(BAR, Number.NaN))).toBe('input.nan');
  });

  it('a non-object bar is still refused first', () => {
    expect(codeOf(() => (bar.range as (b: unknown) => number)(undefined))).toBe('input.wrong_type');
  });

  it('no accessor returns a non-finite value for any single-field omission', () => {
    const offenders: string[] = [];
    for (const [name] of CONSUMES) {
      for (const field of ['high', 'low', 'close']) {
        const input: Record<string, unknown> = { ...BAR };
        delete input[field];
        const result = codeOf(() => (bar[name] as (b: unknown) => number)(input));
        if (result.startsWith('NO THROW') && result.includes('NaN'))
          offenders.push(`bar.${name} without ${field}: ${result}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
