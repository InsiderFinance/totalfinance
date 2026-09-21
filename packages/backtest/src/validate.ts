/**
 * Engine input-shape guards (dx §1.1 / the first-touch law). Every public engine dereferences
 * `options.data` on its first line; a natural wrong guess (`vectorized({ close, signal })`) used to
 * crash with a raw `TypeError: Cannot read properties of undefined (reading 'length')`. These
 * guards run FIRST and answer with the expected shape and the keys the caller actually passed.
 */

import { ErrorCode, InputError, wrongShapeError } from '@totalfinance/core';

/**
 * Validate that `options` is an object whose `data` is a non-empty array of bar rows (element 0 must
 * carry numeric `timestampMs` and `close`). Full-array validation stays where it always was (the engines
 * validate every bar they touch); this is the shape guard at the boundary.
 */
export function requireBarData(options: unknown, functionName: string, shape: string): void {
  if (options === null || typeof options !== 'object')
    throw wrongShapeError(functionName, shape, options);
  const data = (options as { data?: unknown }).data;
  if (data === undefined || !Array.isArray(data))
    throw wrongShapeError(functionName, shape, options);
  if (data.length === 0) {
    throw new InputError(`${functionName}: data is empty — supply at least one bar.`, {
      code: ErrorCode.InputOutOfRange,
      context: { bars: 0 },
    });
  }
  const first = data[0] as Record<string, unknown> | null;
  if (
    first === null ||
    typeof first !== 'object' ||
    typeof first['close'] !== 'number' ||
    typeof first['timestampMs'] !== 'number'
  ) {
    throw new InputError(
      `${functionName}: data[0] is not a bar — each element is { symbol, timestampMs, open, high, low, close, volume? } ` +
        `(columnar arrays are not bars; build rows first).`,
      {
        code: ErrorCode.InputWrongType,
        context: { received: first === null ? 'null' : typeof first },
      },
    );
  }
}
