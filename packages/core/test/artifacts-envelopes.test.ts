/**
 * Gate B acceptance laws for the spine envelopes:
 *
 * - replay determinism: create → serialize → read restores an identical envelope with an identical
 *   content hash;
 * - migration policy: newer versions refuse; older versions load ONLY through explicitly
 *   registered migrations, each application reported; migration is idempotent (reading a current
 *   envelope applies none);
 * - identity: artifact ids are stable across key order, cover every body field, exclude
 *   provenance, and are VERIFIED on read;
 * - the observation grammar refuses non-finite market data (absent, not NaN) while saved RESULTS
 *   keep their disclosed non-finite values through the wrapper.
 */

import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, isQuantError } from '@totalfinance/core';
import {
  ANALYSIS_ARTIFACT_SCHEMA_VERSION,
  MARKET_SNAPSHOT_KIND,
  MARKET_SNAPSHOT_SCHEMA_VERSION,
  SCENARIO_SET_SCHEMA_VERSION,
  canonicalJsonOf,
  contentHash,
  createAnalysisArtifact,
  createArtifactMigrationRegistry,
  createMarketSnapshot,
  requireInstantMarketSnapshot,
  createScenarioSet,
  createTableHandle,
  fromCanonicalJson,
  isAnalysisArtifact,
  isMarketSnapshot,
  isScenarioSet,
  isTableHandle,
  marketSnapshotContentHash,
  readAnalysisArtifact,
  readMarketSnapshot,
  readScenarioSet,
  scenarioSetContentHash,
} from '@totalfinance/core/artifacts';
import type { MarketSnapshotObservations } from '@totalfinance/core/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const OBSERVATIONS: MarketSnapshotObservations = {
  spots: { AAPL: { price: 195.3, currency: 'USD' } },
  riskFreeRates: { USD: 0.045 },
  dividendYields: { AAPL: 0.005 },
  volatilities: { AAPL: 0.24 },
  surfaces: {
    AAPL: {
      timeToExpiryYears: [0.25, 0.5],
      strikes: [180, 200, 220],
      impliedVolatilities: [
        [0.28, 0.24, 0.23],
        [0.27, 0.24, 0.235],
      ],
    },
  },
};

function buildSnapshot() {
  return createMarketSnapshot({
    asOf: '2026-07-20',
    conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
    observations: OBSERVATIONS,
    provenance: { provider: 'insiderfinance', dataset: 'eod', asOf: 1784505600000 },
  });
}

const LAW2_RESULT = {
  value: { gammaExposure: 1.25e9 },
  assumptions: { conventionsVersion: CONVENTIONS_VERSION, model: 'gex' },
  diagnostics: { warnings: [] },
};

