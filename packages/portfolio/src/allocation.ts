/**
 * `allocatePortfolio` (FC7 slice 4, Stage 4.4; tracker "Portfolio-side management" → "discrete
 * weight-to-quantity allocation with prices, lot sizes, minimum notionals, cash reserve,
 * transaction costs, and dust reporting"): target weights → executable quantities and cash
 * residuals, at an explicit instant, under the ONE target-resolution law in `policy-grammar.ts`.
 *
 * Laws this module executes:
 *
 * - **Weights are of net asset value.** A target notional is `weight × netAssetValue`; the cash
 *   target and the cash reserve are BOTH honoured (the plan intends to hold
 *   `reserve + cashTarget × netAssetValue`). Buys are funded by cash conservation — current cash
 *   plus sells minus the intended cash — and a plan whose buys are not funded is reported
 *   infeasible with the shortfall; nothing is scaled silently.
 * - **Rounding is toward zero** to the lot size (a short target rounds toward zero too: its
 *   magnitude shrinks); every rounding residual is reported per instrument and stays in cash.
 * - **Dust is explicit.** A trade whose notional is below `minimumNotional` is skipped, listed with
 *   its notional and its effect on cash, and the instrument is reported at its CURRENT quantity.
 * - **Missing goals are never defaulted.** Every unresolved target from the expansion is carried
 *   verbatim; a target with no price, a non-positive price, or a contradiction with the policy's
 *   allowed/restricted lists is an `unresolved` row, never a filled-in value.
 */

import type { EpochMs, OrderSide } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireRepresentableResult,
  resolveAsOf,
  sideOf,
} from '@totalfinance/core';
import type { CurrencyPairQuote } from './internal.js';
import {
  QUANTITY_DUST,
  convertWithQuotes,
  deepFreeze,
  ownValue,
  requireCurrencyCode,
  requireCurrencyPairQuoteShape,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requirePositiveNumberField,
  setOwnValue,
} from './internal.js';
import type { InstrumentClassification } from './pnl.js';
import { requireInstrumentClassification } from './pnl.js';
import type { InvestmentPolicy, ResolvedTargetSource, UnresolvedTarget } from './policy-grammar.js';
import {
  CASH_ASSET_CLASS,
  expandTargets,
  requireInvestmentPolicy,
  resolvePolicyTargets,
} from './policy-grammar.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

/** One instrument's price at the allocation instant, in its trading currency. */
export interface AllocationPrice {
  /** Finite; sign unconstrained (a target on a non-positive price is reported unresolved). */
  price: number;
  currency: string;
}

/** The transaction-cost model — every term optional and explicit; an omitted term estimates 0. */
export interface AllocationTransactionCosts {
  /** Base-currency commission per non-zero trade. */
  commissionPerTrade?: number;
  /** Base-currency commission per unit traded (× |quantity|). */
  commissionPerUnit?: number;
  /** Half-spread cost in basis points of |notional|. */
  spreadBasisPoints?: number;
  /** Market-impact/slippage cost in basis points of |notional|. */
  slippageBasisPoints?: number;
}

/** The sizing grammar {@link allocatePortfolio} and `proposePortfolioRebalance` share. */
export interface AllocationSizingInput {
  /** Lot size per instrument (> 0, finite). */
  lotSizes?: Record<string, number>;
  /** Lot size for instruments without a `lotSizes` row; when neither covers an instrument its quantity stays fractional. */
  defaultLotSize?: number;
  /** Base-currency notional below which a trade is dust (skipped and reported). */
  minimumNotional?: number;
  transactionCosts?: AllocationTransactionCosts;
}

export interface AllocatePortfolioInput extends AllocationSizingInput {
  /** Targets inline or via a model artifact (resolved at `asOf`). */
  policy: InvestmentPolicy;
  /** REQUIRED — model targets are dated; echoed on the result. */
  asOf: EpochMs | string;
  baseCurrency: string;
  /** The investable total in base currency (> 0). Weights are shares of this. */
  netAssetValue: number;
  /** Per instrument. Required for every instrument with a target or a holding. */
  prices: Record<string, AllocationPrice>;
  /** FC5 quotes; required exactly when a priced instrument's currency ≠ `baseCurrency`. */
  currencyConversions?: CurrencyPairQuote[];
  /** Signed quantity per instrument; omitted = no holdings. */
  currentHoldings?: Record<string, number>;
  /**
   * Units of the underlying per unit of quantity, per instrument (slice 5): an option's 100, a
   * futures contract size. Omitted = 1. Notional = quantity × price × multiplier; lot rounding
   * stays on quantity.
   */
  contractMultipliers?: Record<string, number>;
  instrumentClassification?: Record<string, InstrumentClassification>;
  /** Base currency held back from the investable amount (≥ 0), on top of the cash target. */
  cashReserve?: number;
}

