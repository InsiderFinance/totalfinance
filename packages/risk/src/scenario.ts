/**
 * Stress & scenario testing for a positions book.
 *
 * A `Scenario` is a named bundle of factor `Shock`s (spot/vol/rate/time/dividend/custom). Positions
 * are repriced under each scenario — either with a caller-supplied `reprice` function, or with the
 * built-in **Greeks-Taylor** expansion, which also yields a **P&L explain** decomposition. The engine
 * sums position P&Ls into a per-scenario book P&L. The expansion is complete to **second order** in
 * (spot, vol, time, rate): the first-order terms `Δ·dS + Vega·dσ + Θ·dt + Rho·dr`, the diagonal
 * curvatures `½Γ·dS² + ½·vomma·dσ² + ½·rhoConvexity·dr² + ½·thetaConvexity·dt²`, and every cross term
 * `vanna·dS·dσ + charm·dS·dt + deltaRate·dS·dr + veta·dσ·dt + vera·dσ·dr + thetaRate·dt·dr`, plus a
 * first-order dividend-carry term `ε·dq`. Each higher-order term is 0 when its greek is absent, so a
 * first-order greek vector reproduces the classic `Δ·dS + ½Γ·dS² + Vega·dσ + Θ·dt + Rho·dr`.
 *
 * Conventions: a spot shock `dS` is absolute price (or `spot · pct` for a percent shock); vol shocks
 * are absolute vol points (`'+10pts'` = +0.10); rate shocks are absolute (`'+50bp'` = +0.005); time
 * shocks advance calendar by `dt` **years**; dividend shocks are absolute yield (`'+50bp'` = +0.005);
 * Greeks (vega/theta/rho) are per-unit (per +1.00 vol,
 * per +1 year, per +1.00 rate) — i.e. raw partial derivatives, not scaled to 1%/1bp/1day. Percent
 * (`'%'`) shocks resolve only for **spot** in the Taylor engine (spot is the one factor it has a
 * reference level for); a `'%'` vol/rate/custom shock throws a teaching error there — use `pts`/`bp`
 * or a raw decimal. A custom `reprice` fn receives the raw scenario and may interpret `%` itself.
 */

import {
  ErrorCode,
  CONVENTIONS_VERSION,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  DEFAULT_GREEK_UNITS,
} from '@totalfinance/core';

/** Law 2 report grammar (D5): every scenario answer carries its conventions and a warnings channel. */
function scenarioReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

/**
 * A scenario's `shocks` list is what the Taylor engine iterates — a `{ name }` without one (or a
 * scalar in its place) would die on a raw "not iterable" TypeError. Teach the shape: scenarios come
 * from `scenario(name, ...shocks)` or `{ name, shocks: [...] }`.
 */
