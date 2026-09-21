/**
 * FC2 — comparable-company (trading multiples) valuation.
 *
 * Required semantics (spec, frozen): the analysis RECORDS the metric definition, the period, the
 * peer values, the weighting/aggregation method, the outlier policy, and the enterprise/equity
 * basis — a multiple with no recorded basis is two different numbers to two different readers.
 * The outlier policy is applied BEFORE aggregation, every excluded peer is named with the reason
 * it was excluded, and no policy or weight is ever defaulted silently.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

/** Whether the multiple prices the whole firm or only the equity. REQUIRED — never guessed. */
export type ComparableValuationBasis = 'enterprise' | 'equity';

/** How the surviving peer multiples collapse into one. REQUIRED — never guessed. */
export type ComparableAggregation = 'median' | 'mean' | 'weighted-mean';

/** One peer observation: the name and its multiple for the SAME metric/period as the subject. */
export interface ComparablePeer {
  peerName: string;
  /** The peer's multiple (e.g. EV/EBITDA of 8.5 is `8.5`). */
  multiple: number;
}

/**
 * The EXPLICIT outlier policy, applied to peer multiples BEFORE aggregation.
 *
 * `'interquartile-range'` excludes peers whose multiple lies outside
 * `[Q1 − multiplier·IQR, Q3 + multiplier·IQR]`, with Q1/Q3 the standard linear-interpolation
 * quantiles of the peer multiples. `'none'` keeps every peer — stated, not assumed.
 */
export type ComparableOutlierPolicy =
  | { method: 'none' }
  | { method: 'interquartile-range'; multiplier: number };

/** Input for {@link comparableCompanyValuation}. */
export interface ComparableCompanyValuationInput {
  /** The metric's name (e.g. `'EV/EBITDA'`). Recorded, never inferred. */
  metricName: string;
  /** What the metric MEANS (e.g. `'enterprise value over trailing-twelve-month EBITDA'`). */
  metricDefinition: string;
  /** The period the metric covers (e.g. `'TTM 2025-Q4'`). Recorded, never inferred. */
  period: string;
  /** `'enterprise'` when the multiple prices the firm, `'equity'` when it prices the equity. */
  valuationBasis: ComparableValuationBasis;
  /** The subject company's metric amount the aggregated multiple is applied to. */
  subjectMetricAmount: number;
  peers: readonly ComparablePeer[];
  aggregation: ComparableAggregation;
  /**
   * Peer weights, REQUIRED for (and only valid with) `'weighted-mean'`, one per peer in peer
   * order. Each must be a finite number > 0; they need not sum to 1 — they are normalized and
   * the normalized weights are echoed in `assumptions.weightsNormalized`.
   */
  weights?: readonly number[];
  /** REQUIRED — an unstated outlier policy is a silent default. Use `{ method: 'none' }` to keep all. */
  outlierPolicy: ComparableOutlierPolicy;
}

/** One peer that survived the outlier policy; `weight` present only under `'weighted-mean'`. */
export interface ComparablePeerUsed {
  peerName: string;
  multiple: number;
  /** The NORMALIZED weight applied to this peer (present only under `'weighted-mean'`). */
  weight?: number;
}

/** One peer the outlier policy excluded, with the exact reason. */
export interface ComparablePeerExcluded {
  peerName: string;
  multiple: number;
  reason: string;
}

/** Result of {@link comparableCompanyValuation} — every recorded convention echoed. */
export interface ComparableCompanyValuationResult {
  diagnostics: {
    /** One warning per excluded peer. */
    warnings: string[];
  };
  /** `aggregatedMultiple × subjectMetricAmount`, on the declared `valuationBasis`. */
  impliedValue: number;
  aggregatedMultiple: number;
  valuationBasis: ComparableValuationBasis;
  metricName: string;
  metricDefinition: string;
  period: string;
  /** The peers that survived the outlier policy, in input order. */
  peersUsed: ComparablePeerUsed[];
  /** The peers the outlier policy excluded, in input order, each with its reason. */
  peersExcluded: ComparablePeerExcluded[];
  aggregation: ComparableAggregation;
  assumptions: {
    /** The outlier policy as requested — echoed so the record is self-describing. */
    outlierPolicy: ComparableOutlierPolicy;
    /** Present only under `'weighted-mean'`: the normalized weights, aligned with `peersUsed`. */
    weightsNormalized?: number[];
  };
}

