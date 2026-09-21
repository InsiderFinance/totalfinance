/**
 * Intrabar ambiguity (Stage 4.6, FC8 Decision 7). A bar says where prices went, not in which
 * order. When two orders could both have touched inside one bar — a take-profit above and a
 * stop-loss below, two resting orders on opposite sides of the open — the sequence is a decision
 * the run must make explicitly. Four policies, one function, and the count of ambiguous bars in
 * every result's diagnostics.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { AmbiguityPolicy } from './types.js';

/** One order that touched inside the bar. */
export interface IntrabarTouch {
  orderId: string;
  /** The price at which the order would fill. */
  triggerPrice: number;
  /** Whether filling this order first is the favorable sequence for the account (a take-profit). */
  favorable: boolean;
}

export interface OrderTouchSequenceInput {
  bar: { open: number; high: number; low: number; close: number };
  touches: readonly IntrabarTouch[];
  policy: AmbiguityPolicy;
}

export type IntrabarPath = 'open-low-high-close' | 'open-high-low-close' | 'unambiguous';

export interface OrderTouchSequenceResult {
  /** Order ids in fill sequence. */
  sequence: string[];
  /** The path the sequence assumes; `unambiguous` when every touch lay on one side of the open. */
  path: IntrabarPath;
  /** Whether the bar alone could not decide the sequence (the policy did). */
  ambiguous: boolean;
  policy: AmbiguityPolicy;
}

const INPUT_KEYS = ['bar', 'touches', 'policy'] as const;
const TOUCH_KEYS = ['orderId', 'triggerPrice', 'favorable'] as const;
const POLICIES: readonly AmbiguityPolicy[] = [
  'optimistic',
  'pessimistic',
  'deterministic-path',
  'reject',
];

function distanceOrder(touches: readonly IntrabarTouch[], open: number): string[] {
  // Nearer the open fills first; ties break on orderId so the sequence is stable.
  return [...touches]
    .sort(
      (a, b) =>
        Math.abs(a.triggerPrice - open) - Math.abs(b.triggerPrice - open) ||
        (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0),
    )
    .map((touch) => touch.orderId);
}

/**
 * Resolve the fill sequence of the orders a bar touched. Touches on one side of the open are
 * never ambiguous (nearer the open fills first). Touches on both sides are: `deterministic-path`
 * walks open → low → high → close on an up bar (close ≥ open) and open → high → low → close on a
 * down bar; `optimistic` walks the side holding a favorable touch first (and the deterministic
 * path when both sides do); `pessimistic` the reverse; `reject` refuses with
 * `backtest.ambiguous_intrabar` naming the orders.
 */
export function orderTouchSequence(input: OrderTouchSequenceInput): OrderTouchSequenceResult {
  const functionName = 'orderTouchSequence';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requireArgumentObject(functionName, 'input.bar', input.bar);
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    const value = input.bar[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InputError(`${functionName}: input.bar.${field} must be a finite number.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `bar.${field}` },
      });
    }
  }
  if (input.bar.low > input.bar.high) {
    throw new InputError(
      `${functionName}: input.bar.low (${input.bar.low}) exceeds input.bar.high (${input.bar.high}).`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'bar.low' } },
    );
  }
  requireArgumentArray(functionName, 'input.touches', input.touches);
  const ids = new Set<string>();
  input.touches.forEach((touch, index) => {
    const path = `input.touches[${index}]`;
    requireArgumentObject(functionName, path, touch);
    ensureKnownKeys(functionName, path, touch, TOUCH_KEYS);
    if (typeof touch.orderId !== 'string' || touch.orderId.length === 0) {
      throw new InputError(`${functionName}: ${path}.orderId must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.orderId` },
      });
    }
    if (ids.has(touch.orderId)) {
      throw new InputError(
        `${functionName}: ${path}.orderId '${touch.orderId}' repeats an earlier touch.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `${path}.orderId` },
        },
      );
    }
    ids.add(touch.orderId);
    if (typeof touch.triggerPrice !== 'number' || !Number.isFinite(touch.triggerPrice)) {
      throw new InputError(`${functionName}: ${path}.triggerPrice must be a finite number.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.triggerPrice` },
      });
    }
    if (touch.triggerPrice < input.bar.low || touch.triggerPrice > input.bar.high) {
      throw new InputError(
        `${functionName}: ${path}.triggerPrice (${touch.triggerPrice}) lies outside the bar's range [${input.bar.low}, ${input.bar.high}] — a touch the bar never made is not a touch.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.triggerPrice` } },
      );
    }
    if (typeof touch.favorable !== 'boolean') {
      throw new InputError(`${functionName}: ${path}.favorable must be a boolean.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.favorable` },
      });
    }
  });
  if (!POLICIES.includes(input.policy)) {
    throw new InputError(
      `${functionName}: input.policy must be one of ${POLICIES.map((p) => `'${p}'`).join(' | ')}. Received ${JSON.stringify(input.policy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'policy' } },
    );
  }
  const { open, close } = input.bar;
  const above = input.touches.filter((touch) => touch.triggerPrice > open);
  const below = input.touches.filter((touch) => touch.triggerPrice < open);
  const atOpen = input.touches.filter((touch) => touch.triggerPrice === open);
  const atOpenIds = distanceOrder(atOpen, open);
  if (above.length === 0 || below.length === 0) {
    return {
      sequence: [...atOpenIds, ...distanceOrder(above.length > 0 ? above : below, open)],
      path: 'unambiguous',
      ambiguous: false,
      policy: input.policy,
    };
  }
  if (input.policy === 'reject') {
    throw new InputError(
      `${functionName}: the bar (open ${open}, high ${input.bar.high}, low ${input.bar.low}, close ${close}) touched orders on both sides of the open — ${above.map((t) => t.orderId).join(', ')} above and ${below.map((t) => t.orderId).join(', ')} below — and the 'reject' ambiguity policy refuses to choose a sequence. Choose 'optimistic', 'pessimistic', or 'deterministic-path', or supply finer observations.`,
      {
        code: ErrorCode.BacktestAmbiguousIntrabar,
        context: { above: above.map((t) => t.orderId), below: below.map((t) => t.orderId) },
      },
    );
  }
  const deterministic: IntrabarPath = close >= open ? 'open-low-high-close' : 'open-high-low-close';
  let path: IntrabarPath = deterministic;
  if (input.policy === 'optimistic' || input.policy === 'pessimistic') {
    const favorableAbove = above.some((t) => t.favorable);
    const favorableBelow = below.some((t) => t.favorable);
    if (favorableAbove !== favorableBelow) {
      const favorableSideFirst: IntrabarPath = favorableAbove
        ? 'open-high-low-close'
        : 'open-low-high-close';
      const unfavorableSideFirst: IntrabarPath = favorableAbove
        ? 'open-low-high-close'
        : 'open-high-low-close';
      path = input.policy === 'optimistic' ? favorableSideFirst : unfavorableSideFirst;
    }
  }
  const first = path === 'open-low-high-close' ? below : above;
  const second = path === 'open-low-high-close' ? above : below;
  return {
    sequence: [...atOpenIds, ...distanceOrder(first, open), ...distanceOrder(second, open)],
    path,
    ambiguous: true,
    policy: input.policy,
  };
}
