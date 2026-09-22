/** Shared validation for the public technical-analysis snapshot envelope. */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { TechnicalAnalysisSnapshot } from './framework.js';

export const SNAPSHOT_SCHEMA_VERSION = 3;
export const SNAPSHOT_ENVELOPE_KEYS = ['kind', 'schemaVersion', 'state'] as const;

/** `typeof`, plus the distinctions `typeof` refuses to make, phrased inside an error sentence. */
export function describeSnapshotValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `the string "${value}"`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** Validate the schema version independently for callers that only inspect the envelope. */
export function checkTechnicalAnalysisSnapshotVersion(snapshot: TechnicalAnalysisSnapshot): void {
  requireArgumentObject('checkSnapshotVersion', 'snapshot', snapshot);
  const version = snapshot.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new InputError(
      `checkTechnicalAnalysisSnapshotVersion: TechnicalAnalysisSnapshot has an invalid schema version: ${String(snapshot.schemaVersion)}.`,
      {
        code: ErrorCode.SnapshotInvalidVersion,
        context: { version: snapshot.schemaVersion, kind: snapshot.kind },
      },
    );
  }
  if (version > SNAPSHOT_SCHEMA_VERSION) {
    throw new InputError(
      `checkTechnicalAnalysisSnapshotVersion: TechnicalAnalysisSnapshot schema version ${version} is newer than this build supports (${SNAPSHOT_SCHEMA_VERSION}). ` +
        `Upgrade @insiderfinance/totalfinance to restore it.`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { version, supported: SNAPSHOT_SCHEMA_VERSION, kind: snapshot.kind },
      },
    );
  }
  if (version < SNAPSHOT_SCHEMA_VERSION) {
    throw new InputError(
      `checkTechnicalAnalysisSnapshotVersion: TechnicalAnalysisSnapshot schema version ${version} predates the explicit envelope (${SNAPSHOT_SCHEMA_VERSION}). ` +
        `Re-serialize it with this build; pre-1.0 snapshots are not migrated (spec D5).`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { version, supported: SNAPSHOT_SCHEMA_VERSION, kind: snapshot.kind },
      },
    );
  }
}

export interface ValidatedSnapshotEnvelope<Kind extends string> {
  readonly kind: Kind;
  readonly state: Record<string, unknown>;
}

/**
 * Validate the closed envelope, version, identity, and state-object shape without traversing state.
 * Resource preflights use this same door before inspecting array lengths, so canonical envelope
 * errors always outrank lower-level state diagnostics.
 */
export function validateSnapshotEnvelope<Kind extends string>(
  snapshot: TechnicalAnalysisSnapshot,
  expected: Kind | readonly Kind[],
): ValidatedSnapshotEnvelope<Kind> {
  if (
    typeof expected !== 'string' &&
    (!Array.isArray(expected) || expected.some((kind) => typeof kind !== 'string'))
  )
    throw new InputError(
      `readSnapshot: expected must be the indicator kind this restorer produces, or the list of kinds ` +
        `in its family — got ${describeSnapshotValue(expected)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { received: describeSnapshotValue(expected) },
      },
    );
  const accepted: readonly Kind[] = typeof expected === 'string' ? [expected] : expected;
  if (accepted.length === 0)
    throw new InputError(
      `readSnapshot: expected is an empty list, so no snapshot could ever match it. Pass the kind ` +
        `this restorer produces.`,
      { code: ErrorCode.InputOutOfRange, context: { received: 'an empty array' } },
    );
  const label = accepted.length === 1 ? accepted[0]! : accepted.join(' | ');

  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new InputError(
      `${label}: expected a snapshot envelope { kind, schemaVersion, state }, got ${describeSnapshotValue(snapshot)}.`,
      { code: ErrorCode.SnapshotWrongShape, context: { kind: label } },
    );

  if (!Object.prototype.hasOwnProperty.call(snapshot, 'state'))
    throw new InputError(
      `${label}: the snapshot has no \`state\` object — it looks like a pre-envelope (v1) snapshot. ` +
        `Re-serialize it with this build; v1 snapshots are not migrated (spec D5).`,
      { code: ErrorCode.SnapshotWrongShape, context: { kind: label } },
    );

  ensureKnownKeys(label, 'snapshot', snapshot, SNAPSHOT_ENVELOPE_KEYS);
  checkTechnicalAnalysisSnapshotVersion(snapshot);

  if (typeof snapshot.kind !== 'string' || !(accepted as readonly string[]).includes(snapshot.kind))
    throw new InputError(
      `${label}: this snapshot's kind is ${
        typeof snapshot.kind === 'string'
          ? `"${snapshot.kind}"`
          : describeSnapshotValue(snapshot.kind)
      }, not ${accepted.map((kind) => `"${kind}"`).join(' or ')}. Restore it with the indicator that wrote ` +
        `it, or re-serialize from a ${accepted[0]!} stream.`,
      {
        code: ErrorCode.SnapshotKindMismatch,
        context: { expected: accepted, received: snapshot.kind },
      },
    );

  const { state } = snapshot;
  if (state === null || typeof state !== 'object' || Array.isArray(state))
    throw new InputError(
      `${snapshot.kind}: the snapshot's \`state\` must be an object of the indicator's own stream state, got ${describeSnapshotValue(state)}.`,
      {
        code: ErrorCode.SnapshotWrongShape,
        context: { kind: snapshot.kind, received: describeSnapshotValue(state) },
      },
    );

  return { kind: snapshot.kind as Kind, state };
}
