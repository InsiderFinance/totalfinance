import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError, resolvedExpiry, stableSum } from '@totalfinance/core';
import { createAnalysisArtifact, readAnalysisArtifact } from '@totalfinance/core/artifacts';
import {
  exposure,
  exposureFromGreeks,
  type GammaUnit,
  type SuppliedExposureInput,
  type SuppliedExposureQuote,
  type SuppliedExposureTotals,
} from '@totalfinance/structure';

const timestampMs = Date.parse('2026-09-01T15:00:00Z');

function quote(overrides: Partial<SuppliedExposureQuote> = {}): SuppliedExposureQuote {
  return {
    contract: {
      underlying: 'SPY',
      type: 'put',
      style: 'american',
      strike: 100,
      expiry: '2026-09-18',
      ...resolvedExpiry('2026-09-18'),
      multiplier: 100,
    },
    source: 'chain-feed',
    timestampMs,
    openInterest: 10,
    greeks: { delta: -0.4, gamma: 0.02, provenance: { source: 'greek-feed', timestampMs } },
    ...overrides,
  };
}

function input(quotes = [quote()]): SuppliedExposureInput {
  return {
    quotes,
    market: { underlying: 'SPY', spot: 100, source: 'spot-feed', timestampMs, asOf: timestampMs },
    config: {
      gexConvention: { calls: 1, puts: -1 },
      dexConvention: { calls: 1, puts: 1 },
      gammaUnit: 'per1PercentMove',
      maximumObservationAgeMs: 60000,
    },
  };
}

function rejects(request: unknown, field: string, code?: string): void {
  let caught: unknown;
  try {
    exposureFromGreeks(request as SuppliedExposureInput);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputError);
  expect((caught as InputError).message).toContain(field);
  if (code) expect((caught as InputError).code).toBe(code);
}

