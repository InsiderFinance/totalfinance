import { describe, expect, it } from 'vitest';
import {
  formatOccSymbol,
  isOccOptionSymbol,
  parseOccSymbol,
  selectQuotePrice,
  resolvedExpiry,
} from '@totalfinance/core';
import type { OptionQuote } from '@totalfinance/core';

describe('OCC symbology', () => {
  it('parses a call symbol', () => {
    expect(parseOccSymbol('AAPL260918C00105000')).toEqual({
      root: 'AAPL',
      expiry: '2026-09-18',
      ...resolvedExpiry('2026-09-18'),
      type: 'call',
      strike: 105,
    });
  });

  it('parses a put with a fractional strike', () => {
    expect(parseOccSymbol('SPY260320P00450500')).toEqual({
      root: 'SPY',
      expiry: '2026-03-20',
      ...resolvedExpiry('2026-03-20'),
      type: 'put',
      strike: 450.5,
    });
  });

  it('round-trips parse → format', () => {
    const sym = 'AAPL260918C00105000';
    expect(formatOccSymbol(parseOccSymbol(sym))).toBe(sym);
  });

  it('formats from components', () => {
    expect(formatOccSymbol({ root: 'aapl', expiry: '2026-09-18', type: 'call', strike: 105 })).toBe(
      'AAPL260918C00105000',
    );
  });

  it('rejects malformed input', () => {
    expect(() => parseOccSymbol('NOTASYMBOL')).toThrowError(/OCC option symbol/);
  });

  it('isOccOptionSymbol answers exactly what the parser accepts, and only for strings', () => {
    // The predicate is the one OCC grammar asked as a question: a broker or plan uses it to refuse
    // treating a contract as a share, so it must agree with the parser on every input.
    for (const symbol of ['AAPL260918C00200000', 'spy 261218p00450000', ' TSLA250117C00250000 '])
      expect([symbol, isOccOptionSymbol(symbol)]).toEqual([symbol, true]);
    for (const symbol of [
      'AAPL',
      'BTC-USD',
      'NOTASYMBOL',
      'AAPL260918X00200000',
      '',
      '260918C00200000',
    ])
      expect([symbol, isOccOptionSymbol(symbol)]).toEqual([symbol, false]);
    for (const value of [null, undefined, 42, {}])
      expect(() => isOccOptionSymbol(value as never)).toThrowError(/symbol must be a string/);
  });

  // WS1.9: dates must be validated as real calendar dates in BOTH directions.
  it('rejects an impossible date on parse (2099-13-32)', () => {
    expect(() => parseOccSymbol('AAPL991332C00105000')).toThrowError(/valid calendar date|date/i);
  });

  it('rejects an impossible date on format', () => {
    expect(() =>
      formatOccSymbol({ root: 'AAPL', expiry: '2026-13-45', type: 'call', strike: 105 }),
    ).toThrowError(/date/i);
  });

  it('uppercases a lowercase root on parse (round-trip symmetry)', () => {
    expect(parseOccSymbol('aapl260918C00105000').root).toBe('AAPL');
    const parsed = parseOccSymbol('aapl260918C00105000');
    expect(formatOccSymbol(parsed)).toBe('AAPL260918C00105000');
  });

  it('round-trips a range of valid contracts', () => {
    for (const sym of [
      'SPY260320P00450500',
      'TSLA271217C01234500',
      'A300101P00000500', // single-char root, minimal strike
    ]) {
      expect(formatOccSymbol(parseOccSymbol(sym))).toBe(sym);
    }
  });
});

describe('selectQuotePrice', () => {
  const quote: OptionQuote = {
    contract: {
      underlying: 'AAPL',
      type: 'call',
      style: 'american',
      strike: 100,
      expiry: '2026-09-18',
      ...resolvedExpiry('2026-09-18'),
    },
    timestampMs: Date.UTC(2026, 5, 18),
    bid: 3.1,
    ask: 3.3,
    last: 3.25,
  };

  it('selects explicit sources', () => {
    expect(selectQuotePrice(quote, 'bid')).toBe(3.1);
    expect(selectQuotePrice(quote, 'ask')).toBe(3.3);
    expect(selectQuotePrice(quote, 'last')).toBe(3.25);
  });

  it('derives mid from bid/ask when no explicit mid', () => {
    expect(selectQuotePrice(quote, 'mid')).toBeCloseTo(3.2, 12);
  });

  it('returns undefined when the source is missing', () => {
    const { last: _omitLast, ...noLast } = quote;
    expect(selectQuotePrice(noLast, 'last')).toBeUndefined();
  });
});

describe('formatOccSymbol type enum (a typo must never emit a PUT symbol)', () => {
  it("rejects anything but exactly 'call'/'put'", () => {
    for (const bad of ['CALL', 'Call', 'C', 'cal']) {
      expect(() =>
        formatOccSymbol({ root: 'SPY', expiry: '2026-06-19', type: bad as never, strike: 500 }),
      ).toThrowError(/type must be 'call' or 'put'/);
    }
  });
});
