/**
 * FC7 slice 4 — `monitorPortfolio`: one explicit valuation against the policy and the prior
 * monitor state. Every number is hand-computed in a comment; the replay law is held directly.
 *
 * Base fixture (USD): 01-02 deposit 100,000 · 01-10 buy 100 AAPL @ 700 → cash 30,000, 100 AAPL.
 *   AAPL @ 700 → NAV 100,000, AAPL weight 0.7, cash weight 0.3.
 *   AAPL @ 800 → NAV 110,000. AAPL @ 650 → NAV 95,000. AAPL @ 300 → NAV 60,000 (weight 0.5).
 * Levered fixture: 01-02 deposit 100,000 · 01-10 buy 200 AAPL @ 700 → cash −40,000, 200 AAPL.
 *   AAPL @ 700 → positions 140,000, NAV 100,000, gross leverage 1.4.
 * Option fixtures (slice 5): 01-12 one AAPL 2026-02-20 200 call/put @ 5 × 100 multiplier.
 *   Long call → cash 99,500; call @ 6 → NAV 100,100. Short → cash 100,500; @ 12 → NAV 99,300.
 * Futures fixture: 01-12 buy 2 ESH6 @ 4,500 × 50, variation margin → cash stays 100,000.
 *   ESH6 @ 4,520 → unsettled P&L 2,000, NAV 102,000; notional 452,000 (weight 4.4314).
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot, type MarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  portfolioPnl,
  reconcilePortfolio,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioState,
} from '../src/index.js';
import {
  MONITOR_ALERT_FAMILIES,
  PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION,
  monitorPortfolio,
  type MonitorAlert,
  type MonitorPortfolioInput,
  type PortfolioMonitorState,
} from '../src/monitor.js';
import type { InvestmentPolicy } from '../src/policy-grammar.js';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event.eventType,
    sourceId: 'test',
    accountId,
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}

const at = (month: number, day: number, hour = 15) => Date.UTC(2026, month - 1, day, hour);
/** February evaluation instants, 16:00 UTC. */
const T = (day: number, hour = 16) => Date.UTC(2026, 1, day, hour);
const HOUR = 3_600_000;

const DEPOSIT = envelope('dep-1', at(1, 2), 'main', {
  eventType: 'cash.deposit',
  amount: 100_000,
  currency: 'USD',
});
const BUY_100 = envelope('fill-1', at(1, 10), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'AAPL',
  side: 'buy',
  quantity: 100,
  pricePerUnit: 700,
  currency: 'USD',
});
const BUY_200 = envelope('fill-1', at(1, 10), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'AAPL',
  side: 'buy',
  quantity: 200,
  pricePerUnit: 700,
  currency: 'USD',
});
const BUY_MSFT = envelope('fill-2', at(1, 11), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'MSFT',
  side: 'buy',
  quantity: 50,
  pricePerUnit: 400,
  currency: 'USD',
});

const CALL_ID = 'AAPL260220C200';
const PUT_ID = 'AAPL260220P200';
const CALL_TERMS = {
  kind: 'option',
  underlyingInstrumentId: 'AAPL',
  type: 'call',
  strikePricePerUnit: 200,
  expiryTimestampMs: at(2, 20),
} as const;
const PUT_TERMS = { ...CALL_TERMS, type: 'put' } as const;
const optionFill = (
  eventId: string,
  instrumentId: string,
  side: 'buy' | 'sell',
  contract: typeof CALL_TERMS | typeof PUT_TERMS,
): PortfolioEventEnvelope =>
  envelope(eventId, at(1, 12), 'main', {
    eventType: 'trade.fill',
    instrumentId,
    side,
    quantity: 1,
    pricePerUnit: 5,
    currency: 'USD',
    contractMultiplier: 100,
    contract,
  });
const FUTURES_FILL = envelope('fut-1', at(1, 12), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'ESH6',
  side: 'buy',
  quantity: 2,
  pricePerUnit: 4_500,
  currency: 'USD',
  contractMultiplier: 50,
  settlementStyle: 'variation-margin',
  contract: { kind: 'future', underlyingInstrumentId: 'SPX', expiryTimestampMs: at(3, 20) },
});

const LEDGER = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_100] });
const LEVERED = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_200] });
const TWO = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_100, BUY_MSFT] });
const LONG_CALL = createPortfolioLedger({
  baseCurrency: 'USD',
  events: [DEPOSIT, optionFill('opt-1', CALL_ID, 'buy', CALL_TERMS)],
});
const SHORT_CALL = createPortfolioLedger({
  baseCurrency: 'USD',
  events: [DEPOSIT, optionFill('opt-1', CALL_ID, 'sell', CALL_TERMS)],
});
const SHORT_PUT = createPortfolioLedger({
  baseCurrency: 'USD',
  events: [DEPOSIT, optionFill('opt-2', PUT_ID, 'sell', PUT_TERMS)],
});
const FUTURES = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, FUTURES_FILL] });

function market(
  asOf: number | string,
  spots: Record<string, { price: number; timestampMs?: number }>,
): MarketSnapshot {
  const observed: Record<string, { price: number; currency: string; timestampMs?: number }> = {};
  for (const [id, spot] of Object.entries(spots)) {
    observed[id] = { currency: 'USD', ...spot };
  }
  return createMarketSnapshot({ asOf, observations: { spots: observed } });
}

const CONCENTRATION: InvestmentPolicy = { limits: { maximumPositionWeight: 0.5 } };

