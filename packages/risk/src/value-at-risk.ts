/**
 * Value at Risk (VaR) and Conditional VaR / Expected Shortfall (CVaR), plus portfolio risk
 * decomposition (marginal / component / percent contribution, diversification ratio).
 *
 * Conventions: returns are per-period simple returns; **VaR and CVaR are returned as positive loss
 * magnitudes** (a 95% VaR of `0.03` means "a loss of 3% of capital is the threshold exceeded only 5%
 * of the time"). A multi-period `horizonPeriods` scales by √-time across **all three methods**: the mean
 * drifts linearly (μ·h) while the demeaned dispersion scales by √h (σ·√h), so a quantile/tail value
 * `x` becomes `μ·h + (x − μ)·√h`. CVaR ≥ VaR always.
 *
 * Honesty contract (Law 2 / design law #4) — every degradation is disclosed in
 * `diagnostics.warnings`, never absorbed into the number:
 *   - the Cornish-Fisher expansion is applied only inside its monotone domain; outside it the plain
 *     Gaussian quantile is reported (`risk.cornish_fisher_out_of_domain`), which is what keeps VaR
 *     **monotone non-decreasing in confidence**;
 *   - a `historical` tail the sample cannot resolve — `(1 − confidence)·(n − 1) < 1`, i.e. the
 *     quantile is an interpolation off the single worst observation — warns
 *     `risk.quantile_beyond_sample`, and so does any method whose tail quantile turns out to be a
 *     PROFIT (the `max(0, ·)` clamp, which would otherwise ship a bare `0` as if it were an
 *     estimate);
 *   - the applied estimator/law/scaling (`quantileEstimator`, `distribution`, `momentScaling`) ride
 *     `assumptions`.
 */

import {
  ensureArrayWhenPresent as ensureArrayWhenPresentVaR,
  ensureBooleanWhenPresent,
  ensureEnumWhenPresent,
  ensureFiniteOptionsWhenPresent,
  ensureFiniteWhenPresent,
} from './options-internal.js';
import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureKnownKeys,
  seriesFacade,
  suspiciousReturnsWarning,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  ensureEnum,
} from '@totalfinance/core';
import {
  type Matrix,
  type RandomNumberGenerator,
  mean as mathMean,
  normalInverseCdf,
  normalPdf,
  normalSample,
  quantile as mathQuantile,
  mulberry32,
  correlatedNormalSampler,
} from '@totalfinance/math';
import { dot, matVec, quadForm, assertSquare, requireFiniteSymmetric } from './linalg.js';

export type VaRMethod = 'parametric' | 'historical' | 'monteCarlo';

/**
 * Hard cap on Monte-Carlo draws (2026-08-23 review, P0): `samples` sizes a materialized simulation
 * array and drives a synchronous draw-and-sort loop, so an astronomical count validated only as "an
 * integer" was an absurd allocation (`Number.isInteger(1e308)` is `true`) or a non-terminating loop
 * (above 2^53 the counter stops advancing). 10^6 draws is ~8 MB of doubles, well under a second of
 * normal sampling plus the sort, and Monte-Carlo error there (∝ 1/√n ≈ 0.1%) is already far below
 * the model error of simulating from a fitted normal. Matches `MAX_SAMPLES` in book-var.ts.
 */
const MAX_MONTE_CARLO_SAMPLES = 1_000_000;

export interface VaROptions {
  /** Confidence level in (0, 1). Default 0.95. */
  confidence?: number;
  /**
   * Estimation method. Default `'historical'`.
   *   - `'historical'` — the empirical (hyndman-fan-7) tail quantile of the sample;
   *   - `'parametric'` — the Gaussian quantile of the fitted (μ, σ), optionally Cornish-Fisher;
   *   - `'monteCarlo'` — draws from the **fitted NORMAL** and takes its empirical tail. It captures
   *     no non-normality whatsoever (same two moments as `'parametric'`, plus sampling noise), so
   *     prefer `'parametric'` unless you specifically want sampling diagnostics; use
   *     `'historical'` or the EVT tools when the shape of the tail matters.
   */
  method?: VaRMethod;
  /** Holding-period horizonPeriods in periods; scales by √-time. Default 1. */
  horizonPeriods?: number;
  /**
   * Parametric only: Cornish-Fisher adjustment for skew/excess-kurtosis. Default false. Applied
   * only where the expansion is a monotone quantile map; outside that domain the plain Gaussian
   * quantile is reported with a `risk.cornish_fisher_out_of_domain` warning and
   * `cornishFisher: false`. Over a multi-period `horizonPeriods` the moments are rescaled to the
   * horizon under iid aggregation (`skew/√h`, `excessKurtosis/h`), disclosed as
   * `assumptions.momentScaling: 'iid'`. On a non-parametric method it is ignored with an info
   * warning, never silently.
   */
  cornishFisher?: boolean;
  /** Monte-Carlo only: number of simulated paths. Default 10000. */
  samples?: number;
  /** Monte-Carlo only: PRNG seed for reproducibility. Default 1. */
  seed?: number;
}

/** The documented {@link VaROptions} keys — Law 12: an unknown option must throw, never no-op. */
const VAR_OPTIONS_KEYS = [
  'confidence',
  'method',
  'horizonPeriods',
  'cornishFisher',
  'samples',
  'seed',
] as const;

export interface VaRResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /**
   * Structured warnings; always present (possibly empty). This is the ONE warnings channel: the
   * legacy top-level `warnings` twin was removed pre-1.0 (two arrays that had to be kept in sync is
   * a defect waiting to happen — a caller reading the stale one silently misses a disclosure).
   */
  diagnostics: { warnings: QuantWarning[] };
  /** Positive loss magnitude at `confidence`. */
  valueAtRisk: number;
  /** Conditional VaR / expected shortfall (mean loss beyond VaR); ≥ `var`. */
  conditionalValueAtRisk: number;
  confidence: number;
  method: VaRMethod;
  horizonPeriods: number;
  /** Monte-Carlo only: the PRNG seed actually used (echoed for reproducibility). */
  seed?: number;
  /** Monte-Carlo only: the number of simulated samples actually drawn. */
  samples?: number;
  /**
   * Whether the Cornish-Fisher adjustment was actually APPLIED to the VaR quantile (parametric
   * only). `false` when it was requested but its expansion was out of domain — the plain Gaussian
   * quantile was reported instead and a `risk.cornish_fisher_out_of_domain` warning says so.
   */
  cornishFisher?: boolean;
}

