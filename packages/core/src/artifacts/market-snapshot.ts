/**
 * The versioned market snapshot (Gate B): ONE envelope for "market state at an instant", so books,
 * scenarios, saved research, workers, and MCP handles stop inventing incompatible bags of market
 * fields (roadmap Program 1).
 *
 * What the envelope IS:
 *
 * - **an instant** — `asOf`, resolved once through core's one time grammar (`resolveAsOf`); the
 *   library never reads the machine clock, so the caller always supplies it;
 * - **conventions, out loud** — `conventionsVersion` plus the day count / compounding / calendar
 *   the flat observations are quoted under. A flat `riskFreeRates` section REQUIRES a stated
 *   compounding and day count: a rate without its convention is not an observation, it is a guess
 *   (the no-silent-economics law);
 * - **observations** — spot/rate/dividend/volatility/curve/surface/chain sections that REUSE the
 *   canonical `@insiderfinance/totalfinance/core` market-data vocabulary (`RateCurve`, `OptionQuote`) rather than
 *   minting a second one, which is what lets existing per-domain market objects map in without
 *   changing: an options `market({ spot, riskFreeRate, volatility, dividendYield, asOf })` is one
 *   spot + one flat rate + one flat volatility + one flat dividend yield here, and a fixed-income
 *   curve is already a `RateCurve`;
 * - **provenance, caller-supplied** — the snapshot records where data CAME from; it never fetches
 *   (explicit-effects law #7). Provenance is attached and preserved but excluded from the content
 *   hash: two identically-valued snapshots from two vendors are the same market.
 *
 * What it is NOT: a required input. `blackScholes.call({...})` keeps taking `spot` and
 * `riskFreeRate` directly (no-abstraction-tax law #5); the snapshot exists for calculations where
 * sharing, replay, scenarios, or provenance justify it, and every observation remains plain
 * readable data (escape-hatch law #6).
 *
 * Finiteness: a snapshot REFUSES non-finite numbers anywhere in its observations. An unobservable
 * quantity is ABSENT, not `NaN` — which is also what makes the stored form pure JSON with no
 * non-finite wrappers, so `JSON.stringify(snapshot)` is lossless as-is.
 */

import { CONVENTIONS_VERSION } from '../assumptions.js';
import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from '../invariants.js';
import type { RateCurve, SymbolId } from '../market-data.js';
import { requireRateCurveData } from '../market-data.js';
import type { Provenance } from '../provenance.js';
import { requireProvenance } from '../provenance.js';
import type { DayCount, EpochMs, InterestCompounding } from '../time.js';
import { resolveAsOf } from '../time.js';
import { canonicalJsonOf, fromCanonicalJson } from '../canonical-json.js';
import { contentHash } from './content-hash.js';
import { deepFreeze } from './deep-freeze.js';
import type { AppliedMigration, ArtifactMigrationRegistry } from './migration.js';
import { createArtifactMigrationRegistry } from './migration.js';
import type { TableHandle } from './table-handle.js';
import { requireTableHandle } from './table-handle.js';

export const MARKET_SNAPSHOT_KIND = 'totalfinance.market-snapshot';

/**
 * Current market-snapshot schema version. Bump ONLY with a shape change, and land the bump with a
 * registered migration — `readMarketSnapshot` refuses an older stored version without one, and
 * refuses a newer version outright (this build cannot know what changed).
 */
export const MARKET_SNAPSHOT_SCHEMA_VERSION = 1;

/** A spot observation. Open per Law 12: extra vendor fields are preserved, finite, and unread. */
export interface SpotObservation {
  /** Observed price in `currency`. Finite; sign unconstrained (negative commodity prints are real). */
  price: number;
  currency?: string;
  /** When this particular print was observed, if it differs from the snapshot's `asOf`. */
  timestampMs?: EpochMs;
}

/** An implied-volatility surface grid; `impliedVolatilities[i][j]` pairs expiry `i` with strike `j`. */
export interface VolatilitySurfaceObservation {
  timeToExpiryYears: number[];
  strikes: number[];
  /** Annualized decimal implied volatilities, row per expiry, column per strike. */
  impliedVolatilities: number[][];
}

/**
 * An option-chain observation: EITHER inline rows (small chains) or a {@link TableHandle}
 * reference (large chains stay out of the envelope). Exactly one of the two.
 * Rows are core `OptionQuote`-shaped and validated openly: the numeric fields TotalFinance consumes
 * must be finite numbers when present; vendor decoration is preserved.
 */
