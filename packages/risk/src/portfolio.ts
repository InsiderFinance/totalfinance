import { ensureFiniteWhenPresent } from './options-internal.js';
/**
 * `@insiderfinance/totalfinance/risk/portfolio` — portfolio-level risk approximations (spec §15.3): concentration,
 * liquidity, margin, and Greeks aggregation. Pure functions over weights / positions / Greeks; no
 * market data or option pricing pulled in.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  requireArgumentArray,
  requireArgumentObject,
  seriesFacade,
  warning,
} from '@totalfinance/core';
import type { Position, PositionGreeks } from './scenario.js';

/** Law 2 report grammar (D5): every portfolio answer carries its conventions and a warnings channel. */
function portfolioReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

// ───────────────────────── concentration risk ─────────────────────────

/** The bare concentration read-out (the values `analyzeBook` embeds without a nested report). */
export interface ConcentrationValues {
  /** Herfindahl-Hirschman index `Σ s_i²` on gross-normalized weights (1 = one name, 1/n = equal). */
  hhi: number;
  /**
   * Effective number of positions `1 / HHI`; `null` when the book has zero gross exposure (there is
   * nothing to concentrate — Law 7: an undefined quantity is null-with-reason, never NaN).
   */
  effectiveCount: number | null;
  /** Largest single name's share of gross exposure. */
  topWeight: number;
  /** Combined share of the top-`k` names (default `k = min(5, n)`). */
  topKShare: number;
  /** Gini coefficient of the gross-normalized weight distribution (0 = equal, →1 = concentrated). */
  gini: number;
}

/** {@link concentration}'s report: the values plus the applied conventions (Law 2 report grammar). */
export interface ConcentrationResult extends ConcentrationValues {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** The documented `concentration` option keys. */
const CONCENTRATION_OPTIONS_KEYS = ['topK'] as const;

/**
 * Concentration of a (possibly long/short) weight vector, measured on gross-normalized shares
 * `s_i = |w_i| / Σ|w|`: the HHI and its reciprocal effective-N, the largest and top-k shares, and the
 * Gini coefficient.
 */
export function concentration(
  weights: ArrayLike<number>,
  options: { topK?: number } = {},
): ConcentrationResult {
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('concentration', 'options', options);
  // Law 12: a misspelled knob (`topk: 2` running at the top-5 default) must throw, never no-op.
  ensureKnownKeys('concentration', 'options', options, CONCENTRATION_OPTIONS_KEYS);
  requireArgumentArray('concentration', 'weights', weights);
  const n = weights.length;
  if (n === 0) {
    // Every sibling rejects empty input; a NaN-struct would silently poison a dashboard (design law #4).
    throw new InputError('concentration: weights must be non-empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { length: 0 },
    });
  }
  let gross = 0;
  for (let i = 0; i < n; i++) {
    ensureFinite(weights[i]!, `weights[${i}]`, 'concentration');
    gross += Math.abs(weights[i]!);
  }
  ensureFiniteWhenPresent(options.topK, 'topK', 'concentration');
  const k = Math.max(1, Math.min(options.topK ?? 5, n));
  if (gross === 0) {
    // A zero-gross book has nothing to concentrate: effectiveN is undefined — null + a warning
    // (Law 7: warnings never license a NaN), mirroring the optionsMargin `maxLoss: null` pattern.
    return {
      hhi: 0,
      effectiveCount: null,
      topWeight: 0,
      topKShare: 0,
      gini: 0,
      ...portfolioReport({ topK: k, positions: n }, [
        warning(
          WarningCode.RiskZeroGrossExposure,
          'concentration: every weight is 0, so gross exposure is zero and the effective position count is undefined — effectiveCount is null.',
          'info',
          { positions: n },
        ),
      ]),
    };
  }
  const shares = Array.from({ length: n }, (_, i) => Math.abs(weights[i]!) / gross).sort(
    (a, b) => b - a,
  );
  let hhi = 0;
  for (const s of shares) hhi += s * s;
  let topKShare = 0;
  for (let i = 0; i < k; i++) topKShare += shares[i]!;
  // Gini via mean absolute difference of the shares (Σ s = 1 ⇒ denominator simplifies to n).
  let rollingMeanAbsoluteDeviation = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) rollingMeanAbsoluteDeviation += Math.abs(shares[i]! - shares[j]!);
  const gini = rollingMeanAbsoluteDeviation / (2 * n);
  return {
    hhi,
    effectiveCount: 1 / hhi,
    topWeight: shares[0]!,
    topKShare,
    gini,
    // The applied top-k window (dx §2.4): the `topK: 5` default is disclosed, never hidden.
    ...portfolioReport({ topK: k, positions: n }),
  };
}

// ───────────────────────── liquidity approximations ─────────────────────────

