/**
 * Snapshot schema versioning (3B.N7 — the explicit `TechnicalAnalysisSnapshot` envelope).
 *
 * Two assertions here INVERTED with the envelope, deliberately:
 *
 *   - a flat pre-envelope (v1) snapshot used to be "accepted as v1". It is now REJECTED. Accepting
 *     it would mean restoring an indicator whose every field reads `undefined` from a missing
 *     `state` — a silently NaN-producing stream, which design law #4 forbids. Pre-1.0 corrections
 *     are clean (law N9), so no legacy parser is retained.
 *   - nested snapshots used to be stripped of their version so the root owned it. Each nested
 *     snapshot is now a full envelope, because it is produced by the child's own `toJSON()` →
 *     `snapshotOf`. That is the better property: any nested snapshot is independently restorable
 *     and self-describing, and the field collision the old stripping protected against (a stream
 *     serializing its own `v`) is structurally impossible now that state lives under `state`.
 */

import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type TechnicalAnalysisSnapshot,
  checkSnapshotVersion,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.1);

/** A structurally valid envelope for direct `checkSnapshotVersion` probes. */
const envelope = (over: Partial<TechnicalAnalysisSnapshot> = {}): TechnicalAnalysisSnapshot => ({
  kind: 'x',
  schemaVersion: SCHEMA_VERSION,
  state: {},
  ...over,
});

describe('snapshot schema versioning', () => {
  it('stamps SCHEMA_VERSION on streamed snapshots and keeps state out of the envelope', () => {
    const stream = ta.rsi.stream({ period: 14 });
    closes.slice(0, 20).forEach((close) => stream.next(close));
    const snapshot = stream.toJSON();
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.kind).toBe('rsi'); // inner kind preserved
    // the envelope carries exactly three fields — indicator state never leaks up to this level
    expect(Object.keys(snapshot).sort()).toEqual(['kind', 'schemaVersion', 'state']);
    expect(typeof snapshot.state).toBe('object');
  });

  it('round-trips through JSON, continues identically, and re-stamps on re-serialization', () => {
    const reference = ta.ema.stream({ period: 10 });
    const expected = closes.map((close) => reference.next(close));
    const partial = ta.ema.stream({ period: 10 });
    for (let i = 0; i < 30; i++) partial.next(closes[i]!);
    const json = JSON.parse(JSON.stringify(partial.toJSON())) as TechnicalAnalysisSnapshot;
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
    const restored = ta.ema.fromJSON(json);
    for (let i = 30; i < closes.length; i++) {
      expect(restored.next(closes[i]!) as number).toBeCloseTo(expected[i] as number, 9);
    }
    expect(restored.toJSON().schemaVersion).toBe(SCHEMA_VERSION); // re-serialization re-stamps
  });

  it('REJECTS a pre-envelope (flat) snapshot instead of restoring undefined state', () => {
    const partial = ta.ema.stream({ period: 10 });
    for (let i = 0; i < 30; i++) partial.next(closes[i]!);
    // what a v1 snapshot looked like: state at the same level as the envelope fields
    const flat = { kind: 'ema', v: 1, ...partial.toJSON().state } as unknown;
    expect(() => ta.ema.fromJSON(flat as TechnicalAnalysisSnapshot)).toThrowError(
      /invalid schema version|predates the explicit envelope|no `state` object/,
    );
  });

  it('rejects a snapshot from a newer schema (typed error)', () => {
    const partial = ta.ema.stream({ period: 10 });
    partial.next(closes[0]!);
    const json = JSON.parse(JSON.stringify(partial.toJSON())) as TechnicalAnalysisSnapshot;
    json.schemaVersion = SCHEMA_VERSION + 1;
    expect(() => ta.ema.fromJSON(json)).toThrowError(/newer than this build/);
    try {
      ta.ema.fromJSON(json);
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as { code?: string }).code).toBe('snapshot.unsupported_version');
    }
  });

  it('rejects an invalid version (non-integer, zero, negative, NaN)', () => {
    const partial = ta.ema.stream({ period: 10 });
    partial.next(closes[0]!);
    for (const bad of [0, -1, 1.5, NaN]) {
      const json = JSON.parse(JSON.stringify(partial.toJSON())) as TechnicalAnalysisSnapshot;
      json.schemaVersion = bad;
      expect(() => ta.ema.fromJSON(json), String(bad)).toThrowError(/invalid schema version/);
    }
  });

  it('checkSnapshotVersion validates an envelope directly', () => {
    expect(() => checkSnapshotVersion(envelope())).not.toThrow();
    expect(() => checkSnapshotVersion(envelope({ schemaVersion: 999 }))).toThrowError(
      /newer than this build/,
    );
    expect(() => checkSnapshotVersion(envelope({ schemaVersion: 1 }))).toThrowError(
      /predates the explicit envelope/,
    );
  });

  it('versions composed-indicator snapshots at every level (macd)', () => {
    const reference = ta.macd.stream({ fast: 12, slow: 26, signal: 9 });
    const expected = closes.map((close) => reference.next(close));
    const partial = ta.macd.stream({ fast: 12, slow: 26, signal: 9 });
    for (let i = 0; i < 40; i++) partial.next(closes[i]!);
    const snapshot = partial.toJSON();
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    // a nested snapshot is itself an envelope — independently restorable, not a bare state bag
    const nested = snapshot.state['fast'] as TechnicalAnalysisSnapshot;
    expect(nested.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof nested.state).toBe('object');
    const restored = ta.macd.fromJSON(
      JSON.parse(JSON.stringify(snapshot)) as TechnicalAnalysisSnapshot,
    );
    for (let i = 40; i < closes.length; i++) {
      const got = restored.next(closes[i]!);
      if (expected[i] === null) expect(got).toBeNull();
      else expect(got).toEqual(expected[i]);
    }
  });
});
