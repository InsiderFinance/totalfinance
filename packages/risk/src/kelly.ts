import { ensureFiniteWhenPresent } from './options-internal.js';
/**
 * Kelly bet-sizing pack (spec: `docs/specs/kelly-sizing.md`, roadmap Tier 2 → Sizing). One call that
 * turns a trade's edge — a binary win/loss bet, a discrete payoff distribution, a Gaussian `μ/σ²`, or a
 * raw return sample — into a sane position size: the growth-optimal fraction `f*`, then scaled down by
 * fractional-Kelly (half by default), an explicit drawdown budget, and a hard cap, with the
 * growth/drawdown tradeoff and the fat-tail correction disclosed.
 *
 * This is the single-bankroll bet-sizing question, orthogonal to the portfolio `kelly()` in
 * `optimize.ts` (which allocates `Σ⁻¹μ` weights across correlated assets). Full Kelly maximizes long-run
 * log-growth `g(f) = E[ln(1 + f·r)]`; the drawdown model is the running-minimum law of the wealth GBM.
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
import { brentMin, cholesky, choleskySolve, variance } from '@totalfinance/math';

/** A binary win/loss bet, amounts expressed per unit staked. */
export interface BinaryEdge {
  /** Probability of the winning outcome, in (0, 1). */
  winProbability: number;
  /** Gain per unit staked on a win (e.g. 2 = win 2× the stake). Must be > 0. */
  winAmount: number;
  /** Loss per unit staked on a loss (e.g. 1 = lose the stake). Default 1. Must be > 0. */
  lossAmount?: number;
}

/** One outcome of a discrete payoff distribution, P&L per unit staked. */
export interface EdgeOutcome {
  /** Probability of this outcome, in [0, 1]; the set must sum to 1. */
  probability: number;
  /** P&L per unit staked (positive = gain, negative = loss). */
  payoff: number;
}

/** Inputs for {@link kellyBet}. Supply the edge exactly one of four ways. */
export interface KellyBetInput {
  edge:
    | { binary: BinaryEdge }
    | { outcomes: EdgeOutcome[] }
    | { gaussian: { mean: number; variance: number } }
    | { returns: ArrayLike<number> };
  /** Fraction of full Kelly to apply (0.5 = half-Kelly). Default 0.5. Must be > 0. */
  fraction?: number;
  /** Cap the applied Kelly multiple so `P(ever falling to toFraction of starting bankroll) ≤ maxProbability`. */
  drawdownLimit?: { toFraction: number; maxProbability: number };
  /** Hard cap on the recommended fraction of bankroll (e.g. 1 = no leverage). Must be > 0. */
  maxFraction?: number;
  /** Optional horizonPeriods (periods) for the growth projection. Must be > 0 when given. */
  horizonPeriods?: number;
}

/** The documented {@link KellyBetInput} keys — Law 12: an unknown field must throw, never no-op. */
const KELLY_BET_INPUT_KEYS = [
  'edge',
  'fraction',
  'drawdownLimit',
  'maxFraction',
  'horizonPeriods',
] as const;

/** The sizing verdict. */
export interface KellySizing {
  /**
   * `f*` — the growth-optimal fraction of bankroll. `null` when the edge has **no downside**, so
   * log-growth increases without bound and there is no finite unconstrained optimum (finite-success
   * law — never `Infinity`; a `risk.kelly_unbounded` diagnostic explains it).
   */
  fullKelly: number | null;
  /**
   * The recommended fraction after the fractional/drawdown/max caps (≥ 0). `null` only for a
   * no-downside edge with **no** explicit cap — a finite recommendation then requires a `maxFraction`.
   */
  recommendedFraction: number | null;
  /** `κ = recommendedFraction / fullKelly` — the applied Kelly multiple (0 when there's no edge);
   *  `null` when `fullKelly` is null (undefined against a non-existent optimum). */
  appliedFraction: number | null;
  /** Expected per-period log-growth at the recommended fraction; `null` when there is none. */
  growthRate: number | null;
  /** Expected per-period log-growth at full Kelly (the maximum); `null` for a no-downside edge. */
  growthRateFull: number | null;
  /** `ln 2 / growthRate` — periods to double at the recommended fraction (`Infinity` when growth ≤ 0,
   *  `null` when there is no finite recommendation). */
  periodsToDouble: number | null;
  /** `P(wealth ever falls to toFraction of the starting bankroll)` at the recommended fraction (continuous model). */
  drawdownRisk: { toFraction: number; probability: number };
  /** Which cap set the recommended fraction (`no-downside` = unbounded edge with no cap supplied). */
  bindingConstraint: 'fraction' | 'drawdown-limit' | 'max-fraction' | 'no-edge' | 'no-downside';
  /** Returns path only: the Gaussian `μ/σ²` estimate, for comparison with the exact empirical `f*`. */
  gaussianKelly?: number;
  /** Present when `horizonPeriods` is given: the median wealth projection over the horizonPeriods. */
  horizonGrowth?: { horizonPeriods: number; logGrowth: number; growthMultiple: number };
  /** Prose an agent relays. */
  rationale: string;
  assumptions: {
    conventionsVersion: string;
    fraction: number;
    drawdownModel: 'continuous-gbm';
    edgeType: 'binary' | 'outcomes' | 'gaussian' | 'returns';
  };
  diagnostics: Diagnostics;
}

type EdgeType = KellySizing['assumptions']['edgeType'];

/** A resolved edge: its full-Kelly fraction, a log-growth function, its worst loss, and disclosures. */
interface ResolvedEdge {
  edgeType: EdgeType;
  /** `f*` — growth-optimal fraction. `Infinity` = no downside; `≤ 0` = no edge. */
  fullKelly: number;
  /** `g(f) = E[ln(1 + f·r)]` — the per-period log-growth at fraction `f`. */
  growth: (f: number) => number;
  /** Population `μ/σ²` (returns path only), for the fat-tail comparison. */
  gaussianKelly?: number;
  warnings: QuantWarning[];
}