function requireConfidence(c: number, functionName: string): number {
  if (!(c > 0 && c < 1)) {
    throw new InputError(`${functionName}: confidence must be in (0, 1).`, {
      code: ErrorCode.InputOutOfRange,
      context: { functionName, confidence: c },
    });
  }
  return c;
}

function clean(returns: ArrayLike<number>, functionName: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    const v = returns[i]!;
    if (!Number.isFinite(v)) {
      throw new InputError(`${functionName}: returns must be finite.`, {
        code: ErrorCode.InputNotFinite,
        context: { functionName, index: i, value: v },
      });
    }
    out.push(v);
  }
  if (out.length === 0) {
    throw new InputError(`${functionName}: returns must be non-empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { functionName },
    });
  }
  return out;
}

function moments(r: number[]): { mu: number; sigma: number; skew: number; exKurt: number } {
  const n = r.length;
  const mu = mathMean(r);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of r) {
    const d = x - mu;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sigma = Math.sqrt(m2);
  const skew = m2 > 0 ? m3 / m2 ** 1.5 : 0;
  const exKurt = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
  return { mu, sigma, skew, exKurt };
}

/**
 * Scale a one-period return statistic (a quantile or tail mean) to a multi-period `horizonPeriods`:
 * the mean drifts linearly while the *demeaned* part scales by √-time. Matches the parametric
 * (μ·h, σ·√h) convention, so all three VaR methods agree on how horizonPeriods affects risk.
 */
function scaleToHorizon(input: { value: number; mean: number; horizonPeriods: number }): number {
  const { value, mean: mu, horizonPeriods } = input;
  return mu * horizonPeriods + (value - mu) * Math.sqrt(horizonPeriods);
}

const VAR_METHODS: readonly VaRMethod[] = ['parametric', 'historical', 'monteCarlo'];

/** Cornish-Fisher modified quantile `w` of the standardized loss tail at level `alpha`. */
function cornishFisherZ(input: {
  alpha: number;
  skewness: number;
  excessKurtosis: number;
}): number {
  const { alpha, skewness: skew, excessKurtosis: exKurt } = input;
  const z = normalInverseCdf(alpha); // lower-tail z (negative)
  return (
    z +
    ((z * z - 1) / 6) * skew +
    ((z * z * z - 3 * z) / 24) * exKurt -
    ((2 * z * z * z - 5 * z) / 36) * skew * skew
  );
}

/**
 * The deepest tail the parametric VaR family validates the Cornish-Fisher expansion against: the
 * 99.9% quantile. Anchoring the domain test at a FIXED tail (rather than only at the requested one)
 * is what makes the answer monotone in confidence: the in/out-of-domain verdict is the same for
 * every confidence up to 99.9%, so a series cannot be CF-corrected at 95% and Gaussian at 99% —
 * the mixture that used to let a 99% VaR come back SMALLER than the 95% one.
 */
const CORNISH_FISHER_DOMAIN_ANCHOR_ALPHA = 1e-3;

/**
 * Is the Cornish-Fisher quantile map usable at this tail? Same gate as `bookVaR`'s (book-var.ts):
 * CF is only a quantile when its map `q(z)` is MONOTONE over the region being read, i.e.
 * `q'(z) = qa·z² + qb·z + qc > 0` there. Outside that domain the "quantile" folds back on itself and
 * the expansion returns a number that moves the WRONG WAY with confidence (a crash-day series
 * reporting a 99% VaR of exactly 0 while its 95% VaR is 1.5%).
 *
 * The window is `[min(z_α, z_{1e-3}), −min(z_α, z_{1e-3})]`: the requested tail UNION the fixed
 * anchor tail. (bookVaR uses a 1e-4 anchor because it also integrates a CF expected shortfall down
 * to that depth; a single VaR quantile is read at most at its own tail, so the anchor sits at the
 * deepest confidence this family serves. A global ∀z test would wrongly reject mild skew, where
 * `qa` dips slightly below 0.)
 */
function cornishFisherInDomain(input: {
  alpha: number;
  skewness: number;
  excessKurtosis: number;
}): boolean {
  const { alpha, skewness: skew, excessKurtosis: exKurt } = input;
  const a = skew / 6;
  const b = exKurt / 24;
  const qa = 3 * b - 6 * a * a;
  const qb = 2 * a;
  const qc = 1 - 3 * b + 5 * a * a;
  const qprime = (z: number): number => qa * z * z + qb * z + qc;
  const zLo = Math.min(
    normalInverseCdf(CORNISH_FISHER_DOMAIN_ANCHOR_ALPHA),
    normalInverseCdf(alpha),
  );
  const zHi = -zLo;
  let qMin = Math.min(qprime(zLo), qprime(zHi));
  if (qa > 0) {
    const zVertex = -qb / (2 * qa);
    if (zVertex > zLo && zVertex < zHi) qMin = Math.min(qMin, qprime(zVertex));
  }
  return qMin > 0;
}

/** Full VaR + CVaR report for a single return/P&L series. */
export function valueAtRiskReport(returns: ArrayLike<number>, options: VaROptions = {}): VaRResult {
  requireArgumentArray('valueAtRiskReport', 'returns', returns);
  const functionName = 'valueAtRiskReport';
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject(functionName, 'options', options);
  // Shared entry for valueAtRisk / expectedShortfall (plain AND .explain): a misspelled option
  // (`confidnce: 0.99` running at the 0.95 default) must throw, never silently change the VaR.
  ensureKnownKeys(functionName, 'options', options, VAR_OPTIONS_KEYS);
  // When-present ladders BEFORE any coalesce (the 350c2796 ruling): `{ confidence: null }` used
  // to run at 0.95, and a truthy string cornishFisher silently engaged the expansion.
  ensureFiniteOptionsWhenPresent(functionName, options as Record<string, unknown>, [
    'confidence',
    'horizonPeriods',
  ]);
  ensureBooleanWhenPresent(options.cornishFisher, functionName, 'cornishFisher');
  ensureFiniteWhenPresent((options as Record<string, unknown>)['samples'], 'samples', functionName);
  ensureEnumWhenPresent(options.method, functionName, 'method', VAR_METHODS);
  // Validated at the SHARED entry, not just inside the Monte-Carlo block: seed is a declared
  // option of this closed request, so `{ seed: null }` teaches even when the method never
  // consumes it — otherwise the historical path silently accepts a seed the caller thinks is set.
  // Safe integer (2026-08-23 review, P0): above 2^53 adjacent integers collide, so two "different"
  // seeds silently reproduce the same stream — reproducibility is the whole point of the field.
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) {
    throw new InputError(
      `${functionName}: seed must be an integer within ±(2^53 − 1) (a safe integer) for reproducibility; got ${options.seed === null ? 'null' : String(options.seed)}.`,
      { code: ErrorCode.InputOutOfRange, context: { functionName, seed: options.seed } },
    );
  }
  const confidence = requireConfidence(options.confidence ?? 0.95, functionName);
  const method = options.method ?? 'historical';
  // Reject an unknown method rather than silently treating it as Monte Carlo (design law #4).
  if (!VAR_METHODS.includes(method)) {
    throw new InputError(
      `${functionName}: method must be one of ${VAR_METHODS.join(', ')}; got "${method}".`,
      { code: ErrorCode.InputInvalidEnum, context: { functionName, method } },
    );
  }
  ensureFiniteWhenPresent(options.horizonPeriods, 'horizonPeriods', 'valueAtRiskReport');
  const horizonPeriods = options.horizonPeriods ?? 1;
  if (!(horizonPeriods > 0)) {
    throw new InputError(`${functionName}: horizonPeriods must be positive.`, {
      code: ErrorCode.InputOutOfRange,
      context: { functionName, horizonPeriods },
    });
  }
  const r = clean(returns, functionName);
  const alpha = 1 - confidence;
  const hScale = Math.sqrt(horizonPeriods);

  let varLoss: number;
  let cvarLoss: number;
  // Echoed only for the Monte-Carlo path (design law: a serialized result must be reproducible).
  let monteCarloEcho: { seed: number; samples: number } | undefined;
  const warnings: QuantWarning[] = [];
  // Method-specific conventions that ride `assumptions` (Law 2): the quantile estimator, the
  // moment-scaling rule, the simulated distribution — each is disclosed, never assumed known.
  const methodAssumptions: Record<string, unknown> = {};
  // dx WS-3/R6: flag a price-looking series passed as returns before reporting a nonsense VaR.
  const suspicious = suspiciousReturnsWarning(r);
  if (suspicious !== undefined) warnings.push(suspicious);
  let usedCornishFisher = false;
  // Law 12 sibling of "an unknown option throws": `cornishFisher` is documented parametric-only, so
  // requesting it on another method must SAY it was ignored rather than silently no-op.
  if (options.cornishFisher === true && method !== 'parametric') {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `${functionName}: cornishFisher applies to the parametric method only; it was ignored for method "${method}" (the ${method} tail is empirical, not a moment expansion).`,
        'info',
        { method },
      ),
    );
  }

  if (method === 'parametric') {
    const { mu, sigma, skew: skew1, exKurt: exKurt1 } = moments(r);
    const muH = mu * horizonPeriods;
    const sigmaH = sigma * hScale;
    // The quantile is read on the h-PERIOD distribution, so the shape moments must be the h-period
    // ones too. Under iid aggregation skewness scales 1/√h and excess kurtosis 1/h (both → 0 as the
    // sum normalizes). Feeding one-period skew/kurtosis to a √h-scaled quantile — as this did —
    // over-corrects a 10-day VaR by the full one-day asymmetry.
    const skew = skew1 / hScale;
    const exKurt = exKurt1 / horizonPeriods;
    let z = normalInverseCdf(alpha);
    if (options.cornishFisher === true) {
      if (cornishFisherInDomain({ alpha, skewness: skew, excessKurtosis: exKurt })) {
        usedCornishFisher = true;
        z = cornishFisherZ({ alpha, skewness: skew, excessKurtosis: exKurt });
      } else {
        // Past the anchor tail the expansion can fall out of domain while it was still valid AT the
        // anchor. The bare Gaussian quantile there could come back below the CF loss reported at a
        // LOWER confidence, so floor the reported loss at the deepest trustworthy CF quantile —
        // monotonicity in confidence is a property of the family, not of one call.
        if (
          alpha < CORNISH_FISHER_DOMAIN_ANCHOR_ALPHA &&
          cornishFisherInDomain({
            alpha: CORNISH_FISHER_DOMAIN_ANCHOR_ALPHA,
            skewness: skew,
            excessKurtosis: exKurt,
          })
        ) {
          z = Math.min(
            z,
            cornishFisherZ({
              alpha: CORNISH_FISHER_DOMAIN_ANCHOR_ALPHA,
              skewness: skew,
              excessKurtosis: exKurt,
            }),
          );
        }
        // Out of domain: the expansion is not a quantile here. Report the plain parametric quantile
        // and say why — never a folded-back "VaR" that shrinks as confidence rises.
        warnings.push(
          warning(
            WarningCode.RiskCornishFisherOutOfDomain,
            `${functionName}: the return distribution is too far from normal for a reliable Cornish-Fisher expansion (skewness ${skew.toFixed(2)}, excess kurtosis ${exKurt.toFixed(2)}); the plain parametric (Gaussian) quantile is reported instead (never below the deepest still-valid CF loss, so VaR stays monotone in confidence) — use method 'historical' for this series.`,
            'warn',
            { skewness: skew, excessKurtosis: exKurt, confidence, horizonPeriods },
          ),
        );
      }
      if (horizonPeriods !== 1) methodAssumptions['momentScaling'] = 'iid';
    }
    varLoss = -(muH + sigmaH * z);
    // Gaussian expected shortfall (Cornish-Fisher CVaR has no clean closed form; fall back to the
    // Gaussian ES, which is exact when cornishFisher is off).
    cvarLoss = -(muH - (sigmaH * normalPdf(normalInverseCdf(alpha))) / alpha);
    if (usedCornishFisher) {
      // The VaR quantile is CF-adjusted, but the reported CVaR is the GAUSSIAN ES — say so, don't
      // silently mix a skew/kurtosis-aware VaR with a normal-tail CVaR (design law #4).
      warnings.push({
        code: WarningCode.RiskCornishFisherConditionalValueAtRiskGaussianFallback,
        message:
          'Cornish-Fisher VaR was requested, but CVaR (expected shortfall) has no clean CF closed form; the reported CVaR is the Gaussian ES, which understates the tail when skew/kurtosis are large.',
        severity: 'info',
      });
    }
  } else if (method === 'historical') {
    const mu = mathMean(r);
    const sorted = [...r].sort((a, b) => a - b);
    const q = mathQuantile(sorted, alpha); // one-period lower-tail return
    // mean of the tail at or below the VaR quantile
    const tail = sorted.filter((x) => x <= q);
    const tailMean = tail.length > 0 ? mathMean(tail) : q;
    // √-time horizonPeriods scaling on the demeaned tail (not a linear ·h on the whole quantile).
    varLoss = -scaleToHorizon({ value: q, mean: mu, horizonPeriods });
    cvarLoss = -scaleToHorizon({ value: tailMean, mean: mu, horizonPeriods });
    // The estimator is a CONVENTION, not a detail: `quantile` is Hyndman-Fan type 7 (the R/NumPy
    // default), which INTERPOLATES between order statistics. At α·(n−1) < 1 the requested tail sits
    // between the worst observation and the second-worst — the sample cannot resolve it, and the
    // interpolation can even land on a positive return (a "negative loss" the clamp below turns
    // into a VaR of exactly 0). Disclose the estimator always, and flag the unresolvable tail.
    methodAssumptions['quantileEstimator'] = 'hyndman-fan-7';
    if (alpha * (r.length - 1) < 1) {
      warnings.push(
        warning(
          ErrorCode.RiskQuantileBeyondSample,
          `${functionName}: the ${(confidence * 100).toFixed(1)}% tail needs (1−confidence)·(n−1) = ${(alpha * (r.length - 1)).toFixed(2)} order statistics but the sample has ${r.length} observations — the quantile is an extrapolation off the worst one (hyndman-fan-7 interpolation), not a resolved tail. Use ≥ ${Math.ceil(1 / alpha + 1)} observations, a lower confidence, or method 'parametric'/EVT.`,
          'warn',
          { confidence, observations: r.length, orderStatistics: alpha * (r.length - 1) },
        ),
      );
    }
  } else {
    // Monte Carlo: simulate from the fitted normal, then take the empirical tail.
    ensureFiniteWhenPresent(options.samples, 'samples', 'value-at-risk');
    const samples = options.samples ?? 10000;
    // Safe integer AND a work cap (2026-08-23 review, P0): `Number.isInteger(1e308)` is `true`, so
    // the old gate let one call request an OOM-sized `sims` array — and above 2^53 the draw loop's
    // counter stops advancing, which is a non-terminating loop, not a slow one.
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > MAX_MONTE_CARLO_SAMPLES) {
      throw new InputError(
        `${functionName}: samples must be an integer in [1, ${MAX_MONTE_CARLO_SAMPLES.toLocaleString('en-US')}] — every sample is a normal draw materialized into the simulation array that then gets sorted, so the cap keeps the largest request under a second of synchronous work (~8 MB of doubles), and Monte-Carlo error at 10^6 samples (∝ 1/√n ≈ 0.1%) is already far below the fitted-normal model error; got ${samples}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { functionName, samples, max: MAX_MONTE_CARLO_SAMPLES },
        },
      );
    }
    const { mu, sigma } = moments(r);
    // Pre-coalesce: `{ seed: null }` must not silently become seed 1 (the 350c2796 ruling);
    // the integer guard below carries the teaching for every present-but-wrong value.
    const seed = options.seed === null ? Number.NaN : (options.seed ?? 1);
    // A serialized MC result must be reproducible; a non-integer/NaN/∞ seed silently is not — and
    // neither is one above 2^53, where adjacent integers collide (2026-08-23 review, P0).
    if (!Number.isSafeInteger(seed)) {
      throw new InputError(
        `${functionName}: seed must be an integer within ±(2^53 − 1) (a safe integer) for reproducibility; got ${seed}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { functionName, seed },
        },
      );
    }
    monteCarloEcho = { seed, samples };
    const randomNumberGenerator = mulberry32(seed);
    const sims: number[] = [];
    for (let i = 0; i < samples; i++) sims.push(normalSample(randomNumberGenerator, mu, sigma));
    sims.sort((a, b) => a - b);
    const q = mathQuantile(sims, alpha);
    const tail = sims.filter((x) => x <= q);
    const tailMean = tail.length > 0 ? mathMean(tail) : q;
    varLoss = -scaleToHorizon({ value: q, mean: mu, horizonPeriods });
    cvarLoss = -scaleToHorizon({ value: tailMean, mean: mu, horizonPeriods });
    // The simulated law is a CONVENTION, and it is a strong one: the draws come from the NORMAL
    // fitted to (mu, sigma) — so this method captures no skew, no fat tail, nothing the sample
    // showed beyond its first two moments. Disclosed, never implied by the word "monteCarlo".
    methodAssumptions['distribution'] = 'fitted-normal';
  }

  // A profitable tail produces a negative "loss"; VaR/CVaR clamp at 0 (no risk of loss). The clamp
  // is a real answer for a genuinely profitable tail — and a red flag when it fires at a HIGH
  // confidence, where it means the tail estimate itself broke down. Say which (Law 2), never a
  // bare 0.
  const clampFired = varLoss < 0;
  varLoss = Math.max(0, varLoss);
  cvarLoss = Math.max(varLoss, cvarLoss);
  if (clampFired) {
    warnings.push(
      usedCornishFisher
        ? warning(
            WarningCode.RiskCornishFisherOutOfDomain,
            `${functionName}: the Cornish-Fisher quantile at ${(confidence * 100).toFixed(1)}% confidence is a PROFIT, so the reported VaR is the 0 clamp — the expansion has left the region where it behaves like a tail quantile. Use method 'historical' or drop cornishFisher.`,
            'warn',
            { confidence, method },
          )
        : warning(
            ErrorCode.RiskQuantileBeyondSample,
            `${functionName}: the ${(confidence * 100).toFixed(1)}% ${method} tail quantile is a PROFIT, so the reported VaR is the 0 clamp, not an estimated loss — the sample/model does not resolve a loss at this confidence.`,
            'warn',
            { confidence, method },
          ),
    );
  }
  return {
    valueAtRisk: varLoss,
    conditionalValueAtRisk: cvarLoss,
    confidence,
    method,
    horizonPeriods,
    cornishFisher: usedCornishFisher,
    ...(monteCarloEcho ?? {}),
    // The applied conventions (dx §2.4, Law 2 report grammar): the 0.95/historical/1-period
    // defaults (plus the resolved seed/samples for Monte Carlo, the quantile estimator, the
    // simulated law, and the moment-scaling rule) are disclosed, never hidden. `diagnostics` is
    // the one and only warnings channel.
    ...portfolioVarReport(
      {
        confidence,
        method,
        horizonPeriods,
        cornishFisher: usedCornishFisher,
        ...methodAssumptions,
        ...(monteCarloEcho ?? {}),
      },
      warnings,
    ),
  };
}

