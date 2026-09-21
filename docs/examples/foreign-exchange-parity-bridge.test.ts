/**
 * FC5 acceptance law — cross-package FX conventions have parity fixtures with the new package.
 *
 * Three packages state the SAME no-arbitrage forward in their own vocabularies, and this bridge
 * proves they agree to machine precision rather than merely resembling each other:
 *
 *   - `@totalfinance/foreign-exchange` — `coveredInterestParityForward`: domestic = QUOTE-currency
 *     rate, foreign = BASE-currency rate, growth-factor ratio on the spot.
 *   - `@totalfinance/fixed-income` — `crossCurrencyBasisCurve` with no basis: the §14.5 curve
 *     arithmetic `F(0,t) = spot · D_for(t) / D_dom(t)`, spot quoted DOMESTIC units per 1 FOREIGN
 *     unit (the same orientation: quote per base).
 *   - `@totalfinance/options` — Black-Scholes with `dividendYield` = the foreign rate (the
 *     Garman-Kohlhagen reading): put-call parity `C − P = D_dom(t) · (F − K)` recovers the same
 *     forward, and the synthetic forward equals `foreignExchangeForwardValue` on the same terms.
 */

import { describe, expect, it } from 'vitest';
import {
  coveredInterestParityForward,
  foreignExchangeForwardValue,
} from '@totalfinance/foreign-exchange';
import { crossCurrencyBasisCurve, curves } from '@totalfinance/fixed-income';
import { blackScholes } from '@totalfinance/options';

// EUR/USD 1.08 — USD (quote) is the domestic leg, EUR (base) the foreign leg.
const SPOT = 1.08;
const DOMESTIC_RATE = 0.05; // USD, continuously compounded
const FOREIGN_RATE = 0.03; // EUR, continuously compounded
const REF = '2026-01-01';

const spotRate = { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: SPOT };

describe('the one covered-interest-parity forward, three packages', () => {
  it('fixed-income curve arithmetic and the FX package agree at 1e-12 across maturities', () => {
    const domestic = curves.flat({ rate: DOMESTIC_RATE, referenceDate: REF });
    const foreign = curves.flat({ rate: FOREIGN_RATE, referenceDate: REF });
    const bridge = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign });
    for (const timeYears of [0.25, 1, 2.5, 7]) {
      const parity = coveredInterestParityForward({
        spotRate,
        domesticAnnualRate: DOMESTIC_RATE,
        foreignAnnualRate: FOREIGN_RATE,
        timeYears,
        compounding: 'continuous',
      });
      // Both must equal spot · e^((rd − rf)·t) exactly — same convention, same number.
      const closedForm = SPOT * Math.exp((DOMESTIC_RATE - FOREIGN_RATE) * timeYears);
      expect(parity.forwardRate.quotePerBase).toBeCloseTo(closedForm, 12);
      expect(bridge.fxForward(timeYears)).toBeCloseTo(closedForm, 12);
      expect(bridge.fxForward(timeYears)).toBeCloseTo(parity.forwardRate.quotePerBase, 12);
    }
  });

  it('Garman-Kohlhagen put-call parity recovers the same forward, and the synthetic forward equals foreignExchangeForwardValue', () => {
    const timeYears = 0.75;
    const strike = 1.1;
    const optionBase = {
      spot: SPOT,
      strike,
      timeToExpiryYears: timeYears,
      riskFreeRate: DOMESTIC_RATE,
      dividendYield: FOREIGN_RATE, // the foreign rate plays the carry role — Garman-Kohlhagen
      volatility: 0.1,
    };
    const call = blackScholes.price({ ...optionBase, type: 'call' });
    const put = blackScholes.price({ ...optionBase, type: 'put' });
    const discountFactor = Math.exp(-DOMESTIC_RATE * timeYears);
    const parityForward = coveredInterestParityForward({
      spotRate,
      domesticAnnualRate: DOMESTIC_RATE,
      foreignAnnualRate: FOREIGN_RATE,
      timeYears,
      compounding: 'continuous',
    }).forwardRate;

    // Put-call parity: C − P = D_dom · (F − K), with F the covered-interest-parity forward.
    expect(call - put).toBeCloseTo(discountFactor * (parityForward.quotePerBase - strike), 12);

    // The synthetic forward (long call, short put at K) IS a forward contracted at K — mark it.
    const forward = foreignExchangeForwardValue({
      contractRate: { ...spotRate, quotePerBase: strike },
      currentForwardRate: parityForward,
      notionalBaseAmount: 1,
      discountFactorToSettlement: discountFactor,
      perspective: 'buyer-of-base',
    });
    expect(call - put).toBeCloseTo(forward.forwardValueInQuoteCurrency, 12);
  });
});
