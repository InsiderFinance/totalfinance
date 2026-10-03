import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  charmExposure,
  colorExposure,
  deltaExposure,
  exposure,
  gammaExposure,
  speedExposure,
  thetaExposure,
  vannaExposure,
  vegaExposure,
  vommaExposure,
  type ExposureMetric,
  type ExposureShortcutInput,
} from '@totalfinance/structure';
import * as exposureEntry from '@totalfinance/structure/exposure';
import golden from './golden/exposure-0.1.0.inputs.json';

/**
 * Selective model exposure (selective Greeks and exposure spec, decisions 11–13).
 *
 * The full profile is pinned to the published 0.1.0 package by exposure-released-parity.test.ts;
 * this file pins every SELECTION to that full profile: a selected metric is bit-identical to the
 * same metric of the full profile, unselected metrics are absent (never zero), analyses compute
 * their own dependencies and agree with the full profile, and each shortcut IS its one-metric
 * selection.
 */

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
const IDENTITY = [
  'expiry',
  'strike',
  'type',
  'timeToExpiryYears',
  'impliedVolatility',
  'openInterest',
  'multiplier',
  'sign',
];

const INPUTS = golden.entries.map((entry) => ({
  name: entry.name,
  input: entry.input as unknown as ExposureShortcutInput,
}));
const input = INPUTS[0]!.input;

function caught(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (!isQuantError(error)) throw error;
    return { code: error.code, message: error.message };
  }
  throw new Error('expected a typed error');
}

const SELECTIONS: ExposureMetric[][] = [
  ...ALL.map((m) => [m]),
  ['gex', 'dex'],
  ['dex', 'gex'],
  ['vanna', 'charm'],
  ['speed', 'theta', 'vega'],
  ['color', 'gex', 'vomma'],
  [...ALL].reverse(),
];

describe('a selection computes exactly its metrics, bit-identical to the full profile', () => {
  for (const { name, input: chain } of INPUTS) {
    const full = exposure(chain);
    for (const metrics of SELECTIONS) {
      it(`${name}: [${metrics.join(', ')}]`, () => {
        const profile = exposure({ ...chain, metrics });
        const canonical = ALL.filter((m) => metrics.includes(m));
        const raw = [
          ...(metrics.includes('gex') ? ['gamma'] : []),
          ...(metrics.includes('dex') ? ['delta'] : []),
        ];
        expect(profile.contracts.length).toBe(full.contracts.length);
        profile.contracts.forEach((row, i) => {
          // Identity fields, then the raw Greeks gex/dex rows carry, then the metrics — nothing else.
          expect(Object.keys(row)).toEqual([...IDENTITY, ...raw, ...canonical]);
          const reference = full.contracts[i]!;
          for (const key of Object.keys(row)) {
            expect(Object.is((row as Record<string, unknown>)[key], reference[key as never])).toBe(
              true,
            );
          }
          expect(Object.isFrozen(row)).toBe(true);
        });
        expect(Object.keys(profile.aggregate)).toEqual(canonical);
        for (const m of canonical) {
          expect(Object.is(profile.aggregate[m], full.aggregate[m])).toBe(true);
        }
        expect(Object.isFrozen(profile.aggregate)).toBe(true);
        // The selection is echoed as requested; the full profile has no `metrics` echo at all.
        expect(profile.assumptions.metrics).toEqual(metrics);
        expect('metrics' in full.assumptions).toBe(false);
        const { metrics: _echo, ...rest } = profile.assumptions;
        expect(rest).toStrictEqual(full.assumptions);
        expect(profile.diagnostics).toStrictEqual(full.diagnostics);
      });
    }
  }

  it('an uncomputed metric is absent, never zero', () => {
    const profile = exposure({ ...input, metrics: ['gex'] });
    const serialized = JSON.parse(JSON.stringify(profile.aggregate)) as Record<string, unknown>;
    expect(serialized).toEqual({ gex: profile.aggregate.gex });
    expect('dex' in profile.contracts[0]!).toBe(false);
    expect('delta' in profile.contracts[0]!).toBe(false);
  });
});

