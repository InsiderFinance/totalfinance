/**
 * Stage 4.4b Decision 11: one heterogeneous scenario grid must preserve every direct engine.
 *
 * This is numerical acceptance evidence, not a second implementation. Expected option, bond, and
 * Taylor answers are obtained from their existing public APIs over the explicitly transformed
 * market coordinates, then compared with the runner's retained results and reconciled totals.
 */

import { describe, expect, it } from 'vitest';
import { stableSum, type RateCurve } from '@totalfinance/core';
import {
  canonicalJsonOf,
  createMarketSnapshot,
  createScenarioSet,
  type ScenarioDefinition,
} from '@totalfinance/core/artifacts';
import { bonds, curves, priceMultiCurve } from '@totalfinance/fixed-income';
import { bondDiscountCurvePricer } from '@totalfinance/fixed-income/pricer';
import { market as optionMarket, option } from '@totalfinance/options';
import { optionContractPricer } from '@totalfinance/options/pricer';
import { taylorPnl, type PositionGreeks, type Scenario } from '@totalfinance/risk';
import {
  runScenarios,
  scenarioTarget,
  spotAssetPricer,
  type ScenarioBaseCell,
  type ScenarioCell,
  type ScenarioPricingResult,
  type ScenarioRunResult,
} from '../src/index.js';

const MILLISECONDS_PER_YEAR = 31_536_000_000;
const AS_OF = Date.UTC(2026, 5, 15, 13, 45);
const SIX_HOURS = 6 * 60 * 60 * 1_000;
const TWELVE_HOURS = 12 * 60 * 60 * 1_000;
const CURVE_ID = 'USD.treasury';

const baseCurve: RateCurve = {
  currency: 'USD',
  asOf: Date.UTC(2026, 0, 1),
  dayCount: 'ACT/365F',
  compounding: 'continuous',
  interpolation: 'logLinearDiscount',
  points: [
    { date: '2026-01-01', zeroRate: 0.04 },
    { date: '2027-01-01', zeroRate: 0.042 },
    { date: '2029-01-01', zeroRate: 0.045 },
    { date: '2032-01-01', zeroRate: 0.047 },
  ],
};

const shockedCurve: RateCurve = {
  ...baseCurve,
  points: baseCurve.points.map((point) => ({ ...point, zeroRate: point.zeroRate + 0.001 })),
};

const optionContract = option.call({
  convention: 'us-equity-close',
  underlying: 'AAPL',
  strike: 105,
  expiry: '2027-06-18',
  style: 'european',
});

const fixedBond = bonds.fixedRate({
  issueDate: '2025-01-01',
  maturityDate: '2031-01-01',
  couponRate: 0.05,
  frequency: 'semiannual',
  faceValue: 100,
  dayCount: '30/360',
});

const taylorGreeks = {
  delta: 0.55,
  gamma: 0.015,
  vega: 12,
  theta: -6,
  rho: 8,
  vanna: 0.4,
  vomma: 25,
  charm: -0.03,
  veta: 1.2,
  vera: 0.8,
  deltaRate: 0.2,
  thetaRate: -0.1,
  rhoConvexity: 3,
  thetaConvexity: 0.5,
  phi: -4,
} as const;

const scenarios = [
  {
    name: 'joint market and curve move',
    shocks: [
      { factor: 'spot', target: 'AAPL', kind: 'absolute', value: 5 },
      { factor: 'volatility', target: 'AAPL', kind: 'absolute', value: 0.03 },
      { factor: 'riskFreeRate', target: 'USD', kind: 'absolute', value: 0.005 },
      { factor: 'dividend', target: 'AAPL', kind: 'absolute', value: -0.002 },
      { factor: 'discountCurve', target: CURVE_ID, kind: 'absolute', value: 0.001 },
    ],
  },
  {
    name: 'same UTC date six-hour roll',
    shocks: [
      {
        factor: 'time',
        kind: 'absolute',
        value: SIX_HOURS / MILLISECONDS_PER_YEAR,
      },
    ],
  },
  {
    name: 'next UTC date twelve-hour roll',
    shocks: [
      {
        factor: 'time',
        kind: 'absolute',
        value: TWELVE_HOURS / MILLISECONDS_PER_YEAR,
      },
    ],
  },
] satisfies ScenarioDefinition[];

interface ExpectedLevels {
  readonly spot: number;
  readonly volatility: number;
  readonly riskFreeRate: number;
  readonly dividendYield: number;
  readonly valuationInstant: number;
  readonly curve: RateCurve;
}

