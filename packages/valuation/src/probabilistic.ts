/**
 * FC2 — the probabilistic DCF. Explicit marginal distributions over named DCF variables, explicit
 * dependence, explicit sample count and seed. It never turns an unlabeled base case into a
 * stochastic forecast: every randomized variable is declared, everything else stays fixed, and the
 * same seed reproduces the run exactly.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type RandomNumberGenerator,
  correlatedNormalSampler,
  mulberry32,
  normalCdf,
  normalSample,
  quantile,
} from '@totalfinance/math';
import {
  type DiscountedCashFlowInput,
  type DiscountedCashFlowResult,
  discountedCashFlow,
} from './discounted-cash-flow.js';
import { type TerminalValueMethod } from './corporate-primitives.js';

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

/** An explicit marginal distribution. */
export type MarginalDistribution =
  | { type: 'normal'; mean: number; standardDeviation: number }
  | { type: 'uniform'; from: number; to: number }
  | { type: 'triangular'; minimum: number; mode: number; maximum: number };

/** One randomized DCF variable. `'cash-flow-scale'` shocks the whole stream proportionally. */
export interface RandomizedVariable {
  variable: 'annual-discount-rate' | 'perpetual-growth-rate' | 'cash-flow-scale';
  distribution: MarginalDistribution;
}

/** Input for {@link probabilisticDiscountedCashFlow}. */
export interface ProbabilisticDiscountedCashFlowInput {
  discountedCashFlowInput: DiscountedCashFlowInput;
  distributions: readonly RandomizedVariable[];
  /**
   * Correlation matrix over `distributions` (Gaussian dependence, applied before the marginal
   * transforms). Omitted → independent.
   */
  correlationMatrix?: readonly (readonly number[])[];
  sampleCount: number;
  seed: number;
}

