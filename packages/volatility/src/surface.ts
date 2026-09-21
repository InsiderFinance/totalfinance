/**
 * Implied-volatility surface (spec §10.1).
 *
 * Builds a surface from an option chain: solves an implied vol per quote (or uses the quote's own
 * `impliedVolatility`), groups into per-expiry smiles, and offers strike×expiry lookup (plus moneyness- and
 * delta-axis accessors) with extrapolation and sparse-data diagnostics. Cross-expiry interpolation is
 * linear in total variance `w = σ²·T`, the calendar-arbitrage-friendly axis. Eight `model`s are
 * supported: non-parametric `raw` (linear), `interpolated` (shape-preserving PCHIP) and `smoothed`
 * (Gaussian-kernel); parametric `svi`/`sabr` calibrated per expiry; and three calibrated globally to the
 * whole surface — `ssvi` (the arbitrage-free Gatheral–Jacquier surface SVI), `essvi` (SSVI with a
 * per-maturity skew), and `heston` (stochastic-vol). Parametric models fall back to an interpolated smile
 * (with a diagnostic) for expiries with too few strikes, and an SVI slice that remains
 * butterfly-arbitrageable after calibration is flagged. (Dupire local-volatility *surface fitting* is
 * sequenced later — spec §10.1.)
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  type Computed,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type MarketInputs,
  type OptionQuote,
  type OptionType,
  type PriceSource,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  optionExpiryToMs,
  requireArgumentArray,
  requireArgumentObject,
  selectQuotePrice,
  wrongShapeError,
  yearFraction,
  resolveValuationAsOf,
  type ClosedRequestSpecification,
  validateClosedRequest,
} from '@totalfinance/core';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { makePchipInterpolator, normalCdf } from '@totalfinance/math';
import {
  impliedVolatility,
  type HestonParameters,
  type SabrParameters,
  type SabrVolatilityType,
} from '@totalfinance/options';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { type SVIParameters, calibrateSvi, sviVolatility } from './svi.js';
import { type SSVIParameters, calibrateSsvi, ssviVolatility } from './ssvi.js';
import { type ESSVIParameters, calibrateEssvi, essviVolatility } from './essvi.js';
import { calibrateSabrSmile } from './sabr.js';
import { calibrateHestonSurface } from './heston-surface.js';
import {
  type ArbitrageCheckOptions,
  type ArbitrageReport,
  surfaceArbitrageReport,
} from './arbitrage.js';

/**
 * `raw`/`interpolated`/`smoothed` are non-parametric (linear, PCHIP, and a Gaussian-kernel smoother);
 * `svi`/`sabr` fit a parametric smile per expiry; `heston` calibrates one global stochastic-vol model
 * to the whole surface. Parametric models fall back to an interpolated smile for expiries with too few
 * strikes. (Dupire local-volatility *surface fitting* is sequenced later — spec §10.1.)
 */
export type SurfaceModel =
  | 'raw'
  | 'interpolated'
  | 'smoothed'
  | 'svi'
  | 'sabr'
  | 'ssvi'
  | 'essvi'
  | 'heston';

const SURFACE_MODELS: readonly SurfaceModel[] = [
  'raw',
  'interpolated',
  'smoothed',
  'svi',
  'sabr',
  'ssvi',
  'essvi',
  'heston',
];

/**
 * Market snapshot for `volatilitySurface()` — the workspace-canonical {@link MarketInputs}, except `spot` is
 * optional (it falls back to each quote's `underlyingPrice` when omitted) (WS3.2).
 */
export type SurfaceMarket = Omit<MarketInputs, 'spot'> & {
  /** Spot price. Falls back to each quote's `underlyingPrice` when omitted. */
  spot?: number;
};

/** The documented {@link SurfaceMarket} fields (the {@link MarketInputs} keys, `spot` optional). */
export const SURFACE_MARKET_KEYS = ['spot', 'riskFreeRate', 'dividendYield', 'asOf'] as const;

/** Non-market surface configuration: price source, model, and per-model calibration knobs (WS3.2). */
export interface SurfaceConfig {
  /** Which quote price to invert when a quote has no `impliedVolatility` (default `mid`). */
  priceSource?: PriceSource;
  /**
   * `interpolated` (PCHIP, default), `raw` (linear), `smoothed` (Gaussian kernel), `svi`/`sabr`
   * (parametric per expiry), `ssvi` (one global arbitrage-free surface SVI), `essvi` (SSVI with a
   * per-maturity skew), or `heston` (one global stochastic-vol model fit to the whole surface).
   */
  model?: SurfaceModel;
  /** Below this many usable strikes, an expiry slice is flagged sparse (default 3). */
  minQuotesPerExpiry?: number;
  /** SABR backbone exponent β ∈ [0, 1] for `model: 'sabr'` (default 0.5). */
  sabrBeta?: number;
  /** SABR Hagan expansion for `model: 'sabr'` (default `'lognormal'`). */
  sabrVolatilityType?: SabrVolatilityType;
  /** Gaussian-kernel bandwidth (in log-moneyness) for `model: 'smoothed'` (default auto). */
  smoothingBandwidth?: number;
  /** Warm start (partial pin) for the global `model: 'heston'` calibration — threads into `calibrateHestonSurface`'s `initialParameters`. */
  hestonInitialParameters?: Partial<HestonParameters>;
  /** COS cosine-term count for the `model: 'heston'` calibration & evaluation (default 128). */
  cosineExpansionTerms?: number;
  /** Curvature family for the global `model: 'ssvi'` calibration (default `'power-law'`). */
  ssviPhi?: 'power-law' | 'heston';
  /** Least-squares weighting for `model: 'ssvi'`: `'uniform'` (default) or `'vega'` (ATM-dominant). */
  ssviWeight?: 'uniform' | 'vega';
  /** Curvature family for the global `model: 'essvi'` calibration (default `'power-law'`). */
  essviPhi?: 'power-law' | 'heston';
  /** Least-squares weighting for `model: 'essvi'`: `'uniform'` (default) or `'vega'` (ATM-dominant). */
  essviWeight?: 'uniform' | 'vega';
}

/** The documented {@link SurfaceConfig} fields (Law 12 allowlist). */
const SURFACE_CONFIG_KEYS = [
  'priceSource',
  'model',
  'minQuotesPerExpiry',
  'sabrBeta',
  'sabrVolatilityType',
  'smoothingBandwidth',
  'hestonInitialParameters',
  'cosineExpansionTerms',
  'ssviPhi',
  'ssviWeight',
  'essviPhi',
  'essviWeight',
] as const;

/** Internal merged view of the two public inputs, used by the constructor body and smile builder. */
type VolatilitySurfaceOptions = SurfaceMarket & SurfaceConfig;

/** One per-expiry smile, strikes ascending. */
export interface SurfaceSlice {
  expiry: string;
  /** Time to expiry in years (ACT/365F). */
  timeToExpiryYears: number;
  /** Forward `S·e^{(r−q)t}`. */
  forward: number;
  strikes: number[];
  impliedVolatilities: number[];
  /** Call-delta `e^{−qt}·N(d1)` at each strike (the smile's delta axis, for skew lookups). */
  deltas: number[];
  /** Fitted raw-SVI parameters when `model: 'svi'` (absent if the slice fell back to interpolation). */
  svi?: SVIParameters;
  /** Fitted SABR parameters when `model: 'sabr'` (absent if the slice fell back to interpolation). */
  sabr?: SabrParameters;
  /** The globally-calibrated SSVI parameters when `model: 'ssvi'` (shared across all slices). */
  ssvi?: SSVIParameters;
  /** The globally-calibrated eSSVI parameters when `model: 'essvi'` (shared across all slices). */
  essvi?: ESSVIParameters;
  /** The globally-calibrated Heston parameters when `model: 'heston'` (shared across all slices). */
  heston?: HestonParameters;
}

/** A raw solved surface point before smoothing. */
export interface SurfacePoint {
  expiry: string;
  strike: number;
  type: OptionType;
  timeToExpiryYears: number;
  impliedVolatility: number;
}

