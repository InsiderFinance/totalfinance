/**
 * `Position` — the options profit calculator core (spec §12.2–§12.5).
 *
 * Expiration payoff, breakevens, and max profit/loss are computed exactly from the piecewise-linear
 * payoff (kinks at strikes, asymptotic slopes for unbounded ends). Mark-to-market and Greeks route
 * through the BSM kernel in `@insiderfinance/totalfinance/options` — no duplicate pricing math.
 */

import {
  ensureFiniteWhenPresent,
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensurePositive,
  ensureKnownKeys,
  optionExpiryToMs,
  resolveValuationAsOf,
  yearFraction,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { mulberry32, normalInverseCdf } from '@totalfinance/math';
import { type ExtendedGreeks } from '@totalfinance/options';
import { blackScholesExtendedGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type {
  ChartInclude,
  Leg,
  LegInput,
  MarketSource,
  MarkToMarketInput,
  MarkToMarketResult,
  OptimalExitPoint,
  PayoffMetrics,
  PayoffResult,
  PositionAssumptions,
  PositionConfig,
  PremiumMarket,
  PremiumSource,
  PremiumVolatilitySource,
  PriceRange,
  VolatilitySource,
  WhatIfCell,
  WhatIfCubeBreakEven,
  WhatIfCubeOptions,
  WhatIfCubeProbability,
  WhatIfCubeResult,
  WhatIfProbabilityModel,
  WhatIfProbabilityOptions,
} from './types.js';
import { POSITION_CONFIG_KEYS } from './types.js';
import { autoPriceRange } from './auto-range.js';
import { priceGridDistribution, type TerminalPriceLaw } from './thesis-distribution.js';
import {
  type ProbabilityInput,
  type ProbabilityMonteCarloInput,
  type ProbabilityMonteCarloMetrics,
  type ProbabilityMetrics,
  type ProbabilityModel,
  type ScenarioRow,
  type ScenarioTableResult,
  type TouchProbability,
  expectedIntrinsic,
  terminalCdf,
  touchProbability,
} from './probability.js';

const EPS = 1e-9;
/** Effective per-leg vol is floored here so a large negative shock can't request a non-positive σ. */
const VOL_FLOOR = 1e-6;

/**
 * The most points one price grid will materialize (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check let a "steps" reach the grid loop as an
 * unfinishable allocation — and every downstream consumer (payoff, chartData, scenarioTable)
 * evaluates the whole multi-leg position at EVERY grid point. 10^6 points is 8 MB of grid and
 * seconds of leg evaluations, ~250× the horizontal resolution of a 4K chart; no payoff diagram
 * needs more.
 */
const MAX_GRID_STEPS = 1_000_000;

/**
 * Monte-Carlo probability caps (2026-08-23 review, P0 "unbounded work", reviewer-named): every
 * path × step draws one normal through the inverse CDF (~37 ns measured), samples the local vol
 * when smile-aware, and updates a Brownian-bridge touch estimate per breakeven — so paths and steps
 * MULTIPLY into the workload and must be bounded together (10^7 × 10^6 = 10^13 path-steps, days).
 * 10^8 path-steps is ~4–8 s; the 50,000 × 50 default is 2.5×10^6.
 */
const MAX_MC_PROBABILITY_PATHS = 10_000_000;
const MAX_MC_PROBABILITY_STEPS = 1_000_000;
const MAX_MC_PROBABILITY_PATH_STEPS = 100_000_000;

/**
 * INTERNAL provenance channel (dx §4.5): named builders stamp `constructedAs` THROUGH the
 * constructor — positions are frozen at construction (dx §4.4), so a post-hoc `defineProperty`
 * would throw. The symbol is deliberately NOT exported from the package index: provenance can
 * only be stamped by this package's own builders, so `constructedAs` is never generally writable.
 */
export const CONSTRUCTED_AS: unique symbol = Symbol('totalfinance.strategy.constructedAs');

/** INTERNAL — attach builder provenance to a config so the constructor stamps `constructedAs`. */
export function withProvenance(name: string, config: PositionConfig | undefined): PositionConfig {
  return { ...config, [CONSTRUCTED_AS]: name } as PositionConfig;
}

function grid(range: PriceRange): number[] {
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) {
    throw new InputError(
      `strategy: price range from/to must be finite, got from=${range.from}, to=${range.to}.`,
      { code: ErrorCode.InputNotFinite, context: { from: range.from, to: range.to } },
    );
  }
  // Safe integer AND a work cap (2026-08-23 review, P0): see MAX_GRID_STEPS.
  if (!Number.isSafeInteger(range.steps) || range.steps < 1 || range.steps > MAX_GRID_STEPS) {
    throw new InputError(
      `strategy: price range steps must be an integer in [1, ${MAX_GRID_STEPS.toLocaleString('en-US')}] — the grid is materialized and every consumer evaluates the whole position at each point, and 10^6 points is already ~250× a 4K chart's width. Received ${range.steps}.\n  e.g. { from: 80, to: 120, steps: 201 }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { steps: range.steps, max: MAX_GRID_STEPS },
      },
    );
  }
  const out: number[] = [];
  const steps = range.steps;
  if (steps === 1) return [range.from];
  const dx = (range.to - range.from) / (steps - 1);
  for (let i = 0; i < steps; i++) out.push(range.from + i * dx);
  return out;
}

/**
 * Resolve a caller's `prices` — an explicit grid array, a `{ from, to, steps }` range, or omitted — to
 * a numeric grid. When omitted, the `fallback` range (strike-derived, see {@link autoPriceRange}) is
 * used, so `payoff()` / `chartData()` / `scenarioTable()` all have a sensible default instead of
 * throwing on a bare call. An explicit array is used as-is; a range object is expanded through `grid`
 * (which rejects a malformed range with a typed error).
 */
function resolveGrid(
  prices: number[] | PriceRange | undefined,
  fallback: () => PriceRange,
): number[] {
  if (prices === undefined) return grid(fallback());
  if (Array.isArray(prices)) return prices;
  return grid(prices);
}

// ── What-if cube probability helpers (Wave 6 §3) ──────────────────────────────────────────────────

/** §6: reject a probability axis that is not strictly increasing (and thus not unique) or non-finite. */
function ensureStrictlyIncreasing(
  arr: readonly number[],
  name: string,
  functionName: string,
): void {
  for (let i = 0; i < arr.length; i++) {
    ensureFinite(arr[i]!, `${name}[${i}]`, functionName);
    if (i > 0 && !(arr[i]! > arr[i - 1]!)) {
      throw new InputError(
        `${functionName}: ${name} must be strictly increasing and unique; ${name}[${i}]=${arr[i]} ≤ ${name}[${i - 1}]=${arr[i - 1]}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, value: arr[i], previous: arr[i - 1] },
        },
      );
    }
  }
}

