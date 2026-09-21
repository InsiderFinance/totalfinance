import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchRecord } from '../src/search.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
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
const response = () => new Response(JSON.stringify(records));
const settle = () => vi.advanceTimersByTimeAsync(0);

async function setup(fetchMock: ReturnType<typeof vi.fn>, query = '', base = '') {
  vi.useFakeTimers();
  const handlers = new Map<string, () => void>();
  const input = {
    value: '',
    addEventListener: (name: string, callback: () => void) => handlers.set(name, callback),
  };
  const results = {
    innerHTML: '',
    replaceChildren() {
      this.innerHTML = '';
    },
  };
  const status = { textContent: '' };
  let submit!: (event: { preventDefault(): void }) => void;
  const form = {
    querySelector: () => input,
    addEventListener: (_event: string, callback: typeof submit) => {
      submit = callback;
    },
  };
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    querySelectorAll: () => [],
    documentElement: { dataset: { base } },
    querySelector: (selector: string) =>
      selector === '[data-search-form]'
        ? form
        : selector === '[data-search-results]'
          ? results
          : status,
  });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('location', { search: query });
  vi.stubGlobal('fetch', fetchMock);
  await import('../src/client.js');
  return {
    results,
    status,
    input,
    submit(value: string) {
      input.value = value;
      submit({ preventDefault() {} });
    },
    type(value: string) {
      input.value = value;
      handlers.get('input')!();
    },
  };
}

describe('search loading (mock document, not visual browser verification)', () => {
  it('shares one in-flight fetch and JSON parse, renders only the latest query, and caches success', async () => {
    const pending = deferred<Response>();
    const json = deferred<SearchRecord[]>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    const page = await setup(fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    page.submit('older');
    page.submit('newer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const parse = vi.fn().mockReturnValue(json.promise);
    pending.resolve({ ok: true, json: parse } as unknown as Response);
    await settle();
    page.submit('newer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    json.resolve(records);
    await settle();
    expect(page.results.innerHTML).toContain('newer');
    expect(page.results.innerHTML).not.toContain('older');
    expect(page.results.innerHTML).toContain('function · API');
    page.submit('older');
    await settle();
    expect(page.results.innerHTML).toContain('older');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'http', 'json', 'shape', 'record'] as const)(
    'allows retry after a shared %s failure',
    async (failure) => {
      const pending = deferred<Response>();
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(response());
      const page = await setup(fetchMock);
      page.submit('older');
      page.submit('newer');
      if (failure === 'network') pending.reject(new Error('Offline'));
      else
        pending.resolve(
          failure === 'http'
            ? new Response('', { status: 503 })
            : failure === 'shape'
              ? new Response('{"error":"temporarily unavailable"}')
              : failure === 'record'
                ? new Response(JSON.stringify([{ ...records[0], title: null }]))
                : new Response('invalid json'),
        );
      await settle();
      expect(page.status.textContent).toContain('Search could not load');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      page.submit('newer');
      await settle();
      expect(page.results.innerHTML).toContain('newer');
      expect(page.status.textContent).toContain('1 result shown');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('invalidates a result as soon as input changes, including during the debounce window', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    const page = await setup(fetchMock);
    page.submit('older');
    page.type('newer');
    pending.resolve(response());
    await settle();
    expect(page.results.innerHTML).toBe('');
    await vi.advanceTimersByTimeAsync(120);
    expect(page.results.innerHTML).toContain('newer');
    expect(page.results.innerHTML).not.toContain('older');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'clearing the query immediately ignores a pending %s',
    async (outcome) => {
      const pending = deferred<Response>();
      const fetchMock = vi.fn().mockReturnValue(pending.promise);
      const page = await setup(fetchMock);
      page.submit('older');
      page.type('');
      expect(page.status.textContent).toContain('Search functions');
      if (outcome === 'resolve') pending.resolve(response());
      else pending.reject(new Error('Offline'));
      await settle();
      expect(page.results.innerHTML).toBe('');
      expect(page.status.textContent).toContain('Search functions');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('submitting cancels the queued debounce so a failed load is not retried without a new action', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Offline'));
    const page = await setup(fetchMock);
    page.type('newer');
    page.submit('newer');
    await vi.advanceTimersByTimeAsync(120);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.status.textContent).toContain('Search could not load');
  });

  it('uses the version-pinned index for URL queries and retains honest empty results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const page = await setup(fetchMock, '?q=newer', '/versions/0.1.0-preview.0');
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/versions/0.1.0-preview.0/search-index.json');
    expect(page.results.innerHTML).toContain('newer');
    page.submit('absent');
    await settle();
    expect(page.results.innerHTML).toBe('');
    expect(page.status.textContent).toContain('No matches');
  });

  it('escapes index text and supports legacy records without kind metadata', async () => {
    const legacy = {
      title: 'newer <img src=x>',
      description: '<script>example</script>',
      category: 'API & types',
      url: '/reference/?q="example"',
      keywords: 'newer',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([legacy])));
    const page = await setup(fetchMock, '?q=newer');
    await settle();
    expect(page.results.innerHTML).toContain('&lt;img src=x&gt;');
    expect(page.results.innerHTML).toContain('&lt;script&gt;');
    expect(page.results.innerHTML).toContain('API &amp; types');
    expect(page.results.innerHTML).toContain('&quot;example&quot;');
    expect(page.results.innerHTML).not.toContain('<img');
    expect(page.results.innerHTML).not.toContain('undefined');
  });
});