/** One evaluation of the base ledger at `asOf` with AAPL at `price`. */
function evaluate(
  overrides: Partial<MonitorPortfolioInput> & {
    price?: number;
    asOf?: number;
    portfolio?: PortfolioState;
  },
) {
  const { price = 700, asOf = T(1), portfolio = LEDGER.state, ...rest } = overrides;
  return monitorPortfolio({
    portfolio,
    market: market(asOf, { AAPL: { price } }),
    asOf,
    policy: CONCENTRATION,
    previousState: null,
    ...rest,
  });
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const alertsByKey = (alerts: readonly MonitorAlert[]): Record<string, MonitorAlert> =>
  Object.fromEntries(alerts.map((alert) => [alert.key, alert]));

describe('monitorPortfolio — the first evaluation', () => {
  const first = evaluate({ policy: { limits: { maximumDrawdown: 0.1, maximumDailyLoss: 0.1 } } });

  it('values the portfolio and initialises the drawdown peak at the first NAV', () => {
    // NAV = 30,000 cash + 100 × 700 = 100,000.
    expect(first.netAssetValue).toBe(100_000);
    expect(first.state.schemaVersion).toBe(PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION);
    expect(first.state.asOf).toBe(T(1));
    expect(first.state.netAssetValue).toBe(100_000);
    expect(first.state.peakNetAssetValue).toBe(100_000);
    expect(first.state.evaluationCount).toBe(1);
    expect(first.alerts).toEqual([]);
  });

  it('evaluates drawdown at 0 (quiet) and skips daily loss with the first-evaluation reason', () => {
    const drawdown = first.evaluated.find((row) => row.family === 'drawdown')!;
    expect(drawdown.status).toBe('evaluated');
    expect(drawdown.observationCount).toBe(1);
    expect(first.state.rules['drawdown:portfolio']).toEqual({
      active: false,
      consecutiveBreaches: 0,
      lastRaisedAtMs: null,
      acknowledged: false,
      lastValue: 0,
    });
    const daily = first.evaluated.find((row) => row.family === 'daily-loss')!;
    expect(daily.status).toBe('skipped');
    expect(daily.reason).toMatch(/first evaluation/);
  });

  it('lists every family once, in the family order, and declares the deferred ones', () => {
    expect(first.evaluated.map((row) => row.family)).toEqual([...MONITOR_ALERT_FAMILIES]);
    expect(first.diagnostics.unsupportedFamilies.map((entry) => entry.family)).toEqual([
      'dividend-risk',
      'order-status',
      'scenario-loss-change',
    ]);
    const deferred = Object.fromEntries(
      first.diagnostics.unsupportedFamilies.map((entry) => [entry.family, entry.reason]),
    );
    expect(deferred['dividend-risk']).toMatch(/no ex-dividend calendar/);
    expect(deferred['order-status']).toMatch(/execution journal/);
    expect(deferred['scenario-loss-change']).toMatch(/no scenario runner/);
    expect(first.assumptions.liquidityParticipationRate).toBe(0.1);
    expect(typeof first.assumptions.conventions).toBe('string');
    expect(first.assumptions.rulesApplied.drawdown).toEqual({
      enabled: true,
      threshold: 0.1,
      thresholdSource: 'policy',
      direction: 'above',
      hysteresis: null,
      debounceEvaluations: 1,
      cooldownMs: 0,
      severity: 'critical',
    });
  });
});

describe('allocation-drift', () => {
  // AAPL weight 0.7 vs target 0.6 → drift 0.1; cash weight 0.3 vs target 0.4 → drift 0.1.
  const targets: InvestmentPolicy['targets'] = [
    { group: { instrumentId: 'AAPL' }, weight: 0.6 },
    { group: { assetClass: 'cash' }, weight: 0.4 },
  ];

  it('raises for every target outside its band, with the numbers in evidence', () => {
    const result = evaluate({ policy: { targets, driftBand: 0.05 } });
    expect(result.alerts.map((alert) => [alert.key, alert.state])).toEqual([
      ['allocation-drift:AAPL', 'raised'],
      ['allocation-drift:assetClass:cash', 'raised'],
    ]);
    const apple = result.alerts[0]!;
    expect(apple.value).toBeCloseTo(0.1, 12);
    expect(apple.threshold).toBe(0.05);
    expect(apple.direction).toBe('above');
    expect(apple.evidence['currentWeight']).toBeCloseTo(0.7, 12);
    expect(apple.evidence['targetWeight']).toBe(0.6);
    const cash = result.alerts[1]!;
    expect(cash.evidence['currentWeight']).toBeCloseTo(0.3, 12);
    expect(cash.evidence['targetWeight']).toBe(0.4);
    expect(result.diagnostics.raisedCount).toBe(2);
  });

  it('is quiet within the band, and the observations are still counted', () => {
    const result = evaluate({ policy: { targets, driftBand: 0.15 } });
    expect(result.alerts).toEqual([]);
    const row = result.evaluated.find((entry) => entry.family === 'allocation-drift')!;
    expect(row.status).toBe('evaluated');
    expect(row.observationCount).toBe(2);
  });

  it('is skipped without targets, and without any band', () => {
    const noTargets = evaluate({ policy: { driftBand: 0.05 } });
    expect(
      noTargets.evaluated.find((entry) => entry.family === 'allocation-drift')!.reason,
    ).toMatch(/declares no targets/);
    const noBand = evaluate({ policy: { targets } });
    expect(noBand.evaluated.find((entry) => entry.family === 'allocation-drift')!.reason).toMatch(
      /declares no driftBand/,
    );
    expect(noBand.alerts).toEqual([]);
  });
});

describe('concentration-limit', () => {
  it('raises a 0.7 weight against a 0.5 limit with the number in evidence and the message', () => {
    const result = evaluate({});
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('concentration-limit:AAPL');
    expect(alert.state).toBe('raised');
    expect(alert.value).toBeCloseTo(0.7, 12);
    expect(alert.threshold).toBe(0.5);
    expect(alert.severity).toBe('warning');
    expect(alert.evidence['absoluteWeight']).toBeCloseTo(0.7, 12);
    expect(alert.evidence['maximumPositionWeight']).toBe(0.5);
    expect(alert.evidence['baseCurrencyMarketValue']).toBe(70_000);
    expect(alert.message).toContain('0.7');
    expect(alert.message).toContain('0.5');
    expect(result.state.rules['concentration-limit:AAPL']).toEqual({
      active: true,
      consecutiveBreaches: 1,
      lastRaisedAtMs: T(1),
      acknowledged: false,
      lastValue: 0.7,
    });
  });

  it('evaluates group limits through the policy grammar (a tag group of one member)', () => {
    const result = evaluate({
      policy: {
        limits: { maximumGroupWeights: [{ group: { tag: 'tech' }, maximumWeight: 0.6 }] },
      },
      instrumentClassification: { AAPL: { tags: ['tech'] } },
    });
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('concentration-limit:tag:tech');
    expect(alert.value).toBeCloseTo(0.7, 12);
    expect(alert.threshold).toBe(0.6);
    expect(alert.evidence['members']).toBe('AAPL');
  });
});

describe('leverage-limit, margin-pressure, and cash-reserve', () => {
  it('leverage: gross 140,000 ÷ NAV 100,000 = 1.4 against 1.2 is raised', () => {
    const result = evaluate({
      portfolio: LEVERED.state,
      policy: { limits: { maximumGrossLeverage: 1.2 } },
    });
    expect(result.netAssetValue).toBe(100_000);
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('leverage-limit:portfolio');
    expect(alert.value).toBeCloseTo(1.4, 12);
    expect(alert.evidence['grossExposure']).toBe(140_000);
    expect(alert.severity).toBe('critical');
  });

  it('margin pressure: settled cash −40,000 against a floor of 0 is raised (direction below)', () => {
    const result = evaluate({
      portfolio: LEVERED.state,
      policy: { limits: { minimumSettledCash: 0 } },
    });
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('margin-pressure:portfolio');
    expect(alert.direction).toBe('below');
    expect(alert.value).toBe(-40_000);
    expect(alert.threshold).toBe(0);
    expect(alert.evidence['settledCash']).toBe(-40_000);
  });

  it('cash reserve: the larger of minimumCash 40,000 and 0.35 × NAV = 35,000 binds; cash 30,000 is below', () => {
    const result = evaluate({ policy: { minimumCash: 40_000, minimumCashWeight: 0.35 } });
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('cash-reserve:portfolio');
    expect(alert.direction).toBe('below');
    expect(alert.value).toBe(30_000);
    expect(alert.threshold).toBe(40_000);
    expect(alert.evidence['bindingFloor']).toBe('minimumCash');
    expect(alert.evidence['minimumCashFromWeight']).toBeCloseTo(35_000, 9);
    expect(result.assumptions.rulesApplied['cash-reserve'].threshold).toBe(40_000);
    // 25,000 alone: cash 30,000 is not below it.
    expect(evaluate({ policy: { minimumCash: 25_000 } }).alerts).toEqual([]);
  });
});

describe('drawdown and daily-loss across a NAV sequence', () => {
  // 700 → NAV 100,000; 800 → 110,000; 650 → 95,000.
  const policy: InvestmentPolicy = { limits: { maximumDrawdown: 0.1, maximumDailyLoss: 0.1 } };
  const first = evaluate({ policy, price: 700, asOf: T(1) });
  const second = evaluate({ policy, price: 800, asOf: T(2), previousState: first.state });
  const third = evaluate({ policy, price: 650, asOf: T(3), previousState: second.state });

  it('carries the peak through the state', () => {
    expect(first.state.peakNetAssetValue).toBe(100_000);
    expect(second.state.peakNetAssetValue).toBe(110_000);
    expect(third.state.peakNetAssetValue).toBe(110_000);
    expect(third.state.netAssetValue).toBe(95_000);
    expect(third.state.evaluationCount).toBe(3);
  });

  it('a rising NAV raises nothing; daily loss is negative (a gain)', () => {
    expect(second.alerts).toEqual([]);
    // (100,000 − 110,000) ÷ 100,000 = −0.1.
    expect(second.state.rules['daily-loss:portfolio']!.lastValue).toBeCloseTo(-0.1, 12);
  });

  it('drawdown 1 − 95,000 ÷ 110,000 = 0.13636… and daily loss 15,000 ÷ 110,000 = 0.13636… are raised', () => {
    const byKey = alertsByKey(third.alerts);
    expect(Object.keys(byKey)).toEqual(['daily-loss:portfolio', 'drawdown:portfolio']);
    expect(byKey['drawdown:portfolio']!.value).toBeCloseTo(1 - 95_000 / 110_000, 12);
    expect(byKey['drawdown:portfolio']!.value).toBeCloseTo(0.1363636, 6);
    expect(byKey['drawdown:portfolio']!.evidence['peakNetAssetValue']).toBe(110_000);
    expect(byKey['daily-loss:portfolio']!.value).toBeCloseTo(15_000 / 110_000, 12);
    expect(byKey['daily-loss:portfolio']!.evidence['previousNetAssetValue']).toBe(110_000);
    expect(byKey['daily-loss:portfolio']!.evidence['previousAsOf']).toBe(T(2));
    expect(third.diagnostics.raisedCount).toBe(2);
    expect(third.diagnostics.activeCount).toBe(2);
  });
});

describe('stale and missing market data', () => {
  it('a mark observed 2 h before asOf against a 1 h limit is raised with the age in evidence', () => {
    const asOf = T(1);
    const result = monitorPortfolio({
      portfolio: LEDGER.state,
      market: market(asOf, { AAPL: { price: 700, timestampMs: asOf - 2 * HOUR } }),
      asOf,
      policy: {},
      previousState: null,
      marketStalenessLimitMs: HOUR,
    });
    expect(result.netAssetValue).toBe(100_000);
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('stale-market-data:AAPL');
    expect(alert.value).toBe(2 * HOUR);
    expect(alert.threshold).toBe(HOUR);
    expect(alert.evidence['markTimestampMs']).toBe(asOf - 2 * HOUR);
    expect(alert.evidence['markSource']).toBe('spot.timestampMs');
  });

  it('without a limit and with every mark present the family is skipped, never defaulted', () => {
    const result = evaluate({ policy: {} });
    const row = result.evaluated.find((entry) => entry.family === 'stale-market-data')!;
    expect(row.status).toBe('skipped');
    expect(row.reason).toMatch(/marketStalenessLimitMs/);
  });

  it('a missing mark is raised with value null and the weight families are skipped as unvalued', () => {
    // TWO holds AAPL and MSFT; the market carries AAPL only. Cash 100,000 − 70,000 − 20,000 = 10,000.
    const result = evaluate({
      portfolio: TWO.state,
      policy: { limits: { maximumPositionWeight: 0.5, minimumSettledCash: 0 } },
    });
    expect(result.netAssetValue).toBeNull();
    expect(result.state.netAssetValue).toBeNull();
    expect(result.state.peakNetAssetValue).toBeNull();
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('stale-market-data:MSFT');
    expect(alert.state).toBe('raised');
    expect(alert.value).toBeNull();
    expect(alert.evidence['reason']).toMatch(/no observations\.spots\['MSFT'\]/);
    const concentration = result.evaluated.find((entry) => entry.family === 'concentration-limit')!;
    expect(concentration.status).toBe('skipped');
    expect(concentration.reason).toMatch(/^unvalued/);
    expect(concentration.reason).toContain('MSFT');
    // Cash needs no marks: margin pressure still evaluates (settled 10,000 ≥ 0 → quiet).
    const margin = result.evaluated.find((entry) => entry.family === 'margin-pressure')!;
    expect(margin.status).toBe('evaluated');
    expect(result.state.rules['margin-pressure:portfolio']!.lastValue).toBe(10_000);
  });

  it('an unvalued evaluation carries the prior peak and skips daily loss on the next valued one', () => {
    const policy: InvestmentPolicy = { limits: { maximumDrawdown: 0.1, maximumDailyLoss: 0.1 } };
    // Valued: cash 10,000 + 70,000 + 20,000 = 100,000.
    const valued = monitorPortfolio({
      portfolio: TWO.state,
      market: market(T(1), { AAPL: { price: 700 }, MSFT: { price: 400 } }),
      asOf: T(1),
      policy,
      previousState: null,
    });
    expect(valued.netAssetValue).toBe(100_000);
    const unvalued = evaluate({
      portfolio: TWO.state,
      policy,
      asOf: T(2),
      previousState: valued.state,
    });
    expect(unvalued.state.netAssetValue).toBeNull();
    expect(unvalued.state.peakNetAssetValue).toBe(100_000);
    const again = monitorPortfolio({
      portfolio: TWO.state,
      market: market(T(3), { AAPL: { price: 700 }, MSFT: { price: 400 } }),
      asOf: T(3),
      policy,
      previousState: unvalued.state,
    });
    expect(again.evaluated.find((entry) => entry.family === 'daily-loss')!.reason).toMatch(
      /was unvalued/,
    );
    expect(again.state.peakNetAssetValue).toBe(100_000);
  });
});

describe('reconciliation-difference from a real reconcilePortfolio result', () => {
  const external = (quantity: number) => ({
    asOf: T(1),
    accounts: {
      main: { cash: { USD: { total: 30_000 } }, positions: [{ instrumentId: 'AAPL', quantity }] },
    },
  });
  const tolerance = { quantity: 0, cashAmount: 0 };

  it('reconciled === false raises with the counts in evidence', () => {
    const reconciliation = reconcilePortfolio({
      portfolio: LEDGER.state,
      external: external(90),
      asOf: T(1),
      tolerance,
    });
    expect(reconciliation.reconciled).toBe(false);
    const result = evaluate({ policy: {}, reconciliation });
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('reconciliation-difference:portfolio');
    expect(alert.value).toBe(1);
    expect(alert.threshold).toBe(0);
    expect(alert.evidence['differenceCount']).toBe(1);
    expect(alert.evidence['explainedCount']).toBe(0);
    expect(alert.evidence['reconciled']).toBe('false');
  });

  it('a reconciled result is quiet; no result skips the family', () => {
    const reconciliation = reconcilePortfolio({
      portfolio: LEDGER.state,
      external: external(100),
      asOf: T(1),
      tolerance,
    });
    expect(reconciliation.reconciled).toBe(true);
    expect(evaluate({ policy: {}, reconciliation }).alerts).toEqual([]);
    const skipped = evaluate({ policy: {} }).evaluated.find(
      (entry) => entry.family === 'reconciliation-difference',
    )!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toMatch(/no reconciliation result/);
  });
});

describe('unexplained-residual and unusual-pnl from a real portfolioPnl result', () => {
  // 02-01 mark: AAPL 700 → NAV 100,000. 03-01 mark: AAPL 800 → NAV 110,000.
  // Unrealized +10,000 is the whole P&L; residual 0.
  const pnl = portfolioPnl({
    ledger: LEDGER,
    from: { valuationDate: '2026-02-01', market: market('2026-02-01', { AAPL: { price: 700 } }) },
    to: { valuationDate: '2026-03-01', market: market('2026-03-01', { AAPL: { price: 800 } }) },
  });
  const asOf = Date.UTC(2026, 2, 1, 16);

  it('the fixture P&L is as computed', () => {
    expect(pnl.components.totalPnl).toBeCloseTo(10_000, 9);
    expect(Math.abs(pnl.residual)).toBeLessThan(1e-9);
  });

  it('unusual P&L: 10,000 ÷ NAV 110,000 = 0.0909… against 0.05 is raised', () => {
    const result = evaluate({ policy: {}, price: 800, asOf, pnl, unusualPnlThreshold: 0.05 });
    expect(result.netAssetValue).toBe(110_000);
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.key).toBe('unusual-pnl:portfolio');
    expect(alert.value).toBeCloseTo(10_000 / 110_000, 12);
    expect(alert.evidence['totalPnl']).toBeCloseTo(10_000, 9);
    expect(alert.evidence['netAssetValue']).toBe(110_000);
  });

  it('unexplained residual: |25| against a tolerance of 10 is raised; the real 0 is quiet', () => {
    const edited = { ...pnl, residual: 25 };
    const result = evaluate({ policy: {}, price: 800, asOf, pnl: edited, residualTolerance: 10 });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.key).toBe('unexplained-residual:portfolio');
    expect(result.alerts[0]!.value).toBe(25);
    expect(result.alerts[0]!.threshold).toBe(10);
    const quiet = evaluate({ policy: {}, price: 800, asOf, pnl, residualTolerance: 1e-6 });
    expect(quiet.alerts).toEqual([]);
  });

  it('without a tolerance or threshold the families are skipped, never defaulted', () => {
    const result = evaluate({ policy: {}, price: 800, asOf, pnl });
    const reasons = Object.fromEntries(result.evaluated.map((row) => [row.family, row.reason]));
    expect(reasons['unexplained-residual']).toMatch(/residualTolerance/);
    expect(reasons['unusual-pnl']).toMatch(/unusualPnlThreshold/);
    expect(result.alerts).toEqual([]);
  });
});

