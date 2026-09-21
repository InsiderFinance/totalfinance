import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('standalone built export inventory', () => {
  it('resolves self exports, including renamed deep paths, without an app-installed package', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { inventoryPackage } from './tools/manifest/inventory.ts';
      const inventory = await inventoryPackage({
        package: '@totalfinance/foreign-exchange', dir: 'foreign-exchange', entrypoints: ['./risk'],
      }, { built: true });
      if (!inventory.has('currencyExposure') || !inventory.has('hedgeRatio')) throw new Error('missing real built exports');
      if (inventory.get('currencyExposure').entrypoints.join(',') !== './risk') throw new Error('wrong public path');
      console.log('built-self-exports-ok');
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('built-self-exports-ok');
  });
});