const f2 = (n: number): string =>
  Number.isFinite(n) ? Number(n.toFixed(2)).toString() : n > 0 ? '∞' : '−∞';
const f3 = (n: number): string => (Number.isFinite(n) ? Number(n.toFixed(3)).toString() : f2(n));
const pct = (p: number): string => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

/**
 * `P(wealth ever falls to a fraction `b` of the starting bankroll)` at an applied Kelly multiple `κ`.
 * From the running-minimum (first-passage) law of the wealth GBM: `b^(2/κ − 1)`, clamped to `[0, 1]`
 * (`κ ≥ 2` ⇒ the log-drift is non-positive ⇒ ruin is certain). `κ ≤ 0` (not betting) ⇒ no drawdown.
 * NOTE: this is relative to STARTING capital (the Thorp/MacLean–Ziemba result), not the running peak.
 */
function drawdownProbability(b: number, kappa: number): number {
  if (!(kappa > 0)) return 0;
  const exponent = 2 / kappa - 1;
  if (exponent <= 0) return 1; // κ ≥ 2 — non-positive growth drift, certain drawdown.
  const p = b ** exponent;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * The largest applied Kelly multiple `κ` keeping `P(drawdown to b) ≤ p`: `κ_max = 2/(1 + ln p/ln b)`.
 * `Infinity` when the limit is non-binding (`1 + ln p/ln b ≤ 0`).
 */
function drawdownConstrainedKappa(b: number, p: number): number {
  const denom = 1 + Math.log(p) / Math.log(b);
  return denom > 0 ? 2 / denom : Infinity;
}

/**
 * Numerically maximize a strictly concave log-growth `g` on `(0, fMax)` (Brent on `−g`). Returns 0 when
 * `g'(0) = μ ≤ 0` (no edge). `fMax = 1/L` is the leverage at which the worst loss wipes out the stake.
 */
function maximizeGrowth(g: (f: number) => number, mu: number, fMax: number): number {
  if (!(mu > 0)) return 0;
  const hi = fMax * (1 - 1e-9);
  const lo = fMax * 1e-9;
  const res = brentMin((f) => -g(f), lo, hi, { tolerance: 1e-12, maximumIterations: 300 });
  return res.argMin > 0 ? res.argMin : 0;
}

/** Resolve the four edge specifications to a common `ResolvedEdge`. */
function resolveEdge(edge: KellyBetInput['edge'], functionName: string): ResolvedEdge {
  requireArgumentObject(functionName, 'edge', edge);

  if ('binary' in edge) {
    const b = edge.binary;
    requireArgumentObject(functionName, 'edge.binary', b);
    const p = b.winProbability;
    const win = b.winAmount;
    ensureFiniteWhenPresent(b.lossAmount, 'edge.binary.lossAmount', 'kelly');
    const loss = b.lossAmount ?? 1;
    ensureFinite(p, 'edge.binary.winProbability', functionName);
    ensureFinite(win, 'edge.binary.winAmount', functionName);
    ensureFinite(loss, 'edge.binary.lossAmount', functionName);
    if (!(p > 0 && p < 1)) {
      throw new InputError(`${functionName}: winProbability must be in (0, 1); got ${p}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { winProbability: p },
      });
    }
    if (!(win > 0) || !(loss > 0)) {
      throw new InputError(
        `${functionName}: winAmount and lossAmount must be positive; got ${win}, ${loss}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { winAmount: win, lossAmount: loss },
        },
      );
    }
    const q = 1 - p;
    const fullKelly = p / loss - q / win; // f* = (p·b − q·a)/(a·b)
    return {
      edgeType: 'binary',
      fullKelly,
      growth: (f) => p * Math.log(1 + f * win) + q * Math.log(1 - f * loss),
      warnings: [],
    };
  }

  if ('outcomes' in edge) {
    requireArgumentArray(functionName, 'edge.outcomes', edge.outcomes);
    const os = edge.outcomes;
    if (os.length < 2) {
      throw new InputError(`${functionName}: edge.outcomes needs ≥ 2 outcomes; got ${os.length}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { outcomes: os.length },
      });
    }
    let probSum = 0;
    let mu = 0;
    let worstLoss = 0;
    for (let i = 0; i < os.length; i++) {
      const o = os[i]!;
      requireArgumentObject(functionName, `edge.outcomes[${i}]`, o);
      ensureFinite(o.probability, `edge.outcomes[${i}].probability`, functionName);
      ensureFinite(o.payoff, `edge.outcomes[${i}].payoff`, functionName);
      if (!(o.probability >= 0)) {
        throw new InputError(
          `${functionName}: outcome probabilities must be ≥ 0; got ${o.probability}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: i, probability: o.probability },
          },
        );
      }
      probSum += o.probability;
      mu += o.probability * o.payoff;
      if (-o.payoff > worstLoss) worstLoss = -o.payoff;
    }
    if (Math.abs(probSum - 1) > 1e-6) {
      throw new InputError(
        `${functionName}: outcome probabilities must sum to 1; got ${probSum}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { probabilitySum: probSum },
        },
      );
    }
    const growth = (f: number): number => {
      let g = 0;
      for (let i = 0; i < os.length; i++) {
        const o = os[i]!;
        if (o.probability > 0) g += o.probability * Math.log(1 + f * o.payoff);
      }
      return g;
    };
    if (worstLoss <= 0) {
      // No losing outcome — g increases without bound; f* is unbounded.
      return {
        edgeType: 'outcomes',
        fullKelly: Infinity,
        growth,
        warnings: [noDownsideWarning(functionName)],
      };
    }
    return {
      edgeType: 'outcomes',
      fullKelly: maximizeGrowth(growth, mu, 1 / worstLoss),
      growth,
      warnings: [],
    };
  }

  if ('gaussian' in edge) {
    const g = edge.gaussian;
    requireArgumentObject(functionName, 'edge.gaussian', g);
    ensureFinite(g.mean, 'edge.gaussian.mean', functionName);
    ensureFinite(g.variance, 'edge.gaussian.variance', functionName);
    if (!(g.variance > 0)) {
      throw new InputError(
        `${functionName}: edge.gaussian.variance must be positive; got ${g.variance}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { variance: g.variance },
        },
      );
    }
    const mu = g.mean;
    const v = g.variance;
    return {
      edgeType: 'gaussian',
      fullKelly: mu / v,
      // Continuous log-growth of a GBM with arithmetic drift μ and variance σ²: g(f) = f·μ − ½f²σ².
      growth: (f) => f * mu - 0.5 * f * f * v,
      warnings: [],
    };
  }

  if ('returns' in edge) {
    requireArgumentArray(functionName, 'edge.returns', edge.returns);
    const r = edge.returns;
    const n = r.length;
    if (n < 2) {
      throw new InputError(`${functionName}: edge.returns needs ≥ 2 observations; got ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { observations: n },
      });
    }
    let mu = 0;
    let worstLoss = 0;
    for (let i = 0; i < n; i++) {
      const x = r[i]!;
      ensureFinite(x, `edge.returns[${i}]`, functionName);
      mu += x;
      if (-x > worstLoss) worstLoss = -x;
    }
    mu /= n;
    const v = variance(r, { population: true });
    // C (hygiene): a zero-variance sample is a degenerate edge, not a malformed one. Every return
    // is the same number: a positive one is an edge with no downside (unbounded, capped below), a
    // non-positive one is no edge at all. The Gaussian approximation μ/σ² has no value either way,
    // so it is omitted and the diagnostic says why.
    const degenerate = !(v > 0);
    const gaussianKelly = degenerate ? undefined : mu / v;
    const zeroVariance = degenerate ? [zeroVarianceWarning(functionName, r[0]!)] : [];
    const growth = (f: number): number => {
      let g = 0;
      for (let i = 0; i < n; i++) g += Math.log(1 + f * r[i]!);
      return g / n;
    };
    if (worstLoss <= 0) {
      return {
        edgeType: 'returns',
        fullKelly: Infinity,
        growth,
        ...(gaussianKelly === undefined ? {} : { gaussianKelly }),
        warnings: [...zeroVariance, noDownsideWarning(functionName)],
      };
    }
    return {
      edgeType: 'returns',
      fullKelly: maximizeGrowth(growth, mu, 1 / worstLoss),
      growth,
      ...(gaussianKelly === undefined ? {} : { gaussianKelly }),
      warnings: zeroVariance,
    };
  }

  throw new InputError(
    `${functionName}: edge must specify exactly one of binary / outcomes / gaussian / returns.`,
    { code: ErrorCode.InputMissingField, context: { keys: Object.keys(edge) } },
  );
}

function zeroVarianceWarning(functionName: string, value: number): QuantWarning {
  return warning(
    WarningCode.RiskKellyZeroVariance,
    `${functionName}: edge.returns have zero variance (every return is ${value}); the Gaussian Kelly approximation μ/σ² is undefined and omitted — the sizing below rests on the empirical growth curve alone.`,
    'warn',
    { value },
  );
}

function noDownsideWarning(functionName: string): QuantWarning {
  return warning(
    WarningCode.RiskKellyUnbounded,
    `${functionName}: the edge has no losing outcome, so log-growth increases without bound and full Kelly is infinite. Cap the size with maxFraction; the recommendation defaults to that cap.`,
    'warn',
  );
}

/**
 * Size a single bet by the Kelly criterion — compute the growth-optimal fraction from the edge, then
 * scale it down sanely (half-Kelly by default, a drawdown budget, a hard cap) with the growth, the
 * drawdown risk, and the fat-tail correction all disclosed. See `docs/specs/kelly-sizing.md`.
 */
export function kellyBet(input: KellyBetInput): KellySizing {
  const functionName = 'kellyBet';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled knob (`maxFracton: 1` leaving the size uncapped) must throw, never no-op.
  ensureKnownKeys(functionName, 'input', input, KELLY_BET_INPUT_KEYS);
  ensureFiniteWhenPresent(input.fraction, 'fraction', 'kellyBet');
  const fraction = input.fraction ?? 0.5;
  if (!(fraction > 0)) {
    throw new InputError(
      `${functionName}: fraction must be positive (0.5 = half-Kelly); got ${fraction}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { fraction },
      },
    );
  }
  ensureFinite(fraction, 'fraction', functionName);
  if (input.maxFraction !== undefined && !(input.maxFraction > 0)) {
    throw new InputError(
      `${functionName}: maxFraction must be positive; got ${input.maxFraction}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxFraction: input.maxFraction },
      },
    );
  }
  if (input.horizonPeriods !== undefined && !(input.horizonPeriods > 0)) {
    throw new InputError(
      `${functionName}: horizonPeriods must be positive; got ${input.horizonPeriods}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { horizonPeriods: input.horizonPeriods },
      },
    );
  }
  let ddToFraction = 0.5;
  let ddMaxProb: number | undefined;
  if (input.drawdownLimit !== undefined) {
    const dl = input.drawdownLimit;
    requireArgumentObject(functionName, 'drawdownLimit', dl);
    if (!(dl.toFraction > 0 && dl.toFraction < 1)) {
      throw new InputError(
        `${functionName}: drawdownLimit.toFraction must be in (0, 1); got ${dl.toFraction}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { toFraction: dl.toFraction },
        },
      );
    }
    if (!(dl.maxProbability > 0 && dl.maxProbability < 1)) {
      throw new InputError(
        `${functionName}: drawdownLimit.maxProbability must be in (0, 1); got ${dl.maxProbability}.`,
        { code: ErrorCode.InputOutOfRange, context: { maxProbability: dl.maxProbability } },
      );
    }
    ddToFraction = dl.toFraction;
    ddMaxProb = dl.maxProbability;
  }

  const resolved = resolveEdge(input.edge, functionName);
  const { fullKelly, growth, edgeType } = resolved;
  const warnings: QuantWarning[] = [...resolved.warnings];

  // ── No edge: f* ≤ 0 ⇒ do not bet (never a hedged small number, never a short) ──
  if (fullKelly <= 0) {
    warnings.push(
      warning(
        WarningCode.RiskKellyNoEdge,
        `${functionName}: the edge is non-positive (full Kelly ${f3(fullKelly)} ≤ 0), so the growth-optimal action is to not bet.`,
        'warn',
      ),
    );
    const rationale = `No edge: the growth-optimal Kelly fraction is ${f3(fullKelly)} ≤ 0, so this bet loses money on average — do not bet. Sizing anything above zero has negative expected log-growth.`;
    return assemble({
      fullKelly,
      recommendedFraction: 0,
      appliedFraction: 0,
      growthRate: 0,
      growthRateFull: 0,
      periodsToDouble: Infinity,
      drawdownRisk: { toFraction: ddToFraction, probability: 0 },
      bindingConstraint: 'no-edge',
      gaussianKelly: resolved.gaussianKelly,
      horizonGrowth: undefined,
      rationale,
      fraction,
      edgeType,
      warnings,
    });
  }

  // ── No downside: g increases without bound ⇒ no finite full-Kelly optimum (finite-success law) ──
  // `resolveEdge` already attached the `risk.kelly_unbounded` diagnostic. Represent the state with a
  // null unconstrained fraction + discriminant rather than Infinity; a finite recommendation exists
  // only if the caller supplied an explicit, finite cap. A no-downside edge never draws down.
  if (!Number.isFinite(fullKelly)) {
    const cap = input.maxFraction;
    const capped = cap !== undefined && Number.isFinite(cap);
    const rec = capped ? cap! : null;
    const gRate = rec !== null ? growth(rec) : null;
    const rationale = capped
      ? `No downside: full Kelly is unbounded, so the recommendation is the hard maxFraction cap of ${pct(cap!)} of bankroll (expected log-growth ${f3(gRate!)} per period).`
      : `No downside: log-growth increases without bound, so there is no finite Kelly optimum. Supply an explicit maxFraction to get a finite, capped recommendation.`;
    return assemble({
      fullKelly: null,
      recommendedFraction: rec,
      appliedFraction: null,
      growthRate: gRate,
      growthRateFull: null,
      periodsToDouble: gRate !== null ? (gRate > 0 ? Math.LN2 / gRate : Infinity) : null,
      drawdownRisk: { toFraction: ddToFraction, probability: 0 },
      bindingConstraint: capped ? 'max-fraction' : 'no-downside',
      gaussianKelly: resolved.gaussianKelly,
      horizonGrowth:
        capped && input.horizonPeriods !== undefined && gRate !== null
          ? {
              horizonPeriods: input.horizonPeriods,
              logGrowth: input.horizonPeriods * gRate,
              growthMultiple: Math.exp(input.horizonPeriods * gRate),
            }
          : undefined,
      rationale,
      fraction,
      edgeType,
      warnings,
    });
  }

  // ── Caps (in fraction-of-bankroll terms) — fullKelly is finite and > 0 past this point ──
  const finite = Number.isFinite(fullKelly);
  const capFractional = finite ? fraction * fullKelly : Infinity; // undefined for f*=∞ → non-binding
  const kappaMax =
    ddMaxProb !== undefined ? drawdownConstrainedKappa(ddToFraction, ddMaxProb) : Infinity;
  const capDrawdown = finite && Number.isFinite(kappaMax) ? kappaMax * fullKelly : Infinity;
  const capMax = input.maxFraction ?? Infinity;

  const caps: Array<{ label: KellySizing['bindingConstraint']; value: number }> = [
    { label: 'fraction', value: capFractional },
    { label: 'drawdown-limit', value: capDrawdown },
    { label: 'max-fraction', value: capMax },
  ];
  let recommendedFraction = Infinity;
  let bindingConstraint: KellySizing['bindingConstraint'] = 'fraction';
  for (const c of caps) {
    if (c.value < recommendedFraction) {
      recommendedFraction = c.value;
      bindingConstraint = c.label;
    }
  }
  if (!Number.isFinite(recommendedFraction)) {
    // No-downside edge with no maxFraction/finite cap — honest ∞ rather than a fabricated number.
    recommendedFraction = Infinity;
  }
  if (recommendedFraction < 0) recommendedFraction = 0;

  const appliedFraction = finite ? recommendedFraction / fullKelly : Infinity; // κ
  const growthRate = Number.isFinite(recommendedFraction) ? growth(recommendedFraction) : Infinity;
  const growthRateFull = finite ? growth(fullKelly) : Infinity;
  const periodsToDouble = growthRate > 0 ? Math.LN2 / growthRate : Infinity;
  const ddProbability = drawdownProbability(ddToFraction, appliedFraction);

  if (appliedFraction > 1) {
    warnings.push(
      warning(
        WarningCode.RiskKellyOver,
        `${functionName}: the applied fraction is ${f2(appliedFraction)}× full Kelly (> 1); drawdown risk is severe (P(ever falling to ${pct(ddToFraction)} of start) ≈ ${pct(ddProbability)}).`,
        'warn',
      ),
    );
  }

  // Fat-tail disclosure (returns path): the Gaussian μ/σ² vs the exact empirical f*.
  if (
    resolved.gaussianKelly !== undefined &&
    Number.isFinite(fullKelly) &&
    resolved.gaussianKelly > fullKelly * 1.15
  ) {
    warnings.push(
      warning(
        WarningCode.RiskKellyFatTails,
        `${functionName}: the exact empirical full Kelly (${f3(fullKelly)}) is below the Gaussian μ/σ² estimate (${f3(resolved.gaussianKelly)}) — the return sample's tails cut the safe size.`,
        'info',
      ),
    );
  }

  let horizonGrowth: KellySizing['horizonGrowth'];
  if (input.horizonPeriods !== undefined && Number.isFinite(growthRate)) {
    const logGrowth = input.horizonPeriods * growthRate;
    horizonGrowth = {
      horizonPeriods: input.horizonPeriods,
      logGrowth,
      growthMultiple: Math.exp(logGrowth),
    };
  }

  const rationale = composeRationale({
    edgeType,
    fullKelly,
    recommendedFraction,
    appliedFraction,
    fraction,
    bindingConstraint,
    growthRate,
    growthRateFull,
    periodsToDouble,
    ddToFraction,
    ddProbability,
    gaussianKelly: resolved.gaussianKelly,
    horizonGrowth,
  });

  return assemble({
    fullKelly,
    recommendedFraction,
    appliedFraction,
    growthRate,
    growthRateFull,
    periodsToDouble,
    drawdownRisk: { toFraction: ddToFraction, probability: ddProbability },
    bindingConstraint,
    gaussianKelly: resolved.gaussianKelly,
    horizonGrowth,
    rationale,
    fraction,
    edgeType,
    warnings,
  });
}

