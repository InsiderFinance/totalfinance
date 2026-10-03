/** Pure comparison of selected disclosed holdings; never a trade or economic-ledger inference. */
import {
  ensureKnownKeys,
  ErrorCode,
  requireRepresentableResult,
  WarningCode,
  type QuantWarning,
} from '@totalfinance/core';
import {
  addDecimal,
  decimal,
  decimalText,
  multiplyDecimal,
  ratioDecimal,
  subtractDecimal,
} from './disclosed-holdings-decimal.js';
import {
  compareText,
  enumeration,
  fail,
  object,
  own,
  snapshot,
  sortedUnique,
} from './disclosed-holdings-boundary.js';
import type {
  CompareDisclosedHoldingsInput,
  DisclosedHoldingChange,
  DisclosedHoldingsReport,
  DisclosedHoldingsSnapshotReport,
  DisclosedPositionResult,
} from './disclosed-holdings-types.js';
export type * from './disclosed-holdings-types.js';

const FUNCTION = 'compareDisclosedHoldings';
const keyOf = (row: { securityId: string; classId: string }): string =>
  JSON.stringify([row.securityId, row.classId]);
const orderPosition = (
  left: { securityId: string; classId: string },
  right: { securityId: string; classId: string },
): number =>
  compareText(left.securityId, right.securityId) || compareText(left.classId, right.classId);

function prepare(report: DisclosedHoldingsSnapshotReport, decimalPlaces: number): string[] {
  const groups = new Map<string, DisclosedHoldingsSnapshotReport['holdings']>();
  const identity = new Map<string, Set<string>>();
  for (const row of report.holdings) {
    const reasons: string[] = [];
    if (
      row.mappingStatus !== 'mapped' ||
      row.issuerId === null ||
      row.securityId === null ||
      row.classId === null
    )
      reasons.push('unresolved_identity');
    if (row.instrumentType !== 'common_stock') reasons.push('unsupported_instrument_type');
    if (row.quantityUnit !== 'SH') reasons.push('unsupported_quantity_unit');
    if (row.putCall !== 'none') reasons.push('option_position');
    if (row.investmentDiscretion !== 'SOLE' || row.otherManagerIds.length > 0)
      reasons.push('unsupported_discretion');
    if (row.reviewReasons.length > 0) reasons.push('source_row_review');
    row.reasons = reasons;
    if (row.securityId !== null && row.classId !== null) {
      const key = keyOf({ securityId: row.securityId, classId: row.classId });
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
      const identities = identity.get(row.securityId) ?? new Set<string>();
      identities.add(JSON.stringify([row.issuerId, row.classId]));
      identity.set(row.securityId, identities);
    }
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    if (group.length > 1) for (const row of group) row.reasons.push('duplicate_security_class');
    if (identity.get(first.securityId!)!.size > 1)
      for (const row of group) row.reasons.push('conflicting_security_identity');
    const reasons = sortedUnique(group.flatMap((row) => row.reasons));
    report.positions.push({
      issuerId: new Set(group.map((row) => row.issuerId)).size === 1 ? first.issuerId : null,
      securityId: first.securityId!,
      classId: first.classId!,
      holdingIds: group.map((row) => row.holdingId),
      evidenceIds: sortedUnique(group.flatMap((row) => row.evidenceIds)),
      quantity: reasons.length === 0 ? decimalText(decimal(first.quantity)) : null,
      reportedValue: reasons.length === 0 ? first.normalizedReportedValue : null,
      valueCurrency:
        new Set(group.map((row) => row.valueCurrency)).size === 1 ? first.valueCurrency : null,
      weight: null,
      status: reasons.length === 0 ? 'supported' : 'review',
      reasons,
    });
  }
  for (const row of report.holdings) {
    row.reasons = sortedUnique(row.reasons);
    row.status = row.reasons.length === 0 ? 'supported' : 'review';
  }
  report.positions.sort(orderPosition);
  const reasons: string[] = [];
  if (!report.reportComplete) reasons.push('report_incomplete');
  if (!report.mappingComplete) reasons.push('mapping_incomplete');
  if (!report.comparisonEligible) reasons.push('comparison_ineligible');
  if (report.reviewReasons.length > 0) reasons.push('source_snapshot_review');
  if (report.holdings.some((row) => row.status === 'review'))
    reasons.push('holdings_require_review');
  const currencies = new Set(report.holdings.map((row) => row.valueCurrency));
  if (currencies.size > 1) reasons.push('mixed_currencies');
  report.concentration.valueCurrency = currencies.size === 1 ? [...currencies][0]! : null;
  if (reasons.length > 0) {
    report.concentration.reasons = reasons;
    return reasons;
  }
  let total = decimal('0');
  let squares = decimal('0');
  let maximum = decimal('0');
  for (const row of report.holdings) {
    const value = decimal(row.normalizedReportedValue);
    total = addDecimal(total, value);
    squares = addDecimal(squares, multiplyDecimal(value, value));
    if (addDecimal(value, { ...maximum, coefficient: -maximum.coefficient }).coefficient > 0n)
      maximum = value;
  }
  report.concentration.denominatorReportedValue = decimalText(total);
  if (total.coefficient === 0n) {
    report.concentration.reasons = ['zero_denominator'];
    return [];
  }
  report.concentration.status = 'available';
  report.concentration.largestWeight = ratioDecimal({
    numerator: maximum,
    denominator: total,
    decimalPlaces,
  });
  report.concentration.herfindahlIndex = ratioDecimal({
    numerator: squares,
    denominator: multiplyDecimal(total, total),
    decimalPlaces,
  });
  for (const row of report.positions)
    row.weight = ratioDecimal({
      numerator: decimal(row.reportedValue!),
      denominator: total,
      decimalPlaces,
    });
  return [];
}

