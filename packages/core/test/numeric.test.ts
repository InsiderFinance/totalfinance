import { describe, expect, it } from 'vitest';
import {
  between,
  clamp,
  ensurePositive,
  formatMoney,
  formatPercent,
  isFiniteNumber,
  isNonNegative,
  isPositive,
  round,
  toFixedSafe,
} from '@totalfinance/core';

describe('numeric guards', () => {
  it('isFiniteNumber rejects NaN/Infinity/non-numbers', () => {
    expect(isFiniteNumber(1.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
  });

  it('isPositive / isNonNegative', () => {
    expect(isPositive(0)).toBe(false);
    expect(isPositive(0.1)).toBe(true);
    expect(isNonNegative(0)).toBe(true);
    expect(isNonNegative(-0.1)).toBe(false);
  });
});

describe('numeric helpers', () => {
  it('round is stable on the classic 1.005 case', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(-1.005, 2)).toBe(-1.01);
    // The nudge is RELATIVE, so portfolio-scale money rounds the same way as values near 1.
    expect(round(1234567.005, 2)).toBe(1234567.01);
    expect(round(-1234567.005, 2)).toBe(-1234567.01);
  });

  it('between honors inclusivity', () => {
    expect(between(0.25, 0.25, 0.35)).toBe(true);
    expect(between(0.25, 0.25, 0.35, { inclusive: false })).toBe(false);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });

  it('toFixedSafe never throws on non-finite input', () => {
    expect(toFixedSafe(1.234, 2)).toBe('1.23');
    expect(toFixedSafe(NaN)).toBe('NaN');
    expect(toFixedSafe(Infinity)).toBe('∞');
  });

  it('formatMoney / formatPercent', () => {
    expect(formatMoney(1234.5, { currency: 'USD' })).toBe('$1,234.50');
    expect(formatPercent(0.225, { decimals: 1 })).toBe('22.5%');
  });
});

describe('invariants', () => {
  it('ensurePositive throws InputError with a stable code', () => {
    expect(() => ensurePositive(-12, 'spot', 'blackScholes.call')).toThrowError(/spot must be > 0/);
    try {
      ensurePositive(0, 'spot', 'blackScholes.call', 'input.negative_spot');
    } catch (e) {
      expect((e as { code: string }).code).toBe('input.negative_spot');
    }
  });
});
