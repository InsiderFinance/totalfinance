import { describe, expect, it } from 'vitest';
import { engines, option, type OptionPricingEngine } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  bjerksundStensland1993Approximation,
  bjerksundStensland2002Approximation,
  logNormalCdf,
  weightedBivariateNormalCdf,
} from '../src/engines/american-approx.js';
import { makeAmericanEngine } from '../src/engines/engine-factory.js';
import golden from './golden/bjerksund-stensland-mpmath.json';

/**
 * Bjerksund–Stensland at low volatility (spec: docs/specs/bjerksund-stensland-stability.md).
 *
 * Every expected value is independent of TotalFinance. The goldens are the published 1993/2002 formulas
 * evaluated term for term in mpmath (tools/golden/bjerksund_stensland_reference.py), which first
 * reproduces three published 2002 values (NAG S30QCF and two MathWorks examples). Engines run through
 * the public API with explicit expiry instants and `greeks: true`, because a price-only check cannot
 * see a non-finite bump.
 *
 * Tolerances, all for binary64 evaluation against an exact reference:
 * - Price: 5e-14·(S + K). The 2002 sum has twelve terms (33 additive pieces). Each is bounded by the
 *   spot or strike (α·S^β ≤ S, and every φ/Ψ bracket is a difference of probabilities), and each
 *   carries the ~1e-15 absolute error of the normal and bivariate-normal CDFs plus a few roundings.
 *   The measured worst case is reported in the spec.
 * - Greeks against the engine's OWN stencil evaluated exactly: that price bound divided by the bump
 *   (twice for gamma), in the Greek's documented unit. Truncation is identical on both sides, so this
 *   isolates floating-point error. Truncation against the true derivative is asserted separately,
 *   only where the bump resolves the price.
 */

const AS_OF = golden.meta.asOfMs;
const YEAR_MS = 365 * 86_400_000;
const PRICE_TOLERANCE = 5e-14;

interface GoldenInput {
  type: 'call' | 'put';
  spot: number;
  strike: number;
  years: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}

const contractOf = (c: Pick<GoldenInput, 'type' | 'strike' | 'years'>) => {
  const expiry = new Date(AS_OF + c.years * YEAR_MS).toISOString();
  const spec = { underlying: 'X', strike: c.strike, expiry, style: 'american' as const };
  return c.type === 'call' ? option.call(spec) : option.put(spec);
};

const priceWith = (
  engine: OptionPricingEngine,
  c: Omit<GoldenInput, 'timeToExpiryYears'>,
  greeks = true,
) =>
  engine.price({
    contract: contractOf(c),
    market: {
      asOf: AS_OF,
      spot: c.spot,
      riskFreeRate: c.riskFreeRate,
      dividendYield: c.dividendYield,
      volatility: c.volatility,
    },
    options: { greeks },
  });

const rawInput = (c: GoldenInput) => ({
  type: c.type,
  spot: c.spot,
  strike: c.strike,
  timeToExpiryYears: c.timeToExpiryYears,
  riskFreeRate: c.riskFreeRate,
  dividendYield: c.dividendYield,
  volatility: c.volatility,
});

type GreekName = 'delta' | 'gamma' | 'theta' | 'vega' | 'rho';
interface GoldenPrice extends GoldenInput {
  approximation2002: number;
  price2002: number;
  approximation1993: number;
  price1993: number;
}
interface GoldenGreek extends GoldenInput {
  price: number;
  bumps: { spotStep: number; volatilityStep: number; timeStepYears: number; rateStep: number };
  finiteDifference: Record<GreekName, number>;
  derivative: Record<GreekName, number>;
}
interface GoldenAnchor extends GoldenInput {
  source: string;
  printed: number;
  decimals: number;
  reference: number;
}
// JSON imports widen `type` to string; the generator writes only 'call' | 'put'.
const PRICES = golden.prices as unknown as GoldenPrice[];
const GREEKS = golden.greeks as unknown as GoldenGreek[];
const ANCHORS = golden.anchors as unknown as GoldenAnchor[];

