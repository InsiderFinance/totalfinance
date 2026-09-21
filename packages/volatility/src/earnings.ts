/**
 * Earnings / event-vol modeling (spec §10.3, roadmap Tier 2). The term-structure layer over the
 * single-tenor event-vol kernels (`eventVolatilityDecomposition`, `eventStrippedVolatility`): `calibrateEventVolatility` **extracts**
 * the continuous vol `σ_base` and the discrete event jump `J` (the implied earnings move) from a whole
 * ATM-vol term structure by regression — no hand-supplied base vol — and `calibrateEventMove` compares
 * straddle-**implied** moves to subsequently-**realized** moves across past events (is the earnings
 * straddle historically over- or under-priced?).
 *
 * Model: an event at time τ adds a fixed variance `J²` to any expiry on/after it, the rest accruing
 * continuously at `σ_base` — so total variance `Vᵢ = σ_base²·Tᵢ + J²·[Tᵢ spans the event]` is linear in
 * `(σ_base², J²)` and recovered by a least-squares fit. See `docs/specs/earnings-event-vol.md`.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  isoDateToEpochMs,
  optionExpiryToMs,
  requireArgumentArray,
  requireArgumentObject,
  resolveValuationAsOf,
  usEquityMarketDateUtcMs,
  warning,
  yearFraction,
  validateClosedRequest,
  type ClosedRequestSpecification,
} from '@totalfinance/core';

import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function earningsSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `earnings: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const EVENT_VOLATILITY_AT_EXPIRY_SPEC = earningsSpecOf('eventVolatilityAtExpiry#0');
const EVENT_VOLATILITY_AT_EXPIRY_EXAMPLE =
  "eventVolatilityAtExpiry({ fit: calibrateEventVolatility({ termStructure, eventDate: '2026-05-11', asOf: '2026-05-01T10:00:00-04:00' }), expiries: ['2026-06-19'] })";

const DAY_MS = 86_400_000;

/** Whole calendar days from `asOf`'s date to an ISO date (both at midnight — no 16:00-ET inflation). */
function calendarDays(isoDate: string, asOfDayMs: EpochMs): number {
  return Math.round((isoDateToEpochMs(isoDate) - asOfDayMs) / DAY_MS);
}

/** One point on the ATM-vol term structure. */
export interface AtmVolatilityPoint {
  /** ISO expiry date → `t` computed from `asOf` (ACT/365F). */
  expiry: string;
  /** Annualized ATM implied vol (decimal). */
  atmVolatility: number;
}

/** Inputs for {@link calibrateEventVolatility}. */
export interface FitEventVolatilityOptions {
  /** The ATM-vol term structure (≥ 1 expiry; ≥ 2 to fit both `σ_base` and `J`, unless `baseVolatility` given). */
  termStructure: readonly AtmVolatilityPoint[];
  /** ISO date of the earnings/event. */
  eventDate: string;
  asOf: EpochMs | string;
  /** Pin the continuous vol when the term structure can't identify it (single expiry / no maturity spread). */
  baseVolatility?: number;
}

/** One expiry's fitted vs actual ATM vol. */
export interface FittedExpiry {
  expiry: string;
  daysToExpiry: number;
  timeToExpiryYears: number;
  atmVolatility: number;
  spansEvent: boolean;
  /** The model's ATM vol at this expiry. */
  fittedVolatility: number;
  /** `atmVolatility − fittedVolatility`. */
  residual: number;
}

/** The event-vol fit. */
export interface EventVolatilityCalibration {
  /** Annualized continuous (non-event) vol `√σ_base²`. */
  baseVolatility: number;
  /** `σ_base²` — the fitted continuous variance itself (exact; `baseVolatility` is its root). */
  baseVariance: number;
  /** Implied event move as a fraction of spot (`J`) — the "earnings move" (`spot·J` in price units). */
  eventMove: number;
  /** `J²` — the discrete event variance. */
  eventVariance: number;
  daysToEvent: number;
  perExpiry: FittedExpiry[];
  /** Fit quality on total variance (1 = perfect). */
  rSquared: number;
  assumptions: {
    conventionsVersion: string;
    method: string;
    eventDate: string;
    /** The valuation instant the maturities were measured from (epoch ms) — what {@link eventVolatilityAtExpiry} evaluates against. */
    asOf: EpochMs;
  };
  diagnostics: Diagnostics;
}

