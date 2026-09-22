/**
 * Dupire local-volatility surface fitting (spec §10.1). The Dupire transform `σ_loc(K, t)` is a
 * *derived* surface — the local volatility consistent with an observed implied-vol surface — not an
 * implied-vol parametrization. So it is exposed here as a derived `LocalVolatilitySurface` (with a fast
 * cached grid) built from any implied-vol function or a fitted {@link VolatilitySurface}, reusing the Dupire
 * engine in `@insiderfinance/totalfinance/options`, rather than as a `VolatilitySurface` `model` (which would mis-type `.iv()`).
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import {
  type DupireOptions,
  type LocalVolatilityFunction,
  type LocalVolatilityGridSpecification,
  type LocalVolatilityMarket,
} from '@totalfinance/options';
import { dupireLocalVolatility, localVolatilityGrid } from '@totalfinance/options/local-volatility';
import type { VolatilitySurface } from './surface.js';

export type {
  DupireOptions,
  LocalVolatilityFunction,
  LocalVolatilityGridSpecification,
  LocalVolatilityMarket,
} from '@totalfinance/options';

/** The documented {@link LocalVolatilityMarket} fields (Law 12 allowlist). */
const LOCAL_VOL_MARKET_KEYS = ['spot', 'riskFreeRate', 'dividendYield'] as const;

/** The documented {@link DupireOptions} fields (Law 12 allowlist). */
const DUPIRE_OPTIONS_KEYS = ['logMoneynessStep', 'timeStepYears', 'floorVolatility'] as const;

export interface LocalVolatilitySurface {
  /** Dupire local volatility `σ_loc(level, t)` (level = underlying price, t in years). */
  localVolatility(level: number, timeToExpiryYears: number): number;
  /**
   * A grid-cached local-volatility function over the given (level, time) knots — bilinearly interpolated and
   * far cheaper to evaluate inside a Monte-Carlo simulation than the raw finite-difference transform.
   */
  grid(specification: LocalVolatilityGridSpecification): LocalVolatilityFunction;
}

export interface LocalVolatilitySurfaceInput {
  impliedVolatility: (strike: number, timeToExpiryYears: number) => number;
  market: LocalVolatilityMarket;
  options?: DupireOptions;
}

/** Fit a Dupire local-volatility surface from an implied-vol function `σ_imp(strike, t)` and market context. */
export function localVolatilitySurface(input: LocalVolatilitySurfaceInput): LocalVolatilitySurface {
  requireArgumentObject('localVolatilitySurface', 'input', input);
  ensureKnownKeys('localVolatilitySurface', 'input', input, [
    'impliedVolatility',
    'market',
    'options',
  ]);
  const { impliedVolatility, market, options: options = {} } = input;
  if (typeof impliedVolatility !== 'function') {
    throw new InputError(
      `localVolatilitySurface: impliedVolatility must be a function (strike, t) => impliedVolatility, got ${
        impliedVolatility === null ? 'null' : typeof impliedVolatility
      }.`,
      { code: ErrorCode.InputWrongType, context: { received: typeof impliedVolatility } },
    );
  }
  requireArgumentObject('localVolatilitySurface', 'market', market);
  ensureKnownKeys('localVolatilitySurface', 'market', market, LOCAL_VOL_MARKET_KEYS);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('localVolatilitySurface', 'options', options);
  ensureKnownKeys('localVolatilitySurface', 'options', options, DUPIRE_OPTIONS_KEYS);
  const fn = dupireLocalVolatility({
    impliedVolatility,
    market,
    options,
  });
  return {
    localVolatility: fn,
    grid: (specification: LocalVolatilityGridSpecification): LocalVolatilityFunction =>
      localVolatilityGrid(fn, specification),
  };
}

export interface SurfaceLocalVolatilityInput {
  surface: VolatilitySurface;
  market: LocalVolatilityMarket;
  options?: DupireOptions;
}

/** Fit a Dupire local-volatility surface directly from a calibrated {@link VolatilitySurface}. */
export function surfaceLocalVolatility(input: SurfaceLocalVolatilityInput): LocalVolatilitySurface {
  requireArgumentObject('surfaceLocalVolatility', 'input', input);
  ensureKnownKeys('surfaceLocalVolatility', 'input', input, ['surface', 'market', 'options']);
  const { surface, market, options: options = {} } = input;
  requireArgumentObject('surfaceLocalVolatility', 'surface', surface);
  requireArgumentObject('surfaceLocalVolatility', 'market', market);
  ensureKnownKeys('surfaceLocalVolatility', 'market', market, LOCAL_VOL_MARKET_KEYS);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('surfaceLocalVolatility', 'options', options);
  ensureKnownKeys('surfaceLocalVolatility', 'options', options, DUPIRE_OPTIONS_KEYS);
  return localVolatilitySurface({
    impliedVolatility: (strike, t) => surface.impliedVolatility(strike, t),
    market,
    options,
  });
}
