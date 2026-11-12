import { expect, it } from 'vitest';
import { black76 } from '@totalfinance/options/black76';
import { blackScholes } from '@totalfinance/options/black-scholes';
import { spread } from '@totalfinance/options';
const exchange = {
  type: 'call' as const,
  spot1: 1 + 1e-10,
  spot2: 1,
  strike: 0,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  dividendYield1: 0,
  dividendYield2: 0,
  volatility1: 0.2000000001,
  volatility2: 0.2,
  correlation: 1,
};
for (const [type, expected] of [
  ['call', 1.08331549307335068415e-10],
  ['put', 8.33154103329796850623e-12],
] as const)
  it(`uses exact common-carry cancellation for a near-offset ${type} exchange`, () => {
    // 150-digit Margrabe evaluation at the actual binary64 inputs. K=0 cancels r.
    for (const riskFreeRate of [-0.02, 0.05, 0.3]) {
      const r = spread.price({ ...exchange, type, riskFreeRate });
      expect(r.value / expected).toBeCloseTo(1, 12);
      expect(r.diagnostics.converged).toBe(true);
    }
  });
it('resolves tiny exchange premiums without treating rounded forwards as exact ATM', () => {
  const r = spread.price({ ...exchange, spot1: 1 + Number.EPSILON, volatility1: 0.2 + 3e-16 });
  expect(r.value / 2.6368777392589163e-16).toBeCloseTo(1, 12);
});
it('keeps an ordinary carry-bearing ITM option when its intrinsic value is well resolved', () => {
  const t = {
    type: 'call' as const,
    spot: 100,
    strike: 100 * Math.exp(0.03) * Math.exp(-1e-6),
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0.02,
    volatility: 1e-7,
  };
  expect(blackScholes.price(t) / 9.801981830642707e-5).toBeCloseTo(1, 8);
});

it('checks intrinsic sensitivity before the a>55 shortcut', () => {
  const t = {
    type: 'call' as const,
    spot: 100,
    strike: 100 * Math.exp(0.03) * Math.exp(-2e-14),
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0.02,
    volatility: 1e-16,
  };
  expect(() => blackScholes.price(t)).toThrowError(
    expect.objectContaining({
      code: 'input.out_of_range',
      context: expect.objectContaining({ reason: 'analytic_premium_cancellation' }),
    }),
  );
});
it('does not call rounded computed-forward equality an exact tiny-volatility ATM spread', () => {
  const k = 0.2,
    a = Math.exp(0.05) / (Math.exp(0.05) + k);
  const t = {
    ...exchange,
    spot1: 1 + k * Math.exp(-0.05),
    strike: k,
    volatility1: 0.2 * a + 1e-16,
  };
  expect(() => spread.price(t)).toThrowError(
    expect.objectContaining({
      code: 'input.out_of_range',
      context: expect.objectContaining({ reason: 'analytic_premium_cancellation' }),
    }),
  );
});

for (const facade of [blackScholes, black76])
  it('preserves repairable precision teaching through an IV facade', () => {
    const t =
      facade === blackScholes
        ? {
            type: 'call' as const,
            spot: 100,
            strike: 100,
            timeToExpiryYears: 1,
            riskFreeRate: -1000,
            dividendYield: 0,
            price: 10,
          }
        : {
            type: 'call' as const,
            forward: 100,
            strike: 100,
            timeToExpiryYears: 1,
            riskFreeRate: -1000,
            price: 10,
          };
    const report = facade.impliedVolatility.explain(t as never);
    expect(report.value).toBeNull();
    expect(report.diagnostics.converged).toBe(false);
    expect(report.diagnostics.warnings).toContainEqual(
      expect.objectContaining({
        code: 'implied_volatility.no_convergence',
        message: expect.stringMatching(/binary64 precision/),
        context: expect.objectContaining({ reason: 'no_bracket' }),
      }),
    );
    expect(() => facade.impliedVolatility(t as never)).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/binary64 precision/) }),
    );
  });
for (const type of ['call', 'put'] as const)
  it(`guards ${type} intrinsic sensitivity on both sides of a=55`, () => {
    for (const a of [54, 56, 200]) {
      const direction = type === 'call' ? -1 : 1;
      const t = {
        type,
        spot: 100,
        strike: 100 * Math.exp(0.03) * Math.exp(direction * a * 1e-16),
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield: 0.02,
        volatility: 1e-16,
      };
      expect(() => blackScholes.price(t)).toThrowError(
        expect.objectContaining({ code: 'input.out_of_range' }),
      );
    }
  });
