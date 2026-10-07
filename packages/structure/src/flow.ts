/**
 * Options flow analytics (spec §11.6): NBBO aggressor classification, sweep/block detection,
 * multi-leg spread estimation, grouping, and ranking.
 *
 * Every inferred classification is an ESTIMATE — aggressor side, sweeps, blocks, and spreads are
 * heuristics over trade prints and NBBO context, not exchange-confirmed labels. Every result says
 * so via `model.limitation` entries in `diagnostics.warnings` (R2 — no hoisted fields).
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type OptionTrade,
  type OptionType,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  optionExpiryToMs,
  requireArgumentArray,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import { mean, standardDeviation } from '@totalfinance/math';
import { classifyPrint, requireClassificationSource } from './flow-print.js';
import { marketDayIndex } from './market-day.js';

export type AggressorSide = 'buy' | 'sell' | 'unknown';

/**
 * `provided-or-quotes` is the backwards-compatible rule: supplied buy/sell wins, but unknown or
 * absent classification falls through to quotes. `provided-first` preserves supplied unknowns
 * and uses quotes only when classification is absent. `provided-only` never infers from quotes;
 * `quotes-only` ignores supplied classifications (but still validates their enum).
 */
export type FlowClassificationSource =
  | 'provided-or-quotes'
  | 'provided-first'
  | 'provided-only'
  | 'quotes-only';

/** Lineage of the classification, not a claim that a provider label is exchange-confirmed. */
export interface FlowClassificationProvenance {
  policy: FlowClassificationSource;
  source: 'provided' | 'quotes' | 'unavailable';
  /** `null` means absent; `'unknown'` means the provider explicitly declined to classify. */
  providedSide: AggressorSide | null;
  reason:
    | 'provided'
    | 'provided-missing'
    | 'quotes-missing'
    | 'quotes-locked-or-crossed'
    | 'quote-midpoint'
    | 'quote-rule';
}

/** Opening-vs-closing estimate; only a definite `open` (size exceeds prior OI) is inferred. */
export type OpenCloseEstimate = 'open' | 'unknown';

export interface FlowOptions {
  /** Classification authority/fallback rule. Default `'provided-or-quotes'` (legacy behavior). */
  classificationSource?: FlowClassificationSource;
  /** A single print is a block at/above this size (contracts). Default 100. */
  blockMinSize?: number;
  /** ...or at/above this premium (price·size·multiplier). Default 100_000. */
  blockMinPremium?: number;
  /** Prints on one contract within this window (ms), same side, count as one sweep. Default 500. */
  sweepWindowMs?: number;
  /** Minimum prints to call a cluster a sweep. Default 3. */
  sweepMinPrints?: number;
  /** Prints on one underlying within this window (ms) across ≥2 contracts form a spread. Default 100. */
  spreadWindowMs?: number;
  /** Contract multiplier when a trade omits one. Default 100. */
  multiplier?: number;
}

/** {@link FlowOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const FLOW_OPTIONS_KEYS = [
  'classificationSource',
  'blockMinSize',
  'blockMinPremium',
  'sweepWindowMs',
  'sweepMinPrints',
  'spreadWindowMs',
  'multiplier',
] as const;

export interface ClassifiedTrade {
  trade: OptionTrade;
  underlying: string;
  type: OptionType;
  strike: number;
  expiry: string;
  /** Supplied or quote-estimated aggressor side, according to classificationProvenance. */
  side: AggressorSide;
  classificationProvenance: FlowClassificationProvenance;
  premium: number;
  size: number;
  isBlock: boolean;
  /** True when the trade prints on its own expiration day (0DTE). */
  isZeroDaysToExpiry: boolean;
  /** Opening estimate: `open` when size exceeds prior open interest (definitely new contracts). */
  openClose: OpenCloseEstimate;
  /** Sweep cluster id (undefined when not part of a sweep). */
  sweepId?: number;
  /** Spread group id (undefined when not part of a detected multi-leg spread). */
  spreadId?: number;
}

