/**
 * Probability & scenario metrics for a position (spec §12.6).
 *
 * The terminal underlying is modelled as lognormal with an explicit, echoed drift — risk-neutral
 * (`r − q`) by default, or a real-world expected return. Probability of profit integrates that density
 * over the strategy's profit regions; expected value uses the closed-form expected option intrinsic;
 * probability of touch is the GBM first-passage probability to each breakeven.
 */

import {
  ensureKnownKeys,
  type Assumptions,
  type Computed,
  type EpochMs,
  ensureEnum,
  requireArgumentObject,
  requireFiniteFields,
  type QuantWarning,
} from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';
import type { MarketSource } from './types.js';

export type ProbabilityMeasure = 'riskNeutral' | 'realWorld';

export interface ProbabilityInput {
  /** Underlying spot price (WS3.2: renamed from `underlyingPrice` for workspace consistency). */
  spot: number;
  /** Snapshot time. Epoch ms, or an ISO date/datetime string parsed at the boundary. */
  asOf: EpochMs | string;
  expiry: string;
  /** Annualized volatility of the terminal lognormal (e.g. the ATM implied vol). */
  volatility: number;
  riskFreeRate: number;
  dividendYield?: number;
  /** Terminal measure: `riskNeutral` (drift `r − q`, default) or `realWorld` (drift `expectedReturn − q`). */
  measure?: ProbabilityMeasure;
  /**
   * Annualized expected return, the drift of the `realWorld` measure.
   *
   * **REQUIRED when `measure: 'realWorld'`, and rejected otherwise.** It used to default to
   * `riskFreeRate`, so `measure: 'realWorld'` with no expected return silently returned the
   * risk-neutral probabilities while `assumptions.probabilityModel.measure` still reported
   * `'realWorld'` — a result whose own echoed assumptions contradicted the number it carried.
   * Choosing the real-world measure IS choosing a drift, so the drift must be stated.
   */
  expectedReturn?: number;
}

export interface TouchProbability {
  /** The breakeven price. */
  price: number;
  /** Probability the underlying touches it at any time before expiry (first passage). */
  probability: number;
}

/** The explicit probability model behind the metrics (echoed, per spec §12.6). */
export interface ProbabilityModel {
  measure: ProbabilityMeasure;
  /** Annualized drift used for the terminal lognormal. */
  drift: number;
  /**
   * Representative annualized volatility. For a lognormal model this is the constant vol; for a
   * local-volatility model it is `σ_loc(spot, t)` at valuation (the path uses the full surface).
   */
  volatility: number;
  /** Diffusion used: `lognormal` (constant vol) or `localVolatility` (smile-consistent Dupire surface). */
  volatilityModel: 'lognormal' | 'localVolatility';
  /** Time to expiry in years. */
  timeToExpiryYears: number;
}

export interface ProbabilityMetrics {
  /** Probability that expiration P&L is positive (sum of profit-region probabilities). */
  probabilityOfProfit: number;
  /** Expected expiration P&L under the model (closed-form expected intrinsic − premium per leg). */
  expectedValue: number;
  /**
   * Reward-to-risk ratio `|maxProfit / maxLoss|`, or `null` when it is undefined — an unbounded
   * profit, an unbounded loss, or a zero maximum loss — with the reason in `diagnostics.warnings`
   * (`strategy.risk_reward_undefined`). Never `Infinity` (B3).
   */
  riskReward: number | null;
  /** Probability of touching each breakeven before expiry. */
  probabilityOfTouch: TouchProbability[];
  /**
   * Applied conventions, where the market fields came from (`assumptions.marketSource`, R5), and
   * the probability model echo (`assumptions.probabilityModel`) — R2: never hoisted to the top
   * level.
   */
  assumptions: Assumptions<{ marketSource: MarketSource; probabilityModel: ProbabilityModel }>;
  /** Structured warnings — the undefined reward-to-risk reason rides here (empty otherwise). */
  diagnostics: { warnings: QuantWarning[] };
}

