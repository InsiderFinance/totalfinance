/**
 * Internal (not an entrypoint): the statistical-hygiene block a research run may carry
 * (Stage 4.5 Decision 4) — up to six VERBATIM `@totalfinance/risk` results the caller attaches.
 *
 * Research may not import risk (the FC0 layer graph: risk composes research outputs, never the
 * reverse), so the shapes below are declared structurally and kept in lock-step with risk's
 * declarations by a compile-time parity fixture (`tools/manifest/research-hygiene-parity.compile.ts`:
 * mutual assignability in both directions). The validator closes the block's own keys and each
 * member's declared top-level keys, and checks every field a comparison or a reader CONSUMES —
 * `assumptions` records stay open, as risk declares them (Law 12). Nothing here computes a hygiene
 * statistic: the block is lineage (Program 11), never a second engine (D7).
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';

/** `researchProtocol`'s verdict — risk's `ResearchVerdict`, structurally. */
export interface HygieneResearchVerdict {
  verdict: 'significant' | 'inconclusive' | 'likely-overfit';
  /** Sharpe figures are `null` when the returns had zero variance (C hygiene); the verdict is then `inconclusive`. */
  inSample: { sharpe: number | null; annualizedSharpe: number | null; observations: number };
  deflatedSharpe: number | null;
  probabilisticSharpe: number | null;
  expectedMaxSharpe: number;
  trialCount: number;
  /** `Infinity` when the Sharpe is at or below its benchmark — a disclosed non-finite the producing law made legal. */
  minTrackRecordLength: number;
  outOfSample?: {
    sharpe: number | null;
    annualizedSharpe: number | null;
    degradation: number | null;
  };
  rationale: string;
  assumptions: { conventionsVersion: string; confidence: number; periodsPerYear: number };
  diagnostics: { warnings: QuantWarning[] };
}

/** `deflatedSharpeRatio`'s result — risk's `DeflatedSharpeResult`, structurally. */
export interface HygieneDeflatedSharpe {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
  /** `null` when the statistics carried no Sharpe (a zero-variance series). */
  deflatedSharpe: number | null;
  probabilisticSharpe: number | null;
  expectedMaxSharpe: number;
  trialCount: number;
}

/** `backtestOverfittingProbability`'s result — risk's `BacktestOverfittingProbabilityResult`, structurally. */
export interface HygieneBacktestOverfitting {
  backtestOverfittingProbability: number;
  combinations: number;
  splits: number;
  observations: number;
  trials: number;
  medianLogit: number;
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
}

/** `detectLeakage`'s report — risk's `LeakageReport`, structurally. */
export interface HygieneLeakageReport {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
  clean: boolean;
  leaks: Array<{ split: number; overlapCount: number; sample: number[] }>;
}

/** `parameterSweepDiagnostics`' result — risk's `ParameterSweepResult`, structurally. */
export interface HygieneParameterSweep {
  trialCount: number;
  bestSharpe: number;
  meanSharpe: number;
  varianceSharpe: number;
  expectedMaxSharpe: number;
  /** `null` when the selected statistics carried no Sharpe (a zero-variance series). */
  deflatedSharpe: number | null;
  probabilisticSharpe: number | null;
}

/** `adjustPValues`' result — risk's `MultipleTestResult`, structurally. */
export interface HygieneMultipleTest {
  method: 'bonferroni' | 'sidak' | 'holm' | 'benjaminiHochberg';
  alpha: number;
  adjusted: number[];
  rejected: boolean[];
}

/** The closed block: every member optional, every present member verbatim. */
export interface ResearchHygieneBlock {
  protocol?: HygieneResearchVerdict;
  deflatedSharpe?: HygieneDeflatedSharpe;
  backtestOverfitting?: HygieneBacktestOverfitting;
  leakage?: HygieneLeakageReport;
  parameterSweep?: HygieneParameterSweep;
  multipleTesting?: HygieneMultipleTest;
}

export const HYGIENE_BLOCK_KEYS = [
  'protocol',
  'deflatedSharpe',
  'backtestOverfitting',
  'leakage',
  'parameterSweep',
  'multipleTesting',
] as const;

export const HYGIENE_VERDICTS = ['significant', 'inconclusive', 'likely-overfit'] as const;
const MULTIPLE_TEST_METHODS = ['bonferroni', 'sidak', 'holm', 'benjaminiHochberg'] as const;

