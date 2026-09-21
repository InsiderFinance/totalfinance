import { ensureFiniteWhenPresent } from './options-internal.js';
/**
 * Portfolio book / risk aggregation (spec §12.2, roadmap Tier 2) — the first-class **book** object
 * that answers "what is my whole book's risk right now?" in one call: net greeks, beta-weighted delta
 * to a reference index, total + per-position margin, concentration by name, per-position and
 * per-underlying breakdowns, and (optionally) the book's P&L under a set of scenarios.
 *
 * Pure composition of the existing risk primitives — `betaWeightedDelta`, `optionsMargin`,
 * `concentration`, `stressTest` — over strategy `Position`s marked with `Position.value()`. The value
 * it adds is the missing top-level book abstraction and the marking that turns a list of positions
 * into aggregate risk.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { StrategyPosition } from './strategy-shape.js';
import {
  type BetaWeightedDeltaResult,
  type ConcentrationValues,
  type OptionMarginLeg,
  betaWeightedDelta,
  concentration,
  optionsMargin,
} from './portfolio.js';
import { type PnlMarket } from './pnl-explain.js';
import {
  type Position as ScenarioPosition,
  type Scenario,
  type ScenarioResult,
  stressTest,
} from './scenario.js';

/** One position in the book: a strategy Position, its market, and optional grouping/beta metadata. */
export interface BookPosition {
  position: StrategyPosition;
  market: PnlMarket;
  id?: string;
  /** Grouping key for the per-underlying breakdown (default: `id` ?? `position-${i}`). */
  underlying?: string;
  /** Beta to the reference index (default 1); used only when `options.indexPrice` is given. */
  beta?: number;
}

/** Options for {@link analyzeBook}. */
export interface BookOptions {
  /** Reference index price → beta-weighted delta (the "net delta in SPY terms" read-out). */
  indexPrice?: number;
  /** Optional book P&L under scenarios (reuses `stressTest` / `taylorPnl`). */
  scenarios?: readonly Scenario[];
  /** Contract multiplier for margin (default 100). */
  multiplier?: number;
  /** Reg-T naked-margin rate knob, forwarded to `optionsMargin` as its `equityRate`. */
  regulationTRate?: number;
}

/** The documented {@link BookOptions} keys — Law 12: an unknown option must throw, never no-op. */
const BOOK_OPTIONS_KEYS = ['indexPrice', 'scenarios', 'multiplier', 'regulationTRate'] as const;

/** Net book greeks in trader-facing DISPLAY units (delta $, theta/day, vega/1%, rho/1%), dollar-scaled. */
export interface BookGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

/** Per-position risk row. */
export interface PositionRisk {
  id: string;
  underlying: string;
  /** Net unrealized P&L of the position ($) — `Position.value()` (P&L since entry), not liquidation NAV. */
  value: number;
  greeks: BookGreeks;
  /** Initial (buying-power) margin for this position. */
  margin: number;
  definedRisk: boolean;
}

/** Per-underlying risk row (positions grouped by `underlying`). */
export interface UnderlyingRisk {
  underlying: string;
  /** Net unrealized P&L for this name ($) — sum of its positions' `Position.value()`. */
  value: number;
  greeks: BookGreeks;
  margin: number;
}

/** The full book risk read-out. */
export interface BookRisk {
  /** Net unrealized P&L of the book ($) — Σ each position's `Position.value()` (P&L since entry), not liquidation NAV. */
  value: number;
  /** Net greeks, display units. */
  greeks: BookGreeks;
  /** Present when `options.indexPrice` is given. */
  betaWeightedDelta?: BetaWeightedDeltaResult;
  margin: { total: number; buyingPowerReduction: number };
  /** Concentration on per-underlying margin — how much buying power sits in one name (bare values; the report wrapper lives on `concentration()` itself). */
  concentration: ConcentrationValues;
  byPosition: PositionRisk[];
  byUnderlying: UnderlyingRisk[];
  /** Present when `options.scenarios` is given. */
  scenarios?: ScenarioResult[];
  assumptions: { conventionsVersion: string; indexPrice?: number; multiplier: number };
  diagnostics: Diagnostics;
}

