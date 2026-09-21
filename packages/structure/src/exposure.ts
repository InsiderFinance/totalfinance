/**
 * Options market-structure exposure (spec §11.1–11.5): per-contract and aggregate dealer-positioning
 * estimates — GEX, DEX, vega/vanna/charm exposure — plus levels (walls, zero-gamma, max pain, pin
 * risk), by-strike/by-expiry profiles, and scenario maps.
 *
 * IMPORTANT: these analytics ESTIMATE positioning from open interest and a sign convention. They do
 * not know true dealer books. Every result echoes its sign convention in `assumptions.convention`
 * and carries its model limitations as `model.limitation` entries in `diagnostics.warnings` (R2 —
 * no hoisted fields). There is no ambiguous canonical `vex`; vega-of-spot is `vega` and
 * vega-of-spot/vol cross is `vanna`.
 *
 * GEX (per-1%-move convention, the spec formula): `Γ · openInterest · multiplier · spot² · 0.01`.
 */

import {
  ensureFiniteWhenPresent,
  type Assumptions,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type MarketInputs,
  type OptionQuote,
  type OptionType,
  type PriceSource,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  optionExpiryToMs,
  resolveValuationAsOf,
  selectQuotePrice,
  warning,
  wrongShapeError,
  yearFraction,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { impliedVolatility } from '@totalfinance/options';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
} from '@totalfinance/options/black-scholes';
import { asOfMarketDayIndex, marketDateUtcMs, marketDayIndex } from './market-day.js';

export type ExposureConvention =
  | 'callsPositivePutsNegative'
  | 'dealerShortGamma'
  | 'tradeSignedAggressor'
  | { calls: 1 | -1; puts: 1 | -1 };

export type GammaUnit = 'per1PercentMove' | 'perPoint';
export type ExposureMetric =
  | 'gex'
  | 'dex'
  | 'vega'
  | 'vanna'
  | 'charm'
  | 'theta'
  | 'vomma'
  | 'speed'
  | 'color';

const ALL_METRICS: readonly ExposureMetric[] = [
  'gex',
  'dex',
  'vega',
  'vanna',
  'charm',
  'theta',
  'vomma',
  'speed',
  'color',
];

/** Metrics that require the second-order `blackScholesExtendedGreeks` pass (vs. the basic gamma/delta/vega/theta). */
const EXTENDED_METRICS: ReadonlySet<ExposureMetric> = new Set<ExposureMetric>([
  'vanna',
  'charm',
  'vomma',
  'speed',
  'color',
]);

const needsExtended = (metrics: readonly ExposureMetric[]): boolean =>
  metrics.some((m) => EXTENDED_METRICS.has(m));

/**
 * Market snapshot for `exposure()` — the workspace-canonical {@link MarketInputs}, except `spot` is
 * optional here because it falls back to each quote's `underlyingPrice` when omitted (WS3.2), and
 * `asOf` also accepts the ONE canonical "when" grammar (core `resolveAsOf`): epoch ms, `YYYY-MM-DD`
 * (UTC midnight), or a ZONED ISO datetime — a bare zone-less datetime throws the teaching error.
 */
export type ExposureMarket = Omit<MarketInputs, 'spot' | 'asOf'> & {
  /** Spot price. Falls back to each quote's `underlyingPrice` when omitted. */
  spot?: number;
  /** Snapshot time: epoch ms, `'YYYY-MM-DD'`, or a zoned ISO datetime (core `resolveAsOf` grammar). */
  asOf: EpochMs | string;
};

/** EXACT {@link ExposureMarket} fields (Law 12) — core {@link MarketInputs} with spot optional. */
const EXPOSURE_MARKET_KEYS = ['spot', 'riskFreeRate', 'dividendYield', 'asOf'] as const;

/** Non-market exposure configuration: the sign convention and computation knobs (WS3.2). */
export interface ExposureConfig {
  /** REQUIRED sign convention; echoed in `assumptions.convention` with its caveat in diagnostics. */
  convention: ExposureConvention;
  priceSource?: PriceSource;
  /** `per1PercentMove` (default, the spec GEX formula) or `perPoint`. */
  gammaUnit?: GammaUnit;
  /** Skip contracts with time-to-expiry below this many years (default 0). */
  minTimeToExpiry?: number;
  /** Contract multiplier when a quote omits one (default 100). */
  defaultMultiplier?: number;
}

/** EXACT {@link ExposureConfig} fields (Law 12) — a typo'd knob must teach, never silently default. */
const EXPOSURE_CONFIG_KEYS = [
  'convention',
  'priceSource',
  'gammaUnit',
  'minTimeToExpiry',
  'defaultMultiplier',
] as const;

/** EXACT {@link ScenarioMapOptions} fields (Law 12). */
const SCENARIO_MAP_OPTIONS_KEYS = ['spot', 'volatilityShock', 'timeAdvance', 'metrics'] as const;

/** EXACT `levels()` option fields (Law 12). */
const LEVELS_OPTIONS_KEYS = ['pinRiskBand'] as const;

export interface ContractExposure {
  expiry: string;
  strike: number;
  type: OptionType;
  timeToExpiryYears: number;
  impliedVolatility: number;
  openInterest: number;
  multiplier: number;
  /** Applied position sign (+1/−1) from the convention. */
  sign: number;
  gamma: number;
  delta: number;
  gex: number;
  dex: number;
  vega: number;
  vanna: number;
  charm: number;
  theta: number;
  vomma: number;
  speed: number;
  color: number;
}

export interface ExposureTotals {
  /** Dollar gamma exposure (`Γ·OI·mult·spot²·0.01` per-1%-move, signed by convention). */
  gex: number;
  /** Dollar delta exposure (`Δ·OI·mult·spot`). */
  dex: number;
  /** Vega exposure (`vega/1%·OI·mult`). */
  vega: number;
  /** Vanna exposure: dollar-delta change per +1% vol. */
  vanna: number;
  /**
   * Charm exposure: signed dollar-delta change as ONE calendar day ELAPSES (positive ⇒ dealer delta
   * increases day-over-day). Reported as `−∂DEX/∂T` per day, so its sign matches the passage of time.
   */
  charm: number;
  /** Theta exposure: dollar option-price decay per calendar day. */
  theta: number;
  /** Vomma (volga) exposure: change in vega exposure per +1% vol. */
  vomma: number;
  /**
   * Speed exposure: the CHANGE IN `gex` for a **+1% spot move**, in the same unit as `gex`
   * (`gammaUnit`). It is the full derivative of the GEX definition, not the bare third-order greek:
   * per-1%-move, `Δgex = (speed·S + 2·Γ)·OI·mult·sign·S²·1e-4`; per-point, `(speed·S + Γ)·OI·mult·sign·S·0.01`.
   * So `aggregate.speed ≈ atSpot(spot·1.01).gex − atSpot(spot).gex` (a first-order estimate of it).
   */
  speed: number;
  /**
   * Color exposure: signed change in GEX as ONE calendar day ELAPSES (`−∂GEX/∂T` per day), so a
   * positive value means dealer gamma exposure grows as time passes.
   */
  color: number;
}

