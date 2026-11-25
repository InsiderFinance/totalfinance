import { describe, expect, it } from 'vitest';
import { engines, option, type OptionPricingEngine } from '@totalfinance/options';
import { blackScholesExtendedGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { digital } from '@totalfinance/options/exotics';
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
 *   isolates floating-point error.
 * - Greeks against the TRUE derivative: 1e-4 of the Greek's at-the-money magnitude (delta 1, gamma
 *   φ(0)/(Sσ√T), theta Sσφ(0)/(2√T)/365, vega S√Tφ(0)/100, rho KT/100). Each bump is a hundredth of
 *   its coordinate's natural scale, so central-difference truncation is about (1/100)²/6 to /12 of the
 *   Greek, i.e. 1–2e-5. That is multiplied by a higher-derivative ratio of O(1–5) within ±3 standard
 *   deviations of the money (measured worst 2e-5). A lattice adds its own discretization error and
 *   gets 1e-3.
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
  /** The engine's central stencil evaluated exactly; null where it straddles the exercise switch. */
  finiteDifference: Record<GreekName, number | null>;
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
interface GoldenEuropean extends GoldenInput {
  price: number;
  bumps: GoldenGreek['bumps'];
  derivative: Record<GreekName, number>;
}
interface GoldenKink extends GoldenEuropean {
  boundary: number;
  exercised: boolean;
}
const GREEK_NAMES = ['delta', 'gamma', 'theta', 'vega', 'rho'] as const;
const TRUE_DERIVATIVE_TOLERANCE = 1e-4;
const PHI_ZERO = 1 / Math.sqrt(2 * Math.PI);
/** A Greek's at-the-money magnitude, in its documented unit: the yardstick for its error. */
const greekScale = (c: GoldenInput, greek: GreekName): number => {
  const rootT = Math.sqrt(c.timeToExpiryYears);
  switch (greek) {
    case 'delta':
      return 1;
    case 'gamma':
      return PHI_ZERO / (c.spot * c.volatility * rootT);
    case 'theta':
      return (c.spot * c.volatility * PHI_ZERO) / (2 * rootT) / 365;
    case 'vega':
      return (c.spot * rootT * PHI_ZERO) / 100;
    case 'rho':
      return (c.strike * c.timeToExpiryYears) / 100;
  }
};

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
    let compared = 0;
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
        const expected = c.finiteDifference[greek];
        // Null: the central stencil straddles the exercise switch, so the engine differences one-sided
        // (branchAwareDifference); the true-derivative test below covers that coordinate.
        if (expected === null) continue;
        compared++;
        expect(
          Math.abs(result.greeks![greek] - expected),
          `${label(c)} ${greek}`,
        ).toBeLessThanOrEqual(tolerance[greek]);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(60);
  });

  it('every first-order Greek is close to the true model derivative, short expiries included', () => {
    let checked = 0;
    for (const c of GREEKS) {
      // A put at r = 0 sits exactly on the model's own regime switch: there the put is European
      // (early exercise never pays), and for r > 0 it uses the two-boundary formula. Rho has no
      // derivative at that point, so only the other Greeks are compared.
      const onRegimeSwitch = c.type === 'put' && c.riskFreeRate === 0;
      const result = priceWith(bs2002, c);
      for (const greek of GREEK_NAMES) {
        if (onRegimeSwitch && greek === 'rho') continue;
        checked++;
        expect(
          Math.abs(result.greeks![greek] - c.derivative[greek]) / greekScale(c, greek),
          `${label(c)} ${greek}`,
        ).toBeLessThanOrEqual(TRUE_DERIVATIVE_TOLERANCE);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(65);
  });
});

