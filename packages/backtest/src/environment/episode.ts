/**
 * `runEnvironmentEpisode` (Stage 7B.1 slice 3, Decision 7): drive an environment with a recorded
 * action trace from `reset` to the end and return the episode as one record — the engine's own
 * result, every step's canonical action, reward, and identity, and the trace hash. It is the
 * artifact spine's verb for the `environment` run kind: a saved episode replays by running this
 * function again on its stored input and comparing the trace hash, the equity, and the rewards.
 */
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { CONVENTIONS_VERSION } from '@totalfinance/core';
import { createTradingEnvironment } from './environment.js';
import { requireEnvironmentAction, requireTradingEnvironmentDefinition } from './validate.js';
import type {
  EnvironmentAction,
  EnvironmentEpisodeInput,
  EnvironmentEpisodeResult,
  EnvironmentEpisodeStep,
} from './types.js';

const FN = 'runEnvironmentEpisode';
const INPUT_KEYS = ['definition', 'seed', 'actions'] as const;
/** The most actions one trace may carry — the episode ceiling. */
const ACTION_CEILING = 100_000;

export function requireEnvironmentEpisodeInput(
  functionName: string,
  label: string,
  value: unknown,
): EnvironmentEpisodeInput {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, INPUT_KEYS);
  const input = value as Record<string, unknown>;
  requireTradingEnvironmentDefinition(functionName, `${label}.definition`, input['definition']);
  if ('seed' in input && input['seed'] !== undefined) {
    const seed = input['seed'];
    if (!(Number.isSafeInteger(seed) && (seed as number) >= 0)) {
      throw new InputError(
        `${functionName}: ${label}.seed must be a non-negative safe integer. Received ${String(seed)}.`,
        {
          code: typeof seed === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.seed` },
        },
      );
    }
  }
  if (!Array.isArray(input['actions'])) {
    throw new InputError(`${functionName}: ${label}.actions must be an array of actions.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: `${label}.actions` },
    });
  }
  if (input['actions'].length > ACTION_CEILING) {
    throw new InputError(
      `${functionName}: ${label}.actions holds ${input['actions'].length} actions, above the ${ACTION_CEILING} one episode may take.`,
      {
        code: ErrorCode.BacktestInputTooLarge,
        context: { function: functionName, field: `${label}.actions` },
      },
    );
  }
  (input['actions'] as unknown[]).forEach((action, i) =>
    requireEnvironmentAction(functionName, `${label}.actions[${i}]`, action),
  );
  return value as EnvironmentEpisodeInput;
}

export function runEnvironmentEpisode(input: EnvironmentEpisodeInput): EnvironmentEpisodeResult {
  requireEnvironmentEpisodeInput(FN, 'input', input);
  const environment = createTradingEnvironment(input.definition);
  const start = environment.reset(input.seed === undefined ? undefined : { seed: input.seed });
  const steps: EnvironmentEpisodeStep[] = [];
  let terminated = start.terminated;
  let truncated = start.truncated;
  let reason: EnvironmentEpisodeResult['reason'] = start.reason;
  let violations = 0;
  let fills = 0;
  let rejections = 0;
  let rewardTotal = 0;
  let over = terminated || truncated;
  for (const [i, action] of (input.actions as readonly EnvironmentAction[]).entries()) {
    if (over) {
      throw new InputError(
        `${FN}: input.actions[${i}] comes after the episode ended at step ${steps.length} (${reason ?? 'terminal'}) — a trace must not outlive its episode.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: FN, field: `input.actions[${i}]`, step: steps.length },
        },
      );
    }
    const result = environment.step(action);
    steps.push({
      step: result.identity.step,
      asOf: result.observation.asOf,
      action: result.observation.previous!.action,
      traceHash: result.identity.traceHash,
      reward: result.reward,
      netAssetValue: result.observation.portfolio.netAssetValue,
      fills: result.fills.length,
      rejections: result.rejections.length,
      breaches: result.observation.limits.breaches.length,
    });
    fills += result.fills.length;
    rejections += result.rejections.length;
    violations += result.reward.components['riskViolation']?.value ?? 0;
    rewardTotal += result.reward.total;
    terminated = result.terminated;
    truncated = result.truncated;
    reason = result.reason;
    over = terminated || truncated;
  }
  const engine = environment.finish();
  return {
    runId: start.identity.runId,
    engineRunId: start.episode.engineRunId,
    definitionHash: start.episode.definitionHash,
    seed: start.episode.seed,
    traceHash: steps.length === 0 ? start.identity.traceHash : steps[steps.length - 1]!.traceHash,
    steps,
    rewards: steps.map((s) => s.reward.total),
    rewardTotal,
    terminated,
    truncated,
    reason,
    result: engine,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      replayable:
        input.definition.reward?.goal === undefined &&
        Object.values(input.definition.instruments).every((spec) => spec.kind !== 'custom'),
      nextObservationLaw:
        'an order decided on observation k meets the market at instant k + 1 through the declared fill model; it is never filled on the observation that produced it',
      executionPolicy: engine.assumptions.execution.label,
      maximumSteps: start.episode.maximumSteps,
      instantCount: start.episode.instantCount,
    },
    diagnostics: {
      engine: 'trading-environment',
      method: 'stepper-episode',
      converged: true,
      warnings: engine.diagnostics.warnings,
      stepCount: steps.length,
      fillCount: fills,
      rejectionCount: rejections,
      violationCount: violations,
    },
  };
}
