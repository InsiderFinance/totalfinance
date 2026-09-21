import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import * as contracts from '../src/builtin-metadata.js';
import { withBuiltinMetadata, type BuiltinIndicatorMetadata } from '../src/indicator-metadata.js';
import { makeIndicator, snapshotOf, type IndicatorStream } from '../src/framework.js';
import { getIndicator, listIndicators, register, defineIndicator } from '../src/registry.js';
import { indicatorWarmups } from '../src/warmup.js';

const entries = listIndicators();
const parameters = new Map(indicatorWarmups(280).map((entry) => [entry.name, entry.parameters]));

describe('single-source built-in metadata', () => {
  it('preserves all discovery contracts and the catalog size', () => {
    expect(entries).toHaveLength(335);
    expect(new Set(entries.map((entry) => entry.indicator)).size).toBe(321);
    const named = contracts as unknown as Record<string, BuiltinIndicatorMetadata>;
    for (const entry of entries) {
      const declared: BuiltinIndicatorMetadata =
        named[`${entry.name}Metadata`] ?? contracts.candlestickMetadata;
      expect(entry.inputs, entry.name).toBe(declared.inputs);
      expect(entry.parameters, entry.name).toEqual(declared.parameters);
      expect(entry.defaults, entry.name).toEqual(declared.defaults);
      expect(entry.conventions, entry.name).toEqual(declared.conventions);
      expect(Object.isFrozen(entry.parameters), entry.name).toBe(true);
      if (entry.defaults) expect(Object.isFrozen(entry.defaults), entry.name).toBe(true);
    }
  });

  it.each([
    ['sma', 'rollingMean'],
    ['trima', 'symmetricWma'],
    ['stochastic', 'stochFast'],
    ['easeOfMovement', 'emv'],
    ['forceIndex', 'efi'],
    ['klinger', 'kvo'],
    ['beta', 'rollingBeta'],
    ['correl', 'rollingCorrelation'],
    ['rollingMinIndex', 'lowestBars'],
    ['rollingMaxIndex', 'highestBars'],
    ['shift', 'lag'],
    ['diff', 'change'],
    ['cdlDoji', 'doji'],
    ['cdlInside', 'inside'],
  ])('preserves facade identity for %s / %s', (first, second) => {
    expect(getIndicator(first)!.indicator).toBe(getIndicator(second)!.indicator);
  });

  it('keeps convention overwrite and inheritance distinct from discovery descriptions', () => {
    const stochastic = getIndicator('stochastic')!;
    const fast = getIndicator('stochFast')!;
    const bars = [{ high: 2, low: 1, close: 1.5 }];
    expect(stochastic.conventions).toHaveProperty('defaultForm');
    expect(fast.conventions).not.toHaveProperty('defaultForm');
    expect(stochastic.indicator.explain(bars).assumptions.conventions).toEqual(fast.conventions);
    for (const [first, alias, input] of [
      ['beta', 'rollingBeta', [{ x: 1, y: 2 }]],
      ['rollingMinIndex', 'lowestBars', [1, 2]],
      ['rollingMaxIndex', 'highestBars', [1, 2]],
    ] as const) {
      expect(getIndicator(alias)!.conventions).toBeUndefined();
      expect(
        getIndicator(alias)!.indicator.explain(input, { period: 2 }).assumptions.conventions,
      ).toEqual(getIndicator(first)!.conventions);
    }
  });

  it('keeps derived defaults callable and resolves them after caller overrides', () => {
    for (const [name, field] of [
      ['vidya', 'cmoPeriod'],
      ['chaikinVolatility', 'rocPeriod'],
      ['relativeVolatilityIndex', 'stdevPeriod'],
    ] as const) {
      const entry = getIndicator(name)!;
      expect(typeof entry.defaults![field]).toBe('function');
      const input = entry.inputs === 'bars' ? [{ high: 2, low: 1, close: 1.5 }] : [1, 2, 3];
      const explain = entry.indicator.explain;
      expect(explain(input, { period: 7 }).assumptions.parameters[field]).toBe(7);
      expect(explain(input, { period: 7, [field]: 3 }).assumptions.parameters[field]).toBe(3);
    }
    expect(
      getIndicator('relativeVolatilityIndex')!.indicator.explain([1, 2, 3]).assumptions.parameters,
    ).toEqual({ period: 14, stdevPeriod: 14 });
  });

  it('preserves nested default cloning and the intentional nullable period', () => {
    const tos = getIndicator('tosStdevAll')!.indicator;
    const first = tos.explain([1, 2, 3], { period: null });
    expect(first.assumptions.parameters).toEqual({ period: null, stds: [1, 2, 3], ddof: 1 });
    (first.assumptions.parameters['stds'] as number[]).push(99);
    expect(tos.explain([1, 2, 3]).assumptions.parameters['stds']).toEqual([1, 2, 3]);
    expect(() => getIndicator('rsi')!.indicator([1, 2, 3], { period: null })).toThrow(InputError);

    for (const name of ['kst', 'movingAverageRibbon', 'divergence']) {
      const entry = getIndicator(name)!;
      const input = entry.inputs === 'pair' ? [{ x: 1, y: 2 }] : [1, 2, 3];
      const initial = entry.indicator.explain(input).assumptions.parameters;
      const expected = structuredClone(initial);
      for (const value of Object.values(initial)) {
        if (Array.isArray(value)) value.push('changed');
        else if (value !== null && typeof value === 'object') Object.assign(value, { left: 99 });
      }
      expect(entry.indicator.explain(input).assumptions.parameters, name).toEqual(expected);
    }
  });

  it('retains runnable canonical parameters for every registered facade', () => {
    expect(parameters.size).toBe(entries.length);
  });
});

