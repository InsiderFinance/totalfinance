/**
 * `portfolioPnl` — the reconciled P&L decomposition between two valuation marks (FC7 slice 2,
 * 2026-08-28; agent-native "Derived state and reports"). The identity it reports is the doc's,
 * verbatim, and it holds EXACTLY by construction of the fold:
 *
 *   ending NAV − beginning NAV − external flows
 *     = realized P&L + unrealized P&L + income − transaction costs − financing
 *     + foreign-exchange P&L + explicitly unexplained residual
 *
 * Convention (stated in `assumptions.identity`, tested to a 1e-9 residual on a multi-currency
 * journey): every local-currency component over the window converts to base at the CLOSING mark's
 * quote, and foreign-exchange P&L is (a) the translation of each non-base currency's OPENING value
 * by the quote change plus (b) every `cash.conversion` valued at closing quotes (what was received
 * minus what was given). Algebraically `ΔNAV = Σ_c (ΔL_c · q_end,c) + Σ_c L_begin,c · (q_end,c −
 * q_begin,c)`, and each currency's local change is exactly the sum of its booked components, so
 * the residual is float rounding — anything larger is disclosed with a warning, never absorbed.
 *
 * Grouping (position, instrument, account, currency, underlying, asset class, strategy, tag): the
 * instrument-attributable components are grouped by the caller's classification; whatever no
 * instrument owns (account-level costs, financing, FX) lands in an explicit `unattributed` row, so
 * every partitioning dimension reconciles to the total to 1e-9. Tags overlap by nature — that
 * dimension is emitted with `reconciles: false` and the reason.
 */

import type { EpochMs } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireRepresentableResult,
  stableSum,
} from '@totalfinance/core';
import type { CashConversionEvent, CashDepositEvent, CashWithdrawalEvent } from './events.js';
import type { CurrencyPairQuote } from './internal.js';
import {
  convertWithQuotes,
  deepFreeze,
  ownValue,
  positionGroupingLabel,
  requireIdentityString,
  setOwnValue,
} from './internal.js';
import type { PortfolioLedger } from './ledger.js';
import type { MarkWindow, PortfolioValuationMark } from './marks.js';
import { foldToMarks, requireValuationMarks } from './marks.js';
import type { LotReliefPolicy } from './state.js';
import { requirePortfolioLedger } from './state.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

/** Caller-supplied identity metadata for grouping; every field optional, unknown instruments group as `unclassified`. */
export interface InstrumentClassification {
  underlying?: string;
  assetClass?: string;
  strategy?: string;
  /** Overlapping by nature — the `tag` grouping does not partition the total. */
  tags?: string[];
}

export type PortfolioGroupingDimension =
  | 'position'
  | 'instrument'
  | 'account'
  | 'currency'
  | 'underlying'
  | 'assetClass'
  | 'strategy'
  | 'tag';

/** P&L components in the base currency. `totalPnl` is their signed sum. */
export interface PortfolioPnlComponents {
  realizedPnl: number;
  unrealizedPnl: number;
  income: number;
  transactionCosts: number;
  financing: number;
  foreignExchangePnl: number;
  totalPnl: number;
}

export interface PortfolioPnlGroupRow extends PortfolioPnlComponents {
  label: string;
}

export interface PortfolioPnlGrouping {
  dimension: PortfolioGroupingDimension;
  /** Sorted by label — deterministic. */
  rows: PortfolioPnlGroupRow[];
  /** Components no row owns (account-level costs, financing, foreign exchange) — explicit, never dropped. */
  unattributed: PortfolioPnlComponents;
  /** `components.totalPnl − Σ rows.totalPnl − unattributed.totalPnl`; 0 within 1e-9 for partitioning dimensions. */
  reconciliationResidual: number;
  reconciles: boolean;
  /** Present exactly when `reconciles` is false. */
  reason?: string;
}