/**
 * The call/put GEX + OI split attached to a by-strike row WHEN `'gex'` is requested (WS4.5): the
 * canonical dashboard chart draws `callGex` bars up and `putGex` bars down. `callGex + putGex`
 * equals the row's net `gex`; `callOpenInterest + putOpenInterest` equals the total open interest at that strike.
 */
export type GexSplit = {
  callGex: number;
  putGex: number;
  callOpenInterest: number;
  putOpenInterest: number;
};

/**
 * A by-strike row narrowed to the requested metrics: only the selected `M` keys are present (WS2.4),
 * never a zero-filled full set. `StrikeRow` with no type argument is the full-metrics row. When `M`
 * includes `'gex'` the row additionally carries the {@link GexSplit} call/put columns (WS4.5); when it
 * does not, the conditional intersects with `unknown` (a no-op) so non-gex rows stay lean.
 */
export type StrikeRow<M extends ExposureMetric = ExposureMetric> = { strike: number } & Pick<
  ExposureTotals,
  M
> &
  ('gex' extends M ? GexSplit : unknown);
/** A by-expiry row narrowed to the requested metrics (see {@link StrikeRow}). */
export type ExpiryRow<M extends ExposureMetric = ExposureMetric> = { expiry: string } & Pick<
  ExposureTotals,
  M
>;

export interface Levels {
  /**
   * Spot level where net GEX flips sign, chosen as the interpolated gamma-flip NEAREST spot when the
   * profile has more than one flip in [0.8·spot, 1.2·spot]. Null when no flip exists in range.
   */
  zeroGamma: number | null;
  /** All interpolated gamma-flip levels in [0.8·spot, 1.2·spot], sorted ascending (may be empty). */
  gammaFlips: number[];
  /** Direction at the current spot: `positive` (mean-reverting) or `negative` (trending), or null. */
  gammaRegime: 'positive' | 'negative' | null;
  /**
   * Strike with the largest summed |call GEX| across ALL expiries (resistance). Magnitude, not signed:
   * the wall is where the most call gamma sits, which is the same strike whichever way the convention
   * signs it.
   */
  callWall: number | null;
  /** Strike with the largest summed |put GEX| across ALL expiries, under the convention (support). */
  putWall: number | null;
  maxGammaStrike: number | null;
  minGammaStrike: number | null;
  /**
   * Strike minimizing total in-the-money option value to holders (max writer profit), computed for the
   * NEAREST expiry only — max pain is expiry-specific and cannot be aggregated across expirations.
   */
  maxPain: number | null;
  largestCallOpenInterest: number | null;
  largestPutOpenInterest: number | null;
  vannaWall: number | null;
  charmWall: number | null;
  /** Nearest high-gamma strike to spot, with `atRisk` true when spot is within `pinRiskBand`. */
  pinRisk: { strike: number; atRisk: boolean } | null;
  /**
   * Largest net-|GEX| strike (calls + puts summed per strike) among 0DTE contracts — expiring on the
   * snapshot's own **America/New_York** trading date (not its UTC date: after 20:00 ET the UTC date is
   * already tomorrow, which flagged the NEXT session's expiry as 0DTE).
   */
  zeroDaysToExpiryWall: number | null;
  /** Largest net-|GEX| strike (calls + puts summed per strike) in the nearest Friday (weekly) expiry. */
  weeklyOpexWall: number | null;
  /** Largest net-|GEX| strike (calls + puts summed per strike) in the nearest monthly OPEX (3rd-Friday). */
  monthlyOpexWall: number | null;
}

/** Net dealer-hedging drift estimate (spec §11.5). */
export interface NetDrift {
  /** `positive` (mean-reverting/pinning) or `negative` (trending), or null. */
  gammaRegime: 'positive' | 'negative' | null;
  /** The zero-gamma level (gamma flip) — the attractor in positive gamma, repeller in negative. */
  zeroGamma: number | null;
  /** Signed distance from spot to zero-gamma as a fraction of spot (positive ⇒ flip is above spot). */
  distanceToZeroGamma: number | null;
  /** `pin` (gamma pulls spot toward zero-gamma) / `trend` (pushes away) / null. */
  bias: 'pin' | 'trend' | null;
  /**
   * Aggregate charm exposure: signed dealer delta to re-hedge as ONE calendar day ELAPSES (drift into
   * expiry). Positive ⇒ dealers accumulate long delta day-over-day. Uses the elapsed-time sign
   * (`−∂DEX/∂T` per day), so it reads the same direction as the passage of time.
   */
  charmFlowPerDay: number;
  /**
   * Aggregate vanna exposure: signed dealer delta to re-hedge per +1 VOL POINT (a +0.01 move in
   * implied volatility), matching the per-1%-move convention `gex` uses. The unit is in the name
   * because the value is 100x smaller than a per-unit-volatility reading of the same greek.
   */
  vannaFlowPerVolatilityPoint: number;
}

/** The metrics a `scenarioMap` computes when none are requested. */
export type DefaultScenarioMetric = 'gex' | 'dex' | 'vanna' | 'charm';

export interface ScenarioMapOptions<M extends ExposureMetric = ExposureMetric> {
  /** Spot grid: explicit prices, or `{ from, to, steps }`. Defaults to ±10% around spot, 41 steps. */
  spot?: number[] | { from: number; to: number; steps: number };
  /** Additive vol shocks (decimal), e.g. `[-0.05, 0, 0.05]`. Default `[0]`. */
  volatilityShock?: number[];
  /** Years to advance time (reducing each T), e.g. `[0, 1/365]`. Default `[0]`. */
  timeAdvance?: number[];
  /** Which metrics to compute. Default `['gex','dex','vanna','charm']`. */
  metrics?: readonly M[];
}

/** A scenario-grid cell carrying ONLY the requested metrics (WS2.4), plus its grid coordinates. */
export type ScenarioCell<M extends ExposureMetric = ExposureMetric> = {
  spot: number;
  volatilityShock: number;
  timeAdvance: number;
} & Pick<ExposureTotals, M>;

export interface ScenarioMap<M extends ExposureMetric = ExposureMetric> {
  cells: ScenarioCell<M>[];
  metrics: M[];
  /** Total greek recomputations performed (for the acceleration-need benchmark). */
  evaluations: number;
}

interface Resolved {
  expiry: string;
  strike: number;
  type: OptionType;
  timeToExpiryYears: number;
  impliedVolatility: number;
  oi: number;
  mult: number;
}

function expiryToYears(asOf: EpochMs, expiry: string): number {
  return yearFraction(asOf, expiryMsOf(expiry), 'ACT/365F');
}

/**
 * Parse an expiry label to epoch ms. A date-only `YYYY-MM-DD` resolves to US market close (16:00 ET)
 * — not UTC midnight — so a same-day 0DTE contract isn't dropped as "expired" during the session.
 */
function expiryMsOf(expiry: string): number {
  return optionExpiryToMs(expiry);
}

/** Whether an instant falls on a given market (America/New_York) calendar day index. */
const onMarketDay = (ms: number, dayIndex: number): boolean => marketDayIndex(ms) === dayIndex;

// Weekday / day-of-month are read off the MARKET date too, so all three expiry buckets (0DTE, weekly
// Friday, monthly OPEX) agree on where a day starts — a 16:00-ET expiry is 20:00/21:00 UTC, and an
// expiry quoted as a late-evening ET datetime would otherwise land on the next UTC weekday.
const isFriday = (ms: number): boolean => new Date(marketDateUtcMs(ms)).getUTCDay() === 5;

