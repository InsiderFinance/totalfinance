/**
 * The registry is a source of truth, so reading it must not be a way to write to it.
 *
 * A review found that it was. `getIndicator` handed back the LIVE entry, and `register` bound the
 * caller's own `parameters` array into the facade's runtime allowlist — the same array. So a reader
 * could turn Law 12 off for the whole process:
 *
 *     getIndicator('rsi')!.parameters.push('typo');
 *     rsi(values, { period: 14, typo: true });   // accepted, silently, everywhere
 *
 * The same objects reached `describeIndicator`, so discovery and MCP could be made to disclose one
 * set of conventions while `.explain()` disclosed another — the two halves of the disclosure law
 * contradicting each other, with nothing to notice.
 *
 * These tests attack every surface that hands an entry out. They assert the mutation is REFUSED, and
 * then — the part that actually matters — that behaviour downstream is unchanged, because a freeze
 * that silently no-ops in sloppy mode would pass a shallower test.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import * as ta from '@totalfinance/technical-analysis';
import { getIndicator, listIndicators, register } from '@totalfinance/technical-analysis/registry';
import { describeIndicator, searchIndicators } from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.2);

/** Does the facade still refuse an undeclared parameter? */
const rejectsUnknownKey = (): boolean => {
  try {
    (ta.rsi as unknown as (v: number[], p: unknown) => unknown)(closes, {
      period: 14,
      qzxTypo: true,
    });
    return false;
  } catch (error) {
    return isQuantError(error, 'input.unknown_field');
  }
};

describe('registry entries are frozen at registration', () => {
  it('the control: an undeclared parameter is refused', () => {
    expect(rejectsUnknownKey()).toBe(true);
  });

  it('getIndicator: pushing onto `parameters` throws and cannot disable Law 12', () => {
    const entry = getIndicator('rsi')!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.parameters)).toBe(true);
    expect(() => (entry.parameters as string[]).push('qzxTypo')).toThrow(TypeError);
    expect(rejectsUnknownKey(), 'Law 12 survived the mutation attempt').toBe(true);
  });

  it('getIndicator: replacing `parameters` wholesale throws', () => {
    const entry = getIndicator('rsi')!;
    expect(() => {
      (entry as { parameters: string[] }).parameters = ['period', 'qzxTypo'];
    }).toThrow(TypeError);
    expect(rejectsUnknownKey()).toBe(true);
  });

  it('getIndicator: `defaults` cannot be edited to change what `.explain()` discloses', () => {
    const entry = getIndicator('rsi')!;
    const before = ta.rsi.explain(closes).assumptions.parameters['period'];
    expect(() => {
      (entry.defaults as Record<string, unknown>)['period'] = 999;
    }).toThrow(TypeError);
    expect(ta.rsi.explain(closes).assumptions.parameters['period']).toBe(before);
  });

  it('listIndicators: the array is fresh, and its entries are the same frozen objects', () => {
    const first = listIndicators();
    first.push({ name: 'qzxFake' } as never); // harmless: a fresh array each call
    expect(listIndicators().some((e) => e.name === 'qzxFake')).toBe(false);
    const fromList = listIndicators().find((e) => e.name === 'rsi')!;
    expect(fromList).toBe(getIndicator('rsi'));
    expect(() => (fromList.parameters as string[]).push('qzxTypo')).toThrow(TypeError);
  });

  it('describeIndicator: its conventions cannot be edited into disagreeing with .explain()', () => {
    const described = describeIndicator('rsi');
    const disclosed = ta.rsi.explain(closes).assumptions.conventions;
    if (described.conventions !== undefined) {
      expect(() => {
        (described.conventions as Record<string, unknown>)['smoothing'] = 'qzxEma';
      }).toThrow(TypeError);
      // discovery and the direct path still agree
      expect(describeIndicator('rsi').conventions).toEqual(disclosed);
    }
    expect(() => (described.parameters as string[]).push('qzxTypo')).toThrow(TypeError);
    expect(rejectsUnknownKey()).toBe(true);
  });

  it('searchIndicators: results cannot be edited back into the registry', () => {
    const hit = searchIndicators({ query: 'rsi' }).indicators.find((r) => r.name === 'rsi');
    expect(hit).toBeDefined();
    // Whatever shape a result carries, nothing reachable from it may reopen the allowlist.
    expect(rejectsUnknownKey()).toBe(true);
  });

  /**
   * The MCP discovery path reads `describeIndicator` and forwards its `parameters` / `conventions`
   * into the tool's structured output. A review's scenario was to edit the conventions on the way
   * out so discovery advertised EMA smoothing while `rsi.explain()` kept reporting Wilder — two
   * disclosure surfaces contradicting each other with nothing to notice. It is closed at the source:
   * what discovery forwards is the frozen registry object.
   */
  it('the objects MCP discovery forwards are the frozen registry objects', () => {
    const described = describeIndicator('rsi');
    const entry = getIndicator('rsi')!;
    expect(described.parameters).toBe(entry.parameters);
    expect(Object.isFrozen(described.parameters)).toBe(true);
    if (described.conventions !== undefined) {
      expect(described.conventions).toBe(entry.conventions);
      expect(Object.isFrozen(described.conventions)).toBe(true);
    }
    expect(Object.isFrozen(described.output)).toBe(true);
  });

  it('register: the CALLER keeps their own array, and editing it afterwards changes nothing', () => {
    const parameters = ['period'];
    const conventions = { smoothing: 'wilder' } as never;
    const stream = ta.rsi.stream.bind(ta.rsi);
    register({
      name: 'qzxImmutabilityProbe',
      category: 'custom',
      inputs: 'series',
      parameters,
      defaults: { period: 14 },
      conventions,
      indicator: ta.rsi as never,
      output: { value: { type: 'number' }, visualization: { kind: 'line' } },
    });
    // the caller mutates their own array AFTER registering
    parameters.push('qzxLateAddition');
    const stored = getIndicator('qzxImmutabilityProbe')!;
    expect(stored.parameters).toEqual(['period']);
    expect(stored.parameters).not.toBe(parameters);
    expect(typeof stream).toBe('function');
  });
});
