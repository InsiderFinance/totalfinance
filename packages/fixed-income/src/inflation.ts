/**
 * Inflation analytics (spec: `docs/specs/inflation.md`, roadmap Tier 2): the three tools an inflation
 * desk reaches for, composing the existing linker machinery rather than adding a model.
 *
 *   - `tipsIndexRatio`    — the US-Treasury reference-CPI daily interpolation + index ratio (the number
 *                           that uplifts a TIPS's principal/coupons; the mechanic `bonds.inflationLinked`
 *                           consumes via `referenceIndex`).
 *   - `breakevenInflation`— nominal − real breakeven (arithmetic + exact Fisher), with the standard
 *                           premium decomposition into expected inflation.
 *   - `cpiSeasonality`    — the 12 multiplicative seasonal factors of an NSA CPI history via the classic
 *                           ratio-to-2×12-moving-average.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  parseIsoDate,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import { daysInMonth } from './conventions.js';

const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Shift a (year, 1-indexed month) by `delta` months → 'YYYY-MM'. */
function shiftMonthKey(year: number, month: number, delta: number): string {
  const total = year * 12 + (month - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------
// 1. TIPS index ratio
// ---------------------------------------------------------------------------------------------------

/** Input for {@link tipsIndexRatio}. */
export interface TipsIndexRatioInput {
  /** The date the index ratio is for (ISO). */
  settlementDate: string;
  /** NSA CPI by month `'YYYY-MM'` → level; must cover the 3-month-lag window of every date used. */
  cpi: Record<string, number>;
  /** The dated-date reference CPI (indexation base) — supply this OR `datedDate`, exactly one. */
  baseReferenceCpi?: number;
  /** The bond's dated date; its reference CPI (interpolated from `cpi`) becomes the base. */
  datedDate?: string;
}

/** The reference CPI and index ratio for a settlement date. */
export interface TipsIndexRatioResult {
  settlementDate: string;
  /** Interpolated reference CPI (raw). */
  referenceCpi: number;
  /** Reference CPI rounded to the Treasury's 5 decimals. */
  referenceCpiRounded: number;
  baseReferenceCpi: number;
  /** `referenceCpi / baseReferenceCpi` (raw). */
  indexRatio: number;
  /** Index ratio rounded to 5 decimals (the official ratio). */
  indexRatioRounded: number;
  /** CPI three months prior (`CPI₋₃`) and its month. */
  lagMonth3: string;
  lagMonth3Cpi: number;
  /** CPI two months prior (`CPI₋₂`) and its month. */
  lagMonth2: string;
  lagMonth2Cpi: number;
  /** `indexRatio − 1`. */
  inflationSinceBase: number;
  assumptions: { conventionsVersion: string; lagMonths: 3; interpolation: 'daily-linear' };
  diagnostics: Diagnostics;
}

/** The interpolated 3-month-lagged reference CPI for a date + the two months it blended. */
function interpolatedRefCpi(
  date: string,
  cpi: Record<string, number>,
  functionName: string,
): { ref: number; m3: string; c3: number; m2: string; c2: number } {
  const { year, month, day } = parseIsoDate(date);
  const m3 = shiftMonthKey(year, month, -3);
  const m2 = shiftMonthKey(year, month, -2);
  const c3 = cpi[m3];
  const c2 = cpi[m2];
  for (const [key, val] of [
    [m3, c3],
    [m2, c2],
  ] as const) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      throw new InputError(
        `${functionName}: CPI for ${key} (needed for the 3-month lag of ${date}) is missing or non-positive.`,
        { code: ErrorCode.InputMissingField, context: { date, month: key, value: val } },
      );
    }
  }
  // The loop above guarantees both are finite positive numbers; assert for the type-checker.
  const cpi3 = c3 as number;
  const cpi2 = c2 as number;
  const D = daysInMonth(year, month); // the SETTLEMENT month's day count
  const ref = cpi3 + ((day - 1) / D) * (cpi2 - cpi3);
  return { ref, m3, c3: cpi3, m2, c2: cpi2 };
}

/**
 * The TIPS reference CPI and index ratio for a settlement date: the 3-month-lagged NSA CPI, linearly
 * interpolated by day across the settlement month, over the dated-date base. See `docs/specs/inflation.md`.
 */
