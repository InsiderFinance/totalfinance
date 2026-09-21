/**
 * A UNION WAS MEASURED ON ONE BRANCH, AND THE VERDICT SPOKE FOR ALL OF THEM.
 *
 * `measureVariant` returns the moment a baseline is not rejected, so a HEALTHY union never reached
 * its second branch: `strategyFromChain` declares ten `type` values and exactly one was ever called.
 * Branch identity also rode `attempt` — the retry counter that simultaneously walks curated value
 * alternatives and admits choice-group optionals — so one number selected three independent things
 * and none of them could be read back.
 *
 * These fixtures bind the four properties that make variant coverage mean something:
 *
 *   1. an alternative is a DISCRIMINATOR LITERAL, not an AST branch;
 *   2. independent sibling unions are NOT crossed (the combinatorial explosion the ruling forbids);
 *   3. a union nested inside a selected branch IS reached (the combination the ruling requires);
 *   4. the aggregation ladder is pessimistic at every rung.
 *
 * The last test binds it to the committed artifact, because a hand-made shape proves the code path
 * while the artifact proves the RESULT.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregateVerdict } from './contract-enforcement.js';
import {
  alternativeIdOf,
  choiceFor,
  enumerateVariants,
  synthesizeArguments,
  unionSites,
  type SynthesisParameter,
} from './contract-synthesis.js';

const numeric = (name: string) => ({
  name,
  type: 'number',
  kind: 'numeric',
  optional: false,
  nullable: false,
});

const tag = (name: string, literals: string[]) => ({
  name,
  type: literals.map((literal) => `'${literal}'`).join(' | '),
  kind: 'enum',
  optional: false,
  nullable: false,
  literals,
});

/** Two AST branches; the first declares TWO literals, so the union offers three alternatives. */
const THREE_ALTERNATIVES: SynthesisParameter = {
  name: 'config',
  type: 'Spread | Single',
  optional: false,
  kind: 'object',
  branches: [
    { type: '', kind: 'object', fields: [tag('type', ['bull', 'bear']), numeric('width')] },
    { type: '', kind: 'object', fields: [tag('type', ['single']), numeric('strike')] },
  ],
};

const twoBranch = (name: string, literals: [string, string]): SynthesisParameter => ({
  name,
  type: 'A | B',
  optional: false,
  kind: 'object',
  branches: [
    { type: '', kind: 'object', fields: [tag('kind', [literals[0]]), numeric('a')] },
    { type: '', kind: 'object', fields: [tag('kind', [literals[1]]), numeric('b')] },
  ],
});

describe('an alternative is a discriminator literal, not an AST branch', () => {
  it('expands a branch declaring several literals into one variant each', () => {
    // Two structural branches, three `type` values. Measuring per BRANCH would report two — and the
    // four spread variants of `strategyFromChain` share one shape, so that undercount is the norm
    // rather than the corner case.
    const { variants } = enumerateVariants([THREE_ALTERNATIVES], []);
    expect(variants.map((variant) => variant.id).sort()).toEqual([
      'arg0:type=bear',
      'arg0:type=bull',
      'arg0:type=single',
    ]);
  });

  it('names the canonical variant by what it SELECTED, never `baseline`', () => {
    // An anonymous default is the one alternative every other measurement is compared against.
    const { variants } = enumerateVariants([THREE_ALTERNATIVES], []);
    expect(variants[0]?.id).toBe('arg0:type=bull');
  });

  it('actually BUILDS the selected literal, rather than the branch default', () => {
    // The discriminator is what the variant IS, so it cannot be answered with `literals[0]` — that
    // was the bug that made every literal of one branch produce an identical call.
    const { variants } = enumerateVariants([THREE_ALTERNATIVES], []);
    const bear = variants.find((variant) => variant.id === 'arg0:type=bear');
    expect(choiceFor(bear!.selection, 'arg0')?.discriminator).toEqual([
      { field: 'type', value: 'bear' },
    ]);
  });
});

