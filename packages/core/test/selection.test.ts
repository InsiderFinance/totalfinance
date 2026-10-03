import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError, requireSelection } from '@totalfinance/core';

const ALLOWED = ['price', 'delta', 'gamma'] as const;

function refusal(run: () => unknown): InputError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InputError);
    return error as InputError;
  }
  throw new Error('expected an InputError');
}

describe('requireSelection', () => {
  it('returns a dense copy in request order', () => {
    const value = ['gamma', 'price'];
    const selected = requireSelection('evaluate', 'outputs', value, ALLOWED);
    expect(selected).toEqual(['gamma', 'price']);
    expect(selected).not.toBe(value);
  });

  it('refuses a value that is not an array', () => {
    const error = refusal(() => requireSelection('evaluate', 'outputs', 'gamma', ALLOWED));
    expect(error.code).toBe(ErrorCode.InputWrongType);
    expect(error.message).toBe(
      'evaluate: outputs must be an array of names (one or more of price, delta, gamma); got string.',
    );
    expect(refusal(() => requireSelection('evaluate', 'outputs', null, ALLOWED)).message).toMatch(
      /got null\.$/,
    );
  });

  it('refuses an empty selection, which would compute nothing', () => {
    const error = refusal(() => requireSelection('evaluate', 'outputs', [], ALLOWED));
    expect(error.code).toBe(ErrorCode.InputOutOfRange);
    expect(error.context).toEqual({ function: 'evaluate', field: 'outputs' });
  });

  it('refuses a sparse hole instead of skipping it', () => {
    const holed: string[] = ['gamma'];
    holed[2] = 'price';
    const error = refusal(() => requireSelection('evaluate', 'outputs', holed, ALLOWED));
    expect(error.code).toBe(ErrorCode.InputMissingField);
    expect(error.context).toEqual({ function: 'evaluate', field: 'outputs', index: 1 });
  });

  it('refuses an unknown name with a suggestion, and a non-string entry', () => {
    const unknown = refusal(() => requireSelection('evaluate', 'outputs', ['gama'], ALLOWED));
    expect(unknown.code).toBe(ErrorCode.InputInvalidEnum);
    expect(unknown.message).toBe(
      'evaluate: outputs[0] must be one of price, delta, gamma; got "gama" — did you mean "gamma"?',
    );
    expect(unknown.context).toMatchObject({ index: 0, value: 'gama', suggestion: 'gamma' });
    const numeric = refusal(() => requireSelection('evaluate', 'outputs', ['price', 7], ALLOWED));
    expect(numeric.code).toBe(ErrorCode.InputInvalidEnum);
    expect(numeric.message).toBe('evaluate: outputs[1] must be one of price, delta, gamma; got 7.');
    expect(numeric.context).toMatchObject({ field: 'outputs', index: 1 });
  });

  it('refuses a repeated name instead of collapsing it', () => {
    const error = refusal(() =>
      requireSelection('evaluate', 'outputs', ['gamma', 'delta', 'gamma'], ALLOWED),
    );
    expect(error.code).toBe(ErrorCode.InputDuplicateEntry);
    expect(error.context).toEqual({
      function: 'evaluate',
      field: 'outputs',
      index: 2,
      value: 'gamma',
    });
  });

  it('refuses a missing or blank label before reading the selection', () => {
    for (const [label, received] of [
      [undefined, 'undefined'],
      [null, 'null'],
      ['', "''"],
      [42, 'number'],
    ] as const) {
      const boundary = refusal(() =>
        requireSelection(label as unknown as string, 'outputs', ['gamma'], ALLOWED),
      );
      expect(boundary.code).toBe(ErrorCode.InputWrongType);
      expect(boundary.message).toBe(
        `requireSelection: functionName must be a non-empty string (it names the caller's boundary in every error); got ${received}.`,
      );
      expect(boundary.context).toEqual({
        function: 'requireSelection',
        field: 'functionName',
        received,
      });
      const field = refusal(() =>
        requireSelection('evaluate', label as unknown as string, ['gamma'], ALLOWED),
      );
      expect(field.code).toBe(ErrorCode.InputWrongType);
      expect(field.context).toEqual({ function: 'requireSelection', field: 'field', received });
    }
  });
});
