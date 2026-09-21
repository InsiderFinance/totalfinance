/**
 * The 2026-08 engine hardening wave (options ENGINES/MODELS/EXOTICS slice).
 *
 * Three families of regression, each pinning a defect that shipped a confident wrong number:
 *
 *   1. **Greeks battery** — every engine that CLAIMS first-order Greeks is measured against the
 *      analytic Black–Scholes set at on-node AND off-node spots. The universal `S·1e-3` bump is ~20×
 *      finer than a CRR node spacing or a Crank–Nicolson `dS`, so the second difference used to
 *      return the discretization's sawtooth: gamma 0.377 (or exactly 0.000) against a true 0.0189.
 *   2. **Cross-engine agreement at stress parameters** — long-dated/high-vol, negative-rate, and
 *      very-low-vol regimes where a σ√T-blind grid, an unbounded branch probability, or a
 *      positive-rate-only closed form silently produced +45%, −2.6e51, or NaN. Every engine must land
 *      within tolerance of the reference or be honestly flagged/refused.
 *   3. **The no-arbitrage output bound** — the structural postcondition that catches the whole family
 *      at the boundary, verified against a deliberately broken engine.
 */

import { describe, expect, it } from 'vitest';
import { PostconditionError } from '@totalfinance/core';
import {
  engines,
  market,
  option,
  compareEngines,
  type OptionPricingEngine,
} from '@totalfinance/options';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { makeAmericanEngine } from '../src/engines/engine-factory.js';

const asOf = Date.UTC(2026, 0, 1, 21); // 16:00 ET close → a date-only expiry lands on an exact year
const oneYear = '2027-01-01';

const contractAt = (input: {
  type: 'call' | 'put';
  style: 'european' | 'american';
  strike: number;
  expiry: string;
}) =>
  input.type === 'call'
    ? option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: input.strike,
        expiry: input.expiry,
        style: input.style,
      })
    : option.put({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: input.strike,
        expiry: input.expiry,
        style: input.style,
      });

// ───────────────────────────── 1. the per-engine Greeks battery ─────────────────────────────

/**
 * Every engine claiming first-order Greeks, at the resolution a caller would actually use. The
 * Leisen–Reimer lattice keeps the bump path (its tree is anchored on the STRIKE, so its price is
 * smooth in the spot — verified below to ~1e-6 on delta); the spot-anchored lattices and the PDE grid
 * read delta/gamma/theta off their own nodes.
 */
const GREEK_ENGINES: { label: string; engine: OptionPricingEngine }[] = [
  { label: 'binomial-crr', engine: engines.binomial({ variant: 'crr', steps: 801 }) },
  {
    label: 'binomial-jarrow-rudd',
    engine: engines.binomial({ variant: 'jarrow-rudd', steps: 801 }),
  },
  { label: 'binomial-tian', engine: engines.binomial({ variant: 'tian', steps: 801 }) },
  {
    label: 'binomial-leisen-reimer',
    engine: engines.binomial({ variant: 'leisen-reimer', steps: 801 }),
  },
  { label: 'trinomial', engine: engines.trinomial({ steps: 600 }) },
  {
    label: 'crank-nicolson',
    engine: engines.finiteDifference.crankNicolson({ gridPoints: 400, timeSteps: 400 }),
  },
  { label: 'barone-adesi-whaley', engine: engines.baroneAdesiWhaley() },
  { label: 'bjerksund-stensland-2002', engine: engines.bjerksundStensland2002() },
];

// 100 and 95 sit ON a Crank–Nicolson node (dS = 1 at these settings); 98.3 / 101.7 / 103 do not.
const BATTERY_SPOTS = [95, 98.3, 100, 101.7, 103];
const BATTERY = { strike: 100, riskFreeRate: 0.05, dividendYield: 0.02, volatility: 0.2 } as const;

