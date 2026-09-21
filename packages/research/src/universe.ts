/**
 * Point-in-time universe vocabulary (Stage 4.6, FC8 Decision 3) — owned here because research owns
 * universe identity and eligibility; a simulator reads these and never redefines them.
 *
 * - A universe is a HISTORY of membership intervals, not a snapshot: a name is a member from
 *   `fromTimestampMs` (inclusive) until `toTimestampMs` (exclusive). An exit says why, and a
 *   `delisted` exit carries the return a holder earned from the last available price to the exit
 *   so a backtest can book the fact instead of silently surviving it.
 * - Eligibility at an instant is the SAME law screening applies: an observation is visible only
 *   when its `availableTimestampMs` is at or before the decision instant (minus an explicit lag in
 *   trading sessions), and one instrument resolves to its latest available version.
 *
 * Everything is deterministic, clock-free, and JSON-safe; nothing mutates a caller array.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  type EpochMs,
} from '@totalfinance/core';
import {
  type FieldDefinition,
  type UniverseObservation,
  requireBoundaryName,
  requireFieldDefinitions,
  requirePathLabel,
  requireUniverseObservations,
} from './observations.js';
import { resolveLatestAvailableObservations } from './point-in-time.js';

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export type UniverseExitReason = 'removed' | 'delisted' | 'merged' | 'other';

/** One membership interval of one instrument. Half-open: `[fromTimestampMs, toTimestampMs)`. */
export interface UniverseMember {
  instrumentId: string;
  /** First instant the name is a member (inclusive). */
  fromTimestampMs: EpochMs;
  /** First instant it is no longer a member (exclusive); omitted = still a member. */
  toTimestampMs?: EpochMs;
  exitReason?: UniverseExitReason;
  /**
   * The simple return a holder earned from the last available price to the exit — a delisting
   * return (−1 for a total loss). Required by a simulator when `exitReason` is `'delisted'` and a
   * position is open; recorded here so the fact travels with the universe, not the strategy.
   */
  delistingReturn?: number;
}

export interface UniverseHistory {
  universeId: string;
  members: readonly UniverseMember[];
}

const HISTORY_KEYS = ['universeId', 'members'] as const;
const MEMBER_KEYS = [
  'instrumentId',
  'fromTimestampMs',
  'toTimestampMs',
  'exitReason',
  'delistingReturn',
] as const;
const EXIT_REASONS: readonly UniverseExitReason[] = ['removed', 'delisted', 'merged', 'other'];

const EXAMPLE_HISTORY =
  "{ universeId: 'us-large-cap', members: [{ instrumentId: 'AAPL', fromTimestampMs: 1735689600000 }, { instrumentId: 'XYZ', fromTimestampMs: 1735689600000, toTimestampMs: 1751328000000, exitReason: 'delisted', delistingReturn: -0.4 }] }";

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a {@link UniverseHistory} at a public boundary: a closed record whose members are
 * closed records with finite instants, a half-open non-empty interval each, a declared exit
 * reason whenever an exit instant is given, a finite delisting return ≥ −1 only beside an exit,
 * and no two overlapping intervals for one instrument (a name cannot be a member twice at once).
 */
