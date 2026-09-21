import { describe, expect, it } from 'vitest';
import { search, type SearchRecord } from '../src/search.js';

function record(
  title: string,
  kind = 'function',
  overrides: Partial<SearchRecord> = {},
): SearchRecord {
  return {
    title,
    kind,
    category: '@totalfinance/options',
    url: `/#${title}`,
    description: 'European option',
    keywords: '',
    ...overrides,
  };
}

describe('search relevance contract', () => {
  const records = [
    record('BlackScholesPriceInput', 'interface'),
    record('blackScholesPriceMany'),
    record('blackScholesPrice', 'function', { category: 'totalfinance' }),
    record('blackScholesPrice'),
    record('blackScholes', 'value'),
    record('Price a European call', 'task', { keywords: 'price-an-option' }),
    record('option', 'function', { description: 'Price an option' }),
    record('Guide', 'guide', { keywords: 'black scholes price an option' }),
    record('PortfolioPnlComponents', 'interface'),
    record('portfolioPnl'),
    record('SectorPerformanceInput', 'interface'),
    record('sectorPerformance'),
  ];

  it.each(['black scholes', 'Black–Scholes', 'BLACK_SCHOLES', 'blackScholes'])(
    'normalizes %s to the facade, then functions before incidental types',
    (query) => {
      const matches = search(records, query);
      expect(matches[0]!.title).toBe('blackScholes');
      expect(matches[1]!.title).toBe('blackScholesPrice');
      expect(matches[1]!.category).toBe('@totalfinance/options');
      expect(matches.findIndex((row) => row.kind === 'interface')).toBeGreaterThan(3);
    },
  );

  it.each(['blackScholesPrice', 'BLACKSCHOLESPRICE', 'black scholes price'])(
    'keeps exact %s ahead of a batch variant and exposes both package imports',
    (query) => {
      const matches = search(records, query);
      expect(matches.slice(0, 2).map((row) => row.category)).toEqual([
        '@totalfinance/options',
        'totalfinance',
      ]);
      expect(matches.slice(0, 2).every((row) => row.title === 'blackScholesPrice')).toBe(true);
    },
  );

  it('keeps an explicitly requested type first', () => {
    expect(search(records, 'BlackScholesPriceInput')[0]!.title).toBe('BlackScholesPriceInput');
  });
  it.each(['portfolio P&L', 'portfolio pnl', 'PORTFOLIO_PNL'])(
    'normalizes %s without letting supporting types bury the calculation',
    (query) => {
      expect(search(records, query)[0]!.title).toBe('portfolioPnl');
    },
  );
  it('matches domain phrases and task slugs without a per-export ranking table', () => {
    expect(search(records, 'sector performance')[0]!.title).toBe('sectorPerformance');
    expect(search(records, 'price an option')[0]!.kind).toBe('task');
  });
  it('preserves all-term filtering, result bounds, tie order, empty queries, and old indexes', () => {
    expect(search(records, 'black scholes absent')).toEqual([]);
    expect(search(records, ' -- ')).toEqual([]);
    expect(search(records, 'option', 0)).toEqual([]);
    expect(search(records, 'black', 2)).toHaveLength(2);
    const legacy = [record('one'), record('two')];
    delete legacy[0]!.kind;
    delete legacy[1]!.kind;
    expect(search(legacy, 'European')).toEqual(legacy);
    expect(search(records, 'black')).toEqual(search(records, 'black'));
  });
});
