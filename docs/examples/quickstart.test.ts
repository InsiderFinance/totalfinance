import { describe, expect, it } from 'vitest';
import { engines, market, option } from '@insiderfinance/totalfinance/options';
import { blackScholes } from '@insiderfinance/totalfinance/options/black-scholes';
import { schemas } from '@insiderfinance/totalfinance/options/schema';

describe('documentation quickstart examples', () => {
  it('prices through the facade and explains assumptions', () => {
    const input = {
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
    };

    const price = blackScholes.call(input);
    const explained = blackScholes.call.explain(input);

    expect(price).toBeGreaterThan(0);
    expect(explained.value).toBe(price);
    expect(explained.assumptions.dayCount).toBe('ACT/365F');
    expect(explained.assumptions.compounding).toBe('continuous');
    expect(explained.diagnostics.converged).toBe(true);
  });

  it('prices through the pro API', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'AAPL',
      strike: 100,
      expiry: '2026-09-18',
      style: 'european',
    });

    const result = option.price({
      contract,
      market: market({
        spot: 96.5,
        riskFreeRate: 0.045,
        dividendYield: 0.012,
        volatility: 0.28,
        asOf: Date.UTC(2026, 5, 18),
      }),
      engine: engines.blackScholesMerton(),
    });

    expect(result.value).toBeGreaterThan(0);
    expect(result.greeks!.delta).toBeGreaterThan(0);
    expect(result.assumptions.engine).toBe('black-scholes-merton');
    expect(result.diagnostics.converged).toBe(true);
  });

  it('validates a BUILT contract with the schema entrypoint (the schema is the resolved artifact)', () => {
    // The builders produce exactly what the schema validates — build first, then validate (D2).
    const contract = option.european({
      convention: 'us-equity-close',
      type: 'call',
      underlying: 'AAPL',
      strike: 100,
      expiry: '2026-09-18',
    });
    const parsed = schemas.OptionContract.parse(contract);
    expect(parsed.underlying).toBe('AAPL');
    expect(Number.isFinite(parsed.expiresAt)).toBe(true);
  });
});
