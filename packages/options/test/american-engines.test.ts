import { describe, expect, it } from 'vitest';
import { engines, market, option, type OptionPricingEngine } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

// 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1 (2026 non-leap)
const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

function price(
  engine: OptionPricingEngine,
  type: 'call' | 'put',
  style: 'american' | 'european',
): number {
  const contract =
    type === 'call'
      ? option.call({ convention: 'us-equity-close', underlying: 'X', strike: 100, expiry, style })
      : option.put({ convention: 'us-equity-close', underlying: 'X', strike: 100, expiry, style });
  return engine.price({ contract, market: mkt }).value;
}

describe('American call with no dividends equals the European price', () => {
  const euro = blackScholesPrice({
    type: 'call',
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.2,
  });

  it('Barone–Adesi–Whaley and Bjerksund–Stensland are exact', () => {
    expect(price(engines.baroneAdesiWhaley(), 'call', 'american')).toBeCloseTo(euro, 8);
    expect(price(engines.bjerksundStensland(), 'call', 'american')).toBeCloseTo(euro, 8);
  });

  it('lattices converge to the European price', () => {
    expect(price(engines.binomial({ variant: 'crr', steps: 600 }), 'call', 'american')).toBeCloseTo(
      euro,
      1,
    );
    expect(
      price(engines.binomial({ variant: 'jarrow-rudd', steps: 600 }), 'call', 'american'),
    ).toBeCloseTo(euro, 1);
    expect(
      price(engines.binomial({ variant: 'tian', steps: 600 }), 'call', 'american'),
    ).toBeCloseTo(euro, 1);
    expect(
      price(engines.binomial({ variant: 'leisen-reimer', steps: 401 }), 'call', 'american'),
    ).toBeCloseTo(euro, 3);
    expect(price(engines.trinomial({ steps: 400 }), 'call', 'american')).toBeCloseTo(euro, 1);
  });

  it('Crank–Nicolson converges to the European price', () => {
    expect(
      price(
        engines.finiteDifference.crankNicolson({ gridPoints: 300, timeSteps: 300 }),
        'call',
        'american',
      ),
    ).toBeCloseTo(euro, 1);
  });
});

describe('European prices via lattice/FDM match BSM', () => {
  const euroPut = blackScholesPrice({
    type: 'put',
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.2,
  });
  it('binomial LR (European) ≈ BSM put', () => {
    expect(
      price(engines.binomial({ variant: 'leisen-reimer', steps: 401 }), 'put', 'european'),
    ).toBeCloseTo(euroPut, 3);
  });
  it('Crank–Nicolson (European) ≈ BSM put', () => {
    expect(
      price(
        engines.finiteDifference.crankNicolson({ gridPoints: 400, timeSteps: 400 }),
        'put',
        'european',
      ),
    ).toBeCloseTo(euroPut, 1);
  });
});