describe('analyses compute their own dependencies and return what the full profile returns', () => {
  const full = exposure(input);
  for (const metrics of [['gex'], ['dex'], ['vega'], ['speed', 'color']] as ExposureMetric[][]) {
    it(`levels() and netDrift() from a [${metrics.join(', ')}] profile`, () => {
      const profile = exposure({ ...input, metrics });
      expect(profile.levels()).toStrictEqual(full.levels());
      expect(profile.levels({ pinRiskBand: 0.02 })).toStrictEqual(
        full.levels({ pinRiskBand: 0.02 }),
      );
      expect(profile.netDrift()).toStrictEqual(full.netDrift());
      // Computing them did not change the profile's own shape.
      expect(Object.keys(profile.aggregate)).toEqual(ALL.filter((m) => metrics.includes(m)));
    });
  }

  it('scenarioMap is an explicit analysis: any metric, the full profile’s values', () => {
    const profile = gammaExposure(input);
    const options = {
      spot: { from: 6300, to: 6700, steps: 3 },
      volatilityShock: [-0.02, 0, 0.03],
      timeAdvance: [0, 2 / 365],
      metrics: ALL,
    };
    expect(profile.scenarioMap(options)).toStrictEqual(full.scenarioMap(options));
    expect(profile.scenarioMap()).toStrictEqual(full.scenarioMap());
  });

  it('scenarioMap refuses an unknown metric instead of returning undefined cells', () => {
    const error = caught(() =>
      exposure(input).scenarioMap({ metrics: ['gamma' as ExposureMetric] }),
    );
    expect(error.code).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('atSpot re-evaluates only the selected gex/dex', () => {
  const full = exposure(input);
  it('gex-only and dex-only profiles return just their metric, equal to the full profile', () => {
    for (const spot of [6300, 6500, 6512.5, 6700]) {
      const both = full.atSpot(spot);
      expect(gammaExposure(input).atSpot(spot)).toStrictEqual({ gex: both.gex });
      expect(deltaExposure(input).atSpot(spot)).toStrictEqual({ dex: both.dex });
      expect(exposure({ ...input, metrics: ['dex', 'gex'] }).atSpot(spot)).toStrictEqual(both);
    }
  });

  it('conservation: at the profile’s own spot atSpot reproduces the aggregate exactly', () => {
    const profile = gammaExposure(input);
    expect(profile.atSpot(profile.spot).gex).toBe(profile.aggregate.gex);
  });

  it('a profile that selected neither gex nor dex refuses', () => {
    const profile = exposure({ ...input, metrics: ['vanna'] as ExposureMetric[] });
    const error = caught(() => profile.atSpot(6500));
    expect(error.code).toBe(ErrorCode.InputInvalidEnum);
    expect(error.message).toMatch(/computed neither/);
  });
});

describe('by-strike and by-expiry views follow the selection', () => {
  const full = exposure(input);
  it('default to the selection and equal the full profile’s rows for it', () => {
    const profile = exposure({ ...input, metrics: ['gex', 'vanna'] });
    expect(profile.byStrike()).toStrictEqual(full.byStrike(['gex', 'vanna']));
    expect(profile.byExpiry()).toStrictEqual(full.byExpiry(['gex', 'vanna']));
    expect(profile.byStrike(['vanna'])).toStrictEqual(full.byStrike(['vanna']));
    // The call/put split rides only with gex.
    expect(Object.keys(profile.byStrike(['vanna'])[0]!)).toEqual(['strike', 'vanna']);
  });

  it('refuse a metric the profile did not compute, and unknown names', () => {
    const profile = exposure({ ...input, metrics: ['gex'] });
    const unselected = caught(() => profile.byStrike(['dex' as never]));
    expect(unselected.code).toBe(ErrorCode.InputInvalidEnum);
    expect(unselected.message).toMatch(/"dex" was not computed by this profile \(metrics: gex\)/);
    expect(caught(() => profile.byExpiry(['vega' as never])).code).toBe(ErrorCode.InputInvalidEnum);
    expect(caught(() => full.byStrike(['gamma' as never])).code).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('the nine shortcuts are their one-metric selections', () => {
  const SHORTCUTS = [
    [gammaExposure, 'gex', 'gammaExposure'],
    [deltaExposure, 'dex', 'deltaExposure'],
    [vegaExposure, 'vega', 'vegaExposure'],
    [thetaExposure, 'theta', 'thetaExposure'],
    [vannaExposure, 'vanna', 'vannaExposure'],
    [charmExposure, 'charm', 'charmExposure'],
    [vommaExposure, 'vomma', 'vommaExposure'],
    [speedExposure, 'speed', 'speedExposure'],
    [colorExposure, 'color', 'colorExposure'],
  ] as const;

  for (const [shortcut, metric, name] of SHORTCUTS) {
    it(`${name} ≡ exposure({ …, metrics: ['${metric}'] })`, () => {
      const viaShortcut = (shortcut as (i: ExposureShortcutInput) => ReturnType<typeof exposure>)(
        input,
      );
      const viaSelection = exposure({ ...input, metrics: [metric] as ExposureMetric[] });
      expect(viaShortcut.contracts).toStrictEqual(viaSelection.contracts);
      expect(viaShortcut.aggregate).toStrictEqual(viaSelection.aggregate);
      expect(viaShortcut.assumptions).toStrictEqual(viaSelection.assumptions);
      expect(viaShortcut.diagnostics).toStrictEqual(viaSelection.diagnostics);
      expect(viaShortcut.byStrike()).toStrictEqual(viaSelection.byStrike());
      expect(viaShortcut.byExpiry()).toStrictEqual(viaSelection.byExpiry());
      expect(Object.keys(viaShortcut.aggregate)).toEqual([metric]);
      // Discoverable from both public structure entrypoints, as the same function.
      expect((exposureEntry as Record<string, unknown>)[name]).toBe(shortcut);
    });

    it(`${name} is closed ({ quotes, market, config }) and names itself in errors`, () => {
      const call = shortcut as (i: unknown) => unknown;
      const extra = caught(() => call({ ...input, metrics: [metric] }));
      expect(extra.code).toBe(ErrorCode.InputUnknownField);
      expect(extra.message).toMatch(new RegExp(`^${name}: unknown field "metrics"`));
      const noSpot = caught(() =>
        call({
          ...input,
          quotes: [],
          market: { riskFreeRate: 0.04, asOf: '2026-06-15T14:30:00-04:00' },
        }),
      );
      expect(noSpot.code).toBe(ErrorCode.InputMissingField);
      expect(noSpot.message).toMatch(new RegExp(`^${name}: spot is required`));
    });
  }
});

describe('the selection is validated like any other selection', () => {
  const run = (metrics: unknown) => caught(() => exposure({ ...input, metrics } as never));
  it('typed errors for every malformed selection', () => {
    expect(run(null).code).toBe(ErrorCode.InputWrongType);
    expect(run('gex').code).toBe(ErrorCode.InputWrongType);
    expect(run([]).code).toBe(ErrorCode.InputOutOfRange);
    // eslint-disable-next-line no-sparse-arrays
    expect(run(['gex', , 'dex']).code).toBe(ErrorCode.InputMissingField);
    expect(run(['gex', 'gex']).code).toBe(ErrorCode.InputDuplicateEntry);
    const typo = run(['gexx']);
    expect(typo.code).toBe(ErrorCode.InputInvalidEnum);
    expect(typo.message).toMatch(/did you mean "gex"/);
    expect(run(['gamma']).code).toBe(ErrorCode.InputInvalidEnum);
  });

  it('an explicit undefined is the full profile', () => {
    const profile = exposure({ ...input, metrics: undefined });
    expect(Object.keys(profile.aggregate)).toEqual(ALL);
    expect('metrics' in profile.assumptions).toBe(false);
  });
});

describe('snapshot validation keeps the released errors and fixes the NaN case', () => {
  const one = (contract: Record<string, unknown>, config: Record<string, unknown> = {}) => ({
    quotes: [
      {
        contract: {
          underlying: 'X',
          expiry: '2026-07-17',
          strike: 100,
          type: 'call',
          ...contract,
        },
        openInterest: 10,
        impliedVolatility: 0.2,
        ts: 0,
      },
    ],
    market: { spot: 100, riskFreeRate: 0.04, asOf: '2026-06-15T14:30:00-04:00' },
    config: { convention: 'dealerShortGamma', ...config },
  });

  it('an unknown option type or a non-finite strike throws exactly what 0.1.0 threw', () => {
    // Recorded from the published 0.1.0 package (tools/golden/capture-exposure-baseline.mjs setup).
    const badType = caught(() => exposure(one({ type: 'CALL' }) as never));
    expect(badType.code).toBe(ErrorCode.InputInvalidEnum);
    expect(badType.message).toBe('blackScholesGreeks: type must be one of call, put; got "CALL".');
    const infiniteStrike = caught(() => exposure(one({ strike: Infinity }) as never));
    expect(infiniteStrike.code).toBe(ErrorCode.InputNotFinite);
    expect(infiniteStrike.message).toMatch(/^blackScholesGreeks: strike must be a finite number/);
  });

  it('CORRECTION: a negative minTimeToExpiry no longer admits expired contracts as NaN', () => {
    // 0.1.0 returned a NaN aggregate here (every metric), under converged: true.
    const profile = exposure(one({ expiry: '2026-06-12' }, { minTimeToExpiry: -1 }) as never);
    expect(profile.contracts).toEqual([]);
    expect(profile.aggregate.gex).toBe(0);
    expect(profile.diagnostics.warnings[0]!.code).toBe('structure.contracts_skipped');
  });
});
