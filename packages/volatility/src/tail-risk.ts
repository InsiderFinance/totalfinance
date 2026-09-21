/**
 * SKEW-style tail-risk index (spec §10.x, roadmap Tier 2) — the model-free risk-neutral **skewness**
 * (and excess kurtosis) of the log-return distribution, from the same OTM strip the variance index
 * uses. A crash-risk gauge à la the CBOE SKEW index: `skewIndex = 100 − 10·skewness`, so a fat left tail
 * (the usual equity put-skew) reads **above 100**.
 *
 * The moments are the Bakshi–Kapadia–Madan (2003) power-payoff estimators, referenced to the forward
 * `F` (so `E[S_T/F] = 1`): for `Rᵢ = ln(Kᵢ/F)` and OTM prices `Qᵢ`,
 * `Mₙ = e^{rT}·Σ gₙ''(Kᵢ)·Qᵢ·ΔKᵢ` with `g₁ = R, g₂ = R², g₃ = R³, g₄ = R⁴`; the central moments then
 * give skewness and kurtosis. Composes `extractOtmStrips`. See `docs/specs/tail-risk-index.md`.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type OptionQuote,
  WarningCode,
  ensurePositive,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { type OtmStrip, extractOtmStrips } from './otm-strip.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import.
 */
function tailRiskSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `tail-risk: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const TAIL_RISK_INDEX_SPEC = tailRiskSpecOf('tailRiskIndex#0');

const TAIL_RISK_INDEX_EXAMPLE = (): string =>
  "tailRiskIndex({ quotes, spot: 100, riskFreeRate: 0.04, asOf: '2026-05-15T16:00:00Z' })";

/** Inputs for {@link tailRiskIndex}. */
export interface TailRiskOptions {
  quotes: readonly OptionQuote[];
  spot: number;
  riskFreeRate: number;
  asOf: number | string;
  /** Constant-maturity target in calendar days. Default 30 (CBOE SKEW). */
  horizonDays?: number;
}

/** One expiry's model-free tail-risk moments. */
export interface ExpiryTailRisk {
  expiry: string;
  daysToExpiry: number;
  timeToExpiryYears: number;
  forward: number;
  /** Risk-neutral skewness of `ln(S_T/F)` (negative for the usual equity put-skew). */
  skewness: number;
  /** Risk-neutral excess kurtosis (`kurtosis − 3`; > 0 ⇒ fat tails). */
  excessKurtosis: number;
  /** `100 − 10·skewness` — the CBOE-style SKEW value (> 100 ⇒ fat left tail). */
  skewIndex: number;
  strikesUsed: number;
}

/** The tail-risk read-out. */
export interface TailRiskResult {
  /** Constant-maturity SKEW value (> 100 ⇒ elevated crash risk), interpolated to `horizonDays`. */
  skewIndex: number;
  /** Constant-maturity risk-neutral skewness. */
  skewness: number;
  /** Constant-maturity risk-neutral excess kurtosis. */
  excessKurtosis: number;
  horizonDays: number;
  /** Per-expiry moments — the whole tail-risk term structure, ascending by DTE. */
  termStructure: ExpiryTailRisk[];
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

/** Bakshi–Kapadia–Madan risk-neutral moments of `ln(S_T/F)` from one OTM strip, or a skip reason. */
function bkmMoments(
  strip: OtmStrip,
  rate: number,
): { skewness: number; excessKurtosis: number } | { skip: string } {
  const { strikes: K, otmPrices: Q, forward: F, timeToExpiryYears } = strip;
  const disc = Math.exp(rate * timeToExpiryYears);
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < K.length; i++) {
    const dK =
      i === 0
        ? K[1]! - K[0]!
        : i === K.length - 1
          ? K[i]! - K[i - 1]!
          : (K[i + 1]! - K[i - 1]!) / 2;
    const u = Math.log(K[i]! / F); // moneyness ln(K/F)
    const w = (disc * Q[i]! * dK) / (K[i]! * K[i]!); // e^{rT}·Q·ΔK / K²
    // gₙ''(K)·K² for gₙ = ln(K/F)ⁿ: g₁''K² = −1; g₂''K² = 2(1−u); g₃''K² = 6u−3u²; g₄''K² = 12u²−4u³.
    m1 += w * -1;
    m2 += w * (2 * (1 - u));
    m3 += w * (6 * u - 3 * u * u);
    m4 += w * (12 * u * u - 4 * u * u * u);
  }
  const mu = m1; // E[ln(S_T/F)]
  const variance = m2 - mu * mu;
  if (!(variance > 0)) {
    return {
      skip: `non-positive risk-neutral variance (${variance}) — arbitrageable or too-sparse strip`,
    };
  }
  const thirdCentral = m3 - 3 * mu * m2 + 2 * mu * mu * mu;
  const fourthCentral = m4 - 4 * mu * m3 + 6 * mu * mu * m2 - 3 * mu * mu * mu * mu;
  const skewness = thirdCentral / variance ** 1.5;
  const excessKurtosis = fourthCentral / (variance * variance) - 3;
  if (!Number.isFinite(skewness) || !Number.isFinite(excessKurtosis)) {
    return { skip: 'non-finite moments — degenerate strip' };
  }
  return { skewness, excessKurtosis };
}

/** Linearly interpolate a per-expiry quantity by DTE to the horizonPeriods, or extrapolate from the nearest. */
function interpByDaysToExpiry(
  term: ExpiryTailRisk[],
  horizonDays: number,
  pick: (e: ExpiryTailRisk) => number,
): { value: number; near?: string; far?: string; extrapolated: boolean } {
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
    const w = (horizonDays - near.daysToExpiry) / (far.daysToExpiry - near.daysToExpiry);
    return {
      value: pick(near) + w * (pick(far) - pick(near)),
      near: near.expiry,
      far: far.expiry,
      extrapolated: false,
    };
  }
  const nearest = term.reduce((a, b) =>
    Math.abs(b.daysToExpiry - horizonDays) < Math.abs(a.daysToExpiry - horizonDays) ? b : a,
  );
  return { value: pick(nearest), extrapolated: true };
}

/**
 * The SKEW-style tail-risk index from an option chain: per-expiry risk-neutral skewness / excess
 * kurtosis (BKM), plus the constant-maturity SKEW value. See `docs/specs/tail-risk-index.md`.
 */
export function tailRiskIndex(options: TailRiskOptions): TailRiskResult {
  const functionName = 'tailRiskIndex';
  validateClosedRequest(functionName, options, TAIL_RISK_INDEX_SPEC, {
    argumentName: 'options',
    exampleCall: TAIL_RISK_INDEX_EXAMPLE,
  });
  ensurePositive(options.spot, 'spot', functionName);
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

  const { strips, warnings } = extractOtmStrips(
    options.quotes,
    { rate: options.riskFreeRate, asOf: options.asOf },
    functionName,
  );
  const term: ExpiryTailRisk[] = [];
  for (const s of strips) {
    const m = bkmMoments(s, options.riskFreeRate);
    if ('skip' in m) {
      warnings.push(
        warning(WarningCode.ModelLimitation, `expiry ${s.expiry} dropped: ${m.skip}.`, 'info', {
          expiry: s.expiry,
        }),
      );
      continue;
    }
    term.push({
      expiry: s.expiry,
      daysToExpiry: s.daysToExpiry,
      timeToExpiryYears: s.timeToExpiryYears,
      forward: s.forward,
      skewness: m.skewness,
      excessKurtosis: m.excessKurtosis,
      skewIndex: 100 - 10 * m.skewness,
      strikesUsed: s.strikes.length,
    });
  }
  if (term.length === 0) {
    throw new InputError(
      `${functionName}: no expiry could be replicated from the chain (need ≥ 3 OTM strikes with a bracketing forward and positive variance per expiry). See diagnostics for per-expiry reasons.`,
      { code: ErrorCode.InputOutOfRange, context: { quotes: options.quotes.length } },
    );
  }

  const skew = interpByDaysToExpiry(term, horizonDays, (e) => e.skewness);
  const kurt = interpByDaysToExpiry(term, horizonDays, (e) => e.excessKurtosis);
  if (skew.extrapolated) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `horizonPeriods ${horizonDays}d is not bracketed by two listed expiries; the index is extrapolated from the nearest expiry (${term.length} usable).`,
        'warn',
        { horizonDays },
      ),
    );
  }

  return {
    skewIndex: 100 - 10 * skew.value,
    skewness: skew.value,
    excessKurtosis: kurt.value,
    horizonDays,
    termStructure: term,
    ...(skew.near !== undefined && skew.far !== undefined
      ? { interpolatedBetween: { near: skew.near, far: skew.far } }
      : {}),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      horizonDays,
      measure: 'risk-neutral',
      method: 'bkm-moments + daysToExpiry-interpolation',
    },
    diagnostics: { engine: 'tail-risk-index', method: 'skew-style', converged: true, warnings },
  };
}