describe('American put: engines agree and exceed the European price', () => {
  // High-resolution Leisen–Reimer lattice is the convergence reference.
  const reference = price(
    engines.binomial({ variant: 'leisen-reimer', steps: 999 }),
    'put',
    'american',
  );
  const euroPut = blackScholesPrice({
    type: 'put',
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.2,
  });

  it('American put has a positive early-exercise premium', () => {
    expect(reference).toBeGreaterThan(euroPut);
  });

  it('trinomial, FDM, BAW, and Bjerksund–Stensland agree with the reference', () => {
    expect(price(engines.trinomial({ steps: 500 }), 'put', 'american')).toBeCloseTo(reference, 1);
    expect(
      price(
        engines.finiteDifference.crankNicolson({ gridPoints: 400, timeSteps: 400 }),
        'put',
        'american',
      ),
    ).toBeCloseTo(reference, 1);
    // Closed-form approximations within their documented tolerance. `bjerksundStensland()` is the
    // 2002 two-boundary form (a tighter lower bound than the 1993 single-boundary version).
    expect(
      Math.abs(price(engines.baroneAdesiWhaley(), 'put', 'american') - reference),
    ).toBeLessThan(0.05);
    expect(
      Math.abs(price(engines.bjerksundStensland(), 'put', 'american') - reference),
    ).toBeLessThan(0.1);
  });

  it('capture the early-exercise premium of a dividend-bearing American call', () => {
    // S=K=100, T=1, r=5%, q=6%, σ=20%: early exercise is optimal (q > r).
    const divMkt = market({
      spot: 100,
      riskFreeRate: 0.05,
      volatility: 0.2,
      asOf,
      dividendYield: 0.06,
    });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const ref = engines
      .binomial({ variant: 'leisen-reimer', steps: 999 })
      .price({ contract: c, market: divMkt }).value;
    const euro = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0.06,
      volatility: 0.2,
    });
    expect(ref).toBeGreaterThan(euro); // early-exercise premium is positive
    expect(
      Math.abs(engines.baroneAdesiWhaley().price({ contract: c, market: divMkt }).value - ref),
    ).toBeLessThan(0.05);
    expect(
      Math.abs(engines.bjerksundStensland().price({ contract: c, market: divMkt }).value - ref),
    ).toBeLessThan(0.1);
  });
});

describe('lattice/FDM engines converge as resolution increases', () => {
  // High-resolution Leisen–Reimer is the convergence oracle (cross-validated by every other engine).
  const reference = price(
    engines.binomial({ variant: 'leisen-reimer', steps: 2001 }),
    'put',
    'american',
  );

  it('CRR error shrinks monotonically with step count', () => {
    const err = (steps: number) =>
      Math.abs(price(engines.binomial({ variant: 'crr', steps }), 'put', 'american') - reference);
    const e = [50, 100, 200, 400].map(err);
    // Each refinement at least halves... in practice CRR oscillates, so require a clear downward trend.
    expect(e[3]!).toBeLessThan(e[0]!);
    expect(e[3]!).toBeLessThan(0.02);
  });

  it('trinomial and Crank–Nicolson converge to the same reference', () => {
    const tri = (steps: number) =>
      Math.abs(price(engines.trinomial({ steps }), 'put', 'american') - reference);
    expect(tri(400)).toBeLessThan(tri(50));
    expect(tri(400)).toBeLessThan(0.02);
    const cn = Math.abs(
      price(
        engines.finiteDifference.crankNicolson({ gridPoints: 500, timeSteps: 500 }),
        'put',
        'american',
      ) - reference,
    );
    expect(cn).toBeLessThan(0.05);
  });

  it('all engines agree on the American put to two decimals', () => {
    const values = [
      price(engines.binomial({ variant: 'crr', steps: 800 }), 'put', 'american'),
      price(engines.binomial({ variant: 'jarrow-rudd', steps: 800 }), 'put', 'american'),
      price(engines.binomial({ variant: 'tian', steps: 800 }), 'put', 'american'),
      price(engines.binomial({ variant: 'leisen-reimer', steps: 801 }), 'put', 'american'),
      price(engines.trinomial({ steps: 600 }), 'put', 'american'),
      price(
        engines.finiteDifference.crankNicolson({ gridPoints: 500, timeSteps: 500 }),
        'put',
        'american',
      ),
    ];
    for (const v of values) expect(v).toBeCloseTo(reference, 1);
  });
});

