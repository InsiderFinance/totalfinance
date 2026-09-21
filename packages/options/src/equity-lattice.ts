/**
 * Generic equity binomial lattice (spec §9 lattice tooling). A reusable Cox–Ross–Rubinstein /
 * Jarrow–Rudd tree on a single GBM underlying, exposing a `rollback` primitive that hands each node its
 * two child values and full context (spot, time, up-probability, per-step discount). Unlike the
 * option-specific lattice engines, this is payoff-agnostic: American/Bermudan equity exotics and
 * credit-adjusted instruments (convertible bonds) supply their own node logic. Pure and clock-free.
 */

import {
  ensureKnownKeys,
  ensureFiniteWhenPresent,
  ErrorCode,
  InputError,
  ensureFinite,
  ensurePositive,
  requireArgumentObject,
} from '@totalfinance/core';

export type LatticeVariant = 'crr' | 'jarrow-rudd';

/**
 * The most time steps one lattice will carry (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check admitted a step count whose `rollback`
 * could never finish — the tree has steps²/2 nodes, each a `combine` callback (measured ~24 ns/node
 * for a plain closure: 25,000 steps ≈ 3.1×10^8 nodes ≈ 8 s, the single-digit-second ceiling). The
 * cap still clears the documented CRR-stability requirement `steps > (horizonYears·(rate−q)/σ)²`
 * for extreme drift/vol ratios (e.g. rate 1.0, σ 0.01 needs > 10^4), and CRR pricing error is
 * O(1/steps) — long converged by 25,000.
 */
const MAX_LATTICE_STEPS = 25_000;

export interface EquityLatticeOptions {
  spot: number;
  riskFreeRate: number;
  dividendYield?: number;
  volatility: number;
  /** Horizon in years. */
  horizonYears: number;
  /** Number of time steps (default 200). */
  steps?: number;
  /** `crr` (Cox–Ross–Rubinstein, default) or `jarrow-rudd` (equal-probability). */
  variant?: LatticeVariant;
}

/** Per-node context handed to a {@link EquityLattice.rollback} combiner. */
export interface LatticeNode {
  /** Time step index (0 = today). */
  stepIndex: number;
  /** Up-move count at the node (`0..stepIndex`). */
  upMoveCount: number;
  /** Underlying price at the node. */
  spot: number;
  /** Node time in years (`i·dt`). */
  timeToExpiryYears: number;
  /** Continuation value from the upper child. */
  up: number;
  /** Continuation value from the lower child. */
  down: number;
  /** Risk-neutral up-probability. */
  upProbability: number;
  /** Per-step discount factor `e^{−r·dt}`. */
  discount: number;
  /** Step length in years. */
  timeStepYears: number;
}

export interface EquityLattice {
  readonly steps: number;
  readonly timeStepYears: number;
  /** Up-probability (risk-neutral). */
  readonly upProbability: number;
  /** Underlying price at node `(stepIndex, upMoveCount)` (`upMoveCount` up-moves out of `stepIndex`). */
  spotAt(stepIndex: number, upMoveCount: number): number;
  /**
   * Backward induction from the terminal step to the root. `terminal(spot)` seeds each leaf; `combine`
   * returns each interior node's value from its children + context (apply discounting, exercise,
   * conversion, default adjustment — whatever the instrument needs). Returns the root value.
   */
  rollback(terminal: (spot: number) => number, combine: (node: LatticeNode) => number): number;
}

