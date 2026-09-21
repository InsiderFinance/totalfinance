/**
 * A UNION SITE'S IDENTITY MUST MOVE WHEN THE UNION MOVES.
 *
 * Every variant is filed under `<qualified path>~<digest>#<branch>`, and the digest is what makes an
 * id a claim about a DECLARATION rather than about a position. If two materially different unions can
 * share one digest, then a selection recorded against one applies silently to the other: the harness
 * would report measuring `#1` of a contract it never saw.
 *
 * An earlier version of this file varied arm metadata AND rendered type text together, concluded the
 * identity moved, and reported that widening the digest was unnecessary. That was a test proving the
 * wrong thing: the text alone was carrying the identity, so the metadata could have been ignored
 * entirely and every case would still have passed.
 *
 * The fixtures below now hold rendered text CONSTANT and vary only what the text cannot show — an
 * alias-resolved element type, a callback's resolved arity, a nested arm, a tuple's positions. Those
 * are exactly the differences an alias hides, and they are the ones a site key must still separate,
 * because the key decides which selection applies to which declaration and which paths pool their
 * evidence.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineGap, unionSites, type SynthesisParameter } from './contract-synthesis.js';

const numeric = (name: string) => ({
  name,
  type: 'number',
  kind: 'numeric',
  optional: false,
  nullable: false,
});

/**
 * The ROOT site's key — `arg0~<digest>`.
 *
 * Not "the only site": a union nested inside the arm this parameter selects is discovered as its own
 * site now, so a fixture can legitimately declare more than one. Keying on the root is what these
 * comparisons are about; the nested discovery is asserted directly below.
 */
const keyOf = (parameter: SynthesisParameter): string => {
  const sites = unionSites([parameter], []);
  const root = sites.find((site) => site.valuePath === 'arg0');
  expect(root, 'the fixture declares no union at its root').toBeDefined();
  return root!.key;
};

const twoArms = (name: string, armA: object, armB: object): SynthesisParameter =>
  ({
    name: 'input',
    type: name,
    optional: false,
    kind: 'other',
    branches: [armA, armB],
  }) as SynthesisParameter;

