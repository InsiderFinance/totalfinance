import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { referenceIndex, referencePage } from '@/lib/data';
import type { ExportLink } from '@/src/site-data';

export { KindBadge } from '../reference/kind-badge';
import { KindBadge } from '../reference/kind-badge';

export function DomainGrid({ exclude = [] as string[] }: { exclude?: string[] }) {
  const domains = referenceIndex().domains.filter(
    (domain) => domain.slug !== 'index' && !exclude.includes(domain.slug),
  );
  return (
    <div className="not-prose my-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {domains.map((domain) => {
        const exports = domain.entrypoints.reduce(
          (count, entrypoint) => count + entrypoint.exportCount,
          0,
        );
        return (
          <Link
            key={domain.slug}
            href={`/domains/${domain.slug}`}
            className="group rounded-xl border border-fd-border p-4 transition-colors hover:border-fd-primary/50 hover:bg-fd-muted"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-display font-semibold text-fd-foreground">{domain.title}</span>
              <ArrowUpRight
                className="size-4 text-fd-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-fd-primary"
                aria-hidden
              />
            </span>
            <span className="mt-1.5 block text-sm leading-6 text-fd-muted-foreground">
              {domain.summary}
            </span>
            <span className="mt-3 block font-mono text-[0.6875rem] text-fd-muted-foreground">
              {domain.entrypoints.length}{' '}
              {domain.entrypoints.length === 1 ? 'entry point' : 'entry points'} ·{' '}
              {exports.toLocaleString('en-US')} exports
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function EntrypointList({ domain }: { domain: string }) {
  const found = referenceIndex().domains.find((candidate) => candidate.slug === domain);
  if (!found) throw new Error(`Unknown domain ${domain}`);
  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border border-fd-border">
      <table className="w-full text-sm">
        <thead className="bg-fd-muted text-left text-xs text-fd-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Import</th>
            <th className="px-4 py-2 text-right font-medium">Exports</th>
          </tr>
        </thead>
        <tbody>
          {found.entrypoints.map((entrypoint) => (
            <tr key={entrypoint.specifier} className="border-t border-fd-border">
              <td className="px-4 py-2">
                <Link
                  href={`/${entrypoint.path}`}
                  className="font-mono text-[0.8125rem] text-fd-primary hover:underline"
                >
                  {entrypoint.specifier}
                </Link>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-fd-muted-foreground">
                {entrypoint.exportCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function exportsOf(path: string): ExportLink[] {
  const page = referencePage(path);
  return page?.kind === 'entrypoint' ? page.exports : [];
}

/** Cards for named exports of a domain's root entry point, with their generated summaries. */
export function KeyExports({
  domain,
  names,
  entrypoint,
}: {
  domain: string;
  names: string[];
  entrypoint?: string;
}) {
  const exports = exportsOf(entrypoint ?? `reference/totalfinance/${domain}`);
  const missing = names.filter((name) => !exports.some((entry) => entry.name === name));
  if (missing.length)
    throw new Error(
      `KeyExports(${domain}): not exported from the domain root: ${missing.join(', ')}`,
    );
  return (
    <div className="not-prose my-6 grid gap-2.5 sm:grid-cols-2">
      {names.map((name) => {
        const entry = exports.find((candidate) => candidate.name === name)!;
        return (
          <Link
            key={name}
            href={entry.url}
            className="group flex flex-col rounded-xl border border-fd-border p-3.5 transition-colors hover:border-fd-primary/50 hover:bg-fd-muted"
          >
            <span className="flex items-center gap-2">
              <KindBadge kind={entry.kind} />
              <code className="truncate font-mono text-[0.8125rem] font-semibold text-fd-foreground">
                {entry.name}
              </code>
            </span>
            <span className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-5 text-fd-muted-foreground">
              {entry.summary || 'See the reference for its full contract.'}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