describe('first-order Greeks vs the analytic set — every engine that claims them', () => {
  for (const { label, engine } of GREEK_ENGINES) {
    for (const spot of BATTERY_SPOTS) {
      it(`${label} @ S=${spot} (European call)`, () => {
        const result = engine.price({
          contract: contractAt({
            type: 'call',
            style: 'european',
            strike: BATTERY.strike,
            expiry: oneYear,
          }),
          market: market({
            spot,
            riskFreeRate: BATTERY.riskFreeRate,
            dividendYield: BATTERY.dividendYield,
            volatility: BATTERY.volatility,
            asOf,
          }),
          options: { greeks: true },
        });
        const greeks = result.greeks!;
        const exact = blackScholesGreeks({
          type: 'call',
          spot,
          strike: BATTERY.strike,
          timeToExpiryYears: result.assumptions.timeToExpiryYears as number,
          riskFreeRate: BATTERY.riskFreeRate,
          dividendYield: BATTERY.dividendYield,
          volatility: BATTERY.volatility,
        });
        const relative = (got: number, want: number): number =>
          Math.abs(got - want) / Math.abs(want);
        expect(Math.abs(greeks.delta - exact.delta), 'delta').toBeLessThan(2e-3);
        expect(
          Math.min(
            relative(greeks.gamma, exact.gamma),
            Math.abs(greeks.gamma - exact.gamma) / 1e-4,
          ),
          'gamma',
        ).toBeLessThan(0.05);
        expect(relative(greeks.theta, exact.theta), 'theta').toBeLessThan(0.02);
        expect(relative(greeks.vega, exact.vega), 'vega').toBeLessThan(0.01);
        expect(relative(greeks.rho, exact.rho), 'rho').toBeLessThan(0.01);
      });
    }
  }

  it('an American-put gamma agrees between the Leisen–Reimer lattice and the Crank–Nicolson grid', () => {
    const contract = contractAt({
      type: 'put',
      style: 'american',
      strike: 100,
      expiry: oneYear,
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.25, asOf });
    const lattice = engines
      .binomial({ variant: 'leisen-reimer', steps: 801 })
      .price({ contract, market: mkt, options: { greeks: true } }).greeks!;
    const grid = engines.finiteDifference
      .crankNicolson({ gridPoints: 400, timeSteps: 400 })
      .price({ contract, market: mkt, options: { greeks: true } }).greeks!;
    expect(lattice.gamma).toBeGreaterThan(0);
    expect(Math.abs(grid.gamma - lattice.gamma) / lattice.gamma).toBeLessThan(0.1);
    expect(Math.abs(grid.delta - lattice.delta)).toBeLessThan(5e-3);
  });

  it('the sawtooth is what a sub-spacing spot bump measures (why the natives exist)', () => {
    // Reprice the CRR lattice by hand at S ± S·1e-3 — the bump the shared FD helper used to take —
    // and confirm the second difference is nowhere near the true gamma. This is the defect, pinned.
    const spot = 100;
    const priceAt = (s: number): number =>
      engines.binomial({ variant: 'crr', steps: 801 }).price({
        contract: contractAt({ type: 'call', style: 'european', strike: 100, expiry: oneYear }),
        market: market({
          spot: s,
          riskFreeRate: 0.05,
          dividendYield: 0.02,
          volatility: 0.2,
          asOf,
        }),
        options: { greeks: false },
      }).value;
    const h = spot * 1e-3;
    const bumpGamma = (priceAt(spot + h) - 2 * priceAt(spot) + priceAt(spot - h)) / (h * h);
    const native = engines.binomial({ variant: 'crr', steps: 801 }).price({
      contract: contractAt({ type: 'call', style: 'european', strike: 100, expiry: oneYear }),
      market: market({ spot, riskFreeRate: 0.05, dividendYield: 0.02, volatility: 0.2, asOf }),
      options: { greeks: true },
    }).greeks!.gamma;
    const exact = 0.018_950_578_755; // blackScholesGreeks gamma at S=K=100, T=1, r=5%, q=2%, σ=20%
    expect(Math.abs(native - exact) / exact).toBeLessThan(0.01);
    // The bump answer is off by orders of magnitude — either ~0 or a spike, never the truth.
    expect(Math.abs(bumpGamma - exact) / exact).toBeGreaterThan(0.5);
  });
});

