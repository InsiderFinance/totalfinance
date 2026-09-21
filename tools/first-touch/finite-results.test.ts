/**
 * Spec P2.1 / Law 7 (tightened in E3) — SYSTEMATIC finite-result postconditions, driven by the
 * manifest (the spine): successful facade and analysis results are JSON-safe and contain NO
 * non-finite numbers. **Warnings never license a non-finite value** — an undefined quantity is
 * `null` and the warning explains the null. The ONLY ratified exceptions are structural sentinels:
 *
 *   - a series envelope's `diagnostics.warmup > 0` licenses EXACTLY the first `warmup` slots
 *     (the documented "not yet formed" aligned-series contract) — slots past the prefix are judged;
 *   - discriminated `direction: 0` zone elements and `code: 0` divergence elements (the documented
 *     NaN-when-none contracts). Undeclared leading NaNs are violations just like mid-series NaNs.
 *
 * For every manifest export with role `facade` or `analysis` that has a happy-path fixture, this
 * sweep calls the function (and its `.explain` twin when present) and DEEP-WALKS the entire
 * result — full depth, no output cap, cycle-safe.
 *
 * `JSON.stringify` silently turns NaN/±Infinity into `null` — a non-finite is data corruption
 * waiting for the first serialization boundary. That is why this is a LAW, not a lint.
 */

import { describe, expect, it } from 'vitest';
import { allFixtures } from './fixtures.js';
import { packageEntrypoints } from '../manifest/inventory.js';
import { readManifest } from '../manifest/generate.js';

/**
 * SHRINK-ONLY: `domain.name(.explain)` results that still carry a non-finite number at their
 * fixture point. Fix the function (null-with-reason); never extend.
 */
const UNDISCLOSED_LEDGER = new Set<string>([]);

interface Located {
  key: string;
  fn: (...callArguments: unknown[]) => unknown;
  fixture: () => unknown[];
}

function isEnvelope(v: unknown): v is {
  value: unknown;
  diagnostics?: { warmup?: number };
} {
  return (
    v !== null &&
    typeof v === 'object' &&
    'value' in (v as Record<string, unknown>) &&
    'diagnostics' in (v as Record<string, unknown>)
  );
}

/** Collect dotted paths of every non-finite number in a value tree (cycle-safe, full depth). */
function nonFinitePaths(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) out.push(path || '(root)');
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      // Report a single representative index per array to keep failures readable.
      for (let i = 0; i < v.length; i++) {
        const before = out.length;
        walk(v[i], `${path}[${i}]`);
        if (out.length > before) return;
      }
      return;
    }
    for (const [k, val] of Object.entries(v)) walk(val, path ? `${path}.${k}` : k);
  };
  walk(root, '');
  return out;
}

/**
 * The zone-indicator convention (`ZonePoint` et al.): `direction: 0` is the self-describing
 * "no zone on this bar" discriminant, and its numeric zone fields are DOCUMENTED as NaN-when-none.
 * These interleave with real zones by design — a discriminated sentinel is a disclosure, not a
 * leak — so drop them anywhere in the array. Plain NUMBER NaNs mid-series stay violations.
 */
function dropDiscriminatedSentinels(arr: unknown[]): unknown[] {
  return arr.filter((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return true;
    const disc = v as { direction?: unknown; code?: unknown };
    // Zone points (`direction: 0`) and divergence points (`code: 0`, anchored on `priceSwings`).
    return !(disc.direction === 0 || (disc.code === 0 && 'priceSwings' in v));
  });
}

