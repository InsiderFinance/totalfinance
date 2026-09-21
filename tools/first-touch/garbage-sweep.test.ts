/**
 * DX §7.1 — the auto-enumerated garbage sweep (the un-regressable first-touch law).
 *
 * Every callable export of every facade package, called with each of a fixed garbage-probe set,
 * must either return or throw a typed `QuantError` — ANY other throw (TypeError, RangeError, or a
 * codeless plain `Error`) escaping any public function fails this suite. This is the automated complement to the hand-curated
 * happy-path list in `first-touch.test.ts`: the hand list proves the good calls work; this sweep
 * proves the bad calls can't crash.
 *
 * Scope: the facade packages (shapes 1–4). `@totalfinance/math` and `@totalfinance/core` export trusted
 * mathematical utilities (shape 5) and are deliberately not runtime-swept; their declarations are
 * still governed by the signature manifest.
 * Namespaces (plain objects of functions, e.g. `bs`, `strategy`) are descended one level.
 *
 * A silent return on garbage is allowed HERE (targeted tests assert the throw-on-garbage law where
 * it is ratified, e.g. TA series validation); the sweep's single job is: no raw crashes, anywhere.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { KNOWN_CRASHERS } from './known-crashers.js';
import { expectedSweptPackages } from './sweep-roster.js';
import * as backtest from '@totalfinance/backtest';
import * as calendars from '@totalfinance/calendars';
import * as commodities from '@totalfinance/commodities';
import * as valuation from '@totalfinance/valuation';
import * as crypto from '@totalfinance/crypto';
import * as fixedIncome from '@totalfinance/fixed-income';
import * as foreignExchange from '@totalfinance/foreign-exchange';
import * as fundamentals from '@totalfinance/fundamentals';
import * as options from '@totalfinance/options';
import * as performance from '@totalfinance/performance';
import * as portfolio from '@totalfinance/portfolio';
import * as research from '@totalfinance/research';
import * as risk from '@totalfinance/risk';
import * as scenarios from '@totalfinance/scenarios';
import * as strategy from '@totalfinance/strategy';
import * as structure from '@totalfinance/structure';
import * as technicalAnalysis from '@totalfinance/technical-analysis';
import * as volatility from '@totalfinance/volatility';
import * as workflows from '@totalfinance/workflows';

const PACKAGES: Record<string, Record<string, unknown>> = {
  backtest: backtest as never,
  calendars: calendars as never,
  commodities: commodities as never,
  valuation: valuation as never,
  crypto: crypto as never,
  'fixed-income': fixedIncome as never,
  'foreign-exchange': foreignExchange as never,
  fundamentals: fundamentals as never,
  options: options as never,
  performance: performance as never,
  portfolio: portfolio as never,
  research: research as never,
  risk: risk as never,
  scenarios: scenarios as never,
  strategy: strategy as never,
  structure: structure as never,
  'technical-analysis': technicalAnalysis as never,
  volatility: volatility as never,
  workflows: workflows as never,
};

/** The probe set: the natural wrong first calls. */
const PROBES: Array<{ label: string; args: unknown[] }> = [
  { label: 'no args', args: [] },
  { label: 'undefined', args: [undefined] },
  { label: 'empty object', args: [{}] },
  { label: 'empty array', args: [[]] },
  { label: 'string', args: ['hello'] },
  { label: 'number', args: [42] },
  { label: 'short numeric array', args: [[1, 2, 3]] },
  { label: 'columnar object', args: [{ high: [], low: [], close: [] }] },
];

/**
 * Known trusted-tier callables reached through facade packages. Each entry needs a reason; keep this
 * list SHORT — facades and confusable financial scalar lists never belong here.
 */
const EXEMPT = new Set<string>([
  // (empty — every current facade passes; add `pkg.export` with a reason if a kernel leaks in)
]);

function isProbeworthy(
  name: string,
  value: unknown,
): value is (...callArguments: unknown[]) => unknown {
  if (typeof value !== 'function') return false;
  // Uppercase names are classes/constructors (probed via their factories) and schema objects.
  if (/^[A-Z]/.test(name)) return false;
  return true;
}

/**
 * Packages re-export whole namespaces of each other (ta.ta.*, risk.performance.*) — probe each
 * underlying function ONCE and memoize its verdict, but run the ratchet checks for EVERY key it is
 * reachable under, so stale alias entries can't linger in the ledger.
 */
const VERDICTS = new Map<unknown, boolean>();

