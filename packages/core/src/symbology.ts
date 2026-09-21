/**
 * Option symbology (spec §7.7) — OCC / OPRA option symbols.
 *
 * OCC symbol layout (the "compact" OSI form): `<ROOT><YYMMDD><C|P><STRIKE×1000, 8 digits>`,
 * e.g. `AAPL260918C00105000` = AAPL, 2026-09-18, call, strike 105.000. The fixed-width tail
 * (6 date + 1 type + 8 strike = 15 chars) lets us parse regardless of root padding.
 */

import { ErrorCode, InputError } from './errors.js';
import { requireArgumentObject } from './invariants.js';
import { parseIsoDate } from './dates.js';
import { resolvedExpiry } from './time.js';
import type { OptionType } from './contracts.js';

export interface OccOptionSymbol {
  root: string;
  /** ISO `YYYY-MM-DD`. */
  expiry: string;
  /** Resolved expiry instant (one expiry law, E2): OCC symbols are always US-equity date-only. */
  expiresAt: number;
  expiryConvention: 'us-equity-close';
  type: OptionType;
  strike: number;
}

const STRIKE_DIGITS = 8;
const TAIL = 15; // YYMMDD(6) + C/P(1) + strike(8)

/** The grammar of a compact OCC symbol, parsed and validated but not yet resolved to an instant. */
interface OccSymbolParts {
  root: string;
  /** ISO `YYYY-MM-DD`. */
  expiry: string;
  type: OptionType;
  strike: number;
}

/**
 * The one OCC grammar: a fixed-width tail, `C`/`P`, an eight-digit strike in thousandths, a real
 * calendar date, a non-empty root. Anything else throws a typed InputError. Kept apart from expiry
 * resolution so a predicate can ask the grammar without bundling the session calendar.
 */
function occSymbolParts(symbol: string): OccSymbolParts {
  const raw = symbol.trim();
  if (raw.length < TAIL + 1) {
    throw new InputError(`occSymbolParts: "${symbol}" is too short to be an OCC option symbol.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'occSymbol', value: symbol },
    });
  }

  const strikeStr = raw.slice(-STRIKE_DIGITS);
  const typeChar = raw.slice(-(STRIKE_DIGITS + 1), -STRIKE_DIGITS).toUpperCase();
  const yymmdd = raw.slice(-TAIL, -(STRIKE_DIGITS + 1));
  // Uppercase the root so parse/format round-trip symmetrically (format uppercases too).
  const root = raw.slice(0, -TAIL).trim().toUpperCase();

  if (
    !/^\d{8}$/.test(strikeStr) ||
    !/^\d{6}$/.test(yymmdd) ||
    (typeChar !== 'C' && typeChar !== 'P')
  ) {
    throw new InputError(`occSymbolParts: "${symbol}" is not a valid OCC option symbol.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'occSymbol', value: symbol },
    });
  }
  if (root.length === 0) {
    throw new InputError(`occSymbolParts: "${symbol}" is missing a root symbol.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'root', value: symbol },
    });
  }

  const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  parseIsoDate(expiry); // reject impossible dates like 2099-13-32 (throws InputOutOfRange)
  const strike = Number(strikeStr) / 1000;
  // A `00000000` strike is not a contract: no listed option has strike 0, and the parse result
  // could never round-trip (formatOccSymbol rejects strike <= 0 with this same message).
  if (!(strike > 0)) {
    throw new InputError(`occSymbolParts: Strike must be > 0, received ${strike}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'strike', value: strike },
    });
  }

  return { root, expiry, type: typeChar === 'C' ? 'call' : 'put', strike };
}

/** Parse an OCC option symbol into its components. */
export function parseOccSymbol(symbol: string): OccOptionSymbol {
  const { root, expiry, type, strike } = occSymbolParts(symbol);
  return {
    root,
    expiry,
    ...(resolvedExpiry(expiry) as { expiresAt: number; expiryConvention: 'us-equity-close' }),
    type,
    strike,
  };
}

/**
 * Whether `symbol` is an OCC option symbol: true exactly when the OCC grammar accepts it — the
 * same parse {@link parseOccSymbol} performs before resolving the expiry instant. The grammar lives
 * in one place; this only asks the question, so a broker or a plan can refuse to treat an option
 * contract as a share without re-describing the symbol layout or bundling the session calendar.
 */
export function isOccOptionSymbol(symbol: string): boolean {
  if (typeof symbol !== 'string') {
    throw new InputError(
      `isOccOptionSymbol: symbol must be a string. Received ${symbol === null ? 'null' : typeof symbol}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'symbol' } },
    );
  }
  try {
    occSymbolParts(symbol);
    return true;
  } catch (error) {
    if (error instanceof InputError) return false;
    throw error;
  }
}

/** Format option components into a compact OCC option symbol. */
export function formatOccSymbol(
  // Formatting needs only the four symbol components — parse output (which also carries the
  // resolved expiry instant) still round-trips, and format callers need not resolve first.
  option: Pick<OccOptionSymbol, 'root' | 'expiry' | 'type' | 'strike'>,
): string {
  requireArgumentObject('formatOccSymbol', 'option', option);
  // NO key closure, deliberately: parse output (which also carries `expiresAt`) round-trips
  // through format by documented contract — the option is a decorated parse artifact.
  if (typeof option.root !== 'string' || option.root.length === 0) {
    throw new InputError(
      `formatOccSymbol: root must be a non-empty underlying root — formatOccSymbol({ root: 'AAPL', expiry: '2026-06-19', type: 'call', strike: 210 }). Received ${option.root === null ? 'null' : option.root === undefined ? 'undefined' : typeof option.root}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'root' } },
    );
  }
  // Validate the real calendar date (not just the shape) so we never emit a garbage symbol.
  const { year, month, day } = parseIsoDate(option.expiry);
  if (!(option.strike > 0)) {
    throw new InputError(`formatOccSymbol: Strike must be > 0, received ${option.strike}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'strike', value: option.strike },
    });
  }

  const yy = String(year).slice(2);
  const date = `${yy}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  // Option type changes the meaning of the whole symbol — never coerce 'CALL'/'C'/typos to a put.
  if (option.type !== 'call' && option.type !== 'put') {
    throw new InputError(
      `formatOccSymbol: type must be 'call' or 'put' (lowercase). Received ${JSON.stringify(option.type)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'type', value: option.type } },
    );
  }
  const typeChar = option.type === 'call' ? 'C' : 'P';
  const strikeThousandths = Math.round(option.strike * 1000);
  const strikeStr = String(strikeThousandths).padStart(STRIKE_DIGITS, '0');
  if (strikeStr.length > STRIKE_DIGITS) {
    throw new InputError(
      `formatOccSymbol: Strike ${option.strike} is too large for an OCC symbol.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'strike', value: option.strike },
      },
    );
  }
  return `${option.root.trim().toUpperCase()}${date}${typeChar}${strikeStr}`;
}
