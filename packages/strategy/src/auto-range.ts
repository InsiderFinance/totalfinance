/**
 * The default payoff-diagram price window (spec §12.2/§12.5). Internal, deliberately NOT re-exported
 * from the package index: it is shared by `Position`'s chart/scenario methods (when the caller omits
 * `prices`) and by `payoffSvg`, so a bare `payoff()` / `chartData()` and the drawn diagram frame the
 * same window — without adding a positional-array export that the first-touch sweep would have to police.
 */

import type { PriceRange } from './types.js';

/**
 * Build a price grid that spans the given reference levels — typically strikes (stock legs contribute
 * their entry price), finite breakevens, and any known spot — padded 35% on each side and clamped at 0.
 * Non-finite and non-positive references are ignored; with no usable reference it falls back to 1..100.
 */
export function autoPriceRange(refs: readonly number[]): PriceRange {
  const finite = refs.filter((x) => Number.isFinite(x) && x > 0);
  const lo = finite.length ? Math.min(...finite) : 1;
  const hi = finite.length ? Math.max(...finite) : 100;
  const span = hi - lo || hi * 0.3 || 1;
  return { from: Math.max(0, lo - span * 0.35), to: hi + span * 0.35, steps: 121 };
}
