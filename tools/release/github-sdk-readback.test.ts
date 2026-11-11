import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NPMJS, type ReleaseArtifact } from './artifact-policy.js';
import { waitForSdkReadback } from './github-sdk-readback.js';
import { fixtureMetadata } from './test-fixtures.js';
import { PUBLIC_PACKAGE_NAME } from '../public-packages.js';

const bytes = 'synthetic approved SDK bytes';
const sdk: ReleaseArtifact = {
  package: PUBLIC_PACKAGE_NAME,
  version: '0.1.0',
  tarball: 'insiderfinance-totalfinance-0.1.0.tgz',
  bytes: Buffer.byteLength(bytes),
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const packageUrl = `${NPMJS}/${encodeURIComponent(sdk.package)}`;
const tarballUrl = `${NPMJS}/sdk.tgz`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registry(state: { present: boolean; latest?: string; body?: string; status?: number }) {
  const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (state.status) return new Response('', { status: state.status });
    if (url === packageUrl)
      return Response.json({ 'dist-tags': state.latest ? { latest: state.latest } : {} });
    if (url === `${packageUrl}/${sdk.version}`)
      return state.present
        ? Response.json({ ...fixtureMetadata(), dist: { tarball: tarballUrl } })
        : new Response('', { status: 404 });
    if (url === tarballUrl) return new Response(state.body ?? bytes);
    throw new Error(`Unexpected registry request: ${url}`);
  });
  vi.stubGlobal('fetch', request);
  return request;
}

describe('accepted npm uploads wait for public readback without publishing again', () => {
  it('returns immediately when exact bytes and latest are ready', async () => {
    registry({ present: true, latest: sdk.version });
    expect(await waitForSdkReadback(sdk, NPMJS)).toEqual({ latest: sdk.version });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives the actual accepted-but-not-visible response before requiring exact bytes and latest', async () => {
    const state = { present: false, latest: '0.0.9' };
    const request = registry(state);
    const result = waitForSdkReadback(sdk, NPMJS);
    await vi.advanceTimersByTimeAsync(15_000);
    state.present = true;
    await vi.advanceTimersByTimeAsync(15_000);
    state.latest = sdk.version;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ latest: sdk.version });
    expect(
      request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not declare success from a ready tag whose SDK bytes are still absent', async () => {
    const state = { present: false, latest: sdk.version };
    registry(state);
    const result = waitForSdkReadback(sdk, NPMJS);
    await vi.advanceTimersByTimeAsync(15_000);
    state.present = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ latest: sdk.version });
  });

  it('stops after the 15-minute processing deadline and preserves the original-run recovery path', async () => {
    const request = registry({ present: false });
    const failure = expect(waitForSdkReadback(sdk, NPMJS)).rejects.toThrow('after 15 minutes');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await failure;
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/0.1.0'))).toHaveLength(61);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses changed registry bytes immediately rather than treating corruption as processing', async () => {
    registry({ present: true, latest: sdk.version, body: 'different bytes' });
    await expect(waitForSdkReadback(sdk, NPMJS)).rejects.toThrow('Registry bytes differ');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 500])(
    'does not hide registry HTTP %s failures behind a processing retry',
    async (status) => {
      registry({ present: false, status });
      await expect(waitForSdkReadback(sdk, NPMJS)).rejects.toThrow(`(${status})`);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('refuses a newer latest while waiting instead of reporting a stale release as current', async () => {
    registry({ present: true, latest: '0.1.1' });
    await expect(waitForSdkReadback(sdk, NPMJS)).rejects.toThrow('newer npm latest');
    expect(vi.getTimerCount()).toBe(0);
  });
});