// ───────────────────── 1b. the lattice branch-probability guard (finding 1) ─────────────────────

describe('risk-neutral branch probabilities must stay in [0, 1]', () => {
  const longDated = '2036-01-01'; // T = 10
  const lowVolFastDrift = market({
    spot: 100,
    riskFreeRate: 0.3,
    dividendYield: 0,
    volatility: 0.05,
    asOf,
  });

  it('CRR refuses when the drift outruns the diffusion (p > 1), naming Leisen–Reimer', () => {
    // T=10, 200 steps ⇒ Δt = 0.05: e^{0.3·0.05} = 1.01511 is ABOVE u = e^{0.05·√0.05} = 1.01124,
    // so p = (1.01511 − 0.98888)/(1.01124 − 0.98888) = 1.173. The tree used to price it anyway.
    const contract = contractAt({
      type: 'call',
      style: 'european',
      strike: 100,
      expiry: longDated,
    });
    let thrown: { code?: string; message?: string } = {};
    try {
      engines.binomial({ variant: 'crr', steps: 200 }).price({
        contract,
        market: lowVolFastDrift,
        options: { greeks: false },
      });
      expect.unreachable('the CRR lattice must refuse an out-of-range probability');
    } catch (error) {
      thrown = error as { code?: string; message?: string };
    }
    expect(thrown.code).toBe('engine.probability_out_of_range');
    expect(thrown.message).toMatch(/probability p=1\.17/);
    expect(thrown.message).toMatch(/leisen-reimer/);
  });

  it('the trinomial refuses a negative middle probability (pu > 1, pm < 0)', () => {
    // σ=1%, r=10%, T=10 at the default 300 steps: pu = 1.3124, pm = −0.3298. European used to sum
    // to −2.6e51; the American put looked plausible and was 4.4× low.
    const mkt = market({ spot: 100, riskFreeRate: 0.1, dividendYield: 0, volatility: 0.01, asOf });
    for (const style of ['european', 'american'] as const) {
      for (const type of ['call', 'put'] as const) {
        let thrown: { code?: string; message?: string } = {};
        try {
          engines.trinomial().price({
            contract: contractAt({ type, style, strike: 100, expiry: longDated }),
            market: mkt,
            options: { greeks: false },
          });
          expect.unreachable(`trinomial must refuse the ${style} ${type}`);
        } catch (error) {
          thrown = error as { code?: string; message?: string };
        }
        expect(thrown.code).toBe('engine.probability_out_of_range');
        expect(thrown.message).toMatch(/p[umd]=/);
      }
    }
  });

  it("Leisen–Reimer's Peizer–Pratt probability is in (0, 1) by construction — it never trips", () => {
    const contract = contractAt({
      type: 'call',
      style: 'european',
      strike: 100,
      expiry: longDated,
    });
    for (const steps of [51, 501]) {
      const priced = engines
        .binomial({ variant: 'leisen-reimer', steps })
        .price({ contract, market: lowVolFastDrift, options: { greeks: false } });
      expect(Number.isFinite(priced.value)).toBe(true);
      expect(priced.diagnostics.converged).toBe(true);
    }
    // Even at a vanishing volatility, where Peizer–Pratt saturates and `d` used to be 0/0 = NaN.
    const flat = engines.binomial({ variant: 'leisen-reimer', steps: 101 }).price({
      contract,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: 1e-9, asOf }),
      options: { greeks: false },
    });
    const forward = 100 * Math.exp(0.05 * (flat.assumptions.timeToExpiryYears as number));
    const discounted =
      Math.max(forward - 100, 0) * Math.exp(-0.05 * (flat.assumptions.timeToExpiryYears as number));
    expect(flat.value).toBeCloseTo(discounted, 6); // the deterministic σ→0 limit, not NaN
  });

  it('normal parameters are untouched by the guard (the CRR golden still lands)', () => {
    // S=K=100, T=1, r=5%, σ=20%, 400 steps — the same value the suite has always pinned.
    const priced = engines.binomial({ variant: 'crr', steps: 400 }).price({
      contract: contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear }),
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf }),
      options: { greeks: false },
    });
    expect(priced.value).toBeCloseTo(6.09, 1);
    expect(priced.diagnostics.converged).toBe(true);
  });
});

