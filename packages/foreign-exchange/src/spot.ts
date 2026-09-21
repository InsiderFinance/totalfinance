/**
 * FC5 — spot foreign exchange: the currency-pair quote contract, quote inversion, cross rates
 * through one common currency, conversion, and pip values. One law above all: a pair always
 * identifies its base and quote currency, and `quotePerBase` is units of QUOTE currency per ONE
 * unit of BASE currency. Nothing here guesses a direction, a pip size, or a missing pair — every
 * inversion is explicit and disclosed in the result's assumptions.
 */

import { requireFiniteComputation } from './internal.js';
import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

// ---------------------------------------------------------------------------------------------------
// The pair contract and its guards
// ---------------------------------------------------------------------------------------------------

/**
 * One foreign-exchange quote. `quotePerBase` is the price of ONE unit of `baseCurrency` expressed
 * in `quoteCurrency` — EUR/USD 1.08 is `{ baseCurrency: 'EUR', quoteCurrency: 'USD',
 * quotePerBase: 1.08 }`: one euro costs 1.08 dollars.
 */
export interface CurrencyPairQuote {
  /** Uppercase three-letter ISO-style code of the currency being priced (ONE unit of this). */
  baseCurrency: string;
  /** Uppercase three-letter ISO-style code of the currency the price is expressed in. */
  quoteCurrency: string;
  /** Units of quote currency per ONE base unit; must be finite and > 0. */
  quotePerBase: number;
}

/** {@link CurrencyPairQuote} keys (Law 12 — mirrors the interface above; keep in sync). */
const CURRENCY_PAIR_QUOTE_KEYS = ['baseCurrency', 'quoteCurrency', 'quotePerBase'] as const;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** The literal a shared guard's derived example plugs in for the quote slot. */
const EXAMPLE_QUOTE = "{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }";

const exampleQuoteCall = (functionName: string, label: string): string =>
  `${functionName}({ …, ${label}: ${EXAMPLE_QUOTE} })`;

/**
 * Validate one currency-code field at a public boundary: a string matching `/^[A-Z]{3}$/`
 * (uppercase three-letter ISO-4217 style). A lowercase spelling is answered with the exact
 * uppercase fix rather than a bare rejection.
 */
export function requireCurrencyCode(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new InputError(
      `${functionName}: ${field} must be an uppercase three-letter currency code string (e.g. 'EUR'). Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
  if (!CURRENCY_CODE_PATTERN.test(value)) {
    const uppercased = value.toUpperCase();
    const fix = CURRENCY_CODE_PATTERN.test(uppercased) ? ` — write it as '${uppercased}'` : '';
    throw new InputError(
      `${functionName}: ${field} must be an uppercase three-letter ISO-style currency code matching /^[A-Z]{3}$/ (e.g. 'EUR'). Received ${JSON.stringify(value)}${fix}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, value } },
    );
  }
}

/**
 * Validate a {@link CurrencyPairQuote} at a public boundary (Law 12 closed request): known keys,
 * two DISTINCT uppercase currency codes, and a finite `quotePerBase` > 0. The guard validates its
 * own `functionName` and `label` first — invoked without them, every error it teaches would blame
 * "undefined" (see `requireFundamentalPeriod` for the precedent).
 */
