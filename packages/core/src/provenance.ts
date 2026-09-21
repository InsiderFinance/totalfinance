/** Data provenance (spec §7.8). Adapters attach it; compute packages propagate it. */

import type { QuantWarning } from './diagnostics.js';
import { ErrorCode, InputError } from './errors.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from './invariants.js';
import type { EpochMs } from './time.js';

export interface Provenance {
  provider?: string;
  dataset?: string;
  asOf?: EpochMs;
  receivedAt?: EpochMs;
  sourceVersion?: string;
  requestId?: string;
  warnings?: QuantWarning[];
}

/** The declared {@link Provenance} keys — the closed set every accepting boundary validates. */
const PROVENANCE_KEYS = [
  'provider',
  'dataset',
  'asOf',
  'receivedAt',
  'sourceVersion',
  'requestId',
  'warnings',
] as const;

const PROVENANCE_STRING_FIELDS = ['provider', 'dataset', 'sourceVersion', 'requestId'] as const;
const PROVENANCE_INSTANT_FIELDS = ['asOf', 'receivedAt'] as const;
const WARNING_KEYS = ['code', 'message', 'severity', 'context'] as const;
const WARNING_SEVERITIES = ['info', 'warn', 'error'] as const;

function provenanceError(
  functionName: string,
  message: string,
  code: ErrorCode,
  field: string,
): InputError {
  return new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

/**
 * The ONE full validator for a caller-supplied {@link Provenance} record, used by every boundary
 * that accepts one (market snapshots, analysis artifacts, scenario sets — create AND read paths),
 * so all of them refuse the same malformations with the same teaching. It validates exactly the
 * DECLARED shape, closed keys: `provider`/`dataset`/`sourceVersion`/`requestId` strings when
 * present, `asOf`/`receivedAt` finite epoch-ms numbers when present, and `warnings` an array of
 * structured {@link QuantWarning}s ({ code, message, severity, context? }) when present. A
 * `provider: 42` or a bare-string warning is refused here, not preserved into a stored envelope —
 * provenance is outside every content hash, but it is still a PUBLIC payload a consumer reads back.
 * Core-internal on purpose: validation plumbing, not analysis API. Returns the (unchanged) record.
 */
export function requireProvenance(functionName: string, label: string, value: unknown): Provenance {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, PROVENANCE_KEYS as readonly string[]);
  const record = value as Provenance;
  for (const field of PROVENANCE_STRING_FIELDS) {
    const member = record[field];
    if (member !== undefined && typeof member !== 'string') {
      throw provenanceError(
        functionName,
        `${label}.${field} must be a string when present. Received ${member === null ? 'null' : typeof member}.\n  e.g. { provider: 'insiderfinance', dataset: 'eod' }`,
        ErrorCode.InputWrongType,
        `${label}.${field}`,
      );
    }
  }
  for (const field of PROVENANCE_INSTANT_FIELDS) {
    const member = record[field];
    if (member !== undefined && (typeof member !== 'number' || !Number.isFinite(member))) {
      throw provenanceError(
        functionName,
        `${label}.${field} must be finite epoch milliseconds when present. Received ${typeof member === 'number' ? member : member === null ? 'null' : typeof member}.`,
        typeof member === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
        `${label}.${field}`,
      );
    }
  }
  if (record.warnings !== undefined) {
    requireArgumentArray(functionName, `${label}.warnings`, record.warnings);
    for (let i = 0; i < record.warnings.length; i++) {
      const entry = record.warnings[i] as Partial<QuantWarning> | null;
      const path = `${label}.warnings[${i}]`;
      requireArgumentObject(functionName, path, entry);
      ensureKnownKeys(functionName, path, entry as object, WARNING_KEYS as readonly string[]);
      const warning = entry as Partial<QuantWarning>;
      if (typeof warning.code !== 'string' || warning.code.length === 0) {
        throw provenanceError(
          functionName,
          `${path}.code must be a non-empty warning-code string — provenance warnings are structured QuantWarnings ({ code, message, severity }), the same grammar diagnostics carry.`,
          ErrorCode.InputWrongType,
          `${path}.code`,
        );
      }
      if (typeof warning.message !== 'string') {
        throw provenanceError(
          functionName,
          `${path}.message must be a string. Received ${warning.message === null ? 'null' : typeof warning.message}.`,
          ErrorCode.InputWrongType,
          `${path}.message`,
        );
      }
      if (!(WARNING_SEVERITIES as readonly string[]).includes(warning.severity as string)) {
        throw provenanceError(
          functionName,
          `${path}.severity must be one of ${WARNING_SEVERITIES.map((s) => `'${s}'`).join(' | ')}. Received ${JSON.stringify(warning.severity)}.`,
          ErrorCode.InputInvalidEnum,
          `${path}.severity`,
        );
      }
      if (warning.context !== undefined) {
        requireArgumentObject(functionName, `${path}.context`, warning.context);
      }
    }
  }
  return record;
}