describe('exposureFromGreeks independent accounting', () => {
  it('executes the source JSDoc example itself', () => {
    const source = readFileSync(new URL('../src/supplied-exposure.ts', import.meta.url), 'utf8');
    const code = source
      .match(/@example\s+\* ```ts\n([\s\S]*?)\n \* ```/)![1]!
      .replace(/^ \* ?/gm, '')
      .replace(/^import .*;\n/gm, '');
    const report = new Function('resolvedExpiry', 'exposureFromGreeks', `${code}\nreturn report;`)(
      resolvedExpiry,
      exposureFromGreeks,
    );
    expect(report.aggregate.gex).toBe(-2000);
    expect(report.aggregate.dex).toBe(-40000);
  });

  it('uses hand-calculated signed put Greeks and independent position conventions', () => {
    // put: gamma .02 * 10 * 100 * 100 * 1 * -1 = -2000; delta -.4 * 10 * 100 * 100 = -40000.
    const request = input();
    const report = exposureFromGreeks(request);
    expect(report.aggregate).toEqual({
      gex: -2000,
      dex: -40000,
      grossGex: 2000,
      grossDex: 40000,
      callGex: 0,
      putGex: -2000,
      callDex: 0,
      putDex: -40000,
      openInterest: 10,
      callOpenInterest: 0,
      putOpenInterest: 10,
      includedQuotes: 1,
    });
    request.config.dexConvention.puts = -1;
    expect(exposureFromGreeks(request).aggregate).toMatchObject({ gex: -2000, dex: 40000 });
    request.quotes[0]!.greeks!.gamma = -0.02;
    expect(exposureFromGreeks(request).aggregate).toMatchObject({ gex: 2000, dex: 40000 });
  });

  it('separates per-point and per-1%-move GEX without changing DEX', () => {
    const request = input();
    request.market.spot = 250;
    const percent = exposureFromGreeks(request);
    expect(percent.aggregate).toMatchObject({ gex: -12500, dex: -100000 });
    request.config.gammaUnit = 'perPoint';
    const point = exposureFromGreeks(request);
    expect(point.aggregate).toMatchObject({ gex: -5000, dex: -100000 });
    expect(point.assumptions).toMatchObject({
      gammaUnit: 'perPoint',
      suppliedGammaUnit: 'deltaPerSpotPoint',
      dexUnit: 'dollarDelta',
    });
  });

  it('preserves gross per-row exposure even where strike and expiry net to zero', () => {
    const put = quote();
    const call = quote({
      contract: { ...put.contract, type: 'call' },
      greeks: { ...put.greeks!, delta: 0.4 },
    });
    const report = exposureFromGreeks(input([put, call]));
    for (const totals of [report.aggregate, report.byStrike[0]!, report.byExpiry[0]!]) {
      expect(totals).toMatchObject({ gex: 0, dex: 0, grossGex: 4000, grossDex: 80000 });
    }
  });

  it.each([1, 10, 50, 100, 2.5])(
    'uses multiplier %s without assuming 100 or applying it twice',
    (multiplier) => {
      const row = quote();
      row.contract.multiplier = multiplier;
      const report = exposureFromGreeks(input([row]));
      expect(report.aggregate.gex).toBe(-20 * multiplier);
      expect(report.aggregate.dex).toBe(-400 * multiplier);
      expect(report.contributions[0]!.multiplierSource).toBe('contract');
    },
  );

  it('uses only an explicit fallback and echoes its actual source', () => {
    const request = input();
    delete request.quotes[0]!.contract.multiplier;
    rejects(request, 'quotes[0].contract.multiplier', ErrorCode.InputMissingField);
    request.config.defaultMultiplier = 10;
    const report = exposureFromGreeks(request);
    expect(report.aggregate.dex).toBe(-4000);
    expect(report.contributions[0]).toMatchObject({
      multiplier: 10,
      multiplierSource: 'config.defaultMultiplier',
    });
    expect(report.assumptions.defaultMultiplier).toBe(10);
    request.quotes[0]!.contract.multiplier = 1;
    expect(exposureFromGreeks(request).aggregate.dex).toBe(-400);
  });

  it('retains actual independent sources and observation timestamps', () => {
    const request = input();
    request.quotes[0]!.timestampMs -= 1000;
    request.quotes[0]!.greeks!.provenance.timestampMs -= 2000;
    request.market.timestampMs -= 3000;
    const report = exposureFromGreeks(request);
    expect(report.contributions[0]).toMatchObject({
      source: 'chain-feed',
      timestampMs: timestampMs - 1000,
      greeks: { provenance: { source: 'greek-feed', timestampMs: timestampMs - 2000 } },
    });
    expect(report.assumptions.market).toEqual(request.market);
    expect(report.assumptions.greekSource).toBe('supplied');
    expect(report.assumptions.suppliedGreekSignPolicy).toBe('signed-as-provided');
    expect(report.assumptions.currencyPolicy).toBe(
      'caller-aligned-single-currency-no-fx-conversion',
    );
    expect(report.coverage).toMatchObject({
      scope: 'suppliedQuotesOnly',
      status: 'allInputQuotesIncluded',
    });
    expect(report.assumptions.model).toBeUndefined();
    expect(report.diagnostics.warnings.map((w) => w.code)).toContain('model.limitation');
    expect(report).not.toHaveProperty('scenarioMap');
    expect(report).not.toHaveProperty('levels');
    expect(report.assumptions.scenarioRepricing).toBe('unavailable');
  });

  it('saves directly through the existing analysis-artifact report grammar', () => {
    const request = input();
    const report = exposureFromGreeks(request);
    const artifact = createAnalysisArtifact({
      artifactType: 'supplied-exposure',
      producedBy: {
        operation: 'structure.exposureFromGreeks',
        libraryVersion: '0.0.1',
      },
      inputs: { parameters: request },
      result: report,
    });
    expect(
      readAnalysisArtifact({ artifact: JSON.parse(JSON.stringify(artifact)) }).artifact.result,
    ).toEqual(report);
  });

  it('ignores unconsumed price/IV fields and accepts decoration without mutating or retaining it', () => {
    const request = input();
    const baseline = exposureFromGreeks(request);
    Object.assign(request.quotes[0]!, {
      impliedVolatility: NaN,
      bid: 'unused',
      vendor: { nested: Infinity },
    });
    Object.assign(request.quotes[0]!.contract, { deliverable: null, custom: 'metadata' });
    Object.assign(request.quotes[0]!.greeks!, { theta: NaN, custom: 'metadata' });
    Object.assign(request.market, { exchange: 'NYSE' });
    Object.freeze(request.quotes[0]!.contract);
    Object.freeze(request.quotes[0]!.greeks);
    Object.freeze(request.quotes[0]);
    Object.freeze(request.quotes);
    Object.freeze(request.market);
    const report = exposureFromGreeks(request);
    expect(report).toEqual(baseline);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.contributions[0]!.contract).not.toBe(request.quotes[0]!.contract);
    expect(report.assumptions.gexConvention).not.toBe(request.config.gexConvention);
  });

  it('does not change its report after caller input mutation', () => {
    const request = input();
    const report = exposureFromGreeks(request);
    const copy = JSON.stringify(report);
    request.quotes[0]!.greeks!.delta = 1;
    request.quotes[0]!.contract.strike = 200;
    request.config.gexConvention.puts = 1;
    request.market.spot = 200;
    expect(JSON.stringify(report)).toBe(copy);
  });
});

