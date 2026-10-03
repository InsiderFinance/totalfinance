import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exposure, type ExposureMetric } from '@totalfinance/structure';
import type { ExposureInput } from '@totalfinance/structure/exposure';
import inputs from './golden/exposure-0.1.0.inputs.json';

/**
 * RELEASED-BEHAVIOR PARITY (selective Greeks and exposure spec, decision 11).
 *
 * The expected results were captured from the PUBLISHED `@insiderfinance/totalfinance@0.1.0`
 * package by `tools/golden/capture-exposure-baseline.mjs` — not from this repository's code — so
 * this test compares the current implementation with what released consumers actually received.
 * Omitting `metrics` must reproduce every value, field, key order, assumption and diagnostic
 * exactly (`toStrictEqual` on doubles is exact equality), through every analysis the profile offers.
 *
 * Exact against the SAME platform. V8's transcendental functions (Math.exp, log, pow, …) differ in
 * the last bit between its darwin-arm64, linux-arm64 and x64 builds, so 0.1.0 itself returns a few
 * different last bits on each (at most 8 values here, under 4e-16 relative). One golden per
 * platform keeps the comparison exact everywhere: `exposure-0.1.0.inputs.json` holds the cases and
 * `exposure-0.1.0.<platform>-<arch>.json` what 0.1.0 returned for them on that platform.
 *
 * One documented correction is not parity: per-point color exposure (see `withReleasedColor`).
 */

const PLATFORM = `${process.platform}-${process.arch}`;
const GOLDEN_DIRECTORY = new URL('./golden/', import.meta.url);

interface PlatformGolden {
  meta: { platform: string };
  entries: { name: string; expected: unknown }[];
}

const readGolden = (file: string): PlatformGolden =>
  JSON.parse(readFileSync(new URL(file, GOLDEN_DIRECTORY), 'utf8')) as PlatformGolden;

/** The capture script wrote -0, NaN and ±Infinity as strings (JSON cannot carry them). */
function revive(value: unknown): unknown {
  if (value === '-0') return -0;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, revive(inner)]));
  }
  return value;
}

/** A plain-data copy of a result, so class instances and frozen objects compare by value and key order. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const ALL: ExposureMetric[] = [
  'gex',
  'dex',
  'vega',
  'vanna',
  'charm',
  'theta',
  'vomma',
  'speed',
  'color',
];

/**
 * DOCUMENTED CORRECTION (spec decision 18). Under `gammaUnit: 'perPoint'`, 0.1.0 scaled color
 * exposure by the per-1%-move factor S²·0.01 instead of the per-point S, overstating it by S·0.01.
 * For such a profile each color value must equal 0.1.0's divided by S·0.01 — S being the profile
 * spot, or a scenario cell's own spot — to rounding (the worst case is 7e-15 relative). Every other
 * value is still compared exactly: this returns `actual` with its checked color values replaced by
 * the released ones, for the caller's `toStrictEqual`. `corrected` counts the replacements.
 */
function withReleasedColor(
  actual: unknown,
  released: unknown,
  spot: number,
  corrected: { count: number },
): unknown {
  if (Array.isArray(actual)) {
    return actual.map((item, index) =>
      withReleasedColor(item, (released as unknown[] | undefined)?.[index], spot, corrected),
    );
  }
  if (actual === null || typeof actual !== 'object') return actual;
  const current = actual as Record<string, unknown>;
  const before = (released ?? {}) as Record<string, unknown>;
  const cellSpot = typeof current['spot'] === 'number' ? current['spot'] : spot;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    const value = current[key];
    const releasedValue = before[key];
    if (key === 'color' && typeof value === 'number' && typeof releasedValue === 'number') {
      const expectedValue = releasedValue / (cellSpot * 0.01);
      expect(Math.abs(value - expectedValue)).toBeLessThanOrEqual(1e-13 * Math.abs(expectedValue));
      corrected.count++;
      result[key] = releasedValue;
    } else {
      result[key] = withReleasedColor(value, releasedValue, cellSpot, corrected);
    }
  }
  return result;
}

