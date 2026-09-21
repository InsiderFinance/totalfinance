/**
 * The committed OpenAPI document is a generated artifact (Stage 7A Decision 7): regenerate from the
 * full-profile registry and diff. A drift here means `pnpm openapi:update` was not run in the commit
 * that changed an operation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '@totalfinance/http';
import { registryForProfile } from '@totalfinance/workflows/local';

const COMMITTED = fileURLToPath(new URL('../packages/http/etc/openapi.json', import.meta.url));

describe('the committed OpenAPI document (Stage 7A)', () => {
  const generated = openApiDocument({ registry: registryForProfile({ profile: 'full' }) });

  it('is byte-identical to a fresh generation over the full profile', () => {
    const committed = readFileSync(COMMITTED, 'utf8');
    expect(
      committed,
      'packages/http/etc/openapi.json drifted — run `pnpm openapi:update` in the same commit',
    ).toBe(`${JSON.stringify(generated, null, 2)}\n`);
  });

  it('is structurally OpenAPI 3.1: one run path per operation, components keyed by id, one error schema, the vendor extension', () => {
    expect(generated.openapi).toBe('3.1.0');
    const runPaths = Object.keys(generated.paths).filter((path) => path.endsWith('/run'));
    const ids = registryForProfile({ profile: 'full' })
      .list()
      .map((op) => op.id)
      .sort();
    expect(runPaths.map((path) => path.slice('/operations/'.length, -'/run'.length))).toEqual(ids);
    for (const id of ids) {
      expect(generated.components.schemas[`${id}.input`]).toBeDefined();
      expect(generated.components.schemas[`${id}.result`]).toBeDefined();
      const run = generated.paths[`/operations/${id}/run`]!['post'] as Record<string, unknown>;
      // Stage 7B.2 slice 4 (2026-09-06): the trade pack's writes carry their own effect fields
      const described = registryForProfile({ profile: 'full' }).describe(id);
      expect(run['x-totalfinance']).toMatchObject({
        sideEffect: described.sideEffect,
        authorization: described.authorization,
      });
      const responses = run['responses'] as Record<string, unknown>;
      for (const status of ['200', '400', '404', '413', '422', '500'])
        expect(responses[status]).toBeDefined();
    }
    expect(generated.components.schemas['OperationError']).toBeDefined();
    for (const route of [
      '/operations',
      '/operations/{id}',
      '/jobs',
      '/jobs/{id}',
      '/jobs/{id}/cancel',
      '/jobs/{id}/result',
      '/artifacts/{uri}',
      '/capabilities',
      '/openapi.json',
    ]) {
      expect(generated.paths[route], route).toBeDefined();
    }
    // Every $ref resolves.
    const refs = [
      ...JSON.stringify(generated).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]!);
    for (const ref of refs) expect(generated.components.schemas[ref], ref).toBeDefined();
  });
});
