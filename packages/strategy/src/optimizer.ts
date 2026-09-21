/**
 * Strategy optimizer (spec §12, roadmap Tier 3) — invert the profit calculator: given a **thesis**
 * (where the trader thinks the underlying lands, by when, and how sure), search structures × strikes ×
 * **expiries** and rank by expected P&L **under that thesis**, not the market's risk-neutral
 * distribution.
 *
 * A thin generalization of `scanStrategies`: for each expiry it reuses the scanner to enumerate + filter
 * + risk-metric the candidates (with materializable legs), then re-scores each candidate's expected P&L
 * and probability-of-profit by integrating `Position.pnlAtExpiry` against the trader's thesis density.
 * No second pricing path. See `docs/specs/strategy-optimizer.md`.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  optionExpiryToMs,
  requireArgumentArray,
  requireArgumentObject,
  resolveValuationAsOf,
  warning,
  yearFraction,
  WarningCode,
} from '@totalfinance/core';
import {
  kellyBet,
  optionsMargin,
  type EdgeOutcome,
  type KellyBetInput,
  type KellySizing,
  type OptionsMarginResult,
} from '@totalfinance/risk/sizing';
import { Position } from './position.js';
import {
  type ScanCandidate,
  SCAN_OBJECTIVES,
  type ScanObjective,
  type ScanQuoteRow,
  type ScanStructure,
  scanStrategies,
} from './scanner.js';
import {
  customPriceGrid,
  lognormalPriceGrid,
  priceGridDistribution,
  scoreOutcomes,
  type TerminalPriceLaw,
  type ThesisOutcomeNode,
} from './thesis-distribution.js';
import type { Leg } from './types.js';

/** The trader's view of the terminal price — a lognormal centered at a target (or drift). */
export interface OptimizerThesis {
  /** Median terminal price (the central view). If omitted, the median is `spot·e^{drift·t}`. */
  targetPrice?: number;
  /** Annualized volatility capturing the trader's UNCERTAINTY (σ_log at expiry = `volatility·√t`). Required, > 0. */
  volatility: number;
  /** Annualized drift used when `targetPrice` is omitted (default 0 — a flat view). */
  drift?: number;
  /** Escape hatch: an arbitrary terminal density `p(price, t)` (replaces the lognormal shape). */
  pdf?: (price: number, timeToExpiryYears: number) => number;
  /**
   * Required with `pdf`: the price range `{ from, to }` covering the density's support. The custom
   * density is integrated over exactly this range (not the `volatility` window), so its mass is never
   * silently truncated. Ignored for the lognormal thesis.
   */
  pdfRange?: { from: number; to: number };
}

/** One expiry in the search space: its chain (+ optional pricing `volatility`/`smile`). */
export interface OptimizerExpiry {
  expiry: string;
  chain: ScanQuoteRow[];
  /** Pricing volatility for this expiry (falls back to `options.volatility`). */
  volatility?: number;
  /** Pricing smile for this expiry (falls back to `options.smile`). */
  smile?: (strike: number) => number;
}

/** Ranking objective: a thesis-based one, or the scanner's market-implied ones. */
export type OptimizerObjective =
  | 'thesisExpectedValuePerRisk'
  | 'thesisExpectedValuePerCapital'
  | 'thesisExpectedValue'
  | 'thesisProbabilityOfProfit'
  | ScanObjective;

/**
 * Opt-in Kelly sizing for the optimizer: every {@link kellyBet} knob except `edge` (which the optimizer
 * builds from each candidate's thesis outcomes), plus a required `enabled: true` so sizing is a
 * deliberate request, never an accidental default. Omitting `sizing` performs no Kelly work at all.
 */
export type OptimizerSizingOptions = Omit<KellyBetInput, 'edge'> & { enabled: true };

/**
 * The Kelly verdict for a candidate (present only when `sizing` was requested): a full {@link KellySizing}
 * on dimensionless (P&L ÷ capital) returns, or a structured `not-admissible` refusal — an unbounded
 * downside under the thesis support (any positive bankroll fraction can cross zero wealth) or a zero
 * capital requirement (the return is undefined).
 */
export type OptimizedStrategyKelly =
  | { status: 'sized'; sizing: KellySizing }
  | { status: 'not-admissible'; reason: 'unbounded-downside' | 'zero-capital' };

