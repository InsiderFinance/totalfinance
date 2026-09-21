/**
 * `proposePortfolioRebalance` (FC7 slice 4, Stage 4.4; agent-native "Rebalance proposal"): a pure,
 * contribution/withdrawal-aware PROPOSAL over an event-derived ledger valued against an explicit
 * market snapshot. It produces a plan and never executes it.
 *
 * Laws this module executes (agent-native doc → "Rebalance proposal"; tracker → "Portfolio-side
 * management"):
 *
 * - **A proposal is a plan.** The result carries trades, estimates, and a normalized,
 *   content-addressed `TradePlanArtifact` suitable for preflight — and no execution capability.
 * - **Hard constraints are never silently relaxed.** A turnover cap or cash floor that binds trims
 *   the plan and is reported as a `capped` constraint (the GOAL is unmet, the CONSTRAINT holds); a
 *   post-trade limit the plan would break is reported as `violated` with the number and the plan
 *   is `feasible: false` — the trades stay listed so the caller sees what the targets ask for.
 * - **New cash first.** A contribution invested to targets funds underweights before anything is
 *   sold; sizing over the post-flow NAV makes that the natural to-target plan.
 * - **Everything explicit.** Infeasibility, non-convergence, skipped dust, rounding, residual cash,
 *   unavailable liquidity data, and the lot-selection preview's availability under the ledger's
 *   own relief policy are all reported; missing goals (a flow with no handling, a scope) are typed
 *   refusals, never defaults.
 */

import type { EpochMs } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isOccOptionSymbol,
  requireArgumentObject,
  requireRepresentableResult,
  resolveAsOf,
  sideOf,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import { contentHash, readMarketSnapshot } from '@totalfinance/core/artifacts';
import type {
  AllocatePortfolioInput,
  AllocationDustRow,
  AllocationSizing,
  AllocationSizingInput,
} from './allocation.js';
import {
  allocatePortfolio,
  describeCostModel,
  describeRounding,
  estimateTradeCost,
  lotSizeFor,
  requireAllocationSizing,
  roundTowardZeroToLot,
  sortUnresolved,
} from './allocation.js';
import type { CurrencyPairQuote } from './internal.js';
import {
  QUANTITY_DUST,
  convertWithQuotes,
  deepFreeze,
  describeInputValue,
  ownValue,
  requireCurrencyCode,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requirePositiveNumberField,
  setOwnValue,
} from './internal.js';
import type { InstrumentClassification } from './pnl.js';
import { requireInstrumentClassification } from './pnl.js';
import type {
  AllocationTarget,
  InvestmentPolicy,
  ModelSleeve,
  ResolvedTargetSource,
  TargetGroup,
  UnresolvedTarget,
} from './policy-grammar.js';
import {
  CASH_ASSET_CLASS,
  expandTargets,
  instrumentGroupKeys,
  isCashTargetGroup,
  requireInvestmentPolicy,
  resolvePolicyTargets,
  targetGroupKey,
} from './policy-grammar.js';
import { portfolioSnapshot } from './snapshot.js';
import type { LotReliefPolicy, PortfolioState, TaxLot } from './state.js';
import { reliefOrder, requirePortfolioStateShape } from './state.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

/** Trade every instrument to target, or only what is outside its drift band. REQUIRED. */
export type RebalanceScope = 'to-target' | 'drift-only';

export type RebalanceTradeReason = 'drift' | 'to-target' | 'contribution' | 'withdrawal';

/** A planned contribution (`amount > 0`) or withdrawal (`amount < 0`) at `asOf`. */
export interface ExternalFlow {
  amount: number;
  /** Base currency only in this build (a foreign-currency flow is a typed refusal). */
  currency: string;
}

export interface ProposePortfolioRebalanceInput extends AllocationSizingInput {
  portfolio: PortfolioState;
  /** Marks come from `observations.spots` through `portfolioSnapshot`. */
  market: MarketSnapshot;
  asOf: EpochMs | string;
  currencyConversions?: CurrencyPairQuote[];
  policy: InvestmentPolicy;
  instrumentClassification?: Record<string, InstrumentClassification>;
  scope: RebalanceScope;
  externalFlow?: ExternalFlow;
  /** Where BUYS book. REQUIRED when more than one allowed account; with exactly one it is that account. */
  tradingAccountId?: string;
  /** Units per day; with `limits.maximumDaysToLiquidate`, days = |post-trade quantity| ÷ (volume × 0.1). */
  averageDailyVolumes?: Record<string, number>;
}

export interface RebalanceInstrumentWeight {
  instrumentId: string;
  /** Weight of the pre-flow managed NAV. */
  current: number;
  /** `null` when the instrument's goal is unresolved (an `unresolvedTargets` row names why). */
  target: number | null;
  /** Weight of the post-flow NAV after the proposed trades. */
  postTrade: number;
  driftBand: number | null;
  outsideBand: boolean;
  sourceGroups: string[];
}

export interface RebalanceGroupWeight {
  key: string;
  current: number;
  target: number;
  postTrade: number;
  driftBand: number | null;
  outsideBand: boolean;
}

export interface RebalanceCashWeight {
  current: number;
  target: number | null;
  postTrade: number;
}

export interface RebalanceCashSummary {
  /** Settled cash of the allowed accounts (base currency) plus the external flow. */
  available: number;
  /** Σ proposed sell notionals (base). */
  raised: number;
  /** Σ proposed buy notionals (base). */
  used: number;
  /** Post-trade settled cash: `available + raised − used`. */
  remainingReserve: number;
  /** The binding cash floor: the larger of `minimumCash` and `minimumCashWeight × post-flow NAV` (0 when neither is declared). */
  minimumReserve: number;
}

export interface RebalanceLotPreview {
  lotId: string;
  /** Unsigned quantity relieved from this lot. */
  quantity: number;
  costBasisPerUnit: number;
  /** At the mark, in the position's currency: long `(mark − basis) × quantity`; short `(basis − mark) × quantity`. */
  estimatedRealizedPnl: number;
}

export interface RebalanceLotSelection {
  policy: LotReliefPolicy;
  lots: RebalanceLotPreview[];
  estimatedRealizedPnl: number;
}

export interface RebalanceTrade {
  accountId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  /** Unsigned magnitude. */
  quantity: number;
  /** The mark, in `currency`. */
  markPricePerUnit: number;
  currency: string;
  /** `quantity × mark` converted to the base currency. */
  estimatedNotional: number;
  estimatedCommission: number;
  estimatedSpreadCost: number;
  estimatedSlippageCost: number;
  /** Present when the trade relieves lots under the ledger's own `lotRelief` policy. */
  lotSelection: RebalanceLotSelection | null;
  /** Why `lotSelection` is null (the trade opens/extends, or the policy is 'specific-lot'); null otherwise. */
  lotSelectionReason: string | null;
  reason: RebalanceTradeReason;
}

export interface RebalanceEstimates {
  commission: number;
  spread: number;
  slippage: number;
  totalCost: number;
  /** `Σ |trade notional| ÷ post-flow NAV`. */
  turnover: number;
}

export interface RebalanceObjectivePoint {
  /** `Σ |weight − target| ÷ 2` over instrument targets and cash. */
  driftDistance: number;
  /** Active share vs `policy.benchmark.constituents`; `null` (with a diagnostics warning) when none are given. */
  trackingDistance: number | null;
}

export interface RebalanceRiskPoint {
  maximumPositionWeight: number;
  /** `Σ weight²` over instruments (cash excluded). */
  herfindahlIndex: number;
  topThreeWeight: number;
  /** `Σ |weight|` over instruments. */
  grossLeverage: number;
  cashWeight: number;
}

/**
 * `capped`: the constraint bound the plan (trimmed to honour it; the goal is unmet).
 * `violated`: the plan as proposed breaks the limit (never auto-fixed; `feasible` is false).
 * `unverifiable`: the limit could not be evaluated (data missing); `feasible` is false.
 */
export type UnresolvedConstraintStatus = 'capped' | 'violated' | 'unverifiable';

export interface UnresolvedConstraint {
  constraint: string;
  status: UnresolvedConstraintStatus;
  reason: string;
  value: number | null;
  limit: number | null;
}

export interface RebalanceDustSummary {
  skipped: AllocationDustRow[];
  /** Σ signed skipped notionals (the net cash effect of skipping). */
  aggregateNotional: number;
}

export const TRADE_PLAN_KIND = 'totalfinance.trade-plan';
export const TRADE_PLAN_SCHEMA_VERSION = 1;

export interface TradePlanTrade {
  accountId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** The instrument's trading currency. */
  currency: string;
  referencePricePerUnit: number;
  /**
   * The contract multiplier the estimate applied: the ledger position's, the `instruments`
   * description's, or 1 for a plain instrument known only from a market spot. An OCC option symbol
   * never takes that share default — the plan refuses it until the multiplier is declared.
   */
  contractMultiplier: number;
  /** `quantity × referencePricePerUnit × contractMultiplier`, in `currency`. */
  estimatedNotional: number;
}

