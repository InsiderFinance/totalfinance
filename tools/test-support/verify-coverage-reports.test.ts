import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCoverageReports } from './verify-coverage-reports.js';

describe('coverage merge requires every shard report', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'totalfinance-coverage-reports-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const report = (index: number, count = 5, content = '{}') =>
    writeFileSync(join(directory, `blob-${index}-${count}.json`), content);
  const complete = () => {
    for (let index = 1; index <= 5; index++) report(index);
  };
  const verify = () => verifyCoverageReports({ directory, shardCount: 5 });

  it('accepts the exact five nonempty files (Vitest validates their contents)', () => {
    complete();
    expect(verify).not.toThrow();
  });

  it('rejects a missing shard even when the other reports exist', () => {
    complete();
    rmSync(join(directory, 'blob-4-5.json'));
    expect(verify).toThrow('missing [blob-4-5.json]');
  });

  it('checks identities, not just the number of files', () => {
    complete();
    rmSync(join(directory, 'blob-4-5.json'));
    report(4, 3);
    expect(verify).toThrow('missing [blob-4-5.json]; unexpected [blob-4-3.json]');
  });

  it('rejects unexpected reports even when every expected one exists', () => {
    complete();
    report(6);
    expect(verify).toThrow('unexpected [blob-6-5.json]');
  });

  it('rejects an empty directory or a missing directory', () => {
    expect(verify).toThrow('Expected all 5 shard reports');
    expect(() =>
      verifyCoverageReports({ directory: join(directory, 'missing'), shardCount: 5 }),
    ).toThrow();
  });

  it('rejects empty files', () => {
    complete();
    report(2, 5, '');
    expect(verify).toThrow('blob-2-5.json must be a nonempty regular file');
  });

  it('rejects a directory masquerading as a report', () => {
    complete();
    rmSync(join(directory, 'blob-2-5.json'));
    mkdirSync(join(directory, 'blob-2-5.json'));
    expect(verify).toThrow('blob-2-5.json must be a nonempty regular file');
  });

  it('rejects a symlink substituting another shard report', () => {
    complete();
    rmSync(join(directory, 'blob-2-5.json'));
    symlinkSync(join(directory, 'blob-1-5.json'), join(directory, 'blob-2-5.json'));
    expect(verify).toThrow('blob-2-5.json must be a nonempty regular file');
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid shard count %s', (shardCount) => {
    expect(() => verifyCoverageReports({ directory, shardCount })).toThrow('positive safe integer');
  });

  it('exits nonzero for missing evidence and zero for a complete set', () => {
    const script = fileURLToPath(new URL('./verify-coverage-reports.ts', import.meta.url));
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', script, directory, '5'], {
        encoding: 'utf8',
      });
    const incomplete = run();
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain('Incomplete coverage reports');
    complete();
    const completed = run();
    expect(completed.status).toBe(0);
    expect(completed.stdout).toContain('Verified all 5 coverage shard reports');
  });

  it('the workflow refuses missing uploads and verifies the exact set before merging', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/totalfinance-ci.yml', import.meta.url),
      'utf8',
    );
    const upload = workflow.slice(
      workflow.indexOf('- uses: actions/upload-artifact@v4'),
      workflow.indexOf('\n  static:'),
    );
    expect(upload).toContain('if-no-files-found: error');
    expect(upload).toContain('path: .vitest-reports/blob-${{ matrix.shard }}-5.json');
    const merge = workflow.slice(
      workflow.indexOf('\n  coverage:'),
      workflow.indexOf('\n  release-rehearsal:'),
    );
    expect(merge).toContain(
      'pnpm exec tsx tools/test-support/verify-coverage-reports.ts .vitest-reports 5',
    );
    expect(merge.indexOf('verify-coverage-reports.ts')).toBeLessThan(
      merge.indexOf('vitest run --merge-reports --coverage'),
    );
  });
});
