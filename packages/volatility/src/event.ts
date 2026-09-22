/**
 * Event-volatility analytics (spec §10.3): expected move (from IV and from the ATM straddle),
 * risk-neutral probability ITM, and probability of touch (first-passage to a barrier).
 *
 * All probabilities are RISK-NEUTRAL model probabilities (they use the risk-neutral drift `r − q`),
 * not real-world forecasts — this is stated in each function's contract.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type OptionType,
  type QuantWarning,
  WarningCode,
  ensureEnum,
  requireArgumentObject,
  facade,
  ensureKnownKeys,
  ensureFinite,
  warning,
} from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';
import { RISK_NEUTRAL_ESTIMATE } from './estimate.js';

/** √(2/π): the ratio E|Z| for a standard normal, linking the ATM straddle to the 1-σ move. */
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);

export interface ExpectedMove {
  /** One standard-deviation move in price units: `spot · σ · √t`. */
  oneSigma: number;
  /** One-σ move as a fraction of spot: `σ · √t`. */
  oneSigmaFraction: number;
  /** Expected absolute move `E|S_t − S_0| = oneSigma · √(2/π)` (≈ the ATM straddle price). */
  expectedAbsolute: number;
  /** Spot − oneSigma. */
  lower: number;
  /** Spot + oneSigma. */
  upper: number;
}

function requirePositive(value: number, field: string, functionName: string): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a positive finite number, got ${value}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { [field]: value },
      },
    );
  }
}

/** The conventions echoed by an expected-move estimate (a lognormal 1-σ band). */
type ExpectedMoveExtra = {
  measure: 'risk-neutral';
  basis: 'lognormal-1sigma';
  volatilitySource: string;
};

/** Input for {@link expectedMoveFromImpliedVolatility}. */
export interface ExpectedMoveImpliedVolatilityInput {
  spot: number;
  /** Implied volatility (annualized decimal) — the one volatility vocabulary across the library. */
  impliedVolatility: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
}

/**
 * Pre-release spellings of this input that are DELETED, not deprecated (spec D5): `iv` was the
 * original, `vol` replaced it briefly, and 3B.N settled on `impliedVolatility`. Both are rejected BY
 * NAME so the mistake teaches its fix instead of being silently ignored.
 *
 * This list is removal EVIDENCE: it must keep naming the retired spellings. A repo-wide rename that
 * rewrites it into the current name inverts the guard — the function then rejects its own canonical
 * input — which is exactly what happened here and what `naming-removals.test.ts` now pins.
 */
const RETIRED_VOLATILITY_KEYS = ['iv', 'vol'] as const;

/** Expected move implied by a volatility: the 1-σ band `spot · σ · √t` (and the expected |move|). */
function expectedMoveFromImpliedVolatilityExplain(
  input: ExpectedMoveImpliedVolatilityInput,
): Computed<ExpectedMove, ExpectedMoveExtra> {
  requireArgumentObject('expectedMoveFromImpliedVolatility', 'input', input);
  const received = input as unknown as Record<string, unknown>;
  const retired = RETIRED_VOLATILITY_KEYS.find((key) => key in received);
  if (retired) {
    throw new InputError(
      `expectedMoveFromImpliedVolatility: '${retired}' is not an input — the field is named impliedVolatility across @insiderfinance/totalfinance/volatility. ` +
        'e.g. expectedMoveFromImpliedVolatility({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 })',
      {
        code: ErrorCode.InputWrongShape,
        context: {
          function: 'expectedMoveFromImpliedVolatility',
          received: retired,
          expected: 'impliedVolatility',
        },
      },
    );
  }
  ensureKnownKeys('expectedMoveFromImpliedVolatility', 'input', input, [
    'spot',
    'impliedVolatility',
    'timeToExpiryYears',
  ]);
  const { spot, timeToExpiryYears, impliedVolatility } = input;
  requirePositive(spot, 'spot', 'expectedMoveFromImpliedVolatility');
  if (impliedVolatility === undefined) {
    throw new InputError(
      'expectedMoveFromImpliedVolatility: impliedVolatility is required.\n  e.g. expectedMoveFromImpliedVolatility({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 })',
      {
        code: ErrorCode.InputMissingField,
        context: { function: 'expectedMoveFromImpliedVolatility', field: 'impliedVolatility' },
      },
    );
  }
  requirePositive(impliedVolatility, 'impliedVolatility', 'expectedMoveFromImpliedVolatility');
  requirePositive(timeToExpiryYears, 'timeToExpiryYears', 'expectedMoveFromImpliedVolatility');
  const oneSigmaFraction = impliedVolatility * Math.sqrt(timeToExpiryYears);
  const oneSigma = spot * oneSigmaFraction;
  return {
    value: {
      oneSigma,
      oneSigmaFraction,
      expectedAbsolute: oneSigma * SQRT_2_OVER_PI,
      lower: spot - oneSigma,
      upper: spot + oneSigma,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears,
      measure: 'risk-neutral',
      basis: 'lognormal-1sigma',
      volatilitySource: 'implied',
    },
    diagnostics: { warnings: [RISK_NEUTRAL_ESTIMATE] },
  };
}

