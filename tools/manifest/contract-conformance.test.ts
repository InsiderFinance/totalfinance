/**
 * Phase 3B.0 gates for the public contract inventory.
 *
 * The inventory's whole value is that its numbers can be trusted, so the gates protect the things that
 * would quietly make them untrue:
 *
 *   - DRIFT: the committed baseline must equal a fresh generation. A stale contract graph would send
 *     3B.1/3B.2 to fix paths that changed, or hide ones that appeared.
 *   - DETERMINISM: two generations must be byte-identical. Anything order- or clock-dependent makes
 *     every diff unreviewable.
 *   - STABLE IDENTITY: no identity may embed a source position. Decision-ledger C02 records why —
 *     the first version keyed implementations on a `.d.ts` character offset, so editing any
 *     declaration churned every identity below it in the file.
 *   - GUARD CONVENTION: the `require*`/`ensure*` convention must still recognize every guard the repo
 *     had when the policy was written. A guard renamed outside the convention silently shrinks
 *     coverage and inflates the unenforced count — which is exactly how the first draft of this
 *     inventory reported 1,862 unenforced contracts when the real figure was 154.
 *   - HONEST EXCLUSIONS: every boundary kind excluded from the must-enforce set must be excluded for a
 *     structural reason (C20), and the curated exception list may not grow without a rationale.
 *
 * This file deliberately does NOT assert that the unenforced count is zero. 3B.0's commit boundary is
 * inventory only; burning that count down is 3B.1 and 3B.2, and a knowingly-red gate here is what the
 * spec forbids.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContractInventory } from './contract-inventory.js';
import { generatePublicSignatureManifest } from './signature-inventory.js';
import {
  CONTRACT_EXCEPTIONS,
  KNOWN_GUARD_NAMES,
  NON_TERMINATING_BOUNDARIES,
  SEED_FIXTURES,
  boundaryKindOf,
  isGuardName,
  isPostconditionName,
} from './contract-policy.js';

/** Two full contract-inventory builds. Generous on purpose: it backstops a hang, it is not a target. */
const INVENTORY_BUDGET_MS = 300_000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE = resolve(ROOT, 'tools/manifest/public-contracts.json');

const committed = JSON.parse(readFileSync(BASELINE, 'utf8')) as ReturnType<
  typeof buildContractInventory
>;

/**
 * The unmeasured-reason vocabulary, in one place.
 *
 * Both the header gate and the taxonomy gate consult it: one asks that the prose quote nothing the
 * artifact lacks, the other that the artifact record nothing the vocabulary lacks. Two copies of a
 * list are two chances for them to disagree about what a reason IS.
 */
const REASON_VOCABULARY = new Set([
  'receiver-unresolved',
  'external-callback-contract',
  'no-input',
  'baseline-rejected',
  'callback-input-required',
  'probe-failed',
  'no-mutable-argument',
  'probe-timeout',
  'async-result-unobserved',
  'incomplete-baseline',
  'branch-not-realized',
]);

