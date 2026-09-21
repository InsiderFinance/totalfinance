import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { divergence, SCHEMA_VERSION, type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import {
  aggregators,
  InformationBarAggregator,
  LineBreakStream,
  RenkoStream,
} from '@totalfinance/technical-analysis/chart-types';
import { pairs } from '@totalfinance/technical-analysis/statistics';

/**
 * TechnicalAnalysisSnapshot integrity (C1): restoring twice from ONE snapshot must yield independent streams (no
 * shared live state); every chart-type stream stamps the `v` schema version and validates it on
 * restore; DivergenceStream's `value` survives a full JSON round-trip.
 */

const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 6 + i * 0.15);
const bars: BarInput[] = closes.map((c, i) => ({
  open: i === 0 ? c : closes[i - 1]!,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 50 + (i % 7) * 20,
}));

describe('restore-twice independence (no shared live state)', () => {
  it('InformationBarAggregator: two restores from one snapshot object do not share the forming bar', () => {
    const src = aggregators.volumeImbalance(5000);
    for (let i = 0; i < 20; i++) src.next(bars[i]!);
    const snap = src.toJSON(); // NOT JSON.stringify'd — the sharing bug needs the live object
    const a = InformationBarAggregator.fromJSON(snap);
    const b = InformationBarAggregator.fromJSON(snap);
    const outA: BarInput[] = [];
    const outB: BarInput[] = [];
    for (let i = 20; i < bars.length; i++) {
      outA.push(...a.next(bars[i]!)); // drive A first — with shared acc this corrupts B
      outB.push(...b.next(bars[i]!));
    }
    expect(outB).toEqual(outA);
  });

  it('InformationBarAggregator.toJSON copies the accumulator (mutating the snapshot is harmless)', () => {
    const src = aggregators.imbalance(500);
    for (let i = 0; i < 10; i++) src.next(bars[i]!);
    const control = InformationBarAggregator.fromJSON(JSON.parse(JSON.stringify(src.toJSON())));
    const snap = src.toJSON();
    (snap.state['acc'] as Record<string, number>)['imbalance'] = 1e9;
    const after: BarInput[] = [];
    const expected: BarInput[] = [];
    for (let i = 10; i < 30; i++) {
      after.push(...src.next(bars[i]!));
      expected.push(...control.next(bars[i]!));
    }
    expect(after).toEqual(expected);
  });

  it('BarAggregator.restore deep-copies and is kind/version-checked', () => {
    const src = aggregators.volume(1000);
    for (let i = 0; i < 15; i++) src.next(bars[i]!);
    const snap = src.toJSON();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);

    const a = aggregators.volume(1000);
    const b = aggregators.volume(1000);
    a.restore(snap);
    b.restore(snap);
    const outA: BarInput[] = [];
    const outB: BarInput[] = [];
    for (let i = 15; i < bars.length; i++) {
      outA.push(...a.next(bars[i]!));
      outB.push(...b.next(bars[i]!));
    }
    expect(outB).toEqual(outA);

    // a snapshot from a different aggregator kind must not restore
    expect(() => aggregators.tick(3).restore(snap)).toThrowError(/kind/);
    // a newer schema version must be rejected, not mis-restored
    expect(() =>
      aggregators.volume(1000).restore({ ...snap, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrowError(/newer than this build/);
  });

  it('divergence: two restores from one snapshot stay independent', () => {
    const input = pairs(
      closes,
      closes.map((v, i) => v + Math.cos(i / 4) * 3),
    );
    const src = divergence.stream();
    for (let i = 0; i < 40; i++) src.next(input[i]!);
    const snap = src.toJSON();
    const a = divergence.fromJSON(snap);
    const b = divergence.fromJSON(snap);
    const outA: unknown[] = [];
    const outB: unknown[] = [];
    for (let i = 40; i < input.length; i++) {
      outA.push(a.next(input[i]!));
      outB.push(b.next(input[i]!));
    }
    expect(outB).toEqual(outA);
  });
});

describe('chart-type streams follow the versioning law', () => {
  it('RenkoStream stamps v and rejects a newer schema', () => {
    const s = new RenkoStream(2);
    for (const b of bars.slice(0, 30)) s.next(b);
    const snap = s.toJSON();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(() => RenkoStream.fromJSON({ ...snap, schemaVersion: SCHEMA_VERSION + 1 })).toThrowError(
      InputError,
    );
    // 3B.N7: a pre-envelope snapshot is REJECTED, not silently restored with undefined state
    const legacy = { kind: snap.kind, ...snap.state } as unknown;
    expect(() => RenkoStream.fromJSON(legacy as typeof snap)).toThrowError(InputError);
  });

  it('LineBreakStream stamps v and rejects a newer schema', () => {
    const s = new LineBreakStream(3);
    for (const b of bars.slice(0, 30)) s.next(b);
    const snap = s.toJSON();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(() =>
      LineBreakStream.fromJSON({ ...snap, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrowError(/newer than this build/);
  });

  it('InformationBarAggregator stamps v and rejects a newer schema', () => {
    const s = aggregators.run(300);
    for (const b of bars.slice(0, 10)) s.next(b);
    const snap = s.toJSON();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(() =>
      InformationBarAggregator.fromJSON({ ...snap, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrowError(/newer than this build/);
  });
});

describe('DivergenceStream round-trips `value`', () => {
  /** NaN-aware deep equality (divergence points legitimately carry NaN fields). */
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

  it('value survives a full JSON round-trip (including its NaN fields)', () => {
    const input = pairs(
      closes,
      closes.map((v, i) => v + Math.cos(i / 4) * 3),
    );
    const src = divergence.stream();
    for (const p of input.slice(0, 50)) src.next(p);
    expect(src.value).not.toBeNull(); // past warmup — there IS a value to lose
    const restored = divergence.fromJSON(JSON.parse(JSON.stringify(src.toJSON())));
    expect(eq(restored.value, src.value), 'restored .value ≠ source .value').toBe(true);
  });

  it('pre-fix snapshots (no serialized value) restore with value null, not garbage', () => {
    const input = pairs(closes, closes);
    const src = divergence.stream();
    for (const p of input.slice(0, 30)) src.next(p);
    const snap = src.toJSON();
    delete snap.state['value'];
    const restored = divergence.fromJSON(JSON.parse(JSON.stringify(snap)));
    expect(restored.value).toBeNull();
  });
});

describe('stochastic smoothK (A5): the slow stochastic, one implementation', () => {
  it('smoothK: 3 matches a hand-computed slow stochastic on a small series', () => {
    const small: BarInput[] = [
      { high: 12, low: 8, close: 10 },
      { high: 13, low: 9, close: 12 },
      { high: 14, low: 10, close: 11 },
      { high: 15, low: 11, close: 14 },
      { high: 16, low: 12, close: 13 },
      { high: 17, low: 13, close: 16 },
      { high: 18, low: 14, close: 15 },
      { high: 19, low: 15, close: 18 },
    ];
    const kPeriod = 3;
    const smoothK = 3;
    const dPeriod = 2;
    // hand-computed raw %K over kPeriod=3
    const rawK: number[] = [];
    for (let i = kPeriod - 1; i < small.length; i++) {
      const win = small.slice(i - kPeriod + 1, i + 1);
      const hh = Math.max(...win.map((b) => b.high));
      const ll = Math.min(...win.map((b) => b.low));
      rawK.push((100 * (small[i]!.close - ll)) / (hh - ll));
    }
    const sma = (xs: number[], n: number): number[] =>
      xs.slice(n - 1).map((_, i) => xs.slice(i, i + n).reduce((a, b) => a + b, 0) / n);
    const slowK = sma(rawK, smoothK);
    const slowD = sma(slowK, dPeriod);

    const out = ta.stochastic(small, { kPeriod, dPeriod, smoothK });
    // first defined index: (kPeriod-1) + (smoothK-1) + (dPeriod-1)
    const first = kPeriod - 1 + (smoothK - 1) + (dPeriod - 1);
    for (let i = 0; i < first; i++) {
      expect(Number.isNaN(out[i]!.k)).toBe(true);
      expect(Number.isNaN(out[i]!.d)).toBe(true);
    }
    for (let i = first; i < small.length; i++) {
      expect(out[i]!.k).toBeCloseTo(slowK[i - first + (dPeriod - 1)]!, 10);
      expect(out[i]!.d).toBeCloseTo(slowD[i - first]!, 10);
    }
  });

  it('smoothK: 1 (the default) is byte-identical to the previous fast behavior and to stochFast', () => {
    const dflt = ta.stochastic(bars);
    const explicit = ta.stochastic(bars, { kPeriod: 14, dPeriod: 3, smoothK: 1 });
    expect(dflt).toEqual(explicit);
    // stochFast is a TRUE alias — same facade object, same behavior
    expect(ta.stochFast).toBe(ta.stochastic);
    expect(ta.stochFast(bars, { kPeriod: 10, dPeriod: 4 })).toEqual(
      ta.stochastic(bars, { kPeriod: 10, dPeriod: 4 }),
    );
  });

  it('smoothK round-trips through streaming snapshots (and legacy snapshots restore as fast)', () => {
    const stream = ta.stochastic.stream({ kPeriod: 5, dPeriod: 3, smoothK: 3 });
    for (const b of bars.slice(0, 30)) stream.next(b);
    const restored = ta.stochastic.fromJSON(JSON.parse(JSON.stringify(stream.toJSON())));
    for (const b of bars.slice(30)) {
      expect(restored.next(b)).toEqual(stream.next(b));
    }
    // a pre-smoothK snapshot (no smoothK/rawBuf fields) restores as the fast stochastic
    const legacyStream = ta.stochastic.stream({ kPeriod: 5, dPeriod: 3 });
    for (const b of bars.slice(0, 30)) legacyStream.next(b);
    const legacy = JSON.parse(JSON.stringify(legacyStream.toJSON())) as Record<string, unknown>;
    delete legacy['smoothK'];
    delete legacy['rawBuf'];
    const legacyRestored = ta.stochastic.fromJSON(legacy as never);
    for (const b of bars.slice(30)) {
      expect(legacyRestored.next(b)).toEqual(legacyStream.next(b));
    }
  });
});