/** One instrument's sizing. Notionals are base currency. */
export interface AllocationRow {
  instrumentId: string;
  targetWeight: number;
  /** `targetWeight × netAssetValue`. */
  targetNotional: number;
  /** The supplied price, in `currency`. */
  price: number;
  currency: string;
  priceInBaseCurrency: number;
  /** Units of the underlying per unit of quantity (1 unless the caller declared a multiplier). */
  contractMultiplier: number;
  currentQuantity: number;
  /** The rounded target quantity (toward zero to `lotSize`). */
  targetQuantity: number;
  /** `targetQuantity − currentQuantity` (signed: + buy, − sell); 0 when the trade is dust. */
  tradeQuantity: number;
  /** `tradeQuantity × priceInBaseCurrency` (signed). */
  tradeNotional: number;
  lotSize: number | null;
  /** `(unrounded target quantity − targetQuantity) × priceInBaseCurrency` — stays in cash. */
  roundingResidualNotional: number;
  /** The post-trade weight of NAV (the CURRENT weight when the trade is dust). */
  achievedWeight: number;
  dust: boolean;
  sourceGroups: string[];
  implied: boolean;
}

export interface AllocationTrade {
  instrumentId: string;
  side: 'buy' | 'sell';
  /** Unsigned magnitude. */
  quantity: number;
  /** `quantity × priceInBaseCurrency`, base currency. */
  estimatedNotional: number;
  /** The instrument's trading currency (the price's currency). */
  currency: string;
  /** Base-currency estimate under the cost model. */
  estimatedCost: number;
}

export interface AllocationDustRow {
  instrumentId: string;
  /** The skipped trade's signed base-currency notional (+ an unspent buy, − an unraised sell). */
  tradeNotional: number;
  reason: string;
}

export interface AllocationCash {
  targetWeight: number;
  reserve: number;
  /** `reserve + targetWeight × netAssetValue` — the cash the plan intends to hold. */
  targetAmount: number;
  /**
   * Post-trade cash minus `targetAmount`: rounding residuals + dust residuals; negative when the
   * buys are not funded (then `feasible` is false).
   */
  residualAmount: number;
  /** Post-trade cash ÷ `netAssetValue`. */
  achievedWeight: number;
}

