import { bench, describe } from 'vitest';
import { barrier, doubleTouch } from '@totalfinance/options/exotics';

/**
 * Exotics boundary-validation evidence (spec 3B.1b, generated-spec migration).
 *
 * The exotics cluster validates ONCE per public call through `validateClosedRequest` walking a
 * generated spec — a per-field loop over static data with cached key indexes. C14's rule for
 * scalar paths is to report the ABSOLUTE cost rather than police a noisy percentage: these two
 * cases keep that number visible so a future spec walk that starts allocating (or a spec that
 * grows a nested branch scan on the hot path) shows up as a level shift. The Monte-Carlo engines
 * dominate their own cost by orders of magnitude; scalar analytics are where validation could
 * ever matter, so that is what is measured. Read the rme before quoting anything.
 */
const BARRIER = {
  type: 'call',
  barrierType: 'up-out',
  spot: 100,
  strike: 105,
  barrier: 120,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
} as const;

const DOUBLE_TOUCH = {
  kind: 'double-no-touch',
  spot: 100,
  lower: 90,
  upper: 115,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
} as const;

describe('exotic scalar analytics (validate once, then closed form)', () => {
  bench('barrier.price (8-field intersection spec)', () => {
    barrier.price(BARRIER);
  });

  bench('doubleTouch.price (7-field spec + image series)', () => {
    doubleTouch.price(DOUBLE_TOUCH);
  });
});