describe('liquidity', () => {
  it('days to liquidate = |quantity| ÷ (volume × 0.1): 100 ÷ (50 × 0.1) = 20 days against 10', () => {
    const result = evaluate({
      policy: { limits: { maximumDaysToLiquidate: 10 } },
      averageDailyVolumes: { AAPL: 50 },
    });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.key).toBe('liquidity:AAPL');
    expect(result.alerts[0]!.value).toBeCloseTo(20, 12);
    expect(result.alerts[0]!.evidence['participationRate']).toBe(0.1);
  });

  it('is skipped without volumes, and a missing instrument volume is a warning', () => {
    const skipped = evaluate({ policy: { limits: { maximumDaysToLiquidate: 10 } } });
    expect(skipped.evaluated.find((row) => row.family === 'liquidity')!.reason).toMatch(
      /averageDailyVolumes/,
    );
    const missing = evaluate({
      policy: { limits: { maximumDaysToLiquidate: 10 } },
      averageDailyVolumes: { MSFT: 1_000 },
    });
    expect(missing.alerts).toEqual([]);
    expect(
      missing.diagnostics.warnings.some((w) => /no averageDailyVolumes entry for AAPL/.test(w)),
    ).toBe(true);
  });
});

describe('the rule state machine', () => {
  it('hysteresis enter 0.05 / exit 0.02: 0.06 raises, 0.03 stays active, 0.01 clears', () => {
    // Peak 100,000: 640 → 94,000 (dd 0.06); 670 → 97,000 (0.03); 690 → 99,000 (0.01).
    const policy: InvestmentPolicy = { limits: { maximumDrawdown: 0.05 } };
    const rules = { drawdown: { hysteresis: { enter: 0.05, exit: 0.02 } } };
    const e1 = evaluate({ policy, rules, price: 700, asOf: T(1) });
    expect(e1.alerts).toEqual([]);
    const e2 = evaluate({ policy, rules, price: 640, asOf: T(2), previousState: e1.state });
    expect(e2.alerts.map((a) => [a.key, a.state])).toEqual([['drawdown:portfolio', 'raised']]);
    expect(e2.alerts[0]!.value).toBeCloseTo(0.06, 12);
    expect(e2.alerts[0]!.threshold).toBe(0.05);
    const e3 = evaluate({ policy, rules, price: 670, asOf: T(3), previousState: e2.state });
    expect(e3.alerts.map((a) => [a.key, a.state])).toEqual([['drawdown:portfolio', 'active']]);
    expect(e3.alerts[0]!.value).toBeCloseTo(0.03, 12);
    expect(e3.alerts[0]!.threshold).toBe(0.02);
    expect(e3.alerts[0]!.evidence['enterThreshold']).toBe(0.05);
    expect(e3.alerts[0]!.evidence['exitThreshold']).toBe(0.02);
    const e4 = evaluate({ policy, rules, price: 690, asOf: T(4), previousState: e3.state });
    expect(e4.alerts.map((a) => [a.key, a.state])).toEqual([['drawdown:portfolio', 'cleared']]);
    expect(e4.alerts[0]!.value).toBeCloseTo(0.01, 12);
    expect(e4.state.rules['drawdown:portfolio']!.active).toBe(false);
    expect(e4.diagnostics.clearedCount).toBe(1);
    expect(e4.assumptions.rulesApplied.drawdown.thresholdSource).toBe('rule');
  });

  it('debounce 2: the first breach is quiet with consecutiveBreaches 1, the second raises', () => {
    const rules = { 'concentration-limit': { debounceEvaluations: 2 } };
    const e1 = evaluate({ rules, asOf: T(1) });
    expect(e1.alerts).toEqual([]);
    expect(e1.state.rules['concentration-limit:AAPL']).toMatchObject({
      active: false,
      consecutiveBreaches: 1,
      lastRaisedAtMs: null,
    });
    const e2 = evaluate({ rules, asOf: T(2), previousState: e1.state });
    expect(e2.alerts.map((a) => a.state)).toEqual(['raised']);
    expect(e2.state.rules['concentration-limit:AAPL']).toMatchObject({
      active: true,
      consecutiveBreaches: 2,
      lastRaisedAtMs: T(2),
    });
  });

  it('cooldown: a re-breach inside the window is suppressed, after it is raised', () => {
    // AAPL 300 → NAV 60,000, weight exactly 0.5 — not above 0.5, so the alert clears.
    const rules = { 'concentration-limit': { cooldownMs: 24 * HOUR } };
    const e1 = evaluate({ rules, price: 700, asOf: T(1) });
    expect(e1.alerts.map((a) => a.state)).toEqual(['raised']);
    const e2 = evaluate({ rules, price: 300, asOf: T(1) + HOUR, previousState: e1.state });
    expect(e2.alerts.map((a) => a.state)).toEqual(['cleared']);
    const e3 = evaluate({ rules, price: 700, asOf: T(1) + 2 * HOUR, previousState: e2.state });
    expect(e3.alerts.map((a) => a.state)).toEqual(['suppressed']);
    expect(e3.state.rules['concentration-limit:AAPL']!.active).toBe(false);
    expect(e3.state.rules['concentration-limit:AAPL']!.lastRaisedAtMs).toBe(T(1));
    expect(e3.diagnostics.suppressedCount).toBe(1);
    const e4 = evaluate({ rules, price: 700, asOf: T(1) + 30 * HOUR, previousState: e3.state });
    expect(e4.alerts.map((a) => a.state)).toEqual(['raised']);
    expect(e4.state.rules['concentration-limit:AAPL']!.lastRaisedAtMs).toBe(T(1) + 30 * HOUR);
  });

  it('acknowledgment holds until the rule clears; a re-entry is raised afresh', () => {
    const key = 'concentration-limit:AAPL';
    const e1 = evaluate({ asOf: T(1) });
    expect(e1.alerts.map((a) => a.state)).toEqual(['raised']);
    const e2 = evaluate({ asOf: T(2), previousState: e1.state, acknowledgments: [key] });
    expect(e2.alerts.map((a) => a.state)).toEqual(['acknowledged']);
    expect(e2.state.rules[key]!.acknowledged).toBe(true);
    expect(e2.diagnostics.acknowledgedCount).toBe(1);
    const e3 = evaluate({ asOf: T(3), previousState: e2.state });
    expect(e3.alerts.map((a) => a.state)).toEqual(['acknowledged']);
    const e4 = evaluate({ asOf: T(4), price: 300, previousState: e3.state });
    expect(e4.alerts.map((a) => a.state)).toEqual(['cleared']);
    expect(e4.state.rules[key]!.acknowledged).toBe(false);
    const e5 = evaluate({ asOf: T(5), price: 700, previousState: e4.state });
    expect(e5.alerts.map((a) => a.state)).toEqual(['raised']);
  });

  it('an acknowledgment for a rule that is not active is a warning, not a refusal', () => {
    const result = evaluate({ acknowledgments: ['drawdown:portfolio'] });
    expect(result.diagnostics.warnings.some((w) => /'drawdown:portfolio'/.test(w))).toBe(true);
  });

  it('a subject that vanishes clears: selling the position clears its concentration alert', () => {
    const e1 = evaluate({ asOf: T(1) });
    expect(e1.alerts.map((a) => a.state)).toEqual(['raised']);
    const flat = LEDGER.apply([
      envelope('fill-9', T(5, 10), 'main', {
        eventType: 'trade.fill',
        instrumentId: 'AAPL',
        side: 'sell',
        quantity: 100,
        pricePerUnit: 700,
        currency: 'USD',
      }),
    ]);
    const e2 = evaluate({ asOf: T(5), portfolio: flat.state, previousState: e1.state });
    expect(e2.netAssetValue).toBe(100_000);
    expect(e2.alerts).toHaveLength(1);
    expect(e2.alerts[0]!.key).toBe('concentration-limit:AAPL');
    expect(e2.alerts[0]!.state).toBe('cleared');
    expect(e2.alerts[0]!.value).toBeNull();
    expect(e2.alerts[0]!.evidence['lastValue']).toBe(0.7);
    expect(e2.state.rules['concentration-limit:AAPL']).toBeUndefined();
  });

  it('a skipped family carries its active rules forward unevaluated, with a warning', () => {
    const e1 = evaluate({ asOf: T(1) });
    const e2 = evaluate({
      asOf: T(2),
      previousState: e1.state,
      rules: { 'concentration-limit': { enabled: false } },
    });
    expect(e2.alerts).toEqual([]);
    expect(e2.state.rules['concentration-limit:AAPL']).toEqual(
      e1.state.rules['concentration-limit:AAPL'],
    );
    expect(e2.diagnostics.activeCount).toBe(1);
    expect(e2.diagnostics.warnings.some((w) => /carried forward unevaluated/.test(w))).toBe(true);
    expect(e2.evaluated.find((row) => row.family === 'concentration-limit')!.reason).toMatch(
      /enabled is false/,
    );
  });
});

