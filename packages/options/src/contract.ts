/**
 * Option contract builders (spec §9.2; rewritten valid-by-construction in alignment-spec P3.4).
 *
 * A builder's name is a promise: what it returns is a VALID instrument. Every meaning-changing
 * field is required (exercise `style` is never guessed — US equity options are American, many
 * index options European), every numeric is validated at construction, and the expiry label is
 * resolved to its exact instant HERE, with the applied convention stamped on the contract.
 *
 * The lovable layer is the instrument builders: `usEquityCall`/`usEquityPut` encode the US listed
 * convention (American exercise, 16:00 ET close for date-only expiries, 100 multiplier);
 * `european` names the European-exercise case explicitly. The generic `callContract`/`putContract`
 * remain for full control and REQUIRE `style`.
 */

import {
  ErrorCode,
  InputError,
  type OptionContract,
  type OptionStyle,
  type OptionType,
  ensureEnum,
  ensureKnownKeys,
  ensurePositive,
  optionExpiryToMs,
  parseOccSymbol,
  requireArgumentObject,
} from '@totalfinance/core';
import { expiryConventionOf } from './engine-bsm.js';

export interface OptionBuilderInput {
  underlying: string;
  strike: number;
  /** Expiry label: `YYYY-MM-DD` (requires `convention`) or a zoned ISO datetime. */
  expiry: string;
  /**
   * REQUIRED for a date-only `expiry` (D2, one expiry law): a bare date does not name its
   * INSTANT, and the generic builders never guess one — `'us-equity-close'` options into the
   * 16:00 ET session close explicitly. The `usEquityCall`/`usEquityPut` names carry it for you.
   */
  convention?: 'us-equity-close';
  /**
   * REQUIRED (P3.4): exercise style is meaning-changing and is never defaulted — an American put
   * is worth more than its European twin. Use `usEquityCall`/`usEquityPut`/`european` when you
   * want the convention encoded in the builder's name instead.
   */
  style: OptionStyle;
  multiplier?: number;
  currency?: string;
  root?: string;
}

/** Instrument-builder input: the convention lives in the builder name, so no `style` here. */
export type InstrumentBuilderInput = Omit<OptionBuilderInput, 'style'>;

const STYLES: readonly OptionStyle[] = ['european', 'american'];

const BUILDER_KEYS = [
  'underlying',
  'strike',
  'expiry',
  'style',
  'convention',
  'multiplier',
  'currency',
  'root',
] as const;

const DATE_ONLY_EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

