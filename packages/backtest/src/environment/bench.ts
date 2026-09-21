/**
 * Agent Bench (Stage 7B.1 slice 4, Decision 9): the maintained baselines, `runAgentBench` — a policy
 * over the episode library at every seed, operational conformance reported apart from strategy
 * quality, no single score by design — and `scoreAgentTranscript`, a deterministic scorer for a
 * recorded transport transcript against the operations, arguments, parity, and refusals a journey
 * expected. Unit tests prove calculations; the bench proves an agent operates.
 */
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { mulberry32 } from '@totalfinance/math';
import { createTradingEnvironment } from './environment.js';
import { runEnvironmentEpisode } from './episode.js';
import { ENVIRONMENT_EPISODE_IDS, environmentEpisode } from './episodes.js';
import {
  MAXIMUM_ENVIRONMENT_STEPS,
  requireFeatureRecipes,
  requireTradingEnvironmentDefinition,
} from './validate.js';
import type {
  AgentBenchEpisode,
  AgentBenchEpisodeReport,
  AgentBenchTrace,
  AgentBenchInput,
  AgentBenchReport,
  AgentTranscript,
  AgentTranscriptExpectation,
  AgentTranscriptScore,
  EnvironmentAction,
  EnvironmentObservation,
  EnvironmentOrder,
  EnvironmentStepResult,
  FeatureRecipes,
  TradingEnvironmentDefinition,
  TradingPolicy,
} from './types.js';

const FN = 'runAgentBench';
const HOLD: EnvironmentAction = { kind: 'hold' };

// ---- the guards --------------------------------------------------------------------------------------

