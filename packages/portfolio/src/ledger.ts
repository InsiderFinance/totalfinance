/**
 * `@totalfinance/portfolio/ledger` — the immutable, reusable ledger artifact and its serialization
 * THROUGH the Gate B artifact spine (`docs/specs/gate-b-artifact-spine.md`), never a second
 * envelope invention:
 *
 * - the serialized form is a versioned envelope (`kind: 'totalfinance.portfolio-ledger'`,
 *   `schemaVersion`) whose canonical bytes and `sha256:` identity come from
 *   `@totalfinance/core/artifacts` (`canonicalJsonOf` / `contentHash`);
 * - the envelope stores the EVENTS, never the derived state: a ledger IS a fold over its events
 *   (Permanent law 1), so `readPortfolioLedgerSnapshot` restores by RE-FOLDING — replay is the
 *   deserializer, and a state that could drift from its events cannot exist;
 * - create/read symmetry mirrors `readMarketSnapshot` exactly: closed envelope keys, kind check,
 *   newer-version refusal, older versions only through an explicitly registered
 *   `createArtifactMigrationRegistry` chain (the registry is an ARGUMENT, never module-global
 *   state), full re-validation, frozen canonical result, and a `migrationsApplied` report;
 * - identity excludes provenance at BOTH levels (ledger and event) — Gate B Decision 3: two
 *   sources delivering identical economic facts are the SAME ledger; the lot-relief policy and
 *   base currency are INSIDE identity because they change the derived economics.
 */

import type { Provenance } from '@totalfinance/core';
import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import type { AppliedMigration, ArtifactMigrationRegistry } from '@totalfinance/core/artifacts';
import {
  canonicalJsonOf,
  contentHash,
  createArtifactMigrationRegistry,
  fromCanonicalJson,
} from '@totalfinance/core/artifacts';
import type { PortfolioEventEnvelope } from './events.js';
import { duplicateBoundaryKey } from './events.js';
import type { LotReliefPolicy, PortfolioState } from './state.js';
import { applyPortfolioEvents } from './state.js';
import type { PortfolioPnlInput, PortfolioPnlResult } from './pnl.js';
import { portfolioPnl } from './pnl.js';
import type { PortfolioTimelineInput, PortfolioTimelineResult } from './timeline.js';
import { portfolioTimeline } from './timeline.js';
import {
  deepFreeze,
  describeInputValue,
  requireDenseDataArray,
  requireNoInheritedFields,
  requirePlainDataObject,
  requireProvenanceShape,
} from './internal.js';

// Subpath completeness: `@totalfinance/portfolio/ledger` consumers can name the fold's contracts.
export type { LotReliefPolicy, PortfolioState } from './state.js';
export type { PortfolioEventEnvelope } from './events.js';

export const PORTFOLIO_LEDGER_KIND = 'totalfinance.portfolio-ledger';

/**
 * Current ledger-envelope schema version. Bump ONLY with a shape change, landed together with a
 * registered migration — `readPortfolioLedgerSnapshot` refuses an older stored version without
 * one, and refuses a newer version outright (this build cannot know what changed).
 */
export const PORTFOLIO_LEDGER_SCHEMA_VERSION = 1;

/**
 * The serialized ledger: pure JSON, canonical-JSON-stable, storable anywhere. Derived state is
 * deliberately ABSENT — restoring re-folds the events, so the stored form can never disagree
 * with the accounting that produced it.
 */
export interface PortfolioLedgerSnapshot {
  kind: typeof PORTFOLIO_LEDGER_KIND;
  schemaVersion: number;
  portfolioId?: string;
  baseCurrency: string;
  /** The lot-relief policy the fold runs under — INSIDE the content identity (it changes P&L). */
  lotRelief: LotReliefPolicy;
  events: PortfolioEventEnvelope[];
  /** Ledger-level provenance — caller-supplied, preserved, OUTSIDE the content identity. */
  provenance?: Provenance;
}

/** Input for {@link createPortfolioLedger}. */
export interface CreatePortfolioLedgerInput {
  portfolioId?: string;
  baseCurrency: string;
  /** Defaults to `'fifo'`; echoed on the artifact, the state, and every serialized envelope. */
  lotRelief?: LotReliefPolicy;
  events: readonly PortfolioEventEnvelope[];
  provenance?: Provenance;
}

/**
 * The immutable reusable ledger artifact (the agent-native doc's decided API ladder). It earns
 * its existence through repeated queries, identity, migration, and replay; it does not hide the
 * reducer (`applyPortfolioEvents` stays independently public) and requires no storage.
 */