describe('createMarketSnapshot', () => {
  it('stamps kind, schemaVersion, conventionsVersion, and records a bare date as date-granular (UTC midnight)', () => {
    const snapshot = buildSnapshot();
    expect(snapshot.kind).toBe(MARKET_SNAPSHOT_KIND);
    expect(snapshot.schemaVersion).toBe(MARKET_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.conventions.conventionsVersion).toBe(CONVENTIONS_VERSION);
    expect(snapshot.asOf).toBe(Date.UTC(2026, 6, 20));
    expect(snapshot.conventions.asOfConvention).toBe('date-midnight-utc');
    expect(isMarketSnapshot(snapshot)).toBe(true);
  });

  it('records an explicit instant, refuses a caller-set asOfConvention, and guards option pricing', () => {
    const zoned = createMarketSnapshot({ asOf: '2026-07-20T10:30:00-04:00', observations: {} });
    expect(zoned.conventions.asOfConvention).toBe('explicit-instant');
    expect(createMarketSnapshot({ asOf: 0, observations: {} }).conventions.asOfConvention).toBe(
      'explicit-instant',
    );
    expect(() =>
      createMarketSnapshot({
        asOf: 0,
        observations: {},
        conventions: { asOfConvention: 'explicit-instant' } as never,
      }),
    ).toThrow(/asOfConvention is stamped by the library/);
    // The guard: a dated ledger snapshot cannot answer an option pricer's "when". It is a typed door:
    // garbage is refused before any field is read, through the ONE snapshot reader.
    expect(requireInstantMarketSnapshot('t', zoned)).toBe(zoned.asOf);
    expect(() => requireInstantMarketSnapshot('t', null as never)).toThrow(/snapshot/);
    expect(() => requireInstantMarketSnapshot('', zoned)).toThrow(
      /functionName must be a non-empty string/,
    );
    expect(() =>
      requireInstantMarketSnapshot('t', {
        ...zoned,
        conventions: { ...zoned.conventions, extra: 1 },
      } as never),
    ).toThrow(/extra/);
    let caught: unknown;
    try {
      requireInstantMarketSnapshot('runScenarios', buildSnapshot());
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    if (!isQuantError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('time.valuation_instant_required');
    expect(caught.message).toMatch(
      /^runScenarios: the market snapshot was created from the bare date "2026-07-20"/,
    );
    expect(caught.message).toContain("usEquitySessionInstant('2026-07-20', 'close')");
    // A hand-assembled envelope must carry a valid convention, like conventionsVersion.
    expect(() =>
      readMarketSnapshot({
        snapshot: {
          ...zoned,
          conventions: { ...zoned.conventions, asOfConvention: 'guess' },
        } as never,
      }),
    ).toThrow(/asOfConvention must be 'explicit-instant' or 'date-midnight-utc'/);
  });

  it('returns a deeply frozen copy — later input mutation cannot reach it', () => {
    const observations = { spots: { AAPL: { price: 100 } } };
    const snapshot = createMarketSnapshot({ asOf: 0, observations });
    observations.spots.AAPL.price = 999;
    expect(snapshot.observations.spots?.['AAPL']?.price).toBe(100);
    expect(Object.isFrozen(snapshot.observations.spots?.['AAPL'])).toBe(true);
    expect(() => {
      (snapshot as { asOf: number }).asOf = 1;
    }).toThrowError();
  });

  it('refuses an unknown envelope key with a did-you-mean teaching error', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: {},
          // @ts-expect-error — misspelled field must be refused, not ignored
          provenence: {},
        }),
      ),
    ).toBe('input.unknown_field');
  });

  it('requires asOf and refuses a zone-less datetime (never the machine clock or zone)', () => {
    expect(
      codeOf(() =>
        // @ts-expect-error — asOf is required
        createMarketSnapshot({ observations: {} }),
      ),
    ).toBe('input.missing_field');
    expect(() =>
      createMarketSnapshot({ asOf: '2026-07-20T16:00:00', observations: {} }),
    ).toThrowError(/no timezone/);
  });

  it('refuses NaN market data: an unobservable quantity is absent, never NaN', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({ asOf: 0, observations: { spots: { AAPL: { price: Number.NaN } } } }),
      ),
    ).toBe('input.not_finite');
    // …including inside vendor DECORATION (the global finiteness walk).
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: {
            spots: { AAPL: { price: 100, vendorScore: Number.POSITIVE_INFINITY } as never },
          },
        }),
      ),
    ).toBe('input.not_finite');
    // …while finite decoration is preserved (Law 12: structural artifacts are open).
    const snapshot = createMarketSnapshot({
      asOf: 0,
      observations: { spots: { AAPL: { price: 100, vendorScore: 7 } as never } },
    });
    expect((snapshot.observations.spots?.['AAPL'] as { vendorScore?: number }).vendorScore).toBe(7);
  });

  it('refuses flat riskFreeRates without a stated compounding and day count (no silent economics)', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({ asOf: 0, observations: { riskFreeRates: { USD: 0.045 } } }),
      ),
    ).toBe('input.missing_field');
  });

  it('refuses a negative volatility observation', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({ asOf: 0, observations: { volatilities: { AAPL: -0.2 } } }),
      ),
    ).toBe('input.negative_volatility');
  });

  it('validates surface grid shape: one IV row per expiry, one column per strike', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: {
            surfaces: {
              AAPL: {
                timeToExpiryYears: [0.25],
                strikes: [100, 110],
                impliedVolatilities: [[0.2]],
              },
            },
          },
        }),
      ),
    ).toBe('input.length_mismatch');
  });

  it('requires a chain observation to carry exactly one of quotes or table', () => {
    expect(
      codeOf(() => createMarketSnapshot({ asOf: 0, observations: { chains: { AAPL: {} } } })),
    ).toBe('input.missing_field');
    const table = createTableHandle({
      contentHash: contentHash([{ strike: 190, bid: 3.1 }]),
      rowCount: 1,
      columnCount: 2,
    });
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: { chains: { AAPL: { quotes: [{ strike: 190 }], table } } },
        }),
      ),
    ).toBe('input.wrong_shape');
    const snapshot = createMarketSnapshot({
      asOf: 0,
      observations: { chains: { AAPL: { table } } },
    });
    expect(snapshot.observations.chains?.['AAPL']?.table?.contentHash).toBe(table.contentHash);
  });

  it('refuses a wrong-typed consumed numeric field in a chain quote, teaching with the row index', () => {
    expect(() =>
      createMarketSnapshot({
        asOf: 0,
        observations: {
          chains: { AAPL: { quotes: [{ strike: 190, bid: 3.1 }, { bid: 'oops' }] } },
        },
      }),
    ).toThrow(/observations\.chains\.AAPL\.quotes\[1\]\.bid must be a finite number when present/);
    // Vendor decoration outside the consumed vocabulary is preserved (Law 12), finite as ever.
    const snapshot = createMarketSnapshot({
      asOf: 0,
      observations: {
        chains: { AAPL: { quotes: [{ bid: 3.1, ask: 3.3, vendorNote: 'sweep', vendorScore: 7 }] } },
      },
    });
    expect(snapshot.observations.chains?.['AAPL']?.quotes?.[0]?.['vendorNote']).toBe('sweep');
  });

  it('validates a chain TableHandle fully — a count/columns mismatch or numeric locator refuses', () => {
    const malformed = {
      kind: 'totalfinance.table-handle',
      contentHash: contentHash([{ strike: 190, bid: 3.1 }]),
      rowCount: 1,
      columnCount: 2,
      columns: ['strike'],
      locator: 42,
    };
    expect(() =>
      createMarketSnapshot({
        asOf: 0,
        observations: { chains: { AAPL: { table: malformed as never } } },
      }),
    ).toThrow(/columns names 1 column but columnCount is 2/);
    const numericLocator = { ...malformed, columns: ['strike', 'bid'] };
    expect(() =>
      createMarketSnapshot({
        asOf: 0,
        observations: { chains: { AAPL: { table: numericLocator as never } } },
      }),
    ).toThrow(/locator must be a non-empty storage-reference string/);
  });

  it('validates stored curves as core RateCurve data: real dates, ascending pillars, typed interpolation', () => {
    const curve = {
      currency: 'USD',
      asOf: Date.UTC(2026, 6, 20),
      dayCount: 'ACT/365F' as const,
      compounding: 'continuous' as const,
      points: [
        { date: '2026-10-20', zeroRate: 0.045 },
        { date: '2027-07-20', zeroRate: 0.043 },
      ],
      interpolation: 'linearZero',
    };
    const withCurve = (overrides: Record<string, unknown>) =>
      createMarketSnapshot({
        asOf: 0,
        observations: { curves: { 'USD.sofr': { ...curve, ...overrides } as never } },
      });
    expect(withCurve({}).observations.curves?.['USD.sofr']?.interpolation).toBe('linearZero');
    expect(() => withCurve({ points: [{ date: '2025-02-30', zeroRate: 0.04 }] })).toThrow(
      /observations\.curves\.USD\.sofr\.points\[0\]\.date is not a real calendar date/,
    );
    expect(() =>
      withCurve({
        points: [
          { date: '2027-07-20', zeroRate: 0.043 },
          { date: '2026-10-20', zeroRate: 0.045 },
        ],
      }),
    ).toThrow(/must be strictly ascending by date/);
    expect(() => withCurve({ interpolation: 42 })).toThrow(
      /interpolation must be an interpolation-name string/,
    );
    expect(codeOf(() => withCurve({ dayCount: 'ACT/999' }))).toBe('input.invalid_enum');
  });

  it('refuses a caller-set conventionsVersion — the library stamps what it wrote', () => {
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          // @ts-expect-error — conventionsVersion is stamped, not supplied
          conventions: { conventionsVersion: '9.9.9' },
          observations: {},
        }),
      ),
    ).toBe('input.unknown_field');
  });
});