export interface AllocatePortfolioResult {
  asOf: EpochMs;
  baseCurrency: string;
  netAssetValue: number;
  /** Sorted by instrumentId. */
  allocations: AllocationRow[];
  cash: AllocationCash;
  /** Sorted by instrumentId; dust and zero trades excluded. */
  trades: AllocationTrade[];
  /** Sorted by instrumentId. */
  dust: AllocationDustRow[];
  estimatedTransactionCost: number;
  /** `Σ |trade notional| ÷ netAssetValue` (buys and sells both counted). */
  turnover: number;
  /** Sorted by key, then reason. */
  unresolved: UnresolvedTarget[];
  /** No unresolved target AND the buys are funded (cash residual ≥ 0). */
  feasible: boolean;
  assumptions: {
    conventionsVersion: string;
    targetSource: ResolvedTargetSource;
    rounding: string;
    costModel: string;
    pricing: string;
    currencyConversionsUsed: CurrencyPairQuote[];
  };
  diagnostics: {
    warnings: string[];
    instrumentCount: number;
    tradeCount: number;
    dustCount: number;
    unresolvedCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

const INPUT_KEYS = [
  'policy',
  'asOf',
  'baseCurrency',
  'netAssetValue',
  'prices',
  'currencyConversions',
  'currentHoldings',
  'contractMultipliers',
  'instrumentClassification',
  'lotSizes',
  'defaultLotSize',
  'minimumNotional',
  'cashReserve',
  'transactionCosts',
] as const;
const PRICE_KEYS = ['price', 'currency'] as const;
const COST_KEYS = [
  'commissionPerTrade',
  'commissionPerUnit',
  'spreadBasisPoints',
  'slippageBasisPoints',
] as const;

/** Lot rounding nudges the quotient by this before truncating, so 399.9999999996 lots reads as 400. */
const LOT_EPSILON = 1e-9;
/** Funding comparisons tolerate this fraction of NAV of float noise. */
const AMOUNT_TOLERANCE_FRACTION = 1e-9;

const PRICING_CONVENTION =
  'Prices are the caller’s prices[instrumentId] in the stated currency, converted to the base ' +
  'currency with currencyConversions (direct: multiply by quotePerBase; inverted: divide — FC5 ' +
  'convertCurrency arithmetic). Target notional = targetWeight × netAssetValue; current weight = ' +
  'currentHoldings × price in base ÷ netAssetValue; current cash = netAssetValue − Σ holding ' +
  'values. The cash the plan intends to hold is cashReserve + cash target × netAssetValue; buys are ' +
  'funded by current cash + sells − that amount, and an unfunded plan is reported infeasible, ' +
  'never scaled.';

const EXAMPLE_CALL =
  "allocatePortfolio({ policy: { targets: [{ group: { instrumentId: 'SPY' }, weight: 0.6 }, { group: { instrumentId: 'AGG' }, weight: 0.3 }, { group: { assetClass: 'cash' }, weight: 0.1 }] }, asOf: '2026-08-29', baseCurrency: 'USD', netAssetValue: 100_000, prices: { SPY: { price: 150, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } }, defaultLotSize: 1 })";

// ---------------------------------------------------------------------------------------------------
// Shared sizing grammar (validation + arithmetic reused by the rebalance proposal)
// ---------------------------------------------------------------------------------------------------

/** The validated sizing grammar. `null` = not supplied (fractional quantities / no dust threshold). */
export interface AllocationSizing {
  lotSizes: Record<string, number>;
  defaultLotSize: number | null;
  minimumNotional: number | null;
  transactionCosts: Required<AllocationTransactionCosts>;
}

function requireNonNegativeField(functionName: string, field: string, value: unknown): number {
  requireFiniteNumberField(functionName, field, value);
  if (value < 0) {
    throw new InputError(`${functionName}: ${field} must be ≥ 0. Received ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field },
    });
  }
  return value;
}

/** Validate the lot-size / minimum-notional / cost grammar (package-internal; shared). */
export function requireAllocationSizing(
  functionName: string,
  input: AllocationSizingInput,
): AllocationSizing {
  const lotSizes: Record<string, number> = {};
  if (input.lotSizes !== undefined) {
    requireArgumentObject(functionName, 'lotSizes', input.lotSizes);
    for (const instrumentId of Object.keys(input.lotSizes).sort()) {
      requireIdentityString(functionName, 'lotSizes key', instrumentId);
      const lotSize = ownValue(input.lotSizes, instrumentId);
      requirePositiveNumberField(
        functionName,
        `lotSizes['${instrumentId}']`,
        lotSize,
        'a lot size is the smallest tradable quantity increment',
      );
      setOwnValue(lotSizes, instrumentId, lotSize);
    }
  }
  let defaultLotSize: number | null = null;
  if (input.defaultLotSize !== undefined) {
    requirePositiveNumberField(
      functionName,
      'defaultLotSize',
      input.defaultLotSize,
      'a lot size is the smallest tradable quantity increment',
    );
    defaultLotSize = input.defaultLotSize;
  }
  let minimumNotional: number | null = null;
  if (input.minimumNotional !== undefined) {
    minimumNotional = requireNonNegativeField(
      functionName,
      'minimumNotional',
      input.minimumNotional,
    );
  }
  const transactionCosts: Required<AllocationTransactionCosts> = {
    commissionPerTrade: 0,
    commissionPerUnit: 0,
    spreadBasisPoints: 0,
    slippageBasisPoints: 0,
  };
  if (input.transactionCosts !== undefined) {
    requireArgumentObject(functionName, 'transactionCosts', input.transactionCosts);
    ensureKnownKeys(functionName, 'transactionCosts', input.transactionCosts, COST_KEYS);
    for (const key of COST_KEYS) {
      const value = input.transactionCosts[key];
      if (value !== undefined) {
        transactionCosts[key] = requireNonNegativeField(
          functionName,
          `transactionCosts.${key}`,
          value,
        );
      }
    }
  }
  return { lotSizes, defaultLotSize, minimumNotional, transactionCosts };
}

/** The lot size that applies to an instrument, or `null` when neither grammar covers it. */
export function lotSizeFor(sizing: AllocationSizing, instrumentId: string): number | null {
  return ownValue(sizing.lotSizes, instrumentId) ?? sizing.defaultLotSize;
}

/**
 * Round a signed quantity TOWARD ZERO to a whole number of lots (a short quantity's magnitude
 * shrinks too). The quotient is nudged by 1e-9 lots before truncation so float noise below a whole
 * lot never drops a lot. Never returns −0.
 */
export function roundTowardZeroToLot(quantity: number, lotSize: number | null): number {
  if (lotSize === null) return quantity;
  const lots = quantity / lotSize;
  const rounded = Math.trunc(lots + Math.sign(lots) * LOT_EPSILON) * lotSize;
  return rounded === 0 ? 0 : rounded;
}

export interface TradeCostEstimate {
  commission: number;
  spread: number;
  slippage: number;
  total: number;
}

/** The cost model: commission per trade + per unit, spread and slippage in basis points of |notional|. */
export function estimateTradeCost(
  costs: Required<AllocationTransactionCosts>,
  quantity: number,
  notionalInBaseCurrency: number,
): TradeCostEstimate {
  const magnitude = Math.abs(quantity);
  const notional = Math.abs(notionalInBaseCurrency);
  const commission =
    magnitude === 0 ? 0 : costs.commissionPerTrade + costs.commissionPerUnit * magnitude;
  const spread = (costs.spreadBasisPoints * notional) / 10_000;
  const slippage = (costs.slippageBasisPoints * notional) / 10_000;
  return { commission, spread, slippage, total: commission + spread + slippage };
}

/** Prose statement of the cost model actually applied (string-typed by design). */
export function describeCostModel(costs: Required<AllocationTransactionCosts>): string {
  const terms: string[] = [];
  if (costs.commissionPerTrade !== 0)
    terms.push(`${costs.commissionPerTrade} base currency per non-zero trade`);
  if (costs.commissionPerUnit !== 0)
    terms.push(`${costs.commissionPerUnit} base currency per unit traded (× |quantity|)`);
  if (costs.spreadBasisPoints !== 0)
    terms.push(`spread ${costs.spreadBasisPoints} basis points × |notional| ÷ 10 000`);
  if (costs.slippageBasisPoints !== 0)
    terms.push(`slippage ${costs.slippageBasisPoints} basis points × |notional| ÷ 10 000`);
  return terms.length === 0
    ? 'No transactionCosts were supplied: every estimated cost is 0 (costs are estimates in base currency and are never deducted from the plan’s cash).'
    : `Estimated cost per trade = ${terms.join(' + ')}; costs are estimates in base currency and are never deducted from the plan’s cash.`;
}

/** Prose statement of the rounding convention actually applied (string-typed by design). */
export function describeRounding(
  sizing: AllocationSizing,
  fractionalInstruments: string[],
): string {
  const perInstrument = Object.keys(sizing.lotSizes).sort();
  const parts = [
    'Target quantities round TOWARD ZERO to the instrument’s lot size (a short target rounds toward zero too, so its magnitude shrinks); each rounding residual is reported per instrument and stays in cash.',
  ];
  parts.push(
    perInstrument.length === 0
      ? 'No per-instrument lotSizes were supplied.'
      : `Per-instrument lot sizes: ${perInstrument.map((id) => `${id}=${String(ownValue(sizing.lotSizes, id))}`).join(', ')}.`,
  );
  parts.push(
    sizing.defaultLotSize === null
      ? 'No defaultLotSize was supplied.'
      : `defaultLotSize ${sizing.defaultLotSize} applies to every other instrument.`,
  );
  if (fractionalInstruments.length > 0) {
    parts.push(
      `Neither covers ${fractionalInstruments.join(', ')}: their quantities are left fractional (unrounded).`,
    );
  }
  parts.push(
    sizing.minimumNotional === null
      ? 'No minimumNotional was supplied: no trade is treated as dust.'
      : `A trade with |notional| below minimumNotional ${sizing.minimumNotional} is dust: skipped, listed, and its instrument reported at its current quantity.`,
  );
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

function requirePrices(functionName: string, value: unknown): Record<string, AllocationPrice> {
  if (value === undefined) {
    throw new InputError(
      `${functionName}: prices is required — a quantity is a notional divided by a price, and TotalFinance never fetches one.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'prices' } },
    );
  }
  requireArgumentObject(functionName, 'prices', value);
  const map = value as Record<string, unknown>;
  const out: Record<string, AllocationPrice> = {};
  for (const instrumentId of Object.keys(map).sort()) {
    const path = `prices['${instrumentId}']`;
    requireIdentityString(functionName, 'prices key', instrumentId);
    const row = ownValue(map, instrumentId);
    requireArgumentObject(functionName, path, row);
    ensureKnownKeys(functionName, path, row as object, PRICE_KEYS);
    const record = row as Record<string, unknown>;
    requireFiniteNumberField(functionName, `${path}.price`, record['price']);
    requireCurrencyCode(functionName, `${path}.currency`, record['currency']);
    setOwnValue(out, instrumentId, { price: record['price'], currency: record['currency'] });
  }
  return out;
}

