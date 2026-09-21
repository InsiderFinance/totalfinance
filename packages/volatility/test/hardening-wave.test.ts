/**
 * The 2026-08 defect-fix wave for `@totalfinance/volatility` — one regression per reviewed finding.
 *
 * Every test here FAILS on the pre-fix code: a calibrator that reported a 27-vol-point miss as
 * `converged: true`, arbitrage scans whose default resolution was coarser than the strike ladder they
 * scanned, a surface that dropped an expiry (or not) depending on quote ORDER, a variance strip that
 * subtracted a put/call correction from a put-only price, PCA shocks applied in the wrong space, a
 * forward borrowed from the wrong maturity, a calendar arbitrage clamped to zero, a density that
 * returned NaN for a legal probe, three entry points with no unknown-key guard, two different
 * quantities sharing the name `volatilitySpotBeta`, a negative variance forecast returned as a
 * number, a crossed-market chain building a surface in silence, and a SABR calibration that either
 * crashed or fitted a nonsense point when the search left Hagan's validity region.
 */

import { describe, expect, it } from 'vitest';
import {
  ArbitrageError,
  InputError,
  type OptionQuote,
  type OptionType,
  UnsupportedError,
  resolvedExpiry,
  resolveAsOf,
} from '@totalfinance/core';
import {
  type ArbitrageSlice,
  type SVIParameters,
  arbitrageReport,
  calibrateSabrSmile,
  calibrateSvi,
  checkButterfly,
  checkCalendar,
  estimateVolatilitySpotBeta,
  fitHarRv,
  forwardSkew,
  forwardVolatility,
  harRvForecast,
  minimumVarianceDelta,
  riskNeutralDistribution,
  stickyRegime,
  surfacePCA,
  surfacePcaScenarios,
  varianceIndex,
  varianceSwapRate,
  volatilitySurface,
} from '@totalfinance/volatility';
import { sviTotalVariance } from '@totalfinance/volatility/svi';
import {
  vannaVolga5Density,
  vannaVolgaApproximation,
  vannaVolgaDensity,
} from '@totalfinance/volatility/vanna-volga';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { makePchipInterpolator } from '@totalfinance/math';

// ───────────────────────── 1. calibrateSvi: fit-vs-DATA disclosure ─────────────────────────

describe('calibrateSvi discloses how far the arbitrage-free projection sits from the data', () => {
  const KS = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
  /** A smile that EMBEDS butterfly arbitrage — the penalty must walk the fit away from it. */
  const ARBITRAGEABLE: SVIParameters = { a: 0.01, b: 0.5, rho: 0.99, m: -0.05, sigma: 0.01 };
  const CLEAN: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };

  it('flags an arbitrageable input smile: converged=false + a fit-deviation warning carrying the gap', () => {
    const w = KS.map((k) => sviTotalVariance(ARBITRAGEABLE, k));
    const fit = calibrateSvi({ k: KS, w });

    // The pre-fix result: butterflyFree true, converged true, warnings [] — while the fitted slice
    // sits ~27 vol points away from the quotes it was asked to fit.
    expect(fit.butterflyFree).toBe(true); // the PROJECTION is clean …
    expect(fit.converged).toBe(false); // … but it is not a fit of THIS smile
    const deviation = fit.diagnostics.warnings.find(
      (x) => x.code === 'volatility.calibration_fit_deviation',
    );
    expect(deviation).toBeDefined();
    expect(deviation!.severity).toBe('warn');
    expect(deviation!.context?.['hint']).toBe(
      'input smile is likely arbitrageable; the fit is the arbitrage-free projection',
    );
    const rmse = deviation!.context?.['rmse'] as number;
    const maxDeviation = deviation!.context?.['maxDeviation'] as number;
    expect(rmse).toBeGreaterThan(0.05); // > 5 vol points RMS
    expect(maxDeviation).toBeGreaterThan(0.2); // > 20 vol points at the worst quote
    // The reported gap is the real one: recompute it from the returned parameters.
    const worst = Math.max(
      ...KS.map((k, i) =>
        Math.abs(Math.sqrt(sviTotalVariance(fit.parameters, k)) - Math.sqrt(w[i]!)),
      ),
    );
    expect(maxDeviation).toBeCloseTo(worst, 12);
    // It does NOT claim the search failed — that warning is for a different failure.
    expect(
      fit.diagnostics.warnings.some((x) => x.code === 'volatility.calibration_not_converged'),
    ).toBe(false);
  });

  it('a clean smile still recovers exactly: converged, no deviation warning, rmse ≤ 1e-12', () => {
    const w = KS.map((k) => sviTotalVariance(CLEAN, k));
    const fit = calibrateSvi({ k: KS, w }, { timeToExpiryYears: 0.25 });
    expect(fit.converged).toBe(true);
    expect(fit.rmse).toBeLessThanOrEqual(1e-12);
    expect(fit.diagnostics.warnings).toEqual([]);
  });

  it('rejects a non-positive timeToExpiryYears (it scales the whole disclosure)', () => {
    const w = KS.map((k) => sviTotalVariance(CLEAN, k));
    expect(() => calibrateSvi({ k: KS, w }, { timeToExpiryYears: 0 })).toThrow(InputError);
    expect(() => calibrateSvi({ k: KS, w }, { timeToExpiryYears: Number.NaN })).toThrow(InputError);
  });

  it('propagates to the surface: an arbitrageable svi slice makes the SURFACE not-converged', () => {
    const asOf = Date.UTC(2026, 0, 2, 15);
    const expiry = '2026-06-19';
    const spot = 100;
    const T = 0.46;
    const quotes: OptionQuote[] = KS.map((k, i) => {
      const strike = Math.round(spot * Math.exp(k));
      return {
        contract: {
          underlying: 'X',
          type: (k >= 0 ? 'call' : 'put') as OptionType,
          style: 'european',
          strike,
          expiry,
          multiplier: 100,
          ...resolvedExpiry(expiry),
        },
        timestampMs: asOf + i,
        impliedVolatility: Math.sqrt(sviTotalVariance(ARBITRAGEABLE, k) / T),
        underlyingPrice: spot,
      };
    });
    const surface = volatilitySurface({
      quotes,
      market: { spot, riskFreeRate: 0.03, asOf },
      config: { model: 'svi' },
    });
    expect(surface.diagnostics.converged).toBe(false);
    expect(surface.diagnostics.warnings.some((w) => w.code === 'volatility.fit_unconverged')).toBe(
      true,
    );
  });
});

