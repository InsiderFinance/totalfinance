import { ensureEnumWhenPresent, ensureFiniteWhenPresent } from './options-internal.js';
/**
 * Return attribution (spec: `docs/specs/attribution.md`, roadmap Tier 2). Two classic decompositions
 * that split a realized return into named, additive pieces which reconstruct the total EXACTLY:
 *
 * - `factorAttribution` — regress a return series on observable factor returns and split the realized
 *   return into a contribution per factor plus a specific (alpha/skill) residual. Because OLS residuals
 *   sum to zero with an intercept, `totalReturn = specificReturn + Σ contributions` to machine precision.
 * - `brinsonAttribution` — split a portfolio's active return vs a benchmark into allocation, selection,
 *   and interaction, with `allocation + selection + interaction = activeReturn` exactly.
 *
 * The statistical (PCA) factor model lives separately in `factor.ts` (`pca`/`factorExposure`).
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { ols } from '@totalfinance/math';

// ─────────────────────────────── factor P&L attribution ───────────────────────────────

/** One observable factor's return series. */
export interface FactorSeries {
  name: string;
  /** Per-period factor returns, aligned to the subject `returns`. */
  returns: ArrayLike<number>;
}

/** Inputs for {@link factorAttribution}. */
export interface FactorAttributionInput {
  /** The asset/portfolio return series to attribute. */
  returns: ArrayLike<number>;
  /** Observable factor return series (each aligned to `returns`). */
  factors: FactorSeries[];
  /** Per-period risk-free rate subtracted from `returns` first; default 0. */
  riskFreeRate?: number;
}

/** A factor's exposure and its contribution to the realized return. */
export interface FactorContribution {
  name: string;
  /** Exposure / loading `β_k`. */
  beta: number;
  /** t-statistic of the exposure. */
  tStatistic: number;
  /** Cumulative return attributable to the factor: `β_k · Σ(factor returns)`. */
  contribution: number;
}

/** The factor attribution. */
export interface FactorAttribution {
  factors: FactorContribution[];
  /** Per-period specific return (the OLS intercept). */
  alpha: number;
  /** Cumulative specific return `n·alpha` — the part no factor explains. */
  specificReturn: number;
  /** Total of the (excess, if `riskFreeRate` given) return series = `specificReturn + Σ contributions`. */
  totalReturn: number;
  rSquared: number;
  adjustedRSquared: number;
  observations: number;
  assumptions: { conventionsVersion: string; riskFreeRate: number };
  diagnostics: Diagnostics;
}

/**
 * Attribute a return series to observable factors by OLS regression, splitting the realized return into
 * a contribution per factor plus a specific (alpha) residual — a decomposition that reconstructs the
 * total exactly. See `docs/specs/attribution.md`.
 */
export function factorAttribution(input: FactorAttributionInput): FactorAttribution {
  const functionName = 'factorAttribution';
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled field (`riskfreeRate` running at the 0 default) must throw, never no-op.
  ensureKnownKeys(functionName, 'input', input, ['returns', 'factors', 'riskFreeRate']);
  requireArgumentArray(functionName, 'returns', input.returns);
  requireArgumentArray(functionName, 'factors', input.factors as unknown);
  const n = input.returns.length;
  const k = input.factors.length;
  if (k < 1) {
    throw new InputError(`${functionName}: at least one factor is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { factors: k },
    });
  }
  if (n < k + 2) {
    throw new InputError(
      `${functionName}: need at least k+2 = ${k + 2} observations to estimate ${k} factors + intercept; got ${n}.`,
      { code: ErrorCode.InputOutOfRange, context: { observations: n, factors: k } },
    );
  }
  ensureFiniteWhenPresent(input.riskFreeRate, 'riskFreeRate', 'factorAttribution');
  const rf = input.riskFreeRate ?? 0;
  ensureFinite(rf, 'riskFreeRate', functionName);

  // Subject series (excess), and the factor design matrix (rows aligned to observations).
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = input.returns[i]!;
    ensureFinite(v, `returns[${i}]`, functionName);
    y[i] = v - rf;
  }
  const factorSums = new Array<number>(k).fill(0);
  const X: number[][] = Array.from({ length: n }, () => new Array<number>(k));
  for (let j = 0; j < k; j++) {
    const f = input.factors[j]!;
    requireArgumentObject(functionName, `factors[${j}]`, f);
    requireArgumentArray(functionName, `factors[${j}].returns`, f.returns);
    if (f.returns.length !== n) {
      throw new InputError(
        `${functionName}: factors[${j}] ("${String(f.name)}") has ${f.returns.length} returns but the subject has ${n}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: j, length: f.returns.length, observations: n },
        },
      );
    }
    for (let i = 0; i < n; i++) {
      const v = f.returns[i]!;
      ensureFinite(v, `factors[${j}].returns[${i}]`, functionName);
      X[i]![j] = v;
      factorSums[j]! += v;
    }
  }

  const reg = ols(y, X); // intercept prepended by default: coefficients[0] = alpha, [1..k] = betas
  // Collinear / rank-deficient factors ⇒ non-finite coefficients: fail loudly rather than fabricate.
  for (let c = 0; c < reg.coefficients.length; c++) {
    if (!Number.isFinite(reg.coefficients[c]!)) {
      throw new InputError(
        `${functionName}: the factor regression is rank-deficient (collinear factors or too few observations) — coefficient ${c} is not finite.`,
        { code: ErrorCode.InputOutOfRange, context: { coefficient: c } },
      );
    }
  }

  const alpha = reg.coefficients[0]!;
  const factors: FactorContribution[] = input.factors.map((f, j) => {
    const beta = reg.coefficients[j + 1]!;
    return {
      name: f.name,
      beta,
      tStatistic: reg.tStatistics[j + 1]!,
      contribution: beta * factorSums[j]!,
    };
  });
  const specificReturn = n * alpha;
  let totalReturn = 0;
  for (let i = 0; i < n; i++) totalReturn += y[i]!;

  return {
    factors,
    alpha,
    specificReturn,
    totalReturn,
    rSquared: reg.rSquared,
    adjustedRSquared: reg.adjustedRSquared,
    observations: n,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, riskFreeRate: rf },
    diagnostics: { engine: 'factor-attribution', method: 'ols', converged: true, warnings: [] },
  };
}