function requireScenarioShape(functionName: string, scenario: Scenario): void {
  requireArgumentObject(functionName, 'scenario', scenario);
  if (!Array.isArray(scenario.shocks)) {
    throw new InputError(
      `${functionName}: scenario.shocks must be an array of shocks — build scenarios with ` +
        `scenario('name', shock.spot('-5%'), …) or pass { name, shocks: [...] }.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          functionName,
          received: scenario.shocks === null ? 'null' : typeof scenario.shocks,
        },
      },
    );
  }
}

export type ShockKind = 'percent' | 'absolute';
export type ShockFactor = 'spot' | 'volatility' | 'riskFreeRate' | 'time' | 'dividend' | string;

export interface Shock {
  factor: ShockFactor;
  kind: ShockKind;
  value: number;
}

/** Parse a change like `'-5%'`, `'+10pts'`, `'50bp'`, or a raw number into `{ kind, value }`. */
function parseChange(
  change: string | number,
  functionName: string,
): { kind: ShockKind; value: number } {
  if (typeof change !== 'number' && typeof change !== 'string') {
    throw new InputError(
      `${functionName}: expected a change like '-5%', '+50bp', or a number; got ${
        change === null ? 'null' : typeof change
      }.`,
      { code: ErrorCode.InputWrongType, context: { functionName } },
    );
  }
  if (typeof change === 'number') {
    if (!Number.isFinite(change)) {
      throw new InputError(`${functionName}: shock value must be finite.`, {
        code: ErrorCode.InputNotFinite,
        context: { functionName, change },
      });
    }
    return { kind: 'absolute', value: change };
  }
  const s = change.trim().replace(/\s+/g, '');
  const m = /^([+-]?\d*\.?\d+)(%|pts?|bps?)?$/i.exec(s);
  if (!m) {
    throw new InputError(`${functionName}: cannot parse shock "${change}".`, {
      code: ErrorCode.InputWrongType,
      context: { functionName, change },
    });
  }
  const num = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '%') return { kind: 'percent', value: num / 100 };
  if (unit === 'pt' || unit === 'pts') return { kind: 'absolute', value: num / 100 }; // vol points
  if (unit === 'bp' || unit === 'bps') return { kind: 'absolute', value: num / 10000 }; // basis points
  return { kind: 'absolute', value: num };
}

/** Typed shock constructors. Strings carry units; raw numbers are absolute. */
export const shock = {
  /** Spot move: `'-5%'` (relative) or `-5` (absolute price). */
  spot(change: string | number): Shock {
    return { factor: 'spot', ...parseChange(change, 'shock.spot') };
  },
  /**
   * Volatility move in absolute vol points (`'+10pts'` ⇒ +0.10) or a raw decimal (`0.10`). Percent (`'%'`)
   * vol moves are rejected by the Taylor engine — it has no reference vol to scale against.
   */
  volatility(change: string | number): Shock {
    return { factor: 'volatility', ...parseChange(change, 'shock.volatility') };
  },
  /**
   * Rate move: `'+50bp'` ⇒ +0.005, or a raw `0.005`. Percent (`'%'`) rate moves are rejected by the
   * Taylor engine — it has no reference rate to scale against.
   */
  riskFreeRate(change: string | number): Shock {
    return { factor: 'riskFreeRate', ...parseChange(change, 'shock.riskFreeRate') };
  },
  /** Time decay over `years` (e.g. `1/365` for one day). */
  time(years: number): Shock {
    return { factor: 'time', kind: 'absolute', value: years };
  },
  /**
   * Dividend-yield move: `'+50bp'` ⇒ +0.005, or a raw `0.005`. Drives the first-order carry term
   * `ε·dq`. Percent (`'%'`) dividend moves are rejected by the Taylor engine — it has no reference
   * dividend level to scale against.
   */
  dividend(change: string | number): Shock {
    return { factor: 'dividend', ...parseChange(change, 'shock.dividend') };
  },
  /**
   * A custom named factor shock. Percent (`'%'`) moves resolve only for `'spot'` in the Taylor
   * engine; a custom `reprice` fn receives the raw scenario and may interpret `%` itself.
   */
  factor(name: string, change: string | number): Shock {
    return { factor: name, ...parseChange(change, 'shock.factor') };
  },
};

/** The documented {@link Shock} keys — Law 12: an unknown field must throw, never no-op. */
const SHOCK_KEYS = ['factor', 'kind', 'value'] as const;

/**
 * Build a named scenario from shocks. Each shock is validated at build time (use the `shock.*`
 * constructors — they produce exactly this shape), so a malformed shock fails here with a typed
 * error instead of deep inside the Taylor engine.
 */
export function scenario(name: string, ...shocks: Shock[]): Scenario {
  if (typeof name !== 'string' || name.length === 0) {
    throw new InputError(
      `scenario: name must be a non-empty string — scenario('crash', { factor: 'spot', kind: 'relative', value: -0.2 }). Received ${name === undefined ? 'undefined' : name === null ? 'null' : typeof name}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'name' } },
    );
  }
  shocks.forEach((sh, i) => {
    requireArgumentObject('scenario', `shocks[${i}]`, sh);
    // Law 12: a misspelled shock field (`facor`) must throw, never silently apply a zero move.
    ensureKnownKeys('scenario', `shocks[${i}]`, sh, SHOCK_KEYS);
  });
  return { name, shocks };
}
export interface Scenario {
  name: string;
  shocks: Shock[];
}

