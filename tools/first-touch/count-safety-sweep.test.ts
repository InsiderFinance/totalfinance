/**
 * The COUNT-SAFETY mutant (2026-08-23 review wave, P0 "integer/count validation can permit
 * effectively infinite work") — the adversarial gate for exactly the coordinates the overflow
 * mutant (`overflow-sweep.test.ts`) deliberately SKIPS.
 *
 * The overflow mutant scales magnitudes and delegates resource coordinates to this gate. The
 * hole that left open: `Number.isInteger(1e308)` is `true`, so a validator written as
 * `Number.isInteger(count) && count >= 1` accepts a request for effectively infinite synchronous
 * work — and above 2^53, where `counter++` stops changing, a literally NON-TERMINATING loop.
 *
 * The law: setting any resource coordinate to the common `2^32` ceiling or an unsafe/absurd value
 * — `2^53` (the first unsafe
 * integer), `2^53 + 2` (unsafe but still `Number.isInteger`-true), `1e308`, `−2^53`, and `2.5`
 * (a non-integer, the refusal every site already owed) — must throw a TYPED TotalFinance teaching
 * error. Never succeed, never a raw JavaScript error, never hang.
 *
 * COORDINATE SELECTION: a shared path-aware policy avoids bare-token over-matches — `count` inside
 * `accountsReceivable`/`accountsPayable` (monetary amounts) and `discountFactor`/`annualDiscountRate`
 * (rates), `index` matches `indexValue` (a NAV level), and `peryear` matches `periodsPerYear`
 * (a deliberately-fractional annualization convention: `resolvePeriodsPerYear` accepts any
 * positive finite number). Demanding a typed refusal for `accountsReceivable: 2.5` would be
 * asserting nonsense. The declaration inventory also restores names for positional scalars (a
 * fixture containing only `args[1] = 20` cannot otherwise reveal that the parameter is `window`).
 *
 * FOURTH review (2026-08-23): the gate went LIBRARY-WIDE — every facade-tier package, not just
 * the six Stage-4 dirs; aliases feed by function identity like the overflow mutant; an unfed
 * governed head FAILS the gate instead of warning; zero-valued count coordinates mutate too
 * (the magnitude walker skips zeros because scaling 0 is a no-op — a count of 0 replaced by 2^53
 * is not); and the branch-variant fixtures feed every discriminated arm.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { allFixtures } from './fixtures.js';
import { isResourceCoordinate, RESOURCE_SAFETY_CEILING } from './count-semantics.js';
import { VARIANT_FIXTURES } from './overflow-variants.js';
import {
  allDeclaredNumericCoordinates,
  declaredNumericCoordinateKey,
  declaredNumericCoordinatesForHead,
} from './declaration-coordinates.js';
import { RESOURCE_METHOD_TARGETS } from './resource-method-targets.js';
import {
  RESOURCE_CONSTRUCTOR_TARGET_ERRORS,
  RESOURCE_CONSTRUCTOR_TARGETS,
} from './resource-constructor-targets.js';
import {
  RESOURCE_ATTACHED_TARGET_ERRORS,
  RESOURCE_ATTACHED_TARGETS,
} from './resource-attached-targets.js';
import { packageEntrypoints } from '../manifest/inventory.js';
import { readManifest } from '../manifest/generate.js';

/**
 * The six adversarial resource values. Every one must be REFUSED with a typed error: 2^32 is the
 * library-wide outer safety ceiling; 2^53 and 2^53 + 2 pass `Number.isInteger` but not
 * `Number.isSafeInteger`; 1e308
 * passes `Number.isInteger` and is a request for effectively infinite work; −2^53 is the negative
 * twin; 2.5 is the plain non-integer every count validator already owed a refusal.
 */
const UNSAFE_COUNTS: readonly number[] = [
  RESOURCE_SAFETY_CEILING,
  2 ** 53,
  2 ** 53 + 2,
  1e308,
  -(2 ** 53),
  2.5,
];