export interface Sweep {
  id: number;
  underlying: string;
  strike: number;
  type: OptionType;
  expiry: string;
  side: AggressorSide;
  prints: number;
  size: number;
  premium: number;
  startTimestampMs: number;
  endTimestampMs: number;
  /** True only if THIS sweep's own prints spanned ≥2 exchanges; false for a timing-only cluster. */
  venueVerified: boolean;
}

export interface Spread {
  id: number;
  underlying: string;
  timestampMs: number;
  legs: number;
  /** Net premium: positive = net debit (bought), negative = net credit (sold). */
  netPremium: number;
  /**
   * True only if EVERY leg's aggressor side was estimable (buy/sell). When false, an `unknown`-side
   * leg was excluded from `netPremium`, so the net direction is partial — do not read it as signed.
   */
  directionKnown: boolean;
  contracts: Array<{
    type: OptionType;
    strike: number;
    expiry: string;
    size: number;
    side: AggressorSide;
  }>;
}

export interface FlowGroupKey {
  underlying?: string;
  expiry?: string;
  strike?: number;
  type?: OptionType;
}

export interface FlowGroup extends FlowGroupKey {
  trades: number;
  size: number;
  premium: number;
  buyPremium: number;
  sellPremium: number;
  /** Net premium (buy − sell). */
  netPremium: number;
  /**
   * Volume/open-interest ratio when grouped to a single contract with known OI, else `null`
   * (chart-facing rows use JSON-safe `null`, never `undefined` or `NaN` — WS2.12).
   */
  volumeOpenInterestRatio: number | null;
}

export type RankByKey = 'premium' | 'size' | 'netPremium' | 'volumeOpenInterestRatio';

const RANK_BY_KEYS: RankByKey[] = ['premium', 'size', 'netPremium', 'volumeOpenInterestRatio'];

export interface RankOptions {
  /** Ranking metric (default `'premium'`). */
  by?: RankByKey;
  /** Exclude groups below this aggregate premium. */
  minPremium?: number;
  /** Exclude groups below this volume/open-interest ratio. */
  minVolumeOpenInterestRatio?: number;
  /** Maximum returned groups; a non-negative safe integer. Omit for every group. */
  limit?: number;
}

/** {@link RankOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const RANK_OPTIONS_KEYS = ['by', 'minPremium', 'minVolumeOpenInterestRatio', 'limit'] as const;

/** Call-vs-put premium/volume summary with put/call ratios (spec §11.6). */
export interface CallPutPremium {
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  /** Put ÷ call traded volume (contracts); `null` when there is no call volume. */
  putCallVolumeRatio: number | null;
  /** Put ÷ call premium ($); `null` when there is no call premium. */
  putCallPremiumRatio: number | null;
  /** Net directional premium across all trades (buy − sell). */
  netPremium: number;
}

/**
 * Whether a trade's timestamp and its contract expiry fall on the same **America/New_York** trading
 * day (0DTE) — the same calendar the exposure 0DTE bucket uses. Resolves the expiry with the
 * canonical `optionExpiryToMs` (date-only ⇒ 16:00 ET, matching the rest of the library) and throws —
 * rather than silently returning false — on an unparseable expiry.
 */
function isZeroDteTrade(trade: OptionTrade): boolean {
  return (
    marketDayIndex(trade.timestampMs) === marketDayIndex(optionExpiryToMs(trade.contract.expiry))
  );
}

/**
 * Result of analyzing a stream of option trades. R2 envelope: the rules/windows ride `assumptions`
 * and the heuristic caveats ride `diagnostics.warnings` as `model.limitation` entries — nothing is
 * hoisted top-level.
 */
