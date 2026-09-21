/**
 * Schema ↔ interface drift guard (WS3.10). For every exported market-data type there is a payload
 * schema in `coreSchemas`, and a fully-populated fixture (typed as the interface) round-trips through
 * `parse` in STRICT mode. This is the permanent guard against divergence:
 *   - add a field to the interface → the typed fixture must set it → strict parse rejects the now-
 *     unknown key unless the schema was updated too;
 *   - drop a field from the schema → the typed fixture still carries it → strict parse rejects it.
 */

import { describe, expect, it } from 'vitest';
import type {
  Bar,
  Quote,
  Trade,
  OptionContract,
  OptionQuote,
  OptionTrade,
  Dividend,
  CorporateAction,
  RateCurvePoint,
  RateCurve,
  OrderBookLevel,
  OrderBook,
  RawFundamentalsRecord,
} from '@totalfinance/core';
import { optionExpiryToMs } from '@totalfinance/core';
import { coreSchemas } from '@totalfinance/core/schema';
// Core-internal on purpose (validation plumbing, not analysis API) — the parity suite below needs
// the runtime door itself, so it imports the source module the way core's own tests may.
import { requireRateCurveData } from '../src/market-data.js';

const contract: OptionContract = {
  underlying: 'AAPL',
  type: 'call',
  style: 'american',
  strike: 190,
  expiry: '2026-06-19',
  expiresAt: optionExpiryToMs('2026-06-19'),
  expiryConvention: 'us-equity-close' as const,
  multiplier: 100,
  settlement: 'physical',
  exerciseTime: 'PM',
  currency: 'USD',
  root: 'AAPL',
  occSymbol: 'AAPL260619C00190000',
  deliverable: { cash: 0, shares: [{ symbol: 'AAPL', quantity: 100 }], notes: 'standard' },
  adjusted: false,
};

const optionQuote: OptionQuote = {
  contract,
  timestampMs: 1_780_000_000_000,
  bid: 4.2,
  ask: 4.4,
  bidSize: 10,
  askSize: 12,
  mid: 4.3,
  last: 4.35,
  mark: 4.3,
  volume: 1500,
  openInterest: 8000,
  underlyingPrice: 191.2,
  impliedVolatility: 0.24,
  exchange: 'OPRA',
  conditions: ['regular'],
};

// One fully-populated fixture per exported market-data type, typed as its interface.
const fixtures: { [K in keyof typeof coreSchemas]: unknown } = {
  Bar: {
    symbol: 'AAPL',
    timestampMs: 1_780_000_000_000,
    open: 190,
    high: 192,
    low: 189,
    close: 191,
    volume: 1_000_000,
    vwap: 190.7,
    adjusted: true,
  } satisfies Bar,
  Quote: {
    symbol: 'AAPL',
    timestampMs: 1_780_000_000_000,
    bid: 190.9,
    ask: 191.1,
    bidSize: 100,
    askSize: 120,
    exchange: 'XNAS',
    conditions: ['regular'],
  } satisfies Quote,
  Trade: {
    symbol: 'AAPL',
    timestampMs: 1_780_000_000_000,
    price: 191,
    size: 100,
    exchange: 'XNAS',
    conditions: ['regular'],
    sequence: 42,
  } satisfies Trade,
  OptionContract: contract,
  OptionQuote: optionQuote,
  OptionTrade: {
    ...optionQuote,
    price: 4.35,
    size: 5,
    sequence: 99,
    aggressorSide: 'buy',
    premium: 2175,
    notional: 95_600,
    openingLikely: true,
  } satisfies OptionTrade,
  Dividend: {
    symbol: 'AAPL',
    exDate: '2026-05-08',
    payDate: '2026-05-15',
    amount: 0.25,
    currency: 'USD',
    type: 'regular',
  } satisfies Dividend,
  CorporateAction: {
    symbol: 'AAPL',
    effectiveDate: '2026-06-09',
    type: 'split',
    ratio: 4,
    cash: 0,
    newSymbol: 'AAPL',
    details: { board: 'approved', factor: 4 },
  } satisfies CorporateAction,
  RateCurvePoint: {
    date: '2026-06-19',
    zeroRate: 0.045,
  } satisfies RateCurvePoint,
  RateCurve: {
    currency: 'USD',
    asOf: 1_780_000_000_000,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    points: [{ date: '2026-06-19', zeroRate: 0.045 }],
    interpolation: 'log-linear',
  } satisfies RateCurve,
  OrderBookLevel: {
    price: 190.9,
    size: 100,
    exchange: 'XNAS',
  } satisfies OrderBookLevel,
  OrderBook: {
    symbol: 'AAPL',
    timestampMs: 1_780_000_000_000,
    bids: [{ price: 190.9, size: 100, exchange: 'XNAS' }],
    asks: [{ price: 191.1, size: 120, exchange: 'XNAS' }],
  } satisfies OrderBook,
  RawFundamentalsRecord: {
    symbol: 'AAPL',
    fiscalPeriod: '2026Q1',
    asOf: 1_780_000_000_000,
    fields: { revenue: 123_000_000_000, currency: 'USD', guidance: null },
  } satisfies RawFundamentalsRecord,
};

