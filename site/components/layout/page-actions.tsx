'use client';
import { Bot, Check, ChevronDown, Copy, ExternalLink, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BASE_PATH } from '@/lib/site';
import { markdownRoute } from '@/src/routes';

function base(): string {
  return typeof document === 'undefined'
    ? BASE_PATH
    : (document.documentElement.dataset['tfBase'] ?? BASE_PATH);
}

export function PageActions({ route, title }: { route: string; title: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const markdownHref = `${BASE_PATH}${markdownRoute(route)}`;
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const absoluteMarkdown = () => `${window.location.origin}${base()}${markdownRoute(route)}`;
  const prompt = () =>
    `Read ${absoluteMarkdown()} (the TotalFinance docs page “${title}”) so you can answer questions and write TypeScript with @insiderfinance/totalfinance. Use only APIs that the docs show.`;

  const copyPage = async () => {
    try {
      const response = await fetch(`${base()}${markdownRoute(route)}`);
      if (!response.ok) throw new Error(String(response.status));
      await navigator.clipboard.writeText(await response.text());
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 2200);
  };

  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fd-foreground hover:bg-fd-secondary';
  return (
    <div
      ref={menu}
      className="relative inline-flex shrink-0 rounded-lg border border-fd-border bg-fd-background text-xs font-medium shadow-xs"
    >
      <button
        type="button"
        onClick={() => void copyPage()}
        className="inline-flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground"
        title="Copy this page as Markdown, for an LLM or your notes"
      >
        {copied === 'copied' ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        <span aria-live="polite">
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy page'}
        </span>
      </button>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More page actions"
        className="inline-flex items-center rounded-r-lg border-l border-fd-border px-2 text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground"
      >
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-fd-border bg-fd-popover p-1.5 shadow-xl"
        >
          <a role="menuitem" href={markdownHref} className={item}>
            <FileText className="size-4 text-fd-muted-foreground" aria-hidden />
            View as Markdown
          </a>
          <a
            role="menuitem"
            className={item}
            href="https://claude.ai/new"
            onClick={(event) => {
              event.preventDefault();
              window.open(
                `https://claude.ai/new?q=${encodeURIComponent(prompt())}`,
                '_blank',
                'noopener',
              );
            }}
          >
            <ExternalLink className="size-4 text-fd-muted-foreground" aria-hidden />
            Open in Claude
          </a>
          <a
            role="menuitem"
            className={item}
            href="https://chatgpt.com/"
            onClick={(event) => {
              event.preventDefault();
              window.open(
                `https://chatgpt.com/?hints=search&q=${encodeURIComponent(prompt())}`,
                '_blank',
                'noopener',
              );
            }}
          >
            <ExternalLink className="size-4 text-fd-muted-foreground" aria-hidden />
            Open in ChatGPT
          </a>
          <a
            role="menuitem"
            href={`${base()}/agents`}
            className={`${item} border-t border-fd-border`}
          >
            <Bot className="size-4 text-fd-primary" aria-hidden />
            Connect your AI agent (MCP)
          </a>
        </div>
      ) : null}
    </div>
  );
}