/** Options for {@link optimizeStrategy}. */
export interface OptimizeStrategyOptions {
  spot: number;
  /**
   * Valuation instant — epoch milliseconds or a zoned ISO datetime, the ONE valuation-instant
   * grammar shared with `scanStrategies`, `Position.probability()` and the what-if cube. A bare
   * date is refused everywhere a position is priced: the time of day is the answer for a 0DTE.
   */
  asOf: EpochMs | string;
  riskFreeRate: number;
  dividendYield?: number;
  /** The multi-expiry search space (≥ 1 expiry). */
  expiries: OptimizerExpiry[];
  thesis: OptimizerThesis;
  /** Default pricing volatility for missing premiums + the scanner's market-implied metrics. */
  volatility?: number;
  /** Default pricing smile (takes precedence over `volatility` for pricing). */
  smile?: (strike: number) => number;
  /** Which structures to enumerate (default: all the scanner's). */
  structures?: ScanStructure[];
  maxWidth?: number;
  /** Keep only candidates whose MARKET-implied PoP ≥ this. */
  minProbabilityOfProfit?: number;
  /** Keep only candidates whose max loss ≤ this (per contract, 100×). */
  maxRisk?: number;
  /** Keep only candidates whose THESIS PoP ≥ this. */
  minThesisProbabilityOfProfit?: number;
  /** Ranking objective (default `'thesisExpectedValuePerRisk'`). */
  objective?: OptimizerObjective;
  /** Top-N across all expiries (default 25). */
  top?: number;
  /** Integration resolution for the thesis metrics (default 801). */
  gridPoints?: number;
  /** Opt-in Kelly sizing. When set, each candidate gains a `kelly` verdict; omit for no Kelly work. */
  sizing?: OptimizerSizingOptions;
}

/**
 * The capital (buying-power) a candidate ties up, from Reg-T options margin — an economically honest
 * denominator that is DISTINCT from `|maxLoss|`: a naked short has unbounded max loss yet a finite
 * Reg-T requirement, so it can still be ranked by capital efficiency. This is a static entry
 * buying-power model, not a liquidation or future house-margin model (echoed in `assumptions`).
 */
export interface OptimizedStrategyCapital {
  /** Buying-power reduction the account must set aside (per contract, 100×). */
  requirement: number;
  /** How the requirement was derived. */
  method: OptionsMarginResult['method'];
  /** Worst-case expiration loss per contract; `null` when the loss is unbounded (Law 7). */
  maxLoss: number | null;
  /** The Reg-T / conventions assumptions echoed by `optionsMargin`. */
  assumptions: OptionsMarginResult['assumptions'];
  /** The `optionsMargin` diagnostics (e.g. the `risk.unbounded_loss` warning behind a `null` maxLoss). */
  diagnostics: OptionsMarginResult['diagnostics'];
}

/** A scanned candidate re-scored under the trader's thesis. */
export interface OptimizedStrategy extends ScanCandidate {
  expiry: string;
  /** Year fraction to this expiry. */
  timeToExpiryYears: number;
  /** Expected P&L under the thesis (per contract, 100×). */
  thesisExpectedValue: number;
  /** Probability of profit under the thesis. */
  thesisProbabilityOfProfit: number;
  /** `thesisEv / |maxLoss|` (0 when risk is unbounded) — the defined-risk read; never falls back to margin. */
  thesisExpectedValuePerRisk: number;
  /** The candidate's Reg-T buying-power requirement (the honest capital denominator). */
  capital: OptimizedStrategyCapital;
  /** `thesisEv / capital.requirement`; `null` (never `Infinity`) when the requirement is zero. */
  thesisExpectedValuePerCapital: number | null;
  /** Kelly sizing verdict — present only when `sizing` was requested (2B never populates it). */
  kelly?: OptimizedStrategyKelly;
}

/** The optimizer read-out. */
export interface OptimizeStrategyResult {
  /** Top-N candidates across all expiries, ranked by `objective` (descending). */
  candidates: OptimizedStrategy[];
  thesis: { median: 'target' | 'drift'; volatility: number; targetPrice?: number; drift?: number };
  assumptions: {
    conventionsVersion: string;
    objective: OptimizerObjective;
    expiries: number;
    gridPoints: number;
  };
  diagnostics: Diagnostics;
}