describe('schema ↔ interface parity (drift guard, WS3.10)', () => {
  for (const name of Object.keys(coreSchemas) as (keyof typeof coreSchemas)[]) {
    it(`${name}: a valid fixture round-trips through parse in strict mode`, () => {
      const schema = coreSchemas[name];
      const fixture = fixtures[name];
      // Strict mode: an unknown field (schema missing an interface key) throws here.
      const parsed = schema.parse(fixture, { mode: 'strict' });
      expect(parsed).toEqual(fixture);
    });
  }
});

/**
 * Regression for an external-review finding: `RawFundamentalsRecordSchema.fields` was `record(unknown())`, which
 * accepted arbitrary objects/booleans while the `RawFundamentalsRecord.fields` interface allows only
 * `number | string | null`. The schema now matches the type, so value-level drift is rejected.
 */
describe('RawFundamentalsRecord.fields values are scalar-or-null (schema matches the interface)', () => {
  it('rejects a nested-object field value', () => {
    const drifted = { symbol: 'AAPL', fields: { pe: { nested: true } } };
    expect(coreSchemas.RawFundamentalsRecord.safeParse(drifted).success).toBe(false);
  });

  it('rejects a boolean field value', () => {
    const drifted = { symbol: 'AAPL', fields: { flag: true } };
    expect(coreSchemas.RawFundamentalsRecord.safeParse(drifted).success).toBe(false);
  });

  it('accepts number | string | null field values', () => {
    const ok = { symbol: 'AAPL', fields: { revenue: 1_000, ccy: 'USD', guidance: null } };
    expect(coreSchemas.RawFundamentalsRecord.safeParse(ok).success).toBe(true);
  });
});

/**
 * RateCurve schema ↔ runtime-validator parity (2026-08-23, second external review). `RateCurve`
 * used to have THREE incompatible contracts: the TS type, `requireRateCurveData`, and a structural
 * `RateCurveSchema` that rejected valid compounding forms ('annual' et al.), accepted empty and
 * unordered points, and closed the vendor-decoration openness the runtime documents. The schema
 * now ROUTES through `requireRateCurveData`, so this suite is the permanent guard: every curve —
 * valid or invalid — must get the SAME accept/refuse verdict from both doors.
 */
