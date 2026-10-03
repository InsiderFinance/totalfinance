import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BatchModule from '@totalfinance/options/batch';
import type * as BlackScholesModule from '@totalfinance/options/black-scholes';
import type { ExposureShortcutInput } from '@totalfinance/structure';
import golden from './golden/exposure-0.1.0.inputs.json';

/**
 * Unrequested exposure work is SKIPPED, not discarded (selective Greeks and exposure spec,
 * decisions 11–12): every Black–Scholes evaluation the profile makes is recorded with the outputs
 * it asked for, and the validating scalar Greek functions the released profile called once or twice
 * per contract are counted (they must not run at all on a valid chain).
 */
const calls = vi.hoisted(() => ({
  evaluations: [] as string[][],
  scalarGreeks: 0,
  scalarExtendedGreeks: 0,
}));

vi.mock('@totalfinance/options/batch', async (importOriginal) => {
  const actual = await importOriginal<typeof BatchModule>();
  return {
    ...actual,
    blackScholesEvaluateManyInto: (
      columns: BatchModule.OptionBatchColumns,
      outputs: BatchModule.BlackScholesOutputBuffers,
    ) => {
      calls.evaluations.push(Object.keys(outputs).sort());
      actual.blackScholesEvaluateManyInto(columns, outputs);
    },
  };
});
vi.mock('@totalfinance/options/black-scholes', async (importOriginal) => {
  const actual = await importOriginal<typeof BlackScholesModule>();
  return {
    ...actual,
    blackScholesGreeks: (input: Parameters<typeof actual.blackScholesGreeks>[0]) => {
      calls.scalarGreeks++;
      return actual.blackScholesGreeks(input);
    },
    blackScholesExtendedGreeks: (
      input: Parameters<typeof actual.blackScholesExtendedGreeks>[0],
    ) => {
      calls.scalarExtendedGreeks++;
      return actual.blackScholesExtendedGreeks(input);
    },
  };
});

const { exposure, gammaExposure, deltaExposure, speedExposure } =
  await import('@totalfinance/structure');
const input = golden.entries[0]!.input as unknown as ExposureShortcutInput;

function record(run: () => unknown): string[][] {
  calls.evaluations = [];
  run();
  return calls.evaluations;
}

describe('exposure evaluates only what was asked', () => {
  beforeEach(() => {
    calls.scalarGreeks = 0;
    calls.scalarExtendedGreeks = 0;
  });

  it('construction is ONE kernel pass with exactly the selection’s outputs — no level search', () => {
    expect(record(() => gammaExposure(input))).toEqual([['gamma']]);
    expect(record(() => deltaExposure(input))).toEqual([['delta']]);
    expect(record(() => speedExposure(input))).toEqual([['gamma', 'speed']]);
    expect(record(() => exposure({ ...input, metrics: ['gex', 'dex', 'vanna'] }))).toEqual([
      ['delta', 'gamma', 'vanna'],
    ]);
    // The full profile: nine outputs for the nine metrics, in one pass (0.1.0 called the validating
    // blackScholesGreeks and blackScholesExtendedGreeks once each per contract).
    expect(record(() => exposure(input))).toEqual([
      ['charm', 'color', 'delta', 'gamma', 'speed', 'theta', 'vanna', 'vega', 'vomma'],
    ]);
    expect(calls.scalarGreeks).toBe(0);
    expect(calls.scalarExtendedGreeks).toBe(0);
  });

  it('atSpot re-evaluates only the selected gamma/delta', () => {
    const gex = gammaExposure(input);
    expect(record(() => gex.atSpot(6510))).toEqual([['gamma']]);
    const full = exposure(input);
    expect(record(() => full.atSpot(6510))).toEqual([['delta', 'gamma']]);
  });

  it('the zero-gamma sweep is gamma-only: 81 grid points plus the regime check', () => {
    const profile = exposure(input);
    const sweep = record(() => profile.netDrift());
    expect(sweep).toHaveLength(82);
    expect(sweep.every((outputs) => outputs.join() === 'gamma')).toBe(true);
  });

  it('levels() on a gamma profile computes vanna and charm once, then sweeps gamma', () => {
    const profile = gammaExposure(input);
    const evaluations = record(() => profile.levels());
    expect(evaluations[0]).toEqual(['charm', 'vanna']);
    expect(evaluations.slice(1).every((outputs) => outputs.join() === 'gamma')).toBe(true);
    // Cached: a second call needs only the sweep.
    expect(record(() => profile.levels()).every((outputs) => outputs.join() === 'gamma')).toBe(
      true,
    );
  });

  it('a gex-only scenario evaluates gamma alone; extended metrics share one pass per cell', () => {
    const profile = exposure(input);
    const gammaOnly = record(() => profile.scenarioMap({ spot: [6400, 6500], metrics: ['gex'] }));
    expect(gammaOnly).toEqual([['gamma'], ['gamma']]);
    const mixed = record(() =>
      profile.scenarioMap({ spot: [6500], metrics: ['speed', 'gex', 'charm'] }),
    );
    expect(mixed).toEqual([['charm', 'gamma', 'speed']]);
  });
});