/** Reject a probability axis with a non-finite or duplicate value. */
function ensureFiniteUnique(arr: readonly number[], name: string, functionName: string): void {
  const seen = new Set<number>();
  for (let i = 0; i < arr.length; i++) {
    ensureFinite(arr[i]!, `${name}[${i}]`, functionName);
    if (seen.has(arr[i]!)) {
      throw new InputError(`${functionName}: ${name} must be unique; duplicate value ${arr[i]}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: i, value: arr[i] },
      });
    }
    seen.add(arr[i]!);
  }
}

/**
 * The `realWorld` measure's contract: it is a REQUEST for a specific drift, so the drift must be
 * supplied. Falling back to `riskFreeRate` returned the risk-neutral numbers under a result that
 * still echoed `measure: 'realWorld'` — the answer and its own stated assumptions disagreed, and
 * nothing in the output revealed it. `riskNeutral` (the default) needs no expectedReturn, and
 * supplying one there is a contradiction worth naming rather than ignoring.
 *
 * This is the same law the what-if cube's model grammar already enforces (`resolveWhatIfModel`).
 */
function requireExpectedReturn(
  functionName: string,
  measure: 'riskNeutral' | 'realWorld',
  expectedReturn: number | undefined,
): void {
  if (measure === 'realWorld') {
    if (expectedReturn === undefined) {
      throw new InputError(
        `${functionName}: measure 'realWorld' requires expectedReturn — the annualized real-world ` +
          `drift IS the measure. Omitting it silently returned the risk-neutral answer under a ` +
          `'realWorld' label; pass expectedReturn: 0.08, or drop measure to use the risk-neutral ` +
          `default (drift = riskFreeRate − dividendYield).`,
        { code: ErrorCode.InputMissingField, context: { measure, field: 'expectedReturn' } },
      );
    }
    ensureFinite(expectedReturn, 'expectedReturn', functionName);
    return;
  }
  if (expectedReturn !== undefined) {
    throw new InputError(
      `${functionName}: expectedReturn only applies to measure 'realWorld' — the risk-neutral ` +
        `drift is riskFreeRate − dividendYield and cannot be overridden. Pass measure: 'realWorld' ` +
        `to use it, or remove it.`,
      { code: ErrorCode.InputInvalidEnum, context: { measure, expectedReturn } },
    );
  }
}

interface WhatIfModelResolution {
  modelAssumptions: WhatIfCubeProbability['modelAssumptions'];
  lawAt: (yearsForward: number) => TerminalPriceLaw;
}

/**
 * Resolve a {@link WhatIfProbabilityModel} to its echoed assumptions + a `lawAt(yearsForward)` that
 * builds the terminal-price law for that horizon. GBM drift follows the {@link Position.probability}
 * measure grammar with no silent zero default; a custom density integrates over its explicit support.
 */
function resolveWhatIfModel(
  model: WhatIfProbabilityModel,
  context: { s0: number; riskFreeRate: number; dividendYield: number; functionName: string },
): WhatIfModelResolution {
  const { s0, riskFreeRate, dividendYield, functionName } = context;
  requireArgumentObject(functionName, 'probability.model', model);
  const kind = (model as { kind?: unknown }).kind;
  if (kind === 'gbm') {
    const gbm = model as {
      annualizedVolatility: number;
      measure?: string;
      expectedReturn?: number;
      drift?: number;
    };
    const measure = gbm.measure ?? 'riskNeutral';
    if (measure !== 'riskNeutral' && measure !== 'realWorld' && measure !== 'explicit') {
      throw new InputError(
        `${functionName}: probability.model.measure must be 'riskNeutral', 'realWorld', or 'explicit', got "${String(measure)}".`,
        { code: ErrorCode.InputInvalidEnum, context: { measure } },
      );
    }
    // Reject contradictory / extra fields per measure (Law 12): e.g. riskNeutral must not carry drift.
    const allowed =
      measure === 'realWorld'
        ? (['kind', 'annualizedVolatility', 'measure', 'expectedReturn'] as const)
        : measure === 'explicit'
          ? (['kind', 'annualizedVolatility', 'measure', 'drift'] as const)
          : (['kind', 'annualizedVolatility', 'measure'] as const);
    ensureKnownKeys(functionName, 'probability.model', gbm, allowed);
    const sigma = gbm.annualizedVolatility;
    ensurePositive(
      sigma,
      'probability.model.annualizedVolatility',
      functionName,
      ErrorCode.InputNegativeVolatility,
    );
    let resolvedDrift: number;
    let modelAssumptions: WhatIfCubeProbability['modelAssumptions'];
    if (measure === 'realWorld') {
      if (gbm.expectedReturn === undefined) {
        throw new InputError(
          `${functionName}: probability.model measure 'realWorld' requires expectedReturn.`,
          {
            code: ErrorCode.InputMissingField,
            context: { field: 'expectedReturn' },
          },
        );
      }
      ensureFinite(gbm.expectedReturn, 'probability.model.expectedReturn', functionName);
      resolvedDrift = gbm.expectedReturn - dividendYield;
      modelAssumptions = {
        kind: 'gbm',
        measure: 'realWorld',
        annualizedVolatility: sigma,
        expectedReturn: gbm.expectedReturn,
        dividendYield,
        resolvedDrift,
      };
    } else if (measure === 'explicit') {
      if (gbm.drift === undefined) {
        throw new InputError(
          `${functionName}: probability.model measure 'explicit' requires drift.`,
          {
            code: ErrorCode.InputMissingField,
            context: { field: 'drift' },
          },
        );
      }
      ensureFinite(gbm.drift, 'probability.model.drift', functionName);
      resolvedDrift = gbm.drift;
      modelAssumptions = {
        kind: 'gbm',
        measure: 'explicit',
        annualizedVolatility: sigma,
        drift: gbm.drift,
        resolvedDrift,
      };
    } else {
      resolvedDrift = riskFreeRate - dividendYield;
      modelAssumptions = {
        kind: 'gbm',
        measure: 'riskNeutral',
        annualizedVolatility: sigma,
        riskFreeRate,
        dividendYield,
        resolvedDrift,
      };
    }
    const lnS0 = Math.log(s0);
    const lawAt = (timeToExpiryYears: number): TerminalPriceLaw => ({
      kind: 'lognormal',
      muLog: lnS0 + (resolvedDrift - 0.5 * sigma * sigma) * timeToExpiryYears,
      sigma: sigma * Math.sqrt(timeToExpiryYears),
    });
    return { modelAssumptions, lawAt };
  }
  if (kind === 'custom') {
    const custom = model as {
      density: (price: number, yearsForward: number) => number;
      support: { from: number; to: number };
    };
    ensureKnownKeys(functionName, 'probability.model', custom, [
      'kind',
      'density',
      'support',
    ] as const);
    if (typeof custom.density !== 'function') {
      throw new InputError(`${functionName}: probability.model.density must be a function.`, {
        code: ErrorCode.InputWrongType,
        context: { field: 'density' },
      });
    }
    const sup = custom.support;
    requireArgumentObject(functionName, 'probability.model.support', sup);
    ensureKnownKeys(functionName, 'probability.model.support', sup, ['from', 'to'] as const);
    ensureFinite(sup.from, 'probability.model.support.from', functionName);
    ensureFinite(sup.to, 'probability.model.support.to', functionName);
    if (!(sup.from >= 0) || !(sup.to > sup.from)) {
      throw new InputError(
        `${functionName}: probability.model.support must satisfy 0 ≤ from < to (finite), got { from: ${sup.from}, to: ${sup.to} }.`,
        { code: ErrorCode.InputOutOfRange, context: { from: sup.from, to: sup.to } },
      );
    }
    const lawAt = (t: number): TerminalPriceLaw => ({
      kind: 'custom',
      density: custom.density,
      from: sup.from,
      to: sup.to,
      yearsForward: t,
    });
    return { modelAssumptions: { kind: 'custom', support: { from: sup.from, to: sup.to } }, lawAt };
  }
  throw new InputError(
    `${functionName}: probability.model.kind must be 'gbm' or 'custom', got "${String(kind)}".`,
    { code: ErrorCode.InputInvalidEnum, context: { kind } },
  );
}

/**
 * The spot mass over the price grid at one horizon, plus the disclosed grid tails (as fractions of the
 * total support mass). Day zero (or any zero horizon) is a degenerate point mass in the bin containing
 * the current spot — never a divide-by-zero. `report-and-renormalize` returns the in-grid conditional
 * distribution; `include-in-edge-bins` folds the tails into the edge bins.
 */
function resolveDayMass(input: {
  prices: number[];
  yearsForward: number;
  s0: number;
  lawAt: (t: number) => TerminalPriceLaw;
  gridPolicy: 'report-and-renormalize' | 'include-in-edge-bins';
  functionName: string;
}): { masses: number[]; below: number; above: number } {
  const { prices, yearsForward, s0, lawAt, gridPolicy, functionName } = input;
  const n = prices.length;
  if (yearsForward <= 0) {
    // Degenerate point mass at the current spot.
    const loEdge = prices[0]! - (prices[1]! - prices[0]!) / 2;
    const hiEdge = prices[n - 1]! + (prices[n - 1]! - prices[n - 2]!) / 2;
    const masses = new Array<number>(n).fill(0);
    if (s0 < loEdge || s0 > hiEdge) {
      if (gridPolicy === 'report-and-renormalize') {
        throw new InputError(
          `${functionName}: the day-zero spot ${s0} is outside the price grid [${loEdge.toFixed(4)}, ${hiEdge.toFixed(4)}]; the conditional-grid policy cannot renormalize a point mass with no in-grid support. Widen the grid or use gridPolicy: 'include-in-edge-bins'.`,
          { code: ErrorCode.InputOutOfRange, context: { spot: s0, loEdge, hiEdge } },
        );
      }
      if (s0 < loEdge) {
        masses[0] = 1;
        return { masses, below: 1, above: 0 };
      }
      masses[n - 1] = 1;
      return { masses, below: 0, above: 1 };
    }
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      const hi = i === n - 1 ? hiEdge : (prices[i]! + prices[i + 1]!) / 2;
      if (s0 <= hi) {
        idx = i;
        break;
      }
    }
    masses[idx] = 1;
    return { masses, below: 0, above: 0 };
  }
  const dist = priceGridDistribution({ prices, law: lawAt(yearsForward) });
  const total = dist.inGridMass + dist.tailBelow + dist.tailAbove;
  const norm = total > 0 ? total : 1;
  const below = dist.tailBelow / norm;
  const above = dist.tailAbove / norm;
  if (gridPolicy === 'report-and-renormalize') {
    // In-grid conditional distribution (priceGridDistribution already renormalized it to sum to 1).
    return { masses: dist.nodes.map((nd) => nd.probability), below, above };
  }
  // include-in-edge-bins: fold the tail fractions into the edge bins of the support-fraction masses.
  const masses = dist.nodes.map((nd) => (nd.probability * dist.inGridMass) / norm);
  masses[0] = masses[0]! + below;
  masses[n - 1] = masses[n - 1]! + above;
  return { masses, below, above };
}

/**
 * Zeroed extended greeks — the value for a stock leg (delta set by the caller), an expired leg, and the
 * starting accumulator for the aggregate. `lambda` (elasticity Δ·S/V) is `null` here: it is not additive
 * and is recomputed at the book level; a per-leg zero/expiry position has no meaningful elasticity.
 */
function zeroExtendedGreeks(): ExtendedGreeks {
  return {
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    vanna: 0,
    charm: 0,
    vomma: 0,
    speed: 0,
    color: 0,
    phi: 0,
    zomma: 0,
    veta: 0,
    vera: 0,
    ultima: 0,
    lambda: null,
  };
}

/** Evaluate an injected local-volatility function, failing loudly if it returns a non-finite/≤0 σ. */
function sampleLocalVolatility(
  lv: (level: number, timeToExpiryYears: number) => number,
  level: number,
  t: number,
  functionName: string,
): number {
  const s = lv(level, t);
  if (!Number.isFinite(s) || s <= 0) {
    throw new InputError(
      `${functionName}: localVolatility(${level}, ${t}) returned ${s}; a local-volatility path needs a finite positive σ.`,
      { code: ErrorCode.InputOutOfRange, context: { level, timeToExpiryYears: t, sigma: s } },
    );
  }
  return s;
}

/** Linear-interpolated quantile of an already-ascending-sorted array. */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! * (1 - (idx - lo)) + sorted[hi]! * (idx - lo);
}

/**
 * Model-price one leg's entry premium from the market (§3.4): options via BSM at their entry
 * time-to-expiry, stock at spot. Every unpriced leg routes through here so `premiumSource: 'model'`
 * is honest.
 */
function modelPremium(
  leg: Extract<LegInput, { kind: 'call' | 'put' }>,
  market: PremiumMarket,
  index: number,
  functionName: string,
): number {
  const expiry = leg.expiry ?? market.expiry;
  if (expiry === undefined) {
    throw new InputError(
      `${functionName}: legs[${index}] has no premium and no expiry to model one — set the leg's expiry or market.expiry.`,
      { code: ErrorCode.InputMissingField, context: { index, field: 'expiry' } },
    );
  }
  // Core `resolveAsOf` (WS3.2): date-only → UTC midnight, datetimes must carry a zone, garbage
  // throws a teaching error — deterministic on every machine, never a silent local-zone parse.
  const asOfMs = resolveValuationAsOf(market.asOf, functionName);
  ensureFinite(asOfMs, 'market.asOf', functionName);
  const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
  // The leg's own implied volatility prices its entry, exactly as `value()` marks it — pricing the
  // entry at the position vol and the mark at the leg vol opened every chain-fed position with a
  // phantom P&L.
  return blackScholesPrice({
    type: leg.kind,
    spot: market.spot,
    strike: leg.strike,
    timeToExpiryYears: t,
    riskFreeRate: market.riskFreeRate,
    dividendYield: market.dividendYield ?? 0,
    volatility: leg.impliedVolatility ?? market.volatility,
  });
}

/**
 * The reward-to-risk ratio of an expiration payoff, `|maxProfit / maxLoss|`, or `null` with the
 * warning that says why it is undefined: an unbounded profit, an unbounded loss, or a zero maximum
 * loss (B3). One definition serves `probability().riskReward`, `explainPosition`'s `rewardToRisk`
 * and the scanner's `returnOnRisk`, so the three reads of one position can never disagree —
 * and `Infinity` never crosses the surface to read as "the best possible trade".
 */
export function rewardToRisk(metrics: PayoffMetrics): {
  ratio: number | null;
  warning: QuantWarning | null;
} {
  const undefinedBecause =
    metrics.maxLoss === null
      ? 'the maximum loss is unbounded'
      : metrics.maxProfit === null
        ? 'the maximum profit is unbounded'
        : metrics.maxLoss === 0
          ? 'the maximum loss is zero'
          : null;
  if (undefinedBecause !== null) {
    return {
      ratio: null,
      warning: {
        code: WarningCode.StrategyRiskRewardUndefined,
        message: `${undefinedBecause}, so the reward-to-risk ratio is undefined (reported as null).`,
        severity: 'info',
        context: { maxProfit: metrics.maxProfit, maxLoss: metrics.maxLoss },
      },
    };
  }
  return { ratio: Math.abs(metrics.maxProfit! / metrics.maxLoss!), warning: null };
}

/**
 * Resolve every leg's entry premium to a number. A leg that already carries a premium is `'user'`;
 * a leg without one is priced from `config.market` when `premiums: 'model'`, else a typed error
 * teaches the two supported modes. `premiumSource` is `'model'` iff any premium was modeled.
 */
function resolvePremiums(
  legs: readonly LegInput[],
  config: PositionConfig,
  functionName: string,
): {
  resolved: Leg[];
  premiumSource: PremiumSource;
  premiumVolatilitySource?: PremiumVolatilitySource;
} {
  const mode = config.premiums ?? 'user';
  let modeledAny = false;
  const volatilitySources = new Set<'leg' | 'position'>();
  const resolved = legs.map((leg, i): Leg => {
    // A stock row is priced by its entry price, an option row by its premium; either is modeled
    // from the market (the spot, the Black–Scholes–Merton premium) when omitted.
    const priceField = leg.kind === 'stock' ? 'price' : 'premium';
    const supplied = leg.kind === 'stock' ? leg.price : leg.premium;
    if (typeof supplied === 'number')
      return leg.kind === 'stock' ? { ...leg, price: supplied } : { ...leg, premium: supplied };
    if (mode !== 'model' || config.market === undefined) {
      throw new InputError(
        `${functionName}: legs[${i}] has no ${priceField}. Supply entry ${priceField === 'price' ? 'prices' : 'premiums'}, or pass ` +
          `{ premiums: 'model', market: { spot, volatility, riskFreeRate, asOf } } to price them from ` +
          `the market.`,
        { code: ErrorCode.InputMissingField, context: { index: i, field: priceField } },
      );
    }
    modeledAny = true;
    if (leg.kind === 'stock') return { ...leg, price: config.market.spot };
    volatilitySources.add(leg.impliedVolatility !== undefined ? 'leg' : 'position');
    return { ...leg, premium: modelPremium(leg, config.market, i, functionName) };
  });
  if (!modeledAny) return { resolved, premiumSource: 'user' };
  const premiumVolatilitySource: PremiumVolatilitySource | undefined =
    volatilitySources.size === 0
      ? undefined
      : volatilitySources.size === 2
        ? 'mixed'
        : ([...volatilitySources][0] as 'leg' | 'position');
  return {
    resolved,
    premiumSource: 'model',
    ...(premiumVolatilitySource !== undefined ? { premiumVolatilitySource } : {}),
  };
}

/**
 * Only options have expiry horizons. Keep an omitted option expiry as its own bucket: all-undated
 * options support a symbolic terminal payoff, but mixing dated and undated options is unresolved,
 * not evidence that the undated options share their sibling's date. Stock never adds a bucket.
 */
function optionExpiries(legs: readonly Leg[]): Set<string | undefined> {
  return new Set(legs.filter((leg) => leg.kind !== 'stock').map((leg) => leg.expiry));
}

export class Position {
  /**
   * The resolved legs — a frozen snapshot (deep-copied at construction, `Object.freeze`d per leg
   * and as an array). A Position is immutable by design: to tweak a strategy, edit your own leg
   * list and rebuild with `strategy(editedLegs, config)` — every downstream calculation is generic
   * over the legs, so the rebuilt position needs no named builder. Mutating this array throws
   * instead of silently diverging from `assumptions()`/cached results.
   */
  readonly legs: readonly Readonly<Leg>[];
  readonly multiplier: number;
  /** How the entry premiums were sourced: `'user'` (supplied) or `'model'` (priced from `market`). */
  readonly premiumSource: PremiumSource;
  /** When modeled, which volatility priced the entries (`'leg'`, `'position'` or `'mixed'`). */
  readonly premiumVolatilitySource?: PremiumVolatilitySource;
  /**
   * The market this position was built with, if any — a frozen copy (R5), so mutating the caller's
   * market object later never silently retargets the position. `probability()`, `value()`,
   * `scenarioTable()`, and `chartData()` default to it; per-call fields merge over it.
   */
  readonly market?: Readonly<PremiumMarket>;
  /** Keep an explicit default horizon for stock-only probability; never infer it from stock dates. */
  private readonly defaultExpiry: string | undefined;
  /**
   * PROVENANCE, not identity (dx §4.5): the named builder that constructed this position, absent
   * for raw `strategy(legs)`. Because positions are immutable this can never go stale — but a
   * rebuilt-after-tweak position has no name. For "what is this NOW?" use `classifyStrategy`.
   */
  readonly constructedAs?: string;

  constructor(legs: readonly LegInput[], config: PositionConfig = {}) {
    // Validate at construction so payoff/metrics/chart never surface NaN max-profit/loss or chart
    // points from a malformed leg or multiplier (design law #4). All builders flow through here.
    const functionName = 'strategy';
    requireArgumentArray(functionName, 'legs', legs);
    requireArgumentObject(functionName, 'config', config);
    // Law 12: the config rejects unknown keys here at the SHARED entry — `strategy(legs, config)`,
    // `strategyOf`, and every named builder all construct through this constructor. (Provenance
    // rides a symbol key, invisible to Object.keys, so builder-stamped configs pass untouched.)
    ensureKnownKeys(functionName, 'config', config, POSITION_CONFIG_KEYS);
    // When-present ladders BEFORE any coalesce (the 350c2796 ruling): a null multiplier used to
    // silently size at 100, a null market silently priced market-free, and a null expiry fell
    // through the precedence chain below as if omitted.
    ensureFiniteWhenPresent(config.multiplier, 'multiplier', functionName);
    if (
      config.premiums !== undefined &&
      config.premiums !== 'model' &&
      config.premiums !== 'user'
    ) {
      throw new InputError(
        `${functionName}: config.premiums must be 'model' | 'user' when provided. Received ${config.premiums === null ? 'null' : JSON.stringify(config.premiums)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'config.premiums' } },
      );
    }
    if (
      config.expiry !== undefined &&
      (typeof config.expiry !== 'string' || config.expiry.length === 0)
    ) {
      throw new InputError(
        `${functionName}: config.expiry must be an ISO date string when provided. Received ${config.expiry === null ? 'null' : typeof config.expiry}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'config.expiry' } },
      );
    }
    if (
      config.market !== undefined &&
      (config.market === null || typeof config.market !== 'object')
    ) {
      throw new InputError(
        `${functionName}: config.market must be an object of market fields when provided. Received ${config.market === null ? 'null' : typeof config.market}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'config.market' } },
      );
    }
    const multiplier = config.multiplier ?? 100;
    ensurePositive(multiplier, 'multiplier', functionName);
    // Position-level default expiry (R4): materialized onto every leg that lacks its own, so the
    // position remembers when it expires (probability()/value() need no re-telling). Precedence:
    // leg.expiry > config.expiry > config.market.expiry. Validated eagerly — a garbage default
    // expiry must fail here, not on the first probability() call.
    const defaultExpiry = config.expiry ?? config.market?.expiry;
    if (defaultExpiry !== undefined) optionExpiryToMs(defaultExpiry);
    this.defaultExpiry = defaultExpiry;
    // Each row is closed to its own kind (B4): a stock row has no strike, premium, expiry or
    // volatility to carry, and an option row has no share price — a misspelled or misplaced field
    // teaches instead of riding along. The default horizon is materialized onto OPTION rows only;
    // stock has no expiry.
    legs.forEach((leg, i) => {
      requireArgumentObject(functionName, `legs[${i}]`, leg);
      if (leg.kind === 'stock')
        ensureKnownKeys(functionName, `legs[${i}]`, leg, ['kind', 'price', 'quantity']);
      else
        ensureKnownKeys(functionName, `legs[${i}]`, leg, [
          'kind',
          'strike',
          'premium',
          'quantity',
          'expiry',
          'impliedVolatility',
        ]);
    });
    const withExpiry =
      defaultExpiry === undefined
        ? legs
        : legs.map((l) =>
            l.kind !== 'stock' && l.expiry === undefined ? { ...l, expiry: defaultExpiry } : l,
          );
    // Resolve entry premiums first — unpriced legs are model-priced from config.market (§3.4).
    const { resolved, premiumSource, premiumVolatilitySource } = resolvePremiums(
      withExpiry,
      config,
      functionName,
    );
    resolved.forEach((leg, i) => {
      if (leg.kind === 'stock') {
        ensureFinite(leg.price, `legs[${i}].price`, functionName);
      } else {
        ensurePositive(
          leg.strike,
          `legs[${i}].strike`,
          functionName,
          ErrorCode.InputNegativeStrike,
        );
        ensureFinite(leg.premium, `legs[${i}].premium`, functionName);
      }
      ensureFinite(leg.quantity, `legs[${i}].quantity`, functionName);
      if (leg.quantity === 0) {
        throw new InputError(`${functionName}: legs[${i}].quantity must be non-zero.`, {
          code: ErrorCode.InputOutOfRange,
          context: { index: i },
        });
      }
    });
    this.legs = Object.freeze(resolved.map((leg) => Object.freeze(leg)));
    this.multiplier = multiplier;
    this.premiumSource = premiumSource;
    if (premiumVolatilitySource !== undefined)
      this.premiumVolatilitySource = premiumVolatilitySource;
    if (config.market !== undefined) this.market = Object.freeze({ ...config.market });
    // Builder provenance rides the config through the internal CONSTRUCTED_AS symbol (named
    // builders and strategyFromChain) — it must be set BEFORE the freeze below.
    const provenance = (config as { [CONSTRUCTED_AS]?: unknown })[CONSTRUCTED_AS];
    if (typeof provenance === 'string') this.constructedAs = provenance;
    // Positions are immutable (dx §4.4). The legs are frozen above; freezing the instance itself
    // makes `pos.multiplier = 1` (which would silently retarget every metric) a TypeError in
    // strict mode instead of a lie.
    Object.freeze(this);
  }

  /**
   * Position-construction assumptions (design law #3): whether the entry premiums were supplied by
   * the caller (`'user'`) or model-priced from a market (`'model'`), plus the contract multiplier.
   */
  assumptions(): PositionAssumptions {
    return {
      premiumSource: this.premiumSource,
      ...(this.premiumVolatilitySource !== undefined
        ? { premiumVolatilitySource: this.premiumVolatilitySource }
        : {}),
      multiplier: this.multiplier,
      ...(this.constructedAs !== undefined ? { constructedAs: this.constructedAs } : {}),
    };
  }

  /**
   * Merge call-site market overrides over the remembered construction market (R5). Only DEFINED
   * call fields override (an explicit `undefined` never erases a remembered value), the position's
   * single option expiry backfills `expiry`, and `required` fields still missing after the merge throw
   * one teaching error listing them all. Returns the merged fields plus the echoed `marketSource`.
   */
  private resolveMarket<T extends Partial<PremiumMarket> & { expiry?: string }>(
    input: T,
    functionName: string,
    required: readonly ('spot' | 'volatility' | 'riskFreeRate' | 'asOf' | 'expiry')[],
  ): { merged: T & Partial<PremiumMarket>; marketSource: MarketSource } {
    const MARKET_KEYS = [
      'spot',
      'volatility',
      'riskFreeRate',
      'asOf',
      'dividendYield',
      'expiry',
    ] as const;
    // Defaults were materialized at construction. Infer a horizon only when ALL options agree;
    // neither a dated stock nor a dated sibling can resolve a missing option expiry.
    const expiries = optionExpiries(this.legs);
    let positionExpiry: string | undefined;
    if (expiries.size === 0) positionExpiry = this.defaultExpiry;
    else if (expiries.size === 1) positionExpiry = [...expiries][0];
    const defaults: Partial<PremiumMarket> & { expiry?: string } = {
      ...(this.market !== undefined ? this.market : {}),
      ...(positionExpiry !== undefined ? { expiry: positionExpiry } : {}),
    };
    // The position owns its horizon: a call-site `expiry` that contradicts the expiry materialized
    // on its option legs used to be echoed in `assumptions` and used by `probability()` while every
    // leg kept pricing at its own date. A FOREIGN horizon is refused; a value the legs already carry,
    // or the remembered construction market's own `expiry` (re-passing that market object is the
    // common call), changes nothing and is accepted. A call-site expiry is a horizon only for a
    // position whose options carry none.
    const datedExpiries = [...expiries].filter((e): e is string => e !== undefined);
    if (
      input.expiry !== undefined &&
      datedExpiries.length > 0 &&
      !datedExpiries.includes(input.expiry) &&
      input.expiry !== this.market?.expiry
    ) {
      throw new InputError(
        `${functionName}: this position's option legs expire ${datedExpiries.map((e) => `"${e}"`).join(', ')}, ` +
          `so a call-site expiry "${input.expiry}" would price them at a horizon they do not have. ` +
          `Rebuild the position with the new expiry — strategy(legs, { expiry }) or a per-leg expiry — ` +
          `instead of overriding it at valuation.`,
        {
          code: ErrorCode.StrategyExpiryConflict,
          context: {
            function: functionName,
            field: 'expiry',
            expiry: input.expiry,
            legExpiries: datedExpiries,
          },
        },
      );
    }
    const merged: Record<string, unknown> = { ...defaults };
    let callContributed = false;
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      merged[k] = v;
      if ((MARKET_KEYS as readonly string[]).includes(k)) callContributed = true;
    }
    // Dated legs govern: the horizon every single-expiry analytic prices and echoes is the legs'
    // own, never a call-site or construction-market default that happened to differ.
    if (positionExpiry !== undefined) merged['expiry'] = positionExpiry;
    const constructionContributed = MARKET_KEYS.some(
      (k) => defaults[k] !== undefined && merged[k] === defaults[k],
    );
    const missing = required.filter((k) => merged[k] === undefined);
    if (missing.length > 0) {
      throw new InputError(
        `${functionName}: missing market field(s): ${missing.join(', ')}. Pass them in the call, or build ` +
          `the position with { market: { spot, volatility, riskFreeRate, asOf, expiry } } so they default from it.`,
        { code: ErrorCode.InputMissingField, context: { missing: [...missing] } },
      );
    }
    const marketSource: MarketSource =
      constructionContributed && callContributed
        ? 'merged'
        : constructionContributed
          ? 'construction'
          : 'call';
    return { merged: merged as T & Partial<PremiumMarket>, marketSource };
  }

  /**
   * Single-expiration analytics (`payoff`/`metrics`/`probability`) assume all OPTIONS expire together.
   * A calendar/diagonal spans multiple expiries, so a single terminal payoff is meaningless — refuse
   * it and point the caller at the time-aware `value()` / `scenarioTable()` instead (design law #4:
   * never answer a different question than the one asked). More than one option-expiry bucket also
   * rejects mixed dated/undated options. Stock has no expiry and is valued at the terminal spot.
   */
  private assertSingleExpiry(method: string): void {
    const distinct = optionExpiries(this.legs);
    if (distinct.size > 1) {
      throw new InputError(
        `strategy: ${method}() is single-expiration analytics, but this position spans multiple ` +
          `expiries (a calendar/diagonal). Use value() or scenarioTable() for a time-aware mark-to-market.`,
        {
          code: ErrorCode.StrategyMultiExpiryExpirationAnalytics,
          context: { method, expiries: [...distinct] },
        },
      );
    }
  }

  /** Expiration P&L at an underlying price. */
  pnlAtExpiry(underlyingPrice: number): number {
    // A single terminal payoff is meaningless for a calendar/diagonal (legs expire at different
    // times); refuse it here rather than fabricate a flat curve (the guard `metrics()`/`payoff()`
    // already enforce, extended to the public payoff primitive and to `chartData(expirationPnl)`).
    this.assertSingleExpiry('pnlAtExpiry');
    let total = 0;
    for (const leg of this.legs) {
      if (leg.kind === 'stock') {
        total += leg.quantity * (underlyingPrice - leg.price);
      } else {
        const intrinsic =
          leg.kind === 'call'
            ? Math.max(underlyingPrice - leg.strike, 0)
            : Math.max(leg.strike - underlyingPrice, 0);
        total += leg.quantity * this.multiplier * (intrinsic - leg.premium);
      }
    }
    return total;
  }

  /** Slope of the expiration payoff at an underlying price (used for asymptotic analysis). */
  private slopeAt(underlyingPrice: number): number {
    let slope = 0;
    for (const leg of this.legs) {
      if (leg.kind === 'stock') {
        slope += leg.quantity;
      } else {
        const d =
          leg.kind === 'call'
            ? underlyingPrice > leg.strike
              ? 1
              : 0
            : underlyingPrice < leg.strike
              ? -1
              : 0;
        slope += leg.quantity * this.multiplier * d;
      }
    }
    return slope;
  }

  /** Net cash to enter (positive = debit, negative = credit). */
  netDebit(): number {
    let net = 0;
    for (const leg of this.legs) {
      net +=
        leg.kind === 'stock'
          ? leg.quantity * leg.price
          : leg.quantity * this.multiplier * leg.premium;
    }
    return net;
  }

  /**
   * Net debit/credit, max profit/loss, and breakevens. The expiration payoff is piecewise-linear, so
   * these are computed ANALYTICALLY from the kink set (every option strike plus every stock entry
   * price) and the tail slopes — never by sampling a coarse grid, which missed breakevens beyond the
   * last strike (e.g. a lone long stock, or a deep-ITM option) and ignored stock entry prices.
   */
  metrics(): PayoffMetrics {
    this.assertSingleExpiry('metrics');
    const netDebit = this.netDebit();
    const kinks = [
      ...new Set(this.legs.map((l) => (l.kind === 'stock' ? l.price : l.strike))),
    ].sort((a, b) => a - b);

    if (kinks.length === 0) {
      const p = this.pnlAtExpiry(0);
      return {
        netDebit,
        netCredit: -netDebit,
        maxProfit: p,
        maxLoss: p,
        bounded: { profit: true, loss: true },
        breakevens: [],
      };
    }

    const pnl = kinks.map((k) => this.pnlAtExpiry(k));
    const leftSlope = this.slopeAt(kinks[0]! - 1);
    const rightSlope = this.slopeAt(kinks[kinks.length - 1]! + 1);

    // The payoff is linear on [0, k₀], between consecutive kinks, and on [kₙ, ∞). Its extremes occur
    // at a kink, at S=0, or at ±∞ per the right-tail slope (S ≥ 0, so the left tail is bounded).
    const pnl0 = this.pnlAtExpiry(0);
    // An unbounded tail is `null` with its `bounded` flag false (B3) — never `Infinity`, which
    // JSON drops and which read as "the best trade" in a ratio.
    const bounded = { profit: !(rightSlope > EPS), loss: !(rightSlope < -EPS) };
    const maxProfit = bounded.profit ? Math.max(pnl0, ...pnl) : null;
    const maxLoss = bounded.loss ? Math.min(pnl0, ...pnl) : null;

    const breakevens: number[] = [];
    const add = (x: number): void => {
      if (Number.isFinite(x) && !breakevens.some((b) => Math.abs(b - x) < 1e-9)) breakevens.push(x);
    };
    // A kink sitting exactly on zero is itself a breakeven (e.g. a lone long stock at its entry).
    kinks.forEach((k, i) => {
      if (Math.abs(pnl[i]!) < 1e-9) add(k);
    });
    // Interior segments: an exact root wherever consecutive kinks straddle zero.
    for (let i = 0; i < kinks.length - 1; i++) {
      const a = pnl[i]!;
      const b = pnl[i + 1]!;
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
        add(kinks[i]! + ((kinks[i + 1]! - kinks[i]!) * (0 - a)) / (b - a));
      }
    }
    // Left tail (0 ≤ x < k₀): crossing off the first kink using the analytic left slope.
    if (Math.abs(leftSlope) > EPS) {
      const x = kinks[0]! - pnl[0]! / leftSlope;
      if (x >= 0 && x < kinks[0]!) add(x);
    }
    // Right tail (x > kₙ): crossing off the last kink using the analytic right slope.
    if (Math.abs(rightSlope) > EPS) {
      const last = kinks.length - 1;
      const x = kinks[last]! - pnl[last]! / rightSlope;
      if (x > kinks[last]!) add(x);
    }
    breakevens.sort((a, b) => a - b);

    return { netDebit, netCredit: -netDebit, maxProfit, maxLoss, bounded, breakevens };
  }

  /**
   * Strike-derived default price window for the chart/scenario methods when a caller omits `prices` —
   * the same auto-range a payoff diagram draws: strikes (stock legs use their entry price), finite
   * breakevens (single-expiry only), and any known spot. Keeps a bare `payoff()` / `chartData()` /
   * `scenarioTable()` useful instead of forcing a hand-picked grid.
   */
  private defaultPriceRange(): PriceRange {
    const singleExpiry = optionExpiries(this.legs).size <= 1;
    return autoPriceRange([
      ...this.legs.map((l) => (l.kind === 'stock' ? l.price : l.strike)),
      ...(singleExpiry ? this.metrics().breakevens : []),
      ...(this.market?.spot !== undefined ? [this.market.spot] : []),
    ]);
  }

  /**
   * Expiration payoff metrics plus a chart-ready grid of points (spec §12.2). `prices` is an explicit
   * grid array or a `{ from, to, steps }` range; omit it to frame the strike-derived default window
   * (the same one a payoff diagram draws).
   */
  payoff(options: { prices?: number[] | PriceRange } = {}): PayoffResult {
    requireArgumentObject('strategy.payoff', 'options', options);
    this.assertSingleExpiry('payoff');
    const points = resolveGrid(options.prices, () => this.defaultPriceRange()).map(
      (underlyingPrice) => ({
        underlyingPrice,
        pnl: this.pnlAtExpiry(underlyingPrice),
      }),
    );
    return { ...this.metrics(), points };
  }

  private markToMarketAssumptions(input: {
    timeToExpiryYears: number | undefined;
    asOf: number;
    dividendYield: number;
    volatilitySource: VolatilitySource;
    marketSource: MarketSource;
  }): Assumptions<{ volatilitySource: VolatilitySource; marketSource: MarketSource }> {
    const { timeToExpiryYears: t, asOf, dividendYield: q, volatilitySource, marketSource } = input;
    return {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      asOf,
      // A fully multi-expiry position (calendar/diagonal) has no position-level time-to-expiry:
      // every leg prices at its own t, so echoing one here would disclose an unused assumption.
      ...(t !== undefined ? { timeToExpiryYears: t } : {}),
      dividendModel: q === 0 ? 'none' : 'continuousYield',
      units: DEFAULT_GREEK_UNITS,
      model: 'black-scholes-merton',
      engine: 'black-scholes-merton',
      volatilitySource,
      marketSource,
    };
  }

  /** Mark-to-market value, P&L, per-leg and aggregate Greeks via BSM (spec §12.3). */
  value(overrides: Partial<MarkToMarketInput> = {}): MarkToMarketResult {
    // Validate at the boundary before the trusted low-level kernels, so an invalid MTM input never
    // surfaces as a NaN value/Greeks with `converged: true` (design law #4).
    const functionName = 'strategy.value';
    // A position-level `expiry` is required only when some OPTION lacks its own: a fully multi-expiry
    // position (calendar/diagonal) prices every leg at its own expiry, so demanding one would ask
    // for a pricing-irrelevant fact — and any supplied one is neither consumed nor echoed.
    const expiries = optionExpiries(this.legs);
    const needsPositionExpiry = expiries.has(undefined);
    const isFullyMultiExpiry = !needsPositionExpiry && expiries.size > 1;
    // The construction market is the default; call fields merge over it (R5).
    const { merged: input, marketSource } = this.resolveMarket(
      overrides,
      functionName,
      needsPositionExpiry
        ? ['spot', 'riskFreeRate', 'asOf', 'expiry']
        : ['spot', 'riskFreeRate', 'asOf'],
    ) as { merged: MarkToMarketInput; marketSource: MarketSource };
    ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
    ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
    const asOfMs = resolveValuationAsOf(input.asOf, functionName);
    ensureFinite(asOfMs, 'asOf', functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    // Position-level time-to-expiry, via the shared option-expiry convention (date-only → 16:00 ET,
    // datetime parsed) so a same-day 0DTE contract keeps positive time-to-expiry instead of
    // collapsing to t<0. Undefined for stock-only or fully multi-expiry positions (no shared t).
    let timeToExpiryYears: number | undefined;
    if (expiries.size > 0 && !isFullyMultiExpiry && input.expiry !== undefined) {
      timeToExpiryYears = yearFraction(asOfMs, optionExpiryToMs(input.expiry), 'ACT/365F');
      ensureFinite(timeToExpiryYears, 'timeToExpiryYears', functionName); // catches an unparseable expiry (→ NaN)
    }
    // Per-leg time-to-expiry: a leg with its own `expiry` (calendars/diagonals) is priced at its own
    // TTE; legs without one use the position-level expiry (`t` is guaranteed defined for them by the
    // `needsPositionExpiry` requirement above). Cache by expiry string to avoid re-parsing.
    const legTimeCache = new Map<string, number>();
    const legTime = (leg: Leg): number => {
      if (leg.expiry === undefined) return timeToExpiryYears!;
      const cached = legTimeCache.get(leg.expiry);
      if (cached !== undefined) return cached;
      const lt = yearFraction(asOfMs, optionExpiryToMs(leg.expiry), 'ACT/365F');
      ensureFinite(lt, 'timeToExpiryYears', functionName);
      legTimeCache.set(leg.expiry, lt);
      return lt;
    };
    // Per-leg volatility (WS7.1): a leg prices at its own `impliedVolatility` when set, else the
    // position-level `volatility`. Each future option leg needs a positive volatility from one of
    // those two sources; a leg with its own `impliedVolatility` does not require `input.volatility`.
    // Validate every applicable source and record where the volatility came from.
    let usesLegVolatility = false;
    let usesPositionVolatility = false;
    let usesCallVolatility = false;
    // Per-call overrides (Preview P1): an array aligned to the legs; a number overrides that leg's
    // volatility for this call, `undefined` leaves the leg's own precedence untouched.
    const legVolatilities = input.legVolatilities;
    if (legVolatilities !== undefined) {
      if (!Array.isArray(legVolatilities) || legVolatilities.length !== this.legs.length) {
        throw new InputError(
          `${functionName}: legVolatilities must be an array aligned to the position's ${this.legs.length} legs (a number overrides that leg's volatility for this call; undefined leaves it). Received ${Array.isArray(legVolatilities) ? `${legVolatilities.length} entries` : legVolatilities === null ? 'null' : typeof legVolatilities}.`,
          { code: ErrorCode.InputWrongShape, context: { field: 'legVolatilities' } },
        );
      }
      legVolatilities.forEach((v, i) => {
        if (v === undefined) return;
        ensurePositive(v, `legVolatilities[${i}]`, functionName, ErrorCode.InputNegativeVolatility);
      });
    }
    const callVolatility = (index: number): number | undefined =>
      legVolatilities === undefined ? undefined : legVolatilities[index];
    for (const [index, leg] of this.legs.entries()) {
      if (leg.kind === 'stock' || legTime(leg) <= EPS) continue; // expired/stock legs use no vol
      if (callVolatility(index) !== undefined) {
        usesCallVolatility = true;
      } else if (leg.impliedVolatility !== undefined) {
        ensurePositive(
          leg.impliedVolatility,
          'leg.impliedVolatility',
          functionName,
          ErrorCode.InputNegativeVolatility,
        );
        usesLegVolatility = true;
      } else {
        usesPositionVolatility = true;
      }
    }
    if (usesPositionVolatility) {
      // At least one un-expired leg has no per-leg iv, so a position-level vol is required here.
      if (input.volatility === undefined) {
        throw new InputError(
          `${functionName}: a leg without its own impliedVolatility needs a position-level volatility; ` +
            `pass \`volatility\` (or give every leg an impliedVolatility).`,
          { code: ErrorCode.InputMissingField, context: { field: 'volatility' } },
        );
      }
      ensurePositive(
        input.volatility,
        'volatility',
        functionName,
        ErrorCode.InputNegativeVolatility,
      );
    }
    const volatilitySource: VolatilitySource = usesCallVolatility
      ? 'perCall'
      : usesLegVolatility && usesPositionVolatility
        ? 'mixed'
        : usesLegVolatility
          ? 'perLeg'
          : 'position';
    // An additive vol shock applies to EVERY effective leg vol (per-leg `iv` and position `vol`), so
    // a scenario shock actually reaches per-leg-IV legs instead of being silently ignored.
    const volatilityShock = input.volatilityShock ?? 0;
    let volatilityFloored = false;
    const S = input.spot;
    const perLeg = [];
    const agg = zeroExtendedGreeks();
    let currentValue = 0;
    let entryValue = 0;

    for (const [legIndex, leg] of this.legs.entries()) {
      if (leg.kind === 'stock') {
        const v = leg.quantity * S;
        const entry = leg.quantity * leg.price;
        // Stock is pure delta (elasticity 1); every option greek is 0.
        const g: ExtendedGreeks = { ...zeroExtendedGreeks(), delta: leg.quantity, lambda: 1 };
        perLeg.push({ leg, value: v, pnl: v - entry, greeks: g });
        currentValue += v;
        entryValue += entry;
        agg.delta += g.delta;
        continue;
      }
      const scaled = leg.quantity * this.multiplier;
      const tLeg = legTime(leg);
      let price: number;
      let g: ExtendedGreeks;
      if (tLeg <= EPS) {
        // At/after this leg's expiry: value at intrinsic, Greeks zero.
        price = leg.kind === 'call' ? Math.max(S - leg.strike, 0) : Math.max(leg.strike - S, 0);
        g = zeroExtendedGreeks();
      } else {
        // `input.vol` is guaranteed present here when a leg has no iv (validated above).
        let legVolatility =
          (callVolatility(legIndex) ?? leg.impliedVolatility ?? input.volatility!) +
          volatilityShock;
        if (legVolatility < VOL_FLOOR) {
          legVolatility = VOL_FLOOR;
          volatilityFloored = true;
        }
        price = blackScholesPrice({
          type: leg.kind,
          spot: S,
          strike: leg.strike,
          timeToExpiryYears: tLeg,
          riskFreeRate: input.riskFreeRate,
          dividendYield: q,
          volatility: legVolatility,
        });
        // Extended greeks (not just first-order): the second-order fields power the higher-order P&L
        // attribution in `explainPositionPnl` (@insiderfinance/totalfinance/risk) automatically. All are raw and scale
        // linearly with position size; `lambda` (Δ·S/V) is dimensionless and passes through unscaled.
        const lg = blackScholesExtendedGreeks({
          type: leg.kind,
          spot: S,
          strike: leg.strike,
          timeToExpiryYears: tLeg,
          riskFreeRate: input.riskFreeRate,
          dividendYield: q,
          volatility: legVolatility,
        });
        g = {
          delta: lg.delta * scaled,
          gamma: lg.gamma * scaled,
          theta: lg.theta * scaled,
          vega: lg.vega * scaled,
          rho: lg.rho * scaled,
          vanna: lg.vanna * scaled,
          charm: lg.charm * scaled,
          vomma: lg.vomma * scaled,
          speed: lg.speed * scaled,
          color: lg.color * scaled,
          phi: lg.phi * scaled,
          zomma: lg.zomma * scaled,
          veta: lg.veta * scaled,
          vera: lg.vera * scaled,
          ultima: lg.ultima * scaled,
          lambda: lg.lambda,
        };
      }
      const v = scaled * price;
      const entry = scaled * leg.premium;
      perLeg.push({ leg, value: v, pnl: v - entry, greeks: g });
      currentValue += v;
      entryValue += entry;
      agg.delta += g.delta;
      agg.gamma += g.gamma;
      agg.theta += g.theta;
      agg.vega += g.vega;
      agg.rho += g.rho;
      agg.vanna += g.vanna;
      agg.charm += g.charm;
      agg.vomma += g.vomma;
      agg.speed += g.speed;
      agg.color += g.color;
      agg.phi += g.phi;
      agg.zomma += g.zomma;
      agg.veta += g.veta;
      agg.vera += g.vera;
      agg.ultima += g.ultima;
    }
    // Book elasticity Λ = Δ·S / V (dimensionless; not additive across legs, so recomputed here). Null
    // when the book value underflows to 0 — elasticity is undefined at V = 0 (Law 7), never ±∞/NaN.
    const aggLambda = (agg.delta * S) / currentValue;
    agg.lambda = Number.isFinite(aggLambda) ? aggLambda : null;

    const pnl = currentValue - entryValue;
    const warnings: QuantWarning[] = [];
    if (volatilityFloored) {
      warnings.push({
        code: WarningCode.StrategyVolatilityFloored,
        message: `An effective leg volatility fell below the ${VOL_FLOOR} floor after the vol shock and was priced at the floor, not the requested shock.`,
        severity: 'warn',
      });
    }
    const diagnostics: Diagnostics = {
      engine: 'black-scholes-merton',
      method: 'closed-form',
      converged: true,
      warnings,
    };
    return {
      value: pnl,
      pnl,
      perLeg,
      greeks: agg,
      assumptions: this.markToMarketAssumptions({
        timeToExpiryYears,
        asOf: asOfMs,
        dividendYield: q,
        volatilitySource,
        marketSource,
      }),
      diagnostics,
    };
  }

  /**
   * Probability-metric assumptions (R2 envelope): applied conventions plus where the market fields
   * came from (construction/call/merged, R5) — carried in `assumptions`, never hoisted top-level.
   */
  private probabilityAssumptions(
    asOf: number,
    timeToExpiryYears: number,
    marketSource: MarketSource,
    probabilityModel: ProbabilityModel,
  ): Assumptions<{ marketSource: MarketSource; probabilityModel: ProbabilityModel }> {
    return {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      asOf,
      timeToExpiryYears,
      marketSource,
      probabilityModel,
    };
  }

  /**
   * Probability & scenario metrics (spec §12.6): probability of profit, expected value, reward/risk,
   * and the probability of touching each breakeven — under an explicit, echoed lognormal model.
   */
  probability(overrides: Partial<ProbabilityInput> = {}): ProbabilityMetrics {
    const functionName = 'strategy.probability';
    this.assertSingleExpiry('probability');
    // The construction market is the default; call fields merge over it (R5). A position built
    // with { premiums: 'model', market } answers probability() with no arguments at all.
    const { merged: input, marketSource } = this.resolveMarket(overrides, functionName, [
      'spot',
      'volatility',
      'riskFreeRate',
      'asOf',
      'expiry',
    ]) as { merged: ProbabilityInput; marketSource: MarketSource };
    ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
    ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
    const asOfMs = resolveValuationAsOf(input.asOf, functionName);
    ensureFinite(asOfMs, 'asOf', functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    // Resolve the expiry via the shared option-expiry convention (date-only → 16:00 ET, datetime
    // parsed) so a same-day 0DTE contract keeps positive time-to-expiry instead of collapsing to t<0.
    const t = yearFraction(asOfMs, optionExpiryToMs(input.expiry), 'ACT/365F');
    ensureFinite(t, 'timeToExpiryYears', functionName);
    if (t > EPS)
      ensurePositive(
        input.volatility,
        'volatility',
        functionName,
        ErrorCode.InputNegativeVolatility,
      );

    const measure = input.measure ?? 'riskNeutral';
    // Reject an unknown measure rather than silently treating it as risk-neutral and echoing it back.
    if (measure !== 'riskNeutral' && measure !== 'realWorld') {
      throw new InputError(
        `${functionName}: measure must be 'riskNeutral' or 'realWorld', got "${measure}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { measure },
        },
      );
    }
    // `realWorld` REQUIRES its drift. The old `?? input.riskFreeRate` fallback made an omitted
    // `expectedReturn` silently reproduce the risk-neutral answer while the echoed
    // `assumptions.probabilityModel.measure` still claimed 'realWorld' — a result that says it is
    // one thing and is another. Same contract the what-if cube's model grammar already enforces.
    requireExpectedReturn(functionName, measure, input.expectedReturn);
    const drift = (measure === 'realWorld' ? input.expectedReturn! : input.riskFreeRate) - q;
    const S0 = input.spot;
    const sigma = input.volatility;
    const m = this.metrics();

    // Profit regions are the intervals between sorted breakevens (plus 0 and ∞); POP sums the
    // lognormal probability mass of the regions where expiration P&L is positive.
    const bes = [...m.breakevens].sort((a, b) => a - b);
    const edges = [0, ...bes, Infinity];
    let pop = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i]!;
      const hi = edges[i + 1]!;
      const rep =
        lo === 0 && hi === Infinity
          ? S0
          : lo === 0
            ? hi / 2
            : hi === Infinity
              ? lo + Math.max(S0, lo * 0.5)
              : (lo + hi) / 2;
      if (this.pnlAtExpiry(rep) > 0) {
        const cdfLo =
          lo === 0
            ? 0
            : terminalCdf({
                spot: S0,
                strike: lo,
                drift,
                volatility: sigma,
                timeToExpiryYears: t,
              });
        const cdfHi =
          hi === Infinity
            ? 1
            : terminalCdf({
                spot: S0,
                strike: hi,
                drift,
                volatility: sigma,
                timeToExpiryYears: t,
              });
        pop += cdfHi - cdfLo;
      }
    }

    // Expected expiration P&L: per leg, closed-form expected intrinsic (undiscounted) minus premium.
    let ev = 0;
    for (const leg of this.legs) {
      if (leg.kind === 'stock') {
        ev += leg.quantity * (S0 * Math.exp(drift * t) - leg.price);
      } else {
        const ei = expectedIntrinsic({
          type: leg.kind,
          spot: S0,
          strike: leg.strike,
          drift,
          volatility: sigma,
          timeToExpiryYears: t,
        });
        ev += leg.quantity * this.multiplier * (ei - leg.premium);
      }
    }

    const { ratio: riskReward, warning: riskRewardWarning } = rewardToRisk(m);
    const probabilityOfTouch: TouchProbability[] = bes.map((price) => ({
      price,
      probability: touchProbability({
        spot: S0,
        barrier: price,
        drift,
        volatility: sigma,
        timeToExpiryYears: t,
      }),
    }));

    return {
      probabilityOfProfit: Math.min(1, Math.max(0, pop)),
      expectedValue: ev,
      riskReward,
      probabilityOfTouch,
      assumptions: this.probabilityAssumptions(asOfMs, t, marketSource, {
        measure,
        drift,
        volatility: sigma,
        volatilityModel: 'lognormal',
        timeToExpiryYears: t,
      }),
      diagnostics: { warnings: riskRewardWarning === null ? [] : [riskRewardWarning] },
    };
  }

  /**
   * Monte-Carlo probability metrics (spec §12.6): the simulated analogue of {@link probability}, for
   * cross-validation and path-dependent reads. Terminal lognormal paths give the probability of profit
   * and expected P&L (with a standard error); the probability of touching each breakeven is estimated
   * with the Brownian-bridge continuous-monitoring correction. Seeded and deterministic.
   */
  monteCarloProbability(
    overrides: Partial<ProbabilityMonteCarloInput> & { seed: number },
  ): ProbabilityMonteCarloMetrics {
    const functionName = 'strategy.monteCarloProbability';
    // Unlike `probability()`/`value()`, this has no defaultable empty input — a simulation needs an
    // explicit `seed` (the determinism law never invents one) — so a bare call teaches the seed
    // requirement directly instead of a generic shape error.
    if (overrides === undefined || overrides === null) {
      throw new InputError(
        `${functionName}: a Monte-Carlo run must be explicitly seeded — call monteCarloProbability({ seed: 42 }). ` +
          `Market fields (spot, volatility, rate, asOf, expiry) default from the construction market; the seed never defaults.`,
        { code: ErrorCode.InputMissingField, context: { missing: ['seed'] } },
      );
    }
    requireArgumentObject(functionName, 'overrides', overrides);
    this.assertSingleExpiry('monteCarloProbability');
    // Market fields default from construction (R5); the seed is never defaulted — a simulation
    // must be explicitly, reproducibly seeded.
    const { merged: input, marketSource } = this.resolveMarket(overrides, functionName, [
      'spot',
      'riskFreeRate',
      'asOf',
      'expiry',
    ]) as { merged: ProbabilityMonteCarloInput; marketSource: MarketSource };
    ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
    ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
    const asOfMs = resolveValuationAsOf(input.asOf, functionName);
    ensureFinite(asOfMs, 'asOf', functionName);
    ensureFinite(input.seed, 'seed', functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    const t = yearFraction(asOfMs, optionExpiryToMs(input.expiry), 'ACT/365F');
    ensureFinite(t, 'timeToExpiryYears', functionName);
    ensurePositive(t, 'timeToExpiryYears', functionName);
    const useLocalVolatility = input.localVolatility !== undefined;
    if (!useLocalVolatility && input.volatility === undefined) {
      throw new InputError(
        `${functionName}: provide volatility (constant-σ) or localVolatility (smile-aware).`,
        {
          code: ErrorCode.InputMissingField,
          context: {},
        },
      );
    }
    if (input.volatility !== undefined)
      ensurePositive(
        input.volatility,
        'volatility',
        functionName,
        ErrorCode.InputNegativeVolatility,
      );

    const measure = input.measure ?? 'riskNeutral';
    if (measure !== 'riskNeutral' && measure !== 'realWorld') {
      throw new InputError(
        `${functionName}: measure must be 'riskNeutral' or 'realWorld', got "${measure}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { measure },
        },
      );
    }
    requireExpectedReturn(functionName, measure, input.expectedReturn);
    const drift = (measure === 'realWorld' ? input.expectedReturn! : input.riskFreeRate) - q;

    // Safe integers AND work caps (2026-08-23 review, P0, reviewer-named): see the
    // MAX_MC_PROBABILITY_* constants — above 2^53 the loop counters cannot advance at all, and the
    // paths × steps PRODUCT is the real workload, so it is bounded alongside each factor.
    const paths = input.paths ?? 50_000;
    if (!Number.isSafeInteger(paths) || paths < 2 || paths > MAX_MC_PROBABILITY_PATHS) {
      throw new InputError(
        `${functionName}: paths must be an integer in [2, ${MAX_MC_PROBABILITY_PATHS.toLocaleString('en-US')}] — every path simulates the full step grid and updates a touch estimate per breakeven, and win-rate standard error ∝ 1/√paths gains only 3× per extra decade. Received ${paths}.\n  e.g. monteCarloProbability({ seed: 42, paths: 100_000 })`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { paths, max: MAX_MC_PROBABILITY_PATHS },
        },
      );
    }
    const steps = input.steps ?? 50;
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_MC_PROBABILITY_STEPS) {
      throw new InputError(
        `${functionName}: steps must be an integer in [1, ${MAX_MC_PROBABILITY_STEPS.toLocaleString('en-US')}] — each step is one normal draw per path (plus a local-vol sample when smile-aware), and the touch estimator's bridge correction already covers what finer stepping would add. Received ${steps}.\n  e.g. monteCarloProbability({ seed: 42, steps: 100 })`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { steps, max: MAX_MC_PROBABILITY_STEPS },
        },
      );
    }
    if (paths * steps > MAX_MC_PROBABILITY_PATH_STEPS) {
      throw new InputError(
        `${functionName}: paths × steps must not exceed ${MAX_MC_PROBABILITY_PATH_STEPS.toLocaleString('en-US')} — the product is the total simulation workload (one inverse-CDF draw per path-step, ~4–8 s at the cap), so each factor being under its own cap proves nothing. Received ${paths} × ${steps} = ${(paths * steps).toLocaleString('en-US')}.\n  e.g. monteCarloProbability({ seed: 42, paths: 100_000, steps: 100 })`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { paths, steps, maxPathSteps: MAX_MC_PROBABILITY_PATH_STEPS },
        },
      );
    }

    const S0 = input.spot;
    const localVolatilityFn = input.localVolatility;
    // Representative echo vol: local vol at (spot, t) when smile-aware, else the constant σ.
    const echoVolatility = useLocalVolatility
      ? sampleLocalVolatility(localVolatilityFn!, S0, t, functionName)
      : input.volatility!;
    const bes = [...this.metrics().breakevens].sort((x, y) => x - y);
    const randomNumberGenerator = mulberry32(input.seed);
    const timeStepYears = t / steps;
    const sqdt = Math.sqrt(timeStepYears);

    const wantQuantiles = input.pnlQuantiles !== undefined && input.pnlQuantiles.length > 0;
    if (wantQuantiles) {
      for (const q of input.pnlQuantiles!) {
        if (!(q > 0 && q < 1)) {
          throw new InputError(`${functionName}: each pnlQuantile must be in (0, 1), got ${q}.`, {
            code: ErrorCode.InputOutOfRange,
            context: { quantile: q },
          });
        }
      }
    }
    const pnls = wantQuantiles ? new Array<number>(paths) : undefined;

    let wins = 0;
    let evSum = 0;
    let evSumSq = 0;
    const touchSum = new Array<number>(bes.length).fill(0);

    for (let p = 0; p < paths; p++) {
      let logS = Math.log(S0);
      let prevS = S0;
      const survive = new Array<number>(bes.length).fill(1); // probability NOT yet touched
      for (let i = 0; i < steps; i++) {
        // Constant σ, or the Dupire local vol at the price/time reached this step (smile-aware paths).
        const sig = useLocalVolatility
          ? sampleLocalVolatility(
              localVolatilityFn!,
              prevS,
              (i + 0.5) * timeStepYears,
              functionName,
            )
          : input.volatility!;
        const sig2dt = sig * sig * timeStepYears;
        logS +=
          (drift - 0.5 * sig * sig) * timeStepYears +
          sig * sqdt * normalInverseCdf(randomNumberGenerator.next());
        const s = Math.exp(logS);
        for (let b = 0; b < bes.length; b++) {
          const H = bes[b]!;
          if ((prevS - H) * (s - H) <= 0) {
            survive[b] = 0; // discrete crossing ⇒ definitely touched
          } else {
            // Brownian-bridge probability of having crossed H between prevS and s (same side).
            survive[b]! *= 1 - Math.exp((-2 * Math.log(prevS / H) * Math.log(s / H)) / sig2dt);
          }
        }
        prevS = s;
      }
      const pnl = this.pnlAtExpiry(prevS);
      if (pnl > 0) wins++;
      evSum += pnl;
      evSumSq += pnl * pnl;
      if (pnls) pnls[p] = pnl;
      for (let b = 0; b < bes.length; b++) touchSum[b]! += 1 - survive[b]!;
    }

    const ev = evSum / paths;
    const variance = Math.max(0, (evSumSq - paths * ev * ev) / (paths - 1));
    const result: ProbabilityMonteCarloMetrics = {
      probabilityOfProfit: wins / paths,
      expectedValue: ev,
      expectedValueStandardError: Math.sqrt(variance / paths),
      probabilityOfTouch: bes.map((price, b) => ({ price, probability: touchSum[b]! / paths })),
      paths,
      seed: input.seed,
      assumptions: this.probabilityAssumptions(asOfMs, t, marketSource, {
        measure,
        drift,
        volatility: echoVolatility,
        volatilityModel: useLocalVolatility ? 'localVolatility' : 'lognormal',
        timeToExpiryYears: t,
      }),
    };
    if (pnls) {
      pnls.sort((a, b) => a - b);
      result.pnlQuantiles = input.pnlQuantiles!.map((q) => ({
        quantile: q,
        pnl: quantileSorted(pnls, q),
      }));
    }
    return result;
  }

  /**
   * Scenario table (spec §12.6): mark-to-market P&L and Greeks across a grid of underlying prices,
   * additive vol shocks, and days forward — the standard "what-if" matrix for an options ticket.
   */
  scenarioTable(
    options: {
      /** Market overrides; defaults from the construction market (R5). */
      market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
      /** Spot axis: an explicit grid array or a `{ from, to, steps }` range. Omit for the default window. */
      prices?: number[] | PriceRange;
      /** Additive vol shocks (decimal), e.g. `[-0.05, 0, 0.05]`. Default `[0]`. */
      volatilityShocks?: number[];
      /** Calendar days to advance `asOf`, e.g. `[0, 1, 7]`. Default `[0]`. */
      daysForward?: number[];
    } = {},
  ): ScenarioTableResult {
    const functionName = 'strategy.scenarioTable';
    requireArgumentObject(functionName, 'options', options);
    const prices = resolveGrid(options.prices, () => this.defaultPriceRange());
    const volatilityShocks = options.volatilityShocks ?? [0];
    const days = options.daysForward ?? [0];
    const DAY = 86_400_000;
    const market = options.market ?? {};
    // Where the table's market came from (R5): merge the caller's market fields over the
    // construction market exactly as the per-cell value() calls will. Nothing is REQUIRED here —
    // each cell's value() enforces the full field set — this only derives the honest echo.
    const { marketSource } = this.resolveMarket(
      market as Partial<PremiumMarket> & { expiry?: string },
      functionName,
      [],
    );
    const baseAsOfRaw = market.asOf ?? this.market?.asOf;
    if (baseAsOfRaw === undefined) {
      throw new InputError(
        `${functionName}: missing market field(s): asOf. Pass market.asOf, or build the ` +
          `position with { market: { spot, volatility, riskFreeRate, asOf, expiry } } so it defaults from it.`,
        { code: ErrorCode.InputMissingField, context: { missing: ['asOf'] } },
      );
    }
    const baseAsOf = resolveValuationAsOf(baseAsOfRaw, functionName);
    const rows: ScenarioRow[] = [];
    let clampedCells = 0;
    for (const underlyingPrice of prices) {
      for (const volatilityShock of volatilityShocks) {
        for (const daysForward of days) {
          // Route the shock through `value(volatilityShock)` so it reaches per-leg-IV legs (not just the
          // position `vol`); `value()` floors the effective vol and reports it, which we tally here.
          const markToMarket = this.value({
            ...market,
            spot: underlyingPrice,
            volatilityShock,
            asOf: baseAsOf + daysForward * DAY,
          });
          if (
            markToMarket.diagnostics.warnings.some((w) => w.code === 'strategy.volatility_floored')
          )
            clampedCells++;
          rows.push({
            underlyingPrice,
            volatilityShock,
            daysForward,
            pnl: markToMarket.pnl,
            delta: markToMarket.greeks.delta,
            gamma: markToMarket.greeks.gamma,
            theta: markToMarket.greeks.theta,
            vega: markToMarket.greeks.vega,
          });
        }
      }
    }
    const warnings: QuantWarning[] = [];
    if (clampedCells > 0) {
      warnings.push({
        code: WarningCode.StrategyVolatilityFloored,
        message: `${clampedCells} scenario cell(s) had a shocked volatility below the ${VOL_FLOOR} floor and were priced at the floor, not the requested shock.`,
        severity: 'warn',
        context: { clampedCells, volatilityFloor: VOL_FLOOR },
      });
    }
    // R2 one-envelope law: the grid is the `value`, `marketSource` lives in assumptions (never
    // hoisted), and the clamped-vol warnings ride `diagnostics.warnings` like every other result.
    return {
      value: rows,
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, marketSource },
      diagnostics: {
        engine: 'black-scholes-merton',
        method: 'closed-form',
        converged: true,
        warnings,
      },
    };
  }

  /**
   * A what-if **cube**: the position marked over the full spot × vol-shock × days-forward grid, plus
   * the **optimal-exit surface** — for each (spot, vol) outcome, the day along the time axis that
   * optimizes P&L (`max-pnl` by default, or `min-pnl`). `scenarioTable` extended a dimension: it returns
   * a navigable cube (axes + row-major cells) with the reductions a trader wants, not a flat row list.
   *
   * Every cell is a `value()` mark (time-aware, per-leg-IV, shock-through-to-leg-IV), so calendars and
   * per-leg volatilities behave identically. The optimal-exit surface is a CONDITIONAL what-if ("if the
   * underlying is here with this vol shock, which day marks best?"), not a path-dependent stopping rule.
   * See `docs/specs/what-if-cube.md`.
   */
  whatIfCube(options: WhatIfCubeOptions = {}): WhatIfCubeResult {
    const functionName = 'strategy.whatIfCube';
    requireArgumentObject(functionName, 'options', options);
    const prices = resolveGrid(options.prices, () => this.defaultPriceRange());
    const volatilityShocks = options.volatilityShocks ?? [0];
    const days = options.daysForward ?? [0];
    if (prices.length === 0 || volatilityShocks.length === 0 || days.length === 0) {
      throw new InputError(
        `${functionName}: prices, volatilityShocks, and daysForward must each be non-empty (a cube needs at least one of each axis).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            prices: prices.length,
            volatilityShocks: volatilityShocks.length,
            days: days.length,
          },
        },
      );
    }
    const objective = options.objective ?? 'max-pnl';
    if (objective !== 'max-pnl' && objective !== 'min-pnl') {
      throw new InputError(
        `${functionName}: objective must be 'max-pnl' or 'min-pnl'; got ${String(objective)}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { objective },
        },
      );
    }
    const DAY = 86_400_000;
    const market = options.market ?? {};
    const { marketSource } = this.resolveMarket(
      market as Partial<PremiumMarket> & { expiry?: string },
      functionName,
      [],
    );
    const baseAsOfRaw = market.asOf ?? this.market?.asOf;
    if (baseAsOfRaw === undefined) {
      throw new InputError(
        `${functionName}: missing market field(s): asOf. Pass market.asOf, or build the ` +
          `position with { market: { spot, volatility, riskFreeRate, asOf, expiry } } so it defaults from it.`,
        { code: ErrorCode.InputMissingField, context: { missing: ['asOf'] } },
      );
    }
    const baseAsOf = resolveValuationAsOf(baseAsOfRaw, functionName);

    const cells: WhatIfCell[] = [];
    const optimalExit: OptimalExitPoint[] = [];
    let best: WhatIfCell | undefined;
    let worst: WhatIfCell | undefined;
    let clampedCells = 0;
    const better = (a: number, b: number): boolean => (objective === 'max-pnl' ? a > b : a < b);

    // Break-even-time surface: first non-negative-P&L day per (price, vol). Price outer, vol inner.
    const breakEvenRows: Array<Array<number | null>> = [];
    // Row-major: price outer, vol middle, day inner — so `cells` index is ((i·|vol|)+j)·|days|+k.
    for (const underlyingPrice of prices) {
      const beRow: Array<number | null> = [];
      for (const volatilityShock of volatilityShocks) {
        let exit: OptimalExitPoint | undefined;
        let firstNonNegativeDay: number | null = null;
        for (const daysForward of days) {
          const markToMarket = this.value({
            ...market,
            spot: underlyingPrice,
            volatilityShock,
            asOf: baseAsOf + daysForward * DAY,
          });
          if (
            markToMarket.diagnostics.warnings.some((w) => w.code === 'strategy.volatility_floored')
          )
            clampedCells++;
          const cell: WhatIfCell = {
            underlyingPrice,
            volatilityShock,
            daysForward,
            pnl: markToMarket.pnl,
            delta: markToMarket.greeks.delta,
            gamma: markToMarket.greeks.gamma,
            theta: markToMarket.greeks.theta,
            vega: markToMarket.greeks.vega,
          };
          cells.push(cell);
          if (exit === undefined || better(cell.pnl, exit.pnl)) {
            exit = { underlyingPrice, volatilityShock, daysForward, pnl: cell.pnl };
          }
          // First requested day with non-negative P&L (a conditional surface; not assumed monotone).
          if (firstNonNegativeDay === null && cell.pnl >= 0) firstNonNegativeDay = daysForward;
          if (best === undefined || cell.pnl > best.pnl) best = cell;
          if (worst === undefined || cell.pnl < worst.pnl) worst = cell;
        }
        // `exit` is defined: `days` has ≥ 1 entry (defaults to `[0]`).
        optimalExit.push(exit!);
        beRow.push(firstNonNegativeDay);
      }
      breakEvenRows.push(beRow);
    }
    const breakEven: WhatIfCubeBreakEven = {
      firstNonNegativeDayByPriceAndVolatility: breakEvenRows,
    };

    // Opt-in probability weighting (Wave 6 §3) — resolved from the current spot + selected process.
    const probability = options.probability
      ? this.whatIfProbability(options.probability, {
          prices,
          volatilityShocks,
          days,
          cells,
          market,
          baseAsOf,
          functionName,
        })
      : undefined;

    const warnings: QuantWarning[] = [];
    if (clampedCells > 0) {
      warnings.push({
        code: WarningCode.StrategyVolatilityFloored,
        message: `${clampedCells} cube cell(s) had a shocked volatility below the ${VOL_FLOOR} floor and were priced at the floor, not the requested shock.`,
        severity: 'warn',
        context: { clampedCells, volatilityFloor: VOL_FLOOR },
      });
    }

    return {
      value: {
        axes: { prices, volatilityShocks, daysForward: days },
        cells,
        optimalExit,
        // `best`/`worst` are defined: the loops run at least once (prices/volatilityShocks/days each non-empty).
        best: best!,
        worst: worst!,
        breakEven,
        ...(probability !== undefined ? { probability } : {}),
      },
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, marketSource },
      diagnostics: {
        engine: 'black-scholes-merton',
        method: 'closed-form',
        converged: true,
        warnings,
      },
    };
  }

  /**
   * Resolve the what-if cube's probability block (Wave 6 §3): a spot distribution per day (GBM by
   * measure, or a custom density), disclosed grid tails, and per-(vol, day) expected P&L. The spot law
   * is anchored at the CURRENT spot; day zero is a degenerate point mass in the containing bin (no
   * divide-by-zero). Shares {@link priceGridDistribution} with the optimizer.
   */
  private whatIfProbability(
    options: WhatIfProbabilityOptions,
    context: {
      prices: number[];
      volatilityShocks: number[];
      days: number[];
      cells: WhatIfCell[];
      market: Partial<Omit<MarkToMarketInput, 'spot'>>;
      baseAsOf: number;
      functionName: string;
    },
  ): WhatIfCubeProbability {
    const { prices, volatilityShocks, days, cells, market, functionName } = context;
    requireArgumentObject(functionName, 'probability', options);
    ensureKnownKeys(functionName, 'probability', options, ['model', 'gridPolicy'] as const);
    const gridPolicy = options.gridPolicy ?? 'report-and-renormalize';
    if (gridPolicy !== 'report-and-renormalize' && gridPolicy !== 'include-in-edge-bins') {
      throw new InputError(
        `${functionName}: probability.gridPolicy must be 'report-and-renormalize' or 'include-in-edge-bins', got "${String(gridPolicy)}".`,
        { code: ErrorCode.InputInvalidEnum, context: { gridPolicy } },
      );
    }
    // §6: probability mode needs strictly increasing unique prices, strictly increasing unique
    // non-negative days, and finite unique vol shocks — the spot mass is undefined otherwise.
    ensureStrictlyIncreasing(prices, 'probability prices', functionName);
    ensureStrictlyIncreasing(days, 'probability daysForward', functionName);
    if (days[0]! < 0) {
      throw new InputError(
        `${functionName}: probability daysForward must be non-negative, got ${days[0]}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { day: days[0] },
        },
      );
    }
    ensureFiniteUnique(volatilityShocks, 'probability volatilityShocks', functionName);

    // Anchor the process at the CURRENT spot + rate/dividend (the GBM start), not the grid prices.
    const { merged } = this.resolveMarket(
      market as Partial<PremiumMarket> & { expiry?: string },
      functionName,
      ['spot', 'riskFreeRate'],
    );
    const s0 = merged.spot!;
    const rate = merged.riskFreeRate!;
    const dividendYield = merged.dividendYield ?? 0;
    ensurePositive(s0, 'spot', functionName, ErrorCode.InputNegativeSpot);
    ensureFinite(rate, 'riskFreeRate', functionName);
    ensureFinite(dividendYield, 'dividendYield', functionName);

    const { modelAssumptions, lawAt } = resolveWhatIfModel(options.model, {
      s0,
      riskFreeRate: rate,
      dividendYield,
      functionName,
    });

    const DAY_YEARS = 1 / 365; // ACT/365F: calendar days forward → years
    const spotMassByDay: number[][] = [];
    const tailMassByDay: Array<{ below: number; above: number }> = [];
    const expectationMeaning =
      gridPolicy === 'report-and-renormalize' ? 'conditional-on-grid' : 'edge-censored';

    for (const day of days) {
      const yearsForward = day * DAY_YEARS;
      const { masses, below, above } = resolveDayMass({
        prices,
        yearsForward,
        s0,
        lawAt,
        gridPolicy,
        functionName,
      });
      spotMassByDay.push(masses);
      tailMassByDay.push({ below, above });
    }

    // expectedPnlByVolatilityAndDay[v][d] = Σ_price spotMass(price, day) · cell.pnl(price, vol, day).
    const nDays = days.length;
    const nVolatility = volatilityShocks.length;
    const expectedPnlByVolatilityAndDay: number[][] = volatilityShocks.map(() =>
      new Array<number>(nDays).fill(0),
    );
    for (let pi = 0; pi < prices.length; pi++) {
      for (let vi = 0; vi < nVolatility; vi++) {
        for (let di = 0; di < nDays; di++) {
          const pnl = cells[(pi * nVolatility + vi) * nDays + di]!.pnl;
          expectedPnlByVolatilityAndDay[vi]![di]! += spotMassByDay[di]![pi]! * pnl;
        }
      }
    }

    return {
      spotMassByDay,
      tailMassByDay,
      gridPolicy,
      expectationMeaning,
      modelAssumptions,
      expectedPnlByVolatilityAndDay,
    };
  }

  /**
   * Chart-ready output (spec §12.5). Current P&L / live Greeks need a market: per-call fields
   * merge over the construction market (R5), so a model-premium position charts with no `market`.
   */
  chartData(
    options: {
      prices?: number[] | PriceRange;
      include?: ChartInclude;
      market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
    } = {},
  ): Array<{
    underlyingPrice: number;
    expirationPnl?: number;
    currentPnl?: number;
    delta?: number;
    theta?: number;
  }> {
    requireArgumentObject('strategy.chartData', 'options', options);
    const include = options.include ?? { expirationPnl: true };
    const needsMarket = include.currentPnl || include.delta || include.theta;
    if (needsMarket && !options.market && !this.market) {
      throw new InputError(
        'chartData: `market` is required when currentPnl/delta/theta columns are requested ' +
          '(or build the position with { market: {...} } so it defaults from it).',
        { code: ErrorCode.StrategyInvalidChartRange, context: { include } },
      );
    }
    return resolveGrid(options.prices, () => this.defaultPriceRange()).map((underlyingPrice) => {
      const row: {
        underlyingPrice: number;
        expirationPnl?: number;
        currentPnl?: number;
        delta?: number;
        theta?: number;
      } = {
        underlyingPrice,
      };
      if (include.expirationPnl) row.expirationPnl = this.pnlAtExpiry(underlyingPrice);
      if (needsMarket) {
        const markToMarket = this.value({ ...(options.market ?? {}), spot: underlyingPrice });
        if (include.currentPnl) row.currentPnl = markToMarket.pnl;
        if (include.delta) row.delta = markToMarket.greeks.delta;
        if (include.theta) row.theta = markToMarket.greeks.theta;
      }
      return row;
    });
  }
}

/** Build a position from legs. */
export function strategyOf(legs: readonly LegInput[], config?: PositionConfig): Position {
  return new Position(legs, config);
}
