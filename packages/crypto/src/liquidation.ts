/**
 * Isolated-margin **liquidation & bankruptcy prices** for leveraged perpetual/futures positions —
 * coin-margined (inverse) and USDT-margined (linear) — the most-watched number for a leveraged crypto
 * trader (spec: `docs/specs/perp-liquidation.md`). Depends only on `@insiderfinance/totalfinance/core`.
 *
 * Convention (disclosed in `assumptions`): **isolated** margin; the maintenance margin is assessed on the
 * position value **at the mark** (the economically exact mark-to-market definition — liquidation is where
 * account equity first equals the maintenance margin). This differs slightly from the entry-notional
 * closed forms some venues publish (e.g. BitMEX's `entry/(1+IMR−MMR)`), which assess maintenance on the
 * ENTRY notional — a few basis points apart. In terms of the initial-margin rate `IMR = 1/leverage` and
 * the maintenance-margin rate `MMR = m`, the mark-based liquidation prices are:
 *
 * ```
 *   inverse (coin-margined)         linear (USDT-margined)
 *   long : F₀·(1+m)/(1+IMR)         long : F₀·(1−IMR)/(1−m)
 *   short: F₀·(1−m)/(1−IMR)         short: F₀·(1+IMR)/(1+m)
 * ```
 *
 * The **bankruptcy price** (equity = 0, all posted margin gone) is the same formula with `m = 0`; it is
 * always beyond the liquidation price by the maintenance buffer. Both are independent of position size —
 * they depend only on the entry price, the leverage, the side, and the margin mode.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  ErrorCode,
  finalizeResult,
  InputError,
  requireArgumentObject,
  type Computed,
} from '@totalfinance/core';
import type { InverseSide } from './inverse.js';

const MARGIN_MODES = ['inverse', 'linear'] as const;
/** Margin mode: `inverse` = coin-margined (Deribit/BitMEX), `linear` = USDT-margined. */
export type MarginMode = (typeof MARGIN_MODES)[number];

const SIDES = ['long', 'short'] as const;

/** Input for {@link liquidationPrice}. */
export interface LiquidationInput {
  /** Margin mode: coin-margined (`inverse`) or USDT-margined (`linear`). */
  margin: MarginMode;
  /** Entry (average) price, USD per coin. */
  entryPrice: number;
  /** Position leverage (`> 1`); the initial-margin rate is `1/leverage`. */
  leverage: number;
  /** Maintenance-margin rate `m` (fraction, e.g. `0.005` = 0.5%). `0 ≤ m < 1`. */
  maintenanceMarginRate: number;
  /** Position side. Default `'long'`. */
  side?: InverseSide;
}

/** The convention fields {@link liquidationPrice} echoes in `assumptions` (Law 2). */
export interface LiquidationAssumptions extends Record<string, unknown> {
  margin: MarginMode;
  side: InverseSide;
  maintenanceMarginRate: number;
  marginBasis: string;
}

/** Isolated-margin liquidation economics of a leveraged perp/future position. */
export interface Liquidation {
  /** Mark price at which account equity first equals the maintenance margin (isolated, at-mark). */
  liquidationPrice: number;
  /** Mark price at which equity reaches 0 (all posted margin gone) — beyond `liquidationPrice`. */
  bankruptcyPrice: number;
  /** Adverse move to liquidation as a fraction of entry: `|liquidationPrice − entryPrice| / entryPrice`. */
  distanceToLiquidation: number;
  /** Initial-margin rate used, `1/leverage`. */
  initialMarginRate: number;
}

/** EXACT {@link LiquidationInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const LIQUIDATION_KEYS = [
  'margin',
  'entryPrice',
  'leverage',
  'maintenanceMarginRate',
  'side',
] as const;

/**
 * Isolated-margin liquidation & bankruptcy price of a leveraged perpetual/future position (inverse or
 * linear). Size-independent: depends only on entry price, leverage, maintenance-margin rate, side, and
 * margin mode. Maintenance is assessed at the mark (see the module doc for the convention and the
 * closed forms). Requires `leverage > 1` — an isolated liquidation price is degenerate at ≤1×.
 */
export function liquidationPrice(
  input: LiquidationInput,
): Computed<Liquidation, LiquidationAssumptions> {
  const functionName = 'liquidationPrice';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, LIQUIDATION_KEYS);
  ensureEnum(input.margin, MARGIN_MODES, 'margin', functionName);
  ensurePositive(input.entryPrice, 'entryPrice', functionName);
  ensureFinite(input.leverage, 'leverage', functionName);
  if (!(input.leverage > 1)) {
    throw new InputError(
      `${functionName}: leverage must be > 1 — an isolated liquidation price is degenerate at ≤1× (a 1× long liquidates only at 0, a 1× inverse short never within margin).`,
      { code: ErrorCode.InputOutOfRange, context: { leverage: input.leverage } },
    );
  }
  ensureFinite(input.maintenanceMarginRate, 'maintenanceMarginRate', functionName);
  const m = input.maintenanceMarginRate;
  if (!(m >= 0 && m < 1)) {
    throw new InputError(`${functionName}: maintenanceMarginRate must be in [0, 1) — got ${m}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { maintenanceMarginRate: m },
    });
  }
  if (input.side !== undefined && input.side !== 'long' && input.side !== 'short') {
    throw new InputError(
      `liquidationPrice: side must be 'long' | 'short' when provided. Received ${input.side === null ? 'null' : JSON.stringify(input.side)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'side' } },
    );
  }
  const side = input.side ?? 'long';
  ensureEnum(side, SIDES, 'side', functionName);

  const { entryPrice: F0, margin } = input;
  const imr = 1 / input.leverage;
  const isLong = side === 'long';

  // Mark-based isolated liquidation (see module doc); bankruptcy is the same with m = 0.
  const liq = (mm: number): number =>
    margin === 'inverse'
      ? isLong
        ? (F0 * (1 + mm)) / (1 + imr)
        : (F0 * (1 - mm)) / (1 - imr)
      : isLong
        ? (F0 * (1 - imr)) / (1 - mm)
        : (F0 * (1 + imr)) / (1 + mm);

  const liquidation = liq(m);
  const bankruptcy = liq(0);

  return finalizeResult(functionName, {
    value: {
      liquidationPrice: liquidation,
      bankruptcyPrice: bankruptcy,
      distanceToLiquidation: Math.abs(liquidation - F0) / F0,
      initialMarginRate: imr,
    },
    assumptions: liquidationAssumptions(margin, side, m),
    diagnostics: {
      engine: 'perp-liquidation',
      method: 'closed-form',
      converged: true,
      warnings: [],
    },
  });
}

function liquidationAssumptions(
  margin: MarginMode,
  side: InverseSide,
  mmr: number,
): Assumptions<LiquidationAssumptions> {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    model: 'perp-liquidation',
    engine: 'perp-liquidation',
    margin,
    side,
    maintenanceMarginRate: mmr,
    marginBasis: 'isolated; maintenance assessed at the mark',
  };
}
