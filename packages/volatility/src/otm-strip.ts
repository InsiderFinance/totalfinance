/**
 * Shared OTM-strip extraction for the model-free chain indices (variance index, tail-risk / SKEW). From
 * a raw option chain it derives, per expiry, the put–call-parity **forward** and the **OTM strip** (puts
 * below the forward, calls above, averaged at the money) that both the DDKZ variance replication and the
 * Bakshi–Kapadia–Madan moment estimators integrate over. An expiry that can't be replicated (< 3 OTM
 * strikes, no strike carrying both a call and a put, no bracketing forward strike) is dropped with a
 * disclosed warning — never fabricated. Internal to `@insiderfinance/totalfinance/volatility` (not part of the package surface).
 */

import {
  type EpochMs,
  ErrorCode,
  InputError,
  type OptionQuote,
  type QuantWarning,
  WarningCode,
  optionExpiryToMs,
  requireArgumentObject,
  resolveValuationAsOf,
  usEquityMarketDayIndex,
  warning,
  yearFraction,
} from '@totalfinance/core';

const DAY_MS = 86_400_000;

/**
 * The US options market's calendar day (America/New_York) as a whole-day index. Expiries resolve to
 * 16:00 ET, i.e. 20:00/21:00 **UTC**, so flooring both instants to UTC midnight counts the wrong
 * boundary: an evening-ET snapshot (21:30 ET Thursday = 01:30 UTC Friday) already sits on the next
 * UTC date, and every `daysToExpiry` on the chain came back one day SHORT — which shifts the
 * variance-index T₁/T₂ interpolation weights (and can drop the 30-day bracket) at the UTC rollover,
 * mid-session in Asia. Pure: reads only the timestamp it is given.
 */
function marketDayIndex(epochMs: EpochMs): number {
  return usEquityMarketDayIndex(epochMs);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The market day of the `asOf` **as the caller expressed it**: a date-only `'YYYY-MM-DD'` names a
 * trading DATE and is taken literally (core resolves it to UTC midnight = 19:00/20:00 ET the previous
 * day, which must not be re-zoned into the day before); anything else is an instant, mapped to the ET
 * date it falls on.
 */
function asOfMarketDayIndex(asOf: EpochMs | string, resolvedMs: EpochMs): number {
  if (typeof asOf === 'string') {
    const m = DATE_ONLY.exec(asOf);
    if (m) return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
  }
  return marketDayIndex(resolvedMs);
}

/** One expiry's OTM strip, ready for a model-free integral. */
export interface OtmStrip {
  expiry: string;
  /** Year fraction to expiry (ACT/365F, to the 16:00-ET expiry instant). */
  timeToExpiryYears: number;
  /** Whole calendar days to expiry, counted between America/New_York trading DATES. */
  daysToExpiry: number;
  /** Put–call-parity forward. */
  forward: number;
  /** OTM strikes, ascending. */
  strikes: number[];
  /** OTM option mids at `strikes` (put below the forward, call above, averaged at K₀). */
  otmPrices: number[];
}

/** Best available mid for a quote: `mid`, else `(bid+ask)/2`, else `mark`, else `last`. */
export function midOf(q: OptionQuote): number | undefined {
  if (typeof q.mid === 'number' && Number.isFinite(q.mid)) return q.mid;
  if (
    typeof q.bid === 'number' &&
    typeof q.ask === 'number' &&
    Number.isFinite(q.bid) &&
    Number.isFinite(q.ask)
  ) {
    return (q.bid + q.ask) / 2;
  }
  if (typeof q.mark === 'number' && Number.isFinite(q.mark)) return q.mark;
  if (typeof q.last === 'number' && Number.isFinite(q.last)) return q.last;
  return undefined;
}

interface CallPut {
  call?: number;
  put?: number;
}

/** Group a chain into `expiry → strike → { call, put } mids`, validating each quote's contract. */
function groupChain(
  quotes: readonly OptionQuote[],
  functionName: string,
): Map<string, Map<number, CallPut>> {
  const byExpiry = new Map<string, Map<number, CallPut>>();
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i]!;
    requireArgumentObject(functionName, `quotes[${i}]`, q);
    const c = (q as OptionQuote).contract;
    requireArgumentObject(functionName, `quotes[${i}].contract`, c);
    const { type, strike, expiry } = c;
    if (
      (type !== 'call' && type !== 'put') ||
      typeof strike !== 'number' ||
      typeof expiry !== 'string'
    ) {
      throw new InputError(
        `${functionName}: quotes[${i}].contract must be { type: 'call'|'put', strike: number, expiry: 'YYYY-MM-DD' }.`,
        { code: ErrorCode.InputWrongType, context: { index: i } },
      );
    }
    const price = midOf(q);
    if (price === undefined || !(price >= 0)) continue; // no usable mid — skip this quote
    let byStrike = byExpiry.get(expiry);
    if (byStrike === undefined) {
      byStrike = new Map<number, CallPut>();
      byExpiry.set(expiry, byStrike);
    }
    const cp = byStrike.get(strike) ?? {};
    if (type === 'call') cp.call = price;
    else cp.put = price;
    byStrike.set(strike, cp);
  }
  return byExpiry;
}

