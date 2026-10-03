/**
 * Compile-only type contract for selective Black–Scholes evaluation (selective Greeks spec,
 * decision 6). Typechecked by `pnpm typecheck`; never executed. Every `@ts-expect-error` must stay
 * an error — an unused one fails the typecheck.
 */
import {
  blackScholesEvaluateMany,
  blackScholesEvaluateManyInto,
  type BlackScholesEvaluateManyResult,
  type BlackScholesOutputBuffers,
  type OptionBatchColumns,
} from '@totalfinance/options/batch';
import {
  blackScholes,
  type BlackScholesEvaluation,
  type BlackScholesOutput,
} from '@totalfinance/options/black-scholes';

const input = {
  type: 'call' as const,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};

// ---- named single-Greek methods ----
export const namedGamma: number = blackScholes.gamma(input);
export const namedTheta: number = blackScholes.theta.explain(input).value;
// @ts-expect-error a named method takes the plain typed input; `outputs` belongs to evaluate
blackScholes.gamma({ ...input, outputs: ['gamma'] });

// ---- literal selections: exactly the requested, required properties ----
const literal = blackScholes.evaluate({ ...input, outputs: ['price', 'gamma'] });
export const literalPrice: number = literal.price;
export const literalGamma: number = literal.gamma;
// @ts-expect-error delta was not requested, so it does not exist on the result
void literal.delta;

const explained = blackScholes.evaluate.explain({ ...input, outputs: ['vanna'] });
export const explainedVanna: number = explained.value.vanna;
// @ts-expect-error price was not requested
void explained.value.price;

const picked = ['theta', 'rho'] as const;
const viaConstant = blackScholes.evaluate({ ...input, outputs: picked });
export const constantTheta: number = viaConstant.theta;

// @ts-expect-error unknown output name
blackScholes.evaluate({ ...input, outputs: ['price', 'gama'] });
// @ts-expect-error lambda stays on extendedGreeks (no nullable selective encoding)
blackScholes.evaluate({ ...input, outputs: ['lambda'] });
// @ts-expect-error the selection is required
blackScholes.evaluate(input);
// An empty selection type-checks (no conditional parameter types on the public surface) and is
// refused at run time with input.out_of_range (selective-greeks.test.ts).

// ---- dynamic selections: honest optional properties ----
declare const dynamic: BlackScholesOutput[];
const dynamicResult = blackScholes.evaluate({ ...input, outputs: dynamic });
export const maybeGamma: number | undefined = dynamicResult.gamma;
// @ts-expect-error a dynamic selection cannot claim gamma was computed
export const certainGamma: number = dynamicResult.gamma;

declare const narrow: Array<'delta' | 'gamma'>;
const narrowResult = blackScholes.evaluate({ ...input, outputs: narrow });
export const maybeDelta: number | undefined = narrowResult.delta;
// @ts-expect-error price is outside the dynamic union
void narrowResult.price;

// ---- selections the type cannot pin down: only what every possibility holds is required ----
// Review of #3: a conditional between two fixed tuples used to type BOTH names as required, so
// `result.gamma` read as a number on the branch that computed delta. A fixed-length tuple is not
// necessarily a fixed selection.
declare const condition: boolean;
const conditional = condition ? (['gamma'] as const) : (['delta'] as const);
const conditionalResult = blackScholes.evaluate({ ...input, outputs: conditional });
export const conditionalMaybeGamma: number | undefined = conditionalResult.gamma;
export const conditionalMaybeDelta: number | undefined = conditionalResult.delta;
// @ts-expect-error gamma is undefined on the delta branch
export const conditionalGamma: number = conditionalResult.gamma;
// @ts-expect-error vega is in neither branch
void conditionalResult.vega;

// A name every branch selects stays required; the others are optional.
const shared = condition ? (['price', 'gamma'] as const) : (['delta', 'price'] as const);
const sharedResult = blackScholes.evaluate({ ...input, outputs: shared });
export const sharedPrice: number = sharedResult.price;
// @ts-expect-error gamma is only on one branch
export const sharedGamma: number = sharedResult.gamma;

// An element that is itself a union holds one of its members, and the type cannot say which.
declare const which: 'gamma' | 'delta';
const unionElement = blackScholes.evaluate({ ...input, outputs: [which] });
export const unionMaybeGamma: number | undefined = unionElement.gamma;
// @ts-expect-error the element may be delta
export const unionGamma: number = unionElement.gamma;
const mixedElement = blackScholes.evaluate({ ...input, outputs: ['price', which] });
export const mixedPrice: number = mixedElement.price;
// @ts-expect-error the second element may be gamma
export const mixedDelta: number = mixedElement.delta;
// @ts-expect-error the same rule on .explain
export const explainedGamma: number = blackScholes.evaluate.explain({
  ...input,
  outputs: conditional,
}).value.gamma;

// The result type is nameable for app state.
export const typedEvaluation: BlackScholesEvaluation<readonly ['delta']> = { delta: 0.5 };

// ---- batch family: the same selection rule, one Float64Array per output ----
declare const columns: OptionBatchColumns;
const many = blackScholesEvaluateMany(columns, { outputs: ['gamma', 'delta'] });
export const manyGamma: Float64Array = many.gamma;
export const manyDelta: Float64Array = many.delta;
// @ts-expect-error price was not requested
void many.price;
const manyDynamic = blackScholesEvaluateMany(columns, { outputs: dynamic });
export const manyMaybe: Float64Array | undefined = manyDynamic.vega;
// @ts-expect-error a dynamic selection cannot claim vega was computed
export const manyCertain: Float64Array = manyDynamic.vega;
// @ts-expect-error unknown output name
blackScholesEvaluateMany(columns, { outputs: ['gama'] });
// @ts-expect-error the selection is required
blackScholesEvaluateMany(columns, {});
// @ts-expect-error lambda stays on extendedGreeks
blackScholesEvaluateMany(columns, { outputs: ['lambda'] });
const manyConditional = blackScholesEvaluateMany(columns, { outputs: conditional });
export const manyMaybeGamma: Float64Array | undefined = manyConditional.gamma;
// @ts-expect-error gamma is undefined on the delta branch
export const manyConditionalGamma: Float64Array = manyConditional.gamma;
const manyUnion = blackScholesEvaluateMany(columns, { outputs: ['price', which] });
export const manyUnionPrice: Float64Array = manyUnion.price;
// @ts-expect-error the second element may be delta
export const manyUnionGamma: Float64Array = manyUnion.gamma;
export const typedMany: BlackScholesEvaluateManyResult<readonly ['gamma']> = {
  gamma: new Float64Array(0),
};

// The buffer object's property names ARE the selection.
blackScholesEvaluateManyInto(columns, { gamma: new Float64Array(0) });
blackScholesEvaluateManyInto(columns, { price: new Float64Array(0), color: new Float64Array(0) });
// @ts-expect-error an output buffer must be a Float64Array, not a plain array
blackScholesEvaluateManyInto(columns, { gamma: [0] });
// @ts-expect-error an output buffer must be a Float64Array, not another typed array
blackScholesEvaluateManyInto(columns, { gamma: new Float32Array(0) });
// @ts-expect-error unknown output buffer name
blackScholesEvaluateManyInto(columns, { gama: new Float64Array(0) });
// A buffer set assembled at runtime is accepted; the runtime refuses an empty one.
declare const assembled: BlackScholesOutputBuffers;
blackScholesEvaluateManyInto(columns, assembled);
