/**
 * The volatility half of the silent-miscompute cluster (3B.1b).
 *
 * Every case here returned a NUMBER before the fix — `NaN`, handed back as a success. In a surface
 * library that is the failure mode with the longest blast radius: a `NaN` total variance becomes a
 * `NaN` implied vol, then a `NaN` price, and nothing in between raises anything.
 *
 * The `phi` cases are the interesting ones and are kept separate below, because the defect was not
 * "a guard was missing" — it was that an absent discriminant SELECTED A BRANCH.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { sviG, sviTotalVariance, sviVolatility } from '@totalfinance/volatility/svi';
import { phiValue, ssviSliceW } from '@totalfinance/volatility/ssvi';

const SVI = { a: 0.04, b: 0.4, rho: -0.3, m: 0, sigma: 0.1 } as const;
const SLICE = { k: 0, theta: 0.04, rho: -0.3, psi: 1 } as const;

function codeOf(call: () => unknown): string {
  try {
    return `NO THROW — returned ${String(call())}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

describe('raw-SVI slice parameters', () => {
  it('the control still evaluates', () => {
    expect(sviTotalVariance(SVI, 0)).toBeCloseTo(0.08, 10);
  });

  it.each(['a', 'b', 'rho', 'm', 'sigma'] as const)(
    'omitting %s is refused by every SVI entry point',
    (field) => {
      const p: Record<string, unknown> = { ...SVI };
      delete p[field];
      expect(codeOf(() => sviTotalVariance(p as never, 0))).toBe('input.missing_field');
      expect(codeOf(() => sviG(p as never, 0))).toBe('input.missing_field');
      expect(codeOf(() => sviVolatility(p as never, 0, 1))).toBe('input.missing_field');
    },
  );

  it('a non-finite log-moneyness is refused rather than propagated', () => {
    expect(codeOf(() => sviTotalVariance(SVI, Number.NaN))).toBe('input.nan');
    expect(codeOf(() => sviTotalVariance(SVI, Number.POSITIVE_INFINITY))).toBe('input.not_finite');
  });

  it('calibrated slices still evaluate identically (the guard changed no math)', () => {
    // Two points either side of the smile centre; values are the closed form, not a snapshot.
    expect(sviTotalVariance(SVI, -0.5)).toBeCloseTo(0.04 + 0.4 * (0.15 + Math.sqrt(0.26)), 10);
    expect(sviVolatility(SVI, 0, 1)).toBeCloseTo(Math.sqrt(0.08), 10);
  });
});

describe('SSVI slice input', () => {
  it.each(['k', 'theta', 'rho', 'psi'] as const)('omitting %s is refused', (field) => {
    const input: Record<string, unknown> = { ...SLICE };
    delete input[field];
    expect(codeOf(() => ssviSliceW(input as never))).toBe('input.missing_field');
  });
});

/**
 * The curvature function is a DISCRIMINATED UNION, and the original defect was subtler than an
 * unguarded field. `requireArgumentObject` accepted `{}`; `phi.kind` was then `undefined`; the
 * `=== 'power-law'` test failed; and control fell through to the Heston branch, which multiplied by
 * an absent `lambda`. A missing discriminant did not skip validation — it CHOSE a model.
 */
describe('phi: the discriminant selects a branch, so it is validated first', () => {
  it('the control evaluates on both branches', () => {
    expect(phiValue({ kind: 'power-law', eta: 1, gamma: 0.5 }, 0.04)).toBeCloseTo(5, 10);
    expect(phiValue({ kind: 'heston', lambda: 1 }, 0.04)).toBeGreaterThan(0);
  });

  it('an empty phi is refused on the DISCRIMINANT, not silently priced as Heston', () => {
    expect(codeOf(() => phiValue({} as never, 0.04))).toBe('input.invalid_enum');
  });

  it('a misspelled kind names the allowed set', () => {
    expect(codeOf(() => phiValue({ kind: 'powerlaw', eta: 1, gamma: 0.5 } as never, 0.04))).toBe(
      'input.invalid_enum',
    );
    try {
      phiValue({ kind: 'powerlaw' } as never, 0.04);
    } catch (error) {
      expect((error as Error).message).toContain('power-law, heston');
    }
  });

  it('each branch requires only its OWN fields, and reports the nested path', () => {
    expect(codeOf(() => phiValue({ kind: 'power-law', eta: 1 } as never, 0.04))).toBe(
      'input.missing_field',
    );
    expect(codeOf(() => phiValue({ kind: 'heston' } as never, 0.04))).toBe('input.missing_field');
    // A power-law phi does not need `lambda`, and a Heston phi does not need `eta`/`gamma`.
    expect(phiValue({ kind: 'power-law', eta: 1, gamma: 0.5 } as never, 0.04)).toBeCloseTo(5, 10);
    try {
      phiValue({ kind: 'heston' } as never, 0.04);
    } catch (error) {
      // `phi.lambda`, not `lambda` — the caller is holding a surface.
      expect((error as Error).message).toContain('phi.lambda');
    }
  });
});
