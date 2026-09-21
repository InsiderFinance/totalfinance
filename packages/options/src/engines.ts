/** Pricing engines and the engine extension API (spec §9.3, §22.1). */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type EpochMs,
  ErrorCode,
  InputError,
  type OptionContract,
  type OptionStyle,
  type QuantWarning,
  UnsupportedError,
  WarningCode,
  assertFiniteValue,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  isQuantError,
  requireArgumentArray,
  requireArgumentObject,
  resolveValuationAsOf,
  type ClosedRequestSpecification,
  validateClosedRequest,
} from '@totalfinance/core';
import type { SelectionCandidate } from '@totalfinance/core/pricing';
import { black76ExtendedGreeks, black76Greeks, black76Price } from './black76.js';
import { blackScholesPrice } from './bsm.js';
import { expiryConventionOf, type BlackScholesEngineConfig, priceContract } from './engine-bsm.js';
import { requireOptionalArgObject } from './facade-util.js';
import { hasDiscreteDividends } from './dividends.js';
import {
  type AmericanEngineConfig,
  ENGINE_VERSION,
  makeAmericanEngine,
  requireSupportsContract,
} from './engines/engine-factory.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import type { AmericanApproximationPricer } from './engines/scalar-pricing.js';
import {
  bawPrice,
  bawSolve,
  bjerksundStensland2002Price,
  bjerksundStenslandPrice,
} from './engines/american-approx.js';
import {
  type BinomialVariant,
  binomialPrice,
  binomialSolve,
  latticeSpotGreeks,
  trinomialPrice,
  trinomialSolve,
} from './engines/tree.js';
import { crankNicolsonPrice, crankNicolsonSolve } from './engines/fdm.js';
import {
  type HestonCosineExpansionOptions,
  type HestonInput,
  type HestonParameters,
  hestonPrice,
} from './heston.js';
import {
  type LocalVolatilityFunction,
  type LocalVolatilityInput,
  type LocalVolatilityMonteCarloOptions,
  localVolatilityMonteCarloPrice,
} from './local-volatility.js';
import { validateMonteCarloSamplingOptions } from './mc/core.js';
import { type MonteCarloPriceOptions, monteCarloPrice } from './monte-carlo.js';
import {
  DEFAULT_LOCAL_VOLATILITY_STEPS,
  requireHestonCosineTermCount,
} from './resource-validation-internal.js';
import { type SabrInput, type SabrOptions, type SabrParameters, sabrPrice } from './sabr.js';
import { contractTimeToExpiryYears } from './time.js';
import type { ExtendedGreeks, Greeks, OptionMarket, PriceResult } from './types.js';

export interface PriceOptions {
  /**
   * Compute first-order Greeks (default `true`). `false` omits `result.greeks` entirely — absent
   * means "not requested", never fabricated zeros — and flags `greeks.not_computed` in
   * diagnostics. Honored identically by EVERY engine (the substitutability contract, spec P2.4);
   * `extendedGreeks: true` implies `greeks`.
   */
  greeks?: boolean;
  /**
   * Also compute the **higher-order (extended) Greek set** (vanna, charm, vomma, speed, color, phi, zomma,
   * veta, vera, ultima, lambda). Analytic on the closed-form engines; by finite difference on the
   * numerical (lattice / PDE / approximation) engines. Implies `greeks`.
   */
  extendedGreeks?: boolean;
}

/** One complete request to a pluggable option-pricing engine. */
export interface OptionEnginePriceInput {
  contract: OptionContract;
  market: OptionMarket;
  options?: PriceOptions;
}

/** A pluggable option-pricing engine (spec §9.3). */
/**
 * Machine-readable engine capabilities (Law 8, C6): what an engine can do, stated as data the
 * shared contract suite VERIFIES behaviorally — `styles` against `supports()`, `greeks`/
 * `extendedGreeks` against actual result contents, `deterministic` against repeat-call equality.
 * A claim the suite can't confirm fails CI, so capabilities can never drift into marketing.
 */
export interface EngineCapabilities {
  /** Exercise styles this engine prices (must agree with `supports()`). */
  readonly styles: readonly OptionStyle[];
  /** Dividend models the engine honors. */
  readonly dividends: readonly ('none' | 'continuous' | 'discrete')[];
  /**
   * How first-order Greeks are produced when requested: closed-form (`analytic`), bump-and-reprice
   * (`finite-difference`), by the selected delegate (`delegated`, meta-engines), or not at all
   * (`none` — requests are disclosed as unhonored, never silently dropped).
   */
  readonly greeks: 'analytic' | 'finite-difference' | 'delegated' | 'none';
  /** Whether the extended (higher-order) Greek set is available on request. */
  readonly extendedGreeks: boolean;
  /**
   * Same inputs → identical outputs. `false` marks stochastic engines (Monte-Carlo): a FIXED SEED
   * makes them reproducible, which is what the contract suite verifies for them.
   */
  readonly deterministic: boolean;
}

export interface OptionPricingEngine {
  readonly name: string;
  readonly version: string;
  /** Machine-readable capabilities, behaviorally verified by the engine contract suite (Law 8). */
  readonly capabilities: EngineCapabilities;
  /** Whether this engine can price the given contract. */
  supports(contract: OptionContract): boolean;
  price(input: OptionEnginePriceInput): PriceResult;
}

/** One caller-supplied behavioral probe for {@link validateOptionPricingEngine}. */
export interface OptionPricingEngineProbe {
  /** A representative contract the engine claims to support. */
  contract: OptionContract;
  /** Market data appropriate for this engine (for example `forward` for Black-76). */
  market: OptionMarket;
  /** Optional baseline pricing flags used for this probe. */
  options?: PriceOptions;
}

/**
 * Assert an engine-shaped argument (the first-touch law, dx §7.1): anything without callable
 * `supports`/`price` would crash later as `chosen.supports is not a function` — teach the two
 * factory gestures instead. Intra-package guard, not part of the public surface.
 */