const INPUT_KEYS = [
  'metricName',
  'metricDefinition',
  'period',
  'valuationBasis',
  'subjectMetricAmount',
  'peers',
  'aggregation',
  'weights',
  'outlierPolicy',
] as const;

const PEER_KEYS = ['peerName', 'multiple'] as const;

const EXAMPLE_CALL =
  "comparableCompanyValuation({ metricName: 'EV/EBITDA', metricDefinition: 'enterprise value over trailing-twelve-month EBITDA', period: 'TTM 2025-Q4', valuationBasis: 'enterprise', subjectMetricAmount: 50, peers: [{ peerName: 'Alpha', multiple: 8 }, { peerName: 'Beta', multiple: 9 }], aggregation: 'median', outlierPolicy: { method: 'interquartile-range', multiplier: 1.5 } })";

function requireNonEmptyString(functionName: string, field: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-empty string — the analysis RECORDS it so the result is self-describing. Received ${value === null ? 'null' : typeof value === 'string' ? "''" : typeof value}. e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputWrongType, context: { field } },
    );
  }
}

/** The standard linear-interpolation quantile (R type 7) of ASCENDING-sorted values. */
function linearInterpolationQuantile(sortedAscending: readonly number[], p: number): number {
  const position = (sortedAscending.length - 1) * p;
  const lower = Math.floor(position);
  const fraction = position - lower;
  if (fraction === 0) return sortedAscending[lower]!;
  return (
    sortedAscending[lower]! + fraction * (sortedAscending[lower + 1]! - sortedAscending[lower]!)
  );
}