describe('readMarketSnapshot + hash', () => {
  it('replay determinism: JSON round-trip restores an identical envelope and identical hash', () => {
    const snapshot = buildSnapshot();
    const stored = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const { snapshot: restored, migrationsApplied } = readMarketSnapshot({ snapshot: stored });
    expect(migrationsApplied).toEqual([]);
    expect(restored).toEqual(snapshot);
    expect(marketSnapshotContentHash(restored)).toBe(marketSnapshotContentHash(snapshot));
  });

  it('provenance is preserved but OUTSIDE the content hash; conventions and asOf are INSIDE it', () => {
    const snapshot = buildSnapshot();
    const relabeled = createMarketSnapshot({
      asOf: '2026-07-20',
      conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
      observations: OBSERVATIONS,
      provenance: { provider: 'other-vendor' },
    });
    expect(relabeled.provenance?.provider).toBe('other-vendor');
    expect(marketSnapshotContentHash(relabeled)).toBe(marketSnapshotContentHash(snapshot));
    // The stamped asOfConvention is INSIDE the hash: the same epoch expressed as an instant is a
    // different artifact from the date-granular one (an option pricer treats them differently).
    const sameEpochAsInstant = createMarketSnapshot({
      asOf: '2026-07-20T00:00:00Z',
      conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
      observations: OBSERVATIONS,
    });
    expect(sameEpochAsInstant.asOf).toBe(snapshot.asOf);
    expect(marketSnapshotContentHash(sameEpochAsInstant)).not.toBe(
      marketSnapshotContentHash(snapshot),
    );

    const differentConvention = createMarketSnapshot({
      asOf: '2026-07-20T00:00:00Z',
      conventions: { dayCount: 'ACT/360', compounding: 'continuous' },
      observations: OBSERVATIONS,
    });
    expect(marketSnapshotContentHash(differentConvention)).not.toBe(
      marketSnapshotContentHash(snapshot),
    );
    const differentInstant = createMarketSnapshot({
      asOf: '2026-07-21T00:00:00Z',
      conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
      observations: OBSERVATIONS,
    });
    expect(marketSnapshotContentHash(differentInstant)).not.toBe(
      marketSnapshotContentHash(snapshot),
    );
  });

  it('refuses a NEWER schema version with an upgrade teaching error', () => {
    const stored = JSON.parse(JSON.stringify(buildSnapshot())) as Record<string, unknown>;
    stored['schemaVersion'] = MARKET_SNAPSHOT_SCHEMA_VERSION + 1;
    expect(codeOf(() => readMarketSnapshot({ snapshot: stored }))).toBe(
      'snapshot.unsupported_version',
    );
  });

  it('refuses a non-envelope and a wrong kind', () => {
    expect(codeOf(() => readMarketSnapshot({ snapshot: 42 }))).toBe('snapshot.wrong_shape');
    const wrongKind = { ...(JSON.parse(JSON.stringify(buildSnapshot())) as object), kind: 'other' };
    expect(codeOf(() => readMarketSnapshot({ snapshot: wrongKind }))).toBe(
      'snapshot.kind_mismatch',
    );
  });

  it('refuses an OLDER version without a migration — upgrades are explicit, never silent', () => {
    const stored = JSON.parse(JSON.stringify(buildSnapshot())) as Record<string, unknown>;
    stored['schemaVersion'] = 0;
    expect(codeOf(() => readMarketSnapshot({ snapshot: stored }))).toBe(
      'artifact.migration_missing',
    );
  });

  it('applies a registered migration chain, reports each step, and the result re-reads cleanly', () => {
    const v0 = JSON.parse(JSON.stringify(buildSnapshot())) as Record<string, unknown>;
    v0['schemaVersion'] = 0;
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: MARKET_SNAPSHOT_KIND,
      fromVersion: 0,
      toVersion: 1,
      description: 'synthetic test upgrade: v0 and v1 share a shape',
      migrate: (envelope) => ({ ...envelope, schemaVersion: 1 }),
    });
    const { snapshot: migrated, migrationsApplied } = readMarketSnapshot({
      snapshot: v0,
      migrations,
    });
    expect(migrationsApplied).toEqual([
      {
        kind: MARKET_SNAPSHOT_KIND,
        fromVersion: 0,
        toVersion: 1,
        description: 'synthetic test upgrade: v0 and v1 share a shape',
      },
    ]);
    // Migration idempotence: the migrated envelope re-reads as CURRENT with no further steps.
    const again = readMarketSnapshot({
      snapshot: JSON.parse(JSON.stringify(migrated)),
      migrations,
    });
    expect(again.migrationsApplied).toEqual([]);
    expect(again.snapshot).toEqual(migrated);
  });
});