export interface LiquidityPosition {
  /** Position size (signed), in the same unit as `averageDailyVolume` (shares or notional). */
  size: number;
  /** Average daily volume (> 0), same unit as `size`. */
  averageDailyVolume: number;
}

export interface LiquidityResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  perAsset: { daysToLiquidate: number; averageDailyVolumeMultiple: number }[];
  /** Days to fully unwind the book trading each name at `participation` of its ADV (the slowest name). */
  portfolioDaysToLiquidate: number;
}

/** The documented `liquidity` option keys. */
const LIQUIDITY_OPTIONS_KEYS = ['participation'] as const;

/**
 * Liquidity approximation: days to liquidate each position when trading at most `participation` of its
 * average daily volume (default 20%), plus the slowest name's horizonPeriods for the whole book.
 */
export function liquidity(
  positions: readonly LiquidityPosition[],
  options: { participation?: number } = {},
): LiquidityResult {
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('liquidity', 'options', options);
  // Law 12: a misspelled knob (`particpation` running at the 20% default) must throw, never no-op.
  ensureKnownKeys('liquidity', 'options', options, LIQUIDITY_OPTIONS_KEYS);
  requireArgumentArray('liquidity', 'positions', positions);
  ensureFiniteWhenPresent(options.participation, 'participation', 'liquidity');
  const participation = options.participation ?? 0.2;
  if (!(participation > 0 && participation <= 1)) {
    throw new InputError(`liquidity: participation must be in (0, 1], got ${participation}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { participation },
    });
  }
  let worst = 0;
  const perAsset = positions.map((p, i) => {
    if (!(p.averageDailyVolume > 0)) {
      throw new InputError(
        `liquidity: positions[${i}].averageDailyVolume must be > 0, got ${p.averageDailyVolume}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, averageDailyVolume: p.averageDailyVolume },
        },
      );
    }
    const averageDailyVolumeMultiple = Math.abs(p.size) / p.averageDailyVolume;
    const daysToLiquidate = averageDailyVolumeMultiple / participation;
    if (daysToLiquidate > worst) worst = daysToLiquidate;
    return { daysToLiquidate, averageDailyVolumeMultiple };
  });
  return {
    perAsset,
    portfolioDaysToLiquidate: worst,
    // The applied participation cap (dx §2.4): the 20% default is disclosed, never hidden.
    ...portfolioReport({ participation, positions: positions.length }),
  };
}

/** Inputs to {@link marketImpact}: the trade size, the asset's ADV, and its per-period vol. */
export interface MarketImpactInput {
  /** Trade size (signed), in the same unit as `averageDailyVolume` (shares or notional). */
  size: number;
  /** Average daily volume (> 0), same unit as `size`. */
  averageDailyVolume: number;
  /** The asset's per-period vol (≥ 0). */
  volatility: number;
}

/** The documented {@link MarketImpactInput} keys. */
const MARKET_IMPACT_INPUT_KEYS = ['size', 'averageDailyVolume', 'volatility'] as const;

/** The documented `marketImpact` option keys. */
const MARKET_IMPACT_OPTIONS_KEYS = ['coefficient'] as const;

/** {@link marketImpact}'s envelope: the impact cost plus the applied impact-law coefficient. */
export type MarketImpactResult = Computed<number, { coefficient: number }>;

/**
 * Square-root market-impact cost (fraction of price): `coefficient · σ · √(|size| / averageDailyVolume)` — the
 * standard concave impact law. `σ` is the asset's per-period vol; `coefficient` defaults to 1.
 * Returns the standard `Computed` envelope: `value` is the impact cost, and the applied
 * `coefficient` default is echoed in `assumptions` (dx §2.4, never silently applied).
 */
