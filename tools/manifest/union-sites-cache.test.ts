import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LiteralValue } from './contract-fields.js';
import {
  resetSynthesisIdentities,
  synthesizeArguments,
  unionSites,
  type RouteStep,
  type SynthesisBranch,
  type SynthesisField,
  type SynthesisParameter,
  type UnionSite,
  type VariantChoice,
} from './contract-synthesis.js';

const declaration = (): SynthesisParameter[] => [
  {
    name: 'input',
    type: 'number | string',
    kind: 'other',
    optional: false,
    branches: [
      { type: 'number', kind: 'numeric' },
      { type: 'string', kind: 'string' },
    ],
  },
];

describe('union-site declaration cache', () => {
  it('shares site metadata but gives every caller its own array', () => {
    const parameters = declaration();
    const fields: string[] = [];
    const first = unionSites(parameters, fields);
    const expected = structuredClone(first);
    const second = unionSites(parameters, fields);

    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    first.splice(0, first.length);
    expect(second).toEqual(expected);
    expect(unionSites(parameters, fields)).toEqual(expected);
  });

  it('keeps different declaration objects separate even when their shapes initially agree', () => {
    const parameters = declaration();
    const fields: string[] = [];
    const first = unionSites(parameters, fields);
    const independent = declaration();
    const second = unionSites(independent, fields);

    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);

    // Changed declarations get new identities; mutating an already cached declaration is unsupported.
    const changed = declaration();
    changed[0]!.branches![1] = { type: 'boolean', kind: 'primitive' };
    const third = unionSites(changed, fields);
    expect(third[0]!.key).not.toBe(first[0]!.key);
    expect(unionSites(parameters, fields)).toEqual(first);
  });

  it('keys fields and producers by identity without invoking a producer', () => {
    const parameters = declaration();
    const fields: string[] = [];
    const producers = new Map([
      [
        'unused',
        () => {
          throw new Error('declaration discovery must not invoke a producer');
        },
      ],
    ]);
    const first = unionSites(parameters, fields, producers);

    expect(unionSites(parameters, fields, producers)[0]).toBe(first[0]);
    expect(unionSites(parameters, [...fields], producers)[0]).not.toBe(first[0]);
    expect(unionSites(parameters, fields, new Map(producers))[0]).not.toBe(first[0]);
    expect(unionSites(parameters, fields)[0]).not.toBe(first[0]);
  });

  it('does not consume synthesized identities on a cache miss or a hit', () => {
    const named: SynthesisParameter[] = [
      { name: 'name', type: 'string', kind: 'string', optional: false },
    ];
    resetSynthesisIdentities();
    const expected = synthesizeArguments(named, []);
    expect(expected).toEqual(['Test1']);
    resetSynthesisIdentities();
    try {
      const parameters = declaration();
      const fields: string[] = [];
      unionSites(parameters, fields);
      unionSites(parameters, fields);
      expect(synthesizeArguments(named, [])).toEqual(expected);
      expect(synthesizeArguments(named, [])).toEqual(['Test2']);
    } finally {
      resetSynthesisIdentities();
    }
  });

  it('exposes shared metadata as readonly in the TypeScript contract', () => {
    expectTypeOf<UnionSite>().toEqualTypeOf<Readonly<UnionSite>>();
    expectTypeOf<UnionSite['alternatives']>().toEqualTypeOf<readonly VariantChoice[]>();
    expectTypeOf<VariantChoice>().toEqualTypeOf<Readonly<VariantChoice>>();
    expectTypeOf<NonNullable<VariantChoice['discriminator']>>().toEqualTypeOf<
      readonly { readonly field: string; readonly value: LiteralValue }[]
    >();
    expectTypeOf<UnionSite['route']>().toEqualTypeOf<readonly RouteStep[]>();
    expectTypeOf<RouteStep>().toEqualTypeOf<Readonly<RouteStep>>();
    expectTypeOf<UnionSite['branches']>().toEqualTypeOf<readonly SynthesisBranch[] | undefined>();
    expectTypeOf<UnionSite['branchFields']>().toEqualTypeOf<
      readonly (readonly SynthesisField[] | null)[]
    >();
    expectTypeOf<UnionSite['branchTypes']>().toEqualTypeOf<readonly string[] | undefined>();
  });
});