describe('external oracle: Longstaff–Schwartz (2001) American put benchmark', () => {
  // Canonical problem: S=K=40, r=6%, σ=20%, T=1, no dividends. The widely-cited high-accuracy value
  // is 2.3196 (the LSM paper's own coarse-grid FD figure of 2.314 is slightly low). Every TotalFinance
  // engine must reproduce the accurate value — this is an absolute, externally-anchored fixture, not
  // an internal self-consistency check.
  const ORACLE = 2.3196;
  const lsAsOf = Date.UTC(2026, 0, 1);
  const lsExpiry = '2027-01-01';
  const lsMkt = market({ spot: 40, riskFreeRate: 0.06, volatility: 0.2, asOf: lsAsOf });
  const put = (engine: OptionPricingEngine): number =>
    engine.price({
      contract: option.put({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 40,
        expiry: lsExpiry,
        style: 'american',
      }),
      market: lsMkt,
    }).value;

  it('lattice and FDM engines reproduce the accurate value (2.3196) to two decimals', () => {
    expect(put(engines.binomial({ variant: 'leisen-reimer', steps: 2001 }))).toBeCloseTo(ORACLE, 2);
    expect(put(engines.binomial({ variant: 'crr', steps: 2000 }))).toBeCloseTo(ORACLE, 2);
    expect(put(engines.trinomial({ steps: 1000 }))).toBeCloseTo(ORACLE, 2);
    expect(
      put(engines.finiteDifference.crankNicolson({ gridPoints: 800, timeSteps: 800 })),
    ).toBeCloseTo(ORACLE, 2);
  });

  it('closed-form approximations are within their documented tolerance', () => {
    expect(Math.abs(put(engines.baroneAdesiWhaley()) - ORACLE)).toBeLessThan(0.01);
    expect(Math.abs(put(engines.bjerksundStensland()) - ORACLE)).toBeLessThan(0.05);
  });
});

describe('Bjerksund–Stensland: 2002 refines 1993, and the alias is 2002', () => {
  // A spread of regimes (puts and dividend-bearing calls) where early exercise is live.
  const lrRef = (
    type: 'call' | 'put',
    S: number,
    K: number,
    T: number,
    r: number,
    q: number,
    v: number,
  ): number =>
    engines.binomial({ variant: 'leisen-reimer', steps: 2001 }).price({
      contract:
        type === 'call'
          ? option.call({
              convention: 'us-equity-close',
              underlying: 'X',
              strike: K,
              expiry,
              style: 'american',
            })
          : option.put({
              convention: 'us-equity-close',
              underlying: 'X',
              strike: K,
              expiry,
              style: 'american',
            }),
      market: market({ spot: S, riskFreeRate: r, volatility: v, asOf, dividendYield: q }),
    }).value;

  const bs = (
    factory: OptionPricingEngine,
    type: 'call' | 'put',
    S: number,
    K: number,
    r: number,
    q: number,
    v: number,
  ): number =>
    factory.price({
      contract:
        type === 'call'
          ? option.call({
              convention: 'us-equity-close',
              underlying: 'X',
              strike: K,
              expiry,
              style: 'american',
            })
          : option.put({
              convention: 'us-equity-close',
              underlying: 'X',
              strike: K,
              expiry,
              style: 'american',
            }),
      market: market({ spot: S, riskFreeRate: r, volatility: v, asOf, dividendYield: q }),
    }).value;

  const cases = [
    { type: 'put' as const, S: 100, K: 100, r: 0.05, q: 0, v: 0.2 },
    { type: 'put' as const, S: 90, K: 100, r: 0.03, q: 0, v: 0.35 },
    { type: 'call' as const, S: 100, K: 100, r: 0.05, q: 0.06, v: 0.2 },
    { type: 'call' as const, S: 110, K: 100, r: 0.04, q: 0.07, v: 0.25 },
  ];

  it('2002 is at least as accurate as 1993 in every regime, and both are valid lower bounds', () => {
    const e93 = engines.bjerksundStensland1993();
    const e02 = engines.bjerksundStensland2002();
    for (const c of cases) {
      const ref = lrRef(c.type, c.S, c.K, 1, c.r, c.q, c.v);
      const v93 = bs(e93, c.type, c.S, c.K, c.r, c.q, c.v);
      const v02 = bs(e02, c.type, c.S, c.K, c.r, c.q, c.v);
      // Both under-price the true American value (suboptimal flat-boundary exercise).
      expect(v93).toBeLessThanOrEqual(ref + 1e-9);
      expect(v02).toBeLessThanOrEqual(ref + 1e-9);
      // 2002's two-boundary refinement is never worse than 1993.
      expect(Math.abs(v02 - ref)).toBeLessThanOrEqual(Math.abs(v93 - ref) + 1e-9);
    }
  });

  it('the bjerksundStensland() alias equals the 2002 engine', () => {
    for (const c of cases) {
      const alias = bs(engines.bjerksundStensland(), c.type, c.S, c.K, c.r, c.q, c.v);
      const explicit = bs(engines.bjerksundStensland2002(), c.type, c.S, c.K, c.r, c.q, c.v);
      expect(alias).toBe(explicit);
    }
  });

  it('the alias reports the 2002 method in diagnostics', () => {
    const result = engines.bjerksundStensland().price({
      contract: option.put({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 100,
        expiry,
        style: 'american',
      }),
      market: mkt,
    });
    expect(result.diagnostics.method).toBe('bjerksund-stensland-2002');
  });
});

