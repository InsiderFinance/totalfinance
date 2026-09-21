/**
 * Internal (not an entrypoint): the sixteen-family grammar's FIXED-INCOME half — Stage 4.5
 * Decision 2. One row per bootstrap: the direct bootstrap to re-issue, the projection into core's
 * `FittedModelSummary` (pillar vectors as dot-path parameters; an `exact-bootstrap` objective whose
 * residuals are the repricing residuals of every calibration instrument through the package's
 * PUBLIC valuation — `forwardRate` for deposits/FRAs/futures, `swapRate` for swaps, `cdsParSpread`
 * for CDS), the evaluator (the restored curve's own methods), and the instrument partition for
 * holdout. Curves are stored as their data and restored exactly (`curve-data.ts`).
 */

import { ErrorCode, InputError, type QuantWarning, warning, WarningCode } from '@totalfinance/core';
import type { FittedModelSummary, TableHandle } from '@totalfinance/core/artifacts';
import {
  bootstrapHazardFromCds,
  cdsParSpread,
  type CdsQuote,
  type HazardBootstrapOptions,
  type SurvivalCurve,
} from './credit.js';
import {
  curves,
  type BootstrapInstrument,
  type BootstrapOptions,
  type MultiCurve,
  type MultiCurveBootstrapOptions,
  type ProjectionBootstrapOptions,
  type YieldCurve,
} from './curves.js';
import { swapRate } from './rates.js';
import {
  survivalCurveDataOf,
  survivalCurveFromData,
  yieldCurveDataOf,
  yieldCurveFromData,
  type SurvivalCurveData,
  type YieldCurveData,
} from './curve-data.js';

// ─────────────────────────────────────────── the grammar ───────────────────────────────────────────

export type CurveModelFamily =
  | 'discount-curve'
  | 'projection-curve'
  | 'multi-curve'
  | 'hazard-curve';

export const CURVE_MODEL_FAMILIES: readonly CurveModelFamily[] = [
  'discount-curve',
  'projection-curve',
  'multi-curve',
  'hazard-curve',
];

/** The direct bootstrap's input per family, verbatim (live curves where the bootstrap takes them). */
export interface CurveCalibrations {
  'discount-curve': { instruments: BootstrapInstrument[]; options: BootstrapOptions };
  'projection-curve': { instruments: BootstrapInstrument[]; options: ProjectionBootstrapOptions };
  'multi-curve': { options: MultiCurveBootstrapOptions };
  'hazard-curve': { quotes: CdsQuote[]; options: HazardBootstrapOptions };
}

/** The STORED calibration: live curves as their data, the bulk row sets optionally as `TableHandle`s. */
export interface CurveStoredCalibrations {
  'discount-curve': { instruments: BootstrapInstrument[] | TableHandle; options: BootstrapOptions };
  'projection-curve': {
    instruments: BootstrapInstrument[] | TableHandle;
    options: Omit<ProjectionBootstrapOptions, 'discountCurve'> & { discountCurve: YieldCurveData };
  };
  'multi-curve': {
    options: Omit<MultiCurveBootstrapOptions, 'ois' | 'projection'> & {
      ois: BootstrapInstrument[] | TableHandle;
      projection: BootstrapInstrument[] | TableHandle;
    };
  };
  'hazard-curve': {
    quotes: CdsQuote[] | TableHandle;
    options: Omit<HazardBootstrapOptions, 'discountCurve'> & { discountCurve: YieldCurveData };
  };
}

/** The stored fit per family: the live result's own data members. */
export interface CurveFits {
  'discount-curve': YieldCurveData;
  'projection-curve': YieldCurveData;
  'multi-curve': { discountCurve: YieldCurveData; forecastCurve: YieldCurveData };
  'hazard-curve': SurvivalCurveData;
}

/** The live result per family — what the direct bootstrap returns and what `fittedModelArtifact` accepts. */
export interface CurveLiveFits {
  'discount-curve': YieldCurve;
  'projection-curve': YieldCurve;
  'multi-curve': MultiCurve;
  'hazard-curve': SurvivalCurve;
}

export type YieldCurveMeasure = 'discount' | 'zeroRate' | 'instantaneousForward';
export type SurvivalCurveMeasure = 'survival' | 'hazard';

