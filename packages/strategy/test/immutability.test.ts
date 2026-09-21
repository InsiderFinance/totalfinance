import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { type Position, ironCondor, legs, strategy, strategyFromChain } from '../src/index.js';

/**
 * DX §4.4 — a Position is immutable and `legs` is a frozen snapshot. The supported edit workflow
 * is: keep your own (signed-quantity) leg list as state, tweak it, and rebuild with
 * `strategy(editedLegs, config)`. Mutating a built position must throw, never silently diverge.
 */
describe('Position immutability (dx §4.4)', () => {
  const build = (): Position =>
    strategy([
      legs.put({ strike: 540, premium: 3.4, quantity: 1 }),
      legs.put({ strike: 550, premium: 5.1, quantity: -1 }),
      legs.call({ strike: 590, premium: 4.8, quantity: -1 }),
      legs.call({ strike: 600, premium: 3.1, quantity: 1 }),
    ]);

  it('pos.legs is frozen: push throws instead of corrupting state', () => {
    const pos = build();
    expect(Object.isFrozen(pos.legs)).toBe(true);
    expect(() => (pos.legs as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(pos.legs).toHaveLength(4);
  });

  it('individual legs are frozen: editing a strike in place throws', () => {
    const pos = build();
    expect(Object.isFrozen(pos.legs[0])).toBe(true);
    expect(() => {
      (pos.legs[0] as { strike: number }).strike = 1;
    }).toThrow(TypeError);
    expect(pos.legs[0]!.strike).toBe(540);
  });

  it('mutating the caller-owned input legs after construction does not retarget the position', () => {
    const mine = [
      legs.put({ strike: 540, premium: 3.4, quantity: 1 }),
      legs.put({ strike: 550, premium: 5.1, quantity: -1 }),
    ];
    const pos = strategy(mine);
    (mine[0] as { strike: number }).strike = 999;
    expect(pos.legs[0]!.strike).toBe(540);
  });

  it('rebuild-after-tweak: pos.legs feeds straight back into strategy() for ANY leg combo', () => {
    const pos = build();
    // Tweak: drop a wing and double the short put — no longer an iron condor, still computes.
    const edited = pos.legs
      .filter((l) => l.strike !== 600)
      .map((l) => (l.strike === 550 ? { ...l, quantity: l.quantity * 2 } : { ...l }));
    const rebuilt = strategy(edited);
    expect(rebuilt.legs).toHaveLength(3);
    expect(rebuilt.metrics().breakevens.length).toBeGreaterThan(0);
    // The readonly legs array is directly acceptable as builder input (no copying ceremony).
    const clone = strategy(pos.legs);
    expect(clone.metrics()).toEqual(build().metrics());
  });

  it('the INSTANCE is frozen: assigning multiplier throws instead of silently changing metrics', () => {
    const pos = build();
    expect(Object.isFrozen(pos)).toBe(true);
    const before = pos.metrics();
    // Vitest runs ESM (strict mode), so assignment to a frozen object's property throws.
    expect(() => {
      (pos as { multiplier: number }).multiplier = 1;
    }).toThrow(TypeError);
    expect(() => {
      (pos as { premiumSource: string }).premiumSource = 'model';
    }).toThrow(TypeError);
    expect(pos.multiplier).toBe(100);
    expect(pos.metrics()).toEqual(before);
  });

  it('constructedAs cannot be forged onto a frozen position after the fact', () => {
    const pos = build();
    expect(() => {
      Object.defineProperty(pos, 'constructedAs', { value: 'ironCondor', enumerable: true });
    }).toThrow(TypeError);
    expect(pos.constructedAs).toBeUndefined();
  });

  it('freezing does not break provenance: named builders and from-chain still stamp constructedAs', () => {
    const named = ironCondor({
      putLong: { strike: 540, premium: 3.4 },
      putShort: { strike: 550, premium: 5.1 },
      callShort: { strike: 590, premium: 4.8 },
      callLong: { strike: 600, premium: 3.1 },
    });
    expect(Object.isFrozen(named)).toBe(true);
    expect(named.constructedAs).toBe('ironCondor');

    const expiry = '2026-04-17';
    const quote = (type: 'call' | 'put', strike: number, delta: number) => ({
      contract: {
        underlying: 'XYZ',
        type,
        style: 'american' as const,
        strike,
        expiry,
        ...resolvedExpiry(expiry),
      },
      timestampMs: 0,
      bid: 2.9,
      ask: 3.1,
      mid: 3,
      underlyingPrice: 100,
      greeks: { delta },
    });
    const fromChain = strategyFromChain([quote('call', 105, 0.4), quote('put', 95, -0.4)], {
      type: 'strangle',
      expiry,
      shortDelta: 0.4,
    });
    expect(Object.isFrozen(fromChain.position)).toBe(true);
    expect(fromChain.position.constructedAs).toBe('strangle');
  });
});
