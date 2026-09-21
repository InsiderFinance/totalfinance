/** Instrument-first leg constructors. Direction is the sign of the required position quantity. */
import {
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ensurePositive,
  requireFiniteFields,
  ErrorCode,
  InputError,
  isQuantError,
  optionExpiryToMs,
  requireArgumentObject,
} from '@totalfinance/core';
import type { LegInput, StockLeg } from './types.js';

/** The option variant of a leg input — what `legs.call` / `legs.put` build. */
type OptionLegRow = Extract<LegInput, { kind: 'call' | 'put' }>;

export interface OptionLegInput {
  /** Positive strike price per share. */
  strike: number;
  /** Signed contracts: positive = long, negative = short. Required, finite and nonzero. */
  quantity: number;
  /**
   * Entry premium per share. Omit it (or pass `undefined`) and supply `{ premiums: 'model', market }`
   * on the position config to have it priced from the market. Accepts `undefined` explicitly so
   * builders can forward an optional slot premium without a conditional spread.
   */
  premium?: number | undefined;
  /** Per-leg expiry: a YYYY-MM-DD label (16:00 ET) or zoned ISO datetime. */
  expiry?: string;
  /** Positive per-leg implied volatility, as an annualized decimal (0.20 = 20%). */
  impliedVolatility?: number;
}

export interface StockLegInput {
  /** Entry price per share. */
  price: number;
  /** Signed shares: positive = long, negative = short. Not scaled by the option multiplier. */
  quantity: number;
}

/** Finiteness and requiredness are checked before this guard. Fractional exposure is analytical. */
function nonzeroQuantity(quantity: number, functionName: string): void {
  if (quantity === 0) {
    throw new InputError(
      `${functionName}: quantity must be non-zero; positive is long and negative is short. Remove an inactive leg instead.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'quantity', quantity },
      },
    );
  }
}

function optionLeg(kind: 'call' | 'put', input: OptionLegInput): OptionLegRow {
  const name = `legs.${kind}`;
  requireArgumentObject(name, 'input', input);
  ensureKnownKeys(name, 'input', input, [
    'strike',
    'quantity',
    'premium',
    'expiry',
    'impliedVolatility',
  ]);
  requireFiniteFields(name, input, ['strike', 'quantity'], {
    exampleCall: `${name}({ strike: 105, premium: 2.5, quantity: -1 })`,
  });
  ensurePositive(input.strike, 'strike', name, ErrorCode.InputNegativeStrike);
  nonzeroQuantity(input.quantity, name);
  ensureFiniteWhenPresent(input.premium, 'premium', name);
  ensureFiniteWhenPresent(input.impliedVolatility, 'impliedVolatility', name);
  if (input.impliedVolatility !== undefined)
    ensurePositive(
      input.impliedVolatility,
      'impliedVolatility',
      name,
      ErrorCode.InputNegativeVolatility,
    );
  if (input.expiry !== undefined) {
    if (typeof input.expiry !== 'string' || input.expiry.length === 0) {
      throw new InputError(
        `${name}: expiry must be a YYYY-MM-DD date or zoned ISO datetime when provided.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: name, field: 'expiry', received: input.expiry },
        },
      );
    }
    try {
      optionExpiryToMs(input.expiry);
    } catch (cause) {
      throw new InputError(
        `${name}: expiry must be a real YYYY-MM-DD date or zoned ISO datetime.`,
        {
          code: isQuantError(cause) ? cause.code : ErrorCode.InputOutOfRange,
          context: { function: name, field: 'expiry', received: input.expiry },
          cause,
        },
      );
    }
  }
  return {
    kind,
    strike: input.strike,
    quantity: input.quantity,
    ...(input.premium !== undefined ? { premium: input.premium } : {}),
    ...(input.expiry !== undefined ? { expiry: input.expiry } : {}),
    ...(input.impliedVolatility !== undefined
      ? { impliedVolatility: input.impliedVolatility }
      : {}),
  };
}

/** Plain leg records for custom strategies. No direction or size is inferred. */
export const legs = {
  /**
   * Build a call leg. Signed quantity is in contracts; premium is per share.
   * @example legs.call({ strike: 100, premium: 6, quantity: 2 })
   */
  call: (input: OptionLegInput): OptionLegRow => optionLeg('call', input),
  /**
   * Build a put leg. Signed quantity is in contracts; premium is per share.
   * @example legs.put({ strike: 90, premium: 3, quantity: -1 })
   */
  put: (input: OptionLegInput): OptionLegRow => optionLeg('put', input),
  /**
   * Build a stock leg. Signed quantity is in shares; price is the entry price per share.
   * @example legs.stock({ price: 100, quantity: -50 })
   */
  stock: (input: StockLegInput): StockLeg => {
    const name = 'legs.stock';
    requireArgumentObject(name, 'input', input);
    ensureKnownKeys(name, 'input', input, ['price', 'quantity']);
    requireFiniteFields(name, input, ['price', 'quantity'], {
      exampleCall: 'legs.stock({ price: 100, quantity: 100 })',
    });
    nonzeroQuantity(input.quantity, name);
    return { kind: 'stock', price: input.price, quantity: input.quantity };
  },
} as const;