const THESIS_OBJECTIVES = [
  'thesisExpectedValuePerRisk',
  'thesisExpectedValuePerCapital',
  'thesisExpectedValue',
  'thesisProbabilityOfProfit',
] as const;
// RV11 — imported, not re-declared. Two hand-kept copies of the same vocabulary is how the error
// message drifted away from the values it was describing.

/** {@link OptimizeStrategyOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const OPTIMIZE_STRATEGY_OPTIONS_KEYS = [
  'spot',
  'asOf',
  'riskFreeRate',
  'dividendYield',
  'expiries',
  'thesis',
  'volatility',
  'smile',
  'structures',
  'maxWidth',
  'minProbabilityOfProfit',
  'maxRisk',
  'minThesisProbabilityOfProfit',
  'objective',
  'top',
  'gridPoints',
  'sizing',
] as const;

/**
 * {@link OptimizerSizingOptions} keys (Law 12) — EXACTLY `kellyBet`'s knobs plus `enabled`.
 *
 * The horizon knob was dead in both spellings: this list allowed `horizon` (a name `kellyBet` has
 * never had, so it was accepted and then dropped), while the real field `horizonPeriods` was
 * REJECTED as unknown. Either way no growth projection was ever produced. The list now mirrors
 * `KellyBetInput` exactly.
 */
const OPTIMIZER_SIZING_OPTIONS_KEYS = [
  'enabled',
  'fraction',
  'drawdownLimit',
  'maxFraction',
  'horizonPeriods',
] as const;

/** {@link OptimizerThesis} keys (Law 12). */
const OPTIMIZER_THESIS_KEYS = ['targetPrice', 'volatility', 'drift', 'pdf', 'pdfRange'] as const;

/** {@link OptimizerExpiry} keys (Law 12). */
const OPTIMIZER_EXPIRY_KEYS = ['expiry', 'chain', 'volatility', 'smile'] as const;

/**
 * Expected P&L and probability-of-profit of a position under the thesis distribution — via the shared
 * {@link priceGridDistribution} probability-mass path (Wave 6 §2B), so the same quadrature the what-if
 * cube uses backs the optimizer. The lognormal thesis resolves a log-uniform grid over ±6σ and assigns
 * each price its exact CDF bin mass; a custom `pdf` uses normalized trapezoidal quadrature over its
 * explicit `pdfRange`, so its (possibly multi-modal) mass is never truncated by a σ-derived window.
 */
function thesisMetrics(input: {
  position: Position;
  thesis: OptimizerThesis;
  spot: number;
  timeToExpiryYears: number;
  gridPoints: number;
}): { ev: number; pop: number; nodes: ThesisOutcomeNode[] } {
  const { position, thesis, spot, timeToExpiryYears: t, gridPoints: n } = input;
  let law: TerminalPriceLaw;
  let prices: number[];
  if (thesis.pdf) {
    // Custom density over its explicit support (validated in optimizeStrategy).
    const { from, to } = thesis.pdfRange!;
    law = { kind: 'custom', density: thesis.pdf, from, to, yearsForward: t };
    prices = customPriceGrid({ from, to, gridPoints: n });
  } else {
    const sigma = thesis.volatility * Math.sqrt(t);
    const muLog = Math.log(thesis.targetPrice ?? spot * Math.exp((thesis.drift ?? 0) * t));
    law = { kind: 'lognormal', muLog, sigma };
    prices = lognormalPriceGrid(law, n);
  }
  const distribution = priceGridDistribution({ prices, law });
  const { ev, pop, nodes } = scoreOutcomes(distribution, (S) => position.pnlAtExpiry(S));
  return { ev, pop, nodes };
}

/**
 * Whether a candidate's expiration loss is unbounded *under the thesis support* — the admissibility
 * test for Kelly (Wave 6 §2C). Determined from the payoff's asymptotic slope, NOT sampled grid nodes:
 * `optionsMargin` reports `maxLoss: null` exactly when the net-call slope makes the up-tail unbounded
 * as `S → ∞`. A lognormal thesis has support `(0, ∞)`, so that up-tail is reachable ⇒ unbounded. A
 * custom density's finite `[from, to]` support caps the realized loss ⇒ bounded, even for a net-short
 * call. (The down side is always bounded — `S ≥ 0`.)
 */
