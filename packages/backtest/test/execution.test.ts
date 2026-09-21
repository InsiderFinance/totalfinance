/**
 * Stage 4.6 slice 1 — pluggable execution reality: the honest default, declared overrides, the
 * three fill models over bar / quote / order-book observations, the four intrabar ambiguity
 * policies over one bar, the small cost models, the margin helpers, the conformance suite, and
 * the bridge from a fill decision to the ledger's NormalizedFill.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { brokers } from '@totalfinance/backtest';
import {
  assertFillModelConformance,
  barTriggerPrice,
  describeExecutionPolicy,
  execution,
  fees,
  fillModels,
  impactModels,
  latencyModels,
  maintenanceMarginBreached,
  normalizedFillFromDecision,
  orderTouchSequence,
  requiredInitialMargin,
  slippage,
  spreadModels,
  type FillContext,
  type FillModel,
  type OrderIntent,
} from '@totalfinance/backtest/execution';
import { portfolioEventsFromFill } from '@totalfinance/portfolio';

const T0 = Date.UTC(2026, 0, 5, 14, 30);

function context(overrides: Partial<FillContext> = {}): FillContext {
  return {
    asOf: T0,
    partialFills: 'allow',
    staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
    lockedCrossed: 'fill-at-mid',
    queue: { model: 'depth-approximation' },
    ...overrides,
  };
}

function order(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    orderId: 'o-1',
    instrumentId: 'XYZ',
    side: 'buy',
    quantity: 100,
    type: 'market',
    submittedTimestampMs: T0 - 1,
    ...overrides,
  };
}

const bar = {
  symbol: 'XYZ',
  timestampMs: T0,
  open: 100,
  high: 104,
  low: 97,
  close: 102,
  volume: 1_000,
};
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('the honest default and declared policies', () => {
  it('simplified() names every member in its label and its description says realism: simplified', () => {
    const policy = execution.simplified();
    expect(policy.realism).toBe('simplified');
    expect(policy.label).toContain('no spread, impact, latency, or borrow');
    expect(Object.isFrozen(policy)).toBe(true);
    const described = describeExecutionPolicy(policy);
    expect(described).toMatchObject({
      realism: 'simplified',
      observation: 'bar',
      ambiguity: 'deterministic-path',
      costs: {
        commission: 'none',
        slippage: 'none',
        spread: null,
        marketImpact: null,
        latencySessions: null,
        participation: null,
        borrow: null,
      },
      margin: { buyingPowerMultiplier: 1, forcedLiquidation: 'none' },
      queue: 'none',
    });
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });

  it('declared() overrides only what is given, requires a label, and validates every member', () => {
    const policy = execution.declared({
      label: 'quote fills, 2 bps half-spread, 30 s freshness',
      observation: 'quote',
      costs: {
        spread: spreadModels.halfSpreadBps(2),
        commission: fees.bps(1),
        participation: 0.25,
      },
      staleQuotes: { maximumAgeMs: 30_000, behavior: 'reject' },
      margin: {
        buyingPowerMultiplier: 2,
        initialMarginRate: 0.5,
        maintenanceMarginRate: 0.25,
        forcedLiquidation: 'close-largest-loss',
      },
    });
    expect(policy.realism).toBe('declared');
    expect(policy.fill.observation).toBe('quote');
    expect(policy.costs.slippage.label).toBe('none');
    expect(describeExecutionPolicy(policy).costs).toMatchObject({
      spread: 'half-spread 2 bps',
      participation: 0.25,
    });
    expect(codeOf(() => execution.declared({ label: '' }))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => execution.declared({ label: 'x', ambiguity: 'random' as never }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(
      codeOf(() =>
        execution.declared({ label: 'x', observation: 'quote', fill: fillModels.bar() }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => execution.declared({ label: 'x', observation: 'trade' }))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(codeOf(() => execution.declared({ label: 'x', costs: { participation: 1.5 } }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() =>
        execution.declared({
          label: 'x',
          margin: {
            buyingPowerMultiplier: 1,
            initialMarginRate: 0.2,
            maintenanceMarginRate: 0.3,
            forcedLiquidation: 'none',
          },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        execution.declared({
          label: 'x',
          sessions: { halts: [{ fromTimestampMs: 5, toTimestampMs: 5 }] },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => execution.declared({ label: 'x', extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });
});

describe('bar fill model — the SimulatedBroker touch rules, verbatim', () => {
  const model = fillModels.bar();
  const cases: Array<[Partial<OrderIntent>, number | null, string?]> = [
    [{ type: 'market' }, 100, 'bar.open'],
    [{ type: 'market-on-close' }, 102, 'bar.close'],
    [{ type: 'limit', limitPrice: 99 }, 99, 'bar.touch:limit'],
    [{ type: 'limit', limitPrice: 101 }, 100, 'bar.open'], // open already through the limit
    [{ type: 'limit', limitPrice: 96 }, null],
    [{ type: 'stop', stopPrice: 103 }, 103, 'bar.touch:stop'],
    [{ type: 'stop', stopPrice: 99 }, 100, 'bar.touch:stop'], // gapped through: fills at the open
    [{ type: 'stop', stopPrice: 105 }, null],
    [{ side: 'sell', type: 'stop', stopPrice: 98 }, 98, 'bar.touch:stop'],
    [{ type: 'stop-limit', stopPrice: 103, limitPrice: 103.5 }, 103, 'bar.touch:stop-limit'],
    [{ type: 'stop-limit', stopPrice: 103, limitPrice: 102 }, 102, 'bar.touch:limit'], // triggered at 103, the bar's low reached the limit
  ];
  it.each(cases)('%j → %s', (overrides, price, reference) => {
    const decision = model.fill({
      order: order(overrides),
      observation: { kind: 'bar', bar },
      context: context(),
    });
    if (price === null) expect(decision).toEqual({ outcome: 'unfilled', reason: 'not-triggered' });
    else
      expect(decision).toMatchObject({
        outcome: 'filled',
        pricePerUnit: price,
        reference,
        quantity: 100,
        partial: false,
      });
  });

  it('agrees with the shipped broker on every archetype', () => {
    for (const [overrides, price] of cases) {
      if (overrides.type === 'market-on-close' || overrides.type === 'market-on-open') continue;
      const broker = brokers.simulated({ cash: 1_000_000 });
      const o = order(overrides);
      broker.submit({
        symbol: o.instrumentId,
        side: o.side,
        quantity: o.quantity,
        type: o.type,
        ...(o.limitPrice !== undefined ? { limitPrice: o.limitPrice } : {}),
        ...(o.stopPrice !== undefined ? { stopPrice: o.stopPrice } : {}),
      });
      const trades = broker.processBar(bar);
      expect(trades[0]?.price ?? null).toBe(price);
    }
  });

  it('applies participation caps, partial-fill policy, halts, and price limits', () => {
    const capped = model.fill({
      order: order(),
      observation: { kind: 'bar', bar },
      context: context({ participation: 0.05 }),
    });
    expect(capped).toMatchObject({ outcome: 'filled', quantity: 50, partial: true });
    expect(
      model.fill({
        order: order(),
        observation: { kind: 'bar', bar },
        context: context({ participation: 0.05, partialFills: 'reject' }),
      }),
    ).toEqual({ outcome: 'unfilled', reason: 'insufficient-depth' });
    const halted = model.fill({
      order: order(),
      observation: { kind: 'bar', bar },
      context: context({
        sessions: {
          halts: [{ instrumentId: 'XYZ', fromTimestampMs: T0 - 1, toTimestampMs: T0 + 1 }],
        },
      }),
    });
    expect(halted).toEqual({ outcome: 'unfilled', reason: 'halted' });
    const limited = model.fill({
      order: order({ type: 'stop', stopPrice: 103 }),
      observation: { kind: 'bar', bar },
      context: context({
        sessions: {
          priceLimits: [
            {
              instrumentId: 'XYZ',
              fromTimestampMs: T0 - 1,
              toTimestampMs: T0 + 1,
              low: 95,
              high: 101,
            },
          ],
        },
      }),
    });
    expect(limited).toMatchObject({
      outcome: 'filled',
      pricePerUnit: 101,
      clampedToPriceLimit: true,
    });
    expect(
      model.fill({
        order: order(),
        observation: { kind: 'quote', quote: { symbol: 'XYZ', timestampMs: T0, bid: 1, ask: 2 } },
        context: context(),
      }),
    ).toMatchObject({ outcome: 'unfilled', reason: 'wrong-observation-kind' });
    expect(barTriggerPrice({ order: order({ type: 'limit', limitPrice: 99 }), bar })).toEqual({
      price: 99,
      reference: 'bar.touch:limit',
    });
  });
});

describe('quote fill model — sides, freshness, locked and crossed markets', () => {
  const model = fillModels.quote();
  const quote = {
    symbol: 'XYZ',
    timestampMs: T0 - 5_000,
    bid: 99.9,
    ask: 100.1,
    bidSize: 300,
    askSize: 200,
  };
  it('buys at the ask and sells at the bid; limits fill when marketable; stops trigger on the touch side', () => {
    expect(
      model.fill({ order: order(), observation: { kind: 'quote', quote }, context: context() }),
    ).toMatchObject({
      pricePerUnit: 100.1,
      reference: 'quote.ask',
    });
    expect(
      model.fill({
        order: order({ side: 'sell' }),
        observation: { kind: 'quote', quote },
        context: context(),
      }),
    ).toMatchObject({
      pricePerUnit: 99.9,
      reference: 'quote.bid',
    });
    expect(
      model.fill({
        order: order({ type: 'limit', limitPrice: 100.05 }),
        observation: { kind: 'quote', quote },
        context: context(),
      }),
    ).toEqual({ outcome: 'unfilled', reason: 'not-triggered' });
    expect(
      model.fill({
        order: order({ type: 'limit', limitPrice: 100.2 }),
        observation: { kind: 'quote', quote },
        context: context(),
      }),
    ).toMatchObject({ pricePerUnit: 100.1 });
    expect(
      model.fill({
        order: order({ type: 'stop', stopPrice: 100.05 }),
        observation: { kind: 'quote', quote },
        context: context(),
      }),
    ).toMatchObject({ pricePerUnit: 100.1 });
    expect(
      model.fill({
        order: order({ type: 'stop', stopPrice: 100.5 }),
        observation: { kind: 'quote', quote },
        context: context(),
      }),
    ).toEqual({ outcome: 'unfilled', reason: 'not-triggered' });
  });
  it('a stale quote fills-at-last with the staleness named, or refuses with backtest.stale_quote', () => {
    const stale = context({ staleQuotes: { maximumAgeMs: 1_000, behavior: 'fill-at-last' } });
    expect(
      model.fill({ order: order(), observation: { kind: 'quote', quote }, context: stale }),
    ).toMatchObject({
      reference: 'quote.ask:stale',
    });
    expect(
      codeOf(() =>
        model.fill({
          order: order(),
          observation: { kind: 'quote', quote },
          context: context({ staleQuotes: { maximumAgeMs: 1_000, behavior: 'reject' } }),
        }),
      ),
    ).toBe(ErrorCode.BacktestStaleQuote);
  });
  it('locked and crossed quotes fill at mid or are refused, per policy; sizes cap partial fills', () => {
    const crossed = { ...quote, bid: 100.2 };
    expect(
      model.fill({
        order: order(),
        observation: { kind: 'quote', quote: crossed },
        context: context(),
      }),
    ).toMatchObject({
      pricePerUnit: (100.2 + 100.1) / 2,
      reference: 'quote.mid',
    });
    expect(
      model.fill({
        order: order(),
        observation: { kind: 'quote', quote: crossed },
        context: context({ lockedCrossed: 'reject' }),
      }),
    ).toMatchObject({ outcome: 'unfilled', reason: 'locked-crossed' });
    expect(
      model.fill({
        order: order({ quantity: 1_000 }),
        observation: { kind: 'quote', quote },
        context: context({ participation: 0.5 }),
      }),
    ).toMatchObject({ quantity: 100, partial: true });
  });
});

describe('order-book fill model — walking the levels', () => {
  const model = fillModels.orderBook();
  const book = {
    symbol: 'XYZ',
    timestampMs: T0,
    bids: [
      { price: 99.9, size: 200 },
      { price: 99.8, size: 300 },
    ],
    asks: [
      { price: 100.1, size: 150 },
      { price: 100.2, size: 250 },
    ],
  };
  it('averages across consumed levels and reports how many it consumed', () => {
    const decision = model.fill({
      order: order({ quantity: 200 }),
      observation: { kind: 'order-book', book },
      context: context(),
    });
    expect(decision).toMatchObject({
      outcome: 'filled',
      quantity: 200,
      levelsConsumed: 2,
      partial: false,
      reference: 'book.levels',
    });
    expect((decision as { pricePerUnit: number }).pricePerUnit).toBeCloseTo(
      (150 * 100.1 + 50 * 100.2) / 200,
      12,
    );
  });
  it('without depth approximation only the best level fills; a limit stops the walk; depth runs out honestly', () => {
    expect(
      model.fill({
        order: order({ quantity: 200 }),
        observation: { kind: 'order-book', book },
        context: context({ queue: { model: 'none' } }),
      }),
    ).toMatchObject({ quantity: 150, partial: true, levelsConsumed: 1 });
    expect(
      model.fill({
        order: order({ quantity: 200, type: 'limit', limitPrice: 100.1 }),
        observation: { kind: 'order-book', book },
        context: context(),
      }),
    ).toMatchObject({ quantity: 150, partial: true });
    expect(
      model.fill({
        order: order({ quantity: 200, type: 'limit', limitPrice: 100 }),
        observation: { kind: 'order-book', book },
        context: context(),
      }),
    ).toEqual({ outcome: 'unfilled', reason: 'not-triggered' });
    expect(
      model.fill({
        order: order({ quantity: 1_000 }),
        observation: { kind: 'order-book', book },
        context: context({ partialFills: 'reject' }),
      }),
    ).toMatchObject({ outcome: 'unfilled', reason: 'insufficient-depth' });
    expect(
      model.fill({
        order: order({ side: 'sell', quantity: 100 }),
        observation: { kind: 'order-book', book },
        context: context(),
      }),
    ).toMatchObject({ pricePerUnit: 99.9 });
  });
});

describe('orderTouchSequence — the four ambiguity policies', () => {
  const upBar = { open: 100, high: 104, low: 97, close: 102 };
  const touches = [
    { orderId: 'take-profit', triggerPrice: 103, favorable: true },
    { orderId: 'stop-loss', triggerPrice: 98, favorable: false },
  ];
  it('touches on one side of the open are never ambiguous; nearer the open fills first', () => {
    const r = orderTouchSequence({
      bar: upBar,
      touches: [
        { orderId: 'a', triggerPrice: 103, favorable: true },
        { orderId: 'b', triggerPrice: 101, favorable: true },
      ],
      policy: 'reject',
    });
    expect(r).toMatchObject({ sequence: ['b', 'a'], path: 'unambiguous', ambiguous: false });
  });
  it('deterministic-path walks low first on an up bar and high first on a down bar', () => {
    expect(orderTouchSequence({ bar: upBar, touches, policy: 'deterministic-path' })).toMatchObject(
      { sequence: ['stop-loss', 'take-profit'], path: 'open-low-high-close', ambiguous: true },
    );
    expect(
      orderTouchSequence({ bar: { ...upBar, close: 99 }, touches, policy: 'deterministic-path' }),
    ).toMatchObject({ sequence: ['take-profit', 'stop-loss'], path: 'open-high-low-close' });
  });
  it('optimistic fills the favorable side first, pessimistic the unfavorable, reject refuses with the orders named', () => {
    expect(orderTouchSequence({ bar: upBar, touches, policy: 'optimistic' }).sequence).toEqual([
      'take-profit',
      'stop-loss',
    ]);
    expect(orderTouchSequence({ bar: upBar, touches, policy: 'pessimistic' }).sequence).toEqual([
      'stop-loss',
      'take-profit',
    ]);
    let caught: { code?: string; message?: string } | undefined;
    try {
      orderTouchSequence({ bar: upBar, touches, policy: 'reject' });
    } catch (error) {
      caught = error as { code?: string; message?: string };
    }
    expect(caught?.code).toBe(ErrorCode.BacktestAmbiguousIntrabar);
    expect(caught?.message).toContain('take-profit');
    expect(caught?.message).toContain('stop-loss');
  });
  it('teaches: a touch outside the bar, a repeated order id, an unknown policy', () => {
    expect(
      codeOf(() =>
        orderTouchSequence({
          bar: upBar,
          touches: [{ orderId: 'a', triggerPrice: 110, favorable: true }],
          policy: 'optimistic',
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        orderTouchSequence({
          bar: upBar,
          touches: [
            { orderId: 'a', triggerPrice: 101, favorable: true },
            { orderId: 'a', triggerPrice: 99, favorable: false },
          ],
          policy: 'optimistic',
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() => orderTouchSequence({ bar: upBar, touches, policy: 'coin-flip' as never })),
    ).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('cost and margin helpers', () => {
  it('spread, impact, latency, and slippage models are labeled and finite', () => {
    expect(
      spreadModels.halfSpreadBps(2).halfSpread({ referencePrice: 100, side: 'buy' }),
    ).toBeCloseTo(0.02, 12);
    expect(spreadModels.none().halfSpread({ referencePrice: 100, side: 'sell' })).toBe(0);
    const impact = impactModels.squareRoot({ coefficient: 0.1 });
    expect(
      impact.impact({ quantity: 10_000, referencePrice: 100, averageDailyVolume: 1_000_000 }),
    ).toBeCloseTo(0.01, 12);
    expect(impact.impact({ quantity: 10_000, referencePrice: 100 })).toBe(0);
    expect(latencyModels.sessions(1)).toEqual({ label: 'latency 1 session', sessions: 1 });
    expect(codeOf(() => latencyModels.sessions(1.5))).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => spreadModels.halfSpreadBps(-1))).toBeDefined();
    expect(slippage.bps(5).label).toContain('5');
  });
  it('initial margin and maintenance breach follow the policy', () => {
    const policy = {
      buyingPowerMultiplier: 2,
      initialMarginRate: 0.5,
      maintenanceMarginRate: 0.25,
      forcedLiquidation: 'none' as const,
    };
    expect(requiredInitialMargin({ notional: 10_000, policy })).toBe(5_000);
    expect(maintenanceMarginBreached({ equity: 2_000, grossNotional: 10_000, policy })).toEqual({
      breached: true,
      requiredEquity: 2_500,
      shortfall: 500,
    });
    expect(maintenanceMarginBreached({ equity: 3_000, grossNotional: 10_000, policy })).toEqual({
      breached: false,
      requiredEquity: 2_500,
      shortfall: 0,
    });
  });
});

describe('conformance and the fill → ledger bridge', () => {
  it('every built-in model passes the suite, and the checks are named', () => {
    for (const model of [fillModels.bar(), fillModels.quote(), fillModels.orderBook()]) {
      const result = assertFillModelConformance({ fillModel: model });
      expect(result.conformant).toBe(true);
      expect(result.fixturesRun).toBeGreaterThanOrEqual(10);
      expect(result.checks).toContain('determinism');
      expect(result.checks).toContain('price-within-observation');
      expect(result.checks).toContain('immutability');
    }
  });
  it('a model that fills outside its observation, mutates inputs, or is non-deterministic is refused by name', () => {
    const outside: FillModel = {
      label: 'outside',
      version: '1',
      observation: 'bar',
      fill: ({ order: o }) => ({
        outcome: 'filled',
        quantity: o.quantity,
        pricePerUnit: 1e9,
        reference: 'x',
        partial: false,
      }),
    };
    let caught = codeOf(() => assertFillModelConformance({ fillModel: outside }));
    expect(caught).toBe(ErrorCode.BacktestAdapterNonconformant);
    let calls = 0;
    const flaky: FillModel = {
      label: 'flaky',
      version: '1',
      observation: 'bar',
      fill: ({ order: o, observation: obs }) => ({
        outcome: 'filled',
        quantity: o.quantity,
        pricePerUnit: obs.kind === 'bar' ? obs.bar.open + (calls++ % 2) * 0.5 : 0,
        reference: 'x',
        partial: false,
      }),
    };
    caught = codeOf(() => assertFillModelConformance({ fillModel: flaky }));
    expect(caught).toBe(ErrorCode.BacktestAdapterNonconformant);
    const mutating: FillModel = {
      label: 'mutating',
      version: '1',
      observation: 'bar',
      fill: ({ order: o, observation: obs }) => {
        (o as { quantity: number }).quantity = 1;
        return {
          outcome: 'filled',
          quantity: 1,
          pricePerUnit: obs.kind === 'bar' ? obs.bar.open : 0,
          reference: 'x',
          partial: true,
        };
      },
    };
    expect(codeOf(() => assertFillModelConformance({ fillModel: mutating }))).toBe(
      ErrorCode.BacktestAdapterNonconformant,
    );
    expect(
      codeOf(() =>
        assertFillModelConformance({
          fillModel: {
            label: '',
            version: '1',
            observation: 'bar',
            fill: () => ({ outcome: 'unfilled', reason: 'not-triggered' }),
          },
        }),
      ),
    ).toBe(ErrorCode.BacktestAdapterNonconformant);
  });
  it('a filled decision becomes the portfolio-owned NormalizedFill and folds through the ledger bridge', () => {
    const decision = fillModels
      .bar()
      .fill({ order: order(), observation: { kind: 'bar', bar }, context: context() });
    const fill = normalizedFillFromDecision({
      decision,
      order: order(),
      accountId: 'main',
      currency: 'USD',
      filledTimestampMs: T0,
      costs: { commission: 1 },
    });
    expect(fill).toMatchObject({
      fillId: 'o-1:fill',
      orderId: 'o-1',
      quantity: 100,
      pricePerUnit: 100,
      side: 'buy',
      instrumentId: 'XYZ',
    });
    const events = portfolioEventsFromFill({
      fill,
      sourceId: 'backtest:test',
      recordedTimestampMs: T0,
    });
    expect(events.map((e) => e.eventType)).toEqual(['trade.fill', 'cost.charge']);
    expect(
      codeOf(() =>
        normalizedFillFromDecision({
          decision: { outcome: 'unfilled', reason: 'not-triggered' },
          order: order(),
          accountId: 'main',
          currency: 'USD',
          filledTimestampMs: T0,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});

describe('closed guards — null is not omission, unknown keys and wrong types teach', () => {
  it('execution.declared refuses a present null member and a nested unknown key', () => {
    expect(codeOf(() => execution.declared({ label: 'x', ambiguity: null as never }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => execution.declared({ label: 'x', margin: null as never }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => execution.declared({ label: 'x', staleQuotes: null as never }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() => execution.declared({ label: 'x', queue: { model: 'fifo' } as never })),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() => execution.declared({ label: 'x', costs: { commission: null } as never })),
    ).toBe(ErrorCode.InputWrongType);
  });
  it('barTriggerPrice, describeExecutionPolicy, normalizedFillFromDecision, and the conformance suite refuse malformed inputs', () => {
    expect(codeOf(() => barTriggerPrice({ order: order(), bar, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => barTriggerPrice({ order: order({ type: 'limit' }), bar }))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(codeOf(() => barTriggerPrice({ order: order({ side: 'long' as never }), bar }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => barTriggerPrice({ order: order(), bar: { ...bar, low: 105 } }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() => barTriggerPrice({ order: order(), bar: { ...bar, close: Number.NaN } })),
    ).toBe(ErrorCode.InputNotFinite);
    const policy = execution.simplified();
    expect(codeOf(() => describeExecutionPolicy({ ...policy, realism: 'exact' as never }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => describeExecutionPolicy({ ...policy, margin: null as never }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => describeExecutionPolicy({ ...policy, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    const decision = {
      outcome: 'filled' as const,
      quantity: 100,
      pricePerUnit: 100,
      reference: 'bar.open',
      partial: false,
    };
    expect(
      codeOf(() =>
        normalizedFillFromDecision({
          decision,
          order: order(),
          accountId: 'main',
          currency: 'USD',
          filledTimestampMs: T0,
          costs: null as never,
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        normalizedFillFromDecision({
          decision: { ...decision, partial: 'no' as never },
          order: order(),
          accountId: 'main',
          currency: 'USD',
          filledTimestampMs: T0,
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        normalizedFillFromDecision({
          decision,
          order: { ...order(), quantity: Number.NaN },
          accountId: 'main',
          currency: 'USD',
          filledTimestampMs: T0,
        }),
      ),
    ).toBe(ErrorCode.InputNotFinite);
    expect(
      codeOf(() =>
        assertFillModelConformance({ fillModel: fillModels.bar(), fixtures: null as never }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        assertFillModelConformance({
          fillModel: fillModels.bar(),
          fixtures: [
            {
              order: order(),
              observation: { kind: 'bar', bar },
              context: { ...context(), partialFills: 'maybe' },
            },
          ] as never,
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        requiredInitialMargin({
          notional: 1,
          policy: {
            buyingPowerMultiplier: 1,
            initialMarginRate: 1,
            maintenanceMarginRate: 0,
            forcedLiquidation: 'none',
            extra: 1,
          } as never,
        }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});