export class FlowAnalysis {
  /** Frozen result arrays — an analysis is a snapshot; mutate a copy, never the result. */
  readonly trades: readonly Readonly<ClassifiedTrade>[];
  readonly sweeps: readonly Readonly<Sweep>[];
  readonly spreads: readonly Readonly<Spread>[];
  /** The rules/windows the analysis ran under — echoed so a serialized report is self-interpreting. */
  readonly assumptions: Assumptions<{
    /**
     * The aggressor rule actually applied: the NBBO **quote rule** (at/above ask ⇒ buy, at/below bid
     * ⇒ sell, strictly inside ⇒ compare to the midpoint, AT the midpoint ⇒ `unknown`). It is NOT
     * Lee–Ready, which resolves midpoint prints with a **tick test** against the previous trade —
     * this package never sees a trade's predecessor price, so it declines instead of guessing.
     */
    nbboRule: 'quote-rule-midpoint-unknown';
    classificationSource: FlowClassificationSource;
    sweepWindowMs: number;
    spreadWindowMs: number;
    sweepMinPrints: number;
    blockMinSize: number;
    blockMinPremium: number;
    multiplier: number;
    /** Whether any print carried an `exchange`, enabling venue-verified sweep detection (WS2.13). */
    venueVerifiedSweeps: boolean;
  }>;
  /** Structured warnings: `model.limitation` caveats plus any data-quality flags. */
  readonly diagnostics: Diagnostics;

