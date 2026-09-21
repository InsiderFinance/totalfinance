/**
 * Structural artifact comparison and replay parity (Stage 4.5 Decisions 6 and 7).
 *
 * Two laws, both bounded and both over CANONICAL forms:
 *
 * - {@link compareAnalysisArtifacts} — two `AnalysisArtifact`s of the same `artifactType`, walked
 *   leaf by leaf: every differing leaf is reported with its path, both values, and (for numbers)
 *   absolute and relative deltas; keys or indices present on one side only are reported as added
 *   or removed paths; nothing is summarized away, and `truncated` says so when the retained
 *   difference list hit its cap. A tolerance is never defaulted — `withinTolerance` is `null`
 *   without an explicit two-sided one (a half-stated or guessed tolerance is an economic
 *   judgment the library will not make).
 * - {@link artifactReplayParity} — the saved result versus a recomputed one, by canonical bytes:
 *   identical hashes or the first differing paths. Parity is exact, not a tolerance, because a
 *   calculation is deterministic given its inputs; a byte difference is a FINDING (a changed
 *   calibrator, a changed dependency, a platform-math difference), never noise to smooth over.
 *
 * Disclosed non-finite leaves compare by their `{ nonFinite }` wrapper — two NaNs are equal,
 * a NaN against a number is a non-numeric difference — so no comparison ever produces a NaN delta.
 *
 * Bounded work (Decision 9): both sides are preflighted with the shared stop-at-limit scanner
 * before any canonical copy or walk allocates, and the retained-difference count is capped.
 */

import { CONVENTIONS_VERSION } from '../assumptions.js';
import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentObject } from '../invariants.js';
import { warning, type QuantWarning, WarningCode } from '../diagnostics.js';
import { canonicalJsonOf } from '../canonical-json.js';
import type { AnalysisArtifact } from './analysis-artifact.js';
import { readAnalysisArtifact } from './analysis-artifact.js';
import { scanCanonicalData } from './canonical-scan.js';
import { contentHash } from './content-hash.js';
import { deepFreeze } from './deep-freeze.js';
import { compareFiniteNumbers } from './numeric-comparison.js';

/** A two-sided tolerance: `|Δ| ≤ absolute + relative · |baseline|`, evaluated exactly on the supplied IEEE values. */
export interface ComparisonTolerance {
  /** Absolute tolerance in the leaf's own unit; `≥ 0`, finite. */
  absolute: number;
  /** Relative tolerance as a fraction of the baseline's magnitude; `≥ 0`, finite. */
  relative: number;
}

/** Work caps for one comparison or parity check. Defaults and hard maxima are Decision 9's. */
export interface ComparisonLimits {
  /** Changed, added and removed differences share one retention cap per walk (default 1,000, maximum 100,000); the rest are counted. */
  maximumDifferences?: number;
  /**
   * Canonical work units each side may cost before the comparison refuses (default and maximum
   * 2,000,000). A leaf costs one unit, so this bounds the leaves walked from above.
   */
  maximumLeaves?: number;
}

/** One differing leaf between the baseline and the candidate. */
export interface ValueDifference {
  /** Dot/bracket path from the compared root, e.g. `parameters.rho` or `perSliceRmse[2].rmse`. */
  path: string;
  baselineValue: unknown;
  candidateValue: unknown;
  /** `candidate − baseline` for two finite numbers; `null` if unavailable or unrepresentable. */
  absoluteDelta: number | null;
  /** `(candidate − baseline) / |baseline|`; `null` at zero or if unavailable/unrepresentable. */
  relativeDelta: number | null;
  /** Under an explicit tolerance: whether this leaf is within it (non-numeric differences never are); `null` without one. */
  withinTolerance: boolean | null;
}

