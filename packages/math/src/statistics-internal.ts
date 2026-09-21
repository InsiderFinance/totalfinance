/**
 * Package-internal statistics machinery (spec 3B.1b) — validation and unchecked primitives.
 *
 * This module is deliberately ABSENT from the package `exports` map and re-exported by no public
 * subpath: `./statistics` is public API, so anything exported THERE is API, and a public validator
 * or unchecked kernel is a door past the guard (the `ssvi-kernel` rule). Public boundaries in
 * `statistics.ts`/`linalg.ts` validate ONCE at the external call, then delegate here; nothing in
 * this module validates options.
 *
 * The null ruling (review of `52f4e422e`, from C06 + the generated contract's `nullable: false`):
 * optional `undefined` is omission; `null` is NOT — these fields are declared non-nullable and the
 * runtime contract matches the declaration. An enum field teaches `input.invalid_enum`, a
 * boolean/numeric field teaches `input.wrong_type`. `null` is accepted only where a declaration
 * explicitly includes it, and none of these do.
 */

import {
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  requireArgumentObject,
} from '@totalfinance/core';
import type { NanPolicy, PopulationOptions, VarianceOptions } from './statistics.js';

export const NAN_POLICIES = ['propagate', 'omit', 'throw'] as const;

/** How a declared option field is validated when present. */
export type OptionFieldKind = 'nanPolicy' | 'boolean' | 'finiteNumber';

/**
 * A validation spec with its derived lookups precomputed once at module load — `Object.keys` and
 * `options.${key}` template construction per call were measurable in the delegation benchmark.
 */
export interface OptionsSpec {
  readonly fields: Readonly<Record<string, OptionFieldKind>>;
  readonly allowed: readonly string[];
  readonly paths: Readonly<Record<string, string>>;
}

/**
 * Build a spec from a field table. Exactness is enforced where the table is DEFINED:
 * `{...} as const satisfies Record<keyof T, OptionFieldKind>` fails the build when the interface
 * gains a field the table does not know, and when the table lists a key the interface never
 * declared. Compiler-checked, not generated — sufficient for these single-shape contracts;
 * union-shaped contracts take checker-derived per-branch lists instead.
 */
export function optionsSpec(fields: Readonly<Record<string, OptionFieldKind>>): OptionsSpec {
  const allowed = Object.keys(fields);
  const paths: Record<string, string> = {};
  for (const key of allowed) paths[key] = `options.${key}`;
  return { fields, allowed, paths };
}

function describeOption(value: unknown): string {
  if (typeof value === 'string') return `"${value}" (string)`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let printed: string;
  try {
    printed = JSON.stringify(value) ?? String(value);
  } catch {
    printed = String(value);
  }
  return `${printed} (${typeof value})`;
}

/**
 * Validate a public options argument. Called exactly ONCE per external call, at the public
 * boundary, under the public function's own name — never on an internal delegation frame. The
 * `undefined` fast path is a single comparison, so an options-less call pays nothing.
 */
export function validateOptions(functionName: string, options: unknown, spec: OptionsSpec): void {
  if (options === undefined) return;
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options as object, spec.allowed);
  for (const key of spec.allowed) {
    // Explicit annotation: `ensureEnum` is an `asserts` signature, and an asserted target may not
    // infer its own type (TS7022).
    const value: unknown = (options as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const path = spec.paths[key]!;
    const kind = spec.fields[key]!;
    if (kind === 'nanPolicy') {
      // `null` lands here too and reports invalid_enum — it is not one of the declared policies.
      ensureEnum(value, NAN_POLICIES, path, functionName);
    } else if (kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new InputError(
          `${functionName}: ${path} must be a boolean. Received ${describeOption(value)}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: path, received: typeof value },
          },
        );
      }
    } else {
      // finiteNumber: wrong type (including null) → wrong_type; NaN → input.nan; ±Inf → not_finite.
      if (typeof value !== 'number') {
        throw new InputError(
          `${functionName}: ${path} must be a number. Received ${describeOption(value)}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: path, received: typeof value },
          },
        );
      }
      ensureFinite(value, path, functionName);
    }
  }
}

