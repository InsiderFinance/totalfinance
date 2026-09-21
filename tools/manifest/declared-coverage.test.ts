/**
 * NOTHING DECLARED MAY BE ABSENT FROM MEASUREMENT.
 *
 * Union discovery used to be a side effect of synthesis: `enumerateVariants` walked the attempt-zero
 * call and collected whatever unions that walk happened to pass. A minimal baseline omits optional
 * fields ON PURPOSE — that is what makes an `omit-required` probe mean something — so any union
 * inside one was not measured, and not unmeasured either. It was absent, and nothing in the artifact
 * said so.
 *
 * A declaration-to-generator audit found 18 public paths across eight scoped callables reaching fewer
 * union nodes than they declare, and six of them published `enforced` with no alternatives at all
 * while declaring a nested union. `researchProtocol` is the clearest: `trials` declares two shapes,
 * and its row claimed enforcement of a contract whose alternatives had never been built.
 *
 * A confident verdict about a surface never touched is the worst failure available here — worse than
 * a wrong verdict, because a wrong verdict is visible. These gates make the claim checkable:
 *
 *   1. every union node the DECLARATION offers is reachable by enumeration;
 *   2. a measured boundary that declares alternatives publishes them;
 *   3. every published alternative is either measured or explicitly `unmeasured` — never dropped.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  declaredSites,
  enumerateVariants,
  normalizeSelection,
  realizationGaps,
  resetSynthesisIdentities,
  synthesizeArguments,
  type SynthesisParameter,
} from './contract-synthesis.js';

const contracts = JSON.parse(
  readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
) as {
  contracts: {
    id: string;
    fields?: string[];
    signatures?: { parameters?: SynthesisParameter[] }[];
  }[];
};

const enforcement = JSON.parse(
  readFileSync(fileURLToPath(new URL('./public-enforcement.json', import.meta.url)), 'utf8'),
) as {
  enforcement: {
    id: string;
    verdict: string;
    measurementSource?: string;
    inheritedFrom?: string;
    alternatives?: {
      id: string;
      verdict: string;
      unmeasuredReason?: string;
      /** Present when the evidence came from a HAND FIXTURE rather than from synthesis. */
      fixtureSource?: string;
    }[];
    alternativeSummary?: { total: number; truncated?: boolean };
  }[];
};

/**
 * How long a WHOLE-LIBRARY sweep may take. See the note on the first sweep below.
 *
 * ~20s alone, 46s under a full-suite run competing for CPU — against vitest's 45s default, which was
 * never chosen for a test that re-derives every variant of every record. It failed on the clock while
 * asserting nothing, which reads as a defect in the measurement and is a defect in the budget.
 *
 * Re-measured 2026-08-29 (FC7 slice 5): the lifecycle grammar widened the portfolio event envelope
 * to twenty-two families with nested unions; the sweep went to ~267s alone and failed the 180s
 * budget while asserting nothing — the same defect in the same place. Memoizing one derivation per
 * declaration (`sweepRecord`) brought it to ~144s alone and made the second sweep a cache replay.
 * 600s is ~4x that solo measurement (the earlier contended/solo ratio was ~2.3x); a sweep that
 * genuinely hangs still fails, one that is merely sharing a machine does not.
 */
// Stage 7A slice 4 (2026-09-03): measured 412 s (gates) and 425 s (a full coverage run) once
// @totalfinance/workflows, @totalfinance/cli, and their contracts joined the sweep; the second coverage
// pass crossed 600 s under load. 900 s from the measurement — the sweep is memoized, so the
// ceiling bounds one derivation per declaration, not repeated work.
const WHOLE_LIBRARY_SWEEP_MS = 900_000;

const parametersOf = (id: string): SynthesisParameter[] =>
  contracts.contracts.find((record) => record.id === id)?.signatures?.[0]?.parameters ?? [];

/**
 * ONE DERIVATION PER DECLARATION.
 *
 * Re-deriving a record's variants depends only on its DECLARATION (parameters + fields) and on
 * which variants are skipped as hand-fixtured — the identity counter is reset per record, so two
 * records with the same declaration and the same skip set derive byte-identical calls. The umbrella
 * publishes every portfolio head under three spellings, and the FC7 slice-5 lifecycle grammar
 * (twenty-two event families with nested unions) made each envelope-bearing record ~13× costlier
 * to re-derive: the whole-library sweep went from ~20 s to ~267 s run alone (2026-08-29), past its
 * own budget while asserting the same facts three times over. Memoizing by declaration keeps the
 * sweep EXACT (same enumeration, same synthesis, same gaps — replayed under each spelling's id) and
 * returns it to the budget. The residual allowlists below stay keyed per record id, so nothing a
 * spelling used to pin is pinned less.
 */
interface SweptVariant {
  id: string;
  /** Skipped: measured from a hand fixture, so re-deriving it says nothing about the measurement. */
  fixtured: boolean;
  /** Synthesis built a call for it (an unbuildable variant is `no-input`, a different finding). */
  built: boolean;
  gaps: { named: string; built: string | null }[];
}
const sweepCache = new Map<string, SweptVariant[]>();
function sweepRecord(
  record: (typeof contracts.contracts)[number],
  fixturedKeys: ReadonlySet<string>,
): SweptVariant[] {
  const parameters = record.signatures?.[0]?.parameters ?? [];
  const fields = record.fields ?? [];
  const declarationKey = JSON.stringify([parameters, fields]);
  const enumerationKey = `enumerate|${declarationKey}`;
  let enumerated = sweepCache.get(enumerationKey)?.map((v) => v.id);
  if (enumerated === undefined) {
    enumerated = enumerateVariants(parameters, fields).variants.map((variant) => variant.id);
    sweepCache.set(
      enumerationKey,
      enumerated.map((id) => ({ id, fixtured: false, built: false, gaps: [] })),
    );
  }
  if (enumerated.length <= 1) return [];
  const fixturedIds = enumerated.filter((id) => fixturedKeys.has(`${record.id} :: ${id}`));
  const key = `${declarationKey}|${fixturedIds.join(',')}`;
  const cached = sweepCache.get(key);
  if (cached !== undefined) return cached;
  // A clean identity counter per DERIVATION — the same rule the generator follows (see below).
  resetSynthesisIdentities();
  const variants = enumerateVariants(parameters, fields).variants;
  const fixturedSet = new Set(fixturedIds);
  const swept: SweptVariant[] = variants.map((variant) => {
    if (fixturedSet.has(variant.id))
      return { id: variant.id, fixtured: true, built: false, gaps: [] };
    const args = synthesizeArguments(parameters, fields, 0, undefined, variant.selection);
    if (args === null) return { id: variant.id, fixtured: false, built: false, gaps: [] };
    return {
      id: variant.id,
      fixtured: false,
      built: true,
      gaps: realizationGaps(parameters, fields, undefined, variant.selection, args).map((gap) => ({
        named: gap.named,
        built: gap.built ?? null,
      })),
    };
  });
  sweepCache.set(key, swept);
  return swept;
}

/**
 * Every union node reachable under ANY selection — the declaration's own answer to "how many
 * alternatives does this contract offer", computed without building anything.
 */
function everyDeclaredSite(parameters: readonly SynthesisParameter[]): Set<string> {
  const keys = new Set<string>();
  const queue = [normalizeSelection(parameters, new Map())];
  for (let step = 0; step < 512 && queue.length > 0; step += 1) {
    const selection = queue.shift()!;
    for (const site of declaredSites(parameters, selection)) {
      for (const alternative of site.alternatives) {
        const next = normalizeSelection(parameters, new Map(selection).set(site.key, alternative));
        const unseen = declaredSites(parameters, next).filter((entry) => !keys.has(entry.key));
        if (keys.has(site.key) && unseen.length === 0) continue;
        keys.add(site.key);
        for (const entry of unseen) keys.add(entry.key);
        if (unseen.length > 0) queue.push(next);
      }
    }
  }
  return keys;
}

