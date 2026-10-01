/**
 * Compile-only type contract for selective Black–Scholes evaluation (selective Greeks spec,
 * decision 6). Typechecked by `pnpm typecheck`; never executed. Every `@ts-expect-error` must stay
 * an error — an unused one fails the typecheck.
 */
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
// @ts-expect-error an empty literal selection computes nothing
blackScholes.evaluate({ ...input, outputs: [] });

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

// The result type is nameable for app state.
export const typedEvaluation: BlackScholesEvaluation<readonly ['delta']> = { delta: 0.5 };