async function assertTypedOrReturns(
  pkg: string,
  path: string,
  fn: (...a: unknown[]) => unknown,
): Promise<void> {
  const key = `${pkg}.${path}`;
  if (EXEMPT.has(key)) return;
  const memo = VERDICTS.get(fn);
  if (memo !== undefined) {
    expect(
      !memo && KNOWN_CRASHERS.has(key),
      `${key} no longer raw-crashes — remove it from known-crashers.ts (the ratchet only shrinks).`,
    ).toBe(false);
    return;
  }
  let rawCrashed = false;
  for (const probe of PROBES) {
    try {
      const result = fn(...probe.args);
      // Async facades (collectAsync, streamAsync consumers) must obey the same law on rejection —
      // and an unawaited rejection would leak as an unhandled error either way.
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        await (result as Promise<unknown>);
      }
    } catch (error) {
      // R3: the law is QuantError-or-return. A plain `new Error(...)` from a facade is as much a
      // violation as a TypeError — it has no stable code an agent or UI can dispatch on.
      const raw = !isQuantError(error);
      if (raw) rawCrashed = true;
      expect(
        raw && !KNOWN_CRASHERS.has(key),
        `${key}(${probe.label}) escaped a non-QuantError ${String((error as Error).name)}: ${String(
          (error as Error).message,
        )} — throw a typed error from the boundary (never add to the ratchet).`,
      ).toBe(false);
    }
  }
  VERDICTS.set(fn, rawCrashed);
  // The ratchet only shrinks: a listed path that no longer raw-crashes must be delisted.
  expect(
    !rawCrashed && KNOWN_CRASHERS.has(key),
    `${key} no longer raw-crashes — remove it from known-crashers.ts (the ratchet only shrinks).`,
  ).toBe(false);
}

describe('DX7.1 garbage sweep: no raw TypeError/RangeError escapes any facade', () => {
  it('the ratchet is EMPTY and stays that way (10/10 everywhere)', () => {
    expect(KNOWN_CRASHERS.size).toBe(0);
  });

  it('the package roster covers every package that must be swept (no silent gap)', () => {
    // Hand-typed (the namespaces are static imports) but not hand-TRUSTED: checked against the
    // manifest tier map, so a new package cannot ship without a runtime gate.
    expect(Object.keys(PACKAGES).sort()).toEqual(expectedSweptPackages());
  });

  for (const [pkg, ns] of Object.entries(PACKAGES)) {
    describe(pkg, () => {
      for (const [name, value] of Object.entries(ns)) {
        if (isProbeworthy(name, value)) {
          it(`${name}`, async () => {
            await assertTypedOrReturns(pkg, name, value);
            // .explain twins obey the same law (this is what caught the TA envelope gap).
            const explain = (value as { explain?: unknown }).explain;
            if (typeof explain === 'function') {
              await assertTypedOrReturns(pkg, `${name}.explain`, explain as never);
            }
          });
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          // Namespace objects (bs, legs, engines, bonds, …) AND uppercase instances/schemas
          // (NYSE, CBOE, *Schema): descend one level — calendar methods obey the same law.
          const members = Object.entries(value as Record<string, unknown>).filter(([k, v]) =>
            isProbeworthy(k, v),
          );
          if (members.length === 0) continue;
          it(`${name}.*`, async () => {
            for (const [k, v] of members) {
              await assertTypedOrReturns(pkg, `${name}.${k}`, v as never);
              const explain = (v as { explain?: unknown }).explain;
              if (typeof explain === 'function') {
                await assertTypedOrReturns(pkg, `${name}.${k}.explain`, explain as never);
              }
            }
          });
        }
      }
    });
  }
});

/**
 * R3 — subpath entrypoints obey the same law. The root sweep above covers `@totalfinance/x`; this
 * enumerates every `exports`-map subpath (`@totalfinance/options/schema`, `@totalfinance/technical-analysis/…`) from each
 * package.json — so a facade reachable ONLY through a subpath can never dodge the sweep. Verdicts
 * are memoized per function, so re-exported aliases cost nothing.
 */
const PKG_DIR = fileURLToPath(new URL('../../packages', import.meta.url));

function subpathSpecifiers(): string[] {
  const specs: string[] = [];
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let manifest: { name?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8')) as never;
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.exports) continue;
    // Same scope as the root sweep: @totalfinance/core and @totalfinance/math are the documented
    // trusted mathematical tier (shape 5) and are deliberately not runtime-swept.
    if (manifest.name === '@totalfinance/core' || manifest.name === '@totalfinance/math') continue;
    for (const k of Object.keys(manifest.exports)) {
      if (k === '.' || k === './package.json') continue;
      const specification = `${manifest.name}/${k.slice(2)}`;
      // The umbrella's core/math subpaths are pure re-exports of that same trusted tier —
      // the exemption follows the MODULE, not the specifier it is reached through.
      if (specification === 'totalfinance/core' || specification === 'totalfinance/math') continue;
      specs.push(specification);
    }
  }
  return specs;
}

describe('DX7.1 garbage sweep: subpath entrypoints', () => {
  for (const specification of subpathSpecifiers()) {
    it(
      specification,
      async () => {
        const mod = (await import(/* @vite-ignore */ specification)) as Record<string, unknown>;
        for (const [name, value] of Object.entries(mod)) {
          if (isProbeworthy(name, value)) {
            await assertTypedOrReturns(specification, name, value);
            const explain = (value as { explain?: unknown }).explain;
            if (typeof explain === 'function') {
              await assertTypedOrReturns(specification, `${name}.explain`, explain as never);
            }
          } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              if (!isProbeworthy(k, v)) continue;
              await assertTypedOrReturns(specification, `${name}.${k}`, v as never);
              const explain = (v as { explain?: unknown }).explain;
              if (typeof explain === 'function') {
                await assertTypedOrReturns(specification, `${name}.${k}.explain`, explain as never);
              }
            }
          }
        }
      },
      30_000,
    );
  }
});
