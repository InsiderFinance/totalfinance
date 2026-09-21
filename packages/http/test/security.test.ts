/** R11/R12: exercise the real HTTP boundary, not just helpers or transport parity. */
import { randomBytes } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import { schema } from '@totalfinance/core/schema';
import { createOperationRegistry, defineOperation, type JobRecord } from '@totalfinance/workflows';
import { registryForProfile, type JobRunner } from '@totalfinance/workflows/local';
import { createLocalHttpServer, openApiDocument, type LocalHttpServer } from '@totalfinance/http';

const token = randomBytes(32).toString('hex');
const bearer = { authorization: `Bearer ${token}` };
const writes = vi.fn();
const approval = defineOperation({
  id: 'totalfinance.test.approve',
  title: 'Approval with a persisted grant',
  description: 'Approval is stateful despite its none sideEffect.',
  inputSchema: schema.object({ value: schema.number() }),
  requiredCapabilities: ['trade:approve'],
  run: (input) => {
    writes();
    return { summary: 'approved', structured: { value: input.value } };
  },
});
const read = defineOperation({
  id: 'totalfinance.test.read',
  title: 'Public analytics',
  description: 'No write authority required.',
  inputSchema: schema.object({ value: schema.number() }),
  run: (input) => ({ summary: 'read', structured: { value: input.value } }),
});
const registry = createOperationRegistry({ operations: [approval, read] });
const runPath = '/operations/totalfinance.test.approve/run';

