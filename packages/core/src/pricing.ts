/**
 * Gate C — the narrow structural extension contract (`@totalfinance/core/pricing`).
 *
 * This module is the WHOLE protocol a heterogeneous position is priced through: a small structural
 * `Pricer` interface, typed market-requirement descriptors, the engine-selection report grammar,
 * and a behavioral conformance kit driven by caller-supplied fixtures. It contains ZERO pricing
 * mathematics — pricers are ADAPTERS around existing public functions (the no-second-engine law),
 * and a caller who wants one formula keeps calling the formula (the directness law).
 *
 * Three deliberate absences, per the platform roadmap's Gate C constraints:
 *   - no universal instrument superclass — `Pricer<TInstrument>` is structural and generic;
 *   - no mutable global evaluation date — the valuation instant is a market REQUIREMENT
 *     (`{ kind: 'valuationInstant' }`) satisfied by an observation like any other input;
 *   - no stringly typed mega-dispatch — requirements are a closed discriminated union and engine
 *     choice is an engine OBJECT on the concrete adapter, never a name looked up in a registry.
 *
 * Requirement descriptors NAME snapshot observation kinds as plain data so a Gate B market
 * snapshot can satisfy them, but this module never imports the artifacts layer — the coupling is
 * a shared vocabulary, not a dependency (design note in the Gate C spec).
 */

import { canonicalJsonOf } from './canonical-json.js';
import { type Computed, isComputed } from './computed.js';
import type { QuantWarning } from './diagnostics.js';
import { ErrorCode, InputError, isQuantError } from './errors.js';
import { assertFiniteValue } from './facade.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from './invariants.js';
import { requireRateCurveData, type RateCurve } from './market-data.js';
import { resolveValuationAsOf, type EpochMs } from './time.js';

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Market requirements — "what I need to price", stated as data
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of observation kinds a pricer may require. These names are the shared vocabulary
 * with the Gate B market-snapshot spine: a snapshot stores observations under the SAME kinds, so a
 * runner can satisfy a requirement by lookup without either side importing the other. The set is
 * extended here (one union member + one row in `REQUIREMENT_SUBJECT_FIELDS` + one value type), and
 * every extension is a reviewed vocabulary decision, not a runtime registration.
 */
export type ObservationKind =
  | 'valuationInstant'
  | 'spot'
  | 'forward'
  | 'impliedVolatility'
  | 'riskFreeRate'
  | 'dividendYield'
  | 'discountCurve';

/**
 * The instant a valuation is "as of". Required by any pricer that discounts or measures time to
 * expiry. Making it a requirement — rather than ambient state — is what makes "no mutable global
 * evaluation date" structural: two books can value the same instruments at two instants
 * concurrently, and a scenario that shifts time shifts an observation, not a process global.
 */
export interface ValuationInstantRequirement {
  kind: 'valuationInstant';
  /** `true` marks a requirement the pricer consumes when present and defaults DISCLOSED otherwise. */
  optional?: boolean;
}

/** The spot price of one underlying. */
export interface SpotRequirement {
  kind: 'spot';
  symbol: string;
  optional?: boolean;
}

/** The forward price of one underlying to a delivery/expiry instant. */
export interface ForwardRequirement {
  kind: 'forward';
  symbol: string;
  /** Delivery/expiry instant (epoch ms) the forward settles to. */
  expiresAt: EpochMs;
  optional?: boolean;
}

/** An implied volatility (decimal, e.g. `0.24`) for one contract coordinate. */
export interface ImpliedVolatilityRequirement {
  kind: 'impliedVolatility';
  symbol: string;
  strike: number;
  /** Expiration instant (epoch ms) of the contract the volatility belongs to. */
  expiresAt: EpochMs;
  optional?: boolean;
}

/** A continuously-compounded risk-free rate (decimal) for one currency. */
export interface RiskFreeRateRequirement {
  kind: 'riskFreeRate';
  currency: string;
  optional?: boolean;
}

/** A continuous dividend yield (decimal) for one underlying. */
export interface DividendYieldRequirement {
  kind: 'dividendYield';
  symbol: string;
  optional?: boolean;
}

/**
 * ONE named discount curve, satisfied by a core {@link RateCurve} — PLAIN DATA, the same payload a
 * Gate B market snapshot stores under `observations.curves`, so the observation list stays
 * serializable and replayable end to end. Consumers (e.g. a fixed-income adapter) evaluate the
 * curve with their own machinery; the protocol carries data, never behavior.
 *
 * `curveId` IS the snapshot `curves` label (e.g. `'USD.sofr'`) — that binding is the identity: a
 * snapshot stores multiple same-currency curves under caller labels, so a currency alone cannot
 * name one, and a runner satisfies this requirement by `snapshot.observations.curves[curveId]`.
 * `currency` remains a subject field AND a cross-check: the satisfying curve's own declared
 * `currency` must equal it, so a USD requirement can never be quietly satisfied by an EUR curve
 * that happened to sit under the requested label.
 */
export interface DiscountCurveRequirement {
  kind: 'discountCurve';
  /** The snapshot `observations.curves` label naming the exact curve (e.g. `'USD.sofr'`). */
  curveId: string;
  currency: string;
  optional?: boolean;
}

/**
 * One typed market-requirement descriptor — plain, serializable data. A pricer returns these from
 * `requirements(instrument)`; a runner satisfies them from a snapshot; a missing REQUIRED one is a
 * teaching error (`pricer.requirement_unsatisfied`), never a guessed value. There is deliberately
 * no "god market object": each pricer names exactly the observations it consumes, so a book runner
 * can gather the union for a heterogeneous book and know it is complete.
 */
export type MarketRequirement =
  | ValuationInstantRequirement
  | SpotRequirement
  | ForwardRequirement
  | ImpliedVolatilityRequirement
  | RiskFreeRateRequirement
  | DividendYieldRequirement
  | DiscountCurveRequirement;

/** The value type each observation kind is satisfied with. Every value is plain, serializable data. */
export interface ObservationValueByKind {
  /**
   * Epoch ms, `'YYYY-MM-DD'`, or a zoned ISO datetime — the workspace `asOf` grammar, validated
   * through core's `resolveAsOf` (the same resolution the market snapshot's create path applies),
   * so `'yesterday-ish'` and impossible calendar dates teach here, not downstream.
   */
  valuationInstant: EpochMs | string;
  spot: number;
  forward: number;
  /** Annualized decimal, ≥ 0 — a volatility quote is a magnitude, never a signed number. */
  impliedVolatility: number;
  riskFreeRate: number;
  dividendYield: number;
  /**
   * Core's plain-data {@link RateCurve} — the SAME payload Gate B snapshots store under
   * `observations.curves`, validated with the shared core curve validator. Consumers evaluate it
   * with their own machinery (a fixed-income adapter bootstraps/interpolates as its heads already
   * do); the observation itself carries no methods, so the list serializes and replays.
   */
  discountCurve: RateCurve;
}

/** The requirement-descriptor variant for one kind. */
export type RequirementOfKind<K extends ObservationKind> = Extract<MarketRequirement, { kind: K }>;

/**
 * One satisfied requirement: the descriptor it answers plus the value. Carrying the DESCRIPTOR
 * (not a bare keyed map) keeps matching structural and lets the same observation list serialize,
 * diff, and replay alongside Gate B snapshots.
 */
export type MarketObservation = {
  [K in ObservationKind]: { requirement: RequirementOfKind<K>; value: ObservationValueByKind[K] };
}[ObservationKind];

/** Subject fields per kind, in canonical key order. The single source of descriptor shape truth. */
const REQUIREMENT_SUBJECT_FIELDS: Record<ObservationKind, readonly string[]> = {
  valuationInstant: [],
  spot: ['symbol'],
  forward: ['symbol', 'expiresAt'],
  impliedVolatility: ['symbol', 'strike', 'expiresAt'],
  riskFreeRate: ['currency'],
  dividendYield: ['symbol'],
  discountCurve: ['curveId', 'currency'],
};

const OBSERVATION_KINDS = Object.keys(REQUIREMENT_SUBJECT_FIELDS) as readonly ObservationKind[];

/**
 * Every multi-positional helper here validates its own `functionName` FIRST (the guard-label law,
 * the research package's requireBoundaryName precedent): invoked without it, every error it
 * teaches would blame "undefined".
 */
function requireBoundaryName(functionName: unknown): asserts functionName is string {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireBoundaryName: pricing helper: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName === 'string' ? "''" : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
}

