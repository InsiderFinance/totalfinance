import { resolvedExpiry } from '@totalfinance/core';
import { isPeriodAvailableAt } from '@totalfinance/fundamentals';
import { internalRateOfReturn, netPresentValue } from '@totalfinance/valuation';
import { screenUniverse, type ScreenUniverseInput } from '@totalfinance/research';
import { convertCurrency, coveredInterestParityForward } from '@totalfinance/foreign-exchange';
import { commodityForwardPrice, impliedConvenienceYield } from '@totalfinance/commodities';
import { createPortfolioLedger, portfolioSnapshot } from '@totalfinance/portfolio';
import { createMarketSnapshot, createScenarioSet } from '@totalfinance/core/artifacts';
import { describe, expect, it } from 'vitest';
import type { OptionQuote } from '@totalfinance/core';
import { isoDateToEpochMs } from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';
import { NYSE } from '@totalfinance/calendars/nyse';
import { sharpe } from '@totalfinance/performance';
import { covariance, maxSharpe, valueAtRisk } from '@totalfinance/risk';
import { crossSectionalBacktest } from '@totalfinance/backtest';
import { blackScholes, option } from '@totalfinance/options';
import { optionContractPricer } from '@totalfinance/options/pricer';
import { runScenarios, scenarioTarget } from '@totalfinance/scenarios';
import { expectedMoveFromImpliedVolatility } from '@totalfinance/volatility';
import { exposure } from '@totalfinance/structure';
import * as ta from '@totalfinance/technical-analysis';
import { legs, strategy } from '@totalfinance/strategy';
import { bonds, priceFromYield } from '@totalfinance/fixed-income';
import { futuresBasis, perpetualFunding } from '@totalfinance/crypto';
import { defaultTools } from '@totalfinance/mcp';
import { createOperationRegistry, defaultPacks } from '@totalfinance/workflows';
import { openApiDocument } from '@totalfinance/http';
import {
  createFileArtifactStore,
  createFileJobStore,
  registryForProfile,
  submitJob,
} from '@totalfinance/cli';
import { calibrateSvi } from '@totalfinance/volatility';
import {
  compareFittedModels,
  evaluateFittedModel,
  fittedModelArtifact,
  readFittedModel,
  replayFittedModel,
} from '@totalfinance/volatility/artifacts';
import { curves, type BootstrapInstrument } from '@totalfinance/fixed-income';
import {
  compareFittedModels as compareCurveModels,
  evaluateFittedModel as evaluateCurveModel,
  fittedModelArtifact as curveArtifact,
  readFittedModel as readCurveModel,
  replayFittedModel as replayCurveModel,
} from '@totalfinance/fixed-income/artifacts';
import {
  compareResearchRuns,
  readResearchRun,
  replayResearchRun,
  researchRunArtifact,
} from '@totalfinance/research/artifacts';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';

/**
 * DX4.2 — the single source of truth for each package README's example.
 *
 * `tools/readme-gen.ts` extracts the block between `readme:begin` / `readme:end` from each `it`
 * (keyed by the package name) into `packages/<pkg>/README.md`, un-commenting the `// import …`
 * lines. Because every block RUNS here in CI, the README examples can never rot. Regenerate with
 * `pnpm tsx tools/readme-gen.ts`; `tools/readme-gen.test.ts` fails on drift.
 *
 * The umbrella (`totalfinance`) block runs against its domain subpaths; their identity with the
 * scoped bindings is also guarded separately by `packages/totalfinance/test`.
 */