function marketImpactResult(
  input: MarketImpactInput,
  options: { coefficient?: number } = {},
): MarketImpactResult {
  requireArgumentObject('marketImpact', 'input', input);
  // Law 12: a misspelled field (`avd` leaving averageDailyVolume undefined) must throw, never no-op.
  ensureKnownKeys('marketImpact', 'input', input, MARKET_IMPACT_INPUT_KEYS);
  requireArgumentObject('marketImpact', 'options', options);
  ensureKnownKeys('marketImpact', 'options', options, MARKET_IMPACT_OPTIONS_KEYS);
  const { size, averageDailyVolume, volatility } = input;
  if (!(averageDailyVolume > 0)) {
    throw new InputError(
      `marketImpact: averageDailyVolume must be > 0, got ${averageDailyVolume}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { averageDailyVolume },
      },
    );
  }
  // Without these, a NaN size or a negative vol/coefficient yields a NaN or negative "cost".
  ensureFinite(size, 'size', 'marketImpact');
  ensureNonNegative(volatility, 'volatility', 'marketImpact');
  const coefficient = options.coefficient ?? 1;
  ensureNonNegative(coefficient, 'coefficient', 'marketImpact');
  return {
    value: coefficient * volatility * Math.sqrt(Math.abs(size) / averageDailyVolume),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, coefficient },
    diagnostics: { warnings: [] },
  };
}

/** Plain impact cost; use `marketImpact.explain(...)` for the coefficient and diagnostics. */
export const marketImpact = seriesFacade(
  'marketImpact',
  (input: MarketImpactInput, options: { coefficient?: number } = {}): number =>
    marketImpactResult(input, options).value,
  marketImpactResult,
);

// ───────────────────────── margin approximations ─────────────────────────

export interface MarginResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  /** Short exposure as a positive magnitude. */
  shortExposure: number;
  /** Initial (Reg-T-style) margin requirement: `initialRate · gross`. */
  initialMargin: number;
  /** Maintenance margin requirement: `maintenanceRate · gross`. */
  maintenanceMargin: number;
  /** Gross leverage `gross / equity`. */
  leverage: number;
  /** Whether `equity ≥ maintenanceMargin`. */
  meetsMaintenance: boolean;
}

/** The documented `margin` option keys. */
const MARGIN_OPTIONS_KEYS = ['equity', 'initialRate', 'maintenanceRate'] as const;

/**
 * Margin approximation from signed position notionals and account equity: gross/net/long/short
 * exposure, Reg-T-style initial (default 50%) and maintenance (default 25%) requirements, gross
 * leverage, and a maintenance-met flag.
 */
export function margin(
  positionNotionals: ArrayLike<number>,
  options: { equity: number; initialRate?: number; maintenanceRate?: number },
): MarginResult {
  requireArgumentObject('margin', 'options', options);
  // Law 12: a misspelled knob (`initalRate` running at the 50% default) must throw, never no-op.
  ensureKnownKeys('margin', 'options', options, MARGIN_OPTIONS_KEYS);
  requireArgumentArray('margin', 'positionNotionals', positionNotionals);
  ensureFinite(options.equity, 'equity', 'margin');
  if (!(options.equity > 0)) {
    throw new InputError(`margin: equity must be > 0, got ${options.equity}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { equity: options.equity },
    });
  }
  ensureFiniteWhenPresent(options.initialRate, 'initialRate', 'margin');
  const initialRate = options.initialRate ?? 0.5;
  ensureFiniteWhenPresent(options.maintenanceRate, 'maintenanceRate', 'margin');
  const maintenanceRate = options.maintenanceRate ?? 0.25;
  // A negative/NaN rate would flow straight into initial/maintenance margin and meetsMaintenance.
  ensureNonNegative(initialRate, 'initialRate', 'margin');
  ensureNonNegative(maintenanceRate, 'maintenanceRate', 'margin');
  let gross = 0;
  let net = 0;
  let long = 0;
  let short = 0;
  for (let i = 0; i < positionNotionals.length; i++) {
    const v = positionNotionals[i]!;
    ensureFinite(v, `positionNotionals[${i}]`, 'margin');
    gross += Math.abs(v);
    net += v;
    if (v > 0) long += v;
    else short -= v;
  }
  const maintenanceMargin = maintenanceRate * gross;
  return {
    grossExposure: gross,
    netExposure: net,
    longExposure: long,
    shortExposure: short,
    initialMargin: initialRate * gross,
    maintenanceMargin,
    leverage: gross / options.equity,
    meetsMaintenance: options.equity >= maintenanceMargin,
    // The applied rates (dx §2.4): the 50%/25% Reg-T defaults are disclosed, never hidden.
    ...portfolioReport({
      equity: options.equity,
      initialRate,
      maintenanceRate,
      positions: positionNotionals.length,
    }),
  };
}

// ───────────────────────── options margin / buying-power (spec §15.3) ─────────────────────────

export interface NakedMarginOptions {
  /** Contract multiplier (default 100). */
  multiplier?: number;
  /** Reg-T naked "equity" rate — the % of underlying (default 0.20). */
  equityRate?: number;
  /** Reg-T naked floor rate — the % of underlying (calls) / strike (puts) minimum (default 0.10). */
  floorRate?: number;
}

/**
 * Resolve and validate the naked-margin knobs. A negative multiplier or rate would flip the sign of
 * the requirement (negative margin / max loss) — reject rather than emit a nonsensical figure.
 */
function resolveNakedMarginOptions(
  options: NakedMarginOptions,
  functionName: string,
): { mult: number; eq: number; fl: number } {
  ensureFiniteWhenPresent(options.multiplier, 'multiplier', functionName);
  const mult = options.multiplier ?? 100;
  ensureFiniteWhenPresent(options.equityRate, 'equityRate', functionName);
  const eq = options.equityRate ?? 0.2;
  ensureFiniteWhenPresent(options.floorRate, 'floorRate', functionName);
  const fl = options.floorRate ?? 0.1;
  ensurePositive(mult, 'multiplier', functionName);
  ensureNonNegative(eq, 'equityRate', functionName);
  ensureNonNegative(fl, 'floorRate', functionName);
  return { mult, eq, fl };
}

