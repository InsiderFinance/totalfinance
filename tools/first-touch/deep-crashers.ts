/**
 * R3 — the deep-sweep ratchet (shrink-only, exactly like `known-crashers.ts`).
 *
 * Paths listed here are callables whose LATER argument positions, partial-object inputs, or
 * `.explain()` envelopes still violate the law (a non-QuantError throw, a non-Computed envelope,
 * or an undisclosed NaN). The deep sweep fails when an UNLISTED path violates, and when a LISTED
 * path stops violating (delist it — the ratchet only shrinks). The goal state is EMPTY, and the
 * lock test in `deep-sweep.test.ts` keeps it there.
 */

export const DEEP_CRASHERS: ReadonlySet<string> = new Set([]);
