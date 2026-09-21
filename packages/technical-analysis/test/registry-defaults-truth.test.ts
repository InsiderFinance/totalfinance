import { describe, expect, it } from 'vitest';
import { snapshotOf } from '@totalfinance/technical-analysis';
import { InputError } from '@totalfinance/core';
import {
  defineIndicator,
  getIndicator,
  listIndicators,
  register,
} from '@totalfinance/technical-analysis/registry';
import { indicatorWarmups } from '@totalfinance/technical-analysis/warmup';
import { pairs } from '@totalfinance/technical-analysis/statistics';
import type {
  BarInput,
  Indicator,
  IndicatorStream,
  TechnicalAnalysisSnapshot,
} from '@totalfinance/technical-analysis';

/**
 * THE TRUTH TEST for the disclosure law (dx R1): for EVERY registered indicator, the defaults the
 * registry declares must be the defaults the implementation actually engages.
 *
 *   (i)  An indicator whose parameters are all defaulted accepts a no-param call, and
 *        `.explain().assumptions.parameters` echoes EVERY declared param with a concrete value.
 *   (ii) Re-running with those echoed parameters passed explicitly produces IDENTICAL output — the
 *        declared defaults are the real ones, not documentation fiction.
 *  (iii) An indicator with required parameters throws a typed InputError on the no-param call
 *        (coherence: a param we claim is required really is), and with only the required parameters
 *        supplied the OPTIONAL parameters still echo their engaged defaults — and the echo round-trips
 *        to identical output.
 */

type AnyInd = Indicator<Record<string, unknown>, unknown, unknown>;
const indicators = listIndicators();
const canonicalByName = new Map(indicatorWarmups(280).map((w) => [w.name, w.parameters]));

function probe(n: number): { series: number[]; bars: BarInput[]; pair: ReturnType<typeof pairs> } {
  const series: number[] = [];
  for (let i = 0; i < n; i++)
    series.push(100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1));
  const bars: BarInput[] = series.map((c, i) => {
    const open = i === 0 ? c : series[i - 1]!;
    return {
      open,
      high: Math.max(open, c) + 1 + (i % 3) * 0.5,
      low: Math.min(open, c) - 1 - (i % 4) * 0.3,
      close: c,
      volume: 1000 + ((i * 53) % 400),
    };
  });
  const other = series.map((v, i) => v + Math.cos(i / 4) * 3);
  return { series, bars, pair: pairs(series, other) };
}
const d = probe(260);
const inputFor = (inputs: string): readonly unknown[] =>
  inputs === 'series' ? d.series : inputs === 'bars' ? d.bars : d.pair;

/** NaN-aware deep equality (warmup slots and record outputs carry NaN sentinels). */
function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function expectIdentical(name: string, a: unknown[], b: unknown[]): void {
  expect(b.length, `${name}: echoed-parameters rerun changed the output length`).toBe(a.length);
  for (let i = 0; i < a.length; i++) {
    expect(eq(a[i], b[i]), `${name}[${i}]: echoed parameters did not reproduce the output`).toBe(
      true,
    );
  }
}

describe('disclosure law: declared defaults are the engaged defaults (every indicator)', () => {
  for (const e of indicators) {
    const declared = e.parameters;
    const defaults = e.defaults ?? {};
    const required = declared.filter((p) => !(p in defaults));
    const ind = e.indicator as AnyInd;
    const input = inputFor(e.inputs);

    if (required.length === 0) {
      it(`${e.name} — no-param call echoes and round-trips all ${declared.length} parameters`, () => {
        // (i) the no-param call is legal and the echo covers every declared param, concretely.
        const bare = ind.explain(input);
        const echoed = bare.assumptions.parameters;
        for (const p of declared) {
          expect(p in echoed, `${e.name}: param "${p}" missing from assumptions.parameters`).toBe(
            true,
          );
          expect(echoed[p], `${e.name}: param "${p}" echoed as undefined`).not.toBe(undefined);
        }
        // Nothing beyond the declared parameters is echoed (no junk keys).
        for (const k of Object.keys(echoed)) {
          expect(declared.includes(k), `${e.name}: echoed undeclared param "${k}"`).toBe(true);
        }
        // (ii) the echoed parameters reproduce the computation exactly.
        const rerun = ind.explain(input, echoed as Record<string, unknown>);
        expectIdentical(e.name, bare.value, rerun.value);
        expect(rerun.diagnostics.warmup).toBe(bare.diagnostics.warmup);
      });
    } else {
      it(`${e.name} — required [${required.join(', ')}] throw when omitted; optional parameters echo defaults`, () => {
        // (iii-a) coherence: a param we claim is required really is required.
        expect(() => ind(input)).toThrowError(InputError);
        // (iii-b) with ONLY the required parameters, every optional param still echoes its default.
        const canonical = canonicalByName.get(e.name)!;
        const minimal: Record<string, unknown> = {};
        for (const p of required) minimal[p] = canonical[p];
        const run = ind.explain(input, minimal);
        const echoed = run.assumptions.parameters;
        for (const p of declared) {
          expect(p in echoed, `${e.name}: param "${p}" missing from assumptions.parameters`).toBe(
            true,
          );
          expect(echoed[p], `${e.name}: param "${p}" echoed as undefined`).not.toBe(undefined);
        }
        for (const p of required) {
          expect(eq(echoed[p], minimal[p]), `${e.name}: required "${p}" echo differs`).toBe(true);
        }
        // (iii-c) and the full echo round-trips to the identical output.
        const rerun = ind.explain(input, echoed as Record<string, unknown>);
        expectIdentical(e.name, run.value, rerun.value);
        expect(rerun.diagnostics.warmup).toBe(run.diagnostics.warmup);
      });
    }
  }

  it('every parameterized indicator declares its optional/required split (sanity census)', () => {
    // The split itself is data-driven; this pins the shape so a future registration can't silently
    // regress to "no defaults declared anywhere" (the pre-DX2 state: 6 of 216 disclosed).
    const parameterized = indicators.filter((e) => e.parameters.length > 0);
    const withDefaults = parameterized.filter((e) => Object.keys(e.defaults ?? {}).length > 0);
    expect(parameterized.length).toBeGreaterThan(150);
    expect(withDefaults.length).toBeGreaterThan(100);
  });
});

