/**
 * FC3 — cross-sectional style factors. Every operation works over the ONE factor-vector shape
 * (instrument, value-or-null), states its method explicitly, and reports coverage — a factor
 * whose missing half is invisible is a backtest artifact waiting to be discovered. Recipes are
 * versioned ARTIFACTS that disclose everything they do; TotalFinance ships canonical recipes without
 * implying any definition is universal truth.
 */

import {
  requireRepresentableResult,
  stableSum,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { correlation, luDecompose, luSolve } from '@totalfinance/math';

// ---------------------------------------------------------------------------------------------------
// The factor vector
// ---------------------------------------------------------------------------------------------------

/** One instrument's factor value at a cross-section; `null` = the source had no value. */
export interface FactorEntry {
  instrumentId: string;
  value: number | null;
}

/** Coverage of a factor vector: what fraction of entries carry a value. */
export interface FactorCoverage {
  entryCount: number;
  valuedCount: number;
  coverageFraction: number;
}

function requireFactorEntries(
  functionName: string,
  label: string,
  entries: readonly FactorEntry[],
): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new InputError(
      `${functionName}: ${label} must be a non-empty array of { instrumentId, value } entries (value null where the source had none).`,
      { code: ErrorCode.InputOutOfRange, context: { field: label } },
    );
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const path = `${label}[${index}]`;
    requireArgumentObject(functionName, path, entry);
    ensureKnownKeys(functionName, path, entry, ['instrumentId', 'value']);
    if (typeof entry.instrumentId !== 'string' || entry.instrumentId.length === 0) {
      throw new InputError(`${functionName}: ${path}.instrumentId must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.instrumentId` },
      });
    }
    if (
      entry.value !== null &&
      (typeof entry.value !== 'number' || !Number.isFinite(entry.value))
    ) {
      throw new InputError(
        `${functionName}: ${path}.value must be a finite number or null (null means missing; it is never coalesced). Received ${typeof entry.value === 'number' ? String(entry.value) : typeof entry.value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.value` } },
      );
    }
    if (seen.has(entry.instrumentId)) {
      throw new InputError(
        `${functionName}: ${path} repeats instrument '${entry.instrumentId}' — one entry per instrument per cross-section.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.instrumentId` } },
      );
    }
    seen.add(entry.instrumentId);
  });
}

function coverageOf(entries: readonly FactorEntry[]): FactorCoverage {
  const valuedCount = entries.filter((entry) => entry.value !== null).length;
  return {
    entryCount: entries.length,
    valuedCount,
    coverageFraction: entries.length === 0 ? 0 : valuedCount / entries.length,
  };
}

/**
 * The minimum-coverage law shared by every factor analysis: below the stated fraction the
 * cross-section is refused (a factor computed over a sliver quietly measures the sliver).
 */
function requireCoverage(
  functionName: string,
  coverage: FactorCoverage,
  minimumCoverageFraction: number | undefined,
): number {
  const minimum = minimumCoverageFraction ?? 0.5;
  if (
    minimumCoverageFraction !== undefined &&
    (typeof minimumCoverageFraction !== 'number' ||
      !Number.isFinite(minimumCoverageFraction) ||
      minimumCoverageFraction < 0 ||
      minimumCoverageFraction > 1)
  ) {
    throw new InputError(
      `${functionName}: minimumCoverageFraction must be a fraction in [0, 1] when provided. Received ${minimumCoverageFraction === null ? 'null' : String(minimumCoverageFraction)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'minimumCoverageFraction' } },
    );
  }
  if (coverage.coverageFraction < minimum) {
    throw new InputError(
      `${functionName}: coverage ${coverage.valuedCount}/${coverage.entryCount} (${(coverage.coverageFraction * 100).toFixed(1)}%) is below the minimum ${(minimum * 100).toFixed(1)}% — a factor computed over a sliver measures the sliver. Lower minimumCoverageFraction explicitly to proceed anyway.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'entries' } },
    );
  }
  return minimum;
}

// ---------------------------------------------------------------------------------------------------
// Winsorization
// ---------------------------------------------------------------------------------------------------

/** The explicit winsorization method — cutoffs are stated, never implied. */
export type WinsorizationMethod =
  | { type: 'percentile'; lowerPercentile: number; upperPercentile: number }
  | { type: 'standard-deviations'; multiplier: number };

/** Input for {@link winsorizeFactor}. */
export interface WinsorizeFactorInput {
  entries: readonly FactorEntry[];
  method: WinsorizationMethod;
  minimumCoverageFraction?: number;
}

/** Result of {@link winsorizeFactor}. */
export interface WinsorizeFactorResult {
  assumptions: {
    method: WinsorizationMethod;
    minimumCoverageFraction: number;
    /** The realized clip bounds, so the transform is reproducible without the input. */
    lowerBound: number;
    upperBound: number;
  };
  diagnostics: {
    warnings: string[];
    coverage: FactorCoverage;
    clippedLowerCount: number;
    clippedUpperCount: number;
  };
  entries: FactorEntry[];
}

/**
 * Winsorize a factor vector under an EXPLICIT method. The percentile form uses the CLASSIC Winsor
 * convention — order-statistic replacement: the `floor(n × lowerPercentile)` smallest values are
 * replaced by the next order statistic (and symmetrically at the top). Chosen over interpolating
 * quantiles deliberately: order-statistic replacement is EXACTLY idempotent (re-winsorizing a
 * winsorized vector is the identity — the metamorphic law in the evidence plan), while an
 * interpolated cutoff moves every time it is recomputed over its own output. Nulls pass through
 * untouched; the realized clip bounds are echoed.
 */
