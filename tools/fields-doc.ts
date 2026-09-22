/**
 * Stage 4.7 (FC9, Decision 4) — the generated field reference.
 *
 * Reads `tools/manifest/public-contracts.json` (the committed declaration walk) and writes
 * `docs/reference/fields.md` (the index) plus one `docs/reference/fields/<package>.md` per
 * package: every public callable's declared fields with their kind, optionality, nullability,
 * the literal domain of an enumeration, and the UNIT the field's name carries under the naming
 * law's suffix conventions. Nothing is inferred beyond the name: a field whose name carries no
 * unit suffix is listed as "unitless by name".
 *
 * The umbrella package's spellings (`totalfinance:<domain>.<callable>`) repeat the domain packages'
 * declarations and are counted, not listed. The transports (`@totalfinance/cli`, `@totalfinance/http`,
 * `@totalfinance/mcp`) are listed like any package — their callables are public.
 *
 * `pnpm docs:update` regenerates; `tools/fields-doc.test.ts` fails when the committed documents
 * drift from the declarations.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGE_NAME, toPublicSpecifier } from './public-packages.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ContractNode {
  name?: string;
  type?: string;
  kind?: string;
  optional?: boolean;
  nullable?: boolean;
  literals?: readonly (string | number | boolean)[];
  fields?: ContractNode[];
  fieldTree?: ContractNode[];
  element?: ContractNode;
  truncated?: boolean;
}

interface ContractParameter extends ContractNode {
  name: string;
  rest?: boolean;
}

interface ContractRecord {
  id: string;
  package: string;
  role?: string;
  grammar?: string;
  boundaryKind?: string;
  signatures?: Array<{ parameters?: ContractParameter[] }>;
}

/**
 * The unit a field's NAME carries — the naming law's suffix conventions, applied in order (the
 * first match wins). Cited by the reference's header; nothing here is inferred from a value.
 */
export const UNIT_SUFFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^asOf$/,
    'an instant: epoch milliseconds or a YYYY-MM-DD / zoned ISO string (the resolveAsOf convention)',
  ],
  [/TimestampMs$/, 'epoch milliseconds (UTC instant)'],
  [/(Ms|Milliseconds)$/, 'milliseconds'],
  [/Years$/, 'years (decimal)'],
  [/Days$/, 'days'],
  [/Sessions$/, 'trading sessions'],
  [/Periods$/, 'periods'],
  [/PerYear$/, 'per year (count)'],
  [/PerUnit$/, 'currency per unit'],
  [/(Bps|BasisPoints)$/, 'basis points'],
  [/Percent$/, 'percent (0–100)'],
  [/(Rate|Yield)$/, 'decimal rate (0.05 = 5%)'],
  [/(Fraction|Weight|Share|Ratio|Multiplier|Factor)$/, 'decimal fraction / multiple'],
  [
    /(Amount|Notional|Value|Cash|Cost|Costs|Premium|Price|Proceeds|Pnl)$/,
    'currency amount (the field or record currency)',
  ],
  [/(Count|Index|Size|Length)$/, 'count (integer)'],
  [/Date$/, 'calendar date (YYYY-MM-DD)'],
  [/Currency$/, 'ISO-4217 currency code'],
];

export function unitByName(name: string): string {
  for (const [pattern, unit] of UNIT_SUFFIXES) if (pattern.test(name)) return unit;
  return 'unitless by name';
}

interface Row {
  callable: string;
  path: string;
  kind: string;
  domain: string;
  optional: boolean;
  nullable: boolean;
  unit: string;
}

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A named object type (`FundamentalPeriod`, `Bar`, …) expanded ONCE per package and referenced elsewhere. */
interface NamedType {
  name: string;
  rows: Row[];
}

const isNamedType = (field: ContractNode): boolean =>
  field.kind === 'object' &&
  typeof field.type === 'string' &&
  /^[A-Z][A-Za-z0-9]*$/.test(field.type) &&
  (field.fieldTree ?? field.fields ?? []).length > 0;