export function requireEngine(
  functionName: string,
  engine: unknown,
): asserts engine is OptionPricingEngine {
  const e = engine as { supports?: unknown; price?: unknown } | null;
  if (
    e === null ||
    typeof e !== 'object' ||
    typeof e.supports !== 'function' ||
    typeof e.price !== 'function'
  ) {
    throw new InputError(
      `${functionName}: engine must be an OptionPricingEngine ({ name, supports, price }) — build one with ` +
        `engines.* (e.g. engines.binomial()) or defineOptionPricingEngine(...); got ${
          engine === null ? 'null' : Array.isArray(engine) ? 'array' : typeof engine
        }.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName } },
    );
  }
}

function makeBlackScholesEngine(config: BlackScholesEngineConfig): OptionPricingEngine {
  return {
    name: config.name,
    version: ENGINE_VERSION,
    capabilities: {
      styles: ['european'],
      dividends: config.useDividends ? ['none', 'continuous', 'discrete'] : ['none'],
      greeks: 'analytic',
      extendedGreeks: true,
      deterministic: true,
    },
    supports: (contract) => {
      requireSupportsContract(contract);
      return contract.style === 'european';
    },
    price: ({ contract, market, options }) => priceContract(config, contract, market, options),
  };
}

/**
 * Price a European contract on the *forward* under Black-76 (spec §9.3). The forward already embeds
 * carry/dividends, so there is no separate dividend model — the discount rate `market.rate` is applied
 * to the Black-76 value and Greeks are taken with respect to the forward.
 */
function priceBlack76Contract(
  contract: OptionContract,
  market: OptionMarket,
  options?: PriceOptions,
): PriceResult {
  const functionName = 'option.price(black-76)';
  if (contract.style !== 'european') {
    throw new UnsupportedError(
      `${functionName}: black-76 prices European-style options only; received style "${contract.style}".`,
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: { engine: 'black-76', style: contract.style },
      },
    );
  }
  if (typeof market.forward !== 'number') {
    throw new InputError(`${functionName}: market.forward is required for the Black-76 engine.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'forward', function: functionName },
    });
  }
  if (typeof market.volatility !== 'number') {
    throw new InputError(`${functionName}: market.volatility (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'volatility', function: functionName },
    });
  }
  if (typeof market.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: market.riskFreeRate (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate', function: functionName },
    });
  }
  ensurePositive(market.forward, 'forward', functionName, ErrorCode.InputNegativeSpot);
  ensurePositive(market.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  const asOfMs = resolveValuationAsOf(market.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  const t = resolveExpiryYears(asOfMs, contract, functionName);
  const F = market.forward;
  const value = black76Price({
    type: contract.type,
    forward: F,
    strike: contract.strike,
    timeToExpiryYears: t,
    riskFreeRate: market.riskFreeRate,
    volatility: market.volatility,
  });
  // Honor `greeks: false` (engine-substitutability law, spec P2.4) — same contract as the
  // BSM/American/FD engines; `extendedGreeks` implies `greeks`.
  const wantExtended = options?.extendedGreeks ?? false;
  const wantGreeks = wantExtended || (options?.greeks ?? true);
  const greeks = !wantGreeks
    ? undefined
    : wantExtended
      ? black76ExtendedGreeks({
          type: contract.type,
          forward: F,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: market.riskFreeRate,
          volatility: market.volatility,
        })
      : black76Greeks({
          type: contract.type,
          forward: F,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: market.riskFreeRate,
          volatility: market.volatility,
        });
  const warnings: QuantWarning[] = [];
  if (!wantGreeks) {
    warnings.push({
      code: WarningCode.GreeksNotComputed,
      message: 'Greeks were not computed (greeks: false).',
      severity: 'info',
    });
  } else if (wantExtended && (greeks as ExtendedGreeks).lambda === null) {
    warnings.push({
      code: WarningCode.LambdaUndefined,
      message:
        'lambda (elasticity Δ·F/V) is undefined — the option price underflowed to zero; reported as null, never NaN/Infinity.',
      severity: 'info',
    });
  }
  const assumptions: Assumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf: asOfMs,
    timeToExpiryYears: t,
    expiryConvention: expiryConventionOf(contract.expiry),
    dividendModel: 'none',
    units: DEFAULT_GREEK_UNITS,
    model: 'black-76',
    engine: 'black-76',
  };
  const base = {
    value,
    assumptions,
    diagnostics: { engine: 'black-76', method: 'closed-form', converged: true, warnings },
  };
  return greeks ? { ...base, greeks } : base;
}

/** Resolve time-to-expiry in years, throwing (never fabricating) when the contract is not live. */
function resolveExpiryYears(
  asOf: EpochMs | string,
  contract: OptionContract,
  functionName: string,
): number {
  // ONE expiry law (D2): built contracts price from the stamped `expiresAt` with the
  // label cross-checked — identical to the BSM/FD/MC engines, never the display string alone.
  const t = contractTimeToExpiryYears(
    resolveValuationAsOf(asOf, functionName),
    contract,
    functionName,
  );
  if (t <= 0) {
    throw new UnsupportedError(
      `${functionName}: contract expiry ${contract.expiry} is not after asOf.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: { asOf, expiry: contract.expiry, timeToExpiryYears: t },
      },
    );
  }
  return t;
}

/** Guard a European-only engine when its `price` is called directly (not through `supports()`). */
function requireEuropean(engine: string, contract: OptionContract): void {
  if (contract.style !== 'european') {
    throw new UnsupportedError(
      `${engine} prices European-style options only; received style "${contract.style}".`,
      { code: ErrorCode.EngineUnsupportedContract, context: { engine, style: contract.style } },
    );
  }
}

/**
 * Re-stamp the temporal metadata on a stochastic-kernel result. The low-level `hestonPrice`/
 * `sabrPrice`/`localVolatilityMonteCarloPrice` kernels take `t` directly and carry neither `asOf` nor the expiry
 * label; the engine adapters compute `t` from `expiry`/`asOf`, so they must also echo the `asOf`
 * they used AND the applied expiry-resolution convention — matching the analytic engines'
 * assumptions exactly (P1.6: the convention is never silent on any engine).
 */
function withTimeMetadata<T extends PriceResult>(
  result: T,
  asOf: EpochMs | string,
  expiry: string,
): T {
  return {
    ...result,
    assumptions: {
      ...result.assumptions,
      asOf: resolveValuationAsOf(asOf, 'option.price'),
      expiryConvention: expiryConventionOf(expiry),
    },
  };
}

const AMERICAN_EUROPEAN: OptionStyle[] = ['american', 'european'];

