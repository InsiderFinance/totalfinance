import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  shock,
  scenario,
  taylorPnl,
  stressTest,
  scenarioGrid,
  type Position,
} from '@totalfinance/risk/scenario';

describe('shock parsing', () => {
  it('parses units: % (relative), pts (vol), bp (rate), raw (absolute)', () => {
    expect(shock.spot('-5%')).toEqual({ factor: 'spot', kind: 'percent', value: -0.05 });
    expect(shock.spot(-5)).toEqual({ factor: 'spot', kind: 'absolute', value: -5 });
    expect(shock.volatility('+10pts')).toEqual({
      factor: 'volatility',
      kind: 'absolute',
      value: 0.1,
    });
    expect(shock.riskFreeRate('+50bp')).toEqual({
      factor: 'riskFreeRate',
      kind: 'absolute',
      value: 0.005,
    });
    expect(shock.dividend('+50bp')).toEqual({ factor: 'dividend', kind: 'absolute', value: 0.005 });
    expect(shock.time(1 / 365).value).toBeCloseTo(0.00274, 5);
  });
  it('rejects unparseable shocks', () => {
    expect(() => shock.spot('five percent')).toThrow(InputError);
  });
});

/** The one unit system: theta per calendar day, vega/rho/phi per 1% — the engine scales to raw. */
const DAYS = 365;
const PCT = 100;

