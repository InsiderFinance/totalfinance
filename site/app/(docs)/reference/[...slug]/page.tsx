import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/code/copy-button';
import { PageHeader } from '@/components/layout/page-header';
import { TableOfContents } from '@/components/layout/toc';
import { KindBadge } from '@/components/reference/kind-badge';
import { ExportGrid, ReferenceEntries } from '@/components/reference/reference-entries';
import { referenceIndex, referencePage } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { BASE_PATH } from '@/lib/site';
import type { EntrypointPageData } from '@/src/site-data';

type Props = { params: Promise<{ slug: string[] }> };

function domainTitle(slug: string): string {
  return referenceIndex().domains.find((domain) => domain.slug === slug)?.title ?? slug;
}

function Pagination({ page }: { page: EntrypointPageData }) {
  if (page.chunks.length < 2) return null;
  return (
    <nav aria-label="Reference pages" className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="mr-1 text-xs text-fd-muted-foreground">Declarations, page</span>
      {page.chunks.map((path, index) => (
        <Link
          key={path}
          href={`/${path}`}
          prefetch={false}
          aria-current={index === page.chunk ? 'page' : undefined}
          className={`inline-flex size-8 items-center justify-center rounded-lg border text-xs font-medium ${
            index === page.chunk
              ? 'border-fd-primary bg-fd-accent text-fd-primary'
              : 'border-fd-border text-fd-muted-foreground hover:text-fd-foreground'
          }`}
        >
          {index + 1}
        </Link>
      ))}
    </nav>
  );
}

function EntrypointView({ page }: { page: EntrypointPageData }) {
  const route = `/${page.path}`;
  const counts = new Map<string, number>();
  for (const entry of page.exports) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const twin = `${BASE_PATH}${page.contract}`;
  return (
    <div className="mx-auto grid max-w-[88rem] grid-cols-1 gap-10 px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10 xl:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0">
        <PageHeader
          route={route}
          eyebrow={`${domainTitle(page.domain)} · ${page.package}`}
          title={
            <span className="font-mono text-2xl sm:text-3xl">
              {/* Break long import paths after a slash, never inside a word. */}
              {page.entrypoint.split('/').map((part, index, parts) => (
                <span key={index}>
                  {part}
                  {index < parts.length - 1 ? (
                    <>
                      /<wbr />
                    </>
                  ) : null}
                </span>
              ))}
            </span>
          }
          crumbs={[
            { title: 'TotalFinance', url: '/' },
            { title: 'Reference', url: '/reference' },
            {
              title: domainTitle(page.domain),
              url: page.domain === 'index' ? '/reference' : `/domains/${page.domain}`,
            },
            {
              title:
                page.entrypoint.replace(/^@insiderfinance\//, '') +
                (page.chunk ? ` · page ${page.chunk + 1}` : ''),
            },
          ]}
        >
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-fd-border bg-fd-muted py-1 pl-3 pr-1 font-mono text-xs">
              <span className="truncate">
                import {'{ … }'} from &apos;{page.entrypoint}&apos;
              </span>
              <CopyButton
                text={`import {  } from '${page.entrypoint}';`}
                tone="light"
                label="Copy"
              />
            </div>
            <span className="rounded-full border border-fd-border px-2.5 py-1 text-xs text-fd-muted-foreground">
              {page.stability}
            </span>
            {[...counts].map(([kind, count]) => (
              <span
                key={kind}
                className="inline-flex items-center gap-1.5 text-xs text-fd-muted-foreground"
              >
                <KindBadge kind={kind} /> {count}
              </span>
            ))}
            <a href={twin} className="text-xs text-fd-muted-foreground hover:text-fd-primary">
              JSON ↗
            </a>
          </div>
        </PageHeader>
        {page.empty ? (
          <p className="rounded-xl border border-fd-border p-5 text-sm text-fd-muted-foreground">
            This supported entry point has no named exports. Stability: {page.stability}.
          </p>
        ) : (
          <>
            {page.chunk === 0 ? (
              <section
                aria-label="All exports"
                className="mb-10 rounded-2xl border border-fd-border p-5"
              >
                <ExportGrid exports={page.exports} />
              </section>
            ) : null}
            <Pagination page={page} />
            <div className="mt-4">
              <ReferenceEntries
                entries={page.entries}
                entrypoint={page.entrypoint}
                contract={page.contract}
              />
            </div>
            <div className="mt-10">
              <Pagination page={page} />
            </div>
          </>
        )}
      </div>
      <aside className="hidden xl:block">
        <div className="sticky top-[calc(var(--tf-header-height)+2.5rem)] max-h-[calc(100dvh-var(--tf-header-height)-4rem)] overflow-y-auto pb-6">
          <TableOfContents
            items={page.entries.map((entry) => ({
              title: entry.name,
              url: `#${entry.name}`,
              depth: 2,
            }))}
          />
        </div>
      </aside>
    </div>
  );
}

export default async function ReferencePage({ params }: Props) {
  const { slug } = await params;
  const page = referencePage(['reference', ...slug].join('/'));
  if (!page) notFound();
  return <EntrypointView page={page} />;
}

export function generateStaticParams() {
  return referenceIndex().routes.map((route) => ({
    slug: route.path.split('/').slice(1).map(decodeURIComponent),
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = referencePage(['reference', ...slug].join('/'));
  if (!page) notFound();
  const title = `${page.entrypoint}${page.chunk ? ` (page ${page.chunk + 1})` : ''}`;
  const description = `API reference for ${page.entrypoint}: ${page.exports.length} exports with signatures, members, units and examples.`;
  return pageMetadata({ title, description, route: `/${page.path}` });
}
