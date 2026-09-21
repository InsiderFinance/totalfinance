import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type Schema, schema } from '@totalfinance/core/schema';
import {
  type McpServerOptions,
  type TotalFinanceTool,
  createTotalFinanceMcpServer,
  defaultTools,
  optionsPack,
} from '@totalfinance/mcp';

async function connect(options?: McpServerOptions) {
  const server = createTotalFinanceMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** The tool's own structured output — the `structured` slot of the OperationResult envelope (B2). */
function structuredOf(result: unknown): unknown {
  return (result as { structuredContent: { structured: unknown } }).structuredContent.structured;
}

describe('TotalFinance MCP server', () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect();
  });

  it('lists the read-only compute tools with generated input schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('totalfinance_option_price');
    expect(names).toContain('totalfinance_option_greeks');
    expect(names).toContain('totalfinance_option_implied_volatility');
    expect(names).toContain('totalfinance_technical_analysis_calculate');
    expect(names).toContain('totalfinance_technical_analysis_list');
    expect(names).toContain('totalfinance_technical_analysis_describe');
    expect(names).toContain('totalfinance_strategy_analyze');
    expect(names).toContain('totalfinance_volatility_expected_move');
    expect(names).toContain('totalfinance_volatility_probability_in_the_money');
    expect(names).toContain('totalfinance_volatility_probability_of_touch');
    expect(names).toContain('totalfinance_structure_exposures');
    expect(names).toContain('totalfinance_risk_value_at_risk');

    const price = tools.find((t) => t.name === 'totalfinance_option_price');
    expect(price?.inputSchema?.type).toBe('object');
    expect(price?.inputSchema?.required).toContain('spot');
  });

  it('prices an option and returns structured content with assumptions', async () => {
    const res = await client.callTool({
      name: 'totalfinance_option_price',
      arguments: {
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
        type: 'call',
      },
    });
    const structured = structuredOf(res) as {
      value: number;
      assumptions: { model: string };
      diagnostics: { converged: boolean };
    };
    expect(structured.value).toBeCloseTo(10.4506, 4);
    expect(structured.assumptions.model).toBe('black-scholes-merton');
    expect(structured.diagnostics.converged).toBe(true);
  });

  it('solves implied volatility round-trip', async () => {
    const res = await client.callTool({
      name: 'totalfinance_option_implied_volatility',
      arguments: {
        price: 10.450583572185565,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
      },
    });
    const structured = structuredOf(res) as { value: number; converged: boolean };
    expect(structured.converged).toBe(true);
    expect(structured.value).toBeCloseTo(0.2, 6);
  });

  it('exposes the IV method suite and echoes the method actually used', async () => {
    const res = await client.callTool({
      name: 'totalfinance_option_implied_volatility',
      arguments: {
        price: 10.450583572185565,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
        method: 'newton',
        fallback: false,
      },
    });
    const structured = structuredOf(res) as {
      value: number;
      converged: boolean;
      diagnostics: { method: string; fallback: boolean };
    };
    expect(structured.converged).toBe(true);
    expect(structured.value).toBeCloseTo(0.2, 6);
    expect(structured.diagnostics.method).toBe('newton');
    expect(structured.diagnostics.fallback).toBe(false);
  });

  // The IV input schema is COMPOSED from the library's option field descriptors (date-aware: t or
  // expiry+asOf) plus the tool-only method/fallback knobs — one source of truth, no drift-prone duplicate.
  it('implied_volatility input schema composes the library schema with the method suite', () => {
    const impliedVolatility = defaultTools().find(
      (t) => t.name === 'totalfinance_option_implied_volatility',
    )!;
    const js = impliedVolatility.schema.toJSONSchema();
    expect(Object.keys(js.properties ?? {})).toEqual(
      expect.arrayContaining([
        'price',
        'spot',
        'strike',
        'timeToExpiryYears',
        'riskFreeRate',
        'type',
        'dividendYield',
        'expiry', // F7: date-aware — supply t OR expiry + asOf
        'asOf',
        'method',
        'fallback',
      ]),
    );
    expect(js.required).toEqual(
      expect.arrayContaining(['price', 'spot', 'strike', 'riskFreeRate', 'type']),
    );
    // `t` is optional now: expiry + asOf can derive it (F7), so it is no longer a required field.
    expect(js.required).not.toContain('timeToExpiryYears');
    expect(js.required).not.toContain('method');
    expect(js.required).not.toContain('fallback');
    // Strict validation still teaches on base-field and extension-field violations alike.
    const bad = impliedVolatility.schema.safeParse(
      {
        price: 1,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
        bogus: 1,
      },
      { mode: 'strict' },
    );
    expect(bad.success).toBe(false);
    const badMethod = impliedVolatility.schema.safeParse(
      {
        price: 1,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
        method: 'sorcery',
      },
      { mode: 'strict' },
    );
    expect(badMethod.success).toBe(false);
  });

  it('option tools are date-aware: expiry + asOf derive t, echoed in assumptions (F7)', () => {
    const price = defaultTools().find((t) => t.name === 'totalfinance_option_price')!;
    // Dates instead of a hand-computed year fraction: ~31 days ⇒ t ≈ 31/365.
    const byDates = price.run({
      type: 'call',
      spot: 100,
      strike: 105,
      expiry: '2026-08-14',
      asOf: '2026-07-14T00:00:00Z',
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    const assumptions = byDates.structured['assumptions'] as {
      timeToExpiryYears: number;
      asOf: number;
      expiryConvention: string;
    };
    const t = assumptions.timeToExpiryYears;
    // ~31 days, plus the intraday offset (expiry 16:00 ET vs asOf UTC-midnight); echoed, not hidden.
    expect(t).toBeGreaterThan(31 / 365);
    expect(t).toBeLessThan(32 / 365);
    // Correction pass C3 (P1.6): the resolved temporal metadata is ECHOED — the agent sees the
    // asOf that was used and the named expiry-resolution convention, not just a bare t.
    expect(assumptions.asOf).toBe(Date.UTC(2026, 6, 14));
    expect(assumptions.expiryConvention).toBe('us-equity-close');
    // The resolved t is what actually drives pricing: a direct t-based call reproduces it exactly.
    const byT = price.run({
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: t,
      riskFreeRate: 0.045,
      volatility: 0.22,
    });
    expect(byT.structured['value']).toBeCloseTo(byDates.structured['value'] as number, 10);
    // t and dates are mutually exclusive; neither is an error too.
    expect(() =>
      price.run({
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 0.1,
        expiry: '2026-08-14',
        asOf: '2026-07-14T00:00:00Z',
        riskFreeRate: 0.045,
        volatility: 0.22,
      }),
    ).toThrow(/either timeToExpiryYears .* or expiry \+ asOf/);
    expect(() =>
      price.run({ type: 'call', spot: 100, strike: 105, riskFreeRate: 0.045, volatility: 0.22 }),
    ).toThrow(/provide timeToExpiryYears .* or both expiry and asOf/);
    expect(() =>
      price.run({
        type: 'call',
        spot: 100,
        strike: 105,
        expiry: '2026-08-14',
        riskFreeRate: 0.045,
        volatility: 0.22,
      }),
    ).toThrow(/both expiry and asOf/);
  });

  it('returns a validation error (not a throw) for bad input', async () => {
    const res = await client.callTool({
      name: 'totalfinance_option_price',
      arguments: {
        spot: -100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
        type: 'call',
      },
    });
    expect(res.isError).toBe(true);
    const text = Array.isArray(res.content) ? (res.content[0] as { text: string }).text : '';
    expect(text).toMatch(/spot/);
  });

  it('reports non-convergence as null (JSON-safe), not NaN, with the failure in diagnostics', async () => {
    const res = await client.callTool({
      name: 'totalfinance_option_implied_volatility',
      arguments: {
        price: 0.01,
        spot: 200,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
      },
    });
    const structured = structuredOf(res) as {
      value: number | null;
      converged: boolean;
      diagnostics: { warnings: { code: string }[] };
    };
    expect(res.isError).toBeFalsy();
    expect(structured.converged).toBe(false);
    // Non-finite results are normalized to null so the structured content stays schema-valid; the
    // one text block is the summary, never a second JSON copy (B2).
    expect(structured.value).toBeNull();
    expect(res.content).toHaveLength(1);
    expect(structured.diagnostics.warnings[0]?.code).toBe('implied_volatility.below_intrinsic');
  });

  it('exported tools are JSON-safe at the source (direct run() returns null, not NaN)', () => {
    // A direct `defaultTools().run()` (not server-wrapped) must already match the advertised schema.
    const impliedVolatility = defaultTools().find(
      (t) => t.name === 'totalfinance_option_implied_volatility',
    )!;
    const out = impliedVolatility.run({
      price: 0.01,
      spot: 200,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      type: 'call',
    });
    expect((out.structured as { value: number | null }).value).toBeNull();
    const ta = defaultTools().find((t) => t.name === 'totalfinance_technical_analysis_calculate')!;
    const taOut = ta.run({ indicator: 'sma', closes: [1, 2, 3, 4, 5], parameters: { period: 3 } });
    const values = (taOut.structured as { value: (number | null)[] }).value;
    expect(values[0]).toBeNull(); // warmup is null, not NaN
    expect(values.every((v) => v === null || Number.isFinite(v))).toBe(true);
  });

  it('exposes tool and named schema resources', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    // Per spec §2603, per-tool input schemas live at .../tool/{name}/input (not the bare path).
    expect(uris).toContain('totalfinance://schema/tool/totalfinance_option_price/input');
    expect(uris).not.toContain('totalfinance://schema/tool/totalfinance.option.price');
    expect(uris).toContain('totalfinance://schema/option-contract');
    expect(uris).toContain('totalfinance://policy/seed');

    const read = await client.readResource({ uri: 'totalfinance://schema/option-contract' });
    expect(JSON.parse((read.contents[0] as { text: string }).text).type).toBe('object');

    const toolInput = await client.readResource({
      uri: 'totalfinance://schema/tool/totalfinance_option_price/input',
    });
    expect(JSON.parse((toolInput.contents[0] as { text: string }).text).type).toBe('object');

    const seed = await client.readResource({ uri: 'totalfinance://policy/seed' });
    expect(JSON.parse((seed.contents[0] as { text: string }).text).policy).toBe('deterministic');
  });

  it('calculates a technical indicator with a warmup-aligned series', async () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const res = await client.callTool({
      name: 'totalfinance_technical_analysis_calculate',
      arguments: { indicator: 'sma', closes, parameters: { period: 5 } },
    });
    const structured = structuredOf(res) as {
      indicator: string;
      value: number[];
      assumptions: { parameters: Record<string, unknown> };
      diagnostics: { warmup: number };
    };
    expect(structured.indicator).toBe('sma');
    expect(structured.diagnostics.warmup).toBe(4);
    expect(structured.assumptions.parameters).toEqual({ period: 5 });
    expect(structured.value).toHaveLength(30);
  });

  it('rejects an oversized TA input', async () => {
    const closes = new Array(6000).fill(1);
    const res = await client.callTool({
      name: 'totalfinance_technical_analysis_calculate',
      arguments: { indicator: 'sma', closes, parameters: { period: 5 } },
    });
    expect(res.isError).toBe(true);
  });

  // DX5.1 — `technical_analysis.calculate` is registry-driven: the enum and the dispatch both come from the
  // `@totalfinance/technical-analysis` registry, so it covers all ~335 indicators (not a hardcoded handful).
  it('technical_analysis.calculate dispatches indicators beyond the legacy hardcoded set (dema)', () => {
    const taCalc = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_calculate',
    )!;
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i));
    const out = taCalc.run({ indicator: 'dema', closes, parameters: { period: 5 } });
    const structured = out.structured as {
      indicator: string;
      category: string;
      inputs: string;
      warmup: number;
      value: (number | null)[];
    };
    expect(structured.indicator).toBe('dema');
    expect(structured.category).toBe('moving-average');
    expect(structured.inputs).toBe('series');
    expect(structured.value).toHaveLength(30);
    expect(structured.value[0]).toBeNull(); // warmup is null, not NaN
    expect(structured.value.every((v) => v === null || Number.isFinite(v))).toBe(true);
  });

  it('technical_analysis.calculate builds bars from parallel `series` columns for bar indicators (atr)', () => {
    const taCalc = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_calculate',
    )!;
    const n = 30;
    const high = Array.from({ length: n }, (_, i) => 101 + i);
    const low = Array.from({ length: n }, (_, i) => 99 + i);
    const close = Array.from({ length: n }, (_, i) => 100 + i);
    const out = taCalc.run({
      indicator: 'atr',
      series: { high, low, close },
      parameters: { period: 14 },
    });
    const structured = out.structured as { indicator: string; inputs: string; value: unknown[] };
    expect(structured.indicator).toBe('atr');
    expect(structured.inputs).toBe('bars');
    expect(structured.value).toHaveLength(n);
  });

  it('technical_analysis.calculate teaches (does not silently NaN) on mismatched `series` column lengths', () => {
    const taCalc = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_calculate',
    )!;
    expect(() =>
      taCalc.run({ indicator: 'atr', series: { high: [1, 2, 3], low: [1], close: [1, 2, 3] } }),
    ).toThrow(/column `low` has length 1, expected 3/);
  });

  it('technical_analysis.calculate handles pair indicators via `x`/`y` (correl)', () => {
    const taCalc = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_calculate',
    )!;
    const x = Array.from({ length: 30 }, (_, i) => i + Math.sin(i));
    const y = Array.from({ length: 30 }, (_, i) => i * 1.5 - Math.cos(i));
    const out = taCalc.run({ indicator: 'correl', x, y, parameters: { period: 10 } });
    const structured = out.structured as { indicator: string; inputs: string; value: unknown[] };
    expect(structured.indicator).toBe('correl');
    expect(structured.inputs).toBe('pair');
    expect(structured.value).toHaveLength(30);
  });

  it('technical_analysis.calculate throws a teaching error naming the field the indicator needs', () => {
    const taCalc = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_calculate',
    )!;
    // `atr` is a bars indicator; passing only `closes` should teach that it needs `bars`.
    expect(() => taCalc.run({ indicator: 'atr', closes: [1, 2, 3] })).toThrow(/needs `bars`/);
  });

  it('technical_analysis.list discovers the full registry and filters by category', () => {
    const taListTool = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_list',
    )!;
    const all = taListTool.run({ limit: 1_000 });
    const allStructured = all.structured as {
      count: number;
      indicators: { name: string; category: string; inputs: string; parameters: string[] }[];
    };
    expect(allStructured.count).toBeGreaterThan(100);
    expect(allStructured.count).toBe(allStructured.indicators.length);
    expect(allStructured.indicators.find((i) => i.name === 'dema')?.category).toBe(
      'moving-average',
    );

    const mas = taListTool.run({ category: 'moving-average', limit: 1_000 });
    const masStructured = mas.structured as { count: number; indicators: { category: string }[] };
    expect(masStructured.count).toBeGreaterThan(0);
    expect(masStructured.count).toBeLessThan(allStructured.count);
    expect(masStructured.indicators.every((i) => i.category === 'moving-average')).toBe(true);
  });

  it('technical_analysis.list is registered and callable over the wire', async () => {
    const res = await client.callTool({
      name: 'totalfinance_technical_analysis_list',
      arguments: {},
    });
    const structured = structuredOf(res) as { count: number; total: number };
    // B2: the default page is 50 rows of a registry `total` above 100 — search first, then page.
    expect(structured.count).toBe(50);
    expect(structured.total).toBeGreaterThan(100);
  });

  it('technical_analysis.list searches by name/alias and paginates with a full total', () => {
    const taListTool = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_list',
    )!;
    // The default page is 50 (B2); an explicit limit above the registry size returns it whole.
    const defaultPage = taListTool.run({}).structured as { count: number; total: number };
    expect(defaultPage.count).toBe(50);
    expect(defaultPage.total).toBeGreaterThan(defaultPage.count);
    const all = taListTool.run({ limit: 1_000 }).structured as { count: number; total: number };
    expect(all.count).toBe(all.total);

    // Alias search: "MACD" (a TA-Lib name) finds the macd family.
    const search = taListTool.run({ search: 'MACD' }).structured as {
      total: number;
      indicators: { name: string }[];
    };
    expect(search.indicators.some((i) => i.name === 'macd')).toBe(true);
    expect(search.total).toBe(search.indicators.length);

    // Pagination: a page smaller than the total, with the total disclosed.
    const page = taListTool.run({ limit: 5, offset: 0 }).structured as {
      count: number;
      total: number;
      offset: number;
      indicators: unknown[];
    };
    expect(page.count).toBe(5);
    expect(page.total).toBe(all.total);
    expect(page.offset).toBe(0);
    expect(page.indicators.length).toBe(5);
  });

  it('technical_analysis.describe returns one indicator’s full card, alias-aware, with warmup', () => {
    const taDescribe = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_describe',
    )!;
    const out = taDescribe.run({ name: 'RSI' }); // TA-Lib alias → canonical
    const s = out.structured as {
      name: string;
      category: string;
      inputs: string;
      parameters: string[];
      defaults: Record<string, unknown>;
      required: string[];
      warmup: number | null;
      aliases?: { talib?: string };
    };
    expect(s.name).toBe('rsi');
    expect(s.category).toBe('momentum');
    expect(s.inputs).toBe('series');
    expect(s.defaults['period']).toBe(14);
    expect(s.warmup).toBe(14);
    expect(s.aliases?.talib).toBe('RSI');
    expect(out.summary).toContain('rsi');
    expect(out.summary).toContain('warmup');
  });

  it('technical_analysis.describe throws on an unknown indicator', () => {
    const taDescribe = defaultTools().find(
      (t) => t.name === 'totalfinance_technical_analysis_describe',
    )!;
    expect(() => taDescribe.run({ name: 'not-a-real-indicator' })).toThrowError();
  });

  it('technical_analysis.describe is registered and callable over the wire', async () => {
    const res = await client.callTool({
      name: 'totalfinance_technical_analysis_describe',
      arguments: { name: 'macd' },
    });
    const structured = structuredOf(res) as { name: string; warmup: number | null };
    expect(structured.name).toBe('macd');
    expect(structured.warmup).not.toBeUndefined();
  });

  // DX5 — the flagship: an iron condor's P&L and probability-of-profit from strikes ALONE,
  // over MCP. `premiums: 'model'` prices every unpriced leg from the market snapshot.
  const condorLegs = [
    { kind: 'put', strike: 540, quantity: 1 },
    { kind: 'put', strike: 550, quantity: -1 },
    { kind: 'call', strike: 590, quantity: -1 },
    { kind: 'call', strike: 600, quantity: 1 },
  ];
  const condorMarket = {
    spot: 570,
    volatility: 0.18,
    riskFreeRate: 0.045,
    asOf: '2026-07-06T00:00:00Z',
    expiry: '2026-08-21',
  };

  it('strategy.analyze prices an iron condor from strikes alone and reports PoP', () => {
    const analyze = defaultTools().find((t) => t.name === 'totalfinance_strategy_analyze')!;
    const out = analyze.run({
      legs: condorLegs,
      premiums: 'model',
      market: condorMarket,
      probability: true,
    });
    const structured = out.structured as {
      premiumSource: string;
      metrics: { maxProfit: number; maxLoss: number; breakevens: number[] };
      legs: { premium: number }[];
      probability: {
        probabilityOfProfit: number;
        assumptions: { marketSource: string };
        marketSource?: string;
      };
      diagnostics: { warnings: unknown[] };
    };
    expect(structured.premiumSource).toBe('model');
    // Every leg was priced from the market (no fills supplied).
    expect(structured.legs.every((l) => l.premium > 0)).toBe(true);
    expect(structured.metrics.breakevens.length).toBeGreaterThan(0);
    expect(Number.isFinite(structured.metrics.maxProfit)).toBe(true);
    expect(Number.isFinite(structured.metrics.maxLoss)).toBe(true);
    expect(structured.probability.probabilityOfProfit).toBeGreaterThan(0);
    expect(structured.probability.probabilityOfProfit).toBeLessThan(1);
    // Where the market came from rides `probability.assumptions.marketSource` (R2, not hoisted).
    expect(structured.probability.assumptions.marketSource).toBe('construction');
    expect(structured.probability.marketSource).toBeUndefined();
    // Envelope law (dx §2.8): the payload carries diagnostics (empty warnings when clean).
    expect(Array.isArray(structured.diagnostics.warnings)).toBe(true);
  });

  it('strategy.analyze reports premiumSource: user when premiums are supplied', () => {
    const analyze = defaultTools().find((t) => t.name === 'totalfinance_strategy_analyze')!;
    const out = analyze.run({ legs: [{ kind: 'call', strike: 100, quantity: 1, premium: 5 }] });
    expect((out.structured as { premiumSource: string }).premiumSource).toBe('user');
    // Envelope law: diagnostics ride even on the plain metrics path.
    expect(
      Array.isArray(
        (out.structured as { diagnostics: { warnings: unknown[] } }).diagnostics.warnings,
      ),
    ).toBe(true);
  });

  it('strategy.analyze teaches when probability: true is passed without market', () => {
    const analyze = defaultTools().find((t) => t.name === 'totalfinance_strategy_analyze')!;
    let caught: unknown;
    try {
      analyze.run({
        legs: [{ kind: 'call', strike: 100, quantity: 1, premium: 5, expiry: '2026-08-21' }],
        probability: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as InputError).message).toMatch(/`probability: true` requires `market`/);
    expect((caught as InputError).message).toMatch(/spot, volatility, riskFreeRate, asOf/);
  });

  it('strategy.analyze is callable over the wire with model premiums', async () => {
    const res = await client.callTool({
      name: 'totalfinance_strategy_analyze',
      arguments: { legs: condorLegs, premiums: 'model', market: condorMarket, probability: true },
    });
    const structured = structuredOf(res) as {
      premiumSource: string;
      probability: { probabilityOfProfit: number };
    };
    expect(res.isError).toBeFalsy();
    expect(structured.premiumSource).toBe('model');
    expect(structured.probability.probabilityOfProfit).toBeGreaterThan(0);
  });

  // DX5 — vol pack: the everyday options questions (expected move, P(ITM), P(touch)).
  it('volatility.expected_move implies the 1σ band from IV', () => {
    const em = defaultTools().find((t) => t.name === 'totalfinance_volatility_expected_move')!;
    // spot·σ·√t = 100·0.2·√0.25 = 10.
    const out = em.run({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 });
    const v = (out.structured as { value: { oneSigma: number; lower: number; upper: number } })
      .value;
    expect(v.oneSigma).toBeCloseTo(10, 6);
    expect(v.lower).toBeCloseTo(90, 6);
    expect(v.upper).toBeCloseTo(110, 6);
  });

  it('volatility.expected_move implies the move from the ATM straddle', () => {
    const em = defaultTools().find((t) => t.name === 'totalfinance_volatility_expected_move')!;
    const out = em.run({ spot: 100, straddlePrice: 8 });
    const v = (out.structured as { value: { oneSigma: number; expectedAbsolute: number } }).value;
    // oneSigma = straddle / √(2/π) ≈ 1.2533·8 ≈ 10.03; E|move| = the straddle itself.
    expect(v.oneSigma).toBeCloseTo(10.027, 2);
    expect(v.expectedAbsolute).toBeCloseTo(8, 6);
  });

  it('volatility.expected_move teaches when neither IV+t nor straddle is given', () => {
    const em = defaultTools().find((t) => t.name === 'totalfinance_volatility_expected_move')!;
    expect(() => em.run({ spot: 100 })).toThrow(/straddlePrice.*or.*impliedVolatility/i);
  });

  it('volatility.probability_in_the_money returns the risk-neutral N(±d2)', () => {
    const pitm = defaultTools().find(
      (t) => t.name === 'totalfinance_volatility_probability_in_the_money',
    )!;
    const call = pitm.run({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const put = pitm.run({
      type: 'put',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const cv = (call.structured as { value: number }).value;
    const pv = (put.structured as { value: number }).value;
    expect(cv).toBeGreaterThan(0.5); // positive carry → ATM call slightly ITM-favored
    expect(cv).toBeLessThan(1);
    expect(cv + pv).toBeCloseTo(1, 6); // N(d2) + N(−d2) = 1
  });

  it('volatility.probability_of_touch is a valid first-passage probability', () => {
    const pot = defaultTools().find(
      (t) => t.name === 'totalfinance_volatility_probability_of_touch',
    )!;
    const out = pot.run({
      spot: 100,
      barrier: 110,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const v = (out.structured as { value: number }).value;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    // Touching a level before expiry is at least as likely as finishing beyond it.
    const pitm = defaultTools().find(
      (t) => t.name === 'totalfinance_volatility_probability_in_the_money',
    )!;
    const finishAbove = (
      pitm.run({
        type: 'call',
        spot: 100,
        strike: 110,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
      }).structured as {
        value: number;
      }
    ).value;
    expect(v).toBeGreaterThanOrEqual(finishAbove);
  });

  it('volatility.expected_move is callable over the wire', async () => {
    const res = await client.callTool({
      name: 'totalfinance_volatility_expected_move',
      arguments: { spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 },
    });
    const v = (structuredOf(res) as { value: { oneSigma: number } }).value;
    expect(res.isError).toBeFalsy();
    expect(v.oneSigma).toBeCloseTo(10, 6);
  });

  // DX5 — structure pack: dealer GEX/DEX + levels from an option chain (the app's signature read).
  const sampleChain = () => {
    const rows: {
      strike: number;
      expiry: string;
      type: 'call' | 'put';
      openInterest: number;
      impliedVolatility: number;
    }[] = [];
    for (const strike of [90, 95, 100, 105, 110]) {
      rows.push({
        strike,
        expiry: '2026-08-21',
        type: 'call',
        openInterest: strike >= 105 ? 6000 : 2000,
        impliedVolatility: 0.25,
      });
      rows.push({
        strike,
        expiry: '2026-08-21',
        type: 'put',
        openInterest: strike <= 95 ? 6000 : 2000,
        impliedVolatility: 0.25,
      });
    }
    return rows;
  };

  it('structure.exposures computes GEX/DEX and levels from a chain', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_structure_exposures')!;
    const out = tool.run({
      chain: sampleChain(),
      spot: 100,
      riskFreeRate: 0.045,
      asOf: '2026-07-13T00:00:00Z',
      underlying: 'XYZ',
      style: 'american',
      convention: 'callsPositivePutsNegative',
    });
    const st = out.structured as {
      spot: number;
      atSpot: { gex: number; dex: number };
      levels: { callWall: number | null; putWall: number | null; maxPain: number | null };
      topStrikes: { strike: number; gex: number }[];
      assumptions: { convention: { name: string; calls: number; puts: number }; gammaUnit: string };
      diagnostics: { warnings: { code: string; message: string }[] };
    };
    expect(st.spot).toBe(100);
    expect(Number.isFinite(st.atSpot.gex)).toBe(true);
    expect(Number.isFinite(st.atSpot.dex)).toBe(true);
    // topStrikes: sorted by |GEX| descending, drawn from the chain's strikes.
    expect(st.topStrikes.length).toBeGreaterThan(0);
    for (let i = 1; i < st.topStrikes.length; i++) {
      expect(Math.abs(st.topStrikes[i - 1]!.gex)).toBeGreaterThanOrEqual(
        Math.abs(st.topStrikes[i]!.gex),
      );
    }
    expect(st.topStrikes.every((r) => [90, 95, 100, 105, 110].includes(r.strike))).toBe(true);
    // The honesty echo rides the R2 envelope: the sign convention in assumptions.convention, the
    // model limitations as `model.limitation` warnings in diagnostics.warnings — nothing hoisted.
    expect(st.assumptions.convention.name).toBeTruthy();
    expect(st.assumptions.gammaUnit).toBe('per1PercentMove');
    const limitations = st.diagnostics.warnings.filter((w) => w.code === 'model.limitation');
    expect(limitations.length).toBeGreaterThan(0);
    expect('maxPain' in st.levels).toBe(true);
  });

  it('structure.exposures caps topStrikes and implies IV from price when impliedVolatility is omitted', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_structure_exposures')!;
    const chain = [
      { strike: 95, expiry: '2026-08-21', type: 'call' as const, openInterest: 3000, price: 6.5 },
      { strike: 100, expiry: '2026-08-21', type: 'call' as const, openInterest: 4000, price: 3.2 },
      { strike: 100, expiry: '2026-08-21', type: 'put' as const, openInterest: 4000, price: 2.8 },
      { strike: 105, expiry: '2026-08-21', type: 'put' as const, openInterest: 3000, price: 5.9 },
    ];
    const out = tool.run({
      chain,
      spot: 100,
      riskFreeRate: 0.045,
      asOf: '2026-07-13T00:00:00Z',
      underlying: 'XYZ',
      style: 'american',
      convention: 'callsPositivePutsNegative',
      topStrikes: 2,
    });
    expect((out.structured as { topStrikes: unknown[] }).topStrikes.length).toBeLessThanOrEqual(2);
  });

  it('structure.exposures caps the chain length (no unbounded compute, specification §18.5)', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_structure_exposures')!;
    const chain = Array.from({ length: 6000 }, () => ({
      strike: 100,
      expiry: '2026-08-21',
      type: 'call' as const,
      openInterest: 1,
      impliedVolatility: 0.2,
    }));
    expect(() =>
      tool.run({
        chain,
        spot: 100,
        riskFreeRate: 0.045,
        asOf: '2026-07-13T00:00:00Z',
        underlying: 'XYZ',
        style: 'american',
        convention: 'callsPositivePutsNegative',
      }),
    ).toThrow(/exceeds the 5000-row limit for this operation/);
  });

  it('structure.exposures is callable over the wire', async () => {
    const res = await client.callTool({
      name: 'totalfinance_structure_exposures',
      arguments: {
        chain: sampleChain(),
        spot: 100,
        riskFreeRate: 0.045,
        asOf: '2026-07-13T00:00:00Z',
        underlying: 'XYZ',
        style: 'american',
        convention: 'callsPositivePutsNegative',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(Number.isFinite((structuredOf(res) as { atSpot: { gex: number } }).atSpot.gex)).toBe(
      true,
    );
  });

  // DX5 — risk pack: VaR / CVaR from a return series. Structured output is the Computed envelope:
  // { value: { var, cvar }, assumptions, diagnostics } (envelope law, dx §2.8).
  const sampleReturns = () => Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? -0.05 : 0.01));
  type VarStructured = {
    value: { valueAtRisk: number; conditionalValueAtRisk: number };
    assumptions: {
      confidence: number;
      method: string;
      horizonPeriods: number;
      cornishFisher: boolean;
      conventionsVersion: string;
      seed?: number;
      samples?: number;
    };
    diagnostics: { warnings: unknown[] };
  };

  it('risk.value_at_risk returns the VaR/CVaR envelope with the method echoed (historical default)', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_risk_value_at_risk')!;
    const r = tool.run({ returns: sampleReturns() }).structured as unknown as VarStructured;
    expect(r.assumptions.method).toBe('historical');
    expect(r.assumptions.confidence).toBe(0.95);
    expect(r.assumptions.horizonPeriods).toBe(1);
    expect(r.assumptions.conventionsVersion).toBeTruthy();
    // A deterministic method must not echo a meaningless seed.
    expect(r.assumptions.seed).toBeUndefined();
    expect(Array.isArray(r.diagnostics.warnings)).toBe(true);
    expect(r.value.valueAtRisk).toBeGreaterThan(0);
    expect(r.value.conditionalValueAtRisk).toBeGreaterThanOrEqual(r.value.valueAtRisk); // CVaR ≥ VaR by definition
  });

  it('risk.value_at_risk scales VaR up with the √-time horizon (parametric)', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_risk_value_at_risk')!;
    const returns = sampleReturns();
    const h1 = (tool.run({ returns, method: 'parametric' }).structured as unknown as VarStructured)
      .value.valueAtRisk;
    const h4 = (
      tool.run({ returns, method: 'parametric', horizonPeriods: 4 })
        .structured as unknown as VarStructured
    ).value.valueAtRisk;
    expect(h4).toBeGreaterThan(h1);
  });

  it('risk.value_at_risk Monte-Carlo is reproducible and echoes the seed in assumptions', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_risk_value_at_risk')!;
    const returns = sampleReturns();
    const a = tool.run({ returns, method: 'monteCarlo', seed: 7 })
      .structured as unknown as VarStructured;
    const b = tool.run({ returns, method: 'monteCarlo', seed: 7 })
      .structured as unknown as VarStructured;
    expect(a.assumptions.seed).toBe(7);
    expect(a.assumptions.samples).toBeGreaterThan(0);
    expect(a.value.valueAtRisk).toBe(b.value.valueAtRisk);
  });

  it('risk.value_at_risk is callable over the wire', async () => {
    const res = await client.callTool({
      name: 'totalfinance_risk_value_at_risk',
      arguments: { returns: sampleReturns(), confidence: 0.99 },
    });
    expect(res.isError).toBeFalsy();
    const r = structuredOf(res) as unknown as VarStructured;
    expect(r.assumptions.confidence).toBe(0.99);
    expect(r.value.valueAtRisk).toBeGreaterThan(0);
  });

  it('row-cap errors name the tool that was called, with code input.out_of_range', () => {
    const varTool = defaultTools().find((t) => t.name === 'totalfinance_risk_value_at_risk')!;
    const returns = new Array(5001).fill(0.01);
    let caught: unknown;
    try {
      varTool.run({ returns });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as InputError).code).toBe('input.out_of_range');
    expect((caught as InputError).message).toMatch(/^totalfinance\.risk\.value_at_risk:/);
    expect((caught as InputError).message).toMatch(
      /exceeds the 5000-row limit for this operation \(5001\)/,
    );

    // The shared guard is parameterized per tool (it used to hardcode ta.calculate).
    const metrics = defaultTools().find((t) => t.name === 'totalfinance_volatility_metrics')!;
    let caught2: unknown;
    try {
      metrics.run({ current: 0.2, history: new Array(5001).fill(0.2) });
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).toBeInstanceOf(InputError);
    expect((caught2 as InputError).code).toBe('input.out_of_range');
    expect((caught2 as InputError).message).toMatch(
      /^totalfinance\.volatility\.metrics: `history`/,
    );
  });

  it('tool.run() with invalid input throws the typed schema error, never a raw TypeError', () => {
    for (const name of [
      'totalfinance_risk_value_at_risk',
      'totalfinance_option_price',
      'totalfinance_structure_exposures',
    ]) {
      const t = defaultTools().find((x) => x.name === name)!;
      let caught: unknown;
      try {
        t.run({});
      } catch (e) {
        caught = e;
      }
      expect(caught, `${name} should throw a typed InputError`).toBeInstanceOf(InputError);
      expect((caught as InputError).message).toMatch(/is required/);
    }
  });

  it('exposes analysis prompts', async () => {
    const { prompts } = await client.listPrompts();
    // Stage 7A slice 6: the chain-screen prompt is gone (it invited invented data until a chain handle exists).
    expect(prompts.map((p) => p.name)).toEqual(['analyze-option-trade', 'analyze-strategy']);
    const got = await client.getPrompt({
      name: 'analyze-option-trade',
      arguments: { underlying: 'AAPL', details: 'strike 100, expiry 2026-09-18, spot 96.5' },
    });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/AAPL/);
    expect(text).toMatch(/totalfinance_option_price/);
    expect(text).not.toMatch(/totalfinance\.option\.price\b(?! )/);
  });
});