  constructor(rawTrades: OptionTrade[], options: FlowOptions = {}) {
    requireArgumentArray('flow', 'trades', rawTrades);
    requireArgumentObject('flow', 'options', options);
    // Law 12 at the SHARED entry (both `flow()` and direct construction): a misspelled knob
    // (`blockMinSze`) must teach, never silently analyze under the defaults.
    ensureKnownKeys('flow', 'options', options, FLOW_OPTIONS_KEYS);
    const classificationSource = options.classificationSource ?? 'provided-or-quotes';
    if (options.classificationSource !== undefined) {
      requireClassificationSource(options.classificationSource);
    }
    for (const numField of [
      'multiplier',
      'blockMinSize',
      'blockMinPremium',
      'sweepWindowMs',
      'sweepMinPrints',
      'spreadWindowMs',
    ] as const) {
      const numValue = (options as Record<string, unknown>)[numField];
      if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
        throw new InputError(
          `flow: ${numField} must be a finite number when provided. Received ${
            numValue === null ? 'null' : typeof numValue
          }.`,
          { code: ErrorCode.InputWrongType, context: { field: numField } },
        );
      }
    }
    const mult = options.multiplier ?? 100;
    const blockMinSize = options.blockMinSize ?? 100;
    const blockMinPremium = options.blockMinPremium ?? 100_000;
    // Reject nonsensical knobs before they produce negative premium or degenerate block/sweep windows.
    ensurePositive(mult, 'multiplier', 'flow');
    ensureNonNegative(blockMinSize, 'blockMinSize', 'flow');
    ensureNonNegative(blockMinPremium, 'blockMinPremium', 'flow');
    ensurePositive(options.sweepWindowMs ?? 500, 'sweepWindowMs', 'flow');
    ensurePositive(options.spreadWindowMs ?? 100, 'spreadWindowMs', 'flow');
    const sweepMinPrints = options.sweepMinPrints ?? 3;
    // Safe integer (2026-08-23 review, P0): a print-count threshold above 2^53 is no longer exact;
    // it drives no loop (prints are data), but the comparison must be real.
    if (!Number.isSafeInteger(sweepMinPrints) || sweepMinPrints < 1) {
      throw new InputError(`flow: sweepMinPrints must be an integer ≥ 1, got ${sweepMinPrints}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { sweepMinPrints },
      });
    }

    const classified: ClassifiedTrade[] = rawTrades.map((t, i) => {
      const { premium, side, classificationProvenance } = classifyPrint(
        t,
        i,
        mult,
        classificationSource,
      );
      const oi = t.openInterest;
      return {
        trade: t,
        underlying: t.contract.underlying,
        type: t.contract.type,
        strike: t.contract.strike,
        expiry: t.contract.expiry,
        side,
        classificationProvenance,
        premium,
        size: t.size,
        isBlock: t.size >= blockMinSize || premium >= blockMinPremium,
        isZeroDaysToExpiry: isZeroDteTrade(t),
        openClose: oi !== undefined && oi >= 0 && t.size > oi ? 'open' : 'unknown',
      };
    });
    // Stable chronological order for window-based detection.
    classified.sort((a, b) => a.trade.timestampMs - b.trade.timestampMs);

    // Freeze the result arrays (and their rows): callers who mutate a "result" in place would
    // silently diverge from `assumptions`/`diagnostics` — same law as Position.legs (dx §4.4).
    this.sweeps = Object.freeze(
      this.detectSweeps(classified, options).map((s) => Object.freeze(s)),
    );
    this.spreads = Object.freeze(
      this.detectSpreads(classified, options).map((s) => Object.freeze(s)),
    );
    this.trades = Object.freeze(classified.map((t) => Object.freeze(t)));

    // A sweep is venue-verified only if ITS OWN prints span ≥2 exchanges (set per-sweep in
    // detectSweeps). Deriving from the sweeps — not `rawTrades.some(exchange)` — stops one unrelated
    // print carrying an exchange from suppressing the warning for actual timing-only clusters.
    const anyTimingOnlySweep = this.sweeps.some((s) => !s.venueVerified);
    const noExchangeData = !rawTrades.some((t) => t.exchange !== undefined);
    // Echo stays coarse (was venue data available at all). The per-sweep warning below is what
    // actually flags timing-only clusters — one stray exchange must not suppress it (review finding).
    const venueVerifiedSweeps = !noExchangeData;
    // Heuristic caveats are structured warnings (R2 / WS-2.6): `model.limitation`, severity info —
    // never a hoisted top-level field.
    const warnings: QuantWarning[] = [
      warning(
        WarningCode.ModelLimitation,
        `Aggressor classifications follow ${classificationSource}; each print reports supplied versus quote rule provenance. Supplied labels are not independently verified. Quote estimates compare price to NBBO (midpoint = unknown), with no tick test; they are neither Lee–Ready nor exchange-confirmed.`,
        'info',
      ),
      warning(
        WarningCode.ModelLimitation,
        'Sweeps, blocks, and spreads are heuristic groupings over print timing/size, not labeled order types.',
        'info',
      ),
      warning(
        WarningCode.ModelLimitation,
        'Opening estimate only flags a definite open (size > prior OI); closing is never inferred. Delta-adjusted premium, IV-change and earnings flow need external greeks/IV/calendar data (bring your own).',
        'info',
      ),
    ];
    if (anyTimingOnlySweep || noExchangeData) {
      warnings.push(
        warning(
          WarningCode.ModelLimitation,
          'Sweeps could not be venue-verified across ≥2 exchanges (no/partial exchange data or a single-venue burst — an iceberg can masquerade as a sweep); provide `exchange` on every print to require multi-venue.',
          'info',
        ),
        {
          code: WarningCode.FlowSweepsNotVenueVerified,
          message:
            'One or more sweeps are timing-only (their prints did not span ≥2 venues); provide `exchange` on prints to require multi-venue.',
          severity: 'info',
        },
      );
    }
    this.assumptions = {
      conventionsVersion: CONVENTIONS_VERSION,
      nbboRule: 'quote-rule-midpoint-unknown',
      classificationSource,
      sweepWindowMs: options.sweepWindowMs ?? 500,
      spreadWindowMs: options.spreadWindowMs ?? 100,
      sweepMinPrints,
      blockMinSize,
      blockMinPremium,
      multiplier: mult,
      venueVerifiedSweeps,
    };
    this.diagnostics = { warnings };
  }

  private detectSweeps(trades: ClassifiedTrade[], options: FlowOptions): Sweep[] {
    const windowMs = options.sweepWindowMs ?? 500;
    const minPrints = options.sweepMinPrints ?? 3;
    const byContract = new Map<string, ClassifiedTrade[]>();
    for (const t of trades) {
      const key = `${t.underlying}|${t.expiry}|${t.type}|${t.strike}|${t.side}`;
      const arr = byContract.get(key);
      if (arr) arr.push(t);
      else byContract.set(key, [t]);
    }
    const sweeps: Sweep[] = [];
    let id = 0;
    for (const group of byContract.values()) {
      let cluster: ClassifiedTrade[] = [];
      const flush = (): void => {
        // A true intermarket sweep hits ≥2 venues; a single-venue burst is an iceberg, not a sweep
        // (WS2.13). An UNTAGGED print is an UNKNOWN venue, not evidence of a single venue (review
        // finding): only a FULLY-tagged single-venue cluster is a confirmed iceberg and rejected.
        // With partial/no tagging the venue evidence is insufficient, so the cluster falls back to
        // timing-only classification (venueVerified: false, flagged in diagnostics.warnings) rather
        // than being suppressed. ≥2 distinct tagged venues ⇒ venue-verified.
        const tagged = cluster
          .map((c) => c.trade.exchange)
          .filter((e): e is string => e !== undefined);
        const venues = new Set(tagged);
        const confirmedSingleVenue = tagged.length === cluster.length && venues.size === 1;
        if (cluster.length >= minPrints && !confirmedSingleVenue) {
          id++;
          const first = cluster[0]!;
          let size = 0;
          let premium = 0;
          for (const c of cluster) {
            c.sweepId = id;
            size += c.size;
            premium += c.premium;
          }
          sweeps.push({
            id,
            underlying: first.underlying,
            strike: first.strike,
            type: first.type,
            expiry: first.expiry,
            side: first.side,
            prints: cluster.length,
            size,
            premium,
            startTimestampMs: first.trade.timestampMs,
            endTimestampMs: cluster[cluster.length - 1]!.trade.timestampMs,
            venueVerified: venues.size >= 2,
          });
        }
        cluster = [];
      };
      for (const t of group) {
        if (
          cluster.length === 0 ||
          t.trade.timestampMs - cluster[cluster.length - 1]!.trade.timestampMs <= windowMs
        ) {
          cluster.push(t);
        } else {
          flush();
          cluster = [t];
        }
      }
      flush();
    }
    return sweeps;
  }

  private detectSpreads(trades: ClassifiedTrade[], options: FlowOptions): Spread[] {
    const windowMs = options.spreadWindowMs ?? 100;
    const byUnderlying = new Map<string, ClassifiedTrade[]>();
    for (const t of trades) {
      const arr = byUnderlying.get(t.underlying);
      if (arr) arr.push(t);
      else byUnderlying.set(t.underlying, [t]);
    }
    const spreads: Spread[] = [];
    let id = 0;
    for (const group of byUnderlying.values()) {
      let cluster: ClassifiedTrade[] = [];
      const flush = (): void => {
        const distinct = new Set(cluster.map((c) => `${c.type}|${c.strike}|${c.expiry}`));
        // Real multi-leg spreads execute in size proportion (ratio ∈ [1/4, 4]) within the same
        // second (WS2.13) — this stops a 500-lot and an unrelated 3-lot print from being glued into
        // a bogus "spread". The label remains an estimate.
        const sizes = cluster.map((c) => c.size);
        const minSize = Math.min(...sizes);
        const maxSize = Math.max(...sizes);
        const sizeCompatible = minSize > 0 && maxSize / minSize <= 4;
        const sameSecond =
          cluster[cluster.length - 1]!.trade.timestampMs - cluster[0]!.trade.timestampMs <= 1000;
        if (cluster.length >= 2 && distinct.size >= 2 && sizeCompatible && sameSecond) {
          id++;
          let netPremium = 0;
          let directionKnown = true;
          for (const c of cluster) {
            c.spreadId = id;
            // An `unknown` aggressor must NOT be counted as a buy: exclude it from net directional
            // premium (sign 0) and flag the spread direction-uncertain (review finding).
            const sign = c.side === 'buy' ? 1 : c.side === 'sell' ? -1 : 0;
            if (sign === 0) directionKnown = false;
            netPremium += sign * c.premium;
          }
          spreads.push({
            id,
            underlying: cluster[0]!.underlying,
            timestampMs: cluster[0]!.trade.timestampMs,
            legs: distinct.size,
            netPremium,
            directionKnown,
            contracts: cluster.map((c) => ({
              type: c.type,
              strike: c.strike,
              expiry: c.expiry,
              size: c.size,
              side: c.side,
            })),
          });
        }
        cluster = [];
      };
      for (const t of group) {
        if (cluster.length === 0 || t.trade.timestampMs - cluster[0]!.trade.timestampMs <= windowMs)
          cluster.push(t);
        else {
          flush();
          cluster = [t];
        }
      }
      flush();
    }
    return spreads;
  }

  /** Blocks: single prints large by size or premium. */
  get blocks(): ClassifiedTrade[] {
    return this.trades.filter((t) => t.isBlock);
  }

  /** 0DTE trades: prints on a contract expiring the same calendar day. */
  get zeroDaysToExpiry(): ClassifiedTrade[] {
    return this.trades.filter((t) => t.isZeroDaysToExpiry);
  }

  /** Call-vs-put premium and volume across all trades, with put/call ratios and net premium. */
  callPutPremium(): CallPutPremium {
    let callPremium = 0;
    let putPremium = 0;
    let callVolume = 0;
    let putVolume = 0;
    let buy = 0;
    let sell = 0;
    for (const t of this.trades) {
      if (t.type === 'call') {
        callPremium += t.premium;
        callVolume += t.size;
      } else {
        putPremium += t.premium;
        putVolume += t.size;
      }
      if (t.side === 'buy') buy += t.premium;
      else if (t.side === 'sell') sell += t.premium;
    }
    return {
      callPremium,
      putPremium,
      callVolume,
      putVolume,
      // Chart-facing: null (JSON-safe) when there is no call side, never NaN (WS2.12).
      putCallVolumeRatio: callVolume > 0 ? putVolume / callVolume : null,
      putCallPremiumRatio: callPremium > 0 ? putPremium / callPremium : null,
      netPremium: buy - sell,
    };
  }

  /** Aggregate trades into groups keyed by any subset of underlying/expiry/strike/type. */
  groupBy(keys: Array<keyof FlowGroupKey>): FlowGroup[] {
    const groups = new Map<string, { key: FlowGroupKey; rows: ClassifiedTrade[] }>();
    for (const t of this.trades) {
      const key: FlowGroupKey = {};
      if (keys.includes('underlying')) key.underlying = t.underlying;
      if (keys.includes('expiry')) key.expiry = t.expiry;
      if (keys.includes('strike')) key.strike = t.strike;
      if (keys.includes('type')) key.type = t.type;
      const id = JSON.stringify(key);
      const g = groups.get(id);
      if (g) g.rows.push(t);
      else groups.set(id, { key, rows: [t] });
    }
    const out: FlowGroup[] = [];
    for (const { key, rows } of groups.values()) {
      let size = 0;
      let premium = 0;
      let buyPremium = 0;
      let sellPremium = 0;
      for (const r of rows) {
        size += r.size;
        premium += r.premium;
        if (r.side === 'buy') buyPremium += r.premium;
        else if (r.side === 'sell') sellPremium += r.premium;
      }
      const group: FlowGroup = {
        ...key,
        trades: rows.length,
        size,
        premium,
        buyPremium,
        sellPremium,
        netPremium: buyPremium - sellPremium,
        volumeOpenInterestRatio: null, // JSON-safe default; set below when the group is one contract with OI.
      };
      // Volume/OI ratio when the group is a single contract with a known open interest.
      if (
        keys.includes('underlying') &&
        keys.includes('expiry') &&
        keys.includes('strike') &&
        keys.includes('type')
      ) {
        const oi = rows[0]!.trade.openInterest;
        if (oi !== undefined && oi > 0) group.volumeOpenInterestRatio = size / oi;
      }
      out.push(group);
    }
    return out;
  }

  /** Filter and sort groups (default: by premium, descending). */
  rank(groups: FlowGroup[], options: RankOptions = {}): FlowGroup[] {
    // Law 12 at every knob-bearing entry. This one was open: `rank` read its options by property and
    // never rejected an unknown key, so a caller still writing the retired `minVolumeOiRatio` would
    // have had the filter SILENTLY not applied and received a longer list than they asked for. A
    // renamed field that is merely ignored is the failure mode 3B.N exists to prevent.
    requireArgumentObject('rank', 'options', options);
    ensureKnownKeys('rank', 'options', options, RANK_OPTIONS_KEYS);
    const by = options.by ?? 'premium';
    if (!RANK_BY_KEYS.includes(by)) {
      throw new InputError(`rank: by must be one of ${RANK_BY_KEYS.join(', ')}; got "${by}".`, {
        code: ErrorCode.InputInvalidEnum,
        context: { by },
      });
    }
    // Safe integer (2026-08-23 review, P0): `slice(0, limit)` is bounded by the group count, but
    // the requested limit must be an exact count — above 2^53 it is not.
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 0)
    ) {
      throw new InputError(
        `rank: limit must be a non-negative safe integer; omit it to return every ranked group. Got ${options.limit}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { limit: options.limit },
        },
      );
    }
    // A NaN threshold makes every `>=` comparison false (silent empty result); a negative one is
    // domain-invalid for a ratio and a no-op filter for premium — reject both for consistency.
    if (options.minPremium !== undefined)
      ensureNonNegative(options.minPremium, 'minPremium', 'rank');
    if (options.minVolumeOpenInterestRatio !== undefined) {
      ensureNonNegative(options.minVolumeOpenInterestRatio, 'minVolumeOpenInterestRatio', 'rank');
    }
    let rows = groups;
    if (options.minPremium !== undefined)
      rows = rows.filter((g) => g.premium >= options.minPremium!);
    if (options.minVolumeOpenInterestRatio !== undefined) {
      rows = rows.filter(
        (g) => (g.volumeOpenInterestRatio ?? 0) >= options.minVolumeOpenInterestRatio!,
      );
    }
    rows = [...rows].sort((a, b) => (b[by] ?? 0) - (a[by] ?? 0));
    return options.limit !== undefined ? rows.slice(0, options.limit) : rows;
  }
}