describe('disclosure law: the defaults channel works for custom defineIndicator indicators', () => {
  class ConstStream implements IndicatorStream<number, number> {
    value: number | null = null;
    constructor(private readonly k: number) {}
    next(v: number): number | null {
      this.value = v * this.k;
      return this.value;
    }
    toJSON(): TechnicalAnalysisSnapshot {
      return snapshotOf('_truthCustomScale', { k: this.k, value: this.value });
    }
  }

  it('defineIndicator no longer drops defaults: explain echoes them merged under user parameters', () => {
    const custom = defineIndicator<{ k?: number }, number, number>({
      name: '_truthCustomScale',
      inputs: 'series',
      output: { value: { type: 'number' } },
      parameters: ['k'],
      defaults: { k: 2 },
      stream: (p) => new ConstStream(p.k ?? 2),
      restore: (s) => {
        const x = new ConstStream(s.state['k'] as number);
        x.value = s.state['value'] as number | null;
        return x;
      },
      nan: () => NaN,
    });
    expect(custom.explain([1, 2, 3]).assumptions.parameters).toEqual({ k: 2 });
    expect(custom.explain([1, 2, 3], { k: 5 }).assumptions.parameters).toEqual({ k: 5 });
    expect(custom([1, 2, 3])).toEqual([2, 4, 6]);
    expect(getIndicator('_truthCustomScale')?.defaults).toEqual({ k: 2 });
  });

  it('register/defineIndicator validate the inputs enum (registry integrity)', () => {
    expect(() =>
      defineIndicator<Record<string, never>, number, number>({
        name: '_truthBadInputs',
        // @ts-expect-error — deliberately invalid inputs kind
        inputs: 'serie',
        stream: () => new ConstStream(1),
        restore: () => new ConstStream(1),
        nan: () => NaN,
      }),
    ).toThrowError(/inputs must be one of series \| bars \| pair/);
    expect(() =>
      register({
        name: '_truthBadInputs2',
        category: 'custom',
        // @ts-expect-error — undefined inputs used to register and mis-route as 'pair'
        inputs: undefined,
        parameters: [],
        indicator: (() => []) as never,
      }),
    ).toThrowError(/inputs must be one of/);
  });

  it('register rejects a default declared for an undeclared param', () => {
    expect(() =>
      defineIndicator<{ k?: number }, number, number>({
        name: '_truthBadDefault',
        inputs: 'series',
        output: { value: { type: 'number' } },
        parameters: ['k'],
        defaults: { notAParam: 1 },
        stream: (p) => new ConstStream(p.k ?? 2),
        restore: (s) => new ConstStream(s.state['k'] as number),
        nan: () => NaN,
      }),
    ).toThrowError(/declares a default for "notAParam"/);
  });

  it('the echo is mutation-safe: editing returned parameters cannot corrupt the registry defaults', () => {
    const div = getIndicator('divergence')!.indicator as AnyInd;
    const first = div.explain(d.pair).assumptions.parameters as { swing: { left: number } };
    first.swing.left = 999;
    const second = div.explain(d.pair).assumptions.parameters as { swing: { left: number } };
    expect(second.swing.left).toBe(5);
  });
});