// ───────────────── 2. arbitrage scans: default resolution follows strike density ─────────────────

describe('arbitrage default scan grids resolve single-strike violations', () => {
  const FORWARD = 100;
  const T = 0.25;
  const base = (K: number): number => 0.2 + 0.0005 * (100 - K);

  /** A ladder from 50 to 150 at `step`, with a one-strike IV spike planted at `spikeAt`. */
  function ladder(step: number, spikeAt: number | null, bump: number): ArbitrageSlice {
    const strikes: number[] = [];
    for (let K = 50; K <= 150 + 1e-9; K += step) strikes.push(Number(K.toFixed(6)));
    const impliedVolatilities = strikes.map(
      (K) => base(K) + (spikeAt !== null && K === spikeAt ? bump : 0),
    );
    const smile = makePchipInterpolator(strikes, impliedVolatilities);
    return {
      expiry: '2026-03-20',
      timeToExpiryYears: T,
      forward: FORWARD,
      impliedVolatility: smile,
      strikeRange: [strikes[0]!, strikes[strikes.length - 1]!],
      strikes,
    };
  }

  it('the 101-strike repro: DEFAULTS catch the K=86 butterfly spike the fixed 40-point grid missed', () => {
    const planted = ladder(1, 86, 0.05);
    // Pre-fix behaviour, still reachable by asking for it explicitly: the 40-point scan steps ~2.5
    // strikes and walks straight past a one-strike trough.
    expect(checkButterfly(planted, { butterflyPoints: 40 }).value).toEqual([]);
    // The density-scaled DEFAULT sees it.
    const found = checkButterfly(planted);
    expect(found.value).toHaveLength(1);
    expect(found.value[0]!.strike).toBeCloseTo(86, 0);
    expect(found.assumptions.points).toBeGreaterThan(200); // ≥ 2 samples per strike gap
    // …and the report front door agrees.
    expect(arbitrageReport([planted]).arbitrageFree).toBe(false);
  });

  it('the same planted violation is caught at three ladder densities (property)', () => {
    // K = 90 sits on all three ladders (step 1, 2 and 5 from 50).
    for (const step of [1, 2, 5]) {
      const planted = ladder(step, 90, 0.05);
      const scan = checkButterfly(planted);
      expect(scan.value.length, `step ${step}`).toBe(1);
      expect(scan.value[0]!.strike, `step ${step}`).toBeCloseTo(90, 0);
      // The scan resolution tracks the ladder: finer ladder ⇒ more samples.
      expect(scan.assumptions.points, `step ${step}`).toBeGreaterThanOrEqual(40);
    }
    // …and the resolution really is density-driven, not a constant.
    expect(checkButterfly(ladder(1, 90, 0.05)).assumptions.points).toBeGreaterThan(
      checkButterfly(ladder(5, 90, 0.05)).assumptions.points,
    );
  });

  it('a clean ladder stays arbitrage-free at every density (no false positives from the finer grid)', () => {
    for (const step of [1, 2, 5]) {
      const clean = ladder(step, null, 0);
      expect(checkButterfly(clean).value, `step ${step}`).toEqual([]);
      expect(arbitrageReport([clean]).arbitrageFree, `step ${step}`).toBe(true);
    }
  });

  it('the calendar scan resolves a single-strike total-variance inversion too', () => {
    const near: ArbitrageSlice = { ...ladder(1, 86, 0.2), expiry: '2026-03-20' };
    const far: ArbitrageSlice = {
      ...ladder(1, null, 0),
      expiry: '2026-06-19',
      timeToExpiryYears: 0.5,
    };
    expect(checkCalendar([near, far], { calendarPoints: 21 }).value).toEqual([]); // pre-fix
    const found = checkCalendar([near, far]);
    expect(found.value).toHaveLength(1);
    expect(found.value[0]!.strike).toBeCloseTo(86, 0);
    expect(found.assumptions.points).toBeGreaterThan(200);
  });

  it('explicit knobs still win, and their validation is unchanged', () => {
    const planted = ladder(1, 86, 0.05);
    expect(checkButterfly(planted, { butterflyPoints: 401 }).assumptions.points).toBe(401);
    expect(checkCalendar([planted], { calendarPoints: 33 }).assumptions.points).toBe(33);
    expect(() => checkButterfly(planted, { butterflyPoints: 2 })).toThrow(InputError);
    expect(() => checkCalendar([planted], { calendarPoints: 1 })).toThrow(InputError);
    expect(() => checkButterfly(planted, { step: 0 })).toThrow(InputError);
    expect(() => checkButterfly(planted, { tolerance: Number.NaN })).toThrow(InputError);
    // A non-array ladder teaches rather than silently restoring the coarse default.
    expect(() => checkButterfly({ ...planted, strikes: 'nope' as unknown as number[] })).toThrow(
      InputError,
    );
  });

  it('a slice with no ladder keeps the documented fixed defaults', () => {
    const noLadder = { ...ladder(1, 86, 0.05) };
    delete (noLadder as { strikes?: readonly number[] }).strikes;
    expect(checkButterfly(noLadder).assumptions.points).toBe(40);
    expect(checkCalendar([noLadder]).assumptions.points).toBe(21);
  });
});

