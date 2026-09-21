import { ensureFiniteWhenPresent } from './options-internal.js';
/**
 * P&L explain (spec §12.2) — decompose a position's or portfolio's **realized** P&L between two
 * market states into greek contributions (the full second-order Taylor in spot/vol/time/rate plus a
 * dividend-carry term) plus an honest **unexplained residual**.
 *
 * It is the realized wrapper over the greek-Taylor engine already in this package: `taylorPnl` gives
 * the first-order `Δ·dS + Vega·dσ + Θ·dt + Rho·dr`, the diagonal curvatures `½Γ·dS² + ½·vomma·dσ² +
 * ½·rhoConvexity·dr² + ½·thetaConvexity·dt²`, every cross term `vanna·dS·dσ + charm·dS·dt +
 * deltaRate·dS·dr + veta·dσ·dt + vera·dσ·dr + thetaRate·dt·dr`, and the carry `ε·dq`; P&L explain feeds
 * the ACTUAL observed move + the ACTUAL realized P&L, and reports `unexplained = actualPnl − (those
 * terms)`. The residual is the load-bearing honesty term: 3rd-order-and-higher (speed/ultima/…), any
 * 2nd-order greek the caller did not supply, and any model/data effects the expansion misses — it
 * grows precisely when the greeks stop approximating the move well.
 *
 * Invariant (exact up to floating-point rounding): `Σ(greek terms) + unexplained === total`. It is
 * reconstructed as `Σterms + (actual − Σterms)`, so it is bit-exact except under catastrophic
 * cancellation — the explained P&L dwarfing the actual by ~16 orders of magnitude, which never happens
 * on a real book.
 */

import {
  CONVENTIONS_VERSION,
  type EpochMs,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  resolveValuationAsOf,
  yearFraction,
} from '@totalfinance/core';
import type { StrategyLeg, StrategyPosition } from './strategy-shape.js';
import { type PnlAttribution, type PositionGreeks, type Scenario, taylorPnl } from './scenario.js';

/** A realized market move (t0 → t1), in the raw units `taylorPnl` expects. */
export interface PnlMove {
  /** Absolute spot change ($). */
  dSpot?: number;
  /** Absolute vol change (decimal; `+0.02` = +2 vol points). */
  dVolatility?: number;
  /**
   * Time elapsed, in YEARS. The unit is in the name; the Greeks are per DAY (the options package's
   * units) and the engine converts, so a caller never scales either side by 365.
   */
  dTimeYears?: number;
  /** Absolute rate change (decimal; `+0.005` = +50 bp). */
  dRate?: number;
  /** Absolute dividend-yield change (decimal; `+0.005` = +50 bp) — drives the `ε·dq` carry term. */
  dDividendYield?: number;
}

/** The documented {@link PnlMove} keys — Law 12: a misspelled move (`dspot`) must throw, never no-op. */
const PNL_MOVE_KEYS = ['dSpot', 'dVolatility', 'dTimeYears', 'dRate', 'dDividendYield'] as const;

/** Law 2 report grammar (D5): every P&L-explain answer carries its conventions and a warnings channel. */
function pnlExplainReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

/**
 * Warn when the (already-computed) residual dominates the total: the greek-Taylor expansion stopped
 * explaining the move, so the attribution should be read with suspicion (design law #4).
 */
function residualWarnings(total: number, unexplained: number): QuantWarning[] {
  if (!(Math.abs(total) > 0) || !(Math.abs(unexplained) > 0.5 * Math.abs(total))) return [];
  return [
    {
      code: WarningCode.RiskPnlUnexplainedResidual,
      message:
        'The unexplained residual exceeds half of the total P&L — the greek-Taylor expansion is not capturing this move (higher-order, cross-term, or model/data effects dominate).',
      severity: 'warn',
      context: { total, unexplained, share: Math.abs(unexplained) / Math.abs(total) },
    },
  ];
}

