/**
 * FC0 — the frozen FundamentalPeriod contract and the point-in-time availability law.
 * `availableTimestampMs`, never `periodEndDate`, controls eligibility; a restatement is a NEW
 * version an observer cannot see before its own availability instant.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  isPeriodAvailableAt,
  requireFundamentalPeriod,
  type FundamentalPeriod,
} from '@totalfinance/fundamentals';

const Q1: FundamentalPeriod = {
  periodStartDate: '2026-01-01',
  periodEndDate: '2026-03-31',
  fiscalYear: 2026,
  fiscalQuarter: 1,
  periodType: 'quarter',
  filedTimestampMs: Date.UTC(2026, 3, 28),
  availableTimestampMs: Date.UTC(2026, 3, 28, 21, 30),
  currency: 'USD',
  monetaryScale: 1_000_000,
  form: '10-Q',
};

describe('FundamentalPeriod (FC0 frozen contract)', () => {
  it('accepts the canonical period and closes its keys', () => {
    requireFundamentalPeriod('test', Q1);
    let caught: unknown;
    try {
      requireFundamentalPeriod('test', { ...Q1, monetaryScal: 1 } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.unknown_field')).toBe(true);
  });

  it('rejects a loose date — the grammar is strict YYYY-MM-DD', () => {
    for (const bad of ['2026-3-31', '03/31/2026', '2026-03-31T00:00:00Z', 20260331]) {
      let caught: unknown;
      try {
        requireFundamentalPeriod('test', { ...Q1, periodEndDate: bad } as never);
      } catch (e) {
        caught = e;
      }
      expect(isQuantError(caught, 'input.wrong_type'), String(bad)).toBe(true);
    }
  });

  it('rejects domain violations on periodType / fiscalQuarter / monetaryScale', () => {
    expect(() => requireFundamentalPeriod('test', { ...Q1, periodType: 'ttm' } as never)).toThrow();
    expect(() => requireFundamentalPeriod('test', { ...Q1, fiscalQuarter: 5 } as never)).toThrow();
    expect(() =>
      requireFundamentalPeriod('test', { ...Q1, monetaryScale: 100 } as never),
    ).toThrow();
  });

  it('AVAILABILITY, not the period end, controls point-in-time eligibility', () => {
    // The quarter ENDED March 31 — but an observer on April 1 must not see it: the filing
    // arrived April 28.
    expect(isPeriodAvailableAt(Q1, Date.UTC(2026, 3, 1))).toBe(false);
    expect(isPeriodAvailableAt(Q1, Q1.availableTimestampMs)).toBe(true);
    expect(isPeriodAvailableAt(Q1, Date.UTC(2026, 4, 15))).toBe(true);
  });

  it('a restatement is a new version: invisible before ITS availability, original still visible', () => {
    const restated: FundamentalPeriod = {
      ...Q1,
      availableTimestampMs: Date.UTC(2026, 6, 10),
      accession: 'A-2',
      restatementOf: 'A-1',
    };
    const between = Date.UTC(2026, 5, 1); // after the original, before the restatement
    expect(isPeriodAvailableAt(Q1, between)).toBe(true);
    expect(isPeriodAvailableAt(restated, between)).toBe(false);
    expect(isPeriodAvailableAt(restated, Date.UTC(2026, 7, 1))).toBe(true);
  });

  it('asOf must be a finite epoch-ms number', () => {
    let caught: unknown;
    try {
      isPeriodAvailableAt(Q1, NaN as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
  });
});