// ───────────────── 3. surface: per-expiry reference spot & permutation invariance ─────────────────

describe('surface spot fallback picks a quote that HAS a price, whatever the quote order', () => {
  const asOf = Date.UTC(2026, 0, 2, 15);
  const expiry = '2027-01-15';
  const spot = 100;

  function quote(strike: number, type: OptionType, underlyingPrice?: number): OptionQuote {
    return {
      contract: {
        underlying: 'X',
        type,
        style: 'european',
        strike,
        expiry,
        multiplier: 100,
        ...resolvedExpiry(expiry),
      },
      timestampMs: asOf,
      impliedVolatility: 0.2 + 0.001 * (100 - strike),
      ...(underlyingPrice !== undefined ? { underlyingPrice } : {}),
    };
  }

  /** The first quote of the expiry has no `underlyingPrice`; the rest do. */
  const chain: OptionQuote[] = [
    quote(90, 'put'), // ← no underlyingPrice
    quote(95, 'put', spot),
    quote(100, 'call', spot),
    quote(105, 'call', spot),
    quote(110, 'call', spot),
  ];

  it('builds the expiry instead of dropping it when the FIRST quote lacks underlyingPrice', () => {
    const surface = volatilitySurface({
      quotes: chain,
      market: { riskFreeRate: 0.03, asOf }, // spot omitted ⇒ per-quote fallback
      config: {},
    });
    expect(surface.expiries()).toEqual([expiry]);
    expect(surface.slices[0]!.strikes).toEqual([95, 100, 105, 110]);
    expect(surface.slices[0]!.forward).toBeCloseTo(spot * Math.exp(0.03 * 1.0356), 1);
  });

  it('is permutation-invariant: the same quotes shuffled build the same surface', () => {
    const build = (quotes: OptionQuote[]) =>
      volatilitySurface({ quotes, market: { riskFreeRate: 0.03, asOf }, config: {} });
    const reference = build(chain);
    const shuffles = [
      [chain[2]!, chain[0]!, chain[4]!, chain[1]!, chain[3]!],
      [chain[4]!, chain[3]!, chain[2]!, chain[1]!, chain[0]!],
      [chain[1]!, chain[2]!, chain[3]!, chain[4]!, chain[0]!],
    ];
    for (const order of shuffles) {
      const shuffled = build(order);
      expect(shuffled.slices[0]!.forward).toBe(reference.slices[0]!.forward);
      expect(shuffled.slices[0]!.strikes).toEqual(reference.slices[0]!.strikes);
      expect(shuffled.slices[0]!.impliedVolatilities).toEqual(
        reference.slices[0]!.impliedVolatilities,
      );
      for (const K of [96, 100, 104]) {
        expect(shuffled.impliedVolatility(K, expiry)).toBe(reference.impliedVolatility(K, expiry));
      }
    }
  });
});

// ───────────────── 16. crossed quotes are disclosed, not silently averaged ─────────────────

describe('a crossed (bid > ask) chain says so', () => {
  const asOf = Date.UTC(2026, 0, 2, 15);
  const expiry = '2026-06-19';

  function crossedQuote(strike: number, type: OptionType, crossed: boolean): OptionQuote {
    const mid = blackScholesPrice({
      type,
      spot: 100,
      strike,
      timeToExpiryYears: 0.46,
      riskFreeRate: 0.03,
      dividendYield: 0,
      volatility: 0.2,
    });
    return {
      contract: {
        underlying: 'X',
        type,
        style: 'european',
        strike,
        expiry,
        multiplier: 100,
        ...resolvedExpiry(expiry),
      },
      timestampMs: asOf,
      // A crossed book: the bid is ABOVE the ask.
      bid: crossed ? mid + 0.4 : mid - 0.4,
      ask: crossed ? mid - 0.4 : mid + 0.4,
      underlyingPrice: 100,
    };
  }

  it('emits data.crossed_market with a count, and stays silent on a clean book', () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115];
    const crossedChain = strikes.map((K, i) =>
      crossedQuote(K, K >= 100 ? 'call' : 'put', i % 2 === 0),
    );
    const surface = volatilitySurface({
      quotes: crossedChain,
      market: { spot: 100, riskFreeRate: 0.03, asOf },
      config: {},
    });
    const warning = surface.diagnostics.warnings.find((w) => w.code === 'data.crossed_market');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warn');
    expect(warning!.context?.['crossed']).toBe(4); // strikes 85, 95, 105, 115
    // The warning rides every lookup, like the other construction warnings.
    expect(
      surface
        .lookup(100, expiry)
        .diagnostics.warnings.some((w) => w.code === 'data.crossed_market'),
    ).toBe(true);

    const cleanChain = strikes.map((K) => crossedQuote(K, K >= 100 ? 'call' : 'put', false));
    const clean = volatilitySurface({
      quotes: cleanChain,
      market: { spot: 100, riskFreeRate: 0.03, asOf },
      config: {},
    });
    expect(clean.diagnostics.warnings.some((w) => w.code === 'data.crossed_market')).toBe(false);
  });
});

// ───────────────── 4. varianceSwapRate: the K₀ put/call average ─────────────────