/** The documented {@link Scenario} keys — Law 12: an unknown field must throw, never no-op. */
const SCENARIO_KEYS = ['name', 'shocks'] as const;

/**
 * A position's Greeks in TotalFinance's ONE unit system — the units `@insiderfinance/totalfinance/options` and
 * `@insiderfinance/totalfinance/strategy` report (`DEFAULT_GREEK_UNITS`), so a `blackScholesGreeks(...)` /
 * `Position.value().greeks` object spreads straight in: `{ value, spot, ...greeks }`.
 *
 * Per unit of the position (per share of one contract when `Position.multiplier` scales it):
 *   - `delta` per $1 of spot, `gamma` per $1²;
 *   - `theta` per CALENDAR DAY; `vega` per 1 volatility POINT (0.01); `rho` per 1% rate (0.01);
 *     `phi` per 1% dividend yield;
 *   - the second-order Greeks in the options package's own units: `vanna` ∂Δ/∂σ and `vomma` ∂²V/∂σ²
 *     per 1.00 σ, `charm` = ∂Δ/∂T and `veta` = ∂vega/∂T per YEAR of time-to-expiry (vega per 1.00 σ),
 *     `vera` per 1.00 σ per 1.00 rate;
 *   - the rate cross terms the options package does not emit follow the first-order conventions:
 *     `deltaRate` per 1% rate, `thetaRate` per day per 1% rate, `rhoConvexity` per (1%)²,
 *     `thetaConvexity` per day².
 * The Taylor engine converts to the raw per-year / per-1.00 form internally, in one place. Third-order
 * Greeks (`speed`, `color`, `zomma`, `ultima`) and `lambda` are accepted so a whole `ExtendedGreeks`
 * can be passed, and are not used by the second-order expansion.
 */
export interface PositionGreeks {
  /** Current mark value of the position (per unit). */
  value: number;
  /** Reference spot, required to resolve percent spot shocks into price moves. */
  spot?: number;
  /** ∂V/∂S per $1 of spot. */
  delta?: number;
  /** ∂²V/∂S² per $1². */
  gamma?: number;
  /** ∂V/∂σ per 1 volatility point (0.01), as the options package reports it. */
  vega?: number;
  /** ∂V/∂t per CALENDAR DAY (negative for a long option), as the options package reports it. */
  theta?: number;
  /** ∂V/∂r per 1% rate (0.01), as the options package reports it. */
  rho?: number;
  /** ∂²V/∂S∂σ per 1.00 σ per $ — the options package's `vanna`. Optional — omitted ⇒ its term is 0. */
  vanna?: number;
  /** ∂²V/∂σ² per 1.00 σ² — the options package's `vomma`. Optional. */
  vomma?: number;
  /** ∂Δ/∂T per year of time-to-expiry — the options package's `charm` (delta drift as expiry recedes). Optional. */
  charm?: number;
  /** ∂vega/∂T per year of time-to-expiry, vega per 1.00 σ — the options package's `veta`. Optional. */
  veta?: number;
  /** ∂²V/∂σ∂r per 1.00 σ per 1.00 rate — the options package's `vera`. Optional. */
  vera?: number;
  /** ∂²V/∂S∂r per $ per 1% rate — the spot-rate cross (`∂Δ/∂r`). Optional. */
  deltaRate?: number;
  /** ∂²V/∂t∂r per calendar day per 1% rate — the time-rate cross (`∂Θ/∂r`). Optional. */
  thetaRate?: number;
  /** ∂²V/∂r² per (1%)² — rho convexity. Optional. */
  rhoConvexity?: number;
  /** ∂²V/∂t² per calendar day² — theta convexity (theta's own bleed). Optional. */
  thetaConvexity?: number;
  /** φ = ∂V/∂q per 1% dividend yield — the options package's `phi` (dividend rho). Optional. */
  phi?: number;
  /** Accepted from a whole `ExtendedGreeks`; not used by the second-order expansion. */
  speed?: number;
  /** Accepted from a whole `ExtendedGreeks`; not used by the second-order expansion. */
  color?: number;
  /** Accepted from a whole `ExtendedGreeks`; not used by the second-order expansion. */
  zomma?: number;
  /** Accepted from a whole `ExtendedGreeks`; not used by the second-order expansion. */
  ultima?: number;
  /** Accepted from a whole `ExtendedGreeks` (`null` = elasticity undefined); not used by the expansion. */
  lambda?: number | null;
}

