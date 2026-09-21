import { describe, expect, it } from 'vitest';
import { ErrorCode, QuantError } from '@totalfinance/core';
import { luDecompose, luSolve } from '@totalfinance/math';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};

describe('luSolve closes its LuResult argument (Stage 7A slice 3: a hand baseline exposed the open door)', () => {
  const lu = () =>
    luDecompose([
      [4, 3],
      [6, 3],
    ]);

  it('solves the system it was given, and refuses an edited decomposition with the field named', () => {
    const x = luSolve(lu(), [10, 12]);
    expect(x[0]!).toBeCloseTo(1, 12);
    expect(x[1]!).toBeCloseTo(2, 12);
    expect(codeOf(() => luSolve({ ...lu(), extra: 1 } as never, [10, 12]))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => luSolve({ ...lu(), lu: null } as never, [10, 12]))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => luSolve({ ...lu(), lu: [[1, 2], [3]] } as never, [10, 12]))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(
      codeOf(() =>
        luSolve(
          {
            ...lu(),
            lu: [
              [1, Number.NaN],
              [3, 4],
            ],
          } as never,
          [10, 12],
        ),
      ),
    ).toBe(ErrorCode.InputNotFinite);
    expect(codeOf(() => luSolve({ ...lu(), pivotIndices: [0, 5] } as never, [10, 12]))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => luSolve({ ...lu(), pivotIndices: [0] } as never, [10, 12]))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => luSolve({ ...lu(), sign: 2 } as never, [10, 12]))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => luSolve({ ...lu(), sign: null } as never, [10, 12]))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => luSolve(null as never, [10, 12]))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => luSolve(lu(), [10, 12, 14]))).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => luSolve(lu(), [10, Number.POSITIVE_INFINITY]))).toBe(
      ErrorCode.InputNotFinite,
    );
    expect(codeOf(() => luSolve(lu(), 'b' as never))).toBe(ErrorCode.InputWrongType);
  });
});