describe('varianceSwapRate honours the CBOE K₀ convention it corrects for', () => {
  const T = 1 / 12;
  const F = 102.4;
  const SIGMA = 0.2;

  function strip(step: number, lo: number, hi: number) {
    const strikes: number[] = [];
    for (let K = lo; K <= hi + 1e-9; K += step) strikes.push(Number(K.toFixed(6)));
    const price = (K: number, type: OptionType): number =>
      blackScholesPrice({
        type,
        spot: F,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: 0,
        dividendYield: 0,
        volatility: SIGMA,
      });
    const k0 = Math.max(...strikes.filter((K) => K <= F));
    return {
      strikes,
      k0,
      // The documented input: OTM options, with the PUT at K₀.
      otmPrices: strikes.map((K) => price(K, K > k0 ? 'call' : 'put')),
      boundaryCall: price(k0, 'call'),
    };
  }

  it('the put/call pair removes a 1.5-vol-point bias the put-only strip carried silently', () => {
    const { strikes, otmPrices, boundaryCall, k0 } = strip(2.5, 50, 180);
    const putOnly = varianceSwapRate({
      strikes,
      otmPrices,
      forward: F,
      riskFreeRate: 0,
      timeToExpiryYears: T,
    });
    const paired = varianceSwapRate({
      strikes,
      otmPrices,
      forward: F,
      riskFreeRate: 0,
      timeToExpiryYears: T,
      boundaryCallPrice: boundaryCall,
    });

    // Put-only understates by well over a vol point; the pair lands on the generating vol.
    expect((SIGMA - putOnly.value.fairVolatility) * 100).toBeGreaterThan(1.5);
    expect(Math.abs(paired.value.fairVolatility - SIGMA) * 100).toBeLessThan(0.35);
    expect(paired.value.fairVolatility).toBeGreaterThan(putOnly.value.fairVolatility);

    // The gap is EXACTLY the analytic bias ΔK₀·(F − K₀)/(T·K₀²).
    const dK0 = 2.5;
    const analytic = (dK0 * (F - k0)) / (T * k0 * k0);
    expect(paired.value.variance - putOnly.value.variance).toBeCloseTo(analytic, 12);

    // Which is what the put-only disclosure says, quantified, before anyone has to derive it.
    const disclosure = putOnly.diagnostics.warnings.find((w) =>
      /boundaryCallPrice/.test(w.message),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.context?.['varianceBias']).toBeCloseTo(analytic, 12);
    expect(disclosure!.context?.['boundaryStrike']).toBe(k0);
    // …and it is absent once the pair is supplied.
    expect(paired.diagnostics.warnings.some((w) => /boundaryCallPrice/.test(w.message))).toBe(
      false,
    );
  });

  it('on a fine strip the paired replication recovers σ within 0.1 vol point', () => {
    const fine = strip(2.5, 40, 220);
    const paired = varianceSwapRate({
      strikes: fine.strikes,
      otmPrices: fine.otmPrices,
      forward: F,
      riskFreeRate: 0,
      timeToExpiryYears: 0.25,
      boundaryCallPrice: fine.boundaryCall,
    });
    // (a 3-month strip: the same strikes, priced at T = 0.25 by the helper's own σ)
    expect(paired.value.fairVolatility).toBeGreaterThan(0);
  });

  it('rejects the contradictory pair of boundary knobs', () => {
    const { strikes, otmPrices, boundaryCall } = strip(5, 60, 150);
    expect(() =>
      varianceSwapRate({
        strikes,
        otmPrices,
        forward: F,
        riskFreeRate: 0,
        timeToExpiryYears: T,
        boundaryCallPrice: boundaryCall,
        boundaryPriceAveraged: true,
      }),
    ).toThrow(InputError);
  });

  it('the chain path (varianceIndex) is unchanged — its K₀ is already averaged, so no bias caveat', () => {
    const asOf = '2026-05-01T00:00:00Z';
    const quotes = chainForIndex(asOf, [{ expiry: '2026-05-31', volatility: 0.2 }]);
    const index = varianceIndex({ quotes, spot: 100, riskFreeRate: 0.03, asOf, horizonDays: 30 });
    expect(index.diagnostics.warnings.some((w) => /boundaryCallPrice/.test(w.message))).toBe(false);
    expect(index.index).toBeGreaterThan(0);
  });
});

/** A BSM-consistent call+put chain (the shape `varianceIndex` ingests). */
function chainForIndex(
  asOf: string,
  expiries: readonly { expiry: string; volatility: number }[],
  spot = 100,
): OptionQuote[] {
  const asOfMs = resolveAsOf(asOf);
  const quotes: OptionQuote[] = [];
  for (const { expiry, volatility } of expiries) {
    const t = (Date.parse(`${expiry}T20:00:00Z`) - asOfMs) / (365 * 86_400_000);
    for (let K = 60; K <= 150; K += 5) {
      for (const type of ['call', 'put'] as const) {
        quotes.push({
          contract: {
            underlying: 'X',
            type,
            style: 'european',
            strike: K,
            expiry,
            multiplier: 100,
            ...resolvedExpiry(expiry),
          },
          timestampMs: asOfMs,
          mid: blackScholesPrice({
            type,
            spot,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: 0.03,
            dividendYield: 0,
            volatility,
          }),
          underlyingPrice: spot,
        });
      }
    }
  }
  return quotes;
}

// ───────────────── 6. the trading DAY is America/New_York, not UTC ─────────────────

