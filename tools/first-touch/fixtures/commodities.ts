/**
 * FC6 — first-touch fixtures for `@totalfinance/commodities`: every analysis-role export plus the
 * ratified-plain forward-price primitive. Thunks build FRESH inputs per call; probes mutate what
 * they are given.
 */

import { type FixtureThunk } from '../inputs.js';

const curve = (): unknown[] => [
  { timeToDeliveryYears: 0.25, forwardPrice: 72.4 },
  { timeToDeliveryYears: 0.5, forwardPrice: 73.1 },
  { timeToDeliveryYears: 1, forwardPrice: 74.6 },
];

export const COMMODITIES_FIXTURES: Record<string, FixtureThunk> = {
  // Forwards.
  'commodities.commodityForwardPrice': () => [
    {
      spotPrice: 72,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
      compounding: 'continuous',
    },
  ],
  'commodities.commodityForwardValue': () => [
    {
      contractForwardPrice: 70,
      currentForwardPrice: 74,
      quantity: 1_000,
      discountFactorToDelivery: 0.98,
      perspective: 'long',
    },
  ],
  'commodities.commodityCarry': () => [
    {
      spotPrice: 72,
      forwardPrice: 74.19,
      timeToDeliveryYears: 0.5,
      compounding: 'continuous',
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
    },
  ],
  'commodities.impliedConvenienceYield': () => [
    {
      spotPrice: 72,
      forwardPrice: 74.19,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      compounding: 'continuous',
    },
  ],
  'commodities.impliedStorageCost': () => [
    {
      spotPrice: 72,
      forwardPrice: 74.19,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualConvenienceYield: 0.01,
      compounding: 'continuous',
    },
  ],
  'commodities.futuresHedgeRatio': () => [
    { exposureQuantity: 25_000, futuresContractSize: 1_000, betaOrHedgeEffectiveness: 0.92 },
  ],
  'commodities.commodityBasis': () => [{ spotPrice: 72, futuresPrice: 73.5 }],

  // Term structure.
  'commodities.termStructureState': () => [{ curve: curve(), flatToleranceFraction: 0.001 }],
  'commodities.calendarSpread': () => [
    {
      nearPoint: { timeToDeliveryYears: 0.25, forwardPrice: 72.4 },
      farPoint: { timeToDeliveryYears: 0.5, forwardPrice: 73.1 },
    },
  ],
  'commodities.curveSpreadAnalytics': () => [{ curve: curve() }],
  'commodities.rollYield': () => [
    { expiringContractPrice: 74.2, nextContractPrice: 72.9, spotPriceAtRoll: 74.5 },
  ],
  'commodities.rollReturnDecomposition': () => [
    {
      initialSpotPrice: 100,
      finalSpotPrice: 104,
      initialContractPrice: 98,
      finalContractPriceBeforeRoll: 103.5,
      nextContractPriceAtRoll: 101,
    },
  ],
  'commodities.seasonalityProfile': () => [
    {
      observations: Array.from({ length: 24 }, (_, index) => ({
        observationDate: `${2024 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-15`,
        value: 70 + (index % 12) * 0.4,
      })),
      statistic: 'mean',
    },
  ],
  'commodities.convertCommodityQuantity': () => [
    { quantity: 1_000, fromUnit: 'barrel', toUnit: 'gallon', conversionFactor: 42 },
  ],
};