function changes(input: {
  baseline: DisclosedHoldingsSnapshotReport;
  current: DisclosedHoldingsSnapshotReport;
  baselineReasons: string[];
  currentReasons: string[];
}): DisclosedHoldingChange[] {
  const baseline = new Map(input.baseline.positions.map((row) => [keyOf(row), row]));
  const current = new Map(input.current.positions.map((row) => [keyOf(row), row]));
  const identity = new Map<string, Set<string>>();
  for (const row of [...baseline.values(), ...current.values()]) {
    const set = identity.get(row.securityId) ?? new Set<string>();
    set.add(JSON.stringify([row.issuerId, row.classId]));
    identity.set(row.securityId, set);
  }
  const complete = input.baselineReasons.length === 0 && input.currentReasons.length === 0;
  const rows: DisclosedHoldingChange[] = [];
  for (const key of sortedUnique([...baseline.keys(), ...current.keys()])) {
    const before = baseline.get(key);
    const after = current.get(key);
    const position = (after ?? before)!;
    const reasons = [
      ...input.baselineReasons.map((reason) => `baseline_${reason}`),
      ...input.currentReasons.map((reason) => `current_${reason}`),
      ...(before?.reasons ?? []),
      ...(after?.reasons ?? []),
    ];
    const conflicting = identity.get(position.securityId)!.size > 1;
    if (conflicting) reasons.push('conflicting_security_identity');
    const supported =
      !conflicting &&
      (before === undefined || before.status === 'supported') &&
      (after === undefined || after.status === 'supported');
    let classification: DisclosedHoldingChange['classification'] = 'unknown';
    if (supported && before !== undefined && after !== undefined)
      classification = 'still_disclosed';
    else if (supported && complete)
      classification = before === undefined ? 'newly_disclosed' : 'no_longer_disclosed';
    const comparable = complete && supported;
    const quantity = (row: DisclosedPositionResult | undefined): string | null =>
      row?.quantity ?? (row === undefined && comparable ? '0' : null);
    const value = (row: DisclosedPositionResult | undefined): string | null =>
      row?.reportedValue ?? (row === undefined && comparable ? '0' : null);
    const beforeQuantity = quantity(before);
    const afterQuantity = quantity(after);
    const beforeValue = value(before);
    const afterValue = value(after);
    const sameCurrency =
      before === undefined || after === undefined || before.valueCurrency === after.valueCurrency;
    if (!sameCurrency) reasons.push('currency_mismatch');
    rows.push({
      issuerId: conflicting ? null : position.issuerId,
      securityId: position.securityId,
      classId: position.classId,
      baselineHoldingIds: before?.holdingIds ?? [],
      currentHoldingIds: after?.holdingIds ?? [],
      classification,
      baselineQuantity: beforeQuantity,
      currentQuantity: afterQuantity,
      quantityDifference:
        comparable && beforeQuantity !== null && afterQuantity !== null
          ? subtractDecimal(afterQuantity, beforeQuantity)
          : null,
      baselineReportedValue: beforeValue,
      currentReportedValue: afterValue,
      valueDifference:
        comparable && sameCurrency && beforeValue !== null && afterValue !== null
          ? subtractDecimal(afterValue, beforeValue)
          : null,
      valueCurrency: sameCurrency ? position.valueCurrency : null,
      reasons: sortedUnique(reasons),
    });
  }
  return rows.sort(orderPosition);
}

/**
 * Compare supplied reported holdings; exact decimal quantities and values are never inferred trades.
 * A complete supported universe establishes absence; incomplete/unsupported evidence stays visible
 * with withheld deltas or ratios. Source/system cutoffs belong in the caller's artifact envelope.
 *
 * @example
 * compareDisclosedHoldings({ baseline, current, comparisonMode: 'reported-period-change', policy: { supportedProfile: 'common-stock-shares-v1', discretionPolicy: 'sole-without-other-managers', ratioDecimalPlaces: 12 } })
 */
