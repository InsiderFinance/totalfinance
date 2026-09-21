/**
 * `chainGreeks` (pre-publish interface repairs, B7): the Greeks call that exists.
 *
 * A chain row is `OptionQuote`. Its optional `greeks` are what a vendor supplied or what this call
 * stamped: per row it selects the observed price, solves the implied volatility with the same
 * style routing as `option.impliedVolatility` (closed-form Black–Scholes–Merton for a European
 * contract, the Bjerksund–Stensland 2002 engine for an American one), prices the contract at that
 * volatility, and stamps `impliedVolatility` and the display-unit `greeks` with their provenance.
 *
 * It never throws per row: a row without a usable price, a price with no volatility, or a
 * malformed row is reported in `diagnostics.rows` and returned unchanged. The arguments themselves
 * are validated like every other door — a malformed request is a typed error.
 */

import {
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  ErrorCode,
  InputError,
  type Computed,
  type Diagnostics,
  type EpochMs,
  type GreekUnits,
  type MarketInputs,
  type OptionQuote,
  type OptionQuoteGreeks,
  type PriceSource,
  type QuantWarning,
  WarningCode,
  ensureEnum,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  isQuantError,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
  resolveValuationAsOf,
  selectQuotePrice,
} from '@totalfinance/core';
import { engines } from './engines.js';
import { impliedVolatilityOption, priceOption } from './pro.js';

export interface ChainGreeksInput {
  /** The chain rows; each is returned in order, stamped when its Greeks could be solved. */
  quotes: readonly OptionQuote[];
  /** Spot, rate, optional continuous yield and the valuation instant (a bare date is refused). */
  market: MarketInputs;
  /** Which observed price to invert per row (default `'mid'`; no fallback across sources). */
  priceSource?: PriceSource;
}

export type ChainGreeksRowStatus = 'solved' | 'skipped';

export interface ChainGreeksRowDiagnostic {
  /** Input index of the row. */
  index: number;
  status: ChainGreeksRowStatus;
  /** The engine that solved the row, or null when it was skipped. */
  engine: string | null;
  /** Why the row was skipped (a typed code, e.g. `implied_volatility.below_intrinsic`), else null. */
  reason: string | null;
  /** The message behind `reason`, else null. */
  message: string | null;
}

/** Extra assumptions `chainGreeks` echoes beyond the shared conventions. */
export interface ChainGreeksAssumptionsExtra extends Record<string, unknown> {
  priceSource: PriceSource;
  /** The engine each exercise style is solved with. */
  engines: { european: 'black-scholes-merton'; american: 'bjerksund-stensland-2002' };
  /** The provenance stamped on every solved row's Greeks. */
  provenanceSource: 'chainGreeks';
  spot: number;
  riskFreeRate: number;
  dividendYield: number;
  units: GreekUnits;
}

export interface ChainGreeksDiagnostics extends Diagnostics {
  warnings: QuantWarning[];
  /** One entry per input row, in order. */
  rows: ChainGreeksRowDiagnostic[];
  solvedCount: number;
  skippedCount: number;
}

/**
 * `value` is the input rows in order: a solved row carries `impliedVolatility` and `greeks`; a
 * skipped row is returned unchanged and named in `diagnostics.rows`.
 */
export type ChainGreeksResult = Computed<OptionQuote[], ChainGreeksAssumptionsExtra> & {
  diagnostics: ChainGreeksDiagnostics;
};

const NAME = 'chainGreeks';
const INPUT_KEYS = ['quotes', 'market', 'priceSource'] as const;
const PRICE_SOURCES = ['bid', 'ask', 'mid', 'last', 'mark'] as const;
const EXAMPLE_CALL =
  "chainGreeks({ quotes, market: { spot: 100, riskFreeRate: 0.04, asOf: '2026-06-01T15:30:00-04:00' } })";

function skipped(index: number, reason: string, message: string): ChainGreeksRowDiagnostic {
  return { index, status: 'skipped', engine: null, reason, message };
}

/**
 * Solve every chain row's implied volatility and Greeks from its observed price. See the module
 * note: non-throwing per row, style-routed, display units, provenance stamped.
 */
