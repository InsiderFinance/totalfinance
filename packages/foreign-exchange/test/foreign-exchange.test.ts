/**
 * FC5 — foreign-exchange acceptance laws with HAND-COMPUTED goldens: conversion round-trip
 * identity, quote-direction inversion, triangular-arbitrage closure, covered interest parity
 * (continuous exactness + the no-arbitrage fixture), forward points/value/swap/NDF goldens, the
 * currency-exposure missing-pair law, and the hedged P&L decomposition. Identities hold at 1e-12.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import {
  type CurrencyPairQuote,
  convertCurrency,
  coveredInterestParityForward,
  crossRate,
  currencyExposure,
  foreignExchangeForwardPoints,
  foreignExchangeForwardValue,
  foreignExchangeSwapValue,
  hedgeRatio,
  invertCurrencyPairQuote,
  nonDeliverableForwardValue,
  pipValue,
  requireCurrencyPairQuote,
  spotForwardHedgedProfitAndLoss,
} from '../src/index.js';

/** |actual − expected| ≤ tolerance × max(1, |expected|) — the identities-at-1e-12 comparator. */
const close = (actual: number, expected: number, tolerance = 1e-12): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    tolerance * Math.max(1, Math.abs(expected)),
  );
};

const expectInputError = (call: () => unknown, code: string, messagePart: string): void => {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputError);
  const inputError = thrown as InputError;
  expect(inputError.code).toBe(code);
  expect(inputError.message).toContain(messagePart);
};

const eurUsd: CurrencyPairQuote = { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 };
const usdJpy: CurrencyPairQuote = {
  baseCurrency: 'USD',
  quoteCurrency: 'JPY',
  quotePerBase: 147.5,
};

describe('conversion round-trip identity (1e-12)', () => {
  it('EUR→USD→EUR with the same quote returns the amount', () => {
    const there = convertCurrency({
      amount: 1_000,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: eurUsd,
    });
    // 1_000 EUR × 1.08 USD/EUR = 1_080 USD.
    close(there.convertedAmount, 1_080);
    expect(there.assumptions.orientation).toBe('direct');
    const back = convertCurrency({
      amount: there.convertedAmount,
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      spotRate: eurUsd,
    });
    // 1_080 USD ÷ 1.08 USD/EUR = 1_000 EUR — the round trip closes at 1e-12.
    expect(back.assumptions.orientation).toBe('inverted');
    close(back.convertedAmount, 1_000);
  });

  it('a negative amount (a liability) round-trips identically', () => {
    const there = convertCurrency({
      amount: -250,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: eurUsd,
    });
    close(there.convertedAmount, -270);
    const back = convertCurrency({
      amount: there.convertedAmount,
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      spotRate: eurUsd,
    });
    close(back.convertedAmount, -250);
  });
});

describe('quote-direction inversion', () => {
  it('inverting twice is the identity (1e-12)', () => {
    const once = invertCurrencyPairQuote({ quote: eurUsd });
    expect(once.quote.baseCurrency).toBe('USD');
    expect(once.quote.quoteCurrency).toBe('EUR');
    // 1 / 1.08 = 0.925925…
    close(once.quote.quotePerBase, 1 / 1.08);
    expect(once.assumptions.inversion).toBe('1 / quotePerBase');
    const twice = invertCurrencyPairQuote({ quote: once.quote });
    expect(twice.quote.baseCurrency).toBe('EUR');
    expect(twice.quote.quoteCurrency).toBe('USD');
    close(twice.quote.quotePerBase, 1.08);
  });

  it('converting with the inverted quote gives the same answer', () => {
    const inverted = invertCurrencyPairQuote({ quote: eurUsd }).quote;
    const direct = convertCurrency({
      amount: 1_000,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: eurUsd,
    });
    const viaInverted = convertCurrency({
      amount: 1_000,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: inverted,
    });
    expect(viaInverted.assumptions.orientation).toBe('inverted');
    // 1_000 × 1.08 vs 1_000 ÷ (1/1.08) — identical at 1e-12.
    close(viaInverted.convertedAmount, direct.convertedAmount);
  });
});

