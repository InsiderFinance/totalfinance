import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import { convertPriceLevel, type ReferencePriceLevelInput } from '../src/price-levels.js';

function input(source: number, target: number, reference: number): ReferencePriceLevelInput {
  return {
    method: 'reference-prices',
    sourcePriceLevel: source,
    referenceTargetPrice: target,
    referenceSourcePrice: reference,
    sourcePriceUnit: 'source points',
    targetPriceUnit: 'target points',
  };
}

describe.each([
  ['plain', convertPriceLevel],
  ['explain', (request: ReferencePriceLevelInput) => convertPriceLevel.explain(request).value],
] as const)('%s correctly rounded range boundaries', (_name, convert) => {
  it('does not mistake a result just above half MIN_VALUE for zero', () => {
    expect(convert(input(3 * Number.MIN_VALUE, 0.9999999999999999, 5.999999999999999))).toBe(
      Number.MIN_VALUE,
    );
  });

  it('does not mistake a result that rounds to MAX_VALUE for infinity', () => {
    expect(
      convert(input(Number.MAX_VALUE - 2 ** 971, 1.4999999999999998, 1.4999999999999996)),
    ).toBe(Number.MAX_VALUE);
  });

  it.each([
    [0.75, 1],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [4.5, 4],
  ])('rounds %s MIN_VALUE to %s MIN_VALUE, including ties to even', (scale, expected) => {
    expect(convert(input(Number.MIN_VALUE, scale, 1))).toBe(expected * Number.MIN_VALUE);
  });

  it('rounds the normal/subnormal midpoint to the even minimum normal value', () => {
    expect(convert(input(Number.MIN_VALUE, 2 ** 53 - 1, 2))).toBe(2 ** -1022);
  });

  it('still refuses exact zero and infinity rounding thresholds with typed errors', () => {
    for (const request of [
      input(3 * Number.MIN_VALUE, 1, 6), // Exactly half MIN_VALUE: ties to zero.
      // (1 + 2^-27)(1 - 2^-27) * 2^1024 = 2^1024 - 2^970: ties to infinity.
      input(2 ** 1023 * (1 + 2 ** -27), 2 * (1 - 2 ** -27), 1),
    ]) {
      expect(() => convert(request)).toThrow(InputError);
      expect(() => convert(request)).toThrow(
        expect.objectContaining({
          code: ErrorCode.InputOutOfRange,
          context: expect.objectContaining({ function: 'convertPriceLevel' }),
        }),
      );
    }
  });
});

// Independent oracle: compare exact input fractions with fixed range thresholds and the
// midpoints adjacent to the returned double. It neither normalizes nor rounds the quotient.
const view = new DataView(new ArrayBuffer(8));
function bits(value: number): bigint {
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}
function neighbor(value: number, steps: number): number {
  view.setBigUint64(0, bits(value) + BigInt(steps));
  return view.getFloat64(0);
}
function fraction(value: number): [bigint, number] {
  const encoded = bits(value);
  const exponent = Number(encoded >> 52n);
  const mantissa = encoded & ((1n << 52n) - 1n);
  return exponent === 0 ? [mantissa, -1074] : [(1n << 52n) + mantissa, exponent - 1075];
}
function compare(left: bigint, right: bigint, power: number): number {
  if (power >= 0) left <<= BigInt(power);
  else right <<= BigInt(-power);
  return left > right ? 1 : left < right ? -1 : 0;
}

it('matches exact rounding intervals for 40,460 neighboring nontrivial-significand triples', () => {
  let checked = 0;
  function check(source: number, target: number, reference: number): void {
    const [sourceInteger, sourceExponent] = fraction(source);
    const [targetInteger, targetExponent] = fraction(target);
    const [referenceInteger, referenceExponent] = fraction(reference);
    const numerator = sourceInteger * targetInteger;
    const exponent = sourceExponent + targetExponent - referenceExponent;
    // Infinity starts at 2^1024 - 2^970; zero includes the 2^-1075 tie.
    const overflow = compare(numerator, referenceInteger * ((1n << 54n) - 1n), exponent - 970) >= 0;
    const underflow = compare(numerator, referenceInteger, exponent + 1075) <= 0;
    const request = input(source, target, reference);
    if (overflow || underflow) {
      expect(() => convertPriceLevel(request)).toThrow(
        expect.objectContaining({ code: ErrorCode.InputOutOfRange }),
      );
    } else {
      const result = convertPriceLevel(request);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      const [resultInteger, resultExponent] = fraction(result);
      const even = (bits(result) & 1n) === 0n;
      for (const direction of [-1, 1]) {
        // MAX_VALUE's upper midpoint is already pinned by the overflow threshold above.
        if (result === Number.MAX_VALUE && direction === 1) continue;
        const [adjacentInteger, adjacentExponent] = fraction(neighbor(result, direction));
        const commonExponent = Math.min(resultExponent, adjacentExponent);
        const midpointInteger =
          (resultInteger << BigInt(resultExponent - commonExponent)) +
          (adjacentInteger << BigInt(adjacentExponent - commonExponent));
        const midpointComparison = compare(
          numerator,
          referenceInteger * midpointInteger,
          exponent - (commonExponent - 1),
        );
        // The exact result must be inside this double's rounding interval. A tie belongs here
        // only if its last significand bit is even, independently of the production algorithm.
        expect(midpointComparison * direction).toBeLessThanOrEqual(even ? 0 : -1);
      }
    }
    checked += 1;
  }

  for (let offset = 0; offset < 10; offset++) {
    for (const base of [1, 1.25, 1.5, 1.75, 2, 100, 1e200]) {
      for (let targetStep = -8; targetStep <= 8; targetStep++) {
        for (let referenceStep = -8; referenceStep <= 8; referenceStep++) {
          check(
            neighbor(Number.MAX_VALUE, -offset),
            neighbor(base, targetStep),
            neighbor(base, referenceStep),
          );
          check(
            (offset + 1) * Number.MIN_VALUE,
            neighbor(base, targetStep),
            neighbor(base * 2 * (offset + 1), referenceStep),
          );
        }
      }
    }
  }
  expect(checked).toBe(40_460);
});
