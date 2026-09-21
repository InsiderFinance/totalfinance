/**
 * Static no-arbitrage diagnostics for an implied-volatility surface (spec §10.1).
 *
 * Two model-free checks, both expressed in **total variance** `w(k) = σ(k)²·t` over forward
 * log-moneyness `k = ln(K/F)` — the coordinates in which the no-arbitrage conditions are clean:
 *
 *   • **Calendar arbitrage** — total variance must be non-decreasing in maturity at every fixed `k`.
 *     A drop `w(k, Tᵢ) > w(k, Tᵢ₊₁)` is a calendar spread you could lock in for free.
 *   • **Butterfly arbitrage** — the risk-neutral density implied by a smile is proportional to
 *     Gatheral's `g(k)`; `g(k) ≥ 0` everywhere ⇔ no butterfly arbitrage. This *is* the convexity of
 *     the call-price-in-strike function, so it covers the "convexity" check; monotonicity of the
 *     implied CDF follows from a non-negative density with finite wings.
 *
 * The checks operate on a light {@link ArbitrageSlice} abstraction (forward, maturity, an `iv(strike)`
 * function, and the fitted strike range), so they apply equally to raw, interpolated, SVI, and SABR
 * surfaces. {@link surfaceArbitrageReport} adapts a {@link VolatilitySurface} to it.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  validateClosedRequest,
} from '@totalfinance/core';
import type { VolatilitySurface } from './surface.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/** A single expiry slice, as the arbitrage checks see it. */
export interface ArbitrageSlice {
  expiry: string;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Forward price `S·e^{(r−q)t}`. */
  forward: number;
  /** Implied volatility at an absolute strike. */
  impliedVolatility: (strike: number) => number;
  /** Fitted strike range `[Kmin, Kmax]`. */
  strikeRange: [number, number];
  /**
   * The slice's actual strike ladder, when known. Used ONLY to size the DEFAULT scan grids: the
   * checks then sample at least {@link SAMPLES_PER_STRIKE_GAP} points per adjacent-strike gap, so a
   * violation planted at a single strike cannot hide between two scan points (an explicit
   * `butterflyPoints`/`calendarPoints` still wins). Omitted ⇒ the fixed 40/21-point defaults.
   */
  strikes?: readonly number[];
}

export type ArbitrageKind = 'calendar' | 'butterfly';

export interface ArbitrageViolation {
  kind: ArbitrageKind;
  /** The expiry where the breach occurs (the later expiry for a calendar breach). */
  expiry: string;
  /** Approximate strike of the worst breach. */
  strike: number;
  /** Forward log-moneyness of the worst breach. */
  logMoneyness: number;
  /** Severity: the total-variance drop (calendar) or the most-negative `g(k)` (butterfly). */
  magnitude: number;
  message: string;
}

export interface ArbitrageReport {
  /** True when no calendar or butterfly violation was found. */
  arbitrageFree: boolean;
  violations: ArbitrageViolation[];
  /** Per-check pass/fail summary. */
  checks: { calendar: boolean; butterfly: boolean };
  /** Applied conventions/knobs, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    tolerance: number;
    butterflyPoints: number;
    calendarPoints: number;
    step: number;
  };
  /** Structured warnings (carried-through surface warnings live here); always present. */
  diagnostics: Diagnostics;
}

/** The conventions echoed by the per-check envelopes ({@link checkCalendar} / {@link checkButterfly}). */
type ArbitrageCheckExtra = { tolerance: number; points: number; step?: number };

/** The documented {@link ArbitrageSlice} fields (Law 12 allowlist). */
const ARB_SLICE_KEYS = [
  'expiry',
  'timeToExpiryYears',
  'forward',
  'impliedVolatility',
  'strikeRange',
  'strikes',
] as const;

/** Fixed floors — the scan is never COARSER than the historical defaults, only finer. */
const DEFAULT_BUTTERFLY_POINTS = 40;
const DEFAULT_CALENDAR_POINTS = 21;

