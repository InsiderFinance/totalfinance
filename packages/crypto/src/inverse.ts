/**
 * Inverse (coin-margined, Deribit/BitMEX-style) futures & perpetuals (spec: `docs/specs/inverse-future.md`).
 *
 * Inverse contracts are denominated in USD notional but margined and settled IN THE COIN, so the coin PnL
 * `s·Q·(1/F₀ − 1/F)` is a non-linear function of price — its coin delta is `Q/F²` (not constant) and a long
 * inverse future is SHORT gamma in coin. That coin delta is exactly the instrument that hedges an inverse
 * *option*'s coin delta, so `inverseHedge` sizes the future/perp against any coin delta and reports the
 * residual convexity the delta hedge leaves behind. Depends only on `@totalfinance/core`.
 */

import {
  ErrorCode,
  InputError,
  type Assumptions,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  finalizeResult,
  requireArgumentObject,
  type Computed,
} from '@totalfinance/core';

const SIDES = ['long', 'short'] as const;
/** Position side of an inverse contract. */
export type InverseSide = (typeof SIDES)[number];

function assumptions(engine: string): Assumptions {
  return { conventionsVersion: CONVENTIONS_VERSION, model: 'inverse-future', engine };
}

function diagnostics(engine: string): Diagnostics {
  return { engine, method: 'closed-form', converged: true, warnings: [] };
}

// ── inverseFuture ───────────────────────────────────────────────────────────────

/** Input for {@link inverseFuture}. */
export interface InverseFutureInput {
  /** USD notional (= contracts × contract multiplier, e.g. $10/contract on Deribit). */
  notionalUsd: number;
  /** Entry price (USD per coin). */
  entryPrice: number;
  /** Current mark price (USD per coin). */
  markPrice: number;
  /** Position side. Default 'long'. */
  side?: InverseSide;
}

/** The coin economics of an inverse-margined futures/perp position. */
export interface InverseFuture {
  /** Coin PnL since entry: `s · notionalUsd · (1/entry − 1/mark)`. */
  coinPnl: number;
  /** USD value of that coin PnL at the mark (`coinPnl · markPrice`). */
  usdPnl: number;
  /** `∂coinPnl/∂mark = s · notionalUsd / mark²` — coin per $1 move; NOT constant (inverse convexity). */
  coinDelta: number;
  /** `∂²coinPnl/∂mark² = s · (−2·notionalUsd / mark³)` — a LONG inverse future is SHORT gamma in coin. */
  coinGamma: number;
  /** Coin-equivalent size at the mark (`s · notionalUsd / mark`) — how many coins the position is long. */
  coinExposure: number;
}

/**
 * The coin PnL and coin greeks of an inverse-margined (Deribit/BitMEX-style) future or perpetual position.
 * The coin PnL `s·Q·(1/entry − 1/mark)` is non-linear in price: the coin delta is `Q/mark²` and a long
 * position is short gamma in coin. See `docs/specs/inverse-future.md`.
 */
/** EXACT {@link InverseFutureInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const INVERSE_FUTURE_KEYS = ['notionalUsd', 'entryPrice', 'markPrice', 'side'] as const;

export function inverseFuture(input: InverseFutureInput): Computed<InverseFuture> {
  const functionName = 'inverseFuture';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INVERSE_FUTURE_KEYS);
  ensurePositive(input.notionalUsd, 'notionalUsd', functionName);
  ensurePositive(input.entryPrice, 'entryPrice', functionName);
  ensurePositive(input.markPrice, 'markPrice', functionName);
  if (input.side !== undefined && input.side !== 'long' && input.side !== 'short') {
    throw new InputError(
      `inverseFuture: side must be 'long' | 'short' when provided. Received ${input.side === null ? 'null' : JSON.stringify(input.side)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'side' } },
    );
  }
  const side = input.side ?? 'long';
  ensureEnum(side, SIDES, 'side', functionName);

  const s = side === 'short' ? -1 : 1;
  const { notionalUsd: Q, entryPrice: F0, markPrice: F } = input;
  const coinPnl = s * Q * (1 / F0 - 1 / F);

  return finalizeResult(functionName, {
    value: {
      coinPnl,
      usdPnl: coinPnl * F,
      coinDelta: (s * Q) / (F * F),
      coinGamma: (s * -2 * Q) / (F * F * F),
      coinExposure: (s * Q) / F,
    },
    assumptions: assumptions('inverse-future'),
    diagnostics: diagnostics('inverse-future'),
  });
}

// ── inverseHedge ────────────────────────────────────────────────────────────────

/** Input for {@link inverseHedge}. */
export interface InverseHedgeInput {
  /** The coin delta to neutralize (e.g. `inverseOption.greeks(…).value.coin.delta`). */
  coinDelta: number;
  /** Mark price of the inverse future/perp used to hedge (USD per coin; a perp ≈ spot). */
  markPrice: number;
  /** Coin gamma of the position being hedged — supply to get the residual gamma after the delta hedge. */
  coinGamma?: number;
}

/** The inverse future/perp trade that neutralizes a coin delta. */
export interface InverseHedge {
  /** USD notional of the inverse future to trade. */
  notionalUsd: number;
  /** Which way to trade it. */
  side: InverseSide;
  /** The hedge future's coin delta — equal and opposite to the input `coinDelta` (combined ⇒ 0). */
  hedgeCoinDelta: number;
  /** Residual coin gamma after the delta hedge (`positionGamma + hedgeFutureGamma`) — iff `coinGamma` given. */
  residualCoinGamma?: number;
}

/**
 * Size an inverse future/perp to neutralize a coin delta `D`: `notionalUsd = |D|·mark²`, sold if `D > 0`
 * and bought if `D < 0`, so the hedge's coin delta `s·notionalUsd/mark² = −D` exactly. When the hedged
 * position's `coinGamma` is supplied, the residual coin gamma after the delta hedge is reported. Assumes
 * the perp/future mark moves 1:1 with the underlying the coin delta was measured against (exact for a
 * perp). See `docs/specs/inverse-future.md`.
 */
/** EXACT {@link InverseHedgeInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const INVERSE_HEDGE_KEYS = ['coinDelta', 'markPrice', 'coinGamma'] as const;

export function inverseHedge(input: InverseHedgeInput): Computed<InverseHedge> {
  const functionName = 'inverseHedge';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INVERSE_HEDGE_KEYS);
  ensureFinite(input.coinDelta, 'coinDelta', functionName);
  ensurePositive(input.markPrice, 'markPrice', functionName);

  const { coinDelta: D, markPrice: F } = input;
  const notionalUsd = Math.abs(D) * F * F;
  const side: InverseSide = D > 0 ? 'short' : 'long';
  const s = side === 'short' ? -1 : 1;
  // The hedge future's coin delta = s·notionalUsd/F² = −D by construction.
  const hedgeCoinDelta = (s * notionalUsd) / (F * F);

  const payload: InverseHedge = {
    notionalUsd,
    side,
    hedgeCoinDelta,
  };

  if (input.coinGamma !== undefined) {
    ensureFinite(input.coinGamma, 'coinGamma', functionName);
    const hedgeGamma = (s * -2 * notionalUsd) / (F * F * F);
    payload.residualCoinGamma = input.coinGamma + hedgeGamma;
  }

  return finalizeResult(functionName, {
    value: payload,
    assumptions: assumptions('inverse-hedge'),
    diagnostics: diagnostics('inverse-hedge'),
  });
}
