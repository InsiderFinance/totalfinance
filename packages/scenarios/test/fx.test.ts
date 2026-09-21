import { describe, expect, it } from 'vitest';
import { ErrorCode, WarningCode } from '@totalfinance/core';
import { createScenarioSet } from '@totalfinance/core/artifacts';
import {
  convertReportingValue,
  convertScenarioPositionValues,
  prepareCurrencyPlan,
  transformCurrencyPlan,
} from '../src/fx.js';
import { scenarioTarget } from '../src/targets.js';
import type { ScenarioTargetDescriptor } from '../src/types.js';

function target(id: string, currency: string): ScenarioTargetDescriptor {
  return JSON.parse(
    JSON.stringify(scenarioTarget.spot({ id, symbol: id.toUpperCase(), quantity: 1, currency })),
  ) as ScenarioTargetDescriptor;
}

describe('reporting-currency planning and transformation', () => {
  it('binds exact direct and inverted quotes and leaves same-currency targets unconverted', () => {
    const plan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [
        { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 },
        { baseCurrency: 'USD', quoteCurrency: 'JPY', quotePerBase: 150 },
      ],
      targets: [target('usd', 'USD'), target('eur', 'EUR'), target('jpy', 'JPY')],
    });

    expect(plan.conversionsByTarget).toEqual([
      null,
      expect.objectContaining({ sourceQuoteIndex: 0, orientation: 'direct' }),
      expect.objectContaining({ sourceQuoteIndex: 1, orientation: 'inverted' }),
    ]);
    expect(plan.targetCoordinateCounts).toEqual([0, 1, 1]);
    expect(plan.usedSourceQuoteIndices).toEqual([0, 1]);
    expect(
      convertReportingValue({
        amount: 150,
        valuationCurrency: 'JPY',
        reportingCurrency: 'USD',
        currencyConversion: plan.conversionsByTarget[2]!,
      }),
    ).toBeCloseTo(1);
  });

  it('infers reporting currency only for a homogeneous target set', () => {
    expect(
      prepareCurrencyPlan({
        reportingCurrency: undefined,
        currencyConversions: [],
        targets: [target('one', 'USD'), target('two', 'USD')],
      }).reportingCurrency,
    ).toBe('USD');

    expect(() =>
      prepareCurrencyPlan({
        reportingCurrency: undefined,
        currencyConversions: [],
        targets: [target('one', 'USD'), target('two', 'EUR')],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputMissingField }));
  });

  it('rejects duplicate pair candidates instead of choosing by source order', () => {
    expect(() =>
      prepareCurrencyPlan({
        reportingCurrency: 'USD',
        currencyConversions: [
          { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 },
          { baseCurrency: 'USD', quoteCurrency: 'EUR', quotePerBase: 0.8 },
        ],
        targets: [target('eur', 'EUR')],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputOutOfRange }));
  });

  it('reports unused valid quotes without letting them affect conversion', () => {
    const plan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [
        { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 },
        { baseCurrency: 'GBP', quoteCurrency: 'USD', quotePerBase: 1.3 },
      ],
      targets: [target('eur', 'EUR')],
    });

    expect(plan.unusedCurrencyConversions).toEqual([
      { baseCurrency: 'GBP', quoteCurrency: 'USD', quotePerBase: 1.3 },
    ]);
    expect(plan.warnings).toEqual([
      expect.objectContaining({ code: WarningCode.ScenarioUnusedCurrencyConversion }),
    ]);
  });

  it('applies overrides before ordered shocks to used quotes and records exact evidence', () => {
    const plan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 }],
      targets: [target('eur', 'EUR')],
    });
    const set = createScenarioSet({
      name: 'fx-order',
      scenarios: [
        {
          name: 'ordered',
          overrides: [{ factor: 'foreignExchangeRate', target: 'EUR/USD', value: 1.25 }],
          shocks: [
            {
              factor: 'foreignExchangeRate',
              target: 'EUR/USD',
              kind: 'percent',
              value: 0.1,
            },
            {
              factor: 'foreignExchangeRate',
              target: 'EUR/USD',
              kind: 'absolute',
              value: -0.025,
            },
          ],
        },
      ],
    });
    const transformed = transformCurrencyPlan({ plan, scenarioDefinitions: set.scenarios });

    expect(transformed.scenarios[0]!.conversionsByTarget[0]!.quote.quotePerBase).toBeCloseTo(1.35);
    expect(transformed.scenarios[0]!.appliedInstructionsByTarget[0]).toEqual([
      expect.objectContaining({ phase: 'override', before: 1.2, after: 1.25 }),
      expect.objectContaining({ phase: 'shock', instructionIndex: 0, before: 1.25, after: 1.375 }),
      expect.objectContaining({ phase: 'shock', instructionIndex: 1, before: 1.375, after: 1.35 }),
    ]);
    expect([...transformed.matchedInstructions]).toEqual([
      '0:override:0',
      '0:shock:0',
      '0:shock:1',
    ]);
  });

  it('keeps a differently targeted FX instruction unmatched', () => {
    const plan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 }],
      targets: [target('eur', 'EUR')],
    });
    const set = createScenarioSet({
      name: 'fx-target',
      scenarios: [
        {
          name: 'wrong pair',
          shocks: [
            {
              factor: 'foreignExchangeRate',
              target: 'GBP/USD',
              kind: 'percent',
              value: 0.1,
            },
          ],
        },
      ],
    });
    const transformed = transformCurrencyPlan({ plan, scenarioDefinitions: set.scenarios });

    expect(transformed.matchedInstructions.size).toBe(0);
    expect(transformed.scenarios[0]!.conversionsByTarget[0]!.quote.quotePerBase).toBe(1.2);
    expect(transformed.scenarios[0]!.appliedInstructionsByTarget[0]).toEqual([]);
  });

  it('computes reporting P&L from independently converted base and scenario values', () => {
    const basePlan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 }],
      targets: [target('eur', 'EUR')],
    });
    const scenarioPlan = transformCurrencyPlan({
      plan: basePlan,
      scenarioDefinitions: [
        {
          name: 'fx up',
          shocks: [{ factor: 'foreignExchangeRate', kind: 'percent', value: 0.1 }],
        },
      ],
    });

    expect(
      convertScenarioPositionValues({
        basePositionValue: 100,
        scenarioPositionValue: 100,
        valuationCurrency: 'EUR',
        reportingCurrency: 'USD',
        baseCurrencyConversion: basePlan.conversionsByTarget[0]!,
        scenarioCurrencyConversion: scenarioPlan.scenarios[0]!.conversionsByTarget[0]!,
      }),
    ).toEqual({
      baseReportingPositionValue: 120,
      scenarioReportingPositionValue: 132,
      reportingPnl: 12,
    });
  });

  it('deeply freezes and detaches plans from caller-owned quote records', () => {
    const quote = { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.2 };
    const plan = prepareCurrencyPlan({
      reportingCurrency: 'USD',
      currencyConversions: [quote],
      targets: [target('eur', 'EUR')],
    });
    quote.quotePerBase = 9;

    expect(plan.currencyConversions[0]!.quotePerBase).toBe(1.2);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.currencyConversions)).toBe(true);
    expect(Object.isFrozen(plan.currencyConversions[0])).toBe(true);
  });
});
