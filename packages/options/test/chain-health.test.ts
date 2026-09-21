import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule, ScriptTarget } from 'typescript';
import {
  InputError,
  ErrorCode,
  assertFiniteValue,
  resolvedExpiry,
  type OptionContract,
} from '@totalfinance/core';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import {
  engines,
  option,
  optionChainHealth,
  blackScholes,
  type OptionChainHealthInput,
  type OptionChainHealthQuote,
  type OptionChainHealthReport,
} from '@totalfinance/options';

const AS_OF = 1767225600000;
const EXPIRY = '2027-01-01T00:00:00Z';

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  const expiry = overrides.expiry ?? EXPIRY;
  return {
    underlying: 'X',
    type: 'call',
    style: 'european',
    strike: 100,
    expiry,
    ...resolvedExpiry(expiry),
    ...overrides,
  };
}

function quote(overrides: Partial<OptionChainHealthQuote> = {}): OptionChainHealthQuote {
  return { contract: contract(), timestampMs: AS_OF, bid: 7.9, ask: 8.1, ...overrides };
}

function request(quotes: readonly OptionChainHealthQuote[] = [quote()]): OptionChainHealthInput {
  return {
    quotes,
    market: { underlying: 'X', spot: 100, riskFreeRate: 0, dividendYield: 0, asOf: AS_OF },
    config: {
      model: 'black-scholes-merton',
      priceSource: 'mid',
      maximumQuoteAgeMs: 60_000,
      maximumRelativeSpread: 0.1,
      minimumExpiries: 1,
      minimumStrikesPerExpiry: 1,
    },
  };
}

function first(input: OptionChainHealthInput): OptionChainHealthReport['rows'][number] {
  return optionChainHealth(input).rows[0]!;
}

function malformed(input: unknown, field?: string, code?: string): void {
  expect(() => optionChainHealth(input as OptionChainHealthInput)).toThrow(InputError);
  try {
    optionChainHealth(input as OptionChainHealthInput);
    throw new Error('Expected typed failure');
  } catch (error) {
    expect(error).toBeInstanceOf(InputError);
    if (field !== undefined) expect((error as InputError).message).toContain(field);
    if (code !== undefined) expect((error as InputError).code).toBe(code);
  }
}