/** node:http preserves malformed targets and explicit Host, unlike fetch's URL normalizer. */
function wire(
  base: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string | string[]>;
    rawHeaders?: string[];
    body?: string;
    omitHost?: boolean;
  } = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.rawHeaders ?? options.headers ?? {},
        setHost: options.omitHost !== true,
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(text) as Record<string, unknown>,
              headers: res.headers,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('HTTP write safety (R11)', () => {
  let local: LocalHttpServer;
  let base: string;
  beforeAll(async () => {
    local = createLocalHttpServer({
      registry,
      capabilities: ['trade:approve'],
      authenticationToken: token,
      port: 0,
    });
    base = (await local.start()).url;
  });
  afterAll(async () => {
    await local.stop();
  });

  const post = (headers: Record<string, string | string[]> = {}, body = '{"value":7}') =>
    wire(base, runPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer, ...headers },
      body,
    });

  it('refuses writable configuration without a token, including approve with sideEffect none', () => {
    for (const capabilities of [['trade:approve'], ['trade:paper'], ['portfolio:write']]) {
      expect(() =>
        createLocalHttpServer({ registry: registryForProfile({ profile: 'full' }), capabilities }),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.InputMissingField }));
    }
    for (const sideEffect of ['portfolio-state', 'external-order'] as const) {
      const effect = defineOperation({
        id: 'totalfinance.test.effect',
        title: 'Effect',
        description: 'Custom enabled effect.',
        sideEffect,
        inputSchema: schema.object({}),
        run: () => ({ summary: 'effect', structured: {} }),
      });
      expect(() =>
        createLocalHttpServer({ registry: createOperationRegistry({ operations: [effect] }) }),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.InputMissingField }));
    }
    for (const authenticationToken of [
      '',
      'a'.repeat(31),
      'a'.repeat(32) + '\n',
      'ü'.repeat(32),
      'a b'.repeat(32),
    ]) {
      expect(() => createLocalHttpServer({ registry, authenticationToken })).toThrowError(
        expect.objectContaining({ code: ErrorCode.InputWrongShape }),
      );
    }
    expect(() =>
      createLocalHttpServer({ registry, authenticationToken: 42 } as never),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputWrongType }));
    expect(() =>
      createLocalHttpServer({ registry, authenticationToken: randomBytes(24).toString('base64') }),
    ).not.toThrow();
    // Registering a write is not enabling it: default read-only discovery is still useful.
    expect(() => createLocalHttpServer({ registry })).not.toThrow();
  });

  it.each([
    'null',
    'https://untrusted.example',
    'http://untrusted.example',
    'file://',
    'http://localhost',
    'https://localhost',
  ])('refuses origin %s before any write', async (origin) => {
    const before = writes.mock.calls.length;
    const res = await post({ origin }, '{');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: ErrorCode.InputWrongShape,
      context: { field: 'origin' },
    });
    expect(writes).toHaveBeenCalledTimes(before);
    expect((await wire(base, '/capabilities')).status).toBe(200);
  });

  it('checks the actual bound port and rejects ambiguous/forged Host and Origin headers', async () => {
    const url = new URL(base);
    const foreignPort = Number(url.port) === 65535 ? 65534 : Number(url.port) + 1;
    for (const host of [
      `untrusted.example:${url.port}`,
      `127.0.0.1:${foreignPort}`,
      'localhost',
      `localhost:${url.port}@evil.example`,
      `localhost:${url.port}/`,
      `localhost:${url.port},evil.example`,
      `localhost.evil.example:${url.port}`,
      `127.1:${url.port}`,
    ]) {
      expect((await post({ host })).status, host).toBe(403);
    }
    expect((await post({ origin: `http://127.0.0.1:${foreignPort}` })).status).toBe(403);
    expect((await post({ origin: [base, 'http://evil.example'] })).status).toBe(400);
    expect((await wire(base, '/capabilities', { omitHost: true })).status).toBe(400);
    expect(
      (await wire(base, '/capabilities', { rawHeaders: ['Host', url.host, 'Host', url.host] }))
        .status,
    ).toBe(400);
    expect(
      (await post({ host: `localhost:${url.port}`, origin: `http://localhost:${url.port}` }))
        .status,
    ).toBe(200);
    expect((await post({ origin: base })).status).toBe(200);
  });

  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/jsonp',
    '',
  ])('requires application/json, refuses %s', async (contentType) => {
    const before = writes.mock.calls.length;
    const res = await post({ 'content-type': contentType });
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ code: ErrorCode.InputWrongShape });
    expect(writes).toHaveBeenCalledTimes(before);
  });

  it('refuses missing/wrong bearer before JSON parsing and accepts a proper bearer with JSON', async () => {
    const before = writes.mock.calls.length;
    for (const authorization of [
      '',
      'Basic abc',
      `Bearer ${'x'.repeat(token.length)}`,
      `Bearer ${token.slice(1)}`,
      `Bearer ${token}x`,
    ]) {
      const res = await post({ authorization }, '{broken json');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.OperationCapabilityMissing });
      expect(res.headers['www-authenticate']).toContain('Bearer');
      expect(JSON.stringify(res.body)).not.toContain(token);
    }
    const noHeader = await wire(base, runPath, { method: 'POST', body: '{broken' });
    expect(noHeader.status).toBe(401);
    expect(writes).toHaveBeenCalledTimes(before);
    expect((await post({ authorization: [`Bearer ${token}`, `Bearer ${token}`] })).status).toBe(
      400,
    );
    expect((await post({ 'content-type': 'Application/JSON; charset=utf-8' })).status).toBe(200);
    expect(writes).toHaveBeenCalledTimes(before + 1);
    expect((await post({}, '{broken')).status).toBe(400);
  });

  it('keeps read-only calls public on an authenticated server, never advertises secrets, and publishes truthful security', async () => {
    const res = await wire(base, '/operations/totalfinance.test.read/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"value":1}',
    });
    expect(res.status).toBe(200);
    const caps = await wire(base, '/capabilities');
    expect(caps.body).toMatchObject({
      readOnly: false,
      authentication: { configured: true, reads: 'public' },
    });
    const api = await wire(base, '/openapi.json');
    expect(JSON.stringify([caps.body, api.body])).not.toContain(token);
    expect(local.document.servers[0]!.url).toBe(base);
    const document = openApiDocument({ registry: registryForProfile({ profile: 'full' }) });
    expect(document.components.securitySchemes['localBearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const path of [
      '/operations/totalfinance.trade.authorize/run',
      '/operations/totalfinance.trade.submit/run',
      '/operations/totalfinance.trade.cancel/run',
      '/operations/totalfinance.portfolio.record_events/run',
      '/jobs',
      '/jobs/{id}/cancel',
    ]) {
      expect(document.paths[path]?.['post'], path).toMatchObject({
        security: [{ localBearer: [] }],
      });
    }
    expect(document.paths['/operations/totalfinance.option.price/run']!['post']).toMatchObject({
      security: [],
    });
    expect(document.paths['/operations']!['get']).not.toHaveProperty('security');
  });

  it('a bearer does not enable a missing capability; refuses before parsing even malformed JSON', async () => {
    const restricted = createLocalHttpServer({ registry, authenticationToken: token, port: 0 });
    const address = await restricted.start();
    try {
      const res = await wire(address.url, runPath, { method: 'POST', headers: bearer, body: '{' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: ErrorCode.OperationCapabilityMissing,
        context: { field: 'capabilities' },
      });
      expect((await wire(address.url, '/capabilities')).body).toMatchObject({ readOnly: true });
    } finally {
      await restricted.stop();
    }
  });
});

