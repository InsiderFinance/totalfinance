/**
 * Strategy scanner / optimizer (spec §12, product review §1). Enumerate the classic defined-risk
 * option structures over a strike grid, score each with the existing closed-form probability/payoff
 * metrics (probability of profit, expected value, max profit/loss, return-on-risk, a bid/ask liquidity
 * score), filter, and rank by a chosen objective. Pure and clock-free: it prices any missing leg
 * premiums off an explicit `volatility`/`smile` via Black–Scholes and takes an injected valuation date.
 *
 * The scanner reuses the same `Position` engine a hand-built strategy uses, so a ranked candidate's
 * metrics are identical to constructing that structure directly — this is a search over structures,
 * not a second pricing path.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  optionExpiryToMs,
  resolveValuationAsOf,
  yearFraction,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  bearCallSpread,
  bearPutSpread,
  bullCallSpread,
  bullPutSpread,
  ironCondor,
} from './builders.js';
import { legs } from './legs.js';
import { Position, rewardToRisk } from './position.js';
import type { Leg } from './types.js';

/** The structures the scanner can enumerate (all single-expiry, defined-risk or long-premium). */
export type ScanStructure =
  | 'bullCallSpread'
  | 'bearCallSpread'
  | 'bullPutSpread'
  | 'bearPutSpread'
  | 'ironCondor'
  | 'ironButterfly'
  | 'longCallButterfly'
  | 'longPutButterfly'
  | 'straddle'
  | 'strangle';

const ALL_STRUCTURES: ScanStructure[] = [
  'bullCallSpread',
  'bearCallSpread',
  'bullPutSpread',
  'bearPutSpread',
  'ironCondor',
  'ironButterfly',
  'longCallButterfly',
  'longPutButterfly',
  'straddle',
  'strangle',
];

/** One strike's market data. `call`/`put` are mid premiums; bid/ask feed the liquidity score. */
export interface ScanQuoteRow {
  strike: number;
  /** Call mid premium. If omitted, priced from `volatility`/`smile` via Black–Scholes. */
  call?: number;
  /** Put mid premium. If omitted, priced from `volatility`/`smile` via Black–Scholes. */
  put?: number;
  callBid?: number;
  callAsk?: number;
  putBid?: number;
  putAsk?: number;
}

/**
 * Every ranking objective a scan accepts, as DATA — the single source the type, the runtime guard and
 * the error message are all derived from.
 *
 * RV11 — these were three copies: a hand-written union here, a hand-written array in `optimizer.ts`,
 * and a third hand-written list inside the error string. The string copy drifted and kept teaching
 * `pop|ev` after both were renamed, because plain prose is invisible to a rename of the quoted
 * literals. One tuple, and `.join(', ')` for the message, is what makes that impossible rather than
 * merely fixed.
 *
 * `'return'` became `'returnOnRisk'` in the same pass: it ranked by `returnOnRisk` and the candidate
 * output already called that number `returnOnRisk`, so one quantity carried two public names.
 */
export const SCAN_OBJECTIVES = [
  'probabilityOfProfit',
  'expectedValue',
  'returnOnRisk',
  'expectedValuePerRisk',
] as const;

/** Ranking objective; `expectedValuePerRisk` (expected value ÷ max loss) is the default. */
export type ScanObjective = (typeof SCAN_OBJECTIVES)[number];

