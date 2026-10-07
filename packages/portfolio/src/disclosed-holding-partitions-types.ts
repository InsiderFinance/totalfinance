import type { QuantWarning } from '@totalfinance/core';

/** A source holding observation. Extra metadata is accepted but is not consumed or copied. */
export interface DisclosedHoldingPartition {
  holdingId: string;
  issuerId: string | null;
  securityId: string | null;
  classId: string | null;
  mappingStatus: 'mapped' | 'unresolved';
  instrumentType: string;
  /** Exact nonnegative plain decimal string, at most 100 digits and 18 fractional places. */
  quantity: string;
  quantityUnit: string;
  /** Exact reported amount before multiplying by valueScale. */
  reportedValue: string;
  valueCurrency: string;
  /** Explicit multiplier, exactly '1' or '1000'. */
  valueScale: '1' | '1000';
  putCall: 'none' | 'put' | 'call';
  investmentDiscretion: string;
  sourceReportId: string;
  otherManagerReferences: readonly string[];
  evidenceIds: readonly string[];
  reviewReasons: readonly string[];
  [key: string]: unknown;
}

/** Selected disclosure facts, not a cash/transaction portfolio or amendment-selection request. */
export interface DisclosedHoldingPartitionsSnapshot {
  managerId: string;
  /** Strict YYYY-MM-DD reporting date, not an availability timestamp. */
  periodEnd: string;
  reportIds: readonly string[];
  evidenceIds: readonly string[];
  /**
   * Caller attests that holdings contains the entire selected reported universe for this period,
   * not a page, filtered subset, or a report with known withheld/missing holdings. This does not
   * assert that a disclosure covers all of the manager's economic assets. Unknown means false.
   */
  reportComplete: boolean;
  /**
   * Caller attests that every supplied holding has an authenticated issuer/security/class mapping.
   * Keep unresolved rows in holdings; never drop them to make this true. The library also checks
   * consumed mapping fields and conflicts. Unknown means false.
   */
  mappingComplete: boolean;
  /**
   * Caller attests that upstream source/report-selection review permits using this snapshot for
   * the requested comparison (including amendment selection and known disclosure limitations).
   * The SDK does not authenticate evidence or select reports. Unknown means false; explain known
   * issues in reviewReasons. True never overrides row reviews, reference scope or changed bases.
   * All three flags gate totals/weights; both snapshots must pass before absence or deltas are inferred.
   */
  comparisonEligible: boolean;
  reviewReasons: readonly string[];
  holdings: readonly DisclosedHoldingPartition[];
  [key: string]: unknown;
}

export type DisclosedHoldingPartitionsPolicy = {
  supportedProfile: 'common-stock-reported-partitions-v1';
  discretionPolicy: 'reported-partitions-without-cross-manager-netting';
  /** Ratios rounded once, half away from zero, to this many decimal places (0–18). */
  ratioDecimalPlaces: number;
};

/** Library-generated row/position review codes; source reviewReasons remain free-form. */
export type DisclosedHoldingPartitionReason =
  | 'unresolved_identity'
  | 'unsupported_instrument_type'
  | 'unsupported_quantity_unit'
  | 'option_position'
  | 'unsupported_discretion'
  | 'source_row_review'
  | 'duplicate_partition'
  | 'invalid_other_manager_references'
  | 'conflicting_security_identity';

/** Reasons the supplied universe cannot establish absence or comparable whole-universe totals. */
export type DisclosedHoldingPartitionsSnapshotReason =
  | 'report_incomplete'
  | 'mapping_incomplete'
  | 'comparison_ineligible'
  | 'source_snapshot_review'
  | 'holdings_require_review'
  | 'mixed_currencies';

/** Zero totals additionally withhold ratios, but do not invalidate otherwise justified absence. */
export type DisclosedHoldingPartitionsConcentrationReason =
  | DisclosedHoldingPartitionsSnapshotReason
  | 'zero_denominator';

/** Snapshot eligibility codes identify the side; row and currency codes describe the pair. */
export type DisclosedHoldingPartitionChangeReason =
  | DisclosedHoldingPartitionReason
  | `baseline_${DisclosedHoldingPartitionsSnapshotReason}`
  | `current_${DisclosedHoldingPartitionsSnapshotReason}`
  | 'currency_mismatch'
  | 'report_scoped_reference_basis'
  | 'partition_basis_changed';

export interface CompareDisclosedHoldingPartitionsInput {
  baseline: DisclosedHoldingPartitionsSnapshot;
  current: DisclosedHoldingPartitionsSnapshot;
  comparisonMode: 'reported-period-change' | 'same-period-revision';
  policy: DisclosedHoldingPartitionsPolicy;
}