function americanFrom(
  name: string,
  method: string,
  pricer: AmericanEngineConfig['pricer'],
  extras: Pick<
    AmericanEngineConfig,
    'solve' | 'extendedGreeks' | 'rateStepFloor' | 'warnings'
  > = {},
): OptionPricingEngine {
  const { solve, extendedGreeks, rateStepFloor, warnings } = extras;
  return makeAmericanEngine({
    name,
    method,
    styles: AMERICAN_EUROPEAN,
    pricer,
    ...(solve !== undefined ? { solve } : {}),
    ...(extendedGreeks !== undefined ? { extendedGreeks } : {}),
    ...(rateStepFloor !== undefined ? { rateStepFloor } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * The most steps a tree engine accepts (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check admitted a step count whose lattice rollback
 * could never finish — binomial and trinomial trees both visit O(steps²) nodes (~3×10^8 at the cap
 * ≈ 8 s, measured ~24 ns/node), and every Greek re-prices the tree several times. Matches
 * MAX_LATTICE_STEPS in equity-lattice.ts; tree pricing error is O(1/steps), long converged by then.
 */
const MAX_TREE_STEPS = 25_000;

/**
 * The most grid points / time steps the Crank–Nicolson engine accepts per axis, and the most CELLS
 * (gridPoints × timeSteps) per solve (2026-08-23 review, P0): the solver runs one O(gridPoints)
 * tridiagonal solve per time step, so the PRODUCT is the workload — 10^8 cells at a few flops each
 * is ~2–5 s, and each axis alone being modest proves nothing about the product (10^5 × 10^5 = 10^10
 * cells, minutes). FD error is O(Δx² + Δt²); the 200 × 200 default already prices to basis points.
 */
const MAX_FD_AXIS = 100_000;
const MAX_FD_CELLS = 100_000_000;

/**
 * Validate a numerical-engine resolution parameter (steps, grid points) at config time. Safe integer
 * AND an operation-appropriate cap (2026-08-23 review, P0): `max` is the bound the caller's algorithm
 * justifies, `why` the one-line reason taught in the refusal.
 */
function requirePositiveInt(
  value: number,
  field: string,
  functionName: string,
  max: number,
  why: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InputError(
      `${functionName}: ${field} must be an integer in [1, ${max.toLocaleString('en-US')}] — ${why} Received ${value}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { [field]: value, max },
      },
    );
  }
  return value;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations, so a
 * misspelled `path`/`step`/`varient` teaches at CONFIG time, not silently simulating with defaults
 * (Law 12). Resolved at module load so a stale key fails at import. (The `OptionPricingEngine#supports`
 * head lives in engine-factory.ts — `requireSupportsContract` — shared with `makeAmericanEngine`.)
 */
function enginesSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `engines: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const ENGINES_AUTO_SPEC = enginesSpecOf('engines.auto#0');
const ENGINES_BINOMIAL_SPEC = enginesSpecOf('engines.binomial#0');
const ENGINES_TRINOMIAL_SPEC = enginesSpecOf('engines.trinomial#0');
const ENGINES_FD_CRANK_NICOLSON_SPEC = enginesSpecOf('engines.finiteDifference.crankNicolson#0');
const ENGINES_HESTON_PARAMETERS_SPEC = enginesSpecOf('engines.heston#0');
const ENGINES_HESTON_OPTIONS_SPEC = enginesSpecOf('engines.heston#1');
const ENGINES_SABR_PARAMETERS_SPEC = enginesSpecOf('engines.sabr#0');
const ENGINES_SABR_OPTIONS_SPEC = enginesSpecOf('engines.sabr#1');
const ENGINES_MONTE_CARLO_SPEC = enginesSpecOf('engines.monteCarlo#0');
const ENGINES_LOCAL_VOL_OPTIONS_SPEC = enginesSpecOf('engines.localVolatility#1');

const ENGINES_AUTO_EXAMPLE = (): string => "engines.auto({ objective: 'accuracy' })";
const ENGINES_BINOMIAL_EXAMPLE = (): string =>
  "engines.binomial({ variant: 'leisen-reimer', steps: 501 })";
const ENGINES_TRINOMIAL_EXAMPLE = (): string => 'engines.trinomial({ steps: 300 })';
const ENGINES_FD_CRANK_NICOLSON_EXAMPLE = (): string =>
  'engines.finiteDifference.crankNicolson({ gridPoints: 200, timeSteps: 200 })';
const ENGINES_MONTE_CARLO_EXAMPLE = (): string => 'engines.monteCarlo({ seed: 42, paths: 200000 })';
const ENGINES_HESTON_EXAMPLE = (): string =>
  'engines.heston({ v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.6 }, { terms: 256 })';
const ENGINES_SABR_EXAMPLE = (): string =>
  'engines.sabr({ alpha: 0.2, beta: 0.5, rho: -0.3, nu: 0.4 })';
const ENGINES_LOCAL_VOL_EXAMPLE = (): string =>
  'engines.localVolatility(surface, { seed: 42, paths: 20000, steps: 100 })';

export interface BinomialEngineOptions {
  variant?: BinomialVariant;
  steps?: number;
}
export interface TrinomialEngineOptions {
  steps?: number;
}
export interface FiniteDifferenceEngineOptions {
  gridPoints?: number;
  timeSteps?: number;
}

/**
 * Built-in pricing engines (analytical, lattice, closed-form American approximations, and FDM) —
 * every factory returns an {@link OptionPricingEngine} usable wherever an engine is accepted.
 *
 * @example
 * ```ts
 * import { engines, market, option } from '@totalfinance/options';
 *
 * const contract = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
 * const mkt = market({ spot: 195, riskFreeRate: 0.045, volatility: 0.24, asOf: '2026-07-20T10:30:00-04:00' });
 *
 * option.price({ contract, market: mkt });                                  // engines.auto() default
 * option.price({ contract, market: mkt, engine: engines.binomial({ steps: 501 }) });
 * option.compareEngines({ contract, market: mkt });                         // side-by-side table
 * ```
 */
export const engines = {
  /** Textbook Black–Scholes (European, no dividends). */
  blackScholes: (): OptionPricingEngine =>
    makeBlackScholesEngine({ name: 'black-scholes', useDividends: false }),
  /** Black–Scholes–Merton (European) with a continuous dividend yield. */
  blackScholesMerton: (): OptionPricingEngine =>
    makeBlackScholesEngine({ name: 'black-scholes-merton', useDividends: true }),

  /**
   * Black-76 (European options on a forward/future). Prices off `market.forward` and discounts at
   * `market.rate` — the forward embeds carry/dividends, so no separate dividend model is applied.
   */
  black76: (): OptionPricingEngine => ({
    name: 'black-76',
    version: ENGINE_VERSION,
    capabilities: {
      styles: ['european'],
      dividends: ['none'], // carry is embedded in the forward
      greeks: 'analytic',
      extendedGreeks: true,
      deterministic: true,
    },
    supports: (contract) => {
      requireSupportsContract(contract);
      return contract.style === 'european';
    },
    price: ({ contract, market, options }) => priceBlack76Contract(contract, market, options),
  }),

  /** Binomial tree (American or European). Variants: CRR, Jarrow–Rudd, Tian, Leisen–Reimer. */
  binomial: (options: BinomialEngineOptions = {}): OptionPricingEngine => {
    validateClosedRequest('engines.binomial', options, ENGINES_BINOMIAL_SPEC, {
      argumentName: 'options',
      subject: true,
      exampleCall: ENGINES_BINOMIAL_EXAMPLE,
    });
    const variant = options.variant ?? 'crr';
    const requested = requirePositiveInt(
      options.steps ?? 400,
      'steps',
      'engines.binomial',
      MAX_TREE_STEPS,
      'the tree visits O(steps²) nodes per price (≈ 8 s at the cap) and its error is O(1/steps), long converged by then.',
    );
    // Leisen–Reimer's smooth, non-oscillating convergence relies on an ODD number of steps; round an
    // even count up to the next odd and disclose it (the value is still correct either way).
    const steps = variant === 'leisen-reimer' && requested % 2 === 0 ? requested + 1 : requested;
    const warnings: QuantWarning[] =
      steps !== requested
        ? [
            {
              code: WarningCode.BinomialStepsRoundedOdd,
              message: `Leisen–Reimer requires an odd step count for smooth convergence; rounded ${requested} up to ${steps}.`,
              severity: 'info',
              context: { requested, effective: steps },
            },
          ]
        : [];
    // Leisen–Reimer's lattice is anchored on the STRIKE (u/d/p are functions of d₁/d₂), so its price
    // is smooth in the spot and the shared finite-difference path reproduces the analytic Greeks to
    // ~1e-7. Every other variant is anchored on the SPOT — its nodes sit at S·uʲdᵏ — so a sub-spacing
    // bump differences the lattice sawtooth; those read delta/gamma/theta off their own nodes.
    const strikeAnchored = variant === 'leisen-reimer';
    return americanFrom(
      `binomial-${variant}`,
      `binomial-${variant}`,
      ({ type, style, spot, strike, timeToExpiryYears, riskFreeRate, dividendYield, volatility }) =>
        binomialPrice(variant, {
          type,
          style,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
          steps,
        }),
      {
        solve: ({
          type,
          style,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        }) => {
          const solution = binomialSolve(variant, {
            type,
            style,
            spot,
            strike,
            timeToExpiryYears,
            riskFreeRate,
            dividendYield,
            volatility,
            steps,
          });
          const early = solution.early;
          return {
            value: solution.value,
            // Past the branch-probability guard the rollback is a genuine risk-neutral expectation.
            converged: true,
            ...(!strikeAnchored && early !== undefined
              ? {
                  spotGreeks: latticeSpotGreeks({
                    spot,
                    rootValue: solution.value,
                    early,
                  }),
                }
              : {}),
          };
        },
        extendedGreeks: strikeAnchored,
        // Jarrow–Rudd and Tian bake the drift into their NODE SPOTS, so the whole grid moves with the
        // rate: the rate bump must shift the terminal nodes by at least one node spacing
        // (Δr·T ≥ σ·√Δt ⇒ Δr ≥ σ/√(steps·T)) or it differences the lattice sawtooth. CRR and
        // Leisen–Reimer keep the reference 1e-4 bump — their node spots do not carry the rate.
        ...(variant === 'jarrow-rudd' || variant === 'tian'
          ? {
              rateStepFloor: ({
                volatility,
                timeToExpiryYears,
              }: {
                volatility: number;
                timeToExpiryYears: number;
              }): number => volatility / Math.sqrt(steps * Math.max(timeToExpiryYears, 1e-12)),
            }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    );
  },

  /** Trinomial tree (American or European). */
  trinomial: (options: TrinomialEngineOptions = {}): OptionPricingEngine => {
    validateClosedRequest('engines.trinomial', options, ENGINES_TRINOMIAL_SPEC, {
      argumentName: 'options',
      subject: true,
      exampleCall: ENGINES_TRINOMIAL_EXAMPLE,
    });
    const steps = requirePositiveInt(
      options.steps ?? 300,
      'steps',
      'engines.trinomial',
      MAX_TREE_STEPS,
      'the tree visits O(steps²) nodes per price (≈ 8 s at the cap) and its error is O(1/steps), long converged by then.',
    );
    return americanFrom(
      'trinomial',
      'trinomial',
      ({ type, style, spot, strike, timeToExpiryYears, riskFreeRate, dividendYield, volatility }) =>
        trinomialPrice({
          type,
          style,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
          steps,
        }),
      {
        solve: ({
          type,
          style,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        }) => {
          const solution = trinomialSolve({
            type,
            style,
            spot,
            strike,
            timeToExpiryYears,
            riskFreeRate,
            dividendYield,
            volatility,
            steps,
          });
          const early = solution.early;
          return {
            value: solution.value,
            converged: true,
            ...(early !== undefined
              ? { spotGreeks: latticeSpotGreeks({ spot, rootValue: solution.value, early }) }
              : {}),
          };
        },
        extendedGreeks: false,
      },
    );
  },

  /**
   * Barone–Adesi–Whaley American approximation (European falls through to BSM). Requires a POSITIVE
   * rate: the quadratic approximation's exponent divides by `1 − e^{−rT}`, so it refuses `r ≤ 0`
   * with `engine.unsupported_contract` instead of returning NaN or a diverging value.
   */
  baroneAdesiWhaley: (): OptionPricingEngine =>
    americanFrom('barone-adesi-whaley', 'barone-adesi-whaley', americanApproximation(bawPrice), {
      solve: ({
        type,
        style,
        spot,
        strike,
        timeToExpiryYears,
        riskFreeRate,
        dividendYield,
        volatility,
      }) => {
        if (style === 'european') {
          return {
            value: blackScholesPrice({
              type,
              spot,
              strike,
              timeToExpiryYears,
              riskFreeRate,
              dividendYield,
              volatility,
            }),
            converged: true,
          };
        }
        // The critical-price Newton loop's own verdict rides the diagnostics — never assumed true.
        const solution = bawSolve({
          type,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        });
        return {
          value: solution.value,
          converged: solution.converged,
          ...(solution.iterations > 0 ? { iterations: solution.iterations } : {}),
          ...(solution.converged
            ? {}
            : {
                warnings: [
                  {
                    code: ErrorCode.SolverNoConvergence,
                    message:
                      'barone-adesi-whaley: the critical-price Newton iteration hit its budget without meeting ' +
                      'tolerance; the value is the last iterate and is not trustworthy. Price this contract with ' +
                      "engines.bjerksundStensland2002() or engines.binomial({ variant: 'leisen-reimer', steps: 501 }).",
                    severity: 'warn' as const,
                  },
                ],
              }),
        };
      },
    }),

  /**
   * Bjerksund–Stensland American approximation — alias for the more accurate, more widely-used
   * **2002** two-boundary form. Use {@link engines.bjerksundStensland1993} for the original
   * single-boundary version. (European contracts fall through to BSM.)
   */
  bjerksundStensland: (): OptionPricingEngine =>
    americanFrom(
      'bjerksund-stensland',
      'bjerksund-stensland-2002',
      americanApproximation(bjerksundStensland2002Price),
    ),

  /** Bjerksund–Stensland (2002) two-boundary American approximation (European falls through to BSM). */
  bjerksundStensland2002: (): OptionPricingEngine =>
    americanFrom(
      'bjerksund-stensland-2002',
      'bjerksund-stensland-2002',
      americanApproximation(bjerksundStensland2002Price),
    ),

  /** Bjerksund–Stensland (1993) single-boundary American approximation (European falls through to BSM). */
  bjerksundStensland1993: (): OptionPricingEngine =>
    americanFrom(
      'bjerksund-stensland-1993',
      'bjerksund-stensland-1993',
      americanApproximation(bjerksundStenslandPrice),
    ),

  /** Crank–Nicolson finite-difference engine (American or European). */
  finiteDifference: {
    crankNicolson: (options: FiniteDifferenceEngineOptions = {}): OptionPricingEngine => {
      validateClosedRequest(
        'engines.finiteDifference.crankNicolson',
        options,
        ENGINES_FD_CRANK_NICOLSON_SPEC,
        {
          argumentName: 'options',
          subject: true,
          exampleCall: ENGINES_FD_CRANK_NICOLSON_EXAMPLE,
        },
      );
      const gridPoints = requirePositiveInt(
        options.gridPoints ?? 200,
        'gridPoints',
        'engines.finiteDifference.crankNicolson',
        MAX_FD_AXIS,
        'the solver runs one O(gridPoints) tridiagonal solve per time step, and FD error is O(Δx²) — the 200-point default already prices to basis points.',
      );
      const timeSteps = requirePositiveInt(
        options.timeSteps ?? 200,
        'timeSteps',
        'engines.finiteDifference.crankNicolson',
        MAX_FD_AXIS,
        'each time step costs an O(gridPoints) tridiagonal solve, and FD error is O(Δt²) — the 200-step default already prices to basis points.',
      );
      // The PRODUCT gridPoints × timeSteps is the solve's cell count — bound it even when each axis
      // alone is under its cap (2026-08-23 review, P0: multiplying counts must be bounded together).
      if (gridPoints * timeSteps > MAX_FD_CELLS) {
        throw new InputError(
          `engines.finiteDifference.crankNicolson: gridPoints × timeSteps must not exceed ${MAX_FD_CELLS.toLocaleString('en-US')} cells — the solver touches every cell (a few flops each, ~2–5 s at the cap), so the product is the workload. Received ${gridPoints} × ${timeSteps} = ${(gridPoints * timeSteps).toLocaleString('en-US')}.\n  e.g. ${ENGINES_FD_CRANK_NICOLSON_EXAMPLE()}`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { gridPoints, timeSteps, maxCells: MAX_FD_CELLS },
          },
        );
      }
      return americanFrom(
        'crank-nicolson',
        'crank-nicolson',
        ({
          type,
          style,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        }) =>
          crankNicolsonPrice({
            type,
            style,
            spot,
            strike,
            timeToExpiryYears,
            riskFreeRate,
            dividendYield,
            volatility,
            gridPoints,
            timeSteps,
          }),
        {
          solve: ({
            type,
            style,
            spot,
            strike,
            timeToExpiryYears,
            riskFreeRate,
            dividendYield,
            volatility,
          }) => {
            const solution = crankNicolsonSolve({
              type,
              style,
              spot,
              strike,
              timeToExpiryYears,
              riskFreeRate,
              dividendYield,
              volatility,
              gridPoints,
              timeSteps,
            });
            return {
              value: solution.value,
              // The grid reports its own adequacy for the requested regime (σ√T-aware truncation
              // AND near-strike resolution), never a hardcoded true.
              converged: solution.converged,
              ...(solution.warnings.length > 0 ? { warnings: solution.warnings } : {}),
              spotGreeks: {
                delta: solution.delta,
                gamma: solution.gamma,
                thetaPerYear: solution.thetaPerYear,
              },
            };
          },
          extendedGreeks: false,
        },
      );
    },
  },

  /**
   * Geometric-Brownian-motion Monte-Carlo engine (European only). The seed is required and echoed;
   * the result carries MC error statistics on `result.mc` (and is a superset of {@link PriceResult}).
   * Excluded from the {@link compareEngines} default panel — a stochastic engine belongs in a
   * comparison only when the caller options in with a fixed seed.
   */
  monteCarlo: (options: MonteCarloPriceOptions): OptionPricingEngine => {
    validateClosedRequest('engines.monteCarlo', options, ENGINES_MONTE_CARLO_SPEC, {
      argumentName: 'options',
      subject: true,
      exampleCall: ENGINES_MONTE_CARLO_EXAMPLE,
    });
    // A configured engine is a successful public call: reject an impossible path budget now, not on
    // the first later `price()` invocation.
    validateMonteCarloSamplingOptions(1, options, 'engines.monteCarlo');
    return {
      name: 'monte-carlo',
      version: ENGINE_VERSION,
      capabilities: {
        styles: ['european'],
        dividends: ['none', 'continuous'],
        greeks: 'finite-difference',
        extendedGreeks: true,
        deterministic: false, // seeded reproducibility — the suite verifies same-seed equality
      },
      supports: (contract) => {
        requireSupportsContract(contract);
        return contract.style === 'european';
      },
      // Forward a per-call `greeks` override so `option.price({ contract: c, market: m, greeks: true })` reaches the MC
      // kernel instead of being silently dropped in favour of the engine-config default.
      price: ({ contract, market, options: priceOpts }) => {
        const greeks = priceOpts?.greeks ?? options.greeks;
        const extendedGreeks = priceOpts?.extendedGreeks ?? options.extendedGreeks;
        return monteCarloPrice({
          contract,
          market,
          options: {
            ...options,
            ...(greeks !== undefined ? { greeks } : {}),
            ...(extendedGreeks !== undefined ? { extendedGreeks } : {}),
          },
        });
      },
    };
  },

  /**
   * Heston stochastic-volatility engine (spec §9.3, WS4.3): European vanillas via the COS method.
   * American exercise is unsupported (`supports()` returns `false`). The low-level named-input kernel
   * {@link hestonPrice} remains the direct API; this adapter lets Heston flow through `option.price`,
   * `priceMany`, and `compareEngines`.
   */
  heston: (
    parameters: HestonParameters,
    options: HestonCosineExpansionOptions = {},
  ): OptionPricingEngine => {
    validateClosedRequest('engines.heston', parameters, ENGINES_HESTON_PARAMETERS_SPEC, {
      argumentName: 'parameters',
      exampleCall: ENGINES_HESTON_EXAMPLE,
    });
    validateClosedRequest('engines.heston', options, ENGINES_HESTON_OPTIONS_SPEC, {
      argumentName: 'options',
      exampleCall: ENGINES_HESTON_EXAMPLE,
    });
    requireHestonCosineTermCount('engines.heston', options.terms);
    return {
      name: 'heston',
      version: ENGINE_VERSION,
      capabilities: {
        styles: ['european'],
        dividends: ['none', 'continuous'],
        greeks: 'finite-difference',
        extendedGreeks: true,
        deterministic: true, // COS is analytic — only the Greeks are differenced
      },
      supports: (contract) => {
        requireSupportsContract(contract);
        return contract.style === 'european';
      },
      price: ({ contract, market, options: priceOpts }) => {
        requireEuropean('heston', contract);
        const t = resolveExpiryYears(market.asOf, contract, 'option.price(heston)');
        const input: HestonInput = {
          spot: market.spot,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: market.riskFreeRate,
          dividendYield: market.dividendYield ?? 0,
        };
        const greeks = priceOpts?.greeks ?? options.greeks ?? true;
        const extendedGreeks = priceOpts?.extendedGreeks ?? options.extendedGreeks ?? false;
        return withTimeMetadata(
          hestonPrice({
            type: contract.type,
            input,
            parameters,
            options: { ...options, greeks, extendedGreeks },
          }),
          market.asOf,
          contract.expiry,
        );
      },
    };
  },

  /**
   * SABR engine (spec §9.3, WS4.3): European vanillas via Hagan's implied vol into Black-76
   * (lognormal) or Bachelier (normal). Uses `market.forward` when present, else the spot-implied
   * forward. Low-level named-input kernel: {@link sabrPrice}.
   */
  sabr: (parameters: SabrParameters, options: SabrOptions = {}): OptionPricingEngine => {
    validateClosedRequest('engines.sabr', parameters, ENGINES_SABR_PARAMETERS_SPEC, {
      argumentName: 'parameters',
      exampleCall: ENGINES_SABR_EXAMPLE,
    });
    validateClosedRequest('engines.sabr', options, ENGINES_SABR_OPTIONS_SPEC, {
      argumentName: 'options',
      exampleCall: ENGINES_SABR_EXAMPLE,
    });
    return {
      name: 'sabr',
      version: ENGINE_VERSION,
      capabilities: {
        styles: ['european'],
        dividends: ['none', 'continuous'],
        greeks: 'finite-difference',
        extendedGreeks: true,
        deterministic: true, // Hagan closed form
      },
      supports: (contract) => {
        requireSupportsContract(contract);
        return contract.style === 'european';
      },
      price: ({ contract, market, options: priceOpts }) => {
        requireEuropean('sabr', contract);
        const t = resolveExpiryYears(market.asOf, contract, 'option.price(sabr)');
        const q = market.dividendYield ?? 0;
        const input: SabrInput =
          market.forward !== undefined
            ? {
                forward: market.forward,
                strike: contract.strike,
                timeToExpiryYears: t,
                riskFreeRate: market.riskFreeRate,
                dividendYield: q,
              }
            : {
                spot: market.spot,
                strike: contract.strike,
                timeToExpiryYears: t,
                riskFreeRate: market.riskFreeRate,
                dividendYield: q,
              };
        const greeks = priceOpts?.greeks ?? options.greeks ?? true;
        const extendedGreeks = priceOpts?.extendedGreeks ?? options.extendedGreeks ?? false;
        // An out-of-domain Hagan point throws from the kernel (typed `input.out_of_range`); the engine
        // lets it propagate, so compareEngines shows a failed row instead of a negative "price".
        return withTimeMetadata(
          sabrPrice({
            type: contract.type,
            input,
            parameters,
            options: { ...options, greeks, extendedGreeks },
          }),
          market.asOf,
          contract.expiry,
        );
      },
    };
  },

  /**
   * Local-volatility (Dupire) Monte-Carlo engine (spec §9.3, WS4.3): European vanillas. `surface` is a
   * `LocalVolatilityFunction` `(level, t) → σ` (typically from `dupireLocalVolatility`); `options` requires a seed (echoed).
   * Greeks are not computed by the MC engine — absent, never fabricated. Low-level kernel:
   * {@link localVolatilityMonteCarloPrice}.
   */
  localVolatility: (
    surface: LocalVolatilityFunction,
    options: LocalVolatilityMonteCarloOptions,
  ): OptionPricingEngine => {
    // Law 12 at config time: a misspelled MC option must never silently simulate with defaults —
    // the generated spec closes the options object AND requires the seed (arg #1; arg #0 is the
    // surface callback, which has no generated key and takes the solver-family typeof check:
    // omitting it returned a complete-looking engine that only failed lazily at price time).
    if (typeof surface !== 'function') {
      throw new InputError(
        `engines.localVolatility: surface must be a function (sigma_local(spot, timeYears)). Received ${surface === null ? 'null' : typeof surface}.`,
        {
          code: ErrorCode.InputWrongType,
          context: {
            function: 'engines.localVolatility',
            field: 'surface',
            received: surface === null ? 'null' : typeof surface,
          },
        },
      );
    }
    validateClosedRequest('engines.localVolatility', options, ENGINES_LOCAL_VOL_OPTIONS_SPEC, {
      argumentName: 'options',
      exampleCall: ENGINES_LOCAL_VOL_EXAMPLE,
    });
    // `steps` is the MC dimension, so validate both axes and their real paths × steps workload before
    // returning a complete-looking engine that would fail only when used.
    validateMonteCarloSamplingOptions(
      options.steps ?? DEFAULT_LOCAL_VOLATILITY_STEPS,
      options,
      'engines.localVolatility',
    );
    return {
      name: 'local-volatility',
      version: ENGINE_VERSION,
      capabilities: {
        styles: ['european'],
        dividends: ['none', 'continuous'],
        greeks: 'none', // disclosed as unhonored on request, never silently dropped
        extendedGreeks: false,
        deterministic: false,
      },
      supports: (contract) => {
        requireSupportsContract(contract);
        return contract.style === 'european';
      },
      price: ({ contract, market, options: priceOpts }) => {
        requireEuropean('local-volatility', contract);
        const t = resolveExpiryYears(market.asOf, contract, 'option.price(local-volatility)');
        const input: LocalVolatilityInput = {
          spot: market.spot,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: market.riskFreeRate,
          dividendYield: market.dividendYield ?? 0,
        };
        const result = withTimeMetadata(
          localVolatilityMonteCarloPrice({
            type: contract.type,
            input,
            localVolatility: surface,
            options,
          }),
          market.asOf,
          contract.expiry,
        );
        // This engine cannot compute Greeks. The KERNEL already flags `greeks.not_computed`, so the
        // adapter never appends its own copy (no duplicate diagnostics). On an EXPLICIT request the
        // generic flag is REPLACED by the precise capability code — one warning, the sharpest one —
        // because a request an engine can't honor must never be silently dropped (P2.4).
        const requested = priceOpts?.greeks === true || priceOpts?.extendedGreeks === true;
        if (!requested) return result;
        return {
          ...result,
          diagnostics: {
            ...result.diagnostics,
            warnings: [
              ...result.diagnostics.warnings.filter((w) => w.code !== 'greeks.not_computed'),
              {
                code: WarningCode.GreeksUnsupportedByEngine,
                message:
                  'The local-volatility MC engine cannot compute Greeks — the request was not honored. ' +
                  'Compute them by bump-and-reprice under the same local-volatility surface, or choose a ' +
                  'Greek-capable engine if model substitution is acceptable.',
                severity: 'warn',
              },
            ],
          },
        };
      },
    };
  },

  /**
   * Auto-select a pricing engine by objective (spec §9.3). The default `'accuracy'` favours the most
   * accurate engine; `'speed'` favours the fastest closed form. Selection (delegate in **bold**):
   *
   * | Contract                       | speed                         | accuracy                      |
   * | ------------------------------ | ----------------------------- | ----------------------------- |
   * | European (spot)                | **black-scholes-merton**      | same                          |
   * | European (forward, no spot)    | **black-76**                  | same                          |
   * | American call, no dividends    | **black-scholes-merton** ¹    | same                          |
   * | American (otherwise)           | **bjerksund-stensland-2002**  | **binomial-leisen-reimer** ²  |
   * | Unsupported (e.g. bermudan)    | throws `engine.unsupported_contract`               |
   *
   * ¹ Early exercise of a non-dividend call is never optimal, so its value equals the European BSM
   *   price. ² 501-step lattice. The result's `diagnostics.engine` is the DELEGATE's name and
   *   `diagnostics.autoReason` explains, in one sentence, why it was chosen.
   */
  auto: (options: AutoEngineOptions = {}): OptionPricingEngine => {
    validateClosedRequest('engines.auto', options, ENGINES_AUTO_SPEC, {
      argumentName: 'options',
      subject: true,
      exampleCall: ENGINES_AUTO_EXAMPLE,
    });
    const objective: AutoObjective = options.objective ?? 'accuracy';
    return {
      name: 'auto',
      version: ENGINE_VERSION,
      capabilities: {
        styles: ['european', 'american'],
        dividends: ['none', 'continuous', 'discrete'],
        greeks: 'delegated',
        extendedGreeks: true,
        deterministic: true, // every delegate in the routing table is deterministic
      },
      // Every vanilla style routes to a supporting delegate; exotic styles (bermudan) do not.
      supports: (contract) => {
        requireSupportsContract(contract);
        return contract.style === 'european' || contract.style === 'american';
      },
      price: ({ contract, market, options: priceOpts }) => {
        const chosen = resolveAutoDelegate(contract, market, objective);
        if (chosen === null) {
          throw new UnsupportedError(
            `engines.auto: no built-in engine supports a "${contract.style}" ${contract.type}.`,
            {
              code: ErrorCode.EngineUnsupportedContract,
              context: { style: contract.style, type: contract.type, objective },
            },
          );
        }
        const result = chosen.engine.price({
          contract: chosen.contract,
          market,
          ...(priceOpts !== undefined ? { options: priceOpts } : {}),
        });
        // Delegate transparency (spec §9.3): report the delegate as the engine and record why.
        // `selection` is the Gate C structured superset of engine+autoReason — same decision, one
        // more level of honesty: every candidate the routing considered, with its verdict.
        return {
          ...result,
          diagnostics: {
            ...result.diagnostics,
            engine: chosen.engine.name,
            autoReason: chosen.reason,
            selection: {
              mode: 'automatic',
              selected: { name: chosen.engine.name, version: chosen.engine.version },
              reason: chosen.reason,
              candidates: chosen.candidates,
            },
          },
        };
      },
    };
  },
} as const;

/** Objective steering {@link engines.auto}: maximise accuracy (default) or speed. */
export type AutoObjective = 'speed' | 'accuracy';

export interface AutoEngineOptions {
  /** `'accuracy'` (default) picks the most accurate engine; `'speed'` the fastest closed form. */
  objective?: AutoObjective;
}

/** A resolved auto delegate: the engine, the (possibly rewritten) contract, and the reason. */
interface AutoDelegate {
  engine: OptionPricingEngine;
  contract: OptionContract;
  reason: string;
  /**
   * Every engine the routing table considered for THIS contract/market, each with an eligibility
   * verdict and a one-sentence reason (Gate C inspectable-selection: the routing function is the
   * single source of decision truth, so it also owns the disclosure — nothing re-derives it).
   */
  candidates: SelectionCandidate[];
}

/**
 * Resolve the delegate {@link engines.auto} should use for `(contract, market)`. Returns `null` when
 * no built-in engine supports the contract (the caller throws `engine.unsupported_contract`).
 */
function resolveAutoDelegate(
  contract: OptionContract,
  market: OptionMarket,
  objective: AutoObjective,
): AutoDelegate | null {
  if (contract.style === 'european') {
    // WS3.2 keeps `market.spot` required on OptionMarket, so the standard European path is BSM. A
    // forward-only market (spot omitted at runtime — the same `typeof` guard requireSpot() uses) is
    // priced on the forward with Black-76.
    const spotUsable = typeof market.spot === 'number' && market.spot > 0;
    const forwardOnly = !spotUsable && market.forward !== undefined;
    const black76Reason = forwardOnly
      ? 'European contract with a forward and no usable spot: priced on the forward with Black-76.'
      : market.forward !== undefined
        ? 'Not selected: a usable spot is present, and the spot-based Black–Scholes–Merton route is preferred; the forward route is reserved for forward-only markets.'
        : 'Ineligible: requires market.forward, which this market does not supply.';
    const bsmReason = forwardOnly
      ? 'Not selected: no usable spot to price off — the forward-only Black-76 route applied.'
      : 'European contract: priced with the closed-form Black–Scholes–Merton model.';
    const candidates: SelectionCandidate[] = [
      { name: 'black-76', eligible: market.forward !== undefined, reason: black76Reason },
      { name: 'black-scholes-merton', eligible: spotUsable, reason: bsmReason },
    ];
    if (forwardOnly) {
      return { engine: engines.black76(), contract, reason: black76Reason, candidates };
    }
    return { engine: engines.blackScholesMerton(), contract, reason: bsmReason, candidates };
  }

  if (contract.style === 'american') {
    const noDividends = (market.dividendYield ?? 0) === 0 && !hasDiscreteDividends(market);
    // The "American call = European when no dividends" theorem also REQUIRES a non-negative rate:
    // with r < 0, deferring the strike payment is costly, so early exercise can be optimal and the
    // BSM shortcut would undervalue the option. A negative-rate call falls through to the lattice.
    const shortcut = contract.type === 'call' && noDividends && (market.riskFreeRate ?? 0) >= 0;
    const shortcutReason = shortcut
      ? 'American call with no dividends and a non-negative rate: early exercise is never optimal, so its value equals the European Black–Scholes–Merton price.'
      : 'Ineligible: early exercise can be optimal here (a put, dividends, or a negative rate), which the European closed form cannot price.';
    const speedReason = shortcut
      ? 'Not selected: the no-dividend call shortcut prices exactly with the European closed form.'
      : objective === 'speed'
        ? 'American option (objective: speed): priced with the Bjerksund–Stensland (2002) closed-form approximation.'
        : 'Not selected: objective "accuracy" prefers the 501-step Leisen–Reimer lattice.';
    const accuracyReason = shortcut
      ? 'Not selected: the no-dividend call shortcut prices exactly with the European closed form.'
      : objective === 'speed'
        ? 'Not selected: objective "speed" prefers the Bjerksund–Stensland closed-form approximation.'
        : 'American option (objective: accuracy): priced with a 501-step Leisen–Reimer binomial lattice.';
    const candidates: SelectionCandidate[] = [
      { name: 'black-scholes-merton', eligible: shortcut, reason: shortcutReason },
      { name: 'bjerksund-stensland-2002', eligible: true, reason: speedReason },
      { name: 'binomial-leisen-reimer', eligible: true, reason: accuracyReason },
    ];
    if (shortcut) {
      // American call, no dividends, r ≥ 0: early exercise is never optimal, so the value equals the
      // European BSM price. Price a European clone so BSM's `supports()` gate is satisfied.
      return {
        engine: engines.blackScholesMerton(),
        contract: { ...contract, style: 'european' },
        reason: shortcutReason,
        candidates,
      };
    }
    return objective === 'speed'
      ? { engine: engines.bjerksundStensland2002(), contract, reason: speedReason, candidates }
      : {
          engine: engines.binomial({ variant: 'leisen-reimer', steps: 501 }),
          contract,
          reason: accuracyReason,
          candidates,
        };
  }

  // e.g. bermudan — no built-in engine prices it.
  return null;
}

/** Wrap an American-only closed form so European contracts fall through to the BSM price. */
function americanApproximation(
  pricer: AmericanApproximationPricer,
): AmericanEngineConfig['pricer'] {
  return ({
    type,
    style,
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    dividendYield,
    volatility,
  }) =>
    style === 'european'
      ? blackScholesPrice({
          type,
          spot,
          strike,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        })
      : pricer({ type, spot, strike, timeToExpiryYears, riskFreeRate, dividendYield, volatility });
}

/**
 * Define a custom pricing engine (spec §22.1). TotalFinance treats it like any built-in engine: pass it
 * to `option.price({ contract: contract, market: market, engine: engine })`.
 */
export function defineOptionPricingEngine(engine: OptionPricingEngine): OptionPricingEngine {
  const functionName = 'defineOptionPricingEngine';
  requireEngine(functionName, engine);
  const bad = (what: string, context: Record<string, unknown> = {}): never => {
    throw new InputError(
      `${functionName}: ${what} — declare capabilities { styles, dividends, greeks, extendedGreeks, ` +
        'deterministic } (Law 8) so TotalFinance can verify and route the engine like a built-in.',
      { code: ErrorCode.InputMissingField, context: { function: functionName, ...context } },
    );
  };
  // Identity: a nameless/unversioned engine is unreportable in diagnostics and comparisons.
  if (typeof engine.name !== 'string' || engine.name.trim() === '') {
    bad('engine.name must be a non-empty string', { name: engine.name });
  }
  if (typeof engine.version !== 'string' || engine.version.trim() === '') {
    bad('engine.version must be a non-empty string', { version: engine.version });
  }
  const c = engine.capabilities as EngineCapabilities | undefined;
  if (c === undefined || c === null || typeof c !== 'object') {
    bad('engine.capabilities is required');
  }
  // Member-level enum validation (E6): a typo'd style/dividend model would silently misroute.
  const checkEnumArray = (
    field: string,
    arr: unknown,
    allowed: readonly string[],
  ): readonly string[] => {
    if (!Array.isArray(arr) || arr.length === 0) {
      bad(`capabilities.${field} must be a non-empty array of ${allowed.join(' | ')}`, {
        [field]: arr,
      });
    }
    const seen = new Set<string>();
    for (const v of arr as unknown[]) {
      if (typeof v !== 'string' || !allowed.includes(v)) {
        bad(
          `capabilities.${field} contains ${JSON.stringify(v)} — allowed: ${allowed.join(', ')}`,
          {
            [field]: arr,
          },
        );
      }
      const member = v as string; // narrowed above; bad() throws
      if (seen.has(member)) bad(`capabilities.${field} lists "${member}" twice`, { [field]: arr });
      seen.add(member);
    }
    return arr as readonly string[];
  };
  const cc = c as EngineCapabilities;
  checkEnumArray('styles', cc.styles, ['european', 'american']);
  checkEnumArray('dividends', cc.dividends, ['none', 'continuous', 'discrete']);
  if (!['analytic', 'finite-difference', 'delegated', 'none'].includes(cc.greeks)) {
    bad(
      `capabilities.greeks must be analytic | finite-difference | delegated | none, got ${JSON.stringify(
        cc.greeks,
      )}`,
      { greeks: cc.greeks },
    );
  }
  if (typeof cc.extendedGreeks !== 'boolean') bad('capabilities.extendedGreeks must be a boolean');
  if (typeof cc.deterministic !== 'boolean') bad('capabilities.deterministic must be a boolean');

  // Definition is intentionally STRUCTURAL and side-effect-free. TotalFinance cannot invent a
  // universally valid market fixture: Black-76 needs `forward`, spot engines need `spot`, and a
  // remote/custom engine may require domain-specific data or perform I/O. Callers who want
  // behavioral verification opt into validateOptionPricingEngine(engine, probes) with fixtures
  // that are valid for that engine.
  const capabilities: EngineCapabilities = Object.freeze({
    styles: Object.freeze([...(cc.styles as readonly OptionStyle[])]),
    dividends: Object.freeze([...cc.dividends]),
    greeks: cc.greeks,
    extendedGreeks: cc.extendedGreeks,
    deterministic: cc.deterministic,
  });
  const supportsImpl = engine.supports.bind(engine);
  // The registered engine honors the same `supports(contract)` head as every built-in (spec key
  // `OptionPricingEngine#supports#0`): the closed contract validates BEFORE the custom predicate,
  // so a partial contract teaches identically whichever engine it is probed against.
  const supports = (contract: OptionContract): boolean => {
    requireSupportsContract(contract);
    return supportsImpl(contract);
  };
  const price = engine.price.bind(engine);
  return Object.freeze({
    name: engine.name,
    version: engine.version,
    capabilities,
    supports,
    price,
  });
}

const ENGINE_PROBE_KEYS = ['contract', 'market', 'options'] as const;

/**
 * Behaviorally verify a custom pricing engine against CALLER-SUPPLIED fixtures. Registration via
 * {@link defineOptionPricingEngine} is deliberately side-effect-free; this explicit companion is
 * the place for potentially expensive pricing calls and therefore works for spot, forward,
 * stateful, remote, and domain-specific engines without TotalFinance guessing their inputs.
 *
 * At least one probe is required for every claimed exercise style. Each probe verifies
 * `supports()`, a finite non-negative price, Greek capability claims, extended-Greek claims, and
 * repeat-call value equality when `deterministic` is true. The validated immutable engine is
 * returned for convenient inline use.
 */
export function validateOptionPricingEngine(
  engine: OptionPricingEngine,
  probes: readonly OptionPricingEngineProbe[],
): OptionPricingEngine {
  const functionName = 'validateOptionPricingEngine';
  const defined = defineOptionPricingEngine(engine);
  requireArgumentArray(functionName, 'probes', probes);
  if (probes.length === 0) {
    throw new InputError(
      `${functionName}: probes must contain at least one engine-specific fixture.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'probes' },
      },
    );
  }

  const failProbe = (
    message: string,
    index: number,
    context: Record<string, unknown> = {},
  ): never => {
    throw new InputError(`${functionName}: probes[${index}] ${message}.`, {
      code: ErrorCode.InputWrongShape,
      context: { function: functionName, index, ...context },
    });
  };

  // Validate every fixture's container shape before assessing cross-probe coverage. A malformed
  // probe should identify its own index/field, not masquerade as a missing exercise style.
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]!;
    requireArgumentObject(functionName, `probes[${i}]`, probe);
    ensureKnownKeys(functionName, `probes[${i}]`, probe, ENGINE_PROBE_KEYS);
    if (probe.contract === undefined) failProbe('must include contract', i);
    if (probe.market === undefined) failProbe('must include market', i);
    requireArgumentObject(functionName, `probes[${i}].contract`, probe.contract);
    requireArgumentObject(functionName, `probes[${i}].market`, probe.market);
    if (probe.options !== undefined)
      requireArgumentObject(functionName, `probes[${i}].options`, probe.options);
    if (probe.contract.style !== 'european' && probe.contract.style !== 'american') {
      failProbe(
        `contract.style must be "european" or "american", got ${JSON.stringify(
          probe.contract.style,
        )}`,
        i,
      );
    }
  }

  for (const style of defined.capabilities.styles) {
    if (!probes.some((probe) => probe?.contract?.style === style)) {
      throw new InputError(
        `${functionName}: probes must include a supported ${style} contract because capabilities.styles claims "${style}".`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: 'probes', style },
        },
      );
    }
  }

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]!;
    const claimed = defined.capabilities.styles.includes(probe.contract.style);
    let supportResult: unknown;
    try {
      supportResult = defined.supports(probe.contract);
    } catch (error) {
      failProbe(`supports() threw: ${error instanceof Error ? error.message : String(error)}`, i, {
        cause: error,
      });
    }
    if (typeof supportResult !== 'boolean') {
      failProbe(`supports() returned ${String(supportResult)} instead of a boolean`, i);
    }
    const supported = supportResult;
    if (supported !== claimed) {
      failProbe(
        `disagrees with capabilities.styles: supports() returned ${supported} for style "${probe.contract.style}"`,
        i,
        { style: probe.contract.style, supported },
      );
    }
    if (!supported) continue;

    const priceOnce = (options: PriceOptions | undefined): PriceResult => {
      let result: unknown;
      try {
        result = defined.price({
          contract: probe.contract,
          market: probe.market,
          ...(options !== undefined ? { options } : {}),
        });
      } catch (error) {
        failProbe(`price() threw: ${error instanceof Error ? error.message : String(error)}`, i, {
          cause: error,
        });
      }
      if (result === null || typeof result !== 'object') {
        failProbe(`price() returned ${String(result)} instead of a PriceResult object`, i);
      }
      const priced = result as PriceResult;
      if (typeof priced.value !== 'number' || !Number.isFinite(priced.value) || priced.value < 0) {
        failProbe(`price() returned ${String(priced.value)} (expected a finite value >= 0)`, i, {
          value: priced.value,
        });
      }
      try {
        assertFiniteValue(`${functionName}.probes[${i}]`, priced);
      } catch (error) {
        failProbe(
          `price() returned a non-finite result: ${
            error instanceof Error ? error.message : String(error)
          }`,
          i,
          { cause: error },
        );
      }
      return priced;
    };

    const base = priceOnce(probe.options);
    if (defined.capabilities.deterministic) {
      const again = priceOnce(probe.options);
      if (again.value !== base.value) {
        failProbe(
          `claims deterministic=true but identical calls returned ${base.value} and ${again.value}`,
          i,
          { first: base.value, second: again.value },
        );
      }
    }

    const withGreeks = priceOnce({ ...probe.options, greeks: true });
    if (defined.capabilities.greeks === 'none') {
      if (withGreeks.greeks !== undefined) {
        failProbe('claims greeks="none" but returned Greeks when requested', i);
      }
    } else {
      if (
        withGreeks.greeks === undefined ||
        withGreeks.greeks === null ||
        typeof withGreeks.greeks !== 'object'
      ) {
        failProbe(`claims greeks="${defined.capabilities.greeks}" but returned no Greeks`, i);
      }
      const checkedGreeks = withGreeks.greeks as Greeks | ExtendedGreeks;
      for (const field of ['delta', 'gamma', 'theta', 'vega', 'rho'] as const) {
        if (typeof checkedGreeks[field] !== 'number') {
          failProbe(`claims Greek support but greeks.${field} is missing or non-numeric`, i);
        }
      }
    }

    if (defined.capabilities.extendedGreeks) {
      const extended = priceOnce({ ...probe.options, extendedGreeks: true });
      const greeks = extended.greeks as ExtendedGreeks | undefined;
      if (greeks === undefined) {
        failProbe('claims extendedGreeks=true but returned no extended Greek set', i);
      }
      const checkedGreeks = greeks as ExtendedGreeks;
      for (const field of [
        'vanna',
        'charm',
        'vomma',
        'speed',
        'color',
        'phi',
        'zomma',
        'veta',
        'vera',
        'ultima',
      ] as const) {
        if (typeof checkedGreeks[field] !== 'number') {
          failProbe(`claims extendedGreeks=true but greeks.${field} is missing or non-numeric`, i);
        }
      }
      if (checkedGreeks.lambda !== null && typeof checkedGreeks.lambda !== 'number') {
        failProbe('claims extendedGreeks=true but greeks.lambda is neither numeric nor null', i);
      }
    }
  }

  return defined;
}

/** One engine's result inside a {@link compareEngines} comparison. */
export interface EngineComparisonRow {
  engine: string;
  /** Diagnostic method label (e.g. `binomial-crr`, `crank-nicolson`). */
  method: string;
  /** `null` when the engine failed to price — the failure rides `warnings` (Law 7: never NaN). */
  value: number | null;
  /** Absent when the engine did not compute Greeks (e.g. a Monte-Carlo engine) or failed to price. */
  greeks?: Greeks;
  converged: boolean;
  warnings: QuantWarning[];
  /** Wall-clock pricing time in ms, measured only when a `now` clock is injected (else 0). */
  timingMs: number;
  /** Signed deviation from the reference engine's value; `null` for a failed row. */
  differenceFromReference: number | null;
  absoluteDifferenceFromReference: number | null;
}

/** Result of {@link compareEngines}: rows sorted by accuracy against a high-resolution reference. */
export interface EngineComparison {
  reference: { engine: string; value: number };
  rows: EngineComparisonRow[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; referenceEngine: string; engines: number };
  /** Structured warnings; always present — engine failures are summarized here (details per row). */
  diagnostics: { warnings: QuantWarning[] };
}

export interface CompareEnginesOptions {
  /** Engines to compare. Defaults to the built-in panel that supports the contract. */
  engines?: OptionPricingEngine[];
  /** Convergence benchmark. Defaults to a 1001-step Leisen–Reimer lattice. */
  reference?: OptionPricingEngine;
  /**
   * Optional monotonic clock (e.g. `() => performance.now()`). When supplied, each engine's
   * wall-clock pricing time is measured into `timingMs`. Omitted by default so the function stays
   * pure (no system-clock read) — timing is opt-in instrumentation the caller injects.
   */
  now?: () => number;
}

/** One cohesive request for side-by-side engine comparison. */
export interface CompareEnginesInput {
  contract: OptionContract;
  market: OptionMarket;
  options?: CompareEnginesOptions;
}

/** Law 12 allowlist for {@link CompareEnginesOptions}. */
const COMPARE_ENGINES_KEYS = ['engines', 'reference', 'now'] as const;
const COMPARE_ENGINES_REQUEST_KEYS = ['contract', 'market', 'options'] as const;

/** The default comparison panel for a contract (only engines that support its style are kept). */
function defaultEnginePanel(contract: OptionContract): OptionPricingEngine[] {
  const panel: OptionPricingEngine[] = [];
  if (contract.style === 'european') panel.push(engines.blackScholesMerton());
  panel.push(
    engines.binomial({ variant: 'crr', steps: 400 }),
    engines.binomial({ variant: 'leisen-reimer', steps: 401 }),
    engines.trinomial({ steps: 300 }),
    engines.baroneAdesiWhaley(),
    engines.bjerksundStensland(),
    engines.finiteDifference.crankNicolson({ gridPoints: 200, timeSteps: 200 }),
  );
  return panel.filter((engine) => engine.supports(contract));
}

/**
 * Price one contract across many engines and report each engine's value, Greeks, convergence,
 * timing, and deviation from a high-resolution reference (spec §9.7). Rows are sorted most-accurate
 * first. This is the tool for choosing an engine and for validating new ones against the lattice
 * convergence benchmark — no silent "best" pick, every number is shown with its diagnostics.
 *
 * Supply a custom panel as `options.engines`; all request fields live in one object so adding a
 * benchmark or clock never creates a second calling form.
 */
export function compareEngines(input: CompareEnginesInput): EngineComparison {
  requireArgumentObject('compareEngines', 'input', input);
  ensureKnownKeys('compareEngines', 'input', input, COMPARE_ENGINES_REQUEST_KEYS);
  const { contract, market, options = {} } = input;
  requireArgumentObject('compareEngines', 'contract', contract);
  requireArgumentObject('compareEngines', 'market', market);
  // Contracts and markets are extensible domain artifacts; validate the fields the engines consume.
  // The closed options objects below still reject misspelled control knobs.
  requireOptionalArgObject('compareEngines', 'options', options);
  ensureKnownKeys('compareEngines', 'options', options, COMPARE_ENGINES_KEYS);
  const requested = options.engines;
  if (requested !== undefined) {
    requireArgumentArray('compareEngines', 'engines', requested);
    for (const engine of requested) requireEngine('compareEngines', engine);
  }
  const list = (requested ?? defaultEnginePanel(contract)).filter((engine) =>
    engine.supports(contract),
  );
  const referenceEngine =
    options.reference ?? engines.binomial({ variant: 'leisen-reimer', steps: 1001 });
  requireEngine('compareEngines', referenceEngine);
  const referenceValue = referenceEngine.price({ contract, market }).value;
  const now = options.now;

  const rows: EngineComparisonRow[] = list.map((engine) => {
    const t0 = now ? now() : 0;
    // A failed engine becomes a row with `converged: false` and the reason as a warning — it must
    // not abort the comparison (honoring the per-row contract). Sorted last via a null deviation.
    const failedRow = (code: string, message: string): EngineComparisonRow => ({
      engine: engine.name,
      method: engine.name,
      value: null,
      converged: false,
      warnings: [{ code, message, severity: 'error' }],
      timingMs: now ? now() - t0 : 0,
      differenceFromReference: null,
      absoluteDifferenceFromReference: null,
    });
    try {
      const result = engine.price({ contract, market });
      // An engine that RETURNS a non-finite value fails the row exactly like one that throws:
      // a NaN would otherwise sort as `Infinity` deviation but still present as a priced row, and
      // `NaN - reference` reads as a legitimate-looking null-ish difference downstream (Law 7).
      if (!Number.isFinite(result.value)) {
        return failedRow(
          ErrorCode.PostconditionNonFinite,
          `${engine.name} returned a non-finite value (${String(result.value)}) for this contract; the row is reported as failed rather than compared.`,
        );
      }
      const timingMs = now ? now() - t0 : 0;
      const d = result.diagnostics;
      const difference = result.value - referenceValue;
      return {
        engine: engine.name,
        method: d.method ?? engine.name,
        value: result.value,
        ...(result.greeks ? { greeks: result.greeks } : {}),
        converged: d.converged ?? true,
        warnings: d.warnings,
        timingMs,
        differenceFromReference: difference,
        absoluteDifferenceFromReference: Math.abs(difference),
      };
    } catch (err) {
      const code = isQuantError(err) ? err.code : 'engine.error';
      const message = err instanceof Error ? err.message : 'engine failed to price';
      return failedRow(code, message);
    }
  });
  // Failed rows (null diff) sort last — accuracy ordering is only meaningful for priced rows.
  rows.sort(
    (a, b) =>
      (a.absoluteDifferenceFromReference ?? Infinity) -
      (b.absoluteDifferenceFromReference ?? Infinity),
  );

  // Law 2 report grammar: a serialized comparison is self-interpreting, and a failed engine is
  // disclosed at the top level (row-level detail rides each row's own warnings).
  const failed = rows.filter((r) => !r.converged).map((r) => r.engine);
  const warnings: QuantWarning[] =
    failed.length === 0
      ? []
      : [
          {
            code: WarningCode.OptionsEngineFailed,
            message: `compareEngines: ${failed.join(
              ', ',
            )} failed to price this contract — see the failed rows' warnings for reasons.`,
            severity: 'warn',
            context: { engines: failed },
          },
        ];
  return {
    reference: { engine: referenceEngine.name, value: referenceValue },
    rows,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      referenceEngine: referenceEngine.name,
      engines: rows.length,
    },
    diagnostics: { warnings },
  };
}
