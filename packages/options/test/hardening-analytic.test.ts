/**
 * Hardening suite for the ANALYTIC layer (defect-fix wave). Every block below is a reviewed,
 * reproduced defect that shipped a confident wrong number, pinned so it cannot come back:
 *
 *   1. IV solvers accepted a bracket ENDPOINT under an ABSOLUTE price tolerance, so any target
 *      premium ≤ 1e-8 "converged" on an arbitrary σ — with a cliff at exactly 1e-8 where a 1%
 *      larger price returned a completely different volatility. Now relative, at every entry point.
 *   8. A price AT the upper no-arbitrage bound (the σ→∞ supremum) came back converged with whatever
 *      σ the bracket expansion stopped at (≈40). Now `above_max_bound`.
 *   2. `impliedForward` / `impliedDividendYield` reported `converged: true` with a fabricated forward
 *      on a CROSSED chain (positive parity slope ⇒ negative discount factor).
 *   3. Date-only dividend ex-dates resolved to the 16:00 ET OPTION-expiry convention, so an intraday
 *      `asOf` on the ex-date escrowed a dividend the share no longer carried.
 *   4. `americanImpliedVolatility` returned `value: NaN` where its type and doc promise `null`.
 *   5. `blackScholesPriceManyInto` silently corrupted later rows when `out` partially overlapped an
 *      input column.
 *   6. The `method: 'brent'` failure path emitted no warning at all.
 *   7. The American IV route silently ignored `method`/`fallback`/`failFast`.
 *   9. `usEquityCall`/`usEquityPut` rejected every zoned-datetime expiry with unfollowable advice.
 *  10. `market()` returned a mutable artifact while contracts/positions are frozen.
 *  11. `AmericanExerciseResult.style` carried an option TYPE.
 */

import { describe, expect, it } from 'vitest';
import {
  ArbitrageError,
  ConvergenceError,
  InputError,
  UnsupportedError,
  resolvedExpiry,
  usEquityCloseUtcMs,
  type OptionQuote,
} from '@totalfinance/core';
import {
  americanExercise,
  americanImpliedVolatility,
  dividendTermStructure,
  engines,
  impliedBorrow,
  impliedDividendYield,
  impliedForward,
  impliedVolatility,
  market,
  option,
  type ImpliedVolatilityMethod,
} from '@totalfinance/options';
import {
  blackScholes,
  blackScholesImpliedVolatility,
  blackScholesPrice,
  blackScholesPriceBounds,
} from '@totalfinance/options/black-scholes';
import { black76, black76ImpliedVolatility, black76Price } from '@totalfinance/options/black76';
import {
  bachelier,
  bachelierImpliedVolatility,
  bachelierPrice,
} from '@totalfinance/options/bachelier';
import { blackScholesPriceManyInto } from '@totalfinance/options/batch';

// ---------------------------------------------------------------------------
// Shared helpers — deterministic bisection, independent of the solvers under test.
// ---------------------------------------------------------------------------

/** Bisect a strictly increasing `f` for `f(x) = 0` on `[lo, hi]`. 300 halvings ⇒ machine-exact. */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 300; i++) {
    const mid = 0.5 * (a + b);
    if (f(mid) < 0) a = mid;
    else b = mid;
  }
  return 0.5 * (a + b);
}