describe('artifact migration registry', () => {
  it('refuses a duplicate registration for one (kind, fromVersion)', () => {
    const migrations = createArtifactMigrationRegistry();
    const step = {
      kind: 'totalfinance.test-envelope',
      fromVersion: 0,
      toVersion: 1,
      description: 'first',
      migrate: (envelope: Record<string, unknown>) => ({ ...envelope, schemaVersion: 1 }),
    };
    migrations.register(step);
    expect(codeOf(() => migrations.register({ ...step, description: 'second' }))).toBe(
      'artifact.duplicate_migration',
    );
  });

  it('refuses a step that skips versions — chains are single reviewable steps', () => {
    const migrations = createArtifactMigrationRegistry();
    expect(
      codeOf(() =>
        migrations.register({
          kind: 'totalfinance.test-envelope',
          fromVersion: 0,
          toVersion: 2,
          description: 'skip',
          migrate: (envelope) => envelope,
        }),
      ),
    ).toBe('input.out_of_range');
  });

  it('walks a multi-step chain in order and refuses the first missing link', () => {
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: 'totalfinance.test-envelope',
      fromVersion: 0,
      toVersion: 1,
      description: 'zero to one',
      migrate: (envelope) => ({ ...envelope, schemaVersion: 1, a: 1 }),
    });
    migrations.register({
      kind: 'totalfinance.test-envelope',
      fromVersion: 1,
      toVersion: 2,
      description: 'one to two',
      migrate: (envelope) => ({ ...envelope, schemaVersion: 2, b: 2 }),
    });
    const { envelope, migrationsApplied } = migrations.upgrade({
      envelope: { kind: 'totalfinance.test-envelope', schemaVersion: 0 },
      targetVersion: 2,
    });
    expect(envelope).toEqual({ kind: 'totalfinance.test-envelope', schemaVersion: 2, a: 1, b: 2 });
    expect(migrationsApplied.map((m) => `${m.fromVersion}->${m.toVersion}`)).toEqual([
      '0->1',
      '1->2',
    ]);
    expect(
      codeOf(() =>
        migrations.upgrade({
          envelope: { kind: 'totalfinance.test-envelope', schemaVersion: 0 },
          targetVersion: 3,
        }),
      ),
    ).toBe('artifact.migration_missing');
  });

  it('convicts a migration that stamps the wrong version', () => {
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: 'totalfinance.test-envelope',
      fromVersion: 0,
      toVersion: 1,
      description: 'forgets the stamp',
      migrate: (envelope) => ({ ...envelope }),
    });
    expect(
      codeOf(() =>
        migrations.upgrade({
          envelope: { kind: 'totalfinance.test-envelope', schemaVersion: 0 },
          targetVersion: 1,
        }),
      ),
    ).toBe('snapshot.invalid_version');
  });
});

