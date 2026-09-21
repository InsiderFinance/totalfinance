import { describe, expect, it, vi } from 'vitest';
import * as core from '@totalfinance/core';
import { InputError, isComputed, resolvedExpiry, type OptionQuote } from '@totalfinance/core';
import { observedSkew, type ObservedSkewInput } from '@totalfinance/volatility';

const expiry = '2026-07-17';
const asOf = Date.parse('2026-06-01T20:00:00Z');
const expiresAt = resolvedExpiry(expiry).expiresAt;

function quote(
  type: 'call' | 'put',
  strike: number,
  impliedVolatility: number,
  delta?: number,
  date = expiry,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'american',
      strike,
      expiry: date,
      ...resolvedExpiry(date),
    },
    timestampMs: asOf,
    impliedVolatility,
    openInterest: 100,
    ...(delta === undefined ? {} : { greeks: { delta } }),
  };
}

function dense(): ObservedSkewInput {
  return {
    quotes: [
      quote('call', 90, 0.45, 0.9),
      quote('put', 90, 0.35, -0.1),
      quote('call', 95, 0.4, 0.75),
      quote('put', 95, 0.33, -0.25),
      quote('call', 100, 0.29, 0.5),
      quote('put', 100, 0.31, -0.5),
      quote('call', 105, 0.305, 0.25),
      quote('put', 105, 0.5, -0.75),
      quote('call', 110, 0.32, 0.1),
      quote('put', 110, 0.55, -0.9),
    ],
    market: { spot: 100, asOf },
    config: { expiry },
  };
}

function typedError(run: () => unknown, code: string): void {
  expect(run).toThrow(InputError);
  expect(run).toThrow(expect.objectContaining({ code }));
}

function jsonSafe(value: unknown): void {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  if (value && typeof value === 'object') for (const v of Object.values(value)) jsonSafe(v);
}

