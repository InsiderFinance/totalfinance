/** No-arbitrage bound checks for option prices (spec §9.5/§9.6). */

import {
  ensureFiniteWhenPresent,
  ErrorCode,
  type Assumptions,
  type OptionType,
  type QuantWarning,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  requireArgumentObject,
} from '@totalfinance/core';
import { analyticAssumptions } from './facade-util.js';
import { blackScholesPriceBounds } from './bsm.js';

const TOL = 1e-9;

/** Input for {@link checkBlackScholesNoArbitrage} — the observed price plus the BSM inputs it's bounded against. */
export interface BlackScholesNoArbitrageInput {
  type: OptionType;
  /** The observed option price to test. */
  price: number;
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  /** Continuous dividend yield (decimal, default 0). */
  dividendYield?: number;
}

/** {@link BlackScholesNoArbitrageInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const BSM_NO_ARBITRAGE_KEYS = [
  'type',
  'price',
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
] as const;

/**
 * The no-arbitrage verdict (Law 2 report grammar): the admissibility flag plus the exact band the
 * price was tested against, with the applied conventions on `assumptions` and any violations as
 * structured warnings on `diagnostics.warnings` (empty when the price is admissible).
 */
export interface BlackScholesNoArbitrageReport {
  /** True when the observed price sits inside the BSM no-arbitrage band (within tolerance). */
  admissible: boolean;
  /** The no-arbitrage lower bound (discounted intrinsic). */
  lower: number;
  /** The no-arbitrage upper bound (call: discounted spot; put: discounted strike). */
  upper: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: Assumptions;
  /** The violations as structured warnings (empty when admissible). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Check an observed price against BSM no-arbitrage bounds. Returns a report: `admissible` plus the
 * `[lower, upper]` band, with each violation as a structured `severity: 'error'` warning on
 * `diagnostics.warnings` (empty when the price is admissible). Callers decide whether to treat a
 * violation as fatal.
 */
export function checkBlackScholesNoArbitrage(
  input: BlackScholesNoArbitrageInput,
): BlackScholesNoArbitrageReport {
  const functionName = 'checkBlackScholesNoArbitrage';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled field (`divYield`) must teach, never silently loosen the tested band.
  ensureKnownKeys(functionName, 'input', input, BSM_NO_ARBITRAGE_KEYS);
  // `type` is meaning-changing: garbage would silently test the other leg's band (design law #4).
  ensureEnum(input.type, ['call', 'put'] as const, 'type', functionName);
  // A NaN price makes every band comparison false — it would read as "admissible". Reject it, but
  // allow an exact 0 (a worthless quote is a legitimate price to test against the band).
  ensureFinite(input.price, 'price', functionName);
  ensureNonNegative(input.price, 'price', functionName);
  ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  ensurePositive(input.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    functionName,
    ErrorCode.InputNegativeTime,
  );
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(input.dividendYield, 'dividendYield', functionName);
  const q = input.dividendYield ?? 0;

  const { type, price, spot, strike, timeToExpiryYears, riskFreeRate } = input;
  const { lower, upper } = blackScholesPriceBounds({
    type,
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    dividendYield: q,
  });
  const warnings: QuantWarning[] = [];
  if (price < lower - TOL) {
    warnings.push({
      code: ErrorCode.ImpliedVolatilityBelowIntrinsic,
      message: `price ${price} is below the no-arbitrage lower bound ${lower}`,
      severity: 'error',
      context: { price, lower },
    });
  }
  if (price > upper + TOL) {
    warnings.push({
      code: ErrorCode.ImpliedVolatilityAboveMax,
      message: `price ${price} is above the no-arbitrage upper bound ${upper}`,
      severity: 'error',
      context: { price, upper },
    });
  }
  return {
    admissible: warnings.length === 0,
    lower,
    upper,
    assumptions: analyticAssumptions({
      model: 'black-scholes-merton',
      timeToExpiryYears,
      dividendModel: q === 0 ? 'none' : 'continuousYield',
    }),
    diagnostics: { warnings },
  };
}