/** Inputs to {@link nakedCallMargin} / {@link nakedPutMargin}: the underlier spot, strike, and premium. */
export interface NakedMarginInput {
  /** Current price of the underlying (> 0). */
  spot: number;
  /** Option strike (> 0). */
  strike: number;
  /** Premium per share, entry mid (≥ 0). */
  premium: number;
}

/** The documented {@link NakedMarginInput} keys. */
const NAKED_MARGIN_INPUT_KEYS = ['spot', 'strike', 'premium'] as const;

/**
 * The naked-margin envelope: `value` is the Reg-T requirement in account currency per contract, and
 * the applied multiplier / equity-rate / floor-rate defaults ride `assumptions` (dx §2.4).
 */
export type NakedMarginResult = Computed<
  number,
  { multiplier: number; equityRate: number; floorRate: number }
>;

/** Shared boundary guard + knob resolution for the two naked-margin facades. */
function resolveNakedMargin(
  input: NakedMarginInput,
  options: NakedMarginOptions,
  functionName: string,
): { mult: number; eq: number; fl: number } {
  requireArgumentObject(functionName, 'input', input);
  // Law 12: a misspelled field (`premum` treated as premium 0) must throw, never no-op.
  ensureKnownKeys(functionName, 'input', input, NAKED_MARGIN_INPUT_KEYS);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, NAKED_MARGIN_OPTIONS_KEYS);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensureNonNegative(input.premium, 'premium', functionName);
  return resolveNakedMarginOptions(options, functionName);
}

/** Wrap a per-contract requirement in the naked-margin envelope. */
function nakedMarginEnvelope(
  value: number,
  knobs: { mult: number; eq: number; fl: number },
): NakedMarginResult {
  return {
    value,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      multiplier: knobs.mult,
      equityRate: knobs.eq,
      floorRate: knobs.fl,
    },
    diagnostics: { warnings: [] },
  };
}

/** Bare per-contract naked-call requirement given resolved knobs (shared with `optionsMargin`). */
function nakedCallMarginKernel(
  input: NakedMarginInput,
  knobs: { mult: number; eq: number; fl: number },
): number {
  const otm = Math.max(input.strike - input.spot, 0);
  return (
    (input.premium + Math.max(knobs.eq * input.spot - otm, knobs.fl * input.spot)) * knobs.mult
  );
}

/** Bare per-contract naked-put requirement given resolved knobs (shared with `optionsMargin`). */
function nakedPutMarginKernel(
  input: NakedMarginInput,
  knobs: { mult: number; eq: number; fl: number },
): number {
  const otm = Math.max(input.spot - input.strike, 0);
  return (
    (input.premium + Math.max(knobs.eq * input.spot - otm, knobs.fl * input.strike)) * knobs.mult
  );
}

/**
 * Reg-T initial margin for one naked short **call**, in account currency per contract:
 * `premium + max(equityRate·U − OTM, floorRate·U)`, `OTM = max(strike − U, 0)`, all × multiplier.
 * Returns the standard `Computed` envelope (`value` = the requirement).
 */
function nakedCallMarginResult(
  input: NakedMarginInput,
  options: NakedMarginOptions = {},
): NakedMarginResult {
  const knobs = resolveNakedMargin(input, options, 'nakedCallMargin');
  return nakedMarginEnvelope(nakedCallMarginKernel(input, knobs), knobs);
}

/** Plain per-contract requirement; use `.explain()` for the applied Reg-T knobs. */
export const nakedCallMargin = seriesFacade(
  'nakedCallMargin',
  (input: NakedMarginInput, options: NakedMarginOptions = {}): number =>
    nakedCallMarginResult(input, options).value,
  nakedCallMarginResult,
);

/**
 * Reg-T initial margin for one naked short **put**, in account currency per contract:
 * `premium + max(equityRate·U − OTM, floorRate·strike)`, `OTM = max(U − strike, 0)`, all × multiplier.
 * (The floor is on the strike/aggregate exercise value, per the CBOE manual.) Returns the standard
 * `Computed` envelope (`value` = the requirement).
 */
function nakedPutMarginResult(
  input: NakedMarginInput,
  options: NakedMarginOptions = {},
): NakedMarginResult {
  const knobs = resolveNakedMargin(input, options, 'nakedPutMargin');
  return nakedMarginEnvelope(nakedPutMarginKernel(input, knobs), knobs);
}