describe('the replay law and the result contract', () => {
  const policy: InvestmentPolicy = {
    limits: { maximumDrawdown: 0.05, maximumDailyLoss: 0.05, maximumPositionWeight: 0.5 },
  };
  const rules = {
    drawdown: { hysteresis: { enter: 0.05, exit: 0.02 } },
    // 72 h: the re-breach at T(3)+2h is 50 h after the T(1) raise (suppressed); T(5) is 96 h after (raised).
    'concentration-limit': { cooldownMs: 72 * HOUR },
  };
  const recorded = [
    { asOf: T(1), price: 700 },
    { asOf: T(2), price: 640 },
    { asOf: T(3), price: 670 },
    { asOf: T(3) + HOUR, price: 300 },
    { asOf: T(3) + 2 * HOUR, price: 700 },
    { asOf: T(5), price: 690 },
  ];
  const replay = (roundTrip: boolean) => {
    const alerts: MonitorAlert[][] = [];
    const states: PortfolioMonitorState[] = [];
    let previousState: PortfolioMonitorState | null = null;
    for (const step of recorded) {
      const result = evaluate({ policy, rules, ...step, previousState });
      alerts.push([...result.alerts]);
      states.push(result.state);
      previousState = roundTrip
        ? (JSON.parse(JSON.stringify(result.state)) as PortfolioMonitorState)
        : result.state;
    }
    return { alerts, states };
  };

  it('a recorded stream of inputs reproduces the same alerts and states, twice and through JSON', () => {
    const first = replay(false);
    const second = replay(false);
    const viaJson = replay(true);
    expect(second.alerts).toEqual(first.alerts);
    expect(second.states).toEqual(first.states);
    expect(viaJson.alerts).toEqual(first.alerts);
    expect(viaJson.states).toEqual(first.states);
    // The stream did something: drawdown raised, stayed active, and cleared; concentration was suppressed.
    const states = first.alerts.flat().map((alert) => `${alert.key}=${alert.state}`);
    expect(states).toContain('drawdown:portfolio=raised');
    expect(states).toContain('drawdown:portfolio=active');
    expect(states).toContain('drawdown:portfolio=cleared');
    expect(states).toContain('concentration-limit:AAPL=suppressed');
  });

  it('alerts are sorted by key and the result is deeply frozen', () => {
    const result = evaluate({
      policy: { ...policy, minimumCash: 40_000 },
      portfolio: LEDGER.state,
      price: 650,
      asOf: T(2),
      previousState: evaluate({ policy, asOf: T(1) }).state,
    });
    const keys = result.alerts.map((alert) => alert.key);
    expect(keys).toEqual([...keys].sort());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.alerts)).toBe(true);
    expect(Object.isFrozen(result.alerts[0])).toBe(true);
    expect(Object.isFrozen(result.alerts[0]!.evidence)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.rules)).toBe(true);
    expect(Object.isFrozen(result.state.rules['drawdown:portfolio'])).toBe(true);
    expect(Object.isFrozen(result.assumptions.rulesApplied)).toBe(true);
    expect(typeof result.assumptions.conventionsVersion).toBe('string');
  });

  it('an empty policy skips every family with a reason naming the missing goal, raising nothing', () => {
    const result = evaluate({ policy: {} });
    expect(result.alerts).toEqual([]);
    expect(result.evaluated.every((row) => row.status === 'skipped')).toBe(true);
    for (const row of result.evaluated) expect(typeof row.reason).toBe('string');
    const reasons = Object.fromEntries(result.evaluated.map((row) => [row.family, row.reason!]));
    expect(reasons['concentration-limit']).toMatch(/maximumPositionWeight/);
    expect(reasons['leverage-limit']).toMatch(/maximumGrossLeverage/);
    expect(reasons['drawdown']).toMatch(/maximumDrawdown/);
    expect(reasons['daily-loss']).toMatch(/maximumDailyLoss/);
    expect(reasons['cash-reserve']).toMatch(/minimumCash/);
    expect(reasons['margin-pressure']).toMatch(/minimumSettledCash/);
    expect(reasons['liquidity']).toMatch(/maximumDaysToLiquidate/);
    expect(reasons['option-expiration']).toMatch(/optionExpirationWarningDays/);
    expect(reasons['assignment-risk']).toMatch(/assignmentRiskMoneyness/);
    expect(result.state.rules).toEqual({});
  });
});

