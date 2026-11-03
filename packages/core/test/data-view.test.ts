import { describe, it, expect } from 'vitest';
import {
  createDataView,
  defineDataProvider,
  type DataPage,
  type PriceBarRecord,
} from '../src/data.js';
import { ErrorCode, QuantError } from '../src/errors.js';
import { canonicalJsonOf } from '../src/canonical-json.js';
import { contentHash } from '../src/artifacts/content-hash.js';
import { sma } from '../../technical-analysis/src/moving-averages.js';
import { vwap } from '../../technical-analysis/src/bars.js';
import {
  bar,
  page,
  dailyRequest,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
function facts(): DataPage<PriceBarRecord> {
  return {
    ...page(),
    kind: 'price-bars',
    data: [bar('2026-10-26', 100), bar('2026-10-27', 101), bar('2026-10-28', 102)],
  };
}
function prices(raw = facts()) {
  const view = createDataView(raw);
  if (view.kind !== 'price-bars') throw new Error('expected price bars');
  return view;
}
describe('SDK-owned consumer data view', () => {
  it('queries directly into the existing SMA with no projection or envelope', async () => {
    const raw = facts();
    const provider = defineDataProvider({
      id: 'fixture',
      version: '0.0.0',
      contractVersion: 1,
      async capabilities() {
        return {
          contractVersion: 1,
          providerId: 'fixture',
          providerVersion: '0.0.0',
          capabilities: [barCapability],
        };
      },
      async query() {
        return raw as never;
      },
    });
    const result = await provider.query({ ...dailyRequest, limit: 3 });
    expect(sma(result.closePrices, { period: 2 }).at(-1)).toBe(101.5);
    expect(sma.explain(result.closePrices, { period: 2 })).toEqual(
      sma.explain([100, 101, 102], { period: 2 }),
    );
    expect(result.page).toEqual(raw);
    expect(Object.isFrozen(raw)).toBe(false);
  });
  it('supplies plain immutable arrays/rows compatible with VWAP', () => {
    const raw = facts();
    raw.data.forEach((row, i) => {
      row.bar.volume = i + 1;
    });
    const view = prices(raw);
    expect(vwap.explain(view.ohlcvBars)).toEqual(
      vwap.explain([
        { open: 100, high: 102, low: 99, close: 100, volume: 1 },
        { open: 100, high: 102, low: 99, close: 101, volume: 2 },
        { open: 100, high: 102, low: 99, close: 102, volume: 3 },
      ]),
    );
    for (const values of [view.closePrices, view.ohlcvBars]) {
      expect(Object.getPrototypeOf(values)).toBe(Array.prototype);
      expect(Reflect.ownKeys(values)).toEqual(['0', '1', '2', 'length']);
      expect(Object.isFrozen(values)).toBe(true);
    }
    expect(Object.isFrozen(view.ohlcvBars[0])).toBe(true);
    expect(view.closePrices).toBe(view.closePrices);
    expect(view.ohlcvBars).toBe(view.ohlcvBars);
    expect(() => (view.closePrices as number[]).push(0)).toThrow();
    expect(() => {
      (view.ohlcvBars[0] as any).close = 0;
    }).toThrow();
  });
  it.each([0, 1, 2])(
    'keeps partial-quality closes usable when row %i volume is unknown',
    (index) => {
      const raw = facts();
      delete raw.data[index]!.bar.volume;
      (raw.metadata.quality as any).status = 'partial';
      (raw.diagnostics.warnings as unknown[]).push({
        code: 'data.source_issue',
        message: 'Source volume unknown',
        severity: 'warn',
      });
      const view = prices(raw);
      expect(sma(view.closePrices, { period: 2 }).at(-1)).toBe(101.5);
      expect(() => view.ohlcvBars).toThrow(
        expect.objectContaining({
          code: ErrorCode.InputMissingField,
          context: expect.objectContaining({ field: 'volume', index }),
        }),
      );
      expect(view.page.metadata.quality.status).toBe('partial');
      expect(view.page.diagnostics).toEqual(raw.diagnostics);
      expect(JSON.parse(JSON.stringify(view))).toEqual({ kind: 'price-bars', page: raw });
      expect(Object.keys(view)).toEqual(['kind', 'page']);
    },
  );
  it.each(['complete', 'partial', 'unknown', 'unavailable'] as const)(
    'does not turn %s quality into a field ban',
    (status) => {
      const raw = facts();
      (raw.metadata.quality as any).status = status;
      expect(prices(raw).closePrices).toEqual([100, 101, 102]);
      expect(prices(raw).ohlcvBars).toHaveLength(3);
    },
  );
  it('retains zero fields and empty samples without new history policies', () => {
    const raw = facts();
    Object.assign(raw.data[0]!.bar, { open: 0, high: 0, low: 0, close: 0, volume: 0 });
    expect(prices(raw).ohlcvBars[0]).toEqual({ open: 0, high: 0, low: 0, close: 0, volume: 0 });
    expect(prices(raw).closePrices[0]).toBe(0);
    const empty = prices({ ...raw, data: [] });
    expect(empty.closePrices).toEqual([]);
    expect(empty.ohlcvBars).toEqual([]);
    expect(sma(empty.closePrices, { period: 2 })).toEqual([]);
  });
  it('exposes exactly a nonterminal or terminal page sample without fetching or continuity claims', () => {
    const raw = facts();
    (raw as any).nextCursor = 'another-page';
    const first = prices(raw);
    expect(first.closePrices).toEqual([100, 101, 102]);
    expect(first.page.nextCursor).toBe('another-page');
    const last = prices({ ...raw, data: [raw.data[2]!], nextCursor: null });
    expect(last.closePrices).toEqual([102]);
    expect(last.page.metadata.coverage.status).toBe('unknown');
  });
  it('preserves canonical raw-page identity, all source clocks/warnings and restoration', () => {
    const raw = facts();
    const before = canonicalJsonOf(raw);
    const view = prices(raw);
    const hash = contentHash(raw);
    expect(contentHash(view.page)).toBe(hash);
    expect(() => contentHash(view as never)).toThrow(QuantError);
    const restored = prices(JSON.parse(JSON.stringify(view.page)));
    expect(restored.closePrices).toEqual(view.closePrices);
    expect(contentHash(restored.page)).toBe(hash);
    expect(restored.page.metadata.times).toEqual({
      observedTimestampMs: null,
      availableTimestampMs: null,
      sourceStoredTimestampMs: null,
    });
    expect(restored.page.metadata.adjustment).toBe('split');
    expect(canonicalJsonOf(raw)).toBe(before);
  });
  it.each([undefined, null, [], {}, 42])('restoration first touch is typed for %j', (input) => {
    expect(() => createDataView(input)).toThrow(QuantError);
  });
  it.each([
    (p: any) => {
      p.data[1].bar.close = NaN;
    },
    (p: any) => {
      p.data.reverse();
    },
    (p: any) => {
      p.data[1].bar.high = 0;
    },
    (p: any) => {
      p.metadata.times.observedTimestampMs = 1;
    },
  ])('rejects invalid raw financial/page facts before selection', (mutate) => {
    const raw = facts();
    mutate(raw);
    expect(() => createDataView(raw)).toThrow(
      expect.objectContaining({ code: ErrorCode.DataInvalidResponse }),
    );
  });
});

it('rejects accessor-bearing raw data without invoking it', () => {
  let reads = 0;
  const raw = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('must not run');
    },
  });
  expect(() => createDataView(raw)).toThrow(
    expect.objectContaining({ code: ErrorCode.DataInvalidResponse }),
  );
  expect(reads).toBe(0);
});

it('restoration refuses a page with missing source identity', () => {
  const raw = facts();
  delete raw.provenance.provider;
  expect(() => createDataView(raw)).toThrow(
    expect.objectContaining({ code: ErrorCode.DataInvalidResponse }),
  );
});
