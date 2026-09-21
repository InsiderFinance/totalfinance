/**
 * Capabilities (Stage 7B.2, Decision 9): the runtime refuses an operation whose
 * `requiredCapabilities` are not all present — before parsing the input — with
 * `operation.capability_missing`, naming the missing ones. The defaults grant reading, analysis, and
 * proposing; approval, paper execution, and portfolio writes are granted explicitly by the caller.
 */
import { ErrorCode, InputError } from '@totalfinance/core';

/** What a caller holds when it names nothing: read, analyze, propose. */
export const DEFAULT_CAPABILITIES: readonly string[] = Object.freeze([
  'portfolio:read',
  'analytics:run',
  'trade:propose',
]);

/** The capabilities this stage names; a runtime may grant others (the registry does not enumerate them). */
export const KNOWN_CAPABILITIES: readonly string[] = Object.freeze([
  'portfolio:read',
  'analytics:run',
  'trade:propose',
  'trade:approve',
  'trade:paper',
  'portfolio:write',
]);

const CAPABILITY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function requireCapabilities(
  functionName: string,
  field: string,
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${field} must be an array of capability names (e.g. 'trade:paper') when present.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  const seen = new Set<string>();
  value.forEach((name, index) => {
    if (typeof name !== 'string' || !CAPABILITY.test(name)) {
      throw new InputError(
        `${functionName}: ${field}[${index}] must be a capability name of the form 'scope:action' (e.g. 'trade:paper'). Received ${JSON.stringify(name)}.`,
        {
          code: typeof name === 'string' ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
          context: { function: functionName, field: `${field}[${index}]` },
        },
      );
    }
    seen.add(name);
  });
  return Object.freeze([...seen].sort());
}

/** The required capabilities the caller does not hold, sorted — the runtime's gate. Both lists are validated. */
export function missingCapabilities(
  required: readonly string[],
  capabilities: readonly string[],
): string[] {
  const functionName = 'missingCapabilities';
  const needed = requireCapabilities(functionName, 'required', required);
  const held = new Set(requireCapabilities(functionName, 'capabilities', capabilities));
  return needed.filter((name) => !held.has(name));
}
