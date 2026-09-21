/**
 * Digital (binary) greeks (`digital.greeks`). Every closed-form greek is pinned to a central
 * finite-difference bump of the exact `digital.price` (both kinds, both types, across moneyness); the
 * greeks satisfy the vanilla decomposition `vanilla = asset − K·cash`; the asset-or-nothing gamma/vega are
 * exactly 0 at `d₂ = 0`; the units are echoed; and the guards hold.
 */

import { describe, expect, it } from 'vitest';
import { digital, type DigitalKind } from '@totalfinance/options';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
} from '@totalfinance/options/black-scholes';
import { DEFAULT_GREEK_UNITS } from '@totalfinance/core';
import type { OptionType } from '@totalfinance/options';

const K = 100;
const T = 0.5;
const R = 0.03;
const Q = 0.01;
const SIG = 0.2;
const inp = (spot: number, vol = SIG, t = T, rate = R, q = Q) => ({
  spot,
  strike: K,
  timeToExpiryYears: t,
  riskFreeRate: rate,
  volatility: vol,
  dividendYield: q,
  cash: 1,
});
const px = (
  type: OptionType,
  kind: DigitalKind,
  spot: number,
  vol = SIG,
  t = T,
  rate = R,
  q = Q,
): number => digital.price({ ...inp(spot, vol, t, rate, q), type, kind }).value;

describe('digital.greeks', () => {
  it('matches a central finite-difference bump of digital.price for every greek', () => {
    const spotStep = 0.05;
    const hv = 1e-4;
    const hr = 1e-5;
    const timeStepYears = 1e-4;
    for (const kind of ['cash-or-nothing', 'asset-or-nothing'] as const) {
      for (const type of ['call', 'put'] as const) {
        for (const spot of [108, 100, 92]) {
          const g = digital.greeks({ ...inp(spot), type, kind }).value;
          const fdDelta =
            (px(type, kind, spot + spotStep) - px(type, kind, spot - spotStep)) / (2 * spotStep);
          const fdGamma =
            (px(type, kind, spot + spotStep) -
              2 * px(type, kind, spot) +
              px(type, kind, spot - spotStep)) /
            (spotStep * spotStep);
          const fdVega =
            (px(type, kind, spot, SIG + hv) - px(type, kind, spot, SIG - hv)) / (2 * hv) / 100;
          const fdTheta =
            -(
              (px(type, kind, spot, SIG, T + timeStepYears) -
                px(type, kind, spot, SIG, T - timeStepYears)) /
              (2 * timeStepYears)
            ) / 365;
          const fdRho =
            (px(type, kind, spot, SIG, T, R + hr) - px(type, kind, spot, SIG, T, R - hr)) /
            (2 * hr) /
            100;
          expect(g.delta).toBeCloseTo(fdDelta, 4);
          expect(g.gamma).toBeCloseTo(fdGamma, 4);
          expect(g.vega).toBeCloseTo(fdVega, 4);
          expect(g.theta).toBeCloseTo(fdTheta, 4);
          expect(g.rho).toBeCloseTo(fdRho, 4);
        }
      }
    }
  });

  it('satisfies the vanilla decomposition (call = asset − K·cash, put = K·cash − asset)', () => {
    // (S−K)⁺ = S·1{S>K} − K·1{S>K}; (K−S)⁺ = K·1{S<K} − S·1{S<K}.
    for (const type of ['call', 'put'] as const) {
      for (const spot of [108, 100, 92]) {
        const vanilla = blackScholesGreeks({
          type,
          spot,
          strike: K,
          timeToExpiryYears: T,
          riskFreeRate: R,
          dividendYield: Q,
          volatility: SIG,
        });
        const asset = digital.greeks({ ...inp(spot), type, kind: 'asset-or-nothing' }).value;
        const cash = digital.greeks({ ...inp(spot), type, kind: 'cash-or-nothing' }).value; // cash = 1
        for (const g of ['delta', 'gamma', 'vega', 'theta', 'rho'] as const) {
          const decomposed = type === 'call' ? asset[g] - K * cash[g] : K * cash[g] - asset[g];
          expect(decomposed).toBeCloseTo(vanilla[g], 9);
        }
      }
    }
  });

  it('cash-or-nothing gamma flips sign across the strike (pin risk)', () => {
    // With r − q − σ²/2 = 0 here, d₂ = 0 at the strike; gamma > 0 just below, < 0 just above.
    const below = digital.greeks({ ...inp(97), type: 'call', kind: 'cash-or-nothing' }).value.gamma;
    const above = digital.greeks({ ...inp(103), type: 'call', kind: 'cash-or-nothing' }).value
      .gamma;
    expect(below).toBeGreaterThan(0);
    expect(above).toBeLessThan(0);
  });

  it('the asset-or-nothing gamma and vega are exactly 0 where d₂ = 0', () => {
    // d₂ = 0 ⇔ S* = K·exp(−(r−q−σ²/2)T). Pick parameters so S* ≠ K.
    const r = 0.05;
    const q = 0.01;
    const sig = 0.3;
    const t = 1;
    const sStar = K * Math.exp(-(r - q - 0.5 * sig * sig) * t);
    for (const type of ['call', 'put'] as const) {
      const g = digital.greeks({
        ...inp(sStar, sig, t, r, q),
        type,
        kind: 'asset-or-nothing',
      }).value;
      expect(Math.abs(g.gamma)).toBeLessThan(1e-10);
      expect(Math.abs(g.vega)).toBeLessThan(1e-10);
    }
  });

  it('echoes the greek units and reports a finite, converged closed-form result', () => {
    const res = digital.greeks({ ...inp(100), type: 'put', kind: 'asset-or-nothing' });
    expect(res.assumptions.units).toEqual(DEFAULT_GREEK_UNITS);
    expect(res.diagnostics.method).toBe('closed-form-greeks');
    expect(res.diagnostics.converged).toBe(true);
    expect(Object.values(res.value).every((x) => Number.isFinite(x))).toBe(true);
  });

  it('guards a bad type/kind and the shared digital input validation', () => {
    expect(() => digital.greeks(undefined as never)).toThrowError();
    expect(() =>
      digital.greeks({ ...inp(100), type: 'nope', kind: 'cash-or-nothing' } as never),
    ).toThrowError();
    expect(() =>
      digital.greeks({ ...inp(100), type: 'call', kind: 'bad' } as never),
    ).toThrowError();
    expect(() =>
      digital.greeks({ ...inp(100, -0.2), type: 'call', kind: 'cash-or-nothing' }),
    ).toThrowError();
    expect(() =>
      digital.greeks({ type: 'call', kind: 'cash-or-nothing', ...inp(100), spot: -1 }),
    ).toThrowError();
  });
});