export function winsorizeFactor(input: WinsorizeFactorInput): WinsorizeFactorResult {
  requireArgumentObject('winsorizeFactor', 'input', input);
  ensureKnownKeys('winsorizeFactor', 'input', input, [
    'entries',
    'method',
    'minimumCoverageFraction',
  ]);
  requireFactorEntries('winsorizeFactor', 'entries', input.entries);
  requireArgumentObject('winsorizeFactor', 'method', input.method);
  if (input.method.type === 'percentile') {
    ensureKnownKeys('winsorizeFactor', 'method', input.method, [
      'type',
      'lowerPercentile',
      'upperPercentile',
    ]);
    requireFiniteFields(
      'winsorizeFactor',
      input.method as unknown as Record<string, unknown>,
      ['lowerPercentile', 'upperPercentile'],
      {
        exampleCall:
          "winsorizeFactor({ entries, method: { type: 'percentile', lowerPercentile: 0.01, upperPercentile: 0.99 } })",
      },
    );
    const { lowerPercentile, upperPercentile } = input.method;
    if (!(lowerPercentile >= 0 && upperPercentile <= 1 && lowerPercentile < upperPercentile)) {
      throw new InputError(
        `winsorizeFactor: percentiles must satisfy 0 ≤ lowerPercentile < upperPercentile ≤ 1 (fractions — 0.01, not 1). Received lower ${lowerPercentile}, upper ${upperPercentile}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'method.lowerPercentile' } },
      );
    }
  } else if (input.method.type === 'standard-deviations') {
    ensureKnownKeys('winsorizeFactor', 'method', input.method, ['type', 'multiplier']);
    requireFiniteFields(
      'winsorizeFactor',
      input.method as unknown as Record<string, unknown>,
      ['multiplier'],
      {
        exampleCall:
          "winsorizeFactor({ entries, method: { type: 'standard-deviations', multiplier: 3 } })",
      },
    );
    if (input.method.multiplier <= 0) {
      throw new InputError(
        `winsorizeFactor: method.multiplier must be > 0. Received ${input.method.multiplier}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'method.multiplier' } },
      );
    }
  } else {
    throw new InputError(
      `winsorizeFactor: method.type must be 'percentile' | 'standard-deviations'. Received ${JSON.stringify((input.method as { type?: unknown }).type)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method.type' } },
    );
  }
  const coverage = coverageOf(input.entries);
  const minimum = requireCoverage('winsorizeFactor', coverage, input.minimumCoverageFraction);

  const values = input.entries
    .filter((entry): entry is { instrumentId: string; value: number } => entry.value !== null)
    .map((entry) => entry.value);
  let lowerBound: number;
  let upperBound: number;
  if (input.method.type === 'percentile') {
    const sorted = [...values].sort((a, b) => a - b);
    // The epsilon absorbs binary-fraction dust (5 × (1 − 0.8) is 0.999…96, not 1) so the count
    // is the arithmetic answer, not the representation's.
    const lowerCount = Math.floor(sorted.length * input.method.lowerPercentile + 1e-9);
    const upperCount = Math.floor(
      sorted.length - sorted.length * input.method.upperPercentile + 1e-9,
    );
    lowerBound = sorted[Math.min(lowerCount, sorted.length - 1)]!;
    upperBound = sorted[Math.max(sorted.length - 1 - upperCount, 0)]!;
  } else {
    // Scale before taking moments. The obvious formulas overflow for perfectly ordinary finite
    // answers: mean([1e308, 1e308]) used to be Infinity and `(value - mean) ** 2` then became NaN.
    // In scaled coordinates every value is in [-1, 1], every squared deviation is bounded by 4,
    // and stableSum preserves cancellation. Rescale only the final mean/deviation.
    const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    const scaledValues = scale === 0 ? values : values.map((value) => value / scale);
    const scaledMean = stableSum(scaledValues) / scaledValues.length;
    const mean = scale === 0 ? 0 : scale * scaledMean;
    const scaledVariance =
      scaledValues.length === 1
        ? 0
        : stableSum(scaledValues.map((value) => (value - scaledMean) ** 2)) /
          (scaledValues.length - 1);
    // Multiply the three positive factors in a range-safe order. Computing `scale * deviation`
    // first would overflow for `[-MAX_VALUE, MAX_VALUE]` even when a small multiplier makes the
    // requested clipping offset perfectly representable. Pairing the smallest and largest factors
    // first avoids both premature overflow and underflow whenever the three-factor product itself is
    // representable.
    const factors = [scale, Math.sqrt(scaledVariance), input.method.multiplier].sort(
      (a, b) => a - b,
    );
    const boundOffset = factors[0]! * factors[2]! * factors[1]!;
    lowerBound = mean - boundOffset;
    upperBound = mean + boundOffset;
  }

  let clippedLowerCount = 0;
  let clippedUpperCount = 0;
  const entries = input.entries.map((entry) => {
    if (entry.value === null) return { instrumentId: entry.instrumentId, value: null };
    if (entry.value < lowerBound) {
      clippedLowerCount += 1;
      return { instrumentId: entry.instrumentId, value: lowerBound };
    }
    if (entry.value > upperBound) {
      clippedUpperCount += 1;
      return { instrumentId: entry.instrumentId, value: upperBound };
    }
    return { instrumentId: entry.instrumentId, value: entry.value };
  });
  return requireRepresentableResult('winsorizeFactor', {
    assumptions: { method: input.method, minimumCoverageFraction: minimum, lowerBound, upperBound },
    diagnostics: { warnings: [], coverage, clippedLowerCount, clippedUpperCount },
    entries,
  });
}

// ---------------------------------------------------------------------------------------------------
// Standardization
// ---------------------------------------------------------------------------------------------------

/** Input for {@link standardizeFactor}. */
export interface StandardizeFactorInput {
  entries: readonly FactorEntry[];
  method: 'z-score' | 'percentile-rank';
  minimumCoverageFraction?: number;
}

/** Result of {@link standardizeFactor}. */
export interface StandardizeFactorResult {
  assumptions: {
    method: 'z-score' | 'percentile-rank';
    minimumCoverageFraction: number;
    /** Echoed z-score moments (absent for percentile ranks). */
    mean?: number;
    sampleStandardDeviation?: number;
    tieHandling: 'average rank';
  };
  diagnostics: { warnings: string[]; coverage: FactorCoverage };
  entries: FactorEntry[];
}

/**
 * Standardize a factor cross-sectionally: z-scores over the valued entries, or average-rank
 * percentiles scaled to (0, 1]. Nulls pass through; a zero-dispersion z-score answers 0 for every
 * entry WITH a warning rather than dividing by nothing.
 */
export function standardizeFactor(input: StandardizeFactorInput): StandardizeFactorResult {
  requireArgumentObject('standardizeFactor', 'input', input);
  ensureKnownKeys('standardizeFactor', 'input', input, [
    'entries',
    'method',
    'minimumCoverageFraction',
  ]);
  requireFactorEntries('standardizeFactor', 'entries', input.entries);
  if (input.method !== 'z-score' && input.method !== 'percentile-rank') {
    throw new InputError(
      `standardizeFactor: method must be 'z-score' | 'percentile-rank'. Received ${input.method === null ? 'null' : JSON.stringify(input.method)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method' } },
    );
  }
  const coverage = coverageOf(input.entries);
  const minimum = requireCoverage('standardizeFactor', coverage, input.minimumCoverageFraction);
  const valued = input.entries.filter(
    (entry): entry is { instrumentId: string; value: number } => entry.value !== null,
  );
  const warnings: string[] = [];
  const byInstrument = new Map<string, number>();
  let mean: number | undefined;
  let deviation: number | undefined;
  if (input.method === 'z-score') {
    mean = valued.reduce((total, entry) => total + entry.value, 0) / valued.length;
    const variance =
      valued.length === 1
        ? 0
        : valued.reduce((total, entry) => total + (entry.value - mean!) ** 2, 0) /
          (valued.length - 1);
    deviation = Math.sqrt(variance);
    if (deviation === 0) {
      warnings.push('zero cross-sectional dispersion — every z-score is 0');
      for (const entry of valued) byInstrument.set(entry.instrumentId, 0);
    } else {
      for (const entry of valued)
        byInstrument.set(entry.instrumentId, (entry.value - mean) / deviation);
    }
  } else {
    const sorted = [...valued].sort((a, b) =>
      a.value !== b.value ? a.value - b.value : a.instrumentId < b.instrumentId ? -1 : 1,
    );
    let index = 0;
    while (index < sorted.length) {
      let end = index;
      while (end + 1 < sorted.length && sorted[end + 1]!.value === sorted[index]!.value) end += 1;
      const averageRank = (index + end + 2) / 2;
      for (let position = index; position <= end; position++) {
        byInstrument.set(sorted[position]!.instrumentId, averageRank / sorted.length);
      }
      index = end + 1;
    }
  }
  return requireRepresentableResult('standardizeFactor', {
    assumptions: {
      method: input.method,
      minimumCoverageFraction: minimum,
      ...(mean !== undefined ? { mean } : {}),
      ...(deviation !== undefined ? { sampleStandardDeviation: deviation } : {}),
      tieHandling: 'average rank',
    },
    diagnostics: { warnings, coverage },
    entries: input.entries.map((entry) => ({
      instrumentId: entry.instrumentId,
      value: entry.value === null ? null : byInstrument.get(entry.instrumentId)!,
    })),
  });
}

