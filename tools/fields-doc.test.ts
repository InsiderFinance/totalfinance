import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNIT_SUFFIXES, buildFieldReference, unitByName } from './fields-doc.js';

/**
 * Stage 4.7 (FC9, Decision 4) — the committed field reference IS the generated one. The same law
 * as `docs/bundle-size.md`: regenerate in memory from the committed declaration walk and compare
 * byte for byte; a drift fails here and `pnpm docs:update` repairs it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('the generated field reference (FC9 Decision 4)', () => {
  const reference = buildFieldReference(read('tools/manifest/public-contracts.json'));

  it('the index and every package page are committed byte for byte', () => {
    expect(read('docs/reference/fields.md')).toBe(reference.index);
    const drift: string[] = [];
    for (const [pkg, page] of reference.pages) {
      const path = `docs/reference/fields/${page.file}`;
      if (!existsSync(join(ROOT, path))) drift.push(`${pkg}: ${path} missing`);
      else if (read(path) !== page.markdown)
        drift.push(`${pkg}: ${path} differs — run pnpm docs:update`);
    }
    expect(drift).toEqual([]);
  });

  it('no stale page — every committed page is a package the declarations still carry', () => {
    const committed = readdirSync(join(ROOT, 'docs/reference/fields'))
      .filter((f) => f.endsWith('.md'))
      .sort();
    const generated = [...reference.pages.values()].map((page) => page.file).sort();
    expect(committed).toEqual(generated);
  });

  it('covers the whole library (not vacuous)', () => {
    expect(reference.pages.size).toBeGreaterThan(20);
    let fields = 0;
    for (const page of reference.pages.values()) fields += page.fields;
    // 14,678 at the gate's landing (2026-09-04): named object types expanded once per page.
    expect(fields).toBeGreaterThan(10_000);
    expect(reference.umbrellaSpellings).toBeGreaterThan(3_000);
  });

  it("the unit table is applied by the naming law's suffixes, first match wins, and the index prints it", () => {
    expect(unitByName('expiryTimestampMs')).toBe('epoch milliseconds (UTC instant)');
    expect(unitByName('timeToExpiryYears')).toBe('years (decimal)');
    expect(unitByName('strikePricePerUnit')).toBe('currency per unit');
    expect(unitByName('riskFreeRate')).toBe('decimal rate (0.05 = 5%)');
    expect(unitByName('spreadBasisPoints')).toBe('basis points');
    expect(unitByName('asOf')).toContain('instant');
    expect(unitByName('symbol')).toBe('unitless by name');
    for (const [pattern] of UNIT_SUFFIXES) {
      expect(reference.index).toContain(pattern.source.replace(/\|/g, '\\|'));
    }
  });
});