/** Result of a surface lookup: the IV plus whether the query was extrapolated. */
export interface SurfaceLookup extends Computed<number> {
  extrapolated: boolean;
}

/** Schema version stamped onto every {@link VolatilitySurface#toJSON} snapshot; checked on restore (WS4.4). */
export const SURFACE_SCHEMA_VERSION = '1';

/** A vol-structure shock echoed in a shocked surface's {@link VolatilitySurface.assumptions} (WS4.4). */
export interface SurfaceShock {
  /** Additive parallel shift applied to every stored IV (in vol points, e.g. `0.02` = +2 vol). */
  parallel: number;
  /** Skew rotation: adds `skewTilt · k` where `k = ln(K/forward)` (log-moneyness). */
  skewTilt: number;
  /** Which quantity the tilt is pinned to: `'strike'` (default) or `'moneyness'`. */
  sticky: 'strike' | 'moneyness';
}

/**
 * One chart-facing row from {@link VolatilitySurface#toRows} — the smile-chart / heatmap feed. Per the
 * workspace missing-value policy (WS2.12), every chart-facing numeric is `number | null`: a non-finite
 * stored value becomes `null`, never `NaN` and never omitted.
 */
export interface SurfaceRow {
  expiry: string;
  strike: number;
  /** `ln(strike/forward)`, or `null` if non-finite. */
  logMoneyness: number | null;
  /** Stored call-delta at the strike, or `null` if the stored value is non-finite. */
  delta: number | null;
  /** Stored implied vol at the strike, or `null` if the stored value is non-finite. */
  impliedVolatility: number | null;
}

/**
 * A serialized surface (spec WS4.4). Carries the model, per-slice smile state (including any fitted
 * `svi`/`sabr`/`heston` parameters), points, assumptions/diagnostics, the global Heston parameters, `spotRef`,
 * and the config knobs needed to REBUILD interpolators. Closures are never serialized —
 * {@link VolatilitySurface.fromJSON} rebuilds them from this state so the restored surface answers `iv()`
 * identically.
 */
export interface VolatilitySurfaceSnapshot {
  schemaVersion: string;
  model: SurfaceModel;
  slices: SurfaceSlice[];
  points: SurfacePoint[];
  assumptions: Assumptions<{ shock?: SurfaceShock }>;
  diagnostics: Diagnostics;
  /** The global SSVI parameters when `model: 'ssvi'`. */
  ssvi?: SSVIParameters;
  /** The global eSSVI parameters when `model: 'essvi'`. */
  essvi?: ESSVIParameters;
  /** The global Heston parameters when `model: 'heston'`. */
  heston?: HestonParameters;
  referenceSpot: number;
  /** Config knobs needed to rebuild the per-slice interpolators without re-solving from quotes. */
  config: {
    riskFreeRate: number;
    dividendYield: number;
    sabrBeta: number;
    sabrVolatilityType: SabrVolatilityType;
    smoothingBandwidth?: number;
    cosineExpansionTerms: number;
  };
}

function expiryToYears(asOf: EpochMs, expiry: string): number {
  // A bare `YYYY-MM-DD` resolves to 16:00 ET (US options close), not UTC midnight, so a same-day 0DTE
  // chain quoted intraday still carries positive time-to-expiry instead of being dropped as expired.
  // Matches the core/options/structure convention (spec §1 expiry handling).
  const ms = optionExpiryToMs(expiry);
  return yearFraction(asOf, ms, 'ACT/365F');
}