/** Conventions a VaR-family explain envelope discloses. */
export type ValueAtRiskAssumptionExtras = {
  confidence: number;
  method: VaRMethod;
  horizonPeriods: number;
  seed?: number;
  samples?: number;
  cornishFisher?: boolean;
  /** Historical only: the order-statistic interpolation rule (`hyndman-fan-7`, the R/NumPy default). */
  quantileEstimator?: string;
  /** Monte-Carlo only: the law actually simulated (`fitted-normal` — first two moments only). */
  distribution?: string;
  /** Cornish-Fisher over a multi-period horizon: how skew/kurtosis were scaled (`iid`). */
  momentScaling?: string;
};

/** Wrap one field of {@link valueAtRiskReport} in the core Computed envelope (dx §2.4). */
function varExplain(pick: 'valueAtRisk' | 'conditionalValueAtRisk') {
  return (
    returns: ArrayLike<number>,
    options?: VaROptions,
  ): Computed<number, ValueAtRiskAssumptionExtras> => {
    const report = valueAtRiskReport(returns, options);
    return {
      value: report[pick],
      // The report's `assumptions` ARE the envelope's assumptions — built once, so the two can
      // never disagree about what was applied (they used to be assembled twice, and only the
      // report learned about newly disclosed conventions).
      assumptions: {
        ...report.assumptions,
        conventionsVersion: CONVENTIONS_VERSION,
      } as Computed<number, ValueAtRiskAssumptionExtras>['assumptions'],
      diagnostics: { method: report.method, warnings: report.diagnostics.warnings },
    };
  };
}

