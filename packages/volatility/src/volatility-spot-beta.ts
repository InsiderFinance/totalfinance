/**
 * Empirical vol–spot β — the leverage effect (roadmap Tier 2 — the `minimumVarianceDelta` follow-up).
 *
 * `minimumVarianceDelta` needs `β = ∂σ/∂S`, and its spec is explicit that the honest β is **empirical**: the
 * regression slope of realized IV changes on spot changes (negative for equities — the leverage effect). This
 * estimates it from a `(spot, impliedVolatility)` history via OLS (with optional Newey–West HAC standard errors) so
 * the `volatilitySpotBeta` output feeds straight into `minimumVarianceDelta({ volatilitySpotBeta })`.
 * See `docs/specs/volatility-spot-beta.md`.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureEnum,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  type ClosedRequestSpecification,
  validateClosedRequest,
} from '@totalfinance/core';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { ols } from '@totalfinance/math';

/** Input for {@link estimateVolatilitySpotBeta}. */
export interface VolatilitySpotBetaInput {
  /** Chronological spot prices. */
  spot: number[];
  /** The option's implied vol (decimal), aligned to `spot`. */
  impliedVolatility: number[];
  /** Regress IV changes on log-returns (`'log'`, default) or dollar spot changes (`'level'`). */
  basis?: 'log' | 'level';
  /** Reference spot to convert a log-basis slope to `∂σ/∂S` (default: the latest spot). */
  referenceSpot?: number;
  /** Newey–West HAC bandwidth for autocorrelation-robust errors (default 0 = White). */
  hacLags?: number;
}

/** The empirical vol–spot β and its regression diagnostics. */
export interface VolatilitySpotBeta {
  /**
   * `β = ∂σ/∂S` in decimal vol **per $1 of spot** — feed straight to
   * `minimumVarianceDelta({ volatilitySpotBeta })`, which expects the same per-dollar units.
   *
   * Units matter here: `stickyRegime` reports `volatilitySpotBetaPerLogSpot` = `∂σ/∂lnS` (per 100%
   * spot move), which is `S ×` this number. On a `'log'` basis the conversion is done for you
   * (`slope / referenceSpot`); {@link slope} is the raw regression coefficient in its own basis.
   */
  volatilitySpotBeta: number;
  /** The regression slope: `∂σ/∂ln S` (`'log'`) or `∂σ/∂S` (`'level'`). */
  slope: number;
  /** Standard error of the slope. */
  slopeStandardError: number;
  /** t-statistic of the slope. */
  slopeTStatistic: number;
  /** Correlation of the IV change with the spot-change regressor (leverage ⇒ negative). */
  correlation: number;
  /** Coefficient of determination `R²`. */
  rSquared: number;
  /** Change observations used (after dropping bad pairs). */
  observationCount: number;
  /** Dropped (non-finite / non-positive) change observations. */
  dropped: number;
  /** Reference spot used for the `∂σ/∂S` conversion. */
  referenceSpot: number;
}

const FN = 'estimateVolatilitySpotBeta';

/**
 * Hard cap on Newey-West lags (2026-08-23 review, P0): ols()'s HAC outer loop runs `lags`
 * iterations regardless of the sample size, so an astronomical "integer" was a non-terminating
 * regression. The Newey-West bandwidth rule 4·(n/100)^(2/9) stays below 30 for any market-sized
 * sample; 1,000 is ~30× beyond that while keeping the O(lags × n) sum well under a second.
 */
const MAX_HAC_LAGS = 1_000;

/**
 * Estimate the empirical vol–spot sensitivity `β = ∂σ/∂S` (the leverage effect) from a `(spot, impliedVolatility)`
 * history by OLS of one-step IV changes on spot changes. The `volatilitySpotBeta` output is the minimum-variance
 * hedge input for {@link minimumVarianceDelta}; the slope's standard error / t-stat / R² and a
 * significance warning are reported so a β that is really noise does not masquerade as a hedge input.
 * See `docs/specs/volatility-spot-beta.md`.
 */
const SPOT_BETA_SPEC: ClosedRequestSpecification = (() => {
  const spec = VALIDATION_SPECS['estimateVolatilitySpotBeta#0'];
  if (spec === undefined)
    throw new Error('volatility-spot-beta: missing generated spec — run `pnpm validation:update`');
  return spec;
})();

export function estimateVolatilitySpotBeta(
  input: VolatilitySpotBetaInput,
): Computed<
  VolatilitySpotBeta,
  { measure: 'real-world-hedge'; basis: 'log' | 'level'; hacLags: number }