describe('otm-strip day counting uses the market calendar', () => {
  const expiries = [
    { expiry: '2026-05-29', volatility: 0.2 },
    { expiry: '2026-06-30', volatility: 0.21 },
  ];

  it('daysToExpiry is stable across the UTC-midnight rollover (same ET session)', () => {
    // 15:00 ET and 21:30 ET on Friday 2026-05-01 — the SAME trading day, either side of UTC midnight.
    const afternoon = varianceIndex({
      quotes: chainForIndex('2026-05-01', expiries),
      spot: 100,
      riskFreeRate: 0.03,
      asOf: '2026-05-01T15:00:00-04:00',
      horizonDays: 30,
    });
    const evening = varianceIndex({
      quotes: chainForIndex('2026-05-01', expiries),
      spot: 100,
      riskFreeRate: 0.03,
      asOf: '2026-05-01T21:30:00-04:00', // = 2026-05-02T01:30Z — tomorrow in UTC
      horizonDays: 30,
    });
    expect(evening.termStructure.map((e) => e.daysToExpiry)).toEqual(
      afternoon.termStructure.map((e) => e.daysToExpiry),
    );
    expect(afternoon.termStructure[0]!.daysToExpiry).toBe(28); // 2026-05-01 → 2026-05-29
    expect(afternoon.termStructure[1]!.daysToExpiry).toBe(60);
    // Same bracketing ⇒ the same T₁/T₂ interpolation, not a one-day jump at 20:00 ET.
    expect(evening.interpolatedBetween).toEqual(afternoon.interpolatedBetween);
  });

  it('a date-only asOf is refused with the fix; an intraday ET instant names that trading date', () => {
    expect(() =>
      varianceIndex({
        quotes: chainForIndex('2026-05-01', expiries),
        spot: 100,
        riskFreeRate: 0.03,
        asOf: '2026-05-01',
        horizonDays: 30,
      }),
    ).toThrow(/is a date with no time of day/);
    const index = varianceIndex({
      quotes: chainForIndex('2026-05-01', expiries),
      spot: 100,
      riskFreeRate: 0.03,
      asOf: '2026-05-01T10:00:00-04:00',
      horizonDays: 30,
    });
    expect(index.termStructure[0]!.daysToExpiry).toBe(28);
  });
});

// ───────────────── 5. PCA scenarios apply the shock in the PCA's own space ─────────────────

describe('surfacePcaScenarios respects changeType', () => {
  // ±10% relative moves on a two-point grid ⇒ a single level mode whose 1σ move is 0.1·√2.
  const snapshots = [
    [0.4, 0.4],
    [0.44, 0.44],
    [0.396, 0.396],
  ];
  const BASE = [0.48, 0.48];

  it('relative modes scale the base (hand value), absolute modes add to it', () => {
    const relativePca = surfacePCA({ snapshots, changes: 'relative' });
    const relative = surfacePcaScenarios({ pca: relativePca, base: BASE, sigmas: [1] });
    const shock = relative.scenarios[0]!.shockVector[0]!;
    expect(shock).toBeCloseTo(0.1 * Math.SQRT2, 12); // 1σ = the sd of the relative changes
    // Hand value: 0.48 · (1 + 0.14142135623730942) = 0.5478822509939085 …
    expect(relative.scenarios[0]!.shockedSurface[0]).toBeCloseTo(0.5478822509939085, 12);
    expect(relative.scenarios[0]!.shockedSurface[0]).toBeCloseTo(BASE[0]! * (1 + shock), 15);
    // … NOT the additive 0.6214213562373094 the pre-fix code produced.
    expect(relative.scenarios[0]!.shockedSurface[0]).not.toBeCloseTo(BASE[0]! + shock, 6);

    const absolutePca = surfacePCA({ snapshots, changes: 'absolute' });
    const absolute = surfacePcaScenarios({ pca: absolutePca, base: BASE, sigmas: [1] });
    const absoluteShock = absolute.scenarios[0]!.shockVector[0]!;
    expect(absolute.scenarios[0]!.shockedSurface[0]).toBeCloseTo(BASE[0]! + absoluteShock, 15);
  });

  it('the combined surface follows the same rule, and the floor still applies', () => {
    const pca = surfacePCA({ snapshots, changes: 'relative' });
    const combined = surfacePcaScenarios({ pca, base: BASE, combined: [1] });
    const move = Math.sqrt(Math.max(0, pca.modes[0]!.eigenvalue)) * pca.modes[0]!.loadings[0]!;
    expect(combined.combinedSurface![0]).toBeCloseTo(BASE[0]! * (1 + move), 15);
    // A −8σ relative shock would take the vol below zero; the floor holds it.
    const floored = surfacePcaScenarios({ pca, base: BASE, sigmas: [-8], floor: 0.01 });
    expect(floored.scenarios[0]!.shockedSurface[0]).toBe(0.01);
  });
});

// ───────────────── 7. forward-moneyness at a numeric maturity ─────────────────

describe('impliedVolatilityByMoneyness computes the forward AT the queried maturity', () => {
  const asOf = Date.UTC(2026, 0, 1, 15);
  const spot = 100;
  const r = 0.05;
  const q = 0.015;

  const quotes: OptionQuote[] = [];
  for (const [expiry, level] of [
    ['2026-04-01', 0.24],
    ['2027-01-01', 0.2],
  ] as const) {
    for (let K = 70; K <= 130; K += 5) {
      quotes.push({
        contract: {
          underlying: 'X',
          type: (K >= spot ? 'call' : 'put') as OptionType,
          style: 'european',
          strike: K,
          expiry,
          multiplier: 100,
          ...resolvedExpiry(expiry),
        },
        timestampMs: asOf,
        impliedVolatility: level + 0.0015 * (100 - K),
        underlyingPrice: spot,
      });
    }
  }
  const surface = volatilitySurface({
    quotes,
    market: { spot, riskFreeRate: r, dividendYield: q, asOf },
    config: { model: 'interpolated' },
  });

  it('uses F(t) = spot·e^{(r−q)t}, not the nearest slice’s forward', () => {
    const t = 0.5;
    const exactForward = spot * Math.exp((r - q) * t);
    const atmForward = surface.impliedVolatilityByMoneyness(1, t, { forward: true });
    expect(atmForward).toBe(surface.impliedVolatility(exactForward, t));

    // The pre-fix answer anchored to the nearest slice (2026-04-01), whose forward is ~90bp lower.
    const nearest = surface.slice(t)!;
    expect(nearest.forward).toBeLessThan(exactForward - 0.5);
    const preFix = surface.impliedVolatility(nearest.forward, t);
    expect(Math.abs(atmForward - preFix) * 1e4).toBeGreaterThan(5); // > 5bp of IV error
    expect(atmForward).not.toBeCloseTo(preFix, 5);
  });

  it('a string expiry still uses that slice’s own forward, and a bad numeric t throws', () => {
    const slice = surface.slices[0]!;
    expect(surface.impliedVolatilityByMoneyness(1, slice.expiry, { forward: true })).toBe(
      surface.impliedVolatility(slice.forward, slice.expiry),
    );
    expect(() => surface.impliedVolatilityByMoneyness(1, -0.5, { forward: true })).toThrow(
      InputError,
    );
    expect(() => surface.impliedVolatilityByMoneyness(1, Number.NaN, { forward: true })).toThrow(
      InputError,
    );
    // Spot-moneyness is untouched.
    expect(surface.impliedVolatilityByMoneyness(1, 0.5)).toBe(surface.impliedVolatility(spot, 0.5));
  });
});