describe('scale-aware finite-difference steps (exact European-equivalent references)', () => {
  // A no-dividend call with r ≥ 0, and a put with r ≤ 0 and q ≥ 0, are never exercised early. Every
  // American engine must therefore report the Black–Scholes–Merton derivatives, which mpmath takes
  // from the BSM price alone.
  const EUROPEAN = golden.europeanEquivalent as unknown as GoldenEuropean[];

  it('the one-day, 1%-vol at-the-money call reports the analytic delta and gamma (was −6.4% and −21%)', () => {
    const receipt = EUROPEAN.find(
      (c) => c.type === 'call' && c.spot === 100 && c.volatility === 0.01 && c.years < 0.01,
    )!;
    expect(receipt.derivative.delta).toBeCloseTo(0.60332913, 8);
    expect(receipt.derivative.gamma).toBeCloseTo(7.36467588, 7);
    for (const engine of [
      engines.bjerksundStensland2002(),
      engines.bjerksundStensland1993(),
      engines.baroneAdesiWhaley(),
    ]) {
      const result = priceWith(engine, receipt);
      // The bump resolves the distribution: a hundredth of S·σ√T ≈ 0.0523, not 0.1.
      expect(result.diagnostics.finiteDifferenceBumps).toEqual(receipt.bumps);
      for (const greek of GREEK_NAMES) {
        const exact = receipt.derivative[greek];
        expect(
          Math.abs(result.greeks![greek] - exact) / Math.abs(exact),
          `${engine.name} ${greek}`,
        ).toBeLessThanOrEqual(2e-5);
      }
    }
  });

  it('BS2002, BS1993 and BAW match the exact derivatives across expiry, volatility, moneyness and scale', () => {
    expect(EUROPEAN.length).toBe(66);
    for (const engine of [
      engines.bjerksundStensland2002(),
      engines.bjerksundStensland1993(),
      engines.baroneAdesiWhaley(),
    ]) {
      for (const c of EUROPEAN) {
        const result = priceWith(engine, c);
        expect(result.diagnostics.finiteDifferenceBumps).toEqual(c.bumps);
        for (const greek of GREEK_NAMES) {
          expect(
            Math.abs(result.greeks![greek] - c.derivative[greek]) / greekScale(c, greek),
            `${engine.name} ${label(c)} ${greek}`,
          ).toBeLessThanOrEqual(TRUE_DERIVATIVE_TOLERANCE);
        }
      }
    }
  });
});

