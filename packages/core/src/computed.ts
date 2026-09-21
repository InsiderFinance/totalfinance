/** The rich result envelope returned by every pro API (spec §5.2). */

import type { Assumptions } from './assumptions.js';
import type { Diagnostics } from './diagnostics.js';
import type { Provenance } from './provenance.js';

export interface Computed<T, Extra extends Record<string, unknown> = Record<never, never>> {
  /**
   * The computed value. Never `NaN` or `±Infinity`: a value the model cannot produce is `null`
   * beside a diagnostic that says why (Law 7 — a warning never licenses a non-finite number).
   */
  value: T;
  /** Every applied convention, echoed back. */
  assumptions: Assumptions<Extra>;
  /** How the value was computed, plus any warnings. */
  diagnostics: Diagnostics;
  /** Optional data lineage when the inputs came from a provider. */
  provenance?: Provenance;
}

/**
 * C (hygiene): the one question a caller asks of any envelope — may I act on this number? A result
 * is trustworthy when its iterative procedure converged (or none ran: `converged` absent) and no
 * warning is an error. `converged` lives on `diagnostics` everywhere; a result that also reports it
 * in its value mirrors the diagnostics slot, so this reads one place.
 */
export function isTrustworthy(result: unknown): boolean {
  // A predicate over an arbitrary value (like `isComputed`): anything that is not an envelope with
  // a diagnostics record is not trustworthy, and never a thrown error.
  if (result === null || typeof result !== 'object') return false;
  const diagnostics = (result as { diagnostics?: unknown }).diagnostics;
  if (diagnostics === null || typeof diagnostics !== 'object') return false;
  const { converged, warnings } = diagnostics as { converged?: unknown; warnings?: unknown };
  if (converged === false) return false;
  if (!Array.isArray(warnings)) return false;
  return !warnings.some(
    (w) =>
      w !== null && typeof w === 'object' && (w as { severity?: unknown }).severity === 'error',
  );
}

/**
 * Runtime guard for the one-envelope law (dx §7.2): a rich result is `Computed` iff it carries
 * `value`, `assumptions.conventionsVersion`, and a `diagnostics.warnings` array. Exported so
 * generic result handlers (and the conformance sweep in CI) can assert the shape.
 */
export function isComputed(value: unknown): value is Computed<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { value?: unknown; assumptions?: unknown; diagnostics?: unknown };
  if (!('value' in v)) return false;
  const a = v.assumptions as { conventionsVersion?: unknown } | undefined;
  if (a === null || typeof a !== 'object' || typeof a.conventionsVersion !== 'string') return false;
  const d = v.diagnostics as { warnings?: unknown } | undefined;
  return d !== null && typeof d === 'object' && Array.isArray(d.warnings);
}