/** Extract one expiry's OTM strip (forward + strikes + OTM prices), or a disclosed skip reason. */
function stripForExpiry(input: {
  expiry: string;
  byStrike: Map<number, CallPut>;
  asOf: EpochMs;
  /** The snapshot's America/New_York day index (see {@link marketDayIndex}). */
  asOfDayIndex: number;
  riskFreeRate: number;
}): OtmStrip | { skip: string } {
  const { expiry, byStrike, asOf: asOfMs, asOfDayIndex, riskFreeRate } = input;
  const expiryMs = optionExpiryToMs(expiry);
  const t = yearFraction(asOfMs, expiryMs, 'ACT/365F');
  if (!(t > 0)) return { skip: 'already expired' };

  // Forward from put–call parity at the strike with the smallest |C − P| (most at-the-money).
  const paired = [...byStrike.entries()].filter(
    ([, cp]) => cp.call !== undefined && cp.put !== undefined,
  );
  if (paired.length === 0)
    return { skip: 'no strike carries both a call and a put to imply the forward' };
  let kStar = paired[0]![0];
  let bestGap = Infinity;
  for (const [k, cp] of paired) {
    const gap = Math.abs(cp.call! - cp.put!);
    if (gap < bestGap) {
      bestGap = gap;
      kStar = k;
    }
  }
  const disc = Math.exp(riskFreeRate * t);
  const cpStar = byStrike.get(kStar)!;
  const forward = kStar + disc * (cpStar.call! - cpStar.put!);
  if (!(forward > 0)) return { skip: `non-positive parity forward (${forward})` };

  // K0 = the highest strike ≤ forward; the OTM strip is puts below, calls above, averaged at K0.
  const strikesAsc = [...byStrike.keys()].sort((a, b) => a - b);
  let k0: number | undefined;
  for (const k of strikesAsc) if (k <= forward) k0 = k;
  if (k0 === undefined) return { skip: `no strike at or below the forward ${forward}` };

  const strikes: number[] = [];
  const otmPrices: number[] = [];
  for (const k of strikesAsc) {
    const cp = byStrike.get(k)!;
    let price: number | undefined;
    if (k < k0) price = cp.put;
    else if (k > k0) price = cp.call;
    else
      price =
        cp.call !== undefined && cp.put !== undefined
          ? (cp.call + cp.put) / 2
          : (cp.call ?? cp.put);
    if (price === undefined || !Number.isFinite(price) || price < 0) continue;
    strikes.push(k);
    otmPrices.push(price);
  }
  if (strikes.length < 3) return { skip: `only ${strikes.length} usable OTM strikes (need ≥ 3)` };

  return {
    expiry,
    timeToExpiryYears: t,
    // Whole calendar days between the two MARKET dates (America/New_York). `expiryMs` is the 16:00-ET
    // expiry instant (≈ 20:00–21:00 UTC), so neither instant may be compared on the UTC clock: the
    // expiry would round a day up, and an evening-ET `asOf` a day down.
    daysToExpiry: marketDayIndex(expiryMs) - asOfDayIndex,
    forward,
    strikes,
    otmPrices,
  };
}

/**
 * Build the per-expiry OTM strips from a chain (ascending by DTE), disclosing every dropped expiry. The
 * shared front-door for the model-free chain indices; each consumer computes its own moments over the
 * returned strips.
 */
export function extractOtmStrips(
  quotes: readonly OptionQuote[],
  options: { rate: number; asOf: EpochMs | string },
  functionName: string,
): { strips: OtmStrip[]; warnings: QuantWarning[]; asOfMs: EpochMs } {
  const asOfMs = resolveValuationAsOf(options.asOf, functionName);
  const asOfDayIndex = asOfMarketDayIndex(options.asOf, asOfMs);
  const byExpiry = groupChain(quotes, functionName);
  const strips: OtmStrip[] = [];
  const warnings: QuantWarning[] = [];
  for (const [expiry, byStrike] of byExpiry) {
    const s = stripForExpiry({
      expiry,
      byStrike,
      asOf: asOfMs,
      asOfDayIndex,
      riskFreeRate: options.rate,
    });
    if ('skip' in s) {
      warnings.push(
        warning(WarningCode.ModelLimitation, `expiry ${expiry} dropped: ${s.skip}.`, 'info', {
          expiry,
        }),
      );
    } else {
      strips.push(s);
    }
  }
  strips.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  return { strips, warnings, asOfMs };
}
