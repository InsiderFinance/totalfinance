/**
 * Structural strategy classification (dx §4.5) — identity is DERIVED from the legs, never
 * remembered. A position that started as `ironCondor(...)` and was tweaked past recognition is
 * whatever its legs now say it is; `classifyStrategy` recomputes that truth on demand.
 *
 * Matching is structural: legs are normalized to a BASE signature of (kind, sign, strike-rank,
 * quantity-ratio, expiry-rank) tuples and compared against signatures DERIVED from the manifest's
 * own example inputs — so the classifier can never drift from the builders (the round-trip law in
 * CI rebuilds every example, plus randomized spacing/scale/order variants, and asserts each
 * classifies to its own name). The base signature carries NO strike-spacing information: an iron
 * condor is an iron condor whether its wings are 5 or 50 wide, evenly spaced or not. Notes on
 * exactness:
 *
 * - Quantity RATIOS are identity (a 2-lot condor is a condor; a 1×3 call ratio spread does not
 *   match the 1×2 archetype and classifies as custom).
 * - Wing-gap symmetry is used ONLY as a tie-breaker where two registry entries collide on the
 *   base signature — the butterfly (equal wings) vs broken-wing (skip-strike) families, which
 *   genuinely differ by spacing alone. It is never part of any other strategy's identity.
 * - Builders that accept either strike ordering (the diagonals: nothing constrains
 *   `shortStrike` vs `longStrike`) register one signature per ordering, so a reversed-strike
 *   diagonal still classifies to its own name.
 * - Aliases that share a payoff (`shortPut` / `cashSecuredPut`) both match; manifest order first.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type QuantWarning,
  requireArgumentArray,
} from '@totalfinance/core';
import type { Position } from './position.js';
import { strategyRegistry } from './manifest.js';
import type { LegInput, LegKind } from './types.js';

/** One classification match. `exact` is always true today (a fuzzy tier can be added later). */
export interface StrategyMatch {
  name: string;
  exact: true;
}

/**
 * The classification report (Law 2 report grammar): every matching name plus the applied matching
 * conventions and a warnings channel.
 */
export interface StrategyClassification {
  /**
   * Every matching name in manifest order — payoff-identical aliases all match. Empty = a custom
   * position (every calculation still works, it just has no name).
   */
  matches: StrategyMatch[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    /** Identity is the structural base signature: (kind, sign, strike-rank, ratio, expiry-rank). */
    matching: 'structural-base-signature';
    /** Spacing splits base-signature collisions only (butterflies vs broken wings). */
    tieBreaker: 'wing-gap-symmetry';
  };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** The classifiable subset of a leg: kind, strike, signed quantity, optional expiry. */
/** The members `strategySignature` reads; a stock row carries no strike (`undefined`), an option row must. */
export type ClassifiableLeg = {
  kind: LegKind;
  quantity: number;
  strike?: number | undefined;
  expiry?: string | undefined;
};

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) [x, y] = [y, x % y];
  return x;
}

/**
 * Normalize legs to a structural BASE signature string (order-, scale-, and spacing-independent).
 * Two leg lists share a base signature iff they have the same (kind, sign, strike-rank,
 * quantity-ratio, expiry-rank) multiset — strike DISTANCES are deliberately not encoded (spacing
 * distinguishes only butterflies from broken wings, handled as a tie-breaker in
 * {@link classifyStrategy}, never here).
 */
export function strategySignature(legs: readonly ClassifiableLeg[]): string {
  requireArgumentArray('strategySignature', 'legs', legs);
  if (legs.length === 0) return 'empty';
  // Scale invariance: reduce integer quantities by their gcd (2× a condor ≡ a condor).
  const quantities = legs.map((l) => l.quantity);
  const allInt = quantities.every((q) => Number.isInteger(q));
  const divisor = allInt ? quantities.reduce((g, q) => gcd(g, q), 0) || 1 : 1;
  // Strike ranks over the distinct option strikes, ascending (stock legs rank as 'S').
  const strikes = [
    ...new Set(legs.flatMap((l) => (l.strike === undefined ? [] : [l.strike]))),
  ].sort((a, b) => a - b);
  const strikeRank = new Map(strikes.map((k, i) => [k, i]));
  // Expiry ranks over distinct expiries, ascending; "no expiry" is its own bucket. A position with
  // one distinct expiry (or none) is single-expiry: rank 0 for every leg.
  const expiries = [...new Set(legs.map((l) => l.expiry).filter((e) => e !== undefined))].sort();
  const expiryRank = (e: string | undefined): number =>
    expiries.length <= 1 ? 0 : e === undefined ? -1 : expiries.indexOf(e);
  const tuples = legs.map((l) => {
    const rank =
      l.kind === 'stock' || l.strike === undefined ? 'S' : String(strikeRank.get(l.strike));
    const sign = l.quantity > 0 ? '+' : '-';
    const ratio = Math.abs(l.quantity) / divisor;
    return `${l.kind}:${sign}:${rank}:${ratio}:${expiryRank(l.expiry)}`;
  });
  tuples.sort();
  return tuples.join('|');
}

