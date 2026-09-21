/**
 * Tests for §13.2 async-iterable streaming input: feeding an indicator stream from an async source
 * (websocket/cursor/generator) yields exactly the same results as the batch computation.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { collectAsync, rsi, sma, streamAsync } from '@totalfinance/technical-analysis';

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const x of items) {
    await Promise.resolve(); // simulate awaiting a live feed
    yield x;
  }
}

const prices = Array.from({ length: 40 }, (_, i) => 100 + 5 * Math.sin(i / 3) + i * 0.2);

describe('async-iterable streaming input', () => {
  it('collectAsync reproduces the batch series exactly (SMA)', async () => {
    const batch = sma.explain(prices, { period: 10 });
    const streamed = await collectAsync(sma.stream({ period: 10 }), asAsync(prices), NaN);
    expect(streamed.warmup).toBe(batch.diagnostics.warmup);
    expect(streamed.value.length).toBe(batch.value.length);
    for (let i = 0; i < batch.value.length; i++) {
      if (Number.isNaN(batch.value[i]!)) expect(streamed.value[i]).toBeNaN();
      else expect(streamed.value[i]).toBeCloseTo(batch.value[i]!, 10);
    }
  });

  it('streamAsync yields only post-warmup values, matching the batch (RSI)', async () => {
    const batch = rsi(prices, { period: 14 }).filter((v) => !Number.isNaN(v));
    const yielded: number[] = [];
    for await (const v of streamAsync(rsi.stream({ period: 14 }), asAsync(prices))) {
      yielded.push(v);
    }
    expect(yielded.length).toBe(batch.length);
    for (let i = 0; i < batch.length; i++) expect(yielded[i]).toBeCloseTo(batch[i]!, 10);
  });
});

describe('async adapters guard the stream argument (first-touch law, R3 deep sweep)', () => {
  // `{}` passes an object-shape check but has no next(); pre-fix it crashed mid-drain with a raw
  // "stream.next is not a function" TypeError instead of a typed teaching error.
  it('collectAsync with a next-less stream rejects with a typed InputError', async () => {
    let caught: unknown;
    try {
      await collectAsync({} as never, asAsync([1, 2, 3]), NaN);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    expect((caught as Error).message).toMatch(/IndicatorStream/);
  });

  it('streamAsync with a next-less stream throws typed on first iteration', async () => {
    const gen = streamAsync({} as never, asAsync([1, 2, 3]));
    let caught: unknown;
    try {
      await gen.next();
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
    expect((caught as Error).message).toMatch(/IndicatorStream/);
  });
});
