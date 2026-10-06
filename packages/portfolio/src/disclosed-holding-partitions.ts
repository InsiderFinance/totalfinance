/** Pure reported-line calculations; reporting partitions never establish exclusive ownership. */
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
} from './disclosed-holding-partitions-boundary.js';
import type {
  CompareDisclosedHoldingPartitionsInput,
  DisclosedHoldingPartitionChange,
  DisclosedHoldingPartitionChangeReason,
  DisclosedHoldingPartitionKey,
  DisclosedHoldingPartitionReason,
  DisclosedHoldingPartitionResult,
  DisclosedHoldingPartitionsReport,
  DisclosedHoldingPartitionsSnapshotReport,
  DisclosedHoldingPartitionsSnapshotReason,
  DisclosedUncomparedHoldingPartition,
} from './disclosed-holding-partitions-types.js';
export type * from './disclosed-holding-partitions-types.js';

const FUNCTION = 'compareDisclosedHoldingPartitions';
const groupKey = (key: { securityId: string; classId: string }): string =>
  JSON.stringify([key.securityId, key.classId]);
const partitionIdentity = (key: DisclosedHoldingPartitionKey): string =>
  JSON.stringify([
    key.securityId,
    key.classId,
    key.investmentDiscretion,
    key.otherManagerReferences,
    key.sourceReportId ?? null,
  ]);
const copyKey = (key: DisclosedHoldingPartitionKey): DisclosedHoldingPartitionKey => ({
  ...key,
  otherManagerReferences: [...key.otherManagerReferences],
});
const orderPartition = (
  left: { partitionKey: DisclosedHoldingPartitionKey },
  right: { partitionKey: DisclosedHoldingPartitionKey },
): number =>
  compareText(partitionIdentity(left.partitionKey), partitionIdentity(right.partitionKey));