function validateInput(input: ComparableCompanyValuationInput): void {
  const functionName = 'comparableCompanyValuation';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requireNonEmptyString(functionName, 'metricName', input.metricName);
  requireNonEmptyString(functionName, 'metricDefinition', input.metricDefinition);
  requireNonEmptyString(functionName, 'period', input.period);
  if (input.valuationBasis !== 'enterprise' && input.valuationBasis !== 'equity') {
    throw new InputError(
      `${functionName}: valuationBasis must be 'enterprise' | 'equity' — an enterprise multiple applied to an equity metric is a category error, so the basis is never guessed. Received ${input.valuationBasis === null ? 'null' : JSON.stringify(input.valuationBasis)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'valuationBasis' } },
    );
  }
  requireFiniteFields(functionName, input, ['subjectMetricAmount'], { exampleCall: EXAMPLE_CALL });
  requireArgumentArray(functionName, 'peers', input.peers);
  if (input.peers.length === 0) {
    throw new InputError(
      `${functionName}: peers must not be empty — a comparable valuation with no comparables values nothing.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'peers' } },
    );
  }
  input.peers.forEach((peer, index) => {
    requireArgumentObject(functionName, `peers[${index}]`, peer);
    ensureKnownKeys(functionName, `peers[${index}]`, peer, PEER_KEYS);
    requireNonEmptyString(functionName, `peers[${index}].peerName`, peer.peerName);
    requireFiniteFields(functionName, peer, ['multiple'], {
      exampleCall: EXAMPLE_CALL,
      path: `peers[${index}]`,
    });
  });
  if (
    input.aggregation !== 'median' &&
    input.aggregation !== 'mean' &&
    input.aggregation !== 'weighted-mean'
  ) {
    throw new InputError(
      `${functionName}: aggregation must be 'median' | 'mean' | 'weighted-mean' — the collapse of peer multiples into one number is never guessed. Received ${input.aggregation === null ? 'null' : JSON.stringify(input.aggregation)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'aggregation' } },
    );
  }
  if (input.aggregation === 'weighted-mean') {
    // Null is a wrong-typed value, not omission: `weights: null` fails the array guard below.
    if (input.weights === undefined) {
      throw new InputError(
        `${functionName}: weights is required when aggregation is 'weighted-mean' — a weighted mean without weights is an unweighted mean wearing the wrong label. e.g. ${EXAMPLE_CALL.replace("aggregation: 'median'", "aggregation: 'weighted-mean', weights: [2, 1]")}`,
        { code: ErrorCode.InputMissingField, context: { field: 'weights' } },
      );
    }
    requireArgumentArray(functionName, 'weights', input.weights);
    if (input.weights.length !== input.peers.length) {
      throw new InputError(
        `${functionName}: weights must have one entry per peer (peer order). Received ${input.weights.length} weights for ${input.peers.length} peers.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'weights' } },
      );
    }
    input.weights.forEach((weight, index) => {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        throw new InputError(
          `${functionName}: weights[${index}] must be a finite number > 0 (weights need not sum to 1 — they are normalized and echoed). Received ${weight === null ? 'null' : String(weight)}.`,
          {
            code:
              typeof weight === 'number' && Number.isFinite(weight)
                ? ErrorCode.InputOutOfRange
                : ErrorCode.InputWrongType,
            context: { field: `weights[${index}]` },
          },
        );
      }
    });
  } else if (input.weights !== undefined) {
    throw new InputError(
      `${functionName}: weights is only valid with aggregation 'weighted-mean' — '${input.aggregation}' would silently ignore it. Remove weights or switch the aggregation.`,
      { code: ErrorCode.InputUnknownField, context: { field: 'weights' } },
    );
  }
  requireArgumentObject(functionName, 'outlierPolicy', input.outlierPolicy);
  const method = (input.outlierPolicy as { method?: unknown }).method;
  if (method === 'none') {
    ensureKnownKeys(functionName, 'outlierPolicy', input.outlierPolicy, ['method']);
  } else if (method === 'interquartile-range') {
    ensureKnownKeys(functionName, 'outlierPolicy', input.outlierPolicy, ['method', 'multiplier']);
    requireFiniteFields(functionName, input.outlierPolicy, ['multiplier'], {
      exampleCall: EXAMPLE_CALL,
      path: 'outlierPolicy',
    });
    if ((input.outlierPolicy as { multiplier: number }).multiplier < 0) {
      throw new InputError(
        `${functionName}: outlierPolicy.multiplier must be ≥ 0 (1.5 is the Tukey convention; 0 keeps only [Q1, Q3]). Received ${(input.outlierPolicy as { multiplier: number }).multiplier}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'outlierPolicy.multiplier' } },
      );
    }
  } else {
    throw new InputError(
      `${functionName}: outlierPolicy.method must be 'none' | 'interquartile-range' — an unstated outlier policy is a silent default. Received ${method === null ? 'null' : JSON.stringify(method)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'outlierPolicy.method' } },
    );
  }
}

/**
 * Comparable-company valuation: apply the EXPLICIT outlier policy to the peer multiples, aggregate
 * the survivors under the declared method, and price the subject's metric on the declared
 * enterprise/equity basis. Every excluded peer is named with the reason; the metric definition,
 * period, basis, aggregation, policy, and normalized weights are all echoed in the result.
 */