/** One currency's ledger over the window, in that currency's own units unless stated. */
export interface PortfolioPnlCurrencyRow {
  currency: string;
  /** Base per unit of this currency at the opening and closing marks (1 for the base currency). */
  quoteAtStart: number;
  quoteAtEnd: number;
  /** Cash plus position market value in this currency at the opening / closing mark. */
  openingLocalValue: number;
  closingLocalValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  income: number;
  transactionCosts: number;
  financing: number;
  /** Deposits − withdrawals in this currency over the window. */
  externalFlows: number;
  /** Net local effect of `cash.conversion` events on this currency (received − given). */
  conversionNet: number;
  /** BASE currency: `openingLocalValue × (quoteAtEnd − quoteAtStart)`. */
  translationEffectBaseCurrency: number;
}

export interface PortfolioPnlInput {
  ledger: PortfolioLedger;
  from: PortfolioValuationMark;
  to: PortfolioValuationMark;
  instrumentClassification?: Record<string, InstrumentClassification>;
}

export interface PortfolioPnlResult {
  baseCurrency: string;
  from: { valuationDate: string; asOf: EpochMs; netAssetValue: number };
  to: { valuationDate: string; asOf: EpochMs; netAssetValue: number };
  /** `to.netAssetValue − from.netAssetValue`. */
  netAssetValueChange: number;
  /** Deposits − withdrawals over the window, in base currency at closing quotes. */
  externalFlows: number;
  /** `netAssetValueChange − externalFlows` — the investment return the components explain. */
  investmentReturn: number;
  /** The explained decomposition; `components.totalPnl + residual === investmentReturn`. */
  components: PortfolioPnlComponents;
  /** `investmentReturn − components.totalPnl` — float rounding by construction; larger is warned. */
  residual: number;
  byCurrency: PortfolioPnlCurrencyRow[];
  groupings: PortfolioPnlGrouping[];
  assumptions: {
    conventionsVersion: string;
    lotRelief: LotReliefPolicy;
    /** The identity, stated. */
    identity: string;
    /** The conversion convention, stated. */
    conversionConvention: string;
    residualTolerance: number;
  };
  diagnostics: {
    warnings: string[];
    /** Events with `from ≤ effectiveTimestampMs < to`. */
    eventCount: number;
    residualWithinTolerance: boolean;
  };
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

const INPUT_KEYS = ['ledger', 'from', 'to', 'instrumentClassification'] as const;
const CLASSIFICATION_KEYS = ['underlying', 'assetClass', 'strategy', 'tags'] as const;
export const GROUPING_DIMENSIONS: readonly PortfolioGroupingDimension[] = [
  'position',
  'instrument',
  'account',
  'currency',
  'underlying',
  'assetClass',
  'strategy',
  'tag',
];
const UNCLASSIFIED = 'unclassified';
const RESIDUAL_TOLERANCE = 1e-9;

const IDENTITY =
  'ending NAV − beginning NAV − external flows = realized P&L + unrealized P&L + income − ' +
  'transaction costs − financing + foreign-exchange P&L + residual. Beginning and ending NAV are ' +
  'portfolioSnapshot at the two marks (each mark folds every event strictly before 00:00 UTC of ' +
  'its date); external flows are cash.deposit minus cash.withdrawal over the window; realized, ' +
  'income, costs, and financing are the differences of the fold accumulators; unrealized P&L is ' +
  'the difference of open-lot mark-to-market; the residual is what the components leave ' +
  'unexplained and is float rounding by construction.';

const CONVERSION_CONVENTION =
  'Every local-currency component over the window converts to base at the CLOSING mark’s quote. ' +
  'Foreign-exchange P&L = Σ over non-base currencies of opening local value × (closing quote − ' +
  'opening quote) [translation] + Σ over cash.conversion events of (amount received × closing ' +
  'quote of the received currency − amount given × closing quote of the given currency). Note ' +
  'that portfolioPerformanceInputs converts external flows at the FLOW-DATE mark for FC4; this ' +
  'report converts them at the closing mark so the identity holds exactly.';

const EXAMPLE_CALL =
  "portfolioPnl({ ledger, from: { valuationDate: '2026-01-02', market: januaryMarket }, to: { valuationDate: '2026-02-01', market: februaryMarket }, instrumentClassification: { AAPL: { underlying: 'AAPL', assetClass: 'equity', strategy: 'core', tags: ['tech'] } } })";

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

/** Validate a caller's classification map (shared with the timeline). */
export function requireInstrumentClassification(
  functionName: string,
  value: unknown,
): Record<string, InstrumentClassification> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, 'instrumentClassification', value);
  const map = value as Record<string, unknown>;
  const out: Record<string, InstrumentClassification> = {};
  for (const instrumentId of Object.keys(map).sort()) {
    const path = `instrumentClassification['${instrumentId}']`;
    requireIdentityString(functionName, `instrumentClassification key`, instrumentId);
    const entry = ownValue(map, instrumentId);
    requireArgumentObject(functionName, path, entry);
    ensureKnownKeys(functionName, path, entry as object, CLASSIFICATION_KEYS);
    const record = entry as Record<string, unknown>;
    const cleaned: InstrumentClassification = {};
    for (const field of ['underlying', 'assetClass', 'strategy'] as const) {
      if (record[field] !== undefined) {
        requireIdentityString(functionName, `${path}.${field}`, record[field]);
        cleaned[field] = record[field] as string;
      }
    }
    if (record['tags'] !== undefined) {
      if (!Array.isArray(record['tags'])) {
        throw new InputError(
          `${functionName}: ${path}.tags must be an array of non-empty strings. Received ${record['tags'] === null ? 'null' : typeof record['tags']}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: `${path}.tags` },
          },
        );
      }
      record['tags'].forEach((tag, index) =>
        requireIdentityString(functionName, `${path}.tags[${index}]`, tag),
      );
      cleaned.tags = [...new Set(record['tags'] as string[])].sort();
    }
    setOwnValue(out, instrumentId, cleaned);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The kernel — shared with the timeline
// ---------------------------------------------------------------------------------------------------

interface CurrencyLedger {
  openingLocalValue: number;
  closingLocalValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  income: number;
  transactionCosts: number;
  financing: number;
  externalFlows: number;
  conversionNet: number;
}

interface InstrumentAttribution {
  accountId: string;
  instrumentId: string;
  /** In the instrument's own currencies — converted at closing quotes when grouped. */
  realizedPnl: Record<string, number>;
  income: Record<string, number>;
  transactionCosts: Record<string, number>;
  /** Local currency of the position (one per position). */
  unrealizedPnl: Record<string, number>;
}

/** Everything `portfolioPnl` reports for one window; the timeline consumes the same object per step. */
export interface PnlWindowComputation {
  netAssetValueChange: number;
  externalFlows: number;
  investmentReturn: number;
  components: PortfolioPnlComponents;
  residual: number;
  byCurrency: PortfolioPnlCurrencyRow[];
  groupings: PortfolioPnlGrouping[];
  warnings: string[];
  eventCount: number;
}

const totalOf = (c: Omit<PortfolioPnlComponents, 'totalPnl'>): number =>
  stableSum([
    c.realizedPnl,
    c.unrealizedPnl,
    c.income,
    -c.transactionCosts,
    -c.financing,
    c.foreignExchangePnl,
  ]);

function quoteToBase(
  functionName: string,
  mark: PortfolioValuationMark,
  currency: string,
  baseCurrency: string,
  subject: string,
): number {
  if (currency === baseCurrency) return 1;
  return convertWithQuotes({
    functionName,
    amount: 1,
    fromCurrency: currency,
    toCurrency: baseCurrency,
    quotes: mark.currencyConversions ?? [],
    subject,
  }).convertedAmount;
}

function deltaOf(
  from: Readonly<Record<string, number>> | undefined,
  to: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const currency of new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])) {
    const delta =
      (to === undefined ? 0 : (ownValue(to, currency) ?? 0)) -
      (from === undefined ? 0 : (ownValue(from, currency) ?? 0));
    if (delta !== 0) setOwnValue(out, currency, delta);
  }
  return out;
}

export function computePnlWindow(
  functionName: string,
  ledger: PortfolioLedger,
  from: MarkWindow,
  to: MarkWindow,
  classification: Record<string, InstrumentClassification>,
): PnlWindowComputation {
  const baseCurrency = ledger.state.baseCurrency;
  const warnings: string[] = [];
  const currencies = new Map<string, CurrencyLedger>();
  const ledgerOf = (currency: string): CurrencyLedger => {
    const existing = currencies.get(currency);
    if (existing) return existing;
    const created: CurrencyLedger = {
      openingLocalValue: 0,
      closingLocalValue: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      income: 0,
      transactionCosts: 0,
      financing: 0,
      externalFlows: 0,
      conversionNet: 0,
    };
    currencies.set(currency, created);
    return created;
  };

  // Opening / closing local values (cash at face + positions at mark) per currency.
  for (const row of from.valued.cash) ledgerOf(row.currency).openingLocalValue += row.totalAmount;
  for (const row of from.valued.positions)
    ledgerOf(row.currency).openingLocalValue += row.marketValue;
  for (const row of to.valued.cash) ledgerOf(row.currency).closingLocalValue += row.totalAmount;
  for (const row of to.valued.positions)
    ledgerOf(row.currency).closingLocalValue += row.marketValue;

  // Accumulator deltas per currency, and per-instrument attribution.
  const attribution: InstrumentAttribution[] = [];
  const attributionByAccount = new Map<string, Map<string, InstrumentAttribution>>();
  const attributionOf = (accountId: string, instrumentId: string): InstrumentAttribution => {
    let byInstrument = attributionByAccount.get(accountId);
    if (byInstrument === undefined) {
      byInstrument = new Map<string, InstrumentAttribution>();
      attributionByAccount.set(accountId, byInstrument);
    }
    const existing = byInstrument.get(instrumentId);
    if (existing) return existing;
    const created: InstrumentAttribution = {
      accountId,
      instrumentId,
      realizedPnl: {},
      income: {},
      transactionCosts: {},
      unrealizedPnl: {},
    };
    byInstrument.set(instrumentId, created);
    attribution.push(created);
    return created;
  };
  const accountIds = new Set([
    ...Object.keys(from.state.accounts),
    ...Object.keys(to.state.accounts),
  ]);
  for (const accountId of [...accountIds].sort()) {
    const before = ownValue(from.state.accounts, accountId);
    const after = ownValue(to.state.accounts, accountId);
    for (const [currency, delta] of Object.entries(
      deltaOf(before?.realizedPnl, after?.realizedPnl),
    ))
      ledgerOf(currency).realizedPnl += delta;
    for (const [currency, delta] of Object.entries(
      deltaOf(before?.incomeReceived, after?.incomeReceived),
    ))
      ledgerOf(currency).income += delta;
    for (const [currency, delta] of Object.entries(
      deltaOf(before?.transactionCosts, after?.transactionCosts),
    ))
      ledgerOf(currency).transactionCosts += delta;
    for (const [currency, delta] of Object.entries(
      deltaOf(before?.financingCosts, after?.financingCosts),
    ))
      ledgerOf(currency).financing += delta;
    for (const field of [
      'realizedPnlByInstrument',
      'incomeByInstrument',
      'transactionCostsByInstrument',
    ] as const) {
      const instruments = new Set([
        ...Object.keys(before?.[field] ?? {}),
        ...Object.keys(after?.[field] ?? {}),
      ]);
      for (const instrumentId of instruments) {
        const beforeAmounts =
          before === undefined ? undefined : ownValue(before[field], instrumentId);
        const afterAmounts = after === undefined ? undefined : ownValue(after[field], instrumentId);
        const delta = deltaOf(beforeAmounts, afterAmounts);
        if (Object.keys(delta).length === 0) continue;
        const target = attributionOf(accountId, instrumentId);
        const bucket =
          field === 'realizedPnlByInstrument'
            ? target.realizedPnl
            : field === 'incomeByInstrument'
              ? target.income
              : target.transactionCosts;
        for (const [currency, amount] of Object.entries(delta)) {
          setOwnValue(bucket, currency, (ownValue(bucket, currency) ?? 0) + amount);
        }
      }
    }
  }

  // Unrealized: the difference of open-lot mark-to-market, per position (closed positions are 0).
  type ValuedPosition = (typeof from.valued.positions)[number];
  const positionsByIdentity = (
    rows: readonly ValuedPosition[],
  ): Map<string, Map<string, ValuedPosition>> => {
    const byAccount = new Map<string, Map<string, ValuedPosition>>();
    for (const row of rows) {
      let byInstrument = byAccount.get(row.accountId);
      if (byInstrument === undefined) {
        byInstrument = new Map<string, ValuedPosition>();
        byAccount.set(row.accountId, byInstrument);
      }
      byInstrument.set(row.instrumentId, row);
    }
    return byAccount;
  };
  const unrealizedBefore = positionsByIdentity(from.valued.positions);
  const unrealizedAfter = positionsByIdentity(to.valued.positions);
  for (const accountId of new Set([...unrealizedBefore.keys(), ...unrealizedAfter.keys()])) {
    const beforeByInstrument = unrealizedBefore.get(accountId);
    const afterByInstrument = unrealizedAfter.get(accountId);
    for (const instrumentId of new Set([
      ...(beforeByInstrument?.keys() ?? []),
      ...(afterByInstrument?.keys() ?? []),
    ])) {
      const before = beforeByInstrument?.get(instrumentId);
      const after = afterByInstrument?.get(instrumentId);
      const currency = (after ?? before)!.currency;
      if (before !== undefined && after !== undefined && before.currency !== after.currency) {
        throw new InputError(
          `${functionName}: ${accountId} / ${instrumentId} changed trading currency between the marks (${before.currency} → ${after.currency}) — a position's currency is fixed for its life in this slice.`,
          { code: ErrorCode.InputOutOfRange, context: { function: functionName } },
        );
      }
      const delta = (after?.unrealizedPnl ?? 0) - (before?.unrealizedPnl ?? 0);
      if (delta === 0) continue;
      ledgerOf(currency).unrealizedPnl += delta;
      const target = attributionOf(accountId, instrumentId);
      setOwnValue(
        target.unrealizedPnl,
        currency,
        (ownValue(target.unrealizedPnl, currency) ?? 0) + delta,
      );
    }
  }

  // Window events: external flows and conversions.
  const conversions: { event: CashConversionEvent; eventId: string }[] = [];
  for (const envelope of to.eventsSincePrior) {
    switch (envelope.event.eventType) {
      case 'cash.deposit':
      case 'cash.withdrawal': {
        const event = envelope.event as CashDepositEvent | CashWithdrawalEvent;
        ledgerOf(event.currency).externalFlows +=
          envelope.event.eventType === 'cash.deposit' ? event.amount : -event.amount;
        break;
      }
      case 'cash.conversion': {
        const event = envelope.event as CashConversionEvent;
        ledgerOf(event.fromCurrency).conversionNet -= event.fromAmount;
        ledgerOf(event.toCurrency).conversionNet += event.toAmount;
        conversions.push({ event, eventId: envelope.eventId });
        break;
      }
      default:
        break;
    }
  }

  // Quotes: closing for every currency with any activity or closing value; opening only where an
  // opening value exists (a currency that appears mid-window has no opening translation).
  const quoteEnd = new Map<string, number>();
  const quoteStart = new Map<string, number>();
  for (const [currency, row] of currencies) {
    const active =
      row.closingLocalValue !== 0 ||
      row.realizedPnl !== 0 ||
      row.unrealizedPnl !== 0 ||
      row.income !== 0 ||
      row.transactionCosts !== 0 ||
      row.financing !== 0 ||
      row.externalFlows !== 0 ||
      row.conversionNet !== 0 ||
      row.openingLocalValue !== 0;
    quoteEnd.set(
      currency,
      active
        ? quoteToBase(
            functionName,
            to.mark,
            currency,
            baseCurrency,
            `the ${to.mark.valuationDate} mark (${currency} activity over the window)`,
          )
        : 1,
    );
    quoteStart.set(
      currency,
      row.openingLocalValue !== 0
        ? quoteToBase(
            functionName,
            from.mark,
            currency,
            baseCurrency,
            `the ${from.mark.valuationDate} mark (${currency} opening value)`,
          )
        : quoteEnd.get(currency)!,
    );
  }
  const toBaseAtEnd = (amount: number, currency: string): number =>
    amount * quoteEnd.get(currency)!;

  // Components in base at closing quotes; FX = translation + conversions at closing quotes.
  const byCurrency: PortfolioPnlCurrencyRow[] = [];
  const parts = {
    realizedPnl: [] as number[],
    unrealizedPnl: [] as number[],
    income: [] as number[],
    transactionCosts: [] as number[],
    financing: [] as number[],
    externalFlows: [] as number[],
    foreignExchangePnl: [] as number[],
  };
  for (const currency of [...currencies.keys()].sort()) {
    const row = currencies.get(currency)!;
    const qEnd = quoteEnd.get(currency)!;
    const qStart = quoteStart.get(currency)!;
    const translation = currency === baseCurrency ? 0 : row.openingLocalValue * (qEnd - qStart);
    parts.realizedPnl.push(row.realizedPnl * qEnd);
    parts.unrealizedPnl.push(row.unrealizedPnl * qEnd);
    parts.income.push(row.income * qEnd);
    parts.transactionCosts.push(row.transactionCosts * qEnd);
    parts.financing.push(row.financing * qEnd);
    parts.externalFlows.push(row.externalFlows * qEnd);
    parts.foreignExchangePnl.push(translation);
    byCurrency.push({
      currency,
      quoteAtStart: qStart,
      quoteAtEnd: qEnd,
      openingLocalValue: row.openingLocalValue,
      closingLocalValue: row.closingLocalValue,
      realizedPnl: row.realizedPnl,
      unrealizedPnl: row.unrealizedPnl,
      income: row.income,
      transactionCosts: row.transactionCosts,
      financing: row.financing,
      externalFlows: row.externalFlows,
      conversionNet: row.conversionNet,
      translationEffectBaseCurrency: translation,
    });
  }
  for (const { event } of conversions) {
    parts.foreignExchangePnl.push(
      toBaseAtEnd(event.toAmount, event.toCurrency) -
        toBaseAtEnd(event.fromAmount, event.fromCurrency),
    );
  }
  const componentsWithoutTotal = {
    realizedPnl: stableSum(parts.realizedPnl),
    unrealizedPnl: stableSum(parts.unrealizedPnl),
    income: stableSum(parts.income),
    transactionCosts: stableSum(parts.transactionCosts),
    financing: stableSum(parts.financing),
    foreignExchangePnl: stableSum(parts.foreignExchangePnl),
  };
  const components: PortfolioPnlComponents = {
    ...componentsWithoutTotal,
    totalPnl: totalOf(componentsWithoutTotal),
  };
  const externalFlows = stableSum(parts.externalFlows);
  const netAssetValueChange = to.valued.netAssetValue - from.valued.netAssetValue;
  const investmentReturn = netAssetValueChange - externalFlows;
  const residual = investmentReturn - components.totalPnl;
  const scale = Math.max(1, Math.abs(from.valued.netAssetValue), Math.abs(to.valued.netAssetValue));
  if (Math.abs(residual) > RESIDUAL_TOLERANCE * scale) {
    warnings.push(
      `${functionName}: the P&L identity leaves ${residual} unexplained between ${from.mark.valuationDate} and ${to.mark.valuationDate} (tolerance ${RESIDUAL_TOLERANCE * scale}) — the residual is reported, never absorbed; an event family this slice does not decompose (or a mark that values a position in a currency with no opening quote) is the usual cause.`,
    );
  }

  // Groupings.
  const groupings = buildGroupings(components, attribution, classification, quoteEnd);

  return {
    netAssetValueChange,
    externalFlows,
    investmentReturn,
    components,
    residual,
    byCurrency,
    groupings,
    warnings,
    eventCount: to.eventsSincePrior.length,
  };
}

