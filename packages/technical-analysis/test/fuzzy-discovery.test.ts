/**
 * TA fuzzy discovery (Wave 6 §4). `searchIndicators` now tolerates typos via a deterministic
 * Damerau–Levenshtein fallback, ranks by match class → score → name, and carries inspectable `match`
 * evidence. Exact/substring hits always outrank fuzzy; no evidence is attached to an unfiltered list.
 */

import { describe, expect, it } from 'vitest';
import { searchIndicators } from '@totalfinance/technical-analysis';
import { normalizeName, osaDistance, similarity } from '../src/fuzzy.js';

describe('searchIndicators — fuzzy fallback', () => {
  it('a 1–2 edit misspelling returns the intended indicator first', () => {
    const cases: Array<[string, string]> = [
      ['mcad', 'macd'], // adjacent transposition
      ['stochasic', 'stochastic'], // one deletion
      ['stochastc', 'stochastic'], // one deletion
    ];
    for (const [typo, name] of cases) {
      const r = searchIndicators({ query: typo });
      expect(r.indicators.length).toBeGreaterThan(0);
      expect(r.indicators[0]!.name).toBe(name);
      expect(r.indicators[0]!.match!.kind).toBe('fuzzy'); // no substring hit ⇒ fuzzy fallback
      expect(r.indicators[0]!.match!.score).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('an exact match outranks any fuzzy candidate (fuzzy mode still ranks it first)', () => {
    const r = searchIndicators({ query: 'rsi', match: 'fuzzy' });
    expect(r.indicators[0]!.name).toBe('rsi');
    expect(r.indicators[0]!.match!.kind).toBe('canonical-exact');
    const exactIdx = r.indicators.findIndex((i) => i.match!.kind.endsWith('exact'));
    const firstFuzzy = r.indicators.findIndex((i) => i.match!.kind === 'fuzzy');
    if (firstFuzzy >= 0) expect(exactIdx).toBeLessThan(firstFuzzy);
  });

  it('auto uses substring when present, fuzzy only as a fallback', () => {
    const sub = searchIndicators({ query: 'stoch' });
    expect(sub.total).toBeGreaterThan(0);
    expect(
      sub.indicators.every(
        (i) => i.match!.kind.includes('substring') || i.match!.kind.endsWith('exact'),
      ),
    ).toBe(true);
    const fuzz = searchIndicators({ query: 'stochasic' });
    expect(fuzz.indicators[0]!.match!.kind).toBe('fuzzy');
  });

  it('carries inspectable match evidence (kind, score, matchedOn)', () => {
    const r = searchIndicators({ query: 'stochasic' });
    const top = r.indicators[0]!.match!;
    expect(top.score).toBeGreaterThanOrEqual(0.7);
    expect(['canonical', 'alias']).toContain(top.matchedOn.source);
    expect(typeof top.matchedOn.value).toBe('string');
  });

  it('is deterministic and stable (identical results on repeat)', () => {
    const run = () =>
      searchIndicators({ query: 'movng', match: 'fuzzy', minScore: 0.6 }).indicators.map((i) => ({
        name: i.name,
        kind: i.match!.kind,
        score: i.match!.score,
      }));
    expect(run()).toEqual(run());
  });

  it('substring mode excludes fuzzy; fuzzy needs ≥ 3 normalized chars', () => {
    // A typo with no substring hit returns nothing in substring mode...
    expect(searchIndicators({ query: 'stochasic', match: 'substring' }).total).toBe(0);
    // ...and a 2-char query never triggers fuzzy (auto with no substring hit ⇒ empty).
    const short = searchIndicators({ query: 'zq' });
    expect(short.indicators.every((i) => i.match?.kind !== 'fuzzy')).toBe(true);
  });

  it('attaches no match evidence to an unfiltered list (lean pagination)', () => {
    const r = searchIndicators({ limit: 5 });
    expect(r.indicators.every((i) => i.match === undefined)).toBe(true);
    expect(r.indicators.length).toBe(5);
  });

  it('rejects a no-op minScore/match without a query, a bad minScore, and unknown options', () => {
    expect(() => searchIndicators({ minScore: 0.8 })).toThrowError(/minScore requires a query/);
    expect(() => searchIndicators({ match: 'fuzzy' })).toThrowError(/requires a query/);
    expect(() => searchIndicators({ query: 'rsi', minScore: 1.5 })).toThrowError();
    expect(() => searchIndicators({ query: 'rsi', match: 'wat' as never })).toThrowError();
    expect(() => searchIndicators({ query: 'rsi', junk: 1 } as never)).toThrowError();
    // match: 'auto' explicitly with no query is fine (it's the default, not a no-op override).
    expect(() => searchIndicators({ match: 'auto' })).not.toThrowError();
  });
});

describe('fuzzy module (deterministic string math)', () => {
  it('OSA distance handles insert/delete/substitute + adjacent transposition', () => {
    expect(osaDistance('bolinger', 'bollinger')).toBe(1);
    expect(osaDistance('mcad', 'macd')).toBe(1);
    expect(osaDistance('', 'abc')).toBe(3);
    expect(osaDistance('abc', 'abc')).toBe(0);
  });

  it('similarity is symmetric and in [0, 1]', () => {
    expect(similarity('abc', 'abd')).toBeCloseTo(similarity('abd', 'abc'), 15);
    const s = similarity('rsi', 'macd');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('normalizeName splits camel-case + separators into tokens', () => {
    expect(normalizeName('bollingerBands')).toEqual({
      full: 'bollingerbands',
      tokens: ['bollinger', 'bands'],
    });
    expect(normalizeName('stochastic_rsi').tokens).toEqual(['stochastic', 'rsi']);
  });
});