export interface ScanOptions {
  /** Underlying spot price (WS3.2: renamed from `underlyingPrice` for workspace consistency). */
  spot: number;
  /**
   * Valuation instant. Epoch ms or a zoned ISO datetime, resolved at the boundary by core's
   * `resolveValuationAsOf` — the ONE valuation-instant grammar shared by `Position.probability()`,
   * the what-if cube and every other pricing boundary. A bare date is refused: a 0DTE's value
   * depends on the time of day.
   */
  asOf: EpochMs | string;
  /** Option expiry (`YYYY-MM-DD` → 16:00 ET, or a full datetime). */
  expiry: string;
  riskFreeRate: number;
  dividendYield?: number;
  /** The option chain — one row per strike, ascending or not (sorted internally). */
  chain: ScanQuoteRow[];
  /** Constant annualized volatility used for probabilityOfProfit / expectedValue scoring and to price any missing premiums. */
  volatility?: number;
  /**
   * Per-strike implied-volatility smile. Used to price any missing per-strike premiums (takes
   * precedence over `volatility`). **Scoring uses a SINGLE volatility:** `probabilityOfProfit` and
   * `expectedValue` are computed closed-form at the at-spot volatility `smile(spot)` (or
   * `volatility`), not the full smile — for smile-consistent probabilities, price a specific structure
   * with `Position.monteCarloProbability({ localVolatility })`.
   */
  smile?: (strike: number) => number;
  /** Which structures to enumerate (default: all). */
  structures?: ScanStructure[];
  /** Cap on the width (strike distance) of any single wing/spread, in price units. */
  maxWidth?: number;
  /** Keep only candidates with probability-of-profit ≥ this. */
  minProbabilityOfProfit?: number;
  /** Keep only candidates whose max loss ≤ this (in the position's P&L units — per contract, 100×). */
  maxRisk?: number;
  /** Ranking objective (default `expectedValuePerRisk`). */
  rankBy?: ScanObjective;
  /** Return only the top-N ranked candidates (default 25). */
  top?: number;
}

/** {@link ScanOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const SCAN_OPTIONS_KEYS = [
  'spot',
  'asOf',
  'expiry',
  'riskFreeRate',
  'dividendYield',
  'chain',
  'volatility',
  'smile',
  'structures',
  'maxWidth',
  'minProbabilityOfProfit',
  'maxRisk',
  'rankBy',
  'top',
] as const;

export interface ScanCandidate {
  structure: ScanStructure;
  /** The structure's strikes, ascending. */
  strikes: number[];
  /** Net debit (> 0 paid) or credit (< 0 received), PER CONTRACT (multiplier-scaled, 100×) — the
   * same units as `maxProfit`/`maxLoss`/`expectedValue` and `Position.netDebit()`. */
  netDebit: number;
  /** Max profit / max loss / expected value are per contract (100× multiplier, as in `Position`). */
  maxProfit: number | null;
  maxLoss: number | null;
  /** Whether each tail of the expiration payoff is bounded (a `null` bound above is unbounded). */
  bounded: { profit: boolean; loss: boolean };
  breakevens: number[];
  probabilityOfProfit: number;
  expectedValue: number;
  /**
   * `|maxProfit / maxLoss|` — the same definition as `Position.probability().riskReward` — or
   * `null` when undefined (an unbounded side or a zero max loss). Never `Infinity` (B3).
   */
  returnOnRisk: number | null;
  /** `expectedValue / |maxLoss|` — a risk-normalized EV; 0 when risk is unbounded. */
  expectedValuePerRisk: number;
  /** Liquidity in `[0, 1]` from the legs' relative bid/ask spreads (1 = tight), null if unpriced. */
  liquidity: number | null;
  /** The value of the ranking objective for this candidate; `null` when the objective is undefined for it. */
  score: number | null;
  /**
   * The resolved legs (premiums included, whatever their source), so every candidate is
   * MATERIALIZABLE (WS7.3): `strategy(candidate.legs)` reconstructs the exact position for charting or
   * mark-to-market, and `strategy(candidate.legs).metrics()` reproduces the reported payoff metrics.
   */
  legs: Leg[];
}

interface Priced {
  strike: number;
  call: number;
  put: number;
  /** Relative bid/ask spread of the call/put, or null when bid/ask is unavailable. */
  callRelSpread: number | null;
  putRelSpread: number | null;
}

/**
 * The scan report (Law 2 report grammar): the ranked candidates plus the applied conventions
 * (`assumptions`) and a warnings channel (`diagnostics`).
 */
export interface ScanResult {
  /** The top-N candidates by the ranking objective, descending, each fully metric'd. */
  candidates: ScanCandidate[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    dayCount: 'ACT/365F';
    /** The ranking objective that produced the order (and each candidate's `score`). */
    rankBy: ScanObjective;
    /** The structures that were enumerated. */
    structures: ScanStructure[];
    /** Year fraction to the scanned expiry. */
    timeToExpiryYears: number;
    /** The single at-spot volatility that `probabilityOfProfit`/`expectedValue` are scored at (see the `smile` doc). */
    scoringVolatility: number;
  };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: Diagnostics;
}