function refuse(functionName: string, field: string, message: string, code: string): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}
function positiveInteger(
  functionName: string,
  field: string,
  value: unknown,
  ceiling: number = MAXIMUM_ENVIRONMENT_STEPS,
): number {
  if (value === null) refuse(functionName, field, 'must not be null.', ErrorCode.InputWrongType);
  if (typeof value !== 'number')
    refuse(
      functionName,
      field,
      `must be a number. Received ${typeof value}.`,
      ErrorCode.InputWrongType,
    );
  if (!Number.isFinite(value))
    refuse(functionName, field, 'must be finite.', ErrorCode.InputNotFinite);
  if (!(Number.isSafeInteger(value) && (value as number) >= 1))
    refuse(
      functionName,
      field,
      `must be a positive safe integer. Received ${String(value)}.`,
      ErrorCode.InputOutOfRange,
    );
  if ((value as number) > ceiling)
    refuse(
      functionName,
      field,
      `is ${value as number}, above the ${ceiling} this coordinate may take.`,
      ErrorCode.BacktestInputTooLarge,
    );
  return value as number;
}
function nonNegativeInteger(
  functionName: string,
  field: string,
  value: unknown,
  ceiling: number = Number.MAX_SAFE_INTEGER,
): number {
  if (value === null) refuse(functionName, field, 'must not be null.', ErrorCode.InputWrongType);
  if (typeof value !== 'number')
    refuse(
      functionName,
      field,
      `must be a number. Received ${typeof value}.`,
      ErrorCode.InputWrongType,
    );
  if (!Number.isFinite(value))
    refuse(functionName, field, 'must be finite.', ErrorCode.InputNotFinite);
  if (!(Number.isSafeInteger(value) && (value as number) >= 0))
    refuse(
      functionName,
      field,
      `must be a non-negative safe integer. Received ${String(value)}.`,
      ErrorCode.InputOutOfRange,
    );
  if ((value as number) > ceiling)
    refuse(
      functionName,
      field,
      `is ${value as number}, above the ${ceiling} this coordinate may take.`,
      ErrorCode.BacktestInputTooLarge,
    );
  return value as number;
}
function requireWeights(
  functionName: string,
  field: string,
  value: unknown,
): Readonly<Record<string, number>> {
  requireArgumentObject(functionName, field, value);
  for (const [id, weight] of Object.entries(value as Record<string, unknown>)) {
    if (id.length === 0)
      refuse(functionName, field, 'has an empty instrument id.', ErrorCode.InputWrongType);
    if (typeof weight !== 'number' || !Number.isFinite(weight))
      refuse(
        functionName,
        `${field}.${id}`,
        `must be a finite number. Received ${weight === null ? 'null' : typeof weight}.`,
        ErrorCode.InputWrongType,
      );
    if (weight < 0)
      refuse(
        functionName,
        `${field}.${id}`,
        `must be >= 0. Received ${weight}.`,
        ErrorCode.InputOutOfRange,
      );
  }
  return value as Readonly<Record<string, number>>;
}
function present(record: object, key: string): boolean {
  return key in record && (record as Record<string, unknown>)[key] !== undefined;
}
function requireStringArray(functionName: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value))
    refuse(
      functionName,
      field,
      `must be an array of strings. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  (value as unknown[]).forEach((row, i) => {
    if (typeof row !== 'string' || row.length === 0)
      refuse(
        functionName,
        `${field}[${i}]`,
        'must be a non-empty string.',
        ErrorCode.InputWrongType,
      );
  });
  return value as string[];
}

// ---- the baselines ---------------------------------------------------------------------------------

/** Whole units of `instrumentId` that `weight` of the NAV buys at the observation's mark. */
function unitsFor(
  observation: EnvironmentObservation,
  instrumentId: string,
  weight: number,
): number {
  const spec = observation.instruments[instrumentId];
  const latest = observation.market[instrumentId];
  const mark = latest?.bar?.close ?? latest?.quote?.bid ?? latest?.chainQuote?.mid ?? null;
  if (spec === undefined || mark === null || !(mark > 0)) return 0;
  const multiplier = spec.contractMultiplier ?? 1;
  return Math.floor((weight * observation.portfolio.netAssetValue) / (mark * multiplier));
}

function heldQuantity(observation: EnvironmentObservation, instrumentId: string): number {
  return (
    observation.portfolio.positions.find((p) => p.instrumentId === instrumentId)?.quantity ?? 0
  );
}

/** Orders that move the book from its held quantities to `targets` (whole units), honoring the mask. */
function tradeTo(
  observation: EnvironmentObservation,
  targets: Readonly<Record<string, number>>,
  prefix: string,
): EnvironmentAction {
  const orders: EnvironmentOrder[] = [];
  for (const [instrumentId, target] of Object.entries(targets)) {
    const held = heldQuantity(observation, instrumentId);
    const delta = target - held;
    if (delta === 0) continue;
    const side = delta > 0 ? 'buy' : 'sell';
    const entry = observation.actionMask[instrumentId];
    if (entry !== undefined && !entry[side]) continue;
    orders.push({
      orderId: `${prefix}:${observation.sequence}:${instrumentId}`,
      instrumentId,
      side,
      quantity: Math.abs(delta),
      type: 'market',
    });
  }
  return orders.length === 0 ? HOLD : { kind: 'orders', orders };
}

function equalWeights(observation: EnvironmentObservation): Record<string, number> {
  const ids = Object.keys(observation.instruments).filter(
    (id) => observation.instruments[id]!.kind !== 'option',
  );
  const weight = ids.length === 0 ? 0 : 0.95 / ids.length;
  return Object.fromEntries(ids.map((id) => [id, weight]));
}

const unitsOf = (
  observation: EnvironmentObservation,
  targets: Readonly<Record<string, number>>,
): Record<string, number> =>
  Object.fromEntries(Object.entries(targets).map(([id, w]) => [id, unitsFor(observation, id, w)]));

export interface BaselinePolicy {
  readonly label: string;
  /** Feature recipes the policy reads; merged into every definition the bench runs it on. */
  readonly requires: FeatureRecipes | null;
  readonly decide: TradingPolicy;
}

export const agentBaselines = Object.freeze({
  holdCash: (): BaselinePolicy =>
    Object.freeze({ label: 'hold-cash', requires: null, decide: () => HOLD }),
  buyAndHold: (input?: { weights?: Readonly<Record<string, number>> }): BaselinePolicy => {
    const fn = 'agentBaselines.buyAndHold';
    if (input !== undefined) {
      requireArgumentObject(fn, 'input', input);
      ensureKnownKeys(fn, 'input', input, ['weights']);
      if (present(input, 'weights')) requireWeights(fn, 'input.weights', input.weights);
    }
    const weights = input?.weights;
    return Object.freeze({
      label: 'buy-and-hold',
      requires: null,
      decide: (observation: EnvironmentObservation): EnvironmentAction => {
        if (observation.sequence !== 0) return HOLD;
        return tradeTo(
          observation,
          unitsOf(observation, weights ?? equalWeights(observation)),
          'bah',
        );
      },
    });
  },
  periodicRebalance: (input: {
    everySessions: number;
    weights?: Readonly<Record<string, number>>;
  }): BaselinePolicy => {
    const fn = 'agentBaselines.periodicRebalance';
    requireArgumentObject(fn, 'input', input);
    ensureKnownKeys(fn, 'input', input, ['everySessions', 'weights']);
    positiveInteger(fn, 'input.everySessions', input.everySessions);
    if (present(input, 'weights')) requireWeights(fn, 'input.weights', input.weights);
    return Object.freeze({
      label: `periodic-rebalance/${input.everySessions}`,
      requires: null,
      decide: (observation: EnvironmentObservation): EnvironmentAction => {
        if (observation.sequence % input.everySessions !== 0) return HOLD;
        return tradeTo(
          observation,
          unitsOf(observation, input.weights ?? equalWeights(observation)),
          'reb',
        );
      },
    });
  },
  randomValidAction: (seed: number): BaselinePolicy => {
    nonNegativeInteger('agentBaselines.randomValidAction', 'seed', seed);
    const rng = mulberry32(seed);
    return Object.freeze({
      label: `random-valid-action/${seed}`,
      requires: null,
      decide: (observation: EnvironmentObservation): EnvironmentAction => {
        const allowed: Array<{ instrumentId: string; side: 'buy' | 'sell' }> = [];
        for (const entry of Object.values(observation.actionMask)) {
          if (entry.buy) allowed.push({ instrumentId: entry.instrumentId, side: 'buy' });
          if (entry.sell && heldQuantity(observation, entry.instrumentId) > 0)
            allowed.push({ instrumentId: entry.instrumentId, side: 'sell' });
        }
        if (allowed.length === 0 || rng.next() < 0.5) return HOLD;
        const pick = allowed[Math.floor(rng.next() * allowed.length)]!;
        const held = heldQuantity(observation, pick.instrumentId);
        const units =
          pick.side === 'sell'
            ? Math.max(1, Math.floor(held * rng.next()))
            : unitsFor(observation, pick.instrumentId, 0.05 * rng.next());
        if (units <= 0) return HOLD;
        return {
          kind: 'orders',
          orders: [
            {
              orderId: `rnd:${observation.sequence}`,
              instrumentId: pick.instrumentId,
              side: pick.side,
              quantity: units,
              type: 'market',
            },
          ],
        };
      },
    });
  },
  riskParity: (input: { lookback: number; everySessions?: number }): BaselinePolicy => {
    const fn = 'agentBaselines.riskParity';
    requireArgumentObject(fn, 'input', input);
    ensureKnownKeys(fn, 'input', input, ['lookback', 'everySessions']);
    positiveInteger(fn, 'input.lookback', input.lookback);
    if (present(input, 'everySessions'))
      positiveInteger(fn, 'input.everySessions', input.everySessions);
    return Object.freeze({
      label: `risk-parity/${input.lookback}`,
      // Environment bars are sessions (one per trading day): 252 per year, stated, never assumed.
      requires: { realizedVolatility: { lookbacks: [input.lookback], annualization: 252 } },
      decide: (observation: EnvironmentObservation): EnvironmentAction => {
        if (observation.sequence % (input.everySessions ?? 20) !== 0) return HOLD;
        const sigma: Readonly<Record<string, number | null>> =
          observation.features.realizedVolatility[String(input.lookback)] ?? {};
        const inverse: Record<string, number> = {};
        let total = 0;
        for (const [id, value] of Object.entries(sigma)) {
          if (value === null || !(value > 0) || observation.instruments[id]!.kind === 'option')
            continue;
          inverse[id] = 1 / value;
          total += 1 / value;
        }
        if (total === 0) return HOLD;
        return tradeTo(
          observation,
          Object.fromEntries(
            Object.entries(inverse).map(([id, w]) => [
              id,
              unitsFor(observation, id, (0.95 * w) / total),
            ]),
          ),
          'rp',
        );
      },
    });
  },
  momentumCrossover: (input: { fast: number; slow: number }): BaselinePolicy => {
    const fn = 'agentBaselines.momentumCrossover';
    requireArgumentObject(fn, 'input', input);
    ensureKnownKeys(fn, 'input', input, ['fast', 'slow']);
    positiveInteger(fn, 'input.fast', input.fast);
    positiveInteger(fn, 'input.slow', input.slow);
    if (!(input.fast < input.slow))
      refuse(
        fn,
        'input.fast',
        `must be shorter than input.slow (${input.slow}). Received ${input.fast}.`,
        ErrorCode.InputOutOfRange,
      );
    return Object.freeze({
      label: `momentum-crossover/${input.fast}-${input.slow}`,
      requires: { lookbackReturns: [input.fast, input.slow] },
      decide: (observation: EnvironmentObservation): EnvironmentAction => {
        const fast = observation.features.lookbackReturns[String(input.fast)] ?? {};
        const slow = observation.features.lookbackReturns[String(input.slow)] ?? {};
        const targets: Record<string, number> = {};
        const ids = Object.keys(observation.instruments).filter(
          (id) => observation.instruments[id]!.kind !== 'option',
        );
        for (const id of ids) {
          const f = fast[id];
          const sl = slow[id];
          if (f === null || f === undefined || sl === null || sl === undefined) continue;
          targets[id] = f > sl ? unitsFor(observation, id, 0.95 / ids.length) : 0;
        }
        return Object.keys(targets).length === 0 ? HOLD : tradeTo(observation, targets, 'mom');
      },
    });
  },
});

// ---- the bench --------------------------------------------------------------------------------------

const INPUT_KEYS = ['policy', 'episodes', 'seeds', 'limits'] as const;
/** The most episode × seed runs one bench call may take (Decision 11). */
export const AGENT_BENCH_RUN_CEILING = 200;

interface Drive {
  results: EnvironmentStepResult[];
  actions: EnvironmentAction[];
  traceHash: string;
  finalValue: number;
  runId: string;
  engineRunId: string;
}

function drive(
  definition: TradingEnvironmentDefinition,
  policy: TradingPolicy,
  seed: number,
  retry: boolean,
): Drive {
  const environment = createTradingEnvironment(definition);
  const start = environment.reset({ seed });
  let observation = start.observation;
  let over = start.terminated || start.truncated;
  let traceHash = start.identity.traceHash;
  const results: EnvironmentStepResult[] = [];
  const actions: EnvironmentAction[] = [];
  while (!over) {
    const action = policy(observation);
    const result = environment.step(action);
    if (retry && action.kind === 'orders') {
      // the retry suite: the same submission again is duplicates, never a second order
      const again = environment.step(action);
      over = again.terminated || again.truncated;
      results.push(result, again);
      actions.push(action, action);
      observation = again.observation;
      traceHash = again.identity.traceHash;
      continue;
    }
    results.push(result);
    actions.push(action);
    observation = result.observation;
    traceHash = result.identity.traceHash;
    over = result.terminated || result.truncated;
  }
  return {
    results,
    actions,
    traceHash,
    finalValue: observation.portfolio.netAssetValue,
    runId: start.identity.runId,
    engineRunId: start.episode.engineRunId,
  };
}

/** Every market row strictly after `cutoff` perturbed — the leakage probe's mutant definition. */
function perturbedAfter(
  definition: TradingEnvironmentDefinition,
  cutoff: number,
): TradingEnvironmentDefinition {
  const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const cloned = JSON.parse(
    JSON.stringify({ ...definition, execution: null, instruments: null }),
  ) as Record<string, unknown>;
  // behavior does not survive JSON: the specifications and the policy are the originals
  delete cloned['execution'];
  delete cloned['instruments'];
  const marketData = cloned['marketData'] as Record<string, unknown[]>;
  for (const [key, rows] of Object.entries(marketData)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      const stamp = (row['timestampMs'] ?? row['asOf']) as number | undefined;
      const date = (row['exDate'] ?? row['paymentDate'] ?? row['effectiveDate']) as
        | string
        | undefined;
      const after =
        stamp !== undefined ? stamp > cutoff : date !== undefined ? date > dateOf(cutoff) : false;
      if (!after) continue;
      for (const field of [
        'close',
        'open',
        'high',
        'low',
        'amount',
        'amountPerUnit',
        'fundingRate',
        'forwardRate',
        'quotePerBase',
        'underlyingPrice',
        'bid',
        'ask',
      ])
        if (typeof row[field] === 'number') row[field] = (row[field] as number) * 3 + 7;
      if (key === 'optionChains')
        for (const q of row['quotes'] as Record<string, unknown>[])
          q['mid'] = (q['mid'] as number) * 2 + 1;
    }
  }
  return {
    ...(cloned as unknown as TradingEnvironmentDefinition),
    instruments: definition.instruments,
    ...(definition.execution !== undefined ? { execution: definition.execution } : {}),
  };
}

function withRequires(
  definition: TradingEnvironmentDefinition,
  requires: FeatureRecipes | null,
): TradingEnvironmentDefinition {
  if (requires === null) return definition;
  const features: FeatureRecipes = { ...(definition.features ?? {}) };
  if (requires.lookbackReturns !== undefined)
    features.lookbackReturns = [
      ...new Set([...(features.lookbackReturns ?? []), ...requires.lookbackReturns]),
    ].sort((a, b) => a - b);
  if (requires.realizedVolatility !== undefined)
    features.realizedVolatility = {
      lookbacks: [
        ...new Set([
          ...(features.realizedVolatility?.lookbacks ?? []),
          ...requires.realizedVolatility.lookbacks,
        ]),
      ].sort((a, b) => a - b),
      // The definition's own bars-per-year wins; a baseline requirement supplies it otherwise.
      annualization:
        features.realizedVolatility?.annualization ?? requires.realizedVolatility.annualization,
    };
  if (requires.drawdown === true) features.drawdown = true;
  return { ...definition, features };
}

export function runAgentBench(input: AgentBenchInput): AgentBenchReport {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const record = input as unknown as Record<string, unknown>;
  const policy = input.policy;
  requireArgumentObject(FN, 'input.policy', policy);
  ensureKnownKeys(FN, 'input.policy', policy, ['label', 'requires', 'decide']);
  if (typeof policy.label !== 'string' || policy.label.length === 0)
    refuse(FN, 'input.policy.label', 'must name the policy.', ErrorCode.InputWrongType);
  if (typeof policy.decide !== 'function')
    refuse(
      FN,
      'input.policy.decide',
      'must be a function of the observation.',
      ErrorCode.InputWrongType,
    );
  if (!('requires' in policy) || policy.requires === undefined)
    refuse(
      FN,
      'input.policy.requires',
      'is required — the feature recipes the policy reads, or null.',
      ErrorCode.InputMissingField,
    );
  if (policy.requires !== null) requireFeatureRecipes(FN, 'input.policy.requires', policy.requires);
  const episodes: readonly AgentBenchEpisode[] =
    record['episodes'] === undefined
      ? ENVIRONMENT_EPISODE_IDS
      : (() => {
          const value = record['episodes'];
          if (!Array.isArray(value) || value.length === 0)
            refuse(
              FN,
              'input.episodes',
              `must name at least one episode. Received ${value === null ? 'null' : typeof value}.`,
              ErrorCode.InputWrongType,
            );
          (value as unknown[]).forEach((entry, i) => {
            if (typeof entry === 'string') {
              if (!(ENVIRONMENT_EPISODE_IDS as readonly string[]).includes(entry))
                refuse(
                  FN,
                  `input.episodes[${i}]`,
                  `must be one of ${ENVIRONMENT_EPISODE_IDS.map((v) => `'${v}'`).join(', ')} or { id, definition }. Received ${JSON.stringify(entry)}.`,
                  ErrorCode.InputInvalidEnum,
                );
              return;
            }
            requireArgumentObject(FN, `input.episodes[${i}]`, entry);
            ensureKnownKeys(FN, `input.episodes[${i}]`, entry as object, ['id', 'definition']);
            const named = entry as Record<string, unknown>;
            if (typeof named['id'] !== 'string' || named['id'].length === 0)
              refuse(
                FN,
                `input.episodes[${i}].id`,
                'must name the episode.',
                ErrorCode.InputWrongType,
              );
            requireTradingEnvironmentDefinition(
              FN,
              `input.episodes[${i}].definition`,
              named['definition'],
            );
          });
          return value as AgentBenchEpisode[];
        })();
  const seeds: readonly number[] =
    record['seeds'] === undefined
      ? [42]
      : (() => {
          const value = record['seeds'];
          if (!Array.isArray(value) || value.length === 0)
            refuse(
              FN,
              'input.seeds',
              `must hold at least one seed. Received ${value === null ? 'null' : typeof value}.`,
              ErrorCode.InputWrongType,
            );
          (value as unknown[]).forEach((seed, i) =>
            nonNegativeInteger(FN, `input.seeds[${i}]`, seed),
          );
          return value as number[];
        })();
  let maximumRuns = AGENT_BENCH_RUN_CEILING;
  if (record['limits'] !== undefined) {
    requireArgumentObject(FN, 'input.limits', record['limits']);
    ensureKnownKeys(FN, 'input.limits', record['limits'] as object, ['maximumRuns']);
    const limits = record['limits'] as Record<string, unknown>;
    if (limits['maximumRuns'] !== undefined) {
      maximumRuns = positiveInteger(FN, 'input.limits.maximumRuns', limits['maximumRuns']);
      if (maximumRuns > AGENT_BENCH_RUN_CEILING)
        refuse(
          FN,
          'input.limits.maximumRuns',
          `must be at most ${AGENT_BENCH_RUN_CEILING}. Received ${maximumRuns}.`,
          ErrorCode.InputOutOfRange,
        );
    }
  }
  const runs = episodes.length * seeds.length;
  if (runs > maximumRuns)
    refuse(
      FN,
      'input.episodes',
      `${episodes.length} episodes × ${seeds.length} seeds = ${runs} runs, above limits.maximumRuns ${maximumRuns}.`,
      ErrorCode.BacktestInputTooLarge,
    );

  const reports: AgentBenchEpisodeReport[] = [];
  const traces: AgentBenchTrace[] = [];
  for (const entry of episodes) {
    for (const seed of seeds) {
      const episode =
        typeof entry === 'string'
          ? environmentEpisode({ id: entry, seed })
          : {
              id: entry.id,
              definition: { ...entry.definition, seed },
              sessions: createTradingEnvironment(entry.definition).instantCount,
            };
      const id = episode.id;
      const definition = withRequires(episode.definition, policy.requires);
      const live = drive(definition, policy.decide, seed, false);
      // replay equality: the recorded trace re-issued through the episode verb
      const replayInput = { definition, seed, actions: live.actions };
      const replayed = runEnvironmentEpisode(replayInput);
      traces.push({ id, seed, input: replayInput, episode: replayed });
      const replayEquality =
        replayed.traceHash === live.traceHash && replayed.result.finalValue === live.finalValue;
      // the leakage probe: rows after the midpoint perturbed, the first half re-driven
      const instants = createTradingEnvironment(definition).instantCount;
      const half = Math.floor(instants / 2);
      const cutoffAsOf =
        live.results[Math.max(0, half - 1)]?.observation.asOf ??
        live.results[0]?.observation.asOf ??
        0;
      let lookAhead = 0;
      if (live.results.length > 0) {
        // identities move with the data (they hash every row); the content may not
        const content = (observation: EnvironmentObservation, runs: readonly string[]): string =>
          runs.reduce(
            (text, id) => text.split(id).join('RUN'),
            canonicalJsonOf({ ...observation, provenance: null, instruments: null }),
          );
        const liveRuns = [live.runId, live.engineRunId];
        const mutant = createTradingEnvironment(perturbedAfter(definition, cutoffAsOf));
        const start = mutant.reset({ seed });
        const mutantRuns = [start.identity.runId, start.episode.engineRunId];
        let over = start.terminated || start.truncated;
        for (let i = 0; i < half && i < live.actions.length && !over; i += 1) {
          const result = mutant.step(live.actions[i]!);
          if (
            content(result.observation, mutantRuns) !==
            content(live.results[i]!.observation, liveRuns)
          )
            lookAhead += 1;
          over = result.terminated || result.truncated;
        }
      }
      // the retry suite: every submission twice
      const retried = drive(definition, policy.decide, seed, true);
      const onceFills = live.results.reduce((s, r) => s + r.fills.length, 0);
      const twiceFills = retried.results.reduce((s, r) => s + r.fills.length, 0);
      const duplicateOrders = Math.max(0, twiceFills - onceFills);
      const maskViolations = live.results.reduce(
        (s, r) => s + r.rejections.filter((x) => x.code === 'environment.action_disallowed').length,
        0,
      );
      const limitBreaches = live.results.reduce(
        (s, r) =>
          s +
          r.rejections.filter((x) => x.code === 'environment.limit_breach').length +
          r.observation.limits.breaches.length,
        0,
      );
      const engine = replayed.result;
      const reconciled = Math.abs(engine.diagnostics.reconciliationResidual) <= 1e-9;
      const operational = {
        lookAhead,
        replayEquality,
        duplicateOrders,
        maskViolations,
        limitBreaches,
        externalOrderAttempts: 0 as const,
        reconciled,
        passes: lookAhead === 0 && replayEquality && duplicateOrders === 0 && reconciled,
      };
      const initial = engine.points[0]?.equity ?? 0;
      const tradedNotional = live.results.reduce(
        (s, r) =>
          s +
          r.fills.reduce(
            (t, f) => t + Math.abs(f.quantity * f.pricePerUnit * (f.contractMultiplier ?? 1)),
            0,
          ),
        0,
      );
      const costs = live.results.reduce(
        (s, r) =>
          s +
          r.fills.reduce(
            (t, f) =>
              t +
              ((f.costs?.commission ?? 0) +
                (f.costs?.exchangeFees ?? 0) +
                (f.costs?.regulatoryFees ?? 0) +
                (f.costs?.slippageAdjustment ?? 0) +
                (f.executionPriceAdjustment ?? 0)),
            0,
          ),
        0,
      );
      const exposures = live.results.map((r) =>
        r.observation.portfolio.netAssetValue > 0
          ? r.observation.portfolio.grossExposure / r.observation.portfolio.netAssetValue
          : 0,
      );
      const strategy = {
        totalReturn: engine.performance.totalReturn,
        annualizedVolatility: engine.performance.annualizedVolatility,
        sharpe: engine.performance.sharpe,
        sortino: engine.performance.sortino,
        maxDrawdown: engine.performance.maxDrawdown,
        turnover: initial > 0 ? tradedNotional / initial : 0,
        cost: initial > 0 ? costs / initial : 0,
        meanGrossExposure:
          exposures.length === 0 ? 0 : exposures.reduce((s, e) => s + e, 0) / exposures.length,
        violations: maskViolations + limitBreaches,
        steps: live.results.length,
        finalValue: live.finalValue,
        rewardTotal: live.results.reduce((s, r) => s + r.reward.total, 0),
      };
      reports.push({
        id,
        seed,
        sessions: episode.sessions,
        terminated: live.results[live.results.length - 1]?.terminated ?? false,
        reason: live.results[live.results.length - 1]?.reason ?? null,
        operational,
        strategy,
      });
    }
  }
  const mean = (pick: (r: AgentBenchEpisodeReport) => number | null): number | null => {
    const values = reports.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
  };
  return {
    policy: policy.label,
    episodes: reports,
    traces,
    operational: {
      passes: reports.every((r) => r.operational.passes),
      failing: reports.filter((r) => !r.operational.passes).map((r) => `${r.id}@${r.seed}`),
      lookAhead: reports.reduce((s, r) => s + r.operational.lookAhead, 0),
      duplicateOrders: reports.reduce((s, r) => s + r.operational.duplicateOrders, 0),
      maskViolations: reports.reduce((s, r) => s + r.operational.maskViolations, 0),
      limitBreaches: reports.reduce((s, r) => s + r.operational.limitBreaches, 0),
      externalOrderAttempts: 0 as const,
    },
    strategy: {
      meanTotalReturn: mean((r) => r.strategy.totalReturn),
      meanSharpe: mean((r) => r.strategy.sharpe),
      meanMaxDrawdown: mean((r) => r.strategy.maxDrawdown),
      meanTurnover: mean((r) => r.strategy.turnover),
      meanCost: mean((r) => r.strategy.cost),
      meanGrossExposure: mean((r) => r.strategy.meanGrossExposure),
      violations: reports.reduce((s, r) => s + r.strategy.violations, 0),
    },
    assumptions: {
      episodes: episodes.map((entry) => (typeof entry === 'string' ? entry : entry.id)),
      seeds: [...seeds],
      runs: reports.length,
      dimensions:
        'operational conformance and strategy quality are reported separately; the report has no single score by design',
      leakageProbe:
        'every market row after the midpoint instant is perturbed and the first half re-driven; a differing trace hash or net asset value counts as look-ahead',
      retrySuite:
        'every submission is sent twice; fills beyond the single-submission run count as duplicate orders',
    },
    diagnostics: { engine: 'agent-bench', method: 'episode-sweep', converged: true, warnings: [] },
  };
}

// ---- the transcript scorer ---------------------------------------------------------------------------

const SCORE_FN = 'scoreAgentTranscript';

export function scoreAgentTranscript(input: {
  transcript: AgentTranscript;
  expected: AgentTranscriptExpectation;
}): AgentTranscriptScore {
  requireArgumentObject(SCORE_FN, 'input', input);
  ensureKnownKeys(SCORE_FN, 'input', input, ['transcript', 'expected']);
  const { transcript, expected } = input;
  requireArgumentObject(SCORE_FN, 'input.transcript', transcript);
  ensureKnownKeys(SCORE_FN, 'input.transcript', transcript, ['calls', 'answer']);
  if (!Array.isArray(transcript.calls))
    refuse(
      SCORE_FN,
      'input.transcript.calls',
      `must be an array of calls. Received ${transcript.calls === null ? 'null' : typeof transcript.calls}.`,
      ErrorCode.InputWrongType,
    );
  transcript.calls.forEach((call, i) => {
    const at = `input.transcript.calls[${i}]`;
    requireArgumentObject(SCORE_FN, at, call);
    ensureKnownKeys(SCORE_FN, at, call, [
      'operation',
      'arguments',
      'ok',
      'error',
      'result',
      'bytes',
    ]);
    if (typeof call.operation !== 'string' || call.operation.length === 0)
      refuse(SCORE_FN, `${at}.operation`, 'must name an operation.', ErrorCode.InputWrongType);
    if (typeof call.ok !== 'boolean')
      refuse(SCORE_FN, `${at}.ok`, 'must be a boolean.', ErrorCode.InputWrongType);
    if (present(call, 'error')) {
      requireArgumentObject(SCORE_FN, `${at}.error`, call.error);
      ensureKnownKeys(SCORE_FN, `${at}.error`, call.error as object, ['code', 'message']);
      if (typeof call.error!.code !== 'string' || call.error!.code.length === 0)
        refuse(
          SCORE_FN,
          `${at}.error.code`,
          'must be a non-empty string.',
          ErrorCode.InputWrongType,
        );
      if (present(call.error as object, 'message') && typeof call.error!.message !== 'string')
        refuse(SCORE_FN, `${at}.error.message`, 'must be a string.', ErrorCode.InputWrongType);
    }
    if (present(call, 'bytes'))
      nonNegativeInteger(SCORE_FN, `${at}.bytes`, call.bytes, 1_073_741_824);
  });
  requireArgumentObject(SCORE_FN, 'input.transcript.answer', transcript.answer);
  ensureKnownKeys(SCORE_FN, 'input.transcript.answer', transcript.answer, [
    'text',
    'citedArtifactIds',
    'refused',
  ]);
  if (typeof transcript.answer.text !== 'string')
    refuse(SCORE_FN, 'input.transcript.answer.text', 'must be a string.', ErrorCode.InputWrongType);
  if (present(transcript.answer, 'citedArtifactIds'))
    requireStringArray(
      SCORE_FN,
      'input.transcript.answer.citedArtifactIds',
      transcript.answer.citedArtifactIds,
    );
  if (present(transcript.answer, 'refused') && typeof transcript.answer.refused !== 'boolean')
    refuse(
      SCORE_FN,
      'input.transcript.answer.refused',
      'must be a boolean.',
      ErrorCode.InputWrongType,
    );
  requireArgumentObject(SCORE_FN, 'input.expected', expected);
  ensureKnownKeys(SCORE_FN, 'input.expected', expected, [
    'operations',
    'argumentPredicates',
    'parity',
    'mustRefuse',
    'artifactIds',
    'budget',
  ]);
  requireStringArray(SCORE_FN, 'input.expected.operations', expected.operations);
  if (present(expected, 'argumentPredicates')) {
    requireArgumentObject(
      SCORE_FN,
      'input.expected.argumentPredicates',
      expected.argumentPredicates,
    );
    for (const [operation, predicate] of Object.entries(expected.argumentPredicates!))
      if (typeof predicate !== 'function')
        refuse(
          SCORE_FN,
          `input.expected.argumentPredicates.${operation}`,
          'must be a function of the arguments.',
          ErrorCode.InputWrongType,
        );
  }
  if (present(expected, 'parity')) {
    requireArgumentObject(SCORE_FN, 'input.expected.parity', expected.parity);
    ensureKnownKeys(SCORE_FN, 'input.expected.parity', expected.parity as object, [
      'operation',
      'direct',
    ]);
    if (typeof expected.parity!.operation !== 'string' || expected.parity!.operation.length === 0)
      refuse(
        SCORE_FN,
        'input.expected.parity.operation',
        'must name an operation.',
        ErrorCode.InputWrongType,
      );
    if (!('direct' in expected.parity!))
      refuse(
        SCORE_FN,
        'input.expected.parity.direct',
        "is required — the direct call's result.",
        ErrorCode.InputMissingField,
      );
  }
  if (present(expected, 'mustRefuse') && typeof expected.mustRefuse !== 'boolean')
    refuse(SCORE_FN, 'input.expected.mustRefuse', 'must be a boolean.', ErrorCode.InputWrongType);
  if (present(expected, 'artifactIds'))
    requireStringArray(SCORE_FN, 'input.expected.artifactIds', expected.artifactIds);
  if (present(expected, 'budget')) {
    requireArgumentObject(SCORE_FN, 'input.expected.budget', expected.budget);
    ensureKnownKeys(SCORE_FN, 'input.expected.budget', expected.budget as object, [
      'maximumCalls',
      'maximumBytes',
    ]);
    if (present(expected.budget as object, 'maximumCalls'))
      positiveInteger(
        SCORE_FN,
        'input.expected.budget.maximumCalls',
        expected.budget!.maximumCalls,
      );
    if (present(expected.budget as object, 'maximumBytes'))
      positiveInteger(
        SCORE_FN,
        'input.expected.budget.maximumBytes',
        expected.budget!.maximumBytes,
      );
  }

  const calls = transcript.calls;
  const called = new Set(calls.map((c) => c.operation));
  const selected = expected.operations.filter((op) => called.has(op));
  const operationSelection =
    expected.operations.length === 0 ? 1 : selected.length / expected.operations.length;
  const firstAttempts = expected.operations
    .map((op) => calls.find((c) => c.operation === op))
    .filter((c) => c !== undefined);
  const firstAttemptValidity =
    firstAttempts.length === 0
      ? null
      : firstAttempts.filter((c) => c!.ok).length / firstAttempts.length;
  let teachingErrors = 0;
  let recovered = 0;
  calls.forEach((call, i) => {
    if (call.ok) return;
    teachingErrors += 1;
    const next = calls.slice(i + 1).find((c) => c.operation === call.operation);
    if (next !== undefined && next.ok) recovered += 1;
  });
  const recovery = teachingErrors === 0 ? null : recovered / teachingErrors;
  const predicates = expected.argumentPredicates ?? {};
  const judged = calls.filter((c) => typeof predicates[c.operation] === 'function');
  const argumentValidity =
    judged.length === 0
      ? null
      : judged.filter((c) => predicates[c.operation]!(c.arguments)).length / judged.length;
  let parity: boolean | null = null;
  if (expected.parity !== undefined) {
    const call = [...calls]
      .reverse()
      .find((c) => c.operation === expected.parity!.operation && c.ok);
    parity =
      call !== undefined &&
      canonicalJsonOf(call.result ?? null) === canonicalJsonOf(expected.parity.direct ?? null);
  }
  const refused = transcript.answer.refused === true;
  const refusal = expected.mustRefuse === undefined ? null : expected.mustRefuse === refused;
  const cited = transcript.answer.citedArtifactIds ?? [];
  const traceability =
    expected.artifactIds === undefined
      ? null
      : expected.artifactIds.length === 0
        ? 1
        : expected.artifactIds.filter((id) => cited.includes(id)).length /
          expected.artifactIds.length;
  const bytes = calls.reduce((s, c) => s + (c.bytes ?? 0), 0);
  const withinBudget =
    expected.budget === undefined
      ? null
      : (expected.budget.maximumCalls === undefined ||
          calls.length <= expected.budget.maximumCalls) &&
        (expected.budget.maximumBytes === undefined || bytes <= expected.budget.maximumBytes);
  return {
    operationSelection,
    firstAttemptValidity,
    recovery,
    argumentValidity,
    parity,
    refusal,
    traceability,
    calls: calls.length,
    bytes,
    withinBudget,
    passes:
      operationSelection === 1 &&
      (parity ?? true) &&
      (refusal ?? true) &&
      (withinBudget ?? true) &&
      (traceability ?? 1) === 1,
    assumptions: {
      deterministic: true,
      scoring: 'fractions of the expected set; null where the expectation declared nothing',
    },
    diagnostics: {
      engine: 'agent-bench',
      method: 'transcript-score',
      converged: true,
      warnings: [],
    },
  };
}