describe('discretized engines keep the reference bumps (lattice node resolution)', () => {
  // A lattice price has interior kinks at its own nodes and early-exercise structure. A scale-aware
  // spot bump (S·σ√T/100 ≈ √N/100 of a node) would difference them: a 401-step Leisen–Reimer American
  // put next to its exercise boundary had a gamma about 21% off, with N-dependent noise. The reference
  // bump (S·1e-3, several nodes wide) is the engine's policy; this checks it against a converged
  // 4001-step reference (second differences of prices at d = 0.1, about nine nodes).
  it('a 401-step Leisen–Reimer put near its exercise boundary matches the converged gamma', () => {
    const contract = option.put({
      underlying: 'X',
      strike: 100,
      expiry: new Date(AS_OF + 7 * 86_400_000).toISOString(),
      style: 'american',
    });
    const market = (spot: number) => ({
      asOf: AS_OF,
      spot,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.05,
    });
    const converged = engines.binomial({ variant: 'leisen-reimer', steps: 4001 });
    const at = (spot: number) =>
      converged.price({ contract, market: market(spot), options: { greeks: false } }).value;
    for (const spot of [99.5, 99.6, 99.75]) {
      const result = engines
        .binomial({ variant: 'leisen-reimer' })
        .price({ contract, market: market(spot), options: { greeks: true } });
      expect(result.diagnostics.finiteDifferenceBumps!['spotStep']).toBeCloseTo(spot * 1e-3, 15);
      const d = 0.1;
      const reference = (at(spot + d) - 2 * at(spot) + at(spot - d)) / (d * d);
      // Measured within 0.24%; 1% leaves room for the 401-step discretization.
      expect(
        Math.abs(result.greeks!.gamma - reference) / reference,
        `S=${spot}`,
      ).toBeLessThanOrEqual(1e-2);
    }
  });

  it('lattices keep the plain central stencils next to the exercise boundary', () => {
    // A one-sided stencil reaches two and three bumps from the base, into the lattice's own node
    // structure. On these 401-step Leisen–Reimer puts (K = 100, r = 5%, q = 0) it gave delta −0.385
    // against a converged −0.632 at one day and 1% vol, and a NEGATIVE gamma at 30 days and 20% vol.
    // Reference-policy engines therefore keep exactly the central stencils of their public prices.
    const cases = [
      { days: 1, volatility: 0.01, spots: [99.98, 99.9947], oracleStep: 0.005 },
      { days: 30, volatility: 0.2, spots: [90.95, 90.92], oracleStep: 0.1 },
    ];
    for (const { days, volatility, spots, oracleStep } of cases) {
      const contract = option.put({
        underlying: 'X',
        strike: 100,
        expiry: new Date(AS_OF + days * 86_400_000).toISOString(),
        style: 'american',
      });
      const market = (spot: number, sigma = volatility, riskFreeRate = 0.05) => ({
        asOf: AS_OF,
        spot,
        riskFreeRate,
        dividendYield: 0,
        volatility: sigma,
      });
      const lattice = engines.binomial({ variant: 'leisen-reimer' });
      const converged = engines.binomial({ variant: 'leisen-reimer', steps: 4001 });
      const at = (engine: OptionPricingEngine, m: ReturnType<typeof market>) =>
        engine.price({ contract, market: m, options: { greeks: false } }).value;
      for (const spot of spots) {
        const result = lattice.price({ contract, market: market(spot), options: { greeks: true } });
        const g = result.greeks!;
        const {
          spotStep: h,
          volatilityStep: hv,
          rateStep: hr,
        } = result.diagnostics.finiteDifferenceBumps!;
        const up = at(lattice, market(spot + h!));
        const down = at(lattice, market(spot - h!));
        // Exactly the central stencils of the engine's own public prices (its pre-existing method).
        expect(g.delta, `S=${spot}`).toBe((up - down) / (2 * h!));
        expect(g.gamma, `S=${spot}`).toBe((up - 2 * result.value + down) / (h! * h!));
        const vegaUp = at(lattice, market(spot, volatility + hv!));
        const vegaDown = at(lattice, market(spot, volatility - hv!));
        expect(g.vega, `S=${spot}`).toBe((vegaUp - vegaDown) / (2 * hv!) / 100);
        const rhoUp = at(lattice, market(spot, volatility, 0.05 + hr!));
        const rhoDown = at(lattice, market(spot, volatility, 0.05 - hr!));
        expect(g.rho, `S=${spot}`).toBe((rhoUp - rhoDown) / (2 * hr!) / 100);
        // Against the converged 4001-step lattice: a put's gamma stays positive, and delta is within
        // the 401-step resolution (measured 5.7–6.8% at one day, 4e-4 absolute at 30 days).
        const d = oracleStep;
        const [fineUp, fine, fineDown] = [spot + d, spot, spot - d].map((s) =>
          at(converged, market(s)),
        );
        const oracleDelta = (fineUp! - fineDown!) / (2 * d);
        const oracleGamma = (fineUp! - 2 * fine! + fineDown!) / (d * d);
        expect(g.gamma, `S=${spot}`).toBeGreaterThan(0);
        if (days === 1) {
          expect(Math.abs(g.delta - oracleDelta) / Math.abs(oracleDelta)).toBeLessThanOrEqual(0.1);
          // 401 steps resolve this one-day, 1%-vol curvature only to 25–32% (spec residual 2).
          expect(Math.abs(g.gamma - oracleGamma) / oracleGamma).toBeLessThanOrEqual(0.35);
        } else {
          expect(Math.abs(g.delta - oracleDelta)).toBeLessThanOrEqual(1e-3);
        }
      }
      // Engines with native spot Greeks keep the central stencil on the bumped coordinates too.
      for (const engine of [engines.binomial({ variant: 'crr' }), engines.trinomial()]) {
        for (const spot of spots) {
          const result = engine.price({
            contract,
            market: market(spot),
            options: { greeks: true },
          });
          const hv = result.diagnostics.finiteDifferenceBumps!['volatilityStep']!;
          const central =
            (at(engine, market(spot, volatility + hv)) -
              at(engine, market(spot, volatility - hv))) /
            (2 * hv) /
            100;
          expect(result.greeks!.vega, `${engine.name} S=${spot}`).toBe(central);
        }
      }
    }
  });
});

