import { describe, expect, it } from 'vitest';
import { optionExpiryToMs } from '@totalfinance/core';
import {
  BarSchema,
  OptionContractSchema,
  OptionQuoteSchema,
  coreSchemas,
  schema,
} from '@totalfinance/core/schema';

describe('core payload schemas', () => {
  it('parses a valid bar and rejects a missing field', () => {
    const bar = BarSchema.parse({
      symbol: 'AAPL',
      timestampMs: Date.UTC(2026, 0, 2),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000_000,
    });
    expect(bar.close).toBe(100.5);
    expect(
      BarSchema.safeParse({ symbol: 'AAPL', timestampMs: 0, open: 1, high: 1, low: 1 }).success,
    ).toBe(false);
  });

  it('validates an option quote with a nested contract', () => {
    const quote = OptionQuoteSchema.parse({
      contract: {
        underlying: 'AAPL',
        type: 'call',
        style: 'american',
        strike: 105,
        expiry: '2026-09-18',
        expiresAt: optionExpiryToMs('2026-09-18'),
        expiryConvention: 'us-equity-close' as const,
      },
      timestampMs: Date.UTC(2026, 5, 18),
      bid: 3.1,
      ask: 3.3,
      openInterest: 1200,
    });
    expect(quote.contract.strike).toBe(105);
    expect(Object.isFrozen(quote.contract)).toBe(true);
  });

  it('enforces resolved-expiry invariants through every schema composition path', () => {
    const valid = {
      underlying: 'AAPL',
      type: 'call' as const,
      style: 'american' as const,
      strike: 105,
      expiry: '2026-09-18',
      expiresAt: optionExpiryToMs('2026-09-18'),
      expiryConvention: 'us-equity-close' as const,
    };
    const invalid = { ...valid, expiresAt: optionExpiryToMs('2026-09-19') };

    expect(OptionContractSchema.safeParse(invalid).success).toBe(false);
    expect(OptionQuoteSchema.safeParse({ contract: invalid, timestampMs: 0 }).success).toBe(false);
    expect(schema.array(OptionContractSchema).safeParse([invalid]).success).toBe(false);
    expect(
      schema.object({ contract: OptionContractSchema.optional() }).safeParse({ contract: invalid })
        .success,
    ).toBe(false);
    expect(OptionContractSchema.describe('resolved contract').safeParse(invalid).success).toBe(
      false,
    );
    expect(OptionContractSchema['~standard'].validate(invalid).issues).toBeDefined();

    const nested = OptionQuoteSchema.parse({ contract: valid, timestampMs: 0 });
    expect(Object.isFrozen(nested.contract)).toBe(true);
    expect(OptionContractSchema.safeParse(invalid, { mode: 'off' })).toEqual({
      success: true,
      data: invalid,
    });
  });

  it('exposes JSON Schema for every core payload', () => {
    for (const schema of Object.values(coreSchemas)) {
      expect(schema.toJSONSchema().type).toBe('object');
    }
  });
});