export interface OptionChainObservation {
  quotes?: Record<string, unknown>[];
  table?: TableHandle;
}

export interface MarketSnapshotConventions {
  /** The library conventions revision the snapshot was created under; stamped, not caller-set. */
  conventionsVersion: string;
  /**
   * How `asOf` was expressed at create time; stamped, not caller-set. `'explicit-instant'` — epoch
   * ms or a zoned datetime; `'date-midnight-utc'` — a bare `YYYY-MM-DD`, the ledger's date-granular
   * convention (calendar date D at 00:00 UTC). Option-pricing consumers refuse a date-granular
   * snapshot through {@link requireInstantMarketSnapshot}: the time of day prices a same-day option.
   */
  asOfConvention: MarketSnapshotAsOfConvention;
  /** Quote basis for the flat `riskFreeRates`/`dividendYields` sections. Required with them. */
  dayCount?: DayCount;
  compounding?: InterestCompounding;
  calendar?: string;
}

/** How a snapshot's `asOf` was expressed at create time (stamped by `createMarketSnapshot`). */
export type MarketSnapshotAsOfConvention = 'explicit-instant' | 'date-midnight-utc';

/**
 * The caller-facing conventions at create time: everything in {@link MarketSnapshotConventions}
 * EXCEPT `conventionsVersion` and `asOfConvention`, which the library stamps. Spelled out rather than `Omit<…>` so the
 * declaration stays walkable by tooling and readable without resolving a mapped type.
 */
export interface CreateMarketSnapshotInputConventions {
  /** Quote basis for the flat `riskFreeRates`/`dividendYields` sections. Required with them. */
  dayCount?: DayCount;
  compounding?: InterestCompounding;
  calendar?: string;
}

/** Input for {@link createMarketSnapshot}. */
export interface CreateMarketSnapshotInput {
  /**
   * Epoch ms or a zoned ISO datetime (stamped `asOfConvention: 'explicit-instant'`), or a bare
   * `'YYYY-MM-DD'` for a date-granular ledger snapshot (calendar date D at 00:00 UTC, stamped
   * `'date-midnight-utc'`). Option-pricing consumers refuse the date form with the fix.
   */
  asOf: EpochMs | string;
  conventions?: CreateMarketSnapshotInputConventions;
  observations: MarketSnapshotObservations;
  /** Where the observations came from — supplied by the caller, never fetched (law #7). */
  provenance?: Provenance;
}

export interface MarketSnapshotObservations {
  spots?: Record<SymbolId, SpotObservation>;
  /** Flat annual rates as decimals, keyed by currency, quoted under the envelope conventions. */
  riskFreeRates?: Record<string, number>;
  /** Flat continuous dividend/borrow yields as decimals, keyed by symbol. */
  dividendYields?: Record<SymbolId, number>;
  /** Flat annualized volatilities as decimals, keyed by symbol. */
  volatilities?: Record<SymbolId, number>;
  /** Full dated curves, keyed by a caller label (e.g. `'USD.sofr'`). Each carries its own conventions. */
  curves?: Record<string, RateCurve>;
  surfaces?: Record<SymbolId, VolatilitySurfaceObservation>;
  chains?: Record<SymbolId, OptionChainObservation>;
}

export interface MarketSnapshot {
  kind: typeof MARKET_SNAPSHOT_KIND;
  schemaVersion: number;
  asOf: EpochMs;
  conventions: MarketSnapshotConventions;
  observations: MarketSnapshotObservations;
  provenance?: Provenance;
}

const ENVELOPE_KEYS = [
  'kind',
  'schemaVersion',
  'asOf',
  'conventions',
  'observations',
  'provenance',
];
const CONVENTION_KEYS = [
  'conventionsVersion',
  'asOfConvention',
  'dayCount',
  'compounding',
  'calendar',
];
const AS_OF_CONVENTIONS: readonly MarketSnapshotAsOfConvention[] = [
  'explicit-instant',
  'date-midnight-utc',
];
const DATE_ONLY_AS_OF = /^\d{4}-\d{2}-\d{2}$/;
const OBSERVATION_KEYS = [
  'spots',
  'riskFreeRates',
  'dividendYields',
  'volatilities',
  'curves',
  'surfaces',
  'chains',
];
const DAY_COUNTS: readonly DayCount[] = ['ACT/365F', 'ACT/360', '30/360'];