describe('createAnalysisArtifact', () => {
  const snapshotHash = marketSnapshotContentHash(buildSnapshot());

  function buildArtifact(parameters: unknown = { minOpenInterest: 100 }) {
    return createAnalysisArtifact({
      artifactType: 'structure.gamma-exposure',
      producedBy: { operation: 'gammaExposure', libraryVersion: '0.0.1' },
      inputs: { snapshotHash, parameters },
      result: LAW2_RESULT,
    });
  }

  it('stamps identity: id and inputsHash are content hashes; conventionsVersion is LIBRARY-stamped', () => {
    const artifact = buildArtifact();
    expect(artifact.schemaVersion).toBe(ANALYSIS_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.id.startsWith('sha256:')).toBe(true);
    expect(artifact.inputs.inputsHash).toBe(
      contentHash({ snapshotHash, parameters: { minOpenInterest: 100 } }),
    );
    // Stamped from core CONVENTIONS_VERSION at creation (the snapshot's law) — never an echo of
    // the result and never caller-set.
    expect(artifact.conventionsVersion).toBe(CONVENTIONS_VERSION);
  });

  it('saves a real Law-2 report whose assumptions carry NO conventionsVersion — the true floor', () => {
    const artifact = createAnalysisArtifact({
      artifactType: 'performance.time-weighted-return',
      producedBy: { operation: 'timeWeightedReturn' },
      result: {
        timeWeightedReturn: 0.05,
        assumptions: { flowTiming: 'at-flow-timestamp', linking: 'geometric' },
        diagnostics: { warnings: [] },
      },
    });
    expect(artifact.conventionsVersion).toBe(CONVENTIONS_VERSION);
    // When a result DOES carry assumptions.conventionsVersion, it rides along verbatim in result;
    // the top-level stamp is the library's, not the result's.
    const echoing = createAnalysisArtifact({
      artifactType: 'x.y',
      producedBy: { operation: 'x' },
      result: {
        value: 1,
        assumptions: { conventionsVersion: 'result-own-version' },
        diagnostics: { warnings: [] },
      },
    });
    expect(echoing.conventionsVersion).toBe(CONVENTIONS_VERSION);
    expect(
      (echoing.result['assumptions'] as { conventionsVersion: string }).conventionsVersion,
    ).toBe('result-own-version');
  });

  it('id is stable across parameter key order and changes when ANY covered field changes', () => {
    const one = createAnalysisArtifact({
      artifactType: 'structure.gamma-exposure',
      producedBy: { operation: 'gammaExposure', libraryVersion: '0.0.1' },
      inputs: { snapshotHash, parameters: { a: 1, b: 2 } },
      result: LAW2_RESULT,
    });
    const shuffled = createAnalysisArtifact({
      result: LAW2_RESULT,
      inputs: { parameters: { b: 2, a: 1 }, snapshotHash },
      producedBy: { libraryVersion: '0.0.1', operation: 'gammaExposure' },
      artifactType: 'structure.gamma-exposure',
    });
    expect(shuffled.id).toBe(one.id);
    expect(buildArtifact({ minOpenInterest: 101 }).id).not.toBe(buildArtifact().id);
    const differentOperation = createAnalysisArtifact({
      artifactType: 'structure.gamma-exposure',
      producedBy: { operation: 'gammaExposureProfile' },
      inputs: { snapshotHash, parameters: { minOpenInterest: 100 } },
      result: LAW2_RESULT,
    });
    expect(differentOperation.id).not.toBe(buildArtifact().id);
  });

  it('provenance is preserved but outside the id', () => {
    const labeled = createAnalysisArtifact({
      artifactType: 'structure.gamma-exposure',
      producedBy: { operation: 'gammaExposure', libraryVersion: '0.0.1' },
      inputs: { snapshotHash, parameters: { minOpenInterest: 100 } },
      result: LAW2_RESULT,
      provenance: { provider: 'insiderfinance' },
    });
    expect(labeled.id).toBe(buildArtifact().id);
    expect(labeled.provenance?.provider).toBe('insiderfinance');
  });

  it('refuses a result without the Law-2 floor (assumptions object, warnings channel present)', () => {
    expect(
      codeOf(() =>
        createAnalysisArtifact({
          artifactType: 'x.y',
          producedBy: { operation: 'x' },
          result: { value: 1 } as never,
        }),
      ),
    ).toBe('input.missing_field');
    expect(
      codeOf(() =>
        createAnalysisArtifact({
          artifactType: 'x.y',
          producedBy: { operation: 'x' },
          result: { value: 1, assumptions: 'annual', diagnostics: { warnings: [] } } as never,
        }),
      ),
    ).toBe('input.wrong_type');
    expect(
      codeOf(() =>
        createAnalysisArtifact({
          artifactType: 'x.y',
          producedBy: { operation: 'x' },
          result: {
            value: 1,
            assumptions: { conventionsVersion: '0.0.1' },
            diagnostics: {},
          } as never,
        }),
      ),
    ).toBe('input.missing_field');
  });

  it('carries createdFrom lineage and validated table handles', () => {
    const parent = buildArtifact();
    const rows = [
      { strike: 180, gammaExposure: 4.1e8 },
      { strike: 200, gammaExposure: -2.2e8 },
    ];
    const child = createAnalysisArtifact({
      artifactType: 'structure.gamma-exposure.profile',
      producedBy: { operation: 'gammaExposureProfile' },
      inputs: { snapshotHash },
      createdFrom: [parent.id],
      result: LAW2_RESULT,
      tables: {
        profile: createTableHandle({
          contentHash: contentHash(rows),
          rowCount: rows.length,
          columnCount: 2,
          columns: ['strike', 'gammaExposure'],
          locator: 'artifacts/gex/profile.json',
        }),
      },
    });
    expect(child.createdFrom).toEqual([parent.id]);
    expect(child.tables?.['profile']?.rowCount).toBe(2);
    expect(
      codeOf(() =>
        createAnalysisArtifact({
          artifactType: 'x.y',
          producedBy: { operation: 'x' },
          result: LAW2_RESULT,
          tables: { bad: { kind: 'totalfinance.table-handle' } as never },
        }),
      ),
    ).toBe('input.wrong_type');
    expect(
      codeOf(() =>
        createTableHandle({ contentHash: contentHash([]), rowCount: -1, columnCount: 0 }),
      ),
    ).toBe('input.out_of_range');
    expect(
      codeOf(() =>
        createTableHandle({
          contentHash: contentHash([]),
          rowCount: 0,
          columnCount: 2,
          columns: ['only-one'],
        }),
      ),
    ).toBe('input.length_mismatch');
  });

  it('a disclosed non-finite RESULT value round-trips losslessly through canonical JSON', () => {
    const artifact = createAnalysisArtifact({
      artifactType: 'technical-analysis.sma',
      producedBy: { operation: 'sma' },
      inputs: { parameters: { period: 3 } },
      result: {
        value: [Number.NaN, Number.NaN, 101.5],
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [], warmup: 2 },
      },
    });
    const text = canonicalJsonOf(artifact);
    expect(text).toContain('{"nonFinite":"NaN"}');
    const { artifact: restored, migrationsApplied } = readAnalysisArtifact({
      artifact: fromCanonicalJson(text),
    });
    expect(migrationsApplied).toEqual([]);
    const values = restored.result['value'] as number[];
    expect(Number.isNaN(values[0])).toBe(true);
    expect(values[2]).toBe(101.5);
    expect(restored.id).toBe(artifact.id);
  });
});