const baseLevels: ExpectedLevels = {
  spot: 100,
  volatility: 0.2,
  riskFreeRate: 0.04,
  dividendYield: 0.01,
  valuationInstant: AS_OF,
  curve: baseCurve,
};

const expectedScenarioLevels: readonly ExpectedLevels[] = [
  {
    spot: 105,
    volatility: 0.23,
    riskFreeRate: 0.045,
    dividendYield: 0.008,
    valuationInstant: AS_OF,
    curve: shockedCurve,
  },
  { ...baseLevels, valuationInstant: AS_OF + SIX_HOURS },
  { ...baseLevels, valuationInstant: AS_OF + TWELVE_HOURS },
];

type AnyCell = ScenarioBaseCell | ScenarioCell;

function fullRevaluationCell(cell: AnyCell | undefined, label: string) {
  expect(cell, label).toBeDefined();
  expect(cell?.status, label).toBe('complete');
  expect(cell?.valuationMethod, label).toBe('full-revaluation');
  if (
    cell === undefined ||
    cell.status !== 'complete' ||
    cell.valuationMethod !== 'full-revaluation'
  ) {
    throw new Error(`${label}: expected a successful full-revaluation cell.`);
  }
  return cell;
}

function taylorCell(cell: ScenarioCell | undefined, label: string) {
  expect(cell, label).toBeDefined();
  expect(cell?.status, label).toBe('complete');
  expect(cell?.valuationMethod, label).toBe('taylor');
  if (cell === undefined || cell.status !== 'complete' || cell.valuationMethod !== 'taylor') {
    throw new Error(`${label}: expected a successful Taylor cell.`);
  }
  return cell;
}

function fullRevaluationScenarioCell(cell: ScenarioCell | undefined, label: string) {
  const complete = fullRevaluationCell(cell, label);
  if (complete.kind !== 'scenario') {
    throw new Error(`${label}: expected a scenario cell, not a base cell.`);
  }
  return complete;
}

function baseCell(result: ScenarioRunResult, targetId: string): ScenarioBaseCell | undefined {
  return result.base.find((cell) => cell.targetId === targetId);
}

function scenarioCell(
  result: ScenarioRunResult,
  scenarioIndex: number,
  targetId: string,
): ScenarioCell | undefined {
  return result.cells.find(
    (cell) => cell.scenarioIndex === scenarioIndex && cell.targetId === targetId,
  );
}

function directOption(levels: ExpectedLevels) {
  return option.price({
    contract: optionContract,
    market: optionMarket({
      spot: levels.spot,
      volatility: levels.volatility,
      riskFreeRate: levels.riskFreeRate,
      dividendYield: levels.dividendYield,
      asOf: levels.valuationInstant,
    }),
  });
}

function directCurve(curve: RateCurve) {
  return curves.fromZeroRates(
    curve.points.map((point) => [point.date, point.zeroRate] as const),
    {
      referenceDate: new Date(curve.asOf).toISOString().slice(0, 10),
      dayCount: curve.dayCount,
      compounding: curve.compounding,
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    },
  );
}

function expectBondDirectParity(result: ScenarioPricingResult, levels: ExpectedLevels): void {
  const settlementDate = new Date(levels.valuationInstant).toISOString().slice(0, 10);
  const direct = priceMultiCurve(fixedBond, {
    settlementDate,
    discountCurve: directCurve(levels.curve),
  });
  const directAssumptionsFromAdapter = Object.fromEntries(
    Object.keys(direct.assumptions).map((key) => [key, result.assumptions[key]]),
  );

  expect(
    canonicalJsonOf({
      dirtyPrice: result['dirtyPrice'],
      cleanPrice: result['cleanPrice'],
      accruedInterest: result['accruedInterest'],
      assumptions: directAssumptionsFromAdapter,
      diagnostics: result.diagnostics,
    }),
  ).toBe(canonicalJsonOf(direct));
  expect(Object.is(result.value, direct.dirtyPrice)).toBe(true);
  expect(result.assumptions).toMatchObject({
    priceType: 'dirty',
    curveId: CURVE_ID,
    currency: 'USD',
    interpolation: 'logLinearDiscount',
    extrapolation: 'flatForward',
    valuationInstant: levels.valuationInstant,
    settlementDate,
    curveReferenceDate: '2026-01-01',
    settlementDateProjection: 'UTC calendar date containing valuationInstant',
  });
}

