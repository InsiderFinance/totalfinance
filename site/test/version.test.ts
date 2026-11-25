import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readSiteVersion } from '../version.js';

function fixture(version: string, mcpVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'totalfinance-site-version-'));
  mkdirSync(join(root, 'distribution/totalfinance'), { recursive: true });
  mkdirSync(join(root, 'distribution/mcp'), { recursive: true });
  writeFileSync(
    join(root, 'distribution/totalfinance/package.json'),
    JSON.stringify({ name: '@insiderfinance/totalfinance', version }),
  );
  writeFileSync(
    join(root, 'distribution/mcp/package.json'),
    JSON.stringify({ name: '@insiderfinance/totalfinance-mcp', version: mcpVersion }),
  );
  return root;
}

describe('version labels', () => {
  it.each([
    ['0.1.7', 'Pre-1.0 · 0.1.7'],
    ['0.2.0-beta.1', 'Preview · 0.2.0-beta.1'],
    ['1.0.0', 'Stable · 1.0.0'],
  ])('labels %s from the package manifests', (version, label) => {
    const root = fixture(version);
    try {
      expect(readSiteVersion(root)).toEqual({
        version,
        label,
        packageVersions: {
          '@insiderfinance/totalfinance': version,
          '@insiderfinance/totalfinance-mcp': version,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires both public distributions at one version', () => {
    const root = fixture('0.1.7', '0.2.0');
    try {
      expect(() => readSiteVersion(root)).toThrow('both public distributions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
