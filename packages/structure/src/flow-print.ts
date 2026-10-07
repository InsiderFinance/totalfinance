/**
 * The per-print half of options flow: validate a print, price its premium, classify its side.
 *
 * Package-internal. `flow()` and `optionFlowDrift()` both run every print through `classifyPrint`,
 * so they cannot disagree about one. It lives in its own module, which is not a package entrypoint,
 * so nothing here becomes public API through the `structure/flow` subpath.
 */

import {
  ErrorCode,
  InputError,
  type OptionTrade,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureNonNegative,
  ensurePositive,
  requireFiniteFields,
  wrongShapeError,
} from '@totalfinance/core';
import type {
  AggressorSide,
  FlowClassificationProvenance,
  FlowClassificationSource,
} from './flow.js';

/**
 * Reject a malformed trade print before it produces nonsensical premium/volume. Flow ingests vendor
 * data, so a `NaN` price or a negative size must fail loudly rather than flow into block/sweep stats.
 * Shape first (review finding): a null/primitive element or a missing `contract` teaches the
 * expected print shape with its index — it must never escape as a raw TypeError.
 */
function validateTradePrint(t: OptionTrade, i: number): void {
  const where = `flow: trades[${i}]`;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    throw wrongShapeError(
      'flow',
      `trades[${i}] to be a trade print { contract: { underlying, expiry, strike, type }, price, size, timestampMs }`,
      t,
    );
  }
  if (t.contract === null || typeof t.contract !== 'object' || Array.isArray(t.contract)) {
    throw wrongShapeError(
      'flow',
      `trades[${i}].contract to be { underlying, expiry, strike, type }`,
      t,
    );
  }
  requireFiniteFields('flow', t, ['price', 'size', 'timestampMs'], {
    path: `trades[${i}]`,
    exampleCall:
      "flow([{ contract: { underlying: 'SPY', type: 'call', style: 'american', strike: 600, expiry: '2026-06-19', expiresAt: 1781899200000, expiryConvention: 'us-equity-close' }, timestampMs: 1780579800000, price: 2, size: 10 }])",
  });
  requireFiniteFields('flow', t.contract, ['strike'], {
    path: `trades[${i}].contract`,
    exampleCall:
      "flow([{ contract: { underlying: 'SPY', type: 'call', style: 'american', strike: 600, expiry: '2026-06-19', expiresAt: 1781899200000, expiryConvention: 'us-equity-close' }, timestampMs: 1780579800000, price: 2, size: 10 }])",
  });
  ensurePositive(t.price, 'price', where);
  ensurePositive(t.size, 'size', where);
  ensureFinite(t.timestampMs, 'timestampMs', where);
  if (!Number.isSafeInteger(t.timestampMs) || Math.abs(t.timestampMs) > 8.64e15) {
    throw new InputError(
      `${where}: timestampMs must be representable integer epoch milliseconds.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'timestampMs', index: i },
      },
    );
  }
  if (typeof t.contract.underlying !== 'string' || t.contract.underlying.trim() === '') {
    throw new InputError(`${where}: contract.underlying must be a non-empty symbol string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'contract.underlying', index: i },
    });
  }
  if (typeof t.contract.expiry !== 'string') {
    throw new InputError(`${where}: contract.expiry must be an ISO date or zoned datetime.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'contract.expiry', index: i },
    });
  }
  if (t.contract.type !== 'call' && t.contract.type !== 'put') {
    throw new InputError(`${where}: contract.type must be 'call' or 'put'.`, {
      code: ErrorCode.InputInvalidEnum,
      context: { field: 'contract.type', index: i },
    });
  }
  if (t.aggressorSide !== undefined && !['buy', 'sell', 'unknown'].includes(t.aggressorSide)) {
    throw new InputError(
      `${where}: aggressorSide must be 'buy', 'sell', or 'unknown'; omit it for absent classification.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { field: 'aggressorSide', index: i },
      },
    );
  }
  for (const field of ['bid', 'ask'] as const) {
    ensureFiniteWhenPresent(t[field], field, where);
    if (t[field] !== undefined) ensureNonNegative(t[field], field, where);
  }
  ensurePositive(t.contract.strike, 'contract.strike', where);
  ensureFiniteWhenPresent(t.contract.multiplier, 'contract.multiplier', where);
  if (t.contract.multiplier !== undefined) {
    ensurePositive(t.contract.multiplier, 'contract.multiplier', where);
  }
  ensureFiniteWhenPresent(t.premium, 'premium', where);
  if (t.premium !== undefined) ensureNonNegative(t.premium, 'premium', where);
  // Open interest is a non-negative count; a negative value would corrupt the open/close estimate.
  ensureFiniteWhenPresent(t.openInterest, 'openInterest', where);
  if (t.openInterest !== undefined) ensureNonNegative(t.openInterest, 'openInterest', where);
}
/**
 * The NBBO **quote rule** (not Lee–Ready): at/above the ask is a buy, at/below the bid a sell, and
 * strictly inside the spread the print is compared to the midpoint. A print exactly AT the midpoint
 * is `unknown` — Lee–Ready would break that tie with a tick test against the previous trade, which
 * needs a trade sequence this function does not have. The source policy determines whether a
 * caller-supplied `aggressorSide` wins or the quote rule runs.
 */