function requireHoldings(functionName: string, value: unknown): Record<string, number> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, 'currentHoldings', value);
  const map = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const instrumentId of Object.keys(map).sort()) {
    requireIdentityString(functionName, 'currentHoldings key', instrumentId);
    const quantity = ownValue(map, instrumentId);
    requireFiniteNumberField(functionName, `currentHoldings['${instrumentId}']`, quantity);
    setOwnValue(out, instrumentId, quantity);
  }
  return out;
}

function requireMultipliers(functionName: string, value: unknown): Record<string, number> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, 'contractMultipliers', value);
  const map = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const instrumentId of Object.keys(map).sort()) {
    requireIdentityString(functionName, 'contractMultipliers key', instrumentId);
    requirePositiveNumberField(
      functionName,
      `contractMultipliers['${instrumentId}']`,
      ownValue(map, instrumentId),
      'units of the underlying per unit of quantity',
    );
    setOwnValue(out, instrumentId, ownValue(map, instrumentId) as number);
  }
  return out;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic order for unresolved rows: key, then reason. */
export function sortUnresolved(rows: UnresolvedTarget[]): UnresolvedTarget[] {
  return [...rows].sort((a, b) => compareIds(a.key, b.key) || compareIds(a.reason, b.reason));
}

// ---------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------

