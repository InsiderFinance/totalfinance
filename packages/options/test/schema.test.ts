import { describe, expect, it } from 'vitest';
import { optionExpiryToMs } from '@totalfinance/core';
import { OptionContractSchema, schemas } from '@totalfinance/options/schema';

describe('option schemas', () => {
  it('parses a valid RESOLVED contract; an unresolved one is not a contract yet (D2)', () => {
    const c = schemas.OptionContract.parse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: 105,
      expiry: '2026-09-18',
      expiresAt: optionExpiryToMs('2026-09-18'),
      expiryConvention: 'us-equity-close',
    });
    expect(c).toMatchObject({ underlying: 'AAPL', type: 'call', strike: 105 });
    // Without the resolved instant the schema refuses — build the contract first.
    const r = schemas.OptionContract.safeParse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: 105,
      expiry: '2026-09-18',
    });
    expect(r.success).toBe(false);
    // Zoned datetime labels (builder-supported) are accepted too.
    const zoned = schemas.OptionContract.parse({
      underlying: 'SPX',
      type: 'put',
      style: 'european',
      strike: 6000,
      expiry: '2026-09-18T13:00:00-04:00',
      expiresAt: optionExpiryToMs('2026-09-18T13:00:00-04:00'),
      expiryConvention: 'explicit-instant',
    });
    expect(zoned.strike).toBe(6000);
  });

  it('the implied-vol schema reuses blackScholesShape descriptions — no bare fields (F9)', () => {
    const props = schemas.BlackScholesImpliedVolatilityInput.toJSONSchema().properties ?? {};
    for (const f of [
      'price',
      'spot',
      'strike',
      'timeToExpiryYears',
      'riskFreeRate',
      'type',
      'dividendYield',
    ]) {
      expect(
        (props[f] as { description?: string })?.description,
        `${f} must carry a description`,
      ).toBeTruthy();
    }
    // Field descriptions are the SAME as the pricing schema — one source of truth, no drift.
    const typed = schemas.BlackScholesTypedInput.toJSONSchema().properties ?? {};
    for (const f of ['spot', 'strike', 'timeToExpiryYears', 'riskFreeRate']) {
      expect((props[f] as { description?: string }).description).toBe(
        (typed[f] as { description?: string }).description,
      );
    }
  });

  it('exports JSON Schema suitable for MCP tools', () => {
    const j = OptionContractSchema.toJSONSchema();
    expect(j.type).toBe('object');
    expect(j.additionalProperties).toBe(false);
    expect(j.properties?.['strike']).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    expect(j.properties?.['type']).toMatchObject({ type: 'string', enum: ['call', 'put'] });
    expect(j.required).toContain('underlying');
    expect(j.required).not.toContain('multiplier');
  });

  it('BlackScholesInput schema rejects a negative volatility', () => {
    const r = schemas.BlackScholesInput.safeParse({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: -0.2,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.issues[0]?.path).toEqual(['volatility']);
  });

  it('BlackScholesInput JSON Schema carries field descriptions', () => {
    const j = schemas.BlackScholesInput.toJSONSchema();
    expect(j.properties?.['timeToExpiryYears']).toMatchObject({
      description: 'Time to expiry in years',
    });
  });
});