/**
 * Enumerate, score, and rank option structures over a strike grid. `candidates` carries the top-N
 * by the chosen objective, each with the full payoff/probability metrics.
 */
export function scanStrategies(options: ScanOptions): ScanResult {
  requireArgumentObject('scanStrategies', 'options', options as never);
  const functionName = 'scanStrategies';
  // Law 12: a misspelled knob (`rankby`) must teach, never silently rank by the default.
  ensureKnownKeys(functionName, 'options', options, SCAN_OPTIONS_KEYS);
  // When-present ladders before any coalesce (the 350c2796 ruling): a null rankBy silently
  // ranked by the default objective, and a null structures scanned everything.
  for (const field of ['dividendYield', 'minProbabilityOfProfit', 'top'] as const) {
    ensureFiniteWhenPresent(
      (options as unknown as Record<string, unknown>)[field],
      field,
      functionName,
    );
  }
  if (
    options.rankBy !== undefined &&
    !(SCAN_OBJECTIVES as readonly string[]).includes(options.rankBy as string)
  ) {
    throw new InputError(
      `${functionName}: rankBy must be one of ${SCAN_OBJECTIVES.join(' | ')} when provided. Received ${options.rankBy === null ? 'null' : JSON.stringify(options.rankBy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'rankBy', received: options.rankBy } },
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
  // Container guards first (the first-touch law): a missing/non-array `chain` or a null/primitive
  // row would otherwise crash below with a raw TypeError (`.length`, iteration, `.strike` in the
  // sort comparator) instead of teaching the ScanQuoteRow shape.
  requireArgumentArray(functionName, 'chain', options.chain);
  for (let i = 0; i < options.chain.length; i++) {
    const row: unknown = options.chain[i];
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof (row as { strike?: unknown }).strike !== 'number'
    ) {
      throw new InputError(
        `${functionName}: chain[${i}] must be a ScanQuoteRow object with a numeric strike ` +
          `({ strike, call?, put?, callBid?, callAsk?, putBid?, putAsk? }), got ${JSON.stringify(
            row,
          )}.`,
        { code: ErrorCode.InputWrongType, context: { index: i, received: row } },
      );
    }
  }
  ensurePositive(options.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  // Resolve once via core's shared valuation-instant door (epoch ms or a zoned datetime; a bare
  // date is refused with the fix), then require the resolved instant to be finite.
  const asOfMs = resolveValuationAsOf(options.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  const q = options.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  if (options.chain.length < 2) {
    throw new InputError(`${functionName}: chain needs at least 2 strikes.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: options.chain.length },
    });
  }
  const t = yearFraction(asOfMs, optionExpiryToMs(options.expiry), 'ACT/365F');
  ensurePositive(t, 'timeToExpiryYears', functionName);
  if (options.volatility !== undefined)
    ensurePositive(
      options.volatility,
      'volatility',
      functionName,
      ErrorCode.InputNegativeVolatility,
    );
  const top = options.top ?? 25;
  // Safe integer (2026-08-23 review, P0): `top` only ranks and slices the candidates the chain
  // itself generated — no loop runs off it — but above 2^53 it is no longer an exact count.
  if (!Number.isSafeInteger(top) || top < 1) {
    throw new InputError(`${functionName}: top must be a positive integer, got ${top}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { top },
    });
  }
  const rankBy = options.rankBy ?? 'expectedValuePerRisk';
  if (!(SCAN_OBJECTIVES as readonly string[]).includes(rankBy)) {
    throw new InputError(
      `${functionName}: rankBy must be one of ${SCAN_OBJECTIVES.join(', ')}; got "${rankBy}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { rankBy },
      },
    );
  }
  // Filter knobs: an out-of-range/NaN threshold would silently drop or keep the wrong candidates.
  if (
    options.minProbabilityOfProfit !== undefined &&
    !(options.minProbabilityOfProfit >= 0 && options.minProbabilityOfProfit <= 1)
  ) {
    throw new InputError(
      `${functionName}: minProbabilityOfProfit must be within [0, 1], got ${options.minProbabilityOfProfit}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { minProbabilityOfProfit: options.minProbabilityOfProfit },
      },
    );
  }
  if (
    options.maxRisk !== undefined &&
    !(Number.isFinite(options.maxRisk) && options.maxRisk >= 0)
  ) {
    throw new InputError(
      `${functionName}: maxRisk must be finite and ≥ 0, got ${options.maxRisk}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxRisk: options.maxRisk },
      },
    );
  }
  if (options.maxWidth !== undefined && !(options.maxWidth > 0)) {
    throw new InputError(
      `${functionName}: maxWidth must be > 0 when supplied, got ${options.maxWidth}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxWidth: options.maxWidth },
      },
    );
  }
  const S = options.spot;
  const r = options.riskFreeRate;

  // Per-strike implied volatility, used to price any missing premiums. (Scoring uses a single
  // volatility, at-spot `volatilityAt(S)` — see the `smile` doc; not a per-strike probability measure.)
  const volatilityAt = (strike: number): number => {
    const v = options.smile ? options.smile(strike) : options.volatility;
    if (v === undefined || !Number.isFinite(v) || v <= 0) {
      throw new InputError(
        `${functionName}: no finite positive volatility for strike ${strike}; supply row premiums, a volatility, or a smile.`,
        { code: ErrorCode.InputNegativeVolatility, context: { strike, volatility: v } },
      );
    }
    return v;
  };
  const relSpread = (bid?: number, ask?: number): number | null => {
    if (bid === undefined || ask === undefined) return null;
    const mid = (bid + ask) / 2;
    if (!(mid > 0) || ask < bid) return null;
    return (ask - bid) / mid;
  };

  const rows: Priced[] = [...options.chain]
    .sort((a, b) => a.strike - b.strike)
    .map((row) => {
      ensurePositive(row.strike, 'strike', functionName);
      const call =
        row.call ??
        blackScholesPrice({
          type: 'call',
          spot: S,
          strike: row.strike,
          timeToExpiryYears: t,
          riskFreeRate: r,
          dividendYield: q,
          volatility: volatilityAt(row.strike),
        });
      const put =
        row.put ??
        blackScholesPrice({
          type: 'put',
          spot: S,
          strike: row.strike,
          timeToExpiryYears: t,
          riskFreeRate: r,
          dividendYield: q,
          volatility: volatilityAt(row.strike),
        });
      if (!(call >= 0) || !(put >= 0)) {
        throw new InputError(`${functionName}: negative premium at strike ${row.strike}.`, {
          code: ErrorCode.InputOutOfRange,
          context: { strike: row.strike, call, put },
        });
      }
      return {
        strike: row.strike,
        call,
        put,
        callRelSpread: relSpread(row.callBid, row.callAsk),
        putRelSpread: relSpread(row.putBid, row.putAsk),
      };
    });
  const width = options.maxWidth ?? Infinity;
  // Reject an unknown structure name (e.g. a config/UI typo) rather than silently returning nothing.
  if (options.structures) {
    for (const s of options.structures) {
      if (!ALL_STRUCTURES.includes(s)) {
        throw new InputError(
          `${functionName}: unknown structure "${s}"; expected one of ${ALL_STRUCTURES.join(', ')}.`,
          { code: ErrorCode.InputInvalidEnum, context: { structure: s } },
        );
      }
    }
  }
  const wanted = new Set(options.structures ?? ALL_STRUCTURES);
  const atmVolatility = volatilityAt(S);

  const out: ScanCandidate[] = [];
  const consider = (
    structure: ScanStructure,
    position: Position,
    ks: number[],
    legLiquidity: (number | null)[],
  ): void => {
    const m = position.metrics();
    const prob = position.probability({
      spot: S,
      asOf: asOfMs,
      expiry: options.expiry,
      volatility: atmVolatility,
      riskFreeRate: r,
      ...(options.dividendYield !== undefined ? { dividendYield: q } : {}),
    });
    // An unbounded loss is no risk figure at all: it is filtered by `maxRisk` (nothing is under a
    // cap it cannot be measured against) and scores zero EV-per-risk, as documented.
    const risk = m.maxLoss === null ? null : Math.abs(m.maxLoss);
    const returnOnRisk = rewardToRisk(m).ratio;
    const expectedValuePerRisk = risk !== null && risk > 0 ? prob.expectedValue / risk : 0;
    // Liquidity = 1 − mean relative spread across the legs, clamped to [0, 1]; null if any leg unpriced.
    const spreadVals = legLiquidity.filter((x): x is number => x !== null);
    const liquidity =
      spreadVals.length === legLiquidity.length
        ? Math.max(0, 1 - spreadVals.reduce((s, x) => s + x, 0) / spreadVals.length)
        : null;

    if (
      options.minProbabilityOfProfit !== undefined &&
      prob.probabilityOfProfit < options.minProbabilityOfProfit
    )
      return;
    if (options.maxRisk !== undefined && (risk === null || risk > options.maxRisk)) return;

    const scoreOf = (): number | null => {
      switch (rankBy) {
        case 'probabilityOfProfit':
          return prob.probabilityOfProfit;
        case 'expectedValue':
          return prob.expectedValue;
        case 'returnOnRisk':
          return returnOnRisk;
        default:
          return expectedValuePerRisk;
      }
    };
    out.push({
      structure,
      strikes: ks,
      netDebit: m.netDebit,
      maxProfit: m.maxProfit,
      maxLoss: m.maxLoss,
      bounded: m.bounded,
      breakevens: m.breakevens,
      probabilityOfProfit: prob.probabilityOfProfit,
      expectedValue: prob.expectedValue,
      returnOnRisk,
      expectedValuePerRisk,
      liquidity,
      score: scoreOf(),
      legs: [...position.legs],
    });
  };

  // ---- vertical spreads: every ascending (lo, hi) pair within maxWidth ----
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const lo = rows[i]!;
      const hi = rows[j]!;
      if (hi.strike - lo.strike > width) break;
      const ks = [lo.strike, hi.strike];
      if (wanted.has('bullCallSpread')) {
        consider(
          'bullCallSpread',
          bullCallSpread({
            long: { strike: lo.strike, premium: lo.call },
            short: { strike: hi.strike, premium: hi.call },
          }),
          ks,
          [lo.callRelSpread, hi.callRelSpread],
        );
      }
      if (wanted.has('bearCallSpread')) {
        consider(
          'bearCallSpread',
          bearCallSpread({
            long: { strike: hi.strike, premium: hi.call },
            short: { strike: lo.strike, premium: lo.call },
          }),
          ks,
          [lo.callRelSpread, hi.callRelSpread],
        );
      }
      if (wanted.has('bullPutSpread')) {
        consider(
          'bullPutSpread',
          bullPutSpread({
            long: { strike: lo.strike, premium: lo.put },
            short: { strike: hi.strike, premium: hi.put },
          }),
          ks,
          [lo.putRelSpread, hi.putRelSpread],
        );
      }
      if (wanted.has('bearPutSpread')) {
        consider(
          'bearPutSpread',
          bearPutSpread({
            long: { strike: hi.strike, premium: hi.put },
            short: { strike: lo.strike, premium: lo.put },
          }),
          ks,
          [lo.putRelSpread, hi.putRelSpread],
        );
      }
    }
  }

  // ---- iron condors: short put < short call straddling spot, one-strike wings within maxWidth ----
  if (wanted.has('ironCondor')) {
    for (let ps = 0; ps < rows.length; ps++) {
      const putShort = rows[ps]!;
      if (putShort.strike >= S) break; // short put below spot
      const putLong = rows[ps - 1];
      if (!putLong || putShort.strike - putLong.strike > width) continue;
      for (let cs = ps + 1; cs < rows.length; cs++) {
        const callShort = rows[cs]!;
        if (callShort.strike <= S) continue; // short call above spot
        const callLong = rows[cs + 1];
        if (!callLong || callLong.strike - callShort.strike > width) continue;
        consider(
          'ironCondor',
          ironCondor({
            putLong: { strike: putLong.strike, premium: putLong.put },
            putShort: { strike: putShort.strike, premium: putShort.put },
            callShort: { strike: callShort.strike, premium: callShort.call },
            callLong: { strike: callLong.strike, premium: callLong.call },
          }),
          [putLong.strike, putShort.strike, callShort.strike, callLong.strike],
          [
            putLong.putRelSpread,
            putShort.putRelSpread,
            callShort.callRelSpread,
            callLong.callRelSpread,
          ],
        );
      }
    }
  }

  // ---- iron butterfly: short straddle at a center strike, long wings ±w within maxWidth ----
  if (wanted.has('ironButterfly')) {
    for (let c = 0; c < rows.length; c++) {
      const center = rows[c]!;
      for (let w = 1; c - w >= 0 && c + w < rows.length; w++) {
        const lo = rows[c - w]!;
        const hi = rows[c + w]!;
        if (center.strike - lo.strike > width || hi.strike - center.strike > width) break;
        const position = new Position([
          legs.put({ strike: lo.strike, premium: lo.put, quantity: 1 }),
          legs.put({ strike: center.strike, premium: center.put, quantity: -1 }),
          legs.call({ strike: center.strike, premium: center.call, quantity: -1 }),
          legs.call({ strike: hi.strike, premium: hi.call, quantity: 1 }),
        ]);
        consider(
          'ironButterfly',
          position,
          [lo.strike, center.strike, hi.strike],
          [lo.putRelSpread, center.putRelSpread, center.callRelSpread, hi.callRelSpread],
        );
      }
    }
  }

  // ---- long call/put butterflies: equally-spaced k1<k2<k3, long wings / short 2× body ----
  for (let c = 0; c < rows.length; c++) {
    for (let w = 1; c - w >= 0 && c + w < rows.length; w++) {
      const lo = rows[c - w]!;
      const mid = rows[c]!;
      const hi = rows[c + w]!;
      // Require (near-)equal spacing so the body is centered — the textbook butterfly.
      if (Math.abs(mid.strike - lo.strike - (hi.strike - mid.strike)) > 1e-9) continue;
      if (mid.strike - lo.strike > width) break;
      const ks = [lo.strike, mid.strike, hi.strike];
      if (wanted.has('longCallButterfly')) {
        consider(
          'longCallButterfly',
          new Position([
            legs.call({ strike: lo.strike, premium: lo.call, quantity: 1 }),
            legs.call({ strike: mid.strike, premium: mid.call, quantity: -2 }),
            legs.call({ strike: hi.strike, premium: hi.call, quantity: 1 }),
          ]),
          ks,
          [lo.callRelSpread, mid.callRelSpread, hi.callRelSpread],
        );
      }
      if (wanted.has('longPutButterfly')) {
        consider(
          'longPutButterfly',
          new Position([
            legs.put({ strike: lo.strike, premium: lo.put, quantity: 1 }),
            legs.put({ strike: mid.strike, premium: mid.put, quantity: -2 }),
            legs.put({ strike: hi.strike, premium: hi.put, quantity: 1 }),
          ]),
          ks,
          [lo.putRelSpread, mid.putRelSpread, hi.putRelSpread],
        );
      }
    }
  }

  // ---- long straddle (one strike) and long strangle (put strike < call strike) ----
  if (wanted.has('straddle')) {
    for (const row of rows) {
      consider(
        'straddle',
        new Position([
          legs.call({ strike: row.strike, premium: row.call, quantity: 1 }),
          legs.put({ strike: row.strike, premium: row.put, quantity: 1 }),
        ]),
        [row.strike],
        [row.callRelSpread, row.putRelSpread],
      );
    }
  }
  if (wanted.has('strangle')) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const putK = rows[i]!;
        const callK = rows[j]!;
        if (callK.strike - putK.strike > width) break;
        consider(
          'strangle',
          new Position([
            legs.put({ strike: putK.strike, premium: putK.put, quantity: 1 }),
            legs.call({ strike: callK.strike, premium: callK.call, quantity: 1 }),
          ]),
          [putK.strike, callK.strike],
          [putK.putRelSpread, callK.callRelSpread],
        );
      }
    }
  }

  // Rank by the objective (descending); an undefined (`null`) or NaN score sinks to the bottom —
  // a ratio that does not exist is never "the best".
  const rankOf = (score: number | null): number =>
    score !== null && Number.isFinite(score) ? score : -Infinity;
  out.sort((a, b) => rankOf(b.score) - rankOf(a.score));
  return {
    candidates: out.slice(0, top),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      rankBy,
      structures: [...wanted],
      timeToExpiryYears: t,
      scoringVolatility: atmVolatility,
    },
    diagnostics: {
      engine: 'strategy-scanner',
      method: 'closed-form enumeration',
      converged: true,
      warnings: [],
    },
  };
}