const fixtures = allFixtures();
const targets: Located[] = [];
const roots = new Map<string, Record<string, unknown>>();
for (const pkg of packageEntrypoints()) {
  const manifest = readManifest(pkg.dir);
  if (!manifest || manifest.tier !== 'facade') continue;
  const mod = (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>;
  roots.set(pkg.dir, mod);
  for (const [name, entry] of Object.entries(manifest.exports)) {
    if (entry.kind !== 'function') continue;
    if (entry.role !== 'facade' && entry.role !== 'analysis') continue;
    const key = `${pkg.dir}.${name}`;
    const fixture = fixtures.get(key);
    if (!fixture) continue; // fixture completeness is the manifest gate's job, not this sweep's
    const fn = name
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mod);
    if (typeof fn !== 'function') continue;
    targets.push({ key, fn: fn as never, fixture: fixture as never });
  }
}

describe('P2.1 finite-result postconditions (facade + analysis, manifest-driven)', () => {
  it('found a substantial sweep population (the manifest is wired)', () => {
    expect(targets.length).toBeGreaterThan(150);
  });

  it('every fixtured facade/analysis result is finite (nulls, not NaN — warnings never license)', () => {
    const violations: string[] = [];
    const staleLedger = new Set(UNDISCLOSED_LEDGER);
    for (const { key, fn, fixture } of targets) {
      let plain: unknown;
      let explain: unknown;
      let explainErr = false;
      let explainError: unknown;
      try {
        plain = fn(...fixture());
      } catch {
        continue; // fixture validity is deep-sweep territory; this sweep judges SUCCESSFUL results
      }
      const explainFn = (fn as { explain?: (...a: unknown[]) => unknown }).explain;
      if (typeof explainFn === 'function') {
        try {
          explain = explainFn(...fixture());
        } catch (caught) {
          explainErr = true;
          explainError = caught;
        }
      }

      const domain = key.split('.')[0]!;
      const declaredWarmup =
        isEnvelope(explain) && typeof explain.diagnostics?.warmup === 'number'
          ? explain.diagnostics.warmup
          : 0;
      const judge = (label: string, result: unknown): void => {
        let judged = result;
        // Warmup licenses EXACTLY the declared leading prefix of an array value — nothing else.
        if (
          isEnvelope(judged) &&
          (Array.isArray(judged.value) || ArrayBuffer.isView(judged.value))
        ) {
          const warmup = judged.diagnostics?.warmup;
          if (typeof warmup === 'number' && warmup > 0) {
            judged = {
              ...judged,
              value: Array.from(judged.value as ArrayLike<unknown>).slice(warmup),
            };
          }
        } else if ((Array.isArray(judged) || ArrayBuffer.isView(judged)) && declaredWarmup > 0) {
          // A PLAIN aligned-series result carries no diagnostics of its own — its `.explain` twin's
          // DECLARED warmup covers the same leading prefix (structural metadata, not a warning).
          judged = Array.from(judged as ArrayLike<unknown>).slice(declaredWarmup);
        }
        // TA outputs may carry explicitly discriminated "none" elements anywhere in the array.
        // There is deliberately no heuristic leading-prefix stripping: warmup must be declared.
        if (domain === 'technical-analysis') {
          const clean = (a: unknown[]): unknown[] => dropDiscriminatedSentinels(a);
          if (Array.isArray(judged)) judged = clean(judged);
          else if (isEnvelope(judged) && Array.isArray(judged.value)) {
            judged = { ...judged, value: clean(judged.value) };
          }
        }
        const paths = nonFinitePaths(judged);
        if (paths.length === 0) return;
        if (UNDISCLOSED_LEDGER.has(label)) {
          staleLedger.delete(label);
          return;
        }
        violations.push(`${label}: non-finite at ${paths[0]!}`);
      };

      judge(key, plain);
      if (explainErr) {
        const detail =
          explainError instanceof Error
            ? `${explainError.name}: ${explainError.message}`
            : String(explainError);
        violations.push(`${key}.explain: threw after the plain surface succeeded (${detail})`);
      } else if (explain !== undefined) {
        judge(`${key}.explain`, explain);
      }
    }
    for (const stale of staleLedger) violations.push(`${stale}: stale finite-result ledger entry`);
    expect(
      violations,
      `results with NaN/Infinity (report undefined quantities as null-with-reason):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