function validateAndResolve(
  functionName: string,
  type: OptionType,
  input: OptionBuilderInput,
): OptionContract {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, BUILDER_KEYS);
  // `type` reaches here from user input via european({ type }) — never trusted (design law #4).
  ensureEnum(type, ['call', 'put'] as const, 'type', functionName);
  if (typeof input.underlying !== 'string' || input.underlying.trim() === '') {
    throw new InputError(
      `${functionName}: underlying must be a non-blank symbol string. Received ${
        typeof input.underlying === 'string' ? `"${input.underlying}"` : typeof input.underlying
      }.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'underlying' } },
    );
  }
  if (!STYLES.includes(input.style)) {
    throw new InputError(
      `${functionName}: style is required — one of 'european' | 'american' (never defaulted: exercise style ` +
        `changes the value). US listed equity options are American; use usEquityCall/usEquityPut ` +
        `or european(...) to encode the convention in the builder name. Received ${
          input.style === undefined ? 'undefined' : `"${String(input.style)}"`
        }.`,
      { code: ErrorCode.InputMissingField, context: { function: functionName, field: 'style' } },
    );
  }
  ensurePositive(input.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  if (input.multiplier !== undefined) ensurePositive(input.multiplier, 'multiplier', functionName);
  for (const field of ['currency', 'root'] as const) {
    const v = input[field];
    if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) {
      throw new InputError(
        `${functionName}: ${field} must be a non-blank string when provided (omit it for none).`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
      );
    }
  }
  // The convention field is an ENUM, never a free string (E2): 'bogus' teaches, silently
  // ignoring it would be silent economics.
  if (input.convention !== undefined) {
    ensureEnum(input.convention, ['us-equity-close'] as const, 'convention', functionName);
  }
  // A zoned datetime IS its own instant — a convention alongside it is a contradiction, not a
  // no-op (E2): reject rather than silently discard the caller's stated meaning.
  if (
    input.convention !== undefined &&
    typeof input.expiry === 'string' &&
    !DATE_ONLY_EXPIRY.test(input.expiry)
  ) {
    throw new InputError(
      `${functionName}: convention "${input.convention}" contradicts the zoned expiry "${input.expiry}" — ` +
        'a zoned datetime already names its exact instant; omit convention (it applies to ' +
        'date-only labels).',
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, expiry: input.expiry },
      },
    );
  }
  // A date-only expiry must NAME its instant (D2): the generic builders take an explicit
  // convention; only the usEquity* names imply one. `european()` shares this same check.
  if (
    typeof input.expiry === 'string' &&
    DATE_ONLY_EXPIRY.test(input.expiry) &&
    input.convention === undefined
  ) {
    throw new InputError(
      `${functionName}: a date-only expiry ("${input.expiry}") does not name its expiry INSTANT. Pass a ` +
        `zoned datetime (e.g. "${input.expiry}T16:00:00-04:00"), or add convention: ` +
        `'us-equity-close' to opt into the 16:00 ET close explicitly. (usEquityCall/usEquityPut ` +
        'carry that convention in their names.)',
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'convention' },
      },
    );
  }
  // Resolve the expiry label NOW — a builder never returns a contract whose expiry cannot price.
  // optionExpiryToMs validates real calendar dates and rejects zone-less datetimes with the fix.
  const expiresAt = optionExpiryToMs(input.expiry);
  if (!Number.isFinite(expiresAt)) {
    // Belt-and-braces: a frozen contract must never carry a non-finite instant (Law 7).
    throw new InputError(
      `${functionName}: expiry "${input.expiry}" resolved to a non-finite instant.`,
      {
        code: ErrorCode.InputNotFinite,
        context: { function: functionName, expiry: input.expiry },
      },
    );
  }
  // Artifact role (Law 2): the built contract is FROZEN — a field edited after construction
  // would silently disagree with the resolved expiresAt; engines also cross-check the pair.
  return Object.freeze({
    underlying: input.underlying,
    type,
    style: input.style,
    strike: input.strike,
    expiry: input.expiry,
    expiresAt,
    expiryConvention: expiryConventionOf(input.expiry),
    ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.root !== undefined ? { root: input.root } : {}),
  });
}

/** Generic call builder — `style` REQUIRED. */
export function callContract(input: OptionBuilderInput): OptionContract {
  return validateAndResolve('callContract', 'call', input);
}

/** Generic put builder — `style` REQUIRED. */
export function putContract(input: OptionBuilderInput): OptionContract {
  return validateAndResolve('putContract', 'put', input);
}

/**
 * US listed equity call: AMERICAN exercise, date-only expiries resolve to the 16:00 ET close
 * (`expiryConvention: 'us-equity-close'`), multiplier defaults to the standard 100.
 *
 * A ZONED DATETIME expiry is accepted too and is used verbatim (`expiryConvention:
 * 'explicit-instant'`): the builder's date-only convention is what it applies when the label does
 * not name an instant, not a claim about labels that do. Weekly/EOM contracts that expire at an
 * instant other than 16:00 ET — and any desk that stamps the exact settlement time — go through
 * here, not through the generic builders (defect-fix wave, review-1).
 */
// The usEquity* names OWN the convention (E2): neither `style` nor `convention` is accepted —
// a supplied value would be silently identical-or-overridden, and Law 12 forbids silent.
const INSTRUMENT_KEYS = BUILDER_KEYS.filter((k) => k !== 'style' && k !== 'convention');

/**
 * The date-only convention these builders carry, applied ONLY to a date-only label. Stamping it on
 * a zoned datetime made the builder contradict itself: `validateAndResolve` rejects a convention
 * next to an explicit instant, so every zoned expiry was refused with advice ("omit convention")
 * that a caller of `usEquityCall` had no way to follow — the field is not even accepted.
 */
function usEquityConvention(expiry: unknown): { convention?: 'us-equity-close' } {
  return typeof expiry === 'string' && DATE_ONLY_EXPIRY.test(expiry)
    ? { convention: 'us-equity-close' }
    : {};
}

export function usEquityCall(input: InstrumentBuilderInput): OptionContract {
  requireArgumentObject('usEquityCall', 'input', input);
  // The convention lives in the NAME — a user-supplied `style` here would be silently
  // overridden, so it is rejected like any other unknown key (Law 12).
  ensureKnownKeys('usEquityCall', 'input', input, INSTRUMENT_KEYS);
  return validateAndResolve('usEquityCall', 'call', {
    multiplier: 100,
    ...input,
    ...usEquityConvention(input.expiry),
    style: 'american',
  });
}

/** US listed equity put — see {@link usEquityCall}. */
export function usEquityPut(input: InstrumentBuilderInput): OptionContract {
  requireArgumentObject('usEquityPut', 'input', input);
  ensureKnownKeys('usEquityPut', 'input', input, INSTRUMENT_KEYS);
  return validateAndResolve('usEquityPut', 'put', {
    multiplier: 100,
    ...input,
    ...usEquityConvention(input.expiry),
    style: 'american',
  });
}

/** Input for {@link usEquityOption}: an OCC symbol, or the contract's data with its `type`. */
export interface UsEquityOptionInput extends Partial<InstrumentBuilderInput> {
  /** A compact OCC symbol (`AAPL260918C00200000`); its root, expiry, type and strike are the contract. */
  occSymbol?: string;
  /** `'call' | 'put'` — required unless `occSymbol` names it. */
  type?: OptionType;
}

const US_EQUITY_OPTION_KEYS = [...INSTRUMENT_KEYS, 'occSymbol', 'type'] as const;

/**
 * US listed equity option from DATA (B7): either an OCC symbol, or `type` plus the fields
 * `usEquityCall`/`usEquityPut` take. The two named builders remain the sugar; this is the door a
 * chain row, a fill, or a broker symbol goes through without branching on `type` first. A field
 * given beside `occSymbol` must agree with the symbol — a contradiction is refused, never resolved
 * by preference.
 */
export function usEquityOption(input: UsEquityOptionInput): OptionContract {
  requireArgumentObject('usEquityOption', 'input', input);
  ensureKnownKeys('usEquityOption', 'input', input, US_EQUITY_OPTION_KEYS);
  const { occSymbol, type, ...fields } = input;
  if (occSymbol !== undefined) {
    if (typeof occSymbol !== 'string' || occSymbol.trim().length === 0) {
      throw new InputError(
        `usEquityOption: occSymbol must be a non-empty OCC option symbol string when provided.`,
        { code: ErrorCode.InputWrongType, context: { field: 'occSymbol' } },
      );
    }
    const parsed = parseOccSymbol(occSymbol);
    // The symbol names the ROOT (`SPXW`), not the underlying (`SPX`): `underlying` may be given
    // beside it; `root`, `type`, `strike`, and `expiry` must agree with what the symbol spells.
    const conflicts = (
      [
        ['type', type, parsed.type],
        ['root', fields.root, parsed.root],
        ['strike', fields.strike, parsed.strike],
        ['expiry', fields.expiry, parsed.expiry],
      ] as const
    ).filter(([, given, fromSymbol]) => given !== undefined && given !== fromSymbol);
    if (conflicts.length > 0) {
      throw new InputError(
        `usEquityOption: ${conflicts
          .map(
            ([field, given, fromSymbol]) =>
              `${field} ${JSON.stringify(given)} contradicts occSymbol's ${JSON.stringify(fromSymbol)}`,
          )
          .join('; ')}. Pass the symbol alone, or the fields alone.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: 'usEquityOption', occSymbol, conflicts: conflicts.map(([f]) => f) },
        },
      );
    }
    const { strike: _strike, expiry: _expiry, root: _root, ...rest } = fields;
    const build = parsed.type === 'call' ? usEquityCall : usEquityPut;
    const contract = build({
      ...rest,
      underlying: rest.underlying ?? parsed.root,
      strike: parsed.strike,
      expiry: parsed.expiry,
      root: parsed.root,
    });
    return Object.freeze({ ...contract, occSymbol: occSymbol.trim().toUpperCase() });
  }
  if (type === undefined) {
    throw new InputError(
      `usEquityOption: type ('call' | 'put') is required unless occSymbol is given. ` +
        `e.g. usEquityOption({ type: 'call', underlying: 'AAPL', strike: 200, expiry: '2026-09-18' })`,
      { code: ErrorCode.InputMissingField, context: { function: 'usEquityOption', field: 'type' } },
    );
  }
  ensureEnum(type, ['call', 'put'] as const, 'type', 'usEquityOption');
  return (type === 'call' ? usEquityCall : usEquityPut)(fields as InstrumentBuilderInput);
}

/**
 * European-exercise contract with the convention in the name (index-style options).
 *
 * A DATE-ONLY expiry must say which instant it means: pass a zoned datetime, or add
 * `convention: 'us-equity-close'` to opt into the 16:00 ET close explicitly. The silent
 * US-equity default belongs to `usEquityCall`/`usEquityPut`, whose NAMES carry it — European
 * index products settle at different instants (AM auctions, European closes), so guessing here
 * would be silent economics (Law 6).
 */
export function european(
  input: InstrumentBuilderInput & { type: OptionType; convention?: 'us-equity-close' },
): OptionContract {
  requireArgumentObject('european', 'input', input);
  ensureKnownKeys('european', 'input', input, [...INSTRUMENT_KEYS, 'type', 'convention']);
  const { type, ...rest } = input;
  return validateAndResolve('european', type, { ...rest, style: 'european' });
}