describe('triangular-arbitrage closure', () => {
  it('EURUSD × USDJPY = EURJPY, and the one-hop conversion matches the two-hop at 1e-9', () => {
    const cross = crossRate({
      firstQuote: eurUsd,
      secondQuote: usdJpy,
      crossBaseCurrency: 'EUR',
      crossQuoteCurrency: 'JPY',
    });
    // 1 EUR = 1.08 USD; 1 USD = 147.5 JPY → 1 EUR = 1.08 × 147.5 = 159.3 JPY.
    close(cross.quote.quotePerBase, 159.3, 1e-12);
    expect(cross.assumptions.throughCurrency).toBe('USD');
    expect(cross.quote.baseCurrency).toBe('EUR');
    expect(cross.quote.quoteCurrency).toBe('JPY');

    const oneHop = convertCurrency({
      amount: 100,
      fromCurrency: 'EUR',
      toCurrency: 'JPY',
      spotRate: cross.quote,
    });
    const hopOne = convertCurrency({
      amount: 100,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: eurUsd,
    });
    const hopTwo = convertCurrency({
      amount: hopOne.convertedAmount,
      fromCurrency: 'USD',
      toCurrency: 'JPY',
      spotRate: usdJpy,
    });
    // 100 EUR → 108 USD → 15_930 JPY, vs 100 × 159.3 directly.
    close(hopTwo.convertedAmount, 15_930, 1e-9);
    close(oneHop.convertedAmount, hopTwo.convertedAmount, 1e-9);
  });

  it('handles a reversed-orientation leg by explicit inversion', () => {
    // The JPY leg supplied upside down: 1 JPY = 0.0068 USD, so 1 USD = 1/0.0068 JPY.
    const jpyUsd: CurrencyPairQuote = {
      baseCurrency: 'JPY',
      quoteCurrency: 'USD',
      quotePerBase: 0.0068,
    };
    const cross = crossRate({
      firstQuote: eurUsd,
      secondQuote: jpyUsd,
      crossBaseCurrency: 'EUR',
      crossQuoteCurrency: 'JPY',
    });
    // 1 EUR = 1.08 USD; 1 USD = 1/0.0068 JPY → quotePerBase = 1.08 / 0.0068.
    close(cross.quote.quotePerBase, 1.08 / 0.0068);
    expect(cross.assumptions.derivation).toContain('inverted');
  });
});

describe('covered interest parity', () => {
  it('continuous compounding: forward = spot · e^((rd − rf)·t) exactly (1e-12)', () => {
    const parity = coveredInterestParityForward({
      spotRate: eurUsd,
      domesticAnnualRate: 0.05,
      foreignAnnualRate: 0.03,
      timeYears: 0.75,
      compounding: 'continuous',
    });
    // 1.08 × e^{(0.05 − 0.03) × 0.75} = 1.08 × e^{0.015}.
    close(parity.forwardRate.quotePerBase, 1.08 * Math.exp(0.015));
    expect(parity.forwardRate.baseCurrency).toBe('EUR');
    expect(parity.forwardRate.quoteCurrency).toBe('USD');
    expect(parity.assumptions.rateRoles).toBe('domestic = quote currency, foreign = base currency');
    expect(parity.assumptions.compounding).toBe('continuous');
  });

  it('no-arbitrage fixture: invest abroad + convert at the parity forward = convert now + invest at home', () => {
    const parity = coveredInterestParityForward({
      spotRate: eurUsd,
      domesticAnnualRate: 0.05,
      foreignAnnualRate: 0.03,
      timeYears: 0.75,
      compounding: 'continuous',
    });
    // Strategy A: hold 1 EUR, invest at the foreign (EUR = base) rate → e^{0.03×0.75} EUR at T,
    // then convert at the parity forward F → e^{0.0225} × F USD.
    const strategyA = Math.exp(0.03 * 0.75) * parity.forwardRate.quotePerBase;
    // Strategy B: convert 1 EUR at spot → 1.08 USD, invest at the domestic (USD = quote) rate →
    // 1.08 × e^{0.05×0.75} USD at T.
    const strategyB = 1.08 * Math.exp(0.05 * 0.75);
    // Both equal 1.08 × e^{0.0375}: A = e^{0.0225} × 1.08 × e^{0.015} = 1.08 × e^{0.0375} = B.
    close(strategyA, strategyB);
  });

  it('defaults to annual compounding and echoes it; annual golden', () => {
    const parity = coveredInterestParityForward({
      spotRate: eurUsd,
      domesticAnnualRate: 0.05,
      foreignAnnualRate: 0.03,
      timeYears: 2,
    });
    expect(parity.assumptions.compounding).toBe('annual');
    // 1.08 × (1.05)² / (1.03)² = 1.08 × 1.1025 / 1.0609.
    close(parity.forwardRate.quotePerBase, (1.08 * 1.1025) / 1.0609);
  });
});