const zeroGreeks = (): BookGreeks => ({ delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 });

function addGreeks(into: BookGreeks, g: BookGreeks): void {
  into.delta += g.delta;
  into.gamma += g.gamma;
  into.vega += g.vega;
  into.theta += g.theta;
  into.rho += g.rho;
}

/** A strategy Position built by `strategy(...)` / a named builder — not a raw object. */
function requirePosition(position: unknown, index: number): asserts position is StrategyPosition {
  const p = position as { value?: unknown; legs?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.value !== 'function' ||
    !Array.isArray(p.legs)
  ) {
    throw new InputError(
      `analyzeBook: positions[${index}].position must be a strategy Position (from strategy(...) or a named builder).`,
      { code: ErrorCode.InputWrongType, context: { index } },
    );
  }
}

/**
 * Initial (buying-power) margin for a strategy position at a spot. Pure-option positions use the
 * Reg-T `optionsMargin` (defined-risk max loss, long premium, or naked). A **stock-inclusive**
 * structure — covered call, collar, protective put — has its risk capped by the stock leg, which the
 * options-only calc can't see; for those (single-expiry) we use the position's own stock-inclusive
 * max loss as the capital-at-risk margin, so a covered call reads as defined-risk, not a naked short.
 * Returns 0 for a position with no option legs.
 */
function positionMargin(input: {
  position: StrategyPosition;
  spot: number;
  multiplier: number;
  regulationTRate: number | undefined;
}): { margin: number; buyingPower: number; definedRisk: boolean } {
  const { position, spot, multiplier, regulationTRate } = input;
  const optionLegs: OptionMarginLeg[] = position.legs
    .filter(
      (l): l is (typeof position.legs)[number] & { kind: 'call' | 'put' } =>
        l.kind === 'call' || l.kind === 'put',
    )
    .map((l) => ({ type: l.kind, quantity: l.quantity, strike: l.strike, premium: l.premium }));
  if (optionLegs.length === 0) return { margin: 0, buyingPower: 0, definedRisk: true };

  const hasStock = position.legs.some((l) => l.kind === 'stock');
  const expiries = new Set(
    position.legs.filter((l) => l.kind !== 'stock' && l.expiry !== undefined).map((l) => l.expiry),
  );
  // Only a single-expiry position has a well-defined expiration payoff (metrics() asserts it). A
  // stock-covered structure's true (bounded) risk lives in that payoff, not in the option-only calc,
  // so a covered call / collar / protective put reports defined-risk max loss, never a naked short.
  if (hasStock && expiries.size <= 1) {
    const maxLoss = position.metrics().maxLoss;
    if (maxLoss !== null) {
      const margin = Math.max(0, -maxLoss);
      return { margin, buyingPower: margin, definedRisk: true };
    }
    // Unbounded even with the stock cover (e.g. an extra naked short) → fall through to Reg-T naked.
  }
  const r = optionsMargin(optionLegs, {
    spot,
    multiplier,
    ...(regulationTRate !== undefined ? { equityRate: regulationTRate } : {}),
  });
  return {
    margin: r.initialMargin,
    buyingPower: r.buyingPowerReduction,
    definedRisk: r.definedRisk,
  };
}

/**
 * Aggregate a book of strategy positions into net risk: greeks, beta-weighted delta, margin,
 * concentration, per-position + per-underlying breakdowns, and (optionally) scenario P&L.
 */
