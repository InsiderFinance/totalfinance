import { describe, expect, it } from 'vitest';
import {
  ALIAS_TABLE,
  aliasesOf,
  compatibilityMatrixMarkdown,
  getIndicator,
  hasIndicator,
  resolveIndicator,
  resolveIndicatorName,
  type BarInput,
} from '@totalfinance/technical-analysis';

const toArray = (x?: string | string[]): string[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];
const externalNames = (r: (typeof ALIAS_TABLE)[number]): string[] => [
  ...toArray(r.talib),
  ...toArray(r.pandas),
  ...(r.tradingview ? [r.tradingview] : []),
];

describe('name resolution', () => {
  it('resolves TA-Lib, pandas-ta and TradingView names to the canonical name', () => {
    expect(resolveIndicatorName('WILLR')).toBe('williamsR'); // TA-Lib
    expect(resolveIndicatorName('willr')).toBe('williamsR'); // pandas-ta
    expect(resolveIndicatorName('Williams %R')).toBe('williamsR'); // TradingView
    expect(resolveIndicatorName('williamsR')).toBe('williamsR'); // canonical
  });
  it('is case-insensitive on canonical names (exact match wins)', () => {
    expect(resolveIndicatorName('RSI')).toBe('rsi');
    expect(resolveIndicatorName('Rsi')).toBe('rsi');
    expect(resolveIndicatorName('rsi')).toBe('rsi');
    expect(resolveIndicatorName('SMA')).toBe('sma');
  });
  it('returns undefined for an unknown name', () => {
    expect(resolveIndicatorName('definitelyNotAnIndicator')).toBeUndefined();
    expect(resolveIndicator('nope')).toBeUndefined();
  });
  it('resolveIndicator returns a usable registered indicator', () => {
    const r = resolveIndicator('WILLR')!;
    expect(r.name).toBe('williamsR');
    const bars: BarInput[] = Array.from({ length: 30 }, (_, i) => ({
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
    }));
    expect(r.indicator(bars, { period: 14 })).toHaveLength(bars.length);
  });
});

describe('alias table integrity', () => {
  it('every row targets a registered indicator', () => {
    for (const row of ALIAS_TABLE) {
      expect(hasIndicator(row.totalfinance), row.totalfinance).toBe(true);
    }
  });
  it('every external name resolves to the same indicator object as its canonical target', () => {
    for (const row of ALIAS_TABLE) {
      const target = getIndicator(row.totalfinance)!.indicator;
      for (const name of externalNames(row)) {
        const resolved = resolveIndicator(name);
        // Object identity, not name — handles short forms that are themselves registered aliases
        // (e.g. `efi` is a registered canonical that IS `forceIndex`).
        expect(resolved?.indicator, name).toBe(target);
      }
    }
  });
  it('has no duplicate canonical rows', () => {
    const names = ALIAS_TABLE.map((r) => r.totalfinance);
    expect(new Set(names).size).toBe(names.length);
  });
  it('aliasesOf returns the row for a canonical name', () => {
    const row = aliasesOf('williamsR')!;
    expect(row.talib).toBe('WILLR');
    expect(row.pandas).toBe('willr');
    expect(aliasesOf('definitelyNotAnIndicator')).toBeUndefined();
  });
});

describe('compatibility matrix', () => {
  it('renders a grouped Markdown matrix with the canonical/TA-Lib/pandas/TradingView columns', () => {
    const md = compatibilityMatrixMarkdown();
    expect(md).toContain('# TotalFinance indicator compatibility matrix');
    expect(md).toContain('| TotalFinance | TA-Lib | pandas-ta | TradingView |');
    expect(md).toContain('`williamsR`');
    expect(md).toContain('`WILLR`');
    expect(md).toContain('Williams %R');
    // every mapped indicator appears
    for (const row of ALIAS_TABLE) {
      expect(md, row.totalfinance).toContain(`\`${row.totalfinance}\``);
    }
  });
});
