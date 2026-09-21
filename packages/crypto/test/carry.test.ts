/**
 * Crypto perpetual & futures carry (`perpetualFunding`, `futuresBasis`, `predictedFunding`,
 * `fundingBasisSpread`). Every output is an exact identity, so the tests pin the arithmetic (8h funding
 * annualizes to 10.95 % simple / 11.57 % compounded), the no-arbitrage round-trips (a fair future has zero
 * richness and zero cash-and-carry edge; the perp funding and the future basis agree when both price the
 * same carry), the venue funding formula's three clamp regimes, the disclosed flags, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { PostconditionError, isQuantError } from '@totalfinance/core';
import { blackScholes } from '@totalfinance/options';
import {
  perpetualFunding,
  futuresBasis,
  predictedFunding,
  fundingBasisSpread,
  optionsBasisSpread,
} from '@totalfinance/crypto';

describe('perpetualFunding', () => {
  it('annualizes an 8h funding rate simply and compounded, with the carry signs explicit', () => {
    const r = perpetualFunding({ markPrice: 60030, indexPrice: 60000, fundingRate: 0.0001 });
    expect(r.value.periodsPerYear).toBe((365 * 24) / 8); // 1095
    expect(r.value.premium).toBeCloseTo(30 / 60000, 12); // 0.0005
    expect(r.value.annualizedSimple).toBeCloseTo(0.1095, 10); // 10.95 %
    expect(r.value.annualizedCompounded).toBeCloseTo(Math.pow(1.0001, 1095) - 1, 12); // ~11.57 %
    // A long PAYS when funding is positive; a short receives.
    expect(r.value.longCarry).toBeCloseTo(-0.1095, 10);
    expect(r.value.shortCarry).toBeCloseTo(0.1095, 10);
    expect(r.diagnostics.warnings).toHaveLength(0);
    expect(r.assumptions.model).toBe('carry');
  });

  it('honors a custom interval and flags extreme funding', () => {
    // 1h interval ⇒ 8760 periods/yr; a 0.05 %/1h funding annualizes to +438 %/yr ⇒ flagged.
    const r = perpetualFunding({
      markPrice: 100,
      indexPrice: 100,
      fundingRate: 0.0005,
      intervalHours: 1,
    });
    expect(r.value.periodsPerYear).toBe(8760);
    expect(r.value.annualizedSimple).toBeCloseTo(4.38, 10);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('crypto.extreme_funding');
  });

  it('guards missing input, non-positive prices/interval, and a non-finite funding rate', () => {
    expect(() => perpetualFunding(undefined as never)).toThrowError();
    expect(() =>
      perpetualFunding({ markPrice: 0, indexPrice: 100, fundingRate: 0 }),
    ).toThrowError();
    expect(() =>
      perpetualFunding({ markPrice: 100, indexPrice: -1, fundingRate: 0 }),
    ).toThrowError();
    expect(() =>
      perpetualFunding({ markPrice: 100, indexPrice: 100, fundingRate: Infinity }),
    ).toThrowError();
    expect(() =>
      perpetualFunding({ markPrice: 100, indexPrice: 100, fundingRate: 0, intervalHours: 0 }),
    ).toThrowError();
  });
});

describe('futuresBasis', () => {
  it('decomposes a contango basis and, given financing, the cash-and-carry edge', () => {
    const r = futuresBasis({
      spot: 60000,
      future: 61800,
      timeToExpiryYears: 0.25,
      financingRate: 0.05,
      coinYield: 0.01,
    });
    expect(r.value.basis).toBeCloseTo(1800, 8);
    expect(r.value.basisFraction).toBeCloseTo(0.03, 12);
    expect(r.value.annualizedSimple).toBeCloseTo(0.12, 12);
    expect(r.value.annualizedLog).toBeCloseTo(Math.log(61800 / 60000) / 0.25, 12);
    expect(r.value.structure).toBe('contango');
    // fairFuture = spot·e^{(r−q)t}; carryArbitrage = annualizedLog − (r−q).
    expect(r.value.fairFuture).toBeCloseTo(60000 * Math.exp(0.04 * 0.25), 8);
    expect(r.value.richness).toBeCloseTo(61800 - 60000 * Math.exp(0.04 * 0.25), 6);
    expect(r.value.carryArbitrage).toBeCloseTo(Math.log(61800 / 60000) / 0.25 - 0.04, 12);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('crypto.carry_arbitrage');
  });

  it('at the fair future the richness and cash-and-carry edge are exactly zero', () => {
    const spot = 60000,
      r = 0.05,
      q = 0.01,
      t = 0.3;
    const fair = spot * Math.exp((r - q) * t);
    const res = futuresBasis({
      spot,
      future: fair,
      timeToExpiryYears: t,
      financingRate: r,
      coinYield: q,
    });
    expect(res.value.richness!).toBeCloseTo(0, 6);
    expect(res.value.carryArbitrage!).toBeCloseTo(0, 12);
    expect(res.value.annualizedLog).toBeCloseTo(r - q, 12);
    expect(res.diagnostics.warnings).toHaveLength(0); // no arb flagged
  });

  it('labels backwardation and omits the cash-and-carry fields without financing', () => {
    const r = futuresBasis({ spot: 60000, future: 59400, timeToExpiryYears: 0.25 });
    expect(r.value.structure).toBe('backwardation');
    expect(r.value.basis).toBeCloseTo(-600, 8);
    expect(r.value.fairFuture).toBeUndefined();
    expect(r.value.richness).toBeUndefined();
    expect(r.value.carryArbitrage).toBeUndefined();
  });

  it('labels a flat basis', () => {
    expect(futuresBasis({ spot: 100, future: 100, timeToExpiryYears: 0.5 }).value.structure).toBe(
      'flat',
    );
  });

  it('flags a negative cash-and-carry edge (short-spot / long-future), defaulting coinYield to 0', () => {
    // Deep backwardation with financing but no coinYield ⇒ carryArbitrage < 0 ⇒ the reverse arb, coinYield → 0.
    const r = futuresBasis({
      spot: 60000,
      future: 58000,
      timeToExpiryYears: 0.25,
      financingRate: 0.05,
    });
    expect(r.value.carryArbitrage!).toBeLessThan(-0.05);
    const arb = r.diagnostics.warnings.find((w) => w.code === 'crypto.carry_arbitrage');
    expect(arb?.message).toContain('short-spot / long-future');
    expect(arb?.context?.['coinYield']).toBe(0);
  });

  it('guards missing input and non-positive prices/time', () => {
    expect(() => futuresBasis(undefined as never)).toThrowError();
    expect(() => futuresBasis({ spot: -1, future: 100, timeToExpiryYears: 0.25 })).toThrowError();
    expect(() => futuresBasis({ spot: 100, future: 0, timeToExpiryYears: 0.25 })).toThrowError();
    expect(() => futuresBasis({ spot: 100, future: 100, timeToExpiryYears: 0 })).toThrowError();
    expect(() =>
      futuresBasis({ spot: 100, future: 101, timeToExpiryYears: 0.25, financingRate: NaN }),
    ).toThrowError();
  });
});

describe('predictedFunding', () => {
  it('equals the interest rate when the premium is within the clamp', () => {
    // |interest − premium| = |0.0001 − 0.00005| = 0.00005 ≤ clamp 0.0005 ⇒ funding = interest.
    const r = predictedFunding({ premium: 0.00005, interestRate: 0.0001 });
    expect(r.value.fundingRate).toBeCloseTo(0.0001, 12);
    expect(r.value.capped).toBe(false);
  });

  it('tracks the premium (minus the clamp) when the premium dominates', () => {
    const hi = predictedFunding({ premium: 0.002, interestRate: 0.0001 }); // premium−clamp
    expect(hi.value.fundingRate).toBeCloseTo(0.0015, 12);
    const lo = predictedFunding({ premium: -0.002, interestRate: 0.0001 }); // premium+clamp
    expect(lo.value.fundingRate).toBeCloseTo(-0.0015, 12);
  });

  it('applies a hard cap and discloses it', () => {
    const r = predictedFunding({ premium: 0.02, interestRate: 0, cap: 0.0075 });
    expect(r.value.fundingRate).toBeCloseTo(0.0075, 12);
    expect(r.value.capped).toBe(true);
    // Within the cap, capped is false.
    const u = predictedFunding({ premium: 0.001, interestRate: 0, cap: 0.0075 });
    expect(u.value.capped).toBe(false);
  });

  it('defaults the interest rate to 0 and guards bad inputs', () => {
    expect(predictedFunding({ premium: 0.0003 }).value.fundingRate).toBeCloseTo(0, 12); // premium+clamp(−premium)= premium−premium=0
    expect(() => predictedFunding(undefined as never)).toThrowError();
    expect(() => predictedFunding({ premium: NaN })).toThrowError();
    expect(() => predictedFunding({ premium: 0.001, clamp: -1 })).toThrowError();
    expect(() => predictedFunding({ premium: 0.001, cap: -1 })).toThrowError();
  });
});

describe('fundingBasisSpread', () => {
  it('composes the two carries and flags which instrument is rich', () => {
    // Perp funding 0.0001/8h ⇒ 10.95 %/yr; a future ~12 %/yr basis ⇒ future-rich.
    const r = fundingBasisSpread({
      fundingRate: 0.0001,
      spot: 60000,
      future: 61800,
      timeToExpiryYears: 0.25,
    });
    expect(r.value.fundingImpliedCarry).toBeCloseTo(0.1095, 10);
    expect(r.value.basisImpliedCarry).toBeCloseTo(Math.log(61800 / 60000) / 0.25, 12);
    expect(r.value.spread).toBeCloseTo(r.value.basisImpliedCarry - r.value.fundingImpliedCarry, 12);
    expect(r.value.signal).toBe('future-rich');
  });

  it('is aligned when the two carries match, and perp-rich when funding exceeds the basis', () => {
    // Choose a future whose log-basis equals the perp's 10.95 % carry ⇒ aligned.
    const carry = 0.0001 * ((365 * 24) / 8); // 0.1095
    const future = 60000 * Math.exp(carry * 0.25);
    expect(
      fundingBasisSpread({ fundingRate: 0.0001, spot: 60000, future, timeToExpiryYears: 0.25 })
        .value.signal,
    ).toBe('aligned');
    // High funding, flat basis ⇒ perp-rich.
    expect(
      fundingBasisSpread({
        fundingRate: 0.001,
        spot: 60000,
        future: 60000,
        timeToExpiryYears: 0.25,
      }).value.signal,
    ).toBe('perpetual-rich');
  });

  it('guards missing input and non-positive prices/time/interval', () => {
    expect(() => fundingBasisSpread(undefined as never)).toThrowError();
    expect(() =>
      fundingBasisSpread({ fundingRate: 0.0001, spot: 0, future: 100, timeToExpiryYears: 0.25 }),
    ).toThrowError();
    expect(() =>
      fundingBasisSpread({ fundingRate: 0.0001, spot: 100, future: 100, timeToExpiryYears: -1 }),
    ).toThrowError();
    expect(() =>
      fundingBasisSpread({ fundingRate: NaN, spot: 100, future: 100, timeToExpiryYears: 0.25 }),
    ).toThrowError();
  });
});

describe('optionsBasisSpread', () => {
  // BSM-consistent quotes: the put-call-parity forward must recover the true forward S·e^{(r−q)t}.
  const spot = 60_000;
  const rate = 0.05;
  const q = 0.02;
  const t = 0.5;
  const strike = 61_000;
  const trueForward = spot * Math.exp((rate - q) * t);
  const call = blackScholes.price({
    type: 'call',
    spot,
    strike,
    timeToExpiryYears: t,
    riskFreeRate: rate,
    volatility: 0.7,
    dividendYield: q,
  });
  const put = blackScholes.price({
    type: 'put',
    spot,
    strike,
    timeToExpiryYears: t,
    riskFreeRate: rate,
    volatility: 0.7,
    dividendYield: q,
  });

  it('recovers the parity forward + carry and is aligned when the future prices the same carry', () => {
    const r = optionsBasisSpread({
      spot,
      strike,
      call,
      put,
      timeToExpiryYears: t,
      riskFreeRate: rate,
      future: trueForward,
    });
    expect(r.value.optionsImpliedForward).toBeCloseTo(
      strike + Math.exp(rate * t) * (call - put),
      12,
    );
    expect(r.value.optionsImpliedForward).toBeCloseTo(trueForward, 6); // parity recovers the true forward
    expect(r.value.optionsImpliedCarry).toBeCloseTo(rate - q, 8); // ln(F/S)/t == r − q
    expect(r.value.basisImpliedCarry).toBeCloseTo(rate - q, 8);
    expect(r.value.spread).toBeCloseTo(0, 8);
    expect(r.value.signal).toBe('aligned');
  });

  it('flags future-rich / options-rich by which market prices the richer forward', () => {
    // A future 3 %/yr richer than the options-implied forward ⇒ future-rich.
    const richFuture = trueForward * Math.exp(0.03 * t);
    expect(
      optionsBasisSpread({
        spot,
        strike,
        call,
        put,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        future: richFuture,
      }).value.signal,
    ).toBe('future-rich');
    // A future below the synthetic ⇒ options-rich.
    const cheapFuture = trueForward * Math.exp(-0.03 * t);
    expect(
      optionsBasisSpread({
        spot,
        strike,
        call,
        put,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        future: cheapFuture,
      }).value.signal,
    ).toBe('options-rich');
  });

  it('rejects an inconsistent (non-positive parity forward) quote and guards inputs', () => {
    // strike + e^{rt}(call − put) ≤ 0 ⇒ the quotes are arbitraged/stale; refuse rather than emit NaN carry.
    expect(() =>
      optionsBasisSpread({
        spot,
        strike: 100,
        call: 0,
        put: 200,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        future: trueForward,
      }),
    ).toThrow(/parity forward/);
    expect(() => optionsBasisSpread(undefined as never)).toThrowError();
    expect(() =>
      optionsBasisSpread({
        spot: 0,
        strike,
        call,
        put,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        future: trueForward,
      }),
    ).toThrowError();
    expect(() =>
      optionsBasisSpread({
        spot,
        strike,
        call,
        put,
        t,
        rate,
        future: trueForward,
        bogus: 1,
      } as never),
    ).toThrowError();
  });
});

describe('compounding of a ≤−100%-per-interval funding rate (P2.2, Law 7)', () => {
  it('reports annualizedCompounded null with a disclosure — never NaN with converged: true', () => {
    const r = perpetualFunding({
      markPrice: 100,
      indexPrice: 100,
      fundingRate: -1.1,
      intervalHours: 7,
    });
    expect(r.value.annualizedCompounded).toBeNull();
    expect(Number.isFinite(r.value.annualizedSimple)).toBe(true); // the simple annualization stays exact
    expect(r.diagnostics.warnings.some((w) => w.code === 'crypto.compounding_undefined')).toBe(
      true,
    );
    // JSON-safe end to end.
    expect(JSON.parse(JSON.stringify(r)).value.annualizedCompounded).toBeNull();
  });

  it('a normal funding rate keeps a finite compounded annualization and no disclosure', () => {
    const r = perpetualFunding({
      markPrice: 100,
      indexPrice: 100,
      fundingRate: 0.0001,
      intervalHours: 8,
    });
    expect(Number.isFinite(r.value.annualizedCompounded)).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === 'crypto.compounding_undefined')).toBe(
      false,
    );
  });

  it('reports compounded overflow as null with a disclosure', () => {
    const r = perpetualFunding({
      markPrice: 100,
      indexPrice: 100,
      fundingRate: 10,
      intervalHours: 8,
    });
    expect(r.value.annualizedCompounded).toBeNull();
    expect(r.diagnostics.warnings.map((warning) => warning.code)).toContain(
      'crypto.compounding_overflow',
    );
    expect(JSON.parse(JSON.stringify(r)).value.annualizedCompounded).toBeNull();
  });
});

/**
 * [review-1] Seven crypto facades built their Computed envelope by hand and returned it directly,
 * skipping `finalizeResult` — the Law 7 postcondition every other facade goes through. A successful
 * result could therefore carry `Infinity`/`NaN`, which `JSON.stringify` silently turns into `null`
 * at the serialization boundary. The repro below returned `fairFuture: Infinity` as a SUCCESS.
 */