// ---------------------------------------------------------------------------------------------------
// Neutralization
// ---------------------------------------------------------------------------------------------------

/** Input for {@link neutralizeFactor}. */
export interface NeutralizeFactorInput {
  entries: readonly FactorEntry[];
  /** Category memberships (sector/industry): the group mean is removed within each group. */
  groups?: readonly { instrumentId: string; group: string }[];
  /** Continuous exposures (size, beta, …): the cross-sectional OLS projection is removed. */
  exposures?: readonly { instrumentId: string; exposures: readonly number[] }[];
  minimumCoverageFraction?: number;
}

/** Result of {@link neutralizeFactor}. */
export interface NeutralizeFactorResult {
  assumptions: {
    groupNeutralization: boolean;
    continuousNeutralization: boolean;
    /** Continuous fit always includes an intercept, so residuals are mean-zero. */
    intercept: 'included';
    minimumCoverageFraction: number;
  };
  diagnostics: {
    warnings: string[];
    coverage: FactorCoverage;
    groupCount?: number;
    exposureCount?: number;
    /** Entries dropped because their group or exposure row was absent, tallied. */
    exclusionReasons: Record<string, number>;
  };
  entries: FactorEntry[];
}

/**
 * Neutralize a factor against sector/industry groups (demean within group) and/or continuous
 * exposures (remove the OLS projection, intercept included). Residuals are orthogonal to every
 * controlled exposure within numerical tolerance — the acceptance law, provable from the normal
 * equations this solves.
 */