// ─────────────────────────────── Brinson attribution ───────────────────────────────

/** One segment (sector/bucket) of a Brinson attribution. */
export interface BrinsonSegment {
  name: string;
  portfolioWeight: number;
  benchmarkWeight: number;
  portfolioReturn: number;
  benchmarkReturn: number;
}

/** The allocation / selection / interaction effects for one segment. */
export interface SegmentEffect {
  name: string;
  allocation: number;
  selection: number;
  interaction: number;
  /** `allocation + selection + interaction`. */
  total: number;
}

type BrinsonMethod = 'brinson-fachler' | 'brinson-hood-beebower';
const BRINSON_METHODS: readonly BrinsonMethod[] = ['brinson-fachler', 'brinson-hood-beebower'];

/** Options for {@link brinsonAttribution}. */
export interface BrinsonAttributionOptions {
  /** Allocation convention; default `'brinson-fachler'` (benchmark-relative). */
  method?: BrinsonMethod;
}

/** The Brinson attribution. */
export interface BrinsonAttribution {
  portfolioReturn: number;
  benchmarkReturn: number;
  /** `portfolioReturn − benchmarkReturn`. */
  activeReturn: number;
  /** Segment-summed effects (`allocation + selection + interaction = activeReturn`, exact). */
  allocation: number;
  selection: number;
  interaction: number;
  segments: SegmentEffect[];
  method: BrinsonMethod;
  assumptions: { conventionsVersion: string; method: BrinsonMethod };
  diagnostics: Diagnostics;
}

/**
 * Decompose a portfolio's active return vs a benchmark into allocation (sector bets), selection
 * (security picks), and interaction — an exact decomposition (the three sum to the active return). See
 * `docs/specs/attribution.md`.
 */
