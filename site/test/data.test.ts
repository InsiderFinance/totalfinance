import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  parseDateCell,
  parseNumberCell,
  parseOhlcv,
  parseSeries,
  parseTable,
  tokenize,
} from '../src/data/csv.js';
import {
  closesToReturns,
  OHLCV_SAMPLES,
  RETURN_SAMPLES,
  SAMPLE_REGISTRY,
  syntheticBars,
  weekdaySessions,
} from '../src/data/samples.js';
import { inputToQuery, queryToInput } from '../src/url-state.js';
import { playgrounds } from '../src/playgrounds/index.js';
import { defaultInput, validateInputs } from '../src/playgrounds/inputs.js';

const options = { minRows: 2, maxRows: 100, label: 'Test data' };

describe('reader data parsing', () => {
  it('tokenizes quoted fields, doubled quotes and every line ending', () => {
    expect(tokenize('a,"b, c","say ""hi"""\r\n1,2,3\n\n4,5,6', ',')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
    expect(() => tokenize('a,"open', ',')).toThrow(/quoted field is not closed/);
  });

  it('detects tab, semicolon, comma and pipe delimiters', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1,5;2;3')).toBe(';');
    expect(detectDelimiter('a,b\n1,2')).toBe(',');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
  });

  it('reads numbers with separators, currency, percent and accounting negatives', () => {
    expect(parseNumberCell('1,234.50')).toBe(1234.5);
    expect(parseNumberCell('$99.10')).toBe(99.1);
    expect(parseNumberCell('-2.5%')).toBeCloseTo(-0.025, 12);
    expect(parseNumberCell('(3.2)')).toBe(-3.2);
    expect(parseNumberCell('1e-3')).toBe(0.001);
    for (const bad of ['', 'abc', '1.2.3', '--1']) expect(parseNumberCell(bad)).toBeNull();
  });

  it('reads ISO, US, compact and epoch dates, and refuses impossible ones', () => {
    expect(parseDateCell('2025-03-07')).toBe('2025-03-07');
    expect(parseDateCell('2025-03-07T15:30:00-05:00')).toBe('2025-03-07');
    expect(parseDateCell('3/7/2025')).toBe('2025-03-07');
    expect(parseDateCell('20250307')).toBe('2025-03-07');
    expect(parseDateCell('1741305600')).toBe('2025-03-07');
    expect(parseDateCell('1741305600000')).toBe('2025-03-07');
    expect(parseDateCell('2025-02-30')).toBeNull();
    expect(parseDateCell('yesterday')).toBeNull();
  });

  it('recognizes a header row only when a cell is neither a number nor a date', () => {
    expect(parseTable('date,close\n2025-01-02,100').header).toEqual(['date', 'close']);
    expect(parseTable('2025-01-02,100\n2025-01-03,101').header).toBeNull();
    expect(() => parseTable('   ')).toThrow(/header row and at least one data row/);
  });

  it('parses typical exports into OHLCV bars, oldest first, with notes', () => {
    const yahoo =
      'Date,Open,High,Low,Close,Adj Close,Volume\n2025-01-03,10,12,9,11,10.9,1000\n2025-01-02,9,10,8.5,9.5,9.4,900\n';
    const { value, notes } = parseOhlcv(yahoo, options);
    expect(value).toEqual({
      format: 'ohlcv',
      label: 'Test data',
      origin: 'reader',
      bars: [
        { date: '2025-01-02', open: 9, high: 10, low: 8.5, close: 9.5, volume: 900 },
        { date: '2025-01-03', open: 10, high: 12, low: 9, close: 11, volume: 1000 },
      ],
    });
    expect(notes[0]).toMatch(/^Columns used: date ← "Date", open ← "Open", .*close ← "Close"/);
    expect(notes.join(' ')).toMatch(/newest-first/);
    expect(notes.join(' ')).toMatch(/unadjusted close/);
    const tabs = parseOhlcv(
      'time\to\th\tl\tc\n2025-01-02\t1\t2\t0.5\t1.5\n2025-01-03\t1.5\t2\t1\t1.8',
      options,
    );
    expect(tabs.value.format === 'ohlcv' && tabs.value.bars[1]!.close).toBe(1.8);
    const headerless = parseOhlcv('2025-01-02,1,2,0.5,1.5\n2025-01-03,1.5,2,1,1.8', options);
    expect(headerless.notes.join(' ')).toMatch(/No header row/);
  });

  it('names the line and column of every refusal', () => {
    expect(() =>
      parseOhlcv(
        'date,open,high,low,close\n2025-01-02,1,2,0.5,1.5\n2025-01-03,1,0.5,0.4,1',
        options,
      ),
    ).toThrow(/Line 3: high must be the highest/);
    expect(() =>
      parseOhlcv('date,open,high,low,close\n2025-01-02,1,2,0.5,1.5\nnope,1,2,0.5,1.5', options),
    ).toThrow(/Line 3: "date" "nope" is not a date/);
    expect(() =>
      parseOhlcv('date,open,high,low,close\n2025-01-02,1,2,0.5,x\n2025-01-03,1,2,0.5,1', options),
    ).toThrow(/Line 2: close "x" must be a positive number/);
    expect(() => parseOhlcv('day,price\n2025-01-02,1', options)).toThrow(
      /Missing open, high, low column/,
    );
    expect(() =>
      parseOhlcv(
        'date,open,high,low,close\n2025-01-02,1,2,0.5,1.5\n2025-01-02,1,2,0.5,1.5',
        options,
      ),
    ).toThrow(/Dates must be unique and in order/);
    expect(() => parseOhlcv('date,open,high,low,close\n2025-01-02,1,2,0.5,1.5', options)).toThrow(
      /At least 2 bars/,
    );
  });

  it('keeps the most recent rows above the limit and says so', () => {
    const rows = Array.from({ length: 5 }, (_, index) => `2025-01-0${index + 2},1,2,0.5,1`).join(
      '\n',
    );
    const { value, notes } = parseOhlcv(`date,open,high,low,close\n${rows}`, {
      ...options,
      maxRows: 3,
    });
    expect(value.format === 'ohlcv' && value.bars.map((bar) => bar.date)).toEqual([
      '2025-01-04',
      '2025-01-05',
      '2025-01-06',
    ]);
    expect(notes.join(' ')).toMatch(/Kept the most recent 3 of 5/);
  });

  it('parses series of prices or returns, with or without dates', () => {
    expect(parseSeries('100\n101\n102.5', { ...options, meaning: 'prices' }).value).toEqual({
      format: 'series',
      label: 'Test data',
      origin: 'reader',
      meaning: 'prices',
      values: [100, 101, 102.5],
    });
    const dated = parseSeries('date,return\n2025-01-03,0.01\n2025-01-02,-0.02', {
      ...options,
      meaning: 'returns',
    });
    expect(dated.value).toMatchObject({
      values: [-0.02, 0.01],
      dates: ['2025-01-02', '2025-01-03'],
    });
    expect(() => parseSeries('a\n0.1\n-1.5', { ...options, meaning: 'returns' })).toThrow(
      /−100% or worse/,
    );
    expect(() => parseSeries('100\n-5', { ...options, meaning: 'prices' })).toThrow(
      /must be positive/,
    );
    expect(parseSeries('r\n2\n-0.5', { ...options, meaning: 'returns' }).notes.join(' ')).toMatch(
      /exceed ±100%/,
    );
  });
});

