/** Package-private shared evaluation of positive analytic premium legs. */
import { ErrorCode, InputError } from '@totalfinance/core';

/** Distinguish arithmetic precision failures from input validation during IV trials. */
export class AnalyticPrecisionError extends InputError {
  constructor() {
    super(
      'analytic option price: subtraction cancellation cannot resolve this premium reliably in binary64 precision. Use a higher-precision calculation for these inputs; this is not distribution-tail underflow.',
      { code: ErrorCode.InputOutOfRange, context: { reason: 'analytic_premium_cancellation' } },
    );
  }
}

export function analyticPremium(input: {
  positiveLeg: number;
  negativeLeg: number;
  atTheMoney: boolean;
  discountedScale: number;
  standardDeviation: number;
}): number {
  const { positiveLeg, negativeLeg, atTheMoney, discountedScale, standardDeviation: sd } = input;
  if (atTheMoney && sd > 0 && sd < 1e-4) {
    // 2*Phi(sd/2)-1 = integral[-sd/2,sd/2] phi(x) dx. The omitted
    // sd^6/21504 relative term is <5e-29 here, below binary64 rounding.
    const square = sd * sd;
    return (
      ((discountedScale * sd) / Math.sqrt(2 * Math.PI)) *
      (1 - square / 24 + (square * square) / 640)
    );
  }
  const value = positiveLeg - negativeLeg;
  // A true zero tail leg is not a subtraction problem. With two positive legs,
  // refuse subtraction leaving at most about 12 significant bits rather than claiming a reliable premium.
  // This conservative supported-precision boundary is scale-relative; ordinary
  // successful prices and IVs are pinned separately by independent regressions.
  if (
    Number.isFinite(positiveLeg) &&
    Number.isFinite(negativeLeg) &&
    (value < 0 ||
      (positiveLeg > 0 &&
        negativeLeg > 0 &&
        value <= 4096 * Number.EPSILON * Math.max(positiveLeg, negativeLeg)))
  ) {
    throw new AnalyticPrecisionError();
  }
  return value;
}

/** Only the precision failure above is an unavailable solver trial; never swallow bad inputs. */
export function analyticTrial(calculate: () => number): number {
  try {
    return calculate();
  } catch (error) {
    if (error instanceof AnalyticPrecisionError) return NaN;
    throw error;
  }
}
