import { describe, expect, it } from 'vitest';
import {
  type OptionMarket,
  type OptionPricingEngine,
  defineOptionPricingEngine,
  engines,
  market,
  option,
  validateOptionPricingEngine,
} from '@totalfinance/options';

/**
 * Alignment spec P2.4 — the parameterized ENGINE CONTRACT SUITE. Shared per-call options mean the
 * same thing for every engine (the substitutability law): this suite runs the same assertions over
 * every built-in engine so a divergence like the original BSM/Black-76 `greeks: false` drift is
 * caught mechanically, not by review. Every future engine (built-in or custom) belongs here.
 */

const asOf = Date.UTC(2026, 0, 2, 21);
const expiry = '2027-01-02';
const euro = option.call({
  convention: 'us-equity-close',
  underlying: 'X',
  strike: 100,
  expiry,
  style: 'european',
});
const amer = option.call({
  convention: 'us-equity-close',
  underlying: 'X',
  strike: 100,
  expiry,
  style: 'american',
});
const spotMkt = market({
  spot: 100,
  riskFreeRate: 0.05,
  dividendYield: 0.01,
  volatility: 0.2,
  asOf,
});
const fwdMkt = { forward: 104, riskFreeRate: 0.05, volatility: 0.2, asOf } as OptionMarket;

interface EngineCase {
  label: string;
  engine: () => OptionPricingEngine;
  contract: typeof euro;
  mkt: OptionMarket;
  /** Whether the engine supports the extended (higher-order) Greek set. */
  extended: boolean;
  /** MC computes Greeks opt-in (cost-gated, documented); everything else defaults on. */
  greeksByDefault?: boolean;
  /** false → the engine CANNOT compute Greeks; an explicit request must be disclosed, never silent. */
  greeksSupported?: boolean;
}

const CASES: EngineCase[] = [
  {
    label: 'blackScholes',
    engine: () => engines.blackScholes(),
    contract: euro,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'blackScholesMerton',
    engine: () => engines.blackScholesMerton(),
    contract: euro,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'black76',
    engine: () => engines.black76(),
    contract: euro,
    mkt: fwdMkt,
    extended: true,
  },
  {
    // Spot-anchored lattice: first-order Greeks come from its own nodes, and it declares
    // `extendedGreeks: false` rather than difference its sawtooth for the higher-order spot set.
    label: 'binomial(crr)',
    engine: () => engines.binomial(),
    contract: amer,
    mkt: spotMkt,
    extended: false,
  },
  {
    label: 'binomial(leisen-reimer)',
    engine: () => engines.binomial({ variant: 'leisen-reimer' }),
    contract: amer,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'trinomial',
    engine: () => engines.trinomial(),
    contract: amer,
    mkt: spotMkt,
    extended: false,
  },
  {
    label: 'baroneAdesiWhaley',
    engine: () => engines.baroneAdesiWhaley(),
    contract: amer,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'bjerksundStensland2002',
    engine: () => engines.bjerksundStensland2002(),
    contract: amer,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'finiteDifference.crankNicolson',
    engine: () => engines.finiteDifference.crankNicolson(),
    contract: amer,
    mkt: spotMkt,
    extended: false,
  },
  {
    label: 'monteCarlo',
    engine: () => engines.monteCarlo({ paths: 20_000, seed: 7 }),
    contract: euro,
    mkt: spotMkt,
    extended: true,
    greeksByDefault: false,
  },
  {
    label: 'bjerksundStensland',
    engine: () => engines.bjerksundStensland(),
    contract: amer,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'bjerksundStensland1993',
    engine: () => engines.bjerksundStensland1993(),
    contract: amer,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'heston',
    engine: () => engines.heston({ v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.7 }),
    contract: euro,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'sabr',
    engine: () => engines.sabr({ alpha: 0.2, beta: 1, rho: -0.3, nu: 0.6 }),
    contract: euro,
    mkt: spotMkt,
    extended: true,
  },
  {
    label: 'localVolatility',
    engine: () => engines.localVolatility(() => 0.2, { paths: 10_000, seed: 7 }),
    contract: euro,
    mkt: spotMkt,
    extended: false,
    greeksSupported: false,
  },
  { label: 'auto', engine: () => engines.auto(), contract: euro, mkt: spotMkt, extended: true },
];

