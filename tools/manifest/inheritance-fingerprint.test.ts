/**
 * INHERITING A VERDICT ASSERTS THE TWO NAMES ASK THE SAME QUESTION.
 *
 * `sameCallShape` gates that, and it compared parameter kind, optionality, type
 * text and a shallow field digest. Everything a UNION says was missing — so
 * `A | B` and `A | C` fingerprinted identically — along with literal domains,
 * nullability, tuple element trees and callback signatures. Each omission lets a
 * verdict cross to a declaration it was never measured against, which is the one
 * thing inheritance must never do.
 *
 * The two halves are equally load-bearing: branch ORDER must not matter (`A | B`
 * and `B | A` are the same contract), while any semantic difference must.
 */

import { describe, expect, it } from 'vitest';
import { sameCallShape, type ContractRecord } from './contract-enforcement.js';
import type { SynthesisField, SynthesisParameter } from './contract-synthesis.js';

const field = (name: string, over: Partial<SynthesisField> = {}): SynthesisField => ({
  name,
  type: 'number',
  kind: 'numeric',
  optional: false,
  nullable: false,
  ...over,
});

const record = (parameter: SynthesisParameter, id = 'x'): ContractRecord => ({
  id,
  package: 'p',
  implementation: 'i',
  signatures: [{ parameters: [parameter] }],
  inputContract: null,
  boundaryKind: 'function',
  guardReachability: 'none',
});

const union = (branches: (SynthesisField[] | null)[], types: string[]): SynthesisParameter => ({
  name: 'input',
  type: types.join(' | '),
  optional: false,
  kind: 'object',
  branches: branches.map((fields, index) => ({
    type: types[index] ?? '',
    kind: fields ? 'object' : 'other',
    ...(fields ? { fields } : {}),
  })),
});

const A = [field('a'), field('kind', { kind: 'enum', type: "'a'", literals: ['a'] })];
const B = [field('b'), field('kind', { kind: 'enum', type: "'b'", literals: ['b'] })];
const C = [field('c'), field('kind', { kind: 'enum', type: "'c'", literals: ['c'] })];

describe('branch ORDER does not change the contract', () => {
  it('treats `A | B` and `B | A` as the same call shape', () => {
    expect(
      sameCallShape(record(union([A, B], ['A', 'B'])), record(union([B, A], ['B', 'A']))),
    ).toBe(true);
  });

  it('is still order-insensitive with three branches', () => {
    expect(
      sameCallShape(
        record(union([A, B, C], ['A', 'B', 'C'])),
        record(union([C, A, B], ['C', 'A', 'B'])),
      ),
    ).toBe(true);
  });
});

describe('declaration ORDER never changes the contract', () => {
  const bag = (fields: SynthesisField[]): SynthesisParameter => ({
    name: 'input',
    type: 'Req',
    optional: false,
    kind: 'object',
    fieldTree: fields,
  });

  it('treats `{ a; b }` and `{ b; a }` as the same object', () => {
    // Field order is a fact about how someone typed the interface, not about what the boundary
    // accepts. Two spellings of one callable whose trees the checker emitted in different orders were
    // fingerprinting apart, splitting a group that should be measured once.
    expect(
      sameCallShape(record(bag([field('a'), field('b')])), record(bag([field('b'), field('a')]))),
    ).toBe(true);
  });

  it('is order-insensitive at NESTED depth too', () => {
    const nest = (inner: SynthesisField[]) =>
      bag([field('outer', { kind: 'object', type: 'Inner', fields: inner })]);
    expect(
      sameCallShape(record(nest([field('x'), field('y')])), record(nest([field('y'), field('x')]))),
    ).toBe(true);
  });

  it('but a TUPLE keeps its order — position is the meaning there', () => {
    const tuple = (trees: SynthesisField[][]): SynthesisParameter => ({
      name: 'input',
      type: '[a: A, b: B]',
      optional: false,
      kind: 'object',
      tupleFieldTrees: trees,
    });
    expect(sameCallShape(record(tuple([A, B])), record(tuple([B, A])))).toBe(false);
  });
});