function tool(
  partial: Partial<TotalFinanceTool> & Pick<TotalFinanceTool, 'name' | 'run'>,
): TotalFinanceTool {
  return {
    title: partial.name,
    description: 'test tool',
    schema: schema.object({}) as unknown as Schema<unknown>,
    ...partial,
  } as TotalFinanceTool;
}

describe('R3 review follow-ups — bounded compute + machine-readable contracts', () => {
  it('caps Monte-Carlo samples in the schema (bounded BEFORE work starts, not just by the deadline)', () => {
    const var_ = defaultTools().find((t) => t.name === 'totalfinance_risk_value_at_risk')!;
    const returns = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.01);
    const huge = var_.schema.safeParse({
      returns,
      method: 'monteCarlo',
      samples: 5_000_000,
    });
    expect(huge.success).toBe(false);
    const ok = var_.schema.safeParse({ returns, method: 'monteCarlo', samples: 50_000 });
    expect(ok.success).toBe(true);
  });

  it('an unknown tool returns a machine-readable code, not just prose', async () => {
    const client = await connect();
    // Stage 7A slice 6 (Decision 8): an unknown tool is a PROTOCOL error (JSON-RPC -32602), never an isError result.
    await expect(
      client.callTool({ name: 'totalfinance.nope', arguments: {} }),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('technical_analysis.list discloses each indicator’s defaults and required parameters (disclosure law for discovery)', () => {
    const list = defaultTools().find((t) => t.name === 'totalfinance_technical_analysis_list')!;
    const out = list.run({ limit: 1_000 });
    const rsi = (
      out.structured as {
        indicators: Array<{ name: string; defaults: Record<string, unknown>; required: string[] }>;
      }
    ).indicators.find((i) => i.name === 'rsi')!;
    expect(rsi.defaults['period']).toBe(14);
    // ema has no universal default → it must be surfaced as required, not silently defaulted.
    const ema = (
      out.structured as { indicators: Array<{ name: string; required: string[] }> }
    ).indicators.find((i) => i.name === 'ema')!;
    expect(ema.required).toContain('period');
  });
});

describe('MCP protocol polish', () => {
  it('lists output schemas and exposes them as resources', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const price = tools.find((t) => t.name === 'totalfinance_option_price');
    expect(price?.outputSchema?.type).toBe('object');

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      'totalfinance://schema/tool/totalfinance_option_price/output',
    );
    const read = await client.readResource({
      uri: 'totalfinance://schema/tool/totalfinance_option_price/output',
    });
    const schemaDocument = JSON.parse((read.contents[0] as { text: string }).text) as {
      properties: { structured: { anyOf: { properties: { value: { type: string } } }[] } };
      required: string[];
    };
    // B2: the wire outputSchema is the OperationResult envelope around the tool's own schema,
    // with the spilled-handle branch beside it.
    expect(schemaDocument.required).toEqual(
      expect.arrayContaining(['operation', 'structured', 'assumptions', 'diagnostics', 'identity']),
    );
    expect(schemaDocument.properties.structured.anyOf[0]!.properties.value.type).toBe('number');
    expect(schemaDocument.properties.structured.anyOf).toHaveLength(2);
  });

  it('returns the summary as the one text block and the OperationResult envelope as structuredContent', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: 'totalfinance_option_price',
      arguments: {
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
        type: 'call',
      },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    // B2: no duplicate JSON text block — the structured content IS the JSON document.
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    const envelope = res.structuredContent as {
      operation: { id: string; version: string };
      library: { version: string };
      summary: string;
      structured: { value: number };
      assumptions: Record<string, unknown>;
      diagnostics: { warnings: unknown[]; status: string; incomplete: string[] };
      identity: { inputsHash: string };
      artifacts: unknown[];
      usage: { inputBytes: number };
      trace: { requestId: string | null };
    };
    expect(envelope.operation.id).toBe('totalfinance.option.price');
    expect(envelope.summary).toBe(content[0]!.text);
    expect(envelope.structured.value).toBeCloseTo(10.4506, 4);
    expect(envelope.diagnostics.status).toBe('complete');
    expect(envelope.identity.inputsHash).toMatch(/^sha256:/);
    expect(envelope.usage.inputBytes).toBeGreaterThan(0);
  });

  it('read-only mode filters mutating tools structurally', async () => {
    const mutating = tool({
      name: 'totalfinance_test_mutate',
      mutates: true,
      run: () => ({ summary: 'm', structured: { ok: true } }),
    });
    const roClient = await connect({ tools: [...[], mutating] });
    const names = (await roClient.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('totalfinance_test_mutate');
    // A filtered tool is not "unknown" (B2): the call is refused with the reason and the
    // capabilities resource, so a client reading a fuller catalog learns what this server needs.
    const refused = await roClient.callTool({ name: 'totalfinance_test_mutate', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    const document = JSON.parse((refused.content as { text: string }[])[0]!.text) as {
      code: string;
      message: string;
      context: { readOnly: boolean; capabilitiesUri: string };
    };
    expect(document.code).toBe('operation.tool_filtered');
    expect(document.context.readOnly).toBe(true);
    expect(document.context.capabilitiesUri).toBe('totalfinance://capabilities');
    expect(document.message).toContain('read-only');

    const rwClient = await connect({ tools: [mutating], readOnly: false });
    expect((await rwClient.listTools()).tools.map((t) => t.name)).toContain(
      'totalfinance_test_mutate',
    );
  });

  it('advertises the version from package.json, not a hand-pinned literal', async () => {
    // `SERVER_INFO.version` was the string '0.0.1', maintained by remembering to. Version is the
    // one field a client uses to decide what a server supports, so a stale literal is a lie told to
    // every connection — and the kind that survives review because it never fails a test.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { name: string; version: string };
    const client = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe('totalfinance');
    expect(info?.version).toBe(manifest.version);
    // Not vacuous: a real semver string, and one that tracks the manifest rather than a constant.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('evaluates the stochastic predicate AFTER schema defaults are applied', async () => {
    // The predicate used to run on the RAW pre-parse arguments, so a tool whose stochastic method
    // is its schema DEFAULT looked deterministic when the caller simply omitted the field: no seed
    // injected, a different answer every call, and `assumptions.seed` absent — nothing said the
    // result was not reproducible. Defaults are part of the call.
    const seenMethods: unknown[] = [];
    const base = schema.object({
      method: schema.enum(['monteCarlo', 'historical'] as const).optional(),
      seed: schema.number().integer().optional(),
    }) as unknown as Schema<unknown>;
    // A schema that FILLS IN its default on parse — the shape whose default decides stochasticity.
    const defaulting: Schema<unknown> = {
      ...base,
      toJSONSchema: () => base.toJSONSchema(),
      safeParse: (input, options) => {
        const res = base.safeParse(input, options);
        if (!res.success) return res;
        const data = res.data as Record<string, unknown>;
        return { success: true, data: { method: 'monteCarlo', ...data } };
      },
    } as Schema<unknown>;
    const defaultingTool = tool({
      name: 'totalfinance_test_default_stochastic',
      schema: defaulting,
      stochastic: (args) => {
        seenMethods.push(args['method']);
        return args['method'] === 'monteCarlo';
      },
      run: () => ({ summary: 'sampled', structured: { draw: 0.5 } }),
    });
    const client = await connect({
      tools: [defaultingTool],
      readOnly: false,
      defaultSeed: 11,
    });

    // `method` OMITTED ⇒ the schema default 'monteCarlo' ⇒ stochastic ⇒ a seed is injected.
    const defaulted = await client.callTool({
      name: 'totalfinance_test_default_stochastic',
      arguments: {},
    });
    expect(seenMethods[0]).toBe('monteCarlo'); // the predicate SAW the default
    expect((structuredOf(defaulted) as { assumptions: { seed?: number } }).assumptions.seed).toBe(
      11,
    );

    // The explicitly-deterministic branch still gets no meaningless seed.
    const deterministic = await client.callTool({
      name: 'totalfinance_test_default_stochastic',
      arguments: { method: 'historical' },
    });
    expect(seenMethods[1]).toBe('historical');
    expect(
      (structuredOf(deterministic) as { assumptions?: { seed?: number } }).assumptions?.seed,
    ).toBeUndefined();

    // An explicit seed is respected, not overwritten by the policy default.
    const explicit = await client.callTool({
      name: 'totalfinance_test_default_stochastic',
      arguments: { seed: 99 },
    });
    expect((structuredOf(explicit) as { assumptions: { seed: number } }).assumptions.seed).toBe(99);
  });

  it('injects a seed for stochastic tools and echoes it in assumptions.seed (not top-level)', async () => {
    const stochastic = tool({
      name: 'totalfinance_test_random',
      stochastic: true,
      schema: schema.object({
        seed: schema.number().integer().optional(),
      }) as unknown as Schema<unknown>,
      run: () => ({ summary: 'sampled', structured: { draw: 0.5 } }),
    });
    const client = await connect({ tools: [stochastic], readOnly: false, defaultSeed: 7 });
    const res = await client.callTool({ name: 'totalfinance_test_random', arguments: {} });
    const structured = structuredOf(res) as { seed?: number; assumptions: { seed: number } };
    expect(structured.assumptions.seed).toBe(7);
    expect(structured.seed).toBeUndefined();
  });

  /**
   * The seed is injected AFTER `safeParse`, which made it the one field in a request that the tool's
   * own schema never saw. A review built a custom stochastic tool declaring `seed: number().integer()`
   * and a server with `defaultSeed: 1.5`; the call was accepted and the fractional seed echoed back
   * as though it were reproducible. The built-in VaR rejects it deeper in — a custom tool has no
   * such luck, and "it happens to fail downstream" is not a contract.
   */
  it('a fractional defaultSeed is refused at CONSTRUCTION, not at some later call', () => {
    expect(() => createTotalFinanceMcpServer({ defaultSeed: 1.5 })).toThrow(InputError);
    expect(() => createTotalFinanceMcpServer({ defaultSeed: Number.NaN })).toThrow(InputError);
    expect(() => createTotalFinanceMcpServer({ defaultSeed: Number.POSITIVE_INFINITY })).toThrow(
      InputError,
    );
    // a legitimate seed still constructs
    expect(() => createTotalFinanceMcpServer({ defaultSeed: 42 })).not.toThrow();
  });

  it("the injected seed is re-parsed, so a tool's own seed constraint stays authoritative", async () => {
    // The tool demands a seed of at least 100; the server's default of 7 does not satisfy it. The
    // call must fail with the tool's own complaint rather than silently running on 7.
    const picky = tool({
      name: 'totalfinance_test_picky_seed',
      stochastic: true,
      schema: schema.object({
        seed: schema.number().integer().min(100).optional(),
      }) as unknown as Schema<unknown>,
      run: () => ({ summary: 'sampled', structured: { draw: 0.5 } }),
    });
    const client = await connect({ tools: [picky], readOnly: false, defaultSeed: 7 });
    const res = await client.callTool({ name: 'totalfinance_test_picky_seed', arguments: {} });
    expect(res.isError, 'the tool ran on a seed its own schema rejects').toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/defaultSeed/);
  });

  it('a seed the tool DOES accept still flows through untouched', async () => {
    const picky = tool({
      name: 'totalfinance_test_happy_seed',
      stochastic: true,
      schema: schema.object({
        seed: schema.number().integer().min(100).optional(),
      }) as unknown as Schema<unknown>,
      run: () => ({ summary: 'sampled', structured: { draw: 0.5 } }),
    });
    const client = await connect({ tools: [picky], readOnly: false, defaultSeed: 123 });
    const res = await client.callTool({ name: 'totalfinance_test_happy_seed', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((structuredOf(res) as { assumptions: { seed: number } }).assumptions.seed).toBe(123);
  });

  it('the other numeric server budgets are validated at construction too', () => {
    for (const options of [
      { maxInputBytes: 0 },
      { maxInputBytes: -1 },
      { maxInputBytes: Number.NaN },
      { deadlineMs: 0 },
      { deadlineMs: Number.POSITIVE_INFINITY },
    ] as const) {
      expect(() => createTotalFinanceMcpServer(options), JSON.stringify(options)).toThrow(
        InputError,
      );
    }
    expect(() =>
      createTotalFinanceMcpServer({ maxInputBytes: 1024, deadlineMs: 5_000 }),
    ).not.toThrow();
  });

  it('throws a descriptive error at registration on a duplicate tool name', () => {
    const dup = tool({
      name: 'totalfinance_option_price',
      run: () => ({ summary: 'shadow', structured: {} }),
    });
    // `packs` is an exact selection (P1.1), so a pack alone cannot collide with implicit
    // defaults — but an explicit tools+packs union still guards duplicates…
    expect(() =>
      createTotalFinanceMcpServer({
        tools: defaultTools(),
        packs: [{ name: 'dup-pack', tools: [dup] }],
      }),
    ).toThrow(/duplicate tool name "totalfinance_option_price"/);
    // …as does selecting the same pack twice…
    expect(() => createTotalFinanceMcpServer({ packs: [optionsPack(), optionsPack()] })).toThrow(
      /duplicate tool name/,
    );
    // …and duplicates WITHIN the base set.
    const a = tool({
      name: 'totalfinance_test_same',
      run: () => ({ summary: '', structured: {} }),
    });
    expect(() => createTotalFinanceMcpServer({ tools: [a, a] })).toThrow(
      /duplicate tool name "totalfinance_test_same"/,
    );
  });
});

describe('packs + stochastic seed policy (dx §5.3)', () => {
  it('backtestPack is absent by default; expansion is explicit via [...defaultPacks(), backtestPack()]', async () => {
    const bare = await connect();
    const bareNames = (await bare.listTools()).tools.map((t) => t.name);
    expect(bareNames).not.toContain('totalfinance_backtest_vectorized_run');
    expect(bareNames).toHaveLength(23); // 20 + crypto (2) + fixed_income (1), P3.7

    const { backtestPack, defaultPacks } = await import('@totalfinance/mcp');
    // `packs` is an exact selection: the backtest pack ALONE exposes exactly its own tool…
    const alone = await connect({ packs: [backtestPack()] });
    const aloneNames = (await alone.listTools()).tools.map((t) => t.name);
    expect(aloneNames).toEqual([
      'totalfinance_backtest_vectorized_run',
      'totalfinance_backtest_options_run',
      'totalfinance_backtest_cross_sectional_run',
      'totalfinance_backtest_portfolio_run',
      'totalfinance_backtest_environment_episode',
    ]);
    // …and the documented expansion is defaults + backtest = 23 + 3 = 26.
    const expanded = await connect({ packs: [...defaultPacks(), backtestPack()] });
    const expandedNames = (await expanded.listTools()).tools.map((t) => t.name);
    expect(expandedNames).toContain('totalfinance_backtest_vectorized_run');
    expect(expandedNames).toContain('totalfinance_backtest_options_run');
    expect(expandedNames).toContain('totalfinance_backtest_cross_sectional_run');
    expect(expandedNames).toHaveLength(28);
  });

  it("the guide's documented subset example works: packs: [optionsPack()] → exactly the option tools (P1.1)", async () => {
    const { optionsPack, technicalAnalysisPack } = await import('@totalfinance/mcp');
    const client = await connect({ packs: [optionsPack()] });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'totalfinance_option_greeks',
      'totalfinance_option_implied_volatility',
      'totalfinance_option_price',
    ]);
    // Two packs compose: options + ta = 6 tools, nothing implicit.
    const two = await connect({ packs: [optionsPack(), technicalAnalysisPack()] });
    expect((await two.listTools()).tools).toHaveLength(6);
    // A selected tool actually dispatches (the registry is real, not just listed).
    const res = await client.callTool({
      name: 'totalfinance_option_price',
      arguments: {
        spot: 100,
        strike: 105,
        timeToExpiryYears: 30 / 365,
        riskFreeRate: 0.045,
        volatility: 0.22,
        type: 'call',
      },
    });
    expect((structuredOf(res) as { value: number }).value).toBeCloseTo(0.8984, 3);
  });

  it('a monteCarlo VaR call without a seed gets the policy default injected into assumptions.seed', async () => {
    const client = await connect({ defaultSeed: 7 });
    const returns = Array.from({ length: 100 }, (_, i) => 0.01 * Math.sin(i));
    const res = await client.callTool({
      name: 'totalfinance_risk_value_at_risk',
      arguments: { returns, method: 'monteCarlo' },
    });
    const structured = structuredOf(res) as {
      seed?: number;
      value: { valueAtRisk: number };
      assumptions: { seed: number };
    };
    expect(structured.assumptions.seed).toBe(7);
    expect(structured.seed).toBeUndefined(); // echoed in assumptions, never hoisted top-level
    expect(structured.value.valueAtRisk).toBeGreaterThan(0);
    // Same seed ⇒ bit-identical result (the reproducibility contract).
    const res2 = await client.callTool({
      name: 'totalfinance_risk_value_at_risk',
      arguments: { returns, method: 'monteCarlo' },
    });
    expect((structuredOf(res2) as { value: { valueAtRisk: number } }).value.valueAtRisk).toBe(
      structured.value.valueAtRisk,
    );
  });

  it('a deterministic VaR call never gets a seed injected (stochastic is per-call)', async () => {
    const client = await connect({ defaultSeed: 7 });
    const returns = Array.from({ length: 100 }, (_, i) => 0.01 * Math.sin(i));
    for (const method of [undefined, 'historical', 'parametric'] as const) {
      const res = await client.callTool({
        name: 'totalfinance_risk_value_at_risk',
        arguments: { returns, ...(method !== undefined ? { method } : {}) },
      });
      expect(res.isError).toBeFalsy();
      const structured = structuredOf(res) as {
        seed?: number;
        assumptions: { seed?: number };
      };
      expect(structured.seed).toBeUndefined();
      expect(structured.assumptions.seed).toBeUndefined();
    }
  });
});
