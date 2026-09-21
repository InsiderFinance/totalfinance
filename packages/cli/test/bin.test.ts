/**
 * Stage 7A slice 4 — the `totalfinance` binary, spawned as a process for every command and exit code:
 * stdout purity (one JSON document), logs on stderr, the exit-code contract, jobs across processes.
 * Runs against the workspace build (`dist/bin.js`), like the worker.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isoDateToEpochMs, resolvedExpiry } from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { CLI_EXIT_CODES } from '@totalfinance/cli';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fresh = () => mkdtempSync(join(tmpdir(), 'totalfinance-cli-'));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

/** Spawn the binary; parse stdout as ONE JSON document when it is not empty. */
function totalfinance(args: string[], options: { stdin?: string; store?: string } = {}): Run {
  const result = spawnSync(
    process.execPath,
    [BIN, ...args, ...(options.store ? ['--store', options.store] : [])],
    {
      encoding: 'utf8',
      input: options.stdin,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
  const stdout = result.stdout ?? '';
  let json: unknown = undefined;
  if (stdout.trim().length > 0) {
    try {
      json = JSON.parse(stdout) as unknown; // one document (pretty or compact)
    } catch {
      json = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown); // NDJSON (job status --follow)
    }
  }
  return { code: result.status ?? -1, stdout, stderr: result.stderr ?? '', json };
}

const PRICE = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};