describe('RateCurveSchema ↔ requireRateCurveData parity (one curve contract)', () => {
  const asOf = Date.UTC(2026, 6, 20); // 2026-07-20T00:00Z
  const base: RateCurve = {
    currency: 'USD',
    asOf,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    points: [
      { date: '2026-10-20', zeroRate: 0.045 },
      { date: '2027-07-20', zeroRate: 0.043 },
    ],
    interpolation: 'linearZero',
  };

  const cases: { name: string; curve: unknown; accepted: boolean }[] = [
    { name: 'a plain continuous curve', curve: base, accepted: true },
    {
      name: "'annual' compounding (valid InterestCompounding the old schema enum rejected)",
      curve: { ...base, compounding: 'annual' },
      accepted: true,
    },
    {
      name: "'semiannual' compounding",
      curve: { ...base, compounding: 'semiannual' },
      accepted: true,
    },
    {
      name: 'the periodic-object compounding form',
      curve: { ...base, compounding: { type: 'periodic', periodsPerYear: 52 } },
      accepted: true,
    },
    {
      name: 'a vendor-decorated curve (Law 12: entries stay open)',
      curve: { ...base, vendor: 'refinitiv', pullId: 'abc-123' },
      accepted: true,
    },
    {
      name: 'a vendor-decorated pillar',
      curve: { ...base, points: [{ date: '2026-10-20', zeroRate: 0.045, vendorTag: 'sofr' }] },
      accepted: true,
    },
    {
      name: 'a pillar exactly AT asOf (the legal t = 0 anchor)',
      curve: { ...base, points: [{ date: '2026-07-20', zeroRate: 0.044 }, ...base.points] },
      accepted: true,
    },
    {
      name: 'a negative-rate curve that still has a real discount factor',
      curve: { ...base, currency: 'CHF', points: [{ date: '2027-07-20', zeroRate: -0.0075 }] },
      accepted: true,
    },
    {
      name: 'empty points (an empty curve discounts nothing)',
      curve: { ...base, points: [] },
      accepted: false,
    },
    {
      name: 'unordered points',
      curve: {
        ...base,
        points: [
          { date: '2027-07-20', zeroRate: 0.043 },
          { date: '2026-10-20', zeroRate: 0.045 },
        ],
      },
      accepted: false,
    },
    {
      name: 'zeroRate -2 under annual compounding (1 + r/m ≤ 0 — no real discount factor)',
      curve: {
        ...base,
        compounding: 'annual',
        points: [{ date: '2027-07-20', zeroRate: -2 }],
      },
      accepted: false,
    },
    {
      name: "a pillar before the curve's asOf (discounting into the past)",
      curve: { ...base, points: [{ date: '2026-07-19', zeroRate: 0.045 }, ...base.points] },
      accepted: false,
    },
    {
      name: 'an impossible calendar pillar date',
      curve: { ...base, points: [{ date: '2025-02-30', zeroRate: 0.04 }] },
      accepted: false,
    },
    {
      name: 'an unknown compounding label',
      curve: { ...base, compounding: 'hourly-ish' },
      accepted: false,
    },
    {
      name: 'the retired pillar shape ({ rate } instead of { zeroRate })',
      curve: { ...base, points: [{ date: '2026-10-20', rate: 0.045 }] },
      accepted: false,
    },
    { name: 'a non-object', curve: 42, accepted: false },
  ];

  for (const { name, curve, accepted } of cases) {
    it(`${name}: both doors ${accepted ? 'accept' : 'refuse'}`, () => {
      const schemaVerdict = coreSchemas.RateCurve.safeParse(curve).success;
      let runtimeVerdict = true;
      try {
        requireRateCurveData('parity-test', 'curve', curve);
      } catch {
        runtimeVerdict = false;
      }
      expect(schemaVerdict, 'schema verdict').toBe(accepted);
      expect(runtimeVerdict, 'runtime validator verdict').toBe(accepted);
    });
  }

  it('the schema refusal carries the runtime validator’s own teaching', () => {
    const refused = coreSchemas.RateCurve.safeParse({ ...base, points: [] });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.message).toMatch(
        /at least one pillar — an empty curve discounts nothing/,
      );
    }
  });
});
