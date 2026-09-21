import { describe, expect, it } from 'vitest';
import { isQuantError, resolvedExpiry } from '@totalfinance/core';
import type { OptionQuote } from '@totalfinance/core';
import { strategyFromChain } from '@totalfinance/strategy';

const expiry = '2026-04-17';
const farExpiry = '2026-06-19';

function mk(
  type: 'call' | 'put',
  strike: number,
  mid: number,
  impliedVolatility: number,
  delta?: number,
): OptionQuote {
  return {
    contract: {
      underlying: 'XYZ',
      type,
      style: 'american',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: 0,
    bid: mid - 0.1,
    ask: mid + 0.1,
    mid,
    last: mid + 0.5,
    mark: mid + 0.2,
    impliedVolatility,
    underlyingPrice: 100,
    ...(delta !== undefined ? { greeks: { delta } } : {}),
  };
}

// Spot 100. Call/put deltas and mids across a 9-strike grid.
const CALLS: Array<[number, number, number, number]> = [
  // strike, mid, iv, delta
  [80, 21, 0.3, 0.9],
  [85, 16.5, 0.29, 0.82],
  [90, 12.5, 0.28, 0.7],
  [95, 9.0, 0.27, 0.58],
  [100, 6.0, 0.26, 0.5],
  [105, 3.8, 0.25, 0.38],
  [110, 2.2, 0.24, 0.28],
  [115, 1.2, 0.23, 0.18],
  [120, 0.6, 0.22, 0.1],
];
const PUTS: Array<[number, number, number, number]> = [
  [80, 0.5, 0.32, -0.1],
  [85, 1.0, 0.31, -0.18],
  [90, 1.8, 0.3, -0.3],
  [95, 3.0, 0.29, -0.42],
  [100, 5.0, 0.28, -0.5],
  [105, 7.5, 0.27, -0.62],
  [110, 10.8, 0.26, -0.72],
  [115, 14.5, 0.25, -0.82],
  [120, 18.8, 0.24, -0.9],
];
const chain: OptionQuote[] = [
  ...CALLS.map(([k, m, impliedVolatility, d]) => mk('call', k, m, impliedVolatility, d)),
  ...PUTS.map(([k, m, impliedVolatility, d]) => mk('put', k, m, impliedVolatility, d)),
];

describe('WS7.2 strategyFromChain — iron condor', () => {
  it('picks short strikes by |delta| and wings by width, in leg order', () => {
    const res = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
      price: 'mid',
    });
    // shortPut |δ|≈0.30 → 90; shortCall |δ| nearest 0.30 → 110 (0.28); wings 5 wide → longPut 85, longCall 115.
    expect(res.legs.map((l) => l.strike)).toEqual([85, 90, 110, 115]);
    expect(res.legs.map((l) => Math.sign(l.quantity))).toEqual([1, -1, -1, 1]);
    expect(res.fills.map((f) => f.role)).toEqual(['longPut', 'shortPut', 'shortCall', 'longCall']);
    // Premiums come from the chosen source (mid); per-leg IVs are attached.
    expect(res.fills[1]!.premium).toBeCloseTo(1.8, 9); // short put 90 mid
    expect(res.legs[1]!.impliedVolatility).toBeCloseTo(0.3, 12); // short put 90 IV
    expect(res.fills[1]!.delta).toBeCloseTo(-0.3, 12);
  });

  it('respects the premium source', () => {
    const bid = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
      price: 'bid',
    });
    expect(bid.fills[1]!.premium).toBeCloseTo(1.7, 9); // short put 90 bid = mid − 0.1
  });

  it('the materialized position marks with per-leg IVs (volatilitySource = perLeg)', () => {
    const { position } = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
    });
    const markToMarket = position.value({
      spot: 100,
      asOf: Date.UTC(2026, 0, 1, 21),
      expiry,
      volatility: 0.2,
      riskFreeRate: 0.03,
    });
    expect(Number.isFinite(markToMarket.pnl)).toBe(true);
    expect(markToMarket.assumptions.volatilitySource).toBe('perLeg');
  });

  // Regression for an external-review finding: `strategyFromChain` needed numeric-input validation.
  // requireSpot used `spot > 0`, which admits Infinity (Infinity > 0 is true) for ATM/stock legs.
  it('rejects an infinite spot for an ATM strategy', () => {
    let caught: unknown;
    try {
      strategyFromChain(chain, { type: 'straddle', expiry, spot: Infinity });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });
});

