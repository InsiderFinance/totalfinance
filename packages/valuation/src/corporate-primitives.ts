/**
 * FC2 — cost of capital and corporate cash-flow primitives. The named formulas are FIXED by the
 * capability spec; a function never silently swaps net income for operating income, total debt
 * change for net borrowing, or cash for operating working capital — the field names demand the
 * exact quantity and the docs say what it is.
 */

import {
  requireRepresentableResult,
  stableSum,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

// ---------------------------------------------------------------------------------------------------
// Expected return and component costs
// ---------------------------------------------------------------------------------------------------

/** Input for {@link capitalAssetPricingExpectedReturn}. */
export interface CapitalAssetPricingInput {
  /** Annual risk-free rate (decimal). */
  annualRiskFreeRate: number;
  beta: number;
  /** Annual market risk premium (decimal) — the premium itself, not the market return. */
  annualMarketRiskPremium: number;
}

/**
 * `riskFree + beta · premium` evaluated so a REPRESENTABLE answer is never lost to an
 * intermediate overflow (2026-08-23 review wave: `beta · premium` can pass `Number.MAX_VALUE`
 * while the sum cancels back into range). Normal magnitudes take the plain expression bit-for-bit;
 * the scaled fallback divides through by the dominant magnitude first, so only a truly
 * unrepresentable answer reaches the finalizer.
 */
function capitalAssetPricingKernel(
  functionName: string,
  riskFree: number,
  beta: number,
  premium: number,
): number {
  const plain = riskFree + beta * premium;
  if (Number.isFinite(plain)) return plain;
  const scale = Math.max(Math.abs(riskFree), Math.abs(premium), 1);
  return requireRepresentableResult(
    functionName,
    scale * (riskFree / scale + beta * (premium / scale)),
  );
}

/**
 * Capital-asset-pricing expected return = annual risk-free rate + beta × annual market risk
 * premium. The premium is supplied AS a premium — passing the market return here would double the
 * risk-free rate, so the field name says exactly which number it wants.
 */
export function capitalAssetPricingExpectedReturn(input: CapitalAssetPricingInput): number {
  requireArgumentObject('capitalAssetPricingExpectedReturn', 'input', input);
  ensureKnownKeys('capitalAssetPricingExpectedReturn', 'input', input, [
    'annualRiskFreeRate',
    'beta',
    'annualMarketRiskPremium',
  ]);
  requireFiniteFields(
    'capitalAssetPricingExpectedReturn',
    input as unknown as Record<string, unknown>,
    ['annualRiskFreeRate', 'beta', 'annualMarketRiskPremium'],
    {
      exampleCall:
        'capitalAssetPricingExpectedReturn({ annualRiskFreeRate: 0.04, beta: 1.2, annualMarketRiskPremium: 0.05 })',
    },
  );
  return capitalAssetPricingKernel(
    'capitalAssetPricingExpectedReturn',
    input.annualRiskFreeRate,
    input.beta,
    input.annualMarketRiskPremium,
  );
}

/** Input for {@link costOfEquity} — the method is an explicit discriminant, never inferred. */
export type CostOfEquityInput =
  | {
      method: 'capital-asset-pricing';
      annualRiskFreeRate: number;
      beta: number;
      annualMarketRiskPremium: number;
    }
  | {
      method: 'dividend-growth';
      /** The NEXT annual dividend per share (already grown one period). */
      nextAnnualDividendPerShare: number;
      sharePrice: number;
      perpetualGrowthRate: number;
    };

/**
 * Cost of equity under an EXPLICIT method: `'capital-asset-pricing'` (risk-free + beta × premium)
 * or `'dividend-growth'` (next dividend / price + growth). The dividend-growth form requires a
 * positive share price and takes the NEXT dividend — the field name carries the timing so the
 * one-period growth step is never applied twice or forgotten.
 */
export function costOfEquity(input: CostOfEquityInput): number {
  requireArgumentObject('costOfEquity', 'input', input);
  if (input.method === 'capital-asset-pricing') {
    ensureKnownKeys('costOfEquity', 'input', input, [
      'method',
      'annualRiskFreeRate',
      'beta',
      'annualMarketRiskPremium',
    ]);
    requireFiniteFields(
      'costOfEquity',
      input as unknown as Record<string, unknown>,
      ['annualRiskFreeRate', 'beta', 'annualMarketRiskPremium'],
      {
        exampleCall:
          "costOfEquity({ method: 'capital-asset-pricing', annualRiskFreeRate: 0.04, beta: 1.2, annualMarketRiskPremium: 0.05 })",
      },
    );
    return capitalAssetPricingKernel(
      'costOfEquity',
      input.annualRiskFreeRate,
      input.beta,
      input.annualMarketRiskPremium,
    );
  }
  if (input.method === 'dividend-growth') {
    ensureKnownKeys('costOfEquity', 'input', input, [
      'method',
      'nextAnnualDividendPerShare',
      'sharePrice',
      'perpetualGrowthRate',
    ]);
    requireFiniteFields(
      'costOfEquity',
      input as unknown as Record<string, unknown>,
      ['nextAnnualDividendPerShare', 'sharePrice', 'perpetualGrowthRate'],
      {
        exampleCall:
          "costOfEquity({ method: 'dividend-growth', nextAnnualDividendPerShare: 2.1, sharePrice: 42, perpetualGrowthRate: 0.03 })",
      },
    );
    if (input.sharePrice <= 0) {
      throw new InputError(
        `costOfEquity: sharePrice must be > 0 for the dividend-growth method. Received ${input.sharePrice}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'sharePrice' } },
      );
    }
    return requireRepresentableResult(
      'costOfEquity',
      input.nextAnnualDividendPerShare / input.sharePrice + input.perpetualGrowthRate,
    );
  }
  const received = (input as { method?: unknown }).method;
  throw new InputError(
    `costOfEquity: method must be 'capital-asset-pricing' | 'dividend-growth'. Received ${received === null ? 'null' : JSON.stringify(received)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { field: 'method' } },
  );
}

/** Input for {@link afterTaxCostOfDebt}. */
export interface AfterTaxCostOfDebtInput {
  /** Annual pre-tax cost of debt (decimal). */
  annualPreTaxCostOfDebt: number;
  /** Marginal tax rate in [0, 1). */
  marginalTaxRate: number;
  /**
   * An EXPLICIT adjustment (decimal, added to the after-tax cost) for a tax shield the company
   * cannot use — supplied, never inferred from losses or carryforwards.
   */
  unusableTaxShieldAdjustment?: number;
}

/**
 * After-tax cost of debt = annual pre-tax cost × (1 − marginal tax rate), plus any EXPLICIT
 * unusable-tax-shield adjustment.
 */
export function afterTaxCostOfDebt(input: AfterTaxCostOfDebtInput): number {
  requireArgumentObject('afterTaxCostOfDebt', 'input', input);
  ensureKnownKeys('afterTaxCostOfDebt', 'input', input, [
    'annualPreTaxCostOfDebt',
    'marginalTaxRate',
    'unusableTaxShieldAdjustment',
  ]);
  requireFiniteFields(
    'afterTaxCostOfDebt',
    input as unknown as Record<string, unknown>,
    ['annualPreTaxCostOfDebt', 'marginalTaxRate'],
    { exampleCall: 'afterTaxCostOfDebt({ annualPreTaxCostOfDebt: 0.06, marginalTaxRate: 0.21 })' },
  );
  if (input.marginalTaxRate < 0 || input.marginalTaxRate >= 1) {
    throw new InputError(
      `afterTaxCostOfDebt: marginalTaxRate must be in [0, 1). Received ${input.marginalTaxRate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'marginalTaxRate' } },
    );
  }
  if (
    input.unusableTaxShieldAdjustment !== undefined &&
    (typeof input.unusableTaxShieldAdjustment !== 'number' ||
      !Number.isFinite(input.unusableTaxShieldAdjustment))
  ) {
    throw new InputError(
      `afterTaxCostOfDebt: unusableTaxShieldAdjustment must be a finite decimal when provided. Received ${input.unusableTaxShieldAdjustment === null ? 'null' : String(input.unusableTaxShieldAdjustment)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'unusableTaxShieldAdjustment' } },
    );
  }
  return requireRepresentableResult(
    'afterTaxCostOfDebt',
    input.annualPreTaxCostOfDebt * (1 - input.marginalTaxRate) +
      (input.unusableTaxShieldAdjustment !== undefined ? input.unusableTaxShieldAdjustment : 0),
  );
}

// ---------------------------------------------------------------------------------------------------
// Weighted-average cost of capital
// ---------------------------------------------------------------------------------------------------

/** One market-value capital component with its (already after-tax where applicable) annual cost. */
export interface CapitalComponent {
  /** e.g. 'equity', 'debt', 'preferred' — a label, echoed; the math treats components uniformly. */
  label: string;
  /** Market value, ≥ 0. */
  marketValue: number;
  /** The component's annual cost (decimal). Tax shields are applied BEFORE this input, explicitly. */
  annualCostOfCapital: number;
}

/** Input for {@link weightedAverageCostOfCapital}. */
export interface WeightedAverageCostOfCapitalInput {
  components: readonly CapitalComponent[];
}

/** Result of {@link weightedAverageCostOfCapital}. */
export interface WeightedAverageCostOfCapitalResult {
  assumptions: {
    weightBasis: 'market values, normalized to sum to one';
    componentCount: number;
  };
  diagnostics: { warnings: string[] };
  weightedAverageCostOfCapital: number;
  /**
   * `null` when the summed capital base exceeds `Number.MAX_VALUE` — the WEIGHTS and the average
   * are still exact (computed in scaled space), but the raw total itself has no IEEE-754
   * representation; `totalCapitalAbsentReason` says so (2026-08-23 review wave).
   */
  totalCapital: number | null;
  totalCapitalAbsentReason?: string;
  /** Normalized weights, echoed per component — they sum to one by construction. */
  components: Array<{
    label: string;
    marketValue: number;
    weight: number;
    annualCostOfCapital: number;
    contribution: number;
  }>;
}

/**
 * Market-value weighted average of the supplied component costs. Weights are normalized from the
 * market values and REPORTED; a zero or negative total capital base is refused — there is no
 * average over nothing. Tax shields are explicit: hand this function the after-tax cost of debt
 * (see {@link afterTaxCostOfDebt}), it never applies a tax rate itself.
 */
export function weightedAverageCostOfCapital(
  input: WeightedAverageCostOfCapitalInput,
): WeightedAverageCostOfCapitalResult {
  requireArgumentObject('weightedAverageCostOfCapital', 'input', input);
  ensureKnownKeys('weightedAverageCostOfCapital', 'input', input, ['components']);
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new InputError(
      `weightedAverageCostOfCapital: components must be a non-empty array.\n  e.g. weightedAverageCostOfCapital({ components: [{ label: 'equity', marketValue: 700, annualCostOfCapital: 0.1 }, { label: 'debt', marketValue: 300, annualCostOfCapital: 0.045 }] })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'components' } },
    );
  }
  input.components.forEach((component, index) => {
    requireArgumentObject('weightedAverageCostOfCapital', `components[${index}]`, component);
    ensureKnownKeys('weightedAverageCostOfCapital', `components[${index}]`, component, [
      'label',
      'marketValue',
      'annualCostOfCapital',
    ]);
    if (typeof component.label !== 'string' || component.label.length === 0) {
      throw new InputError(
        `weightedAverageCostOfCapital: components[${index}].label must be a non-empty string. Received ${component.label === null ? 'null' : typeof component.label}.`,
        { code: ErrorCode.InputWrongType, context: { field: `components[${index}].label` } },
      );
    }
    for (const field of ['marketValue', 'annualCostOfCapital'] as const) {
      const value = component[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InputError(
          `weightedAverageCostOfCapital: components[${index}].${field} must be a finite number. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field: `components[${index}].${field}` } },
        );
      }
    }
    if (component.marketValue < 0) {
      throw new InputError(
        `weightedAverageCostOfCapital: components[${index}].marketValue must be ≥ 0 — a negative market-value weight has no meaning in a capital base. Received ${component.marketValue}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `components[${index}].marketValue` } },
      );
    }
  });
  const naiveTotal = input.components.reduce(
    (total, component) => total + component.marketValue,
    0,
  );
  if (naiveTotal <= 0) {
    throw new InputError(
      `weightedAverageCostOfCapital: the total capital base must be positive — received ${naiveTotal}. A zero base has no weights to normalize.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'components' } },
    );
  }
  // Weights survive an unrepresentable TOTAL (2026-08-23 review wave: two near-MAX market values
  // summed to Infinity, so every weight collapsed to 0 and the average to 0 — a silently WRONG
  // finite answer). Market values are ≥ 0, so the naive sum overflows only when the true total is
  // genuinely past `Number.MAX_VALUE`; the weights and the average are still exact in scaled
  // space (divide every value by the largest first), and only `totalCapital` itself goes absent.
  const scale = Number.isFinite(naiveTotal)
    ? 1
    : input.components.reduce((max, component) => Math.max(max, component.marketValue), 0);
  const scaledTotal = input.components.reduce(
    (total, component) => total + component.marketValue / scale,
    0,
  );
  const components = input.components.map((component) => {
    const weight = component.marketValue / scale / scaledTotal;
    return {
      label: component.label,
      marketValue: component.marketValue,
      weight,
      annualCostOfCapital: component.annualCostOfCapital,
      contribution: weight * component.annualCostOfCapital,
    };
  });
  const totalCapital = scale * scaledTotal;
  const warnings: string[] = [];
  let totalCapitalAbsentReason: string | undefined;
  if (!Number.isFinite(totalCapital)) {
    totalCapitalAbsentReason =
      'the summed capital base exceeds Number.MAX_VALUE and has no IEEE-754 representation; weights and the average are computed in scaled space and remain exact';
    warnings.push(`totalCapital is absent: ${totalCapitalAbsentReason}`);
  }
  return requireRepresentableResult('weightedAverageCostOfCapital', {
    assumptions: {
      weightBasis: 'market values, normalized to sum to one' as const,
      componentCount: components.length,
    },
    diagnostics: { warnings },
    weightedAverageCostOfCapital: components.reduce((total, row) => total + row.contribution, 0),
    totalCapital: Number.isFinite(totalCapital) ? totalCapital : null,
    ...(totalCapitalAbsentReason === undefined ? {} : { totalCapitalAbsentReason }),
    components,
  });
}