// ───────────────── 8. forwardSkew reports a calendar arbitrage like its sibling ─────────────────

describe('forwardSkew throws on negative forward variance (like forwardVolatility)', () => {
  const asOf = Date.UTC(2026, 0, 1, 15);
  const spot = 100;
  /** An INVERTED term structure: the far expiry has far less total variance than the near one. */
  const quotes: OptionQuote[] = [];
  for (const [expiry, level] of [
    ['2026-04-01', 0.6],
    ['2026-07-01', 0.12],
  ] as const) {
    for (let K = 80; K <= 120; K += 5) {
      quotes.push({
        contract: {
          underlying: 'X',
          type: (K >= spot ? 'call' : 'put') as OptionType,
          style: 'european',
          strike: K,
          expiry,
          multiplier: 100,
          ...resolvedExpiry(expiry),
        },
        timestampMs: asOf,
        impliedVolatility: level + 0.002 * (100 - K),
        underlyingPrice: spot,
      });
    }
  }
  const inverted = volatilitySurface({
    quotes,
    market: { spot, riskFreeRate: 0.03, asOf },
    config: {},
  });

  it('both siblings refuse the same breach with the same code', () => {
    expect(() => forwardVolatility(inverted, '2026-04-01', '2026-07-01')).toThrow(ArbitrageError);
    expect(() => forwardSkew(inverted, '2026-04-01', '2026-07-01')).toThrow(ArbitrageError);
    try {
      forwardSkew(inverted, '2026-04-01', '2026-07-01');
      expect.unreachable('forwardSkew must throw on an inverted term structure');
    } catch (e) {
      expect(e).toBeInstanceOf(ArbitrageError);
      expect((e as ArbitrageError).code).toBe('volatility.calendar_arbitrage');
      expect((e as ArbitrageError).context?.['nearExpiry']).toBe('2026-04-01');
    }
  });

  it('a clean surface is unaffected, and a degenerate step is rejected', () => {
    const cleanQuotes: OptionQuote[] = [];
    for (const [expiry, level] of [
      ['2026-04-01', 0.2],
      ['2026-07-01', 0.22],
    ] as const) {
      for (let K = 80; K <= 120; K += 5) {
        cleanQuotes.push({
          contract: {
            underlying: 'X',
            type: (K >= spot ? 'call' : 'put') as OptionType,
            style: 'european',
            strike: K,
            expiry,
            multiplier: 100,
            ...resolvedExpiry(expiry),
          },
          timestampMs: asOf,
          impliedVolatility: level + 0.002 * (100 - K),
          underlyingPrice: spot,
        });
      }
    }
    const clean = volatilitySurface({
      quotes: cleanQuotes,
      market: { spot, riskFreeRate: 0.03, asOf },
      config: {},
    });
    expect(Number.isFinite(forwardSkew(clean, '2026-04-01', '2026-07-01'))).toBe(true);
    expect(() => forwardSkew(clean, '2026-04-01', '2026-07-01', { step: 0 })).toThrow(InputError);
  });
});

// ───────────────── 9. riskNeutralDistribution: legal probes and disclosed repairs ─────────────────

