/**
 * Crypto perpetual & futures carry analytics (spec: `docs/specs/crypto-carry.md`).
 *
 * Five deterministic, no-arbitrage-grounded functions that turn raw crypto quotes into annualized,
 * comparable carry numbers:
 *   • `perpetualFunding`        — a funding rate → its annualized (simple + compounded) cost-of-carry;
 *   • `futuresBasis`       — a dated future → basis, implied carry, and the cash-and-carry edge;
 *   • `predictedFunding`   — the venue (Binance-style) next-interval funding formula;
 *   • `fundingBasisSpread` — the perp-vs-future no-arbitrage carry spread (a cross-instrument signal);
 *   • `optionsBasisSpread` — the put-call-parity synthetic forward vs the dated future (options-vs-future carry).
 *
 * The perp's annualized funding, the future's annualized basis, AND the options market's put-call-parity
 * forward are the SAME number in equilibrium — all equal the carry `r − q` — so their spreads, and the gap
 * to actual financing, are tradeable signals. All outputs are exact identities over the inputs;
 * browser-safe; depends only on `@insiderfinance/totalfinance/core`.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type QuantWarning,
  ErrorCode,
  InputError,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  requireArgumentObject,
  finalizeResult,
  warning,
  type Computed,
} from '@totalfinance/core';

/** Hours in a 365-day year — the annualization base for funding intervals. */
const HOURS_PER_YEAR = 365 * 24;

/**
 * |rate| above which a financing/discount rate is almost certainly a unit mistake (1000%/yr). Crypto
 * carry genuinely runs hot — a squeezed perp can annualize past 100%/yr — so the threshold sits far
 * above anything a real quote produces, and the warning is `info`: it flags, it never blocks.
 */
const IMPLAUSIBLE_RATE = 10;

/**
 * Flag an implausible annualized rate BEFORE it compounds into `e^{r·t}`. Reuses the registered
 * `input.suspicious_risk_free_rate` code — the same footgun (a percent typed as a decimal), the
 * same family a consumer already branches on.
 */
function implausibleRateWarning(
  functionName: string,
  field: string,
  rate: number,
): QuantWarning | undefined {
  if (!Number.isFinite(rate) || Math.abs(rate) <= IMPLAUSIBLE_RATE) return undefined;
  return warning(
    WarningCode.SuspiciousRiskFreeRate,
    `${functionName}: ${field}=${rate} implies ${(rate * 100).toFixed(0)}%/yr — rates here are annualized decimals (0.05 = 5%); did you mean ${(rate / 100).toFixed(4)}? At this magnitude e^{rate·t} overflows and the result is refused (Law 7).`,
    'info',
    { [field]: rate },
  );
}

function assumptions(engine: string): Assumptions {
  return { conventionsVersion: CONVENTIONS_VERSION, dayCount: 'ACT/365F', model: 'carry', engine };
}

function diagnostics(engine: string, warnings: QuantWarning[]): Diagnostics {
  return { engine, method: 'closed-form', converged: true, warnings };
}

// ── perpetualFunding ───────────────────────────────────────────────────────────────

/** Input for {@link perpetualFunding}. */
export interface PerpetualFundingInput {
  /** Perpetual mark price. */
  markPrice: number;
  /** Index (spot) price. */
  indexPrice: number;
  /** Realized funding for the interval (fraction; 0.0001 = 0.01 %). Longs pay shorts when positive. */
  fundingRate: number;
  /** Funding interval in hours. Default 8. */
  intervalHours?: number;
  /** |annualized| above which the funding is flagged extreme. Default 1 (100 %/yr). */
  extremeAnnualized?: number;
}

/** The annualized carry a funding rate implies. */
export interface PerpetualFunding {
  /** `markPrice/indexPrice − 1`. */
  premium: number;
  fundingRate: number;
  intervalHours: number;
  periodsPerYear: number;
  /** `fundingRate · periodsPerYear` — the perp's implied cost-of-carry `r − q`. */
  annualizedSimple: number;
  /**
   * `(1 + fundingRate)^periodsPerYear − 1`. `null` when `fundingRate <= −1` (−100% or worse per
   * interval): fractional compounding of a non-positive base is mathematically undefined —
   * disclosed via a `crypto.compounding_undefined` warning, never NaN (Law 7).
   */
  annualizedCompounded: number | null;
  /** Carry of a LONG perp — `−annualizedSimple` (a long pays funding when it is positive). */
  longCarry: number;
  /** Carry of a SHORT perp — `+annualizedSimple`. */
  shortCarry: number;
}