/**
 * FACADE (P3.2, one gesture): the plain call returns the {@link ExpectedMove} numbers; the same
 * call's `.explain()` returns the full envelope with the risk-neutral caveat — exactly the
 * `blackScholes.call` / `blackScholes.call.explain` grammar, one import away.
 */
export const expectedMoveFromImpliedVolatility = facade(
  'expectedMoveFromImpliedVolatility',
  (input: ExpectedMoveImpliedVolatilityInput): ExpectedMove =>
    expectedMoveFromImpliedVolatilityExplain(input).value,
  expectedMoveFromImpliedVolatilityExplain,
);

/**
 * Expected move implied by the ATM straddle price. The ATM-forward straddle ≈ `E|move|`
 * (= `oneSigma · √(2/π)`), so `oneSigma = straddlePrice / √(2/π) ≈ 1.2533 · straddlePrice`.
 */
/** Input for {@link expectedMoveFromStraddle}. */
export interface ExpectedMoveStraddleInput {
  spot: number;
  /** The ATM straddle mid-price (call + put at the spot strike). */
  straddlePrice: number;
}

function expectedMoveFromStraddleExplain(
  input: ExpectedMoveStraddleInput,
): Computed<ExpectedMove, ExpectedMoveExtra> {
  requireArgumentObject('expectedMoveFromStraddle', 'input', input);
  ensureKnownKeys('expectedMoveFromStraddle', 'input', input, ['spot', 'straddlePrice']);
  const { spot, straddlePrice } = input;
  requirePositive(spot, 'spot', 'expectedMoveFromStraddle');
  requirePositive(straddlePrice, 'straddlePrice', 'expectedMoveFromStraddle');
  const oneSigma = straddlePrice / SQRT_2_OVER_PI;
  return {
    value: {
      oneSigma,
      oneSigmaFraction: oneSigma / spot,
      expectedAbsolute: straddlePrice,
      lower: spot - oneSigma,
      upper: spot + oneSigma,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      measure: 'risk-neutral',
      basis: 'lognormal-1sigma',
      volatilitySource: 'atm-straddle',
    },
    diagnostics: { warnings: [RISK_NEUTRAL_ESTIMATE] },
  };
}

/** FACADE: plain {@link ExpectedMove}; `.explain()` for the envelope. */
export const expectedMoveFromStraddle = facade(
  'expectedMoveFromStraddle',
  (input: ExpectedMoveStraddleInput): ExpectedMove => expectedMoveFromStraddleExplain(input).value,
  expectedMoveFromStraddleExplain,
);

/**
 * Risk-neutral probability the option finishes in the money: `N(d2)` for a call, `N(−d2)` for a put,
 * where `d2 = (ln(S/K) + (r − q − σ²/2)t) / (σ√t)`. This is the model probability `P(S_t ⋛ K)` under
 * the risk-neutral measure — NOT a real-world forecast.
 */
/** The conventions echoed by a risk-neutral probability estimate. */
type RiskNeutralExtra = { measure: 'risk-neutral'; drift: string };

/** Input for {@link probabilityInTheMoney}. */
export interface ProbabilityInTheMoneyInput {
  type: OptionType;
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  /** Implied volatility (annualized decimal). */
  volatility: number;
  /** Continuous dividend yield (decimal, default 0). */
  dividendYield?: number;
}

const PROBABILITY_IN_THE_MONEY_KEYS = [
  'type',
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'volatility',
  'dividendYield',
] as const;