/**
 * Extract the continuous vol and the discrete event jump from an ATM-vol term structure by fitting
 * `Vᵢ = σ_base²·Tᵢ + J²·[spans]` (a 2-coefficient least-squares regression). See the spec.
 */
export function calibrateEventVolatility(
  options: FitEventVolatilityOptions,
): EventVolatilityCalibration {
  const functionName = 'calibrateEventVolatility';
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, [
    'termStructure',
    'eventDate',
    'asOf',
    'baseVolatility',
  ]);
  requireArgumentArray(functionName, 'options.termStructure', options.termStructure as never);
  if (typeof options.eventDate !== 'string') {
    throw new InputError(`${functionName}: eventDate must be an ISO date string.`, {
      code: ErrorCode.InputWrongType,
      context: { eventDate: typeof options.eventDate },
    });
  }
  if (options.termStructure.length === 0) {
    throw new InputError(`${functionName}: termStructure must have at least one expiry.`, {
      code: ErrorCode.InputOutOfRange,
      context: { points: 0 },
    });
  }
  const asOfMs = resolveValuationAsOf(options.asOf, functionName);
  // Whole-day counts run between America/New_York calendar dates, not UTC dates: a 21:00 ET
  // snapshot is already tomorrow in UTC and would report one day fewer than the trader's calendar.
  const asOfDayMs = usEquityMarketDateUtcMs(asOfMs);
  const eventMs = optionExpiryToMs(options.eventDate);

  // Per-expiry (t, spans, total variance V = σ²·t).
  const rows = options.termStructure.map((p, i) => {
    requireArgumentObject(functionName, `termStructure[${i}]`, p);
    ensureKnownKeys(functionName, `termStructure[${i}]`, p, ['expiry', 'atmVolatility']);
    if (typeof p.expiry !== 'string') {
      throw new InputError(
        `${functionName}: termStructure[${i}].expiry must be an ISO date string.`,
        {
          code: ErrorCode.InputWrongType,
          context: { index: i },
        },
      );
    }
    ensurePositive(p.atmVolatility, `termStructure[${i}].atmVolatility`, functionName);
    const expiryMs = optionExpiryToMs(p.expiry);
    const t = yearFraction(asOfMs, expiryMs, 'ACT/365F');
    if (!(t > 0)) {
      throw new InputError(
        `${functionName}: termStructure[${i}] (${p.expiry}) is not after asOf.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, expiry: p.expiry },
        },
      );
    }
    return {
      expiry: p.expiry,
      atmVolatility: p.atmVolatility,
      t,
      spans: expiryMs >= eventMs,
      v: p.atmVolatility * p.atmVolatility * t,
    };
  });

  const warnings: QuantWarning[] = [];
  const spanningCount = rows.filter((r) => r.spans).length;

  let baseVar: number; // σ_base²
  let eventVar: number; // J²
  if (options.baseVolatility !== undefined) {
    // Caller pins the continuous vol — solve the jump from the spanning expiries' excess variance.
    ensureNonNegative(options.baseVolatility, 'baseVolatility', functionName);
    baseVar = options.baseVolatility * options.baseVolatility;
    const excesses = rows.filter((r) => r.spans).map((r) => r.v - baseVar * r.t);
    eventVar = excesses.length > 0 ? excesses.reduce((a, b) => a + b, 0) / excesses.length : 0;
  } else if (spanningCount === 0) {
    // No option captures the event → J is unidentifiable; report the continuous vol only.
    const st2 = rows.reduce((a, r) => a + r.t * r.t, 0);
    const stv = rows.reduce((a, r) => a + r.t * r.v, 0);
    baseVar = st2 > 0 ? stv / st2 : 0;
    eventVar = 0;
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `no expiry spans the event date ${options.eventDate}; the event move cannot be extracted (eventMove = 0). Include an expiry on/after the event.`,
        'warn',
        { eventDate: options.eventDate },
      ),
    );
  } else {
    // Least-squares fit of V on [t, spans]: XᵀX = [[Σt², Σt·s],[Σt·s, Σs]] (s ∈ {0,1} ⇒ s² = s).
    const st2 = rows.reduce((a, r) => a + r.t * r.t, 0);
    const sts = rows.reduce((a, r) => a + (r.spans ? r.t : 0), 0);
    const ss = spanningCount;
    const stv = rows.reduce((a, r) => a + r.t * r.v, 0);
    const ssv = rows.reduce((a, r) => a + (r.spans ? r.v : 0), 0);
    const det = st2 * ss - sts * sts;
    if (!(Math.abs(det) > 1e-12 * (st2 * ss + 1))) {
      throw new InputError(
        `${functionName}: the term structure can't separate the continuous vol from the event jump (need ≥ 2 expiries with different maturities, at least one spanning the event, or pass baseVolatility).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { spanningExpiries: ss, expiries: rows.length },
        },
      );
    }
    baseVar = (ss * stv - sts * ssv) / det;
    eventVar = (st2 * ssv - sts * stv) / det;
  }

  // Clamp a physically-impossible fit and disclose it (no fabricated positive move).
  if (baseVar < 0) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `fitted continuous variance was negative (${baseVar}); clamped to 0.`,
        'warn',
        {
          baseVar,
        },
      ),
    );
    baseVar = 0;
  }
  if (eventVar < 0) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `no positive event premium — implied vol falls through the event (fitted event variance ${eventVar}); eventMove clamped to 0.`,
        'warn',
        { eventVar },
      ),
    );
    eventVar = 0;
  }

  const perExpiry: FittedExpiry[] = rows.map((r) => {
    const fittedVolatility = modelAtmVolatility({
      baseVariance: baseVar,
      eventVariance: eventVar,
      timeToExpiryYears: r.t,
      spansEvent: r.spans,
    });
    return {
      expiry: r.expiry,
      daysToExpiry: calendarDays(r.expiry, asOfDayMs),
      timeToExpiryYears: r.t,
      atmVolatility: r.atmVolatility,
      spansEvent: r.spans,
      fittedVolatility,
      residual: r.atmVolatility - fittedVolatility,
    };
  });

  // R² on total variance, against the reported (clamped) model.
  const vBar = rows.reduce((a, r) => a + r.v, 0) / rows.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const r of rows) {
    const fittedVar = baseVar * r.t + (r.spans ? eventVar : 0);
    ssRes += (r.v - fittedVar) * (r.v - fittedVar);
    ssTot += (r.v - vBar) * (r.v - vBar);
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return {
    baseVolatility: Math.sqrt(baseVar),
    baseVariance: baseVar,
    eventMove: Math.sqrt(eventVar),
    eventVariance: eventVar,
    daysToEvent: calendarDays(options.eventDate, asOfDayMs),
    perExpiry,
    rSquared,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method:
        options.baseVolatility !== undefined
          ? 'pinned-base + excess-variance'
          : 'ols variance ~ [t, spans]',
      eventDate: options.eventDate,
      asOf: asOfMs,
    },
    diagnostics: {
      engine: 'event-vol-fit',
      method: 'additive-event-variance',
      converged: true,
      warnings,
    },
  };
}

