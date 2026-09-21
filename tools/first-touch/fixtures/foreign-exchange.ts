/**
 * FC5 — first-touch fixtures for `@totalfinance/foreign-exchange`: the multi-arg boundary guards and
 * every analysis-role export. Thunks build FRESH inputs per call; probes mutate what they are
 * given.
 */

import { type FixtureThunk } from '../inputs.js';

const eurUsd = (): Record<string, unknown> => ({
  baseCurrency: 'EUR',
  quoteCurrency: 'USD',
  quotePerBase: 1.08,
});

const eurUsdForward = (): Record<string, unknown> => ({
  baseCurrency: 'EUR',
  quoteCurrency: 'USD',
  quotePerBase: 1.0952,
});

const usdJpy = (): Record<string, unknown> => ({
  baseCurrency: 'USD',
  quoteCurrency: 'JPY',
  quotePerBase: 147.5,
});

const forwardValueInput = (
  perspective: 'buyer-of-base' | 'seller-of-base',
): Record<string, unknown> => ({
  contractRate: eurUsd(),
  currentForwardRate: eurUsdForward(),
  notionalBaseAmount: 1_000_000,
  discountFactorToSettlement: 0.97,
  perspective,
});

export const FOREIGN_EXCHANGE_FIXTURES: Record<string, FixtureThunk> = {
  // Multi-arg boundary guards.
  'foreign-exchange.requireCurrencyCode': () => ['deepSweepProbe', 'currency', 'EUR'],
  'foreign-exchange.requireCurrencyPairQuote': () => ['deepSweepProbe', 'quote', eurUsd()],

  // Spot analyses.
  'foreign-exchange.invertCurrencyPairQuote': () => [{ quote: eurUsd() }],
  'foreign-exchange.crossRate': () => [
    {
      firstQuote: eurUsd(),
      secondQuote: usdJpy(),
      crossBaseCurrency: 'EUR',
      crossQuoteCurrency: 'JPY',
    },
  ],
  'foreign-exchange.convertCurrency': () => [
    { amount: 1_000, fromCurrency: 'EUR', toCurrency: 'USD', spotRate: eurUsd() },
  ],
  'foreign-exchange.pipValue': () => [
    { quote: eurUsd(), pipSize: 0.0001, notionalAmount: 100_000, notionalCurrency: 'EUR' },
  ],

  // Forward analyses.
  'foreign-exchange.coveredInterestParityForward': () => [
    {
      spotRate: eurUsd(),
      domesticAnnualRate: 0.05,
      foreignAnnualRate: 0.03,
      timeYears: 0.75,
      compounding: 'continuous',
    },
  ],
  'foreign-exchange.foreignExchangeForwardPoints': () => [
    { spotRate: eurUsd(), forwardRate: eurUsdForward(), pointSize: 0.0001 },
  ],
  'foreign-exchange.foreignExchangeForwardValue': () => [forwardValueInput('buyer-of-base')],
  'foreign-exchange.foreignExchangeSwapValue': () => [
    { nearLeg: forwardValueInput('seller-of-base'), farLeg: forwardValueInput('buyer-of-base') },
  ],
  'foreign-exchange.nonDeliverableForwardValue': () => [
    {
      contractRate: { baseCurrency: 'BRL', quoteCurrency: 'USD', quotePerBase: 0.185 },
      fixingRate: { baseCurrency: 'BRL', quoteCurrency: 'USD', quotePerBase: 0.19 },
      notionalBaseAmount: 1_000_000,
      settlementCurrency: 'USD',
      discountFactorToSettlement: 0.98,
      perspective: 'buyer-of-base',
    },
  ],

  // Exposure analyses.
  'foreign-exchange.currencyExposure': () => [
    {
      positions: [
        { positionLabel: 'bund-etf', currency: 'EUR', marketValueInPositionCurrency: 1_000 },
        { positionLabel: 'us-cash', currency: 'USD', marketValueInPositionCurrency: 500 },
      ],
      baseCurrency: 'USD',
      spotRates: [eurUsd()],
    },
  ],
  'foreign-exchange.hedgeRatio': () => [
    { exposureBaseAmount: 1_000_000, hedgeNotionalBaseAmount: 750_000 },
  ],
  'foreign-exchange.spotForwardHedgedProfitAndLoss': () => [
    {
      initialSpotRate: eurUsd(),
      finalSpotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.12 },
      forwardRateAtHedge: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.095 },
      hedgedFraction: 0.5,
      notionalBaseAmount: 1_000_000,
    },
  ],
};
