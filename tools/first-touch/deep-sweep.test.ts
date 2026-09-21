/**
 * R3 — the deep sweep: everything the arg-0 garbage sweep is structurally blind to.
 *
 * For every callable with a happy-path fixture (`fixtures.ts`):
 *
 *   1. HAPPY  — the fixture call succeeds (every fixture doubles as a baked-in happy-path test);
 *   2. ARGS   — each argument position (not just the first) replaced with garbage → the call must
 *               throw a typed QuantError or return; ANY other throw (TypeError, RangeError, plain
 *               Error) fails. This is the "valid subject, garbage config" class: option.price with
 *               a missing market, walkForward without run, swaptionPrice without curves;
 *   3. PARTIAL— each top-level key of each object argument deleted one at a time → same law (the
 *               partial-but-plausible inputs real users type: ironButterfly without body);
 *   4. EXPLAIN— `.explain(...)` on the fixture returns a real Computed envelope (`isComputed`,
 *               WS-7.2), and a numeric NaN value must carry ≥1 diagnostics warning (design law #4:
 *               degenerate values only alongside explicit diagnostics).
 *
 * Coverage is a ratchet: every callable taking ≥2 args or carrying `.explain` needs a fixture or
 * an `unfixtured.ts` entry (shrink-only). Violations land in `deep-crashers.ts` (shrink-only).
 * Both ledgers' goal state is EMPTY and lock tests pin them there once burned.
 */

import { describe, expect, it } from 'vitest';
import { isComputed, isQuantError } from '@totalfinance/core';
import { allFixtures } from './fixtures.js';
import { expectedSweptPackages } from './sweep-roster.js';
import { DEEP_CRASHERS } from './deep-crashers.js';
import { UNFIXTURED } from './unfixtured.js';
import * as backtest from '@totalfinance/backtest';
import * as calendars from '@totalfinance/calendars';
import * as commodities from '@totalfinance/commodities';
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
import * as valuation from '@totalfinance/valuation';
import * as volatility from '@totalfinance/volatility';
import * as workflows from '@totalfinance/workflows';

const PACKAGES: Record<string, Record<string, unknown>> = {
  backtest: backtest as never,
  calendars: calendars as never,
  commodities: commodities as never,
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
  valuation: valuation as never,
  volatility: volatility as never,
  workflows: workflows as never,
};

const GARBAGE: Array<{ label: string; value: unknown }> = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'number', value: 42 },
  { label: 'string', value: 'garbage' },
  { label: 'empty array', value: [] },
  { label: 'empty object', value: {} },
  { label: 'NaN', value: NaN },
];

type AnyFn = (...callArguments: unknown[]) => unknown;

interface Callable {
  key: string;
  fn: AnyFn;
}

function isProbeworthy(name: string, value: unknown): value is AnyFn {
  return typeof value === 'function' && /^[a-z]/.test(name);
}

/** Enumerate the deduped public surface: top-level functions + one level of namespace objects. */
function enumerateSurface(): Callable[] {
  const seen = new Set<unknown>();
  const out: Callable[] = [];
  for (const [pkg, ns] of Object.entries(PACKAGES)) {
    for (const [name, value] of Object.entries(ns)) {
      if (isProbeworthy(name, value)) {
        if (!seen.has(value)) {
          seen.add(value);
          out.push({ key: `${pkg}.${name}`, fn: value });
        }
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (isProbeworthy(k, v) && !seen.has(v)) {
            seen.add(v);
            out.push({ key: `${pkg}.${name}.${k}`, fn: v as AnyFn });
          }
        }
      }
    }
  }
  return out;
}

const violations = new Map<string, string[]>();

function violate(key: string, detail: string): void {
  const list = violations.get(key) ?? [];
  if (list.length < 8) list.push(detail);
  violations.set(key, list);
}