/** Plain per-contract requirement; use `.explain()` for the applied Reg-T knobs. */
export const nakedPutMargin = seriesFacade(
  'nakedPutMargin',
  (input: NakedMarginInput, options: NakedMarginOptions = {}): number =>
    nakedPutMarginResult(input, options).value,
  nakedPutMarginResult,
);

/** One option leg of a position for the margin calculation. */
export interface OptionMarginLeg {
  type: 'call' | 'put';
  /** Signed contracts: positive = long, negative = short. */
  quantity: number;
  strike: number;
  /** Premium per share (entry mid). */
  premium: number;
}

/**
 * How an UNCOVERED short put is margined:
 *   - `'reg-t-naked'` (default) — the Reg-T naked-put requirement, i.e. {@link nakedPutMargin};
 *   - `'cash-secured'` — the full expiration max loss `(strike − premium)·multiplier`, i.e. the
 *     cash a cash-secured seller must post. That is ~4× the Reg-T number and is what a
 *     retail-cash account (or an IRA) actually needs.
 */
export type PutMarginBasis = 'reg-t-naked' | 'cash-secured';

export interface OptionsMarginOptions extends NakedMarginOptions {
  /** Current price of the underlying (> 0). */
  spot: number;
  /**
   * Basis for UNCOVERED short puts. Default `'reg-t-naked'` — a margin account's actual
   * requirement. Use `'cash-secured'` for a cash/IRA account, where the whole exercise value must
   * be posted. Echoed in `assumptions.putMarginBasis`.
   */
  putMarginBasis?: PutMarginBasis;
}

/** The documented {@link NakedMarginOptions} keys. */
const NAKED_MARGIN_OPTIONS_KEYS = ['multiplier', 'equityRate', 'floorRate'] as const;

/** The documented {@link OptionsMarginOptions} keys — the naked knobs plus `spot`. */
const OPTIONS_MARGIN_OPTIONS_KEYS = [
  ...NAKED_MARGIN_OPTIONS_KEYS,
  'spot',
  'putMarginBasis',
] as const;

/** The valid {@link PutMarginBasis} values (Law 12: an unknown basis throws, never defaults). */
const PUT_MARGIN_BASES: readonly PutMarginBasis[] = ['reg-t-naked', 'cash-secured'];

export interface OptionsMarginResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Initial margin / buying-power requirement, in account currency. */
  initialMargin: number;
  /**
   * Buying-power reduction — what the account must set aside. Equals `initialMargin` for margin
   * accounts; for a long-only (fully-paid) position it is the net debit paid.
   */
  buyingPowerReduction: number;
  /**
   * Worst-case expiration loss magnitude per contract; `null` when the loss is unbounded (e.g. a
   * naked call — no finite worst case exists; `Infinity` is not JSON-safe, Law 7). `definedRisk:
   * false` is the primary unbounded discriminant, and a `risk.unbounded_loss` warning explains the
   * null.
   */
  maxLoss: number | null;
  /** Net debit paid (> 0) or credit received (< 0), per contract. */
  netDebit: number;
  /** True when the position's loss is capped (spreads / condors / butterflies / long options). */
  definedRisk: boolean;
  /**
   * How the requirement was derived. `'reg-t-naked-put'` is the bounded-but-uncovered case: the
   * loss IS capped (a put's underlying stops at 0), but the position is short naked puts, so the
   * requirement is the Reg-T naked-put charge on the uncovered contracts plus the capped max loss
   * of whatever remains — not the cash-secured exercise value.
   */
  method: 'defined-risk-max-loss' | 'reg-t-naked' | 'reg-t-naked-put' | 'long-premium';
}

/**
 * Initial margin / buying-power for a single-underlying, single-expiry multi-leg option position
 * (spec §15.3, product review §6). The expiration payoff is piecewise-linear, so the requirement is:
 *
 *  - **long only** (all legs bought): the net debit paid (fully-paid, no additional margin);
 *  - **covered defined risk** (every short leg is offset — verticals, condors, butterflies): the
 *    max loss;
 *  - **uncovered short puts** (more short put contracts than long ones): the Reg-T naked-put
 *    requirement on the uncovered contracts + the max loss of the rest. A short put's loss is
 *    *bounded* (the underlying stops at 0), but bounded is not the same as covered: charging the
 *    whole `(strike − premium)` exercise value margins a margin account as if it were
 *    cash-secured, ~4× the Reg-T requirement one function away (`nakedPutMargin`). Opt into the
 *    cash-secured basis for a cash/IRA account with `putMarginBasis: 'cash-secured'`;
 *  - **undefined risk** (a net-short call leaves the upside unbounded): the Reg-T naked requirement
 *    summed over the short legs — a conservative strategy-based approximation (a portfolio-margin
 *    engine would net offsets more finely).
 *
 * Coverage is counted contract-for-contract per option type, pairing the highest strikes first, so
 * a 1×1 spread is covered and the extra short in a 2×1 ratio is not. `maxLoss` is unaffected by the
 * margin basis — it stays the position's true worst case at expiration.
 *
 * Pure and clock-free; premiums, strikes, and the underlier are explicit inputs.
 */