export interface PortfolioLedger {
  readonly portfolioId?: string;
  readonly baseCurrency: string;
  readonly lotRelief: LotReliefPolicy;
  /** The applied economic events, canonical and frozen. Identical no-op replays are not stored. */
  readonly events: readonly PortfolioEventEnvelope[];
  /** The derived state — the fold of `events` under `lotRelief`. */
  readonly state: PortfolioState;
  readonly provenance?: Provenance;
  /** Fold more events and return a NEW immutable ledger; this one is untouched. */
  apply(events: readonly PortfolioEventEnvelope[]): PortfolioLedger;
  /** The serialized envelope (also what `JSON.stringify(ledger)` emits). */
  toJSON(): PortfolioLedgerSnapshot;
  /** `portfolioPnl` over this ledger (slice 2; the agent-native API ladder's `ledger.pnl`). */
  pnl(input: Omit<PortfolioPnlInput, 'ledger'>): PortfolioPnlResult;
  /** `portfolioTimeline` over this ledger (slice 2). */
  timeline(input: Omit<PortfolioTimelineInput, 'ledger'>): PortfolioTimelineResult;
}

const CREATE_KEYS = ['portfolioId', 'baseCurrency', 'lotRelief', 'events', 'provenance'] as const;
const ENVELOPE_KEYS = [
  'kind',
  'schemaVersion',
  'portfolioId',
  'baseCurrency',
  'lotRelief',
  'events',
  'provenance',
] as const;

const EXAMPLE_CREATE =
  "createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events })";

/**
 * Keep each `(sourceId, eventId)` exactly once, in first-delivery order. The reducer already
 * no-ops identical replays (and throws on conflicting ones — it runs FIRST), so a stored
 * duplicate would change the envelope's bytes and hash without changing any economics.
 */
function dedupeAppendedEvents(
  events: readonly PortfolioEventEnvelope[],
  alreadyApplied: Readonly<Record<string, string>>,
): PortfolioEventEnvelope[] {
  const seen = new Set<string>(Object.keys(alreadyApplied));
  const kept: PortfolioEventEnvelope[] = [];
  for (const envelope of events) {
    const key = duplicateBoundaryKey(envelope);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(envelope);
  }
  return kept;
}

function buildLedger(
  portfolioId: string | undefined,
  baseCurrency: string,
  lotRelief: LotReliefPolicy,
  events: readonly PortfolioEventEnvelope[],
  state: PortfolioState,
  provenance: Provenance | undefined,
): PortfolioLedger {
  const snapshot: PortfolioLedgerSnapshot = deepFreeze(
    fromCanonicalJson(
      canonicalJsonOf({
        kind: PORTFOLIO_LEDGER_KIND,
        schemaVersion: PORTFOLIO_LEDGER_SCHEMA_VERSION,
        ...(portfolioId !== undefined ? { portfolioId } : {}),
        baseCurrency,
        lotRelief,
        events,
        ...(provenance !== undefined ? { provenance } : {}),
      }),
    ) as PortfolioLedgerSnapshot,
  );
  const ledger: PortfolioLedger = {
    ...(portfolioId !== undefined ? { portfolioId } : {}),
    baseCurrency,
    lotRelief,
    events: snapshot.events,
    state,
    ...(provenance !== undefined ? { provenance: snapshot.provenance! } : {}),
    pnl(input: Omit<PortfolioPnlInput, 'ledger'>): PortfolioPnlResult {
      requireArgumentObject('pnl', 'input', input);
      return portfolioPnl({ ...input, ledger });
    },
    timeline(input: Omit<PortfolioTimelineInput, 'ledger'>): PortfolioTimelineResult {
      requireArgumentObject('timeline', 'input', input);
      return portfolioTimeline({ ...input, ledger });
    },
    apply(moreEvents: readonly PortfolioEventEnvelope[]): PortfolioLedger {
      requireArgumentArray('apply', 'events', moreEvents);
      const nextState = applyPortfolioEvents({ previousState: state, events: moreEvents });
      const appended = dedupeAppendedEvents(moreEvents, state.appliedEvents);
      return buildLedger(
        portfolioId,
        baseCurrency,
        lotRelief,
        [...snapshot.events, ...appended],
        nextState,
        provenance,
      );
    },
    toJSON(): PortfolioLedgerSnapshot {
      return snapshot;
    },
  };
  return Object.freeze(ledger);
}

