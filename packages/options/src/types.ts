/** Public option-pricing types (spec §9). Pure types — no runtime, no bundle cost. */

import type { Computed, MarketInputs, OptionType } from '@totalfinance/core';

/**
 * First-order Greeks in TotalFinance default units:
 *   - `theta` per calendar day (ACT/365F),
 *   - `vega` per 1 volatility point (1% = 0.01),
 *   - `rho` per 1% change in the rate.
 * The applied units are always echoed in `assumptions.units`.
 */
export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

/** Flat facade input for a single Black–Scholes–Merton computation. */
export interface BlackScholesInput {
  /** Spot price of the underlying. */
  spot: number;
  /** Strike price. */
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Continuously-compounded risk-free rate (decimal, e.g. `0.045`). */
  riskFreeRate: number;
  /** Volatility (decimal, e.g. `0.22`). */
  volatility: number;
  /** Continuous dividend yield (decimal, default `0`). */
  dividendYield?: number;
}

/** Facade input where the option type is explicit (`blackScholes.price`, `blackScholes.greeks`). */
export interface BlackScholesTypedInput extends BlackScholesInput {
  type: OptionType;
}

/** Facade input for implied-volatility solving. */
export interface BlackScholesImpliedVolatilityInput {
  /** Observed option price to invert. */
  price: number;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  type: OptionType;
  dividendYield?: number;
}

/** A discrete cash dividend with an ex-date (ISO) and per-share amount. */
export interface DiscreteDividend {
  /**
   * Ex-date, `YYYY-MM-DD` or a zoned ISO datetime.
   *
   * A DATE-ONLY label resolves to the US equity market OPEN, **09:30 America/New_York** — the
   * instant the share starts trading without the dividend. This is deliberately NOT the 16:00 ET
   * convention a date-only option EXPIRY uses: they are different events. The practical consequence
   * is that an `asOf` from 09:30 ET on the ex-date onward treats the dividend as PAID (it is already
   * out of the spot) and stops discounting it into the escrowed spot, while `asOf` earlier that
   * morning, or any time the day before, still accrues it.
   *
   * Pass a zoned datetime (e.g. `'2026-06-01T09:30:00-04:00'`) to name the instant yourself.
   */
  exDate: string;
  /** Cash amount per share (must be finite and non-negative). */
  amount: number;
}

/**
 * Market inputs for the pro pricing API (spec §9.1). Extends the workspace-canonical
 * {@link MarketInputs} (spot/rate/dividendYield/asOf) and adds the option-specific fields. `spot` is
 * required (every pro engine resolves off it — forward-only pricing uses the flat `black76`/
 * `bachelier` facades). `rate`/`volatility` are scalars in this milestone; a `VolatilityLookup` variant for
 * `volatility` arrives with the surface integration.
 */
export interface OptionMarket extends MarketInputs {
  forward?: number;
  /** Discrete cash dividends (American engines use the escrowed-dividend approximation). */
  dividends?: DiscreteDividend[];
  volatility?: number;
  /** The observed premium an inversion reproduces (`option.impliedVolatility`). */
  price?: number;
}

/** Extended (higher-order) Greeks (spec §9.4). */
export interface ExtendedGreeks extends Greeks {
  vanna: number;
  charm: number;
  vomma: number;
  speed: number;
  color: number;
  /** Dividend rho (epsilon) `ε = ∂V/∂q`, per 1% dividend yield (scaled like `rho`). */
  phi: number;
  /** `∂Γ/∂σ = ∂³V/∂S²∂σ` (raw, per 1.00 σ). */
  zomma: number;
  /** `∂vega/∂T` (raw, per year of time-to-expiry; vega here is per 1.00 σ) — the ∂/∂T sibling of vega. */
  veta: number;
  /** `∂rho/∂σ = ∂²V/∂r∂σ` (raw, per 1.00 σ; rho here is per 1.00 rate). */
  vera: number;
  /** `∂vomma/∂σ = ∂³V/∂σ³` (raw). */
  ultima: number;
  /**
   * Elasticity / effective leverage `Λ = Δ·S / V` (dimensionless). `null` when the price
   * underflows to zero (deep-OTM): elasticity is undefined at V = 0 and is disclosed as null with
   * a `greeks.lambda_undefined` warning on explained paths — never NaN/Infinity (Law 7).
   */
  lambda: number | null;
}

/**
 * Result of a pro `option.price(...)` call: a value envelope plus Greeks. `greeks` is OPTIONAL — absent
 * means "not computed" (e.g. a Monte-Carlo engine priced without the extra Greek budget). Absent is never
 * the same as a genuine zero: engines never fabricate `{delta:0, …}`. It is the **first-order** `Greeks`
 * by default, or the full {@link ExtendedGreeks} when the call passes `{ extendedGreeks: true }`.
 */
export interface PriceResult extends Computed<number> {
  greeks?: Greeks | ExtendedGreeks;
}

/** Result of a pro `option.impliedVolatility(...)` call. */
export type ImpliedVolatilityResult = Computed<number>;
