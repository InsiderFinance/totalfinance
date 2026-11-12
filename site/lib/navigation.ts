import 'server-only';
import { playgrounds } from '@/src/playgrounds';
import { generatedGuides, operations, referenceIndex } from '@/lib/data';
import { source } from '@/lib/source';
import { sitePath } from '@/src/routes';

export interface NavLink {
  title: string;
  url: string;
  /** Short monospace badge, like the API docs' GET/POST. */
  badge?: string;
}

export interface NavGroup {
  title: string;
  links: NavLink[];
  /** Collapsible groups start closed unless they contain the active page. */
  collapsible?: boolean;
}

export interface NavTab {
  id: 'guide' | 'reference' | 'agents';
  title: string;
  url: string;
  description: string;
  groups: NavGroup[];
}

/** Guide placement by route. A generated guide missing here lands in "More guides" (and fails a test). */
export const GUIDE_GROUPS: { title: string; routes: string[] }[] = [
  {
    title: 'Conventions',
    routes: [
      'guides/assumptions',
      'guides/envelope',
      'guides/errors',
      'guides/levels',
      'guides/imports-and-bundles',
      'guides/calculation-adoption',
    ],
  },
  {
    title: 'Options & strategies',
    routes: [
      'guides/strategies',
      'guides/selective-greeks-and-exposure',
      'guides/price-level-conversion',
    ],
  },
  {
    title: 'Technical analysis',
    routes: [
      'guides/ta-indicators',
      'guides/ta-warmup',
      'guides/ta-live-charts',
      'guides/ta-snapshots',
      'guides/ta-compatibility',
    ],
  },
  {
    title: 'Portfolios & research',
    routes: [
      'guides/end-to-end',
      'guides/backtesting',
      'guides/sector-performance',
      'guides/disclosed-holdings',
      'guides/disclosed-holding-partitions',
    ],
  },
  {
    title: 'Interfaces & trading',
    routes: [
      'guides/cli',
      'guides/http',
      'guides/mcp',
      'guides/trade-lifecycle',
      'guides/trading-environment',
    ],
  },
  {
    title: 'Project',
    routes: ['guides/getting-started', 'guides/stability', 'guides/bundle-size', 'guides/security'],
  },
];

function pageTitle(route: string): string {
  const page = source.getPage(route ? route.split('/') : []);
  if (!page) throw new Error(`Navigation points to a missing page: /${route}`);
  return page.data.title;
}

const link = (route: string, title = pageTitle(route), badge?: string): NavLink => ({
  title,
  url: sitePath(route),
  ...(badge ? { badge } : {}),
});

const TASK_BADGES: Record<string, string> = {
  'price-an-option': 'OPT',
  'analyze-a-strategy': 'STR',
  'explore-scenarios': 'SCN',
  'fit-a-volatility-smile': 'VOL',
  'chart-technical-indicators': 'TA',
  'backtest-a-strategy': 'BT',
  'measure-risk': 'RISK',
  'track-portfolio-pnl': 'PNL',
  'value-a-company': 'DCF',
  'price-a-bond': 'FI',
};

export function navigation(): NavTab[] {
  const guides = generatedGuides();
  const placed = new Set(GUIDE_GROUPS.flatMap((group) => group.routes));
  const unplaced = guides.filter((guide) => guide.group === 'guides' && !placed.has(guide.route));
  const index = referenceIndex();
  return [
    {
      id: 'guide',
      title: 'Guide',
      url: '/start',
      description: 'Concepts, calculators and guides',
      groups: [
        {
          title: 'Get started',
          links: [
            link('start'),
            link('start/installation'),
            link('start/quickstart'),
            link('start/concepts'),
          ],
        },
        {
          title: 'Calculators',
          links: playgrounds.map((playground) =>
            link(
              `learn/${playground.id}`,
              pageTitle(`learn/${playground.id}`),
              TASK_BADGES[playground.id],
            ),
          ),
        },
        {
          title: 'Domains',
          collapsible: true,
          links: index.domains
            .filter((domain) => domain.slug !== 'index')
            .map((domain) => link(`domains/${domain.slug}`, domain.title)),
        },
        ...GUIDE_GROUPS.map((group) => ({
          title: group.title,
          collapsible: true,
          links: group.routes
            .filter((route) => guides.some((guide) => guide.route === route))
            .map((route) => link(route)),
        })),
        ...(unplaced.length
          ? [
              {
                title: 'More guides',
                collapsible: true,
                links: unplaced.map((guide) => link(guide.route)),
              },
            ]
          : []),
        {
          title: 'Project',
          links: [link('versions', 'Versions & stability'), link('playgrounds', 'All calculators')],
        },
      ],
    },
    {
      id: 'reference',
      title: 'Reference',
      url: '/reference',
      description: `${index.totals.entrypoints} entry points, ${index.totals.exportPaths.toLocaleString('en-US')} exports`,
      groups: [
        { title: 'Overview', links: [link('reference', 'All packages & entry points')] },
        ...index.domains.map((domain) => ({
          title: domain.title,
          collapsible: true,
          links: domain.entrypoints.map((entrypoint) => ({
            title: entrypoint.specifier.replace(/^@insiderfinance\//, ''),
            url: `/${entrypoint.path}`,
          })),
        })),
      ],
    },
    {
      id: 'agents',
      title: 'Agents',
      url: '/agents',
      description: 'MCP, operations and LLM-ready docs',
      groups: [
        {
          title: 'Connect',
          links: [
            link('agents', 'Connect an AI agent'),
            link('agents/handbook', 'Agent handbook'),
            link('guides/mcp', 'MCP server reference'),
            link('agents/docs-mcp'),
          ],
        },
        {
          title: 'For agents',
          links: [
            link('agents/llms'),
            link('agents/browser-tools'),
            link('agents/operations', 'Operation catalog'),
          ],
        },
        {
          title: 'Operations',
          collapsible: true,
          links: operations().map((operation) => ({
            title: operation.title,
            url: `/agents/operations/${operation.id}`,
          })),
        },
      ],
    },
  ];
}

export function activeTab(pathname: string): NavTab['id'] {
  if (pathname.startsWith('/reference')) return 'reference';
  if (pathname.startsWith('/agents')) return 'agents';
  return 'guide';
}
