/**
 * `createTradingEnvironment` (Stage 7B.1, AT4 — Decisions 2–7): `portfolioBacktest`'s per-instant
 * loop driven from outside through the stepper seam. `reset` positions the episode at the first
 * decision instant; `step` applies the action's cancellations, checks each order against the mask
 * and the projected limits, queues the accepted ones, and advances one instant — every open order
 * meets the market there through the declared fill model (the next-observation law: an order
 * decided on observation `k` is never filled on observation `k`). Post-trade, FC7's monitor judges
 * the limits; the reward is a declared composition over the engine's frame and never touches the
 * accounting. Rejections are rows, never throws; a repeated order id is an idempotent retry; the
 * trace hash chains every canonical action so identical policies leave identical traces.
 */
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  requireArgumentObject,
} from '@totalfinance/core';
import type { EpochMs } from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import type {
  CurrencyPairQuote,
  NormalizedFill,
  PortfolioMonitorState,
} from '@totalfinance/portfolio';
import { execution as executionPolicies } from '../execution/policy.js';
import { requireOrderIntent } from '../execution/validate.js';
import type { ExecutionPolicy, OrderIntent } from '../execution/types.js';
import { adapterFor } from '../portfolio/adapters.js';
import { createPortfolioStepper } from '../portfolio/engine.js';
import type {
  PortfolioBacktestResult,
  PortfolioStepFrame,
  PortfolioStepper,
  PortfolioStepperRequest,
  SessionContext,
} from '../portfolio/types.js';
import { createFeatureIndex, featuresAt, freshnessAt } from './features.js';
import {
  buildActionMask,
  createProjectionBook,
  evaluatePostTrade,
  projectOrder,
} from './limits.js';
import { rewardBreakdown } from './reward.js';
import {
  MAXIMUM_ENVIRONMENT_STEPS,
  RATIONALE_BYTE_LIMIT,
  actionProblem,
  requireTradingEnvironmentDefinition,
} from './validate.js';
import type {
  ActionMask,
  EnvironmentAction,
  EnvironmentIdentity,
  EnvironmentLimitsView,
  EnvironmentObservation,
  EnvironmentRejection,
  EnvironmentResetOptions,
  EnvironmentResetResult,
  EnvironmentStepOutcome,
  EnvironmentStepResult,
  OpenOrder,
  OpenOrderReason,
  RewardBreakdown,
  RewardFrame,
  TradingEnvironment,
  TradingEnvironmentDefinition,
} from './types.js';

const FN = 'createTradingEnvironment';

/** The engine's unfilled reasons that leave an order open for the next instant (Decision 3). */
const CARRY_REASONS: ReadonlySet<string> = new Set([
  'not-triggered',
  'no-observation',
  'stale-quote',
  'halted',
  'locked-crossed',
  'insufficient-depth',
]);

const NO_REWARD: RewardBreakdown = Object.freeze({ total: 0, components: Object.freeze({}) });

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const member of Object.values(value as Record<string, unknown>)) freezeDeep(member);
  return value;
}

/** UTF-8 bytes of a string, without a platform encoder. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
function boundedRationale(text: string | undefined): { text?: string; truncated: boolean } {
  if (text === undefined) return { truncated: false };
  if (utf8ByteLength(text) <= RATIONALE_BYTE_LIMIT) return { text, truncated: false };
  let kept = text.slice(0, RATIONALE_BYTE_LIMIT);
  while (utf8ByteLength(kept) > RATIONALE_BYTE_LIMIT) kept = kept.slice(0, -1);
  return { text: kept, truncated: true };
}

/** An amount in `currency` valued in the base currency through the engine's dated quotes. */
function toBase(
  amount: number,
  currency: string,
  baseCurrency: string,
  quotes: readonly CurrencyPairQuote[],
): number {
  if (currency === baseCurrency) return amount;
  const direct = quotes.find(
    (q) => q.baseCurrency === currency && q.quoteCurrency === baseCurrency,
  );
  if (direct !== undefined) return amount * direct.quotePerBase;
  const inverse = quotes.find(
    (q) => q.baseCurrency === baseCurrency && q.quoteCurrency === currency,
  );
  if (inverse !== undefined) return amount / inverse.quotePerBase;
  return amount;
}