describe('forward points', () => {
  it('golden: (1.0952 − 1.08) / 0.0001 = 152 points', () => {
    const result = foreignExchangeForwardPoints({
      spotRate: eurUsd,
      forwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 },
      pointSize: 0.0001,
    });
    close(result.forwardPoints, 152, 1e-9);
    expect(result.assumptions.pointSizeSource).toBe('explicit');
  });

  it('rejects mismatched pairs', () => {
    expectInputError(
      () =>
        foreignExchangeForwardPoints({
          spotRate: eurUsd,
          forwardRate: { baseCurrency: 'USD', quoteCurrency: 'EUR', quotePerBase: 0.92 },
          pointSize: 0.0001,
        }),
      ErrorCode.InputOutOfRange,
      'SAME currency pair',
    );
  });
});

describe('forward value', () => {
  it('golden with a hand discount factor: (1.0952 − 1.08) × 1e6 × 0.97 = 14 744 USD', () => {
    const buyer = foreignExchangeForwardValue({
      contractRate: eurUsd,
      currentForwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 },
      notionalBaseAmount: 1_000_000,
      discountFactorToSettlement: 0.97,
      perspective: 'buyer-of-base',
    });
    // 0.0152 × 1_000_000 × 0.97 = 14_744.
    close(buyer.forwardValueInQuoteCurrency, 14_744, 1e-9);
    const seller = foreignExchangeForwardValue({
      contractRate: eurUsd,
      currentForwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 },
      notionalBaseAmount: 1_000_000,
      discountFactorToSettlement: 0.97,
      perspective: 'seller-of-base',
    });
    // The long/short sign law: seller = −buyer.
    close(seller.forwardValueInQuoteCurrency, -buyer.forwardValueInQuoteCurrency);
  });

  it('is zero at its contracted fair forward under unchanged inputs (acceptance law)', () => {
    const fair = coveredInterestParityForward({
      spotRate: eurUsd,
      domesticAnnualRate: 0.05,
      foreignAnnualRate: 0.03,
      timeYears: 0.75,
      compounding: 'continuous',
    }).forwardRate;
    const value = foreignExchangeForwardValue({
      contractRate: fair,
      currentForwardRate: fair,
      notionalBaseAmount: 1_000_000,
      discountFactorToSettlement: 0.97,
      perspective: 'buyer-of-base',
    });
    expect(value.forwardValueInQuoteCurrency).toBe(0);
  });

  it('rejects a signed notional — direction belongs to perspective', () => {
    expectInputError(
      () =>
        foreignExchangeForwardValue({
          contractRate: eurUsd,
          currentForwardRate: eurUsd,
          notionalBaseAmount: -1_000_000,
          discountFactorToSettlement: 0.97,
          perspective: 'buyer-of-base',
        }),
      ErrorCode.InputOutOfRange,
      'perspective',
    );
  });
});

