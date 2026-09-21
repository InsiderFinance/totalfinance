/**
 * Vendor-neutral sector returns: supplied same-period returns or an audited completed-session snapshot.
 * Pure compute only: no provider aliases, universe inference, I/O, cache, or system clock.
 */

import {
  ensureKnownKeys,
  ErrorCode,
  InputError,
  requireRepresentableResult,
  type QuantWarning,
} from '@totalfinance/core';
import {
  AGGREGATION_ASSUMPTIONS,
  POLICY_VERSION,
  aggregateSectors,
  compareText,
  sectorBoundary,
  sectorSimpleReturn,
  sectorWarnings,
  type SectorGroup,
} from './sector-performance-internal.js';

/** The selected fields of one same-period return observation. */
export interface SectorPerformanceMemberResult {
  securityId: string;
  sectorId: string;
  sectorName: string;
  /** Decimal simple return (0.01 = +1%), at least -1. No daily/annual horizon is inferred. */
  periodReturn: number;
}

/** A supplied decimal return over the SAME caller-chosen period and comparable return basis. */
export interface SectorPerformanceMember extends SectorPerformanceMemberResult {
  /** Extra observation metadata is accepted, not traversed or copied into the report. */
  [key: string]: unknown;
}

/** The simple on-ramp needs no invented price, calendar, classification or source lineage. */
export interface SectorPerformanceInput {
  /** Dense observations with unique securityId; at most 1,000,000 rows. Empty is disclosed. */
  members: readonly SectorPerformanceMember[];
}

export interface SectorPerformanceSectorResult {
  sectorId: string;
  sectorName: string;
  /** Equal-security mean, rounded once to eight decimal-return places. */
  periodReturn: number;
  /** Descending competition rank on rounded returns. */
  rank: number;
  includedSecurityCount: number;
  members: SectorPerformanceMemberResult[];
}

export interface SectorPerformanceAssumptions {
  policyVersion: typeof POLICY_VERSION;
  returnBasis: string;
  weighting: string;
  rounding: string;
  rankingAndTies: string;
}

/** Rich report accepted directly by createAnalysisArtifact; raw calculation needs no artifact. */
export type SectorPerformanceReport = {
  policyVersion: typeof POLICY_VERSION;
  assumptions: Readonly<SectorPerformanceAssumptions>;
  sectors: SectorPerformanceSectorResult[];
  diagnostics: {
    warnings: QuantWarning[];
    status: 'complete' | 'empty';
    inputMemberCount: number;
    includedSecurityCount: number;
    sectorCount: number;
  };
};

const SIMPLE_ASSUMPTIONS: Readonly<SectorPerformanceAssumptions> = Object.freeze({
  ...AGGREGATION_ASSUMPTIONS,
  returnBasis:
    'Caller-supplied decimal simple returns over one common period and comparable basis; no horizon, price, taxonomy, source, currency conversion, or audit metadata is inferred.',
});
const SIMPLE_BOUNDARY = sectorBoundary(
  'sectorPerformance',
  "sectorPerformance({ members: [{ securityId: 'A', sectorId: 'technology', sectorName: 'Technology', periodReturn: 0.01 }] })",
);
const MEMBER_KEYS = ['securityId', 'sectorId', 'sectorName', 'periodReturn'] as const;

/**
 * Equal-weight sectors from same-period decimal returns. Rows are open observations, the request
 * is closed. Inputs are copied, never mutated; identities, not ticker aliases, determine membership.
 *
 * @example
 * sectorPerformance({ members: [{ securityId: 'A', sectorId: 'technology', sectorName: 'Technology', periodReturn: 0.01 }] })
 */
