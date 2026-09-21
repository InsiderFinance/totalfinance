/**
 * Declaration-derived executable targets for resource-bearing attached callables.
 *
 * The runtime manifest intentionally records `facade.explain` and `indicator.stream` as capabilities
 * on their parent function, not as separate exports. That is useful for package documentation but
 * used to make the count-safety sweep skip hundreds of directly callable public boundaries. This
 * adapter joins those declaration paths back to the live attached functions and gives every one a
 * successful, low-cost baseline before the mutation gate trusts its refusal.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { synthesizeCall, type SynthesisParameter } from '../manifest/contract-synthesis.js';
import { isResourceCoordinate } from './count-semantics.js';
import { declaredNumericCoordinatesForHead } from './declaration-coordinates.js';
import { allFixtures } from './fixtures.js';
import type { ResourceMethodTarget } from './resource-method-targets.js';

interface ContractRecord {
  id: string;
  package: string;
  fields?: string[];
  signatures?: Array<{ parameters?: SynthesisParameter[] }>;
}

const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../manifest/public-contracts.json', import.meta.url)),
    'utf8',
  ),
) as { contracts: ContractRecord[] };

const SAFE_BY_KEY: Readonly<Record<string, number>> = {
  count: 3,
  fast: 12,
  slow: 26,
  short: 7,
  medium: 14,
  long: 28,
  signal: 9,
  levels: 10,
  displacement: 26,
  basePeriod: 26,
  spanBPeriod: 52,
  kPeriod: 3,
  dPeriod: 3,
  smoothK: 3,
  resetEvery: 1,
};

const safeCount = (head: string, key: string): number =>
  head === 'technical-analysis.ebsw.explain' || head === 'technical-analysis.ebsw.stream'
    ? key === 'period'
      ? 40
      : (SAFE_BY_KEY[key] ?? 20)
    : (SAFE_BY_KEY[key] ?? 20);

function setCoordinate(
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  replacement: number,
): unknown {
  if (depth === path.length) return replacement;
  const step = path[depth]!;
  if (Array.isArray(value)) {
    if (typeof step === 'number' && depth > 0) {
      return value.map((entry) => setCoordinate(entry, path, depth + 1, replacement));
    }
    const copy = value.slice();
    copy[step as number] = setCoordinate(copy[step as number], path, depth + 1, replacement);
    return copy;
  }
  if (typeof step === 'number') {
    const copy: unknown[] = [];
    copy[step] = setCoordinate(undefined, path, depth + 1, replacement);
    return copy;
  }
  const record =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    ...record,
    [step]: setCoordinate(record[step as string], path, depth + 1, replacement),
  };
}

function fresh(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fresh);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = fresh(entry);
  return copy;
}

function normalizedArguments(head: string, args: unknown[]): unknown[] {
  let normalized: unknown = fresh(args);
  for (const coordinate of declaredNumericCoordinatesForHead(head)) {
    if (!isResourceCoordinate(coordinate)) continue;
    normalized = setCoordinate(normalized, coordinate.path, 0, safeCount(head, coordinate.key));
  }
  return normalized as unknown[];
}

function resolveCallable(
  module: Record<string, unknown>,
  path: string,
): { fn: (...args: unknown[]) => unknown; receiver: unknown } | undefined {
  const parts = path.split('.');
  let receiver: unknown = module;
  for (const part of parts.slice(0, -1)) {
    receiver = (receiver as Record<string, unknown> | undefined)?.[part];
  }
  const fn = (receiver as Record<string, unknown> | undefined)?.[parts.at(-1)!];
  return typeof fn === 'function'
    ? { fn: fn as (...args: unknown[]) => unknown, receiver }
    : undefined;
}

const fixtures = allFixtures();
const EXPLAIN_FIXTURE_ALIASES: Readonly<Record<string, string>> = {
  'fixed-income.creditSpreadCurve': 'fixed-income.credit.creditSpreadCurve',
};
const targets: ResourceMethodTarget[] = [];
const errors: string[] = [];
const modules = new Map<string, Record<string, unknown>>();

for (const record of artifact.contracts) {
  const match = /^@totalfinance\/([^:]+):(.+)\.(explain|stream)$/.exec(record.id);
  if (match === null) continue;
  const [, packageDir, callablePath, companion] = match;
  const head = `${packageDir}.${callablePath}.${companion}`;
  if (
    !declaredNumericCoordinatesForHead(head).some((coordinate) => isResourceCoordinate(coordinate))
  ) {
    continue;
  }

  let module = modules.get(record.package);
  if (module === undefined) {
    module = (await import(/* @vite-ignore */ record.package)) as Record<string, unknown>;
    modules.set(record.package, module);
  }
  const callable = resolveCallable(module, `${callablePath}.${companion}`);
  if (callable === undefined) {
    errors.push(`${head}: live attached callable was not found`);
    continue;
  }

  const candidates: unknown[][] = [];
  if (companion === 'explain') {
    const baseKey = `${packageDir}.${callablePath}`;
    const baseFixture = fixtures.get(EXPLAIN_FIXTURE_ALIASES[baseKey] ?? baseKey);
    if (baseFixture !== undefined) candidates.push(baseFixture());
  }
  const parameters = record.signatures?.[0]?.parameters ?? [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const built = synthesizeCall(parameters, record.fields ?? [], attempt);
    if (built !== null) candidates.push(built.args);
  }

  let baseline: unknown[] | undefined;
  let lastError = 'no synthesized call';
  for (const args of candidates) {
    const candidate = normalizedArguments(head, args);
    try {
      Reflect.apply(callable.fn, callable.receiver, candidate);
      baseline = candidate;
      break;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  if (baseline === undefined) {
    errors.push(`${head}: ${lastError}`);
    continue;
  }

  targets.push({
    key: head,
    fn: (...args: unknown[]) => Reflect.apply(callable.fn, callable.receiver, args),
    fixture: () => fresh(baseline) as unknown[],
  });
}

export const RESOURCE_ATTACHED_TARGETS: readonly ResourceMethodTarget[] = targets;
export const RESOURCE_ATTACHED_TARGET_ERRORS: readonly string[] = errors;
