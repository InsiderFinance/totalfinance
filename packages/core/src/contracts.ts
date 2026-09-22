/**
 * Canonical option contract types (spec §7.6).
 *
 * These are pure types (zero runtime cost). `@insiderfinance/totalfinance/options` re-exports them and adds pricing
 * market types, builders, and engines. Quotes/trades/dividends and the rest of the market-data
 * contracts live in `market-data.ts`.
 */

import type { EpochMs } from './time.js';

export type OptionType = 'call' | 'put';
/**
 * Exercise style of a LISTED equity/index option. `'bermudan'` was removed (alignment spec P3.4):
 * no vanilla engine supports it, and a representable-but-unpriceable state violates
 * valid-by-construction. Bermudan RATES exercise lives where it is actually priced —
 * `@insiderfinance/totalfinance/fixed-income`'s `bermudanSwaption` with its explicit exercise-date schedule.
 */
export type OptionStyle = 'european' | 'american';
export type Settlement = 'physical' | 'cash';
export type ExerciseTime = 'AM' | 'PM';

export interface Deliverable {
  cash?: number;
  shares?: Array<{ symbol: string; quantity: number }>;
  notes?: string;
}

export interface OptionContract {
  // ── Identity & pricing fields — every engine reads these (P3.4 pricing/metadata split) ──────
  underlying: string;
  type: OptionType;
  /** REQUIRED at build — never defaulted: US equity options are American, many index options European. */
  style: OptionStyle;
  strike: number;
  /** The expiry LABEL as supplied: `YYYY-MM-DD` (a calendar date) or a zoned ISO datetime. */
  expiry: string;
  /**
   * The exact expiration INSTANT the label resolved to (epoch ms), stamped by the builders at
   * construction: a bare date resolves via the named `expiryConvention`; a zoned datetime is the
   * caller's explicit instant. REQUIRED (E2, one expiry law): engines price against this
   * resolution and cross-validate it against the label — an unresolved literal is not a
   * contract; build one with the option builders.
   */
  expiresAt: EpochMs;
  /** HOW `expiry` resolved to `expiresAt` — named, never silent (spec P1.6/P3.4). */
  expiryConvention: 'us-equity-close' | 'explicit-instant';

  // ── Metadata — portfolio accounting, settlement plumbing, display. Vanilla pricing does NOT
  //    read these; an engine never appears to honor a field it ignores (P3.4). ──────────────────
  multiplier?: number;
  settlement?: Settlement;
  /**
   * AM- or PM-settled — settlement/display metadata. It does NOT move `expiresAt`: the expiry
   * instant always comes from the `expiry` label and `expiryConvention`. Express an AM-settled
   * index expiry as a zoned datetime (`'2026-09-18T09:30:00-04:00'`) when its instant matters.
   */
  exerciseTime?: ExerciseTime;
  currency?: string;
  root?: string;
  occSymbol?: string;
  deliverable?: Deliverable;
  adjusted?: boolean;
}