/**
 * Build the immutable ledger artifact from a definition and its economic events. Validates every
 * envelope, folds the state through `applyPortfolioEvents` (the ONE reducer — no second engine),
 * and returns a frozen artifact whose serialized form rides the Gate B spine.
 *
 * @example
 * ```ts
 * import { createPortfolioLedger, readPortfolioLedgerSnapshot } from '@totalfinance/portfolio';
 *
 * const ledger = createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events });
 * const nextLedger = ledger.apply(moreEvents); // NEW artifact; `ledger` is untouched
 * const stored = JSON.stringify(nextLedger); // the versioned envelope
 * const { ledger: restored } = readPortfolioLedgerSnapshot({ snapshot: JSON.parse(stored) });
 * // restored.state deep-equals nextLedger.state — replay IS the deserializer
 * ```
 */
export function createPortfolioLedger(input: CreatePortfolioLedgerInput): PortfolioLedger {
  const functionName = 'createPortfolioLedger';
  requirePlainDataObject(functionName, 'input', input);
  requireNoInheritedFields(functionName, 'input', input, CREATE_KEYS);
  ensureKnownKeys(functionName, 'input', input, CREATE_KEYS);
  // Read each stored member once. Besides making the fold easier to audit, this prevents a live
  // accessor from returning one event list to the reducer and another to the serialized ledger.
  const { portfolioId, baseCurrency, lotRelief, events: rawEvents, provenance } = input;
  if (baseCurrency === undefined) {
    throw new InputError(
      `${functionName}: baseCurrency is required — a ledger states the currency its portfolio reports in.\n  e.g. ${EXAMPLE_CREATE}`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'baseCurrency' },
      },
    );
  }
  if (provenance !== undefined) {
    requireProvenanceShape(functionName, 'provenance', provenance);
  }
  requireDenseDataArray(functionName, 'events', rawEvents);
  const events = rawEvents as PortfolioEventEnvelope[];
  const state = applyPortfolioEvents({
    portfolio: {
      ...(portfolioId !== undefined ? { portfolioId } : {}),
      baseCurrency,
      ...(lotRelief !== undefined ? { lotRelief } : {}),
    },
    events,
  });
  const deduplicatedEvents = dedupeAppendedEvents(events, {});
  return buildLedger(
    portfolioId,
    baseCurrency,
    state.lotRelief,
    deduplicatedEvents,
    state,
    provenance,
  );
}

/** Structural test for a (current-version) serialized ledger envelope. */
export function isPortfolioLedgerSnapshot(value: unknown): value is PortfolioLedgerSnapshot {
  try {
    readPortfolioLedgerSnapshot({ snapshot: value });
    return true;
  } catch {
    return false;
  }
}

/** Input for {@link readPortfolioLedgerSnapshot}. */
export interface ReadPortfolioLedgerSnapshotInput {
  snapshot: unknown;
  /** Explicitly registered migrations for OLDER stored versions — never module-global state. */
  migrations?: ArtifactMigrationRegistry;
}

/**
 * The ONE door back in for stored ledgers: validates the envelope (closed key set, kind, version)
 * BEFORE reading any event, applies explicitly registered migrations for older versions, refuses
 * newer versions, then restores by RE-FOLDING the events through `createPortfolioLedger` — full
 * re-validation and deterministic replay in one step — and reports the exact migrations applied.
 */
