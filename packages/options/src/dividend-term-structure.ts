/**
 * Dividend term structures (spec: `docs/specs/dividend-term-structure.md`, roadmap Tier 2). Unifies the
 * two ways a desk carries dividends — a **discrete cash schedule** (real ex-dates and amounts) and a
 * **continuous yield** `q` (the one number a Black–Scholes engine wants) — into a single per-maturity
 * term structure of the dividend-adjusted forward `F(T)`, the PV of the dividends accruing before `T`,
 * and the **continuous-equivalent yield** `q_eff(T)` that reproduces that forward exactly.
 *
 * EX-DATE CONVENTION: a date-only `exDate` resolves to the US equity market OPEN (09:30
 * America/New_York), while a date-only MATURITY resolves to the 16:00 ET option close — two different
 * events, two different instants (see {@link parseExDateToEpoch}). A zoned datetime is taken as-is.
 *
 * Same escrowed-dividend model as {@link escrowedSpot} (the `0 < τᵢ < T` rule), so `q_eff(T)` is a
 * *lossless* collapse of the schedule at each expiry: pricing with `(S, r, q_eff(T), σ)` returns exactly
 * the escrowed-spot price, because BSM depends on `(S,r,q)` only through the forward. This is the forward
 * direction of the relationship `parity.impliedDividendYield` inverts (recovering `q_eff` from prices).
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type DividendModel,
  type EpochMs,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensurePositive,
  requireArgumentObject,
  ensureKnownKeys,
  resolveValuationAsOf,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { timeToExDateYears, timeToExpiryYears } from './time.js';
import type { DiscreteDividend } from './types.js';

/** Input for {@link dividendTermStructure}. */
export interface DividendTermStructureInput {
  spot: number;
  /** Continuously-compounded risk-free rate (decimal, e.g. `0.045`). */
  riskFreeRate: number;
  /** Continuous dividend yield applied alongside the discrete schedule (decimal); default `0`. */
  dividendYield?: number;
  /** Discrete cash dividends (ISO ex-date + per-share amount). Omitted / empty ⇒ continuous-only. */
  dividends?: DiscreteDividend[];
  /** Valuation date; ex-dates and maturities are measured from here (epoch ms or ISO). Required. */
  asOf: EpochMs | string;
  /** The expiries (ISO dates) to report the term structure at. At least one, each after `asOf`. */
  maturities: string[];
}

/** One expiry's row of the dividend term structure. */
export interface DividendTermStructurePoint {
  /** The maturity (ISO), echoed. */
  maturity: string;
  /** Year fraction from `asOf` (ACT/365F). */
  yearsToExpiry: number;
  /** PV of the discrete dividends accruing strictly before this expiry. */
  dividendPresentValue: number;
  /** How many discrete dividends accrue strictly before this expiry. */
  discreteCount: number;
  /** Dividend-adjusted (escrowed) forward `F(T) = (S − PV)·e^{(r−q)T}`. */
  forward: number;
  /** The discrete schedule expressed as a continuous yield: `−ln(1−PV/S)/T`. */
  discreteEquivalentYield: number;
  /** The single continuous yield that reproduces `F(T)`: `q + discreteEquivalentYield`. */
  impliedContinuousYield: number;
  /** Net cost-of-carry the forward grows at: `r − impliedContinuousYield` (so `F = S·e^{carry·T}`). */
  carry: number;
}