async function lawfulCall(key: string, fn: AnyFn, args: unknown[], label: string): Promise<void> {
  try {
    const result = fn(...args);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      await (result as Promise<unknown>);
    }
  } catch (error) {
    if (!isQuantError(error)) {
      violate(
        key,
        `${label} threw non-QuantError ${(error as Error)?.name ?? typeof error}: ${String(
          (error as Error)?.message ?? error,
        )}`,
      );
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ArrayBuffer.isView(v))
    return false;
  // Class instances (bonds, curves, streams) are not key-deletable inputs — spreading one would
  // drop its prototype methods and probe a shape no caller can produce.
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Navigate a fixture key ('technical-analysis.rsi', 'options.blackScholes.call') to the live function it names. */
function resolveKey(key: string): AnyFn | undefined {
  const [pkg, ...path] = key.split('.');
  let cur: unknown = PACKAGES[pkg!];
  for (const part of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'function' ? (cur as AnyFn) : undefined;
}

describe('R3 deep sweep: later args, partial inputs, and envelopes obey the law', () => {
  const fixtures = allFixtures();
  const surface = enumerateSurface();
  const surfaceKeys = new Set(surface.map((c) => c.key));

  // Identity fallback: a fixture written for 'technical-analysis.stochastic' also covers every alias export of the
  // SAME function ('technical-analysis.stoch', 'technical-analysis.candlesticks.*' twins), whichever key the walker saw first.
  const byFn = new Map<AnyFn, () => unknown[]>();
  for (const [key, thunk] of fixtures) {
    const fn = resolveKey(key);
    if (fn && !byFn.has(fn)) byFn.set(fn, thunk);
  }
  const fixtureFor = (key: string, fn: AnyFn): (() => unknown[]) | undefined =>
    fixtures.get(key) ?? byFn.get(fn);

  it('the deep-crashers ratchet is EMPTY and stays that way', () => {
    expect(DEEP_CRASHERS.size).toBe(0);
  });

  it('the package roster covers every package that must be swept (no silent gap)', () => {
    // This roster is hand-typed because the namespaces must be statically imported — so it is
    // checked against the manifest tier map rather than trusted. `@totalfinance/crypto` was in the
    // garbage sweep's roster and missing from this one: a whole facade package with no
    // later-argument, partial-input, or envelope coverage, and nothing to say so.
    expect(Object.keys(PACKAGES).sort()).toEqual(expectedSweptPackages());
  });

  it('coverage: every multi-arg or explain-bearing callable is fixtured (or ledgered, shrink-only)', () => {
    const missing: string[] = [];
    for (const { key, fn } of surface) {
      const needs = fn.length >= 2 || typeof (fn as { explain?: unknown }).explain === 'function';
      if (!needs) continue;
      if (fixtureFor(key, fn) !== undefined) {
        expect(
          UNFIXTURED.has(key),
          `${key} has a fixture now — remove it from unfixtured.ts (the ledger only shrinks).`,
        ).toBe(false);
      } else if (!UNFIXTURED.has(key)) {
        missing.push(key);
      }
    }
    expect(
      missing,
      `unfixtured multi-arg/explain callables (add fixtures to fixtures.ts — or, only while burning down, list in unfixtured.ts):\n${missing.join('\n')}`,
    ).toEqual([]);
    // Stale ledger entries: listed but no longer on the surface (renamed/removed) must be delisted.
    for (const listed of UNFIXTURED) {
      expect(
        surfaceKeys.has(listed),
        `${listed} is in unfixtured.ts but no longer on the public surface — delist it.`,
      ).toBe(true);
    }
  });

  for (const { key, fn } of surface) {
    const thunk = fixtureFor(key, fn);
    if (!thunk) continue;

    it(key, async () => {
      // 1 — HAPPY: the fixture itself must work.
      let happyThrew: unknown;
      try {
        const r = fn(...thunk());
        if (
          r !== null &&
          (typeof r === 'object' || typeof r === 'function') &&
          typeof (r as { then?: unknown }).then === 'function'
        ) {
          await (r as Promise<unknown>);
        }
      } catch (e) {
        happyThrew = e;
      }
      if (happyThrew !== undefined) {
        violate(
          key,
          `HAPPY fixture call threw: ${String((happyThrew as Error)?.message ?? happyThrew)}`,
        );
      }

      const base = thunk();
      const maxPos = Math.min(4, Math.max(fn.length, base.length, 2));

      // 2 — ARGS: garbage at every position, valid fixture values in the others.
      for (let pos = 0; pos < maxPos; pos++) {
        for (const probe of GARBAGE) {
          const args = thunk();
          args[pos] = probe.value;
          await lawfulCall(key, fn, args, `args[${pos}]=${probe.label}`);
        }
      }

      // 3 — PARTIAL: delete each top-level key of each object argument.
      for (let pos = 0; pos < base.length; pos++) {
        if (!isPlainObject(base[pos])) continue;
        for (const k of Object.keys(base[pos] as Record<string, unknown>)) {
          // Deleting a function-valued member (a factory artifact's method) probes corruption no
          // caller can type — the instance guards cover that class; skip it here.
          if (typeof (base[pos] as Record<string, unknown>)[k] === 'function') continue;
          const args = thunk();
          const clone = { ...(args[pos] as Record<string, unknown>) };
          delete clone[k];
          args[pos] = clone;
          await lawfulCall(key, fn, args, `partial: missing '${k}' in args[${pos}]`);
        }
      }

      // 4 — EXPLAIN: envelope conformance (WS-7.2) + disclosed-NaN law.
      const explain = (fn as { explain?: AnyFn }).explain;
      if (typeof explain === 'function') {
        try {
          const env = explain(...thunk());
          if (!isComputed(env)) {
            violate(key, `.explain() did not return a Computed envelope (isComputed=false)`);
          } else if (
            typeof (env as { value?: unknown }).value === 'number' &&
            Number.isNaN((env as { value: number }).value) &&
            (env as { diagnostics: { warnings: unknown[] } }).diagnostics.warnings.length === 0
          ) {
            violate(key, `.explain() returned NaN with EMPTY warnings (undisclosed degenerate)`);
          }
        } catch (e) {
          if (!isQuantError(e)) {
            violate(
              key,
              `.explain(happy fixture) threw non-QuantError: ${String((e as Error)?.message ?? e)}`,
            );
          } else {
            violate(key, `.explain(happy fixture) threw ${String((e as Error)?.message ?? e)}`);
          }
        }
        for (const probe of GARBAGE) {
          const args = thunk();
          args[0] = probe.value;
          await lawfulCall(key, explain, args, `.explain args[0]=${probe.label}`);
        }
      }

      const details = violations.get(key) ?? [];
      const violated = details.length > 0;
      expect(
        violated && !DEEP_CRASHERS.has(key),
        `${key} violates the deep-sweep law:\n  ${details.join('\n  ')}\n(fix the boundary — never grow the ratchet)`,
      ).toBe(false);
      expect(
        !violated && DEEP_CRASHERS.has(key),
        `${key} no longer violates — remove it from deep-crashers.ts (the ratchet only shrinks).`,
      ).toBe(false);
    });
  }
});
