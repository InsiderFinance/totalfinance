/**
 * Bond futures & cheapest-to-deliver analytics (spec: `docs/specs/bond-future-ctd.md`, roadmap Tier 2).
 * A Treasury future settles against a *basket* of deliverable bonds, each scaled by a published
 * conversion factor; the short delivers whichever is cheapest. This module computes the CME/CBOT
 * conversion factor, the gross/net basis, carry, and the (repo-independent) implied repo rate for each
 * deliverable, and picks the cheapest-to-deliver — composing the existing `Bond` machinery (accrued
 * interest, cash flows) rather than introducing a new instrument model.
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
import { ensureBooleanWhenPresent } from './validate.js';
import { brent } from '@totalfinance/math';
import { compareDates, yearFraction } from './conventions.js';
import { type Bond, priceFromYield, yieldMetrics, yieldToMaturity } from './bonds.js';

const DEFAULT_NOTIONAL_COUPON = 0.06;

// ---------------------------------------------------------------------------------------------------
// Conversion factor (CME/CBOT)
// ---------------------------------------------------------------------------------------------------

/** Input for {@link conversionFactor}. */
export interface ConversionFactorInput {
  /** The deliverable bond — its (semiannual) coupon and maturity drive the factor. */
  bond: Bond;
  /** The conversion factor is computed as of the first day of THIS date's month. */
  deliveryDate: string;
  /** The contract's notional coupon (decimal); default `0.06` (CME Treasury futures). */
  notionalCoupon?: number;
}

/** The conversion factor plus the rounding breakdown that produced it. */
export interface ConversionFactorResult {
  /** Price per $1 face that makes the bond yield the notional coupon on the first delivery day. */
  factor: number;
  /** Whole years to maturity after rounding down to a quarter (`n`). */
  wholeYears: number;
  /** Residual months after rounding, `z ∈ {0, 3, 6, 9}`. */
  extraMonths: number;
  notionalCoupon: number;
  assumptions: { conventionsVersion: string; couponFrequency: 'semiannual' };
  diagnostics: Diagnostics;
}

/** The rounding + factor, shared by `conversionFactor` and `bondFuture`. */
function computeFactor(
  couponRate: number,
  deliveryDate: string,
  maturityDate: string,
  notionalCoupon: number,
  functionName: string,
): { factor: number; n: number; z: number } {
  const del = parseIsoDate(deliveryDate);
  const mat = parseIsoDate(maturityDate);
  // Time from the FIRST day of the delivery month to maturity, in whole months, floored to a quarter.
  const months = (mat.year - del.year) * 12 + (mat.month - del.month);
  if (months <= 0) {
    throw new InputError(
      `${functionName}: bond maturing ${maturityDate} does not mature after the delivery month of ${deliveryDate}; it is not deliverable.`,
      { code: ErrorCode.InputOutOfRange, context: { maturityDate, deliveryDate, months } },
    );
  }
  const rounded = months - (months % 3);
  const n = Math.floor(rounded / 12);
  const z = rounded - 12 * n; // 0, 3, 6, or 9

  const semi = notionalCoupon / 2;
  const base = z < 7 ? Math.pow(1 + semi, -2 * n) : Math.pow(1 + semi, -(2 * n + 1));
  const v = z < 7 ? z : z - 6;
  const a = Math.pow(1 + semi, -v / 6);
  const b = (couponRate / 2) * ((6 - v) / 6);
  const d = (couponRate / notionalCoupon) * (1 - base);
  const factor = a * (couponRate / 2 + base + d) - b;
  return { factor, n, z };
}

/**
 * The CME/CBOT conversion factor for a deliverable bond: the price per $1 face that would make it yield
 * the contract's notional coupon (default 6%) on the first day of the delivery month, with the time to
 * maturity rounded down to whole quarters. Assumes semiannual coupons (Treasury/Gilt convention).
 * See `docs/specs/bond-future-ctd.md`.
 */
