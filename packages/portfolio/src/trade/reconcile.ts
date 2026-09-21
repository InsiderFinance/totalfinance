/**
 * Reconciliation (Decision 8): the journal's order states joined to the ledger's `fillEffects`
 * (every journaled fill must be a ledger fill under the execution's source; every ledger fill under
 * that source must be journaled), the fills' quantities against the journal's, the unresolved
 * orders listed, and — when an external snapshot is given — `reconcilePortfolio` composed verbatim
 * for cash, holdings, and the drafted corrections. `reconciled` is true only when every join agrees
 * within the explicit tolerance and no order is unresolved.
 */
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  ensureKnownKeys,
  requireArgumentObject,
  resolveAsOf,
} from '@totalfinance/core';
import { canonicalJsonOf, contentHash } from '@totalfinance/core/artifacts';
import { requireNormalizedFill } from '../events.js';
import type { NormalizedFill } from '../events.js';
import { deepFreeze, requireFiniteNumberField, requireIdentityString } from '../internal.js';
import { reconcilePortfolio } from '../reconciliation.js';
import type { ReconcilePortfolioResult, ReconciliationTolerance } from '../reconciliation.js';
import { requirePortfolioStateShape } from '../state.js';
import { applyJournalEvents, journalOrderStates } from './journal.js';
import {
  RECONCILIATION_REPORT_KIND,
  RECONCILIATION_REPORT_SCHEMA_VERSION,
  type ExecutionJournalState,
  type ExecutionOrderState,
  type ReconcileExecutionInput,
  type ReconciliationFillMatch,
  type ReconciliationOrderCheck,
  type ReconciliationReport,
} from './types.js';
import { refuse, requireExecutionJournalState } from './validate.js';

const FN = 'reconcileExecution';
const INPUT_KEYS = [
  'journal',
  'ledger',
  'sourceId',
  'fills',
  'external',
  'asOf',
  'tolerance',
  'planHash',
] as const;
const TOLERANCE_KEYS = ['quantity', 'cashAmount', 'costBasis'] as const;

function requireTolerance(value: unknown): Required<ReconciliationTolerance> {
  requireArgumentObject(FN, 'input.tolerance', value);
  ensureKnownKeys(FN, 'input.tolerance', value as object, TOLERANCE_KEYS);
  const record = value as Record<string, unknown>;
  requireFiniteNumberField(FN, 'input.tolerance.quantity', record['quantity']);
  requireFiniteNumberField(FN, 'input.tolerance.cashAmount', record['cashAmount']);
  if ((record['quantity'] as number) < 0) refuse(FN, 'input.tolerance.quantity', 'must be ≥ 0');
  if ((record['cashAmount'] as number) < 0) refuse(FN, 'input.tolerance.cashAmount', 'must be ≥ 0');
  let costBasis = record['cashAmount'] as number;
  if (record['costBasis'] !== undefined) {
    requireFiniteNumberField(FN, 'input.tolerance.costBasis', record['costBasis']);
    if ((record['costBasis'] as number) < 0) refuse(FN, 'input.tolerance.costBasis', 'must be ≥ 0');
    costBasis = record['costBasis'] as number;
  }
  return {
    quantity: record['quantity'] as number,
    cashAmount: record['cashAmount'] as number,
    costBasis,
  };
}

function journalStateOf(value: unknown): ExecutionJournalState {
  if (Array.isArray(value)) return applyJournalEvents({ events: value }).state;
  return requireExecutionJournalState(FN, 'input.journal', value);
}

/** Parse a `fillEffects` registry key (`canonicalJsonOf([sourceId, eventId])`) back to its parts. */
function parseFillKey(key: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    /* not a registry key — reported below */
  }
  return null;
}

/**
 * Reconcile an execution (Decision 8). Pure: the journal (events or a folded state), the ledger,
 * the fills, and the optional external snapshot are inputs; the tolerance is explicit; the result is
 * a content-addressed `totalfinance.reconciliation-report`.
 */