export function comparableCompanyValuation(
  input: ComparableCompanyValuationInput,
): ComparableCompanyValuationResult {
  validateInput(input);

  // 1. The outlier policy, BEFORE aggregation.
  const excluded: ComparablePeerExcluded[] = [];
  const usedIndices: number[] = [];
  if (input.outlierPolicy.method === 'interquartile-range') {
    const multiplier = input.outlierPolicy.multiplier;
    const sorted = input.peers.map((peer) => peer.multiple).sort((a, b) => a - b);
    const firstQuartile = linearInterpolationQuantile(sorted, 0.25);
    const thirdQuartile = linearInterpolationQuantile(sorted, 0.75);
    const interquartileRange = thirdQuartile - firstQuartile;
    const lowerFence = firstQuartile - multiplier * interquartileRange;
    const upperFence = thirdQuartile + multiplier * interquartileRange;
    input.peers.forEach((peer, index) => {
      if (peer.multiple < lowerFence || peer.multiple > upperFence) {
        excluded.push({
          peerName: peer.peerName,
          multiple: peer.multiple,
          reason: `multiple ${peer.multiple} lies ${peer.multiple < lowerFence ? 'below' : 'above'} the interquartile-range fence [${lowerFence}, ${upperFence}] (Q1 = ${firstQuartile}, Q3 = ${thirdQuartile}, multiplier = ${multiplier})`,
        });
      } else {
        usedIndices.push(index);
      }
    });
    if (usedIndices.length === 0) {
      throw new InputError(
        `comparableCompanyValuation: the interquartile-range outlier policy (multiplier ${multiplier}) excluded every peer — the fence [${lowerFence}, ${upperFence}] contains none of the ${input.peers.length} multiples, so nothing remains to aggregate. Widen the multiplier or use outlierPolicy: { method: 'none' }.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'outlierPolicy' } },
      );
    }
  } else {
    input.peers.forEach((_, index) => usedIndices.push(index));
  }

  // 2. Normalized weights over the SURVIVING peers (weighted-mean only).
  let weightsNormalized: number[] | undefined;
  if (input.aggregation === 'weighted-mean') {
    const survivingWeights = usedIndices.map((index) => input.weights![index]!);
    const totalWeight = survivingWeights.reduce((sum, weight) => sum + weight, 0);
    weightsNormalized = survivingWeights.map((weight) => weight / totalWeight);
  }

  // 3. Aggregation of the survivors under the declared method.
  const survivingMultiples = usedIndices.map((index) => input.peers[index]!.multiple);
  let aggregatedMultiple: number;
  if (input.aggregation === 'median') {
    const sorted = [...survivingMultiples].sort((a, b) => a - b);
    aggregatedMultiple = linearInterpolationQuantile(sorted, 0.5);
  } else if (input.aggregation === 'mean') {
    aggregatedMultiple =
      survivingMultiples.reduce((sum, multiple) => sum + multiple, 0) / survivingMultiples.length;
  } else {
    aggregatedMultiple = survivingMultiples.reduce(
      (sum, multiple, position) => sum + multiple * weightsNormalized![position]!,
      0,
    );
  }

  const peersUsed: ComparablePeerUsed[] = usedIndices.map((index, position) => ({
    peerName: input.peers[index]!.peerName,
    multiple: input.peers[index]!.multiple,
    ...(weightsNormalized !== undefined ? { weight: weightsNormalized[position]! } : {}),
  }));

  return requireRepresentableResult('comparableCompanyValuation', {
    diagnostics: {
      warnings: excluded.map((peer) => `${peer.peerName} excluded: ${peer.reason}`),
    },
    impliedValue: aggregatedMultiple * input.subjectMetricAmount,
    aggregatedMultiple,
    valuationBasis: input.valuationBasis,
    metricName: input.metricName,
    metricDefinition: input.metricDefinition,
    period: input.period,
    peersUsed,
    peersExcluded: excluded,
    aggregation: input.aggregation,
    assumptions: {
      outlierPolicy:
        input.outlierPolicy.method === 'interquartile-range'
          ? { method: 'interquartile-range', multiplier: input.outlierPolicy.multiplier }
          : { method: 'none' },
      ...(weightsNormalized !== undefined ? { weightsNormalized } : {}),
    },
  });
}
