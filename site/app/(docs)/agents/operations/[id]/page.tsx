import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SchemaView } from '@/components/reference/schema-view';
import { schemaSummary } from '@/src/schema-summary';
import { PageHeader } from '@/components/layout/page-header';
import { operations } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';

type Props = { params: Promise<{ id: string }> };

export default async function OperationPage({ params }: Props) {
  const { id } = await params;
  const operation = operations().find((candidate) => candidate.id === id);
  if (!operation) notFound();
  const rows: [string, string][] = [
    ['MCP tool name', operation.mcpToolName],
    ['Pack / profiles', `${operation.pack} / ${operation.profiles.join(', ')}`],
    [
      'Default discovery',
      operation.defaultEnabled
        ? 'Included in the default tool set'
        : 'Opt-in (select its pack or profile)',
    ],
    ['Required capabilities', operation.requiredCapabilities.join(', ') || 'None'],
    ['Effects / authorization', `${operation.sideEffect} / ${operation.authorization}`],
    [
      'Cost / cancellation',
      `${operation.costClass} / ${operation.supportsCancellation ? 'Supported by configured worker execution' : 'Do not assume inline interruption'}`,
    ],
    ['Handle-eligible inputs', operation.handleFields.join(', ') || 'None'],
    ['Idempotency', operation.idempotency],
  ];
  return (
    <div className="mx-auto max-w-[64rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route={`/agents/operations/${operation.id}`}
        eyebrow={`${operation.pack} · wire operation`}
        title={operation.title}
        description={operation.description}
        crumbs={[
          { title: 'Agents', url: '/agents' },
          { title: 'Operations', url: '/agents/operations' },
          { title: operation.id },
        ]}
      >
        <code className="mt-4 inline-block rounded-lg border border-fd-border bg-fd-muted px-3 py-1 font-mono text-sm">
          {operation.id}
        </code>
      </PageHeader>
      <dl className="mb-8 overflow-hidden rounded-xl border border-fd-border text-sm">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-1 border-t border-fd-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[13rem_minmax(0,1fr)]"
          >
            <dt className="text-fd-muted-foreground">{label}</dt>
            <dd className="break-words font-mono text-[0.8125rem]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">Input schema</h2>
          <SchemaView
            id={operation.id}
            which="inputSchema"
            summary={schemaSummary(operation.inputSchema)}
          />
        </section>
        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">Output schema</h2>
          <SchemaView
            id={operation.id}
            which="outputSchema"
            summary={schemaSummary(operation.outputSchema)}
          />
        </section>
      </div>
    </div>
  );
}

export function generateStaticParams() {
  return operations().map((operation) => ({ id: operation.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const operation = operations().find((candidate) => candidate.id === id);
  if (!operation) notFound();
  return pageMetadata({
    title: operation.title,
    description: operation.description,
    route: `/agents/operations/${operation.id}`,
  });
}
