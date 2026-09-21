import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analysisTools, backtestPack, defaultPacks, defaultTools } from '../src/index.js';

/**
 * DX §WS-5 — the expanded default tool set (23 tools across 10 packs), the opt-in backtest pack,
 * and the envelope law on every structured payload.
 */
function tool(name: string) {
  const t = [...defaultTools(), ...backtestPack().tools].find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

const returns = Array.from({ length: 120 }, (_, i) => 0.01 * Math.sin(i) + 0.0004);

describe('the default tool inventory (dx §5.1)', () => {
  it('is 23 tools, and every analysis addition is present', () => {
    const names = defaultTools().map((t) => t.name);
    expect(names).toHaveLength(23); // 20 + crypto (2) + fixed_income (1), P3.7
    for (const expected of [
      'totalfinance_performance_analyze',
      'totalfinance_risk_optimize',
      'totalfinance_volatility_surface',
      'totalfinance_volatility_metrics',
      'totalfinance_volatility_event',
      'totalfinance_structure_flow',
      'totalfinance_strategy_list',
      'totalfinance_calendar_sessions',
      'totalfinance_crypto_perpetual_funding',
      'totalfinance_crypto_futures_basis',
      'totalfinance_fixed_income_bond_analytics',
    ]) {
      expect(names).toContain(expected);
    }
    // The backtest pack is opt-in, never in the default set.
    expect(names.some((n) => n.startsWith('totalfinance.backtest.'))).toBe(false);
    expect(backtestPack().tools.map((t) => t.name)).toContain(
      'totalfinance_backtest_vectorized_run',
    );
    expect(analysisTools()).toHaveLength(8);
  });

  it('is ten domain packs that flatten to exactly the default tool set (F8)', () => {
    const packs = defaultPacks();
    expect(packs.map((p) => p.name)).toEqual([
      'options',
      'technical_analysis',
      'strategy',
      'volatility',
      'structure',
      'risk',
      'performance',
      'calendar',
      'crypto',
      // The pack id matches its `totalfinance.fixed_income.*` tool prefix. It was `fixed-income`
      // against `fixed_income` tools — one identity, two spellings on the wire.
      'fixed_income',
    ]);
    // defaultTools() IS the flattened packs — same tools, no divergence.
    const flat = packs.flatMap((p) => p.tools.map((t) => t.name));
    expect(flat).toEqual(defaultTools().map((t) => t.name));
    // Every pack is independently enable-able and non-empty.
    for (const pack of packs) expect(pack.tools.length).toBeGreaterThan(0);
  });

  it('the doc tool counts cannot drift from defaultTools() (F8)', () => {
    const n = defaultTools().length;
    const root = new URL('../../../', import.meta.url); // repo root
    // Collapse prose line-wrapping so a re-wrapped paragraph can't false-fail the count check.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\s+/g, ' ');
    // Both the umbrella README and the MCP guide state the count in prose — pin them to the truth.
    expect(read('README.md')).toContain(`${n} read-only tools`);
    expect(read('docs/guides/mcp.md')).toContain(`exposes ${n} read-only tools`);
    // And the "ten domain packs" claim tracks defaultPacks().
    expect(read('docs/guides/mcp.md')).toContain('grouped into ten domain packs');
    expect(defaultPacks()).toHaveLength(10);
  });

  it('risk.value_at_risk is stochastic per call: only for method monteCarlo (seed policy)', () => {
    const stochastic = tool('totalfinance_risk_value_at_risk').stochastic;
    expect(typeof stochastic).toBe('function');
    const isStochastic = stochastic as (args: Record<string, unknown>) => boolean;
    expect(isStochastic({ method: 'monteCarlo' })).toBe(true);
    expect(isStochastic({ method: 'historical' })).toBe(false);
    expect(isStochastic({ method: 'parametric' })).toBe(false);
    expect(isStochastic({})).toBe(false); // default method is historical — deterministic
  });
});

describe('performance.analyze', () => {
  it('returns the envelope and enforces returns XOR equity', () => {
    const r = tool('totalfinance_performance_analyze').run({ returns });
    const s = r.structured as {
      value: { sharpe: number };
      assumptions: object;
      diagnostics: object;
    };
    expect(s.value.sharpe).toBeTypeOf('number');
    expect(s.assumptions).toBeDefined();
    expect(s.diagnostics).toBeDefined();
    expect(() => tool('totalfinance_performance_analyze').run({})).toThrowError(/exactly one/);
  });
});

describe('risk.optimize', () => {
  const covariance = [
    [0.04, 0.01],
    [0.01, 0.09],
  ];

  it('solves minVariance and returns the Computed envelope', () => {
    const r = tool('totalfinance_risk_optimize').run({
      objective: 'minVariance',
      covariance,
      longOnly: true,
    });
    const s = r.structured as {
      value: { weights: number[] };
      assumptions: { objective: string; budget: number };
      diagnostics: { converged: boolean };
    };
    expect(s.value.weights).toHaveLength(2);
    expect(s.value.weights[0]! + s.value.weights[1]!).toBeCloseTo(1, 6);
    expect(s.assumptions.objective).toBe('minVariance');
    expect(s.assumptions.budget).toBe(1);
    expect(s.diagnostics.converged).toBe(true);
  });

  it('teaches when mean is missing for a mean-requiring objective', () => {
    expect(() =>
      tool('totalfinance_risk_optimize').run({ objective: 'maxSharpe', covariance }),
    ).toThrowError(/mean.*required/);
  });
});

describe('vol tools', () => {
  it('volatility.metrics returns rank/percentile with the envelope', () => {
    const history = Array.from({ length: 252 }, (_, i) => 0.15 + 0.1 * Math.abs(Math.sin(i / 20)));
    const r = tool('totalfinance_volatility_metrics').run({ current: 0.22, history });
    const s = r.structured as { value: { rank: number; percentile: number } };
    expect(s.value.rank).toBeGreaterThan(0);
    expect(s.value.percentile).toBeGreaterThan(0);
  });

  it('volatility.event decomposes the earnings move and adds VRP when realizedVolatility is given', () => {
    const r = tool('totalfinance_volatility_event').run({
      atmVolatility: 0.6,
      baseVolatility: 0.3,
      timeToExpiryYears: 5 / 365,
      realizedVolatility: 0.4,
    });
    const s = r.structured as { value: { eventMove: number; varianceRiskPremium: number } };
    expect(s.value.eventMove).toBeGreaterThan(0);
    expect(s.value.varianceRiskPremium).toBeTypeOf('number');
  });

  it('volatility.surface fits a small chain and reports arbitrage', () => {
    const chain = [];
    for (const expiry of ['2026-06-19', '2026-09-18']) {
      for (const strike of [90, 100, 110]) {
        chain.push({
          strike,
          expiry,
          type: 'call' as const,
          impliedVolatility: 0.2 + (100 - strike) * 0.001,
        });
      }
    }
    const r = tool('totalfinance_volatility_surface').run({
      chain,
      spot: 100,
      riskFreeRate: 0.04,
      asOf: '2026-01-02T00:00:00Z',
      underlying: 'XYZ',
      style: 'european',
    });
    const s = r.structured as {
      rows: unknown[];
      expiries: string[];
      arbitrage: { violations: unknown[] };
    };
    expect(s.expiries).toHaveLength(2);
    expect(s.rows.length).toBeGreaterThan(0);
    expect(Array.isArray(s.arbitrage.violations)).toBe(true);
  });
});

describe('structure.flow', () => {
  it('classifies prints and reports counts + honest limitations', () => {
    const ts = Date.parse('2026-07-06T15:00:00Z');
    const trades = [
      {
        timestampMs: ts,
        type: 'call' as const,
        strike: 100,
        expiry: '2026-08-21',
        price: 2.6,
        size: 60,
        bid: 2.4,
        ask: 2.6,
      },
      {
        timestampMs: ts + 50,
        type: 'call' as const,
        strike: 100,
        expiry: '2026-08-21',
        price: 2.6,
        size: 80,
        bid: 2.4,
        ask: 2.6,
      },
      {
        timestampMs: ts + 90,
        type: 'call' as const,
        strike: 100,
        expiry: '2026-08-21',
        price: 2.65,
        size: 70,
        bid: 2.4,
        ask: 2.65,
      },
    ];
    const r = tool('totalfinance_structure_flow').run({
      trades,
      underlying: 'XYZ',
      style: 'american',
    });
    const s = r.structured as {
      counts: { trades: number; buy: number };
      limitations: string[];
      diagnostics: { warnings: { code: string; message: string }[] };
    };
    expect(s.counts.trades).toBe(3);
    expect(s.counts.buy).toBe(3); // all at the ask
    // The caveats live in diagnostics.warnings as model.limitation entries (R2); `limitations` is
    // the derived convenience view of exactly those messages.
    const limitationWarnings = s.diagnostics.warnings.filter((w) => w.code === 'model.limitation');
    expect(limitationWarnings.length).toBeGreaterThan(0);
    expect(s.limitations).toEqual(limitationWarnings.map((w) => w.message));
  });
});

describe('strategy.list + named dispatch', () => {
  it('lists the catalog with buildable examples', () => {
    const r = tool('totalfinance_strategy_list').run({});
    const s = r.structured as {
      count: number;
      strategies: Array<{ name: string; example: object }>;
    };
    expect(s.count).toBeGreaterThanOrEqual(55);
    expect(s.strategies.find((d) => d.name === 'ironCondor')?.example).toBeDefined();
  });

  it('strategy.analyze dispatches a named builder with model premiums and classifies it', () => {
    const r = tool('totalfinance_strategy_analyze').run({
      strategy: 'ironCondor',
      input: { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
      premiums: 'model',
      probability: true,
      market: {
        spot: 100,
        volatility: 0.2,
        riskFreeRate: 0.04,
        asOf: '2026-01-02T00:00:00Z',
        expiry: '2026-06-19',
      },
    });
    const s = r.structured as {
      classification: string[];
      probability: { probabilityOfProfit: number; assumptions: { marketSource: string } };
      assumptions: { constructedAs?: string };
      diagnostics: { warnings: unknown[] };
    };
    expect(s.classification).toContain('ironCondor');
    expect(s.assumptions.constructedAs).toBe('ironCondor');
    expect(s.probability.probabilityOfProfit).toBeGreaterThan(0);
    // The market rode from construction (R5), echoed in probability.assumptions.marketSource.
    expect(s.probability.assumptions.marketSource).toBe('construction');
    expect(Array.isArray(s.diagnostics.warnings)).toBe(true);
  });

  it('teaches on an unknown name and on legs+strategy both supplied', () => {
    expect(() =>
      tool('totalfinance_strategy_analyze').run({ strategy: 'ironCondorb', input: {} }),
    ).toThrowError(/totalfinance\.strategy\.list/);
    expect(() => tool('totalfinance_strategy_analyze').run({})).toThrowError(/exactly one/);
  });
});

describe('calendar.sessions', () => {
  it('returns trading days, holidays, and OPEX expirations for a range', () => {
    const r = tool('totalfinance_calendar_sessions').run({
      calendar: 'NYSE',
      from: '2026-06-01',
      to: '2026-07-31',
      expirationKind: 'monthly',
    });
    const s = r.structured as {
      tradingDays: string[];
      holidays: string[];
      expirations: string[];
      nextExpiry: string;
    };
    expect(s.tradingDays.length).toBeGreaterThan(35);
    expect(s.holidays).toContain('2026-07-03'); // July 4th observed
    expect(s.expirations).toEqual(['2026-06-18', '2026-07-17']); // Juneteenth-shifted OPEX
    expect(s.nextExpiry).toBe('2026-06-18');
  });
});

describe('backtest pack (opt-in)', () => {
  const bars = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestampMs: i * 86_400_000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
    }));

  it('runs a vectorized backtest and surfaces the run assumptions + risk diagnostics', () => {
    const data = bars(40);
    const signal = data.map((_, i) => (i >= 5 ? 1 : 0));
    const r = tool('totalfinance_backtest_vectorized_run').run({ data, signal });
    const s = r.structured as {
      finalValue: number;
      turnover: number;
      performance: { sharpe: number };
      assumptions: {
        conventionsVersion: string;
        initialCapital: number;
        fill: string;
        cost: string;
        slippage: string;
        cashSettlement: string;
        corporateAction: string;
        calendar: string;
        margin: string;
      };
      diagnostics: { warnings: unknown[]; benchmarkFixtureVersion: string };
    };
    expect(s.finalValue).toBeGreaterThan(0);
    // The modelling policies the run assumed ride `assumptions` (dx §2.5) — policies are no longer
    // a diagnostics field.
    expect(s.assumptions.fill).toBe('close');
    expect(s.assumptions.initialCapital).toBeGreaterThan(0);
    expect(s.assumptions.cost).toBeTruthy();
    expect(s.assumptions.slippage).toBeTruthy();
    expect(s.assumptions.cashSettlement).toBeTruthy();
    expect(s.assumptions.calendar).toBeTruthy();
    expect(s.assumptions.margin).toBeTruthy();
    expect(s.assumptions.conventionsVersion).toBeTruthy();
    expect(Array.isArray(s.diagnostics.warnings)).toBe(true);
    expect(s.diagnostics.benchmarkFixtureVersion).toBeTruthy();
    expect((s.diagnostics as { policies?: unknown }).policies).toBeUndefined();
  });

  it('passes initialCapital through and echoes it in assumptions', () => {
    const data = bars(10);
    const signal = data.map(() => 1);
    const r = tool('totalfinance_backtest_vectorized_run').run({
      data,
      signal,
      initialCapital: 100_000,
    });
    const s = r.structured as { finalValue: number; assumptions: { initialCapital: number } };
    expect(s.assumptions.initialCapital).toBe(100_000);
    expect(s.finalValue).toBeGreaterThan(0);
  });
});
