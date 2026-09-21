/**
 * The reward as a declared composition (Stage 7B.1 slice 2, Decision 7): every component's raw value
 * is reported with its weight and contribution — weight 0 when the composition omits it — so a
 * consumer always sees the financial outcome regardless of what the policy is paid for. A reward
 * never touches the accounting: it is computed from the step frame the engine already produced.
 */
import { ErrorCode, InputError } from '@totalfinance/core';
import type { RewardBreakdown, RewardComponent, RewardComposition, RewardFrame } from './types.js';

const FN = 'createTradingEnvironment';

export const REWARD_COMPONENT_NAMES = Object.freeze([
  'pnl',
  'drawdown',
  'turnover',
  'cost',
  'concentration',
  'leverage',
  'riskViolation',
  'benchmark',
] as const);

export type RewardComponentName = (typeof REWARD_COMPONENT_NAMES)[number];

function component(value: number, weight: number): RewardComponent {
  return { value, weight, contribution: weight * value };
}

export function rewardBreakdown(
  composition: RewardComposition | undefined,
  frame: RewardFrame,
): RewardBreakdown {
  const c = composition ?? {};
  const before = frame.netAssetValueBefore;
  const after = frame.netAssetValueAfter;
  const perBefore = (amount: number): number => (before > 0 ? amount / before : 0);
  const perAfter = (amount: number): number => (after > 0 ? amount / after : 0);
  const values: Record<RewardComponentName, number> = {
    pnl: frame.stepReturn,
    drawdown: Math.max(0, frame.drawdownAfter - frame.drawdownBefore),
    turnover: perBefore(frame.tradedNotional),
    cost: perBefore(frame.costs),
    concentration: frame.largestPositionWeight,
    leverage: perAfter(frame.grossExposure),
    riskViolation: frame.violations,
    benchmark: frame.benchmarkReturn === null ? 0 : frame.stepReturn - frame.benchmarkReturn,
  };
  const weights: Record<RewardComponentName, number> = {
    pnl: c.pnl ?? 0,
    drawdown: c.drawdown ?? 0,
    turnover: c.turnover ?? 0,
    cost: c.cost ?? 0,
    concentration: c.concentration ?? 0,
    leverage: c.leverage ?? 0,
    riskViolation: c.riskViolation ?? 0,
    benchmark: c.benchmark?.weight ?? 0,
  };
  const components: Record<string, RewardComponent> = {};
  let total = 0;
  for (const name of REWARD_COMPONENT_NAMES) {
    const row = component(values[name], weights[name]);
    components[name] = row;
    total += row.contribution;
  }
  if (c.goal !== undefined) {
    const terms = c.goal(frame);
    if (terms === null || typeof terms !== 'object' || Array.isArray(terms)) {
      throw new InputError(
        `${FN}: reward.goal must return a record of named finite terms at step ${frame.step}; received ${terms === null ? 'null' : Array.isArray(terms) ? 'an array' : typeof terms}.`,
        { code: ErrorCode.InputWrongType, context: { function: FN, field: 'reward.goal' } },
      );
    }
    for (const [name, value] of Object.entries(terms)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InputError(
          `${FN}: reward.goal term '${name}' must be a finite number at step ${frame.step}; received ${String(value)}.`,
          {
            code: ErrorCode.InputNotFinite,
            context: { function: FN, field: `reward.goal.${name}` },
          },
        );
      }
      if (name in components) {
        throw new InputError(
          `${FN}: reward.goal term '${name}' shadows the built-in component of that name — choose another name.`,
          {
            code: ErrorCode.InputUnknownField,
            context: { function: FN, field: `reward.goal.${name}` },
          },
        );
      }
      const row = component(value, 1);
      components[name] = row;
      total += row.contribution;
    }
  }
  return { total, components };
}