/** The standard monthly OPEX: a Friday whose day-of-month is 15–21 (the 3rd Friday). */
function isThirdFriday(ms: number): boolean {
  const d = new Date(marketDateUtcMs(ms));
  const dom = d.getUTCDate();
  return d.getUTCDay() === 5 && dom >= 15 && dom <= 21;
}

function resolveSigns(c: ExposureConvention): {
  name: string;
  calls: number;
  puts: number;
  limitation: string;
} {
  if (typeof c === 'object') {
    /**
     * THE DECLARED DOMAIN IS `1 | -1`, AND IT IS CHECKED.
     *
     * `{ calls, puts }` went straight through: `{ calls: 0, puts: 999 }` was accepted and reported a
     * gamma exposure of 0, and `{ calls: 7, puts: -3 }` returned a figure seven times the correct one
     * — converged, unwarned, and echoed back in `assumptions.convention` as though it had been
     * resolved. A sign convention is a choice between two directions; any other number silently
     * rescales every exposure the call returns, which is the worst kind of wrong answer because it
     * looks like an answer.
     *
     * `ensureKnownKeys` guards `config`'s own keys but never descended into this nested object, so
     * `{ calls: 1, puts: -1, extra: 5 }` passed too.
     */
    if (c === null || Array.isArray(c)) {
      throw wrongShapeError(
        'exposure',
        'config.convention to be an object with `calls` and `puts`',
        c,
      );
    }
    ensureKnownKeys('exposure', 'config.convention', c, ['calls', 'puts']);
    for (const side of ['calls', 'puts'] as const) {
      const sign: unknown = c[side];
      if (sign !== 1 && sign !== -1) {
        throw new InputError(
          `exposure: config.convention.${side} must be 1 or -1; got ${String(sign)}. ` +
            `A custom convention chooses a DIRECTION per option type — any other value rescales ` +
            `every exposure in the result.`,
          { code: ErrorCode.InputOutOfRange, context: { [side]: sign } },
        );
      }
    }
    return {
      name: 'custom',
      calls: c.calls,
      puts: c.puts,
      limitation: 'Custom per-type signs supplied by the caller.',
    };
  }
  switch (c) {
    case 'callsPositivePutsNegative':
      return {
        name: c,
        calls: 1,
        puts: -1,
        limitation:
          'Naive net-gamma view (calls +, puts −); does not model who is long vs short the options.',
      };
    case 'dealerShortGamma':
      return {
        name: c,
        calls: -1,
        puts: -1,
        limitation:
          'Assumes dealers are short the customer-held long calls and puts (short gamma both sides); a heuristic, not true dealer books.',
      };
    case 'tradeSignedAggressor':
      return {
        name: c,
        calls: 1,
        puts: -1,
        limitation:
          'Trade-signed positioning requires per-trade aggressor data (use @totalfinance/structure flow); on an open-interest chain it falls back to calls +, puts −.',
      };
    default:
      // The switch is EXHAUSTIVE to the compiler, so a runtime value outside the union fell off
      // the end and returned `undefined` signs — every exposure then computed against a convention
      // that does not exist. A sign convention chooses direction; teach the domain instead.
      throw new InputError(
        `exposure: config.convention must be 'callsPositivePutsNegative' | 'dealerShortGamma' | 'tradeSignedAggressor', or { calls: 1 | -1, puts: 1 | -1 }. Received ${JSON.stringify(c)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'convention', received: c } },
      );
  }
}

/**
 * A computed exposure profile with levels, by-strike/by-expiry views, and scenario maps. R2
 * envelope: the sign convention and every resolved knob live in `assumptions`; model limitations
 * ride `diagnostics.warnings` as `model.limitation` entries — nothing is hoisted top-level.
 */
export class ExposureProfile {
  readonly spot: number;
  /** Frozen result rows — a profile is a snapshot; mutate a copy, never the result. */
  readonly contracts: readonly Readonly<ContractExposure>[];
  readonly aggregate: ExposureTotals;
  readonly assumptions: Assumptions<{
    /** Charm/color are reported per calendar day ELAPSED (`−∂/∂T`), matching the passage of time. */
    timeDecayDirection: 'perCalendarDayElapsed';
    /** Spot-shift scans (zeroGamma, scenarioMap) hold each contract's IV fixed (sticky-strike). */
    scanVolatilityPolicy: 'stickyStrike';
    /** The resolved sign convention (echoed; its caveat rides `diagnostics.warnings`). */
    convention: { name: string; calls: number; puts: number };
    /** GEX unit: `per1PercentMove` (spec formula) or `perPoint`. */
    gammaUnit: GammaUnit;
    /** Quote price used for the IV fallback when a quote has no usable `impliedVolatility`. */
    priceSource: PriceSource;
    /** Contracts with time-to-expiry (years) at/below this were skipped. */
    minTimeToExpiry: number;
    /** Contract multiplier applied when a quote omits one. */
    defaultMultiplier: number;
  }>;
  readonly diagnostics: Diagnostics;
  private readonly resolved: Resolved[];
  /** Resolved per-type position signs (also echoed in `assumptions.convention`). */
  private readonly signs: { name: string; calls: number; puts: number };
  private readonly r: number;
  private readonly q: number;
  private readonly gammaUnit: GammaUnit;
  private readonly asOf: EpochMs;
  /** The snapshot's America/New_York trading-DAY index — the 0DTE bucket's day boundary. */
  private readonly asOfDayIndex: number;

  constructor(request: ExposureInput) {
    requireArgumentObject('exposure', 'request', request);
    ensureKnownKeys('exposure', 'request', request, ['quotes', 'market', 'config']);
    const { quotes, market, config } = request;
    requireArgumentArray('exposure', 'quotes', quotes);
    requireArgumentObject('exposure', 'market', market);
    requireArgumentObject('exposure', 'config', config);
    // Law 12: market and config reject unknown keys — a typo'd knob (`gamaUnit`, `divYield`) must
    // teach with a did-you-mean, never silently fall back to a default.
    ensureKnownKeys('exposure', 'market', market, EXPOSURE_MARKET_KEYS);
    ensureKnownKeys('exposure', 'config', config, EXPOSURE_CONFIG_KEYS);
    if (config.convention === undefined) {
      throw new InputError('exposure: a sign convention is required (results echo it).', {
        code: ErrorCode.InputMissingField,
        context: { field: 'convention' },
      });
    }
    ensureFinite(market.riskFreeRate, 'riskFreeRate', 'exposure');
    // One grammar for "when" (core resolveAsOf): epoch ms, 'YYYY-MM-DD', or a ZONED ISO datetime.
    // A numeric asOf passes through resolveAsOf untouched, so NaN still needs the finite guard.
    this.asOf = resolveValuationAsOf(market.asOf, 'exposure');
    ensureFinite(this.asOf, 'asOf', 'exposure');
    // Day BOUNDARY for the 0DTE bucket: the ET trading date of the snapshot — taken literally when
    // the caller named a date (`'2026-06-19'`), since that is a date, not an instant to re-zone.
    this.asOfDayIndex = asOfMarketDayIndex(market.asOf, this.asOf);
    this.r = market.riskFreeRate;
    // Null is a wrong-typed value, not omission (the 350c2796 ruling): `?? 0` used to launder a
    // null dividendYield into a dividend-free book BEFORE the finite check ran on the default.
    ensureFiniteWhenPresent(market.dividendYield, 'dividendYield', 'exposure');
    this.q = market.dividendYield ?? 0;
    if (
      config.gammaUnit !== undefined &&
      config.gammaUnit !== 'per1PercentMove' &&
      config.gammaUnit !== 'perPoint'
    ) {
      throw new InputError(
        `ExposureProfile: gammaUnit must be 'per1PercentMove' | 'perPoint' when provided. Received ${config.gammaUnit === null ? 'null' : JSON.stringify(config.gammaUnit)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'gammaUnit' } },
      );
    }
    if (
      config.defaultMultiplier !== undefined &&
      (typeof config.defaultMultiplier !== 'number' || !Number.isFinite(config.defaultMultiplier))
    ) {
      throw new InputError(
        `ExposureProfile: defaultMultiplier must be a finite number when provided. Received ${config.defaultMultiplier === null ? 'null' : typeof config.defaultMultiplier}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'defaultMultiplier' } },
      );
    }
    if (
      config.priceSource !== undefined &&
      config.priceSource !== 'bid' &&
      config.priceSource !== 'ask' &&
      config.priceSource !== 'mid' &&
      config.priceSource !== 'last' &&
      config.priceSource !== 'mark'
    ) {
      throw new InputError(
        `exposure: priceSource must be 'bid' | 'ask' | 'mid' | 'last' | 'mark' when provided. Received ${config.priceSource === null ? 'null' : JSON.stringify(config.priceSource)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'priceSource' } },
      );
    }
    ensureFiniteWhenPresent(config.minTimeToExpiry, 'minTimeToExpiry', 'exposure');
    // `spot: null` used to fall through `??` into the quote-derived fallback — the caller believed
    // THEIR spot anchored the surface while a quote's underlyingPrice silently did.
    ensureFiniteWhenPresent(market.spot, 'spot', 'exposure');
    this.gammaUnit = config.gammaUnit ?? 'per1PercentMove';
    const source: PriceSource = config.priceSource ?? 'mid';
    const minT = config.minTimeToExpiry ?? 0;
    const defMult = config.defaultMultiplier ?? 100;
    const signs = resolveSigns(config.convention);
    const warnings: QuantWarning[] = [];

    const spot =
      market.spot ?? quotes.find((qq) => qq.underlyingPrice !== undefined)?.underlyingPrice;
    if (spot === undefined) {
      throw new InputError(
        'exposure: spot is required (pass market.spot or quotes with underlyingPrice).',
        {
          code: ErrorCode.InputMissingField,
          context: { field: 'spot' },
        },
      );
    }
    // `spot > 0` alone lets Infinity through (Infinity > 0 is true), which would silently poison every
    // exposure with ∞/NaN under converged:true — require a FINITE positive spot.
    if (!(spot > 0) || !Number.isFinite(spot)) {
      throw new InputError(`exposure: spot must be a finite positive number, got ${spot}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { spot },
      });
    }
    this.spot = spot;

    const resolved: Resolved[] = [];
    let skipped = 0;
    for (let i = 0; i < quotes.length; i++) {
      const quote = quotes[i]!;
      // Element-level shape guard: a null/primitive element or a missing `contract` must teach the
      // expected quote shape (with its index), never escape as a raw TypeError (first-touch law).
      if (quote === null || typeof quote !== 'object') {
        throw wrongShapeError(
          'exposure',
          `quotes[${i}] to be an option quote { contract: { underlying, expiry, strike, type }, openInterest, impliedVolatility | bid/ask, … }`,
          quote,
        );
      }
      if (quote.contract === null || typeof quote.contract !== 'object') {
        throw wrongShapeError(
          'exposure',
          `quotes[${i}].contract to be { underlying, expiry, strike, type }`,
          quote,
        );
      }
      const { strike, type, expiry, multiplier } = quote.contract;
      const T = expiryToYears(this.asOf, expiry);
      const oi = quote.openInterest ?? 0;
      const mult = multiplier ?? defMult;
      // Skip rows that cannot produce a finite exposure (no/invalid OI, non-finite multiplier,
      // expired, or non-positive strike) — they are counted in `skipped` and warned, never allowed
      // to poison the aggregate with NaN/∞ under `converged: true`.
      if (
        !(T > minT) ||
        !(strike > 0) ||
        !(oi > 0) ||
        !Number.isFinite(oi) ||
        !(mult > 0) ||
        !Number.isFinite(mult)
      ) {
        skipped++;
        continue;
      }
      let volatility: number | undefined;
      // `> 0` alone admits Infinity; require a FINITE positive IV or fall through to the price-implied
      // path (and, failing that, the skipped+warned bucket) rather than pricing off ∞ vol.
      if (
        quote.impliedVolatility !== undefined &&
        quote.impliedVolatility > 0 &&
        Number.isFinite(quote.impliedVolatility)
      )
        volatility = quote.impliedVolatility;
      else {
        const price = selectQuotePrice(quote, source);
        if (price !== undefined && price > 0) {
          const res = impliedVolatility({
            price,
            spot,
            strike,
            timeToExpiryYears: T,
            riskFreeRate: this.r,
            type,
            dividendYield: this.q,
          });
          if (res.diagnostics.converged && res.value !== null && res.value > 0)
            volatility = res.value;
        }
      }
      if (volatility === undefined) {
        skipped++;
        continue;
      }
      resolved.push({
        expiry,
        strike,
        type,
        timeToExpiryYears: T,
        impliedVolatility: volatility,
        oi,
        mult,
      });
    }
    if (skipped > 0) {
      warnings.push({
        code: WarningCode.StructureContractsSkipped,
        message: `${skipped} contract(s) skipped (no open interest, expired, or IV unavailable).`,
        severity: 'info',
        context: { skipped },
      });
    }
    if (config.convention === 'tradeSignedAggressor') {
      warnings.push({
        code: WarningCode.StructureAggressorUnavailable,
        message:
          'tradeSignedAggressor convention used on an OI chain; fell back to calls +, puts −.',
        severity: 'warn',
      });
    }
    this.resolved = resolved;

    // The base profile must carry every metric (byStrike/byExpiry default to all), so compute the
    // extended greeks here; only the scenario map (which knows its requested metrics up front) gates.
    // Freeze the result rows: a caller who edits a "result" in place would silently diverge from
    // `assumptions`/`diagnostics` — same law as Position.legs (dx §4.4).
    this.contracts = Object.freeze(
      resolved.map((c) =>
        Object.freeze(
          this.exposureFor({
            contract: c,
            spot,
            impliedVolatility: c.impliedVolatility,
            timeToExpiryYears: c.timeToExpiryYears,
            callSign: signs.calls,
            putSign: signs.puts,
            computeExtended: true,
          }),
        ),
      ),
    );
    // Frozen like `contracts`: the aggregate is a SNAPSHOT of those frozen rows, so a caller who
    // "adjusted" `aggregate.gex` in place would hold totals that no longer sum their own contracts
    // while `assumptions`/`diagnostics` still described the original (dx §4.4).
    this.aggregate = Object.freeze(sumTotals(this.contracts));
    this.signs = { name: signs.name, calls: signs.calls, puts: signs.puts };
    // Model limitations are structured warnings (R2 / WS-2.6): `model.limitation`, severity info —
    // never a hoisted top-level field.
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        'Positioning is estimated from open interest and a sign convention, not true dealer books.',
        'info',
      ),
      warning(WarningCode.ModelLimitation, signs.limitation, 'info'),
    );
    // Frozen (nested convention included): `assumptions` is the record of HOW this profile was
    // computed. Editing it — `assumptions.gammaUnit = 'perPoint'` — changed nothing about the numbers
    // and left a result that misdescribes itself; the freeze makes that a TypeError, not a silent lie.
    this.assumptions = Object.freeze({
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      asOf: this.asOf,
      model: 'bsm',
      engine: 'structure-exposure',
      timeDecayDirection: 'perCalendarDayElapsed',
      scanVolatilityPolicy: 'stickyStrike',
      // Echoed as a COPY: editing the echo must not silently re-sign the internal computations.
      convention: Object.freeze({ ...this.signs }),
      gammaUnit: this.gammaUnit,
      priceSource: source,
      minTimeToExpiry: minT,
      defaultMultiplier: defMult,
    });
    this.diagnostics = {
      engine: 'structure-exposure',
      method: `gex:${this.gammaUnit}`,
      converged: true,
      warnings,
    };
  }

  /**
   * Per-contract exposure at a given spot/iv/t (used for the base profile and scenario maps). The
   * second-order (`blackScholesExtendedGreeks`) pass — vanna/charm/vomma/speed/color — is computed only when
   * `computeExtended` is set; a gex/dex-only scenario map skips it entirely (WS2.4), which roughly
   * halves its work. When skipped, those five fields are 0 and MUST NOT be read (callers gate on the
   * requested-metric set so they never are).
   */
  private exposureFor(input: {
    contract: Resolved;
    spot: number;
    impliedVolatility: number;
    timeToExpiryYears: number;
    callSign: number;
    putSign: number;
    computeExtended: boolean;
  }): ContractExposure {
    const {
      contract: c,
      spot: S,
      impliedVolatility,
      timeToExpiryYears: T,
      callSign,
      putSign,
      computeExtended,
    } = input;
    const g = blackScholesGreeks({
      type: c.type,
      spot: S,
      strike: c.strike,
      timeToExpiryYears: T,
      riskFreeRate: this.r,
      dividendYield: this.q,
      volatility: impliedVolatility,
    });
    const sign = c.type === 'call' ? callSign : putSign;
    const w = c.oi * c.mult * sign;
    const gex = this.gammaUnit === 'per1PercentMove' ? g.gamma * w * S * S * 0.01 : g.gamma * w * S; // dollar-delta change per 1-point move

    let vanna = 0;
    let charm = 0;
    let vomma = 0;
    let speed = 0;
    let color = 0;
    if (computeExtended) {
      const x = blackScholesExtendedGreeks({
        type: c.type,
        spot: S,
        strike: c.strike,
        timeToExpiryYears: T,
        riskFreeRate: this.r,
        dividendYield: this.q,
        volatility: impliedVolatility,
      });
      vanna = x.vanna * w * S * 0.01; // dollar-delta per 1% vol
      // charm/color come from the pricer as ∂/∂T (per added year of time-to-expiry). Negate so the
      // exposure is per calendar day ELAPSED (T falls as a day passes), matching the passage of time.
      charm = -(x.charm * w * S) / 365; // dollar-delta change per calendar day elapsed
      vomma = x.vomma * w * 0.0001; // Δ(vega exposure) per +1% vol (vega per-1%; vomma ∂²V/∂σ²)
      // speed exposure = the CHANGE IN GEX for a +1% spot move, in this profile's own gammaUnit —
      // so it composes with `gex` instead of being a raw third-order greek in nobody's units. Both
      // terms of the derivative are required: GEX = Γ·w·S²·0.01 depends on spot through Γ AND
      // through S², so d(GEX)/dS = w·0.01·(Γ'·S² + 2Γ·S); times ΔS = 0.01·S. Dropping the 2Γ·S term
      // (the old `Γ'·w·S³·0.01`) left a number that matched no convention and was 32–100× off the
      // finite difference of the profile's own GEX.
      const spotStep = S * 0.01;
      speed =
        this.gammaUnit === 'per1PercentMove'
          ? (x.speed * S + 2 * g.gamma) * w * S * 0.01 * spotStep
          : (x.speed * S + g.gamma) * w * spotStep; // d/dS[Γ·w·S]·ΔS
      color = -(x.color * w * S * S * 0.01) / 365; // change in GEX per calendar day elapsed
    }
    return {
      expiry: c.expiry,
      strike: c.strike,
      type: c.type,
      timeToExpiryYears: T,
      impliedVolatility,
      openInterest: c.oi,
      multiplier: c.mult,
      sign,
      gamma: g.gamma,
      delta: g.delta,
      gex,
      dex: g.delta * w * S, // dollar delta
      vega: g.vega * w, // vega is per 1% already
      vanna,
      charm,
      theta: g.theta * w, // dollar option-price decay per day (theta is per-day)
      vomma,
      speed,
      color,
    };
  }

  /**
   * Per-tick fast path: re-evaluate NET dollar-gamma (`gex`) and NET dollar-delta (`dex`) exposure at
   * a new `spot`, holding each contract's IV, time-to-expiry, and open interest FIXED (sticky-strike,
   * echoed in `assumptions.scanVolatilityPolicy`) — only spot moves and gamma/delta are re-evaluated. This is
   * the intraday dashboard path (one cheap greek pass per tick); a full {@link exposure} re-run — which
   * re-derives IV, the extended greeks, and levels — is the per-refresh path. At the profile's original
   * spot this reproduces `aggregate.gex`/`aggregate.dex` exactly (same operations, same order).
   */
  atSpot(spot: number): { gex: number; dex: number } {
    // The per-tick path takes a LIVE price straight off a feed, so it is exactly where a NaN/0/−50
    // print arrives. Unguarded, `blackScholesGreeks` turns it into a NaN gamma and the dashboard
    // renders a NaN (or a mirror-image negative-spot) exposure with nothing saying so.
    if (!(spot > 0) || !Number.isFinite(spot)) {
      throw new InputError(
        `ExposureProfile.atSpot: spot must be a finite positive number, got ${spot}.`,
        { code: ErrorCode.InputNegativeSpot, context: { spot } },
      );
    }
    return this.netExposureAtSpot(spot);
  }

  /**
   * Single-pass net GEX + DEX at spot `S` under sticky-strike (IV/T/OI held fixed; gamma/delta
   * re-evaluated). Backs both {@link atSpot} and {@link netGexAtSpot}: `blackScholesGreeks` returns gamma AND
   * delta from one pass, so the DEX is a free ride on the gamma re-evaluation already needed for GEX.
   */
  private netExposureAtSpot(S: number): { gex: number; dex: number } {
    const { calls, puts } = this.signs;
    let gex = 0;
    let dex = 0;
    for (const c of this.resolved) {
      const g = blackScholesGreeks({
        type: c.type,
        spot: S,
        strike: c.strike,
        timeToExpiryYears: c.timeToExpiryYears,
        riskFreeRate: this.r,
        dividendYield: this.q,
        volatility: c.impliedVolatility,
      });
      const sign = c.type === 'call' ? calls : puts;
      const w = c.oi * c.mult * sign;
      gex += this.gammaUnit === 'per1PercentMove' ? g.gamma * w * S * S * 0.01 : g.gamma * w * S;
      dex += g.delta * w * S; // dollar delta (Δ·OI·mult·spot, signed by convention)
    }
    return { gex, dex };
  }

  /** Net signed GEX recomputed with spot shifted to `S` (gamma re-evaluated; IV/T/OI fixed). */
  private netGexAtSpot(S: number): number {
    return this.netExposureAtSpot(S).gex;
  }

  /**
   * Chart-ready by-strike profile (one row per strike, totals summed), narrowed to `metrics`. When
   * `'gex'` is requested each row ALSO carries the call/put split — `callGex`/`putGex`/`callOpenInterest`/`putOpenInterest`
   * (the {@link GexSplit} columns) — for the canonical dashboard chart (call bars up, put bars down).
   * `callGex + putGex` equals the row's net `gex` and `callOpenInterest + putOpenInterest` the strike's total OI (WS4.5).
   */
  byStrike<M extends ExposureMetric = ExposureMetric>(
    metrics: readonly M[] = [...ALL_METRICS] as M[],
  ): StrikeRow<M>[] {
    const byK = new Map<number, ContractExposure[]>();
    for (const c of this.contracts) {
      const arr = byK.get(c.strike);
      if (arr) arr.push(c);
      else byK.set(c.strike, [c]);
    }
    const wantGexSplit = (metrics as readonly ExposureMetric[]).includes('gex');
    return [...byK.keys()]
      .sort((a, b) => a - b)
      .map((strike) => {
        const rows = byK.get(strike)!;
        const base = { strike, ...pickTotals(sumTotals(rows), metrics) };
        // The split columns appear ONLY when 'gex' is requested (mirrors the Pick<> narrowing), so a
        // non-gex row stays lean and the runtime shape matches the conditional StrikeRow<M> type.
        return (wantGexSplit ? { ...base, ...splitGexOi(rows) } : base) as StrikeRow<M>;
      });
  }

  /** Chart-ready by-expiry profile (one row per expiry), narrowed to `metrics`. */
  byExpiry<M extends ExposureMetric = ExposureMetric>(
    metrics: readonly M[] = [...ALL_METRICS] as M[],
  ): ExpiryRow<M>[] {
    const byE = new Map<string, ContractExposure[]>();
    for (const c of this.contracts) {
      const arr = byE.get(c.expiry);
      if (arr) arr.push(c);
      else byE.set(c.expiry, [c]);
    }
    return [...byE.keys()]
      .sort()
      .map((expiry) => ({ expiry, ...pickTotals(sumTotals(byE.get(expiry)!), metrics) }));
  }

  /** Dealer-positioning levels (walls, zero-gamma, max pain, pin risk). */
  levels(options: { pinRiskBand?: number } = {}): Levels {
    // Law 12 at every knob-bearing entry: `pinRiskBnd: 0.01` must teach, not silently fall back to
    // the 0.5% default and report a different pin-risk flag than the caller asked for.
    requireArgumentObject('exposure.levels', 'options', options);
    ensureKnownKeys('exposure.levels', 'options', options, LEVELS_OPTIONS_KEYS);
    if (options.pinRiskBand !== undefined) {
      ensureFinite(options.pinRiskBand, 'pinRiskBand', 'exposure.levels');
    }
    const rows = this.byStrike([...ALL_METRICS]);
    if (rows.length === 0) {
      return {
        zeroGamma: null,
        gammaFlips: [],
        gammaRegime: null,
        callWall: null,
        putWall: null,
        maxGammaStrike: null,
        minGammaStrike: null,
        maxPain: null,
        largestCallOpenInterest: null,
        largestPutOpenInterest: null,
        vannaWall: null,
        charmWall: null,
        pinRisk: null,
        zeroDaysToExpiryWall: null,
        weeklyOpexWall: null,
        monthlyOpexWall: null,
      };
    }
    const pinBand = options.pinRiskBand ?? 0.005;

    // Call/put walls: aggregate the SIGNED per-contract GEX per strike across ALL expiries, per side,
    // so a strike whose OI is split over several expiries isn't beaten by one fat single-expiry
    // contract. callWall = strike with the largest summed call GEX; putWall = largest summed |put GEX|.
    // Largest-OI strikes aggregate the same way (per strike, not per contract).
    const callGexByStrike = new Map<number, number>();
    const putGexByStrike = new Map<number, number>();
    const callOpenInterest = new Map<number, number>();
    const putOpenInterest = new Map<number, number>();
    for (const c of this.contracts) {
      if (c.type === 'call') {
        callGexByStrike.set(c.strike, (callGexByStrike.get(c.strike) ?? 0) + c.gex);
        callOpenInterest.set(c.strike, (callOpenInterest.get(c.strike) ?? 0) + c.openInterest);
      } else {
        putGexByStrike.set(c.strike, (putGexByStrike.get(c.strike) ?? 0) + c.gex);
        putOpenInterest.set(c.strike, (putOpenInterest.get(c.strike) ?? 0) + c.openInterest);
      }
    }
    let callWall: number | null = null;
    let putWall: number | null = null;
    let callBest = -Infinity;
    let putBest = -Infinity;
    for (const [k, g] of callGexByStrike) {
      // MAGNITUDE, like putWall. A wall is "where the most dealer gamma sits", which is a size, not a
      // signed quantity: under a dealer-negative convention (`dealerShortGamma`, or any custom
      // `{ calls: -1 }`) every call GEX is ≤ 0, so a signed max returned the LEAST-exposed strike —
      // a 10-lot beat a 10,000-lot and the dashboard drew resistance at the emptiest strike.
      if (Math.abs(g) > callBest) {
        callBest = Math.abs(g);
        callWall = k;
      }
    }
    for (const [k, g] of putGexByStrike) {
      if (Math.abs(g) > putBest) {
        putBest = Math.abs(g);
        putWall = k;
      }
    }
    let largestCallOpenInterest: number | null = null;
    let largestPutOpenInterest: number | null = null;
    let callOpenInterestBest = -Infinity;
    let putOpenInterestBest = -Infinity;
    for (const [k, oi] of callOpenInterest) {
      if (oi > callOpenInterestBest) {
        callOpenInterestBest = oi;
        largestCallOpenInterest = k;
      }
    }
    for (const [k, oi] of putOpenInterest) {
      if (oi > putOpenInterestBest) {
        putOpenInterestBest = oi;
        largestPutOpenInterest = k;
      }
    }

    const maxGammaStrike = rows.reduce((b, r) => (r.gex > b.gex ? r : b)).strike;
    const minGammaStrike = rows.reduce((b, r) => (r.gex < b.gex ? r : b)).strike;
    const vannaWall = rows.reduce((b, r) => (Math.abs(r.vanna) > Math.abs(b.vanna) ? r : b)).strike;
    const charmWall = rows.reduce((b, r) => (Math.abs(r.charm) > Math.abs(b.charm) ? r : b)).strike;

    return {
      ...this.gammaProfileLevels(),
      callWall,
      putWall,
      maxGammaStrike,
      minGammaStrike,
      maxPain: this.maxPain(),
      largestCallOpenInterest,
      largestPutOpenInterest,
      vannaWall,
      charmWall,
      pinRisk: this.pinRisk(pinBand),
      zeroDaysToExpiryWall: this.opexWall((ms) => onMarketDay(ms, this.asOfDayIndex)),
      weeklyOpexWall: this.opexWall((ms) => ms >= this.asOf && isFriday(ms)),
      monthlyOpexWall: this.opexWall((ms) => ms >= this.asOf && isThirdFriday(ms)),
    };
  }

  /**
   * The strike with the largest net gamma wall within `bucket`'s soonest matching expiry: signed GEX
   * (calls + puts) is summed PER STRIKE across that expiry and the max-|sum| strike wins. "weekly" is
   * the nearest Friday and "monthly" the nearest 3rd-Friday OPEX.
   */
  private opexWall(bucket: (expiryMs: number) => boolean): number | null {
    let soonest: string | null = null;
    let soonestT = Infinity;
    for (const c of this.resolved) {
      if (c.timeToExpiryYears < soonestT && bucket(expiryMsOf(c.expiry))) {
        soonestT = c.timeToExpiryYears;
        soonest = c.expiry;
      }
    }
    if (soonest === null) return null;
    const gexByStrike = new Map<number, number>();
    for (const c of this.contracts) {
      if (c.expiry !== soonest) continue;
      gexByStrike.set(c.strike, (gexByStrike.get(c.strike) ?? 0) + c.gex);
    }
    let wall: number | null = null;
    let best = -Infinity;
    for (const [k, g] of gexByStrike) {
      if (Math.abs(g) > best) {
        best = Math.abs(g);
        wall = k;
      }
    }
    return wall;
  }

  /**
   * Net dealer-hedging drift estimate (spec §11.5): the gamma regime (pinning vs trending), the
   * zero-gamma attractor, and the aggregate charm/vanna hedging flows that push spot over time and as
   * vol moves. An ESTIMATE from the positioning model — not a price forecast. An empty or
   * identically-zero book has no gamma structure: `zeroGamma`/`distanceToZeroGamma`/`gammaRegime`/
   * `bias` are all `null` (never fabricated), and the charm/vanna flows echo the (zero) aggregate.
   */
  netDrift(): NetDrift {
    const { zeroGamma, gammaRegime } = this.gammaProfileLevels();
    const distanceToZeroGamma = zeroGamma === null ? null : (zeroGamma - this.spot) / this.spot;
    const bias = gammaRegime === 'positive' ? 'pin' : gammaRegime === 'negative' ? 'trend' : null;
    return {
      gammaRegime,
      zeroGamma,
      distanceToZeroGamma,
      bias,
      charmFlowPerDay: this.aggregate.charm,
      vannaFlowPerVolatilityPoint: this.aggregate.vanna,
    };
  }

  /**
   * Zero-gamma (gamma flip) by scanning net GEX across the [0.8·spot, 1.2·spot] grid. Collects ALL
   * sign-change roots (books can have several); `zeroGamma` is the one NEAREST spot, `gammaFlips` is
   * the full sorted list. IV is held fixed per contract during the scan (sticky-strike, echoed in
   * `assumptions.scanVolatilityPolicy`).
   *
   * Honesty guards (review finding): an EMPTY resolved book, or a profile that is identically zero
   * across the whole scan, has no gamma structure — return nulls rather than fabricate a "flip" at
   * every grid point (netGEX ≡ 0 made the old `prevG === 0` branch push all 81 of them, and an empty
   * book reported `zeroGamma: spot`). A RUN of consecutive exact-zero grid points collapses to at
   * most one flip (the run's first point).
   */
  private gammaProfileLevels(): Pick<Levels, 'zeroGamma' | 'gammaFlips' | 'gammaRegime'> {
    if (this.resolved.length === 0) return { zeroGamma: null, gammaFlips: [], gammaRegime: null };
    const lo = this.spot * 0.8;
    const hi = this.spot * 1.2;
    const steps = 80;
    const grid: number[] = [];
    const net: number[] = [];
    let allZero = true;
    for (let i = 0; i <= steps; i++) {
      const S = lo + ((hi - lo) * i) / steps;
      const g = this.netGexAtSpot(S);
      grid.push(S);
      net.push(g);
      if (g !== 0) allZero = false;
    }
    if (allZero) return { zeroGamma: null, gammaFlips: [], gammaRegime: null };
    const flips: number[] = [];
    let inZeroRun = false;
    for (let i = 0; i < net.length; i++) {
      const g = net[i]!;
      if (g === 0) {
        if (!inZeroRun) flips.push(grid[i]!); // consecutive exact zeros collapse to ONE flip
        inZeroRun = true;
      } else {
        // Strict sign change between adjacent non-zero points ⇒ interpolate the linear root. A
        // change ACROSS a zero run needs no extra root: the run itself already contributed one.
        if (i > 0 && !inZeroRun && net[i - 1]! * g < 0) {
          const S0 = grid[i - 1]!;
          const g0 = net[i - 1]!;
          flips.push(S0 + ((grid[i]! - S0) * (0 - g0)) / (g - g0));
        }
        inZeroRun = false;
      }
    }
    const gammaFlips = [...flips].sort((a, b) => a - b);
    const zeroGamma = gammaFlips.length
      ? gammaFlips.reduce((best, f) =>
          Math.abs(f - this.spot) < Math.abs(best - this.spot) ? f : best,
        )
      : null;
    const here = this.netGexAtSpot(this.spot);
    const gammaRegime = here > 0 ? 'positive' : here < 0 ? 'negative' : null;
    return { zeroGamma, gammaFlips, gammaRegime };
  }

  /**
   * Max-pain strike for the NEAREST expiry — the strike that minimizes total in-the-money value paid
   * out to holders (max writer profit). Max pain is EXPIRY-SPECIFIC: settlement only nets contracts of
   * the SAME expiration, so summing intrinsic value across unrelated expiries produces a meaningless
   * number. We scope it to the soonest expiry present, mirroring the expiry-scoped OPEX walls.
   */
  private maxPain(): number | null {
    if (this.contracts.length === 0) return null;
    const nearestExpiry = this.contracts.reduce((best, c) =>
      expiryMsOf(c.expiry) < expiryMsOf(best.expiry) ? c : best,
    ).expiry;
    const cohort = this.contracts.filter((c) => c.expiry === nearestExpiry);
    const strikes = [...new Set(cohort.map((c) => c.strike))].sort((a, b) => a - b);
    if (strikes.length === 0) return null;
    let best: number | null = null;
    let bestPain = Infinity;
    for (const S of strikes) {
      let pain = 0;
      for (const c of cohort) {
        const intrinsic = c.type === 'call' ? Math.max(S - c.strike, 0) : Math.max(c.strike - S, 0);
        pain += intrinsic * c.openInterest * c.multiplier;
      }
      if (pain < bestPain) {
        bestPain = pain;
        best = S;
      }
    }
    return best;
  }

  /** Pin risk: nearest high-gamma·OI strike to spot, flagged when spot is within `band` of it. */
  private pinRisk(band: number): { strike: number; atRisk: boolean } | null {
    let best: number | null = null;
    let bestScore = -Infinity;
    for (const c of this.contracts) {
      // Weight gamma·OI by proximity to spot (closer strikes pin harder).
      const proximity = 1 / (1 + Math.abs(c.strike - this.spot) / this.spot);
      const score = Math.abs(c.gamma) * c.openInterest * c.multiplier * proximity;
      if (score > bestScore) {
        bestScore = score;
        best = c.strike;
      }
    }
    if (best === null) return null;
    return { strike: best, atRisk: Math.abs(best - this.spot) / this.spot <= band };
  }

  /**
   * Recompute aggregate metrics across a spot × volatilityShock × time grid. With no `metrics` the default
   * set is `['gex','dex','vanna','charm']` — and the return type narrows to exactly those, so it never
   * over-claims the metrics not actually computed (WS2.4).
   */
  scenarioMap<M extends ExposureMetric = DefaultScenarioMetric>(
    options: ScenarioMapOptions<M> = {},
  ): ScenarioMap<M> {
    // Law 12: a misspelled axis (`volatilityShocks`, `spots`, `metric`) silently produced the DEFAULT
    // grid — one cell at the current spot — and the caller charted it as their scenario surface.
    requireArgumentObject('exposure.scenarioMap', 'options', options);
    ensureKnownKeys('exposure.scenarioMap', 'options', options, SCENARIO_MAP_OPTIONS_KEYS);
    const metrics = (options.metrics ?? (['gex', 'dex', 'vanna', 'charm'] as M[])) as readonly M[];
    const volatilityShocks = options.volatilityShock ?? [0];
    const timeAdvances = options.timeAdvance ?? [0];
    // A non-finite grid entry would silently poison every cell it touches with NaN under converged:true.
    volatilityShocks.forEach((v, i) =>
      ensureFinite(v, `scenarioMap.volatilityShock[${i}]`, 'exposure.scenarioMap'),
    );
    timeAdvances.forEach((t, i) =>
      ensureFinite(t, `scenarioMap.timeAdvance[${i}]`, 'exposure.scenarioMap'),
    );
    const spots = resolveSpotGrid(options.spot, this.spot);
    const signs = { calls: this.signs.calls, puts: this.signs.puts };
    // Skip the second-order greek pass entirely when no requested metric needs it (WS2.4).
    const wantExtended = needsExtended(metrics);

    const cells: Array<ScenarioCell<M>> = [];
    let evaluations = 0;
    for (const S of spots) {
      for (const dv of volatilityShocks) {
        for (const timeStepYears of timeAdvances) {
          const totals = emptyTotals();
          for (const c of this.resolved) {
            const T = c.timeToExpiryYears - timeStepYears;
            if (!(T > 0)) continue;
            const impliedVolatility = Math.max(1e-4, c.impliedVolatility + dv);
            const e = this.exposureFor({
              contract: c,
              spot: S,
              impliedVolatility,
              timeToExpiryYears: T,
              callSign: signs.calls,
              putSign: signs.puts,
              computeExtended: wantExtended,
            });
            for (const m of ALL_METRICS) totals[m] += e[m];
            evaluations++;
          }
          cells.push({
            spot: S,
            volatilityShock: dv,
            timeAdvance: timeStepYears,
            ...pickTotals(totals, metrics),
          });
        }
      }
    }
    return { cells, metrics: [...metrics], evaluations };
  }
}

