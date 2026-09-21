import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { CBOE, NYSE, crypto24x7, expirations, nextExpiry } from '../src/index.js';

/** DX WS-6 / R10 — trader vocabulary + option-expiration helpers. */
describe('isTradingDay (R10)', () => {
  it('is a first-class alias of isBusinessDay on every exported calendar', () => {
    for (const cal of [NYSE, CBOE, crypto24x7]) {
      expect(cal.isTradingDay).toBe(cal.isBusinessDay);
    }
    expect(NYSE.isTradingDay('2026-07-03')).toBe(false); // July 4th observed
    expect(NYSE.isTradingDay('2026-07-06')).toBe(true);
  });
});

describe('expirations', () => {
  it('monthly = 3rd Fridays (OPEX)', () => {
    const opex = expirations(NYSE, { from: '2026-01-01', to: '2026-06-30', kind: 'monthly' });
    expect(opex).toEqual([
      '2026-01-16',
      '2026-02-20',
      '2026-03-20',
      '2026-04-17',
      '2026-05-15',
      '2026-06-18', // Juneteenth Friday → settles Thursday
    ]);
  });

  it('quarterly = 3rd Fridays of Mar/Jun/Sep/Dec', () => {
    const q = expirations(NYSE, { from: '2026-01-01', to: '2026-12-31', kind: 'quarterly' });
    expect(q).toEqual(['2026-03-20', '2026-06-18', '2026-09-18', '2026-12-18']);
  });

  it('a Good Friday expiration shifts to Thursday (holiday-shifted from calendar data)', () => {
    // Good Friday 2026-04-03: the weekly expiry settles on Thursday 2026-04-02.
    const wk = expirations(NYSE, { from: '2026-03-30', to: '2026-04-05', kind: 'weekly' });
    expect(wk).toEqual(['2026-04-02']);
    expect(NYSE.isTradingDay('2026-04-03')).toBe(false);
  });

  it('teaches on garbage input', () => {
    let caught: unknown;
    try {
      expirations('NYSE' as never, { from: '2026-01-01', to: '2026-02-01' });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect(() => expirations(NYSE, { from: '2026-02-01', to: '2026-01-01' })).toThrowError(
      /before/,
    );
    expect(() =>
      expirations(NYSE, { from: '2026-01-01', to: '2026-02-01', kind: 'daily' as never }),
    ).toThrowError(/weekly/);
  });
});

describe('nextExpiry', () => {
  it('finds the nearest weekly Friday, strictly after the date', () => {
    expect(nextExpiry(NYSE, '2026-07-06')).toBe('2026-07-10');
    expect(nextExpiry(NYSE, '2026-07-10')).toBe('2026-07-17'); // strictly after
  });

  it('finds the next monthly and quarterly expiries', () => {
    expect(nextExpiry(NYSE, '2026-07-06', 'monthly')).toBe('2026-07-17');
    expect(nextExpiry(NYSE, '2026-07-06', 'quarterly')).toBe('2026-09-18');
  });
});