export function sectorPerformance(input: SectorPerformanceInput): SectorPerformanceReport {
  const boundary = SIMPLE_BOUNDARY;
  const value = boundary.requireObject<Partial<SectorPerformanceInput>>('input', input);
  ensureKnownKeys('sectorPerformance', 'input', value, ['members']);
  boundary.requireFields(value, 'input', ['members']);
  const arrays = boundary.boundedArrays(value, ['members']);
  const members = boundary.mapRows(
    arrays['members']!,
    'input.members',
    (raw, index): SectorPerformanceMemberResult => {
      const path = `input.members[${index}]`;
      const row = boundary.requireObject<Partial<SectorPerformanceMember>>(path, raw);
      boundary.requireFields(row, path, MEMBER_KEYS);
      const periodReturn = boundary.requireNumber(`${path}.periodReturn`, row.periodReturn);
      if (periodReturn < -1) {
        throw new InputError(
          `sectorPerformance: ${path}.periodReturn must be >= -1 in decimal simple-return units.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: 'sectorPerformance', field: `${path}.periodReturn` },
          },
        );
      }
      return {
        securityId: boundary.requireNonEmptyString(`${path}.securityId`, row.securityId),
        sectorId: boundary.requireNonEmptyString(`${path}.sectorId`, row.sectorId),
        sectorName: boundary.requireNonEmptyString(`${path}.sectorName`, row.sectorName),
        periodReturn: Object.is(periodReturn, -0) ? 0 : periodReturn,
      };
    },
  );
  boundary.requireUnique(members, 'input.members', (member) => member.securityId);
  const groups = new Map<string, SectorGroup<SectorPerformanceMemberResult>>();
  // Identity ordering also pins the lineage order and keeps both aggregation paths identical.
  members.sort((left, right) => compareText(left.securityId, right.securityId));
  for (const member of members) {
    const group = groups.get(member.sectorId);
    if (group === undefined) {
      groups.set(member.sectorId, {
        sectorId: member.sectorId,
        sectorName: member.sectorName,
        eligibleSecurityCount: 1,
        members: [member],
      });
    } else {
      if (group.sectorName !== member.sectorName) {
        throw new InputError('sectorPerformance: one sectorId must have one sectorName.', {
          code: ErrorCode.InputOutOfRange,
          context: {
            function: 'sectorPerformance',
            field: 'input.members',
            sectorId: member.sectorId,
          },
        });
      }
      group.members.push(member);
      group.eligibleSecurityCount++;
    }
  }
  const sectors = aggregateSectors({
    groups: groups.values(),
    memberReturn: (member) => member.periodReturn,
  }).map(({ sectorId, sectorName, periodReturn, rank, includedSecurityCount, members }) => ({
    sectorId,
    sectorName,
    periodReturn,
    rank,
    includedSecurityCount,
    members,
  }));
  return requireRepresentableResult('sectorPerformance', {
    policyVersion: POLICY_VERSION,
    assumptions: SIMPLE_ASSUMPTIONS,
    sectors,
    diagnostics: {
      warnings: sectorWarnings({ blockers: members.length === 0 ? ['members-empty'] : [] }),
      status: members.length === 0 ? 'empty' : 'complete',
      inputMemberCount: members.length,
      includedSecurityCount: members.length,
      sectorCount: sectors.length,
    },
  });
}

/** A caller-nominated eligible security and listing. Ticker decoration is not used as identity. */
export interface SectorPerformanceUniverseMember {
  /** Harmless caller decoration is accepted but is not copied into selected-input lineage. */
  [key: string]: unknown;
  /** Stable identity for the supplied universe membership decision. */
  universeMembershipId: string;
  /** Stable security identity; sector returns receive one equal weight per security. */
  securityId: string;
  /** Stable listing identity used for exact close joins. */
  listingId: string;
}

/** One caller-supplied completed market session. */
export interface SectorPerformanceCompletedSession {
  /** Harmless caller decoration is accepted but is not copied into selected-input lineage. */
  [key: string]: unknown;
  sessionId: string;
  /** Strict `YYYY-MM-DD` session date. */
  sessionDate: string;
  /** When the caller considered the session complete. */
  completedAtTimestampMs: number;
}

/** One effective-dated, bitemporal sector-classification observation. */
export interface SectorClassificationObservation {
  /** Harmless caller decoration is accepted but is not copied into selected-input lineage. */
  [key: string]: unknown;
  classificationObservationId: string;
  securityId: string;
  taxonomyId: string;
  taxonomyVersion: string;
  /** Inclusive strict `YYYY-MM-DD` boundary. */
  effectiveFromSessionDate: string;
  /** Exclusive strict `YYYY-MM-DD` boundary, or `null` while the state remains effective. */
  effectiveToSessionDate: string | null;
  /** `null` together with `sectorName` explicitly records an unclassified state. */
  sectorId: string | null;
  /** `null` together with `sectorId` explicitly records an unclassified state. */
  sectorName: string | null;
  sourceId: string;
  sourceTimestampMs: number;
  knownAtTimestampMs: number;
}

/** One exact-session split-adjusted close observation. */
export interface SectorPerformanceCloseObservation {
  /** Harmless caller decoration is accepted but is not copied into selected-input lineage. */
  [key: string]: unknown;
  closeObservationId: string;
  securityId: string;
  listingId: string;
  sessionId: string;
  /** Positive split-adjusted close in `currency`. */
  splitAdjustedClose: number;
  currency: string;
  /** Both return legs must use the same caller-declared adjustment version. */
  adjustmentVersion: string;
  /** A stale exact-session observation is disclosed but never used. */
  quality: 'final' | 'stale';
  sourceId: string;
  sourceTimestampMs: number;
  knownAtTimestampMs: number;
}

/** Explicit point-in-time and session-completion cutoffs. All comparisons are inclusive. */
export interface SectorPerformanceCutoffs {
  sourceCutoffTimestampMs: number;
  knowledgeCutoffTimestampMs: number;
  sessionCompletedCutoffTimestampMs: number;
}

/** The classification taxonomy selected for this calculation. */
export interface SectorPerformanceTaxonomy {
  taxonomyId: string;
  taxonomyVersion: string;
}

/**
 * Complete, caller-supplied input to the pure calculation. No policy argument is needed: the
 * implemented version is stamped in the report. The four dense arrays share a 1,000,000-row
 * synchronous work ceiling, checked before any observation is accessed.
 */
export interface SectorPerformanceSnapshotInput {
  /** Exact requested session date. A non-session date produces an empty diagnostic report. */
  targetSessionDate: string;
  /** Caller-declared calendar identity; TotalFinance does not infer holidays or sessions. */
  marketCalendarId: string;
  classificationTaxonomy: SectorPerformanceTaxonomy;
  cutoffs: SectorPerformanceCutoffs;
  /** Exactly one nominated listing per eligible security for the target session. */
  eligibleUniverse: readonly SectorPerformanceUniverseMember[];
  completedSessions: readonly SectorPerformanceCompletedSession[];
  classifications: readonly SectorClassificationObservation[];
  splitAdjustedCloses: readonly SectorPerformanceCloseObservation[];
}

/** The immutable semantics echoed by every result. */
export interface SectorPerformanceSnapshotAssumptions {
  policyVersion: typeof POLICY_VERSION;
  eligibility: string;
  sessionSelection: string;
  temporalSelection: string;
  classification: string;
  returnBasis: string;
  weighting: string;
  missingAndStale: string;
  rounding: string;
  rankingAndTies: string;
  cacheAndFreshness: string;
}

/** Selected completed-session lineage. */
export interface SectorPerformanceSessionLineage {
  sessionId: string;
  sessionDate: string;
  completedAtTimestampMs: number;
}

/** Selected classification lineage sufficient to replay a member's sector assignment. */
export interface SectorPerformanceClassificationLineage {
  classificationObservationId: string;
  securityId: string;
  taxonomyId: string;
  taxonomyVersion: string;
  effectiveFromSessionDate: string;
  effectiveToSessionDate: string | null;
  sectorId: string | null;
  sectorName: string | null;
  sourceId: string;
  sourceTimestampMs: number;
  knownAtTimestampMs: number;
}

/** Assigned classification lineage carried by every included member. */
export interface SectorPerformanceAssignedClassificationLineage extends SectorPerformanceClassificationLineage {
  sectorId: string;
  sectorName: string;
}

/** Selected close lineage sufficient to replay one return leg. */
export interface SectorPerformanceCloseLineage {
  closeObservationId: string;
  securityId: string;
  listingId: string;
  sessionId: string;
  splitAdjustedClose: number;
  currency: string;
  adjustmentVersion: string;
  quality: 'final' | 'stale';
  sourceId: string;
  sourceTimestampMs: number;
  knownAtTimestampMs: number;
}

/** One included security and every selected input that contributed to its return. */
export interface SectorPerformanceSnapshotMemberResult {
  universeMembershipId: string;
  securityId: string;
  listingId: string;
  /** Unrounded decimal simple return for this security. */
  dailyReturn: number;
  classification: SectorPerformanceAssignedClassificationLineage;
  previousClose: SectorPerformanceCloseLineage;
  targetClose: SectorPerformanceCloseLineage;
}

/** Why a nominated member could not contribute; reasons are emitted in this declared order. */
export type SectorPerformanceExclusionReason =
  | 'classification-missing'
  | 'classification-after-cutoff'
  | 'classification-unassigned'
  | 'previous-close-missing'
  | 'previous-close-after-cutoff'
  | 'previous-close-stale'
  | 'target-close-missing'
  | 'target-close-after-cutoff'
  | 'target-close-stale'
  | 'currency-mismatch'
  | 'adjustment-version-mismatch';

/** Explicit partial lineage for a nominated security excluded from calculation. */
export interface SectorPerformanceExclusion {
  universeMembershipId: string;
  securityId: string;
  listingId: string;
  reasons: SectorPerformanceExclusionReason[];
  classification?: SectorPerformanceClassificationLineage;
  previousClose?: SectorPerformanceCloseLineage;
  targetClose?: SectorPerformanceCloseLineage;
}

/** One canonical sector result. No provider compatibility alias is part of this contract. */
export interface SectorPerformanceSnapshotSectorResult {
  sectorId: string;
  sectorName: string;
  /** Equal-security arithmetic mean, in decimal return units, rounded once to eight places. */
  dailyReturn: number;
  /** Descending competition rank (`1, 1, 3`) on the rounded sector return. */
  rank: number;
  eligibleSecurityCount: number;
  includedSecurityCount: number;
  excludedSecurityCount: number;
  members: SectorPerformanceSnapshotMemberResult[];
}

/** A calculation-level reason that no complete sector result could be produced. */
export type SectorPerformanceBlocker =
  | 'target-session-not-completed'
  | 'previous-completed-session-unavailable'
  | 'eligible-universe-empty'
  | 'no-includable-members';

/** Deterministic count of one exclusion reason. */
export interface SectorPerformanceReasonCount {
  reason: SectorPerformanceExclusionReason;
  count: number;
}

/** Input, coverage, and exclusion diagnostics for the calculation. */
export interface SectorPerformanceSnapshotDiagnostics {
  warnings: QuantWarning[];
  status: 'complete' | 'partial' | 'empty';
  blockers: SectorPerformanceBlocker[];
  inputCounts: {
    eligibleUniverse: number;
    completedSessions: number;
    classifications: number;
    splitAdjustedCloses: number;
  };
  eligibleSecurityCount: number;
  includedSecurityCount: number;
  excludedSecurityCount: number;
  sectorCount: number;
  reasonCounts: SectorPerformanceReasonCount[];
}

/** Canonical, replayable result of one requested daily sector-performance calculation. */
export type SectorPerformanceSnapshotReport = {
  policyVersion: typeof POLICY_VERSION;
  assumptions: Readonly<SectorPerformanceSnapshotAssumptions>;
  targetSessionDate: string;
  marketCalendarId: string;
  classificationTaxonomy: SectorPerformanceTaxonomy;
  cutoffs: SectorPerformanceCutoffs;
  selectedSessions: {
    target: SectorPerformanceSessionLineage | null;
    previous: SectorPerformanceSessionLineage | null;
  };
  sectors: SectorPerformanceSnapshotSectorResult[];
  exclusions: SectorPerformanceExclusion[];
  diagnostics: SectorPerformanceSnapshotDiagnostics;
};

const FUNCTION_NAME = 'sectorPerformanceSnapshot';
const {
  requireObject,
  requireFields,
  requireNumber,
  requireNonEmptyString,
  requireDate,
  requireTimestamp,
  requireUnique,
  boundedArrays,
  mapRows,
} = sectorBoundary(
  FUNCTION_NAME,
  "sectorPerformanceSnapshot({ targetSessionDate: '2026-08-28', marketCalendarId: 'XNYS', classificationTaxonomy: { taxonomyId: 'GICS', taxonomyVersion: '2025' }, cutoffs, eligibleUniverse, completedSessions, classifications, splitAdjustedCloses })",
);

const ASSUMPTIONS: Readonly<SectorPerformanceSnapshotAssumptions> = Object.freeze({
  policyVersion: POLICY_VERSION,
  eligibility:
    'The caller nominates exactly one stable security/listing pair per eligible target-session security; TotalFinance does not infer security type, active status, primary listing, ticker, additions, or removals.',
  sessionSelection:
    'The requested date must exactly equal a caller-supplied session completed by the inclusive session cutoff; the comparison is the immediately preceding supplied completed session, with no calendar-date fallback.',
  temporalSelection:
    'Classification and close observations are visible only when sourceTimestampMs <= sourceCutoffTimestampMs and knownAtTimestampMs <= knowledgeCutoffTimestampMs; latest source timestamp then latest knowledge timestamp wins, and exact precedence ties fail closed.',
  classification:
    'The requested taxonomy/version and latest visible effective state at the target session are used; effective-from is inclusive, effective-to is exclusive, and later classifications never backfill history. sectorId is canonical identity, one sectorId must have one selected name, and distinct sectorIds remain distinct even when their names match.',
  returnBasis:
    'Each member return is (target split-adjusted close / previous split-adjusted close) - 1 in decimal units; it is not a log or total return and assumes no dividends beyond the supplied close basis.',
  weighting: AGGREGATION_ASSUMPTIONS.weighting,
  missingAndStale:
    'Both exact-session closes and an assigned classification are required; stale, missing, after-cutoff, currency-incomparable, and adjustment-incomparable members are excluded with diagnostics, never carried forward or zero-filled. A sector may be calculated from its remaining valid members.',
  rounding: AGGREGATION_ASSUMPTIONS.rounding,
  rankingAndTies: AGGREGATION_ASSUMPTIONS.rankingAndTies,
  cacheAndFreshness:
    'This pure calculation has no cache or system clock; exact-session inputs and caller cutoffs fully determine freshness.',
});

const INPUT_KEYS = [
  'targetSessionDate',
  'marketCalendarId',
  'classificationTaxonomy',
  'cutoffs',
  'eligibleUniverse',
  'completedSessions',
  'classifications',
  'splitAdjustedCloses',
] as const;
const TAXONOMY_KEYS = ['taxonomyId', 'taxonomyVersion'] as const;
const CUTOFF_KEYS = [
  'sourceCutoffTimestampMs',
  'knowledgeCutoffTimestampMs',
  'sessionCompletedCutoffTimestampMs',
] as const;
const UNIVERSE_KEYS = ['universeMembershipId', 'securityId', 'listingId'] as const;
const SESSION_KEYS = ['sessionId', 'sessionDate', 'completedAtTimestampMs'] as const;
const CLASSIFICATION_KEYS = [
  'classificationObservationId',
  'securityId',
  'taxonomyId',
  'taxonomyVersion',
  'effectiveFromSessionDate',
  'effectiveToSessionDate',
  'sectorId',
  'sectorName',
  'sourceId',
  'sourceTimestampMs',
  'knownAtTimestampMs',
] as const;
const CLOSE_KEYS = [
  'closeObservationId',
  'securityId',
  'listingId',
  'sessionId',
  'splitAdjustedClose',
  'currency',
  'adjustmentVersion',
  'quality',
  'sourceId',
  'sourceTimestampMs',
  'knownAtTimestampMs',
] as const;

const EXCLUSION_ORDER: readonly SectorPerformanceExclusionReason[] = [
  'classification-missing',
  'classification-after-cutoff',
  'classification-unassigned',
  'previous-close-missing',
  'previous-close-after-cutoff',
  'previous-close-stale',
  'target-close-missing',
  'target-close-after-cutoff',
  'target-close-stale',
  'currency-mismatch',
  'adjustment-version-mismatch',
];

interface ValidatedInput extends SectorPerformanceSnapshotInput {
  eligibleUniverse: SectorPerformanceUniverseMember[];
  completedSessions: SectorPerformanceCompletedSession[];
  classifications: SectorClassificationObservation[];
  splitAdjustedCloses: SectorPerformanceCloseObservation[];
}

function validateInput(input: SectorPerformanceSnapshotInput): ValidatedInput {
  const value = requireObject<Partial<SectorPerformanceSnapshotInput>>('input', input);
  ensureKnownKeys(FUNCTION_NAME, 'input', value, INPUT_KEYS);
  requireFields(value, 'input', INPUT_KEYS);

  const arrays = boundedArrays(value, [
    'eligibleUniverse',
    'completedSessions',
    'classifications',
    'splitAdjustedCloses',
  ]);
  const targetSessionDate = requireDate('input.targetSessionDate', value.targetSessionDate);
  const marketCalendarId = requireNonEmptyString('input.marketCalendarId', value.marketCalendarId);

  const taxonomyValue = requireObject<Partial<SectorPerformanceTaxonomy>>(
    'input.classificationTaxonomy',
    value.classificationTaxonomy,
  );
  ensureKnownKeys(FUNCTION_NAME, 'input.classificationTaxonomy', taxonomyValue, TAXONOMY_KEYS);
  requireFields(taxonomyValue, 'input.classificationTaxonomy', TAXONOMY_KEYS);
  const classificationTaxonomy: SectorPerformanceTaxonomy = {
    taxonomyId: requireNonEmptyString(
      'input.classificationTaxonomy.taxonomyId',
      taxonomyValue.taxonomyId,
    ),
    taxonomyVersion: requireNonEmptyString(
      'input.classificationTaxonomy.taxonomyVersion',
      taxonomyValue.taxonomyVersion,
    ),
  };

  const cutoffValue = requireObject<Partial<SectorPerformanceCutoffs>>(
    'input.cutoffs',
    value.cutoffs,
  );
  ensureKnownKeys(FUNCTION_NAME, 'input.cutoffs', cutoffValue, CUTOFF_KEYS);
  requireFields(cutoffValue, 'input.cutoffs', CUTOFF_KEYS);
  const cutoffs: SectorPerformanceCutoffs = {
    sourceCutoffTimestampMs: requireTimestamp(
      'input.cutoffs.sourceCutoffTimestampMs',
      cutoffValue.sourceCutoffTimestampMs,
    ),
    knowledgeCutoffTimestampMs: requireTimestamp(
      'input.cutoffs.knowledgeCutoffTimestampMs',
      cutoffValue.knowledgeCutoffTimestampMs,
    ),
    sessionCompletedCutoffTimestampMs: requireTimestamp(
      'input.cutoffs.sessionCompletedCutoffTimestampMs',
      cutoffValue.sessionCompletedCutoffTimestampMs,
    ),
  };

  const eligibleUniverse = mapRows(
    arrays['eligibleUniverse']!,
    'input.eligibleUniverse',
    (raw, index): SectorPerformanceUniverseMember => {
      const path = `input.eligibleUniverse[${index}]`;
      const row = requireObject<Partial<SectorPerformanceUniverseMember>>(path, raw);
      requireFields(row, path, UNIVERSE_KEYS);
      return {
        universeMembershipId: requireNonEmptyString(
          `${path}.universeMembershipId`,
          row.universeMembershipId,
        ),
        securityId: requireNonEmptyString(`${path}.securityId`, row.securityId),
        listingId: requireNonEmptyString(`${path}.listingId`, row.listingId),
      };
    },
  );

  const completedSessions = mapRows(
    arrays['completedSessions']!,
    'input.completedSessions',
    (raw, index): SectorPerformanceCompletedSession => {
      const path = `input.completedSessions[${index}]`;
      const row = requireObject<Partial<SectorPerformanceCompletedSession>>(path, raw);
      requireFields(row, path, SESSION_KEYS);
      return {
        sessionId: requireNonEmptyString(`${path}.sessionId`, row.sessionId),
        sessionDate: requireDate(`${path}.sessionDate`, row.sessionDate),
        completedAtTimestampMs: requireTimestamp(
          `${path}.completedAtTimestampMs`,
          row.completedAtTimestampMs,
        ),
      };
    },
  );

  const classifications = mapRows(
    arrays['classifications']!,
    'input.classifications',
    (raw, index): SectorClassificationObservation => {
      const path = `input.classifications[${index}]`;
      const row = requireObject<Partial<SectorClassificationObservation>>(path, raw);
      requireFields(row, path, CLASSIFICATION_KEYS);
      const effectiveFromSessionDate = requireDate(
        `${path}.effectiveFromSessionDate`,
        row.effectiveFromSessionDate,
      );
      const effectiveToSessionDate =
        row.effectiveToSessionDate === null
          ? null
          : requireDate(`${path}.effectiveToSessionDate`, row.effectiveToSessionDate);
      if (effectiveToSessionDate !== null && effectiveToSessionDate <= effectiveFromSessionDate) {
        throw new InputError(
          `${FUNCTION_NAME}: ${path}.effectiveToSessionDate must be after effectiveFromSessionDate (the end is exclusive).`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: FUNCTION_NAME, field: `${path}.effectiveToSessionDate` },
          },
        );
      }
      const sectorId =
        row.sectorId === null ? null : requireNonEmptyString(`${path}.sectorId`, row.sectorId);
      const sectorName =
        row.sectorName === null
          ? null
          : requireNonEmptyString(`${path}.sectorName`, row.sectorName);
      if ((sectorId === null) !== (sectorName === null)) {
        throw new InputError(
          `${FUNCTION_NAME}: ${path}.sectorId and sectorName must either both be non-empty strings or both be null.`,
          {
            code: ErrorCode.InputWrongShape,
            context: { function: FUNCTION_NAME, field: path },
          },
        );
      }
      const sourceTimestampMs = requireTimestamp(
        `${path}.sourceTimestampMs`,
        row.sourceTimestampMs,
      );
      const knownAtTimestampMs = requireTimestamp(
        `${path}.knownAtTimestampMs`,
        row.knownAtTimestampMs,
      );
      if (knownAtTimestampMs < sourceTimestampMs) {
        throw new InputError(
          `${FUNCTION_NAME}: ${path}.knownAtTimestampMs must be >= sourceTimestampMs.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: FUNCTION_NAME, field: `${path}.knownAtTimestampMs` },
          },
        );
      }
      return {
        classificationObservationId: requireNonEmptyString(
          `${path}.classificationObservationId`,
          row.classificationObservationId,
        ),
        securityId: requireNonEmptyString(`${path}.securityId`, row.securityId),
        taxonomyId: requireNonEmptyString(`${path}.taxonomyId`, row.taxonomyId),
        taxonomyVersion: requireNonEmptyString(`${path}.taxonomyVersion`, row.taxonomyVersion),
        effectiveFromSessionDate,
        effectiveToSessionDate,
        sectorId,
        sectorName,
        sourceId: requireNonEmptyString(`${path}.sourceId`, row.sourceId),
        sourceTimestampMs,
        knownAtTimestampMs,
      };
    },
  );

  const splitAdjustedCloses = mapRows(
    arrays['splitAdjustedCloses']!,
    'input.splitAdjustedCloses',
    (raw, index): SectorPerformanceCloseObservation => {
      const path = `input.splitAdjustedCloses[${index}]`;
      const row = requireObject<Partial<SectorPerformanceCloseObservation>>(path, raw);
      requireFields(row, path, CLOSE_KEYS);
      const splitAdjustedClose = requireNumber(
        `${path}.splitAdjustedClose`,
        row.splitAdjustedClose,
      );
      if (splitAdjustedClose <= 0) {
        throw new InputError(`${FUNCTION_NAME}: ${path}.splitAdjustedClose must be > 0.`, {
          code: ErrorCode.InputOutOfRange,
          context: { function: FUNCTION_NAME, field: `${path}.splitAdjustedClose` },
        });
      }
      if (row.quality !== 'final' && row.quality !== 'stale') {
        throw new InputError(`${FUNCTION_NAME}: ${path}.quality must be 'final' or 'stale'.`, {
          code: ErrorCode.InputInvalidEnum,
          context: { function: FUNCTION_NAME, field: `${path}.quality` },
        });
      }
      const sourceTimestampMs = requireTimestamp(
        `${path}.sourceTimestampMs`,
        row.sourceTimestampMs,
      );
      const knownAtTimestampMs = requireTimestamp(
        `${path}.knownAtTimestampMs`,
        row.knownAtTimestampMs,
      );
      if (knownAtTimestampMs < sourceTimestampMs) {
        throw new InputError(
          `${FUNCTION_NAME}: ${path}.knownAtTimestampMs must be >= sourceTimestampMs.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: FUNCTION_NAME, field: `${path}.knownAtTimestampMs` },
          },
        );
      }
      return {
        closeObservationId: requireNonEmptyString(
          `${path}.closeObservationId`,
          row.closeObservationId,
        ),
        securityId: requireNonEmptyString(`${path}.securityId`, row.securityId),
        listingId: requireNonEmptyString(`${path}.listingId`, row.listingId),
        sessionId: requireNonEmptyString(`${path}.sessionId`, row.sessionId),
        splitAdjustedClose,
        currency: requireNonEmptyString(`${path}.currency`, row.currency),
        adjustmentVersion: requireNonEmptyString(
          `${path}.adjustmentVersion`,
          row.adjustmentVersion,
        ),
        quality: row.quality,
        sourceId: requireNonEmptyString(`${path}.sourceId`, row.sourceId),
        sourceTimestampMs,
        knownAtTimestampMs,
      };
    },
  );

  requireUnique(eligibleUniverse, 'input.eligibleUniverse', (row) => row.universeMembershipId);
  requireUnique(eligibleUniverse, 'input.eligibleUniverse', (row) => row.securityId);
  requireUnique(eligibleUniverse, 'input.eligibleUniverse', (row) => row.listingId);
  requireUnique(completedSessions, 'input.completedSessions', (row) => row.sessionId);
  requireUnique(completedSessions, 'input.completedSessions', (row) => row.sessionDate);
  requireUnique(classifications, 'input.classifications', (row) => row.classificationObservationId);
  requireUnique(classifications, 'input.classifications', (row) =>
    JSON.stringify([
      row.securityId,
      row.taxonomyId,
      row.taxonomyVersion,
      row.effectiveFromSessionDate,
      row.sourceTimestampMs,
      row.knownAtTimestampMs,
    ]),
  );
  requireUnique(splitAdjustedCloses, 'input.splitAdjustedCloses', (row) => row.closeObservationId);
  requireUnique(splitAdjustedCloses, 'input.splitAdjustedCloses', (row) =>
    JSON.stringify([
      row.securityId,
      row.listingId,
      row.sessionId,
      row.sourceTimestampMs,
      row.knownAtTimestampMs,
    ]),
  );

  const sessionIds = new Set(completedSessions.map((session) => session.sessionId));
  splitAdjustedCloses.forEach((close, index) => {
    if (!sessionIds.has(close.sessionId)) {
      throw new InputError(
        `${FUNCTION_NAME}: input.splitAdjustedCloses[${index}].sessionId does not reference a supplied completed session.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            function: FUNCTION_NAME,
            field: `input.splitAdjustedCloses[${index}].sessionId`,
            sessionId: close.sessionId,
          },
        },
      );
    }
  });

  return {
    targetSessionDate,
    marketCalendarId,
    classificationTaxonomy,
    cutoffs,
    eligibleUniverse,
    completedSessions,
    classifications,
    splitAdjustedCloses,
  };
}

