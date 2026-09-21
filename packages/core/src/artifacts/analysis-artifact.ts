/**
 * The saved analysis artifact (Gate B / roadmap Program 11): how a computed result becomes a
 * DURABLE record with identity, inputs, and lineage — without a god client and without changing
 * what any compute function returns.
 *
 * The grammar:
 *
 * - **`result` is the producing call's return value, verbatim.** Law 2 makes every analysis
 *   result carry `assumptions` (a plain object) and `diagnostics.warnings` (an array) — that TRUE
 *   floor is what the artifact requires, and nothing more: many real reports (DCF, event study,
 *   time-weighted return) state their assumptions without an `assumptions.conventionsVersion`
 *   field, and when one IS present it simply rides along verbatim inside `result`. Saving never
 *   rewrites the result — replay compares saved-vs-recomputed results byte-for-byte, which only
 *   works if saving is the identity on them.
 * - **the top-level `conventionsVersion` is LIBRARY-STAMPED at creation** from core's
 *   `CONVENTIONS_VERSION` — exactly the market snapshot's law, never an echo of the result: it
 *   states which TotalFinance conventions the artifact was WRITTEN under, so it is not caller-set.
 *   A stored artifact's stamp is validated as a non-empty string and is covered by the id.
 * - **`id` is the content hash of the body** — everything except `id` itself and `provenance`.
 *   Same operation + same inputs + same result → same id, whatever key order the caller built
 *   objects in; any covered change → a new id. `readAnalysisArtifact` recomputes it and refuses a
 *   mismatch: an artifact that fails its own hash was edited after creation, and its lineage
 *   cannot be trusted.
 * - **`inputs` carries identity, not bulk**: the snapshot travels as its content hash (from
 *   `marketSnapshotContentHash`), parameters embed only when small, and large outputs hang off
 *   named {@link TableHandle} references. `inputs.inputsHash` is stamped from
 *   `{ snapshotHash, parameters }` and RE-VERIFIED against those stored fields on every
 *   validation pass — a forged inputsHash is refused even inside an outer-consistent envelope.
 * - **`createdFrom`** lists parent artifact ids, so derivation chains (chain → surface → exposure)
 *   are walkable without a database — the spine stays storage-agnostic.
 *
 * Non-finite values inside a RESULT are legal exactly where the producing call's own laws made
 * them legal (disclosed warmup NaN, documented kernel IEEE behavior). The canonical serializer
 * carries them through JSON with the library's `{ nonFinite }` wrapper, so a stored artifact
 * round-trips losslessly — `JSON.stringify` alone would have written `null` and destroyed the
 * disclosure.
 */

import { CONVENTIONS_VERSION } from '../assumptions.js';
import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from '../invariants.js';
import type { Provenance } from '../provenance.js';
import { requireProvenance } from '../provenance.js';
import { canonicalJsonOf, fromCanonicalJson } from '../canonical-json.js';
import { contentHash, isContentHashString } from './content-hash.js';
import { deepFreeze } from './deep-freeze.js';
import type { AppliedMigration, ArtifactMigrationRegistry } from './migration.js';
import { createArtifactMigrationRegistry } from './migration.js';
import type { TableHandle } from './table-handle.js';
import { requireTableHandle } from './table-handle.js';

export const ANALYSIS_ARTIFACT_KIND = 'totalfinance.analysis-artifact';

/** Current artifact schema version — same bump-with-migration policy as the market snapshot. */
export const ANALYSIS_ARTIFACT_SCHEMA_VERSION = 1;

/** What produced the result — the call a replay re-issues. */
export interface ArtifactProducedBy {
  /** The public operation name, e.g. `'analyzeChain'` or `'options.blackScholes.explain'`. */
  operation: string;
  /** The TotalFinance version that produced it, when the caller knows it (e.g. from package.json). */
  libraryVersion?: string;
}

