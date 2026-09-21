import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 4.7 (FC9, Decision 8) — "the full Phase 3A/3B gates rerun against the expanded surface with
 * ZERO deferred exceptions", made executable in one place.
 *
 * A deferred exception is a claim postponed: a skipped or todo test, a pending-harvest entry, an
 * unregistered legacy code, an unresolved naming identity, a defective enforcement row, an
 * unmeasured row with no reason, or an allowlist entry with no reason. The allowlists the other
 * gates carry (declared-coverage residuals, union-parity undescribed parameters, uninstantiated
 * generic routes, the no-side-effects routes) are measured facts, not deferrals — each entry must
 * say why it is there, and this gate checks that it does.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function walkTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    if (statSync(p).isDirectory()) walkTests(p, out);
    else if (entry.endsWith('.test.ts')) out.push(p);
  }
}

/** The body of a bracketed literal (`[...]`), found by its declaration name. */
function literalBody(source: string, name: string): string {
  const match = new RegExp(`${name}[^=]*=\\s*(?:new (?:Set|Map)[^(]*\\()?\\[`).exec(source);
  if (match === null) throw new Error(`${name}: declaration not found`);
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (depth > 0 && i < source.length) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') depth -= 1;
    i += 1;
  }
  return source.slice(start, i - 1);
}

describe('zero deferred exceptions (FC9 Decision 8)', () => {
  it('no test is skipped, todo, or focused', () => {
    const files: string[] = [];
    for (const dir of ['packages', 'tools', 'docs/examples']) walkTests(join(ROOT, dir), files);
    expect(files.length).toBeGreaterThan(400);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const hit = /\b(?:it|test|describe)\.(?:skip|todo|only)\(/.exec(text);
      if (hit !== null) offenders.push(`${relative(ROOT, file)}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the count-safety pending-harvest map is empty', () => {
    const body = literalBody(
      read('tools/first-touch/count-safety-sweep.test.ts'),
      'KNOWN_UNSAFE_PENDING_HARVEST',
    );
    // comments explaining the last harvest may remain; entries may not
    const entries = body.split('\n').filter((line) => /^\s*\[/.test(line));
    expect(entries).toEqual([]);
  });

  it('the legacy unregistered-codes list is empty', () => {
    const body = literalBody(read('tools/codes-conformance.test.ts'), 'LEGACY_UNREGISTERED');
    expect(body.trim()).toBe('');
  });

  it('the naming inventory has no unresolved identity', () => {
    const naming = JSON.parse(read('tools/manifest/public-naming.json')) as {
      summary: { identities: number; unresolved: number };
    };
    expect(naming.summary.identities).toBeGreaterThan(30_000);
    expect(naming.summary.unresolved).toBe(0);
  });

  it('enforcement has no defective row, and every unmeasured row or alternative carries a reason', () => {
    const enforcement = JSON.parse(read('tools/manifest/public-enforcement.json')) as {
      summary: { candidates: number; defective: number; unmeasured: number };
      enforcement: Array<{
        id: string;
        verdict: string;
        unmeasuredReason?: string;
        inheritedFrom?: string;
        alternatives?: Array<{ id: string; verdict: string; unmeasuredReason?: string }>;
      }>;
    };
    expect(enforcement.summary.candidates).toBeGreaterThan(5_000);
    expect(enforcement.summary.defective).toBe(0);
    const silent: string[] = [];
    for (const row of enforcement.enforcement) {
      if (row.inheritedFrom !== undefined) continue;
      if (row.verdict === 'unmeasured' && !row.unmeasuredReason) silent.push(row.id);
      for (const alternative of row.alternatives ?? []) {
        if (alternative.verdict === 'unmeasured' && !alternative.unmeasuredReason) {
          silent.push(`${row.id} / ${alternative.id}`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  it('every allowlist entry of the other gates carries a reason', () => {
    // declared-coverage residual rows: string entries grouped under dated comments
    {
      const body = literalBody(
        read('tools/manifest/declared-coverage.test.ts'),
        'ALLOWED_RESIDUAL',
      );
      let dated = false;
      const orphans: string[] = [];
      for (const line of body.split('\n')) {
        if (/^\s*\/\//.test(line)) {
          if (/20\d\d-\d\d-\d\d/.test(line)) dated = true;
        } else if (/^\s*'/.test(line) && !dated) {
          orphans.push(line.trim().slice(0, 80));
        }
      }
      expect(orphans, 'declared-coverage residual rows before any dated reason').toEqual([]);
    }
    // union-parity undescribed parameters: [route, reason] tuples
    {
      const body = literalBody(
        read('tools/manifest/union-checker-parity.test.ts'),
        'UNDESCRIBED_ALLOWLIST',
      );
      const entryLines = body
        .split('\n')
        .filter((line) => /^\s*\[\s*$/.test(line) || /^\s*\[\s*'/.test(line)).length;
      const tuples = [...body.matchAll(/\[\s*'([^']+)',\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2/g)];
      expect(tuples.length, 'every tuple parsed').toBe(entryLines);
      expect(tuples.length).toBeGreaterThan(40); // 47 at the gate's landing (2026-09-04)
      const bare = tuples.filter((t) => t[3]!.length < 40).map((t) => t[1]);
      expect(bare, 'undescribed-parameter entries without a reason').toEqual([]);
    }
    // uninstantiated generic routes: every entry under a comment inside the block
    {
      const body = literalBody(
        read('tools/manifest/union-checker-parity.test.ts'),
        'UNINSTANTIATED_GENERIC_PARAMETER_ROUTES',
      );
      let commented = false;
      const orphans: string[] = [];
      for (const line of body.split('\n')) {
        if (/^\s*\/\//.test(line)) commented = true;
        else if (/^\s*'/.test(line) && !commented) orphans.push(line.trim());
      }
      expect(orphans, 'generic-route entries before any reason').toEqual([]);
    }
    // the no-side-effects routes: every entry has a reason field of substance
    {
      const source = read('tools/no-side-effects.test.ts');
      const reasons = [...source.matchAll(/reason:\s*\n?\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)];
      // Two routes remain (the local layer and the runtime deadline clock); the two teaching-string
      // entries were retired when the strings stopped naming the clock (2026-09).
      expect(reasons.length).toBeGreaterThan(1);
      expect(reasons.filter((r) => r[2]!.length < 40)).toEqual([]);
    }
  });
});
