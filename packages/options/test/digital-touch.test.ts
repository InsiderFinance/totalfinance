/**
 * Digital (binary) and one-touch / no-touch options. The closed forms are pinned by exact identities —
 * a vanilla call decomposes as asset-or-nothing − K·cash-or-nothing; cash-or-nothing call + put =
 * cash·e^{−rT}; one-touch@expiry + no-touch = cash·e^{−rT}; and (the decisive one) at r=0 the
 * Reiner–Rubinstein pay-at-hit value equals the first-passage pay-at-expiry value — and each analytic is
 * corroborated by its Monte-Carlo engine (the touch pay-at-expiry MC uses the Brownian-bridge survival).
 */

import { describe, expect, it } from 'vitest';
import { digital, touch } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const INP = {
  spot: 100,
  strike: 100,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  volatility: 0.25,
  dividendYield: 0.02,
};

describe('digital — European binaries', () => {
  it('a vanilla call decomposes as asset-or-nothing − K·cash-or-nothing (exact)', () => {
    const aon = digital.price({ ...INP, type: 'call', kind: 'asset-or-nothing' }).value;
    const con = digital.price({ ...INP, type: 'call', kind: 'cash-or-nothing' }).value;
    const bsm = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0.02,
      volatility: 0.25,
    });
    expect(aon - 100 * con).toBeCloseTo(bsm, 10);

    const aonP = digital.price({ ...INP, type: 'put', kind: 'asset-or-nothing' }).value;
    const conP = digital.price({ ...INP, type: 'put', kind: 'cash-or-nothing' }).value;
    const blackScholesP = blackScholesPrice({
      type: 'put',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0.02,
      volatility: 0.25,
    });
    expect(-(aonP - 100 * conP)).toBeCloseTo(blackScholesP, 10); // put decomposition: BSM put = K·CoN put − AoN put
  });

  it('cash-or-nothing call + put = cash·e^{−rT} (something finishes on one side)', () => {
    const con = digital.price({ ...INP, type: 'call', kind: 'cash-or-nothing' }).value;
    const conP = digital.price({ ...INP, type: 'put', kind: 'cash-or-nothing' }).value;
    expect(con + conP).toBeCloseTo(Math.exp(-0.05), 10);
  });

  it('the cash payout scales the cash-or-nothing value linearly', () => {
    const one = digital.price({ ...INP, type: 'call', kind: 'cash-or-nothing' }).value;
    const five = digital.price({ type: 'call', kind: 'cash-or-nothing', ...INP, cash: 5 }).value;
    expect(five).toBeCloseTo(5 * one, 10);
  });

  it('Monte-Carlo converges to the analytic (cash and asset)', () => {
    const monteCarlo = { paths: 200_000, seed: 42 };
    for (const kind of ['cash-or-nothing', 'asset-or-nothing'] as const) {
      const a = digital.price({ ...INP, type: 'call', kind }).value;
      const m = digital.monteCarloPrice({ ...INP, type: 'call', kind }, monteCarlo);
      expect(Math.abs(m.value - a)).toBeLessThan(5 * m.monteCarlo.standardError!);
    }
  });

  it('guards bad enums and inputs', () => {
    expect(() =>
      digital.price({ ...INP, type: 'bogus', kind: 'cash-or-nothing' } as never),
    ).toThrowError();
    expect(() => digital.price({ ...INP, type: 'call', kind: 'bogus' } as never)).toThrowError();
    expect(() =>
      digital.price({ type: 'call', kind: 'cash-or-nothing', ...INP, spot: -1 }),
    ).toThrowError();
    expect(() => digital.price(undefined as never)).toThrowError();
  });
});