/**
 * Heads with a KNOWN-unsafe count site in a file another 2026-08-23 wave agent owns, keyed by
 * sweep path with the offending file named. These heads are SKIPPED — not run-and-expected-to-fail
 * — because an unfixed count site may be literally non-terminating (that is this defect class),
 * so calling it would hang the suite rather than redden it. SHRINK-ONLY: delete each entry as its
 * owner's fix lands; empty is the goal state, enforced at harvest when the orchestrator re-runs
 * this gate over the full fixture population.
 */
const KNOWN_UNSAFE_PENDING_HARVEST = new Map<string, string>([
  // Emptied at harvest 2026-08-23: `valuation.equivalentAnnualAnnuity` (projectLifeYears) was the
  // one entry; it is now safe-integer + 100,000-capped and fixtured, and this gate runs it.
]);

interface Coordinate {
  path: (string | number)[];
  key: string;
}

/** Every numeric-leaf coordinate of an argument list, with the object key that names it. */
function numericCoordinates(root: unknown): Coordinate[] {
  const out: Coordinate[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: (string | number)[], key: string): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ path: [...path], key });
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map || value instanceof Set) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        walk(value[index], [...path, index], key);
      }
      return;
    }
    for (const [memberKey, member] of Object.entries(value)) {
      walk(member, [...path, memberKey], memberKey);
    }
  };
  walk(root, [], '');
  return out;
}

/** A deep structural clone with ONE coordinate transformed. */
function withCoordinate(
  root: unknown,
  coordinate: Coordinate,
  transform: (value: number) => number,
): unknown {
  const clone = (value: unknown, depth: number): unknown => {
    if (depth === coordinate.path.length) return transform(value as number);
    const step = coordinate.path[depth]!;
    if (Array.isArray(value)) {
      const copy = value.slice();
      copy[step as number] = clone(value[step as number], depth + 1);
      return copy;
    }
    const record = value as Record<string, unknown>;
    return { ...record, [step]: clone(record[step as string], depth + 1) };
  };
  return clone(root, 0);
}

const fixtures = allFixtures();

