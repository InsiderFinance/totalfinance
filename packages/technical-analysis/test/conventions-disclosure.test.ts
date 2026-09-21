/**
 * The convention-disclosure gate (3B.1b).
 *
 * `docs/compatibility/talib-differences.md` is where TotalFinance records every place its numbers
 * deliberately differ from TA-Lib or pandas-ta. That document was the ONLY place those choices
 * lived: a caller comparing two libraries could see the disagreement in the values and had no way to
 * ask the result why. `.explain().assumptions.conventions` now answers that in-band.
 *
 * A disclosure is only worth having if it cannot drift from the thing it discloses, so this file
 * holds the two directions together:
 *
 *   1. every indicator the differences doc names must DECLARE conventions, and
 *   2. every declared convention must name a registered indicator and survive serialization.
 *
 * Direction 1 is the one that matters. Without it, the next divergence gets a doc row, the
 * disclosure silently stays behind, and the library is back to answering "read the prose".
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ta from '@totalfinance/technical-analysis';

const DIFFERENCES_DOC = fileURLToPath(
  new URL('../../../docs/compatibility/talib-differences.md', import.meta.url),
);

/**
 * Names the differences doc calls out, resolved to canonical registry names.
 *
 * The doc writes them as reference spellings (`ATR`, `STOCHRSI`, `ADOSC`), which is what a reader
 * searching for their other library's function will type — so the alias resolver does the mapping
 * rather than a second hand-maintained list that could disagree with the first.
 */
function divergentIndicators(): { canonical: string; documentedAs: string }[] {
  const markdown = readFileSync(DIFFERENCES_DOC, 'utf8');
  const seen = new Map<string, string>();
  // Only the FIRST column of a table row names the function(s) a row is about; later columns
  // describe the difference and routinely mention unrelated names ("like RSI", "TA-Lib's STOCH").
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1];
    if (firstCell === undefined) continue;
    for (const [, spelling] of firstCell.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
      if (spelling === undefined) continue;
      const canonical = ta.resolveIndicatorName(spelling);
      if (canonical !== undefined && !seen.has(canonical)) seen.set(canonical, spelling);
    }
  }
  return [...seen].map(([canonical, documentedAs]) => ({ canonical, documentedAs }));
}

describe('conventions are disclosed in-band, not only in prose', () => {
  const divergent = divergentIndicators();

  it('the doc scan actually found the divergence rows', () => {
    // Without this, a parser change that matched nothing would make the loop below vacuous — the
    // failure mode that let a hand-listed sweep roster silently drop a whole package.
    expect(divergent.length).toBeGreaterThan(10);
  });

  it.each(divergent)(
    'the documented divergence $documentedAs ($canonical) declares its conventions',
    ({ canonical, documentedAs }) => {
      const described = ta.describeIndicator(canonical);
      expect(
        described.conventions,
        `${canonical} is named in talib-differences.md (as \`${documentedAs}\`) but declares no ` +
          `conventions, so a caller can only learn the difference by reading the doc. Add an entry ` +
          `to the indicator's named contract in builtin-metadata.ts.`,
      ).toBeDefined();
      expect(Object.keys(described.conventions ?? {}).length).toBeGreaterThan(0);
    },
  );

  it('every declared convention names a registered indicator with JSON-safe scalar values', () => {
    for (const entry of ta.listIndicators()) {
      const conventions = ta.describeIndicator(entry.name).conventions;
      if (conventions === undefined) continue;
      for (const [key, value] of Object.entries(conventions)) {
        expect(['string', 'number', 'boolean'], `${entry.name}.${key}`).toContain(typeof value);
      }
      // The block is part of a result that travels over MCP and into stored artifacts.
      expect(JSON.parse(JSON.stringify(conventions))).toEqual(conventions);
    }
  });

  it('the declaration is frozen, so reading a result cannot rewrite every later one', () => {
    const conventions = ta.rsi.explain([1, 2, 3], { period: 2 }).assumptions.conventions;
    expect(conventions).toBeDefined();
    expect(Object.isFrozen(conventions)).toBe(true);
  });

  it('an indicator with no such choice omits the block rather than carrying an empty one', () => {
    // Presence has to MEAN something: `sma` is an arithmetic mean with nothing to disclose.
    const assumptions = ta.sma.explain([1, 2, 3, 4], { period: 2 }).assumptions;
    expect('conventions' in assumptions).toBe(false);
  });

  it('the direct call and the discovery path disclose the same thing', () => {
    // Two paths reach these facts — a result envelope and a tool schema — and an agent may see
    // either. Both paths consume the named contracts in builtin-metadata.ts.
    for (const { canonical } of divergent) {
      const fromDiscovery = ta.describeIndicator(canonical).conventions;
      const indicator = (ta as unknown as Record<string, { explain?: unknown }>)[canonical];
      if (typeof indicator?.explain !== 'function') continue;
      expect(fromDiscovery).toBeDefined();
    }
  });

  it('RSI discloses the flat-series answer that differs from both references', () => {
    // The concrete case the whole mechanism exists for: three libraries, three answers, and the
    // number alone cannot tell you which convention produced it.
    const flat = ta.rsi.explain(
      Array.from({ length: 30 }, () => 50),
      { period: 14 },
    );
    expect(flat.value.at(-1)).toBe(100);
    expect(String(flat.assumptions.conventions?.['flatSeries'])).toMatch(/100/);
    expect(String(flat.assumptions.conventions?.['smoothing'])).toBe('wilder');
  });
});
