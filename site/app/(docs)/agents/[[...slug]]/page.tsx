import type { Metadata } from 'next';
import { DocsPage, docsMetadata } from '@/components/docs-page';
import { source } from '@/lib/source';

type Props = { params: Promise<{ slug?: string[] }> };

export default async function AgentsPage({ params }: Props) {
  return <DocsPage slug={['agents', ...((await params).slug ?? [])]} />;
}

export function generateStaticParams() {
  return source
    .generateParams()
    .filter((params) => params.slug[0] === 'agents')
    .map((params) => ({ slug: params.slug.slice(1) }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return docsMetadata(['agents', ...((await params).slug ?? [])]);
}