/**
 * The additive-event-variance model's ATM volatility at maturity `t`: `√(σ_base²·t + J²·[spans]) / √t`.
 * The ONE formula behind the calibrator's `perExpiry.fittedVolatility` and the direct evaluator
 * {@link eventVolatilityAtExpiry} (Stage 4.5 — one engine, two doors).
 */
function modelAtmVolatility(input: {
  baseVariance: number;
  eventVariance: number;
  timeToExpiryYears: number;
  spansEvent: boolean;
}): number {
  const fittedVariance =
    input.baseVariance * input.timeToExpiryYears + (input.spansEvent ? input.eventVariance : 0);
  return Math.sqrt(Math.max(0, fittedVariance) / input.timeToExpiryYears);
}

/** One evaluated expiry of {@link eventVolatilityAtExpiry}. */
export interface EventVolatilityAtExpiryRow {
  expiry: string;
  daysToExpiry: number;
  timeToExpiryYears: number;
  spansEvent: boolean;
  /** The model's annualized ATM volatility at this expiry. */
  value: number;
}

export interface EventVolatilityAtExpiryResult {
  /** The model ATM volatilities, aligned to `input.expiries`. */
  values: number[];
  rows: EventVolatilityAtExpiryRow[];
  assumptions: {
    conventionsVersion: string;
    method: 'additive-event-variance';
    eventDate: string;
    asOf: EpochMs;
    baseVolatility: number;
    eventMove: number;
  };
  diagnostics: Diagnostics;
}

