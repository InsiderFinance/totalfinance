/** Package-private shared evaluation of positive analytic premium legs. */
import { ErrorCode, InputError, type QuantErrorOptions } from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';

/** Distinguish arithmetic precision failures from input validation during IV trials. */
export class AnalyticPrecisionError extends InputError {
  constructor(
    message = 'analytic option price: subtraction cancellation cannot resolve this premium reliably in binary64 precision. Use a higher-precision calculation for these inputs; this is not distribution-tail underflow.',
    options: QuantErrorOptions = {
      code: ErrorCode.InputOutOfRange,
      context: { reason: 'analytic_premium_cancellation' },
    },
  ) {
    super(message, options);
    this.name = 'InputError';
  }
}

/** Accurate near equal prices, without overflowing a far-away ratio. */
export function logPriceRatio(a: number, b: number): number {
  const difference = a - b;
  return Math.abs(difference) < b / 2 ? Math.log1p(difference / b) : Math.log(a) - Math.log(b);
}

export function requireHorizonVolatility(sd: number): void {
  if (sd === 0)
    throw new AnalyticPrecisionError(
      'analytic option price: positive volatility times sqrt(timeToExpiryYears) underflows binary64 precision. Use a higher-precision calculation.',
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'timeToExpiryYears', reason: 'horizon_volatility_underflow' },
      },
    );
}

export function analyticPremium(input: {
  positiveLeg: number;
  negativeLeg: number;
  atTheMoney: boolean;
  discountedScale: number;
  discountedStrike: number;
  logMoneyness: number;
  logMoneynessError?: number;
  type: 'call' | 'put';
  standardDeviation: number;
}): number {
  const {
    positiveLeg,
    negativeLeg,
    atTheMoney,
    discountedScale: A,
    discountedStrike: B,
    logMoneyness: h,
    standardDeviation: sd,
  } = input;
  if (sd > 0 && sd < 1e-4 && A > 0 && B > 0 && Number.isFinite(A) && Number.isFinite(B)) {
    if (atTheMoney) {
      const square = sd * sd;
      return ((A * sd) / Math.sqrt(2 * Math.PI)) * (1 - square / 24 + (square * square) / 640);
    }
    const a = Math.abs(h) / sd;
    // A forward computed by cancelling carry and log-price terms may have lost the
    // moneyness needed to resolve its premium. Never interpret that loss as exact ATM.
    const intrinsic =
      input.type === 'call'
        ? h > 0
          ? h < 0.5
            ? B * Math.expm1(h)
            : A - B
          : 0
        : h < 0
          ? h > -0.5
            ? A * Math.expm1(-h)
            : B - A
          : 0;
    // Even the largest finite currency scale cannot rescue this Gaussian tail.
    if (a > 55) return intrinsic;
    if (((input.logMoneynessError ?? 0) / sd) * (1 + a) > 1e-8) throw new AnalyticPrecisionError();
    // The Gaussian integral for time value, expanded only in sd (not moneyness):
    // OTM = sqrt(A B) sd phi(a) [J0 - sd² J1/8 + sd⁴ J2/128].
    // Jn = exp(a²/2) integral_0^1 u^(2n) exp(-a²/(2u²)) du.
    // For a>=1, the normal Mills continued fraction (DLMF 7.9) gives J0
    // without subtracting two almost equal numbers. 512 levels resolve a=1 too.
    let j0: number;
    if (a < 1) j0 = 1 - a * Math.sqrt(2 * Math.PI) * Math.exp((a * a) / 2) * normalCdf(-a);
    else {
      let tail = 0;
      for (let k = 512; k >= 2; k--) tail = k / (a + tail);
      j0 = 1 / (1 + a * (a + tail));
    }
    const square = sd * sd;
    const j1 = (1 - a * a * j0) / 3;
    const j2 = (1 - a * a * j1) / 5;
    // Log scaling retains a representable currency premium even if phi(a) alone underflows.
    const timeValue = Math.exp(
      (Math.log(A) + Math.log(B)) / 2 +
        Math.log(sd) -
        (a * a) / 2 -
        Math.log(2 * Math.PI) / 2 +
        Math.log(j0 - (square * j1) / 8 + (square * square * j2) / 128),
    );
    return intrinsic + timeValue;
  }
  const value = positiveLeg - negativeLeg;
  // Tail CDF conditioning grows with d². This is a refusal threshold, not a
  // promise of a fixed number of accurate digits for an arbitrary subtraction.
  const tailCondition = sd > 0 ? 1 + (h / sd) ** 2 : 1;
  if (
    Number.isFinite(positiveLeg) &&
    Number.isFinite(negativeLeg) &&
    (value < 0 ||
      (positiveLeg > 0 &&
        negativeLeg > 0 &&
        value <= 4096 * Number.EPSILON * tailCondition * Math.max(positiveLeg, negativeLeg)))
  ) {
    throw new AnalyticPrecisionError();
  }
  return value;
}

/** Only arithmetic precision failures are unavailable trials; never swallow bad inputs. */
export function analyticTrial(calculate: () => number): number {
  try {
    return calculate();
  } catch (error) {
    if (error instanceof AnalyticPrecisionError) return NaN;
    throw error;
  }
}

/** Find a finite lower trial inside the caller's bounds; never walk past their ceiling. */
export function analyticLowerTrial(
  evaluate: (volatility: number) => number,
  lower: number,
  upper: number,
): { lower: number; value: number; adjusted: boolean } {
  const original = lower;
  let value = evaluate(lower);
  for (let i = 0; i < 64 && !Number.isFinite(value) && lower < upper; i++) {
    lower = Math.min(upper, lower * 2);
    value = evaluate(lower);
  }
  return { lower, value, adjusted: lower !== original };
}
