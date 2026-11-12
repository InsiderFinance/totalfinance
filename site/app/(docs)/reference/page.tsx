import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { referenceIndex } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { BASE_PATH } from '@/lib/site';

export const metadata = pageMetadata({
  title: 'API reference',
  description:
    'Every public entry point and export of TotalFinance, generated from the TypeScript source.',
  route: '/reference',
});

export default function ReferenceIndexPage() {
  const index = referenceIndex();
  return (
    <div className="mx-auto max-w-[88rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route="/reference"
        eyebrow="Generated from the source"
        title="API reference"
        description={`${index.totals.packages} packages, ${index.totals.entrypoints} supported entry points and ${index.totals.exportPaths.toLocaleString('en-US')} export paths, including types. Browse signatures, types, field contracts and imports generated from the public source.`}
        crumbs={[{ title: 'TotalFinance', url: '/' }, { title: 'Reference' }]}
      >
        <div className="mt-5 flex flex-wrap gap-2 text-xs">
          {index.packages.map((pkg) => (
            <span
              key={pkg.name}
              className="rounded-full border border-fd-border px-3 py-1 text-fd-muted-foreground"
            >
              <span className="font-mono text-fd-foreground">{pkg.name}</span> · {pkg.version} ·{' '}
              {pkg.entrypoints.length} entry points
            </span>
          ))}
          <a
            href={`${BASE_PATH}/reference-coverage.json`}
            className="rounded-full border border-fd-border px-3 py-1 text-fd-muted-foreground hover:text-fd-primary"
          >
            reference-coverage.json ↗
          </a>
        </div>
      </PageHeader>
      <div className="grid gap-5 lg:grid-cols-2">
        {index.domains.map((domain) => (
          <section
            key={domain.slug}
            id={domain.slug}
            className="rounded-2xl border border-fd-border p-5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display text-lg font-semibold">
                {domain.slug === 'index' ? (
                  domain.title
                ) : (
                  <Link href={`/domains/${domain.slug}`} className="hover:text-fd-primary">
                    {domain.title}
                  </Link>
                )}
              </h2>
              <span className="shrink-0 font-mono text-[0.6875rem] text-fd-muted-foreground">
                {domain.entrypoints
                  .reduce((count, entrypoint) => count + entrypoint.exportCount, 0)
                  .toLocaleString('en-US')}{' '}
                exports
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{domain.summary}</p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {domain.entrypoints.map((entrypoint) => (
                <li key={entrypoint.specifier}>
                  <Link
                    href={`/${entrypoint.path}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-fd-border px-2 py-1 font-mono text-[0.72rem] text-fd-foreground transition-colors hover:border-fd-primary/50 hover:text-fd-primary"
                  >
                    {entrypoint.specifier.replace(/^@insiderfinance\/totalfinance(?=\/)/, '')}
                    <span className="text-fd-muted-foreground">{entrypoint.exportCount}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
