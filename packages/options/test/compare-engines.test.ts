import { describe, expect, it } from 'vitest';
import {
  compareEngines,
  engines,
  market,
  option,
  type OptionImpliedVolatilityBatchColumns,
  type OptionPricingEngine,
} from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { blackScholesImpliedVolatilityMany } from '@totalfinance/options/batch';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2027-01-01'; // T = 1
const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

describe('compareEngines', () => {
  it('benchmarks the default panel against a high-resolution reference, sorted by accuracy', () => {
    const contract = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const cmp = compareEngines({ contract, market: mkt });

    expect(cmp.reference.engine).toBe('binomial-leisen-reimer');
    expect(cmp.rows.length).toBeGreaterThanOrEqual(5); // CRR, LR, trinomial, BAW, BS, CN
    // Rows are sorted most-accurate first.
    for (let i = 1; i < cmp.rows.length; i++) {
      expect(cmp.rows[i]!.absoluteDifferenceFromReference!).toBeGreaterThanOrEqual(
        cmp.rows[i - 1]!.absoluteDifferenceFromReference!,
      );
    }
    // Every engine in the panel converges close to the reference and reports diagnostics.
    for (const row of cmp.rows) {
      expect(row.converged).toBe(true);
      expect(row.absoluteDifferenceFromReference).toBeLessThan(0.2);
      expect(typeof row.method).toBe('string');
      expect(row.greeks!.delta).toBeLessThan(0); // analytic/lattice engines compute Greeks; put delta < 0
      expect(Array.isArray(row.warnings)).toBe(true);
      expect(row.timingMs).toBe(0); // pure by default: no system-clock read
    }
  });

  it('measures timing only when a clock is injected (pure compute by default)', () => {
    const contract = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    let ticks = 0;
    const now = (): number => ticks++; // deterministic injected clock (no system clock)
    const cmp = compareEngines({ contract, market: mkt, options: { now } });
    // Each engine advances the injected clock by exactly 1 tick (start→end), so timing is recorded.
    for (const row of cmp.rows) expect(row.timingMs).toBe(1);
  });

  it('includes Black–Scholes only for European contracts and respects a custom panel', () => {
    const euro = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const cmp = compareEngines({ contract: euro, market: mkt });
    expect(cmp.rows.some((r) => r.engine === 'black-scholes-merton')).toBe(true);

    const custom = compareEngines({
      contract: euro,
      market: mkt,
      options: {
        engines: [engines.binomial({ variant: 'crr', steps: 200 })],
        reference: engines.blackScholesMerton(),
      },
    });
    expect(custom.reference.engine).toBe('black-scholes-merton');
    expect(custom.rows).toHaveLength(1);
    expect(custom.rows[0]!.engine).toBe('binomial-crr');
  });

  it('accepts a custom engine panel with an optional reference override', () => {
    const contract = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const cmp = compareEngines({
      contract,
      market: mkt,
      options: {
        engines: [
          engines.bjerksundStensland(),
          engines.baroneAdesiWhaley(),
          engines.binomial({ variant: 'crr', steps: 500 }),
          engines.finiteDifference.crankNicolson({ gridPoints: 300, timeSteps: 300 }),
        ],
      },
    });
    expect(cmp.rows).toHaveLength(4);
    expect(cmp.rows.map((r) => r.engine).sort()).toEqual(
      ['barone-adesi-whaley', 'binomial-crr', 'bjerksund-stensland', 'crank-nicolson'].sort(),
    );

    const withRef = compareEngines({
      contract,
      market: mkt,
      options: {
        engines: [engines.binomial({ variant: 'crr', steps: 500 })],
        reference: engines.binomial({ variant: 'leisen-reimer', steps: 801 }),
      },
    });
    expect(withRef.reference.engine).toBe('binomial-leisen-reimer');
    expect(withRef.rows).toHaveLength(1);
  });

  it('is reachable via the option namespace', () => {
    const contract = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    expect(option.compareEngines({ contract, market: mkt }).rows.length).toBeGreaterThan(0);
  });

  it('turns a throwing engine into a converged:false row instead of aborting the comparison', () => {
    const contract = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    // NOT built via defineOptionPricingEngine — its behavioral smoke test (E6) rightly rejects an
    // engine that can't price anything. This is the runtime-failure case: an engine that passed
    // definition but throws on a specific contract; compareEngines must degrade it to a row.
    const broken: OptionPricingEngine = {
      name: 'broken',
      version: '0.0.1',
      capabilities: {
        styles: ['european'],
        dividends: ['none'],
        greeks: 'none',
        extendedGreeks: false,
        deterministic: true,
      },
      supports: () => true,
      price: () => {
        throw new Error('boom');
      },
    };
    const cmp = compareEngines({
      contract,
      market: mkt,
      options: { engines: [engines.binomial({ steps: 200 }), broken] },
    });
    expect(cmp.rows).toHaveLength(2);
    const brokenRow = cmp.rows.find((r) => r.engine === 'broken')!;
    expect(brokenRow.converged).toBe(false);
    expect(brokenRow.value).toBeNull();
    expect(brokenRow.warnings[0]?.message).toMatch(/boom/);
    // The failed engine sorts last; the good engine still produced a real value.
    expect(cmp.rows[cmp.rows.length - 1]!.engine).toBe('broken');
    expect(Number.isFinite(cmp.rows[0]!.value)).toBe(true);
  });
});

