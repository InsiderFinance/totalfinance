/** R11/R12: credentials and process survival through the built binary users actually launch. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'totalfinance-http-bin-'));
const token = randomBytes(32).toString('hex');
const tokenFile = join(directory, 'token');
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

function environment(credential?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['TOTALFINANCE_HTTP_TOKEN'];
  return { ...env, ...(credential === undefined ? {} : { TOTALFINANCE_HTTP_TOKEN: credential }) };
}

function cli(args: string[], credential?: string) {
  return spawnSync(process.execPath, [BIN, '--store', directory, ...args], {
    env: environment(credential),
    encoding: 'utf8',
    timeout: 10_000,
    // Full trade schemas exceed spawnSync's default 1 MiB stdout capture limit.
    maxBuffer: 16_777_216,
  });
}

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the HTTP CLI credential contract', () => {
  it('teaches protected token files/environment and refuses writable startup without a token', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).toContain('--token-file');
    expect(help.stderr).toContain('TOTALFINANCE_HTTP_TOKEN');
    expect(help.stderr).toContain('randomBytes(32)');
    expect(help.stderr).toContain('read-only inline analytics remain public');
    const denied = cli(['--profile', 'full', '--capability', 'trade:approve', '--openapi']);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('authenticationToken');
    expect(denied.stderr).toContain('--token-file');
  });

  it('accepts token-file or environment, prefers the file, and never includes credentials in OpenAPI or logs', () => {
    for (const [args, credential] of [
      [['--token-file', tokenFile], undefined],
      [[], token],
      [['--token-file', tokenFile], 'invalid-short-env-token'],
    ] as const) {
      const result = cli(
        ['--profile', 'full', '--capability', 'trade:approve', '--openapi', ...args],
        credential,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        components: { securitySchemes: { localBearer: { scheme: 'bearer' } } },
      });
      expect(result.stdout + result.stderr).not.toContain(token);
      if (credential !== undefined) expect(result.stdout + result.stderr).not.toContain(credential);
    }
  });

  it('does not repeat invalid secrets or accidentally supplied secret arguments in errors', () => {
    const short = 'short-secret-value';
    const invalid = cli(['--openapi'], short);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).not.toContain(short);
    const argument = cli([`--token=${token}`]);
    expect(argument.status).toBe(2);
    expect(argument.stdout + argument.stderr).not.toContain(token);
    const missing = cli(['--token-file', join(directory, 'absent'), '--openapi']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Unable to read --token-file');
  });

  it('keeps the launched process alive after malformed URLs and emits no credential in its listening line or logs', async () => {
    const child = spawn(
      process.execPath,
      [BIN, '--store', directory, '--port', '0', '--token-file', tokenFile],
      {
        env: environment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    try {
      const base = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP binary did not start.')), 10_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`HTTP binary exited early (${code}).`));
        });
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.includes('\n')) {
            clearTimeout(timer);
            try {
              resolve((JSON.parse(stdout.trim()) as { listening: string }).listening);
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      for (const path of ['/%', '/%ZZ', '/%E0%A4%A', '/operations/a%2Fb/run']) {
        const bad = await fetch(`${base}${path}`);
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ code: 'input.wrong_shape' });
        expect((await fetch(`${base}/capabilities`)).status).toBe(200);
        expect(child.exitCode).toBeNull();
      }
      expect(JSON.parse(stdout)).toMatchObject({ listening: base, port: expect.any(Number) });
      expect(stdout + stderr).not.toContain(token);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill('SIGTERM');
        await closed;
      }
    }
  });
});