describe('exposure() without metrics reproduces the published 0.1.0 results exactly', () => {
  const file = `exposure-0.1.0.${PLATFORM}.json`;
  if (!existsSync(new URL(file, GOLDEN_DIRECTORY))) {
    it(`has 0.1.0's results for ${PLATFORM}`, () => {
      throw new Error(
        `No ${file}: capture 0.1.0's results on this platform with ` +
          'tools/golden/capture-exposure-baseline.mjs (see its header) before relying on this suite.',
      );
    });
    return;
  }
  const golden = readGolden(file);

  it('the platform golden covers exactly the committed cases', () => {
    expect(golden.meta.platform).toBe(PLATFORM);
    expect(golden.entries.map((entry) => entry.name)).toEqual(
      inputs.entries.map((entry) => entry.name),
    );
  });

  for (const [index, entry] of inputs.entries.entries()) {
    describe(entry.name, () => {
      const input = entry.input as unknown as ExposureInput;
      const expected = revive(golden.entries[index]!.expected) as Record<string, unknown>;
      const profile = exposure(input);
      const corrected = { count: 0 };
      /** `actual` as 0.1.0 would have returned it: the color correction checked and undone. */
      const released = (actual: unknown, key: string): unknown =>
        input.config.gammaUnit === 'perPoint'
          ? withReleasedColor(actual, expected[key], profile.spot, corrected)
          : actual;

      it('contracts, aggregate, assumptions and diagnostics', () => {
        expect(profile.spot).toBe(expected['spot']);
        expect(released(profile.contracts, 'contracts')).toStrictEqual(expected['contracts']);
        expect(Object.keys(profile.contracts[0]!)).toEqual(
          Object.keys((expected['contracts'] as object[])[0]!),
        );
        expect(released(profile.aggregate, 'aggregate')).toStrictEqual(expected['aggregate']);
        expect(Object.keys(profile.aggregate)).toEqual(
          Object.keys(expected['aggregate'] as object),
        );
        expect(plain(profile.assumptions)).toStrictEqual(expected['assumptions']);
        expect(plain(profile.diagnostics)).toStrictEqual(expected['diagnostics']);
      });

      it('levels and net drift', () => {
        expect(profile.levels()).toStrictEqual(expected['levels']);
        expect(profile.levels({ pinRiskBand: 0.02 })).toStrictEqual(expected['levelsWideBand']);
        expect(profile.netDrift()).toStrictEqual(expected['netDrift']);
      });

      it('by-strike and by-expiry views', () => {
        expect(released(profile.byStrike(), 'byStrike')).toStrictEqual(expected['byStrike']);
        expect(profile.byStrike(['gex'])).toStrictEqual(expected['byStrikeGex']);
        expect(profile.byStrike(['vanna', 'charm'])).toStrictEqual(expected['byStrikeVannaCharm']);
        expect(released(profile.byExpiry(), 'byExpiry')).toStrictEqual(expected['byExpiry']);
      });

      it('per-tick atSpot', () => {
        const atSpot = [6300, 6500, 6512.5, 6700].map((spot) => ({
          spot,
          ...profile.atSpot(spot),
        }));
        expect(atSpot).toStrictEqual(expected['atSpot']);
      });

      it('scenario maps', () => {
        expect(released(profile.scenarioMap(), 'scenarioDefault')).toStrictEqual(
          expected['scenarioDefault'],
        );
        expect(
          released(
            profile.scenarioMap({
              spot: { from: 6300, to: 6700, steps: 5 },
              volatilityShock: [-0.05, 0, 0.05],
              timeAdvance: [0, 1 / 365, 3 / 365],
              metrics: ALL,
            }),
            'scenarioFull',
          ),
        ).toStrictEqual(expected['scenarioFull']);
        expect(profile.scenarioMap({ spot: [6400, 6450, 6500], metrics: ['gex'] })).toStrictEqual(
          expected['scenarioGammaOnly'],
        );
      });

      it('the color correction applies to perPoint profiles only, and to every color value there', () => {
        // Runs after the views above (Vitest runs a file's tests in order), so `corrected` holds
        // every color value those comparisons checked.
        if (input.config.gammaUnit === 'perPoint') {
          expect(corrected.count).toBeGreaterThan(150);
        } else {
          expect(corrected.count).toBe(0);
        }
      });
    });
  }
});

describe('the per-platform 0.1.0 goldens differ only in last bits', () => {
  // A guard on the captures themselves: every committed platform must hold the same structure and
  // the same numbers to within a few units in the last place. A capture from the wrong package
  // version, or from regenerated inputs, fails here on every machine.
  const files = readdirSync(GOLDEN_DIRECTORY).filter((name) =>
    /^exposure-0\.1\.0\.[a-z0-9]+-[a-z0-9]+\.json$/.test(name),
  );

  it('covers the platforms the library is developed and tested on', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'exposure-0.1.0.darwin-arm64.json',
        'exposure-0.1.0.darwin-x64.json',
        'exposure-0.1.0.linux-arm64.json',
        'exposure-0.1.0.linux-x64.json',
      ]),
    );
  });

  it('agree with one another to 1e-15 relative, with identical structure', () => {
    const [reference, ...others] = files.map((file) => ({ file, golden: readGolden(file) }));
    const compare = (a: unknown, b: unknown, path: string, mismatches: string[]): void => {
      if (typeof a === 'number' && typeof b === 'number') {
        if (a !== b && !(Math.abs(a - b) <= 1e-15 * Math.max(Math.abs(a), Math.abs(b)))) {
          mismatches.push(`${path}: ${a} vs ${b}`);
        }
        return;
      }
      if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
        expect(Object.keys(b), path).toEqual(Object.keys(a));
        for (const key of Object.keys(a)) {
          compare(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            `${path}.${key}`,
            mismatches,
          );
        }
        return;
      }
      if (a !== b) mismatches.push(`${path}: ${String(a)} vs ${String(b)}`);
    };
    for (const other of others) {
      const mismatches: string[] = [];
      compare(reference!.golden.entries, other.golden.entries, 'entries', mismatches);
      expect(mismatches, `${other.file} vs ${reference!.file}`).toEqual([]);
    }
  });
});