function fillNotional(fill: NormalizedFill): number {
  return Math.abs(fill.quantity * fill.pricePerUnit * (fill.contractMultiplier ?? 1));
}
function fillCosts(fill: NormalizedFill): number {
  const c = fill.costs;
  if (c === undefined) return fill.executionPriceAdjustment ?? 0;
  return (
    (c.commission ?? 0) +
    (c.exchangeFees ?? 0) +
    (c.regulatoryFees ?? 0) +
    (c.slippageAdjustment ?? 0) +
    (fill.executionPriceAdjustment ?? 0)
  );
}

interface Episode {
  stepper: PortfolioStepper;
  runId: string;
  seed: number | null;
  maximumSteps: number;
  sequence: number;
  /** The last closed instant. */
  cursor: number;
  openOrders: OpenOrder[];
  seen: Map<string, { step: number; outcome: string }>;
  orderCount: number;
  traceHash: string;
  terminated: boolean;
  truncated: boolean;
  reason: EnvironmentStepResult['reason'];
  finished: boolean;
  observation: EnvironmentObservation;
  mask: ActionMask;
  monitorState: PortfolioMonitorState | null;
  peak: number;
  previousNetAssetValue: number | null;
  result: PortfolioBacktestResult | null;
}

export function createTradingEnvironment(
  definition: TradingEnvironmentDefinition,
): TradingEnvironment {
  const checked = requireTradingEnvironmentDefinition(FN, 'definition', definition);
  const request: Record<string, unknown> = { ...checked };
  for (const key of ['maximumSteps', 'limits', 'reward', 'features']) delete request[key];
  const policy: ExecutionPolicy = checked.execution ?? executionPolicies.simplified();
  const baseCurrency = checked.accounting.baseCurrency;
  const limits = checked.limits;
  const reward = checked.reward;
  const featureIndex = createFeatureIndex(checked.marketData.bars);
  const declared = {
    maximumSteps: checked.maximumSteps ?? null,
    limits: limits ?? null,
    reward:
      reward === undefined
        ? null
        : {
            ...reward,
            benchmark: reward.benchmark ?? null,
            goal: reward.goal === undefined ? null : 'callback',
          },
    features: checked.features ?? null,
  };
  // The definition's identity is the engine's own (order-invariant, behavior described not
  // serialized), seed excluded; an episode's runId adds the seed through the stepper it drives.
  const seedless: Record<string, unknown> = { ...request };
  delete seedless['seed'];
  const probe = createPortfolioStepper(seedless as unknown as PortfolioStepperRequest);
  if (probe.instants.length === 0) {
    throw new InputError(
      `${FN}: the market data holds no decision instant inside the window — an episode needs at least one observation to step from.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: FN, field: 'definition.marketData' },
      },
    );
  }
  const definitionHash = contentHash({ engine: probe.runId, ...declared });
  const instantCount = probe.instants.length;
  const adapters = Object.entries(checked.instruments).map(([instrumentId, spec]) => {
    const adapter = adapterFor(instrumentId, spec);
    return { instrumentId, kind: adapter.kind, version: adapter.version };
  });
  let episode: Episode | null = null;

  const requireEpisode = (verb: string): Episode => {
    if (episode === null) {
      throw new InputError(`${FN}: ${verb}() needs reset() first — no episode is open.`, {
        code: ErrorCode.EnvironmentNotReset,
        context: { function: FN },
      });
    }
    return episode;
  };

  const identityOf = (ep: Episode): EnvironmentIdentity => ({
    runId: ep.runId,
    step: ep.sequence,
    traceHash: ep.traceHash,
  });

  const exposures = (context: SessionContext): { gross: number; net: number; largest: number } => {
    let gross = 0;
    let net = 0;
    let largest = 0;
    for (const position of context.positions) {
      if (position.baseCurrencyMarketValue === null) continue;
      const absolute = Math.abs(position.baseCurrencyMarketValue);
      gross += absolute;
      net += position.baseCurrencyMarketValue;
      if (absolute > largest) largest = absolute;
    }
    return { gross, net, largest };
  };

  const observe = (
    ep: Episode,
    context: SessionContext,
    previous: EnvironmentStepOutcome | null,
    limitsView: EnvironmentLimitsView,
  ): EnvironmentObservation => {
    const { gross, net } = exposures(context);
    const buyingPower =
      context.netAssetValue *
        Math.min(
          policy.margin.buyingPowerMultiplier,
          policy.margin.initialMarginRate === 0 ? Infinity : 1 / policy.margin.initialMarginRate,
        ) -
      gross;
    const mask = buildActionMask({
      context,
      policy,
      limits,
      nextInstant: ep.stepper.instants[ep.cursor + 1],
      grossExposure: gross,
      buyingPower,
      episodeOver: ep.finished || ep.terminated || ep.truncated,
    });
    ep.mask = mask;
    return freezeDeep({
      asOf: context.asOf,
      index: context.index,
      sequence: ep.sequence,
      market: context.observations,
      instruments: context.instruments,
      portfolio: {
        netAssetValue: context.netAssetValue,
        cash: context.cash,
        positions: context.positions,
        grossExposure: gross,
        netExposure: net,
        buyingPower,
        openOrders: ep.openOrders.map((order) => ({ ...order })),
      },
      limits: limitsView,
      features: featuresAt(featureIndex, checked.features, context.instruments, context.asOf),
      freshness: freshnessAt(context.observations, context.instruments, policy, context.asOf),
      actionMask: mask,
      previous,
      provenance: {
        runId: ep.runId,
        engineRunId: ep.stepper.runId,
        definitionHash,
        seed: ep.seed,
        executionPolicy: policy.label,
        conventionsVersion: CONVENTIONS_VERSION,
        adapters,
      },
    });
  };

  const reset = (options?: EnvironmentResetOptions): EnvironmentResetResult => {
    let seed: number | null = checked.seed ?? null;
    if (options !== undefined) {
      requireArgumentObject(FN, 'options', options);
      const keys = Object.keys(options);
      const unknown = keys.filter((key) => key !== 'seed');
      if (unknown.length > 0) {
        throw new InputError(
          `${FN}: reset() options has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} (allowed: seed).`,
          { code: ErrorCode.InputUnknownField, context: { function: FN, field: 'options' } },
        );
      }
      if (keys.includes('seed')) {
        const given = options.seed;
        if (!(Number.isSafeInteger(given) && (given as number) >= 0)) {
          throw new InputError(
            `${FN}: reset() options.seed must be a non-negative safe integer. Received ${String(given)}.`,
            {
              code:
                typeof given === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
              context: { function: FN, field: 'options.seed' },
            },
          );
        }
        seed = given as number;
      }
    }
    const seeded: Record<string, unknown> = { ...request };
    delete seeded['seed'];
    if (seed !== null) seeded['seed'] = seed;
    const stepper = createPortfolioStepper(seeded as unknown as PortfolioStepperRequest);
    const maximumSteps = Math.min(
      checked.maximumSteps ?? stepper.instants.length,
      MAXIMUM_ENVIRONMENT_STEPS,
    );
    const runId = contentHash({ engine: stepper.runId, ...declared });
    stepper.open(0);
    stepper.close(0, []);
    const context = stepper.context();
    const ep: Episode = {
      stepper,
      runId,
      seed,
      maximumSteps,
      sequence: 0,
      cursor: 0,
      openOrders: [],
      seen: new Map(),
      orderCount: 0,
      traceHash: contentHash({ runId }),
      terminated: false,
      truncated: false,
      reason: null,
      finished: false,
      observation: null as unknown as EnvironmentObservation,
      mask: {},
      monitorState: null,
      peak: Math.max(0, context.netAssetValue),
      previousNetAssetValue: null,
      result: null,
    };
    const post = evaluatePostTrade({
      valuation: stepper.valuation(),
      limits,
      policy,
      previousState: null,
      context,
      grossExposure: exposures(context).gross,
      runningPeak: ep.peak,
      previousNetAssetValue: null,
    });
    ep.monitorState = post.state;
    ep.previousNetAssetValue = context.netAssetValue;
    if (!(context.netAssetValue > 0)) {
      ep.terminated = true;
      ep.reason = 'insolvent';
    } else if (post.view.breaches.length > 0 && (limits?.onBreach ?? 'terminate') === 'terminate') {
      ep.terminated = true;
      ep.reason = 'limit-breach';
    } else if (stepper.instants.length === 1) {
      ep.truncated = true;
      ep.reason = 'data-boundary';
    }
    ep.observation = observe(ep, context, null, post.view);
    episode = ep;
    return freezeDeep({
      observation: ep.observation,
      episode: {
        runId,
        engineRunId: stepper.runId,
        definitionHash,
        seed,
        instantCount: stepper.instants.length,
        maximumSteps,
        window: {
          fromTimestampMs: checked.window?.fromTimestampMs ?? null,
          toTimestampMs: checked.window?.toTimestampMs ?? null,
        },
      },
      identity: identityOf(ep),
      terminated: ep.terminated,
      truncated: ep.truncated,
      reason: ep.reason,
    });
  };

  const episodeOver = (ep: Episode): EnvironmentStepResult =>
    freezeDeep({
      observation: ep.observation,
      fills: [],
      rejections: [
        {
          step: ep.sequence,
          orderId: null,
          instrumentId: null,
          code: ErrorCode.EnvironmentEpisodeOver,
          detail: ep.finished
            ? 'finish() has been called — reset() starts a new episode.'
            : `the episode ended at step ${ep.sequence} (${ep.reason ?? 'terminal'}) — reset() starts a new one.`,
          source: 'environment',
        },
      ],
      liquidations: [],
      events: [],
      warnings: [],
      reward: NO_REWARD,
      terminated: ep.terminated,
      truncated: ep.truncated,
      reason: ep.reason,
      identity: identityOf(ep),
      diagnostics: {
        acceptedCount: 0,
        rejectedCount: 1,
        cancelledCount: 0,
        carriedCount: 0,
        openOrderCount: ep.openOrders.length,
        rationaleTruncated: false,
      },
    });

  const step = (action: EnvironmentAction): EnvironmentStepResult => {
    const ep = requireEpisode('step');
    requireArgumentObject(FN, 'action', action);
    if (ep.finished || ep.terminated || ep.truncated) return episodeOver(ep);
    const stepNumber = ep.sequence + 1;
    const rejections: EnvironmentRejection[] = [];
    let violations = 0;
    const reject = (
      code: EnvironmentRejection['code'],
      detail: string,
      orderId: string | null = null,
      instrumentId: string | null = null,
    ): void => {
      rejections.push({
        step: stepNumber,
        orderId,
        instrumentId,
        code,
        detail,
        source: 'environment',
      });
    };
    // ---- the action --------------------------------------------------------------------------------
    const problem = actionProblem(action);
    let canonical: EnvironmentAction = { kind: 'hold' };
    let rationaleTruncated = false;
    if (problem !== null) {
      reject(ErrorCode.EnvironmentActionInvalid, `${problem}; the step proceeds as hold.`);
    } else {
      const rationale = boundedRationale(action.rationale);
      rationaleTruncated = rationale.truncated;
      if (action.kind === 'hold') {
        canonical = {
          kind: 'hold',
          ...(rationale.text !== undefined ? { rationale: rationale.text } : {}),
        };
      } else {
        canonical = {
          kind: 'orders',
          orders: action.orders.map((order) => ({ ...order })),
          ...(action.cancel !== undefined ? { cancel: [...action.cancel] } : {}),
          ...(rationale.text !== undefined ? { rationale: rationale.text } : {}),
        };
      }
    }
    let cancelledCount = 0;
    let acceptedCount = 0;
    const current = ep.stepper.instants[ep.cursor]!;
    const before = ep.stepper.context();
    if (canonical.kind === 'orders') {
      // cancellations first, so a replace never double-executes
      for (const id of canonical.cancel ?? []) {
        const at = ep.openOrders.findIndex((order) => order.orderId === id);
        if (at < 0) {
          reject(ErrorCode.EnvironmentOrderInvalid, `no open order '${id}' to cancel.`, id);
          continue;
        }
        ep.openOrders.splice(at, 1);
        ep.seen.set(id, { step: stepNumber, outcome: 'cancelled' });
        cancelledCount += 1;
      }
      const book = createProjectionBook(before, baseCurrency);
      for (const open of ep.openOrders) projectOrder(book, undefined, open);
      canonical.orders.forEach((order, i) => {
        const orderId = order.orderId ?? `${ep.runId}:a${ep.orderCount + 1}`;
        const earlier = ep.seen.get(orderId);
        if (earlier !== undefined) {
          reject(
            ErrorCode.EnvironmentDuplicateOrder,
            `orders[${i}] repeats '${orderId}', submitted at step ${earlier.step} (${earlier.outcome}); a retry is not a second order.`,
            orderId,
            order.instrumentId ?? null,
          );
          return;
        }
        if (
          typeof order.instrumentId === 'string' &&
          !(order.instrumentId in checked.instruments)
        ) {
          reject(
            ErrorCode.EnvironmentUnknownInstrument,
            `orders[${i}] names '${order.instrumentId}', which is not an instrument of this environment.`,
            orderId,
            order.instrumentId,
          );
          return;
        }
        const intent: Record<string, unknown> = {
          ...order,
          orderId,
          submittedTimestampMs: current,
        };
        if (!('timeInForce' in order)) intent['timeInForce'] = policy.timeInForce.default;
        try {
          requireOrderIntent(FN, `orders[${i}]`, intent);
        } catch (error) {
          reject(
            ErrorCode.EnvironmentOrderInvalid,
            (error as Error).message.replace(`${FN}: `, ''),
            orderId,
            typeof order.instrumentId === 'string' ? order.instrumentId : null,
          );
          return;
        }
        const accepted = intent as unknown as OrderIntent;
        const entry = ep.mask[accepted.instrumentId];
        const allowed =
          entry === undefined ? true : accepted.side === 'buy' ? entry.buy : entry.sell;
        if (!allowed) {
          const reasons = entry!.reasons[accepted.side];
          violations += 1;
          reject(
            ErrorCode.EnvironmentActionDisallowed,
            `orders[${i}]: a ${accepted.side} of ${accepted.instrumentId} is disallowed at this observation (${reasons.join(', ')}); the action mask said so.`,
            orderId,
            accepted.instrumentId,
          );
          return;
        }
        const verdict = projectOrder(book, limits, accepted);
        if (verdict !== null) {
          violations += 1;
          reject(
            ErrorCode.EnvironmentLimitBreach,
            `orders[${i}] ${verdict.detail} (a projection at the current marks; the post-trade monitor is the judge)`,
            orderId,
            accepted.instrumentId,
          );
          return;
        }
        if (order.orderId === undefined) ep.orderCount += 1;
        ep.seen.set(orderId, { step: stepNumber, outcome: 'accepted' });
        ep.openOrders.push({
          orderId,
          instrumentId: accepted.instrumentId,
          side: accepted.side,
          quantity: accepted.quantity,
          type: accepted.type,
          ...(accepted.limitPrice !== undefined ? { limitPrice: accepted.limitPrice } : {}),
          ...(accepted.stopPrice !== undefined ? { stopPrice: accepted.stopPrice } : {}),
          timeInForce: accepted.timeInForce ?? policy.timeInForce.default,
          submittedStep: stepNumber,
          submittedTimestampMs: current,
          reason: 'submitted',
          attempts: 0,
        });
        acceptedCount += 1;
      });
    }
    // ---- the next instant: every open order meets the market there -------------------------------
    const next = ep.cursor + 1;
    ep.stepper.open(next);
    const intents: OrderIntent[] = ep.openOrders.map((order) => ({
      orderId: order.orderId,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      type: order.type,
      ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
      ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
      timeInForce: order.timeInForce,
      submittedTimestampMs: order.submittedTimestampMs,
    }));
    const frame: PortfolioStepFrame = ep.stepper.close(next, intents);
    const context = ep.stepper.context();
    const valuation = ep.stepper.valuation();
    // ---- reconcile the open orders with what the market did -----------------------------------------
    const asOf = ep.stepper.instants[next]!;
    const following = ep.stepper.instants[next + 1];
    const sameSession = following !== undefined && dateOf(following) === dateOf(asOf);
    let carriedCount = 0;
    const stillOpen: OpenOrder[] = [];
    for (const order of ep.openOrders) {
      const record = [...frame.orders].reverse().find((row) => row.orderId === order.orderId);
      const attempts = order.attempts + 1;
      if (record === undefined || record.outcome === 'filled') {
        ep.seen.set(order.orderId, { step: stepNumber, outcome: 'filled' });
        continue;
      }
      const reason: OpenOrderReason | null =
        record.outcome === 'partial'
          ? 'partial'
          : record.reason !== null && CARRY_REASONS.has(record.reason)
            ? (record.reason as OpenOrderReason)
            : null;
      const remaining =
        record.outcome === 'partial' ? order.quantity - record.filledQuantity : order.quantity;
      const carries =
        reason !== null && remaining > 0 && (order.timeInForce === 'gtc' || sameSession);
      if (!carries) {
        ep.seen.set(order.orderId, {
          step: stepNumber,
          outcome: record.outcome === 'partial' ? 'partial' : 'unfilled',
        });
        continue;
      }
      carriedCount += 1;
      stillOpen.push({ ...order, quantity: remaining, reason, attempts });
    }
    ep.openOrders = stillOpen;
    for (const row of frame.rejections) {
      rejections.push({
        step: stepNumber,
        orderId: row.orderId,
        instrumentId: row.instrumentId,
        code: row.code,
        detail: row.detail,
        source: 'engine',
      });
    }
    // ---- the limits, post-trade, through FC7's monitor ---------------------------------------------
    const { gross, largest } = exposures(context);
    const nav = context.netAssetValue;
    const peakAfter = Math.max(ep.peak, nav);
    const post = evaluatePostTrade({
      valuation,
      limits,
      policy,
      previousState: ep.monitorState,
      context,
      grossExposure: gross,
      runningPeak: peakAfter,
      previousNetAssetValue: ep.previousNetAssetValue,
    });
    ep.monitorState = post.state;
    violations += post.view.breaches.length;
    // ---- the reward, from the frame — never from the ledger ------------------------------------------
    const navBefore = before.netAssetValue;
    const benchmarkId = reward?.benchmark?.instrumentId;
    const closeBefore =
      benchmarkId === undefined ? undefined : before.observations[benchmarkId]?.bar?.close;
    const closeAfter =
      benchmarkId === undefined ? undefined : context.observations[benchmarkId]?.bar?.close;
    const rewardFrame: RewardFrame = {
      step: stepNumber,
      asOf,
      netAssetValueBefore: navBefore,
      netAssetValueAfter: nav,
      stepReturn: navBefore > 0 ? (nav - navBefore) / navBefore : 0,
      drawdownBefore: ep.peak > 0 ? 1 - navBefore / ep.peak : 0,
      drawdownAfter: peakAfter > 0 ? 1 - nav / peakAfter : 0,
      tradedNotional: frame.fills.reduce(
        (sum, fill) =>
          sum +
          toBase(fillNotional(fill), fill.currency, baseCurrency, valuation.currencyConversions),
        0,
      ),
      costs: frame.fills.reduce(
        (sum, fill) =>
          sum + toBase(fillCosts(fill), fill.currency, baseCurrency, valuation.currencyConversions),
        0,
      ),
      grossExposure: gross,
      largestPositionWeight: nav > 0 ? largest / nav : 0,
      violations,
      benchmarkReturn:
        closeBefore !== undefined && closeAfter !== undefined && closeBefore > 0
          ? closeAfter / closeBefore - 1
          : null,
      fills: frame.fills,
      positions: context.positions,
    };
    const stepReward = rewardBreakdown(reward, rewardFrame);
    // ---- the flags, the trace, the observation -------------------------------------------------------
    ep.sequence = stepNumber;
    ep.cursor = next;
    ep.peak = peakAfter;
    ep.previousNetAssetValue = nav;
    ep.traceHash = contentHash({ previous: ep.traceHash, step: stepNumber, action: canonical });
    if (!(nav > 0)) {
      ep.terminated = true;
      ep.reason = 'insolvent';
    } else if (post.view.breaches.length > 0 && (limits?.onBreach ?? 'terminate') === 'terminate') {
      ep.terminated = true;
      ep.reason = 'limit-breach';
    } else if (next === ep.stepper.instants.length - 1) {
      ep.truncated = true;
      ep.reason = 'data-boundary';
    } else if (stepNumber >= ep.maximumSteps) {
      ep.truncated = true;
      ep.reason = 'maximum-steps';
    }
    const outcome: EnvironmentStepOutcome = {
      step: stepNumber,
      action: canonical,
      fills: frame.fills,
      rejections,
      liquidations: frame.liquidations,
      events: frame.events,
      warnings: frame.warnings,
      reward: stepReward,
    };
    ep.observation = observe(ep, context, outcome, post.view);
    return freezeDeep({
      observation: ep.observation,
      fills: frame.fills,
      rejections,
      liquidations: frame.liquidations,
      events: frame.events,
      warnings: frame.warnings,
      reward: stepReward,
      terminated: ep.terminated,
      truncated: ep.truncated,
      reason: ep.reason,
      identity: identityOf(ep),
      diagnostics: {
        acceptedCount,
        rejectedCount: rejections.length,
        cancelledCount,
        carriedCount,
        openOrderCount: ep.openOrders.length,
        rationaleTruncated,
      },
    });
  };

  const finish = (): PortfolioBacktestResult => {
    const ep = requireEpisode('finish');
    if (ep.result === null) ep.result = ep.stepper.finish();
    ep.finished = true;
    return ep.result;
  };

  return Object.freeze({ definitionHash, instantCount, reset, step, finish });
}

export type { EpochMs };
