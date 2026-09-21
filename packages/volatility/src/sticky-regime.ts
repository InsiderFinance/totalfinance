/**
 * Sticky-strike vs sticky-delta regime measurement (spec: `docs/specs/sticky-regime.md`, roadmap Tier 2).
 * When spot moves, does the smile stay put on strikes or slide with the spot? `minimumVarianceDelta`
 * *assumes* that regime; `stickyRegime` *measures* it — regressing a fixed reference strike's implied-vol
 * changes on spot log-returns to get the vol-spot beta `β = ∂σ_K/∂lnS`, then placing the market on the
 * sticky-strike (`β=0`) ↔ sticky-moneyness (`β=−skewSlope`) axis.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { ols } from '@totalfinance/math';

/** Inputs for {@link stickyRegime}. */
export interface StickyRegimeInput {
  /** Per-observation underlying spot, aligned to `fixedStrikeVolatility`. */
  spot: ArrayLike<number>;
  /** Per-observation implied vol of a FIXED reference strike (same K across the series). */
  fixedStrikeVolatility: ArrayLike<number>;
  /** The smile slope `∂σ/∂ln(K)` — the sticky-moneyness reference. Omit ⇒ only `β`/R² (indeterminate). */
  skewSlope?: number;
}

/** The measured regime. */
export interface StickyRegime {
  /**
   * `∂σ_K/∂lnS` — the empirical vol-spot beta from the regression, **per LOG spot** (vol points per
   * 100% spot move). NOT the same quantity as `VolatilitySpotBeta.volatilitySpotBeta` /
   * `minimumVarianceDelta({ volatilitySpotBeta })`, which are `∂σ/∂S` — per DOLLAR. The two differ by
   * a factor of `S`: feeding this straight into the hedge would scale the smile adjustment by the
   * spot price. Divide by the reference spot first (`estimateVolatilitySpotBeta` does exactly that
   * when its `basis` is `'log'`).
   */
  volatilitySpotBetaPerLogSpot: number;
  tStatistic: number;
  /** How much of the fixed-strike vol's change spot returns explain. */
  rSquared: number;
  /** Position on the axis: 0 = sticky-strike, 1 = sticky-moneyness (`= −β/skewSlope`); `null` if no reference. */
  stickiness: number | null;
  regime: 'sticky-strike' | 'sticky-moneyness' | 'intermediate' | 'indeterminate';
  observations: number;
  assumptions: { conventionsVersion: string; skewSlope: number | null };
  diagnostics: Diagnostics;
}

/**
 * Measure whether the market's smile is sticky-strike or sticky-moneyness (sticky-delta) from a history
 * of spot and a fixed reference strike's implied vol. See `docs/specs/sticky-regime.md`.
 */
export function stickyRegime(input: StickyRegimeInput): StickyRegime {
  const functionName = 'stickyRegime';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['spot', 'fixedStrikeVolatility', 'skewSlope']);
  requireArgumentArray(functionName, 'spot', input.spot);
  requireArgumentArray(functionName, 'fixedStrikeVolatility', input.fixedStrikeVolatility);
  const n = input.spot.length;
  if (input.fixedStrikeVolatility.length !== n) {
    throw new InputError(
      `${functionName}: spot (${n}) and fixedStrikeVolatility (${input.fixedStrikeVolatility.length}) must have the same length.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { spotLength: n, fixedStrikeVolatilityLength: input.fixedStrikeVolatility.length },
      },
    );
  }
  if (n < 4) {
    throw new InputError(
      `${functionName}: need ≥ 4 observations for a stable regression; got ${n}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { observations: n },
      },
    );
  }
  const skewSlope = input.skewSlope;
  if (skewSlope !== undefined) ensureFinite(skewSlope, 'skewSlope', functionName);

  // Δσ_K vs ΔlnS over the series.
  const dLnS: number[] = [];
  const dSig: number[] = [];
  for (let t = 0; t < n; t++) {
    ensurePositive(input.spot[t]!, `spot[${t}]`, functionName);
    ensurePositive(input.fixedStrikeVolatility[t]!, `fixedStrikeVolatility[${t}]`, functionName);
    if (t > 0) {
      dLnS.push(Math.log(input.spot[t]! / input.spot[t - 1]!));
      dSig.push(input.fixedStrikeVolatility[t]! - input.fixedStrikeVolatility[t - 1]!);
    }
  }

  const reg = ols(
    dSig,
    dLnS.map((x) => [x]),
  ); // coefficients: [intercept, β]
  const volatilitySpotBetaPerLogSpot = reg.coefficients[1]!;
  const tStatistic = reg.tStatistics[1]!;
  const rSquared = reg.rSquared;

  const warnings: QuantWarning[] = [];
  let stickiness: number | null = null;
  let regime: StickyRegime['regime'];
  // A flat smile (or no reference) leaves the sticky axis undefined — don't divide by ~0.
  if (skewSlope === undefined || Math.abs(skewSlope) < 1e-6) {
    regime = 'indeterminate';
    warnings.push(
      warning(
        WarningCode.VolatilityStickyIndeterminate,
        `${functionName}: ${skewSlope === undefined ? 'no skewSlope was supplied' : `the smile is ~flat (skewSlope ${skewSlope})`}, so the sticky-strike ↔ sticky-moneyness axis is undefined. Reporting the raw vol-spot beta (${volatilitySpotBetaPerLogSpot.toFixed(4)}) and R² only.`,
        'info',
      ),
    );
  } else {
    stickiness = -volatilitySpotBetaPerLogSpot / skewSlope;
    regime =
      stickiness < 0.25 ? 'sticky-strike' : stickiness > 0.75 ? 'sticky-moneyness' : 'intermediate';
  }
  // A low R² is the EXPECTED signature of sticky-strike (the vol doesn't respond to spot), so it isn't a
  // reliability concern there. Warn only when a non-trivial (intermediate / sticky-moneyness) placement
  // rests on a weak regression — that's the case worth flagging.
  if (rSquared < 0.1 && regime !== 'sticky-strike' && regime !== 'indeterminate') {
    warnings.push(
      warning(
        WarningCode.VolatilityStickyWeakFit,
        `${functionName}: spot returns explain little of the fixed-strike vol changes (R² ${rSquared.toFixed(3)}) — the placement (${regime}) rests on a weak vol-spot regression; treat it with caution.`,
        'info',
      ),
    );
  }

  return {
    volatilitySpotBetaPerLogSpot,
    tStatistic,
    rSquared,
    stickiness,
    regime,
    observations: n,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, skewSlope: skewSlope ?? null },
    diagnostics: { engine: 'sticky-regime', method: 'ols', converged: true, warnings },
  };
}