/** The documented {@link PositionGreeks} keys — shared by every greeks-taking entry point here. */
const POSITION_GREEKS_KEYS = [
  'value',
  'spot',
  'delta',
  'gamma',
  'vega',
  'theta',
  'rho',
  'vanna',
  'vomma',
  'charm',
  'veta',
  'vera',
  'deltaRate',
  'thetaRate',
  'rhoConvexity',
  'thetaConvexity',
  'phi',
  'speed',
  'color',
  'zomma',
  'ultima',
  'lambda',
] as const;

/** Display → raw conversion factors: the ONE place the unit system meets the Taylor arithmetic. */
const DAYS_PER_YEAR = 365;
const PER_PERCENT = 100;
/** The unit system every Greek-taking entry point here consumes (echoed in reports). */
const GREEK_UNITS = { ...DEFAULT_GREEK_UNITS, phi: 'per1Percent' } as const;

function requirePositionGreeks(
  functionName: string,
  greeks: PositionGreeks,
  policy: 'closed' | 'open' = 'closed',
): void {
  requireArgumentObject(functionName, 'greeks', greeks);
  if (policy === 'closed') ensureKnownKeys(functionName, 'greeks', greeks, POSITION_GREEKS_KEYS);
  ensureFinite(greeks.value, 'greeks.value', functionName);
  for (const field of POSITION_GREEKS_KEYS.slice(1)) {
    const value = greeks[field];
    // `lambda` is declared `number | null` (null = elasticity undefined at zero option value).
    if (field === 'lambda' && value === null) continue;
    if (value !== undefined) ensureFinite(value as number, `greeks.${field}`, functionName);
  }
}

export interface Position<T = unknown> {
  id?: string;
  /** Number of units held (signed). Default 1. */
  quantity?: number;
  /**
   * Contract multiplier applied to per-unit value and Greeks (100 for a listed US equity option
   * whose Greeks are per share and whose `quantity` is in contracts). Default 1. Applied by
   * `aggregateGreeks`, `stressTest` and the book tools; disclosed in their assumptions.
   */
  multiplier?: number;
  greeks?: PositionGreeks;
  /**
   * Current mark per unit — the BASE a custom `reprice` differences against (H11). When `reprice`
   * is supplied, either this or `greeks.value` must be present; the base is never assumed 0.
   */
  value?: number;
  data?: T;
}

export interface PnlAttribution {
  total: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  /** Second-order spot–vol cross term: `vanna·dS·dσ` (0 when `vanna` is absent). */
  vanna: number;
  /** Second-order vol-convexity term: `½·vomma·dσ²` (0 when `vomma` is absent). */
  vomma: number;
  /** Second-order spot–time cross term: `charm·dS·dt` (0 when `charm` is absent). */
  charm: number;
  /** Second-order vol–time cross term: `veta·dσ·dt` (0 when `veta` is absent). */
  veta: number;
  /** Second-order vol–rate cross term: `vera·dσ·dr` (0 when `vera` is absent). */
  vera: number;
  /** Second-order spot–rate cross term: `deltaRate·dS·dr` (0 when `deltaRate` is absent). */
  deltaRate: number;
  /** Second-order time–rate cross term: `thetaRate·dt·dr` (0 when `thetaRate` is absent). */
  thetaRate: number;
  /** Second-order rate-convexity term: `½·rhoConvexity·dr²` (0 when `rhoConvexity` is absent). */
  rhoConvexity: number;
  /** Second-order time-convexity term: `½·thetaConvexity·dt²` (0 when `thetaConvexity` is absent). */
  thetaConvexity: number;
  /** First-order dividend-carry term: `φ·dq` (0 when `phi` is absent). */
  phi: number;
  /** Residual = repriced − value − (the Greek terms); 0 for a pure Taylor reprice. */
  other: number;
}

