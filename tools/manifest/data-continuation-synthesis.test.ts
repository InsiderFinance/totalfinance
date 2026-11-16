/** Real C5 continuation branches must be built, never silently reported with an absent cursor. */
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import {
  enumerateVariants,
  synthesizeArguments,
  realizationGaps,
  resetSynthesisIdentities,
  type SynthesisParameter,
} from './contract-synthesis.js';
const contracts = JSON.parse(
  readFileSync(new URL('./public-contracts.json', import.meta.url), 'utf8'),
).contracts as {
  id: string;
  fields: string[];
  signatures: { parameters: SynthesisParameter[] }[];
}[];
for (const id of [
  '@totalfinance/core:DataProvider#query',
  '@totalfinance/core:ConnectedData#query',
])
  it(id + ' builds each selected flat snapshot at the existing depth bound', () => {
    const record = contracts.find((r) => r.id === id);
    if (!record) throw Error('missing public contract');
    resetSynthesisIdentities();
    const parameters = record.signatures[0]!.parameters;
    const variants = enumerateVariants(parameters, record.fields).variants.filter((v) =>
      v.id.includes('arg1.cursor:present.binding.query:kind=option-chain-research.snapshot#'),
    );
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      const args = synthesizeArguments(parameters, record.fields, 0, undefined, v.selection);
      expect(args).not.toBeNull();
      expect(realizationGaps(parameters, record.fields, undefined, v.selection, args!)).toEqual([]);
      expect(
        (args![1] as { cursor: { binding: { query: { snapshot: unknown } } } }).cursor.binding.query
          .snapshot,
      ).toHaveProperty('kind');
    }
  });
it('does not turn truncated nested objects into an invented flat leaf', () => {
  const record = structuredClone(
    contracts.find((r) => r.id === '@totalfinance/core:DataProvider#query')!,
  );
  function change(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const x = value as Record<string, unknown>;
    if (x['type'] === "{ readonly kind: 'latest'; }")
      x['type'] = "{ readonly kind: 'latest'; readonly nested: { value: number }; }";
    for (const v of Object.values(x))
      if (Array.isArray(v)) v.forEach(change);
      else change(v);
  }
  change(record.signatures[0]!.parameters);
  resetSynthesisIdentities();
  const p = record.signatures[0]!.parameters;
  const v = enumerateVariants(p, record.fields).variants.find((v) =>
    v.id.includes('arg1.cursor:present.binding.query:kind=option-chain-research.snapshot#0'),
  );
  if (!v) throw Error('missing nested control');
  const args = synthesizeArguments(p, record.fields, 0, undefined, v.selection);
  expect(args).not.toBeNull();
  expect(realizationGaps(p, record.fields, undefined, v.selection, args!)).not.toEqual([]);
});
