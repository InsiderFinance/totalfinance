import { describe, expect, it } from 'vitest';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';

// Central-difference reference for each higher-order Greek, expressed via the first-order Greeks in
// RAW units (vega/rho are returned per-1%, so multiply back by 100; theta is per-day, ×365).
const cases = [
  { type: 'call' as const, S: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2 },
  { type: 'put' as const, S: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2 },
  { type: 'call' as const, S: 95, K: 110, T: 0.5, r: 0.03, q: 0.02, sigma: 0.35 },
  { type: 'put' as const, S: 120, K: 90, T: 2, r: 0.04, q: 0.01, sigma: 0.18 },
];

describe('blackScholesExtendedGreeks match finite differences of the first-order Greeks', () => {
  for (const c of cases) {
    it(`${c.type} S=${c.S} K=${c.K} T=${c.T}`, () => {
      const x = blackScholesExtendedGreeks({
        type: c.type,
        spot: c.S,
        strike: c.K,
        timeToExpiryYears: c.T,
        riskFreeRate: c.r,
        dividendYield: c.q,
        volatility: c.sigma,
      });
      const g = (S = c.S, sig = c.sigma, T = c.T): ReturnType<typeof blackScholesGreeks> =>
        blackScholesGreeks({
          type: c.type,
          spot: S,
          strike: c.K,
          timeToExpiryYears: T,
          riskFreeRate: c.r,
          dividendYield: c.q,
          volatility: sig,
        });

      const spotStep = c.S * 1e-5;
      const volatilityStep = 1e-5;
      const timeStepYears = 1e-5;

      // vanna = ∂delta/∂σ
      const vanna =
        (g(c.S, c.sigma + volatilityStep).delta - g(c.S, c.sigma - volatilityStep).delta) /
        (2 * volatilityStep);
      // vomma = ∂vegaRaw/∂σ   (vega is per-1%, so ×100 to raw)
      const vomma =
        ((g(c.S, c.sigma + volatilityStep).vega - g(c.S, c.sigma - volatilityStep).vega) * 100) /
        (2 * volatilityStep);
      // speed = ∂gamma/∂S
      const speed = (g(c.S + spotStep).gamma - g(c.S - spotStep).gamma) / (2 * spotStep);
      // charm = ∂delta/∂T
      const charm =
        (g(c.S, c.sigma, c.T + timeStepYears).delta - g(c.S, c.sigma, c.T - timeStepYears).delta) /
        (2 * timeStepYears);
      // color = ∂gamma/∂T
      const color =
        (g(c.S, c.sigma, c.T + timeStepYears).gamma - g(c.S, c.sigma, c.T - timeStepYears).gamma) /
        (2 * timeStepYears);

      expect(x.vanna).toBeCloseTo(vanna, 5);
      expect(x.vomma).toBeCloseTo(vomma, 3);
      expect(x.speed).toBeCloseTo(speed, 6);
      expect(x.charm).toBeCloseTo(charm, 5);
      expect(x.color).toBeCloseTo(color, 5);

      // ── the six added greeks ──
      const P = (q = c.q) =>
        blackScholesPrice({
          type: c.type,
          spot: c.S,
          strike: c.K,
          timeToExpiryYears: c.T,
          riskFreeRate: c.r,
          dividendYield: q,
          volatility: c.sigma,
        });
      const X = (sig: number): ReturnType<typeof blackScholesExtendedGreeks> =>
        blackScholesExtendedGreeks({
          type: c.type,
          spot: c.S,
          strike: c.K,
          timeToExpiryYears: c.T,
          riskFreeRate: c.r,
          dividendYield: c.q,
          volatility: sig,
        });
      const dividendYieldStep = 1e-6;
      // phi = ∂V/∂q, stored per 1% (÷100)
      const phi =
        (P(c.q + dividendYieldStep) - P(c.q - dividendYieldStep)) / (2 * dividendYieldStep) / 100;
      // zomma = ∂gamma/∂σ
      const zomma =
        (g(c.S, c.sigma + volatilityStep).gamma - g(c.S, c.sigma - volatilityStep).gamma) /
        (2 * volatilityStep);
      // veta = ∂vegaRaw/∂T   (vega per-1% → ×100)
      const veta =
        ((g(c.S, c.sigma, c.T + timeStepYears).vega - g(c.S, c.sigma, c.T - timeStepYears).vega) *
          100) /
        (2 * timeStepYears);
      // vera = ∂rhoRaw/∂σ   (rho per-1% → ×100)
      const vera =
        ((g(c.S, c.sigma + volatilityStep).rho - g(c.S, c.sigma - volatilityStep).rho) * 100) /
        (2 * volatilityStep);
      // ultima = ∂vomma/∂σ
      const ultima =
        (X(c.sigma + volatilityStep).vomma - X(c.sigma - volatilityStep).vomma) /
        (2 * volatilityStep);
      // lambda = Δ·S/V
      const lambda = (g().delta * c.S) / P();

      expect(x.phi).toBeCloseTo(phi, 4);
      expect(x.zomma).toBeCloseTo(zomma, 4);
      expect(x.veta).toBeCloseTo(veta, 2);
      expect(x.vera).toBeCloseTo(vera, 3);
      expect(x.ultima).toBeCloseTo(ultima, 2);
      expect(x.lambda).toBeCloseTo(lambda, 10);
    });
  }

  it('put/call vanna, vomma, speed, color are equal; charm differs by q·e^{-qT}', () => {
    const p = { S: 100, K: 105, T: 0.75, r: 0.04, q: 0.03, sigma: 0.25 };
    const call = blackScholesExtendedGreeks({
      type: 'call',
      spot: p.S,
      strike: p.K,
      timeToExpiryYears: p.T,
      riskFreeRate: p.r,
      dividendYield: p.q,
      volatility: p.sigma,
    });
    const put = blackScholesExtendedGreeks({
      type: 'put',
      spot: p.S,
      strike: p.K,
      timeToExpiryYears: p.T,
      riskFreeRate: p.r,
      dividendYield: p.q,
      volatility: p.sigma,
    });
    expect(put.vanna).toBeCloseTo(call.vanna, 10);
    expect(put.vomma).toBeCloseTo(call.vomma, 10);
    expect(put.speed).toBeCloseTo(call.speed, 10);
    expect(put.color).toBeCloseTo(call.color, 10);
    expect(put.charm - call.charm).toBeCloseTo(p.q * Math.exp(-p.q * p.T), 10);
  });

  it('the added greeks obey put/call parity relations', () => {
    const p = { S: 100, K: 105, T: 0.75, r: 0.04, q: 0.03, sigma: 0.25 };
    const call = blackScholesExtendedGreeks({
      type: 'call',
      spot: p.S,
      strike: p.K,
      timeToExpiryYears: p.T,
      riskFreeRate: p.r,
      dividendYield: p.q,
      volatility: p.sigma,
    });
    const put = blackScholesExtendedGreeks({
      type: 'put',
      spot: p.S,
      strike: p.K,
      timeToExpiryYears: p.T,
      riskFreeRate: p.r,
      dividendYield: p.q,
      volatility: p.sigma,
    });
    // gamma/vega/vomma are put=call ⇒ so are their σ/T derivatives.
    expect(put.zomma).toBeCloseTo(call.zomma, 10); // ∂γ/∂σ
    expect(put.veta).toBeCloseTo(call.veta, 8); // ∂vega/∂T
    expect(put.ultima).toBeCloseTo(call.ultima, 8); // ∂vomma/∂σ
    // rho_call − rho_put = K·T·e^{−rT} is σ-independent ⇒ vera (∂rho/∂σ) is put=call.
    expect(put.vera).toBeCloseTo(call.vera, 10);
    // ε_put − ε_call = ∂(V_put − V_call)/∂q = S·T·e^{−qT}, per 1% (÷100).
    expect(put.phi - call.phi).toBeCloseTo((p.S * p.T * Math.exp(-p.q * p.T)) / 100, 10);
    // lambda differs (different delta and price); a long call is levered long, a put levered short.
    expect(call.lambda).toBeGreaterThan(0);
    expect(put.lambda).toBeLessThan(0);
  });
});
