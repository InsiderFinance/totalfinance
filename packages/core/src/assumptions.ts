/** Convention disclosure (spec §7.4). Pro results echo every applied convention here. */

import type { InterestCompounding, DayCount, EpochMs } from './time.js';

/** Bump this only when default conventions change (major versions only, design law #3). */
export const CONVENTIONS_VERSION = '0.0.1';

export type ThetaUnit = 'perDay' | 'perYear';
export type VegaUnit = 'per1Percent' | 'perPoint';
export type RhoUnit = 'per1Percent' | 'perPoint';

/** Units in which Greeks are reported. */
export interface GreekUnits {
  theta: ThetaUnit;
  vega: VegaUnit;
  rho: RhoUnit;
}

export type DividendModel = 'none' | 'continuousYield' | 'discreteSchedule';

/**
 * Assumptions echoed on every pro result. Extra model-specific fields are added via the `Extra`
 * type parameter so each domain can annotate its own conventions without losing the common shape.
 */
export type Assumptions<Extra extends Record<string, unknown> = Record<never, never>> = {
  conventionsVersion: string;
  dayCount?: DayCount;
  compounding?: InterestCompounding;
  calendar?: string;
  calendarVersion?: string;
  asOf?: EpochMs;
  timeToExpiryYears?: number;
  /**
   * How the contract's expiry label was resolved to an instant: `'us-equity-close'` when a
   * date-only `YYYY-MM-DD` expiry resolved to the US equity/options close — 16:00 America/New_York,
   * or 13:00 on an early-close day;
   * `'explicit-instant'` when the caller supplied a zoned datetime. Named so the convention is
   * never silent (alignment spec P1.6); instrument builders own the full story in Phase 3.
   */
  expiryConvention?: 'us-equity-close' | 'explicit-instant';
  timeToExpiryConvention?: never;
  dividendModel?: DividendModel;
  units?: GreekUnits;
  model?: string;
  engine?: string;
  /**
   * The randomness seed this result was computed under — REQUIRED echo for a
   * `randomness: 'seeded'` Pricer (Gate C, 2026-08-23): a stochastic result that does not name
   * its seed cannot be replayed from the result alone. Deterministic paths never set it.
   */
  seed?: number;
} & Extra;

/** Library default conventions (spec §7.4 defaults table). */
export const DEFAULT_DAY_COUNT: DayCount = 'ACT/365F';
export const DEFAULT_COMPOUNDING: InterestCompounding = 'continuous';
export const DEFAULT_DIVIDEND_YIELD = 0;
export const DEFAULT_GREEK_UNITS: GreekUnits = {
  theta: 'perDay',
  vega: 'per1Percent',
  rho: 'per1Percent',
};