// ---------------------------------------------------------------------------------------------------
// Free cash flow
// ---------------------------------------------------------------------------------------------------

/** Input for {@link freeCashFlowToFirm} — the exact quantities, never proxies. */
export interface FreeCashFlowToFirmInput {
  operatingIncome: number;
  /** Tax rate in [0, 1) applied to operating income. */
  taxRate: number;
  depreciationAndAmortization: number;
  capitalExpenditure: number;
  /** The INCREASE in net working capital over the period (a decrease is negative). */
  increaseInNetWorkingCapital: number;
}

/**
 * FCFF = operating income × (1 − tax rate) + depreciation/amortization − capital expenditure −
 * increase in net working capital. Wants OPERATING income — handing it net income double-counts
 * interest, and the field name refuses the swap.
 */
export function freeCashFlowToFirm(input: FreeCashFlowToFirmInput): number {
  requireArgumentObject('freeCashFlowToFirm', 'input', input);
  ensureKnownKeys('freeCashFlowToFirm', 'input', input, [
    'operatingIncome',
    'taxRate',
    'depreciationAndAmortization',
    'capitalExpenditure',
    'increaseInNetWorkingCapital',
  ]);
  requireFiniteFields(
    'freeCashFlowToFirm',
    input as unknown as Record<string, unknown>,
    [
      'operatingIncome',
      'taxRate',
      'depreciationAndAmortization',
      'capitalExpenditure',
      'increaseInNetWorkingCapital',
    ],
    {
      exampleCall:
        'freeCashFlowToFirm({ operatingIncome: 180, taxRate: 0.21, depreciationAndAmortization: 45, capitalExpenditure: 70, increaseInNetWorkingCapital: 15 })',
    },
  );
  if (input.taxRate < 0 || input.taxRate >= 1) {
    throw new InputError(
      `freeCashFlowToFirm: taxRate must be in [0, 1). Received ${input.taxRate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'taxRate' } },
    );
  }
  // stableSum, not left-to-right: `1e308 + 1e308 − 1e308 − 1e308` is exactly 0, and refusing it
  // because the second partial sum overflowed would be a lie (2026-08-23, fourth review).
  return requireRepresentableResult(
    'freeCashFlowToFirm',
    stableSum([
      input.operatingIncome * (1 - input.taxRate),
      input.depreciationAndAmortization,
      -input.capitalExpenditure,
      -input.increaseInNetWorkingCapital,
    ]),
  );
}

/** Input for {@link freeCashFlowToEquity} — net borrowing is NET, not the total debt change. */
export interface FreeCashFlowToEquityInput {
  netIncome: number;
  depreciationAndAmortization: number;
  capitalExpenditure: number;
  /** The INCREASE in net working capital over the period (a decrease is negative). */
  increaseInNetWorkingCapital: number;
  /** New borrowing minus repayments over the period. */
  netBorrowing: number;
}

/**
 * FCFE = net income + depreciation/amortization − capital expenditure − increase in net working
 * capital + net borrowing.
 */
export function freeCashFlowToEquity(input: FreeCashFlowToEquityInput): number {
  requireArgumentObject('freeCashFlowToEquity', 'input', input);
  ensureKnownKeys('freeCashFlowToEquity', 'input', input, [
    'netIncome',
    'depreciationAndAmortization',
    'capitalExpenditure',
    'increaseInNetWorkingCapital',
    'netBorrowing',
  ]);
  requireFiniteFields(
    'freeCashFlowToEquity',
    input as unknown as Record<string, unknown>,
    [
      'netIncome',
      'depreciationAndAmortization',
      'capitalExpenditure',
      'increaseInNetWorkingCapital',
      'netBorrowing',
    ],
    {
      exampleCall:
        'freeCashFlowToEquity({ netIncome: 132, depreciationAndAmortization: 45, capitalExpenditure: 70, increaseInNetWorkingCapital: 15, netBorrowing: 10 })',
    },
  );
  return requireRepresentableResult(
    'freeCashFlowToEquity',
    stableSum([
      input.netIncome,
      input.depreciationAndAmortization,
      -input.capitalExpenditure,
      -input.increaseInNetWorkingCapital,
      input.netBorrowing,
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------
// Terminal value
// ---------------------------------------------------------------------------------------------------

/** The terminal method — a discriminated union, and the discriminant is validated FIRST. */
export type TerminalValueMethod =
  | {
      method: 'perpetual-growth';
      /**
       * The FINAL forecast-period cash flow. The perpetuity begins one period later, so the value
       * is `terminalCashFlow × (1 + g) / (r − g)` — the one-period growth step is applied HERE,
       * exactly once (echoed by every consumer).
       */
      terminalCashFlow: number;
      perpetualGrowthRate: number;
    }
  | {
      method: 'exit-multiple';
      terminalMetricAmount: number;
      exitMultiple: number;
    };

/** Input for {@link terminalValue}. */
export interface TerminalValueInput {
  terminalValueMethod: TerminalValueMethod;
  /** Annual discount rate (decimal). Perpetual growth requires it to EXCEED the growth rate. */
  annualDiscountRate: number;
}

/** Validate a {@link TerminalValueMethod} at a public boundary (shared with the DCF analyses). */
export function requireTerminalValueMethod(
  functionName: string,
  method: TerminalValueMethod,
  annualDiscountRate: number,
): void {
  requireArgumentObject(functionName, 'terminalValueMethod', method);
  if (method.method === 'perpetual-growth') {
    ensureKnownKeys(functionName, 'terminalValueMethod', method, [
      'method',
      'terminalCashFlow',
      'perpetualGrowthRate',
    ]);
    requireFiniteFields(
      functionName,
      method as unknown as Record<string, unknown>,
      ['terminalCashFlow', 'perpetualGrowthRate'],
      {
        exampleCall: `${functionName}({ terminalValueMethod: { method: 'perpetual-growth', terminalCashFlow: 135, perpetualGrowthRate: 0.025 }, annualDiscountRate: 0.09 })`,
      },
    );
    if (annualDiscountRate <= method.perpetualGrowthRate) {
      throw new InputError(
        `${functionName}: perpetual growth requires annualDiscountRate > perpetualGrowthRate — received rate ${annualDiscountRate} against growth ${method.perpetualGrowthRate}. A perpetuity growing as fast as it discounts has no finite value, and no spread is guessed.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: 'terminalValueMethod.perpetualGrowthRate' },
        },
      );
    }
    return;
  }
  if (method.method === 'exit-multiple') {
    ensureKnownKeys(functionName, 'terminalValueMethod', method, [
      'method',
      'terminalMetricAmount',
      'exitMultiple',
    ]);
    requireFiniteFields(
      functionName,
      method as unknown as Record<string, unknown>,
      ['terminalMetricAmount', 'exitMultiple'],
      {
        exampleCall: `${functionName}({ terminalValueMethod: { method: 'exit-multiple', terminalMetricAmount: 225, exitMultiple: 9 }, annualDiscountRate: 0.09 })`,
      },
    );
    return;
  }
  const received = (method as { method?: unknown }).method;
  throw new InputError(
    `${functionName}: terminalValueMethod.method must be 'perpetual-growth' | 'exit-multiple'. Received ${received === null ? 'null' : JSON.stringify(received)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { field: 'terminalValueMethod.method' } },
  );
}

/**
 * The terminal value AT the end of the forecast horizon (not yet discounted to the valuation
 * date): perpetual growth `terminalCashFlow × (1 + g) / (r − g)`, or the exit multiple
 * `terminalMetricAmount × exitMultiple`.
 */
export function terminalValue(input: TerminalValueInput): number {
  requireArgumentObject('terminalValue', 'input', input);
  ensureKnownKeys('terminalValue', 'input', input, ['terminalValueMethod', 'annualDiscountRate']);
  requireFiniteFields(
    'terminalValue',
    input as unknown as Record<string, unknown>,
    ['annualDiscountRate'],
    {
      exampleCall:
        "terminalValue({ terminalValueMethod: { method: 'perpetual-growth', terminalCashFlow: 135, perpetualGrowthRate: 0.025 }, annualDiscountRate: 0.09 })",
    },
  );
  requireTerminalValueMethod('terminalValue', input.terminalValueMethod, input.annualDiscountRate);
  const method = input.terminalValueMethod;
  if (method.method === 'perpetual-growth') {
    // Ratio first: `(1 + g) / (r − g)` stays representable even when `terminalCashFlow · (1 + g)`
    // would overflow, and the true value often is (2026-08-23 review wave: a near-MAX cash flow
    // with a deeply negative growth rate has a perfectly good finite value).
    return requireRepresentableResult(
      'terminalValue',
      method.terminalCashFlow *
        ((1 + method.perpetualGrowthRate) /
          (input.annualDiscountRate - method.perpetualGrowthRate)),
    );
  }
  return requireRepresentableResult(
    'terminalValue',
    method.terminalMetricAmount * method.exitMultiple,
  );
}

// ---------------------------------------------------------------------------------------------------
// Enterprise ⇄ equity bridge
// ---------------------------------------------------------------------------------------------------

/** The enterprise-to-equity bridge — every field explicit, none silently zeroed. */
export interface EnterpriseToEquityBridge {
  cashAndCashEquivalents: number;
  totalDebt: number;
  preferredEquity: number;
  minorityInterest: number;
  nonOperatingAssets: number;
}

const BRIDGE_KEYS = [
  'cashAndCashEquivalents',
  'totalDebt',
  'preferredEquity',
  'minorityInterest',
  'nonOperatingAssets',
] as const;

/** Validate an {@link EnterpriseToEquityBridge} at a public boundary. */
export function requireEnterpriseToEquityBridge(
  functionName: string,
  bridge: EnterpriseToEquityBridge,
): void {
  requireArgumentObject(functionName, 'enterpriseToEquityBridge', bridge);
  ensureKnownKeys(functionName, 'enterpriseToEquityBridge', bridge, BRIDGE_KEYS);
  requireFiniteFields(functionName, bridge as unknown as Record<string, unknown>, BRIDGE_KEYS, {
    exampleCall: `${functionName}({ ..., enterpriseToEquityBridge: { cashAndCashEquivalents: 40, totalDebt: 150, preferredEquity: 0, minorityInterest: 0, nonOperatingAssets: 0 } })`,
  });
}

/** Input for {@link enterpriseToEquityValue}. */
export interface EnterpriseToEquityValueInput {
  enterpriseValue: number;
  enterpriseToEquityBridge: EnterpriseToEquityBridge;
}

/**
 * Equity value = enterprise value − total debt − preferred equity − minority interest + cash and
 * cash equivalents + non-operating assets. The bridge is EXPLICIT: a field the company genuinely
 * lacks is a stated zero, not an omission.
 */
export function enterpriseToEquityValue(input: EnterpriseToEquityValueInput): number {
  requireArgumentObject('enterpriseToEquityValue', 'input', input);
  ensureKnownKeys('enterpriseToEquityValue', 'input', input, [
    'enterpriseValue',
    'enterpriseToEquityBridge',
  ]);
  requireFiniteFields(
    'enterpriseToEquityValue',
    input as unknown as Record<string, unknown>,
    ['enterpriseValue'],
    {
      exampleCall:
        'enterpriseToEquityValue({ enterpriseValue: 2_090, enterpriseToEquityBridge: { cashAndCashEquivalents: 150, totalDebt: 280, preferredEquity: 0, minorityInterest: 0, nonOperatingAssets: 0 } })',
    },
  );
  requireEnterpriseToEquityBridge('enterpriseToEquityValue', input.enterpriseToEquityBridge);
  const bridge = input.enterpriseToEquityBridge;
  return requireRepresentableResult(
    'enterpriseToEquityValue',
    stableSum([
      input.enterpriseValue,
      -bridge.totalDebt,
      -bridge.preferredEquity,
      -bridge.minorityInterest,
      bridge.cashAndCashEquivalents,
      bridge.nonOperatingAssets,
    ]),
  );
}
