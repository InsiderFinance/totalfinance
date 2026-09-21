/**
 * Factory that wraps a scalar American/European pricer into a full `OptionPricingEngine`:
 * computes the price, derives first-order Greeks, applies the escrowed approximation for discrete
 * dividends, and reports diagnostics (engine, method, convergence, the bumps actually differenced).
 *
 * Greek policy (defect-fix wave, finding 2). A bump-and-reprice spot Greek is only meaningful when
 * the engine's price is smooth in the spot. It is NOT for a lattice or PDE grid anchored on the
 * spot: the universal `S·1e-3` bump is ~20× finer than a CRR node spacing or a Crank–Nicolson `dS`,
 * so the second difference measures the discretization's sawtooth — a gamma of 0.377 (or exactly 0)
 * against a true 0.0189. Those engines therefore supply a `solve` that reads delta/gamma/theta off
 * their OWN nodes; vega and rho stay bump-based, because the price IS smooth in σ and r (the whole
 * grid moves with them). Engines whose price is smooth in the spot — the closed-form American
 * approximations, and the Leisen–Reimer lattice, whose grid is anchored on the STRIKE rather than
 * the spot — keep the pure finite-difference path, verified against the analytic set.
 */

import type { EngineCapabilities, OptionEnginePriceInput } from '../engines.js';
import {
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  type EpochMs,
  InputError,
  type OptionContract,
  type QuantWarning,
  UnsupportedError,
  WarningCode,
  ensureFinite,
  ensurePositive,
  resolveValuationAsOf,
  validateClosedRequest,
} from '@totalfinance/core';
import { VALIDATION_SPECS } from '../generated/validation-specs.js';
import { expiryConventionOf } from '../engine-bsm.js';
import { escrowedSpot, hasDiscreteDividends } from '../dividends.js';
import { contractTimeToExpiryYears } from '../time.js';
import type { ExtendedGreeks, Greeks, PriceResult } from '../types.js';
import { assertNoArbitrageBounds } from './bounds.js';
import { finiteDifferenceExtendedGreeks, resolveFdSteps } from './fd-greeks.js';
import type { ScalarAmericanPricer, ScalarAmericanPricingInput } from './scalar-pricing.js';
import type { OptionStyle } from '@totalfinance/core';

export type { ScalarAmericanPricer, ScalarAmericanPricingInput } from './scalar-pricing.js';

/** First-order spot Greeks an engine reads off its own discretization (raw units). */
export interface NativeSpotGreeks {
  delta: number;
  gamma: number;
  /** ∂V/∂t per YEAR (calendar decay, so negative for a long option). */
  thetaPerYear: number;
}

/** What an engine reports about the base-state solve it just ran. */
export interface EngineSolution {
  value: number;
  /** Whether the discretization/iteration actually resolved the contract (never hardcoded). */
  converged: boolean;
  /** Solve-time warnings (e.g. an inadequate grid), echoed on the result. */
  warnings?: QuantWarning[];
  /** Delta/gamma/theta from the engine's own nodes, when it has them. */
  spotGreeks?: NativeSpotGreeks;
  /** Iteration count for an iterative closed form. */
  iterations?: number;
}

