/**
 * Serializable scenario sets (Gate B, ahead of Gate D's shared runner): named scenario
 * DEFINITIONS — shocks and overrides over a market snapshot — as pure data one runner can later
 * apply across domains. Deliberately NOT a DSL: no expressions, no conditionals, no references —
 * a scenario is a list of typed records, and anything a list of records cannot say belongs in
 * caller code via the escape hatch (a custom reprice function), not in a language embedded here.
 *
 * The shock grammar is the one `@insiderfinance/totalfinance/risk` already speaks — `{ factor, kind: 'percent' |
 * 'absolute', value }`, with the same factor vocabulary (`spot`, `volatility`, `riskFreeRate`,
 * `time`, `dividend`, or a custom label) — extended with an optional `target` symbol so one
 * scenario can shock AAPL and SPY differently. A spine shock without `target` is exactly a risk
 * `Shock`, so Gate D's runner can hand these to the existing Taylor engine unchanged (no second
 * vocabulary, no adapter tax).
 *
 * Semantics fixed here so every future runner agrees:
 *
 * - **overrides apply first**, setting an observation to an absolute value;
 * - **shocks then apply in array order** (deterministic composition — `+10 pts` then `-5%` is not
 *   `-5%` then `+10 pts`, and the data says which one is meant);
 * - **two overrides for the same `(factor, target)` in one scenario are a CONFLICT** and are
 *   refused at creation — the second absolute set would silently win;
 * - repeated SHOCKS on one factor are legal: they compose, in order.
 */

import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from '../invariants.js';
import type { Provenance } from '../provenance.js';
import { requireProvenance } from '../provenance.js';
import { canonicalJsonOf, fromCanonicalJson } from '../canonical-json.js';
import { contentHash } from './content-hash.js';
import { deepFreeze } from './deep-freeze.js';
import type { AppliedMigration, ArtifactMigrationRegistry } from './migration.js';
import { createArtifactMigrationRegistry } from './migration.js';

export const SCENARIO_SET_KIND = 'totalfinance.scenario-set';

/** Current scenario-set schema version — same bump-with-migration policy as the other envelopes. */
export const SCENARIO_SET_SCHEMA_VERSION = 1;

/** The factor vocabulary shared with `@insiderfinance/totalfinance/risk`'s scenario engine; open for custom labels. */
export type ScenarioFactor = 'spot' | 'volatility' | 'riskFreeRate' | 'time' | 'dividend' | string;

/** A relative change: `percent` scales the base level; `absolute` adds in the factor's own unit. */
export interface ScenarioShock {
  factor: ScenarioFactor;
  kind: 'percent' | 'absolute';
  value: number;
  /** Which symbol the shock hits; absent = every target the runner prices with this factor. */
  target?: string;
}

/** An absolute set: the observation for `(factor, target)` BECOMES `value` before shocks apply. */
export interface ScenarioOverride {
  factor: ScenarioFactor;
  value: number;
  target?: string;
}

export interface ScenarioDefinition {
  /** Unique within the set — result cells trace back to scenarios by name. */
  name: string;
  shocks: ScenarioShock[];
  overrides?: ScenarioOverride[];
}

export interface ScenarioSet {
  kind: typeof SCENARIO_SET_KIND;
  schemaVersion: number;
  name: string;
  scenarios: ScenarioDefinition[];
  /** Where the definitions came from (a historical-event library, a desk doc) — caller-supplied. */
  provenance?: Provenance;
}

const ENVELOPE_KEYS = ['kind', 'schemaVersion', 'name', 'scenarios', 'provenance'];

const EXAMPLE_CALL =
  "createScenarioSet({ name: 'rate-and-vol-stress', scenarios: [{ name: 'vol +10pts', shocks: [{ factor: 'volatility', kind: 'absolute', value: 0.10 }] }] })";

function scenarioError(
  message: string,
  code: ErrorCode,
  context: Record<string, unknown>,
): InputError {
  return new InputError(message, { code, context });
}

