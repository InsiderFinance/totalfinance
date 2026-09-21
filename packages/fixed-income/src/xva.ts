/**
 * Counterparty valuation adjustments — CVA / DVA / FVA (spec §14.4, previously "later"). A Hull-White
 * one-factor **exposure simulator** drives them: simulate the short rate forward (exact Ornstein-
 * Uhlenbeck transitions) along a pathwise stochastic discount factor, value the remaining swap
 * **analytically** at each exposure date (the Hull-White bond reconstruction — no regression needed),
 * and aggregate the discounted expected positive/negative exposure against the counterparty / own
 * survival curves and recovery.
 *
 * - **CVA** = `(1 − R꜀) · Σ DiscEPE(tₖ) · [Q꜀(tₖ₋₁) − Q꜀(tₖ)]` — the cost of the counterparty defaulting.
 * - **DVA** = `(1 − Rₒ) · Σ DiscENE(tₖ) · [Qₒ(tₖ₋₁) − Qₒ(tₖ)]` — the symmetric own-default benefit.
 * - **FVA** ≈ `fundingSpread · Σ DiscEPE(tₖ) · Δtₖ` — the funding cost of the expected positive exposure.
 *
 * Seeded and deterministic; the simulator is validated by an internal martingale check (the simulated
 * stochastic discount factor reprices a zero-coupon bond).
 */

import {
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  CONVENTIONS_VERSION,
  type Diagnostics,
} from '@totalfinance/core';
import {
  ensureDayCountWhenPresent,
  ensureFrequencyWhenPresent,
  ensureStepsPerYearWhenPresent,
} from './validate.js';
import { mulberry32, normalInverseCdf, quantile } from '@totalfinance/math';
import {
  type FixedIncomeDayCount,
  type Frequency,
  generateSchedule,
  yearFraction,
} from './conventions.js';
import type { SurvivalCurve } from './credit.js';
import type { YieldCurve } from './curves.js';
import { hullWhite } from './models.js';

/**
 * Hard caps on the exposure simulation (2026-08-23 review, P0): `paths` and the time grid drive a
 * synchronous paths × steps Monte-Carlo where each step is Hull-White bond math and each exposure
 * date a full remaining-swap re-valuation — heavy per unit, so the bounds sit well below a naive
 * 10^7-ish loop cap. 100,000 paths is 20× the 5,000 default (MC error ∝ 1/√n gains nothing real
 * beyond it), and 10^7 total path-steps is ~8× the default workload — single-digit seconds on a
 * laptop at the ~µs-per-step cost measured for this kind of exp()-dominated math.
 */
const MAX_XVA_PATHS = 100_000;
const MAX_XVA_PATH_STEPS = 10_000_000;

export interface XvaSwapSpecification {
  /** Discount/forecast curve (single-curve); its reference date is the valuation date. */
  curve: YieldCurve;
  startDate: string;
  maturityDate: string;
  fixedRate: number;
  /** `payer` = we pay fixed; `receiver` = we receive fixed. */
  optionType: 'payer' | 'receiver';
  notional?: number;
  fixedFrequency?: Frequency;
  fixedDayCount?: FixedIncomeDayCount;
}

/** {@link XvaSwapSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const XVA_SWAP_SPEC_KEYS = [
  'curve',
  'startDate',
  'maturityDate',
  'fixedRate',
  'optionType',
  'notional',
  'fixedFrequency',
  'fixedDayCount',
] as const;

export interface XvaParameters {
  /** Hull-White mean reversion and short-rate volatility. */
  meanReversion: number;
  sigma: number;
  /** Counterparty survival curve (drives CVA). */
  counterpartySurvival: SurvivalCurve;
  /** Own survival curve (drives DVA); omit to skip DVA. */
  ownSurvival?: SurvivalCurve;
  /** Counterparty recovery (default 0.4). */
  recovery?: number;
  /** Own recovery (default 0.4). */
  ownRecovery?: number;
  /** Funding spread over the risk-free curve for FVA (default 0 ⇒ FVA = 0). */
  fundingSpread?: number;
  /** Seed for the deterministic PRNG. */
  seed: number;
  /** Number of simulated paths (default 5000). */
  paths?: number;
  /** Simulation steps per year (default 24, hard outer maximum 1,000,000; paths×steps cap may be lower). */
  stepsPerYear?: number;
}