/**
 * VaR (positive loss magnitude) for a single return/P&L series. Plain call → the number;
 * `.explain()` → the Computed envelope echoing confidence/method/horizonPeriods (dx §2.4: the applied
 * `confidence: 0.95` default is disclosed, never hidden).
 */
export const valueAtRisk = seriesFacade(
  'valueAtRisk',
  (returns: ArrayLike<number>, options?: VaROptions): number =>
    valueAtRiskReport(returns, options).valueAtRisk,
  varExplain('valueAtRisk'),
);

/** Conditional VaR / expected shortfall (positive loss magnitude), with the same `.explain()`. */
export const expectedShortfall = seriesFacade(
  'expectedShortfall',
  (returns: ArrayLike<number>, options?: VaROptions): number =>
    valueAtRiskReport(returns, options).conditionalValueAtRisk,
  varExplain('conditionalValueAtRisk'),
);

// ───────────────────────── portfolio risk decomposition ─────────────────────────

function checkWeightsCov(
  weights: ArrayLike<number>,
  covariance: Matrix,
  functionName: string,
): number[] {
  const w = clean(weights, functionName);
  assertSquare(covariance, w.length, functionName);
  // H07: every covariance cell finite, diagonal ≥ 0, numerically symmetric — a NaN/∞ cell or a
  // transposed entry used to ride silently through wᵀΣw into every volatility/VaR number.
  requireFiniteSymmetric(covariance, functionName);
  return w;
}

