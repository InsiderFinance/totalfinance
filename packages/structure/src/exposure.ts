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
  requireSelection,
} from '@totalfinance/core';
import { impliedVolatility } from '@totalfinance/options';
import {
  blackScholesEvaluateManyInto,
  type BlackScholesOutput,
  type BlackScholesOutputBuffers,
  type OptionBatchColumns,
} from '@totalfinance/options/batch';
import { blackScholesGreeks } from '@totalfinance/options/black-scholes';
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

/**
 * The Black–Scholes outputs each exposure metric is built from (selective Greeks and exposure spec,
 * decision 11). Speed exposure is the full derivative of GEX, so it needs gamma as well as speed.
 */
const METRIC_OUTPUTS: Readonly<Record<ExposureMetric, readonly BlackScholesOutput[]>> = {
  gex: ['gamma'],
  dex: ['delta'],
  vega: ['vega'],
  vanna: ['vanna'],
  charm: ['charm'],
  theta: ['theta'],
  vomma: ['vomma'],
  speed: ['speed', 'gamma'],
  color: ['color'],
};

/**
 * The metrics an `exposure()` call is GUARANTEED to have computed: every metric when `metrics` is
 * omitted, exactly the names of a literal selection, and none for a selection whose contents the
 * type cannot know (`ExposureMetric[]`).
 */
export type GuaranteedExposureMetrics<S extends readonly ExposureMetric[] | undefined> = [
  S,
] extends [undefined]
  ? ExposureMetric
  : [S] extends [readonly ExposureMetric[]]
    ? number extends NonNullable<S>['length']
      ? never
      : NonNullable<S>[number]
    : never;

/** The metrics an `exposure()` call MAY have computed: every metric unless a selection narrows them. */
export type PossibleExposureMetrics<S extends readonly ExposureMetric[] | undefined> =
  undefined extends S ? ExposureMetric : NonNullable<S>[number];

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

/**
 * The totals of a profile that computed the guaranteed metrics `G` and possibly `P`: guaranteed
 * metrics are required, possible ones optional, everything else absent. With the defaults this is
 * {@link ExposureTotals}.
 */
export type ExposureAggregate<
  G extends ExposureMetric = ExposureMetric,
  P extends ExposureMetric = G,
> = Pick<ExposureTotals, G> & Partial<Pick<ExposureTotals, Exclude<P, G>>>;

/**
 * A per-contract row of a profile (see {@link ExposureAggregate}): the contract's identity and inputs,
 * its computed metrics, the raw `gamma` only when `gex` was computed and the raw `delta` only when
 * `dex` was. With the defaults this is {@link ContractExposure}.
 */
export type ContractExposureRow<
  G extends ExposureMetric = ExposureMetric,
  P extends ExposureMetric = G,
> = Omit<ContractExposure, ExposureMetric | 'gamma' | 'delta'> &
  ExposureAggregate<G, P> &
  ('gex' extends G ? { gamma: number } : 'gex' extends P ? { gamma?: number } : unknown) &
  ('dex' extends G ? { delta: number } : 'dex' extends P ? { delta?: number } : unknown);

/** What `atSpot` re-evaluates for a profile: its selected `gex` and/or `dex`. */
export type AtSpotExposure<
  G extends ExposureMetric = ExposureMetric,
  P extends ExposureMetric = G,
> = Pick<{ gex: number; dex: number }, Extract<G, 'gex' | 'dex'>> &
  Partial<Pick<{ gex: number; dex: number }, Extract<Exclude<P, G>, 'gex' | 'dex'>>>;

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