function requireFiniteValue(functionName: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw scenarioError(
      `${functionName}: ${path} must be a finite number. Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
      { function: functionName, field: path },
    );
  }
  return value;
}

function requireFactor(functionName: string, path: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw scenarioError(
      `${functionName}: ${path} must be a factor name — 'spot', 'volatility', 'riskFreeRate', 'time', 'dividend', or a custom label.\n  e.g. ${EXAMPLE_CALL}`,
      ErrorCode.InputWrongType,
      { function: functionName, field: path },
    );
  }
  return value;
}

function validateScenarioSetBody(
  functionName: string,
  body: Omit<ScenarioSet, 'provenance'>,
): void {
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw scenarioError(
      `${functionName}: name must be a non-empty string — saved scenario sets are referenced by name.\n  e.g. ${EXAMPLE_CALL}`,
      ErrorCode.InputWrongType,
      { field: 'name' },
    );
  }
  requireArgumentArray(functionName, 'scenarios', body.scenarios);
  if (body.scenarios.length === 0) {
    throw scenarioError(
      `${functionName}: scenarios must name at least one scenario — an empty set answers nothing.`,
      ErrorCode.InputOutOfRange,
      { field: 'scenarios' },
    );
  }
  const seenNames = new Set<string>();
  for (let s = 0; s < body.scenarios.length; s++) {
    const scenario = body.scenarios[s]!;
    const path = `scenarios[${s}]`;
    requireArgumentObject(functionName, path, scenario);
    ensureKnownKeys(functionName, path, scenario, ['name', 'shocks', 'overrides']);
    if (typeof scenario.name !== 'string' || scenario.name.length === 0) {
      throw scenarioError(
        `${functionName}: ${path}.name must be a non-empty string — result cells trace back to scenarios by name.`,
        ErrorCode.InputWrongType,
        { field: `${path}.name` },
      );
    }
    if (seenNames.has(scenario.name)) {
      throw scenarioError(
        `${functionName}: scenario name '${scenario.name}' appears twice — names are the set's row identity, so each must be unique.`,
        ErrorCode.InputOutOfRange,
        { field: `${path}.name`, name: scenario.name },
      );
    }
    seenNames.add(scenario.name);
    requireArgumentArray(functionName, `${path}.shocks`, scenario.shocks);
    for (let i = 0; i < scenario.shocks.length; i++) {
      const shock = scenario.shocks[i]!;
      const shockPath = `${path}.shocks[${i}]`;
      requireArgumentObject(functionName, shockPath, shock);
      ensureKnownKeys(functionName, shockPath, shock, ['factor', 'kind', 'value', 'target']);
      requireFactor(functionName, `${shockPath}.factor`, shock.factor);
      if (shock.kind !== 'percent' && shock.kind !== 'absolute') {
        throw scenarioError(
          `${functionName}: ${shockPath}.kind must be 'percent' or 'absolute'; got ${JSON.stringify(shock.kind)}.`,
          ErrorCode.InputInvalidEnum,
          { field: `${shockPath}.kind`, value: shock.kind },
        );
      }
      requireFiniteValue(functionName, `${shockPath}.value`, shock.value);
      if (
        shock.target !== undefined &&
        (typeof shock.target !== 'string' || shock.target.length === 0)
      ) {
        throw scenarioError(
          `${functionName}: ${shockPath}.target must be a non-empty symbol string when present.`,
          ErrorCode.InputWrongType,
          { field: `${shockPath}.target` },
        );
      }
    }
    if (scenario.overrides !== undefined) {
      requireArgumentArray(functionName, `${path}.overrides`, scenario.overrides);
      const seenOverrides = new Set<string>();
      for (let i = 0; i < scenario.overrides.length; i++) {
        const override = scenario.overrides[i]!;
        const overridePath = `${path}.overrides[${i}]`;
        requireArgumentObject(functionName, overridePath, override);
        ensureKnownKeys(functionName, overridePath, override, ['factor', 'value', 'target']);
        const factor = requireFactor(functionName, `${overridePath}.factor`, override.factor);
        requireFiniteValue(functionName, `${overridePath}.value`, override.value);
        if (
          override.target !== undefined &&
          (typeof override.target !== 'string' || override.target.length === 0)
        ) {
          throw scenarioError(
            `${functionName}: ${overridePath}.target must be a non-empty symbol string when present.`,
            ErrorCode.InputWrongType,
            { field: `${overridePath}.target` },
          );
        }
        const overrideKey = JSON.stringify([factor, override.target ?? null]);
        if (seenOverrides.has(overrideKey)) {
          throw scenarioError(
            `${functionName}: ${overridePath} sets (${factor}${override.target === undefined ? '' : `, ${override.target}`}) a second time in '${scenario.name}' — two absolute sets for one observation conflict, and the second would silently win. Merge them or split the scenario.`,
            ErrorCode.InputOutOfRange,
            {
              field: overridePath,
              factor,
              ...(override.target !== undefined ? { target: override.target } : {}),
            },
          );
        }
        seenOverrides.add(overrideKey);
      }
    }
  }
}

