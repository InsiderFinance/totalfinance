import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { operations } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { BASE_PATH } from '@/lib/site';

export const metadata = pageMetadata({
  title: 'Operation catalog',
  description:
    'Every registered TotalFinance operation available to the CLI, local HTTP server and MCP tools.',
  route: '/agents/operations',
});

export default function OperationsPage() {
  const all = operations();
  const packs = [...new Set(all.map((operation) => operation.pack))];
  return (
    <div className="mx-auto max-w-[80rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route="/agents/operations"
        eyebrow="One registry, several front doors"
        title="Operation catalog"
        description={`${all.length} registered operations. The default profile exposes ${all.filter((operation) => operation.defaultEnabled).length}; selected packs and permissions decide what a given server actually offers. This is a curated serializable subset, not the whole SDK.`}
        crumbs={[
          { title: 'TotalFinance', url: '/' },
          { title: 'Agents', url: '/agents' },
          { title: 'Operations' },
        ]}
      >
        <p className="mt-4 text-sm text-fd-muted-foreground">
          Machine-readable:{' '}
          <a
            href={`${BASE_PATH}/operation-catalog.json`}
            className="text-fd-primary hover:underline"
          >
            operation-catalog.json
          </a>{' '}
          with full input and output schemas.
        </p>
      </PageHeader>
      <div className="space-y-8">
        {packs.map((pack) => (
          <section key={pack}>
            <h2 className="mb-3 font-mono text-sm font-semibold text-fd-muted-foreground">
              {pack} pack
            </h2>
            <div className="grid gap-2.5 md:grid-cols-2">
              {all
                .filter((operation) => operation.pack === pack)
                .map((operation) => (
                  <Link
                    key={operation.id}
                    href={`/agents/operations/${operation.id}`}
                    className="rounded-xl border border-fd-border p-4 transition-colors hover:border-fd-primary/50 hover:bg-fd-muted"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fd-foreground">{operation.title}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide ${operation.defaultEnabled ? 'bg-fd-accent text-fd-primary' : 'bg-fd-secondary text-fd-muted-foreground'}`}
                      >
                        {operation.defaultEnabled ? 'Default' : 'Opt-in'}
                      </span>
                    </span>
                    <code className="mt-1 block font-mono text-[0.72rem] text-fd-muted-foreground">
                      {operation.mcpToolName}
                    </code>
                    <span className="mt-1.5 line-clamp-2 block text-[0.8125rem] leading-5 text-fd-muted-foreground">
                      {operation.description}
                    </span>
                  </Link>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