/**
 * Turn a policy's target weights into executable quantities at `asOf` — see the module comment for
 * the laws. A proposal built on this is a PLAN: nothing here executes anything.
 *
 * @example
 * ```ts
 * import { allocatePortfolio } from '@insiderfinance/totalfinance/portfolio/policy';
 *
 * const plan = allocatePortfolio({
 *   policy: {
 *     targets: [
 *       { group: { instrumentId: 'SPY' }, weight: 0.6 },
 *       { group: { instrumentId: 'AGG' }, weight: 0.3 },
 *       { group: { assetClass: 'cash' }, weight: 0.1 },
 *     ],
 *   },
 *   asOf: '2026-08-29',
 *   baseCurrency: 'USD',
 *   netAssetValue: 100_000,
 *   prices: { SPY: { price: 150, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } },
 *   defaultLotSize: 1,
 * });
 * plan.trades; // buy 400 SPY, buy 300 AGG; plan.cash.residualAmount === 0
 * ```
 */
export function allocatePortfolio(input: AllocatePortfolioInput): AllocatePortfolioResult {
  const functionName = 'allocatePortfolio';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  if (input.policy === undefined) {
    throw new InputError(
      `${functionName}: policy is required — the targets are the caller's goals.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'policy' } },
    );
  }
  const policy = requireInvestmentPolicy(functionName, 'policy', input.policy);
  if (input.asOf === undefined) {
    throw new InputError(
      `${functionName}: asOf is required — targets are dated (a model's tactical/glide-path sets resolve at an instant) and TotalFinance never reads the system clock.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'asOf' } },
    );
  }
  const asOf = resolveAsOf(input.asOf, functionName);
  requireEpochMsField(functionName, 'asOf', asOf);
  requireCurrencyCode(functionName, 'baseCurrency', input.baseCurrency);
  const baseCurrency = input.baseCurrency;
  if (policy.model !== undefined && policy.model.baseCurrency !== baseCurrency) {
    throw new InputError(
      `${functionName}: policy.model '${policy.model.modelId}' v${policy.model.version} is stated in ${policy.model.baseCurrency}, but baseCurrency is ${baseCurrency} — a model's weights are shares of a NAV in its own currency.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'policy.model.baseCurrency' },
      },
    );
  }
  requirePositiveNumberField(
    functionName,
    'netAssetValue',
    input.netAssetValue,
    'weights are shares of a positive net asset value',
  );
  const netAssetValue = input.netAssetValue;
  const prices = requirePrices(functionName, input.prices);
  const quotes: CurrencyPairQuote[] = [];
  if (input.currencyConversions !== undefined) {
    requireArgumentArray(functionName, 'currencyConversions', input.currencyConversions);
    input.currencyConversions.forEach((quote, index) => {
      requireCurrencyPairQuoteShape(functionName, `currencyConversions[${index}]`, quote);
      quotes.push(quote);
    });
  }
  const currentHoldings = requireHoldings(functionName, input.currentHoldings);
  const contractMultipliers = requireMultipliers(functionName, input.contractMultipliers);
  const multiplierOf = (instrumentId: string): number =>
    ownValue(contractMultipliers, instrumentId) ?? 1;
  const classification = requireInstrumentClassification(
    functionName,
    input.instrumentClassification,
  );
  const sizing = requireAllocationSizing(functionName, input);
  const cashReserve =
    input.cashReserve === undefined
      ? 0
      : requireNonNegativeField(functionName, 'cashReserve', input.cashReserve);

  const warnings: string[] = [];
  const resolved = resolvePolicyTargets(functionName, policy, asOf);

  // ---- the universe: priced ∪ held ∪ instrument targets ∪ sleeve members ----
  const universe = new Set<string>([...Object.keys(prices), ...Object.keys(currentHoldings)]);
  for (const target of resolved.targets) {
    if (target.group.instrumentId !== undefined) universe.add(target.group.instrumentId);
  }
  const sleeves = policy.model?.sleeves ?? [];
  for (const sleeve of sleeves) {
    for (const member of sleeve.members ?? []) universe.add(member.instrumentId);
  }

  // ---- prices in base currency ----
  const quotesUsed = new Map<string, CurrencyPairQuote>();
  const priceInBase = new Map<string, number>();
  const instrumentCurrency: Record<string, string> = {};
  for (const instrumentId of Object.keys(prices).sort()) {
    const row = ownValue(prices, instrumentId)!;
    setOwnValue(instrumentCurrency, instrumentId, row.currency);
    if (row.currency === baseCurrency) {
      priceInBase.set(instrumentId, row.price);
      continue;
    }
    const { convertedAmount, quoteUsed } = convertWithQuotes({
      functionName,
      amount: row.price,
      fromCurrency: row.currency,
      toCurrency: baseCurrency,
      quotes,
      subject: `prices['${instrumentId}'] (${row.currency})`,
    });
    // Echo a COPY — freezing the result must never freeze the caller's own quote objects.
    quotesUsed.set(`${quoteUsed.baseCurrency}/${quoteUsed.quoteCurrency}`, { ...quoteUsed });
    priceInBase.set(instrumentId, convertedAmount);
  }

  // ---- current weights (held AND priced) ----
  const currentWeights: Record<string, number> = {};
  let currentHoldingsValue = 0;
  for (const instrumentId of Object.keys(currentHoldings)) {
    const base = priceInBase.get(instrumentId);
    if (base === undefined) continue;
    const value = ownValue(currentHoldings, instrumentId)! * base * multiplierOf(instrumentId);
    setOwnValue(currentWeights, instrumentId, value / netAssetValue);
    currentHoldingsValue += value;
  }

  const expanded = expandTargets(functionName, {
    targets: resolved.targets,
    universe: [...universe],
    instrumentClassification: classification,
    instrumentCurrency,
    currentWeights,
    sleeves,
    withinGroupAllocation: policy.withinGroupAllocation,
    defaultDriftBand: policy.driftBand,
  });
  const unresolved: UnresolvedTarget[] = [...expanded.unresolved];
  warnings.push(...expanded.warnings);

  // ---- cash: the target and the reserve are both honoured ----
  const cashTargetWeight = expanded.cashTarget?.targetWeight ?? 0;
  if (expanded.cashTarget === null && unresolved.length === 0) {
    // Cannot happen by the expansion law (a null cash target always comes with an unresolved
    // row), but a missing goal must never silently become 0.
    unresolved.push({
      key: `assetClass:${CASH_ASSET_CLASS}`,
      group: { assetClass: CASH_ASSET_CLASS },
      reason: "the expansion produced no cash target — declare { assetClass: 'cash' }.",
    });
  }
  const targetCashAmount = cashReserve + cashTargetWeight * netAssetValue;
  const tolerance = netAssetValue * AMOUNT_TOLERANCE_FRACTION;
  if (netAssetValue - targetCashAmount < -tolerance) {
    unresolved.push({
      key: `assetClass:${CASH_ASSET_CLASS}`,
      group: { assetClass: CASH_ASSET_CLASS },
      reason: `the cash reserve ${cashReserve} plus the cash target ${cashTargetWeight} × ${netAssetValue} = ${targetCashAmount} exceed the net asset value — nothing is investable. Lower cashReserve or the cash target.`,
    });
  }

  // ---- per-instrument sizing ----
  const restricted = new Set(policy.restrictedInstruments ?? []);
  const allowed =
    policy.allowedInstruments === undefined ? null : new Set(policy.allowedInstruments);
  const allocations: AllocationRow[] = [];
  const trades: AllocationTrade[] = [];
  const dust: AllocationDustRow[] = [];
  const fractional: string[] = [];
  const idle: string[] = [];
  let buys = 0;
  let sells = 0;
  let grossTraded = 0;
  let estimatedTransactionCost = 0;

  for (const target of expanded.instrumentTargets) {
    const instrumentId = target.instrumentId;
    const weight = target.targetWeight;
    const held = ownValue(currentHoldings, instrumentId) ?? 0;
    const priceRow = ownValue(prices, instrumentId);
    const active = weight !== 0 || held !== 0;
    if (priceRow === undefined) {
      if (active) {
        unresolved.push({
          key: `instrumentId:${instrumentId}`,
          group: { instrumentId },
          reason: `no price for '${instrumentId}' — its target ${weight} of NAV${held !== 0 ? ` and its ${held} held units` : ''} cannot be sized. Add prices['${instrumentId}'] = { price, currency }.`,
        });
      } else {
        idle.push(instrumentId);
      }
      continue;
    }
    if (priceRow.price <= 0 && active) {
      unresolved.push({
        key: `instrumentId:${instrumentId}`,
        group: { instrumentId },
        reason: `cannot size against a non-positive price: prices['${instrumentId}'].price is ${priceRow.price}.`,
      });
      continue;
    }
    if (weight !== 0 && restricted.has(instrumentId)) {
      unresolved.push({
        key: `instrumentId:${instrumentId}`,
        group: { instrumentId },
        reason: `'${instrumentId}' is in policy.restrictedInstruments but its targets give it ${weight} of NAV (${target.sourceGroups.join(', ')}) — a restricted instrument cannot carry a target.`,
      });
      continue;
    }
    if (weight !== 0 && allowed !== null && !allowed.has(instrumentId)) {
      unresolved.push({
        key: `instrumentId:${instrumentId}`,
        group: { instrumentId },
        reason: `'${instrumentId}' is not in policy.allowedInstruments but its targets give it ${weight} of NAV (${target.sourceGroups.join(', ')}) — add it to allowedInstruments or restate the targets.`,
      });
      continue;
    }
    const base = priceInBase.get(instrumentId)! * multiplierOf(instrumentId);
    const targetNotional = weight * netAssetValue;
    const unroundedQuantity = targetNotional / base;
    const lotSize = lotSizeFor(sizing, instrumentId);
    if (lotSize === null && unroundedQuantity !== 0) fractional.push(instrumentId);
    const targetQuantity = roundTowardZeroToLot(unroundedQuantity, lotSize);
    const roundingResidualNotional = (unroundedQuantity - targetQuantity) * base;
    let tradeQuantity = targetQuantity - held;
    if (Math.abs(tradeQuantity) <= QUANTITY_DUST) tradeQuantity = 0;
    const tradeNotional = tradeQuantity * base;
    const isDust =
      tradeQuantity !== 0 &&
      sizing.minimumNotional !== null &&
      Math.abs(tradeNotional) < sizing.minimumNotional;
    const side: OrderSide = tradeQuantity === 0 ? 'buy' : sideOf(tradeQuantity);
    if (isDust) {
      dust.push({
        instrumentId,
        tradeNotional,
        reason: `the ${side} of ${Math.abs(tradeQuantity)} ${instrumentId} (|notional| ${Math.abs(tradeNotional)}) is below minimumNotional ${sizing.minimumNotional} — skipped; '${instrumentId}' stays at ${held} and the ${Math.abs(tradeNotional)} ${side === 'buy' ? 'stays in cash' : 'is not raised'}.`,
      });
    } else if (tradeQuantity !== 0) {
      const cost = estimateTradeCost(sizing.transactionCosts, tradeQuantity, tradeNotional);
      trades.push({
        instrumentId,
        side,
        quantity: Math.abs(tradeQuantity),
        estimatedNotional: Math.abs(tradeNotional),
        currency: priceRow.currency,
        estimatedCost: cost.total,
      });
      estimatedTransactionCost += cost.total;
      if (tradeQuantity > 0) buys += tradeNotional;
      else sells += -tradeNotional;
      grossTraded += Math.abs(tradeNotional);
    }
    const postQuantity = isDust ? held : targetQuantity;
    allocations.push({
      instrumentId,
      targetWeight: weight,
      targetNotional,
      price: priceRow.price,
      currency: priceRow.currency,
      priceInBaseCurrency: base,
      contractMultiplier: multiplierOf(instrumentId),
      currentQuantity: held,
      targetQuantity,
      tradeQuantity: isDust ? 0 : tradeQuantity,
      tradeNotional: isDust ? 0 : tradeNotional,
      lotSize,
      roundingResidualNotional,
      achievedWeight: (postQuantity * base) / netAssetValue,
      dust: isDust,
      sourceGroups: [...target.sourceGroups],
      implied: target.implied,
    });
  }
  if (idle.length > 0) {
    warnings.push(
      `${idle.length} instrument${idle.length === 1 ? ' has' : 's have'} no price row, no target, and no holding — nothing to size: ${idle.join(', ')}.`,
    );
  }

  // ---- cash conservation ----
  const currentCash = netAssetValue - currentHoldingsValue;
  const postTradeCash = currentCash - buys + sells;
  const residualAmount = postTradeCash - targetCashAmount;
  const fundable = currentCash + sells - targetCashAmount;
  const buysFunded = buys <= fundable + tolerance;
  if (!buysFunded) {
    warnings.push(
      `buys of ${buys} exceed the ${fundable} fundable (current cash ${currentCash} + sells ${sells} − intended cash ${targetCashAmount}) by ${buys - fundable} — the plan is infeasible as stated; nothing was scaled. Lower the targets, the cashReserve, or the cash target.`,
    );
  }
  const sortedUnresolved = sortUnresolved(unresolved);
  const feasible = sortedUnresolved.length === 0 && buysFunded;
  allocations.sort((a, b) => compareIds(a.instrumentId, b.instrumentId));
  trades.sort((a, b) => compareIds(a.instrumentId, b.instrumentId));
  dust.sort((a, b) => compareIds(a.instrumentId, b.instrumentId));

  return deepFreeze(
    requireRepresentableResult(functionName, {
      asOf,
      baseCurrency,
      netAssetValue,
      allocations,
      cash: {
        targetWeight: cashTargetWeight,
        reserve: cashReserve,
        targetAmount: targetCashAmount,
        residualAmount,
        achievedWeight: postTradeCash / netAssetValue,
      },
      trades,
      dust,
      estimatedTransactionCost,
      turnover: grossTraded / netAssetValue,
      unresolved: sortedUnresolved,
      feasible,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        targetSource: resolved.source,
        rounding: describeRounding(sizing, fractional.sort()),
        costModel: describeCostModel(sizing.transactionCosts),
        pricing: PRICING_CONVENTION,
        currencyConversionsUsed: [...quotesUsed.keys()].sort().map((key) => quotesUsed.get(key)!),
      },
      diagnostics: {
        warnings,
        instrumentCount: allocations.length,
        tradeCount: trades.length,
        dustCount: dust.length,
        unresolvedCount: sortedUnresolved.length,
      },
    }),
  );
}
