/** Executable HTTP auth teaching: run the published snippets without putting secrets in argv. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { createLocalHttpServer } from '@totalfinance/http';
import { createLocalJobRunner, registryForProfile } from '@totalfinance/workflows/local';
import { extractTsBlocks, readmeAliasMap } from '../../../tools/readme-exec.js';

const guide = readFileSync(new URL('../../../docs/guides/http.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function runCode(code: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // stdin also avoids an OS argument-length limit for bundled SDK examples.
    const child = spawn(process.execPath, ['--input-type=module'], { cwd, timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(`HTTP documentation snippet exited ${status}: ${stderr}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(code);
  });
}

describe('HTTP authentication documentation examples', () => {
  it.each([
    ['README', readme],
    ['guide', guide],
  ])(
    '%s creates a private random token without printing or overwriting it',
    async (_name, markdown) => {
      const directory = mkdtempSync(join(tmpdir(), 'totalfinance-http-doc-token-'));
      try {
        const code = markdown.match(/^node --input-type=module -e '([^']+)'$/m)?.[1];
        expect(code).toBeDefined();
        const result = await runCode(code!, directory);
        const file = join(directory, '.totalfinance-http-token');
        const token = readFileSync(file, 'utf8');
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(result).toEqual({ stdout: '', stderr: '' });
        const retry = spawnSync(process.execPath, ['--input-type=module'], {
          cwd: directory,
          input: code,
          encoding: 'utf8',
        });
        expect(retry.status).not.toBe(0);
        expect(readFileSync(file, 'utf8')).toBe(token);
        expect(retry.stdout + retry.stderr).not.toContain(token);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('the guide client authenticates a real persisted analytics job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'totalfinance-http-doc-job-'));
    try {
      const generation = guide.match(/^node --input-type=module -e '([^']+)'$/m)?.[1];
      expect(generation).toBeDefined();
      await runCode(generation!, directory);
      const authenticationToken = readFileSync(join(directory, '.totalfinance-http-token'), 'utf8');
      const registry = registryForProfile({ profile: 'default' });
      const jobs = createLocalJobRunner({
        registry,
        directory,
        profile: 'default',
        clock: () => new Date().toISOString(),
      });
      const local = createLocalHttpServer({ registry, jobs, authenticationToken, port: 0 });
      const { url } = await local.start();
      try {
        const client = guide.match(/node --input-type=module <<'JS'\n([\s\S]*?)\nJS/)?.[1];
        expect(client).toContain('http://127.0.0.1:8787/jobs');
        const result = await runCode(
          client!.replace('http://127.0.0.1:8787/jobs', `${url}/jobs`),
          directory,
        );
        expect(result.stdout).toContain('totalfinance.option.price');
        expect(result.stdout + result.stderr).not.toContain(authenticationToken);
        expect(jobs.list()).toHaveLength(1);
        expect(jobs.list()[0]!.state).toBe('completed');
      } finally {
        await local.stop();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(extractTsBlocks(guide).map((code, index) => [index + 1, code] as const))(
    'SDK example %s builds and starts its server',
    async (_index, code) => {
      const result = await build({
        stdin: { contents: code, loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'es2022',
        write: false,
        alias: readmeAliasMap(),
        logLevel: 'silent',
      });
      const output = await runCode(result.outputFiles[0]!.text, tmpdir());
      expect(output).toEqual({ stdout: '', stderr: '' });
    },
  );
});