export function neutralizeFactor(input: NeutralizeFactorInput): NeutralizeFactorResult {
  requireArgumentObject('neutralizeFactor', 'input', input);
  ensureKnownKeys('neutralizeFactor', 'input', input, [
    'entries',
    'groups',
    'exposures',
    'minimumCoverageFraction',
  ]);
  requireFactorEntries('neutralizeFactor', 'entries', input.entries);
  if (input.groups === undefined && input.exposures === undefined) {
    throw new InputError(
      `neutralizeFactor: supply groups, exposures, or both — with neither there is nothing to neutralize against.`,
      { code: ErrorCode.InputMissingField, context: { field: 'groups' } },
    );
  }
  const groupByInstrument = new Map<string, string>();
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups) || input.groups.length === 0) {
      throw new InputError(`neutralizeFactor: groups must be a non-empty array when provided.`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'groups' },
      });
    }
    input.groups.forEach((row, index) => {
      const path = `groups[${index}]`;
      requireArgumentObject('neutralizeFactor', path, row);
      ensureKnownKeys('neutralizeFactor', path, row, ['instrumentId', 'group']);
      if (typeof row.instrumentId !== 'string' || row.instrumentId.length === 0) {
        throw new InputError(`neutralizeFactor: ${path}.instrumentId must be a non-empty string.`, {
          code: ErrorCode.InputWrongType,
          context: { field: `${path}.instrumentId` },
        });
      }
      if (typeof row.group !== 'string' || row.group.length === 0) {
        throw new InputError(`neutralizeFactor: ${path}.group must be a non-empty string.`, {
          code: ErrorCode.InputWrongType,
          context: { field: `${path}.group` },
        });
      }
      groupByInstrument.set(row.instrumentId, row.group);
    });
  }
  const exposuresByInstrument = new Map<string, readonly number[]>();
  let exposureCount: number | undefined;
  if (input.exposures !== undefined) {
    if (!Array.isArray(input.exposures) || input.exposures.length === 0) {
      throw new InputError(`neutralizeFactor: exposures must be a non-empty array when provided.`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'exposures' },
      });
    }
    input.exposures.forEach((row, index) => {
      const path = `exposures[${index}]`;
      requireArgumentObject('neutralizeFactor', path, row);
      ensureKnownKeys('neutralizeFactor', path, row, ['instrumentId', 'exposures']);
      if (typeof row.instrumentId !== 'string' || row.instrumentId.length === 0) {
        throw new InputError(`neutralizeFactor: ${path}.instrumentId must be a non-empty string.`, {
          code: ErrorCode.InputWrongType,
          context: { field: `${path}.instrumentId` },
        });
      }
      if (!Array.isArray(row.exposures) || row.exposures.length === 0) {
        throw new InputError(
          `neutralizeFactor: ${path}.exposures must be a non-empty numeric array.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.exposures` } },
        );
      }
      row.exposures.forEach((value: unknown, position: number) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new InputError(
            `neutralizeFactor: ${path}.exposures[${position}] must be a finite number. Received ${value === null ? 'null' : typeof value}.`,
            {
              code: ErrorCode.InputWrongType,
              context: { field: `${path}.exposures[${position}]` },
            },
          );
        }
      });
      if (exposureCount === undefined) exposureCount = row.exposures.length;
      else if (row.exposures.length !== exposureCount) {
        throw new InputError(
          `neutralizeFactor: ${path}.exposures has ${row.exposures.length} entries but earlier rows have ${exposureCount} — one exposure vector shape per cross-section.`,
          { code: ErrorCode.InputWrongShape, context: { field: `${path}.exposures` } },
        );
      }
      exposuresByInstrument.set(row.instrumentId, row.exposures);
    });
  }
  const coverage = coverageOf(input.entries);
  const minimum = requireCoverage('neutralizeFactor', coverage, input.minimumCoverageFraction);

  const exclusionReasons: Record<string, number> = {};
  const addExclusion = (reason: string): void => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };

  // Working set: valued entries with every required control present.
  const working: Array<{ instrumentId: string; value: number }> = [];
  for (const entry of input.entries) {
    if (entry.value === null) continue;
    if (input.groups !== undefined && !groupByInstrument.has(entry.instrumentId)) {
      addExclusion('no-group-membership');
      continue;
    }
    if (input.exposures !== undefined && !exposuresByInstrument.has(entry.instrumentId)) {
      addExclusion('no-exposure-row');
      continue;
    }
    working.push({ instrumentId: entry.instrumentId, value: entry.value });
  }
  const residualByInstrument = new Map<string, number>();
  const warnings: string[] = [];

  // 1. Group demeaning. The mean falls back to scaled summation when the naive sum overflows —
  // two same-sign near-MAX values have a perfectly representable mean, and losing it here turned
  // a computable residual into Infinity (2026-08-23 review wave).
  const groupMeanOf = (values: readonly number[]): number => {
    let total = 0;
    for (const value of values) total += value;
    const naive = total / values.length;
    if (Number.isFinite(naive)) return naive;
    let maxAbs = 0;
    for (const value of values) maxAbs = Math.max(maxAbs, Math.abs(value));
    let scaled = 0;
    for (const value of values) scaled += value / maxAbs;
    return maxAbs * (scaled / values.length);
  };
  let current = working;
  if (input.groups !== undefined) {
    const valuesByGroup = new Map<string, number[]>();
    for (const entry of current) {
      const group = groupByInstrument.get(entry.instrumentId)!;
      const bucket = valuesByGroup.get(group) ?? [];
      bucket.push(entry.value);
      valuesByGroup.set(group, bucket);
    }
    const meanByGroup = new Map<string, number>();
    for (const [group, values] of valuesByGroup) meanByGroup.set(group, groupMeanOf(values));
    current = current.map((entry) => ({
      instrumentId: entry.instrumentId,
      value: entry.value - meanByGroup.get(groupByInstrument.get(entry.instrumentId)!)!,
    }));
  }

  // 2. Continuous projection via the normal equations, intercept included.
  if (input.exposures !== undefined && current.length > 0) {
    const k = exposureCount! + 1; // intercept column first
    if (current.length <= k) {
      throw new InputError(
        `neutralizeFactor: ${current.length} usable entries cannot identify ${exposureCount} exposure coefficients plus an intercept — supply more entries or fewer exposures.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'exposures' } },
      );
    }
    const design = current.map((entry) => [1, ...exposuresByInstrument.get(entry.instrumentId)!]);
    const response = current.map((entry) => entry.value);
    const normal: number[][] = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
    const moment: number[] = Array.from({ length: k }, () => 0);
    for (let row = 0; row < design.length; row++) {
      for (let a = 0; a < k; a++) {
        moment[a]! += design[row]![a]! * response[row]!;
        for (let b = 0; b < k; b++) normal[a]![b]! += design[row]![a]! * design[row]![b]!;
      }
    }
    const coefficients = luSolve(luDecompose(normal), moment);
    current = current.map((entry, row) => {
      let fitted = 0;
      for (let a = 0; a < k; a++) fitted += coefficients[a]! * design[row]![a]!;
      return { instrumentId: entry.instrumentId, value: entry.value - fitted };
    });
  }
  for (const entry of current) residualByInstrument.set(entry.instrumentId, entry.value);

  return requireRepresentableResult('neutralizeFactor', {
    assumptions: {
      groupNeutralization: input.groups !== undefined,
      continuousNeutralization: input.exposures !== undefined,
      intercept: 'included',
      minimumCoverageFraction: minimum,
    },
    diagnostics: {
      warnings,
      coverage,
      ...(input.groups !== undefined
        ? { groupCount: new Set(groupByInstrument.values()).size }
        : {}),
      ...(exposureCount !== undefined ? { exposureCount } : {}),
      exclusionReasons,
    },
    entries: input.entries.map((entry) => ({
      instrumentId: entry.instrumentId,
      value: residualByInstrument.get(entry.instrumentId) ?? null,
    })),
  });
}

// ---------------------------------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------------------------------

/** One composite component: an already-standardized factor vector with a weight and direction. */
export interface CompositeComponent {
  label: string;
  entries: readonly FactorEntry[];
  weight: number;
  direction: 'higher-is-better' | 'lower-is-better';
}

/** Input for {@link compositeFactorScore}. */
export interface CompositeFactorScoreInput {
  components: readonly CompositeComponent[];
  /** `'exclude'` drops an instrument missing any component; `'renormalize-weights'` scores what is present. */
  missingValuePolicy: 'exclude' | 'renormalize-weights';
}

/** Result of {@link compositeFactorScore}. */
export interface CompositeFactorScoreResult {
  assumptions: {
    components: Array<{
      label: string;
      weight: number;
      normalizedWeight: number;
      direction: string;
    }>;
    missingValuePolicy: 'exclude' | 'renormalize-weights';
  };
  diagnostics: {
    warnings: string[];
    instrumentCount: number;
    scoredCount: number;
    exclusionReasons: Record<string, number>;
  };
  entries: FactorEntry[];
}

/** Weighted composite of standardized factor vectors; direction flips signs so higher is better. */
export function compositeFactorScore(input: CompositeFactorScoreInput): CompositeFactorScoreResult {
  requireArgumentObject('compositeFactorScore', 'input', input);
  ensureKnownKeys('compositeFactorScore', 'input', input, ['components', 'missingValuePolicy']);
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new InputError(`compositeFactorScore: components must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'components' },
    });
  }
  input.components.forEach((component, index) => {
    const path = `components[${index}]`;
    requireArgumentObject('compositeFactorScore', path, component);
    ensureKnownKeys('compositeFactorScore', path, component, [
      'label',
      'entries',
      'weight',
      'direction',
    ]);
    if (typeof component.label !== 'string' || component.label.length === 0) {
      throw new InputError(`compositeFactorScore: ${path}.label must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.label` },
      });
    }
    requireFactorEntries('compositeFactorScore', `${path}.entries`, component.entries);
    if (
      typeof component.weight !== 'number' ||
      !Number.isFinite(component.weight) ||
      component.weight <= 0
    ) {
      throw new InputError(
        `compositeFactorScore: ${path}.weight must be a finite number > 0. Received ${component.weight === null ? 'null' : String(component.weight)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.weight` } },
      );
    }
    if (component.direction !== 'higher-is-better' && component.direction !== 'lower-is-better') {
      throw new InputError(
        `compositeFactorScore: ${path}.direction must be 'higher-is-better' | 'lower-is-better'. Received ${JSON.stringify(component.direction)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.direction` } },
      );
    }
  });
  if (
    input.missingValuePolicy !== 'exclude' &&
    input.missingValuePolicy !== 'renormalize-weights'
  ) {
    throw new InputError(
      `compositeFactorScore: missingValuePolicy must be 'exclude' | 'renormalize-weights'. Received ${input.missingValuePolicy === null ? 'null' : JSON.stringify(input.missingValuePolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'missingValuePolicy' } },
    );
  }
  const totalWeight = input.components.reduce((total, component) => total + component.weight, 0);
  const instruments = new Set<string>();
  for (const component of input.components) {
    for (const entry of component.entries) instruments.add(entry.instrumentId);
  }
  const exclusionReasons: Record<string, number> = {};
  const entries: FactorEntry[] = [];
  for (const instrumentId of [...instruments].sort()) {
    let weighted = 0;
    let usedWeight = 0;
    let missing = false;
    for (const component of input.components) {
      const entry = component.entries.find(
        (candidate: FactorEntry) => candidate.instrumentId === instrumentId,
      );
      const value = entry?.value ?? null;
      if (value === null) {
        missing = true;
        continue;
      }
      const sign = component.direction === 'higher-is-better' ? 1 : -1;
      weighted += sign * value * component.weight;
      usedWeight += component.weight;
    }
    if (usedWeight === 0 || (missing && input.missingValuePolicy === 'exclude')) {
      exclusionReasons[usedWeight === 0 ? 'missing-every-component' : 'missing-component-value'] =
        (exclusionReasons[
          usedWeight === 0 ? 'missing-every-component' : 'missing-component-value'
        ] ?? 0) + 1;
      entries.push({ instrumentId, value: null });
      continue;
    }
    entries.push({ instrumentId, value: weighted / usedWeight });
  }
  return requireRepresentableResult('compositeFactorScore', {
    assumptions: {
      components: input.components.map((component) => ({
        label: component.label,
        weight: component.weight,
        normalizedWeight: component.weight / totalWeight,
        direction: component.direction,
      })),
      missingValuePolicy: input.missingValuePolicy,
    },
    diagnostics: {
      warnings: [],
      instrumentCount: instruments.size,
      scoredCount: entries.filter((entry) => entry.value !== null).length,
      exclusionReasons,
    },
    entries,
  });
}

// ---------------------------------------------------------------------------------------------------
// Quantile portfolios
// ---------------------------------------------------------------------------------------------------

/** Input for {@link formQuantilePortfolios}. */
export interface FormQuantilePortfoliosInput {
  entries: readonly FactorEntry[];
  /** How many portfolios (e.g. 5 = quintiles). */
  quantileCount: number;
  /** `'descending'`: portfolio 1 holds the HIGHEST values (the conventional long leg). */
  direction: 'ascending' | 'descending';
}

/** Result of {@link formQuantilePortfolios}. */
export interface FormQuantilePortfoliosResult {
  assumptions: {
    quantileCount: number;
    direction: 'ascending' | 'descending';
    tieBreaker: 'instrumentId ascending';
    sizing: 'as equal as arithmetic allows; earlier portfolios take the remainder';
  };
  diagnostics: {
    warnings: string[];
    coverage: FactorCoverage;
    excludedMissingCount: number;
  };
  portfolios: Array<{ quantileIndex: number; instrumentIds: string[] }>;
}

/**
 * Sort the valued entries and cut them into `quantileCount` portfolios. Every valued entry lands
 * in EXACTLY one portfolio and no portfolio repeats a name — the acceptance law, by construction.
 */
export function formQuantilePortfolios(
  input: FormQuantilePortfoliosInput,
): FormQuantilePortfoliosResult {
  requireArgumentObject('formQuantilePortfolios', 'input', input);
  ensureKnownKeys('formQuantilePortfolios', 'input', input, [
    'entries',
    'quantileCount',
    'direction',
  ]);
  requireFactorEntries('formQuantilePortfolios', 'entries', input.entries);
  if (!Number.isSafeInteger(input.quantileCount) || input.quantileCount < 2) {
    throw new InputError(
      `formQuantilePortfolios: quantileCount must be an integer ≥ 2. Received ${input.quantileCount === null ? 'null' : String(input.quantileCount)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'quantileCount' } },
    );
  }
  if (input.direction !== 'ascending' && input.direction !== 'descending') {
    throw new InputError(
      `formQuantilePortfolios: direction must be 'ascending' | 'descending' ('descending' puts the highest values in portfolio 1). Received ${JSON.stringify(input.direction)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'direction' } },
    );
  }
  const valued = input.entries.filter(
    (entry): entry is { instrumentId: string; value: number } => entry.value !== null,
  );
  if (valued.length < input.quantileCount) {
    throw new InputError(
      `formQuantilePortfolios: ${valued.length} valued entries cannot fill ${input.quantileCount} portfolios.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'quantileCount' } },
    );
  }
  const sorted = [...valued].sort((a, b) => {
    if (a.value !== b.value) {
      const ordered = a.value < b.value ? -1 : 1;
      return input.direction === 'ascending' ? ordered : -ordered;
    }
    return a.instrumentId < b.instrumentId ? -1 : 1;
  });
  const base = Math.floor(sorted.length / input.quantileCount);
  const remainder = sorted.length % input.quantileCount;
  const portfolios: FormQuantilePortfoliosResult['portfolios'] = [];
  let cursor = 0;
  for (let index = 0; index < input.quantileCount; index++) {
    const size = base + (index < remainder ? 1 : 0);
    portfolios.push({
      quantileIndex: index + 1,
      instrumentIds: sorted.slice(cursor, cursor + size).map((entry) => entry.instrumentId),
    });
    cursor += size;
  }
  return {
    assumptions: {
      quantileCount: input.quantileCount,
      direction: input.direction,
      tieBreaker: 'instrumentId ascending',
      sizing: 'as equal as arithmetic allows; earlier portfolios take the remainder',
    },
    diagnostics: {
      warnings: [],
      coverage: coverageOf(input.entries),
      excludedMissingCount: input.entries.length - valued.length,
    },
    portfolios,
  };
}

