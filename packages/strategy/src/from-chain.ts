/**
 * Chain → strategy bridge (spec §12, WS7.2).
 *
 * Turn a live option chain (`OptionQuote[]`) into a ready-to-analyze {@link Position}: pick strikes by
 * target delta / width, resolve premiums from a chosen price source, and attach each quote's implied
 * vol to its leg so the position marks with per-leg IVs (WS7.1).
 *
 * Dependency hygiene: this module depends on `@totalfinance/core` types only. Deltas are consumed from the
 * input rows (core `OptionQuote`, `greeks.delta`) — when a delta-based selection needs them and they
 * are absent, it throws an error naming `@totalfinance/options`' `chainGreeks` rather than reaching for
 * that package itself.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type OptionContract,
  type OptionQuote,
  type PriceSource,
  ensureKnownKeys,
  selectQuotePrice,
  wrongShapeError,
} from '@totalfinance/core';
import { Position, withProvenance } from './position.js';
import type { Leg } from './types.js';

/** An option-chain row: a quote optionally carrying its Black–Scholes delta. */

/** The v1 structures the bridge can build. */
export type FromChainType =
  | 'ironCondor'
  | 'bullCallSpread'
  | 'bearCallSpread'
  | 'bullPutSpread'
  | 'bearPutSpread'
  | 'straddle'
  | 'strangle'
  | 'coveredCall'
  | 'protectivePut'
  | 'calendar';

/** Every buildable `type`, for the invalid-enum teaching error (kept in sync with the union). */
const FROM_CHAIN_TYPES: readonly FromChainType[] = [
  'ironCondor',
  'bullCallSpread',
  'bearCallSpread',
  'bullPutSpread',
  'bearPutSpread',
  'straddle',
  'strangle',
  'coveredCall',
  'protectivePut',
  'calendar',
];

interface CommonOptions {
  /** The expiry to select from (the NEAR expiry for a calendar). */
  expiry: string;
  /** Number of contracts (default 1). */
  quantity?: number;
  /** Premium source (default `'mid'`). */
  price?: PriceSource;
  /** Contract multiplier (default 100). */
  multiplier?: number;
  /** Underlying spot; falls back to a quote's `underlyingPrice`. Needed for ATM / stock legs. */
  spot?: number;
}

export type FromChainOptions =
  | (CommonOptions & { type: 'ironCondor'; shortDelta: number; wingWidth: number })
  | (CommonOptions & {
      type: 'bullCallSpread' | 'bearCallSpread' | 'bullPutSpread' | 'bearPutSpread';
      shortDelta: number;
      width: number;
    })
  | (CommonOptions & { type: 'straddle'; strike?: number })
  | (CommonOptions & { type: 'strangle'; shortDelta: number })
  | (CommonOptions & { type: 'coveredCall'; shortDelta: number; stockPrice?: number })
  | (CommonOptions & { type: 'protectivePut'; shortDelta: number; stockPrice?: number })
  | (CommonOptions & {
      type: 'calendar';
      farExpiry: string;
      strike?: number;
      right?: 'call' | 'put';
    });

/** The {@link CommonOptions} keys shared by every `FromChainOptions` variant. */
const COMMON_OPTION_KEYS = ['type', 'expiry', 'quantity', 'price', 'multiplier', 'spot'] as const;

/**
 * EXACT per-type options fields (Law 12) — the {@link FromChainOptions} union resolved per variant, so
 * an ironCondor does not silently accept `width` nor a straddle `wingWidth`, and a typo of any
 * field gets a did-you-mean against exactly the fields that variant reads.
 */
const FROM_CHAIN_FIELDS: Record<FromChainType, readonly string[]> = {
  ironCondor: [...COMMON_OPTION_KEYS, 'shortDelta', 'wingWidth'],
  bullCallSpread: [...COMMON_OPTION_KEYS, 'shortDelta', 'width'],
  bearCallSpread: [...COMMON_OPTION_KEYS, 'shortDelta', 'width'],
  bullPutSpread: [...COMMON_OPTION_KEYS, 'shortDelta', 'width'],
  bearPutSpread: [...COMMON_OPTION_KEYS, 'shortDelta', 'width'],
  straddle: [...COMMON_OPTION_KEYS, 'strike'],
  strangle: [...COMMON_OPTION_KEYS, 'shortDelta'],
  coveredCall: [...COMMON_OPTION_KEYS, 'shortDelta', 'stockPrice'],
  protectivePut: [...COMMON_OPTION_KEYS, 'shortDelta', 'stockPrice'],
  calendar: [...COMMON_OPTION_KEYS, 'farExpiry', 'strike', 'right'],
};

