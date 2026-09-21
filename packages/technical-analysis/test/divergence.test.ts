import { describe, expect, it } from 'vitest';
import { divergence, divergences } from '@totalfinance/technical-analysis';

const SWING = { left: 2, right: 2 } as const;

describe('WS6.3 divergences — regular', () => {
  it('detects a regular BULLISH divergence (price lower-low, indicator higher-low) at the confirm bar', () => {
    // Swing lows at idx 2 (price 8) and idx 6 (price 7): price LL; indicator 30 → 40: higher-low.
    const price = [10, 9, 8, 9, 10, 11, 7, 8, 9, 10, 11];
    const indicator = [50, 45, 30, 45, 55, 60, 40, 50, 55, 60, 65];
    const evs = divergences({ price, indicator, parameters: { swing: SWING } });
    expect(evs).toEqual([
      { index: 8, kind: 'bullish', priceSwings: [8, 7], indicatorSwings: [30, 40] },
    ]);
  });

  it('detects a regular BEARISH divergence (price higher-high, indicator lower-high)', () => {
    // Swing highs at idx 2 (price 12) and idx 6 (price 13): price HH; indicator 70 → 60: lower-high.
    const price = [10, 11, 12, 11, 10, 9, 13, 12, 11, 10, 9];
    const indicator = [50, 55, 70, 55, 45, 40, 60, 50, 45, 40, 35];
    const evs = divergences({ price, indicator, parameters: { swing: SWING } });
    expect(evs).toEqual([
      { index: 8, kind: 'bearish', priceSwings: [12, 13], indicatorSwings: [70, 60] },
    ]);
  });
});

describe('WS6.3 divergences — hidden', () => {
  it('detects a HIDDEN BULLISH divergence (price higher-low, indicator lower-low)', () => {
    // Swing lows at idx 2 (price 7) and idx 6 (price 8): price higher-low; indicator 40 → 30: lower-low.
    const price = [10, 9, 7, 9, 10, 11, 8, 9, 10, 11, 12];
    const indicator = [50, 45, 40, 45, 55, 60, 30, 50, 55, 60, 65];
    const evs = divergences({ price, indicator, parameters: { swing: SWING } });
    expect(evs).toEqual([
      { index: 8, kind: 'hiddenBullish', priceSwings: [7, 8], indicatorSwings: [40, 30] },
    ]);
  });
});

describe('WS6.3 divergences — negatives, filters, causality', () => {
  const price = [10, 9, 8, 9, 10, 11, 7, 8, 9, 10, 11];
  const indicator = [50, 45, 30, 45, 55, 60, 40, 50, 55, 60, 65];

  it('emits nothing when neither a regular nor a hidden pattern holds', () => {
    // Price lower-low but indicator ALSO lower-low ⇒ no regular (needs ind HL) and no hidden (needs price HL).
    const ind2 = [50, 45, 30, 45, 55, 60, 20, 50, 55, 60, 65];
    expect(divergences({ price, indicator: ind2, parameters: { swing: SWING } })).toHaveLength(0);
  });

  it('respects the kinds filter (a bullish setup is suppressed when only bearish is requested)', () => {
    expect(
      divergences({
        price,
        indicator,
        parameters: { swing: SWING, kinds: ['bearish'] },
      }),
    ).toHaveLength(0);
    expect(
      divergences({
        price,
        indicator,
        parameters: { swing: SWING, kinds: ['bullish'] },
      }),
    ).toHaveLength(1);
  });

  it('is causal: truncating the input at the confirmation bar still yields the same event', () => {
    const full = divergences({ price, indicator, parameters: { swing: SWING } });
    const upToConfirm = divergences({
      price: price.slice(0, 9),
      indicator: indicator.slice(0, 9),
      parameters: { swing: SWING },
    });
    expect(upToConfirm).toEqual(full); // confirmation bar is index 8; nothing after it is needed
  });

  it('rejects a length mismatch and a bad swing window', () => {
    expect(() =>
      divergences({ price: [1, 2, 3], indicator: [1, 2], parameters: { swing: SWING } }),
    ).toThrow(/equal length/);
    expect(() =>
      divergences({
        price,
        indicator,
        parameters: { swing: { left: 0, right: 2 } },
      }),
    ).toThrow(/positive integer/);
  });
});

describe('WS6.3 divergence indicator — batch ≡ stream + snapshot round-trip', () => {
  const price = [10, 9, 8, 9, 10, 11, 7, 8, 9, 10, 11];
  const indicator = [50, 45, 30, 45, 55, 60, 40, 50, 55, 60, 65];
  const pairs = price.map((p, i) => ({ x: p, y: indicator[i]! }));
  const parameters = { swing: SWING } as const;

  it('the registered `divergence` stream matches its aligned batch', () => {
    const batch = divergence.explain(pairs, parameters);
    const stream = divergence.stream(parameters);
    for (let i = 0; i < pairs.length; i++) {
      const out = stream.next(pairs[i]!);
      if (i < batch.diagnostics.warmup) expect(out).toBeNull();
      else expect(out).toEqual(batch.value[i]);
    }
    // The confirmed event lands at its confirmation bar in the aligned series (code 1 = regular bullish).
    expect(batch.value[8]).toMatchObject({ index: 8, code: 1 });
  });

  it('streaming state survives a mid-stream JSON round-trip', () => {
    const batch = divergence.explain(pairs, parameters);
    const partial = divergence.stream(parameters);
    for (let i = 0; i <= 6; i++) partial.next(pairs[i]!);
    const restored = divergence.fromJSON(JSON.parse(JSON.stringify(partial.toJSON())));
    for (let i = 7; i < pairs.length; i++) {
      expect(restored.next(pairs[i]!)).toEqual(batch.value[i]);
    }
  });
});