export function brinsonAttribution(
  segments: BrinsonSegment[],
  options: BrinsonAttributionOptions = {},
): BrinsonAttribution {
  const functionName = 'brinsonAttribution';
  requireArgumentArray(functionName, 'segments', segments as unknown);
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`metod` running Brinson–Fachler by default) must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, ['method']);
  if (segments.length < 1) {
    throw new InputError(`${functionName}: at least one segment is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { segments: segments.length },
    });
  }
  ensureEnumWhenPresent(options.method, 'brinsonAttribution', 'method', [
    'brinson-fachler',
    'brinson-hood-beebower',
  ]);
  const method = options.method ?? 'brinson-fachler';
  if (!BRINSON_METHODS.includes(method)) {
    throw new InputError(
      `${functionName}: method must be one of ${BRINSON_METHODS.join(' | ')}; got ${String(method)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { method },
      },
    );
  }

  let sumWp = 0;
  let sumWb = 0;
  let Rp = 0;
  let Rb = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    requireArgumentObject(functionName, `segments[${i}]`, s);
    ensureFinite(s.portfolioWeight, `segments[${i}].portfolioWeight`, functionName);
    ensureFinite(s.benchmarkWeight, `segments[${i}].benchmarkWeight`, functionName);
    ensureFinite(s.portfolioReturn, `segments[${i}].portfolioReturn`, functionName);
    ensureFinite(s.benchmarkReturn, `segments[${i}].benchmarkReturn`, functionName);
    sumWp += s.portfolioWeight;
    sumWb += s.benchmarkWeight;
    Rp += s.portfolioWeight * s.portfolioReturn;
    Rb += s.benchmarkWeight * s.benchmarkReturn;
  }

  let allocation = 0;
  let selection = 0;
  let interaction = 0;
  const segEffects: SegmentEffect[] = segments.map((s) => {
    const dW = s.portfolioWeight - s.benchmarkWeight;
    const alloc =
      method === 'brinson-fachler' ? dW * (s.benchmarkReturn - Rb) : dW * s.benchmarkReturn;
    const sel = s.benchmarkWeight * (s.portfolioReturn - s.benchmarkReturn);
    const inter = dW * (s.portfolioReturn - s.benchmarkReturn);
    allocation += alloc;
    selection += sel;
    interaction += inter;
    return {
      name: s.name,
      allocation: alloc,
      selection: sel,
      interaction: inter,
      total: alloc + sel + inter,
    };
  });

  // The three effects reconcile to the active return exactly for Brinson–Hood–Beebower always, and for
  // Brinson–Fachler iff Σwᵖ = Σwᵇ. Detect any residual directly and disclose it — never claim a
  // reconciliation that doesn't hold. (BF's residual is Rb·(Σwᵖ − Σwᵇ), zero at equal/unit weights.)
  const warnings: QuantWarning[] = [];
  const active = Rp - Rb;
  const residual = active - (allocation + selection + interaction);
  if (Math.abs(residual) > 1e-9 * (1 + Math.abs(active))) {
    warnings.push(
      warning(
        WarningCode.RiskBrinsonWeights,
        `${functionName}: the Brinson–Fachler effects do not reconcile to the active return — a residual of ${residual.toExponential(3)} remains because the segment weights are unequal/non-unit (portfolio ${sumWp.toFixed(4)}, benchmark ${sumWb.toFixed(4)}). Normalize the weights (a fully-invested book) or use method: 'brinson-hood-beebower', which reconciles for any weights.`,
        'warn',
      ),
    );
  }

  return {
    portfolioReturn: Rp,
    benchmarkReturn: Rb,
    activeReturn: Rp - Rb,
    allocation,
    selection,
    interaction,
    segments: segEffects,
    method,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method },
    diagnostics: { engine: 'brinson-attribution', method, converged: true, warnings },
  };
}

// ───────────────────────── multi-period linking (Cariño) ─────────────────────────

const LINK_METHODS = ['carino'] as const;
type LinkMethod = (typeof LINK_METHODS)[number];

/** One period's returns and Brinson effects, to be linked across time. */
export interface AttributionPeriod {
  portfolioReturn: number;
  benchmarkReturn: number;
  allocation: number;
  selection: number;
  interaction: number;
  /** Optional per-segment effects (as from `brinsonAttribution().segments`) to link segment-by-segment. */
  segments?: SegmentEffect[];
  /** Optional period label, echoed onto its linking coefficient. */
  label?: string;
}

/** Options for {@link linkAttribution}. */
export interface LinkAttributionOptions {
  /** Linking method; default (and currently only) `'carino'`. */
  method?: LinkMethod;
}

/** A per-period Cariño linking coefficient `βₜ`. */
export interface LinkingCoefficient {
  label?: string;
  coefficient: number;
}

/** The multi-period-linked attribution. */
export interface LinkedAttribution {
  /** Compounded portfolio return `∏(1+Pₜ) − 1`. */
  portfolioReturn: number;
  /** Compounded benchmark return `∏(1+Bₜ) − 1`. */
  benchmarkReturn: number;
  /** `portfolioReturn − benchmarkReturn` (the geometric active return). */
  activeReturn: number;
  /** Linked cumulative effects — `allocation + selection + interaction = activeReturn`, exact. */
  allocation: number;
  selection: number;
  interaction: number;
  /** The per-period linking coefficient `βₜ` (with the period `label` when supplied). */
  linkingCoefficients: LinkingCoefficient[];
  /** Linked per-segment effects — present only when every period supplied segments. */
  segments?: SegmentEffect[];
  method: LinkMethod;
  assumptions: { conventionsVersion: string; method: LinkMethod; periods: number };
  diagnostics: Diagnostics;
}

/** Cariño scaling `(ln(1+P) − ln(1+B))/(P − B)`, with the L'Hôpital limit `1/(1+P)` when `P == B`. */
function carinoScale(p: number, b: number): number {
  return Math.abs(p - b) > 1e-12 ? (Math.log(1 + p) - Math.log(1 + b)) / (p - b) : 1 / (1 + p);
}

/**
 * Link single-period Brinson attributions across time with **Cariño's** logarithmic coefficients, so the
 * cumulative allocation / selection / interaction sum **exactly** to the compounded (geometric) active
 * return — the property the naive arithmetic sum lacks. Each period's effects are scaled by `βₜ = kₜ/k`;
 * per-segment effects are linked with the same `βₜ`. See `docs/specs/attribution-linking.md`.
 */