/** Input identity for replay: hashes for bulk, embedded values only for small parameters. */
export interface ArtifactInputs {
  /**
   * Hash of everything replay needs: `{ snapshotHash, parameters }` — stamped, not caller-set,
   * and RECOMPUTED from the stored fields on every validation pass (create and read), so a
   * tampered hash or tampered inputs are refused even when the outer id was re-minted to match.
   */
  inputsHash: string;
  /** `marketSnapshotContentHash(...)` of the snapshot the analysis read, when one was used. */
  snapshotHash?: string;
  /** The small, JSON-safe call parameters, embedded verbatim. Reference big inputs via tables. */
  parameters?: unknown;
}

export interface AnalysisArtifact {
  kind: typeof ANALYSIS_ARTIFACT_KIND;
  schemaVersion: number;
  /** Content hash of the body (everything but `id` and `provenance`) — stamped at creation. */
  id: string;
  /** Dot-namespaced artifact type, e.g. `'options.chain-analysis'` — names the result schema. */
  artifactType: string;
  producedBy: ArtifactProducedBy;
  /**
   * The library conventions revision the artifact was CREATED under — stamped from core's
   * `CONVENTIONS_VERSION` (the market snapshot's law, one law), never an echo of the result and
   * never caller-set. Covered by the id; validated as a non-empty string on read.
   */
  conventionsVersion: string;
  inputs: ArtifactInputs;
  /** Parent artifact ids this one was derived from, oldest first. */
  createdFrom?: string[];
  /** The producing call's return value, verbatim: `{ …, assumptions, diagnostics }`. */
  result: Record<string, unknown>;
  /** Named large-table references — rows live where storage puts them, identity lives here. */
  tables?: Record<string, TableHandle>;
  /** Data lineage, caller-supplied, outside the id (labels are not identity). */
  provenance?: Provenance;
}

const ENVELOPE_KEYS = [
  'kind',
  'schemaVersion',
  'id',
  'artifactType',
  'producedBy',
  'conventionsVersion',
  'inputs',
  'createdFrom',
  'result',
  'tables',
  'provenance',
];

const EXAMPLE_CALL =
  "createAnalysisArtifact({ artifactType: 'options.chain-analysis', producedBy: { operation: 'analyzeChain' }, " +
  'inputs: { snapshotHash, parameters: { minOpenInterest: 100 } }, result })';

function artifactError(
  message: string,
  code: ErrorCode,
  context: Record<string, unknown>,
): InputError {
  return new InputError(message, { code, context });
}

function requireNonEmptyString(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw artifactError(
      `${functionName}: ${field} must be a non-empty string. Received ${typeof value === 'string' ? "''" : value === null ? 'null' : typeof value}.\n  e.g. ${EXAMPLE_CALL}`,
      ErrorCode.InputWrongType,
      { function: functionName, field },
    );
  }
  return value;
}

/**
 * The TRUE Law-2 floor a result must meet to be SAVED: `assumptions` is a plain object and
 * `diagnostics.warnings` is an array. Both the `{ value, assumptions, diagnostics }` envelope and
 * the report grammar (fields + `assumptions` + `diagnostics` inline) satisfy this — including real
 * reports whose assumptions carry no `conventionsVersion` field (DCF, event study, time-weighted
 * return); when the result DOES carry `assumptions.conventionsVersion` it rides along verbatim.
 * A bare number does not qualify — wrap it in the producing call's `.explain()` envelope, which is
 * where its assumptions live. (The artifact's own top-level `conventionsVersion` is library-stamped
 * at creation, never derived from here.)
 */
function requireReportShape(functionName: string, result: unknown): void {
  requireArgumentObject(functionName, 'result', result);
  const record = result as Record<string, unknown>;
  const assumptions = record['assumptions'];
  if (assumptions === undefined) {
    throw artifactError(
      `${functionName}: result.assumptions is missing — a saved artifact preserves the assumptions its numbers were computed under (Law 2's floor). Save the producing call's OWN return value; for a plain-value facade, save the .explain() result instead.`,
      ErrorCode.InputMissingField,
      { field: 'result.assumptions' },
    );
  }
  if (assumptions === null || typeof assumptions !== 'object' || Array.isArray(assumptions)) {
    throw artifactError(
      `${functionName}: result.assumptions must be a plain object of disclosed assumptions. Received ${assumptions === null ? 'null' : Array.isArray(assumptions) ? 'array' : typeof assumptions}.`,
      ErrorCode.InputWrongType,
      { field: 'result.assumptions' },
    );
  }
  const diagnostics = record['diagnostics'];
  const warnings =
    diagnostics !== null && typeof diagnostics === 'object'
      ? (diagnostics as Record<string, unknown>)['warnings']
      : undefined;
  if (!Array.isArray(warnings)) {
    throw artifactError(
      `${functionName}: result.diagnostics.warnings is missing — a saved artifact keeps its warnings channel (empty is fine, absent is not).`,
      ErrorCode.InputMissingField,
      { field: 'result.diagnostics.warnings' },
    );
  }
}

