/**
 * The structured trade policy (Decision 4): a deterministic function of the plan, the states, and
 * the policy that returns checks with verdicts and one decision; `mergeTradePolicies` composes two
 * policies into the stricter one — a hosted policy can never silently weaken a user's.
 */
import { ErrorCode, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { OrderType } from '@totalfinance/core';
import { deepFreeze } from '../internal.js';
import type { PolicyLimits } from '../policy-grammar.js';
import type { MergeTradePoliciesInput, PolicyCheck, PolicyDecision, TradePolicy } from './types.js';
import { refuse, requirePolicyCheck, requireTradePolicy } from './validate.js';

const MERGE_FN = 'mergeTradePolicies';

function minimum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}
function maximum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  return a.filter((v) => b.includes(v));
}

function mergeLimits(
  a: PolicyLimits | undefined,
  b: PolicyLimits | undefined,
): PolicyLimits | undefined {
  if (a === undefined && b === undefined) return undefined;
  const x = a ?? {};
  const y = b ?? {};
  const out: PolicyLimits = {};
  for (const key of [
    'maximumPositionWeight',
    'maximumGrossLeverage',
    'maximumDrawdown',
    'maximumDailyLoss',
    'maximumDaysToLiquidate',
  ] as const) {
    const v = minimum(x[key], y[key]);
    if (v !== undefined) out[key] = v;
  }
  const settled = maximum(x.minimumSettledCash, y.minimumSettledCash);
  if (settled !== undefined) out.minimumSettledCash = settled;
  const groups = [...(x.maximumGroupWeights ?? []), ...(y.maximumGroupWeights ?? [])];
  if (groups.length > 0) out.maximumGroupWeights = groups;
  return out;
}

/** The stricter of every policy given: the minimum of each bound, the intersection of each allow list, the stricter unverifiable handling. */
export function mergeTradePolicies(input: MergeTradePoliciesInput): TradePolicy {
  requireArgumentObject(MERGE_FN, 'input', input);
  ensureKnownKeys(MERGE_FN, 'input', input, ['policies']);
  if (!Array.isArray(input.policies) || input.policies.length === 0)
    refuse(MERGE_FN, 'input.policies', 'must hold at least one policy.');
  const policies = input.policies.map((p, i) =>
    requireTradePolicy(MERGE_FN, `input.policies[${i}]`, p),
  );
  let merged: TradePolicy = { ...policies[0]! };
  for (const next of policies.slice(1)) {
    const out: TradePolicy = { mode: 'paper' };
    const limits = mergeLimits(merged.limits, next.limits);
    if (limits !== undefined) out.limits = limits;
    for (const key of ['allowedAccounts', 'allowedAssetClasses', 'allowedInstruments'] as const) {
      const v = intersect(merged[key], next[key]);
      if (v !== undefined) out[key] = v;
    }
    const types = intersect(merged.allowedOrderTypes, next.allowedOrderTypes);
    if (types !== undefined) out.allowedOrderTypes = types as OrderType[];
    for (const key of [
      'maximumOrderQuantity',
      'maximumOrderNotional',
      'maximumEstimatedCost',
      'maximumSlippageBps',
      'maximumParticipation',
      'marketMaximumAgeMs',
      'maximumTurnover',
    ] as const) {
      const v = minimum(merged[key], next[key]);
      if (v !== undefined) out[key] = v;
    }
    if (
      merged.allowUndefinedRiskOptions !== undefined ||
      next.allowUndefinedRiskOptions !== undefined
    )
      out.allowUndefinedRiskOptions =
        (merged.allowUndefinedRiskOptions ?? false) && (next.allowUndefinedRiskOptions ?? false);
    const notional = minimum(
      merged.requireApprovalAbove?.notional,
      next.requireApprovalAbove?.notional,
    );
    const quantity = minimum(
      merged.requireApprovalAbove?.quantity,
      next.requireApprovalAbove?.quantity,
    );
    if (notional !== undefined || quantity !== undefined)
      out.requireApprovalAbove = {
        ...(notional !== undefined ? { notional } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      };
    if (merged.onUnverifiable === 'deny' || next.onUnverifiable === 'deny')
      out.onUnverifiable = 'deny';
    else if (merged.onUnverifiable !== undefined || next.onUnverifiable !== undefined)
      out.onUnverifiable = 'require-approval';
    merged = out;
  }
  return deepFreeze(merged);
}

/** The decision the checks imply (Decision 3): allow only when every check passes; deny on any failure; otherwise approval. */
const DECIDE = 'decideFromChecks';

export function decideFromChecks(
  checks: readonly PolicyCheck[],
  onUnverifiable: 'require-approval' | 'deny',
): PolicyDecision {
  if (!Array.isArray(checks))
    refuse(DECIDE, 'checks', 'must be an array of policy checks', ErrorCode.InputWrongType);
  if (checks.length === 0)
    refuse(
      DECIDE,
      'checks',
      'is empty; a decision needs at least one check — an allow never comes from no evidence',
    );
  checks.forEach((check, index) => requirePolicyCheck(DECIDE, `checks[${index}]`, check));
  if (onUnverifiable !== 'require-approval' && onUnverifiable !== 'deny')
    refuse(
      DECIDE,
      'onUnverifiable',
      `must be 'require-approval' or 'deny'. Received ${JSON.stringify(onUnverifiable)}`,
      ErrorCode.InputInvalidEnum,
    );
  const failed = checks.filter((c) => c.verdict === 'fail');
  const unverifiable = checks.filter((c) => c.verdict === 'unverifiable');
  const approval = checks.filter((c) => c.verdict === 'require-approval');
  const rows = [...checks];
  if (failed.length > 0 || (unverifiable.length > 0 && onUnverifiable === 'deny'))
    return { verdict: 'deny', checks: rows };
  if (approval.length > 0 || unverifiable.length > 0)
    return {
      verdict: 'require-approval',
      checks: rows,
      requiredScope:
        approval.length > 0 ? 'trade:approve' : 'trade:approve (unverifiable evidence disclosed)',
    };
  return { verdict: 'allow', checks: rows };
}