describe('binding is defensive without changing custom construction or registration', () => {
  class Scale implements IndicatorStream<number, number> {
    value: number | null = null;
    constructor(readonly scale: number) {}
    next(value: number): number {
      return (this.value = value * this.scale);
    }
    toJSON() {
      return snapshotOf('_metadataScale', { scale: this.scale, value: this.value });
    }
  }
  const make = (p: { scale?: number }) => new Scale(p.scale ?? 2);
  const restore = () => new Scale(2);

  it('bind-and-return preserves identity and protects caller-owned metadata containers', () => {
    const original = makeIndicator(make, restore, () => NaN);
    const conventions = { seed: 'test' };
    const metadata: BuiltinIndicatorMetadata = {
      inputs: 'series',
      parameters: ['scale'],
      defaults: { scale: 2, nested: { value: 3 } },
      conventions,
    };
    const bound = withBuiltinMetadata(original, metadata);
    expect(bound).toBe(original);
    (metadata.parameters as string[]).push('typo');
    (metadata.defaults!['nested'] as { value: number }).value = 99;
    conventions.seed = 'changed';
    expect(() => bound([1], { typo: 1 } as never)).toThrowError(/unknown field/);
    expect(bound.explain([1]).assumptions.parameters).toEqual({ scale: 2, nested: { value: 3 } });
    expect(bound.explain([1]).assumptions.conventions).toEqual({ seed: 'test' });
  });

  it('public makeIndicator retains its fourth defaults argument and custom register still binds', () => {
    const custom = makeIndicator(make, restore, () => NaN, { scale: 2 });
    expect(custom.explain([1, 2]).assumptions.parameters).toEqual({ scale: 2 });
    register({
      name: '_metadataCustom',
      category: 'custom',
      inputs: 'series',
      parameters: ['scale'],
      defaults: { scale: 2 },
      conventions: { seed: 'custom' },
      indicator: custom,
      output: { value: { type: 'number' } },
    });
    expect(custom.explain([1, 2]).assumptions.conventions).toEqual({ seed: 'custom' });
    expect(() => custom([1], { typo: 1 } as never)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputUnknownField }),
    );
    const defined = defineIndicator({
      name: '_metadataDefined',
      inputs: 'series',
      parameters: ['scale'],
      defaults: { scale: 2 },
      output: { value: { type: 'number' } },
      stream: make,
      restore,
      nan: () => NaN,
    });
    expect(defined([1, 2])).toEqual([2, 4]);
    expect(defined.explain([1]).assumptions.parameters).toEqual({ scale: 2 });
  });
});