export function requireUniverseHistory(
  functionName: string,
  label: string,
  history: UniverseHistory,
): void {
  requireBoundaryName(functionName);
  requirePathLabel(functionName, 'label', label);
  requireArgumentObject(functionName, label, history);
  ensureKnownKeys(functionName, label, history, HISTORY_KEYS);
  if (typeof history.universeId !== 'string' || history.universeId.length === 0) {
    throw new InputError(
      `${functionName}: ${label}.universeId must be a non-empty string — a universe without an identity is a list without a source.\n  e.g. ${EXAMPLE_HISTORY}`,
      { code: ErrorCode.InputWrongType, context: { field: `${label}.universeId` } },
    );
  }
  if (!Array.isArray(history.members)) {
    throw new InputError(
      `${functionName}: ${label}.members must be an array of membership intervals (it may be empty).\n  e.g. ${EXAMPLE_HISTORY}`,
      { code: ErrorCode.InputWrongType, context: { field: `${label}.members` } },
    );
  }
  const intervals = new Map<string, Array<{ from: number; to: number; path: string }>>();
  history.members.forEach((member, index) => {
    const path = `${label}.members[${index}]`;
    requireArgumentObject(functionName, path, member);
    ensureKnownKeys(functionName, path, member, MEMBER_KEYS);
    if (typeof member.instrumentId !== 'string' || member.instrumentId.length === 0) {
      throw new InputError(`${functionName}: ${path}.instrumentId must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.instrumentId` },
      });
    }
    if (!isEpochMs(member.fromTimestampMs)) {
      throw new InputError(
        `${functionName}: ${path}.fromTimestampMs must be a finite epoch-ms number (the first instant the name is a member).`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.fromTimestampMs` } },
      );
    }
    let to = Number.POSITIVE_INFINITY;
    if (member.toTimestampMs !== undefined) {
      if (!isEpochMs(member.toTimestampMs)) {
        throw new InputError(
          `${functionName}: ${path}.toTimestampMs must be a finite epoch-ms number (the first instant the name is NOT a member) or omitted while it is still a member.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.toTimestampMs` } },
        );
      }
      if (member.toTimestampMs <= member.fromTimestampMs) {
        throw new InputError(
          `${functionName}: ${path}.toTimestampMs (${member.toTimestampMs}) must be after fromTimestampMs (${member.fromTimestampMs}) — the interval is half-open [from, to) and cannot be empty.`,
          { code: ErrorCode.InputOutOfRange, context: { field: `${path}.toTimestampMs` } },
        );
      }
      to = member.toTimestampMs;
    }
    if (member.exitReason !== undefined) {
      if (!EXIT_REASONS.includes(member.exitReason)) {
        throw new InputError(
          `${functionName}: ${path}.exitReason must be one of ${EXIT_REASONS.map((r) => `'${r}'`).join(' | ')}. Received ${JSON.stringify(member.exitReason)}.`,
          { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.exitReason` } },
        );
      }
      if (member.toTimestampMs === undefined) {
        throw new InputError(
          `${functionName}: ${path}.exitReason is given but ${path}.toTimestampMs is not — an exit needs an exit instant.`,
          { code: ErrorCode.InputMissingField, context: { field: `${path}.toTimestampMs` } },
        );
      }
    }
    if (member.delistingReturn !== undefined) {
      if (typeof member.delistingReturn !== 'number' || !Number.isFinite(member.delistingReturn)) {
        throw new InputError(
          `${functionName}: ${path}.delistingReturn must be a finite simple return (−1 is a total loss).`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.delistingReturn` } },
        );
      }
      if (member.delistingReturn < -1) {
        throw new InputError(
          `${functionName}: ${path}.delistingReturn (${member.delistingReturn}) is below −1 — a holder cannot lose more than the position.`,
          { code: ErrorCode.InputOutOfRange, context: { field: `${path}.delistingReturn` } },
        );
      }
      if (member.exitReason !== 'delisted') {
        throw new InputError(
          `${functionName}: ${path}.delistingReturn is given but ${path}.exitReason is ${member.exitReason === undefined ? 'absent' : `'${member.exitReason}'`} — a delisting return describes a 'delisted' exit only.`,
          { code: ErrorCode.InputOutOfRange, context: { field: `${path}.delistingReturn` } },
        );
      }
    }
    const list = intervals.get(member.instrumentId) ?? [];
    for (const other of list) {
      if (member.fromTimestampMs < other.to && other.from < to) {
        throw new InputError(
          `${functionName}: ${path} overlaps ${other.path} for '${member.instrumentId}' — a name cannot be a member of one universe twice at the same instant; split the history into disjoint intervals.`,
          { code: ErrorCode.InputOutOfRange, context: { field: path } },
        );
      }
    }
    list.push({ from: member.fromTimestampMs, to, path });
    intervals.set(member.instrumentId, list);
  });
}

// ---------------------------------------------------------------------------------------------------
// universeMembershipAt
// ---------------------------------------------------------------------------------------------------

export interface UniverseMembershipAtInput {
  universeHistory: UniverseHistory;
  /** The decision instant. */
  asOf: EpochMs;
  /**
   * The previous decision instant. When given, `additions` and `exits` describe what changed in
   * `(previousAsOf, asOf]`; when omitted both are empty and only `instrumentIds` is meaningful.
   */
  previousAsOf?: EpochMs;
}

export interface UniverseExit {
  instrumentId: string;
  exitTimestampMs: EpochMs;
  exitReason: UniverseExitReason | null;
  delistingReturn: number | null;
}

export interface UniverseMembershipAtResult {
  assumptions: {
    universeId: string;
    asOf: EpochMs;
    previousAsOf: EpochMs | null;
    membershipRule: 'fromTimestampMs <= asOf < toTimestampMs';
  };
  diagnostics: {
    warnings: string[];
    memberCount: number;
    additionCount: number;
    exitCount: number;
  };
  /** Members at `asOf`, `instrumentId` ascending. */
  instrumentIds: string[];
  /** Names whose membership began in `(previousAsOf, asOf]`, ascending. */
  additions: string[];
  /** Names whose membership ended in `(previousAsOf, asOf]`, ascending by id then instant. */
  exits: UniverseExit[];
}

const MEMBERSHIP_KEYS = ['universeHistory', 'asOf', 'previousAsOf'] as const;

/**
 * Who is in the universe at an instant, and — against a previous instant — who joined and who
 * left (with the exit reason and any delisting return). The membership rule is the half-open
 * interval; ties are impossible because one instant is either inside an interval or not.
 */
export function universeMembershipAt(input: UniverseMembershipAtInput): UniverseMembershipAtResult {
  const functionName = 'universeMembershipAt';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, MEMBERSHIP_KEYS);
  requireUniverseHistory(functionName, 'input.universeHistory', input.universeHistory);
  if (!isEpochMs(input.asOf)) {
    throw new InputError(`${functionName}: input.asOf must be a finite epoch-ms number.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'asOf' },
    });
  }
  if (input.previousAsOf !== undefined) {
    if (!isEpochMs(input.previousAsOf)) {
      throw new InputError(
        `${functionName}: input.previousAsOf must be a finite epoch-ms number.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: 'previousAsOf' },
        },
      );
    }
    if (input.previousAsOf >= input.asOf) {
      throw new InputError(
        `${functionName}: input.previousAsOf (${input.previousAsOf}) must be before input.asOf (${input.asOf}) — the change window is (previousAsOf, asOf].`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'previousAsOf' } },
      );
    }
  }
  const { asOf } = input;
  const previous = input.previousAsOf;
  const members = new Set<string>();
  const additions = new Set<string>();
  const exits: UniverseExit[] = [];
  for (const member of input.universeHistory.members) {
    const to = member.toTimestampMs ?? Number.POSITIVE_INFINITY;
    if (member.fromTimestampMs <= asOf && asOf < to) members.add(member.instrumentId);
    if (previous !== undefined) {
      if (member.fromTimestampMs > previous && member.fromTimestampMs <= asOf) {
        additions.add(member.instrumentId);
      }
      if (to > previous && to <= asOf) {
        exits.push({
          instrumentId: member.instrumentId,
          exitTimestampMs: to,
          exitReason: member.exitReason ?? null,
          delistingReturn: member.delistingReturn ?? null,
        });
      }
    }
  }
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  exits.sort(
    (a, b) => byId(a.instrumentId, b.instrumentId) || a.exitTimestampMs - b.exitTimestampMs,
  );
  const warnings: string[] = [];
  for (const exit of exits) {
    if (exit.exitReason === 'delisted' && exit.delistingReturn === null) {
      warnings.push(
        `'${exit.instrumentId}' was delisted at ${exit.exitTimestampMs} without a delistingReturn — a simulator holding it must refuse rather than assume the exit value.`,
      );
    }
  }
  return {
    assumptions: {
      universeId: input.universeHistory.universeId,
      asOf,
      previousAsOf: previous ?? null,
      membershipRule: 'fromTimestampMs <= asOf < toTimestampMs',
    },
    diagnostics: {
      warnings,
      memberCount: members.size,
      additionCount: additions.size,
      exitCount: exits.length,
    },
    instrumentIds: [...members].sort(byId),
    additions: [...additions].sort(byId),
    exits,
  };
}

// ---------------------------------------------------------------------------------------------------
// eligibleObservationsAt
// ---------------------------------------------------------------------------------------------------

export interface EligibilityLag {
  /** How many trading sessions before `asOf` the data must have been available. */
  tradingSessions: number;
  /**
   * The session instants the caller's dataset knows, ascending — the lag counts sessions in this
   * index, never calendar days, so a weekend or holiday is not a session.
   */
  sessionTimestamps: readonly EpochMs[];
}

export interface EligibleObservationsAtInput {
  observations: readonly UniverseObservation[];
  fieldDefinitions: readonly FieldDefinition[];
  asOf: EpochMs;
  /** Omitted = no lag: availability at or before `asOf` is enough. */
  lag?: EligibilityLag;
  /** When given, only members of this universe at `asOf` are eligible. */
  universeHistory?: UniverseHistory;
}

export interface EligibleObservationsAtResult {
  assumptions: {
    asOf: EpochMs;
    /** The instant availability is measured against: `asOf`, or the lagged session instant. */
    availabilityCutoffMs: EpochMs;
    lagTradingSessions: number;
    universeId: string | null;
    versionResolution: 'latest available at or before the cutoff per instrument';
  };
  diagnostics: {
    warnings: string[];
    suppliedCount: number;
    eligibleCount: number;
    excludedCount: number;
    exclusionReasons: Record<string, number>;
  };
  /** One observation per eligible instrument, `instrumentId` ascending. */
  observations: UniverseObservation[];
}

const ELIGIBLE_KEYS = [
  'observations',
  'fieldDefinitions',
  'asOf',
  'lag',
  'universeHistory',
] as const;
const LAG_KEYS = ['tradingSessions', 'sessionTimestamps'] as const;
/** The library-wide ceiling on a count that sizes work (the count-safety law). */
const MAXIMUM_LAG_SESSIONS = 100_000;

/**
 * The observations a decision at `asOf` may see: available at or before the cutoff (an explicit
 * session lag moves the cutoff back through the caller's session index), the latest version per
 * instrument, and — when a universe history is given — members at `asOf` only. Shifting a row's
 * `availableTimestampMs` past the cutoff removes it; the acceptance law every FC3 screen already
 * satisfies, exposed for the simulators.
 */
export function eligibleObservationsAt(
  input: EligibleObservationsAtInput,
): EligibleObservationsAtResult {
  const functionName = 'eligibleObservationsAt';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ELIGIBLE_KEYS);
  const definitions = requireFieldDefinitions(functionName, input.fieldDefinitions);
  requireUniverseObservations(functionName, input.observations, definitions);
  if (!isEpochMs(input.asOf)) {
    throw new InputError(`${functionName}: input.asOf must be a finite epoch-ms number.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'asOf' },
    });
  }
  let cutoff = input.asOf;
  let lagSessions = 0;
  if (input.lag !== undefined) {
    requireArgumentObject(functionName, 'input.lag', input.lag);
    ensureKnownKeys(functionName, 'input.lag', input.lag, LAG_KEYS);
    const { tradingSessions, sessionTimestamps } = input.lag;
    if (
      !Number.isSafeInteger(tradingSessions) ||
      tradingSessions < 0 ||
      tradingSessions > MAXIMUM_LAG_SESSIONS
    ) {
      throw new InputError(
        `${functionName}: input.lag.tradingSessions must be an integer in [0, ${MAXIMUM_LAG_SESSIONS}]. Received ${String(tradingSessions)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'lag.tradingSessions' } },
      );
    }
    if (!Array.isArray(sessionTimestamps)) {
      throw new InputError(
        `${functionName}: input.lag.sessionTimestamps must be an ascending array of session instants — a lag counts sessions in the dataset's own index, never calendar days.`,
        { code: ErrorCode.InputWrongType, context: { field: 'lag.sessionTimestamps' } },
      );
    }
    sessionTimestamps.forEach((instant, index) => {
      if (!isEpochMs(instant)) {
        throw new InputError(
          `${functionName}: input.lag.sessionTimestamps[${index}] must be a finite epoch-ms number.`,
          { code: ErrorCode.InputWrongType, context: { field: `lag.sessionTimestamps[${index}]` } },
        );
      }
      if (index > 0 && instant <= (sessionTimestamps[index - 1] as number)) {
        throw new InputError(
          `${functionName}: input.lag.sessionTimestamps must be strictly ascending; [${index}] (${instant}) does not follow [${index - 1}] (${String(sessionTimestamps[index - 1])}).`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { field: `lag.sessionTimestamps[${index}]` },
          },
        );
      }
    });
    lagSessions = tradingSessions;
    if (tradingSessions > 0) {
      // The session at or before asOf, then `tradingSessions` sessions earlier in the index.
      let position = -1;
      for (let i = 0; i < sessionTimestamps.length; i += 1) {
        if ((sessionTimestamps[i] as number) <= input.asOf) position = i;
        else break;
      }
      const lagged = position - tradingSessions;
      if (position < 0 || lagged < 0) {
        throw new InputError(
          `${functionName}: a lag of ${tradingSessions} trading session${tradingSessions === 1 ? '' : 's'} before asOf (${input.asOf}) reaches before the first session in input.lag.sessionTimestamps — extend the session index or lower the lag.`,
          { code: ErrorCode.InputOutOfRange, context: { field: 'lag.tradingSessions' } },
        );
      }
      cutoff = sessionTimestamps[lagged] as number;
    }
  }
  let universeId: string | null = null;
  let members: Set<string> | null = null;
  if (input.universeHistory !== undefined) {
    const membership = universeMembershipAt({
      universeHistory: input.universeHistory,
      asOf: input.asOf,
    });
    universeId = membership.assumptions.universeId;
    members = new Set(membership.instrumentIds);
  }
  const exclusionReasons: Record<string, number> = {};
  const addExclusion = (reason: string): void => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };
  const resolved = resolveLatestAvailableObservations(input.observations, cutoff, addExclusion);
  const eligible =
    members === null
      ? resolved
      : resolved.filter((observation) => {
          const isMember = members.has(observation.instrumentId);
          if (!isMember) addExclusion('not-a-universe-member-at-asOf');
          return isMember;
        });
  const excludedCount = Object.values(exclusionReasons).reduce((sum, count) => sum + count, 0);
  return {
    assumptions: {
      asOf: input.asOf,
      availabilityCutoffMs: cutoff,
      lagTradingSessions: lagSessions,
      universeId,
      versionResolution: 'latest available at or before the cutoff per instrument',
    },
    diagnostics: {
      warnings: [],
      suppliedCount: input.observations.length,
      eligibleCount: eligible.length,
      excludedCount,
      exclusionReasons,
    },
    observations: eligible,
  };
}