export function optionsMargin(
  legs: readonly OptionMarginLeg[],
  options: OptionsMarginOptions,
): OptionsMarginResult {
  requireArgumentObject('optionsMargin', 'options', options);
  // Law 12: a misspelled knob (`equtyRate` running at the 20% default) must throw, never no-op.
  ensureKnownKeys('optionsMargin', 'options', options, OPTIONS_MARGIN_OPTIONS_KEYS);
  requireArgumentArray('optionsMargin', 'legs', legs);
  const functionName = 'optionsMargin';
  ensurePositive(options.spot, 'spot', functionName);
  // Pre-coalesce: null must reach the enum guard, never silently become the default basis.
  const putMarginBasis: PutMarginBasis =
    options.putMarginBasis === null
      ? (null as unknown as PutMarginBasis)
      : (options.putMarginBasis ?? 'reg-t-naked');
  if (!PUT_MARGIN_BASES.includes(putMarginBasis)) {
    throw new InputError(
      `${functionName}: putMarginBasis must be one of ${PUT_MARGIN_BASES.join(', ')}; got "${String(putMarginBasis)}".`,
      { code: ErrorCode.InputInvalidEnum, context: { putMarginBasis } },
    );
  }
  if (legs.length === 0) {
    throw new InputError(`${functionName}: at least one option leg is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { legs: 0 },
    });
  }
  // Validate the multiplier / Reg-T rate knobs (the naked branch forwards them to nakedCall/PutMargin).
  const { mult, eq, fl } = resolveNakedMarginOptions(options, functionName);
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]!;
    if (l.type !== 'call' && l.type !== 'put') {
      throw new InputError(
        `${functionName}: legs[${i}].type must be 'call' or 'put', got "${l.type}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { index: i, type: l.type },
        },
      );
    }
    ensureFinite(l.quantity, `legs[${i}].quantity`, functionName);
    ensurePositive(l.strike, `legs[${i}].strike`, functionName);
    ensureNonNegative(l.premium, `legs[${i}].premium`, functionName);
  }

  const intrinsic = (type: 'call' | 'put', k: number, x: number): number =>
    type === 'call' ? Math.max(x - k, 0) : Math.max(k - x, 0);
  const netDebitPerShare = legs.reduce((s, l) => s + l.quantity * l.premium, 0);
  const pnlPerShare = (x: number): number =>
    legs.reduce((s, l) => s + l.quantity * intrinsic(l.type, l.strike, x), 0) - netDebitPerShare;

  // The only unbounded direction is up (x → ∞) when the net call quantity is short; the downside is
  // bounded at x = 0. So the worst finite P&L is at a vertex in {0, strikes}.
  const callSlope = legs.filter((l) => l.type === 'call').reduce((s, l) => s + l.quantity, 0);
  const unboundedUp = callSlope < 0;
  const vertices = [0, ...legs.map((l) => l.strike)];
  const worstFinite = Math.min(...vertices.map(pnlPerShare));
  // Only meaningful when the loss is bounded; the unbounded case reports `maxLoss: null` (Law 7 —
  // `Infinity` is not JSON-safe, and a warning never licenses a non-finite).
  const boundedMaxLossPerShare = Math.max(0, -Math.min(0, worstFinite));

  const definedRisk = !unboundedUp;
  const allLong = legs.every((l) => l.quantity > 0);
  const netDebit = netDebitPerShare * mult;
  const knobs = { mult, eq, fl };

  /** Per-contract requirement for one short put leg under the selected basis. */
  const shortPutRequirement = (leg: OptionMarginLeg): number =>
    putMarginBasis === 'cash-secured'
      ? Math.max(0, leg.strike - leg.premium) * mult // the full exercise value a cash account posts
      : nakedPutMarginKernel(
          { spot: options.spot, strike: leg.strike, premium: leg.premium },
          knobs,
        );

  // Uncovered short puts: pair short put contracts against long put contracts, highest strike
  // first, and keep whatever is left over. This is what separates a bull put SPREAD (covered, max
  // loss) from a naked short put (Reg-T), and it is counted per contract so a 2×1 ratio charges the
  // one genuinely naked contract.
  const shortPuts = legs
    .filter((l) => l.type === 'put' && l.quantity < 0)
    .sort((a, b) => b.strike - a.strike);
  let longPutCover = legs
    .filter((l) => l.type === 'put' && l.quantity > 0)
    .reduce((s, l) => s + l.quantity, 0);
  const uncoveredShortPuts: { leg: OptionMarginLeg; contracts: number }[] = [];
  for (const leg of shortPuts) {
    const contracts = Math.abs(leg.quantity);
    const covered = Math.min(longPutCover, contracts);
    longPutCover -= covered;
    if (contracts - covered > 0) uncoveredShortPuts.push({ leg, contracts: contracts - covered });
  }

  let initialMargin: number;
  let method: OptionsMarginResult['method'];
  if (definedRisk && (uncoveredShortPuts.length === 0 || putMarginBasis === 'cash-secured')) {
    // Fully covered (or explicitly cash-secured): the capped expiration loss IS the requirement.
    initialMargin = boundedMaxLossPerShare * mult;
    method = allLong ? 'long-premium' : 'defined-risk-max-loss';
  } else if (definedRisk) {
    // Bounded but uncovered: Reg-T on the naked put contracts + the capped loss of the remainder.
    method = 'reg-t-naked-put';
    const uncoveredMargin = uncoveredShortPuts.reduce(
      (sum, u) => sum + u.contracts * shortPutRequirement(u.leg),
      0,
    );
    // The residual position is the book minus exactly those uncovered short contracts; its own
    // worst case is still a real (capped) loss the account can take on top of the naked charge.
    const residual: OptionMarginLeg[] = legs.map((l) => {
      const uncovered = uncoveredShortPuts.find((u) => u.leg === l);
      return uncovered === undefined ? l : { ...l, quantity: l.quantity + uncovered.contracts };
    });
    const residualLegs = residual.filter((l) => l.quantity !== 0);
    let residualMaxLossPerShare = 0;
    if (residualLegs.length > 0) {
      const residualDebit = residualLegs.reduce((s, l) => s + l.quantity * l.premium, 0);
      const residualPnl = (x: number): number =>
        residualLegs.reduce((s, l) => s + l.quantity * intrinsic(l.type, l.strike, x), 0) -
        residualDebit;
      const residualWorst = Math.min(...[0, ...residualLegs.map((l) => l.strike)].map(residualPnl));
      residualMaxLossPerShare = Math.max(0, -Math.min(0, residualWorst));
    }
    initialMargin = uncoveredMargin + residualMaxLossPerShare * mult;
  } else {
    // Sum the Reg-T naked requirement over the short legs (uncovered).
    method = 'reg-t-naked';
    initialMargin = legs
      .filter((l) => l.quantity < 0)
      .reduce((sum, l) => {
        const per =
          l.type === 'call'
            ? nakedCallMarginKernel(
                { spot: options.spot, strike: l.strike, premium: l.premium },
                knobs,
              )
            : shortPutRequirement(l);
        return sum + Math.abs(l.quantity) * per;
      }, 0);
  }

  // For a long-only position the "requirement" is simply the debit already paid.
  const buyingPowerReduction = method === 'long-premium' ? Math.max(0, netDebit) : initialMargin;
  const warnings: QuantWarning[] = [];
  if (method === 'reg-t-naked-put') {
    warnings.push({
      code: WarningCode.ModelLimitation,
      message:
        `The position is short ${uncoveredShortPuts.reduce((s, u) => s + u.contracts, 0)} uncovered put contract(s): the requirement is the Reg-T naked-put charge on them (a MARGIN account's basis), not the ` +
        `(strike − premium) exercise value. For a cash or IRA account pass putMarginBasis: 'cash-secured'; maxLoss is unchanged either way.`,
      severity: 'info',
      context: { putMarginBasis, uncoveredContracts: uncoveredShortPuts.length },
    });
  }
  if (unboundedUp) {
    warnings.push({
      code: WarningCode.RiskUnboundedLoss,
      message:
        'The position is net-short calls, so the expiration loss is unbounded above — maxLoss is null (no finite worst case; definedRisk is false) and the Reg-T naked requirement is reported instead.',
      severity: 'info',
      context: { callSlope, method },
    });
  }
  return {
    initialMargin,
    buyingPowerReduction,
    maxLoss: unboundedUp ? null : boundedMaxLossPerShare * mult,
    netDebit,
    definedRisk,
    method,
    // The applied knobs (dx §2.4): the 100/20%/10% multiplier + Reg-T rate defaults and the
    // uncovered-short-put basis are disclosed, never hidden.
    ...portfolioReport(
      {
        spot: options.spot,
        multiplier: mult,
        equityRate: eq,
        floorRate: fl,
        putMarginBasis,
        legs: legs.length,
      },
      warnings,
    ),
  };
}