export function linkAttribution(
  periods: AttributionPeriod[],
  options: LinkAttributionOptions = {},
): LinkedAttribution {
  const functionName = 'linkAttribution';
  requireArgumentArray(functionName, 'periods', periods as unknown);
  if (periods.length === 0) {
    throw new InputError(`${functionName}: periods must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { periods: 0 },
    });
  }
  requireArgumentObject(functionName, 'options', options);
  // Law 12: an unknown option must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, ['method']);
  ensureEnumWhenPresent(options.method, 'linkAttribution', 'method', LINK_METHODS);
  const method = options.method ?? 'carino';
  ensureEnum(method, LINK_METHODS, 'options.method', functionName);
  periods.forEach((p, t) => {
    requireArgumentObject(functionName, `periods[${t}]`, p);
    ensureFinite(p.portfolioReturn, `periods[${t}].portfolioReturn`, functionName);
    ensureFinite(p.benchmarkReturn, `periods[${t}].benchmarkReturn`, functionName);
    ensureFinite(p.allocation, `periods[${t}].allocation`, functionName);
    ensureFinite(p.selection, `periods[${t}].selection`, functionName);
    ensureFinite(p.interaction, `periods[${t}].interaction`, functionName);
    if (!(p.portfolioReturn > -1)) {
      throw new InputError(
        `${functionName}: periods[${t}].portfolioReturn must be > -1 (a return cannot fall below -100%); got ${p.portfolioReturn}.`,
        { code: ErrorCode.InputOutOfRange, context: { periodIndex: t, value: p.portfolioReturn } },
      );
    }
    if (!(p.benchmarkReturn > -1)) {
      throw new InputError(
        `${functionName}: periods[${t}].benchmarkReturn must be > -1 (a return cannot fall below -100%); got ${p.benchmarkReturn}.`,
        { code: ErrorCode.InputOutOfRange, context: { periodIndex: t, value: p.benchmarkReturn } },
      );
    }
  });

  const portfolioReturn = periods.reduce((acc, p) => acc * (1 + p.portfolioReturn), 1) - 1;
  const benchmarkReturn = periods.reduce((acc, p) => acc * (1 + p.benchmarkReturn), 1) - 1;
  const k = carinoScale(portfolioReturn, benchmarkReturn);
  const betas = periods.map((p) => carinoScale(p.portfolioReturn, p.benchmarkReturn) / k);

  const allocation = periods.reduce((s, p, t) => s + betas[t]! * p.allocation, 0);
  const selection = periods.reduce((s, p, t) => s + betas[t]! * p.selection, 0);
  const interaction = periods.reduce((s, p, t) => s + betas[t]! * p.interaction, 0);
  const linkingCoefficients: LinkingCoefficient[] = periods.map((p, t) =>
    p.label !== undefined ? { label: p.label, coefficient: betas[t]! } : { coefficient: betas[t]! },
  );

  const result: LinkedAttribution = {
    portfolioReturn,
    benchmarkReturn,
    activeReturn: portfolioReturn - benchmarkReturn,
    allocation,
    selection,
    interaction,
    linkingCoefficients,
    method,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method, periods: periods.length },
    diagnostics: { engine: 'attribution-linking', method, converged: true, warnings: [] },
  };

  // Per-segment linking — only when EVERY period supplies (non-empty) segments, so the breakdown still
  // sums to the cumulative effects (a period without segments would silently drop from the breakdown).
  if (periods.every((p) => Array.isArray(p.segments) && p.segments.length > 0)) {
    const byName = new Map<string, SegmentEffect>();
    const order: string[] = [];
    periods.forEach((p, t) => {
      for (const seg of p.segments!) {
        requireArgumentObject(functionName, `periods[${t}].segments[]`, seg);
        ensureFinite(seg.allocation, `periods[${t}].segments[].allocation`, functionName);
        ensureFinite(seg.selection, `periods[${t}].segments[].selection`, functionName);
        ensureFinite(seg.interaction, `periods[${t}].segments[].interaction`, functionName);
        let cur = byName.get(seg.name);
        if (!cur) {
          cur = { name: seg.name, allocation: 0, selection: 0, interaction: 0, total: 0 };
          byName.set(seg.name, cur);
          order.push(seg.name);
        }
        cur.allocation += betas[t]! * seg.allocation;
        cur.selection += betas[t]! * seg.selection;
        cur.interaction += betas[t]! * seg.interaction;
      }
    });
    result.segments = order.map((name) => {
      const s = byName.get(name)!;
      s.total = s.allocation + s.selection + s.interaction;
      return s;
    });
  }

  return result;
}