export function requireCurrencyPairQuote(
  functionName: string,
  label: string,
  quote: CurrencyPairQuote,
): asserts quote is CurrencyPairQuote {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireCurrencyPairQuote: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName === 'string' ? "''" : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new InputError(
      `requireCurrencyPairQuote: label must be a non-empty string (the caller's name for the quote field being validated). Received ${label === null ? 'null' : label === undefined ? 'undefined' : typeof label === 'string' ? "''" : typeof label}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'label' } },
    );
  }
  requireArgumentObject(functionName, label, quote);
  ensureKnownKeys(functionName, label, quote, CURRENCY_PAIR_QUOTE_KEYS);
  requireCurrencyCode(functionName, `${label}.baseCurrency`, quote.baseCurrency);
  requireCurrencyCode(functionName, `${label}.quoteCurrency`, quote.quoteCurrency);
  requireFiniteFields(functionName, quote, ['quotePerBase'], {
    exampleCall: () => exampleQuoteCall(functionName, label),
    path: label,
  });
  if (quote.quotePerBase <= 0) {
    throw new InputError(
      `${functionName}: ${label}.quotePerBase must be > 0 — it prices ONE unit of ${quote.baseCurrency} in ${quote.quoteCurrency}, and a price of ${quote.quotePerBase} is not a price.\n  e.g. ${exampleQuoteCall(functionName, label)}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: `${label}.quotePerBase`,
          value: quote.quotePerBase,
        },
      },
    );
  }
  if (quote.baseCurrency === quote.quoteCurrency) {
    throw new InputError(
      `${functionName}: ${label} prices ${quote.baseCurrency} in itself — baseCurrency and quoteCurrency must differ. A same-currency "pair" carries no exchange-rate information; drop the quote instead.\n  e.g. ${exampleQuoteCall(functionName, label)}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: label, value: quote.baseCurrency },
      },
    );
  }
}

/** Render a pair for prose in errors and derivations: `EUR/USD`. */
function pairLabel(quote: CurrencyPairQuote): string {
  return `${quote.baseCurrency}/${quote.quoteCurrency}`;
}

/** True when `quote` connects the two currencies, in either orientation. */
function connectsCurrencies(quote: CurrencyPairQuote, first: string, second: string): boolean {
  return (
    (quote.baseCurrency === first && quote.quoteCurrency === second) ||
    (quote.baseCurrency === second && quote.quoteCurrency === first)
  );
}

/**
 * Price of ONE unit of `currency` in `inCurrency`, read off `quote` in whichever orientation
 * connects them. The caller has already established the connection.
 */
function priceOfOneUnit(
  quote: CurrencyPairQuote,
  currency: string,
  inCurrency: string,
): { price: number; orientation: 'direct' | 'inverted' } {
  if (quote.baseCurrency === currency && quote.quoteCurrency === inCurrency) {
    return { price: quote.quotePerBase, orientation: 'direct' };
  }
  return { price: 1 / quote.quotePerBase, orientation: 'inverted' };
}

// ---------------------------------------------------------------------------------------------------
// The result grammar
// ---------------------------------------------------------------------------------------------------

/** Diagnostics every FC5 analysis result carries (the FC2 result grammar). */
export interface ForeignExchangeDiagnostics {
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------------
// Inversion
// ---------------------------------------------------------------------------------------------------

/** Input for {@link invertCurrencyPairQuote}. */
export interface InvertCurrencyPairQuoteInput {
  quote: CurrencyPairQuote;
}

/** Result of {@link invertCurrencyPairQuote}. */
export interface InvertCurrencyPairQuoteResult {
  /** The flipped pair: base and quote swapped, `quotePerBase` reciprocated. */
  quote: CurrencyPairQuote;
  assumptions: {
    inversion: '1 / quotePerBase';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

/**
 * Flip a quote's direction: EUR/USD 1.08 becomes USD/EUR 1/1.08. Inverting twice returns the
 * original pair (the quote-direction identity, tested at 1e-12).
 */
export function invertCurrencyPairQuote(
  input: InvertCurrencyPairQuoteInput,
): InvertCurrencyPairQuoteResult {
  requireArgumentObject('invertCurrencyPairQuote', 'input', input);
  ensureKnownKeys('invertCurrencyPairQuote', 'input', input, ['quote']);
  requireCurrencyPairQuote('invertCurrencyPairQuote', 'quote', input.quote);
  return requireRepresentableResult('invertCurrencyPairQuote', {
    quote: {
      baseCurrency: input.quote.quoteCurrency,
      quoteCurrency: input.quote.baseCurrency,
      quotePerBase: 1 / input.quote.quotePerBase,
    },
    assumptions: { inversion: '1 / quotePerBase' },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Cross rates
// ---------------------------------------------------------------------------------------------------

/** Input for {@link crossRate}. */
export interface CrossRateInput {
  firstQuote: CurrencyPairQuote;
  secondQuote: CurrencyPairQuote;
  /** Base currency of the derived cross pair — one of the two non-shared currencies. */
  crossBaseCurrency: string;
  /** Quote currency of the derived cross pair — the other non-shared currency. */
  crossQuoteCurrency: string;
}

/** Result of {@link crossRate}. */
export interface CrossRateResult {
  /** The derived cross pair, oriented as requested. */
  quote: CurrencyPairQuote;
  assumptions: {
    /** The ONE currency the two supplied quotes share — the leg the cross goes through. */
    throughCurrency: string;
    /** The exact arithmetic, with each leg's source quote and orientation named. */
    derivation: string;
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const CROSS_RATE_KEYS = [
  'firstQuote',
  'secondQuote',
  'crossBaseCurrency',
  'crossQuoteCurrency',
] as const;

const CROSS_RATE_EXAMPLE =
  "crossRate({ firstQuote: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, secondQuote: { baseCurrency: 'USD', quoteCurrency: 'JPY', quotePerBase: 147.5 }, crossBaseCurrency: 'EUR', crossQuoteCurrency: 'JPY' })";

/**
 * Derive a cross pair through the ONE currency the two supplied quotes share (EUR/USD × USD/JPY →
 * EUR/JPY). Every orientation case is handled by explicit inversion, and the derivation prose in
 * the assumptions shows each leg's price, source quote, and orientation. Quotes sharing zero or
 * both currencies are rejected with the currencies named — there is no cross to derive.
 */
export function crossRate(input: CrossRateInput): CrossRateResult {
  requireArgumentObject('crossRate', 'input', input);
  ensureKnownKeys('crossRate', 'input', input, CROSS_RATE_KEYS);
  requireCurrencyPairQuote('crossRate', 'firstQuote', input.firstQuote);
  requireCurrencyPairQuote('crossRate', 'secondQuote', input.secondQuote);
  requireCurrencyCode('crossRate', 'crossBaseCurrency', input.crossBaseCurrency);
  requireCurrencyCode('crossRate', 'crossQuoteCurrency', input.crossQuoteCurrency);
  const { firstQuote, secondQuote, crossBaseCurrency, crossQuoteCurrency } = input;

  const firstCurrencies = [firstQuote.baseCurrency, firstQuote.quoteCurrency];
  const secondCurrencies = [secondQuote.baseCurrency, secondQuote.quoteCurrency];
  const commonCurrencies = firstCurrencies.filter((currency) =>
    secondCurrencies.includes(currency),
  );
  if (commonCurrencies.length === 0) {
    throw new InputError(
      `crossRate: firstQuote (${pairLabel(firstQuote)}) and secondQuote (${pairLabel(secondQuote)}) share no common currency — a cross rate needs exactly one shared leg to go through.\n  e.g. ${CROSS_RATE_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'crossRate',
          firstQuoteCurrencies: firstCurrencies,
          secondQuoteCurrencies: secondCurrencies,
        },
      },
    );
  }
  if (commonCurrencies.length === 2) {
    throw new InputError(
      `crossRate: firstQuote (${pairLabel(firstQuote)}) and secondQuote (${pairLabel(secondQuote)}) share BOTH currencies (${commonCurrencies.join(', ')}) — they quote the same pair, so no third currency exists to cross into. Use invertCurrencyPairQuote for direction changes.\n  e.g. ${CROSS_RATE_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'crossRate', commonCurrencies },
      },
    );
  }
  const throughCurrency = commonCurrencies[0] as string;
  const firstOtherCurrency = firstCurrencies.find(
    (currency) => currency !== throughCurrency,
  ) as string;
  const secondOtherCurrency = secondCurrencies.find(
    (currency) => currency !== throughCurrency,
  ) as string;
  const derivableCurrencies = [firstOtherCurrency, secondOtherCurrency];
  if (
    !derivableCurrencies.includes(crossBaseCurrency) ||
    !derivableCurrencies.includes(crossQuoteCurrency) ||
    crossBaseCurrency === crossQuoteCurrency
  ) {
    throw new InputError(
      `crossRate: the supplied quotes derive the pair ${firstOtherCurrency}/${secondOtherCurrency} (through ${throughCurrency}); crossBaseCurrency and crossQuoteCurrency must name those two currencies in the desired orientation. Received crossBaseCurrency '${crossBaseCurrency}', crossQuoteCurrency '${crossQuoteCurrency}'.\n  e.g. ${CROSS_RATE_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'crossRate',
          derivableCurrencies,
          crossBaseCurrency,
          crossQuoteCurrency,
        },
      },
    );
  }

  // Leg one: ONE crossBase unit priced in the through currency, from whichever quote holds it.
  const legOneQuote = firstOtherCurrency === crossBaseCurrency ? firstQuote : secondQuote;
  const legOneLabel = legOneQuote === firstQuote ? 'firstQuote' : 'secondQuote';
  const legOne = priceOfOneUnit(legOneQuote, crossBaseCurrency, throughCurrency);
  // Leg two: ONE through unit priced in the cross quote currency, from the other quote.
  const legTwoQuote = legOneQuote === firstQuote ? secondQuote : firstQuote;
  const legTwoLabel = legTwoQuote === firstQuote ? 'firstQuote' : 'secondQuote';
  const legTwo = priceOfOneUnit(legTwoQuote, throughCurrency, crossQuoteCurrency);

  const quotePerBase = legOne.price * legTwo.price;
  const derivation = `1 ${crossBaseCurrency} = ${legOne.price} ${throughCurrency} (${legOneLabel}, ${legOne.orientation}); 1 ${throughCurrency} = ${legTwo.price} ${crossQuoteCurrency} (${legTwoLabel}, ${legTwo.orientation}); quotePerBase = ${legOne.price} × ${legTwo.price} = ${quotePerBase}.`;

  return requireRepresentableResult('crossRate', {
    quote: {
      baseCurrency: crossBaseCurrency,
      quoteCurrency: crossQuoteCurrency,
      quotePerBase,
    },
    assumptions: { throughCurrency, derivation },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------------

/** Input for {@link convertCurrency} — the FC5 canonical first-touch shape. */
export interface ConvertCurrencyInput {
  /** Amount of `fromCurrency` to convert (any finite sign — a liability converts like an asset). */
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  /** A quote connecting the two currencies, in EITHER orientation — inverted internally, disclosed. */
  spotRate: CurrencyPairQuote;
}

/** Result of {@link convertCurrency}. */
export interface ConvertCurrencyResult {
  convertedAmount: number;
  assumptions: {
    fromCurrency: string;
    toCurrency: string;
    /** The caller's quote, echoed verbatim. */
    quoteUsed: CurrencyPairQuote;
    /** `'direct'`: multiplied by `quotePerBase`; `'inverted'`: divided by it. */
    orientation: 'direct' | 'inverted';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const CONVERT_CURRENCY_KEYS = ['amount', 'fromCurrency', 'toCurrency', 'spotRate'] as const;

const CONVERT_CURRENCY_EXAMPLE =
  "convertCurrency({ amount: 1_000, fromCurrency: 'EUR', toCurrency: 'USD', spotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 } })";

/**
 * Convert an amount between two currencies at the supplied spot quote. The quote must connect the
 * two currencies; when it is oriented the other way the conversion divides instead of multiplies
 * and the result discloses `orientation: 'inverted'`. Converting there and back with the same
 * quote returns the original amount (the round-trip identity, tested at 1e-12). A same-currency
 * conversion with a quote supplied is rejected — the identity conversion needs no quote.
 */
export function convertCurrency(input: ConvertCurrencyInput): ConvertCurrencyResult {
  requireArgumentObject('convertCurrency', 'input', input);
  ensureKnownKeys('convertCurrency', 'input', input, CONVERT_CURRENCY_KEYS);
  requireFiniteFields('convertCurrency', input, ['amount'], {
    exampleCall: CONVERT_CURRENCY_EXAMPLE,
  });
  requireCurrencyCode('convertCurrency', 'fromCurrency', input.fromCurrency);
  requireCurrencyCode('convertCurrency', 'toCurrency', input.toCurrency);
  if (input.fromCurrency === input.toCurrency) {
    throw new InputError(
      `convertCurrency: fromCurrency and toCurrency are both '${input.fromCurrency}' — the identity conversion needs no quote; the amount is already in the target currency. Drop the call (or the quote) instead.\n  e.g. ${CONVERT_CURRENCY_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'convertCurrency', fromCurrency: input.fromCurrency },
      },
    );
  }
  requireCurrencyPairQuote('convertCurrency', 'spotRate', input.spotRate);
  if (!connectsCurrencies(input.spotRate, input.fromCurrency, input.toCurrency)) {
    throw new InputError(
      `convertCurrency: spotRate (${pairLabel(input.spotRate)}) does not connect fromCurrency '${input.fromCurrency}' to toCurrency '${input.toCurrency}' — supply a quote whose base and quote currencies are exactly those two, in either orientation.\n  e.g. ${CONVERT_CURRENCY_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'convertCurrency',
          spotRateCurrencies: [input.spotRate.baseCurrency, input.spotRate.quoteCurrency],
          fromCurrency: input.fromCurrency,
          toCurrency: input.toCurrency,
        },
      },
    );
  }
  const orientation: 'direct' | 'inverted' =
    input.spotRate.baseCurrency === input.fromCurrency ? 'direct' : 'inverted';
  const convertedAmount =
    orientation === 'direct'
      ? input.amount * input.spotRate.quotePerBase
      : input.amount / input.spotRate.quotePerBase;
  return requireFiniteComputation('convertCurrency', {
    convertedAmount,
    assumptions: {
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      quoteUsed: { ...input.spotRate },
      orientation,
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Pip value
// ---------------------------------------------------------------------------------------------------

/** Input for {@link pipValue}. */
export interface PipValueInput {
  quote: CurrencyPairQuote;
  /**
   * The size of one pip in quote-currency units per base unit (e.g. `0.0001` for EUR/USD,
   * `0.01` for USD/JPY). REQUIRED — never guessed from symbol spelling (FC5 law).
   */
  pipSize: number;
  /** Position notional, expressed in `notionalCurrency` units. */
  notionalAmount: number;
  /** Which currency the notional is stated in — must be the pair's base or quote currency. */
  notionalCurrency: string;
}

/** Result of {@link pipValue}. */
export interface PipValueResult {
  /** Value of a one-pip move in the QUOTE currency. */
  pipValueInQuoteCurrency: number;
  /** The same value converted to the base currency at the supplied spot quote. */
  pipValueInBaseCurrency: number;
  assumptions: {
    pipSize: number;
    pipSizeSource: 'explicit';
    notionalCurrency: string;
    /** How the notional was read: already in base units, or converted from quote units at spot. */
    notionalCurrencyRole: 'base' | 'quote';
    baseConversion: 'pip value in base currency = pip value in quote currency / quotePerBase (converted at the supplied spot quote)';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const PIP_VALUE_KEYS = ['quote', 'pipSize', 'notionalAmount', 'notionalCurrency'] as const;

const PIP_VALUE_EXAMPLE =
  "pipValue({ quote: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, pipSize: 0.0001, notionalAmount: 100_000, notionalCurrency: 'EUR' })";

/**
 * Value of one pip for a position. A pip moves `quotePerBase` by `pipSize`, so a notional of `N`
 * BASE units gains/loses `pipSize × N` quote-currency units per pip; a notional stated in the
 * quote currency is first restated in base units at the supplied spot quote. `pipSize` is always
 * explicit — a symbol's spelling never decides it.
 */
export function pipValue(input: PipValueInput): PipValueResult {
  requireArgumentObject('pipValue', 'input', input);
  ensureKnownKeys('pipValue', 'input', input, PIP_VALUE_KEYS);
  requireCurrencyPairQuote('pipValue', 'quote', input.quote);
  requireFiniteFields('pipValue', input, ['pipSize', 'notionalAmount'], {
    exampleCall: PIP_VALUE_EXAMPLE,
    hints: {
      pipSize:
        'quote-currency units per base unit — e.g. 0.0001 for EUR/USD; never guessed from symbol spelling',
    },
  });
  if (input.pipSize <= 0) {
    throw new InputError(
      `pipValue: pipSize must be > 0 (quote-currency units per base unit — e.g. 0.0001 for EUR/USD). Received ${input.pipSize}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'pipValue', field: 'pipSize', value: input.pipSize },
      },
    );
  }
  requireCurrencyCode('pipValue', 'notionalCurrency', input.notionalCurrency);
  const { quote } = input;
  if (
    input.notionalCurrency !== quote.baseCurrency &&
    input.notionalCurrency !== quote.quoteCurrency
  ) {
    throw new InputError(
      `pipValue: notionalCurrency '${input.notionalCurrency}' is neither side of the pair ${pairLabel(quote)} — the notional must be stated in the pair's base or quote currency.\n  e.g. ${PIP_VALUE_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'pipValue',
          notionalCurrency: input.notionalCurrency,
          pairCurrencies: [quote.baseCurrency, quote.quoteCurrency],
        },
      },
    );
  }
  const notionalCurrencyRole: 'base' | 'quote' =
    input.notionalCurrency === quote.baseCurrency ? 'base' : 'quote';
  const notionalInBaseUnits =
    notionalCurrencyRole === 'base'
      ? input.notionalAmount
      : input.notionalAmount / quote.quotePerBase;
  const pipValueInQuoteCurrency = input.pipSize * notionalInBaseUnits;
  const pipValueInBaseCurrency = pipValueInQuoteCurrency / quote.quotePerBase;
  return requireRepresentableResult('pipValue', {
    pipValueInQuoteCurrency,
    pipValueInBaseCurrency,
    assumptions: {
      pipSize: input.pipSize,
      pipSizeSource: 'explicit',
      notionalCurrency: input.notionalCurrency,
      notionalCurrencyRole,
      baseConversion:
        'pip value in base currency = pip value in quote currency / quotePerBase (converted at the supplied spot quote)',
    },
    diagnostics: { warnings: [] },
  });
}
