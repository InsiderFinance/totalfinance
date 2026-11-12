import { bonds, priceFromYield, yieldMetrics } from '@insiderfinance/totalfinance/fixed-income';
import type { Playground } from '../types';
import { numberInput, stringInput } from './inputs';

const FREQUENCIES = ['annual', 'semiannual', 'quarterly'] as const;

export const bond: Playground = {
  id: 'price-a-bond',
  title: 'Price a fixed-rate bond',
  introduction:
    'Price a newly issued fixed-rate bond from its yield, read its duration, convexity and DV01, and see how price responds as yields move. Prices are per 100 of face value; day count is 30/360.',
  controls: [
    {
      name: 'yield',
      label: 'Yield to maturity',
      unit: 'decimal · annualized',
      value: 0.05,
      min: 0.0005,
      max: 0.3,
      step: 0.0025,
      display: 'decimal-percent',
    },
    {
      name: 'couponRate',
      label: 'Coupon rate',
      unit: 'decimal · annual',
      value: 0.045,
      min: 0,
      max: 0.25,
      step: 0.0025,
      display: 'decimal-percent',
    },
    {
      name: 'years',
      label: 'Years to maturity',
      unit: 'years · integer',
      value: 10,
      min: 1,
      max: 30,
      step: 1,
      display: 'integer',
    },
    {
      kind: 'select',
      name: 'frequency',
      label: 'Coupon frequency',
      value: 'semiannual',
      options: [
        { value: 'annual', label: 'Annual' },
        { value: 'semiannual', label: 'Semiannual' },
        { value: 'quarterly', label: 'Quarterly' },
      ],
    },
  ],
  run(input) {
    const yieldToMaturity = numberInput(input, 'yield');
    const couponRate = numberInput(input, 'couponRate');
    const years = numberInput(input, 'years');
    const frequencyName = stringInput(input, 'frequency');
    if (!Number.isInteger(years)) throw new Error('Years to maturity must be a whole number.');
    const frequency = FREQUENCIES.find((candidate) => candidate === frequencyName);
    if (!frequency) throw new Error('Coupon frequency must be annual, semiannual or quarterly.');
    const specification = {
      issueDate: '2026-01-01',
      maturityDate: `${2026 + years}-01-01`,
      couponRate,
      frequency,
      faceValue: 100,
      dayCount: '30/360' as const,
    };
    const instrument = bonds.fixedRate(specification);
    const settlementDate = '2026-01-01';
    const metrics = yieldMetrics(instrument, { settlementDate, yield: yieldToMaturity });
    // 41 yields, ±4 percentage points around the input (never below 0.05%), rounded to a millionth.
    const yields = Array.from(
      { length: 41 },
      (_, index) =>
        Math.round(Math.max(0.0005, yieldToMaturity - 0.04 + index * 0.002) * 1e6) / 1e6,
    ).filter((value, index, all) => all.indexOf(value) === index);
    const curve = yields.map((value) => ({
      yield: value,
      cleanPrice: priceFromYield(instrument, { settlementDate, yield: value }).cleanPrice,
    }));
    const cashflows = instrument.cashflows();
    const result = { metrics, curve, cashflows };
    const specificationCode = JSON.stringify(specification, null, 2);
    return {
      metrics: [
        { label: 'Clean price', value: metrics.cleanPrice, unit: 'per 100 face' },
        {
          label: 'Modified duration',
          value: metrics.modifiedDuration,
          unit: '% price change per 1% yield',
        },
        { label: 'Macaulay duration', value: metrics.macaulayDuration, unit: 'years' },
        { label: 'Convexity', value: metrics.convexity, unit: 'years²' },
        { label: 'DV01', value: metrics.dv01, unit: 'price change per 1 bp, per 100 face' },
      ],
      chart: {
        title: 'Price across yields',
        caption:
          'The curve bends: price rises more when yields fall than it falls when yields rise by the same amount. That curvature is convexity.',
        xLabel: 'Yield to maturity',
        yLabel: 'Clean price · per 100 face',
        xFormat: 'decimal-percent',
        series: [
          {
            name: 'Clean price',
            points: curve.map((point) => ({ x: point.yield, y: point.cleanPrice })),
          },
        ],
        markers: [
          {
            x: yieldToMaturity,
            label: `Yield ${(yieldToMaturity * 100).toFixed(2)}%`,
            tone: 'brand',
          },
          { y: 100, label: 'Par (100)', tone: 'neutral' },
        ],
      },
      additionalCharts: [
        {
          kind: 'bars',
          title: 'Cash flows to maturity',
          caption: 'Coupons each period, then the coupon plus the 100 face value at maturity.',
          xLabel: 'Payment date',
          yLabel: 'Cash flow · per 100 face',
          bars: cashflows.map((flow) => ({
            label: flow.paymentDate,
            value: flow.amount,
            tone: flow.principal > 0 ? ('brand' as const) : ('neutral' as const),
          })),
        },
      ],
      assumptions: metrics.assumptions,
      diagnostics: metrics.diagnostics,
      result,
      example: {
        description:
          'yieldMetrics returns prices, accrued interest, Macaulay and modified duration, convexity and DV01 at one yield, with the applied conventions echoed in assumptions. The bond itself is an ordinary object with its schedule and cash flows.',
        code: `import { bonds, yieldMetrics } from '@insiderfinance/totalfinance/fixed-income';\n\nconst bond = bonds.fixedRate(${specificationCode});\nconst result = yieldMetrics(bond, { settlementDate: '${settlementDate}', yield: ${yieldToMaturity} });\nconsole.log(result);`,
        result: metrics,
      },
      code: `import { bonds, priceFromYield, yieldMetrics } from '@insiderfinance/totalfinance/fixed-income';\n\nconst bond = bonds.fixedRate(${specificationCode});\nconst settlementDate = '${settlementDate}';\nconst yields = ${JSON.stringify(yields)};\nconst result = {\n  metrics: yieldMetrics(bond, { settlementDate, yield: ${yieldToMaturity} }),\n  curve: yields.map((value) => ({\n    yield: value,\n    cleanPrice: priceFromYield(bond, { settlementDate, yield: value }).cleanPrice,\n  })),\n  cashflows: bond.cashflows(),\n};\nconsole.log(result);`,
    };
  },
};
