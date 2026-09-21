import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import * as ta from '@totalfinance/technical-analysis';

/**
 * Regression for an external-review finding: snapshot restore validated the schema version but not
 * the indicator IDENTITY, so restoring one indicator's snapshot into another produced NaN state (or
 * a raw TypeError for SMA/MACD). `fromJSON` now rejects a kind mismatch with a typed QuantError.
 */
describe('TA snapshot restore — indicator identity guard', () => {
  const emaSnapshot = () => {
    const s = ta.ema.stream({ period: 5 });
    s.peek(10);
    s.peek(11);
    s.peek(12);
    return s.toJSON();
  };

  it('restoring an EMA snapshot into a DIFFERENT indicator throws a QuantError (not a raw crash)', () => {
    const snap = emaSnapshot();
    for (const wrong of [ta.rsi, ta.sma, ta.macd, ta.bbands]) {
      let caught: unknown;
      try {
        wrong.fromJSON(snap);
      } catch (e) {
        caught = e;
      }
      expect(isQuantError(caught, 'snapshot.kind_mismatch')).toBe(true);
    }
  });

  it('a same-indicator round-trip still restores and continues', () => {
    const restored = ta.ema.fromJSON(emaSnapshot());
    expect(restored.toJSON().kind).toBe('ema');
    expect(() => restored.peek(13)).not.toThrow();
  });
});