export function chainGreeks(input: ChainGreeksInput): ChainGreeksResult {
  requireArgumentObject(NAME, 'input', input);
  ensureKnownKeys(NAME, 'input', input, INPUT_KEYS);
  requireArgumentArray(NAME, 'input.quotes', input.quotes);
  requireArgumentObject(NAME, 'input.market', input.market);
  // Optional enum: present-or-absent, never coalesced (a `null` must teach, not run at 'mid').
  const priceSource = input.priceSource === undefined ? 'mid' : input.priceSource;
  ensureEnum(priceSource, PRICE_SOURCES, 'priceSource', NAME);
  requireFiniteFields(NAME, input.market, ['spot', 'riskFreeRate'], {
    path: 'input.market',
    exampleCall: EXAMPLE_CALL,
  });
  if (!(input.market.spot > 0)) {
    throw new InputError(`${NAME}: input.market.spot must be positive.`, {
      code: ErrorCode.InputNegativeSpot,
      context: { function: NAME, field: 'input.market.spot' },
    });
  }
  ensureFiniteWhenPresent(input.market.dividendYield, 'input.market.dividendYield', NAME);
  const dividendYield = input.market.dividendYield ?? 0;
  const asOf: EpochMs = resolveValuationAsOf(input.market.asOf, NAME);
  const market = {
    spot: input.market.spot,
    riskFreeRate: input.market.riskFreeRate,
    dividendYield,
    asOf,
  };

  const rows: OptionQuote[] = [];
  const rowDiagnostics: ChainGreeksRowDiagnostic[] = [];
  input.quotes.forEach((quote, index) => {
    // A row that is not a quote is a programming error, not a data condition: it throws.
    requireArgumentObject(NAME, `input.quotes[${index}]`, quote);
    requireArgumentObject(NAME, `input.quotes[${index}].contract`, quote.contract);
    try {
      const price = selectQuotePrice(quote, priceSource);
      if (price === undefined) {
        rows.push(quote);
        rowDiagnostics.push(
          skipped(index, 'chain_greeks.no_price', `no ${priceSource} price on the row`),
        );
        return;
      }
      // Style routing, and ONE engine per row: the Greeks are taken from the engine that solved
      // the volatility, never from a different model at that volatility.
      const engine =
        quote.contract.style === 'american' ? { engine: engines.bjerksundStensland2002() } : {};
      const solved = impliedVolatilityOption({
        contract: quote.contract,
        market: { ...market, price },
        ...engine,
      });
      if (solved.value === null) {
        const cause = solved.diagnostics.warnings[0];
        rows.push(quote);
        rowDiagnostics.push(
          skipped(
            index,
            cause?.code ?? 'chain_greeks.no_implied_volatility',
            cause?.message ?? 'no volatility reproduces the observed price',
          ),
        );
        return;
      }
      const priced = priceOption({
        contract: quote.contract,
        market: { ...market, volatility: solved.value },
        greeks: true,
        ...engine,
      });
      const g = priced.greeks!;
      const greeks: OptionQuoteGreeks = {
        delta: g.delta,
        gamma: g.gamma,
        theta: g.theta,
        vega: g.vega,
        rho: g.rho,
        provenance: {
          source: 'chainGreeks',
          model: solved.diagnostics.engine,
          timestampMs: asOf,
        },
      };
      rows.push({ ...quote, impliedVolatility: solved.value, greeks });
      rowDiagnostics.push({
        index,
        status: 'solved',
        engine: solved.diagnostics.engine,
        reason: null,
        message: null,
      });
    } catch (error) {
      // A row the pricers refuse (expired against `asOf`, a strike the contract law rejects, a
      // price below intrinsic) is a data condition: reported, not thrown — the caller asked for
      // the chain. Anything that is not a typed TotalFinance error is a bug and propagates.
      if (!isQuantError(error)) throw error;
      rows.push(quote);
      rowDiagnostics.push(skipped(index, error.code, error.message));
    }
  });
  const skippedCount = rowDiagnostics.filter((row) => row.status === 'skipped').length;
  const warnings: QuantWarning[] = [];
  if (skippedCount > 0) {
    warnings.push({
      code: WarningCode.OptionsChainGreeksRowsSkipped,
      message: `${skippedCount} of ${input.quotes.length} row(s) were not solved; see diagnostics.rows for each reason. Skipped rows are returned unchanged.`,
      severity: 'warn',
      context: { skippedCount, rowCount: input.quotes.length },
    });
  }
  return {
    value: rows,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      asOf,
      priceSource,
      engines: { european: 'black-scholes-merton', american: 'bjerksund-stensland-2002' },
      provenanceSource: 'chainGreeks',
      spot: market.spot,
      riskFreeRate: market.riskFreeRate,
      dividendYield,
      units: DEFAULT_GREEK_UNITS,
    },
    diagnostics: {
      engine: 'chain-greeks',
      warnings,
      rows: rowDiagnostics,
      solvedCount: input.quotes.length - skippedCount,
      skippedCount,
    },
  };
}
