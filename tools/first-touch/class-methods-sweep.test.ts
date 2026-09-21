/**
 * DX §7.1 — the garbage sweep, extended to CLASS-INSTANCE methods.
 *
 * The auto-enumerated `garbage-sweep.test.ts` covers module + namespace EXPORTS, but a `Position`'s
 * chart/scenario methods are reachable only on an instance (`strategy.ironCondor(...).payoff()`), so
 * they dodged the sweep — which is exactly how `payoff({})` / `chartData({})` / `scenarioTable({})` /
 * `whatIfCube({})` shipped throwing raw `TypeError`s. This suite probes every PUBLIC `Position` method
 * with the same garbage set, over representative positions, and holds them to the QuantError-or-return
 * law. A completeness guard pins the public/private split to the prototype, so a newly added method
 * must be consciously classified rather than silently escape the sweep.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { Position, strategy } from '@totalfinance/strategy';

/** The probe set (identical to the export sweep): the natural wrong first calls. */
const PROBES: Array<{ label: string; args: unknown[] }> = [
  { label: 'no args', args: [] },
  { label: 'undefined', args: [undefined] },
  { label: 'empty object', args: [{}] },
  { label: 'empty array', args: [[]] },
  { label: 'string', args: ['hello'] },
  { label: 'number', args: [42] },
  { label: 'short numeric array', args: [[1, 2, 3]] },
  { label: 'columnar object', args: [{ high: [], low: [], close: [] }] },
];

/** Public methods swept for the QuantError-or-return law. */
const PUBLIC_METHODS = [
  'assumptions',
  'chartData',
  'metrics',
  'netDebit',
  'payoff',
  'probability',
  'monteCarloProbability',
  'scenarioTable',
  'value',
  'whatIfCube',
] as const;

/** Internal helpers that assume already-validated inputs; deliberately NOT part of the public sweep. */
const PRIVATE_METHODS = [
  'assertSingleExpiry',
  'defaultPriceRange',
  'markToMarketAssumptions',
  'pnlAtExpiry',
  'probabilityAssumptions',
  'resolveMarket',
  'slopeAt',
  'whatIfProbability',
] as const;

const market = {
  spot: 100,
  volatility: 0.25,
  riskFreeRate: 0.03,
  asOf: '2026-07-06T00:00:00Z',
  expiry: '2026-08-21',
} as const;

function condor(config?: Parameters<typeof strategy.ironCondor>[1]): Position {
  return strategy.ironCondor(
    {
      putLong: { strike: 90, premium: 0.7 },
      putShort: { strike: 95, premium: 1.5 },
      callShort: { strike: 105, premium: 1.6 },
      callLong: { strike: 110, premium: 0.8 },
    },
    config,
  );
}

/** Representative positions: with/without a construction market, and a multi-expiry calendar. */
const POSITIONS: Array<{ label: string; position: Position }> = [
  { label: 'iron condor (with market)', position: condor({ market }) },
  { label: 'iron condor (no market)', position: condor() },
  {
    label: 'call calendar (multi-expiry, no market)',
    position: strategy.calendarCallSpread({
      strike: 100,
      nearExpiry: '2026-02-20',
      shortPremium: 2,
      farExpiry: '2026-05-15',
      longPremium: 3.5,
    }),
  },
];

describe('DX7.1 garbage sweep: Position instance methods', () => {
  it('the public/private split is exhaustive over the prototype (a new method must be classified)', () => {
    const proto = Position.prototype as unknown as Record<string, unknown>;
    const onProto = Object.getOwnPropertyNames(Position.prototype)
      .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
      .sort();
    expect(onProto).toEqual([...PUBLIC_METHODS, ...PRIVATE_METHODS].sort());
  });

  for (const { label, position } of POSITIONS) {
    describe(label, () => {
      for (const method of PUBLIC_METHODS) {
        it(`${method}() is QuantError-or-return on every garbage probe`, async () => {
          const raw = (position as unknown as Record<string, unknown>)[method];
          if (typeof raw !== 'function') throw new Error(`Position.${method} is not callable`);
          const fn = raw as (...a: unknown[]) => unknown;
          for (const probe of PROBES) {
            try {
              const result = Reflect.apply(fn, position, probe.args);
              if (
                result !== null &&
                typeof result === 'object' &&
                typeof (result as { then?: unknown }).then === 'function'
              ) {
                await result;
              }
            } catch (error) {
              expect(
                isQuantError(error),
                `Position.${method}(${probe.label}) escaped a non-QuantError ${String(
                  (error as Error).name,
                )}: ${String((error as Error).message)} — throw a typed error from the boundary.`,
              ).toBe(true);
            }
          }
        });
      }
    });
  }
});