function compareRevision(
  left: { sourceTimestampMs: number; knownAtTimestampMs: number },
  right: { sourceTimestampMs: number; knownAtTimestampMs: number },
): number {
  return (
    left.sourceTimestampMs - right.sourceTimestampMs ||
    left.knownAtTimestampMs - right.knownAtTimestampMs
  );
}

function isVisible(
  row: { sourceTimestampMs: number; knownAtTimestampMs: number },
  cutoffs: SectorPerformanceCutoffs,
): boolean {
  return (
    row.sourceTimestampMs <= cutoffs.sourceCutoffTimestampMs &&
    row.knownAtTimestampMs <= cutoffs.knowledgeCutoffTimestampMs
  );
}

type ClassificationSelection =
  | { reason: 'classification-missing' | 'classification-after-cutoff' }
  | { reason: 'classification-unassigned'; selected: SectorClassificationObservation }
  | { selected: SectorClassificationObservation & { sectorId: string; sectorName: string } };

type CloseSelection =
  | { reason: 'missing' | 'after-cutoff' }
  | { reason: 'stale'; selected: SectorPerformanceCloseObservation }
  | { selected: SectorPerformanceCloseObservation };

function closeKey(row: { securityId: string; listingId: string; sessionId: string }): string {
  // Tuple encoding is collision-free even when identities contain separators.
  return JSON.stringify([row.securityId, row.listingId, row.sessionId]);
}

