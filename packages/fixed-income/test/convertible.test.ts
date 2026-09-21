/**
 * Tests for §14.1 convertible bonds: parity/bond-floor limits, the price ≥ max(floor, parity) bound,
 * the risk-free zero anchor for the bond floor, and equity-vol / credit-hazard monotonicities.
 */

import { describe, expect, it } from 'vitest';
import { convertibleBond, credit } from '@totalfinance/fixed-income';

const ref = '2026-01-01';
const base = {
  issueDate: ref,
  maturityDate: '2031-01-01',
  couponRate: 0.03,
  frequency: 'semiannual' as const,
  faceValue: 100,
  conversionRatio: 1, // 1 share per bond
  volatility: 0.3,
  riskFreeRate: 0.05,
  hazardRate: 0.02,
  recovery: 0.4,
  stepsPerYear: 120,
};
const T = (Date.UTC(2031, 0, 1) - Date.UTC(2026, 0, 1)) / (365 * 86_400_000);

describe('convertible bond', () => {
  it('price is at least the greater of the bond floor and the conversion (parity) value', () => {
    const r = convertibleBond({ ...base, spot: 90 });
    expect(r.price).toBeGreaterThanOrEqual(r.bondFloor - 1e-9);
    expect(r.price).toBeGreaterThanOrEqual(r.conversionValue - 1e-9);
  });

  it('deep in-the-money ⇒ price ≈ conversion (parity) value', () => {
    const r = convertibleBond({ ...base, spot: 400 });
    expect(r.conversionValue).toBe(400);
    expect(r.price).toBeGreaterThanOrEqual(400 - 1e-9);
    expect(r.price).toBeLessThan(400 * 1.1); // little time value left
  });

  it('deep out-of-the-money ⇒ price ≈ the bond floor', () => {
    const r = convertibleBond({ ...base, spot: 2 });
    expect(Math.abs(r.price - r.bondFloor)).toBeLessThan(0.5);
    expect(r.optionValue).toBeLessThan(0.5);
  });

  it('the bond floor with no credit is the risk-free discounted bond', () => {
    const r = convertibleBond({ ...base, spot: 5, couponRate: 0, hazardRate: 0 });
    // Zero-coupon, default-free ⇒ floor = face · e^{−rT}.
    expect(r.bondFloor).toBeCloseTo(100 * Math.exp(-0.05 * T), 1);
  });

  it('higher equity volatility raises the convertible (more optionality)', () => {
    const lo = convertibleBond({ ...base, spot: 100, volatility: 0.2 }).price;
    const hi = convertibleBond({ ...base, spot: 100, volatility: 0.5 }).price;
    expect(hi).toBeGreaterThan(lo);
  });

  it('higher hazard lowers both the bond floor and the convertible', () => {
    const safe = convertibleBond({ ...base, spot: 100, hazardRate: 0.005 });
    const risky = convertibleBond({ ...base, spot: 100, hazardRate: 0.06 });
    expect(risky.bondFloor).toBeLessThan(safe.bondFloor);
    expect(risky.price).toBeLessThan(safe.price);
  });

  it('accepts a term-structured survival curve for credit', () => {
    const { hazardRate: _omit, ...noHazard } = base;
    const survival = credit.survivalFromHazards(
      [
        ['2028-01-01', 0.015],
        ['2031-01-01', 0.03],
      ],
      { referenceDate: ref },
    );
    const r = convertibleBond({ ...noHazard, spot: 100, survival });
    expect(r.price).toBeGreaterThan(r.bondFloor - 1e-9);
    expect(r.bondFloor).toBeGreaterThan(0);
    expect(r.bondFloor).toBeLessThan(100); // risky discount below par
  });

  it('requires a credit input and rejects bad parameters', () => {
    const { hazardRate: _omit, ...noHazard } = base;
    expect(() => convertibleBond({ ...noHazard, spot: 100 })).toThrow(/survival|hazard/);
    expect(() => convertibleBond({ ...base, spot: 100, recovery: 1.2 })).toThrow(/recovery/);
  });

  it('rejects a negative flat hazard rate (would make a negative default probability) (PR review)', () => {
    expect(() => convertibleBond({ ...base, spot: 100, hazardRate: -0.5 })).toThrow(/hazardRate/);
  });
});
