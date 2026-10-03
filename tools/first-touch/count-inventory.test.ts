/**
 * AST-level inventory of the few intentional `Number.isInteger` calls left in package source.
 *
 * A text-count ledger was gameable: comments counted, and replacing one classified call with a new
 * unsafe call in the same file left the file's total unchanged. This ratchet records the actual call
 * expression plus its enclosing boundary. Comments are invisible to the TypeScript AST, and a
 * same-file substitution has a different identity and fails.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LEDGER = new Map<string, string>([
  [
    'packages/core/src/calendar.ts#addBusinessDays:Number.isInteger(n)',
    'first-stage integer teaching followed immediately by the 100,000-business-day work cap',
  ],
  [
    'packages/core/src/diagnostics.ts#plausibilityWarnings:Number.isInteger(timeToExpiryYears)',
    'integer-year plausibility heuristic only; it neither validates nor controls work',
  ],
  [
    'packages/core/src/numeric.ts#round:Number.isInteger(decimals)',
    'decimal precision is immediately bounded to the finite IEEE range [-323, 323]',
  ],
  [
    'packages/core/src/numeric.ts#round:Number.isInteger(value)',
    'IEEE fixed-point fast path for already-integral data; it controls no loop or allocation',
  ],
  [
    'packages/core/src/schema/schema.ts#_check:Number.isInteger(value)',
    'generic schema integer predicate for data, not a workload control',
  ],
  [
    "packages/http/src/server.ts#requireInput:Number.isInteger(request['port'])",
    'a TCP port is bounded to [0, 65535] on the same line; it controls no loop or allocation',
  ],
  [
    'packages/math/src/linalg.ts#requireLuResult:Number.isInteger(row)',
    'a permutation row index, bounded to [0, n) on the next line; it controls no loop or allocation',
  ],
  [
    'packages/mcp/src/server.ts#requireServerSeed:Number.isInteger(value)',
    'same condition also requires Number.isSafeInteger before accepting the seed',
  ],
  [
    'packages/portfolio/src/disclosed-holdings.ts#compareDisclosedHoldings:Number.isInteger(decimalPlaces)',
    'exact-decimal ratio precision is bounded to [0, 18] in the same condition before any decimal exponentiation',
  ],
  [
    'packages/strategy/src/classify.ts#anonymous:Number.isInteger(q)',
    'detects integral leg quantities before a GCD over the already-sized leg array',
  ],
  ['packages/strategy/src/explain.ts#price:Number.isInteger(n)', 'display formatting branch only'],
  ['packages/strategy/src/svg.ts#fmt:Number.isInteger(n)', 'display formatting branch only'],
  [
    'packages/technical-analysis/src/framework.ts#integer:Number.isInteger(value)',
    'first-stage snapshot teaching followed immediately by Number.isSafeInteger',
  ],
  [
    'packages/technical-analysis/src/framework.ts#lookback:Number.isInteger(value)',
    'first-stage lookback teaching followed immediately by the allocation cap',
  ],
]);

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) files.push(path);
    }
  };
  for (const packageName of readdirSync('packages')) {
    const source = join('packages', packageName, 'src');
    try {
      if (statSync(source).isDirectory()) walk(source);
    } catch {
      // A metadata-only package may have no source directory.
    }
  }
  return files.sort();
}

function enclosingName(node: ts.Node, source: ts.SourceFile): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      if ('name' in current && current.name !== undefined) return current.name.getText(source);
      if (ts.isVariableDeclaration(current.parent)) return current.parent.name.getText(source);
      return 'anonymous';
    }
    current = current.parent;
  }
  return 'module';
}

function integerCallSites(): string[] {
  const sites: string[] = [];
  for (const file of sourceFiles()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Number.isInteger') {
        const argument = node.arguments[0]?.getText(source) ?? '<missing>';
        sites.push(`${file}#${enclosingName(node, source)}:Number.isInteger(${argument})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort();
}

describe('Number.isInteger AST inventory (exact, classified, and shrink-only)', () => {
  it('contains exactly the reviewed call sites—not comments or same-file count budgets', () => {
    const found = integerCallSites();
    const duplicates = found.filter((site, index) => found.indexOf(site) !== index);
    expect(duplicates, `duplicate semantic site identities:\n${duplicates.join('\n')}`).toEqual([]);
    expect(found, 'classify a new site or remove a stale ledger entry').toEqual(
      [...LEDGER.keys()].sort(),
    );
    expect(
      [...LEDGER.values()].every((reason) => reason.trim().length >= 20),
      'every retained call needs a concrete non-workload or layered-guard reason',
    ).toBe(true);
  });
});