/** One linear pass per observation table. No history is rescanned for each universe member. */
function indexSelections({
  input,
  sessionIds,
}: {
  input: ValidatedInput;
  sessionIds: ReadonlySet<string>;
}) {
  const classifications = new Map<string, ClassificationSelection>();
  const closes = new Map<string, CloseSelection>();
  for (const row of input.classifications) {
    if (
      row.taxonomyId !== input.classificationTaxonomy.taxonomyId ||
      row.taxonomyVersion !== input.classificationTaxonomy.taxonomyVersion ||
      row.effectiveFromSessionDate > input.targetSessionDate
    )
      continue;
    const prior = classifications.get(row.securityId);
    if (!isVisible(row, input.cutoffs)) {
      if (prior === undefined)
        classifications.set(row.securityId, { reason: 'classification-after-cutoff' });
      continue;
    }
    if (prior !== undefined && 'selected' in prior) {
      const comparison =
        compareText(row.effectiveFromSessionDate, prior.selected.effectiveFromSessionDate) ||
        compareRevision(row, prior.selected);
      if (comparison <= 0) continue;
    }
    // The latest effective state wins even when it is ended/unassigned: never revive older states.
    const selection: ClassificationSelection =
      (row.effectiveToSessionDate !== null &&
        input.targetSessionDate >= row.effectiveToSessionDate) ||
      row.sectorId === null ||
      row.sectorName === null
        ? { reason: 'classification-unassigned', selected: row }
        : {
            selected: row as SectorClassificationObservation & {
              sectorId: string;
              sectorName: string;
            },
          };
    classifications.set(row.securityId, selection);
  }
  for (const row of input.splitAdjustedCloses) {
    // All rows were validated, but only the two exact return legs need selection state.
    if (!sessionIds.has(row.sessionId)) continue;
    const key = closeKey(row);
    const prior = closes.get(key);
    if (!isVisible(row, input.cutoffs)) {
      if (prior === undefined) closes.set(key, { reason: 'after-cutoff' });
      continue;
    }
    if (prior !== undefined && 'selected' in prior && compareRevision(row, prior.selected) <= 0)
      continue;
    closes.set(
      key,
      row.quality === 'stale' ? { reason: 'stale', selected: row } : { selected: row },
    );
  }
  return { classifications, closes };
}

