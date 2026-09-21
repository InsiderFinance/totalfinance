import { describe, expect, it } from 'vitest';
import { defaultPacks, defaultTools, fixedIncomePack } from '../src/index.js';

/**
 * C7 — the crypto + fixed-income tools are EXECUTED here, not just counted: values checked
 * against hand math, the financing path actually produces the arbitrage fields, the XOR teaches,
 * and every one declares an output schema.
 */
function tool(name: string) {
  const t = defaultTools().find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

describe('totalfinance_crypto_perpetual_funding', () => {
  it('annualizes an 8h funding rate and reports the premium', () => {
    const r = tool('totalfinance_crypto_perpetual_funding').run({
      markPrice: 101,
      indexPrice: 100,
      fundingRate: 0.0001,
    });
    const s = r.structured as {
      value: { premium: number; annualizedSimple: number; periodsPerYear: number };
      assumptions: object;
      diagnostics: { warnings: unknown[] };
    };
    expect(s.value.premium).toBeCloseTo(0.01, 12);
    expect(s.value.periodsPerYear).toBeCloseTo((365 * 24) / 8, 6);
    expect(s.value.annualizedSimple).toBeCloseTo(0.0001 * s.value.periodsPerYear, 12);
    expect(s.assumptions).toBeDefined();
    expect(Array.isArray(s.diagnostics.warnings)).toBe(true);
    expect(r.summary).toContain('%/yr simple');
  });

  it('declares an output schema', () => {
    expect(tool('totalfinance_crypto_perpetual_funding').outputSchema).toBeDefined();
  });
});

describe('totalfinance_crypto_futures_basis', () => {
  it('without financing: basis analytics only, no fabricated arb fields', () => {
    const r = tool('totalfinance_crypto_futures_basis').run({
      spot: 100,
      future: 104,
      timeToExpiryYears: 0.5,
    });
    const v = (r.structured as { value: Record<string, number | string | undefined> }).value;
    expect(v['basis']).toBeCloseTo(4, 12);
    expect(v['basisFraction']).toBeCloseTo(0.04, 12);
    expect(v['annualizedLog']).toBeCloseTo(Math.log(1.04) / 0.5, 12);
    expect(v['fairFuture']).toBeUndefined();
    expect(v['carryArbitrage']).toBeUndefined();
  });

  it('WITH financing: fairFuture/richness/carryArbitrage are computed and an arb-sized basis is flagged', () => {
    // Implied carry ln(1.04)/0.5 ≈ 7.84%/yr vs 1% financing ⇒ carryArbitrage ≈ 6.8% > 5% default flag.
    const r = tool('totalfinance_crypto_futures_basis').run({
      spot: 100,
      future: 104,
      timeToExpiryYears: 0.5,
      financingRate: 0.01,
    });
    const s = r.structured as {
      value: { fairFuture?: number; richness?: number; carryArbitrage?: number };
      diagnostics: { warnings: { code: string }[] };
    };
    expect(s.value.fairFuture).toBeCloseTo(100 * Math.exp(0.01 * 0.5), 10);
    expect(s.value.richness).toBeCloseTo(104 - 100 * Math.exp(0.01 * 0.5), 10);
    expect(s.value.carryArbitrage).toBeCloseTo(Math.log(1.04) / 0.5 - 0.01, 10);
    expect(s.diagnostics.warnings.length).toBeGreaterThan(0);
    expect(r.summary).toContain('carry arb');
  });

  it('declares an output schema', () => {
    expect(tool('totalfinance_crypto_futures_basis').outputSchema).toBeDefined();
  });
});

describe('totalfinance_fixed_income_bond_analytics', () => {
  const specification = {
    issueDate: '2024-01-15',
    maturityDate: '2030-01-15',
    couponRate: 0.05,
    frequency: 'semiannual',
    settlementDate: '2026-07-20',
  };

  it('prices from a yield and reports duration/convexity/DV01', () => {
    const r = tool('totalfinance_fixed_income_bond_analytics').run({
      ...specification,
      yield: 0.045,
    });
    const v = (
      r.structured as {
        value: {
          yield: number;
          cleanPrice: number;
          dirtyPrice: number;
          accruedInterest: number;
          modifiedDuration: number;
          convexity: number;
          dv01: number;
        };
      }
    ).value;
    expect(v.yield).toBeCloseTo(0.045, 12);
    // A 5% coupon at a 4.5% yield trades above par; dirty = clean + accrued.
    expect(v.cleanPrice).toBeGreaterThan(100);
    expect(v.dirtyPrice).toBeCloseTo(v.cleanPrice + v.accruedInterest, 10);
    expect(v.modifiedDuration).toBeGreaterThan(0);
    expect(v.convexity).toBeGreaterThan(0);
    expect(v.dv01).toBeGreaterThan(0);
  });

  it('solves the yield from a price and round-trips', () => {
    const priced = tool('totalfinance_fixed_income_bond_analytics').run({
      ...specification,
      yield: 0.045,
    });
    const clean = (priced.structured as { value: { cleanPrice: number } }).value.cleanPrice;
    const solved = tool('totalfinance_fixed_income_bond_analytics').run({
      ...specification,
      price: clean,
    });
    expect((solved.structured as { value: { yield: number } }).value.yield).toBeCloseTo(0.045, 8);
  });

  it('yield AND price is rejected with teaching; priceType without price too', () => {
    expect(() =>
      tool('totalfinance_fixed_income_bond_analytics').run({
        ...specification,
        yield: 0.045,
        price: 101,
      }),
    ).toThrow(/not both/);
    expect(() =>
      tool('totalfinance_fixed_income_bond_analytics').run({
        ...specification,
        yield: 0.045,
        priceType: 'clean',
      }),
    ).toThrow(/priceType/);
    expect(() =>
      tool('totalfinance_fixed_income_bond_analytics').run({ ...specification }),
    ).toThrow(/yield.*price|provide/);
  });

  it('declares an output schema', () => {
    expect(tool('totalfinance_fixed_income_bond_analytics').outputSchema).toBeDefined();
  });

  it('WARNS on a percent typed as a decimal (`yield: 5` is a 500% yield)', () => {
    // Over the wire this is the easiest mistake an agent makes: JSON carries no units, so `5` looks
    // as reasonable as `0.05`. It priced silently — a clean price near zero, a duration near zero,
    // and an "ytm 500.000%" line nobody reads. Disclosed, not thrown: distressed paper really can
    // yield above 100%.
    const r = tool('totalfinance_fixed_income_bond_analytics').run({ ...specification, yield: 5 });
    const s = r.structured as {
      value: { yield: number };
      diagnostics: { warnings: { code: string; message: string; severity: string }[] };
    };
    const suspicious = s.diagnostics.warnings.find((w) => w.code === 'input.suspicious_yield');
    expect(suspicious).toBeDefined();
    expect(suspicious!.severity).toBe('info');
    expect(suspicious!.message).toMatch(/500%/);
    expect(suspicious!.message).toMatch(/did you mean 0\.0500/);
    // The answer itself is untouched — the tool teaches, it does not overrule the caller.
    expect(s.value.yield).toBe(5);
    expect(r.summary).toContain('ytm 500.000%');
  });

  it('stays silent on a normal yield, and on a solved-from-price yield', () => {
    const priced = tool('totalfinance_fixed_income_bond_analytics').run({
      ...specification,
      yield: 0.045,
    });
    const codes = (result: { structured: unknown }): string[] =>
      (
        result.structured as { diagnostics: { warnings: { code: string }[] } }
      ).diagnostics.warnings.map((w) => w.code);
    expect(codes(priced)).not.toContain('input.suspicious_yield');
    // Solving FROM a price cannot be a units typo on `yield` — there is no `yield` input.
    const clean = (priced.structured as { value: { cleanPrice: number } }).value.cleanPrice;
    const solved = tool('totalfinance_fixed_income_bond_analytics').run({
      ...specification,
      price: clean,
    });
    expect(codes(solved)).not.toContain('input.suspicious_yield');
  });
});

describe('pack identity matches the wire (P2)', () => {
  it('every pack id is snake_case, in the same alphabet as the tool names', () => {
    // `fixed-income` (pack) against `totalfinance.fixed_income.*` (tools) was one identity spelled two
    // ways: a client that saw the tools could not spell the pack that enables them. Tool-name
    // segments are snake_case, so pack ids must be too — a hyphen is not a legal segment.
    for (const pack of defaultPacks()) {
      expect(pack.name, `pack id "${pack.name}"`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(pack.name).not.toContain('-');
    }
    const names = defaultPacks().map((p) => p.name);
    expect(names).toContain('fixed_income');
    expect(names).not.toContain('fixed-income');
  });

  it('the multi-word packs are spelled the same way their tools are', () => {
    // Only the multi-word ids can disagree on the separator; that is the whole defect class.
    const byName = new Map(defaultPacks().map((p) => [p.name, p]));
    for (const id of ['technical_analysis', 'fixed_income']) {
      const pack = byName.get(id);
      expect(pack, `pack ${id}`).toBeDefined();
      for (const t of pack!.tools)
        expect(t.name.startsWith(`totalfinance_${id}_`), t.name).toBe(true);
    }
  });

  it('the fixed_income pack is independently enable-able under its wire name', () => {
    const pack = fixedIncomePack();
    expect(pack.name).toBe('fixed_income');
    expect(pack.tools.map((t) => t.name)).toEqual(['totalfinance_fixed_income_bond_analytics']);
  });
});

describe('totalfinance.risk.optimize — maxSharpe rate units (wire contract)', () => {
  const covariance = [
    [0.04, 0.006],
    [0.006, 0.09],
  ];
  const mean = [0.01, 0.015];

  it('forwards riskFreeRatePerPeriod and actually changes the tangency portfolio', () => {
    // The tool forwarded `riskFreeRate`, which risk's `maxSharpe` renamed to
    // `riskFreeRatePerPeriod` — a rename made precisely because the old name read as ANNUAL
    // everywhere else in the library. Spread-widening hid it from the typechecker, so only a
    // call over the wire catches it.
    const at = (rate: number): number[] =>
      (
        tool('totalfinance_risk_optimize').run({
          objective: 'maxSharpe',
          covariance,
          mean,
          riskFreeRatePerPeriod: rate,
        }).structured as { value: { weights: number[] } }
      ).value.weights;
    const zero = at(0);
    const positive = at(0.005);
    expect(zero).toHaveLength(2);
    expect(zero.every((w) => Number.isFinite(w))).toBe(true);
    // A non-zero risk-free rate moves the tangency portfolio — proof the field reached the solver.
    expect(Math.abs(positive[0]! - zero[0]!)).toBeGreaterThan(1e-6);
  });

  it('rejects the retired `riskFreeRate` spelling instead of silently ignoring it', () => {
    expect(() =>
      tool('totalfinance_risk_optimize').run({
        objective: 'maxSharpe',
        covariance,
        mean,
        riskFreeRate: 0.005,
      }),
    ).toThrow();
  });

  it('documents the rate as PER-PERIOD in the schema an agent reads', () => {
    const properties = tool('totalfinance_risk_optimize').schema.toJSONSchema()
      .properties as Record<string, { description?: string }>;
    expect(properties['riskFreeRate']).toBeUndefined();
    expect(properties['riskFreeRatePerPeriod']?.description).toMatch(/PER-PERIOD/);
    expect(properties['riskFreeRatePerPeriod']?.description).not.toMatch(/Annualized/);
  });
});

describe('the TA describe tool surfaces indicator conventions', () => {
  it('an agent can learn why this RSI disagrees with another library, in-band', () => {
    // The whole point of the conventions block is that the answer travels WITH the tool result:
    // an agent comparing two libraries has no way to read a compatibility doc from here.
    const tool = defaultTools().find((t) => t.name === 'totalfinance_technical_analysis_describe');
    expect(tool).toBeDefined();
    const result = tool!.run({ name: 'rsi' }) as {
      structured: { conventions?: Record<string, unknown> };
    };
    expect(result.structured.conventions).toBeDefined();
    expect(String(result.structured.conventions?.['smoothing'])).toBe('wilder');
    expect(String(result.structured.conventions?.['flatSeries'])).toMatch(/100/);
  });

  it('an indicator with no such choice omits the block rather than sending an empty one', () => {
    const tool = defaultTools().find((t) => t.name === 'totalfinance_technical_analysis_describe');
    const result = tool!.run({ name: 'sma' }) as { structured: Record<string, unknown> };
    expect('conventions' in result.structured).toBe(false);
  });
});