export interface ArtifactComparison {
  artifactType: string;
  /** Same content-hash id — the two artifacts are one artifact. */
  identical: boolean;
  artifactIds: { baseline: string; candidate: string };
  inputs: {
    sameInputsHash: boolean;
    /** `null` when either side carries no snapshot hash. */
    sameSnapshotHash: boolean | null;
    parameterDifferences: ValueDifference[];
  };
  producedBy: {
    sameOperation: boolean;
    libraryVersions: { baseline: string | null; candidate: string | null };
    conventionsVersions: { baseline: string; candidate: string };
  };
  result: {
    differences: ValueDifference[];
    /** Paths present in the candidate only (keys or trailing array indices). */
    addedPaths: string[];
    /** Paths present in the baseline only. */
    removedPaths: string[];
    comparedLeafCount: number;
    /** `true` when more differences existed than `maximumDifferences` retained — never silent. */
    truncated: boolean;
    /** Every difference found, retained or not. */
    differenceCount: number;
  };
  warningCounts: { baseline: number; candidate: number };
  /** Under an explicit tolerance: every result difference within it, no paths added or removed, nothing truncated; `null` without one. */
  withinTolerance: boolean | null;
  assumptions: {
    conventionsVersion: string;
    tolerance: ComparisonTolerance | null;
    limits: { maximumDifferences: number; maximumLeaves: number };
    comparison: string;
  };
  diagnostics: { warnings: QuantWarning[] };
}

export interface ArtifactReplayParity {
  identical: boolean;
  savedHash: string;
  recomputedHash: string;
  differences: ValueDifference[];
  addedPaths: string[];
  removedPaths: string[];
  comparedLeafCount: number;
  truncated: boolean;
  differenceCount: number;
  assumptions: {
    conventionsVersion: string;
    limits: { maximumDifferences: number; maximumLeaves: number };
    comparison: 'canonical JSON bytes';
  };
  diagnostics: { warnings: QuantWarning[] };
}

export const COMPARISON_LIMITS = Object.freeze({
  maximumDifferences: Object.freeze({ default: 1_000, maximum: 100_000 }),
  maximumLeaves: Object.freeze({ default: 2_000_000, maximum: 2_000_000 }),
});

interface ResolvedLimits {
  maximumDifferences: number;
  maximumLeaves: number;
}

function requireLimits(functionName: string, limits: unknown): ResolvedLimits {
  if (limits === undefined) {
    return {
      maximumDifferences: COMPARISON_LIMITS.maximumDifferences.default,
      maximumLeaves: COMPARISON_LIMITS.maximumLeaves.default,
    };
  }
  requireArgumentObject(functionName, 'limits', limits);
  ensureKnownKeys(functionName, 'limits', limits as object, [
    'maximumDifferences',
    'maximumLeaves',
  ]);
  const record = limits as Record<string, unknown>;
  const resolve = (field: 'maximumDifferences' | 'maximumLeaves'): number => {
    const value = record[field];
    const law = COMPARISON_LIMITS[field];
    if (value === undefined) return law.default;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new InputError(
        `${functionName}: limits.${field} must be a positive safe integer (default ${
          law.default
        }, maximum ${law.maximum}). Received ${
          typeof value === 'number' ? value : value === null ? 'null' : typeof value
        }.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `limits.${field}` },
        },
      );
    }
    if (value > law.maximum) {
      throw new InputError(
        `${functionName}: limits.${field} is ${value}, above the hard maximum ${law.maximum} — a caller may lower a limit or opt up to the maximum, never past it.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `limits.${field}`, maximum: law.maximum },
        },
      );
    }
    return value;
  };
  return {
    maximumDifferences: resolve('maximumDifferences'),
    maximumLeaves: resolve('maximumLeaves'),
  };
}