function sessionLineage(
  session: SectorPerformanceCompletedSession,
): SectorPerformanceSessionLineage {
  return {
    sessionId: session.sessionId,
    sessionDate: session.sessionDate,
    completedAtTimestampMs: session.completedAtTimestampMs,
  };
}

function classificationLineage(
  row: SectorClassificationObservation,
): SectorPerformanceClassificationLineage {
  return {
    classificationObservationId: row.classificationObservationId,
    securityId: row.securityId,
    taxonomyId: row.taxonomyId,
    taxonomyVersion: row.taxonomyVersion,
    effectiveFromSessionDate: row.effectiveFromSessionDate,
    effectiveToSessionDate: row.effectiveToSessionDate,
    sectorId: row.sectorId,
    sectorName: row.sectorName,
    sourceId: row.sourceId,
    sourceTimestampMs: row.sourceTimestampMs,
    knownAtTimestampMs: row.knownAtTimestampMs,
  };
}

function assignedClassificationLineage(
  row: SectorClassificationObservation & { sectorId: string; sectorName: string },
): SectorPerformanceAssignedClassificationLineage {
  return classificationLineage(row) as SectorPerformanceAssignedClassificationLineage;
}

function closeLineage(row: SectorPerformanceCloseObservation): SectorPerformanceCloseLineage {
  return {
    closeObservationId: row.closeObservationId,
    securityId: row.securityId,
    listingId: row.listingId,
    sessionId: row.sessionId,
    splitAdjustedClose: row.splitAdjustedClose,
    currency: row.currency,
    adjustmentVersion: row.adjustmentVersion,
    quality: row.quality,
    sourceId: row.sourceId,
    sourceTimestampMs: row.sourceTimestampMs,
    knownAtTimestampMs: row.knownAtTimestampMs,
  };
}