function callDelta(input: {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): number {
  const {
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return Math.exp(-q * T) * normalCdf(d1);
}

function fitWarning(model: 'svi' | 'sabr', expiry: string, rmse: number): QuantWarning {
  return {
    code: WarningCode.VolatilityFitUnconverged,
    message: `${model.toUpperCase()} fit for ${expiry} did not fully converge (rmse=${rmse.toExponential(
      2,
    )}).`,
    severity: 'warn',
    context: { expiry, model, rmse },
  };
}

function insufficientWarning(
  model: 'svi' | 'sabr',
  need: number,
  expiry: string,
  have: number,
): QuantWarning {
  return {
    code: WarningCode.VolatilityFitInsufficientData,
    message: `Expiry ${expiry} has ${have} strike(s) (<${need} needed for ${model.toUpperCase()}); falling back to an interpolated smile.`,
    severity: 'warn',
    context: { expiry, model, need, have },
  };
}

interface RawPoint {
  strike: number;
  type: OptionType;
  impliedVolatility: number;
}

/** The knobs {@link buildSmile} needs to reconstruct a slice's smile closure without re-fitting. */
interface SmileConfig {
  model: SurfaceModel;
  riskFreeRate: number;
  dividendYield: number;
  sabrVolatilityType: SabrVolatilityType;
  smoothingBandwidth?: number;
  cosineExpansionTerms: number;
}

/** The diagnostics `method` label for a model (single source shared by the constructor and `shock`). */
function methodFor(model: SurfaceModel, sabrBeta: number): string {
  return model === 'svi'
    ? 'svi+total-variance'
    : model === 'sabr'
      ? `sabr(β=${sabrBeta})+total-variance`
      : model === 'ssvi'
        ? 'ssvi-global+total-variance'
        : model === 'essvi'
          ? 'essvi-global+total-variance'
          : model === 'heston'
            ? 'heston-cos+total-variance'
            : model === 'smoothed'
              ? 'gaussian-kernel+total-variance'
              : model === 'interpolated'
                ? 'pchip+total-variance'
                : 'linear+total-variance';
}

/** Deep-copy SSVI parameters (the `phi` object and the `θ` term-structure array must not be aliased). */
function cloneSSVI(p: SSVIParameters): SSVIParameters {
  return { ...p, phi: { ...p.phi }, thetaTerm: p.thetaTerm.map((x) => ({ ...x })) };
}

/** Deep-copy eSSVI parameters (the `phi` object and the `(t, θ, ρ)` term-structure array must not be aliased). */
function cloneESSVI(p: ESSVIParameters): ESSVIParameters {
  return { ...p, phi: { ...p.phi }, thetaTerm: p.thetaTerm.map((x) => ({ ...x })) };
}

/**
 * Build a slice's strike→IV closure from ALREADY-fitted state — this NEVER re-fits. Parametric slices
 * read their stored `svi`/`sabr`/`heston` parameters; non-parametric slices interpolate the stored `impliedVolatilities`
 * (PCHIP, or linear for `raw`/too-few-points, with flat extrapolation; a Gaussian kernel for
 * `smoothed`). It is the single source of truth for the smile shape, called by the constructor (after
 * fitting), by {@link VolatilitySurface.fromJSON} (from a snapshot), and by {@link VolatilitySurface#shock} (from
 * shifted samples) — so a live, restored, or shocked surface all answer `iv()` byte-identically.
 */
function buildSmile(
  slice: SurfaceSlice,
  cfg: SmileConfig,
  referenceSpot: number,
): (x: number) => number {
  if (slice.strikes.length === 1) {
    const v = slice.impliedVolatilities[0]!;
    return () => v;
  }

  if (cfg.model === 'svi' && slice.svi !== undefined) {
    const p = slice.svi;
    return (K: number) => sviVolatility(p, Math.log(K / slice.forward), slice.timeToExpiryYears);
  }
  if (cfg.model === 'sabr' && slice.sabr !== undefined) {
    const p = slice.sabr;
    const vt = cfg.sabrVolatilityType;
    return (K: number) =>
      sabrVolatility({
        input: { forward: slice.forward, strike: K, timeToExpiryYears: slice.timeToExpiryYears },
        parameters: p,
        options: { volatilityType: vt },
      });
  }
  if (cfg.model === 'ssvi' && slice.ssvi !== undefined) {
    // The whole surface shares one globally-calibrated SSVI param set (mirrored onto each slice); the smile
    // is its `ssviVolatility` at `t`, evaluated in log-moneyness (θ(t) interpolation ⇒ arbitrage-free in time).
    const p = slice.ssvi;
    return (K: number) => ssviVolatility(p, Math.log(K / slice.forward), slice.timeToExpiryYears);
  }
  if (cfg.model === 'essvi' && slice.essvi !== undefined) {
    // Like SSVI, one globally-calibrated eSSVI param set (mirrored onto each slice), but with a per-maturity
    // skew ρ(θ); the smile is its `essviVolatility` at `t`, evaluated in log-moneyness.
    const p = slice.essvi;
    return (K: number) => essviVolatility(p, Math.log(K / slice.forward), slice.timeToExpiryYears);
  }
  if (cfg.model === 'heston') {
    // The whole surface shares one calibrated parameter set (mirrored onto each slice); the smile is
    // its COS-priced IV at `t`. A failed inversion yields NaN, which the lookup surfaces (never faked).
    const parameters = slice.heston!;
    const terms = cfg.cosineExpansionTerms;
    const r = cfg.riskFreeRate;
    const q = cfg.dividendYield;
    const S = referenceSpot;
    const t = slice.timeToExpiryYears;
    return (K: number) =>
      hestonImpliedVolatility({
        type: 'call',
        input: { spot: S, strike: K, timeToExpiryYears: t, riskFreeRate: r, dividendYield: q },
        parameters,
        options: {
          terms,
          greeks: false,
        },
      }).value;
  }
  if (cfg.model === 'smoothed') {
    // Nadaraya–Watson Gaussian-kernel smoother in log-moneyness: a denoised, smooth smile.
    const ks = slice.strikes.map((K) => Math.log(K / slice.forward));
    const ys = slice.impliedVolatilities.slice();
    const range = ks[ks.length - 1]! - ks[0]!;
    const h = cfg.smoothingBandwidth ?? Math.max(0.03, (range / Math.max(1, ks.length - 1)) * 1.5);
    return (K: number) => {
      const k = Math.log(K / slice.forward);
      let num = 0;
      let den = 0;
      for (let i = 0; i < ks.length; i++) {
        const wt = Math.exp(-0.5 * ((k - ks[i]!) / h) ** 2);
        num += wt * ys[i]!;
        den += wt;
      }
      return den > 0 ? num / den : ys[0]!;
    };
  }

  // Non-parametric smile (the explicit choice, or a parametric fall-back): PCHIP unless `raw` /
  // too few points, then linear with flat extrapolation outside the strike range.
  if (cfg.model !== 'raw' && slice.strikes.length >= 3) {
    return makePchipInterpolator(slice.strikes, slice.impliedVolatilities);
  }
  const xs = slice.strikes;
  const ys = slice.impliedVolatilities;
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
    let hi = 1;
    while (hi < xs.length && xs[hi]! < x) hi++;
    const lo = hi - 1;
    const w = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
    return ys[lo]! + w * (ys[hi]! - ys[lo]!);
  };
}

/**
 * Deep-copy a slice so a serialized snapshot (or a surface rebuilt from one) never aliases the other's
 * mutable state: the `strikes`/`impliedVolatilities`/`deltas` arrays AND the fitted `svi`/`sabr`/`heston` parameters are
 * copied, not shared. A shallow `{ ...s }` would leave those arrays live-linked — mutating a
 * snapshot's `impliedVolatilities` would then silently change the surface's own `iv()` answers.
 */
function cloneSlice(s: SurfaceSlice): SurfaceSlice {
  return {
    ...s,
    strikes: s.strikes.slice(),
    impliedVolatilities: s.impliedVolatilities.slice(),
    deltas: s.deltas.slice(),
    ...(s.svi ? { svi: { ...s.svi } } : {}),
    ...(s.sabr ? { sabr: { ...s.sabr } } : {}),
    ...(s.ssvi ? { ssvi: cloneSSVI(s.ssvi) } : {}),
    ...(s.essvi ? { essvi: cloneESSVI(s.essvi) } : {}),
    ...(s.heston ? { heston: { ...s.heston } } : {}),
  };
}

/** Copy diagnostics with a fresh `warnings` array so a snapshot's warnings can't be pushed into the live one. */
function cloneDiagnostics(d: Diagnostics): Diagnostics {
  return { ...d, warnings: d.warnings.map((w) => ({ ...w })) };
}

/** Copy assumptions with a fresh `shock` sub-object (when present) so the snapshot is self-contained. */
function cloneSurfaceAssumptions(
  a: Assumptions<{ shock?: SurfaceShock }>,
): Assumptions<{ shock?: SurfaceShock }> {
  return { ...a, ...(a.shock ? { shock: { ...a.shock } } : {}) };
}

export interface VolatilitySurfaceInput {
  quotes: OptionQuote[];
  market: SurfaceMarket;
  config?: SurfaceConfig;
}

/** A fitted implied-volatility surface with diagnostics-bearing lookup. */
export class VolatilitySurface {
  readonly model: SurfaceModel;
  readonly slices: SurfaceSlice[];
  readonly points: SurfacePoint[];
  readonly diagnostics: Diagnostics;
  readonly assumptions: Assumptions<{ shock?: SurfaceShock }>;
  /** The global SSVI parameters when `model: 'ssvi'`, else `undefined`. */
  readonly ssvi?: SSVIParameters;
  /** The global eSSVI parameters when `model: 'essvi'`, else `undefined`. */
  readonly essvi?: ESSVIParameters;
  /** The global Heston parameters when `model: 'heston'`, else `undefined`. */
  readonly heston?: HestonParameters;
  private readonly interps: Array<(x: number) => number>;
  private readonly referenceSpot: number;
  // The config knobs needed to rebuild interpolators (for `shock` / `toJSON` / `fromJSON`), captured so
  // a shocked or restored surface reproduces the smiles without re-solving IVs from quotes.
  private readonly rate: number;
  private readonly dividendYield: number;
  private readonly sabrBeta: number;
  private readonly sabrVolatilityType: SabrVolatilityType;
  private readonly smoothingBandwidth?: number;
  private readonly cosineExpansionTerms: number;

  constructor(input: VolatilitySurfaceInput) {
    requireArgumentObject('volatilitySurface', 'input', input);
    ensureKnownKeys('volatilitySurface', 'input', input, ['quotes', 'market', 'config']);
    const { quotes, market, config = {} } = input;
    // Container + element-0 shape guard (the first-touch law): `undefined` quotes would die on the
    // for…of ("quotes is not iterable"), and a string ITERATES — 'hello' would loop character-by-
    // character into a raw destructure TypeError. Teach the OptionQuote shape instead.
    requireArgumentArray('volatilitySurface', 'quotes', quotes);
    if (quotes.length > 0) {
      const first = quotes[0] as unknown;
      const contract =
        first !== null && typeof first === 'object'
          ? (first as { contract?: unknown }).contract
          : undefined;
      if (contract === null || typeof contract !== 'object') {
        throw wrongShapeError(
          'volatilitySurface',
          'quotes[0] to be an OptionQuote: { contract: { underlying, type, style, strike, expiry }, ts, bid?/ask?/mid?/impliedVolatility?, underlyingPrice? }',
          first,
        );
      }
    }
    // A misspelled market/config field (`devidendYield`, `modle`) silently changing the fit is the
    // Law 12 bug class — reject unknown keys on both objects before they merge.
    requireArgumentObject('volatilitySurface', 'market', market);
    ensureKnownKeys('volatilitySurface', 'market', market, SURFACE_MARKET_KEYS);
    // `null` slips past the `= {}` default and would die on the first config read — reject it typed.
    requireArgumentObject('volatilitySurface', 'config', config);
    ensureKnownKeys('volatilitySurface', 'config', config, SURFACE_CONFIG_KEYS);
    const options: VolatilitySurfaceOptions = { ...market, ...config };
    ensureFinite(options.riskFreeRate, 'riskFreeRate', 'volatilitySurface');
    const asOfMs = resolveValuationAsOf(options.asOf, 'volatilitySurface');
    ensureFinite(asOfMs, 'asOf', 'volatilitySurface');
    const q = options.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', 'volatilitySurface');
    // A non-finite/non-positive global spot √-propagates NaN through every forward and IV while the
    // surface still reports converged:true — reject it up front (design law #4). `> 0` alone passes
    // Infinity, so the finiteness check is load-bearing.
    if (options.spot !== undefined && (!(options.spot > 0) || !Number.isFinite(options.spot))) {
      throw new InputError(
        `volatilitySurface: spot must be a positive finite number; got ${options.spot}.`,
        {
          code: ErrorCode.InputNegativeSpot,
          context: { spot: options.spot },
        },
      );
    }
    const r = options.riskFreeRate;
    const source: PriceSource = options.priceSource ?? 'mid';
    if (options.model !== undefined && !SURFACE_MODELS.includes(options.model)) {
      // Reject an unknown model rather than silently falling through to interpolated behaviour.
      throw new InputError(
        `volatilitySurface: model must be one of ${SURFACE_MODELS.join(', ')}; got "${options.model}".`,
        { code: ErrorCode.InputInvalidEnum, context: { model: options.model } },
      );
    }
    this.model = options.model ?? 'interpolated';
    const minPerExpiry = options.minQuotesPerExpiry ?? 3;
    const warnings: QuantWarning[] = [];

    // Group usable solved points by expiry.
    const byExpiry = new Map<string, RawPoint[]>();
    const points: SurfacePoint[] = [];
    let skipped = 0;
    let crossed = 0;

    for (const quote of quotes) {
      const S = options.spot ?? quote.underlyingPrice;
      const { strike, type, expiry } = quote.contract;
      // A CROSSED quote (bid > ask) is broken market data, not a smile: its mid is meaningless, so
      // the IV solved from it is meaningless, and a whole surface built on a crossed chain used to
      // come back with zero warnings. Policy is unchanged (the mid is still used / the quote still
      // takes its normal path) — but the surface now says out loud that it was fed crossed prices.
      if (
        typeof quote.bid === 'number' &&
        typeof quote.ask === 'number' &&
        Number.isFinite(quote.bid) &&
        Number.isFinite(quote.ask) &&
        quote.bid > quote.ask
      ) {
        crossed++;
      }
      if (S === undefined || !(S > 0) || !Number.isFinite(S)) {
        skipped++;
        continue;
      }
      const T = expiryToYears(asOfMs, expiry);
      if (!(T > 0) || !(strike > 0)) {
        skipped++;
        continue;
      }
      let volatility: number | undefined;
      if (
        quote.impliedVolatility !== undefined &&
        quote.impliedVolatility > 0 &&
        Number.isFinite(quote.impliedVolatility)
      ) {
        volatility = quote.impliedVolatility;
      } else {
        const price = selectQuotePrice(quote, source);
        if (price !== undefined && price > 0) {
          const res = impliedVolatility({
            price,
            spot: S,
            strike,
            timeToExpiryYears: T,
            riskFreeRate: r,
            type,
            dividendYield: q,
          });
          if (res.diagnostics.converged && res.value !== null && res.value > 0)
            volatility = res.value;
        }
      }
      if (volatility === undefined) {
        skipped++;
        continue;
      }
      points.push({ expiry, strike, type, timeToExpiryYears: T, impliedVolatility: volatility });
      const arr = byExpiry.get(expiry);
      if (arr) arr.push({ strike, type, impliedVolatility: volatility });
      else byExpiry.set(expiry, [{ strike, type, impliedVolatility: volatility }]);
    }

    if (skipped > 0) {
      warnings.push({
        code: WarningCode.VolatilitySurfaceQuotesSkipped,
        message: `${skipped} quote(s) skipped (missing spot/price or IV did not solve).`,
        severity: 'info',
        context: { skipped },
      });
    }
    if (crossed > 0) {
      warnings.push({
        code: ErrorCode.DataCrossedMarket,
        message:
          `${crossed} quote(s) are CROSSED (bid > ask) — a locked/crossed or stale book. Their mids ` +
          `are not tradeable prices, so any implied vol solved from them is not a market vol; treat ` +
          `this surface as provisional until the feed is clean.`,
        severity: 'warn',
        context: { crossed, quotes: quotes.length },
      });
    }

    // Build per-expiry smiles. For each strike, prefer the out-of-the-money quote (put below the
    // forward, call above) — the standard, most liquid IV source — averaging when only one side or a
    // duplicate strike exists.
    const slices: SurfaceSlice[] = [];
    for (const [expiry, raw] of byExpiry) {
      const T = expiryToYears(asOfMs, expiry);
      // Spot-fallback mode: take the first quote of this expiry that actually CARRIES a usable
      // underlyingPrice. Taking the first quote of the expiry outright dropped the whole expiry
      // whenever its first quote happened to omit the price — silently, and dependent on the ORDER
      // the chain arrived in (the same quotes shuffled produced a different surface).
      const Sref =
        options.spot ??
        quotes.find(
          (qq) =>
            qq.contract.expiry === expiry &&
            qq.underlyingPrice !== undefined &&
            qq.underlyingPrice > 0 &&
            Number.isFinite(qq.underlyingPrice),
        )?.underlyingPrice;
      if (Sref === undefined) {
        // Reachable only if every quote of an expiry that produced points lost its price in between;
        // name the expiry rather than letting it vanish into the generic skip counter.
        warnings.push({
          code: WarningCode.VolatilitySurfaceSparse,
          message: `Expiry ${expiry} was dropped: no quote carries a usable underlyingPrice and no market.spot was supplied, so its forward cannot be resolved.`,
          severity: 'warn',
          context: { expiry, reason: 'no-reference-spot' },
        });
        continue;
      }
      const forward = Sref * Math.exp((r - q) * T);

      const byStrike = new Map<number, { otm?: number; any: number[] }>();
      for (const p of raw) {
        const isOtm =
          (p.type === 'put' && p.strike <= forward) || (p.type === 'call' && p.strike >= forward);
        const entry = byStrike.get(p.strike) ?? { any: [] };
        entry.any.push(p.impliedVolatility);
        if (isOtm)
          entry.otm =
            entry.otm === undefined ? p.impliedVolatility : (entry.otm + p.impliedVolatility) / 2;
        byStrike.set(p.strike, entry);
      }
      const strikes = [...byStrike.keys()].sort((a, b) => a - b);
      const impliedVolatilities = strikes.map((k) => {
        const e = byStrike.get(k)!;
        return e.otm ?? e.any.reduce((s, v) => s + v, 0) / e.any.length;
      });
      const deltas = strikes.map((k, i) =>
        callDelta({
          spot: Sref,
          strike: k,
          timeToExpiryYears: T,
          riskFreeRate: r,
          dividendYield: q,
          volatility: impliedVolatilities[i]!,
        }),
      );
      slices.push({ expiry, timeToExpiryYears: T, forward, strikes, impliedVolatilities, deltas });

      if (strikes.length < minPerExpiry) {
        warnings.push({
          code: WarningCode.VolatilitySurfaceSparse,
          message: `Expiry ${expiry} has only ${strikes.length} usable strike(s); the smile is sparse.`,
          severity: 'warn',
          context: { expiry, strikes: strikes.length },
        });
      }
    }
    slices.sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);

    if (slices.length === 0) {
      throw new InputError('volatilitySurface: no usable quotes produced a smile.', {
        code: ErrorCode.InputOutOfRange,
        context: { quotes: quotes.length },
      });
    }

    this.slices = slices;
    this.points = points;
    // A representative spot for delta/moneyness axes and Heston pricing (back out of the forward).
    this.referenceSpot =
      options.spot ?? slices[0]!.forward * Math.exp(-(r - q) * slices[0]!.timeToExpiryYears);
    this.rate = r;
    this.dividendYield = q;
    this.sabrBeta = options.sabrBeta ?? 0.5;
    this.sabrVolatilityType = options.sabrVolatilityType ?? 'lognormal';
    this.cosineExpansionTerms = options.cosineExpansionTerms ?? 128;
    if (options.smoothingBandwidth !== undefined)
      this.smoothingBandwidth = options.smoothingBandwidth;

    // Global Heston: one parameter set calibrated to the whole surface, before the per-slice smiles.
    if (this.model === 'heston') {
      const targets = slices.flatMap((s) =>
        s.strikes.map((K, i) => ({
          strike: K,
          timeToExpiryYears: s.timeToExpiryYears,
          impliedVolatility: s.impliedVolatilities[i]!,
          forward: s.forward,
        })),
      );
      const fit = calibrateHestonSurface({
        targets,
        market: { spot: this.referenceSpot, riskFreeRate: r, dividendYield: q },
        options: {
          ...(options.hestonInitialParameters !== undefined
            ? { initialParameters: options.hestonInitialParameters }
            : {}),
          ...(options.cosineExpansionTerms !== undefined
            ? { terms: options.cosineExpansionTerms }
            : {}),
        },
      });
      this.heston = fit.parameters;
      for (const s of slices) s.heston = fit.parameters;
      if (!fit.converged) {
        warnings.push({
          code: WarningCode.VolatilityFitUnconverged,
          message: `Global Heston calibration did not fully converge (rmse=${fit.rmse.toExponential(
            2,
          )}).`,
          severity: 'warn',
          context: { model: 'heston', rmse: fit.rmse },
        });
      }
    }

    // Global SSVI: one arbitrage-free parameter set calibrated to the whole surface (like Heston), before
    // the per-slice smiles. Cross-expiry interpolation uses SSVI's own θ(t) ⇒ calendar-arb-free in time.
    if (this.model === 'ssvi') {
      const ssviSlices = slices.map((s) => ({
        timeToExpiryYears: s.timeToExpiryYears,
        k: s.strikes.map((K) => Math.log(K / s.forward)),
        impliedVolatility: s.impliedVolatilities.slice(),
      }));
      const fit = calibrateSsvi(
        { slices: ssviSlices },
        {
          ...(options.ssviPhi !== undefined ? { phi: options.ssviPhi } : {}),
          ...(options.ssviWeight !== undefined ? { weight: options.ssviWeight } : {}),
        },
      );
      this.ssvi = fit.parameters;
      for (const s of slices) s.ssvi = fit.parameters;
      if (!fit.converged) {
        warnings.push({
          code: WarningCode.VolatilityFitUnconverged,
          message: `Global SSVI calibration did not fully converge (rmse=${fit.rmse.toExponential(
            2,
          )}).`,
          severity: 'warn',
          context: { model: 'ssvi', rmse: fit.rmse },
        });
      }
      if (!fit.arbitrage.butterflyArbitrageFree) {
        warnings.push({
          code: WarningCode.VolatilityButterflyArbitrage,
          message: `The calibrated SSVI surface is butterfly-arbitrageable (min g(k)=${fit.arbitrage.minButterflyG.toFixed(
            4,
          )} < 0); the implied density goes negative.`,
          severity: 'warn',
          context: { minButterflyG: fit.arbitrage.minButterflyG },
        });
      }
      if (!fit.arbitrage.calendarArbitrageFree) {
        warnings.push({
          code: ErrorCode.VolatilityCalendarArbitrage,
          message: `The calibrated SSVI surface has a residual calendar arbitrage across maturities.`,
          severity: 'warn',
          context: {},
        });
      }
    }

    // Global eSSVI: SSVI with a per-maturity skew ρ(θ), calibrated once to the whole surface. Because ρ
    // varies, a monotone θ no longer GUARANTEES calendar-arbitrage-freedom, so the calendar warning is a
    // genuinely reachable disclosure here (the calibration scans the (k, t) grid).
    if (this.model === 'essvi') {
      const essviSlices = slices.map((s) => ({
        timeToExpiryYears: s.timeToExpiryYears,
        k: s.strikes.map((K) => Math.log(K / s.forward)),
        impliedVolatility: s.impliedVolatilities.slice(),
      }));
      const fit = calibrateEssvi(
        { slices: essviSlices },
        {
          ...(options.essviPhi !== undefined ? { phi: options.essviPhi } : {}),
          ...(options.essviWeight !== undefined ? { weight: options.essviWeight } : {}),
        },
      );
      this.essvi = fit.parameters;
      for (const s of slices) s.essvi = fit.parameters;
      if (!fit.converged) {
        warnings.push({
          code: WarningCode.VolatilityFitUnconverged,
          message: `Global eSSVI calibration did not fully converge (rmse=${fit.rmse.toExponential(
            2,
          )}).`,
          severity: 'warn',
          context: { model: 'essvi', rmse: fit.rmse },
        });
      }
      if (!fit.arbitrage.butterflyArbitrageFree) {
        warnings.push({
          code: WarningCode.VolatilityButterflyArbitrage,
          message: `The calibrated eSSVI surface is butterfly-arbitrageable (min g(k)=${fit.arbitrage.minButterflyG.toFixed(
            4,
          )} < 0); the implied density goes negative.`,
          severity: 'warn',
          context: { minButterflyG: fit.arbitrage.minButterflyG },
        });
      }
      if (!fit.arbitrage.calendarArbitrageFree) {
        warnings.push({
          code: ErrorCode.VolatilityCalendarArbitrage,
          message: `The calibrated eSSVI surface has a residual calendar arbitrage (min Δw=${fit.arbitrage.minCalendarSlope.toFixed(
            4,
          )} < 0) — the per-maturity skew crosses in total variance.`,
          severity: 'warn',
          context: { minCalendarSlope: fit.arbitrage.minCalendarSlope },
        });
      }
    }

    this.interps = slices.map((s) => this.makeSmile(s, options, warnings));
    this.diagnostics = {
      engine: 'vol-surface',
      method: methodFor(this.model, options.sabrBeta ?? 0.5),
      // Honest convergence: a parametric fit that did not converge already pushed a
      // `volatility.fit_unconverged` warning; the surface-level flag must reflect that, not be hardcoded true.
      converged: !warnings.some((w) => w.code === 'volatility.fit_unconverged'),
      warnings,
    };
    this.assumptions = {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      asOf: asOfMs,
      model: `vol-surface:${this.model}`,
    };
  }

  /**
   * Build the per-strike smile for one slice. `svi`/`sabr` fit a parametric model (storing the fitted
   * parameters on the slice); `interpolated` is PCHIP; `raw` is linear. A parametric model with too
   * few strikes to identify it falls back to an interpolated smile with a diagnostic.
   */
  private makeSmile(
    slice: SurfaceSlice,
    options: VolatilitySurfaceOptions,
    warnings: QuantWarning[],
  ): (x: number) => number {
    const cfg = this.smileConfig(options);
    // A single-strike slice is a flat smile; never attempt a parametric fit (and emit no warning).
    if (slice.strikes.length === 1) return buildSmile(slice, cfg, this.referenceSpot);

    // Fit the parametric models here (storing parameters + emitting diagnostics on the slice); the closure
    // itself is then built by the shared `buildSmile` from those stored parameters — so a live, restored,
    // or shocked surface all rebuild the same closure and answer `iv()` identically.
    if (this.model === 'svi') {
      if (slice.strikes.length >= 5) {
        const ks = slice.strikes.map((K) => Math.log(K / slice.forward));
        const ws = slice.strikes.map(
          (_, i) => slice.impliedVolatilities[i]! ** 2 * slice.timeToExpiryYears,
        );
        // Pass the slice's maturity so calibrateSvi's fit-vs-data check is in true vol points (a fit
        // that is arbitrage-free but far from the quotes comes back `converged: false`, which the
        // surface turns into a `volatility.fit_unconverged` warning and an honest surface-level flag).
        const fit = calibrateSvi({ k: ks, w: ws }, { timeToExpiryYears: slice.timeToExpiryYears });
        slice.svi = fit.parameters;
        if (!fit.converged) warnings.push(fitWarning('svi', slice.expiry, fit.rmse));
        if (!fit.butterflyFree) {
          warnings.push({
            code: WarningCode.VolatilityButterflyArbitrage,
            message: `SVI fit for ${
              slice.expiry
            } is butterfly-arbitrageable (min g(k)=${fit.minButterflyG.toFixed(
              4,
            )} < 0); the implied density goes negative.`,
            severity: 'warn',
            context: { expiry: slice.expiry, minButterflyG: fit.minButterflyG },
          });
        }
      } else {
        warnings.push(insufficientWarning('svi', 5, slice.expiry, slice.strikes.length));
      }
    } else if (this.model === 'sabr') {
      if (slice.strikes.length >= 3) {
        const vt = options.sabrVolatilityType ?? 'lognormal';
        const fit = calibrateSabrSmile(
          {
            forward: slice.forward,
            strikes: slice.strikes,
            impliedVolatilities: slice.impliedVolatilities,
            timeToExpiryYears: slice.timeToExpiryYears,
          },
          { beta: options.sabrBeta ?? 0.5, volatilityType: vt },
        );
        slice.sabr = fit.parameters;
        if (!fit.converged) warnings.push(fitWarning('sabr', slice.expiry, fit.rmse));
      } else {
        warnings.push(insufficientWarning('sabr', 3, slice.expiry, slice.strikes.length));
      }
    }

    return buildSmile(slice, cfg, this.referenceSpot);
  }

  /** The subset of options {@link buildSmile} needs to rebuild a slice's smile without re-fitting. */
  private smileConfig(options: VolatilitySurfaceOptions): SmileConfig {
    return {
      model: this.model,
      riskFreeRate: options.riskFreeRate,
      dividendYield: options.dividendYield ?? 0,
      sabrVolatilityType: options.sabrVolatilityType ?? 'lognormal',
      cosineExpansionTerms: options.cosineExpansionTerms ?? 128,
      ...(options.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: options.smoothingBandwidth }
        : {}),
    };
  }

  /** The {@link SmileConfig} for this surface's own stored (captured) config knobs. */
  private ownSmileConfig(model: SurfaceModel = this.model): SmileConfig {
    return {
      model,
      riskFreeRate: this.rate,
      dividendYield: this.dividendYield,
      sabrVolatilityType: this.sabrVolatilityType,
      cosineExpansionTerms: this.cosineExpansionTerms,
      ...(this.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: this.smoothingBandwidth }
        : {}),
    };
  }

  /** Run the static no-arbitrage diagnostics (calendar + butterfly) over this surface. */
  arbitrage(options?: ArbitrageCheckOptions): ArbitrageReport {
    return surfaceArbitrageReport(this, options);
  }

  private slot(input: string | number): number {
    return typeof input === 'number' ? input : expiryToYears(this.assumptions.asOf!, input);
  }

  /** Sorted list of the surface's expiry labels. */
  expiries(): string[] {
    return this.slices.map((s) => s.expiry);
  }

  /** The smile at an expiry (exact label or nearest by `t`), or `undefined` if none. */
  slice(expiry: string | number): SurfaceSlice | undefined {
    if (typeof expiry === 'string') return this.slices.find((s) => s.expiry === expiry);
    let best: SurfaceSlice | undefined;
    let bestD = Infinity;
    for (const s of this.slices) {
      const d = Math.abs(s.timeToExpiryYears - expiry);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Implied vol at `(strike, expiry)`. Throws if the surface is empty (never fabricates). */
  impliedVolatility(strike: number, expiry: string | number): number {
    return this.lookup(strike, expiry).value;
  }

  /**
   * Implied vol on the moneyness axis. `moneyness` is `K/S` (spot-moneyness) by default, or `K/F`
   * (forward-moneyness) when `forward` is set — so `impliedVolatilityByMoneyness(1, e)` is the at-the-money(-forward) vol.
   *
   * For a NUMERIC `expiry` (a maturity in years) the forward is computed AT THAT MATURITY,
   * `F(t) = spot·e^{(r−q)·t}` — not borrowed from the nearest fitted slice, which anchored a
   * mid-expiry query to a neighbour's forward and shifted the ATM-forward point off by the carry
   * between them.
   */
  impliedVolatilityByMoneyness(
    moneyness: number,
    expiry: string | number,
    options: { forward?: boolean } = {},
  ): number {
    if (!(moneyness > 0)) {
      throw new InputError(
        `VolatilitySurface.impliedVolatilityByMoneyness: moneyness must be > 0, got ${moneyness}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { moneyness },
        },
      );
    }
    let ref: number;
    if (options.forward && typeof expiry === 'number') {
      // A numeric expiry is a maturity, not a label: the forward it asks about is the one at THAT t.
      // `slice(t)` returns the NEAREST slice, so the old code answered with that slice's forward —
      // e.g. a 6-month query on a 3m/1y surface got the 3m forward, an 8.8bp ATM error at r−q = 3.5%.
      if (!Number.isFinite(expiry) || expiry <= 0) {
        throw new InputError(
          `VolatilitySurface.impliedVolatilityByMoneyness: a numeric expiry is a maturity in years and must be positive and finite, got ${expiry}.`,
          { code: ErrorCode.InputNegativeTime, context: { expiry } },
        );
      }
      ref = this.referenceSpot * Math.exp((this.rate - this.dividendYield) * expiry);
    } else if (options.forward) {
      // Forward-moneyness needs the slice's forward. If the expiry label resolves no slice, refuse —
      // never silently answer the SPOT-moneyness question with spotRef instead (design law #4).
      const slice = this.slice(expiry);
      if (!slice) {
        throw new InputError(
          `VolatilitySurface.impliedVolatilityByMoneyness: forward-moneyness requested for expiry ${String(
            expiry,
          )}, but ` +
            `no slice resolves a forward there; the surface cannot answer a forward-moneyness query.`,
          { code: ErrorCode.VolatilityForwardUnavailable, context: { expiry } },
        );
      }
      ref = slice.forward;
    } else {
      ref = this.referenceSpot;
    }
    return this.impliedVolatility(moneyness * ref, expiry);
  }

  /**
   * Implied vol on the call-delta axis: interpolate the strike whose call-delta equals `callDelta`
   * (∈ (0, 1)) from the slice's stored delta ladder, then read the smile there. A 0.25 delta selects
   * the 25-delta call strike.
   */
  impliedVolatilityByDelta(callDelta: number, expiry: string | number): number {
    if (!(callDelta > 0 && callDelta < 1)) {
      throw new InputError(
        `VolatilitySurface.impliedVolatilityByDelta: callDelta must be in (0, 1), got ${callDelta}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { callDelta },
        },
      );
    }
    const s = this.slice(expiry);
    if (!s) {
      throw new InputError(
        `VolatilitySurface.impliedVolatilityByDelta: no slice for expiry ${String(expiry)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { expiry },
        },
      );
    }
    // `deltas` decrease as strike increases; find the bracketing pair and interpolate the strike.
    const d = s.deltas;
    const k = s.strikes;
    if (callDelta >= d[0]!) return this.impliedVolatility(k[0]!, expiry);
    if (callDelta <= d[d.length - 1]!) return this.impliedVolatility(k[k.length - 1]!, expiry);
    let hi = 1;
    while (hi < d.length && d[hi]! > callDelta) hi++;
    const lo = hi - 1;
    const frac = (d[lo]! - callDelta) / (d[lo]! - d[hi]!);
    const strike = k[lo]! + frac * (k[hi]! - k[lo]!);
    return this.impliedVolatility(strike, expiry);
  }

  /**
   * Implied vol at `(strike, expiry)` with diagnostics. Strike uses the per-slice smile; expiry
   * interpolates total variance linearly between the two bracketing slices. `extrapolated` is true
   * when the query lies outside the fitted strike range or expiry range.
   */
  lookup(strike: number, expiry: string | number): SurfaceLookup {
    // Reject impossible query coordinates before interpolating, so a NaN/negative query never
    // returns a value with `converged: true` (design law #4).
    if (!Number.isFinite(strike) || strike <= 0) {
      throw new InputError(
        `VolatilitySurface.lookup: strike must be a positive finite number, got ${strike}.`,
        {
          code: ErrorCode.InputNegativeStrike,
          context: { strike },
        },
      );
    }
    const T = this.slot(expiry);
    if (!Number.isFinite(T) || T <= 0) {
      throw new InputError(
        `VolatilitySurface.lookup: time-to-expiry must be positive and finite, got ${T} (from ${String(
          expiry,
        )}).`,
        { code: ErrorCode.InputNegativeTime, context: { expiry, timeToExpiryYears: T } },
      );
    }
    const warnings: QuantWarning[] = [];
    const n = this.slices.length;

    const strikeExtrapolated = (i: number): boolean => {
      const s = this.slices[i]!;
      return strike < s.strikes[0]! || strike > s.strikes[s.strikes.length - 1]!;
    };

    let value: number;
    let extrapolated = false;

    if (T <= this.slices[0]!.timeToExpiryYears) {
      value = this.interps[0]!(strike);
      extrapolated = T < this.slices[0]!.timeToExpiryYears || strikeExtrapolated(0);
    } else if (T >= this.slices[n - 1]!.timeToExpiryYears) {
      value = this.interps[n - 1]!(strike);
      extrapolated = T > this.slices[n - 1]!.timeToExpiryYears || strikeExtrapolated(n - 1);
    } else {
      let hi = 1;
      while (hi < n && this.slices[hi]!.timeToExpiryYears < T) hi++;
      const lo = hi - 1;
      const t0 = this.slices[lo]!.timeToExpiryYears;
      const t1 = this.slices[hi]!.timeToExpiryYears;
      const iv0 = this.interps[lo]!(strike);
      const iv1 = this.interps[hi]!(strike);
      // Linear interpolation in total variance w = σ²·t (calendar-arbitrage-friendly).
      const w0 = iv0 * iv0 * t0;
      const w1 = iv1 * iv1 * t1;
      const w = w0 + ((w1 - w0) * (T - t0)) / (t1 - t0);
      value = Math.sqrt(Math.max(0, w) / T);
      extrapolated = strikeExtrapolated(lo) || strikeExtrapolated(hi);
    }

    if (extrapolated) {
      warnings.push({
        code: WarningCode.SurfaceExtrapolated,
        message: `Surface lookup at strike ${strike}, t=${T.toFixed(
          4,
        )} is extrapolated beyond the fitted data.`,
        severity: 'warn',
        context: { strike, timeToExpiryYears: T },
      });
    }

    return {
      value,
      extrapolated,
      assumptions: this.assumptions,
      // Carry the surface-construction warnings (butterfly arbitrage, insufficient data, fit RMSE,
      // extrapolated slices) into every per-call diagnostic — a lookup on an arbitrageable slice must
      // not present as clean just because this particular query interpolated fine (design law #4).
      diagnostics: { ...this.diagnostics, warnings: [...this.diagnostics.warnings, ...warnings] },
    };
  }

  /**
   * Return a NEW surface with a shifted vol structure, produced WITHOUT re-fitting: each stored IV
   * sample gains a `parallel` offset plus a `skewTilt · k` skew rotation (`k = ln(K/forward)`,
   * log-moneyness), the per-slice deltas are recomputed from the shifted IVs, and only the
   * interpolators are rebuilt. The shock is echoed in the new surface's `assumptions.shock`.
   *
   * `sticky`: `'strike'` (default) pins the tilt to each stored strike's own log-moneyness vs the slice
   * forward; `'moneyness'` lets the same additive shift travel with moneyness. Because the shift is
   * applied to the stored strike-indexed IV samples, both modes coincide at the stored strikes in this
   * eager v1 — the distinction only matters once a surface is re-anchored to a new spot/forward, which
   * this method does not do; the requested mode is recorded in `assumptions.shock.sticky` so a caller
   * that later re-anchors knows how the tilt was meant to travel.
   *
   * Parametric models (`svi`/`sabr`/`heston`) have no closed-form shock, so the current smile is SAMPLED
   * at each slice's stored strikes, those samples are shifted, and the result DEGRADES to
   * `'interpolated'` with a `volatility.shock_degraded_to_interpolated` `warn` — the parametric fit is not
   * re-fit. Non-parametric models (`raw`/`interpolated`/`smoothed`) are preserved.
   */
  shock(
    shifts: { parallel?: number; skewTilt?: number },
    { sticky = 'strike' }: { sticky?: 'strike' | 'moneyness' } = {},
  ): VolatilitySurface {
    const parallel = shifts.parallel ?? 0;
    const skewTilt = shifts.skewTilt ?? 0;
    const parametric =
      this.model === 'svi' ||
      this.model === 'sabr' ||
      this.model === 'ssvi' ||
      this.model === 'essvi' ||
      this.model === 'heston';
    const newModel: SurfaceModel = parametric ? 'interpolated' : this.model;
    const SHOCK_VOL_FLOOR = 1e-6;
    let shockFloored = false;

    const newSlices: SurfaceSlice[] = this.slices.map((s, si) => {
      const interp = this.interps[si]!;
      // Parametric: sample the fitted smile at the stored strikes; non-parametric: shift stored IVs.
      const impliedVolatilities = s.strikes.map((K, i) => {
        const base = parametric ? interp(K) : s.impliedVolatilities[i]!;
        const k = Math.log(K / s.forward);
        const shocked = base + parallel + skewTilt * k;
        // A large negative shift must not produce a non-positive/NaN vol silently — floor + flag it.
        if (!(shocked >= SHOCK_VOL_FLOOR)) {
          shockFloored = true;
          return SHOCK_VOL_FLOOR;
        }
        return shocked;
      });
      const deltas = s.strikes.map((K, i) =>
        callDelta({
          spot: this.referenceSpot,
          strike: K,
          timeToExpiryYears: s.timeToExpiryYears,
          riskFreeRate: this.rate,
          dividendYield: this.dividendYield,
          volatility: impliedVolatilities[i]!,
        }),
      );
      return {
        expiry: s.expiry,
        timeToExpiryYears: s.timeToExpiryYears,
        forward: s.forward,
        strikes: s.strikes.slice(),
        impliedVolatilities,
        deltas,
      };
    });

    const warnings: QuantWarning[] = [...this.diagnostics.warnings];
    if (parametric) {
      warnings.push({
        code: WarningCode.VolatilityShockDegradedToInterpolated,
        message:
          `Shock applied to a parametric '${this.model}' surface: the smile was sampled at the stored ` +
          `strikes and shifted, and the shocked surface is 'interpolated' (the ${this.model.toUpperCase()} ` +
          `fit was not re-fit).`,
        severity: 'warn',
        context: { from: this.model, to: newModel, parallel, skewTilt, sticky },
      });
    }
    if (shockFloored) {
      warnings.push({
        code: WarningCode.VolatilityShockFloored,
        message: `The shock drove one or more implied volatilities to/below the ${SHOCK_VOL_FLOOR} floor; those points were clamped to the floor, not the requested shift.`,
        severity: 'warn',
        context: { volatilityFloor: SHOCK_VOL_FLOOR },
      });
    }

    const cfg = this.ownSmileConfig(newModel);
    const interps = newSlices.map((s) => buildSmile(s, cfg, this.referenceSpot));

    const diagnostics: Diagnostics = {
      ...this.diagnostics,
      engine: 'vol-surface',
      method: methodFor(newModel, this.sabrBeta),
      warnings,
    };
    const assumptions: Assumptions<{ shock?: SurfaceShock }> = {
      ...this.assumptions,
      model: `vol-surface:${newModel} (shocked)`,
      shock: { parallel, skewTilt, sticky },
    };

    return VolatilitySurface.fromParts({
      model: newModel,
      slices: newSlices,
      points: this.points.map((p) => ({ ...p })),
      diagnostics,
      assumptions,
      interps,
      referenceSpot: this.referenceSpot,
      riskFreeRate: this.rate,
      dividendYield: this.dividendYield,
      sabrBeta: this.sabrBeta,
      sabrVolatilityType: this.sabrVolatilityType,
      cosineExpansionTerms: this.cosineExpansionTerms,
      ...(this.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: this.smoothingBandwidth }
        : {}),
    });
  }

  /**
   * The smile-chart / heatmap feed: one {@link SurfaceRow} per (slice, stored strike), with
   * `logMoneyness = ln(strike/forward)` and the stored `delta`/`iv`. Per the workspace missing-value
   * policy (WS2.12), any non-finite chart-facing numeric is emitted as `null` (never `NaN`, never
   * omitted).
   */
  toRows(): SurfaceRow[] {
    const finiteOrNull = (x: number | undefined): number | null =>
      x !== undefined && Number.isFinite(x) ? x : null;
    const rows: SurfaceRow[] = [];
    for (const s of this.slices) {
      for (let i = 0; i < s.strikes.length; i++) {
        const strike = s.strikes[i]!;
        const lm = s.forward > 0 ? Math.log(strike / s.forward) : NaN;
        rows.push({
          expiry: s.expiry,
          strike,
          logMoneyness: finiteOrNull(lm),
          delta: finiteOrNull(s.deltas[i]),
          impliedVolatility: finiteOrNull(s.impliedVolatilities[i]),
        });
      }
    }
    return rows;
  }

  /**
   * Serialize the surface to a plain, JSON-safe {@link VolatilitySurfaceSnapshot} (no closures). Restore it
   * with {@link VolatilitySurface.fromJSON}; the pair round-trips `iv()` identically on all six models.
   */
  toJSON(): VolatilitySurfaceSnapshot {
    return {
      schemaVersion: SURFACE_SCHEMA_VERSION,
      model: this.model,
      // Deep-copy every mutable field so the snapshot is an INDEPENDENT value — mutating it (or the
      // live surface) afterwards never corrupts the other (WS4.4 / review: no shallow "live" snapshot).
      slices: this.slices.map(cloneSlice),
      points: this.points.map((p) => ({ ...p })),
      assumptions: cloneSurfaceAssumptions(this.assumptions),
      diagnostics: cloneDiagnostics(this.diagnostics),
      referenceSpot: this.referenceSpot,
      config: {
        riskFreeRate: this.rate,
        dividendYield: this.dividendYield,
        sabrBeta: this.sabrBeta,
        sabrVolatilityType: this.sabrVolatilityType,
        cosineExpansionTerms: this.cosineExpansionTerms,
        ...(this.smoothingBandwidth !== undefined
          ? { smoothingBandwidth: this.smoothingBandwidth }
          : {}),
      },
      ...(this.ssvi !== undefined ? { ssvi: cloneSSVI(this.ssvi) } : {}),
      ...(this.essvi !== undefined ? { essvi: cloneESSVI(this.essvi) } : {}),
      ...(this.heston !== undefined ? { heston: { ...this.heston } } : {}),
    };
  }

  /**
   * Rebuild a surface from a {@link VolatilitySurfaceSnapshot}. Rejects a `schemaVersion` mismatch (design law
   * #4: never silently restore state a different build wrote). Interpolators are rebuilt via
   * {@link buildSmile} from the stored slice parameters — never re-fitted — so the restored surface answers
   * `iv()` identically to the one that produced the snapshot.
   */
  static fromJSON(snapshot: VolatilitySurfaceSnapshot): VolatilitySurface {
    if (snapshot.schemaVersion !== SURFACE_SCHEMA_VERSION) {
      throw new InputError(
        `VolatilitySurface.fromJSON: snapshot schemaVersion "${String(
          snapshot.schemaVersion,
        )}" does not ` +
          `match this build's "${SURFACE_SCHEMA_VERSION}"; the surface cannot be safely restored.`,
        {
          code: ErrorCode.VolatilitySnapshotVersionMismatch,
          context: { got: snapshot.schemaVersion, supported: SURFACE_SCHEMA_VERSION },
        },
      );
    }
    const cfg = snapshot.config;
    // Deep-copy so the rebuilt surface owns its own state and is not live-linked to the caller's snapshot.
    const slices: SurfaceSlice[] = snapshot.slices.map(cloneSlice);
    const smileCfg: SmileConfig = {
      model: snapshot.model,
      riskFreeRate: cfg.riskFreeRate,
      dividendYield: cfg.dividendYield,
      sabrVolatilityType: cfg.sabrVolatilityType,
      cosineExpansionTerms: cfg.cosineExpansionTerms,
      ...(cfg.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: cfg.smoothingBandwidth }
        : {}),
    };
    const interps = slices.map((s) => buildSmile(s, smileCfg, snapshot.referenceSpot));
    return VolatilitySurface.fromParts({
      model: snapshot.model,
      slices,
      points: snapshot.points.map((p) => ({ ...p })),
      diagnostics: cloneDiagnostics(snapshot.diagnostics),
      assumptions: cloneSurfaceAssumptions(snapshot.assumptions),
      interps,
      referenceSpot: snapshot.referenceSpot,
      riskFreeRate: cfg.riskFreeRate,
      dividendYield: cfg.dividendYield,
      sabrBeta: cfg.sabrBeta,
      sabrVolatilityType: cfg.sabrVolatilityType,
      cosineExpansionTerms: cfg.cosineExpansionTerms,
      ...(snapshot.ssvi !== undefined ? { ssvi: cloneSSVI(snapshot.ssvi) } : {}),
      ...(snapshot.essvi !== undefined ? { essvi: cloneESSVI(snapshot.essvi) } : {}),
      ...(snapshot.heston !== undefined ? { heston: { ...snapshot.heston } } : {}),
      ...(cfg.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: cfg.smoothingBandwidth }
        : {}),
    });
  }

  /**
   * Construct a surface from already-built parts, bypassing quote-solving. Used by {@link shock} and
   * {@link fromJSON}: the readonly fields are set on a bare instance so `iv()`/`lookup()` behave exactly
   * as a constructor-built surface would.
   */
  private static fromParts(parts: {
    model: SurfaceModel;
    slices: SurfaceSlice[];
    points: SurfacePoint[];
    diagnostics: Diagnostics;
    assumptions: Assumptions<{ shock?: SurfaceShock }>;
    ssvi?: SSVIParameters;
    essvi?: ESSVIParameters;
    heston?: HestonParameters;
    interps: Array<(x: number) => number>;
    referenceSpot: number;
    riskFreeRate: number;
    dividendYield: number;
    sabrBeta: number;
    sabrVolatilityType: SabrVolatilityType;
    smoothingBandwidth?: number;
    cosineExpansionTerms: number;
  }): VolatilitySurface {
    // Set the readonly fields on a bare instance via `Object.assign` (constructors are the only place
    // TS lets you write readonly props directly; a rebuilt surface must skip quote-solving).
    const surf = Object.create(VolatilitySurface.prototype) as VolatilitySurface;
    Object.assign(surf, {
      model: parts.model,
      slices: parts.slices,
      points: parts.points,
      diagnostics: parts.diagnostics,
      assumptions: parts.assumptions,
      interps: parts.interps,
      referenceSpot: parts.referenceSpot,
      rate: parts.riskFreeRate,
      dividendYield: parts.dividendYield,
      sabrBeta: parts.sabrBeta,
      sabrVolatilityType: parts.sabrVolatilityType,
      cosineExpansionTerms: parts.cosineExpansionTerms,
      ...(parts.ssvi !== undefined ? { ssvi: parts.ssvi } : {}),
      ...(parts.essvi !== undefined ? { essvi: parts.essvi } : {}),
      ...(parts.heston !== undefined ? { heston: parts.heston } : {}),
      ...(parts.smoothingBandwidth !== undefined
        ? { smoothingBandwidth: parts.smoothingBandwidth }
        : {}),
    });
    return surf;
  }
}

/** Fit an implied-volatility surface from an option chain. */
const VOLATILITY_SURFACE_SPEC: ClosedRequestSpecification = (() => {
  const spec = VALIDATION_SPECS['volatilitySurface#0'];
  if (spec === undefined)
    throw new Error('surface: missing generated spec — run `pnpm validation:update`');
  return spec;
})();

export function volatilitySurface(input: VolatilitySurfaceInput): VolatilitySurface {
  validateClosedRequest('volatilitySurface', input, VOLATILITY_SURFACE_SPEC, {
    exampleCall: 'volatilitySurface({ referenceDate, slices })',
  });
  return new VolatilitySurface(input);
}
