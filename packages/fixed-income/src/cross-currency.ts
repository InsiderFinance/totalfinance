/**
 * Cross-currency basis (spec §14.5): covered-interest-parity FX forwards and the domestic-collateralized
 * foreign discount curve. Post-2008, a foreign cash flow collateralized in the domestic currency is
 * discounted on a basis-adjusted foreign curve, not the foreign's own OIS — the gap is the cross-currency
 * basis. Everything here is pure curve arithmetic (no FX data feed): it composes the OIS/projection curves
 * from `curves.bootstrapMultiCurve` with the `YieldCurve.addSpread` combination.
 *
 * FX convention throughout: `spot` and forwards are DOMESTIC units per 1 FOREIGN unit (e.g. USD per EUR
 * with domestic = USD, foreign = EUR).
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { YieldCurve } from './curves.js';

function requireCurve(
  value: unknown,
  functionName: string,
  field: string,
): asserts value is YieldCurve {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { discount?: unknown }).discount !== 'function'
  ) {
    throw new InputError(
      `${functionName}: ${field} must be a yield curve built by curves.* (a curve with discount()/zeroRate()), not a raw object.`,
      { code: ErrorCode.InputWrongType, context: { field } },
    );
  }
}

function requireSameReference(
  functionName: string,
  domestic: YieldCurve,
  other: YieldCurve,
  field: string,
): void {
  if (domestic.referenceDate !== other.referenceDate) {
    throw new InputError(
      `${functionName}: ${field}.referenceDate (${other.referenceDate}) must match the domestic curve's (${domestic.referenceDate}).`,
      { code: ErrorCode.InputWrongShape, context: { field } },
    );
  }
}

export interface CrossCurrencyBasisInput {
  /** FX spot: domestic units per 1 foreign unit. */
  spot: number;
  /** Domestic collateral (OIS) discount curve. */
  domestic: YieldCurve;
  /** Foreign index/OIS discount curve (pre-basis). */
  foreign: YieldCurve;
  /**
   * Cross-currency basis term structure added to the foreign curve (its zero rates ARE the basis
   * spreads). Omit for the pure covered-interest-parity case (no basis): `fxForward` is then
   * `spot · D_for(t)/D_dom(t)` and the collateralized curve is the foreign curve itself.
   */
  basis?: YieldCurve;
}
const CROSS_CURRENCY_BASIS_KEYS = ['spot', 'domestic', 'foreign', 'basis'] as const;

export interface CrossCurrencyBasisResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** The domestic-collateralized foreign discount curve (`foreign + basis`). Discount foreign cash flows on THIS. */
  collateralizedCurve: YieldCurve;
  /** Market FX forward at `at`, from the collateralized curve: `spot · D_for^dom(at) / D_dom(at)`. */
  fxForward(at: string | number): number;
}

/**
 * Build the domestic-collateralized foreign discount curve (spec §14.5): the foreign OIS curve plus the
 * cross-currency basis, `D_for^dom = foreign.addSpread(basis)`. This is the curve on which to discount
 * foreign cash flows collateralized in the domestic currency, and it reprices the FX forwards the xccy
 * basis market quotes: `F(0,t) = spot · D_for^dom(t) / D_dom(t)`.
 */
export function crossCurrencyBasisCurve(input: CrossCurrencyBasisInput): CrossCurrencyBasisResult {
  requireArgumentObject('crossCurrencyBasisCurve', 'input', input);
  ensureKnownKeys('crossCurrencyBasisCurve', 'input', input, CROSS_CURRENCY_BASIS_KEYS);
  requireCurve(input.domestic, 'crossCurrencyBasisCurve', 'domestic');
  requireCurve(input.foreign, 'crossCurrencyBasisCurve', 'foreign');
  requireSameReference('crossCurrencyBasisCurve', input.domestic, input.foreign, 'foreign');
  if (input.basis !== undefined) {
    requireCurve(input.basis, 'crossCurrencyBasisCurve', 'basis');
    requireSameReference('crossCurrencyBasisCurve', input.domestic, input.basis, 'basis');
  }
  ensurePositive(input.spot, 'spot', 'crossCurrencyBasisCurve');
  const collateralizedCurve = input.basis ? input.foreign.addSpread(input.basis) : input.foreign;
  return {
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      spot: input.spot,
      discounting: 'domestic-collateralized',
      fxConvention: 'domestic-per-foreign',
    },
    diagnostics: { warnings: [] },
    collateralizedCurve,
    fxForward: (at) =>
      (input.spot * collateralizedCurve.discount(at)) / input.domestic.discount(at),
  };
}

export interface ImpliedCrossCurrencyBasisInput {
  /** FX spot: domestic units per 1 foreign unit. */
  spot: number;
  /** Domestic collateral (OIS) discount curve. */
  domestic: YieldCurve;
  /** Foreign index/OIS discount curve (pre-basis). */
  foreign: YieldCurve;
  /** Observed market FX forwards `[date, forward]` (domestic per foreign). */
  forwards: [string, number][];
}
const IMPLIED_BASIS_KEYS = ['spot', 'domestic', 'foreign', 'forwards'] as const;

export interface ImpliedCrossCurrencyBasisResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Implied continuous cross-currency basis spread at each forward date (collateralized zero − foreign zero). */
  basis: { date: string; spread: number }[];
}

/**
 * Invert market FX forwards to the cross-currency basis (spec §14.5) — the inverse of
 * {@link crossCurrencyBasisCurve}. From `F(0,t) = spot · D_for^dom(t)/D_dom(t)`, the collateralized foreign
 * discount factor is `D_for^dom(t) = F(0,t)·D_dom(t)/spot`, and the implied basis is its continuous zero
 * minus the foreign curve's own zero.
 */
export function impliedCrossCurrencyBasis(
  input: ImpliedCrossCurrencyBasisInput,
): ImpliedCrossCurrencyBasisResult {
  requireArgumentObject('impliedCrossCurrencyBasis', 'input', input);
  ensureKnownKeys('impliedCrossCurrencyBasis', 'input', input, IMPLIED_BASIS_KEYS);
  requireCurve(input.domestic, 'impliedCrossCurrencyBasis', 'domestic');
  requireCurve(input.foreign, 'impliedCrossCurrencyBasis', 'foreign');
  requireSameReference('impliedCrossCurrencyBasis', input.domestic, input.foreign, 'foreign');
  ensurePositive(input.spot, 'spot', 'impliedCrossCurrencyBasis');
  requireArgumentArray('impliedCrossCurrencyBasis', 'input.forwards', input.forwards);
  const basis = input.forwards.map(([date, fwd]) => {
    ensurePositive(fwd, `forwards[${date}]`, 'impliedCrossCurrencyBasis');
    const t = input.domestic.timeTo(date);
    if (!(t > 0)) {
      throw new InputError(
        `impliedCrossCurrencyBasis: forward date ${date} is not after the curve reference date.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { date, referenceDate: input.domestic.referenceDate },
        },
      );
    }
    const collateralizedDf = (fwd * input.domestic.discount(date)) / input.spot;
    const collateralizedZero = -Math.log(collateralizedDf) / t;
    return { date, spread: collateralizedZero - input.foreign.zeroRate(date) };
  });
  return {
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      spot: input.spot,
      fxConvention: 'domestic-per-foreign',
    },
    diagnostics: { warnings: [] },
    basis,
  };
}
