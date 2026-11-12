/**
 * Authored names and one-line summaries for each public domain. The generator fails when an entry
 * point belongs to a domain that is missing here, so a new domain cannot ship with a placeholder.
 * Order is the reading order of the reference navigation.
 */
export const DOMAINS: readonly { slug: string; title: string; summary: string }[] = [
  {
    slug: 'index',
    title: 'Umbrella package',
    summary: 'One import for every domain as a namespace. Prefer domain subpaths in browsers.',
  },
  {
    slug: 'data',
    title: 'Research data',
    summary:
      'Provider-neutral research queries, immutable source views, bounded windows and explicit resume/quality decisions; external packages own acquisition.',
  },
  {
    slug: 'options',
    title: 'Options',
    summary:
      'Black–Scholes, Black-76, Bachelier, American, Heston, SABR and exotic pricing; Greeks; implied volatility; chain health.',
  },
  {
    slug: 'strategy',
    title: 'Strategies',
    summary:
      'Multi-leg option positions: payoff, break-evens, scenarios and a named strategy catalogue.',
  },
  {
    slug: 'volatility',
    title: 'Volatility',
    summary:
      'Realized and implied volatility, smiles and surfaces (SVI, SSVI, SABR, Heston), GARCH.',
  },
  {
    slug: 'technical-analysis',
    title: 'Technical analysis',
    summary:
      'Hundreds of registered indicators with explicit warmup, streaming state, snapshots and a TA-Lib compatibility matrix.',
  },
  {
    slug: 'portfolio',
    title: 'Portfolio',
    summary: 'Event-sourced ledgers, positions, lots, cash, P&L attribution and timelines.',
  },
  {
    slug: 'performance',
    title: 'Performance',
    summary: 'Returns, risk-adjusted ratios, drawdowns, benchmarks and sector performance.',
  },
  {
    slug: 'risk',
    title: 'Risk',
    summary:
      'Value at risk, expected shortfall, covariance, drawdown risk and portfolio optimization.',
  },
  {
    slug: 'valuation',
    title: 'Valuation',
    summary:
      'DCF, NPV and IRR, WACC, comparables, dividend and residual-income models, loans and price-level conversion.',
  },
  {
    slug: 'fundamentals',
    title: 'Fundamentals',
    summary:
      'Statement ratios, quality scores (Piotroski, Altman, Beneish), growth and point-in-time availability.',
  },
  {
    slug: 'fixed-income',
    title: 'Fixed income',
    summary: 'Bonds, yields, duration and convexity, curves, swaps, caps, swaptions and futures.',
  },
  {
    slug: 'foreign-exchange',
    title: 'Foreign exchange',
    summary: 'Conversion, cross rates, forwards, swaps, non-deliverable forwards and hedging.',
  },
  {
    slug: 'commodities',
    title: 'Commodities',
    summary: 'Forwards, carry, convenience yield, roll yield, spreads and term structure.',
  },
  {
    slug: 'crypto',
    title: 'Crypto',
    summary:
      'Perpetual funding, futures basis, carry curves, inverse contracts and liquidation prices.',
  },
  {
    slug: 'scenarios',
    title: 'Scenarios',
    summary: 'Scenario runs across priced positions and portfolio scenario targets.',
  },
  {
    slug: 'structure',
    title: 'Exposure & flow',
    summary:
      'Dealer Greek exposure (gamma, vanna, charm and more), option flow and unusual activity.',
  },
  {
    slug: 'backtest',
    title: 'Backtesting',
    summary: 'Vectorized and event-driven backtests, costs, execution and tear sheets.',
  },
  {
    slug: 'research',
    title: 'Research',
    summary: 'Screens, factors, event studies and research hygiene.',
  },
  {
    slug: 'math',
    title: 'Math',
    summary:
      'Distributions, statistics, linear algebra, optimization, root finding and Monte Carlo.',
  },
  {
    slug: 'calendars',
    title: 'Calendars',
    summary: 'Exchange calendars (NYSE, Cboe, 24×7 crypto), holidays and option expirations.',
  },
  {
    slug: 'core',
    title: 'Core',
    summary:
      'Shared errors, conventions, validation, dates, formatting, OCC symbols and artifacts.',
  },
  {
    slug: 'workflows',
    title: 'Workflows',
    summary: 'The operation registry behind the CLI, HTTP server and MCP tools.',
  },
  {
    slug: 'cli',
    title: 'CLI',
    summary: 'The command-line interface over the operation registry.',
  },
  {
    slug: 'http',
    title: 'HTTP server',
    summary: 'A local HTTP/OpenAPI server over the operation registry.',
  },
  {
    slug: 'mcp',
    title: 'MCP server',
    summary: 'The optional @insiderfinance/totalfinance-mcp package for AI agents.',
  },
];

export const domainBySlug = new Map(DOMAINS.map((domain) => [domain.slug, domain]));
