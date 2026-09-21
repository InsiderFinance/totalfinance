import { ensureFiniteWhenPresent } from './options-internal.js';
/**
 * Research-protocol pack (spec §14, roadmap Tier 3, agent-native). One call that renders a
 * statistically honest verdict on a completed research process: given the selected strategy's returns,
 * how many configurations were tried (for deflation), and — ideally — its out-of-sample returns, it
 * deflates the Sharpe for selection, checks out-of-sample survival, and returns `significant` /
 * `inconclusive` / `likely-overfit` with a prose rationale an agent relays.
 *
 * Pure composition of `research.ts`: `sharpeStatistics`, `deflatedSharpeRatio` (Bailey & López de Prado —
 * the PSR against the expected-max Sharpe of N trials), and `probabilisticSharpeRatio`. The value it
 * adds is the sequencing + the verdict, so honest research is the path of least resistance. See
 * `docs/specs/research-protocol.md`.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  WarningCode,
  warning,
} from '@totalfinance/core';
import { normalInverseCdf } from '@totalfinance/math';
import {
  type SharpeStatistics,
  deflatedSharpeRatio,
  probabilisticSharpeRatio,
  sharpeStatistics,
} from './research.js';

/** Inputs for {@link researchProtocol}. */
export interface ResearchProtocolInput {
  /** The selected strategy's in-sample return series (per period). */
  returns: ArrayLike<number>;
  /**
   * The pool that produced the selection, for deflation. Omit for a single pre-registered hypothesis
   * (no selection → SR₀ = 0). `trialSharpes` are the per-observation Sharpes of every config tried.
   */
  trials?: { trialSharpes: ArrayLike<number> } | { trialCount: number; varianceSharpe: number };
  /** Out-of-sample (e.g. walk-forward) returns of the SAME strategy — confirmatory. */
  outOfSampleReturns?: ArrayLike<number>;
  /** Confidence for "significant" in (0, 1); default 0.95. */
  confidence?: number;
  /** Periods per year for the annualized read-outs; default 252. */
  periodsPerYear?: number;
  riskFreeRate?: number;
}

/** The research verdict. */
export interface ResearchVerdict {
  verdict: 'significant' | 'inconclusive' | 'likely-overfit';
  /** Sharpe figures are `null` (C hygiene) when the returns have zero variance; the verdict is then `inconclusive`. */
  inSample: { sharpe: number | null; annualizedSharpe: number | null; observations: number };
  /** Probability the true Sharpe beats the selection-adjusted benchmark SR₀; `null` with `inSample.sharpe`. */
  deflatedSharpe: number | null;
  /** Un-deflated PSR (benchmark 0), for comparison; `null` with `inSample.sharpe`. */
  probabilisticSharpe: number | null;
  /** SR₀ — the expected-max Sharpe of `trialCount` under the null (0 for a single hypothesis). */
  expectedMaxSharpe: number;
  trialCount: number;
  /** Observations needed for `deflatedSharpe ≥ confidence` (`Infinity` when SR ≤ SR₀). */
  minTrackRecordLength: number;
  /** Present when out-of-sample returns are given; `null` figures when either series has zero variance. */
  outOfSample?: {
    sharpe: number | null;
    annualizedSharpe: number | null;
    degradation: number | null;
  };
  /** Prose an agent relays. */
  rationale: string;
  assumptions: { conventionsVersion: string; confidence: number; periodsPerYear: number };
  diagnostics: Diagnostics;
}

const f2 = (n: number): string =>
  Number.isFinite(n) ? Number(n.toFixed(2)).toString() : n > 0 ? '∞' : '−∞';
const pct = (p: number): string => `${(p * 100).toFixed(0)}%`;

/**
 * The minimum track-record length for `deflatedSharpe ≥ confidence`, given the in-sample stats and the
 * deflation benchmark SR₀: `1 + [1 − γ₃·SR + (γ₄−1)/4·SR²]·(Z_c/(SR − SR₀))²`; `∞` when `SR ≤ SR₀`.
 */
function minTrackRecordLength(stats: SharpeStatistics, sr0: number, confidence: number): number {
  const sr = stats.sharpe;
  if (sr === null || !(sr > sr0)) return Infinity;
  const denom = 1 - stats.skewness * sr + ((stats.kurtosis - 1) / 4) * sr * sr;
  const z = normalInverseCdf(confidence);
  return 1 + denom * (z / (sr - sr0)) ** 2;
}

