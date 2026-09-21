/**
 * Regenerate the committed OpenAPI document (`packages/http/etc/openapi.json`) from the full-profile
 * registry. Run `pnpm openapi:update` in the same commit that changes an operation; the gate
 * (`tools/openapi-doc.test.ts`) diffs it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '@totalfinance/http';
import { registryForProfile } from '@totalfinance/workflows/local';

const target = fileURLToPath(new URL('../packages/http/etc/openapi.json', import.meta.url));
mkdirSync(dirname(target), { recursive: true });
const document = openApiDocument({ registry: registryForProfile({ profile: 'full' }) });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `openapi: wrote ${target} — ${Object.keys(document.paths).length} paths, ${Object.keys(document.components.schemas).length} schemas`,
);
