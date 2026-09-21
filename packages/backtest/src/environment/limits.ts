/**
 * Limits, the mask, and the projection (Stage 7B.1 slice 2, Decisions 5 and 6). Post-trade truth is
 * FC7's `monitorPortfolio` over the engine's own valuation inputs with `policy: { limits }` — no
 * limit arithmetic is written twice. Pre-trade, each queued order is projected at the current marks
 * (a projection, not a guarantee) against the three ratios the monitor reports; the mask says, per
 * instrument and side, whether any order is allowed and why not, and it is a promise the
 * submission-time check keeps.
 */
import type { EpochMs } from '@totalfinance/core';
import {
  monitorPortfolio,
  type PolicyLimits,
  type PortfolioMonitorState,
} from '@totalfinance/portfolio';
import type { ExecutionPolicy } from '../execution/types.js';
import type {
  InstrumentSpecification,
  LatestObservations,
  PortfolioValuationInputs,
  SessionContext,
  SessionPosition,
} from '../portfolio/types.js';
import { policyObservationTimestamp } from './features.js';
import type {
  ActionMask,
  ActionMaskEntry,
  EnvironmentLimits,
  EnvironmentLimitsView,
  LimitBreach,
  LimitUtilization,
  MaskReason,
} from './types.js';

const ENVIRONMENT_ONLY = [
  'allowUndefinedRiskOptions',
  'maximumPositionNotional',
  'onBreach',
] as const;