/**
 * The numeric fields core's `OptionQuote`/`OptionTrade` declare — the fields TotalFinance CONSUMES
 * from a chain row, which the chain contract requires to be finite numbers when present. Kept in
 * one list so the row check and the vocabulary cannot drift apart.
 */
const CHAIN_QUOTE_NUMERIC_FIELDS = [
  'timestampMs',
  'bid',
  'ask',
  'bidSize',
  'askSize',
  'mid',
  'last',
  'mark',
  'volume',
  'openInterest',
  'underlyingPrice',
  'impliedVolatility',
  'price',
  'size',
  'sequence',
  'premium',
  'notional',
] as const;

const EXAMPLE_CALL =
  "createMarketSnapshot({ asOf: '2026-07-20T10:30:00-04:00', conventions: { dayCount: 'ACT/365F', compounding: 'continuous' }, " +
  'observations: { spots: { AAPL: { price: 195.3 } }, riskFreeRates: { USD: 0.045 } } })';

function snapshotError(
  message: string,
  code: ErrorCode,
  context: Record<string, unknown>,
): InputError {
  return new InputError(message, { code, context });
}

function requireFiniteNumberAt(functionName: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw snapshotError(
      `${functionName}: ${path} must be a finite number — an unobservable quantity is ABSENT from a snapshot, never NaN. ` +
        `Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
      { function: functionName, field: path },
    );
  }
  return value;
}

function validDayCount(value: unknown): value is DayCount {
  return typeof value === 'string' && (DAY_COUNTS as readonly string[]).includes(value);
}

function validCompounding(value: unknown): boolean {
  if (
    value === 'simple' ||
    value === 'continuous' ||
    value === 'annual' ||
    value === 'semiannual' ||
    value === 'quarterly' ||
    value === 'monthly'
  )
    return true;
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'periodic'
  ) {
    const periods = (value as { periodsPerYear?: unknown }).periodsPerYear;
    return typeof periods === 'number' && Number.isFinite(periods) && periods > 0;
  }
  return false;
}

/**
 * Refuse any raw non-finite number anywhere in an observations tree. Global, at the door, exactly
 * like the TA snapshot reader — checking only the fields a consumer happens to read would let a
 * decorated `NaN` sail into a saved file and read back as damage later.
 */
function refuseNonFinite(functionName: string, value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) requireFiniteNumberAt(functionName, path, value);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) refuseNonFinite(functionName, value[i], `${path}[${i}]`);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      refuseNonFinite(functionName, member, `${path}.${key}`);
    }
  }
}

/** Shared by create and read: validate a snapshot BODY whose `asOf` is already an instant. */
function validateSnapshotBody(
  functionName: string,
  body: {
    asOf: number;
    conventions: unknown;
    observations: unknown;
    provenance?: unknown;
  },
): void {
  const { conventions, observations, provenance } = body;
  requireArgumentObject(functionName, 'conventions', conventions);
  ensureKnownKeys(functionName, 'conventions', conventions as object, CONVENTION_KEYS);
  const conv = conventions as MarketSnapshotConventions;
  if (!AS_OF_CONVENTIONS.includes(conv.asOfConvention)) {
    throw snapshotError(
      `${functionName}: conventions.asOfConvention must be 'explicit-instant' or 'date-midnight-utc' (createMarketSnapshot stamps it from the form of asOf). Received ${JSON.stringify(conv.asOfConvention)}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'conventions.asOfConvention' },
    );
  }
  if (typeof conv.conventionsVersion !== 'string' || conv.conventionsVersion.length === 0) {
    throw snapshotError(
      `${functionName}: conventions.conventionsVersion must be a non-empty string (createMarketSnapshot stamps it — a hand-assembled envelope must carry the version it was written under).`,
      ErrorCode.InputWrongType,
      { field: 'conventions.conventionsVersion' },
    );
  }
  if (conv.dayCount !== undefined && !validDayCount(conv.dayCount)) {
    throw snapshotError(
      `${functionName}: conventions.dayCount must be one of ${DAY_COUNTS.join(', ')}; got ${JSON.stringify(conv.dayCount)}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'conventions.dayCount', value: conv.dayCount },
    );
  }
  if (conv.compounding !== undefined && !validCompounding(conv.compounding)) {
    throw snapshotError(
      `${functionName}: conventions.compounding must be 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear }.`,
      ErrorCode.InputInvalidEnum,
      { field: 'conventions.compounding' },
    );
  }
  if (conv.calendar !== undefined && typeof conv.calendar !== 'string') {
    throw snapshotError(
      `${functionName}: conventions.calendar must be a calendar name string when present.`,
      ErrorCode.InputWrongType,
      { field: 'conventions.calendar' },
    );
  }

  requireArgumentObject(functionName, 'observations', observations);
  ensureKnownKeys(functionName, 'observations', observations as object, OBSERVATION_KEYS);
  const obs = observations as MarketSnapshotObservations;

  if (obs.spots !== undefined) {
    requireArgumentObject(functionName, 'observations.spots', obs.spots);
    for (const [symbol, spot] of Object.entries(obs.spots)) {
      const path = `observations.spots.${symbol}`;
      requireArgumentObject(functionName, path, spot);
      requireFiniteNumberAt(functionName, `${path}.price`, spot.price);
      if (spot.currency !== undefined && typeof spot.currency !== 'string') {
        throw snapshotError(
          `${functionName}: ${path}.currency must be a string when present.`,
          ErrorCode.InputWrongType,
          { field: `${path}.currency` },
        );
      }
      if (spot.timestampMs !== undefined)
        requireFiniteNumberAt(functionName, `${path}.timestampMs`, spot.timestampMs);
    }
  }

  for (const section of ['riskFreeRates', 'dividendYields', 'volatilities'] as const) {
    const record = obs[section];
    if (record === undefined) continue;
    requireArgumentObject(functionName, `observations.${section}`, record);
    for (const [key, value] of Object.entries(record)) {
      const resolved = requireFiniteNumberAt(functionName, `observations.${section}.${key}`, value);
      if (section === 'volatilities' && resolved < 0) {
        throw snapshotError(
          `${functionName}: observations.volatilities.${key} must be ≥ 0 — a volatility quote is a magnitude (annualized decimal). Received ${resolved}.`,
          ErrorCode.InputNegativeVolatility,
          { field: `observations.volatilities.${key}`, value: resolved },
        );
      }
    }
  }
  if (obs.riskFreeRates !== undefined && Object.keys(obs.riskFreeRates).length > 0) {
    if (conv.compounding === undefined || conv.dayCount === undefined) {
      throw snapshotError(
        `${functionName}: flat observations.riskFreeRates require conventions.compounding AND conventions.dayCount — ` +
          `a rate without its quote convention is a guess, not an observation (curves carry their own and are exempt).\n  e.g. ${EXAMPLE_CALL}`,
        ErrorCode.InputMissingField,
        {
          field:
            conv.compounding === undefined ? 'conventions.compounding' : 'conventions.dayCount',
        },
      );
    }
  }

  if (obs.curves !== undefined) {
    requireArgumentObject(functionName, 'observations.curves', obs.curves);
    for (const [label, curve] of Object.entries(obs.curves)) {
      // The ONE shared RateCurve data validator (core market-data) — the same checks the Gate C
      // pricing protocol applies to a discountCurve observation, so a curve a snapshot stores is
      // always a curve a pricer can be handed: real calendar pillar dates, strictly ascending,
      // finite values, stated conventions, string interpolation.
      requireRateCurveData(functionName, `observations.curves.${label}`, curve);
    }
  }

  if (obs.surfaces !== undefined) {
    requireArgumentObject(functionName, 'observations.surfaces', obs.surfaces);
    for (const [symbol, surface] of Object.entries(obs.surfaces)) {
      const path = `observations.surfaces.${symbol}`;
      requireArgumentObject(functionName, path, surface);
      ensureKnownKeys(functionName, path, surface, [
        'timeToExpiryYears',
        'strikes',
        'impliedVolatilities',
      ]);
      requireArgumentArray(functionName, `${path}.timeToExpiryYears`, surface.timeToExpiryYears);
      requireArgumentArray(functionName, `${path}.strikes`, surface.strikes);
      requireArgumentArray(
        functionName,
        `${path}.impliedVolatilities`,
        surface.impliedVolatilities,
      );
      for (let i = 0; i < surface.timeToExpiryYears.length; i++) {
        const t = requireFiniteNumberAt(
          functionName,
          `${path}.timeToExpiryYears[${i}]`,
          surface.timeToExpiryYears[i],
        );
        if (t < 0) {
          throw snapshotError(
            `${functionName}: ${path}.timeToExpiryYears[${i}] must be ≥ 0. Received ${t}.`,
            ErrorCode.InputNegativeTime,
            { field: `${path}.timeToExpiryYears[${i}]`, value: t },
          );
        }
      }
      for (let j = 0; j < surface.strikes.length; j++) {
        const k = requireFiniteNumberAt(functionName, `${path}.strikes[${j}]`, surface.strikes[j]);
        if (k <= 0) {
          throw snapshotError(
            `${functionName}: ${path}.strikes[${j}] must be > 0. Received ${k}.`,
            ErrorCode.InputNegativeStrike,
            { field: `${path}.strikes[${j}]`, value: k },
          );
        }
      }
      if (surface.impliedVolatilities.length !== surface.timeToExpiryYears.length) {
        throw snapshotError(
          `${functionName}: ${path}.impliedVolatilities has ${surface.impliedVolatilities.length} rows but timeToExpiryYears names ${surface.timeToExpiryYears.length} expiries — one row per expiry.`,
          ErrorCode.InputLengthMismatch,
          { rows: surface.impliedVolatilities.length, expiries: surface.timeToExpiryYears.length },
        );
      }
      for (let i = 0; i < surface.impliedVolatilities.length; i++) {
        const row = surface.impliedVolatilities[i]!;
        requireArgumentArray(functionName, `${path}.impliedVolatilities[${i}]`, row);
        if (row.length !== surface.strikes.length) {
          throw snapshotError(
            `${functionName}: ${path}.impliedVolatilities[${i}] has ${row.length} columns but strikes names ${surface.strikes.length} — one column per strike.`,
            ErrorCode.InputLengthMismatch,
            { row: i, columns: row.length, strikes: surface.strikes.length },
          );
        }
        for (let j = 0; j < row.length; j++) {
          const iv = requireFiniteNumberAt(
            functionName,
            `${path}.impliedVolatilities[${i}][${j}]`,
            row[j],
          );
          if (iv < 0) {
            throw snapshotError(
              `${functionName}: ${path}.impliedVolatilities[${i}][${j}] must be ≥ 0 (annualized decimal). Received ${iv}.`,
              ErrorCode.InputNegativeVolatility,
              { field: `${path}.impliedVolatilities[${i}][${j}]`, value: iv },
            );
          }
        }
      }
    }
  }

  if (obs.chains !== undefined) {
    requireArgumentObject(functionName, 'observations.chains', obs.chains);
    for (const [symbol, chain] of Object.entries(obs.chains)) {
      const path = `observations.chains.${symbol}`;
      requireArgumentObject(functionName, path, chain);
      ensureKnownKeys(functionName, path, chain, ['quotes', 'table']);
      const hasQuotes = chain.quotes !== undefined;
      const hasTable = chain.table !== undefined;
      if (hasQuotes === hasTable) {
        throw snapshotError(
          `${functionName}: ${path} must carry EXACTLY ONE of quotes (inline rows) or table (a TableHandle reference for large chains)${hasQuotes ? ' — it has both' : ' — it has neither'}.`,
          hasQuotes ? ErrorCode.InputWrongShape : ErrorCode.InputMissingField,
          { field: path, quotes: hasQuotes, table: hasTable },
        );
      }
      if (hasQuotes) {
        requireArgumentArray(functionName, `${path}.quotes`, chain.quotes);
        for (let i = 0; i < chain.quotes!.length; i++) {
          const quote = chain.quotes![i];
          requireArgumentObject(functionName, `${path}.quotes[${i}]`, quote);
          // The chain contract: rows are core OptionQuote/OptionTrade-shaped open records whose
          // CONSUMED numeric fields must be finite numbers when present. The global finiteness
          // walk only convicts non-finite NUMBERS, so a wrong-typed `{ bid: 'oops' }` needs this
          // per-field check; vendor decoration outside the known fields stays untouched (Law 12).
          const row = quote as Record<string, unknown>;
          for (const field of CHAIN_QUOTE_NUMERIC_FIELDS) {
            const value = row[field];
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
              throw snapshotError(
                `${functionName}: ${path}.quotes[${i}].${field} must be a finite number when present — chain rows are OptionQuote-shaped, and a consumed numeric field carrying ${value === null ? 'null' : typeof value === 'number' ? value : `a ${typeof value}`} would poison every consumer that reads it. Omit the field when the venue did not publish it.`,
                typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
                { field: `${path}.quotes[${i}].${field}`, row: i },
              );
            }
          }
        }
      }
      if (hasTable) {
        requireTableHandle(functionName, `${path}.table`, chain.table);
      }
    }
  }

  // The global finiteness door, after the shaped checks so their teaching errors win on the
  // fields they name; this walk convicts everything else, decoration included.
  refuseNonFinite(functionName, obs, 'observations');

  if (provenance !== undefined) {
    // The ONE shared provenance validator (core provenance module) — the same closed-key, fully
    // typed check every artifact envelope applies, so a `provider: 42` is refused identically
    // wherever provenance is accepted.
    requireProvenance(functionName, 'provenance', provenance);
  }
}

/** Canonical-copy + freeze: the returned envelope owns its own tree, in canonical key order. */
function freezeCanonicalCopy(envelope: MarketSnapshot): MarketSnapshot {
  return deepFreeze(fromCanonicalJson(canonicalJsonOf(envelope)) as MarketSnapshot);
}

/**
 * Build an immutable, versioned market snapshot from caller-supplied observations.
 *
 * @example
 * ```ts
 * import { createMarketSnapshot, marketSnapshotContentHash } from '@insiderfinance/totalfinance/core/artifacts';
 *
 * const snapshot = createMarketSnapshot({
 *   asOf: '2026-07-20T10:30:00-04:00',
 *   conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
 *   observations: {
 *     spots: { AAPL: { price: 195.3, currency: 'USD' } },
 *     riskFreeRates: { USD: 0.045 },
 *     volatilities: { AAPL: 0.24 },
 *   },
 *   provenance: { provider: 'insiderfinance', dataset: 'eod', asOf: 1784505600000 },
 * });
 * const identity = marketSnapshotContentHash(snapshot); // 'sha256:…'
 * ```
 */
export function createMarketSnapshot(input: CreateMarketSnapshotInput): MarketSnapshot {
  requireArgumentObject('createMarketSnapshot', 'input', input);
  ensureKnownKeys('createMarketSnapshot', 'input', input, [
    'asOf',
    'conventions',
    'observations',
    'provenance',
  ]);
  if (input.asOf === undefined) {
    throw snapshotError(
      `createMarketSnapshot: asOf is required — TotalFinance never reads the system clock, so the caller states the instant.\n  e.g. ${EXAMPLE_CALL}`,
      ErrorCode.InputMissingField,
      { field: 'asOf' },
    );
  }
  const asOf = resolveAsOf(input.asOf, 'createMarketSnapshot');
  // The form of asOf is recorded on the artifact so an option-pricing consumer can refuse a
  // date-granular snapshot (see requireInstantMarketSnapshot) while the ledger keeps its dates.
  const asOfConvention: MarketSnapshotAsOfConvention =
    typeof input.asOf === 'string' && DATE_ONLY_AS_OF.test(input.asOf)
      ? 'date-midnight-utc'
      : 'explicit-instant';
  // C06: null is NOT omission — `conventions: null` must teach, never coalesce into defaults.
  if (input.conventions !== undefined) {
    requireArgumentObject('createMarketSnapshot', 'conventions', input.conventions);
  }
  const suppliedConventions = input.conventions ?? {};
  if ((suppliedConventions as Record<string, unknown>)['asOfConvention'] !== undefined) {
    throw snapshotError(
      `createMarketSnapshot: conventions.asOfConvention is stamped by the library from the form of asOf (a bare date → 'date-midnight-utc', an instant → 'explicit-instant'); do not set it.`,
      ErrorCode.InputUnknownField,
      { field: 'conventions.asOfConvention' },
    );
  }
  if ((suppliedConventions as Record<string, unknown>)['conventionsVersion'] !== undefined) {
    throw snapshotError(
      `createMarketSnapshot: conventions.conventionsVersion is stamped by the library (currently '${CONVENTIONS_VERSION}') — it states which TotalFinance conventions the snapshot was written under, so it is not caller-settable.`,
      ErrorCode.InputUnknownField,
      { field: 'conventions.conventionsVersion' },
    );
  }
  const conventions: MarketSnapshotConventions = {
    conventionsVersion: CONVENTIONS_VERSION,
    asOfConvention,
    ...suppliedConventions,
  };
  const envelope: MarketSnapshot = {
    kind: MARKET_SNAPSHOT_KIND,
    schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    asOf,
    conventions,
    observations: input.observations,
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };
  validateSnapshotBody('createMarketSnapshot', envelope);
  return freezeCanonicalCopy(envelope);
}

/**
 * The instant of a market snapshot for an OPTION-PRICING consumer. A snapshot created from a bare
 * date (`asOfConvention: 'date-midnight-utc'`) is refused with the fix: 00:00 UTC is 19:00/20:00 ET
 * the previous evening, and a same-day option's value depends on the time of day. Ledger consumers
 * (dated marks) do not call this; they keep the date-granular convention.
 */
export function requireInstantMarketSnapshot(
  functionName: string,
  snapshot: MarketSnapshot,
): EpochMs {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireInstantMarketSnapshot: functionName must be a non-empty string naming the caller (it prefixes the teaching error). Received ${
        functionName === null
          ? 'null'
          : typeof functionName === 'string'
            ? '""'
            : typeof functionName
      }.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  // ONE validator for market snapshots — the Gate B reader (closed keys, kind, version, the stamped
  // conventions, finiteness) — so a hand-assembled or mutated envelope is refused with a typed error
  // before any field is read.
  const { snapshot: validated } = readMarketSnapshot({ snapshot });
  if (validated.conventions.asOfConvention === 'date-midnight-utc') {
    const iso = new Date(validated.asOf).toISOString().slice(0, 10);
    throw new InputError(
      `${functionName}: the market snapshot was created from the bare date "${iso}" (asOfConvention 'date-midnight-utc'), and option pricing needs a valuation instant — a same-day option's value depends on the time of day. Create the snapshot with asOf: usEquitySessionInstant('${iso}', 'close') for that day's US close, a zoned datetime like "${iso}T10:30:00-04:00", or epoch milliseconds.`,
      {
        code: ErrorCode.TimeValuationInstantRequired,
        context: { function: functionName, field: 'market.asOf', asOf: validated.asOf },
      },
    );
  }
  return validated.asOf;
}

/**
 * Validate a CURRENT-version snapshot envelope in FULL: closed key set, kind, exact schema
 * version, finite `asOf`, the whole observations/conventions body, and provenance shape. This is
 * the read door's own validation extracted into a callable that does not migrate — shared by
 * `readMarketSnapshot` (post-migration) and the public {@link isMarketSnapshot} guard, so "is a
 * snapshot" and "reads as a snapshot" are ONE law that cannot drift apart.
 */
function requireCurrentSnapshotEnvelope(
  functionName: string,
  candidate: Record<string, unknown>,
): MarketSnapshot {
  ensureKnownKeys(functionName, 'snapshot', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== MARKET_SNAPSHOT_KIND) {
    throw snapshotError(
      `${functionName}: snapshot.kind is ${JSON.stringify(candidate['kind'])}, not '${MARKET_SNAPSHOT_KIND}'.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  if (candidate['schemaVersion'] !== MARKET_SNAPSHOT_SCHEMA_VERSION) {
    throw snapshotError(
      `${functionName}: snapshot.schemaVersion is ${String(candidate['schemaVersion'])}, not the current ${MARKET_SNAPSHOT_SCHEMA_VERSION} — older versions load only through readMarketSnapshot's explicit migrations.`,
      ErrorCode.SnapshotInvalidVersion,
      { version: candidate['schemaVersion'] },
    );
  }
  const asOf = candidate['asOf'];
  requireFiniteNumberAt(functionName, 'snapshot.asOf', asOf);
  const body: MarketSnapshot = {
    kind: MARKET_SNAPSHOT_KIND,
    schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    asOf: asOf as number,
    conventions: candidate['conventions'] as MarketSnapshotConventions,
    observations: candidate['observations'] as MarketSnapshotObservations,
    ...(candidate['provenance'] !== undefined
      ? { provenance: candidate['provenance'] as Provenance }
      : {}),
  };
  validateSnapshotBody(functionName, body);
  return body;
}