const label = (c: Omit<GoldenInput, 'timeToExpiryYears'>): string =>
  `${c.type} S=${c.spot} K=${c.strike} T=${c.years} r=${c.riskFreeRate} q=${c.dividendYield} σ=${c.volatility}`;

describe('the reported low-volatility reproductions', () => {
  const bs2002 = engines.bjerksundStensland2002();

  it('ATM one-day call and put at 1% volatility price and Greek finitely, to the exact model value', () => {
    for (const type of ['call', 'put'] as const) {
      const c = GREEKS.find(
        (g) => g.type === type && g.spot === 100 && g.volatility === 0.01 && g.years < 0.01,
      )!;
      const result = priceWith(bs2002, c);
      expect(result.assumptions.timeToExpiryYears).toBe(c.timeToExpiryYears);
      expect(Math.abs(result.value - c.price)).toBeLessThanOrEqual(PRICE_TOLERANCE * 200);
      for (const greek of Object.values(result.greeks!)) expect(Number.isFinite(greek)).toBe(true);
    }
  });

  it('a deep out-of-the-money put keeps a finite rho when the rate bump crosses zero', () => {
    const c = GREEKS.find((g) => g.type === 'put' && g.spot === 140 && g.riskFreeRate === 0)!;
    const result = priceWith(bs2002, c);
    expect(Number.isFinite(result.greeks!.rho)).toBe(true);
    expect(result.diagnostics.finiteDifferenceBumps?.['rateStep']).toBe(1e-4);
    // Both sides of the bump (r = ±1e-4) price to the exact model value.
    for (const r of [1e-4, -1e-4, 1e-8, -1e-8]) {
      const g = PRICES.find(
        (p) => p.type === 'put' && p.spot === 140 && p.riskFreeRate === r && p.volatility === 0.05,
      )!;
      expect(Math.abs(priceWith(bs2002, g, false).value - g.price2002)).toBeLessThanOrEqual(
        PRICE_TOLERANCE * (g.spot + g.strike),
      );
    }
  });
});

describe('published Bjerksund–Stensland 2002 anchors', () => {
  it('reproduces NAG S30QCF and the MathWorks examples to their printed precision', () => {
    expect(ANCHORS.length).toBe(7);
    for (const a of ANCHORS) {
      const value = bjerksundStensland2002Approximation(rawInput(a));
      expect(Math.abs(value - a.printed), a.source).toBeLessThanOrEqual(0.5 * 10 ** -a.decimals);
      expect(Math.abs(value - a.reference), a.source).toBeLessThanOrEqual(
        PRICE_TOLERANCE * (a.spot + a.strike),
      );
    }
  });
});

describe('prices against the independent mpmath reference', () => {
  const bs2002 = engines.bjerksundStensland2002();
  const bs1993 = engines.bjerksundStensland1993();

  it('the raw 2002 and 1993 closed forms match the exact model value (the floor cannot mask them)', () => {
    for (const c of PRICES) {
      const scale = PRICE_TOLERANCE * (c.spot + c.strike);
      expect(
        Math.abs(bjerksundStensland2002Approximation(rawInput(c)) - c.approximation2002),
        label(c),
      ).toBeLessThanOrEqual(scale);
      expect(
        Math.abs(bjerksundStensland1993Approximation(rawInput(c)) - c.approximation1993),
        label(c),
      ).toBeLessThanOrEqual(scale);
    }
  });

  it('the public engines (explicit dates, greeks: true) return the floored model value', () => {
    for (const c of PRICES) {
      const scale = PRICE_TOLERANCE * (c.spot + c.strike);
      const r2002 = priceWith(bs2002, c);
      expect(r2002.assumptions.timeToExpiryYears).toBe(c.timeToExpiryYears);
      expect(Math.abs(r2002.value - c.price2002), label(c)).toBeLessThanOrEqual(scale);
      for (const greek of Object.values(r2002.greeks!)) expect(Number.isFinite(greek)).toBe(true);
      expect(Math.abs(priceWith(bs1993, c).value - c.price1993), label(c)).toBeLessThanOrEqual(
        scale,
      );
    }
  });

  it('the boundary grid and the low-volatility grid match the reference case by case', () => {
    const columns = golden.matrix.columns;
    const at = (row: (string | number)[], name: string) => row[columns.indexOf(name)];
    expect(golden.matrix.rows.length).toBe(1932);
    for (const row of golden.matrix.rows) {
      const c = {
        type: at(row, 'type') as 'call' | 'put',
        spot: at(row, 'spot') as number,
        strike: at(row, 'strike') as number,
        years: at(row, 'years') as number,
        riskFreeRate: at(row, 'riskFreeRate') as number,
        dividendYield: at(row, 'dividendYield') as number,
        volatility: at(row, 'volatility') as number,
      };
      const result = priceWith(bs2002, c, false);
      expect(result.assumptions.timeToExpiryYears).toBe(at(row, 'timeToExpiryYears'));
      expect(
        Math.abs(result.value - (at(row, 'price2002') as number)),
        label(c),
      ).toBeLessThanOrEqual(PRICE_TOLERANCE * (c.spot + c.strike));
    }
  });
});

