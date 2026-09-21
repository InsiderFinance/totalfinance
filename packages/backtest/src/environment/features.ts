/**
 * The observation's derived blocks (Stage 7B.1 slice 2, Decision 4): feature recipes evaluated over
 * the bars at or before the instant — never a later row, never a whole-series statistic — and the
 * freshness of every instrument's latest observation under the execution policy's staleness rule.
 */
import type { Bar, EpochMs } from '@totalfinance/core';
import { standardDeviation } from '@totalfinance/math';
import { logReturns } from '@totalfinance/performance';
import type { ExecutionPolicy } from '../execution/types.js';
import type { InstrumentSpecification, LatestObservations } from '../portfolio/types.js';
import type { EnvironmentFeatures, FeatureRecipes, InstrumentFreshness } from './types.js';

/** Per instrument, the bar closes in time order — the prefix at or before an instant is a feature's whole world. */
export interface FeatureIndex {
  readonly closes: ReadonlyMap<
    string,
    { timestamps: readonly EpochMs[]; closes: readonly number[] }
  >;
}

export function createFeatureIndex(bars: readonly Bar[] | undefined): FeatureIndex {
  const grouped = new Map<string, Bar[]>();
  for (const bar of bars ?? []) {
    const rows = grouped.get(bar.symbol);
    if (rows === undefined) grouped.set(bar.symbol, [bar]);
    else rows.push(bar);
  }
  const closes = new Map<string, { timestamps: EpochMs[]; closes: number[] }>();
  for (const [symbol, rows] of grouped) {
    rows.sort((a, b) => a.timestampMs - b.timestampMs);
    closes.set(symbol, {
      timestamps: rows.map((r) => r.timestampMs),
      closes: rows.map((r) => r.close),
    });
  }
  return { closes };
}

/** The count of bars with `timestampMs <= asOf` (binary search on the ascending timestamps). */
function prefixLength(timestamps: readonly EpochMs[], asOf: EpochMs): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (timestamps[mid]! <= asOf) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function featuresAt(
  index: FeatureIndex,
  recipes: FeatureRecipes | undefined,
  instruments: Readonly<Record<string, InstrumentSpecification>>,
  asOf: EpochMs,
): EnvironmentFeatures {
  const lookbackReturns: Record<string, Record<string, number | null>> = {};
  const realizedVolatility: Record<string, Record<string, number | null>> = {};
  const drawdown: Record<string, number | null> = {};
  if (recipes === undefined) return { lookbackReturns, realizedVolatility, drawdown };
  const ids = Object.keys(instruments);
  const prefixOf = (id: string): readonly number[] => {
    const series = index.closes.get(id);
    if (series === undefined) return [];
    return series.closes.slice(0, prefixLength(series.timestamps, asOf));
  };
  const prefixes = new Map(ids.map((id) => [id, prefixOf(id)]));
  for (const lookback of recipes.lookbackReturns ?? []) {
    const row: Record<string, number | null> = {};
    for (const id of ids) {
      const closes = prefixes.get(id)!;
      const n = closes.length;
      row[id] =
        n > lookback && closes[n - 1 - lookback]! > 0
          ? closes[n - 1]! / closes[n - 1 - lookback]! - 1
          : null;
    }
    lookbackReturns[String(lookback)] = row;
  }
  if (recipes.realizedVolatility !== undefined) {
    // The recipe states its bars per year (validated present and positive); no silent 252.
    const scale = Math.sqrt(recipes.realizedVolatility.annualization);
    for (const lookback of recipes.realizedVolatility.lookbacks) {
      const row: Record<string, number | null> = {};
      for (const id of ids) {
        const closes = prefixes.get(id)!;
        const n = closes.length;
        if (n <= lookback || lookback < 2) {
          row[id] = null;
          continue;
        }
        const window = closes.slice(n - 1 - lookback);
        const returns = logReturns(window);
        const sigma = standardDeviation(returns) * scale;
        row[id] = Number.isFinite(sigma) ? sigma : null;
      }
      realizedVolatility[String(lookback)] = row;
    }
  }
  if (recipes.drawdown === true) {
    for (const id of ids) {
      const closes = prefixes.get(id)!;
      if (closes.length === 0) {
        drawdown[id] = null;
        continue;
      }
      let peak = -Infinity;
      for (const close of closes) if (close > peak) peak = close;
      drawdown[id] = peak > 0 ? 1 - closes[closes.length - 1]! / peak : null;
    }
  }
  return { lookbackReturns, realizedVolatility, drawdown };
}

/** The timestamp of an instrument's latest observation of any kind, and the kinds present. */
export function latestObservationTimestamp(latest: LatestObservations): {
  timestampMs: EpochMs | null;
  kinds: string[];
} {
  const kinds: string[] = [];
  let timestampMs: EpochMs | null = null;
  const consider = (kind: string, at: EpochMs | undefined): void => {
    if (at === undefined) return;
    kinds.push(kind);
    if (timestampMs === null || at > timestampMs) timestampMs = at;
  };
  consider('bar', latest.bar?.timestampMs);
  consider('quote', latest.quote?.timestampMs);
  consider('trade', latest.trade?.timestampMs);
  consider('order-book', latest.orderBook?.timestampMs);
  consider('chain-quote', latest.chainQuote?.timestampMs);
  if (latest.forwardRate !== undefined) kinds.push('forward-rate');
  return { timestampMs, kinds };
}

/**
 * The timestamp of the observation the execution policy fills on — the policy's kind for a listed
 * instrument, the chain quote for an option — or null when that kind is absent; the age the
 * staleness rule measures.
 */
export function policyObservationTimestamp(
  spec: InstrumentSpecification,
  latest: LatestObservations,
  policy: ExecutionPolicy,
): EpochMs | null {
  if (spec.kind === 'option') return latest.chainQuote?.timestampMs ?? null;
  if (spec.kind === 'fx-forward') return latestObservationTimestamp(latest).timestampMs;
  switch (policy.observation) {
    case 'bar':
      return latest.bar?.timestampMs ?? null;
    case 'quote':
      return latest.quote?.timestampMs ?? null;
    case 'trade':
      return latest.trade?.timestampMs ?? null;
    case 'order-book':
      return latest.orderBook?.timestampMs ?? null;
  }
}

export function freshnessAt(
  observations: Readonly<Record<string, LatestObservations>>,
  instruments: Readonly<Record<string, InstrumentSpecification>>,
  policy: ExecutionPolicy,
  asOf: EpochMs,
): Record<string, InstrumentFreshness> {
  const out: Record<string, InstrumentFreshness> = {};
  const limit = policy.staleQuotes.maximumAgeMs;
  for (const [id, latest] of Object.entries(observations)) {
    const { kinds } = latestObservationTimestamp(latest);
    const spec = instruments[id];
    const timestampMs =
      spec === undefined
        ? latestObservationTimestamp(latest).timestampMs
        : policyObservationTimestamp(spec, latest, policy);
    const ageMs = timestampMs === null ? null : asOf - timestampMs;
    out[id] = {
      latestTimestampMs: timestampMs,
      ageMs,
      stale: limit !== null && ageMs !== null && ageMs > limit,
      kinds,
    };
  }
  return out;
}
