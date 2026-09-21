/**
 * `crossSectionalBacktest` (Stage 4.6, FC8 Decision 4) — the loop, and only the loop.
 *
 * At every rebalance session: universe membership and exits (research), eligibility (research),
 * the signal (a research verb or the caller's callback), selection and weights (here, from the
 * research quantiles), weights → quantities (the portfolio allocator), orders → fills (the
 * execution policy's fill model), fills → events (the portfolio bridge), events → state (the FC7
 * reducer). Between rebalances every session marks the ledger. At the end the timeline, the P&L,
 * and the performance summary are the portfolio and performance packages' own numbers, and the
 * reported final value must equal the ledger's NAV or the run refuses.
 *
 * Prices are return-index levels (base 100 at each instrument's first session in the dataset):
 * the dataset is returns, as research vocabulary is, and the assumptions say so. Session instants
 * are a stated convention (14:30 UTC open, 21:00 UTC close) so availability instants compare.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  type EpochMs,
  type QuantWarning,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import { analyze } from '@totalfinance/performance';
import {
  type PortfolioEventEnvelope,
  type PortfolioState,
  type PortfolioValuationMark,
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  allocatePortfolio,
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioEventsFromFill,
  portfolioSnapshot,
  portfolioTimeline,
  type NormalizedFill,
} from '@totalfinance/portfolio';
import {
  type FactorEntry,
  type FactorRecipe,
  type FieldDefinition,
  type UniverseObservation,
  compositeFactorScore,
  eligibleObservationsAt,
  factorSpreadReturn,
  formQuantilePortfolios,
  informationCoefficient,
  neutralizeFactor,
  screenUniverse,
  scoreUniverse,
  standardizeFactor,
  universeMembershipAt,
  winsorizeFactor,
} from '@totalfinance/research';
import { covariance, riskParity } from '@totalfinance/risk';
import { type CostModel, type SlippageModel } from '../costs.js';
import { describeExecutionPolicy, execution as executionPolicies } from '../execution/policy.js';
import { normalizedFillFromDecision } from '../execution/normalized.js';
import type { ExecutionPolicy, OrderIntent } from '../execution/types.js';
import { monteCarloResample } from '../tearsheet.js';
import type { EquityPoint, Trade } from '../types.js';
import { equityToReturns } from '../vectorized.js';
import type {
  AttributionRow,
  BenchmarkComparison,
  CrossSectionalAssumptions,
  CrossSectionalBacktestRequest,
  CrossSectionalBacktestResult,
  CrossSectionalDiagnostics,
  HoldingRow,
  RebalanceGoal,
  RebalanceRow,
  SignalRow,
} from './types.js';
import { requireCrossSectionalBacktestRequest } from './validate.js';

// ---------------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------------

const FUNCTION_NAME = 'crossSectionalBacktest';
const ACCOUNT_ID = 'main';
const OPEN_UTC_HOUR = 14.5;
const CLOSE_UTC_HOUR = 21;
const SESSION_INSTANT_CONVENTION =
  'session instants are the session date at 14:30 UTC (open) or 21:00 UTC (close); availability and universe instants compare against them; each session is marked at 00:00 UTC of the following calendar day (the ledger values a mark dated D strictly before 00:00 UTC of D), so a mark holds every fill of its session';
const PRICING_CONVENTION =
  'return-index levels: each instrument starts at 100 on its first session in the dataset and compounds its simple returns; quantities are index units';
const SHORT_BOOK_SIZING =
  'the short book is sized by the same allocator with negative target weights (rounded toward zero to the lot size)';
const DECAY_HORIZONS = [1, 2, 3, 4] as const;
const DEFAULT_LOOKBACK = 63;
const RECONCILIATION_TOLERANCE = 1e-9;
const WINSOR_PERCENTILES = { lowerPercentile: 1, upperPercentile: 99 } as const;

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The engine's session-instant convention — shared with the out-of-sample verbs so a window cuts where the engine does. */
export function sessionInstant(date: string, session: 'open' | 'close'): EpochMs {
  return isoDateToEpochMs(date) + (session === 'open' ? OPEN_UTC_HOUR : CLOSE_UTC_HOUR) * 3_600_000;
}