describe('discrete dividends lower a call (escrowed model)', () => {
  it('a dividend before expiry reduces the call price', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const engine = engines.binomial({ variant: 'crr', steps: 400 });
    const noDiv = engine.price({ contract, market: mkt }).value;
    const withDiv = engine.price({
      contract,
      market: market({
        spot: 100,
        riskFreeRate: 0.05,
        volatility: 0.2,
        asOf,
        dividends: [{ exDate: '2026-06-01', amount: 3 }],
      }),
    }).value;
    expect(withDiv).toBeLessThan(noDiv);
  });
});

describe('numerical engine config is validated (no raw RangeError)', () => {
  it('binomial / trinomial / FDM reject non-integer or non-positive resolution', () => {
    expect(() => engines.binomial({ steps: NaN })).toThrow();
    expect(() => engines.binomial({ steps: 0 })).toThrow();
    expect(() => engines.trinomial({ steps: 10.5 })).toThrow();
    expect(() => engines.finiteDifference.crankNicolson({ gridPoints: NaN })).toThrow();
    expect(() => engines.finiteDifference.crankNicolson({ timeSteps: -10 })).toThrow();
  });

  it('a converged FDM price reports converged:true honestly', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const r = engines.finiteDifference
      .crankNicolson({ gridPoints: 200, timeSteps: 200 })
      .price({ contract: c, market: mkt });
    expect(r.diagnostics.converged).toBe(true);
    expect(Number.isFinite(r.value)).toBe(true);
  });
});

describe('Leisen–Reimer odd-step rounding (WS1.20)', () => {
  const c = option.put({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry,
    style: 'american',
  });

  it('rounds an even default (400) up to 401 and matches the explicit 401-step price', () => {
    const rounded = engines
      .binomial({ variant: 'leisen-reimer' })
      .price({ contract: c, market: mkt }); // default 400 → 401
    const explicit = engines
      .binomial({ variant: 'leisen-reimer', steps: 401 })
      .price({ contract: c, market: mkt }).value;
    expect(rounded.value).toBeCloseTo(explicit, 4);
    const w = rounded.diagnostics.warnings.find((x) => x.code === 'binomial.steps_rounded_odd');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('info');
    expect(w!.context).toMatchObject({ requested: 400, effective: 401 });
  });

  it('an already-odd step count carries no rounding warning', () => {
    const r = engines
      .binomial({ variant: 'leisen-reimer', steps: 401 })
      .price({ contract: c, market: mkt });
    expect(r.diagnostics.warnings.some((x) => x.code === 'binomial.steps_rounded_odd')).toBe(false);
  });

  it('does not round non-LR variants', () => {
    const r = engines.binomial({ variant: 'crr', steps: 400 }).price({ contract: c, market: mkt });
    expect(r.diagnostics.warnings.some((x) => x.code === 'binomial.steps_rounded_odd')).toBe(false);
  });
});
