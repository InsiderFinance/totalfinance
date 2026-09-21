/**
 * FC5 — currency exposure and hedging (the `./risk` subpath): aggregate exposure by currency in a
 * declared base currency, the hedge ratio, and the spot/forward hedged P&L decomposition. The
 * missing-pair law governs everything here: a position whose currency has no supplied connecting
 * quote is EXCLUDED with its reason — it is never converted at a guessed rate.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  missingFieldError,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type CurrencyPairQuote,
  type ForeignExchangeDiagnostics,
  convertCurrency,
  requireCurrencyCode,
  requireCurrencyPairQuote,
} from './spot.js';

// ---------------------------------------------------------------------------------------------------
// Currency exposure
// ---------------------------------------------------------------------------------------------------

/** One position handed to {@link currencyExposure}. */
export interface CurrencyExposurePosition {
  /** The caller's identifier for the position — echoed in exclusions so they stay attributable. */
  positionLabel: string;
  /** Uppercase three-letter code of the currency the position is denominated in. */
  currency: string;
  /** Market value in the position's OWN currency (negative for shorts/liabilities). */
  marketValueInPositionCurrency: number;
}

/** Input for {@link currencyExposure}. */
export interface CurrencyExposureInput {
  positions: CurrencyExposurePosition[];
  /** The reporting currency every value is restated into. */
  baseCurrency: string;
  /**
   * Enough quotes to connect every position currency to the base currency, in either orientation.
   * A currency with no connecting quote has its positions excluded WITH reason — never guessed.
   */
  spotRates: CurrencyPairQuote[];
}

/** One aggregated per-currency exposure row. */
export interface CurrencyExposureRow {
  currency: string;
  positionCount: number;
  /** Sum of position values in the row's own currency. */
  valueInCurrency: number;
  /** The same sum restated in the base currency at the supplied quote. */
  valueInBaseCurrency: number;
  /** Share of `totalBaseValue`; `null` (with a warning) when the total is exactly zero. */
  exposureFraction: number | null;
}

/** One excluded position, with the reason it could not participate. */
export interface ExcludedCurrencyExposurePosition {
  positionLabel: string;
  reason: string;
}

/** How one currency was restated into the base currency. */
export interface CurrencyExposureQuoteUse {
  currency: string;
  /** The caller's quote, echoed verbatim. */
  quote: CurrencyPairQuote;
  /** `'direct'`: multiplied by `quotePerBase`; `'inverted'`: divided by it. */
  orientation: 'direct' | 'inverted';
}