/** Resolve the absolute moves for each factor present in a scenario. */
function resolveMoves(scenario: Scenario, spot: number | undefined): Record<string, number> {
  const moves: Record<string, number> = {};
  for (const sh of scenario.shocks) {
    let m = sh.value;
    if (sh.kind === 'percent') {
      if (sh.factor === 'spot') {
        if (spot == null) {
          throw new InputError('scenario: a percent spot shock needs the position spot.', {
            code: ErrorCode.InputMissingField,
            context: { factor: 'spot' },
          });
        }
        m = spot * sh.value;
      } else {
        // Only spot carries a reference level here. Silently applying a percent vol/rate shock as an
        // ABSOLUTE move ('+10%' → +0.10 = +10 vol POINTS) would be a 10× lie — refuse and teach.
        throw new InputError(
          `scenario: a percent ${sh.factor} shock needs a reference ${sh.factor} level the Taylor engine doesn't have — use absolute units ('+2pts'/'-3pts' for vol, '+50bp' for rates) or a raw decimal move like 0.02. (A custom reprice fn sees the raw scenario and may resolve '%' itself.)`,
          {
            code: ErrorCode.InputWrongType,
            context: { factor: sh.factor, kind: sh.kind, value: sh.value },
          },
        );
      }
    }
    moves[sh.factor] = (moves[sh.factor] ?? 0) + m;
  }
  return moves;
}

/** The resolved absolute factor moves a scenario applied, in `PnlMove` units. */
interface ResolvedMoves {
  dSpot: number;
  dVolatility: number;
  dRate: number;
  dTimeYears: number;
  dDividendYield: number;
}

/**
 * Shared Greeks-Taylor engine behind `taylorPnl` / `stressTest` / `scenarioGrid` — guards + resolved
 * moves + the BARE attribution. Module-local so each public export controls its own return shape:
 * `taylorPnl` wraps this in the Law 2 report grammar; `stressTest`/`scenarioGrid` stay plain-value.
 */