// ---------------------------------------------------------------------------------------------------
// Information coefficient and diagnostics
// ---------------------------------------------------------------------------------------------------

/** Input for {@link informationCoefficient}. */
export interface InformationCoefficientInput {
  factorEntries: readonly FactorEntry[];
  /** Forward returns over the evaluation horizon, keyed by instrument. */
  forwardReturns: readonly FactorEntry[];
  minimumCoverageFraction?: number;
}

/** Result of {@link informationCoefficient}. */
export interface InformationCoefficientResult {
  assumptions: {
    pearsonBasis: 'values';
    rankBasis: 'average ranks (Spearman)';
    minimumCoverageFraction: number;
  };
  diagnostics: { warnings: string[]; pairedCount: number };
  /** Pearson correlation of factor values with forward returns, or null with the reason. */
  informationCoefficient: number | null;
  /** Spearman (rank) correlation, or null with the reason. */
  rankInformationCoefficient: number | null;
  reason?: string;
}

function averageRanks(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (a.value !== b.value ? a.value - b.value : a.index - b.index));
  const ranks = new Array<number>(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1]!.value === order[position]!.value) end += 1;
    const averageRank = (position + end + 2) / 2;
    for (let cursor = position; cursor <= end; cursor++) ranks[order[cursor]!.index] = averageRank;
    position = end + 1;
  }
  return ranks;
}

