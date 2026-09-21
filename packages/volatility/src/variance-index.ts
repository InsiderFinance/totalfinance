/**
 * VIX-style model-free variance index + VRP term structure (spec §10, roadmap Tier 2). The
 * trader-facing layer over the single-expiry DDKZ replication (`varianceSwapRate`): from a raw option
 * **chain** it extracts each expiry's forward (put–call parity), selects the OTM strip, computes the
 * per-expiry model-free fair variance, and **time-interpolates** two expiries to a constant maturity —
 * the actual CBOE VIX construction — plus the variance-risk-premium term structure vs a realized vol.
 *
 * Composes `varianceSwapRate` (analytics.ts) and `varianceRiskPremium` / `realizedImpliedSpread`
 * (event.ts). No fabricated points: an expiry that can't be replicated is dropped with a disclosed
 * warning; an un-bracketed horizonPeriods is extrapolated from the nearest expiry, disclosed. See
 * `docs/specs/variance-index.md`.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type OptionQuote,
  type QuantWarning,
  WarningCode,
  ensureNonNegative,
  ensurePositive,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { varianceSwapRate } from './analytics.js';
import { realizedImpliedSpread, varianceRiskPremium } from './event.js';
import { extractOtmStrips } from './otm-strip.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function varianceIndexSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `variance-index: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const VARIANCE_INDEX_SPEC = varianceIndexSpecOf('varianceIndex#0');
const VRP_TERM_STRUCTURE_SPEC = varianceIndexSpecOf('varianceRiskPremiumTermStructure#0');

const VARIANCE_INDEX_EXAMPLE = (): string =>
  "varianceIndex({ quotes, spot: 100, riskFreeRate: 0.04, asOf: '2026-05-15T16:00:00Z' })";
const VRP_TERM_STRUCTURE_EXAMPLE = (): string =>
  'varianceRiskPremiumTermStructure({ quotes, spot: 100, riskFreeRate: 0.04, ' +
  "asOf: '2026-05-15T16:00:00Z', realizedVolatility: 0.18 })";

/** Inputs for {@link varianceIndex}. */
export interface VarianceIndexOptions {
  /** Option chain across ≥ 1 expiries — call + put quotes with a usable mid. */
  quotes: readonly OptionQuote[];
  spot: number;
  riskFreeRate: number;
  asOf: EpochMs | string;
  /** Constant-maturity target in calendar days. Default 30 (VIX). */
  horizonDays?: number;
  /** Reserved for the forward; default 0 (the parity forward already carries dividend/borrow). */
  dividendYield?: number;
}

/** One expiry's model-free fair variance/vol. */
export interface ExpiryVariance {
  expiry: string;
  /** Calendar days to expiry. */
  daysToExpiry: number;
  /** Year fraction (ACT/365F). */
  timeToExpiryYears: number;
  /** Parity forward. */
  forward: number;
  /** Annualized fair variance (decimal). */
  variance: number;
  /** `√variance` — model-free implied vol (decimal, e.g. 0.20). */
  fairVolatility: number;
  /** OTM strikes used in the replication. */
  strikesUsed: number;
}

/** The variance-index read-out. */
export interface VarianceIndexResult {
  /** Constant-maturity model-free vol in VIX-style points (e.g. 20.0 = 20% annualized). */
  index: number;
  /** Constant-maturity annualized fair variance (decimal). */
  variance: number;
  /** Constant-maturity fair vol as a decimal (`index / 100`). */
  fairVolatility: number;
  horizonDays: number;
  /** Per-expiry fair variance/vol — the whole term structure, ascending by DTE. */
  termStructure: ExpiryVariance[];
  /** The two expiries that bracketed the horizonPeriods (absent when extrapolated from one). */
  interpolatedBetween?: { near: string; far: string };
  assumptions: {
    conventionsVersion: string;
    horizonDays: number;
    measure: 'risk-neutral';
    method: string;
  };
  diagnostics: Diagnostics;
}

/** Inputs for {@link varianceRiskPremiumTermStructure}. */
export interface VarianceRiskPremiumTermStructureOptions extends VarianceIndexOptions {
  /** Realized vol to compare (decimal): one number for the whole curve, or per-expiry by ISO date. */
  realizedVolatility: number | Record<string, number>;
}

/** One expiry's variance-risk-premium point. */
export interface VarianceRiskPremiumPoint extends ExpiryVariance {
  realizedVolatility: number;
  /** `iv² − rv²` (annualized) — the variance risk premium. */
  varianceRiskPremium: number;
  /** `iv − rv` — the vol-point spread. */
  volatilitySpread: number;
}

/** The VRP term-structure read-out. */
export interface VarianceRiskPremiumTermStructureResult {
  points: VarianceRiskPremiumPoint[];
  /** VRP at the constant-maturity index vs the reference realized vol. */
  indexVarianceRiskPremium: number;
  assumptions: { conventionsVersion: string; measure: 'risk-neutral'; method: string };
  diagnostics: Diagnostics;
}