/** Result of {@link probabilisticDiscountedCashFlow}. */
export interface ProbabilisticDiscountedCashFlowResult {
  diagnostics: {
    /** One warning per rejected-sample reason (count included). */
    warnings: string[];
  };
  /** The value the distribution describes (per the base input's valuation basis). */
  valueDescribed: 'enterpriseValue' | 'equityValue';
  sampleCount: number;
  seed: number;
  /** Samples whose drawn variables kept the model inside its domain. */
  validSampleCount: number;
  /** Samples the model's own laws rejected (e.g. growth ≥ rate), with the reasons tallied. */
  rejectedSamples: { count: number; reasons: Record<string, number> };
  mean: number;
  standardDeviation: number;
  quantiles: {
    p05: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
  minimum: number;
  maximum: number;
  /** Left-tail diagnostics: the sampled probability that the value falls at or below zero. */
  probabilityAtOrBelowZero: number;
  /** The exact seeded assumptions, echoed for reproduction. */
  assumptions: {
    distributions: readonly RandomizedVariable[];
    correlationMatrix: readonly (readonly number[])[] | 'independent';
    dependence: 'gaussian-copula-over-declared-correlations';
    baseCase: DiscountedCashFlowResult;
  };
}

const TRIANGULAR_EXAMPLE =
  "probabilisticDiscountedCashFlow({ discountedCashFlowInput, distributions: [{ variable: 'annual-discount-rate', distribution: { type: 'normal', mean: 0.09, standardDeviation: 0.01 } }], sampleCount: 10_000, seed: 42 })";

/**
 * The most samples one run accepts (2026-08-23 review, P0 "unbounded work"): every sample draws
 * the declared marginals AND runs one full {@link discountedCashFlow} — measured at ~7.7 µs per
 * sample (100,000 samples of a 5-flow DCF with two randomized variables in 768 ms on an ordinary
 * laptop), so the cap is ~8 seconds of synchronous work, and Monte-Carlo error at 10⁶ samples
 * (∝ 1/√n ≈ 0.1%) is far below any DCF's model error. The old `Number.isInteger` gate admitted
 * `sampleCount: 1e308` (`Number.isInteger(1e308)` is `true`) — effectively infinite work, and a
 * literally non-terminating loop above 2^53 where `sample++` stops changing.
 */
const MAX_SAMPLE_COUNT = 1_000_000;

function validateDistribution(index: number, marginal: MarginalDistribution): void {
  requireArgumentObject(
    'probabilisticDiscountedCashFlow',
    `distributions[${index}].distribution`,
    marginal,
  );
  const type = (marginal as { type?: unknown }).type;
  if (type === 'normal') {
    ensureKnownKeys(
      'probabilisticDiscountedCashFlow',
      `distributions[${index}].distribution`,
      marginal,
      ['type', 'mean', 'standardDeviation'],
    );
    requireFiniteFields(
      'probabilisticDiscountedCashFlow',
      marginal as unknown as Record<string, unknown>,
      ['mean', 'standardDeviation'],
      { exampleCall: TRIANGULAR_EXAMPLE },
    );
    if ((marginal as { standardDeviation: number }).standardDeviation < 0) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: distributions[${index}].distribution.standardDeviation must be ≥ 0 (zero is the degenerate point mass). Received ${(marginal as { standardDeviation: number }).standardDeviation}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `distributions[${index}].distribution.standardDeviation` },
        },
      );
    }
    return;
  }
  if (type === 'uniform') {
    ensureKnownKeys(
      'probabilisticDiscountedCashFlow',
      `distributions[${index}].distribution`,
      marginal,
      ['type', 'from', 'to'],
    );
    requireFiniteFields(
      'probabilisticDiscountedCashFlow',
      marginal as unknown as Record<string, unknown>,
      ['from', 'to'],
      { exampleCall: TRIANGULAR_EXAMPLE },
    );
    if ((marginal as { from: number }).from > (marginal as { to: number }).to) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: distributions[${index}].distribution requires from ≤ to. Received from ${(marginal as { from: number }).from}, to ${(marginal as { to: number }).to}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `distributions[${index}].distribution` },
        },
      );
    }
    return;
  }
  if (type === 'triangular') {
    ensureKnownKeys(
      'probabilisticDiscountedCashFlow',
      `distributions[${index}].distribution`,
      marginal,
      ['type', 'minimum', 'mode', 'maximum'],
    );
    requireFiniteFields(
      'probabilisticDiscountedCashFlow',
      marginal as unknown as Record<string, unknown>,
      ['minimum', 'mode', 'maximum'],
      { exampleCall: TRIANGULAR_EXAMPLE },
    );
    const { minimum, mode, maximum } = marginal as {
      minimum: number;
      mode: number;
      maximum: number;
    };
    if (!(minimum <= mode && mode <= maximum) || minimum === maximum) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: distributions[${index}].distribution requires minimum ≤ mode ≤ maximum with minimum < maximum. Received min ${minimum}, mode ${mode}, max ${maximum}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `distributions[${index}].distribution` },
        },
      );
    }
    return;
  }
  throw new InputError(
    `probabilisticDiscountedCashFlow: distributions[${index}].distribution.type must be 'normal' | 'uniform' | 'triangular'. Received ${type === null ? 'null' : JSON.stringify(type)}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { field: `distributions[${index}].distribution.type` },
    },
  );
}

/** Inverse CDF of the marginal at the probability carried by a standard normal draw. */
function transformMarginal(marginal: MarginalDistribution, standardNormal: number): number {
  if (marginal.type === 'normal') {
    return marginal.mean + marginal.standardDeviation * standardNormal;
  }
  const probability = normalCdf(standardNormal);
  if (marginal.type === 'uniform') {
    return marginal.from + (marginal.to - marginal.from) * probability;
  }
  const { minimum, mode, maximum } = marginal;
  const modeFraction = (mode - minimum) / (maximum - minimum);
  if (probability <= modeFraction) {
    return minimum + Math.sqrt(probability * (maximum - minimum) * (mode - minimum));
  }
  return maximum - Math.sqrt((1 - probability) * (maximum - minimum) * (maximum - mode));
}

function applyVariables(
  base: DiscountedCashFlowInput,
  variables: readonly RandomizedVariable[],
  draws: readonly number[],
): DiscountedCashFlowInput {
  let trial: DiscountedCashFlowInput = base;
  variables.forEach((randomized, index) => {
    const value = draws[index]!;
    if (randomized.variable === 'annual-discount-rate') {
      trial = { ...trial, annualDiscountRate: value };
      return;
    }
    if (randomized.variable === 'perpetual-growth-rate') {
      trial = {
        ...trial,
        terminalValueMethod: {
          ...(trial.terminalValueMethod as Extract<
            TerminalValueMethod,
            { method: 'perpetual-growth' }
          >),
          perpetualGrowthRate: value,
        },
      };
      return;
    }
    // cash-flow-scale: the whole stream scales together — projections AND the terminal amount.
    const scaledFlows = trial.projectedCashFlows.map((flow) =>
      'cashFlowDate' in flow
        ? { cashFlowDate: flow.cashFlowDate, amount: flow.amount * value }
        : { timeYears: flow.timeYears, amount: flow.amount * value },
    ) as DiscountedCashFlowInput['projectedCashFlows'];
    const terminal: TerminalValueMethod =
      trial.terminalValueMethod.method === 'perpetual-growth'
        ? {
            ...trial.terminalValueMethod,
            terminalCashFlow: trial.terminalValueMethod.terminalCashFlow * value,
          }
        : {
            ...trial.terminalValueMethod,
            terminalMetricAmount: trial.terminalValueMethod.terminalMetricAmount * value,
          };
    trial = { ...trial, projectedCashFlows: scaledFlows, terminalValueMethod: terminal };
  });
  return trial;
}

/**
 * Monte-Carlo DCF over the DECLARED randomized variables: Gaussian dependence per the supplied
 * correlations, inverse-CDF marginal transforms, one direct {@link discountedCashFlow} call per
 * sample. A draw the model's own domain rejects (e.g. growth at or above the rate) is counted and
 * excluded with its reason — never clamped into validity. With every distribution degenerate the
 * run collapses to the deterministic result exactly.
 */
export function probabilisticDiscountedCashFlow(
  input: ProbabilisticDiscountedCashFlowInput,
): ProbabilisticDiscountedCashFlowResult {
  requireArgumentObject('probabilisticDiscountedCashFlow', 'input', input);
  ensureKnownKeys('probabilisticDiscountedCashFlow', 'input', input, [
    'discountedCashFlowInput',
    'distributions',
    'correlationMatrix',
    'sampleCount',
    'seed',
  ]);
  requireFiniteFields(
    'probabilisticDiscountedCashFlow',
    input as unknown as Record<string, unknown>,
    ['sampleCount', 'seed'],
    { exampleCall: TRIANGULAR_EXAMPLE },
  );
  if (
    !Number.isSafeInteger(input.sampleCount) ||
    input.sampleCount < 1 ||
    input.sampleCount > MAX_SAMPLE_COUNT
  ) {
    throw new InputError(
      `probabilisticDiscountedCashFlow: sampleCount must be an integer in [1, ${MAX_SAMPLE_COUNT.toLocaleString('en-US')}] — every sample runs a full discountedCashFlow (~8 µs each), so the cap is a few seconds of synchronous work, and Monte-Carlo error at 10^6 samples (∝ 1/√n ≈ 0.1%) is already far below any DCF's model error. Received ${input.sampleCount}.\n  e.g. ${TRIANGULAR_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'sampleCount' } },
    );
  }
  if (!Array.isArray(input.distributions) || input.distributions.length === 0) {
    throw new InputError(
      `probabilisticDiscountedCashFlow: distributions must be a non-empty array — with nothing declared random there is nothing probabilistic, use discountedCashFlow directly.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'distributions' } },
    );
  }
  const seenVariables = new Set<string>();
  input.distributions.forEach((randomized, index) => {
    requireArgumentObject('probabilisticDiscountedCashFlow', `distributions[${index}]`, randomized);
    ensureKnownKeys('probabilisticDiscountedCashFlow', `distributions[${index}]`, randomized, [
      'variable',
      'distribution',
    ]);
    if (
      randomized.variable !== 'annual-discount-rate' &&
      randomized.variable !== 'perpetual-growth-rate' &&
      randomized.variable !== 'cash-flow-scale'
    ) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: distributions[${index}].variable must be 'annual-discount-rate' | 'perpetual-growth-rate' | 'cash-flow-scale'. Received ${JSON.stringify(randomized.variable)}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { field: `distributions[${index}].variable` },
        },
      );
    }
    if (seenVariables.has(randomized.variable)) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: distributions[${index}] randomizes '${randomized.variable}' twice — one marginal per variable.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `distributions[${index}].variable` } },
      );
    }
    seenVariables.add(randomized.variable);
    if (
      randomized.variable === 'perpetual-growth-rate' &&
      input.discountedCashFlowInput.terminalValueMethod.method !== 'perpetual-growth'
    ) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: randomizing 'perpetual-growth-rate' requires a perpetual-growth terminal method — the supplied method is '${input.discountedCashFlowInput.terminalValueMethod.method}'.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `distributions[${index}].variable` } },
      );
    }
    validateDistribution(index, randomized.distribution);
  });
  const dimension = input.distributions.length;
  if (input.correlationMatrix !== undefined) {
    if (
      !Array.isArray(input.correlationMatrix) ||
      input.correlationMatrix.length !== dimension ||
      input.correlationMatrix.some((row) => !Array.isArray(row) || row.length !== dimension)
    ) {
      throw new InputError(
        `probabilisticDiscountedCashFlow: correlationMatrix must be ${dimension}×${dimension} to match the declared distributions.`,
        { code: ErrorCode.InputWrongShape, context: { field: 'correlationMatrix' } },
      );
    }
  }

  // Base case FIRST: an invalid base input fails here, before any sampling.
  const baseCase = discountedCashFlow(input.discountedCashFlowInput);

  const generator: RandomNumberGenerator = mulberry32(input.seed);
  const sampler =
    input.correlationMatrix !== undefined
      ? correlatedNormalSampler(input.correlationMatrix as number[][])
      : null;
  const values: number[] = [];
  const rejectionReasons: Record<string, number> = {};
  let rejected = 0;
  for (let sample = 0; sample < input.sampleCount; sample++) {
    const normals =
      sampler !== null
        ? sampler(generator)
        : Array.from({ length: dimension }, () => normalSample(generator));
    const draws = input.distributions.map((randomized, index) =>
      transformMarginal(randomized.distribution, normals[index]!),
    );
    try {
      const result = discountedCashFlow(
        applyVariables(input.discountedCashFlowInput, input.distributions, draws),
      );
      values.push(result.valuationBasis === 'firm' ? result.enterpriseValue : result.equityValue);
    } catch (error) {
      rejected += 1;
      const message = (error as Error).message;
      // Tally by the stable leading clause so ten thousand rejections read as one line.
      const reason = message.split(' — ')[0]!.split('. Received')[0]!;
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  if (values.length === 0) {
    throw new InputError(
      `probabilisticDiscountedCashFlow: every one of the ${input.sampleCount} samples fell outside the model's domain (${Object.keys(rejectionReasons).join('; ')}) — the declared distributions do not overlap the model's admissible region.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'distributions' } },
    );
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.length === 1
      ? 0
      : values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  const q = (p: number): number => quantile(sorted, p);
  return requireRepresentableResult('probabilisticDiscountedCashFlow', {
    diagnostics: {
      warnings: Object.entries(rejectionReasons).map(
        ([reason, count]) => `${count} sample${count === 1 ? '' : 's'} rejected: ${reason}`,
      ),
    },
    valueDescribed: baseCase.valuationBasis === 'firm' ? 'enterpriseValue' : 'equityValue',
    sampleCount: input.sampleCount,
    seed: input.seed,
    validSampleCount: values.length,
    rejectedSamples: { count: rejected, reasons: rejectionReasons },
    mean,
    standardDeviation: Math.sqrt(variance),
    quantiles: {
      p05: q(0.05),
      p10: q(0.1),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p95: q(0.95),
    },
    minimum: sorted[0]!,
    maximum: sorted[sorted.length - 1]!,
    probabilityAtOrBelowZero: sorted.filter((value) => value <= 0).length / sorted.length,
    assumptions: {
      distributions: input.distributions,
      correlationMatrix: input.correlationMatrix ?? 'independent',
      dependence: 'gaussian-copula-over-declared-correlations',
      baseCase,
    },
  });
}