function probabilityInTheMoneyExplain(
  input: ProbabilityInTheMoneyInput,
): Computed<number, RiskNeutralExtra> {
  requireArgumentObject('probabilityInTheMoney', 'input', input);
  ensureKnownKeys('probabilityInTheMoney', 'input', input, PROBABILITY_IN_THE_MONEY_KEYS);
  // `type` flips the answer to its complement — a meaning-changing field is never coerced, so
  // `type: 'Call'` must teach, not silently return P(put ITM) (design law #4).
  ensureEnum(input.type, ['call', 'put'] as const, 'type', 'probabilityInTheMoney');
  const {
    type,
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    volatility,
    dividendYield = 0,
  } = input;
  requirePositive(spot, 'spot', 'probabilityInTheMoney');
  requirePositive(strike, 'strike', 'probabilityInTheMoney');
  requirePositive(timeToExpiryYears, 'timeToExpiryYears', 'probabilityInTheMoney');
  requirePositive(volatility, 'volatility', 'probabilityInTheMoney');
  // Rates are signed but must be FINITE — a NaN rate would ride silently into d2 (Law 7).
  ensureFinite(riskFreeRate, 'riskFreeRate', 'probabilityInTheMoney');
  ensureFinite(dividendYield, 'dividendYield', 'probabilityInTheMoney');
  const d2 =
    (Math.log(spot / strike) +
      (riskFreeRate - dividendYield - 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * Math.sqrt(timeToExpiryYears));
  return {
    value: type === 'call' ? normalCdf(d2) : normalCdf(-d2),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears,
      measure: 'risk-neutral',
      drift: 'risk-neutral (r − q)',
    },
    diagnostics: { warnings: [RISK_NEUTRAL_ESTIMATE] },
  };
}

/** FACADE: plain probability; `.explain()` carries the risk-neutral disclosure. */
export const probabilityInTheMoney = facade(
  'probabilityInTheMoney',
  (input: ProbabilityInTheMoneyInput): number => probabilityInTheMoneyExplain(input).value,
  probabilityInTheMoneyExplain,
);

/**
 * Risk-neutral probability the underlying TOUCHES `barrier` at any time before `t` (first-passage
 * probability for geometric Brownian motion with drift `ν = r − q − σ²/2`). Uses the reflection
 * principle; for a driftless process it reduces to `2·P(S_t beyond barrier)`.
 */
/** Input for {@link probabilityOfTouch}. */
export interface ProbabilityOfTouchInput {
  spot: number;
  barrier: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  /** Implied volatility (annualized decimal). */
  volatility: number;
  /** Continuous dividend yield (decimal, default 0). */
  dividendYield?: number;
}

function probabilityOfTouchExplain(
  input: ProbabilityOfTouchInput,
): Computed<number, RiskNeutralExtra> {
  requireArgumentObject('probabilityOfTouch', 'input', input);
  ensureKnownKeys('probabilityOfTouch', 'input', input, [
    'spot',
    'barrier',
    'timeToExpiryYears',
    'riskFreeRate',
    'volatility',
    'dividendYield',
  ]);
  const { spot, barrier, timeToExpiryYears, riskFreeRate, volatility, dividendYield = 0 } = input;
  requirePositive(spot, 'spot', 'probabilityOfTouch');
  requirePositive(barrier, 'barrier', 'probabilityOfTouch');
  requirePositive(timeToExpiryYears, 'timeToExpiryYears', 'probabilityOfTouch');
  requirePositive(volatility, 'volatility', 'probabilityOfTouch');
  ensureFinite(riskFreeRate, 'riskFreeRate', 'probabilityOfTouch');
  ensureFinite(dividendYield, 'dividendYield', 'probabilityOfTouch');
  const rn = (value: number): Computed<number, RiskNeutralExtra> => ({
    value,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears,
      measure: 'risk-neutral',
      drift: 'risk-neutral (r − q − σ²/2)',
    },
    diagnostics: { warnings: [RISK_NEUTRAL_ESTIMATE] },
  });
  if (barrier === spot) return rn(1);
  const nu = riskFreeRate - dividendYield - 0.5 * volatility * volatility;
  const sigT = volatility * Math.sqrt(timeToExpiryYears);
  const a = Math.log(barrier / spot);
  let p: number;
  if (barrier > spot) {
    p =
      normalCdf((-a + nu * timeToExpiryYears) / sigT) +
      Math.exp((2 * nu * a) / (volatility * volatility)) *
        normalCdf((-a - nu * timeToExpiryYears) / sigT);
  } else {
    p =
      normalCdf((a - nu * timeToExpiryYears) / sigT) +
      Math.exp((2 * nu * a) / (volatility * volatility)) *
        normalCdf((a + nu * timeToExpiryYears) / sigT);
  }
  return rn(Math.min(1, Math.max(0, p)));
}