function isoWeek(date: string): string {
  const d = new Date(isoDateToEpochMs(date));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the ISO year
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${isoYear}-W${week}`;
}

function periodKey(date: string, frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'): string {
  switch (frequency) {
    case 'daily':
      return date;
    case 'weekly':
      return isoWeek(date);
    case 'monthly':
      return date.slice(0, 7);
    case 'quarterly':
      return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

interface SessionIndex {
  dates: string[];
  instants: EpochMs[];
  /** The mark for each session: the following calendar day (YYYY-MM-DD) and its 00:00 UTC instant. */
  markDates: string[];
  markInstants: EpochMs[];
  position: Map<string, number>;
}

function nextCalendarDate(date: string): string {
  return new Date(isoDateToEpochMs(date) + 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------------

export function crossSectionalBacktest(
  request: CrossSectionalBacktestRequest,
): CrossSectionalBacktestResult {
  const definitions = requireCrossSectionalBacktestRequest(FUNCTION_NAME, 'request', request);
  const { dataset, universeHistory, signal, rebalanceSchedule, portfolioConstruction } = request;
  const policy: ExecutionPolicy = request.execution ?? executionPolicies.simplified();
  const commission: CostModel = request.transactionCostModel?.commission ?? policy.costs.commission;
  const slippage: SlippageModel = request.transactionCostModel?.slippage ?? policy.costs.slippage;
  const initialCapital = request.initialCapital ?? 1_000_000;
  const baseCurrency = request.baseCurrency ?? 'USD';
  const periodsPerYear = request.periodsPerYear ?? 252;
  const riskFreeRate = request.riskFreeRate ?? 0;
  const lookback = portfolioConstruction.volatilityLookbackSessions ?? DEFAULT_LOOKBACK;
  const warnings: QuantWarning[] = [];

  // ---- sessions and the return index ------------------------------------------------------------
  const allDates = [...new Set(dataset.returns.map((r) => r.tradingSessionDate))].sort();
  const from = request.window?.fromTimestampMs;
  const to = request.window?.toTimestampMs;
  const dates = allDates.filter((date) => {
    const instant = sessionInstant(date, rebalanceSchedule.session);
    return (from === undefined || instant >= from) && (to === undefined || instant <= to);
  });
  if (dates.length < 2) {
    throw new InputError(
      `${FUNCTION_NAME}: the dataset carries ${dates.length} session${dates.length === 1 ? '' : 's'} inside the window; a run needs at least two.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: FUNCTION_NAME, field: 'dataset.returns' },
      },
    );
  }
  const sessions: SessionIndex = {
    dates,
    instants: dates.map((date) => sessionInstant(date, rebalanceSchedule.session)),
    markDates: dates.map(nextCalendarDate),
    markInstants: dates.map((date) => isoDateToEpochMs(nextCalendarDate(date))),
    position: new Map(dates.map((date, index) => [date, index])),
  };
  const returnsByInstrument = new Map<string, Map<string, number>>();
  for (const row of dataset.returns) {
    let byDate = returnsByInstrument.get(row.instrumentId);
    if (byDate === undefined) {
      byDate = new Map();
      returnsByInstrument.set(row.instrumentId, byDate);
    }
    if (byDate.has(row.tradingSessionDate)) {
      throw new InputError(
        `${FUNCTION_NAME}: dataset.returns carries two rows for '${row.instrumentId}' on ${row.tradingSessionDate} — one return per instrument per session.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: FUNCTION_NAME, field: 'dataset.returns' },
        },
      );
    }
    byDate.set(row.tradingSessionDate, row.simpleReturn);
  }
  const knownInstruments = new Set(universeHistory.members.map((m) => m.instrumentId));
  for (const instrumentId of returnsByInstrument.keys()) {
    if (!knownInstruments.has(instrumentId)) {
      throw new InputError(
        `${FUNCTION_NAME}: dataset.returns names '${instrumentId}', which the universe history never lists — every instrument in the dataset belongs to a membership interval (add it to universeHistory.members, or drop its rows).`,
        {
          code: ErrorCode.BacktestUniverseMembershipUnknown,
          context: { function: FUNCTION_NAME, instrumentId },
        },
      );
    }
  }
  // price level per instrument per session index (base 100 at the first session in the dataset)
  const levels = new Map<string, Float64Array>();
  const returnsBySession = new Map<string, Float64Array>();
  for (const [instrumentId, byDate] of returnsByInstrument) {
    const level = new Float64Array(sessions.dates.length);
    const perSession = new Float64Array(sessions.dates.length).fill(Number.NaN);
    let current = Number.NaN;
    sessions.dates.forEach((date, index) => {
      const r = byDate.get(date);
      if (r !== undefined) {
        perSession[index] = r;
        current = Number.isNaN(current) ? 100 : current * (1 + r);
      }
      level[index] = current;
    });
    levels.set(instrumentId, level);
    returnsBySession.set(instrumentId, perSession);
  }
  const priceAt = (instrumentId: string, index: number): number | null => {
    const level = levels.get(instrumentId);
    if (level === undefined) return null;
    const value =
      rebalanceSchedule.session === 'open'
        ? index > 0
          ? level[index - 1]!
          : Number.NaN
        : level[index]!;
    return Number.isFinite(value) ? value : null;
  };

  // ---- schedule ----------------------------------------------------------------------------------
  const rebalanceIndices: number[] = [];
  let previousKey: string | null = null;
  sessions.dates.forEach((date, index) => {
    const key = periodKey(date, rebalanceSchedule.frequency);
    if (key !== previousKey) rebalanceIndices.push(index);
    previousKey = key;
  });
  const isRebalance = new Set(rebalanceIndices);

  // ---- identity ----------------------------------------------------------------------------------
  const signalIdentity: CrossSectionalAssumptions['signal'] =
    'factorRecipe' in signal
      ? {
          kind: 'factor-recipe',
          recipeName: signal.factorRecipe.recipeName,
          recipeVersion: signal.factorRecipe.recipeVersion,
          direction: signal.factorRecipe.direction,
          lagTradingSessions: signal.factorRecipe.lagTradingSessions,
          neutralization: signal.factorRecipe.neutralization,
        }
      : 'score' in signal
        ? {
            kind: 'score',
            components: signal.score.components.length,
            missingValuePolicy: signal.score.missingValuePolicy,
          }
        : 'screen' in signal
          ? {
              kind: 'screen',
              orderBy: signal.screen.orderBy.map((k) => `${k.field} ${k.direction}`),
              missingValuePolicy: signal.screen.missingValuePolicy,
            }
          : { kind: 'callback', replayable: false };
  const replayable = !('callback' in signal) && portfolioConstruction.method !== 'supplied-weights';
  const runId = contentHash({
    universeId: universeHistory.universeId,
    // Assumptions are a readable summary, not an identity: a component count cannot distinguish
    // opposite rankings or changed thresholds. Hash the complete declarative signal.
    signal: 'callback' in signal ? { kind: 'callback', replayable: false } : signal,
    rebalanceSchedule,
    portfolioConstruction: {
      ...portfolioConstruction,
      suppliedWeights: portfolioConstruction.suppliedWeights !== undefined ? 'callback' : undefined,
    },
    initialCapital,
    baseCurrency,
    sessions: [sessions.dates[0], sessions.dates[sessions.dates.length - 1], sessions.dates.length],
    execution: {
      ...describeExecutionPolicy(policy),
      sessions: policy.sessions ?? null,
      borrow: policy.costs.borrow ?? null,
    },
    transactionCosts: { commission: commission.label, slippage: slippage.label },
    periodsPerYear,
    riskFreeRate: request.riskFreeRate ?? 0,
    seed: request.seed ?? null,
  });
  const sourceId = `backtest:cross-sectional:${runId}`;

  // ---- state ---------------------------------------------------------------------------------------
  const events: PortfolioEventEnvelope[] = [];
  const fills: NormalizedFill[] = [];
  const trades: Trade[] = [];
  const marks: PortfolioValuationMark[] = [];
  const rebalances: RebalanceRow[] = [];
  const holdings: HoldingRow[] = [];
  const attributionInputs: Array<{
    rebalanceIndex: number;
    sessionIndex: number;
    sessionDate: string;
    scores: SignalRow[];
    selection: Set<string>;
    eligibleCount: number;
    memberCount: number;
  }> = [];
  let state: PortfolioState | undefined;
  let fillSequence = 0;
  let rejectedFills = 0;
  let exitCount = 0;
  let delistingCount = 0;
  let previousRebalanceInstant: EpochMs | undefined;
  let previousSelection = new Set<string>();

  const fold = (batch: PortfolioEventEnvelope[]): void => {
    if (batch.length === 0) return;
    state = applyPortfolioEvents({
      ...(state === undefined ? { portfolio: { baseCurrency } } : { previousState: state }),
      events: batch,
    });
    events.push(...batch);
  };
  const heldQuantities = (): Map<string, number> => {
    const out = new Map<string, number>();
    const positions = state?.accounts[ACCOUNT_ID]?.positions ?? {};
    for (const [instrumentId, position] of Object.entries(positions)) {
      if (position.quantity !== 0) out.set(instrumentId, position.quantity);
    }
    return out;
  };
  const marketAt = (index: number): ReturnType<typeof createMarketSnapshot> => {
    const spots: Record<string, { price: number; currency: string }> = {};
    for (const instrumentId of levels.keys()) {
      const price = priceAt(instrumentId, index);
      if (price !== null) spots[instrumentId] = { price, currency: baseCurrency };
    }
    return createMarketSnapshot({ asOf: sessions.markInstants[index]!, observations: { spots } });
  };
  const netAssetValueAt = (index: number): number =>
    portfolioSnapshot({
      portfolio: state as PortfolioState,
      asOf: sessions.markInstants[index]!,
      market: marketAt(index),
    }).netAssetValue;

  // The opening deposit at the first session.
  fold([
    {
      eventId: `${runId}:deposit`,
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      eventType: 'cash.deposit',
      sourceId,
      accountId: ACCOUNT_ID,
      effectiveTimestampMs: sessions.instants[0]!,
      recordedTimestampMs: sessions.instants[0]!,
      event: { eventType: 'cash.deposit', amount: initialCapital, currency: baseCurrency },
      provenance: {},
    },
  ]);

  /** Fill one signed trade at a session through the policy's fill model; returns the fill or null. */
  const executeTrade = (trade: {
    index: number;
    instrumentId: string;
    side: 'buy' | 'sell';
    quantity: number;
    referencePrice: number;
    goals: RebalanceGoal[];
  }): NormalizedFill | null => {
    const { index, instrumentId, side, quantity, referencePrice, goals } = trade;
    const asOf = sessions.instants[index]!;
    const order: OrderIntent = {
      orderId: `${runId}:${index}:${instrumentId}`,
      instrumentId,
      side,
      quantity,
      type: 'market',
      submittedTimestampMs: asOf,
    };
    const volume = dataset.averageDailyVolumes?.[instrumentId];
    const decision = policy.fill.fill({
      order,
      observation: {
        kind: 'bar',
        bar: {
          symbol: instrumentId,
          timestampMs: asOf,
          open: referencePrice,
          high: referencePrice,
          low: referencePrice,
          close: referencePrice,
          ...(volume !== undefined ? { volume } : {}),
        },
      },
      context: {
        asOf,
        ...(policy.costs.participation !== undefined
          ? { participation: policy.costs.participation }
          : {}),
        partialFills: policy.partialFills,
        staleQuotes: policy.staleQuotes,
        lockedCrossed: policy.lockedCrossed,
        ...(policy.sessions !== undefined ? { sessions: policy.sessions } : {}),
        queue: policy.queue,
      },
    });
    if (decision.outcome !== 'filled') {
      rejectedFills += 1;
      goals.push({
        goal: `fill ${instrumentId}`,
        status: 'violated',
        detail: `unfilled: ${decision.reason}${decision.detail !== undefined ? ` (${decision.detail})` : ''}`,
      });
      return null;
    }
    // costs and price adjustments: slippage moves the price; spread and impact move it further by side
    let price = slippage.fill({
      referencePrice: decision.pricePerUnit,
      side,
      quantity: decision.quantity,
    });
    const direction = side === 'buy' ? 1 : -1;
    if (policy.costs.spread !== undefined)
      price +=
        direction * policy.costs.spread.halfSpread({ referencePrice: decision.pricePerUnit, side });
    if (policy.costs.marketImpact !== undefined) {
      price *=
        1 +
        direction *
          policy.costs.marketImpact.impact({
            quantity: decision.quantity,
            referencePrice: decision.pricePerUnit,
            ...(volume !== undefined ? { averageDailyVolume: volume } : {}),
          });
    }
    const commissionAmount = commission.commission({ quantity: decision.quantity, price });
    fillSequence += 1;
    const fill = normalizedFillFromDecision({
      decision: { ...decision, pricePerUnit: price },
      order,
      accountId: ACCOUNT_ID,
      currency: baseCurrency,
      filledTimestampMs: asOf,
      fillId: `${runId}:fill:${fillSequence}`,
      ...(commissionAmount > 0 ? { costs: { commission: commissionAmount } } : {}),
    });
    fills.push(fill);
    trades.push({
      symbol: instrumentId,
      timestampMs: asOf,
      side,
      quantity: fill.quantity,
      price,
      commission: commissionAmount,
      slippage: Math.abs(price - decision.pricePerUnit) * fill.quantity,
      // Cross-sectional universes are share-like instruments sized by weight; a unit moves its
      // price in cash, and the fill above carries no contract terms.
      multiplier: 1,
    });
    fold(portfolioEventsFromFill({ fill, sourceId, recordedTimestampMs: asOf }));
    return fill;
  };

  // ---- the loop ------------------------------------------------------------------------------------
  let rebalanceIndex = -1;
  for (let index = 0; index < sessions.dates.length; index += 1) {
    const date = sessions.dates[index]!;
    const asOf = sessions.instants[index]!;
    if (isRebalance.has(index)) {
      rebalanceIndex += 1;
      const goals: RebalanceGoal[] = [];
      const rowExits: RebalanceRow['exits'] = [];
      const held = heldQuantities();
      // 1. membership and exits
      const membership = universeMembershipAt({
        universeHistory,
        asOf,
        ...(previousRebalanceInstant !== undefined
          ? { previousAsOf: previousRebalanceInstant }
          : {}),
      });
      const members = new Set(membership.instrumentIds);
      const exitInfo = new Map(membership.exits.map((exit) => [exit.instrumentId, exit]));
      for (const [instrumentId, quantity] of [...held].sort((a, b) => compareIds(a[0], b[0]))) {
        if (members.has(instrumentId)) continue;
        const exit = exitInfo.get(instrumentId);
        const lastPrice = priceAt(instrumentId, index);
        let exitPrice: number | null = lastPrice;
        let reason: 'delisted' | 'removed' = 'removed';
        if (exit?.exitReason === 'delisted') {
          reason = 'delisted';
          if (exit.delistingReturn === null) {
            throw new InputError(
              `${FUNCTION_NAME}: '${instrumentId}' was delisted at ${exit.exitTimestampMs} while the strategy held ${quantity} units, and the universe history carries no delistingReturn for it — the exit value cannot be assumed. Add delistingReturn to that member (−1 for a total loss).`,
              {
                code: ErrorCode.BacktestDelistingReturnMissing,
                context: { function: FUNCTION_NAME, instrumentId },
              },
            );
          }
          delistingCount += 1;
          const base = lastPrice ?? levels.get(instrumentId)?.[index - 1] ?? null;
          exitPrice = base === null ? null : base * (1 + exit.delistingReturn);
        }
        if (exitPrice === null) {
          throw new InputError(
            `${FUNCTION_NAME}: '${instrumentId}' left the universe on ${date} while held, but the dataset has no price level for it at that session — supply its returns through the exit session.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: FUNCTION_NAME, instrumentId, field: 'dataset.returns' },
            },
          );
        }
        exitCount += 1;
        executeTrade({
          index,
          instrumentId,
          side: quantity > 0 ? 'sell' : 'buy',
          quantity: Math.abs(quantity),
          referencePrice: exitPrice,
          goals,
        });
        rowExits.push({ instrumentId, reason, exitPrice });
      }
      // the exits changed the book; everything after reads the post-exit holdings
      const heldAfterExits = heldQuantities();
      // 2. eligibility
      const lagSessions = 'factorRecipe' in signal ? signal.factorRecipe.lagTradingSessions : 0;
      const eligible = eligibleObservationsAt({
        observations: dataset.observations,
        fieldDefinitions: dataset.fieldDefinitions,
        asOf,
        universeHistory,
        ...(lagSessions > 0
          ? { lag: { tradingSessions: lagSessions, sessionTimestamps: sessions.instants } }
          : {}),
      });
      // 3. the signal
      const scores = signalScores(signal, eligible.observations, definitions, dataset, {
        asOf,
        sessionDate: date,
        members: membership.instrumentIds,
        held: [...heldAfterExits.keys()].sort(compareIds),
        universeId: universeHistory.universeId,
      });
      // a name must have a price to be traded at this session
      const scored = scores.filter(
        (row) => priceAt(row.instrumentId, index) !== null && members.has(row.instrumentId),
      );
      // 4. selection
      const selection = selectSides(
        scored,
        portfolioConstruction,
        rebalanceSchedule.bufferBand ?? 0,
        heldAfterExits,
        goals,
      );
      // 5. weights
      const trailing = (instrumentId: string): number[] => {
        const perSession = returnsBySession.get(instrumentId);
        if (perSession === undefined) return [];
        const out: number[] = [];
        for (let i = Math.max(0, index - lookback); i < index; i += 1) {
          const r = perSession[i]!;
          if (Number.isFinite(r)) out.push(r);
        }
        return out;
      };
      let weights = targetWeights(
        selection,
        portfolioConstruction,
        dataset,
        trailing,
        goals,
        { asOf, sessionDate: date },
        definitions,
        eligible.observations,
        lookback,
        warnings,
      );
      // 6. constraints
      weights = applyConstraints(weights, selection, portfolioConstruction, goals);
      // turnover cap: blend toward the current book in weight space
      const navBefore = netAssetValueAt(index);
      const currentWeights = new Map<string, number>();
      for (const [instrumentId, quantity] of heldAfterExits) {
        const price = priceAt(instrumentId, index);
        if (price !== null && navBefore > 0)
          currentWeights.set(instrumentId, (quantity * price) / navBefore);
      }
      if (portfolioConstruction.maximumTurnover !== undefined) {
        let estimated = 0;
        for (const id of new Set([...weights.keys(), ...currentWeights.keys()])) {
          estimated += Math.abs((weights.get(id) ?? 0) - (currentWeights.get(id) ?? 0));
        }
        if (estimated > portfolioConstruction.maximumTurnover) {
          const scale = portfolioConstruction.maximumTurnover / estimated;
          const blended = new Map<string, number>();
          for (const id of new Set([...weights.keys(), ...currentWeights.keys()])) {
            const current = currentWeights.get(id) ?? 0;
            const target = weights.get(id) ?? 0;
            const w = current + (target - current) * scale;
            if (Math.abs(w) > 1e-12) blended.set(id, w);
          }
          weights = blended;
          goals.push({
            goal: 'maximumTurnover',
            status: 'capped',
            detail: `estimated turnover ${estimated.toFixed(4)} scaled to ${portfolioConstruction.maximumTurnover}`,
          });
        } else {
          goals.push({
            goal: 'maximumTurnover',
            status: 'satisfied',
            detail: `estimated turnover ${estimated.toFixed(4)}`,
          });
        }
      }
      // 7. weights → quantities through the allocator
      const prices: Record<string, { price: number; currency: string }> = {};
      const currentHoldings: Record<string, number> = {};
      for (const id of new Set([...weights.keys(), ...heldAfterExits.keys()])) {
        const price = priceAt(id, index);
        if (price !== null) prices[id] = { price, currency: baseCurrency };
      }
      for (const [id, quantity] of heldAfterExits) currentHoldings[id] = quantity;
      const signedSum = [...weights.values()].reduce((s, w) => s + w, 0);
      const targets = [...weights.entries()]
        .sort((a, b) => compareIds(a[0], b[0]))
        .map(([instrumentId, weight]) => ({ group: { instrumentId }, weight }));
      const cashTarget = 1 - signedSum;
      const allocation = allocatePortfolio({
        policy: { targets: [...targets, { group: { assetClass: 'cash' }, weight: cashTarget }] },
        asOf,
        baseCurrency,
        netAssetValue: navBefore,
        prices,
        currentHoldings,
        defaultLotSize: 1,
      });
      if (!allocation.feasible) {
        goals.push({
          goal: 'allocation feasibility',
          status: 'violated',
          detail:
            allocation.unresolved.length > 0
              ? `unresolved: ${allocation.unresolved.map((u) => JSON.stringify(u)).join('; ')}`
              : (allocation.diagnostics.warnings[0] ?? 'infeasible'),
        });
      }
      // participation cap per name in units
      const participation = portfolioConstruction.maximumParticipation;
      let costsThisRebalance = 0;
      for (const trade of allocation.trades) {
        let quantity = trade.quantity;
        const adv = dataset.averageDailyVolumes?.[trade.instrumentId];
        if (participation !== undefined && adv !== undefined && quantity > participation * adv) {
          goals.push({
            goal: `maximumParticipation ${trade.instrumentId}`,
            status: 'capped',
            detail: `${quantity} → ${participation * adv} units (${participation} × ADV ${adv})`,
          });
          quantity = participation * adv;
        }
        if (!(quantity > 0)) continue;
        const price = prices[trade.instrumentId]!.price;
        const fill = executeTrade({
          index,
          instrumentId: trade.instrumentId,
          side: trade.side,
          quantity,
          referencePrice: price,
          goals,
        });
        if (fill !== null) costsThisRebalance += fill.costs?.commission ?? 0;
      }
      // 8. rows
      const after = heldQuantities();
      const ranks = new Map(scored.map((row, i) => [row.instrumentId, i + 1]));
      const scoreOf = new Map(scored.map((row) => [row.instrumentId, row.score]));
      const selectedNow = new Set([
        ...selection.long.map((r) => r.instrumentId),
        ...selection.short.map((r) => r.instrumentId),
      ]);
      for (const [instrumentId, quantity] of [...after].sort((a, b) => compareIds(a[0], b[0]))) {
        const price = priceAt(instrumentId, index) ?? 0;
        const navNow = navBefore; // weights are stated against the pre-trade NAV the allocator sized to
        holdings.push({
          rebalanceIndex,
          instrumentId,
          side: quantity > 0 ? 'long' : 'short',
          weight: navNow > 0 ? (quantity * price) / navNow : 0,
          quantity,
          score: scoreOf.get(instrumentId) ?? null,
          rank: ranks.get(instrumentId) ?? null,
          reason: selectedNow.has(instrumentId)
            ? previousSelection.has(instrumentId) && selection.retained.has(instrumentId)
              ? 'retained-in-buffer'
              : 'selected'
            : 'exited',
        });
      }
      for (const exit of rowExits) {
        holdings.push({
          rebalanceIndex,
          instrumentId: exit.instrumentId,
          side: 'long',
          weight: 0,
          quantity: 0,
          score: null,
          rank: null,
          reason: exit.reason,
        });
      }
      rebalances.push({
        rebalanceIndex,
        sessionDate: date,
        asOf,
        memberCount: membership.instrumentIds.length,
        eligibleCount: eligible.observations.length,
        scoredCount: scored.length,
        longCount: selection.long.length,
        shortCount: selection.short.length,
        turnover: allocation.turnover,
        costs: costsThisRebalance,
        netAssetValue: netAssetValueAt(index),
        goals,
        exits: rowExits,
      });
      attributionInputs.push({
        rebalanceIndex,
        sessionIndex: index,
        sessionDate: date,
        scores: scored,
        selection: selectedNow,
        eligibleCount: eligible.observations.length,
        memberCount: membership.instrumentIds.length,
      });
      previousSelection = selectedNow;
      previousRebalanceInstant = asOf;
    }
    // every session marks the ledger
    marks.push({ valuationDate: sessions.markDates[index]!, market: marketAt(index) });
  }

  // ---- the ledger's own reports ---------------------------------------------------------------------
  const ledger = createPortfolioLedger({ portfolioId: runId, baseCurrency, events });
  const timeline = portfolioTimeline({
    ledger,
    valuationMarks: marks,
    ...(dataset.classification !== undefined
      ? { instrumentClassification: { ...dataset.classification } }
      : {}),
  });
  const navs = timeline.rows.map((row) => row.netAssetValue);
  const points: EquityPoint[] = timeline.rows.map((row, index) => ({
    timestampMs: sessions.instants[index]!,
    equity: row.netAssetValue,
  }));
  const returns = equityToReturns(navs);
  const finalValue = navs[navs.length - 1]!;
  const reconciliationResidual = netAssetValueAt(sessions.dates.length - 1) - finalValue;
  if (!(Math.abs(reconciliationResidual) <= RECONCILIATION_TOLERANCE)) {
    throw new InputError(
      `${FUNCTION_NAME}: the ledger's net asset value at the last session (${netAssetValueAt(sessions.dates.length - 1)}) differs from the timeline's final value (${finalValue}) by ${reconciliationResidual} — an engine invariant failed; nothing was published.`,
      {
        code: ErrorCode.BacktestLedgerReconciliationFailed,
        context: { function: FUNCTION_NAME, residual: reconciliationResidual },
      },
    );
  }

  // ---- benchmark ------------------------------------------------------------------------------------
  let benchmark: BenchmarkComparison | null = null;
  let benchmarkReturns: number[] | undefined;
  if (dataset.benchmarkReturns !== undefined) {
    const byDate = new Map(
      dataset.benchmarkReturns.map((r) => [r.tradingSessionDate, r.simpleReturn]),
    );
    let missing = 0;
    // the timeline's first row is the opening mark; returns run between consecutive marks
    benchmarkReturns = sessions.dates.slice(1).map((date) => {
      const r = byDate.get(date);
      if (r === undefined) missing += 1;
      return r ?? 0;
    });
    if (missing > 0) {
      warnings.push(
        warning(
          WarningCode.BacktestDataMissing,
          `${missing} benchmark session${missing === 1 ? '' : 's'} had no return and counted as 0`,
          'warn',
          { missing },
        ),
      );
    }
  }
  const performance = analyze(
    { equity: navs },
    {
      periodsPerYear,
      riskFreeRate,
      ...(benchmarkReturns !== undefined ? { benchmark: benchmarkReturns } : {}),
    },
  );
  if (dataset.benchmarkReturns !== undefined && benchmarkReturns !== undefined) {
    const active = returns.map((r, i) => r - (benchmarkReturns as number[])[i]!);
    benchmark = {
      instrumentId: dataset.benchmarkReturns[0]!.instrumentId,
      returns: benchmarkReturns,
      activeReturn: mean(active),
      trackingError: performance.trackingError ?? null,
      informationRatio: performance.informationRatio ?? null,
      beta: performance.beta ?? null,
      alpha: performance.alpha ?? null,
    };
  }

  // ---- attribution ------------------------------------------------------------------------------------
  const perRebalance: AttributionRow[] = [];
  const decaySamples = new Map<number, number[]>(DECAY_HORIZONS.map((h) => [h, []]));
  const forwardReturn = (
    instrumentId: string,
    fromSession: number,
    toSession: number,
  ): number | null => {
    const perSession = returnsBySession.get(instrumentId);
    if (perSession === undefined) return null;
    let compounded = 1;
    let seen = 0;
    for (let i = fromSession + 1; i <= toSession && i < perSession.length; i += 1) {
      const r = perSession[i]!;
      if (!Number.isFinite(r)) continue;
      compounded *= 1 + r;
      seen += 1;
    }
    return seen === 0 ? null : compounded - 1;
  };
  attributionInputs.forEach((input, k) => {
    const next = attributionInputs[k + 1];
    const endSession = next !== undefined ? next.sessionIndex : sessions.dates.length - 1;
    const factorEntries: FactorEntry[] = input.scores.map((row) => ({
      instrumentId: row.instrumentId,
      value: row.score,
    }));
    const forward: FactorEntry[] = input.scores.map((row) => ({
      instrumentId: row.instrumentId,
      value: forwardReturn(row.instrumentId, input.sessionIndex, endSession),
    }));
    let ic: number | null = null;
    let rankIc: number | null = null;
    let spread: number | null = null;
    if (factorEntries.length >= 3 && next !== undefined) {
      const coefficient = informationCoefficient({ factorEntries, forwardReturns: forward });
      ic = coefficient.informationCoefficient;
      rankIc = coefficient.rankInformationCoefficient;
      const valued = forward.filter((e) => e.value !== null).length;
      if (valued >= 4) {
        const quantiles = Math.min(5, Math.floor(valued / 2));
        if (quantiles >= 2) {
          spread = factorSpreadReturn({
            entries: factorEntries,
            forwardReturns: forward,
            quantileCount: quantiles,
            direction: 'descending',
          }).spreadReturn;
        }
      }
    }
    const previous = k > 0 ? attributionInputs[k - 1]!.selection : null;
    const selectionTurnover =
      previous === null || input.selection.size === 0
        ? null
        : [...input.selection].filter((id) => !previous.has(id)).length / input.selection.size;
    perRebalance.push({
      rebalanceIndex: input.rebalanceIndex,
      sessionDate: input.sessionDate,
      informationCoefficient: ic,
      rankInformationCoefficient: rankIc,
      spreadReturn: spread,
      selectionTurnover,
      breadth: input.scores.length,
      coverage: input.memberCount > 0 ? input.eligibleCount / input.memberCount : 0,
    });
    for (const horizon of DECAY_HORIZONS) {
      const target = attributionInputs[k + horizon];
      if (target === undefined || factorEntries.length < 3) continue;
      const fwd: FactorEntry[] = input.scores.map((row) => ({
        instrumentId: row.instrumentId,
        value: forwardReturn(row.instrumentId, input.sessionIndex, target.sessionIndex),
      }));
      const c = informationCoefficient({
        factorEntries,
        forwardReturns: fwd,
      }).rankInformationCoefficient;
      if (c !== null) decaySamples.get(horizon)!.push(c);
    }
  });
  const attribution = {
    perRebalance,
    decay: DECAY_HORIZONS.map((horizon) => {
      const samples = decaySamples.get(horizon)!;
      return {
        horizonRebalances: horizon,
        meanRankInformationCoefficient: mean(samples),
        samples: samples.length,
      };
    }),
    meanInformationCoefficient: mean(
      perRebalance.map((r) => r.informationCoefficient).filter((v): v is number => v !== null),
    ),
    meanRankInformationCoefficient: mean(
      perRebalance.map((r) => r.rankInformationCoefficient).filter((v): v is number => v !== null),
    ),
    meanSpreadReturn: mean(
      perRebalance.map((r) => r.spreadReturn).filter((v): v is number => v !== null),
    ),
  };

  // ---- confidence ---------------------------------------------------------------------------------------
  let performanceConfidence: CrossSectionalBacktestResult['performanceConfidence'] = null;
  if (request.seed !== undefined && returns.length >= 2) {
    const resample = monteCarloResample(returns, { iterations: 1_000, seed: request.seed });
    performanceConfidence = {
      iterations: resample.iterations,
      seed: resample.seed,
      meanTotalReturn: resample.meanTotalReturn,
      standardDeviation: resample.standardDeviation,
      confidenceInterval95: resample.confidenceInterval95,
    };
  }

  const cappedGoalCount = rebalances.reduce(
    (s, r) => s + r.goals.filter((g) => g.status === 'capped').length,
    0,
  );
  const violatedGoalCount = rebalances.reduce(
    (s, r) => s + r.goals.filter((g) => g.status === 'violated').length,
    0,
  );
  const assumptions: CrossSectionalAssumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    universeId: universeHistory.universeId,
    signal: signalIdentity,
    rebalanceSchedule: {
      frequency: rebalanceSchedule.frequency,
      session: rebalanceSchedule.session,
      bufferBand: rebalanceSchedule.bufferBand ?? null,
    },
    sessionInstantConvention: SESSION_INSTANT_CONVENTION,
    pricing: PRICING_CONVENTION,
    portfolioConstruction: {
      method: portfolioConstruction.method,
      long: portfolioConstruction.long,
      short: portfolioConstruction.short ?? null,
      neutrality: portfolioConstruction.neutrality ?? 'none',
      maximumPositions: portfolioConstruction.maximumPositions ?? null,
      maximumPositionWeight: portfolioConstruction.maximumPositionWeight ?? null,
      minimumPositionWeight: portfolioConstruction.minimumPositionWeight ?? null,
      maximumTurnover: portfolioConstruction.maximumTurnover ?? null,
      maximumParticipation: portfolioConstruction.maximumParticipation ?? null,
      volatilityLookbackSessions: lookback,
      shortBookSizing: SHORT_BOOK_SIZING,
    },
    execution: describeExecutionPolicy(policy),
    costs: { commission: commission.label, slippage: slippage.label },
    initialCapital,
    baseCurrency,
    periodsPerYear,
    riskFreeRate,
    seed: request.seed ?? null,
    window: { fromTimestampMs: from ?? null, toTimestampMs: to ?? null },
    ledger: { sourceId, accountId: ACCOUNT_ID, lotRelief: ledger.lotRelief },
    replayable,
  };
  const diagnostics: CrossSectionalDiagnostics = {
    warnings,
    sessionCount: sessions.dates.length,
    rebalanceCount: rebalances.length,
    fillCount: fills.length,
    rejectedFillCount: rejectedFills,
    exitCount,
    delistingCount,
    cappedGoalCount,
    violatedGoalCount,
    reconciliationResidual,
  };
  return {
    rebalances,
    holdings,
    points,
    returns,
    trades,
    fills,
    ledger: ledger.toJSON(),
    timeline,
    attribution,
    benchmark,
    performance,
    performanceConfidence,
    finalValue,
    runId,
    assumptions,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------------------------------
// The signal → scores (every ranking is a research call)
// ---------------------------------------------------------------------------------------------------

function fieldEntries(observations: readonly UniverseObservation[], field: string): FactorEntry[] {
  return observations.map((o) => {
    const value = o.fields[field];
    return {
      instrumentId: o.instrumentId,
      value: typeof value === 'number' && Number.isFinite(value) ? value : null,
    };
  });
}

function recipeScores(
  recipe: FactorRecipe,
  observations: readonly UniverseObservation[],
  dataset: CrossSectionalBacktestRequest['dataset'],
): SignalRow[] {
  if (observations.length === 0) return [];
  const components = recipe.features.map((feature) => {
    let entries = fieldEntries(observations, feature.field);
    if (feature.transform === 'winsorize-then-z-score') {
      entries = winsorizeFactor({
        entries,
        method: { type: 'percentile', ...WINSOR_PERCENTILES },
      }).entries;
      entries = standardizeFactor({ entries, method: 'z-score' }).entries;
    } else if (feature.transform === 'percentile-rank') {
      entries = standardizeFactor({ entries, method: 'percentile-rank' }).entries;
    }
    if (recipe.neutralization !== 'none') {
      const groups = observations
        .filter((o) => dataset.groups?.[o.instrumentId] !== undefined)
        .map((o) => ({ instrumentId: o.instrumentId, group: dataset.groups![o.instrumentId]! }));
      const exposures =
        recipe.neutralization === 'sector-and-size' && dataset.sizeField !== undefined
          ? observations
              .filter((o) => typeof o.fields[dataset.sizeField!] === 'number')
              .map((o) => ({
                instrumentId: o.instrumentId,
                exposures: [o.fields[dataset.sizeField!] as number],
              }))
          : undefined;
      entries = neutralizeFactor({
        entries,
        groups,
        ...(exposures !== undefined ? { exposures } : {}),
      }).entries;
    }
    return { label: feature.field, entries, weight: feature.weight, direction: recipe.direction };
  });
  const composite = compositeFactorScore({
    components,
    missingValuePolicy: recipe.missingValuePolicy,
  });
  return composite.entries
    .filter((e): e is { instrumentId: string; value: number } => e.value !== null)
    .map((e) => ({ instrumentId: e.instrumentId, score: e.value }));
}

function signalScores(
  signal: CrossSectionalBacktestRequest['signal'],
  eligible: readonly UniverseObservation[],
  definitions: Map<string, FieldDefinition>,
  dataset: CrossSectionalBacktestRequest['dataset'],
  context: {
    asOf: EpochMs;
    sessionDate: string;
    members: readonly string[];
    held: readonly string[];
    universeId: string;
  },
): SignalRow[] {
  let rows: SignalRow[];
  if ('factorRecipe' in signal) rows = recipeScores(signal.factorRecipe, eligible, dataset);
  else if ('score' in signal) {
    if (eligible.length === 0) return [];
    rows = scoreUniverse({
      universeId: context.universeId,
      asOf: context.asOf,
      observations: eligible,
      fieldDefinitions: [...definitions.values()],
      components: signal.score.components,
      missingValuePolicy: signal.score.missingValuePolicy,
    }).rows.map((r) => ({ instrumentId: r.instrumentId, score: r.score }));
  } else if ('screen' in signal) {
    if (eligible.length === 0) return [];
    const screened = screenUniverse({
      universeId: context.universeId,
      asOf: context.asOf,
      observations: eligible,
      fieldDefinitions: [...definitions.values()],
      ...(signal.screen.filter !== undefined ? { filter: signal.screen.filter } : {}),
      missingValuePolicy: signal.screen.missingValuePolicy,
      orderBy: [...signal.screen.orderBy],
    });
    // the screen's order is the ranking: the first row is the best
    rows = screened.rows.map((r, i) => ({
      instrumentId: r.instrumentId,
      score: screened.rows.length - i,
    }));
  } else {
    const produced = signal.callback({
      asOf: context.asOf,
      sessionDate: context.sessionDate,
      eligible,
      fieldDefinitions: [...definitions.values()],
      members: context.members,
      held: context.held,
    });
    if (!Array.isArray(produced)) {
      throw new InputError(
        `${FUNCTION_NAME}: signal.callback must return an array of { instrumentId, score }.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: FUNCTION_NAME, field: 'signal.callback' },
        },
      );
    }
    const seen = new Set<string>();
    rows = produced.map((row, i) => {
      if (
        typeof row?.instrumentId !== 'string' ||
        row.instrumentId.length === 0 ||
        typeof row.score !== 'number' ||
        !Number.isFinite(row.score)
      ) {
        throw new InputError(
          `${FUNCTION_NAME}: signal.callback returned a malformed row at index ${i} — each row is { instrumentId: string, score: finite number }.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: FUNCTION_NAME, field: 'signal.callback' },
          },
        );
      }
      if (seen.has(row.instrumentId)) {
        throw new InputError(
          `${FUNCTION_NAME}: signal.callback returned '${row.instrumentId}' twice.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: FUNCTION_NAME, field: 'signal.callback' },
          },
        );
      }
      seen.add(row.instrumentId);
      return { instrumentId: row.instrumentId, score: row.score };
    });
  }
  // higher is better, ties by instrumentId — the same final key research uses
  return [...rows].sort((a, b) => b.score - a.score || compareIds(a.instrumentId, b.instrumentId));
}

// ---------------------------------------------------------------------------------------------------
// Selection and weights
// ---------------------------------------------------------------------------------------------------

interface Selection {
  long: SignalRow[];
  short: SignalRow[];
  retained: Set<string>;
}

function sideCount(
  spec: { topQuantile?: number; bottomQuantile?: number; count?: number; fraction?: number },
  universeSize: number,
): number {
  if (spec.count !== undefined) return Math.min(spec.count, universeSize);
  const fraction = spec.topQuantile ?? spec.bottomQuantile ?? spec.fraction ?? 0;
  return Math.max(0, Math.floor(universeSize * fraction + 1e-12));
}

function selectSides(
  scored: SignalRow[],
  construction: CrossSectionalBacktestRequest['portfolioConstruction'],
  bufferBand: number,
  held: Map<string, number>,
  goals: RebalanceGoal[],
): Selection {
  const retained = new Set<string>();
  const n = scored.length;
  const longCount = sideCount(construction.long, n);
  const shortCount = construction.short !== undefined ? sideCount(construction.short, n) : 0;
  // quantile selections use the research partition so the law is the same one formQuantilePortfolios proves
  let long: SignalRow[];
  let short: SignalRow[] = [];
  if ('topQuantile' in construction.long && n >= 2) {
    const quantiles = Math.max(2, Math.round(1 / construction.long.topQuantile));
    if (n >= quantiles) {
      const partition = formQuantilePortfolios({
        entries: scored.map((r) => ({ instrumentId: r.instrumentId, value: r.score })),
        quantileCount: quantiles,
        direction: 'descending',
      });
      const top = new Set(partition.portfolios[0]!.instrumentIds);
      long = scored.filter((r) => top.has(r.instrumentId));
    } else long = scored.slice(0, longCount);
  } else long = scored.slice(0, longCount);
  if (construction.short !== undefined) {
    if ('bottomQuantile' in construction.short && n >= 2) {
      const quantiles = Math.max(2, Math.round(1 / construction.short.bottomQuantile));
      if (n >= quantiles) {
        const partition = formQuantilePortfolios({
          entries: scored.map((r) => ({ instrumentId: r.instrumentId, value: r.score })),
          quantileCount: quantiles,
          direction: 'descending',
        });
        const bottom = new Set(
          partition.portfolios[partition.portfolios.length - 1]!.instrumentIds,
        );
        short = scored.filter((r) => bottom.has(r.instrumentId));
      } else short = scored.slice(Math.max(0, n - shortCount));
    } else short = scored.slice(Math.max(0, n - shortCount));
  }
  // buffer band: a held long stays while its rank is within (1 + band) × the long threshold; shorts mirrored
  if (bufferBand > 0 && long.length > 0) {
    const threshold = long.length;
    const limit = Math.floor(threshold * (1 + bufferBand));
    const longIds = new Set(long.map((r) => r.instrumentId));
    scored.forEach((row, i) => {
      const rank = i + 1;
      if (
        rank > threshold &&
        rank <= limit &&
        (held.get(row.instrumentId) ?? 0) > 0 &&
        !longIds.has(row.instrumentId)
      ) {
        long.push(row);
        retained.add(row.instrumentId);
      }
    });
  }
  if (bufferBand > 0 && short.length > 0) {
    const threshold = short.length;
    const limit = Math.floor(threshold * (1 + bufferBand));
    const shortIds = new Set(short.map((r) => r.instrumentId));
    scored.forEach((row, i) => {
      const rankFromBottom = n - i;
      if (
        rankFromBottom > threshold &&
        rankFromBottom <= limit &&
        (held.get(row.instrumentId) ?? 0) < 0 &&
        !shortIds.has(row.instrumentId)
      ) {
        short.push(row);
        retained.add(row.instrumentId);
      }
    });
  }
  // a name cannot be on both sides
  const longIds = new Set(long.map((r) => r.instrumentId));
  short = short.filter((r) => !longIds.has(r.instrumentId));
  if (
    construction.maximumPositions !== undefined &&
    long.length + short.length > construction.maximumPositions
  ) {
    const total = long.length + short.length;
    const keepLong = Math.round((construction.maximumPositions * long.length) / total);
    long = long.slice(0, keepLong);
    short = short.slice(Math.max(0, short.length - (construction.maximumPositions - keepLong)));
    goals.push({
      goal: 'maximumPositions',
      status: 'capped',
      detail: `${total} → ${long.length + short.length}`,
    });
  }
  if (long.length === 0)
    goals.push({
      goal: 'long selection',
      status: 'violated',
      detail: `no name qualified from ${n} scored`,
    });
  if (construction.short !== undefined && short.length === 0)
    goals.push({
      goal: 'short selection',
      status: 'violated',
      detail: `no name qualified from ${n} scored`,
    });
  return { long, short, retained };
}

function targetWeights(
  selection: Selection,
  construction: CrossSectionalBacktestRequest['portfolioConstruction'],
  dataset: CrossSectionalBacktestRequest['dataset'],
  trailing: (instrumentId: string) => number[],
  goals: RebalanceGoal[],
  instant: { asOf: EpochMs; sessionDate: string },
  definitions: Map<string, FieldDefinition>,
  eligible: readonly UniverseObservation[],
  lookback: number,
  warnings: QuantWarning[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const sides: Array<{ rows: SignalRow[]; sign: 1 | -1 }> = [{ rows: selection.long, sign: 1 }];
  if (selection.short.length > 0) sides.push({ rows: selection.short, sign: -1 });
  if (construction.method === 'supplied-weights') {
    const trailingReturns: Record<string, number[]> = {};
    for (const row of [...selection.long, ...selection.short])
      trailingReturns[row.instrumentId] = trailing(row.instrumentId);
    const supplied = construction.suppliedWeights!({
      asOf: instant.asOf,
      sessionDate: instant.sessionDate,
      long: selection.long,
      short: selection.short,
      trailingReturns,
    });
    for (const [instrumentId, weight] of Object.entries(supplied ?? {})) {
      if (typeof weight !== 'number' || !Number.isFinite(weight)) {
        throw new InputError(
          `${FUNCTION_NAME}: portfolioConstruction.suppliedWeights returned a non-finite weight for '${instrumentId}'.`,
          {
            code: ErrorCode.InputNotFinite,
            context: { function: FUNCTION_NAME, field: 'portfolioConstruction.suppliedWeights' },
          },
        );
      }
      if (weight !== 0) weights.set(instrumentId, weight);
    }
    return neutralize(weights, selection, construction, dataset, goals, definitions, eligible);
  }
  for (const side of sides) {
    const n = side.rows.length;
    if (n === 0) continue;
    let raw: number[];
    switch (construction.method) {
      case 'equal-weight':
        raw = side.rows.map(() => 1);
        break;
      case 'score-weight': {
        const scores = side.rows.map((r) => r.score);
        const lo = Math.min(...scores);
        const hi = Math.max(...scores);
        const span = hi - lo;
        // conviction: distance from the side's worst score plus one average step, so every name keeps a positive weight
        raw = scores.map((s) => (side.sign === 1 ? s - lo : hi - s) + (span > 0 ? span / n : 1));
        break;
      }
      case 'inverse-volatility': {
        raw = side.rows.map((r) => {
          const sigma = sampleStandardDeviation(trailing(r.instrumentId));
          return sigma !== null && sigma > 0 ? 1 / sigma : Number.NaN;
        });
        if (raw.some((v) => !Number.isFinite(v))) {
          const fallback = raw.filter((v) => Number.isFinite(v));
          const fill =
            fallback.length > 0 ? fallback.reduce((s, v) => s + v, 0) / fallback.length : 1;
          raw = raw.map((v) => (Number.isFinite(v) ? v : fill));
          goals.push({
            goal: `inverse-volatility (${side.sign === 1 ? 'long' : 'short'})`,
            status: 'capped',
            detail: `names without ${lookback}-session history took the side's mean inverse volatility`,
          });
        }
        break;
      }
      case 'risk-budget': {
        const series = side.rows.map((r) => trailing(r.instrumentId));
        const length = Math.min(...series.map((s) => s.length));
        if (length < 3 || n < 2) {
          raw = side.rows.map(() => 1);
          goals.push({
            goal: `risk-budget (${side.sign === 1 ? 'long' : 'short'})`,
            status: 'capped',
            detail: `fewer than 3 common trailing sessions (${length}); equal weights used`,
          });
          break;
        }
        const rows: number[][] = [];
        for (let t = 0; t < length; t += 1) rows.push(series.map((s) => s[s.length - length + t]!));
        const cov = covariance({ returns: rows, assets: side.rows.map((r) => r.instrumentId) });
        const parity = riskParity(cov.value.covariance, { budget: 1 });
        raw = parity.value.weights;
        for (const w of parity.diagnostics.warnings) warnings.push(w);
        break;
      }
      default:
        raw = side.rows.map(() => 1);
    }
    const total = raw.reduce((s, v) => s + v, 0);
    side.rows.forEach((row, i) => {
      const w = (side.sign * (raw[i] ?? 0)) / (total > 0 ? total : 1);
      if (w !== 0) weights.set(row.instrumentId, w);
    });
  }
  return neutralize(weights, selection, construction, dataset, goals, definitions, eligible);
}