function directTaylorScenario(name: string, levels: ExpectedLevels): Scenario {
  return {
    name,
    // The runner passes all five explicit Taylor coordinates, including unchanged zero moves.
    shocks: [
      { factor: 'spot', kind: 'absolute', value: levels.spot - baseLevels.spot },
      {
        factor: 'volatility',
        kind: 'absolute',
        value: levels.volatility - baseLevels.volatility,
      },
      {
        factor: 'riskFreeRate',
        kind: 'absolute',
        value: levels.riskFreeRate - baseLevels.riskFreeRate,
      },
      {
        factor: 'time',
        kind: 'absolute',
        value: (levels.valuationInstant - baseLevels.valuationInstant) / MILLISECONDS_PER_YEAR,
      },
      {
        factor: 'dividend',
        kind: 'absolute',
        value: levels.dividendYield - baseLevels.dividendYield,
      },
    ],
  };
}

function reportingValues(cells: readonly AnyCell[]): number[] {
  return cells.map((cell) => {
    expect(cell.status).toBe('complete');
    if (cell.status !== 'complete') throw new Error(`target ${cell.targetId} did not complete.`);
    return cell.reportingPositionValue;
  });
}

describe('Stage 4.4b heterogeneous numerical parity', () => {
  it('preserves direct engines and reconciles one spot + option + bond + Taylor grid', () => {
    const spotPricer = spotAssetPricer();
    const result = runScenarios({
      scenarioSet: createScenarioSet({ name: 'heterogeneous parity', scenarios }),
      market: createMarketSnapshot({
        asOf: AS_OF,
        conventions: { dayCount: 'ACT/365F', compounding: 'continuous' },
        observations: {
          spots: { AAPL: { price: baseLevels.spot, currency: 'USD' } },
          volatilities: { AAPL: baseLevels.volatility },
          riskFreeRates: { USD: baseLevels.riskFreeRate },
          dividendYields: { AAPL: baseLevels.dividendYield },
          curves: { [CURVE_ID]: baseCurve },
        },
      }),
      targets: [
        scenarioTarget.fullRevaluation({
          id: 'spot:AAPL',
          quantity: 3,
          contractMultiplier: 1,
          currency: 'USD',
          underlying: 'AAPL',
          strategy: 'equity',
          instrument: { symbol: 'AAPL' },
          instrumentDescriptor: { kind: 'spot-asset', symbol: 'AAPL' },
          pricer: spotPricer,
        }),
        scenarioTarget.fullRevaluation({
          id: 'option:AAPL-call',
          quantity: 2,
          contractMultiplier: 100,
          currency: 'USD',
          underlying: 'AAPL',
          strategy: 'long-call',
          instrument: optionContract,
          instrumentDescriptor: { kind: 'option-contract', contract: optionContract },
          pricer: optionContractPricer(),
        }),
        scenarioTarget.fullRevaluation({
          id: 'bond:USD-fixed',
          quantity: 4,
          contractMultiplier: 1,
          currency: 'USD',
          underlying: CURVE_ID,
          strategy: 'rates',
          instrument: fixedBond,
          instrumentDescriptor: {
            kind: 'fixed-rate-bond',
            issueDate: '2025-01-01',
            maturityDate: '2031-01-01',
            couponRate: 0.05,
            frequency: 'semiannual',
            faceValue: 100,
            dayCount: '30/360',
          },
          pricer: bondDiscountCurvePricer({
            curveId: CURVE_ID,
            currency: 'USD',
            priceType: 'dirty',
            interpolation: 'logLinearDiscount',
            extrapolation: 'flatForward',
          }),
        }),
        scenarioTarget.taylor({
          id: 'strategy:AAPL-taylor',
          quantity: -1.5,
          contractMultiplier: 100,
          currency: 'USD',
          underlying: 'AAPL',
          strategy: 'delta-hedge',
          baseValuePerUnit: 17,
          greeks: taylorGreeks,
          factors: {
            spot: { subject: 'AAPL', level: baseLevels.spot },
            volatility: { subject: 'AAPL', level: baseLevels.volatility },
            riskFreeRate: { subject: 'USD', level: baseLevels.riskFreeRate },
            dividend: { subject: 'AAPL', level: baseLevels.dividendYield },
            valuationInstant: { level: baseLevels.valuationInstant },
          },
        }),
      ],
    });

    expect(result.layout).toMatchObject({ targetCount: 4, scenarioCount: 3, cellCount: 12 });
    expect(result.diagnostics.failures).toEqual([]);

    const spotBase = fullRevaluationCell(baseCell(result, 'spot:AAPL'), 'spot base');
    const optionBase = fullRevaluationCell(baseCell(result, 'option:AAPL-call'), 'option base');
    const bondBase = fullRevaluationCell(baseCell(result, 'bond:USD-fixed'), 'bond base');

    const directSpotBase = spotPricer.price({
      instrument: { symbol: 'AAPL' },
      observations: [{ requirement: { kind: 'spot', symbol: 'AAPL' }, value: baseLevels.spot }],
    });
    expect(spotBase.valuePerUnit).toBe(baseLevels.spot);
    expect(canonicalJsonOf(spotBase.pricingResult)).toBe(canonicalJsonOf(directSpotBase));
    expect(canonicalJsonOf(optionBase.pricingResult)).toBe(
      canonicalJsonOf(directOption(baseLevels)),
    );
    expectBondDirectParity(bondBase.pricingResult, baseLevels);

    const directTaylorGreeks: PositionGreeks = {
      value: 17,
      spot: baseLevels.spot,
      ...taylorGreeks,
    };

    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
      const definition = scenarios[scenarioIndex]!;
      const levels = expectedScenarioLevels[scenarioIndex]!;
      const spot = fullRevaluationScenarioCell(
        scenarioCell(result, scenarioIndex, 'spot:AAPL'),
        `${definition.name} spot`,
      );
      const optionResult = fullRevaluationScenarioCell(
        scenarioCell(result, scenarioIndex, 'option:AAPL-call'),
        `${definition.name} option`,
      );
      const bond = fullRevaluationScenarioCell(
        scenarioCell(result, scenarioIndex, 'bond:USD-fixed'),
        `${definition.name} bond`,
      );
      const taylor = taylorCell(
        scenarioCell(result, scenarioIndex, 'strategy:AAPL-taylor'),
        `${definition.name} Taylor`,
      );

      const directSpot = spotPricer.price({
        instrument: { symbol: 'AAPL' },
        observations: [{ requirement: { kind: 'spot', symbol: 'AAPL' }, value: levels.spot }],
      });
      expect(spot.valuePerUnit).toBe(levels.spot);
      expect(canonicalJsonOf(spot.pricingResult)).toBe(canonicalJsonOf(directSpot));

      // Complete canonical equality includes value, every Greek, assumptions, warnings, engine,
      // and the automatic selection report; the runner has neither recomputed nor projected it.
      expect(canonicalJsonOf(optionResult.pricingResult)).toBe(
        canonicalJsonOf(directOption(levels)),
      );

      expectBondDirectParity(bond.pricingResult, levels);

      const directTaylor = taylorPnl(
        directTaylorGreeks,
        directTaylorScenario(definition.name, levels),
      );
      expect(canonicalJsonOf(taylor.taylorResult)).toBe(canonicalJsonOf(directTaylor));
      expect(Object.is(taylor.valuePerUnit, 17 + directTaylor.total)).toBe(true);

      const scenarioCells = result.cells.filter((cell) => cell.scenarioIndex === scenarioIndex);
      const grandTotal = result.aggregates.scenarios[scenarioIndex]!.rows.find(
        (row) => row.group === 'grand-total',
      );
      expect(grandTotal).toMatchObject({
        key: 'all',
        status: 'complete',
        reportingCurrency: 'USD',
        targetIds: ['spot:AAPL', 'option:AAPL-call', 'bond:USD-fixed', 'strategy:AAPL-taylor'],
        failedTargetIds: [],
        baseValue: stableSum(reportingValues(result.base)),
        scenarioValue: stableSum(reportingValues(scenarioCells)),
        pnl: stableSum(
          scenarioCells.map((cell) => {
            expect(cell.status).toBe('complete');
            if (cell.status !== 'complete') throw new Error(`${cell.targetId} did not complete.`);
            return cell.reportingPnl;
          }),
        ),
      });
    }

    const sameDayBond = fullRevaluationScenarioCell(
      scenarioCell(result, 1, 'bond:USD-fixed'),
      'same-day bond',
    );
    expect(new Date(AS_OF + SIX_HOURS).toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(Object.is(sameDayBond.valuePerUnit, bondBase.valuePerUnit)).toBe(true);
    expect(Object.is(sameDayBond.localPnl, 0)).toBe(true);
    expect(sameDayBond.pricingResult.assumptions['settlementDate']).toBe('2026-06-15');
    expect(sameDayBond.pricingResult.assumptions['valuationInstant']).toBe(AS_OF + SIX_HOURS);

    const nextDayBond = fullRevaluationScenarioCell(
      scenarioCell(result, 2, 'bond:USD-fixed'),
      'next-day bond',
    );
    expect(new Date(AS_OF + TWELVE_HOURS).toISOString().slice(0, 10)).toBe('2026-06-16');
    expect(nextDayBond.pricingResult.assumptions['settlementDate']).toBe('2026-06-16');
    expect(Object.is(nextDayBond.valuePerUnit, bondBase.valuePerUnit)).toBe(false);
  });
});
