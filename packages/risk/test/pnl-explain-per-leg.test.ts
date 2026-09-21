/**
 * Preview P1 — `PnlMarket.legVolatilities`: a leg with a fixed entry implied volatility that is
 * re-marked at a different current volatility reports a LIVE vega, attributed per leg, with the
 * sums invariant intact.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { explainPositionPnl } from '@totalfinance/risk';
import { strategy } from '@totalfinance/strategy';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const EXPIRY = '2026-06-19';
const position = strategy(
  [
    { kind: 'put', strike: 95, premium: 1.2, quantity: -1, impliedVolatility: 0.2, expiry: EXPIRY },
    { kind: 'put', strike: 90, premium: 0.5, quantity: 1, impliedVolatility: 0.2, expiry: EXPIRY },
  ],
  { multiplier: 100 },
);
const from = { spot: 100, riskFreeRate: 0.04, asOf: '2026-03-02T00:00:00Z', dividendYield: 0 };

describe('explainPositionPnl legVolatilities (Preview P1)', () => {
  it('attributes a per-leg volatility change to vega (fixed-IV legs are no longer inert) and still sums exactly', () => {
    // Same spot, same time: the ONLY move is each leg's volatility 0.20 → 0.25.
    const explain = explainPositionPnl({
      position,
      from: { ...from, legVolatilities: [0.2, 0.2] },
      to: { ...from, legVolatilities: [0.25, 0.25] },
    });
    expect(explain.assumptions['volatilityAttribution']).toBe('per-leg');
    expect(explain.vega).not.toBe(0);
    expect(Math.abs(explain.delta)).toBeLessThan(1e-9);
    expect(Math.abs(explain.theta)).toBeLessThan(1e-9);
    // First-order vega captures most of a 5-point vol move; vomma takes the rest with a small residual.
    expect(Math.abs(explain.vega + explain.vomma - explain.total)).toBeLessThan(
      0.05 * Math.abs(explain.total),
    );
    const terms =
      explain.delta +
      explain.gamma +
      explain.vega +
      explain.theta +
      explain.rho +
      explain.vanna +
      explain.vomma +
      explain.charm +
      explain.veta +
      explain.vera +
      explain.deltaRate +
      explain.thetaRate +
      explain.rhoConvexity +
      explain.thetaConvexity +
      explain.phi +
      explain.unexplained;
    expect(terms).toBeCloseTo(explain.total, 9);
    expect(explain.perLeg.map((l) => l.vega !== 0)).toEqual([true, true]);
  });

  it('without overrides the pre-P1 contract holds: a fixed-IV leg attributes against a zero vol move', () => {
    const explain = explainPositionPnl({
      position,
      from: { ...from, volatility: 0.2 },
      to: { ...from, volatility: 0.25 },
    });
    expect(explain.assumptions['volatilityAttribution']).toBe('position-level');
    expect(explain.vega).toBe(0);
    expect(explain.total).toBe(0);
  });

  it('validates the overrides: aligned to the legs, positive, closed keys', () => {
    expect(
      codeOf(() => explainPositionPnl({ position, from, to: { ...from, legVolatilities: [0.2] } })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        explainPositionPnl({ position, from, to: { ...from, legVolatilities: [0.2, -1] } }),
      ),
    ).toBe(ErrorCode.InputNegativeVolatility);
    expect(
      codeOf(() =>
        explainPositionPnl({ position, from, to: { ...from, legVolatility: [0.2, 0.2] } as never }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});