/** Analyze a stream of option trades for aggressor, sweeps, blocks, and spreads. */
export function flow(trades: OptionTrade[], options: FlowOptions = {}): FlowAnalysis {
  requireArgumentArray('flow', 'trades', trades);
  requireArgumentObject('flow', 'options', options);
  return new FlowAnalysis(trades, options);
}

// ───────────────────────── directional flow intelligence (spec §11.6) ─────────────────────────

/**
 * One directional flow print. `delta` is the option's signed delta at the print — caller-supplied
 * from their own greeks (this package never fabricates greeks), keeping the compute pure.
 */
export interface DirectionalFlowTrade {
  type: OptionType;
  /** Estimated aggressor side (e.g. from {@link FlowAnalysis}). */
  side: 'buy' | 'sell';
  /** Trade premium in dollars (`price · size · multiplier`). */
  premium: number;
  /** Signed option delta at the print (calls > 0, puts < 0). */
  delta: number;
}

export interface DeltaAdjustedPremium {
  /** Σ |delta|·premium over prints whose directional lean is bullish (bought calls / sold puts). */
  bullishPremium: number;
  /** Σ |delta|·premium over bearish prints (bought puts / sold calls). */
  bearishPremium: number;
  /** `bullishPremium − bearishPremium` — net directional delta-adjusted premium (> 0 = net bullish). */
  netDirectional: number;
  /** Σ |delta|·premium regardless of direction — the total delta-weighted premium. */
  totalDeltaAdjusted: number;
}