> {
  validateClosedRequest('estimateVolatilitySpotBeta', input, SPOT_BETA_SPEC, {
    exampleCall: 'estimateVolatilitySpotBeta({ volatilityChanges, spotReturns })',
  });
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, [
    'spot',
    'impliedVolatility',
    'basis',
    'referenceSpot',
    'hacLags',
  ]);
  requireArgumentArray(FN, 'spot', (input as { spot?: unknown }).spot);
  requireArgumentArray(
    FN,
    'impliedVolatility',
    (input as { impliedVolatility?: unknown }).impliedVolatility,
  );
  const { spot, impliedVolatility } = input;
  if (spot.length !== impliedVolatility.length) {
    throw new InputError(
      `${FN}: spot and impliedVolatility must be the same length (got ${spot.length} and ${impliedVolatility.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { spot: spot.length, impliedVolatility: impliedVolatility.length },
      },
    );
  }
  const basis = input.basis ?? 'log';
  ensureEnum(basis, ['log', 'level'] as const, 'basis', FN);
  const hacLags = input.hacLags ?? 0;
  // Safe integer AND a work cap (2026-08-23 review, P0): hacLags is forwarded to ols(), whose
  // Newey-West outer loop spins `lags` times REGARDLESS of the sample size (lags beyond n just add
  // empty passes) — so `Number.isInteger(1e15)` passing made this call take hours and 2^53 made it
  // non-terminating. The Newey-West bandwidth rule 4·(n/100)^(2/9) stays below 30 even at n = 10^9
  // observations, so 1,000 lags is ~30× beyond any defensible bandwidth while keeping the O(lags × n)
  // covariance sum well under a second on realistic samples.
  if (!Number.isSafeInteger(hacLags) || hacLags < 0 || hacLags > MAX_HAC_LAGS) {
    throw new InputError(
      `${FN}: hacLags must be an integer in [0, ${MAX_HAC_LAGS.toLocaleString('en-US')}] — each lag adds a full pass over the regression sample, and the Newey-West bandwidth rule 4·(n/100)^(2/9) never comes close to ${MAX_HAC_LAGS.toLocaleString('en-US')}; got ${String(hacLags)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { hacLags, max: MAX_HAC_LAGS },
      },
    );
  }

  // One-step change pairs (Δσ, regressor). Drop any pair with a non-finite change or non-positive spot.
  const y: number[] = [];
  const x: number[] = [];
  let dropped = 0;
  for (let t = 1; t < spot.length; t++) {
    const s0 = spot[t - 1]!;
    const s1 = spot[t]!;
    const dSig = impliedVolatility[t]! - impliedVolatility[t - 1]!;
    const reg = basis === 'log' ? Math.log(s1 / s0) : s1 - s0;
    if (!(s0 > 0) || !(s1 > 0) || !Number.isFinite(dSig) || !Number.isFinite(reg)) {
      dropped++;
      continue;
    }
    y.push(dSig);
    x.push(reg);
  }
  const n = y.length;
  if (n < 3) {
    throw new InputError(
      `${FN}: need ≥ 3 usable one-step changes for a slope + intercept regression; got ${n} (from ${spot.length} observation(s), ${dropped} dropped).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { usableChanges: n, dropped, observations: spot.length },
      },
    );
  }

  const reg = ols(
    y,
    x.map((xi) => [xi]),
    hacLags > 0 ? { hac: { lags: hacLags } } : {},
  );
  const slope = reg.coefficients[1]!;
  const slopeStandardError = reg.standardErrors[1]!;
  const slopeTStatistic = reg.tStatistics[1]!;
  const rSquared = reg.rSquared;
  // Single regressor with intercept ⇒ R² is the squared correlation; sign follows the slope.
  const correlation = Math.sign(slope) * Math.sqrt(Math.max(0, rSquared));

  const referenceSpot = input.referenceSpot ?? spot[spot.length - 1]!;
  ensurePositive(referenceSpot, 'referenceSpot', FN);
  // Log basis: slope is ∂σ/∂ln S ⇒ ∂σ/∂S = slope / S at the reference spot. Level basis: slope IS ∂σ/∂S.
  const volatilitySpotBeta = basis === 'log' ? slope / referenceSpot : slope;

  const warnings: QuantWarning[] = [];
  if (dropped > 0) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `dropped ${dropped} change observation(s) with a non-finite IV change or non-positive spot.`,
        'info',
        { dropped },
      ),
    );
  }
  if (n < 20) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `only ${n} change observation(s) — the β estimate is low-power; use a longer history.`,
        'warn',
        { changeObservations: n },
      ),
    );
  }
  if (!(Math.abs(slopeTStatistic) >= 2)) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `the vol–spot slope is statistically insignificant (|t| = ${Math.abs(slopeTStatistic).toFixed(2)} < 2) — β may be noise, not a real leverage effect.`,
        'warn',
        { tStatistic: slopeTStatistic },
      ),
    );
  }

  const assumptions: Assumptions<{
    measure: 'real-world-hedge';
    basis: 'log' | 'level';
    hacLags: number;
  }> = {
    conventionsVersion: CONVENTIONS_VERSION,
    measure: 'real-world-hedge',
    basis,
    hacLags,
  };

  return {
    value: {
      volatilitySpotBeta,
      slope,
      slopeStandardError,
      slopeTStatistic,
      correlation,
      rSquared,
      observationCount: n,
      dropped,
      referenceSpot,
    },
    assumptions,
    diagnostics: { warnings },
  };
}