describe('public contract inventory (Phase 3B.0)', () => {
  it('the committed baseline matches a fresh generation exactly', () => {
    const live = buildContractInventory();
    // Compare the serialized forms so a nested difference surfaces as one readable diff rather than a
    // deep-equal dump of 3,313 records. Assert on a bounded excerpt around the FIRST divergence —
    // asserting on the two full ~40 MB strings crashed vitest's IPC (`RangeError: Invalid array
    // length` serializing the failure payload) instead of printing the diff (2026-08-23).
    const liveText = JSON.stringify(live, null, 2);
    const committedText = JSON.stringify(committed, null, 2);
    if (liveText !== committedText) {
      let at = 0;
      const bound = Math.min(liveText.length, committedText.length);
      while (at < bound && liveText[at] === committedText[at]) at++;
      const from = Math.max(0, at - 400);
      expect(
        liveText.slice(from, at + 800),
        'the contract inventory has drifted — run `pnpm contract:update` and review the diff',
      ).toBe(committedText.slice(from, at + 800));
      expect.unreachable('the inventories differ only past the excerpt — still a drift');
    }
  });

  /**
   * Two FULL inventory builds, so it needs a budget that says so.
   *
   * It ran under the 45s default until it didn't: one build is ~30s on a warm machine and roughly
   * double that on a busy one, and the pair had no headroom either way. Three runs in a row then
   * reported `generation is deterministic FAILED` when the generator was perfectly deterministic and
   * had simply not finished — a diagnostic describing where the runner stopped rather than what was
   * wrong, which cost real time to chase because a determinism failure is exactly the alarming kind.
   *
   * The budget is a backstop against a hang, not a performance target; the sibling enforcement gates
   * take the same shape.
   */
  it(
    'generation is deterministic',
    () => {
      const first = JSON.stringify(buildContractInventory());
      const second = JSON.stringify(buildContractInventory());
      expect(first, 'the generator is not deterministic — two runs disagree').toBe(second);
    },
    INVENTORY_BUDGET_MS,
  );

  it('no identity embeds a source position (ledger C02)', () => {
    // `<file>#<nameChain>`, never `<file>:<offset>`. A digits-after-colon suffix is the old form.
    const positional = committed.contracts
      .filter((record) => /\.d\.ts:\d+/.test(record.implementation))
      .map((record) => `${record.id} -> ${record.implementation}`);
    expect(
      positional,
      `implementation identities keyed on a source position, which churn on unrelated edits:\n${positional.join('\n')}`,
    ).toEqual([]);
  });

  it('every public path resolves to an implementation identity', () => {
    const unresolved = committed.contracts
      .filter((record) => record.implementation === 'unknown' || record.implementation === '')
      .map((record) => record.id);
    expect(unresolved, `paths with no implementation identity:\n${unresolved.join('\n')}`).toEqual(
      [],
    );
  });

  it('the four identity counts are reported separately and are internally consistent', () => {
    const { summary, contracts } = committed;
    // The spec's scope model: a single number always misleads. 3,313 paths overstates the work;
    // deduplicated work understates the surface. Both must be present and both must be true.
    expect(summary['publicPaths']).toBe(contracts.length);
    expect(summary['implementations']).toBe(
      new Set(contracts.map((record) => record.implementation)).size,
    );
    expect(summary['inputContracts']).toBe(
      new Set(contracts.map((record) => record.inputContract).filter(Boolean)).size,
    );
    expect(summary['resultContracts']).toBe(
      new Set(contracts.map((record) => record.resultContract).filter(Boolean)).size,
    );
    // Aliases must actually collapse — if these were equal, identity #2 would be doing nothing.
    expect(Number(summary['implementations'])).toBeLessThan(Number(summary['publicPaths']));
  });

  it('the guard convention still recognizes every guard the repo had', () => {
    const unrecognized = KNOWN_GUARD_NAMES.filter((name) => !isGuardName(name));
    expect(
      unrecognized,
      `these guards no longer match the require*/ensure* convention, so the inventory has stopped ` +
        `counting them as enforcement — rename them back, or add them to GUARD_EXCEPTIONS:\n${unrecognized.join('\n')}`,
    ).toEqual([]);
    // And the convention must not swallow postconditions: they are result discipline, not input guards.
    expect(isPostconditionName('assertFiniteResult')).toBe(true);
    expect(isGuardName('assertFiniteResult')).toBe(false);
  });

  it('enforcement evidence is present wherever it is claimed', () => {
    const claimed = committed.contracts.filter(
      (record) => record.guardReachability === 'direct' || record.guardReachability === 'delegated',
    );
    const empty = claimed
      .filter((record) => record.validators.length === 0)
      .map((record) => `${record.id} (${record.guardReachability})`);
    expect(
      empty,
      `records claim enforcement but name no validator — the claim is unfalsifiable:\n${empty.join('\n')}`,
    ).toEqual([]);
    // A delegated verdict must show the chain that reached the guard, so it can be audited.
    const unaudited = claimed
      .filter(
        (record) => record.guardReachability === 'delegated' && (record.via ?? []).length === 0,
      )
      .map((record) => record.id);
    expect(
      unaudited,
      `delegated enforcement with no \`via\` chain to audit:\n${unaudited.slice(0, 20).join('\n')}`,
    ).toEqual([]);
  });

  it('boundary kinds are derived, exhaustive, and exclude nothing by package or tier (C20)', () => {
    const kinds = new Set(committed.contracts.map((record) => record.boundaryKind));
    // Every kind present must be one the policy defines — a typo would silently create a category
    // that the must-enforce filter then ignores.
    const known = new Set([
      'entry-point',
      'stream-step',
      'constructor',
      'validator',
      'error',
      'snapshot-restore',
      'callback-contract',
    ]);
    expect([...kinds].filter((kind) => !known.has(kind))).toEqual([]);
    // C20's substance: no package is exempt. `core` and `math` must appear in the must-enforce set,
    // because the rule this replaced excluded them wholesale by tier.
    const mustEnforce = committed.contracts.filter(
      (record) =>
        record.inputContract !== null &&
        (record.boundaryKind === 'entry-point' || record.boundaryKind === 'snapshot-restore'),
    );
    for (const pkg of ['@totalfinance/core', '@totalfinance/math']) {
      expect(
        mustEnforce.some((record) => record.package === pkg),
        `${pkg} has no must-enforce object contracts, which would mean the tier exclusion came back`,
      ).toBe(true);
    }
  });

  it('the derived boundary kind agrees with the policy function', () => {
    // Guards against the inventory and the policy drifting apart — the record is generated, but the
    // rule is curated, and a reader must be able to trust that the column reflects the rule.
    for (const record of committed.contracts.slice(0, 400)) {
      const [file] = record.implementation.split('#');
      const expected = boundaryKindOf(
        record.id.split(':').slice(1).join(':'),
        file!,
        record.guardReachability !== 'no-implementation',
      );
      expect(record.boundaryKind, `${record.id} boundary kind disagrees with the policy`).toBe(
        expected,
      );
    }
  });

  it('every curated C20 exception names its enforcing boundary', () => {
    const vague = Object.entries(CONTRACT_EXCEPTIONS)
      .filter(([, rationale]) => rationale.trim().length < 30)
      .map(([id]) => id);
    expect(
      vague,
      `a C20 exception must name WHICH boundary enforces the contract — "it is internal" is not a ` +
        `reason:\n${vague.join('\n')}`,
    ).toEqual([]);
  });

  it('the decision-ledger populations are bound to GENERATED identities, not to the prose baseline', () => {
    // 3B.0: "The handoff baselines are 36 helper paths / 27 operations and 33 pair paths / 30
    // operations, but only the generated Phase 3B.0 identities control execution."
    const { helperQuantAnswers, highLevelPositionalPairs } = committed.ledgers;

    // The generated H-series came out at exactly the spec's 36 — which is how we knew the definition
    // (helper role + the `plain-value quant answer` manifest marker) was the one the spec meant.
    // 36 → … → 20 → 5 (2026-08-19): the TA block (H13–H20, fifteen path spellings) closed after
    // the credit, risk, volatility and priceMany groups — the number tracks the OPEN population,
    // shrinking by design as decisions close. The remaining five: H10–H12 report breaks,
    // H25/H26 ratifications.
    // 36 → 0 (2026-08-19): H10–H12 closed as reports — the ENTIRE H-series is implemented and
    // the backlog this number tracked is EMPTY. It stays bound at zero: a new plain-value quant
    // answer must be DECIDED (ledger entry + rationale), not silently accumulated.
    expect(helperQuantAnswers.length, 'H-series population changed — rebind the ledger').toBe(0);

    // P-series is 21, not the handoff's 33: Phase 3A and 3B.N already migrated twelve pairs to named
    // requests. The generated set governs, so this asserts the LIVE number and will fail loudly if
    // more pairs migrate — at which point the ledger, not this number, is what needs updating.
    //
    // 22 -> 21 when the inventory learned that an INTERSECTION is an object. `extremeValueTailRisk`
    // takes `(returns, { confidence? } & GeneralizedParetoFitOptions)` — a series plus an options
    // object, the library's standard shape — but the intersection read as `other`, so the signature
    // looked like two bare positional coordinates and the pair was filed for migration. It never
    // needed migrating; the P-series had a phantom member.
    expect(highLevelPositionalPairs.length, 'P-series population changed — rebind the ledger').toBe(
      // 21 → … → 33 → 34 (2026-08-19): each closed H-facade/report re-enters the set under its
      // new role (H10's riskContributions(weights, covariance) joins beside taylorPnl). All are
      // role-distinct positional coordinates retained by the P-series criteria — members, not
      // migration candidates; the pair rulings themselves are 3B.4's work.
      34,
    );

    // Both sets must be sorted and duplicate-free, so a diff of the artifact is reviewable.
    expect(helperQuantAnswers).toEqual([...helperQuantAnswers].sort());
    expect(new Set(helperQuantAnswers).size).toBe(helperQuantAnswers.length);
    expect(highLevelPositionalPairs).toEqual([...highLevelPositionalPairs].sort());
    expect(new Set(highLevelPositionalPairs).size).toBe(highLevelPositionalPairs.length);

    // And every ledger member must be a real path in this inventory — a ledger entry naming a path
    // that no longer exists is the stale-claim failure mode the whole phase is meant to end.
    const paths = new Set(committed.contracts.map((record) => record.id));
    const orphaned = [...helperQuantAnswers, ...highLevelPositionalPairs].filter(
      (id) => !paths.has(id),
    );
    expect(
      orphaned,
      `ledger populations name paths absent from the contract inventory:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });

  it('no path reads as enforced while a seed fixture records it defective', () => {
    /**
     * The gate that makes the original contradiction impossible.
     *
     * `488fbd7a` shipped `blackScholesPrice` recorded `direct`ly enforced by the static pass while
     * `SEED_FIXTURES`, in the same commit, recorded it returning `NaN` for a missing field. Nothing
     * compared the two, so nothing failed. The MEASURED record is now the authority, and this asserts
     * the artifacts agree: a path a seed fixture says is broken may not read as enforced.
     */
    const measured = new Map(
      (
        JSON.parse(
          readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
        ) as { enforcement: { id: string; verdict: string }[] }
      ).enforcement.map((record) => [record.id, record.verdict]),
    );
    const contradictions: string[] = [];
    for (const fixture of SEED_FIXTURES) {
      // Matched on the stated `defectiveId`, never parsed out of prose: the parity fixture names BOTH
      // paths and asserts a difference between them, and a matcher that took the first id concluded the
      // working facade was the broken one.
      const verdict = measured.get(fixture.defectiveId);
      if (fixture.closedIn === undefined) {
        if (verdict === 'enforced') {
          contradictions.push(
            `${fixture.defectiveId} reads ENFORCED, but seed fixture ${fixture.id} records: ${fixture.observed}`,
          );
        }
        continue;
      }
      /**
       * The OTHER direction, and it is the half that keeps `closedIn` honest.
       *
       * Marking a fixture closed is a claim about the library, and a claim nothing checks is how the
       * original contradiction happened in the first place — just pointed the other way. A row that
       * says it was fixed must be measured `enforced`; otherwise "closed" is a note someone wrote.
       */
      if (verdict !== 'enforced') {
        contradictions.push(
          `${fixture.defectiveId} is marked closedIn ${fixture.closedIn} by seed fixture ${fixture.id}, ` +
            `but the measured record reads ${verdict ?? '(absent)'} — a closure that is not measured is a claim`,
        );
      }
    }
    expect(
      contradictions,
      `the measured record and the seed fixtures disagree — one is wrong, and shipping both is how ` +
        `the first version of this inventory contradicted itself:\n${contradictions.join('\n')}`,
    ).toEqual([]);
  });

  it('the measured record covers every must-enforce contract, with an honest third state', () => {
    const measured = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
    ) as {
      summary: Record<string, number>;
      enforcement: { id: string; verdict: string; failures?: unknown[] }[];
    };
    const REQUIRED = new Set(['entry-point', 'snapshot-restore', 'constructor']);
    // Object OR series/container: a boundary taking an array has no `inputContract` but is very much
    // breakable, and the earlier object-only filter left 445 required boundaries unmeasured.
    const expected = committed.contracts.filter(
      (record) =>
        REQUIRED.has(record.boundaryKind) &&
        (record.inputContract !== null ||
          (record.signatures[0]?.parameters ?? []).some(
            (parameter) => parameter.kind === 'object' || parameter.kind === 'series',
          )),
    );
    expect(
      measured.enforcement.length,
      'the measured record and the inventory disagree about which contracts are candidates',
    ).toBe(expected.length);

    const verdicts = new Set(measured.enforcement.map((record) => record.verdict));
    expect(
      [...verdicts].filter((v) => !['enforced', 'partial', 'defective', 'unmeasured'].includes(v)),
    ).toEqual([]);
    // `partial` must be a real population, not a definition nothing reaches: it is where the 2,026
    // paths went that used to claim `enforced` while a container dimension sat undecided.
    expect(measured.summary['partial'] as number).toBeGreaterThan(0);
    // `unmeasured` must stay a DISTINCT verdict. Collapsing it into `enforced` is the exact failure
    // this rework corrects: a confident wrong number in place of an honest gap.
    expect(
      measured.summary['unmeasured'],
      'coverage is incomplete; the record must say so',
    ).toBeGreaterThan(0);

    // Every `defective` verdict carries the evidence that convicted it.
    const unevidenced = measured.enforcement
      .filter((record) => record.verdict === 'defective' && (record.failures ?? []).length === 0)
      .map((record) => record.id);
    expect(
      unevidenced,
      `defective verdicts with no recorded failure — unfalsifiable:\n${unevidenced.join('\n')}`,
    ).toEqual([]);
  });

  it('the recorded seed fixtures are data only, not a red gate', () => {
    // The spec: "land executable tests atomically with the 3B.1 fixes—never commit a knowingly red
    // gate or ratchet the defective result as expected behavior." So this asserts the RECORD is
    // well-formed; it does not assert the defects are fixed, and it must not.
    expect(SEED_FIXTURES.length).toBeGreaterThanOrEqual(5);
    for (const fixture of SEED_FIXTURES) {
      expect(fixture.id, 'a seed fixture needs a stable id').toMatch(/^contract\/[a-z0-9-]+\//);
      expect(
        fixture.observed.length,
        `${fixture.id}: observed behaviour must be recorded`,
      ).toBeGreaterThan(10);
      expect(
        fixture.required.length,
        `${fixture.id}: required behaviour must be recorded`,
      ).toBeGreaterThan(10);
      expect(fixture.landsIn, `${fixture.id}: must name the phase that lands the fix`).toMatch(
        /^3B\.\d$/,
      );
      // `observed` and `required` describing the same thing would mean the fixture proves nothing —
      // the tautology failure that cost 3B.N its removal evidence twice.
      expect(fixture.observed, `${fixture.id} records no change`).not.toBe(fixture.required);
    }
    expect(new Set(SEED_FIXTURES.map((fixture) => fixture.id)).size).toBe(SEED_FIXTURES.length);
  });

  /**
   * The spec's HEADER, gated against the artifact it quotes.
   *
   * A review found the header advertising `924 / 1,444 / 1,763 / 211 of 4,342` while the artifact
   * said `966 / 1,543 / 1,630 / 207 of 4,346` — and a second, different `defective` two paragraphs
   * below that. The checklist gate underneath already read four counts out of this document; the
   * header, which is what anyone opening the file reads first, was outside it. Prose that states a
   * measurement is either gated or it is decoration.
   */
  it('the status header quotes the enforcement artifact exactly', () => {
    const spec = readFileSync(
      resolve(ROOT, 'docs/specs/phase-3b-runtime-semantic-closeout.md'),
      'utf8',
    );
    // Unwrapped: blockquote continuations (`\n> `) become spaces, so every pattern below reads one
    // continuous string and none of them depends on where a line happens to break.
    const header = spec
      .slice(0, spec.indexOf('## Objective'))
      .replace(/\n>\s*/g, ' ')
      .replace(/\s+/g, ' ');
    const artifact = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
    ) as { summary: Record<string, number | Record<string, number>> };
    const summary = artifact.summary as Record<string, number>;
    const stated = (label: string, pattern: RegExp): number | null => {
      const match = pattern.exec(header);
      return match ? Number(match[1]!.replace(/,/g, '')) : null;
    };
    const rows: [string, RegExp, number][] = [
      ['enforced', /enforced ([\d,]+)/, summary['enforced']!],
      ['partial', /partial ([\d,]+)/, summary['partial']!],
      ['defective', /defective ([\d,]+)/, summary['defective']!],
      ['unmeasured', /unmeasured ([\d,]+)\*\*/, summary['unmeasured']!],
      ['candidates', /of ([\d,]+) candidates/, summary['candidates']!],
      // The two workload metrics. They are in the header precisely because ONE of them used to be,
      // under a name that did not say which it was.
      // Matched against the UNWRAPPED header (see `header` below): a markdown blockquote rewraps
      // whenever the prose around a number changes, and a regex that encodes today's line breaks
      // fails on an edit that did not touch the number at all.
      [
        'declaration templates',
        /([\d,]+) defective declaration templates/,
        summary['defectiveDeclarationTemplates']!,
      ],
      [
        'measurement targets',
        /([\d,]+) defective measurement targets/,
        summary['defectiveMeasurementTargets']!,
      ],
      /**
       * The three input rejection buckets. They are here because the paragraph that discusses them
       * ROTTED: `input.out_of_range` rose 45 → 48 and `input.wrong_type` fell 18 → 11 under one
       * commit, the next commit moved them to 47 and 17, and the prose kept the intermediate figures
       * because `rejectionsByCode` was not one of the gated patterns. A narrative "rose X → Y" is
       * not gateable, so the document states them in a canonical form and they are bound here.
       */
      // A bucket the artifact omits is ZERO rejections of that kind (the writer drops empty buckets);
      // the prose states it as 0 rather than going silent about a code it used to report.
      [
        'input.out_of_range',
        /`input\.out_of_range` ([\d,]+),/,
        (summary['rejectionsByCode'] as unknown as Record<string, number>)['input.out_of_range'] ??
          0,
      ],
      [
        'input.missing_field',
        /`input\.missing_field` ([\d,]+),/,
        (summary['rejectionsByCode'] as unknown as Record<string, number>)['input.missing_field'] ??
          0,
      ],
      [
        'input.wrong_type',
        /`input\.wrong_type` ([\d,]+)/,
        (summary['rejectionsByCode'] as unknown as Record<string, number>)['input.wrong_type'] ?? 0,
      ],
    ];
    for (const [label, pattern, live] of rows) {
      expect(
        stated(label, pattern),
        `the closeout header states a different "${label}" than the artifact — refresh the header in ` +
          `the same commit that moves the number`,
      ).toBe(live);
    }
    // Every reason the header lists must match too, and it must list all of them: an omitted bucket
    // reads as "zero" to someone counting.
    const byReason = artifact.summary['unmeasuredByReason'] as Record<string, number>;
    /**
     * BOTH DIRECTIONS. The old check asked only that every ARTIFACT reason appears in the prose, so
     * the header could list a reason the artifact does not have — and it did: it claimed a row-level
     * `branch-not-realized` when zero rows carry one and 27 ALTERNATIVES do. A gate that permits
     * extra prose permits a false claim, which is the only kind of claim a gate is for.
     */
    const quoted = [...header.matchAll(/`([a-z-]+)` (\d[\d,]*)/g)].map((match) => match[1]!);
    const rowReasons = new Set(Object.keys(byReason));
    const invented = quoted.filter(
      (reason) => REASON_VOCABULARY.has(reason) && !rowReasons.has(reason),
    );
    expect(
      invented,
      'the header quotes a row-level reason the artifact does not record — the two must agree in ' +
        'BOTH directions, or the prose can say anything',
    ).toEqual([]);
    /**
     * The header's ALTERNATIVE-level figure is checked against the artifact too.
     *
     * `alternativeUnmeasuredByReason` is a different population from the row-level map, and the
     * header quotes it — "27 alternatives". Nothing verified that number, which is how the previous
     * round's "one row" survived: a figure with no gate is prose.
     */
    const claimedAlternatives = /`branch-not-realized`[\s\S]*?(\d[\d,]*) alternatives/.exec(header);
    expect(
      claimedAlternatives,
      'the header states no alternative-level `branch-not-realized` figure to check',
    ).not.toBeNull();
    const publishedAlternatives = (
      artifact.summary['alternativeUnmeasuredByReason'] as Record<string, number> | undefined
    )?.['branch-not-realized'];
    expect(
      Number((claimedAlternatives?.[1] ?? '-1').replace(/,/g, '')),
      'the header quotes a different alternative count than the artifact records',
    ).toBe(publishedAlternatives ?? 0);

    for (const [reason, count] of Object.entries(byReason)) {
      const match = new RegExp(`\`${reason}\` ([\\d,]+)`).exec(header);
      expect(match, `the header does not list the \`${reason}\` bucket`).not.toBeNull();
      expect(Number(match![1]!.replace(/,/g, '')), `header \`${reason}\``).toBe(count);
    }
  });

  /**
   * THE MUTATION TABLE, gated — because it rotted while the header beside it was protected.
   *
   * The header gate binds the verdict counts, the reason buckets and the rejection codes. The
   * executed/covered table two paragraphs below was never bound, and an adversarial audit found three
   * of its five rows wrong in BOTH columns. Prose that states a measurement is either gated or it is
   * decoration — the same rule that put the header under a gate, applied to the table it sits above.
   */
  it('the coverage table quotes the enforcement artifact exactly', () => {
    const spec = readFileSync(
      resolve(ROOT, 'docs/specs/phase-3b-runtime-semantic-closeout.md'),
      'utf8',
    );
    const artifact = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
    ) as {
      summary: {
        mutationsExecuted: Record<string, number>;
        mutationsCovered: Record<string, number>;
      };
    };
    const rows = [...spec.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|$/gm)];
    expect(rows.length, 'the coverage table is gone — remove this gate with it').toBeGreaterThan(3);
    const wrong: string[] = [];
    for (const [, mutation, executed, covered] of rows) {
      const number = (text: string): number => Number(text.replace(/,/g, ''));
      const liveExecuted = artifact.summary.mutationsExecuted[mutation!];
      const liveCovered = artifact.summary.mutationsCovered[mutation!];
      if (number(executed!) !== liveExecuted) {
        wrong.push(`${mutation} executed: doc ${executed} vs artifact ${liveExecuted}`);
      }
      if (number(covered!) !== liveCovered) {
        wrong.push(`${mutation} covered: doc ${covered} vs artifact ${liveCovered}`);
      }
    }
    expect(wrong, `the coverage table has drifted from the artifact:\n${wrong.join('\n')}`).toEqual(
      [],
    );
  });

  it('the 3B.0 checklist counts match the generated inventory', () => {
    /**
     * The counts in the spec's own checklist, parsed back out and compared.
     *
     * Ungated prose rots within one commit — that checklist said `3,313 paths / 2,035 implementations`
     * for exactly as long as it took the next change to land, which is the failure the naming closeout
     * was criticised for and then this file repeated. A number a reader can trust is one a test reads.
     *
     * `input contracts` and the naming count were NOT in this list, and the omission did exactly what
     * an omission does: a signature change moved `inputContracts` 996 → 994, the checklist kept saying
     * 996, and this gate passed. A gate that cannot see the field it is supposed to bind manufactures
     * confidence, which is worse than no gate. Every number the checklist states is bound here now;
     * adding one to the prose without adding it here is the failure mode to watch for.
     */
    const spec = readFileSync(
      resolve(ROOT, 'docs/specs/phase-3b-runtime-semantic-closeout.md'),
      'utf8',
    );
    const naming = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-naming.json'), 'utf8'),
    ) as { summary: { identities: number; byKind: Record<string, number> } };
    const stated = (label: string): number | null => {
      const match = new RegExp(`([\\d,]+) ${label}`).exec(spec);
      return match ? Number(match[1]!.replace(/,/g, '')) : null;
    };
    for (const [label, live] of [
      ['paths', committed.summary['publicPaths']],
      ['implementations', committed.summary['implementations']],
      ['input\n      contracts', committed.summary['inputContracts']],
      ['result contracts', committed.summary['resultContracts']],
      ['validator identities', committed.summary['validatorIdentities']],
      ['naming identities', naming.summary.identities],
    ] as const) {
      expect(
        stated(label),
        `the 3B.0 checklist states a different "${label.replace(/\s+/g, ' ')}" than the artifacts ` +
          `generate — update the checklist in the same commit`,
      ).toBe(live);
    }
  });

  /**
   * The other ungated sentence in the naming closeout: ten counts in one line of prose, none of them
   * bound to anything. It is the largest remaining rot surface in the trackers, and it is bound the
   * same way — read the numbers back out and compare them to `byKind`.
   */
  it('the naming closeout "identity kinds walked" line matches the artifact', () => {
    const spec = readFileSync(
      resolve(ROOT, 'docs/specs/phase-3b-public-naming-normalization.md'),
      'utf8',
    );
    const naming = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-naming.json'), 'utf8'),
    ) as { summary: { byKind: Record<string, number> } };
    const sentence = /Identity kinds walked:([\s\S]*?packages\.)/.exec(spec);
    expect(
      sentence,
      'the "Identity kinds walked" sentence is gone — remove this gate with it',
    ).not.toBeNull();
    const prose = sentence![1]!.replace(/\s+/g, ' ');
    const stated = (label: string): number | null => {
      const match = new RegExp(`([\\d,]+) ${label}`).exec(prose);
      return match ? Number(match[1]!.replace(/,/g, '')) : null;
    };
    const byKind = naming.summary.byKind;
    for (const [label, key] of [
      ['fields', 'field'],
      ['exports', 'export'],
      ['parameters', 'parameter'],
      ['methods', 'method'],
      ['MCP schema fields', 'mcp-field'],
      ['stable codes', 'code-string'],
      ['enum members', 'enum-member'],
      ['subpaths', 'subpath'],
      ['MCP tools', 'mcp-tool'],
      ['packages', 'package'],
    ] as const) {
      expect(
        stated(label),
        `the naming closeout states a different "${label}" than public-naming.json`,
      ).toBe(byKind[key]);
    }
  });

  it('one ordered command regenerates every dependent artifact', () => {
    /**
     * R13. Regenerating by hand meant running the bare `tsx` generators and skipping the prettier step
     * the `:update` scripts carry, which reds `format:check` — twice in one session. The dependency
     * order also matters: contracts read the signature manifest, enforcement reads contracts, and the
     * docs inventory reads the naming baseline and the generator registry.
     */
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const chain = scripts['artifacts:update'];
    expect(chain, 'artifacts:update is missing').toBeTruthy();

    /**
     * The dependency edges are DERIVED from what the generators read, not listed here.
     *
     * A hand-written order is a claim that goes stale silently, and it did. The list used to be
     * `signature -> contract -> enforcement -> docs`, which is correct and incomplete:
     * `contract-inventory.ts` also reads `public-naming.json`, and `naming:update` ran AFTER it. So
     * the contract graph was built against the PREVIOUS run's naming baseline on every regeneration.
     *
     * That is invisible until a type gains a field — then one `artifacts:update` produces an artifact
     * that a second `artifacts:update` disagrees with, and the drift gate fails on a change nobody
     * made. `AdaptiveSimpsonOptions.maxEvaluations` is what surfaced it, months after the edge was
     * introduced.
     *
     * Reading the edges out of the generator sources means the gate cannot fall behind the code: a
     * generator that starts consuming a new artifact is ordered correctly or fails here.
     */
    const GENERATORS: Record<string, string> = {
      'signature:update': 'tools/manifest/signature-inventory.ts',
      'naming:update': 'tools/manifest/naming-inventory.ts',
      'contract:update': 'tools/manifest/contract-inventory.ts',
      'enforcement:update': 'tools/manifest/contract-enforcement.ts',
      'docs:update': 'tools/manifest/docs-inventory.ts',
    };
    /** `<script>` -> the artifact it writes, taken from its own `:update` name. */
    const writes: Record<string, string> = {
      'signature:update': 'public-signatures.json',
      'naming:update': 'public-naming.json',
      'contract:update': 'public-contracts.json',
      'enforcement:update': 'public-enforcement.json',
      'docs:update': 'public-docs.json',
    };
    const producerOf = new Map(Object.entries(writes).map(([step, file]) => [file, step]));

    const positionInChain = (step: string): number => chain!.indexOf(step);
    const violations: string[] = [];
    for (const [step, source] of Object.entries(GENERATORS)) {
      const position = positionInChain(step);
      expect(position, `\`${step}\` is not in artifacts:update`).toBeGreaterThanOrEqual(0);
      /**
       * CODE, not prose. The scan reads which artifacts a generator actually consumes, and a doc
       * comment that merely NAMES one is not a read — this gate failed the moment a comment in
       * `contract-inventory.ts` explained why enforcement copies a policy. Comments are stripped
       * first, which is cheap and exact enough: a `public-*.json` surviving in code is a path.
       */
      const text = readFileSync(resolve(ROOT, source), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const referenced = new Set(text.match(/public-[a-z]+\.json/g) ?? []);
      for (const artifact of referenced) {
        if (artifact === writes[step]) continue; // its own output
        const producer = producerOf.get(artifact);
        if (!producer) continue;
        const producerPosition = positionInChain(producer);
        if (producerPosition < 0 || producerPosition > position) {
          violations.push(
            `${step} reads ${artifact}, which ${producer} writes — but ${producer} runs later`,
          );
        }
      }
    }
    expect(
      violations,
      `artifacts:update regenerates in an order that feeds a generator STALE input:\n${violations.join('\n')}`,
    ).toEqual([]);

    /**
     * `manifest:update` is EXCLUDED on purpose, and this asserts the exclusion.
     *
     * It re-derives the curated manifest keyed by export NAME, so it silently resets the hand-written
     * `role`, `note` and `mcpTools` curation on anything that was renamed. Folding it into a
     * convenience command would make "regenerate everything" quietly destructive — the one thing an
     * aggregate command must never be.
     */
    expect(
      chain!.includes('manifest:update'),
      'artifacts:update must not run manifest:update — it wipes hand curation',
    ).toBe(false);
  });

  it('the committed signature manifest matches a fresh generation', () => {
    /**
     * The manifest had a determinism test and no DRIFT test — the only artifact of the three without
     * one. Determinism proves the generator agrees with itself; it says nothing about whether the
     * committed file agrees with the generator. A reviewer reasonably concluded the head was stale
     * because nothing in CI could have told them otherwise.
     *
     * Compared as parsed JSON, because the committed file is prettier-formatted by `signature:update`
     * while the generator emits compact output; a byte comparison would fail on formatting alone and
     * report drift that is not there.
     */
    const fresh = generatePublicSignatureManifest();
    const committedManifest = JSON.parse(
      readFileSync(resolve(ROOT, 'tools/manifest/public-signatures.json'), 'utf8'),
    ) as { typescriptVersion?: string };
    /**
     * THE COMPILER FIRST, because it is the likeliest cause and the least legible symptom.
     *
     * Every `type` string in this artifact is `checker.typeToString(...)` output, so the file is a
     * function of the TypeScript version that wrote it. `typescript` was declared `^5.7.3` — a caret
     * range — so two checkouts installed on different days resolved different patches and disagreed
     * about a file neither had edited. A reviewer hit it; I could not reproduce it on Node 22, 24 or
     * 26, because Node was never the variable.
     *
     * Checked before the deep-equal so the failure says WHICH COMPILER instead of printing a thousand
     * lines of near-identical type strings and leaving the reader to infer it.
     */
    expect(
      fresh.typescriptVersion,
      `public-signatures.json was generated with TypeScript ${committedManifest.typescriptVersion} ` +
        `and you are running ${fresh.typescriptVersion}. Every type string here is compiler output, ` +
        `so a different compiler rewrites the file without the library changing. The dependency is ` +
        `pinned exactly in package.json — reinstall rather than regenerating.`,
    ).toBe(committedManifest.typescriptVersion);
    expect(
      JSON.parse(JSON.stringify(fresh)),
      'public-signatures.json has drifted — run `pnpm signature:update`',
    ).toEqual(committedManifest);
  });

  it('the signature manifest generates identically twice in one process', () => {
    /**
     * Generated twice, in ONE process, byte-identical.
     *
     * The umbrella traversal descended into primitives, so a string constant contributed its whole
     * `String.prototype`. Symbol-named members render with TypeScript's internal symbol id
     * (`__@iterator@14`), and that counter advances with everything else compiled in the process — so
     * the same input produced different output on the second run and whether CI passed depended on how
     * much had been compiled first. Flaky, which is worse than red.
     */
    const first = JSON.stringify(generatePublicSignatureManifest());
    const second = JSON.stringify(generatePublicSignatureManifest());
    expect(first === second, 'the signature manifest generator is not deterministic').toBe(true);
    expect(first).not.toContain('__@');
  }, 120_000);

  it('the overload count stays at the reconciled figure', () => {
    /**
     * R6, held. A review counted 67 multi-overload public paths where this inventory reports 3; settled
     * three independent ways (inventory 3 paths / 1 implementation, textual `declare function` overload
     * sets 0, checker over root entrypoints 1) and they agree — overloads here are not `declare
     * function` repeats.
     *
     * That is why "the probe measures only the first overload" is currently a one-implementation
     * limitation rather than a sixty-seven-implementation one. If genuine overloads appear, that
     * assumption stops being safe, so this fails rather than letting it quietly become wrong.
     */
    const multi = committed.contracts.filter((record) => record.signatures.length > 1);
    const implementations = new Set(multi.map((record) => record.implementation));
    expect(
      implementations.size,
      `multi-overload implementations changed — the probe measures only the FIRST overload, so this ` +
        `is now a real coverage gap and R7 must cover it:\n${[...implementations].join('\n')}`,
    ).toBe(1);
  });
});

