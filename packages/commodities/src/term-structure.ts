/**
 * FC6 — commodity term structure: curve state classification, calendar/curve spreads, roll
 * analytics, seasonality, and the explicit unit-conversion law. Everything computes over
 * caller-supplied curves and history; no seasonality is invented, no conversion factor is
 * guessed, and every classification discloses the tolerance and the reasoning that produced it.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  parseIsoDate,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { median } from '@totalfinance/math';

/**
 * Mean that survives near-`Number.MAX_VALUE` inputs. The naive sum is used whenever it is finite
 * (bit-for-bit compatibility for every ordinary series); on overflow the summation is re-run with
 * every value divided by the largest magnitude first, so the mean of `[1e308, 1e308]` is `1e308`
 * and the mean of `[1e308, -1e308]` is `0`. The first repair here (Welford) still overflowed in
 * its `x − m` delta for opposite-sign near-MAX pairs — the third review's counterexample.
 */
function stableMean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  const naive = total / values.length;
  if (Number.isFinite(naive)) return naive;
  let maxAbs = 0;
  for (const value of values) maxAbs = Math.max(maxAbs, Math.abs(value));
  if (maxAbs === 0) return 0;
  let scaled = 0;
  for (const value of values) scaled += value / maxAbs;
  return maxAbs * (scaled / values.length);
}

// ---------------------------------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------------------------------

/** One point on a commodity forward curve. */
export interface CommodityCurvePoint {
  /** Time to delivery in years, ≥ 0; strictly ascending across a curve. */
  timeToDeliveryYears: number;
  /** The forward (or futures) price at that delivery, > 0. */
  forwardPrice: number;
}

function requireCurvePoint(
  functionName: string,
  label: string,
  point: unknown,
): asserts point is CommodityCurvePoint {
  requireArgumentObject(functionName, label, point);
  ensureKnownKeys(functionName, label, point as object, ['timeToDeliveryYears', 'forwardPrice']);
  requireFiniteFields(functionName, point, ['timeToDeliveryYears', 'forwardPrice'], {
    exampleCall: `${functionName}({ ..., ${label}: { timeToDeliveryYears: 0.25, forwardPrice: 72.4 } })`,
    path: label,
  });
  const typed = point as CommodityCurvePoint;
  if (typed.timeToDeliveryYears < 0) {
    throw new InputError(
      `${functionName}: ${label}.timeToDeliveryYears must be ≥ 0 — delivery cannot precede the valuation instant. Received ${typed.timeToDeliveryYears}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: `${label}.timeToDeliveryYears` } },
    );
  }
  if (typed.forwardPrice <= 0) {
    throw new InputError(
      `${functionName}: ${label}.forwardPrice must be > 0 — a non-positive forward has no term structure. Received ${typed.forwardPrice}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: `${label}.forwardPrice` } },
    );
  }
}

/**
 * Validate a commodity forward curve: an array of ≥ 2 points, each with `timeToDeliveryYears ≥ 0`
 * and `forwardPrice > 0`, times STRICTLY ascending — the failing index is named in the error.
 */