describe('optionChainHealth independent finance and report grammar', () => {
  it('saves rich reports directly without a cast and round-trips their diagnostics', () => {
    const inputs: OptionChainHealthInput[] = [
      request(),
      request([]),
      request([quote({ contract: contract({ style: 'american' }) })]),
      {
        quotes: [quote({ bid: 9, ask: 7 })],
        market: { underlying: 'X', asOf: AS_OF },
        config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
      },
    ];
    for (const input of inputs) {
      const artifact = createAnalysisArtifact({
        artifactType: 'options.chain-health',
        producedBy: { operation: 'optionChainHealth' },
        // Compile regression: this must remain assignable to Record<string, unknown> with no cast.
        result: optionChainHealth(input),
      });
      const restored = readAnalysisArtifact({
        artifact: fromCanonicalJson(canonicalJsonOf(artifact)),
      });
      expect(restored.artifact.id).toBe(artifact.id);
      expect(canonicalJsonOf(restored.artifact.result)).toBe(
        canonicalJsonOf(optionChainHealth(input)),
      );
    }
  });

  it('inverts an independently specified one-year ATM premium and checks exact hand-calculated coverage', () => {
    const report = optionChainHealth(request());
    const row = report.rows[0]!;
    // For S=K=100 and r=q=0, C=200*N(sigma/2)-100. C=8 -> N(sigma/2)=0.54.
    // Independent inverse-normal value: 2 * Phi^-1(0.54) = 0.2008674410229395.
    expect(row.model.impliedVolatility).toBeCloseTo(0.2008674410229395, 8);
    expect(row.model.bounds).toEqual({ lower: 0, upper: 100 });
    expect(row.model.solver).toMatchObject({
      converged: true,
      status: 'converged',
      method: 'brent',
      reason: null,
    });
    expect(row.model.solver.priceResidual).toBeLessThan(1e-8);
    expect(row.ageMs).toBe(0);
    expect(row.selectedPrice).toBe(8);
    expect(row.spread).toBeCloseTo(0.2, 14);
    expect(row.relativeSpread).toBeCloseTo(0.025, 14);
    expect(row.timeToExpiryYears).toBe(1);
    expect(row.issues).toEqual([]);
    expect(report.coverage.expiries).toEqual([
      {
        expiresAt: resolvedExpiry(EXPIRY).expiresAt,
        style: 'european',
        expired: false,
        quoteCount: 1,
        selectedPriceCount: 1,
        solvedCount: 1,
        strikes: [100],
        callStrikes: [100],
        putStrikes: [],
        missingCallStrikes: [],
        missingPutStrikes: [100],
        belowMinimumStrikes: false,
      },
    ]);
    expect(report.coverage.missingContracts).toBeNull();
    expect(report.assumptions).toMatchObject({
      asOf: AS_OF,
      riskFreeRate: 0,
      dividendYield: 0,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      priceSource: 'mid',
      quotePolicy: 'report-only',
      priceUnit: 'per-underlying-share',
    });
    expect(report.diagnostics.warnings.some((w) => w.code.endsWith('sparse_coverage'))).toBe(true);
    expect(() => assertFiniteValue('test', report)).not.toThrow();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('runs the actual JSDoc example and its numeric assertions', () => {
    const source = readFileSync(new URL('../src/chain-health.ts', import.meta.url), 'utf8');
    const example = source
      .match(/@example\s+\* ```ts\n([\s\S]*?)\* ```/)![1]!
      .replace(/^\s*\* ?/gm, '')
      .replace(/import .*?;\n/, '');
    const runnable = transpileModule(example + '\nreturn report;', {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const result = new Function('option', 'optionChainHealth', runnable)(
      option,
      optionChainHealth,
    ) as OptionChainHealthReport;
    expect(result.summary.solvedCount).toBe(1);
  });

  it.each(['call', 'put'] as const)(
    'honors yield and negative rates for %s, including independent discounted bounds',
    (type) => {
      const input = request([quote({ contract: contract({ type, strike: 110 }) })]);
      input.market.riskFreeRate = -0.03;
      input.market.dividendYield = 0.06;
      const price = blackScholes.price({
        type,
        spot: 100,
        strike: 110,
        timeToExpiryYears: 1,
        riskFreeRate: -0.03,
        dividendYield: 0.06,
        volatility: 0.37,
      });
      input.quotes = [quote({ contract: contract({ type, strike: 110 }), bid: price, ask: price })];
      const row = first(input);
      const discountedSpot = 100 * Math.exp(-0.06);
      const discountedStrike = 110 * Math.exp(0.03);
      expect(row.model.bounds).toEqual({
        lower: Math.max(
          0,
          type === 'call' ? discountedSpot - discountedStrike : discountedStrike - discountedSpot,
        ),
        upper: type === 'call' ? discountedSpot : discountedStrike,
      });
      expect(row.model.impliedVolatility).toBeCloseTo(0.37, 8);
      input.market.dividendYield = 0;
      expect(first(input).model.impliedVolatility).not.toBeCloseTo(0.37, 3);
    },
  );

  it('uses the resolved expiry convention across DST and exact expiry, never a machine clock', () => {
    const input = request([quote({ contract: contract({ expiry: '2026-03-20' }) })]);
    input.market.asOf = '2026-03-20T19:00:00Z';
    expect(first(input).timeToExpiryYears).toBeCloseTo(1 / (24 * 365), 14);
    input.market.asOf = '2026-03-20T20:00:00Z';
    expect(first(input)).toMatchObject({
      timeToExpiryYears: 0,
      model: { status: 'not-evaluated', impliedVolatility: null, solver: { reason: 'expired' } },
    });
    input.market.asOf = '2026-03-21T00:00:00Z';
    expect(first(input).issues).toContain('expired');
  });

  it.each(['bid', 'ask', 'mid', 'last', 'mark'] as const)(
    'uses only the explicit %s price source',
    (priceSource) => {
      const input = request([quote({ mid: 9, last: 10, mark: 11 })]);
      input.config.priceSource = priceSource;
      expect(first(input).selectedPrice).toBe(
        { bid: 7.9, ask: 8.1, mid: 9, last: 10, mark: 11 }[priceSource],
      );
    },
  );

  it('never falls back to supplied IV, market volatility, last, or mark', () => {
    const input = request([
      { contract: contract(), timestampMs: AS_OF, last: 8, mark: 8, impliedVolatility: 0.2 },
    ]);
    expect(first(input)).toMatchObject({
      selectedPrice: null,
      model: { impliedVolatility: null, solver: { reason: 'missing_price' } },
    });
    malformed(
      { ...input, market: { ...input.market, volatility: 0.2 } },
      'volatility',
      ErrorCode.InputUnknownField,
    );
  });
});

describe('quote availability and model compatibility are distinct', () => {
  it('offers quote-only health with no spot, rate, yield, or model assumption and echoed coverage defaults', () => {
    const input: OptionChainHealthInput = {
      quotes: [quote({ bid: 9, ask: 7, contract: contract({ style: 'american' }) })],
      market: { underlying: 'X', asOf: AS_OF },
      config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
    };
    const report = optionChainHealth(input);
    expect(report.rows[0]!.issues).toEqual(['crossed']);
    expect(report.rows[0]!.model).toMatchObject({
      status: 'not-requested',
      bounds: null,
      impliedVolatility: null,
      unsupportedReasons: [],
      solver: { method: null, status: 'not-run', iterations: 0 },
    });
    expect(report.assumptions).toMatchObject({
      modelAssessment: 'not-requested',
      exercisePolicy: 'not-assessed',
      minimumExpiries: 1,
      minimumStrikesPerExpiry: 1,
      maximumSolverIterations: 0,
      lowerVolatilityBound: null,
      upperVolatilityBound: null,
    });
    for (const field of [
      'spot',
      'riskFreeRate',
      'dividendYield',
      'dividendModel',
      'model',
      'engine',
      'compounding',
    ])
      expect(report.assumptions).not.toHaveProperty(field);
    expect(report.summary.modelStatusCounts['not-requested']).toBe(1);
    expect(report.summary.solvedCount).toBe(0);
    expect(report.diagnostics.warnings.some((w) => w.code.endsWith('model_not_requested'))).toBe(
      true,
    );
    expect(
      report.diagnostics.warnings.some((w) => w.code.endsWith('implied_volatility_unavailable')),
    ).toBe(false);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('requires real model economics and refuses orphan solver controls', () => {
    const plain = {
      quotes: [quote()],
      market: { underlying: 'X', asOf: AS_OF },
      config: {
        priceSource: 'mid' as const,
        maximumQuoteAgeMs: 60_000,
        maximumRelativeSpread: 0.1,
      },
    };
    malformed({ ...plain, config: { ...plain.config, model: 'black-scholes-merton' } }, 'spot');
    malformed({ ...plain, config: { ...plain.config, solver: {} } }, 'solver');
    for (const field of ['spot', 'riskFreeRate', 'dividendYield'])
      for (const value of [null, NaN, Infinity, ''])
        malformed({ ...plain, market: { ...plain.market, [field]: value } }, field);
    // @ts-expect-error A model-enabled request requires spot, riskFreeRate, and dividendYield.
    const missingModelEconomics: OptionChainHealthInput = {
      ...plain,
      config: { ...plain.config, model: 'black-scholes-merton' },
    };
    const orphanSolver: OptionChainHealthInput = {
      ...plain,
      // @ts-expect-error A solver is not meaningful without model selection.
      config: { ...plain.config, solver: {} },
    };
    expect(missingModelEconomics.market).toEqual(orphanSolver.market);
  });

  it('defaults coverage minima for BSM without weakening null/zero/unknown control checks', () => {
    const input = request();
    delete input.config.minimumExpiries;
    delete input.config.minimumStrikesPerExpiry;
    const report = optionChainHealth(input);
    expect(report.assumptions.minimumExpiries).toBe(1);
    expect(report.assumptions.minimumStrikesPerExpiry).toBe(1);
    expect(report.coverage.belowMinimumExpiries).toBe(false);
    expect(report.coverage.expiries[0]!.belowMinimumStrikes).toBe(false);
    expect(report.summary.solvedCount).toBe(1);
  });

  it('reports strict stale/future thresholds and retains those quotes for disclosed model inversion', () => {
    const input = request([
      quote({ timestampMs: AS_OF - 60_000 }),
      quote({ timestampMs: AS_OF - 60_001 }),
      quote({ timestampMs: AS_OF + 1 }),
      { contract: contract(), bid: 7.9, ask: 8.1 },
    ]);
    const report = optionChainHealth(input);
    expect(report.rows.map((row) => row.issues)).toEqual([
      [],
      ['stale'],
      ['future'],
      ['missing_timestamp'],
    ]);
    expect(report.rows[3]!.timestampMs).toBeNull();
    expect(report.summary.issueCounts).toMatchObject({ stale: 1, future: 1, missing_timestamp: 1 });
    expect(report.summary.solvedCount).toBe(4);
    expect(report.coverage.duplicateQuoteCount).toBe(3);
  });

  it('reports crossed, wide, and exactly-threshold spreads without mutating or dropping rows', () => {
    const input = request([
      quote({ bid: 9, ask: 7 }),
      quote({ bid: 7, ask: 9 }),
      quote({ bid: 7, ask: 9.01 }),
    ]);
    input.config.maximumRelativeSpread = 0.25;
    const report = optionChainHealth(input);
    expect(report.rows.map((row) => row.issues)).toEqual([['crossed'], [], ['wide']]);
    expect(report.rows[0]!.model.solver.reason).toBe('crossed_market');
    expect(report.rows[0]!.model.bounds).toBeNull();
    expect(report.rows[2]!.model.solver.converged).toBe(true);
    expect(report.summary.quoteCount).toBe(3);
  });

  it('permits zero and absent quotes, with no fake inverse at unidentifiable boundaries', () => {
    const report = optionChainHealth(
      request([{ contract: contract() }, quote({ bid: 0, ask: 0 }), quote({ bid: 100, ask: 100 })]),
    );
    expect(report.rows[0]!.issues).toEqual([
      'missing_timestamp',
      'missing_bid',
      'missing_ask',
      'missing_price',
    ]);
    expect(report.rows[1]!.relativeSpread).toBeNull();
    expect(report.rows[1]!.selectedPrice).toBe(0);
    expect(report.rows[1]!.model).toMatchObject({
      status: 'compatible',
      impliedVolatility: null,
      solver: { reason: 'no_identifiable_time_value', status: 'unavailable' },
    });
    expect(report.rows[2]!.model.solver.reason).toBe('upper_bound_no_finite_implied_volatility');
    for (const row of report.rows) expect(row.diagnostics.warnings.length).toBeGreaterThan(0);
  });

  it('reports model-incompatible prices without calling them bad quotes', () => {
    const report = optionChainHealth(
      request([
        quote({ bid: 110, ask: 110 }),
        quote({ contract: contract({ strike: 90 }), bid: 1, ask: 1 }),
      ]),
    );
    expect(report.rows.map((row) => row.model.status)).toEqual([
      'model-incompatible',
      'model-incompatible',
    ]);
    expect(report.rows.map((row) => row.model.solver.reason)).toEqual([
      'above_model_upper_bound',
      'below_model_lower_bound',
    ]);
    expect(report.summary.quotesWithIssues).toBe(0);
    expect(report.summary.modelStatusCounts['model-incompatible']).toBe(2);
    expect(
      report.diagnostics.warnings.some((w) => w.message.includes('not proof of a bad quote')),
    ).toBe(true);
  });

  it('keeps a bracket failure separate from a model-bound violation', () => {
    const input = request();
    input.config.solver = { lowerVolatilityBound: 0.01, upperVolatilityBound: 0.1 };
    expect(first(input).model).toMatchObject({
      status: 'compatible',
      impliedVolatility: null,
      solver: { status: 'failed', converged: false, reason: 'no_bracket' },
    });
    input.config.solver = { lowerVolatilityBound: 0.3, upperVolatilityBound: 1 };
    expect(first(input).model.solver.reason).toBe('price_below_resolvable');
  });

  it('explicitly refuses cash schedules and adjusted deliverables independently, never exercise style', () => {
    const input = request([
      quote({ contract: contract({ style: 'american', adjusted: true, deliverable: {} }) }),
    ]);
    input.market.dividends = [{ exDate: '2026-02-01', amount: 1 }];
    const report = optionChainHealth(input);
    expect(report.rows[0]!.model).toMatchObject({
      status: 'unsupported',
      engine: 'bjerksund-stensland-2002',
      bounds: null,
      impliedVolatility: null,
      unsupportedReasons: ['discrete_dividends', 'adjusted_deliverable'],
      solver: { status: 'not-run', reason: 'unsupported_assumptions' },
    });
    expect(report.assumptions.dividends).toEqual(input.market.dividends);
    input.quotes = [quote()];
    expect(first(input).model.unsupportedReasons).toEqual(['discrete_dividends']);
    input.market.dividends = [];
    expect(first(input).model.solver.converged).toBe(true);
    // An American row is assessed under ITS style, not refused: no reason, a solved inverse.
    input.quotes = [quote({ contract: contract({ style: 'american' }) })];
    expect(first(input).model.unsupportedReasons).toEqual([]);
    expect(first(input).model.solver.converged).toBe(true);
  });

  it('assesses an American row inside the American band with the Bjerksund–Stensland engine', () => {
    // An American put priced by the engine itself at σ = 0.32 round-trips through the chain: the
    // report's bounds are the UNDISCOUNTED intrinsic-to-strike band (exercise is available now),
    // its inverse is the engine's, and the row names the engine it used.
    const put = contract({ type: 'put', style: 'american', strike: 110 });
    const asOf = AS_OF;
    const priced = engines.bjerksundStensland2002().price({
      contract: put,
      market: { spot: 100, riskFreeRate: 0.04, dividendYield: 0.01, volatility: 0.32, asOf },
    });
    const input = request([quote({ contract: put, bid: priced.value, ask: priced.value })]);
    input.market.riskFreeRate = 0.04;
    input.market.dividendYield = 0.01;
    const report = optionChainHealth(input);
    const row = report.rows[0]!;
    expect(row.model).toMatchObject({
      status: 'compatible',
      engine: 'bjerksund-stensland-2002',
      bounds: { lower: 10, upper: 110 },
      unsupportedReasons: [],
      solver: { status: 'converged', method: 'brent', converged: true, reason: null },
    });
    expect(row.model.impliedVolatility).toBeCloseTo(0.32, 6);
    expect(row.model.solver.priceResidual).toBeLessThanOrEqual(1e-7 * priced.value);
    expect(report.assumptions).toMatchObject({
      exercisePolicy: 'by-contract-style',
      exerciseEngines: { european: 'black-scholes-merton', american: 'bjerksund-stensland-2002' },
    });
    expect(report.assumptions).not.toHaveProperty('engine');
    // A European row in the same report keeps the closed-form engine and its discounted band.
    input.quotes = [quote()];
    expect(first(input).model).toMatchObject({ engine: 'black-scholes-merton' });
    expect(first(input).model.bounds!.upper).toBeCloseTo(100 * Math.exp(-0.01), 12);
    // Outside the American band the row is model-incompatible; at intrinsic it has no time value.
    input.quotes = [quote({ contract: put, bid: 9, ask: 9 })];
    expect(first(input).model).toMatchObject({
      status: 'model-incompatible',
      solver: { reason: 'below_model_lower_bound' },
    });
    input.quotes = [quote({ contract: put, bid: 10, ask: 10 })];
    expect(first(input).model).toMatchObject({
      status: 'compatible',
      solver: { status: 'unavailable', reason: 'no_identifiable_time_value' },
    });
    input.quotes = [quote({ contract: put, bid: 111, ask: 111 })];
    expect(first(input).model).toMatchObject({
      status: 'model-incompatible',
      solver: { reason: 'above_model_upper_bound' },
    });
    // The configured σ bracket is the row's resolvability window for American rows too.
    input.quotes = [quote({ contract: put, bid: priced.value, ask: priced.value })];
    input.config.solver = { lowerVolatilityBound: 0.5, upperVolatilityBound: 1 };
    expect(first(input).model.solver.reason).toBe('price_below_resolvable');
  });

  it('returns an honest empty report with or without an explicit expected universe', () => {
    const input = request([]);
    expect(optionChainHealth(input)).toMatchObject({
      rows: [],
      summary: { quoteCount: 0, solvedCount: 0 },
      coverage: {
        expiryCount: 0,
        belowMinimumExpiries: true,
        missingContracts: null,
        expectedContractCount: null,
      },
    });
    input.expectedContracts = [contract({ type: 'put' })];
    expect(optionChainHealth(input).coverage.missingContracts).toEqual(input.expectedContracts);
    input.expectedContracts = [];
    expect(optionChainHealth(input).coverage.missingContracts).toEqual([]);
  });

  it('measures observed distinct strikes/sides separately by style and identifies expected-universe gaps', () => {
    const later = contract({ expiry: '2027-06-01T00:00:00Z', strike: 120, type: 'put' });
    const input = request([
      quote({ contract: later }),
      quote({ contract: contract({ strike: 110, type: 'put' }) }),
      quote({ contract: contract() }),
      quote({ contract: contract({ style: 'american' }) }),
      quote({ contract: contract() }),
    ]);
    input.config.minimumExpiries = 3;
    input.config.minimumStrikesPerExpiry = 3;
    const missing = contract({ strike: 90 });
    input.expectedContracts = [later, missing, missing, contract()];
    const report = optionChainHealth(input);
    expect(report.coverage).toMatchObject({
      expiryCount: 2,
      belowMinimumExpiries: true,
      duplicateQuoteCount: 1,
      expectedContractCount: 3,
      missingContracts: [missing],
    });
    expect(report.coverage.expiries.map((expiry) => [expiry.style, expiry.strikes])).toEqual([
      ['american', [100]],
      ['european', [100, 110]],
      ['european', [120]],
    ]);
    expect(report.coverage.expiries[1]).toMatchObject({
      missingCallStrikes: [110],
      missingPutStrikes: [100],
      quoteCount: 3,
      belowMinimumStrikes: true,
    });
    input.quotes = [...input.quotes].reverse();
    input.expectedContracts = [...input.expectedContracts].reverse();
    expect(optionChainHealth(input).coverage).toEqual(report.coverage);
  });
});

describe('closed controls, open observations, and indexed malformed requests', () => {
  function replaceField(input: unknown, path: string, value: unknown): void {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let parent = input as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[keys.at(-1)!] = value;
  }

  function exactError(input: unknown, field: string, code: string): InputError {
    try {
      optionChainHealth(input as OptionChainHealthInput);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe(code);
      expect((error as InputError).context).toMatchObject({ function: 'optionChainHealth', field });
      return error as InputError;
    }
    throw new Error('Expected an indexed InputError');
  }

  it.each([
    ['config.maximumQuoteAgeMs', true],
    ['config.maximumRelativeSpread', true],
    ['config.minimumExpiries', false],
    ['config.minimumStrikesPerExpiry', false],
    ['config.maximumQuotes', false],
    ['config.solver.lowerVolatilityBound', false],
    ['config.solver.upperVolatilityBound', false],
    ['market.spot', true],
    ['market.riskFreeRate', true],
    // The package dividend rule: an omitted yield is 0 (echoed and disclosed), never a refusal.
    ['market.dividendYield', false],
    ['market.asOf', true],
    ['market.dividends[0].amount', true],
    ['quotes[0].contract.strike', true],
    ['quotes[0].contract.expiresAt', true],
    ['quotes[0].bid', false],
    ['quotes[0].ask', false],
    ['quotes[0].mid', false],
    ['quotes[0].last', false],
    ['quotes[0].mark', false],
    ['quotes[0].timestampMs', false],
    ['expectedContracts[0].strike', true],
    ['expectedContracts[0].expiresAt', true],
  ] as const)('uses the shared numeric error ladder at %s', (field, required) => {
    const cases: [unknown, string][] = [
      [null, ErrorCode.InputWrongType],
      [false, ErrorCode.InputWrongType],
      [{}, ErrorCode.InputWrongType],
      [[], ErrorCode.InputWrongType],
      [NaN, ErrorCode.InputNaN],
      [Infinity, ErrorCode.InputNotFinite],
      [-Infinity, ErrorCode.InputNotFinite],
    ];
    // Numeric asOf also accepts date strings; the other fields must reject numeric strings.
    if (field !== 'market.asOf') cases.push(['1', ErrorCode.InputWrongType]);
    if (required) cases.push([undefined, ErrorCode.InputMissingField]);
    for (const [value, code] of cases) {
      const input = request();
      input.config.solver = { lowerVolatilityBound: 0.01, upperVolatilityBound: 2 };
      input.market.dividends = [{ exDate: '2026-02-01', amount: 1 }];
      input.expectedContracts = [contract()];
      replaceField(input, field, value);
      const error = exactError(input, field, code);
      if (value === undefined) expect(error.message).toContain('e.g. optionChainHealth({');
    }
  });

  it('distinguishes missing required controls and contract fields from null or invalid values', () => {
    for (const field of [
      'quotes',
      'market',
      'config',
      'market.underlying',
      'config.priceSource',
      'quotes[0].contract',
      'quotes[0].contract.underlying',
      'quotes[0].contract.type',
      'quotes[0].contract.style',
      'quotes[0].contract.expiry',
      'quotes[0].contract.expiryConvention',
      'market.dividends[0].exDate',
    ]) {
      const input = request();
      input.market.dividends = [{ exDate: '2026-02-01', amount: 1 }];
      replaceField(input, field, undefined);
      exactError(input, field, ErrorCode.InputMissingField);
    }
    const absent = request();
    delete (absent.config as Partial<typeof absent.config>).maximumQuoteAgeMs;
    exactError(absent, 'config.maximumQuoteAgeMs', ErrorCode.InputMissingField);
  });

  it('never coerces malformed resolved-expiry primitives into an accidental exception', () => {
    const throwing = {
      toString() {
        throw new Error('must not coerce');
      },
      valueOf() {
        throw new Error('must not coerce');
      },
      [Symbol.toPrimitive]() {
        throw new Error('must not coerce');
      },
    };
    for (const prefix of ['quotes[0].contract', 'expectedContracts[0]']) {
      for (const field of ['expiresAt', 'expiryConvention']) {
        for (const value of [Object.create(null), { toString: 0, valueOf: 0 }, throwing]) {
          const input = request();
          input.expectedContracts = [contract()];
          replaceField(input, `${prefix}.${field}`, value);
          exactError(
            input,
            `${prefix}.${field}`,
            field === 'expiresAt' ? ErrorCode.InputWrongType : ErrorCode.InputInvalidEnum,
          );
        }
      }
    }
  });

  const garbage = [null, undefined, '', ' ', 1, true, [], new Float64Array(1)];
  it.each(garbage)('refuses malformed request containers: %s', (value) => malformed(value));
  it.each(['config', 'market'] as const)(
    'refuses malformed %s containers even for empty chains',
    (key) => {
      for (const value of garbage) malformed({ ...request([]), [key]: value }, key);
    },
  );

  it.each([
    'maximumQuoteAgeMs',
    'maximumRelativeSpread',
    'minimumExpiries',
    'minimumStrikesPerExpiry',
    'maximumQuotes',
  ] as const)('validates every numeric config field %s', (key) => {
    for (const value of [null, '', ' ', '1', NaN, Infinity, -Infinity, -1, false])
      malformed({ ...request([]), config: { ...request().config, [key]: value } }, key);
    if (key.startsWith('minimum') || key === 'maximumQuotes')
      for (const value of [0, 1.5, 10_001, Number.MAX_SAFE_INTEGER])
        malformed({ ...request([]), config: { ...request().config, [key]: value } }, key);
  });

  it.each(['spot', 'riskFreeRate', 'asOf', 'underlying'] as const)(
    'requires an explicit valid market.%s',
    (key) => {
      for (const value of [undefined, null, '', ' ', NaN, Infinity, -Infinity, false, {}])
        malformed({ ...request([]), market: { ...request().market, [key]: value } }, key);
    },
  );

  it('market.dividendYield may be omitted (the package rule: 0, echoed, disclosed) but never malformed', () => {
    for (const value of [null, '', ' ', NaN, Infinity, -Infinity, false, {}])
      malformed(
        { ...request([]), market: { ...request().market, dividendYield: value } },
        'dividendYield',
      );
    const report = optionChainHealth({
      ...request(),
      market: { underlying: 'X', spot: 100, riskFreeRate: 0, asOf: AS_OF },
    });
    expect(report.assumptions).toMatchObject({ dividendYield: 0, dividendModel: 'none' });
    expect(
      report.diagnostics.warnings.some((w) => w.code.endsWith('dividend_yield_defaulted')),
    ).toBe(true);
    expect(report.rows[0]!.model.solver.converged).toBe(true);
    // Quote-only health never assumes a yield: nothing is echoed and nothing is disclosed.
    const quoteOnly = optionChainHealth({
      quotes: [quote()],
      market: { underlying: 'X', asOf: AS_OF },
      config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
    });
    expect(quoteOnly.assumptions).not.toHaveProperty('dividendYield');
    expect(
      quoteOnly.diagnostics.warnings.some((w) => w.code.endsWith('dividend_yield_defaulted')),
    ).toBe(false);
  });

  it('teaches closed unknown keys, including nested empty-chain control typos', () => {
    const input = request([]);
    for (const bad of [
      { ...input, quotse: [] },
      { ...input, config: { ...input.config, maximumQuoteAge: 2 } },
      { ...input, market: { ...input.market, riskFreeRtae: 0.03 } },
      { ...input, config: { ...input.config, solver: { upperVolatiltiyBound: 2 } } },
    ])
      malformed(bad, undefined, ErrorCode.InputUnknownField);
    for (const value of [null, '', 'BSM', 'american', NaN])
      malformed({ ...input, config: { ...input.config, model: value } }, 'model');
    for (const value of [null, '', 'MID', 'midd', NaN])
      malformed({ ...input, config: { ...input.config, priceSource: value } }, 'priceSource');
  });

  it('validates optional solver shape, bounds and wrong-type/null fields before availability exits', () => {
    for (const solver of [
      null,
      [],
      '',
      false,
      new Date(0),
      new Map(),
      new Set(),
      new Float64Array(),
      { lowerVolatilityBound: null },
      { upperVolatilityBound: '' },
      { lowerVolatilityBound: NaN },
      { upperVolatilityBound: Infinity },
      { lowerVolatilityBound: 0 },
      { lowerVolatilityBound: 2, upperVolatilityBound: 1 },
    ])
      malformed({ ...request([]), config: { ...request().config, solver } }, 'solver');
  });

  it('reports structural row errors with their index, including all consumed price sources', () => {
    for (const bad of [null, undefined, [], 3, ''])
      malformed(request([quote(), bad as unknown as OptionChainHealthQuote]), 'quotes[1]');
    for (const field of ['bid', 'ask', 'mid', 'last', 'mark', 'timestampMs'])
      for (const value of [null, '', ' ', '1', NaN, Infinity, -Infinity])
        malformed(request([quote(), { ...quote(), [field]: value }]), `quotes[1].${field}`);
    for (const field of ['bid', 'ask', 'mid', 'last', 'mark'])
      malformed(request([{ ...quote(), [field]: -1 }]), field);
  });

  it('validates canonical contract identity, exercise, and expiry-resolution consistency', () => {
    for (const [field, value] of [
      ['underlying', ' '],
      ['underlying', 'Y'],
      ['style', undefined],
      ['style', 'bermudan'],
      ['type', 'Call'],
      ['strike', 0],
      ['strike', NaN],
      ['strike', null],
      ['expiry', ''],
      ['expiry', '2027-02-30'],
      ['expiry', '2027-01-01T00:00:00'],
      ['expiresAt', undefined],
      ['expiresAt', AS_OF],
      ['expiryConvention', 'us-equity-close'],
      ['adjusted', null],
      ['adjusted', 0],
      ['deliverable', null],
      ['deliverable', []],
    ])
      malformed(
        request([quote({ contract: { ...contract(), [field as string]: value } })]),
        'quotes[0].contract',
      );
    malformed({ ...request(), expectedContracts: [contract(), null] }, 'expectedContracts[1]');
  });

  it('validates dividend observations even for unsupported or empty chains', () => {
    for (const dividends of [
      null,
      {},
      [null],
      [undefined],
      [{ exDate: '', amount: 1 }],
      [{ exDate: '2026-02-30', amount: 1 }],
      [{ exDate: '2026-02-01', amount: null }],
      [{ exDate: '2026-02-01', amount: Infinity }],
      [{ exDate: '2026-02-01', amount: -1 }],
    ])
      malformed({ ...request([]), market: { ...request().market, dividends } }, 'dividends');
  });

  it('accepts decoration without traversing, serializing, or exposing it', () => {
    const input = request();
    const row = input.quotes[0]!;
    Object.defineProperty(row, 'vendorMetadata', {
      enumerable: true,
      get() {
        throw new Error('must not read vendor metadata');
      },
    });
    Object.defineProperty(row.contract, 'notes', {
      enumerable: true,
      get() {
        throw new Error('must not read decoration');
      },
    });
    // These canonical fields are not consumed: this report neither uses nor certifies vendor IV/Greeks.
    Object.assign(row, {
      impliedVolatility: NaN,
      volume: { provider: true },
      greekSource: undefined,
    });
    const report = optionChainHealth(input);
    expect(report.summary.solvedCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('vendorMetadata');
  });

  it('is deterministic, does not read the clock, and owns all returned data', () => {
    const input = request();
    input.expectedContracts = [contract({ strike: 110 })];
    Object.freeze(input.quotes[0]!.contract);
    Object.freeze(input.quotes[0]);
    Object.freeze(input.quotes);
    Object.freeze(input.config);
    Object.freeze(input.market);
    Object.freeze(input.expectedContracts[0]);
    Object.freeze(input.expectedContracts);
    Object.freeze(input);
    const before = JSON.stringify(input);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock forbidden');
    });
    try {
      const a = optionChainHealth(input);
      expect(optionChainHealth(input)).toEqual(a);
      a.rows[0]!.contract.strike = 42;
      a.coverage.missingContracts![0]!.strike = 43;
      expect(JSON.stringify(input)).toBe(before);
      expect(first(input).contract.strike).toBe(100);
    } finally {
      now.mockRestore();
    }
  });
});

describe('bounded work and finite results under adversarial scales', () => {
  it('does not mistake rounded subnormal midpoints for an accurate spread ratio', () => {
    const input: OptionChainHealthInput = {
      quotes: [quote({ bid: Number.MIN_VALUE, ask: 4 * Number.MIN_VALUE })],
      market: { underlying: 'X', asOf: AS_OF },
      config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 1.1 },
    };
    expect(first(input)).toMatchObject({
      // 2.5 minimum units rounds to the even representable value: 2 units.
      selectedPrice: 2 * Number.MIN_VALUE,
      relativeSpread: 1.2,
      issues: ['wide'],
    });
    input.config.maximumRelativeSpread = 1.2;
    expect(first(input).issues).toEqual([]);
    input.quotes = [quote({ bid: 0, ask: Number.MIN_VALUE })];
    expect(first(input)).toMatchObject({ selectedPrice: 0, relativeSpread: 2, issues: ['wide'] });
    input.quotes = [quote({ bid: Number.MAX_VALUE / 2, ask: Number.MAX_VALUE })];
    expect(first(input).relativeSpread).toBeCloseTo(2 / 3, 15);
    expect(Number.isFinite(first(input).selectedPrice)).toBe(true);
  });

  it('property: quote-only spread ratios and wide flags survive subnormal-to-large price rescaling', () => {
    for (const scale of [Number.MIN_VALUE, 2 ** -1022, 2 ** -100, 1, 2 ** 100, 2 ** 1000]) {
      for (let bidUnits = 0; bidUnits <= 16; bidUnits++) {
        for (let askUnits = Math.max(1, bidUnits); askUnits <= 16; askUnits++) {
          const input: OptionChainHealthInput = {
            quotes: [quote({ bid: bidUnits * scale, ask: askUnits * scale })],
            market: { underlying: 'X', asOf: AS_OF },
            config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.73 },
          };
          const row = first(input);
          // Independent dimensionless integer oracle, with no price midpoint to overflow/underflow.
          const expected = (2 * (askUnits - bidUnits)) / (askUnits + bidUnits);
          expect(row.relativeSpread).toBeCloseTo(expected, 14);
          expect(row.issues.includes('wide')).toBe(expected > 0.73);
          expect(Number.isFinite(row.selectedPrice)).toBe(true);
        }
      }
    }
  });

  it('rejects sparse arrays and typed arrays, including inherited numeric slots', () => {
    malformed(request(new Array(2) as OptionChainHealthQuote[]), 'quotes[0]');
    const input = request();
    const sparse = new Array(2);
    Object.setPrototypeOf(sparse, { 0: quote(), 1: quote() });
    malformed({ ...input, quotes: sparse }, 'quotes[0]');
    malformed({ ...input, quotes: new Float64Array(1) }, 'quotes');
    malformed({ ...input, expectedContracts: new Array(1) }, 'expectedContracts[0]');
    malformed({ ...input, market: { ...input.market, dividends: new Array(1) } }, 'dividends[0]');
  });

  it('refuses every oversized array before accessing any observation', () => {
    const poisoned = new Array(10_001);
    Object.defineProperty(poisoned, 0, {
      get() {
        throw new Error('length must be checked first');
      },
    });
    malformed({ ...request(), quotes: poisoned }, 'quotes');
    const rows = [quote()];
    Object.defineProperty(rows, 0, {
      get() {
        throw new Error('no row traversal before all budgets');
      },
    });
    malformed({ ...request(rows), expectedContracts: poisoned }, 'expectedContracts');
    malformed(
      { ...request(rows), market: { ...request().market, dividends: new Array(1_001) } },
      'dividends',
    );
    malformed(
      { ...request([quote(), quote()]), config: { ...request().config, maximumQuotes: 1 } },
      'quotes',
    );
  });

  it('accepts the exact hard row limit and never silently truncates', () => {
    const report = optionChainHealth(
      request(Array.from({ length: 10_000 }, () => ({ contract: contract() }))),
    );
    expect(report.rows).toHaveLength(10_000);
    expect(report.summary.issueCounts.missing_price).toBe(10_000);
    expect(report.coverage.duplicateQuoteCount).toBe(9_999);
  });

  it('bounds text and epoch coordinates before expensive parsing or unsafe elapsed-time arithmetic', () => {
    malformed(
      { ...request(), market: { ...request().market, underlying: 'x'.repeat(257) } },
      'underlying',
    );
    malformed({ ...request(), market: { ...request().market, asOf: 'x'.repeat(257) } }, 'asOf');
    malformed(request([quote({ contract: { ...contract(), expiry: 'x'.repeat(257) } })]), 'expiry');
    malformed({ ...request(), market: { ...request().market, asOf: Number.MAX_VALUE } }, 'asOf');
    malformed(request([quote({ timestampMs: -Number.MAX_VALUE })]), 'timestampMs');
  });

  it('does not overflow a midpoint or leak non-finite model bounds/results', () => {
    const input = request([quote({ bid: Number.MAX_VALUE, ask: Number.MAX_VALUE })]);
    expect(first(input).selectedPrice).toBe(Number.MAX_VALUE);
    input.quotes = [quote({ bid: Number.MIN_VALUE, ask: Number.MIN_VALUE })];
    expect(first(input).selectedPrice).toBe(Number.MIN_VALUE);
    expect(first(input).relativeSpread).toBe(0);
    input.quotes = [quote()];
    input.market.riskFreeRate = -Number.MAX_VALUE;
    input.market.dividendYield = -Number.MAX_VALUE;
    const report = optionChainHealth(input);
    expect(report.rows[0]!.model).toMatchObject({
      status: 'unavailable',
      bounds: null,
      impliedVolatility: null,
      solver: { reason: 'non_finite_or_underflowed_model_bounds' },
    });
    expect(() => assertFiniteValue('test', report)).not.toThrow();
    input.market.dividendYield = 0;
    expect(first(input).model.status).toBe('unavailable');
  });

  it('keeps extreme finite financial inputs and solver brackets finite or explicitly unavailable', () => {
    for (const spot of [Number.MIN_VALUE, 1e-100, 100, 1e100, Number.MAX_VALUE]) {
      for (const riskFreeRate of [-1e100, -0.05, 0, 0.05, 1e100]) {
        const input = request();
        input.market.spot = spot;
        input.market.riskFreeRate = riskFreeRate;
        input.config.solver = {
          lowerVolatilityBound: Number.MIN_VALUE,
          upperVolatilityBound: Number.MAX_VALUE,
        };
        const report = optionChainHealth(input);
        expect(() => assertFiniteValue('test', report)).not.toThrow();
        expect(report.rows[0]!.model.solver.iterations).toBeLessThanOrEqual(100);
      }
    }
  });
});