describe('touch — one-touch / no-touch', () => {
  const ti = (barrier: number, extra = {}) => ({
    spot: 100,
    barrier,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
    dividendYield: 0.02,
    ...extra,
  });

  it('one-touch@expiry + no-touch = cash·e^{−rT} (one of them always pays)', () => {
    for (const H of [80, 120]) {
      const ot = touch.price({ ...ti(H), kind: 'one-touch' }).value;
      const nt = touch.price({ ...ti(H), kind: 'no-touch' }).value;
      expect(ot + nt).toBeCloseTo(Math.exp(-0.05), 10);
    }
  });

  it('at r=0 the pay-at-hit value equals the first-passage pay-at-expiry value (Reiner–Rubinstein check)', () => {
    for (const H of [80, 90, 115, 130]) {
      const t0 = ti(H, { riskFreeRate: 0, dividendYield: 0 });
      const expiry = touch.price({ ...t0, kind: 'one-touch' }).value;
      const hit = touch.price({ kind: 'one-touch', ...t0, payAt: 'hit' as const }).value;
      expect(hit).toBeCloseTo(expiry, 10);
    }
  });

  it('for r>0 paying at the hit is worth more than paying at expiry', () => {
    const expiry = touch.price({ ...ti(120, { riskFreeRate: 0.06 }), kind: 'one-touch' }).value;
    const hit = touch.price({
      ...ti(120, { riskFreeRate: 0.06, payAt: 'hit' }),
      kind: 'one-touch',
    }).value;
    expect(hit).toBeGreaterThan(expiry);
  });

  it('the Brownian-bridge Monte-Carlo (pay-at-expiry) converges to the touch analytic', () => {
    const monteCarlo = { paths: 60_000, seed: 7, steps: 200 };
    for (const H of [80, 120]) {
      const a = touch.price({ ...ti(H), kind: 'one-touch' }).value;
      const m = touch.monteCarloPrice({ ...ti(H), kind: 'one-touch' }, monteCarlo);
      expect(Math.abs(m.value - a)).toBeLessThan(0.01);
    }
  });

  it('the pay-at-hit Monte-Carlo (first-crossing) matches the Reiner–Rubinstein analytic to MC error', () => {
    // The discrete first-crossing MC used to under-detect touches — it only sees the barrier at
    // monitoring dates and misses every excursion that crosses and returns between them — which put
    // it >8 standard errors BELOW the continuous analytic. With the Broadie–Glasserman–Kou
    // continuity correction (the same one the barrier engines already apply) the grid reproduces the
    // continuous first-passage probability, so the two agree to Monte-Carlo error in BOTH directions.
    const a = touch.price({ ...ti(120, { payAt: 'hit' }), kind: 'one-touch' }).value;
    const m = touch.monteCarloPrice(
      { ...ti(120, { payAt: 'hit' }), kind: 'one-touch' },
      {
        paths: 40_000,
        seed: 11,
        steps: 500,
      },
    );
    expect(m.value).toBeGreaterThan(0);
    expect(Math.abs(m.value - a)).toBeLessThan(2 * m.monteCarlo.standardError!);
  });

  it('a pay-at-hit one-touch refuses when its discount exponent has no real solution', () => {
    // r = −2% with q = −4% ⇒ carry b = +2%, μ = 0, and μ² + 2r/σ² = −1: λ = √(negative) = NaN, which
    // used to become the returned "price". Discounting at a negative rate grows the rebate faster
    // than the hitting time can arrive, so E[e^{−rτ}] genuinely diverges.
    let thrown: { code?: string; message?: string } = {};
    try {
      touch.price({
        spot: 100,
        barrier: 120,
        timeToExpiryYears: 1,
        riskFreeRate: -0.02,
        dividendYield: -0.04,
        volatility: 0.2,
        payAt: 'hit',
        kind: 'one-touch',
      });
      expect.unreachable('the pay-at-hit one-touch must refuse a divergent discount');
    } catch (error) {
      thrown = error as { code?: string; message?: string };
    }
    expect(thrown.code).toBe('engine.unsupported_contract');
    expect(thrown.message).toMatch(/μ² \+ 2r\/σ² ≥ 0/);
    expect(thrown.message).toMatch(/payAt: 'expiry'/);

    // The expiry-settled form is bounded by cash·e^{−rT} and still prices at the same inputs.
    const expiry = touch.price({
      spot: 100,
      barrier: 120,
      timeToExpiryYears: 1,
      riskFreeRate: -0.02,
      dividendYield: -0.04,
      volatility: 0.2,
      kind: 'one-touch',
    });
    expect(expiry.value).toBeGreaterThan(0);
    expect(expiry.value).toBeLessThanOrEqual(Math.exp(0.02));

    // A negative rate that keeps the discriminant non-negative still prices at the hit.
    const stillPrices = touch.price({
      spot: 100,
      barrier: 120,
      timeToExpiryYears: 1,
      riskFreeRate: -0.02,
      dividendYield: 0.1,
      volatility: 0.2,
      payAt: 'hit',
      kind: 'one-touch',
    });
    expect(stillPrices.value).toBeGreaterThan(0);
  });

  it('a closer barrier is more likely to be touched', () => {
    const near = touch.price({ ...ti(110), kind: 'one-touch' }).value; // 10% away
    const far = touch.price({ ...ti(130), kind: 'one-touch' }).value; // 30% away
    expect(near).toBeGreaterThan(far);
  });

  it('an already-touched spot (S = H) short-circuits to the certain payoff', () => {
    expect(touch.price({ ...ti(100), kind: 'one-touch' }).value).toBeCloseTo(Math.exp(-0.05), 12); // pay at expiry
    expect(touch.price({ ...ti(100, { payAt: 'hit' }), kind: 'one-touch' }).value).toBe(1); // pay at hit, now
    expect(touch.price({ ...ti(100), kind: 'no-touch' }).value).toBe(0); // never survives
  });

  it("rejects payAt:'hit' for a no-touch (there is no hit to pay on)", () => {
    expect(() => touch.price({ ...ti(120, { payAt: 'hit' }), kind: 'no-touch' })).toThrowError();
    expect(() =>
      touch.monteCarloPrice(
        { ...ti(120, { payAt: 'hit' }), kind: 'no-touch' },
        { paths: 1000, seed: 1 },
      ),
    ).toThrowError();
  });

  it('guards bad enums and inputs', () => {
    expect(() => touch.price({ ...ti(120), kind: 'bogus' } as never)).toThrowError();
    expect(() => touch.price({ ...ti(-1), kind: 'one-touch' })).toThrowError();
    expect(() =>
      touch.price({ ...ti(120, { payAt: 'bogus' }), kind: 'one-touch' } as never),
    ).toThrowError();
  });
});
