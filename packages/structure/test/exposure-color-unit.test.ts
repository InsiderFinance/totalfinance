import { describe, expect, it } from 'vitest';
import { resolvedExpiry } from '@totalfinance/core';
import {
  colorExposure,
  exposure,
  gammaExposure,
  type ExposureShortcutInput,
} from '@totalfinance/structure';

/**
 * Color exposure is the change in GEX as one calendar day elapses (`−∂GEX/∂T` per day), in the
 * profile's own `gammaUnit` (selective Greeks and exposure spec, decision 18).
 *
 * Checked independently of the formula: a central finite difference of the profile's OWN `gex` over
 * the valuation instant. Moving `asOf` ten minutes later shortens time to expiry by exactly ten minutes
 * (ACT/365F on the instants), so `(gex(asOf + h) − gex(asOf − h)) / (2h in days)` is the change in
 * GEX per day elapsed, to O(h²).
 *
 * CORRECTION. 0.1.0 scaled color by the per-1%-move factor (S²·0.01) under `gammaUnit: 'perPoint'`
 * too, overstating it by spot·0.01 — twice the finite difference at spot 200 (found in review of #3).
 */

const SPOT = 200;
const ASOF = Date.parse('2026-06-15T18:30:00Z');
const HOUR_MS = 3_600_000;
/** The finite-difference step: ten minutes, so the O(h²) error is ~3e-8 of a 32-day option's color. */
const STEP_MS = 600_000;

function oneContract(
  type: 'call' | 'put',
  strike: number,
  asOfMs: number,
  gammaUnit: 'per1PercentMove' | 'perPoint',
): ExposureShortcutInput {
  return {
    quotes: [
      {
        contract: {
          underlying: 'XYZ',
          expiry: '2026-07-17',
          ...resolvedExpiry('2026-07-17'),
          strike,
          type,
          style: 'european',
        },
        timestampMs: ASOF - 2 * HOUR_MS,
        openInterest: 1,
        impliedVolatility: 0.25,
        underlyingPrice: SPOT,
      },
    ],
    market: {
      spot: SPOT,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      asOf: new Date(asOfMs).toISOString(),
    },
    config: { convention: 'dealerShortGamma', gammaUnit },
  };
}

describe('color exposure is the change in GEX per day elapsed, in the gex unit', () => {
  for (const gammaUnit of ['per1PercentMove', 'perPoint'] as const) {
    it(`${gammaUnit}: equals the finite difference of the profile's own gex`, () => {
      for (const type of ['call', 'put'] as const) {
        for (const strike of [170, 200, 240]) {
          const color = colorExposure(oneContract(type, strike, ASOF, gammaUnit)).aggregate.color;
          const later = gammaExposure(oneContract(type, strike, ASOF + STEP_MS, gammaUnit));
          const earlier = gammaExposure(oneContract(type, strike, ASOF - STEP_MS, gammaUnit));
          expect(later.contracts).toHaveLength(1);
          expect(earlier.contracts).toHaveLength(1);
          const perDayElapsed =
            (later.aggregate.gex - earlier.aggregate.gex) / ((2 * STEP_MS) / 86_400_000);
          expect(color, `${type} ${strike}`).not.toBe(0);
          expect(Math.abs(color - perDayElapsed) / Math.abs(perDayElapsed)).toBeLessThan(1e-6);
        }
      }
    });
  }

  it('the two units differ by exactly the gex factor ratio, spot·0.01', () => {
    for (const type of ['call', 'put'] as const) {
      const perMove = exposure(oneContract(type, 210, ASOF, 'per1PercentMove')).aggregate;
      const perPoint = exposure(oneContract(type, 210, ASOF, 'perPoint')).aggregate;
      expect(perMove.gex / perPoint.gex).toBeCloseTo(SPOT * 0.01, 12);
      expect(perMove.color / perPoint.color).toBeCloseTo(SPOT * 0.01, 12);
    }
  });

  it('the full profile, the shortcut and a scenario cell agree on color in each unit', () => {
    for (const gammaUnit of ['per1PercentMove', 'perPoint'] as const) {
      const input = oneContract('call', 205, ASOF, gammaUnit);
      const full = exposure(input);
      const shortcut = colorExposure(input);
      expect(shortcut.aggregate.color).toBe(full.aggregate.color);
      const cell = full.scenarioMap({ spot: [SPOT], metrics: ['color'] }).cells[0]!;
      expect(cell.color).toBe(full.aggregate.color);
    }
  });
});
