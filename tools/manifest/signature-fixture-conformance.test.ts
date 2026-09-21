/** Phase 3A: executable examples must use the same argument grammar as the declarations. */

import { describe, expect, it } from 'vitest';
import { allFixtures } from '../first-touch/fixtures.js';
import { readPublicSignatureManifest } from './signature-inventory.js';

function callableId(fixtureKey: string): string {
  const [pkg, ...path] = fixtureKey.split('.');
  return `@totalfinance/${pkg}:${path.join('.')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('public signature fixture conformance (Law 14)', () => {
  it('every first-touch fixture follows its callable grammar', () => {
    const manifest = readPublicSignatureManifest();
    expect(
      manifest,
      'missing tools/manifest/public-signatures.json — run pnpm signature:update',
    ).toBeTruthy();

    const callables = new Map(manifest!.callables.map((callable) => [callable.id, callable]));
    const problems: string[] = [];

    for (const [key, fixture] of allFixtures()) {
      const callable = callables.get(callableId(key));
      // Some registry fixtures exercise indicators that are discoverable by name but not exported
      // as individual runtime callables. They have no declaration signature to compare here.
      if (!callable) continue;

      const args = fixture();
      if (callable.grammar === 'object' && !(args.length === 1 && isObject(args[0]))) {
        problems.push(`${key}: object grammar requires one named request object`);
      }
      if (callable.grammar === 'none' && args.length !== 0) {
        problems.push(`${key}: zero-argument callable fixture supplied ${args.length} arguments`);
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
