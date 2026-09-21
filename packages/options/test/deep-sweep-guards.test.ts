/**
 * Boundary guards exposed by the R3 deep sweep (tools/first-touch/deep-sweep.test.ts).
 *
 * Three classes, one law each:
 *
 *   1. **direct kernels with a meaning-changing STRING `type` field** — an unvalidated `'Call'`/`'garbage'`
 *      would silently fall through `type === 'call' ? … : …` and price the OTHER leg (design law
 *      #4). Every such kernel throws a typed `input.invalid_enum` instead.
 *   2. **optional trailing options objects** — `null` (or a primitive) slips past an `options = {}`
 *      default parameter and used to escape as a raw `TypeError` on the first property read. Every
 *      such boundary answers with a typed `input.wrong_type` that names the slot.
 *   3. **container-shape fields read with `.length` / called as methods** — a missing/mistyped
 *      `weights`, `observationTimes`, `spec.levels`, batch column, or engine argument teaches its
 *      slot name instead of crashing (`undefined.length`, `chosen.supports is not a function`).
 */
import { describe, expect, it } from 'vitest';
import { InputError, isQuantError } from '@totalfinance/core';
import { dupireLocalVolatility } from '@totalfinance/options/local-volatility';
import {
  americanImpliedVolatility,
  autocallable,
  basket,
  compareEngines,
  engines,
  heston,
  impliedVolatility,
  localVolatility,
  option,
  priceMany,
  sabr,
  selectQuotePrice,
  type OptionBatchColumns,
} from '@totalfinance/options';
import { monteCarloEuropean } from '@totalfinance/options/monte-carlo';
import {
  bachelierGreeks,
  bachelierImpliedVolatility,
  bachelierPrice,
} from '@totalfinance/options/bachelier';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesImpliedVolatility,
  blackScholesPrice,
  blackScholesPriceBounds,
} from '@totalfinance/options/black-scholes';
import { blackScholesPriceMany, blackScholesPriceManyInto } from '@totalfinance/options/batch';
import {
  black76Greeks,
  black76ImpliedVolatility,
  black76Price,
  black76PriceBounds,
} from '@totalfinance/options/black76';

const INVALID_ENUM = 'input.invalid_enum';
const WRONG_TYPE = 'input.wrong_type';
const MISSING_FIELD = 'input.missing_field';

function expectTyped(run: () => unknown, code: string, names?: string): void {
  try {
    run();
    throw new Error(`expected a typed ${code} throw`);
  } catch (err) {
    expect(err, `expected InputError, got ${String(err)}`).toBeInstanceOf(InputError);
    expect(isQuantError(err)).toBe(true);
    expect((err as InputError).code).toBe(code);
    if (names) expect((err as InputError).message).toContain(names);
  }
}

const HESTON_PARAMS = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.6 };
const HESTON_INPUT = { spot: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 };
const SABR_PARAMS = { alpha: 0.2, beta: 0.5, rho: -0.3, nu: 0.4 };
const MC = { seed: 7, paths: 200 } as const;
const FLAT = (): number => 0.2;