describe('readAnalysisArtifact', () => {
  const artifact = createAnalysisArtifact({
    artifactType: 'structure.gamma-exposure',
    producedBy: { operation: 'gammaExposure' },
    inputs: { parameters: { minOpenInterest: 100 } },
    result: LAW2_RESULT,
  });

  it('verifies the id: a tampered artifact is refused, not trusted', () => {
    const tampered = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (tampered['result'] as Record<string, unknown>)['value'] = { gammaExposure: 9.9e9 };
    expect(codeOf(() => readAnalysisArtifact({ artifact: tampered }))).toBe('artifact.id_mismatch');
  });

  it('verifies inputsHash: forged parameters are refused even under a re-minted outer id', () => {
    const forged = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const inputs = forged['inputs'] as Record<string, unknown>;
    // The forger changes the parameters WITHOUT restamping inputsHash…
    inputs['parameters'] = { minOpenInterest: 999 };
    // …and re-mints the OUTER id over the forged body, so the envelope is outer-consistent.
    forged['id'] = contentHash({
      kind: forged['kind'],
      schemaVersion: forged['schemaVersion'],
      artifactType: forged['artifactType'],
      producedBy: forged['producedBy'],
      conventionsVersion: forged['conventionsVersion'],
      inputs: forged['inputs'],
      result: forged['result'],
    });
    expect(codeOf(() => readAnalysisArtifact({ artifact: forged }))).toBe('artifact.id_mismatch');
    expect(() => readAnalysisArtifact({ artifact: forged })).toThrow(
      /inputs\.inputsHash does not match the stored inputs/,
    );
  });

  it('validates stored table handles FULLY: a count/columns mismatch and a numeric locator refuse', () => {
    const rows = [{ strike: 190, bid: 3.1 }];
    const forge = (handle: Record<string, unknown>) => {
      const body = {
        kind: 'totalfinance.analysis-artifact',
        schemaVersion: ANALYSIS_ARTIFACT_SCHEMA_VERSION,
        artifactType: 'x.y',
        producedBy: { operation: 'x' },
        conventionsVersion: CONVENTIONS_VERSION,
        inputs: { inputsHash: contentHash({}) },
        result: LAW2_RESULT,
        tables: { chain: handle },
      };
      return { ...body, id: contentHash(body) };
    };
    const base = {
      kind: 'totalfinance.table-handle',
      contentHash: contentHash(rows),
      rowCount: 1,
      columnCount: 2,
    };
    expect(() =>
      readAnalysisArtifact({ artifact: forge({ ...base, columns: ['strike'] }) }),
    ).toThrow(/columns names 1 column but columnCount is 2/);
    expect(() => readAnalysisArtifact({ artifact: forge({ ...base, locator: 42 }) })).toThrow(
      /locator must be a non-empty storage-reference string/,
    );
    expect(() => readAnalysisArtifact({ artifact: forge({ ...base, mediaType: 7 }) })).toThrow(
      /mediaType must be a non-empty media-type string/,
    );
    // A fully valid rich handle still restores.
    const valid = forge({
      ...base,
      columns: ['strike', 'bid'],
      locator: 'artifacts/chains/aapl.json',
      mediaType: 'application/json',
    });
    expect(readAnalysisArtifact({ artifact: valid }).artifact.tables?.['chain']?.locator).toBe(
      'artifacts/chains/aapl.json',
    );
  });

  it('refuses a stored artifact whose stamped conventionsVersion is not a non-empty string', () => {
    const forged = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    forged['conventionsVersion'] = '';
    expect(() => readAnalysisArtifact({ artifact: forged })).toThrow(
      /conventionsVersion must be a non-empty string/,
    );
  });

  it('restores an untampered artifact exactly', () => {
    const { artifact: restored } = readAnalysisArtifact({
      artifact: JSON.parse(JSON.stringify(artifact)),
    });
    expect(restored).toEqual(artifact);
    expect(Object.isFrozen(restored.result)).toBe(true);
  });

  it('refuses newer versions and non-envelopes with the shared codes', () => {
    const newer = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    newer['schemaVersion'] = ANALYSIS_ARTIFACT_SCHEMA_VERSION + 1;
    expect(codeOf(() => readAnalysisArtifact({ artifact: newer }))).toBe(
      'snapshot.unsupported_version',
    );
    expect(codeOf(() => readAnalysisArtifact({ artifact: [] }))).toBe('snapshot.wrong_shape');
  });
});

describe('scenario sets', () => {
  function buildSet() {
    return createScenarioSet({
      name: 'q3-desk-stress',
      scenarios: [
        {
          name: 'crash -20%',
          shocks: [
            { factor: 'spot', kind: 'percent', value: -0.2 },
            { factor: 'volatility', kind: 'absolute', value: 0.15 },
          ],
        },
        {
          name: 'rates 2019',
          shocks: [],
          overrides: [{ factor: 'riskFreeRate', value: 0.0155 }],
        },
        {
          name: 'aapl-only squeeze',
          shocks: [{ factor: 'spot', kind: 'percent', value: 0.1, target: 'AAPL' }],
        },
      ],
    });
  }

  it('creates a frozen, versioned set whose shock grammar matches @totalfinance/risk', () => {
    const set = buildSet();
    expect(set.schemaVersion).toBe(SCENARIO_SET_SCHEMA_VERSION);
    expect(Object.isFrozen(set.scenarios[0]!.shocks[0])).toBe(true);
    // The exact field triple risk's Taylor engine consumes — no adapter needed later.
    expect(set.scenarios[0]!.shocks[0]).toEqual({ factor: 'spot', kind: 'percent', value: -0.2 });
  });

  it('replay determinism: JSON round-trip restores an identical set and identical hash', () => {
    const set = buildSet();
    const { scenarioSet: restored, migrationsApplied } = readScenarioSet({
      scenarioSet: JSON.parse(JSON.stringify(set)),
    });
    expect(migrationsApplied).toEqual([]);
    expect(restored).toEqual(set);
    expect(scenarioSetContentHash(restored)).toBe(scenarioSetContentHash(set));
  });

  it('refuses duplicate scenario names — names are the row identity', () => {
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [
            { name: 'crash', shocks: [] },
            { name: 'crash', shocks: [] },
          ],
        }),
      ),
    ).toBe('input.out_of_range');
  });

  it('refuses conflicting overrides but allows repeated (composing) shocks', () => {
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [
            {
              name: 'conflict',
              shocks: [],
              overrides: [
                { factor: 'spot', target: 'AAPL', value: 200 },
                { factor: 'spot', target: 'AAPL', value: 210 },
              ],
            },
          ],
        }),
      ),
    ).toBe('input.out_of_range');
    const composed = createScenarioSet({
      name: 's',
      scenarios: [
        {
          name: 'compose',
          shocks: [
            { factor: 'spot', kind: 'percent', value: -0.05 },
            { factor: 'spot', kind: 'percent', value: -0.05 },
          ],
        },
      ],
    });
    expect(composed.scenarios[0]!.shocks).toHaveLength(2);
  });

  it('validates the shock records: kind enum, finite value, non-empty factor and target', () => {
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [{ name: 'x', shocks: [{ factor: 'spot', kind: 'pct' as never, value: 1 }] }],
        }),
      ),
    ).toBe('input.invalid_enum');
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [
            { name: 'x', shocks: [{ factor: 'spot', kind: 'percent', value: Number.NaN }] },
          ],
        }),
      ),
    ).toBe('input.not_finite');
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [{ name: 'x', shocks: [{ factor: '', kind: 'percent', value: 1 }] }],
        }),
      ),
    ).toBe('input.wrong_type');
  });

  it('refuses an empty set and a missing scenario name', () => {
    expect(codeOf(() => createScenarioSet({ name: 's', scenarios: [] }))).toBe(
      'input.out_of_range',
    );
    expect(
      codeOf(() => createScenarioSet({ name: 's', scenarios: [{ shocks: [] } as never] })),
    ).toBe('input.wrong_type');
  });
});

