# TotalFinance TA — the live tier (charting workflows)

The technical-analysis package (`@totalfinance/technical-analysis`) is built for live, charting-product use, not just
end-of-day batch runs. Three pieces make that work: forming-bar `peek()`, multi-timeframe
`resample`/`alignToBars`, and `divergences`. All are pure (no clock reads) and streaming-first — batch
output is always derived from the same stream, so what you see live is what a backtest sees.

## 1. Forming bars: `peek()` vs `next()`

Every indicator stream (`indicator.stream(params)`) is a **live stream** with two methods:

- `next(value)` — apply `value` and **commit** it. Call this once, when a bar closes.
- `peek(value)` — return the value that _would_ result from `next(value)`, **without** committing.
  Call it as often as you like while a bar is still forming; the committed history is never touched, so
  closed bars never repaint.

```ts
import { rsi } from '@totalfinance/technical-analysis';

const stream = rsi.stream({ period: 14 });

// Seed with closed bars.
for (const close of closedBars) stream.next(close);

// The bar is still forming — repaint the RSI on every tick, cheaply and without side effects.
onTick((price) => {
  const liveRsi = stream.peek(price); // may be null during warmup
  render(liveRsi);
});

// When the bar closes, commit exactly once.
onBarClose((finalClose) => {
  stream.next(finalClose);
});
```

`peek()` works for **every** indicator (all 300+), because it is supplied by the framework wrapper:
it snapshots the committed state once per commit and applies the tick to a throwaway clone. The default
cost is O(snapshot) per call — fine for a chart's tick rate.

## 2. Multi-timeframe: `resample` + `alignToBars`

Show a 1-hour indicator on a 1-minute chart **without** the `request.security` lookahead trap. Buckets
are epoch-aligned (`floor(ts / intervalMs) * intervalMs`); only **closed** higher-timeframe (HTF) bars
are ever projected onto the lower-timeframe (LTF) index.

```ts
import { resample, alignToBars, rsi } from '@totalfinance/technical-analysis';

// 1m → 1h. Only completed hourly buckets are returned by default; pass { includePartial: true } to
// also get the still-forming bucket (flagged `partial: true`).
const hourly = resample(oneMinuteBars, '1h'); // '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'1d' or a ms number

// Compute on the HTF, then step-hold onto the LTF index — strictly causal (NaN until the first hour
// closes; each 1m bar only ever sees hours that have already closed).
const hourlyRsi = rsi(
  hourly.map((b) => b.close),
  { period: 14 },
);
const rsiOn1m = alignToBars(hourlyRsi, hourly, oneMinuteBars);
```

Each resampled bar carries OHLC (first/max/min/last), summed `volume`, and a volume-weighted `vwap`.
_Limitation:_ only epoch-aligned buckets are supported — session-anchored resampling (buckets anchored
to an exchange's session open) is intentionally not included.

## 3. Divergences

Regular and hidden price/indicator divergences, confirmed causally: an event is emitted at the bar
where the second swing's fractal window completes, and the two swings reference earlier bars.

```ts
import { divergences, rsi } from '@totalfinance/technical-analysis';

const rsiValues = rsi(closes, { period: 14 });
const events = divergences(closes, rsiValues, {
  swing: { left: 5, right: 5 }, // fractal confirmation window
  kinds: ['bullish', 'bearish', 'hiddenBullish', 'hiddenBearish'],
});
// => [{ index, kind, priceSwings: [a, b], indicatorSwings: [a, b] }, ...]
// `index` is the confirmation bar; `priceSwings`/`indicatorSwings` reference the two swing bars.
```

The streaming form is the registered `divergence` indicator (`divergence.stream(...)`), which yields a
numeric `DivergencePoint` per bar (`code: 0` when nothing confirms); `divergences(...)` is the
convenient event-list view with a string `kind`.
