import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  baselineGap,
  choiceFor,
  enumerateVariants,
  realizationGaps,
  selectBranch,
  synthesizeArguments,
  type SynthesisBranch,
  type SynthesisParameter,
} from './contract-synthesis.js';

const narrow: SynthesisBranch = {
  type: 'ReadonlyArray<Minimal>',
  kind: 'array',
  element: {
    name: '[]',
    type: 'Minimal',
    kind: 'object',
    optional: false,
    nullable: false,
    fields: [
      { name: 'quantity', type: 'number', kind: 'numeric', optional: false, nullable: false },
    ],
  },
};
const wide: SynthesisBranch = {
  type: 'ReadonlyArray<Decorated>',
  kind: 'array',
  element: {
    ...narrow.element!,
    type: 'Decorated',
    fields: [
      ...narrow.element!.fields!,
      { name: 'premium', type: 'number', kind: 'numeric', optional: true, nullable: false },
    ],
  },
};
const parameter = (branches: SynthesisBranch[]): SynthesisParameter => ({
  name: 'input',
  type: branches.map((arm) => arm.type).join(' | '),
  optional: false,
  kind: 'series',
  branches,
});
const selectionFor = (input: SynthesisParameter, branch: number) => {
  const variant = enumerateVariants([input], []).variants.find(
    (entry) => choiceFor(entry.selection, 'arg0')?.branch === branch,
  );
  expect(variant, 'an unrealizable arm must remain declared, not disappear').toBeDefined();
  return variant!.selection;
};

describe('explicit non-object union selection never returns a different arm', () => {
  it('declines a later overlapping arm instead of returning an earlier arm under its name', () => {
    const input = parameter([wide, narrow]);
    // The value is valid for BOTH declarations. The reader's first-match rule
    // cannot distinguish the second arm, so synthesis cannot claim it did.
    expect(baselineGap([input], [[{ quantity: 1 }]])).toBeNull();
    expect(selectBranch(input, [{ quantity: 1 }])).toBe(0);
    expect(synthesizeArguments([input], [], 0, undefined, selectionFor(input, 1))).toBeNull();
    const first = synthesizeArguments([input], [], 0, undefined, selectionFor(input, 0));
    expect(first).not.toBeNull();
    expect(realizationGaps([input], [], undefined, selectionFor(input, 0), first!)).toEqual([]);
  });

  it('still builds a distinguishable later arm on retry when an optional field separates it', () => {
    const input = parameter([narrow, wide]);
    const selection = selectionFor(input, 1);
    expect(synthesizeArguments([input], [], 0, undefined, selection)).toBeNull();
    const retried = synthesizeArguments([input], [], 1, undefined, selection);
    expect(retried).not.toBeNull();
    expect((retried![0] as { premium?: number }[])[0]).toHaveProperty('premium');
    expect(selectBranch(input, retried![0])).toBe(1);
    expect(realizationGaps([input], [], undefined, selection, retried!)).toEqual([]);
  });

  it('does not apply an explicit-branch restriction to an unselected minimal baseline', () => {
    const input = parameter([wide, narrow]);
    expect(synthesizeArguments([input], [], 0)).not.toBeNull();
  });

  it('declines an opaque alias when the reader cannot distinguish its array arm', () => {
    // readSnapshot's unresolved Kind alias is also read as the first arm. This
    // guard does not invent metadata to label it as the requested array arm.
    const input = parameter([
      { type: 'Kind', kind: 'string' },
      {
        type: 'ReadonlyArray<Kind>',
        kind: 'array',
        element: {
          name: '[]',
          type: 'Kind',
          kind: 'string',
          optional: false,
          nullable: false,
        },
      },
    ]);
    expect(selectBranch(input, ['x'])).toBe(0);
    expect(synthesizeArguments([input], [], 0, undefined, selectionFor(input, 1))).toBeNull();
  });

  const records = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
  ) as {
    contracts: {
      id: string;
      fields?: string[];
      signatures: { parameters: SynthesisParameter[] }[];
    }[];
  };
  it.each([
    '@totalfinance/strategy:classifyStrategy',
    'totalfinance:classifyStrategy',
    'totalfinance:strategy.classifyStrategy',
  ])('keeps %s honest independently of the Position shape digest', (id) => {
    const record = records.contracts.find((entry) => entry.id === id)!;
    expect(record).toBeDefined();
    const input = record.signatures[0]!.parameters[0]!;
    const index = input.branches!.findIndex((arm) => arm.type === 'ReadonlyArray<ClassifiableLeg>');
    expect(index).toBeGreaterThan(0);
    const selection = selectionFor(input, index);
    /**
     * Pre-publish repairs B4 (2026-09-21): `LegInput` is a discriminated union whose option arms
     * REQUIRE `strike` and `expiry`, so the minimal classifiable leg `{ kind, quantity }` is no
     * longer valid for the earlier array arm. The reader now distinguishes the later arm, and
     * synthesis may claim it — honestly: the built value selects the requested arm and realizes it
     * without gaps. Before B4 the two array arms overlapped on that value and the only honest
     * answer was to decline.
     */
    const built = synthesizeArguments([input], record.fields ?? [], 0, undefined, selection);
    expect(built).not.toBeNull();
    expect(selectBranch(input, built![0])).toBe(index);
    expect(realizationGaps([input], record.fields ?? [], undefined, selection, built!)).toEqual([]);
    // Unrelated source growth changes the union fingerprint, never the rule.
    const changed = structuredClone(input);
    const position = changed.branches!.find((arm) => arm.type === 'Position')!;
    position.fields!.push({
      name: 'futureMethod',
      type: '() => number',
      kind: 'function',
      optional: false,
      nullable: false,
      callSignature: { parameters: 0, returns: 'number' },
    });
    const changedSelection = selectionFor(changed, index);
    expect([...changedSelection.keys()]).not.toEqual([...selection.keys()]);
    const rebuilt = synthesizeArguments(
      [changed],
      record.fields ?? [],
      0,
      undefined,
      changedSelection,
    );
    expect(rebuilt).not.toBeNull();
    expect(selectBranch(changed, rebuilt![0])).toBe(index);
    expect(
      realizationGaps([changed], record.fields ?? [], undefined, changedSelection, rebuilt!),
    ).toEqual([]);
  });
});