/**
 * Hard cap on EXPLICIT butterflyPoints/calendarPoints (2026-08-23 review, P0): both counts drive
 * per-slice (or per-adjacent-pair) scans where every point is a full smile evaluation, so an
 * "integer" of 1e308 was unbounded synchronous work. Density-scaled DEFAULTS are already bounded
 * by {@link MAX_SCAN_POINTS} (2,001); a caller asking explicitly may go further, but 10,000 points
 * per slice — 250–500× the 40/21 defaults — is single-digit seconds across a realistic expiry
 * ladder, and a violation needing finer sampling than that is below any tradable tolerance.
 */
const MAX_EXPLICIT_SCAN_POINTS = 10_000;

/**
 * Scan samples per adjacent-strike gap when a slice carries its {@link ArbitrageSlice.strikes} ladder.
 * The fixed 21/40-point defaults are a scan RESOLUTION, and a resolution coarser than the strike
 * ladder cannot see a one-strike violation: on a 101-strike chain the 40-point butterfly grid steps
 * ~2.5 strikes, so a density trough planted at a single strike sat between two samples and the report
 * certified `arbitrageFree: true` — while the same check at `butterflyPoints: 401` found it. Two
 * samples per gap is the Nyquist floor for a feature one gap wide.
 */
const SAMPLES_PER_STRIKE_GAP = 2;

/** Upper bound on a density-scaled default grid (a 5000-strike chain must not scan forever). */
const MAX_SCAN_POINTS = 2001;

/** The smallest adjacent gap, in log-moneyness, across the given slices' ladders (∞ if unknown). */
function minimumStrikeGap(slices: readonly ArbitrageSlice[]): number {
  let smallest = Infinity;
  for (const slice of slices) {
    const ladder = slice.strikes;
    if (ladder === undefined || ladder.length < 2) continue;
    const ks = [...ladder]
      .filter((K) => K > 0 && Number.isFinite(K))
      .map((K) => Math.log(K / slice.forward))
      .sort((a, b) => a - b);
    for (let i = 1; i < ks.length; i++) {
      const gap = ks[i]! - ks[i - 1]!;
      if (gap > 0 && gap < smallest) smallest = gap;
    }
  }
  return smallest;
}

/**
 * Default sample count for a `[kLo, kHi]` scan: at least {@link SAMPLES_PER_STRIKE_GAP} per
 * adjacent-strike `gap`, never below `floorPoints`, never above {@link MAX_SCAN_POINTS}.
 */