function classifySide(
  trade: OptionTrade,
  policy: FlowClassificationSource,
): { side: AggressorSide; classificationProvenance: FlowClassificationProvenance } {
  const providedSide = trade.aggressorSide ?? null;
  const result = (
    side: AggressorSide,
    source: FlowClassificationProvenance['source'],
    reason: FlowClassificationProvenance['reason'],
  ): ReturnType<typeof classifySide> => ({
    side,
    classificationProvenance: Object.freeze({ policy, source, providedSide, reason }),
  });
  if (
    policy !== 'quotes-only' &&
    providedSide !== null &&
    (policy !== 'provided-or-quotes' || providedSide !== 'unknown')
  ) {
    return result(providedSide, 'provided', 'provided');
  }
  if (policy === 'provided-only') return result('unknown', 'unavailable', 'provided-missing');
  const { bid, ask, price } = trade;
  if (bid === undefined || ask === undefined)
    return result('unknown', 'unavailable', 'quotes-missing');
  // A locked (bid == ask) or crossed (bid > ask) market carries no directional NBBO signal — a print
  // AT a locked price is not a buy just because price >= ask (WS2.12).
  if (bid >= ask) return result('unknown', 'quotes', 'quotes-locked-or-crossed');
  if (price >= ask) return result('buy', 'quotes', 'quote-rule');
  if (price <= bid) return result('sell', 'quotes', 'quote-rule');
  const mid = bid + (ask - bid) / 2;
  if (price > mid) return result('buy', 'quotes', 'quote-rule');
  if (price < mid) return result('sell', 'quotes', 'quote-rule');
  return result('unknown', 'quotes', 'quote-midpoint');
}

/** The four classification policies, refused with one message wherever a caller can choose one. */
export function requireClassificationSource(
  value: unknown,
): asserts value is FlowClassificationSource {
  if (
    typeof value !== 'string' ||
    !['provided-or-quotes', 'provided-first', 'provided-only', 'quotes-only'].includes(value)
  ) {
    throw new InputError(
      'flow: classificationSource must be provided-or-quotes, provided-first, provided-only, or quotes-only.',
      {
        code: ErrorCode.InputInvalidEnum,
        context: { field: 'classificationSource' },
      },
    );
  }
}

/**
 * The work `flow()` does for every print before any analytics — validate it, price its premium,
 * classify its side — in that order and with those errors. Shared with `optionFlowDrift()`, which
 * needs exactly this and none of the block, 0DTE, open/close, sweep or spread analytics, so the two
 * can never disagree about a print.
 */
export function classifyPrint(
  t: OptionTrade,
  i: number,
  multiplier: number,
  policy: FlowClassificationSource,
): {
  premium: number;
  side: AggressorSide;
  classificationProvenance: FlowClassificationProvenance;
} {
  validateTradePrint(t, i);
  const m = t.contract.multiplier ?? multiplier;
  const premium = t.premium ?? t.price * t.size * m;
  ensureFinite(premium, 'computed premium', `flow: trades[${i}]`);
  const { side, classificationProvenance } = classifySide(t, policy);
  return { premium, side, classificationProvenance };
}