describe('independent unions are not crossed; nested ones are', () => {
  it('does NOT take the Cartesian product of sibling unions', () => {
    /**
     * Two independent two-way unions. The ruling is explicit: exercise each alternative while
     * holding the other coordinates at canonical valid values. That is 1 canonical + 1 + 1 = 3.
     * A Cartesian walk would give 4 here and 2^n in general, which is how a bounded pass turns into
     * an unbounded one on a contract with a handful of options bags.
     */
    const { variants } = enumerateVariants(
      [twoBranch('left', ['x', 'y']), twoBranch('right', ['p', 'q'])],
      [],
    );
    /**
     * Three calls, and every id names the WHOLE call. An unfixed union is not "unspecified": it is
     * fixed to its default, and writing that down is what lets a hand fixture and its synthesized
     * twin be recognised as one call instead of measured twice under two spellings.
     */
    expect(variants.map((variant) => variant.id).sort()).toEqual([
      'arg0:kind=x & arg1:kind=p',
      'arg0:kind=x & arg1:kind=q',
      'arg0:kind=y & arg1:kind=p',
    ]);
  });

  it('reaches a union NESTED inside a branch only that branch selects', () => {
    /**
     * The one place combination IS required. `inner` exists only under `outer=deep`, so its
     * alternatives are unreachable until `outer=deep` is held — which is the ruling's "add curated
     * combinations where coordinates interact", derived rather than curated.
     */
    const nested: SynthesisParameter = {
      name: 'config',
      type: 'Shallow | Deep',
      optional: false,
      kind: 'object',
      branches: [
        { type: '', kind: 'object', fields: [tag('outer', ['shallow']), numeric('n')] },
        {
          type: '',
          kind: 'object',
          fields: [
            tag('outer', ['deep']),
            {
              name: 'inner',
              type: 'P | Q',
              kind: 'object',
              optional: false,
              nullable: false,
              branches: [
                { type: '', kind: 'object', fields: [tag('mode', ['p']), numeric('u')] },
                { type: '', kind: 'object', fields: [tag('mode', ['q']), numeric('v')] },
              ],
            },
          ],
        },
      ],
    };
    const ids = enumerateVariants([nested], []).variants.map((variant) => variant.id);
    // Selecting the outer branch REVEALS the nested union, so the call that selects it names both.
    expect(ids).toContain('arg0:outer=deep & arg0:outer=deep.inner:mode=p');
    // The nested alternative is reached, addressed by its path from the ARGUMENT, not the parameter
    // name — the same coordinate space `inputPolicies` indexes — and QUALIFIED by the outer branch
    // that makes it reachable, because `arg0.inner` is a different declaration under each one.
    expect(ids).toContain('arg0:outer=deep & arg0:outer=deep.inner:mode=q');
    // `mode=p` is the nested default, exercised exactly once — by the call that selects `outer=deep`.
    expect(ids.filter((id) => id.includes('mode=p'))).toHaveLength(1);
  });
});

describe('the aggregation ladder is pessimistic at every rung', () => {
  it('any alternative defective makes the boundary defective', () => {
    // A public union promises every alternative is supported. One broken door is a broken contract.
    expect(aggregateVerdict(['enforced', 'enforced', 'defective'])).toBe('defective');
    expect(aggregateVerdict(['unmeasured', 'defective'])).toBe('defective');
  });

  it('every alternative enforced, and only then, is enforced', () => {
    expect(aggregateVerdict(['enforced', 'enforced'])).toBe('enforced');
    // The exact case the ruling names: six enforced plus one unmeasured is NOT enforced.
    expect(aggregateVerdict(['enforced', 'enforced', 'unmeasured'])).toBe('partial');
  });

  it('one measured alongside a partial or unmeasured is partial', () => {
    expect(aggregateVerdict(['partial', 'enforced'])).toBe('partial');
    expect(aggregateVerdict(['enforced', 'unmeasured'])).toBe('partial');
  });

  it('nothing measured is unmeasured — an aggregate cannot invent evidence', () => {
    expect(aggregateVerdict(['unmeasured', 'unmeasured'])).toBe('unmeasured');
  });
});