describe('supplied/model parity and aggregation conservation', () => {
  it.each<GammaUnit>(['perPoint', 'per1PercentMove'])(
    'agrees with exposure() when fed exactly its Greeks: %s',
    (gammaUnit) => {
      const rows = Array.from({ length: 18 }, (_, i) => {
        const expiry = i % 3 === 0 ? '2026-12-18' : '2026-09-18';
        const base = quote();
        return quote({
          contract: {
            ...base.contract,
            type: i % 2 ? 'call' : 'put',
            style: 'european',
            strike: 80 + (i % 6) * 10,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: i % 3 ? 100 : 10,
          },
          openInterest: 5 + i * 3,
          impliedVolatility: 0.15 + i * 0.01,
        });
      });
      for (const signs of [
        { calls: 1, puts: -1 },
        { calls: -1, puts: -1 },
        { calls: 1, puts: 1 },
      ] as const) {
        const model = exposure({
          quotes: rows,
          market: { spot: 130, riskFreeRate: 0.03, dividendYield: 0.01, asOf: timestampMs },
          config: { convention: signs, gammaUnit },
        });
        const supplied = rows.map((row, i) => ({
          ...row,
          greeks: {
            delta: model.contracts[i]!.delta,
            gamma: model.contracts[i]!.gamma,
            provenance: { source: 'bsm-model-fed-test', timestampMs },
          },
        }));
        const request = input(supplied);
        request.market.spot = 130;
        request.config = {
          ...request.config,
          gammaUnit,
          gexConvention: signs,
          dexConvention: signs,
        };
        const report = exposureFromGreeks(request);
        for (const c of report.contributions) {
          expect(c.gex).toBeCloseTo(model.contracts[c.inputIndex]!.gex, 8);
          expect(c.dex).toBeCloseTo(model.contracts[c.inputIndex]!.dex, 8);
        }
        expect(report.aggregate.gex).toBeCloseTo(model.aggregate.gex, 8);
        expect(report.aggregate.dex).toBeCloseTo(model.aggregate.dex, 8);
        for (const row of model.byStrike(['gex', 'dex'])) {
          const other = report.byStrike.find((r) => r.strike === row.strike)!;
          expect(other.gex).toBeCloseTo(row.gex, 8);
          expect(other.dex).toBeCloseTo(row.dex, 8);
        }
        for (const row of model.byExpiry(['gex', 'dex'])) {
          const other = report.byExpiry.find(
            (r) => r.expiresAt === resolvedExpiry(row.expiry).expiresAt,
          )!;
          expect(other.gex).toBeCloseTo(row.gex, 8);
          expect(other.dex).toBeCloseTo(row.dex, 8);
        }
        for (const key of Object.keys(report.aggregate) as Array<keyof SuppliedExposureTotals>) {
          expect(stableSum(report.byStrike.map((r) => r[key]))).toBeCloseTo(
            report.aggregate[key],
            8,
          );
          expect(stableSum(report.byExpiry.map((r) => r[key]))).toBeCloseTo(
            report.aggregate[key],
            8,
          );
        }
        const reversed = exposureFromGreeks({ ...request, quotes: [...supplied].reverse() });
        expect(reversed.aggregate).toEqual(report.aggregate);
        expect(reversed.byStrike).toEqual(report.byStrike);
        expect(reversed.byExpiry).toEqual(report.byExpiry);
      }
    },
  );

  it('sorts expiry, strike, call/put and stable input ties; groups equivalent expiry labels', () => {
    const base = quote();
    const instant = new Date(base.contract.expiresAt).toISOString();
    const rows = [
      base,
      quote({ contract: { ...base.contract, type: 'call' } }),
      quote({
        contract: { ...base.contract, strike: 90, expiry: instant, ...resolvedExpiry(instant) },
      }),
      base,
    ];
    const report = exposureFromGreeks(input(rows));
    expect(report.contributions.map((r) => r.inputIndex)).toEqual([2, 1, 0, 3]);
    expect(report.byStrike.map((r) => r.strike)).toEqual([90, 100]);
    expect(report.byExpiry).toHaveLength(1);
    expect(report.byExpiry[0]!.expiry).toBe(instant);
  });

  it('preserves tiny net residuals with compensated summation', () => {
    const rows = [1e16, 1, -1e16].map((delta) =>
      quote({
        openInterest: 1,
        contract: { ...quote().contract, multiplier: 1 },
        greeks: { ...quote().greeks!, delta, gamma: 0 },
      }),
    );
    const request = input(rows);
    request.market.spot = 1;
    expect(exposureFromGreeks(request).aggregate.dex).toBe(1);
    expect(exposureFromGreeks({ ...request, quotes: [...rows].reverse() }).aggregate.dex).toBe(1);
  });

  it('counts repeated contract identities without silently deduplicating or merging observations', () => {
    const first = quote();
    const second = quote({ timestampMs: timestampMs - 1, source: 'other-chain-source' });
    const missing = quote();
    delete missing.greeks;
    const report = exposureFromGreeks(input([missing, first, second]));
    expect(report.coverage).toMatchObject({
      duplicateContractQuotes: 2,
      duplicateIncludedContractQuotes: 1,
    });
    expect(report.aggregate).toMatchObject({ openInterest: 20, gex: -4000, dex: -80000 });
    expect(report.contributions).toHaveLength(3);
    expect(
      report.diagnostics.warnings.find((w) => w.code === 'structure.duplicate_contract_quotes'),
    ).toMatchObject({
      severity: 'warn',
      context: { duplicateContractQuotes: 2, duplicateIncludedContractQuotes: 1 },
    });
    const reversed = exposureFromGreeks(input([second, first, missing]));
    expect(reversed.coverage).toEqual(report.coverage);
    const excludedOnly = exposureFromGreeks(input([missing, missing]));
    expect(excludedOnly.coverage).toMatchObject({
      duplicateContractQuotes: 1,
      duplicateIncludedContractQuotes: 0,
    });
  });
});

