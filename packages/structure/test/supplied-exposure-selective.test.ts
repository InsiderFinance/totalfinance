import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, resolvedExpiry } from '@totalfinance/core';
import { exposureFromGreeks, type SuppliedExposureInput } from '@totalfinance/structure';
import golden from './golden/supplied-exposure-0.1.0.json';

/**
 * Supplied-Greek GEX/DEX selection (selective Greeks and exposure spec, decision 14).
 *
 * `golden/supplied-exposure-0.1.0.json` was captured from the PUBLISHED 0.1.0 package
 * (tools/golden/capture-exposure-baseline.mjs). Omitting `metrics` must reproduce it exactly; a
 * selection must equal it with the unselected metric's fields removed — same included rows, same
 * values — while reading (and requiring) only the selected metric's inputs.
 */

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const run = (input: unknown): Json =>
  clone(exposureFromGreeks(input as SuppliedExposureInput)) as unknown as Json;

const GEX_FIELDS = ['gex', 'grossGex', 'callGex', 'putGex'];
const DEX_FIELDS = ['dex', 'grossDex', 'callDex', 'putDex'];

/** The released report with one metric's fields removed — what a single-metric selection must return. */
function without(report: Json, metric: 'gex' | 'dex', selection: string[]): Json {
  const out = clone(report);
  const totalsFields = metric === 'gex' ? GEX_FIELDS : DEX_FIELDS;
  const drop = (row: Json) => {
    for (const field of totalsFields) delete row[field];
  };
  for (const row of out['contributions'] as Json[]) {
    delete row[metric === 'gex' ? 'gexSign' : 'dexSign'];
    delete row[metric];
    const greeks = row['greeks'] as Json | null;
    if (greeks !== null) delete greeks[metric === 'gex' ? 'gamma' : 'delta'];
  }
  drop(out['aggregate'] as Json);
  for (const row of out['byStrike'] as Json[]) drop(row);
  for (const row of out['byExpiry'] as Json[]) drop(row);
  const assumptions = out['assumptions'] as Json;
  for (const field of metric === 'gex'
    ? ['suppliedGammaUnit', 'gammaUnit', 'gexConvention']
    : ['suppliedDeltaUnit', 'dexUnit', 'dexConvention']) {
    delete assumptions[field];
  }
  assumptions['metrics'] = selection;
  const kept = metric === 'gex' ? 'delta' : 'gamma';
  const sign = metric === 'gex' ? 'DEX' : 'GEX';
  ((out['diagnostics'] as Json)['warnings'] as Json[])[0]!['message'] =
    `Positioning is estimated from supplied signed ${kept}, open interest and an independent ${sign} sign, not actual dealer books. Signed Greeks are used unchanged before position signs. No Greeks are recomputed and no scenario repricing is available.`;
  return out;
}

function caught(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (!isQuantError(error)) throw error;
    return { code: error.code, message: error.message };
  }
  throw new Error('expected a typed error');
}

describe('released parity and selections against the published 0.1.0 report', () => {
  for (const entry of golden.entries) {
    describe(entry.name, () => {
      const expected = entry.expected as unknown as Json;

      it('omitting metrics reproduces the released report exactly', () => {
        expect(run(entry.input)).toStrictEqual(expected);
      });

      it('an explicit GEX+DEX selection is the same report, echoing the selection', () => {
        for (const metrics of [
          ['gex', 'dex'],
          ['dex', 'gex'],
        ]) {
          const report = run({ ...entry.input, metrics });
          const { metrics: echoed, ...assumptions } = report['assumptions'] as Json;
          expect(echoed).toEqual(metrics);
          expect({ ...report, assumptions }).toStrictEqual(expected);
        }
      });

      it("['gex'] is the released report without its DEX fields", () => {
        expect(run({ ...entry.input, metrics: ['gex'] })).toStrictEqual(
          without(expected, 'dex', ['gex']),
        );
      });

      it("['dex'] is the released report without its GEX fields", () => {
        expect(run({ ...entry.input, metrics: ['dex'] })).toStrictEqual(
          without(expected, 'gex', ['dex']),
        );
      });

      it('GEX and DEX always cover the same included rows', () => {
        const report = run(entry.input);
        for (const row of report['contributions'] as Json[]) {
          expect(row['gex'] === null).toBe(row['dex'] === null);
          expect(row['gex'] === null).toBe(!row['included']);
        }
      });
    });
  }
});

