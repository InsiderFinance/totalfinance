import type { QuantWarning } from '@totalfinance/core';

/** A source holding observation. Extra metadata is accepted but is not consumed or copied. */
export interface DisclosedHolding {
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
  otherManagerIds: readonly string[];
  evidenceIds: readonly string[];
  reviewReasons: readonly string[];
  [key: string]: unknown;
}

/** Selected disclosure facts, not a cash/transaction portfolio or amendment-selection request. */
export interface DisclosedHoldingsSnapshot {
  managerId: string;
  /** Strict YYYY-MM-DD reporting date, not an availability timestamp. */
  periodEnd: string;
  reportIds: readonly string[];
  evidenceIds: readonly string[];
  reportComplete: boolean;
  mappingComplete: boolean;
  comparisonEligible: boolean;
  reviewReasons: readonly string[];
  holdings: readonly DisclosedHolding[];
  [key: string]: unknown;
}

export type DisclosedHoldingsPolicy = {
  supportedProfile: 'common-stock-shares-v1';
  discretionPolicy: 'sole-without-other-managers';
  /** Ratios rounded once, half away from zero, to this many decimal places (0–18). */
  ratioDecimalPlaces: number;
};

/** Library-generated row/position review codes; source reviewReasons remain free-form. */
export type DisclosedHoldingReason =
  | 'unresolved_identity'
  | 'unsupported_instrument_type'
  | 'unsupported_quantity_unit'
  | 'option_position'
  | 'unsupported_discretion'
  | 'source_row_review'
  | 'duplicate_security_class'
  | 'conflicting_security_identity';

/** Reasons the supplied universe cannot establish absence or comparable whole-universe totals. */
export type DisclosedHoldingsSnapshotReason =
  | 'report_incomplete'
  | 'mapping_incomplete'
  | 'comparison_ineligible'
  | 'source_snapshot_review'
  | 'holdings_require_review'
  | 'mixed_currencies';

/** Zero totals additionally withhold ratios, but do not invalidate otherwise justified absence. */
export type DisclosedHoldingsConcentrationReason =
  | DisclosedHoldingsSnapshotReason
  | 'zero_denominator';

/** Snapshot eligibility codes identify the side; row and currency codes describe the pair. */
export type DisclosedHoldingChangeReason =
  | DisclosedHoldingReason
  | `baseline_${DisclosedHoldingsSnapshotReason}`
  | `current_${DisclosedHoldingsSnapshotReason}`
  | 'currency_mismatch';

export interface CompareDisclosedHoldingsInput {
  baseline: DisclosedHoldingsSnapshot;
  current: DisclosedHoldingsSnapshot;
  comparisonMode: 'reported-period-change' | 'same-period-revision';
  policy: DisclosedHoldingsPolicy;
}

export type DisclosedHoldingResult = {
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
  otherManagerIds: string[];
  evidenceIds: string[];
  reviewReasons: string[];
  normalizedReportedValue: string;
  status: 'supported' | 'review';
  reasons: DisclosedHoldingReason[];
};

export type DisclosedPositionResult = {
  issuerId: string | null;
  securityId: string;
  classId: string;
  holdingIds: string[];
  evidenceIds: string[];
  quantity: string | null;
  reportedValue: string | null;
  valueCurrency: string | null;
  weight: string | null;
  status: 'supported' | 'review';
  reasons: DisclosedHoldingReason[];
};

export type DisclosedHoldingsConcentration = {
  status: 'available' | 'review';
  /** Sum of all supplied reported values, only when the complete supported universe is known. */
  denominatorReportedValue: string | null;
  valueCurrency: string | null;
  largestWeight: string | null;
  /** Sum of squared unrounded reported-value weights, not a percentage. */
  herfindahlIndex: string | null;
  reasons: DisclosedHoldingsConcentrationReason[];
};

export type DisclosedHoldingsSnapshotReport = {
  managerId: string;
  periodEnd: string;
  reportIds: string[];
  evidenceIds: string[];
  reportComplete: boolean;
  mappingComplete: boolean;
  comparisonEligible: boolean;
  reviewReasons: string[];
  holdings: DisclosedHoldingResult[];
  positions: DisclosedPositionResult[];
  concentration: DisclosedHoldingsConcentration;
};

export type DisclosedHoldingChange = {
  issuerId: string | null;
  securityId: string;
  classId: string;
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
  reasons: DisclosedHoldingChangeReason[];
};

/** Rich JSON-safe report directly accepted by createAnalysisArtifact. */
export type DisclosedHoldingsReport = {
  policyVersion: 'disclosed-holdings-v1';
  comparisonMode: 'reported-period-change' | 'same-period-revision';
  baseline: DisclosedHoldingsSnapshotReport;
  current: DisclosedHoldingsSnapshotReport;
  changes: DisclosedHoldingChange[];
  assumptions: {
    /** Validated policy used for this report, copied independently of the caller's request. */
    policy: DisclosedHoldingsPolicy;
    profile: string;
    discretion: string;
    denominator: string;
    rounding: string;
    changes: string;
  };
  diagnostics: {
    status: 'complete' | 'review';
    warnings: QuantWarning[];
    baselineHoldingCount: number;
    currentHoldingCount: number;
    changeCount: number;
  };
};