describe('swap value', () => {
  it('equals near + far legs, each matching foreignExchangeForwardValue (compose law)', () => {
    const nearLeg = {
      contractRate: eurUsd,
      currentForwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.085 },
      notionalBaseAmount: 1_000_000,
      discountFactorToSettlement: 0.99,
      perspective: 'buyer-of-base',
    } as const;
    const farLeg = {
      contractRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.09 },
      currentForwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 },
      notionalBaseAmount: 1_000_000,
      discountFactorToSettlement: 0.97,
      perspective: 'seller-of-base',
    } as const;
    const swap = foreignExchangeSwapValue({ nearLeg, farLeg });
    // near (buyer): (1.085 − 1.08) × 1e6 × 0.99 = 4_950; far (seller): −(1.0952 − 1.09) × 1e6 × 0.97 = −0.0052 × 1e6 × 0.97 = −5_044.
    close(swap.nearLegValue, 4_950, 1e-9);
    close(swap.farLegValue, -5_044, 1e-9);
    close(swap.swapValueInQuoteCurrency, 4_950 - 5_044, 1e-9);
    close(swap.swapValueInQuoteCurrency, swap.nearLegValue + swap.farLegValue);
    close(swap.nearLegValue, foreignExchangeForwardValue(nearLeg).forwardValueInQuoteCurrency);
    close(swap.farLegValue, foreignExchangeForwardValue(farLeg).forwardValueInQuoteCurrency);
  });

  it('rejects legs on different pairs', () => {
    expectInputError(
      () =>
        foreignExchangeSwapValue({
          nearLeg: {
            contractRate: eurUsd,
            currentForwardRate: eurUsd,
            notionalBaseAmount: 1_000,
            discountFactorToSettlement: 0.99,
            perspective: 'buyer-of-base',
          },
          farLeg: {
            contractRate: usdJpy,
            currentForwardRate: usdJpy,
            notionalBaseAmount: 1_000,
            discountFactorToSettlement: 0.97,
            perspective: 'seller-of-base',
          },
        }),
      ErrorCode.InputOutOfRange,
      'SAME currency pair',
    );
  });
});

describe('non-deliverable forward', () => {
  it('golden: (1.10 − 1.08) × 1e6 × 0.98 = 19 600, settled in the quote currency', () => {
    const value = nonDeliverableForwardValue({
      contractRate: eurUsd,
      fixingRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.1 },
      notionalBaseAmount: 1_000_000,
      settlementCurrency: 'USD',
      discountFactorToSettlement: 0.98,
      perspective: 'buyer-of-base',
    });
    // 0.02 × 1_000_000 × 0.98 = 19_600.
    close(value.nonDeliverableForwardValueInSettlementCurrency, 19_600, 1e-9);
    expect(value.assumptions.fixingSource).toBe('caller-supplied fixing rate');
  });

  it("rejects a settlement currency other than the pair's quote currency, naming the constraint", () => {
    expectInputError(
      () =>
        nonDeliverableForwardValue({
          contractRate: eurUsd,
          fixingRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.1 },
          notionalBaseAmount: 1_000_000,
          settlementCurrency: 'EUR',
          discountFactorToSettlement: 0.98,
          perspective: 'buyer-of-base',
        }),
      ErrorCode.InputOutOfRange,
      "v1 settles in the pair's quote currency only",
    );
  });
});

