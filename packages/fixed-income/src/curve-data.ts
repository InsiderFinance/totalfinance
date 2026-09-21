/**
 * Internal (not an entrypoint): a curve's DATA, and the exact restore (Stage 4.5 Decision 2).
 *
 * A `YieldCurve` / `SurvivalCurve` is a behavior object; an artifact stores its non-method
 * members verbatim ({@link YieldCurveData}, {@link SurvivalCurveData}) and restores the behavior.
 * Restore is exact BY CONSTRUCTION, not by tolerance: a yield curve's canonical state is its
 * continuous zeros at pillar times (every discount is `exp(−zero·tenor)` of them), and the stored
 * pillars carry exactly that state, so {@link yieldCurveFromData} rebuilds through the curve
 * module's own builder over the stored zeros — not through a public constructor, whose
 * zero ⇄ discount round trip moves the derived field by an ulp and, under zero-space
 * interpolation, every query between pillars with it. The one datum the pillars do not show —
 * whether `zeroRate(referenceDate)` echoes a quoted origin pillar or takes the first segment's
 * limit — travels as {@link YieldCurveData.zeroRateAtOrigin}. Stored pillars whose discount is
 * not `exp(−zero·tenor)` were edited and are refused. Survival curves rebuild through
 * `credit.survivalFromHazards`, whose piecewise-constant forward hazard IS the stored
 * `SurvivalPillar.hazard`.
 */

import {
  ErrorCode,
  InputError,
  ensureEnum,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import { credit, type SurvivalCurve, type SurvivalPillar } from './credit.js';
import { buildYieldCurveFromState, yieldCurveStateOf } from './curve-state.js';
import {
  type CurveExtrapolation,
  type CurveInterpolation,
  type CurvePillar,
  type YieldCurve,
} from './curves.js';
import type { FixedIncomeDayCount } from './conventions.js';

/**
 * How a curve answers `zeroRate(referenceDate)` when a pillar sits ON the reference date:
 * `'quoted'` echoes that pillar's zero (curves built from zero rates, whose t = 0 pillar is a
 * rate the caller supplied); `'limit'` takes the first segment's t → 0⁺ limit under the curve's
 * interpolation (bootstrapped and discount-factor curves, whose origin pillar is the `DF = 1`
 * anchor with a placeholder zero). The two build identical discount functions; the distinction
 * is stored so a restored curve answers exactly as the live one did.
 */
export type ZeroRateAtOrigin = 'quoted' | 'limit';

/** A `YieldCurve`'s own data — its non-method members plus {@link ZeroRateAtOrigin}. */
export interface YieldCurveData {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
  zeroRateAtOrigin: ZeroRateAtOrigin;
  pillars: CurvePillar[];
}

export const ZERO_RATE_AT_ORIGIN: readonly ZeroRateAtOrigin[] = ['quoted', 'limit'];

/** A `SurvivalCurve`'s own data — exactly its non-method members. */
export interface SurvivalCurveData {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  pillars: SurvivalPillar[];
}

export const CURVE_INTERPOLATIONS: readonly CurveInterpolation[] = [
  'logLinearDiscount',
  'linearZero',
  'linearDiscount',
  'cubicZero',
  'pchipZero',
];
export const CURVE_EXTRAPOLATIONS: readonly CurveExtrapolation[] = [
  'flatForward',
  'flatZero',
  'throw',
];
const DAY_COUNTS: readonly FixedIncomeDayCount[] = [
  'ACT/365F',
  'ACT/360',
  '30/360',
  'ACT/ACT',
  '30E/360',
];
const YIELD_CURVE_METHODS = [
  'timeTo',
  'discount',
  'zeroRate',
  'forwardRate',
  'instantaneousForward',
  'shift',
  'bumpPillar',
  'addSpread',
] as const;
const SURVIVAL_CURVE_METHODS = [
  'timeTo',
  'survival',
  'hazard',
  'defaultProbability',
  'conditionalDefaultProbability',
] as const;
const YIELD_PILLAR_KEYS = ['date', 'tenorYears', 'zero', 'discount'] as const;
const SURVIVAL_PILLAR_KEYS = [
  'date',
  'tenorYears',
  'cumulativeHazard',
  'survival',
  'hazard',
] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(
  functionName: string,
  field: string,
  message: string,
  code: ErrorCode = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function requireMethods(
  functionName: string,
  field: string,
  value: unknown,
  methods: readonly string[],
  teaching: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      functionName,
      field,
      `${teaching} Received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const method of methods) {
    if (typeof record[method] !== 'function') {
      fail(
        functionName,
        `${field}.${method}`,
        `${field}.${method} is ${record[method] === null ? 'null' : typeof record[method]}, not a method — ${teaching}`,
      );
    }
  }
  return record;
}

function requirePillars<K extends readonly string[]>(
  functionName: string,
  field: string,
  value: unknown,
  keys: K,
  numeric: readonly string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    fail(functionName, field, `${field} must be a non-empty pillar array.`);
  }
  value.forEach((pillar, index) => {
    const label = `${field}[${index}]`;
    requireArgumentObject(functionName, label, pillar);
    ensureKnownKeys(functionName, label, pillar as object, keys);
    const row = pillar as Record<string, unknown>;
    if (typeof row['date'] !== 'string' || !ISO_DATE.test(row['date'])) {
      fail(functionName, `${label}.date`, `${label}.date must be a 'YYYY-MM-DD' string.`);
    }
    for (const member of numeric) {
      if (typeof row[member] !== 'number' || !Number.isFinite(row[member])) {
        fail(functionName, `${label}.${member}`, `${label}.${member} must be a finite number.`);
      }
    }
  });
}

/** Prove a value is a COMPLETE built `YieldCurve`: every declared method, the conventions, well-formed pillars. */
export function requireBuiltYieldCurve(
  functionName: string,
  field: string,
  value: unknown,
): YieldCurve {
  const teaching = `${field} must be a built YieldCurve (from curves.fromZeroRates / fromDiscountFactors / bootstrap), not raw pillar data or a partial object.`;
  const record = requireMethods(functionName, field, value, YIELD_CURVE_METHODS, teaching);
  if (typeof record['referenceDate'] !== 'string' || !ISO_DATE.test(record['referenceDate'])) {
    fail(
      functionName,
      `${field}.referenceDate`,
      `${field}.referenceDate must be the curve's 'YYYY-MM-DD' reference date — ${teaching}`,
    );
  }
  ensureEnum(record['dayCount'], DAY_COUNTS, `${field}.dayCount`, functionName);
  ensureEnum(record['interpolation'], CURVE_INTERPOLATIONS, `${field}.interpolation`, functionName);
  ensureEnum(record['extrapolation'], CURVE_EXTRAPOLATIONS, `${field}.extrapolation`, functionName);
  requirePillars(functionName, `${field}.pillars`, record['pillars'], YIELD_PILLAR_KEYS, [
    'tenorYears',
    'zero',
    'discount',
  ]);
  return value as YieldCurve;
}

