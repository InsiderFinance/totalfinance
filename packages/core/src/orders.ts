/**
 * One order vocabulary (pre-publish interface repairs, B6).
 *
 * Every package that names an order — the portfolio trade lifecycle, the backtest simulators and
 * the paper broker, the agent wire — spells side, type and time-in-force with THESE names. An
 * order carries a side and a positive quantity; held exposure is signed; `sideOf` / `signOf` are
 * the one bridge between the two, so no engine hand-rolls `quantity > 0 ? 'buy' : 'sell'` again.
 *
 * Identity rule, written down: market data is keyed by `symbol` (a bar, a quote, a chain row);
 * ledger and trade objects are keyed by `instrumentId` (a fill, an order, a position). A symbol
 * is what a venue quotes; an instrument id is what a book holds — the two coincide for a share
 * and differ for a derivative, so neither name is reused for the other.
 */

import { ErrorCode, InputError } from './errors.js';

export type OrderSide = 'buy' | 'sell';

/** Kebab-case everywhere; a simulator that supports a subset says so at its door. */
export type OrderType =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stop-limit'
  | 'market-on-open'
  | 'market-on-close';

export type TimeInForce = 'day' | 'gtc';

export const ORDER_SIDES: readonly OrderSide[] = Object.freeze(['buy', 'sell']);
export const ORDER_TYPES: readonly OrderType[] = Object.freeze([
  'market',
  'limit',
  'stop',
  'stop-limit',
  'market-on-open',
  'market-on-close',
]);
export const TIME_IN_FORCE_VALUES: readonly TimeInForce[] = Object.freeze(['day', 'gtc']);

/**
 * The side of a signed quantity: positive buys, negative sells. Zero and non-finite values have
 * no side and are refused — a caller that reaches here with `0` has a sizing bug, not an order.
 */
export function sideOf(signed: number, functionName = 'sideOf'): OrderSide {
  if (typeof signed !== 'number' || !Number.isFinite(signed) || signed === 0) {
    throw new InputError(
      `${functionName}: a side needs a non-zero finite signed quantity (positive buys, negative sells). Received ${
        typeof signed === 'number' ? String(signed) : typeof signed
      }.`,
      {
        code: signed === 0 ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
        context: { function: functionName, field: 'signed', value: signed },
      },
    );
  }
  return signed > 0 ? 'buy' : 'sell';
}

/** The sign of a side: `+1` for a buy, `-1` for a sell. Any other value is refused. */
export function signOf(side: OrderSide, functionName = 'signOf'): 1 | -1 {
  if (side === 'buy') return 1;
  if (side === 'sell') return -1;
  throw new InputError(
    `${functionName}: side must be 'buy' | 'sell'. Received ${JSON.stringify(side)}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { function: functionName, field: 'side', value: side },
    },
  );
}