describe('Greeks against the independent reference (documented units)', () => {
  const bs2002 = engines.bjerksundStensland2002();
  const units = { delta: 1, gamma: 1, theta: 365, vega: 100, rho: 100 } as const;

  it('every first-order Greek equals the exact evaluation of the engine’s own stencil', () => {
    for (const c of GREEKS) {
      const result = priceWith(bs2002, c);
      expect(result.diagnostics.finiteDifferenceBumps).toEqual(c.bumps);
      const { spotStep, volatilityStep, timeStepYears, rateStep } = c.bumps;
      const priceError = PRICE_TOLERANCE * (c.spot + c.strike);
      const tolerance = {
        delta: priceError / spotStep,
        gamma: (4 * priceError) / spotStep ** 2,
        theta: priceError / timeStepYears / units.theta,
        vega: priceError / volatilityStep / units.vega,
        rho: priceError / rateStep / units.rho,
      };
      for (const greek of Object.keys(units) as (keyof typeof units)[]) {
        const actual = result.greeks![greek];
        const expected = c.finiteDifference[greek];
        expect(Math.abs(actual - expected), `${label(c)} ${greek}`).toBeLessThanOrEqual(
          tolerance[greek],
        );
      }
    }
  });

  it('where the bumps resolve the price, the Greeks are close to the true model derivatives', () => {
    // The default bumps (S·1e-3, …) are coarse against a one-day 1%-vol distribution (σ√T·S ≈ 0.05);
    // there the stencil itself, not the evaluation, sets the error, which the spec reports.
    let checked = 0;
    for (const c of GREEKS) {
      if (c.volatility * Math.sqrt(c.timeToExpiryYears) < 0.02) continue;
      checked++;
      const result = priceWith(bs2002, c);
      for (const greek of ['delta', 'vega', 'rho', 'theta'] as const) {
        const exact = c.derivative[greek];
        expect(Math.abs(result.greeks![greek] - exact), `${label(c)} ${greek}`).toBeLessThanOrEqual(
          2e-3 * Math.abs(exact) + 1e-9 * (c.spot + c.strike),
        );
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});

describe('the original probe grids re-run through the public engine', () => {
  const bs2002 = engines.bjerksundStensland2002();
  const sweep = (grid: GoldenInput[], checkIntrinsic: boolean) => {
    const failures: string[] = [];
    for (const c of grid) {
      try {
        const result = priceWith(bs2002, c);
        const european = blackScholesPrice({ ...rawInput(c) });
        const intrinsic = Math.max(c.type === 'call' ? c.spot - c.strike : c.strike - c.spot, 0);
        const finite =
          Number.isFinite(result.value) &&
          Object.values(result.greeks!).every((g) => Number.isFinite(g));
        if (!finite) failures.push(`non-finite ${label(c)}`);
        else if (result.value + 1e-8 < european) failures.push(`below European ${label(c)}`);
        else if (checkIntrinsic && result.value + 1e-8 < intrinsic)
          failures.push(`below intrinsic ${label(c)}`);
      } catch (error) {
        failures.push(`${String(error).slice(0, 80)} ${label(c)}`);
      }
    }
    return failures;
  };
  const grid = (axes: {
    riskFreeRate: number[];
    dividendYield: number[];
    volatility: number[];
    spot: number[];
    strike: number[];
    years: number[];
  }): GoldenInput[] => {
    const out: GoldenInput[] = [];
    for (const type of ['call', 'put'] as const)
      for (const riskFreeRate of axes.riskFreeRate)
        for (const dividendYield of axes.dividendYield)
          for (const volatility of axes.volatility)
            for (const spot of axes.spot)
              for (const strike of axes.strike)
                for (const years of axes.years)
                  out.push({
                    type,
                    spot,
                    strike,
                    years,
                    timeToExpiryYears: years,
                    riskFreeRate,
                    dividendYield,
                    volatility,
                  });
    return out;
  };

  it('972 boundary cases: finite prices and Greeks, never below intrinsic or European (66 failed before)', () => {
    const cases = grid({
      riskFreeRate: [-0.05, 0, 0.25],
      dividendYield: [0, 0.25],
      volatility: [0.001, 0.25, 10],
      spot: [1, 100, 1e7],
      strike: [1, 100, 1e7],
      years: [1 / 365, 1, 10],
    });
    expect(cases.length).toBe(972);
    expect(sweep(cases, true)).toEqual([]);
  });

  it('12,000 rate/yield/IV/moneyness/maturity cases: finite and never below European (746 failed before)', () => {
    const cases = grid({
      riskFreeRate: [-0.01, 0, 0.04, 0.05],
      dividendYield: [0, 0.01, 0.04, 0.05, 0.12],
      volatility: [0.01, 0.05, 0.2, 0.5, 2],
      spot: [1, 60, 100, 140, 1000],
      strike: [1, 100, 1000],
      years: [1 / 365, 0.1, 0.5, 2],
    });
    expect(cases.length).toBe(12_000);
    expect(sweep(cases, false)).toEqual([]);
  });
});

describe('metamorphic properties of the stable evaluation', () => {
  const lowVol = PRICES.filter((c) => c.volatility <= 0.05 && c.spot === 100 && c.strike === 100);

  it('is homogeneous of degree one in (spot, strike) across monetary scales', () => {
    expect(lowVol.length).toBeGreaterThan(5);
    for (const c of lowVol) {
      const base = bjerksundStensland2002Approximation(rawInput(c));
      for (const scale of [1e-6, 1e-3, 1e3, 1e6]) {
        const scaled = bjerksundStensland2002Approximation({
          ...rawInput(c),
          spot: c.spot * scale,
          strike: c.strike * scale,
        });
        expect(Math.abs(scaled / scale - base), `${label(c)} ×${scale}`).toBeLessThanOrEqual(
          2 * PRICE_TOLERANCE * (c.spot + c.strike),
        );
      }
    }
  });

  it('honors the put–call transformation P(S, K, r, q) = C(K, S, q, r) through the public engine', () => {
    const bs2002 = engines.bjerksundStensland2002();
    for (const c of lowVol.filter((p) => p.type === 'put')) {
      const put = priceWith(bs2002, c, false).value;
      const call = priceWith(
        bs2002,
        {
          ...c,
          type: 'call',
          spot: c.strike,
          strike: c.spot,
          riskFreeRate: c.dividendYield,
          dividendYield: c.riskFreeRate,
        },
        false,
      ).value;
      expect(Math.abs(put - call), label(c)).toBeLessThanOrEqual(
        PRICE_TOLERANCE * (c.spot + c.strike),
      );
    }
  });

  it('converges to the exact European value as the carry approaches the rate from below', () => {
    const nearBranch = PRICES.filter(
      (c) =>
        c.volatility === 0.01 &&
        c.years === 0.5 &&
        ((c.type === 'call' && c.riskFreeRate === 0.05 && c.dividendYield < 0.01) ||
          (c.type === 'put' &&
            c.dividendYield === 0.05 &&
            c.riskFreeRate > 0 &&
            c.riskFreeRate < 0.01)),
    );
    expect(nearBranch.length).toBe(8);
    for (const c of nearBranch) {
      const european = blackScholesPrice(rawInput(c));
      const value = bjerksundStensland2002Approximation(rawInput(c));
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value - c.approximation2002), label(c)).toBeLessThanOrEqual(
        PRICE_TOLERANCE * (c.spot + c.strike),
      );
      // The early-exercise premium vanishes continuously at b = r (never below the European floor).
      const carryGap = c.type === 'call' ? c.dividendYield : c.riskFreeRate;
      expect(Math.abs(Math.max(value, european) - european)).toBeLessThanOrEqual(
        Math.max(10 * carryGap * c.spot * c.timeToExpiryYears, 1e-12),
      );
    }
  });
});

describe('stable kernels', () => {
  it('ln Φ is finite and relatively accurate where Φ underflows', () => {
    for (const { x, value } of golden.kernels.logNormalCdf) {
      expect(Math.abs(logNormalCdf(x) - value), `x=${x}`).toBeLessThanOrEqual(
        4 * Number.EPSILON * Math.max(1, Math.abs(value)),
      );
    }
  });

  it('a weighted bivariate tail equals e^{w}·M(a, b; ρ) when the weight overflows and M underflows', () => {
    // The cases are the Ψ arguments BS2002 really produces: weights up to e^{1290} at the
    // reproduction, and O(1) weighted terms at knife-edge spots. Every exponent sums terms of size
    // |w| and (a² + b²)/(2(1 − ρ²)). Rounding those binary64 inputs alone moves the result by EPS times
    // that size, relatively. The quadrature itself is exact to < 1e-16 (checked in mpmath), which the
    // absolute floor covers at the O(1) scale these terms live on.
    const cases = golden.kernels.weightedBivariateNormalCdf;
    expect(cases.some((c) => c.logWeight > 709 && c.value < Number.MIN_VALUE * 1e10)).toBe(true);
    expect(cases.filter((c) => c.value > 1e-3).length).toBeGreaterThan(20);
    for (const { firstLimit: a, secondLimit: b, correlation: rho, logWeight, value } of cases) {
      const actual = weightedBivariateNormalCdf({
        firstLimit: a,
        secondLimit: b,
        correlation: rho,
        logWeight,
      });
      const conditioning = 1 + Math.abs(logWeight) + (a * a + b * b) / (1 - rho * rho);
      expect(Number.isFinite(actual)).toBe(true);
      expect(Math.abs(actual - value), `a=${a} b=${b} ρ=${rho} w=${logWeight}`).toBeLessThanOrEqual(
        1e-16 + 16 * Number.EPSILON * conditioning * Math.abs(value),
      );
    }
  });
});

describe('the shared engine factory refuses a non-finite Greek (Law 7)', () => {
  // A pricer that is finite at the base state but NaN one rate bump up: the shape of the original
  // silent `rho: NaN` (a rate bump crossing zero).
  const engine = makeAmericanEngine({
    name: 'nan-above-zero-rate',
    method: 'test',
    styles: ['american'],
    pricer: (input) =>
      input.riskFreeRate > 0
        ? Number.NaN
        : blackScholesPrice({
            type: input.type,
            spot: input.spot,
            strike: input.strike,
            timeToExpiryYears: input.timeToExpiryYears,
            riskFreeRate: input.riskFreeRate,
            dividendYield: input.dividendYield,
            volatility: input.volatility,
          }),
  });
  const c = {
    type: 'put' as const,
    spot: 100,
    strike: 100,
    years: 0.5,
    riskFreeRate: 0,
    dividendYield: 0.01,
    volatility: 0.2,
  };

  it('throws postcondition.non_finite_result instead of returning rho: NaN', () => {
    expect(() => priceWith(engine as OptionPricingEngine, c)).toThrowError(
      expect.objectContaining({
        name: 'PostconditionError',
        code: 'postcondition.non_finite_result',
      }) as Error,
    );
  });

  it('still prices when Greeks are not requested', () => {
    const result = priceWith(engine as OptionPricingEngine, c, false);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.greeks).toBeUndefined();
  });
});