function emptyTotals(): ExposureTotals {
  return { gex: 0, dex: 0, vega: 0, vanna: 0, charm: 0, theta: 0, vomma: 0, speed: 0, color: 0 };
}

function sumTotals(rows: ReadonlyArray<Pick<ContractExposure, ExposureMetric>>): ExposureTotals {
  const t = emptyTotals();
  for (const r of rows) for (const m of ALL_METRICS) t[m] += r[m];
  return t;
}

/**
 * Sum the SIGNED per-contract GEX and the open interest at one strike, split by option type (WS4.5).
 * Mirrors the call/put wall aggregation in `levels()`; `callGex + putGex` equals the strike's net GEX
 * and `callOpenInterest + putOpenInterest` its total open interest.
 */
function splitGexOi(rows: readonly ContractExposure[]): GexSplit {
  let callGex = 0;
  let putGex = 0;
  let callOpenInterest = 0;
  let putOpenInterest = 0;
  for (const r of rows) {
    if (r.type === 'call') {
      callGex += r.gex;
      callOpenInterest += r.openInterest;
    } else {
      putGex += r.gex;
      putOpenInterest += r.openInterest;
    }
  }
  return { callGex, putGex, callOpenInterest, putOpenInterest };
}

function pickTotals<M extends ExposureMetric>(
  t: ExposureTotals,
  metrics: readonly M[],
): Pick<ExposureTotals, M> {
  const out = {} as Pick<ExposureTotals, M>;
  // Only the requested keys are present — unrequested metrics are ABSENT, not zero-filled (WS2.4),
  // so a serialized row never claims a metric was computed (and read as 0) when it wasn't.
  for (const m of metrics) out[m] = t[m];
  return out;
}