function neutralize(
  weights: Map<string, number>,
  selection: Selection,
  construction: CrossSectionalBacktestRequest['portfolioConstruction'],
  dataset: CrossSectionalBacktestRequest['dataset'],
  goals: RebalanceGoal[],
  definitions: Map<string, FieldDefinition>,
  eligible: readonly UniverseObservation[],
): Map<string, number> {
  const neutrality = construction.neutrality ?? 'none';
  if (neutrality === 'none' || selection.short.length === 0) return weights;
  const longGross = [...weights.values()].filter((w) => w > 0).reduce((s, w) => s + w, 0);
  const shortGross = [...weights.values()].filter((w) => w < 0).reduce((s, w) => s - w, 0);
  const out = new Map(weights);
  if (neutrality === 'dollar') {
    if (shortGross > 0) {
      const scale = longGross / shortGross;
      for (const [id, w] of out) if (w < 0) out.set(id, w * scale);
      goals.push({
        goal: 'dollar neutrality',
        status: 'satisfied',
        detail: `short book scaled by ${scale.toFixed(6)} to the long gross ${longGross.toFixed(6)}`,
      });
    } else
      goals.push({
        goal: 'dollar neutrality',
        status: 'violated',
        detail: 'no short weights to scale',
      });
    return out;
  }
  if (neutrality === 'sector') {
    const groups = dataset.groups ?? {};
    const byGroup = new Map<string, { long: number; short: number }>();
    for (const [id, w] of out) {
      const g = groups[id] ?? '(ungrouped)';
      const entry = byGroup.get(g) ?? { long: 0, short: 0 };
      if (w > 0) entry.long += w;
      else entry.short -= w;
      byGroup.set(g, entry);
    }
    let violated = 0;
    for (const [g, entry] of byGroup) {
      if (entry.long > 0 && entry.short > 0) {
        const scale = entry.long / entry.short;
        for (const [id, w] of out)
          if (w < 0 && (groups[id] ?? '(ungrouped)') === g) out.set(id, w * scale);
      } else violated += 1;
    }
    goals.push({
      goal: 'sector neutrality',
      status: violated === 0 ? 'satisfied' : 'violated',
      detail:
        violated === 0
          ? `${byGroup.size} groups balanced`
          : `${violated} of ${byGroup.size} groups have one side only`,
    });
    return out;
  }
  if (neutrality === 'beta') {
    const betas = dataset.betas ?? {};
    let longBeta = 0;
    let shortBeta = 0;
    let missing = 0;
    for (const [id, w] of out) {
      const beta = betas[id];
      if (beta === undefined) {
        missing += 1;
        continue;
      }
      if (w > 0) longBeta += w * beta;
      else shortBeta -= w * beta;
    }
    if (missing > 0 || shortBeta <= 0) {
      goals.push({
        goal: 'beta neutrality',
        status: 'violated',
        detail:
          missing > 0
            ? `${missing} selected names have no beta`
            : 'the short book carries no beta to offset',
      });
      return out;
    }
    const scale = longBeta / shortBeta;
    for (const [id, w] of out) if (w < 0) out.set(id, w * scale);
    goals.push({
      goal: 'beta neutrality',
      status: 'satisfied',
      detail: `short book scaled by ${scale.toFixed(6)}; weighted beta 0`,
    });
    return out;
  }
  // factor: residualize the weight vector against the named exposure
  const field = construction.neutralizeAgainst!.field;
  if (!definitions.has(field)) return out;
  const exposureOf = new Map(eligible.map((o) => [o.instrumentId, o.fields[field]]));
  const entries: FactorEntry[] = [...out.entries()].map(([id, w]) => ({
    instrumentId: id,
    value: w,
  }));
  const exposures = entries
    .filter((e) => typeof exposureOf.get(e.instrumentId) === 'number')
    .map((e) => ({
      instrumentId: e.instrumentId,
      exposures: [exposureOf.get(e.instrumentId) as number],
    }));
  if (exposures.length < 3) {
    goals.push({
      goal: 'factor neutrality',
      status: 'violated',
      detail: `only ${exposures.length} selected names carry '${field}'`,
    });
    return out;
  }
  const residual = neutralizeFactor({ entries, exposures });
  for (const e of residual.entries) if (e.value !== null) out.set(e.instrumentId, e.value);
  goals.push({
    goal: 'factor neutrality',
    status: 'satisfied',
    detail: `weights residualized against '${field}' over ${exposures.length} names`,
  });
  return out;
}