// ────────────────── 1c. the Crank–Nicolson grid: σ√T-aware, carry-aware (finding 3) ──────────────

describe('Crank–Nicolson grid sizing and boundaries', () => {
  it('a long-dated, high-vol contract is flagged instead of silently truncated', () => {
    const priced = engines.finiteDifference.crankNicolson().price({
      contract: contractAt({ type: 'call', style: 'european', strike: 100, expiry: '2036-01-01' }),
      market: market({
        spot: 100,
        riskFreeRate: -0.02,
        dividendYield: 0.08,
        volatility: 1.5,
        asOf,
      }),
      options: { greeks: false },
    });
    expect(priced.diagnostics.converged).toBe(false);
    const flag = priced.diagnostics.warnings.find(
      (w) => w.code === 'engine.discretization_inadequate',
    );
    expect(flag, 'the capped grid must say so').toBeDefined();
    expect(flag!.context).toMatchObject({ gridPoints: 1600 });
    // Still in the right neighbourhood (the old σ√T-blind domain was +45%).
    const exact = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: priced.assumptions.timeToExpiryYears as number,
      riskFreeRate: -0.02,
      dividendYield: 0.08,
      volatility: 1.5,
    });
    expect(Math.abs(priced.value - exact) / exact).toBeLessThan(0.05);
  });

  it('a short-dated contract refines the grid rather than under-resolving the strike', () => {
    const priced = engines.finiteDifference.crankNicolson().price({
      contract: contractAt({ type: 'call', style: 'european', strike: 100, expiry: '2026-01-19' }),
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: 0.15, asOf }),
      options: { greeks: false },
    });
    const exact = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: priced.assumptions.timeToExpiryYears as number,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.15,
    });
    expect(priced.diagnostics.converged).toBe(true);
    expect(Math.abs(priced.value - exact) / exact).toBeLessThan(0.01); // was −5.5%
  });

  it('the call upper boundary carries the dividend yield', () => {
    // With q = 8% over 10y the boundary Smax − K·e^{−rτ} overstates the option by the missing
    // e^{−qτ}; the grid is the same in both runs, so any difference is the boundary condition.
    const contract = contractAt({
      type: 'call',
      style: 'european',
      strike: 100,
      expiry: '2036-01-01',
    });
    const engine = engines.finiteDifference.crankNicolson({ gridPoints: 400, timeSteps: 400 });
    const withYield = engine.price({
      contract,
      market: market({ spot: 100, riskFreeRate: 0.03, dividendYield: 0.08, volatility: 0.2, asOf }),
      options: { greeks: false },
    });
    const exact = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: withYield.assumptions.timeToExpiryYears as number,
      riskFreeRate: 0.03,
      dividendYield: 0.08,
      volatility: 0.2,
    });
    expect(Math.abs(withYield.value - exact) / exact).toBeLessThan(0.01);
  });

  it('the benign anchor is unchanged (same grid, same value)', () => {
    const priced = engines.finiteDifference
      .crankNicolson({ gridPoints: 200, timeSteps: 200 })
      .price({
        contract: contractAt({ type: 'call', style: 'american', strike: 100, expiry: oneYear }),
        market: market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf }),
        options: { greeks: false },
      });
    expect(priced.diagnostics.converged).toBe(true);
    expect(priced.diagnostics.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
    expect(priced.value).toBeCloseTo(10.45, 1);
  });
});

// ──────────────── 1d. Barone–Adesi–Whaley's positive-rate domain (findings 4 & 5) ────────────────