/** FACADE: plain first-passage probability; `.explain()` for the envelope. */
export const probabilityOfTouch = facade(
  'probabilityOfTouch',
  (input: ProbabilityOfTouchInput): number => probabilityOfTouchExplain(input).value,
  probabilityOfTouchExplain,
);

/**
 * Realized-vs-implied spread: `impliedVolatility − realizedVolatility` in volatility points (positive ⇒
 * vol premium). BOTH inputs are ANNUALIZED decimals (0.20 = 20%): a technical-analysis estimator
 * supplies that with `annualization: 252` on daily bars — a per-bar σ here is wrong by √252.
 */
export interface RealizedImpliedInput {
  /** Annualized implied volatility (decimal). */
  impliedVolatility: number;
  /** Annualized realized volatility (decimal) — e.g. `historicalVolatility(closes, { period, annualization: 252 })`. */
  realizedVolatility: number;
}

export function realizedImpliedSpread(input: RealizedImpliedInput): number {
  requireArgumentObject('realizedImpliedSpread', 'input', input);
  ensureKnownKeys('realizedImpliedSpread', 'input', input, [
    'impliedVolatility',
    'realizedVolatility',
  ]);
  const { impliedVolatility, realizedVolatility } = input;
  requirePositive(impliedVolatility, 'impliedVolatility', 'realizedImpliedSpread');
  if (!(realizedVolatility >= 0) || !Number.isFinite(realizedVolatility)) {
    throw new InputError(
      `realizedImpliedSpread: realizedVolatility must be ≥ 0, got ${realizedVolatility}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { realizedVolatility },
      },
    );
  }
  return impliedVolatility - realizedVolatility;
}

/**
 * Variance risk premium: `impliedVolatility² − realizedVolatility²`, the premium of option-implied
 * ANNUALIZED variance over subsequently-realized annualized variance (the compensation for bearing
 * variance risk; both inputs are annualized volatilities, so the result is in annualized-variance
 * units). Positive on average.
 */
export function varianceRiskPremium(input: RealizedImpliedInput): number {
  requireArgumentObject('varianceRiskPremium', 'input', input);
  ensureKnownKeys('varianceRiskPremium', 'input', input, [
    'impliedVolatility',
    'realizedVolatility',
  ]);
  const { impliedVolatility, realizedVolatility } = input;
  requirePositive(impliedVolatility, 'impliedVolatility', 'varianceRiskPremium');
  if (!(realizedVolatility >= 0) || !Number.isFinite(realizedVolatility)) {
    throw new InputError(
      `varianceRiskPremium: realizedVolatility must be ≥ 0, got ${realizedVolatility}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { realizedVolatility },
      },
    );
  }
  return impliedVolatility * impliedVolatility - realizedVolatility * realizedVolatility;
}

export interface EventVolatilityDecomposition {
  /** Total variance over the tenor `σ_atm²·t`. */
  totalVariance: number;
  /** Continuous (non-event) variance over the tenor `σ_base²·t`. */
  baseVariance: number;
  /** Variance attributed to the discrete event `σ_atm²·t − σ_base²·t` (clamped ≥ 0). */
  eventVariance: number;
  /** Implied one-event move as a fraction of spot, `√(eventVariance)` — the earnings/event jump size. */
  eventMove: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    timeToExpiryYears: number;
    method: 'additive-event-variance';
  };
  /** Structured warnings; a clamped (base > total) decomposition explains itself here. */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Decompose an event-spanning ATM vol into a continuous (diffusive) part and a discrete event jump
 * (spec §10.3). With a base (non-event) vol `σ_base` for the same tenor, the event contributes
 * `σ_atm²·t − σ_base²·t` of variance, i.e. an implied move of `√(that)` on the event day.
 */