export interface ProbabilityMonteCarloInput extends Omit<ProbabilityInput, 'volatility'> {
  /**
   * Annualized volatility of the constant-vol lognormal. Required unless {@link localVolatility} is supplied
   * (a local-volatility path ignores it except as the model echo's representative vol).
   */
  volatility?: number;
  /**
   * Optional Dupire local-volatility function `σ_loc(level, t)` (e.g. from
   * `@totalfinance/volatility`'s `surfaceLocalVolatility` or `@totalfinance/options`'s `dupireLocalVolatility`). When provided, the
   * simulation steps under local vol instead of a single lognormal σ, so probability-of-profit,
   * expected P&L, and probability-of-touch all reflect the volatility smile/skew — the smile-aware
   * multi-leg read. The function is evaluated at the price and time reached at each step.
   */
  localVolatility?: (level: number, timeToExpiryYears: number) => number;
  /** Seed for the deterministic PRNG (required — the simulation never reads the system clock). */
  seed: number;
  /** Number of simulated paths (default 50_000). */
  paths?: number;
  /** Monitoring steps per path for the probability-of-touch estimate (default 50). */
  steps?: number;
  /**
   * Optional P&L quantiles to report (each in `(0, 1)`), forming an expiration profit "cone" from the
   * simulated terminal distribution. E.g. `[0.05, 0.5, 0.95]` → 5th/50th/95th-percentile P&L.
   */
  pnlQuantiles?: number[];
}

export interface ProbabilityMonteCarloMetrics {
  /** Monte-Carlo probability of a positive expiration P&L. */
  probabilityOfProfit: number;
  /** Monte-Carlo expected expiration P&L. */
  expectedValue: number;
  /** Standard error of the expected-value estimate. */
  expectedValueStandardError: number;
  /**
   * Probability of touching each breakeven before expiry, estimated from simulated paths with the
   * Brownian-bridge continuous-monitoring correction (discrete sampling alone would under-count).
   */
  probabilityOfTouch: TouchProbability[];
  /** The probability model, echoed. */
  /**
   * Applied conventions, plus where the market fields came from — construction market, call site,
   * or a merge (R5) — as `assumptions.marketSource` (R2: never hoisted to the top level).
   */
  assumptions: Assumptions<{ marketSource: MarketSource; probabilityModel: ProbabilityModel }>;
  /** Number of paths simulated. */
  paths: number;
  /** The PRNG seed, echoed for reproducibility (stochastic-provenance rule, cf. `MonteCarloStatistics.seed`). */
  seed: number;
  /** Requested expiration-P&L quantiles (the profit cone), present only when `pnlQuantiles` was set. */
  pnlQuantiles?: { quantile: number; pnl: number }[];
}

/**
 * The terminal-distribution fields, and what each one means to a caller who got it wrong.
 *
 * These functions all take an EARLY RETURN for degenerate inputs — zero volatility or zero time is
 * the intrinsic-value limit, which is correct and documented. Validation has to run BEFORE those
 * branches, because a MISSING field is not a degenerate value: with `spot` absent, `spot <= strike`
 * is `undefined <= undefined` → false, and the function returned a confident `0` probability. A
 * degenerate input has a right answer; an absent one does not.
 */
const TERMINAL_FIELDS = ['spot', 'strike', 'drift', 'volatility', 'timeToExpiryYears'] as const;
const TOUCH_FIELDS = ['spot', 'barrier', 'drift', 'volatility', 'timeToExpiryYears'] as const;

/**
 * ONE EXAMPLE PER BOUNDARY, not per file.
 *
 * A single file-level example told a caller who omitted `touchProbability`'s `barrier` to write
 * `terminalCdf({ … strike … })` — a different function, without the field they were missing. An
 * example that does not correct the failing call is worse than none: it looks authoritative and
 * sends the reader somewhere else.
 */
const TERMINAL_CDF_EXAMPLE_CALL =
  'terminalCdf({ spot: 100, strike: 105, drift: 0.04, volatility: 0.2, timeToExpiryYears: 0.25 })';

const EXPECTED_INTRINSIC_EXAMPLE_CALL =
  "expectedIntrinsic({ type: 'call', spot: 100, strike: 105, drift: 0.04, volatility: 0.2, " +
  'timeToExpiryYears: 0.25 })';

const TOUCH_PROBABILITY_EXAMPLE_CALL =
  'touchProbability({ spot: 100, barrier: 110, drift: 0.04, volatility: 0.2, ' +
  'timeToExpiryYears: 0.25 })';

const PROBABILITY_HINTS: Record<string, string> = {
  drift: 'annualized; use riskFreeRate - dividendYield for risk-neutral',
  volatility: 'annualized decimal, not 20',
  barrier: 'the level being touched',
  timeToExpiryYears: 'in years',
};

export interface TerminalDistributionInput {
  spot: number;
  strike: number;
  /** Annualized drift. */
  drift: number;
  /** Annualized volatility as a decimal. */
  volatility: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
}