/** The strike whose BSM price at `volatility` is (as close as doubles allow to) `target`. */
function strikeForPrice(input: {
  type: 'call' | 'put';
  target: number;
  spot: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): number {
  const { type, target, spot, ...rest } = input;
  const priceAt = (strike: number): number => blackScholesPrice({ type, spot, strike, ...rest });
  // A call's price falls with K, a put's rises with it — orient both so the residual increases.
  return type === 'call'
    ? bisect((k) => target - priceAt(k), spot, spot * 200)
    : bisect((k) => priceAt(k) - target, spot * 1e-6, spot);
}

const relative = (actual: number, expected: number): number =>
  Math.abs(actual - expected) / Math.abs(expected);

const METHODS: ImpliedVolatilityMethod[] = ['brent', 'newton', 'halley', 'householder', 'auto'];

// ---------------------------------------------------------------------------
// 1 + 8. Implied volatility across price SCALES, at every entry point.
// ---------------------------------------------------------------------------

describe('IV round-trip property grid — a recovered σ is real at every price scale (finding 1)', () => {
  const SPOT = 100;
  const RATE = 0.03;
  const DIVIDEND_YIELD = 0;
  const TRUE_VOL = 0.42;
  const TARGETS = [1e-2, 1e-4, 1e-8, 1e-12, 1e-16];
  const MATURITIES = [30 / 365, 1];

  for (const timeToExpiryYears of MATURITIES) {
    for (const type of ['call', 'put'] as const) {
      for (const target of TARGETS) {
        it(`${type} @ T=${timeToExpiryYears.toFixed(3)}y, price ≈ ${target.toExponential()}: recovers σ or fails typed — never a fabricated value`, () => {
          const strike = strikeForPrice({
            type,
            target,
            spot: SPOT,
            timeToExpiryYears,
            riskFreeRate: RATE,
            dividendYield: DIVIDEND_YIELD,
            volatility: TRUE_VOL,
          });
          // The exact double the model produces at the true vol — the round trip's starting point.
          const price = blackScholesPrice({
            type,
            spot: SPOT,
            strike,
            timeToExpiryYears,
            riskFreeRate: RATE,
            dividendYield: DIVIDEND_YIELD,
            volatility: TRUE_VOL,
          });
          expect(price).toBeGreaterThan(0);
          expect(relative(price, target)).toBeLessThan(1e-6);

          const shared = {
            type,
            price,
            spot: SPOT,
            strike,
            timeToExpiryYears,
            riskFreeRate: RATE,
            dividendYield: DIVIDEND_YIELD,
          } as const;

          // (a) the kernel
          const kernel = blackScholesImpliedVolatility(shared);
          if (kernel.converged) {
            expect(relative(kernel.value, TRUE_VOL)).toBeLessThan(1e-6);
          } else {
            expect(kernel.reason).toBe('price_below_resolvable');
            expect(kernel.value).toBeNaN();
          }

          // (b) the facade — same verdict, `null` (never NaN) when there is no answer
          const facade = blackScholes.impliedVolatility.explain(shared);
          expect(facade.diagnostics.converged).toBe(kernel.converged);
          if (facade.diagnostics.converged) {
            expect(relative(facade.value!, TRUE_VOL)).toBeLessThan(1e-6);
          } else {
            expect(facade.value).toBeNull();
            expect(facade.diagnostics.warnings[0]?.code).toBe(
              'implied_volatility.price_below_resolvable',
            );
            expect(() => blackScholes.impliedVolatility(shared)).toThrowError(ConvergenceError);
          }

          // (c) the method suite — every method agrees with the kernel and with the truth
          for (const method of METHODS) {
            const solved = impliedVolatility(shared, { method });
            expect(solved.diagnostics.converged).toBe(kernel.converged);
            if (solved.diagnostics.converged) {
              expect(relative(solved.value!, TRUE_VOL)).toBeLessThan(1e-6);
            } else {
              expect(solved.value).toBeNull();
              // Law 2: a failed solve always names a reason.
              expect(solved.diagnostics.warnings.some((w) => w.severity === 'error')).toBe(true);
            }
          }
        });
      }
    }
  }

  it('THE CLIFF: 1.00e-8 and 1.01e-8 recover the same ≈0.417 vol (an absolute tolerance split them)', () => {
    // Pre-fix, `ptol = 1e-8·max(1, price)` made the σ = lo endpoint "match" any target ≤ 1e-8:
    // 1.00e-8 returned σ = 1e-7 with converged: true, while 1.01e-8 solved to 0.417.
    const CLIFF_VOL = 0.417;
    const base = {
      type: 'call' as const,
      spot: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      dividendYield: 0,
    };
    const strike = strikeForPrice({ ...base, target: 1e-8, volatility: CLIFF_VOL });
    const solve = (price: number) => blackScholesImpliedVolatility({ ...base, strike, price });

    const low = solve(1.0e-8);
    const high = solve(1.01e-8);
    for (const res of [low, high]) {
      expect(res.converged).toBe(true);
      expect(relative(res.value, CLIFF_VOL)).toBeLessThan(1e-3);
    }
    // No cliff: a 1% price move is a small vol move, not a jump to the bracket endpoint.
    expect(relative(low.value, high.value)).toBeLessThan(1e-3);
    expect(low.value).toBeGreaterThan(0.4); // pre-fix this was 1e-7
  });

  it('a price the model cannot reach at ANY σ ≥ lo fails typed, on kernel, facade and suite', () => {
    // ATM, r = 0: the σ→0 price floor is ≈ 4e-6, so a 1e-9 target has no volatility at all.
    const input = {
      type: 'call' as const,
      price: 1e-9,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      dividendYield: 0,
    };
    // `input` is an IV-SOLVER request and carries `price`; the pricing kernel takes no such field,
    // and now says so (Law 12). Pass only the pricing legs.
    const { price: _target, ...market } = input;
    const floor = blackScholesPrice({ ...market, volatility: 1e-7 });
    expect(floor).toBeGreaterThan(input.price);

    const kernel = blackScholesImpliedVolatility(input);
    expect(kernel.converged).toBe(false);
    expect(kernel.reason).toBe('price_below_resolvable');

    const facade = blackScholes.impliedVolatility.explain(input);
    expect(facade.value).toBeNull();
    expect(facade.diagnostics.warnings[0]?.code).toBe('implied_volatility.price_below_resolvable');
    expect(() => blackScholes.impliedVolatility(input)).toThrowError(ConvergenceError);

    const suite = impliedVolatility(input, { method: 'brent' });
    expect(suite.value).toBeNull();
    expect(suite.diagnostics.warnings[0]?.code).toBe('implied_volatility.price_below_resolvable');
  });

  it('an ill-conditioned recovery is disclosed as low_vega on BOTH the facade and the suite', () => {
    const base = {
      type: 'call' as const,
      spot: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      dividendYield: 0,
    };
    const strike = strikeForPrice({ ...base, target: 1e-12, volatility: 0.42 });
    const price = blackScholesPrice({ ...base, strike, volatility: 0.42 });
    const input = { ...base, strike, price };

    const facade = blackScholes.impliedVolatility.explain(input);
    expect(facade.diagnostics.converged).toBe(true);
    expect(facade.diagnostics.warnings.some((w) => w.code === 'implied_volatility.low_vega')).toBe(
      true,
    );
    const suite = impliedVolatility(input, { method: 'auto' });
    expect(suite.diagnostics.warnings.some((w) => w.code === 'implied_volatility.low_vega')).toBe(
      true,
    );
    // A normally-conditioned contract carries no such warning (the disclosure means something).
    const normal = blackScholes.impliedVolatility.explain({
      ...base,
      strike: 100,
      price: blackScholesPrice({ ...base, strike: 100, volatility: 0.42 }),
    });
    expect(normal.diagnostics.warnings.some((w) => w.code === 'implied_volatility.low_vega')).toBe(
      false,
    );
  });

  it('a price AT the upper no-arbitrage bound is above-max, not σ ≈ 40 (finding 8)', () => {
    const base = {
      type: 'call' as const,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
    };
    const { upper } = blackScholesPriceBounds(base);
    const kernel = blackScholesImpliedVolatility({ ...base, price: upper });
    expect(kernel.converged).toBe(false);
    expect(kernel.reason).toBe('above_max_bound');

    const facade = blackScholes.impliedVolatility.explain({ ...base, price: upper });
    expect(facade.value).toBeNull();
    expect(facade.diagnostics.warnings[0]?.code).toBe('implied_volatility.above_max_bound');
    expect(() => blackScholes.impliedVolatility({ ...base, price: upper })).toThrowError(
      ArbitrageError,
    );

    for (const method of METHODS) {
      const suite = impliedVolatility({ ...base, price: upper }, { method });
      expect(suite.value).toBeNull();
      expect(suite.diagnostics.warnings[0]?.code).toBe('implied_volatility.above_max_bound');
    }

    // A put's bound is K·e^{−rT}, and a genuinely solvable price just under it still solves.
    const put = { ...base, type: 'put' as const };
    expect(
      blackScholesImpliedVolatility({ ...put, price: blackScholesPriceBounds(put).upper }).reason,
    ).toBe('above_max_bound');
    const solvable = blackScholesPrice({ ...put, volatility: 1.5 });
    expect(
      relative(blackScholesImpliedVolatility({ ...put, price: solvable }).value, 1.5),
    ).toBeLessThan(1e-8);
  });

  it('the Black-76 and Bachelier kernels align (no fabricated endpoint at a tiny premium)', () => {
    // Black-76: deep-OTM forward option whose premium is 1e-9 at σ = 0.55.
    const b76 = {
      type: 'call' as const,
      forward: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.02,
    };
    const b76Strike = bisect(
      (k) => 1e-9 - black76Price({ ...b76, strike: k, volatility: 0.55 }),
      100,
      20_000,
    );
    const b76Price = black76Price({ ...b76, strike: b76Strike, volatility: 0.55 });
    expect(b76Price).toBeGreaterThan(0);
    const b76Solved = black76ImpliedVolatility({ ...b76, strike: b76Strike, price: b76Price });
    expect(b76Solved.converged).toBe(true);
    expect(relative(b76Solved.value, 0.55)).toBeLessThan(1e-6); // pre-fix: 1e-7, "converged"

    // Black-76 upper bound (df·F) is the σ→∞ supremum too.
    const atBound = black76ImpliedVolatility({
      ...b76,
      strike: 100,
      price: Math.exp(-b76.riskFreeRate * b76.timeToExpiryYears) * b76.forward,
    });
    expect(atBound.converged).toBe(false);
    expect(atBound.reason).toBe('above_max_bound');
    expect(() =>
      black76.impliedVolatility({
        ...b76,
        strike: 100,
        price: Math.exp(-b76.riskFreeRate * b76.timeToExpiryYears) * b76.forward,
      }),
    ).toThrowError(ArbitrageError);

    // Bachelier: normal vol in price units, same endpoint rule.
    const normal = {
      type: 'call' as const,
      forward: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.02,
    };
    const normalStrike = bisect(
      (k) => 1e-9 - bachelierPrice({ ...normal, strike: k, normalVolatility: 12 }),
      100,
      1000,
    );
    const normalPrice = bachelierPrice({
      ...normal,
      strike: normalStrike,
      normalVolatility: 12,
    });
    expect(normalPrice).toBeGreaterThan(0);
    const normalSolved = bachelierImpliedVolatility({
      ...normal,
      strike: normalStrike,
      price: normalPrice,
    });
    expect(normalSolved.converged).toBe(true);
    expect(relative(normalSolved.value, 12)).toBeLessThan(1e-6); // pre-fix: 1e-10, "converged"

    // Below the σ_N→0 floor: an ATM normal option's floor is ≈ 4e-4 at σ_N = 1e-10 — a 1e-30
    // premium is unreachable and must fail typed rather than pin σ_N to the low endpoint.
    const unreachable = bachelier.impliedVolatility.explain({
      ...normal,
      strike: 100,
      price: 1e-30,
    });
    expect(unreachable.value).toBeNull();
    expect(unreachable.diagnostics.warnings[0]?.code).toBe(
      'implied_volatility.price_below_resolvable',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Crossed put-call-parity chains.
// ---------------------------------------------------------------------------

describe('crossed-chain parity table — an inadmissible discount factor never converges (finding 2)', () => {
  const SPOT = 100;
  const RATE = 0.03;
  const DIVIDEND_YIELD = 0.015;
  const SIGMA = 0.25;
  const T = 0.5;
  const EXPIRY = '2026-01-16T21:00:00.000Z';
  const AS_OF = Date.parse(EXPIRY) - T * 365 * 86_400_000;
  const FORWARD = SPOT * Math.exp((RATE - DIVIDEND_YIELD) * T);
  const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];

  /** `crossed: true` swaps each strike's call and put quote — the parity slope flips positive. */
  function chain(crossed: boolean): OptionQuote[] {
    const rows: OptionQuote[] = [];
    for (const strike of STRIKES) {
      for (const type of ['call', 'put'] as const) {
        const quoted = crossed ? (type === 'call' ? 'put' : 'call') : type;
        rows.push({
          contract: {
            underlying: 'ACME',
            type,
            style: 'european',
            strike,
            expiry: EXPIRY,
            ...resolvedExpiry(EXPIRY),
          },
          timestampMs: AS_OF,
          mid: blackScholesPrice({
            type: quoted,
            spot: SPOT,
            strike,
            timeToExpiryYears: T,
            riskFreeRate: RATE,
            dividendYield: DIVIDEND_YIELD,
            volatility: SIGMA,
          }),
        });
      }
    }
    return rows;
  }

  const CROSSED = chain(true);
  const CLEAN = chain(false);
  const forwardOptions = { riskFreeRate: RATE, asOf: AS_OF };
  const carryOptions = { ...forwardOptions, spot: SPOT };

  const CASES = [
    {
      name: 'impliedForward',
      run: (quotes: OptionQuote[]) =>
        impliedForward({ quotes, expiry: EXPIRY, options: forwardOptions }),
      clean: FORWARD,
    },
    {
      name: 'impliedDividendYield',
      run: (quotes: OptionQuote[]) =>
        impliedDividendYield({ quotes, expiry: EXPIRY, options: carryOptions }),
      clean: DIVIDEND_YIELD,
    },
    {
      name: 'impliedBorrow',
      run: (quotes: OptionQuote[]) =>
        impliedBorrow({ quotes, expiry: EXPIRY, options: carryOptions }),
      clean: 0,
    },
  ] as const;

  for (const testCase of CASES) {
    it(`${testCase.name}: crossed chain ⇒ converged false, no fabricated value`, () => {
      const res = testCase.run(CROSSED);
      expect(res.diagnostics.impliedDiscountFactor).toBeLessThan(0); // the repro condition
      expect(res.diagnostics.converged).toBe(false);
      expect(Number.isFinite(res.value)).toBe(false);
      expect(
        res.diagnostics.warnings.some(
          (w) => w.code === 'parity.nonpositive_discount' && w.severity === 'error',
        ),
      ).toBe(true);
    });

    it(`${testCase.name}: clean chain still recovers exactly (no regression)`, () => {
      const res = testCase.run(CLEAN);
      expect(res.diagnostics.converged).toBe(true);
      expect(res.diagnostics.impliedDiscountFactor).toBeGreaterThan(0);
      expect(Math.abs(res.value - testCase.clean)).toBeLessThan(1e-6);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Dividend ex-date boundary.
// ---------------------------------------------------------------------------

describe('ex-date boundary matrix — a date-only ex-date is the market OPEN (finding 3)', () => {
  const EX_DATE = '2026-06-01'; // EDT (UTC−4): 09:30 ET = 13:30 UTC
  const EXPIRY = '2027-01-01';
  const AMOUNT = 3;
  const MARKET_OPEN_MS = usEquityCloseUtcMs(2026, 6, 1) - 6.5 * 3600_000;

  const contract = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry: EXPIRY,
    style: 'european',
  });
  const priceAt = (asOf: number, withDividend: boolean): number =>
    option.price({
      contract,
      market: market({
        spot: 100,
        riskFreeRate: 0.05,
        volatility: 0.2,
        asOf,
        ...(withDividend ? { dividends: [{ exDate: EX_DATE, amount: AMOUNT }] } : {}),
      }),
    }).value;

  const CASES = [
    {
      label: '16:30 ET the day BEFORE the ex-date',
      asOf: Date.UTC(2026, 4, 31, 20, 30),
      accrues: true,
    },
    {
      label: '09:00 ET on the ex-date (pre-open)',
      asOf: Date.UTC(2026, 5, 1, 13, 0),
      accrues: true,
    },
    { label: '09:30 ET on the ex-date (the open itself)', asOf: MARKET_OPEN_MS, accrues: false },
    {
      label: '10:00 ET on the ex-date (intraday)',
      asOf: Date.UTC(2026, 5, 1, 14, 0),
      accrues: false,
    },
    {
      label: '16:00 ET on the ex-date (the close)',
      asOf: Date.UTC(2026, 5, 1, 20, 0),
      accrues: false,
    },
  ] as const;

  for (const testCase of CASES) {
    it(`${testCase.label}: the dividend ${testCase.accrues ? 'accrues' : 'is already out of the spot'}`, () => {
      const withDividend = priceAt(testCase.asOf, true);
      const withoutDividend = priceAt(testCase.asOf, false);
      if (testCase.accrues) {
        // Escrowed off the spot ⇒ a strictly cheaper call.
        expect(withDividend).toBeLessThan(withoutDividend);
      } else {
        // Pre-fix the 16:00 ET expiry convention kept escrowing it all day: a full dividend of
        // error in the premium (≈ −$1.02/share on the reviewed repro).
        expect(withDividend).toBeCloseTo(withoutDividend, 12);
      }

      // The term structure reads the same clock as the escrowed spot.
      const ts = dividendTermStructure({
        spot: 100,
        riskFreeRate: 0.05,
        dividends: [{ exDate: EX_DATE, amount: AMOUNT }],
        asOf: testCase.asOf,
        maturities: [EXPIRY],
      });
      expect(ts.points[0]!.discreteCount).toBe(testCase.accrues ? 1 : 0);
      expect(ts.totalDividendPresentValue).toBeGreaterThanOrEqual(0);
      if (!testCase.accrues) expect(ts.totalDividendPresentValue).toBe(0);
    });
  }

  it('the escrow and the term structure agree on the ex-date instant to the millisecond', () => {
    const justBefore = MARKET_OPEN_MS - 1;
    const justAfter = MARKET_OPEN_MS + 1;
    const count = (asOf: number): number =>
      dividendTermStructure({
        spot: 100,
        riskFreeRate: 0.05,
        dividends: [{ exDate: EX_DATE, amount: AMOUNT }],
        asOf,
        maturities: [EXPIRY],
      }).points[0]!.discreteCount;
    expect(count(justBefore)).toBe(1);
    expect(count(justAfter)).toBe(0);
    expect(priceAt(justBefore, true)).toBeLessThan(priceAt(justBefore, false));
    expect(priceAt(justAfter, true)).toBeCloseTo(priceAt(justAfter, false), 12);
  });

  it('a ZONED datetime ex-date is the caller’s explicit instant, untouched by the convention', () => {
    // 14:00 ET on the ex-date: still accruing at 13:00 ET, gone by 15:00 ET.
    const dividends = [{ exDate: '2026-06-01T14:00:00-04:00', amount: AMOUNT }];
    const at = (asOf: number): number =>
      dividendTermStructure({
        spot: 100,
        riskFreeRate: 0.05,
        dividends,
        asOf,
        maturities: [EXPIRY],
      }).points[0]!.discreteCount;
    expect(at(Date.UTC(2026, 5, 1, 17, 0))).toBe(1); // 13:00 ET
    expect(at(Date.UTC(2026, 5, 1, 19, 0))).toBe(0); // 15:00 ET
  });

  it('q_eff(T) still reproduces the escrowed-spot price exactly (losslessness preserved)', () => {
    const asOf = Date.UTC(2026, 0, 1, 21);
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      dividendYield: 0.01,
      dividends: [
        { exDate: '2026-04-01', amount: 1.5 },
        { exDate: '2026-10-01', amount: 1.5 },
      ],
      asOf,
      maturities: [EXPIRY],
    });
    const point = ts.points[0]!;
    for (const type of ['call', 'put'] as const) {
      const viaQeff = blackScholesPrice({
        type,
        spot: 100,
        strike: 100,
        timeToExpiryYears: point.yearsToExpiry,
        riskFreeRate: 0.05,
        dividendYield: point.impliedContinuousYield,
        volatility: 0.25,
      });
      const escrowed = blackScholesPrice({
        type,
        spot: 100 - point.dividendPresentValue,
        strike: 100,
        timeToExpiryYears: point.yearsToExpiry,
        riskFreeRate: 0.05,
        dividendYield: 0.01,
        volatility: 0.25,
      });
      expect(viaQeff).toBeCloseTo(escrowed, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. American IV: null, not NaN — with the σ→0 floor disclosed.
// ---------------------------------------------------------------------------

describe('americanImpliedVolatility reports null with the σ→0 floor (finding 4)', () => {
  const asOf = Date.UTC(2026, 0, 1, 21);
  const contract = option.usEquityCall({ underlying: 'X', strike: 50, expiry: '2027-01-01' });

  it('a price in the gap between intrinsic and the σ→0 floor: value null + floor in context', () => {
    // S = 100, K = 50, r = 5%: intrinsic is 50 (cleared), but a non-dividend American call is worth
    // at least S − K·e^{−rT} ≈ 52.44 at any σ — so 50.5 has no volatility. It is NOT below intrinsic.
    const res = americanImpliedVolatility({
      contract,
      market: market({ spot: 100, riskFreeRate: 0.05, price: 50.5, asOf }),
    });
    expect(res.diagnostics.converged).toBe(false);
    expect(res.value).toBeNull();
    expect(res.value).not.toBeNaN();
    const failure = res.diagnostics.warnings.find((w) => w.severity === 'error');
    expect(failure?.code).toBe('implied_volatility.no_convergence');
    const floor = failure?.context?.['floor'] as number;
    expect(Number.isFinite(floor)).toBe(true);
    expect(floor).toBeCloseTo(100 - 50 * Math.exp(-0.05), 2);
    expect(floor).toBeGreaterThan(50.5);
    expect(failure?.context?.['belowFloor']).toBe(true);
    // JSON-safe: a NaN would serialize to null and hide the failure; a real null is honest.
    expect(JSON.parse(JSON.stringify(res)).value).toBeNull();
  });

  it('a solvable American price still round-trips (no regression)', () => {
    const put = option.usEquityPut({ underlying: 'X', strike: 100, expiry: '2027-01-01' });
    const priced = engines.bjerksundStensland2002().price({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: 0.33, asOf }),
    });
    const res = americanImpliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
    });
    expect(res.diagnostics.converged).toBe(true);
    expect(res.value!).toBeCloseTo(0.33, 6);
  });
});

// ---------------------------------------------------------------------------
// 5. Batch buffer aliasing.
// ---------------------------------------------------------------------------

describe('batch aliasing table — a partially overlapping out buffer is rejected (finding 5)', () => {
  const ROWS = 6;

  function columns(buffer?: ArrayBuffer, spotByteOffset = 0) {
    const spot = buffer ? new Float64Array(buffer, spotByteOffset, ROWS) : new Float64Array(ROWS);
    spot.set(Array.from({ length: ROWS }, (_, i) => 90 + i * 5));
    return {
      spot,
      strike: Float64Array.from({ length: ROWS }, () => 100),
      volatility: Float64Array.from({ length: ROWS }, () => 0.25),
      riskFreeRate: Float64Array.from({ length: ROWS }, () => 0.04),
      timeToExpiryYears: Float64Array.from({ length: ROWS }, () => 0.5),
      type: Int8Array.from({ length: ROWS }, () => 1),
    };
  }

  /** Reference prices, computed with no aliasing at all. */
  const reference = (() => {
    const out = new Float64Array(ROWS);
    blackScholesPriceManyInto(columns(), out);
    return out;
  })();

  it('disjoint buffers: unchanged', () => {
    const out = new Float64Array(ROWS);
    blackScholesPriceManyInto(columns(), out);
    expect(Array.from(out)).toEqual(Array.from(reference));
  });

  it('EXACT alias (out === a column) stays supported and correct', () => {
    const cols = columns();
    blackScholesPriceManyInto(cols, cols.spot);
    expect(Array.from(cols.spot)).toEqual(Array.from(reference));
  });

  it('OFFSET overlap with an input column throws instead of corrupting later rows', () => {
    // One buffer, spot at element 0 and out at element 1 — writing out[i] lands on spot[i+1].
    const buffer = new ArrayBuffer((ROWS + 1) * 8);
    const cols = columns(buffer, 0);
    const out = new Float64Array(buffer, 8, ROWS);
    expect(() => blackScholesPriceManyInto(cols, out)).toThrowError(InputError);
    expect(() => blackScholesPriceManyInto(cols, out)).toThrowError(/overlaps input column "spot"/);
  });

  it('overlap with a non-Float64 column (type) is caught too', () => {
    const buffer = new ArrayBuffer(ROWS * 8 + 64);
    const type = new Int8Array(buffer, 0, ROWS);
    type.fill(1);
    const out = new Float64Array(buffer, 0, ROWS);
    const cols = { ...columns(), type };
    expect(() => blackScholesPriceManyInto(cols, out)).toThrowError(/overlaps input column "type"/);
  });

  it('a NON-overlapping view of the SAME buffer is allowed', () => {
    const buffer = new ArrayBuffer(2 * ROWS * 8);
    const cols = columns(buffer, 0);
    const out = new Float64Array(buffer, ROWS * 8, ROWS);
    blackScholesPriceManyInto(cols, out);
    expect(Array.from(out)).toEqual(Array.from(reference));
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. Failure grammar and honored knobs.
// ---------------------------------------------------------------------------

describe('IV suite failure grammar and the American route knobs (findings 6, 7)', () => {
  it("method: 'brent' failures carry an error warning like every other path", () => {
    const res = impliedVolatility(
      {
        type: 'call',
        price: 1e-9,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
      },
      { method: 'brent' },
    );
    expect(res.diagnostics.converged).toBe(false);
    expect(res.value).toBeNull();
    // Pre-fix: `warnings` was EMPTY — a null value with no reason at all.
    expect(res.diagnostics.warnings.length).toBeGreaterThan(0);
    const failure = res.diagnostics.warnings.find((w) => w.severity === 'error');
    expect(failure).toBeDefined();
    expect(failure!.code).toBe('implied_volatility.price_below_resolvable');
  });

  it('a derivative method whose brent fallback also fails still names the reason', () => {
    const res = impliedVolatility(
      {
        type: 'call',
        price: 1e-9,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
      },
      { method: 'newton' },
    );
    expect(res.diagnostics.converged).toBe(false);
    expect(res.diagnostics.warnings.some((w) => w.severity === 'error')).toBe(true);
  });

  it('option.impliedVolatility rejects solver knobs it cannot honor on an AMERICAN contract', () => {
    const asOf = Date.UTC(2026, 0, 1, 21);
    const contract = option.usEquityPut({ underlying: 'X', strike: 100, expiry: '2027-01-01' });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, price: 9.5, asOf });
    for (const knobs of [
      { method: 'newton' as const },
      { fallback: false },
      { failFast: true },
      { method: 'auto' as const, fallback: true },
    ]) {
      expect(() => option.impliedVolatility({ contract, market: mkt, ...knobs })).toThrowError(
        UnsupportedError,
      );
    }
    // The message must teach what IS honored.
    expect(() =>
      option.impliedVolatility({ contract, market: mkt, method: 'newton' }),
    ).toThrowError(/honors "engine"/);

    // `engine` alone is honored, and the European route keeps its full method suite.
    const viaEngine = option.impliedVolatility({
      contract,
      market: mkt,
      engine: engines.binomial({ variant: 'leisen-reimer', steps: 201 }),
    });
    expect(viaEngine.diagnostics.engine).toBe('binomial-leisen-reimer');
    const european = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const europeanSolved = option.impliedVolatility({
      contract: european,
      market: market({ spot: 100, riskFreeRate: 0.05, price: 9.5, asOf }),
      method: 'newton',
    });
    expect(europeanSolved.diagnostics.method).toBe('newton');
  });
});

// ---------------------------------------------------------------------------
// 8b. Underflow disclosure on the closed-form explain.
// ---------------------------------------------------------------------------

describe('a price that underflowed to exactly 0 is disclosed, not presented as free (finding 8)', () => {
  const DEEP_OTM = {
    spot: 100,
    strike: 10_000,
    timeToExpiryYears: 0.01,
    riskFreeRate: 0.02,
    volatility: 0.1,
    type: 'call' as const,
  };

  it('blackScholes.price.explain carries an info warning naming the underflow', () => {
    const res = blackScholes.price.explain(DEEP_OTM);
    expect(res.value).toBe(0);
    expect(res.diagnostics.converged).toBe(true);
    const disclosure = res.diagnostics.warnings.find(
      (w) => w.severity === 'info' && /underflow/i.test(w.message),
    );
    expect(disclosure).toBeDefined();
    expect(typeof disclosure!.code).toBe('string');
  });

  it('the call/put facades disclose it too, and a normal price stays silent', () => {
    const { spot, strike, timeToExpiryYears, riskFreeRate, volatility } = DEEP_OTM;
    const underflowed = blackScholes.call.explain({
      spot,
      strike,
      timeToExpiryYears,
      riskFreeRate,
      volatility,
    });
    expect(underflowed.value).toBe(0);
    expect(underflowed.diagnostics.warnings.some((w) => /underflow/i.test(w.message))).toBe(true);

    const normal = blackScholes.price.explain({ ...DEEP_OTM, strike: 105 });
    expect(normal.value).toBeGreaterThan(0);
    expect(normal.diagnostics.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. usEquity* builders and zoned expiries.
// ---------------------------------------------------------------------------

describe('usEquityCall/usEquityPut accept a zoned datetime expiry (review-1)', () => {
  const ZONED = '2026-09-18T13:30:00-04:00'; // an AM-settled instant, not the 16:00 ET close

  it('a zoned expiry is used verbatim and stamped explicit-instant', () => {
    for (const build of [option.usEquityCall, option.usEquityPut]) {
      const contract = build({ underlying: 'AAPL', strike: 200, expiry: ZONED });
      expect(contract.expiresAt).toBe(Date.UTC(2026, 8, 18, 17, 30));
      expect(contract.expiryConvention).toBe('explicit-instant');
      expect(contract.style).toBe('american');
      expect(contract.multiplier).toBe(100);
      expect(contract.expiry).toBe(ZONED);
    }
  });

  it('a zoned-expiry contract prices through the pro path', () => {
    const contract = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: ZONED });
    const res = option.price({
      contract,
      market: market({
        spot: 195,
        riskFreeRate: 0.045,
        volatility: 0.24,
        asOf: Date.UTC(2026, 6, 20, 20),
      }),
    });
    expect(res.value).toBeGreaterThan(0);
    expect(res.assumptions.expiryConvention).toBe('explicit-instant');
  });

  it('date-only expiries are unchanged (16:00 ET, us-equity-close)', () => {
    const contract = option.usEquityCall({
      underlying: 'AAPL',
      strike: 200,
      expiry: '2026-09-18',
    });
    expect(contract.expiresAt).toBe(usEquityCloseUtcMs(2026, 9, 18));
    expect(contract.expiryConvention).toBe('us-equity-close');
    expect(contract.multiplier).toBe(100);
  });

  it('the generic builders still refuse a convention next to a zoned instant', () => {
    expect(() =>
      option.call({
        underlying: 'AAPL',
        strike: 200,
        expiry: ZONED,
        convention: 'us-equity-close',
        style: 'american',
      }),
    ).toThrowError(/contradicts the zoned expiry/);
    // …and still demand one for a date-only label.
    expect(() =>
      option.call({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18', style: 'american' }),
    ).toThrowError(/does not name its expiry INSTANT/);
  });
});

// ---------------------------------------------------------------------------
// 10. market() is a frozen artifact.
// ---------------------------------------------------------------------------

describe('market() returns a FROZEN artifact like contracts and positions (review-1)', () => {
  const dividends = [{ exDate: '2026-06-01', amount: 3 }];
  const build = () =>
    market({
      spot: 100,
      riskFreeRate: 0.05,
      volatility: 0.2,
      asOf: Date.UTC(2026, 0, 1, 21),
      dividends,
    });

  it('every field, the dividend array, and each dividend entry reject mutation', () => {
    const mkt = build();
    expect(Object.isFrozen(mkt)).toBe(true);
    expect(() => {
      (mkt as { spot: number }).spot = 1;
    }).toThrowError(TypeError);
    expect(() => {
      (mkt as { asOf: number }).asOf = 0;
    }).toThrowError(TypeError);
    expect(Object.isFrozen(mkt.dividends)).toBe(true);
    expect(() => mkt.dividends!.push({ exDate: '2026-09-01', amount: 1 })).toThrowError(TypeError);
    expect(() => {
      (mkt.dividends![0] as { amount: number }).amount = 99;
    }).toThrowError(TypeError);
  });

  it("the caller's own dividend array is copied, not frozen out from under them", () => {
    build();
    expect(Object.isFrozen(dividends)).toBe(false);
    dividends.push({ exDate: '2026-09-01', amount: 1 });
    expect(dividends).toHaveLength(2);
    dividends.pop();
  });

  it('the pro paths price, invert and analyse a frozen market without mutating it', () => {
    const mkt = build();
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const priced = option.price({ contract, market: mkt });
    expect(priced.value).toBeGreaterThan(0);

    const inverted = option.impliedVolatility({
      contract,
      market: market({
        spot: 100,
        riskFreeRate: 0.05,
        asOf: Date.UTC(2026, 0, 1, 21),
        price: priced.value,
        dividends,
      }),
    });
    expect(inverted.value!).toBeCloseTo(0.2, 6);

    const american = option.usEquityPut({ underlying: 'X', strike: 100, expiry: '2027-01-01' });
    expect(
      engines.binomial({ variant: 'leisen-reimer', steps: 201 }).price({
        contract: american,
        market: mkt,
      }).value,
    ).toBeGreaterThan(0);
    expect(americanExercise({ contract: american, market: mkt }).american).toBeGreaterThan(0);
    // Still frozen and unchanged after all of that.
    expect(mkt.spot).toBe(100);
    expect(mkt.dividends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 11. The exercise-result field rename.
// ---------------------------------------------------------------------------

describe('AmericanExerciseResult names the option TYPE `optionType` (review-1)', () => {
  it('carries optionType, and no `style` field claiming to be an exercise style', () => {
    const asOf = Date.UTC(2026, 0, 1, 21);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.25, asOf });
    for (const type of ['call', 'put'] as const) {
      const contract =
        type === 'call'
          ? option.usEquityCall({ underlying: 'X', strike: 100, expiry: '2027-01-01' })
          : option.usEquityPut({ underlying: 'X', strike: 100, expiry: '2027-01-01' });
      const res = americanExercise({ contract, market: mkt });
      expect(res.optionType).toBe(type);
      expect('style' in res).toBe(false);
    }
  });
});

describe('underflow disclosure is the same through both doors', () => {
  it('the pro path discloses an underflowed price like the facade does', () => {
    // Deep OTM enough that the premium is below the smallest representable double. The facade
    // already said so; before this the pro engine returned the same 0 with an empty warning list.
    const contract = option.european({
      underlying: 'X',
      type: 'call',
      strike: 10_000,
      expiry: '2026-09-18',
      convention: 'us-equity-close',
    });
    const result = option.price({
      contract,
      market: market({
        spot: 100,
        riskFreeRate: 0.02,
        volatility: 0.2,
        asOf: '2026-08-02T00:00:00Z',
      }),
    });
    expect(result.value).toBe(0);
    expect(result.diagnostics.warnings.map((w) => w.code)).toContain('model.limitation');
  });
});
