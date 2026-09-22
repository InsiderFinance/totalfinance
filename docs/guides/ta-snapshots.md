# Saving and restoring a streaming indicator

Every indicator in `@insiderfinance/totalfinance/technical-analysis` has a streaming form, and every streaming form is
serializable. You feed it bars, save it, load it a week later, and keep feeding it — the output is
identical to a stream that never stopped.

```ts
import * as technicalAnalysis from '@insiderfinance/totalfinance/technical-analysis';

const stream = technicalAnalysis.rsi.stream({ period: 14 });
for (const close of closesSoFar) stream.next(close);

await store.put('rsi:AAPL', JSON.stringify(stream.toJSON()));

// …later, another process, another day
const restored = technicalAnalysis.rsi.fromJSON(JSON.parse(await store.get('rsi:AAPL')));
restored.next(nextClose); // continues exactly where the first stream left off
```

That is the whole API. The rest of this page is what the library guarantees about the thing you
stored, and what it does when that thing is wrong — because a snapshot is the one input to this
package that does **not** come from your code. It comes from a disk, a cache, or a wire.

## The envelope

`toJSON()` returns a `TechnicalAnalysisSnapshot`:

```ts
{
  kind: 'rsi',          // which indicator wrote it
  schemaVersion: 3,     // which shape it is in
  state: { … }          // the indicator's own streaming state
}
```

`kind` and `schemaVersion` are yours to read. **`state` is opaque.** Round-trip it; never branch on
what is inside it. Those keys are indicator-private, they are allowed to be terse, and they change
without a major version — the envelope around them is the contract.

## What a restore checks

`fromJSON` validates the envelope before it touches a single field. In order:

| Check                                                        | Rejected with                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| It is an envelope at all                                     | `snapshot.wrong_shape`                                                              |
| It is not a pre-envelope (flat, v1) snapshot                 | `snapshot.wrong_shape`                                                              |
| It carries no field outside `{ kind, schemaVersion, state }` | `input.unknown_field`                                                               |
| `schemaVersion` is one this build reads                      | `snapshot.unsupported_version`                                                      |
| **`kind` is this indicator**                                 | `snapshot.kind_mismatch`                                                            |
| `state` is an object                                         | `snapshot.wrong_shape`                                                              |
| every field it reads has the right type and shape            | `input.wrong_type`, `input.missing_field`, `input.not_finite`, `input.out_of_range` |

Every one is an `InputError` carrying a `code` and a `context`, so a loader can branch:

```ts
import { isQuantError } from '@insiderfinance/totalfinance/core';

try {
  return technicalAnalysis.rsi.fromJSON(stored);
} catch (error) {
  if (isQuantError(error, 'snapshot.unsupported_version')) return rebuildFromHistory();
  if (isQuantError(error, 'snapshot.kind_mismatch')) throw new Error('cache key collision');
  throw error;
}
```

The identity check is the one worth dwelling on. Before it existed, handing an EMA snapshot to
`atr.fromJSON` produced an **ATR stream seeded with EMA numbers** — no error, no NaN, just a
confidently wrong indicator. A cache-key collision or a schema-less blob store is all it takes.

## Non-finite values survive the round trip

`JSON.stringify(NaN)` is `null`. That matters here more than it looks, because NaN is a _legitimate_
value in this package: fed a zero price series, every log-return is NaN, so `realizedVolatility`'s
window is NaN-filled from perfectly valid input; `acos` outside `[-1, 1]` caches NaN as its last
output. Measured across all 335 indicators, 38 distinct state paths can hold one.

So `snapshotOf` — the single point every `toJSON` goes through — encodes them:

```json
{
  "kind": "realizedVolatility",
  "schemaVersion": 3,
  "state": { "buf": [0.01, { "nonFinite": "NaN" }, 0.02] }
}
```

You never write or read that form; the accessors decode it. What it buys you is that after
serialization **no raw non-finite number exists in `state`** — which is what makes the reverse
meaningful. A raw `NaN` arriving at a restore cannot have come from this library, so it is treated as
damage and rejected, instead of being silently absorbed into a running sum that never recovers.

This is what `schemaVersion: 3` marks. A snapshot written by an earlier build is rejected with a
typed error rather than misread; re-serialize from a live stream to migrate.

## Two independent restores are independent

Restoring twice from the same snapshot object gives two streams that share nothing:

```ts
const snapshot = stream.toJSON();
const a = technicalAnalysis.rsi.fromJSON(snapshot);
const b = technicalAnalysis.rsi.fromJSON(snapshot);
a.next(101); // does not move b
```

Buffers are copied out on the way in, not aliased. This is load-bearing for `peek()`, the forming-bar
affordance described in [live charts](./ta-live-charts.md), which restores a throwaway clone on every
tick.

## Writing your own indicator

If you register an indicator with `defineIndicator`, its restorer uses the same door:

```ts
import {
  readSnapshot,
  snapshotOf,
  type TechnicalAnalysisSnapshot,
} from '@insiderfinance/totalfinance/technical-analysis';

class MyStream {
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('myIndicator', { period: this.period, value: this.value });
  }

  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MyStream {
    const state = readSnapshot(snapshot, 'myIndicator'); // ← the identity guard
    const stream = new MyStream(state.lookback('period'));
    stream.value = state.cached<number>('value');
    return stream;
  }
}
```

`readSnapshot`'s second argument is not optional and has no default: it _is_ the identity guard. One
class that backs several public indicators passes the family instead, and the returned `state.kind`
is narrowed to a member of it:

```ts
const state = readSnapshot(snapshot, ['standardDeviation', 'variance'] as const);
```

The accessors on `SnapshotState`:

|                                                                     |                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| `number` `numberOrNull` `optionalNumber`                            | a number, decoding the non-finite form          |
| `integer` `lookback`                                                | a whole number ≥ 0, and a window ≥ 1            |
| `boolean` `text` `literal(field, allowed)`                          | flags, strings, and closed sets                 |
| `numbers` `numbersOrNull` `optionalNumbers` `numberRows` `literals` | arrays, always returned fresh                   |
| `child` `children`                                                  | nested envelopes, for a composed indicator      |
| `record` `recordOrNull` `records`                                   | structured state the indicator persists whole   |
| `cached<T>`                                                         | the last emitted output; absent reads as `null` |

There is no accessor that returns `unknown`. A restorer that cannot say what it needs is a restorer
that is not checking — which is the defect the whole envelope exists to make impossible.