export function tipsIndexRatio(input: TipsIndexRatioInput): TipsIndexRatioResult {
  const functionName = 'tipsIndexRatio';
  requireArgumentObject(functionName, 'input', input);
  requireArgumentObject(functionName, 'cpi', input.cpi);
  if (typeof input.settlementDate !== 'string') {
    throw new InputError(`${functionName}: settlementDate (an ISO date string) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'settlementDate' },
    });
  }
  const hasBase = input.baseReferenceCpi !== undefined;
  const hasDated = input.datedDate !== undefined;
  if (hasBase === hasDated) {
    throw new InputError(`${functionName}: supply exactly one of baseReferenceCpi or datedDate.`, {
      code: ErrorCode.InputMissingField,
      context: { baseReferenceCpi: input.baseReferenceCpi, datedDate: input.datedDate },
    });
  }

  const settle = interpolatedRefCpi(input.settlementDate, input.cpi, functionName);
  let base: number;
  if (hasBase) {
    ensurePositive(input.baseReferenceCpi as number, 'baseReferenceCpi', functionName);
    base = input.baseReferenceCpi as number;
  } else {
    base = interpolatedRefCpi(input.datedDate as string, input.cpi, functionName).ref;
  }

  const indexRatio = settle.ref / base;
  return {
    settlementDate: input.settlementDate,
    referenceCpi: settle.ref,
    referenceCpiRounded: round5(settle.ref),
    baseReferenceCpi: base,
    indexRatio,
    indexRatioRounded: round5(indexRatio),
    lagMonth3: settle.m3,
    lagMonth3Cpi: settle.c3,
    lagMonth2: settle.m2,
    lagMonth2Cpi: settle.c2,
    inflationSinceBase: indexRatio - 1,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      lagMonths: 3,
      interpolation: 'daily-linear',
    },
    diagnostics: {
      engine: 'tips-index-ratio',
      method: '3-month-lag daily-linear',
      converged: true,
      warnings: [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// 2. Breakeven inflation
// ---------------------------------------------------------------------------------------------------

/** Input for {@link breakevenInflation}. */
export interface BreakevenInflationInput {
  /** Nominal bond yield (decimal, annualized). */
  nominalYield: number;
  /** Real (TIPS) yield (decimal, annualized). */
  realYield: number;
  /** Inflation risk premium (decimal); lifts the breakeven above expected inflation. */
  inflationRiskPremium?: number;
  /** TIPS liquidity premium (decimal); illiquidity depresses the real yield, lifting the breakeven. */
  liquidityPremium?: number;
}

/** {@link BreakevenInflationInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const BREAKEVEN_INFLATION_INPUT_KEYS = [
  'nominalYield',
  'realYield',
  'inflationRiskPremium',
  'liquidityPremium',
] as const;

/** The breakeven inflation rate and its decomposition. */
export interface BreakevenInflationResult {
  /** Arithmetic breakeven: `nominalYield − realYield` (the quoted number). */
  breakeven: number;
  /** Exact Fisher-compounded breakeven: `(1+nominal)/(1+real) − 1`. */
  breakevenCompounded: number;
  /** `breakeven − inflationRiskPremium + liquidityPremium`, or `null` when no premia are supplied. */
  expectedInflation: number | null;
  nominalYield: number;
  realYield: number;
  assumptions: { conventionsVersion: string; method: 'fisher' };
  diagnostics: Diagnostics;
}

/**
 * The breakeven inflation rate implied by a nominal and a real (TIPS) yield — arithmetic and exact
 * Fisher-compounded — with the standard premium decomposition. See `docs/specs/inflation.md`.
 */
export function breakevenInflation(input: BreakevenInflationInput): BreakevenInflationResult {
  const functionName = 'breakevenInflation';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, BREAKEVEN_INFLATION_INPUT_KEYS);
  ensureFinite(input.nominalYield, 'nominalYield', functionName);
  ensureFinite(input.realYield, 'realYield', functionName);
  if (!(1 + input.realYield > 0)) {
    throw new InputError(
      `${functionName}: realYield ${input.realYield} implies a non-positive gross (1 + realYield); the compounded breakeven is undefined.`,
      { code: ErrorCode.InputOutOfRange, context: { realYield: input.realYield } },
    );
  }

  const breakeven = input.nominalYield - input.realYield;
  const breakevenCompounded = (1 + input.nominalYield) / (1 + input.realYield) - 1;

  let expectedInflation: number | null = null;
  const warnings: QuantWarning[] = [];
  if (input.inflationRiskPremium !== undefined || input.liquidityPremium !== undefined) {
    ensureFiniteWhenPresent(input.inflationRiskPremium, 'inflationRiskPremium', functionName);
    ensureFiniteWhenPresent(input.liquidityPremium, 'liquidityPremium', functionName);
    const risk = input.inflationRiskPremium ?? 0;
    const liq = input.liquidityPremium ?? 0;
    expectedInflation = breakeven - risk + liq;
  }

  return {
    breakeven,
    breakevenCompounded,
    expectedInflation,
    nominalYield: input.nominalYield,
    realYield: input.realYield,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method: 'fisher' },
    diagnostics: {
      engine: 'breakeven-inflation',
      method: 'fisher',
      converged: true,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// 3. CPI seasonality
// ---------------------------------------------------------------------------------------------------

/** Input for {@link cpiSeasonality}. */
export interface CpiSeasonalityInput {
  /** NSA CPI history: `{ month: 'YYYY-MM', level }`; ≥ 24 contiguous months (order-independent). */
  series: Array<{ month: string; level: number }>;
}

/** {@link CpiSeasonalityInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const CPI_SEASONALITY_INPUT_KEYS = ['series'] as const;

/** Keys of one `series` observation (Law 12). */
const CPI_POINT_KEYS = ['month', 'level'] as const;

/** The extracted monthly seasonal factors. */
export interface CpiSeasonalityResult {
  /** 12 multiplicative factors, index 0 = January … 11 = December; they average to 1. */
  factors: number[];
  /** Calendar month (1-12) with the largest factor. */
  peakMonth: number;
  /** Calendar month (1-12) with the smallest factor. */
  troughMonth: number;
  /** Number of month observations that fed the estimate (ratios computed). */
  monthsUsed: number;
  /** Calendar years the history spans. */
  yearsSpanned: number;
  assumptions: { conventionsVersion: string; method: 'ratio-to-2x12-moving-average' };
  diagnostics: Diagnostics;
}

/** Parse and validate a 'YYYY-MM' key → month index `year*12 + (month-1)`. */
function monthIndex(key: string, functionName: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) {
    throw new InputError(`${functionName}: month "${key}" must be 'YYYY-MM'.`, {
      code: ErrorCode.InputWrongType,
      context: { month: key },
    });
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new InputError(`${functionName}: month "${key}" has an out-of-range month component.`, {
      code: ErrorCode.InputOutOfRange,
      context: { month: key },
    });
  }
  return Number(m[1]) * 12 + (month - 1);
}

/**
 * Extract 12 multiplicative CPI seasonal factors from an NSA history via the classic ratio-to-centered-
 * 2×12-moving-average, normalized to average 1. See `docs/specs/inflation.md`.
 */
export function cpiSeasonality(input: CpiSeasonalityInput): CpiSeasonalityResult {
  const functionName = 'cpiSeasonality';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, CPI_SEASONALITY_INPUT_KEYS);
  if (!Array.isArray(input.series) || input.series.length < 24) {
    throw new InputError(
      `${functionName}: series must be an array of ≥ 24 contiguous monthly CPI levels.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { length: Array.isArray(input.series) ? input.series.length : null },
      },
    );
  }

  // Sort by month, validate levels, and confirm contiguity (no gaps or duplicates).
  const sorted = input.series
    .map((p, i) => {
      requireArgumentObject(functionName, `series[${i}]`, p);
      ensureKnownKeys(functionName, `series[${i}]`, p, CPI_POINT_KEYS);
      ensurePositive(p.level, `series[${i}].level`, functionName);
      return { idx: monthIndex(p.month, functionName), month: p.month, level: p.level };
    })
    .sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.idx !== sorted[i - 1]!.idx + 1) {
      throw new InputError(
        `${functionName}: the monthly series has a gap or duplicate around ${sorted[i - 1]!.month} → ${sorted[i]!.month}.`,
        { code: ErrorCode.InputOutOfRange, context: { at: sorted[i]!.month } },
      );
    }
  }

  const x = sorted.map((s) => s.level);
  const n = x.length;
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  for (let t = 6; t < n - 6; t++) {
    let s = 0.5 * x[t - 6]! + 0.5 * x[t + 6]!;
    for (let j = -5; j <= 5; j++) s += x[t + j]!;
    const cma = s / 12;
    const calMonth = ((sorted[t]!.idx % 12) + 12) % 12; // 0 = Jan
    buckets[calMonth]!.push(x[t]! / cma);
  }

  const raw = buckets.map((b, m) => {
    if (b.length === 0) {
      throw new InputError(`${functionName}: calendar month ${m + 1} has no usable observation.`, {
        code: ErrorCode.InputOutOfRange,
        context: { month: m + 1 },
      });
    }
    return b.reduce((a, v) => a + v, 0) / b.length;
  });
  const mean = raw.reduce((a, v) => a + v, 0) / 12;
  const factors = raw.map((f) => f / mean); // normalize so the 12 factors average 1

  let peakMonth = 1;
  let troughMonth = 1;
  for (let m = 0; m < 12; m++) {
    if (factors[m]! > factors[peakMonth - 1]!) peakMonth = m + 1;
    if (factors[m]! < factors[troughMonth - 1]!) troughMonth = m + 1;
  }

  const warnings: QuantWarning[] = [];
  if (n < 36) {
    warnings.push(
      warning(
        'fixedIncome.seasonality_short_history',
        `${functionName}: only ${n} months (< 3 years) of history — the seasonal factors are noisy; use ≥ 36 months for a stable estimate.`,
        'warn',
        { months: n },
      ),
    );
  }

  return {
    factors,
    peakMonth,
    troughMonth,
    monthsUsed: n - 12,
    yearsSpanned: n / 12,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'ratio-to-2x12-moving-average',
    },
    diagnostics: {
      engine: 'cpi-seasonality',
      method: 'ratio-to-2x12-moving-average',
      converged: true,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// 4. Zero-coupon inflation swap (ZCIS)
// ---------------------------------------------------------------------------------------------------

/** Input for {@link zeroCouponInflationSwap}. */
export interface ZeroCouponInflationSwapInput {
  /** Swap maturity in years (`N`). The single ZCIS cashflow is exchanged at maturity. */
  maturityYears: number;
  /**
   * The par/market ZCIS rate `K` (the geometric annual breakeven). Supply **this or**
   * `forwardIndexRatio` — exactly one.
   */
  swapRate?: number;
  /**
   * The forward index ratio `I(T)/I(0)`. Supply **this or** `swapRate` — exactly one. Implies
   * `swapRate = forwardIndexRatio^(1/N) − 1`.
   */
  forwardIndexRatio?: number;
  /** An existing position's contracted fixed rate `K_c` — supply to value the swap (MTM). */
  contractRate?: number;
  /** Discount factor to maturity for the MTM (default `1` → the undiscounted at-maturity value). */
  discountFactor?: number;
  /** Notional (default `1`). */
  notional?: number;
  /** Which leg the holder **pays** (default `'fixed'` = pay fixed, receive inflation). Signs the MTM. */
  payer?: 'fixed' | 'inflation';
}

/** {@link ZeroCouponInflationSwapInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const ZCIS_INPUT_KEYS = [
  'maturityYears',
  'swapRate',
  'forwardIndexRatio',
  'contractRate',
  'discountFactor',
  'notional',
  'payer',
] as const;

/** The economics of a zero-coupon inflation swap. */
export interface ZeroCouponInflationSwapResult {
  /** Par ZCIS rate (geometric annual breakeven): `forwardIndexRatio^(1/N) − 1`. */
  parRate: number;
  /** Forward index ratio `I(T)/I(0) = (1 + parRate)^N`. */
  forwardIndexRatio: number;
  /**
   * The single fixed-leg payoff per unit notional at maturity: `(1 + parRate)^N − 1`. Equals the
   * expected inflation-leg payoff (they match at par).
   */
  fixedLeg: number;
  /**
   * Mark-to-market PV of a position at `contractRate` (present only when `contractRate` is supplied):
   * `±notional·DF·[(1+parRate)^N − (1+contractRate)^N]`, signed by `payer`. `null` otherwise.
   */
  markToMarket: number | null;
  assumptions: { conventionsVersion: string; method: 'zero-coupon-inflation-swap' };
  diagnostics: Diagnostics;
}

/**
 * A **zero-coupon inflation swap** (ZCIS) — the standard inflation-market instrument. At maturity the
 * inflation leg pays `I(T)/I(0) − 1` and the fixed leg pays `(1+K)^N − 1`; the par rate `K` is set so the
 * two match, i.e. `(1+K)^N = I(T)/I(0)`, so the par ZCIS rate **is** the geometric breakeven inflation.
 * Supply the market rate or the forward index ratio (each implies the other); supply a `contractRate` to
 * mark an existing position: `MTM = ±notional·DF·[(1+parRate)^N − (1+contractRate)^N]`. Deterministic
 * (forward-measure) — no inflation-vol model. See `docs/specs/inflation.md`.
 */
export function zeroCouponInflationSwap(
  input: ZeroCouponInflationSwapInput,
): ZeroCouponInflationSwapResult {
  const functionName = 'zeroCouponInflationSwap';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ZCIS_INPUT_KEYS);
  ensurePositive(input.maturityYears, 'maturityYears', functionName);
  const N = input.maturityYears;

  const hasRate = input.swapRate !== undefined;
  const hasRatio = input.forwardIndexRatio !== undefined;
  if (hasRate === hasRatio) {
    throw new InputError(
      `${functionName}: supply exactly one of swapRate or forwardIndexRatio (got ${hasRate && hasRatio ? 'both' : 'neither'}).`,
      { code: ErrorCode.InputMissingField, context: { hasRate, hasRatio } },
    );
  }

  let parRate: number;
  let forwardIndexRatio: number;
  if (hasRate) {
    ensureFinite(input.swapRate!, 'swapRate', functionName);
    if (!(1 + input.swapRate! > 0)) {
      throw new InputError(
        `${functionName}: swapRate ${input.swapRate} implies a non-positive gross (1 + swapRate); the forward index ratio is undefined.`,
        { code: ErrorCode.InputOutOfRange, context: { swapRate: input.swapRate } },
      );
    }
    parRate = input.swapRate!;
    forwardIndexRatio = Math.pow(1 + parRate, N);
  } else {
    ensurePositive(input.forwardIndexRatio!, 'forwardIndexRatio', functionName);
    forwardIndexRatio = input.forwardIndexRatio!;
    parRate = Math.pow(forwardIndexRatio, 1 / N) - 1;
  }
  const fixedLeg = forwardIndexRatio - 1; // (1 + parRate)^N − 1

  let markToMarket: number | null = null;
  if (input.contractRate !== undefined) {
    ensureFinite(input.contractRate, 'contractRate', functionName);
    if (!(1 + input.contractRate > 0)) {
      throw new InputError(
        `${functionName}: contractRate ${input.contractRate} implies a non-positive gross (1 + contractRate).`,
        { code: ErrorCode.InputOutOfRange, context: { contractRate: input.contractRate } },
      );
    }
    ensureFiniteWhenPresent(input.discountFactor, 'discountFactor', functionName);
    ensureFiniteWhenPresent(input.notional, 'notional', functionName);
    if (input.payer !== undefined && input.payer !== 'fixed' && input.payer !== 'inflation') {
      throw new InputError(
        `${functionName}: payer must be 'fixed' | 'inflation' when provided. Received ${input.payer === null ? 'null' : JSON.stringify(input.payer)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'payer' } },
      );
    }
    const df = input.discountFactor ?? 1;
    ensurePositive(df, 'discountFactor', functionName);
    const notional = input.notional ?? 1;
    ensurePositive(notional, 'notional', functionName);
    const payer = input.payer ?? 'fixed';
    if (payer !== 'fixed' && payer !== 'inflation') {
      throw new InputError(
        `${functionName}: payer must be 'fixed' or 'inflation'; got ${String(payer)}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { payer },
        },
      );
    }
    // Pay-fixed / receive-inflation benefits when realized inflation beats the contract rate.
    const sign = payer === 'fixed' ? 1 : -1;
    markToMarket = sign * notional * df * (forwardIndexRatio - Math.pow(1 + input.contractRate, N));
  }

  return {
    parRate,
    forwardIndexRatio,
    fixedLeg,
    markToMarket,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method: 'zero-coupon-inflation-swap' },
    diagnostics: {
      engine: 'zero-coupon-inflation-swap',
      method: 'forward-measure',
      converged: true,
      warnings: [],
    },
  };
}
