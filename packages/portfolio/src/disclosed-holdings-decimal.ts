/** Private exact base-ten arithmetic. BigInts never escape the JSON report. */
export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

export function decimal(value: string): ExactDecimal {
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function decimalText(value: ExactDecimal): string {
  const negative = value.coefficient < 0n;
  const magnitude = negative ? -value.coefficient : value.coefficient;
  if (magnitude === 0n) return '0';
  const digits = magnitude.toString().padStart(value.scale + 1, '0');
  const plain =
    value.scale === 0
      ? digits
      : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '');
  return `${negative ? '-' : ''}${plain}`;
}

export function addDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

export function subtractDecimal(left: string, right: string): string {
  const baseline = decimal(right);
  return decimalText(
    addDecimal(decimal(left), { ...baseline, coefficient: -baseline.coefficient }),
  );
}

export function multiplyDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

export function ratioDecimal(input: {
  numerator: ExactDecimal;
  denominator: ExactDecimal;
  decimalPlaces: number;
}): string {
  const numerator =
    input.numerator.coefficient * 10n ** BigInt(input.denominator.scale + input.decimalPlaces);
  const denominator = input.denominator.coefficient * 10n ** BigInt(input.numerator.scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return decimalText({
    coefficient: quotient + (remainder * 2n >= denominator ? 1n : 0n),
    scale: input.decimalPlaces,
  });
}
