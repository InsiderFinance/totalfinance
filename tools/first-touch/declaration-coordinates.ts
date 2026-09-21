/** Compiler-derived numeric input coordinates used by the resource inventory and mutation gate. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface ContractNode {
  name: string;
  kind: string;
  fields?: ContractNode[];
  fieldTree?: ContractNode[];
  element?: ContractNode;
  branches?: ContractNode[];
}

interface ContractParameter extends ContractNode {
  optional?: boolean;
}

interface ContractRecord {
  id: string;
  signatures?: Array<{ parameters?: ContractParameter[] }>;
}

const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../manifest/public-contracts.json', import.meta.url)),
    'utf8',
  ),
) as { contracts: ContractRecord[] };

const contracts = new Map(artifact.contracts.map((contract) => [contract.id, contract]));

export interface DeclaredNumericCoordinate {
  contractId: string;
  head: string;
  path: readonly (string | number)[];
  key: string;
}

const headFromContractId = (id: string): string | undefined => {
  const match = /^@totalfinance\/([^:]+):(.+)$/.exec(id);
  return match ? `${match[1]}.${match[2]}` : undefined;
};

/** Find an exact public head, removing only trailing fixture-variant suffixes when necessary. */
function recordForHead(head: string): ContractRecord | undefined {
  const separator = head.indexOf('.');
  if (separator < 1) return undefined;
  const packageName = head.slice(0, separator);
  let callableName = head.slice(separator + 1);
  for (;;) {
    const record = contracts.get(`@totalfinance/${packageName}:${callableName}`);
    if (record !== undefined) return record;
    const variant = callableName.lastIndexOf('#');
    if (variant < 0) return undefined;
    callableName = callableName.slice(0, variant);
  }
}

function collectRecord(record: ContractRecord, head: string): DeclaredNumericCoordinate[] {
  const out: DeclaredNumericCoordinate[] = [];
  const seen = new Set<string>();
  const push = (path: readonly (string | number)[], key: string): void => {
    // Keep the leading argument index: positional parameters can share a declaration name and must
    // remain separate obligations. Only numeric positions below an argument represent arbitrary
    // array elements and are safe to canonicalize.
    const identity = `${path
      .map((step, index) => (typeof step === 'number' && index > 0 ? '[]' : String(step)))
      .join('.')}|${key}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    out.push({ contractId: record.id, head, path, key });
  };
  const walk = (
    node: ContractNode,
    path: readonly (string | number)[],
    arrayElementKey?: string,
  ): void => {
    if (node.kind === 'numeric') push(path, arrayElementKey ?? node.name);
    for (const field of [...(node.fieldTree ?? []), ...(node.fields ?? [])]) {
      walk(field, [...path, field.name]);
    }
    if (node.element !== undefined) {
      walk(node.element, [...path, 0], node.element.kind === 'numeric' ? node.name : undefined);
    }
    for (const branch of node.branches ?? []) {
      walk(branch, path, arrayElementKey ?? node.name);
    }
  };
  for (const signature of record.signatures ?? []) {
    for (const [index, parameter] of (signature.parameters ?? []).entries()) {
      walk(parameter, [index], parameter.kind === 'numeric' ? parameter.name : undefined);
    }
  }
  return out;
}

/** Every numeric input site in the checker-generated public contract inventory (aliases included). */
export function allDeclaredNumericCoordinates(): DeclaredNumericCoordinate[] {
  const out: DeclaredNumericCoordinate[] = [];
  for (const record of artifact.contracts) {
    const head = headFromContractId(record.id);
    if (head !== undefined) out.push(...collectRecord(record, head));
  }
  return out;
}

/** Numeric input sites for one exact public head (fixture variants resolve to their base head). */
export function declaredNumericCoordinatesForHead(head: string): DeclaredNumericCoordinate[] {
  const record = recordForHead(head);
  if (record === undefined) return [];
  const canonicalHead = headFromContractId(record.id);
  return canonicalHead === undefined ? [] : collectRecord(record, canonicalHead);
}

const pathIdentity = (path: readonly (string | number)[]): string =>
  path
    .map((step, index) => (typeof step === 'number' && index > 0 ? '[]' : String(step)))
    .join('.');

/**
 * Recover the declaration's parameter/field name for a concrete fixture leaf. In particular, a
 * positional `rollingMean(series, window)` fixture contains only `args[1] = 20`; this restores the
 * name `window`, which an object-key walker can never infer.
 */
export function declaredNumericCoordinateKey(
  head: string,
  path: readonly (string | number)[],
): string | undefined {
  const wanted = pathIdentity(path);
  return declaredNumericCoordinatesForHead(head).find(
    (coordinate) => pathIdentity(coordinate.path) === wanted,
  )?.key;
}
