import { describe, expect, it } from 'vitest';
import type { Bar } from '@totalfinance/core';
import { ohlcvFromBars } from '@totalfinance/technical-analysis';
import { ohlcvFromBars as subpathProjection } from 'totalfinance/technical-analysis';
import { technicalAnalysis } from 'totalfinance';
import { TA_FIXTURES } from './ta.js';

const aliases = [
  ['technical-analysis.ohlcvFromBars', ohlcvFromBars],
  ['totalfinance.ohlcvFromBars', subpathProjection],
  ['totalfinance.technicalAnalysis.ohlcvFromBars', technicalAnalysis.ohlcvFromBars],
] as const;

describe('chronological source projection fixtures for every public spelling', () => {
  it.each(aliases)('%s supplies valid fresh source observations', (key, project) => {
    const bars = TA_FIXTURES[key]!()[0] as Bar[];
    expect(project(bars)).toHaveLength(5);
    bars[1]!.timestampMs = bars[0]!.timestampMs;
    expect(() => project(bars)).toThrow(expect.objectContaining({ code: 'input.out_of_range' }));
    expect(project(TA_FIXTURES[key]!()[0] as Bar[])).toHaveLength(5);
  });

  it('each alias fixture rebuilds the same observations rather than sharing mutated input', () => {
    const inputs = aliases.map(([key]) => TA_FIXTURES[key]!()[0] as Bar[]);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[1]).toEqual(inputs[2]);
    expect(inputs[0]).not.toBe(inputs[1]);
    expect(inputs[1]![0]).not.toBe(inputs[2]![0]);
  });
});
