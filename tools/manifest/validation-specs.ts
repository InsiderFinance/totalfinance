/**
 * Generator: checker-derived runtime validation specs (spec 3B.1b).
 *
 * Projects each rostered boundary's object parameters from the contract inventory
 * (`public-contracts.json`, itself built by the TypeScript checker) into the compact
 * `ClosedRequestSpecification` data the shared `validateClosedRequest` walks at runtime. One projection,
 * no hand-authored key lists: the runtime allowlist and the declaration cannot drift apart,
 * because they are the same artifact.
 *
 * Emission: `packages/<pkg>/src/generated/validation-specs.ts`, deliberately ABSENT from every
 * exports map (the generated module is implementation, not API). Specs are deduped by contract
 * identity — `barrier.price` and `barrier.monteCarloPrice` share one `BarrierInput & {...}` spec
 * object — and keyed by `boundaryPath#argumentIndex`, which is what a call site knows about
 * itself.
 *
 * Run via `pnpm validation:update`. The drift gate (`validation-specs.test.ts`) fails when a
 * fresh emission differs from the committed module, when a rostered boundary cannot be resolved,
 * or when a spec loses a field its declaration still carries.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NON_FINITE_BOUND_FIELDS,
  UNCHECKED_ARTIFACT_FIELDS,
  VALIDATION_ROSTER,
} from './validation-roster.js';
import { numericCoordinatePolicy } from '../first-touch/count-semantics.js';
import {
  MAX_TECHNICAL_ANALYSIS_LOOKBACK,
  MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS,
} from '../../packages/technical-analysis/src/limits.js';

interface InventoryFieldNode {
  name?: string;
  kind: string;
  optional?: boolean;
  nullable?: boolean;
  literals?: (string | number | boolean)[];
  fields?: InventoryFieldNode[];
  branches?: InventoryFieldNode[];
  element?: InventoryFieldNode;
}

interface InventoryParameter {
  name: string;
  contract?: string;
  kind: string;
  fieldTree?: InventoryFieldNode[];
}

interface InventoryRecord {
  id: string;
  package: string;
  signatures?: { parameters?: InventoryParameter[] }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Inventory kind → validator kind. Total over the inventory's vocabulary; `other` is unchecked. */
function validatorKind(kind: string): string {
  switch (kind) {
    case 'numeric':
      return 'numeric';
    case 'enum':
      return 'enum';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'function':
      return 'callback';
    default:
      return 'unchecked';
  }
}