// ───────────────────────── Greeks aggregation ─────────────────────────

export interface PortfolioGreeks {
  /** Net mark value `Σ qty · multiplier · value`. */
  value: number;
  /** Book totals in the one unit system: theta per calendar day, vega per vol point, rho per 1%. */
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

/**
 * {@link aggregateGreeks}'s envelope: `value` carries the book-level totals; `assumptions` echo the
 * position count and the missing-greeks-count-as-0 convention.
 */
export type AggregateGreeksResult = Computed<
  PortfolioGreeks,
  {
    positions: number;
    missingGreeks: 'counted-as-zero';
    /** Each position's `multiplier` (default 1) scales its value and Greeks with its `quantity`. */
    contractMultiplier: 'applied';
    /** The unit system of the totals: the options package's (theta per day, vega/rho per 1%). */
    greekUnits: { theta: 'perDay'; vega: 'per1Percent'; rho: 'per1Percent' };
  }
>;

/**
 * Aggregate per-position Greeks into book-level totals, each scaled by the position's signed
 * `quantity` (default 1) AND its contract `multiplier` (default 1) — per-share option Greeks with
 * `quantity` in contracts need `multiplier: 100`, and the result says so. Missing Greeks count as 0,
 * so a mixed book of options and deltas aggregates cleanly. Greeks are in the one unit system
 * (theta per day, vega per vol point, rho per 1%). Returns the standard `Computed` envelope
 * (`value` = the totals).
 */
export function aggregateGreeks(positions: readonly Position[]): AggregateGreeksResult {
  requireArgumentArray('aggregateGreeks', 'positions', positions);
  const total: PortfolioGreeks = { value: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  for (const p of positions) {
    const q = (p.quantity ?? 1) * (p.multiplier ?? 1);
    const g: PositionGreeks | undefined = p.greeks;
    if (!g) continue;
    total.value += q * g.value;
    total.delta += q * (g.delta ?? 0);
    total.gamma += q * (g.gamma ?? 0);
    total.vega += q * (g.vega ?? 0);
    total.theta += q * (g.theta ?? 0);
    total.rho += q * (g.rho ?? 0);
  }
  return {
    value: total,
    // The missing-greeks convention (dx §2.4): a position without greeks contributes 0, disclosed.
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      positions: positions.length,
      missingGreeks: 'counted-as-zero',
      contractMultiplier: 'applied',
      greekUnits: { theta: 'perDay', vega: 'per1Percent', rho: 'per1Percent' },
    },
    diagnostics: { warnings: [] },
  };
}

// ───────────────────────── beta-weighted delta ─────────────────────────

export interface BetaWeightedPosition {
  /** Net delta in shares (already quantity- and multiplier-scaled). */
  delta: number;
  /** The position's underlying (current) price. */
  spot: number;
  /** The underlying's beta to the reference index. */
  beta: number;
}

export interface BetaWeightedDeltaResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Net exposure in index-equivalent shares (`Σ δ·price·β / indexPrice`). */
  indexDelta: number;
  /** Net beta-weighted dollar delta (`Σ δ·price·β`). */
  dollarDelta: number;
  perPosition: { dollarDelta: number; indexDelta: number }[];
}