/** One resolved fill: the traded contract (null for a stock leg), its premium, and its delta. */
export interface ChainFill {
  role: string;
  contract: OptionContract | null;
  premium: number;
  delta: number | null;
}

export interface FromChainResult {
  position: Position;
  legs: Leg[];
  fills: ChainFill[];
  /** C (hygiene): the conventions the selection applied — above all which quoted price became each premium. */
  assumptions: {
    conventionsVersion: string;
    /** The price source every premium was read from (`'mid'` by default; never a silent fallback). */
    priceSource: PriceSource;
    /** The selection expiry (the NEAR expiry for a calendar). */
    expiry: string;
    multiplier: number;
    quantity: number;
  };
}

const FN = 'strategyFromChain';

/**
 * Guard every chain row up front (the first-touch law). `forExpiry` dereferences `r.contract.expiry`
 * on each row, so a chain of the WRONG shape — most often the scanner's flat
 * `ScanQuoteRow` (`{ strike, call, put, callBid, … }`), which is the other chain grammar in this very
 * package — used to die with a raw `TypeError: Cannot read properties of undefined (reading
 * 'expiry')` from inside a `.filter`, naming nothing the caller could act on. The flat shape is
 * detected explicitly and answered with the API that actually takes it.
 */
function requireNestedQuoteRows(rows: readonly unknown[]): void {
  const NESTED_SHAPE =
    'rows: OptionQuote[] — each { contract: { underlying, type, strike, expiry }, bid?, ask?, mid?, delta?, impliedVolatility? }';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== null && typeof row === 'object') {
      const contract = (row as { contract?: unknown }).contract;
      if (contract !== null && typeof contract === 'object') {
        // A nested contract must still carry the fields the selection reads.
        const c = contract as { strike?: unknown; expiry?: unknown; type?: unknown };
        if (typeof c.strike === 'number' && typeof c.expiry === 'string' && c.type !== undefined) {
          continue;
        }
        throw new InputError(
          `${FN}: rows[${i}].contract is missing the fields strike/expiry/type that strike selection reads. ` +
            `Expected ${NESTED_SHAPE}.`,
          {
            code: ErrorCode.InputWrongShape,
            context: { index: i, receivedContractKeys: Object.keys(contract) },
          },
        );
      }
      // The scanner's FLAT row grammar — a different API's input, not a malformed one.
      const flat = row as { strike?: unknown; call?: unknown; put?: unknown };
      if (
        typeof flat.strike === 'number' &&
        (typeof flat.call === 'number' ||
          typeof flat.put === 'number' ||
          'callBid' in flat ||
          'putBid' in flat)
      ) {
        throw new InputError(
          `${FN}: rows[${i}] is a FLAT per-strike row ({ strike, call?, put?, callBid?, … }) — that is ` +
            `scanStrategies' ScanQuoteRow grammar, not a chain quote. strategyFromChain selects ` +
            `individual contracts, so it needs one row PER CONTRACT: ${NESTED_SHAPE}. ` +
            `To enumerate structures over a per-strike grid instead, call scanStrategies({ chain, … }).`,
          {
            code: ErrorCode.InputWrongShape,
            context: { index: i, received: row, expectedApi: 'scanStrategies' },
          },
        );
      }
    }
    throw wrongShapeError(FN, NESTED_SHAPE, row);
  }
}

function forExpiry(rows: OptionQuote[], expiry: string, right: 'call' | 'put'): OptionQuote[] {
  return rows
    .filter((r) => r.contract.expiry === expiry && r.contract.type === right)
    .sort((a, b) => a.contract.strike - b.contract.strike);
}

function resolveSpot(rows: OptionQuote[], options: CommonOptions): number | undefined {
  if (options.spot !== undefined) return options.spot;
  return rows.find((r) => typeof r.underlyingPrice === 'number')?.underlyingPrice;
}

function premiumOf(quote: OptionQuote, source: PriceSource): number {
  const p = selectQuotePrice(quote, source);
  if (p === undefined || !Number.isFinite(p)) {
    throw new InputError(
      `${FN}: no ${source} premium for ${quote.contract.type} ${quote.contract.strike} @ ${quote.contract.expiry}.`,
      {
        code: ErrorCode.StrategyStrikeUnavailable,
        context: { strike: quote.contract.strike, type: quote.contract.type, source },
      },
    );
  }
  return p;
}