/**
 * Build an immutable, serializable scenario set.
 *
 * @example
 * ```ts
 * const stress = createScenarioSet({
 *   name: 'q3-desk-stress',
 *   scenarios: [
 *     { name: 'crash -20%', shocks: [{ factor: 'spot', kind: 'percent', value: -0.20 },
 *                                    { factor: 'volatility', kind: 'absolute', value: 0.15 }] },
 *     { name: 'rates 2019', overrides: [{ factor: 'riskFreeRate', value: 0.0155 }], shocks: [] },
 *   ],
 * });
 * ```
 */
export function createScenarioSet(input: {
  name: string;
  scenarios: ScenarioDefinition[];
  provenance?: Provenance;
}): ScenarioSet {
  requireArgumentObject('createScenarioSet', 'input', input);
  ensureKnownKeys('createScenarioSet', 'input', input, ['name', 'scenarios', 'provenance']);
  const envelope: ScenarioSet = {
    kind: SCENARIO_SET_KIND,
    schemaVersion: SCENARIO_SET_SCHEMA_VERSION,
    name: input.name,
    scenarios: input.scenarios,
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };
  validateScenarioSetBody('createScenarioSet', envelope);
  if (envelope.provenance !== undefined) {
    // The ONE shared provenance validator — the same closed-key, fully typed check every envelope
    // applies, so `provenance: { provider: 42 }` is refused here exactly as a snapshot refuses it.
    requireProvenance('createScenarioSet', 'provenance', envelope.provenance);
  }
  return deepFreeze(fromCanonicalJson(canonicalJsonOf(envelope)) as ScenarioSet);
}

/**
 * Validate a CURRENT-version scenario-set envelope in FULL: closed key set, kind, exact schema
 * version, the whole scenarios body (names unique, shocks/overrides typed, override conflicts
 * refused), and provenance shape. The read door's own validation extracted into a callable that
 * does not migrate — shared by `readScenarioSet` (post-migration) and the public
 * {@link isScenarioSet} guard, so the two can never disagree about what a scenario set is.
 */
function requireCurrentScenarioSetEnvelope(
  functionName: string,
  candidate: Record<string, unknown>,
): ScenarioSet {
  ensureKnownKeys(functionName, 'scenarioSet', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== SCENARIO_SET_KIND) {
    throw scenarioError(
      `${functionName}: scenarioSet.kind is ${JSON.stringify(candidate['kind'])}, not '${SCENARIO_SET_KIND}'.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  if (candidate['schemaVersion'] !== SCENARIO_SET_SCHEMA_VERSION) {
    throw scenarioError(
      `${functionName}: scenarioSet.schemaVersion is ${String(candidate['schemaVersion'])}, not the current ${SCENARIO_SET_SCHEMA_VERSION} — older versions load only through readScenarioSet's explicit migrations.`,
      ErrorCode.SnapshotInvalidVersion,
      { version: candidate['schemaVersion'] },
    );
  }
  const body: ScenarioSet = {
    kind: SCENARIO_SET_KIND,
    schemaVersion: SCENARIO_SET_SCHEMA_VERSION,
    name: candidate['name'] as string,
    scenarios: candidate['scenarios'] as ScenarioDefinition[],
    ...(candidate['provenance'] !== undefined
      ? { provenance: candidate['provenance'] as Provenance }
      : {}),
  };
  validateScenarioSetBody(functionName, body);
  // The body validator deliberately omits provenance (labels are not identity); presence still
  // demands the full shared shape — a `{ provider: 42 }` label bag is not provenance.
  if (body.provenance !== undefined) {
    requireProvenance(functionName, 'provenance', body.provenance);
  }
  return body;
}