/**
 * Build the per-expiry fair-variance term structure (ascending by DTE) from a chain, disclosing every
 * dropped expiry. Shares the OTM-strip extraction with the tail-risk index (`extractOtmStrips`); the
 * DDKZ replication (`varianceSwapRate`) is applied per strip here.
 */
function termStructureOf(
  options: VarianceIndexOptions,
  functionName: string,
): { term: ExpiryVariance[]; warnings: QuantWarning[]; asOfMs: EpochMs } {
  // Shape/type/closedness ran at the public heads (spec 3B.1b); the domain residue is spot > 0.
  ensurePositive(options.spot, 'spot', functionName);

  const { strips, warnings, asOfMs } = extractOtmStrips(
    options.quotes,
    { rate: options.riskFreeRate, asOf: options.asOf },
    functionName,
  );
  const term: ExpiryVariance[] = [];
  for (const s of strips) {
    let variance: number;
    let fairVolatility: number;
    try {
      const vs = varianceSwapRate({
        strikes: s.strikes,
        otmPrices: s.otmPrices,
        forward: s.forward,
        riskFreeRate: options.riskFreeRate,
        timeToExpiryYears: s.timeToExpiryYears,
        // `extractOtmStrips` already averages the K₀ call and put (the CBOE convention), so the
        // put-only bias disclosure does not apply to this path — say so instead of carrying a
        // warning that is false here.
        boundaryPriceAveraged: true,
      });
      variance = vs.value.variance;
      fairVolatility = vs.value.fairVolatility;
    } catch (err) {
      if (err instanceof InputError) {
        warnings.push(
          warning(
            WarningCode.ModelLimitation,
            `expiry ${s.expiry} dropped: ${err.message}.`,
            'info',
            {
              expiry: s.expiry,
            },
          ),
        );
        continue;
      }
      throw err;
    }
    if (!(variance >= 0) || !Number.isFinite(fairVolatility)) {
      warnings.push(
        warning(
          WarningCode.ModelLimitation,
          `expiry ${s.expiry} dropped: negative/undefined fair variance (${variance}) — arbitrageable or too-sparse strip.`,
          'info',
          { expiry: s.expiry },
        ),
      );
      continue;
    }
    term.push({
      expiry: s.expiry,
      daysToExpiry: s.daysToExpiry,
      timeToExpiryYears: s.timeToExpiryYears,
      forward: s.forward,
      variance,
      fairVolatility,
      strikesUsed: s.strikes.length,
    });
  }
  if (term.length === 0) {
    throw new InputError(
      `${functionName}: no expiry could be replicated from the chain (need ≥ 3 OTM strikes with a bracketing forward per expiry). See diagnostics for per-expiry reasons.`,
      { code: ErrorCode.InputOutOfRange, context: { quotes: options.quotes.length } },
    );
  }
  return { term, warnings, asOfMs };
}

/** Time-interpolate two expiries' variance to the constant maturity, or extrapolate from the nearest. */
function constantMaturityVariance(
  term: ExpiryVariance[],
  horizonDays: number,
): { variance: number; near?: string; far?: string; extrapolated: boolean } {
  // Bracket: the last expiry with dte ≤ horizonPeriods and the first with dte ≥ horizonPeriods.
  let nearIdx = -1;
  for (let i = 0; i < term.length; i++) if (term[i]!.daysToExpiry <= horizonDays) nearIdx = i;
  const near = nearIdx >= 0 ? term[nearIdx] : undefined;
  const far = nearIdx + 1 < term.length ? term[nearIdx + 1] : undefined;
  if (
    near &&
    far &&
    far.daysToExpiry > near.daysToExpiry &&
    near.daysToExpiry <= horizonDays &&
    far.daysToExpiry >= horizonDays
  ) {
    const n1 = near.daysToExpiry;
    const n2 = far.daysToExpiry;
    const w1 = (n2 - horizonDays) / (n2 - n1);
    const w2 = (horizonDays - n1) / (n2 - n1);
    // CBOE: interpolate total variance (T·σ²) then annualize to the horizonPeriods (×365/N). Use the SAME
    // calendar-day time base (dte/365) as the weights and the horizonPeriods — mixing the 16:00-ET `t` here
    // with dte-based weights biases the constant-maturity variance by ~(1 + δ/N).
    const variance =
      ((n1 / 365) * near.variance * w1 + (n2 / 365) * far.variance * w2) * (365 / horizonDays);
    return { variance, near: near.expiry, far: far.expiry, extrapolated: false };
  }
  // Un-bracketed → nearest expiry's fair variance (disclosed as extrapolated).
  const nearest = term.reduce((a, b) =>
    Math.abs(b.daysToExpiry - horizonDays) < Math.abs(a.daysToExpiry - horizonDays) ? b : a,
  );
  return { variance: nearest.variance, extrapolated: true };
}

/**
 * The VIX-style constant-maturity, model-free implied vol from an option chain, with the per-expiry
 * fair-variance term structure. See `docs/specs/variance-index.md`.
 */
