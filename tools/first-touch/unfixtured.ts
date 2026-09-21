/**
 * R3 — the fixture-coverage ratchet (shrink-only, exactly like `known-crashers.ts`).
 *
 * Every public callable that takes ≥2 arguments or carries `.explain` must have a happy-path
 * fixture in `fixtures.ts` so the deep sweep can probe its LATER argument positions and its
 * envelope — the blind spot the arg-0 sweep can never see. A callable without a fixture must be
 * listed here; the deep sweep fails when
 *
 *   - an unlisted, unfixtured callable appears (new exports must ship a fixture), or
 *   - a listed entry gains a fixture or disappears (the ledger only shrinks — delist it).
 *
 * The goal state is EMPTY. Populate fixtures, not this file.
 */

export const UNFIXTURED: ReadonlySet<string> = new Set([]);
