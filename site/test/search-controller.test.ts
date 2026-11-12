import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchController, type SearchState } from '../src/search-controller.js';
import type { SearchRecord } from '../src/search.js';

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const records: SearchRecord[] = ['older', 'newer'].map((title) => ({
  title,
  url: `/reference/#${title}`,
  description: title,
  category: 'API',
  keywords: title,
  kind: 'function',
}));
const response = (body: unknown = records) => new Response(JSON.stringify(body));
const settle = () => vi.advanceTimersByTimeAsync(0);

function setup(fetchMock: (input: RequestInfo | URL) => Promise<Response>) {
  vi.useFakeTimers();
  const states: SearchState[] = [];
  const controller = createSearchController({
    indexUrl: '/docs/totalfinance/search-index.json',
    onChange: (state) => states.push(state),
    fetch: fetchMock,
  });
  return { controller, states, last: () => states.at(-1)! };
}

describe('search controller (dialog and search page share it)', () => {
  it('shares one lazy download across concurrent queries and caches success', async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn(() => request.promise);
    const page = setup(fetchMock);
    page.controller.setQuery('older');
    await vi.advanceTimersByTimeAsync(150);
    page.controller.setQuery('newer');
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/docs/totalfinance/search-index.json');
    request.resolve(response());
    await settle();
    expect(page.last()).toMatchObject({ status: 'ready', query: 'newer' });
    expect(page.last().results.map((record) => record.title)).toEqual(['newer']);
    page.controller.setQuery('older');
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.last().results.map((record) => record.title)).toEqual(['older']);
  });

  it('retries on the next user action after network, HTTP, JSON or malformed failures, without a retry storm', async () => {
    for (const failure of [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(new Response('nope', { status: 500 })),
      () => Promise.resolve(new Response('{not json')),
      () => Promise.resolve(response([{ title: 1 }])),
    ]) {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(failure)
        .mockImplementation(() => Promise.resolve(response()));
      const page = setup(fetchMock);
      page.controller.setQuery('older');
      await vi.advanceTimersByTimeAsync(150);
      await settle();
      expect(page.last().status).toBe('error');
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      page.controller.setQuery('older ');
      await vi.advanceTimersByTimeAsync(150);
      await settle();
      expect(page.last()).toMatchObject({ status: 'ready' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('a new input invalidates pending results immediately, even inside the debounce window', async () => {
    const request = deferred<Response>();
    const page = setup(vi.fn(() => request.promise));
    page.controller.setQuery('older');
    await vi.advanceTimersByTimeAsync(150);
    page.controller.setQuery('newer');
    request.resolve(response());
    await settle();
    expect(
      page.states.filter((state) => state.status === 'ready' && state.query === 'older'),
    ).toEqual([]);
  });

  it('clearing the query cannot be overwritten by a late success or failure', async () => {
    for (const settleWith of ['success', 'failure'] as const) {
      const request = deferred<Response>();
      const page = setup(vi.fn(() => request.promise));
      page.controller.setQuery('older');
      await vi.advanceTimersByTimeAsync(150);
      page.controller.setQuery('');
      await settle();
      if (settleWith === 'success') request.resolve(response());
      else request.reject(new Error('late'));
      await settle();
      expect(page.last()).toEqual({ status: 'idle', query: '', results: [] });
    }
  });

  it('submit cancels the pending debounce and searches at once; dispose silences everything', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response()));
    const page = setup(fetchMock);
    page.controller.setQuery('newer');
    await page.controller.submit();
    expect(page.last()).toMatchObject({ status: 'ready', query: 'newer' });
    const count = page.states.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(page.states.length).toBe(count);
    page.controller.setQuery('older');
    page.controller.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(page.states.length).toBe(count);
  });
});