function attributedComponents(
  target: InstrumentAttribution,
  quoteEnd: ReadonlyMap<string, number>,
): Omit<PortfolioPnlComponents, 'totalPnl'> {
  const sumAtEnd = (bucket: Record<string, number>): number =>
    stableSum(
      Object.entries(bucket).map(([currency, amount]) => amount * (quoteEnd.get(currency) ?? 1)),
    );
  return {
    realizedPnl: sumAtEnd(target.realizedPnl),
    unrealizedPnl: sumAtEnd(target.unrealizedPnl),
    income: sumAtEnd(target.income),
    transactionCosts: sumAtEnd(target.transactionCosts),
    financing: 0,
    foreignExchangePnl: 0,
  };
}

function buildGroupings(
  components: PortfolioPnlComponents,
  attribution: readonly InstrumentAttribution[],
  classification: Record<string, InstrumentClassification>,
  quoteEnd: ReadonlyMap<string, number>,
): PortfolioPnlGrouping[] {
  const attributed = attribution.map((target) => ({
    target,
    components: attributedComponents(target, quoteEnd),
    currency:
      Object.keys(target.unrealizedPnl)[0] ??
      Object.keys(target.realizedPnl)[0] ??
      Object.keys(target.income)[0] ??
      Object.keys(target.transactionCosts)[0] ??
      UNCLASSIFIED,
  }));
  const attributedTotals = {
    realizedPnl: stableSum(attributed.map((a) => a.components.realizedPnl)),
    unrealizedPnl: stableSum(attributed.map((a) => a.components.unrealizedPnl)),
    income: stableSum(attributed.map((a) => a.components.income)),
    transactionCosts: stableSum(attributed.map((a) => a.components.transactionCosts)),
  };
  const unattributedBase = {
    realizedPnl: components.realizedPnl - attributedTotals.realizedPnl,
    unrealizedPnl: components.unrealizedPnl - attributedTotals.unrealizedPnl,
    income: components.income - attributedTotals.income,
    transactionCosts: components.transactionCosts - attributedTotals.transactionCosts,
    financing: components.financing,
    foreignExchangePnl: components.foreignExchangePnl,
  };
  const unattributed: PortfolioPnlComponents = {
    ...unattributedBase,
    totalPnl: totalOf(unattributedBase),
  };

  const labelsFor = (
    dimension: PortfolioGroupingDimension,
    entry: (typeof attributed)[number],
  ): string[] => {
    const meta = ownValue(classification, entry.target.instrumentId) ?? {};
    switch (dimension) {
      case 'position':
        return [positionGroupingLabel(entry.target.accountId, entry.target.instrumentId)];
      case 'instrument':
        return [entry.target.instrumentId];
      case 'account':
        return [entry.target.accountId];
      case 'currency':
        return [entry.currency];
      case 'underlying':
        return [meta.underlying ?? UNCLASSIFIED];
      case 'assetClass':
        return [meta.assetClass ?? UNCLASSIFIED];
      case 'strategy':
        return [meta.strategy ?? UNCLASSIFIED];
      case 'tag':
        return meta.tags && meta.tags.length > 0 ? meta.tags : [UNCLASSIFIED];
      default:
        return [UNCLASSIFIED];
    }
  };

  return GROUPING_DIMENSIONS.map((dimension) => {
    const rows = new Map<string, Omit<PortfolioPnlComponents, 'totalPnl'>>();
    for (const entry of attributed) {
      for (const label of labelsFor(dimension, entry)) {
        const row = rows.get(label) ?? {
          realizedPnl: 0,
          unrealizedPnl: 0,
          income: 0,
          transactionCosts: 0,
          financing: 0,
          foreignExchangePnl: 0,
        };
        row.realizedPnl += entry.components.realizedPnl;
        row.unrealizedPnl += entry.components.unrealizedPnl;
        row.income += entry.components.income;
        row.transactionCosts += entry.components.transactionCosts;
        rows.set(label, row);
      }
    }
    const rowsOut: PortfolioPnlGroupRow[] = [...rows.keys()].sort().map((label) => {
      const row = rows.get(label)!;
      return { label, ...row, totalPnl: totalOf(row) };
    });
    const explained = stableSum([...rowsOut.map((row) => row.totalPnl), unattributed.totalPnl]);
    const reconciliationResidual = components.totalPnl - explained;
    const overlapping = dimension === 'tag';
    const reconciles =
      !overlapping &&
      Math.abs(reconciliationResidual) <=
        RESIDUAL_TOLERANCE * Math.max(1, Math.abs(components.totalPnl));
    return {
      dimension,
      rows: rowsOut,
      unattributed: { ...unattributed },
      reconciliationResidual,
      reconciles,
      ...(reconciles
        ? {}
        : {
            reason: overlapping
              ? 'tags overlap — an instrument may carry several, so tag rows double-count by design and do not partition the total'
              : `the ${dimension} rows plus the unattributed row leave ${reconciliationResidual} of the total unexplained`,
          }),
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------

/**
 * Reconciled P&L between two valuation marks — see the module comment for the identity and the
 * conversion convention. Never mutates the ledger; every number is base currency unless the row
 * says otherwise.
 */
export function portfolioPnl(input: PortfolioPnlInput): PortfolioPnlResult {
  const functionName = 'portfolioPnl';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioLedger(functionName, 'ledger', input.ledger);
  for (const field of ['from', 'to'] as const) {
    if (input[field] === undefined) {
      throw new InputError(
        `${functionName}: ${field} is required — a P&L is measured BETWEEN two dated valuation marks.\n  e.g. ${EXAMPLE_CALL}`,
        { code: ErrorCode.InputMissingField, context: { function: functionName, field } },
      );
    }
  }
  requireValuationMarks(functionName, [input.from, input.to], 2, EXAMPLE_CALL);
  const classification = requireInstrumentClassification(
    functionName,
    input.instrumentClassification,
  );

  const [from, to] = foldToMarks(input.ledger, [input.from, input.to]) as [MarkWindow, MarkWindow];
  const window = computePnlWindow(functionName, input.ledger, from, to, classification);
  const warnings = [
    ...from.valued.diagnostics.warnings.map((w) => `${from.mark.valuationDate}: ${w}`),
    ...to.valued.diagnostics.warnings.map((w) => `${to.mark.valuationDate}: ${w}`),
    ...window.warnings,
  ];
  const scale = Math.max(1, Math.abs(from.valued.netAssetValue), Math.abs(to.valued.netAssetValue));

  return deepFreeze(
    requireRepresentableResult(functionName, {
      baseCurrency: input.ledger.state.baseCurrency,
      from: {
        valuationDate: from.mark.valuationDate,
        asOf: from.instant,
        netAssetValue: from.valued.netAssetValue,
      },
      to: {
        valuationDate: to.mark.valuationDate,
        asOf: to.instant,
        netAssetValue: to.valued.netAssetValue,
      },
      netAssetValueChange: window.netAssetValueChange,
      externalFlows: window.externalFlows,
      investmentReturn: window.investmentReturn,
      components: window.components,
      residual: window.residual,
      byCurrency: window.byCurrency,
      groupings: window.groupings,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        lotRelief: input.ledger.state.lotRelief,
        identity: IDENTITY,
        conversionConvention: CONVERSION_CONVENTION,
        residualTolerance: RESIDUAL_TOLERANCE * scale,
      },
      diagnostics: {
        warnings,
        eventCount: window.eventCount,
        residualWithinTolerance: Math.abs(window.residual) <= RESIDUAL_TOLERANCE * scale,
      },
    }),
  );
}

export type { PortfolioValuationMark } from './marks.js';
export type { CurrencyPairQuote };