describe('currency exposure', () => {
  it('converts through an inverted-orientation quote and excludes the missing pair with reason', () => {
    const result = currencyExposure({
      positions: [
        { positionLabel: 'us-cash', currency: 'USD', marketValueInPositionCurrency: 500 },
        { positionLabel: 'bund-etf', currency: 'EUR', marketValueInPositionCurrency: 1_000 },
        { positionLabel: 'gilt', currency: 'GBP', marketValueInPositionCurrency: 300 },
        { positionLabel: 'euro-bond', currency: 'EUR', marketValueInPositionCurrency: 500 },
        { positionLabel: 'swiss-note', currency: 'CHF', marketValueInPositionCurrency: 200 },
      ],
      baseCurrency: 'USD',
      spotRates: [
        eurUsd,
        // CHF supplied upside down: 1 USD = 0.8 CHF, so 1 CHF = 1.25 USD.
        { baseCurrency: 'USD', quoteCurrency: 'CHF', quotePerBase: 0.8 },
      ],
    });
    // USD 500 stays 500; EUR (1_000 + 500) × 1.08 = 1_620; CHF 200 ÷ 0.8 = 250; GBP excluded.
    close(result.totalBaseValue, 500 + 1_620 + 250, 1e-9);
    expect(result.byCurrency.map((row) => row.currency)).toEqual(['USD', 'EUR', 'CHF']);
    const [usd, eur, chf] = result.byCurrency;
    close(usd!.valueInBaseCurrency, 500);
    expect(usd!.positionCount).toBe(1);
    close(eur!.valueInCurrency, 1_500);
    close(eur!.valueInBaseCurrency, 1_620, 1e-9);
    expect(eur!.positionCount).toBe(2);
    close(chf!.valueInBaseCurrency, 250, 1e-9);
    close(eur!.exposureFraction as number, 1_620 / 2_370, 1e-9);
    // The missing GBP pair excluded the position WITH its reason — never guessed.
    expect(result.excludedPositions).toHaveLength(1);
    expect(result.excludedPositions[0]!.positionLabel).toBe('gilt');
    expect(result.excludedPositions[0]!.reason).toContain('GBP');
    expect(result.excludedPositions[0]!.reason).toContain('USD');
    expect(result.diagnostics.warnings.some((message) => message.includes('GBP'))).toBe(true);
    // The inverted orientation is disclosed.
    const chfUse = result.assumptions.quotesUsed.find((use) => use.currency === 'CHF');
    expect(chfUse!.orientation).toBe('inverted');
  });
});

describe('hedge ratio', () => {
  it('golden: 750k over 1m = 0.75, both amounts echoed', () => {
    const result = hedgeRatio({
      exposureBaseAmount: 1_000_000,
      hedgeNotionalBaseAmount: 750_000,
    });
    close(result.hedgeRatio as number, 0.75);
    expect(result.assumptions.exposureBaseAmount).toBe(1_000_000);
    expect(result.assumptions.hedgeNotionalBaseAmount).toBe(750_000);
    expect(result.hedgeRatioAbsentReason).toBeUndefined();
  });

  it('zero exposure → null with reason, never Infinity', () => {
    const result = hedgeRatio({ exposureBaseAmount: 0, hedgeNotionalBaseAmount: 750_000 });
    expect(result.hedgeRatio).toBeNull();
    expect(result.hedgeRatioAbsentReason).toContain('exposureBaseAmount is 0');
  });
});