export function readPortfolioLedgerSnapshot(input: ReadPortfolioLedgerSnapshotInput): {
  ledger: PortfolioLedger;
  migrationsApplied: AppliedMigration[];
} {
  const functionName = 'readPortfolioLedgerSnapshot';
  const inputKeys = ['snapshot', 'migrations'] as const;
  requirePlainDataObject(functionName, 'input', input);
  requireNoInheritedFields(functionName, 'input', input, inputKeys);
  ensureKnownKeys(functionName, 'input', input, inputKeys);
  // `?? createArtifactMigrationRegistry()` would treat an explicit `migrations: null` (or a
  // non-registry) as "no migrations" — null is a stated value, and a registry that lacks the
  // three methods cannot upgrade anything (enforcement harness, 2026-08-28).
  if (input.migrations !== undefined) {
    const registry = input.migrations as Partial<ArtifactMigrationRegistry> | null;
    if (
      registry === null ||
      typeof registry !== 'object' ||
      typeof registry.register !== 'function' ||
      typeof registry.find !== 'function' ||
      typeof registry.upgrade !== 'function'
    ) {
      throw new InputError(
        `${functionName}: migrations must be an ArtifactMigrationRegistry (createArtifactMigrationRegistry() with register/find/upgrade) when provided — omit it to restore current-version envelopes only. Received ${registry === null ? 'null' : typeof registry}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: 'migrations' },
        },
      );
    }
  }
  const raw = input.snapshot;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError(
      `${functionName}: snapshot must be a PortfolioLedgerSnapshot envelope object ({ kind, schemaVersion, baseCurrency, lotRelief, events }). Received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
      {
        code: ErrorCode.SnapshotWrongShape,
        context: { received: raw === null ? 'null' : typeof raw },
      },
    );
  }
  requirePlainDataObject(functionName, 'snapshot', raw);
  requireNoInheritedFields(functionName, 'snapshot', raw, ENVELOPE_KEYS);
  const candidate = raw as Record<string, unknown>;
  ensureKnownKeys(functionName, 'snapshot', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== PORTFOLIO_LEDGER_KIND) {
    const received = describeInputValue(candidate['kind']);
    throw new InputError(
      `${functionName}: snapshot.kind is ${received}, not '${PORTFOLIO_LEDGER_KIND}' — this reader restores portfolio ledgers only.`,
      { code: ErrorCode.SnapshotKindMismatch, context: { received } },
    );
  }
  const version = candidate['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    const received = describeInputValue(version);
    throw new InputError(`${functionName}: snapshot has an invalid schema version: ${received}.`, {
      code: ErrorCode.SnapshotInvalidVersion,
      context: { received },
    });
  }
  if (version > PORTFOLIO_LEDGER_SCHEMA_VERSION) {
    throw new InputError(
      `${functionName}: snapshot schema version ${version} is newer than this build supports (${PORTFOLIO_LEDGER_SCHEMA_VERSION}). Upgrade @totalfinance/portfolio to restore it — restoring blind would misread economic state.`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { version, supported: PORTFOLIO_LEDGER_SCHEMA_VERSION },
      },
    );
  }
  let envelope = candidate;
  let migrationsApplied: AppliedMigration[] = [];
  if (version < PORTFOLIO_LEDGER_SCHEMA_VERSION) {
    const registry = input.migrations ?? createArtifactMigrationRegistry();
    ({ envelope, migrationsApplied } = registry.upgrade({
      envelope,
      targetVersion: PORTFOLIO_LEDGER_SCHEMA_VERSION,
    }));
    requirePlainDataObject(functionName, 'migrated snapshot', envelope);
    requireNoInheritedFields(functionName, 'migrated snapshot', envelope, ENVELOPE_KEYS);
    ensureKnownKeys(functionName, 'migrated snapshot', envelope, ENVELOPE_KEYS);
  }
  const body = envelope as unknown as PortfolioLedgerSnapshot;
  // The envelope ECHOES its fold policy; a stored ledger without one must not silently default.
  if (
    body.lotRelief !== 'fifo' &&
    body.lotRelief !== 'lifo' &&
    body.lotRelief !== 'highest-cost' &&
    body.lotRelief !== 'specific-lot'
  ) {
    const received = describeInputValue(body.lotRelief);
    throw new InputError(
      `${functionName}: snapshot.lotRelief must be 'fifo' | 'lifo' | 'highest-cost' | 'specific-lot' — a serialized ledger always states the relief policy its realized figures were folded under. Received ${received}.`,
      {
        code:
          body.lotRelief === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'snapshot.lotRelief', received },
      },
    );
  }
  const ledger = createPortfolioLedger({
    ...(body.portfolioId !== undefined ? { portfolioId: body.portfolioId } : {}),
    baseCurrency: body.baseCurrency,
    lotRelief: body.lotRelief,
    events: body.events,
    ...(body.provenance !== undefined ? { provenance: body.provenance } : {}),
  });
  return { ledger, migrationsApplied };
}

/**
 * The ledger's content identity: `sha256:` over the canonical envelope with `provenance` removed
 * at BOTH levels — the ledger's own and every event's (Gate B Decision 3: identical economic
 * facts from two vendors are the SAME ledger; dedup and replay comparison depend on that).
 * `baseCurrency` and `lotRelief` ARE covered: they change the derived economics, so two ledgers
 * differing only in relief policy must never collide. The envelope is fully validated through the
 * read path first — a malformed envelope never acquires a confident-looking hash (the Gate B
 * serial-landing lesson) — and identity is defined over the CURRENT grammar: hash an older stored
 * version by reading it with its registered migrations and hashing `ledger.toJSON()`.
 */
export function portfolioLedgerContentHash(snapshot: PortfolioLedgerSnapshot): string {
  const { ledger } = readPortfolioLedgerSnapshot({ snapshot });
  const validated = ledger.toJSON();
  return contentHash({
    kind: validated.kind,
    schemaVersion: validated.schemaVersion,
    ...(validated.portfolioId !== undefined ? { portfolioId: validated.portfolioId } : {}),
    baseCurrency: validated.baseCurrency,
    lotRelief: validated.lotRelief,
    events: validated.events.map((event) => {
      const body: Record<string, unknown> = { ...event };
      delete body['provenance'];
      return body;
    }),
  });
}