/**
 * Evaluate a fitted event-volatility model at any expiries — the forward door of
 * {@link calibrateEventVolatility}: the ATM volatility the model implies at an expiry, whether or
 * not that expiry was in the calibration (an expiry after the event carries the jump; one before
 * it does not). Maturities are measured from the fit's own `assumptions.asOf`.
 *
 * @example
 * ```ts
 * const fit = calibrateEventVolatility({ termStructure, eventDate: '2026-05-11', asOf: '2026-05-01T10:00:00-04:00' });
 * eventVolatilityAtExpiry({ fit, expiries: ['2026-05-08', '2026-06-19'] }).values; // [σ_base, √(σ_base² + J²/t)]
 * ```
 */
export function eventVolatilityAtExpiry(input: {
  fit: EventVolatilityCalibration;
  expiries: readonly string[];
}): EventVolatilityAtExpiryResult {
  const functionName = 'eventVolatilityAtExpiry';
  // The generated spec proves the WHOLE declared shape — `fit` is the complete calibrateEventVolatility
  // result (every field, nested assumptions/diagnostics) — so a hand-built partial "fit" teaches
  // rather than misprices; the semantic laws below are the ones a shape check cannot state.
  validateClosedRequest(functionName, input, EVENT_VOLATILITY_AT_EXPIRY_SPEC, {
    exampleCall: EVENT_VOLATILITY_AT_EXPIRY_EXAMPLE,
  });
  const record = input.fit as unknown as Record<string, unknown>;
  const teaching = ' — pass the result of calibrateEventVolatility() as input.fit.';
  for (const field of ['baseVolatility', 'baseVariance', 'eventVariance'] as const) {
    const value = record[field] as number;
    if (!(value >= 0)) {
      throw new InputError(
        `${functionName}: input.fit.${field} must be a non-negative number${teaching}`,
        { code: ErrorCode.InputOutOfRange, context: { field: `input.fit.${field}` } },
      );
    }
  }
  if (input.expiries.length === 0) {
    throw new InputError(`${functionName}: input.expiries must name at least one expiry.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'input.expiries', count: 0 },
    });
  }
  const baseVolatility = record['baseVolatility'] as number;
  const eventVar = record['eventVariance'] as number;
  // The EXACT fitted variance, not the root re-squared — so the evaluator reproduces the
  // calibrator's own perExpiry.fittedVolatility bit for bit (one engine, two doors).
  const baseVar = record['baseVariance'] as number;
  const eventDate = input.fit.assumptions.eventDate;
  const asOfMs = input.fit.assumptions.asOf;
  // Whole-day counts run between America/New_York calendar dates, not UTC dates: a 21:00 ET
  // snapshot is already tomorrow in UTC and would report one day fewer than the trader's calendar.
  const asOfDayMs = usEquityMarketDateUtcMs(asOfMs);
  const eventMs = optionExpiryToMs(eventDate);
  const rows: EventVolatilityAtExpiryRow[] = input.expiries.map((expiry, index) => {
    if (typeof expiry !== 'string') {
      throw new InputError(
        `${functionName}: input.expiries[${index}] must be an ISO date string.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `input.expiries[${index}]` },
        },
      );
    }
    const expiryMs = optionExpiryToMs(expiry);
    const t = yearFraction(asOfMs, expiryMs, 'ACT/365F');
    if (!(t > 0)) {
      throw new InputError(
        `${functionName}: input.expiries[${index}] (${expiry}) is not after the fit's asOf — the model has no maturity to evaluate there.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `input.expiries[${index}]`, expiry } },
      );
    }
    const spansEvent = expiryMs >= eventMs;
    return {
      expiry,
      daysToExpiry: calendarDays(expiry, asOfDayMs),
      timeToExpiryYears: t,
      spansEvent,
      value: modelAtmVolatility({
        baseVariance: baseVar,
        eventVariance: eventVar,
        timeToExpiryYears: t,
        spansEvent,
      }),
    };
  });
  return {
    values: rows.map((row) => row.value),
    rows,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'additive-event-variance',
      eventDate,
      asOf: asOfMs,
      baseVolatility,
      eventMove: Math.sqrt(eventVar),
    },
    diagnostics: {
      engine: 'event-vol-fit',
      method: 'additive-event-variance',
      converged: true,
      warnings: [],
    },
  };
}

/** One past event: the straddle-implied move before it and the realized move after. */
export interface EventMoveObservation {
  /** Straddle-implied move BEFORE the event (fraction of spot), > 0. */
  impliedMove: number;
  /** Realized |move| AFTER the event (fraction of spot), ≥ 0. */
  realizedMove: number;
  /** Optional label (e.g. the event date). */
  date?: string;
}

/** One calibrated past event. */
export interface CalibratedEvent extends EventMoveObservation {
  /** `realizedMove − impliedMove`. */
  error: number;
  /** `impliedMove > realizedMove` — the straddle seller won. */
  overpriced: boolean;
}

/** The straddle-implied vs realized-move calibration. */
export interface EventMoveCalibration {
  count: number;
  averageImplied: number;
  averageRealized: number;
  /** `averageRealized / averageImplied` — > 1 ⇒ the stock moves MORE than the straddle prices. */
  ratio: number;
  /** Fraction of events where implied > realized (how often selling the straddle won). */
  overpricedFraction: number;
  /** Mean `realized − implied` — positive ⇒ straddles underpriced on average. */
  bias: number;
  /** Mean `|realized − implied|`. */
  meanAbsoluteError: number;
  perEvent: CalibratedEvent[];
  assumptions: { conventionsVersion: string; method: string };
  diagnostics: Diagnostics;
}

/**
 * Calibrate the earnings straddle: compare each past event's implied move (before) to its realized move
 * (after), and aggregate — the ratio, how often selling the straddle won, and the average bias. A
 * historical statistic (not a forecast). See the spec.
 */
export function calibrateEventMove(
  observations: readonly EventMoveObservation[],
): EventMoveCalibration {
  const functionName = 'calibrateEventMove';
  requireArgumentArray(functionName, 'observations', observations as never);
  if (observations.length === 0) {
    throw new InputError(`${functionName}: observations must have at least one event.`, {
      code: ErrorCode.InputOutOfRange,
      context: { count: 0 },
    });
  }
  const perEvent: CalibratedEvent[] = observations.map((o, i) => {
    requireArgumentObject(functionName, `observations[${i}]`, o);
    ensureKnownKeys(functionName, `observations[${i}]`, o, ['impliedMove', 'realizedMove', 'date']);
    ensurePositive(o.impliedMove, `observations[${i}].impliedMove`, functionName);
    ensureNonNegative(o.realizedMove, `observations[${i}].realizedMove`, functionName);
    return {
      ...o,
      error: o.realizedMove - o.impliedMove,
      overpriced: o.impliedMove > o.realizedMove,
    };
  });
  const n = perEvent.length;
  const averageImplied = perEvent.reduce((a, p) => a + p.impliedMove, 0) / n;
  const averageRealized = perEvent.reduce((a, p) => a + p.realizedMove, 0) / n;
  const bias = perEvent.reduce((a, p) => a + p.error, 0) / n;
  const meanAbsoluteError = perEvent.reduce((a, p) => a + Math.abs(p.error), 0) / n;
  const overpricedFraction = perEvent.filter((p) => p.overpriced).length / n;
  return {
    count: n,
    averageImplied,
    averageRealized,
    ratio: averageRealized / averageImplied, // averageImplied > 0 (each impliedMove > 0)
    overpricedFraction,
    bias,
    meanAbsoluteError,
    perEvent,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'implied-vs-realized calibration',
    },
    diagnostics: {
      engine: 'event-move-calibration',
      method: 'historical',
      converged: true,
      warnings: [],
    },
  };
}