export function conversionFactor(input: ConversionFactorInput): ConversionFactorResult {
  const functionName = 'conversionFactor';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['bond', 'deliveryDate', 'notionalCoupon']);
  requireArgumentObject(functionName, 'bond', input.bond);
  if (typeof input.deliveryDate !== 'string') {
    throw new InputError(`${functionName}: deliveryDate (an ISO date string) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'deliveryDate' },
    });
  }
  ensureFiniteWhenPresent(input.notionalCoupon, 'notionalCoupon', functionName);
  const notionalCoupon = input.notionalCoupon ?? DEFAULT_NOTIONAL_COUPON;
  ensurePositive(notionalCoupon, 'notionalCoupon', functionName);
  ensureFinite(input.bond.couponRate, 'bond.couponRate', functionName);

  const { factor, n, z } = computeFactor(
    input.bond.couponRate,
    input.deliveryDate,
    input.bond.maturityDate,
    notionalCoupon,
    functionName,
  );

  const warnings: QuantWarning[] = [];
  if (input.bond.frequency !== 2) {
    warnings.push(
      warning(
        'fixedIncome.cf_non_semiannual',
        `${functionName}: the conversion-factor formula assumes semiannual coupons, but the bond pays ${input.bond.frequency}×/year — treat the factor as an approximation.`,
        'warn',
        { frequency: input.bond.frequency },
      ),
    );
  }

  return {
    factor,
    wholeYears: n,
    extraMonths: z,
    notionalCoupon,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, couponFrequency: 'semiannual' },
    diagnostics: {
      engine: 'bond-future-conversion-factor',
      method: 'cme whole-quarter',
      converged: true,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Bond future basis / carry / implied repo / CTD
// ---------------------------------------------------------------------------------------------------

/** One deliverable in the futures basket. */
export interface DeliverableBond {
  bond: Bond;
  /** Clean market price per 100 face. */
  cleanPrice: number;
  /** Label for reporting; defaults to the basket index. */
  id?: string;
  /** Exchange-published conversion factor; if omitted, computed via the CME formula. */
  conversionFactor?: number;
}

/** {@link DeliverableBond} keys (Law 12 — mirrors the interface above; keep in sync). */
const DELIVERABLE_BOND_KEYS = ['bond', 'cleanPrice', 'id', 'conversionFactor'] as const;

/** Input for {@link bondFuture}. */
export interface BondFutureInput {
  /** Futures price per 100 face. */
  futuresPrice: number;
  /** Settlement date — when the cash bond is bought (ISO). */
  settlementDate: string;
  /** Delivery date — when the short delivers into the future (ISO). */
  deliveryDate: string;
  /** ACT/360 financing (repo) rate (decimal) used for carry / net basis. */
  repoRate: number;
  /** The contract's notional coupon (decimal); default `0.06`. */
  notionalCoupon?: number;
  deliverables: DeliverableBond[];
}

/** {@link BondFutureInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const BOND_FUTURE_INPUT_KEYS = [
  'futuresPrice',
  'settlementDate',
  'deliveryDate',
  'repoRate',
  'notionalCoupon',
  'deliverables',
] as const;

/**
 * A JSON-safe digest of the deliverable basket, for error contexts.
 *
 * An error context is a public payload: it is logged, serialized, and shown to an agent. A `Bond`
 * is a closure-carrying object, so spreading the raw input into `context` put whole bonds (methods,
 * the entire schedule) in there — the methods vanish through `JSON.stringify`, leaving a shape that
 * is simultaneously bloated and uninformative, and no way to tell WHICH bond the error meant. The
 * identifying facts are the id and the maturity, so those are what travel.
 */
function summarizeDeliverables(deliverables: unknown): { id: string; maturityDate?: string }[] {
  if (!Array.isArray(deliverables)) return [];
  return deliverables.map((entry, i) => {
    const row = entry as { id?: string; bond?: { maturityDate?: string } } | null | undefined;
    const maturityDate = row?.bond?.maturityDate;
    return {
      id: row?.id ?? String(i),
      ...(typeof maturityDate === 'string' ? { maturityDate } : {}),
    };
  });
}

/**
 * Deliverables carry Bond INSTANCES (from `bonds.fixedRate(...)` et al.) — a raw spec object would
 * crash on the first `accrued()`/`futureCashflows()` call inside the basis loop; teach the fix at
 * the boundary instead (the same pattern as `requireBondInstance` in bonds).
 */
function requireDeliverableBondInstance(functionName: string, field: string, bond: unknown): void {
  const b = bond as { accrued?: unknown; futureCashflows?: unknown };
  if (typeof b.accrued !== 'function' || typeof b.futureCashflows !== 'function') {
    throw new InputError(
      `${functionName}: ${field} must be a bond built by bonds.fixedRate(...) / bonds.zeroCoupon(...) (a Bond ` +
        `instance with cash-flow methods), not a raw specification object. Build the bond first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

/** The full basis analysis for one deliverable. */
export interface DeliverableAnalysis {
  id: string;
  conversionFactor: number;
  conversionFactorSource: 'computed' | 'supplied';
  cleanPrice: number;
  accruedAtSettlement: number;
  accruedAtDelivery: number;
  /** Interim coupons paid in `(settlement, delivery]`. */
  interimCoupons: number;
  /** Dirty purchase cost today (`cleanPrice + accruedAtSettlement`). */
  purchaseCost: number;
  /** What the short receives on delivery (`F·CF + accruedAtDelivery`). */
  invoicePrice: number;
  /** `cleanPrice − F·CF`. */
  grossBasis: number;
  /** `coupon income − financing cost` over the hold. */
  carry: number;
  /** `grossBasis − carry`. */
  netBasis: number;
  /** Annualized break-even return of the buy-and-deliver trade (ACT/360). */
  impliedRepoRate: number;
  isCheapestToDeliver: boolean;
}

/** The bond-future basket analysis. */
export interface BondFutureResult {
  /** Per-deliverable rows, sorted by implied repo rate descending (CTD first). */
  deliverables: DeliverableAnalysis[];
  /** The cheapest-to-deliver (max implied repo rate). */
  cheapestToDeliver: DeliverableAnalysis;
  yearsToDelivery: number;
  summary: string;
  assumptions: {
    conventionsVersion: string;
    futuresPrice: number;
    repoRate: number;
    notionalCoupon: number;
    settlementDate: string;
    deliveryDate: string;
  };
  diagnostics: Diagnostics;
}

const money = (x: number): string => x.toFixed(3);
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/**
 * Bond-future basis, carry, implied repo rate, and cheapest-to-deliver across a basket. See
 * `docs/specs/bond-future-ctd.md`.
 */
export function bondFuture(input: BondFutureInput): BondFutureResult {
  const functionName = 'bondFuture';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, BOND_FUTURE_INPUT_KEYS);
  ensurePositive(input.futuresPrice, 'futuresPrice', functionName);
  ensureFinite(input.repoRate, 'repoRate', functionName);
  if (typeof input.settlementDate !== 'string' || typeof input.deliveryDate !== 'string') {
    throw new InputError(
      `${functionName}: settlementDate and deliveryDate (ISO date strings) are required.`,
      {
        code: ErrorCode.InputMissingField,
        context: { settlementDate: input.settlementDate, deliveryDate: input.deliveryDate },
      },
    );
  }
  if (compareDates(input.settlementDate, input.deliveryDate) >= 0) {
    throw new InputError(
      `${functionName}: deliveryDate ${input.deliveryDate} must be after settlementDate ${input.settlementDate}.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: {
          settlementDate: input.settlementDate,
          deliveryDate: input.deliveryDate,
          futuresPrice: input.futuresPrice,
          repoRate: input.repoRate,
          deliverables: summarizeDeliverables(input.deliverables),
        },
      },
    );
  }
  if (!Array.isArray(input.deliverables) || input.deliverables.length === 0) {
    throw new InputError(`${functionName}: at least one deliverable bond is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'deliverables' },
    });
  }
  ensureFiniteWhenPresent(input.notionalCoupon, 'notionalCoupon', functionName);
  const notionalCoupon = input.notionalCoupon ?? DEFAULT_NOTIONAL_COUPON;
  ensurePositive(notionalCoupon, 'notionalCoupon', functionName);

  const F = input.futuresPrice;
  const repo = input.repoRate;
  const settle = input.settlementDate;
  const delivery = input.deliveryDate;
  const tau = yearFraction(settle, delivery, 'ACT/360');

  let nonSemiannual = false;
  const rows: DeliverableAnalysis[] = input.deliverables.map((d, i) => {
    requireArgumentObject(functionName, `deliverables[${i}]`, d);
    ensureKnownKeys(functionName, `deliverables[${i}]`, d, DELIVERABLE_BOND_KEYS);
    requireArgumentObject(functionName, `deliverables[${i}].bond`, d.bond);
    requireDeliverableBondInstance(functionName, `deliverables[${i}].bond`, d.bond);
    ensurePositive(d.cleanPrice, `deliverables[${i}].cleanPrice`, functionName);
    const bond = d.bond;
    if (bond.frequency !== 2) nonSemiannual = true;

    let cf: number;
    let source: 'computed' | 'supplied';
    if (d.conversionFactor !== undefined) {
      ensurePositive(d.conversionFactor, `deliverables[${i}].conversionFactor`, functionName);
      cf = d.conversionFactor;
      source = 'supplied';
    } else {
      cf = computeFactor(
        bond.couponRate,
        delivery,
        bond.maturityDate,
        notionalCoupon,
        functionName,
      ).factor;
      source = 'computed';
    }

    const aiS = bond.accrued(settle);
    const aiD = bond.accrued(delivery);
    // Interim coupons paid in (settlement, delivery]: futureCashflows already excludes date <= settle.
    const interim = bond.futureCashflows(settle).filter((f) => compareDates(f.date, delivery) <= 0);
    const coupons = interim.reduce((s, f) => s + f.amount, 0);
    const sumCouponTime = interim.reduce(
      (s, f) => s + f.amount * yearFraction(f.paymentDate, delivery, 'ACT/360'),
      0,
    );

    const purchaseCost = d.cleanPrice + aiS;
    const invoicePrice = F * cf + aiD;
    const denom = purchaseCost * tau - sumCouponTime;
    if (!(denom > 0)) {
      throw new InputError(
        `${functionName}: degenerate cash-and-carry for deliverable ${d.id ?? i} (financing base ${denom} ≤ 0); implied repo is undefined.`,
        { code: ErrorCode.InputOutOfRange, context: { id: d.id ?? i, denom, tau } },
      );
    }
    const impliedRepoRate = (invoicePrice + coupons - purchaseCost) / denom;
    const grossBasis = d.cleanPrice - F * cf;
    const carry = coupons + aiD - aiS - purchaseCost * repo * tau;
    const netBasis = grossBasis - carry;

    return {
      id: d.id ?? String(i),
      conversionFactor: cf,
      conversionFactorSource: source,
      cleanPrice: d.cleanPrice,
      accruedAtSettlement: aiS,
      accruedAtDelivery: aiD,
      interimCoupons: coupons,
      purchaseCost,
      invoicePrice,
      grossBasis,
      carry,
      netBasis,
      impliedRepoRate,
      isCheapestToDeliver: false,
    };
  });

  // CTD = the max implied-repo-rate deliverable; sort CTD-first.
  rows.sort((x, y) => y.impliedRepoRate - x.impliedRepoRate);
  rows[0]!.isCheapestToDeliver = true;
  const ctd = rows[0]!;

  const warnings: QuantWarning[] = [];
  if (nonSemiannual) {
    warnings.push(
      warning(
        'fixedIncome.cf_non_semiannual',
        `${functionName}: one or more deliverables do not pay semiannually; their computed conversion factors are approximate (supply an exchange factor to be exact).`,
        'warn',
      ),
    );
  }

  const summary =
    `CTD is ${ctd.id} (implied repo ${pct(ctd.impliedRepoRate)}, net basis ${money(ctd.netBasis)}) ` +
    `of ${rows.length} deliverable${rows.length === 1 ? '' : 's'}; gross basis ${money(ctd.grossBasis)}, ` +
    `carry ${money(ctd.carry)} over ${tau.toFixed(3)}y to delivery.`;

  return {
    deliverables: rows,
    cheapestToDeliver: ctd,
    yearsToDelivery: tau,
    summary,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      futuresPrice: F,
      repoRate: repo,
      notionalCoupon,
      settlementDate: settle,
      deliveryDate: delivery,
    },
    diagnostics: {
      engine: 'bond-future',
      method: 'basis + carry + implied-repo CTD',
      converged: true,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Bond-future DV01 hedge & futures-implied yield
// ---------------------------------------------------------------------------------------------------

/** Input for {@link bondFutureHedge} — the basket plus an optional position to hedge. */
export interface BondFutureHedgeInput extends BondFutureInput {
  /** DV01 (per 100 face) of the position to hedge; when given, the result reports `hedgeRatio`. */
  hedgeDv01?: number;
}

/** {@link BondFutureHedgeInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const BOND_FUTURE_HEDGE_INPUT_KEYS = [...BOND_FUTURE_INPUT_KEYS, 'hedgeDv01'] as const;

/** Per-deliverable interest-rate risk. */
export interface DeliverableRisk {
  id: string;
  conversionFactor: number;
  /** Spot yield of the deliverable at its market clean price. */
  yield: number;
  /** DV01 of the cash bond per 100 face. */
  dv01: number;
  /** DV01 the futures inherit through this bond: `dv01 / CF`. */
  futuresDv01ViaBond: number;
}

/** The bond-future hedge analysis. */
export interface BondFutureHedgeResult {
  ctdId: string;
  ctdConversionFactor: number;
  /** Spot yield of the CTD at its market clean price. */
  ctdYield: number;
  /** DV01 of the CTD cash bond per 100 face (at its market yield). */
  ctdDv01: number;
  /** The futures contract's DV01 per 100 face of notional (`ctdDv01 / CF_ctd`). */
  futuresDv01: number;
  /** The CTD yield the futures price implies at the forward clean price `F·CF`, as of delivery. */
  impliedForwardYield: number;
  /** # futures (per 100 face) whose DV01 offsets `hedgeDv01` — SELL them to hedge a long book. Present iff `hedgeDv01` was supplied. */
  hedgeRatio?: number;
  /** Per-deliverable spot yield + DV01 across the basket (CTD first). */
  deliverables: DeliverableRisk[];
  assumptions: {
    conventionsVersion: string;
    futuresPrice: number;
    settlementDate: string;
    deliveryDate: string;
  };
  diagnostics: Diagnostics;
}

/**
 * Bond-future DV01 hedge ratio and futures-implied yield. Composes {@link bondFuture} (to find the CTD and
 * the conversion factors) with the bond yield/DV01 analytics: the futures DV01 is the CTD's DV01 divided by
 * its conversion factor (Hull), so a `hedgeDv01` of risk is offset by `hedgeDv01 / futuresDv01` contracts —
 * exactly `CF` to hedge the CTD itself. Also reports the CTD yield implied by the forward clean price
 * `F·CF`. See `docs/specs/bond-future-hedge.md`.
 */
export function bondFutureHedge(input: BondFutureHedgeInput): BondFutureHedgeResult {
  const functionName = 'bondFutureHedge';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, BOND_FUTURE_HEDGE_INPUT_KEYS);
  const { hedgeDv01, ...basketInput } = input;
  if (hedgeDv01 !== undefined) ensureFinite(hedgeDv01, 'hedgeDv01', functionName);

  // The CTD, conversion factors, and basis come from bondFuture (one source of truth). The basket
  // input is the hedge input minus `hedgeDv01` — bondFuture rejects keys it does not own (Law 12).
  const basket = bondFuture(basketInput);
  const settle = input.settlementDate;
  const delivery = input.deliveryDate;
  const F = input.futuresPrice;

  // Map each result row back to its input bond (row id = deliverable id ?? basket index).
  const bondById = new Map<string, Bond>();
  input.deliverables.forEach((d, i) => bondById.set(d.id ?? String(i), d.bond));

  const deliverables: DeliverableRisk[] = basket.deliverables.map((row) => {
    const bond = bondById.get(row.id)!;
    const y = yieldToMaturity(bond, { settlementDate: settle, price: row.cleanPrice });
    const dv01 = yieldMetrics(bond, { settlementDate: settle, yield: y }).dv01;
    return {
      id: row.id,
      conversionFactor: row.conversionFactor,
      yield: y,
      dv01,
      futuresDv01ViaBond: dv01 / row.conversionFactor,
    };
  });

  const ctdRow = basket.cheapestToDeliver;
  const ctd = deliverables.find((d) => d.id === ctdRow.id)!;
  const futuresDv01 = ctd.futuresDv01ViaBond; // = ctdDv01 / CF_ctd
  const ctdBond = bondById.get(ctdRow.id)!;
  // The futures-implied forward yield: the CTD's yield at its forward clean price F·CF, as of delivery.
  const impliedForwardYield = yieldToMaturity(ctdBond, {
    settlementDate: delivery,
    price: F * ctdRow.conversionFactor,
  });

  return {
    ctdId: ctd.id,
    ctdConversionFactor: ctd.conversionFactor,
    ctdYield: ctd.yield,
    ctdDv01: ctd.dv01,
    futuresDv01,
    impliedForwardYield,
    ...(hedgeDv01 !== undefined ? { hedgeRatio: hedgeDv01 / futuresDv01 } : {}),
    deliverables,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      futuresPrice: F,
      settlementDate: settle,
      deliveryDate: delivery,
    },
    diagnostics: {
      engine: 'bond-future-hedge',
      method: 'ctd dv01 / CF + implied forward yield',
      converged: true,
      warnings: basket.diagnostics.warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Bond-future CTD switching frontier + delivery-date DV01 (Wave 6)
// ---------------------------------------------------------------------------------------------------

/**
 * A parallel-yield-shift grid: either an explicit list of basis-point shifts, or an inclusive
 * `{ from, to, step }` range. The default (`{ from: -200, to: 200, step: 25 }`) resolves to 17 ordered
 * nodes and contains a zero node.
 */
export type YieldShiftGrid = readonly number[] | { from: number; to: number; step: number };

/** Input for {@link bondFutureCtdFrontier} — a {@link BondFutureInput} basket plus the scan controls. */
export interface BondFutureCtdFrontierInput extends BondFutureInput {
  /** Parallel yield shifts (bp) to scan. Default `{ from: -200, to: 200, step: 25 }` (17 nodes incl. 0). */
  yieldShiftsBp?: YieldShiftGrid;
  /**
   * Optional futures-price path, one entry per *explicit* shift (the `(shift, price)` pairs are sorted
   * together). Omit to hold the input futures quote constant across the scan (a ceteris-paribus basis
   * question). A discrete path does not define values between nodes, so its switches stay grid-labeled.
   */
  futuresPrices?: readonly number[];
  /** Refine held-constant-policy switch brackets to a crossing; default `true`. Invalid with `futuresPrices`. */
  refineSwitches?: boolean;
  /** Maximum reported switch-location bracket width in shift basis points; default `0.01`. */
  switchLocationToleranceBp?: number;
}

/** {@link BondFutureCtdFrontierInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const BOND_FUTURE_CTD_FRONTIER_INPUT_KEYS = [
  ...BOND_FUTURE_INPUT_KEYS,
  'yieldShiftsBp',
  'futuresPrices',
  'refineSwitches',
  'switchLocationToleranceBp',
] as const;

/** One node of the CTD frontier scan: the whole basket, repriced at a parallel shift + a futures price. */
export interface CtdFrontierScenario {
  /** The parallel yield shift (bp) applied to every deliverable's current yield. */
  yieldShiftBp: number;
  /** The futures price used at this node (held constant, or the supplied path entry). */
  futuresPrice: number;
  /** The cheapest-to-deliver at this node. */
  ctdId: string;
  /** The CTD's net basis at this node. */
  netBasis: number;
  /** The CTD's implied repo rate at this node. */
  impliedRepoRate: number;
  /** The full per-deliverable basis rows at this node (CTD first), straight from {@link bondFuture}. */
  deliverables: DeliverableAnalysis[];
}

/** A cheapest-to-deliver switch between two frontier nodes. */
export interface CtdSwitch {
  /** The CTD on the low-shift side of the transition. */
  fromCtd: string;
  /** The CTD on the high-shift side of the transition. */
  toCtd: string;
  /** The refined (or grid) bracket, in shift bp, that contains the transition. */
  bracketBp: readonly [number, number];
  /** Best estimate of the switch shift (bp): the root under `root-refined`, else the bracket midpoint. */
  estimatedSwitchBp: number;
  /**
   * `root-refined` — the two rivals' implied-repo rates were equalized to tolerance and neither is
   * beaten by a third deliverable at the root. `grid-midpoint` — a discrete futures path (no
   * interpolation) or a bracket that could not be root-refined; the estimate is the bracket midpoint.
   */
  method: 'root-refined' | 'grid-midpoint';
}

/** The bond-future CTD switching-frontier analysis. */
export interface BondFutureCtdFrontierResult {
  /** The current (unshifted) cheapest-to-deliver. */
  current: { ctdId: string; ctdYield: number; conversionFactor: number };
  /** Every scanned node, ordered by ascending yield shift. */
  scenarios: CtdFrontierScenario[];
  /** Every CTD switch across the scan (a third-deliverable window splits into two transitions). */
  switches: CtdSwitch[];
  risk: {
    /** The current futures DV01 from the spot cash DV01 / CF (matches {@link bondFutureHedge}). */
    spotFuturesDv01: number;
    /** The futures DV01 from the CTD's *forward* DV01 at the delivery date / CF — the delivery risk. */
    deliveryDateFuturesDv01: number;
    /** The CTD yield the futures price implies at the forward clean price `F·CF`, as of delivery. */
    impliedForwardYield: number;
  };
  assumptions: {
    conventionsVersion: string;
    settlementDate: string;
    deliveryDate: string;
    futuresPriceScenario: 'held-constant' | 'supplied-path';
    yieldShock: 'parallel';
    yieldShiftsBp: number[];
    refineSwitches: boolean;
    switchLocationToleranceBp: number | null;
    /** Internal global-tie test, decimal annualized implied-repo rate; a fixed library assumption. */
    repoRateTieTolerance: 1e-10;
  };
  diagnostics: Diagnostics;
}

/** The internal global-tie tolerance (decimal annualized implied-repo rate) — not a caller knob. */
const REPO_RATE_TIE_TOLERANCE = 1e-10 as const;
const DEFAULT_SWITCH_LOCATION_TOL_BP = 0.01;

/** Build an inclusive `[from, to]` range of shifts stepped by `step`; validates the range shape. */
function buildShiftRange(
  range: { from: number; to: number; step: number },
  functionName: string,
): number[] {
  const { from, to, step } = range;
  ensureFinite(from, 'yieldShiftsBp.from', functionName);
  ensureFinite(to, 'yieldShiftsBp.to', functionName);
  ensureFinite(step, 'yieldShiftsBp.step', functionName);
  if (!(step > 0)) {
    throw new InputError(`${functionName}: yieldShiftsBp.step must be positive, got ${step}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { step },
    });
  }
  if (!(to > from)) {
    throw new InputError(
      `${functionName}: yieldShiftsBp.to (${to}) must be greater than yieldShiftsBp.from (${from}).`,
      { code: ErrorCode.InputOutOfRange, context: { from, to } },
    );
  }
  const n = Math.round((to - from) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(from + i * step);
  return out;
}

/** Resolve the shift grid; when a futures path is present, an explicit aligned array is required. */
function resolveYieldShifts(
  specification: YieldShiftGrid | undefined,
  hasFuturesPath: boolean,
  functionName: string,
): { shifts: number[]; explicit: boolean } {
  if (specification === undefined) {
    if (hasFuturesPath) {
      throw new InputError(
        `${functionName}: futuresPrices requires an explicit yieldShiftsBp array to align one-for-one with; the default range cannot be aligned to a discrete price path.`,
        { code: ErrorCode.InputWrongType, context: { field: 'yieldShiftsBp' } },
      );
    }
    return {
      shifts: buildShiftRange({ from: -200, to: 200, step: 25 }, functionName),
      explicit: false,
    };
  }
  if (Array.isArray(specification)) {
    const arr = specification as readonly number[];
    if (arr.length === 0) {
      throw new InputError(`${functionName}: yieldShiftsBp must contain at least one shift.`, {
        code: ErrorCode.InputMissingField,
        context: { field: 'yieldShiftsBp' },
      });
    }
    arr.forEach((v, i) => ensureFinite(v, `yieldShiftsBp[${i}]`, functionName));
    return { shifts: [...arr], explicit: true };
  }
  // Not an array: the range object. (`Array.isArray` cannot narrow the `readonly number[]` branch out
  // of the union, so name the range shape explicitly after the guard above.)
  const range = specification as { from: number; to: number; step: number };
  requireArgumentObject(functionName, 'yieldShiftsBp', range);
  ensureKnownKeys(functionName, 'yieldShiftsBp', range, ['from', 'to', 'step'] as const);
  if (hasFuturesPath) {
    throw new InputError(
      `${functionName}: futuresPrices requires an explicit yieldShiftsBp array; a { from, to, step } range does not pin the alignment of a discrete price path.`,
      { code: ErrorCode.InputWrongType, context: { field: 'yieldShiftsBp' } },
    );
  }
  return { shifts: buildShiftRange(range, functionName), explicit: false };
}

/**
 * The cheapest-to-deliver *frontier*: how the CTD identity and the futures risk move under explicit
 * parallel-yield (and optional futures-price) scenarios. This is a **switching frontier**, not a
 * valuation of the short's timing/quality delivery option (which stays deferred). It composes
 * {@link bondFuture} at every node (one source of basis/carry/implied-repo truth), reprices each
 * deliverable with {@link priceFromYield}, refines held-constant switch brackets by re-evaluating the
 * *whole* basket (so a narrow third-deliverable window splits into two honest transitions and no
 * pairwise root off the global frontier is accepted), and reports the delivery-date futures DV01 from
 * the CTD's futures-implied forward yield — distinct from the spot cash DV01 / CF. See
 * `docs/specs/wave6-quant-moats.md` §1 and `docs/specs/bond-future-ctd.md`.
 */
export function bondFutureCtdFrontier(
  input: BondFutureCtdFrontierInput,
): BondFutureCtdFrontierResult {
  const functionName = 'bondFutureCtdFrontier';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, BOND_FUTURE_CTD_FRONTIER_INPUT_KEYS);

  const hasFuturesPath = input.futuresPrices !== undefined;

  // refineSwitches defaults true, but a discrete futures path forbids interpolated refinement.
  let refine: boolean;
  if (hasFuturesPath) {
    if (input.refineSwitches === true) {
      throw new InputError(
        `${functionName}: refineSwitches is invalid with a supplied futuresPrices path — a discrete price path does not define values between nodes, so switches cannot be root-refined without inventing an interpolation.`,
        { code: ErrorCode.InputOutOfRange, context: { refineSwitches: true } },
      );
    }
    refine = false;
  } else {
    ensureBooleanWhenPresent(input.refineSwitches, functionName, 'refineSwitches');
    refine = input.refineSwitches ?? true;
  }

  const tolBp = input.switchLocationToleranceBp ?? DEFAULT_SWITCH_LOCATION_TOL_BP;
  if (input.switchLocationToleranceBp !== undefined) {
    ensureFinite(input.switchLocationToleranceBp, 'switchLocationToleranceBp', functionName);
    ensurePositive(input.switchLocationToleranceBp, 'switchLocationToleranceBp', functionName);
  }

  const { shifts, explicit } = resolveYieldShifts(
    input.yieldShiftsBp,
    hasFuturesPath,
    functionName,
  );

  // Pair each shift with its futures price, then order by ascending shift and reject duplicates.
  let nodes: Array<{ shift: number; futuresPrice: number }>;
  if (hasFuturesPath) {
    const prices = input.futuresPrices as readonly number[];
    if (!explicit) {
      // Unreachable (resolveYieldShifts throws first), but keeps the invariant explicit for readers.
      throw new InputError(
        `${functionName}: futuresPrices requires an explicit yieldShiftsBp array.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: 'yieldShiftsBp' },
        },
      );
    }
    if (prices.length !== shifts.length) {
      throw new InputError(
        `${functionName}: futuresPrices (${prices.length}) must align one-for-one with yieldShiftsBp (${shifts.length}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { prices: prices.length, shifts: shifts.length },
        },
      );
    }
    prices.forEach((p, i) => ensurePositive(p, `futuresPrices[${i}]`, functionName));
    nodes = shifts.map((s, i) => ({ shift: s, futuresPrice: prices[i]! }));
  } else {
    nodes = shifts.map((s) => ({ shift: s, futuresPrice: input.futuresPrice }));
  }
  nodes.sort((a, b) => a.shift - b.shift);
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]!.shift === nodes[i - 1]!.shift) {
      throw new InputError(
        `${functionName}: yieldShiftsBp contains a duplicate shift (${nodes[i]!.shift}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { shift: nodes[i]!.shift },
        },
      );
    }
  }

  // The current (unshifted) CTD, per-deliverable spot yields, and the spot futures risk all come from
  // bondFutureHedge — one source of truth. Rebuild the basket with only its keys (the frontier-only
  // controls would be rejected by bondFuture's Law-12 unknown-key guard).
  const basketInput: BondFutureInput = {
    futuresPrice: input.futuresPrice,
    settlementDate: input.settlementDate,
    deliveryDate: input.deliveryDate,
    repoRate: input.repoRate,
    ...(input.notionalCoupon !== undefined ? { notionalCoupon: input.notionalCoupon } : {}),
    deliverables: input.deliverables,
  };
  const hedge = bondFutureHedge(basketInput);

  const settle = input.settlementDate;
  const delivery = input.deliveryDate;
  const heldFuturesPrice = input.futuresPrice;

  // Map each deliverable to its id, bond, and current (spot) yield for shifting.
  const yieldById = new Map(hedge.deliverables.map((d) => [d.id, d.yield]));
  const scanBonds = basketInput.deliverables.map((d, i) => {
    const id = d.id ?? String(i);
    const baseYield = yieldById.get(id);
    if (baseYield === undefined) {
      throw new InputError(
        `${functionName}: could not resolve a spot yield for deliverable ${id}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { id },
        },
      );
    }
    return { deliverable: d, id, baseYield };
  });

  /** Reprice the whole basket at a parallel shift + a futures price, via bondFuture (one truth). */
  function basketAtShift(shiftBp: number, futuresPrice: number): BondFutureResult {
    const deliverables: DeliverableBond[] = scanBonds.map(({ deliverable, baseYield }) => ({
      ...deliverable,
      cleanPrice: priceFromYield(deliverable.bond, {
        settlementDate: settle,
        yield: baseYield + shiftBp / 1e4,
      }).cleanPrice,
    }));
    return bondFuture({
      futuresPrice,
      settlementDate: settle,
      deliveryDate: delivery,
      repoRate: input.repoRate,
      ...(input.notionalCoupon !== undefined ? { notionalCoupon: input.notionalCoupon } : {}),
      deliverables,
    });
  }

  const scenarios: CtdFrontierScenario[] = nodes.map(({ shift, futuresPrice }) => {
    const r = basketAtShift(shift, futuresPrice);
    const ctd = r.cheapestToDeliver;
    return {
      yieldShiftBp: shift,
      futuresPrice,
      ctdId: ctd.id,
      netBasis: ctd.netBasis,
      impliedRepoRate: ctd.impliedRepoRate,
      deliverables: r.deliverables,
    };
  });

  const switchWarnings: QuantWarning[] = [];

  /** The global CTD id and every deliverable's implied repo (held-constant policy) at a shift. */
  function ctdAt(shiftBp: number): { id: string; irr: Map<string, number> } {
    const r = basketAtShift(shiftBp, heldFuturesPrice);
    return {
      id: r.cheapestToDeliver.id,
      irr: new Map(r.deliverables.map((d) => [d.id, d.impliedRepoRate])),
    };
  }

  /** Root-refine a narrow adjacent-winner bracket, or fall back to an honest grid midpoint. */
  function rootRefineOrMidpoint(a: number, b: number, ctdA: string, ctdB: string): CtdSwitch {
    const irrDiff = (shift: number): number => {
      const { irr } = ctdAt(shift);
      return (irr.get(ctdA) ?? NaN) - (irr.get(ctdB) ?? NaN);
    };
    const root = brent(irrDiff, a, b, {
      stepTolerance: 1e-12,
      residualTolerance: REPO_RATE_TIE_TOLERANCE * 1e-3,
      maximumIterations: 200,
    });
    if (root.converged && Number.isFinite(root.value)) {
      const { irr } = ctdAt(root.value);
      const irrA = irr.get(ctdA);
      const irrB = irr.get(ctdB);
      if (
        irrA !== undefined &&
        irrB !== undefined &&
        Math.abs(irrA - irrB) <= REPO_RATE_TIE_TOLERANCE
      ) {
        // No third deliverable may beat the tied pair at the root, or it is not on the global frontier.
        let maxOther = -Infinity;
        for (const [id, v] of irr) if (id !== ctdA && id !== ctdB && v > maxOther) maxOther = v;
        if (maxOther - Math.max(irrA, irrB) <= REPO_RATE_TIE_TOLERANCE) {
          return {
            fromCtd: ctdA,
            toCtd: ctdB,
            bracketBp: [a, b],
            estimatedSwitchBp: root.value,
            method: 'root-refined',
          };
        }
      }
    }
    switchWarnings.push(
      warning(
        'fixedIncome.ctd_switch_unrefined',
        `${functionName}: the ${ctdA}→${ctdB} switch near [${a}, ${b}]bp could not be root-refined to the repo-rate tie tolerance; reporting the bracket midpoint.`,
        'info',
        { fromCtd: ctdA, toCtd: ctdB, bracketBp: [a, b] },
      ),
    );
    return {
      fromCtd: ctdA,
      toCtd: ctdB,
      bracketBp: [a, b],
      estimatedSwitchBp: (a + b) / 2,
      method: 'grid-midpoint',
    };
  }

  /**
   * Refine a bracket whose endpoints have different CTDs by re-evaluating the WHOLE basket at each
   * midpoint: if a third deliverable wins in the middle, split into two transitions (so a narrow
   * intermediate CTD is never skipped); otherwise narrow to the location tolerance and root-refine.
   */
  function refineBracket(a: number, b: number, ctdA: string, ctdB: string): CtdSwitch[] {
    if (b - a <= tolBp) return [rootRefineOrMidpoint(a, b, ctdA, ctdB)];
    const mid = (a + b) / 2;
    const midId = ctdAt(mid).id;
    if (midId === ctdA) return refineBracket(mid, b, ctdA, ctdB);
    if (midId === ctdB) return refineBracket(a, mid, ctdA, ctdB);
    return [...refineBracket(a, mid, ctdA, midId), ...refineBracket(mid, b, midId, ctdB)];
  }

  const switches: CtdSwitch[] = [];
  for (let i = 1; i < scenarios.length; i++) {
    const lo = scenarios[i - 1]!;
    const hi = scenarios[i]!;
    if (lo.ctdId === hi.ctdId) continue;
    if (refine) {
      switches.push(...refineBracket(lo.yieldShiftBp, hi.yieldShiftBp, lo.ctdId, hi.ctdId));
    } else {
      switches.push({
        fromCtd: lo.ctdId,
        toCtd: hi.ctdId,
        bracketBp: [lo.yieldShiftBp, hi.yieldShiftBp],
        estimatedSwitchBp: (lo.yieldShiftBp + hi.yieldShiftBp) / 2,
        method: 'grid-midpoint',
      });
    }
  }

  // Delivery-date futures DV01: the CTD's forward DV01 at the delivery date / CF (distinct from spot).
  const ctdBond = scanBonds.find((s) => s.id === hedge.ctdId)!.deliverable.bond;
  const deliveryDateFuturesDv01 =
    yieldMetrics(ctdBond, { settlementDate: delivery, yield: hedge.impliedForwardYield }).dv01 /
    hedge.ctdConversionFactor;

  return {
    current: {
      ctdId: hedge.ctdId,
      ctdYield: hedge.ctdYield,
      conversionFactor: hedge.ctdConversionFactor,
    },
    scenarios,
    switches,
    risk: {
      spotFuturesDv01: hedge.futuresDv01,
      deliveryDateFuturesDv01,
      impliedForwardYield: hedge.impliedForwardYield,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      settlementDate: settle,
      deliveryDate: delivery,
      futuresPriceScenario: hasFuturesPath ? 'supplied-path' : 'held-constant',
      yieldShock: 'parallel',
      yieldShiftsBp: nodes.map((n) => n.shift),
      refineSwitches: refine,
      switchLocationToleranceBp: refine ? tolBp : null,
      repoRateTieTolerance: REPO_RATE_TIE_TOLERANCE,
    },
    diagnostics: {
      engine: 'bond-future-ctd-frontier',
      method: 'parallel-shift scan + whole-basket switch refinement + delivery-date DV01',
      converged: true,
      warnings: [...hedge.diagnostics.warnings, ...switchWarnings],
    },
  };
}
