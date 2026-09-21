/**
 * Declaration-derived executable targets for resource-bearing public constructors.
 *
 * Constructors are not ordinary module functions in the hand manifest, so the original count sweep
 * never discovered them. Build their low-cost calls from the checker contract, replace every
 * resource coordinate with a realistic count, and invoke them with `Reflect.construct`. A new
 * resource-bearing constructor therefore joins the safety gate automatically instead of waiting for
 * a hand-maintained class list.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as bands from '../../packages/technical-analysis/src/bands.js';
import * as bars from '../../packages/technical-analysis/src/bars.js';
import * as candleAliases from '../../packages/technical-analysis/src/candle-aliases.js';
import * as candlesticks from '../../packages/technical-analysis/src/candlesticks.js';
import * as chartTypes from '../../packages/technical-analysis/src/chart-types.js';
import * as cycle from '../../packages/technical-analysis/src/cycle.js';
import * as macd from '../../packages/technical-analysis/src/macd.js';
import * as math from '../../packages/technical-analysis/src/math.js';
import * as microstructure from '../../packages/technical-analysis/src/microstructure.js';
import * as momentumExt from '../../packages/technical-analysis/src/momentum-ext.js';
import * as movingAverages from '../../packages/technical-analysis/src/moving-averages.js';
import * as oscillators from '../../packages/technical-analysis/src/oscillators.js';
import * as overlapExt from '../../packages/technical-analysis/src/overlap-ext.js';
import * as performanceExt from '../../packages/technical-analysis/src/performance-ext.js';
import * as pipeline from '../../packages/technical-analysis/src/pipeline.js';
import * as rsi from '../../packages/technical-analysis/src/rsi.js';
import * as series from '../../packages/technical-analysis/src/series.js';
import * as signal from '../../packages/technical-analysis/src/signal.js';
import * as statistics from '../../packages/technical-analysis/src/statistics.js';
import * as transforms from '../../packages/technical-analysis/src/transforms.js';
import * as trend from '../../packages/technical-analysis/src/trend.js';
import * as volatility from '../../packages/technical-analysis/src/volatility.js';
import * as volumeCore from '../../packages/technical-analysis/src/volume-core.js';
import { synthesizeCall, type SynthesisParameter } from '../manifest/contract-synthesis.js';
import { isResourceCoordinate } from './count-semantics.js';
import { declaredNumericCoordinatesForHead } from './declaration-coordinates.js';
import { CONSTRUCTOR_FIXTURES } from './fixtures/constructors.js';
import type { ResourceMethodTarget } from './resource-method-targets.js';

interface ContractRecord {
  id: string;
  implementation: string;
  fields?: string[];
  signatures?: Array<{ parameters?: SynthesisParameter[] }>;
}

const IMPLEMENTATION_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  bands,
  bars,
  'candle-aliases': candleAliases,
  candlesticks,
  'chart-types': chartTypes,
  cycle,
  macd,
  math,
  microstructure,
  'momentum-ext': momentumExt,
  'moving-averages': movingAverages,
  oscillators,
  'overlap-ext': overlapExt,
  'performance-ext': performanceExt,
  pipeline,
  rsi,
  series,
  signal,
  statistics,
  transforms,
  trend,
  volatility,
  'volume-core': volumeCore,
};

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

const safeCount = (key: string): number => SAFE_BY_KEY[key] ?? 20;

/** Canonical numeric array positions below the argument are wildcards, not only element zero. */
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
  const record = value as Record<string, unknown>;
  return {
    ...record,
    [step]: setCoordinate(record[step as string], path, depth + 1, replacement),
  };
}

function fresh(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fresh);
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = fresh(entry);
  return copy;
}

function normalizedArguments(head: string, args: unknown[]): unknown[] {
  let normalized: unknown = fresh(args);
  for (const coordinate of declaredNumericCoordinatesForHead(head)) {
    if (!isResourceCoordinate(coordinate)) continue;
    normalized = setCoordinate(normalized, coordinate.path, 0, safeCount(coordinate.key));
  }
  return normalized as unknown[];
}

const targets: ResourceMethodTarget[] = [];
const errors: string[] = [];

for (const record of artifact.contracts) {
  const match = /^@totalfinance\/technical-analysis:([A-Za-z_$][\w$]*)\.constructor$/.exec(
    record.id,
  );
  if (match === null) continue;
  const className = match[1]!;
  const head = `technical-analysis.${className}.constructor`;
  if (
    !declaredNumericCoordinatesForHead(head).some((coordinate) => isResourceCoordinate(coordinate))
  ) {
    continue;
  }
  const implementationModule = /\/dist\/([^#]+)\.d\.ts#/.exec(record.implementation)?.[1];
  const constructor = implementationModule
    ? IMPLEMENTATION_MODULES[implementationModule]?.[className]
    : undefined;
  if (typeof constructor !== 'function') {
    errors.push(
      `${head}: ${className} was not found in its public implementation module ${implementationModule ?? '(unknown)'}`,
    );
    continue;
  }
  const parameters = record.signatures?.[0]?.parameters ?? [];
  let baseline: unknown[] | undefined;
  let lastError = 'no synthesized call';
  const explicitFixture = CONSTRUCTOR_FIXTURES[head]?.();
  for (let attempt = -1; attempt < 5; attempt++) {
    const builtArgs =
      attempt === -1
        ? explicitFixture
        : synthesizeCall(parameters, record.fields ?? [], attempt)?.args;
    if (builtArgs === undefined) continue;
    const candidate = normalizedArguments(head, builtArgs);
    try {
      Reflect.construct(constructor, candidate);
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
    fn: (...args: unknown[]) => Reflect.construct(constructor, args),
    fixture: () => fresh(baseline) as unknown[],
  });
}

export const RESOURCE_CONSTRUCTOR_TARGETS: readonly ResourceMethodTarget[] = targets;
export const RESOURCE_CONSTRUCTOR_TARGET_ERRORS: readonly string[] = errors;
