/**
 * Explicit schema migration for spine envelopes (Gate B).
 *
 * The version policy every reader shares:
 *
 * - an envelope whose `schemaVersion` MATCHES the build restores directly;
 * - a NEWER envelope is refused — this build cannot know what changed, and restoring it anyway
 *   would silently misread state (the TA snapshot reader's law, applied spine-wide);
 * - an OLDER envelope restores ONLY through an explicitly registered migration chain. There is no
 *   silent upgrade: a migration is a named function with a stated reason, each step raises the
 *   version by exactly one, and every applied step is reported back to the caller.
 *
 * The registry is an ARGUMENT to the readers, never module-global state — a hidden process-wide
 * registry is exactly the "result depends on hidden process state" failure the artifact spine
 * exists to make impossible (roadmap Program 11 exit gate).
 */

import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentObject } from '../invariants.js';

/** One explicit schema-upgrade step for one envelope kind. */
export interface ArtifactMigration {
  /** The envelope `kind` this step migrates, e.g. `'totalfinance.market-snapshot'`. */
  kind: string;
  /** The stored version this step reads. */
  fromVersion: number;
  /** Always `fromVersion + 1` — chains are single steps, applied in order, each one reviewable. */
  toVersion: number;
  /** Why the schema changed — reported to the caller with every application. */
  description: string;
  /**
   * Pure shape-to-shape upgrade. Receives the whole envelope at `fromVersion`; returns the whole
   * envelope at `toVersion` (including the bumped `schemaVersion` field). Must not fetch, read
   * the clock, or mutate its input.
   */
  migrate: (envelope: Record<string, unknown>) => Record<string, unknown>;
}

/** One applied step, echoed by the readers so an upgrade is never invisible. */
export interface AppliedMigration {
  kind: string;
  fromVersion: number;
  toVersion: number;
  description: string;
}

export interface ArtifactMigrationRegistry {
  /** Register one step. A second registration for the same `(kind, fromVersion)` is refused. */
  register: (migration: ArtifactMigration) => void;
  /** The registered step out of `(kind, fromVersion)`, if any. */
  find: (kind: string, fromVersion: number) => ArtifactMigration | undefined;
  /**
   * Apply registered steps until `targetVersion`, reporting each. Refuses (rather than skips) the
   * first missing link — a partial upgrade is a corrupt envelope with a plausible version number.
   */
  upgrade: (input: { envelope: Record<string, unknown>; targetVersion: number }) => {
    envelope: Record<string, unknown>;
    migrationsApplied: AppliedMigration[];
  };
}

const MIGRATION_KEYS = ['kind', 'fromVersion', 'toVersion', 'description', 'migrate'] as const;

function requireVersionInteger(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-negative integer schema version. Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
  return value;
}

/** Create an empty, caller-owned migration registry. */
export function createArtifactMigrationRegistry(): ArtifactMigrationRegistry {
  const steps = new Map<string, ArtifactMigration>();
  const keyOf = (kind: string, fromVersion: number): string => `${kind}@${fromVersion}`;

  const register = (migration: ArtifactMigration): void => {
    requireArgumentObject('register', 'migration', migration);
    ensureKnownKeys('register', 'migration', migration, MIGRATION_KEYS);
    const { kind, description, migrate } = migration;
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new InputError(
        `register: migration.kind must be the envelope kind string it migrates, e.g. 'totalfinance.market-snapshot'.`,
        { code: ErrorCode.InputWrongType, context: { field: 'kind' } },
      );
    }
    const fromVersion = requireVersionInteger(
      'register',
      'migration.fromVersion',
      migration.fromVersion,
    );
    const toVersion = requireVersionInteger('register', 'migration.toVersion', migration.toVersion);
    if (toVersion !== fromVersion + 1) {
      throw new InputError(
        `register: migration.toVersion must be fromVersion + 1 (got ${fromVersion} → ${toVersion}). ` +
          `Chains are single steps so each shape change stays individually reviewable.`,
        { code: ErrorCode.InputOutOfRange, context: { fromVersion, toVersion } },
      );
    }
    if (typeof description !== 'string' || description.length === 0) {
      throw new InputError(
        `register: migration.description must state why the schema changed — it is echoed to every caller the migration touches.`,
        { code: ErrorCode.InputWrongType, context: { field: 'description' } },
      );
    }
    if (typeof migrate !== 'function') {
      throw new InputError(
        `register: migration.migrate must be a function (envelope) => envelope.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: 'migrate' },
        },
      );
    }
    const key = keyOf(kind, fromVersion);
    if (steps.has(key)) {
      throw new InputError(
        `register: a migration for ${kind} version ${fromVersion} → ${fromVersion + 1} is already registered — ` +
          `two upgrades for one stored shape cannot both be the truth.`,
        { code: ErrorCode.ArtifactDuplicateMigration, context: { kind, fromVersion } },
      );
    }
    steps.set(key, migration);
  };

  const find = (kind: string, fromVersion: number): ArtifactMigration | undefined =>
    steps.get(keyOf(kind, fromVersion));

  const upgrade: ArtifactMigrationRegistry['upgrade'] = (input) => {
    requireArgumentObject('upgrade', 'input', input);
    ensureKnownKeys('upgrade', 'input', input, ['envelope', 'targetVersion']);
    requireArgumentObject('upgrade', 'input.envelope', input.envelope);
    const targetVersion = requireVersionInteger(
      'upgrade',
      'input.targetVersion',
      input.targetVersion,
    );
    let envelope = input.envelope;
    const kind = envelope['kind'];
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new InputError(`upgrade: input.envelope.kind must be the envelope's kind string.`, {
        code: ErrorCode.SnapshotWrongShape,
        context: { received: kind === null ? 'null' : typeof kind },
      });
    }
    let version = requireVersionInteger(
      'upgrade',
      'input.envelope.schemaVersion',
      envelope['schemaVersion'],
    );
    const migrationsApplied: AppliedMigration[] = [];
    while (version < targetVersion) {
      const step = find(kind, version);
      if (step === undefined) {
        throw new InputError(
          `upgrade: no migration is registered for ${kind} version ${version} → ${version + 1} ` +
            `(stored ${envelope['schemaVersion'] === version ? version : `${String(envelope['schemaVersion'])}, currently at ${version}`}, this build reads ${targetVersion}). ` +
            `Schema upgrades are explicit: register the missing step with registry.register(...) — nothing is migrated silently.`,
          {
            code: ErrorCode.ArtifactMigrationMissing,
            context: { kind, fromVersion: version, targetVersion },
          },
        );
      }
      envelope = step.migrate(envelope);
      requireArgumentObject(
        'upgrade',
        `migrated envelope (${kind} v${version} → v${version + 1})`,
        envelope,
      );
      const migratedVersion = envelope['schemaVersion'];
      if (migratedVersion !== version + 1) {
        throw new InputError(
          `upgrade: the ${kind} v${version} → v${version + 1} migration returned schemaVersion ${String(migratedVersion)} — a migration must stamp exactly the version it declares.`,
          {
            code: ErrorCode.SnapshotInvalidVersion,
            context: { kind, fromVersion: version, returned: migratedVersion },
          },
        );
      }
      migrationsApplied.push({
        kind,
        fromVersion: version,
        toVersion: version + 1,
        description: step.description,
      });
      version += 1;
    }
    return { envelope, migrationsApplied };
  };

  return { register, find, upgrade };
}
