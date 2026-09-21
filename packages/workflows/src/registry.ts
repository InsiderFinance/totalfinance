/**
 * The operation registry (Stage 7A Decision 3): the curated, effect-checked set every transport
 * lists and runs. A side effect other than `'none'` is refused at REGISTRATION — structural, never a
 * runtime flag a caller could flip.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  describeOperation,
  requireOperation,
  type OperationDescription,
  type OperationPack,
  type OperationResult,
  type TotalFinanceOperation,
} from './operation.js';
import { defaultPacks } from './operations-compute.js';
import { runOperation, type RunOperationOptions } from './runtime.js';

export interface OperationRegistry {
  list(): OperationDescription[];
  get(id: string): TotalFinanceOperation | null;
  /** The operation, or a typed refusal naming the closest id. */
  require(id: string): TotalFinanceOperation;
  describe(id: string): OperationDescription;
  /** Run one registered operation: `{ id, input, ...runtime options }` — one closed request. */
  run(request: { id: string; input: unknown } & RunOperationOptions): OperationResult;
  packs(): OperationPack[];
  readonly size: number;
}

function closest(id: string, ids: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const candidate of ids) {
    let common = 0;
    const limit = Math.min(candidate.length, id.length);
    while (common < limit && candidate[common] === id[common]) common += 1;
    if (common > bestScore) {
      bestScore = common;
      best = candidate;
    }
  }
  return bestScore >= 'totalfinance.'.length + 1 ? best : undefined;
}

export function createOperationRegistry(input: {
  operations?: readonly TotalFinanceOperation[];
  packs?: readonly OperationPack[];
}): OperationRegistry {
  const functionName = 'createOperationRegistry';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['operations', 'packs']);
  if (input.operations !== undefined)
    requireArgumentArray(functionName, 'operations', input.operations);
  if (input.packs !== undefined) requireArgumentArray(functionName, 'packs', input.packs);
  // `createOperationRegistry({})` — omitting BOTH — is the curated default set (the ten domain packs),
  // the same default the MCP server ships with; `{ operations: [] }` or `{ packs: [] }` is an
  // explicitly empty registry. (The request object itself stays required, like every other door.)
  const packs = [...(input.packs ?? (input.operations === undefined ? defaultPacks() : []))];
  const byId = new Map<string, TotalFinanceOperation>();
  const register = (operation: TotalFinanceOperation, source: string): void => {
    requireOperation(functionName, source, operation);
    // Stage 7B.2 Decision 9: registration is effect-aware, not read-only — a write operation registers
    // like any other and EXECUTION is gated by the capabilities the caller holds (runOperation).
    if (operation.deterministic && operation.stochastic !== false) {
      throw new InputError(
        `${functionName}: ${operation.id} is declared deterministic but stochastic.`,
        {
          code: ErrorCode.OperationRegistrationRefused,
          context: { function: functionName, field: `${source}.deterministic`, id: operation.id },
        },
      );
    }
    const existing = byId.get(operation.id);
    if (existing !== undefined && existing !== operation) {
      throw new InputError(
        `${functionName}: duplicate operation id '${operation.id}' — the registry lists each operation exactly once.`,
        {
          code: ErrorCode.OperationRegistrationRefused,
          context: { function: functionName, field: `${source}.id`, id: operation.id },
        },
      );
    }
    byId.set(operation.id, operation);
  };
  packs.forEach((pack, packIndex) => {
    requireArgumentObject(functionName, `packs[${packIndex}]`, pack);
    ensureKnownKeys(functionName, `packs[${packIndex}]`, pack, ['name', 'operations']);
    requireArgumentArray(functionName, `packs[${packIndex}].operations`, pack.operations);
    pack.operations.forEach((operation, index) =>
      register(operation, `packs[${packIndex}].operations[${index}]`),
    );
  });
  (input.operations ?? []).forEach((operation, index) =>
    register(operation, `operations[${index}]`),
  );
  const ids = (): string[] => [...byId.keys()];
  const require = (id: string): TotalFinanceOperation => {
    const operation = byId.get(id);
    if (operation !== undefined) return operation;
    const suggestion = typeof id === 'string' ? closest(id, ids()) : undefined;
    throw new InputError(
      `operationRegistry.require: Unknown operation ${JSON.stringify(id)}${suggestion !== undefined ? ` — did you mean '${suggestion}'?` : ''}. List the registry (operations list) for the ${byId.size} registered ids.`,
      {
        code: ErrorCode.OperationUnknown,
        context: {
          function: 'operationRegistry.require',
          id,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      },
    );
  };
  return {
    list: () => ids().map((id) => describeOperation(byId.get(id)!)),
    get: (id) => byId.get(id) ?? null,
    require,
    describe: (id) => describeOperation(require(id)),
    run: (request) => {
      requireArgumentObject('operationRegistry.run', 'request', request);
      ensureKnownKeys('operationRegistry.run', 'request', request, [
        'id',
        'input',
        'maxInputBytes',
        'defaultSeed',
        'deadlineMs',
        'signal',
        'artifacts',
        'inlineResultBytes',
        'createdTimestampMs',
        'requestId',
        'now',
        'capabilities',
        'stores',
      ]);
      const { id, ...rest } = request;
      return runOperation({ operation: require(id), ...rest });
    },
    packs: () => packs.map((pack) => ({ name: pack.name, operations: [...pack.operations] })),
    get size() {
      return byId.size;
    },
  };
}