function resolveSigns(
  c: ExposureConvention,
  functionName: string,
): {
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
        functionName,
        'config.convention to be an object with `calls` and `puts`',
        c,
      );
    }
    ensureKnownKeys(functionName, 'config.convention', c, ['calls', 'puts']);
    for (const side of ['calls', 'puts'] as const) {
      const sign: unknown = c[side];
      if (sign !== 1 && sign !== -1) {
        throw new InputError(
          `${functionName}: config.convention.${side} must be 1 or -1; got ${String(sign)}. ` +
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
          'Trade-signed positioning requires per-trade aggressor data (use @insiderfinance/totalfinance/structure flow); on an open-interest chain it falls back to calls +, puts −.',
      };
    default:
      // The switch is EXHAUSTIVE to the compiler, so a runtime value outside the union fell off
      // the end and returned `undefined` signs — every exposure then computed against a convention
      // that does not exist. A sign convention chooses direction; teach the domain instead.
      throw new InputError(
        `${functionName}: config.convention must be 'callsPositivePutsNegative' | 'dealerShortGamma' | 'tradeSignedAggressor', or { calls: 1 | -1, puts: 1 | -1 }. Received ${JSON.stringify(c)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'convention', received: c } },
      );
  }
}

/**
 * Module-private marker carrying the PUBLIC function a profile is being built for, so a shortcut's
 * errors name the function the caller actually called (`gammaExposure: spot is required…`). A symbol
 * key is invisible to `Object.keys`, so the closed-key checks never see it and callers cannot set it.
 */
const CALLER: unique symbol = Symbol('exposure.caller');

type ProfileRequest = ExposureShortcutInput & {
  metrics?: readonly ExposureMetric[] | undefined;
  [CALLER]?: string;
};

/**
 * A computed exposure profile with levels, by-strike/by-expiry views, and scenario maps. R2
 * envelope: the sign convention and every resolved knob live in `assumptions`; model limitations
 * ride `diagnostics.warnings` as `model.limitation` entries — nothing is hoisted top-level.
 *
 * SELECTIVE (selective Greeks and exposure spec, decision 11). A profile built with
 * `exposure({ …, metrics })` — or a shortcut such as {@link gammaExposure} — computed ONLY the
 * selected metrics and the Black–Scholes outputs they need. Its rows and `aggregate` carry exactly
 * those metrics; an uncomputed metric is ABSENT, never zero. `G` is the set the type guarantees (a
 * literal selection) and `P` the set that may be present (a dynamic selection); both default to every
 * metric — the full profile `exposure()` has always returned.
 */
export class ExposureProfile<
  G extends ExposureMetric = ExposureMetric,
  P extends ExposureMetric = G,
> {
  readonly spot: number;
  /** Frozen result rows — a profile is a snapshot; mutate a copy, never the result. */
  readonly contracts: readonly Readonly<ContractExposureRow<G, P>>[];
  readonly aggregate: ExposureAggregate<G, P>;
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
    /**
     * The metrics this profile computed, as requested. Present only when `metrics` was passed; a
     * profile without it is the full profile (every metric).
     */
    metrics?: readonly ExposureMetric[];
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
  /** The metrics computed at construction, in canonical order (every metric when none were selected). */
  readonly #selected: readonly ExposureMetric[];
  /**
   * The OWNED snapshot as Black–Scholes columns (decision 10). Strike, volatility, time and type are
   * fixed at construction; `spot` is scratch storage refilled for each evaluation. Every evaluation
   * goes through the public `blackScholesEvaluateManyInto`, so it is validated on every call.
   */
  readonly #columns: OptionBatchColumns;
  /** Per-contract `openInterest · multiplier · sign` — the weight every exposure formula applies. */
  readonly #weight: Float64Array;
  /** Per-contract metric values at the profile's spot: the selection at construction, others on demand. */
  readonly #baseMetrics = new Map<ExposureMetric, Float64Array>();
  /** The summed per-contract base metric columns (each summed once, in contract order). */
  readonly #baseTotals = new Map<ExposureMetric, number>();
  /** Raw per-contract gamma/delta at the profile's spot (rows, pin risk), cached once computed. */
  readonly #baseGreeks = new Map<'gamma' | 'delta', Float64Array>();
  /** Reused output storage for repeated evaluations (atSpot, the zero-gamma sweep, scenarios). */
  readonly #scratch = new Map<BlackScholesOutput, Float64Array>();
  /** Reused per-contract metric values for the same repeated evaluations (created on first use). */
  #metricScratch: Float64Array | undefined;
  #strikeGroups: { strikes: number[]; members: number[][] } | undefined;

  constructor(request: ExposureInput) {
    const fn = (request as ProfileRequest | null | undefined)?.[CALLER] ?? 'exposure';
    requireArgumentObject(fn, 'request', request);
    ensureKnownKeys(fn, 'request', request, ['quotes', 'market', 'config', 'metrics']);
    const { quotes, market, config } = request;
    const requested = (request as ProfileRequest).metrics;
    // A selection decides what is computed, so it is checked as strictly as `outputs`: explicit,
    // nonempty, dense, known names, each once (typed errors; did-you-mean on a typo).
    const selection =
      requested === undefined ? undefined : requireSelection(fn, 'metrics', requested, ALL_METRICS);
    requireArgumentArray(fn, 'quotes', quotes);
    requireArgumentObject(fn, 'market', market);
    requireArgumentObject(fn, 'config', config);
    // Law 12: market and config reject unknown keys — a typo'd knob (`gamaUnit`, `divYield`) must
    // teach with a did-you-mean, never silently fall back to a default.
    ensureKnownKeys(fn, 'market', market, EXPOSURE_MARKET_KEYS);
    ensureKnownKeys(fn, 'config', config, EXPOSURE_CONFIG_KEYS);
    if (config.convention === undefined) {
      throw new InputError(`${fn}: a sign convention is required (results echo it).`, {
        code: ErrorCode.InputMissingField,
        context: { field: 'convention' },
      });
    }
    ensureFinite(market.riskFreeRate, 'riskFreeRate', fn);
    // One grammar for "when" (core resolveAsOf): epoch ms, 'YYYY-MM-DD', or a ZONED ISO datetime.
    // A numeric asOf passes through resolveAsOf untouched, so NaN still needs the finite guard.
    this.asOf = resolveValuationAsOf(market.asOf, fn);
    ensureFinite(this.asOf, 'asOf', fn);
    // Day BOUNDARY for the 0DTE bucket: the ET trading date of the snapshot — taken literally when
    // the caller named a date (`'2026-06-19'`), since that is a date, not an instant to re-zone.
    this.asOfDayIndex = asOfMarketDayIndex(market.asOf, this.asOf);
    this.r = market.riskFreeRate;
    // Null is a wrong-typed value, not omission (the 350c2796 ruling): `?? 0` used to launder a
    // null dividendYield into a dividend-free book BEFORE the finite check ran on the default.
    ensureFiniteWhenPresent(market.dividendYield, 'dividendYield', fn);
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
        `${fn}: priceSource must be 'bid' | 'ask' | 'mid' | 'last' | 'mark' when provided. Received ${config.priceSource === null ? 'null' : JSON.stringify(config.priceSource)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: 'priceSource' } },
      );
    }
    ensureFiniteWhenPresent(config.minTimeToExpiry, 'minTimeToExpiry', fn);
    // `spot: null` used to fall through `??` into the quote-derived fallback — the caller believed
    // THEIR spot anchored the surface while a quote's underlyingPrice silently did.
    ensureFiniteWhenPresent(market.spot, 'spot', fn);
    this.gammaUnit = config.gammaUnit ?? 'per1PercentMove';
    const source: PriceSource = config.priceSource ?? 'mid';
    const minT = config.minTimeToExpiry ?? 0;
    const defMult = config.defaultMultiplier ?? 100;
    const signs = resolveSigns(config.convention, fn);
    const warnings: QuantWarning[] = [];

    const spot =
      market.spot ?? quotes.find((qq) => qq.underlyingPrice !== undefined)?.underlyingPrice;
    if (spot === undefined) {
      throw new InputError(
        `${fn}: spot is required (pass market.spot or quotes with underlyingPrice).`,
        {
          code: ErrorCode.InputMissingField,
          context: { field: 'spot' },
        },
      );
    }
    // `spot > 0` alone lets Infinity through (Infinity > 0 is true), which would silently poison every
    // exposure with ∞/NaN under converged:true — require a FINITE positive spot.
    if (!(spot > 0) || !Number.isFinite(spot)) {
      throw new InputError(`${fn}: spot must be a finite positive number, got ${spot}.`, {
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
          fn,
          `quotes[${i}] to be an option quote { contract: { underlying, expiry, strike, type }, openInterest, impliedVolatility | bid/ask, … }`,
          quote,
        );
      }
      if (quote.contract === null || typeof quote.contract !== 'object') {
        throw wrongShapeError(
          fn,
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
      // to poison the aggregate with NaN/∞ under `converged: true`. `T > 0` matters only for a
      // negative `minTimeToExpiry`, which used to admit expired contracts and turn every exposure
      // into NaN (selective Greeks spec, decision 15 — a contract at or past expiry has no Greeks).
      if (
        !(T > minT) ||
        !(T > 0) ||
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
    this.signs = { name: signs.name, calls: signs.calls, puts: signs.puts };

    // The snapshot is validated ONCE, here (decision 10). Spot, volatility, time, rate and dividend
    // yield are already known-good; an option type outside call/put or a non-finite strike is not.
    // The released profile met those rows in `blackScholesGreeks`, which threw — so they are handed
    // to it again and fail with the identical error instead of pricing a garbage row.
    for (const c of resolved) {
      if ((c.type !== 'call' && c.type !== 'put') || !Number.isFinite(c.strike)) {
        blackScholesGreeks({
          type: c.type,
          spot,
          strike: c.strike,
          timeToExpiryYears: c.timeToExpiryYears,
          riskFreeRate: this.r,
          dividendYield: this.q,
          volatility: c.impliedVolatility,
        });
      }
    }
    const n = resolved.length;
    const strikes = new Float64Array(n);
    const volatilities = new Float64Array(n);
    const times = new Float64Array(n);
    const types = new Int8Array(n);
    const weight = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = resolved[i]!;
      strikes[i] = c.strike;
      volatilities[i] = c.impliedVolatility;
      times[i] = c.timeToExpiryYears;
      types[i] = c.type === 'call' ? 1 : -1;
      weight[i] = c.oi * c.mult * (c.type === 'call' ? signs.calls : signs.puts);
    }
    this.#columns = {
      spot: new Float64Array(n),
      strike: strikes,
      volatility: volatilities,
      riskFreeRate: new Float64Array(n).fill(this.r),
      timeToExpiryYears: times,
      type: types,
      dividendYield: new Float64Array(n).fill(this.q),
    };
    this.#weight = weight;
    const selected =
      selection === undefined ? ALL_METRICS : ALL_METRICS.filter((m) => selection.includes(m));
    this.#selected = selected;

    // ONE kernel pass computes every selected metric's Black–Scholes outputs (a full profile: nine
    // outputs for the nine metrics; `['gex']`: gamma alone). No level search or scenario runs here.
    this.ensureBase(selected);
    const gamma = selected.includes('gex') ? this.#baseGreeks.get('gamma')! : undefined;
    const delta = selected.includes('dex') ? this.#baseGreeks.get('delta')! : undefined;
    const columns = selected.map((m) => this.#baseMetrics.get(m)!);
    // Freeze the result rows: a caller who edits a "result" in place would silently diverge from
    // `assumptions`/`diagnostics` — same law as Position.legs (dx §4.4). A row carries the raw
    // gamma only with `gex` and the raw delta only with `dex`; unselected metrics are absent.
    const rows: Readonly<Record<string, unknown>>[] = new Array<Readonly<Record<string, unknown>>>(
      n,
    );
    const full = selection === undefined;
    const metric = (name: ExposureMetric) => this.#baseMetrics.get(name)!;
    // The full profile builds each row as ONE literal in the released field order, which keeps the
    // row a compact object; a selection adds only its own fields.
    const [gex, dex, vega, vanna, charm, theta, vomma, speed, color] = full
      ? ALL_METRICS.map(metric)
      : [];
    for (let i = 0; i < n; i++) {
      const c = resolved[i]!;
      const sign = c.type === 'call' ? signs.calls : signs.puts;
      if (full) {
        rows[i] = Object.freeze({
          expiry: c.expiry,
          strike: c.strike,
          type: c.type,
          timeToExpiryYears: c.timeToExpiryYears,
          impliedVolatility: c.impliedVolatility,
          openInterest: c.oi,
          multiplier: c.mult,
          sign,
          gamma: gamma![i]!,
          delta: delta![i]!,
          gex: gex![i]!,
          dex: dex![i]!,
          vega: vega![i]!,
          vanna: vanna![i]!,
          charm: charm![i]!,
          theta: theta![i]!,
          vomma: vomma![i]!,
          speed: speed![i]!,
          color: color![i]!,
        });
        continue;
      }
      const row: Record<string, unknown> = {
        expiry: c.expiry,
        strike: c.strike,
        type: c.type,
        timeToExpiryYears: c.timeToExpiryYears,
        impliedVolatility: c.impliedVolatility,
        openInterest: c.oi,
        multiplier: c.mult,
        sign,
      };
      if (gamma !== undefined) row['gamma'] = gamma[i];
      if (delta !== undefined) row['delta'] = delta[i];
      for (let m = 0; m < selected.length; m++) row[selected[m]!] = columns[m]![i];
      rows[i] = Object.freeze(row);
    }
    this.contracts = Object.freeze(rows) as unknown as readonly Readonly<
      ContractExposureRow<G, P>
    >[];
    // Frozen like `contracts`: the aggregate is a SNAPSHOT of those frozen rows, so a caller who
    // "adjusted" `aggregate.gex` in place would hold totals that no longer sum their own contracts
    // while `assumptions`/`diagnostics` still described the original (dx §4.4).
    const aggregate: Partial<ExposureTotals> = {};
    for (const m of selected) aggregate[m] = this.#baseTotals.get(m)!;
    this.aggregate = Object.freeze(aggregate) as ExposureAggregate<G, P>;
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
      ...(selection === undefined ? {} : { metrics: Object.freeze([...selection]) }),
    });
    this.diagnostics = {
      engine: 'structure-exposure',
      method: `gex:${this.gammaUnit}`,
      converged: true,
      warnings,
    };
  }

  /**
   * Make sure the per-contract base columns for `metrics` (and the raw `greeks`) exist, computing
   * whatever is missing in ONE kernel pass at the profile's spot. Construction calls it for the
   * selection; `levels()`/`netDrift()` call it for what they read (decision 12). Values are those a
   * full profile computes — same inputs, same kernel, same expressions, same summation order.
   */
  private ensureBase(
    metrics: readonly ExposureMetric[],
    greeks: readonly ('gamma' | 'delta')[] = [],
  ): void {
    const missing = metrics.filter((m) => !this.#baseMetrics.has(m));
    const outputs = new Set<BlackScholesOutput>();
    for (const m of missing) for (const output of METRIC_OUTPUTS[m]) outputs.add(output);
    for (const greek of greeks) outputs.add(greek);
    // gex/dex rows carry the raw gamma/delta, so keep them whenever they are computed.
    if (missing.includes('gex')) outputs.add('gamma');
    if (missing.includes('dex')) outputs.add('delta');
    for (const greek of ['gamma', 'delta'] as const) {
      if (this.#baseGreeks.has(greek)) outputs.delete(greek);
    }
    const rows = this.resolved.length;
    const computed = new Map<BlackScholesOutput, Float64Array>();
    if (outputs.size > 0) {
      const buffers: BlackScholesOutputBuffers = {};
      for (const output of outputs) buffers[output] = new Float64Array(rows);
      this.#columns.spot.fill(this.spot);
      blackScholesEvaluateManyInto(this.#columns, buffers);
      for (const output of outputs) computed.set(output, buffers[output]!);
      for (const greek of ['gamma', 'delta'] as const) {
        const values = computed.get(greek);
        if (values !== undefined) this.#baseGreeks.set(greek, values);
      }
    }
    const read = (output: BlackScholesOutput): Float64Array =>
      computed.get(output) ?? this.#baseGreeks.get(output as 'gamma' | 'delta')!;
    for (const m of missing) {
      const values = new Float64Array(rows);
      const total = accumulateMetric(
        m,
        read,
        this.#weight,
        this.spot,
        this.gammaUnit,
        rows,
        values,
      );
      this.#baseMetrics.set(m, values);
      this.#baseTotals.set(m, total);
    }
  }

  /** A base column, computing it (and only it) if this profile has not yet. */
  private baseColumn(metric: ExposureMetric): Float64Array {
    this.ensureBase([metric]);
    return this.#baseMetrics.get(metric)!;
  }

  /** The aggregate of one metric at the profile's spot — `aggregate[metric]` when it was selected. */
  private totalOf(metric: ExposureMetric): number {
    this.ensureBase([metric]);
    return this.#baseTotals.get(metric)!;
  }

  /**
   * Evaluate `outputs` for the snapshot (or a time-advanced slice of it) at spot `S` into reused
   * scratch storage. The returned columns are valid until the next evaluation.
   */
  private evaluateAt(
    S: number,
    outputs: readonly BlackScholesOutput[],
    columns: OptionBatchColumns = this.#columns,
  ): (output: BlackScholesOutput) => Float64Array {
    const capacity = this.resolved.length;
    const buffers: BlackScholesOutputBuffers = {};
    for (const output of outputs) {
      let buffer = this.#scratch.get(output);
      if (buffer === undefined) {
        buffer = new Float64Array(capacity);
        this.#scratch.set(output, buffer);
      }
      buffers[output] = buffer;
    }
    columns.spot.fill(S);
    if (outputs.length > 0) blackScholesEvaluateManyInto(columns, buffers);
    return (output) => buffers[output]!;
  }

  /**
   * Per-tick fast path: re-evaluate NET dollar-gamma (`gex`) and NET dollar-delta (`dex`) exposure at
   * a new `spot`, holding each contract's IV, time-to-expiry, and open interest FIXED (sticky-strike,
   * echoed in `assumptions.scanVolatilityPolicy`) — only spot moves and gamma/delta are re-evaluated. This is
   * the intraday dashboard path (one cheap greek pass per tick); a full {@link exposure} re-run — which
   * re-derives IV, the extended greeks, and levels — is the per-refresh path. At the profile's original
   * spot this reproduces `aggregate.gex`/`aggregate.dex` exactly (same operations, same order).
   *
   * A selective profile re-evaluates only what it selected: a {@link gammaExposure} profile returns
   * `{ gex }` and computes gamma alone. A profile that selected neither `gex` nor `dex` refuses.
   */
  atSpot(spot: number): AtSpotExposure<G, P> {
    const S = spot;
    // The per-tick path takes a LIVE price straight off a feed, so it is exactly where a NaN/0/−50
    // print arrives. Unguarded, the kernel turns it into a NaN gamma and the dashboard renders a NaN
    // (or a mirror-image negative-spot) exposure with nothing saying so.
    if (!(S > 0) || !Number.isFinite(S)) {
      throw new InputError(
        `ExposureProfile.atSpot: spot must be a finite positive number, got ${S}.`,
        { code: ErrorCode.InputNegativeSpot, context: { spot: S } },
      );
    }
    const wantGex = this.#selected.includes('gex');
    const wantDex = this.#selected.includes('dex');
    if (!wantGex && !wantDex) {
      throw new InputError(
        `ExposureProfile.atSpot re-evaluates gex and dex, and this profile computed neither (metrics: ${this.#selected.join(', ')}). Include 'gex' and/or 'dex' in exposure({ metrics }).`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { metrics: [...this.#selected], requires: ['gex', 'dex'] },
        },
      );
    }
    const outputs: BlackScholesOutput[] = [];
    if (wantGex) outputs.push('gamma');
    if (wantDex) outputs.push('delta');
    const read = this.evaluateAt(S, outputs);
    const rows = this.resolved.length;
    const result: { gex?: number; dex?: number } = {};
    const values = this.metricValues();
    if (wantGex) {
      result.gex = accumulateMetric('gex', read, this.#weight, S, this.gammaUnit, rows, values);
    }
    if (wantDex) {
      result.dex = accumulateMetric('dex', read, this.#weight, S, this.gammaUnit, rows, values);
    }
    return result as AtSpotExposure<G, P>;
  }

  /** Net signed GEX recomputed with spot shifted to `S` — gamma ALONE is evaluated (IV/T/OI fixed). */
  private netGexAtSpot(S: number): number {
    const read = this.evaluateAt(S, ['gamma']);
    const rows = this.resolved.length;
    return accumulateMetric(
      'gex',
      read,
      this.#weight,
      S,
      this.gammaUnit,
      rows,
      this.metricValues(),
    );
  }

  /** Scratch per-contract metric values for evaluations whose rows are summed, not kept. */
  private metricValues(): Float64Array {
    this.#metricScratch ??= new Float64Array(this.resolved.length);
    return this.#metricScratch;
  }

  /**
   * Chart-ready by-strike profile (one row per strike, totals summed), narrowed to `metrics` —
   * by default this profile's own metrics (every metric for a full profile). When
   * `'gex'` is requested each row ALSO carries the call/put split — `callGex`/`putGex`/`callOpenInterest`/`putOpenInterest`
   * (the {@link GexSplit} columns) — for the canonical dashboard chart (call bars up, put bars down).
   * `callGex + putGex` equals the row's net `gex` and `callOpenInterest + putOpenInterest` the strike's total OI (WS4.5).
   * A metric this profile did not compute is refused, not reported as zero.
   */
  byStrike<M extends ExposureMetric = G>(metrics?: readonly M[]): StrikeRow<M>[] {
    const chosen = this.viewMetrics('exposure.byStrike', metrics);
    const { strikes, members } = this.groupsByStrike();
    const columns = chosen.map((m) => this.#baseMetrics.get(m)!);
    const wantGexSplit = chosen.includes('gex');
    const gex = wantGexSplit ? this.#baseMetrics.get('gex')! : undefined;
    return strikes.map((strike, k) => {
      const indices = members[k]!;
      const row: Record<string, number> = { strike };
      for (let m = 0; m < chosen.length; m++) row[chosen[m]!] = sumAt(columns[m]!, indices);
      // The split columns appear ONLY when 'gex' is requested (mirrors the Pick<> narrowing), so a
      // non-gex row stays lean and the runtime shape matches the conditional StrikeRow<M> type.
      if (gex !== undefined) Object.assign(row, splitGexOi(this.resolved, gex, indices));
      return row as StrikeRow<M>;
    });
  }

  /**
   * Chart-ready by-expiry profile (one row per expiry), narrowed to `metrics` — by default this
   * profile's own metrics. A metric this profile did not compute is refused.
   */
  byExpiry<M extends ExposureMetric = G>(metrics?: readonly M[]): ExpiryRow<M>[] {
    const chosen = this.viewMetrics('exposure.byExpiry', metrics);
    const byE = new Map<string, number[]>();
    for (let i = 0; i < this.resolved.length; i++) {
      const expiry = this.resolved[i]!.expiry;
      const indices = byE.get(expiry);
      if (indices) indices.push(i);
      else byE.set(expiry, [i]);
    }
    const columns = chosen.map((m) => this.#baseMetrics.get(m)!);
    return [...byE.keys()].sort().map((expiry) => {
      const indices = byE.get(expiry)!;
      const row: Record<string, number | string> = { expiry };
      for (let m = 0; m < chosen.length; m++) row[chosen[m]!] = sumAt(columns[m]!, indices);
      return row as ExpiryRow<M>;
    });
  }

  /**
   * Resolve a view's metric list: this profile's selection by default; otherwise every name must be
   * a known metric that this profile computed (a view never reads a value that was not computed).
   */
  private viewMetrics(
    functionName: string,
    metrics: readonly ExposureMetric[] | undefined,
  ): ExposureMetric[] {
    if (metrics === undefined) return [...this.#selected];
    requireArgumentArray(functionName, 'metrics', metrics);
    for (let i = 0; i < metrics.length; i++) {
      const metric: unknown = metrics[i];
      if (!(ALL_METRICS as readonly unknown[]).includes(metric)) {
        throw new InputError(
          `${functionName}: metrics[${i}] must be one of ${ALL_METRICS.join(', ')}; got ${JSON.stringify(metric) ?? String(metric)}.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: { field: 'metrics', index: i, value: String(metric) },
          },
        );
      }
      if (!this.#selected.includes(metric as ExposureMetric)) {
        throw new InputError(
          `${functionName}: "${String(metric)}" was not computed by this profile (metrics: ${this.#selected.join(', ')}). ` +
            `Add it to exposure({ metrics }), or omit metrics for the full profile.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: {
              field: 'metrics',
              index: i,
              value: String(metric),
              computed: [...this.#selected],
            },
          },
        );
      }
    }
    return [...metrics];
  }

  /** Contract indices grouped by strike (contract order within a strike), strikes ascending. */
  private groupsByStrike(): { strikes: number[]; members: number[][] } {
    if (this.#strikeGroups === undefined) {
      const byK = new Map<number, number[]>();
      for (let i = 0; i < this.resolved.length; i++) {
        const strike = this.resolved[i]!.strike;
        const indices = byK.get(strike);
        if (indices) indices.push(i);
        else byK.set(strike, [i]);
      }
      const strikes = [...byK.keys()].sort((a, b) => a - b);
      this.#strikeGroups = { strikes, members: strikes.map((k) => byK.get(k)!) };
    }
    return this.#strikeGroups;
  }

  /**
   * Dealer-positioning levels (walls, zero-gamma, max pain, pin risk). On a selective profile this
   * computes what it reads — per-contract gex, gamma, vanna and charm at the profile's spot, plus a
   * gamma-only zero-gamma sweep — and returns exactly what a full profile returns.
   */
  levels(options: { pinRiskBand?: number } = {}): Levels {
    // Law 12 at every knob-bearing entry: `pinRiskBnd: 0.01` must teach, not silently fall back to
    // the 0.5% default and report a different pin-risk flag than the caller asked for.
    requireArgumentObject('exposure.levels', 'options', options);
    ensureKnownKeys('exposure.levels', 'options', options, LEVELS_OPTIONS_KEYS);
    if (options.pinRiskBand !== undefined) {
      ensureFinite(options.pinRiskBand, 'pinRiskBand', 'exposure.levels');
    }
    if (this.resolved.length === 0) {
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
    this.ensureBase(['gex', 'vanna', 'charm'], ['gamma']);
    const gex = this.#baseMetrics.get('gex')!;

    // Call/put walls: aggregate the SIGNED per-contract GEX per strike across ALL expiries, per side,
    // so a strike whose OI is split over several expiries isn't beaten by one fat single-expiry
    // contract. callWall = strike with the largest summed call GEX; putWall = largest summed |put GEX|.
    // Largest-OI strikes aggregate the same way (per strike, not per contract).
    const callGexByStrike = new Map<number, number>();
    const putGexByStrike = new Map<number, number>();
    const callOpenInterest = new Map<number, number>();
    const putOpenInterest = new Map<number, number>();
    for (let i = 0; i < this.resolved.length; i++) {
      const c = this.resolved[i]!;
      if (c.type === 'call') {
        callGexByStrike.set(c.strike, (callGexByStrike.get(c.strike) ?? 0) + gex[i]!);
        callOpenInterest.set(c.strike, (callOpenInterest.get(c.strike) ?? 0) + c.oi);
      } else {
        putGexByStrike.set(c.strike, (putGexByStrike.get(c.strike) ?? 0) + gex[i]!);
        putOpenInterest.set(c.strike, (putOpenInterest.get(c.strike) ?? 0) + c.oi);
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

    // Per-strike sums across expiries, strikes ascending; the first strike wins a tie (as the
    // by-strike `reduce` always did).
    const { strikes, members } = this.groupsByStrike();
    const vanna = this.#baseMetrics.get('vanna')!;
    const charm = this.#baseMetrics.get('charm')!;
    const gexByStrike = members.map((indices) => sumAt(gex, indices));
    const vannaByStrike = members.map((indices) => sumAt(vanna, indices));
    const charmByStrike = members.map((indices) => sumAt(charm, indices));
    const extreme = (values: number[], better: (candidate: number, best: number) => boolean) => {
      let best = 0;
      for (let k = 1; k < values.length; k++) if (better(values[k]!, values[best]!)) best = k;
      return strikes[best]!;
    };

    return {
      ...this.gammaProfileLevels(),
      callWall,
      putWall,
      maxGammaStrike: extreme(gexByStrike, (a, b) => a > b),
      minGammaStrike: extreme(gexByStrike, (a, b) => a < b),
      maxPain: this.maxPain(),
      largestCallOpenInterest,
      largestPutOpenInterest,
      vannaWall: extreme(vannaByStrike, (a, b) => Math.abs(a) > Math.abs(b)),
      charmWall: extreme(charmByStrike, (a, b) => Math.abs(a) > Math.abs(b)),
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
    const gex = this.baseColumn('gex');
    const gexByStrike = new Map<number, number>();
    for (let i = 0; i < this.resolved.length; i++) {
      const c = this.resolved[i]!;
      if (c.expiry !== soonest) continue;
      gexByStrike.set(c.strike, (gexByStrike.get(c.strike) ?? 0) + gex[i]!);
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
   * On a selective profile the charm and vanna aggregates are computed here if they were not selected.
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
      charmFlowPerDay: this.totalOf('charm'),
      vannaFlowPerVolatilityPoint: this.totalOf('vanna'),
    };
  }

  /**
   * Zero-gamma (gamma flip) by scanning net GEX across the [0.8·spot, 1.2·spot] grid. Collects ALL
   * sign-change roots (books can have several); `zeroGamma` is the one NEAREST spot, `gammaFlips` is
   * the full sorted list. IV is held fixed per contract during the scan (sticky-strike, echoed in
   * `assumptions.scanVolatilityPolicy`). Each grid point evaluates gamma ALONE.
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
    if (this.resolved.length === 0) return null;
    const nearestExpiry = this.resolved.reduce((best, c) =>
      expiryMsOf(c.expiry) < expiryMsOf(best.expiry) ? c : best,
    ).expiry;
    const cohort = this.resolved.filter((c) => c.expiry === nearestExpiry);
    const strikes = [...new Set(cohort.map((c) => c.strike))].sort((a, b) => a - b);
    if (strikes.length === 0) return null;
    let best: number | null = null;
    let bestPain = Infinity;
    for (const S of strikes) {
      let pain = 0;
      for (const c of cohort) {
        const intrinsic = c.type === 'call' ? Math.max(S - c.strike, 0) : Math.max(c.strike - S, 0);
        pain += intrinsic * c.oi * c.mult;
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
    this.ensureBase([], ['gamma']);
    const gamma = this.#baseGreeks.get('gamma')!;
    let best: number | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.resolved.length; i++) {
      const c = this.resolved[i]!;
      // Weight gamma·OI by proximity to spot (closer strikes pin harder).
      const proximity = 1 / (1 + Math.abs(c.strike - this.spot) / this.spot);
      const score = Math.abs(gamma[i]!) * c.oi * c.mult * proximity;
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
   * over-claims the metrics not actually computed (WS2.4). Each cell evaluates only the Black–Scholes
   * outputs its metrics need, in one shared pass (`['gex']` evaluates gamma alone). A scenario is an
   * explicitly requested analysis, so it may use any metric, whatever this profile selected.
   */
  scenarioMap<M extends ExposureMetric = DefaultScenarioMetric>(
    options: ScenarioMapOptions<M> = {},
  ): ScenarioMap<M> {
    // Law 12: a misspelled axis (`volatilityShocks`, `spots`, `metric`) silently produced the DEFAULT
    // grid — one cell at the current spot — and the caller charted it as their scenario surface.
    requireArgumentObject('exposure.scenarioMap', 'options', options);
    ensureKnownKeys('exposure.scenarioMap', 'options', options, SCENARIO_MAP_OPTIONS_KEYS);
    const metrics = (options.metrics ?? (['gex', 'dex', 'vanna', 'charm'] as M[])) as readonly M[];
    requireArgumentArray('exposure.scenarioMap', 'metrics', metrics);
    metrics.forEach((metric: unknown, i) => {
      // An unknown metric used to come back as `undefined` cells; it is a typed error now.
      if (!(ALL_METRICS as readonly unknown[]).includes(metric)) {
        throw new InputError(
          `exposure.scenarioMap: metrics[${i}] must be one of ${ALL_METRICS.join(', ')}; got ${JSON.stringify(metric) ?? String(metric)}.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: { field: 'metrics', index: i, value: String(metric) },
          },
        );
      }
    });
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
    const unique = ALL_METRICS.filter((m) => (metrics as readonly ExposureMetric[]).includes(m));
    const outputs = [...new Set(unique.flatMap((m) => METRIC_OUTPUTS[m]))];
    // Contracts still alive after each time advance — built once per advance, not once per cell.
    const slices = timeAdvances.map((step) => this.advancedSlice(step));

    const cells: Array<ScenarioCell<M>> = [];
    let evaluations = 0;
    for (const S of spots) {
      for (const dv of volatilityShocks) {
        for (let k = 0; k < timeAdvances.length; k++) {
          const slice = slices[k]!;
          const { volatility } = slice.columns;
          for (let i = 0; i < slice.rows; i++) {
            volatility[i] = Math.max(1e-4, slice.baseVolatility[i]! + dv);
          }
          const read = this.evaluateAt(S, outputs, slice.columns);
          const totals: Partial<ExposureTotals> = {};
          const values = this.metricValues();
          for (const m of unique) {
            totals[m] = accumulateMetric(
              m,
              read,
              slice.weight,
              S,
              this.gammaUnit,
              slice.rows,
              values,
            );
          }
          evaluations += slice.rows;
          const cell: Record<string, number> = {
            spot: S,
            volatilityShock: dv,
            timeAdvance: timeAdvances[k]!,
          };
          for (const m of metrics) cell[m] = totals[m]!;
          cells.push(cell as ScenarioCell<M>);
        }
      }
    }
    return { cells, metrics: [...metrics], evaluations };
  }

  /**
   * The snapshot advanced by `step` years: contracts whose time-to-expiry stays positive, with their
   * shortened times, in contract order. Volatility is a scratch column the scenario fills per shock.
   */
  private advancedSlice(step: number): {
    rows: number;
    columns: OptionBatchColumns;
    baseVolatility: Float64Array;
    weight: Float64Array;
  } {
    const all = this.#columns;
    const n = this.resolved.length;
    const kept: number[] = [];
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const T = all.timeToExpiryYears[i]! - step;
      if (!(T > 0)) continue;
      kept.push(i);
      times.push(T);
    }
    const rows = kept.length;
    const pick = (source: Float64Array) => Float64Array.from(kept, (i) => source[i]!);
    return {
      rows,
      columns: {
        spot: new Float64Array(rows),
        strike: pick(all.strike),
        volatility: new Float64Array(rows),
        riskFreeRate: pick(all.riskFreeRate),
        timeToExpiryYears: Float64Array.from(times),
        type: Int8Array.from(kept, (i) => all.type[i]!),
        dividendYield: pick(all.dividendYield!),
      },
      baseVolatility: pick(all.volatility),
      weight: pick(this.#weight),
    };
  }
}

/**
 * One exposure metric over `rows` contracts at spot `S`, from the Black–Scholes outputs `read`
 * supplies: writes the per-contract values to `into` and returns their sum (from 0, in contract
 * order — the order the released aggregate summed its rows in).
 *
 * These are the released formulas, operation for operation, so a selected metric equals the same
 * metric from the full profile bit for bit:
 *   gex   Γ·w·S²·0.01 (per 1% move) or Γ·w·S (per point)     dex   Δ·w·S
 *   vega  vega%·w                                           theta θ/day·w
 *   vanna vanna·w·S·0.01                                    charm −(charm·w·S)/365
 *   vomma vomma·w·0.0001                                    color −(color·w·S²·0.01)/365
 *   speed the change in gex for a +1% spot move, in the gex unit (both terms of d(GEX)/dS)
 * with `w = openInterest · multiplier · sign`. Plain loops over typed arrays, with no closure
 * holding a running total, so the hot paths (atSpot, the zero-gamma sweep) allocate nothing per row.
 */
function accumulateMetric(
  metric: ExposureMetric,
  read: (output: BlackScholesOutput) => Float64Array,
  weight: Float64Array,
  S: number,
  gammaUnit: GammaUnit,
  rows: number,
  into: Float64Array,
): number {
  switch (metric) {
    case 'gex': {
      const gamma = read('gamma');
      if (gammaUnit === 'per1PercentMove') {
        for (let i = 0; i < rows; i++) into[i] = gamma[i]! * weight[i]! * S * S * 0.01;
      } else {
        for (let i = 0; i < rows; i++) into[i] = gamma[i]! * weight[i]! * S; // dollar-delta change per 1-point move
      }
      break;
    }
    case 'dex': {
      const delta = read('delta');
      for (let i = 0; i < rows; i++) into[i] = delta[i]! * weight[i]! * S; // dollar delta
      break;
    }
    case 'vega': {
      const vega = read('vega');
      for (let i = 0; i < rows; i++) into[i] = vega[i]! * weight[i]!; // vega is per 1% already
      break;
    }
    case 'theta': {
      const theta = read('theta');
      for (let i = 0; i < rows; i++) into[i] = theta[i]! * weight[i]!; // dollar decay per day
      break;
    }
    case 'vanna': {
      const vanna = read('vanna');
      for (let i = 0; i < rows; i++) into[i] = vanna[i]! * weight[i]! * S * 0.01; // dollar-delta per 1% vol
      break;
    }
    case 'charm': {
      // charm/color come from the pricer as ∂/∂T (per added year of time-to-expiry). Negate so the
      // exposure is per calendar day ELAPSED (T falls as a day passes), matching the passage of time.
      const charm = read('charm');
      for (let i = 0; i < rows; i++) into[i] = -(charm[i]! * weight[i]! * S) / 365;
      break;
    }
    case 'vomma': {
      const vomma = read('vomma');
      for (let i = 0; i < rows; i++) into[i] = vomma[i]! * weight[i]! * 0.0001; // Δ(vega exposure) per +1% vol
      break;
    }
    case 'speed': {
      // speed exposure = the CHANGE IN GEX for a +1% spot move, in this profile's own gammaUnit —
      // so it composes with `gex` instead of being a raw third-order greek in nobody's units. Both
      // terms of the derivative are required: GEX = Γ·w·S²·0.01 depends on spot through Γ AND
      // through S², so d(GEX)/dS = w·0.01·(Γ'·S² + 2Γ·S); times ΔS = 0.01·S. Dropping the 2Γ·S term
      // (the old `Γ'·w·S³·0.01`) left a number that matched no convention and was 32–100× off the
      // finite difference of the profile's own GEX.
      const speed = read('speed');
      const gamma = read('gamma');
      const spotStep = S * 0.01;
      if (gammaUnit === 'per1PercentMove') {
        for (let i = 0; i < rows; i++) {
          into[i] = (speed[i]! * S + 2 * gamma[i]!) * weight[i]! * S * 0.01 * spotStep;
        }
      } else {
        for (let i = 0; i < rows; i++)
          into[i] = (speed[i]! * S + gamma[i]!) * weight[i]! * spotStep; // d/dS[Γ·w·S]·ΔS
      }
      break;
    }
    case 'color': {
      const color = read('color');
      for (let i = 0; i < rows; i++) into[i] = -(color[i]! * weight[i]! * S * S * 0.01) / 365; // change in GEX per day elapsed
      break;
    }
  }
  let total = 0;
  for (let i = 0; i < rows; i++) total += into[i]!;
  return total;
}

/** Sum of `values` at `indices`, from 0, in the given order. */
function sumAt(values: Float64Array, indices: readonly number[]): number {
  let total = 0;
  for (const i of indices) total += values[i]!;
  return total;
}

/**
 * Sum the SIGNED per-contract GEX and the open interest at one strike, split by option type (WS4.5).
 * Mirrors the call/put wall aggregation in `levels()`; `callGex + putGex` equals the strike's net GEX
 * and `callOpenInterest + putOpenInterest` its total open interest.
 */
function splitGexOi(
  resolved: readonly Resolved[],
  gex: Float64Array,
  indices: readonly number[],
): GexSplit {
  let callGex = 0;
  let putGex = 0;
  let callOpenInterest = 0;
  let putOpenInterest = 0;
  for (const i of indices) {
    const c = resolved[i]!;
    if (c.type === 'call') {
      callGex += gex[i]!;
      callOpenInterest += c.oi;
    } else {
      putGex += gex[i]!;
      putOpenInterest += c.oi;
    }
  }
  return { callGex, putGex, callOpenInterest, putOpenInterest };
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

/** The chain, market and sign convention every exposure takes — the input of the single-metric shortcuts. */
export interface ExposureShortcutInput {
  quotes: OptionQuote[];
  market: ExposureMarket;
  config: ExposureConfig;
}

/** Input for {@link exposure}: the chain, market and convention, plus an optional metric selection. */
export interface ExposureInput<
  S extends readonly ExposureMetric[] | undefined = undefined,
> extends ExposureShortcutInput {
  /**
   * The exposures to compute, e.g. `['gex']` or `['gex', 'dex', 'vanna']`. Omit it for the full
   * profile (every metric, exactly as before). A selection — explicit, nonempty, each name once —
   * computes only those metrics and the Black–Scholes outputs they need, and is echoed in
   * `assumptions.metrics`; uncomputed metrics are absent from the result, never zero.
   */
  metrics?: S;
}

/**
 * Compute an exposure profile from an option chain.
 *
 * Omit `metrics` for the full profile. Pass `metrics` to compute only some exposures — a literal
 * selection types the result precisely (`exposure({ …, metrics: ['gex'] }).aggregate.gex` is a
 * `number`, `.dex` does not exist); a selection held in a variable types its metrics as optional.
 * Name the full profile's types as `ExposureInput` and `ExposureProfile`: `Parameters<typeof
 * exposure>` and `ReturnType<typeof exposure>` see the selection's general (dynamic) form.
 *
 * @example
 * const profile = exposure({ quotes, market, config: { convention: 'dealerShortGamma' }, metrics: ['gex', 'dex'] });
 * profile.aggregate.gex;
 */
export function exposure<const S extends readonly ExposureMetric[] | undefined = undefined>(
  input: ExposureInput<S>,
): ExposureProfile<GuaranteedExposureMetrics<S>, PossibleExposureMetrics<S>> {
  return new ExposureProfile(input as ExposureInput) as unknown as ExposureProfile<
    GuaranteedExposureMetrics<S>,
    PossibleExposureMetrics<S>
  >;
}

/** The single-metric shortcuts share the selective implementation; they never build a full profile. */
function singleMetricExposure<M extends ExposureMetric>(
  functionName: string,
  metric: M,
  input: ExposureShortcutInput,
): ExposureProfile<M> {
  requireArgumentObject(functionName, 'input', input);
  // Closed: a shortcut IS its selection, so a `metrics` key is refused rather than silently obeyed.
  ensureKnownKeys(functionName, 'input', input, ['quotes', 'market', 'config']);
  const request: ProfileRequest = {
    quotes: input.quotes,
    market: input.market,
    config: input.config,
    metrics: [metric],
    [CALLER]: functionName,
  };
  return new ExposureProfile(request as ExposureInput) as unknown as ExposureProfile<M>;
}

/**
 * Gamma exposure (GEX) alone — the dollar change in dealer delta for a 1% spot move
 * (`Γ·OI·multiplier·spot²·0.01`, or per point with `gammaUnit: 'perPoint'`), signed by the convention.
 * Computes gamma only. Equivalent to `exposure({ ...input, metrics: ['gex'] })`; `atSpot` re-evaluates
 * GEX per tick and `levels()` computes what it needs when called.
 *
 * @example
 * const gex = gammaExposure({ quotes, market: { spot: 6500, riskFreeRate: 0.043, asOf }, config: { convention: 'dealerShortGamma' } });
 * gex.aggregate.gex;
 */
export function gammaExposure(input: ExposureShortcutInput): ExposureProfile<'gex'> {
  return singleMetricExposure('gammaExposure', 'gex', input);
}

/**
 * Delta exposure (DEX) alone — dollar delta (`Δ·OI·multiplier·spot`), signed by the convention.
 * Computes delta only. Equivalent to `exposure({ ...input, metrics: ['dex'] })`.
 */
export function deltaExposure(input: ExposureShortcutInput): ExposureProfile<'dex'> {
  return singleMetricExposure('deltaExposure', 'dex', input);
}

/**
 * Vega exposure alone — the dollar change in option value per 1% (0.01) volatility move
 * (`vega%·OI·multiplier`). Equivalent to `exposure({ ...input, metrics: ['vega'] })`.
 */
export function vegaExposure(input: ExposureShortcutInput): ExposureProfile<'vega'> {
  return singleMetricExposure('vegaExposure', 'vega', input);
}

/**
 * Theta exposure alone — dollar option-value decay per calendar day (`θ/day·OI·multiplier`).
 * Equivalent to `exposure({ ...input, metrics: ['theta'] })`.
 */
export function thetaExposure(input: ExposureShortcutInput): ExposureProfile<'theta'> {
  return singleMetricExposure('thetaExposure', 'theta', input);
}

/**
 * Vanna exposure alone — the dollar-delta change per +1% volatility (`vanna·OI·multiplier·spot·0.01`).
 * A higher-order exposure. Equivalent to `exposure({ ...input, metrics: ['vanna'] })`.
 */
export function vannaExposure(input: ExposureShortcutInput): ExposureProfile<'vanna'> {
  return singleMetricExposure('vannaExposure', 'vanna', input);
}

/**
 * Charm exposure alone — the signed dollar-delta change as ONE calendar day elapses (`−∂DEX/∂T` per
 * day). A higher-order exposure. Equivalent to `exposure({ ...input, metrics: ['charm'] })`.
 */
export function charmExposure(input: ExposureShortcutInput): ExposureProfile<'charm'> {
  return singleMetricExposure('charmExposure', 'charm', input);
}

/**
 * Vomma (volga) exposure alone — the change in vega exposure per +1% volatility. A higher-order
 * exposure. Equivalent to `exposure({ ...input, metrics: ['vomma'] })`.
 */
export function vommaExposure(input: ExposureShortcutInput): ExposureProfile<'vomma'> {
  return singleMetricExposure('vommaExposure', 'vomma', input);
}

/**
 * Speed exposure alone — the change in GEX for a +1% spot move, in the GEX unit (computes speed and
 * gamma). A higher-order exposure. Equivalent to `exposure({ ...input, metrics: ['speed'] })`.
 */
export function speedExposure(input: ExposureShortcutInput): ExposureProfile<'speed'> {
  return singleMetricExposure('speedExposure', 'speed', input);
}

/**
 * Color exposure alone — the signed change in GEX as ONE calendar day elapses (`−∂GEX/∂T` per day).
 * A higher-order exposure. Equivalent to `exposure({ ...input, metrics: ['color'] })`.
 */
export function colorExposure(input: ExposureShortcutInput): ExposureProfile<'color'> {
  return singleMetricExposure('colorExposure', 'color', input);
}