describe('taylorPnl — Greeks P&L explain', () => {
  const greeks = { value: 12, spot: 100, delta: 0.5, gamma: 0.02, vega: 10, theta: -5, rho: 8 };
  it('decomposes Δ·dS + ½Γ·dS² + Vega·dσ + Θ·timeStepYears + Rho·dr (display units in)', () => {
    const scn = scenario(
      'stress',
      shock.spot('-5%'), // dS = -5
      shock.volatility('+10pts'), // dσ = +0.10
      shock.riskFreeRate('+50bp'), // dr = +0.005
      shock.time(1 / 365), // timeStepYears
    );
    const p = taylorPnl(greeks, scn);
    expect(p.delta).toBeCloseTo(0.5 * -5, 10);
    expect(p.gamma).toBeCloseTo(0.5 * 0.02 * 25, 10);
    expect(p.vega).toBeCloseTo(10 * PCT * 0.1, 10); // per point × 10 points
    expect(p.theta).toBeCloseTo(-5 * DAYS * (1 / 365), 10); // per day × one day
    expect(p.rho).toBeCloseTo(8 * PCT * 0.005, 10); // per 1% × 50 bp
    expect(p.total).toBeCloseTo(-2.5 + 0.25 + 100 - 5 + 4, 10);
    expect(p.assumptions['greekUnits']).toEqual({
      theta: 'perDay',
      vega: 'per1Percent',
      rho: 'per1Percent',
      phi: 'per1Percent',
    });
  });
  it('gamma makes large spot moves convex (long gamma cushions both directions)', () => {
    const up = taylorPnl(greeks, scenario('up', shock.spot(10))).total;
    const dn = taylorPnl(greeks, scenario('dn', shock.spot(-10))).total;
    // gamma term is symmetric +1.0 each side; delta is ±5
    expect(up).toBeCloseTo(5 + 1, 10);
    expect(dn).toBeCloseTo(-5 + 1, 10);
  });

  it('decomposes the full 2nd-order cross/curvature terms + the dividend carry (ε·dq)', () => {
    const ho = {
      value: 12,
      spot: 100,
      delta: 0.5,
      gamma: 0.02,
      vega: 10,
      theta: -5,
      rho: 8,
      vanna: 1.2,
      vomma: 3,
      charm: 0.4,
      veta: 0.7,
      vera: 2.5,
      deltaRate: 1.5,
      thetaRate: 0.9,
      rhoConvexity: 6,
      thetaConvexity: 11,
      phi: -9,
    };
    const p = taylorPnl(
      ho,
      scenario(
        's',
        shock.spot(-5), // dS
        shock.volatility('+10pts'), // dσ = 0.1
        shock.time(0.02), // timeStepYears
        shock.riskFreeRate('+50bp'), // dr = 0.005
        shock.dividend('+30bp'), // dq = 0.003
      ),
    );
    const dS = -5,
      dSig = 0.1,
      timeStepYears = 0.02,
      dr = 0.005,
      dq = 0.003;
    // vanna/vomma/vera per 1.00 σ (unscaled); charm/veta are the options ∂/∂T derivatives, entering
    // with the calendar sign; the rate/time crosses and phi carry the per-1% / per-day scales.
    expect(p.vanna).toBeCloseTo(1.2 * dS * dSig, 12);
    expect(p.vomma).toBeCloseTo(0.5 * 3 * dSig * dSig, 12);
    expect(p.charm).toBeCloseTo(-0.4 * dS * timeStepYears, 12);
    expect(p.veta).toBeCloseTo(-0.7 * dSig * timeStepYears, 12);
    expect(p.vera).toBeCloseTo(2.5 * dSig * dr, 12);
    expect(p.deltaRate).toBeCloseTo(1.5 * PCT * dS * dr, 12);
    expect(p.thetaRate).toBeCloseTo(0.9 * DAYS * PCT * timeStepYears * dr, 12);
    expect(p.rhoConvexity).toBeCloseTo(0.5 * 6 * PCT * PCT * dr * dr, 12);
    expect(p.thetaConvexity).toBeCloseTo(
      0.5 * 11 * DAYS * DAYS * timeStepYears * timeStepYears,
      12,
    );
    expect(p.phi).toBeCloseTo(-9 * PCT * dq, 12);
    // The total is the exact sum of every term (1st + full 2nd-order + carry).
    const sum =
      p.delta +
      p.gamma +
      p.vega +
      p.theta +
      p.rho +
      p.vanna +
      p.vomma +
      p.charm +
      p.veta +
      p.vera +
      p.deltaRate +
      p.thetaRate +
      p.rhoConvexity +
      p.thetaConvexity +
      p.phi;
    expect(p.total).toBeCloseTo(sum, 12);
    // The resolved dividend move is disclosed in the Law 2 report.
    expect(p.assumptions['dDividendYield']).toBeCloseTo(dq, 12);
  });

  it('RV10 — the disclosed moves are EXACTLY the PnlMove coordinates, by name', () => {
    /**
     * `taylorPnl` used to disclose `dDividend` while `PnlMove` declared `dDividendYield`: one
     * coordinate under two public names, in the same package. Nothing caught it. `assumptions` has
     * an index signature, so TypeScript sees a legal string key; the naming inventory walks declared
     * identifiers, and a key written only inside an object literal is not one.
     *
     * A caller reading `assumptions` to learn what was applied, then feeding those names back into
     * `explainPnl`, would have had the dividend move silently dropped — or thrown at, once Law 12
     * rejects unknown keys. So this asserts the SET, not the presence: an extra `d`-prefixed key is
     * as much a defect as a missing one, and only equality catches both.
     */
    const applied = taylorPnl(
      greeks,
      scenario('s', shock.spot('-5%'), shock.volatility('+2'), shock.dividend('+0.01')),
    );
    const disclosed = Object.keys(applied.assumptions)
      .filter((key) => /^d[A-Z]/.test(key))
      .sort();
    // Mirrors PNL_MOVE_KEYS in pnl-explain.ts, which is module-private.
    const declared = ['dDividendYield', 'dRate', 'dSpot', 'dTimeYears', 'dVolatility'];
    expect(disclosed).toEqual(declared);
  });

  it('rejects a percent dividend shock (no reference level), like vol/rate', () => {
    expect(() => taylorPnl(greeks, scenario('s', shock.dividend('+5%')))).toThrow(
      /reference dividend level/,
    );
  });

  it('Law 2 report grammar: echoes the RESOLVED absolute moves (percent shocks scaled to spot)', () => {
    const p = taylorPnl(
      greeks,
      scenario(
        'stress',
        shock.spot('-5%'),
        shock.volatility('+10pts'),
        shock.riskFreeRate('+50bp'),
      ),
    );
    expect(p.assumptions.conventionsVersion).toBeTruthy();
    expect(p.assumptions['scenario']).toBe('stress');
    expect(p.assumptions['dSpot']).toBeCloseTo(-5, 12); // '-5%' of spot 100, resolved
    expect(p.assumptions['dVolatility']).toBeCloseTo(0.1, 12);
    expect(p.assumptions['dRate']).toBeCloseTo(0.005, 12);
    expect(p.assumptions['dTimeYears']).toBe(0);
    expect(p.diagnostics.warnings).toEqual([]);
    expect('value' in p).toBe(false); // report, not envelope
  });
});