/** A realized P&L attribution: greek terms + the unexplained residual, summing exactly to `total`. */
export interface PnlExplain {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings (e.g. a dominant residual); always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** The actual realized P&L. */
  total: number;
  /** Delta term: `Δ·dS`. */
  delta: number;
  /** Gamma term: `½Γ·dS²`. */
  gamma: number;
  /** Vega term: `Vega·dσ`. */
  vega: number;
  /** Theta term: `Θ·dt`. */
  theta: number;
  /** Rho term: `Rho·dr`. */
  rho: number;
  /** Second-order spot–vol cross term: `vanna·dS·dσ` (0 unless the greeks carry `vanna`). */
  vanna: number;
  /** Second-order vol-convexity term: `½·vomma·dσ²` (0 unless the greeks carry `vomma`). */
  vomma: number;
  /** Second-order spot–time cross term: `charm·dS·dt` (0 unless the greeks carry `charm`). */
  charm: number;
  /** Second-order vol–time cross term: `veta·dσ·dt` (0 unless the greeks carry `veta`). */
  veta: number;
  /** Second-order vol–rate cross term: `vera·dσ·dr` (0 unless the greeks carry `vera`). */
  vera: number;
  /** Second-order spot–rate cross term: `deltaRate·dS·dr` (0 unless the greeks carry `deltaRate`). */
  deltaRate: number;
  /** Second-order time–rate cross term: `thetaRate·dt·dr` (0 unless the greeks carry `thetaRate`). */
  thetaRate: number;
  /** Second-order rate-convexity term: `½·rhoConvexity·dr²` (0 unless the greeks carry `rhoConvexity`). */
  rhoConvexity: number;
  /** Second-order time-convexity term: `½·thetaConvexity·dt²` (0 unless the greeks carry `thetaConvexity`). */
  thetaConvexity: number;
  /** First-order dividend-carry term: `φ·dq` (0 unless the greeks carry `phi`). */
  phi: number;
  /**
   * `total − Σ(terms)` — the full 2nd-order Taylor in (spot, vol, time, rate) plus the dividend carry
   * is now attributed, so the residual is only 3rd-order-and-higher (speed/ultima/…), any 2nd-order
   * greek the caller did not supply, and model/data. Grows as the greek expansion breaks.
   */
  unexplained: number;
}

/** A market snapshot for {@link explainPositionPnl}: what changes between the two states. */
export interface PnlMarket {
  spot: number;
  /** Position-level vol (drives vega attribution; a leg with its own fixed IV ignores it — see docs). */
  volatility?: number;
  riskFreeRate: number;
  asOf: EpochMs | string;
  dividendYield?: number;
  /**
   * Per-leg volatilities at this market state (Preview P1), aligned to `position.legs`: a number
   * marks leg `i` at that volatility (through `Position.value`'s `legVolatilities`) and its vol move
   * is attributed at the LEG level (`to − from`, each side resolving to the override, else the leg's
   * fixed `impliedVolatility`, else the position-level `volatility`). `undefined` leaves that leg on
   * its own precedence. This is how a leg re-marked from a current quote reports a live vega.
   */
  legVolatilities?: readonly (number | undefined)[];
}

/** The documented {@link PnlMarket} keys. */
const PNL_MARKET_KEYS = [
  'spot',
  'volatility',
  'riskFreeRate',
  'asOf',
  'dividendYield',
  'legVolatilities',
] as const;

/** The bare attribution terms — {@link PnlExplain} without the report wrapper (internal reuse). */
type PnlTerms = Omit<PnlExplain, 'assumptions' | 'diagnostics'>;

/** Per-leg realized P&L attribution (bare terms; the report wrapper lives on the position level). */
export interface LegPnlExplain extends Omit<PnlExplain, 'assumptions' | 'diagnostics'> {
  leg: StrategyLeg;
}

/** A position's realized P&L attribution, aggregate + per leg. */
export interface PositionPnlExplain extends PnlExplain {
  perLeg: LegPnlExplain[];
}

/** One position in a portfolio P&L explain, with its own market context. */
export interface PortfolioPnlItem {
  position: StrategyPosition;
  from: PnlMarket;
  to: PnlMarket;
  id?: string;
}

/**
 * A book-level realized P&L attribution (term-wise sum), preserving each position's explain. The
 * report wrapper (Law 2) lives at THIS level (and on each `byPosition` entry, which is itself a
 * {@link PositionPnlExplain}); per-leg rows stay bare by design.
 */
export interface PortfolioPnlExplain extends PnlExplain {
  byPosition: (PositionPnlExplain & { id?: string })[];
}

function scenarioFromMove(move: PnlMove): Scenario {
  return {
    name: 'realized',
    shocks: [
      { factor: 'spot', kind: 'absolute', value: move.dSpot ?? 0 },
      { factor: 'volatility', kind: 'absolute', value: move.dVolatility ?? 0 },
      { factor: 'time', kind: 'absolute', value: move.dTimeYears ?? 0 },
      { factor: 'riskFreeRate', kind: 'absolute', value: move.dRate ?? 0 },
      { factor: 'dividend', kind: 'absolute', value: move.dDividendYield ?? 0 },
    ],
  };
}

