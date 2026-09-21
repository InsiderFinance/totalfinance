/**
 * Law 12 + the generated-spec contract for the exotics cluster (spec 3B.1b).
 *
 * One boundary per input family, each swept through the five mutation classes with the EXACT code
 * that mistake owns. Exhaustive per-boundary proof is the enforcement artifact's job (all 41
 * boundaries are measured and gated there); this suite is the human-readable regression evidence
 * that the generated specs actually bind — a misspelled key teaches, a null is never omission, an
 * undeclared enum member never prices the other leg, and the curated ±Infinity bounds stay open
 * while NaN stays shut.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  asian,
  autocallable,
  barrier,
  basket,
  cliquet,
  compo,
  digital,
  doubleTouch,
  forwardStart,
  inverseOption,
  lookback,
  quanto,
  spread,
  touch,
  varianceSwap,
} from '@totalfinance/options/exotics';

type Case = readonly [
  name: string,
  valid: Record<string, unknown>,
  call: (input: Record<string, unknown>) => unknown,
  requiredNumeric: string,
];

const MC = { seed: 7, paths: 100 } as const;

/** One representative boundary per exotic input family. */
const FAMILIES: readonly Case[] = [
  [
    'barrier.price',
    {
      type: 'call',
      barrierType: 'up-out',
      spot: 100,
      strike: 105,
      barrier: 120,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => barrier.price(input as never),
    'volatility',
  ],
  [
    'asian.geometricPrice',
    {
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => asian.geometricPrice(input as never),
    'volatility',
  ],
  [
    'lookback.price',
    {
      type: 'call',
      strikeType: 'floating',
      spot: 100,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => lookback.price(input as never),
    'volatility',
  ],
  [
    'spread.price',
    {
      type: 'call',
      spot1: 100,
      spot2: 95,
      strike: 5,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility1: 0.2,
      volatility2: 0.25,
      correlation: 0.5,
    },
    (input) => spread.price(input as never),
    'volatility1',
  ],
  [
    'quanto.price',
    {
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      domesticRate: 0.04,
      foreignRate: 0.01,
      volatility: 0.2,
      fxVolatility: 0.1,
      correlation: 0.3,
    },
    (input) => quanto.price(input as never),
    'volatility',
  ],
  [
    'basket.approximatePrice',
    {
      type: 'call',
      spots: [100, 95],
      weights: [0.5, 0.5],
      strike: 95,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatilities: [0.2, 0.25],
      correlation: [
        [1, 0.5],
        [0.5, 1],
      ],
    },
    (input) => basket.approximatePrice(input as never),
    'strike',
  ],
  [
    'digital.price',
    {
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => digital.price(input as never),
    'volatility',
  ],
  [
    'touch.price',
    {
      kind: 'one-touch',
      payAt: 'expiry',
      spot: 100,
      barrier: 110,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => touch.price(input as never),
    'volatility',
  ],
  [
    'doubleTouch.price',
    {
      kind: 'double-no-touch',
      spot: 100,
      lower: 90,
      upper: 115,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => doubleTouch.price(input as never),
    'volatility',
  ],
  [
    'forwardStart.price',
    {
      type: 'call',
      spot: 100,
      resetTime: 0.25,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      volatility: 0.2,
    },
    (input) => forwardStart.price(input as never),
    'volatility',
  ],
  [
    'cliquet.price',
    {
      spot: 100,
      resetTimes: [0.25, 0.5, 0.75, 1],
      riskFreeRate: 0.04,
      volatility: 0.2,
      localFloor: 0,
      localCap: 0.08,
    },
    (input) => cliquet.price(input as never),
    'volatility',
  ],
  [
    'compo.price',
    {
      type: 'call',
      spot: 50,
      fxSpot: 1.1,
      strike: 60,
      timeToExpiryYears: 0.25,
      domesticRate: 0.04,
      volatility: 0.2,
      fxVolatility: 0.1,
      correlation: 0.3,
    },
    (input) => compo.price(input as never),
    'volatility',
  ],
  [
    'inverseOption.price',
    {
      type: 'call',
      spot: 60000,
      strike: 65000,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.6,
    },
    (input) => inverseOption.price(input as never),
    'volatility',
  ],
  [
    'varianceSwap.value',
    {
      realizedVariance: 0.03,
      strikeVariance: 0.04,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
    },
    (input) => varianceSwap.value(input as never),
    'strikeVariance',
  ],
  [
    'autocallable.monteCarloPrice',
    {
      spot: 100,
      riskFreeRate: 0.03,
      volatility: 0.2,
      observationTimes: [0.5, 1],
      autocallBarrier: 105,
      couponRate: 0.02,
      knockInBarrier: 70,
    },
    (input) => autocallable.monteCarloPrice(input as never, MC),
    'volatility',
  ],
] as const;

function outcome(run: () => unknown): string {
  try {
    run();
    return 'NO THROW';
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

/** Offender-list sweep (3B.1a convention): one assertion, every violating family named. */
function sweep(
  mutate: (valid: Record<string, unknown>) => Record<string, unknown>,
  expected: string,
): string[] {
  const violations: string[] = [];
  for (const [name, valid, call, requiredNumeric] of FAMILIES) {
    const got = outcome(() => call(mutate({ ...valid, __required: requiredNumeric })));
    if (got !== expected) violations.push(`${name}: ${got}`);
  }
  return violations;
}

describe('exotics closed requests (generated specs, Law 12)', () => {
  it('every family control call succeeds', () => {
    const failures: string[] = [];
    for (const [name, valid, call] of FAMILIES) {
      const got = outcome(() => call({ ...valid }));
      if (got !== 'NO THROW') failures.push(`${name}: ${got}`);
    }
    expect(failures).toEqual([]);
  });

  it('an unknown key rejects with input.unknown_field everywhere', () => {
    expect(
      sweep((valid) => {
        const { __required, ...rest } = valid;
        return { ...rest, qzxBogusKey: 1 };
      }, ErrorCode.InputUnknownField),
    ).toEqual([]);
  });

  it('null on a required numeric field rejects with input.wrong_type everywhere', () => {
    expect(
      sweep((valid) => {
        const { __required, ...rest } = valid;
        return { ...rest, [__required as string]: null };
      }, ErrorCode.InputWrongType),
    ).toEqual([]);
  });

  it('a missing required numeric field teaches input.missing_field everywhere', () => {
    expect(
      sweep((valid) => {
        const { __required, ...rest } = valid;
        delete rest[__required as string];
        return rest;
      }, ErrorCode.InputMissingField),
    ).toEqual([]);
  });

  it('NaN in a required numeric field rejects with input.nan everywhere', () => {
    expect(
      sweep((valid) => {
        const { __required, ...rest } = valid;
        return { ...rest, [__required as string]: Number.NaN };
      }, ErrorCode.InputNaN),
    ).toEqual([]);
  });

  it('an undeclared enum member teaches against the declared domain', () => {
    expect(
      outcome(() => barrier.price({ ...FAMILIES[0]![1], barrierType: 'up-and-out' } as never)),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(outcome(() => digital.price({ ...FAMILIES[6]![1], kind: 'binary' } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
  });

  it('the curated IEEE bounds stay open while NaN stays shut', () => {
    const base = FAMILIES.find(([name]) => name === 'cliquet.price')![1];
    expect(outcome(() => cliquet.price({ ...base, localCap: Infinity } as never))).toBe('NO THROW');
    expect(outcome(() => cliquet.price({ ...base, globalFloor: -Infinity } as never))).toBe(
      'NO THROW',
    );
    expect(outcome(() => cliquet.price({ ...base, localCap: Number.NaN } as never))).toBe(
      ErrorCode.InputNaN,
    );
    // localFloor is NOT a curated bound: the resolver requires it finite and ≥ −1.
    expect(outcome(() => cliquet.price({ ...base, localFloor: -Infinity } as never))).toBe(
      ErrorCode.InputNotFinite,
    );
  });

  it('the teaching error carries the worked example on a missing field', () => {
    try {
      const { volatility: _omitted, ...rest } = FAMILIES[0]![1];
      barrier.price(rest as never);
      expect.unreachable('accepted a missing volatility');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputMissingField)) throw error;
      expect(error.message).toContain("barrier.price({ type: 'call'");
    }
  });
});
