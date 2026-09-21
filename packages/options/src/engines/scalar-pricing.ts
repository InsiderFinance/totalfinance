import type { OptionStyle, OptionType } from '@totalfinance/core';

/**
 * Fully named scalar request shared by American engine adapters and closed-form approximations.
 *
 * This type is intentionally internal. It prevents the same spot/strike/time/rate/yield/volatility
 * transpositions inside the engine graph that Phase 3A removes from the public surface.
 */
export interface ScalarAmericanPricingInput {
  type: OptionType;
  style: OptionStyle;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}

/** American-engine scalar callback with one cohesive, named request. */
export type ScalarAmericanPricer = (input: ScalarAmericanPricingInput) => number;

/** Closed-form approximation request; exercise style is implied to be American. */
export type AmericanApproximationInput = Omit<ScalarAmericanPricingInput, 'style'>;

/** Closed-form American approximation callback. */
export type AmericanApproximationPricer = (input: AmericanApproximationInput) => number;