describe('the shared bumps also reach the extended (higher-order) Greeks', () => {
  const HIGHER = ['vanna', 'charm', 'speed', 'color', 'zomma', 'veta'] as const;

  it('American extended Greeks of exactly-European contracts match the analytic BSM set', () => {
    // A no-dividend call with r ≥ 0 is never exercised early, so the BS2002 extended set must equal
    // the closed-form BSM extended Greeks (validated against mpmath elsewhere). 1e-3 of each Greek's
    // at-the-money magnitude covers a second or third difference at bumps one hundredth of the scale.
    // With the old fixed bumps the one-day case was off by up to 84% (speed).
    for (const c of (golden.europeanEquivalent as unknown as GoldenEuropean[]).filter(
      (e) => e.type === 'call' && e.spot === 100 && e.volatility >= 0.05,
    )) {
      const result = engines.bjerksundStensland2002().price({
        contract: contractOf(c),
        market: {
          asOf: AS_OF,
          spot: c.spot,
          riskFreeRate: c.riskFreeRate,
          dividendYield: c.dividendYield,
          volatility: c.volatility,
        },
        options: { extendedGreeks: true },
      });
      const analytic = blackScholesExtendedGreeks(rawInput(c)) as unknown as Record<string, number>;
      const greeks = result.greeks as unknown as Record<string, number>;
      // Each higher Greek's at-the-money magnitude, from the gamma and vega yardsticks: errors are
      // judged against it, not against a value that can cross zero (zomma at σ = 5%, one year).
      const gamma = greekScale(c, 'gamma');
      const vegaRaw = greekScale(c, 'vega') * 100;
      const T = c.timeToExpiryYears;
      const rootT = Math.sqrt(T);
      const scale: Record<(typeof HIGHER)[number], number> = {
        vanna: PHI_ZERO / c.volatility,
        charm: PHI_ZERO / T,
        speed: gamma / (c.spot * c.volatility * rootT),
        color: gamma / T,
        zomma: gamma / c.volatility,
        veta: vegaRaw / T,
      };
      for (const greek of HIGHER) {
        expect(
          Math.abs(greeks[greek]! - analytic[greek]!) / scale[greek],
          `${label(c)} ${greek}`,
        ).toBeLessThanOrEqual(1e-3);
      }
    }
  });

  it('digital extended Greeks match exact mpmath derivatives, including one day to expiry', () => {
    // The binary's closed form is differenced by the shared helper. The old fixed bumps were 0.6–2.7%
    // off at one day; the scale-aware bumps are within 3e-4 (measured).
    const cases = golden.digitalExtended as unknown as {
      kind: 'cash-or-nothing' | 'asset-or-nothing';
      type: 'call' | 'put';
      spot: number;
      strike: number;
      timeToExpiryYears: number;
      riskFreeRate: number;
      dividendYield: number;
      volatility: number;
      derivative: Record<(typeof HIGHER)[number] | 'vomma', number>;
    }[];
    expect(cases.length).toBe(13);
    for (const c of cases) {
      const value = digital.extendedGreeks({
        type: c.type,
        kind: c.kind,
        spot: c.spot,
        strike: c.strike,
        timeToExpiryYears: c.timeToExpiryYears,
        riskFreeRate: c.riskFreeRate,
        dividendYield: c.dividendYield,
        volatility: c.volatility,
      }).value as unknown as Record<string, number>;
      for (const greek of [...HIGHER, 'vomma'] as const) {
        const exact = c.derivative[greek];
        expect(
          Math.abs(value[greek]! - exact),
          `${c.kind} ${c.type} S=${c.spot} T=${c.timeToExpiryYears} ${greek}`,
        ).toBeLessThanOrEqual(1e-3 * Math.abs(exact) + 1e-9);
      }
    }
  });
});