describe('synthetic samples', () => {
  it('are deterministic, internally consistent and labelled synthetic', () => {
    expect(syntheticBars(7, 100, [{ sessions: 30, drift: 0.001, volatility: 0.01 }])).toEqual(
      syntheticBars(7, 100, [{ sessions: 30, drift: 0.001, volatility: 0.01 }]),
    );
    for (const sample of [...OHLCV_SAMPLES, ...RETURN_SAMPLES]) {
      expect(sample.value.label).toMatch(/[Ss]ynthetic/);
      expect(sample.value.label).toMatch(/not market data/);
      expect(sample.value.origin).toBe('sample');
    }
    for (const sample of OHLCV_SAMPLES) {
      if (sample.value.format !== 'ohlcv') throw new Error('expected bars');
      for (const bar of sample.value.bars) {
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close, bar.low));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
        expect(bar.low).toBeGreaterThan(0);
      }
    }
    expect(SAMPLE_REGISTRY.size).toBe(OHLCV_SAMPLES.length + RETURN_SAMPLES.length);
  });

  it('weekday sessions skip weekends and returns derive from consecutive closes', () => {
    expect(weekdaySessions('2025-01-03', 3)).toEqual(['2025-01-03', '2025-01-06', '2025-01-07']);
    expect(
      closesToReturns([
        { date: 'a', open: 1, high: 1, low: 1, close: 100 },
        { date: 'b', open: 1, high: 1, low: 1, close: 110 },
      ]),
    ).toEqual([0.1]);
  });
});

describe('shareable URL state', () => {
  it('round-trips numbers, options, tables and samples, and never shares reader data', () => {
    for (const playground of playgrounds) {
      const input = defaultInput(playground);
      const { query, omitted } = inputToQuery(playground.controls, input);
      expect(omitted).toEqual([]);
      expect(
        validateInputs(playground, {
          ...defaultInput(playground),
          ...queryToInput(playground.controls, query),
        }),
      ).toEqual(input);
    }
    const backtest = playgrounds.find((playground) => playground.id === 'backtest-a-strategy')!;
    const reader = {
      ...defaultInput(backtest),
      data: { format: 'ohlcv', label: 'Mine', origin: 'reader', bars: [] },
    } as never;
    const shared = inputToQuery(backtest.controls, reader);
    expect(shared.omitted).toEqual(['Price data']);
    expect(shared.query).not.toContain('data=');
  });

  it('ignores damaged or unknown parameters', () => {
    const options = playgrounds[0]!;
    expect(queryToInput(options.controls, 'spot=abc&strike=&volatility=0.3&unknown=1')).toEqual({
      volatility: 0.3,
    });
    const strategy = playgrounds.find((playground) => playground.id === 'analyze-a-strategy')!;
    expect(queryToInput(strategy.controls, 'legs=%%%')).toEqual({});
  });
});