const EXT_KEYS = [
  'delta',
  'gamma',
  'theta',
  'vega',
  'rho',
  'vanna',
  'charm',
  'vomma',
  'speed',
  'color',
  'phi',
  'zomma',
  'veta',
  'vera',
  'ultima',
  'lambda',
] as const;

describe('digital.extendedGreeks', () => {
  it('its first-order fields are the exact analytic digital.greeks', () => {
    for (const kind of ['cash-or-nothing', 'asset-or-nothing'] as const) {
      for (const type of ['call', 'put'] as const) {
        const g = digital.greeks({ ...inp(103), type, kind }).value;
        const x = digital.extendedGreeks({ ...inp(103), type, kind }).value;
        for (const k of ['delta', 'gamma', 'vega', 'theta', 'rho'] as const) {
          expect(x[k]).toBeCloseTo(g[k], 12); // overridden with the analytic value
        }
        expect(EXT_KEYS.every((k) => Number.isFinite(x[k]))).toBe(true);
      }
    }
  });

  it('the higher-order greeks match a finite difference of the analytic digital greeks', () => {
    const hv = 1e-4;
    const timeStepYears = 1e-5;
    const hq = 1e-6;
    for (const kind of ['cash-or-nothing', 'asset-or-nothing'] as const) {
      for (const type of ['call', 'put'] as const) {
        for (const spot of [108, 92]) {
          const x = digital.extendedGreeks({ ...inp(spot), type, kind }).value;
          const gAt = (vol = SIG, t = T, q = Q) =>
            digital.greeks({ ...inp(spot, vol, t, R, q), type, kind }).value;
          // Relative closeness — these greeks can be O(10) near the pin, so a fixed-decimal bound is
          // fragile; both sides are finite differences (different step sizes) of the same quantity.
          const near = (got: number, exp: number): void =>
            expect(Math.abs(got - exp) / Math.max(Math.abs(exp), 1e-3)).toBeLessThan(1e-3);
          // vanna = ∂delta/∂σ, vomma = ∂vega_raw/∂σ, charm = ∂delta/∂T, zomma = ∂gamma/∂σ,
          // vera = ∂rho_raw/∂σ.
          near(x.vanna, (gAt(SIG + hv).delta - gAt(SIG - hv).delta) / (2 * hv));
          near(x.vomma, ((gAt(SIG + hv).vega - gAt(SIG - hv).vega) * 100) / (2 * hv));
          near(
            x.charm,
            (gAt(SIG, T + timeStepYears).delta - gAt(SIG, T - timeStepYears).delta) /
              (2 * timeStepYears),
          );
          near(x.zomma, (gAt(SIG + hv).gamma - gAt(SIG - hv).gamma) / (2 * hv));
          near(x.vera, ((gAt(SIG + hv).rho - gAt(SIG - hv).rho) * 100) / (2 * hv));
          // phi = ∂price/∂q (per 1%); lambda = Δ·S/V.
          near(
            x.phi,
            (px(type, kind, spot, SIG, T, R, Q + hq) - px(type, kind, spot, SIG, T, R, Q - hq)) /
              (2 * hq) /
              100,
          );
          expect(x.lambda).toBeCloseTo((x.delta * spot) / px(type, kind, spot), 6);
        }
      }
    }
  });

  it('the extended greeks satisfy the vanilla decomposition against blackScholesExtendedGreeks', () => {
    // Every LINEAR greek of the vanilla decomposes: call = asset − K·cash (lambda is Δ·S/V, nonlinear).
    const LINEAR = EXT_KEYS.filter((k) => k !== 'lambda');
    for (const type of ['call', 'put'] as const) {
      for (const spot of [108, 100, 92]) {
        const v = blackScholesExtendedGreeks({
          type,
          spot,
          strike: K,
          timeToExpiryYears: T,
          riskFreeRate: R,
          dividendYield: Q,
          volatility: SIG,
        });
        const asset = digital.extendedGreeks({
          ...inp(spot),
          type,
          kind: 'asset-or-nothing',
        }).value;
        const cash = digital.extendedGreeks({
          ...inp(spot),
          type,
          kind: 'cash-or-nothing',
        }).value; // cash = 1
        for (const g of LINEAR) {
          const dec = type === 'call' ? asset[g] - K * cash[g] : K * cash[g] - asset[g];
          // first-order analytic ⇒ tight; higher-order FD-vs-analytic ⇒ small relative tolerance.
          const tolerance = ['delta', 'gamma', 'vega', 'theta', 'rho'].includes(g) ? 1e-6 : 2e-2;
          expect(Math.abs(dec - v[g]) / Math.max(Math.abs(v[g]), 1e-3)).toBeLessThan(tolerance);
        }
      }
    }
  });

  it('echoes the greek units and guards its inputs', () => {
    const res = digital.extendedGreeks({ ...inp(100), type: 'put', kind: 'asset-or-nothing' });
    expect(res.assumptions.units).toEqual(DEFAULT_GREEK_UNITS);
    expect(res.diagnostics.method).toBe('analytic-first-order + fd-higher-order');
    expect(res.diagnostics.converged).toBe(true);
    expect(() =>
      digital.extendedGreeks({ ...inp(100), type: 'nope', kind: 'cash-or-nothing' } as never),
    ).toThrowError();
    expect(() =>
      digital.extendedGreeks({ ...inp(100), type: 'call', kind: 'bad' } as never),
    ).toThrowError();
    expect(() =>
      digital.extendedGreeks({ ...inp(100, -0.2), type: 'call', kind: 'cash-or-nothing' }),
    ).toThrowError();
  });
});