/** P(S_T ≤ strike) under a lognormal terminal distribution. */
export function terminalCdf(input: TerminalDistributionInput): number {
  requireArgumentObject('terminalCdf', 'input', input);
  ensureKnownKeys('terminalCdf', 'input', input, TERMINAL_FIELDS);
  requireFiniteFields('terminalCdf', input, TERMINAL_FIELDS, {
    exampleCall: TERMINAL_CDF_EXAMPLE_CALL,
    hints: PROBABILITY_HINTS,
  });
  const { spot, strike, drift, volatility, timeToExpiryYears } = input;
  if (!(timeToExpiryYears > 0) || !(volatility > 0)) return spot <= strike ? 1 : 0;
  if (!(strike > 0)) return 0;
  const d2 =
    (Math.log(spot / strike) + (drift - 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * Math.sqrt(timeToExpiryYears));
  return normalCdf(-d2);
}

export interface ExpectedIntrinsicInput extends TerminalDistributionInput {
  type: 'call' | 'put';
}

/** Undiscounted expected option intrinsic under the supplied terminal distribution. */
export function expectedIntrinsic(input: ExpectedIntrinsicInput): number {
  requireArgumentObject('expectedIntrinsic', 'input', input);
  // Law 12: a `strkie` typo must teach, never silently price intrinsic against undefined.
  ensureKnownKeys('expectedIntrinsic', 'input', input, ['type', ...TERMINAL_FIELDS]);
  ensureEnum(input.type, ['call', 'put'] as const, 'type', 'expectedIntrinsic');
  requireFiniteFields('expectedIntrinsic', input, TERMINAL_FIELDS, {
    exampleCall: EXPECTED_INTRINSIC_EXAMPLE_CALL,
    hints: PROBABILITY_HINTS,
  });
  const { type, spot, strike, drift, volatility, timeToExpiryYears } = input;
  if (!(timeToExpiryYears > 0) || !(volatility > 0)) {
    return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  const fwd = spot * Math.exp(drift * timeToExpiryYears);
  const d1 =
    (Math.log(spot / strike) + (drift + 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * Math.sqrt(timeToExpiryYears));
  const d2 = d1 - volatility * Math.sqrt(timeToExpiryYears);
  return type === 'call'
    ? fwd * normalCdf(d1) - strike * normalCdf(d2)
    : strike * normalCdf(-d2) - fwd * normalCdf(-d1);
}

export interface TouchProbabilityInput {
  spot: number;
  barrier: number;
  /** Annualized drift. */
  drift: number;
  /** Annualized volatility as a decimal. */
  volatility: number;
  /** Monitoring horizon in years. */
  timeToExpiryYears: number;
}

/** GBM first-passage probability of touching `barrier` before expiry. */
export function touchProbability(input: TouchProbabilityInput): number {
  requireArgumentObject('touchProbability', 'input', input);
  ensureKnownKeys('touchProbability', 'input', input, TOUCH_FIELDS);
  requireFiniteFields('touchProbability', input, TOUCH_FIELDS, {
    exampleCall: TOUCH_PROBABILITY_EXAMPLE_CALL,
    hints: PROBABILITY_HINTS,
  });
  const { spot, barrier, drift, volatility, timeToExpiryYears } = input;
  if (!(timeToExpiryYears > 0) || !(volatility > 0) || !(barrier > 0)) {
    return spot === barrier ? 1 : 0;
  }
  if (barrier === spot) return 1;
  const nu = drift - 0.5 * volatility * volatility;
  const sigT = volatility * Math.sqrt(timeToExpiryYears);
  const a = Math.log(barrier / spot);
  const p =
    barrier > spot
      ? normalCdf((-a + nu * timeToExpiryYears) / sigT) +
        Math.exp((2 * nu * a) / (volatility * volatility)) *
          normalCdf((-a - nu * timeToExpiryYears) / sigT)
      : normalCdf((a - nu * timeToExpiryYears) / sigT) +
        Math.exp((2 * nu * a) / (volatility * volatility)) *
          normalCdf((a + nu * timeToExpiryYears) / sigT);
  return Math.min(1, Math.max(0, p));
}

export interface ScenarioRow {
  underlyingPrice: number;
  /** Additive vol shock applied (decimal). */
  volatilityShock: number;
  /** Calendar days advanced from `asOf`. */
  daysForward: number;
  /** Mark-to-market P&L in this scenario. */
  pnl: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/**
 * Result of `scenarioTable()` — the R2 one-envelope form: `value` is the grid rows, `assumptions`
 * echoes the conventions plus `marketSource` (construction/call/merged, R5), and warnings ride
 * `diagnostics.warnings` (WS3.7). A shocked volatility that lands at or below the 1e-6 floor is
 * clamped rather than priced at a non-positive vol; when that happens the affected cells are
 * flagged in the diagnostics instead of silently returning floor-vol numbers.
 */
export type ScenarioTableResult = Computed<ScenarioRow[], { marketSource: MarketSource }>;
