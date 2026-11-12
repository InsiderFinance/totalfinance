import Link from 'next/link';
import { DocsShell } from '@/components/layout/docs-shell';

export default function NotFound() {
  return (
    <DocsShell tab="guide">
      <div className="mx-auto max-w-2xl px-5 py-24 text-center">
        <p className="tf-eyebrow">404</p>
        <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight">
          That page is not here.
        </h1>
        <p className="mt-4 text-fd-muted-foreground">
          It may have moved, or the link may be from an older version. Search the docs with{' '}
          <kbd className="tf-kbd">⌘</kbd> <kbd className="tf-kbd">K</kbd>, or start from one of
          these:
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm font-semibold">
          <Link
            href="/"
            className="rounded-xl bg-fd-primary px-4 py-2.5 text-fd-primary-foreground"
          >
            Home
          </Link>
          <Link href="/reference" className="rounded-xl border border-fd-border px-4 py-2.5">
            API reference
          </Link>
          <Link href="/playgrounds" className="rounded-xl border border-fd-border px-4 py-2.5">
            Calculators
          </Link>
          <Link href="/search" className="rounded-xl border border-fd-border px-4 py-2.5">
            Search
          </Link>
        </div>
      </div>
    </DocsShell>
  );
}
