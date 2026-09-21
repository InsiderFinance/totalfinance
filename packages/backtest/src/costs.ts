/**
 * Transaction-cost, slippage, and borrow models (spec §16.1, §16.2).
 *
 * Both engines apply the same models, and each model carries a stable `label` that flows into the
 * result's implementation-risk policies (§16.3) so the assumed costs are never hidden.
 */

import {
  ErrorCode,
  InputError,
  ensureNonNegative,
  requireFiniteFields,
  signOf,
} from '@totalfinance/core';
import type { OrderSide } from '@totalfinance/core';

/** A commission model: the cash cost of a fill of `quantity` shares at `price`. */
export interface CommissionInput {
  quantity: number;
  price: number;
}

export interface CostModel {
  readonly label: string;
  commission(input: CommissionInput): number;
}

/**
 * A slippage model: the effective fill price, worsened against the trader from a reference price.
 * `quantity` is the INTENDED order size (both engines pass the real size, estimated at the reference
 * price for notional orders). A notional order is re-quantized once at the slipped price — a single
 * iteration — so a size-dependent impact model is evaluated at the intended size, not at qty = 1.
 */
export interface SlippageFillInput {
  referencePrice: number;
  side: OrderSide;
  quantity: number;
}

export interface SlippageModel {
  readonly label: string;
  fill(input: SlippageFillInput): number;
}

/** A borrow-fee model for short positions: an annualized financing rate on the short market value. */
export interface BorrowModel {
  readonly label: string;
  /** Annualized borrow rate (decimal, e.g. `0.005` = 50 bps/yr). */
  readonly annualRate: number;
}

function direction(side: OrderSide): number {
  return signOf(side);
}

/**
 * Validate one commission/slippage request. These run per FILL, so they are deliberately two field
 * checks and nothing more — cheap next to the bar loop around them, and the alternative measured
 * badly: `commission({ quantity })` with no `price` returned `NaN`, which flowed into cash, then
 * equity, then every performance statistic derived from the curve. A backtest that reports `NaN`
 * Sharpe is obvious; one where a single `NaN` fill poisons the equity series is not.
 */
/**
 * Commission and fill are DIFFERENT APIs with different fields, so each gets its own example. Sharing
 * one told a caller missing `referencePrice` to write `fees.bps(1).commission({ quantity, price })`,
 * which contains no `referencePrice` at all — an example that cannot fix the call it is attached to.
 */
/**
 * Built from the MODEL that failed, because three fee models and four slippage models share these
 * two guards. A caller who omitted `price` on `fees.fixed.commission` was told to call
 * `fees.bps(1).commission(...)` — a different model whose constructor argument means something else
 * (basis points, not dollars). The constructor argument is part of the correction, so it has to come
 * from the same place the name does.
 */
const COST_MODEL_ARGUMENTS: Record<string, string> = {
  'fees.bps': '1',
  'fees.perShare': '0.005',
  'fees.fixed': '1',
  'fees.none': '',
  'slippage.bps': '1',
  'slippage.fixed': '0.01',
  'slippage.spread': '0.02',
  'slippage.none': '',
};

/** `fees.fixed.commission` -> `fees.fixed(1).commission({ … })`. */
function costExampleCall(functionName: string, body: string): string {
  const lastDot = functionName.lastIndexOf('.');
  const model = functionName.slice(0, lastDot);
  const method = functionName.slice(lastDot + 1);
  return `${model}(${COST_MODEL_ARGUMENTS[model] ?? ''}).${method}({ ${body} })`;
}

const COMMISSION_EXAMPLE_BODY = 'quantity: 100, price: 42.15';
const FILL_EXAMPLE_BODY = "referencePrice: 42.15, side: 'buy', quantity: 100";

const COMMISSION_HINTS: Record<string, string> = {
  quantity: 'signed — negative is a sell',
  price: 'fill price per share',
};