/**
 * The information coefficient: Pearson correlation of a factor with forward returns over the
 * instruments carrying BOTH, plus the Spearman rank version. Fewer than three pairs or zero
 * dispersion answers null with the reason — a correlation of nothing is not zero.
 */
export function informationCoefficient(
  input: InformationCoefficientInput,
): InformationCoefficientResult {
  requireArgumentObject('informationCoefficient', 'input', input);
  ensureKnownKeys('informationCoefficient', 'input', input, [
    'factorEntries',
    'forwardReturns',
    'minimumCoverageFraction',
  ]);
  requireFactorEntries('informationCoefficient', 'factorEntries', input.factorEntries);
  requireFactorEntries('informationCoefficient', 'forwardReturns', input.forwardReturns);
  const forwardByInstrument = new Map<string, number | null>(
    input.forwardReturns.map((entry) => [entry.instrumentId, entry.value]),
  );
  const paired: Array<{ factor: number; forward: number }> = [];
  for (const entry of input.factorEntries) {
    if (entry.value === null) continue;
    const forward = forwardByInstrument.get(entry.instrumentId);
    if (forward === undefined || forward === null) continue;
    paired.push({ factor: entry.value, forward });
  }
  const coverage: FactorCoverage = {
    entryCount: input.factorEntries.length,
    valuedCount: paired.length,
    coverageFraction:
      input.factorEntries.length === 0 ? 0 : paired.length / input.factorEntries.length,
  };
  const minimum = requireCoverage(
    'informationCoefficient',
    coverage,
    input.minimumCoverageFraction,
  );
  const base = {
    assumptions: {
      pearsonBasis: 'values' as const,
      rankBasis: 'average ranks (Spearman)' as const,
      minimumCoverageFraction: minimum,
    },
    diagnostics: { warnings: [] as string[], pairedCount: paired.length },
  };
  if (paired.length < 3) {
    return {
      ...base,
      informationCoefficient: null,
      rankInformationCoefficient: null,
      reason: `only ${paired.length} instrument${paired.length === 1 ? '' : 's'} carry both the factor and a forward return — a correlation needs at least 3`,
    };
  }
  const factors = paired.map((pair) => pair.factor);
  const forwards = paired.map((pair) => pair.forward);
  const pearson = correlation(factors, forwards);
  const spearman = correlation(averageRanks(factors), averageRanks(forwards));
  if (Number.isNaN(pearson) || Number.isNaN(spearman)) {
    return {
      ...base,
      informationCoefficient: null,
      rankInformationCoefficient: null,
      reason: 'zero dispersion on one side — the correlation is undefined',
    };
  }
  return { ...base, informationCoefficient: pearson, rankInformationCoefficient: spearman };
}

/** Input for {@link factorSpreadReturn}. */
export interface FactorSpreadReturnInput {
  entries: readonly FactorEntry[];
  forwardReturns: readonly FactorEntry[];
  quantileCount: number;
  /** `'descending'`: portfolio 1 (highest factor) is the LONG leg. */
  direction: 'ascending' | 'descending';
}

/** Result of {@link factorSpreadReturn}. */
export interface FactorSpreadReturnResult {
  assumptions: {
    quantileCount: number;
    direction: 'ascending' | 'descending';
    legWeighting: 'equal weight within each leg';
  };
  diagnostics: { warnings: string[]; longLegCount: number; shortLegCount: number };
  /** Mean forward return of portfolio 1 minus portfolio N, or null with the reason. */
  spreadReturn: number | null;
  longLegMeanReturn: number | null;
  shortLegMeanReturn: number | null;
  reason?: string;
}