/** Validate an optional per-asset mean vector matches the asset count. */
function checkMeanLen(mean: ArrayLike<number> | undefined, n: number, functionName: string): void {
  if (mean && mean.length !== n) {
    throw new InputError(
      `${functionName}: mean length (${mean.length}) must match the number of assets (${n}).`,
      { code: ErrorCode.InputOutOfRange, context: { functionName, expected: n, got: mean.length } },
    );
  }
}

/**
 * The one variance kernel behind `portfolioVariance` / `portfolioVolatility` /
 * `diversificationRatio` (H07/H08) — inputs already validated by {@link checkWeightsCov}. A
 * materially negative quadratic form means Σ is not positive semi-definite along `w`: that is
 * REJECTED under the caller's own name (H04's lesson — never blame a delegate), not clamped to a
 * plausible 0. Only floating-point negative noise inside the documented tolerance
 * `1e-12 · max|Σᵢⱼ| · (Σ|wᵢ|)²` — comfortably above round-off (~n·ε), far below material — is
 * clamped to exactly 0.
 */
function quadFormNonNegative(w: number[], covariance: Matrix, functionName: string): number {
  const q = quadForm(covariance, w);
  if (q >= 0) return q;
  // Noise scale of the form via the triangle inequality: |wᵀΣw| ≤ max|Σᵢⱼ| · (Σ|wᵢ|)².
  let maxAbs = 0;
  for (const row of covariance) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  let l1 = 0;
  for (const wi of w) l1 += Math.abs(wi);
  const tolerance = 1e-12 * maxAbs * l1 * l1;
  if (q < -tolerance) {
    throw new InputError(
      `${functionName}: wᵀΣw = ${q} is materially negative — the covariance is not positive semi-definite along these weights.`,
      {
        code: ErrorCode.LinalgNotPositiveDefinite,
        context: { functionName, quadraticForm: q, tolerance },
      },
    );
  }
  return 0;
}

/**
 * Portfolio variance `wᵀΣw` (H07 contract): every weight and covariance cell validated finite, Σ
 * numerically symmetric with a non-negative diagonal, a materially negative quadratic form
 * rejected (`linalg.not_positive_definite`), and only the tiny documented floating-point tolerance
 * (see {@link quadFormNonNegative}) clamped to 0.
 */
export function portfolioVariance(weights: ArrayLike<number>, covariance: Matrix): number {
  requireArgumentArray('portfolioVariance', 'covariance', covariance);
  requireArgumentArray('portfolioVariance', 'weights', weights);
  const w = checkWeightsCov(weights, covariance, 'portfolioVariance');
  return quadFormNonNegative(w, covariance, 'portfolioVariance');
}

/** Portfolio volatility `√(wᵀΣw)` — H08: delegates to H07's variance kernel, validating under its own name. */
export function portfolioVolatility(weights: ArrayLike<number>, covariance: Matrix): number {
  requireArgumentArray('portfolioVolatility', 'covariance', covariance);
  requireArgumentArray('portfolioVolatility', 'weights', weights);
  const w = checkWeightsCov(weights, covariance, 'portfolioVolatility');
  return Math.sqrt(quadFormNonNegative(w, covariance, 'portfolioVolatility'));
}

