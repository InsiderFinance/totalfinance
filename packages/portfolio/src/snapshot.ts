/**
 * `portfolioSnapshot` — explicit market/as-of valuation of a derived {@link PortfolioState}
 * (FC7 required API; agent-native Permanent law 2: valuation combines ledger FACTS with an
 * explicit market snapshot; P&L is a derived report, never ledger state).
 *
 * The market is a Gate B `MarketSnapshot` (`@totalfinance/core/artifacts`) — the platform's ONE
 * container for "market state at an instant" — validated through `readMarketSnapshot` so there is
 * exactly one validator. Position marks come from `observations.spots`; base-currency conversion
 * uses explicit {@link CurrencyPairQuote}s in FC5's vocabulary and arithmetic (see
 * `internal.ts`). An unavailable mark or quote is a TYPED failure
 * (`portfolio.mark_unavailable`) — never an interpolation, a stale guess, or a silent skip.
 *
 * The settled/unsettled cash split happens HERE, against the explicit `asOf`: the fold records
 * each dated cash leg; this call classifies legs settling after `asOf` as receivable (incoming)
 * or payable (outgoing). That keeps the reducer clock-free while the report states
 * trade-date-vs-settlement-date truth (FC7 mandatory state).
 */

import type { EpochMs } from '@totalfinance/core';
import {
  requireRepresentableResult,
  CONVENTIONS_VERSION,
  DataError,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  resolveAsOf,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import { readMarketSnapshot } from '@totalfinance/core/artifacts';
import type { CurrencyPairQuote } from './internal.js';
import {
  convertWithQuotes,
  deepFreeze,
  ownValue,
  requireCurrencyPairQuoteShape,
  requireEpochMsField,
} from './internal.js';
import type { SettlementStyle } from './events.js';
import type { LotReliefPolicy, PortfolioState } from './state.js';
import { requirePortfolioStateShape } from './state.js';

/** Input for {@link portfolioSnapshot}. */
export interface PortfolioSnapshotInput {
  /** A derived {@link PortfolioState} (from `applyPortfolioEvents` or `ledger.state`). */
  portfolio: PortfolioState;
  /** The valuation instant: epoch ms, `'YYYY-MM-DD'`, or a zoned ISO datetime. */
  asOf: EpochMs | string;
  /** The Gate B market snapshot supplying instrument marks. */
  market: MarketSnapshot;
  /**
   * Explicit valuation-time exchange-rate quotes (FC5 vocabulary), one per currency pair, in
   * either orientation. Required exactly when the portfolio holds cash or positions outside its
   * base currency.
   */
  currencyConversions?: CurrencyPairQuote[];
}

/** One account × currency cash row at the valuation instant. */
export interface PortfolioSnapshotCashRow {
  accountId: string;
  currency: string;
  /** The booked balance including unsettled legs. */
  totalAmount: number;
  /** `totalAmount − unsettledReceivable + unsettledPayable` (the tested identity). */
  settledAmount: number;
  /** Magnitude of incoming cash legs settling after `asOf` (receivable), ≥ 0. */
  unsettledReceivable: number;
  /** Magnitude of outgoing cash legs settling after `asOf` (payable), ≥ 0. */
  unsettledPayable: number;
  /** `totalAmount` in the portfolio's base currency at the supplied conversion quote. */
  baseCurrencyValue: number;
}

/** One valued position at the valuation instant. */
export interface PortfolioSnapshotPosition {
  accountId: string;
  instrumentId: string;
  /** The position's trading currency (marks must be quoted in it). */
  currency: string;
  quantity: number;
  markPricePerUnit: number;
  /** Units of the underlying per unit of quantity (slice 5): shares 1, an option's 100, a futures size. */
  contractMultiplier: number;
  settlementStyle: SettlementStyle;
  /**
   * The position's contribution to NAV, in `currency`: `quantity × mark × multiplier` for a
   * cash-on-trade position; for a variation-margin position the UNSETTLED P&L since the last
   * settlement, `Σ (mark − lot basis) × lot quantity × multiplier` (its notional is not owned).
   */
  marketValue: number;
  baseCurrencyMarketValue: number;
  /** `quantity × mark × multiplier` — the economic exposure, in `currency` (equals marketValue for cash-on-trade). */
  notionalValue: number;
  baseCurrencyNotionalValue: number;
  /** Remaining open-lot basis `Σ lot.quantity × lot.costBasisPerUnit × multiplier` (signed), in `currency`; 0 for variation-margin positions (their basis is the last settlement, not capital). */
  costBasis: number;
  /** `marketValue − costBasis`, in `currency` — mark-to-market on the OPEN lots only. */
  unrealizedPnl: number;
  baseCurrencyUnrealizedPnl: number;
  lotCount: number;
}

/** Result of {@link portfolioSnapshot}. */
export interface PortfolioSnapshotResult {
  asOf: EpochMs;
  baseCurrency: string;
  /** `totalCashBaseCurrencyValue + totalPositionsBaseCurrencyValue` (the tested identity). */
  netAssetValue: number;
  /** Sorted by (accountId, currency) — deterministic. */
  cash: PortfolioSnapshotCashRow[];
  totalCashBaseCurrencyValue: number;
  /** Sorted by (accountId, instrumentId) — deterministic. */
  positions: PortfolioSnapshotPosition[];
  totalPositionsBaseCurrencyValue: number;
  assumptions: {
    conventionsVersion: string;
    /** The relief policy behind every realized figure in the underlying state — echoed. */
    lotRelief: LotReliefPolicy;
    /** The market snapshot's own instant — a warning discloses any mismatch with `asOf`. */
    marketAsOf: EpochMs;
    /** The exchange-rate quotes actually used, echoed verbatim. */
    currencyConversionsUsed: CurrencyPairQuote[];
    /** Prose statement of the valuation convention. String-typed by design. */
    valuationConvention: string;
  };
  diagnostics: {
    warnings: string[];
    accountCount: number;
    positionCount: number;
  };
}

const INPUT_KEYS = ['portfolio', 'asOf', 'market', 'currencyConversions'] as const;

const VALUATION_CONVENTION =
  'Positions mark at observations.spots[instrumentId].price from the supplied market snapshot, ' +
  'quoted in the position’s trading currency and scaled by the contract multiplier; a ' +
  'variation-margin position (futures, perpetuals) contributes its unsettled P&L since the last ' +
  'settlement, not its notional; cash values at face; base-currency conversion uses ' +
  'the supplied currencyConversions quotes (direct: multiply by quotePerBase; inverted: divide — ' +
  'FC5 convertCurrency arithmetic). Cash legs with settleTimestampMs > asOf are unsettled: ' +
  'incoming legs are receivable, outgoing legs payable; settledAmount = totalAmount − ' +
  'unsettledReceivable + unsettledPayable. Unrealized P&L is marked on open lots only; an ' +
  'unavailable mark or quote is a typed failure, never a guess.';

const EXAMPLE_CALL =
  "portfolioSnapshot({ portfolio: state, asOf: '2026-08-20', market, currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }] })";

/**
 * Value a portfolio state against an explicit market snapshot at an explicit instant.
 *
 * @example
 * ```ts
 * import { createMarketSnapshot } from '@totalfinance/core/artifacts';
 * import { applyPortfolioEvents, portfolioSnapshot } from '@totalfinance/portfolio';
 *
 * const state = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events });
 * const market = createMarketSnapshot({
 *   asOf: '2026-08-20',
 *   observations: { spots: { AAPL: { price: 232.5, currency: 'USD' } } },
 * });
 * const valued = portfolioSnapshot({ portfolio: state, asOf: '2026-08-20', market });
 * valued.netAssetValue; // cash + positions, in USD
 * ```
 */
export function portfolioSnapshot(input: PortfolioSnapshotInput): PortfolioSnapshotResult {
  const functionName = 'portfolioSnapshot';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioStateShape(functionName, 'portfolio', input.portfolio);
  if (input.asOf === undefined) {
    throw new InputError(
      `${functionName}: asOf is required — TotalFinance never reads the system clock, so the caller states the valuation instant.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'asOf' } },
    );
  }
  const asOf = resolveAsOf(input.asOf, functionName);
  requireEpochMsField(functionName, 'asOf', asOf);
  // ONE validator for market snapshots: the Gate B reader (closed keys, kind, version, finiteness).
  const { snapshot: market } = readMarketSnapshot({ snapshot: input.market });
  const quotes: CurrencyPairQuote[] = [];
  if (input.currencyConversions !== undefined) {
    requireArgumentArray(functionName, 'currencyConversions', input.currencyConversions);
    input.currencyConversions.forEach((quote, index) => {
      requireCurrencyPairQuoteShape(functionName, `currencyConversions[${index}]`, quote);
      quotes.push(quote);
    });
  }

  const warnings: string[] = [];
  if (market.asOf !== asOf) {
    warnings.push(
      `${functionName}: the market snapshot is observed at ${market.asOf} but the valuation asOf is ${asOf} — marks from another instant are being applied; supply a snapshot at the valuation instant to remove this warning.`,
    );
  }

  const state = input.portfolio;
  const baseCurrency = state.baseCurrency;
  const quotesUsed = new Map<string, CurrencyPairQuote>();

  const toBase = (amount: number, currency: string, subject: string): number => {
    if (currency === baseCurrency) return amount;
    const { convertedAmount, quoteUsed } = convertWithQuotes({
      functionName,
      amount,
      fromCurrency: currency,
      toCurrency: baseCurrency,
      quotes,
      subject,
    });
    // Echo a COPY — freezing the result must never freeze the caller's own quote objects.
    quotesUsed.set(`${quoteUsed.baseCurrency}/${quoteUsed.quoteCurrency}`, { ...quoteUsed });
    return convertedAmount;
  };

  const cashRows: PortfolioSnapshotCashRow[] = [];
  const positionRows: PortfolioSnapshotPosition[] = [];
  const spots = market.observations.spots ?? {};

  for (const accountId of Object.keys(state.accounts).sort()) {
    const account = ownValue(state.accounts, accountId)!;

    for (const currency of Object.keys(account.cashBalances).sort()) {
      const balance = ownValue(account.cashBalances, currency)!;
      let unsettledReceivable = 0;
      let unsettledPayable = 0;
      for (const leg of balance.settlementSchedule) {
        if (leg.settleTimestampMs > asOf) {
          if (leg.amount > 0) unsettledReceivable += leg.amount;
          else unsettledPayable += -leg.amount;
        }
      }
      const settledAmount = balance.totalAmount - unsettledReceivable + unsettledPayable;
      cashRows.push({
        accountId,
        currency,
        totalAmount: balance.totalAmount,
        settledAmount,
        unsettledReceivable,
        unsettledPayable,
        baseCurrencyValue: toBase(
          balance.totalAmount,
          currency,
          `account '${accountId}' ${currency} cash`,
        ),
      });
    }

    for (const instrumentId of Object.keys(account.positions).sort()) {
      const position = ownValue(account.positions, instrumentId)!;
      const spot = ownValue(spots, instrumentId);
      if (spot === undefined) {
        throw new DataError(
          `${functionName}: account '${accountId}' holds ${position.quantity} ${instrumentId}, but the market snapshot carries no observations.spots['${instrumentId}'] — an unavailable mark is a typed failure, never a guess. Add the spot (price + currency) to the snapshot.`,
          {
            code: ErrorCode.PortfolioMarkUnavailable,
            context: { function: functionName, accountId, instrumentId },
          },
        );
      }
      if (spot.currency === undefined) {
        throw new InputError(
          `${functionName}: observations.spots['${instrumentId}'] states no currency, but it marks a held position — a valuation price must state its currency (${position.currency} here) so nothing is guessed.`,
          {
            code: ErrorCode.InputMissingField,
            context: {
              function: functionName,
              field: `market.observations.spots.${instrumentId}.currency`,
            },
          },
        );
      }
      if (spot.currency !== position.currency) {
        throw new DataError(
          `${functionName}: observations.spots['${instrumentId}'] is quoted in ${spot.currency}, but account '${accountId}' built the position in ${position.currency} — a mark in another currency is not a mark for these lots. Supply the ${position.currency} price.`,
          {
            code: ErrorCode.PortfolioMarkUnavailable,
            context: {
              function: functionName,
              accountId,
              instrumentId,
              markCurrency: spot.currency,
              positionCurrency: position.currency,
            },
          },
        );
      }
      const multiplier = position.contractMultiplier;
      const notionalValue = position.quantity * spot.price * multiplier;
      const marketValue =
        position.settlementStyle === 'variation-margin'
          ? position.lots.reduce(
              (sum, lot) => sum + (spot.price - lot.costBasisPerUnit) * lot.quantity * multiplier,
              0,
            )
          : notionalValue;
      const costBasis =
        position.settlementStyle === 'variation-margin'
          ? 0
          : position.lots.reduce(
              (sum, lot) => sum + lot.quantity * lot.costBasisPerUnit * multiplier,
              0,
            );
      const unrealizedPnl = marketValue - costBasis;
      const baseCurrencyNotionalValue = toBase(
        notionalValue,
        position.currency,
        `account '${accountId}' ${instrumentId} notional`,
      );
      const baseCurrencyMarketValue = toBase(
        marketValue,
        position.currency,
        `account '${accountId}' ${instrumentId} position`,
      );
      const baseCurrencyUnrealizedPnl = toBase(
        unrealizedPnl,
        position.currency,
        `account '${accountId}' ${instrumentId} unrealized P&L`,
      );
      positionRows.push({
        accountId,
        instrumentId,
        currency: position.currency,
        quantity: position.quantity,
        markPricePerUnit: spot.price,
        contractMultiplier: multiplier,
        settlementStyle: position.settlementStyle,
        marketValue,
        baseCurrencyMarketValue,
        notionalValue,
        baseCurrencyNotionalValue,
        costBasis,
        unrealizedPnl,
        baseCurrencyUnrealizedPnl,
        lotCount: position.lots.length,
      });
    }
  }

  const totalCashBaseCurrencyValue = cashRows.reduce((sum, row) => sum + row.baseCurrencyValue, 0);
  const totalPositionsBaseCurrencyValue = positionRows.reduce(
    (sum, row) => sum + row.baseCurrencyMarketValue,
    0,
  );

  return deepFreeze(
    requireRepresentableResult('portfolioSnapshot', {
      asOf,
      baseCurrency,
      netAssetValue: totalCashBaseCurrencyValue + totalPositionsBaseCurrencyValue,
      cash: cashRows,
      totalCashBaseCurrencyValue,
      positions: positionRows,
      totalPositionsBaseCurrencyValue,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        lotRelief: state.lotRelief,
        marketAsOf: market.asOf,
        currencyConversionsUsed: [...quotesUsed.keys()].sort().map((key) => quotesUsed.get(key)!),
        valuationConvention: VALUATION_CONVENTION,
      },
      diagnostics: {
        warnings,
        accountCount: Object.keys(state.accounts).length,
        positionCount: positionRows.length,
      },
    }),
  );
}