export function compareDisclosedHoldings(
  input: CompareDisclosedHoldingsInput,
): DisclosedHoldingsReport {
  const request = object(input, 'input');
  ensureKnownKeys(FUNCTION, 'input', request, ['baseline', 'current', 'comparisonMode', 'policy']);
  const comparisonMode = enumeration(
    own(request, 'comparisonMode', 'input'),
    'input.comparisonMode',
    ['reported-period-change', 'same-period-revision'],
  );
  const policy = object(own(request, 'policy', 'input'), 'input.policy');
  ensureKnownKeys(FUNCTION, 'input.policy', policy, [
    'supportedProfile',
    'discretionPolicy',
    'ratioDecimalPlaces',
  ]);
  enumeration(own(policy, 'supportedProfile', 'input.policy'), 'input.policy.supportedProfile', [
    'common-stock-shares-v1',
  ]);
  enumeration(own(policy, 'discretionPolicy', 'input.policy'), 'input.policy.discretionPolicy', [
    'sole-without-other-managers',
  ]);
  const decimalPlaces = own(policy, 'ratioDecimalPlaces', 'input.policy');
  if (typeof decimalPlaces !== 'number')
    fail('input.policy.ratioDecimalPlaces', 'must be an integer from 0 through 18.');
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 18)
    fail(
      'input.policy.ratioDecimalPlaces',
      'must be an integer from 0 through 18.',
      ErrorCode.InputOutOfRange,
    );
  const baseline = snapshot(own(request, 'baseline', 'input'), 'input.baseline');
  const current = snapshot(own(request, 'current', 'input'), 'input.current');
  if (baseline.managerId !== current.managerId)
    fail(
      'input.current.managerId',
      'must match baseline.managerId; cross-manager overlaps are not inferred.',
      ErrorCode.InputOutOfRange,
    );
  if (comparisonMode === 'reported-period-change' && current.periodEnd <= baseline.periodEnd)
    fail(
      'input.current.periodEnd',
      'must follow baseline.periodEnd for reported-period-change.',
      ErrorCode.InputOutOfRange,
    );
  if (
    comparisonMode === 'same-period-revision' &&
    (current.periodEnd !== baseline.periodEnd ||
      JSON.stringify(current.reportIds) === JSON.stringify(baseline.reportIds))
  )
    fail(
      'input.current',
      'must have the same period and a distinct report ID set for same-period-revision.',
      ErrorCode.InputOutOfRange,
    );
  const baselineReasons = prepare(baseline, decimalPlaces);
  const currentReasons = prepare(current, decimalPlaces);
  const differences = changes({ baseline, current, baselineReasons, currentReasons });
  const warnings: QuantWarning[] = [];
  for (const [side, report] of [
    ['baseline', baseline],
    ['current', current],
  ] as const) {
    if (report.concentration.status === 'review')
      warnings.push({
        code: WarningCode.PortfolioDisclosedHoldingsReview,
        message: `${side} disclosed universe requires review; unavailable ratios remain null.`,
        severity: 'warn',
        context: { side, reasons: report.concentration.reasons },
      });
  }
  if (differences.some((row) => row.reasons.length > 0))
    warnings.push({
      code: WarningCode.PortfolioDisclosedHoldingsReview,
      message:
        'Some reported changes require review; missing or incompatible evidence is not a zero holding or a trade.',
      severity: 'warn',
    });
  return requireRepresentableResult(FUNCTION, {
    policyVersion: 'disclosed-holdings-v1',
    comparisonMode,
    baseline,
    current,
    changes: differences,
    assumptions: {
      profile:
        'Resolved common_stock, SH quantities, no put/call. Every supplied row remains visible; unsupported rows are never silently filtered.',
      discretion:
        'SOLE without other-manager references; repeated security/class rows are reviewed, never combined or deduplicated by guess.',
      denominator:
        'All supplied reported values in a complete supported same-currency disclosure universe; no eligible-only denominator, FX conversion or outstanding-share ownership inference.',
      rounding: `Amounts and differences are exact base-ten strings. Ratios round once half away from zero to ${decimalPlaces} decimal places; rounded weights need not sum to one. Herfindahl uses unrounded operands.`,
      changes:
        'Differences are current minus baseline reported disclosures, not purchases/sales, returns, cost basis or corporate-action-adjusted quantities. Zero denominator withholds ratios, not otherwise justified absence.',
    },
    diagnostics: {
      status: warnings.length === 0 ? 'complete' : 'review',
      warnings,
      baselineHoldingCount: baseline.holdings.length,
      currentHoldingCount: current.holdings.length,
      changeCount: differences.length,
    },
  } satisfies DisclosedHoldingsReport);
}