function inputCounts(input: ValidatedInput): SectorPerformanceSnapshotDiagnostics['inputCounts'] {
  return {
    eligibleUniverse: input.eligibleUniverse.length,
    completedSessions: input.completedSessions.length,
    classifications: input.classifications.length,
    splitAdjustedCloses: input.splitAdjustedCloses.length,
  };
}

function emptyReport({
  input,
  target,
  previous,
  blocker,
}: {
  input: ValidatedInput;
  target: SectorPerformanceCompletedSession | null;
  previous: SectorPerformanceCompletedSession | null;
  blocker: SectorPerformanceBlocker;
}): SectorPerformanceSnapshotReport {
  return requireRepresentableResult(FUNCTION_NAME, {
    policyVersion: POLICY_VERSION,
    assumptions: ASSUMPTIONS,
    targetSessionDate: input.targetSessionDate,
    marketCalendarId: input.marketCalendarId,
    classificationTaxonomy: { ...input.classificationTaxonomy },
    cutoffs: { ...input.cutoffs },
    selectedSessions: {
      target: target === null ? null : sessionLineage(target),
      previous: previous === null ? null : sessionLineage(previous),
    },
    sectors: [],
    exclusions: [],
    diagnostics: {
      status: 'empty',
      blockers: [blocker],
      warnings: sectorWarnings({ blockers: [blocker] }),
      inputCounts: inputCounts(input),
      eligibleSecurityCount: input.eligibleUniverse.length,
      includedSecurityCount: 0,
      excludedSecurityCount: 0,
      sectorCount: 0,
      reasonCounts: [],
    },
  });
}