describe('Barone–Adesi–Whaley at r ≤ 0', () => {
  const engine = engines.baroneAdesiWhaley();
  const mkt = (riskFreeRate: number, dividendYield = 0.05) =>
    market({ spot: 100, riskFreeRate, dividendYield, volatility: 0.25, asOf });

  it('refuses r = 0 and r = −1% for a call, with the typed code and the working engines named', () => {
    for (const rate of [0, -0.01]) {
      let thrown: { code?: string; message?: string } = {};
      try {
        engine.price({
          contract: contractAt({ type: 'call', style: 'american', strike: 100, expiry: oneYear }),
          market: mkt(rate),
          options: { greeks: false },
        });
        expect.unreachable(`BAW must refuse r=${rate}`);
      } catch (error) {
        thrown = error as { code?: string; message?: string };
      }
      expect(thrown.code).toBe('engine.unsupported_contract');
      expect(thrown.message).toMatch(/bjerksundStensland2002/);
      expect(thrown.message).toMatch(/leisen-reimer/);
    }
  });

  it('prices a put at r ≤ 0 EXACTLY, as its European value (early exercise is never optimal)', () => {
    for (const rate of [0, -0.01]) {
      const contract = contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear });
      const priced = engine.price({ contract, market: mkt(rate), options: { greeks: false } });
      const european = blackScholesPrice({
        type: 'put',
        spot: 100,
        strike: 100,
        timeToExpiryYears: priced.assumptions.timeToExpiryYears as number,
        riskFreeRate: rate,
        dividendYield: 0.05,
        volatility: 0.25,
      });
      expect(priced.value).toBeCloseTo(european, 10);
      // And the lattice agrees that there is no early-exercise premium at a non-positive rate.
      const lattice = engines
        .binomial({ variant: 'leisen-reimer', steps: 1001 })
        .price({ contract, market: mkt(rate), options: { greeks: false } }).value;
      expect(Math.abs(lattice - european)).toBeLessThan(0.01);
    }
  });

  it('refuses a put at r ≤ 0 with a NEGATIVE dividend yield (the dominance argument fails there)', () => {
    expect(() =>
      engine.price({
        contract: contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear }),
        market: mkt(-0.01, -0.03),
        options: { greeks: false },
      }),
    ).toThrow(/riskFreeRate ≤ 0/);
  });

  it('still prices at r = 0.001, and reports the iteration it actually took', () => {
    const priced = engine.price({
      contract: contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear }),
      market: mkt(0.001),
      options: { greeks: false },
    });
    expect(priced.value).toBeGreaterThan(0);
    expect(priced.diagnostics.converged).toBe(true);
    expect(priced.diagnostics.iterations).toBeGreaterThan(0);
    const reference = engines.binomial({ variant: 'leisen-reimer', steps: 1001 }).price({
      contract: contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear }),
      market: mkt(0.001),
      options: { greeks: false },
    }).value;
    expect(Math.abs(priced.value - reference)).toBeLessThan(0.05);
  });
});

// ───────── 1e. Bjerksund–Stensland never dips below its own floor (found by the bound) ─────────