/**
 * Shared explain engine behind `explainPnl` / `explainPositionPnl` — guards + the BARE terms.
 * Module-local so each public export controls its own return shape (Law 2): the wrappers add the
 * report grammar at their own level; per-leg rows stay bare.
 */
function explainPnlKernel(input: ExplainPnlInput): PnlTerms {
  requireArgumentObject('explainPnl', 'input', input);
  ensureKnownKeys('explainPnl', 'input', input, ['greeks', 'move', 'actualPnl']);
  const { greeks, move, actualPnl } = input;
  requireArgumentObject('explainPnl', 'greeks', greeks);
  requireArgumentObject('explainPnl', 'move', move);
  // A misspelled move field (`dspot`) would attribute 0 to that greek silently; the greeks arg is
  // guarded by the shared taylorPnl engine below.
  ensureKnownKeys('explainPnl', 'move', move, PNL_MOVE_KEYS);
  ensureFinite(actualPnl, 'actualPnl', 'explainPnl');
  const t: PnlAttribution = taylorPnl(greeks, scenarioFromMove(move));
  return {
    total: actualPnl,
    delta: t.delta,
    gamma: t.gamma,
    vega: t.vega,
    theta: t.theta,
    rho: t.rho,
    vanna: t.vanna,
    vomma: t.vomma,
    charm: t.charm,
    veta: t.veta,
    vera: t.vera,
    deltaRate: t.deltaRate,
    thetaRate: t.thetaRate,
    rhoConvexity: t.rhoConvexity,
    thetaConvexity: t.thetaConvexity,
    phi: t.phi,
    unexplained: actualPnl - t.total,
  };
}

/**
 * Decompose a realized P&L into greek terms + residual, given the position's Greeks (in the options
 * package's units — theta per day, vega per vol point, rho per 1%; see `PositionGreeks`), the
 * realized move, and the actual P&L. The general primitive — works for any instrument whose greeks
 * you can supply.
 */
export interface ExplainPnlInput {
  greeks: PositionGreeks;
  move: PnlMove;
  actualPnl: number;
}

export function explainPnl(input: ExplainPnlInput): PnlExplain {
  requireArgumentObject('explainPnl', 'input', input);
  const { move } = input;
  // A null move member must not coalesce into "no move" (the 350c2796 ruling) — the attribution
  // would DISCLOSE a zero it never applied.
  requireArgumentObject('explainPnl', 'move', move);
  for (const field of PNL_MOVE_KEYS) {
    ensureFiniteWhenPresent(
      (move as Record<string, unknown>)[field],
      `move.${field}`,
      'explainPnl',
    );
  }
  const terms = explainPnlKernel(input);
  return {
    ...terms,
    // The applied move with its `?? 0` defaults resolved (dx §2.4) — a serialized attribution says
    // exactly what it was attributed against; a dominant residual is disclosed, never silent.
    ...pnlExplainReport(
      {
        dSpot: move.dSpot ?? 0,
        dVolatility: move.dVolatility ?? 0,
        dTimeYears: move.dTimeYears ?? 0,
        dRate: move.dRate ?? 0,
        dDividendYield: move.dDividendYield ?? 0,
      },
      residualWarnings(terms.total, terms.unexplained),
    ),
  };
}

function moveBetween(from: PnlMarket, to: PnlMarket): PnlMove {
  const fromMs = resolveValuationAsOf(from.asOf, 'explainPositionPnl');
  const toMs = resolveValuationAsOf(to.asOf, 'explainPositionPnl');
  return {
    dSpot: to.spot - from.spot,
    // A vol move only exists when both markets state a position-level vol.
    dVolatility:
      from.volatility !== undefined && to.volatility !== undefined
        ? to.volatility - from.volatility
        : 0,
    dTimeYears: yearFraction(fromMs, toMs, 'ACT/365F'),
    dRate: to.riskFreeRate - from.riskFreeRate,
    // A dividend-yield move only exists when both markets state one (default 0 = no carry move).
    dDividendYield:
      from.dividendYield !== undefined && to.dividendYield !== undefined
        ? to.dividendYield - from.dividendYield
        : 0,
  };
}

function requireMarket(m: PnlMarket, field: string, functionName: string): void {
  requireArgumentObject(functionName, field, m);
  ensureKnownKeys(functionName, field, m, PNL_MARKET_KEYS);
  ensureFinite(m.spot, `${field}.spot`, functionName);
  ensureFinite(m.riskFreeRate, `${field}.riskFreeRate`, functionName);
}

