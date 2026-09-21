/**
 * `reconcilePortfolio` (FC7 slice 3, 2026-08-28; agent-native "Reconciliation"): compare a derived
 * portfolio state with a NORMALIZED external snapshot (a broker's, a custodian's, another ledger's)
 * at an explicit instant and report every difference — never mutating anything, never guessing.
 *
 * What it returns, per the decided list: missing/extra positions, quantity differences, cash
 * differences by currency, cost-basis differences when supplied, settled-versus-unsettled
 * differences, known timing explanations, suggested normalized correction events (DRAFT
 * envelopes, fully validated, that a separate authorized write may apply), and an explicit
 * `reconciled` verdict. Tolerance is explicit (the doc: "an explicit currency/quantity
 * tolerance") and every difference is reported whether or not it is within it.
 */

import type { EpochMs } from '@totalfinance/core';
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
import type { PortfolioEventEnvelope } from './events.js';
import { requirePortfolioEventEnvelope } from './events.js';
import {
  deepFreeze,
  describeInputValue,
  epochMsToUtcDate,
  ownValue,
  requireCurrencyCode,
  requireFiniteNumberField,
  requireEpochMsField,
  requireIdentityString,
} from './internal.js';
import type { LotReliefPolicy, PortfolioState } from './state.js';
import { requirePortfolioStateShape } from './state.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

/** One currency's cash as the external source reports it. `settled` is optional — many report only totals. */
export interface ExternalCashBalance {
  total: number;
  settled?: number;
}

export interface ExternalPosition {
  instrumentId: string;
  /** Signed; short positions negative. */
  quantity: number;
  currency?: string;
  /** Total cost basis in the position's currency, when the source supplies it. */
  costBasis?: number;
}

export interface ExternalAccountSnapshot {
  cash: Record<string, ExternalCashBalance>;
  positions: ExternalPosition[];
}

/** A normalized external snapshot — the shape adapters produce from broker/custodian statements. */
export interface ExternalPortfolioSnapshot {
  asOf: EpochMs | string;
  accounts: Record<string, ExternalAccountSnapshot>;
  /** Free-text origin (e.g. a broker name); echoed into suggested corrections' provenance. */
  source?: string;
}

/** Explicit — never defaulted. Absolute amounts in position units and in each currency's units. */
export interface ReconciliationTolerance {
  quantity: number;
  cashAmount: number;
  /** Cost-basis tolerance in currency units; defaults to `cashAmount` when omitted. */
  costBasis?: number;
}

export interface ReconcilePortfolioInput {
  portfolio: PortfolioState;
  external: ExternalPortfolioSnapshot;
  /** The comparison instant (settled/unsettled cash is classified here); ISO date or epoch ms. */
  asOf: EpochMs | string;
  tolerance: ReconciliationTolerance;
  /** `sourceId` stamped on suggested correction drafts. Default `'reconciliation'`. */
  correctionSourceId?: string;
}

export type ReconciliationExplanation =
  | {
      kind: 'pending-settlement';
      detail: string;
    }
  | {
      kind: 'corporate-action-candidate';
      detail: string;
      ratio: number;
    };

export interface CashDifference {
  currency: string;
  ledgerTotal: number;
  ledgerSettled: number;
  ledgerUnsettledReceivable: number;
  ledgerUnsettledPayable: number;
  externalTotal: number;
  externalSettled: number | null;
  /** `externalTotal − ledgerTotal`. */
  totalDifference: number;
  /** `externalSettled − ledgerSettled`, `null` when the source reports no settled figure. */
  settledDifference: number | null;
  withinTolerance: boolean;
  explanation?: ReconciliationExplanation;
}

export type PositionDifferenceKind =
  | 'matched'
  | 'quantity-difference'
  | 'missing-in-external'
  | 'extra-in-external';