export function analyzeBook(
  positions: readonly BookPosition[],
  options: BookOptions = {},
): BookRisk {
  requireArgumentArray('analyzeBook', 'positions', positions);
  requireArgumentObject('analyzeBook', 'options', options);
  ensureKnownKeys('analyzeBook', 'options', options, BOOK_OPTIONS_KEYS);
  ensureFiniteWhenPresent(options.regulationTRate, 'regulationTRate', 'analyzeBook');
  ensureFiniteWhenPresent(options.multiplier, 'multiplier', 'analyzeBook');
  ensureFiniteWhenPresent(options.multiplier, 'multiplier', 'analyzeBook');
  const multiplier = options.multiplier ?? 100;

  const netGreeks = zeroGreeks();
  let netValue = 0;
  let totalMargin = 0;
  let totalBuyingPower = 0;
  const byPosition: PositionRisk[] = [];
  const byUnderlyingMap = new Map<string, UnderlyingRisk>();
  const betaInputs: { delta: number; spot: number; beta: number }[] = [];
  const scenarioPositions: ScenarioPosition[] = [];

  for (let i = 0; i < positions.length; i++) {
    const item = positions[i]!;
    requireArgumentObject('analyzeBook', `positions[${i}]`, item);
    requirePosition(item.position, i);
    requireArgumentObject('analyzeBook', `positions[${i}].market`, item.market);
    const pos = item.position;

    const marked = pos.value(item.market);
    const g: BookGreeks = {
      delta: marked.greeks.delta,
      gamma: marked.greeks.gamma,
      vega: marked.greeks.vega,
      theta: marked.greeks.theta,
      rho: marked.greeks.rho,
    };
    const id = item.id ?? `position-${i}`;
    const underlying = item.underlying ?? id;
    const spot = item.market.spot;
    const m = positionMargin({
      position: pos,
      spot,
      multiplier,
      regulationTRate: options.regulationTRate,
    });

    netValue += marked.value;
    addGreeks(netGreeks, g);
    totalMargin += m.margin;
    totalBuyingPower += m.buyingPower;

    byPosition.push({
      id,
      underlying,
      value: marked.value,
      greeks: g,
      margin: m.margin,
      definedRisk: m.definedRisk,
    });

    const u = byUnderlyingMap.get(underlying) ?? {
      underlying,
      value: 0,
      greeks: zeroGreeks(),
      margin: 0,
    };
    u.value += marked.value;
    addGreeks(u.greeks, g);
    u.margin += m.margin;
    byUnderlyingMap.set(underlying, u);

    betaInputs.push({ delta: g.delta, spot, beta: item.beta ?? 1 });
    scenarioPositions.push({
      id,
      quantity: 1,
      // Marked Greeks are already in the one unit system; the Taylor engine converts internally.
      greeks: { value: marked.value, spot, ...marked.greeks },
    });
  }

  const byUnderlying = [...byUnderlyingMap.values()].sort((a, b) => b.margin - a.margin);
  // `concentration` rejects an empty input and divides by gross margin (NaN when it's zero). An empty
  // book, or a zero-margin book (all long-premium / stock-only — no buying power at risk), has nothing
  // to concentrate — report the neutral zero rather than throw or leak a NaN into the envelope.
  const totalConcMargin = byUnderlying.reduce((a, u) => a + u.margin, 0);
  let conc: ConcentrationValues;
  if (byUnderlying.length === 0 || totalConcMargin <= 0) {
    conc = { hhi: 0, effectiveCount: 0, topWeight: 0, topKShare: 0, gini: 0 };
  } else {
    // Embed the bare values only — the book carries ONE report wrapper (its own envelope), and the
    // concentration conventions (top-k default) are `concentration()`'s to disclose, not the book's.
    const c = concentration(byUnderlying.map((u) => u.margin));
    conc = {
      hhi: c.hhi,
      effectiveCount: c.effectiveCount,
      topWeight: c.topWeight,
      topKShare: c.topKShare,
      gini: c.gini,
    };
  }

  const result: BookRisk = {
    value: netValue,
    greeks: netGreeks,
    margin: { total: totalMargin, buyingPowerReduction: totalBuyingPower },
    concentration: conc,
    byPosition,
    byUnderlying,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      ...(options.indexPrice !== undefined ? { indexPrice: options.indexPrice } : {}),
      multiplier,
    },
    diagnostics: {
      engine: 'portfolio-book',
      method: 'greeks-aggregation',
      converged: true,
      warnings: [],
    },
  };

  if (options.indexPrice !== undefined) {
    result.betaWeightedDelta = betaWeightedDelta(betaInputs, { indexPrice: options.indexPrice });
  }
  if (options.scenarios !== undefined) {
    // H11: stressTest reports; the book embeds the bare rows (no nested envelope inside a report).
    result.scenarios = stressTest({
      positions: scenarioPositions,
      scenarios: options.scenarios,
    }).scenarios;
  }
  return result;
}
