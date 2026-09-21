/** First-touch cardinality checks that run before the shared snapshot decoder reads element zero. */

import { ErrorCode, InputError } from '@totalfinance/core';
import type { TechnicalAnalysisSnapshot } from './framework.js';
import { validateSnapshotEnvelope } from './snapshot-envelope.js';

interface SnapshotArrayCardinality {
  readonly exactLength?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
  readonly maximumLengthField?: string;
  readonly unit: string;
}

/**
 * Refuse an impossible or allocation-sized state array from `.length` alone. Shape/type errors that
 * are not cardinality errors remain the shared reader's responsibility, so this preflight never
 * weakens its envelope diagnostics.
 */
export function requireSnapshotArrayCardinality(
  snapshot: TechnicalAnalysisSnapshot,
  expectedKind: string,
  field: string,
  rule: SnapshotArrayCardinality,
): void {
  // Canonical envelope/version/kind diagnostics must outrank a lower-level cardinality defect. The
  // shared validator deliberately stops before traversing state, so this remains a first-touch guard.
  const { state } = validateSnapshotEnvelope(snapshot, expectedKind);
  const value = state[field];
  if (!Array.isArray(value)) return;
  const length = value.length;

  if (rule.exactLength !== undefined && length !== rule.exactLength) {
    throw new InputError(
      `${expectedKind}: snapshot state ${field} must contain exactly ${rule.exactLength} ${rule.unit}. Received ${length}.`,
      {
        code: ErrorCode.SnapshotWrongShape,
        context: { kind: expectedKind, field, length, expectedLength: rule.exactLength },
      },
    );
  }
  if (rule.minimumLength !== undefined && length < rule.minimumLength) {
    throw new InputError(
      `${expectedKind}: snapshot state ${field} must contain at least ${rule.minimumLength} ${rule.unit}. Received ${length}.`,
      {
        code: ErrorCode.SnapshotWrongShape,
        context: { kind: expectedKind, field, length, minimumLength: rule.minimumLength },
      },
    );
  }
  if (rule.maximumLength !== undefined && length > rule.maximumLength) {
    throw new InputError(
      `${expectedKind}: snapshot state ${field} must contain at most ${rule.maximumLength.toLocaleString('en-US')} ${rule.unit}. Received ${length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { kind: expectedKind, field, length, maximumLength: rule.maximumLength },
      },
    );
  }

  if (rule.maximumLengthField !== undefined) {
    const maximum = state[rule.maximumLengthField];
    if (
      typeof maximum === 'number' &&
      Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      length > maximum
    ) {
      throw new InputError(
        `${expectedKind}: snapshot state ${field} has length ${length}, which exceeds its ${rule.maximumLengthField} ${maximum}. Re-serialize the stream instead of restoring impossible rolling-window state.`,
        {
          code: ErrorCode.SnapshotWrongShape,
          context: {
            kind: expectedKind,
            field,
            length,
            [rule.maximumLengthField]: maximum,
          },
        },
      );
    }
  }
}
