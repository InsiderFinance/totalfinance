import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { API_PACKAGES, generateReport, generateReports } from './generate.js';

describe('batched API reports', () => {
  let reports: ReturnType<typeof generateReports>;
  beforeAll(() => {
    reports = generateReports();
  }, 60_000);

  it('preserves every committed report byte for byte and keeps package order', () => {
    expect([...reports.keys()]).toEqual([...API_PACKAGES]);
    for (const pkg of API_PACKAGES) {
      const committed = readFileSync(
        new URL(`../../packages/${pkg}/etc/${pkg}.api.md`, import.meta.url),
        'utf8',
      );
      expect(reports.get(pkg), pkg).toBe(committed);
    }
  });

  it.each(['core', 'options', 'totalfinance'] as const)(
    'matches the independent single-entry compiler for %s',
    (pkg) => {
      expect(reports.get(pkg)).toBe(generateReport(pkg));
    },
    60_000,
  );

  it('reads changed source on the next invocation instead of retaining a stale compiler', () => {
    const entry = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));
    const originalRead = ts.sys.readFile;
    const marker = 'apiReportFreshSourceRegressionMarker';
    let entryReads = 0;
    expect(reports.get('core')).not.toContain(marker);
    const read = vi.spyOn(ts.sys, 'readFile').mockImplementation((path, encoding) => {
      const source = originalRead(path, encoding);
      if (path === entry) entryReads += 1;
      return path === entry && source !== undefined
        ? `${source}\nexport const ${marker} = 'fresh';\n`
        : source;
    });
    try {
      expect(generateReports().get('core')).toContain(`const ${marker}`);
      expect(entryReads).toBe(1);
    } finally {
      read.mockRestore();
    }
    expect(generateReport('core')).toBe(reports.get('core'));
  }, 60_000);
});
