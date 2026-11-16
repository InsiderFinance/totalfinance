import { expect, it } from 'vitest';
import { ensureKnownKeys } from '../src/invariants.js';
import { QuantError, ErrorCode } from '../src/errors.js';

// Independent matrix reference from the previous implementation; the compact search is bounded
// by edit count instead. Distances above two must produce no suggestion, and ties keep list order.
function reference(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + cost);
    }
  return d[a.length]![b.length]!;
}
function suggestion(key: string, allowed: string[]): unknown {
  try {
    ensureKnownKeys('probe', 'input', { [key]: 1 }, allowed);
  } catch (e) {
    expect(e).toBeInstanceOf(QuantError);
    expect((e as QuantError).code).toBe(ErrorCode.InputUnknownField);
    return (e as QuantError).context?.['suggestion'];
  }
  throw new Error('Fixture unexpectedly declared the supplied key.');
}
it('preserves zero/one/two-edit and transposition hints against an independent matrix corpus', () => {
  const words = [''];
  let level = [''];
  for (let n = 0; n < 4; n++) {
    level = level.flatMap((w) => ['a', 'b', 'c'].map((c) => w + c));
    words.push(...level);
  }
  for (const key of words)
    for (const candidate of words) {
      if (key === candidate) continue;
      expect(suggestion(key, [candidate]), `${key} -> ${candidate}`).toBe(
        reference(key, candidate) <= 2 ? candidate : undefined,
      );
    }
  expect(suggestion('CA', ['ABC'])).toBeUndefined();
  expect(suggestion('DELTA', ['delta'])).toBe('delta');
  expect(suggestion('deltc', ['delta', 'deltb'])).toBe('delta');
  expect(suggestion('deltc', ['deltb', 'delta'])).toBe('deltb');
});