// ── Finding 4: the public `is*` guards are the FULL validators behind a boolean door ────────────

describe('sound type guards (a guard may not be a weaker law than its validator)', () => {
  it('isTableHandle refuses every malformation requireTableHandle refuses — and accepts rich valid handles', () => {
    const valid = createTableHandle({
      contentHash: contentHash([{ strike: 190 }]),
      rowCount: 1,
      columnCount: 2,
      columns: ['strike', 'bid'],
      locator: 'artifacts/chains/aapl.json',
      mediaType: 'application/json',
    });
    expect(isTableHandle(valid)).toBe(true);
    expect(isTableHandle(JSON.parse(JSON.stringify(valid)))).toBe(true);
    // The reproduced defect: a numeric `columns` passed the shallow guard, then detonated at the
    // first envelope site that trusted `value is TableHandle`.
    expect(isTableHandle({ ...valid, columns: 42 })).toBe(false);
    expect(isTableHandle({ ...valid, columns: ['strike'] })).toBe(false); // length ≠ columnCount
    expect(isTableHandle({ ...valid, locator: '' })).toBe(false);
    expect(isTableHandle({ ...valid, mediaType: '' })).toBe(false);
    expect(isTableHandle({ ...valid, rowCount: 1.5 })).toBe(false);
    expect(isTableHandle(null)).toBe(false);
    expect(isTableHandle([valid])).toBe(false);
  });

  it('table handles refuse empty-string and DUPLICATE column names, and an empty mediaType', () => {
    const base = { contentHash: contentHash([]), rowCount: 0, columnCount: 2 };
    expect(() => createTableHandle({ ...base, columns: ['strike', ''] })).toThrow(
      /NON-EMPTY column-name strings/,
    );
    expect(() => createTableHandle({ ...base, columns: ['strike', 'strike'] })).toThrow(
      /columns names "strike" twice/,
    );
    expect(codeOf(() => createTableHandle({ ...base, columns: ['strike', 'strike'] }))).toBe(
      'input.out_of_range',
    );
    expect(() => createTableHandle({ ...base, mediaType: '' })).toThrow(
      /mediaType must be a non-empty media-type string/,
    );
  });

  it('2026-08-23 P0: table counts must be SAFE integers — 2^53 and 1e308 are refusals, 2^53 − 1 is not', () => {
    // `Number.isInteger(1e308)` is `true`, so the old gate accepted a rowCount no double can
    // count to; above 2^53 an "integer" count is no longer exact. Counts are metadata here (no
    // loop or allocation), so the boundary is exactly the safe-integer range — no practical cap.
    const base = { contentHash: contentHash([]), rowCount: 0, columnCount: 0 };
    for (const unsafe of [2 ** 53, 2 ** 53 + 2, 1e308]) {
      expect(
        codeOf(() => createTableHandle({ ...base, rowCount: unsafe })),
        `rowCount ${unsafe}`,
      ).toBe('input.out_of_range');
      expect(
        codeOf(() => createTableHandle({ ...base, columnCount: unsafe })),
        `columnCount ${unsafe}`,
      ).toBe('input.out_of_range');
    }
    expect(() => createTableHandle({ ...base, rowCount: 2 ** 53 })).toThrow(/safe integer/);
    // The guard is the same law behind a boolean door.
    const valid = createTableHandle({ ...base, rowCount: 1_000_000 });
    expect(isTableHandle(valid)).toBe(true);
    expect(isTableHandle({ ...valid, rowCount: 2 ** 53 })).toBe(false);
    expect(isTableHandle({ ...valid, rowCount: 1e308 })).toBe(false);
    // The boundary itself is accepted: 2^53 − 1 is the largest exact count a double can carry.
    expect(createTableHandle({ ...base, rowCount: Number.MAX_SAFE_INTEGER }).rowCount).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    // Non-integers stay refused exactly as before.
    expect(codeOf(() => createTableHandle({ ...base, rowCount: 2.5 }))).toBe('input.out_of_range');
  });

  it('isMarketSnapshot routes through the full read-door validation (sans migration)', () => {
    const snapshot = buildGuardSnapshot();
    expect(isMarketSnapshot(snapshot)).toBe(true);
    expect(isMarketSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
    const raw = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    // Each reproduced malformation: the shallow guard said true; the sound guard refuses.
    expect(isMarketSnapshot({ ...raw, asOf: Number.NaN })).toBe(false);
    expect(isMarketSnapshot({ ...raw, conventions: {} })).toBe(false); // missing conventionsVersion
    expect(isMarketSnapshot({ ...raw, observations: { spots: { AAPL: { price: 'high' } } } })).toBe(
      false,
    );
    expect(isMarketSnapshot({ ...raw, unknownKey: 1 })).toBe(false);
    expect(isMarketSnapshot({ ...raw, schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION + 1 })).toBe(
      false,
    );
    expect(isMarketSnapshot(null)).toBe(false);
  });

  it('isAnalysisArtifact validates the full body but — per its documented contract — not the id hash', () => {
    const artifact = createAnalysisArtifact({
      artifactType: 'x.y',
      producedBy: { operation: 'x' },
      inputs: { parameters: { period: 3 } },
      result: LAW2_RESULT,
    });
    expect(isAnalysisArtifact(artifact)).toBe(true);
    const raw = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    // Reproduced malformations the shallow guard admitted:
    expect(isAnalysisArtifact({ ...raw, inputs: undefined })).toBe(false);
    expect(isAnalysisArtifact({ ...raw, producedBy: { operation: '' } })).toBe(false);
    expect(isAnalysisArtifact({ ...raw, result: { value: 1 } })).toBe(false); // no Law-2 floor
    expect(isAnalysisArtifact({ ...raw, provenance: { provider: 42 } })).toBe(false);
    // Forged inputs are caught (inputsHash is re-derived in body validation)…
    const forgedInputs = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (forgedInputs['inputs'] as Record<string, unknown>)['parameters'] = { period: 99 };
    expect(isAnalysisArtifact(forgedInputs)).toBe(false);
    // …but an edited RESULT under the original id still passes the guard: id verification stays
    // the read door's job (the guard's one documented omission, unchanged).
    const editedResult = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (editedResult['result'] as Record<string, unknown>)['extra'] = 1;
    expect(isAnalysisArtifact(editedResult)).toBe(true);
    expect(codeOf(() => readAnalysisArtifact({ artifact: editedResult }))).toBe(
      'artifact.id_mismatch',
    );
  });

  it('isScenarioSet refuses non-record scenarios and malformed bodies the shallow guard admitted', () => {
    const set = createScenarioSet({
      name: 's',
      scenarios: [{ name: 'crash', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] }],
    });
    expect(isScenarioSet(set)).toBe(true);
    const raw = JSON.parse(JSON.stringify(set)) as Record<string, unknown>;
    expect(isScenarioSet({ ...raw, scenarios: [42] })).toBe(false);
    expect(isScenarioSet({ ...raw, scenarios: [] })).toBe(false);
    expect(isScenarioSet({ ...raw, name: '' })).toBe(false);
    expect(isScenarioSet({ ...raw, provenance: { provider: 42 } })).toBe(false);
    expect(isScenarioSet(null)).toBe(false);
  });
});