function taylorPnlKernel(
  greeks: PositionGreeks,
  scenario: Scenario,
  greeksPolicy: 'closed' | 'open' = 'closed',
): { attribution: PnlAttribution; moves: ResolvedMoves } {
  requireScenarioShape('taylorPnl', scenario);
  requirePositionGreeks('taylorPnl', greeks, greeksPolicy);
  ensureKnownKeys('taylorPnl', 'scenario', scenario, SCENARIO_KEYS);
  const moves = resolveMoves(scenario, greeks.spot);
  const dS = moves['spot'] ?? 0;
  const dSig = moves['volatility'] ?? 0;
  const dr = moves['riskFreeRate'] ?? 0;
  const timeStepYears = moves['time'] ?? 0;
  const dq = moves['dividend'] ?? 0;
  // Display units in, raw arithmetic here: theta per DAY → per year, vega/rho/phi per 1% → per 1.00.
  // Moves are absolute decimals (dσ = 0.02 is +2 vol points; dr = 0.005 is +50 bp; dt in years).
  const delta = (greeks.delta ?? 0) * dS;
  const gamma = 0.5 * (greeks.gamma ?? 0) * dS * dS;
  const vega = (greeks.vega ?? 0) * PER_PERCENT * dSig;
  const theta = (greeks.theta ?? 0) * DAYS_PER_YEAR * timeStepYears;
  const rho = (greeks.rho ?? 0) * PER_PERCENT * dr;
  // Second-order cross/curvature terms — the full 2nd-order Taylor in (spot, vol, time, rate), plus
  // the first-order dividend carry. Each is 0 when its greek is absent, so a first-order greek vector
  // reduces to Δ·dS + ½Γ·dS² + Vega·dσ + Θ·dt + Rho·dr. Verified: adding these reduces the residual
  // against a repriced BSM move from O(move²) to O(move³).
  // `charm`/`veta` are the options package's ∂/∂T (time-to-expiry) derivatives; time PASSING is
  // −dT, hence the sign. Both are already per year and per 1.00 σ.
  const vanna = (greeks.vanna ?? 0) * dS * dSig;
  const vomma = 0.5 * (greeks.vomma ?? 0) * dSig * dSig;
  // `+ 0` folds a negative zero (an absent charm negated) into 0 so canonical JSON and in-process
  // results agree.
  const charm = -(greeks.charm ?? 0) * dS * timeStepYears + 0;
  const veta = -(greeks.veta ?? 0) * dSig * timeStepYears + 0;
  const vera = (greeks.vera ?? 0) * dSig * dr;
  const deltaRate = (greeks.deltaRate ?? 0) * PER_PERCENT * dS * dr;
  const thetaRate = (greeks.thetaRate ?? 0) * DAYS_PER_YEAR * PER_PERCENT * timeStepYears * dr;
  const rhoConvexity = 0.5 * (greeks.rhoConvexity ?? 0) * PER_PERCENT * PER_PERCENT * dr * dr;
  const thetaConvexity =
    0.5 *
    (greeks.thetaConvexity ?? 0) *
    DAYS_PER_YEAR *
    DAYS_PER_YEAR *
    timeStepYears *
    timeStepYears;
  const phi = (greeks.phi ?? 0) * PER_PERCENT * dq;
  const total =
    delta +
    gamma +
    vega +
    theta +
    rho +
    vanna +
    vomma +
    charm +
    veta +
    vera +
    deltaRate +
    thetaRate +
    rhoConvexity +
    thetaConvexity +
    phi;
  return {
    attribution: {
      total,
      delta,
      gamma,
      vega,
      theta,
      rho,
      vanna,
      vomma,
      charm,
      veta,
      vera,
      deltaRate,
      thetaRate,
      rhoConvexity,
      thetaConvexity,
      phi,
      other: 0,
    },
    moves: {
      dSpot: dS,
      dVolatility: dSig,
      dRate: dr,
      dTimeYears: timeStepYears,
      dDividendYield: dq,
    },
  };
}

