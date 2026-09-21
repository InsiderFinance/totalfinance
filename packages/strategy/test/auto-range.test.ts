import { describe, expect, it } from 'vitest';
import { autoPriceRange } from '../src/auto-range.js';

/**
 * The internal default-window helper behind a bare `payoff()` / `chartData()` / `scenarioTable()` and
 * `payoffSvg`'s auto-range (F4). Real positions always contribute strikes, so these exercise the
 * degenerate references-only paths a live position never reaches.
 */
describe('autoPriceRange', () => {
  it('spans the references padded 35% on each side, clamped at 0', () => {
    const r = autoPriceRange([90, 95, 110, 115]);
    const span = 115 - 90; // 25
    expect(r.from).toBeCloseTo(90 - span * 0.35, 9);
    expect(r.to).toBeCloseTo(115 + span * 0.35, 9);
    expect(r.steps).toBe(121);
    expect(r.from).toBeGreaterThanOrEqual(0);
  });

  it('ignores non-finite and non-positive references', () => {
    // Only 100 survives the finite-and-positive filter, so it degenerates to the single-ref case.
    const r = autoPriceRange([NaN, -5, 0, Infinity, 100]);
    // Zero span → falls back to 30% of the level (100 * 0.3 = 30) for padding.
    expect(r.from).toBeCloseTo(100 - 30 * 0.35, 9);
    expect(r.to).toBeCloseTo(100 + 30 * 0.35, 9);
  });

  it('falls back to a 1..100 window when no reference is usable', () => {
    const r = autoPriceRange([]);
    const span = 100 - 1;
    expect(r.from).toBeCloseTo(Math.max(0, 1 - span * 0.35), 9);
    expect(r.to).toBeCloseTo(100 + span * 0.35, 9);
    expect(autoPriceRange([NaN, -1])).toEqual(r); // all filtered out ⇒ same fallback
  });

  it('clamps `from` at 0 when the padded low would go negative', () => {
    // lo=1, hi=4, span=3 → 1 - 3*0.35 = -0.05 → clamped to 0.
    expect(autoPriceRange([1, 4]).from).toBe(0);
    // lo=1, hi=2, span=1 → 1 - 1*0.35 = 0.65 → stays positive (no clamp).
    expect(autoPriceRange([1, 2]).from).toBeCloseTo(0.65, 9);
  });
});