/**
 * Wing-gap symmetry over the distinct option strikes: `'sym'` when every consecutive strike gap
 * is equal (relative tolerance), `'asym'` otherwise, `null` with fewer than 3 distinct strikes
 * (no interior wing to compare). Used ONLY to split base-signature collisions between the
 * symmetric butterfly family and the broken wings — spacing is not identity anywhere else.
 */
type WingGaps = 'sym' | 'asym' | null;

function wingGaps(legs: readonly ClassifiableLeg[]): WingGaps {
  const strikes = [
    ...new Set(legs.flatMap((l) => (l.strike === undefined ? [] : [l.strike]))),
  ].sort((a, b) => a - b);
  if (strikes.length < 3) return null;
  const deltas = strikes.slice(1).map((k, i) => k - strikes[i]!);
  const first = deltas[0]!;
  return deltas.some((d) => Math.abs(d - first) > 1e-9 * Math.max(1, Math.abs(first)))
    ? 'asym'
    : 'sym';
}

interface SignatureEntry {
  name: string;
  /** The wing-gap class of the entry's example — the tie-breaker attribute (see module doc). */
  gaps: WingGaps;
}

let SIGNATURES: Map<string, SignatureEntry[]> | undefined;

/** Canonical market used to build the manifest examples (values are irrelevant to signatures). */
const CANONICAL_MARKET = {
  spot: 105,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T10:00:00-05:00',
  expiry: '2026-06-19',
} as const;

function signatureIndex(): Map<string, SignatureEntry[]> {
  if (SIGNATURES === undefined) {
    SIGNATURES = new Map();
    for (const entry of strategyRegistry()) {
      // The example itself — plus, where the builder accepts either strike ordering (the diagonals
      // expose top-level shortStrike/longStrike with no ordering constraint), the example with the
      // two strikes swapped, so BOTH orderings classify back to the builder's name.
      const examples: Record<string, unknown>[] = [entry.example];
      const shortStrike = entry.example['shortStrike'];
      const longStrike = entry.example['longStrike'];
      if (typeof shortStrike === 'number' && typeof longStrike === 'number') {
        examples.push({ ...entry.example, shortStrike: longStrike, longStrike: shortStrike });
      }
      for (const example of examples) {
        const position = entry.builder(example as never, {
          premiums: 'model',
          market: CANONICAL_MARKET,
        });
        const sig = strategySignature(position.legs);
        const list = SIGNATURES.get(sig) ?? [];
        const gaps = wingGaps(position.legs);
        if (!list.some((e) => e.name === entry.name && e.gaps === gaps)) {
          list.push({ name: entry.name, gaps });
        }
        SIGNATURES.set(sig, list);
      }
    }
  }
  return SIGNATURES;
}

/**
 * Classify a leg list (or a Position) against the named-strategy catalog. `matches` carries every
 * matching name in manifest order — payoff-identical aliases all match — and is `[]` when the
 * structure matches nothing (a custom position; every calculation still works, it just has no name).
 */
export function classifyStrategy(
  input: readonly ClassifiableLeg[] | readonly LegInput[] | Position,
): StrategyClassification {
  if (input === null || typeof input !== 'object') {
    throw new InputError(
      `classifyStrategy: expected a leg array or a Position, got ${input === null ? 'null' : typeof input}.`,
      { code: ErrorCode.InputWrongType, context: { received: typeof input } },
    );
  }
  const legs: readonly ClassifiableLeg[] = Array.isArray(input) ? input : (input as Position).legs;
  requireArgumentArray('classifyStrategy', 'legs', legs as never);
  const candidates = signatureIndex().get(strategySignature(legs)) ?? [];
  // Wing-gap symmetry breaks ties ONLY when the base signature is ambiguous between entries of
  // different gap classes (butterflies vs broken wings). A homogeneous candidate set matches
  // regardless of spacing — an unevenly-winged iron condor is still an iron condor.
  const classes = new Set(candidates.map((c) => c.gaps));
  const matched =
    classes.size > 1 ? candidates.filter((c) => c.gaps === wingGaps(legs)) : candidates;
  return {
    matches: matched.map(({ name }) => ({ name, exact: true as const })),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      matching: 'structural-base-signature',
      tieBreaker: 'wing-gap-symmetry',
    },
    diagnostics: { warnings: [] },
  };
}