// ── Finding 4b: ONE shared provenance validator, everywhere provenance is accepted ──────────────

describe('shared provenance validation', () => {
  const badProvider = { provider: 42 } as never;
  const badWarnings = { provider: 'x', warnings: ['not a QuantWarning'] } as never;
  const goodProvenance = {
    provider: 'insiderfinance',
    dataset: 'eod',
    asOf: 1784505600000,
    receivedAt: 1784505600001,
    sourceVersion: 'v2',
    requestId: 'req-1',
    warnings: [{ code: 'data.stale', message: 'quote is 20 minutes old', severity: 'warn' }],
  };

  it('every create door refuses provider: 42 and a bare-string warning with the same teaching', () => {
    expect(
      codeOf(() => createMarketSnapshot({ asOf: 0, observations: {}, provenance: badProvider })),
    ).toBe('input.wrong_type');
    expect(() =>
      createMarketSnapshot({ asOf: 0, observations: {}, provenance: badProvider }),
    ).toThrow(/provenance\.provider must be a string when present/);
    expect(
      codeOf(() =>
        createAnalysisArtifact({
          artifactType: 'x.y',
          producedBy: { operation: 'x' },
          result: LAW2_RESULT,
          provenance: badProvider,
        }),
      ),
    ).toBe('input.wrong_type');
    expect(
      codeOf(() =>
        createScenarioSet({
          name: 's',
          scenarios: [{ name: 'x', shocks: [] }],
          provenance: badProvider,
        }),
      ),
    ).toBe('input.wrong_type');
    expect(() =>
      createMarketSnapshot({ asOf: 0, observations: {}, provenance: badWarnings }),
    ).toThrow(/provenance\.warnings\[0\]/);
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: {},
          provenance: { provider: 'x', receivedAt: Number.NaN } as never,
        }),
      ),
    ).toBe('input.not_finite');
    expect(
      codeOf(() =>
        createMarketSnapshot({
          asOf: 0,
          observations: {},
          provenance: { provider: 'x', unknown: 1 } as never,
        }),
      ),
    ).toBe('input.unknown_field');
  });

  it('the read doors refuse a stored envelope whose provenance was hand-mangled', () => {
    const snapshot = JSON.parse(JSON.stringify(buildGuardSnapshot())) as Record<string, unknown>;
    snapshot['provenance'] = { provider: 42 };
    expect(codeOf(() => readMarketSnapshot({ snapshot }))).toBe('input.wrong_type');
    const set = JSON.parse(
      JSON.stringify(createScenarioSet({ name: 's', scenarios: [{ name: 'x', shocks: [] }] })),
    ) as Record<string, unknown>;
    set['provenance'] = { provider: 42 };
    expect(codeOf(() => readScenarioSet({ scenarioSet: set }))).toBe('input.wrong_type');
  });

  it('a fully-typed provenance (structured warnings included) passes every door and round-trips', () => {
    const snapshot = createMarketSnapshot({
      asOf: 0,
      observations: {},
      provenance: goodProvenance as never,
    });
    expect(snapshot.provenance?.warnings?.[0]?.code).toBe('data.stale');
    const { snapshot: restored } = readMarketSnapshot({
      snapshot: JSON.parse(JSON.stringify(snapshot)),
    });
    expect(restored.provenance?.warnings?.[0]?.severity).toBe('warn');
    const set = createScenarioSet({
      name: 's',
      scenarios: [{ name: 'x', shocks: [] }],
      provenance: goodProvenance as never,
    });
    expect(isScenarioSet(set)).toBe(true);
  });
});

/** A small valid snapshot for the guard/provenance suites (with provenance attached). */
function buildGuardSnapshot() {
  return createMarketSnapshot({
    asOf: '2026-07-20T00:00:00Z',
    conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
    observations: { spots: { AAPL: { price: 195.3 } }, riskFreeRates: { USD: 0.045 } },
    provenance: { provider: 'insiderfinance', dataset: 'eod' },
  });
}