interface AssembleParts {
  fullKelly: number | null;
  recommendedFraction: number | null;
  appliedFraction: number | null;
  growthRate: number | null;
  growthRateFull: number | null;
  periodsToDouble: number | null;
  drawdownRisk: { toFraction: number; probability: number };
  bindingConstraint: KellySizing['bindingConstraint'];
  gaussianKelly: number | undefined;
  horizonGrowth: KellySizing['horizonGrowth'];
  rationale: string;
  fraction: number;
  edgeType: EdgeType;
  warnings: QuantWarning[];
}

function assemble(p: AssembleParts): KellySizing {
  return {
    fullKelly: p.fullKelly,
    recommendedFraction: p.recommendedFraction,
    appliedFraction: p.appliedFraction,
    growthRate: p.growthRate,
    growthRateFull: p.growthRateFull,
    periodsToDouble: p.periodsToDouble,
    drawdownRisk: p.drawdownRisk,
    bindingConstraint: p.bindingConstraint,
    ...(p.gaussianKelly !== undefined ? { gaussianKelly: p.gaussianKelly } : {}),
    ...(p.horizonGrowth !== undefined ? { horizonGrowth: p.horizonGrowth } : {}),
    rationale: p.rationale,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      fraction: p.fraction,
      drawdownModel: 'continuous-gbm',
      edgeType: p.edgeType,
    },
    diagnostics: {
      engine: 'kelly-bet',
      method: p.edgeType === 'binary' || p.edgeType === 'gaussian' ? 'closed-form' : 'brent',
      converged: true,
      warnings: p.warnings,
    },
  };
}