describe('notional exposure and the option-lifecycle families (slice 5)', () => {
  /** One evaluation of `portfolio` at `asOf` with the given USD spots; policy `{}` unless overridden. */
  const evaluateWith = (
    portfolio: PortfolioState,
    spots: Record<string, { price: number }>,
    asOf: number,
    rest: Partial<MonitorPortfolioInput> = {},
  ) =>
    monitorPortfolio({
      portfolio,
      market: market(asOf, spots),
      asOf,
      policy: {},
      previousState: null,
      ...rest,
    });
  /** 2026-02-15 15:00 UTC — exactly 5 days before the 2026-02-20 15:00 UTC expiry. */
  const FIVE_DAYS_OUT = at(2, 15);
  const CALL_SPOTS = { [CALL_ID]: { price: 6 }, AAPL: { price: 210 } };

  it('option-expiration: 5 days to a 2026-02-20 expiry is raised against 7 warning days and quiet against 3, the contract in evidence', () => {
    const raised = evaluateWith(LONG_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT, {
      optionExpirationWarningDays: 7,
    });
    // NAV = 99,500 cash + 1 × 6 × 100 = 100,100.
    expect(raised.netAssetValue).toBe(100_100);
    expect(raised.alerts.map((a) => [a.key, a.state])).toEqual([
      [`option-expiration:${CALL_ID}`, 'raised'],
    ]);
    const alert = raised.alerts[0]!;
    expect(alert.value).toBe(5);
    expect(alert.threshold).toBe(7);
    expect(alert.direction).toBe('below');
    expect(alert.severity).toBe('warning');
    expect(alert.evidence).toMatchObject({
      expiryDate: '2026-02-20',
      expiryTimestampMs: at(2, 20),
      daysToExpiry: 5,
      quantity: 1,
      contractMultiplier: 100,
      type: 'call',
      strikePricePerUnit: 200,
      underlyingInstrumentId: 'AAPL',
      underlyingMark: 210,
      optionExpirationWarningDays: 7,
    });
    expect(alert.message).toContain('expires in 5 days');
    expect(alert.message).toContain('AAPL call 200 expiring 2026-02-20');
    const quiet = evaluateWith(LONG_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT, {
      optionExpirationWarningDays: 3,
    });
    expect(quiet.alerts).toEqual([]);
    expect(quiet.evaluated.find((row) => row.family === 'option-expiration')).toEqual({
      family: 'option-expiration',
      status: 'evaluated',
      observationCount: 1,
    });
    expect(quiet.state.rules[`option-expiration:${CALL_ID}`]!.lastValue).toBe(5);
    expect(quiet.assumptions.rulesApplied['option-expiration']).toEqual({
      enabled: true,
      threshold: 3,
      thresholdSource: 'input',
      direction: 'below',
      hysteresis: null,
      debounceEvaluations: 1,
      cooldownMs: 0,
      severity: 'warning',
    });
  });

  it('past expiry the days are negative and the message says so; an absent underlying mark is null evidence, never a crash', () => {
    // 2026-02-25 15:00 UTC is 5 days after expiry; the market marks the option only.
    const result = evaluateWith(LONG_CALL.state, { [CALL_ID]: { price: 0.01 } }, at(2, 25), {
      optionExpirationWarningDays: 7,
    });
    expect(result.alerts.map((a) => [a.key, a.state])).toEqual([
      [`option-expiration:${CALL_ID}`, 'raised'],
    ]);
    expect(result.alerts[0]!.value).toBe(-5);
    expect(result.alerts[0]!.evidence['daysToExpiry']).toBe(-5);
    expect(result.alerts[0]!.evidence['underlyingMark']).toBeNull();
    expect(result.alerts[0]!.message).toMatch(/expired 5 days before asOf/);
  });

  it('assignment-risk: a short 200 call with AAPL at 210 is 0.05 in the money against 0.02; at 195 it is out of the money and quiet', () => {
    const itm = evaluateWith(
      SHORT_CALL.state,
      { [CALL_ID]: { price: 12 }, AAPL: { price: 210 } },
      FIVE_DAYS_OUT,
      { assignmentRiskMoneyness: 0.02 },
    );
    // NAV = 100,500 cash − 1 × 12 × 100 = 99,300.
    expect(itm.netAssetValue).toBe(99_300);
    expect(itm.alerts.map((a) => [a.key, a.state])).toEqual([
      [`assignment-risk:${CALL_ID}`, 'raised'],
    ]);
    const alert = itm.alerts[0]!;
    // (210 − 200) ÷ 200 = 0.05.
    expect(alert.value).toBeCloseTo(0.05, 12);
    expect(alert.threshold).toBe(0.02);
    expect(alert.direction).toBe('above');
    expect(alert.evidence).toMatchObject({
      underlyingInstrumentId: 'AAPL',
      underlyingMark: 210,
      strikePricePerUnit: 200,
      type: 'call',
      daysToExpiry: 5,
      expiryDate: '2026-02-20',
      quantity: -1,
      contractMultiplier: 100,
      assignmentRiskMoneyness: 0.02,
      reason: null,
    });
    expect(alert.evidence['moneyness']).toBeCloseTo(0.05, 12);
    expect(alert.message).toContain('0.05 in the money at AAPL 210');
    const otm = evaluateWith(
      SHORT_CALL.state,
      { [CALL_ID]: { price: 2 }, AAPL: { price: 195 } },
      FIVE_DAYS_OUT,
      { assignmentRiskMoneyness: 0.02 },
    );
    expect(otm.alerts).toEqual([]);
    // (195 − 200) ÷ 200 = −0.025.
    expect(otm.state.rules[`assignment-risk:${CALL_ID}`]!.lastValue).toBeCloseTo(-0.025, 12);
  });

  it('a short put measures (K − S) ÷ K: AAPL at 190 against a 200 put is 0.05 in the money', () => {
    const result = evaluateWith(
      SHORT_PUT.state,
      { [PUT_ID]: { price: 12 }, AAPL: { price: 190 } },
      FIVE_DAYS_OUT,
      { assignmentRiskMoneyness: 0.02 },
    );
    expect(result.alerts.map((a) => a.key)).toEqual([`assignment-risk:${PUT_ID}`]);
    expect(result.alerts[0]!.value).toBeCloseTo(0.05, 12);
    expect(result.alerts[0]!.evidence['type']).toBe('put');
    expect(result.alerts[0]!.message).toContain('AAPL put 200');
  });

  it('a long option is never at risk of assignment; a short option whose underlying has no mark is raised with value null', () => {
    const long = evaluateWith(LONG_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT, {
      assignmentRiskMoneyness: 0.02,
    });
    expect(long.alerts).toEqual([]);
    expect(long.evaluated.find((row) => row.family === 'assignment-risk')).toEqual({
      family: 'assignment-risk',
      status: 'evaluated',
      observationCount: 0,
    });
    const unmarked = evaluateWith(SHORT_CALL.state, { [CALL_ID]: { price: 12 } }, FIVE_DAYS_OUT, {
      assignmentRiskMoneyness: 0.02,
    });
    // The option itself is marked, so the portfolio IS valued; only the underlying is missing.
    expect(unmarked.netAssetValue).toBe(99_300);
    expect(unmarked.alerts).toHaveLength(1);
    const alert = unmarked.alerts[0]!;
    expect(alert.key).toBe(`assignment-risk:${CALL_ID}`);
    expect(alert.state).toBe('raised');
    expect(alert.value).toBeNull();
    expect(alert.evidence['moneyness']).toBeNull();
    expect(alert.evidence['underlyingMark']).toBeNull();
    expect(alert.evidence['reason']).toMatch(/no observations\.spots\['AAPL'\]/);
    expect(alert.message).toContain('cannot be measured for assignment risk');
    // The stale-market-data family itself stays quiet: every HELD instrument is marked.
    expect(unmarked.evaluated.find((row) => row.family === 'stale-market-data')!.status).toBe(
      'skipped',
    );
  });

  it('a futures overlay: concentration and leverage measure the notional 452,000 while NAV carries only the 2,000 unsettled P&L', () => {
    const result = evaluateWith(FUTURES.state, { ESH6: { price: 4_520 } }, T(1), {
      policy: {
        limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 2 },
        minimumCash: 50_000,
      },
    });
    // NAV = cash 100,000 + (4,520 − 4,500) × 2 × 50 = 102,000; notional = 2 × 4,520 × 50 = 452,000.
    expect(result.netAssetValue).toBe(102_000);
    const byKey = alertsByKey(result.alerts);
    expect(Object.keys(byKey)).toEqual(['concentration-limit:ESH6', 'leverage-limit:portfolio']);
    const concentration = byKey['concentration-limit:ESH6']!;
    expect(concentration.value).toBeCloseTo(452_000 / 102_000, 12);
    expect(concentration.value).toBeCloseTo(4.431372549, 8);
    expect(concentration.evidence['baseCurrencyNotionalValue']).toBe(452_000);
    expect(concentration.evidence['baseCurrencyMarketValue']).toBe(2_000);
    expect(concentration.evidence['settlementStyle']).toBe('variation-margin');
    expect(concentration.evidence['netAssetValue']).toBe(102_000);
    expect(concentration.message).toContain('by notional');
    const leverage = byKey['leverage-limit:portfolio']!;
    expect(leverage.value).toBeCloseTo(452_000 / 102_000, 12);
    expect(leverage.evidence['grossExposure']).toBe(452_000);
    expect(leverage.evidence['longExposure']).toBe(452_000);
    expect(leverage.evidence['exposureBasis']).toBe('baseCurrencyNotionalValue');
    // The cash family stays on cash: 100,000 against a 50,000 floor is quiet.
    expect(result.state.rules['cash-reserve:portfolio']!.lastValue).toBe(100_000);
    expect(result.assumptions.conventions).toContain('NOTIONAL');
    expect(result.assumptions.conventions).toMatch(/futures overlay/);
  });

  it('allocation drift weighs a futures overlay by its notional: 4.4314 against a target of 1 drifts 3.4314', () => {
    // On market value the weight would be 2,000 ÷ 102,000 = 0.0196 (drift 0.98) — inside a band of 2.
    const targets: InvestmentPolicy['targets'] = [{ group: { instrumentId: 'ESH6' }, weight: 1 }];
    const result = evaluateWith(FUTURES.state, { ESH6: { price: 4_520 } }, T(1), {
      policy: { targets, driftBand: 2 },
    });
    expect(result.alerts.map((a) => [a.key, a.state])).toEqual([
      ['allocation-drift:ESH6', 'raised'],
    ]);
    expect(result.alerts[0]!.evidence['currentWeight']).toBeCloseTo(452_000 / 102_000, 12);
    expect(result.alerts[0]!.value).toBeCloseTo(452_000 / 102_000 - 1, 12);
  });

  it('both families are skipped with a reason without an input; a rule threshold declares the goal instead', () => {
    const skipped = evaluateWith(SHORT_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT);
    const reasons = Object.fromEntries(skipped.evaluated.map((row) => [row.family, row.reason]));
    expect(reasons['option-expiration']).toMatch(/no optionExpirationWarningDays supplied/);
    expect(reasons['assignment-risk']).toMatch(/no assignmentRiskMoneyness supplied/);
    expect(skipped.alerts).toEqual([]);
    expect(skipped.state.rules).toEqual({});
    const ruled = evaluateWith(SHORT_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT, {
      rules: { 'option-expiration': { threshold: 7 }, 'assignment-risk': { threshold: 0.02 } },
    });
    expect(ruled.alerts.map((a) => a.key)).toEqual([
      `assignment-risk:${CALL_ID}`,
      `option-expiration:${CALL_ID}`,
    ]);
    expect(ruled.assumptions.rulesApplied['option-expiration']).toMatchObject({
      threshold: 7,
      thresholdSource: 'rule',
      direction: 'below',
    });
    expect(ruled.assumptions.rulesApplied['assignment-risk']).toMatchObject({
      threshold: 0.02,
      thresholdSource: 'rule',
      direction: 'above',
    });
    const disabled = evaluateWith(SHORT_CALL.state, CALL_SPOTS, FIVE_DAYS_OUT, {
      optionExpirationWarningDays: 7,
      rules: { 'option-expiration': { enabled: false } },
    });
    expect(disabled.evaluated.find((row) => row.family === 'option-expiration')!.reason).toMatch(
      /enabled is false/,
    );
  });

  it('the contract-term families evaluate while the portfolio is unvalued (the option itself unmarked)', () => {
    // No mark for the option: stale-market-data raises, the weight families skip, but expiry and
    // assignment risk need only the contract terms and the UNDERLYING's mark.
    const result = evaluateWith(SHORT_CALL.state, { AAPL: { price: 210 } }, FIVE_DAYS_OUT, {
      policy: { limits: { maximumPositionWeight: 0.5 } },
      optionExpirationWarningDays: 7,
      assignmentRiskMoneyness: 0.02,
    });
    expect(result.netAssetValue).toBeNull();
    expect(result.alerts.map((a) => a.key)).toEqual([
      `assignment-risk:${CALL_ID}`,
      `option-expiration:${CALL_ID}`,
      `stale-market-data:${CALL_ID}`,
    ]);
    expect(result.evaluated.find((row) => row.family === 'concentration-limit')!.status).toBe(
      'skipped',
    );
  });

  it('the replay law holds through the option families: a recorded stream raises, holds, and clears', () => {
    // Days to expiry 10 → 8 → 6 → 4 against 7; moneyness −0.025 → 0.05 → 0.025 → −0.05 against 0.02.
    const recorded = [
      { asOf: at(2, 10), price: 195 },
      { asOf: at(2, 12), price: 210 },
      { asOf: at(2, 14), price: 205 },
      { asOf: at(2, 16), price: 190 },
    ];
    const replay = (roundTrip: boolean) => {
      const alerts: MonitorAlert[][] = [];
      const states: PortfolioMonitorState[] = [];
      let previousState: PortfolioMonitorState | null = null;
      for (const step of recorded) {
        const result = evaluateWith(
          SHORT_CALL.state,
          { [CALL_ID]: { price: 6 }, AAPL: { price: step.price } },
          step.asOf,
          { previousState, optionExpirationWarningDays: 7, assignmentRiskMoneyness: 0.02 },
        );
        alerts.push([...result.alerts]);
        states.push(result.state);
        previousState = roundTrip
          ? (JSON.parse(JSON.stringify(result.state)) as PortfolioMonitorState)
          : result.state;
      }
      return { alerts, states };
    };
    const first = replay(false);
    const second = replay(false);
    const viaJson = replay(true);
    expect(second.alerts).toEqual(first.alerts);
    expect(second.states).toEqual(first.states);
    expect(viaJson.alerts).toEqual(first.alerts);
    expect(viaJson.states).toEqual(first.states);
    expect(first.alerts.map((step) => step.map((alert) => `${alert.key}=${alert.state}`))).toEqual([
      [],
      [`assignment-risk:${CALL_ID}=raised`],
      [`assignment-risk:${CALL_ID}=active`, `option-expiration:${CALL_ID}=raised`],
      [`assignment-risk:${CALL_ID}=cleared`, `option-expiration:${CALL_ID}=active`],
    ]);
    expect(first.states[3]!.rules[`option-expiration:${CALL_ID}`]!.lastValue).toBe(4);
  });
});