export interface PositionDifference {
  instrumentId: string;
  kind: PositionDifferenceKind;
  ledgerQuantity: number;
  externalQuantity: number;
  /** `externalQuantity − ledgerQuantity`. */
  quantityDifference: number;
  withinTolerance: boolean;
  currency: string | null;
  /** Present when the external source states a currency that differs from the ledger's. */
  currencyMismatch?: { ledger: string; external: string };
  /** Present when the external source supplies a cost basis. */
  costBasis?: {
    ledger: number;
    external: number;
    difference: number;
    withinTolerance: boolean;
  };
  explanation?: ReconciliationExplanation;
}

export interface ReconciliationAccountReport {
  accountId: string;
  presentInLedger: boolean;
  presentInExternal: boolean;
  /** Sorted by currency. */
  cash: CashDifference[];
  /** Sorted by instrumentId; every ledger or external position appears exactly once. */
  positions: PositionDifference[];
}

export interface ReconcilePortfolioResult {
  asOf: EpochMs;
  baseCurrency: string;
  /** Every difference is within tolerance (or explained by pending settlement). */
  reconciled: boolean;
  accounts: ReconciliationAccountReport[];
  /** Differences beyond tolerance, before explanations. */
  differenceCount: number;
  /** Beyond-tolerance differences an explanation accounts for. */
  explainedCount: number;
  /**
   * DRAFT envelopes that would bring the ledger to the external figures — validated, stamped with
   * `sourceId: correctionSourceId`, effective at `asOf`, and NEVER applied here. Applying them is a
   * separate authorized portfolio write.
   */
  suggestedCorrections: PortfolioEventEnvelope[];
  /** Differences for which no complete draft could be written, and what would be needed. */
  undraftable: { accountId: string; subject: string; reason: string }[];
  assumptions: {
    conventionsVersion: string;
    lotRelief: LotReliefPolicy;
    tolerance: Required<ReconciliationTolerance>;
    comparisonConvention: string;
  };
  diagnostics: {
    warnings: string[];
    ledgerAccountCount: number;
    externalAccountCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

const INPUT_KEYS = ['portfolio', 'external', 'asOf', 'tolerance', 'correctionSourceId'] as const;
const EXTERNAL_KEYS = ['asOf', 'accounts', 'source'] as const;
const EXTERNAL_ACCOUNT_KEYS = ['cash', 'positions'] as const;
const EXTERNAL_CASH_KEYS = ['total', 'settled'] as const;
const EXTERNAL_POSITION_KEYS = ['instrumentId', 'quantity', 'currency', 'costBasis'] as const;
const TOLERANCE_KEYS = ['quantity', 'cashAmount', 'costBasis'] as const;

const COMPARISON_CONVENTION =
  'Differences are external − ledger. Ledger cash is the fold’s booked total; settled cash counts ' +
  'every leg with settleTimestampMs ≤ asOf (a receivable settling later is unsettled). A settled ' +
  'difference that the ledger’s own unsettled legs account for is explained as pending-settlement ' +
  'and does not block the verdict. A quantity ratio between the external and ledger figures that ' +
  'is a whole number (or its reciprocal) ≥ 2 is flagged as a corporate-action candidate — it is an ' +
  'explanation to investigate, not a correction. Suggested corrections are drafts: they are ' +
  'validated envelopes but never applied here.';

const EXAMPLE_CALL =
  "reconcilePortfolio({ portfolio: ledger.state, asOf: '2026-03-01', external: { asOf: '2026-03-01', accounts: { main: { cash: { USD: { total: 85_721 } }, positions: [{ instrumentId: 'AAPL', quantity: 60, costBasis: 9_000 }] } } }, tolerance: { quantity: 1e-9, cashAmount: 0.01 } })";

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

function requireExternalSnapshot(functionName: string, value: unknown): ExternalPortfolioSnapshot {
  requireArgumentObject(functionName, 'external', value);
  ensureKnownKeys(functionName, 'external', value as object, EXTERNAL_KEYS);
  const snapshot = value as ExternalPortfolioSnapshot;
  if (snapshot.asOf === undefined) {
    throw new InputError(
      `${functionName}: external.asOf is required — the external figures are a statement at an instant.\n  e.g. ${EXAMPLE_CALL}`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'external.asOf' },
      },
    );
  }
  resolveAsOf(snapshot.asOf, functionName);
  if (snapshot.source !== undefined)
    requireIdentityString(functionName, 'external.source', snapshot.source);
  requireArgumentObject(functionName, 'external.accounts', snapshot.accounts);
  for (const accountId of Object.keys(snapshot.accounts)) {
    const path = `external.accounts['${accountId}']`;
    requireIdentityString(functionName, 'external.accounts key', accountId);
    const account = ownValue(snapshot.accounts, accountId)!;
    requireArgumentObject(functionName, path, account);
    ensureKnownKeys(functionName, path, account, EXTERNAL_ACCOUNT_KEYS);
    requireArgumentObject(functionName, `${path}.cash`, account.cash);
    for (const currency of Object.keys(account.cash)) {
      requireCurrencyCode(functionName, `${path}.cash key`, currency);
      const balance = ownValue(account.cash, currency)!;
      requireArgumentObject(functionName, `${path}.cash.${currency}`, balance);
      ensureKnownKeys(functionName, `${path}.cash.${currency}`, balance, EXTERNAL_CASH_KEYS);
      requireFiniteNumberField(functionName, `${path}.cash.${currency}.total`, balance.total);
      if (balance.settled !== undefined) {
        requireFiniteNumberField(functionName, `${path}.cash.${currency}.settled`, balance.settled);
      }
    }
    requireArgumentArray(functionName, `${path}.positions`, account.positions);
    const seen = new Set<string>();
    account.positions.forEach((position, index) => {
      const at = `${path}.positions[${index}]`;
      requireArgumentObject(functionName, at, position);
      ensureKnownKeys(functionName, at, position, EXTERNAL_POSITION_KEYS);
      requireIdentityString(functionName, `${at}.instrumentId`, position.instrumentId);
      requireFiniteNumberField(functionName, `${at}.quantity`, position.quantity);
      if (position.currency !== undefined)
        requireCurrencyCode(functionName, `${at}.currency`, position.currency);
      if (position.costBasis !== undefined) {
        requireFiniteNumberField(functionName, `${at}.costBasis`, position.costBasis);
      }
      if (seen.has(position.instrumentId)) {
        throw new InputError(
          `${functionName}: ${path}.positions lists '${position.instrumentId}' twice — a normalized snapshot carries one row per instrument (net the rows before comparing).`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${at}.instrumentId` },
          },
        );
      }
      seen.add(position.instrumentId);
    });
  }
  return snapshot;
}

function requireTolerance(functionName: string, value: unknown): Required<ReconciliationTolerance> {
  if (value === undefined) {
    throw new InputError(
      `${functionName}: tolerance is required and explicit — state the quantity and cash amount below which a difference is accepted (0 for exact).\n  e.g. ${EXAMPLE_CALL}`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'tolerance' },
      },
    );
  }
  requireArgumentObject(functionName, 'tolerance', value);
  ensureKnownKeys(functionName, 'tolerance', value as object, TOLERANCE_KEYS);
  const tolerance = value as ReconciliationTolerance;
  for (const field of ['quantity', 'cashAmount'] as const) {
    const amount = tolerance[field];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new InputError(
        `${functionName}: tolerance.${field} must be a finite number ≥ 0 (0 = exact). Received ${amount === null ? 'null' : typeof amount === 'number' ? amount : typeof amount}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `tolerance.${field}` },
        },
      );
    }
  }
  if (
    tolerance.costBasis !== undefined &&
    (!Number.isFinite(tolerance.costBasis) || tolerance.costBasis < 0)
  ) {
    throw new InputError(
      `${functionName}: tolerance.costBasis must be a finite number ≥ 0 when provided. Received ${describeInputValue(tolerance.costBasis)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'tolerance.costBasis' },
      },
    );
  }
  return {
    quantity: tolerance.quantity,
    cashAmount: tolerance.cashAmount,
    costBasis: tolerance.costBasis ?? tolerance.cashAmount,
  };
}

// ---------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------

function corporateActionRatio(external: number, ledger: number): number | null {
  if (ledger === 0 || external === 0 || Math.sign(ledger) !== Math.sign(external)) return null;
  const ratio = external / ledger;
  for (const candidate of [ratio, 1 / ratio]) {
    const rounded = Math.round(candidate);
    if (rounded >= 2 && Math.abs(candidate - rounded) <= 1e-9) return ratio;
  }
  return null;
}

/**
 * Compare a derived state with a normalized external snapshot at `asOf` — see the module comment.
 */
export function reconcilePortfolio(input: ReconcilePortfolioInput): ReconcilePortfolioResult {
  const functionName = 'reconcilePortfolio';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioStateShape(functionName, 'portfolio', input.portfolio);
  if (input.asOf === undefined) {
    throw new InputError(
      `${functionName}: asOf is required — settled and unsettled cash are classified at an explicit instant.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'asOf' } },
    );
  }
  const asOf = resolveAsOf(input.asOf, functionName);
  requireEpochMsField(functionName, 'asOf', asOf);
  const external = requireExternalSnapshot(functionName, input.external);
  const externalAsOf = resolveAsOf(external.asOf, functionName);
  requireEpochMsField(functionName, 'external.asOf', externalAsOf);
  const tolerance = requireTolerance(functionName, input.tolerance);
  // `undefined` takes the default; an explicit null is a wrong type, never silently the default.
  const correctionSourceId =
    input.correctionSourceId === undefined ? 'reconciliation' : input.correctionSourceId;
  requireIdentityString(functionName, 'correctionSourceId', correctionSourceId);

  const state = input.portfolio;
  const warnings: string[] = [];
  if (externalAsOf !== asOf) {
    warnings.push(
      `${functionName}: the external snapshot is stated at ${externalAsOf} but the comparison asOf is ${asOf} — figures from another instant are being compared; differences may be timing.`,
    );
  }

  const accountIds = [
    ...new Set([...Object.keys(state.accounts), ...Object.keys(external.accounts)]),
  ].sort();
  const accounts: ReconciliationAccountReport[] = [];
  const suggestedCorrections: PortfolioEventEnvelope[] = [];
  const undraftable: ReconcilePortfolioResult['undraftable'] = [];
  let differenceCount = 0;
  let explainedCount = 0;
  const asOfDate = epochMsToUtcDate(asOf);
  const draftId = (accountId: string, subject: string): string =>
    `reconcile:${asOfDate}:${accountId}:${subject}`;
  const draft = (
    accountId: string,
    subject: string,
    event: PortfolioEventEnvelope['event'],
  ): void => {
    const envelope: PortfolioEventEnvelope = {
      eventId: draftId(accountId, subject),
      schemaVersion: 1,
      eventType: event.eventType,
      sourceId: correctionSourceId,
      accountId,
      effectiveTimestampMs: asOf,
      recordedTimestampMs: asOf,
      event,
      // Core's Provenance grammar: the external source is the provider, the draft is the dataset.
      provenance: {
        provider: external.source ?? 'external snapshot',
        dataset: `reconciliation draft ${asOfDate} — review before applying; applying is a separate authorized write`,
        asOf,
      },
    };
    requirePortfolioEventEnvelope(
      functionName,
      `suggestedCorrections[${suggestedCorrections.length}]`,
      envelope,
    );
    suggestedCorrections.push(envelope);
  };

  for (const accountId of accountIds) {
    const ledgerAccount = ownValue(state.accounts, accountId);
    const externalAccount = ownValue(external.accounts, accountId);
    const report: ReconciliationAccountReport = {
      accountId,
      presentInLedger: ledgerAccount !== undefined,
      presentInExternal: externalAccount !== undefined,
      cash: [],
      positions: [],
    };

    // ---- cash by currency ----
    const currencies = [
      ...new Set([
        ...Object.keys(ledgerAccount?.cashBalances ?? {}),
        ...Object.keys(externalAccount?.cash ?? {}),
      ]),
    ].sort();
    for (const currency of currencies) {
      const balance =
        ledgerAccount === undefined ? undefined : ownValue(ledgerAccount.cashBalances, currency);
      let unsettledReceivable = 0;
      let unsettledPayable = 0;
      for (const leg of balance?.settlementSchedule ?? []) {
        if (leg.settleTimestampMs > asOf) {
          if (leg.amount > 0) unsettledReceivable += leg.amount;
          else unsettledPayable += -leg.amount;
        }
      }
      const ledgerTotal = balance?.totalAmount ?? 0;
      const ledgerSettled = ledgerTotal - unsettledReceivable + unsettledPayable;
      const externalBalance =
        externalAccount === undefined ? undefined : ownValue(externalAccount.cash, currency);
      const externalTotal = externalBalance?.total ?? 0;
      const externalSettled = externalBalance?.settled ?? null;
      const totalDifference = externalTotal - ledgerTotal;
      const settledDifference = externalSettled === null ? null : externalSettled - ledgerSettled;
      const totalWithin = Math.abs(totalDifference) <= tolerance.cashAmount;
      let explanation: ReconciliationExplanation | undefined;
      // The source reports settled cash only (its "total" IS settled) and the ledger's unsettled
      // legs account for the gap: timing, not a difference.
      if (
        !totalWithin &&
        externalSettled === null &&
        Math.abs(externalTotal - ledgerSettled) <= tolerance.cashAmount &&
        (unsettledReceivable !== 0 || unsettledPayable !== 0)
      ) {
        explanation = {
          kind: 'pending-settlement',
          detail: `the ledger books ${unsettledReceivable} ${currency} receivable and ${unsettledPayable} ${currency} payable settling after ${asOfDate}; the external total equals the ledger's settled cash`,
        };
      }
      const withinTolerance = totalWithin || explanation !== undefined;
      if (!totalWithin) {
        differenceCount += 1;
        if (explanation !== undefined) explainedCount += 1;
        else if (Math.abs(totalDifference) > 0) {
          draft(accountId, `cash:${currency}`, {
            eventType: totalDifference > 0 ? 'cash.deposit' : 'cash.withdrawal',
            amount: Math.abs(totalDifference),
            currency,
          });
        }
      }
      report.cash.push({
        currency,
        ledgerTotal,
        ledgerSettled,
        ledgerUnsettledReceivable: unsettledReceivable,
        ledgerUnsettledPayable: unsettledPayable,
        externalTotal,
        externalSettled,
        totalDifference,
        settledDifference,
        withinTolerance,
        ...(explanation !== undefined ? { explanation } : {}),
      });
    }

    // ---- positions ----
    const externalPositions = new Map(
      (externalAccount?.positions ?? []).map((position) => [position.instrumentId, position]),
    );
    const instrumentIds = [
      ...new Set([...Object.keys(ledgerAccount?.positions ?? {}), ...externalPositions.keys()]),
    ].sort();
    for (const instrumentId of instrumentIds) {
      const ledgerPosition =
        ledgerAccount === undefined ? undefined : ownValue(ledgerAccount.positions, instrumentId);
      const externalPosition = externalPositions.get(instrumentId);
      const ledgerQuantity = ledgerPosition?.quantity ?? 0;
      const externalQuantity = externalPosition?.quantity ?? 0;
      const quantityDifference = externalQuantity - ledgerQuantity;
      const kind: PositionDifferenceKind =
        ledgerPosition === undefined
          ? 'extra-in-external'
          : externalPosition === undefined
            ? 'missing-in-external'
            : Math.abs(quantityDifference) <= tolerance.quantity
              ? 'matched'
              : 'quantity-difference';
      const currency = ledgerPosition?.currency ?? externalPosition?.currency ?? null;
      const ledgerCostBasis =
        ledgerPosition?.lots.reduce(
          (sum, lot) =>
            sum + lot.quantity * lot.costBasisPerUnit * ledgerPosition.contractMultiplier,
          0,
        ) ?? 0;
      const row: PositionDifference = {
        instrumentId,
        kind,
        ledgerQuantity,
        externalQuantity,
        quantityDifference,
        withinTolerance: kind === 'matched',
        currency,
      };
      if (
        ledgerPosition !== undefined &&
        externalPosition?.currency !== undefined &&
        externalPosition.currency !== ledgerPosition.currency
      ) {
        row.currencyMismatch = {
          ledger: ledgerPosition.currency,
          external: externalPosition.currency,
        };
        row.withinTolerance = false;
      }
      if (externalPosition?.costBasis !== undefined && ledgerPosition !== undefined) {
        const difference = externalPosition.costBasis - ledgerCostBasis;
        const within = Math.abs(difference) <= tolerance.costBasis;
        row.costBasis = {
          ledger: ledgerCostBasis,
          external: externalPosition.costBasis,
          difference,
          withinTolerance: within,
        };
        if (!within) row.withinTolerance = false;
      }
      if (kind === 'quantity-difference') {
        const ratio = corporateActionRatio(externalQuantity, ledgerQuantity);
        if (ratio !== null) {
          row.explanation = {
            kind: 'corporate-action-candidate',
            detail: `the external quantity is ${ratio}× the ledger's — a split, reverse split, or similar corporate action may be unrecorded; verify before correcting`,
            ratio,
          };
        }
      }
      if (!row.withinTolerance) {
        differenceCount += 1;
        if (row.explanation !== undefined) {
          explainedCount += 1;
        } else if (Math.abs(quantityDifference) > tolerance.quantity) {
          // A priced fill needs a price: the external cost basis per unit when supplied, else the
          // ledger's own basis per unit for a position the source no longer shows.
          const perUnit =
            externalPosition?.costBasis !== undefined && externalQuantity !== 0
              ? externalPosition.costBasis / externalQuantity
              : kind === 'missing-in-external' && ledgerQuantity !== 0
                ? ledgerCostBasis / ledgerQuantity
                : null;
          const fillCurrency = currency;
          if (
            perUnit === null ||
            fillCurrency === null ||
            !Number.isFinite(perUnit) ||
            perUnit <= 0
          ) {
            undraftable.push({
              accountId,
              subject: instrumentId,
              reason: `a ${sideOf(quantityDifference)} of ${Math.abs(quantityDifference)} ${instrumentId} needs a positive price per unit and a currency; the external snapshot supplies ${externalPosition?.costBasis === undefined ? 'no cost basis' : 'a non-positive basis'}${fillCurrency === null ? ' and no currency' : ''}`,
            });
          } else {
            draft(accountId, `position:${instrumentId}`, {
              eventType: 'trade.fill',
              instrumentId,
              side: sideOf(quantityDifference),
              quantity: Math.abs(quantityDifference),
              pricePerUnit: perUnit,
              currency: fillCurrency,
            });
          }
        }
      }
      report.positions.push(row);
    }
    accounts.push(report);
  }

  const reconciled = differenceCount === explainedCount;
  return deepFreeze(
    requireRepresentableResult(functionName, {
      asOf,
      baseCurrency: state.baseCurrency,
      reconciled,
      accounts,
      differenceCount,
      explainedCount,
      suggestedCorrections,
      undraftable,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        lotRelief: state.lotRelief,
        tolerance,
        comparisonConvention: COMPARISON_CONVENTION,
      },
      diagnostics: {
        warnings,
        ledgerAccountCount: Object.keys(state.accounts).length,
        externalAccountCount: Object.keys(external.accounts).length,
      },
    }),
  );
}
