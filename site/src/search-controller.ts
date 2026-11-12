import { search, type SearchRecord } from './search';

/**
 * Framework-free search state machine shared by the ⌘K dialog and the full search page.
 *
 * - One lazy fetch and JSON parse is shared by concurrent queries; success is cached.
 * - A network, HTTP, JSON or malformed-record failure clears the cache, so the next user action
 *   retries (no automatic retry storm).
 * - Every new input invalidates pending results immediately, even inside the debounce window;
 *   clearing the query can never be overwritten by a late success or failure.
 * - Submitting cancels a pending debounce and searches at once.
 */
export type SearchState =
  | { status: 'idle'; query: ''; results: [] }
  | { status: 'loading'; query: string; results: SearchRecord[] }
  | { status: 'ready'; query: string; results: SearchRecord[] }
  | { status: 'error'; query: string; results: [] };

export interface SearchControllerOptions {
  /** URL of the version-pinned search index. */
  indexUrl: string;
  onChange: (state: SearchState) => void;
  debounceMs?: number;
  limit?: number;
  fetch?: typeof globalThis.fetch;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function isSearchRecord(record: unknown): record is SearchRecord {
  if (!record || typeof record !== 'object') return false;
  const value = record as Record<string, unknown>;
  return (
    ['title', 'url', 'description', 'category', 'keywords'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    (!('kind' in value) || typeof value['kind'] === 'string')
  );
}

export function createSearchController(options: SearchControllerOptions) {
  const fetchIndex = options.fetch ?? ((input: RequestInfo | URL) => globalThis.fetch(input));
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as number));
  const debounceMs = options.debounceMs ?? 120;
  let indexRequest: Promise<SearchRecord[]> | undefined;
  let generation = 0;
  let timer: unknown;
  let query = '';
  let last: SearchRecord[] = [];

  const loadIndex = () => {
    indexRequest ??= Promise.resolve(fetchIndex(options.indexUrl))
      .then(async (response) => {
        if (!response.ok) throw new Error('Search index unavailable');
        const records: unknown = await response.json();
        if (!Array.isArray(records) || !records.every(isSearchRecord))
          throw new Error('Search index malformed');
        return records;
      })
      .catch((error: unknown) => {
        indexRequest = undefined;
        throw error;
      });
    return indexRequest;
  };

  const perform = async () => {
    const current = ++generation;
    const text = query.trim();
    if (!text) {
      last = [];
      options.onChange({ status: 'idle', query: '', results: [] });
      return;
    }
    options.onChange({ status: 'loading', query: text, results: last });
    try {
      const index = await loadIndex();
      if (current !== generation) return;
      last = search(index, text, options.limit ?? 30);
      options.onChange({ status: 'ready', query: text, results: last });
    } catch {
      if (current !== generation) return;
      last = [];
      options.onChange({ status: 'error', query: text, results: [] });
    }
  };

  return {
    /** Start downloading the index early (e.g. when the dialog opens). Failures are silent. */
    preload() {
      loadIndex().catch(() => undefined);
    },
    setQuery(value: string) {
      query = value;
      // Invalidate any outstanding search immediately, not after the debounce expires.
      generation += 1;
      clearTimer(timer);
      if (!value.trim()) {
        void perform();
        return;
      }
      timer = setTimer(() => void perform(), debounceMs);
    },
    submit() {
      clearTimer(timer);
      return perform();
    },
    dispose() {
      generation += 1;
      clearTimer(timer);
    },
  };
}