/** The dividend term structure across the requested expiries. */
export interface DividendTermStructure {
  /** One row per requested expiry, sorted ascending by tenor. */
  points: DividendTermStructurePoint[];
  /** PV of every *future* dividend in the schedule (all `τᵢ > 0`), independent of the maturities asked. */
  totalDividendPresentValue: number;
  /** The continuous yield echoed back (`0` when none supplied). */
  continuousYield: number;
  /** One-line, agent-relayable summary. */
  summary: string;
  assumptions: {
    conventionsVersion: string;
    spot: number;
    riskFreeRate: number;
    continuousYield: number;
    dividendModel: DividendModel;
  };
  diagnostics: Diagnostics;
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const money = (x: number): string => x.toFixed(2);

/** A future dividend resolved to its year fraction and present value. */
interface ResolvedDividend {
  tau: number;
  amount: number;
  pv: number;
}

/**
 * Build the dividend term structure — per-expiry forward, dividend PV, and continuous-equivalent yield —
 * from a discrete cash schedule and/or a continuous yield. See `docs/specs/dividend-term-structure.md`.
 */
export function dividendTermStructure(input: DividendTermStructureInput): DividendTermStructure {
  const functionName = 'dividendTermStructure';
  requireArgumentObject(functionName, 'input', input);
  // Law 12 (2026-08-23, fourth review): the input is CLOSED — an unknown key is a typo teaching,
  // never silently ignored.
  ensureKnownKeys(functionName, 'input', input, [
    'spot',
    'riskFreeRate',
    'dividendYield',
    'dividends',
    'asOf',
    'maturities',
  ]);

  ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  const S = input.spot;

  if (typeof input.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: rate (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate' },
    });
  }
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const r = input.riskFreeRate;

  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  // `?? []` would treat an explicit `dividends: null` as an omission — null is a stated value,
  // and a caller who wrote it is told so (2026-08-23 fourth-review enforcement).
  for (const field of ['dividendYield', 'dividends'] as const) {
    if (input[field] === null) {
      throw new InputError(
        `${functionName}: ${field} must not be null — omit the field to take its default.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  ensureFiniteWhenPresent(input.dividendYield, 'dividendYield', functionName);
  const q = input.dividendYield ?? 0;

  const asOfMs = resolveValuationAsOf(input.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);

  if (!Array.isArray(input.maturities) || input.maturities.length === 0) {
    throw new InputError(`${functionName}: at least one maturity (ISO date) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'maturities' },
    });
  }

  // Resolve the discrete schedule: validate amounts (matching escrowedSpot), split future from past.
  const future: ResolvedDividend[] = [];
  let pastCount = 0;
  const rawDividends = input.dividends ?? [];
  if (!Array.isArray(rawDividends)) {
    throw new InputError(`${functionName}: dividends must be an array of { exDate, amount }.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'dividends' },
    });
  }
  for (const div of rawDividends) {
    requireArgumentObject(functionName, 'dividend', div);
    if (!Number.isFinite(div.amount) || div.amount < 0) {
      throw new InputError(
        `${functionName}: dividend amount must be a finite, non-negative number, got ${div.amount}.`,
        { code: ErrorCode.InputOutOfRange, context: { exDate: div.exDate, amount: div.amount } },
      );
    }
    // Ex-dates use the MARKET-OPEN convention (09:30 ET for a date-only label), identical to
    // `escrowedSpot` — the two must agree or `q_eff(T)` would stop reproducing the escrowed price.
    const tau = timeToExDateYears(asOfMs, div.exDate, functionName);
    if (tau > 0) future.push({ tau, amount: div.amount, pv: div.amount * Math.exp(-r * tau) });
    else pastCount++;
  }
  const totalDividendPresentValue = future.reduce((s, d) => s + d.pv, 0);

  // Per-maturity term-structure rows.
  const points: DividendTermStructurePoint[] = [];
  for (const maturity of input.maturities) {
    const T = timeToExpiryYears(asOfMs, maturity, functionName);
    if (!(T > 0)) {
      throw new InputError(
        `${functionName}: maturity ${maturity} is not after asOf (year fraction ${T}).`,
        {
          code: ErrorCode.InputNegativeTime,
          context: { asOf: input.asOf, maturity, T },
        },
      );
    }
    let dividendPresentValue = 0;
    let discreteCount = 0;
    for (const d of future) {
      if (d.tau < T) {
        dividendPresentValue += d.pv;
        discreteCount++;
      }
    }
    // Escrowed spot must stay positive — same contract as escrowedSpot (never emit a NaN forward/yield).
    if (!(dividendPresentValue < S)) {
      throw new InputError(
        `${functionName}: present value of dividends before ${maturity} (${dividendPresentValue}) is not less than the spot (${S}); the escrowed spot would be non-positive.`,
        { code: ErrorCode.InputOutOfRange, context: { maturity, dividendPresentValue, spot: S } },
      );
    }
    const forward = (S - dividendPresentValue) * Math.exp((r - q) * T);
    const discreteEquivalentYield = -Math.log(1 - dividendPresentValue / S) / T;
    const impliedContinuousYield = q + discreteEquivalentYield;
    const carry = r - impliedContinuousYield;
    points.push({
      maturity,
      yearsToExpiry: T,
      dividendPresentValue,
      discreteCount,
      forward,
      discreteEquivalentYield,
      impliedContinuousYield,
      carry,
    });
  }
  points.sort((a, b) => a.yearsToExpiry - b.yearsToExpiry);

  const warnings: QuantWarning[] = [];
  if (pastCount > 0) {
    warnings.push(
      warning(
        WarningCode.OptionsDividendsPast,
        `${functionName}: ${pastCount} dividend${pastCount === 1 ? '' : 's'} with an ex-date on or before asOf ${pastCount === 1 ? 'was' : 'were'} dropped (already paid, so not in any forward).`,
        'info',
        { pastCount },
      ),
    );
  }
  if (future.length === 0) {
    warnings.push(
      warning(
        WarningCode.OptionsDividendsNone,
        q === 0
          ? `${functionName}: no dividends supplied — the forwards are the pure cost-of-carry S·e^{rT} (implied yield 0).`
          : `${functionName}: no discrete dividends supplied — the forwards reflect the continuous yield ${pct(q)} only.`,
        'info',
      ),
    );
  }

  const dividendModel: DividendModel =
    future.length > 0 ? 'discreteSchedule' : q === 0 ? 'none' : 'continuousYield';

  return {
    points,
    totalDividendPresentValue,
    continuousYield: q,
    summary: composeSummary({
      points,
      S,
      totalDividendPresentValue,
      futureCount: future.length,
      q,
    }),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      spot: S,
      riskFreeRate: r,
      continuousYield: q,
      dividendModel,
    },
    diagnostics: {
      engine: 'dividend-term-structure',
      method: 'escrowed-dividend forward + continuous-equivalent yield',
      converged: true,
      warnings,
    },
  };
}

/** Compose the one-line term-structure summary. */
function composeSummary(p: {
  points: DividendTermStructurePoint[];
  S: number;
  totalDividendPresentValue: number;
  futureCount: number;
  q: number;
}): string {
  const first = p.points[0]!;
  const last = p.points[p.points.length - 1]!;
  const n = p.points.length;
  const expiries = `${n} expir${n === 1 ? 'y' : 'ies'}`;
  if (p.futureCount === 0) {
    const carry = p.q === 0 ? 'pure cost-of-carry' : `continuous yield ${pct(p.q)}`;
    return `No discrete dividends — ${expiries} priced off ${carry}; the implied dividend yield is a flat ${pct(p.q)}.`;
  }
  const yieldSpan =
    n === 1
      ? `an implied dividend yield of ${pct(first.impliedContinuousYield)}`
      : `an implied dividend yield of ${pct(first.impliedContinuousYield)} at ${first.yearsToExpiry.toFixed(2)}y and ${pct(last.impliedContinuousYield)} at ${last.yearsToExpiry.toFixed(2)}y`;
  return `${p.futureCount} upcoming dividend${p.futureCount === 1 ? '' : 's'} worth ${money(p.totalDividendPresentValue)} PV on a ${money(p.S)} spot — across ${expiries}, ${yieldSpan}.`;
}