export function eventVolatilityDecomposition(options: {
  atmVolatility: number;
  timeToExpiryYears: number;
  baseVolatility: number;
}): EventVolatilityDecomposition {
  requireArgumentObject('eventVolatilityDecomposition', 'options', options);
  ensureKnownKeys('eventVolatilityDecomposition', 'options', options, [
    'atmVolatility',
    'timeToExpiryYears',
    'baseVolatility',
  ]);
  requirePositive(options.atmVolatility, 'atmVolatility', 'eventVolatilityDecomposition');
  requirePositive(options.timeToExpiryYears, 'timeToExpiryYears', 'eventVolatilityDecomposition');
  if (!(options.baseVolatility >= 0) || !Number.isFinite(options.baseVolatility)) {
    throw new InputError(
      `eventVolatilityDecomposition: baseVolatility must be ≥ 0, got ${options.baseVolatility}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { baseVolatility: options.baseVolatility },
      },
    );
  }
  const totalVariance = options.atmVolatility * options.atmVolatility * options.timeToExpiryYears;
  const baseVariance = options.baseVolatility * options.baseVolatility * options.timeToExpiryYears;
  const eventVariance = Math.max(0, totalVariance - baseVariance);
  const warnings: QuantWarning[] = [];
  if (baseVariance > totalVariance) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `eventVolatilityDecomposition: baseVolatility exceeds the event-spanning ATM vol (base variance ${baseVariance} > total ${totalVariance}) — no positive event premium exists; eventVariance/eventMove clamped to 0.`,
        'warn',
        { totalVariance, baseVariance },
      ),
    );
  }
  return {
    totalVariance,
    baseVariance,
    eventVariance,
    eventMove: Math.sqrt(eventVariance),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears: options.timeToExpiryYears,
      method: 'additive-event-variance',
    },
    diagnostics: { warnings },
  };
}

/**
 * De-earned ATM vol: strip a known event jump (`eventMove`, a fraction of spot) out of an
 * event-spanning ATM vol, leaving the annualized continuous vol `√((σ_atm²·t − eventMove²)/t)`
 * (spec §10.3). Use it to compare vol levels across names with the earnings jump removed.
 * Envelope-shaped: the de-earned vol is `value` (Law 2 analysis grammar).
 */
function deEarnedVolatilityResult(options: {
  atmVolatility: number;
  timeToExpiryYears: number;
  eventMove: number;
}): Computed<number, { method: 'additive-event-variance' }> {
  requireArgumentObject('eventStrippedVolatility', 'options', options);
  ensureKnownKeys('eventStrippedVolatility', 'options', options, [
    'atmVolatility',
    'timeToExpiryYears',
    'eventMove',
  ]);
  requirePositive(options.atmVolatility, 'atmVolatility', 'eventStrippedVolatility');
  requirePositive(options.timeToExpiryYears, 'timeToExpiryYears', 'eventStrippedVolatility');
  if (!(options.eventMove >= 0) || !Number.isFinite(options.eventMove)) {
    throw new InputError(
      `eventStrippedVolatility: eventMove must be ≥ 0, got ${options.eventMove}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { eventMove: options.eventMove },
      },
    );
  }
  const residual =
    options.atmVolatility * options.atmVolatility * options.timeToExpiryYears -
    options.eventMove * options.eventMove;
  const warnings: QuantWarning[] = [];
  if (residual < 0) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `eventStrippedVolatility: the event move (${options.eventMove}) carries more variance than the whole tenor's ATM variance — the residual continuous variance is negative and was clamped to 0.`,
        'warn',
        { residual },
      ),
    );
  }
  return {
    value: Math.sqrt(Math.max(0, residual) / options.timeToExpiryYears),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears: options.timeToExpiryYears,
      method: 'additive-event-variance',
    },
    diagnostics: { warnings },
  };
}

/** Plain de-earned volatility; use `.explain()` for assumptions and clamp diagnostics. */
export const eventStrippedVolatility = facade(
  'eventStrippedVolatility',
  (options: { atmVolatility: number; timeToExpiryYears: number; eventMove: number }): number =>
    deEarnedVolatilityResult(options).value,
  deEarnedVolatilityResult,
);