describe('WS7.2 strategyFromChain — other structures', () => {
  it('bullCallSpread: short by delta, long `width` below', () => {
    const res = strategyFromChain(chain, {
      type: 'bullCallSpread',
      expiry,
      shortDelta: 0.3,
      width: 10,
    });
    // short call |δ|≈0.30 → 110; long 10 below → 100.
    expect(
      res.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])).sort((a, b) => a - b),
    ).toEqual([100, 110]);
    const longLeg = res.legs.find((l) => l.quantity > 0)!;
    const shortLeg = res.legs.find((l) => l.quantity < 0)!;
    expect(longLeg.strike).toBe(100);
    expect(shortLeg.strike).toBe(110);
  });

  it('straddle at an explicit strike; strangle by delta', () => {
    const straddle = strategyFromChain(chain, { type: 'straddle', expiry, strike: 100 });
    expect(straddle.legs.map((l) => l.kind)).toEqual(['call', 'put']);
    expect(straddle.legs.every((l) => l.strike === 100 && l.quantity > 0)).toBe(true);

    const strangle = strategyFromChain(chain, { type: 'strangle', expiry, shortDelta: 0.18 });
    // call |δ|=0.18 → 115; put |δ|=0.18 → 85.
    expect(
      strangle.legs.flatMap((l) => (l.kind === 'stock' ? [] : [l.strike])).sort((a, b) => a - b),
    ).toEqual([85, 115]);
  });

  it('coveredCall: long stock + short call; calendar spans two expiries', () => {
    const cc = strategyFromChain(chain, { type: 'coveredCall', expiry, shortDelta: 0.3 });
    expect(cc.legs.find((l) => l.kind === 'stock')!.quantity).toBe(100);
    expect(cc.legs.find((l) => l.kind === 'call')!.quantity).toBe(-1);

    const calChain: OptionQuote[] = [
      ...chain,
      {
        ...mk('call', 100, 8.0, 0.27, 0.52),
        contract: {
          underlying: 'XYZ',
          type: 'call',
          style: 'american',
          strike: 100,
          expiry: farExpiry,
          ...resolvedExpiry(farExpiry),
        },
      },
    ];
    const cal = strategyFromChain(calChain, {
      type: 'calendar',
      expiry,
      farExpiry,
      strike: 100,
      right: 'call',
    });
    const near = cal.legs.find((l) => l.expiry === expiry)!;
    const far = cal.legs.find((l) => l.expiry === farExpiry)!;
    expect(near.quantity).toBe(-1); // short near
    expect(far.quantity).toBe(1); // long far
  });
});

