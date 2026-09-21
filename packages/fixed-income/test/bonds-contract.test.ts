/**
 * Law 12 for the bonds cluster (spec 3B.1b) — and the shared validator's FIRST LIVE UNION.
 *
 * `Amortization = { type: 'straight' } | { type: 'annuity' } | { principalByPeriod: [...] }` is the
 * declared shape the discriminant-first resolver was built against; these are the production calls
 * proving it: a wrong discriminant teaches against the whole domain (never falls through — the
 * `phi: {}` class), the structural arm selects by its required key, and a value matching no arm
 * names every alternative. Also proven here: the MIXED primitive union
 * (`Frequency = 'annual' | … | number`) accepts both spellings and still runs the finite ladder,
 * and the Bond artifact's projection-context methods are closed (the "rich methods outside the
 * facade guards" cluster).
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { bonds } from '@totalfinance/fixed-income/bonds';

const FIXED = {
  issueDate: '2025-01-15',
  maturityDate: '2030-01-15',
  couponRate: 0.045,
  frequency: 'semiannual',
} as const;

function outcome(run: () => unknown): string {
  try {
    run();
    return 'NO THROW';
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

describe('bond builders are closed requests (generated specs)', () => {
  it('control calls succeed for every builder', () => {
    expect(outcome(() => bonds.fixedRate({ ...FIXED }))).toBe('NO THROW');
    expect(
      outcome(() => bonds.zeroCoupon({ issueDate: '2025-01-15', maturityDate: '2030-01-15' })),
    ).toBe('NO THROW');
    expect(outcome(() => bonds.amortizing({ ...FIXED, amortization: { type: 'straight' } }))).toBe(
      'NO THROW',
    );
  });

  it('unknown keys, null, and missing fields teach with exact codes', () => {
    expect(outcome(() => bonds.fixedRate({ ...FIXED, couponRte: 0.05 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(outcome(() => bonds.fixedRate({ ...FIXED, couponRate: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    const { couponRate: _omitted, ...rest } = FIXED;
    expect(outcome(() => bonds.fixedRate(rest as never))).toBe(ErrorCode.InputMissingField);
  });

  it('the MIXED frequency union accepts both spellings and rejects the rest', () => {
    // `Frequency = 'annual' | 'semiannual' | … | number`: the named spelling and the numeric one
    // are equally declared; a collapsed kind used to reject 'semiannual' outright.
    expect(outcome(() => bonds.fixedRate({ ...FIXED, frequency: 2 }))).toBe('NO THROW');
    expect(outcome(() => bonds.fixedRate({ ...FIXED, frequency: 'weekly' } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(outcome(() => bonds.fixedRate({ ...FIXED, frequency: Number.NaN } as never))).toBe(
      ErrorCode.InputNaN,
    );
  });
});

describe('the Amortization union resolves discriminant-first, live', () => {
  const build = (amortization: unknown): string =>
    outcome(() => bonds.amortizing({ ...FIXED, amortization } as never));

  it('every declared arm builds', () => {
    expect(build({ type: 'straight' })).toBe('NO THROW');
    expect(build({ type: 'annuity' })).toBe('NO THROW');
    expect(build({ principalByPeriod: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10] })).toBe('NO THROW');
  });

  it('an undeclared discriminant teaches the whole domain — never falls through', () => {
    try {
      bonds.amortizing({ ...FIXED, amortization: { type: 'bullet' } } as never);
      expect.unreachable('accepted an undeclared amortization type');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputInvalidEnum)) throw error;
      expect(error.message).toContain('straight');
      expect(error.message).toContain('annuity');
    }
  });

  it('a value matching no arm names every alternative', () => {
    expect(build({})).toBe(ErrorCode.InputWrongShape);
  });

  it('a chosen arm is closed against the other arms’ keys', () => {
    expect(build({ type: 'straight', principalByPeriod: [1] })).toBe(ErrorCode.InputUnknownField);
  });
});

describe('Bond artifact methods validate their projection context', () => {
  const bond = bonds.fixedRate({ ...FIXED });

  it('a misspelled context key teaches on the method the user called', () => {
    try {
      bond.futureCashflows('2026-06-15', { forecastCrve: undefined, bogus: 1 } as never);
      expect.unreachable('accepted a bogus context key');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('bond.futureCashflows');
    }
    expect(outcome(() => bond.cashflows({ qzx: 1 } as never))).toBe(ErrorCode.InputUnknownField);
    expect(outcome(() => bond.accrued('2026-06-15', { qzx: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });

  it('a null knownFixingRate is not omission', () => {
    expect(outcome(() => bond.cashflows({ knownFixingRate: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
  });

  it('valid contexts pass through every method', () => {
    expect(bond.cashflows({})).toHaveLength(bond.schedule.length);
    expect(bond.accrued('2026-06-15')).toBeGreaterThan(0);
  });
});
