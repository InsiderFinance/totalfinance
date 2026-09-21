/**
 * Law 12 sweep v3 — object-input strictness follows the manifest's PER-ARGUMENT policy and is
 * probed separately on plain and `.explain()` surfaces.
 *
 * Every fixtured export's every plain-object argument is re-sent with one bogus key
 * (`qzxBogusKey`). Accepting it means a caller's typo silently changes semantics — the exact bug
 * class Law 12 kills. Probe keys are `domain:name[#explain]#argIndex`.
 *
 * Closed config/DTO arguments must throw the precise typed unknown-field error. Open structural
 * artifacts (calendars, contracts, curves, plugin handles, result records) must accept harmless
 * metadata decoration. Passthrough adapters own their foreign schema and are skipped here.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { allFixtures } from './fixtures.js';
import { packageEntrypoints } from '../manifest/inventory.js';
import { readManifest } from '../manifest/generate.js';

interface Probe {
  key: string;
  target: (...a: unknown[]) => unknown;
  args: () => unknown[];
  argIndex: number;
  policy: 'closed' | 'open';
}

function defaultPolicy(_role: string): 'closed' {
  return 'closed';
}

const fixtures = allFixtures();
const probes: Probe[] = [];
for (const pkg of packageEntrypoints()) {
  const manifest = readManifest(pkg.dir);
  if (!manifest || manifest.tier !== 'facade') continue;
  const mod = (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>;
  for (const [name, entry] of Object.entries(manifest.exports)) {
    if (entry.kind !== 'function') continue;
    if (!['facade', 'analysis', 'artifact', 'helper'].includes(entry.role)) continue;
    if (entry.passthrough === true) continue;
    const fixture = fixtures.get(`${pkg.dir}.${name}`);
    if (!fixture) continue;
    const fn = name
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mod);
    if (typeof fn !== 'function') continue;
    const surfaces: [string, (...a: unknown[]) => unknown][] = [
      [`${pkg.dir}:${name}`, fn as never],
    ];
    const explain = (fn as { explain?: unknown }).explain;
    if (typeof explain === 'function') {
      surfaces.push([`${pkg.dir}:${name}#explain`, explain as never]);
    }
    for (const [label, target] of surfaces) {
      const sample = fixture() as unknown[];
      for (let i = 0; i < sample.length; i++) {
        const a = sample[i];
        if (a === null || typeof a !== 'object' || Array.isArray(a)) continue;
        if (Object.getPrototypeOf(a) !== Object.prototype) continue;
        const policy = entry.inputPolicies?.[String(i)] ?? defaultPolicy(entry.role);
        if (policy === 'passthrough') continue;
        probes.push({
          key: `${label}#${i}`,
          target,
          args: fixture as () => unknown[],
          argIndex: i,
          policy,
        });
      }
    }
  }
}

describe('Law 12 v3: manifest-driven per-argument unknown-key policy', () => {
  it('covers a substantial per-argument probe population', () => {
    expect(probes.length).toBeGreaterThan(700);
  });

  it('closed inputs reject with InputUnknownField; open artifacts accept decoration', () => {
    const violations: string[] = [];
    for (const { key, target, args, argIndex, policy } of probes) {
      let error: unknown;
      try {
        const mutated = [...args()];
        mutated[argIndex] = { ...(mutated[argIndex] as object), qzxBogusKey: 1 };
        target(...mutated);
      } catch (caught) {
        error = caught;
      }

      if (policy === 'open') {
        if (error !== undefined) {
          violations.push(
            `${key}: open artifact rejected decoration with ${(error as Error).message}`,
          );
        }
        continue;
      }

      if (error === undefined) {
        violations.push(`${key}: closed config accepted qzxBogusKey`);
      } else if (!isQuantError(error, ErrorCode.InputUnknownField)) {
        violations.push(
          `${key}: closed config threw ${(error as { code?: string }).code ?? (error as Error).name}, expected ${ErrorCode.InputUnknownField}`,
        );
      } else if (error.context?.['key'] !== 'qzxBogusKey') {
        violations.push(`${key}: typed error did not identify qzxBogusKey in context.key`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  }, 120_000);
});