/** What `evaluateFittedModel` takes per family — the restored curve's own query, at dates. */
export interface CurveEvaluations {
  'discount-curve': { dates: string[]; measure: YieldCurveMeasure };
  'projection-curve': { dates: string[]; measure: YieldCurveMeasure };
  'multi-curve': {
    curve: 'discountCurve' | 'forecastCurve';
    dates: string[];
    measure: YieldCurveMeasure;
  };
  'hazard-curve': { dates: string[]; measure: SurvivalCurveMeasure };
}

export type CalibrationOf<F extends CurveModelFamily> = CurveCalibrations[F];
export type StoredCalibrationOf<F extends CurveModelFamily> = CurveStoredCalibrations[F];
export type FitOf<F extends CurveModelFamily> = CurveFits[F];
export type LiveFitOf<F extends CurveModelFamily> = CurveLiveFits[F];
export type EvaluationOf<F extends CurveModelFamily> = CurveEvaluations[F];

export interface FittedModelFamilyDescriptor {
  family: string;
  qualifiedFamily: string;
  modelVersion: number;
  calibrator: string;
  evaluator: string | null;
  warmStart: boolean;
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

function statistics(residuals: readonly number[]): {
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

export interface FamilyProjection {
  parameters: Record<string, number | number[] | string>;
  objective: FittedModelSummary['objective'];
  convergence: FittedModelSummary['convergence'];
  residuals: FittedModelSummary['residuals'];
  modelRisk: FittedModelSummary['modelRisk'];
  weighting: string | null;
}

export interface FamilySpec<F extends CurveModelFamily> {
  descriptor: FittedModelFamilyDescriptor;
  /** Dot paths of the bulk row sets inside the calibration that may be referenced by handle. */
  rowSets: readonly (readonly string[])[];
  /** Dot paths of live yield curves inside the calibration, stored as data and restored exactly. */
  liveCurves: readonly (readonly string[])[];
  calibrate(calibration: CalibrationOf<F>): LiveFitOf<F>;
  fitDataOf(fit: LiveFitOf<F>): FitOf<F>;
  fitFromData(functionName: string, data: FitOf<F>): LiveFitOf<F>;
  /** Repricing residuals (curve-implied − quoted) of every calibration instrument through the public valuation. */
  repricingResiduals(fit: LiveFitOf<F>, calibration: CalibrationOf<F>): number[];
  residualUnit: string;
  project(fit: LiveFitOf<F>, data: FitOf<F>, calibration: CalibrationOf<F>): FamilyProjection;
  evaluationKeys: readonly string[];
  evaluate(
    fit: LiveFitOf<F>,
    at: EvaluationOf<F>,
    calibratedRange: Record<string, Range>,
  ): FamilyEvaluation;
  /** The instrument partition for holdout (the projection instruments for the multi-curve family). */
  points: {
    count(calibration: CalibrationOf<F>): number;
    subset(calibration: CalibrationOf<F>, keep: readonly boolean[]): CalibrationOf<F>;
    residuals(
      fit: LiveFitOf<F>,
      calibration: CalibrationOf<F>,
      heldOut: readonly number[],
    ): number[];
    label: string;
  };
}

const CONVERGENCE = {
  converged: true,
  iterations: null,
  reason:
    'a sequential bootstrap pins one pillar per instrument; there is no iterative search over the curve as a whole',
} as const;

const NO_ARBITRAGE_NOTION =
  'arbitrage freedom is a smile notion; a bootstrapped curve reprices its instruments by construction';

function instrumentResidual(
  instrument: BootstrapInstrument,
  referenceDate: string,
  swapCurves: { discountCurve: YieldCurve; forecastCurve?: YieldCurve },
  forwardCurve: YieldCurve,
): number {
  switch (instrument.type) {
    case 'deposit':
      return (
        forwardCurve.forwardRate(
          referenceDate,
          instrument.maturity,
          instrument.dayCount ?? 'ACT/360',
        ) - instrument.rate
      );
    case 'fra':
      return (
        forwardCurve.forwardRate(
          instrument.start,
          instrument.end,
          instrument.dayCount ?? 'ACT/360',
        ) - instrument.rate
      );
    case 'future': {
      const quoted = (100 - instrument.price) / 100 - (instrument.convexityAdjustment ?? 0);
      return (
        forwardCurve.forwardRate(
          instrument.start,
          instrument.end,
          instrument.dayCount ?? 'ACT/360',
        ) - quoted
      );
    }
    case 'swap':
    case 'ois': {
      // The bootstrap's own pillar conventions, stated explicitly so the public par rate reprices
      // the SAME swap the bootstrap solved (its defaults: fixed semiannual — annual for OIS — on
      // 30/360; float quarterly on ACT/360).
      const par = swapRate(
        {
          startDate: referenceDate,
          maturityDate: instrument.maturity,
          fixedFrequency:
            instrument.fixedFrequency ?? (instrument.type === 'ois' ? 'annual' : 'semiannual'),
          fixedDayCount: instrument.fixedDayCount ?? '30/360',
          floatFrequency: instrument.floatFrequency ?? 'quarterly',
          floatDayCount: instrument.floatDayCount ?? 'ACT/360',
        },
        swapCurves,
      );
      return par - instrument.rate;
    }
  }
}

function instrumentNotes(instruments: readonly BootstrapInstrument[]): string {
  const counts = new Map<string, number>();
  for (const instrument of instruments)
    counts.set(instrument.type, (counts.get(instrument.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${count} ${type}`).join(', ');
}

function yieldCurveParameters(
  prefix: string,
  data: YieldCurveData,
): Record<string, number | number[] | string> {
  return {
    [`${prefix}pillars.tenorYears`]: data.pillars.map((pillar) => pillar.tenorYears),
    [`${prefix}pillars.zero`]: data.pillars.map((pillar) => pillar.zero),
    [`${prefix}pillars.discount`]: data.pillars.map((pillar) => pillar.discount),
    [`${prefix}interpolation`]: data.interpolation,
    [`${prefix}extrapolation`]: data.extrapolation,
  };
}

function yieldCurveRange(prefix: string, data: YieldCurveData): Record<string, Range> {
  return { [`${prefix}tenorYears`]: rangeOf(data.pillars.map((pillar) => pillar.tenorYears)) };
}

function yieldCurveEvaluation(
  curve: YieldCurve,
  dates: readonly string[],
  measure: YieldCurveMeasure,
  range: Range | undefined,
  evaluator: string,
): FamilyEvaluation {
  const values: number[] = [];
  const coordinates: Array<Record<string, number | string>> = [];
  let outside = 0;
  for (const date of dates) {
    const tenorYears = curve.timeTo(date);
    if (range !== undefined && (tenorYears < range.minimum || tenorYears > range.maximum))
      outside += 1;
    // `curve.extrapolation: 'throw'` refuses here on its own — the adapter never softens the curve's law.
    values.push(
      measure === 'discount'
        ? curve.discount(date)
        : measure === 'zeroRate'
          ? curve.zeroRate(date)
          : curve.instantaneousForward(date),
    );
    coordinates.push({ date, tenorYears });
  }
  const warnings: QuantWarning[] = [];
  if (outside > 0) {
    warnings.push(
      warning(
        WarningCode.CurveExtrapolated,
        `evaluateFittedModel: ${outside} date${outside === 1 ? '' : 's'} lie outside the calibrated pillar range${range !== undefined ? ` (tenor ∈ [${range.minimum}, ${range.maximum}] years)` : ''} — answered under the curve's stored '${curve.extrapolation}' extrapolation, counted and disclosed, never silent.`,
        'warn',
        { count: outside, extrapolation: curve.extrapolation },
      ),
    );
  }
  return {
    values,
    reasons: [],
    coordinates,
    unit:
      measure === 'discount'
        ? 'discount factor'
        : measure === 'zeroRate'
          ? 'continuous zero rate'
          : 'instantaneous forward rate',
    evaluator,
    options: { measure, interpolation: curve.interpolation, extrapolation: curve.extrapolation },
    outsideCalibratedRange: outside,
    warnings,
  };
}

function requireMeasure<M extends string>(
  functionName: string,
  value: unknown,
  allowed: readonly M[],
): M {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: at.measure must be one of ${allowed.join(', ')} — the curve answers one quantity per call, in that quantity's unit. Received ${typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'at.measure' },
      },
    );
  }
  return value as M;
}