/** {@link taylorPnl}'s report: the attribution inline plus the applied conventions (Law 2). */
export interface TaylorPnlResult extends PnlAttribution {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** Greeks-Taylor P&L of a single position's Greeks under a scenario (per unit). */
export function taylorPnl(greeks: PositionGreeks, scenario: Scenario): TaylorPnlResult {
  requireArgumentObject('taylorPnl', 'scenario', scenario);
  ensureKnownKeys('taylorPnl', 'scenario', scenario, SCENARIO_KEYS);
  if (typeof scenario.name !== 'string') {
    throw new InputError(
      `taylorPnl: scenario.name must be a string — build scenarios with scenario('crash', …). Received ${scenario.name === null ? 'null' : typeof scenario.name}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'scenario.name' } },
    );
  }
  const { attribution, moves } = taylorPnlKernel(greeks, scenario);
  return {
    ...attribution,
    // The RESOLVED absolute moves (dx §2.4): a serialized result stays self-interpreting even when
    // the scenario carried percent shocks that were scaled against the position's spot — and the
    // Greek units the engine consumed, so the report never implies raw per-year inputs.
    ...scenarioReport({ scenario: scenario.name, ...moves, greekUnits: GREEK_UNITS }),
  };
}

export interface PositionScenarioResult {
  id: string;
  quantity: number;
  pnl: number;
  attribution: PnlAttribution;
  /** How this position was revalued under the scenario (H11 disclosure). */
  valuationMethod: 'greeks-taylor' | 'reprice';
}
export interface ScenarioResult {
  scenario: string;
  /** Book P&L summed over positions. */
  pnl: number;
  byPosition: PositionScenarioResult[];
  /** Book-level P&L-explain (sum of position explains). */
  attribution: PnlAttribution;
}

export interface StressOptions<T> {
  /** Custom revaluation: return the position's **new value per unit** under the scenario. Falls back
   *  to the Greeks-Taylor expansion when omitted. */
  reprice?: (position: Position<T>, scenario: Scenario) => number;
}

export interface StressTestInput<T> {
  positions: readonly Position<T>[];
  scenarios: readonly Scenario[];
  options?: StressOptions<T>;
}

/** The documented {@link StressOptions} keys. */
const STRESS_OPTIONS_KEYS = ['reprice'] as const;

const zeroAttribution = (): PnlAttribution => ({
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
  other: 0,
});

/** The H11 report: scenarios + the Law 2 envelope with the book-level valuation summary. */
export interface StressTestResult {
  assumptions: {
    conventionsVersion: string;
    scenarios: number;
    positions: number;
    /** Book-level valuation summary: 'greeks-taylor' | 'reprice' | 'mixed'. */
    valuation: string;
  };
  diagnostics: { warnings: QuantWarning[] };
  scenarios: ScenarioResult[];
}

/** Stress a positions book across scenarios (H11 report): per-scenario and per-position P&L. */
export function stressTest<T = unknown>(input: StressTestInput<T>): StressTestResult {
  requireArgumentObject('stressTest', 'input', input);
  ensureKnownKeys('stressTest', 'input', input, ['positions', 'scenarios', 'options']);
  const { positions, scenarios, options: options = {} } = input;
  requireArgumentArray('stressTest', 'scenarios', scenarios);
  requireArgumentArray('stressTest', 'positions', positions);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('stressTest', 'options', options);
  ensureKnownKeys('stressTest', 'options', options, STRESS_OPTIONS_KEYS);
  const methodsUsed = new Set<string>();
  const rows = scenarios.map((scenario) => {
    const byPosition: PositionScenarioResult[] = [];
    const bookAttribution = zeroAttribution();
    let bookPnl = 0;
    positions.forEach((pos, i) => {
      // Units held × contract multiplier: per-share option Greeks with quantity in contracts.
      const qty = (pos.quantity ?? 1) * (pos.multiplier ?? 1);
      let attribution: PnlAttribution;
      let valuationMethod: 'greeks-taylor' | 'reprice';
      if (options.reprice) {
        // H11: a custom reprice differences against an EXPLICIT current mark — an assumed base of
        // 0 reported the position's whole revalued price as "P&L".
        const base = pos.value ?? pos.greeks?.value;
        if (base === undefined) {
          throw new InputError(
            `stressTest: custom reprice needs the position's current mark — set \`value\` (per unit) or \`greeks.value\` on position ${String(pos.id ?? i)}. The base is never assumed to be 0.`,
            {
              code: ErrorCode.InputMissingField,
              context: { position: pos.id ?? i, field: 'value' },
            },
          );
        }
        const newVal = options.reprice(pos, scenario);
        const perUnit = newVal - base;
        attribution = { ...zeroAttribution(), total: perUnit, other: perUnit };
        valuationMethod = 'reprice';
      } else if (pos.greeks) {
        // The bare kernel — stressTest is plain-value (helper role); only taylorPnl reports.
        attribution = taylorPnlKernel(pos.greeks, scenario).attribution;
        valuationMethod = 'greeks-taylor';
      } else {
        throw new InputError('stressTest: position needs greeks or a reprice function.', {
          code: ErrorCode.InputMissingField,
          context: { position: pos.id ?? i },
        });
      }
      const pnl = attribution.total * qty;
      bookPnl += pnl;
      bookAttribution.delta += attribution.delta * qty;
      bookAttribution.gamma += attribution.gamma * qty;
      bookAttribution.vega += attribution.vega * qty;
      bookAttribution.theta += attribution.theta * qty;
      bookAttribution.rho += attribution.rho * qty;
      bookAttribution.vanna += attribution.vanna * qty;
      bookAttribution.vomma += attribution.vomma * qty;
      bookAttribution.charm += attribution.charm * qty;
      bookAttribution.veta += attribution.veta * qty;
      bookAttribution.vera += attribution.vera * qty;
      bookAttribution.deltaRate += attribution.deltaRate * qty;
      bookAttribution.thetaRate += attribution.thetaRate * qty;
      bookAttribution.rhoConvexity += attribution.rhoConvexity * qty;
      bookAttribution.thetaConvexity += attribution.thetaConvexity * qty;
      bookAttribution.phi += attribution.phi * qty;
      bookAttribution.other += attribution.other * qty;
      bookAttribution.total += pnl;
      methodsUsed.add(valuationMethod);
      byPosition.push({
        id: pos.id ?? String(i),
        quantity: qty,
        pnl,
        attribution,
        valuationMethod,
      });
    });
    return { scenario: scenario.name, pnl: bookPnl, byPosition, attribution: bookAttribution };
  });
  const valuation =
    methodsUsed.size > 1
      ? 'mixed'
      : ([...methodsUsed][0] ?? (options.reprice ? 'reprice' : 'greeks-taylor'));
  return {
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      scenarios: scenarios.length,
      positions: positions.length,
      valuation,
    },
    diagnostics: { warnings: [] },
    scenarios: rows,
  };
}

