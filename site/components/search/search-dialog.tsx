'use client';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BookOpen,
  Box,
  Braces,
  Calculator,
  CornerDownLeft,
  FileText,
  Loader2,
  Search,
  Workflow,
} from 'lucide-react';
import type { SharedProps } from 'fumadocs-ui/contexts/search';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createSearchController, type SearchState } from '@/src/search-controller';
import type { SearchRecord } from '@/src/search';
import { BASE_PATH } from '@/lib/site';

/** The version-pinned index lives beside the page's own base (a snapshot searches itself). */
export function searchBase(): string {
  if (typeof document === 'undefined') return BASE_PATH;
  return document.documentElement.dataset['tfBase'] ?? BASE_PATH;
}

const SUGGESTIONS: { title: string; query: string }[] = [
  { title: 'Price an option', query: 'price an option' },
  { title: 'Black–Scholes', query: 'black scholes' },
  { title: 'Backtest a strategy', query: 'backtest a strategy' },
  { title: 'RSI', query: 'rsi' },
  { title: 'Value at risk', query: 'value at risk' },
  { title: 'Connect an agent', query: 'connect an agent' },
];

const KIND_LABEL: Record<string, string> = {
  task: 'Calculator',
  guide: 'Guide',
  function: 'Function',
  value: 'Value',
  class: 'Class',
  interface: 'Interface',
  type: 'Type',
  namespace: 'Namespace',
  entrypoint: 'Entry point',
  operation: 'Operation',
};

export function kindIcon(kind: string | undefined): ReactNode {
  const className = 'size-4 shrink-0';
  switch (kind) {
    case 'task':
      return <Calculator className={className} aria-hidden />;
    case 'guide':
      return <BookOpen className={className} aria-hidden />;
    case 'function':
    case 'value':
    case 'class':
      return <Braces className={className} aria-hidden />;
    case 'entrypoint':
      return <Box className={className} aria-hidden />;
    case 'operation':
      return <Workflow className={className} aria-hidden />;
    default:
      return <FileText className={className} aria-hidden />;
  }
}

export function kindLabel(kind: string | undefined): string {
  return (kind && KIND_LABEL[kind]) || 'Page';
}

export function SearchResultContent({ record }: { record: SearchRecord }) {
  return (
    <>
      <span className="mt-0.5 text-fd-muted-foreground">{kindIcon(record.kind)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium text-fd-foreground">{record.title}</span>
          <span className="shrink-0 rounded bg-fd-secondary px-1.5 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-fd-muted-foreground">
            {kindLabel(record.kind)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-fd-muted-foreground">
          {record.category !== 'Guide' && record.category !== 'Runnable task'
            ? `${record.category} — `
            : ''}
          {record.description}
        </span>
      </span>
    </>
  );
}

export function TfSearchDialog({ open, onOpenChange }: SharedProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle', query: '', results: [] });
  const [active, setActive] = useState(0);
  const controller = useMemo(
    () =>
      typeof window === 'undefined'
        ? null
        : createSearchController({
            indexUrl: `${searchBase()}/search-index.json`,
            onChange: setState,
            limit: 30,
          }),
    [],
  );
  useEffect(() => () => controller?.dispose(), [controller]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      controller?.preload();
      requestAnimationFrame(() => input.current?.select());
    }
    if (!open && element.open) element.close();
  }, [open, controller]);

  const results = state.results;
  useEffect(() => setActive(0), [state.query]);

  const go = (url: string, newTab = false) => {
    if (newTab) {
      window.open(`${searchBase()}${url}`, '_blank', 'noopener');
      return;
    }
    onOpenChange(false);
    // Version snapshots link within their own base; the current site uses the router.
    if (searchBase() !== BASE_PATH) window.location.assign(`${searchBase()}${url}`);
    else router.push(url);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const next =
        (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault();
      go(results[active].url, event.metaKey || event.ctrlKey);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Search TotalFinance"
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      className="mx-auto mt-[10vh] w-[min(42rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl border border-fd-border bg-fd-popover p-0 text-fd-foreground shadow-2xl backdrop:bg-slate-950/40 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-3 border-b border-fd-border px-4">
        {state.status === 'loading' ? (
          <Loader2 className="size-5 shrink-0 animate-spin text-fd-muted-foreground" aria-hidden />
        ) : (
          <Search className="size-5 shrink-0 text-fd-muted-foreground" aria-hidden />
        )}
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            controller?.setQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search calculators, guides, functions, types, operations…"
          aria-label="Search query"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fd-muted-foreground"
        />
        <kbd className="tf-kbd">esc</kbd>
      </div>
      <div className="tf-scrollbar max-h-[min(60vh,32rem)] overflow-y-auto p-2">
        {state.status === 'idle' ? (
          <div className="p-2">
            <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.14em] text-fd-muted-foreground">
              Try
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.query}
                  type="button"
                  onClick={() => {
                    setQuery(suggestion.query);
                    controller?.setQuery(suggestion.query);
                    void controller?.submit();
                  }}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground"
                >
                  {suggestion.title}
                  <ArrowRight className="size-3.5" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ) : state.status === 'error' ? (
          <p role="status" className="p-6 text-center text-sm text-fd-muted-foreground">
            Search could not load. Check your connection and type again; the navigation and
            reference stay available.
          </p>
        ) : results.length === 0 && state.status === 'ready' ? (
          <p role="status" className="p-6 text-center text-sm text-fd-muted-foreground">
            No matches for “{state.query}”. Try a function name, a package such as options, or a
            shorter finance term.
          </p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Search results">
            {results.map((record, index) => (
              <li
                key={`${record.url}-${index}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseMove={() => setActive(index)}
                onClick={(event) => go(record.url, event.metaKey || event.ctrlKey)}
                className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-sm ${
                  index === active ? 'bg-fd-accent' : ''
                }`}
              >
                <SearchResultContent record={record} />
                {index === active ? (
                  <CornerDownLeft
                    className="mt-1 size-3.5 shrink-0 text-fd-muted-foreground"
                    aria-hidden
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-fd-border bg-fd-muted px-4 py-2 text-[0.6875rem] text-fd-muted-foreground">
        <span className="flex items-center gap-3">
          <span>
            <kbd className="tf-kbd">↑</kbd> <kbd className="tf-kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="tf-kbd">↵</kbd> open
          </span>
          <span className="hidden sm:inline">
            <kbd className="tf-kbd">⌘</kbd> <kbd className="tf-kbd">↵</kbd> new tab
          </span>
        </span>
        <span>Runs in your browser · no tracking</span>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {state.status === 'ready' ? `${results.length} results` : ''}
      </p>
    </dialog>
  );
}