/**
 * Delta-adjusted (delta-weighted) premium of a set of directional flow prints (spec §11.6, product
 * review §4). Weighting premium by |delta| turns raw premium into an approximate directional
 * exposure: deep-ITM bought calls move the tape far more than lottery-ticket wings of the same
 * premium. A print leans **bullish** when it is a bought call or a sold put and **bearish** when it
 * is a bought put or a sold call. Pure; greeks are an explicit input.
 */
export function deltaAdjustedPremium(
  trades: readonly DirectionalFlowTrade[],
): DeltaAdjustedPremium {
  requireArgumentArray('deltaAdjustedPremium', 'trades', trades as never);
  const functionName = 'deltaAdjustedPremium';
  let bullish = 0;
  let bearish = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    if (t.type !== 'call' && t.type !== 'put') {
      throw new InputError(
        `${functionName}: trades[${i}].type must be 'call' or 'put', got "${t.type}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { index: i, type: t.type },
        },
      );
    }
    if (t.side !== 'buy' && t.side !== 'sell') {
      throw new InputError(
        `${functionName}: trades[${i}].side must be 'buy' or 'sell', got "${t.side}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { index: i, side: t.side },
        },
      );
    }
    ensureNonNegative(t.premium, `trades[${i}].premium`, functionName);
    ensureFinite(t.delta, `trades[${i}].delta`, functionName);
    // A genuine option delta lives in [−1, 1]; a value outside it (e.g. 2) would inflate the
    // directional weight, so reject it rather than silently double-count the premium.
    if (Math.abs(t.delta) > 1) {
      throw new InputError(
        `${functionName}: trades[${i}].delta must be within [-1, 1], got ${t.delta}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, delta: t.delta },
        },
      );
    }
    const w = Math.abs(t.delta) * t.premium;
    const bullishLean = (t.type === 'call') === (t.side === 'buy'); // bought call / sold put
    if (bullishLean) bullish += w;
    else bearish += w;
  }
  return {
    bullishPremium: bullish,
    bearishPremium: bearish,
    netDirectional: bullish - bearish,
    totalDeltaAdjusted: bullish + bearish,
  };
}

export interface Unusualness {
  /** `(value − mean) / stdev` of the baseline; `null` when the baseline is flat (no defined z). */
  zScore: number | null;
  /** Percentile of `value` within the baseline, in `[0, 100]` (share strictly below). */
  percentile: number;
  mean: number;
  /** Sample standard deviation of the baseline. */
  stdev: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; baselineLength: number };
  /** Structured warnings; always present (possibly empty) — a flat baseline explains its null z. */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Unusualness of a reading versus a caller-supplied baseline history (spec §11.6, product review §4):
 * the z-score and percentile of `value` against `baseline` (e.g. today's contract volume vs. its
 * trailing daily volumes). The baseline is bring-your-own — this package stores no history. A flat
 * baseline has no defined spread, so the z-score is `null` (never fabricated).
 */
export function unusualness(value: number, baseline: ArrayLike<number>): Unusualness {
  requireArgumentArray('unusualness', 'baseline', baseline);
  const functionName = 'unusualness';
  ensureFinite(value, 'value', functionName);
  if (baseline.length === 0) {
    throw new InputError(`${functionName}: baseline must be non-empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { length: 0 },
    });
  }
  for (let i = 0; i < baseline.length; i++) {
    ensureFinite(baseline[i]!, `baseline[${i}]`, functionName);
  }
  const mu = mean(baseline);
  const sd = baseline.length > 1 ? standardDeviation(baseline) : 0;
  let below = 0;
  for (let i = 0; i < baseline.length; i++) if (baseline[i]! < value) below++;
  const warnings: QuantWarning[] = [];
  if (!(sd > 0)) {
    warnings.push({
      code: WarningCode.StructureFlatBaseline,
      message:
        'unusualness: the baseline has no spread (every value identical or a single sample) — the z-score is undefined and reported as null.',
      severity: 'info',
      context: { baselineLength: baseline.length },
    });
  }
  return {
    // Chart-facing: null (JSON-safe) when the baseline is flat, never NaN (WS2.12).
    zScore: sd > 0 ? (value - mu) / sd : null,
    percentile: (below / baseline.length) * 100,
    mean: mu,
    stdev: sd,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, baselineLength: baseline.length },
    diagnostics: { warnings },
  };
}
