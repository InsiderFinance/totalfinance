import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, type Computed } from '@totalfinance/core';
import type { Pricer } from '@totalfinance/core/pricing';
import {
  detachCanonicalData,
  scanCanonicalData,
  snapshotClosedRecord,
  snapshotDenseArray,
} from '../src/internal/data.js';
import { scenarioTarget } from '../src/targets.js';

const scanOptions = {
  functionName: 'boundaryTest',
  label: 'value',
  maximumDepth: 64,
  requireFiniteNumbers: true,
} as const;

function inertPricer(): Pricer<{ symbol: string }> {
  return {
    name: 'test.inert',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: () => true,
    requirements: () => [],
    price: () =>
      ({
        value: 1,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      }) satisfies Computed<number>,
  };
}

describe('canonical scenario-data boundary', () => {
  it('uses the specified deterministic primitive, string, array, and object costs', () => {
    expect(scanCanonicalData(null, scanOptions)).toBe(1);
    expect(scanCanonicalData('x', scanOptions)).toBe(2);
    expect(scanCanonicalData([1, 'x'], scanOptions)).toBe(6);
    expect(scanCanonicalData({ a: 1 }, scanOptions)).toBe(5);
  });

  it('rejects accessors without invoking them, including in builder descriptors', () => {
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'value', {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });

    expect(() => scanCanonicalData(hostile, scanOptions)).toThrow(/accessors/);
    expect(() =>
      snapshotClosedRecord(hostile, {
        functionName: 'boundaryTest',
        label: 'input',
        allowedKeys: ['value'],
      }),
    ).toThrow(/data property/);
    expect(() =>
      scenarioTarget.fullRevaluation({
        id: 'hostile',
        quantity: 1,
        contractMultiplier: 1,
        currency: 'USD',
        instrument: { symbol: 'AAPL' },
        instrumentDescriptor: hostile,
        pricer: inertPricer(),
      }),
    ).toThrow(/accessors/);
    expect(reads).toBe(0);
  });

  it('rejects cycles and nesting deeper than 64 without recursive traversal', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => scanCanonicalData(cyclic, scanOptions)).toThrow(/cycle/);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 65; index++) deep = { child: deep };
    expect(() => scanCanonicalData(deep, scanOptions)).toThrow(/deeper than 64/);
  });

  it('rejects sparse/accessor arrays, hidden members, symbols, and custom prototypes', () => {
    const sparse = new Array<unknown>(2);
    sparse[0] = 1;
    expect(() => scanCanonicalData(sparse, scanOptions)).toThrow(/dense/);
    expect(() => snapshotDenseArray(sparse, 'boundaryTest', 'items')).toThrow(/sparse/);

    const accessorArray = [1];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        throw new Error('must not run');
      },
    });
    expect(() => scanCanonicalData(accessorArray, scanOptions)).toThrow(/accessor/);

    const hidden = {};
    Object.defineProperty(hidden, 'secret', { enumerable: false, value: 1 });
    expect(() => scanCanonicalData(hidden, scanOptions)).toThrow(/hidden members/);

    const symbol = { [Symbol('secret')]: 1 };
    expect(() => scanCanonicalData(symbol, scanOptions)).toThrow(/symbol member/);

    const custom = Object.create({ inherited: true }) as Record<string, unknown>;
    custom['value'] = 1;
    expect(() => scanCanonicalData(custom, scanOptions)).toThrow(/custom prototype/);
  });

  it('rejects serialization/coercion behavior and permits acyclic shared references', () => {
    let calls = 0;
    const hostile = {
      value: 1,
      toJSON() {
        calls += 1;
        return { value: 1 };
      },
    };
    expect(() => scanCanonicalData(hostile, scanOptions)).toThrow(/function/);
    expect(calls).toBe(0);

    const shared = { value: 1 };
    expect(() => scanCanonicalData({ left: shared, right: shared }, scanOptions)).not.toThrow();
  });

  it('detaches and deeply freezes canonical data without freezing the caller value', () => {
    const source = { rows: [{ value: 1 }] };
    const detached = detachCanonicalData(source, scanOptions);

    expect(detached).toEqual(source);
    expect(detached).not.toBe(source);
    expect(Object.isFrozen(detached)).toBe(true);
    expect(Object.isFrozen(detached.rows)).toBe(true);
    expect(Object.isFrozen(detached.rows[0])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.rows)).toBe(false);
    expect(Object.isFrozen(source.rows[0])).toBe(false);
  });

  it('stops at the configured work limit instead of cloning or hashing oversized data', () => {
    const oversized = { text: 'x'.repeat(512) };
    expect(() => scanCanonicalData(oversized, { ...scanOptions, maximumWorkUnits: 4 })).toThrow(
      /bounded scan stopped/,
    );
  });

  it('enforces the target tag cap before visiting an oversized array slot', () => {
    let reads = 0;
    const tags = new Array(129);
    Object.defineProperty(tags, '0', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('must not read an oversized tag slot');
      },
    });
    expect(() =>
      scenarioTarget.fullRevaluation({
        id: 'too-many-tags',
        quantity: 1,
        contractMultiplier: 1,
        currency: 'USD',
        tags,
        instrument: { symbol: 'AAPL' },
        pricer: inertPricer(),
      }),
    ).toThrow(/at most 128 tags/);
    expect(reads).toBe(0);
  });
});
