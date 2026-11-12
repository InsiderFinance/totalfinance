import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/highlight.js';
import { siteExampleCases } from '../../tools/site-examples-smoke.js';

describe('isomorphic code highlighter', () => {
  it('is lossless: tokens reassemble every copied example exactly', () => {
    for (const sample of siteExampleCases())
      expect(
        tokenize(sample.code)
          .map((token) => token.text)
          .join(''),
      ).toBe(sample.code);
  });

  it('classifies keywords, strings, numbers, comments, types and calls', () => {
    const tokens = tokenize(
      "import { sma } from 'x';\n// note\nconst average: number[] = sma(values, { period: 20 });",
    );
    const classOf = (text: string) => tokens.find((token) => token.text.includes(text))?.cls;
    expect(classOf('import')).toBe('k');
    expect(classOf("'x'")).toBe('s');
    expect(classOf('// note')).toBe('c');
    expect(classOf('number')).toBe('t');
    expect(classOf('20')).toBe('n');
    expect(tokens.some((token) => token.cls === 'f' && token.text === 'sma')).toBe(true);
  });

  it('marks JSON keys apart from string values and keeps NaN visible', () => {
    const tokens = tokenize('{\n  "price": NaN,\n  "model": "black-scholes"\n}', 'json');
    expect(tokens.find((token) => token.text === '"price"')?.cls).toBe('x');
    expect(tokens.find((token) => token.text === '"black-scholes"')?.cls).toBe('s');
    expect(tokens.find((token) => token.text === 'NaN')?.cls).toBe('n');
  });
});