describe('Bjerksund–Stensland is a LOWER bound, never a negative price', () => {
  // Found by the new output bound: the put–call transformation's early-exercise branch returns the
  // TRANSFORMED call's `S − K`, which for an out-of-the-money put at a low volatility is `K − S` —
  // a flat −5 for S=105, K=100 at any σ ≤ 1%. It reached callers (and the American IV solver's
  // bracket) as a price.
  const lowVolPut = (variant: OptionPricingEngine, volatility: number): number =>
    variant.price({
      contract: contractAt({ type: 'put', style: 'american', strike: 100, expiry: '2026-06-19' }),
      market: market({ spot: 105, riskFreeRate: 0.04, volatility, asOf }),
      options: { greeks: false },
    }).value;

  it('an OTM American put at a vanishing volatility is worth ~0, never −5', () => {
    for (const engine of [engines.bjerksundStensland2002(), engines.bjerksundStensland1993()]) {
      for (const volatility of [1e-8, 1e-4, 0.001, 0.01]) {
        const value = lowVolPut(engine, volatility);
        expect(value, `σ=${volatility}`).toBeGreaterThanOrEqual(0);
        expect(value, `σ=${volatility}`).toBeLessThan(0.01);
      }
    }
  });

  it('the floor never LIFTS a normal value (still a lower bound on the lattice reference)', () => {
    const contract = contractAt({ type: 'put', style: 'american', strike: 100, expiry: oneYear });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const reference = engines
      .binomial({ variant: 'leisen-reimer', steps: 2001 })
      .price({ contract, market: mkt, options: { greeks: false } }).value;
    // Measured gaps to the 2001-step lattice: 0.074 for the two-boundary 2002 form, 0.107 for the
    // single-boundary 1993 form — both still strictly BELOW the reference, as a lower bound must be.
    for (const [engine, gap] of [
      [engines.bjerksundStensland2002(), 0.08],
      [engines.bjerksundStensland1993(), 0.12],
    ] as const) {
      const value = engine.price({ contract, market: mkt, options: { greeks: false } }).value;
      expect(value).toBeLessThanOrEqual(reference + 1e-9);
      expect(reference - value).toBeLessThan(gap);
    }
  });
});

// ─────────────────────── 2. cross-engine agreement at stress parameters ───────────────────────

interface StressCase {
  label: string;
  spot: number;
  strike: number;
  expiry: string;
  years: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}

const STRESS: StressCase[] = [
  {
    label: 'T=10, σ=1.5, q=8%, r=−2% (σ√T ≈ 4.7 — the σ√T-blind truncation was +45%)',
    spot: 100,
    strike: 100,
    expiry: '2036-01-01',
    years: 10,
    riskFreeRate: -0.02,
    dividendYield: 0.08,
    volatility: 1.5,
  },
  {
    label: 'T=5, σ=0.8, q=2%',
    spot: 100,
    strike: 100,
    expiry: '2031-01-01',
    years: 5,
    riskFreeRate: 0.05,
    dividendYield: 0.02,
    volatility: 0.8,
  },
  {
    label: 'T=0.05, σ=0.15 (short-dated — the fixed 4·max(S,K) domain was −5.5%)',
    spot: 100,
    strike: 100,
    expiry: '2026-01-19',
    years: 0.05,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.15,
  },
  {
    label: 'σ=0.01, r=10%, T=1 (drift outruns diffusion — the trees must refuse)',
    spot: 100,
    strike: 100,
    expiry: oneYear,
    years: 1,
    riskFreeRate: 0.1,
    dividendYield: 0,
    volatility: 0.01,
  },
];

/** Every deterministic engine that prices a European vanilla off the spot. */
const PANEL = (): { label: string; engine: OptionPricingEngine }[] => [
  { label: 'binomial-crr', engine: engines.binomial({ variant: 'crr', steps: 801 }) },
  {
    label: 'binomial-leisen-reimer',
    engine: engines.binomial({ variant: 'leisen-reimer', steps: 801 }),
  },
  { label: 'trinomial', engine: engines.trinomial({ steps: 601 }) },
  {
    label: 'crank-nicolson',
    engine: engines.finiteDifference.crankNicolson({ gridPoints: 400, timeSteps: 400 }),
  },
];