/** The FC7 members of the limits — what `monitorPortfolio` reads. */
export function policyLimitsOf(limits: EnvironmentLimits | undefined): PolicyLimits {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(limits ?? {})) {
    if ((ENVIRONMENT_ONLY as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out as PolicyLimits;
}

const declaresPolicyLimit = (limits: PolicyLimits): boolean => Object.keys(limits).length > 0;

/** The observation kind the execution policy fills on is present for the instrument. */
export function tradableObservation(
  spec: InstrumentSpecification,
  latest: LatestObservations,
  policy: ExecutionPolicy,
): boolean {
  if (spec.kind === 'option') return latest.chainQuote !== undefined;
  if (spec.kind === 'fx-forward') return latest.forwardRate !== undefined;
  switch (policy.observation) {
    case 'bar':
      return latest.bar !== undefined;
    case 'quote':
      return latest.quote !== undefined;
    case 'trade':
      return latest.trade !== undefined;
    case 'order-book':
      return latest.orderBook !== undefined;
  }
}

function halted(policy: ExecutionPolicy, instrumentId: string, at: EpochMs | undefined): boolean {
  if (at === undefined) return false;
  for (const window of policy.sessions?.halts ?? []) {
    if (window.instrumentId !== undefined && window.instrumentId !== instrumentId) continue;
    if (window.fromTimestampMs <= at && at <= window.toTimestampMs) return true;
  }
  return false;
}

function staleUnderPolicy(
  spec: InstrumentSpecification,
  latest: LatestObservations,
  policy: ExecutionPolicy,
  asOf: EpochMs,
): boolean {
  if (policy.staleQuotes.behavior !== 'reject' || policy.staleQuotes.maximumAgeMs === null)
    return false;
  const timestampMs = policyObservationTimestamp(spec, latest, policy);
  return timestampMs !== null && asOf - timestampMs > policy.staleQuotes.maximumAgeMs;
}

/** A short option is undefined-risk unless it closes a long, or it is a call covered by the underlying. */
function undefinedRiskSell(
  spec: InstrumentSpecification,
  held: number,
  positions: readonly SessionPosition[],
): boolean {
  if (spec.kind !== 'option') return false;
  if (held > 0) return false; // a sell reduces a long first
  const contract = spec.contract;
  if (contract?.kind !== 'option') return true;
  if (contract.type === 'call') {
    const underlying = positions.find((p) => p.instrumentId === contract.underlyingInstrumentId);
    const multiplier = spec.contractMultiplier ?? 1;
    const covered = underlying === undefined ? 0 : Math.max(0, underlying.quantity) / multiplier;
    return covered < Math.abs(held) + 1;
  }
  return true;
}

export interface MaskInputs {
  context: SessionContext;
  policy: ExecutionPolicy;
  limits: EnvironmentLimits | undefined;
  nextInstant: EpochMs | undefined;
  grossExposure: number;
  buyingPower: number;
  episodeOver: boolean;
}

export function buildActionMask(input: MaskInputs): ActionMask {
  const { context, policy, limits, nextInstant, grossExposure, buyingPower, episodeOver } = input;
  const nav = context.netAssetValue;
  const entries: Record<string, ActionMaskEntry> = {};
  for (const [id, spec] of Object.entries(context.instruments)) {
    const buy: MaskReason[] = [];
    const sell: MaskReason[] = [];
    const both = (reason: MaskReason): void => {
      buy.push(reason);
      sell.push(reason);
    };
    if (episodeOver) both('episode-over');
    const latest = context.observations[id] ?? {};
    if (!tradableObservation(spec, latest, policy)) both('no-observation');
    if (halted(policy, id, nextInstant)) both('halted');
    if (staleUnderPolicy(spec, latest, policy, context.asOf)) both('stale-quote');
    const position = context.positions.find((p) => p.instrumentId === id);
    const held = position?.quantity ?? 0;
    const value = position?.baseCurrencyMarketValue ?? 0;
    // a side that grows the absolute position is the side the limits watch
    const growing: MaskReason[] = held >= 0 ? buy : sell;
    if (limits !== undefined && nav > 0) {
      if (
        limits.maximumPositionWeight !== undefined &&
        Math.abs(value) / nav >= limits.maximumPositionWeight
      )
        growing.push('position-limit');
      if (
        limits.maximumPositionNotional !== undefined &&
        Math.abs(value) >= limits.maximumPositionNotional
      )
        growing.push('notional-limit');
      if (
        limits.maximumGrossLeverage !== undefined &&
        grossExposure / nav >= limits.maximumGrossLeverage
      )
        growing.push('leverage-limit');
    }
    if (held === 0 && limits !== undefined && nav > 0) {
      // a flat instrument grows in either direction
      if (
        limits.maximumGrossLeverage !== undefined &&
        grossExposure / nav >= limits.maximumGrossLeverage
      )
        sell.push('leverage-limit');
    }
    if (
      !(limits?.allowUndefinedRiskOptions ?? false) &&
      undefinedRiskSell(spec, held, context.positions)
    )
      sell.push('undefined-risk');
    if (!(buyingPower > 0)) buy.push('insufficient-buying-power');
    entries[id] = {
      instrumentId: id,
      buy: buy.length === 0,
      sell: sell.length === 0,
      reasons: { buy, sell },
    };
  }
  return entries;
}

export interface ProjectionBook {
  /** Signed quantity per instrument after the orders accepted so far. */
  quantities: Map<string, number>;
  /** Base-currency value per unit of quantity (mark × multiplier × fx), when known. */
  unitValues: Map<string, number | null>;
  grossExposure: number;
  netAssetValue: number;
}

export function createProjectionBook(
  context: SessionContext,
  baseCurrency: string,
): ProjectionBook {
  const quantities = new Map<string, number>();
  const unitValues = new Map<string, number | null>();
  let gross = 0;
  for (const position of context.positions) {
    quantities.set(position.instrumentId, position.quantity);
    if (position.baseCurrencyMarketValue !== null) {
      gross += Math.abs(position.baseCurrencyMarketValue);
      unitValues.set(
        position.instrumentId,
        position.quantity === 0 ? null : position.baseCurrencyMarketValue / position.quantity,
      );
    }
  }
  for (const [id, spec] of Object.entries(context.instruments)) {
    if (unitValues.has(id)) continue;
    const mark = context.marks[id];
    unitValues.set(
      id,
      mark !== null && mark !== undefined && spec.currency === baseCurrency
        ? mark.pricePerUnit * (spec.contractMultiplier ?? 1)
        : null,
    );
  }
  return { quantities, unitValues, grossExposure: gross, netAssetValue: context.netAssetValue };
}

export interface ProjectionVerdict {
  limit: 'maximumPositionWeight' | 'maximumPositionNotional' | 'maximumGrossLeverage';
  detail: string;
}

/** Project one order onto the book; a breach names the limit, an acceptance updates the book. */
export function projectOrder(
  book: ProjectionBook,
  limits: EnvironmentLimits | undefined,
  order: { instrumentId: string; side: 'buy' | 'sell'; quantity: number },
): ProjectionVerdict | null {
  const held = book.quantities.get(order.instrumentId) ?? 0;
  const after = held + (order.side === 'buy' ? order.quantity : -order.quantity);
  const unit = book.unitValues.get(order.instrumentId) ?? null;
  if (limits !== undefined && unit !== null && book.netAssetValue > 0) {
    const current = Math.abs(held * unit);
    const projected = Math.abs(after * unit);
    const nav = book.netAssetValue;
    if (
      limits.maximumPositionWeight !== undefined &&
      projected / nav > limits.maximumPositionWeight
    ) {
      return {
        limit: 'maximumPositionWeight',
        detail: `would hold ${after} ${order.instrumentId} ≈ ${(projected / nav).toFixed(4)} of NAV against maximumPositionWeight ${limits.maximumPositionWeight}.`,
      };
    }
    if (
      limits.maximumPositionNotional !== undefined &&
      projected > limits.maximumPositionNotional
    ) {
      return {
        limit: 'maximumPositionNotional',
        detail: `would hold ${after} ${order.instrumentId} ≈ ${projected.toFixed(2)} against maximumPositionNotional ${limits.maximumPositionNotional}.`,
      };
    }
    const gross = book.grossExposure - current + projected;
    if (limits.maximumGrossLeverage !== undefined && gross / nav > limits.maximumGrossLeverage) {
      return {
        limit: 'maximumGrossLeverage',
        detail: `would take gross exposure to ≈ ${(gross / nav).toFixed(4)} × NAV against maximumGrossLeverage ${limits.maximumGrossLeverage}.`,
      };
    }
    book.grossExposure = gross;
  }
  book.quantities.set(order.instrumentId, after);
  return null;
}

export interface PostTradeInputs {
  valuation: PortfolioValuationInputs;
  limits: EnvironmentLimits | undefined;
  policy: ExecutionPolicy;
  previousState: PortfolioMonitorState | null;
  context: SessionContext;
  grossExposure: number;
  runningPeak: number;
  previousNetAssetValue: number | null;
}

export interface PostTradeVerdict {
  view: EnvironmentLimitsView;
  state: PortfolioMonitorState | null;
}

/** The FC7 monitor over the engine's valuation inputs; the utilization is the dashboard, the monitor is the judge. */
export function evaluatePostTrade(input: PostTradeInputs): PostTradeVerdict {
  const { valuation, limits, policy, previousState, context, grossExposure } = input;
  const policyLimits = policyLimitsOf(limits);
  const nav = context.netAssetValue;
  const utilization: LimitUtilization[] = [];
  const upper = (limit: string, subject: string, value: number | null, bound: number): void => {
    utilization.push({
      limit,
      subject,
      value,
      bound,
      fraction: value === null || bound === 0 ? null : value / bound,
    });
  };
  if (limits !== undefined && nav > 0) {
    for (const position of context.positions) {
      const value = position.baseCurrencyMarketValue;
      if (limits.maximumPositionWeight !== undefined)
        upper(
          'maximumPositionWeight',
          position.instrumentId,
          value === null ? null : Math.abs(value) / nav,
          limits.maximumPositionWeight,
        );
      if (limits.maximumPositionNotional !== undefined)
        upper(
          'maximumPositionNotional',
          position.instrumentId,
          value === null ? null : Math.abs(value),
          limits.maximumPositionNotional,
        );
    }
    if (limits.maximumGrossLeverage !== undefined)
      upper('maximumGrossLeverage', 'portfolio', grossExposure / nav, limits.maximumGrossLeverage);
    if (limits.maximumDrawdown !== undefined)
      upper(
        'maximumDrawdown',
        'portfolio',
        input.runningPeak > 0 ? 1 - nav / input.runningPeak : null,
        limits.maximumDrawdown,
      );
    if (limits.maximumDailyLoss !== undefined)
      upper(
        'maximumDailyLoss',
        'portfolio',
        input.previousNetAssetValue !== null && input.previousNetAssetValue > 0
          ? (input.previousNetAssetValue - nav) / input.previousNetAssetValue
          : null,
        limits.maximumDailyLoss,
      );
    if (limits.minimumSettledCash !== undefined) {
      const settled = valuation.snapshot.cash.reduce(
        (sum, row) =>
          sum +
          (row.totalAmount === 0
            ? 0
            : row.baseCurrencyValue * (row.settledAmount / row.totalAmount)),
        0,
      );
      utilization.push({
        limit: 'minimumSettledCash',
        subject: 'portfolio',
        value: settled,
        bound: limits.minimumSettledCash,
        fraction:
          limits.minimumSettledCash === 0
            ? null
            : limits.minimumSettledCash / (settled === 0 ? Number.EPSILON : settled),
      });
    }
  }
  if (!declaresPolicyLimit(policyLimits))
    return { view: { utilization, breaches: [] }, state: previousState };
  const monitor = monitorPortfolio({
    portfolio: valuation.portfolio,
    market: valuation.market,
    asOf: valuation.asOf,
    currencyConversions: valuation.currencyConversions,
    policy: { limits: policyLimits },
    previousState,
    ...(policy.staleQuotes.maximumAgeMs !== null
      ? { marketStalenessLimitMs: policy.staleQuotes.maximumAgeMs }
      : {}),
  });
  const breaches: LimitBreach[] = monitor.alerts
    .filter((alert) => alert.state === 'raised' || alert.state === 'active')
    .map((alert) => ({
      family: alert.family,
      subject: alert.subject,
      value: alert.value,
      threshold: alert.threshold,
      message: alert.message,
    }));
  return { view: { utilization, breaches }, state: monitor.state };
}
