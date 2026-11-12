import type { Metadata } from 'next';
import { DocsPage, docsMetadata } from '@/components/docs-page';
import { source } from '@/lib/source';

type Props = { params: Promise<{ slug: string[] }> };

export default async function GuidePage({ params }: Props) {
  return <DocsPage slug={(await params).slug} />;
}

/** Every MDX/Markdown page except the Agents section, which has its own layout and route. */
export function generateStaticParams() {
  return source
    .generateParams()
    .filter((params) => params.slug.length > 0 && params.slug[0] !== 'agents');
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return docsMetadata((await params).slug);
}