/**
 * Nameability and the unmeasured breakdown — two things the inventory learned to say in this pass.
 *
 * Both exist for the same reason: a number nobody can act on is worth less than a smaller number that
 * says what to do. `unmeasured: 1011` was one opaque bucket; splitting it showed 70 of those paths are
 * declared FIELDS with no callable to probe, which no amount of better synthesis will ever measure,
 * and that the real work list was the 705 that had no input built.
 */
interface ContractInventoryArtifact {
  contracts: {
    id: string;
    implementation: string;
    /** Non-null when the boundary declares an object input contract (3B.6 ownership gate). */
    inputContract?: unknown;
    /** Static guard attribution — 'none'/'ambiguous' rows reconcile behaviorally (3B.6). */
    guardReachability?: string;
    /** Curated exception marker, when present. */
    exception?: unknown;
    /** Per-argument key policy as the CONTRACT graph declares it — must match the enforcement record. */
    inputPolicies?: Record<string, string>;
    signatures: {
      parameters: {
        typeDeclaration?: string;
        fieldTree?: { name: string; optional: boolean }[];
      }[];
    }[];
  }[];
  nameability: {
    contract: string;
    package: string;
    type: string;
    kind: 'unreachable' | 'foreign';
    exportedBy?: string;
    usedBy: string[];
  }[];
  summary: Record<string, unknown>;
}

