/**
 * Interior-NaN policy for windowed (subtract-on-evict) accumulators — INTERNAL, not an entrypoint.
 *
 * A rolling indicator that keeps a running sum and subtracts the evicted sample is O(1) per bar, but
 * it has a latch: `sum += NaN` makes the sum NaN forever, and the later `sum -= NaN` never repairs it
 * (NaN − NaN is NaN). One missing print in a feed therefore poisoned every subsequent value of that
 * indicator for the rest of the series — silently, since the output still looked like a number-shaped
 * NaN rather than an error.
 *
 * The policy, which matches pandas' rolling semantics ("flows through, then recovers"):
 *
 *   1. the running sum only ever accumulates FINITE samples (a non-finite sample contributes 0), so
 *      the accumulator itself can never latch;
 *   2. a per-window count of the non-finite samples gates EMISSION — while the window still holds
 *      one, the indicator emits `NaN`;
 *   3. the bar the bad sample leaves the window, the count returns to zero and the indicator resumes
 *      emitting the same values it would have produced had the sample never been seen.
 *
 * Indicators whose state is a RECURSION (KAMA, VIDYA, VFI's smoothing EMA) additionally HOLD that
 * recursion while the window is dirty rather than feeding it a NaN — feeding it would latch the
 * filter forever, which is the same bug in a different shape. Their post-gap values are therefore
 * finite and correct going forward, but (unlike the pure-window indicators) not bit-identical to the
 * gap-free series, because the recursion legitimately saw fewer updates.
 *
 * ±Infinity is treated exactly like NaN: it latches a running sum just as permanently (`Inf − Inf`
 * is NaN) and no aligned output may leak an infinity.
 */

/** A sample that must never enter a running sum: `NaN` or `±Infinity`. */
export function isDirtySample(x: number): boolean {
  return !Number.isFinite(x);
}

/**
 * How many samples of a window are non-finite. Used to rebuild the emission gate from a restored
 * snapshot without adding a state key (JSON serializes `NaN` as `null`, which is non-finite too, so
 * a round-tripped dirty window stays dirty).
 */
export function dirtySamples(xs: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) n++;
  return n;
}

/**
 * `dirtySamples` over parallel windows that are pushed and evicted TOGETHER (a paired/tripled
 * accumulator such as CMO's up/down or Vortex's VM+/VM−/TR): a row counts once when any of its
 * columns is non-finite, matching the single counter those streams maintain.
 */
export function dirtyRows(...windows: readonly ArrayLike<number>[]): number {
  const first = windows[0];
  if (first === undefined) return 0;
  let n = 0;
  for (let i = 0; i < first.length; i++) {
    if (windows.some((w) => !Number.isFinite(w[i]!))) n++;
  }
  return n;
}