type GroupedSector = SectorGroup<SectorPerformanceSnapshotMemberResult>;

/**
 * Calculate one target session's audited sector returns from governed inputs.
 *
 * The function is deterministic and pure: it performs no I/O, reads no clock, mutates no input,
 * and never infers a universe, session, classification, or price.
 */
export function sectorPerformanceSnapshot(
  input: SectorPerformanceSnapshotInput,
): SectorPerformanceSnapshotReport {
  const validated = validateInput(input);
  const completed = validated.completedSessions
    .filter(
      (session) =>
        session.completedAtTimestampMs <= validated.cutoffs.sessionCompletedCutoffTimestampMs,
    )
    .sort(
      (left, right) =>
        compareText(left.sessionDate, right.sessionDate) ||
        compareText(left.sessionId, right.sessionId),
    );
  const target = completed.find((session) => session.sessionDate === validated.targetSessionDate);
  if (target === undefined) {
    return emptyReport({
      input: validated,
      target: null,
      previous: null,
      blocker: 'target-session-not-completed',
    });
  }
  const priorSessions = completed.filter((session) => session.sessionDate < target.sessionDate);
  const previous = priorSessions[priorSessions.length - 1];
  if (previous === undefined) {
    return emptyReport({
      input: validated,
      target,
      previous: null,
      blocker: 'previous-completed-session-unavailable',
    });
  }
  if (validated.eligibleUniverse.length === 0) {
    return emptyReport({ input: validated, target, previous, blocker: 'eligible-universe-empty' });
  }

  const indexed = indexSelections({
    input: validated,
    sessionIds: new Set([previous.sessionId, target.sessionId]),
  });
  const members = [...validated.eligibleUniverse].sort(
    (left, right) =>
      compareText(left.securityId, right.securityId) ||
      compareText(left.listingId, right.listingId),
  );
  const exclusions: SectorPerformanceExclusion[] = [];
  const groups = new Map<string, GroupedSector>();
  const sectorNames = new Map<string, string>();

  for (const member of members) {
    const classificationSelection: ClassificationSelection = indexed.classifications.get(
      member.securityId,
    ) ?? { reason: 'classification-missing' };
    const previousSelection: CloseSelection = indexed.closes.get(
      closeKey({ ...member, sessionId: previous.sessionId }),
    ) ?? { reason: 'missing' };
    const targetSelection: CloseSelection = indexed.closes.get(
      closeKey({ ...member, sessionId: target.sessionId }),
    ) ?? { reason: 'missing' };
    const reasons: SectorPerformanceExclusionReason[] = [];

    let selectedClassification:
      | (SectorClassificationObservation & { sectorId: string; sectorName: string })
      | undefined;
    let exclusionClassification: SectorClassificationObservation | undefined;
    if ('reason' in classificationSelection) {
      reasons.push(classificationSelection.reason);
      if ('selected' in classificationSelection) {
        exclusionClassification = classificationSelection.selected;
      }
    } else {
      selectedClassification = classificationSelection.selected;
      exclusionClassification = selectedClassification;
      const priorName = sectorNames.get(selectedClassification.sectorId);
      if (priorName !== undefined && priorName !== selectedClassification.sectorName) {
        throw new InputError(
          `${FUNCTION_NAME}: selected classifications map sectorId ${JSON.stringify(
            selectedClassification.sectorId,
          )} to conflicting names ${JSON.stringify(priorName)} and ${JSON.stringify(
            selectedClassification.sectorName,
          )}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: {
              function: FUNCTION_NAME,
              field: 'input.classifications',
              sectorId: selectedClassification.sectorId,
            },
          },
        );
      }
      sectorNames.set(selectedClassification.sectorId, selectedClassification.sectorName);
    }

    let selectedPrevious: SectorPerformanceCloseObservation | undefined;
    if ('reason' in previousSelection) {
      reasons.push(`previous-close-${previousSelection.reason}`);
      if ('selected' in previousSelection) selectedPrevious = previousSelection.selected;
    } else {
      selectedPrevious = previousSelection.selected;
    }

    let selectedTarget: SectorPerformanceCloseObservation | undefined;
    if ('reason' in targetSelection) {
      reasons.push(`target-close-${targetSelection.reason}`);
      if ('selected' in targetSelection) selectedTarget = targetSelection.selected;
    } else {
      selectedTarget = targetSelection.selected;
    }

    if (selectedPrevious !== undefined && selectedTarget !== undefined) {
      if (selectedPrevious.currency !== selectedTarget.currency) reasons.push('currency-mismatch');
      if (selectedPrevious.adjustmentVersion !== selectedTarget.adjustmentVersion) {
        reasons.push('adjustment-version-mismatch');
      }
    }

    if (
      reasons.length > 0 ||
      selectedClassification === undefined ||
      selectedPrevious === undefined ||
      selectedTarget === undefined
    ) {
      exclusions.push({
        universeMembershipId: member.universeMembershipId,
        securityId: member.securityId,
        listingId: member.listingId,
        reasons: EXCLUSION_ORDER.filter((reason) => reasons.includes(reason)),
        ...(exclusionClassification === undefined
          ? {}
          : { classification: classificationLineage(exclusionClassification) }),
        ...(selectedPrevious === undefined
          ? {}
          : { previousClose: closeLineage(selectedPrevious) }),
        ...(selectedTarget === undefined ? {} : { targetClose: closeLineage(selectedTarget) }),
      });
      continue;
    }

    const dailyReturn = sectorSimpleReturn({
      targetClose: selectedTarget.splitAdjustedClose,
      previousClose: selectedPrevious.splitAdjustedClose,
    });
    if (!Number.isFinite(dailyReturn)) {
      throw new InputError(
        `${FUNCTION_NAME}: the member return for securityId ${JSON.stringify(
          member.securityId,
        )} is not representable in IEEE-754 double precision; rescale the supplied closes.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: FUNCTION_NAME, securityId: member.securityId },
        },
      );
    }
    const result: SectorPerformanceSnapshotMemberResult = {
      universeMembershipId: member.universeMembershipId,
      securityId: member.securityId,
      listingId: member.listingId,
      dailyReturn,
      classification: assignedClassificationLineage(selectedClassification),
      previousClose: closeLineage(selectedPrevious),
      targetClose: closeLineage(selectedTarget),
    };
    const existing = groups.get(selectedClassification.sectorId);
    if (existing === undefined) {
      groups.set(selectedClassification.sectorId, {
        sectorId: selectedClassification.sectorId,
        sectorName: selectedClassification.sectorName,
        eligibleSecurityCount: 1,
        members: [result],
      });
    } else {
      existing.eligibleSecurityCount += 1;
      existing.members.push(result);
    }
  }

  // Excluded members with an assigned classification still count toward that sector's coverage.
  for (const exclusion of exclusions) {
    if (
      exclusion.reasons.includes('classification-unassigned') ||
      exclusion.classification === undefined ||
      exclusion.classification.sectorId === null ||
      exclusion.classification.sectorName === null
    ) {
      continue;
    }
    const existing = groups.get(exclusion.classification.sectorId);
    if (existing === undefined) {
      groups.set(exclusion.classification.sectorId, {
        sectorId: exclusion.classification.sectorId,
        sectorName: exclusion.classification.sectorName,
        eligibleSecurityCount: 1,
        members: [],
      });
    } else {
      existing.eligibleSecurityCount += 1;
    }
  }

  const sectors: SectorPerformanceSnapshotSectorResult[] = aggregateSectors({
    groups: groups.values(),
    memberReturn: (member) => member.dailyReturn,
  }).map(({ periodReturn, ...sector }) => ({ ...sector, dailyReturn: periodReturn }));

  const reasonCounts = EXCLUSION_ORDER.flatMap((reason): SectorPerformanceReasonCount[] => {
    const count = exclusions.filter((exclusion) => exclusion.reasons.includes(reason)).length;
    return count === 0 ? [] : [{ reason, count }];
  });
  const includedSecurityCount = sectors.reduce(
    (total, sector) => total + sector.includedSecurityCount,
    0,
  );
  const blockers: SectorPerformanceBlocker[] =
    includedSecurityCount === 0 ? ['no-includable-members'] : [];
  const report: SectorPerformanceSnapshotReport = {
    policyVersion: POLICY_VERSION,
    assumptions: ASSUMPTIONS,
    targetSessionDate: validated.targetSessionDate,
    marketCalendarId: validated.marketCalendarId,
    classificationTaxonomy: { ...validated.classificationTaxonomy },
    cutoffs: { ...validated.cutoffs },
    selectedSessions: {
      target: sessionLineage(target),
      previous: sessionLineage(previous),
    },
    sectors,
    exclusions,
    diagnostics: {
      status:
        includedSecurityCount === 0 ? 'empty' : exclusions.length > 0 ? 'partial' : 'complete',
      blockers,
      warnings: sectorWarnings({ blockers, reasons: reasonCounts }),
      inputCounts: inputCounts(validated),
      eligibleSecurityCount: validated.eligibleUniverse.length,
      includedSecurityCount,
      excludedSecurityCount: exclusions.length,
      sectorCount: sectors.length,
      reasonCounts,
    },
  };
  return requireRepresentableResult(FUNCTION_NAME, report);
}