/** Render a spec as prettier-stable TypeScript: unquoted identifier keys, single-quoted strings. */
function renderValue(value: unknown, indent: string): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${inner}${renderValue(item, inner)},`).join('\n');
    return `[\n${items}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined,
  );
  if (entries.length === 0) return '{}';
  const rendered = entries
    .map(([key, entry]) => {
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`;
      return `${inner}${safeKey}: ${renderValue(entry, inner)},`;
    })
    .join('\n');
  return `{\n${rendered}\n${indent}}`;
}

interface EmittedField {
  name: string;
  kind: string;
  optional?: boolean;
  nullable?: boolean;
  allowsInfinity?: boolean;
  safeIntegerMaximum?: number;
  safeIntegerElementsMaximum?: number;
  literals?: (string | number | boolean)[];
  openKinds?: string[];
  fields?: EmittedField[];
  branches?: { fields: EmittedField[] }[];
}

interface ProjectionContext {
  head: string;
  path: readonly (string | number)[];
  resourceMaximum?: number;
  arrayElementKey?: string;
}

function projectField(node: InventoryFieldNode, context?: ProjectionContext): EmittedField {
  const out: EmittedField = {
    name: node.name ?? '',
    kind: validatorKind(node.kind),
  };
  if (context?.resourceMaximum !== undefined && node.kind === 'numeric') {
    const key = context.arrayElementKey ?? node.name ?? '';
    if (
      numericCoordinatePolicy({ head: context.head, path: context.path, key }).kind === 'resource'
    ) {
      out.safeIntegerMaximum =
        context.head === 'technical-analysis.RainbowMovingAverageStream.constructor' &&
        key === 'levels'
          ? MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS
          : context.resourceMaximum;
    }
  }
  if (
    context?.resourceMaximum !== undefined &&
    node.kind === 'array' &&
    node.element?.kind === 'numeric' &&
    numericCoordinatePolicy({
      head: context.head,
      path: [...context.path, 0],
      key: node.name ?? '',
    }).kind === 'resource'
  ) {
    out.safeIntegerElementsMaximum = context.resourceMaximum;
  }
  if (node.optional === true) out.optional = true;
  if (node.nullable === true) out.nullable = true;
  if (node.literals !== undefined && node.literals.length > 0) out.literals = node.literals;
  if (node.branches !== undefined && node.branches.length > 0) {
    const objectArms = node.branches.filter(
      (branch) => branch.fields !== undefined && branch.fields.length > 0,
    );
    if (objectArms.length > 0) {
      out.branches = objectArms.map((branch) => ({
        fields: branch.fields!.map((field) =>
          projectField(
            field,
            context === undefined
              ? undefined
              : { ...context, path: [...context.path, field.name ?? ''] },
          ),
        ),
      }));
    } else {
      /**
       * A PRIMITIVE union — every arm is field-less. The runtime branch resolver is for object
       * arms; here the honest projection is the merged domain: literal arms pool into `literals`,
       * and an open primitive arm beside them becomes `openKinds` (`Frequency = 'annual' | … |
       * number` accepts the named spellings OR any finite number — the collapsed outer kind was
       * rejecting `'semiannual'`). Arms of a kind the merge cannot express degrade the field to
       * `unchecked` rather than to a spec that rejects declared-legal values: over-closure is the
       * worse defect.
       */
      const literalPool: (string | number | boolean)[] = [];
      const openKinds = new Set<string>();
      let expressible = true;
      for (const branch of node.branches) {
        if (branch.literals !== undefined && branch.literals.length > 0) {
          for (const literal of branch.literals) {
            if (!literalPool.includes(literal)) literalPool.push(literal);
          }
        } else {
          const kind = validatorKind(branch.kind);
          if (kind === 'numeric' || kind === 'string' || kind === 'boolean') openKinds.add(kind);
          else expressible = false;
        }
      }
      if (!expressible) {
        out.kind = 'unchecked';
        delete out.literals;
      } else if (literalPool.length > 0) {
        out.kind = 'enum';
        out.literals = literalPool;
        if (openKinds.size > 0) out.openKinds = [...openKinds].sort();
      } else if (openKinds.size === 1) {
        out.kind = [...openKinds][0]!;
        delete out.literals;
      } else if (openKinds.size > 1) {
        out.kind = 'unchecked';
        delete out.literals;
      }
    }
  } else if (node.fields !== undefined && node.fields.length > 0) {
    out.fields = node.fields.map((field) =>
      projectField(
        field,
        context === undefined
          ? undefined
          : { ...context, path: [...context.path, field.name ?? ''] },
      ),
    );
  }
  return out;
}

export interface GeneratedSpecs {
  /** Emitted module source per package directory name (e.g. `options`). */
  readonly modules: ReadonlyMap<string, string>;
}

export function generateValidationSpecs(): GeneratedSpecs {
  const inventory = JSON.parse(readFileSync(join(HERE, 'public-contracts.json'), 'utf8')) as {
    contracts: InventoryRecord[];
  };
  const byId = new Map(inventory.contracts.map((record) => [record.id, record]));

  const modules = new Map<string, string>();

  for (const roster of VALIDATION_ROSTER) {
    // Dedup: one spec constant per distinct contract identity, in first-use order.
    const specNameByContract = new Map<string, string>();
    const boundsByContract = new Map<string, string[]>();
    const specSource: string[] = [];
    const entryLines: string[] = [];

    for (const boundary of roster.boundaries) {
      const id = `${roster.package}:${boundary}`;
      const record = byId.get(id);
      if (record === undefined) {
        throw new Error(
          `validation-specs: rostered boundary ${id} is not in the contract inventory`,
        );
      }
      const parameters = record.signatures?.[0]?.parameters ?? [];
      for (const [index, parameter] of parameters.entries()) {
        if (parameter.kind !== 'object') continue;
        const tree = parameter.fieldTree ?? [];
        if (tree.length === 0) continue;
        const contract = parameter.contract ?? `${id}#${index}`;
        const rootBranches = (parameter as { branches?: InventoryFieldNode[] }).branches;
        const overrideKey = `${boundary}#${String(index)}`;
        const bounds = NON_FINITE_BOUND_FIELDS[overrideKey] ?? [];
        const head = `${roster.package.replace('@totalfinance/', '')}.${boundary}`;
        const resourceMaximum =
          roster.package === '@totalfinance/technical-analysis' && boundary.endsWith('.constructor')
            ? MAX_TECHNICAL_ANALYSIS_LOOKBACK
            : undefined;
        let specName = specNameByContract.get(contract);
        if (specName === undefined) {
          specName = `SPEC_${specNameByContract.size + 1}`;
          specNameByContract.set(contract, specName);
          boundsByContract.set(contract, [...bounds].sort());
          const fields = tree.map((field) =>
            projectField(field, {
              head,
              path: [index, field.name ?? ''],
              ...(resourceMaximum === undefined ? {} : { resourceMaximum }),
            }),
          );
          /**
           * A UNION PARAMETER carries its arms at the parameter level with `fieldTree` holding
           * only the COMMON members — projecting the tree alone silently over-closed `phiValue`
           * to its discriminant and rejected every declared-legal call. Arms with fields project
           * as root branches; a union whose arms are all field-less is unprojectable here and
           * fails generation loudly rather than emitting a spec that rejects legal calls.
           */
          let branches;
          if (rootBranches !== undefined && rootBranches.length > 0) {
            const arms = rootBranches.filter((b) => b.fields !== undefined && b.fields.length > 0);
            if (arms.length === 0) {
              throw new Error(
                `validation-specs: ${overrideKey} is a union parameter with no object arms — unprojectable; guard it by hand and remove it from the roster`,
              );
            }
            branches = arms.map((b) => ({
              fields: b.fields!.map((field) =>
                projectField(field, {
                  head,
                  path: [index, field.name ?? ''],
                  ...(resourceMaximum === undefined ? {} : { resourceMaximum }),
                }),
              ),
            }));
          }
          // Curated IEEE bound fields (C03): applied at emission so the runtime spec carries the
          // decision, and validated so a stale curation row fails generation loudly.
          for (const name of UNCHECKED_ARTIFACT_FIELDS[overrideKey] ?? []) {
            const target = fields.find((field) => field.name === name);
            if (target === undefined) {
              throw new Error(
                `validation-specs: curated artifact field ${overrideKey}.${name} is not a field of ${contract}`,
              );
            }
            target.kind = 'unchecked';
            delete target.fields;
            delete target.branches;
          }
          for (const name of bounds) {
            const target = fields.find((field) => field.name === name);
            if (target === undefined || target.kind !== 'numeric') {
              throw new Error(
                `validation-specs: curated bound field ${overrideKey}.${name} is not a numeric field of ${contract}`,
              );
            }
            target.allowsInfinity = true;
          }
          const spec =
            branches !== undefined ? { contract, fields, branches } : { contract, fields };
          specSource.push(
            `const ${specName}: ClosedRequestSpecification = ${renderValue(spec, '')};`,
          );
        } else {
          const settled = boundsByContract.get(contract) ?? [];
          const requested = [...bounds].sort();
          if (JSON.stringify(settled) !== JSON.stringify(requested)) {
            throw new Error(
              `validation-specs: boundaries sharing contract ${contract} disagree on curated bound fields (${overrideKey}: [${requested.join(', ')}] vs [${settled.join(', ')}])`,
            );
          }
        }
        entryLines.push(`  '${boundary}#${String(index)}': ${specName},`);
      }
    }

    const directory = roster.package.replace('@totalfinance/', '');
    const source = [
      '/**',
      ' * GENERATED by `pnpm validation:update` from the checker-derived contract inventory.',
      ' * DO NOT EDIT — hand edits drift from the declarations and fail the drift gate',
      ' * (`tools/manifest/validation-specs.test.ts`). Membership is curated in',
      ' * `tools/manifest/validation-roster.ts`; content is projection, never authorship.',
      ' *',
      ' * This module is deliberately absent from the package exports map: the specs are',
      ' * implementation detail of the public boundaries that consume them, not API.',
      ' */',
      '',
      "import type { ClosedRequestSpecification } from '@totalfinance/core';",
      '',
      ...specSource,
      '',
      'export const VALIDATION_SPECS: Readonly<Record<string, ClosedRequestSpecification>> = {',
      ...entryLines,
      '};',
      '',
    ].join('\n');

    modules.set(directory, source);
  }

  return { modules };
}

export function writeValidationSpecs(): string[] {
  const { modules } = generateValidationSpecs();
  const written: string[] = [];
  for (const [directory, source] of modules) {
    const target = join(ROOT, 'packages', directory, 'src', 'generated', 'validation-specs.ts');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    written.push(target);
  }
  return written;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  for (const target of writeValidationSpecs()) {
    console.log(`wrote ${target}`);
  }
}
