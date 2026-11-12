'use client';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createSearchController, type SearchState } from '@/src/search-controller';
import { SearchResultContent, searchBase } from './search-dialog';

/** Full-page search (works with `?q=`), sharing the dialog's engine and ranking. */
export function SearchPage() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle', query: '', results: [] });
  const controller = useMemo(
    () =>
      typeof window === 'undefined'
        ? null
        : createSearchController({
            indexUrl: `${searchBase()}/search-index.json`,
            onChange: setState,
            limit: 50,
          }),
    [],
  );
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('q') ?? '';
    if (initial) {
      setQuery(initial);
      controller?.setQuery(initial);
      void controller?.submit();
    }
    return () => controller?.dispose();
  }, [controller]);
  return (
    <div>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          window.history.replaceState(
            null,
            '',
            query ? `?q=${encodeURIComponent(query)}` : window.location.pathname,
          );
          void controller?.submit();
        }}
        className="flex items-center gap-2 rounded-xl border border-fd-border bg-fd-background px-3 focus-within:border-fd-primary focus-within:ring-2 focus-within:ring-fd-ring/20"
      >
        <Search className="size-5 text-fd-muted-foreground" aria-hidden />
        <label htmlFor="tf-search-query" className="sr-only">
          Search calculators, guides, functions, types and operations
        </label>
        <input
          id="tf-search-query"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            controller?.setQuery(event.target.value);
          }}
          placeholder="Try blackScholes, discounted cash flow, or portfolio P&L…"
          className="h-12 min-w-0 flex-1 bg-transparent outline-none"
          autoComplete="off"
        />
        <button
          type="submit"
          className="rounded-lg bg-fd-primary px-3 py-1.5 text-sm font-semibold text-fd-primary-foreground"
        >
          Search
        </button>
      </form>
      <p role="status" className="mt-3 text-sm text-fd-muted-foreground">
        {state.status === 'idle'
          ? 'Search functions, types, calculators, guides or financial concepts.'
          : state.status === 'loading'
            ? 'Searching…'
            : state.status === 'error'
              ? 'Search could not load. The reference and guides remain available from the navigation.'
              : state.results.length
                ? `${state.results.length} ${state.results.length === 1 ? 'result' : 'results'}. Refine your search to narrow the list.`
                : 'No matches. Try a full function name, a package, or a shorter finance term.'}
      </p>
      <ul className="mt-4 space-y-1">
        {state.results.map((record, index) => (
          <li key={`${record.url}-${index}`}>
            <Link
              href={record.url}
              className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-fd-muted"
            >
              <SearchResultContent record={record} />
            </Link>
          </li>
        ))}
      </ul>
      <noscript>
        <p>
          Search needs JavaScript. Browse the <a href="../reference/">complete reference</a> without
          it.
        </p>
      </noscript>
    </div>
  );
}
