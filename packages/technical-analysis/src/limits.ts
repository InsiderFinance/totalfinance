/**
 * Largest public TA lookback/window.
 *
 * Several streams precompute one or two arrays of this length. One million therefore means at most
 * roughly 8–16 MB of packed numeric storage and a bounded synchronous setup pass, while already
 * exceeding any practical chart history. Safe-integer validation alone is not resource safety:
 * `2 ** 32` is exact but `new Array(2 ** 32)` throws a raw RangeError before a stream exists.
 */
export const MAX_TECHNICAL_ANALYSIS_LOOKBACK = 1_000_000;

/**
 * Largest number of independent indicator streams one public constructor may create eagerly.
 *
 * This is intentionally much smaller than a chart lookback: `levels` and `periods.length` allocate
 * whole stream objects, not packed numeric slots. One thousand twenty-four already exceeds any
 * useful rainbow/ribbon configuration while preventing one valid-looking request from allocating a
 * million objects synchronously.
 */
export const MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS = 1_024;
