import { describe, expect, it } from 'vitest';
import { ErrorCode, QuantError } from '@totalfinance/core';
import { schema } from '@totalfinance/core/schema';
import { defaultOperations } from '@totalfinance/workflows';
import { defineTool, toolFromOperation, toolNameFor } from '@totalfinance/mcp';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};

const custom = () => ({
  name: 'custom.echo',
  title: 'Echo',
  description: 'Returns its input.',
  schema: schema.object({ value: schema.number() }),
  run: (input: { value: number }) => ({ summary: 'echo', structured: { value: input.value } }),
});

describe('the two tool builders are closed doors', () => {
  it('defineTool refuses unknown keys, mistyped members, and a malformed output document', () => {
    expect(codeOf(() => defineTool({ ...custom(), extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => defineTool({ ...custom(), name: '' }))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => defineTool({ ...custom(), mutates: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => defineTool({ ...custom(), stochastic: 'yes' } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => defineTool({ ...custom(), schema: {} } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => defineTool({ ...custom(), outputSchema: { type: 'nope' } } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(
      codeOf(() =>
        defineTool({ ...custom(), outputSchema: { properties: { x: { $id: null } } } } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    const tool = defineTool({ ...custom(), outputSchema: { type: 'object' } });
    expect(tool.run({ value: 2 })).toEqual({ summary: 'echo', structured: { value: 2 } });
    expect(codeOf(() => tool.run({ value: 'x' }))).toBe(ErrorCode.InputWrongType);
  });

  it('toolFromOperation validates the operation it is handed like every other door', () => {
    const [operation] = defaultOperations();
    expect(codeOf(() => toolFromOperation({ ...operation!, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => toolFromOperation({ ...operation!, costClass: null } as never))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => toolFromOperation(null as never))).toBe(ErrorCode.InputWrongType);
    const tool = toolFromOperation(operation!);
    expect(tool.name).toBe(toolNameFor(operation!.id));
    expect(toolNameFor(operation!.id)).toBe(operation!.id.replace(/\./g, '_'));
    expect((tool as unknown as Record<string, unknown>)['operation']).toBeUndefined();
  });
});