describe('spot/forward hedged P&L decomposition', () => {
  const initialSpotRate = eurUsd;
  const finalSpotRate: CurrencyPairQuote = {
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    quotePerBase: 1.12,
  };
  const forwardRateAtHedge: CurrencyPairQuote = {
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    quotePerBase: 1.095,
  };

  it('hedgedFraction 0 → pure spot P&L: (1.12 − 1.08) × 1e6 = 40 000', () => {
    const result = spotForwardHedgedProfitAndLoss({
      initialSpotRate,
      finalSpotRate,
      hedgedFraction: 0,
      notionalBaseAmount: 1_000_000,
    });
    close(result.totalProfitAndLossInQuoteCurrency, 40_000, 1e-9);
    close(result.unhedgedComponent, 40_000, 1e-9);
    expect(result.hedgedComponent).toBe(0);
  });

  it('hedgedFraction 1 → pure forward lock: (1.095 − 1.08) × 1e6 = 15 000, final spot irrelevant', () => {
    const result = spotForwardHedgedProfitAndLoss({
      initialSpotRate,
      finalSpotRate,
      forwardRateAtHedge,
      hedgedFraction: 1,
      notionalBaseAmount: 1_000_000,
    });
    close(result.totalProfitAndLossInQuoteCurrency, 15_000, 1e-9);
    expect(result.unhedgedComponent).toBe(0);
    close(result.hedgedComponent, 15_000, 1e-9);
  });

  it('hedgedFraction 0.5 golden: 20 000 unhedged + 7 500 hedged = 27 500, components reconcile', () => {
    const result = spotForwardHedgedProfitAndLoss({
      initialSpotRate,
      finalSpotRate,
      forwardRateAtHedge,
      hedgedFraction: 0.5,
      notionalBaseAmount: 1_000_000,
    });
    // (1 − 0.5) × 0.04 × 1e6 = 20_000; 0.5 × 0.015 × 1e6 = 7_500.
    close(result.unhedgedComponent, 20_000, 1e-9);
    close(result.hedgedComponent, 7_500, 1e-9);
    close(result.totalProfitAndLossInQuoteCurrency, 27_500, 1e-9);
    close(
      result.totalProfitAndLossInQuoteCurrency,
      result.unhedgedComponent + result.hedgedComponent,
    );
  });

  it('forwardRateAtHedge is required whenever hedgedFraction > 0', () => {
    expectInputError(
      () =>
        spotForwardHedgedProfitAndLoss({
          initialSpotRate,
          finalSpotRate,
          hedgedFraction: 0.5,
          notionalBaseAmount: 1_000_000,
        }),
      ErrorCode.InputMissingField,
      'forwardRateAtHedge',
    );
  });
});

describe('pip value', () => {
  it('golden: EUR/USD, pip 0.0001, 100k EUR notional → 10 USD per pip, 10/1.08 EUR', () => {
    const result = pipValue({
      quote: eurUsd,
      pipSize: 0.0001,
      notionalAmount: 100_000,
      notionalCurrency: 'EUR',
    });
    // 0.0001 × 100_000 = 10 USD; 10 ÷ 1.08 EUR.
    close(result.pipValueInQuoteCurrency, 10, 1e-9);
    close(result.pipValueInBaseCurrency, 10 / 1.08, 1e-9);
    expect(result.assumptions.pipSizeSource).toBe('explicit');
    expect(result.assumptions.notionalCurrencyRole).toBe('base');
  });

  it('a quote-currency notional is restated in base units first', () => {
    const result = pipValue({
      quote: eurUsd,
      pipSize: 0.0001,
      notionalAmount: 108_000,
      notionalCurrency: 'USD',
    });
    // 108_000 USD ÷ 1.08 = 100_000 EUR base units → 10 USD per pip again.
    close(result.pipValueInQuoteCurrency, 10, 1e-9);
    expect(result.assumptions.notionalCurrencyRole).toBe('quote');
  });

  it('pip size is never guessed — absent pipSize is a missing-field error', () => {
    expectInputError(
      () =>
        pipValue({
          quote: eurUsd,
          notionalAmount: 100_000,
          notionalCurrency: 'EUR',
        } as never),
      ErrorCode.InputMissingField,
      'pipSize',
    );
  });
});