/** Prove a value is a COMPLETE built `SurvivalCurve`. */
export function requireBuiltSurvivalCurve(
  functionName: string,
  field: string,
  value: unknown,
): SurvivalCurve {
  const teaching = `${field} must be a built SurvivalCurve (from credit.survivalFromHazards / survivalFromProbabilities / bootstrapHazardFromCds), not raw pillar data or a partial object.`;
  const record = requireMethods(functionName, field, value, SURVIVAL_CURVE_METHODS, teaching);
  if (typeof record['referenceDate'] !== 'string' || !ISO_DATE.test(record['referenceDate'])) {
    fail(
      functionName,
      `${field}.referenceDate`,
      `${field}.referenceDate must be the curve's 'YYYY-MM-DD' reference date — ${teaching}`,
    );
  }
  ensureEnum(record['dayCount'], DAY_COUNTS, `${field}.dayCount`, functionName);
  requirePillars(functionName, `${field}.pillars`, record['pillars'], SURVIVAL_PILLAR_KEYS, [
    'tenorYears',
    'cumulativeHazard',
    'survival',
    'hazard',
  ]);
  return value as SurvivalCurve;
}

/** Validate STORED yield-curve data (closed keys, conventions, pillars). */
export function requireYieldCurveData(
  functionName: string,
  field: string,
  value: unknown,
): YieldCurveData {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, [
    'referenceDate',
    'dayCount',
    'interpolation',
    'extrapolation',
    'zeroRateAtOrigin',
    'pillars',
  ]);
  const record = value as Record<string, unknown>;
  if (typeof record['referenceDate'] !== 'string' || !ISO_DATE.test(record['referenceDate'])) {
    fail(
      functionName,
      `${field}.referenceDate`,
      `${field}.referenceDate must be a 'YYYY-MM-DD' string.`,
    );
  }
  ensureEnum(record['dayCount'], DAY_COUNTS, `${field}.dayCount`, functionName);
  ensureEnum(record['interpolation'], CURVE_INTERPOLATIONS, `${field}.interpolation`, functionName);
  ensureEnum(record['extrapolation'], CURVE_EXTRAPOLATIONS, `${field}.extrapolation`, functionName);
  ensureEnum(
    record['zeroRateAtOrigin'],
    ZERO_RATE_AT_ORIGIN,
    `${field}.zeroRateAtOrigin`,
    functionName,
  );
  requirePillars(functionName, `${field}.pillars`, record['pillars'], YIELD_PILLAR_KEYS, [
    'tenorYears',
    'zero',
    'discount',
  ]);
  return value as YieldCurveData;
}