export function isUnboundedDownsideUnderSupport(
  capital: OptimizedStrategyCapital,
  thesis: OptimizerThesis,
): boolean {
  if (capital.maxLoss !== null) return false; // a finite worst case ⇒ bounded ⇒ admissible
  return thesis.pdf === undefined; // unbounded up-tail is only reachable under unbounded (lognormal) support
}

/**
 * The Kelly verdict for one candidate (Wave 6 §2C). Refuses an unbounded-downside-under-support or
 * zero-capital position with a structured `not-admissible`; otherwise sizes on DIMENSIONLESS returns
 * (`payoff = node.pnl / capital.requirement` — absolute dollars are never passed to `kellyBet`) and
 * returns the full {@link KellySizing}, every requested cap preserved.
 */
export function resolveCandidateKelly(input: {
  nodes: readonly ThesisOutcomeNode[];
  capital: OptimizedStrategyCapital;
  thesis: OptimizerThesis;
  sizing: OptimizerSizingOptions;
}): OptimizedStrategyKelly {
  const { nodes, capital, thesis, sizing } = input;
  if (!(capital.requirement > 0)) return { status: 'not-admissible', reason: 'zero-capital' };
  if (isUnboundedDownsideUnderSupport(capital, thesis)) {
    return { status: 'not-admissible', reason: 'unbounded-downside' };
  }
  const outcomes: EdgeOutcome[] = nodes.map((nd) => ({
    probability: nd.probability,
    payoff: nd.pnl / capital.requirement,
  }));
  // Forward every kellyBet knob except `enabled` (the opt-in flag) and `edge` (built above).
  const kellyInput: KellyBetInput = {
    edge: { outcomes },
    ...(sizing.fraction !== undefined ? { fraction: sizing.fraction } : {}),
    ...(sizing.drawdownLimit !== undefined ? { drawdownLimit: sizing.drawdownLimit } : {}),
    ...(sizing.maxFraction !== undefined ? { maxFraction: sizing.maxFraction } : {}),
    // Forwarded under kellyBet's OWN field name — the old `horizon:` spelling is not a KellyBetInput
    // key, so even a caller who got past the allowlist never reached the growth projection.
    ...(sizing.horizonPeriods !== undefined ? { horizonPeriods: sizing.horizonPeriods } : {}),
  };
  return { status: 'sized', sizing: kellyBet(kellyInput) };
}

/**
 * The Reg-T buying-power requirement for a candidate's option legs — the honest capital denominator.
 * A candidate with no option legs (there are none among the scanner's structures) has no margin
 * surface and reports a zero requirement. Uses the position multiplier the optimizer marks with (100).
 */
function candidateCapital(legs: readonly Leg[], spot: number): OptimizedStrategyCapital {
  const optionLegs = legs
    .filter((l): l is Extract<Leg, { kind: 'call' | 'put' }> => l.kind !== 'stock')
    .map((l) => ({ type: l.kind, quantity: l.quantity, strike: l.strike, premium: l.premium }));
  if (optionLegs.length === 0) {
    return {
      requirement: 0,
      method: 'long-premium',
      maxLoss: 0,
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: { warnings: [] },
    };
  }
  const m = optionsMargin(optionLegs, { spot, multiplier: 100 });
  return {
    requirement: m.buyingPowerReduction,
    method: m.method,
    maxLoss: m.maxLoss,
    assumptions: m.assumptions,
    diagnostics: m.diagnostics,
  };
}

/** Sort key that puts finite scores in order and an undefined (`null`) or NaN score at the bottom. */
function rankKey(score: number | null): number {
  return score !== null && Number.isFinite(score) ? score : -Infinity;
}

/**
 * Search structures × strikes × expiries for the best trade under a thesis. Reuses `scanStrategies` per
 * expiry, re-scores each candidate under the thesis density, and ranks across all expiries. See the spec.
 */
