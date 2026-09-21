/**
 * E5 — the ANALYSIS fixture-coverage ratchet (shrink-only, exactly like `unfixtured.ts`).
 *
 * Every `role: 'analysis'` manifest export must have a happy-path fixture so the conformance
 * gate's EXECUTABLE shape check (envelope | report, tools/manifest/conformance.test.ts) actually
 * runs it — an unfixtured analysis export is an UNVERIFIED grammar claim. Aliases are covered by
 * their canonical fixture via function identity, mirroring the deep sweep.
 *
 * An analysis export without a fixture must be listed here; the gate fails when
 *   - an unlisted, unfixtured analysis export appears (new exports must ship a fixture), or
 *   - a listed entry gains a fixture or stops being an analysis export (shrink-only — delist it).
 *
 * The goal state is EMPTY. Populate fixtures, not this file.
 */

// EMPTY as of E5: every analysis export is fixtured (or honestly reclassified) — the
// executable envelope|report shape check runs against ALL of them. Keep empty.
export const UNFIXTURED_ANALYSIS: ReadonlySet<string> = new Set([]);