/** Per-leg volatilities must align to the position's legs; each stated entry is a positive number. */
function requireLegVolatilities(
  m: PnlMarket,
  field: string,
  legCount: number,
  functionName: string,
): void {
  const overrides = m.legVolatilities;
  if (overrides === undefined) return;
  if (!Array.isArray(overrides) || overrides.length !== legCount) {
    throw new InputError(
      `${functionName}: ${field}.legVolatilities must be an array aligned to the position's ${legCount} legs (a number marks that leg at it; undefined leaves the leg on its own volatility). Received ${Array.isArray(overrides) ? `${overrides.length} entries` : overrides === null ? 'null' : typeof overrides}.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, field: `${field}.legVolatilities` },
      },
    );
  }
  overrides.forEach((v, i) => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new InputError(
        `${functionName}: ${field}.legVolatilities[${i}] must be a positive finite volatility or undefined. Received ${v === null ? 'null' : typeof v === 'number' ? String(v) : typeof v}.`,
        {
          code: ErrorCode.InputNegativeVolatility,
          context: { function: functionName, field: `${field}.legVolatilities[${i}]` },
        },
      );
    }
  });
}

/** A strategy Position built by `strategy(...)` / a named builder — not a raw object. */
function requirePosition(
  position: unknown,
  functionName: string,
): asserts position is StrategyPosition {
  const p = position as { value?: unknown; legs?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.value !== 'function' ||
    !Array.isArray(p.legs)
  ) {
    throw new InputError(
      `${functionName}: expected a strategy Position (from strategy(...) or a named builder), not a raw object.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'position' } },
    );
  }
}

/**
 * Decompose a strategy {@link StrategyPosition}'s realized P&L between two market states, aggregate and
 * per leg. Marks the position at each state with `Position.value()` (respecting per-leg IV and expiry),
 * attributes each leg via t0's greeks, and reports the residual. The aggregate is the term-wise sum
 * of the per-leg attributions — exactly consistent with the breakdown, and correct when different
 * legs respond to different volatilities (below).
 *
 * **Volatility attribution is honest per leg.** A leg built with its own fixed IV holds that IV in
 * `Position.value()`, so a change in the position-level `volatility` does not move it — its actual vol P&L is
 * 0, and its vega is therefore attributed against a **zero** vol move, not the position-level one. So
 * a fixed-IV leg reports vega ≈ 0 (matching reality) rather than a phantom vega offset by the
 * residual. A leg pricing off the position `volatility` (no per-leg IV) is attributed with the full
 * `to.volatility − from.volatility` move. To attribute a per-leg IV change, mark that leg's own IV, or use
 * {@link explainPnl} directly with your greeks + the vol move you observed.
 */
export interface ExplainPositionPnlInput {
  position: StrategyPosition;
  from: PnlMarket;
  to: PnlMarket;
}

