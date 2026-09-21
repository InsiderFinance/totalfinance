import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chiSquare, gamma, regularizedBeta, regularizedGammaP, studentT } from '@totalfinance/math';

/**
 * WS9.5a golden: `packages/math/src/distributions.ts` is checked against SciPy — the named reference
 * implementation — through a committed fixture (`tools/golden/generate_distributions.py`). CI reads
 * the JSON only; no Python runs here. This is the external cross-check that complements the
 * closed-form/self-consistency goldens in `distributions.test.ts`.
 */

interface GoldenCase {
  fn: string;
  args: number[];
  expected: number;
}
interface Fixture {
  _meta: { source: string; generator: string; note: string };
  cases: GoldenCase[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/distributions.golden.json', import.meta.url)),
    'utf8',
  ),
);

/** Evaluate one golden case against the library implementation. */
function evaluate(c: GoldenCase): number {
  const [a, b, d] = c.args;
  switch (c.fn) {
    case 'studentT.cdf':
      return studentT.cdf(a!, b!);
    case 'studentT.pdf':
      return studentT.pdf(a!, b!);
    case 'studentT.inverseCdf':
      return studentT.inverseCdf(a!, b!);
    case 'chiSquare.cdf':
      return chiSquare.cdf(a!, b!);
    case 'chiSquare.inverseCdf':
      return chiSquare.inverseCdf(a!, b!);
    case 'gamma.cdf':
      return gamma.cdf(a!, b!, d!);
    case 'gamma.inverseCdf':
      return gamma.inverseCdf(a!, b!, d!);
    case 'regularizedGammaP':
      return regularizedGammaP(a!, b!);
    case 'regularizedBeta':
      return regularizedBeta(a!, b!, d!);
    default:
      throw new Error(`unknown golden fn: ${c.fn}`);
  }
}

// Quantile (inverse) cases carry the solver tolerance; probabilities/densities are near-exact.
const isInverse = (fn: string): boolean => fn.endsWith('.inverseCdf');

describe(`distributions vs SciPy golden (${fixture._meta.source})`, () => {
  it('covers every distribution and special function', () => {
    const fns = new Set(fixture.cases.map((c) => c.fn));
    expect(fns).toEqual(
      new Set([
        'studentT.cdf',
        'studentT.pdf',
        'studentT.inverseCdf',
        'chiSquare.cdf',
        'chiSquare.inverseCdf',
        'gamma.cdf',
        'gamma.inverseCdf',
        'regularizedGammaP',
        'regularizedBeta',
      ]),
    );
    expect(fixture.cases.length).toBeGreaterThan(400);
  });

  it('matches SciPy on all 447 reference points', () => {
    let worst = 0;
    let worstCase: GoldenCase | null = null;
    for (const c of fixture.cases) {
      const got = evaluate(c);
      // Absolute error for probabilities/densities; relative for quantiles (they scale with df/shape).
      const tolerance = isInverse(c.fn) ? 1e-7 * Math.max(1, Math.abs(c.expected)) : 1e-10;
      const err = Math.abs(got - c.expected);
      if (err > worst) {
        worst = err;
        worstCase = c;
      }
      expect(
        err,
        `${c.fn}(${c.args.join(', ')}) = ${got}, expected ${c.expected} (Δ=${err})`,
      ).toBeLessThanOrEqual(tolerance);
    }
    // Sanity: the worst error is comfortably below the loosest tolerance.
    expect(worst, `worst case: ${worstCase?.fn}(${worstCase?.args.join(', ')})`).toBeLessThan(1e-6);
  });
});
