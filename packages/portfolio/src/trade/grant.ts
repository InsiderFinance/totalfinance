/**
 * The authorization grant (Decision 5): human authority bound to one plan, one preflight, the
 * portfolio and market they were judged against, a mode, an account, a variance envelope, an
 * expiry, and a closed set of idempotency keys. `createAuthorizationGrant` mints one from a
 * preflight that did not deny; `verifyAuthorizationGrant` re-checks every binding at execution
 * time and never trusts an earlier answer. A material change produces a new plan and needs new
 * authority.
 */
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import {
  deepFreeze,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
} from '../internal.js';
import {
  AUTHORIZATION_GRANT_KIND,
  AUTHORIZATION_GRANT_SCHEMA_VERSION,
  type AuthorizationGrant,
  type CreateAuthorizationGrantInput,
  type ExecutionPlan,
  type GrantRefusal,
  type GrantVerification,
  type TradeOrder,
  type VerifyAuthorizationGrantInput,
} from './types.js';
import {
  refuse,
  requireAuthorizationGrant,
  requireExecutionPlan,
  requireGrantVariance,
  requirePreflightReport,
  requireTradeOrder,
} from './validate.js';

const CREATE = 'createAuthorizationGrant';
const CREATE_KEYS = [
  'plan',
  'preflight',
  'portfolioHash',
  'marketHash',
  'marketMaximumAgeMs',
  'mode',
  'account',
  'variance',
  'expiresAt',
  'approvedBy',
  'idempotencyKeys',
  'now',
  'grantId',
] as const;
const VERIFY = 'verifyAuthorizationGrant';
const VERIFY_KEYS = [
  'grant',
  'plan',
  'now',
  'portfolioHash',
  'marketHash',
  'marketAsOf',
  'mode',
  'idempotencyKey',
  'orders',
] as const;
const PREFIX_KEYS = ['prefix', 'count'] as const;

/** A grant carries at most this many idempotency keys — one per submission attempt it licenses. */
export const GRANT_IDEMPOTENCY_KEY_CEILING = 1_000;

function resolveIdempotencyKeys(value: unknown): string[] {
  const field = 'input.idempotencyKeys';
  if (Array.isArray(value)) {
    if (value.length === 0) refuse(CREATE, field, 'must name at least one idempotency key');
    if (value.length > GRANT_IDEMPOTENCY_KEY_CEILING) {
      refuse(
        CREATE,
        field,
        `names ${value.length} keys; a grant carries at most ${GRANT_IDEMPOTENCY_KEY_CEILING}`,
      );
    }
    const seen = new Set<string>();
    value.forEach((key, index) => {
      requireIdentityString(CREATE, `${field}[${index}]`, key);
      if (seen.has(key)) refuse(CREATE, `${field}[${index}]`, `duplicates ${JSON.stringify(key)}`);
      seen.add(key);
    });
    return [...(value as string[])];
  }
  requireArgumentObject(CREATE, field, value);
  ensureKnownKeys(CREATE, field, value as object, PREFIX_KEYS);
  const { prefix, count } = value as { prefix: unknown; count: unknown };
  requireIdentityString(CREATE, `${field}.prefix`, prefix);
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > GRANT_IDEMPOTENCY_KEY_CEILING
  ) {
    refuse(
      CREATE,
      `${field}.count`,
      `must be an integer in [1, ${GRANT_IDEMPOTENCY_KEY_CEILING}]. Received ${String(count)}`,
    );
  }
  return Array.from({ length: count }, (_, index) => `${prefix}:${index + 1}`);
}

/**
 * Mint a grant (Decision 5). Refuses a preflight whose decision is `deny`
 * (`trade.preflight_denied`), a plan the preflight did not judge, a portfolio or market hash that
 * differs from the preflight's, an account the plan is not for (`trade.grant_invalid`), an expiry
 * not after `now` (`trade.grant_expired`), and `mode: 'live'` (`trade.live_unavailable`). A
 * `require-approval` preflight carries its scope into the grant; the runtime (slice 4) checks the
 * approver holds it.
 */
