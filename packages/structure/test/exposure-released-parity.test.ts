import { describe, expect, it } from 'vitest';
import { exposure, type ExposureMetric } from '@totalfinance/structure';
import type { ExposureInput } from '@totalfinance/structure/exposure';
import golden from './golden/exposure-0.1.0.json';

/**
 * RELEASED-BEHAVIOR PARITY (selective Greeks and exposure spec, decision 11).
 *
 * `golden/exposure-0.1.0.json` was captured from the PUBLISHED `@insiderfinance/totalfinance@0.1.0`
 * package by `tools/golden/capture-exposure-baseline.mjs` — not from this repository's code — so
 * this test compares the current implementation with what released consumers actually received.
 * Omitting `metrics` must reproduce every value, field, key order, assumption and diagnostic
 * exactly (`toStrictEqual` on doubles is exact equality), through every analysis the profile offers.
 */

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

describe('exposure() without metrics reproduces the published 0.1.0 results exactly', () => {
  for (const entry of golden.entries) {
    describe(entry.name, () => {
      const input = entry.input as unknown as ExposureInput;
      const expected = revive(entry.expected) as Record<string, unknown>;
      const profile = exposure(input);

      it('contracts, aggregate, assumptions and diagnostics', () => {
        expect(profile.spot).toBe(expected['spot']);
        expect(profile.contracts).toStrictEqual(expected['contracts']);
        expect(Object.keys(profile.contracts[0]!)).toEqual(
          Object.keys((expected['contracts'] as object[])[0]!),
        );
        expect(profile.aggregate).toStrictEqual(expected['aggregate']);
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
        expect(profile.byStrike()).toStrictEqual(expected['byStrike']);
        expect(profile.byStrike(['gex'])).toStrictEqual(expected['byStrikeGex']);
        expect(profile.byStrike(['vanna', 'charm'])).toStrictEqual(expected['byStrikeVannaCharm']);
        expect(profile.byExpiry()).toStrictEqual(expected['byExpiry']);
      });

      it('per-tick atSpot', () => {
        const atSpot = [6300, 6500, 6512.5, 6700].map((spot) => ({
          spot,
          ...profile.atSpot(spot),
        }));
        expect(atSpot).toStrictEqual(expected['atSpot']);
      });

      it('scenario maps', () => {
        expect(profile.scenarioMap()).toStrictEqual(expected['scenarioDefault']);
        expect(
          profile.scenarioMap({
            spot: { from: 6300, to: 6700, steps: 5 },
            volatilityShock: [-0.05, 0, 0.05],
            timeAdvance: [0, 1 / 365, 3 / 365],
            metrics: ALL,
          }),
        ).toStrictEqual(expected['scenarioFull']);
        expect(profile.scenarioMap({ spot: [6400, 6450, 6500], metrics: ['gex'] })).toStrictEqual(
          expected['scenarioGammaOnly'],
        );
      });
    });
  }
});