describe('the committed artifact measures every declared alternative', () => {
  const artifact = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-enforcement.json', import.meta.url)), 'utf8'),
  ) as {
    enforcement: {
      id: string;
      verdict: string;
      alternatives?: { id: string; verdict: string }[];
      alternativeSummary?: { total: number; truncated?: boolean };
    }[];
  };

  it('strategyFromChain records ten alternatives, one per declared type', () => {
    // The reviewer's worked example: seven TypeScript branches, ten discriminator variants.
    const row = artifact.enforcement.find(
      (r) => r.id === '@totalfinance/strategy:strategyFromChain',
    );
    expect(row?.alternativeSummary?.total, 'strategyFromChain lost its alternatives').toBe(10);
    expect(new Set(row?.alternatives?.map((a) => a.id)).size).toBe(10);
  });

  it('no recorded alternative set is silently truncated', () => {
    // `VARIANT_LIMIT` bounds the sweep; if it ever bites, it must be visible rather than read as
    // exhaustive coverage. This fails loudly the first time a contract outgrows the cap.
    const truncated = artifact.enforcement
      .filter((row) => row.alternativeSummary?.truncated)
      .map((row) => row.id);
    expect(truncated, `${truncated.length} boundaries hit VARIANT_LIMIT`).toEqual([]);
  });

  it('a boundary carrying alternatives agrees with its own aggregation ladder', () => {
    // The published verdict must be the one the ladder derives from the published alternatives —
    // otherwise the summary is decoration beside a number produced some other way.
    const disagreed: string[] = [];
    for (const row of artifact.enforcement) {
      if (!row.alternatives?.length) continue;
      const expected = aggregateVerdict(
        row.alternatives.map((alternative) => alternative.verdict as never),
      );
      if (expected !== row.verdict) disagreed.push(`${row.id}: ${row.verdict} vs ${expected}`);
    }
    expect(disagreed).toEqual([]);
  });
});

/**
 * A NON-OBJECT BRANCH IS STILL AN ALTERNATIVE.
 *
 * `classifyStrategy(legs: Position | ReadonlyArray<LegInput> |
 * ReadonlyArray<ClassifiableLeg>)` expands to `[23 fields, null, null]`: two of
 * its three alternatives have no shape, so a walk that looked only for shapes
 * could not represent them. Worse, the parameter reads as `series`, and branch
 * selection lived only in the `object` case — so it never ran at all. The scoped
 * spelling reported `enforced` from the one branch it built while the umbrella
 * reported `partial` from an array: one callable, two verdicts.
 */
describe('non-object union branches', () => {
  const mixed: SynthesisParameter = {
    name: 'legs',
    type: 'Position | ReadonlyArray<LegInput>',
    optional: false,
    // Deliberately NOT `object` — this is what made the whole branch set invisible.
    kind: 'series',
    branches: [
      {
        type: 'Position',
        kind: 'object',
        fields: [tag('side', ['long', 'short']), numeric('quantity')],
      },
      { type: 'ReadonlyArray<LegInput>', kind: 'other' },
    ],
  };

  it('enumerates the branch that has no field shape', () => {
    const ids = enumerateVariants([mixed], []).variants.map((variant) => variant.id);
    expect(ids).toContain('arg0#1');
  });

  it('keeps branch INDICES aligned with the declaration', () => {
    // Filtering the nulls out renumbered the list, so `#0` named the first
    // OBJECT branch rather than the first declared one — an id for the wrong
    // alternative.
    const { variants } = enumerateVariants([mixed], []);
    const arrayBranch = variants.find((variant) => variant.id === 'arg0#1');
    expect(choiceFor(arrayBranch!.selection, 'arg0')?.branch).toBe(1);
  });

  it('builds the array branch as an array', () => {
    const { variants } = enumerateVariants([mixed], []);
    const arrayBranch = variants.find((variant) => variant.id === 'arg0#1')!;
    const built = synthesizeArguments([mixed], [], 0, undefined, arrayBranch.selection);
    expect(Array.isArray(built?.[0])).toBe(true);
  });

  it('does NOT fall back to another branch when the selected one cannot be built', () => {
    // The failure this replaced: an unbuildable `Position` variant silently
    // produced the ARRAY branch's value, so three alternatives measured one call
    // under three names. Unbuildable must mean unmeasured.
    const unbuildable: SynthesisParameter = {
      name: 'legs',
      type: 'Opaque | ReadonlyArray<number>',
      optional: false,
      kind: 'series',
      branches: [
        {
          type: 'Opaque',
          kind: 'object',
          fields: [
            { name: 'handle', type: 'Opaque', kind: 'other', optional: false, nullable: false },
          ],
        },
        { type: 'ReadonlyArray<number>', kind: 'other' },
      ],
    };
    const { variants } = enumerateVariants([unbuildable], []);
    const objectBranch = variants.find((variant) => variant.id.endsWith('#0'));
    expect(objectBranch, 'the object branch must still be enumerated').toBeDefined();
    expect(
      synthesizeArguments([unbuildable], [], 0, undefined, objectBranch!.selection),
    ).toBeNull();
  });
});