export function varianceIndex(options: VarianceIndexOptions): VarianceIndexResult {
  const functionName = 'varianceIndex';
  // Guard before any field access (first-touch law).
  validateClosedRequest(functionName, options, VARIANCE_INDEX_SPEC, {
    argumentName: 'options',
    exampleCall: VARIANCE_INDEX_EXAMPLE,
  });
  return varianceIndexOf(options, functionName);
}

/** The validated index construction, shared with {@link varianceRiskPremiumTermStructure} (whose options superset it). */
function varianceIndexOf(options: VarianceIndexOptions, functionName: string): VarianceIndexResult {
  const horizonDays = options.horizonDays ?? 30;
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) {
    throw new InputError(
      `${functionName}: horizonDays must be a positive finite number; got ${horizonDays}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { horizonDays },
      },
    );
  }
  const { term, warnings } = termStructureOf(options, functionName);
  const cm = constantMaturityVariance(term, horizonDays);
  if (cm.extrapolated) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `horizonPeriods ${horizonDays}d is not bracketed by two listed expiries; the index is extrapolated from the nearest expiry (${term.length} usable).`,
        'warn',
        { horizonDays },
      ),
    );
  }
  const variance = cm.variance;
  const fairVolatility = Math.sqrt(Math.max(0, variance));
  return {
    index: 100 * fairVolatility,
    variance,
    fairVolatility,
    horizonDays,
    termStructure: term,
    ...(cm.near !== undefined && cm.far !== undefined
      ? { interpolatedBetween: { near: cm.near, far: cm.far } }
      : {}),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      horizonDays,
      measure: 'risk-neutral',
      method: 'ddkz-replication + vix-interpolation',
    },
    diagnostics: { engine: 'variance-index', method: 'vix-style', converged: true, warnings },
  };
}

/** Resolve the realized vol for one expiry (a scalar applies to all; a record is looked up by date). */
function realizedFor(
  expiry: string,
  realizedVolatility: number | Record<string, number>,
  functionName: string,
): number {
  if (typeof realizedVolatility === 'number') {
    ensureNonNegative(realizedVolatility, 'realizedVolatility', functionName);
    return realizedVolatility;
  }
  const rv = realizedVolatility[expiry];
  if (rv === undefined) {
    throw new InputError(`${functionName}: realizedVolatility has no entry for expiry ${expiry}.`, {
      code: ErrorCode.InputMissingField,
      context: { expiry },
    });
  }
  ensureNonNegative(rv, `realizedVolatility["${expiry}"]`, functionName);
  return rv;
}

/**
 * The variance-risk-premium term structure — per-expiry implied variance (from {@link varianceIndex})
 * minus realized variance — plus the VRP at the constant-maturity index. See the spec.
 */
export function varianceRiskPremiumTermStructure(
  options: VarianceRiskPremiumTermStructureOptions,
): VarianceRiskPremiumTermStructureResult {
  const functionName = 'varianceRiskPremiumTermStructure';
  validateClosedRequest(functionName, options, VRP_TERM_STRUCTURE_SPEC, {
    argumentName: 'options',
    exampleCall: VRP_TERM_STRUCTURE_EXAMPLE,
  });
  // `realizedVolatility` is a mixed number-or-record union the spec leaves UNCHECKED — the curated
  // type teaching stays here.
  if (
    options.realizedVolatility === null ||
    (typeof options.realizedVolatility !== 'number' &&
      typeof options.realizedVolatility !== 'object')
  ) {
    throw new InputError(
      `${functionName}: realizedVolatility must be a number or a per-expiry record.`,
      {
        code: ErrorCode.InputWrongType,
        context: { realizedVolatility: typeof options.realizedVolatility },
      },
    );
  }
  const idx = varianceIndexOf(options, functionName);
  const points: VarianceRiskPremiumPoint[] = idx.termStructure.map((e) => {
    const rv = realizedFor(e.expiry, options.realizedVolatility, functionName);
    return {
      ...e,
      realizedVolatility: rv,
      varianceRiskPremium: varianceRiskPremium({
        impliedVolatility: e.fairVolatility,
        realizedVolatility: rv,
      }),
      volatilitySpread: realizedImpliedSpread({
        impliedVolatility: e.fairVolatility,
        realizedVolatility: rv,
      }),
    };
  });
  // Reference realized for the constant-maturity index: the scalar, else the nearest-expiry realized.
  const horizonDays = options.horizonDays ?? 30;
  const refExpiry = idx.termStructure.reduce((a, b) =>
    Math.abs(b.daysToExpiry - horizonDays) < Math.abs(a.daysToExpiry - horizonDays) ? b : a,
  ).expiry;
  const refRealized = realizedFor(refExpiry, options.realizedVolatility, functionName);
  return {
    points,
    indexVarianceRiskPremium: varianceRiskPremium({
      impliedVolatility: idx.fairVolatility,
      realizedVolatility: refRealized,
    }),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      measure: 'risk-neutral',
      method: 'ddkz-replication + vix-interpolation',
    },
    diagnostics: {
      engine: 'variance-risk-premium-term-structure',
      method: 'vix-style',
      converged: true,
      warnings: idx.diagnostics.warnings,
    },
  };
}