/** {@link XvaParameters} keys (Law 12 — mirrors the interface above; keep in sync). */
const XVA_PARAMS_KEYS = [
  'meanReversion',
  'sigma',
  'counterpartySurvival',
  'ownSurvival',
  'recovery',
  'ownRecovery',
  'fundingSpread',
  'seed',
  'paths',
  'stepsPerYear',
] as const;

export interface ExposurePoint {
  tenorYears: number;
  /** Expected positive exposure `E[max(V, 0)]` (undiscounted). */
  epe: number;
  /** Expected negative exposure `E[max(−V, 0)]` (undiscounted). */
  ene: number;
  /** 95% potential future exposure (95th percentile of the swap value). */
  pfe95: number;
}

export interface XvaResult {
  cva: number;
  dva: number;
  fva: number;
  /** Bilateral CVA: `cva − dva`. */
  bilateralCva: number;
  /** The exposure profile across the measurement dates. */
  exposure: ExposurePoint[];
  /** Echoed reproducibility knobs (R2): the seed, paths, and grid resolution actually used. */
  assumptions: {
    conventionsVersion: string;
    model: 'hull-white';
    seed: number;
    paths: number;
    stepsPerYear: number;
  };
  /**
   * Honest computation report (R2). `repricingError` is the worst zero-coupon repricing error of
   * the simulator (martingale check) — the honesty signal for the whole exposure profile.
   */
  diagnostics: Diagnostics & { repricingError: number };
}

