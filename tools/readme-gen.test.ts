import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildReadmes } from './readme-gen.js';

// Drift guard (DX4.2): the committed per-package READMEs must match what the generator produces from
// the live manifests, API reports, and CI-run example snippets. Regenerate with
// `pnpm tsx tools/readme-gen.ts` after any public-API or example change.
describe('DX4.2 per-package READMEs are up to date', () => {
  for (const { dir, content } of buildReadmes()) {
    it(`packages/${dir}/README.md matches the generator`, () => {
      const committed = readFileSync(
        fileURLToPath(new URL(`../packages/${dir}/README.md`, import.meta.url)),
        'utf8',
      );
      expect(committed).toBe(content);
    });
  }
});