interface Target {
  key: string;
  /** Declaration head. Variants retain the base callable's contract. */
  baseKey: string;
  fn: (...callArguments: unknown[]) => unknown;
  fixture: () => unknown[];
}
const targets: Target[] = [];
/** Governed heads with no fixture under their own key nor any same-function alias — gate FAILS. */
const unfed: string[] = [];
{
  const governed: { key: string; fn: (...callArguments: unknown[]) => unknown }[] = [];
  for (const pkg of packageEntrypoints()) {
    const manifest = readManifest(pkg.dir);
    if (!manifest) continue;
    const mod = (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>;
    const entrypointModules = new Map<string, Record<string, unknown>>([['.', mod]]);
    for (const [name, entry] of Object.entries(manifest.exports)) {
      if (entry.kind !== 'function') continue;
      // The same facade answer population as the overflow mutant, PLUS any function in ANY package
      // tier whose declaration owns a resource coordinate. C20 forbids reviving the old core/math
      // tier exemption: retaining positional scalar contracts does not exempt their loop/allocation
      // budgets from exact safety evidence.
      const ratifiedPlain =
        entry.role === 'helper' && (entry.note ?? '').includes('ratified plain');
      const resourceBearing = declaredNumericCoordinatesForHead(`${pkg.dir}.${name}`).some(
        (coordinate) => isResourceCoordinate(coordinate),
      );
      if (
        !resourceBearing &&
        (manifest.tier !== 'facade' ||
          (entry.role !== 'facade' &&
            entry.role !== 'analysis' &&
            entry.role !== 'artifact' &&
            !ratifiedPlain))
      ) {
        continue;
      }
      let fn: unknown;
      for (const entrypoint of entry.entrypoints) {
        let entrypointModule = entrypointModules.get(entrypoint);
        if (entrypointModule === undefined) {
          const specifier = `${pkg.package}/${entrypoint.slice(2)}`;
          entrypointModule = (await import(/* @vite-ignore */ specifier)) as Record<
            string,
            unknown
          >;
          entrypointModules.set(entrypoint, entrypointModule);
        }
        fn = name
          .split('.')
          .reduce<unknown>(
            (owner, member) => (owner as Record<string, unknown> | undefined)?.[member],
            entrypointModule,
          );
        if (typeof fn === 'function') break;
      }
      if (typeof fn !== 'function') continue;
      governed.push({ key: `${pkg.dir}.${name}`, fn: fn as never });
    }
  }
  const fixtureByIdentity = new Map<unknown, () => unknown[]>();
  for (const { key, fn } of governed) {
    const fixture = fixtures.get(key);
    if (fixture && !fixtureByIdentity.has(fn)) fixtureByIdentity.set(fn, fixture as never);
  }
  for (const { key, fn } of governed) {
    const fixture =
      (fixtures.get(key) as (() => unknown[]) | undefined) ?? fixtureByIdentity.get(fn);
    if (!fixture) {
      unfed.push(key);
      continue;
    }
    targets.push({ key, baseKey: key, fn, fixture });
  }
  const byKey = new Map(targets.map((target) => [target.key, target]));
  for (const [variantKey, fixture] of Object.entries(VARIANT_FIXTURES)) {
    const head = byKey.get(variantKey.split('#')[0]!);
    if (!head) {
      unfed.push(`${variantKey} (variant of ungoverned or unfed head)`);
      continue;
    }
    targets.push({
      key: variantKey,
      baseKey: head.baseKey,
      fn: head.fn,
      fixture: fixture as () => unknown[],
    });
  }
}

const configuredResourceFunctionHeads = new Set(
  targets
    .filter((target) =>
      declaredNumericCoordinatesForHead(target.baseKey).some((coordinate) =>
        isResourceCoordinate(coordinate),
      ),
    )
    .map((target) => target.baseKey),
);

for (const target of RESOURCE_METHOD_TARGETS) {
  targets.push({ ...target, baseKey: target.key });
}
for (const target of RESOURCE_CONSTRUCTOR_TARGETS) {
  targets.push({ ...target, baseKey: target.key });
}
for (const target of RESOURCE_ATTACHED_TARGETS) {
  targets.push({ ...target, baseKey: target.key });
}

/** Keep argument positions exact; canonicalize only arbitrary array positions below them. */
function pathIdentity(path: readonly (string | number)[]): string {
  return path
    .map((step, index) => (typeof step === 'number' && index > 0 ? '[]' : String(step)))
    .join('.');
}

const resourceIdentity = (head: string, path: readonly (string | number)[]): string =>
  `${head}|${pathIdentity(path)}`;

function expectedResourceIdentities(head: string): string[] {
  return declaredNumericCoordinatesForHead(head)
    .filter((coordinate) => isResourceCoordinate(coordinate))
    .map((coordinate) => resourceIdentity(head, coordinate.path));
}

function fixtureResourceCoordinates(target: Target): Coordinate[] {
  return numericCoordinates(target.fixture())
    .map((coordinate) => ({
      ...coordinate,
      key: declaredNumericCoordinateKey(target.baseKey, coordinate.path) ?? coordinate.key,
    }))
    .filter((coordinate) =>
      isResourceCoordinate({
        head: target.baseKey,
        path: coordinate.path,
        key: coordinate.key,
      }),
    );
}

const expectedResources = new Set(
  targets.flatMap((target) => expectedResourceIdentities(target.baseKey)),
);
const materializedResources = new Set(
  targets.flatMap((target) =>
    fixtureResourceCoordinates(target).map((coordinate) =>
      resourceIdentity(target.baseKey, coordinate.path),
    ),
  ),
);

const declaredResourceMethodHeads = new Set(
  allDeclaredNumericCoordinates()
    .filter((coordinate) => coordinate.head.includes('#') && isResourceCoordinate(coordinate))
    .map((coordinate) => coordinate.head),
);
const configuredResourceMethodHeads = new Set(RESOURCE_METHOD_TARGETS.map(({ key }) => key));
const declaredResourceConstructorHeads = new Set(
  allDeclaredNumericCoordinates()
    .filter(
      (coordinate) => coordinate.head.endsWith('.constructor') && isResourceCoordinate(coordinate),
    )
    .map((coordinate) => coordinate.head),
);
const configuredResourceConstructorHeads = new Set(
  RESOURCE_CONSTRUCTOR_TARGETS.map(({ key }) => key),
);
const declaredResourceAttachedHeads = new Set(
  allDeclaredNumericCoordinates()
    .filter(
      (coordinate) =>
        (coordinate.head.endsWith('.explain') || coordinate.head.endsWith('.stream')) &&
        isResourceCoordinate(coordinate),
    )
    .map((coordinate) => coordinate.head),
);
const configuredResourceAttachedHeads = new Set(RESOURCE_ATTACHED_TARGETS.map(({ key }) => key));
const declaredResourceFunctionHeads = new Set(
  allDeclaredNumericCoordinates()
    .filter(
      (coordinate) =>
        !coordinate.head.includes('#') &&
        !coordinate.head.endsWith('.constructor') &&
        !coordinate.head.endsWith('.explain') &&
        !coordinate.head.endsWith('.stream') &&
        isResourceCoordinate(coordinate),
    )
    .map((coordinate) => coordinate.head),
);

describe('count-safety mutant (unsafe/absurd counts must be typed refusals — never work, never a hang)', () => {
  it('feeds every governed facade-package function and every resource-bearing receiver method', () => {
    expect(
      [...unfed].sort(),
      'governed heads with no fixture and no same-function alias fixture — add fixtures',
    ).toEqual([]);
    expect(targets.length).toBeGreaterThan(900);
    expect(
      [...declaredResourceFunctionHeads]
        .filter((head) => !configuredResourceFunctionHeads.has(head))
        .sort(),
      'resource-bearing public functions without executable targets',
    ).toEqual([]);
    expect(
      [...configuredResourceFunctionHeads]
        .filter((head) => !declaredResourceFunctionHeads.has(head))
        .sort(),
      'stale function targets whose declaration no longer owns a resource coordinate',
    ).toEqual([]);
    expect(
      [...declaredResourceMethodHeads]
        .filter((head) => !configuredResourceMethodHeads.has(head))
        .sort(),
      'resource-bearing public methods without executable targets',
    ).toEqual([]);
    expect(
      [...configuredResourceMethodHeads]
        .filter((head) => !declaredResourceMethodHeads.has(head))
        .sort(),
      'stale method targets whose declaration no longer owns a resource coordinate',
    ).toEqual([]);
    expect(
      RESOURCE_CONSTRUCTOR_TARGET_ERRORS,
      'resource-bearing constructors without a valid synthesized baseline',
    ).toEqual([]);
    expect(
      [...declaredResourceConstructorHeads]
        .filter((head) => !configuredResourceConstructorHeads.has(head))
        .sort(),
      'resource-bearing public constructors without executable targets',
    ).toEqual([]);
    expect(
      [...configuredResourceConstructorHeads]
        .filter((head) => !declaredResourceConstructorHeads.has(head))
        .sort(),
      'stale constructor targets whose declaration no longer owns a resource coordinate',
    ).toEqual([]);
    expect(
      RESOURCE_ATTACHED_TARGET_ERRORS,
      'resource-bearing attached callables without a valid synthesized baseline',
    ).toEqual([]);
    expect(
      [...declaredResourceAttachedHeads]
        .filter((head) => !configuredResourceAttachedHeads.has(head))
        .sort(),
      'resource-bearing attached callables without executable targets',
    ).toEqual([]);
    expect(
      [...configuredResourceAttachedHeads]
        .filter((head) => !declaredResourceAttachedHeads.has(head))
        .sort(),
      'stale attached-callable targets whose declaration no longer owns a resource coordinate',
    ).toEqual([]);
  });

  it('materializes every declared resource coordinate in a canonical or branch fixture — exactly', () => {
    expect(
      [...expectedResources].filter((coordinate) => !materializedResources.has(coordinate)).sort(),
      'declared resource coordinates absent from every executable fixture',
    ).toEqual([]);
    expect(
      [...materializedResources].filter((coordinate) => !expectedResources.has(coordinate)).sort(),
      'fixture resource coordinates absent from the declaration inventory',
    ).toEqual([]);
    expect(expectedResources.size).toBeGreaterThan(350);
  });

  it('starts every resource-coordinate mutation from a successful baseline call', () => {
    const rejectedBaselines: string[] = [];
    for (const target of targets) {
      if (fixtureResourceCoordinates(target).length === 0) continue;
      try {
        target.fn(...target.fixture());
      } catch (error) {
        rejectedBaselines.push(
          `${target.key}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
      }
    }
    expect(
      rejectedBaselines.sort(),
      'a refusal from an already-invalid fixture is not evidence that the resource mutation was rejected',
    ).toEqual([]);
  });

  it('every resource coordinate refuses 2^32, unsafe integers, 1e308, negative, and fractional budgets with a typed error', () => {
    const violations = new Set<string>();
    // Stale = a ledger entry naming a FIXTURED head that carries no count coordinate (nothing to
    // protect) or a head not in the population at all. An entry for a still-unfixtured head is
    // NOT stale — it exists precisely to keep the harvest re-run from hanging.
    const staleLedger = new Set(KNOWN_UNSAFE_PENDING_HARVEST.keys());
    const mutatedResources = new Set<string>();
    for (const target of targets) {
      const { key, baseKey, fn, fixture } = target;
      // One representative per declaration coordinate: array indices below the argument are the
      // same contract (`periods[]`). Mutating every element adds runtime and duplicate evidence,
      // not coverage.
      const seenCoordinates = new Set<string>();
      const coordinates = fixtureResourceCoordinates(target).filter((coordinate) => {
        const identity = resourceIdentity(baseKey, coordinate.path);
        if (seenCoordinates.has(identity)) return false;
        seenCoordinates.add(identity);
        return true;
      });
      if (coordinates.length === 0) continue;
      if (KNOWN_UNSAFE_PENDING_HARVEST.has(key)) {
        // Skipped, not expected-to-fail: an unfixed count site may be non-terminating.
        staleLedger.delete(key);
        console.warn(
          `count-safety-sweep: SKIPPING known-unsafe head pending harvest — ${key}: ${KNOWN_UNSAFE_PENDING_HARVEST.get(key)!}`,
        );
        continue;
      }
      for (const coordinate of coordinates) {
        mutatedResources.add(resourceIdentity(baseKey, coordinate.path));
        for (const unsafeCount of UNSAFE_COUNTS) {
          let outcome: 'refused' | 'succeeded' | 'raw' = 'refused';
          let rawName = '';
          try {
            fn(...(withCoordinate(fixture(), coordinate, () => unsafeCount) as unknown[]));
            outcome = 'succeeded';
          } catch (error) {
            if (!isQuantError(error)) {
              outcome = 'raw';
              rawName = ((error as Error)?.constructor?.name ?? 'error').slice(0, 30);
            }
          }
          if (outcome !== 'refused') {
            violations.add(
              outcome === 'succeeded'
                ? `${key}: SUCCEEDED with count coordinate ${coordinate.path.join('.')} = ${unsafeCount} (an unsafe/absurd count must be a typed refusal)`
                : `${key}: RAW ${rawName} (not a typed teaching refusal) at ${coordinate.path.join('.')} = ${unsafeCount}`,
            );
          }
        }
      }
    }
    expect(
      [...expectedResources].filter((coordinate) => !mutatedResources.has(coordinate)).sort(),
      'declared resource coordinates that the mutation loop did not execute',
    ).toEqual([]);
    expect(
      [...mutatedResources].some((coordinate) =>
        coordinate.startsWith('valuation.probabilisticDiscountedCashFlow|'),
      ),
      'the sampleCount canary left the population — re-point the gate before trusting it',
    ).toBe(true);
    const sorted = [...violations].sort();
    expect(sorted.slice(0, 80), sorted.slice(0, 80).join('\n')).toEqual([]);
    expect(
      [...staleLedger].sort(),
      'KNOWN_UNSAFE_PENDING_HARVEST entries whose head is no longer in the population — delete them (shrink-only)',
    ).toEqual([]);
  }, 600_000);
});