/** Top-minus-bottom quantile forward return, equal-weighted within each leg. */
export function factorSpreadReturn(input: FactorSpreadReturnInput): FactorSpreadReturnResult {
  requireArgumentObject('factorSpreadReturn', 'input', input);
  ensureKnownKeys('factorSpreadReturn', 'input', input, [
    'entries',
    'forwardReturns',
    'quantileCount',
    'direction',
  ]);
  const portfolios = formQuantilePortfolios({
    entries: input.entries,
    quantileCount: input.quantileCount,
    direction: input.direction,
  });
  requireFactorEntries('factorSpreadReturn', 'forwardReturns', input.forwardReturns);
  const forwardByInstrument = new Map<string, number | null>(
    input.forwardReturns.map((entry) => [entry.instrumentId, entry.value]),
  );
  const legMean = (instrumentIds: readonly string[]): { mean: number | null; count: number } => {
    const returns = instrumentIds
      .map((instrumentId) => forwardByInstrument.get(instrumentId))
      .filter((value): value is number => typeof value === 'number');
    if (returns.length === 0) return { mean: null, count: 0 };
    return {
      mean: returns.reduce((total, value) => total + value, 0) / returns.length,
      count: returns.length,
    };
  };
  const longLeg = legMean(portfolios.portfolios[0]!.instrumentIds);
  const shortLeg = legMean(portfolios.portfolios[portfolios.portfolios.length - 1]!.instrumentIds);
  const missingLeg = longLeg.mean === null || shortLeg.mean === null;
  return {
    assumptions: {
      quantileCount: input.quantileCount,
      direction: input.direction,
      legWeighting: 'equal weight within each leg',
    },
    diagnostics: { warnings: [], longLegCount: longLeg.count, shortLegCount: shortLeg.count },
    spreadReturn: missingLeg ? null : longLeg.mean! - shortLeg.mean!,
    longLegMeanReturn: longLeg.mean,
    shortLegMeanReturn: shortLeg.mean,
    ...(missingLeg
      ? { reason: 'a leg has no instrument with a forward return — the spread cannot be formed' }
      : {}),
  };
}

/** Input for {@link factorTurnover}. */
export interface FactorTurnoverInput {
  previousPortfolios: FormQuantilePortfoliosResult['portfolios'];
  currentPortfolios: FormQuantilePortfoliosResult['portfolios'];
}

/** Result of {@link factorTurnover}. */
export interface FactorTurnoverResult {
  assumptions: { definition: 'fraction of the current portfolio not present in the previous one' };
  diagnostics: { warnings: string[] };
  byQuantile: Array<{ quantileIndex: number; turnover: number | null; reason?: string }>;
}

/** Per-quantile membership turnover between two formations. */
export function factorTurnover(input: FactorTurnoverInput): FactorTurnoverResult {
  requireArgumentObject('factorTurnover', 'input', input);
  ensureKnownKeys('factorTurnover', 'input', input, ['previousPortfolios', 'currentPortfolios']);
  for (const [label, portfolios] of [
    ['previousPortfolios', input.previousPortfolios],
    ['currentPortfolios', input.currentPortfolios],
  ] as const) {
    if (!Array.isArray(portfolios) || portfolios.length === 0) {
      throw new InputError(`factorTurnover: ${label} must be a non-empty portfolio array.`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: label },
      });
    }
    portfolios.forEach((portfolio, index) => {
      const path = `${label}[${index}]`;
      requireArgumentObject('factorTurnover', path, portfolio);
      ensureKnownKeys('factorTurnover', path, portfolio, ['quantileIndex', 'instrumentIds']);
      // A quantile index is an identity, not a loop bound — but 2.5 or an unsafe "integer" is
      // still a caller error worth a teaching (2026-08-23 review wave side finding: this field
      // had no validation at all).
      if (!Number.isSafeInteger(portfolio.quantileIndex) || portfolio.quantileIndex < 1) {
        throw new InputError(
          `factorTurnover: ${path}.quantileIndex must be a safe integer ≥ 1. Received ${String(portfolio.quantileIndex)}.`,
          { code: ErrorCode.InputOutOfRange, context: { field: `${path}.quantileIndex` } },
        );
      }
      if (
        !Array.isArray(portfolio.instrumentIds) ||
        portfolio.instrumentIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)
      ) {
        throw new InputError(
          `factorTurnover: ${path}.instrumentIds must be an array of non-empty strings.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.instrumentIds` } },
        );
      }
    });
  }
  if (input.previousPortfolios.length !== input.currentPortfolios.length) {
    throw new InputError(
      `factorTurnover: portfolio counts differ (${input.previousPortfolios.length} vs ${input.currentPortfolios.length}) — turnover compares like with like.`,
      { code: ErrorCode.InputWrongShape, context: { field: 'currentPortfolios' } },
    );
  }
  const previousByIndex = new Map(
    input.previousPortfolios.map((portfolio) => [
      portfolio.quantileIndex,
      new Set(portfolio.instrumentIds),
    ]),
  );
  const byQuantile = input.currentPortfolios.map((portfolio) => {
    const previous = previousByIndex.get(portfolio.quantileIndex);
    if (previous === undefined) {
      return {
        quantileIndex: portfolio.quantileIndex,
        turnover: null,
        reason: 'no previous portfolio with this quantile index',
      };
    }
    if (portfolio.instrumentIds.length === 0) {
      return {
        quantileIndex: portfolio.quantileIndex,
        turnover: null,
        reason: 'the current portfolio is empty',
      };
    }
    const entering = portfolio.instrumentIds.filter((instrumentId) => !previous.has(instrumentId));
    return {
      quantileIndex: portfolio.quantileIndex,
      turnover: entering.length / portfolio.instrumentIds.length,
    };
  });
  return {
    assumptions: {
      definition: 'fraction of the current portfolio not present in the previous one',
    },
    diagnostics: { warnings: [] },
    byQuantile,
  };
}

/** Input for {@link factorDecay}. */
export interface FactorDecayInput {
  factorEntries: readonly FactorEntry[];
  /** Forward returns at increasing horizons, each labeled. */
  horizons: readonly { horizonLabel: string; forwardReturns: readonly FactorEntry[] }[];
  minimumCoverageFraction?: number;
}

