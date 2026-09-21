/**
 * FC7 slice 4 — `allocatePortfolio`: target weights to executable quantities. Every number is
 * hand-computed in a comment beside the assertion.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { allocatePortfolio, type AllocatePortfolioInput } from '../src/allocation.js';
import { createModelPortfolio } from '../src/policy-grammar.js';
import type { CurrencyPairQuote } from '../src/index.js';

function expectCode(fn: () => unknown, code: string, fragment?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a throw with code ${code}`).toBeDefined();
  expect(
    isQuantError(thrown, code),
    `expected code ${code}, got ${(thrown as Error).message}`,
  ).toBe(true);
  if (fragment !== undefined) expect((thrown as Error).message).toContain(fragment);
}

const AS_OF = '2026-08-29';
const AS_OF_MS = Date.UTC(2026, 7, 29);

const SIXTY_THIRTY_TEN = {
  targets: [
    { group: { instrumentId: 'SPY' }, weight: 0.6 },
    { group: { instrumentId: 'AGG' }, weight: 0.3 },
    { group: { assetClass: 'cash' }, weight: 0.1 },
  ],
};

const PRICES = { SPY: { price: 150, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } };

function base(overrides: Partial<AllocatePortfolioInput> = {}): AllocatePortfolioInput {
  return {
    policy: SIXTY_THIRTY_TEN,
    asOf: AS_OF,
    baseCurrency: 'USD',
    netAssetValue: 100_000,
    prices: PRICES,
    defaultLotSize: 1,
    ...overrides,
  };
}

describe('allocatePortfolio — exact sizing, rounding, dust, and cash, every figure hand-computed', () => {
  it('allocates 100,000 to 60/30/10 at 150/100 with lot size 1: 400 / 300 shares and 10,000 cash', () => {
    const plan = allocatePortfolio(base());
    // SPY: 0.6 × 100_000 = 60_000 ÷ 150 = 400; AGG: 0.3 × 100_000 = 30_000 ÷ 100 = 300.
    expect(plan.asOf).toBe(AS_OF_MS);
    expect(plan.allocations.map((row) => row.instrumentId)).toEqual(['AGG', 'SPY']);
    const spy = plan.allocations.find((row) => row.instrumentId === 'SPY')!;
    const agg = plan.allocations.find((row) => row.instrumentId === 'AGG')!;
    expect(spy.targetNotional).toBe(60_000);
    expect(spy.targetQuantity).toBe(400);
    expect(spy.tradeQuantity).toBe(400);
    expect(spy.tradeNotional).toBe(60_000);
    expect(spy.roundingResidualNotional).toBe(0);
    expect(spy.achievedWeight).toBeCloseTo(0.6, 12);
    expect(spy.lotSize).toBe(1);
    expect(spy.sourceGroups).toEqual(['instrumentId:SPY']);
    expect(spy.implied).toBe(false);
    expect(agg.targetQuantity).toBe(300);
    expect(plan.trades).toEqual([
      {
        instrumentId: 'AGG',
        side: 'buy',
        quantity: 300,
        estimatedNotional: 30_000,
        currency: 'USD',
        estimatedCost: 0,
      },
      {
        instrumentId: 'SPY',
        side: 'buy',
        quantity: 400,
        estimatedNotional: 60_000,
        currency: 'USD',
        estimatedCost: 0,
      },
    ]);
    // Cash: intended = 0 reserve + 0.1 × 100_000 = 10_000; post-trade = 100_000 − 90_000 = 10_000.
    expect(plan.cash).toEqual({
      targetWeight: 0.1,
      reserve: 0,
      targetAmount: 10_000,
      residualAmount: 0,
      achievedWeight: 0.1,
    });
    // Turnover = (60_000 + 30_000) ÷ 100_000.
    expect(plan.turnover).toBeCloseTo(0.9, 12);
    expect(plan.estimatedTransactionCost).toBe(0);
    expect(plan.unresolved).toEqual([]);
    expect(plan.feasible).toBe(true);
    expect(plan.assumptions.targetSource).toBe('inline');
    expect(plan.assumptions.currencyConversionsUsed).toEqual([]);
    expect(plan.diagnostics).toEqual({
      warnings: [],
      instrumentCount: 2,
      tradeCount: 2,
      dustCount: 0,
      unresolvedCount: 0,
    });
  });

  it('sizes an open instrument identity even when its key is __proto__', () => {
    const prices = JSON.parse('{"__proto__":{"price":10,"currency":"USD"}}') as Record<
      string,
      { price: number; currency: string }
    >;
    const lotSizes = JSON.parse('{"__proto__":2}') as Record<string, number>;
    const plan = allocatePortfolio({
      policy: { targets: [{ group: { instrumentId: '__proto__' }, weight: 1 }] },
      asOf: AS_OF,
      baseCurrency: 'USD',
      netAssetValue: 100,
      prices,
      lotSizes,
    });
    expect(plan.feasible).toBe(true);
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]).toMatchObject({
      instrumentId: '__proto__',
      targetQuantity: 10,
      lotSize: 2,
    });
    expect(plan.trades[0]).toMatchObject({ instrumentId: '__proto__', quantity: 10 });
    expect(Object.prototype).not.toHaveProperty('price');
  });

  it('rounds TOWARD ZERO to a 100-share lot and leaves the residual in cash', () => {
    const plan = allocatePortfolio(
      base({
        policy: {
          targets: [
            { group: { instrumentId: 'SPY' }, weight: 0.61 },
            { group: { instrumentId: 'AGG' }, weight: 0.29 },
            { group: { assetClass: 'cash' }, weight: 0.1 },
          ],
        },
        defaultLotSize: 100,
      }),
    );
    // SPY: 61_000 ÷ 150 = 406.67 → 400 lots-of-100 → residual (406.67 − 400) × 150 = 1_000.
    // AGG: 29_000 ÷ 100 = 290 → 200 → residual 90 × 100 = 9_000.
    const spy = plan.allocations.find((row) => row.instrumentId === 'SPY')!;
    const agg = plan.allocations.find((row) => row.instrumentId === 'AGG')!;
    expect(spy.targetQuantity).toBe(400);
    expect(spy.roundingResidualNotional).toBeCloseTo(1_000, 9);
    expect(agg.targetQuantity).toBe(200);
    expect(agg.roundingResidualNotional).toBeCloseTo(9_000, 9);
    // Cash: post-trade = 100_000 − 60_000 − 20_000 = 20_000; intended 10_000; residual 10_000.
    expect(plan.cash.targetAmount).toBe(10_000);
    expect(plan.cash.residualAmount).toBeCloseTo(10_000, 9);
    expect(plan.cash.achievedWeight).toBeCloseTo(0.2, 12);
    expect(plan.feasible).toBe(true);
    expect(plan.assumptions.rounding).toContain('TOWARD ZERO');
    expect(plan.assumptions.rounding).toContain('defaultLotSize 100');
  });

  it('rounds a SHORT target toward zero too, and reports the under-raised cash as an infeasible intended-cash shortfall', () => {
    const plan = allocatePortfolio(
      base({
        policy: {
          targets: [
            { group: { instrumentId: 'SPY' }, weight: 0.6 },
            { group: { instrumentId: 'AGG' }, weight: -0.3 },
            { group: { assetClass: 'cash' }, weight: 0.7 },
          ],
        },
        prices: { SPY: { price: 150, currency: 'USD' }, AGG: { price: 110, currency: 'USD' } },
        lotSizes: { AGG: 100 },
      }),
    );
    // AGG: −30_000 ÷ 110 = −272.73 → toward zero in 100-lots = −200; residual (−272.73 + 200) × 110 = −8_000.
    const agg = plan.allocations.find((row) => row.instrumentId === 'AGG')!;
    expect(agg.targetQuantity).toBe(-200);
    expect(agg.tradeQuantity).toBe(-200);
    expect(agg.roundingResidualNotional).toBeCloseTo(-8_000, 9);
    expect(plan.trades.find((t) => t.instrumentId === 'AGG')).toMatchObject({
      side: 'sell',
      quantity: 200,
      estimatedNotional: 22_000,
    });
    // Cash: post-trade = 100_000 − 60_000 + 22_000 = 62_000; intended = 70_000 → residual −8_000.
    expect(plan.cash.residualAmount).toBeCloseTo(-8_000, 9);
    expect(plan.feasible).toBe(false);
    expect(plan.diagnostics.warnings.join('\n')).toContain('nothing was scaled');
  });

  it('leaves a quantity fractional when neither lotSizes nor defaultLotSize covers it, and says so', () => {
    // No defaultLotSize at all (the key is absent, not undefined): only AGG has a lot size.
    const { defaultLotSize: _omitted, ...withoutDefault } = base({
      policy: {
        targets: [
          { group: { instrumentId: 'SPY' }, weight: 0.61 },
          { group: { instrumentId: 'AGG' }, weight: 0.29 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
      },
      lotSizes: { AGG: 1 },
    });
    const plan = allocatePortfolio(withoutDefault);
    const spy = plan.allocations.find((row) => row.instrumentId === 'SPY')!;
    // 61_000 ÷ 150 = 406.666…
    expect(spy.lotSize).toBeNull();
    expect(spy.targetQuantity).toBeCloseTo(406.6666666666667, 9);
    expect(spy.roundingResidualNotional).toBe(0);
    expect(plan.assumptions.rounding).toContain('Neither covers SPY');
  });

  it('skips a trade below minimumNotional as dust, keeps the instrument at its current quantity, and reports the cash effect', () => {
    const plan = allocatePortfolio(
      base({ currentHoldings: { SPY: 399, AGG: 300 }, minimumNotional: 500 }),
    );
    // SPY trade = 400 − 399 = 1 share × 150 = 150 < 500 → dust; AGG trade = 0.
    const spy = plan.allocations.find((row) => row.instrumentId === 'SPY')!;
    expect(spy.dust).toBe(true);
    expect(spy.tradeQuantity).toBe(0);
    expect(spy.currentQuantity).toBe(399);
    expect(spy.achievedWeight).toBeCloseTo(0.5985, 12); // 399 × 150 ÷ 100_000
    expect(plan.trades).toEqual([]);
    expect(plan.dust).toHaveLength(1);
    expect(plan.dust[0]).toMatchObject({ instrumentId: 'SPY', tradeNotional: 150 });
    expect(plan.dust[0]!.reason).toContain('below minimumNotional 500');
    // Cash: current = 100_000 − 59_850 − 30_000 = 10_150; nothing trades; intended 10_000 → residual 150.
    expect(plan.cash.residualAmount).toBeCloseTo(150, 9);
    expect(plan.turnover).toBe(0);
    expect(plan.diagnostics.dustCount).toBe(1);
    expect(plan.feasible).toBe(true);
  });

  it('prices a non-base-currency instrument through a conversion quote and echoes the quote used', () => {
    const EURUSD: CurrencyPairQuote = {
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      quotePerBase: 1.08,
    };
    const plan = allocatePortfolio(
      base({
        policy: {
          targets: [
            { group: { instrumentId: 'SPY' }, weight: 0.6 },
            { group: { instrumentId: 'SAP' }, weight: 0.3 },
            { group: { assetClass: 'cash' }, weight: 0.1 },
          ],
        },
        prices: { SPY: { price: 150, currency: 'USD' }, SAP: { price: 100, currency: 'EUR' } },
        currencyConversions: [EURUSD],
      }),
    );
    // SAP: 100 EUR × 1.08 = 108 USD; 30_000 ÷ 108 = 277.78 → 277; residual 0.7778 × 108 = 84.
    const sap = plan.allocations.find((row) => row.instrumentId === 'SAP')!;
    expect(sap.priceInBaseCurrency).toBeCloseTo(108, 12);
    expect(sap.currency).toBe('EUR');
    expect(sap.targetQuantity).toBe(277);
    expect(sap.roundingResidualNotional).toBeCloseTo(84, 9);
    expect(plan.trades.find((t) => t.instrumentId === 'SAP')).toMatchObject({
      side: 'buy',
      quantity: 277,
      estimatedNotional: 29_916,
      currency: 'EUR',
    });
    expect(plan.assumptions.currencyConversionsUsed).toEqual([EURUSD]);
    // The echoed quote is a copy: the caller's object is not frozen.
    expect(Object.isFrozen(EURUSD)).toBe(false);
    // Without the quote, an unavailable conversion is a typed failure — never a guess.
    expectCode(
      () =>
        allocatePortfolio(
          base({
            policy: { targets: [{ group: { instrumentId: 'SAP' }, weight: 1 }] },
            prices: { SAP: { price: 100, currency: 'EUR' } },
          }),
        ),
      'portfolio.mark_unavailable',
      'no currencyConversions quote connects EUR to USD',
    );
  });

  it('reports a targeted instrument with no price row as unresolved and still sizes the rest', () => {
    const plan = allocatePortfolio(
      base({
        policy: {
          targets: [
            { group: { instrumentId: 'SPY' }, weight: 0.6 },
            { group: { instrumentId: 'XYZ' }, weight: 0.3 },
            { group: { assetClass: 'cash' }, weight: 0.1 },
          ],
        },
        prices: { SPY: { price: 150, currency: 'USD' } },
      }),
    );
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0]).toMatchObject({
      key: 'instrumentId:XYZ',
      group: { instrumentId: 'XYZ' },
    });
    expect(plan.unresolved[0]!.reason).toContain("no price for 'XYZ'");
    expect(plan.feasible).toBe(false);
    expect(plan.allocations.map((row) => row.instrumentId)).toEqual(['SPY']);
    expect(plan.allocations[0]!.targetQuantity).toBe(400);
    expect(plan.diagnostics.unresolvedCount).toBe(1);
  });

  it('reports a target on a non-positive price as unresolved (cannot size against it)', () => {
    const plan = allocatePortfolio(
      base({
        prices: { SPY: { price: 0, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } },
      }),
    );
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0]!.reason).toContain('cannot size against a non-positive price');
    expect(plan.feasible).toBe(false);
  });

  it('carries an undeclared remainder from expandTargets verbatim — never a secret default', () => {
    // Only SPY 0.6 is declared; AGG is priced and uncovered → its goal is unknown.
    const withAgg = allocatePortfolio(
      base({ policy: { targets: [{ group: { instrumentId: 'SPY' }, weight: 0.6 }] } }),
    );
    expect(withAgg.unresolved).toHaveLength(1);
    expect(withAgg.unresolved[0]!.key).toBe('instrumentId:AGG');
    expect(withAgg.unresolved[0]!.reason).toContain('declared targets sum to 0.6');
    expect(withAgg.feasible).toBe(false);
    // Only SPY priced and declared: the remaining 0.4 has no cash target → the cash goal is unresolved.
    const onlySpy = allocatePortfolio(
      base({
        policy: { targets: [{ group: { instrumentId: 'SPY' }, weight: 0.6 }] },
        prices: { SPY: { price: 150, currency: 'USD' } },
      }),
    );
    expect(onlySpy.unresolved.map((u) => u.key)).toEqual(['assetClass:cash']);
    expect(onlySpy.feasible).toBe(false);
  });

  it('estimates commission per trade + per unit + spread and slippage basis points', () => {
    const plan = allocatePortfolio(
      base({
        transactionCosts: {
          commissionPerTrade: 1,
          commissionPerUnit: 0.01,
          spreadBasisPoints: 5,
          slippageBasisPoints: 5,
        },
      }),
    );
    // SPY 400 @ 150 = 60_000: 1 + 0.01 × 400 + (5 + 5) × 60_000 ÷ 10_000 = 1 + 4 + 60 = 65.
    // AGG 300 @ 100 = 30_000: 1 + 3 + 30 = 34. Total 99.
    expect(plan.trades.find((t) => t.instrumentId === 'SPY')!.estimatedCost).toBeCloseTo(65, 9);
    expect(plan.trades.find((t) => t.instrumentId === 'AGG')!.estimatedCost).toBeCloseTo(34, 9);
    expect(plan.estimatedTransactionCost).toBeCloseTo(99, 9);
    expect(plan.assumptions.costModel).toContain('1 base currency per non-zero trade');
    expect(plan.assumptions.costModel).toContain('spread 5 basis points');
  });

  it('honours a cash reserve on top of the cash target: fully declared targets plus a reserve are infeasible as stated', () => {
    const plan = allocatePortfolio(base({ cashReserve: 5_000 }));
    // Intended cash = 5_000 + 10_000 = 15_000; buys 90_000 > fundable 100_000 − 15_000 = 85_000.
    expect(plan.cash.targetAmount).toBe(15_000);
    expect(plan.cash.residualAmount).toBeCloseTo(-5_000, 9);
    expect(plan.feasible).toBe(false);
    expect(plan.diagnostics.warnings[0]).toContain('buys of 90000 exceed the 85000 fundable');
    // Reserve + target beyond the NAV: the cash goal itself is unresolved.
    const beyond = allocatePortfolio(base({ cashReserve: 95_000 }));
    expect(beyond.unresolved.some((u) => u.key === 'assetClass:cash')).toBe(true);
    expect(beyond.unresolved.find((u) => u.key === 'assetClass:cash')!.reason).toContain(
      'nothing is investable',
    );
  });

  it('sells a held instrument the fully declared targets do not cover (implied 0) and values an unpriced holding as unresolved', () => {
    const sold = allocatePortfolio(
      base({
        prices: { ...PRICES, XYZ: { price: 50, currency: 'USD' } },
        currentHoldings: { XYZ: 10 },
      }),
    );
    const xyz = sold.allocations.find((row) => row.instrumentId === 'XYZ')!;
    expect(xyz.implied).toBe(true);
    expect(xyz.targetWeight).toBe(0);
    expect(xyz.tradeQuantity).toBe(-10);
    expect(sold.trades.find((t) => t.instrumentId === 'XYZ')).toMatchObject({
      side: 'sell',
      quantity: 10,
      estimatedNotional: 500,
    });
    // Current cash = 100_000 − 500 = 99_500; post = 99_500 − 90_000 + 500 = 10_000.
    expect(sold.cash.residualAmount).toBeCloseTo(0, 9);
    expect(sold.feasible).toBe(true);
    const unpriced = allocatePortfolio(base({ currentHoldings: { XYZ: 10 } }));
    expect(unpriced.unresolved.map((u) => u.key)).toEqual(['instrumentId:XYZ']);
    expect(unpriced.unresolved[0]!.reason).toContain('10 held units');
  });

  it('reports a target that contradicts the policy’s restricted/allowed lists as unresolved', () => {
    const restricted = allocatePortfolio(
      base({ policy: { ...SIXTY_THIRTY_TEN, restrictedInstruments: ['AGG'] } }),
    );
    expect(restricted.unresolved.map((u) => u.key)).toEqual(['instrumentId:AGG']);
    expect(restricted.unresolved[0]!.reason).toContain('policy.restrictedInstruments');
    const notAllowed = allocatePortfolio(
      base({ policy: { ...SIXTY_THIRTY_TEN, allowedInstruments: ['SPY'] } }),
    );
    expect(notAllowed.unresolved.map((u) => u.key)).toEqual(['instrumentId:AGG']);
    expect(notAllowed.unresolved[0]!.reason).toContain('policy.allowedInstruments');
  });

  it('resolves model targets at asOf (tactical beats strategic) and flows a sleeve target to its members', () => {
    const model = createModelPortfolio({
      modelId: 'balanced',
      version: 1,
      baseCurrency: 'USD',
      strategic: {
        effectiveFrom: '2026-01-01',
        targets: [
          { group: { sleeveId: 'core' }, weight: 0.9 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
      },
      tactical: [
        {
          effectiveFrom: '2026-08-01',
          effectiveTo: '2026-09-01',
          targets: [
            { group: { sleeveId: 'core' }, weight: 0.8 },
            { group: { assetClass: 'cash' }, weight: 0.2 },
          ],
        },
      ],
      sleeves: [
        {
          sleeveId: 'core',
          members: [
            { instrumentId: 'SPY', weight: 0.5 },
            { instrumentId: 'AGG', weight: 0.5 },
          ],
        },
      ],
    });
    const tactical = allocatePortfolio(base({ policy: { model } }));
    // Tactical set effective 2026-08-01..09-01 covers 2026-08-29: core 0.8 → SPY 0.4, AGG 0.4.
    expect(tactical.assumptions.targetSource).toBe('tactical');
    expect(tactical.allocations.find((r) => r.instrumentId === 'SPY')).toMatchObject({
      targetWeight: 0.4,
      targetQuantity: 266, // 40_000 ÷ 150 = 266.67 → 266
      sourceGroups: ['sleeveId:core'],
    });
    expect(tactical.allocations.find((r) => r.instrumentId === 'AGG')!.targetQuantity).toBe(400);
    expect(tactical.cash.targetWeight).toBe(0.2);
    const strategic = allocatePortfolio(base({ policy: { model }, asOf: '2026-07-01' }));
    expect(strategic.assumptions.targetSource).toBe('strategic');
    expect(strategic.allocations.find((r) => r.instrumentId === 'SPY')!.targetQuantity).toBe(300); // 45_000 ÷ 150
    // A model in another currency cannot size a USD NAV.
    expectCode(
      () => allocatePortfolio(base({ policy: { model }, baseCurrency: 'EUR' })),
      'input.out_of_range',
      'stated in USD, but baseCurrency is EUR',
    );
  });

  it('is deterministic and deeply frozen', () => {
    const input = base({
      currentHoldings: { SPY: 10 },
      transactionCosts: { commissionPerTrade: 1 },
      minimumNotional: 100,
    });
    const first = allocatePortfolio(input);
    const second = allocatePortfolio(input);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.allocations)).toBe(true);
    expect(Object.isFrozen(first.allocations[0])).toBe(true);
    expect(Object.isFrozen(first.trades[0])).toBe(true);
    expect(Object.isFrozen(first.assumptions)).toBe(true);
    // Inputs are never mutated or frozen.
    expect(Object.isFrozen(input.prices)).toBe(false);
    expect(Object.isFrozen(input.policy)).toBe(false);
  });

  describe('typed refusals — every boundary closed, every missing goal named', () => {
    it('rejects unknown keys at every level with the did-you-mean teaching', () => {
      expectCode(
        () => allocatePortfolio({ ...base(), lotSize: 1 } as never),
        'input.unknown_field',
        'did you mean "lotSizes"',
      );
      expectCode(
        () =>
          allocatePortfolio(
            base({ prices: { SPY: { price: 150, currency: 'USD', ccy: 'USD' } } as never }),
          ),
        'input.unknown_field',
        "prices['SPY']",
      );
      expectCode(
        () => allocatePortfolio(base({ transactionCosts: { commission: 1 } as never })),
        'input.unknown_field',
        'commissionPerTrade',
      );
      expectCode(
        () => allocatePortfolio(base({ policy: { ...SIXTY_THIRTY_TEN, turnover: 1 } as never })),
        'input.unknown_field',
        'maximumTurnover',
      );
    });

    it('requires asOf, policy, prices, and targets', () => {
      expectCode(
        () => allocatePortfolio({ ...base(), asOf: undefined } as never),
        'input.missing_field',
        'asOf is required',
      );
      expectCode(
        () => allocatePortfolio({ ...base(), policy: undefined } as never),
        'input.missing_field',
        'policy is required',
      );
      expectCode(
        () => allocatePortfolio({ ...base(), prices: undefined } as never),
        'input.missing_field',
        'prices is required',
      );
      expectCode(
        () => allocatePortfolio(base({ policy: {} })),
        'input.missing_field',
        'policy declares no targets',
      );
    });

    it('refuses a non-finite or non-positive net asset value, a bad lot size, and a negative reserve', () => {
      expectCode(() => allocatePortfolio(base({ netAssetValue: NaN })), 'input.not_finite');
      expectCode(() => allocatePortfolio(base({ netAssetValue: Infinity })), 'input.not_finite');
      expectCode(
        () => allocatePortfolio(base({ netAssetValue: 0 })),
        'input.out_of_range',
        'netAssetValue must be > 0',
      );
      expectCode(
        () => allocatePortfolio(base({ lotSizes: { SPY: 0 } })),
        'input.out_of_range',
        "lotSizes['SPY']",
      );
      expectCode(() => allocatePortfolio(base({ defaultLotSize: -1 })), 'input.out_of_range');
      expectCode(
        () => allocatePortfolio(base({ cashReserve: -1 })),
        'input.out_of_range',
        'cashReserve must be ≥ 0',
      );
      expectCode(
        () => allocatePortfolio(base({ minimumNotional: -1 })),
        'input.out_of_range',
        'minimumNotional',
      );
      expectCode(
        () => allocatePortfolio(base({ transactionCosts: { spreadBasisPoints: -5 } })),
        'input.out_of_range',
        'transactionCosts.spreadBasisPoints',
      );
    });

    it('refuses malformed prices, holdings, and currency codes', () => {
      expectCode(
        () =>
          allocatePortfolio(base({ prices: { SPY: { price: 'x', currency: 'USD' } } as never })),
        'input.wrong_type',
        "prices['SPY'].price",
      );
      expectCode(
        () => allocatePortfolio(base({ prices: { SPY: { price: 150, currency: 'usd' } } })),
        'input.out_of_range',
        "write it as 'USD'",
      );
      expectCode(
        () => allocatePortfolio(base({ currentHoldings: { SPY: NaN } })),
        'input.not_finite',
        "currentHoldings['SPY']",
      );
      expectCode(() => allocatePortfolio(base({ baseCurrency: 'dollars' })), 'input.out_of_range');
      expectCode(
        () => allocatePortfolio(base({ asOf: '2026-08-29T10:00:00' })),
        'input.wrong_type',
        'no timezone',
      );
    });
  });
});
