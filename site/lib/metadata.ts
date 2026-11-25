import 'server-only';
import type { Metadata } from 'next';
import { markdownRoute, sitePath } from '@/src/routes';
import { BASE_PATH, SITE_ORIGIN } from './site';

const CANONICAL_URL = `${SITE_ORIGIN}${BASE_PATH}`;

/** Indexing policy: `index` unless the build sets `TOTALFINANCE_DOCS_INDEXING=noindex`. */
export function indexable(): boolean {
  const override = process.env.TOTALFINANCE_DOCS_INDEXING;
  if (override === undefined || override === 'index') return true;
  if (override === 'noindex') return false;
  throw new Error('TOTALFINANCE_DOCS_INDEXING must be "index" or "noindex".');
}

/** The docs home is the base path itself (`…/docs/totalfinance`), like every other route. */
export function absoluteUrl(route: string): string {
  const path = sitePath(route);
  return path === '/' ? CANONICAL_URL : `${CANONICAL_URL}${path}`;
}

export function pageMetadata({
  title,
  description,
  route,
}: {
  title: string;
  description?: string;
  route: string;
}): Metadata {
  const url = absoluteUrl(route);
  const text =
    description || 'TypeScript finance with explicit units, assumptions and diagnostics.';
  return {
    title,
    description: text,
    alternates: {
      canonical: url,
      types: {
        'text/markdown': `${BASE_PATH}${markdownRoute(route)}`,
      },
    },
    openGraph: {
      title: `${title} · TotalFinance`,
      description: text,
      url,
      siteName: 'TotalFinance by InsiderFinance',
      type: 'article',
      images: [
        {
          url: `${SITE_ORIGIN}/assets/brand/og.png`,
          width: 1200,
          height: 630,
          alt: 'TotalFinance. The most complete finance toolkit. For developers and AI agents. Built with TypeScript. Run anywhere.',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · TotalFinance`,
      description: text,
      images: [`${SITE_ORIGIN}/assets/brand/og.png`],
    },
  };
}