describe('two different unions never share a site identity', () => {
  it('separates arms that differ in ELEMENT contract', () => {
    const a = twoArms(
      'number | ReadonlyArray<number>',
      { type: 'number', kind: 'numeric' },
      {
        type: 'ReadonlyArray<number>',
        kind: 'array',
        element: numeric('[]'),
      },
    );
    const b = twoArms(
      'number | ReadonlyArray<string>',
      { type: 'number', kind: 'numeric' },
      {
        type: 'ReadonlyArray<string>',
        kind: 'array',
        element: { name: '[]', type: 'string', kind: 'string', optional: false, nullable: false },
      },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('separates arms that differ in TUPLE arity', () => {
    const a = twoArms(
      '[number] | [number, number]',
      {
        type: '[number]',
        kind: 'array',
        tuple: [numeric('0')],
      },
      { type: '[number, number]', kind: 'array', tuple: [numeric('0'), numeric('1')] },
    );
    const b = twoArms(
      '[number] | [number, number, number]',
      {
        type: '[number]',
        kind: 'array',
        tuple: [numeric('0')],
      },
      {
        type: '[number, number, number]',
        kind: 'array',
        tuple: [numeric('0'), numeric('1'), numeric('2')],
      },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('separates arms that differ in their LITERAL set', () => {
    const a = twoArms(
      "'bid' | 'ask'",
      { type: "'bid'", kind: 'enum', literals: ['bid'] },
      {
        type: "'ask'",
        kind: 'enum',
        literals: ['ask'],
      },
    );
    const b = twoArms(
      "'bid' | 'mid'",
      { type: "'bid'", kind: 'enum', literals: ['bid'] },
      {
        type: "'mid'",
        kind: 'enum',
        literals: ['mid'],
      },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('separates arms that differ in CALL SIGNATURE', () => {
    const a = twoArms(
      'number | ((x: number) => number)',
      { type: 'number', kind: 'numeric' },
      {
        type: '(x: number) => number',
        kind: 'function',
        callSignature: { parameters: 1, returns: 'number' },
      },
    );
    const b = twoArms(
      'number | ((x: number, y: number) => number)',
      {
        type: 'number',
        kind: 'numeric',
      },
      {
        type: '(x: number, y: number) => number',
        kind: 'function',
        callSignature: { parameters: 2, returns: 'number' },
      },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('separates arms that differ in FIELD requiredness, not only in field names', () => {
    // The one case where the rendered text carries the difference in punctuation alone.
    const a = twoArms(
      '{ a: number } | { b: number }',
      {
        type: '{ a: number }',
        kind: 'object',
        fields: [numeric('a')],
      },
      { type: '{ b: number }', kind: 'object', fields: [numeric('b')] },
    );
    const b = twoArms(
      '{ a?: number } | { b: number }',
      {
        type: '{ a?: number }',
        kind: 'object',
        fields: [{ ...numeric('a'), optional: true }],
      },
      { type: '{ b: number }', kind: 'object', fields: [numeric('b')] },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('gives the SAME identity to the same union declared twice — it is not a nonce', () => {
    /**
     * The other half, and the one that makes the tests above mean something. A digest that mixed in
     * anything per-run would separate every pair trivially and separate a union from itself, which
     * would break resumption and make artifact diffs meaningless.
     */
    const shape = () =>
      twoArms(
        '{ a: number } | { b: number }',
        {
          type: '{ a: number }',
          kind: 'object',
          fields: [numeric('a')],
        },
        { type: '{ b: number }', kind: 'object', fields: [numeric('b')] },
      );
    expect(keyOf(shape())).toBe(keyOf(shape()));
  });

  it('is ORDER-SENSITIVE, because `branch: n` names a position', () => {
    // `A | B` and `B | A` select differently under the same id, so they are not one site.
    const a = twoArms(
      'A | B',
      { type: 'A', kind: 'object', fields: [numeric('a')] },
      {
        type: 'B',
        kind: 'object',
        fields: [numeric('b')],
      },
    );
    const b = twoArms(
      'B | A',
      { type: 'B', kind: 'object', fields: [numeric('b')] },
      {
        type: 'A',
        kind: 'object',
        fields: [numeric('a')],
      },
    );
    expect(keyOf(a)).not.toBe(keyOf(b));
  });
});

/**
 * AN ARM'S CONTENTS ARE PART OF THE CONTRACT IT DESCRIBES.
 *
 * Validation used to rebuild each arm as `name + type + fields` before checking a value against it.
 * That is a faithful description of an arm that happens to be a plain object, and a lossy one for
 * every other kind of arm: an array arm's element contract, a tuple arm's positions, a callback
 * arm's signature and return, and any arm that is itself a union all disappeared in the rebuild.
 *
 * The consequence is not a missed alternative — it is a validator that says yes to a call the
 * declaration forbids, which is the one failure mode a baseline validator cannot have.
 */
describe('a union arm is validated by everything it declares', () => {
  const literalElement = (values: string[]) => ({
    name: '[]',
    type: values.map((value) => `'${value}'`).join(' | '),
    kind: 'enum',
    optional: false,
    nullable: false,
    literals: values,
  });

  const scalarOrLiteralArray: SynthesisParameter = {
    name: 'side',
    type: "number | ReadonlyArray<'left' | 'right'>",
    optional: false,
    kind: 'other',
    branches: [
      { type: 'number', kind: 'numeric' },
      {
        type: "ReadonlyArray<'left' | 'right'>",
        kind: 'array',
        element: literalElement(['left', 'right']),
      },
    ],
  };

  it('accepts a value the array arm genuinely admits', () => {
    expect(baselineGap([scalarOrLiteralArray], [['left']])).toBeNull();
    expect(baselineGap([scalarOrLiteralArray], [['right', 'left']])).toBeNull();
  });

  it('accepts the scalar arm', () => {
    expect(baselineGap([scalarOrLiteralArray], [42])).toBeNull();
  });

  it('REJECTS an element outside the arm element’s literal domain', () => {
    // The reviewer's reproduction. `['bogus']` satisfies neither arm: it is not a number, and the
    // array arm admits exactly two strings. The rebuild dropped `element`, so nothing looked.
    expect(baselineGap([scalarOrLiteralArray], [['bogus']])?.category).toBe('no-branch');
  });

  it('REJECTS a wrong-typed element too', () => {
    expect(baselineGap([scalarOrLiteralArray], [[7]])?.category).toBe('no-branch');
  });

  it('checks a TUPLE arm by its positions, not merely by being an array', () => {
    const tupleOrScalar: SynthesisParameter = {
      name: 'point',
      type: "number | ['x' | 'y', number]",
      optional: false,
      kind: 'other',
      branches: [
        { type: 'number', kind: 'numeric' },
        {
          type: "['x' | 'y', number]",
          kind: 'array',
          tuple: [
            { ...literalElement(['x', 'y']), name: '0' },
            { name: '1', type: 'number', kind: 'numeric', optional: false, nullable: false },
          ],
        },
      ],
    };
    expect(baselineGap([tupleOrScalar], [['x', 1]])).toBeNull();
    expect(baselineGap([tupleOrScalar], [['z', 1]])?.category).toBe('no-branch');
    expect(baselineGap([tupleOrScalar], [['x', 'no']])?.category).toBe('no-branch');
  });

  it('descends a union NESTED INSIDE an arm', () => {
    /**
     * The recursion the rebuild made impossible by accident: an arm carried no arms of its own, so
     * "no recursion risk" was true and the contract one level down was unreachable.
     */
    const nestedArm: SynthesisParameter = {
      name: 'operand',
      type: 'number | { value: string | { code: string } }',
      optional: false,
      kind: 'other',
      branches: [
        { type: 'number', kind: 'numeric' },
        {
          type: '{ value: string | { code: string } }',
          kind: 'object',
          fields: [
            {
              name: 'value',
              type: 'string | { code: string }',
              kind: 'object',
              optional: false,
              nullable: false,
              branches: [
                { type: 'string', kind: 'string' },
                {
                  type: '{ code: string }',
                  kind: 'object',
                  fields: [
                    {
                      name: 'code',
                      type: 'string',
                      kind: 'string',
                      optional: false,
                      nullable: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(baselineGap([nestedArm], [{ value: 'x' }])).toBeNull();
    expect(baselineGap([nestedArm], [{ value: { code: 'x' } }])).toBeNull();
    expect(baselineGap([nestedArm], [{ value: { wrong: 'x' } }])?.category).toBe('no-branch');
  });
});

/**
 * IDENTITY AT CONSTANT RENDERED TEXT.
 *
 * Every fixture pair here prints identically. An alias is exactly this situation — `Operand`,
 * `PriceSource` and `FromChainOptions` all render as a name while resolving to different shapes — so
 * a digest that reads the printed type is blind precisely where the library uses aliases most.
 */
describe('a union site key separates declarations whose TEXT is identical', () => {
  const armPair = (armB: object): SynthesisParameter =>
    ({
      name: 'operand',
      // Identical in both members of every pair below. The alias name is all a reader sees.
      type: 'Operand',
      optional: false,
      kind: 'other',
      branches: [{ type: 'number', kind: 'numeric' }, armB],
    }) as SynthesisParameter;

  it('separates an ELEMENT that resolves to a different type', () => {
    const numeric = armPair({
      type: 'Series',
      kind: 'array',
      element: { name: '[]', type: 'number', kind: 'numeric', optional: false, nullable: false },
    });
    const string_ = armPair({
      type: 'Series',
      kind: 'array',
      element: { name: '[]', type: 'string', kind: 'string', optional: false, nullable: false },
    });
    expect(keyOf(numeric)).not.toBe(keyOf(string_));
  });

  it('separates a CALLBACK arm whose resolved arity differs', () => {
    const one = armPair({
      type: 'Handler',
      kind: 'function',
      callSignature: { parameters: 1, returns: 'number' },
    });
    const two = armPair({
      type: 'Handler',
      kind: 'function',
      callSignature: { parameters: 2, returns: 'number' },
    });
    expect(keyOf(one)).not.toBe(keyOf(two));
  });

  it('separates a callback arm whose RETURN contract differs', () => {
    const returnsNumber = armPair({
      type: 'Handler',
      kind: 'function',
      callSignature: { parameters: 1, returns: 'Result' },
      returns: { name: '()', type: 'Result', kind: 'numeric', optional: false, nullable: false },
    });
    const returnsRecord = armPair({
      type: 'Handler',
      kind: 'function',
      callSignature: { parameters: 1, returns: 'Result' },
      returns: {
        name: '()',
        type: 'Result',
        kind: 'object',
        optional: false,
        nullable: false,
        fields: [numeric('value')],
      },
    });
    expect(keyOf(returnsNumber)).not.toBe(keyOf(returnsRecord));
  });

  it('separates a TUPLE arm whose positions differ', () => {
    const numberFirst = armPair({
      type: 'Pair',
      kind: 'array',
      tuple: [
        numeric('0'),
        { name: '1', type: 'string', kind: 'string', optional: false, nullable: false },
      ],
    });
    const stringFirst = armPair({
      type: 'Pair',
      kind: 'array',
      tuple: [
        { name: '0', type: 'string', kind: 'string', optional: false, nullable: false },
        numeric('1'),
      ],
    });
    expect(keyOf(numberFirst)).not.toBe(keyOf(stringFirst));
  });

  it('separates an arm whose OWN nested arms differ', () => {
    const nestedA = armPair({
      type: 'Inner',
      kind: 'object',
      branches: [
        { type: 'X', kind: 'object', fields: [numeric('x')] },
        { type: 'Y', kind: 'object', fields: [numeric('y')] },
      ],
    });
    const nestedB = armPair({
      type: 'Inner',
      kind: 'object',
      branches: [
        { type: 'X', kind: 'object', fields: [numeric('x')] },
        { type: 'Z', kind: 'object', fields: [numeric('z')] },
      ],
    });
    expect(keyOf(nestedA)).not.toBe(keyOf(nestedB));
  });

  it('separates an arm whose LITERAL domain differs', () => {
    const left = armPair({ type: 'Side', kind: 'enum', literals: ['left', 'right'] });
    const updown = armPair({ type: 'Side', kind: 'enum', literals: ['up', 'down'] });
    expect(keyOf(left)).not.toBe(keyOf(updown));
  });

  it('separates an arm field that differs only in REQUIREDNESS', () => {
    const required = armPair({ type: 'Shape', kind: 'object', fields: [numeric('a')] });
    const optional = armPair({
      type: 'Shape',
      kind: 'object',
      fields: [{ ...numeric('a'), optional: true }],
    });
    expect(keyOf(required)).not.toBe(keyOf(optional));
  });

  it('still gives one declaration ONE key — the digest is not a nonce', () => {
    const shape = () => armPair({ type: 'Shape', kind: 'object', fields: [numeric('a')] });
    expect(keyOf(shape())).toBe(keyOf(shape()));
  });
});

/**
 * A UNION BELOW A SELECTED ARM IS ITS OWN SITE.
 *
 * Discovery used to walk a chosen arm's object FIELDS and nothing else, so everything an arm can
 * hold that is not a field — an array element, tuple positions, a callback's return, a union nested
 * directly inside it — was undiscoverable. The outer union was enumerated and the contract one level
 * beneath the arm it selected never was.
 */
describe('discovery descends into the arm it selects', () => {
  it('finds a union nested inside the selected arm', () => {
    const nested: SynthesisParameter = {
      name: 'operand',
      type: 'Operand',
      optional: false,
      kind: 'other',
      branches: [
        { type: 'number', kind: 'numeric' },
        {
          type: 'Inner',
          kind: 'object',
          branches: [
            { type: 'X', kind: 'object', fields: [numeric('x')] },
            { type: 'Y', kind: 'object', fields: [numeric('y')] },
          ],
        },
      ],
    };
    const paths = unionSites([nested], []).map((site) => site.valuePath);
    expect(paths.filter((path) => path === 'arg0').length, 'the outer union is gone').toBe(2);
  });

  it('finds a union inside the selected arm’s ELEMENT', () => {
    const elementUnion: SynthesisParameter = {
      name: 'legs',
      type: 'Operand',
      optional: false,
      kind: 'other',
      branches: [
        { type: 'number', kind: 'numeric' },
        {
          type: 'ReadonlyArray<X | Y>',
          kind: 'array',
          element: {
            name: '[]',
            type: 'X | Y',
            kind: 'object',
            optional: false,
            nullable: false,
            branches: [
              { type: 'X', kind: 'object', fields: [numeric('x')] },
              { type: 'Y', kind: 'object', fields: [numeric('y')] },
            ],
          },
        },
      ],
    };
    // Two sites at `arg0`: the outer union, and the element union reached THROUGH the selected arm.
    // Before the descent this was one, and the element union had no alternatives at all.
    expect(unionSites([elementUnion], []).length).toBeGreaterThan(1);
  });

  it('gives a TUPLE arm’s positions position steps, not property steps', () => {
    const tupleArm: SynthesisParameter = {
      name: 'pair',
      type: 'Operand',
      optional: false,
      kind: 'other',
      branches: [
        { type: 'number', kind: 'numeric' },
        {
          type: '[number, X | Y]',
          kind: 'array',
          tuple: [
            numeric('0'),
            {
              name: '1',
              type: 'X | Y',
              kind: 'object',
              optional: false,
              nullable: false,
              branches: [
                { type: 'X', kind: 'object', fields: [numeric('x')] },
                { type: 'Y', kind: 'object', fields: [numeric('y')] },
              ],
            },
          ],
        },
      ],
    };
    const sites = unionSites([tupleArm], []);
    const nested = sites.find((site) => site.valuePath === 'arg0[1]');
    expect(nested, 'the union at tuple position 1 was not discovered').toBeDefined();
    expect(
      nested!.route.some((step) => 'position' in step),
      'a tuple position acquired a property route instead of a position step',
    ).toBe(true);
  });
});

/**
 * A MIXED TUPLE / NON-TUPLE UNION IS STILL A UNION OF COMPLETE ARMS.
 *
 * A tuple-special path in the validator fired whenever ANY arm carried positions and rebuilt EVERY
 * arm as `{ kind: 'array', tuple? }`. A non-tuple arm came out of that as "an array of anything":
 * its element, fields, call signature, return and nested arms were all discarded. The complete-arm
 * validator sitting directly below it was never reached for these shapes, so the fix that removed
 * this exact reconstruction everywhere else survived here by pre-empting it.
 *
 * No public declaration mixes the two today. The validator is generic, so the unsoundness was real
 * regardless of whether the surface happened to exercise it — which is the same argument as the
 * tuple-position route step, and the same reason this is a fixture rather than a live example.
 */
describe('a union mixing a tuple arm with a sequence arm judges both completely', () => {
  const mixed: SynthesisParameter = {
    name: 'side',
    type: `[number] | ReadonlyArray<'left' | 'right'>`,
    optional: false,
    kind: 'other',
    branches: [
      {
        type: '[number]',
        kind: 'array',
        tuple: [{ name: '0', type: 'number', kind: 'numeric', optional: false, nullable: false }],
      },
      {
        type: `ReadonlyArray<'left' | 'right'>`,
        kind: 'array',
        element: {
          name: '[]',
          type: `'left' | 'right'`,
          kind: 'enum',
          optional: false,
          nullable: false,
          literals: ['left', 'right'],
        },
      },
    ],
  };

  it('accepts what the TUPLE arm declares', () => {
    expect(baselineGap([mixed], [[1]])).toBeNull();
  });

  it('accepts what the SEQUENCE arm declares', () => {
    expect(baselineGap([mixed], [['left']])).toBeNull();
    expect(baselineGap([mixed], [['right', 'left']])).toBeNull();
  });

  it('REJECTS a value neither arm admits, by element type', () => {
    // `[true]` is not a one-number tuple and not a list of those two strings. The reconstruction
    // reduced the second arm to "an array", which accepted it.
    expect(baselineGap([mixed], [[true]])?.category).toBe('no-branch');
  });

  it('REJECTS a value outside the sequence arm’s literal domain', () => {
    expect(baselineGap([mixed], [['bogus']])?.category).toBe('no-branch');
  });

  it('still rejects a wrong-arity tuple when no sequence arm would take it', () => {
    const tuplesOnly: SynthesisParameter = {
      name: 'pair',
      type: '[number] | [number, number]',
      optional: false,
      kind: 'other',
      branches: [
        {
          type: '[number]',
          kind: 'array',
          tuple: [{ name: '0', type: 'number', kind: 'numeric', optional: false, nullable: false }],
        },
        {
          type: '[number, number]',
          kind: 'array',
          tuple: [
            { name: '0', type: 'number', kind: 'numeric', optional: false, nullable: false },
            { name: '1', type: 'number', kind: 'numeric', optional: false, nullable: false },
          ],
        },
      ],
    };
    // The behaviour the deleted special case existed for: a union of tuples is chosen arm by arm.
    expect(baselineGap([tuplesOnly], [[1]])).toBeNull();
    expect(baselineGap([tuplesOnly], [[1, 2]])).toBeNull();
    expect(baselineGap([tuplesOnly], [[1, 2, 3]])?.category).toBe('no-branch');
    expect(baselineGap([tuplesOnly], [['a']])?.category).toBe('no-branch');
  });
});

/**
 * A CLOSED DOMAIN IS RECORDED WHATEVER PRIMITIVE IT HOLDS.
 *
 * `semanticArms` declines to record arms for a literal-only union because the values are "already
 * recorded as `literals`". That justification was true of STRINGS only: the recorder returned `null`
 * on the first non-string, so `order?: 1 | 2` and `{ calls: 1 | -1 }` were skipped by BOTH — no arms
 * and no domain — and reached the harness as a bare `number`. The two halves of one rule disagreeing
 * is the shape of every defect in this review chain, and it is invisible from inside either half.
 */
describe('the published literal domain', () => {
  const artifact = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
  ) as { contracts: { id: string; signatures?: { parameters?: unknown[] }[] }[] };

  const domains: { record: string; values: unknown[] }[] = [];
  const walk = (node: unknown, record: string): void => {
    if (!node || typeof node !== 'object') return;
    const shape = node as Record<string, unknown>;
    if (Array.isArray(shape['literals'])) domains.push({ record, values: shape['literals'] });
    for (const key of ['fields', 'fieldTree', 'elementFieldTree', 'tuple', 'branches']) {
      for (const child of (shape[key] as unknown[]) ?? []) walk(child, record);
    }
    for (const key of ['element', 'returns']) if (shape[key]) walk(shape[key], record);
    for (const tree of (shape['tupleFieldTrees'] as unknown[][]) ?? []) {
      for (const child of tree ?? []) walk(child, record);
    }
  };
  for (const record of artifact.contracts) {
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) walk(parameter, record.id);
    }
  }

  it('records NUMERIC domains, not only string ones', () => {
    const numeric = domains.filter((entry) => entry.values.some((v) => typeof v === 'number'));
    expect(
      numeric.length,
      'no numeric literal domain is published — `literalDomain` has narrowed back to strings',
    ).toBeGreaterThan(20);
  });

  it('keeps each admitted value in its OWN primitive', () => {
    /**
     * `1` and `'1'` are different admissions. Serialising a domain as text made a numeric domain and
     * a stringly one indistinguishable — to the membership test, to the fingerprint, and to the probe
     * choosing a value outside it.
     */
    const stringified = domains.filter((entry) =>
      entry.values.some((value) => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)),
    );
    expect(
      stringified.map((entry) => entry.record).slice(0, 5),
      'a numeric domain is being published as strings',
    ).toEqual([]);
  });

  it('never publishes an empty domain — absence is how "open type" is said', () => {
    expect(domains.filter((entry) => entry.values.length === 0)).toEqual([]);
  });
});