describe('typed refusals', () => {
  const code = (fn: () => unknown, expected: string, pattern?: RegExp) => {
    const error = caught(fn);
    expect(isQuantError(error, expected), String(error)).toBe(true);
    if (pattern !== undefined) expect((error as Error).message).toMatch(pattern);
  };

  it('unknown keys at every level, with the did-you-mean teaching', () => {
    code(
      () => evaluate({ polcy: CONCENTRATION } as never),
      'input.unknown_field',
      /did you mean "policy"/,
    );
    code(
      () => evaluate({ rules: { drawdwon: {} } as never }),
      'input.unknown_field',
      /did you mean "drawdown"/,
    );
    code(
      () => evaluate({ rules: { drawdown: { treshold: 0.1 } } as never }),
      'input.unknown_field',
      /did you mean "threshold"/,
    );
    code(
      () => evaluate({ rules: { drawdown: { hysteresis: { enter: 0.1, exits: 0.05 } } } as never }),
      'input.unknown_field',
      /did you mean "exit"/,
    );
    const state = evaluate({}).state;
    code(
      () => evaluate({ asOf: T(2), previousState: { ...state, peak: 1 } as never }),
      'input.unknown_field',
      /previousState/,
    );
    code(
      () =>
        evaluate({
          asOf: T(2),
          previousState: {
            ...state,
            rules: {
              'concentration-limit:AAPL': {
                ...state.rules['concentration-limit:AAPL'],
                acknowleged: true,
              },
            },
          } as never,
        }),
      'input.unknown_field',
      /did you mean "acknowledged"/,
    );
  });

  it('a missing previousState key is a refusal that names the reset it would cause', () => {
    const { previousState: _omitted, ...rest } = {
      portfolio: LEDGER.state,
      market: market(T(1), { AAPL: { price: 700 } }),
      asOf: T(1),
      policy: CONCENTRATION,
      previousState: null,
    };
    code(() => monitorPortfolio(rest as never), 'input.missing_field', /previousState is required/);
  });

  it('previousState.asOf at or after asOf is a refusal (evaluations move forward)', () => {
    const state = evaluate({ asOf: T(2) }).state;
    code(() => evaluate({ asOf: T(2), previousState: state }), 'input.out_of_range', /before asOf/);
    code(() => evaluate({ asOf: T(1), previousState: state }), 'input.out_of_range', /before asOf/);
  });

  it('a previousState from another schema, or with corrupt counters, is refused', () => {
    const state = evaluate({}).state;
    code(
      () => evaluate({ asOf: T(2), previousState: { ...state, schemaVersion: 2 } }),
      'snapshot.unsupported_version',
    );
    code(
      () => evaluate({ asOf: T(2), previousState: { ...state, evaluationCount: 1.5 } }),
      'input.out_of_range',
    );
    code(
      () => evaluate({ asOf: T(2), previousState: { ...state, netAssetValue: Infinity } }),
      'input.not_finite',
    );
    code(
      () =>
        evaluate({
          asOf: T(2),
          previousState: {
            ...state,
            rules: { 'nonsense:AAPL': state.rules['concentration-limit:AAPL']! },
          },
        }),
      'input.out_of_range',
      /rule identity/,
    );
  });

  it('bad rule mechanics: a literal, a negative cooldown, a fractional debounce, an inverted hysteresis', () => {
    code(
      () => evaluate({ rules: { drawdown: { direction: 'up' as never } } }),
      'input.out_of_range',
      /'above', 'below'/,
    );
    code(
      () => evaluate({ rules: { drawdown: { severity: 'fatal' as never } } }),
      'input.out_of_range',
    );
    code(() => evaluate({ rules: { drawdown: { cooldownMs: -1 } } }), 'input.out_of_range', /≥ 0/);
    code(
      () => evaluate({ rules: { drawdown: { debounceEvaluations: 1.5 } } }),
      'input.out_of_range',
      /safe integer ≥ 1/,
    );
    code(() => evaluate({ rules: { drawdown: { debounceEvaluations: 0 } } }), 'input.out_of_range');
    code(
      () => evaluate({ rules: { drawdown: { hysteresis: { enter: 0.02, exit: 0.05 } } } }),
      'input.out_of_range',
      /must be ≤ enter/,
    );
    code(
      () =>
        evaluate({
          rules: { drawdown: { threshold: 0.1, hysteresis: { enter: 0.05, exit: 0.02 } } },
        }),
      'input.out_of_range',
      /both threshold and hysteresis/,
    );
  });

  it('asOf and policy are required; companion results must belong to this portfolio', () => {
    code(
      () =>
        monitorPortfolio({
          portfolio: LEDGER.state,
          market: market(T(1), { AAPL: { price: 700 } }),
          policy: {},
          previousState: null,
        } as never),
      'input.missing_field',
      /asOf is required/,
    );
    code(
      () =>
        monitorPortfolio({
          portfolio: LEDGER.state,
          market: market(T(1), { AAPL: { price: 700 } }),
          asOf: T(1),
          previousState: null,
        } as never),
      'input.missing_field',
      /policy is required/,
    );
    const reconciliation = reconcilePortfolio({
      portfolio: LEDGER.state,
      external: { asOf: T(1), accounts: {} },
      asOf: T(1),
      tolerance: { quantity: 0, cashAmount: 0 },
    });
    code(
      () => evaluate({ reconciliation: { ...reconciliation, baseCurrency: 'EUR' } }),
      'input.out_of_range',
      /base currency/,
    );
    code(() => evaluate({ asOf: T(1) - HOUR, reconciliation }), 'input.out_of_range', /after asOf/);
    code(
      () => evaluate({ averageDailyVolumes: { AAPL: 0 } }),
      'input.out_of_range',
      /averageDailyVolumes\['AAPL'\]/,
    );
    code(() => evaluate({ marketStalenessLimitMs: -1 }), 'input.out_of_range');
  });

  it('the option-family inputs: negative warning days, non-finite or non-numeric moneyness', () => {
    code(
      () => evaluate({ optionExpirationWarningDays: -1 }),
      'input.out_of_range',
      /optionExpirationWarningDays must be ≥ 0/,
    );
    code(() => evaluate({ optionExpirationWarningDays: Infinity }), 'input.not_finite');
    code(() => evaluate({ assignmentRiskMoneyness: NaN }), 'input.not_finite');
    code(() => evaluate({ assignmentRiskMoneyness: '0.02' as never }), 'input.wrong_type');
    // A negative moneyness bound is a valid goal (alert while still out of the money).
    expect(evaluate({ assignmentRiskMoneyness: -0.05 }).alerts.map((a) => a.family)).toEqual([
      'concentration-limit',
    ]);
    code(
      () => evaluate({ rules: { 'assignment-risk': { treshold: 0.02 } } as never }),
      'input.unknown_field',
      /did you mean "threshold"/,
    );
  });
});