/** Validate STORED survival-curve data. */
export function requireSurvivalCurveData(
  functionName: string,
  field: string,
  value: unknown,
): SurvivalCurveData {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, ['referenceDate', 'dayCount', 'pillars']);
  const record = value as Record<string, unknown>;
  if (typeof record['referenceDate'] !== 'string' || !ISO_DATE.test(record['referenceDate'])) {
    fail(
      functionName,
      `${field}.referenceDate`,
      `${field}.referenceDate must be a 'YYYY-MM-DD' string.`,
    );
  }
  ensureEnum(record['dayCount'], DAY_COUNTS, `${field}.dayCount`, functionName);
  requirePillars(functionName, `${field}.pillars`, record['pillars'], SURVIVAL_PILLAR_KEYS, [
    'tenorYears',
    'cumulativeHazard',
    'survival',
    'hazard',
  ]);
  return value as SurvivalCurveData;
}

/**
 * Which origin policy a live curve follows. Curves this package built carry it in their build
 * state; a structurally valid curve from another copy of the package is read off its behavior
 * (an origin pillar whose zero the curve echoes is a quoted one).
 */
function zeroRateAtOriginOf(curve: YieldCurve): ZeroRateAtOrigin {
  const state = yieldCurveStateOf(curve);
  if (state !== undefined) return state.originZeroKnown === true ? 'quoted' : 'limit';
  const origin = curve.pillars[0];
  if (origin === undefined || origin.tenorYears !== 0) return 'limit';
  return curve.zeroRate(curve.referenceDate) === origin.zero ? 'quoted' : 'limit';
}

/** A live yield curve's data, copied. */
export function yieldCurveDataOf(curve: YieldCurve): YieldCurveData {
  return {
    referenceDate: curve.referenceDate,
    dayCount: curve.dayCount,
    interpolation: curve.interpolation,
    extrapolation: curve.extrapolation,
    zeroRateAtOrigin: zeroRateAtOriginOf(curve),
    pillars: curve.pillars.map((pillar) => ({
      date: pillar.date,
      tenorYears: pillar.tenorYears,
      zero: pillar.zero,
      discount: pillar.discount,
    })),
  };
}

/** A live survival curve's data, copied. */
export function survivalCurveDataOf(curve: SurvivalCurve): SurvivalCurveData {
  return {
    referenceDate: curve.referenceDate,
    dayCount: curve.dayCount,
    pillars: curve.pillars.map((pillar) => ({
      date: pillar.date,
      tenorYears: pillar.tenorYears,
      cumulativeHazard: pillar.cumulativeHazard,
      survival: pillar.survival,
      hazard: pillar.hazard,
    })),
  };
}

/**
 * Restore a yield curve EXACTLY from its stored data: the stored zeros and tenors ARE the curve
 * module's canonical state, so the rebuilt curve's pillars — and every query between them — are
 * bit for bit the live curve's. Stored data whose discounts are not `exp(−zero·tenor)` of its
 * zeros was edited after it was written and is refused: a curve can be approximated from such
 * pillars, but not restored.
 */
export function yieldCurveFromData(
  functionName: string,
  field: string,
  data: YieldCurveData,
): YieldCurve {
  const curve = buildYieldCurveFromState({
    referenceDate: data.referenceDate,
    dayCount: data.dayCount,
    interpolation: data.interpolation,
    extrapolation: data.extrapolation,
    ts: data.pillars.map((pillar) => pillar.tenorYears),
    zeros: data.pillars.map((pillar) => pillar.zero),
    dates: data.pillars.map((pillar) => pillar.date),
    originZeroKnown: data.zeroRateAtOrigin === 'quoted',
  });
  const edited = curve.pillars.findIndex(
    (pillar, index) => pillar.discount !== data.pillars[index]!.discount,
  );
  if (edited !== -1) {
    const stored = data.pillars[edited]!;
    fail(
      functionName,
      `${field}.pillars[${edited}].discount`,
      `${field}.pillars[${edited}] stores discount ${stored.discount}, but its zero ${stored.zero} over ${stored.tenorYears} years implies ${curve.pillars[edited]!.discount} — the stored pillars were edited after the curve wrote them, so the curve cannot be restored (rebuild it from the intended quotes with curves.fromZeroRates / curves.fromDiscountFactors instead).`,
      ErrorCode.InputWrongShape,
    );
  }
  return curve;
}

/** Restore a live `SurvivalCurve` from stored data through the public constructor. */
export function survivalCurveFromData(data: SurvivalCurveData): SurvivalCurve {
  return credit.survivalFromHazards(
    data.pillars.map((pillar) => [pillar.date, pillar.hazard] as const),
    { referenceDate: data.referenceDate, dayCount: data.dayCount },
  );
}