export interface AmericanEngineConfig {
  name: string;
  /** Diagnostic method label (e.g. `binomial-crr`, `crank-nicolson`, `barone-adesi-whaley`). */
  method: string;
  styles: OptionStyle[];
  /** Price at a (possibly bumped) state — the vega/rho/extended bumps go through this. */
  pricer: ScalarAmericanPricer;
  /**
   * Full solve at the BASE state: value + convergence + (optionally) native spot Greeks. Defaults to
   * `pricer` with `converged: true`, which is honest only for an exact closed form.
   */
  solve?: (input: ScalarAmericanPricingInput) => EngineSolution;
  /**
   * Smallest rate bump whose repricing is meaningful for this engine, given its own discretization.
   *
   * A lattice whose NODE SPOTS carry the drift (Jarrow–Rudd, Tian: `u = e^{(r−q−σ²/2)Δt ± σ√Δt}`)
   * moves its entire grid when the rate is bumped, so a bump too small to shift the terminal nodes by
   * a full node spacing differences the same sawtooth the spot Greeks avoid — 1.6% rho error at the
   * default 1e-4 bump, 0.03% once the bump clears the spacing. CRR/trinomial/Crank–Nicolson leave
   * this unset: their nodes are rate-independent, and only the probabilities (smooth) move.
   */
  rateStepFloor?: (state: { volatility: number; timeToExpiryYears: number }) => number;
  /**
   * Whether this engine can honestly produce the extended (higher-order) Greek set (default `true`).
   * `false` for the spot-anchored lattice/PDE engines: the higher-order spot-curvature Greeks
   * (speed above all) would have to difference the same sawtooth their first-order Greeks avoid, and
   * a disclosed refusal beats a fabricated number.
   */
  extendedGreeks?: boolean;
  /** Config-time warnings echoed on every result (e.g. a rounded step count). */
  warnings?: QuantWarning[];
}

/** Single source of truth for the engine version string (WS2.14; re-used by engines.ts). */
export const ENGINE_VERSION = '0.0.1';

/**
 * Generated closed-request spec for the ONE interface method every engine implements (spec 3B.1b,
 * key `OptionPricingEngine#supports#0`). Resolved at module load so a stale key fails at import.
 * Lives here — not in engines.ts — so `makeAmericanEngine` and the engines.ts factories share it
 * without a runtime import cycle.
 */
const ENGINE_SUPPORTS_SPEC = (() => {
  const spec = VALIDATION_SPECS['OptionPricingEngine#supports#0'];
  if (spec === undefined) {
    throw new Error(
      "engines: no generated validation spec for 'OptionPricingEngine#supports#0' — run `pnpm validation:update`",
    );
  }
  return spec;
})();

const ENGINE_SUPPORTS_EXAMPLE = (): string =>
  "engine.supports(option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' }))";

/**
 * The shared `supports(contract)` head: every built-in engine validates the closed
 * {@link OptionContract} before reading `style`, so a partial or misspelled contract teaches at the
 * capability probe instead of answering `false` (or `true`) about a contract that does not exist.
 * `option.price` routes every call through `supports()`, which makes this the chokepoint.
 */
export function requireSupportsContract(contract: OptionContract): void {
  validateClosedRequest('engine.supports', contract, ENGINE_SUPPORTS_SPEC, {
    argumentName: 'contract',
    exampleCall: ENGINE_SUPPORTS_EXAMPLE,
  });
}

function assumptions(input: {
  name: string;
  timeToExpiryYears: number;
  dividendYield: number;
  asOf: EpochMs;
  escrowed: boolean;
  expiry: string;
}): Assumptions {
  const { name, timeToExpiryYears: t, dividendYield: q, asOf, escrowed, expiry } = input;
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf,
    timeToExpiryYears: t,
    expiryConvention: expiryConventionOf(expiry),
    dividendModel: escrowed ? 'discreteSchedule' : q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: name,
    engine: name,
  };
}