export function reconcileExecution(input: ReconcileExecutionInput): ReconciliationReport {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const state = journalStateOf(input.journal);
  requirePortfolioStateShape(FN, 'input.ledger', input.ledger);
  requireIdentityString(FN, 'input.sourceId', input.sourceId);
  if (!Array.isArray(input.fills))
    refuse(FN, 'input.fills', 'must be an array', ErrorCode.InputWrongType);
  const fills = input.fills.map((fill, index) => {
    requireNormalizedFill(FN, `input.fills[${index}]`, fill);
    return fill as NormalizedFill;
  });
  const asOf = resolveAsOf(input.asOf, FN);
  const tolerance = requireTolerance(input.tolerance);
  let planHash: string | null = null;
  if (input.planHash !== undefined) {
    requireIdentityString(FN, 'input.planHash', input.planHash);
    planHash = input.planHash;
  }
  const warnings: string[] = [];

  // The journal's orders — restricted to the plan when one is named.
  const allOrders = journalOrderStates(state);
  const orders: ExecutionOrderState[] = [];
  let otherPlanCount = 0;
  for (const order of allOrders) {
    if (planHash !== null && order.planHash !== planHash) otherPlanCount += 1;
    else orders.push(order);
  }
  if (otherPlanCount > 0) {
    warnings.push(
      `${otherPlanCount} journaled order${otherPlanCount === 1 ? '' : 's'} belong to other plans and are not judged here`,
    );
  }

  // The ledger's fills under this source.
  const ledgerFillIds = new Set<string>();
  let foreignKeyCount = 0;
  for (const key of Object.keys(input.ledger.fillEffects)) {
    const parts = parseFillKey(key);
    if (parts === null) {
      foreignKeyCount += 1;
      continue;
    }
    if (parts[0] === input.sourceId) ledgerFillIds.add(parts[1]);
  }
  if (foreignKeyCount > 0) {
    warnings.push(
      `${foreignKeyCount} fillEffects key${foreignKeyCount === 1 ? '' : 's'} could not be parsed as [sourceId, eventId] and were skipped`,
    );
  }

  // Join 1: journaled fills ↔ ledger fills.
  const journaledFillIds = new Set<string>();
  const fillOrder = new Map<string, string>();
  for (const order of orders) {
    for (const fillId of order.fillIds) {
      journaledFillIds.add(fillId);
      fillOrder.set(fillId, order.orderId);
    }
  }
  const journaledNotInLedger = [...journaledFillIds].filter((id) => !ledgerFillIds.has(id)).sort();
  const ledgerNotJournaled = [...ledgerFillIds].filter((id) => !journaledFillIds.has(id)).sort();

  // Join 2: the fills given ↔ the journal.
  const fillMatches: ReconciliationFillMatch[] = [];
  const fillQuantityByOrder = new Map<string, number>();
  const seenFillIds = new Set<string>();
  fills.forEach((fill, index) => {
    if (seenFillIds.has(fill.fillId)) {
      refuse(FN, `input.fills[${index}].fillId`, `duplicates ${JSON.stringify(fill.fillId)}`);
    }
    seenFillIds.add(fill.fillId);
    const journaledOrderId = fillOrder.get(fill.fillId) ?? null;
    const orderId = fill.orderId ?? journaledOrderId;
    if (
      journaledOrderId !== null &&
      fill.orderId !== undefined &&
      fill.orderId !== journaledOrderId
    ) {
      warnings.push(
        `fill ${fill.fillId} names order ${fill.orderId}; the journal records it on ${journaledOrderId}`,
      );
    }
    if (orderId !== null) {
      fillQuantityByOrder.set(orderId, (fillQuantityByOrder.get(orderId) ?? 0) + fill.quantity);
    }
    fillMatches.push({
      fillId: fill.fillId,
      orderId,
      quantity: fill.quantity,
      journaled: journaledFillIds.has(fill.fillId),
      inLedger: ledgerFillIds.has(fill.fillId),
      ledgerKey: canonicalJsonOf([input.sourceId, fill.fillId]),
    });
  });
  const orderChecks: ReconciliationOrderCheck[] = orders.map((order) => {
    const fillQuantity = fillQuantityByOrder.get(order.orderId) ?? 0;
    const difference = fillQuantity - order.filledQuantity;
    return {
      orderId: order.orderId,
      state: order.state,
      journaledQuantity: order.filledQuantity,
      fillQuantity,
      difference,
      withinTolerance: Math.abs(difference) <= tolerance.quantity,
    };
  });
  const unmatchedFills = fillMatches
    .filter((match) => !match.journaled)
    .map((match) => match.fillId);
  if (unmatchedFills.length > 0) {
    warnings.push(
      `${unmatchedFills.length} given fill${unmatchedFills.length === 1 ? '' : 's'} not in the journal: ${unmatchedFills.slice(0, 5).join(', ')}${unmatchedFills.length > 5 ? ', …' : ''}`,
    );
  }

  const unresolved = orders
    .filter((order) => order.state === 'unresolved')
    .map((order) => ({ orderId: order.orderId, reason: order.reason ?? 'unresolved' }));
  const openCount = orders.filter((order) => !order.terminal).length;

  let portfolio: ReconcilePortfolioResult | null = null;
  if (input.external !== undefined) {
    portfolio = reconcilePortfolio({
      portfolio: input.ledger,
      external: input.external,
      asOf,
      tolerance,
      correctionSourceId: `reconciliation:${input.sourceId}`,
    });
    warnings.push(...portfolio.diagnostics.warnings.map((warning) => `portfolio: ${warning}`));
  }

  const differenceCount =
    journaledNotInLedger.length +
    ledgerNotJournaled.length +
    unmatchedFills.length +
    orderChecks.filter((check) => !check.withinTolerance).length +
    (portfolio === null ? 0 : portfolio.differenceCount - portfolio.explainedCount);
  const reconciled =
    differenceCount === 0 &&
    unresolved.length === 0 &&
    (portfolio === null || portfolio.reconciled);

  const body = {
    kind: RECONCILIATION_REPORT_KIND,
    schemaVersion: RECONCILIATION_REPORT_SCHEMA_VERSION,
    asOf,
    planHash,
    journalId: state.journalId,
    sourceId: input.sourceId,
    reconciled,
    orders,
    orderChecks,
    fills: fillMatches,
    journaledNotInLedger,
    ledgerNotJournaled,
    unresolved,
    portfolio,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tolerance,
      matchConvention:
        'a journaled fill id is the ledger trade.fill event id under the execution source (fillEffects key = canonical [sourceId, fillId]); fill quantities per order are compared to the journal within tolerance.quantity; an external snapshot is judged by reconcilePortfolio verbatim',
    },
    diagnostics: {
      engine: 'trade-reconciliation' as const,
      warnings,
      orderCount: orders.length,
      openCount,
      fillCount: fills.length,
      ledgerFillCount: ledgerFillIds.size,
      unresolvedCount: unresolved.length,
      differenceCount,
    },
  };
  return deepFreeze({ ...body, contentHash: contentHash(body) } as ReconciliationReport);
}