function fail(
  functionName: string,
  field: string,
  message: string,
  code: ErrorCode = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireFinite(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(
      functionName,
      field,
      `${field} must be a finite number. Received ${describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
    );
  }
  return value;
}

/** A number that the producing law allows to be `+Infinity` (never NaN, never `-Infinity`). */
function requireFiniteOrPositiveInfinity(
  functionName: string,
  field: string,
  value: unknown,
): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) {
    fail(
      functionName,
      field,
      `${field} must be a finite number or +Infinity (the disclosed "never reaches the benchmark" value). Received ${describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireCount(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(
      functionName,
      field,
      `${field} must be a non-negative integer. Received ${describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
    );
  }
  return value;
}

/** A finite number, or `null` — the C-hygiene spelling of "undefined for this series". */
function requireFiniteOrNull(functionName: string, field: string, value: unknown): number | null {
  return value === null ? null : requireFinite(functionName, field, value);
}

function requireUnitIntervalOrNull(
  functionName: string,
  field: string,
  value: unknown,
): number | null {
  return value === null ? null : requireUnitInterval(functionName, field, value);
}

function requireUnitInterval(functionName: string, field: string, value: unknown): number {
  const number = requireFinite(functionName, field, value);
  if (number < 0 || number > 1) {
    fail(
      functionName,
      field,
      `${field} is a probability and must lie in [0, 1]. Received ${number}.`,
      ErrorCode.InputOutOfRange,
    );
  }
  return number;
}

function requireBoolean(functionName: string, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    fail(
      functionName,
      field,
      `${field} must be a boolean. Received ${describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireText(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string') {
    fail(
      functionName,
      field,
      `${field} must be a string. Received ${describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireEnum<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(
      functionName,
      field,
      `${field} must be one of ${allowed.join(', ')}. Received ${describe(value) === 'string' ? JSON.stringify(value) : describe(value)}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
    );
  }
  return value as T;
}

/** Risk's result envelopes: `assumptions` (open, with `conventionsVersion`) and `diagnostics.warnings`. */
function requireRiskEnvelope(
  functionName: string,
  field: string,
  record: Record<string, unknown>,
): void {
  requireArgumentObject(functionName, `${field}.assumptions`, record['assumptions']);
  requireText(
    functionName,
    `${field}.assumptions.conventionsVersion`,
    (record['assumptions'] as Record<string, unknown>)['conventionsVersion'],
  );
  requireArgumentObject(functionName, `${field}.diagnostics`, record['diagnostics']);
  const warnings = (record['diagnostics'] as Record<string, unknown>)['warnings'];
  if (!Array.isArray(warnings)) {
    fail(
      functionName,
      `${field}.diagnostics.warnings`,
      `${field}.diagnostics.warnings must be an array (risk's structured warnings). Received ${describe(warnings)}.`,
    );
  }
}

function requireProtocol(
  functionName: string,
  field: string,
  value: unknown,
): HygieneResearchVerdict {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, [
    'verdict',
    'inSample',
    'deflatedSharpe',
    'probabilisticSharpe',
    'expectedMaxSharpe',
    'trialCount',
    'minTrackRecordLength',
    'outOfSample',
    'rationale',
    'assumptions',
    'diagnostics',
  ]);
  requireEnum(functionName, `${field}.verdict`, record['verdict'], HYGIENE_VERDICTS);
  requireArgumentObject(functionName, `${field}.inSample`, record['inSample']);
  const inSample = record['inSample'] as Record<string, unknown>;
  ensureKnownKeys(functionName, `${field}.inSample`, inSample, [
    'sharpe',
    'annualizedSharpe',
    'observations',
  ]);
  requireFiniteOrNull(functionName, `${field}.inSample.sharpe`, inSample['sharpe']);
  requireFiniteOrNull(
    functionName,
    `${field}.inSample.annualizedSharpe`,
    inSample['annualizedSharpe'],
  );
  requireCount(functionName, `${field}.inSample.observations`, inSample['observations']);
  requireFiniteOrNull(functionName, `${field}.deflatedSharpe`, record['deflatedSharpe']);
  requireUnitIntervalOrNull(
    functionName,
    `${field}.probabilisticSharpe`,
    record['probabilisticSharpe'],
  );
  requireFinite(functionName, `${field}.expectedMaxSharpe`, record['expectedMaxSharpe']);
  requireCount(functionName, `${field}.trialCount`, record['trialCount']);
  requireFiniteOrPositiveInfinity(
    functionName,
    `${field}.minTrackRecordLength`,
    record['minTrackRecordLength'],
  );
  if (record['outOfSample'] !== undefined) {
    requireArgumentObject(functionName, `${field}.outOfSample`, record['outOfSample']);
    const outOfSample = record['outOfSample'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${field}.outOfSample`, outOfSample, [
      'sharpe',
      'annualizedSharpe',
      'degradation',
    ]);
    requireFiniteOrNull(functionName, `${field}.outOfSample.sharpe`, outOfSample['sharpe']);
    requireFiniteOrNull(
      functionName,
      `${field}.outOfSample.annualizedSharpe`,
      outOfSample['annualizedSharpe'],
    );
    requireFiniteOrNull(
      functionName,
      `${field}.outOfSample.degradation`,
      outOfSample['degradation'],
    );
  }
  requireText(functionName, `${field}.rationale`, record['rationale']);
  requireRiskEnvelope(functionName, field, record);
  const assumptions = record['assumptions'] as Record<string, unknown>;
  ensureKnownKeys(functionName, `${field}.assumptions`, assumptions, [
    'conventionsVersion',
    'confidence',
    'periodsPerYear',
  ]);
  requireUnitInterval(functionName, `${field}.assumptions.confidence`, assumptions['confidence']);
  requireFinite(functionName, `${field}.assumptions.periodsPerYear`, assumptions['periodsPerYear']);
  return value as HygieneResearchVerdict;
}

function requireDeflatedSharpe(
  functionName: string,
  field: string,
  value: unknown,
): HygieneDeflatedSharpe {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, [
    'assumptions',
    'diagnostics',
    'deflatedSharpe',
    'probabilisticSharpe',
    'expectedMaxSharpe',
    'trialCount',
  ]);
  requireRiskEnvelope(functionName, field, record);
  requireFiniteOrNull(functionName, `${field}.deflatedSharpe`, record['deflatedSharpe']);
  requireUnitIntervalOrNull(
    functionName,
    `${field}.probabilisticSharpe`,
    record['probabilisticSharpe'],
  );
  requireFinite(functionName, `${field}.expectedMaxSharpe`, record['expectedMaxSharpe']);
  requireCount(functionName, `${field}.trialCount`, record['trialCount']);
  return value as HygieneDeflatedSharpe;
}

function requireBacktestOverfitting(
  functionName: string,
  field: string,
  value: unknown,
): HygieneBacktestOverfitting {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, [
    'backtestOverfittingProbability',
    'combinations',
    'splits',
    'observations',
    'trials',
    'medianLogit',
    'assumptions',
    'diagnostics',
  ]);
  requireUnitInterval(
    functionName,
    `${field}.backtestOverfittingProbability`,
    record['backtestOverfittingProbability'],
  );
  for (const member of ['combinations', 'splits', 'observations', 'trials'] as const)
    requireCount(functionName, `${field}.${member}`, record[member]);
  requireFinite(functionName, `${field}.medianLogit`, record['medianLogit']);
  requireRiskEnvelope(functionName, field, record);
  return value as HygieneBacktestOverfitting;
}

function requireLeakage(functionName: string, field: string, value: unknown): HygieneLeakageReport {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, ['assumptions', 'diagnostics', 'clean', 'leaks']);
  requireRiskEnvelope(functionName, field, record);
  const clean = requireBoolean(functionName, `${field}.clean`, record['clean']);
  const leaks = record['leaks'];
  if (!Array.isArray(leaks)) {
    fail(functionName, `${field}.leaks`, `${field}.leaks must be an array of leakage issues.`);
  }
  leaks.forEach((leak, index) => {
    const label = `${field}.leaks[${index}]`;
    requireArgumentObject(functionName, label, leak);
    const issue = leak as Record<string, unknown>;
    ensureKnownKeys(functionName, label, issue, ['split', 'overlapCount', 'sample']);
    requireCount(functionName, `${label}.split`, issue['split']);
    requireCount(functionName, `${label}.overlapCount`, issue['overlapCount']);
    if (!Array.isArray(issue['sample'])) {
      fail(functionName, `${label}.sample`, `${label}.sample must be an array of indices.`);
    }
  });
  if (clean && leaks.length > 0) {
    fail(
      functionName,
      `${field}.clean`,
      `${field} says clean: true but lists ${leaks.length} leak${leaks.length === 1 ? '' : 's'} — the block must be a verbatim risk result, not an edited one.`,
      ErrorCode.InputWrongShape,
    );
  }
  return value as HygieneLeakageReport;
}

function requireParameterSweep(
  functionName: string,
  field: string,
  value: unknown,
): HygieneParameterSweep {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, [
    'trialCount',
    'bestSharpe',
    'meanSharpe',
    'varianceSharpe',
    'expectedMaxSharpe',
    'deflatedSharpe',
    'probabilisticSharpe',
  ]);
  requireCount(functionName, `${field}.trialCount`, record['trialCount']);
  for (const member of ['bestSharpe', 'meanSharpe', 'expectedMaxSharpe'] as const)
    requireFinite(functionName, `${field}.${member}`, record[member]);
  requireFiniteOrNull(functionName, `${field}.deflatedSharpe`, record['deflatedSharpe']);
  const variance = requireFinite(functionName, `${field}.varianceSharpe`, record['varianceSharpe']);
  if (variance < 0) {
    fail(
      functionName,
      `${field}.varianceSharpe`,
      `${field}.varianceSharpe is a variance and cannot be negative. Received ${variance}.`,
      ErrorCode.InputOutOfRange,
    );
  }
  requireUnitIntervalOrNull(
    functionName,
    `${field}.probabilisticSharpe`,
    record['probabilisticSharpe'],
  );
  return value as HygieneParameterSweep;
}

function requireMultipleTest(
  functionName: string,
  field: string,
  value: unknown,
): HygieneMultipleTest {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, ['method', 'alpha', 'adjusted', 'rejected']);
  requireEnum(functionName, `${field}.method`, record['method'], MULTIPLE_TEST_METHODS);
  const alpha = requireFinite(functionName, `${field}.alpha`, record['alpha']);
  if (alpha <= 0 || alpha >= 1) {
    fail(
      functionName,
      `${field}.alpha`,
      `${field}.alpha is a significance level and must lie in (0, 1). Received ${alpha}.`,
      ErrorCode.InputOutOfRange,
    );
  }
  const adjusted = record['adjusted'];
  const rejected = record['rejected'];
  if (!Array.isArray(adjusted)) {
    fail(
      functionName,
      `${field}.adjusted`,
      `${field}.adjusted must be an array of adjusted p-values.`,
    );
  }
  if (!Array.isArray(rejected)) {
    fail(functionName, `${field}.rejected`, `${field}.rejected must be an array of booleans.`);
  }
  adjusted.forEach((p, index) =>
    requireUnitInterval(functionName, `${field}.adjusted[${index}]`, p),
  );
  rejected.forEach((flag, index) =>
    requireBoolean(functionName, `${field}.rejected[${index}]`, flag),
  );
  if (adjusted.length !== rejected.length) {
    fail(
      functionName,
      `${field}.rejected`,
      `${field}.adjusted has ${adjusted.length} entries but ${field}.rejected has ${rejected.length} — one decision per test.`,
      ErrorCode.InputWrongShape,
    );
  }
  return value as HygieneMultipleTest;
}

/**
 * Validate a caller-attached hygiene block: closed block keys, each present member's declared
 * top-level keys, and every consumed field — `assumptions` records stay open. Returns the block
 * as given (verbatim storage is the law).
 */
export function requireHygieneBlock(
  functionName: string,
  field: string,
  value: unknown,
): ResearchHygieneBlock {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, HYGIENE_BLOCK_KEYS);
  if (record['protocol'] !== undefined)
    requireProtocol(functionName, `${field}.protocol`, record['protocol']);
  if (record['deflatedSharpe'] !== undefined)
    requireDeflatedSharpe(functionName, `${field}.deflatedSharpe`, record['deflatedSharpe']);
  if (record['backtestOverfitting'] !== undefined)
    requireBacktestOverfitting(
      functionName,
      `${field}.backtestOverfitting`,
      record['backtestOverfitting'],
    );
  if (record['leakage'] !== undefined)
    requireLeakage(functionName, `${field}.leakage`, record['leakage']);
  if (record['parameterSweep'] !== undefined)
    requireParameterSweep(functionName, `${field}.parameterSweep`, record['parameterSweep']);
  if (record['multipleTesting'] !== undefined)
    requireMultipleTest(functionName, `${field}.multipleTesting`, record['multipleTesting']);
  return value as ResearchHygieneBlock;
}