describe('observedSkew — observed sampling, units and provenance', () => {
  it('reports the actual nearest wings and mean spot-ATM, without model data', () => {
    const input = dense();
    const original = structuredClone(input);
    const result = observedSkew(input);
    expect(isComputed(result)).toBe(true);
    const { value, assumptions } = result;
    expect(value.unavailableReason).toBeNull();
    expect(value.contractCount).toBe(10);
    expect(value.atm).toMatchObject({ strike: 100, impliedVolatility: 0.3 });
    expect(value.atm!.observations.map((row) => row.quoteIndex).sort()).toEqual([4, 5]);
    expect(value.call25Delta.selected).toMatchObject({
      quoteIndex: 6,
      type: 'call',
      strike: 105,
      delta: 0.25,
      impliedVolatility: 0.305,
      timestampMs: asOf,
    });
    expect(value.put25Delta.selected).toMatchObject({
      quoteIndex: 3,
      type: 'put',
      strike: 95,
      delta: -0.25,
      impliedVolatility: 0.33,
    });
    expect(value.call10Delta.selected!.strike).toBe(110);
    expect(value.put10Delta.selected!.strike).toBe(90);
    expect(value.riskReversal25Delta).toBeCloseTo(-0.025, 14);
    expect(value.butterfly25Delta).toBeCloseTo(0.0175, 14);
    expect(value.riskReversal10Delta).toBeCloseTo(-0.03, 14);
    expect(value.butterfly10Delta).toBeCloseTo(0.035, 14);
    expect(assumptions).toMatchObject({
      impliedVolatilitySource: 'provided',
      deltaSource: 'provided',
      atmMethod: 'nearest-spot-strike-mean',
      riskReversalConvention: 'callMinusPut',
      minimumContracts: 6,
      deltaTolerance: 0.12,
      tailDeltaTolerance: 0.05,
      slopeWindow: 0.1,
      asOf,
      spot: 100,
      expiryConvention: 'us-equity-close',
    });
    expect(assumptions.model).toBeUndefined();
    expect(result.diagnostics.warnings).toEqual([]);
    expect(input).toEqual(original);
    jsonSafe(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('changes only the risk-reversal sign when putMinusCall is selected', () => {
    const input = dense();
    const base = observedSkew(input).value;
    const result = observedSkew({
      ...input,
      config: { expiry, riskReversalConvention: 'putMinusCall' },
    });
    expect(result.value.riskReversal25Delta).toBe(-base.riskReversal25Delta!);
    expect(result.value.riskReversal10Delta).toBe(-base.riskReversal10Delta!);
    expect(result.value.butterfly25Delta).toBe(base.butterfly25Delta);
    expect(result.value.skewSlope).toBe(base.skewSlope);
    expect(result.value.smile).toEqual(base.smile);
  });

  it('fits decimal IV against spot moneyness on observed OTM points only', () => {
    const input = dense();
    input.quotes = [92, 96, 100, 104, 108].flatMap((strike) => {
      const otmIv = 0.3 - 0.2 * (strike / 100 - 1);
      return [
        quote('call', strike, strike >= 100 ? otmIv : 2, 0.5),
        quote('put', strike, strike < 100 ? otmIv : 3, -0.5),
      ];
    });
    const value = observedSkew(input).value;
    expect(value.skewSlope).toBeCloseTo(-0.2, 13);
    expect(value.slopePointCount).toBe(5);
    expect(value.smile.map((point) => point.strike)).toEqual([92, 96, 100, 104, 108]);
    expect(value.smile[0]).toMatchObject({
      call: { impliedVolatility: 2 },
      otmImpliedVolatility: 0.316,
    });
    expect(
      observedSkew({ ...input, config: { expiry, slopeWindow: 0.05 } }).value.unavailableReasons
        .skewSlope,
    ).toBe('insufficient_slope_points');
  });

  it('retains raw smile and term-read conversion data across explicitly selected expiries', () => {
    const input = dense();
    const far = '2026-10-16';
    const later = input.quotes.map((q) => ({
      ...q,
      impliedVolatility: q.impliedVolatility! + 0.04,
      contract: { ...q.contract, expiry: far, ...resolvedExpiry(far) },
    }));
    input.quotes = [...later, ...input.quotes];
    const nearRead = observedSkew(input).value;
    const farRead = observedSkew({ ...input, config: { expiry: far } }).value;
    expect(farRead.atm!.impliedVolatility - nearRead.atm!.impliedVolatility).toBeCloseTo(0.04, 14);
    expect(farRead.daysToExpiry).toBeGreaterThan(nearRead.daysToExpiry);
    expect(farRead.expiresAt).toBe(resolvedExpiry(far).expiresAt);
    expect(nearRead.excludedQuotes.every((row) => row.reason === 'other_expiry')).toBe(true);
    expect(nearRead.smile[0]!.put!.openInterest).toBe(100);
  });

  it('includes both decimal slope-window boundaries without admitting genuinely outside strikes', () => {
    const input = dense();
    input.quotes = [90, 95, 105, 110].map((strike) =>
      quote(strike < 100 ? 'put' : 'call', strike, 0.3 - 0.2 * (strike / 100 - 1)),
    );
    input.config = { expiry, minimumContracts: 4, slopeWindow: 0.1 };
    const read = observedSkew(input).value;
    expect(read.slopePointCount).toBe(4);
    expect(read.skewSlope).toBeCloseTo(-0.2, 13);
    for (const strike of [90 - 1e-10, 110 + 1e-10]) {
      const outside = quote(strike < 100 ? 'put' : 'call', strike, 0.9);
      const extended = observedSkew({ ...input, quotes: [...input.quotes, outside] }).value;
      expect(extended.slopePointCount).toBe(4);
      expect(extended.skewSlope).toBe(read.skewSlope);
      expect(extended.smile).toHaveLength(5);
    }
  });

  it('uses vendor deltas as given even when they disagree with a typical pricing-model delta', () => {
    const input = dense();
    input.quotes = input.quotes.map((q) => ({
      ...q,
      greeks: {
        delta: q.contract.type === 'call' ? (q.contract.strike === 90 ? 0.25 : 0.8) : -0.5,
      },
    }));
    const read = observedSkew(input).value;
    expect(read.call25Delta.selected!.strike).toBe(90);
    expect(read.call25Delta.selected!.delta).toBe(0.25);
    expect(read.put25Delta.selected).toBeNull();
  });
});

describe('observedSkew — missing data never becomes invented wings', () => {
  it('keeps a sparse 25-delta body while 10-delta tails remain null with reasons', () => {
    const input = dense();
    input.quotes = input.quotes.filter((q) => q.contract.strike >= 95 && q.contract.strike <= 105);
    const result = observedSkew(input);
    expect(result.value.atm).not.toBeNull();
    expect(result.value.riskReversal25Delta).toBeCloseTo(-0.025, 14);
    expect(result.value.call10Delta).toMatchObject({
      selected: null,
      nearestDeltaDistance: 0.15,
      unavailableReason: 'outside_delta_tolerance',
    });
    expect(result.value.put10Delta.unavailableReason).toBe('outside_delta_tolerance');
    expect(result.value.riskReversal10Delta).toBeNull();
    expect(result.value.butterfly10Delta).toBeNull();
    expect(result.value.unavailableReasons.riskReversal10Delta).toBe('missing_wing');
    expect(result.diagnostics.warnings.length).toBeGreaterThan(0);
    jsonSafe(result);
  });

  it('keeps IV-bearing observations without delta for ATM/smile, never for wings', () => {
    const input = dense();
    input.quotes = input.quotes.map(({ greeks: _greeks, ...q }) => q);
    const read = observedSkew(input);
    expect(read.value.atm!.impliedVolatility).toBe(0.3);
    expect(read.value.contractCount).toBe(10);
    expect(read.value.call25Delta.unavailableReason).toBe('missing_delta');
    expect(read.value.riskReversal25Delta).toBeNull();
    expect(
      read.value.smile.every((point) => point.call!.delta === null && point.put!.delta === null),
    ).toBe(true);
    expect(
      read.diagnostics.warnings.some((w) => w.code === 'volatility.observed_skew_missing_delta'),
    ).toBe(true);
    const canonical: readonly OptionQuote[] = input.quotes;
    expect(observedSkew({ ...input, quotes: canonical }).value).toEqual(read.value);
  });

  it('excludes missing IV even if prices could support an IV solve; undefined is not a zero', () => {
    const input = dense();
    input.quotes = input.quotes.map(({ impliedVolatility: _iv, ...q }) => ({
      ...q,
      bid: 1,
      ask: 2,
    }));
    const read = observedSkew(input);
    expect(read.value.contractCount).toBe(0);
    expect(read.value.unavailableReason).toBe('insufficient_contracts');
    expect(read.value.atm).toBeNull();
    expect(read.value.smile).toEqual([]);
    expect(read.value.excludedQuotes).toHaveLength(10);
    expect(
      read.value.excludedQuotes.every((row) => row.reason === 'missing_implied_volatility'),
    ).toBe(true);
  });

  it('gates aggregate reads by minimumContracts and honors an explicit lower threshold', () => {
    const input = dense();
    input.quotes = input.quotes.slice(2, 7);
    expect(observedSkew(input).value.unavailableReason).toBe('insufficient_contracts');
    const smaller = observedSkew({ ...input, config: { expiry, minimumContracts: 5 } }).value;
    expect(smaller.unavailableReason).toBeNull();
    expect(smaller.riskReversal25Delta).not.toBeNull();
  });

  it('does not call an ITM counterpart the missing OTM side or include it in the slope', () => {
    const input = dense();
    input.quotes = input.quotes.filter((q) => q.contract.type === 'call');
    const read = observedSkew({ ...input, config: { expiry, minimumContracts: 5 } }).value;
    expect(read.smile[0]).toMatchObject({
      strike: 90,
      call: { impliedVolatility: 0.45 },
      put: null,
      otmImpliedVolatility: null,
      otmUnavailableReason: 'missing_otm_side',
      impliedVolatilityVsAtm: null,
    });
    expect(read.skewSlope).toBeNull();
    expect(read.unavailableReasons.skewSlope).toBe('insufficient_slope_points');
    expect(read.put25Delta.unavailableReason).toBe('no_usable_implied_volatility');
  });

  it('accepts exact-match-only zero tolerances and inclusive distance boundaries', () => {
    const input = dense();
    expect(
      observedSkew({ ...input, config: { expiry, deltaTolerance: 0, tailDeltaTolerance: 0 } }).value
        .riskReversal25Delta,
    ).not.toBeNull();
    const changed = input.quotes.map((q) =>
      q.greeks?.delta === 0.25 ? { ...q, greeks: { delta: 0.375 } } : q,
    );
    expect(
      observedSkew({ ...input, quotes: changed, config: { expiry, deltaTolerance: 0.125 } }).value
        .call25Delta.selected!.delta,
    ).toBe(0.375);
    expect(
      observedSkew({ ...input, quotes: changed, config: { expiry, deltaTolerance: 0.124 } }).value
        .call25Delta.selected,
    ).toBeNull();
  });
});

describe('observedSkew — determinism and snapshot boundaries', () => {
  it('resolves decimal tail-delta ties by lower strike without reversing risk reversal', () => {
    const input = dense();
    input.quotes = [
      quote('call', 105, 0.3, 0.05),
      quote('call', 110, 0.4, 0.15),
      quote('put', 90, 0.35, -0.1),
    ];
    input.config = { expiry, minimumContracts: 3 };
    for (const quotes of [input.quotes, [...input.quotes].reverse()]) {
      const read = observedSkew({ ...input, quotes }).value;
      expect(read.call10Delta.selected).toMatchObject({
        strike: 105,
        delta: 0.05,
        impliedVolatility: 0.3,
      });
      expect(read.call10Delta.nearestDeltaDistance).toBe(0.05);
      expect(read.riskReversal10Delta).toBeCloseTo(-0.05, 14);
    }
    input.quotes = [quote('put', 90, 0.3, -0.05), quote('put', 95, 0.4, -0.15)];
    input.config.minimumContracts = 2;
    expect(observedSkew(input).value.put10Delta.selected!.strike).toBe(90);
  });

  it('does not round genuine delta differences, zero tolerances, or unobserved tails into ties', () => {
    const input = dense();
    input.config = { expiry, minimumContracts: 2 };
    input.quotes = [quote('call', 105, 0.3, 0.05), quote('call', 110, 0.4, 0.15 - 1e-12)];
    expect(observedSkew(input).value.call10Delta.selected!.strike).toBe(110);
    input.quotes = [quote('call', 105, 0.3, 0.1 + Number.EPSILON), quote('call', 110, 0.4, 0.1)];
    input.config.tailDeltaTolerance = 0;
    expect(observedSkew(input).value.call10Delta.selected!.strike).toBe(110);
    input.quotes = input.quotes.slice(0, 1);
    input.config.minimumContracts = 1;
    expect(observedSkew(input).value.call10Delta.unavailableReason).toBe('outside_delta_tolerance');
    input.quotes = [quote('call', 110, 0.4, 0.15 + 1e-12)];
    input.config.tailDeltaTolerance = 0.05;
    expect(observedSkew(input).value.call10Delta.selected).toBeNull();
  });

  it('honors decimal positive-tolerance boundaries without altering the selected delta', () => {
    const input = dense();
    input.quotes = [quote('call', 105, 0.3, 0.4), quote('put', 95, 0.35, -0.4)];
    input.config = { expiry, minimumContracts: 2, deltaTolerance: 0.15 };
    const read = observedSkew(input).value;
    expect(read.call25Delta.selected!.delta).toBe(0.4);
    expect(read.put25Delta.selected!.delta).toBe(-0.4);
    expect(read.call25Delta.nearestDeltaDistance).toBe(Math.abs(0.4 - 0.25));
    expect(read.riskReversal25Delta).toBeCloseTo(-0.05, 14);
  });

  it('breaks numeric ties against the global minimum without chaining approximate winners', () => {
    const input = dense();
    input.config = { expiry, minimumContracts: 3, tailDeltaTolerance: 0.06 };
    input.quotes = [
      quote('call', 105, 0.3, 0.15 + Number.EPSILON),
      quote('call', 110, 0.4, 0.15 + Number.EPSILON / 2),
      quote('call', 115, 0.5, 0.15),
    ];
    for (const quotes of [input.quotes, [...input.quotes].reverse()]) {
      const read = observedSkew({ ...input, quotes }).value;
      expect(read.call10Delta.selected!.strike).toBe(110);
      expect(read.call10Delta.selected!.delta).toBe(0.15 + Number.EPSILON / 2);
    }
  });

  it('applies the same numeric lower-strike tie rule to decimal spot-ATM distances', () => {
    const input = dense();
    input.market.spot = 0.1;
    input.config.minimumContracts = 2;
    input.quotes = [quote('call', 0.05, 0.3, 0.25), quote('call', 0.15, 0.4, 0.25)];
    for (const quotes of [input.quotes, [...input.quotes].reverse()]) {
      expect(observedSkew({ ...input, quotes }).value.atm!.strike).toBe(0.05);
    }
    input.quotes = [quote('call', 0.1 - Number.EPSILON, 0.3), quote('call', 0.1, 0.4)];
    expect(observedSkew(input).value.atm!.strike).toBe(0.1);
  });

  it('breaks ATM/wing ties by lower strike regardless of input order', () => {
    const input = dense();
    input.quotes = [
      quote('call', 98, 0.3, 0.125),
      quote('put', 98, 0.32, -0.125),
      quote('call', 102, 0.4, 0.375),
      quote('put', 102, 0.42, -0.375),
    ];
    input.config = { expiry, minimumContracts: 4, deltaTolerance: 0.125 };
    for (const quotes of [input.quotes, [...input.quotes].reverse()]) {
      const read = observedSkew({ ...input, quotes }).value;
      expect(read.atm!.strike).toBe(98);
      expect(read.atm!.impliedVolatility).toBe(0.31);
      expect(read.call25Delta.selected!.strike).toBe(98);
      expect(read.put25Delta.selected!.strike).toBe(98);
    }
  });

  it('discloses duplicates and selects actual smile observations deterministically', () => {
    const input = dense();
    input.quotes = [
      ...input.quotes,
      { ...quote('call', 105, 0.4, 0.25), timestampMs: asOf - 1000 },
    ];
    for (const quotes of [input.quotes, [...input.quotes].reverse()]) {
      const read = observedSkew({ ...input, quotes });
      expect(read.value.smile.find((p) => p.strike === 105)!.call!.impliedVolatility).toBe(0.305);
      expect(read.value.call25Delta.selected!.impliedVolatility).toBe(0.305);
      expect(
        read.diagnostics.warnings.some(
          (w) => w.code === 'volatility.observed_skew_duplicate_contract',
        ),
      ).toBe(true);
    }
  });

  it('selects the exact expiry label, returning unavailable instead of choosing another expiry', () => {
    const input = dense();
    const read = observedSkew({ ...input, config: { expiry: '2026-10-16' } }).value;
    expect(read.unavailableReason).toBe('expiry_not_found');
    expect(read.atm).toBeNull();
    expect(read.riskReversal25Delta).toBeNull();
    expect(read.smile).toEqual([]);
    expect(observedSkew({ ...input, quotes: [] }).value.unavailableReason).toBe('expiry_not_found');
  });

  it('keeps live 0DTE until the exact expiry instant, with no invented time floor', () => {
    const input = dense();
    const live = observedSkew({ ...input, market: { spot: 100, asOf: expiresAt - 1 } }).value;
    expect(live.timeToExpiryYears).toBeGreaterThan(0);
    expect(live.unavailableReason).toBeNull();
    for (const now of [expiresAt, expiresAt + 1, expiresAt + 86400000]) {
      const read = observedSkew({ ...input, market: { spot: 100, asOf: now } }).value;
      expect(read.unavailableReason).toBe('expired');
      expect(read.atm).toBeNull();
      expect(read.riskReversal25Delta).toBeNull();
      expect(read.call25Delta.unavailableReason).toBe('expired');
      expect(read.daysToExpiry).toBe(0);
    }
  });

  it('excludes future quotes and accepts canonical zoned/datetime expiry resolution', () => {
    const input = dense();
    input.quotes = input.quotes.map((q) => ({ ...q, timestampMs: asOf + 1 }));
    const result = observedSkew(input);
    expect(result.value.contractCount).toBe(0);
    expect(result.value.excludedQuotes.every((row) => row.reason === 'future_quote')).toBe(true);
    const date = '2026-07-17T20:00:00Z';
    const explicit = observedSkew({
      quotes: [quote('call', 100, 0.2, 0.25, date)],
      market: { spot: 100, asOf: '2026-06-01T16:00:00-04:00' },
      config: { expiry: date, minimumContracts: 1 },
    });
    expect(explicit.assumptions.expiryConvention).toBe('explicit-instant');
    expect(explicit.assumptions.asOf).toBe(asOf);
  });

  it('does not mutate frozen inputs or return references to caller-owned records', () => {
    const input = dense();
    input.quotes.forEach((q) => {
      Object.freeze(q.contract);
      Object.freeze(q);
    });
    Object.freeze(input.quotes);
    Object.freeze(input.market);
    Object.freeze(input.config);
    Object.freeze(input);
    const read = observedSkew(input);
    read.value.call25Delta.selected!.impliedVolatility = 999;
    expect(input.quotes[6]!.impliedVolatility).toBe(0.305);
  });
});

describe('observedSkew — closed controls, open observations and faithful validation codes', () => {
  it('validates each distinct expiry triple once per invocation on a 4,000-quote, 20-expiry chain', () => {
    const input = dense();
    input.quotes = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-07-${String(i + 1).padStart(2, '0')}`;
      const base = quote('call', 100, 0.3, 0.25, date);
      return Array.from({ length: 200 }, (_, j) => ({
        ...base,
        contract: { ...base.contract, strike: 75 + j * 0.25 },
      }));
    }).flat();
    const validate = vi.spyOn(core, 'validateResolvedExpiry');
    try {
      const first = observedSkew(input);
      expect(first.value.contractCount).toBe(200);
      expect(validate).toHaveBeenCalledTimes(20);
      expect(observedSkew(input)).toEqual(first);
      expect(validate).toHaveBeenCalledTimes(40);
      // Mutating a previously valid input cannot benefit from trust from the preceding call.
      input.quotes[0]!.contract.expiresAt++;
      typedError(() => observedSkew(input), 'input.wrong_shape');
    } finally {
      validate.mockRestore();
    }
  });

  it('never skips later-row numeric, enum, cross-field or cross-contract guards on a cache hit', () => {
    const cases: Array<[string, unknown, string]> = [
      ['contract.expiresAt', undefined, 'input.missing_field'],
      ['contract.expiresAt', null, 'input.wrong_type'],
      ['contract.expiresAt', NaN, 'input.nan'],
      ['contract.expiresAt', Infinity, 'input.not_finite'],
      ['contract.expiresAt', expiresAt + 1, 'input.wrong_shape'],
      ['contract.expiryConvention', 'explicit-instant', 'input.wrong_shape'],
      ['contract.expiryConvention', 'typo', 'input.invalid_enum'],
      ['contract.expiry', '2026-10-16', 'input.wrong_shape'],
      ['contract.expiry', '2026-07-17T16:00:00', 'input.wrong_shape'],
      ['contract.style', 'typo', 'input.invalid_enum'],
      ['contract.strike', 0, 'input.out_of_range'],
      ['contract.underlying', 'OTHER', 'input.wrong_shape'],
      ['contract.type', 'put', 'input.out_of_range'],
      ['impliedVolatility', null, 'input.wrong_type'],
      ['greeks.delta', NaN, 'input.nan'],
      ['openInterest', -1, 'input.out_of_range'],
      ['timestampMs', Infinity, 'input.not_finite'],
    ];
    for (const [path, value, code] of cases) {
      const first = quote('call', 100, 0.3, 0.25);
      const second = structuredClone(first);
      const [parent, field] = path.split('.');
      Object.assign(field ? (parent === 'greeks' ? second.greeks! : second.contract) : second, {
        [field ?? parent!]: value,
      });
      typedError(() => observedSkew({ ...dense(), quotes: [first, second] }), code);
    }
    const other = '2026-10-16';
    const valid = quote('call', 100, 0.3, 0.25, other);
    const invalid = structuredClone(valid);
    invalid.contract.expiresAt++;
    // Even an expiry excluded from the requested read must pass its full coordinate validation.
    typedError(() => observedSkew({ ...dense(), quotes: [valid, invalid] }), 'input.wrong_shape');
  });

  it('retains first-touch missing-field errors after an identical expiry was already validated', () => {
    for (const path of [
      'contract',
      'timestampMs',
      'contract.underlying',
      'contract.expiry',
      'contract.type',
      'contract.style',
      'contract.strike',
      'contract.expiresAt',
      'contract.expiryConvention',
    ]) {
      const first = quote('call', 100, 0.3, 0.25);
      const second = structuredClone(first);
      const [parent, field] = path.split('.');
      delete (field ? second.contract : second)[(field ?? parent) as never];
      typedError(
        () => observedSkew({ ...dense(), quotes: [first, second] }),
        'input.missing_field',
      );
    }
  });

  it('accepts vendor decoration without consuming it or coercing alternate quote formats', () => {
    const input = dense();
    const quotes = input.quotes.map((q) => ({
      ...q,
      vendorDelta: 999,
      extra: { source: 'test' },
      contract: { ...q.contract, vendorId: 'abc' },
    }));
    expect(observedSkew({ ...input, quotes })).toEqual(observedSkew(input));
    typedError(
      () =>
        observedSkew({
          ...input,
          quotes: [{ strike: 100, expiry, type: 'call', impliedVolatility: 0.2 }],
        } as never),
      'input.missing_field',
    );
  });

  it.each([undefined, null, 1, 'chain', []])('rejects malformed root %j', (bad) => {
    typedError(
      () => observedSkew(bad as never),
      bad === undefined ? 'input.missing_field' : 'input.wrong_type',
    );
  });

  it.each(['quotes', 'market', 'config'] as const)('teaches missing %s', (key) => {
    const input = dense();
    delete (input as unknown as Record<string, unknown>)[key];
    typedError(() => observedSkew(input), 'input.missing_field');
  });

  it.each(['input', 'market', 'config'] as const)('rejects unknown fields in %s', (key) => {
    const input = dense();
    const target = key === 'input' ? input : input[key];
    Object.assign(target, { typo: 1 });
    typedError(() => observedSkew(input), 'input.unknown_field');
  });

  it.each(['minimumContracts', 'deltaTolerance', 'tailDeltaTolerance', 'slopeWindow'] as const)(
    'runs the complete numeric ladder for %s',
    (key) => {
      for (const [bad, code] of [
        [null, 'input.wrong_type'],
        ['0.1', 'input.wrong_type'],
        [NaN, 'input.nan'],
        [Infinity, 'input.not_finite'],
        [-1, 'input.out_of_range'],
      ] as const) {
        const input = dense();
        Object.assign(input.config, { [key]: bad });
        typedError(() => observedSkew(input), code);
      }
      const input = dense();
      Object.assign(input.config, { [key]: undefined });
      expect(observedSkew(input)).toEqual(observedSkew(dense()));
    },
  );

  it.each([
    { minimumContracts: 0 },
    { minimumContracts: 1.5 },
    { minimumContracts: 1e308 },
    { deltaTolerance: 1.01 },
    { tailDeltaTolerance: 1.01 },
    { slopeWindow: 0 },
    { slopeWindow: 1.01 },
  ])('rejects domain violation %j', (config) => {
    typedError(
      () => observedSkew({ ...dense(), config: { expiry, ...config } }),
      'input.out_of_range',
    );
  });

  it.each([null, 'putsMinusCalls', 1])('rejects invalid RR convention %j', (value) => {
    typedError(
      () =>
        observedSkew({ ...dense(), config: { expiry, riskReversalConvention: value } } as never),
      'input.invalid_enum',
    );
  });

  it('requires expiry/asOf and rejects Date objects, zone-less datetimes and inconsistent contract resolution', () => {
    const input = dense();
    typedError(() => observedSkew({ ...input, config: {} } as never), 'input.missing_field');
    typedError(
      () => observedSkew({ ...input, market: { spot: 100 } } as never),
      'input.missing_field',
    );
    for (const value of [null, new Date(asOf), '2026-06-01T16:00:00']) {
      typedError(
        () => observedSkew({ ...input, market: { spot: 100, asOf: value } } as never),
        'input.wrong_type',
      );
    }
    for (const value of [null, new Date(expiresAt), '2026-07-17T16:00:00']) {
      typedError(
        () => observedSkew({ ...input, config: { expiry: value } } as never),
        'input.wrong_type',
      );
    }
    const bad = structuredClone(input);
    bad.quotes[0]!.contract.expiresAt++;
    typedError(() => observedSkew(bad), 'input.wrong_shape');
    delete (bad.quotes[0]!.contract as unknown as Record<string, unknown>)['expiry'];
    typedError(() => observedSkew(bad), 'input.missing_field');
  });

  it.each(['impliedVolatility', 'delta', 'openInterest'] as const)(
    'validates supplied observation %s but permits omission',
    (field) => {
      for (const [bad, code] of [
        [null, 'input.wrong_type'],
        ['0.2', 'input.wrong_type'],
        [NaN, 'input.nan'],
        [Infinity, 'input.not_finite'],
      ] as const) {
        const input = dense();
        // A row's delta rides `greeks.delta` (B7); the other observations stay on the row.
        Object.assign(field === 'delta' ? input.quotes[0]!.greeks! : input.quotes[0]!, {
          [field]: bad,
        });
        typedError(() => observedSkew(input), code);
      }
    },
  );

  it('rejects invalid IV/delta/strike domains and mixed underlyings', () => {
    for (const q of [
      quote('call', 100, 0),
      quote('call', 100, -0.2),
      quote('call', 0, 0.2),
      quote('call', 100, 0.2, -0.25),
      quote('put', 100, 0.2, 0.25),
      quote('call', 100, 0.2, 1.01),
      { ...quote('put', 100, 0.2, -0.25), openInterest: -1 },
    ]) {
      typedError(() => observedSkew({ ...dense(), quotes: [q] }), 'input.out_of_range');
    }
    const input = dense();
    input.quotes[0]!.contract.underlying = 'Y';
    typedError(() => observedSkew(input), 'input.wrong_shape');
  });

  it('preserves missing open interest as null, never fabricating zero volume', () => {
    const input = dense();
    input.quotes = input.quotes.map(({ openInterest: _oi, ...q }) => q);
    const result = observedSkew(input);
    expect(result.value.call25Delta.selected!.openInterest).toBeNull();
    expect(
      result.value.smile.every(
        (point) => point.call!.openInterest === null && point.put!.openInterest === null,
      ),
    ).toBe(true);
  });

  it.each([0, -1])('rejects non-positive spot %s', (spot) => {
    typedError(() => observedSkew({ ...dense(), market: { spot, asOf } }), 'input.out_of_range');
  });

  it('rejects timestamps outside the representable epoch-ms domain without guessing seconds', () => {
    typedError(
      () => observedSkew({ ...dense(), market: { spot: 100, asOf: 1e308 } }),
      'input.out_of_range',
    );
    const input = dense();
    input.quotes[0]!.timestampMs = 1e308;
    typedError(() => observedSkew(input), 'input.out_of_range');
  });

  it('reports safe null-with-reason on derived numerical overflow rather than JSON-changing Infinity', () => {
    const input = dense();
    input.quotes = [99.9999999, 100, 100.0000001, 100.0000002].flatMap((strike, i) => [
      quote('call', strike, i % 2 ? 1e308 : 1e300, 0.25),
      quote('put', strike, i % 2 ? 1e308 : 1e300, -0.25),
    ]);
    const result = observedSkew(input);
    expect(result.value.skewSlope).toBeNull();
    expect(result.value.unavailableReasons.skewSlope).toBe('non_finite_result');
    jsonSafe(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
