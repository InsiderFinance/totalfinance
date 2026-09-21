/**
 * Volatility-surface PCA (spec: `docs/specs/surface-pca.md`, roadmap Tier 2). The package fits a surface at a
 * point in time; this answers how it *moves*. Given a history of surface snapshots, it runs a principal-
 * component analysis of the surface CHANGES and reports the dominant modes — the same
 * Litterman–Scheinkman shapes as a yield curve (level / slope / curvature) — each with its variance
 * explained and a factor-score time series, the raw material for surface risk and scenario models.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  ensureFinite,
  requireArgumentArray,
  requireArgumentObject,
  validateClosedRequest,
} from '@totalfinance/core';
import { jacobiEigen } from '@totalfinance/math';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. Array ELEMENTS (snapshots rows, modes)
 * keep their curated per-element checks — the spec closes the containers.
 */
function surfacePcaSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `surface-pca: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SURFACE_PCA_SPEC = surfacePcaSpecOf('surfacePCA#0');
const SURFACE_PCA_SCENARIOS_SPEC = surfacePcaSpecOf('surfacePcaScenarios#0');

const SURFACE_PCA_EXAMPLE = (): string =>
  'surfacePCA({ snapshots: [[0.2, 0.22], [0.21, 0.23], [0.2, 0.21]], gridPoints: [0.9, 1.1] })';
const SURFACE_PCA_SCENARIOS_EXAMPLE = (): string =>
  'surfacePcaScenarios({ pca: surfacePCA({ snapshots }), base: [0.2, 0.22], sigmas: [-1, 1] })';

/** Inputs for {@link surfacePCA}. */
export interface SurfacePcaInput {
  /** IV snapshots over time; `snapshots[t]` is the vol vector at a FIXED set of grid points. */
  snapshots: number[][];
  /** Ordered grid coordinates (moneyness or tenor), one per column — used to label mode shapes. */
  gridPoints?: number[];
  /** How to difference consecutive snapshots; default `'absolute'`. */
  changes?: 'absolute' | 'relative';
  /** Retain only the top-k modes; default all (= grid size). */
  maxComponents?: number;
}

/** One principal mode of surface motion. */
export interface SurfaceMode {
  /** The eigenvector across the grid (sign-canonicalized so the loadings sum ≥ 0). */
  loadings: number[];
  eigenvalue: number;
  /** Fraction of the total change variance this mode explains. */
  varianceExplained: number;
  /** Shape labeled from the loadings' sign-change count along the grid. */
  shape: 'level' | 'slope' | 'curvature' | 'higher-order';
  /** Factor score per change observation: the projection of each centered change onto `loadings`. */
  scores: number[];
}

/** Result of {@link surfacePCA}. */
export interface SurfacePcaResult {
  modes: SurfaceMode[];
  /** Cumulative variance explained up to and including each mode. */
  cumulativeVarianceExplained: number[];
  totalVariance: number;
  /** Number of change vectors (`snapshots.length − 1`). */
  observations: number;
  gridSize: number;
  changeType: 'absolute' | 'relative';
  assumptions: {
    conventionsVersion: string;
    changeType: 'absolute' | 'relative';
    ordered: boolean;
  };
  diagnostics: Diagnostics;
}

/** Count sign changes along the loadings ordered by the grid; near-zero loadings are skipped. */
function shapeFromLoadings(loadings: number[], order: number[]): SurfaceMode['shape'] {
  const peak = Math.max(...loadings.map((x) => Math.abs(x)));
  const threshold = 0.15 * peak;
  let changes = 0;
  let previousSign = 0;
  for (const idx of order) {
    const v = loadings[idx]!;
    if (Math.abs(v) < threshold) continue; // ignore a wiggle near zero — not a real crossing
    const sign = v > 0 ? 1 : -1;
    if (previousSign !== 0 && sign !== previousSign) changes++;
    previousSign = sign;
  }
  return changes === 0
    ? 'level'
    : changes === 1
      ? 'slope'
      : changes === 2
        ? 'curvature'
        : 'higher-order';
}

/**
 * Principal-component analysis of vol-surface changes: the dominant modes of surface motion
 * (level / slope / curvature), each with its variance explained and factor-score series. See the spec.
 */
export function surfacePCA(input: SurfacePcaInput): SurfacePcaResult {
  const functionName = 'surfacePCA';
  validateClosedRequest(functionName, input, SURFACE_PCA_SPEC, {
    exampleCall: SURFACE_PCA_EXAMPLE,
  });
  const snapshots = input.snapshots;
  const T = snapshots.length;
  if (T < 2) {
    throw new InputError(`${functionName}: need ≥ 2 snapshots to form a change; got ${T}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { snapshots: T },
    });
  }
  requireArgumentArray(functionName, 'snapshots[0]', snapshots[0] as unknown);
  const G = snapshots[0]!.length;
  if (G < 2) {
    throw new InputError(`${functionName}: need ≥ 2 grid points; got ${G}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { gridSize: G },
    });
  }
  const changeType = input.changes ?? 'absolute';
  if (input.gridPoints !== undefined) {
    if (input.gridPoints.length !== G) {
      throw new InputError(
        `${functionName}: gridPoints has length ${input.gridPoints.length} but each snapshot has ${G} points.`,
        { code: ErrorCode.InputOutOfRange, context: { gridPoints: input.gridPoints.length, G } },
      );
    }
    input.gridPoints.forEach((g, i) => ensureFinite(g, `gridPoints[${i}]`, functionName));
  }
  const maxComponents = input.maxComponents ?? G;
  // Safe integer (2026-08-23 review, P0): `Math.min(maxComponents, G)` below keeps the retained
  // count data-bounded, but the count itself must be exact — above 2^53 it is not.
  if (!Number.isSafeInteger(maxComponents) || maxComponents < 1) {
    throw new InputError(
      `${functionName}: maxComponents must be a positive integer; got ${maxComponents}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxComponents },
      },
    );
  }

  // Build the T−1 change vectors (validating shapes and values along the way).
  const changes: number[][] = [];
  for (let t = 1; t < T; t++) {
    requireArgumentArray(functionName, `snapshots[${t}]`, snapshots[t] as unknown);
    if (snapshots[t]!.length !== G) {
      throw new InputError(
        `${functionName}: snapshots[${t}] has ${snapshots[t]!.length} points but snapshots[0] has ${G}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { snapshotIndex: t, length: snapshots[t]!.length, G },
        },
      );
    }
    const row = new Array<number>(G);
    for (let i = 0; i < G; i++) {
      const cur = snapshots[t]![i]!;
      const prev = snapshots[t - 1]![i]!;
      ensureFinite(cur, `snapshots[${t}][${i}]`, functionName);
      ensureFinite(prev, `snapshots[${t - 1}][${i}]`, functionName);
      if (changeType === 'relative') {
        if (prev === 0) {
          throw new InputError(
            `${functionName}: relative changes need a non-zero prior vol; snapshots[${t - 1}][${i}] = 0.`,
            { code: ErrorCode.InputOutOfRange, context: { snapshotIndex: t - 1, i } },
          );
        }
        row[i] = (cur - prev) / prev;
      } else {
        row[i] = cur - prev;
      }
    }
    changes.push(row);
  }
  const m = changes.length; // T − 1

  // Column-center the changes.
  const mean = new Array<number>(G).fill(0);
  for (const row of changes) for (let i = 0; i < G; i++) mean[i]! += row[i]! / m;
  const centered = changes.map((row) => row.map((v, i) => v - mean[i]!));

  // G×G covariance of the centered changes.
  const covariance: number[][] = Array.from({ length: G }, () => new Array<number>(G).fill(0));
  const denom = m > 1 ? m - 1 : 1;
  for (const row of centered) {
    for (let i = 0; i < G; i++) {
      for (let j = i; j < G; j++) {
        covariance[i]![j]! += (row[i]! * row[j]!) / denom;
      }
    }
  }
  for (let i = 0; i < G; i++)
    for (let j = i + 1; j < G; j++) covariance[j]![i] = covariance[i]![j]!;

  const { values, vectors } = jacobiEigen(covariance);
  const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  // Grid order for the shape label: indices sorted by gridPoints (or the natural column order).
  const gridOrder =
    input.gridPoints !== undefined
      ? input.gridPoints
          .map((_, i) => i)
          .sort((a, b) => input.gridPoints![a]! - input.gridPoints![b]!)
      : Array.from({ length: G }, (_, i) => i);

  const keep = Math.min(maxComponents, G);
  const modes: SurfaceMode[] = [];
  const cumulative: number[] = [];
  let acc = 0;
  for (let k = 0; k < keep; k++) {
    const col = order[k]!;
    let loadings = vectors.map((rowVec) => rowVec[col]!);
    // Sign-canonicalize: orient so the loadings sum ≥ 0 (a stable, reproducible orientation).
    const sum = loadings.reduce((s, x) => s + x, 0);
    if (sum < 0) loadings = loadings.map((x) => -x);
    const eigenvalue = values[col]!;
    const varianceExplained = total > 0 ? Math.max(0, eigenvalue) / total : 0;
    acc += varianceExplained;
    cumulative.push(acc);
    const scores = centered.map((row) => {
      let s = 0;
      for (let i = 0; i < G; i++) s += row[i]! * loadings[i]!;
      return s;
    });
    modes.push({
      loadings,
      eigenvalue,
      varianceExplained,
      shape: shapeFromLoadings(loadings, gridOrder),
      scores,
    });
  }

  return {
    modes,
    cumulativeVarianceExplained: cumulative,
    totalVariance: total,
    observations: m,
    gridSize: G,
    changeType,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      changeType,
      ordered: input.gridPoints !== undefined,
    },
    diagnostics: { engine: 'surface-pca', method: 'jacobi-eigen', converged: true, warnings: [] },
  };
}

// ───────────────────────── PCA scenario shocks ─────────────────────────

/** Inputs for {@link surfacePcaScenarios}. */
export interface SurfacePcaScenarioInput {
  /** The result of {@link surfacePCA} — its modes drive the shocks. */
  pca: SurfacePcaResult;
  /** Current volatilities to shock, at the SAME grid points as the PCA (length = `pca.gridSize`). */
  base: number[];
  /** Shock magnitudes in standard deviations, applied to each mode. Default `[-1, 1]`. */
  sigmas?: number[];
  /** Shock only the top-N modes. Default all of `pca.modes`. */
  maxModes?: number;
  /** Floor for the shocked volatilities (a vol can't go negative). Default 0. */
  floor?: number;
  /** Optional per-mode sigma moves → one combined shocked surface. */
  combined?: number[];
}

/** One shocked-surface scenario (a `sigma`-standard-deviation move along one mode). */
export interface SurfaceScenario {
  /** 0-indexed mode. */
  mode: number;
  shape: SurfaceMode['shape'];
  sigma: number;
  /**
   * `sigma·√λ·loadings` — the (unclamped) surface change vector, in the PCA's own units: VOL POINTS
   * for an `absolute` PCA, FRACTIONS of the base vol for a `relative` one.
   */
  shockVector: number[];
  /**
   * The shocked surface, floored: `max(floor, base + shockVector)` for an `absolute` PCA,
   * `max(floor, base · (1 + shockVector))` for a `relative` one.
   */
  shockedSurface: number[];
}

/** Result of {@link surfacePcaScenarios}. */
export interface SurfacePcaScenarios {
  base: number[];
  /** One per `(mode, sigma)`, in mode-major order. */
  scenarios: SurfaceScenario[];
  /** `base + Σ sᵢ·√λᵢ·loadingsᵢ`, floored — present only when `combined` is supplied. */
  combinedSurface?: number[];
  assumptions: { conventionsVersion: string; changeType: 'absolute' | 'relative'; floor: number };
  diagnostics: Diagnostics;
}

/** The 1-sigma surface change of a mode: `√max(0, eigenvalue)·loadings` (loadings are unit-norm). */
function sigmaMove(mode: SurfaceMode, G: number, functionName: string, idx: number): number[] {
  requireArgumentObject(functionName, `pca.modes[${idx}]`, mode);
  requireArgumentArray(
    functionName,
    `pca.modes[${idx}].loadings`,
    (mode as { loadings?: unknown }).loadings,
  );
  if (mode.loadings.length !== G) {
    throw new InputError(
      `${functionName}: pca.modes[${idx}].loadings has length ${mode.loadings.length} but the grid size is ${G}.`,
      { code: ErrorCode.InputOutOfRange, context: { index: idx, length: mode.loadings.length, G } },
    );
  }
  ensureFinite(mode.eigenvalue, `pca.modes[${idx}].eigenvalue`, functionName);
  mode.loadings.forEach((x, i) =>
    ensureFinite(x, `pca.modes[${idx}].loadings[${i}]`, functionName),
  );
  const sd = Math.sqrt(Math.max(0, mode.eigenvalue));
  return mode.loadings.map((x) => sd * x);
}

/**
 * Turn a fitted {@link surfacePCA} into **stress scenarios**: shock a base surface by `±k` standard
 * deviations along each principal mode (`k·√λ·loadings`, since `√λ` is the mode's 1-sigma move and the
 * loadings are unit-norm), and optionally by a combined per-mode move. Shocked volatilities are floored (default 0)
 * so a large downside shock can't go negative.
 *
 * The shock is applied in the units the PCA was FITTED in (`pca.changeType`): `absolute` adds the
 * vector to the base vols, `relative` scales them (`base·(1 + shock)`), because a relative PCA's
 * modes are proportional moves. See `docs/specs/surface-pca-scenarios.md`.
 */
export function surfacePcaScenarios(input: SurfacePcaScenarioInput): SurfacePcaScenarios {
  const functionName = 'surfacePcaScenarios';
  validateClosedRequest(functionName, input, SURFACE_PCA_SCENARIOS_SPEC, {
    exampleCall: SURFACE_PCA_SCENARIOS_EXAMPLE,
  });
  if (input.pca.modes.length === 0) {
    throw new InputError(`${functionName}: pca.modes must have at least one mode.`, {
      code: ErrorCode.InputOutOfRange,
      context: { modes: 0 },
    });
  }
  const G = input.base.length;
  if (G < 1) {
    throw new InputError(`${functionName}: base must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { base: 0 },
    });
  }
  input.base.forEach((v, i) => ensureFinite(v, `base[${i}]`, functionName));

  const sigmas = input.sigmas ?? [-1, 1];
  sigmas.forEach((s, i) => ensureFinite(s, `sigmas[${i}]`, functionName));

  const maxModes = input.maxModes ?? input.pca.modes.length;
  // Safe integer (2026-08-23 review, P0): `Math.min(maxModes, modes.length)` below keeps the
  // scenario count data-bounded, but the count itself must be exact — above 2^53 it is not.
  if (!Number.isSafeInteger(maxModes) || maxModes < 1) {
    throw new InputError(`${functionName}: maxModes must be a positive integer; got ${maxModes}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { maxModes },
    });
  }
  const nModes = Math.min(maxModes, input.pca.modes.length);

  const floor = input.floor ?? 0;

  // Apply a shock in the SAME space the PCA was run in. A `relative` PCA differenced
  // `(σₜ − σₜ₋₁)/σₜ₋₁`, so its loadings — and therefore `√λ·loadings` — are FRACTIONS, not vol
  // points: adding 0.12 to a 0.30 vol when the mode says "+12%" gave 0.42 instead of 0.336, and the
  // error grows with the base vol (a 1.00 vol moved by the same 0.12 either way).
  const relative = input.pca.changeType === 'relative';
  const applyShock = (shock: number[]): number[] =>
    input.base.map((v, i) => Math.max(floor, relative ? v * (1 + shock[i]!) : v + shock[i]!));

  const scenarios: SurfaceScenario[] = [];
  for (let k = 0; k < nModes; k++) {
    const mode = input.pca.modes[k]!;
    const move = sigmaMove(mode, G, functionName, k); // √λ·loadings
    for (const sigma of sigmas) {
      const shockVector = move.map((x) => sigma * x);
      scenarios.push({
        mode: k,
        shape: mode.shape,
        sigma,
        shockVector,
        shockedSurface: applyShock(shockVector),
      });
    }
  }

  const result: SurfacePcaScenarios = {
    base: [...input.base],
    scenarios,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      changeType: input.pca.changeType,
      floor,
    },
    diagnostics: {
      engine: 'surface-pca-scenarios',
      method: 'mode-sigma-shock',
      converged: true,
      warnings: [],
    },
  };

  if (input.combined !== undefined) {
    if (input.combined.length > input.pca.modes.length) {
      throw new InputError(
        `${functionName}: combined has ${input.combined.length} entries but there are only ${input.pca.modes.length} modes.`,
        { code: ErrorCode.InputOutOfRange, context: { combined: input.combined.length } },
      );
    }
    const shock = new Array<number>(G).fill(0);
    input.combined.forEach((s, k) => {
      ensureFinite(s, `combined[${k}]`, functionName);
      const move = sigmaMove(input.pca.modes[k]!, G, functionName, k);
      for (let i = 0; i < G; i++) shock[i]! += s * move[i]!;
    });
    result.combinedSurface = applyShock(shock);
  }

  return result;
}