function requireTolerance(functionName: string, tolerance: unknown): ComparisonTolerance | null {
  if (tolerance === undefined) return null;
  requireArgumentObject(functionName, 'tolerance', tolerance);
  ensureKnownKeys(functionName, 'tolerance', tolerance as object, ['absolute', 'relative']);
  const record = tolerance as Record<string, unknown>;
  for (const field of ['absolute', 'relative'] as const) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InputError(
        `${functionName}: tolerance.${field} must be a finite number ≥ 0 — a tolerance is two-sided and explicit ({ absolute, relative }), never defaulted. Received ${
          typeof value === 'number' ? value : value === null ? 'null' : typeof value
        }.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `tolerance.${field}` },
        },
      );
    }
  }
  return { absolute: record['absolute'] as number, relative: record['relative'] as number };
}

/** The canonical TREE of a value: key-sorted, `-0` folded, non-finite numbers as their wrappers. */
function canonicalTree(value: unknown): unknown {
  return JSON.parse(canonicalJsonOf(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface WalkFrame {
  readonly baseline: unknown;
  readonly candidate: unknown;
  readonly path: string;
}

interface WalkResult {
  differences: ValueDifference[];
  addedPaths: string[];
  removedPaths: string[];
  comparedLeafCount: number;
  differenceCount: number;
  truncated: boolean;
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * Bounded, iterative, key-ordered walk over two canonical trees. Objects compare by key set;
 * arrays positionally with trailing extras as added/removed paths; leaves by value. Every
 * difference is COUNTED; only the first `maximumDifferences` are RETAINED.
 */
function walkDifferences(
  baselineTree: unknown,
  candidateTree: unknown,
  tolerance: ComparisonTolerance | null,
  maximumDifferences: number,
): WalkResult {
  const differences: ValueDifference[] = [];
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  let comparedLeafCount = 0;
  let differenceCount = 0;
  const stack: WalkFrame[] = [{ baseline: baselineTree, candidate: candidateTree, path: '' }];

  const record = (difference: ValueDifference): void => {
    differenceCount += 1;
    if (differenceCount <= maximumDifferences) differences.push(difference);
  };
  const recordPath = (paths: string[], path: string): void => {
    differenceCount += 1;
    if (differenceCount <= maximumDifferences) paths.push(path);
  };

  while (stack.length > 0) {
    const { baseline, candidate, path } = stack.pop()!;
    const baselineIsRecord = isRecord(baseline);
    const candidateIsRecord = isRecord(candidate);
    if (baselineIsRecord && candidateIsRecord) {
      const baselineKeys = Object.keys(baseline).sort();
      const candidateKeys = Object.keys(candidate).sort();
      const candidateSet = new Set(candidateKeys);
      const baselineSet = new Set(baselineKeys);
      for (const key of baselineKeys) {
        if (!candidateSet.has(key)) {
          recordPath(removedPaths, joinPath(path, key));
        }
      }
      for (const key of candidateKeys) {
        if (!baselineSet.has(key)) {
          recordPath(addedPaths, joinPath(path, key));
        }
      }
      // Push in reverse so the walk reports differences in key order.
      for (let index = baselineKeys.length - 1; index >= 0; index--) {
        const key = baselineKeys[index]!;
        if (!candidateSet.has(key)) continue;
        stack.push({
          baseline: baseline[key],
          candidate: candidate[key],
          path: joinPath(path, key),
        });
      }
      continue;
    }
    if (Array.isArray(baseline) && Array.isArray(candidate)) {
      const shared = Math.min(baseline.length, candidate.length);
      for (let index = shared; index < baseline.length; index++) {
        recordPath(removedPaths, `${path}[${index}]`);
      }
      for (let index = shared; index < candidate.length; index++) {
        recordPath(addedPaths, `${path}[${index}]`);
      }
      for (let index = shared - 1; index >= 0; index--) {
        stack.push({
          baseline: baseline[index],
          candidate: candidate[index],
          path: `${path}[${index}]`,
        });
      }
      continue;
    }
    // A leaf on at least one side (a container against a leaf is a leaf-level difference).
    comparedLeafCount += 1;
    if (typeof baseline === 'number' && typeof candidate === 'number') {
      if (baseline === candidate) continue;
      const { absoluteDelta, relativeDelta, withinTolerance } = compareFiniteNumbers({
        baseline,
        candidate,
        tolerance,
      });
      record({
        path,
        baselineValue: baseline,
        candidateValue: candidate,
        absoluteDelta,
        relativeDelta,
        withinTolerance,
      });
      continue;
    }
    // Both sides are canonical TREES (sorted keys, wrappers as objects), so JSON.stringify is
    // deterministic here and never re-enters the serializer on a reserved wrapper.
    if (JSON.stringify(baseline) === JSON.stringify(candidate)) continue;
    record({
      path,
      baselineValue: baseline,
      candidateValue: candidate,
      absoluteDelta: null,
      relativeDelta: null,
      withinTolerance: tolerance === null ? null : false,
    });
  }

  return {
    differences,
    addedPaths,
    removedPaths,
    comparedLeafCount,
    differenceCount,
    truncated: differenceCount > maximumDifferences,
  };
}

function preflight(
  functionName: string,
  label: string,
  value: unknown,
  maximumLeaves: number,
): void {
  scanCanonicalData(value, { functionName, label, maximumWorkUnits: maximumLeaves });
}

/**
 * Compare two analysis artifacts of one `artifactType`, leaf by leaf (module header).
 *
 * @example
 * ```ts
 * const comparison = compareAnalysisArtifacts({
 *   baseline: yesterdayArtifact,
 *   candidate: todayArtifact,
 *   tolerance: { absolute: 1e-6, relative: 1e-4 },
 * });
 * comparison.result.differences; // [{ path: 'parameters.rho', baselineValue: -0.31, candidateValue: -0.29, … }]
 * ```
 */
export function compareAnalysisArtifacts(input: {
  baseline: AnalysisArtifact;
  candidate: AnalysisArtifact;
  tolerance?: ComparisonTolerance;
  limits?: ComparisonLimits;
}): ArtifactComparison {
  const functionName = 'compareAnalysisArtifacts';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['baseline', 'candidate', 'tolerance', 'limits']);
  for (const side of ['baseline', 'candidate'] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, side) || input[side] === undefined) {
      throw new InputError(
        `${functionName}: ${side} is required — pass both artifacts, e.g. compareAnalysisArtifacts({ baseline, candidate }).`,
        { code: ErrorCode.InputMissingField, context: { function: functionName, field: side } },
      );
    }
  }
  const limits = requireLimits(functionName, input.limits);
  const tolerance = requireTolerance(functionName, input.tolerance);
  // Barrier A before Gate B: prove and bound both envelopes before the readers copy or hash them.
  preflight(functionName, 'input.baseline', input.baseline, limits.maximumLeaves);
  preflight(functionName, 'input.candidate', input.candidate, limits.maximumLeaves);
  const baseline = readAnalysisArtifact({ artifact: input.baseline }).artifact;
  const candidate = readAnalysisArtifact({ artifact: input.candidate }).artifact;
  if (baseline.artifactType !== candidate.artifactType) {
    throw new InputError(
      `${functionName}: the artifacts have different types — baseline is '${baseline.artifactType}', candidate is '${candidate.artifactType}'. A leaf-by-leaf comparison across result schemas would compare unrelated numbers under shared names; compare two artifacts of one type.`,
      {
        code: ErrorCode.ArtifactTypeMismatch,
        context: {
          function: functionName,
          baseline: baseline.artifactType,
          candidate: candidate.artifactType,
        },
      },
    );
  }
  const warnings: QuantWarning[] = [];
  const baselineSnapshot = baseline.inputs.snapshotHash ?? null;
  const candidateSnapshot = candidate.inputs.snapshotHash ?? null;
  const sameSnapshotHash =
    baselineSnapshot === null || candidateSnapshot === null
      ? null
      : baselineSnapshot === candidateSnapshot;
  if (sameSnapshotHash === false) {
    warnings.push(
      warning(
        WarningCode.ArtifactComparisonDifferentMarket,
        `${functionName}: the two artifacts were computed under different market snapshots (baseline ${baselineSnapshot!.slice(
          0,
          18,
        )}…, candidate ${candidateSnapshot!.slice(
          0,
          18,
        )}…) — the results are still comparable, but the market moved between them.`,
        'warn',
        { baseline: baselineSnapshot, candidate: candidateSnapshot },
      ),
    );
  }
  const baselineLibrary = baseline.producedBy.libraryVersion ?? null;
  const candidateLibrary = candidate.producedBy.libraryVersion ?? null;
  if (
    baselineLibrary !== null &&
    candidateLibrary !== null &&
    baselineLibrary !== candidateLibrary
  ) {
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        `${functionName}: the artifacts were produced by different library versions (baseline ${baselineLibrary}, candidate ${candidateLibrary}) — a difference may be a library change rather than a market or parameter change.`,
        'warn',
        { baseline: baselineLibrary, candidate: candidateLibrary },
      ),
    );
  }
  const parameterWalk = walkDifferences(
    canonicalTree(baseline.inputs.parameters ?? null),
    canonicalTree(candidate.inputs.parameters ?? null),
    tolerance,
    limits.maximumDifferences,
  );
  const resultWalk = walkDifferences(
    canonicalTree(baseline.result),
    canonicalTree(candidate.result),
    tolerance,
    limits.maximumDifferences,
  );
  const withinTolerance =
    tolerance === null
      ? null
      : !resultWalk.truncated &&
        resultWalk.addedPaths.length === 0 &&
        resultWalk.removedPaths.length === 0 &&
        resultWalk.differences.every((difference) => difference.withinTolerance === true);
  const warningsOf = (artifact: AnalysisArtifact): number => {
    const diagnostics = artifact.result['diagnostics'];
    const list = isRecord(diagnostics) ? diagnostics['warnings'] : undefined;
    return Array.isArray(list) ? list.length : 0;
  };
  return deepFreeze({
    artifactType: baseline.artifactType,
    identical: baseline.id === candidate.id,
    artifactIds: { baseline: baseline.id, candidate: candidate.id },
    inputs: {
      sameInputsHash: baseline.inputs.inputsHash === candidate.inputs.inputsHash,
      sameSnapshotHash,
      parameterDifferences: parameterWalk.differences,
    },
    producedBy: {
      sameOperation: baseline.producedBy.operation === candidate.producedBy.operation,
      libraryVersions: { baseline: baselineLibrary, candidate: candidateLibrary },
      conventionsVersions: {
        baseline: baseline.conventionsVersion,
        candidate: candidate.conventionsVersion,
      },
    },
    result: {
      differences: resultWalk.differences,
      addedPaths: resultWalk.addedPaths,
      removedPaths: resultWalk.removedPaths,
      comparedLeafCount: resultWalk.comparedLeafCount,
      truncated: resultWalk.truncated,
      differenceCount: resultWalk.differenceCount,
    },
    warningCounts: { baseline: warningsOf(baseline), candidate: warningsOf(candidate) },
    withinTolerance,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tolerance,
      limits: {
        maximumDifferences: limits.maximumDifferences,
        maximumLeaves: limits.maximumLeaves,
      },
      comparison:
        'canonical forms walked leaf by leaf: objects by key set, arrays positionally (extra trailing elements are added/removed paths), numbers by candidate − baseline with the relative delta over |baseline| (null at a zero baseline), non-finite numbers by their disclosed wrapper; a tolerance holds when |Δ| ≤ absolute + relative · |baseline|.',
    },
    diagnostics: { warnings },
  });
}

/**
 * Byte-exact replay parity between a saved value and its recomputation (Decision 7).
 *
 * @example
 * ```ts
 * const parity = artifactReplayParity({ saved: artifact.result, recomputed: rerun });
 * parity.identical; // true — or the first differing paths with both values
 * ```
 */
export function artifactReplayParity(input: {
  /** The artifact's stored result (or its verbatim `fit` / `run`) — a plain object, never a bare value. */
  saved: Record<string, unknown>;
  /** The value the producing call returned when re-issued from the stored inputs. */
  recomputed: Record<string, unknown>;
  limits?: ComparisonLimits;
}): ArtifactReplayParity {
  const functionName = 'artifactReplayParity';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['saved', 'recomputed', 'limits']);
  for (const side of ['saved', 'recomputed'] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, side) || input[side] === undefined) {
      throw new InputError(
        `${functionName}: ${side} is required — pass the artifact's stored result and the value the producing call returned when re-issued, e.g. artifactReplayParity({ saved: artifact.result, recomputed }).`,
        { code: ErrorCode.InputMissingField, context: { function: functionName, field: side } },
      );
    }
    // A saved result is a Law-2 object (a report, a surface snapshot, curve data) — a bare null or
    // scalar "result" is not a thing the spine ever stored, so it is refused, never hashed.
    requireArgumentObject(functionName, side, input[side]);
  }
  const limits = requireLimits(functionName, input.limits);
  preflight(functionName, 'input.saved', input.saved, limits.maximumLeaves);
  preflight(functionName, 'input.recomputed', input.recomputed, limits.maximumLeaves);
  const savedHash = contentHash(input.saved);
  const recomputedHash = contentHash(input.recomputed);
  const identical = savedHash === recomputedHash;
  const walk = identical
    ? {
        differences: [],
        addedPaths: [],
        removedPaths: [],
        comparedLeafCount: 0,
        differenceCount: 0,
        truncated: false,
      }
    : walkDifferences(
        canonicalTree(input.saved),
        canonicalTree(input.recomputed),
        null,
        limits.maximumDifferences,
      );
  return deepFreeze({
    identical,
    savedHash,
    recomputedHash,
    differences: walk.differences,
    addedPaths: walk.addedPaths,
    removedPaths: walk.removedPaths,
    comparedLeafCount: walk.comparedLeafCount,
    truncated: walk.truncated,
    differenceCount: walk.differenceCount,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      limits: {
        maximumDifferences: limits.maximumDifferences,
        maximumLeaves: limits.maximumLeaves,
      },
      comparison: 'canonical JSON bytes' as const,
    },
    diagnostics: { warnings: [] },
  });
}