export function createAuthorizationGrant(input: CreateAuthorizationGrantInput): AuthorizationGrant {
  requireArgumentObject(CREATE, 'input', input);
  ensureKnownKeys(CREATE, 'input', input, CREATE_KEYS);
  const plan = requireExecutionPlan(CREATE, 'input.plan', input.plan);
  const preflight = requirePreflightReport(CREATE, 'input.preflight', input.preflight);
  requireEpochMsField(CREATE, 'input.now', input.now);
  requireEpochMsField(CREATE, 'input.expiresAt', input.expiresAt);
  if (input.mode !== 'paper') {
    if ((input.mode as unknown) === 'live') {
      refuse(
        CREATE,
        'input.mode',
        "'live' is not available in this stage — live execution is AT8, behind the same lifecycle. Use 'paper'",
        ErrorCode.TradeLiveUnavailable,
      );
    }
    refuse(CREATE, 'input.mode', `must be 'paper'. Received ${JSON.stringify(input.mode)}`);
  }
  if (preflight.assumptions.mode !== 'paper') {
    refuse(
      CREATE,
      'input.preflight.assumptions.mode',
      `must be 'paper' to authorize a paper execution. Received ${JSON.stringify(preflight.assumptions.mode)}`,
      ErrorCode.TradeGrantInvalid,
    );
  }
  if (preflight.planHash !== plan.contentHash) {
    refuse(
      CREATE,
      'input.preflight.planHash',
      `must be the plan's content hash (${plan.contentHash}); the preflight judged ${preflight.planHash}. Preflight this plan, then authorize it`,
      ErrorCode.TradeGrantInvalid,
    );
  }
  if (preflight.decision.verdict === 'deny') {
    const failed = preflight.checks
      .filter((check) => check.verdict === 'fail')
      .map((check) => check.name);
    refuse(
      CREATE,
      'input.preflight',
      `was denied (${failed.length === 0 ? 'no check passed' : `failed: ${failed.join(', ')}`}); a denied plan cannot be authorized — change the plan and preflight again`,
      ErrorCode.TradePreflightDenied,
    );
  }
  const portfolioHash = bindHash('portfolioHash', input.portfolioHash, preflight.portfolioHash);
  const marketHash = bindHash('marketHash', input.marketHash, preflight.marketHash);
  requireFiniteNumberField(CREATE, 'input.marketMaximumAgeMs', input.marketMaximumAgeMs);
  if (!(input.marketMaximumAgeMs > 0)) refuse(CREATE, 'input.marketMaximumAgeMs', 'must be > 0');
  let accountId = plan.accountId;
  if (input.account !== undefined) {
    requireIdentityString(CREATE, 'input.account', input.account);
    if (input.account !== plan.accountId) {
      refuse(
        CREATE,
        'input.account',
        `must be the plan's account (${JSON.stringify(plan.accountId)}). Received ${JSON.stringify(input.account)}`,
        ErrorCode.TradeGrantInvalid,
      );
    }
    accountId = input.account;
  }
  requireIdentityString(CREATE, 'input.approvedBy', input.approvedBy);
  if (input.expiresAt <= input.now) {
    refuse(
      CREATE,
      'input.expiresAt',
      `must be after input.now (${input.now}); a grant that is already expired authorizes nothing. Received ${input.expiresAt}`,
      ErrorCode.TradeGrantExpired,
    );
  }
  const variance = requireGrantVariance(CREATE, 'input.variance', input.variance);
  const idempotencyKeys = resolveIdempotencyKeys(input.idempotencyKeys);
  let grantId = `grant:${plan.contentHash.slice(0, 16)}:${input.now}`;
  if (input.grantId !== undefined) {
    requireIdentityString(CREATE, 'input.grantId', input.grantId);
    grantId = input.grantId;
  }
  const body = {
    kind: AUTHORIZATION_GRANT_KIND,
    schemaVersion: AUTHORIZATION_GRANT_SCHEMA_VERSION,
    grantId,
    planHash: plan.contentHash,
    preflightHash: preflight.contentHash,
    portfolioHash,
    marketHash,
    marketAsOf: preflight.marketAsOf,
    marketMaximumAgeMs: input.marketMaximumAgeMs,
    mode: 'paper' as const,
    accountId,
    baseCurrency: plan.baseCurrency,
    orderIds: plan.orders.map((order) => order.orderId),
    comboIds: plan.combos.map((combo) => combo.comboId),
    variance,
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    approvedBy: input.approvedBy,
    requiredScope:
      preflight.decision.verdict === 'require-approval' ? preflight.decision.requiredScope : null,
    idempotencyKeys,
  };
  return deepFreeze({ ...body, contentHash: contentHash(body) } as AuthorizationGrant);
}

