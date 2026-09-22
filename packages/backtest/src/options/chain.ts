/**
 * Chain access helpers for the options backtester: resolve snapshot times, compute days-to-expiry,
 * list and select expiries, and bridge the declarative entry rule onto `strategyFromChain` — or, for
 * the multi-expiry structures (Stage 4.6), onto `@insiderfinance/totalfinance/strategy`'s calendar and diagonal
 * constructors with the near leg chosen by delta and the far leg by days.
 */

import {
  type EpochMs,
  InputError,
  ErrorCode,
  type PriceSource,
  isoDateToEpochMs,
  resolveValuationAsOf,
  selectQuotePrice,
  usEquityMarketDateUtcMs,
  type OptionQuote,
} from '@totalfinance/core';
import {
  type FromChainOptions,
  type Position,
  calendarCallSpread,
  calendarPutSpread,
  diagonalCallSpread,
  diagonalPutSpread,
  doubleDiagonal,
  strategyFromChain,
} from '@totalfinance/strategy';
import type {
  ChainSnapshot,
  DaysToExpiryTarget,
  EntryRule,
  MultiExpirySelection,
  MultiExpiryStructure,
} from './types.js';

const DAY_MS = 86_400_000;

/**
 * Resolve a snapshot's `asOf` to epoch ms through core's valuation-instant door: epoch ms or a zoned
 * datetime. A bare date is refused with the fix — an end-of-day chain is observed at the close, so
 * pass `usEquitySessionInstant(date, 'close')`.
 */
export function snapshotAsOf(snap: ChainSnapshot, functionName: string): EpochMs {
  return resolveValuationAsOf(snap.asOf, functionName);
}

/**
 * Calendar days from `asOf` (its America/New_York market DATE) to an ISO expiry — the
 * trader-standard DTE. The day boundary is the market's, not UTC's: a 21:30 ET snapshot is already
 * tomorrow in UTC and would otherwise count one day short.
 */
export function daysToExpiry(asOfMs: EpochMs, expiry: string): number {
  const asOfDateMs = usEquityMarketDateUtcMs(asOfMs);
  return Math.round((isoDateToEpochMs(expiry) - asOfDateMs) / DAY_MS);
}

/** Distinct expiries present in a snapshot's quotes, ascending. */
export function listExpiries(snap: ChainSnapshot): string[] {
  const set = new Set<string>();
  for (const q of snap.quotes) set.add(q.contract.expiry);
  return [...set].sort();
}

/**
 * The listed expiry whose DTE is nearest `dte.target` within `[min, max]`, or `null` when no listed
 * expiry falls in range (the caller discloses the skip — never fabricates a fill).
 */
export function nearestExpiryByDaysToExpiry(
  snap: ChainSnapshot,
  asOfMs: EpochMs,
  target: DaysToExpiryTarget,
): { expiry: string; daysToExpiry: number } | null {
  // Opening an already-expired (or same-bar-settling) expiry is degenerate — it would settle the
  // instant it opens. Skip `dte ≤ 0` unless the caller explicitly options into it via `dte.min ≤ 0`.
  const allowExpired = target.min !== undefined && target.min <= 0;
  let best: { expiry: string; daysToExpiry: number } | null = null;
  for (const expiry of listExpiries(snap)) {
    const d = daysToExpiry(asOfMs, expiry);
    if (!allowExpired && d <= 0) continue;
    if (target.min !== undefined && d < target.min) continue;
    if (target.max !== undefined && d > target.max) continue;
    if (
      best === null ||
      Math.abs(d - target.target) < Math.abs(best.daysToExpiry - target.target)
    ) {
      best = { expiry, daysToExpiry: d };
    }
  }
  return best;
}

/** The signed quantity a sizing rule resolves to (validated positive). */
export function resolveQuantity(sizing: EntryRule['sizing']): number | 'margin' {
  if (sizing === undefined) return 1;
  if ('quantity' in sizing) return sizing.quantity;
  return 'margin';
}

const MULTI_EXPIRY: ReadonlySet<string> = new Set<MultiExpiryStructure>([
  'calendarCallSpread',
  'calendarPutSpread',
  'diagonalCallSpread',
  'diagonalPutSpread',
  'doubleDiagonal',
]);

/** True for the calendar/diagonal structures (Stage 4.6). */
export function isMultiExpiryStructure(structure: string): structure is MultiExpiryStructure {
  return MULTI_EXPIRY.has(structure);
}

/** The quotes of one expiry and right, with a finite delta, |delta| nearest the target. */
function nearestByAbsDelta(
  rows: readonly OptionQuote[],
  expiry: string,
  right: 'call' | 'put',
  target: number,
  label: string,
): OptionQuote {
  let best: OptionQuote | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let seen = 0;
  for (const q of rows) {
    if (q.contract.expiry !== expiry || q.contract.type !== right) continue;
    seen += 1;
    const delta = q.greeks?.delta;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
    const distance = Math.abs(Math.abs(delta) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = q;
    }
  }
  if (best === null) {
    throw new InputError(
      seen === 0
        ? `no ${right} quotes listed for ${expiry} (${label})`
        : `the ${expiry} ${right} quotes carry no finite delta — delta selection needs one per quote (${label})`,
      { code: ErrorCode.InputOutOfRange, context: { expiry, right, target } },
    );
  }
  return best;
}