function walk(
  node: ContractNode,
  prefix: string,
  callable: string,
  rows: Row[],
  types: Map<string, NamedType>,
): void {
  const children = node.fieldTree ?? node.fields ?? [];
  for (const field of children) {
    const path = `${prefix}${field.name ?? '?'}`;
    const kind = field.kind ?? 'other';
    const named = isNamedType(field);
    const domain =
      kind === 'enum' && field.literals !== undefined
        ? field.literals.map((literal) => JSON.stringify(literal)).join(' \\| ')
        : kind === 'array'
          ? `array${field.element?.kind ? ` of ${field.element.kind}` : ''}`
          : kind === 'function'
            ? 'callback'
            : named
              ? `→ ${field.type}`
              : field.truncated === true
                ? 'object (declaration walk stops here)'
                : '';
    rows.push({
      callable,
      path,
      kind,
      domain,
      optional: field.optional === true,
      nullable: field.nullable === true,
      unit: kind === 'numeric' || kind === 'string' ? unitByName(field.name ?? '') : '',
    });
    if (named) {
      const name = field.type!;
      if (!types.has(name)) {
        const typeRows: Row[] = [];
        types.set(name, { name, rows: typeRows });
        walk(field, '', name, typeRows, types);
      }
      continue;
    }
    if (field.element !== undefined) walk(field.element, `${path}[].`, callable, rows, types);
    walk(field, `${path}.`, callable, rows, types);
  }
}

export interface FieldReference {
  /** `docs/reference/fields.md` */
  index: string;
  /** package → `docs/reference/fields/<file>.md` */
  pages: Map<string, { file: string; markdown: string; callables: number; fields: number }>;
  umbrellaSpellings: number;
}