function validateArtifactBody(functionName: string, body: Omit<AnalysisArtifact, 'id'>): void {
  requireNonEmptyString(functionName, 'artifactType', body.artifactType);
  requireArgumentObject(functionName, 'producedBy', body.producedBy);
  ensureKnownKeys(functionName, 'producedBy', body.producedBy, ['operation', 'libraryVersion']);
  requireNonEmptyString(functionName, 'producedBy.operation', body.producedBy.operation);
  if (
    body.producedBy.libraryVersion !== undefined &&
    typeof body.producedBy.libraryVersion !== 'string'
  ) {
    throw artifactError(
      `${functionName}: producedBy.libraryVersion must be a version string when present.`,
      ErrorCode.InputWrongType,
      { field: 'producedBy.libraryVersion' },
    );
  }
  requireArgumentObject(functionName, 'inputs', body.inputs);
  ensureKnownKeys(functionName, 'inputs', body.inputs, [
    'inputsHash',
    'snapshotHash',
    'parameters',
  ]);
  if (!isContentHashString(body.inputs.inputsHash)) {
    throw artifactError(
      `${functionName}: inputs.inputsHash must be a 'sha256:<64 hex>' string (createAnalysisArtifact stamps it from { snapshotHash, parameters }).`,
      ErrorCode.InputWrongType,
      { field: 'inputs.inputsHash' },
    );
  }
  if (body.inputs.snapshotHash !== undefined && !isContentHashString(body.inputs.snapshotHash)) {
    throw artifactError(
      `${functionName}: inputs.snapshotHash must be a 'sha256:<64 hex>' string — use marketSnapshotContentHash(snapshot).`,
      ErrorCode.InputWrongType,
      { field: 'inputs.snapshotHash' },
    );
  }
  // inputsHash is DERIVED, so it is re-derived: recompute from the stored { snapshotHash,
  // parameters } and refuse a mismatch. Creation stamps through this same recipe (always
  // consistent there); on read this catches a forged inputs section even when the outer id was
  // re-minted over the forged bytes — the outer hash proves the envelope is self-consistent, only
  // this check proves the inputs identity actually names the stored inputs.
  const recomputedInputsHash = contentHash({
    ...(body.inputs.snapshotHash !== undefined ? { snapshotHash: body.inputs.snapshotHash } : {}),
    ...(body.inputs.parameters !== undefined ? { parameters: body.inputs.parameters } : {}),
  });
  if (body.inputs.inputsHash !== recomputedInputsHash) {
    throw artifactError(
      `${functionName}: inputs.inputsHash does not match the stored inputs (stored ${body.inputs.inputsHash.slice(0, 18)}…, recomputed ${recomputedInputsHash.slice(0, 18)}… from { snapshotHash, parameters }) — the inputs identity was edited after stamping, so replay could not trust it. Rebuild the artifact with createAnalysisArtifact({ …, inputs: { snapshotHash, parameters } }), which stamps the hash.`,
      ErrorCode.ArtifactIdMismatch,
      {
        field: 'inputs.inputsHash',
        stored: body.inputs.inputsHash,
        recomputed: recomputedInputsHash,
      },
    );
  }
  if (body.createdFrom !== undefined) {
    requireArgumentArray(functionName, 'createdFrom', body.createdFrom);
    for (let i = 0; i < body.createdFrom.length; i++) {
      if (!isContentHashString(body.createdFrom[i])) {
        throw artifactError(
          `${functionName}: createdFrom[${i}] must be a parent artifact id ('sha256:<64 hex>'). Received ${JSON.stringify(body.createdFrom[i])}.`,
          ErrorCode.InputWrongType,
          { field: `createdFrom[${i}]` },
        );
      }
    }
  }
  requireReportShape(functionName, body.result);
  if (typeof body.conventionsVersion !== 'string' || body.conventionsVersion.length === 0) {
    throw artifactError(
      `${functionName}: conventionsVersion must be a non-empty string — createAnalysisArtifact stamps it from the library's CONVENTIONS_VERSION (currently '${CONVENTIONS_VERSION}'), so a stored artifact always states which TotalFinance conventions it was written under.`,
      ErrorCode.InputWrongType,
      { field: 'conventionsVersion' },
    );
  }
  if (body.tables !== undefined) {
    requireArgumentObject(functionName, 'tables', body.tables);
    for (const [name, handle] of Object.entries(body.tables)) {
      requireTableHandle(functionName, `tables.${name}`, handle);
    }
  }
  if (body.provenance !== undefined) {
    // The ONE shared provenance validator — closed keys, fully typed fields — so an artifact
    // refuses `provenance: { provider: 42 }` exactly as a snapshot or scenario set refuses it.
    requireProvenance(functionName, 'provenance', body.provenance);
  }
}

