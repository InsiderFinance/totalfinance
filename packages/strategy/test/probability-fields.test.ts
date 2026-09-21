/**
 * The terminal-distribution probabilities (3B.1b silent-miscompute cluster).
 *
 * These functions take a deliberate EARLY RETURN for degenerate inputs — zero volatility or zero
 * time is the intrinsic-value limit, and answering it directly is correct. The defect was that a
 * MISSING field reached the same branches and produced a confident answer from nothing: with `spot`
 * absent, `spot <= strike` is `undefined <= undefined` → false, and `terminalCdf` returned `0`. Not
 * `NaN` — a clean, plausible, completely unfounded probability of zero.
 *
 * That is why validation runs BEFORE the degenerate branches. A degenerate input has a right answer;
 * an absent one does not, and the difference is invisible in the output.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  expectedIntrinsic,
  terminalCdf,
  touchProbability,
} from '@totalfinance/strategy/probability';

const TERMINAL = {
  spot: 100,
  strike: 105,
  drift: 0.04,
  volatility: 0.2,
  timeToExpiryYears: 0.25,
} as const;

const TOUCH = {
  spot: 100,
  barrier: 110,
  drift: 0.04,
  volatility: 0.2,
  timeToExpiryYears: 0.25,
} as const;

function codeOf(call: () => unknown): string {
  try {
    return `NO THROW — returned ${String(call())}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

describe('terminalCdf / expectedIntrinsic', () => {
  it('the controls compute', () => {
    expect(terminalCdf(TERMINAL)).toBeGreaterThan(0);
    expect(terminalCdf(TERMINAL)).toBeLessThan(1);
    expect(expectedIntrinsic({ ...TERMINAL, type: 'call' })).toBeGreaterThan(0);
  });

  it.each(['spot', 'strike', 'drift', 'volatility', 'timeToExpiryYears'] as const)(
    'omitting %s is refused rather than answered',
    (field) => {
      const input: Record<string, unknown> = { ...TERMINAL };
      delete input[field];
      expect(codeOf(() => terminalCdf(input as never))).toBe('input.missing_field');
      expect(codeOf(() => expectedIntrinsic({ ...input, type: 'call' } as never))).toBe(
        'input.missing_field',
      );
    },
  );

  it('the degenerate LIMITS still work — the guard did not eat them', () => {
    // Zero vol and zero time are legitimate inputs with documented intrinsic-value answers.
    expect(terminalCdf({ ...TERMINAL, volatility: 0 })).toBe(1);
    expect(expectedIntrinsic({ ...TERMINAL, type: 'call', timeToExpiryYears: 0 })).toBe(0);
    expect(expectedIntrinsic({ ...TERMINAL, type: 'put', volatility: 0 })).toBeCloseTo(5, 10);
  });

  it('expectedIntrinsic still refuses a wrong `type` before anything else', () => {
    expect(codeOf(() => expectedIntrinsic({ ...TERMINAL, type: 'Call' } as never))).toBe(
      'input.invalid_enum',
    );
  });
});

describe('touchProbability', () => {
  it('the control computes', () => {
    const p = touchProbability(TOUCH);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it.each(['spot', 'barrier', 'drift', 'volatility', 'timeToExpiryYears'] as const)(
    'omitting %s is refused',
    (field) => {
      const input: Record<string, unknown> = { ...TOUCH };
      delete input[field];
      expect(codeOf(() => touchProbability(input as never))).toBe('input.missing_field');
    },
  );

  it('a barrier already touched is still 1 — a real degenerate case, not an error', () => {
    expect(touchProbability({ ...TOUCH, barrier: 100 })).toBe(1);
  });
});