function prepare(
  report: DisclosedHoldingPartitionsSnapshotReport,
  decimalPlaces: number,
): DisclosedHoldingPartitionsSnapshotReason[] {
  const groups = new Map<string, DisclosedHoldingPartitionsSnapshotReport['holdings']>();
  const identity = new Map<string, Set<string>>();
  for (const row of report.holdings) {
    const reasons: DisclosedHoldingPartitionReason[] = [...row.reasons];
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
    if (!['SOLE', 'DFND', 'OTR'].includes(row.investmentDiscretion))
      reasons.push('unsupported_discretion');
    if (row.reviewReasons.length > 0) reasons.push('source_row_review');
    row.reasons = reasons;
    if (row.securityId !== null) {
      const identities = identity.get(row.securityId) ?? new Set<string>();
      identities.add(JSON.stringify([row.issuerId, row.classId]));
      identity.set(row.securityId, identities);
    }
    if (
      row.securityId !== null &&
      row.classId !== null &&
      !reasons.includes('invalid_other_manager_references')
    ) {
      row.partitionKey = {
        securityId: row.securityId,
        classId: row.classId,
        investmentDiscretion: row.investmentDiscretion,
        otherManagerReferences: [...row.otherManagerReferences],
        ...(row.otherManagerReferences.length > 0 ? { sourceReportId: row.sourceReportId } : {}),
      };
      const key = partitionIdentity(row.partitionKey);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  for (const row of report.holdings) {
    if (row.securityId !== null && identity.get(row.securityId)!.size > 1)
      row.reasons.push('conflicting_security_identity');
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    if (group.length > 1) for (const row of group) row.reasons.push('duplicate_partition');
    const reasons = sortedUnique(group.flatMap((row) => row.reasons));
    report.partitions.push({
      partitionKey: copyKey(first.partitionKey!),
      issuerId: new Set(group.map((row) => row.issuerId)).size === 1 ? first.issuerId : null,
      holdingIds: group.map((row) => row.holdingId),
      evidenceIds: sortedUnique(group.flatMap((row) => row.evidenceIds)),
      quantity: reasons.length === 0 ? decimalText(decimal(first.quantity)) : null,
      reportedValue: reasons.length === 0 ? first.normalizedReportedValue : null,
      valueCurrency:
        new Set(group.map((row) => row.valueCurrency)).size === 1 ? first.valueCurrency : null,
      partitionWeight: null,
      status: reasons.length === 0 ? 'supported' : 'review',
      reasons,
    });
  }
  for (const row of report.holdings) {
    row.reasons = sortedUnique(row.reasons);
    row.status = row.reasons.length === 0 ? 'supported' : 'review';
  }
  report.partitions.sort(orderPartition);
  const reasons: DisclosedHoldingPartitionsSnapshotReason[] = [];
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
  report.concentration.largestPartitionWeight = ratioDecimal({
    numerator: maximum,
    denominator: total,
    decimalPlaces,
  });
  report.concentration.partitionHerfindahlIndex = ratioDecimal({
    numerator: squares,
    denominator: multiplyDecimal(total, total),
    decimalPlaces,
  });
  for (const partition of report.partitions)
    partition.partitionWeight = ratioDecimal({
      numerator: decimal(partition.reportedValue!),
      denominator: total,
      decimalPlaces,
    });
  return [];
}

function comparisons(input: {
  baseline: DisclosedHoldingPartitionsSnapshotReport;
  current: DisclosedHoldingPartitionsSnapshotReport;
  baselineReasons: DisclosedHoldingPartitionsSnapshotReason[];
  currentReasons: DisclosedHoldingPartitionsSnapshotReason[];
}): {
  changes: DisclosedHoldingPartitionChange[];
  uncomparedPartitions: DisclosedUncomparedHoldingPartition[];
} {
  const baseline = new Map(
    input.baseline.partitions.map((row) => [partitionIdentity(row.partitionKey), row]),
  );
  const current = new Map(
    input.current.partitions.map((row) => [partitionIdentity(row.partitionKey), row]),
  );
  const referenceGroups = new Set<string>();
  const identities = new Map<string, Set<string>>();
  for (const report of [input.baseline, input.current])
    for (const row of report.holdings) {
      if (row.securityId === null) continue;
      const identity = identities.get(row.securityId) ?? new Set<string>();
      identity.add(JSON.stringify([row.issuerId, row.classId]));
      identities.set(row.securityId, identity);
      if (row.classId !== null && row.otherManagerReferences.length > 0)
        referenceGroups.add(groupKey({ securityId: row.securityId, classId: row.classId }));
    }
  const bases = (report: DisclosedHoldingPartitionsSnapshotReport): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    for (const row of report.partitions) {
      const key = groupKey(row.partitionKey);
      const values = result.get(key) ?? [];
      if (row.partitionKey.otherManagerReferences.length === 0)
        values.push(row.partitionKey.investmentDiscretion);
      result.set(key, values);
    }
    for (const [key, values] of result) result.set(key, sortedUnique(values));
    return result;
  };
  const beforeBases = bases(input.baseline);
  const afterBases = bases(input.current);
  const changedBases = new Set<string>();
  for (const [key, before] of beforeBases)
    if (afterBases.has(key) && JSON.stringify(before) !== JSON.stringify(afterBases.get(key)))
      changedBases.add(key);
  const complete = input.baselineReasons.length === 0 && input.currentReasons.length === 0;
  const snapshotReasons: DisclosedHoldingPartitionChangeReason[] = [
    ...input.baselineReasons.map((reason) => `baseline_${reason}` as const),
    ...input.currentReasons.map((reason) => `current_${reason}` as const),
  ];
  const changes: DisclosedHoldingPartitionChange[] = [];
  const uncomparedPartitions: DisclosedUncomparedHoldingPartition[] = [];
  for (const key of sortedUnique([...baseline.keys(), ...current.keys()])) {
    const before = baseline.get(key);
    const after = current.get(key);
    const position = (after ?? before)!;
    const group = groupKey(position.partitionKey);
    const reasons: DisclosedHoldingPartitionChangeReason[] = [
      ...snapshotReasons,
      ...(before?.reasons ?? []),
      ...(after?.reasons ?? []),
    ];
    const conflicting = identities.get(position.partitionKey.securityId)!.size > 1;
    if (conflicting) reasons.push('conflicting_security_identity');
    if (referenceGroups.has(group) || changedBases.has(group)) {
      if (referenceGroups.has(group)) reasons.push('report_scoped_reference_basis');
      if (changedBases.has(group)) reasons.push('partition_basis_changed');
      for (const [side, partition] of [
        ['baseline', before],
        ['current', after],
      ] as const) {
        if (partition === undefined) continue;
        uncomparedPartitions.push({
          side,
          partitionKey: copyKey(partition.partitionKey),
          issuerId: partition.issuerId,
          holdingIds: [...partition.holdingIds],
          evidenceIds: [...partition.evidenceIds],
          quantity: partition.quantity,
          reportedValue: partition.reportedValue,
          valueCurrency: partition.valueCurrency,
          classification: 'unknown',
          reasons: sortedUnique(reasons),
        });
      }
      continue;
    }
    const supported =
      !conflicting &&
      (before === undefined || before.status === 'supported') &&
      (after === undefined || after.status === 'supported');
    const comparable = complete && supported;
    let classification: DisclosedHoldingPartitionChange['classification'] = 'unknown';
    if (comparable)
      classification =
        before === undefined
          ? 'newly_disclosed'
          : after === undefined
            ? 'no_longer_disclosed'
            : 'still_disclosed';
    const quantity = (row: DisclosedHoldingPartitionResult | undefined): string | null =>
      row?.quantity ?? (row === undefined && comparable ? '0' : null);
    const value = (row: DisclosedHoldingPartitionResult | undefined): string | null =>
      row?.reportedValue ?? (row === undefined && comparable ? '0' : null);
    const baselineQuantity = quantity(before);
    const currentQuantity = quantity(after);
    const baselineReportedValue = value(before);
    const currentReportedValue = value(after);
    const sameCurrency =
      before === undefined || after === undefined || before.valueCurrency === after.valueCurrency;
    if (!sameCurrency) reasons.push('currency_mismatch');
    changes.push({
      partitionKey: copyKey(position.partitionKey),
      issuerId: conflicting ? null : position.issuerId,
      baselineHoldingIds: before?.holdingIds.slice() ?? [],
      currentHoldingIds: after?.holdingIds.slice() ?? [],
      classification,
      baselineQuantity,
      currentQuantity,
      quantityDifference:
        comparable && baselineQuantity !== null && currentQuantity !== null
          ? subtractDecimal(currentQuantity, baselineQuantity)
          : null,
      baselineReportedValue,
      currentReportedValue,
      valueDifference:
        comparable &&
        sameCurrency &&
        baselineReportedValue !== null &&
        currentReportedValue !== null
          ? subtractDecimal(currentReportedValue, baselineReportedValue)
          : null,
      valueCurrency: sameCurrency ? position.valueCurrency : null,
      reasons: sortedUnique(reasons),
    });
  }
  changes.sort(orderPartition);
  uncomparedPartitions.sort(
    (left, right) => compareText(left.side, right.side) || orderPartition(left, right),
  );
  return { changes, uncomparedPartitions };
}

/** Compare supplied reported partitions without treating discretion redistribution as a position change. */
export function compareDisclosedHoldingPartitions(
  input: CompareDisclosedHoldingPartitionsInput,
): DisclosedHoldingPartitionsReport {
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
  const supportedProfile = enumeration(
    own(policy, 'supportedProfile', 'input.policy'),
    'input.policy.supportedProfile',
    ['common-stock-reported-partitions-v1'],
  );
  const discretionPolicy = enumeration(
    own(policy, 'discretionPolicy', 'input.policy'),
    'input.policy.discretionPolicy',
    ['reported-partitions-without-cross-manager-netting'],
  );
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
  const result = comparisons({ baseline, current, baselineReasons, currentReasons });
  const warnings: QuantWarning[] = [];
  for (const [side, report] of [
    ['baseline', baseline],
    ['current', current],
  ] as const)
    if (report.concentration.status === 'review')
      warnings.push({
        code: WarningCode.PortfolioDisclosedHoldingsReview,
        message: `${side} reported-partition universe requires review; unavailable ratios remain null.`,
        severity: 'warn',
        context: { side, reasons: report.concentration.reasons },
      });
  if (
    result.uncomparedPartitions.length > 0 ||
    result.changes.some((row) => row.reasons.length > 0)
  )
    warnings.push({
      code: WarningCode.PortfolioDisclosedHoldingsReview,
      message:
        'Some reported partitions cannot be compared; source-local references or changed reporting bases never imply trades or absent holdings.',
      severity: 'warn',
    });
  return requireRepresentableResult(FUNCTION, {
    policyVersion: 'disclosed-holding-partitions-v1',
    comparisonMode,
    baseline,
    current,
    ...result,
    assumptions: {
      policy: { supportedProfile, discretionPolicy, ratioDecimalPlaces: decimalPlaces },
      profile:
        'Mapped common_stock, SH quantities, no put/call, recognized SOLE/DFND/OTR; all unsupported and reviewed observations remain visible.',
      discretion:
        'Reported line partitions without aggregation, cross-manager netting or ownership inference. Other-manager tokens are exact and local to sourceReportId.',
      denominator:
        'All supplied reported values in a complete supported same-currency universe; no mapped-subset denominator or security-level concentration.',
      rounding: `Exact base-ten amounts and differences; ratios round once half away from zero to ${decimalPlaces} places; partition Herfindahl uses unrounded operands. Rounded weights need not sum to one.`,
      changes:
        'Current minus baseline reported disclosures on stable no-reference bases, never trades, returns or ownership. Explicit zero stays disclosed; zero denominator withholds ratios only.',
      partitionBasis:
        'Structured security/class/discretion/reference-set keys; sourceReportId is included only for nonempty references. Any reference-bearing row or changed discretion set withholds its entire security/class group; each keyed partition is accounted for once per present side.',
    },
    diagnostics: {
      status: warnings.length === 0 ? 'complete' : 'review',
      warnings,
      baselineHoldingCount: baseline.holdings.length,
      currentHoldingCount: current.holdings.length,
      changeCount: result.changes.length,
      baselinePartitionCount: baseline.partitions.length,
      currentPartitionCount: current.partitions.length,
      uncomparedPartitionCount: result.uncomparedPartitions.length,
    },
  } satisfies DisclosedHoldingPartitionsReport);
}
