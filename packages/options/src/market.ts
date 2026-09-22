/** The `market()` builder for the pro API (spec §9.1). */

import {
  requireFiniteFields,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  requireArgumentObject,
  resolveValuationAsOf,
} from '@totalfinance/core';
import type { DiscreteDividend, OptionMarket } from './types.js';

/**
 * Normalize and lightly validate market inputs. `asOf` is required (epoch ms, `'YYYY-MM-DD'`, or a
 * zoned ISO datetime — resolved here, once) — TotalFinance never reads the system clock (design law
 * #5), so the caller always supplies it.
 *
 * @example
 * ```ts
 * import { market, option } from '@insiderfinance/totalfinance/options';
 *
 * const mkt = market({ spot: 195.3, riskFreeRate: 0.045, volatility: 0.24, dividendYield: 0.005, asOf: '2026-07-20T10:30:00-04:00' });
 * const contract = option.usEquityPut({ underlying: 'AAPL', strike: 190, expiry: '2026-09-18' });
 * option.price({ contract, market: mkt }).value; // premium per share
 * ```
 */
export const MARKET_KEYS = [
  'spot',
  'riskFreeRate',
  'dividendYield',
  'asOf',
  'forward',
  'dividends',
  'volatility',
  'price',
] as const;

export function market(input: OptionMarket): OptionMarket {
  requireArgumentObject('market', 'input', input);
  // Law 12: `{ ...input }` must never carry a misspelled field forward silently.
  ensureKnownKeys('market', 'input', input, MARKET_KEYS);
  requireFiniteFields('market', input, ['spot', 'riskFreeRate'], {
    exampleCall:
      "market({ spot: 195.3, riskFreeRate: 0.045, volatility: 0.24, asOf: '2026-07-20T10:30:00-04:00' })",
  });
  const asOf = resolveValuationAsOf(input.asOf, 'market');
  ensureFinite(asOf, 'asOf', 'market');
  // The frozen artifact is what every pricer trusts: a null dividendYield or a non-array dividends
  // baked in here would surface later as a silent q=0 or a raw crash inside an engine.
  for (const member of ['dividendYield', 'forward', 'volatility', 'price'] as const) {
    ensureFiniteWhenPresent(input[member], member, 'market');
  }
  if (input.dividends !== undefined && !Array.isArray(input.dividends)) {
    throw new InputError(
      `market: dividends must be an array of { timeYears, amount } when provided. Received ${input.dividends === null ? 'null' : typeof input.dividends}.`,
      { code: ErrorCode.InputWrongType, context: { dividends: input.dividends } },
    );
  }
  // Artifact role (Law 2): the built market is FROZEN, exactly like a built contract or position.
  // `asOf` was resolved once here and every result's `assumptions` echoes what was priced — a field
  // edited afterwards (a spot nudged between two `option.price` calls, a dividend amount tweaked)
  // would make those disclosures lie about the inputs. The dividend schedule is COPIED before
  // freezing so the caller's own array is left alone.
  const dividends = input.dividends?.map((dividend) => Object.freeze({ ...dividend }));
  return Object.freeze({
    ...input,
    asOf,
    ...(dividends !== undefined
      ? { dividends: Object.freeze(dividends) as DiscreteDividend[] }
      : {}),
  });
}