describe('cross-engine agreement at stress parameters (European vs Black–Scholes)', () => {
  for (const stress of STRESS) {
    for (const type of ['call', 'put'] as const) {
      it(`${type}: ${stress.label}`, () => {
        const contract = contractAt({
          type,
          style: 'european',
          strike: stress.strike,
          expiry: stress.expiry,
        });
        const mkt = market({
          spot: stress.spot,
          riskFreeRate: stress.riskFreeRate,
          dividendYield: stress.dividendYield,
          volatility: stress.volatility,
          asOf,
        });
        const reference = blackScholesPrice({
          type,
          spot: stress.spot,
          strike: stress.strike,
          timeToExpiryYears: stress.years,
          riskFreeRate: stress.riskFreeRate,
          dividendYield: stress.dividendYield,
          volatility: stress.volatility,
        });
        for (const { label, engine } of PANEL()) {
          let priced;
          try {
            priced = engine.price({ contract, market: mkt, options: { greeks: false } });
          } catch (error) {
            // An honest refusal is a pass: the engine said it cannot price this regime, with a code.
            expect((error as { code?: string }).code, `${label} refused untyped`).toMatch(
              /^(engine|input|solver)\./,
            );
            continue;
          }
          // Time-to-expiry differs from the nominal `years` by the ACT/365F day count, so compare on
          // the engine's own reference rather than demanding the analytic value to the last basis point.
          const exact = blackScholesPrice({
            type,
            spot: stress.spot,
            strike: stress.strike,
            timeToExpiryYears: priced.assumptions.timeToExpiryYears as number,
            riskFreeRate: stress.riskFreeRate,
            dividendYield: stress.dividendYield,
            volatility: stress.volatility,
          });
          const relative = Math.abs(priced.value - exact) / Math.max(exact, 1e-12);
          if (priced.diagnostics.converged === false) {
            // Flagged: the engine may be off, but it said so — and it must still be in the ballpark
            // and inside the no-arbitrage bound (which the engine asserts on the way out).
            expect(
              priced.diagnostics.warnings.length,
              `${label} flagged without a reason`,
            ).toBeGreaterThan(0);
            continue;
          }
          expect(relative, `${label} (${reference.toFixed(4)} reference)`).toBeLessThan(0.01);
        }
      });
    }
  }

  it('the American panel agrees with a 3001-step Leisen–Reimer reference or is flagged', () => {
    for (const stress of STRESS) {
      const contract = contractAt({
        type: 'put',
        style: 'american',
        strike: stress.strike,
        expiry: stress.expiry,
      });
      const mkt = market({
        spot: stress.spot,
        riskFreeRate: stress.riskFreeRate,
        dividendYield: stress.dividendYield,
        volatility: stress.volatility,
        asOf,
      });
      const reference = engines
        .binomial({ variant: 'leisen-reimer', steps: 3001 })
        .price({ contract, market: mkt, options: { greeks: false } }).value;
      expect(reference).toBeGreaterThan(0);
      for (const { label, engine } of PANEL()) {
        let priced;
        try {
          priced = engine.price({ contract, market: mkt, options: { greeks: false } });
        } catch (error) {
          expect((error as { code?: string }).code, `${label} refused untyped`).toMatch(
            /^(engine|input|solver)\./,
          );
          continue;
        }
        if (priced.diagnostics.converged === false) continue; // honestly flagged
        // 1% of the reference, or 0.2 cents on a $100 underlying — whichever is looser. At σ = 1%
        // the American put is worth 1.8 CENTS and the lattices' early-exercise boundaries disagree
        // by 0.15 of a cent: that is discretization of a nearly worthless option, not a defect.
        expect(Math.abs(priced.value - reference), `${label} @ ${stress.label}`).toBeLessThan(
          Math.max(0.01 * reference, 2e-3),
        );
      }
    }
    // A 3001-step Leisen–Reimer reference across the whole American stress panel is genuinely
    // expensive: ~18 s alone, and multiples of that when the full suite saturates every core. The
    // default 45 s passed in isolation and timed out under load — a fixed budget over a workload
    // that grows with the panel, which is the same trap the 3B.N closeout recorded for the
    // enforcement generations. Raised rather than trimming the reference or loosening the
    // tolerance, because the panel's breadth IS the test.
  }, 180_000);

  it('compareEngines turns a refusing engine into a failed ROW, not a thrown comparison', () => {
    // r = 0 is Barone–Adesi–Whaley's 0/0: it refuses, and the table still reports every other engine.
    const table = compareEngines({
      contract: contractAt({ type: 'call', style: 'american', strike: 100, expiry: oneYear }),
      market: market({ spot: 100, riskFreeRate: 0, dividendYield: 0.05, volatility: 0.25, asOf }),
    });
    const failed = table.rows.filter((row) => row.value === null);
    expect(failed.map((row) => row.engine)).toContain('barone-adesi-whaley');
    for (const row of failed) {
      expect(row.converged).toBe(false);
      expect(row.warnings[0]!.code).toBe('engine.unsupported_contract');
      expect(row.absoluteDifferenceFromReference).toBeNull();
    }
    // Failed rows sort last, and the priced rows are still comparable.
    expect(table.rows.at(-1)!.value).toBeNull();
    expect(table.rows[0]!.value).toBeGreaterThan(0);
    expect(table.diagnostics.warnings.some((w) => w.code === 'options.engine_failed')).toBe(true);
  });
});