describe('HTTP jobs are persistent mutations, including analytics jobs (R11)', () => {
  const record = { id: 'job-1', state: 'queued' } as JobRecord;
  const cancel = vi.fn(() => record);
  const submit = vi.fn<JobRunner['submit']>(() => ({
    record,
    completion: Promise.resolve(record),
    cancel: async () => record,
  }));
  const jobs: JobRunner = { submit, cancel, get: () => record, list: () => [record] };

  it('requires auth before parsing, creation and cancellation; public reads and inline analytics still work', async () => {
    const local = createLocalHttpServer({ registry, jobs, authenticationToken: token, port: 0 });
    const { url } = await local.start();
    try {
      for (const path of ['/jobs', '/jobs/job-1/cancel']) {
        const res = await wire(url, path, { method: 'POST', body: '{' });
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.OperationCapabilityMissing });
      }
      expect(submit).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(
        (await wire(url, '/jobs', { method: 'POST', headers: bearer, body: '{}' })).status,
      ).toBe(415);
      const created = await wire(url, '/jobs', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ id: read.id, input: { value: 3 } }),
      });
      expect(created.status).toBe(202);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await wire(url, '/jobs/job-1')).status).toBe(200);
      expect(
        (await wire(url, '/jobs/job-1/cancel', { method: 'POST', headers: bearer })).status,
      ).toBe(200);
      expect(cancel).toHaveBeenCalledTimes(1);
      // The injected runner cannot be used to bypass the HTTP server's capability ceiling.
      const denied = await wire(url, '/jobs', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ id: approval.id, input: {} }),
      });
      expect(denied.status).toBe(403);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await local.stop();
    }
  });

  it('with no token attaches a read-only job store without exposing creation or cancellation', async () => {
    const local = createLocalHttpServer({ registry, jobs, port: 0 });
    const { url } = await local.start();
    try {
      expect((await wire(url, '/capabilities')).body).toMatchObject({
        jobs: true,
        jobMutations: false,
        readOnly: true,
      });
      expect((await wire(url, '/jobs/job-1')).status).toBe(200);
      for (const path of ['/jobs', '/jobs/job-1/cancel']) {
        const res = await wire(url, path, { method: 'POST', headers: bearer });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.OperationCapabilityMissing });
      }
      expect(
        (
          await wire(url, '/operations/totalfinance.test.read/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"value":1}',
          })
        ).status,
      ).toBe(200);
    } finally {
      await local.stop();
    }
  });
});

describe('HTTP malformed targets survive (R12)', () => {
  let local: LocalHttpServer;
  let base: string;
  beforeAll(async () => {
    local = createLocalHttpServer({ registry, port: 0 });
    base = (await local.start()).url;
  });
  afterAll(async () => {
    await local.stop();
  });

  it('the outer promise boundary survives an exception while rendering an error response', async () => {
    const context: Record<string, unknown> = {};
    context['cycle'] = context;
    const failing = createLocalHttpServer({
      registry,
      port: 0,
      artifacts: {
        get: () => {
          throw new InputError('unserializable injected store error', {
            code: ErrorCode.InputWrongShape,
            context,
          });
        },
        list: () => [],
      },
    });
    const address = await failing.start();
    try {
      const res = await wire(address.url, '/artifacts/totalfinance%3A%2F%2Freports%2Fexample');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        code: ErrorCode.OperationInternal,
        message: 'Unexpected HTTP handler failure.',
      });
      expect((await wire(address.url, '/capabilities')).status).toBe(200);
    } finally {
      await failing.stop();
    }
  });

  it.each([
    '/%',
    '/%ZZ',
    '/%C0%AF',
    '/%E0%A4%A',
    '/operations/%2F/run',
    '/jobs/a%2Fb/cancel',
    '/%5c',
    '/%00',
    '/%2e%2e/capabilities',
    '/capabilities?q=%',
    '//evil.example/capabilities',
    'http://evil.example/capabilities',
    'http://[::1',
    '/path#fragment',
    '*',
  ])('refuses %s and serves the next request', async (target) => {
    const res = await wire(base, target);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: ErrorCode.InputWrongShape });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect((await wire(base, '/capabilities')).status).toBe(200);
  });

  it.each(['::1', '[::1]'])(
    'binds and advertises bracket-correct IPv6 %s, and checks its port',
    async (host) => {
      const ipv6 = createLocalHttpServer({ registry, host, port: 0 });
      const address = await ipv6.start();
      try {
        expect(address.url).toBe(`http://[::1]:${address.port}`);
        expect(ipv6.document.servers[0]!.url).toBe(address.url);
        expect(
          (await wire(address.url, '/capabilities', { headers: { origin: address.url } })).status,
        ).toBe(200);
        expect(
          (
            await wire(address.url, '/capabilities', {
              headers: { host: `[::1]:${address.port === 65535 ? 65534 : address.port + 1}` },
            })
          ).status,
        ).toBe(403);
        expect((await wire(address.url, '/%')).status).toBe(400);
        expect((await wire(address.url, '/capabilities')).status).toBe(200);
      } finally {
        await ipv6.stop();
      }
    },
  );
});