describe('registry completeness (C2)', () => {
  it('every engines.* factory appears in the contract suite — a new engine cannot skip it', () => {
    const covered = new Set(CASES.map((c) => c.label.split('(')[0]!.split('.')[0]!));
    const missing = Object.keys(engines).filter((k) => k !== 'finiteDifference' && !covered.has(k));
    expect(
      missing,
      `engines.${missing.join(', engines.')} missing from the contract suite`,
    ).toEqual([]);
    // The nested finite-difference namespace is covered via its crankNicolson member.
    expect(CASES.some((c) => c.label.startsWith('finiteDifference.'))).toBe(true);
  });
});

describe.each(CASES)(
  'engine contract: $label',
  ({ engine, contract, mkt, extended, greeksByDefault = true, greeksSupported = true }) => {
    it('prices with finite value; greeks follow the documented default and are never fabricated', () => {
      const r = option.price({ contract, market: mkt, engine: engine() });
      expect(Number.isFinite(r.value)).toBe(true);
      if (!greeksSupported) {
        // Incapable engine: absent AND disclosed; an explicit request gets the distinct
        // capability code — never a silent drop (correction pass C1/C2). EXACT-list greek-warning
        // assertions: exactly one flag per outcome, no duplicates (review follow-up).
        expect(r.greeks).toBeUndefined();
        const greekCodes = (res: typeof r): string[] =>
          res.diagnostics.warnings.map((w) => w.code).filter((c) => c.startsWith('greeks.'));
        expect(greekCodes(r)).toEqual(['greeks.not_computed']);
        expect(
          greekCodes(option.price({ contract, market: mkt, engine: engine(), greeks: false })),
        ).toEqual(['greeks.not_computed']);
        const requested = option.price({
          contract,
          market: mkt,
          engine: engine(),
          greeks: true,
        });
        expect(requested.greeks).toBeUndefined();
        expect(greekCodes(requested)).toEqual(['greeks.unsupported_by_engine']);
      } else if (greeksByDefault) {
        expect(r.greeks).toBeDefined();
        expect(Number.isFinite(r.greeks!.delta)).toBe(true);
      } else {
        // Cost-gated default (MC): absent greeks are FLAGGED, never silent.
        expect(r.greeks).toBeUndefined();
        expect(
          r.diagnostics.warnings.some(
            (w) => w.code === 'greeks.not_computed' || w.code === 'greeks.unsupported_by_engine',
          ),
        ).toBe(true);
        const withGreeks = option.price({
          contract,
          market: mkt,
          engine: engine(),
          greeks: true,
        });
        expect(withGreeks.greeks).toBeDefined();
        expect(Number.isFinite(withGreeks.greeks!.delta)).toBe(true);
      }
    });

    it('honors greeks: false — greeks absent, flagged not-computed, value unchanged', () => {
      const base = option.price({ contract, market: mkt, engine: engine() });
      const r = option.price({ contract, market: mkt, engine: engine(), greeks: false });
      expect(r.greeks).toBeUndefined();
      expect(r.diagnostics.warnings.some((w) => w.code === 'greeks.not_computed')).toBe(true);
      expect(r.value).toBe(base.value); // suppressing greeks never changes the price
    });

    it('extendedGreeks implies greeks (and wins over greeks: false)', () => {
      if (!greeksSupported) return; // no Greeks at all — covered by the disclosure assertions above
      const r = option.price({
        contract,
        market: mkt,
        engine: engine(),
        greeks: false,
        extendedGreeks: true,
      });
      expect(r.greeks).toBeDefined();
      if (extended) {
        expect('vanna' in r.greeks!).toBe(true);
        const vanna = (r.greeks as { vanna: number }).vanna;
        expect(Number.isFinite(vanna)).toBe(true);
        return;
      }
      // An engine that CANNOT honestly produce the higher-order set still honors `greeks`, still
      // returns its first-order set, and DISCLOSES the unhonored part of the request — never a
      // fabricated higher-order number, never a silent drop (P2.4).
      expect('vanna' in r.greeks!).toBe(false);
      expect(Number.isFinite(r.greeks!.delta)).toBe(true);
      expect(
        r.diagnostics.warnings.some((w) => w.code === 'greeks.unsupported_by_engine'),
        'an unhonorable extendedGreeks request must be disclosed',
      ).toBe(true);
    });

    it('echoes assumptions with the expiry-resolution convention', () => {
      const r = option.price({ contract, market: mkt, engine: engine() });
      expect(r.assumptions.conventionsVersion).toBeTruthy();
      expect(r.assumptions.expiryConvention).toBe('us-equity-close');
    });
  },
);

