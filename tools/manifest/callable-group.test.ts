/**
 * THE SEMANTIC CALLABLE GROUP, as a set of properties rather than an intention.
 *
 * A group is (resolved function object, complete contract fingerprint, invocation mode). It is
 * measured ONCE and its evidence attributed to every equivalent public path. That ruling was
 * implemented in parts, and the parts that were missing were invisible from the outside — a group
 * with two fixtures kept one and silently discarded the other; the field index was excluded from the
 * group key and then never pooled, so a group could be measured through the poorest member's index;
 * receiver methods were left out of the pre-pass entirely because `resolveCallable` cannot reach a
 * prototype method from a module.
 *
 * These bind the parts. `planVariants` and `poolFieldIndex` are the two decisions worth testing
 * directly — everything else is observable in the committed artifact.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConflictingFixturesError,
  declareFixtureEquivalence,
  planVariants,
  poolFieldIndex,
  type ContractRecord,
} from './contract-enforcement.js';
import type { SynthesisParameter } from './contract-synthesis.js';

const tag = (name: string, literals: string[]) => ({
  name,
  type: literals.map((literal) => `'${literal}'`).join(' | '),
  kind: 'enum',
  optional: false,
  nullable: false,
  literals,
});

const numeric = (name: string) => ({
  name,
  type: 'number',
  kind: 'numeric',
  optional: false,
  nullable: false,
});

/** A two-alternative discriminated union, so a fixture can select one and leave the other. */
const UNION: SynthesisParameter = {
  name: 'config',
  type: 'Alpha | Beta',
  optional: false,
  kind: 'object',
  branches: [
    { type: '', kind: 'object', fields: [tag('kind', ['alpha']), numeric('a')] },
    { type: '', kind: 'object', fields: [tag('kind', ['beta']), numeric('b')] },
  ],
};

/** A contract synthesis cannot build: an opaque required parameter with no shape and no producer. */
const UNBUILDABLE: SynthesisParameter = {
  name: 'handle',
  type: 'OpaqueHandle',
  optional: false,
  kind: 'object',
};

const plan = (hand: { call: () => unknown[]; source: string }[], parameters = [UNION]) =>
  planVariants({ parameters, fields: [], producers: undefined, declaredCoordinates: [], hand });