function requireCommodityCurve(
  functionName: string,
  label: string,
  curve: unknown,
): asserts curve is readonly CommodityCurvePoint[] {
  if (!Array.isArray(curve) || curve.length < 2) {
    throw new InputError(
      `${functionName}: ${label} must be an array of at least 2 { timeToDeliveryYears, forwardPrice } points — a single point has no slope to classify. Received ${Array.isArray(curve) ? `${curve.length} point(s)` : curve === null ? 'null' : typeof curve}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: label } },
    );
  }
  curve.forEach((point, index) => {
    requireCurvePoint(functionName, `${label}[${index}]`, point);
  });
  for (let index = 1; index < curve.length; index++) {
    const previous = (curve[index - 1] as CommodityCurvePoint).timeToDeliveryYears;
    const current = (curve[index] as CommodityCurvePoint).timeToDeliveryYears;
    if (current <= previous) {
      throw new InputError(
        `${functionName}: ${label}[${index}].timeToDeliveryYears (${current}) must be strictly greater than ${label}[${index - 1}].timeToDeliveryYears (${previous}) — a curve is indexed by strictly ascending delivery times.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `${label}[${index}].timeToDeliveryYears` },
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Term-structure state
// ---------------------------------------------------------------------------------------------------

/** The four disclosed term-structure states. */
export type TermStructureState = 'contango' | 'backwardation' | 'flat' | 'indeterminate';

/** Input for {@link termStructureState}. */
export interface TermStructureStateInput {
  /** The forward curve — ≥ 2 points, strictly ascending delivery times. */
  curve: readonly CommodityCurvePoint[];
  /**
   * REQUIRED explicit tolerance (e.g. `0.001`): a pairwise price change with
   * `|forwardPrice[i+1] / forwardPrice[i] − 1| ≤ flatToleranceFraction` counts as flat. No
   * default — how much wiggle is "flat" is a judgment the caller must state.
   */
  flatToleranceFraction: number;
}

/** Result of {@link termStructureState}. */
export interface TermStructureStateResult {
  state: TermStructureState;
  assumptions: {
    flatToleranceFraction: number;
    /** The fixed classification prose: pairwise slopes against the tolerance, mixes disclosed. */
    definition: string;
  };
  diagnostics: {
    warnings: string[];
    risingSegmentCount: number;
    fallingSegmentCount: number;
    flatSegmentCount: number;
  };
}

/**
 * Classify a forward curve's term structure with the reasoning disclosed. Each adjacent pair is a
 * segment with fractional slope `far / near − 1`; segments beyond `+flatToleranceFraction` rise,
 * beyond `−flatToleranceFraction` fall, and within the tolerance are flat. ALL rising → `'contango'`;
 * ALL falling → `'backwardation'`; ALL flat → `'flat'`; any other mix → `'indeterminate'`, with the
 * mixed segments named in the diagnostics rather than averaged away. The classification is a pure
 * function of the curve and the tolerance — the same wiggly curve legitimately reads `'flat'` under
 * a loose tolerance and `'indeterminate'` under a tight one.
 */
export function termStructureState(input: TermStructureStateInput): TermStructureStateResult {
  requireArgumentObject('termStructureState', 'input', input);
  ensureKnownKeys('termStructureState', 'input', input, ['curve', 'flatToleranceFraction']);
  requireFiniteFields(
    'termStructureState',
    input as unknown as Record<string, unknown>,
    ['flatToleranceFraction'],
    {
      exampleCall:
        'termStructureState({ curve: [{ timeToDeliveryYears: 0.25, forwardPrice: 72.4 }, { timeToDeliveryYears: 0.5, forwardPrice: 73.1 }], flatToleranceFraction: 0.001 })',
    },
  );
  if (input.flatToleranceFraction < 0) {
    throw new InputError(
      `termStructureState: flatToleranceFraction must be ≥ 0. Received ${input.flatToleranceFraction}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'flatToleranceFraction' } },
    );
  }
  requireCommodityCurve('termStructureState', 'curve', input.curve);
  const tolerance = input.flatToleranceFraction;
  const risingSegments: number[] = [];
  const fallingSegments: number[] = [];
  const flatSegments: number[] = [];
  for (let index = 1; index < input.curve.length; index++) {
    const near = input.curve[index - 1]!;
    const far = input.curve[index]!;
    const slopeFraction = far.forwardPrice / near.forwardPrice - 1;
    if (slopeFraction > tolerance) risingSegments.push(index - 1);
    else if (slopeFraction < -tolerance) fallingSegments.push(index - 1);
    else flatSegments.push(index - 1);
  }
  const segmentCount = input.curve.length - 1;
  let state: TermStructureState;
  const warnings: string[] = [];
  if (risingSegments.length === segmentCount) state = 'contango';
  else if (fallingSegments.length === segmentCount) state = 'backwardation';
  else if (flatSegments.length === segmentCount) state = 'flat';
  else {
    state = 'indeterminate';
    const describe = (indices: number[]): string =>
      indices
        .map(
          (segment) =>
            `${input.curve[segment]!.timeToDeliveryYears}y→${input.curve[segment + 1]!.timeToDeliveryYears}y`,
        )
        .join(', ');
    warnings.push(
      `indeterminate: the curve mixes segment directions beyond/within the ±${tolerance} tolerance — rising [${describe(risingSegments)}], falling [${describe(fallingSegments)}], flat [${describe(flatSegments)}]. No single state describes it, and none is invented.`,
    );
  }
  return {
    state,
    assumptions: {
      flatToleranceFraction: tolerance,
      definition:
        'pairwise fractional slopes forwardPrice[i+1] / forwardPrice[i] − 1: ALL beyond +tolerance → contango; ALL beyond −tolerance → backwardation; ALL within ±tolerance → flat; any other mix → indeterminate, with the mixed segments named',
    },
    diagnostics: {
      warnings,
      risingSegmentCount: risingSegments.length,
      fallingSegmentCount: fallingSegments.length,
      flatSegmentCount: flatSegments.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Calendar and curve spreads
// ---------------------------------------------------------------------------------------------------

/** Input for {@link calendarSpread}. */
export interface CalendarSpreadInput {
  /** The nearer delivery — `nearPoint.timeToDeliveryYears < farPoint.timeToDeliveryYears`. */
  nearPoint: CommodityCurvePoint;
  /** The farther delivery. */
  farPoint: CommodityCurvePoint;
}

/** Result of {@link calendarSpread}. */
export interface CalendarSpreadResult {
  /** `farPoint.forwardPrice − nearPoint.forwardPrice` (price units). */
  spread: number;
  /**
   * The CONTINUOUS carry between the two deliveries:
   * `ln(farPoint.forwardPrice / nearPoint.forwardPrice) / (farTime − nearTime)`.
   */
  annualizedSpreadRate: number;
  assumptions: {
    /** The fixed convention prose: continuous carry between the two deliveries. */
    annualizedSpreadRateConvention: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * The calendar spread between two deliveries: the price spread `far − near`, and the annualized
 * continuous carry the pair implies. Near must genuinely be nearer — a reversed pair is refused
 * rather than silently sign-flipped.
 */
export function calendarSpread(input: CalendarSpreadInput): CalendarSpreadResult {
  requireArgumentObject('calendarSpread', 'input', input);
  ensureKnownKeys('calendarSpread', 'input', input, ['nearPoint', 'farPoint']);
  requireCurvePoint('calendarSpread', 'nearPoint', input.nearPoint);
  requireCurvePoint('calendarSpread', 'farPoint', input.farPoint);
  if (input.nearPoint.timeToDeliveryYears >= input.farPoint.timeToDeliveryYears) {
    throw new InputError(
      `calendarSpread: nearPoint.timeToDeliveryYears (${input.nearPoint.timeToDeliveryYears}) must be strictly less than farPoint.timeToDeliveryYears (${input.farPoint.timeToDeliveryYears}) — swap the points rather than relying on a silent sign flip.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'nearPoint.timeToDeliveryYears' } },
    );
  }
  return requireRepresentableResult('calendarSpread', {
    spread: input.farPoint.forwardPrice - input.nearPoint.forwardPrice,
    annualizedSpreadRate:
      Math.log(input.farPoint.forwardPrice / input.nearPoint.forwardPrice) /
      (input.farPoint.timeToDeliveryYears - input.nearPoint.timeToDeliveryYears),
    assumptions: {
      annualizedSpreadRateConvention:
        'continuous compounding: ln(farPoint.forwardPrice / nearPoint.forwardPrice) / (farPoint.timeToDeliveryYears − nearPoint.timeToDeliveryYears)',
    },
    diagnostics: { warnings: [] },
  });
}

