/**
 * The two direct curve mappers between a live {@link YieldCurve} (a behavior object) and core's
 * `RateCurve` DATA contract (Stage 4.5 Decision 2 — the fixed-income half of Gate B's "domain
 * mappers" box):
 *
 * - {@link yieldCurveFromRateCurve} — stored zero-rate pillars → a live curve. This is the bond
 *   pricer's former private `buildDiscountCurve` made public and unchanged in behavior: the curve's
 *   `asOf` must be UTC midnight (fixed-income curves are date-anchored), the pillars are quoted in
 *   the curve's own `dayCount` / `compounding`, and a stored `interpolation` that conflicts with the
 *   requested one is refused. The pricer calls this function — one engine.
 * - {@link rateCurveFromYieldCurve} — a live curve → core `RateCurve` data that drops into
 *   `MarketSnapshot.observations.curves` and `bondDiscountCurvePricer`. `asOf` is the reference
 *   date at UTC midnight, `compounding` is `'continuous'` (a `CurvePillar.zero` IS continuous —
 *   no option, no default), every pillar including the reference-date anchor is emitted, and the
 *   curve's interpolation is echoed. A curve whose day count core's `RateCurve` cannot state
 *   (`ACT/ACT`, `30E/360`) refuses with the teaching — widening core's day-count set is a core
 *   market-data decision, not this mapper's.
 *
 * Both are closed single-object requests; the mapped data is proven through core's ONE
 * `requireRateCurveData` validator, never a second one.
 */

import {
  ErrorCode,
  InputError,
  ensureEnum,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentObject,
  requireRateCurveData,
  type RateCurve,
} from '@totalfinance/core';
import {
  curves,
  type CurveExtrapolation,
  type CurveInterpolation,
  type YieldCurve,
} from './curves.js';
import {
  CURVE_EXTRAPOLATIONS,
  CURVE_INTERPOLATIONS,
  requireBuiltYieldCurve,
} from './curve-data.js';

/** The day counts core's `RateCurve` can state — the mapper refuses the fixed-income-only ones by name. */
const RATE_CURVE_DAY_COUNTS = ['ACT/365F', 'ACT/360', '30/360'] as const;

/** The UTC calendar date of a midnight-anchored epoch instant, or the teaching refusal. */
export function utcReferenceDateOf(curve: RateCurve, functionName: string, field: string): string {
  let instant: Date;
  try {
    instant = new Date(curve.asOf);
    if (!Number.isFinite(instant.getTime())) throw new RangeError('invalid date');
  } catch (cause) {
    throw new InputError(`${functionName}: ${field}.asOf must be a valid epoch millisecond.`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field: `${field}.asOf` },
      cause,
    });
  }
  const iso = instant.toISOString();
  if (!iso.endsWith('T00:00:00.000Z')) {
    throw new InputError(
      `${functionName}: ${field}.asOf must be UTC midnight because fixed-income curves use a date-valued reference point. Received ${iso}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${field}.asOf`, asOf: curve.asOf },
      },
    );
  }
  return iso.slice(0, 10);
}

/**
 * Build a live {@link YieldCurve} from core `RateCurve` data (module header).
 *
 * @example
 * ```ts
 * const curve = yieldCurveFromRateCurve({
 *   curve: snapshot.observations.curves['USD.treasury'],
 *   interpolation: 'logLinearDiscount',
 *   extrapolation: 'flatForward',
 * });
 * curve.discount('2028-06-30');
 * ```
 */
export function yieldCurveFromRateCurve(input: {
  curve: RateCurve;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
}): YieldCurve {
  const functionName = 'yieldCurveFromRateCurve';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['curve', 'interpolation', 'extrapolation']);
  ensureEnum(input.interpolation, CURVE_INTERPOLATIONS, 'interpolation', functionName);
  ensureEnum(input.extrapolation, CURVE_EXTRAPOLATIONS, 'extrapolation', functionName);
  const observed = requireRateCurveData(functionName, 'input.curve', input.curve);
  if (observed.interpolation !== undefined && observed.interpolation !== input.interpolation) {
    throw new InputError(
      `${functionName}: input.curve.interpolation ${JSON.stringify(observed.interpolation)} conflicts with the requested ${JSON.stringify(input.interpolation)} policy — a stored curve states its own interpolation; request the same one or drop the stored field.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: {
          function: functionName,
          observedInterpolation: observed.interpolation,
          requestedInterpolation: input.interpolation,
        },
      },
    );
  }
  const referenceDate = utcReferenceDateOf(observed, functionName, 'input.curve');
  return curves.fromZeroRates(
    observed.points.map((point) => [point.date, point.zeroRate] as const),
    {
      referenceDate,
      dayCount: observed.dayCount,
      compounding: observed.compounding,
      interpolation: input.interpolation,
      extrapolation: input.extrapolation,
    },
  );
}

/**
 * Project a live {@link YieldCurve} to core `RateCurve` data (module header).
 *
 * @example
 * ```ts
 * const data = rateCurveFromYieldCurve({ curve: curves.bootstrap(instruments, options), currency: 'USD' });
 * createMarketSnapshot({ asOf, observations: { curves: { 'USD.ois': data } } });
 * ```
 */
export function rateCurveFromYieldCurve(input: { curve: YieldCurve; currency: string }): RateCurve {
  const functionName = 'rateCurveFromYieldCurve';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['curve', 'currency']);
  const curve = requireBuiltYieldCurve(functionName, 'input.curve', input.curve);
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new InputError(
      `${functionName}: input.currency must be the curve's currency code (e.g. 'USD') — a stored curve without a currency is a number without a unit.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'input.currency' },
      },
    );
  }
  if (!(RATE_CURVE_DAY_COUNTS as readonly string[]).includes(curve.dayCount)) {
    throw new InputError(
      `${functionName}: the curve's day count ${JSON.stringify(curve.dayCount)} cannot be stated by core's RateCurve, which accepts ${RATE_CURVE_DAY_COUNTS.join(', ')} — rebuild the curve under one of those day counts to store it as market data.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: {
          function: functionName,
          field: 'input.curve.dayCount',
          dayCount: curve.dayCount,
        },
      },
    );
  }
  const data: RateCurve = {
    currency: input.currency,
    asOf: isoDateToEpochMs(curve.referenceDate),
    dayCount: curve.dayCount as RateCurve['dayCount'],
    compounding: 'continuous',
    points: curve.pillars.map((pillar) => ({ date: pillar.date, zeroRate: pillar.zero })),
    interpolation: curve.interpolation,
  };
  // The mapped data is proven through core's ONE validator before it leaves this door.
  return requireRateCurveData(functionName, 'curve', data);
}
