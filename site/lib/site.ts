/**
 * Site-wide configuration. Build-time environment variables (read by `site/build.ts` and
 * `next.config.mjs`) decide where the site lives and which InsiderFinance family links appear.
 */
export const BASE_PATH =
  process.env.NEXT_PUBLIC_TOTALFINANCE_DOCS_BASE_PATH ?? '/docs/totalfinance';

/** Canonical origin for absolute URLs (sitemap, canonical links, Open Graph, llms.txt). */
export const SITE_ORIGIN = (
  process.env.TOTALFINANCE_DOCS_ORIGIN ?? 'https://www.totalfinance.io'
).replace(/\/$/, '');

export const SITE_URL = `${SITE_ORIGIN}${BASE_PATH}`;

export const REPOSITORY_URL = 'https://github.com/InsiderFinance/totalfinance';
export const PACKAGE_NAME = '@insiderfinance/totalfinance';
export const PACKAGE_URL = `https://www.npmjs.com/package/${PACKAGE_NAME}`;
export const MCP_PACKAGE_NAME = '@insiderfinance/totalfinance-mcp';

/**
 * A hosted calculations MCP endpoint. Off unless the build names one; the key page, when set,
 * makes the setup carry an API-key header. See `src/agents.ts`.
 */
export const HOSTED_MCP = {
  url: process.env.TOTALFINANCE_DOCS_HOSTED_MCP_URL || undefined,
  keyUrl: process.env.TOTALFINANCE_DOCS_HOSTED_MCP_KEY_URL || undefined,
};

/**
 * The InsiderFinance documentation family. API and MCP docs are listed only when the build is
 * told they are public (`TOTALFINANCE_DOCS_FAMILY_API=1`); a link to a page that 404s is worse
 * than no link.
 */
const FAMILY_ORIGIN = (
  process.env.TOTALFINANCE_DOCS_FAMILY_ORIGIN ?? 'https://www.insiderfinance.io'
).replace(/\/$/, '');
const API_DOCS_PUBLIC = process.env.TOTALFINANCE_DOCS_FAMILY_API === '1';
export const PUBLIC_DOCS_URL = `${FAMILY_ORIGIN}/docs/totalfinance`;

export interface FamilyLink {
  id: string;
  label: string;
  href: string;
  external: boolean;
}

export const FAMILY = {
  home: FAMILY_ORIGIN,
  docs: `${FAMILY_ORIGIN}/docs`,
  links: [
    {
      id: 'totalfinance',
      label: 'View Docs',
      href: `${PUBLIC_DOCS_URL}/start`,
      external: true,
    },
    ...(API_DOCS_PUBLIC
      ? [
          { id: 'api', label: 'API', href: `${FAMILY_ORIGIN}/docs/api`, external: true },
          { id: 'mcp', label: 'MCP', href: `${FAMILY_ORIGIN}/docs/mcp`, external: true },
        ]
      : []),
  ] satisfies FamilyLink[],
  /** Where "get real market data" points: the API docs when public, otherwise the product. */
  data: API_DOCS_PUBLIC
    ? { label: 'InsiderFinance API', href: `${FAMILY_ORIGIN}/docs/api` }
    : { label: 'InsiderFinance', href: FAMILY_ORIGIN },
};

/** Prefix a site-relative path (starting with `/`) with the base path, for plain `<a>` and assets. */
export function withBase(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${BASE_PATH}${path}`;
}