function requirementError(
  functionName: string,
  what: string,
  context: Record<string, unknown>,
): never {
  throw new InputError(`${functionName}: ${what}`, {
    code: ErrorCode.PricerRequirementInvalid,
    context: { function: functionName, ...context },
  });
}

/**
 * Validate one requirement descriptor: known kind, closed keys, correctly-typed subject fields.
 * Used by the helpers below and by the conformance kit; adapters get it for free through them.
 */
export function validateMarketRequirement(
  functionName: string,
  label: string,
  requirement: unknown,
): MarketRequirement {
  requireBoundaryName(functionName);
  requireArgumentObject(functionName, label, requirement);
  const r = requirement as Record<string, unknown>;
  const kind = r['kind'];
  if (typeof kind !== 'string' || !(OBSERVATION_KINDS as readonly string[]).includes(kind)) {
    requirementError(
      functionName,
      `${label}.kind must be one of ${OBSERVATION_KINDS.join(' | ')} — got ${JSON.stringify(kind)}.`,
      { label, kind },
    );
  }
  const subjectFields = REQUIREMENT_SUBJECT_FIELDS[kind as ObservationKind];
  ensureKnownKeys(functionName, label, r, ['kind', 'optional', ...subjectFields]);
  if (r['optional'] !== undefined && typeof r['optional'] !== 'boolean') {
    requirementError(functionName, `${label}.optional must be a boolean when provided.`, {
      label,
      optional: r['optional'],
    });
  }
  for (const field of subjectFields) {
    const value = r[field];
    if (field === 'symbol' || field === 'currency' || field === 'curveId') {
      if (typeof value !== 'string' || value.trim() === '') {
        requirementError(
          functionName,
          `${label}.${field} must be a non-empty string for kind "${kind}". Received ${JSON.stringify(value)}.`,
          { label, kind, field, value },
        );
      }
    } else if (field === 'strike' || field === 'expiresAt') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        requirementError(
          functionName,
          `${label}.${field} must be a finite positive number for kind "${kind}". Received ${JSON.stringify(value)}.`,
          { label, kind, field, value },
        );
      }
    }
  }
  return requirement as MarketRequirement;
}

/**
 * Canonical identity of a requirement: kind plus subject fields in declaration order, e.g.
 * `impliedVolatility(symbol=AAPL, strike=200, expiresAt=1789430400000)` or
 * `discountCurve(curveId=USD.sofr, currency=USD)`. The `optional` marker is NOT part of identity —
 * an optional and a required descriptor for the same coordinate match the same observation. This
 * string is how runners match, deduplicate across a book, and how missing requirements are NAMED
 * in teaching errors.
 */
export function requirementKey(requirement: MarketRequirement): string {
  const checked = validateMarketRequirement('requirementKey', 'requirement', requirement);
  const subjectFields = REQUIREMENT_SUBJECT_FIELDS[checked.kind];
  if (subjectFields.length === 0) return checked.kind;
  const parts = subjectFields.map(
    (field) => `${field}=${String((checked as unknown as Record<string, unknown>)[field])}`,
  );
  return `${checked.kind}(${parts.join(', ')})`;
}

/** Whether two descriptors identify the same observation (same kind + subject; `optional` ignored). */
export function sameRequirement(first: MarketRequirement, second: MarketRequirement): boolean {
  return requirementKey(first) === requirementKey(second);
}