/** A normalized, content-addressed plan suitable for preflight. It contains NO execution capability. */
export interface TradePlanArtifact {
  kind: typeof TRADE_PLAN_KIND;
  schemaVersion: number;
  asOf: EpochMs;
  baseCurrency: string;
  portfolioId?: string;
  /** `contentHash` over the validated policy the plan was built from. */
  policyContentHash: string;
  /** Sorted by (accountId, instrumentId, side). */
  trades: TradePlanTrade[];
  /** `sha256:` over every field above. */
  contentHash: string;
}

export interface ProposePortfolioRebalanceResult {
  asOf: EpochMs;
  baseCurrency: string;
  /** The managed (allowed-account) NAV before the flow. */
  netAssetValue: number;
  netAssetValueAfterFlow: number;
  weights: {
    instruments: RebalanceInstrumentWeight[];
    groups: RebalanceGroupWeight[];
    cash: RebalanceCashWeight;
  };
  cash: RebalanceCashSummary;
  /** Sorted by (instrumentId, accountId). */
  trades: RebalanceTrade[];
  estimates: RebalanceEstimates;
  objective: {
    before: RebalanceObjectivePoint;
    after: RebalanceObjectivePoint;
    convention: string;
  };
  risk: { before: RebalanceRiskPoint; after: RebalanceRiskPoint };
  unresolvedTargets: UnresolvedTarget[];
  unresolvedConstraints: UnresolvedConstraint[];
  convergence: { converged: boolean; iterations: number };
  dust: RebalanceDustSummary;
  feasible: boolean;
  plan: TradePlanArtifact;
  assumptions: {
    conventionsVersion: string;
    lotRelief: LotReliefPolicy;
    targetSource: ResolvedTargetSource;
    scope: RebalanceScope;
    flowHandling: string;
    rounding: string;
    costModel: string;
    liquidityParticipationRate: number;
    conventions: string;
  };
  diagnostics: {
    warnings: string[];
    accountsConsidered: string[];
    accountsExcluded: string[];
    tradeCount: number;
    dustCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

const INPUT_KEYS = [
  'portfolio',
  'market',
  'asOf',
  'currencyConversions',
  'policy',
  'instrumentClassification',
  'scope',
  'externalFlow',
  'tradingAccountId',
  'lotSizes',
  'defaultLotSize',
  'minimumNotional',
  'transactionCosts',
  'averageDailyVolumes',
] as const;
const FLOW_KEYS = ['amount', 'currency'] as const;
const SCOPES: readonly RebalanceScope[] = ['to-target', 'drift-only'];

/** Liquidity horizon: days = |quantity| ÷ (average daily volume × this participation rate). */
const LIQUIDITY_PARTICIPATION_RATE = 0.1;
const MAXIMUM_ITERATIONS = 3;
const AMOUNT_TOLERANCE_FRACTION = 1e-9;
const WEIGHT_NOISE = 1e-12;

const CONVENTIONS =
  'The managed book is the policy’s allowed accounts (all accounts when none are declared); ' +
  'holdings in other accounts are reported and never traded. Weights are of the managed NAV at ' +
  'the snapshot marks (before) and of the post-flow NAV after the proposed trades (after); trades ' +
  'are value-neutral at the mark and estimated costs are never deducted from cash. Drift is ' +
  'current − target; a target is outside its band when |drift| > band. In scope ‘drift-only’ a ' +
  'trade is kept when its instrument or one of its source groups is outside its band; in ' +
  '‘to-target’ every instrument moves to target. Sizing is one allocatePortfolio pass over the ' +
  'post-flow NAV (the pre-flow NAV when a contribution is held as cash) with the ledger’s ' +
  'holdings and marks; the turnover cap scales every kept trade by cap ÷ required and the cash ' +
  'floor scales buys by available ÷ needed, each re-rounded toward zero to the lot size on the ' +
  'trade quantity, at most three passes. Buys book to the trading account; a trade that closes ' +
  'a position books to the holding account(s) in accountId order and previews the lots the ' +
  'ledger’s own lotRelief policy would relieve at the mark. Post-trade limits are evaluated, ' +
  'never auto-fixed. maximumDrawdown and maximumDailyLoss need a history and are evaluated by ' +
  'monitorPortfolio, not here. driftDistance = Σ|weight − target| ÷ 2 over instrument targets ' +
  'and cash; trackingDistance is the active share vs the benchmark constituents (cash counts ' +
  'as an asset the benchmark does not hold); herfindahlIndex = Σ weight² over instruments.';

const EXAMPLE_CALL =
  "proposePortfolioRebalance({ portfolio: ledger.state, market, asOf: '2026-08-29', scope: 'drift-only', policy: { targets: [{ group: { tag: 'equity' }, weight: 0.6 }, { group: { tag: 'fixed-income' }, weight: 0.3 }, { group: { assetClass: 'cash' }, weight: 0.1 }], driftBand: 0.03, maximumTurnover: 0.15, minimumCash: 5_000 }, instrumentClassification: { SPY: { tags: ['equity'] }, AGG: { tags: ['fixed-income'] } }, defaultLotSize: 1 })";

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

function requireScope(functionName: string, value: unknown): RebalanceScope {
  if (value === undefined) {
    throw new InputError(
      `${functionName}: scope is required — 'to-target' trades every instrument to its target; 'drift-only' trades only instruments (or groups) outside their drift band. Which one is a goal, not a default.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'scope' } },
    );
  }
  if (typeof value !== 'string' || !(SCOPES as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: scope must be 'to-target' or 'drift-only'. Received ${describeInputValue(value)}.`,
      {
        code: typeof value === 'string' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
        context: { function: functionName, field: 'scope' },
      },
    );
  }
  return value as RebalanceScope;
}

function requireExternalFlow(
  functionName: string,
  value: unknown,
  baseCurrency: string,
): ExternalFlow | null {
  if (value === undefined) return null;
  requireArgumentObject(functionName, 'externalFlow', value);
  ensureKnownKeys(functionName, 'externalFlow', value as object, FLOW_KEYS);
  const raw = value as Record<string, unknown>;
  requireFiniteNumberField(functionName, 'externalFlow.amount', raw['amount']);
  if (raw['amount'] === 0) {
    throw new InputError(
      `${functionName}: externalFlow.amount must be non-zero (> 0 a contribution, < 0 a withdrawal) — omit externalFlow when no flow is planned.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'externalFlow.amount' },
      },
    );
  }
  requireCurrencyCode(functionName, 'externalFlow.currency', raw['currency']);
  if (raw['currency'] !== baseCurrency) {
    throw new InputError(
      `${functionName}: externalFlow is stated in ${raw['currency']}, but the portfolio's base currency is ${baseCurrency} — this build sizes flows in the base currency only (a foreign-currency flow is deferred: record its cash.deposit and cash.conversion events first, or state the amount in ${baseCurrency}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'externalFlow.currency' },
      },
    );
  }
  return { amount: raw['amount'], currency: raw['currency'] };
}

function requireVolumes(functionName: string, value: unknown): Record<string, number> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, 'averageDailyVolumes', value);
  const map = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const instrumentId of Object.keys(map).sort()) {
    requireIdentityString(functionName, 'averageDailyVolumes key', instrumentId);
    const volume = ownValue(map, instrumentId);
    requirePositiveNumberField(
      functionName,
      `averageDailyVolumes['${instrumentId}']`,
      volume,
      'an average daily volume in units per day',
    );
    setOwnValue(out, instrumentId, volume);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sleeveLeafMembers(sleeveId: string, sleeves: readonly ModelSleeve[]): string[] {
  const sleeve = sleeves.find((s) => s.sleeveId === sleeveId);
  if (sleeve === undefined) return [];
  if (sleeve.members !== undefined) return sleeve.members.map((m) => m.instrumentId);
  const out = new Set<string>();
  for (const child of sleeves.filter((s) => s.parentSleeveId === sleeveId)) {
    for (const id of sleeveLeafMembers(child.sleeveId, sleeves)) out.add(id);
  }
  return [...out].sort();
}

interface HeldPosition {
  accountId: string;
  quantity: number;
  currency: string;
  markPricePerUnit: number;
  lots: TaxLot[];
}

interface Candidate {
  instrumentId: string;
  /** Signed to-target trade quantity (+ buy, − sell). */
  quantity: number;
  priceInBase: number;
  markPricePerUnit: number;
  currency: string;
  lotSize: number | null;
}

interface KeptTrade {
  candidate: Candidate;
  quantity: number;
  reason: RebalanceTradeReason;
}

function riskPoint(weights: Map<string, number>, cashWeight: number): RebalanceRiskPoint {
  const magnitudes = [...weights.values()].map((w) => Math.abs(w)).sort((a, b) => b - a);
  let herfindahl = 0;
  for (const w of weights.values()) herfindahl += w * w;
  return {
    maximumPositionWeight: magnitudes[0] ?? 0,
    herfindahlIndex: herfindahl,
    topThreeWeight: magnitudes.slice(0, 3).reduce((sum, w) => sum + w, 0),
    grossLeverage: magnitudes.reduce((sum, w) => sum + w, 0),
    cashWeight,
  };
}

function previewLots(
  position: HeldPosition,
  quantity: number,
  lotRelief: LotReliefPolicy,
): RebalanceLotSelection {
  const lots: RebalanceLotPreview[] = [];
  let remaining = quantity;
  let realized = 0;
  for (const lot of reliefOrder(position.lots, lotRelief)) {
    if (remaining <= QUANTITY_DUST) break;
    const take = Math.min(Math.abs(lot.quantity), remaining);
    const estimatedRealizedPnl =
      lot.quantity > 0
        ? (position.markPricePerUnit - lot.costBasisPerUnit) * take
        : (lot.costBasisPerUnit - position.markPricePerUnit) * take;
    lots.push({
      lotId: lot.lotId,
      quantity: take,
      costBasisPerUnit: lot.costBasisPerUnit,
      estimatedRealizedPnl,
    });
    realized += estimatedRealizedPnl;
    remaining -= take;
  }
  return { policy: lotRelief, lots, estimatedRealizedPnl: realized };
}

// ---------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------

/**
 * Propose a rebalance of the ledger's managed book toward the policy's targets at `asOf` — a plan,
 * never an execution. See the module comment for the laws and the accepted example.
 *
 * @example
 * ```ts
 * import { createMarketSnapshot } from '@totalfinance/core/artifacts';
 * import { proposePortfolioRebalance } from '@totalfinance/portfolio/policy';
 *
 * const proposal = proposePortfolioRebalance({
 *   portfolio: ledger.state,
 *   market: createMarketSnapshot({ asOf: '2026-08-29', observations: { spots: { SPY: { price: 120, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } } } }),
 *   asOf: '2026-08-29',
 *   scope: 'drift-only',
 *   policy: {
 *     targets: [
 *       { group: { tag: 'equity' }, weight: 0.6 },
 *       { group: { tag: 'fixed-income' }, weight: 0.3 },
 *       { group: { assetClass: 'cash' }, weight: 0.1 },
 *     ],
 *     driftBand: 0.03,
 *     maximumTurnover: 0.15,
 *     minimumCash: 5_000,
 *   },
 *   instrumentClassification: { SPY: { tags: ['equity'] }, AGG: { tags: ['fixed-income'] } },
 *   defaultLotSize: 1,
 * });
 * proposal.trades; // sell SPY, buy AGG — only what is outside the 3% band
 * proposal.plan.contentHash; // 'sha256:…' — a normalized plan for preflight
 * ```
 */
export function proposePortfolioRebalance(
  input: ProposePortfolioRebalanceInput,
): ProposePortfolioRebalanceResult {
  const functionName = 'proposePortfolioRebalance';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioStateShape(functionName, 'portfolio', input.portfolio);
  const state = input.portfolio;
  const baseCurrency = state.baseCurrency;
  if (input.asOf === undefined) {
    throw new InputError(
      `${functionName}: asOf is required — the book is valued and the targets resolve at an explicit instant; TotalFinance never reads the system clock.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'asOf' } },
    );
  }
  const asOf = resolveAsOf(input.asOf, functionName);
  requireEpochMsField(functionName, 'asOf', asOf);
  if (input.policy === undefined) {
    throw new InputError(
      `${functionName}: policy is required — the targets, bands, and limits are the caller's goals.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'policy' } },
    );
  }
  const policy = requireInvestmentPolicy(functionName, 'policy', input.policy);
  if (policy.model !== undefined && policy.model.baseCurrency !== baseCurrency) {
    throw new InputError(
      `${functionName}: policy.model '${policy.model.modelId}' v${policy.model.version} is stated in ${policy.model.baseCurrency}, but the portfolio's base currency is ${baseCurrency} — a model's weights are shares of a NAV in its own currency.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'policy.model.baseCurrency' },
      },
    );
  }
  const scope = requireScope(functionName, input.scope);
  const flow = requireExternalFlow(functionName, input.externalFlow, baseCurrency);
  if (input.tradingAccountId !== undefined) {
    requireIdentityString(functionName, 'tradingAccountId', input.tradingAccountId);
  }
  const sizing: AllocationSizing = requireAllocationSizing(functionName, input);
  const volumes = requireVolumes(functionName, input.averageDailyVolumes);
  const classification = requireInstrumentClassification(
    functionName,
    input.instrumentClassification,
  );
  // Flow handling is a goal: a flow without its handling is a typed refusal.
  const flowAmount = flow?.amount ?? 0;
  if (flowAmount > 0 && policy.contributionHandling === undefined) {
    throw new InputError(
      `${functionName}: externalFlow plans a contribution of ${flowAmount} ${baseCurrency}, but the policy declares no contributionHandling ('invest-to-targets' spends it on underweights first; 'hold-as-cash' leaves it in cash) — how new cash is treated is a goal, not a default.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'policy.contributionHandling' },
      },
    );
  }
  if (flowAmount < 0 && policy.withdrawalHandling === undefined) {
    throw new InputError(
      `${functionName}: externalFlow plans a withdrawal of ${-flowAmount} ${baseCurrency}, but the policy declares no withdrawalHandling ('raise-from-overweights' sells the most overweight holdings first; 'pro-rata' sells every holding proportionally) — how cash is raised is a goal, not a default.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'policy.withdrawalHandling' },
      },
    );
  }

  // ---- valuation: ONE market validator, ONE valuation law ----
  const { snapshot: market } = readMarketSnapshot({ snapshot: input.market });
  const valued = portfolioSnapshot({
    portfolio: state,
    asOf,
    market: input.market,
    ...(input.currencyConversions !== undefined
      ? { currencyConversions: input.currencyConversions }
      : {}),
  });
  const warnings: string[] = [...valued.diagnostics.warnings];
  const quotes: readonly CurrencyPairQuote[] = input.currencyConversions ?? [];
  const toBase = (amount: number, currency: string, subject: string): number =>
    currency === baseCurrency
      ? amount
      : convertWithQuotes({
          functionName,
          amount,
          fromCurrency: currency,
          toCurrency: baseCurrency,
          quotes,
          subject,
        }).convertedAmount;

  // ---- accounts: the managed book ----
  const allAccounts = Object.keys(state.accounts).sort();
  let accountsConsidered = allAccounts;
  let accountsExcluded: string[] = [];
  if (policy.allowedAccounts !== undefined) {
    const allowedSet = new Set(policy.allowedAccounts);
    accountsConsidered = allAccounts.filter((id) => allowedSet.has(id));
    accountsExcluded = allAccounts.filter((id) => !allowedSet.has(id));
    const unknown = policy.allowedAccounts.filter(
      (id) => ownValue(state.accounts, id) === undefined,
    );
    if (unknown.length > 0) {
      warnings.push(
        `policy.allowedAccounts names ${unknown.map((id) => `'${id}'`).join(', ')}, which the portfolio has no state for — nothing is booked there.`,
      );
    }
  }
  if (accountsConsidered.length === 0) {
    throw new InputError(
      `${functionName}: policy.allowedAccounts (${(policy.allowedAccounts ?? []).join(', ') || 'none'}) matches no account in the portfolio (accounts: ${allAccounts.join(', ') || 'none'}) — there is no managed book to rebalance.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'policy.allowedAccounts' },
      },
    );
  }
  const consideredSet = new Set(accountsConsidered);
  let tradingAccountId: string;
  if (accountsConsidered.length === 1) {
    tradingAccountId = accountsConsidered[0]!;
    if (input.tradingAccountId !== undefined && input.tradingAccountId !== tradingAccountId) {
      throw new InputError(
        `${functionName}: tradingAccountId '${input.tradingAccountId}' is not the managed account ('${tradingAccountId}') — buys book to an allowed account.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: 'tradingAccountId' },
        },
      );
    }
  } else {
    if (input.tradingAccountId === undefined) {
      throw new InputError(
        `${functionName}: tradingAccountId is required — the managed book spans ${accountsConsidered.length} accounts (${accountsConsidered.join(', ')}), and where BUYS book is a decision, not a default. Sells book to the account(s) holding the position.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: 'tradingAccountId' },
        },
      );
    }
    if (!consideredSet.has(input.tradingAccountId)) {
      throw new InputError(
        `${functionName}: tradingAccountId '${input.tradingAccountId}' is not one of the managed accounts (${accountsConsidered.join(', ')}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: 'tradingAccountId' },
        },
      );
    }
    tradingAccountId = input.tradingAccountId;
  }

  // ---- holdings, marks, and cash over the managed book ----
  const positionsByInstrument = new Map<string, HeldPosition[]>();
  const heldQuantity: Record<string, number> = {};
  const heldValueBase = new Map<string, number>();
  const prices: Record<string, { price: number; currency: string }> = {};
  const contractMultipliers: Record<string, number> = {};
  let managedPositionsValue = 0;
  for (const row of valued.positions) {
    if (!consideredSet.has(row.accountId)) continue;
    const list = positionsByInstrument.get(row.instrumentId) ?? [];
    list.push({
      accountId: row.accountId,
      quantity: row.quantity,
      currency: row.currency,
      markPricePerUnit: row.markPricePerUnit,
      lots: ownValue(ownValue(state.accounts, row.accountId)!.positions, row.instrumentId)!.lots,
    });
    positionsByInstrument.set(row.instrumentId, list);
    setOwnValue(
      heldQuantity,
      row.instrumentId,
      (ownValue(heldQuantity, row.instrumentId) ?? 0) + row.quantity,
    );
    // Weights and sizing use NOTIONAL (quantity × mark × multiplier); NAV uses market value.
    heldValueBase.set(
      row.instrumentId,
      (heldValueBase.get(row.instrumentId) ?? 0) + row.baseCurrencyNotionalValue,
    );
    managedPositionsValue += row.baseCurrencyMarketValue;
    setOwnValue(contractMultipliers, row.instrumentId, row.contractMultiplier);
    setOwnValue(prices, row.instrumentId, {
      price: row.markPricePerUnit,
      currency: row.currency,
    });
  }
  let totalCashBase = 0;
  let settledCashBase = 0;
  const settledByAccount = new Map<string, number>();
  for (const row of valued.cash) {
    if (!consideredSet.has(row.accountId)) continue;
    totalCashBase += row.baseCurrencyValue;
    const settled = toBase(
      row.settledAmount,
      row.currency,
      `account '${row.accountId}' settled ${row.currency} cash`,
    );
    settledCashBase += settled;
    settledByAccount.set(row.accountId, (settledByAccount.get(row.accountId) ?? 0) + settled);
  }
  const netAssetValue = totalCashBase + managedPositionsValue;
  if (accountsExcluded.length > 0) {
    const excludedValue =
      valued.cash
        .filter((row) => !consideredSet.has(row.accountId))
        .reduce((sum, row) => sum + row.baseCurrencyValue, 0) +
      valued.positions
        .filter((row) => !consideredSet.has(row.accountId))
        .reduce((sum, row) => sum + row.baseCurrencyMarketValue, 0);
    const excludedHoldings = valued.positions
      .filter((row) => !consideredSet.has(row.accountId))
      .map((row) => `${row.quantity} ${row.instrumentId} in '${row.accountId}'`);
    warnings.push(
      `${accountsExcluded.length} account${accountsExcluded.length === 1 ? '' : 's'} outside policy.allowedAccounts (${accountsExcluded.join(', ')}) hold ${excludedValue} ${baseCurrency}${excludedHoldings.length > 0 ? ` (${excludedHoldings.join('; ')})` : ''} — excluded from the managed NAV and never traded.`,
    );
  }
  if (!(netAssetValue > 0)) {
    throw new InputError(
      `${functionName}: the managed net asset value is ${netAssetValue} ${baseCurrency} (accounts ${accountsConsidered.join(', ')}) — weights need a positive NAV; deposit cash or widen policy.allowedAccounts.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'portfolio' },
      },
    );
  }
  const tolerance = netAssetValue * AMOUNT_TOLERANCE_FRACTION;

  // ---- the universe and the policy's lists ----
  const resolved = resolvePolicyTargets(functionName, policy, asOf);
  const sleeves = policy.model?.sleeves ?? [];
  const restricted = new Set(policy.restrictedInstruments ?? []);
  const allowedInstruments =
    policy.allowedInstruments === undefined ? null : new Set(policy.allowedInstruments);
  const universeAll = new Set<string>(Object.keys(heldQuantity));
  for (const id of policy.allowedInstruments ?? []) universeAll.add(id);
  for (const target of resolved.targets) {
    if (target.group.instrumentId !== undefined) universeAll.add(target.group.instrumentId);
  }
  for (const sleeve of sleeves)
    for (const member of sleeve.members ?? []) universeAll.add(member.instrumentId);
  const unresolvedTargets: UnresolvedTarget[] = [];
  const restrictedHeld = new Set<string>();
  const disallowedHeld = new Set<string>();
  for (const id of Object.keys(heldQuantity)) {
    if (restricted.has(id)) restrictedHeld.add(id);
    else if (allowedInstruments !== null && !allowedInstruments.has(id)) disallowedHeld.add(id);
  }
  const expansionUniverse = [...universeAll].filter(
    (id) => !restricted.has(id) && !disallowedHeld.has(id),
  );
  // Spots for universe instruments not held (a trade into a new name needs a priced currency).
  const spots = market.observations.spots ?? {};
  for (const id of expansionUniverse) {
    if (ownValue(prices, id) !== undefined) continue;
    const spot = ownValue(spots, id);
    if (spot === undefined) continue;
    if (spot.currency === undefined) {
      warnings.push(
        `observations.spots['${id}'] states no currency — it cannot price a trade; '${id}' is unpriced here.`,
      );
      continue;
    }
    // A spot says nothing about a contract's size. A share is 1 by construction; an OCC option
    // symbol that is not held has no multiplier anywhere in this input, and the share default
    // would size a 100-share contract at 1% of its cash value — so it stays unresolved, with the
    // reason, rather than priced wrong.
    if (ownValue(contractMultipliers, id) === undefined && isOccOptionSymbol(id)) {
      unresolvedTargets.push({
        key: `instrumentId:${id}`,
        group: { instrumentId: id },
        reason: `'${id}' is an OCC option symbol that is not held, so its contract multiplier is unknown and a market spot alone cannot size it (the share default of 1 would value each contract at one share). Hold it in the ledger with its contractMultiplier, or trade it through normalizeTradePlan with input.instruments.`,
      });
      continue;
    }
    setOwnValue(prices, id, { price: spot.price, currency: spot.currency });
  }
  const instrumentCurrency: Record<string, string> = {};
  const priceInBase = new Map<string, number>();
  for (const id of Object.keys(prices).sort()) {
    const row = ownValue(prices, id)!;
    setOwnValue(instrumentCurrency, id, row.currency);
    priceInBase.set(id, toBase(row.price, row.currency, `the ${id} mark (${row.currency})`));
  }
  const currentWeight = (id: string): number => (heldValueBase.get(id) ?? 0) / netAssetValue;
  const currentWeights: Record<string, number> = {};
  for (const id of Object.keys(heldQuantity)) {
    setOwnValue(currentWeights, id, currentWeight(id));
  }

  const expanded = expandTargets(functionName, {
    targets: resolved.targets,
    universe: expansionUniverse,
    instrumentClassification: classification,
    instrumentCurrency,
    currentWeights,
    sleeves,
    withinGroupAllocation: policy.withinGroupAllocation,
    defaultDriftBand: policy.driftBand,
  });
  unresolvedTargets.push(...expanded.unresolved);
  warnings.push(...expanded.warnings);

  // ---- the instrument target table ----
  interface TargetRow {
    target: number | null;
    driftBand: number | null;
    sourceGroups: string[];
  }
  const targetRows = new Map<string, TargetRow>();
  for (const t of expanded.instrumentTargets) {
    targetRows.set(t.instrumentId, {
      target: t.targetWeight,
      driftBand: t.driftBand,
      sourceGroups: [...t.sourceGroups],
    });
  }
  for (const id of [...restrictedHeld].sort()) {
    const named = resolved.targets.find((t) => t.group.instrumentId === id);
    if (named !== undefined) {
      unresolvedTargets.push({
        key: `instrumentId:${id}`,
        group: { instrumentId: id },
        reason: `'${id}' is in policy.restrictedInstruments and is also named by a target (weight ${named.weight ?? 'risk budget'}) — a restricted instrument cannot carry a target.`,
      });
      targetRows.set(id, {
        target: null,
        driftBand: policy.driftBand ?? null,
        sourceGroups: ['policy:restrictedInstruments'],
      });
      continue;
    }
    targetRows.set(id, {
      target: 0,
      driftBand: policy.driftBand ?? null,
      sourceGroups: ['policy:restrictedInstruments'],
    });
    warnings.push(
      `'${id}' is in policy.restrictedInstruments — its target is 0 (sell to zero); its ${String(ownValue(heldQuantity, id))} held units are excluded from every group target.`,
    );
  }
  for (const id of [...disallowedHeld].sort()) {
    unresolvedTargets.push({
      key: `instrumentId:${id}`,
      group: { instrumentId: id },
      reason: `'${id}' is held (${String(ownValue(heldQuantity, id))} units) but is not in policy.allowedInstruments — add it to allowedInstruments to keep managing it, or to restrictedInstruments to sell it to zero; it is not traded here.`,
    });
    targetRows.set(id, {
      target: null,
      driftBand: policy.driftBand ?? null,
      sourceGroups: [],
    });
  }
  const cashTargetWeight = expanded.cashTarget?.targetWeight ?? null;
  const cashBand = expanded.cashTarget?.driftBand ?? null;

  // ---- the flow ----
  const netAssetValueAfterFlow = netAssetValue + flowAmount;
  if (!(netAssetValueAfterFlow > 0)) {
    throw new InputError(
      `${functionName}: the withdrawal of ${-flowAmount} ${baseCurrency} exceeds the managed net asset value ${netAssetValue} — nothing would remain to rebalance.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'externalFlow.amount' },
      },
    );
  }
  const holdAsCash = flowAmount > 0 && policy.contributionHandling === 'hold-as-cash';
  const investContribution = flowAmount > 0 && policy.contributionHandling === 'invest-to-targets';
  const sizingNav = holdAsCash ? netAssetValue : netAssetValueAfterFlow;
  const flowHandling =
    flow === null
      ? 'No external flow: the plan is funded from settled cash and sells.'
      : flowAmount > 0
        ? holdAsCash
          ? `A contribution of ${flowAmount} ${baseCurrency} is held as cash (policy.contributionHandling 'hold-as-cash'): instrument targets are sized over the pre-flow NAV ${netAssetValue}; the contribution stays in cash and only ${scope === 'drift-only' ? 'drift' : 'to-target'} trades run.`
          : `A contribution of ${flowAmount} ${baseCurrency} is invested to targets (policy.contributionHandling 'invest-to-targets'): targets are sized over the post-flow NAV ${netAssetValueAfterFlow} and the new cash funds the most underweight instruments first${scope === 'drift-only' ? ', capped at the contribution; the remainder stays in cash' : ''}.`
        : policy.withdrawalHandling === 'raise-from-overweights'
          ? `A withdrawal of ${-flowAmount} ${baseCurrency} is raised from settled cash above the floor first, then by selling the most overweight holdings first (policy.withdrawalHandling 'raise-from-overweights'); targets are sized over the post-flow NAV ${netAssetValueAfterFlow}${scope === 'to-target' ? ' — in scope to-target every holding moves to target, so the handling only labels which sells raise the withdrawal' : ''}.`
          : `A withdrawal of ${-flowAmount} ${baseCurrency} is raised from settled cash above the floor first, then by selling every held instrument proportionally to its value (policy.withdrawalHandling 'pro-rata'); targets are sized over the post-flow NAV ${netAssetValueAfterFlow}${scope === 'to-target' ? ' — in scope to-target every holding moves to target, so the handling only labels which sells raise the withdrawal' : ''}.`;

  // ---- sizing: ONE allocatePortfolio pass over instrument-level targets ----
  const inlineTargets: AllocationTarget[] = [];
  const sizedHoldings: Record<string, number> = {};
  for (const [id, row] of [...targetRows.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    if (row.target === null) continue;
    inlineTargets.push({ group: { instrumentId: id }, weight: row.target });
    const held = ownValue(heldQuantity, id);
    if (held !== undefined) setOwnValue(sizedHoldings, id, held);
  }
  if (cashTargetWeight !== null) {
    inlineTargets.push({ group: { assetClass: CASH_ASSET_CLASS }, weight: cashTargetWeight });
  }
  const sizedPrices: Record<string, { price: number; currency: string }> = {};
  for (const id of Object.keys(prices)) {
    if (targetRows.get(id)?.target !== null && targetRows.has(id)) {
      setOwnValue(sizedPrices, id, ownValue(prices, id)!);
    }
  }
  const candidates: Candidate[] = [];
  const dustSkipped: AllocationDustRow[] = [];
  if (inlineTargets.length > 0) {
    const allocationInput: AllocatePortfolioInput = {
      policy: { targets: inlineTargets },
      asOf,
      baseCurrency,
      netAssetValue: sizingNav,
      prices: sizedPrices,
      currentHoldings: sizedHoldings,
      contractMultipliers,
      ...(input.currencyConversions !== undefined
        ? { currencyConversions: input.currencyConversions }
        : {}),
      ...(input.lotSizes !== undefined ? { lotSizes: input.lotSizes } : {}),
      ...(input.defaultLotSize !== undefined ? { defaultLotSize: input.defaultLotSize } : {}),
      ...(input.minimumNotional !== undefined ? { minimumNotional: input.minimumNotional } : {}),
      ...(input.transactionCosts !== undefined ? { transactionCosts: input.transactionCosts } : {}),
    };
    const allocation = allocatePortfolio(allocationInput);
    for (const row of allocation.unresolved) {
      if (!unresolvedTargets.some((u) => u.key === row.key)) unresolvedTargets.push(row);
    }
    dustSkipped.push(...allocation.dust);
    for (const row of allocation.allocations) {
      if (row.tradeQuantity === 0) continue;
      candidates.push({
        instrumentId: row.instrumentId,
        quantity: row.tradeQuantity,
        priceInBase: row.priceInBaseCurrency,
        markPricePerUnit: row.price,
        currency: row.currency,
        lotSize: row.lotSize,
      });
    }
  } else {
    warnings.push(
      'no target resolved to an instrument or cash weight — nothing can be sized; see unresolvedTargets.',
    );
  }

  // ---- drift (before) ----
  const cashWeightBefore = totalCashBase / netAssetValue;
  const outsideInstruments = new Set<string>();
  for (const [id, row] of targetRows) {
    if (row.target === null || row.driftBand === null) continue;
    if (Math.abs(currentWeight(id) - row.target) > row.driftBand + WEIGHT_NOISE) {
      outsideInstruments.add(id);
    }
  }
  const groupRows = expanded.groupTargets.filter((g) => !isCashTargetGroup(g.group));
  const groupCurrent = new Map<string, number>();
  const outsideGroups = new Set<string>();
  for (const group of groupRows) {
    const current = group.members.reduce((sum, id) => sum + currentWeight(id), 0);
    groupCurrent.set(group.key, current);
    if (
      group.driftBand !== null &&
      Math.abs(current - group.targetWeight) > group.driftBand + WEIGHT_NOISE
    ) {
      outsideGroups.add(group.key);
    }
  }
  const cashOutside =
    cashTargetWeight !== null &&
    cashBand !== null &&
    Math.abs(cashWeightBefore - cashTargetWeight) > cashBand + WEIGHT_NOISE;
  const instrumentIsOutside = (id: string): boolean =>
    outsideInstruments.has(id) ||
    (targetRows.get(id)?.sourceGroups ?? []).some((key) => outsideGroups.has(key));

  // ---- selection: which sized trades the scope and the flow keep ----
  const kept = new Map<string, KeptTrade>();
  const sizedCurrentWeight = (id: string): number => (heldValueBase.get(id) ?? 0) / sizingNav;
  const underweightBy = (id: string): number =>
    (targetRows.get(id)?.target ?? 0) - sizedCurrentWeight(id);
  const byId = (a: Candidate, b: Candidate): number => compareIds(a.instrumentId, b.instrumentId);
  if (investContribution) {
    const buys = candidates
      .filter((c) => c.quantity > 0)
      .sort((a, b) => underweightBy(b.instrumentId) - underweightBy(a.instrumentId) || byId(a, b));
    let remaining = flowAmount;
    for (const candidate of buys) {
      const notional = candidate.quantity * candidate.priceInBase;
      if (scope === 'to-target') {
        if (remaining <= tolerance) break;
        kept.set(candidate.instrumentId, {
          candidate,
          quantity: candidate.quantity,
          reason: 'contribution',
        });
        remaining -= notional;
        continue;
      }
      if (remaining <= tolerance) break;
      if (notional <= remaining + tolerance) {
        kept.set(candidate.instrumentId, {
          candidate,
          quantity: candidate.quantity,
          reason: 'contribution',
        });
        remaining -= notional;
      } else {
        const trimmed = roundTowardZeroToLot(remaining / candidate.priceInBase, candidate.lotSize);
        if (trimmed > 0) {
          kept.set(candidate.instrumentId, {
            candidate,
            quantity: trimmed,
            reason: 'contribution',
          });
          remaining -= trimmed * candidate.priceInBase;
        }
      }
    }
    if (scope === 'drift-only' && remaining > tolerance) {
      warnings.push(
        `the contribution exceeds the underweight buys by ${remaining} ${baseCurrency}; the remainder stays in cash (scope 'drift-only' sells nothing to reach targets).`,
      );
    }
  }
  for (const candidate of [...candidates].sort(byId)) {
    if (kept.has(candidate.instrumentId)) continue;
    if (scope === 'to-target') {
      kept.set(candidate.instrumentId, {
        candidate,
        quantity: candidate.quantity,
        reason: 'to-target',
      });
    } else if (instrumentIsOutside(candidate.instrumentId)) {
      kept.set(candidate.instrumentId, {
        candidate,
        quantity: candidate.quantity,
        reason: 'drift',
      });
    }
  }
  if (scope === 'drift-only' && cashOutside && kept.size === 0) {
    warnings.push(
      `cash is outside its band (${cashWeightBefore} vs target ${cashTargetWeight} ± ${cashBand}) but no instrument or group is — scope 'drift-only' proposes nothing; use scope 'to-target' to move cash to target.`,
    );
  }

  // Cash floor: the larger of the two spellings; 0 when neither is declared (no borrowing).
  const reserve = Math.max(
    policy.minimumCash ?? -Infinity,
    policy.minimumCashWeight === undefined
      ? -Infinity
      : policy.minimumCashWeight * netAssetValueAfterFlow,
    policy.minimumCash === undefined && policy.minimumCashWeight === undefined ? 0 : -Infinity,
  );
  const unresolvedConstraints: UnresolvedConstraint[] = [];
  const keptBuys = (): number =>
    [...kept.values()].reduce(
      (sum, k) => sum + (k.quantity > 0 ? k.quantity * k.candidate.priceInBase : 0),
      0,
    );
  const keptSells = (): number =>
    [...kept.values()].reduce(
      (sum, k) => sum + (k.quantity < 0 ? -k.quantity * k.candidate.priceInBase : 0),
      0,
    );
  if (flowAmount < 0) {
    const needed = -flowAmount;
    if (scope === 'to-target') {
      const sells = [...kept.values()]
        .filter((k) => k.quantity < 0)
        .sort(
          (a, b) =>
            underweightBy(a.candidate.instrumentId) - underweightBy(b.candidate.instrumentId) ||
            byId(a.candidate, b.candidate),
        );
      let remaining = needed;
      for (const k of sells) {
        if (remaining <= tolerance) break;
        k.reason = 'withdrawal';
        remaining -= -k.quantity * k.candidate.priceInBase;
      }
    } else {
      let toRaise = needed + reserve - settledCashBase - keptSells() + keptBuys();
      if (toRaise > tolerance) {
        if (policy.withdrawalHandling === 'raise-from-overweights') {
          const sells = candidates
            .filter((c) => c.quantity < 0 && !kept.has(c.instrumentId))
            .sort(
              (a, b) => underweightBy(a.instrumentId) - underweightBy(b.instrumentId) || byId(a, b),
            );
          for (const candidate of sells) {
            if (toRaise <= tolerance) break;
            const notional = -candidate.quantity * candidate.priceInBase;
            if (notional <= toRaise + tolerance) {
              kept.set(candidate.instrumentId, {
                candidate,
                quantity: candidate.quantity,
                reason: 'withdrawal',
              });
              toRaise -= notional;
            } else {
              const trimmed = roundTowardZeroToLot(
                toRaise / candidate.priceInBase,
                candidate.lotSize,
              );
              if (trimmed > 0) {
                kept.set(candidate.instrumentId, {
                  candidate,
                  quantity: -trimmed,
                  reason: 'withdrawal',
                });
                toRaise -= trimmed * candidate.priceInBase;
              }
            }
          }
        } else {
          const sellable = [...heldValueBase.entries()]
            .filter(
              ([id, value]) =>
                value > 0 &&
                !kept.has(id) &&
                targetRows.get(id)?.target !== null &&
                priceInBase.has(id),
            )
            .sort((a, b) => compareIds(a[0], b[0]));
          const total = sellable.reduce((sum, [, value]) => sum + value, 0);
          const target = toRaise;
          for (const [id, value] of sellable) {
            const base = priceInBase.get(id)!;
            const price = ownValue(prices, id)!;
            const share = (target * value) / total;
            const quantity = Math.min(
              roundTowardZeroToLot(share / base, lotSizeFor(sizing, id)),
              ownValue(heldQuantity, id) ?? 0,
            );
            if (quantity <= QUANTITY_DUST) continue;
            kept.set(id, {
              candidate: {
                instrumentId: id,
                quantity: -quantity,
                priceInBase: base,
                markPricePerUnit: price.price,
                currency: price.currency,
                lotSize: lotSizeFor(sizing, id),
              },
              quantity: -quantity,
              reason: 'withdrawal',
            });
            toRaise -= quantity * base;
          }
        }
        if (toRaise > tolerance) {
          unresolvedConstraints.push({
            constraint: 'withdrawal',
            status: 'violated',
            reason: `the withdrawal of ${needed} ${baseCurrency} plus the cash floor ${reserve} need ${toRaise} ${baseCurrency} more than settled cash and the proposed sells raise (${policy.withdrawalHandling} over the ${scope === 'drift-only' ? 'holdings inside their bands' : 'book'}) — lot rounding or the holdings cannot cover it; widen the scope or lower the floor.`,
            value: toRaise,
            limit: needed,
          });
        }
      }
    }
  }

  // ---- turnover cap and cash floor: trim, never relax (≤ 3 passes) ----
  const requiredTurnover =
    [...kept.values()].reduce((sum, k) => sum + Math.abs(k.quantity) * k.candidate.priceInBase, 0) /
    netAssetValueAfterFlow;
  let turnoverCapped = false;
  let cashCapped = false;
  let cashViolated: number | null = null;
  let iterations = 0;
  let converged = false;
  const rescale = (k: KeptTrade, factor: number): void => {
    k.quantity = roundTowardZeroToLot(k.quantity * factor, k.candidate.lotSize);
  };
  while (iterations < MAXIMUM_ITERATIONS) {
    iterations += 1;
    let changed = false;
    const gross = [...kept.values()].reduce(
      (sum, k) => sum + Math.abs(k.quantity) * k.candidate.priceInBase,
      0,
    );
    const turnover = gross / netAssetValueAfterFlow;
    if (
      policy.maximumTurnover !== undefined &&
      turnover > policy.maximumTurnover + AMOUNT_TOLERANCE_FRACTION
    ) {
      const factor = policy.maximumTurnover / turnover;
      for (const k of kept.values()) rescale(k, factor);
      turnoverCapped = true;
      changed = true;
    }
    const buys = keptBuys();
    const available = settledCashBase + flowAmount + keptSells() - reserve;
    if (buys > available + tolerance) {
      if (buys > 0) {
        const factor = Math.max(0, available) / buys;
        for (const k of kept.values()) if (k.quantity > 0) rescale(k, factor);
        cashCapped = true;
        changed = true;
      } else if (cashViolated === null) {
        cashViolated = available;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  {
    const gross = [...kept.values()].reduce(
      (sum, k) => sum + Math.abs(k.quantity) * k.candidate.priceInBase,
      0,
    );
    const turnoverOk =
      policy.maximumTurnover === undefined ||
      gross / netAssetValueAfterFlow <= policy.maximumTurnover + AMOUNT_TOLERANCE_FRACTION;
    const fundingOk =
      keptBuys() <= settledCashBase + flowAmount + keptSells() - reserve + tolerance;
    converged = converged && turnoverOk && fundingOk;
    if (!converged) {
      unresolvedConstraints.push({
        constraint: 'convergence',
        status: 'violated',
        reason: `the turnover cap and the cash floor did not settle in ${iterations} passes (lot rounding keeps the trimmed plan ${turnoverOk ? 'unfunded' : 'above the turnover cap'}) — the trades listed are the last pass; loosen the lot sizes or the constraint.`,
        value: gross / netAssetValueAfterFlow,
        limit: policy.maximumTurnover ?? null,
      });
    }
  }
  // Trades rounded away, or turned to dust by the trimming.
  for (const [id, k] of [...kept.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    if (k.quantity === 0) {
      kept.delete(id);
      warnings.push(`the ${id} trade rounded to zero lots after trimming and is dropped.`);
      continue;
    }
    const notional = k.quantity * k.candidate.priceInBase;
    if (sizing.minimumNotional !== null && Math.abs(notional) < sizing.minimumNotional) {
      kept.delete(id);
      dustSkipped.push({
        instrumentId: id,
        tradeNotional: notional,
        reason: `after trimming, the ${sideOf(k.quantity)} of ${Math.abs(k.quantity)} ${id} (|notional| ${Math.abs(notional)}) is below minimumNotional ${sizing.minimumNotional} — skipped.`,
      });
    }
  }

  // ---- account assignment, lot previews, costs ----
  const trades: RebalanceTrade[] = [];
  const bookTrade = (
    accountId: string,
    k: KeptTrade,
    quantity: number,
    closing: HeldPosition | null,
  ): void => {
    const c = k.candidate;
    const notionalBase = quantity * c.priceInBase;
    const cost = estimateTradeCost(sizing.transactionCosts, quantity, notionalBase);
    let lotSelection: RebalanceLotSelection | null = null;
    let lotSelectionReason: string | null = null;
    if (closing === null) {
      lotSelectionReason = 'the trade opens or extends a position; nothing is relieved.';
    } else if (state.lotRelief === 'specific-lot') {
      lotSelectionReason =
        'specific-lot relief needs caller lot selections — the ledger relieves only the lots a fill names, so no preview is possible here.';
    } else {
      lotSelection = previewLots(closing, quantity, state.lotRelief);
    }
    trades.push({
      accountId,
      instrumentId: c.instrumentId,
      side: sideOf(k.quantity),
      quantity,
      markPricePerUnit: c.markPricePerUnit,
      currency: c.currency,
      estimatedNotional: notionalBase,
      estimatedCommission: cost.commission,
      estimatedSpreadCost: cost.spread,
      estimatedSlippageCost: cost.slippage,
      lotSelection,
      lotSelectionReason,
      reason: k.reason,
    });
  };
  for (const [id, k] of [...kept.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    let remaining = Math.abs(k.quantity);
    const positions = (positionsByInstrument.get(id) ?? [])
      .filter((p) => (k.quantity < 0 ? p.quantity > 0 : p.quantity < 0))
      .sort((a, b) => compareIds(a.accountId, b.accountId));
    for (const position of positions) {
      if (remaining <= QUANTITY_DUST) break;
      const take = Math.min(remaining, Math.abs(position.quantity));
      if (take <= QUANTITY_DUST) continue;
      bookTrade(position.accountId, k, take, position);
      remaining -= take;
    }
    if (remaining > QUANTITY_DUST) bookTrade(tradingAccountId, k, remaining, null);
  }
  trades.sort(
    (a, b) => compareIds(a.instrumentId, b.instrumentId) || compareIds(a.accountId, b.accountId),
  );
  // The plan never moves cash between accounts: an account whose own settled cash, sells, and
  // (for the trading account) the flow cannot cover the buys booked to it is said, not hidden.
  for (const accountId of accountsConsidered) {
    const accountBuys = trades
      .filter((t) => t.accountId === accountId && t.side === 'buy')
      .reduce((sum, t) => sum + t.estimatedNotional, 0);
    if (accountBuys <= tolerance) continue;
    const accountSells = trades
      .filter((t) => t.accountId === accountId && t.side === 'sell')
      .reduce((sum, t) => sum + t.estimatedNotional, 0);
    const accountFlow = accountId === tradingAccountId ? flowAmount : 0;
    const accountSettled = settledByAccount.get(accountId) ?? 0;
    const shortfall = accountBuys - (accountSettled + accountSells + accountFlow);
    if (shortfall > tolerance) {
      warnings.push(
        `buys booked to '${accountId}' (${accountBuys} ${baseCurrency}) exceed its own settled cash ${accountSettled} + sells ${accountSells}${accountFlow !== 0 ? ` + flow ${accountFlow}` : ''} by ${shortfall} — the plan does not move cash between accounts; a cash.transfer into '${accountId}' is needed before execution.`,
      );
    }
  }

  // ---- post-trade book ----
  const buysTotal = trades.reduce((s, t) => s + (t.side === 'buy' ? t.estimatedNotional : 0), 0);
  const sellsTotal = trades.reduce((s, t) => s + (t.side === 'sell' ? t.estimatedNotional : 0), 0);
  const grossTotal = buysTotal + sellsTotal;
  const postQuantity = new Map<string, number>();
  for (const id of new Set([...Object.keys(heldQuantity), ...kept.keys()])) {
    postQuantity.set(id, (ownValue(heldQuantity, id) ?? 0) + (kept.get(id)?.quantity ?? 0));
  }
  const postCash = totalCashBase + flowAmount - buysTotal + sellsTotal;
  const postSettled = settledCashBase + flowAmount - buysTotal + sellsTotal;
  const weightsBefore = new Map<string, number>();
  const weightsAfter = new Map<string, number>();
  const instrumentIds = [...new Set([...targetRows.keys(), ...Object.keys(heldQuantity)])].sort();
  for (const id of instrumentIds) {
    weightsBefore.set(id, currentWeight(id));
    const base = priceInBase.get(id);
    const quantity = postQuantity.get(id) ?? 0;
    weightsAfter.set(
      id,
      base === undefined
        ? (heldValueBase.get(id) ?? 0) / netAssetValueAfterFlow
        : (quantity * base) / netAssetValueAfterFlow,
    );
  }
  const cashWeightAfter = postCash / netAssetValueAfterFlow;
  const instrumentWeights: RebalanceInstrumentWeight[] = instrumentIds.map((id) => {
    const row = targetRows.get(id) ?? { target: null, driftBand: null, sourceGroups: [] };
    return {
      instrumentId: id,
      current: weightsBefore.get(id)!,
      target: row.target,
      postTrade: weightsAfter.get(id)!,
      driftBand: row.driftBand,
      outsideBand: outsideInstruments.has(id),
      sourceGroups: [...row.sourceGroups],
    };
  });
  const groupWeights: RebalanceGroupWeight[] = groupRows
    .map((group) => ({
      key: group.key,
      current: groupCurrent.get(group.key)!,
      target: group.targetWeight,
      postTrade: group.members.reduce((sum, id) => sum + (weightsAfter.get(id) ?? 0), 0),
      driftBand: group.driftBand,
      outsideBand: outsideGroups.has(group.key),
    }))
    .sort((a, b) => compareIds(a.key, b.key));

  // ---- objective and risk ----
  const driftDistance = (weights: Map<string, number>, cashWeight: number): number => {
    let total = 0;
    for (const [id, row] of targetRows) {
      if (row.target === null) continue;
      total += Math.abs((weights.get(id) ?? 0) - row.target);
    }
    if (cashTargetWeight !== null) total += Math.abs(cashWeight - cashTargetWeight);
    return total / 2;
  };
  const benchmark = policy.benchmark ?? policy.model?.benchmark;
  const constituents = benchmark?.constituents;
  const trackingDistance = (weights: Map<string, number>, cashWeight: number): number | null => {
    if (constituents === undefined) return null;
    const benchmarkWeight = new Map(constituents.map((c) => [c.instrumentId, c.weight]));
    const ids = new Set([...weights.keys(), ...benchmarkWeight.keys()]);
    let total = Math.abs(cashWeight);
    for (const id of ids)
      total += Math.abs((weights.get(id) ?? 0) - (benchmarkWeight.get(id) ?? 0));
    return total / 2;
  };
  if (constituents === undefined) {
    warnings.push(
      benchmark === undefined
        ? 'trackingDistance is null: the policy declares no benchmark.'
        : `trackingDistance is null: benchmark '${benchmark.benchmarkId}' declares no constituents.`,
    );
  }
  const objectiveBefore: RebalanceObjectivePoint = {
    driftDistance: driftDistance(weightsBefore, cashWeightBefore),
    trackingDistance: trackingDistance(weightsBefore, cashWeightBefore),
  };
  const objectiveAfter: RebalanceObjectivePoint = {
    driftDistance: driftDistance(weightsAfter, cashWeightAfter),
    trackingDistance: trackingDistance(weightsAfter, cashWeightAfter),
  };
  if (turnoverCapped) {
    unresolvedConstraints.push({
      constraint: 'maximumTurnover',
      status: 'capped',
      reason: `targets need ${requiredTurnover} turnover; capped at ${policy.maximumTurnover} — residual drift ${objectiveAfter.driftDistance} remains.`,
      value: requiredTurnover,
      limit: policy.maximumTurnover ?? null,
    });
  }
  if (cashCapped) {
    unresolvedConstraints.push({
      constraint: 'minimumCash',
      status: 'capped',
      reason: `buys were scaled to the ${settledCashBase + flowAmount + sellsTotal - reserve} ${baseCurrency} available above the cash floor ${reserve} (settled cash ${settledCashBase} + flow ${flowAmount} + sells ${sellsTotal}) — residual drift ${objectiveAfter.driftDistance} remains.`,
      value: postSettled,
      limit: reserve,
    });
  }
  if (cashViolated !== null) {
    unresolvedConstraints.push({
      constraint: 'minimumCash',
      status: 'violated',
      reason: `post-trade settled cash ${postSettled} ${baseCurrency} is below the cash floor ${reserve} by ${reserve - postSettled} and no buys remain to scale — raise more cash or lower the floor.`,
      value: postSettled,
      limit: reserve,
    });
  }

  // ---- post-trade hard limits: reported, never auto-fixed ----
  const limits = policy.limits;
  const estimates: RebalanceEstimates = {
    commission: trades.reduce((s, t) => s + t.estimatedCommission, 0),
    spread: trades.reduce((s, t) => s + t.estimatedSpreadCost, 0),
    slippage: trades.reduce((s, t) => s + t.estimatedSlippageCost, 0),
    totalCost: 0,
    turnover: grossTotal / netAssetValueAfterFlow,
  };
  estimates.totalCost = estimates.commission + estimates.spread + estimates.slippage;
  if (limits?.maximumPositionWeight !== undefined) {
    for (const id of instrumentIds) {
      const w = Math.abs(weightsAfter.get(id)!);
      if (w > limits.maximumPositionWeight + WEIGHT_NOISE) {
        unresolvedConstraints.push({
          constraint: 'maximumPositionWeight',
          status: 'violated',
          reason: `'${id}' would be ${w} of NAV after the trades, above limits.maximumPositionWeight ${limits.maximumPositionWeight} — the targets ask for it; nothing was relaxed.`,
          value: w,
          limit: limits.maximumPositionWeight,
        });
      }
    }
  }
  if (limits?.maximumGroupWeights !== undefined) {
    for (const limit of limits.maximumGroupWeights) {
      const key = targetGroupKey(limit.group);
      const members = groupMembers(
        limit.group,
        key,
        instrumentIds,
        classification,
        instrumentCurrency,
        sleeves,
      );
      const value =
        key === `assetClass:${CASH_ASSET_CLASS}`
          ? Math.abs(cashWeightAfter)
          : members.reduce((sum, id) => sum + Math.abs(weightsAfter.get(id) ?? 0), 0);
      if (value > limit.maximumWeight + WEIGHT_NOISE) {
        unresolvedConstraints.push({
          constraint: `maximumGroupWeights:${key}`,
          status: 'violated',
          reason: `'${key}' would be ${value} of NAV after the trades (${members.join(', ') || 'cash'}), above its maximumWeight ${limit.maximumWeight}.`,
          value,
          limit: limit.maximumWeight,
        });
      }
    }
  }
  const riskBefore = riskPoint(weightsBefore, cashWeightBefore);
  const riskAfter = riskPoint(weightsAfter, cashWeightAfter);
  if (
    limits?.maximumGrossLeverage !== undefined &&
    riskAfter.grossLeverage > limits.maximumGrossLeverage + WEIGHT_NOISE
  ) {
    unresolvedConstraints.push({
      constraint: 'maximumGrossLeverage',
      status: 'violated',
      reason: `gross exposure would be ${riskAfter.grossLeverage} × NAV after the trades, above limits.maximumGrossLeverage ${limits.maximumGrossLeverage}.`,
      value: riskAfter.grossLeverage,
      limit: limits.maximumGrossLeverage,
    });
  }
  if (
    limits?.minimumSettledCash !== undefined &&
    postSettled < limits.minimumSettledCash - tolerance
  ) {
    unresolvedConstraints.push({
      constraint: 'minimumSettledCash',
      status: 'violated',
      reason: `post-trade settled cash would be ${postSettled} ${baseCurrency}, below limits.minimumSettledCash ${limits.minimumSettledCash}.`,
      value: postSettled,
      limit: limits.minimumSettledCash,
    });
  }
  if (
    policy.maximumEstimatedTransactionCost !== undefined &&
    estimates.totalCost > policy.maximumEstimatedTransactionCost + tolerance
  ) {
    unresolvedConstraints.push({
      constraint: 'maximumEstimatedTransactionCost',
      status: 'violated',
      reason: `the estimated transaction cost ${estimates.totalCost} ${baseCurrency} exceeds policy.maximumEstimatedTransactionCost ${policy.maximumEstimatedTransactionCost}.`,
      value: estimates.totalCost,
      limit: policy.maximumEstimatedTransactionCost,
    });
  }
  if (limits?.maximumDaysToLiquidate !== undefined) {
    const missing: string[] = [];
    for (const id of instrumentIds) {
      const quantity = Math.abs(postQuantity.get(id) ?? 0);
      if (quantity <= QUANTITY_DUST) continue;
      const volume = ownValue(volumes, id);
      if (volume === undefined) {
        missing.push(id);
        continue;
      }
      const days = quantity / (volume * LIQUIDITY_PARTICIPATION_RATE);
      if (days > limits.maximumDaysToLiquidate + WEIGHT_NOISE) {
        unresolvedConstraints.push({
          constraint: 'maximumDaysToLiquidate',
          status: 'violated',
          reason: `'${id}' would take ${days} days to liquidate ${quantity} units at ${LIQUIDITY_PARTICIPATION_RATE} of its ${volume}/day volume, above limits.maximumDaysToLiquidate ${limits.maximumDaysToLiquidate}.`,
          value: days,
          limit: limits.maximumDaysToLiquidate,
        });
      }
    }
    if (missing.length > 0) {
      unresolvedConstraints.push({
        constraint: 'maximumDaysToLiquidate',
        status: 'unverifiable',
        reason: `limits.maximumDaysToLiquidate ${limits.maximumDaysToLiquidate} cannot be evaluated for ${missing.join(', ')} — supply averageDailyVolumes for every post-trade position.`,
        value: null,
        limit: limits.maximumDaysToLiquidate,
      });
    }
  }
  unresolvedConstraints.sort(
    (a, b) => compareIds(a.constraint, b.constraint) || compareIds(a.reason, b.reason),
  );

  // ---- the plan artifact ----
  const policyContentHash = contentHash(policy);
  const planTrades: TradePlanTrade[] = trades
    .map((t) => ({
      accountId: t.accountId,
      instrumentId: t.instrumentId,
      side: t.side,
      quantity: t.quantity,
      currency: t.currency,
      referencePricePerUnit: t.markPricePerUnit,
      // The ledger's multiplier for a held instrument; 1 for a plain instrument priced from a spot
      // (an OCC symbol never reaches here without one — see the spot loop above).
      contractMultiplier: ownValue(contractMultipliers, t.instrumentId) ?? 1,
      estimatedNotional:
        t.quantity * t.markPricePerUnit * (ownValue(contractMultipliers, t.instrumentId) ?? 1),
    }))
    .sort(
      (a, b) =>
        compareIds(a.accountId, b.accountId) ||
        compareIds(a.instrumentId, b.instrumentId) ||
        compareIds(a.side, b.side),
    );
  const planBody = {
    kind: TRADE_PLAN_KIND,
    schemaVersion: TRADE_PLAN_SCHEMA_VERSION,
    asOf,
    baseCurrency,
    ...(state.portfolioId !== undefined ? { portfolioId: state.portfolioId } : {}),
    policyContentHash,
    trades: planTrades,
  } as const;
  const plan: TradePlanArtifact = { ...planBody, contentHash: contentHash(planBody) };

  const sortedUnresolvedTargets = sortUnresolved(unresolvedTargets);
  const feasible =
    sortedUnresolvedTargets.length === 0 &&
    converged &&
    unresolvedConstraints.every((row) => row.status === 'capped');
  dustSkipped.sort((a, b) => compareIds(a.instrumentId, b.instrumentId));

  return deepFreeze(
    requireRepresentableResult(functionName, {
      asOf,
      baseCurrency,
      netAssetValue,
      netAssetValueAfterFlow,
      weights: {
        instruments: instrumentWeights,
        groups: groupWeights,
        cash: { current: cashWeightBefore, target: cashTargetWeight, postTrade: cashWeightAfter },
      },
      cash: {
        available: settledCashBase + flowAmount,
        raised: sellsTotal,
        used: buysTotal,
        remainingReserve: postSettled,
        minimumReserve: reserve,
      },
      trades,
      estimates,
      objective: {
        before: objectiveBefore,
        after: objectiveAfter,
        convention:
          'driftDistance = Σ|weight − target| ÷ 2 over instrument targets and cash (0 = at target, 1 = fully misallocated); trackingDistance = active share vs the benchmark constituents, Σ|weight − benchmark weight| ÷ 2 with cash as an asset the benchmark does not hold — null when the policy names no constituents.',
      },
      risk: { before: riskBefore, after: riskAfter },
      unresolvedTargets: sortedUnresolvedTargets,
      unresolvedConstraints,
      convergence: { converged, iterations },
      dust: {
        skipped: dustSkipped,
        aggregateNotional: dustSkipped.reduce((sum, row) => sum + row.tradeNotional, 0),
      },
      feasible,
      plan,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        lotRelief: state.lotRelief,
        targetSource: resolved.source,
        scope,
        flowHandling,
        rounding: describeRounding(
          sizing,
          [...kept.keys()].filter((id) => lotSizeFor(sizing, id) === null).sort(),
        ),
        costModel: `${describeCostModel(sizing.transactionCosts)} commissionPerTrade applies per proposed trade row (one per account × instrument).`,
        liquidityParticipationRate: LIQUIDITY_PARTICIPATION_RATE,
        conventions: CONVENTIONS,
      },
      diagnostics: {
        warnings,
        accountsConsidered,
        accountsExcluded,
        tradeCount: trades.length,
        dustCount: dustSkipped.length,
      },
    }),
  );
}

/** The instruments a group-weight limit covers, from the same identity vocabulary the targets use. */
function groupMembers(
  group: TargetGroup,
  key: string,
  instrumentIds: readonly string[],
  classification: Record<string, InstrumentClassification>,
  instrumentCurrency: Record<string, string>,
  sleeves: readonly ModelSleeve[],
): string[] {
  if (group.instrumentId !== undefined) return [group.instrumentId];
  if (group.sleeveId !== undefined) return sleeveLeafMembers(group.sleeveId, sleeves);
  return instrumentIds.filter((id) =>
    instrumentGroupKeys(
      id,
      ownValue(classification, id),
      ownValue(instrumentCurrency, id),
    ).includes(key),
  );
}