function densityScaledPoints(kLo: number, kHi: number, gap: number, floorPoints: number): number {
  if (!(gap > 0) || !Number.isFinite(gap) || !(kHi > kLo)) return floorPoints;
  const wanted = Math.ceil(((kHi - kLo) / gap) * SAMPLES_PER_STRIKE_GAP) + 1;
  return Math.min(MAX_SCAN_POINTS, Math.max(floorPoints, wanted));
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. The `slices` ARRAY arguments carry no
 * generated key (top-level arrays are not closed requests), so their per-element checks stay
 * curated in {@link validateSlice}.
 */
function arbitrageSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `arbitrage: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const CHECK_BUTTERFLY_SLICE_SPEC = arbitrageSpecOf('checkButterfly#0');
const CHECK_BUTTERFLY_OPTIONS_SPEC = arbitrageSpecOf('checkButterfly#1');
const CHECK_CALENDAR_OPTIONS_SPEC = arbitrageSpecOf('checkCalendar#1');
const ARBITRAGE_REPORT_OPTIONS_SPEC = arbitrageSpecOf('arbitrageReport#1');
const SURFACE_ARBITRAGE_REPORT_OPTIONS_SPEC = arbitrageSpecOf('surfaceArbitrageReport#1');

const ARB_SLICE_EXAMPLE =
  "{ expiry: '2026-06-19', timeToExpiryYears: 0.5, forward: 100, " +
  'impliedVolatility: (strike) => 0.2, strikeRange: [50, 150] }';
const CHECK_BUTTERFLY_EXAMPLE = (): string =>
  `checkButterfly(${ARB_SLICE_EXAMPLE}, { tolerance: 1e-4 })`;
const CHECK_CALENDAR_EXAMPLE = (): string =>
  `checkCalendar([${ARB_SLICE_EXAMPLE}], { tolerance: 1e-4 })`;
const ARBITRAGE_REPORT_EXAMPLE = (): string =>
  `arbitrageReport([${ARB_SLICE_EXAMPLE}], { tolerance: 1e-4 })`;
const SURFACE_ARBITRAGE_REPORT_EXAMPLE = (): string =>
  'surfaceArbitrageReport(volatilitySurface({ quotes, market }), { tolerance: 1e-4 })';

/**
 * The domain residue for one slice the spec cannot express: positive maturity/forward and a
 * positive fitted strike range.
 */
function requireSliceDomain(functionName: string, label: string, slice: ArbitrageSlice): void {
  ensurePositive(slice.timeToExpiryYears, `${label}.timeToExpiryYears`, functionName);
  ensurePositive(slice.forward, `${label}.forward`, functionName);
  ensurePositive(slice.strikeRange[0]!, `${label}.strikeRange[0]`, functionName);
  ensurePositive(slice.strikeRange[1]!, `${label}.strikeRange[1]`, functionName);
}

/** Validate one {@link ArbitrageSlice}: known keys, a callable smile, and positive `t`/`forward`. */
function validateSlice(functionName: string, label: string, slice: ArbitrageSlice): void {
  requireArgumentObject(functionName, label, slice);
  ensureKnownKeys(functionName, label, slice, ARB_SLICE_KEYS);
  if (typeof slice.impliedVolatility !== 'function') {
    throw new InputError(
      `${functionName}: ${label} is { expiry, timeToExpiryYears, forward, impliedVolatility(strike), strikeRange } (an ArbitrageSlice) — impliedVolatility must be a function strike → implied vol.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.impliedVolatility` },
      },
    );
  }
  requireArgumentArray(functionName, `${label}.strikeRange`, slice.strikeRange as unknown);
  // The optional ladder sizes the default scan grid — a non-array here would silently spread into
  // garbage gaps and quietly restore the coarse fixed default.
  if (slice.strikes !== undefined) {
    requireArgumentArray(functionName, `${label}.strikes`, slice.strikes as unknown);
  }
  requireSliceDomain(functionName, label, slice);
}

/** Knobs used only by the butterfly-density scan. */
export interface ButterflyCheckOptions {
  /** Log-moneyness samples per slice for the butterfly check (default 40, must be ≥ 3). */
  butterflyPoints?: number;
  /** Central-difference step in log-moneyness for the density derivatives (default 0.01, must be > 0). */
  step?: number;
  /** Tolerance below which a breach is reported (default 1e-4, must be finite ≥ 0). */
  tolerance?: number;
}

/** Knobs used only by the calendar total-variance scan. */
export interface CalendarCheckOptions {
  /** Log-moneyness samples for each calendar pair (default 21, must be ≥ 2). */
  calendarPoints?: number;
  /** Tolerance below which a breach is reported (default 1e-4, must be finite ≥ 0). */
  tolerance?: number;
}

/** Combined knobs for reports that deliberately run both checks. */
export interface ArbitrageCheckOptions extends ButterflyCheckOptions, CalendarCheckOptions {}

/**
 * Validate the diagnostic knobs so a degenerate setting (e.g. `step: 0`, `butterflyPoints: 1`) can't
 * silently turn a real arbitrage into a false `arbitrageFree: true` pass.
 */
function validateCheckOptions(options: ArbitrageCheckOptions, functionName: string): void {
  const tolerance = options.tolerance ?? 1e-4;
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) {
    throw new InputError(
      `${functionName}: tolerance must be a finite number ≥ 0, got ${tolerance}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { tolerance },
      },
    );
  }
  if (options.step !== undefined && !(options.step > 0 && Number.isFinite(options.step))) {
    throw new InputError(
      `${functionName}: step must be a finite number > 0, got ${options.step}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { step: options.step },
      },
    );
  }
  // Safe integers AND work caps (2026-08-23 review, P0): both counts drive per-slice smile-scan
  // loops — see MAX_EXPLICIT_SCAN_POINTS for the caps' price.
  if (
    options.butterflyPoints !== undefined &&
    (!Number.isSafeInteger(options.butterflyPoints) ||
      options.butterflyPoints < 3 ||
      options.butterflyPoints > MAX_EXPLICIT_SCAN_POINTS)
  ) {
    throw new InputError(
      `${functionName}: butterflyPoints must be an integer in [3, ${MAX_EXPLICIT_SCAN_POINTS.toLocaleString('en-US')}] — every point is a full smile evaluation per slice, so the cap keeps the scan single-digit seconds (the default is ${DEFAULT_BUTTERFLY_POINTS}), got ${options.butterflyPoints}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { butterflyPoints: options.butterflyPoints, max: MAX_EXPLICIT_SCAN_POINTS },
      },
    );
  }
  if (
    options.calendarPoints !== undefined &&
    (!Number.isSafeInteger(options.calendarPoints) ||
      options.calendarPoints < 2 ||
      options.calendarPoints > MAX_EXPLICIT_SCAN_POINTS)
  ) {
    throw new InputError(
      `${functionName}: calendarPoints must be an integer in [2, ${MAX_EXPLICIT_SCAN_POINTS.toLocaleString('en-US')}] — every point is a total-variance comparison across an adjacent expiry pair, so the cap keeps the scan single-digit seconds (the default is ${DEFAULT_CALENDAR_POINTS}), got ${options.calendarPoints}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { calendarPoints: options.calendarPoints, max: MAX_EXPLICIT_SCAN_POINTS },
      },
    );
  }
}

/**
 * The validated calendar scan shared by {@link checkCalendar} and {@link arbitrageReport}. Reports the
 * largest sample count it actually used, so the envelope echoes the scan that ran (a density-scaled
 * default is not the documented 21).
 */
function calendarViolations(
  slices: ArbitrageSlice[],
  options: ArbitrageCheckOptions,
): { violations: ArbitrageViolation[]; points: number } {
  const tolerance = options.tolerance ?? 1e-4;
  const sorted = [...slices].sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);
  const out: ArbitrageViolation[] = [];
  let pointsUsed = options.calendarPoints ?? DEFAULT_CALENDAR_POINTS;
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    // overlapping forward-log-moneyness range
    const kMin = Math.max(
      Math.log(lo.strikeRange[0] / lo.forward),
      Math.log(hi.strikeRange[0] / hi.forward),
    );
    const kMax = Math.min(
      Math.log(lo.strikeRange[1] / lo.forward),
      Math.log(hi.strikeRange[1] / hi.forward),
    );
    if (kMax <= kMin) continue;
    // Scan resolution follows the DENSER of the two ladders — a violation that lives on one strike of
    // the near expiry must not be missed because the far expiry is sparse.
    const pts =
      options.calendarPoints ??
      densityScaledPoints(kMin, kMax, minimumStrikeGap([lo, hi]), DEFAULT_CALENDAR_POINTS);
    if (pts > pointsUsed) pointsUsed = pts;
    let worst = 0;
    let worstK = NaN;
    for (let j = 0; j < pts; j++) {
      const k = kMin + ((kMax - kMin) * j) / (pts - 1);
      const vLo = lo.impliedVolatility(lo.forward * Math.exp(k));
      const vHi = hi.impliedVolatility(hi.forward * Math.exp(k));
      const drop = vLo * vLo * lo.timeToExpiryYears - vHi * vHi * hi.timeToExpiryYears; // > 0 ⇒ variance fell with maturity
      if (drop > worst) {
        worst = drop;
        worstK = k;
      }
    }
    if (worst > tolerance) {
      out.push({
        kind: 'calendar',
        expiry: hi.expiry,
        logMoneyness: worstK,
        strike: hi.forward * Math.exp(worstK),
        magnitude: worst,
        message: `Total variance falls by ${worst.toFixed(6)} from ${lo.expiry} to ${hi.expiry} near k=${worstK.toFixed(3)} — calendar arbitrage.`,
      });
    }
  }
  return { violations: out, points: pointsUsed };
}

/**
 * Calendar arbitrage: total variance must not fall as maturity increases (at fixed
 * forward-moneyness). Envelope-shaped: `value` is the violation list, `assumptions` echoes the
 * scan knobs (`points` is the resolution actually scanned — see {@link ArbitrageSlice.strikes}), and
 * `diagnostics` is the standard warnings carrier (Law 2 analysis grammar).
 */
export function checkCalendar(
  slices: ArbitrageSlice[],
  options: CalendarCheckOptions = {},
): Computed<ArbitrageViolation[], ArbitrageCheckExtra> {
  const functionName = 'checkCalendar';
  requireArgumentArray(functionName, 'slices', slices);
  slices.forEach((s, i) => validateSlice(functionName, `slices[${i}]`, s));
  validateClosedRequest(functionName, options, CHECK_CALENDAR_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: CHECK_CALENDAR_EXAMPLE,
  });
  validateCheckOptions(options, functionName);
  const scan = calendarViolations(slices, options);
  return {
    value: scan.violations,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tolerance: options.tolerance ?? 1e-4,
      points: scan.points,
    },
    diagnostics: { engine: 'arbitrage-check', method: 'calendar', converged: true, warnings: [] },
  };
}

/**
 * The validated butterfly scan shared by {@link checkButterfly} and {@link arbitrageReport}. Reports
 * the sample count actually used (density-scaled when the slice carries its strike ladder).
 */
function butterflyViolations(
  slice: ArbitrageSlice,
  options: ArbitrageCheckOptions,
): { violations: ArbitrageViolation[]; points: number } {
  const tolerance = options.tolerance ?? 1e-4;
  const h = options.step ?? 0.01;
  const kLo = Math.log(slice.strikeRange[0] / slice.forward) + h;
  const kHi = Math.log(slice.strikeRange[1] / slice.forward) - h;
  const pts =
    options.butterflyPoints ??
    densityScaledPoints(kLo, kHi, minimumStrikeGap([slice]), DEFAULT_BUTTERFLY_POINTS);
  if (kHi <= kLo) return { violations: [], points: pts };
  const wOf = (k: number): number => {
    const v = slice.impliedVolatility(slice.forward * Math.exp(k));
    return v * v * slice.timeToExpiryYears;
  };
  let worst = Infinity;
  let worstK = NaN;
  for (let j = 0; j < pts; j++) {
    const k = kLo + ((kHi - kLo) * j) / (pts - 1);
    const w = wOf(k);
    if (!(w > 0)) continue;
    const wp = (wOf(k + h) - wOf(k - h)) / (2 * h);
    const wpp = (wOf(k + h) - 2 * w + wOf(k - h)) / (h * h);
    const a = 1 - (k * wp) / (2 * w);
    const g = a * a - ((wp * wp) / 4) * (1 / w + 0.25) + wpp / 2;
    if (g < worst) {
      worst = g;
      worstK = k;
    }
  }
  if (worst < -tolerance) {
    return {
      violations: [
        {
          kind: 'butterfly',
          expiry: slice.expiry,
          logMoneyness: worstK,
          strike: slice.forward * Math.exp(worstK),
          magnitude: worst,
          message: `Implied risk-neutral density goes negative (g=${worst.toFixed(6)}) near k=${worstK.toFixed(3)} in ${slice.expiry} — butterfly arbitrage.`,
        },
      ],
      points: pts,
    };
  }
  return { violations: [], points: pts };
}

/**
 * Butterfly arbitrage: Gatheral's `g(k)` (∝ risk-neutral density) must stay non-negative.
 * Envelope-shaped: `value` is the violation list, `assumptions.points` the resolution actually
 * scanned (density-scaled from {@link ArbitrageSlice.strikes} when present) (Law 2 analysis grammar).
 */
export function checkButterfly(
  slice: ArbitrageSlice,
  options: ButterflyCheckOptions = {},
): Computed<ArbitrageViolation[], ArbitrageCheckExtra> {
  const functionName = 'checkButterfly';
  validateClosedRequest(functionName, slice, CHECK_BUTTERFLY_SLICE_SPEC, {
    argumentName: 'slice',
    exampleCall: CHECK_BUTTERFLY_EXAMPLE,
  });
  validateClosedRequest(functionName, options, CHECK_BUTTERFLY_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: CHECK_BUTTERFLY_EXAMPLE,
  });
  requireSliceDomain(functionName, 'slice', slice);
  validateCheckOptions(options, functionName);
  const scan = butterflyViolations(slice, options);
  return {
    value: scan.violations,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tolerance: options.tolerance ?? 1e-4,
      points: scan.points,
      step: options.step ?? 0.01,
    },
    diagnostics: { engine: 'arbitrage-check', method: 'butterfly', converged: true, warnings: [] },
  };
}

/** Build the {@link ArbitrageReport} for validated slices (shared by the two public report fronts). */
function reportFor(
  slices: ArbitrageSlice[],
  options: ArbitrageCheckOptions,
  warnings: QuantWarning[],
): ArbitrageReport {
  const calendar = calendarViolations(slices, options);
  const butterfly = slices.map((s) => butterflyViolations(s, options));
  const violations: ArbitrageViolation[] = [
    ...calendar.violations,
    ...butterfly.flatMap((b) => b.violations),
  ];
  return {
    arbitrageFree: violations.length === 0,
    violations,
    checks: {
      calendar: !violations.some((v) => v.kind === 'calendar'),
      butterfly: !violations.some((v) => v.kind === 'butterfly'),
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tolerance: options.tolerance ?? 1e-4,
      // The FINEST resolution any slice/pair was scanned at (defaults follow strike density, so a
      // report that echoed the documented 40/21 would misdescribe the scan that actually ran).
      butterflyPoints: butterfly.reduce((m, b) => Math.max(m, b.points), DEFAULT_BUTTERFLY_POINTS),
      calendarPoints: calendar.points,
      step: options.step ?? 0.01,
    },
    diagnostics: {
      engine: 'arbitrage-report',
      method: 'calendar + butterfly',
      converged: true,
      warnings,
    },
  };
}

/** Run all static no-arbitrage checks over a set of slices (Law 2 report grammar). */
export function arbitrageReport(
  slices: ArbitrageSlice[],
  options: ArbitrageCheckOptions = {},
): ArbitrageReport {
  const functionName = 'arbitrageReport';
  requireArgumentArray(functionName, 'slices', slices);
  slices.forEach((s, i) => validateSlice(functionName, `slices[${i}]`, s));
  validateClosedRequest(functionName, options, ARBITRAGE_REPORT_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: ARBITRAGE_REPORT_EXAMPLE,
  });
  validateCheckOptions(options, functionName);
  return reportFor(slices, options, []);
}

/**
 * Adapt a {@link VolatilitySurface} to {@link arbitrageReport}, carrying its sparse-data warnings through
 * into `diagnostics.warnings`.
 */
export function surfaceArbitrageReport(
  surface: VolatilitySurface,
  options: ArbitrageCheckOptions = {},
): ArbitrageReport {
  const functionName = 'surfaceArbitrageReport';
  requireArgumentObject(functionName, 'surface', surface);
  requireArgumentArray(
    functionName,
    'surface.slices',
    (surface as { slices?: unknown }).slices as never,
  );
  validateClosedRequest(functionName, options, SURFACE_ARBITRAGE_REPORT_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: SURFACE_ARBITRAGE_REPORT_EXAMPLE,
  });
  validateCheckOptions(options, functionName);
  const slices: ArbitrageSlice[] = surface.slices.map((s) => ({
    expiry: s.expiry,
    timeToExpiryYears: s.timeToExpiryYears,
    forward: s.forward,
    impliedVolatility: (strike: number) => surface.impliedVolatility(strike, s.expiry),
    strikeRange: [s.strikes[0]!, s.strikes[s.strikes.length - 1]!],
    // Copy, don't alias — and hand the scan the real ladder so its default resolution can see a
    // violation that lives on a single strike of a dense chain.
    strikes: [...s.strikes],
  }));
  // Copy, don't alias: handing out the surface's live warnings array would let a caller who pushes
  // into the report's warnings silently mutate the surface's own diagnostics.
  return reportFor(slices, options, [...surface.diagnostics.warnings]);
}