/** One asset's row in a {@link RiskContributionsResult} (H10). */
export interface RiskContributionRow {
  asset: number;
  /** ∂σ_p/∂w_i; `null` when σ_p = 0 (the derivative is undefined), with a degenerate-input warning. */
  marginal: number | null;
  /** `w_i · marginal`; Σ component = σ_p. `null` under the same degenerate case. */
  component: number | null;
  /** `component / σ_p`; Σ fraction = 1 (renamed from `percent`). `null` under the same case. */
  fraction: number | null;
}

/** The H10 report: portfolio volatility + rows + the Law 2 envelope. */
export interface RiskContributionsResult {
  assumptions: { conventionsVersion: string; assets: number };
  diagnostics: { warnings: QuantWarning[] };
  portfolioVolatility: number;
  contributions: RiskContributionRow[];
}

/**
 * Per-asset volatility risk contributions (H10 report). A zero-volatility portfolio has no
 * defined marginal/component/fraction — those rows carry `null` with a degenerate-input warning
 * naming the fields, never fabricated zeros.
 */
export function riskContributions(
  weights: ArrayLike<number>,
  covariance: Matrix,
): RiskContributionsResult {
  requireArgumentArray('riskContributions', 'covariance', covariance);
  requireArgumentArray('riskContributions', 'weights', weights);
  const w = checkWeightsCov(weights, covariance, 'riskContributions');
  const sigma = Math.sqrt(quadFormNonNegative(w, covariance, 'riskContributions'));
  const cw = matVec(covariance, w);
  const degenerate = sigma === 0;
  const contributions: RiskContributionRow[] = w.map((wi, i) => {
    if (degenerate) return { asset: i, marginal: null, component: null, fraction: null };
    const marginal = cw[i]! / sigma;
    const component = wi * marginal;
    return { asset: i, marginal, component, fraction: component / sigma };
  });
  const warnings: QuantWarning[] = degenerate
    ? [
        {
          code: WarningCode.DegenerateInput,
          message:
            'riskContributions: portfolio volatility is zero — marginal/component/fraction are undefined for every asset and reported as null.',
          severity: 'warn',
          context: { portfolioVolatility: 0 },
        },
      ]
    : [];
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, assets: w.length },
    diagnostics: { warnings },
    portfolioVolatility: sigma,
    contributions,
  };
}

/**
 * Diversification ratio: weighted-average asset volatility ÷ portfolio volatility (≥ 1). A
 * zero-volatility portfolio has no finite ratio — that degenerate input throws a typed
 * `input.degenerate` error instead of returning the plausible but false value `1` (H09).
 */
export function diversificationRatio(weights: ArrayLike<number>, covariance: Matrix): number {
  requireArgumentArray('diversificationRatio', 'covariance', covariance);
  requireArgumentArray('diversificationRatio', 'weights', weights);
  const w = checkWeightsCov(weights, covariance, 'diversificationRatio');
  const sigma = Math.sqrt(quadFormNonNegative(w, covariance, 'diversificationRatio'));
  if (sigma === 0) {
    throw new InputError(
      'diversificationRatio: portfolio volatility is zero — the ratio (weighted-average asset volatility ÷ portfolio volatility) has no finite value for this input.',
      {
        code: WarningCode.DegenerateInput,
        context: { functionName: 'diversificationRatio', portfolioVolatility: 0 },
      },
    );
  }
  let weightedVolatility = 0;
  for (let i = 0; i < w.length; i++)
    weightedVolatility += Math.abs(w[i]!) * Math.sqrt(covariance[i]![i]!);
  return weightedVolatility / sigma;
}

export interface ParametricPortfolioVaROptions {
  confidence?: number;
  horizonPeriods?: number;
  /** Expected per-period returns per asset (for a non-zero mean). Default all zeros. */
  mean?: ArrayLike<number>;
}

/** The documented {@link ParametricPortfolioVaROptions} keys. */
const PARAMETRIC_PORTFOLIO_VAR_OPTIONS_KEYS = ['confidence', 'horizonPeriods', 'mean'] as const;

/** {@link monteCarloPortfolioVaR} adds the Monte-Carlo knobs to the parametric options. */
const MONTE_CARLO_PORTFOLIO_VAR_OPTIONS_KEYS = [
  ...PARAMETRIC_PORTFOLIO_VAR_OPTIONS_KEYS,
  'samples',
  'seed',
] as const;

/** Law 2 report grammar (D5): every portfolio-VaR answer carries its conventions and a warnings channel. */
function portfolioVarReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

export interface PortfolioVaRResult extends VaRResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty) — the one warnings channel. */
  diagnostics: { warnings: QuantWarning[] };
  /** Per-asset component VaR; Σ component = total VaR (zero-mean case). */
  componentVaR: number[];
  /** Per-asset marginal VaR (∂VaR/∂w_i). */
  marginalVaR: number[];
}

export interface MonteCarloPortfolioVaRResult extends VaRResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty) — the one warnings channel. */
  diagnostics: { warnings: QuantWarning[] };
  /** The PRNG seed actually used (always echoed for reproducibility). */
  seed: number;
  /** The number of simulated samples actually drawn (always echoed). */
  samples: number;
}

export interface ParametricPortfolioVaRInput {
  weights: ArrayLike<number>;
  covariance: Matrix;
  options?: ParametricPortfolioVaROptions;
}

export interface MonteCarloPortfolioVaRInput {
  weights: ArrayLike<number>;
  covariance: Matrix;
  options?: ParametricPortfolioVaROptions & { samples?: number; seed?: number };
}

/**
 * Parametric (Gaussian) portfolio VaR/CVaR from weights + covariance, with Euler risk
 * decomposition into per-asset marginal and component VaR. With zero mean, Σ componentVaR = VaR.
 */