/**
 * Render a statistically honest verdict on a research process — deflate for selection, confirm
 * out-of-sample, and conclude `significant` / `inconclusive` / `likely-overfit`. See the spec.
 */
export function researchProtocol(input: ResearchProtocolInput): ResearchVerdict {
  const functionName = 'researchProtocol';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled field (`outOfSampleReturn` silently skipping the OOS check) must throw.
  ensureKnownKeys(functionName, 'input', input, [
    'returns',
    'trials',
    'outOfSampleReturns',
    'confidence',
    'periodsPerYear',
    'riskFreeRate',
  ]);
  ensureFiniteWhenPresent(input.confidence, 'confidence', 'researchProtocol');
  const confidence = input.confidence ?? 0.95;
  if (!(confidence > 0 && confidence < 1)) {
    throw new InputError(`${functionName}: confidence must be in (0, 1); got ${confidence}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { confidence },
    });
  }
  ensureFiniteWhenPresent(input.periodsPerYear, 'periodsPerYear', 'researchProtocol');
  const periodsPerYear = input.periodsPerYear ?? 252;
  if (!(periodsPerYear > 0) || !Number.isFinite(periodsPerYear)) {
    throw new InputError(`${functionName}: periodsPerYear must be a positive finite number.`, {
      code: ErrorCode.InputOutOfRange,
      context: { periodsPerYear },
    });
  }
  const rfOpt = input.riskFreeRate !== undefined ? { riskFreeRate: input.riskFreeRate } : {};

  // In-sample stats + deflation.
  const stats = sharpeStatistics(input.returns, rfOpt);
  const annualize = Math.sqrt(periodsPerYear);
  const times = (x: number | null, k: number): number | null => (x === null ? null : x * k);
  let deflatedSharpe: number | null;
  let probabilisticSharpe: number | null;
  let expectedMaxSharpe: number;
  let trialCount: number;
  if (input.trials !== undefined) {
    const d = deflatedSharpeRatio(stats, input.trials);
    ({ deflatedSharpe, probabilisticSharpe, expectedMaxSharpe, trialCount } = d);
  } else {
    // Single pre-registered hypothesis — no selection, so SR₀ = 0 and deflation reduces to the PSR.
    probabilisticSharpe = probabilisticSharpeRatio(stats, 0);
    deflatedSharpe = probabilisticSharpe;
    expectedMaxSharpe = 0;
    trialCount = 1;
  }
  const minTRL = minTrackRecordLength(stats, expectedMaxSharpe, confidence);

  // Out-of-sample (confirmatory).
  let outOfSample: ResearchVerdict['outOfSample'];
  if (input.outOfSampleReturns !== undefined) {
    const oos = sharpeStatistics(input.outOfSampleReturns, rfOpt);
    const degradation =
      stats.sharpe === null || oos.sharpe === null
        ? null
        : stats.sharpe > 0
          ? 1 - oos.sharpe / stats.sharpe
          : oos.sharpe > 0
            ? 0
            : 1;
    outOfSample = {
      sharpe: oos.sharpe,
      annualizedSharpe: times(oos.sharpe, annualize),
      degradation,
    };
  }

  // Verdict: deflation is necessary; out-of-sample survival is required for `significant`.
  // C (hygiene): a series with no Sharpe (zero variance) is evidence of nothing — inconclusive.
  const undefinedSharpe =
    deflatedSharpe === null || (outOfSample !== undefined && outOfSample.sharpe === null);
  const deflationPasses = deflatedSharpe !== null && deflatedSharpe >= confidence;
  let verdict: ResearchVerdict['verdict'];
  if (undefinedSharpe) {
    verdict = 'inconclusive';
  } else if (!deflationPasses) {
    verdict = 'likely-overfit';
  } else if (outOfSample === undefined) {
    verdict = 'inconclusive';
  } else if (outOfSample.sharpe! <= 0) {
    verdict = 'likely-overfit';
  } else if (outOfSample.degradation! > 0.5) {
    verdict = 'inconclusive';
  } else {
    verdict = 'significant';
  }

  const rationale = composeRationale({
    verdict,
    confidence,
    deflatedSharpe,
    probabilisticSharpe,
    expectedMaxSharpe,
    trialCount,
    minTRL,
    inSampleAnnualized: times(stats.sharpe, annualize),
    observations: stats.observations,
    outOfSample,
  });

  return {
    verdict,
    inSample: {
      sharpe: stats.sharpe,
      annualizedSharpe: times(stats.sharpe, annualize),
      observations: stats.observations,
    },
    deflatedSharpe,
    probabilisticSharpe,
    expectedMaxSharpe,
    trialCount,
    minTrackRecordLength: minTRL,
    ...(outOfSample !== undefined ? { outOfSample } : {}),
    rationale,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, confidence, periodsPerYear },
    diagnostics: {
      engine: 'research-protocol',
      method: 'deflated-sharpe + oos',
      converged: true,
      warnings: undefinedSharpe
        ? [
            warning(
              WarningCode.RiskSharpeUndefined,
              `${functionName}: ${deflatedSharpe === null ? 'the in-sample' : 'the out-of-sample'} returns have zero variance, so the Sharpe ratio is undefined; the verdict is inconclusive and its Sharpe figures are null.`,
              'warn',
            ),
          ]
        : [],
    },
  };
}

interface RationaleParts {
  verdict: ResearchVerdict['verdict'];
  confidence: number;
  deflatedSharpe: number | null;
  probabilisticSharpe: number | null;
  expectedMaxSharpe: number;
  trialCount: number;
  minTRL: number;
  inSampleAnnualized: number | null;
  observations: number;
  outOfSample: ResearchVerdict['outOfSample'];
}

/** Compose the prose rationale from the verdict and its supporting numbers. */
function composeRationale(p: RationaleParts): string {
  if (p.deflatedSharpe === null || p.inSampleAnnualized === null) {
    return `Inconclusive: the in-sample returns have zero variance over ${p.observations} observations, so there is no Sharpe ratio to deflate or confirm. Nothing can be concluded from a series that never moved.`;
  }
  if (
    p.outOfSample !== undefined &&
    (p.outOfSample.sharpe === null || p.outOfSample.degradation === null)
  ) {
    return `Inconclusive: the out-of-sample returns have zero variance, so the edge cannot be confirmed or refuted out of sample (in-sample annualized Sharpe ${f2(p.inSampleAnnualized)}).`;
  }
  const trialsPhrase =
    p.trialCount > 1
      ? `after ${p.trialCount} trials (expected best-by-chance Sharpe ${f2(p.expectedMaxSharpe)})`
      : 'as a single hypothesis';
  const deflated = `deflated Sharpe ${pct(p.deflatedSharpe)} vs the ${pct(p.confidence)} bar`;

  if (p.verdict === 'likely-overfit') {
    if (p.deflatedSharpe < p.confidence) {
      const need = Number.isFinite(p.minTRL)
        ? ` It would need ~${Math.ceil(p.minTRL)} observations (has ${p.observations}) to clear the bar.`
        : ' Its Sharpe does not exceed the selection benchmark, so no track record length would suffice.';
      return `Likely overfit: the in-sample Sharpe (annualized ${f2(p.inSampleAnnualized)}) does not survive deflation ${trialsPhrase} — ${deflated}. The result reads as selection bias, not skill.${need}`;
    }
    return `Likely overfit: it clears deflation (${deflated}) but the edge vanishes out-of-sample (OOS annualized Sharpe ${f2(p.outOfSample!.annualizedSharpe!)} ≤ 0). Overfit to the in-sample period.`;
  }
  if (p.verdict === 'inconclusive') {
    if (p.outOfSample === undefined) {
      return `Inconclusive: it clears deflation (${deflated}, ${trialsPhrase}), but that is necessary, not sufficient. Provide out-of-sample (walk-forward) returns to confirm the edge holds.`;
    }
    return `Inconclusive: it clears deflation (${deflated}) and stays positive out-of-sample, but the edge degrades ${pct(p.outOfSample.degradation!)} (OOS annualized Sharpe ${f2(p.outOfSample.annualizedSharpe!)} vs in-sample ${f2(p.inSampleAnnualized)}). Treat with caution.`;
  }
  return `Significant: clears deflation (${deflated}, ${trialsPhrase}) and survives out-of-sample (OOS annualized Sharpe ${f2(p.outOfSample!.annualizedSharpe!)}, only ${pct(p.outOfSample!.degradation!)} degradation). This reads as a genuine edge, not overfitting.`;
}