export type DisclosedHoldingPartitionRowResult = {
  holdingId: string;
  issuerId: string | null;
  securityId: string | null;
  classId: string | null;
  mappingStatus: 'mapped' | 'unresolved';
  instrumentType: string;
  quantity: string;
  quantityUnit: string;
  reportedValue: string;
  valueCurrency: string;
  valueScale: '1' | '1000';
  putCall: 'none' | 'put' | 'call';
  investmentDiscretion: string;
  sourceReportId: string;
  otherManagerReferences: string[];
  partitionKey: DisclosedHoldingPartitionKey | null;
  evidenceIds: string[];
  reviewReasons: string[];
  normalizedReportedValue: string;
  status: 'supported' | 'review';
  reasons: DisclosedHoldingPartitionReason[];
};

export type DisclosedHoldingPartitionResult = {
  partitionKey: DisclosedHoldingPartitionKey;
  issuerId: string | null;
  holdingIds: string[];
  evidenceIds: string[];
  quantity: string | null;
  reportedValue: string | null;
  valueCurrency: string | null;
  partitionWeight: string | null;
  status: 'supported' | 'review';
  reasons: DisclosedHoldingPartitionReason[];
};

export type DisclosedHoldingPartitionsConcentration = {
  status: 'available' | 'review';
  /** Sum of all supplied reported values, only when the complete supported universe is known. */
  denominatorReportedValue: string | null;
  valueCurrency: string | null;
  largestPartitionWeight: string | null;
  /** Sum of squared unrounded reported-value weights, not a percentage. */
  partitionHerfindahlIndex: string | null;
  reasons: DisclosedHoldingPartitionsConcentrationReason[];
};

export type DisclosedHoldingPartitionsSnapshotReport = {
  managerId: string;
  periodEnd: string;
  reportIds: string[];
  evidenceIds: string[];
  reportComplete: boolean;
  mappingComplete: boolean;
  comparisonEligible: boolean;
  reviewReasons: string[];
  holdings: DisclosedHoldingPartitionRowResult[];
  partitions: DisclosedHoldingPartitionResult[];
  concentration: DisclosedHoldingPartitionsConcentration;
};

export type DisclosedHoldingPartitionChange = {
  partitionKey: DisclosedHoldingPartitionKey;
  issuerId: string | null;
  baselineHoldingIds: string[];
  currentHoldingIds: string[];
  classification: 'newly_disclosed' | 'still_disclosed' | 'no_longer_disclosed' | 'unknown';
  baselineQuantity: string | null;
  currentQuantity: string | null;
  quantityDifference: string | null;
  baselineReportedValue: string | null;
  currentReportedValue: string | null;
  valueDifference: string | null;
  valueCurrency: string | null;
  reasons: DisclosedHoldingPartitionChangeReason[];
};

/** Reported line basis; sourceReportId is present only with filing-local references. */
export type DisclosedHoldingPartitionKey = {
  securityId: string;
  classId: string;
  investmentDiscretion: string;
  otherManagerReferences: string[];
  sourceReportId?: string;
};

export type DisclosedUncomparedHoldingPartition = {
  side: 'baseline' | 'current';
  partitionKey: DisclosedHoldingPartitionKey;
  issuerId: string | null;
  holdingIds: string[];
  evidenceIds: string[];
  quantity: string | null;
  reportedValue: string | null;
  valueCurrency: string | null;
  classification: 'unknown';
  reasons: DisclosedHoldingPartitionChangeReason[];
};

/** Rich JSON-safe report directly accepted by createAnalysisArtifact. */
export type DisclosedHoldingPartitionsReport = {
  policyVersion: 'disclosed-holding-partitions-v1';
  comparisonMode: 'reported-period-change' | 'same-period-revision';
  baseline: DisclosedHoldingPartitionsSnapshotReport;
  current: DisclosedHoldingPartitionsSnapshotReport;
  changes: DisclosedHoldingPartitionChange[];
  uncomparedPartitions: DisclosedUncomparedHoldingPartition[];
  assumptions: {
    /** Validated policy used for this report, copied independently of the caller's request. */
    policy: DisclosedHoldingPartitionsPolicy;
    profile: string;
    discretion: string;
    denominator: string;
    rounding: string;
    changes: string;
    partitionBasis: string;
  };
  diagnostics: {
    status: 'complete' | 'review';
    warnings: QuantWarning[];
    baselineHoldingCount: number;
    currentHoldingCount: number;
    changeCount: number;
    baselinePartitionCount: number;
    currentPartitionCount: number;
    uncomparedPartitionCount: number;
  };
};