/** Result of {@link currencyExposure}. */
export interface CurrencyExposureResult {
  /** Sum of every INCLUDED position's value in the base currency. */
  totalBaseValue: number;
  /** Per-currency rows in first-appearance order, included currencies only. */
  byCurrency: CurrencyExposureRow[];
  excludedPositions: ExcludedCurrencyExposurePosition[];
  assumptions: {
    baseCurrency: string;
    /** The fixed policy prose: a position with no connecting quote is excluded with its reason. */
    missingPairPolicy: string;
    /** Which quote restated each non-base currency, and in which orientation. */
    quotesUsed: CurrencyExposureQuoteUse[];
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const CURRENCY_EXPOSURE_KEYS = ['positions', 'baseCurrency', 'spotRates'] as const;

const POSITION_KEYS = ['positionLabel', 'currency', 'marketValueInPositionCurrency'] as const;

const CURRENCY_EXPOSURE_EXAMPLE =
  "currencyExposure({ positions: [{ positionLabel: 'bund-etf', currency: 'EUR', marketValueInPositionCurrency: 1_000 }], baseCurrency: 'USD', spotRates: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }] })";

/**
 * Aggregate positions into per-currency exposure in one declared base currency. Base-currency
 * positions pass through unconverted; every other currency is restated with
 * {@link convertCurrency} at the supplied quote in whichever orientation connects it (disclosed in
 * `assumptions.quotesUsed`). A currency with no connecting quote is excluded position-by-position
 * WITH the reason, and `exposureFraction` is each included currency's share of `totalBaseValue`.
 */
export function currencyExposure(input: CurrencyExposureInput): CurrencyExposureResult {
  requireArgumentObject('currencyExposure', 'input', input);
  ensureKnownKeys('currencyExposure', 'input', input, CURRENCY_EXPOSURE_KEYS);
  requireArgumentArray('currencyExposure', 'positions', input.positions);
  requireCurrencyCode('currencyExposure', 'baseCurrency', input.baseCurrency);
  requireArgumentArray('currencyExposure', 'spotRates', input.spotRates);
  input.positions.forEach((position, index) => {
    requireArgumentObject('currencyExposure', `positions[${index}]`, position);
    ensureKnownKeys('currencyExposure', `positions[${index}]`, position, POSITION_KEYS);
    if (typeof position.positionLabel !== 'string' || position.positionLabel.length === 0) {
      throw new InputError(
        `currencyExposure: positions[${index}].positionLabel must be a non-empty string — exclusions are reported by label, and an unlabelled position could not be attributed. Received ${position.positionLabel === null ? 'null' : position.positionLabel === undefined ? 'undefined' : typeof position.positionLabel === 'string' ? "''" : typeof position.positionLabel}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: 'currencyExposure', field: `positions[${index}].positionLabel` },
        },
      );
    }
    requireCurrencyCode('currencyExposure', `positions[${index}].currency`, position.currency);
    requireFiniteFields('currencyExposure', position, ['marketValueInPositionCurrency'], {
      exampleCall: CURRENCY_EXPOSURE_EXAMPLE,
      path: `positions[${index}]`,
    });
  });
  input.spotRates.forEach((quote, index) => {
    requireCurrencyPairQuote('currencyExposure', `spotRates[${index}]`, quote);
  });

  const warnings: string[] = [];
  const excludedPositions: ExcludedCurrencyExposurePosition[] = [];
  const quotesUsed: CurrencyExposureQuoteUse[] = [];

  // Group by currency in first-appearance order.
  const currencyOrder: string[] = [];
  const positionsByCurrency = new Map<string, CurrencyExposurePosition[]>();
  for (const position of input.positions) {
    const group = positionsByCurrency.get(position.currency);
    if (group === undefined) {
      currencyOrder.push(position.currency);
      positionsByCurrency.set(position.currency, [position]);
    } else {
      group.push(position);
    }
  }

  interface IncludedRow {
    currency: string;
    positionCount: number;
    valueInCurrency: number;
    valueInBaseCurrency: number;
  }
  const includedRows: IncludedRow[] = [];
  for (const currency of currencyOrder) {
    const group = positionsByCurrency.get(currency) as CurrencyExposurePosition[];
    const valueInCurrency = group.reduce(
      (sum, position) => sum + position.marketValueInPositionCurrency,
      0,
    );
    if (currency === input.baseCurrency) {
      includedRows.push({
        currency,
        positionCount: group.length,
        valueInCurrency,
        valueInBaseCurrency: valueInCurrency,
      });
      continue;
    }
    const connecting = input.spotRates.filter(
      (quote) =>
        (quote.baseCurrency === currency && quote.quoteCurrency === input.baseCurrency) ||
        (quote.baseCurrency === input.baseCurrency && quote.quoteCurrency === currency),
    );
    if (connecting.length === 0) {
      const reason = `no spot rate supplied connecting ${currency} to base currency ${input.baseCurrency} — the position is excluded, never converted at a guessed rate.`;
      for (const position of group) {
        excludedPositions.push({ positionLabel: position.positionLabel, reason });
      }
      warnings.push(
        `${group.length} position${group.length === 1 ? '' : 's'} in ${currency} excluded: ${reason}`,
      );
      continue;
    }
    if (connecting.length > 1) {
      // Identical duplicates are safe to deduplicate; quotes that DISAGREE are refused — a warning
      // is not consent, and "first wins" made the result depend on array order (review finding).
      const distinct = new Map<string, CurrencyPairQuote>();
      for (const candidate of connecting) {
        distinct.set(
          `${candidate.baseCurrency}/${candidate.quoteCurrency}@${candidate.quotePerBase}`,
          candidate,
        );
      }
      if (distinct.size > 1) {
        throw new InputError(
          `currencyExposure: ${connecting.length} supplied quotes connect ${currency} to ${input.baseCurrency} and they disagree (${[...distinct.keys()].join('; ')}) — the conversion would depend on array order. Supply exactly one quote per currency pair (in either orientation), or resolve the conflict before calling.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: {
              function: 'currencyExposure',
              currency,
              quotes: [...distinct.keys()],
            },
          },
        );
      }
      warnings.push(
        `${connecting.length} identical quotes connect ${currency} to ${input.baseCurrency} — deduplicated; supply each pair once.`,
      );
    }
    const quote = connecting[0] as CurrencyPairQuote;
    const conversion = convertCurrency({
      amount: valueInCurrency,
      fromCurrency: currency,
      toCurrency: input.baseCurrency,
      spotRate: quote,
    });
    quotesUsed.push({
      currency,
      quote: conversion.assumptions.quoteUsed,
      orientation: conversion.assumptions.orientation,
    });
    includedRows.push({
      currency,
      positionCount: group.length,
      valueInCurrency,
      valueInBaseCurrency: conversion.convertedAmount,
    });
  }

  const totalBaseValue = includedRows.reduce((sum, row) => sum + row.valueInBaseCurrency, 0);
  if (totalBaseValue === 0 && includedRows.length > 0) {
    warnings.push(
      'totalBaseValue is exactly 0 (included positions cancel) — exposure fractions are undefined and reported as null.',
    );
  }
  const byCurrency: CurrencyExposureRow[] = includedRows.map((row) => ({
    ...row,
    exposureFraction: totalBaseValue === 0 ? null : row.valueInBaseCurrency / totalBaseValue,
  }));

  return requireRepresentableResult('currencyExposure', {
    totalBaseValue,
    byCurrency,
    excludedPositions,
    assumptions: {
      baseCurrency: input.baseCurrency,
      missingPairPolicy:
        'a position whose currency has no supplied connecting quote is excluded with its reason — never converted at a guessed rate',
      quotesUsed,
    },
    diagnostics: { warnings },
  });
}

// ---------------------------------------------------------------------------------------------------
// Hedge ratio
// ---------------------------------------------------------------------------------------------------

/** Input for {@link hedgeRatio}. */
export interface HedgeRatioInput {
  /** The exposure being hedged, in base-currency units (sign allowed — a short exposure is negative). */
  exposureBaseAmount: number;
  /** The hedge's notional, in the same base-currency units. */
  hedgeNotionalBaseAmount: number;
}

/** Result of {@link hedgeRatio}. */
export interface HedgeRatioResult {
  /** `hedgeNotionalBaseAmount / exposureBaseAmount`; `null` when the exposure is exactly zero. */
  hedgeRatio: number | null;
  /** Present exactly when `hedgeRatio` is null. */
  hedgeRatioAbsentReason?: string;
  assumptions: {
    exposureBaseAmount: number;
    hedgeNotionalBaseAmount: number;
    definition: 'hedgeRatio = hedgeNotionalBaseAmount / exposureBaseAmount';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const HEDGE_RATIO_EXAMPLE =
  'hedgeRatio({ exposureBaseAmount: 1_000_000, hedgeNotionalBaseAmount: 750_000 })';

/**
 * The simple hedge ratio: `hedgeNotionalBaseAmount / exposureBaseAmount`, both amounts echoed. A
 * zero exposure has no ratio — the result is `null` with the reason, never Infinity or NaN.
 */
export function hedgeRatio(input: HedgeRatioInput): HedgeRatioResult {
  requireArgumentObject('hedgeRatio', 'input', input);
  ensureKnownKeys('hedgeRatio', 'input', input, ['exposureBaseAmount', 'hedgeNotionalBaseAmount']);
  requireFiniteFields('hedgeRatio', input, ['exposureBaseAmount', 'hedgeNotionalBaseAmount'], {
    exampleCall: HEDGE_RATIO_EXAMPLE,
  });
  const assumptions = {
    exposureBaseAmount: input.exposureBaseAmount,
    hedgeNotionalBaseAmount: input.hedgeNotionalBaseAmount,
    definition: 'hedgeRatio = hedgeNotionalBaseAmount / exposureBaseAmount',
  } as const;
  if (input.exposureBaseAmount === 0) {
    return {
      hedgeRatio: null,
      hedgeRatioAbsentReason:
        'exposureBaseAmount is 0 — a hedge ratio divides by the exposure, and a zero exposure needs no hedge; any nonzero hedge is unbounded relative to it.',
      assumptions,
      diagnostics: { warnings: [] },
    };
  }
  return requireRepresentableResult('hedgeRatio', {
    hedgeRatio: input.hedgeNotionalBaseAmount / input.exposureBaseAmount,
    assumptions,
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Spot/forward hedged P&L
// ---------------------------------------------------------------------------------------------------

/** Input for {@link spotForwardHedgedProfitAndLoss}. */
export interface SpotForwardHedgedProfitAndLossInput {
  /** The spot when the position was opened. */
  initialSpotRate: CurrencyPairQuote;
  /** The spot at measurement, SAME pair, SAME direction. */
  finalSpotRate: CurrencyPairQuote;
  /** The forward locked when the hedge was placed. REQUIRED whenever `hedgedFraction` > 0. */
  forwardRateAtHedge?: CurrencyPairQuote;
  /** Fraction of the notional hedged at the forward, in [0, 1]. */
  hedgedFraction: number;
  /** Position size in BASE-currency units; positive = long the base currency, negative flips every sign. */
  notionalBaseAmount: number;
}

/** The exact decomposition prose, frozen so tests and docs can quote it. */
export const HEDGED_PROFIT_AND_LOSS_DECOMPOSITION =
  'totalProfitAndLossInQuoteCurrency = (1 − hedgedFraction) × (finalSpotRate.quotePerBase − initialSpotRate.quotePerBase) × notionalBaseAmount + hedgedFraction × (forwardRateAtHedge.quotePerBase − initialSpotRate.quotePerBase) × notionalBaseAmount, every term in the quote currency' as const;

/** Result of {@link spotForwardHedgedProfitAndLoss}. */
export interface SpotForwardHedgedProfitAndLossResult {
  totalProfitAndLossInQuoteCurrency: number;
  /** `(1 − hedgedFraction) × (finalSpot − initialSpot) × notional` — the part left floating. */
  unhedgedComponent: number;
  /** `hedgedFraction × (forwardRateAtHedge − initialSpot) × notional` — the part locked at the forward. */
  hedgedComponent: number;
  assumptions: {
    decomposition: typeof HEDGED_PROFIT_AND_LOSS_DECOMPOSITION;
    hedgedFraction: number;
    /** The fixed direction prose: positive notional is long the base; negative flips every sign. */
    notionalDirection: string;
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const HEDGED_PROFIT_AND_LOSS_KEYS = [
  'initialSpotRate',
  'finalSpotRate',
  'forwardRateAtHedge',
  'hedgedFraction',
  'notionalBaseAmount',
] as const;

const HEDGED_PROFIT_AND_LOSS_EXAMPLE =
  "spotForwardHedgedProfitAndLoss({ initialSpotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, finalSpotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.12 }, forwardRateAtHedge: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.095 }, hedgedFraction: 0.5, notionalBaseAmount: 1_000_000 })";

/**
 * P&L of a base-currency position that hedged `hedgedFraction` of its notional at a forward. The
 * decomposition is exact and disclosed: the unhedged part rides the spot move
 * `(finalSpot − initialSpot)`, the hedged part locked `(forwardRateAtHedge − initialSpot)` the
 * moment the hedge was placed, and the total is their notional-weighted sum in the QUOTE currency.
 * `hedgedFraction: 0` is the pure spot P&L; `hedgedFraction: 1` is fully locked at the forward and
 * indifferent to the final spot. `forwardRateAtHedge` is REQUIRED whenever `hedgedFraction` > 0.
 */
export function spotForwardHedgedProfitAndLoss(
  input: SpotForwardHedgedProfitAndLossInput,
): SpotForwardHedgedProfitAndLossResult {
  requireArgumentObject('spotForwardHedgedProfitAndLoss', 'input', input);
  ensureKnownKeys('spotForwardHedgedProfitAndLoss', 'input', input, HEDGED_PROFIT_AND_LOSS_KEYS);
  requireCurrencyPairQuote(
    'spotForwardHedgedProfitAndLoss',
    'initialSpotRate',
    input.initialSpotRate,
  );
  requireCurrencyPairQuote('spotForwardHedgedProfitAndLoss', 'finalSpotRate', input.finalSpotRate);
  requireSamePairForProfitAndLoss('finalSpotRate', input.finalSpotRate, input.initialSpotRate);
  requireFiniteFields(
    'spotForwardHedgedProfitAndLoss',
    input,
    ['hedgedFraction', 'notionalBaseAmount'],
    {
      exampleCall: HEDGED_PROFIT_AND_LOSS_EXAMPLE,
    },
  );
  if (input.hedgedFraction < 0 || input.hedgedFraction > 1) {
    throw new InputError(
      `spotForwardHedgedProfitAndLoss: hedgedFraction must lie in [0, 1] — it is the fraction of the notional locked at the forward. Received ${input.hedgedFraction}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'spotForwardHedgedProfitAndLoss',
          field: 'hedgedFraction',
          value: input.hedgedFraction,
        },
      },
    );
  }
  const warnings: string[] = [];
  if (input.forwardRateAtHedge === undefined) {
    if (input.hedgedFraction > 0) {
      throw missingFieldError(
        'spotForwardHedgedProfitAndLoss',
        'forwardRateAtHedge',
        HEDGED_PROFIT_AND_LOSS_EXAMPLE,
        'required whenever hedgedFraction > 0 — the hedged part locks this rate, and it is never inferred',
      );
    }
  } else {
    requireCurrencyPairQuote(
      'spotForwardHedgedProfitAndLoss',
      'forwardRateAtHedge',
      input.forwardRateAtHedge,
    );
    requireSamePairForProfitAndLoss(
      'forwardRateAtHedge',
      input.forwardRateAtHedge,
      input.initialSpotRate,
    );
    if (input.hedgedFraction === 0) {
      warnings.push(
        'forwardRateAtHedge does not affect the result — hedgedFraction is 0, so nothing is locked at it.',
      );
    }
  }
  const spotMove = input.finalSpotRate.quotePerBase - input.initialSpotRate.quotePerBase;
  const unhedgedComponent = (1 - input.hedgedFraction) * spotMove * input.notionalBaseAmount;
  const hedgedComponent =
    input.hedgedFraction === 0 || input.forwardRateAtHedge === undefined
      ? 0
      : input.hedgedFraction *
        (input.forwardRateAtHedge.quotePerBase - input.initialSpotRate.quotePerBase) *
        input.notionalBaseAmount;
  return requireRepresentableResult('spotForwardHedgedProfitAndLoss', {
    totalProfitAndLossInQuoteCurrency: unhedgedComponent + hedgedComponent,
    unhedgedComponent,
    hedgedComponent,
    assumptions: {
      decomposition: HEDGED_PROFIT_AND_LOSS_DECOMPOSITION,
      hedgedFraction: input.hedgedFraction,
      notionalDirection:
        'a positive notionalBaseAmount is long the base currency; a negative notional is the short and flips every sign',
    },
    diagnostics: { warnings },
  });
}

/** Same-pair check against the initial spot, phrased for this boundary. */
function requireSamePairForProfitAndLoss(
  label: string,
  quote: CurrencyPairQuote,
  initialSpotRate: CurrencyPairQuote,
): void {
  if (
    quote.baseCurrency !== initialSpotRate.baseCurrency ||
    quote.quoteCurrency !== initialSpotRate.quoteCurrency
  ) {
    throw new InputError(
      `spotForwardHedgedProfitAndLoss: ${label} (${quote.baseCurrency}/${quote.quoteCurrency}) and initialSpotRate (${initialSpotRate.baseCurrency}/${initialSpotRate.quoteCurrency}) must quote the SAME currency pair in the SAME direction. Use invertCurrencyPairQuote to flip one explicitly first.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'spotForwardHedgedProfitAndLoss',
          [label]: `${quote.baseCurrency}/${quote.quoteCurrency}`,
          initialSpotRate: `${initialSpotRate.baseCurrency}/${initialSpotRate.quoteCurrency}`,
        },
      },
    );
  }
}