describe('blackScholesImpliedVolatilityMany (columnar chain IV)', () => {
  it('round-trips a chain of prices back to the input volatilities', () => {
    const strikes = [80, 90, 100, 110, 120];
    const trueVols = [0.28, 0.24, 0.2, 0.22, 0.26];
    const n = strikes.length;
    const spot = new Float64Array(n).fill(100);
    const rate = new Float64Array(n).fill(0.05);
    const t = new Float64Array(n).fill(0.5);
    const strike = Float64Array.from(strikes);
    const type = Int8Array.from(strikes.map((k) => (k >= 100 ? 1 : 0))); // OTM calls/puts
    const price = Float64Array.from(
      strikes.map((k, i) =>
        blackScholesPrice({
          type: k >= 100 ? 'call' : 'put',
          spot: 100,
          strike: k,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.05,
          dividendYield: 0,
          volatility: trueVols[i]!,
        }),
      ),
    );

    const cols: OptionImpliedVolatilityBatchColumns = {
      price,
      spot,
      strike,
      riskFreeRate: rate,
      timeToExpiryYears: t,
      type,
    };
    const res = blackScholesImpliedVolatilityMany(cols);

    for (let i = 0; i < n; i++) {
      expect(res.converged[i]).toBe(1);
      expect(res.impliedVolatility[i]!).toBeCloseTo(trueVols[i]!, 6);
      expect(res.reasons[i]).toBeUndefined();
    }
  });

  it('reports a machine-readable reason for an unsolvable (below-intrinsic) price', () => {
    const cols: OptionImpliedVolatilityBatchColumns = {
      price: Float64Array.from([0.5]), // below intrinsic for an ITM call (S=100,K=80)
      spot: Float64Array.from([100]),
      strike: Float64Array.from([80]),
      riskFreeRate: Float64Array.from([0.05]),
      timeToExpiryYears: Float64Array.from([1]),
      type: Int8Array.from([1]),
    };
    const res = blackScholesImpliedVolatilityMany(cols);
    expect(res.converged[0]).toBe(0);
    expect(Number.isNaN(res.impliedVolatility[0]!)).toBe(true);
    expect(res.reasons[0]).toBe('below_intrinsic');
  });

  it('rejects a malformed row up front rather than mislabeling it as max_iterations', () => {
    const cols: OptionImpliedVolatilityBatchColumns = {
      price: Float64Array.from([5]),
      spot: Float64Array.from([NaN]), // malformed input, not an unsolvable price
      strike: Float64Array.from([100]),
      riskFreeRate: Float64Array.from([0.05]),
      timeToExpiryYears: Float64Array.from([1]),
      type: Int8Array.from([1]),
    };
    expect(() => blackScholesImpliedVolatilityMany(cols)).toThrow();
  });
});