function bindHash(name: 'portfolioHash' | 'marketHash', given: unknown, judged: string): string {
  if (given === undefined) return judged;
  requireIdentityString(CREATE, `input.${name}`, given);
  if (given !== judged) {
    refuse(
      CREATE,
      `input.${name}`,
      `must be the hash the preflight judged (${judged}); a grant binds the snapshots preflight saw. Received ${given}`,
      ErrorCode.TradeGrantInvalid,
    );
  }
  return given;
}

function planTradeFor(plan: ExecutionPlan, order: TradeOrder, index: number) {
  const byIndex = plan.trades[index];
  if (
    byIndex !== undefined &&
    byIndex.instrumentId === order.instrumentId &&
    byIndex.side === order.side
  ) {
    return byIndex;
  }
  return plan.trades.find(
    (trade) => trade.instrumentId === order.instrumentId && trade.side === order.side,
  );
}

/**
 * Re-verify a grant at execution (Decision 5): expiry, the plan hash, the portfolio and market
 * hashes, the market's age against the grant's allowance, the mode, the account, the idempotency
 * key, and — when the orders about to be submitted differ from the plan's — the variance envelope
 * (quantity ratio, notional ratio, limit-price slippage). Every binding is checked; the result
 * lists every reason, never the first.
 */
export function verifyAuthorizationGrant(input: VerifyAuthorizationGrantInput): GrantVerification {
  requireArgumentObject(VERIFY, 'input', input);
  ensureKnownKeys(VERIFY, 'input', input, VERIFY_KEYS);
  const grant = requireAuthorizationGrant(VERIFY, 'input.grant', input.grant);
  const plan = requireExecutionPlan(VERIFY, 'input.plan', input.plan);
  requireEpochMsField(VERIFY, 'input.now', input.now);
  requireIdentityString(VERIFY, 'input.portfolioHash', input.portfolioHash);
  requireIdentityString(VERIFY, 'input.marketHash', input.marketHash);
  requireEpochMsField(VERIFY, 'input.marketAsOf', input.marketAsOf);
  requireIdentityString(VERIFY, 'input.idempotencyKey', input.idempotencyKey);
  const mode = input.mode === undefined ? 'paper' : input.mode;
  if (mode !== 'paper') {
    refuse(
      VERIFY,
      'input.mode',
      (mode as unknown) === 'live'
        ? "'live' is not available in this stage — live execution is AT8. Use 'paper'"
        : `must be 'paper'. Received ${JSON.stringify(mode)}`,
      (mode as unknown) === 'live' ? ErrorCode.TradeLiveUnavailable : ErrorCode.InputOutOfRange,
    );
  }
  const reasons: GrantRefusal[] = [];
  const { now } = input;
  if (now >= grant.expiresAt) {
    reasons.push({
      reason: 'expired',
      detail: `the grant expired at ${grant.expiresAt}; now is ${now}`,
    });
  }
  if (now < grant.issuedAt) {
    reasons.push({
      reason: 'premature',
      detail: `the grant was issued at ${grant.issuedAt}; now is ${now}`,
    });
  }
  if (plan.contentHash !== grant.planHash) {
    reasons.push({
      reason: 'plan-hash-mismatch',
      detail: `the grant authorizes plan ${grant.planHash}; this plan is ${plan.contentHash} — a changed plan needs new authority`,
    });
  }
  if (input.portfolioHash !== grant.portfolioHash) {
    reasons.push({
      reason: 'portfolio-hash-mismatch',
      detail: `the grant was judged against portfolio ${grant.portfolioHash}; the portfolio is now ${input.portfolioHash}`,
    });
  }
  if (input.marketHash !== grant.marketHash) {
    reasons.push({
      reason: 'market-hash-mismatch',
      detail: `the grant was judged against market ${grant.marketHash}; the market is now ${input.marketHash}`,
    });
  }
  if (input.marketAsOf < grant.marketAsOf) {
    reasons.push({
      reason: 'market-stale',
      detail: `the market (${input.marketAsOf}) is older than the one the grant was judged against (${grant.marketAsOf})`,
    });
  } else if (now - input.marketAsOf > grant.marketMaximumAgeMs) {
    reasons.push({
      reason: 'market-stale',
      detail: `the market is ${now - input.marketAsOf} ms old; the grant allows ${grant.marketMaximumAgeMs} ms`,
    });
  }
  if (mode !== grant.mode) {
    reasons.push({
      reason: 'mode-mismatch',
      detail: `the grant is for ${grant.mode}; requested ${mode}`,
    });
  }
  if (plan.accountId !== grant.accountId) {
    reasons.push({
      reason: 'account-mismatch',
      detail: `the grant is for account ${JSON.stringify(grant.accountId)}; the plan is for ${JSON.stringify(plan.accountId)}`,
    });
  }
  // B5: the grant binds the multi-leg structure — the combo ids, in plan order.
  const planComboIds = plan.combos.map((combo) => combo.comboId);
  if (
    grant.comboIds.length !== planComboIds.length ||
    grant.comboIds.some((comboId, index) => comboId !== planComboIds[index])
  ) {
    reasons.push({
      reason: 'combo-mismatch',
      detail: `the grant binds combos [${grant.comboIds.join(', ')}]; the plan has [${planComboIds.join(', ')}]`,
    });
  }
  if (!grant.idempotencyKeys.includes(input.idempotencyKey)) {
    reasons.push({
      reason: 'idempotency-key-unknown',
      detail: `${JSON.stringify(input.idempotencyKey)} is not one of the grant's ${grant.idempotencyKeys.length} keys`,
    });
  }
  if (input.orders !== undefined) {
    if (!Array.isArray(input.orders)) {
      refuse(VERIFY, 'input.orders', 'must be an array of orders', ErrorCode.InputWrongType);
    }
    if (input.orders.length === 0)
      refuse(
        VERIFY,
        'input.orders',
        'must contain the authorized orders; omit orders to submit the unchanged plan',
        ErrorCode.InputOutOfRange,
      );
    const submitted = new Map<string, TradeOrder>();
    input.orders.forEach((candidate, index) => {
      const order = requireTradeOrder(VERIFY, `input.orders[${index}]`, candidate);
      if (submitted.has(order.orderId))
        reasons.push({
          reason: 'order-mismatch',
          orderId: order.orderId,
          detail: `order ${JSON.stringify(order.orderId)} appears more than once in the submission`,
        });
      submitted.set(order.orderId, order);
      const planIndex = plan.orders.findIndex((planned) => planned.orderId === order.orderId);
      if (planIndex < 0) {
        reasons.push({
          reason: 'order-unknown',
          orderId: order.orderId,
          detail: `order ${JSON.stringify(order.orderId)} is not in the authorized plan`,
        });
        return;
      }
      const planned = plan.orders[planIndex]!;
      if (planned.instrumentId !== order.instrumentId || planned.side !== order.side) {
        reasons.push({
          reason: 'order-mismatch',
          orderId: order.orderId,
          detail: `order ${JSON.stringify(order.orderId)} is ${order.side} ${order.instrumentId}; the plan authorized ${planned.side} ${planned.instrumentId}`,
        });
        return;
      }
      if ((planned.comboId ?? null) !== (order.comboId ?? null)) {
        reasons.push({
          reason: 'order-mismatch',
          orderId: order.orderId,
          detail: `order ${JSON.stringify(order.orderId)} is a leg of combo ${JSON.stringify(order.comboId ?? null)}; the plan authorized combo ${JSON.stringify(planned.comboId ?? null)} — a leg cannot leave or join a combo at submission`,
        });
        return;
      }
      if (
        planned.type !== order.type ||
        planned.timeInForce !== order.timeInForce ||
        planned.stopPrice !== order.stopPrice
      ) {
        reasons.push({
          reason: 'order-mismatch',
          orderId: order.orderId,
          detail: `order ${JSON.stringify(order.orderId)} must retain its authorized type, time-in-force and stop price; these are not quantity/notional variance coordinates`,
        });
      }
      const quantityRatio = Math.abs(order.quantity / planned.quantity - 1);
      if (quantityRatio > grant.variance.maximumQuantityRatio) {
        reasons.push({
          reason: 'quantity-variance',
          orderId: order.orderId,
          detail: `quantity ${order.quantity} is ${(quantityRatio * 100).toFixed(2)}% from the authorized ${planned.quantity}; the grant allows ${(grant.variance.maximumQuantityRatio * 100).toFixed(2)}%`,
        });
      }
      const trade = planTradeFor(plan, planned, planIndex);
      if (trade !== undefined && trade.quantity > 0 && trade.referencePricePerUnit > 0) {
        const perUnit = trade.estimatedNotional / trade.quantity;
        const multiplier = perUnit / trade.referencePricePerUnit;
        const price = order.limitPrice ?? trade.referencePricePerUnit;
        const executedNotional = order.quantity * price * multiplier;
        const authorizedNotional = planned.quantity * trade.referencePricePerUnit * multiplier;
        const notionalRatio =
          authorizedNotional === 0 ? 0 : Math.abs(executedNotional / authorizedNotional - 1);
        if (notionalRatio > grant.variance.maximumNotionalRatio) {
          reasons.push({
            reason: 'notional-variance',
            orderId: order.orderId,
            detail: `notional ${executedNotional} is ${(notionalRatio * 100).toFixed(2)}% from the authorized ${authorizedNotional}; the grant allows ${(grant.variance.maximumNotionalRatio * 100).toFixed(2)}%`,
          });
        }
        if (order.limitPrice !== undefined) {
          const slippageBps =
            (Math.abs(order.limitPrice - trade.referencePricePerUnit) /
              trade.referencePricePerUnit) *
            10_000;
          if (slippageBps > grant.variance.maximumSlippageBps) {
            reasons.push({
              reason: 'slippage-variance',
              orderId: order.orderId,
              detail: `limit ${order.limitPrice} is ${slippageBps.toFixed(2)} bps from the reference ${trade.referencePricePerUnit}; the grant allows ${grant.variance.maximumSlippageBps} bps`,
            });
          }
        }
      }
    });
    // Omitting an independent hedge is as material as omitting a combo leg. Quantity variance
    // changes quantities, not plan membership; preflight never judged the selected subset.
    for (const planned of plan.orders) {
      if (!submitted.has(planned.orderId))
        reasons.push({
          reason: 'order-mismatch',
          orderId: planned.orderId,
          detail: `authorized order ${JSON.stringify(planned.orderId)} is missing; submit the complete plan or preflight and authorize a new plan`,
        });
    }
    for (const combo of plan.combos) {
      const legs = combo.orderIds.map((id) => submitted.get(id));
      if (legs.some((leg) => leg === undefined)) {
        reasons.push({
          reason: 'combo-mismatch',
          detail: `combo ${JSON.stringify(combo.comboId)} must be submitted with every authorized leg; partial combos are not authorized`,
        });
        continue;
      }
      const ratios = legs.map(
        (leg) =>
          leg!.quantity / plan.orders.find((order) => order.orderId === leg!.orderId)!.quantity,
      );
      if (
        ratios.some(
          (ratio) => Math.abs(ratio - ratios[0]!) > Math.max(1, ratio, ratios[0]!) * 1e-12,
        )
      )
        reasons.push({
          reason: 'combo-mismatch',
          detail: `combo ${JSON.stringify(combo.comboId)} must preserve its authorized leg quantity ratios, including within the variance allowance`,
        });
    }
  }
  const orderCount = input.orders === undefined ? plan.orders.length : input.orders.length;
  return deepFreeze({
    valid: reasons.length === 0,
    reasons,
    grantHash: grant.contentHash,
    planHash: plan.contentHash,
    checkedAt: now,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      mode: 'paper' as const,
      marketAsOf: input.marketAsOf,
      marketAgeMs: now - input.marketAsOf,
      marketMaximumAgeMs: grant.marketMaximumAgeMs,
      ordersJudged: input.orders === undefined ? ('plan' as const) : ('supplied' as const),
      bindingConvention:
        'expiry and issue instant against now; plan, portfolio, and market content hashes exact; the market no older than the grant judged and within its age allowance; mode and account exact; the combo ids exact and in plan order; the idempotency key in the licensed set; supplied orders within the variance envelope at the plan reference prices and in their planned combos',
    },
    diagnostics: {
      engine: 'grant-verification' as const,
      warnings:
        reasons.length === 0
          ? []
          : [
              `${reasons.length} binding${reasons.length === 1 ? '' : 's'} failed; the grant does not authorize this execution`,
            ],
      bindingCount: 10,
      reasonCount: reasons.length,
      orderCount,
    },
  });
}