describe('the declaration is the source of truth for what must be measured', () => {
  // Stage 7A slice 3 (2026-09-03): measured 41.3 s idle once @totalfinance/workflows and @totalfinance/cli
  // joined the sweep; the 45 s default flaked under CI load. Bound by the sweep constant like its
  // siblings, from the measurement — not a blank cheque.
  it(
    'reaches every union node the declaration offers, for every public contract',
    () => {
      /**
       * The gate the review asked for: expected sites versus reached sites. A contract whose
       * enumeration reaches fewer nodes than it declares is measuring a subset and reporting a whole.
       */
      const short: string[] = [];
      for (const record of contracts.contracts) {
        const parameters = record.signatures?.[0]?.parameters ?? [];
        const declared = everyDeclaredSite(parameters);
        if (declared.size === 0) continue;
        const reached = new Set<string>();
        for (const variant of enumerateVariants(parameters, record.fields ?? []).variants) {
          for (const key of variant.selection.keys()) reached.add(key);
        }
        const missing = [...declared].filter((key) => !reached.has(key));
        if (missing.length > 0) short.push(`${record.id}: ${missing.length} of ${declared.size}`);
      }
      expect(short, 'declared union nodes never reach measurement').toEqual([]);
    },
    WHOLE_LIBRARY_SWEEP_MS,
  );

  it('publishes alternatives for every measured boundary that declares more than one', () => {
    /**
     * The artifact half. `researchProtocol` was `enforced` with no alternatives while declaring a
     * nested union — the row said "this contract is fully enforced" about branches nothing had built.
     *
     * Scoped to MEASURED rows: an `unmeasured` boundary published no alternatives because it produced
     * no measurement at all, and that is already stated by its verdict and reason.
     */
    /**
     * UNMEASURED ROWS ARE NOT EXEMPT.
     *
     * Skipping them let `defineIndicator` publish one row-level `callback-input-required` and no
     * alternatives at all, while declaring several — so the spec said "measured or explicitly
     * unmeasured, never absent" and the gate enforced it only for the measured half. A claim that
     * holds where it is easy is not the claim.
     */
    const silent: string[] = [];
    for (const row of enforcement.enforcement) {
      // Attributed rows carry their canonical's evidence; the canonical is where the claim is tested.
      if (row.measurementSource !== undefined || row.inheritedFrom !== undefined) continue;
      const parameters = parametersOf(row.id);
      if (parameters.length === 0) continue;
      const variants = enumerateVariants(parameters, []).variants.length;
      if (variants <= 1) continue;
      if (!row.alternatives || row.alternatives.length === 0) {
        silent.push(`${row.id} declares ${variants} alternatives and publishes none`);
      }
    }
    expect(silent, 'a measured boundary hid its declared alternatives').toEqual([]);
  });

  it('records every published alternative with a verdict — measured or explicitly unmeasured', () => {
    // "Never absent" is the whole rule. An alternative the harness cannot build is `unmeasured`,
    // which already denies the boundary `enforced`; one that is missing says nothing at all.
    const bad: string[] = [];
    for (const row of enforcement.enforcement) {
      for (const alternative of row.alternatives ?? []) {
        if (!alternative.verdict) bad.push(`${row.id} / ${alternative.id}`);
      }
      const summary = row.alternativeSummary;
      if (summary && row.alternatives && summary.total !== row.alternatives.length) {
        bad.push(`${row.id}: summary says ${summary.total}, ${row.alternatives.length} published`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('names the eight callables the audit found short, and finds them whole', () => {
    /**
     * The regression fixtures, by name. Each declared union nodes the generator never reached; the
     * audit is in the review, and this is the part of it that stays.
     */
    const audited = [
      '@totalfinance/backtest:optionsBacktest',
      '@totalfinance/fixed-income:curves.bootstrapMultiCurve',
      '@totalfinance/risk:researchProtocol',
      '@totalfinance/strategy:Position#whatIfCube',
      '@totalfinance/technical-analysis:defineIndicator',
      '@totalfinance/technical-analysis:register',
      '@totalfinance/volatility:VolatilitySurface.fromJSON',
      '@totalfinance/volatility:surfaceLocalVolatility',
    ];
    for (const id of audited) {
      const parameters = parametersOf(id);
      expect(parameters.length, `${id} vanished from the inventory`).toBeGreaterThan(0);
      const declared = everyDeclaredSite(parameters);
      expect(declared.size, `${id} declares no union — the fixture has gone stale`).toBeGreaterThan(
        0,
      );
      const variants = enumerateVariants(parameters, []).variants;
      const reached = new Set(variants.flatMap((variant) => [...variant.selection.keys()]));
      expect(
        [...declared].filter((key) => !reached.has(key)),
        `${id} still short`,
      ).toEqual([]);
    }
  });
});

describe('a variant must REALIZE the branch it names', () => {
  /**
   * The gate the previous one should have been.
   *
   * `declared-coverage`'s first test compares declaration-derived selection keys against
   * enumerator-derived selection keys — both produced by the same walker — so it can only ever
   * confirm the enumerator agrees with itself. It never asks whether the CALL reaches the branch,
   * and that is precisely where the evidence broke: both `researchProtocol.trials` variants
   * synthesized the identical request, with no `trials` property at all, and one was published
   * `enforced`.
   *
   * This reads the two sides from genuinely different places: expected from the DECLARATION, observed
   * from the ARGUMENTS actually built. A variant that fails it is not a wrong verdict — it is a
   * verdict about a call that was never made.
   */
  /**
   * AN EXPLICIT BUDGET, because the default was never chosen for a whole-library sweep.
   *
   * This re-derives every variant of every record and compares what each call selects against what it
   * named. Alternatives went from 649 to 2,622 when arms were recorded at every node, and the sweep
   * grew with them: ~20s run alone, 46s under a full-suite run competing for CPU — against vitest's
   * 45s default. It failed on the timeout while asserting nothing, which reads as a defect in the
   * measurement and is a defect in the budget.
   *
   * 180s is ~4x the contended measurement. A sweep that genuinely hangs still fails; one that is
   * merely sharing a machine does not.
   */
  it(
    'every buildable synthesized variant selects what it names, across the whole library',
    async () => {
      /**
       * STRUCTURED identities, because the string version was vacuous.
       *
       * The first cut built `${row.id} / ${alternative.id}` keys and then matched them with
       * `entry.split(':')[0]` — and every record id CONTAINS a colon (`@totalfinance/risk:researchProtocol`),
       * so the split truncated to the package name and could never match. The filtered list was empty
       * on every run, and the gate reported success without comparing anything. A gate that cannot
       * fail is worse than no gate: it occupies the place where a real one would go.
       */
      /**
       * The gate calls the SAME helper the generator does.
       *
       * It used to keep its own copy of the reasoning, and the copy carried the same defect: both
       * compared a site's `scope` — a rendered outcome id — against a map keyed by the internal
       * digested key, a comparison that can never be true. The reverse direction therefore passed
       * everything, including a variant naming a child the call never built. Two oracles are two
       * chances to be wrong about the same thing, and the second one is the one nobody re-reads.
       */
      /**
       * SYNTHESIZED variants only — which is what this test has always been called.
       *
       * The sweep re-derives each call by SYNTHESIS and compares what it selects against what the
       * variant names. That is a valid audit of a synthesized measurement and no audit at all of a
       * hand-fixtured one: `analyzeBook` takes a series of `StrategyPosition`, which synthesis cannot
       * build and a fixture supplies, so re-deriving it produces sixty numbers and every site under
       * the element "goes unrealized" — in a call the harness never made.
       *
       * Fifteen alternatives were convicted that way, and the artifact was right about all fifteen:
       * each carries `fixtureSource`, and the sibling alternative that synthesis genuinely cannot
       * reach is already published `branch-not-realized` next to it. The scope is read from the
       * artifact rather than guessed, and the skipped count is asserted below so this cannot quietly
       * become a gate over nothing.
       */
      const measuredFromFixture = new Set<string>();
      for (const row of enforcement.enforcement) {
        for (const alternative of row.alternatives ?? []) {
          if (alternative.fixtureSource) measuredFromFixture.add(`${row.id} :: ${alternative.id}`);
        }
      }

      const unrealized: { recordId: string; variantId: string; detail: string }[] = [];
      let checked = 0;
      let fixtured = 0;
      let recordsSwept = 0;
      for (const record of contracts.contracts) {
        // This CPU-heavy derivation can otherwise starve Vitest's worker heartbeat for more than a
        // minute and turn a passing release gate into an unhandled RPC timeout.
        if (++recordsSwept % 25 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        /**
         * A CLEAN IDENTITY COUNTER PER RECORD — the same rule the generator follows, and this sweep
         * did not.
         *
         * `uniqueName()` mints `name-1`, `name-2`, … from a module-level counter, so the value built
         * for any field called `name` depends on how much synthesis ran BEFORE it. The generator resets
         * per boundary precisely so measuring a boundary twice yields one record; the sweep reset never,
         * so its results depended on which other test files shared the worker. It passed run alone and
         * failed after `variant-measurement.test.ts` — and the residual allowlist below was therefore
         * only ever valid for one execution order. `sweepRecord` resets before every derivation.
         */
        for (const swept of sweepRecord(record, measuredFromFixture)) {
          if (swept.fixtured) {
            fixtured += 1;
            continue;
          }
          // Unbuildable is a different finding, reported as `no-input`; this is about calls that WERE
          // built.
          if (!swept.built) continue;
          checked += 1;
          for (const gap of swept.gaps) {
            unrealized.push({
              recordId: record.id,
              variantId: swept.id,
              // The allowlist key: record, named outcome, built outcome. Stable across variants,
              // because the same declaration produces the same mismatch under every call that reaches
              // it, and a count of occurrences is not what needs pinning — the SHAPES are.
              detail: `${record.id} | ${gap.named} | ${gap.built ?? 'nothing'}`,
            });
          }
        }
      }
      expect(checked, 'no buildable variants — the realization gate is vacuous').toBeGreaterThan(
        50,
      );
      /**
       * The skipped population is asserted too, in both directions.
       *
       * A scope exclusion that nobody measures is how a gate quietly stops covering its subject: if
       * `fixtureSource` ever stopped being recorded this would silently skip nothing and start
       * convicting fixtured calls again, and if it were recorded too broadly the sweep would shrink to
       * nothing while still reporting success. Both failures are visible here.
       */
      expect(
        fixtured,
        'no fixtured alternatives were skipped — is `fixtureSource` still recorded?',
      ).toBeGreaterThan(0);
      expect(fixtured, 'the fixtured exclusion has swallowed the sweep').toBeLessThan(checked);
      /**
       * The assertion is CONSISTENCY, not zero.
       *
       * The harness does not claim every branch can be materialized — some cannot, and those are
       * published `branch-not-realized`. What it must never do is publish EVIDENCE from a call that
       * did not reach the branch.
       */
      const measured = new Set(
        enforcement.enforcement.flatMap((row) =>
          (row.alternatives ?? [])
            .filter((alternative) => alternative.verdict !== 'unmeasured')
            .map((alternative) => `${row.id}\u0000${alternative.id}`),
        ),
      );
      const published = unrealized.filter((entry) =>
        measured.has(`${entry.recordId}\u0000${entry.variantId}`),
      );
      expect(
        published.map((entry) => `${entry.recordId} / ${entry.variantId}: ${entry.detail}`),
        'a MEASURED alternative was published from a call that does not select it',
      ).toEqual([]);
    },
    WHOLE_LIBRARY_SWEEP_MS,
  );

  it('enumerates ABSENCE and every present branch for an optional union, including branch #0', () => {
    /**
     * Presence is part of identity, so an optional union has (1 + branches) outcomes and not
     * branches-many. Keying dedupe on branch selection alone collapsed "absent" into
     * "present, branch #0" and lost 30 declared outcomes across 17 exported paths — 23 of them the
     * branch-`#0` call, which the enumerator skipped on the old assumption that `#0` was canonical.
     */
    const parameters = parametersOf('@totalfinance/risk:researchProtocol');
    expect(parameters.length).toBeGreaterThan(0);
    const ids = enumerateVariants(parameters, []).variants.map((variant) => variant.id);
    expect(ids.some((id) => id.includes('trials:absent'))).toBe(true);
    expect(ids.some((id) => id.includes('trials:present#0'))).toBe(true);
    expect(ids.some((id) => id.includes('trials:present#1'))).toBe(true);
  });

  it('publishes `branch-not-realized` rather than silently dropping an unbuildable branch', () => {
    /**
     * The other half of "measured or explicitly unmeasured, never absent". Where the harness cannot
     * make a call that reaches a branch, the artifact says so under its own name — distinct from
     * `no-input`, which means nothing could be built at all. The two need different work and one
     * label for both asserted that neither did.
     */
    const notRealized = enforcement.enforcement
      .flatMap((row) => row.alternatives ?? [])
      .filter((alternative) => alternative.unmeasuredReason === 'branch-not-realized');
    expect(
      notRealized.length,
      'no alternative reports `branch-not-realized` — either every branch materializes, which would ' +
        'be news, or the reason is not being emitted',
    ).toBeGreaterThan(0);
    for (const alternative of notRealized) {
      expect(alternative.verdict, `${alternative.id} claims evidence it did not gather`).toBe(
        'unmeasured',
      );
    }
  });

  it('materializes an optional field a variant NAMES, and leaves it out otherwise', () => {
    // The mechanism, on the contract that exposed it. `trials` is optional and carries a union: the
    // canonical call omits it (the minimal baseline an `omit-required` probe depends on) and the
    // variant that names a branch of it builds it.
    const parameters = parametersOf('@totalfinance/risk:researchProtocol');
    expect(parameters.length).toBeGreaterThan(0);
    const variants = enumerateVariants(parameters, []).variants;
    expect(variants.length).toBeGreaterThan(1);
    const present = variants.map((variant) => {
      const args = synthesizeArguments(parameters, [], 0, undefined, variant.selection);
      const first = args?.[0];
      return (
        first !== null &&
        typeof first === 'object' &&
        Object.prototype.hasOwnProperty.call(first, 'trials')
      );
    });
    expect(present[0], 'the canonical call should stay minimal').toBe(false);
    expect(present.slice(1).some(Boolean), 'no variant materialized the optional union').toBe(true);
  });
});

describe('an OPTIONAL ARGUMENT is gated like an optional field', () => {
  it('publishes the omitted call as its own outcome', () => {
    /**
     * Presence gating was written for optional FIELDS and stopped at the parameter list, so
     * `spectralRisk(returns, options?)` published `arg1#0` and `arg1#1` and never the call that omits
     * `options` — the shape every caller writes first, and the one an `omit-required` probe depends
     * on existing.
     */
    const parameters = parametersOf('@totalfinance/risk:spectralRisk');
    expect(parameters.length).toBeGreaterThan(1);
    const variants = enumerateVariants(parameters, []).variants;
    const ids = variants.map((variant) => variant.id);
    expect(ids.some((id) => id.includes('arg1:absent'))).toBe(true);
    expect(ids.some((id) => id.includes('arg1:present#0'))).toBe(true);
    expect(ids.some((id) => id.includes('arg1:present#1'))).toBe(true);

    // And the absent outcome really omits the argument rather than renaming a present one.
    const absent = variants.find((variant) => variant.id.includes('arg1:absent'))!;
    const built = synthesizeArguments(parameters, [], 0, undefined, absent.selection);
    expect(built).not.toBeNull();
    expect(built!.length).toBe(1);
  });

  it(
    'carries the gate scope into the builder, so a named nested branch is the one built',
    async () => {
      /**
       * The enumerator qualifies a union under a present gate as `…:present.…`; the builder had
       * reduced the gate to a bare path and looked the union up unqualified, so a variant naming branch
       * `#1` built branch `#0`. Reported honestly as `branch-not-realized`, and an avoidable generator
       * failure rather than a contract the harness cannot reach.
       *
       * Asserted library-wide through the shared helper: no BUILT call may name one outcome and select
       * another.
       */
      /**
       * SYNTHESIZED variants only, for the same reason as the sweep above: this re-derives the call by
       * synthesis, so it can only speak about calls synthesis made. A hand-fixtured alternative
       * re-derived this way is a different call, and convicting it says nothing about the measurement.
       */
      const fromFixture = new Set<string>();
      for (const row of enforcement.enforcement) {
        for (const alternative of row.alternatives ?? []) {
          if (alternative.fixtureSource) fromFixture.add(`${row.id} :: ${alternative.id}`);
        }
      }
      const seen = new Set<string>();
      let recordsSwept = 0;
      for (const record of contracts.contracts) {
        // A whole-library derivation is CPU-heavy and otherwise monopolizes the Vitest worker for
        // roughly two minutes. Yield periodically so the reporter's `onTaskUpdate` heartbeat can
        // run; a logically passing gate that exits with an RPC timeout is not a usable release gate.
        if (++recordsSwept % 25 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        // One derivation per declaration, identity counter reset per derivation — see `sweepRecord`.
        for (const swept of sweepRecord(record, fromFixture)) {
          if (swept.fixtured || !swept.built) continue;
          for (const gap of swept.gaps) {
            /**
             * `built: null` IS A MISMATCH and belongs in the key.
             *
             * Skipping it meant "named a branch, selected NOTHING" was never ratcheted — a regression
             * of exactly that shape (an optional tuple-union field whose variants omit it entirely)
             * could arrive without failing anything. The two outcomes want the same treatment: a call
             * that does not select what it names is a call that does not select what it names, whether
             * it selected something else or selected nothing at all.
             */
            seen.add(`${record.id} :: ${swept.id} :: ${gap.named} :: ${gap.built ?? 'nothing'}`);
          }
        }
      }
      /**
       * AN EXACT ALLOWLIST, keyed by VARIANT as well as record.
       *
       * `mismatches <= 27` let one new mismatch replace one repaired one — a ratchet that counts can be
       * satisfied by arithmetic. With `variant.id` in the key the list is one entry per occurrence, and
       * every repair or regression is visible individually.
       *
       * 103 occurrences, against 36 before arms were recorded at every node — and the comparison is not
       * like-for-like, because the alternatives they are drawn from went from 649 to 2,582. Recording
       * every union's arms made whole grammars reachable that the enumeration could not previously
       * name, and a reachable alternative the builder cannot construct is visible HERE rather than
       * absent everywhere.
       *
       * THREE mechanisms, all the builder declining to materialize what a variant named:
       *
       *   59 are a PRESENCE GATE named `present` and built `absent`. The gate decides whether an
       *   optional field appears; the variant names it present and the builder leaves it out —
       *   `createTotalFinanceMcpServer`'s `tools`, `priceMany`'s `engine`, `monteCarlo`'s
       *   `randomNumberGenerator`. Where the gate sits inside a callback's RETURN the stub is built
       *   before any selection reaches it, which is the same cause one level further in.
       *
       *   18 name a union whose route the call cannot reach at all (`:: nothing`) — a union under an
       *   element or argument synthesis could not build, so there is no value at that path to select.
       *
       *   26 select a DIFFERENT arm than named, all of them nested one arm deep (`arg0.signal#0#1`
       *   building `#0`): choosing an outer arm and then an inner one is two selections against one
       *   built value, and the inner is applied to whichever outer arm the builder reached.
       *
       * Every one is published `branch-not-realized`, so no evidence rests on any of them, and the
       * gate above proves separately that no MEASURED alternative comes from an unrealized call.
       */
      /**
       * Exact Gate-C observation-union residuals inherited by a package that publishes a concrete
       * `Pricer` instantiation. The builder can enumerate all seven observation arms but cannot
       * steer the nested distributive mapped type to the named arm; runtime enforcement comes from
       * the package's hand fixture instead. Keep every branch and shape digest explicit so a new arm
       * cannot hide behind a package-level prefix, and let the stale-entry check below retire these
       * automatically when the builder learns to steer them.
       */
      const gateCObservationResiduals = (pkg: string): string[] => {
        const residuals: string[] = [];
        for (const method of ['price', 'priceBatch']) {
          const head = `${pkg}:Pricer#${method}`;
          for (const branch of [0, 1, 2, 3, 5]) {
            residuals.push(
              `${head} :: arg0.observations#${branch} :: arg0.observations~170iub#${branch} :: nothing`,
            );
          }
          for (const valueBranch of [0, 1]) {
            const selection = `arg0.observations#4 & arg0.observations#4.value#${valueBranch}`;
            residuals.push(
              `${head} :: ${selection} :: arg0.observations~170iub#4 :: nothing`,
              `${head} :: ${selection} :: arg0.observations#4.value~rx37ry#${valueBranch} :: nothing`,
            );
          }
          for (let compoundingBranch = 0; compoundingBranch < 7; compoundingBranch++) {
            const selection =
              `arg0.observations#6 & ` +
              `arg0.observations#6.value.compounding#${compoundingBranch}`;
            residuals.push(
              `${head} :: ${selection} :: arg0.observations~170iub#6 :: nothing`,
              `${head} :: ${selection} :: ` +
                `arg0.observations#6.value.compounding~10fc3y0#${compoundingBranch} :: nothing`,
            );
          }
        }
        return residuals;
      };

      const ALLOWED_RESIDUAL = new Set([
        ...gateCObservationResiduals('@totalfinance/fixed-income'),
        ...gateCObservationResiduals('@totalfinance/scenarios'),
        // R06/R07 repair (2026-09-07): PaperBroker#deliver now accepts persisted normalized fills
        // and instrument terms. Their optional DerivativeContractTerms each reach the declaration
        // depth frontier: OptionContractTerms / FutureContractTerms / PerpetualContractTerms are
        // explicitly `truncated`, without fields or discriminators. The builder omits the nested
        // contract gate instead of inventing a selected arm — the same truncated-contract residual
        // as the FC7 ledger envelopes below, NOT a caller-callback return union or stale fixture.
        // Bound all six identities exactly; the stale-entry check retires them if synthesis improves.
        // Runtime persisted terms and normalized late fills are independently exercised in
        // packages/backtest/test/paper-restart.test.ts; no evidence is attributed to these calls.
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:present & arg0.event.detail.fill:present.contract:present & arg0.event.detail.fill:present.contract:present#0 & arg0.event.detail.instrument:absent :: arg0.event.detail.fill:present.contract!gate:present :: arg0.event.detail.fill:present.contract!gate:absent',
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:absent & arg0.event.detail.instrument:present & arg0.event.detail.instrument:present.contract:present & arg0.event.detail.instrument:present.contract:present#0 :: arg0.event.detail.instrument:present.contract!gate:present :: arg0.event.detail.instrument:present.contract!gate:absent',
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:present & arg0.event.detail.fill:present.contract:present & arg0.event.detail.fill:present.contract:present#1 & arg0.event.detail.instrument:absent :: arg0.event.detail.fill:present.contract!gate:present :: arg0.event.detail.fill:present.contract!gate:absent',
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:present & arg0.event.detail.fill:present.contract:present & arg0.event.detail.fill:present.contract:present#2 & arg0.event.detail.instrument:absent :: arg0.event.detail.fill:present.contract!gate:present :: arg0.event.detail.fill:present.contract!gate:absent',
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:absent & arg0.event.detail.instrument:present & arg0.event.detail.instrument:present.contract:present & arg0.event.detail.instrument:present.contract:present#1 :: arg0.event.detail.instrument:present.contract!gate:present :: arg0.event.detail.instrument:present.contract!gate:absent',
        '@totalfinance/backtest:PaperBroker#deliver :: arg0.event.detail.fill:absent & arg0.event.detail.instrument:present & arg0.event.detail.instrument:present.contract:present & arg0.event.detail.instrument:present.contract:present#2 :: arg0.event.detail.instrument:present.contract!gate:present :: arg0.event.detail.instrument:present.contract!gate:absent',
        // 2026-09-03 (Stage 4.6 slice 1): the fill-model callback (`FillModel#fill`) returns the
        // `filled | unfilled` decision union, and the fixture model decides `filled` for the fixture's
        // inputs — the builder cannot make the callback return a named `unfilled` reason without
        // authoring a second model per arm, so these eight arms × three heads (the conformance suite,
        // the policy description, `execution.declared`) are unmeasured by construction. The unfilled
        // reasons are exercised directly in packages/backtest/test/execution.test.ts.
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=halted & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=halted :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=insufficient-depth & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=insufficient-depth :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=locked-crossed & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=locked-crossed :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=no-observation & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=no-observation :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=not-triggered & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=not-triggered :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=stale-quote & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=stale-quote :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=wrong-observation-kind & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=wrong-observation-kind :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:assertFillModelConformance :: arg0.fillModel.fill:outcome=unfilled,reason=zero-quantity & arg0.fixtures:absent :: arg0.fillModel.fill~1cx6g82:outcome=unfilled,reason=zero-quantity :: arg0.fillModel.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=halted :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=halted :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=insufficient-depth :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=insufficient-depth :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=locked-crossed :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=locked-crossed :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=no-observation :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=no-observation :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=not-triggered :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=not-triggered :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=stale-quote :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=stale-quote :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=wrong-observation-kind :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=wrong-observation-kind :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:describeExecutionPolicy :: arg0.fill.fill:outcome=unfilled,reason=zero-quantity :: arg0.fill.fill~1cx6g82:outcome=unfilled,reason=zero-quantity :: arg0.fill.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=halted :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=halted :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=insufficient-depth :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=insufficient-depth :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=locked-crossed :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=locked-crossed :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=no-observation :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=no-observation :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=not-triggered :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=not-triggered :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=stale-quote :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=stale-quote :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=wrong-observation-kind :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=wrong-observation-kind :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        '@totalfinance/backtest:execution.declared :: arg0.fill:present & arg0.fill:present.fill:outcome=unfilled,reason=zero-quantity :: arg0.fill:present.fill~1cx6g82:outcome=unfilled,reason=zero-quantity :: arg0.fill:present.fill~1cx6g82:outcome=filled',
        // The readonly callback projection is the same seven-arm observation grammar nested under
        // another discriminated callback request. This exact first-arm row is unmeasured and the
        // factor-handler integration tests exercise all supported return validation instead.
        // Stage 4.6 slice 2 (2026-09-03): fingerprint moved (~18aepqh → ~bpvn7p) when the backtest
        // package's declaration walk grew — the same residual, re-keyed.
        '@totalfinance/scenarios:ScenarioFactorHandler#apply :: arg0.instruction:kind=absolute & arg0.observations#0 & arg0.observations#0.value#0 & arg0.target:valuationMethod=taylor :: arg0.observations~bpvn7p#0 :: nothing',
        // 2026-08-29 (FC7 slice 5): the lifecycle grammar widened the event envelope to
        // twenty-two families with nested unions (a fill's `contract` terms, an exercise's or
        // assignment's `settlement`, a roll's successor `contract`). The `contract` union sits
        // below the inventory's field-tree depth (recorded `truncated`, so no branch carries a
        // discriminator) and a nested `settlement`/`contract` gate under a discriminated arm is the
        // same one-gate-per-call route as the rows below — the builder realizes the outer arm and
        // the inner selection lands on whichever inner arm it reached. Every row is published
        // `branch-not-realized`; every family and contract kind is exercised end-to-end in
        // packages/portfolio/test/lifecycle-foundation.test.ts, lifecycle-derivatives.test.ts, and
        // lifecycle-corporate.test.ts. Staleness-gated like the rest.
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#12 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#13 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#14 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#15 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#16 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#17 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#18 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#19 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#20 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#21 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#22 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#23 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#24 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        '@totalfinance/portfolio:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#12 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#13 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#14 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#15 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#16 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#17 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#18 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#19 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#20 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#21 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#22 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#23 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#24 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.applyPortfolioEvents :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.createPortfolioLedger :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#12 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#13 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#14 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#15 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#16 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#17 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#18 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#19 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#20 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#21 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#22 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#23 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#24 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolio.portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#0 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize & arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.exercise,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis & arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=fold-into-underlying-basis.settlement~w11ak9#0',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize & arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#1 :: arg0.events.event:eventType=derivative.assignment,premiumTreatment=realize.settlement~w11ak9#0',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#0 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=buy & arg0.events.event:eventType=trade.fill,side=buy.contract:present & arg0.events.event:eventType=trade.fill,side=buy.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=buy.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#1 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=trade.fill,side=sell & arg0.events.event:eventType=trade.fill,side=sell.contract:present & arg0.events.event:eventType=trade.fill,side=sell.contract:present#2 :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:present :: arg0.events.event:eventType=trade.fill,side=sell.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#1 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        'totalfinance:portfolioLedgerContentHash :: arg0.events.event:eventType=derivative.roll & arg0.events.event:eventType=derivative.roll.contract:present & arg0.events.event:eventType=derivative.roll.contract:present#2 :: arg0.events.event:eventType=derivative.roll.contract!gate:present :: arg0.events.event:eventType=derivative.roll.contract!gate:absent',
        // 2026-08-29 (FC7 slice 4): two generic builder routes, both published
        // `branch-not-realized` and staleness-gated like the rest. (a) `monitorPortfolio` takes an
        // optional `reconciliation` companion — a PRODUCED report whose synthesized form cannot be
        // made internally consistent (verdict vs counts, instant, base currency), so the builder's
        // `reconciliation!gate:present` call lands absent; the family is measured end-to-end in
        // packages/portfolio/test/monitor.test.ts with a real reconcilePortfolio result.
        // (b) `estimateExpectedReturns` declares `observationTimestamps: (number | string)[]` — an
        // element-level union under an optional field, the same one-arm-per-call route as the
        // element rows below; both arms are exercised directly in
        // packages/risk/test/expected-returns.test.ts.
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#0 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#1 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#2 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#3 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#4 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#5 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#6 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#7 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#8 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#9 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#10 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/portfolio:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#11 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        '@totalfinance/risk:estimateExpectedReturns :: arg0:method=historical-mean & arg0:method=historical-mean.asOf:absent & arg0:method=historical-mean.observationTimestamps:present & arg0:method=historical-mean.observationTimestamps:present#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#1',
        '@totalfinance/risk:estimateExpectedReturns :: arg0:method=exponentially-weighted & arg0:method=exponentially-weighted.asOf:absent & arg0:method=exponentially-weighted.observationTimestamps:present & arg0:method=exponentially-weighted.observationTimestamps:present#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#1',
        'totalfinance:estimateExpectedReturns :: arg0:method=historical-mean & arg0:method=historical-mean.asOf:absent & arg0:method=historical-mean.observationTimestamps:present & arg0:method=historical-mean.observationTimestamps:present#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#1',
        'totalfinance:estimateExpectedReturns :: arg0:method=exponentially-weighted & arg0:method=exponentially-weighted.asOf:absent & arg0:method=exponentially-weighted.observationTimestamps:present & arg0:method=exponentially-weighted.observationTimestamps:present#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#1',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#0 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#1 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#2 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#3 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#4 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#5 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#6 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#7 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#8 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#9 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#10 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#11 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#0 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#1 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#2 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#3 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#4 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#5 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#6 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#7 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#8 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#9 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#10 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:portfolio.monitorPortfolio :: arg0.asOf#0 & arg0.market.conventions.compounding:absent & arg0.policy.benchmark:absent & arg0.policy.model:absent & arg0.reconciliation:present & arg0.reconciliation:present.suggestedCorrections.event#11 :: arg0.reconciliation!gate:present :: arg0.reconciliation!gate:absent',
        'totalfinance:risk.estimateExpectedReturns :: arg0:method=historical-mean & arg0:method=historical-mean.asOf:absent & arg0:method=historical-mean.observationTimestamps:present & arg0:method=historical-mean.observationTimestamps:present#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#0 :: arg0:method=historical-mean.observationTimestamps:present~rx37ry#1',
        'totalfinance:risk.estimateExpectedReturns :: arg0:method=exponentially-weighted & arg0:method=exponentially-weighted.asOf:absent & arg0:method=exponentially-weighted.observationTimestamps:present & arg0:method=exponentially-weighted.observationTimestamps:present#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#0 :: arg0:method=exponentially-weighted.observationTimestamps:present~rx37ry#1',
        // 2026-08-28 (FC7 slice 2): `ledger.pnl` takes TWO marks, each with an optional
        // `market.conventions.compounding`; the declaration names a gate on one mark while the
        // other mark's gate is absent, and the builder realizes one side per call — the same
        // one-gate-per-call generic route as the rows below. Staleness-gated like the rest.
        '@totalfinance/portfolio:PortfolioLedger#pnl :: arg0.from.market.conventions.compounding:present & arg0.from.market.conventions.compounding:present#6 & arg0.to.market.conventions.compounding:absent :: arg0.from.market.conventions.compounding!gate:present :: arg0.from.market.conventions.compounding!gate:absent',
        '@totalfinance/portfolio:PortfolioLedger#pnl :: arg0.from.market.conventions.compounding:absent & arg0.to.market.conventions.compounding:present & arg0.to.market.conventions.compounding:present#6 :: arg0.to.market.conventions.compounding!gate:present :: arg0.to.market.conventions.compounding!gate:absent',
        // 2026-08-23: the review-wave discount-curve identity work (curveId on
        // DiscountCurveRequirement, full curve-value validation) reshaped the MarketObservation
        // union, so every `~124wy4m` route re-fingerprinted to `~175xsnz` (same named arms, new
        // shape hash) and the `requireObservationValue`/`optionalObservationValue` value union
        // gained one arm. The staleness gate below proved the old rows dead before they were
        // deleted, and retires these the day they stop occurring.
        // 2026-09-18: `~175xsnz` re-fingerprinted to `~170iub` with the SAME seven named arms —
        // the checker's type-id order moved the dividendYield and impliedVolatility arms from
        // positions 2/3 to 3/2 when core's export list changed (pre-publish repairs A7 added
        // `isOccOptionSymbol`), so every route below swaps `#2`/`#3` and carries the new digest.
        // Nothing about the union's declaration or its runtime behaviour changed.
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=discountCurve :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=dividendYield :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=forward :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=impliedVolatility :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=riskFreeRate :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#0 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#1 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#1 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#3 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#3 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#2 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#2 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#4 & arg0.observations#4.value#0 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#4 & arg0.observations#4.value#1 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#5 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#5 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#0 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#1 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#2 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#3 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#4 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#5 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:missingRequirements :: arg0.observations#6 & arg0.observations#6.value.compounding#6 & arg0.requirements:kind=valuationInstant :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/core:optionalObservationValue :: arg2#5 :: arg2~esyxa8#5 :: arg2~esyxa8#1',
        '@totalfinance/core:requireObservationValue :: arg2#5 :: arg2~esyxa8#5 :: arg2~esyxa8#1',
        '@totalfinance/options:Pricer#price :: arg0.observations#0 :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#1 :: arg0.observations~170iub#1 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#3 :: arg0.observations~170iub#3 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#2 :: arg0.observations~170iub#2 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#4 & arg0.observations#4.value#0 :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#4 & arg0.observations#4.value#1 :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#5 :: arg0.observations~170iub#5 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#0 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#1 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#2 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#3 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#4 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#5 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#6 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#0 :: arg0.observations~170iub#0 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#1 :: arg0.observations~170iub#1 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#3 :: arg0.observations~170iub#3 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#2 :: arg0.observations~170iub#2 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#4 & arg0.observations#4.value#0 :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#4 & arg0.observations#4.value#1 :: arg0.observations~170iub#4 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#5 :: arg0.observations~170iub#5 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#0 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#1 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#2 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#3 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#4 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#5 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#6 :: arg0.observations~170iub#6 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#0 :: arg0.observations#6.value.compounding~10fc3y0#0 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#1 :: arg0.observations#6.value.compounding~10fc3y0#1 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#2 :: arg0.observations#6.value.compounding~10fc3y0#2 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#3 :: arg0.observations#6.value.compounding~10fc3y0#3 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#4 :: arg0.observations#6.value.compounding~10fc3y0#4 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#5 :: arg0.observations#6.value.compounding~10fc3y0#5 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#6 & arg0.observations#6.value.compounding#6 :: arg0.observations#6.value.compounding~10fc3y0#6 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#0 :: arg0.observations#6.value.compounding~10fc3y0#0 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#1 :: arg0.observations#6.value.compounding~10fc3y0#1 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#2 :: arg0.observations#6.value.compounding~10fc3y0#2 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#3 :: arg0.observations#6.value.compounding~10fc3y0#3 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#4 :: arg0.observations#6.value.compounding~10fc3y0#4 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#5 :: arg0.observations#6.value.compounding~10fc3y0#5 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#6 & arg0.observations#6.value.compounding#6 :: arg0.observations#6.value.compounding~10fc3y0#6 :: nothing',
        /**
         * Gate C (2026-08-20): the pricing protocol's `MarketObservation`/`MarketRequirement`
         * distributive unions — seven named requirement/value arms whose selection the
         * gate-scoped builder cannot steer (the FC2 named-arm-in-nested-structure class, met
         * again across every head and spelling that carries the union). The boundaries are
         * measured ENFORCED via hand fixtures and every arm's grammar is exercised by
         * `packages/core/test/pricing.test.ts`; only the builder cannot NAME the arm it built.
         * The `classifyStrategy` rows are the exported-strategy-types fingerprint MOVE
         * (~1g4d1p0 spellings) — the same mismatch as before under a new digest, re-derived
         * rather than patched.
         */
        '@totalfinance/options:Pricer#price :: arg0.observations#4 & arg0.observations#4.value#0 :: arg0.observations#4.value~rx37ry#0 :: nothing',
        '@totalfinance/options:Pricer#price :: arg0.observations#4 & arg0.observations#4.value#1 :: arg0.observations#4.value~rx37ry#1 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#4 & arg0.observations#4.value#0 :: arg0.observations#4.value~rx37ry#0 :: nothing',
        '@totalfinance/options:Pricer#priceBatch :: arg0.observations#4 & arg0.observations#4.value#1 :: arg0.observations#4.value~rx37ry#1 :: nothing',
        '@totalfinance/options:optionContractPricer :: arg0:present & arg0:present.engine:present & arg0:present.engine:present.price.greeks:absent :: arg0:present.engine!gate:present :: arg0:present.engine!gate:absent',
        '@totalfinance/options:optionContractPricer :: arg0:present & arg0:present.engine:present & arg0:present.engine:present.price.greeks:present & arg0:present.engine:present.price.greeks:present#0 :: arg0:present.engine!gate:present :: arg0:present.engine!gate:absent',
        '@totalfinance/options:optionContractPricer :: arg0:present & arg0:present.engine:present & arg0:present.engine:present.price.greeks:present & arg0:present.engine:present.price.greeks:present#1 :: arg0:present.engine!gate:present :: arg0:present.engine!gate:absent',
        /**
         * RE-SEATED 2026-08-13. Most identities MOVED without their subject moving: these ids embed a
         * shape digest, and `canonicalNode` gained two facts this round — `truncated`, and literal
         * domains serialised with their types so `1` and `'1'` stop sharing a fingerprint. A digest that
         * changes when the shape model changes is the digest working; the list is re-derived rather than
         * patched so it stays an exact set rather than an accumulating one.
         *
         * Two entries are genuinely new and both are the numeric literal domain arriving:
         * `exposure :: arg0.config.convention:calls=-1` names a discriminator on a NUMERIC domain,
         * which could not be expressed before this round, and `VolatilitySurface.fromJSON` gains the
         * same treatment for its slice variants.
         */
        '@totalfinance/backtest:vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#1 :: arg0.signal#0~16c4nu4#1 :: arg0.signal#0~16c4nu4#0',
        '@totalfinance/backtest:vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#2 :: arg0.signal#0~16c4nu4#2 :: arg0.signal#0~16c4nu4#0',
        '@totalfinance/math:monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#0 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        '@totalfinance/math:monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#1 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        '@totalfinance/math:normalSample :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        '@totalfinance/math:stratifiedUniforms :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        '@totalfinance/math:uniformSamples :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        // Stage 7A slice 6 (2026-09-03): `packs` accepts operation packs and tool packs (Decision 8), so the
        // server's `tools[]` arms re-fingerprint under `packs:absent` — the same unbuildable live-Schema items
        // as before, re-derived from the gate's own output (the previous spellings were removed as repaired).
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:absent & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:absent & arg0:present.tools:present.stochastic:present & arg0:present.tools:present.stochastic:present#0 :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:absent & arg0:present.tools:present.stochastic:present & arg0:present.tools:present.stochastic:present#1 :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:absent & arg0:present.tools:present.stochastic:present & arg0:present.tools:present.stochastic:present#2 :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:absent & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#0 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#1 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#2 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#3 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#4 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#5 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#6 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:absent & arg0:present.tools:present.outputSchema:present.type:present & arg0:present.tools:present.outputSchema:present.type:present#7 & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present#0 & arg0:present.tools:present.outputSchema:present.type:absent & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present#1 & arg0:present.tools:present.outputSchema:present.type:absent & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        '@totalfinance/mcp:createTotalFinanceMcpServer :: arg0:present & arg0:present.packs:absent & arg0:present.tools:present & arg0:present.tools:present.outputSchema:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present & arg0:present.tools:present.outputSchema:present.additionalProperties:present#2 & arg0:present.tools:present.outputSchema:present.type:absent & arg0:present.tools:present.stochastic:absent :: arg0:present.tools!gate:present :: arg0:present.tools!gate:absent',
        // Stage 7A slice 1 (2026-09-03): `defineOperation(definition)` and
        // `createOperationRegistry({ operations })` — the same pattern as the MCP server's `tools[]`
        // above: a definition / an item carries a live Schema instance (`inputSchema`) and a `run`
        // function, so the builder cannot synthesize one; every arm named under that gate (the nested
        // `outputSchema` keywords, the `stochastic` union, the effect enums) is declared but unbuildable.
        // Hand fixtures cover the real calls (tools/first-touch/fixtures/workflows.ts). 82 + 14 rows,
        // derived from the gate's own output.
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#1 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#2 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#0 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#1 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#2 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#3 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#4 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#5 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#6 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:absent & arg0.operations:present.outputSchema.type:present & arg0.operations:present.outputSchema.type:present#7 & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:present & arg0.operations:present.outputSchema.additionalProperties:present#0 & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:present & arg0.operations:present.outputSchema.additionalProperties:present#1 & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        '@totalfinance/workflows:createOperationRegistry :: arg0.operations:present & arg0.operations:present.outputSchema.additionalProperties:present & arg0.operations:present.outputSchema.additionalProperties:present#2 & arg0.operations:present.outputSchema.type:absent & arg0.operations:present.stochastic#0 :: arg0.operations!gate:present :: arg0.operations!gate:absent',
        // Stage 7A slice 3 (2026-09-03): `OperationRegistry#run`'s `artifacts` option is a reader OR a
        // writable store (Decision 5) — two named arms of objects made of functions, which the builder
        // cannot instantiate; the runtime's own tests exercise both (handles resolve, results spill).
        '@totalfinance/cli:OperationRegistry#run :: arg0.artifacts:present & arg0.artifacts:present#0 :: arg0.artifacts!gate:present :: arg0.artifacts!gate:absent',
        '@totalfinance/cli:OperationRegistry#run :: arg0.artifacts:present & arg0.artifacts:present#1 :: arg0.artifacts!gate:present :: arg0.artifacts!gate:absent',
        '@totalfinance/workflows:OperationRegistry#run :: arg0.artifacts:present & arg0.artifacts:present#0 :: arg0.artifacts!gate:present :: arg0.artifacts!gate:absent',
        '@totalfinance/workflows:OperationRegistry#run :: arg0.artifacts:present & arg0.artifacts:present#1 :: arg0.artifacts!gate:present :: arg0.artifacts!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#0 :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#0 :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#0 :: arg0.stochastic!gate:present :: arg0.stochastic!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#1 :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#1 :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#1 :: arg0.stochastic!gate:present :: arg0.stochastic!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#2 :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#2 :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:present & arg0.stochastic:present#2 :: arg0.stochastic!gate:present :: arg0.stochastic!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#0 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#0 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#0 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#1 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#1 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#1 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#2 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#2 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#2 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#3 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#3 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#3 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#4 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#4 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#4 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#5 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#5 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#5 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#6 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#6 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#6 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#7 & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#7 & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:absent & arg0.outputSchema:present.type:present & arg0.outputSchema:present.type:present#7 & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#0 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#0 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#0 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#1 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#1 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#1 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#2 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#2 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:present & arg0.outputSchema:present.additionalProperties:present & arg0.outputSchema:present.additionalProperties:present#2 & arg0.outputSchema:present.type:absent & arg0.stochastic:absent :: arg0.outputSchema!gate:present :: arg0.outputSchema!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#1 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#1 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#1 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#0 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#0 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#0 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#1 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#1 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#1 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#2 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#2 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#2 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#3 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#3 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#3 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#4 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#4 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#4 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#5 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#5 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#5 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#6 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#6 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#6 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#7 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#7 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.type!gate:present :: arg0.inputSchema.toJSONSchema.type!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:present & arg0.inputSchema.toJSONSchema.type:present#7 & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#0 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#0 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:present :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#0 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#1 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#1 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:present :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#1 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#2 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=false :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#2 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:present :: arg0.inputSchema.toJSONSchema.additionalProperties!gate:absent',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=false & arg0.inputSchema.toJSONSchema.additionalProperties:present & arg0.inputSchema.toJSONSchema.additionalProperties:present#2 & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=true & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.safeParse~hmge4n:success=true :: nothing',
        '@totalfinance/workflows:defineOperation :: arg0.inputSchema.safeParse:success=true & arg0.inputSchema.toJSONSchema.additionalProperties:absent & arg0.inputSchema.toJSONSchema.type:absent & arg0.inputSchema.~standard.validate#0 & arg0.outputSchema:absent & arg0.stochastic:absent :: arg0.inputSchema.~standard.validate~gyagth#0 :: nothing',
        '@totalfinance/options:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/options:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        '@totalfinance/structure:ExposureProfile.constructor :: arg0.config.convention:calls=-1 & arg0.market.asOf#0 :: arg0.config.convention~1azcy3x:calls=-1 :: arg0.config.convention~1azcy3x:calls=1',
        '@totalfinance/structure:exposure :: arg0.config.convention:calls=-1 & arg0.market.asOf#0 :: arg0.config.convention~1azcy3x:calls=-1 :: arg0.config.convention~1azcy3x:calls=1',
        'totalfinance/structure:exposure :: arg0.config.convention:calls=-1 & arg0.market.asOf#0 :: arg0.config.convention~1azcy3x:calls=-1 :: arg0.config.convention~1azcy3x:calls=1',
        'totalfinance:backtest.vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#1 :: arg0.signal#0~16c4nu4#1 :: arg0.signal#0~16c4nu4#0',
        'totalfinance:backtest.vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#2 :: arg0.signal#0~16c4nu4#2 :: arg0.signal#0~16c4nu4#0',
        'totalfinance:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:math.monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#0 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        'totalfinance:math.monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#1 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        'totalfinance:math.normalSample :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:math.stratifiedUniforms :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:math.uniformSamples :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#0 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        'totalfinance:monteCarlo :: arg1.randomNumberGenerator:present & arg1.randomNumberGenerator:present.getState#1 :: arg1.randomNumberGenerator!gate:present :: arg1.randomNumberGenerator!gate:absent',
        'totalfinance:normalSample :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.impliedVolatilityOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.impliedVolatility :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.price :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.option.price :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:options.priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:priceMany :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:absent & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#0 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        'totalfinance:priceOption :: arg0.engine:present & arg0.engine:present.price.greeks:present & arg0.engine:present.price.greeks:present#1 & arg0.market.asOf#0 :: arg0.engine!gate:present :: arg0.engine!gate:absent',
        // Pre-publish repairs B4 (2026-09-21): the book's `position.legs` became the discriminated
        // Leg union (stock | call | put), so every book door's variants are now named per leg arm
        // CROSSED with the valuation instant's two forms — the same `asOf` residual class as the
        // rows above (the gate-scoped builder reports `nothing` for the instant arm it grafts),
        // now visible once per leg arm on every spelling. The doors themselves are measured with
        // stock, call and put legs in packages/risk/test/book.test.ts and book-var.test.ts.
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        '@totalfinance/risk:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        '@totalfinance/risk:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#1 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.to.asOf~rx37ry#1 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.from.asOf~rx37ry#0 :: nothing',
        '@totalfinance/risk:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#1 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.to.asOf~rx37ry#1 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:risk.analyzeBook :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.market.asOf~rx37ry#1 :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#1 & arg0.position.legs:kind=stock :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:risk.bookVaR :: arg0.market.asOf#0 & arg0.position.legs:kind=call :: arg0.market.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#1 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#1 & arg0.position.legs:kind=stock & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.position.legs~1l9ph1x:kind=call :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=call & arg0.to.asOf#0 :: arg0.to.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.to.asOf~rx37ry#1 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.from.asOf~rx37ry#0 :: nothing',
        'totalfinance:risk.explainPortfolioPnl :: arg0.from.asOf#0 & arg0.position.legs:kind=stock & arg0.to.asOf#1 :: arg0.position.legs~1l9ph1x:kind=stock :: nothing',
        // Pre-publish repairs C (2026-09-21): the signature classifier stopped reading
        // `{ asOf: EpochMs; specification }` as a NUMBER, so `InstrumentAdapter#accrued`'s input is
        // an object contract again and reports the same adapter-gate residual as `#fillTerms`
        // above (the optional function-membered `adapter` the builder can gate but not make return
        // the named nested branches). The adapter is proven by assertInstrumentAdapterConformance.
        '@totalfinance/backtest:InstrumentAdapter#accrued :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#0 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#accrued :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#1 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        // FC0 (2026-08-19): Assumptions.compounding became the seven-arm InterestCompounding
        // union — the engine-protocol probes gained one compounding-gate variant per arm, and
        // classifyStrategy re-fingerprinted again with the declaration change.
        // FC0 (2026-08-19): Assumptions.compounding became the seven-arm InterestCompounding
        // union — the engine-protocol probes gained one compounding-gate variant per union
        // arm across every spelling, and classifyStrategy re-fingerprinted with the
        // declaration change. Same mismatch classes as before, multiplied by the arms.
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/options:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        '@totalfinance/volatility:VolatilitySurface.fromJSON :: arg0.assumptions.compounding:absent & arg0.essvi:absent & arg0.slices.essvi:absent & arg0.slices.ssvi:present & arg0.slices.ssvi:present.phi#1 & arg0.ssvi:absent :: arg0.slices.ssvi:present.phi~4vv2pf#1 :: arg0.slices.ssvi:present.phi~4vv2pf#0',
        '@totalfinance/volatility:VolatilitySurface.fromJSON :: arg0.assumptions.compounding:absent & arg0.essvi:absent & arg0.slices.essvi:present & arg0.slices.essvi:present.phi#1 & arg0.slices.ssvi:absent & arg0.ssvi:absent :: arg0.slices.essvi:present.phi~4vv2pf#1 :: arg0.slices.essvi:present.phi~4vv2pf#0',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.defineOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:options.validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#0 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:absent & arg0.price.greeks:present & arg0.price.greeks:present#1 & arg1.market.asOf#0 :: arg0.price.greeks!gate:present :: arg0.price.greeks!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#0 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#1 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#2 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#3 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#4 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#5 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        'totalfinance:validateOptionPricingEngine :: arg0.price.assumptions.compounding:present & arg0.price.assumptions.compounding:present#6 & arg0.price.greeks:absent & arg1.market.asOf#0 :: arg0.price.assumptions.compounding!gate:present :: arg0.price.assumptions.compounding!gate:absent',
        // Fingerprint moved (~1ez8lkp → ~1bbz1bm) when 3B.2 exported the strategy input types —
        // the same mismatch, now visible under every spelling instead of deduplicating to one.
        'totalfinance:stratifiedUniforms :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:structure.exposure :: arg0.config.convention:calls=-1 & arg0.market.asOf#0 :: arg0.config.convention~1azcy3x:calls=-1 :: arg0.config.convention~1azcy3x:calls=1',
        'totalfinance:uniformSamples :: arg0.getState:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=xoshiro128ss :: arg0.getState~e8jmov:algorithm=mulberry32',
        'totalfinance:vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#1 :: arg0.signal#0~16c4nu4#1 :: arg0.signal#0~16c4nu4#0',
        'totalfinance:vectorized :: arg0.rebalance:absent & arg0.signal#0 & arg0.signal#0#2 :: arg0.signal#0~16c4nu4#2 :: arg0.signal#0~16c4nu4#0',
        // Stage 7A slice 5 (2026-09-03): the error document's `issues[].path` element union (number | string)
        // named inside the optional `issues` arm — the same element-union limitation as the screen filter's
        // `values` below; the mapper's own tests cover a document with issues.
        '@totalfinance/http:statusForError :: arg0.issues:present & arg0.issues:present.path#0 :: arg0.issues:present.path~rx37ry#0 :: arg0.issues:present.path~rx37ry#1',
        // FC3 (2026-08-19): the same named-arm limitation one level deeper — the string arm of
        // the membership filter's `values` ELEMENT union (number | string), named inside the
        // filter grammar's own union arm, is built as arm #0 by the gate-scoped builder.
        '@totalfinance/research:screenUniverse :: arg0.filter:present & arg0.filter:present:operator=in & arg0.filter:present:operator=in.values#0 :: arg0.filter:present:operator=in.values~rx37ry#0 :: arg0.filter:present:operator=in.values~rx37ry#1',
        '@totalfinance/research:screenUniverse :: arg0.filter:present & arg0.filter:present:operator=notIn & arg0.filter:present:operator=notIn.values#0 :: arg0.filter:present:operator=notIn.values~rx37ry#0 :: arg0.filter:present:operator=notIn.values~rx37ry#1',
        'totalfinance:research.screenUniverse :: arg0.filter:present & arg0.filter:present:operator=in & arg0.filter:present:operator=in.values#0 :: arg0.filter:present:operator=in.values~rx37ry#0 :: arg0.filter:present:operator=in.values~rx37ry#1',
        'totalfinance:research.screenUniverse :: arg0.filter:present & arg0.filter:present:operator=notIn & arg0.filter:present:operator=notIn.values#0 :: arg0.filter:present:operator=notIn.values~rx37ry#0 :: arg0.filter:present:operator=notIn.values~rx37ry#1',
        'totalfinance:screenUniverse :: arg0.filter:present & arg0.filter:present:operator=in & arg0.filter:present:operator=in.values#0 :: arg0.filter:present:operator=in.values~rx37ry#0 :: arg0.filter:present:operator=in.values~rx37ry#1',
        'totalfinance:screenUniverse :: arg0.filter:present & arg0.filter:present:operator=notIn & arg0.filter:present:operator=notIn.values#0 :: arg0.filter:present:operator=notIn.values~rx37ry#0 :: arg0.filter:present:operator=notIn.values~rx37ry#1',
        // FC2 (2026-08-26): these two unions sit at the declaration walk's explicit depth frontier
        // (scenarios[].overrides.<field>). Their outer arms and rendered types are known, but their
        // element/member children are deliberately marked `truncated`, so synthesis cannot honestly
        // claim which deep arm it built. The direct DCF schedule branches are fully materialized and
        // measured; these nested copies remain exact, visible residuals rather than false evidence.
        '@totalfinance/valuation:discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:present & arg0.scenarios.overrides.projectedCashFlows:present#1 & arg0.scenarios.overrides.terminalValueMethod:absent :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#1 :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#0',
        'totalfinance:discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:present & arg0.scenarios.overrides.projectedCashFlows:present#1 & arg0.scenarios.overrides.terminalValueMethod:absent :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#1 :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#0',
        'totalfinance:valuation.discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:present & arg0.scenarios.overrides.projectedCashFlows:present#1 & arg0.scenarios.overrides.terminalValueMethod:absent :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#1 :: arg0.scenarios.overrides.projectedCashFlows:present~1ktwsse#0',
        '@totalfinance/valuation:discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:absent & arg0.scenarios.overrides.terminalValueMethod:present & arg0.scenarios.overrides.terminalValueMethod:present#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#0',
        'totalfinance:discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:absent & arg0.scenarios.overrides.terminalValueMethod:present & arg0.scenarios.overrides.terminalValueMethod:present#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#0',
        'totalfinance:valuation.discountedCashFlowScenarioAnalysis :: arg0.discountedCashFlowInput.compounding#0 & arg0.discountedCashFlowInput.projectedCashFlows#0 & arg0.discountedCashFlowInput.terminalValueMethod:method=perpetual-growth & arg0.scenarios.overrides.projectedCashFlows:absent & arg0.scenarios.overrides.terminalValueMethod:present & arg0.scenarios.overrides.terminalValueMethod:present#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#1 :: arg0.scenarios.overrides.terminalValueMethod:present~69mj5f#0',
        // Stage 4.6 slice 2 (2026-09-03): `crossSectionalBacktest`'s optional `execution` policy (a
        // method-bearing fill model inside) and the screen signal's optional `filter` are gated
        // optional members whose gate-scoped builder materializes the absent arm where the named
        // branch says present — the same optional-argument gate limitation as the rows above. The
        // engine's own suite runs a simplified and a declared policy and a screen with a filter
        // (packages/backtest/test/cross-sectional.test.ts).
        '@totalfinance/backtest:crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:crossSectionalBacktest :: arg0.execution:absent & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#2 & arg0.signal#2.screen.filter:present & arg0.signal#2.screen.filter:present#2 :: arg0.signal#2.screen.filter!gate:present :: arg0.signal#2.screen.filter!gate:absent',
        // Stage 7B.2 slice 3 (2026-09-06): `createPaperBroker`'s optional `execution` policy is the
        // same method-bearing fill model behind the same optional-argument gate; the broker's suite
        // runs the simplified policy and a declared, participation-capped one
        // (packages/backtest/test/paper-broker.test.ts).
        '@totalfinance/backtest:createPaperBroker :: arg0.execution:present & arg0.execution:present.fill.fill#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:createPaperBroker :: arg0.execution:present & arg0.execution:present.fill.fill#1 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.crossSectionalBacktest :: arg0.execution:absent & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#2 & arg0.signal#2.screen.filter:present & arg0.signal#2.screen.filter:present#2 :: arg0.signal#2.screen.filter!gate:present :: arg0.signal#2.screen.filter!gate:absent',
        'totalfinance:crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:crossSectionalBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#0 :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:crossSectionalBacktest :: arg0.execution:absent & arg0.portfolioConstruction.long#0 & arg0.portfolioConstruction.short:absent & arg0.signal#2 & arg0.signal#2.screen.filter:present & arg0.signal#2.screen.filter:present#2 :: arg0.signal#2.screen.filter!gate:present :: arg0.signal#2.screen.filter!gate:absent',
        // Stage 4.6 slice 4 (2026-09-04): `optionsBacktest` takes exactly one of the optional
        // `entry` (one rule) and `rules` (a book) — each a gated optional member whose gate-scoped
        // builder materializes the absent arm where the named branch says present, for every entry
        // arm on both spellings; the same optional-argument gate limitation as the rows above. The
        // engine's own suites run every structure through both forms (options-book.test.ts).
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:absent & arg0.entry:present#8.when:absent & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:absent & arg0.rules:present:structure=calendarCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:absent & arg0.rules:present:structure=calendarPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:absent & arg0.rules:present:structure=diagonalCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:absent & arg0.rules:present:structure=diagonalPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:absent & arg0.rules:present:structure=doubleDiagonal.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:absent & arg0.rules:present#8.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:present & arg0.entry:present#8.sizing:present#0 & arg0.entry:present#8.when:absent & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:absent & arg0.entry:present#8.when:present & arg0.entry:present#8.when:present#0 & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:present & arg0.rules:present:structure=calendarCallSpread.sizing:present#0 & arg0.rules:present:structure=calendarCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:absent & arg0.rules:present:structure=calendarCallSpread.when:present & arg0.rules:present:structure=calendarCallSpread.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:present & arg0.rules:present:structure=calendarPutSpread.sizing:present#0 & arg0.rules:present:structure=calendarPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:absent & arg0.rules:present:structure=calendarPutSpread.when:present & arg0.rules:present:structure=calendarPutSpread.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:present & arg0.rules:present:structure=diagonalCallSpread.sizing:present#0 & arg0.rules:present:structure=diagonalCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:absent & arg0.rules:present:structure=diagonalCallSpread.when:present & arg0.rules:present:structure=diagonalCallSpread.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:present & arg0.rules:present:structure=diagonalPutSpread.sizing:present#0 & arg0.rules:present:structure=diagonalPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:absent & arg0.rules:present:structure=diagonalPutSpread.when:present & arg0.rules:present:structure=diagonalPutSpread.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:present & arg0.rules:present:structure=doubleDiagonal.sizing:present#0 & arg0.rules:present:structure=doubleDiagonal.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:absent & arg0.rules:present:structure=doubleDiagonal.when:present & arg0.rules:present:structure=doubleDiagonal.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:present & arg0.rules:present#8.sizing:present#0 & arg0.rules:present#8.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:absent & arg0.rules:present#8.when:present & arg0.rules:present#8.when:present#0 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:present & arg0.entry:present#8.sizing:present#1 & arg0.entry:present#8.when:absent & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:absent & arg0.entry:present#8.when:present & arg0.entry:present#8.when:present#1 & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:present & arg0.entry:present#8 & arg0.entry:present#8.sizing:absent & arg0.entry:present#8.when:present & arg0.entry:present#8.when:present#2 & arg0.rules:absent :: arg0.entry!gate:present :: arg0.entry!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:present & arg0.rules:present:structure=calendarCallSpread.sizing:present#1 & arg0.rules:present:structure=calendarCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:absent & arg0.rules:present:structure=calendarCallSpread.when:present & arg0.rules:present:structure=calendarCallSpread.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarCallSpread & arg0.rules:present:structure=calendarCallSpread.sizing:absent & arg0.rules:present:structure=calendarCallSpread.when:present & arg0.rules:present:structure=calendarCallSpread.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:present & arg0.rules:present:structure=calendarPutSpread.sizing:present#1 & arg0.rules:present:structure=calendarPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:absent & arg0.rules:present:structure=calendarPutSpread.when:present & arg0.rules:present:structure=calendarPutSpread.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=calendarPutSpread & arg0.rules:present:structure=calendarPutSpread.sizing:absent & arg0.rules:present:structure=calendarPutSpread.when:present & arg0.rules:present:structure=calendarPutSpread.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:present & arg0.rules:present:structure=diagonalCallSpread.sizing:present#1 & arg0.rules:present:structure=diagonalCallSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:absent & arg0.rules:present:structure=diagonalCallSpread.when:present & arg0.rules:present:structure=diagonalCallSpread.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalCallSpread & arg0.rules:present:structure=diagonalCallSpread.sizing:absent & arg0.rules:present:structure=diagonalCallSpread.when:present & arg0.rules:present:structure=diagonalCallSpread.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:present & arg0.rules:present:structure=diagonalPutSpread.sizing:present#1 & arg0.rules:present:structure=diagonalPutSpread.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:absent & arg0.rules:present:structure=diagonalPutSpread.when:present & arg0.rules:present:structure=diagonalPutSpread.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=diagonalPutSpread & arg0.rules:present:structure=diagonalPutSpread.sizing:absent & arg0.rules:present:structure=diagonalPutSpread.when:present & arg0.rules:present:structure=diagonalPutSpread.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:present & arg0.rules:present:structure=doubleDiagonal.sizing:present#1 & arg0.rules:present:structure=doubleDiagonal.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:absent & arg0.rules:present:structure=doubleDiagonal.when:present & arg0.rules:present:structure=doubleDiagonal.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present:structure=doubleDiagonal & arg0.rules:present:structure=doubleDiagonal.sizing:absent & arg0.rules:present:structure=doubleDiagonal.when:present & arg0.rules:present:structure=doubleDiagonal.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:present & arg0.rules:present#8.sizing:present#1 & arg0.rules:present#8.when:absent :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:absent & arg0.rules:present#8.when:present & arg0.rules:present#8.when:present#1 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        '@totalfinance/backtest:optionsBacktest :: arg0.chains.asOf#0 & arg0.entry:absent & arg0.rules:present & arg0.rules:present#8 & arg0.rules:present#8.sizing:absent & arg0.rules:present#8.when:present & arg0.rules:present#8.when:present#2 :: arg0.rules!gate:present :: arg0.rules!gate:absent',
        // Stage 4.6 slice 5 (2026-09-04): `InstrumentSpecification.adapter` is an optional
        // FUNCTION-MEMBERED object (a caller's own `InstrumentAdapter`: mark/lifecycle/fillTerms and the
        // optional accrued callback). The builder can gate `adapter` present or absent, but it cannot
        // make a synthesized callback return the named nested branches (`fillTerms.contract`,
        // `lifecycle#n`, `mark#n`), so every route that carries a specification — the adapter's own
        // fillTerms, adapterFor, the conformance suite, portfolioBacktest on the package and the
        // umbrella — reports a built-versus-named row per gate scope. The adapter itself is proven
        // by assertInstrumentAdapterConformance at runtime; these 135 rows are the exact residual.
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=ambiguous & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=ambiguous & arg0.contract:absent :: arg0.adapter:present.mark~erwx0z:unavailable=ambiguous :: arg0.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=missing & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=missing & arg0.contract:absent :: arg0.adapter:present.mark~erwx0z:unavailable=missing :: arg0.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=stale & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=stale & arg0.contract:absent :: arg0.adapter:present.mark~erwx0z:unavailable=stale :: arg0.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=unpriceable & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark:unavailable=unpriceable & arg0.contract:absent :: arg0.adapter:present.mark~erwx0z:unavailable=unpriceable :: arg0.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#1 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#1 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#10 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#10 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#11 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#11 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#12 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#12 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#13 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#13 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#14 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#14 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#15 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#15 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#16 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#16 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#17 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#17 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#18 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#18 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#19 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#19 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#2 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#2 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#20 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#20 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#21 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#21 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#22 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#22 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#23 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#23 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#24 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#24 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#3 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#3 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#4 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#4 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#5 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#5 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#6 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#6 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#7 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#7 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#8 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#8 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:absent & arg0.adapter:present.lifecycle#9 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#9 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#0 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.fillTerms.contract!gate:present :: arg0.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#0 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#1 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.fillTerms.contract!gate:present :: arg0.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#1 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#2 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.fillTerms.contract!gate:present :: arg0.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#fillTerms :: arg0.adapter:present & arg0.adapter:present.fillTerms.contract:present & arg0.adapter:present.fillTerms.contract:present#2 & arg0.adapter:present.lifecycle#0 & arg0.adapter:present.mark#0 & arg0.contract:absent :: arg0.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:InstrumentAdapter#lifecycle :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#0 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#lifecycle :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#1 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#mark :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#0 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        '@totalfinance/backtest:InstrumentAdapter#mark :: arg0.specification.adapter:present & arg0.specification.adapter:present.mark#1 & arg0.specification.contract:absent :: arg0.specification.adapter!gate:present :: arg0.specification.adapter!gate:absent',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=ambiguous & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=ambiguous & arg1.contract:absent :: arg1.adapter:present.mark~erwx0z:unavailable=ambiguous :: arg1.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=missing & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=missing & arg1.contract:absent :: arg1.adapter:present.mark~erwx0z:unavailable=missing :: arg1.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=stale & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=stale & arg1.contract:absent :: arg1.adapter:present.mark~erwx0z:unavailable=stale :: arg1.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=unpriceable & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark:unavailable=unpriceable & arg1.contract:absent :: arg1.adapter:present.mark~erwx0z:unavailable=unpriceable :: arg1.adapter:present.mark~erwx0z#0',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#1 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#1 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#10 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#10 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#11 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#11 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#12 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#12 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#13 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#13 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#14 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#14 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#15 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#15 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#16 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#16 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#17 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#17 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#18 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#18 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#19 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#19 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#2 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#2 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#20 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#20 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#21 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#21 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#22 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#22 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#23 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#23 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#24 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#24 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#3 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#3 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#4 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#4 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#5 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#5 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#6 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#6 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#7 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#7 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#8 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#8 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:absent & arg1.adapter:present.lifecycle#9 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#9 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#0 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.fillTerms.contract!gate:present :: arg1.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#0 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#1 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.fillTerms.contract!gate:present :: arg1.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#1 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#2 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.fillTerms.contract!gate:present :: arg1.adapter:present.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:adapterFor :: arg1.adapter:present & arg1.adapter:present.fillTerms.contract:present & arg1.adapter:present.fillTerms.contract:present#2 & arg1.adapter:present.lifecycle#0 & arg1.adapter:present.mark#0 & arg1.contract:absent :: arg1.adapter:present.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=ambiguous :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=ambiguous :: arg0.adapter.mark~erwx0z:unavailable=ambiguous :: arg0.adapter.mark~erwx0z#0',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=missing :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=missing :: arg0.adapter.mark~erwx0z:unavailable=missing :: arg0.adapter.mark~erwx0z#0',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=stale :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=stale :: arg0.adapter.mark~erwx0z:unavailable=stale :: arg0.adapter.mark~erwx0z#0',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=unpriceable :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#0 & arg0.adapter.mark:unavailable=unpriceable :: arg0.adapter.mark~erwx0z:unavailable=unpriceable :: arg0.adapter.mark~erwx0z#0',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#1 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#1 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#10 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#10 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#11 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#11 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#12 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#12 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#13 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#13 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#14 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#14 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#15 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#15 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#16 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#16 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#17 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#17 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#18 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#18 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#19 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#19 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#2 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#2 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#20 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#20 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#21 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#21 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#22 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#22 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#23 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#23 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#24 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#24 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#3 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#3 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#4 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#4 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#5 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#5 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#6 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#6 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#7 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#7 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#8 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#8 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:absent & arg0.adapter.lifecycle#9 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#9 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#0 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.fillTerms.contract!gate:present :: arg0.adapter.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#0 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#1 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.fillTerms.contract!gate:present :: arg0.adapter.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#1 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#2 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.fillTerms.contract!gate:present :: arg0.adapter.fillTerms.contract!gate:absent',
        '@totalfinance/backtest:assertInstrumentAdapterConformance :: arg0.adapter.fillTerms.contract:present & arg0.adapter.fillTerms.contract:present#2 & arg0.adapter.lifecycle#0 & arg0.adapter.mark#0 :: arg0.adapter.lifecycle~2geepj#0 :: nothing',
        '@totalfinance/backtest:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:absent :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        '@totalfinance/backtest:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#0 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        '@totalfinance/backtest:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#1 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        '@totalfinance/backtest:portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:absent :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:backtest.portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#0 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:backtest.portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#1 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:backtest.portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:absent :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#0 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:portfolioBacktest :: arg0.execution:absent & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:present & arg0.strategy#0.policy:present.benchmark:absent & arg0.strategy#0.policy:present.model:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present & arg0.strategy#0.policy:present.model:present.horizonEndDate:present#1 :: arg0.strategy#0.policy:present.model!gate:present :: arg0.strategy#0.policy:present.model!gate:absent',
        'totalfinance:portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:portfolioBacktest :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent & arg0.strategy#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio & arg0.strategy#0.model:kind=totalfinance.model-portfolio.benchmark:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.horizonEndDate:absent & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveFrom#0 & arg0.strategy#0.model:kind=totalfinance.model-portfolio.strategic.effectiveTo:absent & arg0.strategy#0.policy:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:runAgentBench :: arg0.episodes:absent & arg0.policy.decide:kind=orders :: arg0.policy.decide~87edx9:kind=orders :: arg0.policy.decide~87edx9:kind=hold',
        'totalfinance:backtest.runAgentBench :: arg0.episodes:absent & arg0.policy.decide:kind=orders :: arg0.policy.decide~87edx9:kind=orders :: arg0.policy.decide~87edx9:kind=hold',
        'totalfinance:runAgentBench :: arg0.episodes:absent & arg0.policy.decide:kind=orders :: arg0.policy.decide~87edx9:kind=orders :: arg0.policy.decide~87edx9:kind=hold',
        // Stage 7B.1 slice 5 (2026-09-05): the bench's `episodes` gate (a catalogue id or a named
        // definition) crossed with the policy's `decide` callback returning the action union — the
        // rows above are that residual under the absent gate.
        // Stage 7B.1 slice 4 (2026-09-05): a policy's `decide` callback RETURNS the action union (hold |
        // orders); the walker names its variants as branches of the callback field, which no fixture can
        // build — the same class as the FC8 callback residuals.
        // Stage 7B.1 slice 1 (2026-09-05): the stepper and the environment take portfolioBacktest's
        // request without its strategy, so they inherit its execution-gate residual — the fill-model
        // union under the optional execution policy — with no strategy branch in the signature.
        '@totalfinance/backtest:createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        '@totalfinance/backtest:createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:backtest.createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:createPortfolioStepper :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#0 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
        'totalfinance:createTradingEnvironment :: arg0.execution:present & arg0.execution:present.fill.fill#1 & arg0.marketData.optionChains:absent :: arg0.execution!gate:present :: arg0.execution!gate:absent',
      ]);
      const unexpected = [...seen].filter((signature) => !ALLOWED_RESIDUAL.has(signature));
      const repaired = [...ALLOWED_RESIDUAL].filter((signature) => !seen.has(signature));
      expect(unexpected, 'a NEW built-versus-named mismatch appeared').toEqual([]);
      expect(
        repaired,
        'a listed residual no longer occurs — delete it from ALLOWED_RESIDUAL so the list stays exact',
      ).toEqual([]);
    },
    WHOLE_LIBRARY_SWEEP_MS,
  );

  it('publishes declared alternatives even when the ROW is unmeasured', () => {
    /**
     * "Measured or explicitly unmeasured, never absent" has to hold when the answer is unmeasured, or
     * it is a claim about the easy half. `defineIndicator` reported one row-level
     * `callback-input-required` and nothing about its shapes; `Position#whatIfCube` did the same
     * through the receiver path, which had not been taught the rule the module path already knew.
     */
    for (const id of [
      '@totalfinance/technical-analysis:defineIndicator',
      '@totalfinance/strategy:Position#whatIfCube',
    ]) {
      const row = enforcement.enforcement.find((entry) => entry.id === id);
      expect(row, `${id} vanished`).toBeDefined();
      expect(row!.verdict).toBe('unmeasured');
      expect(row!.alternatives?.length ?? 0, `${id} hides its alternatives`).toBeGreaterThan(1);
      for (const alternative of row!.alternatives ?? []) {
        expect(alternative.verdict).toBe('unmeasured');
        expect(alternative.unmeasuredReason, `${id} alternative carries no reason`).toBeTruthy();
      }
    }
  });
});