describe('engine contract: stochastic determinism', () => {
  it('the Monte-Carlo engine is bit-identical under the same seed', () => {
    const a = option.price({
      contract: euro,
      market: spotMkt,
      engine: engines.monteCarlo({ paths: 20_000, seed: 42 }),
    });
    const b = option.price({
      contract: euro,
      market: spotMkt,
      engine: engines.monteCarlo({ paths: 20_000, seed: 42 }),
    });
    expect(a.value).toBe(b.value);
    const c = option.price({
      contract: euro,
      market: spotMkt,
      engine: engines.monteCarlo({ paths: 20_000, seed: 43 }),
    });
    expect(c.value).not.toBe(a.value);
  });
});

describe('engine capabilities are behaviorally TRUE (Law 8, C6)', () => {
  // Every registered case's engine claims are verified against what the engine actually does —
  // a capabilities field that lies fails here, so the metadata can never drift into marketing.
  it.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const engine = c.engine();
    const cap = engine.capabilities;
    expect(cap).toBeDefined();

    // styles ↔ supports(): claimed styles are supported; unclaimed vanilla styles are not.
    for (const probe of [euro, amer]) {
      expect(engine.supports(probe), `${probe.style} support`).toBe(
        cap.styles.includes(probe.style),
      );
    }

    // greeks claim ↔ actual result contents on a supported contract.
    const r = engine.price({ contract: c.contract, market: c.mkt, options: { greeks: true } });
    if (cap.greeks === 'none') {
      expect(r.greeks).toBeUndefined();
      expect(
        r.diagnostics.warnings.some((w) => w.code === 'greeks.unsupported_by_engine'),
        'an unhonorable Greeks request must be disclosed',
      ).toBe(true);
    } else {
      expect(r.greeks, 'claimed Greek support must produce Greeks').toBeDefined();
    }

    // extendedGreeks claim ↔ the higher-order set.
    if (cap.extendedGreeks) {
      const ext = engine.price({
        contract: c.contract,
        market: c.mkt,
        options: { extendedGreeks: true },
      });
      expect((ext.greeks as { vanna?: number } | undefined)?.vanna).toBeTypeOf('number');
    }

    // deterministic claim ↔ repeat-call equality (stochastic engines verify seeded equality
    // in the dedicated determinism suite above).
    if (cap.deterministic) {
      const a = engine.price({ contract: c.contract, market: c.mkt });
      const b = engine.price({ contract: c.contract, market: c.mkt });
      expect(a.value).toBe(b.value);
    }
  });

  it('defineOptionPricingEngine REQUIRES capabilities (Law 8)', () => {
    expect(() =>
      defineOptionPricingEngine({
        name: 'no-caps',
        version: '1',
        supports: () => true,
        price: () => ({ value: 1 }) as never,
      } as never),
    ).toThrow(/capabilities/);
  });

  it('defines every built-in engine without executing it or guessing its market inputs', () => {
    const black76 = engines.black76();
    expect(() => defineOptionPricingEngine(black76)).not.toThrow();

    let calls = 0;
    const forwardOnly = defineOptionPricingEngine({
      ...black76,
      name: 'forward-only-custom',
      price: (...callArguments) => {
        calls += 1;
        return black76.price(...callArguments);
      },
    });
    expect(calls).toBe(0);
    expect(Object.isFrozen(forwardOnly)).toBe(true);
    expect(Object.isFrozen(forwardOnly.capabilities)).toBe(true);
    expect(Object.isFrozen(forwardOnly.capabilities.styles)).toBe(true);
  });

  it('behaviorally validates an engine only against explicit engine-appropriate probes', () => {
    const validated = validateOptionPricingEngine(engines.black76(), [
      { contract: euro, market: fwdMkt },
    ]);
    expect(validated.name).toBe('black-76');
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('turns broken supports/results/capability claims into indexed teaching errors', () => {
    const black76 = engines.black76();
    const probe = [{ contract: euro, market: fwdMkt }];
    expect(() =>
      validateOptionPricingEngine(
        {
          ...black76,
          supports: () => {
            throw new Error('adapter offline');
          },
        },
        probe,
      ),
    ).toThrow(/probes\[0\].*supports\(\) threw.*adapter offline/);

    let call = 0;
    expect(() =>
      validateOptionPricingEngine(
        {
          ...black76,
          price: (...callArguments) => ({ ...black76.price(...callArguments), value: 1 + call++ }),
        },
        probe,
      ),
    ).toThrow(/deterministic=true/);

    expect(() =>
      validateOptionPricingEngine({ ...black76, price: () => null as never }, probe),
    ).toThrow(/PriceResult object/);
  });
});