describe('teaching rejections', () => {
  it('a same-currency pair is rejected', () => {
    expectInputError(
      () =>
        convertCurrency({
          amount: 1,
          fromCurrency: 'EUR',
          toCurrency: 'USD',
          spotRate: { baseCurrency: 'EUR', quoteCurrency: 'EUR', quotePerBase: 1 },
        }),
      ErrorCode.InputOutOfRange,
      'must differ',
    );
  });

  it('a lowercase currency code teaches the uppercase fix', () => {
    expectInputError(
      () =>
        convertCurrency({
          amount: 1,
          fromCurrency: 'eur',
          toCurrency: 'USD',
          spotRate: eurUsd,
        }),
      ErrorCode.InputOutOfRange,
      "write it as 'EUR'",
    );
  });

  it('a same-currency conversion with a quote supplied is rejected — the identity needs no quote', () => {
    expectInputError(
      () =>
        convertCurrency({ amount: 1, fromCurrency: 'USD', toCurrency: 'USD', spotRate: eurUsd }),
      ErrorCode.InputOutOfRange,
      'identity conversion needs no quote',
    );
  });

  it('a quote that does not connect the two currencies is rejected', () => {
    expectInputError(
      () =>
        convertCurrency({ amount: 1, fromCurrency: 'GBP', toCurrency: 'JPY', spotRate: eurUsd }),
      ErrorCode.InputOutOfRange,
      'does not connect',
    );
  });

  it('cross with no common currency names the currencies', () => {
    expectInputError(
      () =>
        crossRate({
          firstQuote: eurUsd,
          secondQuote: { baseCurrency: 'GBP', quoteCurrency: 'JPY', quotePerBase: 190 },
          crossBaseCurrency: 'EUR',
          crossQuoteCurrency: 'JPY',
        }),
      ErrorCode.InputOutOfRange,
      'share no common currency',
    );
  });

  it('cross with both currencies shared is rejected — no third currency exists', () => {
    expectInputError(
      () =>
        crossRate({
          firstQuote: eurUsd,
          secondQuote: { baseCurrency: 'USD', quoteCurrency: 'EUR', quotePerBase: 1 / 1.08 },
          crossBaseCurrency: 'EUR',
          crossQuoteCurrency: 'USD',
        }),
      ErrorCode.InputOutOfRange,
      'share BOTH currencies',
    );
  });

  it('an unknown key is rejected with a did-you-mean', () => {
    expectInputError(
      () =>
        convertCurrency({
          amount: 1,
          fromCurrency: 'EUR',
          toCurrency: 'USD',
          spotRte: eurUsd,
        } as never),
      ErrorCode.InputUnknownField,
      'spotRate',
    );
  });

  it('the pair guard convicts its own missing functionName and label first', () => {
    expect(() => requireCurrencyPairQuote('' as never, 'quote', eurUsd)).toThrowError(
      /functionName must be a non-empty string/,
    );
    expect(() => requireCurrencyPairQuote('someBoundary', '' as never, eurUsd)).toThrowError(
      /label must be a non-empty string/,
    );
  });

  it('a non-positive quotePerBase is not a price', () => {
    expectInputError(
      () =>
        invertCurrencyPairQuote({
          quote: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 0 },
        }),
      ErrorCode.InputOutOfRange,
      'quotePerBase must be > 0',
    );
  });
});

describe('conflicting quotes are refused, never order-resolved (review finding)', () => {
  const base = {
    positions: [
      { positionLabel: 'bund-etf', currency: 'EUR', marketValueInPositionCurrency: 1_000 },
    ],
    baseCurrency: 'USD',
  };
  it('two DISAGREEING quotes for one pair throw a teaching error naming both', () => {
    expect(() =>
      currencyExposure({
        ...base,
        spotRates: [
          { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 },
          { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.1 },
        ],
      }),
    ).toThrowError(/disagree.*EUR\/USD@1\.08.*EUR\/USD@1\.1/s);
  });
  it('identical duplicates deduplicate safely with a warning, and the result is order-independent', () => {
    const quotes = [
      { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 },
      { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 },
    ];
    const first = currencyExposure({ ...base, spotRates: quotes });
    const second = currencyExposure({ ...base, spotRates: [...quotes].reverse() });
    expect(first.totalBaseValue).toBe(second.totalBaseValue);
    expect(first.diagnostics.warnings.join(' ')).toContain('deduplicated');
  });
});

describe('overflow is refused, never a successful Infinity (Law 7, review finding)', () => {
  it('convertCurrency at the top of the double range teaches instead of returning Infinity', () => {
    expect(() =>
      convertCurrency({
        amount: 1.7e308,
        fromCurrency: 'EUR',
        toCurrency: 'USD',
        spotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 },
      }),
    ).toThrowError(/not representable in IEEE-754/);
  });
});