/**
 * Shared by the rolling statistics and `covarianceMatrix`: contracts that take ONLY `population`.
 * The rolling family documents that it never takes a `nanPolicy` (a per-window `omit` would have an
 * ambiguous width), so accepting-and-ignoring one was exactly the Law-12 defect class.
 */
export const POPULATION_OPTIONS_SPEC = optionsSpec({
  population: 'boolean',
} as const satisfies Record<keyof PopulationOptions, OptionFieldKind>);

/**
 * Apply the NaN policy to a single series. Returns the data to compute on, or `null` under
 * `propagate` when a NaN is present — the caller then propagates (NaN scalar / all-NaN series).
 * Policies are already validated at the public boundary; this trusts its input.
 */
export function prepare(
  xs: ArrayLike<number>,
  policy: NanPolicy | undefined,
): ArrayLike<number> | null {
  if (policy === undefined || policy === 'propagate') {
    for (let i = 0; i < xs.length; i++) if (Number.isNaN(xs[i]!)) return null;
    return xs;
  }
  if (policy === 'omit') {
    const out: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const v = xs[i]!;
      if (!Number.isNaN(v)) out.push(v);
    }
    return out;
  }
  for (let i = 0; i < xs.length; i++) {
    if (Number.isNaN(xs[i]!)) {
      throw new InputError(`stats: input contains NaN at index ${i}.`, {
        code: ErrorCode.InputNaN,
        context: { index: i },
      });
    }
  }
  return xs;
}

/**
 * Apply the NaN policy to two aligned series (paired). Returns cleaned equal-length arrays, or `null`
 * under `propagate` when either series has a NaN. `omit` drops index i when EITHER value is NaN.
 */
export function preparePair(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  policy: NanPolicy | undefined,
): { xs: number[]; ys: number[] } | null {
  const n = xs.length;
  if (policy === 'omit') {
    const ax: number[] = [];
    const ay: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = xs[i]!;
      const b = ys[i]!;
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        ax.push(a);
        ay.push(b);
      }
    }
    return { xs: ax, ys: ay };
  }
  if (policy === 'throw') {
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(xs[i]!) || Number.isNaN(ys[i]!)) {
        throw new InputError(`stats: paired input contains NaN at index ${i}.`, {
          code: ErrorCode.InputNaN,
          context: { index: i },
        });
      }
    }
  } else {
    // propagate (or omitted)
    for (let i = 0; i < n; i++) if (Number.isNaN(xs[i]!) || Number.isNaN(ys[i]!)) return null;
  }
  const ax = new Array<number>(n);
  const ay = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    ax[i] = xs[i]!;
    ay[i] = ys[i]!;
  }
  return { xs: ax, ys: ay };
}

export function requireEqualLength(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  functionName: string,
): number {
  if (xs.length !== ys.length) {
    throw new InputError(
      `${functionName}: series must be equal length (${xs.length} vs ${ys.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { xLength: xs.length, yLength: ys.length },
      },
    );
  }
  return xs.length;
}

/** Kahan-compensated sum over clean data — minimizes rounding error over long series. */
export function kahanSum(data: ArrayLike<number>): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < data.length; i++) {
    const y = data[i]! - c;
    const t = s + y;
    c = t - s - y;
    s = t;
  }
  return s;
}

/** Kahan mean over clean, non-empty-checked data. */
export function meanOf(data: ArrayLike<number>): number {
  return kahanSum(data) / data.length;
}

/**
 * Covariance with options ALREADY validated by the public boundary. `functionName` labels the
 * equal-length error with the call the user actually made (`covariance` or `covarianceMatrix`).
 */
export function covarianceValidated(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options: VarianceOptions | undefined,
  functionName: string,
): number {
  requireEqualLength(xs, ys, functionName);
  const pair = preparePair(xs, ys, options?.nanPolicy);
  if (pair === null) return NaN;
  const n = pair.xs.length;
  const ddof = options?.population ? 0 : 1;
  if (n - ddof <= 0) return NaN;
  const mx = meanOf(pair.xs);
  const my = meanOf(pair.ys);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (pair.xs[i]! - mx) * (pair.ys[i]! - my);
  return acc / (n - ddof);
}