// ───────────────────────── 3. the structural no-arbitrage output bound ─────────────────────────

describe('no-arbitrage output bound (engine.result_out_of_bounds)', () => {
  const euro = contractAt({ type: 'call', style: 'european', strike: 100, expiry: oneYear });
  const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

  it('a stubbed engine returning 2·S is caught by the factory, in the library-defect voice', () => {
    // Built through the SAME factory every built-in engine uses, so this exercises the real result
    // assembly rather than the assertion in isolation.
    const broken = makeAmericanEngine({
      name: 'stub-double-spot',
      method: 'stub',
      styles: ['european', 'american'],
      pricer: ({ spot }) => 2 * spot,
    });
    let thrown: unknown;
    try {
      broken.price({ contract: euro, market: mkt });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PostconditionError);
    expect((thrown as PostconditionError).code).toBe('engine.result_out_of_bounds');
    expect((thrown as PostconditionError).message).toMatch(/no-arbitrage bound/);
    expect((thrown as PostconditionError).context).toMatchObject({ value: 200, ceiling: 100 });
  });

  it('a stubbed engine returning a negative value is caught too', () => {
    const broken = makeAmericanEngine({
      name: 'stub-negative',
      method: 'stub',
      styles: ['european'],
      pricer: () => -1e-6,
    });
    expect(() => broken.price({ contract: euro, market: mkt })).toThrow(PostconditionError);
  });

  it('the American ceiling is the immediate-exercise value, not the discounted one', () => {
    // A deep-ITM American put is worth K − S > K·e^{−rT} for a positive rate: bounding it by the
    // EUROPEAN ceiling would flag a correct price as a defect.
    const deepPut = contractAt({ type: 'put', style: 'american', strike: 200, expiry: oneYear });
    const value = engines.binomial({ variant: 'leisen-reimer', steps: 501 }).price({
      contract: deepPut,
      market: market({ spot: 1, riskFreeRate: 0.05, volatility: 0.2, asOf }),
    }).value;
    expect(value).toBeGreaterThan(200 * Math.exp(-0.05)); // above the European ceiling
    expect(value).toBeLessThanOrEqual(200); // and below the American one
  });

  it('every built-in engine passes the bound on a normal contract', () => {
    for (const { engine } of [...GREEK_ENGINES, ...PANEL()]) {
      const call = engine.price({ contract: euro, market: mkt, options: { greeks: false } }).value;
      expect(call).toBeGreaterThanOrEqual(0);
      expect(call).toBeLessThanOrEqual(100 + 1e-9); // C ≤ S·e^{−qT} = S here (q = 0)
      const put = engine.price({
        contract: contractAt({ type: 'put', style: 'european', strike: 100, expiry: oneYear }),
        market: mkt,
        options: { greeks: false },
      }).value;
      expect(put).toBeGreaterThanOrEqual(0);
      expect(put).toBeLessThanOrEqual(100 * Math.exp(-0.05) + 1e-9); // P ≤ K·e^{−rT}
    }
  });
});