/** EXACT {@link PerpetualFundingInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const PERP_FUNDING_KEYS = [
  'markPrice',
  'indexPrice',
  'fundingRate',
  'intervalHours',
  'extremeAnnualized',
] as const;

/**
 * Annualize a perpetual funding rate into its implied cost-of-carry, in both simple and compounded terms,
 * with the long/short carry sign made explicit. See `docs/specs/crypto-carry.md`.
 */
export function perpetualFunding(input: PerpetualFundingInput): Computed<PerpetualFunding> {
  const functionName = 'perpetualFunding';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, PERP_FUNDING_KEYS);
  ensurePositive(input.markPrice, 'markPrice', functionName);
  ensurePositive(input.indexPrice, 'indexPrice', functionName);
  ensureFinite(input.fundingRate, 'fundingRate', functionName);
  if (
    input.intervalHours !== undefined &&
    (typeof input.intervalHours !== 'number' || !Number.isFinite(input.intervalHours))
  ) {
    throw new InputError(
      `perpetualFunding: intervalHours must be a finite number when provided. Received ${input.intervalHours === null ? 'null' : typeof input.intervalHours}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'intervalHours' } },
    );
  }
  const intervalHours = input.intervalHours ?? 8;
  ensurePositive(intervalHours, 'intervalHours', functionName);
  if (
    input.extremeAnnualized !== undefined &&
    (typeof input.extremeAnnualized !== 'number' || !Number.isFinite(input.extremeAnnualized))
  ) {
    throw new InputError(
      `perpetualFunding: extremeAnnualized must be a finite number when provided. Received ${input.extremeAnnualized === null ? 'null' : typeof input.extremeAnnualized}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'extremeAnnualized' } },
    );
  }
  const extremeAnnualized = input.extremeAnnualized ?? 1;
  ensurePositive(extremeAnnualized, 'extremeAnnualized', functionName);

  const premium = input.markPrice / input.indexPrice - 1;
  const periodsPerYear = HOURS_PER_YEAR / intervalHours;
  const annualizedSimple = input.fundingRate * periodsPerYear;
  for (const [field, value] of [
    ['premium', premium],
    ['periodsPerYear', periodsPerYear],
    ['annualizedSimple', annualizedSimple],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new InputError(
        `${functionName}: ${field} is outside the representable numeric range for these inputs.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field, value: String(value) },
        },
      );
    }
  }
  // (1 + f)^n is undefined for f <= −1 with fractional n (negative base to a non-integer power →
  // NaN). A funding rate at/under −100% per interval is disclosed, never silently compounded.
  const compoundable = 1 + input.fundingRate > 0;
  const compounded = compoundable ? Math.pow(1 + input.fundingRate, periodsPerYear) - 1 : NaN;
  const compoundedOverflow = compoundable && !Number.isFinite(compounded);
  const annualizedCompounded = compoundable && !compoundedOverflow ? compounded : null;

  const warnings: QuantWarning[] = [];
  if (!compoundable) {
    warnings.push(
      warning(
        WarningCode.CompoundingUndefined,
        `perpetualFunding: fundingRate=${input.fundingRate} is at or below −100% per interval — ` +
          'fractional compounding is undefined, so annualizedCompounded is null (annualizedSimple remains exact).',
        'warn',
        { fundingRate: input.fundingRate, periodsPerYear },
      ),
    );
  }
  if (compoundedOverflow) {
    warnings.push(
      warning(
        WarningCode.CompoundingOverflow,
        `perpetualFunding: compounded annualization exceeds the representable numeric range — annualizedCompounded is null (annualizedSimple remains exact).`,
        'warn',
        { fundingRate: input.fundingRate, periodsPerYear },
      ),
    );
  }
  if (Math.abs(annualizedSimple) > extremeAnnualized) {
    warnings.push(
      warning(
        WarningCode.CryptoExtremeFunding,
        `perpetualFunding: annualized funding ${(annualizedSimple * 100).toFixed(1)}% exceeds the extreme threshold ${(extremeAnnualized * 100).toFixed(0)}% — a crowded/one-sided perp.`,
        'warn',
        { annualizedSimple, intervalHours },
      ),
    );
  }

  return finalizeResult(functionName, {
    value: {
      premium,
      fundingRate: input.fundingRate,
      intervalHours,
      periodsPerYear,
      annualizedSimple,
      annualizedCompounded,
      longCarry: -annualizedSimple,
      shortCarry: annualizedSimple,
    },
    assumptions: assumptions('perp-funding'),
    diagnostics: diagnostics('perp-funding', warnings),
  });
}

// ── futuresBasis ──────────────────────────────────────────────────────────────

/** Whether a dated future trades above (contango) or below (backwardation) spot. */
export type BasisStructure = 'contango' | 'backwardation' | 'flat';

/** Input for {@link futuresBasis}. */
export interface FuturesBasisInput {
  /** Index (spot) price. */
  spot: number;
  /** Dated-future price. */
  future: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Quote financing rate — supply to enable `fairFuture`/`richness`/`carryArbitrage`. */
  financingRate?: number;
  /** Coin (base) yield. Default 0. */
  coinYield?: number;
  /** |carryArbitrage| above which a cash-and-carry arbitrage is flagged. Default 0.05 (5 %/yr). */
  arbitrageThreshold?: number;
}

/** A dated future's basis and (when financing is given) its cash-and-carry edge. */
export interface FuturesBasis {
  /** `future − spot`. */
  basis: number;
  /** `future/spot − 1`. */
  basisFraction: number;
  /** `basisPct / t` — simple annualization. */
  annualizedSimple: number;
  /** `ln(future/spot) / t` — the continuously-compounded implied carry `r − q`. */
  annualizedLog: number;
  structure: BasisStructure;
  /** `spot · e^{(r−q)·t}` — present only when `financingRate` is supplied. */
  fairFuture?: number;
  /** `future − fairFuture` — the riskless profit at expiry (per unit) of short-future + carry-spot. */
  richness?: number;
  /** `annualizedLog − (r − q)` — annualized excess of long-spot / short-future over financing. */
  carryArbitrage?: number;
}

/**
 * Decompose a dated future's basis into absolute, percentage, and annualized (simple + log) carry, label
 * the term structure, and — when a financing rate is supplied — surface the no-arbitrage future and the
 * cash-and-carry edge. See `docs/specs/crypto-carry.md`.
 */
/** EXACT {@link FuturesBasisInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const FUTURES_BASIS_KEYS = [
  'spot',
  'future',
  'timeToExpiryYears',
  'financingRate',
  'coinYield',
  'arbitrageThreshold',
] as const;

export function futuresBasis(input: FuturesBasisInput): Computed<FuturesBasis> {
  const functionName = 'futuresBasis';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, FUTURES_BASIS_KEYS);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.future, 'future', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  if (
    input.arbitrageThreshold !== undefined &&
    (typeof input.arbitrageThreshold !== 'number' || !Number.isFinite(input.arbitrageThreshold))
  ) {
    throw new InputError(
      `futuresBasis: arbitrageThreshold must be a finite number when provided. Received ${input.arbitrageThreshold === null ? 'null' : typeof input.arbitrageThreshold}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'arbitrageThreshold' } },
    );
  }
  const arbitrageThreshold = input.arbitrageThreshold ?? 0.05;
  ensureNonNegative(arbitrageThreshold, 'arbitrageThreshold', functionName);

  const basis = input.future - input.spot;
  const basisFraction = input.future / input.spot - 1;
  const annualizedSimple = basisFraction / input.timeToExpiryYears;
  const annualizedLog = Math.log(input.future / input.spot) / input.timeToExpiryYears;
  const structure: BasisStructure =
    Math.abs(basisFraction) < 1e-12 ? 'flat' : basis > 0 ? 'contango' : 'backwardation';

  const warnings: QuantWarning[] = [];
  const payload: FuturesBasis = {
    basis,
    basisFraction,
    annualizedSimple,
    annualizedLog,
    structure,
  };

  if (input.financingRate !== undefined) {
    ensureFinite(input.financingRate, 'financingRate', functionName);
    if (
      input.coinYield !== undefined &&
      (typeof input.coinYield !== 'number' || !Number.isFinite(input.coinYield))
    ) {
      throw new InputError(
        `futuresBasis: coinYield must be a finite number when provided. Received ${input.coinYield === null ? 'null' : typeof input.coinYield}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'coinYield' } },
      );
    }
    const q = input.coinYield ?? 0;
    ensureFinite(q, 'coinYield', functionName);
    for (const [field, rate] of [
      ['financingRate', input.financingRate],
      ['coinYield', q],
    ] as const) {
      const w = implausibleRateWarning(functionName, field, rate);
      if (w !== undefined) warnings.push(w);
    }
    const carry = input.financingRate - q;
    const fairFuture = input.spot * Math.exp(carry * input.timeToExpiryYears);
    const carryArbitrage = annualizedLog - carry;
    payload.fairFuture = fairFuture;
    payload.richness = input.future - fairFuture;
    payload.carryArbitrage = carryArbitrage;
    if (Math.abs(carryArbitrage) > arbitrageThreshold) {
      warnings.push(
        warning(
          WarningCode.CryptoCarryArbitrage,
          `futuresBasis: the cash-and-carry edge ${(carryArbitrage * 100).toFixed(2)}%/yr exceeds ${(arbitrageThreshold * 100).toFixed(0)}%/yr — ${carryArbitrage > 0 ? 'long-spot / short-future' : 'short-spot / long-future'} captures it net of financing.`,
          'warn',
          { carryArbitrage, financingRate: input.financingRate, coinYield: q },
        ),
      );
    }
  }

  return finalizeResult(functionName, {
    value: payload,
    assumptions: assumptions('futures-basis'),
    diagnostics: diagnostics('futures-basis', warnings),
  });
}

// ── predictedFunding ──────────────────────────────────────────────────────────

/** Input for {@link predictedFunding}. */
export interface PredictedFundingInput {
  /** Premium index — the TWAP of `(perp − index)/index` over the interval. */
  premium: number;
  /** Interest-rate component per interval (quote − base). Default 0. */
  interestRate?: number;
  /** Clamp half-width applied to the interest component. Default 0.0005 (Binance). */
  clamp?: number;
  /** Optional hard cap on |funding|. */
  cap?: number;
}

/** The venue-formula next-interval funding. */
export interface PredictedFunding {
  /** `premium + clamp(interestRate − premium, −clamp, +clamp)`, then capped to `±cap`. */
  fundingRate: number;
  premium: number;
  interestRate: number;
  clamp: number;
  /** Whether the hard `cap` bound the result. */
  capped: boolean;
}

/**
 * The exchange (Binance-style) next-interval funding rate from the premium index and an interest-rate
 * component: `premium + clamp(interest − premium, −clamp, clamp)`, optionally hard-capped. When the
 * premium is small the funding equals the interest rate; when the premium dominates it tracks the premium
 * (minus the clamp). See `docs/specs/crypto-carry.md`.
 */
/** EXACT {@link PredictedFundingInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const PREDICTED_FUNDING_KEYS = ['premium', 'interestRate', 'clamp', 'cap'] as const;

export function predictedFunding(input: PredictedFundingInput): Computed<PredictedFunding> {
  const functionName = 'predictedFunding';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, PREDICTED_FUNDING_KEYS);
  ensureFinite(input.premium, 'premium', functionName);
  if (
    input.interestRate !== undefined &&
    (typeof input.interestRate !== 'number' || !Number.isFinite(input.interestRate))
  ) {
    throw new InputError(
      `predictedFunding: interestRate must be a finite number when provided. Received ${input.interestRate === null ? 'null' : typeof input.interestRate}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'interestRate' } },
    );
  }
  const interestRate = input.interestRate ?? 0;
  ensureFinite(interestRate, 'interestRate', functionName);
  if (
    input.clamp !== undefined &&
    (typeof input.clamp !== 'number' || !Number.isFinite(input.clamp))
  ) {
    throw new InputError(
      `predictedFunding: clamp must be a finite number when provided. Received ${input.clamp === null ? 'null' : typeof input.clamp}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'clamp' } },
    );
  }
  const clamp = input.clamp ?? 0.0005;
  ensureNonNegative(clamp, 'clamp', functionName);

  const component = Math.max(-clamp, Math.min(clamp, interestRate - input.premium));
  const raw = input.premium + component;

  let fundingRate = raw;
  let capped = false;
  if (input.cap !== undefined) {
    ensureNonNegative(input.cap, 'cap', functionName);
    const bounded = Math.max(-input.cap, Math.min(input.cap, raw));
    capped = bounded !== raw;
    fundingRate = bounded;
  }

  return finalizeResult(functionName, {
    value: {
      fundingRate,
      premium: input.premium,
      interestRate,
      clamp,
      capped,
    },
    assumptions: assumptions('predicted-funding'),
    diagnostics: diagnostics('predicted-funding', []),
  });
}

// ── fundingBasisSpread ──────────────────────────────────────────────────────────

/** Which instrument prices richer carry. */
export type CarrySignal = 'future-rich' | 'perpetual-rich' | 'aligned';

/** Input for {@link fundingBasisSpread}. */
export interface FundingBasisSpreadInput {
  /** Perp funding for the interval. */
  fundingRate: number;
  /** Funding interval in hours. Default 8. */
  intervalHours?: number;
  /** Index (spot) price. */
  spot: number;
  /** Dated-future price on the same underlying. */
  future: number;
  /** Future's time to expiry in years. */
  timeToExpiryYears: number;
  /** |spread| below which the two are 'aligned'. Default 0.005 (0.5 %/yr). */
  tolerance?: number;
}

/** The perp-vs-future carry spread and its signal. */
export interface FundingBasisSpread {
  /** The perp's annualized funding (`fundingRate · periodsPerYear`). */
  fundingImpliedCarry: number;
  /** The future's annualized log-basis (`ln(future/spot)/t`). */
  basisImpliedCarry: number;
  /** `basisImpliedCarry − fundingImpliedCarry`. */
  spread: number;
  signal: CarrySignal;
}

/**
 * The no-arbitrage spread between a perpetual's funding-implied carry and a dated future's basis-implied
 * carry on the same underlying. `future-rich` ⇒ long perp / short future harvests the spread; `perp-rich`
 * is the reverse. See `docs/specs/crypto-carry.md`.
 */
/** EXACT {@link FundingBasisSpreadInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const FUNDING_BASIS_SPREAD_KEYS = [
  'fundingRate',
  'intervalHours',
  'spot',
  'future',
  'timeToExpiryYears',
  'tolerance',
] as const;

export function fundingBasisSpread(input: FundingBasisSpreadInput): Computed<FundingBasisSpread> {
  const functionName = 'fundingBasisSpread';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, FUNDING_BASIS_SPREAD_KEYS);
  ensureFinite(input.fundingRate, 'fundingRate', functionName);
  if (
    input.intervalHours !== undefined &&
    (typeof input.intervalHours !== 'number' || !Number.isFinite(input.intervalHours))
  ) {
    throw new InputError(
      `fundingBasisSpread: intervalHours must be a finite number when provided. Received ${input.intervalHours === null ? 'null' : typeof input.intervalHours}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'intervalHours' } },
    );
  }
  const intervalHours = input.intervalHours ?? 8;
  ensurePositive(intervalHours, 'intervalHours', functionName);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.future, 'future', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  if (
    input.tolerance !== undefined &&
    (typeof input.tolerance !== 'number' || !Number.isFinite(input.tolerance))
  ) {
    throw new InputError(
      `fundingBasisSpread: tolerance must be a finite number when provided. Received ${input.tolerance === null ? 'null' : typeof input.tolerance}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'tolerance' } },
    );
  }
  const tolerance = input.tolerance ?? 0.005;
  ensureNonNegative(tolerance, 'tolerance', functionName);

  const fundingImpliedCarry = input.fundingRate * (HOURS_PER_YEAR / intervalHours);
  const basisImpliedCarry = Math.log(input.future / input.spot) / input.timeToExpiryYears;
  const spread = basisImpliedCarry - fundingImpliedCarry;
  const signal: CarrySignal =
    spread > tolerance ? 'future-rich' : spread < -tolerance ? 'perpetual-rich' : 'aligned';

  return finalizeResult(functionName, {
    value: {
      fundingImpliedCarry,
      basisImpliedCarry,
      spread,
      signal,
    },
    assumptions: assumptions('funding-basis-spread'),
    diagnostics: diagnostics('funding-basis-spread', []),
  });
}

// ── optionsBasisSpread ──────────────────────────────────────────────────────────

/** Which market prices the richer forward: the dated future, the options-implied synthetic, or neither. */
export type OptionsCarrySignal = 'future-rich' | 'options-rich' | 'aligned';

/** Input for {@link optionsBasisSpread}. */
export interface OptionsBasisSpreadInput {
  /** Index (spot) price. */
  spot: number;
  /** The strike at which the European call & put are quoted (the parity strike). */
  strike: number;
  /** European call price at `strike`/expiry, in USD (same numéraire as `spot`/`put`). */
  call: number;
  /** European put price at `strike`/expiry, in USD. */
  put: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Continuously-compounded financing/discount rate used to un-discount the parity gap. */
  riskFreeRate: number;
  /** Observed dated-future price on the same underlying/expiry. */
  future: number;
  /** |spread| below which the two forwards are 'aligned'. Default 0.005 (0.5 %/yr). */
  tolerance?: number;
}

/** The options-implied (put-call-parity) synthetic forward reconciled against the dated future. */
export interface OptionsBasisSpread {
  /** Put-call-parity synthetic forward: `strike + e^{rt}·(call − put)`. */
  optionsImpliedForward: number;
  /** The options market's annualized implied carry: `ln(optionsImpliedForward/spot)/t`. */
  optionsImpliedCarry: number;
  /** The future's annualized log-basis carry: `ln(future/spot)/t`. */
  basisImpliedCarry: number;
  /** `basisImpliedCarry − optionsImpliedCarry` (annualized carry the two markets disagree by). */
  spread: number;
  signal: OptionsCarrySignal;
}

/**
 * Reconcile the options market's **put-call-parity synthetic forward** against a dated future on the same
 * underlying/expiry. Put-call parity gives the synthetic forward `F = strike + e^{rt}·(call − put)` with no
 * volatility model; its annualized carry is compared to the future's `ln(future/spot)/t`. `future-rich`
 * (spread > tolerance) ⇒ the future prices a richer forward than the options synthetic — sell the future /
 * buy the synthetic (long call + short put); `options-rich` is the reverse. See `docs/specs/crypto-carry.md`.
 */
/** EXACT {@link OptionsBasisSpreadInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const OPTIONS_BASIS_SPREAD_KEYS = [
  'spot',
  'strike',
  'call',
  'put',
  'timeToExpiryYears',
  'riskFreeRate',
  'future',
  'tolerance',
] as const;

export function optionsBasisSpread(input: OptionsBasisSpreadInput): Computed<OptionsBasisSpread> {
  const functionName = 'optionsBasisSpread';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, OPTIONS_BASIS_SPREAD_KEYS);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensureNonNegative(input.call, 'call', functionName);
  ensureNonNegative(input.put, 'put', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  ensurePositive(input.future, 'future', functionName);
  if (
    input.tolerance !== undefined &&
    (typeof input.tolerance !== 'number' || !Number.isFinite(input.tolerance))
  ) {
    throw new InputError(
      `optionsBasisSpread: tolerance must be a finite number when provided. Received ${input.tolerance === null ? 'null' : typeof input.tolerance}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'tolerance' } },
    );
  }
  const tolerance = input.tolerance ?? 0.005;
  ensureNonNegative(tolerance, 'tolerance', functionName);
  const warnings: QuantWarning[] = [];
  // Flagged BEFORE `e^{r·t}` runs: at |r| > 10 the discount factor overflows and the postcondition
  // refuses the result — the warning explains which input caused it.
  const rateWarning = implausibleRateWarning(functionName, 'riskFreeRate', input.riskFreeRate);
  if (rateWarning !== undefined) warnings.push(rateWarning);

  const optionsImpliedForward =
    input.strike +
    Math.exp(input.riskFreeRate * input.timeToExpiryYears) * (input.call - input.put);
  if (!(optionsImpliedForward > 0)) {
    // A non-positive parity forward means the call/put quotes are inconsistent (arbitraged or stale) —
    // `ln(F/spot)` would be non-finite; refuse rather than emit a NaN carry (Law 7).
    throw new InputError(
      `${functionName}: the put-call-parity forward is ${optionsImpliedForward} (≤ 0) — the call (${input.call}) and put (${input.put}) at strike ${input.strike} are inconsistent; check the quotes and rate.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { optionsImpliedForward, call: input.call, put: input.put, strike: input.strike },
      },
    );
  }
  const optionsImpliedCarry =
    Math.log(optionsImpliedForward / input.spot) / input.timeToExpiryYears;
  const basisImpliedCarry = Math.log(input.future / input.spot) / input.timeToExpiryYears;
  const spread = basisImpliedCarry - optionsImpliedCarry;
  const signal: OptionsCarrySignal =
    spread > tolerance ? 'future-rich' : spread < -tolerance ? 'options-rich' : 'aligned';

  return finalizeResult(functionName, {
    value: { optionsImpliedForward, optionsImpliedCarry, basisImpliedCarry, spread, signal },
    assumptions: assumptions('options-basis-spread'),
    diagnostics: diagnostics('options-basis-spread', warnings),
  });
}