/** Nearest quote by |delta| to `target`, requiring deltas on every candidate (else point at greeks()). */
function nearestByAbsDelta(rows: OptionQuote[], target: number): OptionQuote {
  if (rows.length === 0) {
    throw new InputError(`${FN}: no quotes to select from for a delta-targeted leg.`, {
      code: ErrorCode.StrategyStrikeUnavailable,
      context: { target },
    });
  }
  for (const r of rows) {
    if (typeof r.greeks?.delta !== 'number' || !Number.isFinite(r.greeks.delta)) {
      throw new InputError(
        `${FN}: delta-based strike selection needs greeks.delta on every ${r.contract.type} quote; ` +
          `${r.contract.type} ${r.contract.strike} @ ${r.contract.expiry} has none. Compute them first ` +
          `with @totalfinance/options chainGreeks({ quotes, market }) and pass its rows.`,
        {
          code: ErrorCode.StrategyDeltaRequired,
          context: { strike: r.contract.strike, type: r.contract.type },
        },
      );
    }
  }
  let best = rows[0]!;
  let bestD = Math.abs(Math.abs(best.greeks!.delta) - target);
  for (const r of rows) {
    const d = Math.abs(Math.abs(r.greeks!.delta) - target);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Nearest quote by strike to `target` among `rows` (already the correct-side candidates). */
function nearestByStrike(rows: OptionQuote[], target: number, label: string): OptionQuote {
  if (rows.length === 0) {
    throw new InputError(`${FN}: no ${label} strike available near ${target}.`, {
      code: ErrorCode.StrategyStrikeUnavailable,
      context: { target, label },
    });
  }
  let best = rows[0]!;
  let bestD = Math.abs(best.contract.strike - target);
  for (const r of rows) {
    const d = Math.abs(r.contract.strike - target);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function atStrike(rows: OptionQuote[], strike: number, label: string): OptionQuote {
  const hit = rows.find((r) => r.contract.strike === strike);
  if (!hit) {
    throw new InputError(`${FN}: no ${label} quote at strike ${strike}.`, {
      code: ErrorCode.StrategyStrikeUnavailable,
      context: { strike, label },
    });
  }
  return hit;
}

/** Build a signed option leg + fill from a quote, attaching its implied vol and (optional) expiry. */
function optionLeg(
  quote: OptionQuote,
  sign: 1 | -1,
  quantity: number,
  source: PriceSource,
  role: string,
  expiry?: string,
): { leg: Leg; fill: ChainFill } {
  const premium = premiumOf(quote, source);
  const leg: Leg = {
    kind: quote.contract.type,
    strike: quote.contract.strike,
    premium,
    quantity: sign * quantity,
    ...(typeof quote.impliedVolatility === 'number' && quote.impliedVolatility > 0
      ? { impliedVolatility: quote.impliedVolatility }
      : {}),
    ...(expiry !== undefined ? { expiry } : {}),
  };
  return {
    leg,
    fill: { role, contract: quote.contract, premium, delta: quote.greeks?.delta ?? null },
  };
}

function requireSpot(rows: OptionQuote[], options: CommonOptions, why: string): number {
  const spot = resolveSpot(rows, options);
  if (spot === undefined) {
    throw new InputError(
      `${FN}: ${why} needs a spot; pass \`spot\` or provide a quote underlyingPrice.`,
      {
        code: ErrorCode.InputMissingField,
        context: { field: 'spot' },
      },
    );
  }
  // `spot > 0` alone admits Infinity (Infinity > 0 is true); require a FINITE positive spot.
  if (!(spot > 0) || !Number.isFinite(spot)) {
    throw new InputError(`${FN}: spot must be a finite positive number, got ${spot}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'spot', spot },
    });
  }
  return spot;
}

/**
 * Build a {@link Position} from an option chain. Returns the position, its resolved legs (premiums and
 * per-leg IVs attached), and the fills (contract / premium / delta per leg). Missing quotes throw
 * `strategy.strike_unavailable`; delta-targeted selection without deltas throws `strategy.delta_required`.
 */
export function strategyFromChain(rows: OptionQuote[], options: FromChainOptions): FromChainResult {
  // Boundary shape guards FIRST (dx §1.3): a missing options object or a non-array chain must teach
  // the call shape, never crash on a property access below.
  if (!Array.isArray(rows)) {
    throw wrongShapeError(FN, 'strategyFromChain(rows: OptionQuote[], options)', rows);
  }
  requireNestedQuoteRows(rows);
  if (options === null || typeof options !== 'object') {
    throw wrongShapeError(
      FN,
      `options: { type: '${FROM_CHAIN_TYPES.join("' | '")}', expiry, quantity?, price?, multiplier?, spot?, ` +
        'plus per-type fields — ironCondor: { shortDelta, wingWidth }; vertical spreads: ' +
        '{ shortDelta, width }; straddle: { strike? }; strangle: { shortDelta }; ' +
        'coveredCall/protectivePut: { shortDelta, stockPrice? }; calendar: { farExpiry, strike?, right? } }',
      options,
    );
  }
  // Law 12: a KNOWN type's options reject unknown keys against exactly that variant's fields; an
  // unknown `type` falls through to the invalid-enum teaching error in the switch default below.
  const variantFields = (FROM_CHAIN_FIELDS as Record<string, readonly string[] | undefined>)[
    options.type
  ];
  if (variantFields !== undefined) ensureKnownKeys(FN, 'options', options, variantFields);
  for (const numField of ['multiplier', 'quantity'] as const) {
    const numValue = (options as unknown as Record<string, unknown>)[numField];
    if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
      throw new InputError(
        `strategyFromChain: ${numField} must be a finite number when provided. Received ${numValue === null ? 'null' : typeof numValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: numField } },
      );
    }
  }
  /**
   * `expiry` selects the rows every variant works from, so a missing or non-string one produces an
   * EMPTY set and the failure surfaces far downstream as "no quotes to select from for a
   * delta-targeted leg" — a refusal that never names the field the caller got wrong. Every variant
   * declares `expiry` required; say so here, where it can still be said usefully.
   */
  if (typeof options.expiry !== 'string' || options.expiry.length === 0) {
    throw new InputError(
      `${FN}: expiry is required and must be an ISO date string (e.g. '2026-04-17'), got ` +
        `${JSON.stringify(options.expiry)}.`,
      { code: ErrorCode.InputMissingField, context: { field: 'expiry', expiry: options.expiry } },
    );
  }
  /**
   * A DECLARED numeric field is validated when SUPPLIED, whether or not this variant consumes it.
   * `resolveSpot` returns `options.spot` unchecked and the finite guard downstream only runs on the
   * paths that need a spot — so `ironCondor` accepted `spot: NaN` and returned four legs, while
   * `quantity: NaN` was correctly refused. A field the contract declares is a field the contract
   * enforces; "this variant happens not to read it" is not a reason to accept a non-number.
   */
  /**
   * EVERY DECLARED NUMERIC FIELD, validated when supplied — not only the ones this variant consumes.
   *
   * `resolveSpot` returned `options.spot` unchecked and the finite guard downstream only ran on paths
   * that need a spot, so `ironCondor` accepted `spot: NaN` and returned four legs while
   * `quantity: NaN` was correctly refused. The same held for `shortDelta`, `wingWidth`, `width`,
   * `strike` and `stockPrice`. A field the contract declares is a field the contract enforces;
   * "this variant happens not to read it" is not a reason to accept a non-number.
   *
   * `strike` and `stockPrice` are prices and `shortDelta` a probability-like target, so all of them
   * must be finite and positive; there is no meaningful negative or infinite value for any.
   */
  for (const field of [
    'spot',
    'shortDelta',
    'wingWidth',
    'width',
    'strike',
    'stockPrice',
  ] as const) {
    const value = (options as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new InputError(
        `${FN}: ${field} must be a finite positive number, got ${String(value)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field, [field]: value } },
      );
    }
  }
  /** `farExpiry` is a date, and the calendar variant selects its far leg from it. Same rule as `expiry`. */
  if (
    options.type === 'calendar' &&
    options.farExpiry !== undefined &&
    (typeof options.farExpiry !== 'string' || options.farExpiry.length === 0)
  ) {
    throw new InputError(
      `${FN}: farExpiry must be an ISO date string (e.g. '2026-06-19'), got ` +
        `${JSON.stringify(options.farExpiry)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { field: 'farExpiry', farExpiry: options.farExpiry },
      },
    );
  }
  /** `right` selects which side the calendar is built from: a closed set of two, not a number. */
  if (
    options.type === 'calendar' &&
    options.right !== undefined &&
    options.right !== 'call' &&
    options.right !== 'put'
  ) {
    throw new InputError(
      `${FN}: right must be 'call' or 'put', got ${JSON.stringify(options.right)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'right', right: options.right } },
    );
  }
  /**
   * `price` names the PREMIUM SOURCE, not an amount. Passing a number reached `selectQuotePrice` and
   * came back complaining about `source` — a field the caller never wrote — so the message pointed at
   * the wrong name. Refuse it here, where the caller's own spelling is still in hand.
   */
  if (options.price !== undefined && typeof options.price !== 'string') {
    throw new InputError(
      `${FN}: price selects the premium source and must be one of 'bid', 'ask', 'mid', 'last', ` +
        `'mark'; got ${JSON.stringify(options.price)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'price', price: options.price } },
    );
  }
  /**
   * A field this variant REQUIRES, named here rather than surfacing as an empty selection later.
   *
   * Omitting `shortDelta` produced "no quotes to select from for a delta-targeted leg", which never
   * says which field was missing. The table below mirrors the DECLARED type exactly — `stockPrice`,
   * `strike` and `right` are optional and must stay optional. Deriving "required" from
   * `FROM_CHAIN_FIELDS` instead broke `coveredCall`, which legitimately omits `stockPrice` and takes
   * the spot; a list of the fields a variant ACCEPTS is not a list of the fields it DEMANDS.
   */
  const REQUIRED_BY_VARIANT: Record<string, readonly string[]> = {
    ironCondor: ['shortDelta', 'wingWidth'],
    bullCallSpread: ['shortDelta', 'width'],
    bearCallSpread: ['shortDelta', 'width'],
    bullPutSpread: ['shortDelta', 'width'],
    bearPutSpread: ['shortDelta', 'width'],
    strangle: ['shortDelta'],
    coveredCall: ['shortDelta'],
    protectivePut: ['shortDelta'],
    calendar: ['farExpiry'],
  };
  for (const field of REQUIRED_BY_VARIANT[options.type] ?? []) {
    if ((options as unknown as Record<string, unknown>)[field] === undefined) {
      throw new InputError(
        `${FN}: ${options.type} requires ${field}. e.g. strategyFromChain(rows, { type: '${options.type}', expiry: '2026-04-17', ${field}: … }).`,
        { code: ErrorCode.InputMissingField, context: { field, type: options.type } },
      );
    }
  }
  const source: PriceSource = options.price ?? 'mid';
  const qty = options.quantity ?? 1;
  // Safe integer (2026-08-23 review, P0): quantity multiplies into every leg's size and premium — no
  // loop runs off it, but above 2^53 the "integer" contract count is no longer exact, so sized
  // premiums and share counts would silently round.
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new InputError(`${FN}: quantity must be a positive integer, got ${qty}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { quantity: qty },
    });
  }
  const multiplier = options.multiplier ?? 100;
  const shares = multiplier * qty;

  const legList: Leg[] = [];
  const fills: ChainFill[] = [];
  const add = (built: { leg: Leg; fill: ChainFill }): void => {
    legList.push(built.leg);
    fills.push(built.fill);
  };

  switch (options.type) {
    case 'ironCondor': {
      const puts = forExpiry(rows, options.expiry, 'put');
      const calls = forExpiry(rows, options.expiry, 'call');
      const shortPut = nearestByAbsDelta(puts, options.shortDelta);
      const shortCall = nearestByAbsDelta(calls, options.shortDelta);
      const longPut = nearestByStrike(
        puts.filter((r) => r.contract.strike < shortPut.contract.strike),
        shortPut.contract.strike - options.wingWidth,
        'long put wing',
      );
      const longCall = nearestByStrike(
        calls.filter((r) => r.contract.strike > shortCall.contract.strike),
        shortCall.contract.strike + options.wingWidth,
        'long call wing',
      );
      add(optionLeg(longPut, 1, qty, source, 'longPut'));
      add(optionLeg(shortPut, -1, qty, source, 'shortPut'));
      add(optionLeg(shortCall, -1, qty, source, 'shortCall'));
      add(optionLeg(longCall, 1, qty, source, 'longCall'));
      break;
    }
    case 'bullCallSpread':
    case 'bearCallSpread':
    case 'bullPutSpread':
    case 'bearPutSpread': {
      const right: 'call' | 'put' = options.type.endsWith('CallSpread') ? 'call' : 'put';
      const chain = forExpiry(rows, options.expiry, right);
      const short = nearestByAbsDelta(chain, options.shortDelta);
      // The long leg sits `width` away from the short, on the debit/credit side that defines the spread.
      const longBelow = options.type === 'bullCallSpread' || options.type === 'bullPutSpread';
      const target = short.contract.strike + (longBelow ? -options.width : options.width);
      const candidates = chain.filter((r) =>
        longBelow
          ? r.contract.strike < short.contract.strike
          : r.contract.strike > short.contract.strike,
      );
      const long = nearestByStrike(candidates, target, 'long leg');
      // Emit long then short (matches the named builders' leg order for the debit spreads; order does
      // not change the position, only the leg listing).
      add(optionLeg(long, 1, qty, source, 'long'));
      add(optionLeg(short, -1, qty, source, 'short'));
      break;
    }
    case 'straddle': {
      const spot = options.strike ?? requireSpot(rows, options, 'an ATM straddle');
      const calls = forExpiry(rows, options.expiry, 'call');
      const puts = forExpiry(rows, options.expiry, 'put');
      const strike = options.strike ?? nearestByStrike(calls, spot, 'ATM call').contract.strike;
      add(optionLeg(atStrike(calls, strike, 'call'), 1, qty, source, 'longCall'));
      add(optionLeg(atStrike(puts, strike, 'put'), 1, qty, source, 'longPut'));
      break;
    }
    case 'strangle': {
      const calls = forExpiry(rows, options.expiry, 'call');
      const puts = forExpiry(rows, options.expiry, 'put');
      add(optionLeg(nearestByAbsDelta(calls, options.shortDelta), 1, qty, source, 'longCall'));
      add(optionLeg(nearestByAbsDelta(puts, options.shortDelta), 1, qty, source, 'longPut'));
      break;
    }
    case 'coveredCall': {
      const stockPrice = options.stockPrice ?? requireSpot(rows, options, 'a covered call');
      const calls = forExpiry(rows, options.expiry, 'call');
      const short = nearestByAbsDelta(calls, options.shortDelta);
      legList.push({ kind: 'stock', price: stockPrice, quantity: shares });
      fills.push({ role: 'stock', contract: null, premium: stockPrice, delta: 1 });
      add(optionLeg(short, -1, qty, source, 'shortCall'));
      break;
    }
    case 'protectivePut': {
      const stockPrice = options.stockPrice ?? requireSpot(rows, options, 'a protective put');
      const puts = forExpiry(rows, options.expiry, 'put');
      const long = nearestByAbsDelta(puts, options.shortDelta);
      legList.push({ kind: 'stock', price: stockPrice, quantity: shares });
      fills.push({ role: 'stock', contract: null, premium: stockPrice, delta: 1 });
      add(optionLeg(long, 1, qty, source, 'longPut'));
      break;
    }
    case 'calendar': {
      const right = options.right ?? 'call';
      const near = forExpiry(rows, options.expiry, right);
      const far = forExpiry(rows, options.farExpiry, right);
      const strike =
        options.strike ??
        nearestByStrike(near, requireSpot(rows, options, 'an ATM calendar'), `ATM ${right}`)
          .contract.strike;
      // Calendar: short the near expiry, long the far expiry (each priced at its own time-to-expiry).
      add(
        optionLeg(
          atStrike(near, strike, `near ${right}`),
          -1,
          qty,
          source,
          'shortNear',
          options.expiry,
        ),
      );
      add(
        optionLeg(
          atStrike(far, strike, `far ${right}`),
          1,
          qty,
          source,
          'longFar',
          options.farExpiry,
        ),
      );
      break;
    }
    default: {
      // Runtime callers aren't bound by the FromChainOptions union — an unknown `type` must teach
      // the valid set, never fall through to a 0-leg position with all-zero metrics.
      const received = (options as { type?: unknown }).type;
      throw new InputError(
        `${FN}: unknown type ${JSON.stringify(received)} — expected one of ${FROM_CHAIN_TYPES.join(', ')}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { type: received, known: [...FROM_CHAIN_TYPES] },
        },
      );
    }
  }

  // The position remembers its expiry (R4): the selection expiry is the position-level default, so
  // probability()/value() need no re-telling (the calendar's legs already carry their own per-side
  // expiries, which take precedence). `constructedAs` stamps the requested type as provenance,
  // exactly like the named builders (dx §4.5).
  const position = new Position(
    legList,
    withProvenance(options.type, { multiplier, expiry: options.expiry }),
  );
  return {
    position,
    legs: legList,
    fills,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      priceSource: options.price ?? 'mid',
      expiry: options.expiry,
      multiplier,
      quantity: qty,
    },
  };
}