interface RationaleParts {
  edgeType: EdgeType;
  fullKelly: number;
  recommendedFraction: number;
  appliedFraction: number;
  fraction: number;
  bindingConstraint: KellySizing['bindingConstraint'];
  growthRate: number;
  growthRateFull: number;
  periodsToDouble: number;
  ddToFraction: number;
  ddProbability: number;
  gaussianKelly: number | undefined;
  horizonGrowth: KellySizing['horizonGrowth'];
}

/** Compose the prose rationale from the sizing decision and its supporting numbers. */
function composeRationale(p: RationaleParts): string {
  const size = Number.isFinite(p.recommendedFraction)
    ? `${pct(p.recommendedFraction)} of bankroll`
    : 'an unbounded fraction (cap it with maxFraction)';
  const full = Number.isFinite(p.fullKelly) ? `${pct(p.fullKelly)}` : 'unbounded (no downside)';

  const why: Record<KellySizing['bindingConstraint'], string> = {
    fraction: `${f2(p.fraction)}× fractional-Kelly cap (full Kelly is ${full})`,
    'drawdown-limit': `drawdown budget (kept at ${f2(p.appliedFraction)}× full Kelly so P(ever falling to ${pct(p.ddToFraction)} of start) ≤ target)`,
    'max-fraction': `the hard maxFraction cap`,
    'no-edge': 'no edge',
    'no-downside': 'no downside (unbounded full Kelly)',
  };

  const drawdown = `At this size the chance of ever falling to ${pct(p.ddToFraction)} of the starting bankroll is ≈ ${pct(p.ddProbability)}.`;
  const growth = Number.isFinite(p.periodsToDouble)
    ? `Expected log-growth ${f3(p.growthRate)} per period (~${Math.ceil(p.periodsToDouble)} periods to double); full Kelly would grow at ${f3(p.growthRateFull)}.`
    : `Expected log-growth ${f3(p.growthRate)} per period.`;

  const tail =
    p.gaussianKelly !== undefined &&
    Number.isFinite(p.fullKelly) &&
    p.gaussianKelly > p.fullKelly * 1.15
      ? ` The Gaussian μ/σ² estimate (${pct(p.gaussianKelly)}) is larger — the sample's tails cut the safe size.`
      : '';

  const horizonPeriods = p.horizonGrowth
    ? ` Over ${p.horizonGrowth.horizonPeriods} periods the median growth multiple is ~${f2(p.horizonGrowth.growthMultiple)}×.`
    : '';

  return `Bet ${size} — set by the ${why[p.bindingConstraint]}. ${growth} ${drawdown}${tail}${horizonPeriods}`;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Estimation-error-shrunk portfolio Kelly
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Input for {@link shrunkKelly}. */
export interface ShrunkKellyInput {
  /** Estimated per-period expected (excess) returns μ̂, one per asset. */
  mean: number[];
  /** Estimated covariance Σ̂ (n×n, symmetric positive-definite). */
  covariance: number[][];
  /** Number of observations T the estimates came from. Must be > 0. */
  sampleSize: number;
  /** Extra fractional-Kelly multiplier applied on top of the estimation shrinkage (e.g. 0.5). Default 1. */
  fraction?: number;
}

/** The estimation-error-shrunk Kelly book. */
export interface ShrunkKelly {
  /** Estimation-error shrinkage factor `c* ∈ [0, 1]`. */
  shrinkage: number;
  /** The applied scaling `fraction · c*`. */
  appliedScaling: number;
  /** Shrunk Kelly weights `fraction · c* · Σ̂⁻¹μ̂`. */
  weights: number[];
  /** Naive plug-in Kelly weights `Σ̂⁻¹μ̂` (before any shrinkage). */
  naiveWeights: number[];
  /** In-sample squared Sharpe `θ̂² = μ̂ᵀΣ̂⁻¹μ̂` (biased high). */
  inSampleSharpeSquared: number;
  /** Bias-corrected out-of-sample squared Sharpe `θ̂² − n/T` (may be ≤ 0). */
  correctedSharpeSquared: number;
  /** Expected out-of-sample log-growth at the applied scaling. */
  expectedGrowth: number;
  /** Expected out-of-sample log-growth of the naive (unshrunk) book — often negative. */
  naiveExpectedGrowth: number;
  assumptions: {
    conventionsVersion: string;
    assets: number;
    sampleSize: number;
    fraction: number;
  };
  diagnostics: Diagnostics;
}

/**
 * Estimation-error-shrunk portfolio Kelly. The plug-in weights `Σ̂⁻¹μ̂` overbet because `μ̂`/`Σ̂` are
 * estimated from a finite sample; this scales them by the growth-optimal factor
 * `c* = max(0, 1 − (n/T)/θ̂²)` (`θ̂² = μ̂ᵀΣ̂⁻¹μ̂`), returns a zero book when the estimated edge is
 * indistinguishable from sampling noise (`n/T ≥ θ̂²`), and discloses the biased-vs-corrected Sharpe and
 * the naive book's (often negative) expected out-of-sample growth. See `docs/specs/shrunk-kelly.md`.
 */
export function shrunkKelly(input: ShrunkKellyInput): ShrunkKelly {
  const functionName = 'shrunkKelly';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled knob (`samplesize` silently missing) must throw, never no-op.
  ensureKnownKeys(functionName, 'input', input, ['mean', 'covariance', 'sampleSize', 'fraction']);
  requireArgumentArray(functionName, 'input.mean', (input as { mean?: unknown }).mean);
  requireArgumentArray(
    functionName,
    'input.covariance',
    (input as { covariance?: unknown }).covariance,
  );
  const n = input.mean.length;
  if (n === 0) {
    throw new InputError(`${functionName}: mean must have at least one asset.`, {
      code: ErrorCode.InputOutOfRange,
      context: { assets: 0 },
    });
  }
  for (let i = 0; i < n; i++) ensureFinite(input.mean[i]!, `mean[${i}]`, functionName);
  if (input.covariance.length !== n) {
    throw new InputError(
      `${functionName}: covariance must be ${n}×${n} to match mean (got ${input.covariance.length} rows).`,
      { code: ErrorCode.InputOutOfRange, context: { rows: input.covariance.length, expected: n } },
    );
  }
  for (let i = 0; i < n; i++) {
    requireArgumentArray(functionName, `covariance[${i}]`, input.covariance[i]);
    if (input.covariance[i]!.length !== n) {
      throw new InputError(
        `${functionName}: covariance row ${i} has length ${input.covariance[i]!.length}, expected ${n}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { row: i, length: input.covariance[i]!.length },
        },
      );
    }
    for (let j = 0; j < n; j++)
      ensureFinite(input.covariance[i]![j]!, `covariance[${i}][${j}]`, functionName);
  }
  ensurePositive(input.sampleSize, 'sampleSize', functionName);
  ensureFiniteWhenPresent(input.fraction, 'fraction', 'shrunkKelly');
  const fraction = input.fraction ?? 1;
  ensurePositive(fraction, 'fraction', functionName);

  const T = input.sampleSize;
  // Σ̂⁻¹μ̂ via Cholesky — throws a typed LinalgNotPositiveDefinite if Σ̂ is not SPD.
  const L = cholesky(input.covariance);
  const naiveWeights = choleskySolve(L, input.mean);
  const inSampleSharpeSquared = input.mean.reduce((s, m, i) => s + m * naiveWeights[i]!, 0);

  const nOverT = n / T;
  const correctedSharpeSquared = inSampleSharpeSquared - nOverT;
  const shrinkage = inSampleSharpeSquared > 0 ? Math.max(0, 1 - nOverT / inSampleSharpeSquared) : 0;
  const appliedScaling = fraction * shrinkage;
  const weights = naiveWeights.map((w) => appliedScaling * w);

  // Expected OOS log-growth g(a) = a·θ²_corrected − ½a²·θ² (θ² the in-sample plug-in squared Sharpe).
  const growthAt = (a: number): number =>
    a * correctedSharpeSquared - 0.5 * a * a * inSampleSharpeSquared;
  const expectedGrowth = growthAt(appliedScaling);
  const naiveExpectedGrowth = growthAt(1);

  const warnings: QuantWarning[] = [];
  if (correctedSharpeSquared <= 0) {
    warnings.push(
      warning(
        WarningCode.RiskKellyEstimationNoEdge,
        `${functionName}: n/T = ${nOverT.toFixed(4)} ≥ the in-sample squared Sharpe ${inSampleSharpeSquared.toFixed(4)}, so the estimated edge is indistinguishable from sampling noise — the shrunk book is zero. Don't bet on this estimate.`,
        'warn',
        { nOverT, inSampleSharpeSquared, correctedSharpeSquared },
      ),
    );
  } else if (naiveExpectedGrowth < 0) {
    warnings.push(
      warning(
        WarningCode.RiskKellyNaiveOverbet,
        `${functionName}: the naive Kelly book would erode capital out-of-sample (expected growth ${naiveExpectedGrowth.toFixed(4)} < 0); shrinking to c* = ${shrinkage.toFixed(3)} restores positive expected growth (${expectedGrowth.toFixed(4)}).`,
        'warn',
        { naiveExpectedGrowth, shrinkage, expectedGrowth },
      ),
    );
  }
  if (T <= 2 * n) {
    warnings.push(
      warning(
        WarningCode.RiskKellyEstimationThinSample,
        `${functionName}: only ${T} observations for ${n} assets (T ≤ 2n) — the shrinkage is extreme and the estimates are unreliable; treat the sizing as indicative.`,
        'warn',
        { sampleSize: T, assets: n },
      ),
    );
  }

  return {
    shrinkage,
    appliedScaling,
    weights,
    naiveWeights,
    inSampleSharpeSquared,
    correctedSharpeSquared,
    expectedGrowth,
    naiveExpectedGrowth,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      assets: n,
      sampleSize: T,
      fraction,
    },
    diagnostics: {
      engine: 'shrunk-kelly',
      method: 'estimation-error shrinkage',
      converged: shrinkage > 0,
      warnings,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Cost-aware Kelly (continuous edge)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Input for {@link costAwareKelly}. */
export interface CostAwareKellyInput {
  /** The per-period edge: a Gaussian mean/variance, or a return sample (μ, σ² computed from it). */
  edge: { gaussian: { mean: number; variance: number } } | { returns: ArrayLike<number> };
  /** Per-period holding cost per unit of position (financing / borrow / carry). Default 0. */
  holdingCost?: number;
  /** One-time round-trip cost per unit of position (entry + exit). Default 0. Requires `horizonPeriods`. */
  roundTripCost?: number;
  /** Expected holding periods, to amortize `roundTripCost`. Required when `roundTripCost > 0`. */
  horizonPeriods?: number;
  /** Fractional-Kelly multiplier applied to `netKelly`. Default 0.5. Must be > 0. */
  fraction?: number;
}

/** The cost-aware sizing verdict. */
export interface CostAwareKelly {
  /** Per-period cost drag `c = holdingCost + roundTripCost/horizonPeriods`. */
  costPerPeriod: number;
  /** `μ/σ²` — the growth-optimal fraction ignoring costs; `null` when the edge has zero variance (C hygiene). */
  grossKelly: number | null;
  /** `max(0, (μ−c)/σ²)` — the cost-aware growth-optimal fraction; `null` with `grossKelly`. */
  netKelly: number | null;
  /** `fraction · netKelly` — the recommended size after fractional-Kelly; `null` with `grossKelly`. */
  recommendedFraction: number | null;
  /** `μ` — the cost at which the edge vanishes. */
  breakevenCost: number;
  /** Whether the net edge is positive (`c < μ`). */
  isProfitable: boolean;
  /** `μ²/(2σ²)` — expected log-growth at gross Kelly with no costs; `null` with `grossKelly`. */
  grossGrowth: number | null;
  /** `(μ−c)²/(2σ²)` — expected log-growth at net Kelly (the achievable optimum with costs); `null` with `grossKelly`. */
  netGrowth: number | null;
  /** `grossGrowth − netGrowth` — the log-growth the costs cost you; `null` with `grossKelly`. */
  growthDrag: number | null;
  /** Log-growth of naively betting gross Kelly while paying costs (`≤ netGrowth`); `null` with `grossKelly`. */
  ignoringCostsGrowth: number | null;
  /** The edge mean `μ` used. */
  mean: number;
  /** The edge variance `σ²` used. */
  variance: number;
  /** Prose an agent relays. */
  rationale: string;
  assumptions: { conventionsVersion: string; fraction: number; edgeType: 'gaussian' | 'returns' };
  diagnostics: Diagnostics;
}

/** Fraction of gross growth consumed by costs above which the high-drag warning fires. */
const HIGH_COST_DRAG = 0.25;

/** Resolve the continuous edge to (μ, σ²), matching `kellyBet`'s Gaussian / returns conventions. */
function resolveContinuousEdge(
  edge: CostAwareKellyInput['edge'],
  functionName: string,
): { mu: number; v: number; edgeType: 'gaussian' | 'returns' } {
  requireArgumentObject(functionName, 'edge', edge);
  if ('gaussian' in edge) {
    const g = edge.gaussian;
    requireArgumentObject(functionName, 'edge.gaussian', g);
    ensureFinite(g.mean, 'edge.gaussian.mean', functionName);
    ensureFinite(g.variance, 'edge.gaussian.variance', functionName);
    // C (hygiene): a zero variance is a degenerate edge (null sizing, below), a negative one is
    // not a variance at all.
    if (g.variance < 0) {
      throw new InputError(
        `${functionName}: edge.gaussian.variance must be non-negative; got ${g.variance}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { variance: g.variance },
        },
      );
    }
    return { mu: g.mean, v: g.variance, edgeType: 'gaussian' };
  }
  if ('returns' in edge) {
    requireArgumentArray(functionName, 'edge.returns', edge.returns);
    const r = edge.returns;
    const n = r.length;
    if (n < 2) {
      throw new InputError(`${functionName}: edge.returns needs ≥ 2 observations; got ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { observations: n },
      });
    }
    let mu = 0;
    for (let i = 0; i < n; i++) {
      ensureFinite(r[i]!, `edge.returns[${i}]`, functionName);
      mu += r[i]!;
    }
    mu /= n;
    const v = variance(r, { population: true });
    return { mu, v, edgeType: 'returns' };
  }
  throw new InputError(`${functionName}: edge must supply { gaussian } or { returns }.`, {
    code: ErrorCode.InputMissingField,
    context: { edge },
  });
}

/**
 * Cost-aware Kelly for a continuous edge. Costs — a per-period holding cost plus an amortized round-trip
 * cost, `c = holdingCost + roundTripCost/horizonPeriods` — reduce the drift (`μ → μ − c`, variance unchanged),
 * so the growth-optimal size shrinks to `netKelly = max(0, (μ−c)/σ²)` and below the breakeven cost `μ`
 * the edge is not worth betting. Reports gross vs net Kelly, the growth drag, the penalty for naively
 * betting gross while paying costs, and refuses a losing bet. See `docs/specs/cost-aware-kelly.md`.
 */
export function costAwareKelly(input: CostAwareKellyInput): CostAwareKelly {
  const functionName = 'costAwareKelly';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled knob (`holdingcost` silently costless) must throw, never no-op.
  ensureKnownKeys(functionName, 'input', input, [
    'edge',
    'holdingCost',
    'roundTripCost',
    'horizonPeriods',
    'fraction',
  ]);
  const { mu, v, edgeType } = resolveContinuousEdge(input.edge, functionName);

  ensureFiniteWhenPresent(input.holdingCost, 'holdingCost', 'costAwareKelly');
  ensureFiniteWhenPresent(input.horizonPeriods, 'horizonPeriods', 'costAwareKelly');
  const holdingCost = input.holdingCost ?? 0;
  ensureFiniteWhenPresent(input.roundTripCost, 'roundTripCost', 'costAwareKelly');
  const roundTripCost = input.roundTripCost ?? 0;
  ensureFinite(holdingCost, 'holdingCost', functionName);
  ensureFinite(roundTripCost, 'roundTripCost', functionName);
  if (holdingCost < 0 || roundTripCost < 0) {
    throw new InputError(`${functionName}: holdingCost and roundTripCost must be ≥ 0.`, {
      code: ErrorCode.InputOutOfRange,
      context: { holdingCost, roundTripCost },
    });
  }
  let amortizedRoundTrip = 0;
  if (roundTripCost > 0) {
    if (input.horizonPeriods === undefined || !(input.horizonPeriods > 0)) {
      throw new InputError(
        `${functionName}: a positive roundTripCost needs a positive horizonPeriods to amortize over; got ${input.horizonPeriods}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { roundTripCost, horizonPeriods: input.horizonPeriods },
        },
      );
    }
    amortizedRoundTrip = roundTripCost / input.horizonPeriods;
  }
  ensureFiniteWhenPresent(input.fraction, 'fraction', 'costAwareKelly');
  const fraction = input.fraction ?? 0.5;
  ensureFinite(fraction, 'fraction', functionName);
  if (!(fraction > 0)) {
    throw new InputError(`${functionName}: fraction must be positive; got ${fraction}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { fraction },
    });
  }

  const c = holdingCost + amortizedRoundTrip;
  const netEdge = mu - c;
  if (!(v > 0)) {
    // C (hygiene): a zero-variance edge has no growth-optimal size — μ/σ² is undefined. The
    // costs and the edge are still reported; every size is null beside the diagnostic.
    const isProfitable = c < mu;
    return {
      costPerPeriod: c,
      grossKelly: null,
      netKelly: null,
      recommendedFraction: null,
      breakevenCost: mu,
      isProfitable,
      grossGrowth: null,
      netGrowth: null,
      growthDrag: null,
      ignoringCostsGrowth: null,
      mean: mu,
      variance: v,
      rationale: `No size: the edge has zero variance (mean ${f3(mu)}, variance 0), so the growth-optimal fraction μ/σ² is undefined. Costs of ${f3(c)}/period ${isProfitable ? 'leave a positive net edge' : 'meet or exceed the edge'}; size it by a policy cap, not by Kelly.`,
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, fraction, edgeType },
      diagnostics: {
        engine: 'cost-aware-kelly',
        method: 'continuous-edge drift adjustment',
        converged: true,
        warnings: [
          warning(
            WarningCode.RiskKellyZeroVariance,
            `${functionName}: the edge has zero variance; the Kelly fraction is undefined and every size is null.`,
            'warn',
            { mean: mu, variance: v },
          ),
        ],
      },
    };
  }
  const grossKelly = mu / v;
  const netKelly = Math.max(0, netEdge / v);
  const recommendedFraction = fraction * netKelly;
  const grossGrowth = (mu * mu) / (2 * v);
  const netGrowth = netEdge > 0 ? (netEdge * netEdge) / (2 * v) : 0;
  const growthDrag = grossGrowth - netGrowth;
  // Log-growth of betting the (cost-blind) gross Kelly while actually paying c: g_net(grossKelly).
  const ignoringCostsGrowth = grossKelly * netEdge - 0.5 * grossKelly * grossKelly * v;
  const isProfitable = c < mu;

  const warnings: QuantWarning[] = [];
  if (!isProfitable) {
    warnings.push(
      warning(
        WarningCode.RiskCostExceedsEdge,
        `${functionName}: the per-period cost ${f3(c)} ≥ the edge ${f3(mu)} — costs consume the entire edge, so don't bet (netKelly 0).`,
        'warn',
        { cost: c, edge: mu },
      ),
    );
  } else if (grossGrowth > 0 && growthDrag / grossGrowth > HIGH_COST_DRAG) {
    warnings.push(
      warning(
        WarningCode.RiskHighCostDrag,
        `${functionName}: costs consume ${pct(growthDrag / grossGrowth)} of the gross log-growth (${f3(growthDrag)} of ${f3(grossGrowth)}); size shrinks from ${f3(grossKelly)} to ${f3(netKelly)}.`,
        'warn',
        { growthDrag, grossGrowth, fraction: growthDrag / grossGrowth },
      ),
    );
  }

  const rationale = isProfitable
    ? `Costs of ${f3(c)}/period cut the growth-optimal size from ${f3(grossKelly)} (gross) to ${f3(netKelly)} (net) — a ${pct(1 - netKelly / grossKelly)} reduction; at ${pct(fraction)}-Kelly, bet ${f3(recommendedFraction)}. They consume ${pct(growthDrag / grossGrowth)} of the gross log-growth, and naively betting the gross size while paying them gives up a further ${pct((netGrowth - ignoringCostsGrowth) / netGrowth)} of the achievable growth.`
    : `Don't bet: costs of ${f3(c)}/period meet or exceed the edge ${f3(mu)}, so the net edge is non-positive — there is no growth-optimal position with these costs.`;

  return {
    costPerPeriod: c,
    grossKelly,
    netKelly,
    recommendedFraction,
    breakevenCost: mu,
    isProfitable,
    grossGrowth,
    netGrowth,
    growthDrag,
    ignoringCostsGrowth,
    mean: mu,
    variance: v,
    rationale,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, fraction, edgeType },
    diagnostics: {
      engine: 'cost-aware-kelly',
      method: 'continuous-edge drift adjustment',
      converged: true,
      warnings,
    },
  };
}