/** The hashed body: every field except `id` (which IS the hash) and `provenance` (labels ≠ identity). */
function coveredBody(artifact: Omit<AnalysisArtifact, 'id'>): Record<string, unknown> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    artifactType: artifact.artifactType,
    producedBy: artifact.producedBy,
    conventionsVersion: artifact.conventionsVersion,
    inputs: artifact.inputs,
    ...(artifact.createdFrom !== undefined ? { createdFrom: artifact.createdFrom } : {}),
    result: artifact.result,
    ...(artifact.tables !== undefined ? { tables: artifact.tables } : {}),
  };
}

/**
 * Save a computed result as an identified, immutable artifact.
 *
 * @example
 * ```ts
 * import { createAnalysisArtifact, marketSnapshotContentHash } from '@totalfinance/core/artifacts';
 *
 * const report = impliedVolatilitySurface({ ... });        // any Law-2 result, verbatim
 * const artifact = createAnalysisArtifact({
 *   artifactType: 'volatility.surface',
 *   producedBy: { operation: 'impliedVolatilitySurface', libraryVersion: '0.0.1' },
 *   inputs: { snapshotHash: marketSnapshotContentHash(snapshot), parameters: { model: 'svi' } },
 *   result: report,
 * });
 * artifact.id; // 'sha256:…' — recomputable from the body forever
 * ```
 */