describe('stressTest — book across scenarios', () => {
  const book: Position[] = [
    { id: 'A', quantity: 10, greeks: { value: 12, spot: 100, delta: 0.5, gamma: 0.02, vega: 10 } },
    { id: 'B', quantity: -4, greeks: { value: 8, spot: 100, delta: -0.6, gamma: 0.03, vega: 6 } },
  ];
  it('sums position P&L into book P&L with per-position breakdown (H11 report)', () => {
    const crash = scenario('crash', shock.spot('-10%'), shock.volatility('+20pts'));
    const res = stressTest({ positions: book, scenarios: [crash] });
    // H11: the ENVELOPE reports (assumptions + diagnostics + the valuation summary)…
    expect(res.assumptions.scenarios).toBe(1);
    expect(res.assumptions.positions).toBe(2);
    expect(res.assumptions.valuation).toBe('greeks-taylor');
    expect(res.diagnostics.warnings).toEqual([]);
    expect(res.scenarios).toHaveLength(1);
    const r = res.scenarios[0]!;
    const a = taylorPnl(book[0]!.greeks!, crash);
    expect(r.byPosition[0]!.pnl).toBeCloseTo(a.total * 10, 8);
    expect(r.byPosition[0]!.valuationMethod).toBe('greeks-taylor');
    expect(r.pnl).toBeCloseTo(r.byPosition[0]!.pnl + r.byPosition[1]!.pnl, 10);
    expect(r.attribution.total).toBeCloseTo(r.pnl, 10);
    // …while the INNER attributions stay bare — no nested envelope inside a report.
    expect('assumptions' in r.attribution).toBe(false);
    expect('assumptions' in r.byPosition[0]!.attribution).toBe(false);
  });
  it('honors a custom reprice function (full revaluation)', () => {
    const res = stressTest(
      {
        positions: [{ id: 'X', quantity: 2, greeks: { value: 50 } }],
        scenarios: [scenario('s', shock.spot('-5%'))],
        options: { reprice: () => 47 },
      }, // new per-unit value
    );
    expect(res.scenarios[0]!.byPosition[0]!.pnl).toBeCloseTo((47 - 50) * 2, 10);
    expect(res.scenarios[0]!.byPosition[0]!.valuationMethod).toBe('reprice');
    expect(res.assumptions.valuation).toBe('reprice');
  });

  it('H11: custom reprice with NO current mark is rejected typed, never differenced against 0', () => {
    // Before H11 this position's whole revalued price reported as "P&L" (base assumed 0).
    expect(() =>
      stressTest({
        positions: [{ id: 'X', quantity: 2 }],
        scenarios: [scenario('s', shock.spot('-5%'))],
        options: { reprice: () => 47 },
      }),
    ).toThrow(/current mark|never assumed/);
    // An explicit Position.value works without greeks.
    const res = stressTest({
      positions: [{ id: 'X', quantity: 2, value: 50 }],
      scenarios: [scenario('s', shock.spot('-5%'))],
      options: { reprice: () => 47 },
    });
    expect(res.scenarios[0]!.byPosition[0]!.pnl).toBeCloseTo(-6, 10);
  });
  it('throws when a position has neither greeks nor a reprice fn', () => {
    expect(() => stressTest({ positions: [{ id: 'Z' }], scenarios: [scenario('s')] })).toThrow(
      InputError,
    );
  });
});

