/**
 * R3 review fixes: ad-hoc closure completeness (national days of mourning) and the
 * addBusinessDays integer guard, pinned as golden tests.
 */

import { describe, expect, it } from 'vitest';
import { NYSE } from '@totalfinance/calendars';
describe('R3: national days of mourning are real closures', () => {
  it('Reagan (2004-06-11) and Ford (2007-01-02) were NYSE closures', () => {
    expect(NYSE.isBusinessDay('2004-06-11')).toBe(false);
    expect(NYSE.isBusinessDay('2007-01-02')).toBe(false);
    // sanity: the surrounding trading days are open
    expect(NYSE.isBusinessDay('2004-06-10')).toBe(true);
    expect(NYSE.isBusinessDay('2007-01-03')).toBe(true);
  });

  it('addBusinessDays rejects non-integer n (Infinity would hang, NaN would no-op silently)', () => {
    expect(() => NYSE.addBusinessDays('2026-01-02', Infinity)).toThrowError(/must be an integer/);
    expect(() => NYSE.addBusinessDays('2026-01-02', 2.5)).toThrowError(/must be an integer/);
    expect(() => NYSE.addBusinessDays('2026-01-02', NaN)).toThrowError(/must be an integer/);
    expect(NYSE.addBusinessDays('2026-01-02', 1)).toBe('2026-01-05');
  });
});