export function createAnalysisArtifact(input: {
  artifactType: string;
  producedBy: ArtifactProducedBy;
  inputs?: { snapshotHash?: string; parameters?: unknown };
  createdFrom?: string[];
  result: Record<string, unknown>;
  tables?: Record<string, TableHandle>;
  provenance?: Provenance;
}): AnalysisArtifact {
  requireArgumentObject('createAnalysisArtifact', 'input', input);
  ensureKnownKeys('createAnalysisArtifact', 'input', input, [
    'artifactType',
    'producedBy',
    'inputs',
    'createdFrom',
    'result',
    'tables',
    'provenance',
  ]);
  // C06: null is NOT omission — `inputs: null` must teach, never coalesce into "no inputs".
  if (input.inputs !== undefined) {
    requireArgumentObject('createAnalysisArtifact', 'inputs', input.inputs);
    ensureKnownKeys('createAnalysisArtifact', 'inputs', input.inputs, [
      'snapshotHash',
      'parameters',
    ]);
    if (input.inputs.parameters === null) {
      throw artifactError(
        `createAnalysisArtifact: inputs.parameters is null — omit the key for a parameterless call; null would hash as a real value and mint a DIFFERENT artifact id than omission.\n  e.g. ${EXAMPLE_CALL}`,
        ErrorCode.InputWrongType,
        { field: 'inputs.parameters' },
      );
    }
  }
  const suppliedInputs = input.inputs ?? {};
  const inputsHash = contentHash({
    ...(suppliedInputs.snapshotHash !== undefined
      ? { snapshotHash: suppliedInputs.snapshotHash }
      : {}),
    ...(suppliedInputs.parameters !== undefined ? { parameters: suppliedInputs.parameters } : {}),
  });
  requireReportShape('createAnalysisArtifact', input.result);
  const body: Omit<AnalysisArtifact, 'id'> = {
    kind: ANALYSIS_ARTIFACT_KIND,
    schemaVersion: ANALYSIS_ARTIFACT_SCHEMA_VERSION,
    artifactType: input.artifactType,
    producedBy: input.producedBy,
    // Library-stamped, exactly like the market snapshot: the artifact states which TotalFinance
    // conventions it was WRITTEN under. Never an echo of the result (whose own laws may or may
    // not carry an assumptions.conventionsVersion) and never caller-set.
    conventionsVersion: CONVENTIONS_VERSION,
    inputs: {
      inputsHash,
      ...(suppliedInputs.snapshotHash !== undefined
        ? { snapshotHash: suppliedInputs.snapshotHash }
        : {}),
      ...(suppliedInputs.parameters !== undefined ? { parameters: suppliedInputs.parameters } : {}),
    },
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
    result: input.result,
    ...(input.tables !== undefined ? { tables: input.tables } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };
  validateArtifactBody('createAnalysisArtifact', body);
  const id = contentHash(coveredBody(body));
  const envelope: AnalysisArtifact = { ...body, id };
  return deepFreeze(fromCanonicalJson(canonicalJsonOf(envelope)) as AnalysisArtifact);
}

/**
 * Validate a CURRENT-version artifact envelope in FULL — closed key set, kind, exact schema
 * version, a well-formed `id` string, and the whole body (report shape, hash-string formats, the
 * re-derived `inputs.inputsHash`, table handles, provenance) — WITHOUT recomputing the outer
 * content hash. This is the read door's validation extracted into a callable that neither migrates
 * nor id-verifies, shared by `readAnalysisArtifact` (which then DOES verify the id) and the public
 * {@link isAnalysisArtifact} guard (whose contract is that it does not), so the two doors apply
 * one body law.
 */
function requireCurrentArtifactEnvelope(
  functionName: string,
  candidate: Record<string, unknown>,
): AnalysisArtifact {
  ensureKnownKeys(functionName, 'artifact', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== ANALYSIS_ARTIFACT_KIND) {
    throw artifactError(
      `${functionName}: artifact.kind is ${JSON.stringify(candidate['kind'])}, not '${ANALYSIS_ARTIFACT_KIND}'.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  if (candidate['schemaVersion'] !== ANALYSIS_ARTIFACT_SCHEMA_VERSION) {
    throw artifactError(
      `${functionName}: artifact.schemaVersion is ${String(candidate['schemaVersion'])}, not the current ${ANALYSIS_ARTIFACT_SCHEMA_VERSION} — older versions load only through readAnalysisArtifact's explicit migrations.`,
      ErrorCode.SnapshotInvalidVersion,
      { version: candidate['schemaVersion'] },
    );
  }
  const id = candidate['id'];
  if (!isContentHashString(id)) {
    throw artifactError(
      `${functionName}: artifact.id must be a 'sha256:<64 hex>' string. Received ${JSON.stringify(id)}.`,
      ErrorCode.InputWrongType,
      { field: 'id' },
    );
  }
  const body: Omit<AnalysisArtifact, 'id'> = {
    kind: ANALYSIS_ARTIFACT_KIND,
    schemaVersion: ANALYSIS_ARTIFACT_SCHEMA_VERSION,
    artifactType: candidate['artifactType'] as string,
    producedBy: candidate['producedBy'] as ArtifactProducedBy,
    conventionsVersion: candidate['conventionsVersion'] as string,
    inputs: candidate['inputs'] as ArtifactInputs,
    ...(candidate['createdFrom'] !== undefined
      ? { createdFrom: candidate['createdFrom'] as string[] }
      : {}),
    result: candidate['result'] as Record<string, unknown>,
    ...(candidate['tables'] !== undefined
      ? { tables: candidate['tables'] as Record<string, TableHandle> }
      : {}),
    ...(candidate['provenance'] !== undefined
      ? { provenance: candidate['provenance'] as Provenance }
      : {}),
  };
  validateArtifactBody(functionName, body);
  return { ...body, id: id as string };
}

/**
 * Sound structural test for a CURRENT-version analysis-artifact envelope: the complete read-door
 * body validation behind a boolean door — closed keys, report shape, re-derived `inputs.inputsHash`,
 * table handles, provenance, all of it. Does NOT verify the id (its one documented omission,
 * unchanged): `true` means the envelope is well-formed, and `readAnalysisArtifact` proves the id
 * on top. (An earlier version sniffed five fields, so `{ …, inputs: undefined }` passed as
 * `AnalysisArtifact` and detonated at first use.) Full-walk, not constant-time.
 */
export function isAnalysisArtifact(value: unknown): value is AnalysisArtifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    requireCurrentArtifactEnvelope('isAnalysisArtifact', value as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a stored artifact: envelope validation, explicit migration, full body re-validation —
 * and TWO hash verifications. `inputs.inputsHash` is recomputed from the stored
 * `{ snapshotHash, parameters }` (via the body validator), and the recomputed content hash must
 * equal the stored `id`; either mismatch means the artifact was edited after creation, and it is
 * refused rather than trusted.
 */
export function readAnalysisArtifact(input: {
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
}): { artifact: AnalysisArtifact; migrationsApplied: AppliedMigration[] } {
  requireArgumentObject('readAnalysisArtifact', 'input', input);
  ensureKnownKeys('readAnalysisArtifact', 'input', input, ['artifact', 'migrations']);
  const raw = input.artifact;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw artifactError(
      `readAnalysisArtifact: artifact must be an AnalysisArtifact envelope object. Received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
      ErrorCode.SnapshotWrongShape,
      { received: raw === null ? 'null' : typeof raw },
    );
  }
  const candidate = raw as Record<string, unknown>;
  ensureKnownKeys('readAnalysisArtifact', 'artifact', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== ANALYSIS_ARTIFACT_KIND) {
    throw artifactError(
      `readAnalysisArtifact: artifact.kind is ${JSON.stringify(candidate['kind'])}, not '${ANALYSIS_ARTIFACT_KIND}' — this reader restores analysis artifacts only.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  const version = candidate['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw artifactError(
      `readAnalysisArtifact: artifact has an invalid schema version: ${String(version)}.`,
      ErrorCode.SnapshotInvalidVersion,
      { version },
    );
  }
  if (version > ANALYSIS_ARTIFACT_SCHEMA_VERSION) {
    throw artifactError(
      `readAnalysisArtifact: artifact schema version ${version} is newer than this build supports (${ANALYSIS_ARTIFACT_SCHEMA_VERSION}). Upgrade @totalfinance/core to restore it.`,
      ErrorCode.SnapshotUnsupportedVersion,
      { version, supported: ANALYSIS_ARTIFACT_SCHEMA_VERSION },
    );
  }
  let envelope = candidate;
  let migrationsApplied: AppliedMigration[] = [];
  if (version < ANALYSIS_ARTIFACT_SCHEMA_VERSION) {
    const registry = input.migrations ?? createArtifactMigrationRegistry();
    ({ envelope, migrationsApplied } = registry.upgrade({
      envelope,
      targetVersion: ANALYSIS_ARTIFACT_SCHEMA_VERSION,
    }));
  }
  // The shared current-version validator (one body law with isAnalysisArtifact) — then the read
  // door's OWN extra proof: the stored id must equal the content hash of the validated body.
  const validated = requireCurrentArtifactEnvelope('readAnalysisArtifact', envelope);
  const recomputed = contentHash(coveredBody(validated));
  if (recomputed !== validated.id) {
    throw artifactError(
      `readAnalysisArtifact: artifact.id does not match its content (stored ${validated.id.slice(0, 18)}…, recomputed ${recomputed.slice(0, 18)}…) — the artifact was edited after creation, so its lineage cannot be trusted. If the change is intentional, create a NEW artifact with createdFrom: [oldId].`,
      ErrorCode.ArtifactIdMismatch,
      { stored: validated.id, recomputed },
    );
  }
  const restored = deepFreeze(fromCanonicalJson(canonicalJsonOf(validated)) as AnalysisArtifact);
  return { artifact: restored, migrationsApplied };
}