describe('README examples (run in CI so the generated package READMEs can never rot)', () => {
  it('@totalfinance/core', () => {
    // readme:begin
    // import { isoDateToEpochMs } from '@totalfinance/core';
    const ms = isoDateToEpochMs('2026-01-15'); // → UTC midnight, epoch ms
    // readme:end
    expect(ms).toBe(Date.UTC(2026, 0, 15));
  });

  it('@totalfinance/valuation', () => {
    // readme:begin
    // import { netPresentValue, internalRateOfReturn } from '@totalfinance/valuation';
    const cashFlows = [
      { amount: -1_000, timeYears: 0 },
      { amount: 600, timeYears: 1 },
      { amount: 600, timeYears: 2 },
    ];
    const projectValue = netPresentValue({ cashFlows, annualDiscountRate: 0.1 });
    // number | null — an ambiguous IRR is never chosen silently; read .explain() for every root.
    const rate = internalRateOfReturn({ cashFlows });
    // readme:end
    expect(projectValue).toBeCloseTo(41.32, 2);
    expect(rate).toBeCloseTo(0.1307, 4);
  });

  it('@totalfinance/research', () => {
    // readme:begin
    // import { screenUniverse, type ScreenUniverseInput } from '@totalfinance/research';
    const screen = screenUniverse({
      universeId: 'demo@2026-08-12',
      asOf: Date.UTC(2026, 7, 12, 20),
      observations: [
        {
          instrumentId: 'AAA',
          availableTimestampMs: Date.UTC(2026, 7, 1),
          fields: { returnOnInvestedCapital: 0.22, freeCashFlowYield: 0.06 },
        },
        {
          instrumentId: 'BBB',
          availableTimestampMs: Date.UTC(2026, 7, 1),
          fields: { returnOnInvestedCapital: 0.12, freeCashFlowYield: 0.08 },
        },
      ],
      fieldDefinitions: [
        { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
        { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
      ],
      filter: { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.15 },
      missingValuePolicy: 'exclude',
      orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
    });
    // Every exclusion carries a reason; the screen is deterministic under input permutation.
    // readme:end
    expect(screen.rows.map((row) => row.instrumentId)).toEqual(['AAA']);
    expect(screen.diagnostics.exclusionReasons['filtered-out']).toBe(1);
  });

  it('@totalfinance/foreign-exchange', () => {
    // readme:begin
    // import { convertCurrency, coveredInterestParityForward } from '@totalfinance/foreign-exchange';
    // EUR/USD 1.08: one euro costs 1.08 dollars — the pair always names its own direction.
    const spotRate = { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 };
    const conversion = convertCurrency({
      amount: 1_000,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate,
    }); // 1,080 USD, orientation disclosed in conversion.assumptions
    const parity = coveredInterestParityForward({
      spotRate,
      domesticAnnualRate: 0.05, // the QUOTE currency's rate (USD)
      foreignAnnualRate: 0.03, // the BASE currency's rate (EUR)
      timeYears: 0.75,
      compounding: 'continuous',
    }); // forward = 1.08 × e^((0.05 − 0.03) × 0.75)
    // readme:end
    expect(conversion.convertedAmount).toBeCloseTo(1_080, 10);
    expect(parity.forwardRate.quotePerBase).toBeCloseTo(1.08 * Math.exp(0.02 * 0.75), 12);
  });

  it('@totalfinance/portfolio', () => {
    // readme:begin
    // import { createPortfolioLedger, portfolioSnapshot } from '@totalfinance/portfolio';
    // import { createMarketSnapshot } from '@totalfinance/core/artifacts';
    // Portfolio truth is a fold over immutable economic events: a deposit, then a fill.
    const instrumentId = 'AAPL';
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        {
          eventId: 'dep-1',
          schemaVersion: 1,
          eventType: 'cash.deposit',
          sourceId: 'broker-a',
          accountId: 'main',
          effectiveTimestampMs: Date.UTC(2026, 0, 2, 15),
          recordedTimestampMs: Date.UTC(2026, 0, 2, 15),
          event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
          provenance: {},
        },
        {
          eventId: 'fill-1',
          schemaVersion: 1,
          eventType: 'trade.fill',
          sourceId: 'broker-a',
          accountId: 'main',
          effectiveTimestampMs: Date.UTC(2026, 0, 10, 15),
          recordedTimestampMs: Date.UTC(2026, 0, 10, 15),
          event: {
            eventType: 'trade.fill',
            instrumentId,
            side: 'buy',
            quantity: 100,
            pricePerUnit: 150,
            currency: 'USD',
          },
          provenance: {},
        },
      ],
    });
    // Valuation is an explicit market/as-of question, never a stored number:
    // 85_000 cash + 100 × 160 = 101_000 net asset value.
    const valued = portfolioSnapshot({
      portfolio: ledger.state,
      asOf: Date.UTC(2026, 1, 1),
      market: createMarketSnapshot({
        asOf: '2026-02-01', // a dated snapshot: the ledger values calendar date D at 00:00 UTC of D
        observations: { spots: { [instrumentId]: { price: 160, currency: 'USD' } } },
      }),
    });
    const netAssetValue = valued.netAssetValue;
    const heldQuantity = ledger.state.accounts['main']!.positions[instrumentId]!.quantity;
    // readme:end
    expect(netAssetValue).toBe(101_000);
    expect(heldQuantity).toBe(100);
  });

  it('@totalfinance/commodities', () => {
    // readme:begin
    // import { commodityForwardPrice, impliedConvenienceYield } from '@totalfinance/commodities';
    // Cost of carry: forward = spot × e^((financing + storage − convenience) × t).
    const forwardPrice = commodityForwardPrice({
      spotPrice: 72,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
      compounding: 'continuous',
    }); // 72 × e^(0.06 × 0.5) ≈ 74.19
    // The inverse recovers the convenience yield that priced this forward, exactly.
    const implied = impliedConvenienceYield({
      spotPrice: 72,
      forwardPrice,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      compounding: 'continuous',
    });
    // readme:end
    expect(forwardPrice).toBeCloseTo(72 * Math.exp(0.06 * 0.5), 12);
    expect(implied.impliedAnnualConvenienceYield).toBeCloseTo(0.01, 12);
  });

  it('@totalfinance/fundamentals', () => {
    // readme:begin
    // import { isPeriodAvailableAt } from '@totalfinance/fundamentals';
    const q1 = {
      periodEndDate: '2026-03-31',
      fiscalYear: 2026,
      fiscalQuarter: 1,
      periodType: 'quarter',
      availableTimestampMs: Date.UTC(2026, 3, 28, 21, 30), // the 10-Q landed April 28
      currency: 'USD',
      monetaryScale: 1_000_000,
    } as const;
    // The quarter ENDED March 31 — but a point-in-time observer on April 1 must not see it.
    const visibleApril1 = isPeriodAvailableAt(q1, Date.UTC(2026, 3, 1)); // false
    const visibleMay = isPeriodAvailableAt(q1, Date.UTC(2026, 4, 15)); // true
    // readme:end
    expect(visibleApril1).toBe(false);
    expect(visibleMay).toBe(true);
  });

  it('@totalfinance/math', () => {
    // readme:begin
    // import { normalCdf } from '@totalfinance/math';
    const p = normalCdf(0); // → 0.5 (standard normal CDF at 0)
    // readme:end
    expect(p).toBeCloseTo(0.5, 12);
  });

  it('@totalfinance/calendars', () => {
    // readme:begin
    // import { NYSE } from '@totalfinance/calendars/nyse';
    const open = NYSE.isBusinessDay('2026-01-20'); // Tuesday after MLK Day
    // readme:end
    expect(typeof open).toBe('boolean');
  });

  it('@totalfinance/performance', () => {
    // readme:begin
    // import { sharpe } from '@totalfinance/performance';
    const ratio = sharpe([0.012, -0.004, 0.021, 0.007, -0.003, 0.015]);
    // readme:end
    expect(Number.isFinite(ratio)).toBe(true);
  });

  it('@totalfinance/risk', () => {
    // readme:begin
    // import { covariance, maxSharpe, valueAtRisk } from '@totalfinance/risk';
    const returns = [0.01, -0.02, 0.015, -0.05, 0.008, -0.01, 0.02, -0.03];
    const var95 = valueAtRisk(returns); // 95% historical VaR (positive loss magnitude)

    // The portfolio journey: raw return history → covariance + means → optimizer (D11).
    const history = [
      [0.012, -0.004, 0.006],
      [-0.008, 0.011, -0.002],
      [0.005, 0.003, 0.009],
      [0.014, -0.009, -0.005],
      [-0.011, 0.007, 0.004],
      [0.009, 0.002, -0.008],
    ]; // one row per period, one column per asset
    const { covariance: covarianceMatrix, meanReturns: mu } = covariance({
      returns: history,
    }).value;
    const weights = maxSharpe({
      mean: mu,
      covariance: covarianceMatrix,
      options: { longOnly: true },
    }).value.weights;
    // readme:end
    expect(var95).toBeGreaterThan(0);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
  });

  it('@totalfinance/backtest', () => {
    // readme:begin
    // import { crossSectionalBacktest } from '@totalfinance/backtest';
    const sessions = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23', '2026-02-06'];
    const close = (date: string) => Date.parse(`${date}T21:00:00Z`);
    const run = crossSectionalBacktest({
      dataset: {
        // one quality score per name, published before the first close (point-in-time)
        observations: [
          {
            instrumentId: 'AAA',
            availableTimestampMs: close('2026-01-01'),
            fields: { quality: 3 },
          },
          {
            instrumentId: 'BBB',
            availableTimestampMs: close('2026-01-01'),
            fields: { quality: 2 },
          },
          {
            instrumentId: 'CCC',
            availableTimestampMs: close('2026-01-01'),
            fields: { quality: 1 },
          },
        ],
        fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' }],
        // per-session simple returns — the run's calendar and its return-index prices
        returns: ['AAA', 'BBB', 'CCC'].flatMap((instrumentId, n) =>
          sessions.map((tradingSessionDate, i) => ({
            instrumentId,
            tradingSessionDate,
            simpleReturn: (1 - n) * 0.01 + (i % 2 === 0 ? 0.001 : -0.001),
          })),
        ),
      },
      universeHistory: {
        universeId: 'demo',
        members: ['AAA', 'BBB', 'CCC'].map((instrumentId) => ({
          instrumentId,
          fromTimestampMs: close('2026-01-01'),
        })),
      },
      signal: {
        score: {
          components: [
            {
              field: 'quality',
              weight: 1,
              direction: 'higher-is-better',
              standardization: 'z-score',
            },
          ],
          missingValuePolicy: 'exclude',
        },
      },
      rebalanceSchedule: { frequency: 'monthly', session: 'close' },
      portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
      initialCapital: 100_000,
    });
    // run.finalValue equals the ledger's net asset value; run.assumptions.execution says `simplified`
    // readme:end
    expect(run.finalValue).toBeGreaterThan(0);
    expect(run.diagnostics.reconciliationResidual).toBe(0);
    expect(run.assumptions.execution.realism).toBe('simplified');
  });

  it('@totalfinance/options', () => {
    // readme:begin
    // import { blackScholes } from '@totalfinance/options';
    const price = blackScholes.call({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    const explained = blackScholes.call.explain({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    // readme:end
    expect(price).toBeGreaterThan(0);
    expect(explained.value).toBe(price);
    expect(explained.assumptions.dayCount).toBe('ACT/365F');
  });

  it('@totalfinance/scenarios', () => {
    // readme:begin
    // import { createMarketSnapshot, createScenarioSet } from '@totalfinance/core/artifacts';
    // import { option } from '@totalfinance/options';
    // import { optionContractPricer } from '@totalfinance/options/pricer';
    // import { runScenarios, scenarioTarget } from '@totalfinance/scenarios';
    const aaplCall = option.usEquityCall({
      underlying: 'AAPL',
      strike: 105,
      expiry: '2027-01-15',
    });
    const sharedMarket = createMarketSnapshot({
      asOf: '2026-01-15T10:00:00-05:00',
      conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
      observations: {
        spots: { ['AAPL']: { price: 100, currency: 'USD' } },
        volatilities: { ['AAPL']: 0.25 },
        riskFreeRates: { ['USD']: 0.04 },
        dividendYields: { ['AAPL']: 0.01 },
      },
    });
    const sharedScenario = createScenarioSet({
      name: 'AAPL stress',
      scenarios: [
        {
          name: 'AAPL +10%',
          shocks: [{ factor: 'spot', target: 'AAPL', kind: 'percent', value: 0.1 }],
        },
      ],
    });
    const scenarioRun = runScenarios({
      scenarioSet: sharedScenario,
      market: sharedMarket,
      targets: [
        scenarioTarget.spot({
          id: 'AAPL shares',
          symbol: 'AAPL',
          quantity: 10,
          currency: 'USD',
        }),
        scenarioTarget.fullRevaluation({
          id: 'AAPL call',
          quantity: 1,
          contractMultiplier: 100,
          currency: 'USD',
          underlying: 'AAPL',
          instrument: aaplCall,
          pricer: optionContractPricer(),
        }),
      ],
    });

    // Results are explicit unions: narrow once, then values and the original pricing result are typed.
    const shareBase = scenarioRun.base[0];
    const callBase = scenarioRun.base[1];
    const shareUp = scenarioRun.cells[0];
    const callUp = scenarioRun.cells[1];
    if (shareBase?.status !== 'complete' || shareUp?.status !== 'complete') {
      throw new Error('The share valuation did not complete');
    }
    if (
      callBase?.status !== 'complete' ||
      callBase.valuationMethod !== 'full-revaluation' ||
      callUp?.status !== 'complete' ||
      callUp.valuationMethod !== 'full-revaluation'
    ) {
      throw new Error('The option valuation did not complete');
    }
    const summary = {
      ['shareBaseValue']: shareBase.positionValue, // 1,000 USD
      ['shareScenarioValue']: shareUp.positionValue, // 1,100 USD under the same +10% scenario
      ['optionScenarioResult']: callUp.pricingResult, // the complete domain result is preserved
    };
    // readme:end
    expect(summary.shareBaseValue).toBe(1_000);
    expect(summary.shareScenarioValue).toBeCloseTo(1_100, 12);
    expect(summary.optionScenarioResult.value).toBeGreaterThan(0);
    expect(shareBase.valuePerUnit).toBe(100);
    expect(shareBase.positionValue).toBe(1_000);
    expect(shareUp.valuePerUnit).toBeCloseTo(110, 12);
    expect(shareUp.positionValue).toBeCloseTo(1_100, 12);
    expect(shareUp.localPnl).toBeCloseTo(100, 12);
    expect(callBase.pricingResult.value).toBeGreaterThan(0);
    expect(callUp.pricingResult.value).toBeGreaterThan(callBase.pricingResult.value);
    expect(callUp.localPnl).toBeGreaterThan(0);
  });

  it('@totalfinance/volatility', () => {
    // readme:begin
    // import { expectedMoveFromImpliedVolatility } from '@totalfinance/volatility';
    const move = expectedMoveFromImpliedVolatility({
      spot: 100,
      impliedVolatility: 0.2,
      timeToExpiryYears: 30 / 365,
    });
    // readme:end
    expect(move.oneSigma).toBeGreaterThan(0);
  });

  it('@totalfinance/structure', () => {
    // readme:begin
    // import { exposure } from '@totalfinance/structure';
    // import { resolvedExpiry, type OptionQuote } from '@totalfinance/core';
    const chain: OptionQuote[] = [
      {
        contract: {
          underlying: 'SPY',
          type: 'call',
          style: 'american',
          strike: 105,
          expiry: '2026-08-21',
          ...resolvedExpiry('2026-08-21'),
        },
        timestampMs: Date.UTC(2026, 6, 13),
        openInterest: 5000,
        impliedVolatility: 0.2,
        underlyingPrice: 100,
      },
      {
        contract: {
          underlying: 'SPY',
          type: 'put',
          style: 'american',
          strike: 95,
          expiry: '2026-08-21',
          ...resolvedExpiry('2026-08-21'),
        },
        timestampMs: Date.UTC(2026, 6, 13),
        openInterest: 5000,
        impliedVolatility: 0.2,
        underlyingPrice: 100,
      },
    ];
    const profile = exposure({
      quotes: chain,
      market: { spot: 100, riskFreeRate: 0.045, asOf: Date.UTC(2026, 6, 13) },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const net = profile.atSpot(100); // net dealer { gex, dex } at spot
    // readme:end
    expect(Number.isFinite(net.gex)).toBe(true);
  });

  it('@totalfinance/technical-analysis', () => {
    // readme:begin
    // import * as ta from '@totalfinance/technical-analysis';
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const rsi = ta.rsi.explain(closes, { period: 14 }); // aligned to input; NaN through the 14-bar warmup
    rsi.value.at(-1); // => 57.92 — RSI-14 needs 15+ closes; feed fewer and every point is NaN
    // readme:end
    expect(rsi.value).toHaveLength(closes.length);
    expect(rsi.value.at(-1)).toBeCloseTo(57.915, 2);
  });

  it('@totalfinance/strategy', () => {
    // readme:begin
    // import { strategy, legs } from '@totalfinance/strategy';
    const spread = strategy([
      legs.call({ strike: 100, premium: 4.25, quantity: 1 }),
      legs.call({ strike: 110, premium: 1.4, quantity: -1 }),
    ]);
    const metrics = spread.metrics(); // breakevens, max profit/loss, net debit/credit
    // readme:end
    expect(metrics.maxProfit).toBeGreaterThan(0);
  });

  it('@totalfinance/crypto', () => {
    // readme:begin
    // import { futuresBasis, perpetualFunding } from '@totalfinance/crypto';
    const funding = perpetualFunding({
      markPrice: 68_250,
      indexPrice: 68_100,
      fundingRate: 0.0001, // the 8-hour rate the venue publishes
      intervalHours: 8,
    });
    const longPays = funding.value.annualizedSimple; // => 0.1095 — 10.95%/yr at 1095 intervals
    const shortEarns = funding.value.shortCarry; // => +0.1095 — the other side of the same trade

    const basis = futuresBasis({
      spot: 68_100,
      future: 69_400,
      timeToExpiryYears: 90 / 365,
      financingRate: 0.05, // cash-and-carry funding cost
    });
    const shape = basis.value.structure; // => 'contango'
    const overFair = basis.value.richness; // => 455.21 — the future over cash-and-carry fair value
    // readme:end
    expect(longPays).toBeCloseTo(0.1095, 9);
    expect(shortEarns).toBeCloseTo(-funding.value.longCarry, 12);
    expect(shape).toBe('contango');
    expect(overFair).toBeCloseTo(455.214074923, 6);
    // every crypto result carries its conventions (Law 2), so a caller can see the day count used
    expect(basis.assumptions.conventionsVersion).toBe('0.0.1');
  });

  it('@totalfinance/fixed-income', () => {
    // readme:begin
    // import { bonds, priceFromYield } from '@totalfinance/fixed-income';
    const bond = bonds.fixedRate({
      issueDate: '2026-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.05,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: '30/360',
    });
    const priced = priceFromYield(bond, { settlementDate: '2026-01-01', yield: 0.05 });
    // readme:end
    expect(priced.cleanPrice).toBeCloseTo(100, 6);
  });

  it('@totalfinance/mcp', () => {
    // readme:begin
    // import { defaultTools } from '@totalfinance/mcp';
    const toolNames = defaultTools().map((t) => t.name); // the read-only compute tools
    // readme:end
    expect(toolNames).toContain('totalfinance_option_price'); // B1: dots become underscores on the wire
  });

  it('@totalfinance/workflows', () => {
    // readme:begin
    // import { createOperationRegistry, defaultPacks } from '@totalfinance/workflows';
    const registry = createOperationRegistry({ packs: defaultPacks() }); // the curated, effect-checked set
    const result = registry.run({
      id: 'totalfinance.option.price',
      input: {
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 30 / 365,
        riskFreeRate: 0.045,
        volatility: 0.22,
      },
    });
    // readme:end
    expect(result.operation).toEqual({ id: 'totalfinance.option.price', version: '1' });
    expect(result.structured['value']).toBeGreaterThan(0);
  });

  it('@totalfinance/cli', () => {
    // readme:begin
    // import { createFileArtifactStore, createFileJobStore, registryForProfile, submitJob } from '@totalfinance/cli';
    const directory = '/tmp/totalfinance-example-store'; // an ABSOLUTE path: the store directory jobs and handles share
    const run = submitJob({
      registry: registryForProfile({ profile: 'default' }),
      jobs: createFileJobStore({ directory }),
      artifacts: createFileArtifactStore({ directory }),
      directory,
      id: 'totalfinance.option.price', // a small operation runs inline; a job-class one runs in a worker
      input: {
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 30 / 365,
        riskFreeRate: 0.045,
        volatility: 0.22,
      },
      profile: 'default',
      clock: () => new Date().toISOString(),
    });
    const report = createFileArtifactStore({ directory }).get(run.record.result!.uri); // readable from any process
    // readme:end
    expect(run.record.state).toBe('completed');
    expect((report!.value as { structured: { value: number } }).structured.value).toBeGreaterThan(
      0,
    );
  });

  it('@totalfinance/http', () => {
    // readme:begin
    // import { openApiDocument } from '@totalfinance/http';
    // import { createOperationRegistry, defaultPacks } from '@totalfinance/workflows';
    const document = openApiDocument({
      registry: createOperationRegistry({ packs: defaultPacks() }),
    }); // OpenAPI 3.1, from the registry
    const routes = Object.keys(document.paths); // '/operations', '/operations/totalfinance.option.price/run', '/jobs', …
    // readme:end
    expect(document.openapi).toBe('3.1.0');
    expect(routes).toContain('/operations/totalfinance.option.price/run');
  });

  it('totalfinance', async () => {
    const { blackScholes } = await import('totalfinance/options');
    const { rsi } = await import('totalfinance/technical-analysis');
    // readme:begin
    // import { blackScholes } from 'totalfinance/options';
    // import { rsi } from 'totalfinance/technical-analysis';
    const price = blackScholes.call({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    const momentum = rsi.explain(
      [
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
        46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
      ],
      { period: 14 },
    );
    // readme:end
    expect(price).toBeGreaterThan(0);
    expect(momentum.value).toHaveLength(20);
    expect(momentum.value.at(-1)).toBeCloseTo(57.915, 2);
  });

  it('@totalfinance/volatility/artifacts', () => {
    // readme:begin
    // import { calibrateSvi } from '@totalfinance/volatility';
    // import { fittedModelArtifact, readFittedModel, evaluateFittedModel, replayFittedModel, compareFittedModels } from '@totalfinance/volatility/artifacts';
    // import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
    // A smile in total variance w(k) — here generated from known SVI parameters.
    const k = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
    const w = k.map(
      (x) => 0.04 + 0.4 * (-0.4 * (x - 0.05) + Math.sqrt((x - 0.05) ** 2 + 0.15 ** 2)),
    );
    const smile = { k, w };
    const fit = calibrateSvi(smile, { timeToExpiryYears: 0.5 });
    // Save: the fit verbatim, the calibration input, one content-addressed artifact.
    const artifact = fittedModelArtifact({
      family: 'svi',
      fit,
      calibration: { smile, options: { timeToExpiryYears: 0.5 } },
    });
    const json = canonicalJsonOf(artifact); // → persist anywhere
    // Restore, evaluate through the direct evaluator, replay the calibration, compare.
    const { report } = readFittedModel({ artifact: fromCanonicalJson(json) });
    const evaluated = evaluateFittedModel({ model: report, at: { logMoneyness: [-0.2, 0, 0.2] } });
    const replay = replayFittedModel({ artifact }); // parity.identical === true
    const scaled = { k, w: w.map((x) => x * 1.05) };
    const shifted = fittedModelArtifact({
      family: 'svi',
      fit: calibrateSvi(scaled, { timeToExpiryYears: 0.5 }),
      calibration: { smile: scaled, options: { timeToExpiryYears: 0.5 } },
    });
    const comparison = compareFittedModels({ baseline: artifact, candidate: shifted });
    // readme:end
    expect(report.family).toBe('svi');
    expect(evaluated.values).toHaveLength(3);
    expect(replay.parity.identical).toBe(true);
    expect(comparison.parameters.length).toBeGreaterThan(0);
    expect(comparison.sameCalibrationInput).toBe(false);
  });

  it('@totalfinance/fixed-income/artifacts', () => {
    // readme:begin
    // import { curves, type BootstrapInstrument } from '@totalfinance/fixed-income';
    // import { fittedModelArtifact, readFittedModel, evaluateFittedModel, replayFittedModel, compareFittedModels } from '@totalfinance/fixed-income/artifacts';
    // import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
    const instruments: BootstrapInstrument[] = [
      { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
      { type: 'swap', maturity: '2028-01-01', rate: 0.032, fixedFrequency: 'semiannual' },
      { type: 'swap', maturity: '2031-01-01', rate: 0.035, fixedFrequency: 'semiannual' },
    ];
    const options = { referenceDate: '2026-01-01' };
    const curve = curves.bootstrap(instruments, options);
    // Save: the curve's own data (pillars, conventions), restored bit for bit.
    const artifact = curveArtifact({
      family: 'discount-curve',
      fit: curve,
      calibration: { instruments, options },
      currency: 'USD',
    });
    const json = canonicalJsonOf(artifact);
    const { report } = readCurveModel({ artifact: fromCanonicalJson(json) });
    const discount = evaluateCurveModel({
      model: report,
      at: { dates: ['2028-06-30'], measure: 'discount' },
    });
    const replay = replayCurveModel({ artifact }); // parity.identical === true
    const bumped: BootstrapInstrument[] = instruments.map((i) =>
      'rate' in i ? { ...i, rate: i.rate + 0.001 } : i,
    );
    const shifted = curveArtifact({
      family: 'discount-curve',
      fit: curves.bootstrap(bumped, options),
      calibration: { instruments: bumped, options },
      currency: 'USD',
    });
    const comparison = compareCurveModels({ baseline: artifact, candidate: shifted });
    // readme:end
    expect(discount.values[0]).toBe(curve.discount('2028-06-30'));
    expect(replay.parity.identical).toBe(true);
    expect(comparison.sameCalibrationInput).toBe(false);
  });

  it('@totalfinance/research/artifacts', () => {
    // readme:begin
    // import { screenUniverse, type ScreenUniverseInput } from '@totalfinance/research';
    // import { researchRunArtifact, readResearchRun, replayResearchRun, compareResearchRuns } from '@totalfinance/research/artifacts';
    // import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
    const observations = [
      {
        instrumentId: 'AAA',
        availableTimestampMs: Date.UTC(2026, 7, 1),
        fields: { freeCashFlowYield: 0.06 },
      },
      {
        instrumentId: 'BBB',
        availableTimestampMs: Date.UTC(2026, 7, 1),
        fields: { freeCashFlowYield: 0.08 },
      },
      {
        instrumentId: 'CCC',
        availableTimestampMs: Date.UTC(2026, 7, 1),
        fields: { freeCashFlowYield: 0.02 },
      },
    ];
    const input: ScreenUniverseInput = {
      universeId: 'us-large-cap',
      asOf: Date.UTC(2026, 7, 12, 20),
      observations,
      fieldDefinitions: [
        { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
      ],
      filter: { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.03 },
      missingValuePolicy: 'exclude',
      orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
    };
    const run = screenUniverse(input);
    // Save the run verbatim; reference the bulk rows by content hash instead of embedding them.
    const artifact = researchRunArtifact({
      kind: 'screen',
      run,
      input,
      referenceRowSets: ['observations'],
    });
    const json = canonicalJsonOf(artifact);
    const { report } = readResearchRun({ artifact: fromCanonicalJson(json) });
    // Replay needs the referenced rows back — they must hash to the stored handle.
    const replay = replayResearchRun({ artifact, referencedData: { observations } }); // parity.identical === true
    const looser: ScreenUniverseInput = {
      ...input,
      filter: { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.01 },
    };
    const comparison = compareResearchRuns({
      baseline: artifact,
      candidate: researchRunArtifact({
        kind: 'screen',
        run: screenUniverse(looser),
        input: looser,
      }),
    });
    // readme:end
    expect(report.assumptions.inputPolicy).toBe('referenced');
    expect(replay.parity.identical).toBe(true);
    expect(comparison.membership?.entered.ids).toEqual(['CCC']);
    expect(comparison.sameFilter).toBe(false);
  });
});