describe('any SEMANTIC difference does change it', () => {
  it('separates a different branch SET', () => {
    // The headline gap: these were indistinguishable, so a verdict measured
    // against `A | B` could be inherited by `A | C`.
    expect(
      sameCallShape(record(union([A, B], ['A', 'B'])), record(union([A, C], ['A', 'C']))),
    ).toBe(false);
  });

  it('keeps the branch TYPE paired with its own shape', () => {
    /**
     * Sorting `branchFields` and `branchTypes` independently threw the association away, so
     * `A -> fieldsA, B -> fieldsB` and `A -> fieldsB, B -> fieldsA` compared EQUAL: the same multiset
     * of types and the same multiset of shapes, wired together differently. Two genuinely different
     * unions could then inherit each other's evidence — the one thing this fingerprint exists to
     * prevent, defeated by the sort that makes it order-insensitive.
     */
    expect(
      sameCallShape(record(union([A, B], ['A', 'B'])), record(union([B, A], ['A', 'B']))),
      'the branch-to-shape wiring was lost in the sort',
    ).toBe(false);
  });

  it('separates a different branch COUNT', () => {
    expect(
      sameCallShape(record(union([A, B], ['A', 'B'])), record(union([A, B, C], ['A', 'B', 'C']))),
    ).toBe(false);
  });

  it('separates a different LITERAL domain', () => {
    const open = { name: 'input', type: 'Req', optional: false, kind: 'object' as const };
    expect(
      sameCallShape(
        record({ ...open, fieldTree: [field('s', { kind: 'enum', literals: ['live', 'dead'] })] }),
        record({ ...open, fieldTree: [field('s', { kind: 'enum', literals: ['open', 'shut'] })] }),
      ),
    ).toBe(false);
  });

  it('separates a NULLABLE field from a non-nullable one', () => {
    const open = { name: 'input', type: 'Req', optional: false, kind: 'object' as const };
    expect(
      sameCallShape(
        record({ ...open, fieldTree: [field('n', { nullable: true })] }),
        record({ ...open, fieldTree: [field('n', { nullable: false })] }),
      ),
    ).toBe(false);
  });

  it('separates different CALLBACK signatures', () => {
    const open = { name: 'input', type: 'Req', optional: false, kind: 'object' as const };
    expect(
      sameCallShape(
        record({
          ...open,
          fieldTree: [
            field('f', { kind: 'function', callSignature: { parameters: 1, returns: 'number' } }),
          ],
        }),
        record({
          ...open,
          fieldTree: [
            field('f', { kind: 'function', callSignature: { parameters: 2, returns: 'number' } }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it('separates different TUPLE element trees, and respects their order', () => {
    const base: SynthesisParameter = {
      name: 'input',
      type: '[a: A, b: B]',
      optional: false,
      kind: 'object',
    };
    expect(
      sameCallShape(
        record({ ...base, tupleFieldTrees: [A, B] }),
        record({ ...base, tupleFieldTrees: [B, A] }),
      ),
      'a tuple position is part of its meaning, so these are different contracts',
    ).toBe(false);
  });

  it('still separates a different key POLICY on the same arguments', () => {
    const parameter = union([A, B], ['A', 'B']);
    const closed = record(parameter);
    const open: ContractRecord = { ...record(parameter), inputPolicies: { '0': 'open' } };
    expect(sameCallShape(closed, open)).toBe(false);
  });
});

describe('the fingerprint is complete at every depth, not only at the root', () => {
  const callable = (name: string, returns: SynthesisField | undefined): SynthesisField => ({
    name,
    type: '(context: Context) => Result',
    kind: 'function',
    optional: false,
    nullable: false,
    callSignature: { parameters: 1, returns: 'Result' },
    ...(returns ? { returns } : {}),
  });

  const nestedUnion = (first: SynthesisField[], second: SynthesisField[]): SynthesisParameter => ({
    name: 'input',
    type: 'Input',
    optional: false,
    kind: 'object',
    fieldTree: [
      {
        name: 'inner',
        type: 'A | B',
        kind: 'object',
        optional: false,
        nullable: false,
        branches: [
          { type: 'A', kind: 'object', fields: first },
          { type: 'B', kind: 'object', fields: second },
        ],
      },
    ],
  });

  const shapeA: SynthesisField[] = [
    { name: 'a', type: 'string', kind: 'string', optional: false, nullable: false },
  ];
  const shapeB: SynthesisField[] = [
    { name: 'b', type: 'number', kind: 'numeric', optional: false, nullable: false },
  ];

  it('keeps the branch-to-shape wiring inside a NESTED field, not only at the parameter root', () => {
    /**
     * The root digest paired types with shapes; nested fields still used the shape-only one, so
     * `A -> fieldsA, B -> fieldsB` and `A -> fieldsB, B -> fieldsA` fingerprinted identically one
     * level down. Same multiset of types, same multiset of shapes, wired differently — which is two
     * contracts a group key called one.
     */
    expect(
      sameCallShape(record(nestedUnion(shapeA, shapeB)), record(nestedUnion(shapeB, shapeA))),
      'a nested union survived having its branches swapped',
    ).toBe(false);
    // The order-insensitivity it was protecting still holds: the same wiring is the same contract.
    expect(
      sameCallShape(record(nestedUnion(shapeA, shapeB)), record(nestedUnion(shapeA, shapeB))),
    ).toBe(true);
  });

  it('distinguishes callbacks whose signature TEXT agrees and whose return contract does not', () => {
    // `(context: Context) => Result` twice, expanding to two different `Result`s. The signature text
    // is the same promise only if the thing it returns is.
    const withReturn = (fields: SynthesisField[]): SynthesisParameter => ({
      name: 'options',
      type: 'Options',
      optional: false,
      kind: 'object',
      fieldTree: [
        callable('build', {
          name: 'Result',
          type: 'Result',
          kind: 'object',
          optional: false,
          nullable: false,
          fields,
        }),
      ],
    });
    expect(sameCallShape(record(withReturn(shapeA)), record(withReturn(shapeB)))).toBe(false);
    expect(sameCallShape(record(withReturn(shapeA)), record(withReturn(shapeA)))).toBe(true);
  });
});