describe('coverage and exact asOf boundaries', () => {
  it.each(['quote', 'greeks', 'market'] as const)(
    'uses actual %s age with inclusive stale and asOf boundaries',
    (source) => {
      for (const [offset, included, reason] of [
        [0, true, null],
        [-60000, true, null],
        [-60001, false, 'stale'],
        [1, false, 'future'],
      ] as const) {
        const request = input();
        const observation =
          source === 'market'
            ? request.market
            : source === 'greeks'
              ? request.quotes[0]!.greeks!.provenance
              : request.quotes[0]!;
        observation.timestampMs += offset;
        const report = exposureFromGreeks(request);
        expect(report.contributions[0]!.included).toBe(included);
        if (reason)
          expect(report.contributions[0]!.exclusionReasons).toContain(
            `${reason}${source === 'greeks' ? 'Greeks' : source === 'market' ? 'Market' : 'Quote'}`,
          );
        expect(report.aggregate.includedQuotes).toBe(included ? 1 : 0);
        expect(report.contributions[0]!.gex).toBe(included ? -2000 : null);
      }
    },
  );

  it('accepts canonical string asOf and excludes at the exact expiry instant', () => {
    const request = input();
    request.market.asOf = '2026-09-01T15:00:00Z';
    expect(exposureFromGreeks(request).aggregate.gex).toBe(-2000);
    for (const offset of [-1, 0, 1]) {
      const asOf = request.quotes[0]!.contract.expiresAt + offset;
      request.market.asOf = asOf;
      request.market.timestampMs = asOf;
      request.quotes[0]!.timestampMs = asOf;
      request.quotes[0]!.greeks!.provenance.timestampMs = asOf;
      expect(exposureFromGreeks(request).contributions[0]!.included).toBe(offset < 0);
    }
  });

  it('never fills missing Greeks/OI from IV, reports overlapping exclusions, keeps zero OI', () => {
    const missing = quote({ impliedVolatility: 0.2 });
    delete missing.greeks;
    delete missing.openInterest;
    const report = exposureFromGreeks(input([missing, quote({ openInterest: 0 })]));
    expect(report.contributions[0]).toMatchObject({
      included: false,
      gex: null,
      dex: null,
      greeks: null,
      exclusionReasons: ['missingGreeks', 'missingOpenInterest'],
    });
    expect(report.contributions[1]).toMatchObject({ included: true, gex: 0, dex: 0 });
    expect(report.coverage).toMatchObject({
      scope: 'suppliedQuotesOnly',
      status: 'partialInput',
      totalQuotes: 2,
      includedQuotes: 1,
      excludedQuotes: 1,
      fraction: 0.5,
      exclusionCounts: { missingGreeks: 1, missingOpenInterest: 1 },
    });
    expect(report.diagnostics.warnings.some((w) => w.code === 'structure.contracts_skipped')).toBe(
      true,
    );
  });

  it('returns honest empty and excluded-only buckets', () => {
    const report = exposureFromGreeks(input([]));
    expect(report.coverage.fraction).toBeNull();
    expect(report.coverage.status).toBe('emptyInput');
    expect(
      report.diagnostics.warnings.some((w) =>
        w.message.includes('not measured zero market exposure'),
      ),
    ).toBe(true);
    expect(report.aggregate.gex).toBe(0);
    expect(report.byStrike).toEqual([]);
    expect(report.byExpiry).toEqual([]);
    const row = quote();
    delete row.greeks;
    const excluded = exposureFromGreeks(input([row]));
    expect(excluded.coverage.status).toBe('noEligibleQuotes');
    expect(
      excluded.diagnostics.warnings.some((w) => w.code === 'structure.no_eligible_quotes'),
    ).toBe(true);
    expect(excluded.byStrike[0]).toMatchObject({ includedQuotes: 0, gex: 0, grossGex: 0 });
  });
});