describe('exercise-boundary handling of the difference stencils', () => {
  // Spots 0.3 of one spot bump either side of BS2002's second boundary I2, so a central stencil
  // straddles the exercise switch. The exact derivatives belong to the branch holding the base point.
  const KINKS = golden.kinks as unknown as GoldenKink[];
  const bs2002 = engines.bjerksundStensland2002();

  it('a holding spot next to the boundary reports its continuation branch, not a secant', () => {
    const holding = KINKS.filter((c) => !c.exercised);
    expect(holding.length).toBeGreaterThan(0);
    for (const c of holding) {
      const result = priceWith(bs2002, c);
      const step = result.diagnostics.finiteDifferenceBumps!['spotStep']!;
      for (const greek of GREEK_NAMES) {
        expect(
          Math.abs(result.greeks![greek] - c.derivative[greek]) / greekScale(c, greek),
          `${label(c)} ${greek}`,
        ).toBeLessThanOrEqual(TRUE_DERIVATIVE_TOLERANCE);
      }
      // The central stencil there is a secant across the switch: its curvature is an artifact.
      const at = (spot: number) => priceWith(bs2002, { ...c, spot }, false).value;
      const centralGamma = (at(c.spot + step) - 2 * at(c.spot) + at(c.spot - step)) / step ** 2;
      expect(Math.abs(centralGamma - c.derivative.gamma)).toBeGreaterThan(
        100 * Math.abs(result.greeks!.gamma - c.derivative.gamma),
      );
    }
  });

  it('an exercised spot reports the exercise value’s own Greeks: delta 1 and nothing else', () => {
    const exercised = KINKS.filter((c) => c.exercised);
    expect(exercised.length).toBeGreaterThan(0);
    for (const c of exercised) {
      const result = priceWith(bs2002, c);
      expect(result.value).toBe(c.spot - c.strike);
      expect(result.greeks!.delta).toBeCloseTo(1, 9);
      expect(Math.abs(result.greeks!.gamma)).toBeLessThanOrEqual(1e-6 * greekScale(c, 'gamma'));
      expect(Math.abs(result.greeks!.theta)).toBe(0);
      expect(Math.abs(result.greeks!.vega)).toBe(0);
      expect(Math.abs(result.greeks!.rho)).toBe(0);
    }
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

  // The exercise boundary at expiry in the call form: B0 = K·max(1, r/(r − b)), where a put uses its
  // transformed strike S, rate q and carry q − r. Everything else is formed scale-free, so this is
  // the one magnitude that must be representable.
  const expiryBoundary = (c: GoldenInput, scale: number): number => {
    const call = c.type === 'call';
    const strikeLike = (call ? c.strike : c.spot) * scale;
    const rate = call ? c.riskFreeRate : c.dividendYield;
    const carry = call ? c.riskFreeRate - c.dividendYield : c.dividendYield - c.riskFreeRate;
    return carry >= rate ? strikeLike : strikeLike * Math.max(1, rate / (rate - carry));
  };

  it('is homogeneous of degree one in (spot, strike) across monetary scales', () => {
    expect(lowVol.length).toBeGreaterThan(5);
    const ordinary = PRICES.filter(
      (c) => c.volatility === 0.2 && c.spot === 100 && c.strike === 100,
    );
    let compared = 0;
    let unrepresentable = 0;
    for (const c of [...lowVol, ...ordinary]) {
      const base = bjerksundStensland2002Approximation(rawInput(c));
      // Down to 1e-300 and up to 1e300. The paper's products of boundaries (I2²/(S·I1), K²/…) used to
      // overflow above a spot near 1e103 and underflow below 1e-148; they are now products of
      // scale-free ratios.
      for (const scale of [1e-300, 1e-148, 1e-6, 1e-3, 1e3, 1e6, 1e103, 1e162, 1e300]) {
        const scaled = bjerksundStensland2002Approximation({
          ...rawInput(c),
          spot: c.spot * scale,
          strike: c.strike * scale,
        });
        if (expiryBoundary(c, scale) > 1e307) {
          // The documented range limit: B0 itself exceeds binary64. The value is non-finite, so the
          // public engine's postcondition refuses it, and no wrong number is returned.
          unrepresentable++;
          expect(Number.isFinite(scaled), `${label(c)} ×${scale}`).toBe(false);
          continue;
        }
        compared++;
        expect(Math.abs(scaled / scale - base), `${label(c)} ×${scale}`).toBeLessThanOrEqual(
          2 * PRICE_TOLERANCE * (c.spot + c.strike),
        );
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(unrepresentable).toBeLessThan(10);
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
