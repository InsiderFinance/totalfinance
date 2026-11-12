'use client';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** Copies text; on clipboard refusal, selects a visible fallback so the reader can copy manually. */
export function CopyButton({
  text,
  label = 'Copy',
  className = '',
  tone = 'dark',
}: {
  text: string | (() => string | Promise<string>);
  label?: string;
  className?: string;
  tone?: 'dark' | 'light';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [fallback, setFallback] = useState<string | null>(null);
  const copy = async () => {
    const value = typeof text === 'function' ? await text() : text;
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      setFallback(null);
    } catch {
      setState('failed');
      setFallback(value);
    }
    window.setTimeout(() => setState('idle'), 2000);
  };
  const colors =
    tone === 'dark'
      ? 'text-slate-300 hover:bg-white/10 hover:text-white'
      : 'text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground';
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${colors} ${className}`}
        aria-live="polite"
      >
        {state === 'copied' ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy below' : label}
      </button>
      {fallback !== null ? (
        <textarea
          readOnly
          value={fallback}
          onFocus={(event) => event.currentTarget.select()}
          autoFocus
          aria-label="Code to copy"
          className="fixed inset-x-4 bottom-4 z-50 h-48 rounded-lg border border-fd-border bg-fd-background p-3 font-mono text-xs text-fd-foreground shadow-xl"
          onBlur={() => setFallback(null)}
        />
      ) : null}
    </>
  );
}
