import 'server-only';
import type { Metadata } from 'next';
import { siteVersion } from './data';
import { markdownRoute, sitePath } from '@/src/routes';
import { BASE_PATH, SITE_ORIGIN } from './site';

/** Canonical URLs always name the current docs, even from a version snapshot. */
const CANONICAL_URL = `${SITE_ORIGIN}${process.env.TOTALFINANCE_DOCS_CANONICAL_BASE ?? BASE_PATH}`;

/** Explicit indexing policy: `index` only for a verified published build unless overridden. */
export function indexable(): boolean {
  const override = process.env.TOTALFINANCE_DOCS_INDEXING;
  if (override === 'index') return true;
  if (override === 'noindex') return false;
  if (override !== undefined)
    throw new Error('TOTALFINANCE_DOCS_INDEXING must be "index" or "noindex".');
  return siteVersion().published;
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