describe('every fixture in a group is kept, not just the first', () => {
  it('retains two fixtures that select DIFFERENT alternatives, each naming its source', () => {
    /**
     * The defect: the pool broke on the first member that had a fixture, so a group whose second
     * name carried a fixture for the OTHER branch lost it — and that branch fell back to synthesis
     * or to nothing, while the artifact reported the group as fixtured.
     */
    const result = plan([
      { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:alpha' },
      { call: () => [{ kind: 'beta', b: 2 }], source: 'pkg:beta' },
    ]);
    const handed = result.variants.filter((variant) => variant.hand);
    expect(handed).toHaveLength(2);
    expect(handed.map((variant) => `${variant.id}<-${variant.fixtureSource}`).sort()).toEqual([
      'arg0:kind=alpha<-pkg:alpha',
      'arg0:kind=beta<-pkg:beta',
    ]);
  });

  it('serves each hand alternative the call its OWN source wrote', () => {
    // Provenance that does not reach the input is decoration. Each hand variant must build from the
    // fixture it names, or two alternatives are measured with one call under two labels.
    const result = plan([
      { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:alpha' },
      { call: () => [{ kind: 'beta', b: 2 }], source: 'pkg:beta' },
    ]);
    for (const variant of result.variants.filter((entry) => entry.hand)) {
      const built = result.fixtureFor(0, variant)!.call()[0] as { kind: string };
      expect(built.kind, `${variant.id} was served another fixture's call`).toBe(
        variant.fixtureSource === 'pkg:alpha' ? 'alpha' : 'beta',
      );
    }
  });

  it('is invariant to the ORDER the fixtures arrive in', () => {
    // Which member sorted first decided which fixture survived. The plan must be a property of the
    // SET — the same two fixtures in either order describe the same measurement.
    const fixtures = [
      { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:alpha' },
      { call: () => [{ kind: 'beta', b: 2 }], source: 'pkg:beta' },
    ];
    const forward = plan(fixtures);
    const reversed = plan([...fixtures].reverse());
    const shape = (result: ReturnType<typeof plan>) =>
      result.variants
        .map((variant) => `${variant.id}|${variant.hand}|${variant.fixtureSource ?? '-'}`)
        .sort();
    expect(shape(reversed)).toEqual(shape(forward));
  });

  it('does NOT let a hand fixture suppress the alternatives it did not select', () => {
    // One fixture covers one branch. The rest of the union is still declared, and still has to be
    // measured from synthesis — otherwise the boundaries with the most interesting unions are
    // exactly the ones measured on a single branch.
    const result = plan([{ call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:alpha' }]);
    expect(result.variants.map((variant) => variant.id).sort()).toEqual([
      'arg0:kind=alpha',
      'arg0:kind=beta',
    ]);
    expect(result.variants.find((variant) => variant.id === 'arg0:kind=beta')?.hand).toBe(false);
  });
});

describe('two fixtures that disagree about one alternative stop generation', () => {
  it('throws, naming both paths', () => {
    /**
     * There is no honest resolution. Both are deliberately-authored claims about the same alternative
     * of the same callable, and picking by id order publishes one author's call under a verdict the
     * other's would not have produced.
     */
    expect(() =>
      plan([
        { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:one' },
        { call: () => [{ kind: 'alpha', a: 999 }], source: 'pkg:two' },
      ]),
    ).toThrow(ConflictingFixturesError);
    try {
      plan([
        { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:one' },
        { call: () => [{ kind: 'alpha', a: 999 }], source: 'pkg:two' },
      ]);
    } catch (error) {
      expect((error as Error).message).toContain('pkg:one');
      expect((error as Error).message).toContain('pkg:two');
    }
  });

  it('accepts the SAME claim written twice under two names', () => {
    // Two names for one function often carry the same fixture. That is agreement, not conflict, and
    // failing on it would make pooling unusable.
    const result = plan([
      { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:one' },
      { call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:two' },
    ]);
    expect(result.variants.filter((variant) => variant.hand)).toHaveLength(1);
  });

  it('compares calls STRUCTURALLY, so unserializable arguments are still compared', () => {
    // `JSON.stringify` drops functions and throws on cycles, so a serialize-and-compare rule would
    // read two different callback fixtures as identical and let a real conflict through.
    expect(() =>
      plan(
        [
          { call: () => [() => 1], source: 'pkg:one' },
          { call: () => [(_a: number, _b: number) => 2], source: 'pkg:two' },
        ],
        [{ name: 'fn', type: '(x: number) => number', optional: false, kind: 'function' }],
      ),
    ).toThrow(ConflictingFixturesError);
  });
});

describe('a hand fixture survives a contract synthesis cannot build', () => {
  it('plans a measurable alternative where synthesis has nothing', () => {
    /**
     * The regression this replaced cost 89 boundaries their measurement in one run. Every one held a
     * working hand fixture and was reported `no-input` — because the pre-flight check asked whether
     * a SYNTHESIZED variant could be built for a boundary that is fixtured precisely because
     * synthesis cannot build one.
     */
    const result = plan([{ call: () => [{ opaque: true }], source: 'pkg:only' }], [UNBUILDABLE]);
    expect(result.variants.some((variant) => result.fixtureFor(0, variant) !== null)).toBe(true);
    expect(result.synthesized).toBe(false);
  });

  it('reports `synthesized` only when the input actually came from the declaration', () => {
    expect(plan([], [UNION]).synthesized).toBe(true);
    expect(plan([{ call: () => [{ kind: 'alpha', a: 1 }], source: 'pkg:a' }]).synthesized).toBe(
      false,
    );
    // Nothing to measure at all: no fixture and nothing buildable.
    expect(plan([], [UNBUILDABLE]).synthesized).toBe(false);
  });
});

describe('the field index is pooled per OWNER TYPE', () => {
  const member = (id: string, fields: string[]): ContractRecord =>
    ({ id, fields }) as unknown as ContractRecord;

  it('keeps the richest set for each owner, not the richest member overall', () => {
    /**
     * The rule that fails: "whichever member holds the most paths wins entire". A member can hold
     * more paths in total while holding NONE for the owner a given parameter needs, and an owner with
     * no entries synthesizes to nothing — which is how the first attempt cost 89 measurements.
     */
    const pooled = poolFieldIndex([
      member('pkg:big', ['Other.a', 'Other.b', 'Other.c', 'Wanted.x']),
      member('pkg:small', ['Wanted.x', 'Wanted.y']),
    ]);
    expect(pooled).toEqual(['Other.a', 'Other.b', 'Other.c', 'Wanted.x', 'Wanted.y']);
  });

  it('never invents a key set by merging two members of the same owner', () => {
    // Within one owner the largest set wins ENTIRE. Merging could compose a shape no declaration has,
    // and a call no caller could make is the one thing this harness must not measure.
    const pooled = poolFieldIndex([
      member('pkg:one', ['Same.a', 'Same.b']),
      member('pkg:two', ['Same.c']),
    ]);
    expect(pooled).toEqual(['Same.a', 'Same.b']);
  });

  it('is order-invariant and drops entries that name no owner', () => {
    const forward = poolFieldIndex([
      member('pkg:a', ['A.x', 'bare']),
      member('pkg:b', ['A.x', 'A.y']),
    ]);
    const reversed = poolFieldIndex([
      member('pkg:b', ['A.x', 'A.y']),
      member('pkg:a', ['A.x', 'bare']),
    ]);
    expect(forward).toEqual(['A.x', 'A.y']);
    expect(reversed).toEqual(forward);
  });
});

describe('the committed artifact shows the ruling in force', () => {
  const artifact = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-enforcement.json', import.meta.url)), 'utf8'),
  ) as {
    summary: { receiverGroupingGaps: number };
    enforcement: {
      id: string;
      verdict: string;
      fixtureSource?: string;
      measurementSource?: string;
      mutationsExecuted?: Record<string, number>;
      alternatives?: { id: string; fixtureSource?: string }[];
    }[];
  };
  const rows = artifact.enforcement;

  it('records fixture provenance even when the measuring path owns the fixture', () => {
    /**
     * `fixtureSource` used to be suppressed whenever it equalled the record's own id, so "this
     * evidence came from a hand fixture" was recorded only for borrowers. A reader could not tell a
     * self-fixtured measurement from a synthesized one without cross-referencing another artifact.
     */
    const own = rows.filter((row) => row.fixtureSource === row.id);
    expect(own.length, 'self-owned fixture provenance is still suppressed').toBeGreaterThan(0);
    const borrowed = rows.filter((row) => row.fixtureSource && row.fixtureSource !== row.id);
    expect(
      borrowed.length,
      'no record borrows a fixture — pooling is not reaching measurement',
    ).toBeGreaterThan(0);
  });

  it('names a fixture source on the ALTERNATIVE, not only on the row', () => {
    // A row-level source names one fixture and quietly stands for all of them. Where a boundary
    // publishes alternatives, each hand alternative says whose call produced it.
    const perAlternative = rows
      .flatMap((row) => row.alternatives ?? [])
      .filter((a) => a.fixtureSource);
    expect(perAlternative.length, 'alternatives carry no fixture provenance').toBeGreaterThan(0);
    const known = new Set(rows.map((row) => row.id));
    for (const alternative of perAlternative) {
      expect(
        known.has(alternative.fixtureSource!),
        `${alternative.id} names a missing source`,
      ).toBe(true);
    }
  });

  it('publishes how much of the receiver surface grouping cannot reach', () => {
    /**
     * Grouping reads the owner's PROTOTYPE, which covers every exported class and constructs nothing.
     * An owner obtainable only from a factory (`Bond`, `YieldCurve`) has no prototype on any module
     * export, so those members stay ungrouped — and the count is published rather than left as an
     * unstated limit, which is the failure mode this whole phase keeps finding.
     */
    const receivers = rows.filter((row) => row.id.includes('#'));
    expect(receivers.length, 'the receiver surface vanished').toBeGreaterThan(0);
    expect(typeof artifact.summary.receiverGroupingGaps).toBe('number');
    expect(artifact.summary.receiverGroupingGaps).toBeLessThan(receivers.length);
  });

  it('never lets an attributed record claim a physical execution', () => {
    // The accounting rule, restated at the group level: evidence travels, work does not.
    const offenders = rows
      .filter((row) => row.measurementSource && row.mutationsExecuted)
      .map((row) => row.id);
    expect(offenders).toEqual([]);
  });
});

describe('the conflict rule fails CLOSED on anything it cannot prove equal', () => {
  const callbackParam: SynthesisParameter[] = [
    { name: 'fn', type: '(x: number) => number', optional: false, kind: 'function' },
  ];
  const planWith = (
    hand: { call: () => unknown[]; source: string }[],
    parameters = callbackParam,
  ) =>
    planVariants({ parameters, fields: [], producers: undefined, declaredCoordinates: [], hand });

  it('raises a conflict for two functions with different BODIES', () => {
    /**
     * Described by ARITY alone, `() => 1` and `() => 2` compared identical: no conflict was raised
     * and the second fixture was silently discarded. A comparison that cannot tell two claims apart
     * must not call them the same claim — that is the whole content of the rule.
     */
    expect(() =>
      planWith([
        { call: () => [() => 1], source: 'pkg:one' },
        { call: () => [() => 2], source: 'pkg:two' },
      ]),
    ).toThrow(ConflictingFixturesError);
  });

  it('refuses two functions written identically — source text is not behaviour', () => {
    /**
     * This test asserted the OPPOSITE one round ago, and the assertion was the defect.
     *
     *     const make = (n: number) => () => n;
     *     make(1);  // same source text
     *     make(2);  // different behaviour
     *
     * A closure renders identically to its sibling and does something else. Source text describes a
     * function's SHAPE and never its behaviour, so it cannot prove two fixtures make the same claim
     * — and a comparison that cannot prove equality must not assert it.
     */
    const make = (n: number) => () => n;
    expect(() =>
      planWith([
        { call: () => [make(1)], source: 'pkg:one' },
        { call: () => [make(2)], source: 'pkg:two' },
      ]),
    ).toThrow(ConflictingFixturesError);
    // Identical SOURCE is refused for the same reason: it is the same evidence, which is none.
    expect(() =>
      planWith([
        { call: () => [(x: number) => x * 2], source: 'pkg:one' },
        { call: () => [(x: number) => x * 2], source: 'pkg:two' },
      ]),
    ).toThrow(ConflictingFixturesError);
  });

  it('accepts the SAME function object, and an explicitly declared equivalence', () => {
    // Object identity proves it. So does a person saying so — and that claim is registered where it
    // can be found and argued with, rather than inferred from a rendering.
    const shared = (x: number) => x * 2;
    expect(() =>
      planWith([
        { call: () => [shared], source: 'pkg:one' },
        { call: () => [shared], source: 'pkg:two' },
      ]),
    ).not.toThrow();

    const first = declareFixtureEquivalence((x: number) => x * 2, 'double');
    const second = declareFixtureEquivalence((x: number) => x * 2, 'double');
    expect(() =>
      planWith([
        { call: () => [first], source: 'pkg:one' },
        { call: () => [second], source: 'pkg:two' },
      ]),
    ).not.toThrow();
  });

  it('treats a class instance as opaque even when it exposes an enumerable key', () => {
    // Two instances agreeing on `tag` agree on nothing that decides what they DO: private state is
    // invisible here, so "same visible key" is not "same claim".
    class Tagged {
      readonly tag = 'same';
      #hidden: number;
      constructor(hidden: number) {
        this.#hidden = hidden;
      }
      value(): number {
        return this.#hidden;
      }
    }
    expect(() =>
      planWith(
        [
          { call: () => [new Tagged(1)], source: 'pkg:one' },
          { call: () => [new Tagged(2)], source: 'pkg:two' },
        ],
        [{ name: 'receiver', type: 'Tagged', optional: false, kind: 'object' }],
      ),
    ).toThrow(ConflictingFixturesError);
  });

  it('does not confuse a primitive with its string spelling, or two typed arrays', () => {
    expect(() =>
      planWith(
        [
          { call: () => [1], source: 'pkg:one' },
          { call: () => ['1'], source: 'pkg:two' },
        ],
        [{ name: 'x', type: 'number | string', optional: false, kind: 'numeric' }],
      ),
    ).toThrow(ConflictingFixturesError);
    expect(() =>
      planWith(
        [
          { call: () => [new Float64Array([1, 2])], source: 'pkg:one' },
          { call: () => [new Int32Array([1, 2])], source: 'pkg:two' },
        ],
        [{ name: 'series', type: 'Float64Array | Int32Array', optional: false, kind: 'series' }],
      ),
    ).toThrow(ConflictingFixturesError);
  });

  it('does not stop comparing after the first eight array elements', () => {
    // Truncation turns "the first eight agree" into "the calls agree". Two fixtures differing only
    // at index nine are a conflict, and the rule has to raise it.
    const long = (last: number) => () => [[1, 2, 3, 4, 5, 6, 7, 8, last]];
    expect(() =>
      planWith(
        [
          { call: long(9), source: 'pkg:one' },
          { call: long(10), source: 'pkg:two' },
        ],
        [{ name: 'series', type: 'number[]', optional: false, kind: 'series' }],
      ),
    ).toThrow(ConflictingFixturesError);
  });

  it('refuses to call two OPAQUE receivers equal', () => {
    /**
     * A class instance with no enumerable state is a black box. Nothing here can prove two of them
     * make the same claim, so the honest outcome is a conflict a person resolves — not a quiet
     * decision by whichever id sorted first.
     */
    class Opaque {
      readonly #state = Math.trunc(1);
      value(): number {
        return this.#state;
      }
    }
    expect(() =>
      planWith(
        [
          { call: () => [new Opaque()], source: 'pkg:one' },
          { call: () => [new Opaque()], source: 'pkg:two' },
        ],
        [{ name: 'receiver', type: 'Opaque', optional: false, kind: 'object' }],
      ),
    ).toThrow(ConflictingFixturesError);
  });
});

describe('structural comparison covers ORDINARY DATA only', () => {
  const one = (value: unknown, source: string) => ({ call: () => [value], source });
  const twoFixtures = (a: unknown, b: unknown, kind = 'object') =>
    planVariants({
      parameters: [{ name: 'x', type: 'X', optional: false, kind }],
      fields: [],
      producers: undefined,
      declaredCoordinates: [],
      hand: [one(a, 'pkg:one'), one(b, 'pkg:two')],
    });

  it('separates a sparse array from a dense one of the same length', () => {
    // `[, ,]` and `[undefined, undefined]` describe as two `undefined`s and answer `in` differently.
    // Built with `length` rather than written literally: a sparse literal is (rightly) a lint error,
    // and the case still has to be covered because the COMPARATOR must not merge the two.
    const sparse: unknown[] = [];
    sparse.length = 2;
    expect(() => twoFixtures(sparse, [undefined, undefined], 'series')).toThrow(
      ConflictingFixturesError,
    );
  });

  it('separates two symbols that describe themselves identically', () => {
    expect(() => twoFixtures(Symbol('same'), Symbol('same'))).toThrow(ConflictingFixturesError);
  });

  it('separates -0 from 0', () => {
    expect(() => twoFixtures(-0, 0, 'numeric')).toThrow(ConflictingFixturesError);
  });

  it('separates a null-prototype object from an ordinary one with the same keys', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(() => twoFixtures(bare, { a: 1 })).toThrow(ConflictingFixturesError);
  });

  it('separates objects that differ only in NON-ENUMERABLE state', () => {
    /**
     * `Object.keys` cannot see it, so an object carrying non-enumerable state is not ordinary data
     * and its visible shape proves nothing. Same rule for accessors: a getter's value is computed,
     * and one reading says nothing about the next.
     */
    const hidden = (secret: number): Record<string, unknown> => {
      const held = { a: 1 } as Record<string, unknown>;
      Object.defineProperty(held, 'secret', { value: secret, enumerable: false });
      return held;
    };
    expect(() => twoFixtures(hidden(1), hidden(2))).toThrow(ConflictingFixturesError);
  });

  it('still merges two genuinely ordinary records that agree', () => {
    // The subset has to be usable, or pooling stops working and every group becomes a conflict.
    expect(() => twoFixtures({ a: 1, b: 'x' }, { b: 'x', a: 1 })).not.toThrow();
  });
});

describe('the comparator closes the remaining collapse paths', () => {
  const two = (a: unknown, b: unknown, kind = 'object') =>
    planVariants({
      parameters: [{ name: 'x', type: 'X', optional: false, kind }],
      fields: [],
      producers: undefined,
      declaredCoordinates: [],
      hand: [
        { call: () => [a], source: 'pkg:one' },
        { call: () => [b], source: 'pkg:two' },
      ],
    });

  it('separates a writable property from a read-only one', () => {
    // Writability is part of the value: the probes WRITE, and a frozen argument answers differently.
    const frozen = Object.freeze({ a: 1 });
    expect(() => two({ a: 1 }, frozen)).toThrow(ConflictingFixturesError);
  });

  it('separates an array carrying extra own state from a plain one', () => {
    // `Object.assign([1, 2], { tag: 'x' })` indexes like a plain pair and carries a key the element
    // walk cannot see.
    const tagged = Object.assign([1, 2], { tag: 'x' });
    expect(() => two(tagged, [1, 2], 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates a typed-array VIEW from standalone contents that match', () => {
    /**
     * A view onto the middle of a shared buffer holds the same numbers and is not the same argument:
     * writing through it is visible to everything else sharing that buffer.
     */
    const buffer = new Float64Array([9, 1, 2, 9]).buffer;
    const view = new Float64Array(buffer, 8, 2);
    expect(() => two(view, new Float64Array([1, 2]), 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates a SHARED reference graph from duplicated equal objects', () => {
    /**
     * `{ a: shared, b: shared }` and `{ a: {…}, b: {…} }` describe identically once each subtree is
     * walked on its own, and a probe that mutates `a` changes `b` in exactly one of them.
     */
    const shared = { n: 1 };
    expect(() => two({ a: shared, b: shared }, { a: { n: 1 }, b: { n: 1 } })).toThrow(
      ConflictingFixturesError,
    );
  });

  it('still merges two ordinary records that genuinely agree', () => {
    // Every rule above has to leave the usable case usable, or pooling stops working entirely.
    expect(() => two({ a: 1, b: 'x' }, { b: 'x', a: 1 })).not.toThrow();
  });
});

describe('the ordinary-data whitelist is COMPLETE, not a list of fixed reproductions', () => {
  const two = (a: unknown, b: unknown, kind = 'object') =>
    planVariants({
      parameters: [{ name: 'x', type: 'X', optional: false, kind }],
      fields: [],
      producers: undefined,
      declaredCoordinates: [],
      hand: [
        { call: () => [a], source: 'pkg:one' },
        { call: () => [b], source: 'pkg:two' },
      ],
    });

  it('separates a writable array index from a read-only one', () => {
    const frozenIndex = [1, 2];
    Object.defineProperty(frozenIndex, '0', { value: 1, writable: false });
    expect(() => two(frozenIndex, [1, 2], 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates an extensible object from a non-extensible one', () => {
    // The unknown-key probe ADDS a key. A sealed argument answers it differently by construction.
    expect(() => two({ a: 1 }, Object.preventExtensions({ a: 1 }))).toThrow(
      ConflictingFixturesError,
    );
  });

  it('separates a plain array from an array SUBCLASS', () => {
    class Rows extends Array<number> {}
    const subclass = Rows.from([1, 2]);
    expect(() => two(subclass, [1, 2], 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates a typed array from one carrying extra own state', () => {
    const tagged = new Float64Array([1, 2]) as Float64Array & { tag?: string };
    tagged.tag = 'x';
    expect(() => two(tagged, new Float64Array([1, 2]), 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates two views SHARING a buffer from two independent buffers', () => {
    /**
     * The decisive case for backing-buffer topology: identical contents, identical offsets, and a
     * probe writing through one is visible through the other in exactly one of the two calls.
     */
    const shared = new ArrayBuffer(16);
    const viewA = new Float64Array(shared, 0, 1);
    const viewB = new Float64Array(shared, 8, 1);
    const independentA = new Float64Array(1);
    const independentB = new Float64Array(1);
    expect(() =>
      planVariants({
        parameters: [{ name: 'pair', type: 'P', optional: false, kind: 'object' }],
        fields: [],
        producers: undefined,
        declaredCoordinates: [],
        hand: [
          { call: () => [{ a: viewA, b: viewB }], source: 'pkg:one' },
          { call: () => [{ a: independentA, b: independentB }], source: 'pkg:two' },
        ],
      }),
    ).toThrow(ConflictingFixturesError);
  });

  it('still merges genuinely ordinary data — the whitelist has to stay usable', () => {
    expect(() => two({ a: 1, b: 'x' }, { b: 'x', a: 1 })).not.toThrow();
    expect(() => two([1, 2, 3], [1, 2, 3], 'series')).not.toThrow();
  });
});

describe('the whitelist holds against a fresh adversarial pass', () => {
  const two = (a: unknown, b: unknown, kind = 'object') =>
    planVariants({
      parameters: [{ name: 'x', type: 'X', optional: false, kind }],
      fields: [],
      producers: undefined,
      declaredCoordinates: [],
      hand: [
        { call: () => [a], source: 'pkg:one' },
        { call: () => [b], source: 'pkg:two' },
      ],
    });

  it('separates a writable array `length` from a non-writable one', () => {
    // `length` decides what the element walk looks at; freezing it changes the array's behaviour.
    const frozenLength: unknown[] = [1, 2];
    Object.defineProperty(frozenLength, 'length', { value: 2, writable: false });
    expect(() => two(frozenLength, [1, 2], 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates an empty array from one carrying an own "01" pseudo-index', () => {
    /**
     * `"01"` matches `/^\d+$/` and is NOT a canonical array index: `length` does not count it and
     * the element walk never visits it, so both described as `[]`.
     */
    const pseudo: unknown[] = [];
    Object.defineProperty(pseudo, '01', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(() => two(pseudo, [], 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates an extensible typed-array view from a non-extensible one', () => {
    const sealed = new Float64Array([1, 2]);
    Object.preventExtensions(sealed);
    expect(() => two(sealed, new Float64Array([1, 2]), 'series')).toThrow(ConflictingFixturesError);
  });

  it('separates a stock typed array from one with an altered prototype', () => {
    const altered = new Float64Array([1, 2]);
    Object.setPrototypeOf(altered, Object.create(Float64Array.prototype));
    expect(() => two(altered, new Float64Array([1, 2]), 'series')).toThrow(
      ConflictingFixturesError,
    );
  });

  it('separates a typed array from one carrying an own "01" property', () => {
    const tagged = new Float64Array([1, 2]);
    Object.defineProperty(tagged, '01', {
      value: 9,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(() => two(tagged, new Float64Array([1, 2]), 'series')).toThrow(ConflictingFixturesError);
  });

  it('does NOT invent a conflict for a registered or well-known symbol', () => {
    /**
     * `Symbol.for('x')` is canonical — the same symbol everywhere — and cannot be a `WeakMap` key, so
     * routing it through the identity map threw and surfaced as a false conflict. Two fixtures naming
     * the same registered symbol are making the same claim.
     */
    expect(() => two(Symbol.for('shared'), Symbol.for('shared'))).not.toThrow();
    expect(() => two(Symbol.iterator, Symbol.iterator)).not.toThrow();
    // Two DIFFERENT canonical symbols are still two different arguments.
    expect(() => two(Symbol.for('a'), Symbol.for('b'))).toThrow(ConflictingFixturesError);
  });
});