/** One adjacent-pair (or front-to-back) spread row. */
export interface CurveSpreadRow {
  fromTimeYears: number;
  toTimeYears: number;
  /** `forwardPrice(to) − forwardPrice(from)` (price units). */
  spread: number;
  /** Continuous carry between the two deliveries: `ln(to / from) / (toTime − fromTime)`. */
  annualizedSpreadRate: number;
}

/** Input for {@link curveSpreadAnalytics}. */
export interface CurveSpreadAnalyticsInput {
  /** The forward curve — ≥ 2 points, strictly ascending delivery times. */
  curve: readonly CommodityCurvePoint[];
}

/** Result of {@link curveSpreadAnalytics}. */
export interface CurveSpreadAnalyticsResult {
  /** One row per adjacent pair, in curve order. */
  adjacentSpreads: CurveSpreadRow[];
  /** The overall figures from the first delivery to the last. */
  frontToBack: CurveSpreadRow;
  assumptions: {
    /** The fixed convention prose: continuous carry per row. */
    annualizedSpreadRateConvention: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * Spread analytics across a whole curve: one {@link CurveSpreadRow} per adjacent pair plus the
 * overall front-to-back row, every rate under the disclosed continuous convention. Linear in the
 * pillar count.
 */
export function curveSpreadAnalytics(input: CurveSpreadAnalyticsInput): CurveSpreadAnalyticsResult {
  requireArgumentObject('curveSpreadAnalytics', 'input', input);
  ensureKnownKeys('curveSpreadAnalytics', 'input', input, ['curve']);
  requireCommodityCurve('curveSpreadAnalytics', 'curve', input.curve);
  const rowBetween = (near: CommodityCurvePoint, far: CommodityCurvePoint): CurveSpreadRow => ({
    fromTimeYears: near.timeToDeliveryYears,
    toTimeYears: far.timeToDeliveryYears,
    spread: far.forwardPrice - near.forwardPrice,
    annualizedSpreadRate:
      Math.log(far.forwardPrice / near.forwardPrice) /
      (far.timeToDeliveryYears - near.timeToDeliveryYears),
  });
  const adjacentSpreads: CurveSpreadRow[] = [];
  for (let index = 1; index < input.curve.length; index++) {
    adjacentSpreads.push(rowBetween(input.curve[index - 1]!, input.curve[index]!));
  }
  return requireRepresentableResult('curveSpreadAnalytics', {
    adjacentSpreads,
    frontToBack: rowBetween(input.curve[0]!, input.curve[input.curve.length - 1]!),
    assumptions: {
      annualizedSpreadRateConvention:
        'continuous compounding per row: ln(forwardPrice(to) / forwardPrice(from)) / (toTimeYears − fromTimeYears)',
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Roll yield and roll-return decomposition
// ---------------------------------------------------------------------------------------------------

/** Input for {@link rollYield}. */
export interface RollYieldInput {
  /** Price of the contract being rolled OUT of (the expiring one), > 0. */
  expiringContractPrice: number;
  /** Price of the contract being rolled INTO (the next one), > 0. */
  nextContractPrice: number;
  /**
   * The spot price at the roll instant, > 0 — supplied only when observed. Without it the
   * spot-relative decomposition is ABSENT with its reason, never guessed.
   */
  spotPriceAtRoll?: number;
}

/** Result of {@link rollYield}. */
export interface RollYieldResult {
  /**
   * `(expiringContractPrice − nextContractPrice) / nextContractPrice` — the yield a long roller
   * locks in for the next holding period under a static curve. SIGN LAW: positive in
   * backwardation (next below expiring), negative in contango.
   */
  rollYieldFraction: number;
  /**
   * Spot-relative decomposition, present exactly when `spotPriceAtRoll` was supplied. The two
   * components COMPOUND (they do not sum): with `e = expiringVersusSpotFraction` and
   * `n = nextVersusSpotFraction`, `(1 + rollYieldFraction) = (1 + e) / (1 + n)` EXACTLY — an
   * algebraic identity, since `(E/S) / (N/S) = E/N`.
   */
  decomposition?: {
    /**
     * `(expiringContractPrice − spotPriceAtRoll) / spotPriceAtRoll` — the expiring contract's
     * residual basis to spot (near zero when rolled at expiry; the carry already converged).
     */
    expiringVersusSpotFraction: number;
    /**
     * `(nextContractPrice − spotPriceAtRoll) / spotPriceAtRoll` — the curve slope out to the next
     * contract; NEGATIVE in backwardation, which is exactly where positive roll yield comes from.
     */
    nextVersusSpotFraction: number;
  };
  /** Present exactly when the decomposition is absent — the reason, never a guessed spot. */
  decompositionAbsentReason?: string;
  assumptions: {
    /** The fixed direction prose: a long roller out of the expiring contract into the next. */
    rollDirection: string;
    /** The fixed sign-law prose: positive in backwardation, negative in contango. */
    signLaw: string;
    /** The fixed decomposition prose: the spot-relative components compound exactly. */
    decompositionConvention: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * The roll yield when rolling a LONG position from the expiring contract into the next:
 * `(expiring − next) / next`. Positive in backwardation — the next contract is bought below the
 * expiring one and converges upward under a static curve; negative in contango.
 *
 * When `spotPriceAtRoll` is supplied the result also decomposes both legs against spot; the
 * components compound exactly back to the roll yield (see {@link RollYieldResult.decomposition}).
 * When spot is absent the decomposition is absent WITH its reason — it is never inferred from the
 * contract prices.
 */
export function rollYield(input: RollYieldInput): RollYieldResult {
  requireArgumentObject('rollYield', 'input', input);
  ensureKnownKeys('rollYield', 'input', input, [
    'expiringContractPrice',
    'nextContractPrice',
    'spotPriceAtRoll',
  ]);
  requireFiniteFields(
    'rollYield',
    input as unknown as Record<string, unknown>,
    ['expiringContractPrice', 'nextContractPrice'],
    {
      exampleCall:
        'rollYield({ expiringContractPrice: 74.2, nextContractPrice: 72.9, spotPriceAtRoll: 74.5 })',
    },
  );
  if (input.expiringContractPrice <= 0 || input.nextContractPrice <= 0) {
    const field = input.expiringContractPrice <= 0 ? 'expiringContractPrice' : 'nextContractPrice';
    throw new InputError(
      `rollYield: ${field} must be > 0 — roll yield is a ratio of positive contract prices. Received ${input[field]}.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
  if (
    input.spotPriceAtRoll !== undefined &&
    (typeof input.spotPriceAtRoll !== 'number' ||
      !Number.isFinite(input.spotPriceAtRoll) ||
      input.spotPriceAtRoll <= 0)
  ) {
    throw new InputError(
      `rollYield: spotPriceAtRoll must be a finite number > 0 when provided. Received ${input.spotPriceAtRoll === null ? 'null' : String(input.spotPriceAtRoll)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'spotPriceAtRoll' } },
    );
  }
  const rollYieldFraction =
    (input.expiringContractPrice - input.nextContractPrice) / input.nextContractPrice;
  const result: RollYieldResult = {
    rollYieldFraction,
    assumptions: {
      rollDirection: 'a long position rolling out of the expiring contract into the next contract',
      signLaw:
        'positive in backwardation (nextContractPrice < expiringContractPrice), negative in contango',
      decompositionConvention:
        'spot-relative components compound: (1 + rollYieldFraction) = (1 + expiringVersusSpotFraction) / (1 + nextVersusSpotFraction), exactly',
    },
    diagnostics: { warnings: [] },
  };
  if (input.spotPriceAtRoll !== undefined) {
    result.decomposition = {
      expiringVersusSpotFraction:
        (input.expiringContractPrice - input.spotPriceAtRoll) / input.spotPriceAtRoll,
      nextVersusSpotFraction:
        (input.nextContractPrice - input.spotPriceAtRoll) / input.spotPriceAtRoll,
    };
  } else {
    result.decompositionAbsentReason =
      'spotPriceAtRoll was not supplied; the spot-relative decomposition needs the observed spot at the roll instant and is never guessed from the contract prices.';
  }
  return requireRepresentableResult('rollYield', result);
}

/** Input for {@link rollReturnDecomposition}. */
export interface RollReturnDecompositionInput {
  /** Spot price at the start of the holding period, > 0. */
  initialSpotPrice: number;
  /** Spot price at the end of the holding period (the roll instant), > 0. */
  finalSpotPrice: number;
  /** Price of the held contract at the start of the holding period, > 0. */
  initialContractPrice: number;
  /** Price of the held contract at the end of the holding period, BEFORE rolling, > 0. */
  finalContractPriceBeforeRoll: number;
  /** Price of the next contract at the roll instant, > 0. */
  nextContractPriceAtRoll: number;
}

/** Result of {@link rollReturnDecomposition}. */
export interface RollReturnDecompositionResult {
  /**
   * The OBSERVED total return on the held contract over the holding period:
   * `finalContractPriceBeforeRoll / initialContractPrice − 1`.
   */
  totalHoldingReturn: number;
  /** `finalSpotPrice / initialSpotPrice − 1` — the spot move over the period. */
  spotMoveReturn: number;
  /**
   * The change in the contract's basis ratio to spot over the period:
   * `(finalContractPriceBeforeRoll / finalSpotPrice) / (initialContractPrice / initialSpotPrice) − 1`
   * — the carry/convergence earned as the contract pulls toward spot (positive for a long in
   * backwardation).
   */
  carryConvergenceReturn: number;
  /**
   * The roll leg, stated SEPARATELY: the roll is cash-neutral at execution, so its yield
   * `(finalContractPriceBeforeRoll − nextContractPriceAtRoll) / nextContractPriceAtRoll` accrues
   * over the NEXT holding period and is never added into `totalHoldingReturn`.
   */
  rollLeg: {
    rollYieldFraction: number;
    /** The fixed roll-leg prose: cash-neutral at execution, accrues next period. */
    convention: string;
  };
  assumptions: {
    /** The fixed reconciliation prose: the components compound exactly to the observed total. */
    reconciliation: string;
    declaredResidualBound: 1e-12;
  };
  diagnostics: {
    warnings: string[];
    /** `(1 + totalHoldingReturn) − (1 + spotMoveReturn) × (1 + carryConvergenceReturn)` — floating point only. */
    reconciliationResidual: number;
  };
}

/**
 * Decompose the return on a long futures position over one holding period ending at a roll.
 * With `S0/S1` the initial/final spot and `F0/F1` the held contract's initial/final (before-roll)
 * prices:
 *
 * - `totalHoldingReturn = F1/F0 − 1` — the observed total;
 * - `spotMoveReturn = S1/S0 − 1`;
 * - `carryConvergenceReturn = (F1/S1)/(F0/S0) − 1` — the basis-ratio change;
 * - and EXACTLY `(1 + total) = (1 + spotMove) × (1 + carryConvergence)`, because
 *   `(S1/S0) × ((F1/S1)/(F0/S0)) = F1/F0` — the declared multiplicative convention, tested at the
 *   declared residual 1e-12.
 *
 * The roll leg is stated separately: rolling is cash-neutral at execution, so the roll yield
 * `(F1 − N)/N` is the third component of the economics but belongs to the NEXT period's return,
 * and this function never folds it into the holding total.
 */
export function rollReturnDecomposition(
  input: RollReturnDecompositionInput,
): RollReturnDecompositionResult {
  requireArgumentObject('rollReturnDecomposition', 'input', input);
  ensureKnownKeys('rollReturnDecomposition', 'input', input, [
    'initialSpotPrice',
    'finalSpotPrice',
    'initialContractPrice',
    'finalContractPriceBeforeRoll',
    'nextContractPriceAtRoll',
  ]);
  const priceFields = [
    'initialSpotPrice',
    'finalSpotPrice',
    'initialContractPrice',
    'finalContractPriceBeforeRoll',
    'nextContractPriceAtRoll',
  ] as const;
  requireFiniteFields(
    'rollReturnDecomposition',
    input as unknown as Record<string, unknown>,
    priceFields,
    {
      exampleCall:
        'rollReturnDecomposition({ initialSpotPrice: 100, finalSpotPrice: 104, initialContractPrice: 98, finalContractPriceBeforeRoll: 103.5, nextContractPriceAtRoll: 101 })',
    },
  );
  for (const field of priceFields) {
    if (input[field] <= 0) {
      throw new InputError(
        `rollReturnDecomposition: ${field} must be > 0 — every leg of the decomposition is a ratio of positive prices. Received ${input[field]}.`,
        { code: ErrorCode.InputOutOfRange, context: { field } },
      );
    }
  }
  const totalHoldingReturn = input.finalContractPriceBeforeRoll / input.initialContractPrice - 1;
  const spotMoveReturn = input.finalSpotPrice / input.initialSpotPrice - 1;
  const carryConvergenceReturn =
    input.finalContractPriceBeforeRoll /
      input.finalSpotPrice /
      (input.initialContractPrice / input.initialSpotPrice) -
    1;
  const reconciliationResidual =
    1 + totalHoldingReturn - (1 + spotMoveReturn) * (1 + carryConvergenceReturn);
  const warnings: string[] = [];
  if (Math.abs(reconciliationResidual) > 1e-12) {
    warnings.push(
      `reconciliationResidual ${reconciliationResidual} exceeds the declared 1e-12 bound — floating point alone should not do this; inspect the inputs for extreme magnitudes.`,
    );
  }
  return requireRepresentableResult('rollReturnDecomposition', {
    totalHoldingReturn,
    spotMoveReturn,
    carryConvergenceReturn,
    rollLeg: {
      rollYieldFraction:
        (input.finalContractPriceBeforeRoll - input.nextContractPriceAtRoll) /
        input.nextContractPriceAtRoll,
      convention:
        'the roll is cash-neutral at execution; its yield accrues over the next holding period and is never added into totalHoldingReturn',
    },
    assumptions: {
      reconciliation:
        '(1 + totalHoldingReturn) = (1 + spotMoveReturn) × (1 + carryConvergenceReturn) — exact, because (S1/S0) × ((F1/S1)/(F0/S0)) = F1/F0; the components COMPOUND under this declared multiplicative convention, they do not sum',
      declaredResidualBound: 1e-12,
    },
    diagnostics: { warnings, reconciliationResidual },
  });
}

// ---------------------------------------------------------------------------------------------------
// Seasonality
// ---------------------------------------------------------------------------------------------------

/** One dated observation for {@link seasonalityProfile}. */
export interface SeasonalityObservation {
  /** Strict `YYYY-MM-DD` calendar date. */
  observationDate: string;
  value: number;
}

/** One calendar-month row of a {@link seasonalityProfile}. */
export interface SeasonalityMonthRow {
  /** Calendar month, 1..12. */
  month: number;
  observationCount: number;
  /** The requested statistic over the month's observations — `null` for an empty month. */
  statisticValue: number | null;
  /** Present exactly when `statisticValue` is null. */
  statisticValueAbsentReason?: string;
}

/** Input for {@link seasonalityProfile}. */
export interface SeasonalityProfileInput {
  observations: readonly SeasonalityObservation[];
  /** The per-month statistic — explicit, never defaulted. */
  statistic: 'mean' | 'median';
}

/** Result of {@link seasonalityProfile}. */
export interface SeasonalityProfileResult {
  /** Twelve rows, months 1..12 in order — empty months are null WITH reason, never dropped. */
  months: SeasonalityMonthRow[];
  /** The mean over ALL observations (regardless of the per-month statistic). */
  overallMean: number;
  assumptions: {
    statistic: 'mean' | 'median';
    /** The fixed scope prose: descriptive only — no seasonality is invented. */
    scope: string;
  };
  diagnostics: {
    warnings: string[];
    /** Observation counts by calendar month, index 0 = January. */
    observationCountByMonth: number[];
  };
}

/**
 * Group caller-supplied dated observations by calendar month and report the requested statistic
 * per month plus the overall mean. Purely descriptive: it never extrapolates an empty month
 * (`null` with reason), and it warns when any month rests on fewer than 3 observations — a
 * "seasonal pattern" read off one or two points is noise wearing a costume.
 */
export function seasonalityProfile(input: SeasonalityProfileInput): SeasonalityProfileResult {
  requireArgumentObject('seasonalityProfile', 'input', input);
  ensureKnownKeys('seasonalityProfile', 'input', input, ['observations', 'statistic']);
  if (input.statistic !== 'mean' && input.statistic !== 'median') {
    const received = (input as { statistic?: unknown }).statistic;
    throw new InputError(
      `seasonalityProfile: statistic must be 'mean' | 'median'. Received ${received === null ? 'null' : JSON.stringify(received)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'statistic' } },
    );
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new InputError(
      `seasonalityProfile: observations must be a non-empty array of { observationDate: 'YYYY-MM-DD', value } entries.\n  e.g. seasonalityProfile({ observations: [{ observationDate: '2025-01-15', value: 3.12 }], statistic: 'mean' })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'observations' } },
    );
  }
  const valuesByMonth: number[][] = Array.from({ length: 12 }, () => []);
  const allValues: number[] = [];
  input.observations.forEach((observation, index) => {
    const path = `observations[${index}]`;
    requireArgumentObject('seasonalityProfile', path, observation);
    ensureKnownKeys('seasonalityProfile', path, observation, ['observationDate', 'value']);
    if (typeof observation.observationDate !== 'string') {
      throw new InputError(
        `seasonalityProfile: ${path}.observationDate must be a strict 'YYYY-MM-DD' string. Received ${observation.observationDate === null ? 'null' : typeof observation.observationDate}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.observationDate` } },
      );
    }
    let month: number;
    try {
      month = parseIsoDate(observation.observationDate).month;
    } catch (error) {
      throw new InputError(
        `seasonalityProfile: ${path}.observationDate ${(error as Error).message}`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.observationDate` } },
      );
    }
    if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
      throw new InputError(
        `seasonalityProfile: ${path}.value must be a finite number. Received ${observation.value === null ? 'null' : typeof observation.value === 'number' ? String(observation.value) : typeof observation.value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.value` } },
      );
    }
    valuesByMonth[month - 1]!.push(observation.value);
    allValues.push(observation.value);
  });
  const statisticOf = input.statistic === 'mean' ? stableMean : median;
  const months: SeasonalityMonthRow[] = valuesByMonth.map((values, index) => {
    if (values.length === 0) {
      return {
        month: index + 1,
        observationCount: 0,
        statisticValue: null,
        statisticValueAbsentReason:
          'no observations fell in this calendar month — an empty month has no statistic, and none is interpolated.',
      };
    }
    return {
      month: index + 1,
      observationCount: values.length,
      statisticValue: statisticOf(values),
    };
  });
  const thinMonths = months.filter((row) => row.observationCount < 3).map((row) => row.month);
  const warnings: string[] = [];
  if (thinMonths.length > 0) {
    warnings.push(
      `months [${thinMonths.join(', ')}] have fewer than 3 observations — a per-month statistic on so few points is fragile; read it as anecdote, not seasonality.`,
    );
  }
  return {
    months,
    overallMean: stableMean(allValues),
    assumptions: {
      statistic: input.statistic,
      scope: 'a research analysis over caller-supplied history — no seasonality is invented',
    },
    diagnostics: {
      warnings,
      observationCountByMonth: valuesByMonth.map((values) => values.length),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Unit conversion — the explicit-factor law
// ---------------------------------------------------------------------------------------------------

/** Input for {@link convertCommodityQuantity}. */
export interface ConvertCommodityQuantityInput {
  quantity: number;
  /** The unit the quantity is currently in — a label, echoed (e.g. 'barrel'). */
  fromUnit: string;
  /** The target unit — a label, echoed (e.g. 'gallon'). */
  toUnit: string;
  /**
   * REQUIRED explicit factor: target units per one source unit. The generic engine does not
   * invent conversion factors (per spec) — 42 gallons per barrel is the CALLER's physical fact.
   */
  conversionFactor: number;
}

/** Result of {@link convertCommodityQuantity}. */
export interface ConvertCommodityQuantityResult {
  /** `quantity × conversionFactor`, in `toUnit`. */
  convertedQuantity: number;
  assumptions: {
    fromUnit: string;
    toUnit: string;
    conversionFactor: number;
    /** The fixed source prose: the factor is the caller's physical fact. */
    conversionSource: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * Convert a commodity quantity between units with an EXPLICIT caller-supplied factor:
 * `convertedQuantity = quantity × conversionFactor`. Economics are preserved exactly when the
 * caller scales prices by the reciprocal (price-per-unit × quantity is invariant). An identity
 * conversion (`fromUnit === toUnit`) with a factor ≠ 1 is a contradiction and is refused.
 */
export function convertCommodityQuantity(
  input: ConvertCommodityQuantityInput,
): ConvertCommodityQuantityResult {
  requireArgumentObject('convertCommodityQuantity', 'input', input);
  ensureKnownKeys('convertCommodityQuantity', 'input', input, [
    'quantity',
    'fromUnit',
    'toUnit',
    'conversionFactor',
  ]);
  requireFiniteFields(
    'convertCommodityQuantity',
    input as unknown as Record<string, unknown>,
    ['quantity', 'conversionFactor'],
    {
      exampleCall:
        "convertCommodityQuantity({ quantity: 1000, fromUnit: 'barrel', toUnit: 'gallon', conversionFactor: 42 })",
    },
  );
  for (const field of ['fromUnit', 'toUnit'] as const) {
    if (typeof input[field] !== 'string' || input[field].length === 0) {
      throw new InputError(
        `convertCommodityQuantity: ${field} must be a non-empty string. Received ${input[field] === null ? 'null' : typeof input[field] === 'string' ? "''" : typeof input[field]}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  if (input.conversionFactor <= 0) {
    throw new InputError(
      `convertCommodityQuantity: conversionFactor must be > 0 — units convert by a positive scale. Received ${input.conversionFactor}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'conversionFactor' } },
    );
  }
  if (input.fromUnit === input.toUnit && input.conversionFactor !== 1) {
    throw new InputError(
      `convertCommodityQuantity: converting '${input.fromUnit}' to itself with conversionFactor ${input.conversionFactor} is a contradiction — an identity conversion has factor exactly 1. If the units really differ, name them differently.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'conversionFactor' } },
    );
  }
  return requireRepresentableResult('convertCommodityQuantity', {
    convertedQuantity: input.quantity * input.conversionFactor,
    assumptions: {
      fromUnit: input.fromUnit,
      toUnit: input.toUnit,
      conversionFactor: input.conversionFactor,
      conversionSource:
        'caller-supplied — the generic engine does not invent conversion factors or physical-delivery rules',
    },
    diagnostics: { warnings: [] },
  });
}