/** Result of {@link factorDecay}. */
export interface FactorDecayResult {
  assumptions: {
    coefficient: 'rank information coefficient per horizon';
    minimumCoverageFraction: number;
  };
  diagnostics: { warnings: string[] };
  byHorizon: Array<{
    horizonLabel: string;
    rankInformationCoefficient: number | null;
    pairedCount: number;
    reason?: string;
  }>;
}

/** The factor's rank information coefficient at each stated horizon — its signal decay curve. */
export function factorDecay(input: FactorDecayInput): FactorDecayResult {
  requireArgumentObject('factorDecay', 'input', input);
  ensureKnownKeys('factorDecay', 'input', input, [
    'factorEntries',
    'horizons',
    'minimumCoverageFraction',
  ]);
  requireFactorEntries('factorDecay', 'factorEntries', input.factorEntries);
  if (!Array.isArray(input.horizons) || input.horizons.length === 0) {
    throw new InputError(`factorDecay: horizons must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'horizons' },
    });
  }
  const byHorizon = input.horizons.map((horizon, index) => {
    const path = `horizons[${index}]`;
    requireArgumentObject('factorDecay', path, horizon);
    ensureKnownKeys('factorDecay', path, horizon, ['horizonLabel', 'forwardReturns']);
    if (typeof horizon.horizonLabel !== 'string' || horizon.horizonLabel.length === 0) {
      throw new InputError(`factorDecay: ${path}.horizonLabel must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.horizonLabel` },
      });
    }
    const coefficient = informationCoefficient({
      factorEntries: input.factorEntries,
      forwardReturns: horizon.forwardReturns,
      ...(input.minimumCoverageFraction !== undefined
        ? { minimumCoverageFraction: input.minimumCoverageFraction }
        : { minimumCoverageFraction: 0 }),
    });
    return {
      horizonLabel: horizon.horizonLabel,
      rankInformationCoefficient: coefficient.rankInformationCoefficient,
      pairedCount: coefficient.diagnostics.pairedCount,
      ...(coefficient.reason !== undefined ? { reason: coefficient.reason } : {}),
    };
  });
  return {
    assumptions: {
      coefficient: 'rank information coefficient per horizon',
      minimumCoverageFraction: input.minimumCoverageFraction ?? 0,
    },
    diagnostics: { warnings: [] },
    byHorizon,
  };
}

// ---------------------------------------------------------------------------------------------------
// Factor recipes — versioned artifacts, not universal truths
// ---------------------------------------------------------------------------------------------------

/** One feature inside a recipe. */
export interface FactorRecipeFeature {
  field: string;
  transform: 'raw' | 'winsorize-then-z-score' | 'percentile-rank';
  weight: number;
}

/**
 * A versioned factor recipe: everything the factor DOES, disclosed — features, transforms,
 * direction, lag, neutralization, weights, and the missing-value policy. A recipe is data; the
 * raw transforms above remain available for any definition a caller prefers.
 */
export interface FactorRecipe {
  recipeName: string;
  recipeVersion: number;
  /** The disclosure every canonical recipe carries: a definition, not the definition. */
  disclosure: string;
  direction: 'higher-is-better' | 'lower-is-better';
  features: readonly FactorRecipeFeature[];
  /** Sessions between the information date and use — the lookahead guard. */
  lagTradingSessions: number;
  neutralization: 'none' | 'sector' | 'sector-and-size';
  missingValuePolicy: 'exclude' | 'renormalize-weights';
}

const CANONICAL_DISCLOSURE =
  'A canonical definition, published for reproducibility — not a claim that this is the one true construction.';

/**
 * The seven canonical recipe families. Each is a frozen, versioned artifact; callers may copy and
 * modify freely (the result is then their recipe, and should carry their name and version).
 */
export const CANONICAL_FACTOR_RECIPES: Readonly<Record<string, FactorRecipe>> = {
  value: {
    recipeName: 'value',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'higher-is-better',
    features: [
      { field: 'earningsYield', transform: 'winsorize-then-z-score', weight: 0.5 },
      { field: 'freeCashFlowYield', transform: 'winsorize-then-z-score', weight: 0.5 },
    ],
    lagTradingSessions: 1,
    neutralization: 'sector',
    missingValuePolicy: 'exclude',
  },
  size: {
    recipeName: 'size',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'lower-is-better',
    features: [{ field: 'marketCapitalization', transform: 'percentile-rank', weight: 1 }],
    lagTradingSessions: 1,
    neutralization: 'none',
    missingValuePolicy: 'exclude',
  },
  momentum: {
    recipeName: 'momentum',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'higher-is-better',
    features: [
      { field: 'twelveMinusOneMonthReturn', transform: 'winsorize-then-z-score', weight: 1 },
    ],
    lagTradingSessions: 1,
    neutralization: 'sector',
    missingValuePolicy: 'exclude',
  },
  quality: {
    recipeName: 'quality',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'higher-is-better',
    features: [
      { field: 'returnOnEquity', transform: 'winsorize-then-z-score', weight: 0.5 },
      { field: 'cashFlowToNetIncome', transform: 'winsorize-then-z-score', weight: 0.5 },
    ],
    lagTradingSessions: 1,
    neutralization: 'sector',
    missingValuePolicy: 'exclude',
  },
  lowVolatility: {
    recipeName: 'lowVolatility',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'lower-is-better',
    features: [{ field: 'trailingVolatility', transform: 'winsorize-then-z-score', weight: 1 }],
    lagTradingSessions: 1,
    neutralization: 'none',
    missingValuePolicy: 'exclude',
  },
  liquidity: {
    recipeName: 'liquidity',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'higher-is-better',
    features: [{ field: 'averageDailyTradedValue', transform: 'percentile-rank', weight: 1 }],
    lagTradingSessions: 1,
    neutralization: 'none',
    missingValuePolicy: 'exclude',
  },
  investment: {
    recipeName: 'investment',
    recipeVersion: 1,
    disclosure: CANONICAL_DISCLOSURE,
    direction: 'lower-is-better',
    features: [{ field: 'totalAssetGrowth', transform: 'winsorize-then-z-score', weight: 1 }],
    lagTradingSessions: 1,
    neutralization: 'sector',
    missingValuePolicy: 'exclude',
  },
};
