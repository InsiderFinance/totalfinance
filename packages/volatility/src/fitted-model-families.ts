/**
 * Internal (not an entrypoint): the sixteen-family grammar's VOLATILITY half — Stage 4.5 Decision 2.
 *
 * One table row per `calibrate*` / `fit*` export of this package. Each row knows how to re-issue
 * the direct calibrator (replay, stability, holdout), how to PROJECT the verbatim result into the
 * core `FittedModelSummary` grammar (no field dropped, renamed, or recomputed — residuals come
 * either from the calibrator's own report or from the family's direct evaluator re-issued at the
 * calibration points), which direct evaluator answers `evaluateFittedModel`, which option a warm
 * start fills, and which bulk row set may travel as a `TableHandle`. Nothing here computes a
 * number a direct function would not compute.
 */

import {
  ErrorCode,
  InputError,
  type EpochMs,
  type OptionQuote,
  type QuantWarning,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { type FittedModelSummary, type TableHandle } from '@totalfinance/core/artifacts';
import { type HestonParameters, type SabrParameters } from '@totalfinance/options';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import { sabrVolatility } from '@totalfinance/options/sabr';
import {
  calibrateSvi,
  sviTotalVariance,
  sviVolatility,
  type SVICalibrationOptions,
  type SVICalibrationResult,
  type SVISmileInput,
  type SVIWarmStart,
} from './svi.js';
import {
  calibrateSsvi,
  ssviTotalVariance,
  ssviVolatility,
  type SSVICalibration,
  type SSVICalibrationInput,
  type SSVICalibrationOptions,
  type SSVIPhi,
  type SSVISliceInput,
} from './ssvi.js';
import {
  calibrateEssvi,
  essviTotalVariance,
  essviVolatility,
  type ESSVICalibration,
  type ESSVICalibrationInput,
  type ESSVICalibrationOptions,
} from './essvi.js';
import {
  calibrateSabrSmile,
  type SABRCalibrationOptions,
  type SABRCalibrationResult,
  type SABRSmileInput,
} from './sabr.js';
import {
  calibrateHestonSurface,
  type HestonSurfaceCalibrationInput,
  type HestonSurfaceFit,
  type HestonSurfaceTarget,
} from './heston-surface.js';
import {
  calibrateVannaVolga,
  calibrateVannaVolga5,
  type VannaVolga5Input,
  type VannaVolga5Smile,
  type VannaVolgaInput,
  type VannaVolgaSmile,
} from './vanna-volga.js';
import {
  calibrateEventMove,
  calibrateEventVolatility,
  eventVolatilityAtExpiry,
  type AtmVolatilityPoint,
  type EventMoveCalibration,
  type EventMoveObservation,
  type EventVolatilityCalibration,
  type FitEventVolatilityOptions,
} from './earnings.js';
import {
  fitGarch,
  fitHarRv,
  garchForecast,
  harRvForecast,
  type GarchFit,
  type GarchFitOptions,
  type HarRvFit,
  type HarRvOptions,
} from './forecast.js';
import {
  VolatilitySurface,
  volatilitySurface,
  type VolatilitySurfaceInput,
  type VolatilitySurfaceSnapshot,
} from './surface.js';

// ─────────────────────────────────────────── the grammar ───────────────────────────────────────────

export type VolatilityModelFamily =
  | 'svi'
  | 'ssvi'
  | 'essvi'
  | 'sabr-smile'
  | 'heston-surface'
  | 'vanna-volga'
  | 'vanna-volga-5'
  | 'event-volatility'
  | 'event-move'
  | 'garch'
  | 'har-rv'
  | 'volatility-surface';

export const VOLATILITY_MODEL_FAMILIES: readonly VolatilityModelFamily[] = [
  'svi',
  'ssvi',
  'essvi',
  'sabr-smile',
  'heston-surface',
  'vanna-volga',
  'vanna-volga-5',
  'event-volatility',
  'event-move',
  'garch',
  'har-rv',
  'volatility-surface',
];

/** The direct calibrator's input per family, verbatim. */
export interface VolatilityCalibrations {
  svi: { smile: SVISmileInput; options?: SVICalibrationOptions };
  ssvi: { surface: SSVICalibrationInput; options?: SSVICalibrationOptions };
  essvi: { surface: ESSVICalibrationInput; options?: ESSVICalibrationOptions };
  'sabr-smile': { smile: SABRSmileInput; options?: SABRCalibrationOptions };
  'heston-surface': HestonSurfaceCalibrationInput;
  'vanna-volga': VannaVolgaInput;
  'vanna-volga-5': VannaVolga5Input;
  'event-volatility': FitEventVolatilityOptions;
  'event-move': { observations: readonly EventMoveObservation[] };
  garch: { returns: number[]; options?: GarchFitOptions };
  'har-rv': { realizedVariances: number[]; options?: HarRvOptions };
  'volatility-surface': VolatilitySurfaceInput;
}

/** The STORED calibration: the declared bulk row set may be a `TableHandle` (Decision 9). */
export interface VolatilityStoredCalibrations {
  svi: VolatilityCalibrations['svi'];
  ssvi: { surface: { slices: SSVISliceInput[] | TableHandle }; options?: SSVICalibrationOptions };
  essvi: { surface: { slices: SSVISliceInput[] | TableHandle }; options?: ESSVICalibrationOptions };
  'sabr-smile': VolatilityCalibrations['sabr-smile'];
  'heston-surface': Omit<HestonSurfaceCalibrationInput, 'targets'> & {
    targets: readonly HestonSurfaceTarget[] | TableHandle;
  };
  'vanna-volga': VannaVolgaInput;
  'vanna-volga-5': VannaVolga5Input;
  'event-volatility': Omit<FitEventVolatilityOptions, 'termStructure'> & {
    termStructure: readonly AtmVolatilityPoint[] | TableHandle;
  };
  'event-move': { observations: readonly EventMoveObservation[] | TableHandle };
  garch: { returns: number[] | TableHandle; options?: GarchFitOptions };
  'har-rv': { realizedVariances: number[] | TableHandle; options?: HarRvOptions };
  'volatility-surface': Omit<VolatilitySurfaceInput, 'quotes'> & {
    quotes: OptionQuote[] | TableHandle;
  };
}

/** The direct calibrator's result per family, verbatim (the surface as its own `toJSON()` snapshot). */
export interface VolatilityFits {
  svi: SVICalibrationResult;
  ssvi: SSVICalibration;
  essvi: ESSVICalibration;
  'sabr-smile': SABRCalibrationResult;
  'heston-surface': HestonSurfaceFit;
  'vanna-volga': VannaVolgaSmile;
  'vanna-volga-5': VannaVolga5Smile;
  'event-volatility': EventVolatilityCalibration;
  'event-move': EventMoveCalibration;
  garch: GarchFit;
  'har-rv': HarRvFit;
  'volatility-surface': VolatilitySurfaceSnapshot;
}

/** What `evaluateFittedModel` takes per family — the family's direct evaluator's coordinates. */
export interface VolatilityEvaluations {
  svi: { logMoneyness: number[]; timeToExpiryYears?: number };
  ssvi: { logMoneyness: number[]; timeToExpiryYears: number[] };
  essvi: { logMoneyness: number[]; timeToExpiryYears: number[] };
  'sabr-smile': { strikes: number[] };
  'heston-surface': { type: 'call' | 'put'; strikes: number[]; timeToExpiryYears: number[] };
  'vanna-volga': { strikes: number[] };
  'vanna-volga-5': { strikes: number[] };
  'event-volatility': { expiries: string[] };
  'event-move': never;
  garch: { lastVariance: number; horizonPeriods: number };
  'har-rv': { history: number[] };
  'volatility-surface': { strikes: number[]; expiry: string | number };
}

/** What `warmStartFrom` returns per warm-startable family — spread into the next calibration's options. */
export interface VolatilityWarmStarts {
  svi: { initialParameters: SVIWarmStart };
  ssvi: { initialParameters: { rho: number; phi: SSVIPhi } };
  essvi: { initialParameters: { rho: number[]; phi: SSVIPhi } };
  'sabr-smile': { initialParameters: { alpha: number; rho: number; nu: number } };
  'heston-surface': { initialParameters: HestonParameters };
  garch: { initialParameters: { alpha: number; beta: number } };
  'volatility-surface': { config: { hestonInitialParameters: HestonParameters } };
}

export type CalibrationOf<F extends VolatilityModelFamily> = VolatilityCalibrations[F];
export type StoredCalibrationOf<F extends VolatilityModelFamily> = VolatilityStoredCalibrations[F];
export type FitOf<F extends VolatilityModelFamily> = VolatilityFits[F];
export type EvaluationOf<F extends VolatilityModelFamily> = VolatilityEvaluations[F];
export type WarmStartOf<F extends VolatilityModelFamily> = F extends keyof VolatilityWarmStarts
  ? VolatilityWarmStarts[F]
  : never;

/** Program 5's "registry metadata" as DATA — one frozen descriptor per family, no runtime registry. */
export interface FittedModelFamilyDescriptor {
  family: string;
  qualifiedFamily: string;
  modelVersion: number;
  calibrator: string;
  evaluator: string | null;
  warmStart: boolean;
  /** Dot path of the one bulk row set that may be referenced by a `TableHandle`, or none. */
  referenceableRowSets: readonly string[];
  costClass: 'closed-form' | 'least-squares' | 'iterative-pricing' | 'bootstrap' | 'statistic';
  requiredData: string;
  supportedProducts: string;
}

// ────────────────────────────────────────── shared helpers ──────────────────────────────────────────

type Range = { minimum: number; maximum: number };

function rangeOf(values: readonly number[]): Range {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}

function residualStatistics(residuals: readonly number[]): {
  count: number;
  rootMeanSquare: number | null;
  maximumAbsolute: number | null;
} {
  if (residuals.length === 0) return { count: 0, rootMeanSquare: null, maximumAbsolute: null };
  let sumSquares = 0;
  let maximumAbsolute = 0;
  for (const residual of residuals) {
    sumSquares += residual * residual;
    if (Math.abs(residual) > maximumAbsolute) maximumAbsolute = Math.abs(residual);
  }
  return {
    count: residuals.length,
    rootMeanSquare: Math.sqrt(sumSquares / residuals.length),
    maximumAbsolute,
  };
}

function sliceTotalVariances(slice: SSVISliceInput): number[] {
  if (slice.w !== undefined) return [...slice.w];
  const impliedVolatility = slice.impliedVolatility ?? [];
  return impliedVolatility.map((iv) => iv * iv * slice.timeToExpiryYears);
}

function flattenPhi(phi: SSVIPhi): Record<string, number | string> {
  return phi.kind === 'power-law'
    ? { 'phi.kind': 'power-law', 'phi.eta': phi.eta, 'phi.gamma': phi.gamma }
    : { 'phi.kind': 'heston', 'phi.lambda': phi.lambda };
}

function outsideCount(values: readonly number[], range: Range | undefined): number {
  if (range === undefined) return 0;
  return values.filter((value) => value < range.minimum || value > range.maximum).length;
}

/** Every family's evaluation answers this; `evaluateFittedModel` wraps it in the Law-2 report. */
export interface FamilyEvaluation {
  values: (number | null)[];
  reasons: Array<{ index: number; reason: string }>;
  coordinates: Array<Record<string, number | string>>;
  unit: string;
  evaluator: string;
  options: Record<string, unknown>;
  outsideCalibratedRange: number;
  warnings: QuantWarning[];
}

/** The projection a family contributes to the core summary (everything but identity/version/warning count). */
export interface FamilyProjection {
  parameters: Record<string, number | number[] | string>;
  objective: FittedModelSummary['objective'];
  convergence: FittedModelSummary['convergence'];
  residuals: FittedModelSummary['residuals'];
  modelRisk: FittedModelSummary['modelRisk'];
  weighting: string | null;
}

/** How a family's calibration points are partitioned for holdout (cross-sectional families). */
export interface FamilyPoints<F extends VolatilityModelFamily> {
  count(calibration: CalibrationOf<F>): number;
  subset(calibration: CalibrationOf<F>, keep: readonly boolean[]): CalibrationOf<F>;
  /** Residuals (model − observed) of `fit` at the held-out points, through the direct evaluator. */
  residuals(fit: FitOf<F>, calibration: CalibrationOf<F>, heldOut: readonly number[]): number[];
  unit: string;
}

export interface FamilySpec<F extends VolatilityModelFamily> {
  descriptor: FittedModelFamilyDescriptor;
  /** Dot path of the bulk row set inside the calibration (`['surface', 'slices']`), or null. */
  rowSet: readonly string[] | null;
  calibrate(calibration: CalibrationOf<F>): FitOf<F>;
  project(fit: FitOf<F>, calibration: CalibrationOf<F>): FamilyProjection;
  /** `calibratedRange` is the stored summary's — the only range source when the row set is referenced. */
  evaluate:
    | ((
        fit: FitOf<F>,
        calibration: CalibrationOf<F>,
        at: EvaluationOf<F>,
        calibratedRange: Record<string, Range>,
      ) => FamilyEvaluation)
    | null;
  evaluationKeys: readonly string[];
  warmStart: ((fit: FitOf<F>) => WarmStartOf<F>) | null;
  /** Stability: the free start members as a flat vector, and how to apply a jittered vector as options. */
  freeStart: {
    members: readonly string[];
    read(fit: FitOf<F>): number[];
    apply(calibration: CalibrationOf<F>, vector: readonly number[]): CalibrationOf<F>;
    /** Per member: `'correlation'` clamps into (−1, 1); `'positive'` stays positive; `'unit'` stays in (0, 1). */
    domains: readonly ('correlation' | 'positive' | 'unit' | 'free')[];
  } | null;
  points: FamilyPoints<F> | null;
  /** Time-series holdout (prefix fit, one-step forecasts through the direct forecaster). */
  timeSeries: {
    count(calibration: CalibrationOf<F>): number;
    prefix(calibration: CalibrationOf<F>, count: number): CalibrationOf<F>;
    forecastResiduals(fit: FitOf<F>, calibration: CalibrationOf<F>, from: number): number[];
    unit: string;
  } | null;
}

const NO_ITERATIONS = 'the calibrator reports convergence only, not an iteration count';

function sviRange(
  smile: SVISmileInput,
  options: SVICalibrationOptions | undefined,
): Record<string, Range> {
  return {
    logMoneyness: rangeOf(smile.k),
    ...(options?.timeToExpiryYears !== undefined
      ? {
          timeToExpiryYears: {
            minimum: options.timeToExpiryYears,
            maximum: options.timeToExpiryYears,
          },
        }
      : {}),
  };
}

function surfaceRanges(slices: readonly SSVISliceInput[]): Record<string, Range> {
  return {
    logMoneyness: rangeOf(slices.flatMap((slice) => slice.k)),
    timeToExpiryYears: rangeOf(slices.map((slice) => slice.timeToExpiryYears)),
  };
}

const extrapolationWarning = (
  functionName: string,
  count: number,
  ranges: Record<string, Range>,
): QuantWarning =>
  warning(
    WarningCode.SurfaceExtrapolated,
    `${functionName}: ${count} coordinate${count === 1 ? '' : 's'} lie outside the calibrated range (${Object.entries(
      ranges,
    )
      .map(([key, range]) => `${key} ∈ [${range.minimum}, ${range.maximum}]`)
      .join(', ')}) — the model is defined there, but its values are extrapolations, not fits.`,
    'warn',
    { count, ranges },
  );

// ───────────────────────────────────────────── families ─────────────────────────────────────────────

const svi: FamilySpec<'svi'> = {
  descriptor: {
    family: 'svi',
    qualifiedFamily: 'volatility.svi',
    modelVersion: 1,
    calibrator: 'calibrateSvi',
    evaluator: 'sviVolatility',
    warmStart: true,
    referenceableRowSets: [],
    costClass: 'least-squares',
    requiredData:
      'one expiry slice: log-moneyness and total implied variance per strike (≥ 5 points)',
    supportedProducts: 'raw-SVI smile: total variance and implied volatility at any log-moneyness',
  },
  rowSet: null,
  calibrate: (calibration) => calibrateSvi(calibration.smile, calibration.options),
  project: (fit, calibration) => {
    const residuals = calibration.smile.k.map(
      (k, index) => sviTotalVariance(fit.parameters, k) - calibration.smile.w[index]!,
    );
    return {
      parameters: { ...fit.parameters },
      objective: { kind: 'root-mean-square-error', value: fit.rmse, unit: 'total variance' },
      convergence: { converged: fit.converged, iterations: fit.iterations },
      residuals: {
        ...residualStatistics(residuals),
        unit: 'total variance',
        source: 'direct-evaluator',
      },
      modelRisk: {
        arbitrageFree: fit.butterflyFree,
        calibratedRange: sviRange(calibration.smile, calibration.options),
        notes: [`minimum Gatheral g over the check grid: ${fit.minButterflyG}`],
      },
      weighting: null,
    };
  },
  evaluationKeys: ['logMoneyness', 'timeToExpiryYears'],
  evaluate: (fit, calibration, at, ranges) => {
    const timeToExpiryYears = at.timeToExpiryYears ?? calibration.options?.timeToExpiryYears;
    if (timeToExpiryYears === undefined) {
      throw new InputError(
        `evaluateFittedModel: an SVI slice's implied volatility needs a maturity — pass at.timeToExpiryYears, or calibrate with options.timeToExpiryYears; for total variance call sviTotalVariance directly.`,
        {
          code: ErrorCode.InputMissingField,
          context: { family: 'svi', field: 'at.timeToExpiryYears' },
        },
      );
    }
    const outside = outsideCount(at.logMoneyness, ranges['logMoneyness']);
    return {
      values: at.logMoneyness.map((k) => sviVolatility(fit.parameters, k, timeToExpiryYears)),
      reasons: [],
      coordinates: at.logMoneyness.map((logMoneyness) => ({ logMoneyness, timeToExpiryYears })),
      unit: 'implied volatility',
      evaluator: 'sviVolatility',
      options: { timeToExpiryYears },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: (fit) => ({ initialParameters: { m: fit.parameters.m, sigma: fit.parameters.sigma } }),
  freeStart: {
    members: ['m', 'sigma'],
    read: (fit) => [fit.parameters.m, fit.parameters.sigma],
    apply: (calibration, vector) => ({
      ...calibration,
      options: {
        ...(calibration.options ?? {}),
        initialParameters: { m: vector[0]!, sigma: vector[1]! },
      },
    }),
    domains: ['free', 'positive'],
  },
  points: {
    count: (calibration) => calibration.smile.k.length,
    subset: (calibration, keep) => ({
      ...calibration,
      smile: {
        k: calibration.smile.k.filter((_, index) => keep[index] === true),
        w: calibration.smile.w.filter((_, index) => keep[index] === true),
      },
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map(
        (index) =>
          sviTotalVariance(fit.parameters, calibration.smile.k[index]!) -
          calibration.smile.w[index]!,
      ),
    unit: 'total variance',
  },
  timeSeries: null,
};

function ssviLikeProjection(
  fit: SSVICalibration | ESSVICalibration,
  slices: readonly SSVISliceInput[],
  totalVariance: (k: number, t: number) => number,
  parameters: Record<string, number | number[] | string>,
  extraNotes: string[],
): FamilyProjection {
  const residuals: number[] = [];
  for (const slice of slices) {
    const observed = sliceTotalVariances(slice);
    slice.k.forEach((k, index) => {
      residuals.push(totalVariance(k, slice.timeToExpiryYears) - observed[index]!);
    });
  }
  return {
    parameters,
    objective: { kind: 'root-mean-square-error', value: fit.rmse, unit: 'total variance' },
    convergence: {
      converged: fit.converged,
      iterations: fit.diagnostics.iterations ?? null,
      ...(fit.diagnostics.iterations === undefined ? { reason: NO_ITERATIONS } : {}),
    },
    residuals: {
      ...residualStatistics(residuals),
      unit: 'total variance',
      source: 'direct-evaluator',
    },
    modelRisk: {
      arbitrageFree: fit.arbitrage.butterflyArbitrageFree && fit.arbitrage.calendarArbitrageFree,
      calibratedRange: surfaceRanges(slices),
      notes: [
        `butterfly-arbitrage-free: ${fit.arbitrage.butterflyArbitrageFree}; calendar-arbitrage-free: ${fit.arbitrage.calendarArbitrageFree}; minimum Gatheral g: ${fit.arbitrage.minButterflyG}`,
        ...extraNotes,
      ],
    },
    weighting: fit.assumptions.weight,
  };
}

function surfaceEvaluation(
  ranges: Record<string, Range>,
  at: { logMoneyness: number[]; timeToExpiryYears: number[] },
  volatility: (k: number, t: number) => number,
  evaluator: string,
): FamilyEvaluation {
  const outside =
    outsideCount(at.logMoneyness, ranges['logMoneyness']) * at.timeToExpiryYears.length +
    outsideCount(at.timeToExpiryYears, ranges['timeToExpiryYears']) * at.logMoneyness.length;
  const values: number[] = [];
  const coordinates: Array<Record<string, number | string>> = [];
  for (const timeToExpiryYears of at.timeToExpiryYears) {
    for (const logMoneyness of at.logMoneyness) {
      values.push(volatility(logMoneyness, timeToExpiryYears));
      coordinates.push({ logMoneyness, timeToExpiryYears });
    }
  }
  return {
    values,
    reasons: [],
    coordinates,
    unit: 'implied volatility',
    evaluator,
    options: { layout: 'timeToExpiryYears-major' },
    outsideCalibratedRange: outside,
    warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
  };
}

function slicesSubset(
  slices: readonly SSVISliceInput[],
  keep: readonly boolean[],
): SSVISliceInput[] {
  let cursor = 0;
  const out: SSVISliceInput[] = [];
  for (const slice of slices) {
    const observed = sliceTotalVariances(slice);
    const k: number[] = [];
    const w: number[] = [];
    slice.k.forEach((value, index) => {
      if (keep[cursor + index] === true) {
        k.push(value);
        w.push(observed[index]!);
      }
    });
    cursor += slice.k.length;
    out.push({ timeToExpiryYears: slice.timeToExpiryYears, k, w });
  }
  return out;
}

function slicesResiduals(
  slices: readonly SSVISliceInput[],
  heldOut: readonly number[],
  totalVariance: (k: number, t: number) => number,
): number[] {
  const flat: Array<{ k: number; t: number; w: number }> = [];
  for (const slice of slices) {
    const observed = sliceTotalVariances(slice);
    slice.k.forEach((k, index) =>
      flat.push({ k, t: slice.timeToExpiryYears, w: observed[index]! }),
    );
  }
  return heldOut.map((index) => {
    const point = flat[index]!;
    return totalVariance(point.k, point.t) - point.w;
  });
}

const ssvi: FamilySpec<'ssvi'> = {
  descriptor: {
    family: 'ssvi',
    qualifiedFamily: 'volatility.ssvi',
    modelVersion: 1,
    calibrator: 'calibrateSsvi',
    evaluator: 'ssviVolatility',
    warmStart: true,
    referenceableRowSets: ['surface.slices'],
    costClass: 'least-squares',
    requiredData: 'maturity slices of log-moneyness and total variance (or implied volatility)',
    supportedProducts: 'a global SSVI surface: total variance and implied volatility at any (k, t)',
  },
  rowSet: ['surface', 'slices'],
  calibrate: (calibration) => calibrateSsvi(calibration.surface, calibration.options),
  project: (fit, calibration) =>
    ssviLikeProjection(
      fit,
      calibration.surface.slices,
      (k, t) => ssviTotalVariance(fit.parameters, k, t),
      {
        rho: fit.parameters.rho,
        ...flattenPhi(fit.parameters.phi),
        'thetaTerm.timeToExpiryYears': fit.parameters.thetaTerm.map(
          (knot) => knot.timeToExpiryYears,
        ),
        'thetaTerm.theta': fit.parameters.thetaTerm.map((knot) => knot.theta),
      },
      [`sufficient Gatheral–Jacquier conditions hold: ${fit.arbitrage.sufficientConditionsHold}`],
    ),
  evaluationKeys: ['logMoneyness', 'timeToExpiryYears'],
  evaluate: (fit, _calibration, at, ranges) =>
    surfaceEvaluation(ranges, at, (k, t) => ssviVolatility(fit.parameters, k, t), 'ssviVolatility'),
  warmStart: (fit) => ({ initialParameters: { rho: fit.parameters.rho, phi: fit.parameters.phi } }),
  freeStart: {
    members: ['rho', 'phi'],
    read: (fit) =>
      fit.parameters.phi.kind === 'power-law'
        ? [fit.parameters.rho, fit.parameters.phi.eta, fit.parameters.phi.gamma]
        : [fit.parameters.rho, fit.parameters.phi.lambda],
    apply: (calibration, vector) => ({
      ...calibration,
      options: {
        ...(calibration.options ?? {}),
        initialParameters: {
          rho: vector[0]!,
          phi:
            (calibration.options?.phi ?? 'power-law') === 'power-law'
              ? { kind: 'power-law', eta: vector[1]!, gamma: vector[2]! }
              : { kind: 'heston', lambda: vector[1]! },
        },
      },
    }),
    domains: ['correlation', 'positive', 'unit'],
  },
  points: {
    count: (calibration) =>
      calibration.surface.slices.reduce((sum, slice) => sum + slice.k.length, 0),
    subset: (calibration, keep) => ({
      ...calibration,
      surface: { slices: slicesSubset(calibration.surface.slices, keep) },
    }),
    residuals: (fit, calibration, heldOut) =>
      slicesResiduals(calibration.surface.slices, heldOut, (k, t) =>
        ssviTotalVariance(fit.parameters, k, t),
      ),
    unit: 'total variance',
  },
  timeSeries: null,
};

const essvi: FamilySpec<'essvi'> = {
  descriptor: {
    family: 'essvi',
    qualifiedFamily: 'volatility.essvi',
    modelVersion: 1,
    calibrator: 'calibrateEssvi',
    evaluator: 'essviVolatility',
    warmStart: true,
    referenceableRowSets: ['surface.slices'],
    costClass: 'least-squares',
    requiredData: 'maturity slices of log-moneyness and total variance (or implied volatility)',
    supportedProducts:
      'an eSSVI surface with per-maturity skew: total variance and implied volatility at any (k, t)',
  },
  rowSet: ['surface', 'slices'],
  calibrate: (calibration) => calibrateEssvi(calibration.surface, calibration.options),
  project: (fit, calibration) =>
    ssviLikeProjection(
      fit,
      calibration.surface.slices,
      (k, t) => essviTotalVariance(fit.parameters, k, t),
      {
        ...flattenPhi(fit.parameters.phi),
        'thetaTerm.timeToExpiryYears': fit.parameters.thetaTerm.map(
          (knot) => knot.timeToExpiryYears,
        ),
        'thetaTerm.theta': fit.parameters.thetaTerm.map((knot) => knot.theta),
        'thetaTerm.rho': fit.parameters.thetaTerm.map((knot) => knot.rho),
      },
      [`minimum calendar slope over the grid: ${fit.arbitrage.minCalendarSlope}`],
    ),
  evaluationKeys: ['logMoneyness', 'timeToExpiryYears'],
  evaluate: (fit, _calibration, at, ranges) =>
    surfaceEvaluation(
      ranges,
      at,
      (k, t) => essviVolatility(fit.parameters, k, t),
      'essviVolatility',
    ),
  warmStart: (fit) => ({
    initialParameters: {
      rho: fit.parameters.thetaTerm.map((knot) => knot.rho),
      phi: fit.parameters.phi,
    },
  }),
  freeStart: {
    members: ['rho[]', 'phi'],
    read: (fit) => [
      ...fit.parameters.thetaTerm.map((knot) => knot.rho),
      ...(fit.parameters.phi.kind === 'power-law'
        ? [fit.parameters.phi.eta, fit.parameters.phi.gamma]
        : [fit.parameters.phi.lambda]),
    ],
    apply: (calibration, vector) => {
      const knots = calibration.surface.slices.length;
      const powerLaw = (calibration.options?.phi ?? 'power-law') === 'power-law';
      return {
        ...calibration,
        options: {
          ...(calibration.options ?? {}),
          initialParameters: {
            rho: vector.slice(0, knots),
            phi: powerLaw
              ? { kind: 'power-law', eta: vector[knots]!, gamma: vector[knots + 1]! }
              : { kind: 'heston', lambda: vector[knots]! },
          },
        },
      };
    },
    domains: ['correlation', 'positive', 'unit'],
  },
  points: {
    count: (calibration) =>
      calibration.surface.slices.reduce((sum, slice) => sum + slice.k.length, 0),
    subset: (calibration, keep) => ({
      ...calibration,
      surface: { slices: slicesSubset(calibration.surface.slices, keep) },
    }),
    residuals: (fit, calibration, heldOut) =>
      slicesResiduals(calibration.surface.slices, heldOut, (k, t) =>
        essviTotalVariance(fit.parameters, k, t),
      ),
    unit: 'total variance',
  },
  timeSeries: null,
};

function sabrVolatilityAt(
  fit: SABRCalibrationResult,
  smile: SABRSmileInput,
  strike: number,
): number {
  return sabrVolatility({
    input: { forward: smile.forward, strike, timeToExpiryYears: smile.timeToExpiryYears },
    parameters: fit.parameters,
    options: { volatilityType: fit.assumptions.volatilityType },
  });
}

const sabrSmile: FamilySpec<'sabr-smile'> = {
  descriptor: {
    family: 'sabr-smile',
    qualifiedFamily: 'volatility.sabr-smile',
    modelVersion: 1,
    calibrator: 'calibrateSabrSmile',
    evaluator: 'sabrVolatility',
    warmStart: true,
    referenceableRowSets: [],
    costClass: 'least-squares',
    requiredData: 'one expiry: forward, strikes, implied volatilities (≥ 3 strikes)',
    supportedProducts: 'a SABR smile (Hagan lognormal or normal) at any strike of that expiry',
  },
  rowSet: null,
  calibrate: (calibration) => calibrateSabrSmile(calibration.smile, calibration.options),
  project: (fit, calibration) => {
    const residuals = calibration.smile.strikes.map(
      (strike, index) =>
        sabrVolatilityAt(fit, calibration.smile, strike) -
        calibration.smile.impliedVolatilities[index]!,
    );
    return {
      parameters: { ...fit.parameters },
      objective: { kind: 'root-mean-square-error', value: fit.rmse, unit: 'implied volatility' },
      convergence: { converged: fit.converged, iterations: fit.iterations },
      residuals: {
        ...residualStatistics(residuals),
        unit: 'implied volatility',
        source: 'direct-evaluator',
      },
      modelRisk: {
        arbitrageFree: null,
        calibratedRange: {
          strike: rangeOf(calibration.smile.strikes),
          timeToExpiryYears: {
            minimum: calibration.smile.timeToExpiryYears,
            maximum: calibration.smile.timeToExpiryYears,
          },
        },
        notes: [
          `beta fixed at ${fit.assumptions.beta}; Hagan ${fit.assumptions.volatilityType} expansion`,
        ],
      },
      weighting: null,
    };
  },
  evaluationKeys: ['strikes'],
  evaluate: (fit, calibration, at, ranges) => {
    const outside = outsideCount(at.strikes, ranges['strike']);
    return {
      values: at.strikes.map((strike) => sabrVolatilityAt(fit, calibration.smile, strike)),
      reasons: [],
      coordinates: at.strikes.map((strike) => ({
        strike,
        timeToExpiryYears: calibration.smile.timeToExpiryYears,
      })),
      unit: 'implied volatility',
      evaluator: 'sabrVolatility',
      options: {
        volatilityType: fit.assumptions.volatilityType,
        forward: calibration.smile.forward,
      },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: (fit) => ({
    initialParameters: {
      alpha: fit.parameters.alpha,
      rho: fit.parameters.rho,
      nu: fit.parameters.nu,
    },
  }),
  freeStart: {
    members: ['alpha', 'rho', 'nu'],
    read: (fit) => [fit.parameters.alpha, fit.parameters.rho, fit.parameters.nu],
    apply: (calibration, vector) => ({
      ...calibration,
      options: {
        ...(calibration.options ?? {}),
        initialParameters: { alpha: vector[0]!, rho: vector[1]!, nu: vector[2]! },
      },
    }),
    domains: ['positive', 'correlation', 'positive'],
  },
  points: {
    count: (calibration) => calibration.smile.strikes.length,
    subset: (calibration, keep) => ({
      ...calibration,
      smile: {
        ...calibration.smile,
        strikes: calibration.smile.strikes.filter((_, index) => keep[index] === true),
        impliedVolatilities: calibration.smile.impliedVolatilities.filter(
          (_, index) => keep[index] === true,
        ),
      },
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map(
        (index) =>
          sabrVolatilityAt(fit, calibration.smile, calibration.smile.strikes[index]!) -
          calibration.smile.impliedVolatilities[index]!,
      ),
    unit: 'implied volatility',
  },
  timeSeries: null,
};

function hestonVolatilityAt(
  fit: HestonSurfaceFit,
  calibration: HestonSurfaceCalibrationInput,
  type: 'call' | 'put',
  strike: number,
  timeToExpiryYears: number,
): { value: number | null; reason?: string } {
  const answer = hestonImpliedVolatility({
    type,
    input: {
      spot: calibration.market.spot,
      strike,
      timeToExpiryYears,
      riskFreeRate: calibration.market.riskFreeRate,
      dividendYield: calibration.market.dividendYield,
    },
    parameters: fit.parameters,
    options: { terms: calibration.options?.terms ?? 128, greeks: false },
  });
  if (!answer.converged || !Number.isFinite(answer.value)) {
    return {
      value: null,
      reason: `implied-volatility inversion did not converge${answer.reason !== undefined ? ` (${String(answer.reason)})` : ''}`,
    };
  }
  return { value: answer.value };
}

function hestonRanges(targets: readonly HestonSurfaceTarget[]): Record<string, Range> {
  return {
    logMoneyness: rangeOf(targets.map((target) => Math.log(target.strike / target.forward))),
    strike: rangeOf(targets.map((target) => target.strike)),
    timeToExpiryYears: rangeOf(targets.map((target) => target.timeToExpiryYears)),
  };
}

const hestonSurface: FamilySpec<'heston-surface'> = {
  descriptor: {
    family: 'heston-surface',
    qualifiedFamily: 'volatility.heston-surface',
    modelVersion: 1,
    calibrator: 'calibrateHestonSurface',
    evaluator: 'hestonImpliedVolatility',
    warmStart: true,
    referenceableRowSets: ['targets'],
    costClass: 'iterative-pricing',
    requiredData:
      '(strike, maturity, implied volatility, forward) targets and the spot / carry market',
    supportedProducts:
      'one Heston parameter set: implied volatility at any (strike, maturity, option type)',
  },
  rowSet: ['targets'],
  calibrate: (calibration) => calibrateHestonSurface(calibration),
  project: (fit, calibration) => {
    const residuals: number[] = [];
    for (const target of calibration.targets) {
      const answer = hestonVolatilityAt(
        fit,
        calibration,
        'call',
        target.strike,
        target.timeToExpiryYears,
      );
      if (answer.value !== null) residuals.push(answer.value - target.impliedVolatility);
    }
    const feller = 2 * fit.parameters.kappa * fit.parameters.theta >= fit.parameters.sigma ** 2;
    return {
      parameters: { ...fit.parameters },
      objective: { kind: 'root-mean-square-error', value: fit.rmse, unit: 'implied volatility' },
      convergence: { converged: fit.converged, iterations: null, reason: NO_ITERATIONS },
      residuals: {
        ...residualStatistics(residuals),
        unit: 'implied volatility',
        source: 'direct-evaluator',
      },
      modelRisk: {
        arbitrageFree: null,
        calibratedRange: hestonRanges(calibration.targets),
        notes: [
          `Feller condition 2κθ ≥ σ² ${feller ? 'holds' : 'is violated'} (2κθ = ${2 * fit.parameters.kappa * fit.parameters.theta}, σ² = ${fit.parameters.sigma ** 2})`,
          `rmse tolerance the converged flag was gated on: ${fit.rmseTolerance}`,
        ],
      },
      weighting: null,
    };
  },
  evaluationKeys: ['type', 'strikes', 'timeToExpiryYears'],
  evaluate: (fit, calibration, at, ranges) => {
    const outside =
      outsideCount(at.strikes, ranges['strike']) * at.timeToExpiryYears.length +
      outsideCount(at.timeToExpiryYears, ranges['timeToExpiryYears']) * at.strikes.length;
    const values: (number | null)[] = [];
    const reasons: Array<{ index: number; reason: string }> = [];
    const coordinates: Array<Record<string, number | string>> = [];
    for (const timeToExpiryYears of at.timeToExpiryYears) {
      for (const strike of at.strikes) {
        const answer = hestonVolatilityAt(fit, calibration, at.type, strike, timeToExpiryYears);
        if (answer.value === null) reasons.push({ index: values.length, reason: answer.reason! });
        values.push(answer.value);
        coordinates.push({ type: at.type, strike, timeToExpiryYears });
      }
    }
    return {
      values,
      reasons,
      coordinates,
      unit: 'implied volatility',
      evaluator: 'hestonImpliedVolatility',
      options: {
        type: at.type,
        terms: calibration.options?.terms ?? 128,
        layout: 'timeToExpiryYears-major',
      },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: (fit) => ({ initialParameters: { ...fit.parameters } }),
  freeStart: {
    members: ['v0', 'theta', 'kappa', 'sigma', 'rho'],
    read: (fit) => [
      fit.parameters.v0,
      fit.parameters.theta,
      fit.parameters.kappa,
      fit.parameters.sigma,
      fit.parameters.rho,
    ],
    apply: (calibration, vector) => ({
      ...calibration,
      options: {
        ...(calibration.options ?? {}),
        initialParameters: {
          v0: vector[0]!,
          theta: vector[1]!,
          kappa: vector[2]!,
          sigma: vector[3]!,
          rho: vector[4]!,
        },
      },
    }),
    domains: ['positive', 'positive', 'positive', 'positive', 'correlation'],
  },
  points: {
    count: (calibration) => calibration.targets.length,
    subset: (calibration, keep) => ({
      ...calibration,
      targets: calibration.targets.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.flatMap((index) => {
        const target = calibration.targets[index]!;
        const answer = hestonVolatilityAt(
          fit,
          calibration,
          'call',
          target.strike,
          target.timeToExpiryYears,
        );
        return answer.value === null ? [] : [answer.value - target.impliedVolatility];
      }),
    unit: 'implied volatility',
  },
  timeSeries: null,
};

const vannaVolga: FamilySpec<'vanna-volga'> = {
  descriptor: {
    family: 'vanna-volga',
    qualifiedFamily: 'volatility.vanna-volga',
    modelVersion: 1,
    calibrator: 'calibrateVannaVolga',
    evaluator: 'calibrateVannaVolga',
    warmStart: false,
    referenceableRowSets: [],
    costClass: 'closed-form',
    requiredData: 'forward, maturity, ATM volatility, one risk reversal and butterfly at a delta',
    supportedProducts: 'the three-pillar vanna–volga smile at any strikes of that expiry',
  },
  rowSet: null,
  calibrate: (calibration) => calibrateVannaVolga(calibration),
  project: (fit, calibration) => ({
    parameters: {
      putStrike: fit.pillars.putStrike,
      putVolatility: fit.pillars.putVolatility,
      atmStrike: fit.pillars.atmStrike,
      atmVolatility: fit.pillars.atmVolatility,
      callStrike: fit.pillars.callStrike,
      callVolatility: fit.pillars.callVolatility,
      delta: fit.delta,
    },
    objective: { kind: 'exact-fit', value: 0, unit: 'implied volatility' },
    convergence: {
      converged: true,
      iterations: null,
      reason: 'an exact pillar construction has no search',
    },
    residuals: null,
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        strike: rangeOf(calibration.strikes),
        timeToExpiryYears: {
          minimum: calibration.timeToExpiryYears,
          maximum: calibration.timeToExpiryYears,
        },
      },
      notes: [
        'exact by construction: the three pillars reprice with zero residual',
        `delta convention: ${fit.assumptions.deltaConvention}`,
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['strikes'],
  evaluate: (fit, calibration, at, ranges) => {
    const outside = outsideCount(at.strikes, ranges['strike']);
    const smile = calibrateVannaVolga({ ...calibration, strikes: [...at.strikes] });
    return {
      values: [...smile.volatilities],
      reasons: [],
      coordinates: at.strikes.map((strike) => ({
        strike,
        timeToExpiryYears: calibration.timeToExpiryYears,
      })),
      unit: 'implied volatility',
      evaluator: 'calibrateVannaVolga',
      options: { delta: fit.delta },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: null,
  freeStart: null,
  points: null,
  timeSeries: null,
};

const vannaVolga5: FamilySpec<'vanna-volga-5'> = {
  descriptor: {
    family: 'vanna-volga-5',
    qualifiedFamily: 'volatility.vanna-volga-5',
    modelVersion: 1,
    calibrator: 'calibrateVannaVolga5',
    evaluator: 'calibrateVannaVolga5',
    warmStart: false,
    referenceableRowSets: [],
    costClass: 'closed-form',
    requiredData:
      'forward, maturity, ATM volatility, 25- and 10-delta risk reversals and butterflies',
    supportedProducts: 'the five-pillar vanna–volga smile at any strikes of that expiry',
  },
  rowSet: null,
  calibrate: (calibration) => calibrateVannaVolga5(calibration),
  project: (fit, calibration) => ({
    parameters: {
      'pillars.strike': fit.pillars.map((pillar) => pillar.strike),
      'pillars.volatility': fit.pillars.map((pillar) => pillar.volatility),
      'pillars.delta': fit.pillars.map((pillar) => pillar.delta),
      innerDelta: fit.innerDelta,
      outerDelta: fit.outerDelta,
    },
    objective: { kind: 'exact-fit', value: 0, unit: 'implied volatility' },
    convergence: {
      converged: true,
      iterations: null,
      reason: 'an exact pillar construction has no search',
    },
    residuals: null,
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        strike: rangeOf(calibration.strikes),
        timeToExpiryYears: {
          minimum: calibration.timeToExpiryYears,
          maximum: calibration.timeToExpiryYears,
        },
      },
      notes: [
        `pillar kinds in order: ${fit.pillars.map((pillar) => pillar.kind).join(', ')}`,
        `wing extrapolation: ${fit.assumptions.wingExtrapolation}; interpolation: ${fit.assumptions.interpolation}`,
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['strikes'],
  evaluate: (fit, calibration, at, ranges) => {
    const outside = outsideCount(at.strikes, ranges['strike']);
    const smile = calibrateVannaVolga5({ ...calibration, strikes: [...at.strikes] });
    return {
      values: [...smile.volatilities],
      reasons: [],
      coordinates: at.strikes.map((strike) => ({
        strike,
        timeToExpiryYears: calibration.timeToExpiryYears,
      })),
      unit: 'implied volatility',
      evaluator: 'calibrateVannaVolga5',
      options: {
        innerDelta: fit.innerDelta,
        outerDelta: fit.outerDelta,
        wingExtrapolation: fit.assumptions.wingExtrapolation,
      },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: null,
  freeStart: null,
  points: null,
  timeSeries: null,
};

const eventVolatility: FamilySpec<'event-volatility'> = {
  descriptor: {
    family: 'event-volatility',
    qualifiedFamily: 'volatility.event-volatility',
    modelVersion: 1,
    calibrator: 'calibrateEventVolatility',
    evaluator: 'eventVolatilityAtExpiry',
    warmStart: false,
    referenceableRowSets: ['termStructure'],
    costClass: 'least-squares',
    requiredData: 'an ATM-volatility term structure, the event date, and the valuation instant',
    supportedProducts:
      'the continuous volatility and the event jump; the model ATM volatility at any expiry',
  },
  rowSet: ['termStructure'],
  calibrate: (calibration) => calibrateEventVolatility(calibration),
  project: (fit) => ({
    parameters: {
      baseVolatility: fit.baseVolatility,
      baseVariance: fit.baseVariance,
      eventMove: fit.eventMove,
      eventVariance: fit.eventVariance,
      daysToEvent: fit.daysToEvent,
    },
    objective: { kind: 'r-squared', value: fit.rSquared, unit: 'total variance' },
    convergence: {
      converged: fit.diagnostics.converged ?? true,
      iterations: null,
      reason: 'a two-coefficient least-squares regression solves in closed form',
    },
    residuals: {
      ...residualStatistics(fit.perExpiry.map((row) => row.residual)),
      unit: 'implied volatility',
      source: 'reported-by-calibrator',
    },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        timeToExpiryYears: rangeOf(fit.perExpiry.map((row) => row.timeToExpiryYears)),
      },
      notes: [
        `${fit.perExpiry.filter((row) => row.spansEvent).length} of ${fit.perExpiry.length} expiries span the event on ${fit.assumptions.eventDate}`,
        `method: ${fit.assumptions.method}`,
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['expiries'],
  evaluate: (fit, _calibration, at, ranges) => {
    const answer = eventVolatilityAtExpiry({ fit, expiries: [...at.expiries] });
    const outside = outsideCount(
      answer.rows.map((row) => row.timeToExpiryYears),
      ranges['timeToExpiryYears'],
    );
    return {
      values: [...answer.values],
      reasons: [],
      coordinates: answer.rows.map((row) => ({
        expiry: row.expiry,
        timeToExpiryYears: row.timeToExpiryYears,
      })),
      unit: 'implied volatility',
      evaluator: 'eventVolatilityAtExpiry',
      options: { eventDate: fit.assumptions.eventDate, asOf: fit.assumptions.asOf },
      outsideCalibratedRange: outside,
      warnings: outside > 0 ? [extrapolationWarning('evaluateFittedModel', outside, ranges)] : [],
    };
  },
  warmStart: null,
  freeStart: null,
  points: {
    count: (calibration) => calibration.termStructure.length,
    subset: (calibration, keep) => ({
      ...calibration,
      termStructure: calibration.termStructure.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) => {
      const answer = eventVolatilityAtExpiry({
        fit,
        expiries: heldOut.map((index) => calibration.termStructure[index]!.expiry),
      });
      return answer.values.map(
        (value, position) => value - calibration.termStructure[heldOut[position]!]!.atmVolatility,
      );
    },
    unit: 'implied volatility',
  },
  timeSeries: null,
};

const eventMove: FamilySpec<'event-move'> = {
  descriptor: {
    family: 'event-move',
    qualifiedFamily: 'volatility.event-move',
    modelVersion: 1,
    calibrator: 'calibrateEventMove',
    evaluator: null,
    warmStart: false,
    referenceableRowSets: ['observations'],
    costClass: 'statistic',
    requiredData: 'past events: straddle-implied move before and realized move after',
    supportedProducts:
      'a historical implied-versus-realized statistic (no forward evaluator: it is not a model)',
  },
  rowSet: ['observations'],
  calibrate: (calibration) => calibrateEventMove(calibration.observations),
  project: (fit) => ({
    parameters: {
      count: fit.count,
      averageImplied: fit.averageImplied,
      averageRealized: fit.averageRealized,
      ratio: fit.ratio,
      overpricedFraction: fit.overpricedFraction,
      bias: fit.bias,
      meanAbsoluteError: fit.meanAbsoluteError,
    },
    objective: {
      kind: 'not-applicable',
      value: null,
      unit: 'move fraction',
      reason: 'an aggregate of past events has no fitted objective',
    },
    convergence: {
      converged: true,
      iterations: null,
      reason: 'a closed-form statistic has no search',
    },
    residuals: {
      ...residualStatistics(fit.perEvent.map((row) => row.error)),
      unit: 'move fraction',
      source: 'reported-by-calibrator',
    },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {},
      notes: [
        `${fit.count} past events; method: ${fit.assumptions.method}`,
        'no forward evaluator: a realized-versus-implied statistic is not a model',
      ],
    },
    weighting: null,
  }),
  evaluationKeys: [],
  evaluate: null,
  warmStart: null,
  freeStart: null,
  points: null,
  timeSeries: null,
};

const garch: FamilySpec<'garch'> = {
  descriptor: {
    family: 'garch',
    qualifiedFamily: 'volatility.garch',
    modelVersion: 1,
    calibrator: 'fitGarch',
    evaluator: 'garchForecast',
    warmStart: true,
    referenceableRowSets: ['returns'],
    costClass: 'statistic',
    requiredData: 'a return series (≥ the fit minimum) and the mean policy',
    supportedProducts:
      'GARCH(1,1) variance forecasts from a caller-supplied last conditional variance',
  },
  rowSet: ['returns'],
  calibrate: (calibration) => fitGarch(calibration.returns, calibration.options),
  project: (fit, calibration) => ({
    parameters: {
      omega: fit.omega,
      alpha: fit.alpha,
      beta: fit.beta,
      persistence: fit.persistence,
      longRunVariance: fit.longRunVariance,
    },
    objective:
      fit.logLikelihood === null
        ? {
            kind: 'log-likelihood',
            value: null,
            unit: 'log-likelihood',
            reason: 'the likelihood was degenerate (a zero-variance series)',
          }
        : { kind: 'log-likelihood', value: fit.logLikelihood, unit: 'log-likelihood' },
    convergence: { converged: fit.converged, iterations: fit.iterations },
    residuals: null,
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        observation: { minimum: 0, maximum: Math.max(0, calibration.returns.length - 1) },
      },
      notes: [
        `stationary: ${fit.persistence < 1} (persistence ${fit.persistence})`,
        `mean policy: ${fit.assumptions.mean}; the seeded multi-start (seed ${calibration.options?.seed ?? 0x61726368}) is part of the stored calibration, so replay is byte-exact`,
        'no per-point residual surface: a variance recursion has no fitted points to compare',
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['lastVariance', 'horizonPeriods'],
  evaluate: (fit, _calibration, at, _ranges) => {
    const forecast = garchForecast({
      fit,
      lastVariance: at.lastVariance,
      horizonPeriods: at.horizonPeriods,
    });
    return {
      values: [...forecast.variancePath],
      reasons: [],
      coordinates: forecast.variancePath.map((_, index) => ({ horizonPeriod: index + 1 })),
      unit: 'variance per period',
      evaluator: 'garchForecast',
      options: { lastVariance: at.lastVariance, horizonPeriods: at.horizonPeriods },
      outsideCalibratedRange: 0,
      warnings: [],
    };
  },
  warmStart: (fit) => ({ initialParameters: { alpha: fit.alpha, beta: fit.beta } }),
  freeStart: {
    members: ['alpha', 'beta'],
    read: (fit) => [fit.alpha, fit.beta],
    apply: (calibration, vector) => ({
      ...calibration,
      options: {
        ...(calibration.options ?? {}),
        initialParameters: { alpha: vector[0]!, beta: vector[1]! },
      },
    }),
    domains: ['unit', 'unit'],
  },
  points: null,
  timeSeries: null,
};

const harRv: FamilySpec<'har-rv'> = {
  descriptor: {
    family: 'har-rv',
    qualifiedFamily: 'volatility.har-rv',
    modelVersion: 1,
    calibrator: 'fitHarRv',
    evaluator: 'harRvForecast',
    warmStart: false,
    referenceableRowSets: ['realizedVariances'],
    costClass: 'statistic',
    requiredData: 'a realized-variance history longer than the monthly window plus the fitted rows',
    supportedProducts: 'one-step-ahead realized-variance forecasts from a history window',
  },
  rowSet: ['realizedVariances'],
  calibrate: (calibration) => fitHarRv(calibration.realizedVariances, calibration.options),
  project: (fit, calibration) => ({
    parameters: {
      'coefficients.const': fit.coefficients.const,
      'coefficients.daily': fit.coefficients.daily,
      'coefficients.weekly': fit.coefficients.weekly,
      'coefficients.monthly': fit.coefficients.monthly,
      'windows.weekly': fit.windows.weekly,
      'windows.monthly': fit.windows.monthly,
    },
    objective:
      fit.rSquared === null
        ? {
            kind: 'r-squared',
            value: null,
            unit: 'realized variance',
            reason: 'a flat realized-variance response has no explained variance',
          }
        : { kind: 'r-squared', value: fit.rSquared, unit: 'realized variance' },
    convergence: {
      converged: true,
      iterations: null,
      reason: 'ordinary least squares (QR) solves in closed form',
    },
    residuals: {
      ...residualStatistics(fit.residuals),
      unit: 'realized variance',
      source: 'reported-by-calibrator',
    },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        observation: { minimum: 0, maximum: Math.max(0, calibration.realizedVariances.length - 1) },
      },
      notes: [
        `${fit.observationCount} fitted observations; weekly window ${fit.windows.weekly}, monthly window ${fit.windows.monthly}`,
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['history'],
  evaluate: (fit, _calibration, at, _ranges) => ({
    values: [harRvForecast(fit, [...at.history])],
    reasons: [],
    coordinates: [{ horizonPeriod: 1 }],
    unit: 'realized variance',
    evaluator: 'harRvForecast',
    options: { horizonKind: 'one-step-ahead', historyLength: at.history.length },
    outsideCalibratedRange: 0,
    warnings: [],
  }),
  warmStart: null,
  freeStart: null,
  points: null,
  timeSeries: {
    count: (calibration) => calibration.realizedVariances.length,
    prefix: (calibration, count) => ({
      ...calibration,
      realizedVariances: calibration.realizedVariances.slice(0, count),
    }),
    forecastResiduals: (fit, calibration, from) => {
      const residuals: number[] = [];
      for (let index = from; index < calibration.realizedVariances.length; index++) {
        const forecast = harRvForecast(fit, calibration.realizedVariances.slice(0, index));
        residuals.push(forecast - calibration.realizedVariances[index]!);
      }
      return residuals;
    },
    unit: 'realized variance',
  },
};

function surfaceOf(fit: VolatilitySurfaceSnapshot): VolatilitySurface {
  return VolatilitySurface.fromJSON(fit);
}

function surfaceRangesOf(fit: VolatilitySurfaceSnapshot): Record<string, Range> {
  return {
    strike: rangeOf(fit.slices.flatMap((slice) => slice.strikes)),
    timeToExpiryYears: rangeOf(fit.slices.map((slice) => slice.timeToExpiryYears)),
  };
}

const volatilitySurfaceFamily: FamilySpec<'volatility-surface'> = {
  descriptor: {
    family: 'volatility-surface',
    qualifiedFamily: 'volatility.volatility-surface',
    modelVersion: 1,
    calibrator: 'volatilitySurface',
    evaluator: 'VolatilitySurface.lookup',
    warmStart: true,
    referenceableRowSets: ['quotes'],
    costClass: 'least-squares',
    requiredData:
      'an option chain (quotes with implied volatilities), the market, and the surface config',
    supportedProducts:
      'the fitted surface: implied volatility at any (strike, expiry) with extrapolation disclosed',
  },
  rowSet: ['quotes'],
  calibrate: (calibration) => volatilitySurface(calibration).toJSON(),
  project: (fit) => {
    const parameters: Record<string, number | number[] | string> = {
      model: fit.model,
      referenceSpot: fit.referenceSpot,
    };
    if (fit.ssvi !== undefined) {
      parameters['ssvi.rho'] = fit.ssvi.rho;
      for (const [key, value] of Object.entries(flattenPhi(fit.ssvi.phi)))
        parameters[`ssvi.${key}`] = value;
      parameters['ssvi.thetaTerm.theta'] = fit.ssvi.thetaTerm.map((knot) => knot.theta);
    }
    if (fit.essvi !== undefined) {
      for (const [key, value] of Object.entries(flattenPhi(fit.essvi.phi)))
        parameters[`essvi.${key}`] = value;
      parameters['essvi.thetaTerm.theta'] = fit.essvi.thetaTerm.map((knot) => knot.theta);
      parameters['essvi.thetaTerm.rho'] = fit.essvi.thetaTerm.map((knot) => knot.rho);
    }
    if (fit.heston !== undefined) {
      for (const [key, value] of Object.entries(fit.heston)) parameters[`heston.${key}`] = value;
    }
    return {
      parameters,
      objective: {
        kind: 'not-applicable',
        value: null,
        unit: 'implied volatility',
        reason:
          'per-slice fit diagnostics ride verbatim in fit.diagnostics; the surface has no single objective',
      },
      convergence: {
        converged: fit.diagnostics.converged ?? true,
        iterations: fit.diagnostics.iterations ?? null,
        ...(fit.diagnostics.iterations === undefined ? { reason: NO_ITERATIONS } : {}),
      },
      residuals: null,
      modelRisk: {
        arbitrageFree: null,
        calibratedRange: surfaceRangesOf(fit),
        notes: [
          `${fit.slices.length} expiry slices, ${fit.points.length} stored points; ${fit.diagnostics.warnings.length} surface warnings ride in fit.diagnostics`,
        ],
      },
      weighting: null,
    };
  },
  evaluationKeys: ['strikes', 'expiry'],
  evaluate: (fit, _calibration, at, ranges) => {
    const surface = surfaceOf(fit);
    const values: (number | null)[] = [];
    const reasons: Array<{ index: number; reason: string }> = [];
    const warnings: QuantWarning[] = [];
    let outside = 0;
    at.strikes.forEach((strike, index) => {
      const lookup = surface.lookup(strike, at.expiry);
      if (lookup.extrapolated) outside += 1;
      if (Number.isFinite(lookup.value)) values.push(lookup.value);
      else {
        values.push(null);
        reasons.push({
          index,
          reason: 'the surface answered a non-finite volatility at this strike',
        });
      }
    });
    if (outside > 0) warnings.push(extrapolationWarning('evaluateFittedModel', outside, ranges));
    return {
      values,
      reasons,
      coordinates: at.strikes.map((strike) => ({ strike, expiry: at.expiry })),
      unit: 'implied volatility',
      evaluator: 'VolatilitySurface.lookup',
      options: { model: fit.model },
      outsideCalibratedRange: outside,
      warnings,
    };
  },
  warmStart: (fit) => {
    if (fit.model !== 'heston' || fit.heston === undefined) {
      throw new InputError(
        `warmStartFrom: a volatility-surface fit warm-starts only when its model is 'heston' (the surface config carries hestonInitialParameters); this surface's model is '${fit.model}', whose per-slice fits have no starting point.`,
        {
          code: ErrorCode.ArtifactOperationUnsupported,
          context: { family: 'volatility-surface', model: fit.model },
        },
      );
    }
    return { config: { hestonInitialParameters: { ...fit.heston } } };
  },
  freeStart: null,
  points: {
    count: (calibration) => calibration.quotes.length,
    subset: (calibration, keep) => ({
      ...calibration,
      quotes: calibration.quotes.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) => {
      const surface = surfaceOf(fit);
      return heldOut.flatMap((index) => {
        const quote = calibration.quotes[index]!;
        const observed = quote.impliedVolatility;
        if (observed === undefined || !Number.isFinite(observed)) return [];
        const lookup = surface.lookup(quote.contract.strike, quote.contract.expiry);
        return Number.isFinite(lookup.value) ? [lookup.value - observed] : [];
      });
    },
    unit: 'implied volatility',
  },
  timeSeries: null,
};

/** Coerce a live surface to its snapshot when a caller hands the instance (the lovable form). */
export function surfaceSnapshotOf(value: unknown): unknown {
  return value instanceof VolatilitySurface ? value.toJSON() : value;
}

export const FAMILY_SPECS: { readonly [F in VolatilityModelFamily]: FamilySpec<F> } = {
  svi,
  ssvi,
  essvi,
  'sabr-smile': sabrSmile,
  'heston-surface': hestonSurface,
  'vanna-volga': vannaVolga,
  'vanna-volga-5': vannaVolga5,
  'event-volatility': eventVolatility,
  'event-move': eventMove,
  garch,
  'har-rv': harRv,
  'volatility-surface': volatilitySurfaceFamily,
};

/** The frozen, data-only descriptor table (Program 5's registry metadata). */
export const FITTED_MODEL_FAMILIES: Readonly<
  Record<VolatilityModelFamily, FittedModelFamilyDescriptor>
> = Object.freeze(
  Object.fromEntries(
    VOLATILITY_MODEL_FAMILIES.map((family) => [
      family,
      Object.freeze({
        ...FAMILY_SPECS[family].descriptor,
        referenceableRowSets: Object.freeze([
          ...FAMILY_SPECS[family].descriptor.referenceableRowSets,
        ]),
      }),
    ]),
  ) as Record<VolatilityModelFamily, FittedModelFamilyDescriptor>,
);

export type { SabrParameters, EpochMs };