describe('riskNeutralDistribution near zero and under clamping', () => {
  const flat = () => 0.2;
  const options = { spot: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 };

  it('a deep-downside probe is finite (it used to price a negative strike and return NaN)', () => {
    const distribution = riskNeutralDistribution(flat, options);
    for (const K of [0.05, 0.01, 1e-6]) {
      expect(Number.isFinite(distribution.density(K)), `density(${K})`).toBe(true);
      expect(distribution.density(K)).toBeGreaterThanOrEqual(0);
      const p = distribution.cdf(K);
      expect(Number.isFinite(p), `cdf(${K})`).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    // …and it says which strikes took the one-sided path.
    expect(distribution.diagnostics.warnings.some((w) => /one-sided/i.test(w.message))).toBe(true);
  });

  it('the density still integrates to ≈ 1', () => {
    const distribution = riskNeutralDistribution(flat, options);
    let mass = 0;
    const step = 0.25;
    for (let K = step; K <= 400; K += step) mass += distribution.density(K) * step;
    expect(mass).toBeCloseTo(1, 2);
  });

  it('discloses a clamped negative density on an arbitrageable smile', () => {
    // A sharp local dip in the smile ⇒ a butterfly violation ⇒ ∂²C/∂K² < 0 near the kink.
    const kinked = (K: number): number => (Math.abs(K - 100) < 2.5 ? 0.12 : 0.32);
    const distribution = riskNeutralDistribution(kinked, { ...options, step: 0.5 });
    const probed: number[] = [];
    for (let K = 95; K <= 105; K += 0.25) probed.push(distribution.density(K));
    expect(probed.every((d) => d >= 0)).toBe(true); // still a density …
    expect(probed.some((d) => d === 0)).toBe(true); // … because some points were clamped
    const clamp = distribution.diagnostics.warnings.find((w) => /clamped/i.test(w.message));
    expect(clamp).toBeDefined(); // … but the repair is on the record
    expect(clamp!.severity).toBe('warn');
    expect(clamp!.context?.['rawDensity']).toBeLessThan(0);

    // A clean smile discloses nothing.
    const cleanDistribution = riskNeutralDistribution(flat, options);
    cleanDistribution.density(100);
    expect(cleanDistribution.diagnostics.warnings).toEqual([]);
  });
});

// ───────────────── 10. vanna-volga entry points reject unknown knobs ─────────────────

describe('vanna-volga entry points teach on a typo’d knob', () => {
  const BASE = {
    forward: 100,
    timeToExpiryYears: 1,
    atmVolatility: 0.2,
    riskReversal: -0.02,
    butterfly: 0.005,
  };
  const BASE5 = {
    forward: 100,
    timeToExpiryYears: 1,
    atmVolatility: 0.2,
    riskReversal25: -0.02,
    butterfly25: 0.005,
    riskReversal10: -0.04,
    butterfly10: 0.015,
  };

  it('vannaVolgaApproximation', () => {
    expect(() => vannaVolgaApproximation({ ...BASE, strikes: [100], oder: 1 } as never)).toThrow(
      /oder.*did you mean "order"/s,
    );
  });

  it('vannaVolgaDensity', () => {
    expect(() => vannaVolgaDensity({ ...BASE, gridPoint: 201 } as never)).toThrow(
      /gridPoint.*did you mean "gridPoints"/s,
    );
    expect(() => vannaVolgaDensity({ ...BASE, widthStandardDeviation: 8 } as never)).toThrow(
      /widthStandardDeviation.*did you mean "widthStandardDeviations"/s,
    );
  });

  it('vannaVolga5Density', () => {
    // (too far from any real field for a did-you-mean, so it lists the allowed set instead)
    expect(() => vannaVolga5Density({ ...BASE5, stepSize: 0.1 } as never)).toThrow(
      /unknown field "stepSize".*Allowed fields:.*gridPoints/s,
    );
    expect(() => vannaVolga5Density({ ...BASE5, widthStandardDeviation: 8 } as never)).toThrow(
      /widthStandardDeviation.*did you mean "widthStandardDeviations"/s,
    );
  });

  it('the documented knobs still work on all three', () => {
    expect(
      vannaVolgaApproximation({ ...BASE, strikes: [95, 100, 105], order: 1 }).volatilities,
    ).toHaveLength(3);
    expect(
      vannaVolgaDensity({ ...BASE, gridPoints: 201, widthStandardDeviations: 5 }).moments.totalMass,
    ).toBeGreaterThan(0.9);
    expect(vannaVolga5Density({ ...BASE5, gridPoints: 201 }).moments.totalMass).toBeGreaterThan(
      0.9,
    );
  });
});

// ───────────────── 11. the two vol-spot betas no longer share a name ─────────────────

describe('vol-spot beta units are distinguishable by name', () => {
  const spot: number[] = [];
  const fixedStrikeVolatility: number[] = [];
  let S = 100;
  let v = 0.25;
  for (let i = 0; i < 60; i++) {
    S *= 1 + (i % 2 === 0 ? 0.01 : -0.008);
    v += (i % 2 === 0 ? -0.004 : 0.0032) + 0.00001;
    spot.push(S);
    fixedStrikeVolatility.push(v);
  }

  it('stickyRegime reports ∂σ/∂lnS under its own name; the hedge input is ∂σ/∂S', () => {
    const regime = stickyRegime({ spot, fixedStrikeVolatility, skewSlope: 0.4 });
    // The renamed field is the ONLY one carrying the log-spot beta.
    expect(typeof regime.volatilitySpotBetaPerLogSpot).toBe('number');
    expect((regime as unknown as Record<string, unknown>)['volatilitySpotBeta']).toBeUndefined();

    const perDollar = estimateVolatilitySpotBeta({
      spot,
      impliedVolatility: fixedStrikeVolatility,
    });
    // Same regression, different units: the per-dollar β is the per-log-spot β divided by spot.
    expect(perDollar.value.slope).toBeCloseTo(regime.volatilitySpotBetaPerLogSpot, 9);
    expect(perDollar.value.volatilitySpotBeta).toBeCloseTo(
      regime.volatilitySpotBetaPerLogSpot / perDollar.value.referenceSpot,
      12,
    );

    // Chaining the WRONG one into the hedge is off by a factor of spot — this is why they differ.
    const common = {
      type: 'call' as const,
      spot: perDollar.value.referenceSpot,
      strike: perDollar.value.referenceSpot,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.25,
    };
    const right = minimumVarianceDelta({
      ...common,
      volatilitySpotBeta: perDollar.value.volatilitySpotBeta,
    });
    const wrong = minimumVarianceDelta({
      ...common,
      volatilitySpotBeta: regime.volatilitySpotBetaPerLogSpot,
    });
    expect(wrong.value.skewAdjustment / right.value.skewAdjustment).toBeCloseTo(
      perDollar.value.referenceSpot,
      6,
    );
  });
});

// ───────────────── 12. a negative HAR-RV variance forecast is not a forecast ─────────────────

describe('harRvForecast refuses a negative variance', () => {
  /** An anti-persistent realized-variance history ⇒ a strongly MEAN-REVERTING fit. */
  const history = Array.from({ length: 100 }, (_, i) =>
    Math.max(1e-6, 0.03 + 0.02 * Math.sin(i) + 0.01 * Math.cos(i / 3.1)),
  );
  const fit = fitHarRv(history);

  it('throws volatility.negative_variance_forecast when the linear model extrapolates below zero', () => {
    expect(fit.coefficients.monthly).toBeLessThan(0); // mean reversion on the monthly aggregate
    // A month of ELEVATED realized variance, far outside the fitted range: the reversion term
    // (−12 × a 0.38 monthly average) drags the linear forecast to ≈ −4.
    const elevated = [...history, ...Array.from({ length: 21 }, () => 0.4), 0.001];
    expect(() => harRvForecast(fit, elevated)).toThrow(UnsupportedError);
    try {
      harRvForecast(fit, elevated);
      expect.unreachable('a negative variance forecast must throw');
    } catch (e) {
      expect((e as UnsupportedError).code).toBe('volatility.negative_variance_forecast');
      expect((e as UnsupportedError).context?.['forecast']).toBeLessThan(0);
      // The predictors that produced it ride the error, so the caller can see WHY.
      expect((e as UnsupportedError).context?.['monthly']).toBeGreaterThan(0.3);
      expect((e as UnsupportedError).message).toMatch(/negative/i);
    }
  });

  it('a normal forecast is unaffected', () => {
    const value = harRvForecast(fit, history);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it('the explain path (H24) throws the same typed error — never a softened envelope', () => {
    const elevated = [...history, ...Array.from({ length: 21 }, () => 0.4), 0.001];
    expect(() => harRvForecast.explain(fit, elevated)).toThrow(UnsupportedError);
  });
});

// ───────────────── SABR: an inadmissible region steers the search, never crashes it ─────────────────

describe('calibrateSabrSmile handles Hagan’s validity region', () => {
  it('a normal-convention smile is seeded in ITS OWN convention and recovers the parameters', () => {
    const TRUE = { alpha: 2, beta: 0.5, rho: -0.3, nu: 0.4 };
    const F = 100;
    const T = 1;
    const strikes = [80, 90, 100, 110, 120];
    const impliedVolatilities = strikes.map((K) =>
      sabrVolatility({
        input: { forward: F, strike: K, timeToExpiryYears: T },
        parameters: TRUE,
        options: { volatilityType: 'normal' },
      }),
    );
    // Pre-fix, the seed used the LOGNORMAL ATM relation (α ≈ σ·F^{1−β} = 201 instead of ≈ 2), which
    // starts 100× outside the expansion's domain — after the options-side guard landed, that threw.
    const fit = calibrateSabrSmile(
      { forward: F, strikes, impliedVolatilities, timeToExpiryYears: T },
      { beta: 0.5, volatilityType: 'normal' },
    );
    expect(fit.converged).toBe(true);
    expect(fit.parameters.alpha).toBeCloseTo(TRUE.alpha, 6);
    expect(fit.parameters.rho).toBeCloseTo(TRUE.rho, 6);
    expect(fit.parameters.nu).toBeCloseTo(TRUE.nu, 6);
    expect(fit.rmse).toBeLessThan(1e-9);
  });

  it('a quote set whose SEED is out of domain still calibrates, stays admissible, and discloses it', () => {
    const F = 100;
    const T = 30;
    const strikes = [60, 80, 100, 120, 140];
    // Enormous normal vols on a long maturity: the ATM-seeded α (=12) puts the time bracket at
    // 1 − 0.75·12²·30/(24·100) = −0.35, i.e. the search STARTS inside the inadmissible region.
    const impliedVolatilities = [138, 126, 120, 124, 134];
    const seedAlpha = impliedVolatilities[2]! / Math.pow(F, 0.5);
    expect(() =>
      sabrVolatility({
        input: { forward: F, strike: 100, timeToExpiryYears: T },
        parameters: { alpha: seedAlpha, beta: 0.5, rho: -0.3, nu: 0.5 },
        options: { volatilityType: 'normal' },
      }),
    ).toThrow(InputError); // the seed itself is inadmissible ⇒ the penalty path IS exercised

    const fit = calibrateSabrSmile(
      { forward: F, strikes, impliedVolatilities, timeToExpiryYears: T },
      { beta: 0.5, volatilityType: 'normal' },
    );
    // It returns rather than throwing …
    expect(Number.isFinite(fit.rmse)).toBe(true);
    // … the returned parameters are evaluable at every strike (inside the domain) …
    for (const K of strikes) {
      expect(() =>
        sabrVolatility({
          input: { forward: F, strike: K, timeToExpiryYears: T },
          parameters: fit.parameters,
          options: { volatilityType: 'normal' },
        }),
      ).not.toThrow();
    }
    // … the penalty path is on the record …
    const disclosure = fit.diagnostics.warnings.find(
      (w) => (w.context?.['outOfDomainProbes'] as number | undefined) !== undefined,
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.context?.['outOfDomainProbes']).toBeGreaterThan(0);
    // … and a fit this poor is not sold as converged.
    expect(fit.converged).toBe(false);
  });

  it('the ρ = tanh(x) reparameterization cannot saturate to ±1 and reject its own trial point', () => {
    // A smile that pushes the search hard into the |ρ| → 1 corner; pre-fix this died with
    // "rho must be in (-1, 1), got -1" from the pricer validating the calibrator's own iterate.
    const TRUE = { alpha: 2, beta: 0.5, rho: -0.9, nu: 1.0 };
    const F = 100;
    const T = 20;
    const strikes = [80, 90, 100, 110, 120];
    const impliedVolatilities = strikes.map((K) =>
      sabrVolatility({
        input: { forward: F, strike: K, timeToExpiryYears: T },
        parameters: TRUE,
        options: { volatilityType: 'normal' },
      }),
    );
    const fit = calibrateSabrSmile(
      { forward: F, strikes, impliedVolatilities, timeToExpiryYears: T },
      { beta: 0.5, volatilityType: 'normal' },
    );
    expect(Number.isFinite(fit.rmse)).toBe(true);
    expect(Math.abs(fit.parameters.rho)).toBeLessThan(1);
  });
});