export interface ScenarioGridInput {
  greeks: PositionGreeks;
  spotShocks: readonly Shock[];
  volatilityShocks: readonly Shock[];
}

/** One resolved axis entry of a {@link ScenarioGridResult} (H12). */
export interface ResolvedGridShock {
  factor: 'spot' | 'volatility';
  kind: ShockKind;
  value: number;
  /** The resolved ABSOLUTE move applied (percent spot shocks scaled by `greeks.spot`). */
  resolvedMove: number;
}

/** The H12 report: both axes with resolved shock semantics + the P&L cells + the Law 2 envelope. */
export interface ScenarioGridResult {
  assumptions: { conventionsVersion: string; greekUnits: typeof GREEK_UNITS };
  diagnostics: { warnings: QuantWarning[] };
  spotAxis: ResolvedGridShock[];
  volatilityAxis: ResolvedGridShock[];
  /** `pnl[i][j]` = P&L per unit at `spotAxis[i]` × `volatilityAxis[j]`. */
  pnl: number[][];
}

/**
 * 2-D scenario grid (H12 report): P&L (per unit) of one position's Greeks across a Cartesian
 * product of spot and vol shocks. A serialized result is self-interpreting — both axes carry
 * their resolved shock semantics beside the cells, so a detached matrix never travels alone.
 */
export function scenarioGrid(input: ScenarioGridInput): ScenarioGridResult {
  requireArgumentObject('scenarioGrid', 'input', input);
  ensureKnownKeys('scenarioGrid', 'input', input, ['greeks', 'spotShocks', 'volatilityShocks']);
  const { greeks, spotShocks, volatilityShocks } = input;
  // PositionGreeks may be a decorated result artifact. The shared engine validates every consumed
  // numeric field while this surface deliberately preserves unrelated metadata.
  requirePositionGreeks('scenarioGrid', greeks, 'open');
  requireArgumentArray('scenarioGrid', 'spotShocks', spotShocks);
  requireArgumentArray('scenarioGrid', 'volatilityShocks', volatilityShocks);
  const pnl = spotShocks.map((s) =>
    volatilityShocks.map(
      (v) => taylorPnlKernel(greeks, { name: 'grid', shocks: [s, v] }, 'open').attribution.total,
    ),
  );
  const resolveAxis = (shocks: readonly Shock[], factor: 'spot' | 'volatility') =>
    shocks.map((shock) => ({
      factor,
      kind: shock.kind,
      value: shock.value,
      resolvedMove: resolveMoves({ name: 'grid', shocks: [shock] }, greeks.spot)[shock.factor] ?? 0,
    }));
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, greekUnits: GREEK_UNITS },
    diagnostics: { warnings: [] },
    spotAxis: resolveAxis(spotShocks, 'spot'),
    volatilityAxis: resolveAxis(volatilityShocks, 'volatility'),
    pnl,
  };
}
