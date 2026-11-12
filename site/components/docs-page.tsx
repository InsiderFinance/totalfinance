import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Callout } from 'fumadocs-ui/components/callout';
import Link from 'next/link';
import { PageHeader, type Crumb } from './layout/page-header';
import { TableOfContents } from './layout/toc';
import { mdxComponents } from './mdx/mdx-components';
import { PlaygroundSection } from './playground/playground-section';
import { siteVersion } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { REPOSITORY_URL } from '@/lib/site';
import { source } from '@/lib/source';
import { StarOnGitHub } from './brand/star-on-github';
import { sitePath } from '@/src/routes';

const SECTION: Record<string, Crumb> = {
  start: { title: 'Get started', url: '/start' },
  learn: { title: 'Calculators', url: '/playgrounds' },
  guides: { title: 'Guides', url: '/guides' },
  agents: { title: 'Agents', url: '/agents' },
  domains: { title: 'Library', url: '/domains' },
};

export function DocsPage({ slug }: { slug: string[] }) {
  const page = source.getPage(slug);
  if (!page) notFound();
  const route = sitePath(...slug);
  const MDX = page.data.body;
  const section = SECTION[slug[0]!];
  const crumbs: Crumb[] = [
    { title: 'TotalFinance', url: '/' },
    ...(section && slug.length > 1 ? [section] : []),
    { title: page.data.title },
  ];
  const generatedSource = page.data.source;
  const editUrl = generatedSource
    ? `${REPOSITORY_URL}/blob/main/${generatedSource}`
    : `${REPOSITORY_URL}/blob/main/site/content/docs/${page.path}`;
  const unpublished = !siteVersion().published && page.data.installs;
  const body = (
    <div className="tf-prose">
      {unpublished ? (
        <Callout type="warn" title="Unpublished preview">
          Registry install commands on this page apply after publication. Until then, build the
          source checkout; see <Link href="/start/installation">Installation</Link> and{' '}
          <Link href="/versions">Versions</Link>.
        </Callout>
      ) : null}
      <MDX components={mdxComponents()} />
    </div>
  );
  const footer = (
    <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-fd-border pt-6 text-sm text-fd-muted-foreground">
      <a href={editUrl} className="hover:text-fd-primary">
        {generatedSource ? `Source: ${generatedSource}` : 'Edit this page on GitHub'} ↗
      </a>
      <span>Every code block on this site is executed in CI against the library.</span>
      <StarOnGitHub variant="header" />
    </div>
  );

  if (page.data.playground) {
    return (
      <div className="mx-auto max-w-[96rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
        <PageHeader
          route={route}
          title={page.data.title}
          description={page.data.description}
          crumbs={crumbs}
        />
        <PlaygroundSection id={page.data.playground} />
        <div className="mt-14 grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_14rem]">
          <article className="min-w-0 max-w-3xl">
            {body}
            {footer}
          </article>
          <aside className="hidden xl:block">
            <div className="sticky top-[calc(var(--tf-header-height)+2rem)]">
              <TableOfContents items={page.data.toc} />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-[84rem] grid-cols-1 gap-10 px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10 xl:grid-cols-[minmax(0,1fr)_15rem]">
      <article className="min-w-0 max-w-[46rem]">
        <PageHeader
          route={route}
          title={page.data.title}
          // A generated guide's description is its own first paragraph; do not print it twice.
          description={generatedSource ? undefined : page.data.description}
          crumbs={crumbs}
        />
        {body}
        {footer}
      </article>
      <aside className="hidden xl:block">
        <div className="sticky top-[calc(var(--tf-header-height)+2.5rem)] max-h-[calc(100dvh-var(--tf-header-height)-4rem)] overflow-y-auto pb-6">
          <TableOfContents items={page.data.toc} />
        </div>
      </aside>
    </div>
  );
}

export function docsMetadata(slug: string[]): Metadata {
  const page = source.getPage(slug);
  if (!page) notFound();
  return pageMetadata({
    title: page.data.title,
    description: page.data.description,
    route: sitePath(...slug),
  });
}