function applyConstraints(
  weights: Map<string, number>,
  selection: Selection,
  construction: CrossSectionalBacktestRequest['portfolioConstruction'],
  goals: RebalanceGoal[],
): Map<string, number> {
  const out = new Map(weights);
  const cap = construction.maximumPositionWeight;
  if (cap !== undefined) {
    let capped = 0;
    for (const sign of [1, -1] as const) {
      // cap and redistribute the excess pro rata to the side's uncapped names, iterating to a fixed point
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const side = [...out.entries()].filter(([, w]) => Math.sign(w) === sign);
        const over = side.filter(([, w]) => Math.abs(w) > cap + 1e-12);
        if (over.length === 0) break;
        let excess = 0;
        for (const [id, w] of over) {
          excess += Math.abs(w) - cap;
          out.set(id, sign * cap);
          capped += 1;
        }
        const under = side.filter(([, w]) => Math.abs(w) < cap - 1e-12);
        const underTotal = under.reduce((s, [, w]) => s + Math.abs(w), 0);
        if (under.length === 0 || underTotal === 0) break;
        for (const [id, w] of under) out.set(id, w + sign * excess * (Math.abs(w) / underTotal));
      }
    }
    if (capped > 0)
      goals.push({
        goal: 'maximumPositionWeight',
        status: 'capped',
        detail: `${capped} weight${capped === 1 ? '' : 's'} capped at ${cap}; excess redistributed pro rata`,
      });
  }
  const floor = construction.minimumPositionWeight;
  if (floor !== undefined && floor > 0) {
    let dropped = 0;
    for (const [id, w] of [...out.entries()]) {
      if (Math.abs(w) < floor) {
        out.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0)
      goals.push({
        goal: 'minimumPositionWeight',
        status: 'capped',
        detail: `${dropped} name${dropped === 1 ? '' : 's'} below ${floor} dropped`,
      });
  }
  void selection;
  return out;
}