const FILL_HINTS: Record<string, string> = {
  referencePrice: 'the pre-slippage price',
};
const requireCommission = (input: CommissionInput, name: string): void => {
  requireFiniteFields(name, input, ['quantity', 'price'], {
    exampleCall: () => costExampleCall(name, COMMISSION_EXAMPLE_BODY),
    hints: COMMISSION_HINTS,
  });
};
const requireFill = (input: SlippageFillInput, name: string): void => {
  requireFiniteFields(name, input, ['referencePrice'], {
    exampleCall: () => costExampleCall(name, FILL_EXAMPLE_BODY),
    hints: FILL_HINTS,
  });
};

/** Commission models. */
export const fees = {
  /** No commission. */
  none(): CostModel {
    return { label: 'none', commission: () => 0 };
  },
  /** Commission as basis points of traded notional (`quantity·price·bps/10000`). */
  bps(bps: number): CostModel {
    ensureNonNegative(bps, 'bps', 'fees.bps');
    return {
      label: `bps(${bps})`,
      commission: (input) => {
        requireCommission(input, 'fees.bps.commission');
        return (Math.abs(input.quantity) * input.price * bps) / 10_000;
      },
    };
  },
  /** Commission per share (`quantity·rate`). */
  perShare(amountPerShare: number): CostModel {
    ensureNonNegative(amountPerShare, 'amountPerShare', 'fees.perShare');
    return {
      label: `per-share(${amountPerShare})`,
      commission: (input) => {
        requireCommission(input, 'fees.perShare.commission');
        return Math.abs(input.quantity) * amountPerShare;
      },
    };
  },
  /** A flat commission per fill, regardless of size. */
  fixed(amount: number): CostModel {
    ensureNonNegative(amount, 'amount', 'fees.fixed');
    return {
      label: `fixed(${amount})`,
      commission: (input) => {
        requireCommission(input, 'fees.fixed.commission');
        return input.quantity === 0 ? 0 : amount;
      },
    };
  },
} as const;

/** Slippage models — all worsen the fill price *against* the order's side. */
export const slippage = {
  /** No slippage (fills at the reference price). */
  none(): SlippageModel {
    return {
      label: 'none',
      fill: (input) => {
        requireFill(input, 'slippage.none.fill');
        return input.referencePrice;
      },
    };
  },
  /** Worsen the price by `bps` basis points (relative). */
  bps(bps: number): SlippageModel {
    ensureNonNegative(bps, 'bps', 'slippage.bps');
    return {
      label: `bps(${bps})`,
      fill: (input) => {
        requireFill(input, 'slippage.bps.fill');
        return input.referencePrice * (1 + (direction(input.side) * bps) / 10_000);
      },
    };
  },
  /** Worsen the price by a fixed absolute amount per share. */
  fixed(perShare: number): SlippageModel {
    ensureNonNegative(perShare, 'perShare', 'slippage.fixed');
    return {
      label: `fixed(${perShare})`,
      fill: (input) => {
        requireFill(input, 'slippage.fixed.fill');
        return input.referencePrice + direction(input.side) * perShare;
      },
    };
  },
  /** Cross half of a relative bid-ask `spread` (e.g. `0.001` = 10 bps spread ⇒ 5 bps each way). */
  spread(spread: number): SlippageModel {
    ensureNonNegative(spread, 'spread', 'slippage.spread');
    return {
      label: `spread(${spread})`,
      fill: (input) => {
        requireFill(input, 'slippage.spread.fill');
        return input.referencePrice * (1 + (direction(input.side) * spread) / 2);
      },
    };
  },
} as const;

/** Borrow-fee models for shorts. */
export const borrow = {
  /** No borrow fee. */
  none(): BorrowModel {
    return { label: 'none', annualRate: 0 };
  },
  /** A flat annualized borrow rate charged on the short market value. */
  annualRate(annualRate: number): BorrowModel {
    if (!(annualRate >= 0 && Number.isFinite(annualRate))) {
      throw new InputError(
        `borrow.annualRate: annualRate must be a finite number ≥ 0, got ${annualRate}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { annualRate },
        },
      );
    }
    return { label: `rate(${annualRate})`, annualRate };
  },
} as const;