describe('capability claims: dividends are HONORED, not just declared (D6)', () => {
  // A `dividends: ['continuous', …]` claim means the model actually moves when the yield does.
  it.each(
    CASES.filter((c) => c.engine().capabilities.dividends.includes('continuous')).map(
      (c) => [c.label, c] as const,
    ),
  )('%s: a continuous dividend yield changes the price', (_label, c) => {
    const engine = c.engine();
    const base = engine.price({ contract: c.contract, market: c.mkt });
    const withQ = engine.price({ contract: c.contract, market: { ...c.mkt, dividendYield: 0.08 } });
    expect(withQ.value).not.toBe(base.value);
    // A call is worth LESS with a dividend drain on the underlying.
    if (c.contract.type === 'call') expect(withQ.value).toBeLessThan(base.value);
  });

  it.each(
    CASES.filter((c) => c.engine().capabilities.dividends.includes('discrete')).map(
      (c) => [c.label, c] as const,
    ),
  )('%s: a discrete dividend schedule changes the price (escrowed spot)', (_label, c) => {
    const engine = c.engine();
    if (typeof c.mkt.spot !== 'number') return; // forward-quoted markets carry no discrete schedule
    const base = engine.price({ contract: c.contract, market: c.mkt });
    const withDivs = engine.price({
      contract: c.contract,
      market: {
        ...c.mkt,
        dividends: [{ exDate: '2026-06-19', amount: 2.5 }],
      },
    });
    expect(withDivs.value).not.toBe(base.value);
  });
});

describe('capability claims: stochastic engines are SEED-reproducible (D6)', () => {
  it('local-volatility MC: same seed → identical, different seed → different', () => {
    const flat = () => 0.2;
    const price = (seed: number) =>
      engines
        .localVolatility(flat, { paths: 4_000, seed })
        .price({ contract: euro, market: spotMkt }).value;
    expect(price(11)).toBe(price(11));
    expect(price(11)).not.toBe(price(12));
    // And the capabilities say so: deterministic false ⇒ seeded reproducibility is the contract.
    expect(engines.localVolatility(flat, { paths: 100, seed: 1 }).capabilities.deterministic).toBe(
      false,
    );
  });
});
