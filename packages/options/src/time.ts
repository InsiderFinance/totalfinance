/** Time-to-expiry helpers for the pro API. */

import {
  type EpochMs,
  ErrorCode,
  InputError,
  type OptionContract,
  optionExpiryToMs,
  usEquitySessionInstant,
  yearFraction,
  validateResolvedExpiry,
} from '@totalfinance/core';

/**
 * Parse an ISO date (`YYYY-MM-DD`) or ISO date-time expiry to epoch milliseconds, using the shared
 * {@link optionExpiryToMs} convention: a bare date resolves to the **US options close** (16:00 ET,
 * 13:00 ET on early-close days) so an intraday `asOf` on the expiry day still sees positive
 * time-to-expiry, while a full datetime is
 * parsed as-is. This is the single option-expiry convention across `core`, `options`, `strategy`, and
 * `structure`. The resulting `timeToExpiryYears` is always echoed in `assumptions` so it is never hidden.
 */
export function parseExpiryToEpoch(expiry: string, functionName: string): EpochMs {
  try {
    return optionExpiryToMs(expiry);
  } catch {
    throw new InputError(
      `${functionName}: could not parse expiry "${expiry}" (expected an ISO date or datetime).`,
      {
        code: ErrorCode.InputWrongType,
        context: { field: 'expiry', value: expiry, function: functionName },
      },
    );
  }
}

/** Year fraction from `asOf` to the contract expiry under ACT/365F. */
export function timeToExpiryYears(asOf: EpochMs, expiry: string, functionName: string): number {
  return yearFraction(asOf, parseExpiryToEpoch(expiry, functionName), 'ACT/365F');
}

/**
 * Resolve a dividend EX-DATE label to epoch milliseconds.
 *
 * A date-only `YYYY-MM-DD` ex-date resolves to the **US equity market OPEN, 09:30 America/New_York**
 * — deliberately NOT the 16:00 ET option-expiry convention that {@link parseExpiryToEpoch} applies.
 * A share bought on the ex-date does not carry the dividend: the drop happens at the open, so from
 * 09:30 onward that dividend is already in the price and must not be discounted into the spot again.
 * Under the expiry convention an `asOf` of 10:00 ET on the ex-date still saw the dividend as "in the
 * future" and escrowed it a second time — a full dividend of error in the option price (defect-fix
 * wave, finding 3).
 *
 * A ZONED ISO datetime ex-date is the caller's explicit instant and is parsed as-is, unchanged.
 *
 * DST-safe: the instant comes from core's `usEquitySessionInstant` (Intl, per date). The open is 09:30 ET
 * on every session, including early-close days — it is NOT derived from the close.
 */
export function parseExDateToEpoch(exDate: string, functionName: string): EpochMs {
  if (DATE_ONLY_EX_DATE.test(exDate)) {
    try {
      return usEquitySessionInstant(exDate, 'open');
    } catch {
      throw new InputError(
        `${functionName}: could not parse dividend exDate "${exDate}" (expected an ISO date or datetime).`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: 'exDate', value: exDate, function: functionName },
        },
      );
    }
  }
  // Datetime labels share the option-expiry parser (strict, zone-required, nothing normalized).
  return parseExpiryToEpoch(exDate, functionName);
}

const DATE_ONLY_EX_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Year fraction from `asOf` to a dividend ex-date under ACT/365F, using the MARKET-OPEN convention
 * for date-only labels (see {@link parseExDateToEpoch}). Every discrete-dividend consumer in the
 * package resolves ex-dates through here so the schedule means one thing everywhere.
 */
export function timeToExDateYears(asOf: EpochMs, exDate: string, functionName: string): number {
  return yearFraction(asOf, parseExDateToEpoch(exDate, functionName), 'ACT/365F');
}

/**
 * Contract-aware time to expiry (E2, one expiry law): a contract PRICES from its resolved
 * `expiresAt`, cross-validated against the label and convention — there is NO label-parsing
 * fallback. An unresolved literal is rejected with the builder pointer; a post-construction edit
 * of any of the three fields fails loudly.
 */
export function contractTimeToExpiryYears(
  asOf: EpochMs,
  contract: Pick<OptionContract, 'expiry' | 'expiresAt' | 'expiryConvention'>,
  functionName: string,
): number {
  validateResolvedExpiry(
    functionName,
    contract.expiry,
    contract.expiresAt,
    contract.expiryConvention,
  );
  return yearFraction(asOf, contract.expiresAt, 'ACT/365F');
}