export function explainPositionPnl(input: ExplainPositionPnlInput): PositionPnlExplain {
  requireArgumentObject('explainPositionPnl', 'input', input);
  ensureKnownKeys('explainPositionPnl', 'input', input, ['position', 'from', 'to']);
  const { position, from, to } = input;
  requirePosition(position, 'explainPositionPnl');
  requireMarket(from, 'from', 'explainPositionPnl');
  requireMarket(to, 'to', 'explainPositionPnl');
  for (const [label, market] of [
    ['from', from],
    ['to', to],
  ] as const) {
    ensureFiniteWhenPresent(
      (market as unknown as Record<string, unknown>)['dividendYield'],
      `${label}.dividendYield`,
      'explainPositionPnl',
    );
  }

  requireLegVolatilities(from, 'from', position.legs.length, 'explainPositionPnl');
  requireLegVolatilities(to, 'to', position.legs.length, 'explainPositionPnl');
  const v0 = position.value(from);
  const v1 = position.value(to);
  const move = moveBetween(from, to);
  const perLegAttribution = from.legVolatilities !== undefined || to.legVolatilities !== undefined;
  // The volatility a leg actually priced at, at one market state: the per-call override, else the
  // leg's own fixed IV, else the position-level vol (undefined when none applies — a stock leg).
  const legVolatilityAt = (
    leg: StrategyLeg,
    index: number,
    market: PnlMarket,
  ): number | undefined =>
    leg.kind === 'stock'
      ? undefined
      : (market.legVolatilities?.[index] ?? leg.impliedVolatility ?? market.volatility);
  // A leg carrying its own fixed IV is inert to the position-level vol move, so attribute its vega
  // against a zero vol move (its actual vol P&L is zero too) — no phantom vega, no phantom residual.
  // With per-leg volatilities stated (Preview P1) the leg's OWN move `to − from` is attributed instead.
  const legMove = (leg: StrategyLeg, index: number): PnlMove => {
    if (perLegAttribution) {
      const a = legVolatilityAt(leg, index, from);
      const b = legVolatilityAt(leg, index, to);
      return { ...move, dVolatility: a !== undefined && b !== undefined ? b - a : 0 };
    }
    return leg.kind !== 'stock' && leg.impliedVolatility !== undefined
      ? { ...move, dVolatility: 0 }
      : move;
  };

  const perLeg: LegPnlExplain[] = v0.perLeg.map((lv0, i) => {
    const lv1 = v1.perLeg[i]!;
    const legExplain = explainPnlKernel({
      // The leg's Greeks are already in the one unit system; the kernel converts internally.
      greeks: { value: lv0.value, spot: from.spot, ...lv0.greeks },
      move: legMove(lv0.leg, i),
      actualPnl: lv1.pnl - lv0.pnl,
    });
    return { leg: lv0.leg, ...legExplain };
  });

  // The aggregate is the term-wise sum of the legs: `total` = Σ leg P&L = v1.pnl − v0.pnl, and every
  // greek term (including the honest per-leg vega) and the residual sum exactly.
  const aggregate = perLeg.reduce<PnlTerms>((acc, l) => {
    acc.total += l.total;
    acc.delta += l.delta;
    acc.gamma += l.gamma;
    acc.vega += l.vega;
    acc.theta += l.theta;
    acc.rho += l.rho;
    acc.vanna += l.vanna;
    acc.vomma += l.vomma;
    acc.charm += l.charm;
    acc.veta += l.veta;
    acc.vera += l.vera;
    acc.deltaRate += l.deltaRate;
    acc.thetaRate += l.thetaRate;
    acc.rhoConvexity += l.rhoConvexity;
    acc.thetaConvexity += l.thetaConvexity;
    acc.phi += l.phi;
    acc.unexplained += l.unexplained;
    return acc;
  }, zero());

  return {
    ...aggregate,
    perLeg,
    // The position-level realized move (dx §2.4; a fixed-IV leg is attributed against dVolatility 0 — see
    // the vol-attribution note above) plus the day count behind `dTimeYears`.
    ...pnlExplainReport(
      {
        ...move,
        timeDayCount: 'ACT/365F',
        legs: perLeg.length,
        volatilityAttribution: perLegAttribution ? 'per-leg' : 'position-level',
      },
      residualWarnings(aggregate.total, aggregate.unexplained),
    ),
  };
}

const zero = (): PnlTerms => ({
  total: 0,
  delta: 0,
  gamma: 0,
  vega: 0,
  theta: 0,
  rho: 0,
  vanna: 0,
  vomma: 0,
  charm: 0,
  veta: 0,
  vera: 0,
  deltaRate: 0,
  thetaRate: 0,
  rhoConvexity: 0,
  thetaConvexity: 0,
  phi: 0,
  unexplained: 0,
});

/**
 * Decompose a portfolio's realized P&L: each position with its own market context (so a book can span
 * underlyings). The book explain is the term-wise sum; each position's explain is preserved.
 */
export function explainPortfolioPnl(items: readonly PortfolioPnlItem[]): PortfolioPnlExplain {
  requireArgumentArray('explainPortfolioPnl', 'items', items);
  const byPosition: (PositionPnlExplain & { id?: string })[] = [];
  const book = zero();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    requireArgumentObject('explainPortfolioPnl', `items[${i}]`, item);
    const explain = explainPositionPnl({
      position: item.position,
      from: item.from,
      to: item.to,
    });
    byPosition.push(item.id !== undefined ? { ...explain, id: item.id } : explain);
    book.total += explain.total;
    book.delta += explain.delta;
    book.gamma += explain.gamma;
    book.vega += explain.vega;
    book.theta += explain.theta;
    book.rho += explain.rho;
    book.vanna += explain.vanna;
    book.vomma += explain.vomma;
    book.charm += explain.charm;
    book.veta += explain.veta;
    book.vera += explain.vera;
    book.deltaRate += explain.deltaRate;
    book.thetaRate += explain.thetaRate;
    book.rhoConvexity += explain.rhoConvexity;
    book.thetaConvexity += explain.thetaConvexity;
    book.phi += explain.phi;
    book.unexplained += explain.unexplained;
  }
  return {
    ...book,
    byPosition,
    // The report wrapper at the BOOK level (Law 2): position count disclosed, and a dominant
    // book-level residual warned exactly like the single-position explain. Per-leg rows stay bare.
    ...pnlExplainReport(
      { positions: items.length },
      residualWarnings(book.total, book.unexplained),
    ),
  };
}