/** The quote of one expiry, right, and strike; `null` when none is listed. */
function atStrike(
  rows: readonly OptionQuote[],
  expiry: string,
  right: 'call' | 'put',
  strike: number,
): OptionQuote | null {
  const matches = rows.filter(
    (q) =>
      q.contract.expiry === expiry && q.contract.type === right && q.contract.strike === strike,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function premiumOf(quote: OptionQuote, source: PriceSource, label: string): number {
  const price = selectQuotePrice(quote, source);
  if (price === undefined || !Number.isFinite(price)) {
    throw new InputError(`${label}: the quote carries no usable '${source}' price`, {
      code: ErrorCode.InputOutOfRange,
      context: { strike: quote.contract.strike, expiry: quote.contract.expiry },
    });
  }
  return price;
}

/**
 * Build a calendar / diagonal / double diagonal from the chain: the short near leg by |delta| on the
 * near expiry, the long far leg on the far expiry at the same strike (calendar) or `width` away
 * (diagonal: a call diagonal's long strike is `width` above, a put diagonal's `width` below).
 */
export function buildMultiExpiryPosition(
  structure: MultiExpiryStructure,
  select: MultiExpirySelection,
  snap: ChainSnapshot,
  asOfMs: EpochMs,
  quantity: number,
  price: PriceSource,
): { position: Position; quotes: (OptionQuote | null)[] } | { skip: string } {
  const near = nearestExpiryByDaysToExpiry(snap, asOfMs, select.nearDaysToExpiry);
  if (near === null) {
    return {
      skip: `no listed near expiry within DTE [${select.nearDaysToExpiry.min ?? '−∞'}, ${select.nearDaysToExpiry.max ?? '∞'}] near ${select.nearDaysToExpiry.target}`,
    };
  }
  const far = nearestExpiryByDaysToExpiry(snap, asOfMs, select.farDaysToExpiry);
  if (far === null) {
    return {
      skip: `no listed far expiry within DTE [${select.farDaysToExpiry.min ?? '−∞'}, ${select.farDaysToExpiry.max ?? '∞'}] near ${select.farDaysToExpiry.target}`,
    };
  }
  if (far.expiry <= near.expiry) {
    return {
      skip: `the far expiry ${far.expiry} is not later than the near expiry ${near.expiry} — widen farDaysToExpiry`,
    };
  }
  const isCalendar = structure === 'calendarCallSpread' || structure === 'calendarPutSpread';
  if (isCalendar && select.width !== undefined) {
    throw new InputError(
      `buildMultiExpiryPosition: a ${structure} has one strike — omit select.width (a diagonal carries the width).`,
      { code: ErrorCode.InputUnknownField, context: { field: 'select.width' } },
    );
  }
  if (!isCalendar && !(typeof select.width === 'number' && select.width > 0)) {
    throw new InputError(
      `buildMultiExpiryPosition: a ${structure} needs select.width > 0 (the far leg's strike distance).`,
      {
        code: ErrorCode.InputMissingField,
        context: { field: 'select.width' },
      },
    );
  }
  try {
    const side = (
      right: 'call' | 'put',
    ): {
      shortStrike: number;
      shortPremium: number;
      longStrike: number;
      longPremium: number;
    } => {
      const shortQuote = nearestByAbsDelta(
        snap.quotes,
        near.expiry,
        right,
        select.shortDelta,
        `${structure} short ${right}`,
      );
      const shortStrike = shortQuote.contract.strike;
      const longStrike = isCalendar
        ? shortStrike
        : right === 'call'
          ? shortStrike + select.width!
          : shortStrike - select.width!;
      const longQuote = atStrike(snap.quotes, far.expiry, right, longStrike);
      if (longQuote === null) {
        throw new InputError(
          `side: no ${far.expiry} ${right} listed at strike ${longStrike} for the far leg of the ${structure}`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { expiry: far.expiry, right, strike: longStrike },
          },
        );
      }
      return {
        shortStrike,
        shortPremium: premiumOf(shortQuote, price, `${structure} short ${right}`),
        longStrike,
        longPremium: premiumOf(longQuote, price, `${structure} long ${right}`),
      };
    };
    switch (structure) {
      case 'calendarCallSpread':
      case 'calendarPutSpread': {
        const right = structure === 'calendarCallSpread' ? 'call' : 'put';
        const s = side(right);
        const build = right === 'call' ? calendarCallSpread : calendarPutSpread;
        const position = build({
          strike: s.shortStrike,
          nearExpiry: near.expiry,
          shortPremium: s.shortPremium,
          farExpiry: far.expiry,
          longPremium: s.longPremium,
          quantity,
        });
        return { position, quotes: quotesForLegs(position, snap) };
      }
      case 'diagonalCallSpread':
      case 'diagonalPutSpread': {
        const right = structure === 'diagonalCallSpread' ? 'call' : 'put';
        const s = side(right);
        const build = right === 'call' ? diagonalCallSpread : diagonalPutSpread;
        const position = build({
          shortStrike: s.shortStrike,
          shortPremium: s.shortPremium,
          nearExpiry: near.expiry,
          longStrike: s.longStrike,
          longPremium: s.longPremium,
          farExpiry: far.expiry,
          quantity,
        });
        return { position, quotes: quotesForLegs(position, snap) };
      }
      case 'doubleDiagonal': {
        const call = side('call');
        const put = side('put');
        const position = doubleDiagonal({
          nearExpiry: near.expiry,
          farExpiry: far.expiry,
          call: {
            shortStrike: call.shortStrike,
            shortPremium: call.shortPremium,
            longStrike: call.longStrike,
            longPremium: call.longPremium,
          },
          put: {
            shortStrike: put.shortStrike,
            shortPremium: put.shortPremium,
            longStrike: put.longStrike,
            longPremium: put.longPremium,
          },
          quantity,
        });
        return { position, quotes: quotesForLegs(position, snap) };
      }
    }
  } catch (err) {
    if (err instanceof InputError) return { skip: err.message };
    throw err;
  }
}

/**
 * The chain row each option leg was filled from, aligned to `position.legs` (`null` for a stock
 * leg or a contract the snapshot does not list exactly once) — the fill policy's usability checks
 * walk the legs in the structure's order.
 */
export function quotesForLegs(
  position: Position,
  snap: ChainSnapshot,
  positionExpiry?: string,
): (OptionQuote | null)[] {
  return position.legs.map((leg) => {
    if (leg.kind === 'stock') return null;
    const expiry = leg.expiry ?? positionExpiry;
    if (expiry === undefined) return null;
    return atStrike(snap.quotes, expiry, leg.kind, leg.strike);
  });
}

/**
 * Build the entry position from a snapshot: pick the expiry by DTE, then either run the caller's
 * `build` escape hatch, or map the declarative `structure` + `select` onto `strategyFromChain` (or
 * the multi-expiry constructors). Returns the skip reason when no position could be built — the
 * engine discloses it. `quotes` are the chain rows the legs were filled from (a `build` position has
 * none), in leg order, for the fill policy's usability checks.
 */
export function buildEntryPosition(
  entry: EntryRule,
  snap: ChainSnapshot,
  asOfMs: EpochMs,
  quantity: number,
  ctxBuild: () => Position | null,
): { position: Position; quotes: (OptionQuote | null)[] } | { skip: string } {
  // The escape hatch owns everything (expiry, strikes, structure).
  if ('build' in entry) {
    const position = ctxBuild();
    return position ? { position, quotes: [] } : { skip: 'entry.build returned null' };
  }
  if (isMultiExpiryStructure(entry.structure)) {
    return buildMultiExpiryPosition(
      entry.structure,
      entry.select as MultiExpirySelection,
      snap,
      asOfMs,
      quantity,
      entry.price ?? 'mid',
    );
  }

  const chosen = nearestExpiryByDaysToExpiry(snap, asOfMs, entry.daysToExpiry);
  if (chosen === null) {
    return {
      skip: `no listed expiry within DTE [${entry.daysToExpiry.min ?? '−∞'}, ${entry.daysToExpiry.max ?? '∞'}] near ${entry.daysToExpiry.target}`,
    };
  }

  const common = {
    expiry: chosen.expiry,
    quantity,
    price: entry.price ?? ('mid' as const),
    spot: snap.underlyingPrice,
  };
  // The declarative structure maps 1:1 onto strategyFromChain's option grammar.
  const options = { type: entry.structure, ...entry.select, ...common } as FromChainOptions;
  try {
    const built = strategyFromChain(snap.quotes, options);
    return { position: built.position, quotes: quotesForLegs(built.position, snap, chosen.expiry) };
  } catch (err) {
    // A chain that can't satisfy the selection (no strike at the target delta, missing deltas, …)
    // is a disclosed skip, never a fabricated fill. Non-QuantErrors still propagate (real bugs).
    if (err instanceof InputError) return { skip: err.message };
    throw err;
  }
}

/** Guard a chain snapshot's shape at the boundary (teaching error, not a raw crash). */
export function requireSnapshot(
  snap: unknown,
  index: number,
  functionName: string,
): asserts snap is ChainSnapshot {
  const s = snap as Partial<ChainSnapshot> | null;
  if (
    s === null ||
    typeof s !== 'object' ||
    (typeof s.asOf !== 'number' && typeof s.asOf !== 'string') ||
    typeof s.underlyingPrice !== 'number' ||
    !Array.isArray(s.quotes)
  ) {
    throw new InputError(
      `${functionName}: chains[${index}] must be a ChainSnapshot { asOf, underlyingPrice, quotes: OptionQuote[] }.`,
      { code: ErrorCode.InputWrongType, context: { index } },
    );
  }
}
