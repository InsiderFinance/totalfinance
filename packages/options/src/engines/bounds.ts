/**
 * The no-arbitrage OUTPUT bound every option engine's value must satisfy (defect-fix wave, finding 5).
 *
 * Model-independent, assumption-free, and cheap: a call can never be worth more than the present
 * value of the underlying it delivers, a put never more than the present value of the strike it
 * receives, and neither can be negative. An American option adds its immediate-exercise floor as the
 * bound instead (it may be exercised now, so `S` / `K` replace their discounted forms).
 *
 * This is a POSTCONDITION, not input validation: every value that reaches it has already passed the
 * engine's own guards, so a violation means a TotalFinance defect (a blown-up truncation, an unbounded
 * branch probability, a diverging closed form) is about to be returned as a number a caller would
 * trade on. It is the single assertion that catches an entire family of silent-wrong-number bugs,
 * which is why it sits in the shared result assembly rather than in any one engine.
 */

import {
  ErrorCode,
  type OptionStyle,
  type OptionType,
  PostconditionError,
} from '@totalfinance/core';

/** One value to bound, expressed so both spot models and forward models can use it. */
export interface NoArbitrageBoundInput {
  /** Engine name for the message/context (e.g. `binomial-crr`, `heston-cos`). */
  engine: string;
  type: OptionType;
  style: OptionStyle;
  /** The value about to be returned. */
  value: number;
  /**
   * Present value of receiving one unit of the underlying at expiry — `S·e^{−qT}` for a spot model,
   * `F·e^{−rT}` for a forward model. The European call's ceiling.
   */
  underlyingPresentValue: number;
  /** Present value of the strike, `K·e^{−rT}`. The European put's ceiling. */
  strikePresentValue: number;
  /** Undiscounted spot/forward — the American call's immediate-exercise ceiling. */
  spot: number;
  /** Undiscounted strike — the American put's immediate-exercise ceiling. */
  strike: number;
  /**
   * Extra slack, for estimators whose value carries genuine sampling error (pass a few standard
   * errors for a Monte-Carlo estimate). Default 0 — a deterministic engine gets only the numerical
   * tolerance below.
   */
  tolerance?: number;
}

/** The highest value the contract can have: PV of the underlying / strike, or immediate exercise. */
export function noArbitrageCeiling(
  input: Omit<NoArbitrageBoundInput, 'engine' | 'value' | 'tolerance'>,
): number {
  const { type, style, underlyingPresentValue, strikePresentValue, spot, strike } = input;
  const american = style === 'american';
  return type === 'call'
    ? Math.max(underlyingPresentValue, american ? spot : 0)
    : Math.max(strikePresentValue, american ? strike : 0);
}

/**
 * Throw {@link PostconditionError} (`engine.result_out_of_bounds`) when a computed option value
 * violates `0 ≤ V ≤ ceiling`.
 */
export function assertNoArbitrageBounds(input: NoArbitrageBoundInput): void {
  const {
    engine,
    type,
    style,
    value,
    underlyingPresentValue,
    strikePresentValue,
    spot,
    strike,
    tolerance = 0,
  } = input;
  const american = style === 'american';
  const ceiling = noArbitrageCeiling(input);
  // Floating-point slack proportional to the scale of the bound, plus any caller-declared estimator
  // error. Deterministic engines sit far inside the bound, so this never masks a real violation.
  const slack = 1e-9 * Math.max(1, ceiling) + tolerance;
  if (value >= -slack && value <= ceiling + slack) return;
  const violated = value < 0 ? `0 ≤ value` : `value ≤ ${ceiling}`;
  throw new PostconditionError(
    `${engine}: the ${style} ${type} priced at ${value} violates the no-arbitrage bound ${violated} — ` +
      `a ${type} can never be worth ${type === 'call' ? 'more than the present value of the underlying it delivers' : 'more than the present value of the strike it receives'}` +
      `${american ? ' (or, for an American contract, its immediate-exercise value)' : ''}, nor less than zero. ` +
      'This is a TotalFinance defect rather than an input problem — the engine returned a number no market ' +
      'could quote. Please report it with these inputs.',
    {
      code: ErrorCode.EngineResultOutOfBounds,
      context: {
        engine,
        type,
        style,
        value,
        ceiling,
        underlyingPresentValue,
        strikePresentValue,
        spot,
        strike,
        tolerance,
      },
    },
  );
}