describe('runtime teaching and bounded work', () => {
  it.each([undefined, null, 3, 'bad', [], true])('rejects malformed requests %s', (value) => {
    rejects(value, 'input', ErrorCode.InputWrongType);
  });

  it('rejects closed-control typos with did-you-mean teaching', () => {
    rejects({ ...input(), confgi: {} }, 'confgi', ErrorCode.InputUnknownField);
    const request = input();
    Object.assign(request.config, { gamaUnit: 'perPoint' });
    rejects(request, 'gammaUnit', ErrorCode.InputUnknownField);
    const signs = input();
    Object.assign(signs.config.dexConvention, { put: -1 });
    rejects(signs, 'puts', ErrorCode.InputUnknownField);
    const scenario = input();
    Object.assign(scenario.config, { scenarioMap: {} });
    rejects(scenario, 'scenarioMap', ErrorCode.InputUnknownField);
  });

  it('echoes maximumObservationAgeMs and rejects the unpublished abbreviated name', () => {
    const request = input();
    const report = exposureFromGreeks(request);
    expect(report.assumptions.maximumObservationAgeMs).toBe(60000);
    expect(report.assumptions).not.toHaveProperty('maxObservationAgeMs');
    const { maximumObservationAgeMs, ...config } = request.config;
    rejects(
      { ...request, config: { ...config, maxObservationAgeMs: maximumObservationAgeMs } },
      'maxObservationAgeMs',
      ErrorCode.InputUnknownField,
    );
  });

  it.each([
    'market.spot',
    'market.timestampMs',
    'config.maximumObservationAgeMs',
    'config.defaultMultiplier',
    'quotes[0].timestampMs',
    'quotes[0].openInterest',
    'quotes[0].contract.strike',
    'quotes[0].contract.expiresAt',
    'quotes[0].contract.multiplier',
    'quotes[0].greeks.delta',
    'quotes[0].greeks.gamma',
    'quotes[0].greeks.provenance.timestampMs',
  ])('validates consumed numeric field %s', (path) => {
    for (const value of [null, NaN, Infinity, -Infinity, '1', {}, [], true]) {
      const request = input();
      const parts = path.replaceAll('[0]', '.0').split('.');
      let target = request as unknown as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
      target[parts.at(-1)!] = value;
      rejects(request, path);
    }
  });

  it.each([
    'quotes[0].source',
    'quotes[0].greeks.provenance.source',
    'market.source',
    'market.underlying',
    'quotes[0].contract.underlying',
    'quotes[0].contract.expiry',
  ])('validates consumed text field %s', (path) => {
    for (const value of [undefined, null, 1, {}, '', ' ', 'x'.repeat(513)]) {
      const request = input();
      const parts = path.replaceAll('[0]', '.0').split('.');
      let target = request as unknown as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
      target[parts.at(-1)!] = value;
      rejects(request, path);
    }
  });

  it('checks malformed containers, enums, missing required fields and canonical expiry cross-fields', () => {
    for (const value of [null, [], 1]) {
      rejects({ ...input(), market: value }, 'market');
      rejects({ ...input(), config: value }, 'config');
      rejects({ ...input(), quotes: [value] }, 'quotes[0]');
      rejects(input([quote({ contract: value as never })]), 'quotes[0].contract');
      rejects(input([quote({ greeks: value as never })]), 'quotes[0].greeks');
    }
    for (const value of [undefined, null, 'bad', 0, 2, {}, []]) {
      const request = input();
      request.config.gammaUnit = value as never;
      rejects(request, 'config.gammaUnit');
      const request2 = input();
      request2.config.gexConvention.calls = value as never;
      rejects(request2, 'config.gexConvention.calls');
    }
    for (const field of ['type', 'style', 'expiryConvention'] as const) {
      const request = input();
      request.quotes[0]!.contract[field] = 'bad' as never;
      rejects(request, `quotes[0].contract.${field}`);
    }
    const request = input();
    request.quotes[0]!.contract.expiresAt += 1;
    rejects(request, 'quotes[0].contract.expiry');
    request.quotes[0]!.contract.expiry = '2026-02-30';
    rejects(request, 'quotes[0].contract.expiry');
    const missing = input();
    delete (missing.quotes[0]!.greeks as Partial<{ delta: number }>).delta;
    rejects(missing, 'quotes[0].greeks.delta', ErrorCode.InputMissingField);
  });

  it('checks ranges and never treats a malformed excluded row as merely missing', () => {
    for (const openInterest of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1])
      rejects(input([quote({ openInterest })]), 'quotes[0].openInterest');
    for (const multiplier of [0, -1]) {
      rejects(
        input([quote({ contract: { ...quote().contract, multiplier } })]),
        'quotes[0].contract.multiplier',
      );
    }
    const request = input();
    request.quotes[0]!.timestampMs += 1;
    request.quotes[0]!.greeks!.delta = NaN;
    rejects(request, 'quotes[0].greeks.delta');
    request.quotes[0]!.contract.underlying = 'QQQ';
    rejects(request, 'quotes[0].contract.underlying');
    for (const asOf of [null, NaN, 1.5, 8.64e15 + 1, '2026-09-01T15:00:00', 'bad']) {
      rejects({ ...input(), market: { ...input().market, asOf } }, 'asOf');
    }
  });

  it('refuses sparse/typed arrays and caps length BEFORE reading an element', () => {
    rejects({ ...input(), quotes: new Float64Array(1) }, 'quotes');
    rejects({ ...input(), quotes: new Array(2) }, 'quotes[0]');
    const sparse = [quote(), quote(), quote()];
    delete sparse[1];
    rejects({ ...input(), quotes: sparse }, 'quotes[1]');
    const huge = new Array(100001);
    Object.defineProperty(huge, 0, {
      get() {
        throw new Error('must not read oversized input');
      },
    });
    rejects({ ...input(), quotes: huge }, 'quotes', ErrorCode.OperationInputTooLarge);
  });

  it('throws indexed errors on contribution overflow and refuses aggregate gross overflow', () => {
    const row = quote();
    row.greeks!.gamma = Number.MAX_VALUE;
    rejects(input([row]), 'quotes[0].gex');
    row.greeks!.gamma = 0;
    row.greeks!.delta = Number.MAX_VALUE;
    rejects(input([row]), 'quotes[0].dex');
    const rows = [1, -1].map((sign) =>
      quote({
        openInterest: 1,
        contract: { ...quote().contract, multiplier: 1 },
        greeks: { ...quote().greeks!, delta: sign * 1e308, gamma: 0 },
      }),
    );
    const request = input(rows);
    request.market.spot = 1;
    rejects(request, 'aggregate.grossDex');
  });

  it('preserves a genuine zero exposure with extreme finite inputs', () => {
    const row = quote({ openInterest: 0 });
    row.greeks!.gamma = Number.MAX_VALUE;
    row.greeks!.delta = Number.MAX_VALUE;
    const request = input([row]);
    request.market.spot = Number.MAX_VALUE;
    expect(exposureFromGreeks(request).aggregate).toMatchObject({ gex: 0, dex: 0 });
  });

  it('avoids intermediate overflow/underflow when the final exposure is representable', () => {
    const request = input();
    request.config.gammaUnit = 'perPoint';
    request.market.spot = 1e-308;
    request.quotes[0]!.openInterest = 1;
    request.quotes[0]!.contract.multiplier = 100;
    request.quotes[0]!.greeks = { ...quote().greeks!, delta: 1e308, gamma: -1e308 };
    expect(exposureFromGreeks(request).aggregate).toMatchObject({
      gex: expect.closeTo(100, 12),
      dex: expect.closeTo(100, 12),
    });
    request.quotes[0]!.greeks!.delta = Number.MIN_VALUE;
    request.quotes[0]!.greeks!.gamma = 0;
    request.quotes[0]!.contract.multiplier = 0.1;
    request.market.spot = 100;
    expect(exposureFromGreeks(request).aggregate.dex).toBe(Number.MIN_VALUE * 10);
    request.market.spot = 1;
    expect(exposureFromGreeks(request).aggregate.dex).toBe(0);
    request.quotes[0]!.greeks!.delta = -Number.MIN_VALUE;
    expect(Object.is(exposureFromGreeks(request).aggregate.dex, -0)).toBe(false);
  });

  it('accepts the documented maximum dense chain without quadratic grouping', () => {
    const request = input(Array.from({ length: 100000 }, () => quote({ openInterest: 0 })));
    const report = exposureFromGreeks(request);
    expect(report.coverage.includedQuotes).toBe(100000);
    expect(report.aggregate.gex).toBe(0);
    expect(report.byStrike).toHaveLength(1);
  });

  it('keeps public financial controls named at compile time', () => {
    const compileOnly = (): void => {
      // @ts-expect-error no positional financial signature
      exposureFromGreeks([], {}, {});
      // @ts-expect-error separate explicit conventions and output unit are required
      exposureFromGreeks({ ...input(), config: {} });
      // @ts-expect-error this report is not a model pricing surface
      exposureFromGreeks(input()).scenarioMap({ spot: [100, 110] });
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});