interface EnforcementArtifact {
  enforcement: {
    id: string;
    verdict: string;
    implementation: string;
    unmeasuredReason?: string;
    undecided?: string[];
    rejection?: { code: string; typed: boolean; field?: string; message?: string };
    /** Present when the verdict was copied from an ALIAS sharing the implementation identity. */
    inheritedFrom?: string;
    /** Per-argument key policy the verdict is reported against. Must match the source it came from. */
    inputPolicies?: Record<string, string>;
    /** Probes EXECUTED by mutation kind, independent of verdict — where depth evidence lives. */
    mutationsExecuted?: Record<string, number>;
    advisory?: { verdict: string }[];
    failures?: { mutation: string; field?: string; verdict: string; declared?: boolean }[];
  }[];
  summary: Record<string, unknown>;
}

describe('contract inventory: nameability and measurement gaps (Phase 3B.0)', () => {
  const committed = JSON.parse(readFileSync(BASELINE, 'utf8')) as ContractInventoryArtifact;
  const enforcement = JSON.parse(
    readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
  ) as EnforcementArtifact;

  /**
   * 3B.6 — ZERO UNOWNED PUBLIC OBJECT CONTRACTS, by reconciliation.
   *
   * `unguardedObjectInputs` counts boundaries whose guard the STATIC reachability walk cannot
   * attribute. That is an attribution fact, not an ownership fact: the enforcement artifact
   * proves most of them behaviorally (facade wrappers, module-load-resolved specs and method
   * receivers hide the guard from the walk while the probes show it firing). Ownership means:
   * every such contract is EITHER behaviorally proven (enforced/partial), honestly unmeasured
   * with a recorded reason, or a member of one of three NAMED machinery classes whose rationale
   * is stated here. The remainder must be EMPTY — that is the checkbox, and a new unowned
   * boundary fails this gate, not the summary count.
   */
  it('3B.6: every statically-unattributed object contract has an owner — behavioral, reasoned, or named machinery', () => {
    const verdictById = new Map(
      enforcement.enforcement.map((record) => [record.id, record.verdict] as const),
    );
    const unattributed = committed.contracts.filter(
      (record) =>
        record.inputContract !== null &&
        (record.guardReachability === 'none' || record.guardReachability === 'ambiguous') &&
        (record as { exception?: unknown }).exception === undefined,
    );
    expect(unattributed.length).toBeGreaterThan(0); // the reconciliation must cover a real population
    const MACHINERY: readonly (readonly [RegExp, string])[] = [
      [
        /Error\.constructor$/,
        'an error class constructor is not an enforcement surface — a caller constructs one to THROW it, and garbage in its options harms only their own message',
      ],
      [
        /(:schema\.|Schema#|Schema\.safeParse$|Schema\._check$)/,
        'the schema machinery IS the guard — its own package conformance suite (including the Standard Schema tests) proves its contract',
      ],
      [
        /(Stream|Aggregator)#next$/,
        'per-tick open-bar receivers (C05): a stream consumes decorated bars, validating consumed members in the shared framework; the constructor path is the measured door',
      ],
    ];
    const unowned = unattributed.filter((record) => {
      const verdict = verdictById.get(record.id);
      if (verdict === 'enforced' || verdict === 'partial' || verdict === 'unmeasured') return false;
      return !MACHINERY.some(([pattern]) => pattern.test(record.id));
    });
    expect(
      unowned.map((record) => record.id),
      'an object contract with NO owner appeared — bind a guard, measure it, or name its machinery class with a rationale',
    ).toEqual([]);
  });

  it('records every object-parameter type a consumer cannot name from its own package', () => {
    const findings = committed.nameability;
    expect(findings.length).toBe(committed.summary['unnameableParameterContracts']);
    // Both classes must be populated and distinguished. Collapsing them would overstate the defect:
    // a `foreign` type IS importable, just not from the package whose function demands it.
    const unreachable = findings.filter((finding) => finding.kind === 'unreachable');
    const foreign = findings.filter((finding) => finding.kind === 'foreign');
    expect(unreachable.length + foreign.length).toBe(findings.length);
    // `unreachable > 0` held here until 2026-08-17, when 3B.2's nameability slices drove the class
    // to zero BY DESIGN (every such type is now exported by its owner). A floor that requires
    // defects to exist is a gate a migrated library fails — the partition assertion above is the
    // property; the population is the artifact's to report.
    for (const finding of foreign) {
      expect(finding.exportedBy, `${finding.contract} is foreign but names no owner`).toBeTruthy();
      expect(finding.exportedBy).not.toBe(finding.package);
    }
    for (const finding of findings) {
      expect(finding.usedBy.length, `${finding.contract} is recorded but unused`).toBeGreaterThan(
        0,
      );
      expect([...finding.usedBy].sort()).toEqual(finding.usedBy);
    }
  });

  it('joins contracts by DECLARATION, so homonyms disambiguate (R10)', () => {
    /**
     * `<package>:<BareName>` is not an identity. `@totalfinance/technical-analysis` declares
     * `PeriodParameters` in ten modules and they disagree: `bars.d.ts` (which ATR uses) makes `period`
     * OPTIONAL, `moving-averages.d.ts` (which SMA uses) makes it REQUIRED. Keying on the name let one
     * of them win arbitrarily, and the same `atr` function earned opposite verdicts through different
     * import paths.
     *
     * Verified against the runtime, not just against itself: `atr(bars, {})` is accepted and
     * `sma(series, {})` throws `input.missing_field`. The join gives each parameter the contract the
     * library actually enforces for it.
     */
    const byId = new Map(committed.contracts.map((record) => [record.id, record]));
    const treeOf = (id: string): string[] | null => {
      const parameter = (byId.get(id)?.signatures[0]?.parameters ?? []).find(
        (candidate) => candidate.fieldTree && candidate.typeDeclaration,
      );
      return parameter?.fieldTree?.map((f) => `${f.name}${f.optional ? '?' : '!'}`) ?? null;
    };
    expect(treeOf('@totalfinance/technical-analysis:atr')).toEqual(['period?']);
    expect(treeOf('@totalfinance/technical-analysis:sma')).toEqual(['period!']);

    // And the join must be the norm, not a special case.
    const joined = committed.contracts.filter((record) =>
      (record.signatures[0]?.parameters ?? []).some(
        (parameter) => parameter.typeDeclaration && parameter.fieldTree,
      ),
    );
    expect(joined.length).toBeGreaterThan(3000);

    /**
     * No declaration identity may be an absolute path. The first version returned the raw filename
     * for any declaration, which put `/Users/<me>/…/typescript@5.9.3/…/lib.es5.d.ts#Array` into a
     * committed artifact — an identity that differs per machine, per checkout and per TypeScript
     * patch. Ledger C02 arriving by a new route.
     */
    const absolute = committed.contracts.flatMap((record) =>
      (record.signatures[0]?.parameters ?? [])
        .map((parameter) => parameter.typeDeclaration)
        .filter((id): id is string => Boolean(id) && !id!.startsWith('packages/')),
    );
    expect(absolute.slice(0, 5)).toEqual([]);
  });

  it('records why a contract refused its synthesized baseline', () => {
    /**
     * `baseline-rejected` was 405 paths with no account of what went wrong — the same opaque bucket
     * `unmeasured` used to be. The contract had TOLD us: `snapshot.unsupported_version` names a
     * versioning rule, `input.missing_field` names a field synthesis omitted. Throwing that away
     * turned a conversation into a dead end.
     *
     * The first cut of this counted 727 causes for 405 rejections, because alias inheritance cleared
     * `unmeasuredReason` and left `rejection` behind — a measured record carrying a stale note about
     * a road not taken. Hence the consistency assertion below rather than a bare presence check.
     */
    /**
     * BOTH reasons that come from a refused call keep the refusal. `callback-input-required` is a
     * `baseline-rejected` that could name its own cause, and the contract's account of what it wanted
     * — "def needs { name, inputs, stream(parameters), … }" — is the most useful thing on the record.
     * Stripping it to satisfy a presence rule would have thrown away the evidence for the split.
     */
    const rejected = enforcement.enforcement.filter(
      (record) => record.unmeasuredReason === 'baseline-rejected',
    );
    // Every `baseline-rejected` must say what the contract wanted; that is the whole point of it.
    expect(rejected.every((record) => record.rejection !== undefined)).toBe(true);
    /**
     * A rejection may appear on exactly two reasons, and is REQUIRED on only one.
     *
     * `callback-input-required` stops on either side of the call: synthesis may build a partial input
     * and have it refused (a rejection to record), or decline to build one at all (no call, nothing
     * said). Demanding a rejection on all of them would have forced the classification to follow the
     * code path rather than the cause — which is the inconsistency that reason exists to remove.
     */
    const stray = enforcement.enforcement
      .filter(
        (record) =>
          record.rejection !== undefined &&
          record.unmeasuredReason !== 'baseline-rejected' &&
          record.unmeasuredReason !== 'callback-input-required' &&
          record.unmeasuredReason !== 'incomplete-baseline',
      )
      .map((record) => `${record.id} (${record.unmeasuredReason ?? record.verdict})`);
    expect(
      stray,
      `a rejection is recorded on a record that was not refused:\n${stray.slice(0, 10).join('\n')}`,
    ).toEqual([]);

    const byCode = enforcement.summary['rejectionsByCode'] as Record<string, number>;
    const carrying = enforcement.enforcement.filter((record) => record.rejection !== undefined);
    expect(Object.values(byCode).reduce((total, count) => total + count, 0)).toBe(carrying.length);
    /**
     * Most refusals should be TYPED — an untyped throw from a public boundary is itself a finding.
     *
     * Measured over `baseline-rejected` alone: the callback-shaped contracts are exactly where an
     * untyped `TypeError: objective is not a function` comes from, because the library never gets to
     * validate an argument it is already trying to call. Including them would let a capability gap of
     * the harness's own making depress a ratio that is about the LIBRARY's error discipline.
     */
    const typed = rejected.filter((record) => record.rejection?.typed === true).length;
    expect(typed / Math.max(rejected.length, 1)).toBeGreaterThan(0.8);
  });

  it('builds a snapshot from the thing that produces snapshots', () => {
    /**
     * 134 `Stream.fromJSON` boundaries rejected their synthesized input with
     * `snapshot.unsupported_version` — rightly, because a snapshot is not merely a shape, it carries
     * a version its reader checks. The only input guaranteed to be valid is the one the stream emits,
     * and producing it is exactly the round trip `fromJSON` exists for.
     *
     * What that measured is worth stating: `AdxStream.fromJSON` accepts a snapshot carrying an
     * undeclared key, and accepts one missing its required `kind` discriminant. This is the
     * persistence boundary — snapshots arrive from storage or the wire — and it was entirely
     * unmeasured.
     */
    const byCode = enforcement.summary['rejectionsByCode'] as Record<string, number>;
    // 7, the measured value, not 8. The cause here is still live — the synthesizer picks a producer by
    // TYPE, so a restorer can be handed a well-formed snapshot of the wrong `kind` — but a ratchet is
    // only a ratchet when it sits ON the number. Closing it needs kind-matched synthesis, not a wider bound.
    expect(byCode['snapshot.unsupported_version'] ?? 0).toBeLessThanOrEqual(7);
    const restored = enforcement.enforcement.filter(
      (record) => record.id.endsWith('.fromJSON') && record.verdict !== 'unmeasured',
    );
    expect(restored.length, 'no snapshot-restore boundary was measured at all').toBeGreaterThan(
      100,
    );
  });

  it('gives a matrix contract a matrix', () => {
    /**
     * `Matrix` and `Array<Array<number>>` classify as `series`, so synthesis handed them a flat number
     * array and 21 boundaries died inside the library on `row.slice` — a 1-D array has no rows. The
     * review's `determinant` example was exactly this: declared a matrix, given a vector, and the
     * verdict was about a call that never made sense.
     *
     * Positive-definite rather than arbitrary, because the boundaries that want a matrix mostly want
     * THAT matrix — `cholesky`, `nearestPsd`, `nearestCorrelation` and `correlatedNormalSampler` all
     * reject an indefinite one, and rightly.
     */
    const byCode = enforcement.summary['rejectionsByCode'] as Record<string, number>;
    // `not_positive_definite` is gone entirely — the synthesized matrix satisfies it by construction.
    expect(byCode['linalg.not_positive_definite'] ?? 0).toBe(0);
    /**
     * ZERO — and this bound said 6 while the measured value was already 0.
     *
     * The six were the callback-synthesis gap: three `randomNumberGenerator.next is not a function`
     * and three `objective is not a function`, from stubs deliberately not built. Three others —
     * `rocP.map is not a function`, `weights is not iterable` — were an inline-type parser bug, where
     * `/^number\\b/` matched `number[]` because the word boundary sits before the bracket, so an array
     * field was handed a scalar. R11 turned callback synthesis ON and fixed the parser. All of them
     * went away; the bound did not move.
     *
     * That is the same defect this file retired on the drift gate, found by applying the lesson rather
     * than only writing it down: an allowance whose cause has been fixed does not fail, it just leaves
     * six units of room. The old comment even called the bound "deliberately tight" — it was not, and
     * nothing could have told you so, because a gate reports only what crosses it. An untyped TypeError
     * from a public boundary is the shape a synthesis bug takes when it reaches real code, and there is
     * no longer a known one, so the honest bound is zero.
     */
    expect(byCode['TypeError'] ?? 0).toBe(0);
    /**
     * `linalg.singular` survives at 3, and that is correct rather than a shortfall: a matrix with a
     * constant off-diagonal is positive-definite but NOT of full rank for every routine that asks, so
     * three boundaries still refuse it. A ratchet at the measured number, not an aspiration to zero —
     * asserting zero here would have been asserting something I had not checked, which is the error
     * this whole inventory exists to stop making.
     */
    expect(byCode['linalg.singular'] ?? 0).toBeLessThanOrEqual(3);

    for (const id of ['@totalfinance/math:cholesky', '@totalfinance/math:determinant']) {
      const record = enforcement.enforcement.find((entry) => entry.id === id);
      expect(record?.verdict, `${id} should now be measured`).not.toBe('unmeasured');
    }
  });

  it('reads what a contract said when it refused, and acts on it', () => {
    /**
     * The rejection messages are the library teaching the harness, and they were being discarded
     * twice: once by not recording them, then again by a field regex that understands only one
     * message shape and left 168 of 262 unparsed. Recording the message made the remaining buckets
     * diagnosable, and each fix below came from a contract stating what it wanted:
     *
     *   "does not name its expiry INSTANT"           -> a zoned datetime, not a date
     *   "xs must be strictly increasing"             -> an axis is not a price path
     *   "points are [date, value] tuples"            -> with an example, in the message
     *   "expects { x, y } pairs per element"         -> naming the builder that makes them
     *   "benchmark must be an array of numbers"      -> a labelled TUPLE parameter is several arguments
     */
    /**
     * Every record CARRYING a rejection, which is a different population from `baseline-rejected`
     * alone — `callback-input-required` keeps the contract's account too, and it is the most useful
     * thing on those records. Two gates, two bases; the numbers are not interchangeable, and setting
     * both to 69 is how this one went red on the first full run after they were tightened.
     */
    /**
     * 95, up from 93, and the two that arrived are the guard working.
     *
     * 3B.1 gave every technical-analysis restorer an identity guard and checked field reads. Five of
     * them now REFUSE the harness's synthesized snapshot, and the messages say exactly why:
     *
     *   KstStream / MaRibbonStream    `period must be a lookback of 1 or more, got 101.287…`
     *   MomentStream / CrossPairStream / InformationBarAggregator
     *                                 `this snapshot's kind is nothing, not "standardDeviation" …`
     *
     * A fractional period and a kindless envelope are not snapshots any build of this library can
     * write. So this is not five boundaries becoming unmeasurable through neglect — it is five
     * contracts stating a requirement the synthesizer cannot yet satisfy, which is the distinction
     * `baseline-rejected` exists to record. The follow-up is on the HARNESS: pick a producer whose
     * `kind` matches the restorer being probed, instead of any producer whose type matches.
     *
     * Net on this population: +5 refusing, −3 for the `snapshotState` paths that 3B.1 deleted.
     *
     * 96 at 3B.1b, +1: `phiValue`. Its `phi` argument is a discriminated union, the new guard requires
     * the branch its `kind` selects, and the synthesized baseline does not carry a complete branch —
     * the SAME shape as the five above, and the same follow-up. A contract stating a requirement the
     * synthesizer cannot yet meet is exactly what this reason exists to record.
     *
     * 110 -> 102 when intersection FIELD TREES were completed: with a full contract the synthesizer
     * builds a baseline the boundary accepts, so eight of those refusals were never about the
     * boundary at all — they were the harness offering an object missing the members declared inline.
     *
     * 96 -> 110 when intersections were recognized as objects. These are not newly refusing
     * boundaries: all 14 belong to the 66 paths that had NO enforcement record at all, because a
     * parameter typed `A & B` was filed `other` and nothing downstream could build one. They were
     * never measured, so they could never appear here. A refusal recorded is strictly better than a
     * boundary the inventory did not know existed — the number rising is the inventory getting
     * honest, and the follow-up is the same producer/branch work the entries above describe.
     */
    const refused = enforcement.enforcement.filter((record) => record.rejection !== undefined);
    const withMessage = refused.filter((record) => (record.rejection?.message ?? '') !== '');
    expect(withMessage.length / Math.max(refused.length, 1)).toBeGreaterThan(0.9);
    /**
     * Re-seated 2026-08-12 (measured 93), from 92. It was 102 while three commits walked it to 92.
     *
     * The +1 is presence-gating, and it is the guard working rather than a boundary decaying. An
     * optional field carrying a union is now MATERIALIZED by the variant that names a branch of it,
     * so a request the harness previously never built is built — and its inline object literal
     * declares keys the synthesizer cannot fill, which the pre-call validator correctly refuses as
     * `incomplete-baseline` instead of sending it and scoring the answer.
     *
     * The follow-up is on the HARNESS, as with every entry above: build inline-literal parameters
     * from their declared members rather than from the field tree, which is empty for a type with no
     * name. Recording the refusal is strictly better than measuring against a request the
     * declaration itself calls incomplete.
     */
    // 93 -> 111: recording arms at every node made more alternatives reachable, and an
    // alternative the declaration itself calls incomplete is counted here rather than hidden.
    // 111 -> 112 (FC2, 2026-08-19): one more recorded refusal from the two-package valuation/
    // fundamentals surface after its baselines were taught — the residue, not the wave.
    // 112 -> 115 (2026-08-23 review wave): three more TYPED refusals — the tightened discount-curve
    // identity, provenance, and nested-envelope validators refuse their synthesized baselines with
    // teaching errors, the same honest outcome as the scenario-set precedent below.
    // 115 -> 112 (2026-08-23 third-review harvest): the RateCurve/schema unification made those
    // three baselines measurable again — the ratchet shrinks back.
    expect(refused.length).toBeLessThanOrEqual(112);
  });

  it('holds the nameability ratchet', () => {
    /**
     * A ratchet, not a target. The repair is 3B.2 (dependency-ordered package migration, a re-packed
     * tarball per commit), so these counts are expected to fall — but never to rise, because a new
     * public function taking an unexported input type is the same defect being re-introduced.
     *
     * `compareEngines(input: CompareEnginesInput)` is the canonical case: the options index re-exports
     * nine sibling types from the same module and omits that one, so a consumer can call the function
     * and cannot declare its argument.
     */
    expect(committed.summary['unnameableUnreachable']).toBeLessThanOrEqual(31);
    expect(committed.summary['unnameableForeign']).toBeLessThanOrEqual(42);
  });

  it('says WHY every unmeasured path was not measured', () => {
    const unmeasured = enforcement.enforcement.filter((record) => record.verdict === 'unmeasured');
    const unrecorded = unmeasured.filter((record) => !record.unmeasuredReason).map((r) => r.id);
    expect(
      unrecorded,
      `unmeasured paths with no recorded cause — the bucket is only actionable if it says what is ` +
        `missing:\n${unrecorded.slice(0, 20).join('\n')}`,
    ).toEqual([]);

    // A measured verdict must not carry a reason it could not be measured.
    const contradictory = enforcement.enforcement
      .filter((record) => record.verdict !== 'unmeasured' && record.unmeasuredReason)
      .map((record) => record.id);
    expect(contradictory).toEqual([]);

    const byReason = enforcement.summary['unmeasuredByReason'] as Record<string, number>;
    expect(Object.values(byReason).reduce((total, count) => total + count, 0)).toBe(
      unmeasured.length,
    );
    /**
     * Every reason must be one the vocabulary admits — and NONE of them is a permanent floor.
     *
     * An earlier version of this gate asserted `not-callable > 0`, on the belief that those 70 paths
     * held nothing measurable. Every one of them is a `Type#member` — `SimulatedBroker#exerciseOption`,
     * `Bond#cashflows` — which needs a constructed receiver, not a declaration that it is unmeasurable.
     * Asserting a floor would have frozen that mistake into CI: the gate would have FAILED the day
     * someone did the work to measure them. A reason vocabulary may constrain what can be said; it may
     * never require that work remain undone.
     */
    const admitted = new Set([
      'receiver-unresolved',
      'external-callback-contract',
      'no-input',
      'baseline-rejected',
      /**
       * The declared input requires a function, which synthesis will not build. Split out of
       * `baseline-rejected`, where it read as a bad guess a better guess would fix — and no guess
       * fixes it, because callback synthesis is off by design.
       */
      'callback-input-required',
      'probe-failed',
      'no-mutable-argument',
      'probe-timeout',
      /** The boundary returned a thenable; its validation happens after the probe stopped watching. */
      'async-result-unobserved',
      /** The harness built an input its own declaration calls incomplete; never sent to the library. */
      'incomplete-baseline',
      /**
       * A call WAS built for this alternative and does not select it.
       *
       * Distinct from `no-input` deliberately. `no-input` means nothing could be built and the work
       * is to teach synthesis a shape; this means something was built and it was the wrong thing,
       * and the work is to make the named branch materialize. Collapsing the two hid a defect inside
       * a gap — and for a while hid it inside an `enforced`.
       */
      'branch-not-realized',
    ]);
    expect(Object.keys(byReason).filter((reason) => !admitted.has(reason))).toEqual([]);

    /**
     * THE ALTERNATIVE-LEVEL MAP IS GATED TOO, and against the alternatives themselves.
     *
     * `alternativeUnmeasuredByReason` was published and then checked by nothing: the row-level map had
     * a gate and this one was decoration beside it. A summary nobody verifies is a summary that can
     * drift, and this is the one the header quotes when it says "27 alternatives".
     */
    const byAlternativeReason = enforcement.summary['alternativeUnmeasuredByReason'] as Record<
      string,
      number
    >;
    expect(byAlternativeReason, 'the alternative-level reason map is missing').toBeDefined();
    const counted: Record<string, number> = {};
    for (const record of enforcement.enforcement as unknown as {
      alternatives?: { unmeasuredReason?: string }[];
    }[]) {
      for (const alternative of record.alternatives ?? []) {
        const reason = alternative.unmeasuredReason;
        if (reason === undefined) continue;
        counted[reason] = (counted[reason] ?? 0) + 1;
      }
    }
    expect(
      byAlternativeReason,
      'the published alternative-level reasons do not match the stored alternatives',
    ).toEqual(counted);
    expect(
      Object.keys(byAlternativeReason).filter((reason) => !admitted.has(reason)),
      'an alternative carries a reason outside the vocabulary',
    ).toEqual([]);
  });

  it('a declaration shared by many paths is measured per PATH, not inherited across them', () => {
    /**
     * R10's remaining question, and it has a good answer.
     *
     * `Indicator.explain` is ONE declaration identity covering 625 public paths, because `Indicator`
     * is a generic interface every indicator implements — and those are 625 distinct runtime
     * closures, not one function seen 625 times. If the harness inherited a verdict along that
     * identity, the artifact would be asserting behaviour for 624 functions it never called, which is
     * exactly the class of unfalsifiable claim this phase exists to remove.
     *
     * It does not: 1,302 of the 1,323 records on such identities are measured directly, and their
     * verdicts genuinely disagree (628 enforced, 542 partial, 138 defective) — a spread that
     * inheritance could not produce. This gate keeps it that way.
     *
     * Inheritance along an ALIAS is still correct and still happens: `options:gbmPath` and
     * `options:gbm.path` are two names for one function object, so measuring it twice would be waste.
     * The distinction is whether the paths denote the same runtime function, and a many-path
     * declaration is the case where they do not.
     */
    const pathsPer = new Map<string, string[]>();
    for (const record of committed.contracts) {
      const list = pathsPer.get(record.implementation);
      if (list) list.push(record.id);
      else pathsPer.set(record.implementation, [record.id]);
    }
    const templates = new Set(
      [...pathsPer.entries()].filter(([, paths]) => paths.length > 8).map(([key]) => key),
    );
    const onTemplates = enforcement.enforcement.filter((record) =>
      templates.has(record.implementation),
    );
    expect(
      onTemplates.length,
      'no many-path declarations found — has the identity changed?',
    ).toBeGreaterThan(100);
    /**
     * Inheritance is keyed on the RESOLVED FUNCTION OBJECT now, not on any string, which makes the
     * original hazard structurally impossible: two paths can only share a verdict if they share the
     * function, and a shared declaration is irrelevant to that. So this no longer counts inherited
     * records — it asserts the property that still needs guarding, which is that measurement happened
     * PER FUNCTION rather than once for the template.
     *
     * 625 indicators implement `Indicator.explain`. If one measurement had been copied across all of
     * them, every record under that identity would carry the same verdict and the same source. They do
     * not: the verdicts disagree, and the distinct sources number in the hundreds.
     */
    const sources = new Set(
      onTemplates.map((record) => record.inheritedFrom ?? record.id).map((id) => id.split('#')[0]),
    );
    expect(
      sources.size,
      `every path under a declaration shared by hundreds of distinct runtime functions traces to too ` +
        `few measurements — that would assert behaviour for functions nobody called`,
    ).toBeGreaterThan(50);
    // And the spread proves they are measured individually rather than copied.
    const verdicts = new Set(onTemplates.map((record) => record.verdict));
    expect(
      verdicts.size,
      'every path under a shared declaration got the same verdict — suspicious',
    ).toBeGreaterThan(1);
  });

  it('every non-terminating boundary is DECLARED, not discovered', () => {
    /**
     * A `probe-timeout` is a commitment, not an accident.
     *
     * The supervisor can detect a hang and skip it, and on its own that makes the artifact depend on
     * machine speed: which boundary is in flight when a budget expires is a timing fact, so a slower
     * CI box could skip a different one and fail the drift gate for a reason unrelated to any change.
     * Two runs agreeing on one laptop is not reproducibility.
     *
     * So the skip list is SEEDED from `NON_TERMINATING_BOUNDARIES` and detection becomes a tripwire:
     * anything that times out without being named there fails here. The list is meant to shrink —
     * `adaptiveSimpson` was on it and was fixed at the source instead.
     */
    const timedOut = enforcement.enforcement
      .filter((record) => record.unmeasuredReason === 'probe-timeout')
      .map((record) => record.id);
    const undeclared = timedOut.filter((id) => !(id in NON_TERMINATING_BOUNDARIES));
    expect(
      undeclared,
      `a boundary stopped terminating and nothing says so. Fix it at the source, or add it to ` +
        `NON_TERMINATING_BOUNDARIES with what you measured:\n${undeclared.join('\n')}`,
    ).toEqual([]);
    /**
     * And the list may not outlive its subject. A name that no longer times out is either fixed —
     * delete it — or no longer measured, which is worth noticing.
     */
    /**
     * The list may not outlive its subject, and "measured fine" is not the only way to outlive it: an
     * id that no longer EXISTS was also passing, because `.find` returned undefined and the guard let
     * it through. A declared exception for a boundary that is gone is a claim about nothing.
     */
    const stale = Object.keys(NON_TERMINATING_BOUNDARIES).filter((id) => {
      const record = enforcement.enforcement.find((entry) => entry.id === id);
      return record === undefined || record.unmeasuredReason !== 'probe-timeout';
    });
    expect(
      stale,
      `declared non-terminating but either measured fine or no longer present — delete these from ` +
        `NON_TERMINATING_BOUNDARIES:\n${stale.join('\n')}`,
    ).toEqual([]);
    /**
     * And an entry must name how it was AUDITED, because a skip-list entry cannot be its own evidence:
     * the generator emits `probe-timeout` for anything on the list without calling it, so the gate
     * above would confirm any entry at all. `TOTALFINANCE_IGNORE_DECLARED_SKIPS=1` is the check that can
     * actually refute one, and it is what showed the `swapXva` entry to be false.
     */
    for (const [id, rationale] of Object.entries(NON_TERMINATING_BOUNDARIES)) {
      expect(
        rationale,
        `${id} does not say how it was verified — re-run with TOTALFINANCE_IGNORE_DECLARED_SKIPS=1 and record ` +
          `what the library actually did`,
      ).toMatch(/TOTALFINANCE_IGNORE_DECLARED_SKIPS/);
    }
    // Each entry must say what was measured, not merely that it hangs.
    for (const [id, rationale] of Object.entries(NON_TERMINATING_BOUNDARIES)) {
      expect(rationale.length, `${id} has no rationale`).toBeGreaterThan(40);
    }
  });

  it('an inherited verdict carries its source’s key policy, exactly', () => {
    /**
     * A verdict and the contract it is a verdict ABOUT must travel together.
     *
     * Only scoped packages carry a manifest, so `backtest:crossOver` declares both arguments `open`
     * while its umbrella aliases declare nothing — and an absent policy reads as `closed`. The aliases
     * inherited `enforced` and printed a contract that forbids unknown keys, which neither they nor
     * their source enforce. 38 inherited records disagreed with their source, 8 of them `enforced`:
     * eight paths certified as enforcing a rule the library does not have.
     *
     * The verdicts were right — same function, same behaviour. The contract beside them was not, and a
     * verdict against the wrong contract is exactly the unfalsifiable claim this phase removes.
     */
    const byId = new Map(enforcement.enforcement.map((record) => [record.id, record]));
    const policy = (record: (typeof enforcement.enforcement)[number] | undefined): string =>
      JSON.stringify(record?.inputPolicies ?? null);
    const mismatched = enforcement.enforcement
      .filter((record) => record.inheritedFrom !== undefined)
      .filter((record) => policy(record) !== policy(byId.get(record.inheritedFrom!)))
      .map(
        (record) =>
          `${record.id} ${policy(record)} inherited from ${record.inheritedFrom} ${policy(byId.get(record.inheritedFrom!))}`,
      );
    expect(
      mismatched,
      `an inherited verdict is reported against a DIFFERENT key policy than the measurement it came ` +
        `from:\n${mismatched.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });

  it('the contract graph and the enforcement record agree about every key policy', () => {
    /**
     * ONE PATH, ONE CONTRACT — across artifacts, not just within one.
     *
     * Copying the policy alongside an inherited verdict fixed the verdict side and left the two files
     * disagreeing about 38 paths: `public-contracts.json` reported `null` for every umbrella alias
     * while `public-enforcement.json` reported the copied `open`. A reader consulting the contract
     * graph and a reader consulting the enforcement record would have learned different contracts for
     * the same function, and only one of them the truth.
     *
     * The policy is now propagated along implementation identity in `contract-inventory.ts`, which is
     * where identity lives; this holds the two in step. It compares every record, not only inherited
     * ones — the earlier gate checked an enforcement record against its enforcement SOURCE and so
     * could never see a disagreement with the declared contract.
     */
    const declared = new Map(committed.contracts.map((record) => [record.id, record]));
    const policy = (input: { inputPolicies?: Record<string, string> } | undefined): string =>
      JSON.stringify(input?.inputPolicies ?? null);
    const disagreements = enforcement.enforcement
      .filter((record) => policy(record) !== policy(declared.get(record.id)))
      .map(
        (record) =>
          `${record.id}: enforcement ${policy(record)} vs contract ${policy(declared.get(record.id))}`,
      );
    expect(
      disagreements,
      `the same path is reported under two different key policies depending on which artifact you ` +
        `read:\n${disagreements.slice(0, 12).join('\n')}`,
    ).toEqual([]);
  });

  it('holds the measurement ratchet', () => {
    /**
     * Restated for the `partial` verdict, and the restatement is the point.
     *
     * The previous ratchet held `enforced >= 2881`. That number was inflated by the very defect
     * `partial` exists to fix: 2,026 of those paths had accepted a container mutation, so they were
     * being counted as enforcing a contract whose element-type or empty-input dimension nothing had
     * decided. Only 954 survive the honest definition.
     *
     * Keeping the old floor would have made the gate FIGHT the correction — the ratchet would have
     * failed precisely because the artifact got more truthful. A ratchet must track the measurement's
     * meaning; when the meaning changes, the ratchet is re-derived, not preserved.
     */
    /**
     * Re-derived again for the DEPTH change, and again the re-derivation is the point.
     *
     * `enforced` fell 954 → 654 because the probe stopped stopping at the top level. Those 300 paths
     * did not get worse; they were never fully examined. A ratchet that held the old floor would have
     * failed the moment the measurement got more thorough — the second time in this phase that a
     * ratchet had to be rewritten rather than defended.
     */
    /**
     * Raised, not lowered, for once. Teaching synthesis that an EMPTY contract's minimal call is `{}`
     * rather than a failure moved 310 boundaries out of `no-input`; 156 of them proved they enforce
     * Law 12 — `acos.stream({ qzxBogus: 1 })` throws `input.unknown_field` — which nothing had ever
     * asked, because the harness could not build the `{}` to ask with.
     */
    /**
     * 1,020 and not 1,023, and the three that left were never earned.
     *
     * `register` writes to a global registry, so with a constant synthesized `name` its baseline
     * succeeded and every probe after it was refused as a DUPLICATE — a clean sweep of rejections
     * that had nothing to do with the mutations, scored `enforced`. Minting a fresh identity per call
     * removed the confound and the boundary is `defective`: it accepts an undeclared key, accepts
     * omitting the required `category`, and accepts `category: 42` where a string is declared. All
     * three verified by hand against the harness's own synthesized entry.
     *
     * A ratchet that only ever goes up would have made this correction impossible to land, which is
     * worth remembering the next time one of these numbers falls.
     */
    /**
     * 924, DOWN from 1,024, and the hundred that left were never earned.
     *
     * Measurement is now canonical per (function object, contract): a function is probed ONCE and its
     * other names inherit. Before that, an umbrella alias was probed independently against a target a
     * scoped path had already mutated — and a stateful target that has been probed rejects what comes
     * after, which reads as enforcement. Exactly the `register` false positive, at scale.
     *
     * Verified by hand rather than argued: `blackScholes.price` ACCEPTS omitting `dividendYield`,
     * which its declaration marks required. `options:blackScholes.price` said `defective` and
     * `totalfinance:blackScholes.price` — the same function object, `===` — said `enforced`. Only one of
     * those could be true and the artifact carried both.
     *
     * A ratchet that only rises cannot express a correction. This is the second time that has
     * mattered.
     */
    /**
     * 215, up from 211 — and unlike every re-derivation above, this one is a COST, stated as such.
     *
     * The arithmetic, exactly:  211 + 5 − 3 + 2 = 215
     *   +5  restorers whose new identity/lookback guard refuses the synthesized baseline (see the
     *       rejection-message gate above; a fractional `period`, an envelope with no `kind`)
     *   −3  the `snapshotState` boundaries 3B.1 deleted, which were themselves unmeasured
     *   +2  `SnapshotState#literal` / `#literals`, reachable through `readSnapshot`'s return type;
     *       the harness cannot synthesize the closed set their second argument declares
     *
     * `enforced` is unchanged at 954 and `defective` fell 1,763 → 1,629, so the trade is 4 paths of
     * measurability for 134 that stopped accepting foreign snapshots. Worth naming rather than
     * burying: a guard that refuses a malformed input is also a guard the harness cannot probe
     * through, and that tension does not go away by rounding the number down.
     */
    /**
     * Re-seated on the CURRENT artifact. The 215 arithmetic above is the record of a cost paid at
     * 3B.1a and stays as written — a closed row is dated, not refreshed. The BOUND is a different
     * object and tracks the artifact, or it is a ratchet in name only.
     *
     * 981, up from 966: the 3B.1b shared enforcement path closed the two named seed defects and the
     * silent-miscompute cluster (31 boundaries where omitting a declared-required field reached the
     * arithmetic and returned `NaN` as a success — now zero).
     *
     * 987, up from 984: completing the intersection field trees made 17 previously-unmeasurable
     * boundaries probeable (`unmeasured` 224 -> 207), three of which validate everything the fuller
     * contract now asks about. `defective` rose 1,665 -> 1,689 in the same pass — more fields probed,
     * not more defects written.
     *
     * 984, up from 981 (RV5): the three implied-volatility solvers. Two of them derived their
     * allowed-key list from the PRICING contract, so each accepted the very quantity it solves for
     * and ignored it; the Black-Scholes solver additionally accepted a non-numeric `loVolatility` /
     * `hiVolatility` and reported the resulting failure as `max_iterations`, blaming the algorithm
     * for the argument. Both are now refused at the boundary, and the count moved without a single
     * measurement being lost — `unmeasured` is unchanged at 212, which is the check that the gain is
     * enforcement rather than boundaries quietly dropping out of the probe.
     *
     * 212, up from 208, and the arithmetic is 208 + 1 + 3 — every unit accounted for, not absorbed:
     *
     *   +1  `phiValue`, `defective` → `unmeasured`/`baseline-rejected`. Its `phi` argument is a
     *       DISCRIMINATED UNION, the new guard requires the branch the discriminant selects, and the
     *       synthesized baseline does not carry a complete branch. The same trade 3B.1a recorded — a
     *       guard that refuses malformed input is also a guard the harness cannot probe through. The
     *       guard is correct; union-aware baseline synthesis buys the measurement back.
     *   +3  the three public paths of `requireFiniteFields` itself (scoped, umbrella, umbrella
     *       namespace), all `no-input`. A validator whose second parameter is `unknown` has no
     *       contract to synthesize, which is what `no-input` means rather than a gap to close.
     */
    /**
     * RE-SEATED 2026-08-10 on the measured artifact: enforced 1,134 and unmeasured 197.
     *
     * These sat at 987/207 while four commits moved them to 1,134/197 — each commit message quoting
     * the improvement, none re-seating the bound. The document above states the law they were
     * breaking: "a ratchet is re-seated whenever the number it guards improves, or it is a ratchet in
     * name only." The jump in `enforced` is mostly the 450 boundaries that were falsely `defective`
     * for correctly accepting the omission of an optional field.
     */
    /**
     * Re-seated 2026-08-10 to 1,136 — it FELL by one, and that is the sharper measurement rather than
     * a regression. Probing scalar coordinates moved 21 boundaries `enforced -> defective`; they had
     * been enforced only on the half of the call the harness examined.
     */
    /**
     * RE-SEATED 2026-08-13 to 1,123. It FELL BY THIRTEEN, and the fall is the correction.
     *
     * 46 boundaries were publishing `enforced` against a contract nothing had read. A parameter's
     * members were resolved by looking its declaration up in an index built from EXPORTED types, so an
     * unexported request type — `priceOption`, `americanExercise`, `americanImpliedVolatility`,
     * `compareEngines`, `buildStrategy`, the Kalman family — resolved to nothing, and a boundary with
     * no describable input cannot be found wanting by any mutation. The generator now reads those
     * members off the type; the same boundaries are measured against what they actually declare, and
     * some of them fail. Roughly a third came back on the other side, which is why the net is 13.
     *
     * A ratchet that could only rise would have forbidden this, because the honest consequence of
     * measuring more is measuring worse. The bound tracks the artifact and the reason is written here
     * — the same discipline the two entries above record, and the reason this is a re-seat rather
     * than a tolerance.
     */
    /**
     * Re-seated 2026-08-13 to 1,120 alongside the literal-domain round. Three boundaries left
     * `enforced`: recording numeric domains gave the probe an out-of-domain value to send in the
     * domain's OWN primitive — it had been sending a string at a numeric domain, which any `typeof`
     * check answers — and the arm-resolving recursion put nested union fields in reach for the first
     * time. Both make the same call harder to pass, which is the point of running them.
     */
    /**
     * RE-SEATED 2026-08-14 to 658 — it FELL BY 462, and the fall is a new mutation running, not
     * decay. `null-when-nonnullable` (9,205 probes) asks a question nothing had ever asked: does
     * the boundary accept a `null` its declaration refuses? A guard reading `v == null` as absence
     * rejects `wrong-type`'s string — so every one of these boundaries read as enforced on exactly
     * the dimension it is not, and no earlier mutation could tell the two apart. 2,629 records
     * accept such a null (`new AlmaStream({ period: null })` builds `weights: [null], denom: 0`
     * with no error). Same discipline as the four re-seats above: the honest consequence of
     * measuring more is measuring worse, and the bound tracks the artifact.
     */
    expect(enforcement.summary['enforced'] as number).toBeGreaterThanOrEqual(658);
    /**
     * Re-seated 179 -> 182, and the RISE is the correction rather than a regression. `streamAsync`
     * and its aliases were counted as MEASURED on four mutations that returned an unadvanced
     * generator object; refusing to claim them moves three paths into `async-result-unobserved`. A
     * ratchet that only ever falls would have forbidden telling the truth here, so the bound tracks
     * the artifact and the reason is written down.
     */
    // 182 -> 193: the same widening. Every one carries a reason; see the reason gate below.
    // 193 -> 198 (FC2, 2026-08-19): the forecasting pair (projectFinancialStatements,
    // discountedCashFlowFromStatements) is `no-input` — the variant planner cannot build a NAMED
    // union arm inside an array element, a harness follow-up, not a surface defect (the default
    // baseline builds; the probe proved it by hand). The remainder is recorded sensitivity arms.
    // 198 -> 201 (2026-08-23 review wave): the same three typed baseline-rejections; every row
    // carries its recorded reason and rejection.
    // 201 -> 198 (2026-08-23 third-review harvest): the RateCurve/schema unification made those
    // three baselines measurable again — the ratchet shrinks back.
    // 198 -> 183 (2026-08-26 fourth-review closeout): the 49 constructor heads gained fixtures and
    // measured, and the two null-coercing heads were repaired and measured in full.
    // 183 -> 185 (Stage 7B.2 slice 4, 2026-09-06): AuthorizationStore#put and ExecutionJournalStore#append are
    // interface methods the LIBRARY calls (external-callback-contract), the same class as ArtifactStore#put
    // and JobStore#create; their memory and file implementations are enforced through their factories.
    // 185 -> at most 186 (R08 repair, 2026-09-07): ONLY the new
    // @totalfinance/workflows:ExecutionJournalStore#transact interface is admitted, for that same reason.
    // A fixture choosing one implementation cannot prove an arbitrary caller-supplied store.
    // packages/workflows/test/store-transactions.test.ts exercises BOTH memory/file transact methods:
    // commit-before-return, detached history, read-only calls, conflicting batches, callback failure,
    // invalid input/output, and nested writes. trade-transactions.test.ts proves real cross-process
    // workflow effects. These are implementation evidence, not a fabricated interface measurement.
    // 186 -> 187 (pre-publish repairs B4, 2026-09-21): @totalfinance/workflows:AuthorizationStore#consume
    // is the grant-consumption door of the same caller-supplied store contract as #put and is
    // admitted for the same reason. Both memory and file implementations are exercised by
    // packages/workflows/test/grant-consumption.test.ts (unconsumed after put, consumed once,
    // idempotent for the same receipt, refused for any other), and trade.submit's consumption is
    // proven end to end there. The same slice repaired the signature classifier that had been
    // reading `{ createdTimestampMs: EpochMs; ... }` as a NUMBER and dropping #put from candidacy
    // (tools/manifest/signature-conformance.test.ts), so #put is counted here again rather than
    // hidden.
    // Keep the old bound for every other identity; retire this allowance if the row becomes measured.
    const journalTransaction = enforcement.enforcement.find(
      (record) => record.id === '@totalfinance/workflows:ExecutionJournalStore#transact',
    );
    expect(journalTransaction, 'the transactional store contract vanished').toBeDefined();
    const transactionResidual = journalTransaction?.verdict === 'unmeasured' ? 1 : 0;
    if (transactionResidual) {
      expect(journalTransaction?.unmeasuredReason).toBe('external-callback-contract');
      expect(journalTransaction?.mutationsExecuted).toBeUndefined();
    }
    const grantConsume = enforcement.enforcement.find(
      (record) => record.id === '@totalfinance/workflows:AuthorizationStore#consume',
    );
    expect(grantConsume, 'the grant-consumption store contract vanished').toBeDefined();
    const consumeResidual = grantConsume?.verdict === 'unmeasured' ? 1 : 0;
    if (consumeResidual) {
      expect(grantConsume?.unmeasuredReason).toBe('external-callback-contract');
      expect(grantConsume?.mutationsExecuted).toBeUndefined();
    }
    expect(enforcement.summary['unmeasured'] as number).toBeLessThanOrEqual(
      185 + transactionResidual + consumeResidual,
    );
    // Coverage must not silently fall: a probe that stops running looks exactly like one that passes.
    const executed = enforcement.summary['mutationsExecuted'] as Record<string, number>;
    const covered = enforcement.summary['mutationsCovered'] as Record<string, number>;
    // EXECUTION is the number that answers "was this actually run?". Ratchet it, not the attributed
    // figure, or a probe could stop running while alias fan-out held the total up.
    expect(executed['invalid-literal'] ?? 0).toBeGreaterThanOrEqual(386);
    // Re-seated 2,489 (was 3,357). Execution FELL because undeclared sample keys stopped being
    // probed — those runs measured fields no contract declares, so losing them is the point.
    expect(executed['non-finite'] ?? 0).toBeGreaterThanOrEqual(2489);
    // Seeded at its first full run (2026-08-14). Every declared non-nullable field gets one probe,
    // so this stopping silently would un-measure the library's largest defect class.
    // Re-seated 9,205 → 9,202 (2026-08-16): tosStdevAll's declaration became truthful
    // (`period?: number | null` — null IS the documented all-history convention), so three paths'
    // period fields stopped being non-nullable and the mutation's premise no longer applies there.
    // A ratchet tracks the population it measures; a truthful-declaration shrink is not decay.
    expect(executed['null-when-nonnullable'] ?? 0).toBeGreaterThanOrEqual(9202);
    // Coverage must never be SMALLER than execution: every executed probe covers at least its own path.
    for (const [mutation, runs] of Object.entries(executed)) {
      expect(covered[mutation] ?? 0, `${mutation}: covered < executed`).toBeGreaterThanOrEqual(
        runs,
      );
    }
    /**
     * Receiver acquisition (R12) must not regress.
     *
     * 42 instance methods were reported as having nothing to measure ever. Constructing their owners
     * reached 25 of them, and four produced verdicts immediately —
     * `SimulatedBroker#processBar` accepts an unknown key, accepts omitting the required
     * `timestampMs`, and accepts `NaN` for it, all verified by hand. A ratchet rather than a target:
     * the remaining 17 are constructors synthesis cannot build yet.
     */
    const byReason = enforcement.summary['unmeasuredByReason'] as Record<string, number>;
    // Re-seated 2026-08-10 (measured 4). It has measured 4 since 4e3bea33, ten commits before the
    // bound was last reviewed — a pre-existing drift, inherited rather than created here.
    expect(byReason['receiver-unresolved'] ?? 0).toBeLessThanOrEqual(4);
    // Every candidate lands in exactly one bucket; a verdict that escapes the four is a bug.
    const total =
      (enforcement.summary['enforced'] as number) +
      (enforcement.summary['partial'] as number) +
      (enforcement.summary['defective'] as number) +
      (enforcement.summary['unmeasured'] as number);
    expect(total).toBe(enforcement.summary['candidates']);
  });

  it('never reports `enforced` for a path that accepted a mutation', () => {
    /**
     * The property `partial` was introduced to guarantee. `enforced` used to be awarded whenever no
     * AUTHORITATIVE mutation failed, which said nothing about the advisory ones — and 1,851 paths
     * were accepting at least one. `@totalfinance/math:determinant` declares a matrix, was handed a
     * one-dimensional array, accepted it, and was published as enforced.
     */
    const overclaimed = enforcement.enforcement
      .filter((record) => record.verdict === 'enforced')
      .filter(
        (record) =>
          (record.advisory ?? []).some((result) => result.verdict !== 'rejected') ||
          (record.failures ?? []).length > 0,
      )
      .map((record) => record.id);
    expect(
      overclaimed,
      `paths calling themselves enforced while having accepted a mutation:\n${overclaimed.slice(0, 15).join('\n')}`,
    ).toEqual([]);

    // And every `partial` must say WHICH dimension is open, or it is just a softer overclaim.
    const silent = enforcement.enforcement
      .filter((record) => record.verdict === 'partial')
      .filter((record) => (record.undecided ?? []).length === 0)
      .map((record) => record.id);
    expect(silent).toEqual([]);
  });

  it('probes past the top level, and supplies declared optional fields', () => {
    /**
     * R11 depth, asserted rather than assumed. The probe used to read the first six keys of the
     * SAMPLE object: 18 contracts declare more than six required fields, a declared field the
     * synthesis skipped was never seen at all, nested contracts were never entered, and an optional
     * field was never supplied — "you may leave this out" was being read as "anything goes when you
     * put it in".
     *
     * `defineCalendar` is the case that proves the depth is real: it accepts a `session` missing its
     * declared-required `close`, and accepts `session.open = 12345` where the contract declares a
     * string. No top-level probe could have seen either.
     */
    // Nested observations are counted across failures AND advisory: the property this asserts is
    // probe DEPTH, and the artifact-valued-field rulings (C05) route curated member observations
    // to advisory without un-probing them — verdict routing must not read as lost depth.
    const nested = enforcement.enforcement.flatMap((record) =>
      [...(record.failures ?? []), ...(record.advisory ?? [])].filter((failure) =>
        (failure as { field?: string }).field?.includes('.'),
      ),
    );
    expect(nested.length, 'no nested contract was probed at all').toBeGreaterThan(500);

    // Depth is proven by EXECUTION, not by conviction. This floor once counted surviving
    // optional-wrong-type failures (> 100), which decayed as the when-present ladders closed
    // them — a depth gate that a fully-enforced library would FAIL is measuring the wrong thing
    // (the twenty-sixth wave drove the conviction count 102 → 82 and tripped it). The probe's
    // depth lives in mutationsExecuted, which tallies what was supplied regardless of verdict.
    const optionalExecuted = enforcement.enforcement.reduce(
      (sum, record) => sum + ((record.mutationsExecuted ?? {})['optional-wrong-type'] ?? 0),
      0,
    );
    expect(optionalExecuted, 'no declared optional field was ever supplied').toBeGreaterThan(2000);
    const optional = enforcement.enforcement.flatMap((record) =>
      (record.failures ?? []).filter((failure) => failure.mutation === 'optional-wrong-type'),
    );
    // Supplying an optional field can only convict against a DECLARATION; a guess would be noise.
    expect(optional.every((failure) => failure.declared === true)).toBe(true);
  });

  it('gives each exposure its own identity when the same name is two functions', () => {
    /**
     * 17 umbrella exposures collapsed different callables under one id — `totalfinance/technical-analysis`
     * exports a two-argument series `skew`, `totalfinance/volatility` a one-argument object-request `skew`,
     * and the merged record named one implementation while carrying the other's probe evidence.
     */
    // Asserted against the CONTRACT graph, which is where identity lives. The enforcement record only
    // covers boundaries with an object or series input, so a collided name like `yearFraction` — three
    // scalars — never appears there even though its identity was equally collapsed.
    const byId = new Map(committed.contracts.map((record) => [record.id, record]));
    for (const [left, right] of [
      ['totalfinance/technical-analysis:skew', 'totalfinance/volatility:skew'],
      ['totalfinance/math:covariance', 'totalfinance/risk:covariance'],
      ['totalfinance/core:yearFraction', 'totalfinance/fixed-income:yearFraction'],
    ]) {
      const a = byId.get(left!);
      const b = byId.get(right!);
      expect(a, `${left} should be its own identity`).toBeDefined();
      expect(b, `${right} should be its own identity`).toBeDefined();
      expect(a!.implementation).not.toBe(b!.implementation);
    }
    // The collapsed bare identities must be gone.
    expect(byId.has('totalfinance:skew')).toBe(false);
  });
});