describe('Law 7 postcondition — every carry facade is finalized', () => {
  it('futuresBasis: an overflowing financing rate now FAILS loudly instead of returning Infinity', () => {
    let caught: unknown;
    try {
      futuresBasis({
        spot: 60000,
        future: 61000,
        timeToExpiryYears: 0.25,
        financingRate: 1e6, // e^{1e6·0.25} = Infinity ⇒ fairFuture / richness are non-finite
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostconditionError);
    expect(isQuantError(caught, 'postcondition.non_finite_result')).toBe(true);
    expect((caught as Error).message).toMatch(/futuresBasis/);
    expect((caught as Error).message).toMatch(/value\.fairFuture/);
  });

  it('futuresBasis: an implausible (but survivable) rate is flagged before it compounds', () => {
    // 20 = 2000%/yr over half a year: e^{10} ≈ 22026, finite — so the result stands, with the
    // unit-mistake warning that would have explained the overflow above.
    const r = futuresBasis({
      spot: 100,
      future: 110,
      timeToExpiryYears: 0.5,
      financingRate: 20,
    });
    expect(Number.isFinite(r.value.fairFuture!)).toBe(true);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('input.suspicious_risk_free_rate');
    // a normal rate says nothing
    const normal = futuresBasis({
      spot: 100,
      future: 110,
      timeToExpiryYears: 0.5,
      financingRate: 0.05,
    });
    expect(normal.diagnostics.warnings.map((w) => w.code)).not.toContain(
      'input.suspicious_risk_free_rate',
    );
  });

  it('optionsBasisSpread: an overflowing discount rate fails the postcondition, and is warned about', () => {
    expect(() =>
      optionsBasisSpread({
        spot: 60000,
        strike: 60000,
        call: 3000,
        put: 2500,
        timeToExpiryYears: 0.25,
        riskFreeRate: 1e6,
        future: 61000,
      }),
    ).toThrow(PostconditionError);
  });

  it('predictedFunding / fundingBasisSpread stay finalized on ordinary inputs', () => {
    // Stub-free wiring check: the finalized path is the ONLY path, so a clean call still returns.
    expect(
      predictedFunding({ premium: 0.0003, interestRate: 0.0001 }).value.fundingRate,
    ).toBeCloseTo(0.0003 + Math.max(-0.0005, Math.min(0.0005, 0.0001 - 0.0003)), 12);
    const spread = fundingBasisSpread({
      fundingRate: 0.0001,
      spot: 60000,
      future: 61000,
      timeToExpiryYears: 0.25,
    });
    expect(Number.isFinite(spread.value.spread)).toBe(true);
  });
});