describe('the totalfinance binary', () => {
  it('is built (the tests run against dist, like the worker)', () => {
    expect(existsSync(BIN)).toBe(true);
  });

  it('--version and --help; no command is a usage error', () => {
    const version = totalfinance(['--version']);
    expect(version.code).toBe(CLI_EXIT_CODES.success);
    expect(version.json).toMatchObject({ workflows: expect.any(String), node: process.version });
    const help = totalfinance(['--help']);
    expect(help.code).toBe(CLI_EXIT_CODES.success);
    expect(help.stdout).toBe('');
    expect(help.stderr).toContain('totalfinance operations list');
    const none = totalfinance([]);
    expect(none.code).toBe(CLI_EXIT_CODES.usage);
    expect(none.stdout).toBe('');
    const unknown = totalfinance(['frobnicate']);
    expect(unknown.code).toBe(CLI_EXIT_CODES.usage);
    expect(unknown.stderr).toContain('unknown command');
    const badFlag = totalfinance(['operations', 'list', '--bogus']);
    expect(badFlag.code).toBe(CLI_EXIT_CODES.usage);
  });

  it('operations list renders descriptions for the profile; --packs narrows it; a bad profile is usage', () => {
    const store = fresh();
    const defaults = totalfinance(['operations', 'list'], { store });
    expect(defaults.code).toBe(CLI_EXIT_CODES.success);
    expect((defaults.json as unknown[]).length).toBe(23);
    const full = totalfinance(['operations', 'list', '--profile', 'full'], { store });
    // 40 → 46 (Stage 7B.2 slice 4, 2026-09-06): the six trade-lifecycle operations join the full profile.
    expect((full.json as unknown[]).length).toBe(46);
    const narrowed = totalfinance(
      ['operations', 'list', '--profile', 'full', '--packs', 'artifact,options'],
      { store },
    );
    expect((narrowed.json as { id: string }[]).map((op) => op.id).sort()).toEqual([
      'totalfinance.artifact.compare',
      'totalfinance.artifact.read',
      'totalfinance.option.greeks',
      'totalfinance.option.implied_volatility',
      'totalfinance.option.price',
    ]);
    expect(totalfinance(['operations', 'list', '--profile', 'nope'], { store }).code).toBe(
      CLI_EXIT_CODES.usage,
    );
    const pretty = totalfinance(['operations', 'list', '--pretty'], { store });
    expect(pretty.code).toBe(CLI_EXIT_CODES.success);
    expect(pretty.stderr).toMatch(/23 operations across 10 packs/);
    expect(pretty.stdout.split('\n').length).toBeGreaterThan(3); // indented
  });

  it('schema prints the input or output schema; an unknown id is an operation failure with the teaching', () => {
    const store = fresh();
    const input = totalfinance(['schema', 'totalfinance.option.price'], { store });
    expect(input.code).toBe(CLI_EXIT_CODES.success);
    expect(input.json).toMatchObject({ type: 'object' });
    const output = totalfinance(['schema', 'totalfinance.option.price', '--output'], { store });
    expect(output.json).toMatchObject({ type: 'object' });
    const unknown = totalfinance(['schema', 'totalfinance.nope.x'], { store });
    expect(unknown.code).toBe(CLI_EXIT_CODES.operationFailed);
    expect(unknown.json).toMatchObject({ code: 'operation.unknown' });
  });

  it('run: one OperationResult on stdout; a refused input exits 3 with the error document; stdin with -', () => {
    const store = fresh();
    const file = join(store, 'input.json');
    writeFileSync(file, JSON.stringify(PRICE));
    const ok = totalfinance(['run', 'totalfinance.option.price', '--input', file], { store });
    expect(ok.code).toBe(CLI_EXIT_CODES.success);
    expect(ok.json).toMatchObject({ operation: { id: 'totalfinance.option.price', version: '1' } });
    expect(ok.stderr).toBe('');
    const viaStdin = totalfinance(['run', 'totalfinance.option.price', '--input', '-'], {
      store,
      stdin: JSON.stringify(PRICE),
    });
    expect(viaStdin.code).toBe(CLI_EXIT_CODES.success);
    expect((viaStdin.json as { structured: { value: number } }).structured.value).toBeCloseTo(
      (ok.json as { structured: { value: number } }).structured.value,
      12,
    );
    const refused = totalfinance(['run', 'totalfinance.option.price', '--input', '-'], {
      store,
      stdin: JSON.stringify({ ...PRICE, spot: -1 }),
    });
    expect(refused.code).toBe(CLI_EXIT_CODES.inputRefused);
    expect(refused.json).toMatchObject({
      code: expect.stringMatching(/^input\./),
      operation: { id: 'totalfinance.option.price' },
    });
    const malformed = totalfinance(['run', 'totalfinance.option.price', '--input', '-'], {
      store,
      stdin: '{not json',
    });
    expect(malformed.code).toBe(CLI_EXIT_CODES.usage);
    const noInput = totalfinance(['run', 'totalfinance.option.price'], { store });
    expect(noInput.code).toBe(CLI_EXIT_CODES.usage);
    const tooBig = totalfinance(
      ['run', 'totalfinance.option.price', '--input', '-', '--max-input-bytes', '16'],
      { store, stdin: JSON.stringify(PRICE) },
    );
    expect(tooBig.code).toBe(CLI_EXIT_CODES.operationFailed);
    expect(tooBig.json).toMatchObject({ code: 'operation.input_too_large' });
    const seeded = totalfinance(
      ['run', 'totalfinance.risk.value_at_risk', '--input', '-', '--seed', '7'],
      {
        store,
        stdin: JSON.stringify({
          returns: [0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.003, -0.004],
          method: 'monteCarlo',
        }),
      },
    );
    expect(seeded.code).toBe(CLI_EXIT_CODES.success);
    expect((seeded.json as { assumptions: { seed: number } }).assumptions.seed).toBe(7);
  });

  it('jobs: submit runs inline for a small operation and in a worker for a job; result and status read the shared store', () => {
    const store = fresh();
    const inline = totalfinance(['job', 'submit', 'totalfinance.option.price', '--input', '-'], {
      store,
      stdin: JSON.stringify(PRICE),
    });
    expect(inline.code).toBe(CLI_EXIT_CODES.success);
    const record = inline.json as { id: string; state: string; result: { uri: string } };
    expect(record.state).toBe('completed');
    const result = totalfinance(['job', 'result', record.id], { store });
    expect(result.code).toBe(CLI_EXIT_CODES.success);
    expect(result.json).toMatchObject({ operation: { id: 'totalfinance.option.price' } });
    const status = totalfinance(['job', 'status', record.id], { store });
    expect(status.json).toMatchObject({ id: record.id, state: 'completed' });
    const artifact = totalfinance(['artifacts', 'get', record.result.uri], { store });
    expect(artifact.code).toBe(CLI_EXIT_CODES.success);
    expect(artifact.json).toMatchObject({ handle: { uri: record.result.uri, kind: 'report' } });
    expect(totalfinance(['job', 'status', 'missing'], { store }).code).toBe(
      CLI_EXIT_CODES.operationFailed,
    );
    expect(
      totalfinance(['artifacts', 'get', 'totalfinance://reports/sha256:missing'], { store }).code,
    ).toBe(CLI_EXIT_CODES.operationFailed);
    const failed = totalfinance(['job', 'submit', 'totalfinance.option.price', '--input', '-'], {
      store,
      stdin: JSON.stringify({ ...PRICE, spot: -1 }),
    });
    expect(failed.code).toBe(CLI_EXIT_CODES.inputRefused);
    expect((failed.json as { state: string }).state).toBe('failed');
  });

  it('a job cancelled from another process exits 5 and never produces a result', async () => {
    const store = fresh();
    const chains = JSON.stringify(longBacktestInput());
    const child = spawn(
      process.execPath,
      [
        BIN,
        'job',
        'submit',
        'totalfinance.backtest.options_run',
        '--input',
        '-',
        '--profile',
        'full',
        '--follow',
        '--store',
        store,
        // Stage 7B.2 slice 5 (2026-09-06): the 14 MB input must never fail on the transport default
        // budget before the external cancel lands — a failed record is not a cancelled one.
        '--max-input-bytes',
        '16777216',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stdin.end(chains);
    // The first NDJSON line is the accepted/running record; cancel it from THIS process (another one).
    const firstLine = await new Promise<string>((resolveLine) => {
      const check = () => {
        const line = stdout.split('\n')[0];
        if (line && line.trim().length > 0) resolveLine(line);
        else setTimeout(check, 50);
      };
      check();
    });
    const running = JSON.parse(firstLine) as { id: string; state: string };
    expect(['accepted', 'running']).toContain(running.state);
    const cancel = totalfinance(['job', 'cancel', running.id], { store });
    expect(cancel.code).toBe(CLI_EXIT_CODES.success);
    // A job that already terminated cannot be cancelled; when that happens the record's error says
    // why (a worker that could not start under load is the case this has caught), so assert with it.
    const cancelled = cancel.json as { state: string; error?: unknown };
    expect(
      cancelled.state,
      `expected the running job to be cancelled; it was ${cancelled.state}: ${JSON.stringify(cancelled.error ?? null)}`,
    ).toBe('cancelled');
    const code = await new Promise<number>((resolveCode) =>
      child.once('exit', (c) => resolveCode(c ?? -1)),
    );
    expect(code).toBe(CLI_EXIT_CODES.jobCancelled);
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { state: string; result: unknown });
    expect(lines[lines.length - 1]!.state).toBe('cancelled');
    expect(lines[lines.length - 1]!.result).toBeNull();
    expect(totalfinance(['job', 'result', running.id], { store }).code).toBe(
      CLI_EXIT_CODES.jobCancelled,
    );
  }, 60_000);

  it('serve teaches the totalfinance-http invocation and exits 2; doctor reports the floor and the store', () => {
    const store = fresh();
    const serve = totalfinance(['serve', '--http', '--port', '8787'], { store });
    expect(serve.code).toBe(CLI_EXIT_CODES.usage);
    expect(serve.stdout).toBe('');
    expect(serve.stderr).toContain('totalfinance-http --port 8787');
    const doctor = totalfinance(['doctor'], { store });
    expect(doctor.code).toBe(CLI_EXIT_CODES.success);
    expect(doctor.json).toMatchObject({
      node: { meetsFloor: true, floor: '22.13.0' },
      registry: { profile: 'default', operations: 23 },
      store: { directory: store, artifacts: 0, jobs: 0 },
      budgets: { maxInputBytes: 65_536, inlineResultBytes: 262_144 },
    });
  });
});

/**
 * Weekly snapshots over a fixed expiry ladder (every 8 weeks), quotes priced by Black–Scholes so every
 * strike carries a real delta and an entered contract stays quoted — the same builder as the runner
 * tests. Long enough (2,000 weeks) that a cancel lands mid-run.
 */
function longBacktestInput() {
  const T0 = Date.UTC(2026, 0, 5);
  const DAY_MS = 86_400_000;
  const isoDay = (offsetDays: number): string =>
    new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);
  const weeks = 2_000;
  const ladder = Array.from({ length: Math.ceil(weeks / 8) + 2 }, (_, index) => (index + 1) * 56);
  const chains = Array.from({ length: weeks }, (_, index) => {
    const day = index * 7;
    const date = isoDay(day);
    const ts = isoDateToEpochMs(date);
    const spot = 100 + (index % 5);
    const quotes = [];
    for (const expiry of ladder.filter((e) => e > day && e <= day + 70).map(isoDay)) {
      const t = (isoDateToEpochMs(expiry) - ts) / (DAY_MS * 365);
      for (let strike = 80; strike <= 120; strike += 5) {
        for (const type of ['call', 'put'] as const) {
          const pricing = {
            type,
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: 0.04,
            dividendYield: 0,
            volatility: 0.2,
          };
          quotes.push({
            contract: {
              underlying: 'XYZ',
              type,
              style: 'european',
              strike,
              expiry,
              ...resolvedExpiry(expiry),
              multiplier: 100,
            },
            timestampMs: ts,
            mid: blackScholesPrice(pricing),
            impliedVolatility: 0.2,
            greeks: { delta: blackScholesGreeks(pricing).delta },
            underlyingPrice: spot,
          });
        }
      }
    }
    return { asOf: date, underlyingPrice: spot, quotes };
  });
  return {
    chains,
    entry: {
      daysToExpiry: { target: 45, min: 30, max: 60 },
      structure: 'bullPutSpread',
      select: { shortDelta: 0.3, width: 5 },
    },
    exit: { profitTarget: 0.5, daysToExpiry: 21 },
  };
}

export {};
