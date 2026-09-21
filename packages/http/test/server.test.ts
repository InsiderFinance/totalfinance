/**
 * Stage 7A slice 5 — the local HTTP server, in process: every route's success and error bodies, the
 * status mapping, X-Request-Id, the wire byte budget, loopback-only binding, jobs and artifacts.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDateToEpochMs, resolvedExpiry } from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { ErrorCode, QuantError } from '@totalfinance/core';
import {
  createLocalJobRunner,
  createFileArtifactStore,
  registryForProfile,
} from '@totalfinance/workflows/local';
import { createLocalHttpServer, openApiDocument, statusForError } from '@totalfinance/http';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};

const PRICE = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};

describe('the local HTTP server', () => {
  const directory = mkdtempSync(join(tmpdir(), 'totalfinance-http-'));
  const registry = registryForProfile({ profile: 'full' });
  const clock = () => new Date().toISOString();
  const authenticationToken = randomBytes(32).toString('hex');
  const local = createLocalHttpServer({
    registry,
    artifacts: createFileArtifactStore({ directory }),
    jobs: createLocalJobRunner({ registry, directory, profile: 'full', clock, pollMs: 25 }),
    port: 0,
    budgets: { maxInputBytes: 16_777_216, defaultSeed: 11 },
    clock,
    authenticationToken,
  });
  let base = '';
  beforeAll(async () => {
    base = (await local.start()).url;
  });
  afterAll(async () => {
    await local.stop();
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authenticationToken}`,
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      requestId: response.headers.get('x-request-id'),
      json: text ? (JSON.parse(text) as unknown) : null,
    };
  };

  it('serves the OpenAPI document, the capabilities, and the descriptions', async () => {
    const openapi = await call('GET', '/openapi.json');
    expect(openapi.status).toBe(200);
    expect(openapi.json).toMatchObject({ openapi: '3.1.0' });
    expect(JSON.stringify(openapi.json)).toBe(JSON.stringify(local.document));
    const capabilities = await call('GET', '/capabilities');
    // 40 → 46 (Stage 7B.2 slice 4, 2026-09-06): the six trade-lifecycle operations join the full profile.
    expect(capabilities.json).toMatchObject({
      operations: 46,
      jobs: true,
      artifacts: 'writable',
      readOnly: false,
      jobMutations: true,
      budgets: { maxInputBytes: 16_777_216, defaultSeed: 11 },
    });
    const list = await call('GET', '/operations');
    // 40 → 46 (Stage 7B.2 slice 4, 2026-09-06): the six trade-lifecycle operations join the full profile.
    expect((list.json as unknown[]).length).toBe(46);
    const one = await call('GET', '/operations/totalfinance.option.price');
    expect(one.json).toMatchObject({
      id: 'totalfinance.option.price',
      annotations: { readOnlyHint: true },
    });
    const missing = await call('GET', '/operations/totalfinance.nope.x');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: 'operation.unknown' });
  });

  it('runs an operation; refusals map to statuses with the OperationError body; X-Request-Id round-trips', async () => {
    const ok = await call('POST', '/operations/totalfinance.option.price/run', PRICE, {
      'x-request-id': 'req-42',
    });
    expect(ok.status).toBe(200);
    expect(ok.requestId).toBe('req-42');
    expect(ok.json).toMatchObject({
      operation: { id: 'totalfinance.option.price' },
      trace: { requestId: 'req-42' },
    });
    const generated = await call('POST', '/operations/totalfinance.option.price/run', PRICE);
    expect(generated.requestId).toMatch(/[0-9a-f-]{36}/);
    const refused = await call('POST', '/operations/totalfinance.option.price/run', {
      ...PRICE,
      spot: -1,
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({
      code: expect.stringMatching(/^input\./),
      operation: { id: 'totalfinance.option.price' },
    });
    const malformed = await call('POST', '/operations/totalfinance.option.price/run', '{not json');
    expect(malformed.status).toBe(400);
    const unknown = await call('POST', '/operations/totalfinance.nope.x/run', PRICE);
    expect(unknown.status).toBe(404);
    // The wire budget: a dedicated tiny-budget server proves the 413 without a multi-megabyte body.
    const tiny = createLocalHttpServer({ registry, port: 0, budgets: { maxInputBytes: 256 } });
    const tinyUrl = (await tiny.start()).url;
    try {
      const tooBig = await fetch(`${tinyUrl}/operations/totalfinance.option.price/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...PRICE, padding: 'x'.repeat(2_000) }),
      });
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toMatchObject({ code: 'operation.input_too_large' });
      const fits = await fetch(`${tinyUrl}/operations/totalfinance.option.price/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PRICE),
      });
      expect(fits.status).toBe(200);
    } finally {
      await tiny.stop();
    }
    const seeded = await call('POST', '/operations/totalfinance.risk.value_at_risk/run', {
      returns: [0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.003, -0.004],
      method: 'monteCarlo',
    });
    expect(seeded.status).toBe(200);
    expect((seeded.json as { assumptions: { seed: number } }).assumptions.seed).toBe(11);
    const route = await call('GET', '/nowhere');
    expect(route.status).toBe(404);
    expect(route.json).toMatchObject({ code: 'operation.unknown' });
  });

  it('jobs: submit, poll, result, cancel; artifacts by uri', async () => {
    const submitted = await call('POST', '/jobs', {
      id: 'totalfinance.option.price',
      input: PRICE,
    });
    expect(submitted.status).toBe(202);
    const record = submitted.json as { id: string; state: string; result: { uri: string } };
    expect(record.state).toBe('completed'); // inline for a small operation
    const status = await call('GET', `/jobs/${record.id}`);
    expect(status.json).toMatchObject({ id: record.id, state: 'completed' });
    const result = await call('GET', `/jobs/${record.id}/result`);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ operation: { id: 'totalfinance.option.price' } });
    const artifact = await call('GET', `/artifacts/${encodeURIComponent(record.result.uri)}`);
    expect(artifact.status).toBe(200);
    expect(artifact.json).toMatchObject({ handle: { uri: record.result.uri } });
    expect((await call('GET', '/jobs/missing')).status).toBe(404);
    expect(
      (
        await call(
          'GET',
          `/artifacts/${encodeURIComponent('totalfinance://reports/sha256:missing')}`,
        )
      ).status,
    ).toBe(404);
    const badShape = await call('POST', '/jobs', { id: 'totalfinance.option.price' });
    expect(badShape.status).toBe(400);
    const unknownField = await call('POST', '/jobs', {
      id: 'totalfinance.option.price',
      input: PRICE,
      extra: 1,
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.json).toMatchObject({ code: 'input.unknown_field' });
    // A long job-class run, cancelled through the API — the result route says so with 409.
    const long = await call('POST', '/jobs', {
      id: 'totalfinance.backtest.options_run',
      input: longBacktestInput(),
    });
    expect(long.status).toBe(202);
    const job = long.json as { id: string; state: string };
    expect(['accepted', 'running']).toContain(job.state);
    const cancelled = await call('POST', `/jobs/${job.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((cancelled.json as { state: string }).state).toBe('cancelled');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = (await call('GET', `/jobs/${job.id}`)).json as {
        state: string;
        usage: { elapsedMs: number | null };
      };
      if (current.usage.elapsedMs !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const conflict = await call('GET', `/jobs/${job.id}/result`);
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ code: 'operation.cancelled' });
  }, 60_000);

  it('binds loopback only unless told otherwise, closes its doors, and maps every code', () => {
    expect(codeOf(() => createLocalHttpServer({ registry, host: '0.0.0.0' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(() =>
      createLocalHttpServer({ registry, host: '0.0.0.0', allowNonLoopback: true }),
    ).not.toThrow();
    expect(codeOf(() => createLocalHttpServer({ registry, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => createLocalHttpServer({ registry, port: 70_000 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => createLocalHttpServer({ registry, budgets: { maxInputBytes: 0 } }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => createLocalHttpServer({ registry, budgets: { nope: 1 } } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => createLocalHttpServer({ registry, jobs: {} } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => createLocalHttpServer({ registry: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    const doc = { code: '', message: '', context: {}, operation: { id: 'x', version: '1' } };
    expect(statusForError({ ...doc, code: 'operation.unknown' } as never)).toBe(404);
    expect(statusForError({ ...doc, code: 'operation.handle_unknown' } as never)).toBe(404);
    expect(statusForError({ ...doc, code: 'operation.input_too_large' } as never)).toBe(413);
    expect(statusForError({ ...doc, code: 'operation.cancelled' } as never)).toBe(409);
    expect(statusForError({ ...doc, code: 'operation.internal' } as never)).toBe(500);
    expect(statusForError({ ...doc, code: 'input.wrong_type' } as never)).toBe(400);
    expect(statusForError({ ...doc, code: 'backtest.mark_unavailable' } as never)).toBe(422);
  });

  it('a server without stores answers jobs and artifacts with a teaching, and the OpenAPI document is deterministic', async () => {
    const bare = createLocalHttpServer({
      registry: registryForProfile({ profile: 'options' }),
      port: 0,
    });
    const bound = await bare.start();
    try {
      const jobs = await fetch(`${bound.url}/jobs`, {
        method: 'POST',
        body: JSON.stringify({ id: 'totalfinance.option.price', input: PRICE }),
      });
      expect(jobs.status).toBe(404);
      expect(await jobs.json()).toMatchObject({
        code: 'operation.unknown',
        message: expect.stringContaining('no job runner'),
      });
      const artifacts = await fetch(
        `${bound.url}/artifacts/${encodeURIComponent('totalfinance://reports/sha256:x')}`,
      );
      expect(artifacts.status).toBe(422);
      expect(await artifacts.json()).toMatchObject({ code: 'operation.handle_store_missing' });
    } finally {
      await bare.stop();
    }
    const a = JSON.stringify(openApiDocument({ registry }));
    const b = JSON.stringify(
      openApiDocument({ registry: registryForProfile({ profile: 'full' }) }),
    );
    expect(a).toBe(b);
    expect(codeOf(() => openApiDocument({ registry, serverUrl: 'ftp://x' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => openApiDocument({ registry, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });
});

/**
 * Weekly snapshots over a fixed expiry ladder (every 8 weeks), quotes priced by Black–Scholes so every
 * strike carries a real delta and an entered contract stays quoted — the same builder as the runner
 * tests. Long enough (1500 weeks) that a cancel lands mid-run.
 */
function longBacktestInput() {
  const T0 = Date.UTC(2026, 0, 5);
  const DAY_MS = 86_400_000;
  const isoDay = (offsetDays: number): string =>
    new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);
  const weeks = 1500;
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