function resolveSpotGrid(
  specification: number[] | { from: number; to: number; steps: number } | undefined,
  spot: number,
): number[] {
  const functionName = 'exposure.scenarioMap';
  if (Array.isArray(specification)) {
    specification.forEach((s, i) => {
      if (!Number.isFinite(s) || s <= 0) {
        throw new InputError(
          `${functionName}: spot grid entry ${i} must be a finite positive number, got ${s}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: i, value: s },
          },
        );
      }
    });
    return specification;
  }
  const g = specification ?? { from: spot * 0.9, to: spot * 1.1, steps: 41 };
  if (!Number.isFinite(g.from) || g.from <= 0 || !Number.isFinite(g.to) || g.to <= 0) {
    throw new InputError(
      `${functionName}: spot grid from/to must be finite positive numbers, got from=${g.from}, to=${g.to}.`,
      { code: ErrorCode.InputOutOfRange, context: { from: g.from, to: g.to } },
    );
  }
  // isSafeInteger for uniformity (2026-08-23 review, P0) — the ≤ 10,000 cap already rejects any
  // unsafe magnitude; the cap keeps the materialized spot grid trivial (~80 KB, one exposure
  // re-aggregation per step).
  if (!Number.isSafeInteger(g.steps) || g.steps < 1 || g.steps > 10_000) {
    throw new InputError(
      `${functionName}: spot grid steps must be an integer in [1, 10000], got ${g.steps}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { steps: g.steps },
      },
    );
  }
  const out: number[] = [];
  const n = Math.max(1, g.steps - 1);
  for (let i = 0; i < g.steps; i++) out.push(g.from + ((g.to - g.from) * i) / n);
  return out;
}

export interface ExposureInput {
  quotes: OptionQuote[];
  market: ExposureMarket;
  config: ExposureConfig;
}

/** Compute an exposure profile from an option chain. */
export function exposure(input: ExposureInput): ExposureProfile {
  return new ExposureProfile(input);
}
