import type { ComparisonTolerance } from './comparison.js';

const FLOAT_BITS = new DataView(new ArrayBuffer(8));
const FRACTION_MASK = (1n << 52n) - 1n;

/** Every finite binary64 is an exact integer multiple of 2^-1074, including subnormals. */
function integerUnits(value: number): bigint {
  FLOAT_BITS.setFloat64(0, value);
  const bits = FLOAT_BITS.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & FRACTION_MASK;
  const magnitude = exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  return bits >> 63n === 0n ? magnitude : -magnitude;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Exact inequality on the supplied IEEE values, not their rounded subtraction/product/sum.
 * Multiply both sides by 2^2148 to compare integer units, including the tolerance product.
 * The largest intermediate is bounded by binary64's exponent range (under 4,200 bits).
 * Equality and zero tolerance have exact cheap paths; all other cases use this same rule,
 * avoiding an epsilon heuristic or an unproven "far enough from the boundary" fast path.
 */
function exactWithinTolerance(input: {
  baseline: number;
  candidate: number;
  tolerance: ComparisonTolerance;
}): boolean {
  const { baseline, candidate, tolerance } = input;
  if (baseline === candidate) return true;
  if (tolerance.absolute === 0 && tolerance.relative === 0) return false;
  const baselineUnits = integerUnits(baseline);
  const differenceUnits = magnitude(integerUnits(candidate) - baselineUnits);
  const absoluteUnits = integerUnits(tolerance.absolute);
  if (tolerance.relative === 0) return differenceUnits <= absoluteUnits;
  return (
    differenceUnits << 1074n <=
    (absoluteUnits << 1074n) + integerUnits(tolerance.relative) * magnitude(baselineUnits)
  );
}

/** Shared finite-number comparison: exact tolerance decisions, rounded finite-or-null deltas. */
export function compareFiniteNumbers(input: {
  baseline: number;
  candidate: number;
  tolerance: ComparisonTolerance | null;
}): {
  absoluteDelta: number | null;
  relativeDelta: number | null;
  withinTolerance: boolean | null;
} {
  const { baseline, candidate, tolerance } = input;
  const difference = candidate - baseline;
  const scale = Math.max(Math.abs(baseline), Math.abs(candidate));
  const relative =
    baseline === 0
      ? null
      : Number.isFinite(difference)
        ? difference / Math.abs(baseline)
        : (candidate / scale - baseline / scale) / (Math.abs(baseline) / scale);
  const withinTolerance =
    tolerance === null ? null : exactWithinTolerance({ baseline, candidate, tolerance });
  return {
    absoluteDelta: Number.isFinite(difference) ? difference : null,
    relativeDelta: relative !== null && Number.isFinite(relative) ? relative : null,
    withinTolerance,
  };
}