export function optimizeStrategy(options: OptimizeStrategyOptions): OptimizeStrategyResult {
  const functionName = 'optimizeStrategy';
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`minThesispop`) must teach, never silently drop the filter.
  ensureKnownKeys(functionName, 'options', options, OPTIMIZE_STRATEGY_OPTIONS_KEYS);
  for (const field of [
    'dividendYield',
    'gridPoints',
    'minProbabilityOfProfit',
    'minThesisProbabilityOfProfit',
    'top',
  ] as const) {
    ensureFiniteWhenPresent(
      (options as unknown as Record<string, unknown>)[field],
      field,
      functionName,
    );
  }
  if (
    options.objective !== undefined &&
    !(THESIS_OBJECTIVES as readonly string[]).includes(options.objective as string)
  ) {
    throw new InputError(
      `${functionName}: objective must be one of ${THESIS_OBJECTIVES.join(' | ')} when provided. Received ${options.objective === null ? 'null' : JSON.stringify(options.objective)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { field: 'objective', received: options.objective },
      },
    );
  }
  if (options.structures !== undefined && !Array.isArray(options.structures)) {
    throw new InputError(
      `${functionName}: structures must be an array of structure names when provided. Received ${options.structures === null ? 'null' : typeof options.structures}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'structures' } },
    );
  }
  if (
    options.smile !== undefined &&
    (options.smile === null ||
      (typeof options.smile !== 'object' && typeof options.smile !== 'function'))
  ) {
    throw new InputError(
      `${functionName}: smile must be a volatility smile (per-strike function or object) when provided. Received ${options.smile === null ? 'null' : typeof options.smile}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'smile' } },
    );
  }
  ensurePositive(options.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  // Resolve through the shared valuation-instant door first (the same one the scanner this
  // function delegates to uses), then require the resolved instant to be finite.
  const asOfMs = resolveValuationAsOf(options.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  requireArgumentArray(functionName, 'expiries', options.expiries);
  if (options.expiries.length === 0) {
    throw new InputError(`${functionName}: expiries must have at least one entry.`, {
      code: ErrorCode.InputOutOfRange,
      context: { expiries: 0 },
    });
  }
  requireArgumentObject(functionName, 'thesis', options.thesis);
  ensureKnownKeys(functionName, 'thesis', options.thesis, OPTIMIZER_THESIS_KEYS);
  for (const field of ['targetPrice', 'drift'] as const) {
    ensureFiniteWhenPresent(
      (options.thesis as unknown as Record<string, unknown>)[field],
      `thesis.${field}`,
      functionName,
    );
  }
  if (options.thesis.pdf !== undefined && typeof options.thesis.pdf !== 'function') {
    throw new InputError(
      `${functionName}: thesis.pdf must be a probability-density function when provided. Received ${options.thesis.pdf === null ? 'null' : typeof options.thesis.pdf}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'thesis.pdf' } },
    );
  }
  if (
    options.thesis.pdfRange !== undefined &&
    (options.thesis.pdfRange === null ||
      typeof options.thesis.pdfRange !== 'object' ||
      Array.isArray(options.thesis.pdfRange))
  ) {
    throw new InputError(
      `${functionName}: thesis.pdfRange must be a { from, to } object when provided. Received ${options.thesis.pdfRange === null ? 'null' : Array.isArray(options.thesis.pdfRange) ? 'an array' : typeof options.thesis.pdfRange}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'thesis.pdfRange' } },
    );
  }
  ensurePositive(
    options.thesis.volatility,
    'thesis.volatility',
    functionName,
    ErrorCode.InputNegativeVolatility,
  );
  if (options.thesis.targetPrice !== undefined) {
    ensurePositive(options.thesis.targetPrice, 'thesis.targetPrice', functionName);
  }
  if (options.thesis.pdf !== undefined) {
    // A custom density's support is unknown, so it MUST supply an explicit integration range —
    // otherwise its mass outside a σ-derived window would be silently truncated (wrong-sign EV).
    const randomNumberGenerator = options.thesis.pdfRange as
      | { from?: unknown; to?: unknown }
      | undefined;
    if (
      randomNumberGenerator === undefined ||
      typeof randomNumberGenerator !== 'object' ||
      typeof randomNumberGenerator.from !== 'number' ||
      typeof randomNumberGenerator.to !== 'number' ||
      // Must be FINITE: an Infinite `to` passes `to > from` but makes `dS = ∞` → all-NaN samples → a
      // silent thesisEv = 0 (the very failure this range guard exists to prevent).
      !Number.isFinite(randomNumberGenerator.from) ||
      !Number.isFinite(randomNumberGenerator.to) ||
      !(randomNumberGenerator.from > 0) ||
      !(randomNumberGenerator.to > randomNumberGenerator.from)
    ) {
      throw new InputError(
        `${functionName}: a custom thesis.pdf requires thesis.pdfRange { from, to } with 0 < from < to (finite) covering its support.`,
        { code: ErrorCode.InputMissingField, context: { field: 'thesis.pdfRange' } },
      );
    }
  }
  const objective = options.objective ?? 'thesisExpectedValuePerRisk';
  if (
    !(THESIS_OBJECTIVES as readonly string[]).includes(objective) &&
    !(SCAN_OBJECTIVES as readonly string[]).includes(objective)
  ) {
    throw new InputError(
      `${functionName}: objective must be one of ${[...THESIS_OBJECTIVES, ...SCAN_OBJECTIVES].join(
        ', ',
      )}; got "${objective}".`,
      { code: ErrorCode.InputInvalidEnum, context: { objective } },
    );
  }
  const top = options.top ?? 25;
  // Safe integer (2026-08-23 review, P0): `top` only ranks and slices — no loop or allocation runs
  // off it — but above 2^53 it is no longer an exact count.
  if (!Number.isSafeInteger(top) || top < 1) {
    throw new InputError(`${functionName}: top must be a positive integer, got ${top}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { top },
    });
  }
  const gridPoints = options.gridPoints ?? 801;
  // Safe integer AND a work cap (2026-08-23 review, P0 "unbounded work"): `Number.isInteger(1e308)`
  // is `true`, so the old check admitted a quadrature grid the thesis-EV integral evaluates for
  // EVERY scanned candidate (hundreds per expiry) — 100,000 points × hundreds of candidates is
  // already seconds, and the trapezoid EV integral has long converged at the 801-point default.
  if (!Number.isSafeInteger(gridPoints) || gridPoints < 11 || gridPoints > 100_000) {
    throw new InputError(
      `${functionName}: gridPoints must be an integer in [11, 100,000] — every scanned candidate evaluates its payoff and the thesis density at each grid point, and the EV quadrature is long converged at the 801-point default. Received ${gridPoints}.\n  e.g. { gridPoints: 801 }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { gridPoints, max: 100_000 },
      },
    );
  }
  if (
    options.minThesisProbabilityOfProfit !== undefined &&
    !(options.minThesisProbabilityOfProfit >= 0 && options.minThesisProbabilityOfProfit <= 1)
  ) {
    throw new InputError(
      `${functionName}: minThesisProbabilityOfProfit must be within [0, 1], got ${options.minThesisProbabilityOfProfit}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { minThesisProbabilityOfProfit: options.minThesisProbabilityOfProfit },
      },
    );
  }
  const sizing = options.sizing;
  if (sizing !== undefined) {
    requireArgumentObject(functionName, 'sizing', sizing);
    ensureKnownKeys(functionName, 'sizing', sizing, OPTIMIZER_SIZING_OPTIONS_KEYS);
    // `enabled: true` is a deliberate opt-in; a falsy value would silently do Kelly work or none.
    if (sizing.enabled !== true) {
      throw new InputError(
        `${functionName}: sizing.enabled must be true to request Kelly sizing (omit sizing entirely for none).`,
        { code: ErrorCode.InputInvalidEnum, context: { enabled: sizing.enabled } },
      );
    }
    // The fraction / drawdownLimit / maxFraction / horizonPeriods knobs are validated by kellyBet.
  }

  const all: OptimizedStrategy[] = [];
  const warnings: QuantWarning[] = [];
  for (let e = 0; e < options.expiries.length; e++) {
    const ex = options.expiries[e]!;
    requireArgumentObject(functionName, `expiries[${e}]`, ex);
    ensureKnownKeys(functionName, `expiries[${e}]`, ex, OPTIMIZER_EXPIRY_KEYS);
    const t = yearFraction(asOfMs, optionExpiryToMs(ex.expiry), 'ACT/365F');
    ensurePositive(t, `expiries[${e}].timeToExpiryYears`, functionName);
    const pvol = ex.volatility ?? options.volatility;
    const psmile = ex.smile ?? options.smile;
    // Enumerate every candidate at this expiry (top: all — we re-rank across expiries under the thesis).
    const { candidates: scanned } = scanStrategies({
      spot: options.spot,
      asOf: asOfMs,
      riskFreeRate: options.riskFreeRate,
      ...(options.dividendYield !== undefined ? { dividendYield: options.dividendYield } : {}),
      expiry: ex.expiry,
      chain: ex.chain,
      ...(pvol !== undefined ? { volatility: pvol } : {}),
      ...(psmile !== undefined ? { smile: psmile } : {}),
      ...(options.structures !== undefined ? { structures: options.structures } : {}),
      ...(options.maxWidth !== undefined ? { maxWidth: options.maxWidth } : {}),
      ...(options.minProbabilityOfProfit !== undefined
        ? { minProbabilityOfProfit: options.minProbabilityOfProfit }
        : {}),
      ...(options.maxRisk !== undefined ? { maxRisk: options.maxRisk } : {}),
      top: 1_000_000,
    });
    for (const c of scanned) {
      const position = new Position(c.legs);
      const { ev, pop, nodes } = thesisMetrics({
        position,
        thesis: options.thesis,
        spot: options.spot,
        timeToExpiryYears: t,
        gridPoints,
      });
      if (
        options.minThesisProbabilityOfProfit !== undefined &&
        pop < options.minThesisProbabilityOfProfit
      )
        continue;
      const risk = c.maxLoss === null ? null : Math.abs(c.maxLoss);
      const thesisExpectedValuePerRisk = risk !== null && risk > 0 ? ev / risk : 0;
      const capital = candidateCapital(c.legs, options.spot);
      // A zero requirement makes the ratio undefined — report `null` (never Infinity, Law 7) and
      // disclose it, so the capital objective ranks it last instead of at the top.
      const thesisExpectedValuePerCapital =
        capital.requirement > 0 ? ev / capital.requirement : null;
      if (thesisExpectedValuePerCapital === null) {
        warnings.push(
          warning(
            WarningCode.StrategyOptimizerZeroCapital,
            `${functionName}: candidate "${c.structure}" has a zero capital requirement; thesisExpectedValuePerCapital is null and it ranks last for the capital objective.`,
            'info',
            { structure: c.structure },
          ),
        );
      }
      // Kelly is opt-in: only compute a verdict when `sizing` was requested (2B populates no `kelly`).
      const kelly = sizing
        ? resolveCandidateKelly({ nodes, capital, thesis: options.thesis, sizing })
        : undefined;
      all.push({
        ...c,
        expiry: ex.expiry,
        timeToExpiryYears: t,
        thesisExpectedValue: ev,
        thesisProbabilityOfProfit: pop,
        thesisExpectedValuePerRisk,
        capital,
        thesisExpectedValuePerCapital,
        ...(kelly !== undefined ? { kelly } : {}),
      });
    }
  }

  const scoreOf = (c: OptimizedStrategy): number | null => {
    switch (objective) {
      case 'thesisExpectedValue':
        return c.thesisExpectedValue;
      case 'thesisProbabilityOfProfit':
        return c.thesisProbabilityOfProfit;
      case 'thesisExpectedValuePerRisk':
        return c.thesisExpectedValuePerRisk;
      case 'thesisExpectedValuePerCapital':
        // A `null` ratio (zero capital) stays null on the candidate and ranks last (`rankKey`).
        return c.thesisExpectedValuePerCapital;
      case 'probabilityOfProfit':
        return c.probabilityOfProfit;
      case 'expectedValue':
        return c.expectedValue;
      case 'returnOnRisk':
        return c.returnOnRisk;
      case 'expectedValuePerRisk':
        return c.expectedValuePerRisk;
      default:
        return c.thesisExpectedValuePerRisk;
    }
  };
  for (const c of all) c.score = scoreOf(c);
  all.sort((a, b) => rankKey(b.score) - rankKey(a.score));

  const usesTarget = options.thesis.targetPrice !== undefined;
  return {
    candidates: all.slice(0, top),
    thesis: {
      median: usesTarget ? 'target' : 'drift',
      volatility: options.thesis.volatility,
      // Echo the field that actually drives the median: targetPrice when set, else the drift (0 default).
      ...(options.thesis.targetPrice !== undefined
        ? { targetPrice: options.thesis.targetPrice }
        : { drift: options.thesis.drift ?? 0 }),
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      objective,
      expiries: options.expiries.length,
      gridPoints,
    },
    diagnostics: {
      engine: 'strategy-optimizer',
      method: 'thesis-scored scan',
      converged: true,
      warnings,
    },
  };
}