function parametricPortfolioVaRKernel(input: ParametricPortfolioVaRInput): PortfolioVaRResult {
  requireArgumentObject('portfolioVaR', 'input', input);
  ensureKnownKeys('portfolioVaR', 'input', input, ['weights', 'covariance', 'options']);
  const { weights, covariance, options: options = {} } = input;
  requireArgumentArray('portfolioVaR', 'covariance', covariance);
  requireArgumentArray('portfolioVaR', 'weights', weights);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('portfolioVaR', 'options', options);
  ensureKnownKeys('portfolioVaR', 'options', options, PARAMETRIC_PORTFOLIO_VAR_OPTIONS_KEYS);
  const functionName = 'portfolioVaR';
  const w = checkWeightsCov(weights, covariance, functionName);
  ensureArrayWhenPresentVaR(options.mean, functionName, 'mean');
  checkMeanLen(options.mean, w.length, functionName);
  ensureFiniteWhenPresent(options.confidence, 'confidence', 'portfolioVaR');
  const confidence = requireConfidence(options.confidence ?? 0.95, functionName);
  ensureFiniteWhenPresent(options.horizonPeriods, 'horizonPeriods', 'portfolioVaR');
  const horizonPeriods = options.horizonPeriods ?? 1;
  // A non-positive/NaN horizonPeriods √-scales to NaN and would be reported unflagged (no-silent-degradation).
  if (!(horizonPeriods > 0) || !Number.isFinite(horizonPeriods)) {
    throw new InputError(
      `${functionName}: horizonPeriods must be a positive finite number; got ${horizonPeriods}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { functionName, horizonPeriods },
      },
    );
  }
  const alpha = 1 - confidence;
  const z = -normalInverseCdf(alpha); // positive
  const hScale = Math.sqrt(horizonPeriods);
  // H07 kernel under this function's own name (inputs were validated by checkWeightsCov above).
  const baseSigma = Math.sqrt(quadFormNonNegative(w, covariance, functionName));
  const sigma = baseSigma * hScale;
  const muP = options.mean ? dot(w, clean(options.mean, functionName)) * horizonPeriods : 0;
  const varLoss = Math.max(0, z * sigma - muP);
  const cvarLoss = Math.max(varLoss, (normalPdf(normalInverseCdf(alpha)) / alpha) * sigma - muP);

  const cw = matVec(covariance, w);
  const marginalVaR = cw.map((cwi) => (baseSigma > 0 ? (z * hScale * cwi) / baseSigma : 0));
  const componentVaR = w.map((wi, i) => wi * marginalVaR[i]!);
  const warnings: QuantWarning[] = [];
  return {
    valueAtRisk: varLoss,
    conditionalValueAtRisk: cvarLoss,
    confidence,
    method: 'parametric',
    horizonPeriods,
    marginalVaR,
    componentVaR,
    // The applied conventions (dx §2.4): the 0.95/1-period defaults and the zero-mean assumption
    // are disclosed, never hidden.
    ...portfolioVarReport(
      { confidence, horizonPeriods, assets: w.length, mean: options.mean ? 'provided' : 'zero' },
      warnings,
    ),
  };
}

/**
 * Monte-Carlo portfolio VaR/CVaR: draw correlated normal asset returns from the covariance (and
 * optional mean), form the portfolio P&L distribution, and take its empirical tail.
 */
function monteCarloPortfolioVaRKernel(
  input: MonteCarloPortfolioVaRInput,
): MonteCarloPortfolioVaRResult {
  requireArgumentObject('portfolioVaR', 'input', input);
  ensureKnownKeys('portfolioVaR', 'input', input, ['weights', 'covariance', 'options']);
  const { weights, covariance, options: options = {} } = input;
  requireArgumentArray('portfolioVaR', 'covariance', covariance);
  requireArgumentArray('portfolioVaR', 'weights', weights);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('portfolioVaR', 'options', options);
  ensureKnownKeys('portfolioVaR', 'options', options, MONTE_CARLO_PORTFOLIO_VAR_OPTIONS_KEYS);
  const functionName = 'portfolioVaR';
  const w = checkWeightsCov(weights, covariance, functionName);
  ensureArrayWhenPresentVaR(options.mean, functionName, 'mean');
  checkMeanLen(options.mean, w.length, functionName);
  ensureFiniteWhenPresent(options.confidence, 'confidence', 'portfolioVaR');
  const confidence = requireConfidence(options.confidence ?? 0.95, functionName);
  ensureFiniteWhenPresent(options.horizonPeriods, 'horizonPeriods', 'portfolioVaR');
  const horizonPeriods = options.horizonPeriods ?? 1;
  // A non-positive/NaN horizonPeriods √-scales to NaN and would be reported unflagged (no-silent-degradation).
  if (!(horizonPeriods > 0) || !Number.isFinite(horizonPeriods)) {
    throw new InputError(
      `${functionName}: horizonPeriods must be a positive finite number; got ${horizonPeriods}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { functionName, horizonPeriods },
      },
    );
  }
  ensureFiniteWhenPresent(options.samples, 'samples', 'portfolioVaR');
  const samples = options.samples ?? 10000;
  // Safe integer AND a work cap (2026-08-23 review, P0): `Number.isInteger(1e308)` is `true`, so
  // the old gate let one call request an OOM-sized `pnl` array — and above 2^53 the draw loop's
  // counter stops advancing, which is a non-terminating loop, not a slow one.
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > MAX_MONTE_CARLO_SAMPLES) {
    throw new InputError(
      `${functionName}: samples must be an integer in [1, ${MAX_MONTE_CARLO_SAMPLES.toLocaleString('en-US')}] — every sample draws a correlated normal vector across all assets and materializes one P&L into the array that then gets sorted, so the cap keeps the largest request seconds of synchronous work on a realistic book, and Monte-Carlo error at 10^6 samples (∝ 1/√n ≈ 0.1%) is already far below the Gaussian-copula model error; got ${samples}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { functionName, samples, max: MAX_MONTE_CARLO_SAMPLES },
      },
    );
  }
  const meanVec = options.mean ? clean(options.mean, functionName) : w.map(() => 0);
  ensureFiniteWhenPresent(options.seed, 'seed', 'portfolioVaR');
  const seed = options.seed === null ? Number.NaN : (options.seed ?? 1);
  // A serialized MC result must be reproducible; a non-integer/NaN/∞ seed silently is not — and
  // neither is one above 2^53, where adjacent integers collide (2026-08-23 review, P0).
  if (!Number.isSafeInteger(seed)) {
    throw new InputError(
      `${functionName}: seed must be an integer within ±(2^53 − 1) (a safe integer) for reproducibility; got ${seed}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { functionName, seed },
      },
    );
  }
  const randomNumberGenerator: RandomNumberGenerator = mulberry32(seed);
  const draw = correlatedNormalSampler(covariance);
  const hScale = Math.sqrt(horizonPeriods);
  const pnl: number[] = [];
  for (let s = 0; s < samples; s++) {
    const z = draw(randomNumberGenerator);
    let r = 0;
    for (let i = 0; i < w.length; i++) r += w[i]! * (meanVec[i]! * horizonPeriods + hScale * z[i]!);
    pnl.push(r);
  }
  pnl.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const q = mathQuantile(pnl, alpha);
  const tail = pnl.filter((x) => x <= q);
  const varLoss = Math.max(0, -q);
  const cvarLoss = Math.max(varLoss, -(tail.length > 0 ? mathMean(tail) : q));
  const warnings: QuantWarning[] = [];
  return {
    valueAtRisk: varLoss,
    conditionalValueAtRisk: cvarLoss,
    confidence,
    method: 'monteCarlo',
    horizonPeriods,
    seed,
    samples,
    // A serialized MC result must be reproducible AND self-interpreting (dx §2.4): the applied
    // confidence/horizonPeriods/samples/seed defaults and the zero-mean assumption are disclosed.
    ...portfolioVarReport(
      {
        confidence,
        horizonPeriods,
        samples,
        seed,
        assets: w.length,
        mean: options.mean ? 'provided' : 'zero',
      },
      warnings,
    ),
  };
}

