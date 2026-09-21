import { legs, strategy, type LegInput } from '@totalfinance/strategy';

/** Compile-only: no removed helper or inferred quantity may return to the public surface. */
export function signedLegContracts(): void {
  const input: LegInput[] = [
    legs.call({ strike: 100, quantity: 2, premium: 6 }),
    legs.put({ strike: 90, quantity: -1, expiry: '2026-12-18', impliedVolatility: 0.2 }),
    legs.stock({ price: 100, quantity: -12.5 }),
    { kind: 'call', strike: 110, quantity: -1, premium: 2 },
  ];
  strategy(input, {
    premiums: 'model',
    market: {
      spot: 100,
      volatility: 0.2,
      riskFreeRate: 0.04,
      asOf: '2026-09-01T00:00:00Z',
      expiry: '2026-12-18',
    },
  });
  // @ts-expect-error direction and size cannot be inferred
  legs.call({ strike: 100, premium: 5 });
  // @ts-expect-error direction and size cannot be inferred
  legs.put({ strike: 100 });
  // @ts-expect-error stock shares cannot be inferred
  legs.stock({ price: 100 });
  // @ts-expect-error undefined is not a signed quantity
  legs.call({ strike: 100, quantity: undefined });
  // @ts-expect-error no competing side flag
  legs.call({ strike: 100, quantity: -1, side: 'short' });
  // @ts-expect-error retired pre-release alias
  legs.longCall({ strike: 100 });
  // @ts-expect-error retired pre-release alias
  legs.shortCall({ strike: 100 });
  // @ts-expect-error retired pre-release alias
  legs.longPut({ strike: 100 });
  // @ts-expect-error retired pre-release alias
  legs.shortPut({ strike: 100 });
  // @ts-expect-error retired pre-release alias
  legs.longStock({ price: 100 });
  // @ts-expect-error retired pre-release alias
  legs.shortStock({ price: 100 });
}