/**
 * Sound structural test for a CURRENT-version market snapshot envelope: the complete read-door
 * validation (closed keys, kind, version, finite `asOf`, every observation, provenance shape)
 * behind a boolean door — `true` means `readMarketSnapshot` would accept the value unchanged, with
 * no migrations. (An earlier version sniffed five fields, so `{ …, asOf: NaN }` and a
 * conventions-free bag passed as `MarketSnapshot` and detonated downstream.) Full-walk, not
 * constant-time; when you also need the restored copy, call the read door instead.
 */
export function isMarketSnapshot(value: unknown): value is MarketSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    requireCurrentSnapshotEnvelope('isMarketSnapshot', value as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONE door back in for stored snapshots: validates the envelope (closed key set, kind,
 * version) BEFORE reading any observation, applies explicitly registered migrations for older
 * versions, refuses newer versions, re-validates the full body, and returns a frozen snapshot
 * plus the exact migration steps applied (possibly none).
 */
export function readMarketSnapshot(input: {
  snapshot: unknown;
  migrations?: ArtifactMigrationRegistry;
}): { snapshot: MarketSnapshot; migrationsApplied: AppliedMigration[] } {
  requireArgumentObject('readMarketSnapshot', 'input', input);
  ensureKnownKeys('readMarketSnapshot', 'input', input, ['snapshot', 'migrations']);
  const raw = input.snapshot;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw snapshotError(
      `readMarketSnapshot: snapshot must be a MarketSnapshot envelope object ({ kind, schemaVersion, asOf, conventions, observations }). Received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
      ErrorCode.SnapshotWrongShape,
      { received: raw === null ? 'null' : typeof raw },
    );
  }
  const candidate = raw as Record<string, unknown>;
  ensureKnownKeys('readMarketSnapshot', 'snapshot', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== MARKET_SNAPSHOT_KIND) {
    throw snapshotError(
      `readMarketSnapshot: snapshot.kind is ${JSON.stringify(candidate['kind'])}, not '${MARKET_SNAPSHOT_KIND}' — this reader restores market snapshots only.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  const version = candidate['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw snapshotError(
      `readMarketSnapshot: snapshot has an invalid schema version: ${String(version)}.`,
      ErrorCode.SnapshotInvalidVersion,
      { version },
    );
  }
  if (version > MARKET_SNAPSHOT_SCHEMA_VERSION) {
    throw snapshotError(
      `readMarketSnapshot: snapshot schema version ${version} is newer than this build supports (${MARKET_SNAPSHOT_SCHEMA_VERSION}). Upgrade @insiderfinance/totalfinance to restore it — restoring blind would misread state.`,
      ErrorCode.SnapshotUnsupportedVersion,
      { version, supported: MARKET_SNAPSHOT_SCHEMA_VERSION },
    );
  }
  let envelope = candidate;
  let migrationsApplied: AppliedMigration[] = [];
  if (version < MARKET_SNAPSHOT_SCHEMA_VERSION) {
    const registry = input.migrations ?? createArtifactMigrationRegistry();
    ({ envelope, migrationsApplied } = registry.upgrade({
      envelope,
      targetVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    }));
  }
  // The shared current-version validator — one law with isMarketSnapshot. Post-migration it also
  // proves the registry actually delivered the current shape (kind and version included).
  const body = requireCurrentSnapshotEnvelope('readMarketSnapshot', envelope);
  return { snapshot: freezeCanonicalCopy(body), migrationsApplied };
}

/**
 * The snapshot's content identity: `sha256:` over the canonical envelope WITHOUT `provenance`.
 * Conventions, `asOf`, and every observation are covered (two snapshots that price differently
 * must never collide); source labels are not (two vendors delivering identical numbers ARE the
 * same market — dedup and replay comparison depend on that).
 */
export function marketSnapshotContentHash(snapshot: MarketSnapshot): string {
  requireArgumentObject('marketSnapshotContentHash', 'snapshot', snapshot);
  // FULL validation, not the structural predicate: an identity for a malformed envelope would be
  // worse than a refusal — a snapshot with an unknown key, a non-finite asOf, or a null convention
  // must never acquire a confident-looking hash (the deep probe convicted exactly that). Reusing
  // the read path keeps ONE validator; hashing an older schema version first requires an explicit
  // migration, because identity is defined over the CURRENT canonical grammar.
  const { snapshot: validated } = readMarketSnapshot({ snapshot });
  return contentHash({
    kind: validated.kind,
    schemaVersion: validated.schemaVersion,
    asOf: validated.asOf,
    conventions: validated.conventions,
    observations: validated.observations,
  });
}