const YIELD_MEASURES: readonly YieldCurveMeasure[] = [
  'discount',
  'zeroRate',
  'instantaneousForward',
];
const SURVIVAL_MEASURES: readonly SurvivalCurveMeasure[] = ['survival', 'hazard'];

function requireDates(functionName: string, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((date) => typeof date !== 'string')
  ) {
    throw new InputError(
      `${functionName}: at.dates must be a non-empty array of 'YYYY-MM-DD' strings.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'at.dates' },
      },
    );
  }
  return value as string[];
}

// ───────────────────────────────────────────── families ─────────────────────────────────────────────

function singleCurveProjection(
  fit: YieldCurve,
  data: YieldCurveData,
  instruments: readonly BootstrapInstrument[],
  residuals: number[],
  extraNotes: string[],
): FamilyProjection {
  return {
    parameters: yieldCurveParameters('', data),
    objective: {
      kind: 'exact-bootstrap',
      value: null,
      unit: 'rate',
      reason:
        'a bootstrap reprices its instruments exactly by construction; the repricing residuals are reported in residuals and by fittedModelHoldout',
    },
    convergence: CONVERGENCE,
    residuals: { ...statistics(residuals), unit: 'rate', source: 'direct-evaluator' },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: yieldCurveRange('', data),
      notes: [
        NO_ARBITRAGE_NOTION,
        `${instruments.length} instruments (${instrumentNotes(instruments)}); pillars ${data.pillars.map((pillar) => pillar.date).join(', ')}`,
        `day count ${fit.dayCount}; interpolation ${fit.interpolation}; extrapolation ${fit.extrapolation}`,
        ...extraNotes,
      ],
    },
    weighting: null,
  };
}

const discountCurve: FamilySpec<'discount-curve'> = {
  descriptor: {
    family: 'discount-curve',
    qualifiedFamily: 'fixed-income.discount-curve',
    modelVersion: 1,
    calibrator: 'curves.bootstrap',
    evaluator: 'YieldCurve.discount / zeroRate / instantaneousForward',
    warmStart: false,
    referenceableRowSets: ['instruments'],
    costClass: 'bootstrap',
    requiredData: 'deposits, FRAs, futures, and par swaps/OIS with the curve conventions',
    supportedProducts:
      'a discount curve: discount factors, zero rates, and forwards at any date; drops into MarketSnapshot via rateCurveFromYieldCurve',
  },
  rowSets: [['instruments']],
  liveCurves: [],
  calibrate: (calibration) => curves.bootstrap(calibration.instruments, calibration.options),
  fitDataOf: yieldCurveDataOf,
  fitFromData: (functionName, data) => yieldCurveFromData(functionName, 'fit', data),
  repricingResiduals: (fit, calibration) =>
    calibration.instruments.map((instrument) =>
      instrumentResidual(
        instrument,
        calibration.options.referenceDate,
        { discountCurve: fit },
        fit,
      ),
    ),
  residualUnit: 'rate',
  project: (fit, data, calibration) =>
    singleCurveProjection(
      fit,
      data,
      calibration.instruments,
      discountCurve.repricingResiduals(fit, calibration),
      [],
    ),
  evaluationKeys: ['dates', 'measure'],
  evaluate: (fit, at, range) =>
    yieldCurveEvaluation(
      fit,
      requireDates('evaluateFittedModel', at.dates),
      requireMeasure('evaluateFittedModel', at.measure, YIELD_MEASURES),
      range['tenorYears'],
      'YieldCurve',
    ),
  points: {
    count: (calibration) => calibration.instruments.length,
    subset: (calibration, keep) => ({
      ...calibration,
      instruments: calibration.instruments.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map((index) =>
        instrumentResidual(
          calibration.instruments[index]!,
          calibration.options.referenceDate,
          { discountCurve: fit },
          fit,
        ),
      ),
    label: 'instruments',
  },
};

const projectionCurve: FamilySpec<'projection-curve'> = {
  descriptor: {
    family: 'projection-curve',
    qualifiedFamily: 'fixed-income.projection-curve',
    modelVersion: 1,
    calibrator: 'curves.bootstrapProjection',
    evaluator: 'YieldCurve.discount / zeroRate / instantaneousForward',
    warmStart: false,
    referenceableRowSets: ['instruments'],
    costClass: 'bootstrap',
    requiredData:
      'par swaps (and deposits/FRAs/futures) plus the OIS discount curve they are discounted on',
    supportedProducts:
      'an index projection curve under dual-curve discounting: forwards at any date',
  },
  rowSets: [['instruments']],
  liveCurves: [['options', 'discountCurve']],
  calibrate: (calibration) =>
    curves.bootstrapProjection(calibration.instruments, calibration.options),
  fitDataOf: yieldCurveDataOf,
  fitFromData: (functionName, data) => yieldCurveFromData(functionName, 'fit', data),
  repricingResiduals: (fit, calibration) =>
    calibration.instruments.map((instrument) =>
      instrumentResidual(
        instrument,
        calibration.options.referenceDate,
        { discountCurve: calibration.options.discountCurve, forecastCurve: fit },
        fit,
      ),
    ),
  residualUnit: 'rate',
  project: (fit, data, calibration) =>
    singleCurveProjection(
      fit,
      data,
      calibration.instruments,
      projectionCurve.repricingResiduals(fit, calibration),
      ['discounted on the stored OIS curve (calibration.options.discountCurve, restored exactly)'],
    ),
  evaluationKeys: ['dates', 'measure'],
  evaluate: (fit, at, range) =>
    yieldCurveEvaluation(
      fit,
      requireDates('evaluateFittedModel', at.dates),
      requireMeasure('evaluateFittedModel', at.measure, YIELD_MEASURES),
      range['tenorYears'],
      'YieldCurve',
    ),
  points: {
    count: (calibration) => calibration.instruments.length,
    subset: (calibration, keep) => ({
      ...calibration,
      instruments: calibration.instruments.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map((index) =>
        instrumentResidual(
          calibration.instruments[index]!,
          calibration.options.referenceDate,
          { discountCurve: calibration.options.discountCurve, forecastCurve: fit },
          fit,
        ),
      ),
    label: 'instruments',
  },
};

const multiCurve: FamilySpec<'multi-curve'> = {
  descriptor: {
    family: 'multi-curve',
    qualifiedFamily: 'fixed-income.multi-curve',
    modelVersion: 1,
    calibrator: 'curves.bootstrapMultiCurve',
    evaluator:
      'YieldCurve.discount / zeroRate / instantaneousForward (discountCurve or forecastCurve)',
    warmStart: false,
    referenceableRowSets: ['options.ois', 'options.projection'],
    costClass: 'bootstrap',
    requiredData: 'OIS instruments and index instruments under one set of curve conventions',
    supportedProducts:
      'the dual-curve set { discountCurve, forecastCurve } every swap analytic consumes',
  },
  rowSets: [
    ['options', 'ois'],
    ['options', 'projection'],
  ],
  liveCurves: [],
  calibrate: (calibration) => curves.bootstrapMultiCurve(calibration.options),
  fitDataOf: (fit) => ({
    discountCurve: yieldCurveDataOf(fit.discountCurve),
    forecastCurve: yieldCurveDataOf(fit.forecastCurve),
  }),
  fitFromData: (functionName, data) => ({
    discountCurve: yieldCurveFromData(functionName, 'fit.discountCurve', data.discountCurve),
    forecastCurve: yieldCurveFromData(functionName, 'fit.forecastCurve', data.forecastCurve),
  }),
  repricingResiduals: (fit, calibration) => [
    ...calibration.options.ois.map((instrument) =>
      instrumentResidual(
        instrument,
        calibration.options.referenceDate,
        { discountCurve: fit.discountCurve },
        fit.discountCurve,
      ),
    ),
    ...calibration.options.projection.map((instrument) =>
      instrumentResidual(
        instrument,
        calibration.options.referenceDate,
        { discountCurve: fit.discountCurve, forecastCurve: fit.forecastCurve },
        fit.forecastCurve,
      ),
    ),
  ],
  residualUnit: 'rate',
  project: (fit, data, calibration) => ({
    parameters: {
      ...yieldCurveParameters('discountCurve.', data.discountCurve),
      ...yieldCurveParameters('forecastCurve.', data.forecastCurve),
    },
    objective: {
      kind: 'exact-bootstrap',
      value: null,
      unit: 'rate',
      reason:
        'both bootstraps reprice their instruments exactly by construction; the repricing residuals are reported in residuals and by fittedModelHoldout',
    },
    convergence: CONVERGENCE,
    residuals: {
      ...statistics(multiCurve.repricingResiduals(fit, calibration)),
      unit: 'rate',
      source: 'direct-evaluator',
    },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: {
        ...yieldCurveRange('discountCurve.', data.discountCurve),
        ...yieldCurveRange('forecastCurve.', data.forecastCurve),
      },
      notes: [
        NO_ARBITRAGE_NOTION,
        `OIS: ${calibration.options.ois.length} instruments (${instrumentNotes(calibration.options.ois)}); projection: ${calibration.options.projection.length} instruments (${instrumentNotes(calibration.options.projection)})`,
        `day count ${fit.discountCurve.dayCount}; interpolation ${fit.discountCurve.interpolation}; extrapolation ${fit.discountCurve.extrapolation}`,
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['curve', 'dates', 'measure'],
  evaluate: (fit, at, range) => {
    const which = requireMeasure('evaluateFittedModel', at.curve, [
      'discountCurve',
      'forecastCurve',
    ] as const);
    const answer = yieldCurveEvaluation(
      fit[which],
      requireDates('evaluateFittedModel', at.dates),
      requireMeasure('evaluateFittedModel', at.measure, YIELD_MEASURES),
      range[`${which}.tenorYears`],
      `MultiCurve.${which}`,
    );
    return { ...answer, options: { ...answer.options, curve: which } };
  },
  points: {
    count: (calibration) => calibration.options.projection.length,
    subset: (calibration, keep) => ({
      options: {
        ...calibration.options,
        projection: calibration.options.projection.filter((_, index) => keep[index] === true),
      },
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map((index) =>
        instrumentResidual(
          calibration.options.projection[index]!,
          calibration.options.referenceDate,
          { discountCurve: fit.discountCurve, forecastCurve: fit.forecastCurve },
          fit.forecastCurve,
        ),
      ),
    label: 'options.projection',
  },
};

function cdsResidual(
  quote: CdsQuote,
  options: HazardBootstrapOptions,
  survivalCurve: SurvivalCurve,
): number {
  return (
    cdsParSpread(
      {
        effectiveDate: options.referenceDate,
        maturityDate: quote.maturity,
        ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
        ...(options.frequency !== undefined ? { frequency: options.frequency } : {}),
        ...(options.dayCount !== undefined ? { dayCount: options.dayCount } : {}),
        ...(options.accrualOnDefault !== undefined
          ? { accrualOnDefault: options.accrualOnDefault }
          : {}),
        ...(options.protectionSteps !== undefined
          ? { protectionSteps: options.protectionSteps }
          : {}),
      },
      { discountCurve: options.discountCurve, survivalCurve },
    ) - quote.spread
  );
}

const hazardCurve: FamilySpec<'hazard-curve'> = {
  descriptor: {
    family: 'hazard-curve',
    qualifiedFamily: 'fixed-income.hazard-curve',
    modelVersion: 1,
    calibrator: 'bootstrapHazardFromCds',
    evaluator: 'SurvivalCurve.survival / hazard',
    warmStart: false,
    referenceableRowSets: ['quotes'],
    costClass: 'bootstrap',
    requiredData: 'CDS par spreads by maturity, the discount curve, recovery and CDS conventions',
    supportedProducts:
      'a piecewise-constant hazard curve: survival and default probabilities at any date',
  },
  rowSets: [['quotes']],
  liveCurves: [['options', 'discountCurve']],
  calibrate: (calibration) => bootstrapHazardFromCds(calibration.quotes, calibration.options),
  fitDataOf: survivalCurveDataOf,
  fitFromData: (_functionName, data) => survivalCurveFromData(data),
  repricingResiduals: (fit, calibration) =>
    calibration.quotes.map((quote) => cdsResidual(quote, calibration.options, fit)),
  residualUnit: 'spread',
  project: (fit, data, calibration) => ({
    parameters: {
      'pillars.tenorYears': data.pillars.map((pillar) => pillar.tenorYears),
      'pillars.hazard': data.pillars.map((pillar) => pillar.hazard),
      'pillars.survival': data.pillars.map((pillar) => pillar.survival),
      'pillars.cumulativeHazard': data.pillars.map((pillar) => pillar.cumulativeHazard),
    },
    objective: {
      kind: 'exact-bootstrap',
      value: null,
      unit: 'spread',
      reason:
        'each CDS pillar is solved to reprice its quote exactly; the repricing residuals are reported in residuals and by fittedModelHoldout',
    },
    convergence: {
      converged: true,
      iterations: null,
      reason:
        'one Brent solve per pillar, each converged by construction (a non-converging pillar throws)',
    },
    residuals: {
      ...statistics(hazardCurve.repricingResiduals(fit, calibration)),
      unit: 'spread',
      source: 'direct-evaluator',
    },
    modelRisk: {
      arbitrageFree: null,
      calibratedRange: { tenorYears: rangeOf(data.pillars.map((pillar) => pillar.tenorYears)) },
      notes: [
        NO_ARBITRAGE_NOTION,
        `${calibration.quotes.length} CDS quotes; recovery ${calibration.options.recovery ?? 'default'}; day count ${fit.dayCount}`,
        'discounted on the stored discount curve (calibration.options.discountCurve, restored exactly)',
      ],
    },
    weighting: null,
  }),
  evaluationKeys: ['dates', 'measure'],
  evaluate: (fit, at, range) => {
    const measure = requireMeasure('evaluateFittedModel', at.measure, SURVIVAL_MEASURES);
    const dates = requireDates('evaluateFittedModel', at.dates);
    const tenor = range['tenorYears'];
    const values: number[] = [];
    const coordinates: Array<Record<string, number | string>> = [];
    let outside = 0;
    for (const date of dates) {
      const tenorYears = fit.timeTo(date);
      if (tenor !== undefined && (tenorYears < tenor.minimum || tenorYears > tenor.maximum))
        outside += 1;
      values.push(measure === 'survival' ? fit.survival(date) : fit.hazard(date));
      coordinates.push({ date, tenorYears });
    }
    const warnings: QuantWarning[] =
      outside > 0
        ? [
            warning(
              WarningCode.CurveExtrapolated,
              `evaluateFittedModel: ${outside} date${outside === 1 ? '' : 's'} lie outside the calibrated pillar range — answered by the survival curve's flat-hazard extension, counted and disclosed.`,
              'warn',
              { count: outside },
            ),
          ]
        : [];
    return {
      values,
      reasons: [],
      coordinates,
      unit: measure === 'survival' ? 'survival probability' : 'hazard rate',
      evaluator: 'SurvivalCurve',
      options: { measure },
      outsideCalibratedRange: outside,
      warnings,
    };
  },
  points: {
    count: (calibration) => calibration.quotes.length,
    subset: (calibration, keep) => ({
      ...calibration,
      quotes: calibration.quotes.filter((_, index) => keep[index] === true),
    }),
    residuals: (fit, calibration, heldOut) =>
      heldOut.map((index) => cdsResidual(calibration.quotes[index]!, calibration.options, fit)),
    label: 'quotes',
  },
};

export const FAMILY_SPECS: { readonly [F in CurveModelFamily]: FamilySpec<F> } = {
  'discount-curve': discountCurve,
  'projection-curve': projectionCurve,
  'multi-curve': multiCurve,
  'hazard-curve': hazardCurve,
};

/** The frozen, data-only descriptor table (Program 5's registry metadata) for the curve families. */
export const FITTED_MODEL_FAMILIES: Readonly<
  Record<CurveModelFamily, FittedModelFamilyDescriptor>
> = Object.freeze(
  Object.fromEntries(
    CURVE_MODEL_FAMILIES.map((family) => [
      family,
      Object.freeze({
        ...FAMILY_SPECS[family].descriptor,
        referenceableRowSets: Object.freeze([
          ...FAMILY_SPECS[family].descriptor.referenceableRowSets,
        ]),
      }),
    ]),
  ) as Record<CurveModelFamily, FittedModelFamilyDescriptor>,
);
