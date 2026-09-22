/**
 * Swaption cube — SABR-on-rates (spec: `docs/specs/swaption-cube.md`, roadmap Tier 2). The interest-rate
 * vol surface: implied vol as a function of option **expiry × swap tenor × strike**. Quote-driven, like
 * the SSVI surface: each `(expiry, tenor)` node carries a forward swap rate and a market smile; the cube
 * calibrates a SABR smile per node (`calibrateSabrSmile`) and interpolates the SABR parameters bilinearly
 * across the grid, so the vol at any `(expiry, tenor, strike)` — including between quoted nodes — is one
 * call. Pricing a swaption is then `annuity · Black(forward, strike, cubeVolatility, expiry)`, with the forward
 * and annuity supplied from `@insiderfinance/totalfinance/fixed-income` — `forwardSwap(curves, spec)` returns exactly that
 * curve-driven pair from a live OIS/projection curve (kept out of this package to avoid a dependency).
 *
 * Home note: this lives in `@insiderfinance/totalfinance/volatility` (not `fixed-income`) because it is a vol object built on the
 * SABR machinery here; `fixed-income` does not depend on `vol`, so building it here adds no package edge.
 */

import {
  ensureKnownKeys,
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  validateClosedRequest,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { type SabrParameters, type SabrVolatilityType } from '@totalfinance/options';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { type SABRCalibrationResult, calibrateSabrSmile } from './sabr.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import. `swaptionCube` itself carries no
 * generated key and keeps its curated checks.
 */
function swaptionCubeSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `swaption-cube: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SWAPTION_CUBE_VOLATILITY_SPEC = swaptionCubeSpecOf('swaptionCubeVolatility#0');

const SWAPTION_CUBE_VOLATILITY_EXAMPLE = (): string =>
  'swaptionCubeVolatility({ cube: swaptionCube({ nodes }), expiryYears: 1, tenorYears: 5, strike: 0.03 })';

/** RMSE above this (in vol points) marks a node's SABR fit as poor. 10bp of vol. */
const POOR_FIT_RMSE = 1e-3;

/** One market `(expiry, tenor)` node: a forward swap rate and a smile. */
export interface SwaptionCubeNode {
  /** Option expiry in years. */
  expiryYears: number;
  /** Underlying swap tenor in years. */
  tenorYears: number;
  /** Forward swap rate for this node (the SABR forward). */
  forward: number;
  /** Absolute strike rates (≥ 3), aligned to `volatilities`. */
  strikes: number[];
  /** Market implied volatilities aligned to `strikes`. */
  volatilities: number[];
  /** Per-node backbone β override (else the cube default). */
  beta?: number;
}

/** Input for {@link swaptionCube}. */
export interface SwaptionCubeInput {
  nodes: SwaptionCubeNode[];
  /** Default backbone β for every node's calibration (0.5, the rates convention). */
  beta?: number;
  /** Volatility quote convention: `'lognormal'` (Black, default) or `'normal'` (Bachelier). */
  volatilityType?: SabrVolatilityType;
  /**
   * Rate displacement `s ≥ 0` for **shifted (displaced) SABR** — SABR is lognormal and needs
   * `forward, strike > 0`, so a negative-rate cube must be calibrated on `forward + s` / `strike + s`.
   * Default `0` (plain SABR). With `s > 0` the `'lognormal'` volatilities are *shifted*-lognormal — price with
   * Black on the shifted rates, `annuity · Black(forward + s, strike + s, vol, expiry)`; `'normal'`
   * (Bachelier) volatilities are unchanged (a common shift cancels in `forward − strike`). See
   * `docs/specs/swaption-cube-shift.md`.
   */
  shift?: number;
  /** `calibrateSabrSmile` iteration cap (pass-through). */
  maximumIterations?: number;
  /** `calibrateSabrSmile` tolerance (pass-through). */
  tolerance?: number;
}

/** A calibrated `(expiry, tenor)` node. */
export interface CalibratedSwaptionNode {
  expiryYears: number;
  tenorYears: number;
  forward: number;
  parameters: SabrParameters;
  /** SABR vol at `strike = forward`. */
  atmVolatility: number;
  rmse: number;
  converged: boolean;
}

/** The calibrated swaption cube (data-only, serializable). */
export interface SwaptionCube {
  /** Calibrated nodes, sorted by `(expiry, tenor)`. */
  nodes: CalibratedSwaptionNode[];
  /** Unique expiries, ascending. */
  expiries: number[];
  /** Unique tenors, ascending. */
  tenors: number[];
  volatilityType: SabrVolatilityType;
  /**
   * The rate displacement applied inside SABR (`0` for plain SABR). Nodes' `forward` fields stay the
   * real (unshifted) rates; the shift lives only in the SABR calibration/evaluation. {@link swaptionCubeVolatility}
   * reads this off the cube. OPTIONAL because legacy (pre-shift) serialized cubes carry no field —
   * evaluation reads an absent shift as `0`; the declaration used to say required while the
   * runtime documented that default, and the 3B.1b spec convicted the mismatch (the TA lesson:
   * when the runtime is right, the DECLARATION is what lies).
   */
  shift?: number;
  assumptions: {
    conventionsVersion: string;
    volatilityType: SabrVolatilityType;
    backbone: 'sabr';
    shift: number;
  };
  diagnostics: Diagnostics;
}

const uniqueSorted = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);
const gridKey = (expiry: number, tenor: number): string => `${expiry}|${tenor}`;

/**
 * Calibrate a SABR smile per `(expiry, tenor)` node of a market swaption vol cube. The grid must be
 * complete and rectangular (every expiry × tenor present once). See `docs/specs/swaption-cube.md`.
 */

/**
 * `?? default` treats an explicit `null` as "absent" — but null is a STATED value, not an
 * omission; a config that says `beta: null` is a caller error worth a teaching, not a silent
 * default (2026-08-23 fourth-review enforcement: null-when-nonnullable) .
 */
function refuseNullOption(functionName: string, field: string, value: unknown): void {
  if (value === null) {
    throw new InputError(
      `${functionName}: ${field} must not be null — omit the field to take its default.`,
      { code: ErrorCode.InputWrongType, context: { field } },
    );
  }
}

export function swaptionCube(input: SwaptionCubeInput): SwaptionCube {
  const functionName = 'swaptionCube';
  requireArgumentObject(functionName, 'input', input);
  // Law 12 (2026-08-23, fourth review): the input is CLOSED — an unknown key is a typo teaching,
  // never silently ignored.
  ensureKnownKeys(functionName, 'input', input, [
    'nodes',
    'beta',
    'volatilityType',
    'shift',
    'maximumIterations',
    'tolerance',
  ]);
  requireArgumentArray(functionName, 'input.nodes', (input as { nodes?: unknown }).nodes);
  if (input.nodes.length === 0) {
    throw new InputError(`${functionName}: at least one node is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { nodes: 0 },
    });
  }
  for (const field of [
    'beta',
    'volatilityType',
    'shift',
    'maximumIterations',
    'tolerance',
  ] as const) {
    refuseNullOption(functionName, field, input[field]);
  }
  const defaultBeta = input.beta ?? 0.5;
  ensureFinite(defaultBeta, 'beta', functionName);
  const volatilityType: SabrVolatilityType = input.volatilityType ?? 'lognormal';
  const shift = input.shift ?? 0;
  ensureFinite(shift, 'shift', functionName);
  if (shift < 0) {
    throw new InputError(`${functionName}: shift must be ≥ 0 (got ${shift}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { shift },
    });
  }

  const expiries = uniqueSorted(input.nodes.map((n) => n.expiryYears));
  const tenors = uniqueSorted(input.nodes.map((n) => n.tenorYears));
  if (input.nodes.length !== expiries.length * tenors.length) {
    throw new InputError(
      `${functionName}: the node grid must be complete and rectangular — got ${input.nodes.length} nodes for a ${expiries.length}×${tenors.length} (expiry×tenor) grid.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { nodes: input.nodes.length, expiries: expiries.length, tenors: tenors.length },
      },
    );
  }

  const seen = new Set<string>();
  const warnings: QuantWarning[] = [];
  const nodes: CalibratedSwaptionNode[] = input.nodes.map((node, i) => {
    requireArgumentObject(functionName, `nodes[${i}]`, node);
    ensurePositive(node.expiryYears, `nodes[${i}].expiryYears`, functionName);
    ensurePositive(node.tenorYears, `nodes[${i}].tenorYears`, functionName);
    const key = gridKey(node.expiryYears, node.tenorYears);
    if (seen.has(key)) {
      throw new InputError(
        `${functionName}: duplicate node at (expiry ${node.expiryYears}, tenor ${node.tenorYears}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { expiry: node.expiryYears, tenor: node.tenorYears },
        },
      );
    }
    seen.add(key);

    // Shifted (displaced) SABR: calibrate/evaluate on forward + s / strike + s so both stay positive
    // even for negative rates. shift = 0 leaves the classic positive-rate path untouched.
    ensureFinite(node.forward, `nodes[${i}].forward`, functionName);
    requireArgumentArray(functionName, `nodes[${i}].strikes`, node.strikes);
    const shiftedForward = node.forward + shift;
    if (!(shiftedForward > 0)) {
      throw new InputError(
        `${functionName}: forward + shift must be > 0 at (expiry ${node.expiryYears}, tenor ${node.tenorYears}) — forward ${node.forward} + shift ${shift} = ${shiftedForward}. Increase shift for the negative forward.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            forward: node.forward,
            shift,
            expiry: node.expiryYears,
            tenor: node.tenorYears,
          },
        },
      );
    }
    const minStrike = Math.min(...node.strikes);
    if (!(minStrike + shift > 0)) {
      throw new InputError(
        `${functionName}: min(strike) + shift must be > 0 at (expiry ${node.expiryYears}, tenor ${
          node.tenorYears
        }) — min strike ${minStrike} + shift ${shift} = ${minStrike + shift}. Increase shift.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { minStrike, shift, expiry: node.expiryYears, tenor: node.tenorYears },
        },
      );
    }

    const nodeBeta = node.beta ?? defaultBeta;
    const fit: SABRCalibrationResult = calibrateSabrSmile(
      {
        forward: shiftedForward,
        strikes: node.strikes.map((k) => k + shift),
        impliedVolatilities: node.volatilities,
        timeToExpiryYears: node.expiryYears,
      },
      {
        beta: nodeBeta,
        volatilityType,
        ...(input.maximumIterations !== undefined
          ? { maximumIterations: input.maximumIterations }
          : {}),
        ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
      },
    );
    const atmVolatility = sabrVolatility({
      input: {
        forward: shiftedForward,
        strike: shiftedForward,
        timeToExpiryYears: node.expiryYears,
      },
      parameters: fit.parameters,
      options: { volatilityType },
    });
    if (!fit.converged || fit.rmse > POOR_FIT_RMSE) {
      warnings.push(
        warning(
          WarningCode.VolatilitySwaptionNodePoorFit,
          `${functionName}: SABR fit at (expiry ${node.expiryYears}, tenor ${node.tenorYears}) ${
            fit.converged
              ? `has RMSE ${(fit.rmse * 1e4).toFixed(1)}bp (> ${(POOR_FIT_RMSE * 1e4).toFixed(
                  0,
                )}bp)`
              : 'did not converge'
          }.`,
          'warn',
          {
            expiry: node.expiryYears,
            tenor: node.tenorYears,
            rmse: fit.rmse,
            converged: fit.converged,
          },
        ),
      );
    }
    return {
      expiryYears: node.expiryYears,
      tenorYears: node.tenorYears,
      forward: node.forward,
      parameters: fit.parameters,
      atmVolatility,
      rmse: fit.rmse,
      converged: fit.converged,
    };
  });

  nodes.sort((a, b) => a.expiryYears - b.expiryYears || a.tenorYears - b.tenorYears);

  return {
    nodes,
    expiries,
    tenors,
    volatilityType,
    shift,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      volatilityType,
      backbone: 'sabr',
      shift,
    },
    diagnostics: {
      engine: 'swaption-cube',
      method: shift > 0 ? 'sabr-per-node (shifted)' : 'sabr-per-node',
      converged: nodes.every((n) => n.converged),
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------

/** Query for {@link swaptionCubeVolatility}. */
export interface SwaptionCubeVolatilityQuery {
  cube: SwaptionCube;
  /** Option expiry in years. */
  expiryYears: number;
  /** Underlying swap tenor in years. */
  tenorYears: number;
  /** Absolute strike rate. */
  strike: number;
}

/** The interpolated implied vol at a cube point. */
export interface SwaptionCubeVolatilityResult {
  /** Interpolated implied vol. */
  value: number;
  /** Interpolated forward swap rate. */
  forward: number;
  /** The interpolated SABR parameters used. */
  parameters: SabrParameters;
  /** Whether the query fell outside the `(expiry, tenor)` grid (clamped to the edge). */
  extrapolated: boolean;
  assumptions: {
    conventionsVersion: string;
    volatilityType: SabrVolatilityType;
    interpolation: 'bilinear-parameters';
    /** The cube's rate shift, echoed so the caller prices with the matching (shifted) convention. */
    shift: number;
  };
  diagnostics: Diagnostics;
}

/** Bracket `v` in the ascending `axis`: return `[i0, i1, w]` with `v ≈ axis[i0]·(1−w) + axis[i1]·w`. */
function bracket(
  axis: number[],
  v: number,
): { i0: number; i1: number; w: number; outside: boolean } {
  const n = axis.length;
  if (v <= axis[0]!) return { i0: 0, i1: 0, w: 0, outside: v < axis[0]! };
  if (v >= axis[n - 1]!) return { i0: n - 1, i1: n - 1, w: 0, outside: v > axis[n - 1]! };
  let i0 = 0;
  while (i0 < n - 1 && axis[i0 + 1]! <= v) i0++;
  const i1 = i0 + 1;
  const w = (v - axis[i0]!) / (axis[i1]! - axis[i0]!);
  return { i0, i1, w, outside: false };
}

/**
 * Evaluate the swaption cube's implied vol at an arbitrary `(expiry, tenor, strike)` by bilinearly
 * interpolating the forward and SABR parameters across the grid, then evaluating the SABR smile. See
 * `docs/specs/swaption-cube.md`.
 */
export function swaptionCubeVolatility(
  query: SwaptionCubeVolatilityQuery,
): SwaptionCubeVolatilityResult {
  const functionName = 'swaptionCubeVolatility';
  validateClosedRequest(functionName, query, SWAPTION_CUBE_VOLATILITY_SPEC, {
    argumentName: 'query',
    subject: true,
    exampleCall: SWAPTION_CUBE_VOLATILITY_EXAMPLE,
  });
  const cube = query.cube;
  if (cube.nodes.length === 0) {
    throw new InputError(`${functionName}: cube is missing its calibrated nodes/axes.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'cube' },
    });
  }
  ensurePositive(query.expiryYears, 'expiryYears', functionName);
  ensurePositive(query.tenorYears, 'tenorYears', functionName);
  // Shifted (displaced) SABR: a negative-rate cube may be queried at a negative strike, but the SABR
  // evaluation still needs strike + shift > 0. Default (unshifted) cubes keep the strike > 0 guard.
  const shift = cube.shift ?? 0;
  if (!(query.strike + shift > 0)) {
    throw new InputError(
      `${functionName}: strike + shift must be > 0 (strike ${query.strike} + shift ${shift} = ${
        query.strike + shift
      }).`,
      { code: ErrorCode.InputOutOfRange, context: { strike: query.strike, shift } },
    );
  }

  const byKey = new Map<string, CalibratedSwaptionNode>();
  for (const node of cube.nodes) byKey.set(gridKey(node.expiryYears, node.tenorYears), node);

  const ex = bracket(cube.expiries, query.expiryYears);
  const te = bracket(cube.tenors, query.tenorYears);
  const nodeAt = (ei: number, ti: number): CalibratedSwaptionNode => {
    const key = gridKey(cube.expiries[ei]!, cube.tenors[ti]!);
    const node = byKey.get(key);
    if (!node) {
      throw new InputError(
        `${functionName}: cube grid is missing the node at expiry/tenor index (${ei}, ${ti}).`,
        {
          code: ErrorCode.InputMissingField,
          context: { expiry: cube.expiries[ei], tenor: cube.tenors[ti] },
        },
      );
    }
    return node;
  };

  const n00 = nodeAt(ex.i0, te.i0);
  const n01 = nodeAt(ex.i0, te.i1);
  const n10 = nodeAt(ex.i1, te.i0);
  const n11 = nodeAt(ex.i1, te.i1);
  // Bilinear weight: (expiry weight ex.w) × (tenor weight te.w).
  const bilinear = (input: { q00: number; q01: number; q10: number; q11: number }): number => {
    const { q00, q01, q10, q11 } = input;
    return (
      q00 * (1 - ex.w) * (1 - te.w) +
      q10 * ex.w * (1 - te.w) +
      q01 * (1 - ex.w) * te.w +
      q11 * ex.w * te.w
    );
  };

  const forward = bilinear({
    q00: n00.forward,
    q01: n01.forward,
    q10: n10.forward,
    q11: n11.forward,
  });
  const parameters: SabrParameters = {
    alpha: bilinear({
      q00: n00.parameters.alpha,
      q01: n01.parameters.alpha,
      q10: n10.parameters.alpha,
      q11: n11.parameters.alpha,
    }),
    beta: bilinear({
      q00: n00.parameters.beta,
      q01: n01.parameters.beta,
      q10: n10.parameters.beta,
      q11: n11.parameters.beta,
    }),
    rho: bilinear({
      q00: n00.parameters.rho,
      q01: n01.parameters.rho,
      q10: n10.parameters.rho,
      q11: n11.parameters.rho,
    }),
    nu: bilinear({
      q00: n00.parameters.nu,
      q01: n01.parameters.nu,
      q10: n10.parameters.nu,
      q11: n11.parameters.nu,
    }),
  };
  const value = sabrVolatility({
    input: {
      forward: forward + shift,
      strike: query.strike + shift,
      timeToExpiryYears: query.expiryYears,
    },
    parameters,
    options: { volatilityType: cube.volatilityType },
  });

  const extrapolated = ex.outside || te.outside;
  const warnings: QuantWarning[] = [];
  if (extrapolated) {
    warnings.push(
      warning(
        WarningCode.VolatilitySwaptionCubeExtrapolated,
        `${functionName}: query (expiry ${query.expiryYears}, tenor ${query.tenorYears}) is outside the cube grid [${
          cube.expiries[0]
        }–${cube.expiries[cube.expiries.length - 1]}]×[${cube.tenors[0]}–${
          cube.tenors[cube.tenors.length - 1]
        }]; clamped to the edge (flat extrapolation).`,
        'warn',
        { expiry: query.expiryYears, tenor: query.tenorYears },
      ),
    );
  }

  return {
    value,
    forward,
    parameters,
    extrapolated,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      volatilityType: cube.volatilityType,
      interpolation: 'bilinear-parameters',
      shift,
    },
    diagnostics: {
      engine: 'swaption-cube-vol',
      method: 'bilinear-parameters + sabr',
      converged: true,
      warnings,
    },
  };
}