// ───────────────────────── portfolio VaR — one door, three methods (C hygiene) ─────────────────────────

export interface HistoricalPortfolioVaROptions {
  confidence?: number;
  horizonPeriods?: number;
}

/** A matrix of asset returns: one row per observation, one column per asset (the weights' order). */
export interface HistoricalPortfolioVaRInput {
  weights: ArrayLike<number>;
  returns: ArrayLike<ArrayLike<number>>;
  method: 'historical';
  options?: HistoricalPortfolioVaROptions;
}

export interface HistoricalPortfolioVaRResult extends VaRResult {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
  /** The number of portfolio-return observations the empirical tail was read from. */
  observations: number;
}

/**
 * The one request for a portfolio's VaR: `method` names the model — `'parametric'` (a Gaussian on
 * the covariance), `'monteCarlo'` (correlated normal draws on the covariance, seeded), or
 * `'historical'` (the empirical tail of the weighted return history). No method is defaulted.
 */
export type PortfolioVaRInput =
  | (ParametricPortfolioVaRInput & { method: 'parametric' })
  | (MonteCarloPortfolioVaRInput & { method: 'monteCarlo' })
  | HistoricalPortfolioVaRInput;

export type PortfolioVaROutput =
  | PortfolioVaRResult
  | MonteCarloPortfolioVaRResult
  | HistoricalPortfolioVaRResult;

const PORTFOLIO_VAR_METHODS = ['parametric', 'historical', 'monteCarlo'] as const;
const HISTORICAL_PORTFOLIO_VAR_OPTIONS_KEYS = ['confidence', 'horizonPeriods'] as const;

function historicalPortfolioVaRKernel(
  input: HistoricalPortfolioVaRInput,
): HistoricalPortfolioVaRResult {
  const functionName = 'portfolioVaR';
  ensureKnownKeys(functionName, 'input', input, ['weights', 'returns', 'method', 'options']);
  const { weights, returns, options: options = {} } = input;
  requireArgumentArray(functionName, 'weights', weights);
  requireArgumentArray(functionName, 'returns', returns);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, HISTORICAL_PORTFOLIO_VAR_OPTIONS_KEYS);
  const w = clean(weights, functionName);
  if (w.length === 0) {
    throw new InputError(`${functionName}: weights must not be empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field: 'weights' },
    });
  }
  const observations = returns.length;
  if (observations < 2) {
    throw new InputError(
      `${functionName}: returns needs at least 2 observations (rows) to read an empirical tail; got ${observations}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, observations } },
    );
  }
  const series = new Array<number>(observations);
  for (let t = 0; t < observations; t++) {
    const row = returns[t]!;
    requireArgumentArray(functionName, `returns[${t}]`, row);
    if (row.length !== w.length) {
      throw new InputError(
        `${functionName}: returns[${t}] has ${row.length} assets but weights has ${w.length}; every row is one observation across the weights' assets.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { function: functionName, row: t, assets: row.length, weights: w.length },
        },
      );
    }
    let r = 0;
    for (let i = 0; i < w.length; i++) {
      const x = row[i]!;
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new InputError(
          `${functionName}: returns[${t}][${i}] must be a finite number; got ${typeof x === 'number' ? String(x) : typeof x}.`,
          {
            code: typeof x === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
            context: { function: functionName, row: t, asset: i },
          },
        );
      }
      r += w[i]! * x;
    }
    series[t] = r;
  }
  ensureFiniteWhenPresent(options.confidence, 'confidence', functionName);
  ensureFiniteWhenPresent(options.horizonPeriods, 'horizonPeriods', functionName);
  const report = valueAtRiskReport(series, {
    method: 'historical',
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
    ...(options.horizonPeriods !== undefined ? { horizonPeriods: options.horizonPeriods } : {}),
  });
  return {
    ...report,
    observations,
    ...portfolioVarReport(
      {
        ...report.assumptions,
        assets: w.length,
        observations,
        tail: 'empirical (weighted return history)',
      },
      report.diagnostics.warnings,
    ),
  };
}

export function portfolioVaR(input: PortfolioVaRInput): PortfolioVaROutput {
  const functionName = 'portfolioVaR';
  requireArgumentObject(functionName, 'input', input);
  const method = (input as { method?: unknown }).method;
  if (method === undefined) {
    throw new InputError(
      `${functionName}: input.method is required — 'parametric' | 'historical' | 'monteCarlo'; a VaR model is never defaulted. e.g. portfolioVaR({ weights, covariance, method: 'parametric' }).`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'method' } },
    );
  }
  ensureEnum(method as string, PORTFOLIO_VAR_METHODS, 'method', functionName);
  if (method === 'historical')
    return historicalPortfolioVaRKernel(input as HistoricalPortfolioVaRInput);
  const { method: _method, ...rest } = input as ParametricPortfolioVaRInput & { method: string };
  return method === 'parametric'
    ? parametricPortfolioVaRKernel(rest)
    : monteCarloPortfolioVaRKernel(rest as MonteCarloPortfolioVaRInput);
}