/** Compute CVA / DVA / FVA for an interest-rate swap via a Hull-White exposure simulation. */
export function swapXva(specification: XvaSwapSpecification, parameters: XvaParameters): XvaResult {
  requireArgumentObject('swapXva', 'specification', specification);
  const optionTypeValue = (specification as unknown as Record<string, unknown>)['optionType'];
  // optionType is DECLARED REQUIRED and decides the sign of every exposure: an omitted optionType
  // used to fail the `=== 'payer'` test and silently value the RECEIVER leg.
  if (optionTypeValue === undefined) {
    throw new InputError(
      `swapXva: optionType is required ('payer' | 'receiver' — which leg the counterparty risk is on).\n  e.g. swapXva({ optionType: 'payer', notional: 1_000_000, fixedRate: 0.03, maturityYears: 5, curve }, { recovery: 0.4 })`,
      { code: ErrorCode.InputMissingField, context: { field: 'optionType' } },
    );
  }
  if (optionTypeValue !== 'payer' && optionTypeValue !== 'receiver') {
    throw new InputError(
      `swapXva: optionType must be 'payer' | 'receiver'. Received ${optionTypeValue === null ? 'null' : JSON.stringify(optionTypeValue)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'optionType' } },
    );
  }
  ensureDayCountWhenPresent(specification.fixedDayCount, 'swapXva');
  ensureFrequencyWhenPresent(specification.fixedFrequency, 'swapXva');
  ensureDayCountWhenPresent(
    (specification as unknown as Record<string, unknown>)['floatDayCount'] as never,
    'swapXva',
  );
  ensureFrequencyWhenPresent(
    (specification as unknown as Record<string, unknown>)['floatFrequency'],
    'swapXva',
  );
  if (
    specification.notional !== undefined &&
    (typeof specification.notional !== 'number' || !Number.isFinite(specification.notional))
  ) {
    throw new InputError(
      `swapXva: notional must be a finite number when provided. Received ${specification.notional === null ? 'null' : typeof specification.notional}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'notional' } },
    );
  }
  requireArgumentObject('swapXva', 'parameters', parameters);
  ensureKnownKeys('swapXva', 'parameters', parameters, XVA_PARAMS_KEYS);
  for (const numField of [
    'recovery',
    'ownRecovery',
    'fundingSpread',
    'paths',
    'stepsPerYear',
  ] as const) {
    const numValue = (parameters as unknown as Record<string, unknown>)[numField];
    if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
      throw new InputError(
        `swapXva: ${numField} must be a finite number when provided. Received ${numValue === null ? 'null' : typeof numValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: numField } },
      );
    }
  }
  requireArgumentObject('swapXva', 'specification', specification);
  ensureKnownKeys('swapXva', 'specification', specification, XVA_SWAP_SPEC_KEYS);
  const functionName = 'swapXva';
  // spec.curve drives every discount/forward read; a missing or raw object would die on the first
  // curve method call inside the simulator — teach the fix at the boundary instead.
  const specCurve = specification.curve as
    | { discount?: unknown; referenceDate?: unknown }
    | undefined;
  if (
    specCurve === null ||
    typeof specCurve !== 'object' ||
    typeof specCurve.discount !== 'function' ||
    typeof specCurve.referenceDate !== 'string'
  ) {
    throw new InputError(
      `${functionName}: specification.curve must be a yield curve built by curves.fromZeroRates(...) / curves.flat(...) / ` +
        `curves.bootstrap(...) (an object with discount() and a referenceDate). ` +
        `Build the curve first, then pass it in the swap specification.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'spec.curve' } },
    );
  }
  // The survival curves drive the default-probability increments — same boundary rule.
  for (const [field, sc] of [
    ['counterpartySurvival', parameters.counterpartySurvival],
    ...(parameters.ownSurvival !== undefined
      ? [['ownSurvival', parameters.ownSurvival] as const]
      : []),
  ] as const) {
    const s = sc as { survival?: unknown } | null | undefined;
    if (
      s === null ||
      s === undefined ||
      typeof s !== 'object' ||
      typeof s.survival !== 'function'
    ) {
      throw new InputError(
        `${functionName}: parameters.${field} must be a survival curve built by credit.flatHazard(...) / ` +
          `credit.survivalFromHazards(...) / credit.bootstrapHazardFromCds(...) (an object with survival()).`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `parameters.${field}` },
        },
      );
    }
  }
  ensurePositive(parameters.meanReversion, 'meanReversion', functionName);
  ensurePositive(parameters.sigma, 'sigma', functionName);
  // The seed drives the exposure PRNG; require an integer so a run is bit-for-bit reproducible.
  // Safe integer (2026-08-23 review, P0): above 2^53 adjacent integers collide, so two "different"
  // seeds silently reproduce the same exposure paths.
  if (!Number.isSafeInteger(parameters.seed)) {
    throw new InputError(
      `${functionName}: seed must be an integer within ±(2^53 − 1) (a safe integer) for reproducibility, got ${parameters.seed}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { seed: parameters.seed },
      },
    );
  }
  ensureFinite(specification.fixedRate, 'fixedRate', functionName);
  const recovery = parameters.recovery ?? 0.4;
  const ownRecovery = parameters.ownRecovery ?? 0.4;
  for (const [name, R] of [
    ['recovery', recovery],
    ['ownRecovery', ownRecovery],
  ] as const) {
    if (R < 0 || R >= 1) {
      throw new InputError(`${functionName}: ${name} must be in [0, 1), got ${R}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { [name]: R },
      });
    }
  }
  const paths = parameters.paths ?? 5000;
  // Safe integer AND a work cap (2026-08-23 review, P0): paths sizes the per-date sample matrices
  // and multiplies the whole simulation — `Number.isInteger(1e308)` is `true`, and above 2^53 the
  // path counter stops advancing, so the old gate licensed a non-terminating simulation. 100,000
  // paths is 20× the 5,000 default; XVA Monte-Carlo error ∝ 1/√n gains nothing real beyond that,
  // and the paths × steps PRODUCT is bounded separately below where the grid is known.
  if (!Number.isSafeInteger(paths) || paths < 2 || paths > MAX_XVA_PATHS) {
    throw new InputError(
      `${functionName}: paths must be an integer in [2, ${MAX_XVA_PATHS.toLocaleString('en-US')}] — every path simulates the full short-rate grid and re-values the remaining swap at each exposure date, so the cap (20× the 5,000 default) keeps the largest request seconds of synchronous work, got ${paths}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { paths, max: MAX_XVA_PATHS },
      },
    );
  }
  const notional = specification.notional ?? 1;
  const curve = specification.curve;
  const settlement = curve.referenceDate;
  const maturityYf = yearFraction(settlement, specification.maturityDate, 'ACT/365F');
  const startYf = yearFraction(settlement, specification.startDate, 'ACT/365F');
  const stepsPerYear = parameters.stepsPerYear ?? 24;
  // 2026-08-23 review, P0: stepsPerYear was only checked finite — a zero/negative value silently
  // collapsed the grid to the 2-step floor (a degenerate simulation presented as a result), and an
  // enormous one made N explode. Positive here; the paths × N product bound below prices the rest.
  ensureStepsPerYearWhenPresent(stepsPerYear, functionName);
  const N = Math.max(2, Math.ceil(stepsPerYear * maturityYf));
  // Bound the PRODUCT paths × N (2026-08-23 review, P0): the simulation loop runs exactly
  // paths × N steps, each an OU evolution plus (at exposure dates) a full remaining-swap
  // re-valuation — either factor alone can be reasonable while the product explodes
  // (100,000 paths × a 50y daily grid ≈ 1.8·10^9 heavy steps). 10^7 path-steps is ~8× the default
  // work (5,000 paths × a 10y monthly-ish grid ≈ 1.2·10^6) and stays single-digit seconds on a
  // laptop at the ~µs-per-step cost of Hull-White bond math.
  if (paths * N > MAX_XVA_PATH_STEPS) {
    throw new InputError(
      `${functionName}: paths × timeSteps = ${paths.toLocaleString('en-US')} × ${N.toLocaleString('en-US')} = ${(paths * N).toLocaleString('en-US')} exceeds the ${MAX_XVA_PATH_STEPS.toLocaleString('en-US')} cap on total simulation steps — each step evolves the short rate and (at exposure dates) re-values the remaining swap, so the cap keeps the largest request single-digit seconds of synchronous work. Lower paths or stepsPerYear (the grid is ceil(stepsPerYear × yearsToMaturity)).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { paths, timeSteps: N, stepsPerYear, max: MAX_XVA_PATH_STEPS },
      },
    );
  }
  const timeStepYears = maturityYf / N;
  const { meanReversion, sigma } = parameters;
  const hw = hullWhite(curve, { a: meanReversion, sigma });

  // φ-adjusted short-rate level α(t) = f^M(0,t) + σ²/(2a²)(1 − e^{−at})².
  const alpha = (t: number): number =>
    curve.instantaneousForward(t) +
    ((sigma * sigma) / (2 * meanReversion * meanReversion)) *
      Math.pow(1 - Math.exp(-meanReversion * t), 2);

  // Fixed-leg pay times of the swap.
  const fixedSchedule = generateSchedule({
    effectiveDate: specification.startDate,
    maturityDate: specification.maturityDate,
    frequency: specification.fixedFrequency ?? 'semiannual',
  });
  const fixedDc = specification.fixedDayCount ?? '30/360';
  const payTimes = fixedSchedule.map((p) => ({
    end: yearFraction(settlement, p.accrualEnd, 'ACT/365F'),
    tau: yearFraction(p.accrualStart, p.accrualEnd, fixedDc),
  }));

  /** Remaining-swap value per unit notional at time `ti`, given short rate `r`. */
  const swapValueAt = (ti: number, r: number): number => {
    let annuity = 0;
    for (const p of payTimes)
      if (p.end > ti + 1e-9) {
        annuity +=
          p.tau * hw.discountBond({ valuationTime: ti, timeToMaturity: p.end - ti, shortRate: r });
      }
    const floatStart = Math.max(startYf, ti);
    const floatPv =
      hw.discountBond({
        valuationTime: ti,
        timeToMaturity: Math.max(0, floatStart - ti),
        shortRate: r,
      }) - hw.discountBond({ valuationTime: ti, timeToMaturity: maturityYf - ti, shortRate: r });
    const payer = floatPv - specification.fixedRate * annuity;
    return specification.optionType === 'payer' ? payer : -payer;
  };

  // Exposure measurement dates ≈ monthly, snapped onto the finer simulation grid.
  const everyK = Math.max(1, Math.round(N / Math.max(1, Math.ceil(12 * maturityYf))));
  const exposureIdx: number[] = [];
  for (let m = everyK; m <= N; m += everyK) exposureIdx.push(m);
  if (exposureIdx[exposureIdx.length - 1] !== N) exposureIdx.push(N);
  const exposureTimes = exposureIdx.map((m) => m * timeStepYears);
  const K = exposureIdx.length;

  const sdStep =
    sigma * Math.sqrt((1 - Math.exp(-2 * meanReversion * timeStepYears)) / (2 * meanReversion)); // OU step std-dev
  const meanRev = Math.exp(-meanReversion * timeStepYears);

  // Accumulators.
  const sumEpe = new Array<number>(K).fill(0);
  const sumEne = new Array<number>(K).fill(0);
  const sumDiscEpe = new Array<number>(K).fill(0);
  const sumDiscEne = new Array<number>(K).fill(0);
  const sumDiscBondMartingale = new Array<number>(K).fill(0); // E[B(0,tk)·P(tk, T; r)]
  const vSamples: number[][] = Array.from({ length: K }, () => new Array<number>(paths));

  const randomNumberGenerator = mulberry32(parameters.seed);
  const exposureAt = new Map<number, number>(exposureIdx.map((m, k) => [m, k]));

  for (let path = 0; path < paths; path++) {
    let x = 0;
    let rPrev = alpha(0);
    let logB = 0; // ln of the stochastic discount factor B(0, t)
    for (let m = 1; m <= N; m++) {
      x = x * meanRev + sdStep * normalInverseCdf(randomNumberGenerator.next());
      const t = m * timeStepYears;
      const r = x + alpha(t);
      logB += -0.5 * (rPrev + r) * timeStepYears; // trapezoidal ∫ r timeStepYears
      rPrev = r;
      const k = exposureAt.get(m);
      if (k !== undefined) {
        const B = Math.exp(logB);
        const v = notional * swapValueAt(t, r);
        const pos = Math.max(v, 0);
        const neg = Math.max(-v, 0);
        sumEpe[k]! += pos;
        sumEne[k]! += neg;
        sumDiscEpe[k]! += B * pos;
        sumDiscEne[k]! += B * neg;
        sumDiscBondMartingale[k]! +=
          B * hw.discountBond({ valuationTime: t, timeToMaturity: maturityYf - t, shortRate: r });
        vSamples[k]![path] = v;
      }
    }
  }

  // Profiles + XVA aggregation.
  const exposure: ExposurePoint[] = [];
  let cva = 0;
  let dva = 0;
  let fva = 0;
  let repricingError = 0;
  const cpSurv = parameters.counterpartySurvival;
  const ownSurv = parameters.ownSurvival;
  const fundingSpread = parameters.fundingSpread ?? 0;

  for (let k = 0; k < K; k++) {
    const t = exposureTimes[k]!;
    const tPrev = k === 0 ? 0 : exposureTimes[k - 1]!;
    exposure.push({
      tenorYears: t,
      epe: sumEpe[k]! / paths,
      ene: sumEne[k]! / paths,
      // PFE is the high quantile of *positive* exposure max(V, 0) — always ≥ 0.
      pfe95: quantile(
        vSamples[k]!.map((v) => Math.max(v, 0)),
        0.95,
      ),
    });
    const discEpe = sumDiscEpe[k]! / paths;
    const discEne = sumDiscEne[k]! / paths;

    const cpDefault = cpSurv.survival(tPrev) - cpSurv.survival(t);
    cva += (1 - recovery) * discEpe * cpDefault;
    if (ownSurv) {
      const ownDefault = ownSurv.survival(tPrev) - ownSurv.survival(t);
      dva += (1 - ownRecovery) * discEne * ownDefault;
    }
    fva += fundingSpread * discEpe * (t - tPrev);

    // Martingale check: E[B(0,t)·P(t, T)] should equal the curve's P(0, T).
    const reprice = sumDiscBondMartingale[k]! / paths;
    repricingError = Math.max(repricingError, Math.abs(reprice - curve.discount(maturityYf)));
  }

  return {
    cva,
    dva,
    fva,
    bilateralCva: cva - dva,
    exposure,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      model: 'hull-white',
      seed: parameters.seed,
      paths,
      stepsPerYear,
    },
    diagnostics: {
      method: 'hull-white-mc',
      converged: true,
      warnings: [],
      repricingError,
    },
  };
}