describe('scenarioGrid', () => {
  const greeks = { value: 12, spot: 100, delta: 0.5, gamma: 0.02, vega: 10 };
  it('produces a P&L surface; the all-zero-shock center is 0', () => {
    const res = scenarioGrid({
      greeks,
      spotShocks: [shock.spot(-10), shock.spot(0), shock.spot(10)],
      volatilityShocks: [shock.volatility(-0.05), shock.volatility(0), shock.volatility(0.05)],
    });
    // H12: the report is self-interpreting — both axes carry their resolved shock semantics.
    expect(res.pnl).toHaveLength(3);
    expect(res.pnl[1]![1]).toBeCloseTo(0, 10); // no shock → no P&L
    expect(res.pnl[2]![2]).toBeGreaterThan(res.pnl[1]![1]!); // up spot + up vol for long delta+vega
    expect(res.spotAxis).toHaveLength(3);
    expect(res.spotAxis[0]!.resolvedMove).toBeCloseTo(-10, 12); // absolute shock passes through
    expect(res.volatilityAxis[2]!.resolvedMove).toBeCloseTo(0.05, 12);
    expect(res.assumptions.conventionsVersion.length).toBeGreaterThan(0);
  });
});

describe('percent shocks on non-spot factors are rejected by the Taylor engine (review fix)', () => {
  const greeks = { value: 12, spot: 100, vega: 10, rho: 8 };

  it("shock.volatility('+10%') throws a teaching error instead of moving vol +10 POINTS", () => {
    // The old code applied the pct value as an ABSOLUTE move: '+10%' became dσ = +0.10.
    expect(() => taylorPnl(greeks, scenario('s', shock.volatility('+10%')))).toThrow(InputError);
    expect(() => taylorPnl(greeks, scenario('s', shock.volatility('+10%')))).toThrow(
      /reference volatility level/,
    );
    expect(() => taylorPnl(greeks, scenario('s', shock.volatility('+10%')))).toThrow(/'\+2pts'/);
  });

  it('absolute vol points and raw decimals still work', () => {
    expect(taylorPnl(greeks, scenario('s', shock.volatility('+2pts'))).vega).toBeCloseTo(
      10 * PCT * 0.02,
      12,
    );
    expect(taylorPnl(greeks, scenario('s', shock.volatility(0.02))).vega).toBeCloseTo(
      10 * PCT * 0.02,
      12,
    );
  });

  it('percent rate and custom-factor shocks are rejected too; bp still works', () => {
    expect(() => taylorPnl(greeks, scenario('s', shock.riskFreeRate('+5%')))).toThrow(
      /reference riskFreeRate level/,
    );
    expect(() => taylorPnl(greeks, scenario('s', shock.factor('crude', '-10%')))).toThrow(
      InputError,
    );
    expect(taylorPnl(greeks, scenario('s', shock.riskFreeRate('+50bp'))).rho).toBeCloseTo(
      8 * PCT * 0.005,
      12,
    );
  });

  it('percent SPOT shocks keep working (the one factor with a reference level)', () => {
    const g = { value: 12, spot: 100, delta: 0.5 };
    expect(taylorPnl(g, scenario('s', shock.spot('-5%'))).delta).toBeCloseTo(0.5 * -5, 12);
  });
});

describe('scenario input hardening (deep-sweep boundary)', () => {
  const greeks = { value: 5.2, spot: 100, delta: 0.55, gamma: 0.02, vega: 0.12 };

  it('taylorPnl teaches the scenario shape when shocks is missing/non-array', () => {
    // A `{ name }` without `shocks` used to die on a raw "scn.shocks is not iterable" TypeError.
    expect(() => taylorPnl(greeks, { name: 'x' } as never)).toThrow(
      /taylorPnl: scenario\.shocks must be an array of shocks/,
    );
    expect(() => taylorPnl(greeks, { name: 'x', shocks: 42 } as never)).toThrow(
      /taylorPnl: scenario\.shocks must be an array of shocks/,
    );
    expect(() => taylorPnl(greeks, { name: 'x' } as never)).toThrow(InputError);
    // The scenario() constructor output remains valid.
    expect(taylorPnl(greeks, scenario('down', shock.spot(-5))).delta).toBeCloseTo(-2.75, 12);
  });

  it('stressTest rejects a null options bag', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it).
    const positions: Position[] = [{ id: 'p1', quantity: 1, greeks }];
    expect(() =>
      stressTest({
        positions,
        scenarios: [scenario('down', shock.spot(-5))],
        options: null as never,
      }),
    ).toThrow(/stressTest: options must be an object/);
  });
});