describe('no enumeration ever emits a duplicate alternative id', () => {
  it('holds across every contract in the committed artifact', () => {
    // A duplicate id means two variants are indistinguishable in the artifact —
    // the composition of a sibling union with a nested one produced exactly that
    // before the seen-set became global.
    const contracts = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as {
      contracts: {
        id: string;
        fields?: string[];
        signatures?: { parameters?: SynthesisParameter[] }[];
      }[];
    };
    const offenders: string[] = [];
    for (const record of contracts.contracts) {
      const ids = enumerateVariants(
        record.signatures?.[0]?.parameters ?? [],
        record.fields ?? [],
      ).variants.map((variant) => variant.id);
      if (new Set(ids).size !== ids.length) offenders.push(record.id);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every union node in the library a UNIQUE name and a unique identity', () => {
    /**
     * The library-wide form of contextual identity. Two union nodes sharing a NAME are two contracts
     * the artifact reports as one; two sharing a KEY would share a selection, so choosing a branch of
     * the first would silently choose one of the second.
     *
     * Asserted across every declared contract rather than on a constructed shape: the constructed
     * shape proves the mechanism, this proves the result.
     */
    const contracts = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as {
      contracts: {
        id: string;
        fields?: string[];
        signatures?: { parameters?: SynthesisParameter[] }[];
      }[];
    };
    const collisions: string[] = [];
    for (const record of contracts.contracts) {
      const sites = unionSites(record.signatures?.[0]?.parameters ?? [], record.fields ?? []);
      const paths = sites.map((site) => site.path);
      const keys = sites.map((site) => site.key);
      if (new Set(paths).size !== paths.length) collisions.push(`${record.id} (name)`);
      if (new Set(keys).size !== keys.length) collisions.push(`${record.id} (identity)`);
    }
    expect(collisions, 'two union nodes are indistinguishable').toEqual([]);
  });
});

/**
 * A HAND FIXTURE IS IDENTIFIED BY ITS WHOLE SELECTION, not its outer branch.
 *
 * `alternativeOf` returned on the first matching site, so a fixture choosing a
 * nested non-default alternative was labelled with the OUTER branch alone — the
 * same id the synthesized variant carries when it takes the nested DEFAULT. One
 * alternative was then counted twice and the nested default was never measured.
 */
describe('nested hand-fixture identification', () => {
  const nested: SynthesisParameter = {
    name: 'config',
    type: 'Shallow | Deep',
    optional: false,
    kind: 'object',
    branches: [
      { type: '', kind: 'object', fields: [tag('outer', ['shallow']), numeric('n')] },
      {
        type: '',
        kind: 'object',
        fields: [
          tag('outer', ['deep']),
          {
            name: 'inner',
            type: 'P | Q',
            kind: 'object',
            optional: false,
            nullable: false,
            branches: [
              { type: '', kind: 'object', fields: [tag('mode', ['p']), numeric('u')] },
              { type: '', kind: 'object', fields: [tag('mode', ['q']), numeric('v')] },
            ],
          },
        ],
      },
    ],
  };

  const sitesFor = () => unionSites([nested], []);

  it('names BOTH the outer branch and the nested one it selects', () => {
    const id = alternativeIdOf([{ outer: 'deep', inner: { mode: 'q', v: 1 } }], sitesFor(), [
      nested,
    ]);
    // The nested half repeats its ancestor deliberately: the same string names the same node
    // whether it is read from a fixture label or from an enumerated variant id.
    expect(id).toBe('arg0:outer=deep & arg0:outer=deep.inner:mode=q');
  });

  it('does NOT collide with the variant that takes the nested default', () => {
    // `arg0:outer=deep` synthesizes `mode=p`. A fixture on `mode=q` must not
    // claim that id, or the default alternative silently loses its measurement.
    const fixtureId = alternativeIdOf([{ outer: 'deep', inner: { mode: 'q', v: 1 } }], sitesFor(), [
      nested,
    ]);
    const enumerated = enumerateVariants([nested], []).variants.map((variant) => variant.id);
    expect(enumerated).toContain('arg0:outer=deep & arg0:outer=deep.inner:mode=p');
    expect(fixtureId).not.toBe('arg0:outer=deep & arg0:outer=deep.inner:mode=p');
    // The fixture's id is the id enumeration would give the SAME call — one identity, not two.
    expect(enumerated).toContain(fixtureId!);
  });

  it('still identifies a fixture that takes the nested default', () => {
    const id = alternativeIdOf([{ outer: 'deep', inner: { mode: 'p', u: 1 } }], sitesFor(), [
      nested,
    ]);
    expect(id).toBe('arg0:outer=deep & arg0:outer=deep.inner:mode=p');
  });
});

/**
 * A UNION'S IDENTITY IS ITS PATH **UNDER ITS ANCESTORS**, NOT ITS PATH.
 *
 * Keying a union node by its dotted path alone conflated declarations that merely sit at the same
 * position. `arg0.inner` under `outer=left` and `arg0.inner` under `outer=right` are two different
 * unions, and both the enumeration and the labelling took them for one:
 *
 *   - enumeration dropped alternatives. The path was in the global `reached` set from the FIRST
 *     walk, so descending into the second outer branch found "nothing new" and never queued the
 *     alternatives that only exist there.
 *   - labelling misattributed. A hand fixture selecting a branch of the second union was matched
 *     against the first union's alternatives and reported under one of ITS names, filing real
 *     evidence against a contract the call never touched.
 *
 * Both are silent: the counts stay plausible and every id is well-formed.
 */
describe('contextual union identity', () => {
  /** Outer `left | right`, each carrying a DIFFERENT `inner` union at the same dotted path. */
  const divergent: SynthesisParameter = {
    name: 'config',
    type: 'Left | Right',
    optional: false,
    kind: 'object',
    branches: [
      {
        type: '',
        kind: 'object',
        fields: [
          tag('side', ['left']),
          {
            name: 'inner',
            type: 'P | Q',
            kind: 'object',
            optional: false,
            nullable: false,
            branches: [
              { type: '', kind: 'object', fields: [tag('mode', ['p']), numeric('u')] },
              { type: '', kind: 'object', fields: [tag('mode', ['q']), numeric('v')] },
            ],
          },
        ],
      },
      {
        type: '',
        kind: 'object',
        fields: [
          tag('side', ['right']),
          {
            name: 'inner',
            type: 'R | S',
            kind: 'object',
            optional: false,
            nullable: false,
            branches: [
              { type: '', kind: 'object', fields: [tag('mode', ['r']), numeric('w')] },
              { type: '', kind: 'object', fields: [tag('mode', ['s']), numeric('z')] },
            ],
          },
        ],
      },
    ],
  };

  it('enumerates the nested alternatives of EVERY outer branch', () => {
    // The reviewer's reproduction: `right/s` was missing entirely — three variants where four are
    // declared, and the missing one is the only way to reach that branch's second arm.
    const ids = enumerateVariants([divergent], []).variants.map((variant) => variant.id);
    expect(ids).toContain('arg0:side=right & arg0:side=right.inner:mode=r');
    expect(ids).toContain('arg0:side=left & arg0:side=left.inner:mode=q');
    expect(ids).toContain('arg0:side=right & arg0:side=right.inner:mode=s');
  });

  it('labels a fixture by the union it ACTUALLY selects, not the one at the same path', () => {
    // Reported before as `right/q`: the right-hand fixture matched against the LEFT union's
    // alternatives, which do not include `mode=s` at all.
    const id = alternativeIdOf(
      [{ side: 'right', inner: { mode: 's', z: 1 } }],
      unionSites([divergent], []),
      [divergent],
    );
    expect(id).toBe('arg0:side=right & arg0:side=right.inner:mode=s');
  });

  it('does not attribute a fixture to a nested union its own branch cannot reach', () => {
    // The left fixture must pick up the LEFT nested site and nothing else — the right-hand site is
    // out of scope for it, and matching both would report two selections for one union.
    const id = alternativeIdOf(
      [{ side: 'left', inner: { mode: 'q', v: 1 } }],
      unionSites([divergent], []),
      [divergent],
    );
    expect(id).toBe('arg0:side=left & arg0:side=left.inner:mode=q');
  });

  it('keeps REPEATED discriminators apart — same tag, same literals, different unions', () => {
    /**
     * The hardest case, because every string matches: both inner unions are discriminated by `mode`
     * over the same literals `on | off`, so path-keyed ids collide EXACTLY. Without the ancestor
     * qualifier, `arg0.inner:mode=off` names two different declarations and whichever is measured
     * second is silently discarded as a duplicate.
     */
    const repeated: SynthesisParameter = {
      ...divergent,
      branches: [
        {
          type: '',
          kind: 'object',
          fields: [
            tag('side', ['left']),
            {
              name: 'inner',
              type: 'OnOff',
              kind: 'object',
              optional: false,
              nullable: false,
              branches: [
                { type: '', kind: 'object', fields: [tag('mode', ['on']), numeric('u')] },
                { type: '', kind: 'object', fields: [tag('mode', ['off']), numeric('v')] },
              ],
            },
          ],
        },
        {
          type: '',
          kind: 'object',
          fields: [
            tag('side', ['right']),
            {
              name: 'inner',
              type: 'OnOff',
              kind: 'object',
              optional: false,
              nullable: false,
              branches: [
                { type: '', kind: 'object', fields: [tag('mode', ['on']), numeric('w')] },
                { type: '', kind: 'object', fields: [tag('mode', ['off']), numeric('z')] },
              ],
            },
          ],
        },
      ],
    };
    const ids = enumerateVariants([repeated], []).variants.map((variant) => variant.id);
    expect(new Set(ids).size, 'a repeated discriminator collapsed two unions into one id').toBe(
      ids.length,
    );
    expect(ids).toContain('arg0:side=left & arg0:side=left.inner:mode=off');
    expect(ids).toContain('arg0:side=right & arg0:side=right.inner:mode=off');
  });

  it('separates SHAPE-ONLY branches that differ only by field TYPE', () => {
    /**
     * Two branches, same required field name, different declared types. Branch selection asks a
     * structural question on purpose — a value with one wrong field type must still be attributed to
     * a branch rather than to none — but structural alone cannot separate these, so the first branch
     * absorbed calls belonging to the second. The typed walk runs first and structural stays as the
     * fallback, so both properties hold at once.
     */
    const shapeOnly: SynthesisParameter = {
      name: 'point',
      type: 'AtTime | AtIndex',
      optional: false,
      kind: 'object',
      branches: [
        {
          type: 'AtTime',
          kind: 'object',
          fields: [
            { name: 'at', type: 'string', kind: 'string', optional: false, nullable: false },
          ],
        },
        {
          type: 'AtIndex',
          kind: 'object',
          fields: [
            { name: 'at', type: 'number', kind: 'numeric', optional: false, nullable: false },
          ],
        },
      ],
    };
    const sites = unionSites([shapeOnly], []);
    expect(alternativeIdOf([{ at: 7 }], sites, [shapeOnly])).toBe('arg0#1');
    expect(alternativeIdOf([{ at: 'noon' }], sites, [shapeOnly])).toBe('arg0#0');
  });

  it('gives the two same-shape unions distinct KEYS, so a selection cannot leak across them', () => {
    // Identity is the qualified path AND the branch digest. This asserts the digest half directly:
    // two unions whose declared branches differ must never share a selection key.
    const keys = unionSites([divergent], []).map((site) => site.key);
    expect(new Set(keys).size).toBe(keys.length);
    const inner = keys.filter((key) => key.includes('.inner'));
    expect(inner).toHaveLength(2);
  });
});

/**
 * A TUPLE POSITION IS ADDRESSABLE.
 *
 * The walk knew two ways down a sequence-shaped node: descend into what an array HOLDS (one declared
 * shape, so one node however many values), or stop. A tuple is neither — its positions are separate
 * declarations sharing a container — and with no step meaning "position 1", the walker did not
 * descend into tuple positions at all.
 *
 * `[number, A | B]` therefore declared ZERO union sites. Not an alternative built wrong, not a
 * branch scored wrong: a grammar the enumeration could not name, and so could not measure, while
 * reporting nothing missing. That is the exact shape of every defect this harness exists to catch,
 * sitting in the harness.
 *
 * No public declaration carries this shape today — checked against every `*.api.md`, which is why
 * closing it moves no verdict. It is fixed on the mechanism, and gated here, because "the surface
 * happens not to contain it" is a fact about today's surface, not a property of the walker.
 */
describe('a union inside a TUPLE POSITION is a site', () => {
  const positionUnion: SynthesisParameter = {
    name: 'pair',
    type: '[number, Fixed | Floating]',
    optional: false,
    // What `kindOfType` actually returns for a bare tuple — not `series`, which matches no test in it.
    kind: 'other',
    tuple: [
      { name: '0', type: 'number', kind: 'numeric', optional: false, nullable: false },
      {
        name: '1',
        type: 'Fixed | Floating',
        kind: 'object',
        optional: false,
        nullable: false,
        branches: [
          { type: '', kind: 'object', fields: [numeric('rate')] },
          { type: '', kind: 'object', fields: [numeric('spread')] },
        ],
      },
    ],
  };

  /**
   * THE SAME SHAPE ONE LEVEL DOWN, and it is not the same code path.
   *
   * The parameter-level fixture above is reached by the root descent; a tuple held by a FIELD is
   * reached by `visit`. Planting the defect proved the distinction is load-bearing rather than
   * pedantic: disabling `visit`'s tuple descent left every assertion above passing, because none of
   * them ever entered it. A gate that cannot fail for the reason it was written is not a gate, and
   * this file has now caught that in its own tests twice.
   */
  const nested: SynthesisParameter = {
    name: 'request',
    type: 'SwapRequest',
    optional: false,
    kind: 'object',
    fieldTree: [
      numeric('notional'),
      {
        name: 'pair',
        type: '[number, Fixed | Floating]',
        // Every one of the 63 tuple-bearing FIELD nodes in the committed inventory is `array`.
        kind: 'array',
        optional: false,
        nullable: false,
        tuple: [
          { name: '0', type: 'number', kind: 'numeric', optional: false, nullable: false },
          {
            name: '1',
            type: 'Fixed | Floating',
            kind: 'object',
            optional: false,
            nullable: false,
            branches: [
              { type: '', kind: 'object', fields: [numeric('rate')] },
              { type: '', kind: 'object', fields: [numeric('spread')] },
            ],
          },
        ],
      },
    ],
  };

  it('is DISCOVERED when the tuple is held by a FIELD, not just by the argument', () => {
    const sites = unionSites([nested], []).map((site) => site.path);
    expect(sites, 'a nested tuple position never appeared as a site').toContain('arg0.pair[1]');
  });

  it('builds the selected branch at a NESTED tuple position', () => {
    const { variants } = enumerateVariants([nested], []);
    const ids = variants.map((variant) => variant.id);
    expect(ids).toContain('arg0.pair[1]#0');
    expect(ids).toContain('arg0.pair[1]#1');
    const built = ['arg0.pair[1]#0', 'arg0.pair[1]#1'].map((id) => {
      const variant = variants.find((candidate) => candidate.id === id)!;
      const args = synthesizeArguments([nested], [], 0, undefined, variant.selection);
      return (args?.[0] as { pair: unknown[] } | undefined)?.pair;
    });
    for (const pair of built) {
      expect(Array.isArray(pair), 'the nested tuple must build as a tuple').toBe(true);
      expect(pair!.length).toBe(2);
    }
    expect(Object.keys(built[0]![1] as object)).toEqual(['rate']);
    expect(Object.keys(built[1]![1] as object)).toEqual(['spread']);
  });

  it('is DISCOVERED — the walk reaches position 1', () => {
    const sites = unionSites([positionUnion], []);
    expect(
      sites.map((site) => site.path),
      'the tuple position never appeared as a site',
    ).toContain('arg0[1]');
  });

  it('enumerates one alternative per branch, keyed to the POSITION', () => {
    const ids = enumerateVariants([positionUnion], []).variants.map((variant) => variant.id);
    // Both branches, and named for where they live — not merged onto the container.
    expect(ids).toContain('arg0[1]#0');
    expect(ids).toContain('arg0[1]#1');
  });

  it('BUILDS the selected branch at that position, leaving position 0 alone', () => {
    /**
     * Discovery without construction would be the worse outcome: sites that enumerate and never
     * build report `no-input` — measurement that looks like coverage. Both alternatives must produce
     * a real two-element tuple whose second element is the branch that was asked for.
     */
    const { variants } = enumerateVariants([positionUnion], []);
    const built = ['arg0[1]#0', 'arg0[1]#1'].map((id) => {
      const variant = variants.find((candidate) => candidate.id === id)!;
      return synthesizeArguments([positionUnion], [], 0, undefined, variant.selection)?.[0];
    });
    for (const value of built) {
      expect(Array.isArray(value), 'the tuple must still build as a tuple').toBe(true);
      expect((value as unknown[]).length).toBe(2);
      expect(typeof (value as unknown[])[0]).toBe('number');
    }
    // The two alternatives differ where they should: at position 1, and only there.
    expect(Object.keys((built[0] as unknown[])[1] as object)).toEqual(['rate']);
    expect(Object.keys((built[1] as unknown[])[1] as object)).toEqual(['spread']);
  });

  it('does not confuse a tuple position with an ARRAY ELEMENT', () => {
    /**
     * The distinction the new step exists for. A sequence's element union is ONE node — every value
     * shares the declared shape — so it keys to the container's own path. A tuple's does not. If
     * `position` were implemented as `element`, both would collapse onto `arg0` and one of the two
     * grammars would silently stand in for the other.
     */
    const elementUnion: SynthesisParameter = {
      name: 'legs',
      type: 'ReadonlyArray<Fixed | Floating>',
      optional: false,
      kind: 'series',
      elementFieldTree: [numeric('rate')],
    };
    // The tuple's union keys to its POSITION and never to the container...
    const tupleSites = unionSites([positionUnion], []).map((site) => site.path);
    expect(tupleSites).toContain('arg0[1]');
    expect(tupleSites).not.toContain('arg0');
    // ...while a sequence has no positions to key to, so nothing addresses one.
    expect(unionSites([elementUnion], []).map((site) => site.path)).not.toContain('arg0[0]');
  });
});