/** Validate one observation: a valid descriptor plus a value of that kind's type. */
export function validateMarketObservation(
  functionName: string,
  label: string,
  observation: unknown,
): MarketObservation {
  requireBoundaryName(functionName);
  requireArgumentObject(functionName, label, observation);
  ensureKnownKeys(functionName, label, observation as object, ['requirement', 'value']);
  const o = observation as { requirement?: unknown; value?: unknown };
  const requirement = validateMarketRequirement(
    functionName,
    `${label}.requirement`,
    o.requirement,
  );
  const value = o.value;
  const bad = (expected: string): never => {
    throw new InputError(
      `${functionName}: ${label}.value must be ${expected} for kind "${requirement.kind}" ` +
        `(requirement ${requirementKey(requirement)}). Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.PricerObservationInvalid,
        context: { function: functionName, requirement: requirementKey(requirement), value },
      },
    );
  };
  switch (requirement.kind) {
    case 'valuationInstant':
      if (typeof value !== 'number' && typeof value !== 'string') {
        bad('an epoch-ms number or a zoned ISO datetime (a bare date has no time of day)');
      }
      // The ONE valuation-instant grammar — the same door the market snapshot's create path
      // applies to asOf. A bare date is refused (it hides the time of day a same-day option's
      // value depends on); '2025-02-30' is refused as an impossible calendar date; a bare
      // zone-less datetime is refused rather than machine-parsed.
      resolveValuationAsOf(value as EpochMs | string, functionName);
      break;
    case 'discountCurve': {
      // The shared core RateCurve data validator (also the Gate B snapshot curve door): plain
      // serializable data with real ascending pillar dates, at least one pillar, and finite
      // values — never a method bag.
      const curve = requireRateCurveData(functionName, `${label}.value`, value);
      // Identity cross-check: the curve DECLARES its own currency, and it must be the currency
      // the requirement names — a USD requirement satisfied by an EUR curve would discount in the
      // wrong money and no downstream consumer could tell.
      if (curve.currency !== requirement.currency) {
        throw new InputError(
          `${functionName}: ${label}.value is a ${JSON.stringify(curve.currency)} curve but the requirement ` +
            `${requirementKey(requirement)} names currency ${JSON.stringify(requirement.currency)} — a discount ` +
            'curve observation must carry the currency its requirement asks for. Supply the right ' +
            `curve (the snapshot label bound to this requirement is curveId ${JSON.stringify(requirement.curveId)}), ` +
            'or fix the requirement.',
          {
            code: ErrorCode.PricerObservationInvalid,
            context: {
              function: functionName,
              requirement: requirementKey(requirement),
              curveCurrency: curve.currency,
              requiredCurrency: requirement.currency,
            },
          },
        );
      }
      break;
    }
    case 'impliedVolatility':
      if (typeof value !== 'number' || !Number.isFinite(value)) bad('a finite number');
      // A volatility quote is a MAGNITUDE (annualized decimal) — the same ≥ 0 law the Gate B
      // snapshot applies to its volatilities/surfaces sections. Spot and forward stay sign-free
      // (negative commodity prints are real); a negative volatility is only ever a bug.
      if ((value as number) < 0) {
        throw new InputError(
          `${functionName}: ${label}.value must be ≥ 0 for kind "impliedVolatility" — a volatility ` +
            `quote is a magnitude (annualized decimal, e.g. 0.24 for 24%). Received ${String(value)} ` +
            `(requirement ${requirementKey(requirement)}).`,
          {
            code: ErrorCode.InputNegativeVolatility,
            context: { function: functionName, requirement: requirementKey(requirement), value },
          },
        );
      }
      break;
    default:
      if (typeof value !== 'number' || !Number.isFinite(value)) bad('a finite number');
  }
  return observation as MarketObservation;
}

/** Find the observation satisfying `requirement`, or `undefined`. Pure lookup, no validation walk. */
export function observationFor(
  observations: readonly MarketObservation[],
  requirement: MarketRequirement,
): MarketObservation | undefined {
  const key = requirementKey(requirement);
  return observations.find((observation) => requirementKey(observation.requirement) === key);
}

function unsatisfiedError(
  functionName: string,
  requirement: MarketRequirement,
  observations: readonly MarketObservation[],
): never {
  const key = requirementKey(requirement);
  const available = observations.map((observation) => requirementKey(observation.requirement));
  throw new InputError(
    `${functionName}: no observation satisfies the required market requirement ${key} — ` +
      `add { requirement: { kind: '${requirement.kind}', … }, value: … } to observations. ` +
      (available.length === 0
        ? 'Received no observations.'
        : `Received observations for: ${available.join('; ')}.`),
    {
      code: ErrorCode.PricerRequirementUnsatisfied,
      context: { function: functionName, requirement: key, available },
    },
  );
}

/**
 * The value satisfying a REQUIRED requirement. Missing → the protocol's teaching error
 * (`pricer.requirement_unsatisfied`, naming the exact descriptor and what was received) — the one
 * error code the conformance kit demands, so adapters built on this helper conform by construction.
 */
export function requireObservationValue<K extends ObservationKind>(
  functionName: string,
  observations: readonly MarketObservation[],
  // `MarketRequirement & { kind: K }` (not `RequirementOfKind<K>`) so K infers from the literal's
  // `kind` and the return type narrows to that kind's value type at the call site.
  requirement: MarketRequirement & { kind: K },
): ObservationValueByKind[K] {
  requireBoundaryName(functionName);
  requireArgumentArray(functionName, 'observations', observations);
  const match = observationFor(observations, requirement);
  if (match === undefined) unsatisfiedError(functionName, requirement, observations);
  return validateMarketObservation(functionName, 'observations[…]', match)
    .value as ObservationValueByKind[K];
}

/**
 * The value satisfying an OPTIONAL requirement, or `undefined` when absent. The consuming pricer
 * owns disclosing whatever default it applies (the no-silent-economics law); this helper only
 * makes "absent" unambiguous.
 */
export function optionalObservationValue<K extends ObservationKind>(
  functionName: string,
  observations: readonly MarketObservation[],
  requirement: MarketRequirement & { kind: K },
): ObservationValueByKind[K] | undefined {
  requireBoundaryName(functionName);
  requireArgumentArray(functionName, 'observations', observations);
  const match = observationFor(observations, requirement);
  if (match === undefined) return undefined;
  return validateMarketObservation(functionName, 'observations[…]', match)
    .value as ObservationValueByKind[K];
}

const MISSING_REQUIREMENTS_KEYS = ['requirements', 'observations'] as const;

/**
 * The REQUIRED requirements not satisfied by `observations` — a runner's pre-flight, so a book can
 * report every gap at once instead of failing one missing observation at a time. Optional
 * requirements never appear here.
 */
export function missingRequirements(input: {
  requirements: readonly MarketRequirement[];
  observations: readonly MarketObservation[];
}): readonly MarketRequirement[] {
  const functionName = 'missingRequirements';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, MISSING_REQUIREMENTS_KEYS);
  const { requirements, observations } = input;
  requireArgumentArray(functionName, 'requirements', requirements);
  requireArgumentArray(functionName, 'observations', observations);
  return requirements.filter(
    (requirement) =>
      requirement.optional !== true && observationFor(observations, requirement) === undefined,
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Engine-selection report — "you chose FOR me; show me why"
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** One engine an automatic selection considered, with why it was or was not usable/chosen. */
export interface SelectionCandidate {
  /** Engine name exactly as `diagnostics.engine` would report it. */
  name: string;
  /** Whether the candidate could have priced this request at all. */
  eligible: boolean;
  /** One sentence: why it was chosen, passed over, or ineligible. */
  reason: string;
}

/**
 * The inspectable engine-selection report carried at `diagnostics.selection`. This FORMALIZES the
 * options package's existing `diagnostics.engine` + `diagnostics.autoReason` disclosure — one
 * grammar, not a parallel scheme: `selected.name` always agrees with `diagnostics.engine`, and for
 * automatic mode `reason` is the same sentence `autoReason` carries.
 *
 *   - `mode: 'explicit'` — the caller named the engine; nothing was considered, so `candidates`
 *     is ABSENT (an empty considered-list would fabricate deliberation that never happened).
 *   - `mode: 'automatic'` — the pricer chose, and must show its work: `candidates` lists every
 *     engine the routing considered, each with an eligibility verdict and a reason, and the
 *     selected engine appears among them as an eligible row.
 */
export interface SelectionReport {
  mode: 'explicit' | 'automatic';
  selected: {
    name: string;
    version?: string;
  };
  /** Why the selected engine answers this request. */
  reason: string;
  /** Candidates an automatic selection considered; absent for explicit mode. */
  candidates?: readonly SelectionCandidate[];
}

function selectionError(
  functionName: string,
  what: string,
  context: Record<string, unknown>,
): never {
  throw new InputError(`${functionName}: ${what}`, {
    code: ErrorCode.PricerNonconformant,
    context: { function: functionName, ...context },
  });
}

/** Validate a selection report's grammar (shape, mode/candidates coherence, chosen-among-candidates). */
export function validateSelectionReport(functionName: string, report: unknown): SelectionReport {
  requireBoundaryName(functionName);
  requireArgumentObject(functionName, 'selection', report);
  ensureKnownKeys(functionName, 'selection', report as object, [
    'mode',
    'selected',
    'reason',
    'candidates',
  ]);
  const r = report as {
    mode?: unknown;
    selected?: unknown;
    reason?: unknown;
    candidates?: unknown;
  };
  if (r.mode !== 'explicit' && r.mode !== 'automatic') {
    selectionError(
      functionName,
      `selection.mode must be 'explicit' | 'automatic', got ${JSON.stringify(r.mode)}.`,
      {
        mode: r.mode,
      },
    );
  }
  requireArgumentObject(functionName, 'selection.selected', r.selected);
  ensureKnownKeys(functionName, 'selection.selected', r.selected as object, ['name', 'version']);
  const selected = r.selected as { name?: unknown; version?: unknown };
  if (typeof selected.name !== 'string' || selected.name.trim() === '') {
    selectionError(functionName, 'selection.selected.name must be a non-empty string.', {
      name: selected.name,
    });
  }
  if (selected.version !== undefined && typeof selected.version !== 'string') {
    selectionError(functionName, 'selection.selected.version must be a string when provided.', {
      version: selected.version,
    });
  }
  if (typeof r.reason !== 'string' || r.reason.trim() === '') {
    selectionError(functionName, 'selection.reason must be a non-empty sentence.', {
      reason: r.reason,
    });
  }
  if (r.mode === 'explicit') {
    if (r.candidates !== undefined) {
      selectionError(
        functionName,
        'selection.candidates must be ABSENT for explicit mode — nothing was considered, and an ' +
          'empty considered-list would fabricate deliberation.',
        {},
      );
    }
    return report as SelectionReport;
  }
  requireArgumentArray(functionName, 'selection.candidates', r.candidates);
  const candidates = r.candidates as unknown[];
  if (candidates.length === 0) {
    selectionError(
      functionName,
      'selection.candidates must be non-empty for automatic mode — an automatic choice must show ' +
        'what it considered.',
      {},
    );
  }
  const seenCandidateNames = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const label = `selection.candidates[${i}]`;
    requireArgumentObject(functionName, label, candidates[i]);
    ensureKnownKeys(functionName, label, candidates[i] as object, ['name', 'eligible', 'reason']);
    const candidate = candidates[i] as { name?: unknown; eligible?: unknown; reason?: unknown };
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
      selectionError(functionName, `${label}.name must be a non-empty string.`, { index: i });
    }
    if (seenCandidateNames.has(candidate.name as string)) {
      selectionError(
        functionName,
        `${label}.name "${String(candidate.name)}" appears twice in the considered-set — candidate ` +
          "names are the report's row identity (each names ONE engine with ONE verdict), so a " +
          'duplicate makes "which verdict was this engine\'s?" unanswerable. List each engine once.',
        { index: i, name: candidate.name },
      );
    }
    seenCandidateNames.add(candidate.name as string);
    if (typeof candidate.eligible !== 'boolean') {
      selectionError(functionName, `${label}.eligible must be a boolean.`, { index: i });
    }
    if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
      selectionError(functionName, `${label}.reason must be a non-empty sentence.`, { index: i });
    }
  }
  const rows = candidates as SelectionCandidate[];
  const chosen = rows.find((row) => row.name === (selected.name as string));
  if (chosen === undefined) {
    selectionError(
      functionName,
      `selection.selected.name "${String(selected.name)}" does not appear among the automatic ` +
        'candidates — the considered-set is incomplete.',
      { selected: selected.name, candidates: rows.map((row) => row.name) },
    );
  }
  if (!chosen.eligible) {
    selectionError(
      functionName,
      `selection selected "${chosen.name}" but lists it as ineligible — a report cannot choose an ` +
        'engine it says could not price the request.',
      { selected: chosen.name },
    );
  }
  return report as SelectionReport;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The Pricer protocol
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Machine-readable pricer capabilities, behaviorally verified by {@link validatePricer} — a claim
 * the kit cannot confirm fails conformance, so capabilities can never drift into marketing (the
 * same discipline as the options package's `EngineCapabilities`).
 *
 * Deliberately NOT here: `price` (a Pricer that cannot price is not a Pricer — it is the one
 * mandatory method) and `scenarios` (revaluing under shocked observations is what `price` over
 * requirement-satisfied observations MEANS; every conformant pricer supports scenarios
 * structurally, so a flag would be noise).
 */
export interface PricerCapabilities {
  /**
   * How Greeks are produced when `request.greeks` is set: closed-form (`analytic`), bump-and-
   * reprice (`finite-difference`), by whatever engine was selected (`delegated`), or not at all
   * (`none` — the request is not honored and no `greeks` field appears; never fabricated zeros).
   */
  readonly greeks: 'analytic' | 'finite-difference' | 'delegated' | 'none';
  /**
   * Where the pricer's randomness lives — behaviorally verified, replacing the earlier
   * `deterministic: boolean` (pre-1.0 rename, 2026-08-23, second external review):
   *
   *   - `'none'` — same instrument + observations + request → byte-identical COMPLETE results,
   *     and a supplied `request.seed` is IGNORED entirely (verified: identical results with and
   *     without one).
   *   - `'seeded'` — the pricer consumes randomness, but ONLY through the caller's
   *     `request.seed`: the seed is REQUIRED (its absence is a typed `input.missing_field`
   *     refusal naming `request.seed`), it is echoed at `assumptions.seed`, and two same-seed
   *     calls return byte-identical COMPLETE results. Batches obey the derivation law documented
   *     on {@link PricerValuationRequest.seed}: item `i` prices under `seed + i`.
   *
   * There is deliberately NO free-running mode: a pricer whose results the kit cannot reproduce
   * under a fixed seed makes claims the kit cannot verify, and a claim the kit cannot verify is
   * marketing. Free-running randomness is non-conformant.
   */
  readonly randomness: 'none' | 'seeded';
  /** Whether `priceBatch` exists (one observation set, many instruments — the book fast path). */
  readonly batch: boolean;
}

/** Per-call request flags. Closed; adapters map them onto their wrapped function's own options. */
export interface PricerValuationRequest {
  /** Compute Greeks when the pricer's capability allows (adapter default follows the wrapped API). */
  greeks?: boolean;
  /**
   * Randomness seed — a non-negative safe integer when present. REQUIRED by
   * `randomness: 'seeded'` pricers (a call without it is a typed `input.missing_field` refusal
   * naming this field) and echoed at `assumptions.seed`, so every stochastic result names what
   * reproduces it; IGNORED entirely by `randomness: 'none'` pricers (complete results with and
   * without a seed are identical — verified). THE BATCH DERIVATION LAW (stated here so
   * implementors can comply, verified by {@link validatePricer}):
   * `priceBatch({ instruments, observations, request })` item `i` must deep-equal
   * `price(instruments[i], observations, { ...request, seed: request.seed + i })` — one
   * documented, stable derivation, so a batch replays item-by-item through the scalar path. A
   * seeded batch whose `seed + instruments.length - 1` would exceed `Number.MAX_SAFE_INTEGER`
   * is refused rather than letting derived seeds silently collide.
   */
  seed?: number;
}

/** One complete scalar pricing request. */
export interface PricerPriceInput<TInstrument> {
  instrument: TInstrument;
  /** Observations satisfying the pricer's declared requirements for this instrument. */
  observations: readonly MarketObservation[];
  request?: PricerValuationRequest;
}

/** One complete batch pricing request: one coherent observation set across many instruments. */
export interface PricerBatchPriceInput<TInstrument> {
  instruments: readonly TInstrument[];
  observations: readonly MarketObservation[];
  request?: PricerValuationRequest;
}

/**
 * The minimal structural protocol a heterogeneous position is priced through (Gate C).
 *
 * Small on purpose: identity (`name`/`version`), verified `capabilities`, a `supports` gate, a
 * `requirements` declaration, and `price` returning the workspace's EXISTING result envelope
 * (the structural {@link PricerValuationResult} floor — Law 2's grammar, never a new envelope;
 * domain pricers preserve their richer result, e.g. options `PriceResult` or a bond result with
 * fixed-income-specific assumptions). That is enough
 * for Gate D's book to run one scenario across mixed instruments: gather the union of
 * requirements, satisfy them from one snapshot, shock observations, and call `price` per position
 * — while every direct function underneath stays independently callable.
 *
 * Implementations are ADAPTERS around existing public functions. If writing a Pricer requires
 * writing pricing math that does not already exist as a direct public function, the math lands as
 * a direct function first (the no-second-engine law).
 */
/**
 * Domain-neutral static floor for a Gate-C valuation result.
 *
 * `Computed<number>` is the default, but domains may legitimately widen assumption vocabularies
 * (fixed income uses `compounding: 'curve'`). Gate C consumes only this structural Law-2 floor and
 * preserves every extra field, matching the existing `isComputed` runtime law.
 */
export interface PricerValuationResult {
  readonly value: number;
  readonly assumptions: { readonly conventionsVersion: string };
  readonly diagnostics: {
    readonly warnings: readonly QuantWarning[];
    readonly engine?: string;
    readonly selection?: SelectionReport;
  };
}

export interface Pricer<TInstrument, TValuation extends PricerValuationResult = Computed<number>> {
  /** Stable identity, reported in diagnostics and selection reports. */
  readonly name: string;
  readonly version: string;
  /** Verified by {@link validatePricer}; never self-certified marketing. */
  readonly capabilities: PricerCapabilities;
  /** Whether this pricer can price the instrument. Runners gate on this before `requirements`. */
  supports(instrument: TInstrument): boolean;
  /**
   * The typed market requirements pricing THIS instrument consumes — required ones missing at
   * `price` time must throw `pricer.requirement_unsatisfied`; observations outside this list must
   * not influence the result (both are conformance-probed).
   */
  requirements(instrument: TInstrument): readonly MarketRequirement[];
  price(input: PricerPriceInput<TInstrument>): TValuation;
  /** Present iff `capabilities.batch`; must agree with `price` result-for-result. */
  priceBatch?(input: PricerBatchPriceInput<TInstrument>): readonly TValuation[];
}

const PRICER_CAPABILITY_KEYS = ['greeks', 'randomness', 'batch'] as const;
const PRICER_GREEKS_MODES = ['analytic', 'finite-difference', 'delegated', 'none'] as const;
const PRICER_RANDOMNESS_MODES = ['none', 'seeded'] as const;

/**
 * Structural, side-effect-free validation of a pricer definition (identity, capability grammar,
 * method presence, batch coherence). Mirrors `defineOptionPricingEngine`: definition stays cheap
 * and fixture-free; behavioral proof is the explicit opt-in ({@link validatePricer}), because the
 * protocol cannot invent a valid instrument or market for an arbitrary domain. Returns a frozen
 * pricer with bound methods.
 */
export function definePricer<
  TInstrument,
  TValuation extends PricerValuationResult = Computed<number>,
>(pricer: Pricer<TInstrument, TValuation>): Pricer<TInstrument, TValuation> {
  const functionName = 'definePricer';
  requireArgumentObject(functionName, 'pricer', pricer);
  // Law 12: the definition's key set is CLOSED — a typo'd `priceBatch2` or a speculative
  // `scenarios` member must teach, never be silently ignored (deep-probe conviction).
  ensureKnownKeys(functionName, 'pricer', pricer, [
    'name',
    'version',
    'capabilities',
    'supports',
    'requirements',
    'price',
    'priceBatch',
  ]);
  const bad = (what: string, context: Record<string, unknown> = {}): never => {
    throw new InputError(
      `${functionName}: ${what} — a Pricer declares { name, version, capabilities: { greeks, ` +
        'randomness, batch }, supports, requirements, price } (Gate C protocol) so runners can ' +
        'verify and route it.',
      { code: ErrorCode.InputMissingField, context: { function: functionName, ...context } },
    );
  };
  if (typeof pricer.name !== 'string' || pricer.name.trim() === '') {
    bad('pricer.name must be a non-empty string', { name: pricer.name });
  }
  if (typeof pricer.version !== 'string' || pricer.version.trim() === '') {
    bad('pricer.version must be a non-empty string', { version: pricer.version });
  }
  for (const method of ['supports', 'requirements', 'price'] as const) {
    if (typeof pricer[method] !== 'function') {
      bad(`pricer.${method} must be a function`, { method });
    }
  }
  const capabilities = pricer.capabilities as PricerCapabilities | undefined;
  if (capabilities === undefined || capabilities === null || typeof capabilities !== 'object') {
    bad('pricer.capabilities is required');
  }
  ensureKnownKeys(
    functionName,
    'pricer.capabilities',
    capabilities as object,
    PRICER_CAPABILITY_KEYS,
  );
  const c = capabilities as PricerCapabilities;
  if (!(PRICER_GREEKS_MODES as readonly string[]).includes(c.greeks)) {
    bad(
      `capabilities.greeks must be ${PRICER_GREEKS_MODES.join(' | ')}, got ${JSON.stringify(c.greeks)}`,
      { greeks: c.greeks },
    );
  }
  if (!(PRICER_RANDOMNESS_MODES as readonly string[]).includes(c.randomness)) {
    bad(
      `capabilities.randomness must be ${PRICER_RANDOMNESS_MODES.map((m) => `'${m}'`).join(' | ')} — ` +
        'free-running randomness is non-conformant (a claim the kit cannot verify is marketing), ' +
        `got ${JSON.stringify(c.randomness)}`,
      { randomness: c.randomness },
    );
  }
  if (typeof c.batch !== 'boolean') bad('capabilities.batch must be a boolean');
  if (c.batch && typeof pricer.priceBatch !== 'function') {
    bad('capabilities.batch is true but pricer.priceBatch is not a function', {});
  }
  if (!c.batch && pricer.priceBatch !== undefined) {
    bad(
      'capabilities.batch is false but pricer.priceBatch exists — declare the capability or drop ' +
        'the method; an undeclared batch path is unverified',
      {},
    );
  }
  const frozenCapabilities: PricerCapabilities = Object.freeze({
    greeks: c.greeks,
    randomness: c.randomness,
    batch: c.batch,
  });
  const priceBatch = pricer.priceBatch !== undefined ? pricer.priceBatch.bind(pricer) : undefined;
  return Object.freeze({
    name: pricer.name,
    version: pricer.version,
    capabilities: frozenCapabilities,
    supports: pricer.supports.bind(pricer),
    requirements: pricer.requirements.bind(pricer),
    price: pricer.price.bind(pricer),
    ...(priceBatch !== undefined ? { priceBatch } : {}),
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Conformance kit — caller-supplied fixtures, behavioral proof
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One caller-supplied behavioral fixture for {@link validatePricer}. The CALLER supplies the
 * instrument and a full observation set — the kit cannot invent meaningful market data for an
 * arbitrary domain (the same reasoning as `validateOptionPricingEngine`).
 */
export interface PricerProbe<TInstrument> {
  /** An instrument the pricer claims to support. */
  instrument: TInstrument;
  /**
   * Observations satisfying every REQUIRED declared requirement (optional ones too, when the
   * probe should exercise them). Extra observations beyond the declaration are allowed — the kit
   * uses them to prove the pricer does not read what it does not declare.
   */
  observations: readonly MarketObservation[];
  request?: PricerValuationRequest;
  /**
   * Assert that this probe's result carries a selection report of the given mode. Selection
   * disclosure is per-pricer (a single-model pricer has nothing to select), so the CALLER states
   * the expectation where one exists; the kit always validates a present report's grammar.
   */
  expectSelection?: 'explicit' | 'automatic';
}

const PRICER_PROBE_KEYS = ['instrument', 'observations', 'request', 'expectSelection'] as const;
const PRICER_REQUEST_KEYS = ['greeks', 'seed'] as const;

/**
 * The fixed seed the kit prices under when a probe does not supply one. Any non-negative safe
 * integer works — the laws are about reproducibility under A seed, not about which seed — but it
 * is a named constant so every kit failure message and every re-run names the same number.
 */
const CONFORMANCE_PROBE_SEED = 987_654_321;

/**
 * A benign foreign observation injected during the independence probe: no honest pricer declares
 * (or should react to) a spot for this reserved symbol.
 */
const FOREIGN_OBSERVATION: MarketObservation = {
  requirement: { kind: 'spot', symbol: 'TOTALFINANCE.CONFORMANCE.FOREIGN' },
  value: 1,
};

/**
 * Behaviorally verify a Pricer against CALLER-SUPPLIED fixtures. Every failure teaches: the error
 * names the probe, the broken law, and the fix.
 *
 * Per probe, the kit proves:
 *   1. `supports(instrument)` returns `true` (a probe instrument the pricer rejects is a fixture
 *      error, reported as such);
 *   2. `requirements(instrument)` returns valid, duplicate-free descriptors and is STABLE across
 *      calls — a runner must be able to gather once and price after;
 *   3. pricing with exactly the declared observations succeeds and returns the Law-2 envelope
 *      (`value`/`assumptions`/`diagnostics`) with a fully finite success (Law 7, via the same
 *      walker the library uses);
 *   4. requirement honesty, both directions: each REQUIRED observation removed one at a time makes
 *      `price` throw `pricer.requirement_unsatisfied` naming the requirement (never a silent
 *      guess); each OPTIONAL observation removed still succeeds; and undeclared observations
 *      (the probe's extras plus an injected foreign one) leave the COMPLETE result identical —
 *      compared as canonical JSON over the whole envelope (value, greeks, assumptions,
 *      diagnostics), so a pricer cannot consume what it does not declare and hide the read in a
 *      field the probe forgot to look at;
 *   5. capability honesty (randomness — 2026-08-23, second external review; every comparison is
 *      the COMPLETE canonical result, never `.value` alone): for `randomness: 'none'`, a repeat
 *      call is byte-identical AND a supplied `request.seed` changes nothing (the seed-ignoring
 *      law); for `randomness: 'seeded'`, every law is proved under a fixed seed (the probe's
 *      `request.seed`, else {@link CONFORMANCE_PROBE_SEED}): a call WITHOUT a seed is a typed
 *      `input.missing_field` refusal naming `request.seed`, the seed is echoed at
 *      `assumptions.seed`, two same-seed calls are byte-identical, undeclared-observation
 *      independence holds under that seed, and `priceBatch` obeys the documented derivation law —
 *      item `i` deep-equals the scalar result under `seed + i` (a two-copy batch is probed so the
 *      derivation is actually exercised; a probe seed leaving no safe-integer room for `seed + i`
 *      is refused, typed). `greeks` mode → a NON-EMPTY greeks object with finite-or-null leaves
 *      exactly when claimed (`{}` measures nothing and fails); `batch` → `priceBatch` exists and
 *      agrees with `price` COMPLETE-result-for-result on the probe — and (2026-08-23, fourth
 *      external review) EVERY seed law proved against `price()` is proved against `priceBatch()`
 *      too, on an at-least-two-instrument batch: a `'seeded'` batch without `request.seed` must
 *      refuse exactly as the scalar path does (a silently defaulted seed is unreproducible), a
 *      `'none'` batch must ignore a supplied seed item-for-item, and undeclared-observation
 *      independence must hold on the batch path in both modes;
 *   6. selection honesty: any `diagnostics.selection` present validates against the report grammar
 *      and agrees with `diagnostics.engine`; `expectSelection` makes the report mandatory.
 *
 * Returns the validated (frozen, bound) pricer for inline use.
 */
export function validatePricer<
  TInstrument,
  TValuation extends PricerValuationResult = Computed<number>,
>(
  pricer: Pricer<TInstrument, TValuation>,
  probes: readonly PricerProbe<TInstrument>[],
): Pricer<TInstrument, TValuation> {
  const functionName = 'validatePricer';
  const defined = definePricer(pricer);
  requireArgumentArray(functionName, 'probes', probes);
  if (probes.length === 0) {
    throw new InputError(
      `${functionName}: probes must contain at least one pricer-specific fixture.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: 'probes' } },
    );
  }

  // The explicit `=> never` annotation on the IDENTIFIER (not just the arrow) is what lets the
  // compiler treat a catch-block call as terminating, so `let x: T; try {…} catch { nonconformant(…) }`
  // reads as definitely assigned afterwards.
  const nonconformant: (index: number, what: string, context?: Record<string, unknown>) => never = (
    index,
    what,
    context = {},
  ) => {
    throw new InputError(`${functionName}: probes[${index}] — ${what}`, {
      code: ErrorCode.PricerNonconformant,
      context: { function: functionName, pricer: defined.name, index, ...context },
    });
  };
  const fixtureError = (
    index: number,
    what: string,
    context: Record<string, unknown> = {},
  ): never => {
    throw new InputError(`${functionName}: probes[${index}] ${what}`, {
      code: ErrorCode.InputWrongShape,
      context: { function: functionName, index, ...context },
    });
  };

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]!;
    requireArgumentObject(functionName, `probes[${i}]`, probe);
    ensureKnownKeys(functionName, `probes[${i}]`, probe, PRICER_PROBE_KEYS);
    if (probe.instrument === undefined) fixtureError(i, 'must include instrument');
    requireArgumentArray(functionName, `probes[${i}].observations`, probe.observations);
    if (probe.request !== undefined) {
      requireArgumentObject(functionName, `probes[${i}].request`, probe.request);
      ensureKnownKeys(functionName, `probes[${i}].request`, probe.request, PRICER_REQUEST_KEYS);
      if (
        probe.request.seed !== undefined &&
        (typeof probe.request.seed !== 'number' ||
          !Number.isSafeInteger(probe.request.seed) ||
          probe.request.seed < 0)
      ) {
        fixtureError(
          i,
          `request.seed must be a non-negative safe integer when present (e.g. 42). Received ${String(probe.request.seed)}.`,
          { seed: probe.request.seed },
        );
      }
    }
    if (
      probe.expectSelection !== undefined &&
      probe.expectSelection !== 'explicit' &&
      probe.expectSelection !== 'automatic'
    ) {
      fixtureError(i, `expectSelection must be 'explicit' | 'automatic'`, {
        expectSelection: probe.expectSelection,
      });
    }
    const observations = probe.observations.map((observation, j) =>
      validateMarketObservation(functionName, `probes[${i}].observations[${j}]`, observation),
    );

    // 1. supports() honesty.
    let supported: unknown;
    try {
      supported = defined.supports(probe.instrument);
    } catch (error) {
      nonconformant(
        i,
        `supports() threw: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
    if (typeof supported !== 'boolean') {
      nonconformant(i, `supports() returned ${String(supported)} instead of a boolean`);
    }
    if (!supported) {
      fixtureError(i, 'instrument is not supported by the pricer — probe a supported instrument', {
        pricer: defined.name,
      });
    }

    // 2. requirements() validity and stability.
    const declared = readRequirements(defined, probe.instrument, i, nonconformant);
    const declaredAgain = readRequirements(defined, probe.instrument, i, nonconformant);
    const keysOf = (list: readonly MarketRequirement[]): string =>
      list
        .map((requirement) => requirementKey(requirement))
        .sort()
        .join(' | ');
    if (keysOf(declared) !== keysOf(declaredAgain)) {
      nonconformant(
        i,
        'requirements() is unstable — two identical calls declared different requirement sets, so ' +
          'a runner cannot gather-then-price',
        { first: keysOf(declared), second: keysOf(declaredAgain) },
      );
    }
    const seenKeys = new Set<string>();
    for (const requirement of declared) {
      validateMarketRequirement(functionName, `probes[${i}] requirements(...)`, requirement);
      const key = requirementKey(requirement);
      if (seenKeys.has(key)) {
        nonconformant(i, `requirements() declares ${key} twice`, { requirement: key });
      }
      seenKeys.add(key);
    }
    const required = declared.filter((requirement) => requirement.optional !== true);
    const optional = declared.filter((requirement) => requirement.optional === true);

    // Fixture completeness: every required requirement must be observable in the probe.
    for (const requirement of required) {
      if (observationFor(observations, requirement) === undefined) {
        fixtureError(
          i,
          `observations do not satisfy the pricer's required requirement ` +
            `${requirementKey(requirement)} — supply it so behavior can be probed`,
          { requirement: requirementKey(requirement) },
        );
      }
    }

    const isDeclared = (observation: MarketObservation): boolean =>
      declared.some((requirement) => sameRequirement(requirement, observation.requirement));
    const declaredOnly = observations.filter(isDeclared);
    const extras = observations.filter((observation) => !isDeclared(observation));

    const priceOnce = (
      obs: readonly MarketObservation[],
      request: PricerValuationRequest | undefined,
    ): TValuation => {
      let result: unknown;
      try {
        result = defined.price({
          instrument: probe.instrument,
          observations: obs,
          ...(request !== undefined ? { request } : {}),
        });
      } catch (error) {
        nonconformant(
          i,
          `price() threw: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        );
      }
      // 3. Law-2 grammar + Law-7 finiteness, via the library's own walker.
      if (!isComputed(result)) {
        nonconformant(
          i,
          'price() did not return the Law-2 result envelope { value, assumptions.conventionsVersion, ' +
            'diagnostics.warnings } — pricers return the EXISTING result grammar, never a new one',
        );
      }
      const computed = result as unknown as TValuation;
      if (typeof computed.value !== 'number' || !Number.isFinite(computed.value)) {
        nonconformant(
          i,
          `price() returned value ${String(computed.value)} (expected a finite number)`,
          {
            value: computed.value,
          },
        );
      }
      try {
        assertFiniteValue(`${functionName}.probes[${i}]`, computed);
      } catch (error) {
        nonconformant(
          i,
          `price() returned a non-finite success: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return computed;
    };

    // The three honesty probes below (determinism, independence, batch parity) compare the
    // COMPLETE canonical result — the same canonical-JSON form the artifact spine hashes, which
    // wraps non-finite leaves deterministically — never `.value` alone. A pricer whose value holds
    // still while its assumptions or diagnostics drift is lying about what it computed, and a
    // probe that only reads `.value` would certify the lie.
    const canonicalOf = (stage: string, result: TValuation): string => {
      try {
        return canonicalJsonOf(result);
      } catch (error) {
        nonconformant(
          i,
          `the ${stage} result cannot be canonically serialized — a Pricer result is plain, ` +
            `JSON-safe data (the envelope an artifact saves and a probe compares in full): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };

    // Randomness plumbing (2026-08-23, second external review): every kit call to a 'seeded'
    // pricer carries ONE fixed seed — the probe's, else the kit's named constant — so each law
    // below is proved under reproducible randomness. For a 'none' pricer the base request carries
    // NO seed, so the seed-ignoring law can compare with-seed against without-seed.
    const seeded = defined.capabilities.randomness === 'seeded';
    const probeSeed = probe.request?.seed ?? CONFORMANCE_PROBE_SEED;
    const requestSansSeed: PricerValuationRequest | undefined = (() => {
      if (probe.request === undefined) return undefined;
      const { seed: _probeSuppliedSeed, ...rest } = probe.request;
      return rest;
    })();
    const baseRequest: PricerValuationRequest | undefined = seeded
      ? { ...requestSansSeed, seed: probeSeed }
      : requestSansSeed;

    // 5a-pre. A seeded pricer must REFUSE to price without its seed — pricing anyway would be
    // free-running randomness wearing a 'seeded' label.
    if (seeded) {
      let outcome: 'refused-conformant' | 'refused-wrong' | 'priced' = 'priced';
      let detail = '';
      try {
        defined.price({
          instrument: probe.instrument,
          observations: declaredOnly,
          ...(requestSansSeed !== undefined ? { request: requestSansSeed } : {}),
        });
      } catch (error) {
        if (isQuantError(error, ErrorCode.InputMissingField) && error.message.includes('seed')) {
          outcome = 'refused-conformant';
        } else {
          outcome = 'refused-wrong';
          detail = error instanceof Error ? error.message : String(error);
        }
      }
      if (outcome === 'priced') {
        nonconformant(
          i,
          `claims randomness: 'seeded' but price() SUCCEEDED without request.seed — a seeded ` +
            `pricer REQUIRES its seed (refuse with '${ErrorCode.InputMissingField}' naming ` +
            'request.seed); a result the caller cannot reproduce is free-running randomness',
        );
      }
      if (outcome === 'refused-wrong') {
        nonconformant(
          i,
          `a missing request.seed threw the wrong refusal — expected code ` +
            `'${ErrorCode.InputMissingField}' with a message naming "seed", got: ${detail}`,
        );
      }
    }

    const base = priceOnce(declaredOnly, baseRequest);
    const baseCanonical = canonicalOf('baseline', base);

    // 5a. Determinism — over the COMPLETE result, not the value. For 'none' this is repeat-call
    // identity; for 'seeded' it is SAME-SEED identity (the seed must be the only source of
    // variation).
    {
      const again = priceOnce(declaredOnly, baseRequest);
      if (canonicalOf('repeat-call', again) !== baseCanonical) {
        nonconformant(
          i,
          seeded
            ? `claims randomness: 'seeded' but two identical same-seed calls (seed ${probeSeed}) ` +
                `returned different COMPLETE results (values ${base.value} and ${again.value}) — ` +
                'under a seeded contract the seed is the ONLY source of variation, and a result ' +
                'that varies under a fixed seed cannot be cached, replayed, or trusted'
            : `claims randomness: 'none' but two identical calls returned different COMPLETE results ` +
                `(values ${base.value} and ${again.value}) — the claim covers the whole envelope ` +
                '(value, greeks, assumptions, diagnostics), and a result whose assumptions or ' +
                'diagnostics change between identical calls cannot be cached, replayed, or trusted',
          { first: base.value, second: again.value },
        );
      }
    }

    if (seeded) {
      // 5a-echo. The seed must be echoed at assumptions.seed — a stochastic result that does not
      // name its seed cannot be replayed from the result alone.
      const echoed = (base.assumptions as { seed?: unknown }).seed;
      if (echoed !== probeSeed) {
        nonconformant(
          i,
          `claims randomness: 'seeded' but the result does not echo its seed — expected ` +
            `assumptions.seed to be ${probeSeed}, got ${String(echoed)}; a stochastic result ` +
            'must name what reproduces it',
          { expectedSeed: probeSeed, echoedSeed: echoed },
        );
      }
    } else {
      // 5a-ignore. A 'none' pricer must IGNORE a supplied seed entirely — a pricer that reads it
      // consumes randomness it did not declare.
      const withSeed = priceOnce(declaredOnly, { ...requestSansSeed, seed: probeSeed });
      if (canonicalOf('seed-ignoring', withSeed) !== baseCanonical) {
        nonconformant(
          i,
          `claims randomness: 'none' but supplying request.seed ${probeSeed} changed the COMPLETE ` +
            `result (values ${base.value} and ${withSeed.value}) — a 'none' pricer must ignore a ` +
            "seed entirely; if the seed genuinely participates, declare randomness: 'seeded'",
          { withoutSeed: base.value, withSeed: withSeed.value },
        );
      }
    }

    // 4a. Undeclared-observation independence: extras + a foreign observation change nothing —
    // anywhere in the result. (For a seeded pricer this runs under the same fixed seed, so any
    // difference is a data read, never a draw.)
    const withExtras = priceOnce([...declaredOnly, ...extras, FOREIGN_OBSERVATION], baseRequest);
    if (canonicalOf('undeclared-independence', withExtras) !== baseCanonical) {
      nonconformant(
        i,
        'result changed when undeclared observations were supplied — the pricer consumes market ' +
          'data it does not declare in requirements(), so a runner cannot know what it feeds it ' +
          '(the COMPLETE results differ: value, greeks, assumptions, and diagnostics must all be ' +
          'identical, not just .value)',
        { declaredValue: base.value, withUndeclaredValue: withExtras.value },
      );
    }

    // 4b. Required-missing teaching: remove each required observation; price must throw the code.
    for (const requirement of required) {
      const key = requirementKey(requirement);
      const without = declaredOnly.filter(
        (observation) => !sameRequirement(observation.requirement, requirement),
      );
      let outcome: 'threw-conformant' | 'threw-nonconformant' | 'returned' = 'returned';
      let detail = '';
      try {
        defined.price({
          instrument: probe.instrument,
          observations: without,
          ...(baseRequest !== undefined ? { request: baseRequest } : {}),
        });
      } catch (error) {
        if (isQuantError(error, ErrorCode.PricerRequirementUnsatisfied)) {
          outcome = error.message.includes(requirement.kind)
            ? 'threw-conformant'
            : 'threw-nonconformant';
          detail = error.message;
        } else {
          outcome = 'threw-nonconformant';
          detail = error instanceof Error ? error.message : String(error);
        }
      }
      if (outcome === 'returned') {
        nonconformant(
          i,
          `price() SUCCEEDED without the required observation ${key} — a missing requirement must ` +
            `throw '${ErrorCode.PricerRequirementUnsatisfied}' (use requireObservationValue), never ` +
            'price on a silent guess',
          { requirement: key },
        );
      }
      if (outcome === 'threw-nonconformant') {
        nonconformant(
          i,
          `missing required observation ${key} threw the wrong error — expected code ` +
            `'${ErrorCode.PricerRequirementUnsatisfied}' with a message naming "${requirement.kind}", got: ${detail}`,
          { requirement: key },
        );
      }
    }

    // 4c. Optional-missing tolerance: absence of an optional observation still prices.
    for (const requirement of optional) {
      if (observationFor(declaredOnly, requirement) === undefined) continue;
      const without = declaredOnly.filter(
        (observation) => !sameRequirement(observation.requirement, requirement),
      );
      try {
        priceOnce(without, baseRequest);
      } catch (error) {
        if (isQuantError(error, ErrorCode.PricerNonconformant)) throw error;
        nonconformant(
          i,
          `price() failed without OPTIONAL observation ${requirementKey(requirement)} — an optional ` +
            'requirement must have a disclosed default, or be declared required',
          { requirement: requirementKey(requirement), cause: error },
        );
      }
    }

    // 5b. Greeks capability honesty.
    const withGreeks = priceOnce(declaredOnly, { ...baseRequest, greeks: true });
    const greeks = (withGreeks as { greeks?: unknown }).greeks;
    if (defined.capabilities.greeks === 'none') {
      if (greeks !== undefined) {
        nonconformant(i, 'claims greeks="none" but returned a greeks field when requested');
      }
    } else {
      if (greeks === null || typeof greeks !== 'object' || Array.isArray(greeks)) {
        nonconformant(
          i,
          `claims greeks="${defined.capabilities.greeks}" but returned no greeks object when requested`,
        );
      }
      const greekEntries = Object.entries(greeks as Record<string, unknown>);
      if (greekEntries.length === 0) {
        nonconformant(
          i,
          `claims greeks="${defined.capabilities.greeks}" but returned an EMPTY greeks object when ` +
            'requested — a claimed greeks capability must produce at least one named Greek leaf ' +
            '(a finite number, or null for a disclosed not-computable coordinate); {} satisfies ' +
            'the type while measuring nothing, which is capability marketing, not capability',
          { greeks: defined.capabilities.greeks },
        );
      }
      for (const [field, leaf] of greekEntries) {
        if (leaf !== null && (typeof leaf !== 'number' || !Number.isFinite(leaf))) {
          nonconformant(
            i,
            `greeks.${field} is ${String(leaf)} — Greek leaves are finite numbers or null`,
            {
              field,
            },
          );
        }
      }
    }

    // 5c. Batch capability honesty (presence is checked by definePricer; here, agreement — and
    // EVERY seed law, on the batch path too). 2026-08-23, fourth external review: the missing-seed
    // refusal, seed-ignoring, and undeclared-observation-independence laws were proved only
    // against price(), so a 'seeded' pricer whose priceBatch() silently defaulted a missing seed —
    // and a 'none' pricer whose priceBatch() read a seed its scalar path ignored — both PASSED.
    // A law proved on one entry point licenses the lie on the other, so every probe below runs on
    // priceBatch() as well, and the batch carries TWO copies of the probe instrument in BOTH modes
    // (a single-instrument batch never exercises per-item behavior past item 0). Per item: a
    // 'none' batch must reproduce the scalar result exactly; a 'seeded' batch must obey the
    // documented derivation law — item i deep-equals the scalar result under seed + i.
    if (defined.capabilities.batch) {
      const batchInstruments = [probe.instrument, probe.instrument];
      // Grouped as seed + (length - 1) deliberately: left-to-right (seed + length) - 1 rounds
      // through an unrepresentable intermediate at the MAX_SAFE_INTEGER boundary and lands back
      // on a "safe" value, letting the exact overflow this guard exists for slip through.
      if (seeded && probeSeed + (batchInstruments.length - 1) > Number.MAX_SAFE_INTEGER) {
        // The kit's own typed refusal, not a pricer verdict: a probe seed this large leaves no
        // safe-integer room for the derived per-item seeds, so the derivation law cannot be
        // stated, let alone verified.
        throw new InputError(
          `${functionName}: probes[${i}].request.seed ${probeSeed} leaves no room for the seeded ` +
            `batch derivation law — priceBatch item i prices under seed + i, and seed + ` +
            `${batchInstruments.length - 1} exceeds Number.MAX_SAFE_INTEGER. Probe with a smaller ` +
            'seed (any non-negative safe integer below MAX_SAFE_INTEGER - batch length works).\n' +
            '  e.g. probes: [{ instrument, observations, request: { seed: 42 } }]',
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, index: i, seed: probeSeed },
          },
        );
      }
      // One batch call with shape checks; every failure is a teaching pricer verdict. Each probe
      // stage below reuses it so "threw" and "wrong row count" name the stage that provoked them.
      const batchOnce = (
        stage: string,
        obs: readonly MarketObservation[],
        request: PricerValuationRequest | undefined,
      ): readonly unknown[] => {
        let batchResult: unknown;
        try {
          batchResult = defined.priceBatch!({
            instruments: batchInstruments,
            observations: obs,
            ...(request !== undefined ? { request } : {}),
          });
        } catch (error) {
          nonconformant(
            i,
            `priceBatch() threw (${stage} probe): ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          );
        }
        if (!Array.isArray(batchResult) || batchResult.length !== batchInstruments.length) {
          nonconformant(
            i,
            `priceBatch() must return one result per instrument — the ${stage} probe sent ` +
              `${batchInstruments.length} instruments and got ` +
              `${Array.isArray(batchResult) ? `${batchResult.length} results` : batchResult === null ? 'null' : typeof batchResult}`,
          );
        }
        return batchResult as readonly unknown[];
      };

      // 5c-refuse ('seeded', 2026-08-23, fourth external review). The missing-seed law covers
      // EVERY pricing entry point: a seeded batch called without request.seed must refuse exactly
      // as price() does. Probed BEFORE any seeded batch pricing, so a batch that silently
      // defaults a seed is convicted for that lie, not for a downstream disagreement.
      if (seeded) {
        let outcome: 'refused-conformant' | 'refused-wrong' | 'priced' = 'priced';
        let detail = '';
        try {
          defined.priceBatch!({
            instruments: batchInstruments,
            observations: declaredOnly,
            ...(requestSansSeed !== undefined ? { request: requestSansSeed } : {}),
          });
        } catch (error) {
          if (isQuantError(error, ErrorCode.InputMissingField) && error.message.includes('seed')) {
            outcome = 'refused-conformant';
          } else {
            outcome = 'refused-wrong';
            detail = error instanceof Error ? error.message : String(error);
          }
        }
        if (outcome === 'priced') {
          nonconformant(
            i,
            `claims randomness: 'seeded' but priceBatch() SUCCEEDED without request.seed — a ` +
              `batch that silently defaults a seed is nonconformant, because a defaulted seed is ` +
              `unreproducible: no caller can replay results priced under randomness they never ` +
              `chose. The missing-seed law covers every pricing entry point; refuse with ` +
              `'${ErrorCode.InputMissingField}' naming request.seed, exactly as price() must`,
          );
        }
        if (outcome === 'refused-wrong') {
          nonconformant(
            i,
            `priceBatch() without request.seed threw the wrong refusal — expected code ` +
              `'${ErrorCode.InputMissingField}' with a message naming "seed" (the same ` +
              `missing-seed law price() obeys), got: ${detail}`,
          );
        }
      }

      const rows = batchOnce('baseline batch', declaredOnly, baseRequest);
      // Per-item canonical forms of the conformant baseline batch — the fixed points the batch
      // seed-ignoring and batch independence probes below compare against.
      const batchCanonicals: string[] = [];
      for (let itemIndex = 0; itemIndex < rows.length; itemIndex++) {
        const row = rows[itemIndex];
        // For 'seeded', item 0 under the base seed IS the base scalar result and later items
        // reprice the scalar path under the derived seed; for 'none', every item is a copy of the
        // probe instrument, so every item must equal the base scalar result. Comparison stays
        // COMPLETE-canonical in both modes.
        const expectedCanonical =
          itemIndex === 0 || !seeded
            ? baseCanonical
            : canonicalOf(
                `batch-derivation scalar (seed ${probeSeed + itemIndex})`,
                priceOnce(declaredOnly, { ...requestSansSeed, seed: probeSeed + itemIndex }),
              );
        const rowCanonical = isComputed(row)
          ? canonicalOf(`batch item ${itemIndex}`, row as unknown as TValuation)
          : undefined;
        if (rowCanonical === undefined || rowCanonical !== expectedCanonical) {
          nonconformant(
            i,
            seeded
              ? `priceBatch() breaks the seeded batch derivation law at item ${itemIndex} — ` +
                  `priceBatch(instruments, obs, { …request, seed }) item i must deep-equal ` +
                  `price(instruments[i], obs, { …request, seed: seed + i }) (the documented ` +
                  `derivation on PricerValuationRequest.seed), and item ${itemIndex} does not ` +
                  `match the scalar result under seed ${probeSeed + itemIndex}. A batch that ` +
                  'draws its own way cannot be replayed item-by-item'
              : `priceBatch() disagrees with price() at item ${itemIndex} for the same instrument ` +
                  'and observations — the batch path must be provably the same pricing, not a ' +
                  'second implementation, and agreement covers the COMPLETE result (value, greeks, ' +
                  'assumptions, diagnostics): a batch row whose assumptions differ from the scalar ' +
                  'call was priced under different economics even when the numbers happen to coincide',
            {
              scalar: base.value,
              item: itemIndex,
              batch: isComputed(row) ? (row as Computed<number>).value : row,
            },
          );
        }
        batchCanonicals.push(rowCanonical);
      }

      // 5c-ignore ('none', 2026-08-23, fourth external review): the seed-ignoring law on the
      // batch path — a supplied request.seed must leave every batch item's COMPLETE result
      // identical to the seedless baseline. A batch that changes under a seed consumes randomness
      // it did not declare, even when its scalar path ignores the same seed.
      if (!seeded) {
        const withSeedRows = batchOnce('batch seed-ignoring', declaredOnly, {
          ...requestSansSeed,
          seed: probeSeed,
        });
        for (let itemIndex = 0; itemIndex < withSeedRows.length; itemIndex++) {
          const row = withSeedRows[itemIndex];
          if (
            !isComputed(row) ||
            canonicalOf(`batch seed-ignoring item ${itemIndex}`, row as unknown as TValuation) !==
              batchCanonicals[itemIndex]
          ) {
            nonconformant(
              i,
              `claims randomness: 'none' but supplying request.seed ${probeSeed} changed ` +
                `priceBatch() item ${itemIndex}'s COMPLETE result — a 'none' pricer must ignore a ` +
                'seed on EVERY pricing entry point (the scalar path proved it; the batch path ' +
                "must too); if the seed genuinely participates, declare randomness: 'seeded'",
              { item: itemIndex },
            );
          }
        }
      }

      // 5c-independence (both modes, 2026-08-23, fourth external review): undeclared observations
      // (the probe's extras plus the injected foreign one) must leave every batch item identical —
      // for 'seeded' under the same fixed seed, so any difference is a data read, never a draw.
      // A pricer that ignores undeclared data scalar-by-scalar but reads it on the batch path is
      // consuming market data a runner cannot know to feed it.
      const withExtrasRows = batchOnce(
        'batch undeclared-independence',
        [...declaredOnly, ...extras, FOREIGN_OBSERVATION],
        baseRequest,
      );
      for (let itemIndex = 0; itemIndex < withExtrasRows.length; itemIndex++) {
        const row = withExtrasRows[itemIndex];
        if (
          !isComputed(row) ||
          canonicalOf(
            `batch undeclared-independence item ${itemIndex}`,
            row as unknown as TValuation,
          ) !== batchCanonicals[itemIndex]
        ) {
          nonconformant(
            i,
            `priceBatch() result changed at item ${itemIndex} when undeclared observations were ` +
              'supplied — the pricer consumes market data it does not declare in requirements() ' +
              'on the batch path, so a runner cannot know what it feeds it (the COMPLETE results ' +
              'must be identical: value, greeks, assumptions, and diagnostics)',
            { item: itemIndex },
          );
        }
      }
    }

    // 6. Selection honesty.
    const selection = base.diagnostics.selection;
    if (probe.expectSelection !== undefined && selection === undefined) {
      nonconformant(
        i,
        `probe expects a ${probe.expectSelection} selection report but diagnostics.selection is ` +
          'absent — a pricer that chooses an engine must show its work',
      );
    }
    if (selection !== undefined) {
      let checked: SelectionReport;
      try {
        checked = validateSelectionReport(functionName, selection);
      } catch (error) {
        nonconformant(
          i,
          `diagnostics.selection violates the report grammar: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (probe.expectSelection !== undefined && checked.mode !== probe.expectSelection) {
        nonconformant(
          i,
          `expected a ${probe.expectSelection} selection report but got mode "${checked.mode}"`,
        );
      }
      const engineName = base.diagnostics.engine;
      if (engineName !== undefined && engineName !== checked.selected.name) {
        nonconformant(
          i,
          `diagnostics.engine ("${engineName}") disagrees with selection.selected.name ` +
            `("${checked.selected.name}") — one selection, one story`,
          { engine: engineName, selected: checked.selected.name },
        );
      }
    }
  }

  return defined;
}

/** `requirements()` with teaching failure handling, shared by the probe loop. */
function readRequirements<TInstrument>(
  pricer: { requirements(instrument: TInstrument): readonly MarketRequirement[] },
  instrument: TInstrument,
  index: number,
  nonconformant: (index: number, what: string, context?: Record<string, unknown>) => never,
): readonly MarketRequirement[] {
  let declared: unknown;
  try {
    declared = pricer.requirements(instrument);
  } catch (error) {
    nonconformant(
      index,
      `requirements() threw: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(declared)) {
    nonconformant(index, `requirements() returned ${String(declared)} instead of an array`);
  }
  return declared as readonly MarketRequirement[];
}