describe('WS7.2 strategyFromChain — honest failures', () => {
  it('throws strategy.strike_unavailable for a strike with no quote', () => {
    let code: string | undefined;
    try {
      strategyFromChain(chain, { type: 'straddle', expiry, strike: 97 });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('strategy.strike_unavailable');
  });

  it('throws strategy.delta_required (naming options chainGreeks) when deltas are needed but absent', () => {
    const noDeltas: OptionQuote[] = [
      ...CALLS.map(([k, m, impliedVolatility]) => mk('call', k, m, impliedVolatility)),
      ...PUTS.map(([k, m, impliedVolatility]) => mk('put', k, m, impliedVolatility)),
    ];
    let err: { code?: string; message?: string } = {};
    try {
      strategyFromChain(noDeltas, { type: 'ironCondor', expiry, shortDelta: 0.3, wingWidth: 5 });
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err.code).toBe('strategy.delta_required');
    expect(err.message).toMatch(/chainGreeks\(\{ quotes, market \}\)/);
  });

  it('an unknown type throws input.invalid_enum listing every valid FromChainType (never a 0-leg position)', () => {
    let err: { code?: string; message?: string; context?: { known?: string[] } } = {};
    try {
      strategyFromChain(chain, { type: 'condorOfIron', expiry } as never);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe('input.invalid_enum');
    expect(err.message).toContain('condorOfIron');
    for (const t of ['ironCondor', 'bullCallSpread', 'straddle', 'calendar']) {
      expect(err.message).toContain(t);
    }
    expect(err.context?.known).toHaveLength(10);
  });

  it('the options teach-string documents the REAL FromChainOptions shape', () => {
    let msg = '';
    try {
      strategyFromChain(chain, 42 as never);
    } catch (e) {
      msg = (e as Error).message;
    }
    // Real per-type fields, not the fictional `strikes | deltas` keys the old string taught.
    expect(msg).toContain('shortDelta');
    expect(msg).toContain('wingWidth');
    expect(msg).toContain('farExpiry');
    expect(msg).not.toMatch(/strikes \| deltas/);
  });
});

describe('WS7.2 strategyFromChain — the position remembers its chain context', () => {
  it('non-calendar builds carry the selection expiry: probability() works without re-telling it', () => {
    const { position, legs: builtLegs } = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
    });
    // The legs were filtered by options.expiry — the position must remember it (R4)…
    for (const leg of position.legs) expect(leg.expiry).toBe(expiry);
    // …so probability() no longer throws "missing market field(s): expiry".
    const p = position.probability({
      spot: 100,
      volatility: 0.25,
      riskFreeRate: 0.03,
      asOf: Date.UTC(2026, 0, 2, 21),
    });
    expect(p.probabilityOfProfit).toBeGreaterThan(0);
    expect(p.probabilityOfProfit).toBeLessThan(1);
    // The returned leg list mirrors what the position holds.
    expect(builtLegs).toHaveLength(4);
  });

  it('stamps constructedAs from the requested type, like the named builders do', () => {
    const condor = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
    });
    expect(condor.position.constructedAs).toBe('ironCondor');
    expect(condor.position.assumptions().constructedAs).toBe('ironCondor');

    const calChain: OptionQuote[] = [
      ...chain,
      {
        ...mk('call', 100, 8.0, 0.27, 0.52),
        contract: {
          underlying: 'XYZ',
          type: 'call',
          style: 'american',
          strike: 100,
          expiry: farExpiry,
          ...resolvedExpiry(farExpiry),
        },
      },
    ];
    const cal = strategyFromChain(calChain, {
      type: 'calendar',
      expiry,
      farExpiry,
      strike: 100,
      right: 'call',
    });
    expect(cal.position.constructedAs).toBe('calendar');
    // The calendar branch keeps its per-leg expiries (near ≠ far).
    expect(new Set(cal.position.legs.map((l) => l.expiry)).size).toBe(2);
  });
});

describe('strategyFromChain echoes its price source (C hygiene)', () => {
  it('assumptions name the source every premium was read from, the expiry, the multiplier and the quantity', () => {
    const chain = [
      ...CALLS.map(([k, m, impliedVolatility, delta]) =>
        mk('call', k, m, impliedVolatility, delta),
      ),
      ...PUTS.map(([k, m, impliedVolatility, delta]) => mk('put', k, m, impliedVolatility, delta)),
    ];
    const byDefault = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
    });
    expect(byDefault.assumptions).toEqual({
      conventionsVersion: expect.any(String),
      priceSource: 'mid',
      expiry,
      multiplier: 100,
      quantity: 1,
    });
    const atBid = strategyFromChain(chain, {
      type: 'ironCondor',
      expiry,
      shortDelta: 0.3,
      wingWidth: 5,
      price: 'bid',
      quantity: 3,
      multiplier: 10,
    });
    expect(atBid.assumptions).toMatchObject({ priceSource: 'bid', quantity: 3, multiplier: 10 });
  });
});