export function makeAmericanEngine(config: AmericanEngineConfig) {
  return {
    name: config.name,
    version: ENGINE_VERSION,
    capabilities: {
      styles: config.styles,
      dividends: ['none', 'continuous', 'discrete'],
      greeks: 'finite-difference',
      extendedGreeks: config.extendedGreeks ?? true,
      deterministic: true,
    } satisfies EngineCapabilities as EngineCapabilities,
    supports: (contract: OptionContract): boolean => {
      requireSupportsContract(contract);
      return config.styles.includes(contract.style);
    },
    price: ({ contract, market, options }: OptionEnginePriceInput): PriceResult => {
      const functionName = `option.price(${config.name})`;
      if (!config.styles.includes(contract.style)) {
        throw new UnsupportedError(`${config.name} does not support style "${contract.style}".`, {
          code: ErrorCode.EngineUnsupportedContract,
          context: { engine: config.name, style: contract.style },
        });
      }
      if (typeof market.spot !== 'number') {
        throw new InputError(`${functionName}: market.spot is required.`, {
          code: ErrorCode.InputMissingField,
          context: { field: 'spot' },
        });
      }
      if (typeof market.volatility !== 'number') {
        throw new InputError(`${functionName}: market.volatility (a number) is required.`, {
          code: ErrorCode.InputMissingField,
          context: { field: 'volatility' },
        });
      }
      if (typeof market.riskFreeRate !== 'number') {
        throw new InputError(`${functionName}: market.riskFreeRate (a number) is required.`, {
          code: ErrorCode.InputMissingField,
          context: { field: 'riskFreeRate' },
        });
      }
      ensurePositive(market.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
      ensurePositive(
        market.volatility,
        'volatility',
        functionName,
        ErrorCode.InputNegativeVolatility,
      );
      ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
      ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
      const q = market.dividendYield ?? 0;
      ensureFinite(q, 'dividendYield', functionName);
      const asOfMs = resolveValuationAsOf(market.asOf, functionName);
      ensureFinite(asOfMs, 'asOf', functionName);
      const T = contractTimeToExpiryYears(asOfMs, contract, functionName);
      if (T <= 0) {
        throw new UnsupportedError(
          `${functionName}: contract expiry ${contract.expiry} is not after asOf.`,
          {
            code: ErrorCode.InputNegativeTime,
            context: { asOf: market.asOf, expiry: contract.expiry },
          },
        );
      }

      const escrowed = hasDiscreteDividends(market);
      const sigma = market.volatility;
      const r = market.riskFreeRate;
      const K = contract.strike;
      const type = contract.type;
      const style = contract.style;

      const price = ({
        spot,
        volatility,
        timeToExpiryYears,
        riskFreeRate,
        dividendYield,
      }: {
        spot: number;
        volatility: number;
        timeToExpiryYears: number;
        riskFreeRate: number;
        dividendYield: number;
      }): number =>
        config.pricer({
          type,
          style,
          spot,
          strike: K,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield,
          volatility,
        });

      // The escrowed spot depends on BOTH the rate and time-to-expiry (PV of dividends before expiry),
      // so rho/theta must re-escrow at the bumped r/T; holding a fixed S there biases the
      // discrete-dividend Greeks. With no discrete dividends `spotAt` returns market.spot unchanged, so
      // this is a no-op for the continuous-yield / no-dividend path.
      const spotAt = ({
        riskFreeRate,
        timeToExpiryYears,
      }: {
        riskFreeRate: number;
        timeToExpiryYears: number;
      }): number =>
        escrowedSpot({
          spot: market.spot,
          market,
          asOf: asOfMs,
          timeToExpiryYears,
          riskFreeRate,
          functionName,
        });
      const S = spotAt({ riskFreeRate: r, timeToExpiryYears: T });
      const solved: EngineSolution = config.solve
        ? config.solve({
            type,
            style,
            spot: S,
            strike: K,
            timeToExpiryYears: T,
            riskFreeRate: r,
            dividendYield: q,
            volatility: sigma,
          })
        : {
            value: price({
              spot: S,
              volatility: sigma,
              timeToExpiryYears: T,
              riskFreeRate: r,
              dividendYield: q,
            }),
            converged: true,
          };
      const value = solved.value;
      const native = solved.spotGreeks;

      // Honor `greeks: false` (default true for the FD engines) — absent Greeks mean "not requested",
      // never fabricated zeros, matching the analytic/stochastic engines' contract. `extendedGreeks`
      // implies `greeks`; on an engine that cannot honestly produce the higher-order set the request
      // is DISCLOSED (`greeks.unsupported_by_engine`) and the first-order Greeks are still returned.
      const supportsExtended = config.extendedGreeks ?? true;
      const extendedRequested = options?.extendedGreeks ?? false;
      const wantExtended = extendedRequested && supportsExtended;
      const wantGreeks = extendedRequested || (options?.greeks ?? true);
      // Resolve the FD bumps ONCE (adaptive near the vol/time boundaries, spec P2.3) so the same
      // sizes are used for differencing AND disclosed in diagnostics.finiteDifferenceBumps below.
      const fdState = { spot: S, T, r, q, sigma };
      // A rate bump below the engine's own grid resolution differences its discretization, not the
      // price (see `rateStepFloor`); the floor is disclosed like every other actually-used step.
      const rateFloor = config.rateStepFloor?.({ volatility: sigma, timeToExpiryYears: T }) ?? 0;
      const rateStepOverride = rateFloor > 1e-4 ? { rateStep: rateFloor } : {};
      const fd = wantGreeks
        ? resolveFdSteps(fdState, {
            ...(wantExtended ? {} : { timeStepYears: Math.min(1e-4, T / 4) }),
            ...rateStepOverride,
          })
        : undefined;
      let greeks: Greeks | ExtendedGreeks | undefined;
      if (wantExtended) {
        greeks = finiteDifferenceExtendedGreeks({ price, spotAt, state: fdState, steps: fd! });
      } else if (wantGreeks) {
        // Finite-difference Greeks (default units: theta/day, vega/1%, rho/1%). Spot Greeks come
        // from the engine's own discretization when it exposes them (see the module docstring);
        // only σ/r — coordinates the price is smooth in — are bump-and-repriced.
        const { spotStep, volatilityStep, timeStepYears, rateStep } = fd!;
        const pUp = native
          ? 0
          : price({
              spot: S + spotStep,
              volatility: sigma,
              timeToExpiryYears: T,
              riskFreeRate: r,
              dividendYield: q,
            });
        const pDn = native
          ? 0
          : price({
              spot: S - spotStep,
              volatility: sigma,
              timeToExpiryYears: T,
              riskFreeRate: r,
              dividendYield: q,
            });
        const delta = native ? native.delta : (pUp - pDn) / (2 * spotStep);
        const gamma = native ? native.gamma : (pUp - 2 * value + pDn) / (spotStep * spotStep);
        const vega =
          (price({
            spot: S,
            volatility: sigma + volatilityStep,
            timeToExpiryYears: T,
            riskFreeRate: r,
            dividendYield: q,
          }) -
            price({
              spot: S,
              volatility: sigma - volatilityStep,
              timeToExpiryYears: T,
              riskFreeRate: r,
              dividendYield: q,
            })) /
          (2 * volatilityStep) /
          100;
        // Re-escrow at the bumped time / rate so the dividend PV moves with the bump. A native theta
        // is already ∂V/∂t per year on the engine's own time grid — no maturity bump involved.
        const theta = native
          ? native.thetaPerYear / 365
          : -(
              price({
                spot: spotAt({ riskFreeRate: r, timeToExpiryYears: T + timeStepYears }),
                volatility: sigma,
                timeToExpiryYears: T + timeStepYears,
                riskFreeRate: r,
                dividendYield: q,
              }) -
              price({
                spot: spotAt({ riskFreeRate: r, timeToExpiryYears: T - timeStepYears }),
                volatility: sigma,
                timeToExpiryYears: T - timeStepYears,
                riskFreeRate: r,
                dividendYield: q,
              })
            ) /
            (2 * timeStepYears) /
            365;
        const rho =
          (price({
            spot: spotAt({ riskFreeRate: r + rateStep, timeToExpiryYears: T }),
            volatility: sigma,
            timeToExpiryYears: T,
            riskFreeRate: r + rateStep,
            dividendYield: q,
          }) -
            price({
              spot: spotAt({ riskFreeRate: r - rateStep, timeToExpiryYears: T }),
              volatility: sigma,
              timeToExpiryYears: T,
              riskFreeRate: r - rateStep,
              dividendYield: q,
            })) /
          (2 * rateStep) /
          100;
        greeks = { delta, gamma, theta, vega, rho };
      }

      // No `timingMs` here: this is a pure compute package and must not read the system clock
      // (README design law). Wall-clock timing is the caller's concern — `compareEngines` measures it
      // via an injected clock, and the MCP/bench wrappers can do the same.
      const warnings: QuantWarning[] = config.warnings
        ? config.warnings.map((w) => ({ ...w }))
        : [];
      for (const w of solved.warnings ?? []) warnings.push({ ...w });
      if (!wantGreeks) {
        warnings.push({
          code: WarningCode.GreeksNotComputed,
          message: 'Greeks were not computed (greeks: false).',
          severity: 'info',
        });
      }
      if (extendedRequested && !supportsExtended) {
        warnings.push({
          code: WarningCode.GreeksUnsupportedByEngine,
          message:
            `${config.name} cannot compute the extended (higher-order) Greek set — the request was not honored; ` +
            "the first-order Greeks above come from the engine's own grid. Its higher-order SPOT-curvature " +
            'Greeks (speed, and any second difference of delta/gamma in the spot) would have to be ' +
            'bump-and-repriced at a step finer than the node spacing, which measures the lattice/grid ' +
            "sawtooth rather than the value function. Use engines.binomial({ variant: 'leisen-reimer' }) " +
            '(strike-anchored, smooth in the spot), a closed-form American approximation ' +
            '(engines.bjerksundStensland2002()), or engines.blackScholesMerton() for a European contract.',
          severity: 'warn',
        });
      }
      if (wantExtended && (greeks as ExtendedGreeks).lambda === null) {
        warnings.push({
          code: WarningCode.LambdaUndefined,
          message:
            'lambda (elasticity Δ·S/V) is undefined — the option price underflowed to zero; reported as null, never NaN/Infinity.',
          severity: 'info',
        });
      }
      // Bumps are disclosed only for coordinates actually differenced: with native spot Greeks the
      // spot/time bumps are never taken, and echoing them would describe a computation that did not
      // happen (P2.3 is about the ACTUAL steps).
      const disclosedBumps =
        fd === undefined
          ? undefined
          : wantExtended
            ? {
                spotStep: fd.spotStep,
                volatilityStep: fd.volatilityStep,
                timeStepYears: fd.timeStepYears,
                rateStep: fd.rateStep,
                dividendYieldStep: fd.dividendYieldStep,
              }
            : native
              ? { volatilityStep: fd.volatilityStep, rateStep: fd.rateStep }
              : {
                  spotStep: fd.spotStep,
                  volatilityStep: fd.volatilityStep,
                  timeStepYears: fd.timeStepYears,
                  rateStep: fd.rateStep,
                };
      const diagnostics: Diagnostics = {
        engine: config.name,
        method: config.method,
        // Never hardcoded: closed forms are exact, lattices are trustworthy only past the
        // branch-probability guard, and the PDE grid reports its own adequacy.
        converged: solved.converged,
        warnings,
        ...(solved.iterations !== undefined ? { iterations: solved.iterations } : {}),
        ...(disclosedBumps !== undefined ? { finiteDifferenceBumps: disclosedBumps } : {}),
      };
      // Structural postcondition: no engine may return a value outside the model-independent
      // no-arbitrage bounds (defect-fix wave, finding 5).
      assertNoArbitrageBounds({
        engine: config.name,
        type,
        style,
        value,
        underlyingPresentValue: S * Math.exp(-q * T),
        strikePresentValue: K * Math.exp(-r * T),
        spot: S,
        strike: K,
      });
      const base = {
        value,
        assumptions: assumptions({
          name: config.name,
          timeToExpiryYears: T,
          dividendYield: q,
          asOf: asOfMs,
          escrowed,
          expiry: contract.expiry,
        }),
        diagnostics,
      };
      return greeks ? { ...base, greeks } : base;
    },
  };
}