const CONTRACT = option.call({
  convention: 'us-equity-close',
  underlying: 'ACME',
  strike: 100,
  expiry: '2026-06-19',
  style: 'european',
});
const MARKET = { spot: 105, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-01-02T00:00:00Z' };

// ── 1. direct kernels validate the meaning-changing `type` field ─────────────────────────────────

describe('direct kernels reject a mistyped option type (never price the other leg)', () => {
  const cases: Array<[string, (type: never) => unknown]> = [
    [
      'blackScholesPrice',
      (t) =>
        blackScholesPrice({
          type: t,
          spot: 105,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          dividendYield: 0.01,
          volatility: 0.2,
        }),
    ],
    [
      'blackScholesGreeks',
      (t) =>
        blackScholesGreeks({
          type: t,
          spot: 105,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          dividendYield: 0.01,
          volatility: 0.2,
        }),
    ],
    [
      'blackScholesExtendedGreeks',
      (t) =>
        blackScholesExtendedGreeks({
          type: t,
          spot: 105,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          dividendYield: 0.01,
          volatility: 0.2,
        }),
    ],
    [
      'blackScholesPriceBounds',
      (t) =>
        blackScholesPriceBounds({
          type: t,
          spot: 105,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          dividendYield: 0.01,
        }),
    ],
    [
      'blackScholesImpliedVolatility',
      (t) =>
        blackScholesImpliedVolatility({
          type: t,
          price: 9,
          spot: 105,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          dividendYield: 0.01,
        }),
    ],
    [
      'black76Price',
      (t) =>
        black76Price({
          type: t,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          volatility: 0.2,
        }),
    ],
    [
      'black76Greeks',
      (t) =>
        black76Greeks({
          type: t,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
          volatility: 0.2,
        }),
    ],
    [
      'black76PriceBounds',
      (t) =>
        black76PriceBounds({
          type: t,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
        }),
    ],
    [
      'black76ImpliedVolatility',
      (t) =>
        black76ImpliedVolatility({
          type: t,
          price: 5.5,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.04,
        }),
    ],
    [
      'bachelierPrice',
      (t) =>
        bachelierPrice({
          type: t,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.02,
          normalVolatility: 15,
        }),
    ],
    [
      'bachelierGreeks',
      (t) =>
        bachelierGreeks({
          type: t,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.02,
          normalVolatility: 15,
        }),
    ],
    [
      'bachelierImpliedVolatility',
      (t) =>
        bachelierImpliedVolatility({
          type: t,
          price: 4,
          forward: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.02,
        }),
    ],
    [
      'monteCarloEuropean',
      (t) =>
        monteCarloEuropean({
          type: t,
          spot: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          volatility: 0.2,
          options: MC,
        }),
    ],
    [
      'heston.cosineExpansion',
      (t) =>
        heston.cosineExpansion({
          type: t,
          spot: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          parameters: HESTON_PARAMS,
          terms: 64,
        }),
    ],
    [
      'heston.monteCarloEstimate',
      (t) =>
        heston.monteCarloEstimate({
          type: t,
          spot: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          parameters: HESTON_PARAMS,
          options: { ...MC, steps: 5 },
        }),
    ],
    [
      'localVolatility.monteCarloEstimate',
      (t) =>
        localVolatility.monteCarloEstimate({
          type: t,
          spot: 100,
          strike: 100,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          localVolatility: FLAT,
          options: { ...MC, steps: 5 },
        }),
    ],
  ];

  for (const [name, run] of cases) {
    it(`${name} throws input.invalid_enum for 'Call' and 'garbage'`, () => {
      expectTyped(() => run('Call' as never), INVALID_ENUM, 'type');
      expectTyped(() => run('garbage' as never), INVALID_ENUM, 'type');
    });
  }

  it("correct 'call'/'put' still compute (and differ)", () => {
    const call = blackScholesPrice({
      type: 'call',
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.2,
    });
    const put = blackScholesPrice({
      type: 'put',
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.2,
    });
    expect(Number.isFinite(call)).toBe(true);
    expect(Number.isFinite(put)).toBe(true);
    expect(call).not.toBeCloseTo(put, 6);
    expect(
      black76Price({
        type: 'call',
        forward: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.04,
        volatility: 0.2,
      }),
    ).toBeGreaterThan(0);
    expect(
      bachelierPrice({
        type: 'put',
        forward: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.02,
        normalVolatility: 15,
      }),
    ).toBeGreaterThan(0);
  });
});

// ── 2. optional trailing options objects reject null / primitives ────────────────────────────────

describe('optional `options` boundaries teach on null (never TypeError on a property read)', () => {
  it('hestonPrice / hestonImpliedVolatility', () => {
    expectTyped(
      () =>
        heston.price({
          type: 'call',
          input: HESTON_INPUT,
          parameters: HESTON_PARAMS,
          options: null as never,
        }),
      WRONG_TYPE,
      'options',
    );
    expectTyped(
      () =>
        heston.impliedVolatility({
          type: 'call',
          input: HESTON_INPUT,
          parameters: HESTON_PARAMS,
          options: 42 as never,
        }),
      WRONG_TYPE,
      'options',
    );
  });

  it('sabrVolatility / sabrPrice', () => {
    expectTyped(
      () =>
        sabr.volatility({
          input: { forward: 100, strike: 105, timeToExpiryYears: 0.5 },
          parameters: SABR_PARAMS,
          options: null as never,
        }),
      WRONG_TYPE,
      'options',
    );
    expectTyped(
      () =>
        sabr.price({
          type: 'call',
          input: { forward: 100, strike: 105, timeToExpiryYears: 0.5, riskFreeRate: 0.03 },
          parameters: SABR_PARAMS,
          options: null as never,
        }),
      WRONG_TYPE,
      'options',
    );
  });

  it('dupireLocalVolatility', () => {
    expectTyped(
      () =>
        dupireLocalVolatility({
          impliedVolatility: FLAT,
          market: { spot: 100, riskFreeRate: 0.03 },
          options: null as never,
        }),
      WRONG_TYPE,
      'options',
    );
  });

  it('impliedVolatility / option.impliedVolatility / americanImpliedVolatility', () => {
    const input = {
      type: 'call',
      price: 9,
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
    } as const;
    expectTyped(() => impliedVolatility(input, null as never), WRONG_TYPE, 'options');
    // Object form (P3.5b): there is no separate options arg to null out — a null INPUT teaches.
    expectTyped(() => option.impliedVolatility(null as never), WRONG_TYPE, 'input');
    const american = { ...CONTRACT, style: 'american' as const };
    expectTyped(
      () =>
        americanImpliedVolatility({
          contract: american,
          market: { ...MARKET, price: 4 },
          options: null as never,
        }),
      WRONG_TYPE,
      'options',
    );
  });

  it('priceMany / compareEngines', () => {
    expectTyped(() => priceMany(null as never), WRONG_TYPE, 'input');
    expectTyped(
      () => compareEngines({ contract: CONTRACT, market: MARKET, options: null as never }),
      WRONG_TYPE,
      'options',
    );
    expectTyped(
      () => compareEngines({ contract: CONTRACT, market: MARKET, options: 'garbage' as never }),
      WRONG_TYPE,
      'options',
    );
  });

  it('undefined still means "omitted" — defaults apply', () => {
    expect(
      sabr.volatility({
        input: { forward: 100, strike: 105, timeToExpiryYears: 0.5 },
        parameters: SABR_PARAMS,
      }),
    ).toBeGreaterThan(0);
    expect(
      heston.price({ type: 'call', input: HESTON_INPUT, parameters: HESTON_PARAMS }).value,
    ).toBeGreaterThan(0);
    const res = impliedVolatility({
      type: 'call',
      price: 9,
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
    });
    expect(res.diagnostics.converged).toBe(true);
  });
});

// ── 3. container-shape fields teach their slot names ─────────────────────────────────────────────

describe('engine arguments are engine-shaped or teach the factory gesture', () => {
  it('option.price rejects a non-engine third argument', () => {
    expectTyped(
      () => option.price({ contract: CONTRACT, market: MARKET, engine: 42 as never }),
      WRONG_TYPE,
      'engine',
    );
    expectTyped(
      () => option.price({ contract: CONTRACT, market: MARKET, engine: {} as never }),
      WRONG_TYPE,
      'engine',
    );
  });

  it('priceMany / americanImpliedVolatility / compareEngines reject a non-engine', () => {
    expectTyped(
      () => priceMany({ contracts: [CONTRACT], market: MARKET, engine: 'garbage' as never }),
      WRONG_TYPE,
      'engine',
    );
    const american = { ...CONTRACT, style: 'american' as const };
    expectTyped(
      () =>
        americanImpliedVolatility({
          contract: american,
          market: { ...MARKET, price: 4 },
          options: { engine: 42 as never },
        }),
      WRONG_TYPE,
      'engine',
    );
    expectTyped(
      () =>
        compareEngines({ contract: CONTRACT, market: MARKET, options: { engines: [42 as never] } }),
      WRONG_TYPE,
      'engine',
    );
  });

  it('a real engine still flows through', () => {
    const res = option.price({
      contract: CONTRACT,
      market: MARKET,
      engine: engines.blackScholesMerton(),
    });
    expect(res.value).toBeGreaterThan(0);
  });
});

describe('array-shaped input fields teach their slot names (never crash on .length)', () => {
  it('localVolatilityGrid requires levels and times arrays', () => {
    // 3B.1b taxonomy: an ABSENT required axis is input.missing_field (it used to misreport as
    // wrong_type), and the slot is named from the validated argument — `specification.levels`.
    expectTyped(
      () => localVolatility.grid(FLAT, { times: [0.1, 1] } as never),
      MISSING_FIELD,
      'specification.levels',
    );
    expectTyped(
      () => localVolatility.grid(FLAT, { levels: [50, 150] } as never),
      MISSING_FIELD,
      'specification.times',
    );
    // A PRESENT-but-mistyped axis is still the wrong-type teaching, at the same named slot.
    expectTyped(
      () => localVolatility.grid(FLAT, { levels: 50, times: [0.1, 1] } as never),
      WRONG_TYPE,
      'specification.levels',
    );
  });

  it('basket pricers require a weights array', () => {
    const input = {
      spots: [100, 95],
      strike: 95,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatilities: [0.2, 0.25],
      correlation: [
        [1, 0.5],
        [0.5, 1],
      ],
    };
    // An ABSENT required array is a missing field, not a wrong-typed one (the four-code matrix:
    // omitted → missing_field with a worked example). The old array guard reported wrong_type for
    // absence and this test pinned it; the 3B.1b generated-spec migration corrected the code.
    expectTyped(
      () => basket.approximatePrice({ ...(input as object), type: 'call' } as never),
      MISSING_FIELD,
      'weights',
    );
    expectTyped(
      () => basket.monteCarloPrice({ ...(input as object), type: 'call' } as never, MC),
      MISSING_FIELD,
      'weights',
    );
    // Present-but-not-an-array is still the type error.
    expectTyped(
      () =>
        basket.approximatePrice({ ...(input as object), type: 'call', weights: 'half' } as never),
      WRONG_TYPE,
      'weights',
    );
  });

  it('autocallable requires an observationTimes array', () => {
    const input = {
      spot: 100,
      riskFreeRate: 0.03,
      volatility: 0.2,
      autocallBarrier: 105,
      couponRate: 0.02,
      knockInBarrier: 70,
    };
    // Same ruling as the basket case above: absence is missing_field now.
    expectTyped(
      () => autocallable.monteCarloPrice(input as never, MC),
      MISSING_FIELD,
      'observationTimes',
    );
    expectTyped(
      () =>
        autocallable.monteCarloPrice(
          { ...(input as object), observationTimes: 'soon' } as never,
          MC,
        ),
      WRONG_TYPE,
      'observationTimes',
    );
  });

  it('batch pricers name a missing column instead of crashing', () => {
    const cols = (): OptionBatchColumns => ({
      spot: Float64Array.from([100, 105]),
      strike: Float64Array.from([100, 100]),
      volatility: Float64Array.from([0.2, 0.25]),
      riskFreeRate: Float64Array.from([0.03, 0.03]),
      timeToExpiryYears: Float64Array.from([0.5, 0.5]),
      type: Int8Array.from([1, -1]),
    });
    const missingStrike = { ...cols() } as Record<string, unknown>;
    delete missingStrike['strike'];
    expectTyped(
      () => blackScholesPriceManyInto(missingStrike as never, new Float64Array(2)),
      MISSING_FIELD,
      'strike',
    );
    expectTyped(() => blackScholesPriceMany(missingStrike as never), MISSING_FIELD, 'strike');
    // Intact columns still price.
    const out = new Float64Array(2);
    blackScholesPriceManyInto(cols(), out);
    expect(out[0]).toBeGreaterThan(0);
  });
});

describe('selectQuotePrice is a guarded boundary (options re-export of the core kernel)', () => {
  const quote = {
    contract: {
      underlying: 'ACME',
      type: 'call',
      style: 'european',
      strike: 100,
      expiry: '2026-06-19',
    },
    ts: Date.UTC(2026, 0, 2),
    bid: 5.4,
    ask: 5.6,
  } as const;

  it('rejects a null/primitive quote with a typed error', () => {
    expectTyped(() => selectQuotePrice(null as never, 'mid'), WRONG_TYPE, 'quote');
    expectTyped(() => selectQuotePrice(undefined as never, 'mid'), WRONG_TYPE, 'quote');
    expectTyped(() => selectQuotePrice(42 as never, 'mid'), WRONG_TYPE, 'quote');
  });

  it('rejects a mistyped source (\'Mid\' must teach, not read as "field absent")', () => {
    expectTyped(() => selectQuotePrice(quote as never, 'Mid' as never), INVALID_ENUM, 'source');
    expectTyped(() => selectQuotePrice(quote as never, 'garbage' as never), INVALID_ENUM, 'source');
  });

  it('valid sources still resolve (mid falls back to (bid+ask)/2)', () => {
    expect(selectQuotePrice(quote as never, 'mid')).toBeCloseTo(5.5, 12);
    expect(selectQuotePrice(quote as never, 'bid')).toBe(5.4);
    expect(selectQuotePrice(quote as never, 'last')).toBeUndefined();
  });
});