/** The documented `betaWeightedDelta` option keys. */
const BETA_WEIGHTED_DELTA_OPTIONS_KEYS = ['indexPrice'] as const;

/**
 * Beta-weight a book's delta to a reference index — the standard "what's my net delta in SPY terms"
 * read-out. Each position's dollar delta `δ·price` is scaled by its beta and divided by the index
 * price to express the whole book as index-equivalent shares.
 */
export function betaWeightedDelta(
  positions: readonly BetaWeightedPosition[],
  options: { indexPrice: number },
): BetaWeightedDeltaResult {
  requireArgumentObject('betaWeightedDelta', 'options', options);
  ensureKnownKeys('betaWeightedDelta', 'options', options, BETA_WEIGHTED_DELTA_OPTIONS_KEYS);
  requireArgumentArray('betaWeightedDelta', 'positions', positions);
  ensureFinite(options.indexPrice, 'indexPrice', 'betaWeightedDelta');
  if (!(options.indexPrice > 0)) {
    throw new InputError(`betaWeightedDelta: indexPrice must be > 0, got ${options.indexPrice}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { indexPrice: options.indexPrice },
    });
  }
  let dollarDelta = 0;
  const perPosition = positions.map((p, i) => {
    ensureFinite(p.delta, `positions[${i}].delta`, 'betaWeightedDelta');
    ensureFinite(p.spot, `positions[${i}].spot`, 'betaWeightedDelta');
    ensureFinite(p.beta, `positions[${i}].beta`, 'betaWeightedDelta');
    const dd = p.delta * p.spot * p.beta;
    dollarDelta += dd;
    return { dollarDelta: dd, indexDelta: dd / options.indexPrice };
  });
  return {
    indexDelta: dollarDelta / options.indexPrice,
    dollarDelta,
    perPosition,
    // The reference the whole read-out is expressed against (dx §2.4).
    ...portfolioReport({ indexPrice: options.indexPrice, positions: positions.length }),
  };
}