const fileNameOf = (pkg: string): string =>
  pkg.replace(/^@totalfinance\//, '').replace(/[^a-z0-9-]/gi, '-');

export function buildFieldReference(contractsJson: string): FieldReference {
  const artifact = JSON.parse(contractsJson) as { version?: unknown; contracts: ContractRecord[] };
  const byPackage = new Map<string, ContractRecord[]>();
  let umbrellaSpellings = 0;
  for (const record of artifact.contracts) {
    if (record.package === 'totalfinance') {
      umbrellaSpellings += 1;
      continue;
    }
    const list = byPackage.get(record.package) ?? [];
    list.push(record);
    byPackage.set(record.package, list);
  }
  const pages: FieldReference['pages'] = new Map();
  const packages = [...byPackage.keys()].sort();
  for (const pkg of packages) {
    const records = byPackage
      .get(pkg)!
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rows: Row[] = [];
    const types = new Map<string, NamedType>();
    let callables = 0;
    for (const record of records) {
      const signature = record.signatures?.[0];
      if (signature === undefined) continue;
      callables += 1;
      const callable = record.id.slice(record.package.length + 1);
      (signature.parameters ?? []).forEach((parameter, index) => {
        const head = `${index}(${parameter.name})`;
        const kind = parameter.kind ?? 'other';
        const namedParameter = isNamedType(parameter);
        rows.push({
          callable,
          path: head,
          kind,
          domain:
            kind === 'enum' && parameter.literals
              ? parameter.literals.map((l) => JSON.stringify(l)).join(' \\| ')
              : namedParameter
                ? `→ ${parameter.type}`
                : '',
          optional: parameter.optional === true,
          nullable: parameter.nullable === true,
          unit: kind === 'numeric' || kind === 'string' ? unitByName(parameter.name) : '',
        });
        if (namedParameter) {
          const name = parameter.type!;
          if (!types.has(name)) {
            const typeRows: Row[] = [];
            types.set(name, { name, rows: typeRows });
            walk(parameter, '', name, typeRows, types);
          }
        } else {
          walk(parameter, `${head}.`, callable, rows, types);
        }
      });
    }
    const lines: string[] = [];
    lines.push(`# Fields — \`${toPublicSpecifier(pkg)}\``);
    lines.push('');
    lines.push(
      `Generated by \`tools/fields-doc.ts\` from \`tools/manifest/public-contracts.json\` — do not edit. ${callables} public callables; every declared field (parameters and their members) with named object types expanded once in the table below the callables. See [the index](../fields.md) for the unit conventions.`,
    );
    lines.push('');
    lines.push('| Callable | Field | Kind | Domain | Optional | Nullable | Unit (by name) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| \`${escapeCell(row.callable)}\` | \`${escapeCell(row.path)}\` | ${row.kind} | ${escapeCell(row.domain)} | ${row.optional ? 'yes' : ''} | ${row.nullable ? 'yes' : ''} | ${escapeCell(row.unit)} |`,
      );
    }
    lines.push('');
    const named = [...types.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    let typeFields = 0;
    if (named.length > 0) {
      lines.push('## Named types');
      lines.push('');
      lines.push(
        "Each named object type is expanded once; a `→ Type` domain above refers here. A type expanded in another package's page is expanded again here only when this package declares it.",
      );
      lines.push('');
      lines.push('| Type | Field | Kind | Domain | Optional | Nullable | Unit (by name) |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const type of named) {
        for (const row of type.rows) {
          typeFields += 1;
          lines.push(
            `| \`${escapeCell(type.name)}\` | \`${escapeCell(row.path)}\` | ${row.kind} | ${escapeCell(row.domain)} | ${row.optional ? 'yes' : ''} | ${row.nullable ? 'yes' : ''} | ${escapeCell(row.unit)} |`,
          );
        }
      }
      lines.push('');
    }
    pages.set(pkg, {
      file: `${fileNameOf(pkg)}.md`,
      markdown: lines.join('\n'),
      callables,
      fields: rows.length + typeFields,
    });
  }
  const index: string[] = [];
  index.push('# Field reference');
  index.push('');
  index.push(
    "Generated by `tools/fields-doc.ts` from `tools/manifest/public-contracts.json` (the committed declaration walk) — do not edit; `pnpm docs:update` regenerates it and `tools/fields-doc.test.ts` fails on drift. One page per package lists every public callable's declared fields: the parameter and member path, the kind (numeric / string / boolean / enum with its literal domain / object / array / callback), optionality, nullability, and the unit the field's NAME carries under the naming law. Nothing is inferred beyond the name.",
  );
  index.push('');
  index.push('## Unit conventions (by name suffix, first match wins)');
  index.push('');
  index.push('| Suffix | Unit |');
  index.push('| --- | --- |');
  for (const [pattern, unit] of UNIT_SUFFIXES)
    index.push(`| \`${escapeCell(pattern.source)}\` | ${escapeCell(unit)} |`);
  index.push('| (none of the above) | unitless by name |');
  index.push('');
  index.push('## Domain and transport entry points');
  index.push('');
  index.push('| Entry point | Callables | Declared fields | Page |');
  index.push('| --- | --- | --- | --- |');
  let totalCallables = 0;
  let totalFields = 0;
  for (const pkg of packages) {
    const page = pages.get(pkg)!;
    totalCallables += page.callables;
    totalFields += page.fields;
    index.push(
      `| \`${toPublicSpecifier(pkg)}\` | ${page.callables} | ${page.fields} | [${page.file}](./fields/${page.file}) |`,
    );
  }
  index.push(`| **all** | **${totalCallables}** | **${totalFields}** | |`);
  index.push('');
  index.push(
    `The root \`${PUBLIC_PACKAGE_NAME}\` re-exports ${umbrellaSpellings} of these callables through domain namespaces; those spellings carry the same declarations and are not listed twice. Domain entry points are included in the single main installation, not separately published packages. MCP is the optional companion.`,
  );
  index.push('');
  return { index: index.join('\n'), pages, umbrellaSpellings };
}

export function writeFieldReference(root = ROOT): void {
  const reference = buildFieldReference(
    readFileSync(join(root, 'tools/manifest/public-contracts.json'), 'utf8'),
  );
  const dir = join(root, 'docs/reference/fields');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'docs/reference/fields.md'), reference.index);
  for (const page of reference.pages.values()) writeFileSync(join(dir, page.file), page.markdown);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  writeFieldReference();
  console.log('docs/reference/fields.md written');
}