describe('a selection reads and requires only its own inputs', () => {
  const timestampMs = Date.parse('2026-09-01T15:00:00Z');
  const contract = {
    underlying: 'SPY',
    type: 'put' as const,
    style: 'american' as const,
    strike: 100,
    expiry: '2026-09-18',
    ...resolvedExpiry('2026-09-18'),
    multiplier: 100,
  };
  const provenance = { source: 'greek-feed', timestampMs };
  const market = {
    underlying: 'SPY',
    spot: 100,
    source: 'spot-feed',
    timestampMs,
    asOf: timestampMs,
  };
  const quote = <G extends object>(greeks: G | undefined) => ({
    contract,
    source: 'chain-feed',
    timestampMs,
    openInterest: 10,
    ...(greeks === undefined ? {} : { greeks }),
  });

  it('GEX-only: no delta, no dexConvention needed; the answer matches the full report', () => {
    const report = exposureFromGreeks({
      quotes: [quote({ gamma: 0.02, provenance })],
      market,
      config: {
        gexConvention: { calls: 1, puts: -1 },
        gammaUnit: 'per1PercentMove',
        maximumObservationAgeMs: 60_000,
      },
      metrics: ['gex'],
    });
    expect(report.aggregate.gex).toBe(-2000);
    expect('dex' in report.aggregate).toBe(false);
    expect(report.contributions[0]!.greeks).toEqual({ gamma: 0.02, provenance });
  });

  it('DEX-only: no gamma, no gexConvention or gammaUnit needed', () => {
    const report = exposureFromGreeks({
      quotes: [quote({ delta: -0.4, provenance })],
      market,
      config: { dexConvention: { calls: 1, puts: 1 }, maximumObservationAgeMs: 60_000 },
      metrics: ['dex'],
    });
    expect(report.aggregate.dex).toBe(-40000);
    expect('gex' in report.aggregate).toBe(false);
    expect(report.assumptions.metrics).toEqual(['dex']);
    expect('gammaUnit' in report.assumptions).toBe(false);
  });

  it('the unselected supplied Greek is not read, validated or copied', () => {
    const report = exposureFromGreeks({
      quotes: [quote({ gamma: 0.02, delta: Number.NaN, provenance })],
      market,
      config: {
        gexConvention: { calls: 1, puts: -1 },
        gammaUnit: 'perPoint',
        maximumObservationAgeMs: 0,
      },
      metrics: ['gex'],
    } as never);
    expect('delta' in (report.contributions[0]!.greeks as object)).toBe(false);
  });

  it('a GEX+DEX report (selected or by default) still requires both Greeks on every row', () => {
    const config = {
      gexConvention: { calls: 1, puts: -1 },
      dexConvention: { calls: 1, puts: 1 },
      gammaUnit: 'per1PercentMove',
      maximumObservationAgeMs: 60_000,
    };
    for (const metrics of [undefined, ['gex', 'dex']]) {
      const error = caught(() =>
        exposureFromGreeks({
          quotes: [quote({ gamma: 0.02, provenance })],
          market,
          config,
          ...(metrics === undefined ? {} : { metrics }),
        } as never),
      );
      expect(error.code).toBe(ErrorCode.InputMissingField);
      expect(error.message).toMatch(/delta/);
    }
  });

  it('a selected metric’s controls are required; an unselected one is shape-checked if present', () => {
    const missing = caught(() =>
      exposureFromGreeks({
        quotes: [],
        market,
        config: { dexConvention: { calls: 1, puts: 1 }, maximumObservationAgeMs: 0 },
        metrics: ['gex'],
      } as never),
    );
    expect(missing.message).toMatch(/config\.gexConvention/);
    const malformed = caught(() =>
      exposureFromGreeks({
        quotes: [],
        market,
        config: {
          gexConvention: { calls: 1, puts: -1 },
          dexConvention: { calls: 2, puts: 1 },
          gammaUnit: 'perPoint',
          maximumObservationAgeMs: 0,
        },
        metrics: ['gex'],
      } as never),
    );
    expect(malformed.code).toBe(ErrorCode.InputInvalidEnum);
    expect(malformed.message).toMatch(/config\.dexConvention\.calls/);
  });

  it('missing Greeks exclude a row; no modeled Greek is substituted, no scenario repricing', () => {
    const report = exposureFromGreeks({
      quotes: [quote<{ gamma: number; provenance: typeof provenance }>(undefined)],
      market,
      config: {
        gexConvention: { calls: 1, puts: -1 },
        gammaUnit: 'perPoint',
        maximumObservationAgeMs: 0,
      },
      metrics: ['gex'],
    });
    expect(report.contributions[0]!.gex).toBeNull();
    expect(report.contributions[0]!.exclusionReasons).toEqual(['missingGreeks']);
    expect(report.assumptions.scenarioRepricing).toBe('unavailable');
  });

  it('the selection itself is validated', () => {
    const base = { quotes: [], market, config: { maximumObservationAgeMs: 0 } };
    const code = (metrics: unknown) =>
      caught(() => exposureFromGreeks({ ...base, metrics } as never)).code;
    expect(code([])).toBe(ErrorCode.InputOutOfRange);
    expect(code(['gex', 'gex'])).toBe(ErrorCode.InputDuplicateEntry);
    expect(code(['vega'])).toBe(ErrorCode.InputInvalidEnum);
    expect(code('gex')).toBe(ErrorCode.InputWrongType);
    expect(code(null)).toBe(ErrorCode.InputWrongType);
  });
});