/**
 * Sound structural test for a CURRENT-version scenario-set envelope: the complete read-door
 * validation behind a boolean door — `true` means `readScenarioSet` would accept the value
 * unchanged, with no migrations. (An earlier version checked four fields, so
 * `{ …, scenarios: [42] }` passed as `ScenarioSet` and detonated at first use.) Full-walk, not
 * constant-time; call the read door when you also need the restored copy.
 */
export function isScenarioSet(value: unknown): value is ScenarioSet {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    requireCurrentScenarioSetEnvelope('isScenarioSet', value as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/** Restore a stored scenario set, with the shared version/migration policy. */
export function readScenarioSet(input: {
  scenarioSet: unknown;
  migrations?: ArtifactMigrationRegistry;
}): { scenarioSet: ScenarioSet; migrationsApplied: AppliedMigration[] } {
  requireArgumentObject('readScenarioSet', 'input', input);
  ensureKnownKeys('readScenarioSet', 'input', input, ['scenarioSet', 'migrations']);
  const raw = input.scenarioSet;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw scenarioError(
      `readScenarioSet: scenarioSet must be a ScenarioSet envelope object. Received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
      ErrorCode.SnapshotWrongShape,
      { received: raw === null ? 'null' : typeof raw },
    );
  }
  const candidate = raw as Record<string, unknown>;
  ensureKnownKeys('readScenarioSet', 'scenarioSet', candidate, ENVELOPE_KEYS);
  if (candidate['kind'] !== SCENARIO_SET_KIND) {
    throw scenarioError(
      `readScenarioSet: scenarioSet.kind is ${JSON.stringify(candidate['kind'])}, not '${SCENARIO_SET_KIND}' — this reader restores scenario sets only.`,
      ErrorCode.SnapshotKindMismatch,
      { received: candidate['kind'] },
    );
  }
  const version = candidate['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw scenarioError(
      `readScenarioSet: scenarioSet has an invalid schema version: ${String(version)}.`,
      ErrorCode.SnapshotInvalidVersion,
      { version },
    );
  }
  if (version > SCENARIO_SET_SCHEMA_VERSION) {
    throw scenarioError(
      `readScenarioSet: scenarioSet schema version ${version} is newer than this build supports (${SCENARIO_SET_SCHEMA_VERSION}). Upgrade @insiderfinance/totalfinance to restore it.`,
      ErrorCode.SnapshotUnsupportedVersion,
      { version, supported: SCENARIO_SET_SCHEMA_VERSION },
    );
  }
  let envelope = candidate;
  let migrationsApplied: AppliedMigration[] = [];
  if (version < SCENARIO_SET_SCHEMA_VERSION) {
    const registry = input.migrations ?? createArtifactMigrationRegistry();
    ({ envelope, migrationsApplied } = registry.upgrade({
      envelope,
      targetVersion: SCENARIO_SET_SCHEMA_VERSION,
    }));
  }
  // The shared current-version validator — one law with isScenarioSet. Post-migration it also
  // proves the registry actually delivered the current shape (kind and version included).
  const body = requireCurrentScenarioSetEnvelope('readScenarioSet', envelope);
  return {
    scenarioSet: deepFreeze(fromCanonicalJson(canonicalJsonOf(body)) as ScenarioSet),
    migrationsApplied,
  };
}

/** Content identity for a scenario set: the canonical envelope WITHOUT `provenance`. */
export function scenarioSetContentHash(scenarioSet: ScenarioSet): string {
  requireArgumentObject('scenarioSetContentHash', 'scenarioSet', scenarioSet);
  // FULL validation, not the structural predicate: a malformed envelope must be refused, never
  // identified (the deep probe convicted the predicate-only version for hashing unknown keys and a
  // null provenance). Reusing the read path keeps ONE validator.
  const { scenarioSet: validated } = readScenarioSet({ scenarioSet });
  return contentHash({
    kind: validated.kind,
    schemaVersion: validated.schemaVersion,
    name: validated.name,
    scenarios: validated.scenarios,
  });
}