/** Build a Cox–Ross–Rubinstein / Jarrow–Rudd equity binomial lattice. */
export function equityLattice(options: EquityLatticeOptions): EquityLattice {
  requireArgumentObject('equityLattice', 'options', options);
  const functionName = 'equityLattice';
  ensureKnownKeys(functionName, 'options', options, [
    'spot',
    'riskFreeRate',
    'dividendYield',
    'volatility',
    'horizonYears',
    'steps',
    'variant',
  ]);
  ensurePositive(options.spot, 'spot', functionName);
  ensurePositive(options.volatility, 'volatility', functionName);
  ensurePositive(options.horizonYears, 'horizonYears', functionName);
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(options.dividendYield, 'dividendYield', functionName);
  const q = options.dividendYield ?? 0;
  ensureFiniteWhenPresent(options.steps, 'steps', functionName);
  const steps = options.steps ?? 200;
  // Safe integer AND a work cap (2026-08-23 review, P0): see MAX_LATTICE_STEPS.
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_LATTICE_STEPS) {
    throw new InputError(
      `${functionName}: steps must be an integer in [1, ${MAX_LATTICE_STEPS.toLocaleString('en-US')}] — rollback visits steps²/2 nodes (~3×10^8 combine calls ≈ 8 s at the cap, measured ~24 ns/node) and CRR error is O(1/steps), long converged by then. Received ${steps}.\n  e.g. equityLattice({ spot: 100, riskFreeRate: 0.04, volatility: 0.2, horizonYears: 1, steps: 500 })`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { steps, max: MAX_LATTICE_STEPS },
      },
    );
  }
  if (
    options.variant !== undefined &&
    options.variant !== 'crr' &&
    options.variant !== 'jarrow-rudd'
  ) {
    throw new InputError(
      `${functionName}: variant must be 'crr' | 'jarrow-rudd' when provided. Received ${options.variant === null ? 'null' : JSON.stringify(options.variant)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'variant' } },
    );
  }
  const variant = options.variant ?? 'crr';
  const timeStepYears = options.horizonYears / steps;
  const drift = options.riskFreeRate - q;
  const sigSqrtDt = options.volatility * Math.sqrt(timeStepYears);

  let u: number;
  let d: number;
  let p: number;
  if (variant === 'crr') {
    u = Math.exp(sigSqrtDt);
    d = 1 / u;
    p = (Math.exp(drift * timeStepYears) - d) / (u - d);
  } else if (variant === 'jarrow-rudd') {
    // Equal-probability tree: p = 1/2, drift baked into u/d.
    const nu = (drift - 0.5 * options.volatility * options.volatility) * timeStepYears;
    u = Math.exp(nu + sigSqrtDt);
    d = Math.exp(nu - sigSqrtDt);
    p = 0.5;
  } else {
    throw new InputError(
      `${functionName}: variant must be 'crr' or 'jarrow-rudd', got "${String(variant)}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { variant },
      },
    );
  }
  // The CRR up-probability leaves [0, 1] when the per-step drift outruns the diffusion
  // (|(rate−q)|·√dt ≥ volatility), which makes the "probabilities" — and any rolled-back value —
  // meaningless. Fail loudly with an actionable fix rather than emitting a nonsense price.
  if (!(p >= 0 && p <= 1)) {
    throw new InputError(
      `${functionName}: risk-neutral up-probability ${p} is outside [0, 1] — the ${variant} tree is unstable at timeStepYears=${timeStepYears}. Increase steps (smaller timeStepYears) or reduce the horizonYears/rate so that |(rate−dividendYield)|·√timeStepYears < volatility.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          p,
          timeStepYears,
          riskFreeRate: options.riskFreeRate,
          dividendYield: q,
          volatility: options.volatility,
          variant,
        },
      },
    );
  }
  const discount = Math.exp(-options.riskFreeRate * timeStepYears);
  const rawSpotAt = (i: number, j: number): number =>
    options.spot * Math.pow(u, j) * Math.pow(d, i - j);
  const spotAt = (stepIndex: number, upMoveCount: number): number => {
    if (
      !Number.isSafeInteger(stepIndex) ||
      !Number.isSafeInteger(upMoveCount) ||
      stepIndex < 0 ||
      stepIndex > steps ||
      upMoveCount < 0 ||
      upMoveCount > stepIndex
    ) {
      throw new InputError(
        `equityLattice.spotAt: expected integer node coordinates with 0 ≤ upMoveCount ≤ stepIndex ≤ ${steps}; got stepIndex ${stepIndex}, upMoveCount ${upMoveCount}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { stepIndex, upMoveCount, steps },
        },
      );
    }
    return rawSpotAt(stepIndex, upMoveCount);
  };

  const rollback = (
    terminal: (spot: number) => number,
    combine: (node: LatticeNode) => number,
  ): number => {
    let values = new Array<number>(steps + 1);
    // Internal coordinates are already proven by these loop bounds; bypass the public boundary
    // check in this O(steps²) hot loop.
    for (let j = 0; j <= steps; j++) values[j] = terminal(rawSpotAt(steps, j));
    for (let i = steps - 1; i >= 0; i--) {
      const next = new Array<number>(i + 1);
      const t = i * timeStepYears;
      for (let j = 0; j <= i; j++) {
        next[j] = combine({
          stepIndex: i,
          upMoveCount: j,
          spot: rawSpotAt(i, j),
          timeToExpiryYears: t,
          up: values[j + 1]!,
          down: values[j]!,
          upProbability: p,
          discount,
          timeStepYears,
        });
      }
      values = next;
    }
    return values[0]!;
  };

  return { steps, timeStepYears, upProbability: p, spotAt, rollback };
}
